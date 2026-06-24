#!/usr/bin/env bash
# start.sh — PR-5.8 (Linux/macOS 一键启动)
# 用法: ./start.sh

set -euo pipefail

cd "$(dirname "$0")"

# 检查 .env
if [ ! -f .env ]; then
  echo "[start.sh] .env 不存在，从 .env.example 复制并填入密钥"
  if command -v node >/dev/null 2>&1; then
    SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
    DB_ENCRYPT_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    {
      echo "SESSION_SECRET=$SESSION_SECRET"
      echo "DB_ENCRYPT_KEY=$DB_ENCRYPT_KEY"
    } >> .env
    echo "[start.sh] 已生成 SESSION_SECRET + DB_ENCRYPT_KEY 到 .env"
  else
    cp .env.example .env
    echo "[start.sh] 请手动填入 .env 中的 SESSION_SECRET 和 DB_ENCRYPT_KEY 后重试"
    exit 1
  fi
fi

# 检查 node_modules
if [ ! -d node_modules ]; then
  echo "[start.sh] 第一次启动，安装依赖..."
  npm ci
fi

# 启动
echo "[start.sh] 启动 DeepSeek Mirror..."
exec node server.js
