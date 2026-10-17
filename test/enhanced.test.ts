import { randomBytes } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { Assembly, CHUNK_SIZE, buildFrames, frames, gunzipJson, parseFrame } from '../src/relay-protocol.js';
import { configureRelay, loadRelaySettings, mcpUrl, rebindRelay } from '../src/relay-settings.js';
import { resolvePublicBase } from '../src/public-url.js';
import { createWebSocketProxyAgent, shouldBypassProxy } from '../src/proxy.js';
import { systemdUnit, windowsStartupScript } from '../src/autostart.js';
import { Workspace } from '../src/workspace.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket, { WebSocketServer } from 'ws';

test('default frames stay compatible and negotiated gzip shrinks repetitive output', async () => {
  const repetitive = { output: 'error line\n'.repeat(20000) };
  const plain = frames('same-id', repetitive);
  assert.equal(CHUNK_SIZE, 24000);
  assert.ok(plain.length > 5);
  const compact = await buildFrames('same-id', repetitive, { chunkSize: 120000, compress: true });
  assert.ok(compact.length < plain.length);
  assert.equal(JSON.parse(compact[0]).enc, 'gzip');
  const assembly = new Assembly();
  let packed: Awaited<ReturnType<Assembly['push']>>;
  for (const raw of compact) packed = assembly.push(parseFrame(raw));
  assert.ok(packed && 'gzip' in packed);
  assert.deepEqual(await gunzipJson(packed.gzip), repetitive);
  const tiny = await buildFrames('tiny', { ok: true }, { compress: true, chunkSize: 120000 });
  assert.equal(JSON.parse(tiny[0]).enc, undefined);
  const noisy = await buildFrames('noise', { blob: randomBytes(8000).toString('base64') }, { compress: true, chunkSize: 120000 });
  assert.equal(JSON.parse(noisy[0]).enc, undefined);
});

test('public URL accepts a custom origin and rejects paths', () => {
  assert.equal(resolvePublicBase('https://localmcp-relay.example.workers.dev', 'https://mcp.example.com'), 'https://mcp.example.com');
  assert.equal(resolvePublicBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.throws(() => resolvePublicBase('https://mcp.example.com', 'https://mcp.example.com/mcp'), /origin/);
  assert.throws(() => resolvePublicBase('http://relay.example.com'), /HTTPS/);
});

test('saved identity restores the same MCP URL and refuses a rotating relay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'localmcp-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body || '{}')));
    const body = calls.at(-1) as { deviceId?: string };
    if (!body.deviceId) {
      return new Response(JSON.stringify({ deviceId: '11111111-1111-4111-8111-111111111111', agentToken: 'a'.repeat(64), mcpToken: 'b'.repeat(64), workerUrl: 'http://127.0.0.1:9', publicBaseUrl: 'http://127.0.0.1:9' }), { status: 201 });
    }
    return new Response(JSON.stringify({ deviceId: '22222222-2222-4222-8222-222222222222', agentToken: 'c'.repeat(64), mcpToken: 'd'.repeat(64) }), { status: 201 });
  };
  const env = { LOCALMCP_WORKER_URL: 'http://127.0.0.1:9' };
  const first = await loadRelaySettings(root, env, fetchImpl);
  assert.equal(calls.length, 1);
  const url = mcpUrl(first);
  await rm(join(root, 'worker.json'));
  const restored = await loadRelaySettings(root, env, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(mcpUrl(restored), url);
  const moved = { ...env, LOCALMCP_WORKER_URL: 'http://127.0.0.1:10' };
  await assert.rejects(loadRelaySettings(root, moved, fetchImpl), /keeping the current MCP URL/);
  assert.equal(mcpUrl(JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'))), url);
});

test('configureRelay keeps credentials while changing the public origin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'localmcp-relay-cfg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ deviceId: '11111111-1111-4111-8111-111111111111', agentToken: 'a'.repeat(64), mcpToken: 'b'.repeat(64) }), { status: 201 });
  const settings = await loadRelaySettings(root, { LOCALMCP_WORKER_URL: 'http://127.0.0.1:9' }, fetchImpl);
  const updated = await configureRelay(root, { workerUrl: 'http://127.0.0.1:9', publicBaseUrl: 'https://mcp.example.com' });
  assert.equal(updated.publicBaseUrl, 'https://mcp.example.com');
  if (!('mcpToken' in updated)) throw new Error('credentials missing');
  assert.equal(updated.mcpToken, settings.mcpToken);
  assert.equal(mcpUrl(updated), `https://mcp.example.com/mcp/${settings.deviceId}/${settings.mcpToken}`);
  await assert.rejects(rebindRelay(root, async () => new Response(JSON.stringify({ deviceId: '33333333-3333-4333-8333-333333333333', agentToken: 'e'.repeat(64), mcpToken: 'f'.repeat(64) }), { status: 201 })), /left unchanged/);
});

