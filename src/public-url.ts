const LOCAL_HTTP = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Origin used in the ChatGPT connector URL. `configured` wins over the request/worker origin. */
export function resolvePublicBase(fallbackOrigin: string, configured?: string): string {
  const raw = (configured && configured.trim()) || fallbackOrigin;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`Invalid public URL: ${raw}`); }
  const httpAllowed = url.protocol === 'http:' && LOCAL_HTTP.has(url.hostname);
  if (url.protocol !== 'https:' && !httpAllowed) throw new Error('Public URL must use HTTPS (http is only allowed for localhost)');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Public URL must be an origin without a path, query, or credentials');
  }
  return url.origin;
}
