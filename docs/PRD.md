# OceanBus Console PRD

> v0.1 — 第一阶段：人类 ↔ Agent 直连  
> 替代 wechat-cc，消除 iLink 依赖，基于 OB L0 纯 P2P 架构

---

## 1. 项目定位与名称

### 1.1 是什么

OceanBus Console 是 OceanBus 网络的 **人类控制台**。它让用户通过手机 H5 页面管理自己的 Agent、与 Agent 对话、监控 Agent 间通信（未来）。

### 1.2 为什么替代 wechat-cc

| wechat-cc | OceanBus Console |
|-----------|-----------------|
| iLink 长轮询（token 过期、session 恢复） | ❌ 去掉 |
| 二维码扫码登录（7天过期） | ❌ 去掉 |
| Board/微信双路同步 | ❌ 去掉 |
| Gateway 路由表（stale rt bug） | ❌ 去掉 |
| `/prefix` 文本路由 | ❌ 去掉 |
| MCP 桥接（mcp-gw.js） | ❌ 去掉 |
| OB P2P 直连 | ✅ 保留 |
| 多窗口自动感知 | ✅ 新增 |
| 窗口标签即 Agent 名 | ✅ 新增 |

### 1.3 命名

- **项目**：`oceanbus-console`
- **前端 H5**：OceanBus Console（用户看）
- **后端服务**：OceanBus Cloud API（机器看）
- **SDK CLI**：`npx oceanbus`（现有，新增 `init` / `start` 子命令）

---

## 2. 项目结构

```
oceanbus-monorepo/
├── ai-backend-template/src/apps/03-OceanBusSDK/   # 现有 SDK（加 CLI 子命令）
├── oceanbus-console/                                # 本项目
│   ├── h5/                                          # 前端 H5 页面
│   │   ├── index.html                               # 主控制台
│   │   ├── guide.html                               # 用户指引（新手引导）
│   │   ├── app.js                                   # H5 逻辑
│   │   └── style.css                                # 样式
│   ├── cloud/                                       # 后端 API（部署到阿里云）
│   │   ├── server.js                                # 主服务
│   │   ├── package.json
│   │   └── deploy/                                  # 部署脚本
│   └── docs/
│       ├── PRD.md                                   # 本文档
│       └── USER-GUIDE.md                            # 用户指引（H5 内置）
└── skills/wechat-cc/                                # 旧项目（逐步废弃）
```

### 2.1 为何三个子项目

| 子项目 | 定位 | 部署位置 |
|--------|------|---------|
| SDK (`03-OceanBusSDK`) | P2P 通信层，CLI 工具 | npm registry |
| H5 (`oceanbus-console/h5`) | 用户控制台 | 阿里云（静态托管） |
| Cloud (`oceanbus-console/cloud`) | 配对 API、窗口管理、H5 宿主 | 阿里云 ECS |

**三者关系**：

```
SDK  ←──────── 纯 P2P ────────→  Cloud（OB 测）
  │                                │
  │ CLI: npx oceanbus start        │ HTTP: 配对码、H5 托管
  │                                │
  ▼                                ▼
CC 窗口（桌面）                手机浏览器（H5）
                                    │
                              OB P2P ←→ CC 窗口
```

SDK 和 Cloud 之间没有直接依赖。它们通过 OB L0 通信。Cloud 额外提供 HTTP API 用于配对码发放（轻量，约 100 行）。

---

## 3. 核心概念

### 3.1 实体层级

```
OB 身份（机器级，持久）
  └── 窗口（瞬态，自动命名）
```

| 概念 | 是什么 | 创建 | 销毁 |
|------|--------|------|------|
| OB 身份 | 一台机器/一个用户的 P2P 地址 | `npx oceanbus init` | 删除凭据文件 |
| 窗口 | CC 的一个标签页 | 启动 CLI | 关闭窗口 |
| H5 会话 | 手机浏览器的一个标签页 | 打开 H5 | 关闭标签页/清缓存 |

### 3.2 窗口名 = CC 标签名

不推导、不配置、不碰撞。CC 启动时注入 `OCEANBUS_WINDOW_NAME` 环境变量，值为当前窗口标签显示名。CLI 直接读取。

```
窗口:     "oceanbus"      "小龙虾"      "oceanbus-docs"
标签:      oceanbus        小龙虾        oceanbus-docs
H5 列表:   💻 oceanbus     🦞 小龙虾     📝 oceanbus-docs
```

**用户心智模型**：H5 上的窗口列表 = CC 标签栏的镜像。

---