test('allowed directories scope file tools and fileWrites can be disabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'localmcp-perm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'ok'));
  const ws = new Workspace(root, [join(root, 'ok')]);
  await ws.write('ok/a.txt', 'safe', false);
  assert.equal(await ws.read('ok/a.txt'), 'safe');
  await assert.rejects(ws.read('secret.txt'), /allowed directories/);
  await assert.rejects(ws.path('.'), /allowed directories/);
  const cfg = join(root, 'localmcp.json');
  await writeFile(cfg, JSON.stringify({ workspaces: { home: root }, defaultWorkspace: 'home', features: { files: true, fileWrites: false, shell: true, processes: false }, allowedDirectories: ['ok'] }));
  const client = new Client({ name: 'perm', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js'), 'stdio'], env: { LOCALMCP_CONFIG: cfg }, stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('run_command'));
  assert.ok(!names.includes('write_file'));
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: 'ok/no.txt', content: 'x' } })).isError, true);
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: 'ok/a.txt' } })).isError, undefined);
  const escaped: any = await client.callTool({ name: 'run_command', arguments: { command: 'printf nope', cwd: '.' } });
  assert.equal(escaped.isError, true);
  assert.match(escaped.content[0].text, /allowed directories/);
});

test('autostart templates quote paths and keep loopback off the proxy', () => {
  const unit = systemdUnit({ nodePath: '/usr/bin/node', agentPath: '/opt/Local MCP/agent.js', proxy: 'http://127.0.0.1:7897' });
  assert.match(unit, /ExecStart=\/usr\/bin\/node "\/opt\/Local MCP\/agent\.js"/);
  assert.match(unit, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:7897/);
  assert.match(unit, /NO_PROXY=127\.0\.0\.1,localhost,::1/);
  assert.match(unit, /Restart=on-failure/);
  const cmd = windowsStartupScript({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', agentPath: 'C:\\Users\\张三\\agent.js', proxy: 'http://127.0.0.1:7897' });
  assert.match(cmd, /张三/);
  assert.match(cmd, /HTTP_PROXY=http:\/\/127\.0\.0\.1:7897/);
});

test('websocket client uses HTTP CONNECT proxy and bypasses loopback', async t => {
  assert.equal(shouldBypassProxy(new URL('http://127.0.0.1:8787'), { NO_PROXY: '' }), true);
  assert.equal(shouldBypassProxy(new URL('https://relay.workers.dev'), { NO_PROXY: 'workers.dev' }), true);
  const target = createHttpServer();
  const wss = new WebSocketServer({ server: target });
  wss.on('connection', ws => ws.on('message', message => ws.send(`echo:${message}`)));
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', () => resolve()));
  const targetPort = (target.address() as { port: number }).port;
  let sawConnect = false;
  const proxy = createHttpServer();
  proxy.on('connect', (_req, client, head) => {
    sawConnect = true;
    const upstream = netConnect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()));
  const proxyPort = (proxy.address() as { port: number }).port;
  t.after(() => { wss.close(); target.close(); proxy.close(); });
  const env = { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '' };
  assert.equal(createWebSocketProxyAgent(new URL(`ws://127.0.0.1:${targetPort}`), env), undefined);
  const proxied = new WebSocket(`ws://example.test:${targetPort}`, { agent: createWebSocketProxyAgent(new URL(`ws://example.test:${targetPort}`), env) });
  const message = await new Promise<string>((resolve, reject) => {
    proxied.on('open', () => proxied.send('hello'));
    proxied.on('message', data => resolve(String(data)));
    proxied.on('error', reject);
  });
  assert.equal(message, 'echo:hello');
  assert.equal(sawConnect, true);
  proxied.close();
});

test('health and status exit codes when nothing is running', async t => {
  const home = await mkdtemp(join(tmpdir(), 'localmcp-health-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = (command: string) => new Promise<{ code: number; stdout: string }>(done => {
    execFile(process.execPath, [resolve('dist/index.js'), command], { env: { ...process.env, HOME: home, USERPROFILE: home } }, (error, stdout) => {
      done({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout: stdout ?? '' });
    });
  });
  const status = await run('status');
  assert.equal(status.code, 1);
  assert.match(status.stdout, /Status: stopped/);
  const health = await run('health');
  assert.equal(health.code, 1);
  assert.match(health.stdout, /unhealthy/);
  const version = await run('version');
  assert.equal(version.code, 0);
  assert.match(version.stdout, /@ddd0s\/localmcp 0\.4\.0/);
});

test('global fetch proxy is installed without capturing loopback', async t => {
  const previous = getGlobalDispatcher();
  t.after(() => setGlobalDispatcher(previous));
  const target = createHttpServer((_req, res) => { res.end('direct'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', () => resolve()));
  const port = (target.address() as { port: number }).port;
  let proxied = false;
  const proxy = createHttpServer((_req, res) => { proxied = true; res.end('proxied'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()));
  const proxyPort = (proxy.address() as { port: number }).port;
  t.after(() => { target.close(); proxy.close(); });
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
  const { installProxyDispatcher } = await import('../src/proxy.js');
  assert.ok(installProxyDispatcher());
  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).text();
  assert.equal(body, 'direct');
  assert.equal(proxied, false);
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
});
