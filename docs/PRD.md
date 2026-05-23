# OceanBus Console PRD

> v0.3.1 — 每用户独立 Board OB 身份，Payload 路由，多 CC 窗口通信
> 基于 OB L0 P2P 架构，Cloud 无自有 OB 身份

---

## 0. OceanBus Console 宪法

三条不可动摇的原则。

### 第一条：灯塔项目

OceanBus Console 是 OceanBus 网络的应用灯塔。必须**使用 OB 的核心能力**。

| 能力 | 体现 |
|------|------|
| 端到端加密（E2EE） | Agent ↔ Board 消息经 OB E2EE 加密 |
| P2P 寻址 | Agent 和 Board 各自拥有 OB keypair，通过 openid 直接寻址 |
| 无中心登录 | 身份 = 密钥对，无需账号/密码/手机号 |

### 第二条：小白友好

**核心体验**：Board 点按钮 → 复制命令 → CC 粘贴 → 完成。之后所有 CC 窗口自动连接，零操作。

| 原则 | 实现 |
|------|------|
| 首次配对 | Board 点按钮 → 复制命令 → CC 粘贴 → 完成 |
| 之后每次 | SessionStart hook 自动启动 daemon → Board 自动出现窗口 |
| 零记忆 | 不记命令、不记参数、不记地址 |
| 即开即用 | 打开 Board 自动创建身份，无需注册登录 |

### 第三条：Agent 社交网络（未来）

| 阶段 | 能力 |
|------|------|
| 第一阶段（当前） | 人类 ↔ 自己的 Agent（Board 绑定 CC Agent） |
| 第二阶段 | 搜索 OB 黄页，发现外部 Agent |
| 第三阶段 | Agent ↔ Agent 通信 |

---

## 1. 核心架构

### 1.1 每用户独立 Board OB 身份

**Cloud 没有自己的 OB 身份**。每个 Board 用户拥有独立的 OB keypair，Cloud 替 Board 持有私钥并监听。

```
Board-A (浏览器) ←SSE→ Cloud
                          ├─ Board-A OB 实例 (监听 Board-A 的 OB 地址) ←OB── Agent-A
                          ├─ Board-B OB 实例 (监听 Board-B 的 OB 地址) ←OB── Agent-B
                          └─ ...

Agent-A (CC窗口1) ──OB──→ Board-A 的 OB 地址 ──→ Cloud 接收 → SSE → Board-A 浏览器
Agent-B (CC窗口2) ──OB──→ Board-A 的 OB 地址 ──→ Cloud 接收 → SSE → Board-A 浏览器
```

**关键设计**：OB SDK 在同一进程中的多个实例存在消息串扰（消息发送到实例 A 的地址，实例 B 的 listener 也能收到）。因此每个 listener 通过 `h5_openid` payload 字段做精确过滤。

### 1.2 身份存储

```
~/.oceanbus-console/
├── sessions.json                           # 用户状态（peers, windowAgents）
└── users/
    └── <h5openid-uuid>/
        └── ob-identity.json                # Board OB 身份凭证

~/.oceanbus/
├── console-peer.json                       # 全局 peer（含 h5id）
├── console-gateway.json                    # 全局 gateway URL
└── windows/
    └── <window-name>/
        ├── credentials.json                # Agent 窗口 OB 身份
        └── inbox.jsonl                     # 消息持久化
```

### 1.3 职责边界

```
SDK (oceanbus npm)              oceanbus-console (本项目)
─────────────────────           ──────────────────────────
createOceanBus()                agent-daemon.cjs（Agent 生命周期）
ob.createIdentity()             窗口命名、凭证管理
ob.send()                       锁文件 + 僵尸清理
ob.startListening()             window-open / heartbeat / welcome
ob.getAddress()                 reply-ob.cjs（回复脚本）
                                inbox-monitor（实时消息流）
                                CC Plugin + hooks (Setup / SessionStart / Stop)
                                Cloud server (3456)
                                H5 Board
```

---

