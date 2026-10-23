import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { extractArchive } from '../src/archive.js';
import { redactMcpUrl, redactSecrets } from '../src/redact.js';
import { printStatus, type Status } from '../src/lifecycle.js';
import { archiveUrlForTag, parseChecksums, updateFromGitHub, type Runner } from '../src/update.js';
import { MCP_DEVICE_LIMIT, MCP_IP_LIMIT, REGISTER_LIMIT, allowInWindow, clientKey, type WindowState } from '../worker/rate-limit.js';
import worker from '../worker/index.js';

const exec = promisify(execFile);
const COMMIT = 'a'.repeat(40);
const TAG_OBJECT = 'b'.repeat(40);

test('MCP URLs redact the token unless show-url is requested', () => {
  const token = 'ab'.repeat(32);
  const device = '11111111-1111-4111-8111-111111111111';
  const url = `https://mcp.example.com/mcp/${device}/${token}`;
  assert.equal(redactMcpUrl(url), `https://mcp.example.com/mcp/${device}/<redacted>`);
  assert.equal(redactMcpUrl(`http://127.0.0.1:9/mcp/${token}?x=1`), 'http://127.0.0.1:9/mcp/<redacted>?x=1');
  assert.equal(redactMcpUrl(null), '-');
  assert.equal(redactSecrets(`token ${token} stays out of logs`), 'token <redacted> stays out of logs');
  const logs: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => { logs.push(String(line)); };
  const status: Status = { status: 'running', pid: 7, url, config: 'cfg', log: 'log', ready: true };
  try {
    printStatus(status);
    printStatus(status, { showUrl: true });
  } finally { console.log = original; }
  assert.equal(logs[0].includes(token), false);
  assert.match(logs[0], /MCP URL: https:\/\/mcp\.example\.com\/mcp\/11111111-1111-4111-8111-111111111111\/<redacted>/);
  assert.match(logs[0], /localmcp status --show-url/);
  assert.ok(logs[1].includes(url));
});

test('archive extraction strips a GitHub root and rejects escapes', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'localmcp-archive-'));
  try {
    await extractArchive(gzipSync(tar([
      { name: 'localmcp-9.9.9/package.json', data: Buffer.from('{"name":"ok"}') },
      { name: 'localmcp-9.9.9/src/app.txt', data: Buffer.from('hello') },
    ])), dest);
    assert.equal(await readFile(join(dest, 'package.json'), 'utf8'), '{"name":"ok"}');
    assert.equal(await readFile(join(dest, 'src/app.txt'), 'utf8'), 'hello');
    const mode = (await stat(join(dest, 'package.json'))).mode & 0o777;
    assert.equal(mode, 0o644);
  } finally { await rm(dest, { recursive: true, force: true }); }

  const paxDest = await mkdtemp(join(tmpdir(), 'localmcp-pax-'));
  try {
    const body = Buffer.from(paxRecord('path', 'pkg/nested/hello.txt'));
    await extractArchive(tar([
      { name: './PaxHeaders.0/hello.txt', data: body, type: 'x' },
      { name: 'hello.txt', data: Buffer.from('hi') },
    ]), paxDest);
    assert.equal(await readFile(join(paxDest, 'nested/hello.txt'), 'utf8'), 'hi');
  } finally { await rm(paxDest, { recursive: true, force: true }); }

  const outside = join(tmpdir(), `localmcp-escaped-${Date.now()}`);
  await assert.rejects(extractArchive(tar([{ name: 'pkg/../../outside.txt', data: Buffer.from('nope') }]), await mkdtemp(join(tmpdir(), 'localmcp-reject-'))), /escapes/);
  assert.equal(existsSync(outside), false);
  await assert.rejects(extractArchive(tar([{ name: '/etc/passwd', data: Buffer.from('x') }]), await mkdtemp(join(tmpdir(), 'localmcp-abs-'))), /escapes/);
  await assert.rejects(extractArchive(tar([{ name: 'link', data: Buffer.alloc(0), type: '2' }]), await mkdtemp(join(tmpdir(), 'localmcp-link-'))), /link/);
  await assert.rejects(extractArchive(tar([{ name: 'big.txt', data: Buffer.alloc(32) }]), await mkdtemp(join(tmpdir(), 'localmcp-big-')), { maxFileBytes: 8 }), /size limit/);
});

