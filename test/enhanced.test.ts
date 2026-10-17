import { randomBytes } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { Assembly, CHUNK_SIZE, buildFrames, frames, gunzipJson, parseFrame } from '../src/relay-protocol.js';
import { configureRelay, loadRelaySettings, mcpUrl, rebindRelay } from '../src/relay-settings.js';
import { resolvePublicBase } from '../src/public-url.js';
import { createWebSocketProxyAgent, shouldBypassProxy } from '../src/proxy.js';
import { superviseAgent, systemdUnit, windowsStartupScript } from '../src/autostart.js';
import { EXIT_ALREADY_RUNNING, EXIT_DISPLACED } from '../src/exit-codes.js';
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
  assert.match(unit, new RegExp(`RestartPreventExitStatus=${EXIT_DISPLACED} ${EXIT_ALREADY_RUNNING}`));
  const windowsCli = 'C:\\Users\\张三\\index.js';
  const cmd = windowsStartupScript({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: windowsCli, proxy: 'http://127.0.0.1:7897' });
  assert.match(cmd, /张三/);
  assert.match(cmd, /HTTP_PROXY=http:\/\/127\.0\.0\.1:7897/);
  assert.ok(cmd.includes(`"C:\\Program Files\\nodejs\\node.exe" "${windowsCli}" autostart run --detach`), cmd);
  assert.doesNotMatch(cmd, /schtasks|agent\.js/);
  // Percent signs would otherwise be expanded by cmd.exe.
  assert.match(windowsStartupScript({ nodePath: 'node', cliPath: 'cli.js', proxy: 'http://user:p%40ss@127.0.0.1:7897' }), /p%%40ss/);
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

test('every runtime import is a declared production dependency', async () => {
  // A bare import that only resolves through devDependencies works in a checkout
  // but crashes a real install (0.4.0 shipped proxy.ts importing undici this way).
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { dependencies: Record<string, string> };
  const declared = new Set(Object.keys(pkg.dependencies));
  const missing = new Set<string>();
  const files = (await readdir('src', { recursive: true })).filter(file => file.endsWith('.ts'));
  for (const file of files) {
    const source = await readFile(join('src', file), 'utf8');
    const statements = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].filter(m => !m[1]).map(m => m[2]);
    const dynamic = [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    for (const specifier of [...statements, ...dynamic]) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || builtinModules.includes(specifier)) continue;
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!declared.has(name)) missing.add(`${name} (src/${file})`);
    }
  }
  assert.deepEqual([...missing], []);
});

async function until(check: () => boolean, timeoutMs: number, detail: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(detail());
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>(resolveWait => setTimeout(() => resolveWait('timeout'), timeoutMs).unref())]);
}

function agentEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALMCP_SHELL: '0' };
  delete env.LOCALMCP_WORKER_URL;
  delete env.LOCALMCP_PUBLIC_URL;
  delete env.LOCALMCP_CONFIG;
  return env;
}

function startAgent(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [resolve('dist/index.js'), 'agent'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)));
  return { child, exited, output: () => output };
}

async function seedIdentity(home: string, workerUrl: string) {
  await mkdir(join(home, '.localmcp'), { recursive: true });
  await writeFile(join(home, '.localmcp', 'worker.json'), JSON.stringify({ workerUrl, agentToken: 'a'.repeat(64), mcpToken: 'b'.repeat(64), deviceId: '11111111-1111-4111-8111-111111111111' }));
}