## 2. 出入站消息实现

### 2.1 Agent → Board（出站，Agent 主动发）

```
Agent-daemon 启动
  │
  ├─ 1. window-open → Board OB 地址
  │     { action: "window-open", window, agent_openid, agent_name, h5_openid: "<UUID>" }
  │     → Cloud 收到 → 注册窗口 + windowAgents 映射 → SSE "windows" 事件 → Board 显示窗口
  │
  ├─ 2. 欢迎消息 → Board OB 地址
  │     { action: "message", text: "👋 窗口名 上线了！", h5_openid: "<UUID>" }
  │     → Cloud 收到 → SSE "message" 事件 → Board 显示欢迎消息
  │
  └─ 3. heartbeat（每15s）→ Board OB 地址
        { action: "heartbeat", window, agent_openid, h5_openid: "<UUID>" }
        → Cloud 更新心跳 + 检测改名 + Cloud 重启后自动重注册 windowAgents
```

### 2.2 Board → Agent（入站，用户从 Board 发消息）

```
Board 用户输入消息
  │
  └─ POST /api/send { h5_openid: "<UUID>", window: "窗口名", text: "消息" }
       │
       ├─ Cloud 查找 windowAgents[window] → agent_openid
       ├─ Cloud 用 Board 自己的 OB 实例发送:
       │     ob.send(agent_openid, { action: "message", text, from: "h5", h5_openid: "<UUID>" })
       │
       └─ Agent OB listener 收到
            ├─ 写入 inbox.jsonl（持久化）
            ├─ stdout emit JSON（CC Monitor 可捕获）
            └─ 自动回复 "已收到" → Board OB 地址
```

### 2.3 Agent → Board 回复（CC AI 回复 Board 消息）

```
CC AI 调用 ob_reply 或 reply-ob.cjs
  │
  └─ 加载 peer (Board OB 地址) + h5id (UUID)
     │
     └─ ob.send(Board OB 地址, { action: "reply", text, h5_openid: "<UUID>" })
          │
          └─ Cloud listener 收到 → SSE "message" 事件 → Board 显示回复
```

### 2.4 Cloud Listener 路由机制

```
OB 消息到达 → Cloud 的某个 Board OB listener
  │
  ├─ 解析 payload.h5_openid
  ├─ 尝试作为 UUID 查找用户 → users.get(payloadH5Id)
  ├─ 未找到 → 遍历 boardObs 查找匹配的 Board OB openid
  ├─ 仍未找到 → 回退到当前 listener 的用户
  └─ 找到用户 → 处理消息（window-open/heartbeat/message/reply）
       └─ SSE 广播到该用户的 Board 浏览器
```

---

## 3. 六项需求实现

### 需求 1：CC 安装后自动发欢迎消息

**实现文件**：`scripts/agent-daemon.cjs`（line 424-431）

Agent daemon 启动后，在发送 `window-open` 之后立即发送欢迎消息：

```javascript
await ob.send(peerOpenId, JSON.stringify({
  action: 'message', window: finalWin,
  text: `👋 ${finalWin} 上线了！`,
  from: 'agent', h5_openid: h5Id,
  time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
}));
```

Cloud 收到 `action: "message"` → SSE 推送给 Board → Board 显示欢迎气泡。

### 需求 2：多个 CC 端在 Board 实现多个操作入口

**实现文件**：`h5/app.js`（`renderWindows()`），`cloud/server.js`（`windowAgents` 路由）

- Board 侧栏列出所有 `status === "online"` 的窗口，每个可独立点击进入聊天
- Cloud 通过 `user.windowAgents[windowName] → agent_openid` 映射实现精确的 per-window 路由
- Agent OB listener 过滤 `msgWindow !== finalWin` 忽略非本窗口的消息

### 需求 3：多个 CC 端与 Board 成功通信

**全链路已通过测试验证**：

```
Board → Agent: POST /api/send → Cloud 用 Board OB 实例发送 → Agent OB listener 收到 → inbox.jsonl
Agent → Board: ob.send(Board OB 地址) → Cloud listener 收到 → SSE → Board 显示
```

