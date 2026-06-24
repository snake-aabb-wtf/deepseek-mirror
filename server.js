require('dotenv').config();

// [PR-0.10] 允许 .env 覆盖 NODE_ENV；未设置时再回退 production
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const DeepSeekClient = require('./deepseek-client');
const { AdminTokenStore } = require('./lib/admin-tokens');
const { AccountPool } = require('./lib/account-pool');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// [PR-0.3] SESSION_SECRET 未配置时拒绝启动（fail-fast）
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('[FATAL] SESSION_SECRET environment variable is required (>= 32 chars).');
  console.error('  Set it in .env or shell, e.g.:');
  console.error('    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" | (read SECRET; echo "SESSION_SECRET=$SECRET" >> .env)');
  process.exit(1);
}

// [PR-0.4] 默认 admin 凭据：未设置时生成临时密码并打印
function ensureAdminDefaults() {
  let username = process.env.ADMIN_USERNAME;
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!username) {
    username = 'admin';
    process.env.ADMIN_USERNAME = username;
  }
  if (!password || password === 'admin') {
    password = crypto.randomBytes(12).toString('base64url');
    process.env.ADMIN_PASSWORD = password;
    generated = true;
  }
  return { username, password, generated };
}

const ADMIN_BOOT = ensureAdminDefaults();
const ADMIN_USERNAME = ADMIN_BOOT.username;
const ADMIN_PASSWORD = ADMIN_BOOT.password;
const ADMIN_TOKENS = new AdminTokenStore();

// ── Account pool ─────────────────────────────────────────────
// Persisted in SQLite via db.js

// ── Stats ────────────────────────────────────────────────────
// [PR-3.4] outcome 枚举：success | no_account | upstream_error | client_disconnect
const stats = {
  total_requests: 0,
  success_requests: 0,
  failed_requests: 0,
  no_account_requests: 0,
  upstream_errors: 0,
  client_disconnects: 0,
  total_latency_ms: 0,
  start_time: Date.now(),
};

function recordStat(outcome, latencyMs) {
  stats.total_requests++;
  switch (outcome) {
    case 'success':
      stats.success_requests++;
      break;
    case 'no_account':
      stats.no_account_requests++;
      stats.failed_requests++;
      break;
    case 'upstream_error':
      stats.upstream_errors++;
      stats.failed_requests++;
      break;
    case 'client_disconnect':
      stats.client_disconnects++;
      stats.failed_requests++;
      break;
    default:
      stats.failed_requests++;
  }
  stats.total_latency_ms += latencyMs;
}

// [PR-0.10] 顶层错误处理
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // 优雅退出，让进程管理器拉起
  setTimeout(() => process.exit(1), 200);
});

// [PR-0.7] helmet 默认安全头（注意：SPA 用了 inline script，要放宽 CSP）
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// [PR-0.3] Session 配置：显式 httpOnly/secure/sameSite
app.use(session({
  name: 'ds.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax',
  },
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// [PR-0.7] 限流：登录/注册
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// [PR-0.7] 限流：管理 API
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// [PR-0.7] 限流：聊天接口（防止账号池被单 IP 耗尽）
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// 简单的 flash message 中间件（用于登录/注册错误回显）
app.use((req, res, next) => {
  // 读取并清空 flash（仅在读取时清空）
  res.locals.flash = (req.session && req.session._flash) || null;
  if (req.session) {
    req.session._flash = null;
    req.flash = (type, msg) => {
      req.session._flash = { type, msg };
    };
  }
  next();
});

app.get('/sign_in', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/sign_in', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  // [PR-0.8] 即使用户不存在也走一次 scrypt 防时序枚举
  const user = db.getUserByUsername(String(username || ''));
  const valid = user ? db.verifyPassword(user, String(password || '')) : false;
  if (user && valid) {
    // [PR-0.3] 防 session fixation：重新生成 session id
    // 兜底：regenerate 在某些 race condition 下不发 Set-Cookie，
    //     这里用 saveUninitialized:false 配合显式 save 确保 Set-Cookie 被发送。
    req.session.regenerate((err) => {
      if (err) {
        console.error('session.regenerate error:', err);
        return res.status(500).send('Session error');
      }
      req.session.authenticated = true;
      req.session.userId = user.id;
      req.session.username = user.username;
      req.flash('ok', '登录成功');
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('session.save error:', saveErr);
          return res.status(500).send('Session error');
        }
        // 兜底：某些中间件顺序下 express-session 的 onHeaders 不发 Set-Cookie
        if (!res.getHeader('Set-Cookie') && req.sessionID) {
          const sig = require('cookie-signature').sign(req.sessionID, process.env.SESSION_SECRET);
          const cookieSerialize = require('cookie').serialize;
          const cookieStr = cookieSerialize('ds.sid', 's:' + sig, {
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60,
          });
          res.setHeader('Set-Cookie', cookieStr);
        }
        res.redirect('/');
      });
    });
    return;
  }
  req.flash('err', '账号或密码错误');
  res.redirect('/sign_in');
});

