import { readFile } from 'node:fs/promises';
import { config, configFilePath, type Config } from './config.js';
import { watchConfig } from './config-watch.js';
import { McpLoader } from './mcp/loader.js';
import { createServer } from './server.js';
import { loadSkills, type Skill } from './skills/loader.js';
import { ProcessManager } from './process.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

interface RuntimeState { config: Config; mcp: McpLoader; skills: Skill[] }

export interface LocalRuntime {
  server: Server;
  handle(body: string, protocolVersion?: string): Promise<{ status: number; body: string }>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

export async function startLocalRuntime(): Promise<LocalRuntime> {
  const initial = await config();
  const mcp = new McpLoader(initial.mcpServers);
  await mcp.start();
  const skills = await loadSkills(initial.skillsDir, initial.enabledSkills);
  const processes = new ProcessManager();
  let runtime: RuntimeState = { config: initial, mcp, skills };
  const retired = new Set<Promise<void>>();
  const server = await createServer(initial, mcp, skills, processes, () => runtime);
  const path = configFilePath();

  async function apply(content: string) {
    const nextConfig = await config({ content, path });
    if (JSON.stringify(nextConfig) === JSON.stringify(runtime.config)) return;
    const nextSkills = await loadSkills(nextConfig.skillsDir, nextConfig.enabledSkills);
    const changedMcp = JSON.stringify(nextConfig.mcpServers) !== JSON.stringify(runtime.config.mcpServers);
    const nextMcp = changedMcp ? new McpLoader(nextConfig.mcpServers) : runtime.mcp;
    if (changedMcp) await nextMcp.start();
    const previous = runtime;
    runtime = { config: nextConfig, mcp: nextMcp, skills: nextSkills };
    if (changedMcp) {
      const closing = previous.mcp.close().finally(() => retired.delete(closing));
      retired.add(closing);
    }
    console.error('LocalMCP configuration hot-reloaded.');
  }

  const closeWatcher = watchConfig(path, apply, error => {
    console.error('LocalMCP config hot-reload rejected; keeping current configuration:', error instanceof Error ? error.message : String(error));
  });

  let gate = Promise.resolve();
  return {
    server,
    async handle(body, protocolVersion) {
      const previous = gate;
      let release!: () => void;
      gate = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
        if (protocolVersion) headers.set('mcp-protocol-version', protocolVersion);
        const response = await transport.handleRequest(new Request('http://127.0.0.1/mcp', { method: 'POST', headers, body }));
        return { status: response.status, body: await response.text() };
      } finally {
        await transport.close().catch(() => {});
        release();
      }
    },
    async reload() { await apply(await readFile(path, 'utf8')); },
    async close() {
      await closeWatcher();
      await server.close().catch(() => {});
      await processes.close();
      await runtime.mcp.close();
      await Promise.allSettled([...retired]);
    },
  };
}