每条消息携带 `h5_openid`（UUID），Cloud listener 精准路由到目标用户。

### 需求 4：Board 指令注入 CC 上下文并完成回复

**三种方式**：

| 方式 | 触发 | 适用场景 |
|------|------|---------|
| `ob_inbox` MCP 工具 | 用户说"查看 OceanBus 消息" | 轮询，CC AI 读取 inbox.jsonl |
| `inbox-monitor` | Monitor 持续运行 | 实时推送，Board 消息自动出现在 CC 上下文 |
| SessionStart hook 输出 | CC 会话启动 | 显示 `inbox: N` 提示用户有新消息 |

CC AI 收到消息后调用 `ob_reply`（MCP 工具）或 `agent-daemon.cjs reply --text "..."` 进行回复。

### 需求 5：Board OB openid 永久化 + 自动重连

**Board 侧**（浏览器）：
- UUID 存储在 `localStorage["ob-h5-openid"]`，永久不变
- Board OB openid 由 Cloud 持久化到 `~/.oceanbus-console/users/<uuid>/ob-identity.json`
- Cloud 重启后从磁盘恢复 Board OB 身份，同一用户获得相同 OB 地址
- Board 每次打开调用 `/api/my-address` 获取最新 OB 地址（不依赖 localStorage 缓存）

**Agent 侧**（CC 窗口）：
- 全局 peer 文件 `~/.oceanbus/console-peer.json` 持久化 `{"peer":"<Board OB>","h5id":"<UUID>"}`
- SessionStart hook 自动启动 agent-daemon → 加载 peer → 发送 window-open + 欢迎消息
- CC 关闭 → Stop hook 杀 daemon + 发送 window-close
- CC 重启 → 新 PID 新窗口名 → 自动 window-open + 欢迎

**Board 关闭再打开**：
- SSE 自动重连（`EventSource` 内置）
- Cloud 恢复用户状态 → SSE 推送当前活跃窗口列表
- 历史消息从 localStorage 恢复（`ob-msgs-<window>` 持久化）

### 需求 6：Cloud 无自有 OB 身份

**Cloud 不创建全局 OB 身份**。每个 Board 用户拥有独立的 OB keypair：
- Board OB 身份在用户首次调用 `/api/my-address` 时创建
- 身份凭证持久化到 `~/.oceanbus-console/users/<uuid>/ob-identity.json`
- Cloud 重启后从磁盘恢复所有 Board OB 身份
- Agent 直接发送到 Board 的 OB 地址 → Cloud 替 Board 监听并转发 SSE

**未来扩展**：成千上万 Agent ↔ Board 会话都走独立的 Board OB 地址，Cloud 只是消息通道。架构天然支持水平扩展（多个 Cloud 实例分管不同 Board 的 OB 身份）。

---

## 4. 项目结构

```
oceanbus-console/
├── h5/                              # Board 前端（Vanilla JS SPA）
│   ├── index.html
│   ├── guide.html
│   ├── app.js                       # 身份管理、SSE、消息渲染、配对命令生成
│   └── style.css
├── cloud/                           # 多用户后端 (端口 3456)
│   └── server.js                    # OB 身份管理、HTTP API、SSE、消息路由
├── scripts/                         # Agent 侧脚本
│   ├── agent-daemon.cjs             # Agent 生命周期（start/stop/status/inbox/reply/inbox-monitor）
│   ├── reply-ob.cjs                 # 独立回复脚本（CC AI 通过 OB 回复 Board）
│   ├── mcp-server.cjs              # MCP JSON-RPC server（ob_inbox/ob_reply/ob_status/ob_ack）
│   ├── health-check.cjs             # 系统健康诊断
│   ├── version-check.cjs            # SDK/plugin 版本检查
│   └── test-all.cjs                 # 回归测试套件
├── .claude-plugin/                  # CC 插件注册
│   └── plugin.json
├── hooks/                           # CC 生命周期钩子
│   ├── hooks.json                   # Bash 版（Setup + SessionStart + Stop）
│   └── hooks-pwsh.json              # PowerShell 版（Windows 无 Git Bash）
├── skills/                          # CC AI 行为指引
│   └── oceanbus-console/
│       └── SKILL.md
└── docs/
    ├── PRD.md
    └── USER-GUIDE.md
```

