# OceanBus Console — 产品经理 UX 审查

> 遍历全部用户触点，标记痛点和优化建议。

---

## 触点 1：安装 🔴 高痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 需要两步（plugin + npm） | 中 | 未来提供一条命令安装 |
| plugin 不在 marketplace | 高 | 独立 git repo + marketplace.json 条目 |
| 无安装验证 | 中 | 安装后 `status` 自动确认 daemon 在线 |

## 触点 2：首次打开 H5 Board 🔴 高痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 用户不知道 Board URL | 高 | SessionStart context hook 输出 Board URL |
| Cloud 可能没运行 | 高 | 检测 Cloud 可达性；如不可达提示 `node cloud/server.js` |
| guide.html 内容过时（`npx oceanbus init`） | 高 | 更新为当前流程 |

## 触点 3：首次配对 🟡 中痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 命令格式是旧 `npx oceanbus start` | 低 | 保留向后兼容；SKILL.md 处理转换 |
| 粘贴后无即时反馈 | 中 | H5 加 pairing SSE 事件 + 动画（"等待CC连接..."→"已连接!"） |
| guide.html 提到 `npx oceanbus init`（已废弃） | 中 | 删除 init 步骤，简化 guide |

## 触点 4：daemon 静默运行 🟡 中痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 启动/停止均无用户可见反馈 | 中 | CC 状态栏集成（ob_status → 未读消息数） |
| status 输出是 JSON，小白看不懂 | 低 | status --text 模式给人看，--json 给 AI 用 |
| 错误静默（Cloud 不可达、no peer） | 高 | 关键错误写醒目 stderr |

## 触点 5：消息流 🟡 中痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 消息送达有延迟（OB polling） | 中 | 文档说明延迟原因 |
| 无"已读"确认（H5 侧） | 低 | H5 收到 auto-ack 后显示 ✓✓ |
| inbox 消息格式遗留命名 `wechat_msg` | 低 | 改为 `h5_msg` |

## 触点 6：窗口管理 🟢 低痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 离线窗口停留 60s 才消失 | 低 | 优化超时逻辑（30s 离线、60s 移除） |
| 窗口名不直观（`cc-xxx-oceanbus-12345`） | 低 | 只显示项目名部分，CC session ID 前缀隐藏 |

## 触点 7：跨项目 🟢 零痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 无。全局 peer 自动生效。 | — | — |

## 触点 8：错误恢复 🔴 高痛

| 问题 | 严重度 | 建议 |
|------|--------|------|
| OB L0 不可达：daemon 静默失败 | 高 | 启动时验证 L0 连通性 |
| Cloud 重启 OB 身份丢失 | 高 | **已修复**（cloud-identity.json 持久化） |
| credentials 文件损坏 | 中 | 检测 + 自动重建 |
| 多 daemon 同时运行（锁文件竞争） | 低 | 已处理（lock file + PID check） |

---

## 优先级排序

| 优先级 | 触点 | 修复 | 工作量 |
|--------|------|------|--------|
| **P0** | 触点 8 | 错误静默 → 显式日志 | 小 |
| **P0** | 触点 2 | 更新 guide.html | 小 |
| **P0** | 触点 2 | SessionStart context 显示 Board URL | 小 |
| **P1** | 触点 1 | marketplace 条目 + README | 中 |
| **P1** | 触点 3 | H5 配对等待动画 | 中 |
| **P1** | 触点 6 | 离线窗口及时移除 | 小 |
| **P2** | 触点 4 | 状态栏未读消息数 | 中 |
| **P2** | 触点 5 | 消息命名重构 (wechat_msg → h5_msg) | 小 |

---

## 即时可修的 3 个快赢项

1. **guide.html 更新**：删除 `npx oceanbus init` 步骤，改为当前 plugin + daemon 流程
2. **SessionStart context 输出 Board URL**：`echo "H5 Board: http://localhost:3456"`
3. **daemon 启动时检查 SDK 可用性**：`require('oceanbus')` 失败则立即报错

这 3 项改动 < 20 行代码，立即显著改善首次用户体验。
