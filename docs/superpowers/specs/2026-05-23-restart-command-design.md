# restart 命令设计文档

## 概述

新增 `cc-linker restart` CLI 命令，提供一键重启 Bot 服务的能力。

## 方案

采用**方案 A：容错启动**

- Bot 在运行 → 先 `stop`，确认停止后再 `start --daemon`
- Bot 未运行 → 直接 `start --daemon`，不报错
- 行为类似 `systemctl restart`

## 接口

```bash
cc-linker restart [--daemon]
```

- `--daemon`：以守护进程模式重启（默认行为，与 `start` 保持一致）

## 实现要点

1. **命令注册**：在 `src/index.ts` 注册 `restart` 命令
2. **逻辑复用**：直接调用现有的 `stop()` 和 `start()` 函数，不重复实现停止/启动逻辑
3. **状态检查**：先检查 `isDaemonRunning()`，决定是否先执行 stop
4. **错误处理**：stop 失败不影响 start（容错）
5. **输出格式**：清晰告知用户每一步的状态变化

## 文件变更

| 文件 | 变更 |
|------|------|
| `src/cli/commands/restart.ts` | 新增 restart 命令实现 |
| `src/index.ts` | 注册 restart 命令 |
| `src/cli/commands/start.ts` | 导出 `isDaemonRunning`（如果尚未导出）|
| `README.md` | 更新命令文档 |

## 测试

- 测试 Bot 运行时的重启流程
- 测试 Bot 未运行时的启动流程
