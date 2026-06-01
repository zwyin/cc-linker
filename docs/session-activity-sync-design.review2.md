# Review 确认与修复计划

## 🔴 严重问题确认

### 1. ✅ 确认：SDK 内部进程与交互式 CLI 进程混淆

**问题**：`pgrep -f 'claude'` 会匹配到 SDK `query()` 拉起的内部子进程，误判为"CLI 在处理"。

**修复**：
- Activity Marker 作为飞书侧的主要信号（主动声明，100% 准确）
- CLI 侧检测严格限制：`entry.origin === 'cli'` 时，通过 `jsonl_path` 定位进程（而不是全局 pgrep）
- 删除 `findClaudeProcessByCwd` 的宽泛 `pgrep` 实现，改为基于 JSONL 文件的进程关联

### 2. ✅ 确认：Marker 写入 JSONL 存在竞争

**问题**：`appendFileSync` 虽然原子，但 Scanner 可能在写入中途读取，导致 JSON 解析失败。

**修复**：Marker 写到独立 sidecar 文件：`~/.cc-linker/activity/<sessionId>.jsonl`

### 4. ✅ 确认：message_count 修改会破坏现有数据

**问题**：修改 `parseFull` 中的 `message_count` 计算会导致所有 session 的 message_count 突然下降。

**修复**：与问题 2 合并，Marker 写到 sidecar 文件，不污染 JSONL。

### 5. ✅ 确认：force_override marker 无接收方

**问题**：CLI 侧没有代码读取 `force_override` marker。

**修复**：删除此逻辑。强制发送后不再尝试"告知"CLI 侧。

### 6. ✅ 确认：marker TTL 与 hard_timeout 不匹配

**问题**：10 分钟 TTL < 30 分钟 hard_timeout，长思考场景下会误判为不活跃。

**修复**：
- marker TTL 设为与 `hard_timeout_ms` 一致（默认 30 分钟）
- 每收到 SDK streaming chunk 时刷新 marker（而不仅是固定心跳）

---

## 🟡 中等问题确认

### 7. ✅ 确认：doDetect 遗漏 JSONL 增长检测

**修复**：将 `isJSONLWriting` 作为独立信号加入 `doDetect`。

### 10. ✅ 确认：resume.ts 已有 isSessionBusy

**修复**：设计文档说明与现有 `isSessionBusy` 的关系和集成方式。

### 11. ✅ 确认：强制发送的 SpoolQueue 集成缺失

**修复**：明确实现路径为直接调用 `handleChat(msg)` 跳过检测，不入队。

### 17. ✅ 确认：macOS CPU 采样计算矛盾

**修复**：统一使用原始秒数计算，不混用 ticks。

---

## 核心设计变更

1. **Marker 存储位置**：从 JSONL 改为 `~/.cc-linker/activity/<sessionId>.jsonl`
2. **进程检测范围**：严格限制为 `entry.origin === 'cli'` 的 session，避免匹配 SDK 内部进程
3. **marker TTL**：改为与 `hard_timeout_ms` 匹配（默认 30 分钟）
4. **删除 force_override**：无意义，删除
5. **修正 CPU 计算**：macOS 使用秒数统一计算
