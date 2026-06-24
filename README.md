<!-- markdownlint-disable MD033 MD041 -->

<div align="center">

# DeepSeek Mirror

**自建 DeepSeek Chat 镜像站 · 实验性项目**

[![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-21%2F21_passing-brightgreen?logo=github)](https://github.com/snake-aabb-wtf/deepseek-mirror/actions)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Version](https://img.shields.io/badge/version-1.1.0-blue)](./CHANGELOG.md)
[![Warning](https://img.shields.io/badge/status-experimental-orange)](#)

> ⚠️ **警告：本项目为实验性逆向工程，开发尚不完备，存在较多已知 bug。**  
> **请勿用于生产环境，仅供学习和研究使用。**

</div>

---

## 目录

- [免责声明](#免责声明)
- [概述](#概述)
- [原理详解](#原理详解)
  - [什么是 DeepSeek Mirror？](#什么是-deepseek-mirror)
  - [为什么不直接用官方 API？](#为什么不直接用官方-api)
  - [技术方案选型](#技术方案选型)
- [快速开始](#快速开始)
- [架构全景](#架构全景)
  - [三层认证体系](#三层认证体系)
  - [聊天请求完整链路](#聊天请求完整链路)
- [部署指南](#部署指南)
  - [前置条件](#前置条件)
  - [安装步骤](#安装步骤)
  - [第一步：添加上游账号](#第一步添加上游账号)
- [配置说明](#配置说明)
- [管理面板](#管理面板)
- [技术栈](#技术栈)
- [开发计划 / TODO](#开发计划--todo)
- [License](#license)

---

## 免责声明

- 本项目通过逆向 `chat.deepseek.com` 的网页前端和私有 API 实现，**与 DeepSeek 官方无任何关联**
- 本项目**不提供**任何 DeepSeek 账号、Token 或 Cookies，用户需自行准备
- DeepSeek 的服务条款可能禁止此类逆向代理行为，使用者自行承担风险
- **已知问题较多**，详见下方 [开发计划 / TODO](#开发计划--todo)
- 仅供学习研究，不得用于商业用途或大规模分发

---

## 概述

DeepSeek Mirror 是一个**实验性的 DeepSeek Chat 自托管解决方案**。它通过逆向分析 `chat.deepseek.com` 的前端资源（SPA）和后端 API 协议，将整个网页版封装为一个可独立部署的镜像服务。

核心能力：

- **完整前端还原** — 直接从 `chat.deepseek.com` 抓取原始 SPA 资源，保持 100% 原生 UI 和交互体验
- **无需官方 API Key** — 通过账号池 + WASM PoW 求解直连 DeepSeek 的免费网页 API
- **多用户隔离** — 内置注册登录系统，每个用户独立的会话历史持久化到 SQLite
- **管理面板** — 可视化管理上游账号池、请求统计

---

## 原理详解

### 什么是 DeepSeek Mirror？

DeepSeek 官方提供两种使用方式：

1. **网页版**（chat.deepseek.com）— 免费，但有反爬机制（PoW + Cloudflare），且使用私有 API 协议
2. **官方 API**（api.deepseek.com）— 付费，标准 OpenAI 兼容协议

DeepSeek Mirror 做的事情：**把网页版的私有 API 包装成自托管服务，复用网页版的免费额度**。

```
网页版:   浏览器 → chat.deepseek.com (私有 API)
官方 API: 程序 → api.deepseek.com (OpenAI 协议, 付费)

本镜像:  浏览器 → 镜像站 → chat.deepseek.com (私有 API, 免费)
```

### 为什么不直接用官方 API？

- 官方 API 按 token 计费，对高频用户成本较高
- 网页版免费使用，且体验与付费版基本一致
- 但网页版有 PoW 反爬 + 私有协议，无法直接用标准工具链访问

DeepSeek Mirror 解决了这两个问题：自动求解 PoW、代理私有协议。

### 技术方案选型

- **为什么不用 Python（web2api 原有方案）？**  
  web2api 是一个独立的 Python FastAPI 项目，架构上是 浏览器 → Node 镜像站 → Python web2api → DeepSeek。 多一跳就多一层故障点和运维成本。 本项目将 web2api 的核心功能（PoW 求解、SSE 解析）用 Node.js 原生 WebAssembly 重新实现，并直接嵌入镜像站，去掉了 Python 依赖。

- **为什么用 SQLite 而不是 MySQL/PostgreSQL？**  
  镜像站是单机部署，不需要网络数据库。 SQLite 零配置、单文件、无需额外进程，对 Node.js 极为友好。 sql.js 在内存和磁盘间同步，重启不丢数据。

- **为什么 SPA 的 cookie 认证不可用？**  
  DeepSeek 原版 SPA 的 HTTP 客户端（lyla）使用 `XMLHttpRequest` 且默认 `withCredentials = false`，浏览器不会随 API 请求发送 session cookie。 但 lyla 会自动添加 `Authorization: Bearer <token>` 头。 因此镜像站实现了 token bypass 中间件，识别 SPA 发来的 `mirror-*` 格式令牌来代替 cookie 认证。详见下文[三层认证体系](#三层认证体系)。

- **什么是 PoW？**  
  Proof-of-Work（工作量证明）是 DeepSeek 的反滥用机制。每次调用 API 前必须求解一个 SHA3 哈希难题（约 0.1-0.3 秒）。 求解引擎以 WASM 形式嵌入在 DeepSeek 前端中，本镜像站提取该 WASM 并在 Node.js 中通过 `WebAssembly` API 直接调用。

---

## 快速开始

### 前置条件

- Node.js 20+（推荐 24）
- npm
- 一个可用的 DeepSeek 网页版账号

### 安装步骤

```bash
# 1. 进入项目目录
cd deepseek-mirror

# 2. 安装依赖
npm install

# 3. 配置环境变量（必填 SESSION_SECRET + DB_ENCRYPT_KEY）
cp .env.example .env
# 自动生成密钥：
#   node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('hex'))" >> .env
#   node -e "console.log('DB_ENCRYPT_KEY=' + require('crypto').randomBytes(32).toString('hex'))" >> .env

# 4. 启动（任选其一）
node server.js           # 裸跑
./start.sh               # Linux/macOS 一键（自动生成密钥 + npm ci）
pm2 start ecosystem.config.cjs   # PM2 进程管理
docker compose up -d     # Docker 一键
```

> 启动时若 `ADMIN_PASSWORD` 留空，服务会在控制台**打印一次**临时管理员密码。  
> 首次启动 SQLite 数据库 `sessions.db` 会自动生成（better-sqlite3 格式），旧 sql.js 数据库会自动迁移。

### 部署方式

| 方式 | 命令 | 适用场景 |
|------|------|----------|
| 裸跑 | `node server.js` | 开发 / 临时 |
| 一键脚本 | `./start.sh` | Linux/macOS 快速部署 |
| PM2 | `pm2 start ecosystem.config.cjs` | 长期运行（自动重启） |
| Docker | `docker compose up -d` | 容器化（自动重启 + 数据卷） |

**Docker 数据卷**：`mirror-data` 命名卷持久化 `sessions.db` 和 `.env`。

### 监控

- **健康检查**：`GET /auth.css`（Docker HEALTCHECK）
- **Prometheus 指标**：`GET /metrics`（11 个指标）
- **管理面板**：`/admin/`（账号池 + 统计 + 实时刷新）

### 第一步：添加上游账号

镜像站刚启动时账号池为空，需要先添加一个 DeepSeek 账号才能使用聊天功能：

1. 打开 `http://localhost:3000/admin/` → 使用管理员账号登录（首次启动时控制台打印的临时密码，或 `.env` 中配置的 `ADMIN_PASSWORD`）
2. 进入「账号池」页面
3. 点击「添加」，填写以下两项：

   | 字段 | 获取方法 |
   |------|---------|
   | **Token** | 登录 `chat.deepseek.com` → F12 → Network → 任意请求 → Request Headers → 复制 `Authorization: Bearer <...>` 中 Bearer 后面的完整字符串 |
   | **Cookies** | 登录 `chat.deepseek.com` → F12 → Network → 同一请求 → Request Headers → 复制 `Cookie: <...>` 后面的完整字符串 |

4. 点击「添加」即可

> Token 和 Cookies 会过期（通常数小时到数天），过期后账号会标记为 `error`，需重新获取并更新。

---

## 架构全景

```
┌─ 用户浏览器 ──────────────────────────────────────────────────────────┐
│                                                                        │
│  SPA (fe-static.deepseek.com 的原始前端，未经修改)                      │
│                                                                        │
│  ① 页面加载时 index.html 注入:                                         │
│     localStorage.userToken = "mirror-bypass" (临时引导值)               │
│                                                                        │
│  ② SPA 启动 → 读到 localStorage → 认为已登录 → 调 users API            │
│     → 服务端返回 { token: "mirror-<用户 UUID>", ... }                   │
│     → SPA 将 localStorage 替换为 "mirror-<用户 UUID>"                   │
│                                                                        │
│  ③ 后续每次 API 请求:                                                  │
│     Authorization: Bearer mirror-<用户 UUID>                            │
│     (XHR withCredentials=false → 不发送 cookie)                        │
│                                                                        │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │ POST /api/v0/chat/completion
                           ▼
┌─ 镜像站服务端 (Express) ───────────────────────────────────────────────┐
│                                                                        │
│  ┌── 第 1 关: 静态文件 ──────────────────────────────────────────┐    │
│  │  express.static → 前端 SPA 资源 (index.html, JS, CSS, 字体)    │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                            │                                           │
│  ┌── 第 2 关: Token Bypass ─────────────────────────────────────┐    │
│  │  检查 Authorization 头 → 如果是 "mirror-bypass"               │    │
│  │  或 "mirror-<xxx>" → 标记 session.authenticated = true         │    │
│  │  放行 (不检查 cookie)                                          │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                            │                                           │
│  ┌── 第 3 关: User Auth ───────────────────────────────────────┐    │
│  │  session.authenticated? → 放行 / 401                          │    │
│  │  /sign_in 和 /sign_up 免检                                    │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                            │                                           │
│  ┌── 路由分发 ──────────────────────────────────────────────────┐    │
│  │  /sign_in → 验证密码 → 设置 session                             │    │
│  │  /sign_up → 注册 → 存 SQLite users 表                          │    │
│  │  /api/v0/users* → mock 返回用户信息 + 专属 token               │    │
│  │  /api/v0/current → mock 用户信息                                │    │
│  │  /api/v0/chat_session/* → SQLite CRUD (create, list, delete)   │    │
│  │  /api/v0/chat/completion → handleDeepSeekCompletion 翻译层      │    │
│  │  * → serve SPA (index.html)                                    │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                            │                                           │
│  ┌── 核心翻译层 handleDeepSeekCompletion() ───────────────────────┐    │
│  │                                                                  │    │
│  │  Step 1: 检查 session 认证                                       │    │
│  │  Step 2: 存用户消息到 SQLite messages 表                          │    │
│  │  Step 3: getAvailableAccount()                                   │    │
│  │    → 遍历 SQLite accounts 表，取第一个 idle 账号                  │    │
│  │    → 若无可用账号 → 返回 toast "没有可用账号"                     │    │
│  │  Step 4: new DeepSeekClient(token, cookies)                      │    │
│  │  Step 5: WASM PoW 求解                                           │    │
│  │    GET /api/v0/chat/create_pow_challenge → 获取 challenge        │    │
│  │    wasm_solve() → 计算 nonce → 构造 X-DS-PoW-Response 头         │    │
│  │  Step 6: 创建上游会话 (带 PoW 头)                                 │    │
│  │    POST /api/v0/chat_session/create → 获得 session_id            │    │
│  │  Step 7: 流式聊天 (带 PoW 头)                                     │    │
│  │    POST /api/v0/chat/completion → 上游 SSE 流                    │    │
│  │  Step 8: 上游 SSE → SPA SSE 翻译                                 │    │
│  │    {v:"token"} → event:delta {o:APPEND, p:..., v:"token"}        │    │
│  │  Step 9: 存 assistant 消息到 SQLite                               │    │
│  │  Step 10: releaseAccount() → 账号状态回 idle                     │    │
│  │                                                                  │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                            │                                           │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ POST /api/v0/chat/completion
                             │ Authorization: Bearer <真实 Token>
                             │ Cookie: <真实 Cookies>
                             │ X-DS-PoW-Response: <PoW 解>
                             ▼
┌─ chat.deepseek.com ────────────────────────────────────────────────────┐
│  DeepSeek 原生 API:                                                     │
│  - 校验 Authorization + Cookie                                          │
│  - 校验 X-DS-PoW-Response (PoW 解)                                      │
│  - 创建会话 → 流式返回 SSE                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 三层认证体系

```
┌── 第 1 层: 镜像站用户认证 ──────────────────────────────────────┐
│  入口: /sign_up → /sign_in                                        │
│  凭据: 用户名 + 密码 (scrypt 加盐哈希, 存 SQLite users 表)        │
│  产物: session cookie (connect.sid)                               │
│  备注: 重启后 session 丢失, 需重新登录                             │
├── 第 2 层: SPA 令牌绕过 ─────────────────────────────────────────┤
│  入口: index.html 内联脚本注入 localStorage.userToken              │
│  流程: "mirror-bypass" → /users API → "mirror-<UUID>"               │
│  产物: Authorization: Bearer mirror-<UUID>                         │
│  备注: 解决 SPA 不发送 cookie 的问题, 详见下方                    │
├── 第 3 层: 上游 DeepSeek 账号池 ───────────────────────────────┤
│  入口: 管理面板 /admin/#accounts                                   │
│  凭据: Bearer Token + Cookie 字符串 (存 SQLite accounts 表)        │
│  使用: 聊天时取一个空闲账号直连上游                                │
│  安全: 普通用户永远接触不到这层凭据                                │
└────────────────────────────────────────────────────────────────────┘
```

**为什么要搞三层认证？** 这和 DeepSeek SPA 的内部实现有关。

DeepSeek SPA 的 HTTP 库（lyla）使用 `XMLHttpRequest` 且 `withCredentials = false`（vendors bundle line 1710），所以 session cookie 不会被发送。

但 lyla 会在每次请求时自动读 `localStorage.userToken` 并加 `Authorization: Bearer <token>` 头（main bundle line 2032-2051）。

所以架构决策如下：
- 不能依赖 cookie → 新增 token bypass 中间件，识别 `mirror-*` 令牌
- 令牌从哪里来？→ 从 index.html 注入临时值，再从 mock users API 获取专属值
- 真正的上游凭据放哪里？→ 管理员管理的账号池，服务端使用，永不暴露给用户

### 聊天请求完整链路

以用户发一条消息为例：

```
① 用户在 SPA 输入框打字 → 点击发送

② SPA 调用 createSession()
   → POST /api/v0/chat_session/create
   → Authorization: Bearer mirror-<uuid>
   → 服务端返回 fake UUID（SQLite 写入一条会话记录）

③ SPA 调用 chat completion
   → POST /api/v0/chat/completion
   → 请求体: { chat_session_id, prompt, model_type, thinking_enabled }
   → Authorization: Bearer mirror-<uuid>

④ 服务端收到请求
   → Token bypass: "mirror-xxx" → 标记已验证 → 放行
   → handleDeepSeekCompletion()

⑤ 从账号池取空闲账号
   → 没有可用账号 → 返回 toast "没有可用账号" → 终止
   → 有 → 标记 busy

⑥ new DeepSeekClient(token, cookies)
   → 调用 createSession() → 先 PoW 求解 → 上游创建会话

⑦ 调用 chatStream()
   → 再 PoW 求解 → POST 上游 /api/v0/chat/completion
   → 上游返回 SSE 流

⑧ 翻译层逐条解析上游 SSE:
   {v:"你好"} → event:delta {o:APPEND, p:"response/.../content", v:"你好"}
   {p:"response/status",o:"SET",v:"FINISHED"} → 透传给 SPA

⑨ SPA 收到 SSE → React 渲染 → 用户看到 AI 回复

⑩ 释放账号 (releaseAccount → state 回 idle)
```

---

## 部署指南

### 前置条件

- Node.js 24+（内置 fetch + WebAssembly 支持）
- npm
- 一个可用的 DeepSeek 网页版账号（用于获取 Token + Cookies）

### 安装步骤

```bash
cd deepseek-mirror
npm install
```

依赖说明：

| 包 | 用途 |
|---|------|
| `express` | Web 框架 |
| `express-session` | Session 管理 |
| `http-proxy-middleware` | CDN 反向代理 |
| `sql.js` | SQLite 数据库（WASM 版） |
| `dotenv` | `.env` 文件加载 |

> 不需要安装 `wasmtime` 或任何 Python 依赖。PoW 求解使用 Node.js 内置的 `WebAssembly` API。

### 第一步：添加上游账号

镜像站本身不带任何 DeepSeek 账号。启动后第一件事是去管理面板添加账号：

1. `http://localhost:3000/admin/` → 登录 (默认 `admin / admin`)
2. 进入「账号池」页面
3. 添加一个 DeepSeek 账号：

   ```
   Token:  从 chat.deepseek.com 的请求头中复制
   Cookie: 从 chat.deepseek.com 的请求头中复制
   ```

**如何获取 Token 和 Cookie：**

1. 用 Chrome/Edge 打开 `https://chat.deepseek.com` 并登录
2. 按 F12 打开开发者工具 → Network 标签
3. 在页面中随意操作（如发送一条消息或新建对话）
4. 在请求列表中找到任意一个到 `chat.deepseek.com` 的请求
5. 点击该请求 → Headers → Request Headers

   | 要复制的值 | 位置 |
   |-----------|------|
   | **Token** | `Authorization: Bearer <这里的长字符串>` |
   | **Cookies** | `Cookie: <这里的全部内容>` |

6. 将这两个值填入管理面板的账号添加表单

---

## 配置说明

通过 `.env` 文件（复制自 `.env.example`）：

```env
# 服务监听端口 (默认 3000)
PORT=3000

# 管理面板的登录凭据
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin
```

所有配置项均为可选，不配置时使用默认值。

---

## 管理面板

| 页面 | 路由 | 功能 |
|------|------|------|
| 登录 | `/admin/` → 输入账号密码 | 管理员认证 |
| 概览 | `#dashboard` | 请求统计 + 账号池状态（每 5 秒自动刷新） |
| 账号池 | `#accounts` | 添加/删除/重登录上游 DeepSeek 账号 |

**管理 API 端点（JSON 格式）：**

| 方法 | 路径 | 用途 | 请求体 |
|------|------|------|--------|
| POST | `/admin/api/login` | 登录 | `{username, password}` |
| GET | `/admin/api/stats` | 统计 | — |
| GET | `/admin/api/accounts` | 账号列表 | — |
| POST | `/admin/api/accounts` | 添加账号 | `{token, cookies, email?}` |
| DELETE | `/admin/api/accounts/:index` | 删除 | — |
| POST | `/admin/api/accounts/:index/relogin` | 重登 | — |

> 管理面板认证与用户认证完全独立。管理员账号通过环境变量配置，用户账号通过注册页面创建。

---

## 技术栈

| 层 | 技术 | 版本 | 选型理由 |
|----|------|------|---------|
| 运行时 | Node.js | 24+ | 内置 fetch、WebAssembly，无需外部依赖 |
| Web 框架 | Express | 4.x | 最流行的 Node.js Web 框架，生态丰富 |
| 数据库 | SQLite (sql.js) | 1.x | WASM 实现，零配置，单文件持久化 |
| Session | express-session | 1.x | 内存 store，重启后 session 丢失 |
| WASM | sha3_wasm_bg.wasm | — | 从 DeepSeek 前端提取，Node.js WebAssembly API 调用 |
| 前端 SPA | DeepSeek 原版 | — | 逆向获得，100% 原生 UI，未经修改 |
| 管理面板 | 纯 HTML/CSS/JS | — | 零构建步骤，无 npm 依赖 |
| 密码哈希 | crypto.scryptSync | — | Node.js 内置，无需额外库 |

---

## 开发计划 / TODO

> 详细变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

### v1.1.0 已修复

- [x] **session 安全性** — `httpOnly + secure + sameSite` cookie + regenerate 防 fixation (PR-0)
- [x] **凭据明文存储** — AES-256-GCM 加密 (PR-1)
- [x] **IDOR (跨用户访问)** — 所有 db 操作用 userId 隔离 (PR-3)
- [x] **admin token XSS 风险** — httpOnly cookie 替代 localStorage (PR-4)
- [x] **WASM memory grow buffer 失效** — 预 grow 16 页 (PR-2)
- [x] **弱密码** — 10 位 + 复杂度 (PR-0)
- [x] **时序攻击 / 用户名枚举** — timingSafeEqual + 统一错误 (PR-0)
- [x] **fetch timeout** — 30s 总 + 10min SSE idle (PR-2)
- [x] **并发账号重复** — SQL RETURNING 原子 (PR-3)
- [x] **PoW 失败无重试** — 2 次重试 + resp.ok 检查 (PR-2)
- [x] **Docker 部署** — Dockerfile + docker-compose (PR-5)
- [x] **使用量统计** — outcome 细分 + Prometheus 指标 (PR-3/5)
- [x] **结构化日志** — pino + 组件化 (PR-4)
- [x] **依赖 CVE** — http-proxy-middleware 升 2.0.10 (PR-5)

### 仍待办

- [ ] **Session 持久化** — 内存 store 重启失效（生产建议 Redis）
- [ ] **账号池凭据无自动续期** — 凭据过期需手动更新
- [ ] **暗/亮主题切换** — 目前仅适配暗色
- [ ] **自定义欢迎页** — 替换 SPA 默认 DeepSeek 欢迎页
- [ ] **管理员账号 SQLite 化** — 面板内修改管理员密码
- [ ] **HTTPS** — 默认 HTTP，需前置 nginx/Caddy
- [ ] **多模态支持** — DeepSeek 协议未公开图片上传
- [ ] **工具调用** — DSML/function calling（需修改 SPA）
- [ ] **OpenAI 兼容接口** — `/v1/chat/completions` 标准

### 已知限制

- **不可与官方 DeepSeek 同时使用** — Token 和 Cookie 从同一浏览器提取，回话可能会冲突
- **上游协议变更风险** — DeepSeek 随时可能更新前端或 API 协议，导致镜像站失效
- **PoW 偶尔失败** — 已加重试但仍可能 0 成功率（上游 challenge 无解）

---

## License

MIT