## 4. 通信架构

### 4.1 入站（H5 → CC 窗口）

```
H5                          Cloud                        CC 窗口
│                             │                             │
│  用户在 H5 输入消息          │                             │
│  ↓                          │                             │
│  ob.send(peer, {             │                             │
│    window: "oceanbus",       │                             │
│    text: "审核代码"           │                             │
│  })                          │                             │
│  ─────────── OB L0 ───────────────────────────→           │
│                             │            CC 的 OB 身份接收  │
│                             │            ↓                 │
│                             │      检查 msg.window          │
│                             │      === "oceanbus"? ✓       │
│                             │      ↓                       │
│                             │      stdout JSON             │
│                             │      ↓                       │
│                             │      Monitor → CC 会话       │
```

### 4.2 出站（CC 窗口 → H5）

```
CC 窗口                       Cloud                          H5
│                             │                             │
│  CC AI 回复                  │                             │
│  ↓                          │                             │
│  stdin JSON                 │                             │
│  ↓                          │                             │
│  ob.send(h5Peer, {           │                             │
│    window: "oceanbus",       │                             │
│    text: "审核结果...",       │                             │
│    from: "cc"               │                             │
│  })                          │                             │
│  ─────────── OB L0 ───────────────────────────→           │
│                             │         H5 的 OB 身份接收     │
│                             │         ↓                    │
│                             │   检查 msg.window             │
│                             │   === "oceanbus"? ✓          │
│                             │   ↓                          │
│                             │   渲染到对应对话区             │
```

### 4.3 Cloud 的角色

Cloud **不参与消息路由**。Cloud 提供两个薄服务：

```
1. HTTP: H5 页面托管（静态文件）
2. HTTP: 配对码 API（创建/查询配对码）
3. OB: 自身 OB 身份（用于与 CC 建立首次联系）
```

消息流转完全走 OB L0 P2P，Cloud 看不到明文。

---

## 5. 配对绑定流程

### 5.1 首次绑定

```
Step 1 — CC 侧
  npx oceanbus init
  → 创建 ~/.oceanbus/credentials.json
  → 输出:
    ┌──────────────────────────────────┐
    │  ✅ OceanBus 身份已创建            │
    │                                  │
    │  你的 OB 地址:                     │
    │  0xQj0YjOsZ5QjHO3qtM2dY5i6p...  │
    │                                  │
    │  [📋 复制]                        │
    │                                  │
    │  下一步: 在 H5 上绑定此地址         │
    └──────────────────────────────────┘

Step 2 — H5 侧
  用户打开 https://ob.console
  → 自动创建 H5 OB 身份
  → 显示:
    ┌──────────────────────────────────┐
    │  🔗 绑定 Agent                    │
    │                                  │
    │  粘贴 Agent 的 OB 地址:            │
    │  ┌──────────────────────────┐    │
    │  │ 0xQj0YjOsZ...            │    │
    │  └──────────────────────────┘    │
    │  [绑定]                           │
    │                                  │
    │  — 或者让 Agent 运行 —             │
    │  ┌──────────────────────────┐    │
    │  │ npx oceanbus start \     │    │
    │  │   --peer 8f9g0h1i2j...  │    │
    │  └──────────────────────────┘    │
    │  [📋 复制命令]                    │
    └──────────────────────────────────┘

Step 3 — 确认
  → 绑定方发送 OB announce
  → 对方收到 → 回确认
  → 双方显示 "✅ 已连接"
```

### 5.2 配对码（简化方案）

```
H5 点击"生成配对码"
  → Cloud API: POST /api/pairing → { code: "A8X2K9" }
  → H5 显示:
    ┌──────────────────────────────────┐
    │  配对码: A8X2K9                   │
    │  10 分钟内有效                     │
    │                                  │
    │  Agent 运行:                       │
    │  ┌──────────────────────────┐    │
    │  │ npx oceanbus start \     │    │
    │  │   --code A8X2K9          │    │
    │  └──────────────────────────┘    │
    │  [📋 复制命令]                    │
    └──────────────────────────────────┘

Agent 侧:
  npx oceanbus start --code A8X2K9
  → CLI 调用 GET /api/pairing/A8X2K9
  → 获得 H5 的 OB 地址
  → OB announce → 绑定完成
  → CLI 输出: "✅ 已连接到 H5 (8f9g0...)"
```

**配对码优于裸地址**：6 位短码 vs 64 位 hex，可读，有时效。

---

## 6. 窗口生命周期

### 6.1 窗口打开

