# cc-linker

让飞书和终端（Claude Code CLI）之间的对话切换像切换设备一样无缝。

## 3 步上手

### 1. 安装

```bash
# npm 全局安装
npm install -g cc-linker

# 或 bun 全局安装
bun add -g cc-linker

# 需要 Bun 运行时。安装 Bun:
# curl -fsSL https://bun.sh/install | bash
```

### 2. 一键配置

```bash
cc-linker setup
```

交互式向导会引导你：
- 初始化会话注册表
- 安装 Claude Code 自动注册钩子
- 配置飞书 Bot（App ID + App Secret + 开机自启）

> **仅需终端侧功能？** 运行 `cc-linker setup --skip-feishu` 跳过飞书配置。

### 3. 开始使用

| 场景 | 操作 |
|------|------|
| 飞书中给 Bot 发消息 | 直接对话，流式卡片实时更新 |
| 终端查看所有会话 | `cc-linker list` |
| 终端恢复某个会话 | `cc-linker resume <UUID>` |
| 飞书切换会话 | `/switch <序号>` |
| 飞书创建新会话 | `/new <路径> -- <提示词>` |

---

## 飞书开放平台权限配置

在配置飞书 Bot 前，需要在 [飞书开放平台](https://open.feishu.cn/app) 创建应用并配置权限。

### 创建应用

1. 访问 https://open.feishu.cn/app → 创建企业自建应用
2. 在「应用功能」→「机器人」中启用 Bot 能力
3. 获取 App ID 和 App Secret（凭证与基础信息）

### 必需权限

进入「权限管理」，搜索并开通以下权限：

| 权限 | 用途 |
|------|------|
| `im:message` | 读取和发送消息 |
| `im:message:send_as_bot` | 以应用身份发送消息 |
| `im:message:readonly` | 获取消息详情 |
| `im:chat:readonly` | 获取群组信息 |
| `contact:user.base:readonly` | 获取用户基本信息（用于识别 open_id） |

### 必需事件订阅

进入「事件订阅」，添加以下事件：

| 事件 | 用途 |
|------|------|
| `im.message.receive_v1` | 接收用户发给 Bot 的消息 |
| `im.chat.member.bot.added_v1` | Bot 被邀请进群时触发（可选） |

> **重要**：事件订阅方式选择 **WebSocket**（不是 HTTP 回调）。

### 发布应用

配置完权限后，进入「版本管理与发布」→ 创建版本 → 发布。**只有发布后的权限才会生效。**

---

## 详细使用

### 常用命令

```bash
cc-linker list                      # 列出所有会话
cc-linker resume <UUID>             # 恢复指定会话到终端（支持前缀匹配）
cc-linker show <UUID>               # 查看会话详情
cc-linker sync                      # 手动同步两端会话
cc-linker search <关键词>           # 搜索会话
cc-linker export <UUID>             # 导出会话为 Markdown/JSON/Text
cc-linker clean                     # 清理无效记录
cc-linker status                    # 查看桥接状态
```

### 飞书 Bot 命令

在飞书私聊中给 Bot 发送：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/list` | 列出会话（带切换/恢复按钮卡片） |
| `/new [路径] [-- 提示词]` | 创建新会话 |
| `/switch <序号\|UUID>` | 切换会话 |
| `/resume <序号\|UUID>` | 获取终端恢复命令 |
| `/model` | 查看/设置默认模型 |
| `/status` | 查看状态 |
| `/whoami` | 获取你的 open_id |

### 流式响应体验

当 `stream.enabled = true`（默认开启）时，飞书消息会触发流式卡片：

1. **⏳ 正在处理...** — Claude 进程启动后立即出现
2. **💭 处理中** — 实时展示 thinking 和回复内容，底部显示已用时间
3. **✅ 处理完成** — 展示最终回复 + 费用/耗时/轮数统计

### Bot 运行管理

| 命令 | 说明 |
|------|------|
| `cc-linker start` | 前台启动（阻塞终端） |
| `cc-linker start --daemon` | 后台守护进程模式 |
| `cc-linker stop` | 停止后台 Bot |
| `cc-linker daemon install` | 配置开机自动启动 |
| `cc-linker daemon uninstall` | 移除开机自启 |
| `cc-linker daemon status` | 查看后台服务状态 |

### 分步配置（替代 setup 向导）

如果不想使用一键配置，也可以分步执行：

```bash
# 1. 初始化注册表
cc-linker init

# 2. 安装 Claude Code 钩子（可选但推荐）
cc-linker hook install

# 3. 配置飞书 Bot
cc-linker init-feishu

# 4. 启动 Bot
cc-linker start --daemon

# 5. 配置开机自启
cc-linker daemon install
```

### 配置说明

配置文件：`~/.cc-linker/config.toml`（可选，不创建则使用默认值）

```toml
[general]
log_level = "info"

[stream]
enabled = true
throttle_ms = 1500
show_thinking = true
max_card_bytes = 25000
fallback_to_text = true
```

**环境变量覆盖**：

| 环境变量 | 说明 |
|---------|------|
| `CC_LINKER_FEISHU_APP_ID` | 飞书 App ID |
| `CC_LINKER_FEISHU_APP_SECRET` | 飞书 App Secret |
| `CC_LINKER_FEISHU_OWNER_OPEN_ID` | 限制仅指定用户使用 |
| `CC_LINKER_STREAM_ENABLED` | 流式响应开关 |
| `CC_LINKER_LOG_LEVEL` | 日志级别 |

---

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│  Claude Code CLI    ←→  Registry  ←→  飞书 Bot       │
│  (session JSONL)    (registry.json)  (WebSocket)     │
│                          ↑                           │
│                   SessionStart hook                  │
└──────────────────────────────────────────────────────┘
```

- **Registry** (`~/.cc-linker/registry.json`): 统一会话索引
- **Scanner**: 增量扫描 Claude Code JSONL 文件
- **Hook**: Claude Code 启动时自动注册新会话
- **Spool Queue**: 持久化消息队列，崩溃后可恢复
- **Stream Parser**: 解析 Claude `stream-json` 输出
- **Card Updater**: 流式卡片发送与节流

详细架构见 [docs/产品设计文档-自建方案.md](docs/产品设计文档-自建方案.md)。

## 完整文档索引

| 文档 | 说明 |
|------|------|
| [docs/产品设计文档-自建方案.md](docs/产品设计文档-自建方案.md) | 产品设计文档 |
| [docs/验收指南.md](docs/验收指南.md) | 功能验收指南 |
| [docs/验收测试报告.md](docs/验收测试报告.md) | 验收测试结果 |
| [docs/Product.md](docs/Product.md) | 产品需求文档 |
| [docs/model-switch-design.md](docs/model-switch-design.md) | 模型切换设计 |

## 开发者指南

```bash
git clone https://github.com/yujuntea/cc-linker.git
cd cc-linker
bun install
bun run dev <命令>        # 开发模式
bun run typecheck         # 类型检查
bun test                  # 运行测试
bun test --coverage       # 带覆盖率
bun run build             # 编译为独立二进制文件
```

### 编译和发布

```bash
# 独立二进制（本地分发）
bun run build             # → dist/cc-linker

# npm 发布
npm version minor
npm publish               # prepublishOnly 自动触发 build:npm
git push --tags
```

## License

MIT
