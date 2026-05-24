#!/bin/bash
# cc-linker 飞书集成配置脚本
# 用法: bash scripts/setup-feishu.sh

set -e

CC_CONNECT_CONFIG="${HOME}/.cc-connect/config.toml"
CC_LINKER_CONFIG="${HOME}/.cc-linker/config.toml"

echo "=== cc-linker 飞书集成配置 ==="
echo ""

# 检查 cc-connect 配置文件是否存在
if [ ! -f "$CC_CONNECT_CONFIG" ]; then
  echo "❌ 未找到 cc-connect 配置文件: $CC_CONNECT_CONFIG"
  echo "   请先安装并配置 cc-connect"
  exit 1
fi

echo "✅ 找到 cc-connect 配置: $CC_CONNECT_CONFIG"

# 检查是否已配置 bridge 命令
if grep -q 'name = "bridge"' "$CC_CONNECT_CONFIG" 2>/dev/null; then
  echo "⚠️  bridge 命令已存在，跳过配置"
  echo ""
  echo "如需重新配置，请先手动删除 [[commands]] 中的 bridge 条目"
else
  # 获取 cc-linker 命令路径
  CC_LINKER_BIN=$(which cc-linker 2>/dev/null || echo "")
  if [ -z "$CC_LINKER_BIN" ]; then
    # 尝试从项目目录查找
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
    if [ -f "$PROJECT_DIR/dist/cc-linker" ]; then
      CC_LINKER_BIN="$PROJECT_DIR/dist/cc-linker"
      echo "⚠️  cc-linker 未在 PATH 中，使用编译产物: $CC_LINKER_BIN"
    else
      echo "❌ 未找到 cc-linker 命令"
      echo "   请先安装 cc-linker:"
      echo "   cd $PROJECT_DIR && bun run build && export PATH=\$(pwd)/dist:\$PATH"
      exit 1
    fi
  fi

  echo "✅ cc-linker 路径: $CC_LINKER_BIN"

  # 备份配置文件
  BACKUP_FILE="${CC_CONNECT_CONFIG}.bak.$(date +%Y%m%d_%H%M%S)"
  cp "$CC_CONNECT_CONFIG" "$BACKUP_FILE"
  echo "✅ 已备份配置: $BACKUP_FILE"

  # 添加 [[commands]] 配置
  # 注意：cc-connect v1.3.2 不支持 {{user}} 模板变量
  # cc-linker 会自动从 cc-connect session 文件中识别调用者身份
  cat >> "$CC_CONNECT_CONFIG" << EOF

# cc-linker 飞书集成命令
# cc-linker 会自动从 cc-connect session 文件中识别调用者身份
[[commands]]
  name = "bridge"
  description = "跨平台会话管理 / Cross-platform session management"
  exec = "${CC_LINKER_BIN} feishu-cmd {{args}}"
EOF

  echo "✅ 已添加 bridge 命令配置"
fi

# 同步 bridge token 到 cc-linker 配置
echo ""
echo "--- 同步 Bridge API Token ---"

# 从 cc-connect 配置中提取 bridge token
BRIDGE_TOKEN=$(grep -A 10 '^\[bridge\]' "$CC_CONNECT_CONFIG" | grep 'token' | head -1 | sed 's/.*= *"\([^"]*\)".*/\1/' | tr -d ' ')

if [ -n "$BRIDGE_TOKEN" ]; then
  # 确保 cc-linker 配置目录存在
  mkdir -p "$(dirname "$CC_LINKER_CONFIG")"

  # 创建或更新 cc-linker 配置
  if [ -f "$CC_LINKER_CONFIG" ]; then
    # 更新现有配置
    if grep -q '^\[bridge\]' "$CC_LINKER_CONFIG"; then
      # 只在 [bridge] 段内替换 token，避免误改其他段的 token
      awk -v token="$BRIDGE_TOKEN" '
        BEGIN { in_bridge = 0 }
        /^\[bridge\]/ { in_bridge = 1 }
        /^\[/ && !/^\[bridge\]/ { in_bridge = 0 }
        in_bridge && /^[[:space:]]*token[[:space:]]*=/ {
          print "token = \"" token "\""
          next
        }
        { print }
      ' "$CC_LINKER_CONFIG" > "${CC_LINKER_CONFIG}.tmp"
      mv "${CC_LINKER_CONFIG}.tmp" "$CC_LINKER_CONFIG"
    else
      # 添加 bridge 段
      cat >> "$CC_LINKER_CONFIG" << EOF

[bridge]
  token = "${BRIDGE_TOKEN}"
EOF
    fi
  else
    # 创建新配置
    cat > "$CC_LINKER_CONFIG" << EOF
[bridge]
  token = "${BRIDGE_TOKEN}"
EOF
  fi

  echo "✅ 已同步 Bridge API Token 到 $CC_LINKER_CONFIG"
else
  echo "⚠️  未在 cc-connect 配置中找到 bridge token"
  echo "   请手动配置: $CC_LINKER_CONFIG"
  echo "   添加以下内容:"
  echo '   [bridge]'
  echo '     token = "your-bridge-token"'
fi

echo ""
echo "=== 配置完成 ==="
echo ""
echo "请重启 cc-connect 使配置生效:"
echo "  cc-connect daemon restart"
echo ""
echo "然后在飞书中使用:"
echo "  /bridge list          - 列出所有会话"
echo "  /bridge switch <Ref>  - 切换到指定会话"
echo "  /bridge resume <Ref>  - 获取终端恢复命令"
echo "  /bridge status        - 查看桥接状态"
echo ""
echo "注意：cc-linker 会自动从 cc-connect session 文件中识别飞书调用者身份"
