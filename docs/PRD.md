# OceanBus Console PRD

> v0.3 — CC Plugin 架构，Per-Window 身份隔离，项目级 Peer 绑定
> 替代 wechat-cc，消除 iLink 依赖，基于 OB L0 P2P 架构

---

## 0. OceanBus Console 宪法

三条不可动摇的原则。所有设计决策以此为准。

### 第一条：灯塔项目

OceanBus Console 是 OceanBus 网络的应用灯塔。它必须**使用 OB 的核心能力**。

| 能力 | 体现 |
|------|------|
| 端到端加密（E2EE） | Agent ↔ Cloud 消息经 OB E2EE 加密 |
| P2P 寻址 | Agent 和 Cloud 各自拥有 OB keypair，通过 openid 直接寻址 |
| 无中心登录 | 身份 = 密钥对，无需账号/密码/手机号 |
| 离线消息 | OB mailbox 持久化，Agent 离线消息不丢失 |

### 第二条：小白友好

**核心体验**：每个**项目**只需配对一次。之后同项目下所有 CC 窗口自动连接，零操作。

| 原则 | 实现 |
|------|------|
| 首次配对 | Board 点按钮 → 复制命令 → CC 粘贴 → 完成（两个动作） |
| 之后每次 | CC 窗口打开 → Plugin SessionStart hook 自动启动 agent → Board 自动出现窗口（零动作） |
| 零记忆 | 不记命令、不记参数、不记地址 |
| 即开即用 | 打开 H5 页面自动创建身份，无需注册登录 |

用户的心智模型：**装一次 Plugin，开窗口就能用。**

### 第三条：Agent 社交网络（未来）

Console 是 Agent 之间的社交入口。

| 阶段 | 能力 |
|------|------|
| 第一阶段（当前） | 人类 ↔ 自己的 Agent（H5 绑定 CC Agent） |
| 第二阶段 | 搜索 OB 黄页，发现外部 Agent |
| 第三阶段 | Agent ↔ Agent 通信 |
| 第四阶段 | Agent 委托链 |

---

## 1. 核心设计决策

### 1.1 不是账号制，是密钥制

- 用户打开 Board → 自动创建 UUID → Cloud 分配 OB openid → localStorage 保存
- 不需要注册、登录、密码、手机号

### 1.2 多人单一 URL

Cloud 按 h5_openid 分区：peers、windows、windowAgents 都以用户 openid 为 key。一个人部署，所有人用。

### 1.3 职责边界：SDK 保持轻量

```
SDK (oceanbus npm)              oceanbus-console (本项目)
─────────────────────           ──────────────────────────
createOceanBus()                agent-daemon.cjs（使用 SDK API）
ob.register()                   窗口命名、凭证管理
ob.send()                       锁文件 + 僵尸清理
ob.startListening()             window-open/heartbeat
CLI: init/whoami/send/listen    reply-ob.cjs
                                CC Plugin + hooks
                                Cloud server (3456)
                                H5 Board
```

**SDK 零改动**。所有 Console 逻辑在 oceanbus-console。

### 1.4 Per-Window 身份隔离

```
~/.oceanbus/windows/
├── cc-abc12345-oceanbus-8180/     # 窗口 1
│   ├── credentials.json           # 独立 OB 身份（含 encryption_key）
│   └── inbox.jsonl                # 消息持久化
├── cc-abc12345-oceanbus-14804/    # 窗口 2
│   ├── credentials.json           # 不同 OB 身份
│   └── inbox.jsonl
```

每个 CC 窗口拥有独立的 OB 身份。多窗口消息互不抢。

### 1.5 项目级 Peer 绑定

```
<project>/
├── .ob-console-peer.json          # { peer, savedAt }
└── .ob-console-gateway.json       # { url, savedAt }
```

首次粘贴配对命令 → peer 保存到项目目录。之后该项目所有 CC 窗口自动加载 peer → 零用户操作。

### 1.6 代理启动（Agent Daemon）

```
CC 窗口打开
  → SessionStart hook (hooks.json)
    → node agent-daemon.cjs           # parent: spawn child, write lock, exit
      → node agent-daemon.cjs --fg    # child: OB identity, window-open, heartbeat, listener
```

daemon 支持三个子命令：
- `node agent-daemon.cjs` — 后台启动（spawn child + exit）
- `node agent-daemon.cjs stop` — 停止（kill child + cleanup）
- `node agent-daemon.cjs context` — 查看状态

### 1.7 出入站链路

```
H5 (浏览器)               Cloud (3456)                   Agent (PC)
─────────                ────────────                   ──────────
                           OB 身份                       OB 身份 (per-window)

      │                       │                              │
      │    HTTP/SSE            │        OB P2P                │
      │ ←── /api/events ───── │ ←── window-open ─────────── │
      │ ←── SSE push ──────── │ ←── heartbeat ───────────── │
      │                       │ ←── reply ───────────────── │
      │ ── /api/send ───────→ │ ── ob.send(message) ──────→ │
      │                       │                              │
```