test('git archive of this repo extracts package.json', async () => {
  const { stdout } = await exec('git', ['archive', '--format=tar', 'HEAD'], { encoding: 'buffer', maxBuffer: 40 * 1024 * 1024 });
  const dest = await mkdtemp(join(tmpdir(), 'localmcp-git-archive-'));
  try {
    await extractArchive(stdout as Buffer, dest);
    const manifest = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')) as { name: string };
    assert.equal(manifest.name, '@ddd0s/localmcp');
  } finally { await rm(dest, { recursive: true, force: true }); }
});

test('update installs only a checksum-verified release and keeps npm ci --ignore-scripts', async () => {
  const commit = COMMIT;
  const archive = gzipSync(tar([{ name: 'localmcp-9.9.9/package.json', data: Buffer.from(JSON.stringify({ name: '@ddd0s/localmcp', version: '9.9.9' })) }]));
  const digest = createHash('sha256').update(archive).digest('hex');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const run: Runner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (args[0] === 'pack' && cwd) {
      const destination = args.at(-1)!;
      await import('node:fs/promises').then(fs => fs.writeFile(join(destination, 'pkg-9.9.9.tgz'), ''));
    }
  };
  const fetchImpl = githubFetch({ tag: 'v9.9.9', commit, archive, digest });
  const installed = await updateFromGitHub({ ref: 'v9.9.9', expectedName: '@ddd0s/localmcp', fetchImpl, run, log: () => {} });
  assert.deepEqual(installed, { name: '@ddd0s/localmcp', version: '9.9.9', tag: 'v9.9.9', commit });
  assert.deepEqual(calls.map(call => [call.command, call.args[0]]), [['npm', 'ci'], ['npm', 'pack'], ['npm', 'install']]);
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.equal(calls.some(call => call.command === 'git'), false);
  assert.match(calls[2].args.at(-1)!, /pkg-9\.9\.9\.tgz$/);
  assert.equal(existsSync(calls[0].cwd!), false, 'the temporary checkout is removed');

  calls.length = 0;
  await assert.rejects(updateFromGitHub({
    ref: 'v9.9.9',
    expectedName: '@ddd0s/localmcp',
    fetchImpl: githubFetch({ tag: 'v9.9.9', commit, archive, digest: 'f'.repeat(64) }),
    run,
    log: () => {},
  }), /checksum does not match/);
  assert.equal(calls.length, 0);

  await assert.rejects(updateFromGitHub({
    ref: 'v9.9.9',
    expectedName: '@ddd0s/localmcp',
    fetchImpl: githubFetch({ tag: 'v9.9.9', commit, archive, digest, checksumCommit: 'c'.repeat(40) }),
    run,
    log: () => {},
  }), /SHA256SUMS says/);

  const wrong = gzipSync(tar([{ name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: '@daodao97/localmcp', version: '9.9.9' })) }]));
  await assert.rejects(updateFromGitHub({
    ref: 'v9.9.9',
    expectedName: '@ddd0s/localmcp',
    fetchImpl: githubFetch({ tag: 'v9.9.9', commit, archive: wrong, digest: createHash('sha256').update(wrong).digest('hex') }),
    run: async () => { throw new Error('ran'); },
    log: () => {},
  }), /contains @daodao97\/localmcp/);

  let source: string | undefined;
  await assert.rejects(updateFromGitHub({
    ref: 'v9.9.9',
    expectedName: '@ddd0s/localmcp',
    fetchImpl,
    run: async (_command, _args, cwd) => { source = cwd; throw new Error('ci failed'); },
    log: () => {},
  }), /ci failed/);
  assert.ok(source);
  assert.equal(existsSync(source), false);

  const latest = await updateFromGitHub({ expectedName: '@ddd0s/localmcp', fetchImpl, run, log: () => {} });
  assert.equal(latest.tag, 'v9.9.9');
  const pinned = await updateFromGitHub({ ref: commit, expectedName: '@ddd0s/localmcp', fetchImpl, run, log: () => {} });
  assert.equal(pinned.commit, commit);
  await assert.rejects(updateFromGitHub({
    ref: 'd'.repeat(40),
    expectedName: '@ddd0s/localmcp',
    fetchImpl,
    run: async () => { throw new Error('ran'); },
    log: () => {},
  }), /not the commit of a published GitHub Release/);
  await assert.rejects(updateFromGitHub({ ref: 'feature', expectedName: '@ddd0s/localmcp', fetchImpl, run, log: () => {} }), /release tag/);
});