app.post('/api/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.redirect('/sign_in'));
  } else {
    res.redirect('/sign_in');
  }
});

app.get('/sign_up', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'sign_up.html'));
});

// [PR-0.5] 密码强度：≥10 位 + 必须含大小写字母 + 数字
function isStrongPassword(p) {
  if (typeof p !== 'string' || p.length < 10) return false;
  if (!/[a-z]/.test(p)) return false;
  if (!/[A-Z]/.test(p)) return false;
  if (!/[0-9]/.test(p)) return false;
  return true;
}

// [PR-0.8] 用户名校验：3-32 位字母数字下划线连字符
function isValidUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_-]{3,32}$/.test(u);
}

app.post('/sign_up', authLimiter, (req, res) => {
  const { username, password, confirm_password } = req.body || {};
  // [PR-0.8] 统一错误提示，防用户名/密码策略枚举
  const fail = (msg) => {
    req.flash('err', msg);
    res.redirect('/sign_up');
  };
  if (!isValidUsername(username)) return fail('注册失败：用户名需 3-32 位字母/数字/下划线/连字符');
  if (!isStrongPassword(password)) return fail('注册失败：密码至少 10 位且包含大小写字母和数字');
  if (password !== confirm_password) return fail('注册失败：两次密码不一致');
  if (db.getUserByUsername(username)) return fail('注册失败：用户名已存在');
  const user = db.createUser(username, password);
  if (!user) return fail('注册失败：服务器错误，请重试');
  req.flash('ok', '注册成功，请登录');
  res.redirect('/sign_in');
});

// ── Admin auth middleware ────────────────────────────────────
function adminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/, '').trim();
  if (ADMIN_TOKENS.has(token)) return next();
  res.status(401).json({ detail: 'Unauthorized' });
}

// ── Admin API routes ─────────────────────────────────────────
app.post('/admin/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  // [PR-0.4] 密码比对用恒定时间
  const u = String(username || '');
  const p = String(password || '');
  const uMatch = u.length === ADMIN_USERNAME.length &&
    crypto.timingSafeEqual(Buffer.from(u), Buffer.from(ADMIN_USERNAME));
  const pMatch = p.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(p), Buffer.from(ADMIN_PASSWORD));
  if (!uMatch || !pMatch) {
    return res.status(403).json({ detail: 'Invalid credentials' });
  }
  const token = ADMIN_TOKENS.issue();
  res.json({ token });
});

app.get('/admin/api/stats', adminLimiter, adminAuth, (req, res) => {
  const uptime = Math.floor((Date.now() - stats.start_time) / 1000);
  const avg = stats.total_requests > 0 ? Math.round(stats.total_latency_ms / stats.total_requests) : 0;
  res.json({
    total_requests: stats.total_requests,
    success_requests: stats.success_requests,
    failed_requests: stats.failed_requests,
    no_account_requests: stats.no_account_requests,
    upstream_errors: stats.upstream_errors,
    client_disconnects: stats.client_disconnects,
    avg_latency_ms: avg,
    uptime_secs: uptime,
    admin_tokens_active: ADMIN_TOKENS.size(),
  });
});

app.get('/admin/api/accounts', adminLimiter, adminAuth, (req, res) => {
  const all = db.getAllAccounts();
  res.json({
    accounts: all.map(a => ({
      // [PR-3.3] 返回 id 用于 :id API
      id: a.id,
      email: a.email,
      state: a.state,
      error_count: a.error_count,
      last_error: a.last_error,
      last_used: a.last_used,
      // 故意不返回 token/cookies
    })),
    total: all.length,
    idle: all.filter(a => a.state === 'idle').length,
    busy: all.filter(a => a.state === 'busy').length,
    error: all.filter(a => a.state === 'error').length,
  });
});

app.post('/admin/api/accounts', adminLimiter, adminAuth, (req, res) => {
  const { token, cookies, email } = req.body || {};
  if (!token || !cookies) {
    return res.status(400).json({ detail: 'Token and cookies required' });
  }
  const id = db.createAccount(token, cookies, email);
  res.json({ ok: true, email: email || `acc-${id}` });
});

