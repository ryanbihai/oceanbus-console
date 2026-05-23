# OceanBus Console — 从 claude-mem 学习解决的问题分析

## 问题 1：CLAUDE.md 依赖 → 启动极慢

### 现状

OceanBus Console 的核心操作逻辑写在 CLAUDE.md 中（约 400 行），包括：
- 窗口名检测（读 `[System.Console]::Title`）
- 标题清洗（去 spinner emoji）
- Monitor 启动命令组装
- Board 消息回复流程

每次用户安装后，CC AI 必须先读完 CLAUDE.md 才能执行这些操作，且每个步骤依赖 LLM 推理，速度极慢。

### claude-mem 的做法

**零行 CLAUDE.md。全部通过 CC 原生机制注入。**

| 机制 | 作用 | 文件 |
|------|------|------|
| **Plugin manifest** | 注册到 CC 插件系统 | `.claude-plugin/plugin.json` |
| **Hooks** | 7 个生命周期钩子注入行为 | `hooks/hooks.json` |
| **MCP Server** | 提供工具给 CC 调用 | `.mcp.json` + `mcp-server.cjs` |
| **Skills** | 10 个 skill 自动被发现 | `skills/` 目录 |
| **SessionStart hook** | 启动 worker daemon + 注入上下文 | hooks.json → bun-runner.js → worker-service.cjs |

关键：**hook 的返回值是 `{"continue":true,"suppressOutput":true}`**，不影响 CC 正常工作，用户无感知。

### 可用方案

**方案 A：将 OceanBus Console 做成 CC Plugin**

```
oceanbus-console/
├── .claude-plugin/
│   └── plugin.json          # CC 自动发现
├── hooks/
│   └── hooks.json           # SessionStart: 启动 agent daemon
│                            # Stop: 清理进程 + 发 window-close
├── .mcp.json                # 可选:提供 MCP 工具(reply/send/status)
└── scripts/
    └── agent-daemon.cjs     # 后台 agent 进程(常驻,非 Monitor 启动)
```

**SessionStart hook** 自动做：
1. 检测窗口名（直接用 `CLAUDE_CODE_SESSION` 或 `process.cwd()` 的 basename）
2. 创建/复用 OB 身份
3. 后台启动 agent → announce 到 Cloud
4. 返回 `{"continue":true,"suppressOutput":true}`

**好处**：
- 用户安装后零配置，开 CC 窗口即用
- 不需要 CLAUDE.md 里的长篇指令
- CC AI 不需要推理这些操作

**方案 B：`oceanbus init --cc` 自动注入 settings.json**

类似 claude-mem 的安装流程，运行一次 `oceanbus setup-cc`（SDK 已有 `setup-cc.ts`），自动在 `~/.claude/settings.json` 中添加 hooks。之后每个 CC 窗口启动时自动运行 agent。

---

## 问题 2：窗口名获取 + 会话持久化 + 僵尸进程

### 2.1 窗口名获取

**现状**：依赖 CC AI 执行 `[System.Console]::Title` → 清洗 → `--name` 传入。不可靠（PowerShell 进程≠用户终端），易出错。

**claude-mem 的做法**：完全不读终端标题。使用 CC 原生环境变量 `CLAUDE_CODE_SESSION`（每个 CC 窗口唯一）作为 session ID。项目名用 `basename(cwd)`。

**建议**：
- 窗口显示名：`process.cwd()` 的目录名 + PID 后缀（当前已支持）
- 唯一标识：`CLAUDE_CODE_SESSION`（CC 原生提供，无需手动获取）
- 去掉终端标题读取逻辑（从 CLAUDE.md 中移除）

### 2.2 会话持久化

**现状**：消息存在 H5 端的 `localStorage`，无后端持久化。

**claude-mem 的做法**：
```
~/.claude-mem/
├── claude-mem.db           # SQLite (WAL 模式)，存所有 session/observation
├── supervisor.json         # 进程注册表
├── worker.pid              # 当前 worker 的 PID + port
└── settings.json           # 所有配置
```

HTTP Server (localhost:37777) 提供：
- `GET /api/health` — 完整健康检查
- `GET /api/readiness` — 就绪探针
- `POST /api/admin/restart` — 重启（仅 localhost）

**建议**：
- Cloud server (3456) 已有多用户状态管理基础（`users` Map）
- 添加会话持久化：SQLite 或 JSON 文件存储 `{h5_openid → {windows[], messages[]}}`
- Cloud 重启后恢复会话，H5 重连后恢复历史消息

### 2.3 僵尸进程清理

