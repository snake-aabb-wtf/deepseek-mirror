# AGENTS.md — DeepSeek Mirror

> 本文档面向后续维护本项目的 AI 智能体，完整阐述项目的实现原理、协议细节、代码架构和已知问题。**请先全文阅读本文档再开始任何修改**。

---

## 目录

1. [项目概述](#1-项目概述)
2. [目录结构](#2-目录结构)
3. [核心数据流](#3-核心数据流)
4. [三层认证体系](#4-三层认证体系)
5. [mirror-bypass 令牌机制](#5-mirror-bypass-令牌机制)
6. [数据库 Schema](#6-数据库-schema)
7. [DeepSeek 客户端 (deepseek-client.js)](#7-deepseek-客户端-deepseek-clientjs)
8. [SSE 协议翻译层](#8-sse-协议翻译层)
9. [PoW 求解 (WASM)](#9-pow-求解-wasm)
10. [管理面板](#10-管理面板)
11. [账号池](#11-账号池)
12. [已知问题与边界情况](#12-已知问题与边界情况)
13. [常见调试方法](#13-常见调试方法)
14. [配置系统](#14-配置系统)
15. [约定与编码规范](#15-约定与编码规范)

---

## 1. 项目概述

DeepSeek Mirror 是一个自托管的 DeepSeek Chat 镜像站，将 `chat.deepseek.com` 的 SPA 前端逆向后与服务端代理整合，实现无需官方 API Key 的 DeepSeek 访问。

### 核心能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 原生 SPA 界面 | ✅ | 100% DeepSeek 原版前端，无 UI 改动 |
| 用户注册/登录 | ✅ | SQLite + scrypt 密码哈希 |
| 多用户隔离 | ✅ | 每个用户独立的 `mirror-<uuid>` 令牌 |
| 上游账号池 | ✅ | 管理员添加多个 DeepSeek 账号 |
| WASM PoW 求解 | ✅ | Node.js WebAssembly 直连，无需 Python |
| SSE 流式聊天 | ✅ | DeepSeek 原生 SSE → 镜像站翻译 → SPA |
| 会话持久化 | ✅ | SQLite 存储，重启不丢 |
| 管理面板 | ✅ | 概览统计、账号池管理 |
| 历史记录 | ✅ | 基于 SQLite 的分页查询 |
| 专家/思考模式 | ✅ | 透传 `thinking_enabled` + `model_type` |
| 联网搜索 | ✅ | 透传 `search_enabled` |

### 项目版本

当前版本：`v1.0.0`

---

## 2. 目录结构

```
镜像站/
├── server.js                 # Express 主服务 (路由、认证、翻译层)
├── db.js                     # SQLite 数据库模块 (sql.js)
├── deepseek-client.js         # DeepSeek API 直连客户端
├── sha3_wasm_bg.wasm         # PoW 求解引擎 (从 chat.deepseek.com 提取)
├── package.json              # 依赖声明
├── start.bat                 # Windows 一键启动
├── .env                      # 环境配置 (不提交)
├── .env.example              # 配置模板 (提交)
├── README.md                 # 用户文档
├── AGENTS.md                 # 本文件
│
├── admin/                    # 管理面板 SPA
│   ├── index.html            #   入口
│   ├── app.js                #   SPA 逻辑 (零构建依赖)
│   └── style.css             #   暗色主题
│
├── public/                   # 前端静态文件 (DeepSeek SPA)
│   ├── index.html            #   SPA 入口 + mirror-bypass 注入
│   ├── login.html            #   镜像站登录页
│   ├── sign_up.html          #   镜像站注册页
│   └── fe-static.deepseek.com/chat/static/
│       ├── main.482d6209db.js           # 主应用 bundle
│       ├── default-vendors.7833d62b76.js # 第三方库
│       ├── katex.6058400e2d.js           # KaTeX 渲染
│       ├── main.e6cb057310.css           # 样式
│       ├── 37627.ebf6d8f55d.js          # WASM 加载器
│       ├── 8138.63461459c3.js           # Polyfills
│       ├── 87321.0bf9a03180.js          # DebugPanel (空桩)
│       ├── Inter-*.woff2                # Inter 字体
│       ├── web-logo.svg / favicon.svg   # 资源
│       └── sha3_wasm_bg.*.wasm          # (未使用，deepseek-client.js 用根目录的)
│
└── sessions.db               # SQLite 数据库 (自动创建)
```

### 文件职责矩阵

| 文件 | 职责 | 不负责 |
|------|------|--------|
| `server.js` | 路由、认证、翻译层、管理 API | 数据库操作、上游通信 |
| `db.js` | SQLite 初始化 + 4 张表的 CRUD | HTTP 路由、业务逻辑 |
| `deepseek-client.js` | 上游 DeepSeek API 通信、PoW 求解 | 数据库、用户认证、路由 |
| `admin/app.js` | 管理面板 UI 渲染 + 用户交互 | 服务端逻辑 |

### 开发环境搭建

```bash
# 1. 进入项目目录（路径以你的实际位置为准）
cd deepseek-mirror

# 2. 复制 .env.example 为 .env，并填入 SESSION_SECRET 与 DB_ENCRYPT_KEY
cp .env.example .env
# 生成密钥：
#   node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
#   node -e "console.log('DB_ENCRYPT_KEY=' + require('crypto').randomBytes(32).toString('hex'))"

# 3. 安装依赖（需要 Node 20+）
npm install

# 4. 启动
node server.js
# 访问 http://localhost:3000
# Admin: http://localhost:3000/admin/
```

---

## 3. 核心数据流

### 3.1 用户认证流

```
用户访问 /sign_in
  → GET /sign_in → login.html (镜像站自建登录页)
  → POST /sign_in → db.getUserByUsername() + db.verifyPassword()
  → 成功: session.authenticated = true, 302 /
  → 失败: alert("账号或密码错误"), 回到 /sign_in
```

### 3.2 SPA 启动流

```
302 / → SPA (public/index.html) 加载
  → 内联脚本: localStorage.setItem("userToken", JSON.stringify({value:"mirror-bypass",__version:"0"}))
  → deferred bundles (default-vendors → main) 执行
  → SPA 检查 localStorage.userToken → 发现 mirror-bypass → 认为已登录
  → GET /api/v0/users/current → 返回 { token: "mirror-<uuid>", ... }
  → SPA 调用 setStorageUserToken("mirror-<uuid>") → 替换 localStorage
  → 后续请求统一使用 Authorization: Bearer mirror-<uuid>
```

### 3.3 聊天请求流

```
用户输入消息 → SPA 调用 createSession()
  → POST /api/v0/chat_session/create → 服务器 mock 返回 UUID
  → 存入 SQLite sessions 表

SPA 调用 chat completion
  → POST /api/v0/chat/completion
  → Authorization: Bearer mirror-<uuid>
  → token bypass middleware: 通过
  → handleDeepSeekCompletion():
      1. 存用户消息到 SQLite
      2. getAvailableAccount() → 从账号池取空闲账号
      3. new DeepSeekClient(token, cookies)
      4. WASM 求解 PoW → _powHeaders()
      5. createSession() → 上游 DeepSeek 会话
      6. chatStream() → 上游 SSE 流
      7. 解析上游 SSE → 翻译为 SPA 期望的格式
      8. res.write SSE 事件
  → 完成后存 assistant 消息到 SQLite
```

---

## 4. 三层认证体系

### 4.1 第 1 层：镜像站用户认证

**文件**: `server.js` lines 59-69 (sign_in), 81-99 (sign_up)

- 用户名+密码注册/登录
- 密码使用 `crypto.scryptSync(password, salt, 64)` 加盐哈希
- salt 为 `crypto.randomBytes(16).toString('hex')`
- 存储格式: `salt:hash`（各 64 hex 字符）
- 登录成功后设置 `session.authenticated = true`
- session 使用内存存储（`express-session` 默认 `MemoryStore`）
  - **注意**: 重启后所有 session 失效，用户需重新登录
  - 如需持久化 session，需添加 `connect-sqlite3` 等外部 store

### 4.2 第 2 层：SPA 令牌绕过 (Token Bypass)

**文件**: `server.js` lines 199-208

由于 DeepSeek SPA 的 HTTP 客户端（lyla）使用 `XMLHttpRequest` 且默认 `withCredentials = false`（vendors bundle line 1710），浏览器**不会**随 API 请求发送 session cookie。但 lyla 通过 `onBeforeRequest` 钩子自动添加 `Authorization: Bearer <token>`（main bundle line 2032-2051）。

token bypass 中间件拦截所有请求，检查 `Authorization` 头：

```javascript
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token && (token === 'mirror-bypass' || token.startsWith('mirror-'))) {
    req.session.authenticated = true;
    return next();
  }
  next();
});
```

**必须放在 user auth middleware 之前。**

### 4.3 第 3 层：上游 DeepSeek 账号池

**文件**: `server.js` lines 149-204 (admin API), `deepseek-client.js`

管理员通过管理面板添加真实 DeepSeek 凭据（Bearer token + Cookie 字符串），存储在 SQLite `accounts` 表。聊天时服务器从池中取一个空闲账号，使用其凭据调用上游 API。

**凭据安全**: `GET /admin/api/accounts` 端点**不返回** token 和 cookies（代码 line 133-147 显式过滤），只有 `email`、`state`、`error_count`、`last_error`、`last_used`。

---

## 5. mirror-bypass 令牌机制

### 5.1 设计目的

DeepSeek SPA 是未经修改的原始前端，它期望从 `localStorage.userToken` 读取一个合法的 Bearer token。如果没有该 token，SPA 会跳转到 `/sign-in`（DeepSeek 的登录页）。为了让 SPA 在镜像站上正常工作，需要给它一个"假"的 token。

### 5.2 生命周期

```
1. public/index.html 第 37 行: 注入 "mirror-bypass"
   → localStorage.userToken = { value: "mirror-bypass", __version: "0" }

2. SPA 启动 → 读取 localStorage → 有值 → 不跳转登录页

3. SPA 调用 GET /api/v0/users/current → 服务器返回:
   { data: { biz_data: { token: "mirror-<userId>", ... } } }

4. SPA 的 beAuthenticated handler (main bundle line 33765):
   e.token && T.y.setStorageUserToken(e.token)
   → localStorage.userToken = { value: "mirror-<userId>", __version: "0" }

5. 后续所有请求使用 Authorization: Bearer mirror-<userId>
```

### 5.3 token 前缀格式

当前接受两种格式：
- `mirror-bypass` — 引导阶段使用的固定值
- `mirror-<任意字符串>` — 登录后获得的用户专属值

userId 来自 `POST /sign_in` 设置的 `req.session.userId = user.id`。如果userId为空（例如通过 token bypass 访问），回退为 `'mirror-user'`。

---

## 6. 数据库 Schema

**数据库**: `sessions.db`（SQLite，通过 `sql.js` 操作）  
**初始化**: `db.js` function `init()` — 异步加载 WASM，创建表  
**持久化**: `db.js` function `save()` — `db.export()` → `fs.writeFileSync`  
**注意**: `sql.js` 是内存数据库，每次写操作后必须调用 `save()` 才能落地。

### 6.1 sessions 表

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,         -- UUID
  title         TEXT DEFAULT '',          -- 会话标题
  title_type    TEXT DEFAULT 'DEFAULT',   -- 'USER' | 'DEFAULT'
  updated_at    INTEGER DEFAULT 0,        -- Unix 秒级时间戳
  pinned        INTEGER DEFAULT 0,        -- 0/1
  model_type    TEXT DEFAULT 'deepseek-chat',
  version       INTEGER DEFAULT 1,
  created_at    INTEGER DEFAULT 0
);
```

### 6.2 messages 表

```sql
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,         -- UUID
  session_id    TEXT NOT NULL,            -- 会话 ID
  role          TEXT NOT NULL,            -- 'user' | 'assistant'
  content       TEXT DEFAULT '',
  created_at    INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 6.3 users 表

```sql
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,         -- UUID
  username      TEXT UNIQUE NOT NULL,     -- 登录名
  password_hash TEXT NOT NULL,            -- "salt:hash" 格式
  created_at    INTEGER DEFAULT 0
);
```

### 6.4 accounts 表

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL,            -- Bearer token
  cookies       TEXT NOT NULL,            -- Cookie 字符串
  email         TEXT DEFAULT '',          -- 显示用标识
  state         TEXT DEFAULT 'idle',      -- idle | busy | error
  error_count   INTEGER DEFAULT 0,
  last_error    TEXT DEFAULT '',
  last_used     INTEGER DEFAULT 0
);
```

### 6.5 sql.js 使用注意事项

- `db.prepare(sql)` → 返回 `Statement` 对象
- `stmt.bind([params])` → 绑定参数
- `stmt.step()` → 执行，返回 `true` 代表有行
- `stmt.getAsObject()` → 获取当前行作为对象
- `stmt.free()` → **必须调用！** 释放语句，否则内存泄漏
- `db.run(sql, [params])` → 执行写操作（INSERT/UPDATE/DELETE）
- `db.export()` → 导出整个数据库为 `Uint8Array`

---

## 7. DeepSeek 客户端 (deepseek-client.js)

### 7.1 类: `DeepSeekClient`

```javascript
new DeepSeekClient(token, cookies)
```

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `createSession()` | 无 | `Promise<string>` | 创建上游会话，返回 session_id |
| `chatStream(sessionId, prompt, options)` | sessionId, prompt, { model_type, thinking_enabled, search_enabled } | `AsyncGenerator<object>` | 流式聊天，yield SSE 事件 |
| `checkHealth()` | 无 | `Promise<boolean>` | 测试凭据有效性 |

### 7.2 请求头

```javascript
{
  'Content-Type': 'application/json',
  'Cookie': this.cookies,
  'Authorization': `Bearer ${this.token}`,
  'X-App-Version': '20241129.1',
  'X-Client-Version': '2.0.0',
  'X-Client-Platform': 'web',
  'X-Client-Locale': 'zh_CN',
}
```

PoW 请求额外包含 `'X-DS-PoW-Response': <base64>`。

### 7.3 聊天请求体

```json
{
  "chat_session_id": "<uuid>",
  "parent_message_id": null,
  "model_type": "deepseek-chat",
  "prompt": "User: 你好",
  "ref_file_ids": [],
  "stream": true,
  "thinking_enabled": false,
  "search_enabled": false,
  "preempt": false
}
```

### 7.4 SSE 事件格式 (上游原始)

```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

data: {"v":"Hello"}

data: {"p":"response/fragments/0/content","o":"APPEND","v":" World"}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: close
data: {"click_behavior":"none"}
```

`chatStream()` 逐行解析 SSE，yield 每个 `data:` 行的 JSON parse 结果。

---

## 8. SSE 协议翻译层

**文件**: `server.js` function `handleDeepSeekCompletion()` (lines 449-570)

### 8.1 输入: DeepSeek 原始 SSE

上游 DeepSeek 返回的自定义 SSE 格式，事件类型包括：

| 事件 | data 格式 | 含义 |
|------|-----------|------|
| `ready` | `{request_message_id, response_message_id, model_type}` | 流初始化 |
| (无 event) | `{v: "token"}` | 纯文本 token |
| (无 event) | `{p: "path", o: "SET"\|"APPEND", v: value}` | 操作路径事件 |
| (无 event) | `{p: "response/status", o: "SET", v: "FINISHED"}` | 完成状态 |
| `close` | `{click_behavior: "none"\|"retry"}` | 流关闭 |

### 8.2 输出: SPA 期望的 SSE

SPA 期望的格式与上游基本相同，但需要 `event:` 前缀：

```
event: ready
data: {"response_message_id":"...","request_message_id":"...","model_type":"..."}

event: delta
data: {"o":"SET","p":"response/fragments/0/content","v":"Hello"}

event: delta
data: {"o":"APPEND","p":"response/fragments/0/content","v":" World"}

event: finish
data: {}

event: close
data: {"click_behavior":"none"}
```

### 8.3 翻译逻辑

```javascript
for await (const event of client.chatStream(dsSessionId, prompt, {...})) {
  if (event.v && typeof event.v === 'string') {
    // 纯文本 token → APPEND
    sendDeepSeekSSE(res, 'delta', { o: 'APPEND', p: 'response/fragments/0/content', v: event.v });
  } else if (event.o && typeof event.p === 'string') {
    // 操作事件 → 透传
    sendDeepSeekSSE(res, 'delta', event);
  }
}
```

---

## 9. PoW 求解 (WASM)

### 9.1 原理

DeepSeek Chat 的 API 使用 Proof-of-Work 防止滥用。每次请求前必须求解一个哈希难题。

**约束条件**:
- challenge 有 `expire_at`（Unix 时间戳），过期后不可用
- 每个 challenge 仅对指定 `target_path` 有效
- 难度通过 `difficulty` 参数控制
- 签名验证机制确保 challenge 不被篡改

### 9.2 通信流程

```
1. POST /api/v0/chat/create_pow_challenge
   → body: {"target_path": "/api/v0/chat/completion"}
   → response: { data: { biz_data: { challenge: {
       algorithm, challenge, salt, signature, difficulty, expire_at, target_path
     } } } }

2. WASM 求解 nonce
   → encode(challenge) → WASM 内存
   → encode(prefix = salt + "_" + expire_at + "_") → WASM 内存
   → wasm_solve(stackPtr, chalPtr, chalLen, prefixPtr, prefixLen, difficulty)
   → 从栈上读取 nonce (f64)
   → nonce = 0 表示求解失败

3. 构造 PoW Token
   → base64(json({algorithm, challenge, salt, answer: nonce, signature, target_path}))
   → 放入请求头: X-DS-PoW-Response
```

### 9.3 WASM 导出函数

| 函数 | 参数 | 说明 |
|------|------|------|
| `wasm_solve` | (stack_ptr, chal_ptr, chal_len, prefix_ptr, prefix_len, difficulty_f64) | 核心求解函数 |
| `memory` | — | WASM 线性内存 |
| `__wbindgen_add_to_stack_pointer` | offset (i32) | 栈指针调整 |
| `__wbindgen_export_0` | len (i32) → ptr | malloc |
| `__wbindgen_export_2` | (ptr, len) → void | free |

### 9.4 Node.js WebAssembly vs Python wasmtime

**关键差异**: 
- wasmtime 的导出函数需要额外传入 `store` 作为第一参数
- Node.js 内置 WebAssembly **不需要** store 参数
- 所以调用方式为 `exports.wasm_solve(arg1, arg2, ...)` 而非 `wasmtime` 的 `wasm_solve(store, arg1, ...)`

### 9.5 性能

- 单次求解约 0.1-0.3s（取决于 difficulty）
- `_initWasm()` 在首次调用时初始化，后续复用实例
- 线程安全：Node.js 单线程模型天然安全

### 9.6 WASM 二进制来源

`sha3_wasm_bg.wasm` 从 DeepSeek 前端提取：
1. 打开 `https://chat.deepseek.com` → F12 → Network → 搜索 `sha3_wasm_bg.wasm`
2. 下载并覆盖根目录同名文件

---

## 10. 管理面板

### 10.1 路由

| 端点 | 方法 | 用途 |
|------|------|------|
| `/admin/` | GET | 管理面板 SPA |
| `/admin/api/login` | POST | 管理员登录 |
| `/admin/api/stats` | GET | 请求统计 |
| `/admin/api/accounts` | GET | 账号列表 + 池状态 |
| `/admin/api/accounts` | POST | 添加账号 |
| `/admin/api/accounts/:index` | DELETE | 删除账号 |
| `/admin/api/accounts/:index/relogin` | POST | 重试错误账号 |

### 10.2 认证

- 管理员密码: `ADMIN_PASSWORD` 环境变量（默认 `admin`）
- 管理员用户名: `ADMIN_USERNAME` 环境变量（默认 `admin`）
- 登录返回 64 字符 hex token（服务端内存 Set 存储）
- 所有端点（除 `/login`）通过 `adminAuth` 中间件验证
- 前端 token 存在 `localStorage.admin_token`

### 10.3 统计

`StatsSnapshot` 类追踪：`total_requests`、`success_requests`、`failed_requests`、`total_latency_ms`、`start_time`。统计在 `handleDeepSeekCompletion` 调用前后通过 `recordStat()` 记录。

### 10.4 前端架构

- 纯 HTML + JS + CSS，零 npm/build 依赖
- 通过 Express 静态文件挂载在 `/admin/` 路径
- Hash 路由（`#dashboard` / `#accounts`）
- 概览页每 5 秒轮询 stats + accounts API

---

## 11. 账号池

### 11.1 状态流转

```
添加 → idle
        │
  getAvailableAccount() → busy → releaseAccount() → idle
        │
        └──→ error ←── handleDeepSeekCompletion catch
                     └──→ admin relogin → idle 或保持 error
```

### 11.2 分配策略

`getAvailableAccount()` 遍历 `db.getAllAccounts()`，返回第一个 `state === 'idle'` 的账号，调用 `db.updateAccountState(acct.id, 'busy')`。

如果所有账号都 busy，返回 `null` → `handleDeepSeekCompletion` 显示 "没有可用账号" toast。

### 11.3 错误处理

上游 API 调用失败时（`handleDeepSeekCompletion` catch 块），调用 `db.updateAccountState(acct.id, 'error', err.message)`，增加 error_count 并记录错误原因。错误账号需要管理员在面板点击"重登"恢复。

---

## 12. 已知问题与边界情况

### 12.1 Session 不持久化

`express-session` 使用默认的 `MemoryStore`，重启后所有用户 session 丢失，需重新登录。如需持久化，需添加 `connect-sqlite3` 等外部 session store。

### 12.2 账号池凭据过期

DeepSeek 的 Bearer token 和 Cookie 会过期（通常数小时到数天）。过期后账号状态变为 `error`，需管理员在面板更新凭据。目前**没有自动续期机制**。

### 12.3 SPA 的 XHR withCredentials=false

DeepSeek SPA 的 HTTP 客户端（lyla）默认使用 `withCredentials = false`，意味着 API 请求**不发送 cookie**。这是引入 token bypass 中间件的直接原因。

### 12.4 PoW 求解偶尔失败

极少数情况下 WASM 求解返回 0（无解），抛出 `"WASM solver found no solution"`。调用方应重试整个流程（`handleDeepSeekCompletion` 目前不自动重试）。

### 12.5 管理面板 admin 账号不可通过 SQLite 管理

管理面板的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅通过环境变量配置，不在 `users` 表中。这意味着：
- 不能通过注册页创建管理员账号
- 管理员密码修改需要编辑 `.env` 后重启服务器

### 12.6 没有 HTTPS

默认使用 HTTP。如需 HTTPS，建议在前面加反向代理（nginx、Caddy）。

### 12.7 服务端 `fetch` timeouts

`deepseek-client.js` 使用 Node.js 内置 `fetch()`，默认 timeout 由操作系统决定。长时间思考（专家模式 > 60s）可能触发 timeout。如需设置自定义 timeout，需使用 `AbortController`。

### 12.8 账号池并发限制

所有用户共享同一个账号池。N 个账号最多支持 N 个并发聊天。超出时返回 "没有可用账号"。

### 12.9 `.env` 变更需重启

`server.js` 在模块加载时调用 `require('dotenv').config()`，修改 `.env` 后必须重启服务器。

---

## 13. 常见调试方法

### 13.1 测试 PoW + 上游连接

```bash
node -e "
const DeepSeekClient = require('./deepseek-client');
const c = new DeepSeekClient('your-token', 'your-cookies');
c.checkHealth().then(r => console.log('Health:', r));
"
```

### 13.2 测试 WASM 加载

```bash
node -e "
const fs = require('fs');
const buf = fs.readFileSync('./sha3_wasm_bg.wasm');
const mod = new WebAssembly.Module(buf);
const inst = new WebAssembly.Instance(mod, {});
console.log('WASM exports:', Object.keys(inst.exports));
"
```

### 13.3 查看 SSE 原始事件

在 `handleDeepSeekCompletion` 中添加日志：
```javascript
for await (const event of client.chatStream(...)) {
  console.log('SSE event:', JSON.stringify(event));
  // ...
}
```

### 13.4 测试 auth 中间件

```bash
# 带 token
curl -H "Authorization: Bearer mirror-bypass" http://localhost:3000/api/v0/chat_session/create -X POST

# 不带 token (应 401)
curl http://localhost:3000/api/v0/chat_session/create -X POST
```

### 13.5 检查数据库内容

```bash
node -e "
const db = require('./db');
db.init().then(() => {
  console.log('Users:', JSON.stringify(db.getAllAccounts()));
  console.log('Sessions:', db.getSessionCount());
});
"
```

### 13.6 排查步骤

1. 服务器启动了吗？`http://localhost:3000/` 能打开吗？
2. 管理员面板能登录吗？`http://localhost:3000/admin/`
3. 账号池有账号吗？`admin/#accounts`
4. 用户能注册/登录吗？
5. SPA 能加载吗？检查浏览器 console 有无 JS 错误
6. 查看 `server.js` 控制台输出

---

## 14. 配置系统

### 14.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ADMIN_USERNAME` | `admin` | 管理面板用户名 |
| `ADMIN_PASSWORD` | `admin` | 管理面板密码 |
| `NODE_ENV` | `production` | 运行模式（hardcoded） |

### 14.2 Account Pool 配置

账号池通过管理面板动态添加，无需 env 配置。如需初始化默认账号，可直接编辑 `sessions.db` 的 `accounts` 表，或通过管理 API 添加。

---

## 15. 约定与编码规范

### 15.1 代码风格

- 2 空格缩进
- 无分号（JavaScript）
- 使用 `const`/`let`，不使用 `var`
- 异步函数使用 `async`/`await`
- 驼峰命名（camelCase）

### 15.2 API 响应格式

所有 mock API 遵循 DeepSeek 原始格式：
```json
{
  "data": {
    "biz_data": { ... },
    "biz_code": 0
  }
}
```

### 15.3 SSE 格式

```javascript
function sendDeepSeekSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

### 15.4 路由注册顺序 (server.js)

路由注册顺序**至关重要**，按以下顺序：
1. `POST /sign_in` / `POST /sign_up` (认证)
2. Admin API (POST/GET admin)
3. `app.use('/admin', express.static(...))`
4. Token bypass middleware
5. User auth middleware
6. Mock user APIs (`/api/v0/users*`, `/api/v0/current`)
7. Mock chat APIs (`/api/v0/chat_session/*`)
8. Translation layer (`/api/v0/chat/completion` 等)
9. CDN/HIF proxies
10. Static files + SPA fallback (`app.get('*', ...)`)

### 15.5 测试

当前项目无自动化测试。手动测试覆盖：
- 用户注册/登录流程
- 管理面板登录 + 账号管理
- SPA 加载 + 会话创建
- 聊天 SSE 流
- 数据库持久化（重启测试）

---

> 本文档最后更新：2026-06-05
> 基于 `chat.deepseek.com` HAR 抓包分析
> WASM 引擎版本：`sha3_wasm_bg.wasm`