// 取当前 session userId（无则用 mirror-user）
function uid(req) {
  return (req.session && req.session.userId) || 'mirror-user';
}

// [PR-3.3] :index -> :id（避免多 admin 并发时下标错位）
app.delete('/admin/api/accounts/:id', adminLimiter, adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ detail: 'Invalid id' });
  }
  const acct = db.getAccountById(id);
  if (acct) {
    db.deleteAccount(id);
    res.json({ ok: true });
  } else {
    res.status(404).json({ detail: 'Account not found' });
  }
});

app.post('/admin/api/accounts/:id/relogin', adminLimiter, adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(404).json({ ok: false, message: 'Invalid id' });
  }
  const acct = db.getAccountById(id);
  if (!acct) {
    return res.status(404).json({ ok: false, message: 'Account not found' });
  }
  if (acct.state !== 'error') {
    return res.json({ ok: true, message: 'Account is not in error state' });
  }
  try {
    const client = new DeepSeekClient(acct.token, acct.cookies);
    const ok = await client.checkHealth();
    if (ok) {
      db.resetAccountErrors(acct.id);
      res.json({ ok: true, message: 'ok' });
    } else {
      throw new Error('Health check failed');
    }
  } catch (err) {
    db.updateAccountState(acct.id, 'error', err.message);
    res.json({ ok: false, message: err.message });
  }
});

app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ── Token bypass middleware (Accept SPA's Authorization header) ──
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token && (token === 'mirror-bypass' || token.startsWith('mirror-'))) {
    req.session.authenticated = true;
    return next();
  }
  next();
});

// ── User auth middleware ─────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/admin')) return next();
  if (req.session.authenticated) {
    return next();
  }
  if (req.path === '/sign_in' || req.path.startsWith('/sign_in/') ||
      req.path === '/sign_up' || req.path.startsWith('/sign_up/')) {
    return next();
  }
  if (req.path === '/') {
    return res.redirect('/sign_in');
  }
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/sign_in');
});

// Mock user API
app.get('/api/v0/users*', (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    data: {
      biz_data: {
        id: "mirror-user",
        email: "mirror@localhost",
        nickname: "镜像用户",
        avatar: "",
        token: "mirror-" + (req.session.userId || 'mirror-user'),
        is_new_user: false,
        chat: { max_history_days: 999 },
        settings: {
          theme: "dark",
          language: "zh-CN",
          font_size: 16
        }
      }
    }
  });
});

app.get('/api/v0/current', (req, res) => {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    data: {
      biz_data: {
        id: "mirror-user",
        email: "mirror@localhost",
        nickname: "镜像用户",
        avatar: "",
        token: "mirror-" + (req.session.userId || 'mirror-user'),
        is_new_user: false,
        chat: { max_history_days: 999 },
        settings: {
          theme: "dark",
          language: "zh-CN",
          font_size: 16
        }
      }
    }
  });
});

// ---- Mock chat endpoints ----

app.post('/api/v0/chat_session/create', (req, res) => {
  const session = db.createSession(undefined, uid(req));
  res.json({
    data: {
      biz_data: {
        id: session.id,
        chat_session: {
          id: session.id,
          title: session.title,
          updated_at: session.updated_at,
          title_type: session.title_type,
          pinned: !!session.pinned,
          model_type: session.model_type,
          version: session.version
        },
        ttl_seconds: 259200
      }
    }
  });
});

app.get('/api/v0/chat_session/fetch_page', (req, res) => {
  const cursor = {};
  if (req.query['lte_cursor.pinned'] !== undefined) {
    cursor.pinned = req.query['lte_cursor.pinned'] === 'true';
  }
  if (req.query['lte_cursor.updated_at'] !== undefined && req.query['lte_cursor.updated_at'] !== 'null') {
    cursor.value = parseInt(req.query['lte_cursor.updated_at']);
  }
  const count = req.query.count ? parseInt(req.query.count) : 20;
  const result = db.fetchPage(cursor, count, uid(req));
  res.json({
    data: {
      biz_data: {
        chat_sessions: result.sessions,
        has_more: result.hasMore
      }
    }
  });
});

