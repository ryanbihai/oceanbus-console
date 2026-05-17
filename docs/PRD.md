# OceanBus Console PRD

> v0.2 — 多用户 H5 控制台，单一 Cloud 部署，人类 ↔ Agent 直连  
> 替代 wechat-cc，消除 iLink 依赖，基于 OB L0 P2P 架构

---

## 0. OceanBus Console 宪法

三条不可动摇的原则。所有设计决策以此为准。

### 第一条：灯塔项目

OceanBus Console 是 OceanBus 网络的应用灯塔。它必须**使用 OB 的核心能力**

严禁绕过OB，遇到问题，请参考\OceanBusDocs\test-new-oceanbus-api(1).js 

严禁绕过OB SDK，遇到问题，请参考\OceanBusDocs\sdk-test-run-all.mjs

| 能力 | 体现 |
|------|------|
| 端到端加密（E2EE） | Agent ↔ Cloud 消息经 OB E2EE 加密，Cloud 看不到明文 |
| P2P 寻址 | Agent 和 Cloud 各自拥有 OB keypair，通过 openid 直接寻址 |
| 无中心登录 | 身份 = 密钥对，无需账号/密码/手机号 |
| 离线消息 | OB mailbox 持久化，Agent 离线消息不丢失 |
| AgentCard | 每个 Agent 拥有可验证身份卡片 |
| 黄页发现 | 未来 Agent 可通过黄页互相发现 |

### 第二条：小白友好

让**不懂代码的用户**可以通过手机 H5 页面远程管理自己的 Agent。

| 原则 | 实现 |
|------|------|
| 统一动作 | 拷贝 → 粘贴，两个动作完成所有绑定 |
| 零记忆 | 不记命令、不记参数、不记地址 |
| 零输入 | 不手打 openid、不输配对码、不输入agent名称 |
| 一键连接 | CC 窗口说"npx oceanbus@latest start --peer <console openid>"即可，随后CC AI 代劳一切 |
| 即开即用 | 打开 H5 页面自动创建身份，无需注册登录 |

用户的心智模型：**Board 上点按钮 → 复制 → 到 Agent 端粘贴 → 完成。**

### 第三条：Agent 社交网络（未来）

Console 是 Agent 之间的社交入口。

| 阶段 | 能力 |
|------|------|
| 第一阶段（当前） | 人类 ↔ 自己的 Agent（H5 绑定 CC/服务器 Agent） |
| 第二阶段 | 搜索 OB 黄页，发现外部 Agent（翻译、订票、导游…） |
| 第三阶段 | Agent ↔ Agent 通信（我的助理找导游订票、找餐厅订位） |
| 第四阶段 | Agent 委托链（助理自动协商、自动完成、H5 监控流水线） |

H5 是**总控台**——不是聊天窗口，是 Agent 社交网络的管理面板。

---

## 1. 核心设计决策

### 1.1 不是账号制，是密钥制

- 用户打开 Board → 自动创建 OB keypair → 浏览器 localStorage 保存
- OB openid（64 字符）就是"用户 ID"
- 不需要注册、登录、密码、手机号
- 清除浏览器缓存 = 丢失身份，需提供"导出密钥"功能

### 1.2 多人单一 URL

```
所有用户 → https://ob.example.com → 同一个 Cloud 实例
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
  用户A的OB身份   用户B的OB身份   用户C的OB身份
  (openid:A)     (openid:B)     (openid:C)
```

Cloud 按 openid 分区：peers、windows、messages 都以用户 openid 为 key。一个人部署，所有人用。

### 1.3 绑定方式：复制粘贴命令（不是配对码）

```
Board 显示:
┌──────────────────────────────────────┐
│ npx oceanbus@latest start            │
│   --peer 8f9g0h1i2j...               │
│   --gateway-url https://ob.xxx.com   │
│                            [📋 复制] │
└──────────────────────────────────────┘

Agent 端：粘贴 → 回车 → 绑定完成
```

**为什么不用配对码？**
- 6 位、4 位、8 位……用户都要记、要输入 → 对小白不友好
- 虽然限速可防暴力，但代价仍是用户操作
- 64 字符 openid 天然安全，不需要限速兜底
- 粘贴比记忆+输入更简单

**统一性**：CC / 非 CC / 远端服务器，全部用同一个复制粘贴流程