**现状**：有基本的 lock file 机制（`~/.oceanbus/agent-<slug>.lock`），但只做启动时检查和 SIGTERM。

**claude-mem 的做法（多层防护）**：

| 层级 | 机制 | 说明 |
|------|------|------|
| 1 | `.in_use/{pid}` 锁文件 | 含 `procStart` token 防 PID 重用 |
| 2 | `supervisor.json` 进程注册表 | `{type, pid, sessionId, pgid}` |
| 3 | 30s 健康检查 `process.kill(pid, 0)` | 测试 PID 是否存活，死进程即时移除 |
| 4 | `verifyPidFileOwnership()` | Linux `/proc/pid/stat` 验证进程启动时间 |
| 5 | 关闭级联 | SIGTERM → 等 5s → SIGKILL → `taskkill /T /F` |
| 6 | `RestartGuard` | 60s 窗口内最多重启 10 次，防无限循环 |
| 7 | 进程池上限 | 最多 10 个 SDK 子进程 |

**建议**：
- 已有 lock file + `isPidAlive()` — 保留，加固
- 添加 `procStart` token 到 lock file（防 PID 重用）
- 添加 30s 心跳健康检查（Cloud 端已支持：heartbeat 超 30s → offline）
- 添加 `RestartGuard` 防止 agent 崩溃循环
- `window-close` 事件处理：agent 进程退出时自动通知 Cloud

---

## 问题 3：多窗口 openid 覆盖

### 确认：问题存在

**根因**：所有窗口共享 `~/.oceanbus/credentials.json`

```
窗口1: npx oceanbus start --peer <uuid> → load ~/.oceanbus/credentials.json → openid AAA
窗口2: npx oceanbus start --peer <uuid> → load ~/.oceanbus/credentials.json → openid AAA (相同!)
```

Cloud server `server.js:265-267`：
```js
const peerNames = Object.keys(user.peers);
const peer = user.peers[peerNames[0]];  // 取第一个 peer
ob.send(peer.openid, ...);
```

两个窗口有相同的 `agent_openid`，OB L0 把消息发给最近活跃的那个连接 → **HTML 只能跟一个窗口通信**。

`--temp-identity` 解决了身份隔离（每个窗口独立 OB 身份），但失去了持久化（每次都是新身份）。

### claude-mem 的做法

**每个 CC 窗口有独立的 session 标识**：

```
supervisor.json:
  "sdk:16:43412": { "pid": 43412, "sessionId": 16, "pgid": 43412 }

.in_use/
  10408  → {"pid":10408,"procStart":"639146190529091940"}
  10892  → {"pid":10892,"procStart":"639146905358146060"}
```

关键设计：
1. `CLAUDE_CODE_SESSION` 作为 session 唯一标识（CC 原生提供）
2. PID 作为进程级标识
3. `procStart` token 防 PID 重用
4. SQLite `sdk_sessions` 表关联 session 和 project

### 建议方案

**per-window credential 目录**：

```
~/.oceanbus/windows/
├── oceanbus-12345/          # 窗口名-PID
│   └── credentials.json     # 该窗口独立的 OB 身份
├── oceanbus-67890/
│   └── credentials.json
└── _default/
    └── credentials.json     # 向后兼容：非 CC 环境
```

**start.js 改造点**：
- 共享身份模式（无 `--temp-identity`）：改为保存到 `~/.oceanbus/windows/<window-name>/credentials.json`
- 临时身份模式（`--temp-identity`）：保持现状
- 窗口名 → 从 `CLAUDE_CODE_SESSION` + `basename(cwd)` 自动生成，无需 AI 参与

**Cloud server 改造点**：
- peers map 已按 `agent_name` 键区分 → 没问题
- `/api/send` 需要支持指定 target window（目前只取 `peerNames[0]`）
- 加 `window` 参数路由到正确的 agent

---

## 总结：优先级建议

| 优先级 | 问题 | 方案 | 影响范围 |
|--------|------|------|---------|
| **P0** | openid 覆盖 | per-window credential 目录 | start.js, Cloud server |
| **P1** | CLAUDE.md 依赖 | CC Plugin + SessionStart hook | 新增 plugin 结构 |
| **P2** | 窗口名获取 | 用 `CLAUDE_CODE_SESSION` + `cwd` basename | start.js, CLAUDE.md 删除相关行 |
| **P3** | 会话持久化 | Cloud 端加 SQLite/JSON 存储 | server.js |
| **P3** | 僵尸进程 | 加固 lock file + procStart + RestartGuard | start.js |
