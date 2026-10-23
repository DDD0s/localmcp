const PATH_TOKEN = /\/[a-f0-9]{64}(?=\/|[?#]|$)/gi;
const SECRET = /[a-f0-9]{64}/gi;

/** Hide the credential segment of an MCP URL. The origin and device id stay visible. */
export function redactMcpUrl(url: string | null | undefined): string {
  if (!url) return '-';
  return url.replace(PATH_TOKEN, '/<redacted>');
}

/** Strip 64-hex credentials from free-text log lines and relay error bodies. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET, '<redacted>');
}