test('agent retries rejected upgrades, refuses a duplicate and exits when displaced', { timeout: 90000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'localmcp-agent-'));
  let mode: 'reject' | 'displace' = 'reject';
  const attempts: string[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const relay = createHttpServer((req, res) => {
    if (req.url === '/healthz') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
    res.writeHead(404);
    res.end();
  });
  relay.on('upgrade', (req, socket, head) => {
    attempts.push(mode);
    if (mode === 'reject') {
      // What the original public relay answers while a stale session is still attached.
      const body = JSON.stringify({ error: 'An agent is already connected' });
      socket.end(`HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => ws.close(4000, 'Reclaimed by authenticated agent'));
  });
  await new Promise<void>(resolveListen => relay.listen(0, '127.0.0.1', () => resolveListen()));
  await seedIdentity(home, `http://127.0.0.1:${(relay.address() as { port: number }).port}`);
  const env = agentEnv(home);
  const first = startAgent(env);
  const duplicate: { agent?: ReturnType<typeof startAgent> } = {};
  t.after(async () => {
    for (const agent of [first, duplicate.agent]) if (agent && agent.child.exitCode === null) { agent.child.kill(); await agent.exited; }
    wss.close();
    relay.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await until(() => attempts.length >= 2, 20000, () => `expected a retry after HTTP 409, saw ${attempts.length}\n${first.output()}`);
  duplicate.agent = startAgent(env);
  assert.equal(await within(duplicate.agent.exited, 20000), EXIT_ALREADY_RUNNING, duplicate.agent.output());
  assert.equal(first.child.exitCode, null, 'the first agent keeps running');
  mode = 'displace';
  assert.equal(await within(first.exited, 30000), EXIT_DISPLACED, first.output());
});

test('agent replaces a stale control socket left by a killed process', { skip: process.platform === 'win32' ? 'Unix socket files only' : false, timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'localmcp-stale-'));
  const unused = createHttpServer();
  await new Promise<void>(resolveListen => unused.listen(0, '127.0.0.1', () => resolveListen()));
  const port = (unused.address() as { port: number }).port;
  await new Promise<void>(resolveClose => unused.close(() => resolveClose()));
  await seedIdentity(home, `http://127.0.0.1:${port}`);
  const socketFile = join(home, '.localmcp', 'agent.sock');
  const holder = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(socketFile)}, () => console.log('listening'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>(resolveListen => holder.stdout.on('data', () => resolveListen()));
  holder.kill('SIGKILL');
  await new Promise(resolveExit => holder.once('exit', resolveExit));
  assert.ok(existsSync(socketFile), 'SIGKILL leaves the socket file behind');
  const env = agentEnv(home);
  const agent = startAgent(env);
  t.after(async () => { if (agent.child.exitCode === null) { agent.child.kill(); await agent.exited; } await rm(home, { recursive: true, force: true }); });
  const status = () => new Promise<string>(done => execFile(process.execPath, [resolve('dist/index.js'), 'status'], { env }, (_error, stdout) => done(stdout ?? '')));
  let last = '';
  const deadline = Date.now() + 20000;
  while (!/Status: running/.test(last) && Date.now() < deadline) { last = await status(); await new Promise(r => setTimeout(r, 200)); }
  assert.match(last, /Status: running/, agent.output());
  assert.equal(agent.child.exitCode, null, agent.output());
});

test('autostart supervisor restarts crashed agents but not stopped, displaced or duplicate ones', async t => {
  const root = await mkdtemp(join(tmpdir(), 'localmcp-supervise-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = async (sequence: string) => {
    const name = sequence.replaceAll(',', '-');
    const counter = join(root, `${name}.count`);
    const logFile = join(root, `${name}.log`);
    const code = await superviseAgent({
      nodePath: process.execPath,
      agentPath: resolve('test/fixtures/exit-sequence.mjs'),
      logFile,
      env: { ...process.env, LOCALMCP_EXIT_SEQUENCE: sequence, LOCALMCP_EXIT_COUNTER: counter },
      minDelayMs: 10,
      maxDelayMs: 40,
    });
    return { code, runs: Number(await readFile(counter, 'utf8')), log: await readFile(logFile, 'utf8') };
  };
  const crashed = await run(`1,1,${EXIT_DISPLACED}`);
  assert.equal(crashed.code, EXIT_DISPLACED);
  assert.equal(crashed.runs, 3);
  assert.match(crashed.log, /exited with code 1; restarting/);
  assert.match(crashed.log, /fixture run 3/);
  for (const code of [0, EXIT_ALREADY_RUNNING]) {
    const once = await run(String(code));
    assert.equal(once.code, code);
    assert.equal(once.runs, 1);
  }
});

test('update builds a tarball from a clone and refuses a checkout of another package', async () => {
  const { updateFromGitHub } = await import('../src/update.js');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const fakeRun = (name: string) => async (command: string, args: string[], cwd?: string) => {
    calls.push({ command, args, cwd });
    if (command === 'git') {
      const target = args.at(-1)!;
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({ name, version: '9.9.9' }));
    }
    if (args[0] === 'pack') await writeFile(join(args.at(-1)!, 'pkg-9.9.9.tgz'), '');
  };
  const installed = await updateFromGitHub({ ref: 'v9.9.9', expectedName: '@ddd0s/localmcp', run: fakeRun('@ddd0s/localmcp'), log: () => {} });
  assert.deepEqual(installed, { name: '@ddd0s/localmcp', version: '9.9.9' });
  assert.deepEqual(calls.map(call => [call.command, call.args[0]]), [['git', 'clone'], ['npm', 'ci'], ['npm', 'pack'], ['npm', 'install']]);
  assert.ok(calls[0].args.includes('v9.9.9'));
  assert.ok(calls[1].args.includes('--ignore-scripts'));
  assert.match(calls[3].args.at(-1)!, /pkg-9\.9\.9\.tgz$/);
  assert.equal(existsSync(dirname(calls[3].args.at(-1)!)), false, 'the temporary checkout is removed');
  calls.length = 0;
  await assert.rejects(updateFromGitHub({ ref: 'main', expectedName: '@ddd0s/localmcp', run: fakeRun('@daodao97/localmcp'), log: () => {} }), /contains @daodao97\/localmcp, not @ddd0s\/localmcp/);
  assert.deepEqual(calls.map(call => call.command), ['git'], 'nothing is installed from an upstream checkout');
});
