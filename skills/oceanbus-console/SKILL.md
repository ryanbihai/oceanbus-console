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

## 手动安装（daemon 不存在时）

指引用户：
1. `npm install -g oceanbus@latest`
2. 安装 CC 插件：`/plugin install oceanbus-console@oceanbus-plugins`
3. 或克隆仓库手动安装（见 README.md）
