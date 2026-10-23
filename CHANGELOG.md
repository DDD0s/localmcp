# Changelog

## 0.4.1

### Security

- Upgrade `@modelcontextprotocol/sdk` to 1.32.1 (above 1.31.0). That covers GHSA-6qxp-vccf-f47h, GHSA-22jm-h49p-29qw, and the other SDK advisories `npm audit` reported for 1.30.0. `npm audit fix` also moved the lockfile off vulnerable `proxy-addr` (2.0.8, GHSA-jqcg-44mw-7w3h), `hono` (4.13.13, GHSA-5r4p-p66f-jhc7), `ip-address` (10.7.4), and `fast-uri` (3.1.9). Wrangler 4.152.0 brings the relay toolchain (miniflare, sharp, and its nested undici) onto versions `npm audit` accepts. The worker has no separate lockfile; it is bundled from this repo.
- `localmcp status`, startup, health, and `localmcp relay` redact the MCP token. `localmcp status --show-url` (also `localmcp --show-url`, `localmcp health --show-url`, and `localmcp relay --show-url`) prints the full connector URL. Agent logs and relay error text strip 64-hex secrets.
- `localmcp update` no longer clones `main`. It installs the latest GitHub Release, or a release tag / the full commit that tag points at, and checks the release `SHA256SUMS` asset (tag-archive digest and commit) before `npm ci --ignore-scripts`.
- The relay rate-limits `POST /register` (20/minute per IP) and `POST /mcp` (200/10s per device and per IP) with Workers Rate Limiting bindings. `/healthz` and the agent WebSocket are not limited. Existing MCP URLs and protocol 2 registration responses are unchanged.

Shell execution stays on by default.

This release is not published to npm and the worker is not deployed from the change that introduced it. Publishing a GitHub Release with `SHA256SUMS`, and deploying the worker, are maintainer steps described in the README.