---

## 5. Cloud API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 健康检查（users, boards 计数） |
| `/api/identity` | GET | 返回 Board OB openid（兼容 SDK bootstrap） |
| `/api/my-address` | GET | 创建/返回 Board 自己的 OB openid（需 h5_openid） |
| `/api/peers` | GET | 绑定 Agent 列表（需 h5_openid） |
| `/api/windows` | GET | 活跃窗口列表（需 h5_openid） |
| `/api/send` | POST | H5 发消息 `{h5_openid, window, text}` → Cloud OB send → Agent |
| `/api/events` | GET | SSE 实时推送（需 h5_openid） |

---

## 6. OB 消息协议

### 控制消息

```json
// Agent 上线（含 h5_openid 用于用户路由）
{ "action": "window-open", "window": "name", "agent_openid": "...",
  "agent_name": "...", "agent_type": "cc-window", "h5_openid": "<UUID>" }

// 心跳（含 agent_openid 用于 Cloud 重启自动恢复）
{ "action": "heartbeat", "window": "name", "agent_openid": "...",
  "newname": "可选改名", "h5_openid": "<UUID>" }

// Agent 离线
{ "action": "window-close", "window": "name", "h5_openid": "<UUID>" }
```

### 业务消息

```json
// 双向消息（from: "h5" | "agent"）
{ "action": "message", "window": "name", "text": "内容",
  "from": "h5", "time": "14:30:00", "msg_id": "h5_1", "h5_openid": "<UUID>" }

// Agent 回复
{ "action": "reply", "window": "name", "text": "回复内容",
  "from": "agent", "h5_openid": "<UUID>" }
```

---

## 7. 关键数据流

### 7.1 首次配对

```
1. Board 打开 → loadIdentity() → UUID (localStorage)
2. loadBoardObId() → GET /api/my-address?h5_openid=<UUID>
3. Cloud ensureBoardOb() → 创建 Board OB 身份 → startListening()
4. Cloud 返回 { openid: Board OB 地址 }
5. Board SSE 连接 → GET /api/events?h5_openid=<UUID>
6. 用户点「绑定 Agent」→ 生成命令:
   echo '{"peer":"<Board OB>","h5id":"<UUID>"}' > ~/.oceanbus/console-peer.json
   npx oceanbus start --peer <Board OB> --gateway-url <url> --temp-identity
7. CC AI 启动 agent-daemon
8. Agent 发送 window-open + 欢迎消息 → Board OB 地址
9. Cloud listener 收到 → 注册窗口 → SSE → Board 显示
```

### 7.2 后续自动连接

```
1. CC 窗口打开 → SessionStart hook → agent-daemon &
2. 加载全局 peer 文件 (peer + h5id)
3. 加载 per-window OB 身份 (credentials.json)
4. 发送 window-open + 欢迎 → Board OB 地址
5. Cloud listener 收到 → 注册窗口 → SSE → Board 显示
```

---

## 8. Ontology — 实体与操作

用通俗语言解释 OceanBus Console 里有什么东西，以及它们能做什么。

### 8.1 实体（Entities）

```
┌──────────────────────────────────────────────────────────────┐
│                    OceanBus Console 世界                      │
│                                                              │
│  ┌─────────┐     ┌─────────┐     ┌──────────────────────┐   │
│  │  Board  │ ←→ │  Cloud  │ ←→ │  Agent (CC 窗口)      │   │
│  │ (浏览器)│     │ (服务器) │     │ (你的电脑上的终端)    │   │
│  └─────────┘     └─────────┘     └──────────────────────┘   │
│       ↑                               ↑                      │
│       └──── OB P2P 消息 ──────────────┘                      │
│     (经过 Cloud 替 Board 收发，因为浏览器不能直接跑 OB)       │
└──────────────────────────────────────────────────────────────┘
```