### 1.4 CC 用户 vs 终端用户

| | CC 窗口 | 非 CC Agent |
|---|---------|------------|
| 启动方式 | 说 "连接 OB" → CC AI 全自动 | 手动复制粘贴命令 |
| peer 发现 | CC AI 从 Cloud API 获取 | Board 上的命令自带 |
| 窗口名 | CC AI 写入 `~/.oceanbus/window-name` | --name 手动指定 |
| 消息接收入站 | Monitor stdout | 自行实现 OB/HTTP 监听 |
| 消息出站 | CC AI POST /api/reply | OB send 或 HTTP |

### 1.5 出入站链路（OB P2P 唯一通信通道）

```
  消息传输 = 纯 OB P2P。HTTP 只用于两个场景：
    ① Boot 引导：Agent 启动时查一次 Cloud 的 OB 地址
    ② H5 SSE：浏览器无法做 OB P2P，Cloud 通过 SSE 推送

  H5 (手机)              Cloud                       Agent (PC)
  ─────────             ────────                    ──────────
  UUID 身份             OB 身份 (fresh)              OB 身份
                         OB listener
       │                    │                          │
       │                    │    Boot: 一次性 HTTP      │
       │                    │ ←─ GET /api/identity ────┤
       │                    │ ─→ Cloud 的 OB 地址 ──→  │
       │                    │                          │
  ┌────┴─ HTTP/SSE ────────┴──── OB P2P ─────────────┴──┐
  │                                                      │
  │  入站 (H5 → CC):                                       │
  │  H5→ 阿里云服务（OB sdk） → OB L0 → OB sdk → Agent OB monitor     │
  │                                                      │
  │  出站 (CC → H5):                                       │
  │  Agent → 阿里云服务监听 → SSE → H5             │
  │                                                      │
  │  窗口管理: OB send → Cloud OB 监听 → SSE → Board       │
  └──────────────────────────────────────────────────────┘
```

**OB 是唯一消息通道**。消息经过 OB L0：E2EE 加密、P2P 寻址、mailbox 持久化。
没有 HTTP `/api/poll`，没有 HTTP `/api/agent/announce`，没有 HTTP 消息中继。

**HTTP 仅用于**：
| 场景 | 端点 | 频率 |
|------|------|------|
| Boot 引导 | `GET /api/identity` → Cloud OB 地址 | Agent 启动时一次 |
| H5 收消息 | `GET /api/events` (SSE) | 持久连接 |
| H5 发消息 | `POST /api/send` → Cloud OB send | 每次消息 |
| H5 查询 | `GET /api/peers`, `/api/windows` | 按需 |
| CC AI 回复 | `POST /api/reply` (过渡方案) | 每次回复 |

---

## 2. 项目结构

```
oceanbus-monorepo/
├── ai-backend-template/src/apps/03-OceanBusSDK/   # OB SDK + CLI
├── oceanbus-console/
│   ├── h5/                                          # Board 前端
│   │   ├── index.html
│   │   ├── guide.html
│   │   ├── app.js
│   │   └── style.css
│   ├── cloud/                                       # 多用户后端
│   │   ├── server.js
│   │   └── package.json
│   └── docs/
│       ├── PRD.md
│       └── USER-GUIDE.md
└── skills/wechat-cc/                                # 旧项目（逐步废弃）
```

---

## 3. 多用户 Cloud 数据模型

### 3.1 按用户分区

```javascript
// 所有数据以 h5OpenId 为 key
{
  "openid_A": {
    peers: { "agentName": { openid, boundAt } },
    windows: { "windowName": { lastBeat, cwd, status } },
    messageQueues: { "windowName": [{ action, text, from, time }] }
  },
  "openid_B": { ... }
}
```

### 3.2 用户身份生命周期

```
首次打开 Board:
  → 检查 localStorage 有无 keypair
  → 没有 → 浏览器本地生成 keypair + openid
  → 存 localStorage（不清缓存永久保留）

Board 每次请求带上 h5_openid:
  → Cloud 用这个 key 查询该用户的数据
  → 不需要 session/token/login
```

### 3.3 对等绑定