```
CC 窗口启动:
  → npx oceanbus start
  → 自动读取 OCEANBUS_WINDOW_NAME
  → ob.send(h5Peer, {
       type: "window-open",
       window: "oceanbus",
       cwd: "/projects/oceanbus",
     })
  → 开始监听 OB 消息
```

### 6.2 窗口关闭

```
正常关闭 (Ctrl+C / 退出):
  → try: ob.send(h5Peer, { type: "window-close", window: "oceanbus" })
  → process.exit(0)

异常关闭 (强杀 / 进程崩溃):
  → 发不出 window-close
  → H5 心跳超时 30s → 自动标记离线
```

### 6.3 心跳

```
CC 窗口每 15s:
  → ob.send(h5Peer, { type: "heartbeat", window: "oceanbus" })

H5 维护:
  activeWindows.set("oceanbus", { lastBeat: Date.now(), ... })

每 30s 扫描:
  → Date.now() - lastBeat > 30s → 标记离线
  → 从不活跃列表移除 → UI 灰显
```

---

## 7. H5 控制台 UX

### 7.1 主界面

```
┌── OceanBus Console ────────────────────────────────────────┐
│                                                            │
│  🖥 我的 Agent (0xQj0...YjOsZ)  ●在线                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 💻 oceanbus       ●在线  /projects/oceanbus          │   │
│  │ 📝 oceanbus-docs  ●在线  /projects/oceanbus          │   │
│  │ 🦞 小龙虾         ○5分钟前 /projects/seafood         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  ┌── 对话: 💻 oceanbus ────────────────────────────────┐   │
│  │                                                     │   │
│  │  [H5] 请代码审核一下 index.html           14:30      │   │
│  │  [CC] 已审核，发现 3 个问题：...            14:31    │   │
│  │  [H5] 好的，请修复                               │   │
│  │                                                     │   │
│  │  ┌──────────────────────────────────────┐ [发送] │   │
│  │  │ 输入消息...                           │        │   │
│  │  └──────────────────────────────────────┘        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  [我的 Agent] [🔗 绑定新 Agent] [❓ 帮助]                    │
└────────────────────────────────────────────────────────────┘
```

### 7.2 帮助/引导页 (`guide.html`)

内置在 H5 中，用户首次打开时显示：

```
┌── 欢迎使用 OceanBus Console ──────────────────────────────┐
│                                                            │
│  🚀 三步开始                                               │
│                                                            │
│  1. 在 CC 窗口运行:                                         │
│     ┌─────────────────────────────────────────────────┐    │
│     │ npx oceanbus init                               │    │
│     └─────────────────────────────────────────────────┘    │
│     复制输出的 OB 地址                                      │
│                                                            │
│  2. 在下方粘贴 OB 地址，点击绑定                              │
│     ┌─────────────────────────────────────────────────┐    │
│     │ [_______________]  [绑定]                       │    │
│     └─────────────────────────────────────────────────┘    │
│                                                            │
│  3. CC 窗口运行:                                             │
│     ┌─────────────────────────────────────────────────┐    │
│     │ npx oceanbus start                              │    │
│     └─────────────────────────────────────────────────┘    │
│     窗口会自动出现在左侧列表                                   │
│                                                            │
│  ❓ 什么是 OB 地址？                                         │
│     OB 地址是你的 Agent 在 OceanBus 网络上的唯一标识。       │
│     知道你的 OB 地址 = 可以发消息给你（不能读你的消息）。      │
│                                                            │
│  ❓ 需要登录吗？                                             │
│     不需要。OB 身份就是你的账号。清除浏览器缓存会丢失身份。    │
│     建议绑定后立即 [📥 导出密钥]。                            │
└────────────────────────────────────────────────────────────┘
```

### 7.3 状态指示

| 状态 | 图标 | 含义 | 条件 |
|------|------|------|------|
| 在线 | ● 绿 | 活跃，可收发 | 心跳 < 30s |
| 离线 | ○ 灰 | 窗口关闭或断连 | 心跳超时 |
| 连接中 | ◐ 黄 | 绑定进行中 | announce 已发，未确认 |

---

## 8. Cloud API 设计

### 8.1 端点

```
POST   /api/pairing              → 创建配对码（返回 code + h5Peak）
GET    /api/pairing/:code        → 查询配对码（返回 h5Peak，一次性消费）
GET    /api/status               → Cloud 健康检查
```

### 8.2 配对码数据结构

```javascript
// 内存 Map，不持久化
{
  "A8X2K9": {
    h5OpenId: "8f9g0h1i2j...",    // H5 的 OB 地址
    expiresAt: Date.now() + 600000, // 10 分钟
    used: false
  }
}
```