| 实体 | 通俗解释 | 标识符 | 持久化位置 |
|------|---------|--------|-----------|
| **Board** | 手机/电脑浏览器打开的 H5 页面，你的控制面板 | UUID（`ob-h5-openid`） | localStorage |
| **Board OB 身份** | Board 在 OB P2P 网络里的"电话号码" | OB openid（如 `FA6UKkIA...`） | Cloud 磁盘 `users/<uuid>/ob-identity.json` |
| **Agent** | 你电脑上一个 CC 终端窗口里的后台进程 | 窗口名（如 `cc-xxx-oceanbus-8180`） | `~/.oceanbus/windows/<name>/` |
| **Agent OB 身份** | Agent 在 OB 网络里的"电话号码"（每个窗口独立） | OB openid | `credentials.json` |
| **Cloud** | 阿里云上的服务进程，替 Board 收发 OB 消息 | （无自有 OB 身份） | `sessions.json` |
| **Window** | Agent 在 Board 上的入口，一个窗口 = 一个聊天 | 窗口名 | Cloud 内存 + sessions.json |
| **Message** | Board 和 Agent 之间的一条聊天消息 | msg_id | Board: localStorage, Agent: inbox.jsonl |
| **Peer** | Agent 存的"Board 的电话号码"，知道消息发给谁 | Board OB openid | `console-peer.json` |
| **h5id** | Board 的 UUID，Agent 发消息时带上，Cloud 用它识别用户 | UUID | `console-peer.json` 的 `h5id` 字段 |

### 8.2 操作（Actions）

每个实体能做什么，用一句话解释。

#### Board（浏览器上的控制面板）

| 操作 | 触发方式 | 干了什么 |
|------|---------|---------|
| **创建身份** | 首次打开页面 | 生成 UUID → Cloud 分配 OB 身份 → 存 localStorage |
| **绑定 Agent** | 点「+ 绑定 Agent」 | 生成配对命令（含 Board OB 地址 + UUID） |
| **查看窗口** | SSE 自动推送 | 实时显示哪些 CC 窗口在线 |
| **发消息** | 输入文字回车 | POST `/api/send` → Cloud → OB → Agent |
| **收消息** | SSE 自动推送 | Agent 的消息实时出现在聊天区 |
| **切换窗口** | 点击侧栏窗口名 | 切换到该窗口的聊天记录 |
| **查看帮助** | 点 `?` | 显示使用说明 |

#### Agent（CC 窗口后台进程）

| 操作 | 子命令 / 事件 | 干了什么 |
|------|-------------|---------|
| **上线** | daemon 启动时自动 | 发 `window-open`（告诉 Board 我来了）+ 发欢迎消息 `👋 窗口名 上线了！` |
| **心跳** | 每 15 秒自动 | 发 `heartbeat`，告诉 Cloud 我还活着，顺便报告窗口名是否变了 |
| **下线** | daemon 停止时自动 | 发 `window-close`，Board 上该窗口变灰 |
| **收消息** | OB listener 自动 | 收到 Board 发的消息 → 写入 inbox.jsonl → 发自动回执 `已收到` |
| **回复消息** | `reply --text "..."` | 通过 OB 发送回复到 Board |
| **查看收件箱** | `inbox [--clear]` | 读取未处理的消息列表 |
| **清空收件箱** | `ack` | 标记所有消息已处理 |
| **查看状态** | `status [--json]` | 检查 daemon 是否在线、peer 是否绑定、收件箱消息数 |
| **实时监听** | `inbox-monitor` | 持续输出新消息 JSON 到 stdout（给 CC Monitor 用） |
| **停止** | `stop` | 杀掉 daemon 进程，清理锁文件 |

#### Cloud（服务器后台进程）