app.post('/api/v0/chat_session/update_title', (req, res) => {
  const { chat_session_id, title } = req.body;
  if (!chat_session_id) {
    return res.json({ data: { biz_code: 1, biz_data: {}, biz_msg: 'missing id' } });
  }
  const updatedAt = db.updateTitle(chat_session_id, title || '', uid(req));
  res.json({
    data: {
      biz_code: 0,
      biz_data: {
        title: title || '',
        chat_session_updated_at: updatedAt
      },
      biz_msg: ''
    }
  });
});

app.post('/api/v0/chat_session/delete', (req, res) => {
  const { chat_session_id } = req.body;
  if (chat_session_id) db.deleteSession(chat_session_id, uid(req));
  res.json({ data: { biz_code: 0 } });
});

app.post('/api/v0/chat_session/delete_all', (req, res) => {
  db.deleteAllSessions(uid(req));
  res.json({ data: { biz_code: 0 } });
});

app.post('/api/v0/chat_session/update_pinned', (req, res) => {
  const { chat_session_id, pinned } = req.body;
  if (!chat_session_id) {
    return res.json({ data: { biz_code: 1 } });
  }
  const updatedAt = db.updatePinned(chat_session_id, !!pinned, uid(req));
  res.json({
    data: {
      biz_code: 0,
      biz_data: {
        chat_session_updated_at: updatedAt
      }
    }
  });
});

app.post('/api/v0/chat/message_feedback', (req, res) => {
  res.json({ data: { biz_data: {} } });
});

app.post('/api/v0/chat/stop_stream', (req, res) => {
  res.json({ data: { biz_data: {} } });
});

app.get('/api/v0/chat/history_messages', (req, res) => {
  const sessionId = req.query.chat_session_id;
  if (!sessionId) {
    return res.json({ data: { biz_data: { chat_session: null, chat_messages: [] } } });
  }
  const session = db.getSession(sessionId, uid(req));
  const messages = db.getMessages(sessionId, uid(req));
  res.json({
    data: {
      biz_data: {
        chat_session: session ? {
          id: session.id,
          title: session.title,
          updated_at: session.updated_at,
          title_type: session.title_type,
          pinned: !!session.pinned,
          model_type: session.model_type,
          version: session.version
        } : null,
        chat_messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at
        }))
      }
    }
  });
});

app.post('/api/v0/chat/create_pow_challenge', (req, res) => {
  res.json({
    data: {
      biz_data: {
        challenge: {
          algorithm: "DeepSeekHashV1",
          challenge: crypto.randomBytes(16).toString('hex'),
          salt: crypto.randomBytes(8).toString('hex'),
          signature: crypto.randomBytes(16).toString('hex'),
          difficulty: 10,
          expire_at: Math.floor(Date.now() / 1000) + 300,
          target_path: "/api/v0/chat/completion"
        }
      }
    }
  });
});

// ---- Translation layer: DeepSeek internal SSE <-> web2api OpenAI SSE ----

// [PR-3.1] 原子账号池
const accountPool = new AccountPool(db);

function sendDeepSeekSSE(res, event, data) {
  // [PR-3.5] 客户端断开时 res.write 会抛 EPIPE
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // 静默忽略
  }
}

