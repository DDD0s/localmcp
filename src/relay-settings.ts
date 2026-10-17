import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePublicBase } from './public-url.js';

export const DEFAULT_PUBLIC_WORKER_URL = 'https://localmcp-relay.daodao973597.workers.dev';
const TOKEN = /^[a-f0-9]{64}$/;
const DEVICE = /^[0-9a-f-]{36}$/;

export interface RelaySettings {
  workerUrl: string;
  publicBaseUrl?: string;
  agentToken: string;
  mcpToken: string;
  deviceId?: string;
}

export interface RelayCapabilities { protocol: number; chunkSize: number; compress: boolean }

interface Credentials { agentToken: string; mcpToken: string; deviceId?: string }

export function validateOrigin(value: string): string {
  return resolvePublicBase(value, value);
}

export function mcpUrl(settings: Pick<RelaySettings, 'workerUrl' | 'publicBaseUrl' | 'deviceId' | 'mcpToken'>): string {
  const base = settings.publicBaseUrl || settings.workerUrl;
  const path = settings.deviceId ? `/mcp/${settings.deviceId}/${settings.mcpToken}` : `/mcp/${settings.mcpToken}`;
  return new URL(path, base).href;
}

export function agentSocketUrl(workerUrl: string, deviceId?: string): URL {
  const url = new URL(deviceId ? `/agent/${deviceId}` : '/agent', workerUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export async function probeRelay(workerUrl: string, fetchImpl: typeof fetch = fetch): Promise<RelayCapabilities> {
  const fallback: RelayCapabilities = { protocol: 1, chunkSize: 24000, compress: false };
  try {
    const response = await fetchImpl(new URL('/healthz', workerUrl), { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return fallback;
    const body = await response.json() as { protocol?: number; chunkSize?: number; compress?: boolean };
    const protocol = body.protocol === 2 ? 2 : 1;
    const chunkSize = protocol === 2 && Number.isInteger(body.chunkSize) ? Math.min(120000, Math.max(24000, body.chunkSize as number)) : 24000;
    return { protocol, chunkSize, compress: protocol === 2 && body.compress === true };
  } catch { return fallback; }
}

export async function loadRelaySettings(stateDir: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<RelaySettings> {
  const saved = await readJson(resolve(stateDir, 'worker.json'));
  const identity = await readJson(resolve(stateDir, 'identity.json'));
  const savedCreds = saved ? credentials(saved, 'worker.json') : undefined;
  const identityCreds = identity ? credentials(identity, 'identity.json') : undefined;
  const creds = savedCreds || identityCreds;
  const workerUrl = validateOrigin(env.LOCALMCP_WORKER_URL || saved?.workerUrl || identity?.workerUrl || DEFAULT_PUBLIC_WORKER_URL);
  const requestedPublic = env.LOCALMCP_PUBLIC_URL || saved?.publicBaseUrl || identity?.publicBaseUrl;
  const publicBaseUrl = requestedPublic ? resolvePublicBase(workerUrl, requestedPublic) : undefined;
  const urlChanged = Boolean(saved?.workerUrl) && validateOrigin(saved.workerUrl) !== workerUrl;

  let next: RelaySettings;
  if (!creds) {
    const registered = await register(workerUrl, undefined, fetchImpl);
    next = { ...registered, workerUrl, publicBaseUrl: publicBaseUrl || differentPublic(workerUrl, registered.publicBaseUrl) };
  } else if (urlChanged && creds.deviceId) {
    const registered = await register(workerUrl, creds, fetchImpl);
    if (registered.deviceId !== creds.deviceId || registered.agentToken !== creds.agentToken || registered.mcpToken !== creds.mcpToken) {
      throw new Error('This relay issued new credentials instead of keeping the current MCP URL. Deploy the enhanced self-hosted relay for stable rebind. Saved credentials were left unchanged.');
    }
    next = { ...creds, workerUrl, publicBaseUrl: publicBaseUrl || differentPublic(workerUrl, registered.publicBaseUrl) };
  } else {
    // Restoring identity.json, or editing only the host of a legacy token, must not mint a new URL.
    next = { ...creds, workerUrl, publicBaseUrl };
  }
  await persistRelaySettings(stateDir, next);
  return next;
}

export async function configureRelay(stateDir: string, input: { workerUrl?: string; publicBaseUrl?: string | null }): Promise<RelaySettings | { workerUrl: string; publicBaseUrl?: string }> {
  const workerFile = resolve(stateDir, 'worker.json');
  const saved = await readJson(workerFile) || {};
  const workerUrl = validateOrigin(input.workerUrl || saved.workerUrl || DEFAULT_PUBLIC_WORKER_URL);
  let publicBaseUrl: string | undefined;
  if (input.publicBaseUrl === null) publicBaseUrl = undefined;
  else if (input.publicBaseUrl) publicBaseUrl = resolvePublicBase(workerUrl, input.publicBaseUrl);
  else if (saved.publicBaseUrl) publicBaseUrl = resolvePublicBase(workerUrl, saved.publicBaseUrl);
  const creds = saved.agentToken ? credentials(saved, 'worker.json') : undefined;
  const next = { ...(creds || {}), workerUrl, ...(publicBaseUrl ? { publicBaseUrl } : {}) };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(workerFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  if (creds) await writeFile(resolve(stateDir, 'identity.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Ask an enhanced relay to store the saved device again. Refuses a response that rotates the MCP URL. */
export async function rebindRelay(stateDir: string, fetchImpl: typeof fetch = fetch): Promise<RelaySettings> {
  const saved = await readJson(resolve(stateDir, 'worker.json'));
  const creds = saved ? credentials(saved, 'worker.json') : undefined;
  if (!creds?.deviceId || !saved?.workerUrl) throw new Error('No saved device identity to rebind. Run localmcp once to register.');
  const workerUrl = validateOrigin(saved.workerUrl);
  const registered = await register(workerUrl, creds, fetchImpl);
  if (registered.deviceId !== creds.deviceId || registered.agentToken !== creds.agentToken || registered.mcpToken !== creds.mcpToken) {
    throw new Error('This relay issued new credentials instead of keeping the current MCP URL. Saved credentials were left unchanged.');
  }
  const next: RelaySettings = { ...creds, workerUrl, publicBaseUrl: saved.publicBaseUrl ? resolvePublicBase(workerUrl, saved.publicBaseUrl) : differentPublic(workerUrl, registered.publicBaseUrl) };
  await persistRelaySettings(stateDir, next);
  return next;
}

export async function persistRelaySettings(stateDir: string, settings: RelaySettings): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(settings, null, 2);
  await writeFile(resolve(stateDir, 'worker.json'), body, { mode: 0o600 });
  await writeFile(resolve(stateDir, 'identity.json'), body, { mode: 0o600 });
}

async function register(workerUrl: string, existing: Credentials | undefined, fetchImpl: typeof fetch): Promise<RelaySettings> {
  const body = JSON.stringify(existing ? { deviceId: existing.deviceId, agentToken: existing.agentToken, mcpToken: existing.mcpToken } : {});
  let response: Response;
  try {
    response = await fetchImpl(new URL('/register', workerUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach relay at ${workerUrl}. If this machine uses a local proxy, set HTTP_PROXY or HTTPS_PROXY (for example http://127.0.0.1:7897). ${message}`);
  }
  const text = await response.text();
  let data: Partial<RelaySettings> & { error?: string; hint?: string; publicBaseUrl?: string } = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* keep the status error below */ }
  if (response.status === 409) throw new Error(data.hint || data.error || 'Relay refused to rebind this device (409)');
  if (!response.ok) throw new Error(`Relay registration failed (${response.status}). ${data.error || text.slice(0, 180) || 'Set LOCALMCP_WORKER_URL to a self-hosted relay if the public relay is unavailable.'}`);
  const creds = credentials(data, 'relay registration response');
  if (!creds) throw new Error('Relay registration response did not include credentials');
  return { ...creds, workerUrl, publicBaseUrl: data.publicBaseUrl };
}

function differentPublic(workerUrl: string, advertised?: string): string | undefined {
  if (!advertised) return undefined;
  try {
    const resolved = resolvePublicBase(workerUrl, advertised);
    return resolved === workerUrl ? undefined : resolved;
  } catch { return undefined; }
}

function credentials(value: Partial<RelaySettings> | undefined, label: string): Credentials | undefined {
  if (!value || (value.agentToken === undefined && value.mcpToken === undefined && value.deviceId === undefined)) return undefined;
  if (typeof value.agentToken !== 'string' || !TOKEN.test(value.agentToken) || typeof value.mcpToken !== 'string' || !TOKEN.test(value.mcpToken)) {
    throw new Error(`Saved relay credentials in ${label} are invalid. Restore the previous file or remove it to register again.`);
  }
  if (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !DEVICE.test(value.deviceId))) throw new Error(`deviceId in ${label} is invalid`);
  return { agentToken: value.agentToken, mcpToken: value.mcpToken, deviceId: value.deviceId };
}

async function readJson(path: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}`);
    throw error;
  }
}