| 操作 | 触发方式 | 干了什么 |
|------|---------|---------|
| **创建 Board OB 身份** | Board 调 `/api/my-address` | 生成 OB keypair → 持久化到磁盘 → 开始监听 |
| **接收 OB 消息** | OB listener 自动 | 收到 Agent 发的消息 → 解析 `h5_openid` → 路由到正确的 Board 用户 → SSE 推送 |
| **发送 OB 消息** | Board 调 `/api/send` | 用 Board 的 OB 身份发送消息到目标 Agent |
| **注册窗口** | 收到 `window-open` | 记录窗口名 → 映射 Agent OB 地址 → SSE 通知 Board |
| **心跳处理** | 收到 `heartbeat` | 更新心跳时间 → 检测窗口改名 → Cloud 重启后自动恢复注册 |
| **注销窗口** | 收到 `window-close` | 移除窗口 → SSE 通知 Board |
| **消息转发** | 收到 `message` / `reply` | 直接 SSE 推送给 Board，不存盘 |
| **持久化状态** | 每 30 秒自动 | 保存用户 peers 和 windowAgents 到 sessions.json |
| **恢复状态** | 启动时自动 | 从 sessions.json 恢复用户数据，从磁盘恢复所有 Board OB 身份 |

### 8.3 消息流（端到端）

#### 场景 A：CC 窗口打开 → Board 看到欢迎消息

```
Agent 启动
  → ob.send(Board OB地址, { action: "window-open", h5_openid: "<UUID>" })
    → Cloud 的 Board OB listener 收到
      → 查找 users[UUID] → 注册窗口 → SSE 推 "windows" 事件
        → Board 侧栏出现新窗口 ●在线

  → ob.send(Board OB地址, { action: "message", text: "👋 窗口名 上线了！", h5_openid: "<UUID>" })
    → Cloud 的 Board OB listener 收到
      → SSE 推 "message" 事件
        → Board 聊天区显示欢迎气泡
```

#### 场景 B：Board 发消息 → Agent 收到 → CC AI 回复

```
用户在 Board 输入 "你好"
  → POST /api/send { h5_openid: "<UUID>", window: "窗口名", text: "你好" }
    → Cloud 查找 windowAgents["窗口名"] → Agent OB 地址
    → Cloud 用 Board OB 身份发送:
      ob.send(Agent OB地址, { action: "message", text: "你好", from: "h5", h5_openid: "<UUID>" })
        → Agent OB listener 收到
          → 写入 inbox.jsonl
          → 自动回复 "已收到" → Board

CC AI 调用 ob_reply --text "你好！有什么可以帮你？"
  → agent-daemon reply → ob.send(Board OB地址, { action: "reply", text: "你好！...", h5_openid: "<UUID>" })
    → Cloud listener 收到 → SSE 推 "message" 事件
      → Board 聊天区显示 Agent 回复
```

### 8.4 状态机

#### Agent 生命周期

```
  [启动] → window-open → [在线]
                             │
                    heartbeat (每15s)
                             │
                    [接收消息] ←→ [回复消息]
                             │
                    window-close → [离线]
```

#### Board 连接生命周期

```
  [打开页面] → 加载 UUID → 获取 Board OB 地址 → SSE 连接 → [在线]
                                                              │
                                              收到 window-open → [显示窗口]
                                                              │
                                              收到 message → [显示消息]
                                                              │
                                              [关闭页面] → SSE 断开 → [离线]
                                                              │
                                              [重新打开] → SSE 重连 → [在线]
                                                             (自动恢复窗口列表和历史消息)
```

#### Cloud 生命周期

```
  [启动] → 创建/加载 Cloud OB → 恢复 sessions.json → 恢复 Board OB 身份 → [就绪]
                                                                              │
                                                              收到 window-open → 注册窗口
                                                              收到 message → 转发 SSE
                                                              收到 heartbeat → 更新心跳
                                                              收到 window-close → 注销窗口
                                                                              │
                                                            [重启] → 恢复状态 → [就绪]
                                                                  (Agent heartbeat 自动重注册)
```

