# LocalMCP 增强版

这是 [daodao97/localmcp](https://github.com/daodao97/localmcp) 的增强版（enhanced edition），由 [DDD0s/localmcp](https://github.com/DDD0s/localmcp) 自行维护。上游仓库已停止更新（npm `@daodao97/localmcp` 最后版本 0.3.9）。本仓库保留原作者版权与 MIT 许可证，并在此基础上继续开发。

让 ChatGPT 网页端使用你的本机开发能力：文件操作、Shell、持久进程、Skills 和可插拔 MCP Server。

![LocalMCP 工作原理：ChatGPT 经 Cloudflare Worker 中继，连接本机 Agent 和工具](localmcp.png)

本机主动通过 WebSocket 连接 Cloudflare Worker，由 Worker 负责认证与请求中继，无需公网 IP 或开放入站端口。命令行名称仍是 `localmcp`。

**English:** This fork keeps the same CLI and `~/.localmcp` config. New installs should use GitHub (or, after publish, `@ddd0s/localmcp`) instead of `@daodao97/localmcp`. Existing connector URLs are kept.

## 相对上游的变化

| 能力 | 增强版 |
| --- | --- |
| 中继 | 可部署到自己的 Cloudflare 账号；不设置时仍使用原来的公共中继 |
| MCP URL | 重装、重新注册、更换中继主机时保持 device id 与 token；支持自定义域名 |
| 409 | 已认证的 Agent 可接管崩溃或重启后留下的会话；未声明接管的第二个客户端会得到明确错误 |
| 速度 | 工具服务跑在 Agent 进程内；自建中继协商更大分片，重复文本会 gzip |
| 恢复 | 断线指数退避重连；`status` / `health` 带退出码；Linux systemd 与 Windows 登录自启 |
| 桌面 | 遵守 `HTTP(S)_PROXY`（含 `127.0.0.1:7897`），本机地址不走代理；日志带时间，退出会关掉连接 |
| 权限 | 可单独关闭文件写入和 Shell；可用 `allowedDirectories` 限制目录。默认与旧版相同 |

## 从 `@daodao97/localmcp` 迁移

已有 `~/.localmcp/worker.json` 和 `localmcp.json` 不用删，MCP URL 不会变。

```sh
npm uninstall -g @daodao97/localmcp
git clone --depth 1 https://github.com/DDD0s/localmcp.git
cd localmcp
npm ci --ignore-scripts
npm pack
npm install -g ./ddd0s-localmcp-0.4.1.tgz
localmcp
```

> `npm install -g github:DDD0s/localmcp` does not work with npm 11: it exits 0 but builds no `dist/` and creates no `localmcp` command. Build the tarball as above (`npm pack` prints its file name), or install a release tarball once one is published. After a GitHub Release with a `SHA256SUMS` asset exists, `localmcp update` repeats an install from that release. It does not clone `main`.

Windows PowerShell 同样使用上面的 npm 命令。升级后会多写一份 `~/.localmcp/identity.json`，用来在 `worker.json` 丢失时恢复同一条 URL。

包尚未发布到 npm。发布之后也可以：

```sh
npm install -g @ddd0s/localmcp
```

自己更新（需要已经发布、并带有 `SHA256SUMS` 的 GitHub Release）：

```sh
localmcp update
localmcp update v0.4.1
localmcp update <40-hex-commit>
```

`localmcp update` installs the latest GitHub Release of this repository. It downloads `https://github.com/DDD0s/localmcp/archive/refs/tags/<tag>.tar.gz`, checks that file's SHA-256 and the tag's commit against the release asset `SHA256SUMS`, and only then runs `npm ci --ignore-scripts`, `npm pack`, and `npm install -g`. `localmcp update v0.4.1` pins that tag. `localmcp update <40-hex-commit>` installs the release whose tag points at that commit. Branch names such as `main` are refused. A tree whose `package.json` name is not `@ddd0s/localmcp` is refused. A running agent keeps the old code until `localmcp stop` and `localmcp`.

Until a release with `SHA256SUMS` is published, `localmcp update` exits with an error instead of installing unverified source. Maintainers: after the GitHub Release exists (this repository does not tag or publish it for you), attach the checksum of that exact archive URL:

```sh
TAG=v0.4.1
curl -fsSL -L -o source.tar.gz "https://github.com/DDD0s/localmcp/archive/refs/tags/${TAG}.tar.gz"
COMMIT=$(git rev-parse "refs/tags/${TAG}^{}")
node -e "const fs=require('fs');const c=require('crypto');const b=fs.readFileSync('source.tar.gz');console.log(c.createHash('sha256').update(b).digest('hex')+'  source.tar.gz');console.log('commit '+process.argv[1]);" "$COMMIT" > SHA256SUMS
gh release upload "$TAG" SHA256SUMS
```

The `commit` line is the commit the tag points at (`^{}` peels an annotated tag). `localmcp update` refuses the release if either line does not match.

## 快速开始

不设置中继地址时，仍使用原来的公共中继，已有用户无需改连接器。

### 第一步：准备环境

- 安装 **Node.js 22+**，在终端运行 `node -v` 确认版本。
- 准备 ChatGPT 账号。

### 第二步：安装并启动

```sh
git clone --depth 1 https://github.com/DDD0s/localmcp.git
cd localmcp
npm ci --ignore-scripts
npm pack
npm install -g ./ddd0s-localmcp-0.4.1.tgz
localmcp
```

看到 `Status: running` 后，运行 `localmcp status --show-url`，复制 `MCP URL:` 后的**完整地址**。也可以在启动时加 `--show-url`（`localmcp --show-url`）。普通的 `localmcp`、`localmcp status` 和 `~/.localmcp/agent.log` 会把密钥显示成 `<redacted>`。

> MCP URL 包含访问凭证，请勿公开。服务在后台运行，使用时保持电脑开机、联网即可。

### 第三步：开启 ChatGPT 开发者模式

登录 ChatGPT，在 **设置 → 安全与登录** 中开启 **开发者模式**：[点我打开设置](https://chatgpt.com/#settings/Security?section=developer-mode)。

![在 ChatGPT 中开启开发者模式](chatgpt_developer_mode.png)

### 第四步：在 ChatGPT 中添加 LocalMCP

[点我新建插件](https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins)，填写后创建：

| 字段 | 填写内容 |
| --- | --- |
| 名称 | `LocalMCP` |
| 描述（如需） | 连接本机文件和开发工具 |
| 服务器 URL | 第二步复制的完整 MCP URL |
| 身份验证 | **None（无）** |

![在 ChatGPT 中添加 LocalMCP 插件](chatgpt_add_plugin.png)

### 第五步：开始使用

在个人插件中安装 LocalMCP，回到首页新建对话。输入 `@` 选择 **LocalMCP**，发送：

> 请列出本机工作区的路径和根目录下的文件，不修改任何内容。

如出现工具调用确认，核对后允许。返回本机目录列表即连接成功。

<details>
<summary>遇到问题？</summary>

- **找不到 `localmcp` 命令**：确认安装成功，再重新打开终端。Windows 有时需要新开一个终端。
- **启动失败**：运行 `localmcp status`，查看 `Log:` 指向的日志（`~/.localmcp/agent.log`）。
- **本机开了 127.0.0.1:7897 这类 HTTP 代理**：先设置 `HTTPS_PROXY` 和 `HTTP_PROXY` 再启动，见下文。
- **ChatGPT 无法连接**：确认本机服务已启动、网络正常，URL 复制完整，身份验证为 **None**。
- **日志里出现 409**：公共中继遇到残留会话时仍可能返回 409，并会按退避重试。自建中继会在重启时直接接管该会话。
- **找不到开发者模式或插件**：检查账号权限，确认插件已安装，并新建对话。操作入口见 [OpenAI 官方说明](https://developers.openai.com/plugins/quickstart/)。

</details>

## 常用命令

| 命令 | 用途 | 退出码 |
| --- | --- | --- |
| `localmcp` | 启动后台服务，已运行时复用已有进程 | 启动失败为非 0 |
| `localmcp status` | 查看状态和日志路径。MCP URL 默认隐去密钥 | 运行且就绪为 0，否则 1 |
| `localmcp status --show-url` | 打印完整 MCP URL，供复制到 ChatGPT | 同 `status` |
| `localmcp health` | 检查本机进程，并请求中继 `/healthz`。URL 默认隐去密钥；`localmcp health --show-url` 显示完整地址 | 0 健康，1 未运行或中继不可达，2 本地错误 |
| `localmcp stop` | 停止后台服务 | |
| `localmcp reload` | 校验并重新加载配置 | |
| `localmcp agent` | 前台运行，便于调试 | |
| `localmcp update [tag or commit]` | 安装已校验的 GitHub Release，不拉取 `main` | |
| `localmcp relay` | 查看或保存自建中继地址 | |
| `localmcp autostart install` | 安装用户级自启 | |
| `localmcp version` | 打印 `@ddd0s/localmcp` 与版本号 | |

脚本里用 `localmcp health`。`status` 在进程没起来时返回 1，便于 `localmcp status && ...`。

日志：`~/.localmcp/agent.log`。停止服务或重启电脑后，运行 `localmcp` 即可重新启动。断线后 Agent 会按 1s、2s、4s… 最多 30s 加抖动重连，不会重放已经发出的工具调用。

The agent also retries with the same backoff when the relay refuses the WebSocket (HTTP 409, 5xx, a proxy error). Agent exit codes: `0` stopped on request, `1` crashed or failed to start, `3` another authenticated agent took over this device, `4` another agent already serves this `~/.localmcp`. systemd and the Windows autostart supervisor restart the agent only after `1`.

## 自建中继

公共中继仍是默认值：`https://localmcp-relay.daodao973597.workers.dev`。需要自己的地址、自定义域名，或崩溃后立即接管会话时，把本仓库的 Worker 部署到**你自己的** Cloudflare 账号。

### 第一步：部署 Worker

准备 Cloudflare 账号。在仓库根目录：

```sh
git clone https://github.com/DDD0s/localmcp.git
cd localmcp
npm ci
npx wrangler login
npm run worker:deploy
```

也可以用部署按钮：[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DDD0s/localmcp)

部署配置在 [wrangler.jsonc](wrangler.jsonc)：Worker 名称 `localmcp-relay`，入口 `worker/index.ts`，Durable Object 类 `McpRelay`。`npm run worker:deploy` 就是 `wrangler deploy --config wrangler.jsonc`。

部署完成后，在输出或 **Settings → Domains & Routes** 里复制地址，例如 `https://localmcp-relay.<你的子域>.workers.dev`。

检查：

```sh
curl https://localmcp-relay.<你的子域>.workers.dev/healthz
```

返回里应包含 `"ok":true`、`"service":"localmcp-relay"`、`"registration":true`、`"protocol":2`，以及 `"rateLimit":true`。`protocol: 2` 表示这是增强版中继（稳定重绑、会话接管、大分片和 gzip）。

### 速率限制

`wrangler.jsonc` 里的 `ratelimits` 会在 `npm run worker:deploy` 时生效，不需要另外开通产品。三条绑定：

| 绑定 | 路径 | 默认 |
| --- | --- | --- |
| `REGISTER_RATE_LIMITER` | `POST /register` | 每个连接 IP 每 60 秒 20 次 |
| `MCP_RATE_LIMITER` | `POST /mcp` | 每个 device id 每 10 秒 200 次 |
| `MCP_IP_RATE_LIMITER` | `POST /mcp` | 每个连接 IP 每 10 秒 200 次 |

ChatGPT 正常对话远低于这个速率（一次工具调用是一次 POST，并行调用通常只有几次）。多个 ChatGPT 连接器可能共用 OpenAI 的出口 IP，因此「每 IP」额度是共享的，并且按 Cloudflare 位置分别计算；单个连接器还有自己的 device 额度。`/healthz` 和 Agent 的 WebSocket（`/agent`）不计数，重连不受影响。超过限制时返回 HTTP 429，正文为 `{ "error", "code": "rate_limited", "retryAfter" }`，并带 `Retry-After`。`POST /register` 在创建 Durable Object 之前计数，`POST /mcp` 在读取正文之前计数。已有 MCP URL 和 protocol 2 的注册响应不变。

计数键是 Cloudflare 写入的 `CF-Connecting-IP`，以及 `/mcp` 路径里的 device id。限额按 Cloudflare 位置分别计算，并且是近似值（见 [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)）。`namespace_id`（`18421001`、`18421002`、`18421003`）必须在账号内唯一；部署报冲突时改掉这三个值，并保持与 `worker/rate-limit.ts` 里的数字一致。没有绑定时代码仍会在当前 isolate 上套用同样的数字，跨地点的限制要靠上面的绑定。

本次变更没有部署 Worker。合并后在仓库根目录执行 `npm run worker:deploy` 才会让线上中继开始限流。已有 Durable Object 数据不需要迁移。

### 第二步：可选自定义域名

在 `wrangler.jsonc` 里取消注释并改成你的域名：

```jsonc
"vars": { "PUBLIC_BASE_URL": "https://mcp.example.com" },
"routes": [{ "pattern": "mcp.example.com", "custom_domain": true }]
```

再次 `npm run worker:deploy`。ChatGPT 里使用的源站由 `PUBLIC_BASE_URL` 决定；Agent 仍然连你配置的 Worker 源站。两者必须指向同一个 Worker。

### 第三步：让本机使用这个中继

不要删除已有凭证。`localmcp relay` 只改地址，device id 和 token 保持不变，因此 MCP URL 的路径不变。只有主机名会随中继或自定义域名改变。

```sh
localmcp stop
localmcp relay https://localmcp-relay.<你的子域>.workers.dev

Protect `/register` on your Worker with a Cloudflare secret named `REGISTER_TOKEN`, then on each agent machine:

```bash
# Worker secret (once per deployment)
npx wrangler secret put REGISTER_TOKEN --config wrangler.jsonc
# Agent side (same value)
localmcp register-token '<same-secret>'
# or: export LOCALMCP_REGISTER_TOKEN='<same-secret>'
```

Without the matching header `x-localmcp-register-token`, `POST /register` returns 401. Existing agent reconnect and ChatGPT MCP calls are unchanged.

# 若配置了自定义域名：
localmcp relay https://localmcp-relay.<你的子域>.workers.dev --public https://mcp.example.com
localmcp
```

也可以只用自定义域名作为连接地址：

```sh
localmcp relay https://mcp.example.com
```

环境变量（当前进程有效，写入配置后可不再设置）：

| 变量 | 作用 |
| --- | --- |
| `LOCALMCP_WORKER_URL` | 中继源站，须为 HTTPS 源站；本机调试可用 `http://127.0.0.1` |
| `LOCALMCP_PUBLIC_URL` | 展示给 ChatGPT 的源站，用于自定义域名 |

第一次在增强版中继上注册后，重复注册同一组凭证会得到同一个 `mcpUrl`。凭证不匹配时返回 HTTP 409，不会覆盖原来的设备。

如果把地址指到**不支持稳定重绑**的旧中继，程序会拒绝换发新凭证，避免悄悄改掉 ChatGPT 里的 URL。

## 代理、自启和关闭

Windows 主环境若通过 `127.0.0.1:7897` 上网，在启动前设置（系统环境变量或当前终端均可）：

```bat
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
localmcp
```

macOS / Linux：

```sh
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
localmcp
```

`127.0.0.1`、`localhost`、`::1` 会加入 `NO_PROXY`，本机工具调用不经过代理。日志里会出现 `Using HTTP proxy ...`。

自启：

```sh
localmcp autostart install
localmcp autostart status
localmcp autostart remove
```

- Linux：写入 `~/.config/systemd/user/localmcp.service` 并尝试 `systemctl --user enable --now`。没有 systemd 时仍会留下 unit 文件，并打印手动启用的命令。
- Windows: writes `localmcp.cmd` to the Startup folder. At login it starts a hidden supervisor (`localmcp autostart run`) that runs the agent without a console window, appends its output to `~/.localmcp/agent.log` and restarts it after a crash (3 s, doubling up to 60 s). `install` and `remove` also delete the `LocalMCP` logon task written by earlier 0.4.0 builds, which started a second agent.
- Both: a proxy set at install time is written into the unit or the script. Exit codes `3` and `4` are final, so two machines sharing one identity no longer keep taking the session from each other. On Linux, a user unit starts at boot only after `loginctl enable-linger "$USER"`; otherwise it starts at login.

`localmcp stop`、Ctrl+C、SIGTERM（Windows 上还有 SIGBREAK）会关闭中继 WebSocket、停掉子进程并删除控制套接字。请用 `localmcp stop`，不要直接结束进程树。

## 配置与扩展

### 工作区、写入和目录范围

首次启动会创建 `~/.localmcp/localmcp.json`。默认工作区是用户主目录（`~`），文件、文件写入、Shell 和持久进程都开启，不额外限制目录。这与旧版行为一致。

```json
{
  "workspaces": {
    "project": "C:/Users/你的用户名/code/project"
  },
  "defaultWorkspace": "project",
  "features": {
    "files": true,
    "fileWrites": true,
    "shell": true,
    "processes": true
  },
  "allowedDirectories": [],
  "skills": {
    "dir": "skills",
    "enabled": ["local-development"]
  },
  "mcpServers": {}
}
```

- **多工作区**：在 `workspaces` 中添加路径。调用工具时用 `workspace` 选择，省略时用默认工作区。Windows 路径建议写成 `C:/Users/...`。
- **关闭文件写入**：`"fileWrites": false` 会去掉 `write_file`、`edit_file`、`apply_patch`、`create_directory`、`delete_path`、`move_path`，读取仍然可用。
- **关闭 Shell**：`"shell": false` 会去掉命令和持久进程。持久进程依赖 Shell。
- **目录范围**：`allowedDirectories` 为空或省略时，整个工作区可用。写上路径后，文件工具和命令的工作目录必须落在其中之一。Shell 不是沙箱，命令内容仍可能访问其他路径；需要硬边界时同时把 `shell` 设为 `false`。

完整示例见 [localmcp.example.json](localmcp.example.json)。可用 `LOCALMCP_CONFIG` 指定其他配置文件。

### 外部 MCP 服务

在 `mcpServers` 中添加服务。例如已安装 `cua-driver` 时：

```json
{
  "mcpServers": {
    "computer": {
      "enabled": true,
      "command": "cua-driver",
      "args": ["mcp"]
    }
  }
}
```

| 工具 | 用途 |
| --- | --- |
| `list_mcp_servers` | 列出已加载的服务 |
| `list_mcp_tools` | 查询指定 `server` 的工具及参数 |
| `call_mcp_tool` | 传入 `server`、`tool` 和 `arguments` 调用工具 |

多个外部服务会并行启动。统一入口可能执行写入、命令及网络操作。

### 配置生效与重载

主配置保存后约一秒自动生效，不重启 Agent，也不改变 MCP URL。更新失败时保留旧配置，错误写入日志。

| 修改内容 | 生效方式 |
| --- | --- |
| 主配置（含 `LOCALMCP_CONFIG`） | 自动更新；不打断当前调用或已有进程 |
| `SKILL.md` 文件内容 | 在本机终端运行 `localmcp reload` |
| 中继地址或自定义域名 | `localmcp relay ...` 后重新启动 |

`localmcp reload` 会重新加载内部服务，请在本机终端执行，不要通过 LocalMCP 的 `run_command` 调用。

### 速度

请求路径是：ChatGPT HTTP → 自建或公共 Worker → Durable Object → 本机 WebSocket → 进程内 MCP 工具 → 原路返回。中继不是轮询。

在这台 Linux 测量机上，相对 0.3.9 的本机路径：

| 项目 | 之前 | 增强版 |
| --- | --- | --- |
| 工具进程就绪 | 另起 HTTP 子进程约 216 ms | 同一进程内约 1.4 ms |
| `tools/list` 30 次 | 约 3.2 ms/次（回环 HTTP） | 约 1.2 ms/次 |
| 约 380 KB 可压缩载荷 | 16 个 24 KB 帧，约 381 KB | 自建中继 1 帧，约 1.1 KB |
| 不可压缩数据 | 24 KB 分片 | 保持原样，分片提高到 120 KB |

公共中继不宣告 `protocol: 2`，因此仍使用 24 KB、不压缩的旧帧，避免和现网 Worker 不兼容。ChatGPT 到 Worker 仍是一次 JSON 响应，没有改成 SSE。

数字来自 `node scripts/bench-path.mjs --http`。广域网往返不在这组数字里；自建中继上，大段重复的命令输出或文本会少很多 WebSocket 消息。

### 其他连接方式

**stdio**（供支持该协议的 MCP 客户端）：

```sh
localmcp stdio
```

**本地 HTTP**（密钥至少 32 字符）：

```sh
LOCALMCP_TOKEN='替换为至少32字符的密钥' localmcp http
```

Windows PowerShell：`$env:LOCALMCP_TOKEN='替换为至少32字符的密钥'; localmcp http`

## 从源码构建

For normal use, install as shown above. To work on the source:

```sh
git clone https://github.com/DDD0s/localmcp.git
cd localmcp
npm ci
npm run check
npm test
npm run build
node dist/index.js version
```

## 发布到 npm（维护者）

当前不会自动发布。包名 `@ddd0s/localmcp` 在编写时未被占用（`localmcp-plus` 同样空闲，选用了与 GitHub 账号一致的 scope）。

1. 在 npm 上使用账号 `ddd0s`（scope 必须与包名一致）。
2. `npm login`
3. `npm publish --access public`

After publishing, the install command becomes `npm install -g @ddd0s/localmcp`. Until then, build the tarball as in the install section, or attach it to a GitHub release and install from its URL. `localmcp update` only works after that release also has the `SHA256SUMS` asset described above. Do not point `localmcp update` at `main`.

## License

MIT. Copyright (c) 2026 daodao97. Copyright (c) 2026 DDD0s.
The original project is [daodao97/localmcp](https://github.com/daodao97/localmcp).
