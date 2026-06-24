# Dockerfile — PR-5.6
# 多阶段构建: builder 装 better-sqlite3 native bindings, runtime 精简
#
# 用法:
#   docker build -t deepseek-mirror .
#   docker run -d --name ds-mirror -p 3000:3000 \
#     -v $(pwd)/sessions.db:/app/sessions.db \
#     -v $(pwd)/.env:/app/.env:ro \
#     deepseek-mirror
#
# 多阶段目的:
#   1. 装 native 模块需要编译器；运行时镜像不需要
#   2. 减少最终镜像体积
#   3. 安全：非 root 运行

# ── 阶段 1: builder ──────────────────────────────────────
FROM node:24-bookworm-slim AS builder

# better-sqlite3 需要 python3 + make + g++
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 装依赖
COPY package.json package-lock.json* ./
RUN npm ci

# ── 阶段 2: runtime ──────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# 安全：非 root
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m -d /app nodejs
WORKDIR /app

# 复制 node_modules（含 better-sqlite3 native binding）
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# 复制应用代码
COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs server.js deepseek-client.js db.js ./
COPY --chown=nodejs:nodejs lib/ ./lib/
COPY --chown=nodejs:nodejs public/ ./public/
COPY --chown=nodejs:nodejs admin/ ./admin/
COPY --chown=nodejs:nodejs sha3_wasm_bg.wasm ./

# 数据目录（sessions.db / .env）
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info \
    DB_PATH=/app/data/sessions.db

EXPOSE 3000

# 健康检查（调 /auth.css 公开端点判断）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||3000) +'/auth.css', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# tini-like 行为（Node 自管信号）
CMD ["node", "server.js"]