```
Agent 运行 --peer <h5_openid>:
  → Agent 发 window-open announce → Cloud
  → Cloud 记录到 peers[userOpenId][agentName]
  → Cloud 添加到 windows[userOpenId][windowName]
  → SSE 广播给该用户的 H5
```

---

## 4. 窗口命名

### 4.1 优先级

```
1. --name CLI flag              # 手动覆盖
2. OCEANBUS_WINDOW_NAME env     # CC 原生注入（未来）
3. ~/.oceanbus/window-name 文件 # CC AI 写入
4. cwd basename                 # 回退
```

### 4.2 CC AI 自动命名

用户说 "连接 OB" → CC AI 完成：
1. 取窗口名（项目名或上下文推断）
2. 写入 `~/.oceanbus/window-name`
3. 从 Cloud API 获取 peer openid
4. 启动 Agent：`npx oceanbus@latest start --peer <id> --gateway-url <url>`
5. Board 自动出现窗口

### 4.3 实时改名

心跳每 15s 带当前窗口名。CC 标签改名 → Agent 心跳上报新名 → Cloud 检测 `newname` → 迁移条目 → SSE 推 Board。

---

## 5. Cloud API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 健康检查 |
| `/api/identity` | GET | Cloud 自身的 OB openid |
| `/api/peers` | GET | 当前用户的绑定 Agent 列表（需 h5_openid） |
| `/api/windows` | GET | 当前用户的活跃窗口 |
| `/api/send` | POST | H5 发消息给 Agent {h5_openid, window, text} |
| `/api/reply` | POST | CC AI 回复 {window, text} |
| `/api/poll` | GET | **已废弃**（Agent 改用 OB listener） |
| `/api/agent/announce` | POST | **已废弃**（窗口管理走 OB） |
| `/api/events` | GET | SSE 实时推送 |

**OB 消息模式**（替代 HTTP poll 和 announce）：

| 方向 | OB action | Cloud 处理 |
|------|-----------|-----------|
| Agent → Cloud | `window-open` | OB listener → 注册窗口 → SSE 推 Board |
| Agent → Cloud | `heartbeat` | OB listener → 更新心跳 + 改名检测 |
| Agent → Cloud | `window-close` | OB listener → 移除窗口 → SSE |
| Agent → Cloud | `reply` / `message` | OB listener → SSE 推 H5 |
| Cloud → Agent | `message` | `/api/send` → Cloud OB send → Agent OB listener |

---

## 6. 消息格式

```json
// 标准消息
{ "action": "message", "window": "name", "text": "内容",
  "from": "h5|agent", "time": "14:30:00", "msg_id": "h5_1" }

// 控制消息
{ "action": "window-open",  "window": "name" }
{ "action": "window-close", "window": "name" }
{ "action": "heartbeat",    "window": "name", "newname": "新名" }
```

---

## 7. 待决策 / 待实现

| 议题 | 状态 |
|------|------|
| 阿里云部署 | 待部署 |
| OB 直连 H5（Web Crypto）| 后续——当前 Cloud 代理 OB |
| A2A（Agent 间通信）| 第二阶段 |
| 语音能力 | 后续通过小程序 |
| Board→CC 窗口改名 | 等 CC 支持编程式改标签 |
| CC AI 出站走 OB（去掉 /api/reply）| Agent stdin 桥接到 CC AI |

---

## 8. 开发教训（2026-05-17）

### 8.1 OB listener 不工作？先检查 SDK 版本

**现象**：`ob.send()` 返回成功，L0 信箱有消息（原始 API sync 验证通过），但 `ob.startListening()` 收不到。

**根因**：Cloud 的 node_modules 装的是 npm 旧版 oceanbus v0.9.1，listener 有 bug。本地 SDK dist 测过了但云端没更新。

**教训**：
- 任何 OB 通信问题，第一步：`npm ls oceanbus` 检查版本
- 每次改 SDK 后必须 `npm publish` + Cloud 端 `npm install oceanbus@latest`
- 不要假设 `npm install` 装的是最新版（除非显式指定 `@latest`）

### 8.2 窗口命名：共享文件 = 多窗口地狱

**现象**：两个 CC 窗口启动 Agent，Board 上只显示一个。因为都用 `~/.oceanbus/window-name`，后者覆盖前者。

**根因**：单文件无法区分多个窗口。

**修复**：`cwd-basename-PID` 自动生成唯一名。去掉文件依赖。

