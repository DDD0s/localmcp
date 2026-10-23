#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { startLocalRuntime } from './runtime.js';
import { packageName, version } from './version.js';
import { redactMcpUrl } from './redact.js';

let revealUrl = false;

async function ensureInitialized(force = false) {
  const { copyFile, access, cp, mkdir } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configDir = resolve(homedir(), '.localmcp');
  const target = resolve(configDir, 'localmcp.json');
  const skillsTarget = resolve(configDir, 'skills');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  let created = false;
  try { await access(target); } catch (error: any) { if (error.code !== 'ENOENT') throw error; await copyFile(resolve(packageRoot, 'localmcp.example.json'), target); created = true; }
  try { await access(skillsTarget); } catch (error: any) { if (error.code !== 'ENOENT') throw error; await cp(resolve(packageRoot, 'skills'), skillsTarget, { recursive: true }); created = true; }
  if (created || force) console.log(created ? `Initialized ${configDir}` : `Already initialized: ${configDir}`);
}

async function main() {
  revealUrl = process.argv.includes('--show-url');
  for (let index = process.argv.length - 1; index >= 0; index--) if (process.argv[index] === '--show-url') process.argv.splice(index, 1);
  const mode = process.argv[2] || 'start';
  if (mode === '--version' || mode === '-v' || mode === 'version') { console.log(`${packageName} ${version}`); return; }
  if (mode === 'init') { await ensureInitialized(true); return; }
  if (mode === 'update') { await updateCommand(); return; }
  if (mode === 'relay') { await relayCommand(); return; }
  if (mode === 'register-token') { await registerTokenCommand(); return; }
  if (mode === 'autostart') { await autostartCommand(); return; }
  if (mode === 'health') { await healthCommand(); return; }
  if (['start', 'stop', 'reload', 'status'].includes(mode)) {
    const { control, status, printStatus } = await import('./lifecycle.js');
    if (mode === 'status') {
      const value = await status();
      printStatus(value, { showUrl: revealUrl });
      process.exitCode = value.status === 'running' && value.ready ? 0 : 1;
    } else await control(mode as 'start' | 'stop' | 'reload', ensureInitialized, { showUrl: revealUrl });
    return;
  }
  if (mode === 'agent') { await ensureInitialized(); await import('./agent.js'); return; }
  const cfg = await config();
  if (!['stdio', 'http'].includes(mode)) throw new Error('Usage: localmcp [start|status|stop|reload|health|init|update|relay|register-token|autostart|agent|stdio|http|version] [--show-url]');
  if (mode === 'http' && (!cfg.token || cfg.token.length < 32)) throw new Error('HTTP requires LOCALMCP_TOKEN with at least 32 characters');
  const runtime = await startLocalRuntime();
  const shutdown: Array<() => Promise<unknown>> = [() => runtime.close()];
  if (mode === 'stdio') {
    await runtime.server.connect(new StdioServerTransport());
  } else {
    const app = express();
    app.disable('x-powered-by');
    app.get('/healthz', (_req, res) => { res.json({ ok: true }); });
    app.use((req, res, next) => {
      if (req.headers.origin) { res.sendStatus(403); return; }
      const pathToken = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(req.path)?.[1];
      const supplied = Buffer.from(pathToken ? `Bearer ${pathToken}` : req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${cfg.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.sendStatus(404); return; }
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    app.use(express.json({ limit: '2mb' }));
    app.post(['/mcp', '/mcp/:token'], async (req, res) => {
      try {
        const protocol = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : undefined;
        const result = await runtime.handle(JSON.stringify(req.body ?? {}), protocol);
        res.status(result.status).type('application/json').send(result.body);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
      }
    });
    app.all(['/mcp', '/mcp/:token'], (_req, res) => { res.setHeader('Allow', 'POST'); res.sendStatus(405); });
    const listener = app.listen(cfg.port, '127.0.0.1', () => { if (process.env.LOCALMCP_INTERNAL !== '1') console.error(`localmcp listening on http://127.0.0.1:${cfg.port}/mcp`); });
    listener.on('error', error => { console.error(error.message); process.exit(1); });
    shutdown.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
  }
  const stop = async () => { for (const fn of shutdown) await fn(); process.exit(0); };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  if (process.platform === 'win32') process.once('SIGBREAK', () => void stop());
}

async function healthCommand() {
  const { installProxyDispatcher } = await import('./proxy.js');
  const proxy = installProxyDispatcher();
  const { healthReport } = await import('./lifecycle.js');
  const report = await healthReport({ showUrl: revealUrl });
  if (proxy) console.log(`proxy: ${proxy}`);
  console.log(report.lines.join('\n'));
  process.exitCode = report.code;
}

async function relayCommand() {
  const { homedir } = await import('node:os');
  const { resolve } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { configureRelay, mcpUrl, DEFAULT_PUBLIC_WORKER_URL } = await import('./relay-settings.js');
  const stateDir = resolve(homedir(), '.localmcp');
  const args = process.argv.slice(3);
  if (args.length === 0 || args.includes('--show')) {
    try {
      const saved = JSON.parse(await readFile(resolve(stateDir, 'worker.json'), 'utf8'));
      console.log(`Relay: ${saved.workerUrl || DEFAULT_PUBLIC_WORKER_URL}`);
      if (saved.publicBaseUrl) console.log(`Public URL: ${saved.publicBaseUrl}`);
      if (saved.mcpToken) console.log(`MCP URL: ${revealUrl ? mcpUrl(saved) : redactMcpUrl(mcpUrl(saved))}${revealUrl ? '' : '\nFull URL: localmcp relay --show-url'}`);
      else console.log('MCP URL: not registered yet');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      console.log(`Relay: ${DEFAULT_PUBLIC_WORKER_URL} (default, not saved yet)`);
    }
    return;
  }
  let workerUrl: string | undefined;
  let publicBaseUrl: string | undefined;
  let clearPublic = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--public') { publicBaseUrl = args[++i]; if (!publicBaseUrl) throw new Error('Usage: localmcp relay [url] [--public https://mcp.example.com]'); }
    else if (arg === '--clear-public') clearPublic = true;
    else if (arg.startsWith('--')) throw new Error('Usage: localmcp relay [url] [--public https://mcp.example.com] [--clear-public]');
    else workerUrl = arg;
  }
  const saved = await configureRelay(stateDir, { workerUrl, publicBaseUrl: clearPublic ? null : publicBaseUrl });
  console.log(`Relay saved: ${saved.workerUrl}`);
  if ('publicBaseUrl' in saved && saved.publicBaseUrl) console.log(`Public URL: ${saved.publicBaseUrl}`);
  if ('mcpToken' in saved && saved.mcpToken) console.log(`MCP URL: ${revealUrl ? mcpUrl(saved as any) : redactMcpUrl(mcpUrl(saved as any))}${revealUrl ? '' : '\nFull URL: localmcp status --show-url'}`);
  console.log('Restart localmcp so the change applies. 中继地址已保存，请重新启动 localmcp。已有 deviceId 会原样重绑，ChatGPT 里的路径保持不变。');
}

async function autostartCommand() {
  const action = process.argv[3] || 'status';
  if (!['install', 'remove', 'status', 'run'].includes(action)) throw new Error('Usage: localmcp autostart [install|remove|status|run [--detach]]');
  const { autostart, superviseAgent } = await import('./autostart.js');
  const nodePath = process.execPath;
  const agentPath = fileURLToPath(new URL('./agent.js', import.meta.url));
  const cliPath = fileURLToPath(import.meta.url);
  if (action === 'run') {
    if (process.argv.includes('--detach')) {
      // Startup-folder entry point: hand off to a supervisor without a console and return.
      spawn(nodePath, [cliPath, 'autostart', 'run'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
      return;
    }
    await ensureInitialized();
    const { logFile } = await import('./lifecycle.js');
    process.exitCode = await superviseAgent({ nodePath, agentPath, logFile });
    return;
  }
  console.log(await autostart(action as 'install' | 'remove' | 'status', { nodePath, agentPath, cliPath }));
}


async function registerTokenCommand() {
  const { homedir } = await import('node:os');
  const { resolve } = await import('node:path');
  const { setRegisterToken } = await import('./relay-settings.js');
  const stateDir = resolve(homedir(), '.localmcp');
  const arg = process.argv[3];
  if (!arg) throw new Error('Usage: localmcp register-token <secret>|--clear\nStores the Worker REGISTER_TOKEN for /register (also accepts LOCALMCP_REGISTER_TOKEN).');
  if (arg === '--clear') {
    await setRegisterToken(stateDir, null);
    console.log('Cleared saved register token.');
    return;
  }
  await setRegisterToken(stateDir, arg);
  console.log('Saved register token for self-hosted /register. Restart is not required until the next register/rebind.');
}

async function updateCommand() {
  const { updateFromGitHub } = await import('./update.js');
  const ref = process.argv[3];
  const installed = await updateFromGitHub({ ref, expectedName: packageName });
  console.log(`Installed ${installed.name} ${installed.version} from ${installed.tag} (${installed.commit}). A running agent keeps the old code until: localmcp stop && localmcp`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
