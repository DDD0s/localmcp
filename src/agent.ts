#!/usr/bin/env node
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stateDir, logFile, serveControl, status, type Status } from './lifecycle.js';
import { controlEndpoint } from './control-endpoint.js';
import { EXIT_ALREADY_RUNNING, EXIT_DISPLACED } from './exit-codes.js';
import WebSocket from 'ws';
import { Assembly, buildFrames, gunzipJson, parseFrame, type Assembled } from './relay-protocol.js';
import { agentSocketUrl, loadRelaySettings, mcpUrl, probeRelay, rebindRelay, type RelayCapabilities, type RelaySettings } from './relay-settings.js';
import { createWebSocketProxyAgent, installProxyDispatcher } from './proxy.js';
import { startLocalRuntime, type LocalRuntime } from './runtime.js';
import { redactMcpUrl, redactSecrets } from './redact.js';

const pidFile = resolve(stateDir, 'agent.pid');
let closing = false;
let ready = false;
let mcpEndpoint: string | null = null;
let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let reloading: Promise<void> | undefined;
let runtime: LocalRuntime | undefined;
let settings: RelaySettings | undefined;
let caps: RelayCapabilities = { protocol: 1, chunkSize: 24000, compress: false };
let attempt = 0;
let bannerPrinted = false;
let rebound = false;
let generation = 0;

function log(message: string) {
  console.error(`${new Date().toISOString()} ${redactSecrets(message)}`);
}

const configPath = resolve(process.env.LOCALMCP_CONFIG || resolve(stateDir, 'localmcp.json'));
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const closeControl = await claimControl();

