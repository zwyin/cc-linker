# cc-linker 流式响应设计文档

> 日期：2026-05-23
> 范围：Phase 2 流式响应功能
> 前置：产品设计文档 §4.6 流式响应实现

## 目标

用户在飞书发送消息后，实时看到 Claude 的思考过程和回复进展，消除"黑盒等待"体验。

## 关键设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| thinking 展示 | 展示（可配置开关） | 用户可以看到 Claude 在做什么，增加信任感 |
| 节流频率 | 1500ms | 平衡流畅度和 API 限流风险 |
| 超长回复 | 卡片截断 + 文本续发 | 卡片保留结构化信息，内容完整送达 |

## 架构

```
┌──────────┐    spawn     ┌──────────────┐   stream-json   ┌───────────────┐
│ FeishuBot │────────────►│ SessionMgr   │────────────────►│ StreamParser  │
│ dispatch  │             │ (new method) │                 │ (filter hooks)│
└──────────┘              └──────┬───────┘                 └───────┬───────┘
                                 │                                 │
                                 │ onProgress(chunk)               │ yield chunks
                                 ▼                                 │
                         ┌──────────────┐                          │
                         │ CardUpdater  │◄─────────────────────────┘
                         │ (throttle    │  1500ms
                         │  + patch)    │
                         └──────┬───────┘
                                │ im.v1.message.create / patch
                                ▼
                         ┌──────────────┐
                         │ Feishu API   │
                         └──────────────┘
```

## 组件

### 1. Stream Parser (`src/proxy/stream-parser.ts`)

- 逐行读取 `--output-format stream-json` 输出
- 过滤 `type=system` 行（hook 噪声）
- 提取 `type=assistant` 中的 thinking/text 块
- 输出 `type=result` 供外层处理最终结果

### 2. Card Updater (`src/feishu/card-updater.ts`)

- 发送初始 processing 卡片（`im.v1.message.create`）
- 按 1500ms 节流 patch 更新卡片（`im.v1.message.patch`）
- 管理 4 种状态切换：processing → streaming → complete/error
- 超过 25KB 时自动降级为文本分片

### 3. Session Manager 扩展 (`src/proxy/session.ts`)

- 新增 `sendStreamingMessage()` 方法
- 接受 `onProgress(chunk)` 回调
- 内部使用 `--print --output-format stream-json --verbose` 参数
- 保持原有 `sendMessage()` 不变（非流式路径）

### 4. Feishu Bot 集成 (`src/feishu/bot.ts`)

- `handleChat` 中根据 `[stream].enabled` 配置选择流式/非流式路径
- 流式路径传入 `onProgress` 回调给 Card Updater
- 非流式路径保持 Phase 1 行为

## 数据流

1. Dispatcher 调度消息
2. SessionManager 启动 Claude 进程
3. 进程启动成功 → Card Updater 发送 processing 卡片，记录 delivery `status=sending`
4. Stream Parser 逐行解析 stdout：
   - `type=system` → 忽略
   - `type=assistant` → 累积内容，Card Updater 节流 patch
   - `type=result` → Card Updater patch 为 complete，更新 delivery `status=sent`
5. finalize: spool 移入 done/

## 错误处理

| 错误 | 处理 |
|------|------|
| 进程启动失败 | 不发送卡片，直接回复错误文本 |
| 进程中途崩溃 | patch 卡片为 error 状态 |
| patch 失败（网络） | 指数退避重试 3 次，降级为文本 |
| patch 429（限流） | 延长节流间隔，等待后重试 |
| 超长回复 | 卡片截断，剩余内容以文本分片发送 |
| resume 无效 UUID | patch 卡片为"会话已不存在" |

## 配置

```toml
[stream]
enabled = true
throttle_ms = 1500
show_thinking = true
max_card_bytes = 25000
fallback_to_text = true
```

## 与 Phase 1 兼容性

- 现有 `--output-format json` 路径不受影响
- 通过 `stream: boolean` 参数区分流式/非流式
- delivery receipt 新增 `streaming` 字段，不影响 Phase 1 解析
