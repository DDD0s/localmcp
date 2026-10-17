import { Assembly, buildFrames, gunzipJson, parseFrame, type Assembled } from '../src/relay-protocol';
import { resolvePublicBase } from '../src/public-url';

interface Env { RELAY: DurableObjectNamespace; MCP_TOKEN_HASH?: string; AGENT_TOKEN_HASH?: string; PUBLIC_BASE_URL?: string }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
async function authorized(token: string, expected?: string) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || token.length > 256) return false;
  const hash = await sha256(token);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function randomHex(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
}
async function bodyText(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
function relay(env: Env, deviceId: string) { return env.RELAY.get(env.RELAY.idFromName(deviceId)); }
function publicBase(request: Request, env: Env) {
  try { return resolvePublicBase(new URL(request.url).origin, env.PUBLIC_BASE_URL); }
  catch { return new URL(request.url).origin; }
}
function agentHeaders(request: Request, extra: Record<string, string>) {
  const headers = new Headers({ Upgrade: 'websocket', ...extra });
  for (const name of ['x-localmcp-takeover', 'x-localmcp-chunk', 'x-localmcp-compress']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
const TOKEN = /^[a-f0-9]{64}$/;
const DEVICE = /^[0-9a-f-]{36}$/;

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') {
    return json({ ok: true, service: 'localmcp-relay', registration: true, stableRegistration: true, protocol: 2, chunkSize: 120000, compress: true, publicBaseUrl: publicBase(request, env), edition: 'enhanced' });
  }
  if (request.headers.has('Origin')) return json({ error: 'Origin not allowed' }, 403);
  if (url.pathname === '/register' && request.method === 'POST') {
    let body: { deviceId?: unknown; agentToken?: unknown; mcpToken?: unknown } = {};
    try { body = JSON.parse(await bodyText(request, 4096) || '{}'); }
    catch { return json({ error: 'Invalid JSON' }, 400); }
    const deviceId = typeof body.deviceId === 'string' && DEVICE.test(body.deviceId) ? body.deviceId : undefined;
    const agentToken = typeof body.agentToken === 'string' && TOKEN.test(body.agentToken) ? body.agentToken : undefined;
    const mcpToken = typeof body.mcpToken === 'string' && TOKEN.test(body.mcpToken) ? body.mcpToken : undefined;
    const stable = Boolean(deviceId && agentToken && mcpToken);
    const assignedDevice = deviceId || crypto.randomUUID();
    const assignedAgent = agentToken || randomHex();
    const assignedMcp = mcpToken || randomHex();
    const registered = await relay(env, assignedDevice).fetch(new Request('https://relay.internal/register', {
      method: 'POST',
      headers: { 'x-agent-hash': await sha256(assignedAgent), 'x-mcp-hash': await sha256(assignedMcp), 'x-rebind': stable ? '1' : '0' },
    }));
    if (registered.status === 409) return json({ error: 'Device already registered with different credentials', code: 'device_conflict', hint: 'These credentials do not match the device. Keep the saved ~/.localmcp/identity.json or choose a new device.' }, 409);
    if (!registered.ok) return json({ error: 'Registration failed' }, 500);
    const base = publicBase(request, env);
    return json({ deviceId: assignedDevice, agentToken: assignedAgent, mcpToken: assignedMcp, workerUrl: url.origin, publicBaseUrl: base, mcpUrl: `${base}/mcp/${assignedDevice}/${assignedMcp}`, protocol: 2 }, 201);
  }
  const agentMatch = /^\/agent\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (agentMatch) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
    return relay(env, agentMatch[1]).fetch(new Request('https://relay.internal/agent', { headers: agentHeaders(request, { 'x-localmcp-agent-token': token }) }));
  }
  const mcpMatch = /^\/mcp\/([0-9a-f-]{36})\/([a-f0-9]{64})$/.exec(url.pathname);
  if (mcpMatch) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) return json({ error: 'JSON required' }, 415);
    let body: string;
    try { body = await bodyText(request, 2 * 1024 * 1024); JSON.parse(body); }
    catch { return json({ error: 'Invalid JSON or body exceeds 2 MiB' }, 400); }
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-localmcp-mcp-token': mcpMatch[2] });
    const version = request.headers.get('MCP-Protocol-Version');
    if (version) headers.set('MCP-Protocol-Version', version);
    return relay(env, mcpMatch[1]).fetch(new Request('https://relay.internal/mcp', { method: 'POST', headers, body }));
  }
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (url.pathname === '/agent') {
    if (!await authorized(bearer, env.AGENT_TOKEN_HASH)) return new Response(null, { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    return relay(env, 'local').fetch(new Request('https://relay.internal/agent', { headers: agentHeaders(request, { 'x-localmcp-legacy': '1' }) }));
  }
  const legacy = /^\/mcp(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
  if (!legacy || !await authorized(legacy[1] || bearer, env.MCP_TOKEN_HASH)) return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let legacyBody: string;
  try { legacyBody = await bodyText(request, 2 * 1024 * 1024); JSON.parse(legacyBody); }
  catch { return json({ error: 'Invalid JSON or body exceeds 2 MiB' }, 400); }
  const legacyHeaders = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-localmcp-legacy': '1' });
  const legacyVersion = request.headers.get('MCP-Protocol-Version');
  if (legacyVersion) legacyHeaders.set('MCP-Protocol-Version', legacyVersion);
  return relay(env, 'local').fetch(new Request('https://relay.internal/mcp', { method: 'POST', headers: legacyHeaders, body: legacyBody }));
} };

interface Pending { socket: WebSocket; assembly: Assembly; resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout> }
interface SocketCaps { chunkSize: number; compress: boolean }
const busyBody = { error: 'An agent is already connected for this device.', code: 'agent_already_connected', hint: 'Another live session holds these credentials. Stop that localmcp process first. After a crash or reboot, start localmcp again; the enhanced agent reclaims a stale session. A second client without session takeover is rejected.' };

export class McpRelay {
  private pending = new Map<string, Pending>();
  constructor(private ctx: DurableObjectState) { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/register') return this.register(request);
    const legacy = request.headers.get('x-localmcp-legacy') === '1';
    if (url.pathname === '/agent') return this.acceptAgent(request, legacy);
    if (!legacy) {
      const expected = await this.ctx.storage.get<string>('mcpHash');
      if (!await authorized(request.headers.get('x-localmcp-mcp-token') || '', expected)) return new Response(null, { status: 404 });
    }
    const socket = this.ctx.getWebSockets('agent')[0];
    if (!socket) return json({ error: 'Local agent offline. Start localmcp.' }, 503);
    if (this.pending.size) return json({ error: 'Local agent busy. Do not automatically retry write operations.' }, 429);
    const caps = socketCaps(socket);
    const id = crypto.randomUUID();
    const body = await request.text();
    return new Promise<Response>(resolve => {
      const timer = setTimeout(() => this.finish(id, json({ error: 'Local execution timed out; outcome may be unknown.' }, 504)), 130000);
      this.pending.set(id, { socket, assembly: new Assembly(), resolve, timer });
      void buildFrames(id, { body, protocolVersion: request.headers.get('MCP-Protocol-Version') }, caps).then(frames => {
        try { for (const frame of frames) socket.send(frame); }
        catch { this.finish(id, json({ error: 'Agent connection lost; outcome may be unknown.' }, 502)); }
      }).catch(() => this.finish(id, json({ error: 'Agent connection lost; outcome may be unknown.' }, 502)));
    });
  }

  private async register(request: Request): Promise<Response> {
    const agentHash = request.headers.get('x-agent-hash');
    const mcpHash = request.headers.get('x-mcp-hash');
    if (!agentHash || !mcpHash || !/^[a-f0-9]{64}$/.test(agentHash) || !/^[a-f0-9]{64}$/.test(mcpHash)) return json({ error: 'Invalid registration' }, 400);
    const existingAgent = await this.ctx.storage.get<string>('agentHash');
    const existingMcp = await this.ctx.storage.get<string>('mcpHash');
    if (existingAgent && existingMcp && (existingAgent !== agentHash || existingMcp !== mcpHash)) {
      return json({ error: 'Device already registered with different credentials', code: 'device_conflict' }, 409);
    }
    await this.ctx.storage.put({ agentHash, mcpHash });
    return json({ ok: true, rebound: Boolean(existingAgent) });
  }

  private async acceptAgent(request: Request, legacy: boolean): Promise<Response> {
    if (!legacy) {
      const expected = await this.ctx.storage.get<string>('agentHash');
      if (!await authorized(request.headers.get('x-localmcp-agent-token') || '', expected)) return new Response(null, { status: 404 });
    }
    const existing = this.ctx.getWebSockets('agent');
    const takeover = request.headers.get('x-localmcp-takeover') === '1';
    if (existing.length && !takeover) return json(busyBody, 409);
    if (existing.length && takeover) {
      for (const socket of existing) {
        this.failSocket(socket);
        try { socket.close(4000, 'Reclaimed by authenticated agent'); } catch { /* already closed */ }
      }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['agent']);
    pair[1].serializeAttachment(socketCapsFrom(request));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private finish(id: string, response: Response) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) { void this.consume(socket, message); }

  private async consume(socket: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') throw new Error('Text frames required');
      if (message === 'ping' || message === 'pong') return;
      const frame = parseFrame(message);
      const pending = this.pending.get(frame.id);
      if (!pending || pending.socket !== socket) return;
      const complete = pending.assembly.push(frame);
      if (!complete) return;
      const value = await unpack(complete);
      const data = value as { status: number; body: string };
      if (!data || !Number.isInteger(data.status) || typeof data.body !== 'string') throw new Error('Invalid agent response');
      if (![202, 204, 205, 304].includes(data.status)) JSON.parse(data.body);
      this.finish(frame.id, new Response([204, 205, 304].includes(data.status) ? null : data.body, { status: data.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    } catch {
      try { socket.close(1008, 'Invalid relay response'); } catch { /* already closed */ }
      this.failSocket(socket);
    }
  }

  private failSocket(socket: WebSocket) {
    for (const [id, pending] of this.pending) if (pending.socket === socket) this.finish(id, json({ error: 'Local agent disconnected; execution outcome may be unknown.' }, 502));
  }

  webSocketClose(socket: WebSocket) { this.failSocket(socket); try { socket.close(1000, 'Closed'); } catch { /* already closed */ } }
  webSocketError(socket: WebSocket) { this.failSocket(socket); try { socket.close(1011, 'Connection failed'); } catch { /* already closed */ } }
}

async function unpack(complete: Assembled): Promise<unknown> {
  if ('gzip' in complete) return gunzipJson(complete.gzip);
  return complete.value;
}

function socketCaps(socket: WebSocket): { chunkSize: number; compress: boolean } {
  const raw = socket.deserializeAttachment() as { chunkSize?: number; compress?: boolean } | null;
  const chunkSize = raw && Number.isInteger(raw.chunkSize) && (raw.chunkSize as number) >= 24000 && (raw.chunkSize as number) <= 120000 ? raw.chunkSize as number : 24000;
  return { chunkSize, compress: Boolean(raw?.compress) };
}

function socketCapsFrom(request: Request): SocketCaps {
  const parsed = Number(request.headers.get('x-localmcp-chunk'));
  const chunkSize = Number.isInteger(parsed) && parsed >= 24000 && parsed <= 120000 ? parsed : 24000;
  return { chunkSize, compress: request.headers.get('x-localmcp-compress') === '1' };
}
