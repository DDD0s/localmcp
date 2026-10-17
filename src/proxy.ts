import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

export function getProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || undefined;
}

export function ensureLoopbackBypass(env: NodeJS.ProcessEnv = process.env): void {
  const current = env.NO_PROXY || env.no_proxy || '';
  const parts = current.split(',').map(entry => entry.trim()).filter(Boolean);
  for (const entry of LOOPBACK) if (!parts.some(item => item.toLowerCase() === entry)) parts.push(entry);
  const merged = parts.join(',');
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}

export function shouldBypassProxy(target: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (!noProxy) return false;
  if (noProxy.trim() === '*') return true;
  for (const entry of noProxy.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)) {
    const bare = entry.replace(/^\[|\]$/g, '');
    if (bare.startsWith('.')) {
      if (host.endsWith(bare) || host === bare.slice(1)) return true;
    } else if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** Route Node's global fetch through HTTP(S)_PROXY while keeping loopback direct. */
export function installProxyDispatcher(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const proxy = getProxyUrl(env);
  if (!proxy) return undefined;
  ensureLoopbackBypass(env);
  setGlobalDispatcher(new EnvHttpProxyAgent());
  return proxy;
}

export function createWebSocketProxyAgent(targetUrl: URL, env: NodeJS.ProcessEnv = process.env): http.Agent | https.Agent | undefined {
  const proxyValue = getProxyUrl(env);
  if (!proxyValue || shouldBypassProxy(targetUrl, env)) return undefined;
  const proxy = new URL(proxyValue.includes('://') ? proxyValue : `http://${proxyValue}`);
  const secure = targetUrl.protocol === 'https:' || targetUrl.protocol === 'wss:';
  const targetPort = targetUrl.port || (secure ? '443' : '80');
  const targetHost = targetUrl.hostname;
  const connect = (_options: unknown, callback: (error: Error | null, socket?: net.Socket) => void) => {
    const headers: Record<string, string> = { Host: `${targetHost}:${targetPort}` };
    if (proxy.username || proxy.password) {
      const creds = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
      headers['Proxy-Authorization'] = `Basic ${creds}`;
    }
    const proxyReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
    });
    proxyReq.setTimeout(15000, () => proxyReq.destroy(new Error(`Proxy connection to ${proxy.host} timed out`)));
    proxyReq.on('connect', (res, rawSocket) => {
      if (res.statusCode !== 200) {
        rawSocket.destroy();
        callback(new Error(`Proxy CONNECT failed with status ${res.statusCode}: ${res.statusMessage || 'no reason'}`));
        return;
      }
      if (!secure) { callback(null, rawSocket); return; }
      const tlsSocket = tls.connect({ socket: rawSocket, servername: targetHost }, () => callback(null, tlsSocket));
      tlsSocket.on('error', error => callback(error));
    });
    proxyReq.on('error', error => callback(new Error(`Failed to connect to proxy at ${proxy.host}: ${error.message}`)));
    proxyReq.end();
  };
  const agent = secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
  (agent as unknown as { createConnection: typeof connect }).createConnection = connect;
  return agent;
}
