import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPOSITORY = 'https://github.com/DDD0s/localmcp.git';

export type Runner = (command: string, args: string[], cwd?: string) => Promise<void>;

export interface UpdateOptions {
  /** Branch or tag to install. */
  ref: string;
  /** Package name the checkout must contain, so an upstream branch cannot replace this edition. */
  expectedName: string;
  repository?: string;
  run?: Runner;
  log?: (message: string) => void;
}

/**
 * Install the enhanced edition from GitHub. npm 11 does not run the build scripts of git
 * dependencies, so `npm install -g github:DDD0s/localmcp` exits 0 but leaves neither dist/
 * nor the localmcp command. Build a tarball from a shallow clone and install that instead.
 */
export async function updateFromGitHub(options: UpdateOptions): Promise<{ name: string; version: string }> {
  const run = options.run ?? runCommand;
  const log = options.log ?? (message => console.log(message));
  const repository = options.repository ?? REPOSITORY;
  const npm = 'npm';
  const work = await mkdtemp(join(tmpdir(), 'localmcp-update-'));
  try {
    const source = join(work, 'source');
    log(`Cloning ${repository} (${options.ref})...`);
    await run('git', ['clone', '--quiet', '--depth', '1', '--branch', options.ref, repository, source]);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (manifest.name !== options.expectedName) {
      throw new Error(`${options.ref} contains ${manifest.name ?? 'an unnamed package'}, not ${options.expectedName}. Pass a branch or tag of the enhanced edition: localmcp update <ref>`);
    }
    log(`Building ${manifest.name} ${manifest.version}...`);
    // Only the TypeScript compiler is needed; skip install scripts such as workerd's.
    await run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], source);
    await run(npm, ['pack', '--silent', '--pack-destination', work], source);
    const tarball = (await readdir(work)).find(file => file.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack did not produce a tarball');
    log(`Installing ${tarball}...`);
    await run(npm, ['install', '-g', '--no-audit', '--no-fund', join(work, tarball)]);
    return { name: manifest.name, version: manifest.version ?? 'unknown' };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    // npm is a .cmd shim on Windows and needs a shell; pass one quoted command line.
    const child = process.platform === 'win32'
      ? spawn([command, ...args].map(quoteWindows).join(' '), { cwd, stdio: 'inherit', shell: true })
      : spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} ${args[0] ?? ''} failed with exit code ${code}`)));
  });
}

function quoteWindows(value: string): string {
  return /^[\w.:\\/=@-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}
