import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
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
KillSignal=SIGTERM
TimeoutStopSec=8
NoNewPrivileges=true
${environment.join('\n')}

[Install]
WantedBy=default.target
`;
}

export function windowsStartupScript(options: { nodePath: string; agentPath: string; proxy?: string }): string {
  const proxy = options.proxy
    ? `set "HTTP_PROXY=${options.proxy}"\r\nset "HTTPS_PROXY=${options.proxy}"\r\nset "NO_PROXY=127.0.0.1,localhost,::1"\r\n`
    : '';
  return `@echo off\r\n${proxy}"${options.nodePath}" "${options.agentPath}"\r\n`;
}

export function unitPath(home = homedir()): string {
  return resolve(home, '.config', 'systemd', 'user', unitName);
}

export function windowsStartupPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const appData = env.APPDATA || resolve(home, 'AppData', 'Roaming');
  return resolve(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'localmcp.cmd');
}

export async function autostart(action: 'install' | 'remove' | 'status', paths: { nodePath: string; agentPath: string }): Promise<string> {
  if (process.platform === 'win32') return windowsAutostart(action, paths);
  return linuxAutostart(action, paths);
}

async function linuxAutostart(action: 'install' | 'remove' | 'status', paths: { nodePath: string; agentPath: string }): Promise<string> {
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
  await writeFile(file, systemdUnit({ ...paths, proxy: getProxyUrl() }), { mode: 0o600 });
  try {
    await exec('systemctl', ['--user', 'daemon-reload']);
    await exec('systemctl', ['--user', 'enable', '--now', unitName]);
    return `Installed and started ${file}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Wrote ${file}, but systemctl --user failed (${message}). On a machine with systemd, run: systemctl --user enable --now ${unitName}`;
  }
}

async function windowsAutostart(action: 'install' | 'remove' | 'status', paths: { nodePath: string; agentPath: string }): Promise<string> {
  const file = windowsStartupPath();
  if (action === 'status') {
    try { await readFile(file); return `installed ${file}`; }
    catch { return 'not-installed'; }
  }
  if (action === 'remove') {
    await exec('schtasks', ['/Delete', '/TN', 'LocalMCP', '/F']).catch(() => {});
    await rm(file, { force: true });
    return `Removed ${file}`;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, windowsStartupScript({ ...paths, proxy: getProxyUrl() }));
  const task = `"${paths.nodePath}" "${paths.agentPath}"`;
  try {
    await exec('schtasks', ['/Create', '/TN', 'LocalMCP', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', task]);
    return `Installed ${file} and scheduled task LocalMCP`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Wrote ${file}. schtasks failed (${message}). The Startup-folder script still runs at login.`;
  }
}

function quoteSystemd(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
