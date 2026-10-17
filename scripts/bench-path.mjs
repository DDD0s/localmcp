import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFrames, frames } from '../dist/relay-protocol.js';
import { startLocalRuntime } from '../dist/runtime.js';

const repetitive = { output: 'error line\n'.repeat(20000) };
const plain = frames('bench', repetitive);
const packed = await buildFrames('bench', repetitive, { chunkSize: 120000, compress: true });
const plainBytes = plain.reduce((sum, frame) => sum + frame.length, 0);
const packedBytes = packed.reduce((sum, frame) => sum + frame.length, 0);
console.log(JSON.stringify({
  plainFrames: plain.length,
  plainBytes,
  negotiatedFrames: packed.length,
  negotiatedBytes: packedBytes,
  byteRatio: Number((packedBytes / plainBytes).toFixed(4)),
}));

const root = await mkdtemp(join(tmpdir(), 'localmcp-bench-'));
process.env.LOCALMCP_CONFIG = '/nonexistent/localmcp-bench.json';
process.env.LOCALMCP_ROOT = root;
process.env.LOCALMCP_SHELL = '0';
const runtime = await startLocalRuntime();
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
await runtime.handle(body);
const calls = 30;
const started = performance.now();
for (let i = 0; i < calls; i++) await runtime.handle(body.replace('"id":1', `"id":${i + 2}`));
const elapsed = performance.now() - started;
console.log(JSON.stringify({ inProcessCalls: calls, totalMs: Number(elapsed.toFixed(2)), perCallMs: Number((elapsed / calls).toFixed(2)) }));
const memory = process.memoryUsage();
console.log(JSON.stringify({ rssMb: Number((memory.rss / 1048576).toFixed(1)), heapMb: Number((memory.heapUsed / 1048576).toFixed(1)) }));
await runtime.close();

if (process.argv.includes('--http')) {
  const token = 'a'.repeat(64);
  const port = 22000 + Math.floor(Math.random() * 10000);
  const boot = performance.now();
  const child = spawn(process.execPath, [resolve('dist/index.js'), 'http'], {
    env: { ...process.env, LOCALMCP_PORT: String(port), LOCALMCP_TOKEN: token, LOCALMCP_INTERNAL: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  console.log(JSON.stringify({ httpChildReadyMs: Number((performance.now() - boot).toFixed(1)) }));
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` };
  await fetch(`${base}/mcp`, { method: 'POST', headers, body });
  const httpStarted = performance.now();
  for (let i = 0; i < calls; i++) await (await fetch(`${base}/mcp`, { method: 'POST', headers, body: body.replace('"id":1', `"id":${i + 2}`) })).text();
  const httpElapsed = performance.now() - httpStarted;
  console.log(JSON.stringify({ httpCalls: calls, totalMs: Number(httpElapsed.toFixed(2)), perCallMs: Number((httpElapsed / calls).toFixed(2)) }));
  child.kill('SIGTERM');
}

await rm(root, { recursive: true, force: true });