**教训**：涉及"多实例"的场景，永远不要用全局可变的共享资源做身份标识。用 PID、时间戳、或 UUID 自动生成唯一 ID。

### 8.3 OB 消息过滤：控制消息不能泄漏到用户界面

**现象**：CC 会话收到空文本消息，`chat_id` 是 Cloud 的 OB 地址。

**根因**：Agent 的 OB listener 把所有 OB 消息（包括心跳、窗口管理等控制消息）都 emit 到了 stdout。

**修复**：只 emit `action === 'message' | 'reply' | 'command'` 且有 `text` 的消息。

**教训**：P2P 链路上同时跑用户消息和控制消息。消费端必须按 `action` 字段过滤，否则心跳和窗口管理会污染用户 UI。

### 8.4 `npx oceanbus start` 是持久进程，CC 内必须用 Monitor

**现象**：CC 窗口直接运行命令后卡住不动。

**根因**：`oceanbus start` 的 `await new Promise(() => {})` 永久阻塞。CC 直接运行会等它结束（永远不会）。

**修复**：CLAUDE.md 流程 H 规定 CC AI 必须用 Monitor 工具启动。

**教训**：任何持久监听进程，在 CC 内必须走 Monitor。CLAUDE.md 中的流程必须写死这一点。

### 8.5 进程残留：多轮调试会累积僵尸 Agent

**现象**：一次性杀掉 11 个 `oceanbus start` 进程。

**根因**：每次重启 Cloud 时杀 `Get-Process node`，但旧 Agent 在不同窗口/终端，不在同一个 node 进程池。

**教训**：
- `oceanbus start` 退出时应主动发 `window-close` 并清理
- Cloud 的心跳超时（30s）可以自动标记离线，但不杀进程
- 未来考虑 Agent PID 文件，让 Cloud 可检测僵尸窗口

### 8.6 僵尸进程的三层根因 + 三层防御（2026-05-17）

**现象**：H5 Board 发消息，Monitor 收不到。API 直接调用却能收到。重启 Cloud 后短暂可用，随即再次失效。

**排查过程**：
1. 怀疑 agent.ts 的 OB listener filter 太窄（只处理 `command`，不处理 `message`）→ 修复后仍未解决
2. 怀疑 npx 缓存了旧版 oceanbus SDK → 检查后发现 v0.10.10 代码正确
3. 用本地源码直跑 Agent → 测试消息到达，但用户从 Board 发的消息仍未到
4. 检查进程列表 → 发现 **6 个 oceanbus 僵尸进程**同时运行

**三层根因**：

| 层次 | 根因 | 机制 |
|------|------|------|
| 1 | Monitor TaskStop 杀不死子进程 | `await new Promise(() => {})` 永久阻塞，shell 被杀后 node 变孤儿 |
| 2 | 多实例共享同一 OB 身份 | 所有 Agent 读 `~/.oceanbus/credentials.json`，同一 openid。OB L0 投递时任一实例可消费，僵尸抢走消息 |
| 3 | npx 缓存锁定旧版本 | `npx oceanbus@latest` 首次下载后不再更新，旧代码持续运行 |

**三层防御**：

| 层次 | 位置 | 机制 |
|------|------|------|
| L1 | CLAUDE.md 流程 H 步骤 6 | CC AI 每次启动前：`Get-Process node \| match oceanbus \| Stop-Process` + 清 npx 缓存 |
| L2 | `start.ts` `killExistingInstances()` | Agent 启动时自动杀其他 oceanbus start 进程（同平台适配 Win/Mac/Linux） |
| L3 | Cloud `server.js` 心跳超时 | 30s 无心跳 → 标记离线 → Board 隐藏（已有，无需改动） |

**教训**：
- 持久进程在 Monitor 内运行时，子进程生命周期必须显式管理。不能依赖 Monitor 自动清理
- 共享资源（OB 身份、端口、PID 文件）必须做互斥检测。多实例不是"高可用"，是"互相干扰"
- `npx` 缓存是双刃剑：加速启动但也锁定版本。对于频繁更新的 CLI，考虑用本地源码或加 `--no-cache` 标志
- 排查"有时通有时不通"的问题，第一步查进程数（`ps \| grep` 或 `Get-Process`），不要先怀疑代码逻辑