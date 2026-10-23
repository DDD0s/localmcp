export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface WindowState { start: number; count: number }

export interface LimitPolicy { limit: number; periodSeconds: 10 | 60 }

/**
 * Defaults for the relay. Keep these equal to the `ratelimits` entries in wrangler.jsonc.
 * POST /register is rare (first start and rebind). POST /mcp allows a short ChatGPT burst:
 * interactive use is a handful of tool calls, not hundreds in ten seconds.
 */
export const REGISTER_LIMIT: LimitPolicy = { limit: 20, periodSeconds: 60 };
export const MCP_DEVICE_LIMIT: LimitPolicy = { limit: 200, periodSeconds: 10 };
export const MCP_IP_LIMIT: LimitPolicy = { limit: 200, periodSeconds: 10 };

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;
const MAPPED = /^::ffff:(?:\d{1,3}\.){3}\d{1,3}$/i;

/** Normalize a rate-limit key to a short stable token. Empty and non-IP values share `unknown`. */
export function bindingKey(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 64);
  return cleaned || 'unknown';
}

/** Cloudflare sets CF-Connecting-IP and overwrites client-supplied values. */
export function clientKey(header: string | null): string {
  const value = header?.trim() ?? '';
  if (IPV4.test(value) || IPV6.test(value) || MAPPED.test(value)) return bindingKey(value);
  return 'unknown';
}

export function allowInWindow(windows: Map<string, WindowState>, key: string, limit: number, periodMs: number, now = Date.now()): boolean {
  const current = windows.get(key);
  if (!current || now - current.start >= periodMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 2000) {
      for (const [name, state] of windows) if (now - state.start >= 60_000) windows.delete(name);
    }
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

/**
 * Prefer the Workers Rate Limiting binding. If it is missing or throws, enforce the same
 * numbers in this isolate so a deploy without the binding is not unlimited.
 */
export async function allowRateLimit(limiter: RateLimiter | undefined, windows: Map<string, WindowState>, memoryKey: string, key: string, policy: LimitPolicy, now = Date.now()): Promise<boolean> {
  if (limiter) {
    try { return (await limiter.limit({ key })).success; }
    catch { /* binding unavailable */ }
  }
  return allowInWindow(windows, memoryKey, policy.limit, policy.periodSeconds * 1000, now);
}
