<!-- markdownlint-disable MD033 MD041 -->

<div align="center">

# DeepSeek Mirror

**Self-hosted DeepSeek Chat mirror · Experimental**

[![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-21%2F21_passing-brightgreen?logo=github)](https://github.com/snake-aabb-wtf/deepseek-mirror/actions)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Version](https://img.shields.io/badge/version-1.1.0-blue)](./CHANGELOG.md)
[![Warning](https://img.shields.io/badge/status-experimental-orange)](#)

> ⚠️ **Warning: This is an experimental reverse-engineering project. It is incomplete and has known bugs.**
> **Not suitable for production use. For educational and research purposes only.**

</div>

---

## Table of Contents

- [Disclaimer](#disclaimer)
- [Overview](#overview)
- [How It Works](#how-it-works)
  - [What is DeepSeek Mirror?](#what-is-deepseek-mirror)
  - [Why not use the official API?](#why-not-use-the-official-api)
  - [Technical Decisions](#technical-decisions)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
  - [Three-Layer Auth System](#three-layer-auth-system)
  - [Complete Chat Request Flow](#complete-chat-request-flow)
- [Deployment Guide](#deployment-guide)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Step 1: Add an Upstream Account](#step-1-add-an-upstream-account)
- [Configuration](#configuration)
- [Admin Panel](#admin-panel)
- [Tech Stack](#tech-stack)
- [Roadmap / TODO](#roadmap--todo)
- [License](#license)

---

## Disclaimer

- This project reverse-engineers the frontend and private API of `chat.deepseek.com`. **It is not affiliated with DeepSeek in any way.**
- This project **does not provide** DeepSeek accounts, tokens, or cookies. Users must obtain their own.
- DeepSeek's terms of service may prohibit this type of proxy/reverse-engineering. Use at your own risk.
- **Known issues abound** — see the [Roadmap / TODO](#roadmap--todo) section.
- For educational and research purposes only. Not for commercial use or large-scale distribution.

---

## Overview

DeepSeek Mirror is an **experimental self-hosted DeepSeek Chat solution**. It reverse-engineers the frontend SPA and private API protocol of `chat.deepseek.com`, packaging the entire web app as a standalone mirror service.

Core capabilities:

- **Complete frontend** — original SPA scraped from `chat.deepseek.com`, 100% native UI
- **No official API key needed** — uses an account pool + WASM PoW solving to connect via the free web API
- **Multi-user isolation** — built-in registration/login, per-user session history persisted in SQLite
- **Admin panel** — visual management of the upstream account pool and request statistics

---

## How It Works

### What is DeepSeek Mirror?

DeepSeek offers two ways to use its models:

1. **Web app** (chat.deepseek.com) — free, but has anti-scraping (PoW + Cloudflare) and uses a private API protocol
2. **Official API** (api.deepseek.com) — paid, standard OpenAI-compatible protocol

DeepSeek Mirror bridges the gap: **it wraps the free web app's private API into a self-hosted service, reusing the web app's free quota.**

```
Web app:     Browser → chat.deepseek.com (private API)
Official API: Program → api.deepseek.com (OpenAI protocol, paid)

This mirror: Browser → Mirror Server → chat.deepseek.com (private API, free)
```

### Why not use the official API?

- The official API charges per token, which gets expensive for heavy users
- The web app is free and offers essentially the same model quality
- But the web app has PoW anti-scraping + a private protocol, making it inaccessible to standard tooling

DeepSeek Mirror solves both problems: automated PoW solving and private protocol translation.

### Technical Decisions

- **Why Node.js instead of Python (the original web2api approach)?**  
  The original `web2api` project was a separate Python FastAPI service (Browser → Node mirror → Python web2api → DeepSeek). Each extra hop is a potential failure point. This project reimplements web2api's core functionality (PoW solving, SSE parsing) using Node.js native WebAssembly, eliminating the Python dependency.

- **Why SQLite instead of MySQL/PostgreSQL?**  
  This is a single-machine deployment. SQLite is zero-config, single-file, needs no separate process — ideal for Node.js. `sql.js` keeps data in memory and syncs to disk; nothing is lost on restart.

- **Why doesn't cookie auth work with the SPA?**  
  DeepSeek's SPA uses `XMLHttpRequest` with `withCredentials = false` (vendors bundle line 1710), so the browser never sends session cookies with API requests. However, the SPA's HTTP client (lyla) automatically adds `Authorization: Bearer <token>` from `localStorage` (main bundle line 2032-2051). Therefore, the mirror implements a token bypass middleware that recognizes the SPA's `mirror-*` tokens instead of relying on cookies. See [Three-Layer Auth System](#three-layer-auth-system).

- **What is PoW?**  
  Proof-of-Work is DeepSeek's anti-abuse mechanism. Each API call requires solving a SHA3 hash puzzle (~0.1-0.3s). The solver engine is embedded as WASM in DeepSeek's frontend. This mirror extracts that WASM and calls it directly via Node.js's built-in `WebAssembly` API.

---

## Quick Start

### Prerequisites

- Node.js 20+ (24 recommended)
- npm
- A DeepSeek web app account

### Install

```bash
cd deepseek-mirror
npm install
```

### Configure (mandatory: SESSION_SECRET + DB_ENCRYPT_KEY)

```bash
cp .env.example .env
# Auto-generate keys:
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('hex'))" >> .env
node -e "console.log('DB_ENCRYPT_KEY=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
```

### Start (pick one)

```bash
node server.js                      # Plain
./start.sh                          # Linux/macOS one-liner (auto-generates keys + npm ci)
pm2 start ecosystem.config.cjs      # PM2 process manager
docker compose up -d                # Docker
```

> If `ADMIN_PASSWORD` is empty, the server prints a **one-time** temporary admin password to the console on first start.  
> The SQLite `sessions.db` is auto-created on first start (better-sqlite3 format). Legacy sql.js DBs are auto-migrated.

### Deployment Options

| Method | Command | Use Case |
|--------|---------|----------|
| Plain | `node server.js` | Dev / quick test |
| One-liner | `./start.sh` | Linux/macOS quick deploy |
| PM2 | `pm2 start ecosystem.config.cjs` | Long-running (auto-restart) |
| Docker | `docker compose up -d` | Containerized (auto-restart + volume) |

**Docker volume**: `mirror-data` named volume persists `sessions.db` and `.env`.

### Monitoring

- **Health check**: `GET /auth.css` (Docker HEALTHCHECK)
- **Prometheus metrics**: `GET /metrics` (11 metrics)
- **Admin panel**: `/admin/` (account pool + stats + live refresh)

### Step 1: Add an Upstream Account

The account pool is empty on first start. You need to add a DeepSeek account:

1. Open `http://localhost:3000/admin/` → login with `admin / admin`
2. Go to "Account Pool" tab
3. Click "Add" and fill in:

   | Field | How to get it |
   |-------|---------------|
   | **Token** | Login to `chat.deepseek.com` → F12 → Network → any request → Request Headers → copy `Authorization: Bearer <...>` (the part after "Bearer ") |
   | **Cookies** | Same request → copy `Cookie: <...>` (the full string) |

---

## Architecture

```
┌─ User Browser ──────────────────────────────────────────────────────────┐
│                                                                          │
│  SPA (original DeepSeek frontend, unmodified)                            │
│                                                                          │
│  ① index.html injects: localStorage.userToken = "mirror-bypass"          │
│                                                                          │
│  ② SPA starts → reads localStorage → thinks logged in → calls users API │
│     → Server returns { token: "mirror-<user-UUID>", ... }                │
│     → SPA replaces localStorage with "mirror-<user-UUID>"                │
│                                                                          │
│  ③ Every subsequent API request:                                         │
│     Authorization: Bearer mirror-<user-UUID>                             │
│     (XHR withCredentials=false → no cookies sent)                       │
│                                                                          │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ POST /api/v0/chat/completion
                           ▼
┌─ Mirror Server (Express) ───────────────────────────────────────────────┐
│                                                                          │
│  ┌── Gate 1: Static Files ─────────────────────────────────────────┐    │
│  │  express.static → SPA assets (index.html, JS, CSS, fonts)       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                            │                                            │
│  ┌── Gate 2: Token Bypass ────────────────────────────────────────┐    │
│  │  Checks Authorization header → if "mirror-bypass"                │    │
│  │  or "mirror-<xxx>" → set session.authenticated = true → pass     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                            │                                            │
│  ┌── Gate 3: User Auth ───────────────────────────────────────────┐    │
│  │  session.authenticated? → pass / 401                             │    │
│  │  /sign_in and /sign_up bypass                                    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                            │                                            │
│  ┌── Route Dispatch ───────────────────────────────────────────────┐    │
│  │  /sign_in → verify password → set session                         │    │
│  │  /sign_up → register → insert SQLite users                        │    │
│  │  /api/v0/users* → mock user info + per-user token                │    │
│  │  /api/v0/current → mock user info                                 │    │
│  │  /api/v0/chat_session/* → SQLite CRUD                             │    │
│  │  /api/v0/chat/completion → handleDeepSeekCompletion translation   │    │
│  │  * → serve SPA (index.html)                                      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                            │                                            │
│  ┌── Translation Layer handleDeepSeekCompletion() ──────────────────┐    │
│  │                                                                  │    │
│  │  Step 1: Check session auth                                      │    │
│  │  Step 2: Save user message to SQLite messages table               │    │
│  │  Step 3: getAvailableAccount() → pick idle account               │    │
│  │  Step 4: new DeepSeekClient(token, cookies)                      │    │
│  │  Step 5: WASM PoW solving                                        │    │
│  │  Step 6: Create upstream session (with PoW header)               │    │
│  │  Step 7: Stream chat (with PoW header) → upstream SSE stream     │    │
│  │  Step 8: Translate upstream SSE → SPA SSE format                 │    │
│  │  Step 9: Save assistant message to SQLite                        │    │
│  │  Step 10: releaseAccount()                                       │    │
│  │                                                                  │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                            │                                            │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ POST /api/v0/chat/completion
                             │ Authorization: Bearer <real Token>
                             │ Cookie: <real Cookies>
                             │ X-DS-PoW-Response: <PoW solution>
                             ▼
┌─ chat.deepseek.com ────────────────────────────────────────────────────┐
│  DeepSeek native API:                                                    │
│  - Validates Authorization + Cookie                                      │
│  - Validates X-DS-PoW-Response                                           │
│  - Creates session → SSE stream response                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### Three-Layer Auth System

```
┌── Layer 1: Mirror User Auth ──────────────────────────────────────────┐
│  Entry: /sign_up → /sign_in                                           │
│  Credentials: username + password (scrypt hash, stored in SQLite)     │
│  Result: session cookie (connect.sid)                                  │
│  Note: sessions lost on restart, user must re-login                   │
├── Layer 2: SPA Token Bypass ──────────────────────────────────────────┤
│  Entry: index.html inline script injects localStorage.userToken        │
│  Flow: "mirror-bypass" → /users API → "mirror-<UUID>"                  │
│  Result: Authorization: Bearer mirror-<UUID>                           │
│  Note: solves SPA's no-cookie problem, see below                      │
├── Layer 3: Upstream DeepSeek Account Pool ────────────────────────────┤
│  Entry: Admin panel /admin/#accounts                                   │
│  Credentials: Bearer Token + Cookie string (stored in SQLite)          │
│  Usage: pick idle account on chat → connect upstream                   │
│  Security: regular users never access this layer                       │
└────────────────────────────────────────────────────────────────────────┘
```

**Why three layers?** DeepSeek SPA's HTTP library uses `XMLHttpRequest` with `withCredentials = false` (vendors bundle line 1710), so session cookies are never sent with API requests. However, lyla automatically reads `localStorage.userToken` and adds `Authorization: Bearer <token>` to every request (main bundle line 2032-2051).

The architectural decisions:
- Can't rely on cookies → added token bypass middleware recognizing `mirror-*` tokens
- Where do tokens come from? → injected temporary value from index.html, then per-user value from mock users API
- Where do real upstream credentials go? → admin-managed account pool, server-side only, never exposed

### Complete Chat Request Flow

```
① User types message → clicks send in SPA

② SPA calls createSession()
   → POST /api/v0/chat_session/create
   → Authorization: Bearer mirror-<uuid>
   → Server returns fake UUID (SQLite insert)

③ SPA calls chat completion
   → POST /api/v0/chat/completion
   → Body: { chat_session_id, prompt, model_type, thinking_enabled }
   → Authorization: Bearer mirror-<uuid>

④ Server receives request
   → Token bypass: "mirror-xxx" → auth ok
   → handleDeepSeekCompletion()

⑤ Pick idle account from pool
   → None available → toast "没有可用账号" → abort
   → Got one → mark busy

⑥ new DeepSeekClient(token, cookies)
   → createSession() → PoW solve → upstream session created

⑦ chatStream()
   → PoW solve → POST upstream /api/v0/chat/completion
   → Upstream returns SSE stream

⑧ Translation layer parses upstream SSE events:
   {v:"Hello"} → event:delta {o:APPEND, p:"response/.../content", v:"Hello"}
   → SPA renders the response in real-time

⑨ Release account (releaseAccount → state back to idle)
```

---

## Deployment Guide

### Prerequisites

- Node.js 24+ (built-in fetch + WebAssembly support)
- npm
- A DeepSeek web app account (to obtain Token + Cookies)

### Install

```bash
cd deepseek-mirror
npm install
```

Dependencies:

| Package | Purpose |
|---------|---------|
| `express` | Web framework |
| `express-session` | Session management |
| `http-proxy-middleware` | CDN reverse proxy |
| `sql.js` | SQLite database (WASM build) |
| `dotenv` | `.env` file loading |

> No need for `wasmtime` or any Python dependencies. PoW solving uses Node.js built-in `WebAssembly`.

### Step 1: Add an Upstream Account

The mirror has no embedded DeepSeek accounts. After starting, add one via the admin panel:

1. `http://localhost:3000/admin/` → login (default `admin / admin`)
2. Go to "Account Pool" tab
3. Add a DeepSeek account:

   ```
   Token:   From chat.deepseek.com request headers
   Cookie:  From chat.deepseek.com request headers
   ```

**How to obtain Token and Cookie:**

1. Open `https://chat.deepseek.com` in Chrome/Edge and log in
2. Press F12 → Network tab
3. Do something on the page (send a message or start a new chat)
4. Find any request to `chat.deepseek.com` in the list
5. Click the request → Headers → Request Headers

   | What to copy | Where to find it |
   |-------------|-----------------|
   | **Token** | `Authorization: Bearer <long string>` — copy the part after "Bearer " |
   | **Cookies** | `Cookie: <everything here>` — copy the full string |

---

## Configuration

Via `.env` file (copy from `.env.example`):

```env
# Server port (default 3000)
PORT=3000

# Admin panel credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin
```

All settings are optional — defaults are used if not set.

---

## Admin Panel

| Page | Route | Features |
|------|-------|----------|
| Login | `/admin/` | Admin auth |
| Dashboard | `#dashboard` | Request stats + account pool status (auto-refresh 5s) |
| Account Pool | `#accounts` | Add/delete/relogin DeepSeek accounts |

**Admin API endpoints (JSON):**

| Method | Path | Purpose | Body |
|--------|------|---------|------|
| POST | `/admin/api/login` | Login | `{username, password}` |
| GET | `/admin/api/stats` | Statistics | — |
| GET | `/admin/api/accounts` | List accounts | — |
| POST | `/admin/api/accounts` | Add account | `{token, cookies, email?}` |
| DELETE | `/admin/api/accounts/:index` | Delete | — |
| POST | `/admin/api/accounts/:index/relogin` | Retry | — |

> Admin auth is completely independent from user auth. Admin credentials come from environment variables; user accounts are created via the registration page.

---

## Tech Stack

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Runtime | Node.js | 24+ | Built-in fetch + WebAssembly, zero external deps |
| Web Framework | Express | 4.x | Most popular Node.js web framework |
| Database | SQLite (sql.js) | 1.x | WASM-based, zero config, single file |
| Session | express-session | 1.x | Memory store — sessions lost on restart |
| WASM | sha3_wasm_bg.wasm | — | Extracted from DeepSeek's frontend |
| Frontend SPA | Original DeepSeek | — | Reverse-engineered, unmodified, native UI |
| Admin Panel | Vanilla HTML/CSS/JS | — | Zero build tools, no npm dev deps |
| Password Hashing | crypto.scryptSync | — | Node.js built-in |

---

## Roadmap / TODO

> Detailed change log: [CHANGELOG.md](./CHANGELOG.md)

### Fixed in v1.1.0

- [x] **Session security** — `httpOnly + secure + sameSite` cookies + regenerate (PR-0)
- [x] **Plaintext credentials in DB** — AES-256-GCM encryption (PR-1)
- [x] **IDOR (cross-user access)** — all db ops use userId (PR-3)
- [x] **admin token XSS risk** — httpOnly cookie replaces localStorage (PR-4)
- [x] **WASM memory grow buffer detached** — pre-grow 16 pages (PR-2)
- [x] **Weak passwords** — 10 chars + complexity (PR-0)
- [x] **Timing attack / username enumeration** — timingSafeEqual + unified errors (PR-0)
- [x] **fetch timeout** — 30s total + 10min SSE idle (PR-2)
- [x] **Concurrent account collision** — SQL RETURNING atomic (PR-3)
- [x] **PoW failure no retry** — 2 retries + resp.ok check (PR-2)
- [x] **Docker deployment** — Dockerfile + docker-compose (PR-5)
- [x] **Usage stats** — outcome breakdown + Prometheus metrics (PR-3/5)
- [x] **Structured logging** — pino + components (PR-4)
- [x] **Dependency CVE** — http-proxy-middleware 2.0.10 (PR-5)

### Still TODO

- [ ] **Persistent sessions** — in-memory store loses data on restart (Redis recommended)
- [ ] **No auto-refresh for account credentials** — manual update required on expiry
- [ ] **Light/dark theme toggle** — currently dark-only
- [ ] **Custom welcome page** — replace DeepSeek's default landing
- [ ] **SQLite-based admin accounts** — admin password editable from panel
- [ ] **HTTPS** — HTTP only; needs nginx/Caddy in front
- [ ] **Multimodal** — DeepSeek protocol doesn't expose image upload
- [ ] **Function calling** — DSML/tools (requires SPA modification)
- [ ] **OpenAI-compatible API** — `/v1/chat/completions` standard endpoint

### Known Limitations

- **Cannot use simultaneously with the official DeepSeek web app** — tokens/cookies were extracted from the same browser, sessions may conflict
- **Upstream protocol may change** — DeepSeek may update their frontend or API at any time, breaking the mirror
- **WASM PoW may occasionally fail** — even with retries, upstream challenges can be unsolvable

---

## License

MIT