async function handleDeepSeekCompletion(req, res, mode) {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    chat_session_id,
    prompt,
    model_type = 'deepseek-chat',
    thinking_enabled = false,
    search_enabled = false
  } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  // [PR-3.2] IDOR 修复: 所有 db 操作用 userId 隔离
  const userId = uid(req);
  if (chat_session_id) {
    const existing = db.getSession(chat_session_id, userId);
    if (!existing) {
      // IDOR 防御: 不能 create 别人的 session
      if (chat_session_id && !chat_session_id.match(/^[0-9a-f-]{36}$/i)) {
        return res.status(400).json({ error: 'Invalid session id' });
      }
      db.createSession(chat_session_id, userId);
    }
  }

  // For regenerate: remove last assistant message from DB
  if (mode === 'regenerate') {
    db.deleteLastMessageByRole(chat_session_id, 'assistant', userId);
  }

  // For edit_message: remove last assistant + last user from DB
  if (mode === 'edit_message') {
    db.deleteLastMessageByRole(chat_session_id, 'assistant', userId);
    db.deleteLastMessageByRole(chat_session_id, 'user', userId);
  }

  // Store user message in DB
  db.addMessage(chat_session_id, { role: 'user', content: prompt, id: crypto.randomUUID() }, userId);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // [PR-3.5] 监听客户端断开
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });
  res.on('error', (e) => {
    clientDisconnected = true;
  });

  // Generate IDs for this exchange
  const responseMessageId = crypto.randomUUID();
  const requestMessageId = crypto.randomUUID();

  // Send ready event
  sendDeepSeekSSE(res, 'ready', {
    response_message_id: responseMessageId,
    request_message_id: requestMessageId,
    model_type: model_type
  });

  const startTime = Date.now();

  // [PR-3.1] 用原子账号池
  const acct = accountPool.claim();
  if (!acct) {
    recordStat('no_account', Date.now() - startTime);
    sendDeepSeekSSE(res, 'toast', { type: 'error', content: '没有可用账号' });
    sendDeepSeekSSE(res, 'close', { click_behavior: 'retry' });
    res.end();
    return;
  }

  const client = new DeepSeekClient(acct.token, acct.cookies);

  try {
    // 1. Create a DeepSeek session
    const dsSessionId = await client.createSession();

    // 2. Stream response from DeepSeek
    let fullContent = '';
    for await (const event of client.chatStream(dsSessionId, prompt, {
      model_type,
      thinking_enabled: !!thinking_enabled,
      search_enabled: !!search_enabled
    })) {
      if (clientDisconnected) break;
      if (event.v && typeof event.v === 'string') {
        fullContent += event.v;
        sendDeepSeekSSE(res, 'delta', {
          o: 'APPEND', p: 'response/fragments/0/content', v: event.v
        });
      } else if (event.o && typeof event.p === 'string') {
        sendDeepSeekSSE(res, 'delta', event);
        if (event.p === 'response/fragments/0/content' && typeof event.v === 'string') {
          fullContent += event.v;
        }
      }
    }

    if (clientDisconnected) {
      recordStat('client_disconnect', Date.now() - startTime);
      accountPool.release(acct);
      try { res.end(); } catch { /* ignore */ }
      return;
    }

    // Store the response message
    db.addMessage(chat_session_id, { role: 'assistant', content: fullContent, id: responseMessageId }, userId);

    recordStat('success', Date.now() - startTime);
    accountPool.release(acct);
    sendDeepSeekSSE(res, 'finish', {});
    sendDeepSeekSSE(res, 'close', { click_behavior: 'none' });

  } catch (err) {
    console.error('DeepSeek client error:', err.message);
    recordStat('upstream_error', Date.now() - startTime);
    accountPool.error(acct, err.message);
    if (!clientDisconnected) {
      sendDeepSeekSSE(res, 'toast', {
        type: 'error',
        content: '模型服务异常: ' + err.message
      });
      sendDeepSeekSSE(res, 'close', { click_behavior: 'retry' });
    }
  }
  // 注意: 不再 finally releaseAccount, 因为 success/error 分支已显式处理
  //   accountPool.claim 已加到 _inFlight, 失败/成功都已从 _inFlight 移除

  try { res.end(); } catch { /* ignore */ }
}

// Chat endpoints
app.post('/api/v0/chat/completion', chatLimiter, async (req, res) => {
  await handleDeepSeekCompletion(req, res, 'completion');
});

app.post('/api/v0/chat/regenerate', chatLimiter, async (req, res) => {
  await handleDeepSeekCompletion(req, res, 'regenerate');
});

app.post('/api/v0/chat/continue', chatLimiter, async (req, res) => {
  await handleDeepSeekCompletion(req, res, 'completion');
});

app.post('/api/v0/chat/edit_message', chatLimiter, async (req, res) => {
  await handleDeepSeekCompletion(req, res, 'edit_message');
});

// ---- Proxy endpoints ----

app.use('/cdn', (req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
}, createProxyMiddleware({
  target: 'https://cdn.deepseek.com',
  changeOrigin: true,
}));

app.use('/hif', (req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
}, createProxyMiddleware({
  target: 'https://hif-leim.deepseek.com',
  changeOrigin: true,
}));

// ---- Static files + SPA fallback ----

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    } else if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    }
  }
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await db.init();
  app.listen(PORT, () => {
    console.log(`DeepSeek Mirror running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin/`);
    console.log(`NODE_ENV=${process.env.NODE_ENV}`);
    if (ADMIN_BOOT.generated) {
      console.log('');
      console.log('============================================================');
      console.log(' [PR-0.4] 临时管理员凭据已生成（请保存，下次启动不再显示）');
      console.log(`   用户名: ${ADMIN_USERNAME}`);
      console.log(`   密  码: ${ADMIN_PASSWORD}`);
      console.log(' 建议在 .env 中设置 ADMIN_USERNAME / ADMIN_PASSWORD 永久化。');
      console.log('============================================================');
    }
  });
}
start();
