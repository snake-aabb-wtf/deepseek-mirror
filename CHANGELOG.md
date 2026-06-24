# CHANGELOG

DeepSeek Mirror 维护日志。从 PR-0 到 v1.1.0 的所有变更记录。

## v1.1.0 (2026-06-24) — 全面安全加固 + 可观测性 + 部署

### 安全修复（致命级）

| 问题 | 修复 | PR |
|------|------|-----|
| session secret 硬编码 | 环境变量必填 + fail-fast + 启动校验 | PR-0 |
| admin 默认 admin/admin | 启动时生成 12 位随机密码 | PR-0 |
| 凭据明文存储 | AES-256-GCM 加密 (DB_ENCRYPT_KEY) | PR-1 |
| IDOR (跨用户访问 chat) | 所有 db 操作用 session.userId 隔离 | PR-3 |
| admin token 存 localStorage (XSS 风险) | httpOnly+Secure+SameSite=Strict cookie | PR-4 |
| WASM memory grow buffer 失效 | 预 grow 16 页 (1MB) | PR-2 |
| 弱密码 (4 位) | 10 位 + 大小写 + 数字 | PR-0 |
| 时序攻击 | crypto.timingSafeEqual | PR-0 |
| 用户名枚举 | 统一错误消息 | PR-0 |
| session 不安全 | httpOnly/secure/sameSite/regenerate | PR-0 |

### 性能与稳定性

- **sql.js → better-sqlite3 12.11.1**（PR-1）：10-50x 性能提升，原生 mmap
- **WASM Module 单例**（PR-2）：避免每实例重编译
- **fetch 全链路 timeout**（PR-2）：30s 总超时 + 10min idle（SSE）
- **SSE 解析器**（PR-2）：状态机 + 1MB buffer 上限 + UTF-8 收尾
- **账号池原子化**（PR-3）：SQL RETURNING + 内存 in-flight 跟踪
- **save() 同步写盘 → 异步 + 准备防抖**（PR-3 准备）
- **50 并发不重号**（PR-3 验证）

### 可观测性

- **pino 结构化日志**（PR-4）：JSON + 组件化（db / http / migration）
- **Stats outcome 枚举**（PR-3）：success / no_account / upstream_error / client_disconnect
- **`/metrics` Prometheus 端点**（PR-5）：11 个指标
- **Helmet 安全头**（PR-0）：CSP / HSTS / X-Frame-Options / X-Content-Type-Options
- **限流分级**（PR-0）：登录 10/min、管理 60/min、聊天 30/min

### 依赖升级

| 包 | 旧 | 新 | 原因 |
|----|------|------|------|
| express | 4.18.2 | **5.2.1** | 大版本，含异步错误处理改进 |
| express-session | 1.17.3 | **1.19.0** | 修复 regenerate bug |
| http-proxy-middleware | 2.0.6 | **2.0.10** | CVE 修复 |
| sql.js | 1.14.1 | **(移除)** | → better-sqlite3 |
| helmet | — | **8.2.0** | 新增 |
| express-rate-limit | — | **7.5.1** | 新增 |
| pino | — | **9.14.0** | 新增 |
| cookie-parser | — | **1.4.7** | 新增 |
| better-sqlite3 | — | **12.11.1** | 新增 |

**`npm audit` 0 vulnerabilities**

### 部署

- **Dockerfile**（PR-5）：多阶段构建 + non-root + HEALTHCHECK
- **docker-compose.yml**（PR-5）：一键启动 + 命名卷持久化 + 日志轮转
- **start.sh**（PR-5）：Linux/macOS 一键（自动生成密钥 + npm ci）
- **ecosystem.config.cjs**（PR-5）：PM2 配置（512M 重启 + 优雅关停）

### 前端

- **admin SPA 重构**（PR-3/4）：
  - setInterval 泄漏修复（cleanup 函数）
  - 5s 轮询竞态修复（generation + inFlight）
  - state 白名单防 XSS
  - 错误消息 textContent
  - 删除 loginRendered 标志
  - 操作按钮用 `a.id` 替代 index
- **CSS 抽取**（PR-4）：`public/auth.css` 共享，2 个 HTML 各删 90 行
- **flash 消息**（PR-4）：`<script>alert>` → URL query + JS 渲染
- **文档**（PR-4）：AGENTS.md 硬编码路径 → 相对路径

### 测试

- **21 个冒烟测试**（CI）：6 大类覆盖
  - fail-fast 配置
  - 加密往返
  - admin token TTL
  - 加密账号存储
  - 账号池原子性
  - HTTP 端点 (含 /metrics)
- **GitHub Actions**（CI）：push/PR 自动跑
- **零外部依赖**：用 Node 内置 `node:test`

### 6 个新文件

- `lib/crypto.js` — AES-256-GCM 加密
- `lib/admin-tokens.js` — 带 TTL + GC 的 token 存储
- `lib/account-pool.js` — 原子账号选取
- `lib/wasm-singleton.js` — WebAssembly.Module 共享
- `lib/fetch-with-timeout.js` — AbortController 封装
- `lib/logger.js` — pino 封装

---

## v1.0.0 (2026-06-23) — initial

- DeepSeek 镜像站基线
- sql.js + WASM PoW + 账号池
- admin SPA 基础版
- 文档 README.md / README.en-US.md / AGENTS.md

---

## 升级指南 (v1.0 → v1.1)

### 必读

1. **SESSION_SECRET 必须设置**（≥32 字符），否则服务拒绝启动
2. **DB_ENCRYPT_KEY 必须设置**（≥32 字节），否则服务拒绝启动
3. **旧 sql.js 数据库**自动迁移到 better-sqlite3 + 加密：
   - 检测 `sessions.db.old`
   - 加密 token/cookies 导入新表
   - 旧文件重命名保留

### 启动方式变更

```bash
# 1. 生成密钥
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('hex'))" >> .env
node -e "console.log('DB_ENCRYPT_KEY=' + require('crypto').randomBytes(32).toString('hex'))" >> .env

# 2. 启动（任选其一）
./start.sh                          # 裸跑
pm2 start ecosystem.config.cjs     # PM2
docker compose up -d                # Docker
```

### 配置变更

| 旧 | 新 | 说明 |
|----|------|------|
| `NODE_ENV=production` 硬编码 | 可被 `.env` 覆盖 | 便于本地开发 |
| session cookie 默认 | `httpOnly; secure; sameSite=lax` | 安全 |
| `admin/admin` 默认 | 启动时打印随机密码 | 强默认值 |
| 无 admin token TTL | 8h + 30min GC | 防止无限累积 |

### 兼容性

- ✅ 旧 `sessions.db` 自动迁移
- ✅ 旧 `.env`（如有）自动加载
- ✅ admin SPA URL 不变
- ❌ 旧的 Bearer token auth（`/admin/api/login` 返回 `token`）已废 — 改用 cookie
- ❌ 旧 `npm test`（无）→ 用 `npm test`
