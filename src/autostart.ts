import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { EXIT_ALREADY_RUNNING, EXIT_DISPLACED, FINAL_EXIT_CODES } from './exit-codes.js';
import { getProxyUrl } from './proxy.js';

const exec = promisify(execFile);
const unitName = 'localmcp.service';

export function systemdUnit(options: { nodePath: string; agentPath: string; proxy?: string }): string {
  const start = `${quoteSystemd(options.nodePath)} ${quoteSystemd(options.agentPath)}`;
  const environment = [`Environment=NO_PROXY=127.0.0.1,localhost,::1`];
  if (options.proxy) {
    environment.push(`Environment=HTTP_PROXY=${options.proxy}`, `Environment=HTTPS_PROXY=${options.proxy}`);
  }
  return `[Unit]
Description=LocalMCP enhanced edition
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${start}
Restart=on-failure
RestartSec=3
RestartPreventExitStatus=${EXIT_DISPLACED} ${EXIT_ALREADY_RUNNING}
KillSignal=SIGTERM
TimeoutStopSec=8
NoNewPrivileges=true
${environment.join('\n')}

[Install]
WantedBy=default.target
`;
}

/**
 * Startup-folder entry. It starts a hidden supervisor (`localmcp autostart run --detach`)
 * and returns at once, so the console window only flashes at login.
 */
export function windowsStartupScript(options: { nodePath: string; cliPath: string; proxy?: string }): string {
  const batch = (value: string) => value.replace(/%/g, '%%');
  const proxy = options.proxy
    ? `set "HTTP_PROXY=${batch(options.proxy)}"\r\nset "HTTPS_PROXY=${batch(options.proxy)}"\r\nset "NO_PROXY=127.0.0.1,localhost,::1"\r\n`
    : '';
  return `@echo off\r\nrem Written by "localmcp autostart install". Remove with "localmcp autostart remove".\r\n${proxy}"${options.nodePath}" "${options.cliPath}" autostart run --detach\r\n`;
}

export function unitPath(home = homedir()): string {
  return resolve(home, '.config', 'systemd', 'user', unitName);
}

export function windowsStartupPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const appData = env.APPDATA || resolve(home, 'AppData', 'Roaming');
  return resolve(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'localmcp.cmd');
}

export interface AutostartPaths { nodePath: string; agentPath: string; cliPath: string }

export async function autostart(action: 'install' | 'remove' | 'status', paths: AutostartPaths): Promise<string> {
  if (process.platform === 'win32') return windowsAutostart(action, paths);
  return linuxAutostart(action, paths);
}

async function linuxAutostart(action: 'install' | 'remove' | 'status', paths: AutostartPaths): Promise<string> {
  const file = unitPath();
  if (action === 'status') {
    try { return `enabled\n${await readFile(file, 'utf8')}`; }
    catch { return 'not-installed'; }
  }
  if (action === 'remove') {
    await exec('systemctl', ['--user', 'disable', '--now', unitName]).catch(() => {});
    await rm(file, { force: true });
    await exec('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    return `Removed ${file}`;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, systemdUnit({ nodePath: paths.nodePath, agentPath: paths.agentPath, proxy: getProxyUrl() }), { mode: 0o600 });
  try {
    await exec('systemctl', ['--user', 'daemon-reload']);
    await exec('systemctl', ['--user', 'enable', '--now', unitName]);
    return `Installed and started ${file}\nTo start at boot without logging in, run: loginctl enable-linger "$USER"`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Wrote ${file}, but systemctl --user failed (${message}). On a machine with systemd, run: systemctl --user enable --now ${unitName}`;
  }
}

async function windowsAutostart(action: 'install' | 'remove' | 'status', paths: AutostartPaths): Promise<string> {
  const file = windowsStartupPath();
  if (action === 'status') {
    try { await readFile(file); return `installed ${file}`; }
    catch { return 'not-installed'; }
  }
  // Early 0.4.0 builds also created a logon task, which started a second agent.
  await exec('schtasks', ['/Delete', '/TN', 'LocalMCP', '/F']).catch(() => {});
  if (action === 'remove') {
    await rm(file, { force: true });
    return `Removed ${file}`;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, windowsStartupScript({ nodePath: paths.nodePath, cliPath: paths.cliPath, proxy: getProxyUrl() }));
  return `Installed ${file}. At login it starts a hidden supervisor that restarts the agent after a crash and logs to ~/.localmcp/agent.log.`;
}

export interface SuperviseOptions {
  nodePath: string;
  agentPath: string;
  logFile: string;
  env?: NodeJS.ProcessEnv;
  /** First restart delay; doubles while the agent keeps failing quickly. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** A run at least this long resets the restart delay. */
  stableMs?: number;
}

/**
 * Run the agent in the foreground and restart it after a crash. Returns the final exit
 * code once the agent stops on request (0), was displaced, or found another agent running.
 */
export async function superviseAgent(options: SuperviseOptions): Promise<number> {
  const minDelay = options.minDelayMs ?? 3000;
  const maxDelay = options.maxDelayMs ?? 60000;
  const stable = options.stableMs ?? 60000;
  let delay = minDelay;
  await mkdir(dirname(options.logFile), { recursive: true, mode: 0o700 });
  while (true) {
    const started = Date.now();
    const log = await open(options.logFile, 'a', 0o600);
    let code: number;
    try {
      code = await new Promise<number>(resolveExit => {
        // windowsHide keeps the agent's console (and the shells it starts) invisible.
        const child = spawn(options.nodePath, [options.agentPath], { stdio: ['ignore', log.fd, log.fd], env: options.env ?? process.env, windowsHide: true });
        child.once('error', () => resolveExit(1));
        child.once('exit', exitCode => resolveExit(exitCode ?? 1));
      });
    } finally { await log.close(); }
    if (FINAL_EXIT_CODES.includes(code)) return code;
    // A run that lasted a while starts the backoff over.
    if (Date.now() - started >= stable) delay = minDelay;
    await appendFile(options.logFile, `${new Date().toISOString()} LocalMCP agent exited with code ${code}; restarting in ${Math.ceil(delay / 1000)}s.\n`);
    await new Promise(resolveWait => setTimeout(resolveWait, delay));
    delay = Math.min(maxDelay, delay * 2);
  }
}

function quoteSystemd(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
