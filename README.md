# OceanBus Console

手机上控制 Claude Code 窗口。发消息、收回复、看在线状态。

**核心体验**：一生配对一次。之后所有 CC 窗口自动连接，零操作。

---

## 安装（2 分钟）

### 1. 安装 SDK

```bash
npm install -g oceanbus@latest
```

### 2. 安装 CC 插件

在 Claude Code 中输入：

```
/plugin install oceanbus-console@oceanbus-plugins
```

**完成。** 之后每个 CC 窗口打开时，OceanBus Agent 自动在后台启动。

### 手动安装（插件市场不可用时）

```bash
# 克隆仓库
git clone https://github.com/ryanbihai/oceanbus-console.git ~/.claude/plugins/oceanbus-console

# 注册插件：编辑 ~/.claude/settings.json，在 enabledPlugins 中添加：
#   "oceanbus-console": true
```

> 插件市场条目待创建。目前请使用手动安装方式。

---

## 首次使用（一个项目一次）

### 1. 启动 Cloud

```bash
cd oceanbus-console
node cloud/server.js
```

Cloud 在 `http://localhost:3456` 启动。

> 部署到服务器：将 Cloud 部署到阿里云 ECS 等，通过 `OB_CONSOLE_PORT=80` 和 nginx 反代使用。

### 2. 打开 H5 Board

手机浏览器打开 `http://localhost:3456`（或你的 Cloud 地址）。

Board 自动创建身份——无需登录。

### 3. 配对

点 **+ 绑定 Agent** → 点 **📋 复制** → 回到 CC 粘贴 → 回车。

**完成。** Board 上出现窗口 ●在线。

> 之后同项目所有 CC 窗口自动连接。换项目也自动连接（全局 peer 已保存）。

---

## 日常使用

### H5 → CC

手机发消息 → CC AI 自动收。

### CC → H5

CC AI 调 `ob_reply` 工具回复，或运行：

```bash
node scripts/agent-daemon.cjs reply --text "回复内容"
```

### 查看消息

```bash
node scripts/agent-daemon.cjs inbox       # 查看
node scripts/agent-daemon.cjs inbox --clear  # 查看并清空
node scripts/agent-daemon.cjs ack          # 清空
```

### 查看状态

```bash
node scripts/agent-daemon.cjs status
```

---

## 常见问题

**需要登录吗？** 不需要。密钥即身份。

**消息安全吗？** 端到端加密。Cloud 看不到内容。

**Cloud 必须一直运行吗？** 是的。Cloud 是 Agent ↔ Board 的消息中转站。建议部署到服务器或使用 PM2 守护。

**多台电脑？** 每台电脑安装 SDK + 插件。首次配对后全部自动连接。

**换手机？** 新手机打开 Board 创建新身份，重新配对一次（全局 peer 更新）。

---

## 项目结构

```
oceanbus-console/
├── h5/                  # Board 前端 (HTML/JS/CSS)
├── cloud/               # 多用户后端 (端口 3456)
│   └── server.js
├── scripts/             # Agent 侧
│   ├── agent-daemon.cjs # Agent 生命周期管理
│   ├── reply-ob.cjs     # 回复脚本
│   ├── mcp-server.cjs   # MCP 工具包装
│   └── test-all.cjs     # 回归测试
├── hooks/               # CC 生命周期钩子
├── skills/              # CC Skill（自动发现）
└── docs/                # 文档
```