### 8.3 技术栈

```
Node.js + Express（或裸 http.Server）
不需要数据库（配对码内存存储）
OB SDK（用于 Cloud 自身的 OB 身份）
```

---

## 9. SDK CLI 扩展

### 9.1 新增子命令

| 命令 | 作用 | 使用场景 |
|------|------|---------|
| `npx oceanbus init` | 创建 OB 身份，保存到 ~/.oceanbus/ | 首次使用 |
| `npx oceanbus start` | 启动监听，自动检测 CC 环境 | 每次打开 CC 窗口 |
| `npx oceanbus start --code X` | 启动监听 + 配对码绑定 | 首次绑定 H5 |
| `npx oceanbus start --peer X` | 启动监听 + 直接绑定 | 已知对方地址 |

### 9.2 `start` 自动行为

```
1. 加载 ~/.oceanbus/credentials.json
2. 检测 CC 环境:
   - 如果 CLARDE_CODE_SESSION_ID 存在 → CC 模式
   - stdout 输出 Monitor JSON 格式
3. 读取 OCEANBUS_WINDOW_NAME（CC 注入）作为窗口名
4. 加载 peer 列表（已配对的 H5 地址）
5. 向所有 peer 发 window-open announce
6. 开始 OB 监听 + 心跳定时器
7. stdin 监听 CC AI 回复 → OB send 到 H5
```

### 9.3 凭据文件

```json
// ~/.oceanbus/credentials.json
{
  "agent_id": "...",
  "api_key": "...",
  "openid": "0xQj0YjOsZ5QjHO3qtM2dY5i6p...",
  "created_at": "2026-05-17T08:00:00Z",
  "peers": {
    "h5": "8f9g0h1i2j3k4l5m6n7o8p9q0r..."
  }
}
```

---

## 10. 消息格式

### 10.1 标准消息信封

```json
{
  "action": "message",
  "window": "oceanbus",
  "text": "消息内容",
  "from": "h5",
  "time": "2026-05-17T08:01:00Z",
  "msg_id": "m_12345"
}
```

### 10.2 控制消息

```json
// 窗口打开
{ "action": "window-open",  "window": "oceanbus", "cwd": "/projects/oceanbus" }

// 窗口关闭
{ "action": "window-close", "window": "oceanbus" }

// 心跳
{ "action": "heartbeat",    "window": "oceanbus" }

// 绑定确认
{ "action": "bound",        "peer_openid": "0xQj0..." }
```

### 10.3 CC stdin/stdout 协议

```
// stdout（Agent → CC AI）：
{ "type": "wechat_msg",           // 保持兼容旧协议
  "chat_id": "h5",                // 来源标识
  "text": "请审核代码",
  "window": "oceanbus",           // 新增
  "time": "14:30:00",
  "reply_style": "detailed" }

// stdin（CC AI → Agent）：
{ "type": "reply",
  "window": "oceanbus",           // 回给哪个窗口
  "to": "h5",                     // 目标 peer
  "text": "审核结果..." }
```

---

## 11. 迁移路径

### 11.1 从 wechat-cc 到 OceanBus Console

| 阶段 | 行动 |
|------|------|
| **现在** | OceanBus Console 与 wechat-cc 并行运行 |
| **H5 可用后** | 新用户直接用 H5，老用户可选择迁移 |
| **稳定后** | wechat-cc skill 标记 deprecated |
| **最终** | 移除 iLink/wechat-cc 代码 |

### 11.2 保留的资产

| 资产 | 去向 |
|------|------|
| OB SDK (`03-OceanBusSDK`) | 保留，加 CLI 子命令 |
| OceanBus 发布指南 | 保留（SDK 发布流程不变） |
| wechat-cc 教训总结 | 归档到 docs/lessons-learned/ |
| Board HTML (`ob-dashboard.html`) | H5 重写，不复用 |
| MCP 桥接 (`mcp-gw.js`) | 废弃 |
| Gateway (`index.ts`) | 废弃 |

---

## 12. 待决策

| 议题 | 状态 |
|------|------|
| H5 域名 | `ob.console` 或嵌入现有站点 |
| Cloud 阿里云部署 | 复用现有 ECS 还是新实例 |
| SDK CLI `--cc` 检测机制 | 通过环境变量自动检测 |
| 窗口名来源 | `OCEANBUS_WINDOW_NAME` 由 CC 注入 |
| 语音能力 | 第一期不做，未来可通过小程序补充 |
