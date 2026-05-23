# OceanBus Console — 用户指引

> 手机上控制 Claude Code 窗口。一次配对，永久自动连接。

---

## 这是什么

在手机上发消息给你的 CC 窗口、收回复、看窗口在线状态。

**你不需要**：记命令、扫码、登录、注册。

---

## 第一步：安装（做一次，2 分钟）

### 1. 安装 CC 插件

在 Claude Code 里输入：

```
/plugin install oceanbus-console@oceanbus-plugins
```

### 2. 安装 SDK

打开终端，运行：

```
npm install -g oceanbus@latest
```

**完成。** 以后每个 CC 窗口打开时，OceanBus 自动启动。

---

## 第二步：配对（做一次）

### 1. 打开手机 Board

手机浏览器打开你的 Board 地址（例如 Cloud 部署后的地址）。

Board 自动创建你的身份——**无需登录**。

### 2. 复制命令

点 **+ 绑定 Agent** → 点 **📋 复制**

### 3. 粘贴到 CC，回车

回到 CC 窗口，粘贴，回车。

**完成！** Board 上立刻出现你的 CC 窗口 ●在线，Agent 还会向你打招呼。

> 命令格式：`npx oceanbus@latest start --peer <board-openid>`
> 只有一个参数，没有 URL。npx 自动下载 SDK。

---

## 之后：零操作

- 开任何 CC 窗口 → Board 自动出现新窗口
- 换项目、换电脑 → 同样自动连接
- 不需要再粘贴任何东西

---

## H5 → CC（发消息）

在 Board 上选择窗口，输入消息，发送。

CC AI 自动检查收件箱并处理。

## CC → H5（回复）

CC AI 自动调用 MCP 工具或命令行回复消息。

---

## 常见问题

### 需要登录吗？
不需要。身份自动创建。

### 一个 Board 能控制多个 CC 窗口吗？
能。每个窗口自动上线。

### 多台电脑？
每台安装一次 SDK + 插件。配对一次，所有电脑的所有窗口自动连接。

### 消息安全吗？
端到端加密（OB E2EE）。Cloud 看不到消息内容。

### Cloud 需要一直在运行吗？
是的。Cloud 是消息中转站。建议部署到服务器（阿里云 ECS）并保持运行。
