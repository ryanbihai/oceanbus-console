---
name: oceanbus-console
description: OceanBus Console H5 Board 消息处理 — inbox 检查、消息回复、Agent 状态管理、首次配对
---

# OceanBus Console

OceanBus agent daemon 在后台自动运行。通过子命令与 daemon 交互。

> 脚本路径：`<oceanbus-console>/scripts/agent-daemon.cjs`
> 如未安装，见 README.md 安装指引。

## 命令速查

```bash
# 查看状态
node agent-daemon.cjs status --json
# → {"online":true,"window":"cc-xxx-oceanbus-12345","peer":"bound","inbox":3}

# 读取待处理 H5 消息
node agent-daemon.cjs inbox
# → [{"sender":"h5","text":"你好","time":"14:30:00"}]

# 读取并清空
node agent-daemon.cjs inbox --clear

# 清空收件箱
node agent-daemon.cjs ack

# 回复消息（通过 OB 发送到 H5 Board）
node agent-daemon.cjs reply --text "回复内容"

# 停止 daemon
node agent-daemon.cjs stop

# 实时监听 Board 新消息（用 Monitor 运行）
node agent-daemon.cjs inbox-monitor
# → 持续输出新消息 JSON 到 stdout，CC AI 可实时接收
```

## 首次配对

当用户粘贴 `npx oceanbus@latest start --peer <uuid> --gateway-url <url>` 时：

1. 停止现有 daemon：`node agent-daemon.cjs stop`
2. 将 peer 写入项目文件和全局文件：
   ```bash
   # 项目级
   echo '{"peer":"<uuid>","savedAt":"..."}' > .ob-console-peer.json
   # 全局（之后所有项目自动连接，零操作）
   echo '{"peer":"<uuid>","savedAt":"..."}' > ~/.oceanbus/console-peer.json
   ```
3. 保存 gateway URL：同上写入 `.ob-console-gateway.json` 和 `~/.oceanbus/console-gateway.json`
4. 后台启动 daemon：`node agent-daemon.cjs &`
5. 验证：`node agent-daemon.cjs status` → online

## 之后每次

daemon 自动从项目或全局文件加载 peer → **零操作**。

## 实时接收 Board 消息

**推荐方式**：当 `status` 显示 `peer: bound` 且 `inbox > 0` 时，用 Monitor 运行 inbox-monitor：

```bash
node agent-daemon.cjs inbox-monitor
```

Monitor 会持续推送 Board 新消息到 CC 上下文，格式为：
```json
{"type":"wechat_msg","chat_id":"h5","sender":"h5","text":"消息内容","window":"窗口名","time":"20:25:56","reply_style":"detailed"}
```

收到消息后，CC AI 可以直接分析内容并用 `reply` 命令回复：
```bash
node agent-daemon.cjs reply --text "回复内容"
```

**轮询方式**（无需 Monitor）：用户说"查看 OceanBus 消息"时，调用 `inbox` 读取：
```bash
node agent-daemon.cjs inbox --clear
```

## 手动安装（daemon 不存在时）

指引用户：
1. `npm install -g oceanbus@latest`
2. 安装 CC 插件：`/plugin install oceanbus-console@oceanbus-plugins`
3. 或克隆仓库手动安装（见 README.md）