test('checksum file must name the archive and the commit', () => {
  const parsed = parseChecksums(`# comment\n${'ab'.repeat(32)}  source.tar.gz\ncommit ${COMMIT}\n`);
  assert.equal(parsed.commit, COMMIT);
  assert.equal(parsed.archiveSha256, 'ab'.repeat(32));
  assert.throws(() => parseChecksums(`${'ab'.repeat(32)}  source.tar.gz\n`), /commit/);
  assert.throws(() => parseChecksums('hello\n'), /Unrecognized/);
  assert.equal(archiveUrlForTag('DDD0s/localmcp', 'v0.4.1'), 'https://github.com/DDD0s/localmcp/archive/refs/tags/v0.4.1.tar.gz');
});

test('relay rate limits use the wrangler binding values', async () => {
  const windows = new Map<string, WindowState>();
  for (let i = 0; i < REGISTER_LIMIT.limit; i++) assert.equal(allowInWindow(windows, 'ip', REGISTER_LIMIT.limit, REGISTER_LIMIT.periodSeconds * 1000, 1_000), true);
  assert.equal(allowInWindow(windows, 'ip', REGISTER_LIMIT.limit, REGISTER_LIMIT.periodSeconds * 1000, 1_000), false);
  assert.equal(allowInWindow(windows, 'ip', REGISTER_LIMIT.limit, REGISTER_LIMIT.periodSeconds * 1000, 1_000 + REGISTER_LIMIT.periodSeconds * 1000), true);
  assert.equal(clientKey(null), 'unknown');
  assert.equal(clientKey('not an ip'), 'unknown');
  assert.equal(clientKey('203.0.113.50'), '203_0_113_50');
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8').then(text => text.replace(/^\s*\/\/.*$/gm, ''))) as { ratelimits: Array<{ name: string; simple: { limit: number; period: number } }> };
  const byName = Object.fromEntries(config.ratelimits.map(item => [item.name, item.simple]));
  assert.deepEqual(byName.REGISTER_RATE_LIMITER, { limit: REGISTER_LIMIT.limit, period: REGISTER_LIMIT.periodSeconds });
  assert.deepEqual(byName.MCP_RATE_LIMITER, { limit: MCP_DEVICE_LIMIT.limit, period: MCP_DEVICE_LIMIT.periodSeconds });
  assert.deepEqual(byName.MCP_IP_RATE_LIMITER, { limit: MCP_IP_LIMIT.limit, period: MCP_IP_LIMIT.periodSeconds });
});