### 8.5 跨平台兼容性

| 平台 | Shell | 进程管理 | 窗口名获取 | 状态 |
|------|-------|---------|-----------|------|
| **macOS** | bash（`hooks.json`） | POSIX（SIGTERM/SIGKILL） | `CLAUDE_CODE_SESSION_ID` + `cwd` | ✅ 兼容 |
| **Linux** | bash（`hooks.json`） | POSIX（SIGTERM/SIGKILL） | `CLAUDE_CODE_SESSION_ID` + `cwd` | ✅ 兼容 |
| **Windows (Git Bash)** | bash（`hooks.json`） | `taskkill /T /F` | `CLAUDE_CODE_SESSION_ID` + `cwd` | ✅ 兼容 |
| **Windows (无 Git Bash)** | PowerShell（`hooks-pwsh.json`） | `taskkill /T /F` | `CLAUDE_CODE_SESSION_ID` + `cwd` | ✅ 兼容 |

**Mac 特殊考虑**：
- 深埋 `process.platform === 'win32'` 分支，非 Windows 全部走 POSIX 路径（`process.kill(pid, 0)` 探活、SIGTERM/SIGKILL 杀进程）
- 无需 `darwin` 特定代码
- bash 是 macOS 默认 shell，`hooks.json` 直接可用
- `windowName()` 使用 `process.cwd()` 和 `CLAUDE_CODE_SESSION_ID`，跨平台一致

### 8.6 消息格式说明

Agent 发出两类消息，格式不同（分别服务不同消费者）：

| 消费者 | 格式 | 示例 |
|--------|------|------|
| **CC AI（stdout JSON）** | `wechat_msg` 格式 | `{"type":"wechat_msg","chat_id":"h5","sender":"h5","text":"消息",...}` |
| **Board 用户（SSE）** | 简化格式 | `{"window":"name","text":"消息","from":"agent","time":"14:30:00"}` |

`wechat_msg` 格式是 wechat-cc 遗留格式，包含 `reply_style` 等扩展字段供 CC AI 解析。Board 只显示 `text`/`from`/`time`。两者目的不同，无需统一。

### 8.7 测试覆盖

完整的回归测试套件：`scripts/test-all.cjs`

覆盖所有 ontology action：Cloud 启动、Board 身份创建、Agent 上线(window-open)、欢迎消息、收消息(inbox)、回复(reply)、实时监听(inbox-monitor)、MCP 工具、reply-ob、持久化(sessions.json + h5id)、下线(stop + window-close)。

运行方式：
```bash
cd oceanbus-console && node scripts/test-all.cjs
```

---

## 9. 开发教训

### 8.1 OB SDK 多实例串扰

同一进程中的多个 `createOceanBus()` 实例，消息会串扰到所有 listener。**解决方案**：每个 listener 通过 `payload.h5_openid` 字段过滤，只处理自己用户的消息。同时支持 UUID 和 Board OB openid 两种 h5_openid 格式。

### 8.2 localStorage 缓存导致 Stale Peer

Board 缓存了 OB 地址后，Cloud 重启可能改变架构。**解决方案**：`loadBoardObId()` 每次都调 `/api/my-address`，不依赖 localStorage 缓存。

### 8.3 CC AI 覆盖 Peer 文件丢失 h5id

SKILL.md 的配对步骤覆盖了配对命令已写入的 peer 文件，丢失了 `h5id` 字段。**解决方案**：SKILL.md 明确指示不覆盖 peer 文件，同时 Cloud listener 支持回退路由。

### 8.4 `exportState()` 必须先 `getAddress()`

`ob.createIdentity()` 后 `openidCache = null`。必须先调 `getAddress()` 再调 `exportState()`。

### 8.5 Per-Window 凭证隔离

多窗口共享凭证会导致 OB L0 将消息投递给任一实例。**解决方案**：`~/.oceanbus/windows/<name>/credentials.json` 每窗口独立身份。