HTTP 仅用于 Boot 引导和 H5 SSE。所有 Agent↔Cloud 通信走 OB P2P。

---

## 2. 项目结构

```
oceanbus-console/
├── h5/                              # Board 前端
│   ├── index.html
│   ├── guide.html
│   ├── app.js
│   └── style.css
├── cloud/                           # 多用户后端 (端口 3456)
│   ├── server.js
│   └── package.json
├── scripts/                         # Agent 侧脚本
│   ├── agent-daemon.cjs             # Agent 生命周期管理器
│   └── reply-ob.cjs                 # CC → H5 回复脚本
├── .claude-plugin/                  # CC 插件注册
│   └── plugin.json
├── hooks/                           # CC 生命周期钩子
│   └── hooks.json
├── skills/                          # CC Skill（自动发现）
│   └── oceanbus-console/
│       └── SKILL.md
└── docs/
    ├── PRD.md
    └── USER-GUIDE.md
```

---

## 3. Cloud 数据模型

### 3.1 按用户分区

```javascript
{
  "h5OpenId_A": {
    peers: { "agentName": { openid, boundAt } },
    windows: Map { "windowName" → { lastBeat, cwd, status } },
    windowAgents: { "windowName" → agent_openid },  // per-window 路由
    sse: Set<Response>,
    boardOpenId: "derived_from_cloud+h5"
  }
}
```

### 3.2 Per-Window 消息路由

```
/api/send { h5_openid, window, text }
  → lookup windowAgents[window]
  → ob.send(agent_openid, message)
  → 精确投递到目标窗口
```

### 3.3 OB 消息模式

| 方向 | OB action | Cloud 处理 |
|------|-----------|-----------|
| Agent → Cloud | `window-open` | 注册窗口 + windowAgents 映射 → SSE 推 Board |
| Agent → Cloud | `heartbeat` | 更新心跳 + 改名检测 |
| Agent → Cloud | `window-close` | 移除窗口 + windowAgents 清理 → SSE |
| Agent → Cloud | `reply` / `message` | SSE 推 H5 |
| Cloud → Agent | `message` | `/api/send` → Cloud OB send → Agent OB listener |

---

## 4. 消息格式

```json
// 标准消息
{ "action": "message", "window": "name", "text": "内容",
  "from": "h5|agent", "time": "14:30:00", "msg_id": "h5_1" }

// 控制消息
{ "action": "window-open",  "window": "name", "agent_openid": "...", "agent_type": "cc-window" }
{ "action": "window-close", "window": "name" }
{ "action": "heartbeat",    "window": "name", "newname": "新名" }
```

---

## 5. Cloud API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 健康检查 |
| `/api/identity` | GET | Cloud 自身的 OB openid |
| `/api/my-address` | GET | Board 的派生 OB openid |
| `/api/peers` | GET | 绑定 Agent 列表（需 h5_openid） |
| `/api/windows` | GET | 活跃窗口列表（需 h5_openid） |
| `/api/send` | POST | H5 发消息 {h5_openid, window, text} |
| `/api/events` | GET | SSE 实时推送 |

---

## 6. 窗口命名

### 优先级

```
1. --name CLI flag                   # 手动覆盖
2. OCEANBUS_WINDOW_NAME env          # 环境变量注入
3. cc-{sessionId8}-{cwdBasename}     # CC 窗口自动生成（daemon 默认）
   例: cc-a1b2c3d4-oceanbus
```

daemon 自动检测 `CLAUDE_CODE_SESSION_ID`，前缀 `cc-{前8位}-` + 目录名。

---

## 7. 锁文件格式

```json
{
  "pid": 12345,
  "procStart": "1779457756665531300",
  "windowName": "cc-a1b2c3d4-oceanbus"
}
```

`procStart` 纳秒级时间戳，用于验证 PID 所有权，防 PID 重用攻击。

---

## 8. 开发教训

### 8.1 共享凭证 = 多窗口消息互抢

**现象**：多窗口共享 `~/.oceanbus/credentials.json`，OB L0 将消息投递给任一实例。

**修复**：Per-window 凭证目录 `~/.oceanbus/windows/<name>/credentials.json`。

### 8.2 `exportState()` 必须先 `getAddress()`

`ob.register()` 后 `openidCache = null`。必须先调 `getAddress()`（触发 `GET /agents/me` 获取 openid），再调 `exportState()` 才能拿到 openid。

### 8.3 单实例优于双实例

不要创建两个 `createOceanBus()` 实例（一个注册、一个使用）。用一个实例完成注册+操作。Credential 复用走 `identity: { agent_id, api_key, openid, encryption_key }` 显式传入。

### 8.4 持久进程不能被 Monitor 直接运行

`agent-daemon.cjs` 的 `--fg` 模式持久运行。daemon 默认模式 spawn 后台子进程 + 立即退出，解决 Monitor 阻塞问题。

### 8.5 清理级联

```
SIGTERM → 等 3s → SIGKILL → Windows: taskkill /T /F /PID
退出发送 window-close → 释放锁文件
```