test('worker registration stays protocol 2 and rate limits before waking a Durable Object', async () => {
  const calls = { n: 0 };
  const env = {
    RELAY: {
      idFromName: () => 'id',
      get: () => ({ fetch: async () => { calls.n += 1; return Response.json({ ok: true }); } }),
    },
  };
  const health = await worker.fetch(new Request('https://relay.test/healthz'), env as never);
  const healthBody = await health.json() as { ok: boolean; protocol: number; registration: boolean; rateLimit: boolean };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.protocol, 2);
  assert.equal(healthBody.registration, true);
  assert.equal(healthBody.rateLimit, true);

  const ip = '198.51.100.20';
  const first = await register(env, ip);
  assert.equal(first.status, 201);
  const body = await first.json() as { protocol: number; mcpUrl: string; deviceId: string; agentToken: string; mcpToken: string };
  assert.equal(body.protocol, 2);
  assert.match(body.mcpUrl, new RegExp(`/mcp/${body.deviceId}/${body.mcpToken}$`));
  const again = await register(env, ip, { deviceId: body.deviceId, agentToken: body.agentToken, mcpToken: body.mcpToken });
  assert.equal(again.status, 201);
  assert.equal((await again.json() as { mcpUrl: string }).mcpUrl, body.mcpUrl);

  const blockedEnv = { ...env, REGISTER_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const before = calls.n;
  const blocked = await register(blockedEnv, '198.51.100.21');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal((await blocked.json() as { code: string }).code, 'rate_limited');
  assert.equal(calls.n, before);

  const device = '22222222-2222-4222-8222-222222222222';
  const token = 'c'.repeat(64);
  const mcpEnv = { ...env, MCP_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const limitedMcp = await worker.fetch(new Request(`https://relay.test/mcp/${device}/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), mcpEnv as never);
  assert.equal(limitedMcp.status, 429);
  assert.equal(calls.n, before);
  const allowed = await worker.fetch(new Request(`https://relay.test/mcp/${device}/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.40' }, body: '{}' }), env as never);
  assert.equal(allowed.status, 200);

  const origin = await worker.fetch(new Request('https://relay.test/register', { method: 'POST', headers: { Origin: 'https://evil.example', 'CF-Connecting-IP': '198.51.100.77' }, body: '{}' }), env as never);
  assert.equal(origin.status, 403);
  for (let i = 0; i < REGISTER_LIMIT.limit; i++) assert.equal((await register(env, '198.51.100.77')).status, 201);
  assert.equal((await register(env, '198.51.100.77')).status, 429);
});

function register(env: object, ip: string, body: object = {}) {
  return worker.fetch(new Request('https://relay.test/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  }), env as never);
}

function githubFetch(options: { tag: string; commit: string; archive: Buffer; digest: string; checksumCommit?: string }) {
  const repo = 'DDD0s/localmcp';
  const checksum = `${options.digest}  source.tar.gz\ncommit ${options.checksumCommit ?? options.commit}\n`;
  const release = {
    tag_name: options.tag,
    draft: false,
    assets: [{ name: 'SHA256SUMS', browser_download_url: `https://github.com/${repo}/releases/download/${options.tag}/SHA256SUMS` }],
  };
  const routes = new Map<string, () => Response>([
    [`https://api.github.com/repos/${repo}/releases/tags/${options.tag}`, () => Response.json(release)],
    [`https://api.github.com/repos/${repo}/releases/latest`, () => Response.json(release)],
    [`https://api.github.com/repos/${repo}/releases?per_page=100&page=1`, () => Response.json([release])],
    [`https://api.github.com/repos/${repo}/git/ref/tags/${options.tag}`, () => Response.json({ object: { type: 'tag', sha: TAG_OBJECT } })],
    [`https://api.github.com/repos/${repo}/git/tags/${TAG_OBJECT}`, () => Response.json({ object: { type: 'commit', sha: options.commit } })],
    [`https://github.com/${repo}/releases/download/${options.tag}/SHA256SUMS`, () => new Response(checksum)],
    [archiveUrlForTag(repo, options.tag), () => new Response(options.archive)],
  ]);
  const fetchImpl: typeof fetch = async input => {
    const url = String(input);
    const handler = routes.get(url);
    if (!handler) return new Response('missing', { status: 404 });
    return handler();
  };
  return fetchImpl;
}

function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let length = suffix.length;
  for (;;) {
    const total = String(length).length + suffix.length;
    if (total === length) return `${length}${suffix}`;
    length = total;
  }
}

function tar(entries: Array<{ name: string; data: Buffer; type?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) parts.push(header(entry.name, entry.data.length, entry.type ?? '0'), pad(entry.data));
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, Math.min(name.length, 100), 'utf8');
  block.write('0000644\0', 100, 8, 'utf8');
  block.write('0000000\0', 108, 8, 'utf8');
  block.write('0000000\0', 116, 8, 'utf8');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  block.write('00000000000\0', 136, 12, 'utf8');
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  block.write('ustar\0', 257, 6, 'utf8');
  block.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return block;
}

function pad(data: Buffer): Buffer {
  const extra = (512 - (data.length % 512)) % 512;
  return extra ? Buffer.concat([data, Buffer.alloc(extra)]) : data;
}