/** Serve the control endpoint, which also makes this the only agent for stateDir. */
async function claimControl() {
  const serve = () => serveControl(
    (): Status => ({ status: 'running', pid: process.pid, url: mcpEndpoint, config: configPath, log: logFile, ready }),
    () => { void stop(0); },
    () => reloading ??= reloadLocal().finally(() => { reloading = undefined; }),
  );
  try { return await serve(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    const { socketFile } = controlEndpoint(stateDir);
    const current = await status().catch(() => undefined);
    // A Windows pipe name is only taken while its server is alive. On Unix, only a
    // socket file that refuses connections is treated as left over.
    if (current?.status !== 'stopped' || !socketFile) {
      log(`Another LocalMCP agent${current?.pid ? ` (PID ${current.pid})` : ''} already serves ${stateDir}. This process is exiting.`);
      process.exit(EXIT_ALREADY_RUNNING);
    }
    // A killed process left its Unix socket file behind and nothing listens on it.
    await rm(socketFile, { force: true });
    return serve();
  }
}
await writeFile(pidFile, String(process.pid), { mode: 0o600 });

process.once('SIGINT', () => { void stop(0); });
process.once('SIGTERM', () => { void stop(0); });
if (process.platform === 'win32') process.once('SIGBREAK', () => { void stop(0); });
process.on('SIGHUP', () => { if (!reloading) reloading = reloadLocal().catch(error => log(error instanceof Error ? error.message : String(error))).finally(() => { reloading = undefined; }); });
process.on('uncaughtException', error => { log(error instanceof Error ? error.stack || error.message : String(error)); void stop(1); });
process.on('unhandledRejection', error => { log(error instanceof Error ? error.stack || error.message : String(error)); void stop(1); });

try {
  const proxy = installProxyDispatcher();
  if (proxy) log(`Using HTTP proxy ${proxy}. Loopback addresses bypass it. 已使用代理，本机地址不走代理。`);
  settings = await loadRelaySettings(stateDir);
  mcpEndpoint = mcpUrl(settings);
  const { writeFile: writeConnection } = await import('node:fs/promises');
  await writeConnection(resolve(stateDir, 'connection.json'), JSON.stringify({
    url: mcpEndpoint,
    authentication: 'none',
    transport: 'worker-websocket',
    deviceId: settings.deviceId,
    workerUrl: settings.workerUrl,
    publicBaseUrl: settings.publicBaseUrl || null,
    root: process.env.LOCALMCP_ROOT || process.cwd(),
  }, null, 2), { mode: 0o600 });
  const [started, probed] = await Promise.all([startLocalRuntime(), probeRelay(settings.workerUrl)]);
  runtime = started;
  caps = probed;
  log(`Relay protocol ${caps.protocol}, chunk ${caps.chunkSize}, compress ${caps.compress}.`);
  connect();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  await stop(1);
}

function connect() {
  if (closing || !settings || !runtime) return;
  clearTimeout(reconnect);
  const current = ++generation;
  // A timer and a rebind can both reconnect; never keep two sockets for one device.
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  const wsUrl = agentSocketUrl(settings.workerUrl, settings.deviceId);
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.agentToken}`, 'x-localmcp-takeover': '1' };
  if (caps.protocol >= 2) {
    headers['x-localmcp-chunk'] = String(caps.chunkSize);
    if (caps.compress) headers['x-localmcp-compress'] = '1';
  }
  const ws = new WebSocket(wsUrl, { headers, handshakeTimeout: 15000, maxPayload: 1024 * 1024, agent: createWebSocketProxyAgent(wsUrl) });
  socket = ws;
  let assembly: Assembly | undefined;
  let requestId: string | undefined;
  let pong = Date.now();
  heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - pong > 65000) { ws.terminate(); return; }
    try { ws.send('ping'); } catch { /* close handler reconnects */ }
  }, 25000);
  ws.on('open', () => {
    ready = true;
    attempt = 0;
    if (!bannerPrinted) {
      bannerPrinted = true;
      console.log(`LocalMCP is running\n\nMCP URL:\n${redactMcpUrl(mcpEndpoint)}\n\nFull URL: localmcp status --show-url\nAuthentication: None\nConfig: ${configPath}\n\nUse localmcp stop to stop. 使用 localmcp stop 停止。`);
    } else log('Relay session restored. 中继已重新连接。');
  });
  ws.on('unexpected-response', (_request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let handled = false;
    const finish = () => {
      if (handled) return;
      handled = true;
      clearTimeout(bodyTimer);
      const body = Buffer.concat(chunks).toString('utf8').slice(0, 500);
      log(`Relay rejected the connection (${response.statusCode}): ${body || response.statusMessage}`);
      if (response.statusCode === 404 && !rebound) void rebindAndReconnect();
      else if (response.statusCode === 409) log('The relay kept the existing session. This process will retry with takeover; stop the other localmcp if it is still running. 中继上仍有会话，将继续尝试接管。');
      // With this listener attached, ws leaves the handshake pending instead of aborting it.
      // Terminate so 'close' fires and the backoff below schedules the next attempt.
      ws.terminate();
    };
    const bodyTimer = setTimeout(finish, 5000);
    response.on('data', (chunk: Buffer) => { if (size < 4096) { chunks.push(chunk); size += chunk.length; } });
    response.on('end', finish);
    response.on('error', finish);
  });
  ws.on('message', data => { void onMessage(ws, data.toString(), () => { pong = Date.now(); }, state => { assembly = state.assembly; requestId = state.requestId; }, () => ({ assembly, requestId })); });
  ws.on('error', error => log(`Worker connection error: ${error.message}`));
  ws.on('close', code => {
    ready = false;
    clearInterval(heartbeat);
    if (closing || current !== generation) return;
    if (code === 4000) {
      log('Another authenticated agent reclaimed this device. This process is exiting so it does not steal the session back. 另一个已认证的 Agent 接管了会话，本进程退出。');
      void stop(EXIT_DISPLACED);
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 1000;
    attempt++;
    log(`Worker disconnected (${code}); reconnecting in ${Math.ceil(delay / 1000)}s. In-flight requests are not replayed. 连接已断开，正在重试。`);
    reconnect = setTimeout(connect, delay);
  });
}

async function onMessage(ws: WebSocket, message: string, touch: () => void, setState: (state: { assembly?: Assembly; requestId?: string }) => void, getState: () => { assembly?: Assembly; requestId?: string }) {
  if (message === 'pong') { touch(); return; }
  const respond = async (id: string, value: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const frame of await buildFrames(id, value, { chunkSize: caps.chunkSize, compress: caps.compress })) ws.send(frame);
  };
  try {
    const frame = parseFrame(message);
    let { assembly, requestId } = getState();
    if (!assembly) {
      assembly = new Assembly();
      requestId = frame.id;
      setState({ assembly, requestId });
    }
    if (requestId !== frame.id) throw new Error('Overlapping requests');
    const complete = assembly.push(frame);
    if (!complete) return;
    setState({});
    const value = await unpack(complete) as { body?: string; protocolVersion?: string };
    if (!value || typeof value.body !== 'string' || Buffer.byteLength(value.body) > 2 * 1024 * 1024) throw new Error('Invalid request body');
    JSON.parse(value.body);
    if (!runtime) throw new Error('Local runtime is not ready');
    try {
      const result = await runtime.handle(value.body, value.protocolVersion);
      try { await respond(frame.id, { status: result.status, body: result.body }); }
      catch { await respond(frame.id, { status: 502, body: JSON.stringify({ error: 'Tool response exceeds the relay limit. Outcome may be unknown; do not automatically retry.' }) }); }
    } catch {
      await respond(frame.id, { status: 502, body: JSON.stringify({ error: 'Local call failed or timed out. Outcome may be unknown; do not automatically retry.' }) });
    }
  } catch { ws.close(1008, 'Invalid relay request'); }
}

async function unpack(complete: Assembled): Promise<unknown> {
  if ('gzip' in complete) return gunzipJson(complete.gzip);
  return complete.value;
}

async function rebindAndReconnect() {
  if (closing || rebound || !settings?.deviceId) return;
  rebound = true;
  log('Relay did not recognize this device. Trying one stable rebind with the saved credentials. 正在用已保存的凭证重新绑定，URL 不变。');
  try {
    settings = await rebindRelay(stateDir);
    mcpEndpoint = mcpUrl(settings);
    connect();
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
}

async function reloadLocal() {
  if (closing || !runtime) throw new Error('LocalMCP is not ready');
  await runtime.reload();
}

async function stop(code = 0) {
  if (closing) return;
  closing = true;
  ready = false;
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  const current = socket;
  if (current && current.readyState === WebSocket.OPEN) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 300);
      current.once('close', () => { clearTimeout(timer); resolve(); });
      try { current.close(1000, 'LocalMCP shutting down'); } catch { clearTimeout(timer); resolve(); }
    });
  } else current?.terminate();
  await runtime?.close().catch(error => log(error instanceof Error ? error.message : String(error)));
  await unlink(pidFile).catch(() => {});
  await closeControl().catch(() => {});
  log('LocalMCP stopped. 已停止。');
  process.exit(code);
}
