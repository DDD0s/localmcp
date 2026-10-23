import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { extractArchive } from './archive.js';

export const REPOSITORY = 'https://github.com/DDD0s/localmcp.git';
export const CHECKSUM_ASSET = 'SHA256SUMS';

const BLOCKED_REFS = new Set(['main', 'master', 'head', 'develop', 'dev', 'trunk']);
const TAG = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const ARCHIVE_LIMIT = 30 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

export type Runner = (command: string, args: string[], cwd?: string) => Promise<void>;

export interface UpdateOptions {
  /** Release tag (`v0.4.1`) or the full commit that tag points at. Omit for the latest release. */
  ref?: string;
  /** Package name the checkout must contain, so an upstream tree cannot replace this edition. */
  expectedName: string;
  repository?: string;
  run?: Runner;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export interface InstalledRelease {
  name: string;
  version: string;
  tag: string;
  commit: string;
}

interface ReleaseAsset { name?: string; browser_download_url?: string }
interface Release { tag_name?: string; draft?: boolean; assets?: ReleaseAsset[] }
interface GitObject { object?: { type?: string; sha?: string } }

/**
 * Install a pinned GitHub Release. The tag archive is downloaded from GitHub and checked
 * against the release's SHA256SUMS asset (archive digest plus the tag's commit) before
 * `npm ci --ignore-scripts`. Branch names, including main, are refused.
 */
export async function updateFromGitHub(options: UpdateOptions): Promise<InstalledRelease> {
  const run = options.run ?? runCommand;
  const log = options.log ?? (message => console.log(message));
  const fetchImpl = options.fetchImpl ?? fetch;
  const repository = options.repository ?? REPOSITORY;
  const repo = repoFromRemote(repository);
  const ref = (options.ref ?? '').trim();
  if (ref && BLOCKED_REFS.has(ref.toLowerCase())) {
    throw new Error(`Refusing to install ${ref}. Pass a release tag such as v0.4.1, the 40-character commit that tag points at, or omit the ref to use the latest GitHub Release.`);
  }
  if (ref && ref !== 'latest' && !TAG.test(ref) && !SHA.test(ref)) {
    throw new Error(`Refusing to install ${ref}. Pass a release tag such as v0.4.1 or the 40-character commit that tag points at.`);
  }
  const pinned = SHA.test(ref)
    ? await releaseForCommit(fetchImpl, repo, ref)
    : await releaseForTag(fetchImpl, repo, ref && ref !== 'latest' ? ref : undefined);
  const checksumUrl = checksumAsset(repo, pinned.release);
  log(`Checking ${pinned.release.tag_name} (${pinned.commit})...`);
  const checksums = parseChecksums(await readText(fetchImpl, checksumUrl, TEXT_LIMIT));
  if (!sameHex(checksums.commit, pinned.commit)) {
    throw new Error(`Release ${pinned.release.tag_name} points at ${pinned.commit}, but SHA256SUMS says ${checksums.commit}. Refusing to install.`);
  }
  const archiveUrl = archiveUrlForTag(repo, pinned.release.tag_name || '');
  const archive = await readBytes(fetchImpl, archiveUrl, ARCHIVE_LIMIT);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (!sameHex(digest, checksums.archiveSha256)) {
    throw new Error(`Release ${pinned.release.tag_name} archive checksum does not match SHA256SUMS. Refusing to install.`);
  }
  const work = await mkdtemp(join(tmpdir(), 'localmcp-update-'));
  try {
    const source = join(work, 'source');
    await extractArchive(archive, source);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (manifest.name !== options.expectedName) {
      throw new Error(`${pinned.release.tag_name} contains ${manifest.name ?? 'an unnamed package'}, not ${options.expectedName}.`);
    }
    const expectedVersion = (pinned.release.tag_name || '').replace(/^v/, '');
    if (TAG.test(pinned.release.tag_name || '') && manifest.version !== expectedVersion) {
      throw new Error(`Release ${pinned.release.tag_name} package.json version is ${manifest.version ?? 'missing'}, not ${expectedVersion}.`);
    }
    log(`Building ${manifest.name} ${manifest.version} from ${pinned.release.tag_name}...`);
    // Only the TypeScript compiler is needed; skip install scripts such as workerd's.
    await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], source);
    await run('npm', ['pack', '--silent', '--pack-destination', work], source);
    const tarball = (await readdir(work)).find(file => file.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack did not produce a tarball');
    log(`Installing ${tarball}...`);
    await run('npm', ['install', '-g', '--no-audit', '--no-fund', join(work, tarball)]);
    return { name: manifest.name, version: manifest.version ?? 'unknown', tag: pinned.release.tag_name || '', commit: pinned.commit };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function repoFromRemote(repository: string): string {
  const match = /github\.com[:/]([^/]+)\/([^/#?.]+)(?:\.git)?\/?$/.exec(repository);
  if (!match) throw new Error(`Unsupported repository ${repository}`);
  return `${match[1]}/${match[2]}`;
}

/** Bytes hashed by the maintainer: the GitHub tag archive, not a git checkout. */
export function archiveUrlForTag(repo: string, tag: string): string {
  return `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
}

export function parseChecksums(text: string): { archiveSha256: string; commit: string } {
  let archiveSha256: string | undefined;
  let commit: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const file = /^([a-fA-F0-9]{64}) [ *]source\.tar\.gz$/.exec(line);
    if (file) {
      archiveSha256 = file[1].toLowerCase();
      continue;
    }
    const commitLine = /^commit ([a-fA-F0-9]{40})$/.exec(line);
    if (commitLine) {
      commit = commitLine[1].toLowerCase();
      continue;
    }
    throw new Error(`Unrecognized SHA256SUMS line: ${line.slice(0, 80)}`);
  }
  if (!archiveSha256 || !commit) throw new Error('SHA256SUMS must contain "<sha256>  source.tar.gz" and "commit <40-hex>".');
  return { archiveSha256, commit };
}

async function releaseForTag(fetchImpl: typeof fetch, repo: string, tag: string | undefined): Promise<{ release: Release & { tag_name: string }; commit: string }> {
  const url = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await githubJson<Release>(fetchImpl, url);
  if (!release.tag_name || release.draft) throw new Error(`No published GitHub Release${tag ? ` ${tag}` : ''}. Refusing to install unverified source.`);
  const commit = await tagCommit(fetchImpl, repo, release.tag_name);
  return { release: { ...release, tag_name: release.tag_name }, commit };
}

async function releaseForCommit(fetchImpl: typeof fetch, repo: string, sha: string): Promise<{ release: Release & { tag_name: string }; commit: string }> {
  for (let page = 1; page <= 5; page++) {
    const batch = await githubJson<Release[]>(fetchImpl, `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const release of batch) {
      if (!release.tag_name || release.draft || !TAG.test(release.tag_name)) continue;
      const commit = await tagCommit(fetchImpl, repo, release.tag_name);
      if (commit === sha) return { release: { ...release, tag_name: release.tag_name }, commit };
    }
    if (batch.length < 100) break;
  }
  throw new Error(`Commit ${sha} is not the commit of a published GitHub Release. Refusing to install.`);
}

async function tagCommit(fetchImpl: typeof fetch, repo: string, tag: string): Promise<string> {
  const ref = await githubJson<GitObject>(fetchImpl, `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  let sha = ref.object?.sha ?? '';
  let type = ref.object?.type;
  if (type === 'tag') {
    const annotated = await githubJson<GitObject>(fetchImpl, `https://api.github.com/repos/${repo}/git/tags/${sha}`);
    sha = annotated.object?.sha ?? '';
    type = annotated.object?.type;
  }
  sha = sha.toLowerCase();
  if (type !== 'commit' || !SHA.test(sha)) throw new Error(`Tag ${tag} did not resolve to a commit.`);
  return sha;
}

function checksumAsset(repo: string, release: Release): string {
  const asset = release.assets?.find(item => item.name === CHECKSUM_ASSET);
  const url = asset?.browser_download_url ?? '';
  const prefix = `https://github.com/${repo}/releases/download/`;
  if (!url.startsWith(prefix)) {
    throw new Error(`Release ${release.tag_name ?? ''} has no SHA256SUMS asset on GitHub. Refusing to install unverified source.`);
  }
  return url;
}

function githubHeaders(): Record<string, string> {
  return {
    'user-agent': 'localmcp-update',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

async function githubJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, { headers: githubHeaders() });
  const text = await bodyText(response, TEXT_LIMIT);
  const path = safePath(url);
  if (response.status === 404) throw new Error(`GitHub returned 404 for ${path}. A branch tip is not a release.`);
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}) for ${path}.`);
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`GitHub returned a non-JSON response for ${path}.`); }
}

async function readText(fetchImpl: typeof fetch, url: string, limit: number): Promise<string> {
  const response = await fetchImpl(url, { headers: { 'user-agent': 'localmcp-update', accept: 'application/octet-stream' } });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${safePath(url)}.`);
  return bodyText(response, limit);
}

async function readBytes(fetchImpl: typeof fetch, url: string, limit: number): Promise<Buffer> {
  const response = await fetchImpl(url, { headers: { 'user-agent': 'localmcp-update', accept: 'application/octet-stream' } });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${safePath(url)}.`);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffered = Buffer.from(await response.arrayBuffer());
    if (buffered.length > limit) throw new Error('download exceeds the size limit');
    return buffered;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('download exceeds the size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function bodyText(response: Response, limit: number): Promise<string> {
  return (await readResponse(response, limit)).toString('utf8');
}

async function readResponse(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffered = Buffer.from(await response.arrayBuffer());
    if (buffered.length > limit) throw new Error('download exceeds the size limit');
    return buffered;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('download exceeds the size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function safePath(url: string): string {
  try { return new URL(url).pathname; }
  catch { return 'download'; }
}

function sameHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/.test(left) || !/^[a-f0-9]+$/.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
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
