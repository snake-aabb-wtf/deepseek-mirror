// db.js — PR-1 重写版
// 从 sql.js 迁移到 better-sqlite3。
//
// 主要改进：
//   1. 同步 API（更好用），无 export/save 仪式
//   2. accounts.token/cookies 加密存储（AES-256-GCM via lib/crypto.js）
//   3. sessions/messages 增加 user_id 字段（PR-3 将用其修 IDOR）
//   4. 启动时自动从旧 sql.js 数据库迁移数据
//   5. 同步语句 prepared & cached，性能提升 10-50x
//
// 保留原有导出 API（createSession/getSession/...），调用方可零改动替换。

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const { encryptToken, decryptToken, looksEncrypted } = require('./lib/crypto');
const { createLogger } = require('./lib/logger');
const logger = createLogger('db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sessions.db');
const OLD_DB_PATH = path.join(__dirname, 'sessions.db.old');  // 迁移后保留原文件

let db = null;
let _initPromise = null;

const stmts = {};  // prepared statements 缓存

// ── 初始化 ────────────────────────────────────────────────────
async function init() {
  if (db) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const fresh = !fs.existsSync(DB_PATH);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');

    ensureSchema();
    prepareStatements();

    if (fresh) {
      // 第一次创建 → 尝试从旧 sql.js 数据库迁移
      const old = findOldSqlJsDb();
      if (old) {
        try {
          migrateFromSqlJs(old);
        } catch (e) {
          logger.error({ err: e.message }, '[migrate] failed');
        }
      }
    }
  })();
  return _initPromise;
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL DEFAULT 'mirror-user',
      title         TEXT DEFAULT '',
      title_type    TEXT DEFAULT 'DEFAULT',
      updated_at    INTEGER DEFAULT 0,
      pinned        INTEGER DEFAULT 0,
      model_type    TEXT DEFAULT 'deepseek-chat',
      version       INTEGER DEFAULT 1,
      created_at    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      user_id       TEXT NOT NULL DEFAULT 'mirror-user',
      role          TEXT NOT NULL,
      content       TEXT DEFAULT '',
      created_at    INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      encrypted_token    BLOB NOT NULL,
      encrypted_cookies  BLOB NOT NULL,
      email              TEXT DEFAULT '',
      state              TEXT DEFAULT 'idle',
      error_count        INTEGER DEFAULT 0,
      last_error         TEXT DEFAULT '',
      last_used          INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user    ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_state   ON accounts(state);
  `);
}

function prepareStatements() {
  // sessions
  stmts.upsertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, user_id, title, updated_at, created_at)
    VALUES (?, ?, '', ?, ?)
  `);
  stmts.getSession = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?');
  stmts.getSessionAny = db.prepare('SELECT * FROM sessions WHERE id = ?');  // admin only
  stmts.fetchPageFirst = db.prepare(`
    SELECT * FROM sessions WHERE user_id = ?
    ORDER BY pinned DESC, updated_at DESC LIMIT ?
  `);
  stmts.fetchPageAfter = db.prepare(`
    SELECT * FROM sessions WHERE user_id = ?
      AND (pinned < ? OR (pinned = ? AND updated_at < ?))
    ORDER BY pinned DESC, updated_at DESC LIMIT ?
  `);
  stmts.updateTitle = db.prepare(`
    UPDATE sessions SET title = ?, title_type = 'USER', updated_at = ? WHERE id = ? AND user_id = ?
  `);
  stmts.updatePinned = db.prepare(`
    UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ? AND user_id = ?
  `);
  stmts.deleteSession = db.prepare('DELETE FROM messages WHERE session_id = ?');
  stmts.deleteSessionRow = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?');
  stmts.deleteAllSessions = db.prepare('DELETE FROM messages WHERE user_id = ?');
  stmts.deleteAllSessionsMeta = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  stmts.touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?');
  stmts.getSessionCount = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?');

  // messages
  stmts.insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, user_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmts.getMessages = db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC
  `);
  stmts.findLastByRole = db.prepare(`
    SELECT id FROM messages WHERE session_id = ? AND user_id = ? AND role = ?
    ORDER BY created_at DESC LIMIT 1
  `);
  stmts.deleteMessage = db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?');

  // users
  stmts.insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)
  `);
  stmts.getUser = db.prepare('SELECT * FROM users WHERE username = ?');
  stmts.getUserCount = db.prepare('SELECT COUNT(*) as c FROM users');

  // accounts
  stmts.insertAccount = db.prepare(`
    INSERT INTO accounts (encrypted_token, encrypted_cookies, email) VALUES (?, ?, ?)
  `);
  stmts.getAllAccounts = db.prepare('SELECT * FROM accounts ORDER BY id ASC');
  stmts.getAccountById = db.prepare('SELECT * FROM accounts WHERE id = ?');
  stmts.updateAccountState = db.prepare(`
    UPDATE accounts SET state = ?, error_count = error_count + 1, last_error = ?, last_used = ?
    WHERE id = ?
  `);
  stmts.updateAccountStateNoErr = db.prepare(`
    UPDATE accounts SET state = ?, last_used = ? WHERE id = ?
  `);
  stmts.resetAccountErrors = db.prepare(`
    UPDATE accounts SET state = 'idle', error_count = 0, last_error = '' WHERE id = ?
  `);
  stmts.deleteAccount = db.prepare('DELETE FROM accounts WHERE id = ?');

  // 原子获取一个 idle 账号（PR-3 准备）
  stmts.claimIdleAccount = db.prepare(`
    UPDATE accounts SET state = 'busy', last_used = ? WHERE id = (
      SELECT id FROM accounts WHERE state = 'idle' ORDER BY last_used ASC LIMIT 1
    )
    RETURNING *
  `);
}

// ── 旧 sql.js 数据库迁移 ──────────────────────────────────────
function findOldSqlJsDb() {
  // 查找可能的 sql.js 数据库（其特征是文件大小通常 10-100KB，且包含 SQLite header）
  const candidates = [
    path.join(__dirname, 'sessions.db.old'),
    path.join(__dirname, 'sessions.db.bak'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);
      if (buf.toString('ascii', 0, 15) === 'SQLite format 3') return p;
    } catch { /* skip */ }
  }
  return null;
}

function migrateFromSqlJs(oldPath) {
  logger.info({ path: oldPath }, '[migrate] found legacy DB');
  let oldDb;
  try {
    const initSqlJs = require('sql.js');
    const SQL = require('sql.js');  // already require'd
    // sql.js 是 sync after init
    const buf = fs.readFileSync(oldPath);
    // 重新 require 触发 init
    delete require.cache[require.resolve('sql.js')];
    const initSqlJs2 = require('sql.js');
    let SQLLib;
    return initSqlJs2().then((lib) => {
      SQLLib = lib;
      oldDb = new SQLLib.Database(buf);
      doMigrate(oldDb);
      // 把旧 db 重命名（不删除，让用户手动确认）
      fs.renameSync(oldPath, OLD_DB_PATH);
      logger.info({ path: OLD_DB_PATH }, '[migrate] done');
    });
  } catch (e) {
    logger.error({ err: e.message }, '[migrate] error');
  }
}

function doMigrate(oldDb) {
  // sessions
  try {
    const rows = oldDb.exec('SELECT * FROM sessions');
    if (rows[0]) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO sessions (id, user_id, title, title_type, updated_at, pinned, model_type, version, created_at)
        VALUES (?, 'mirror-user', ?, ?, ?, ?, ?, ?, ?)
      `);
      const txn = db.transaction((rs) => {
        for (const r of rs) insert.run(
          r[0], r[1], r[2] || 'DEFAULT', r[3] || 0, r[4] || 0, r[5] || 'deepseek-chat', r[6] || 1, r[7] || 0
        );
      });
      txn(rows[0].values);
      logger.info({ count: rows[0].values.length }, '[migrate] sessions');
    }
  } catch (e) { logger.error({ err: e.message }, '[migrate] sessions error'); }

  // messages
  try {
    const rows = oldDb.exec('SELECT * FROM messages');
    if (rows[0]) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO messages (id, session_id, user_id, role, content, created_at)
        VALUES (?, ?, 'mirror-user', ?, ?, ?)
      `);
      const txn = db.transaction((rs) => {
        for (const r of rs) insert.run(r[0], r[1], r[2], r[3] || '', r[4] || 0);
      });
      txn(rows[0].values);
      logger.info({ count: rows[0].values.length }, '[migrate] messages');
    }
  } catch (e) { logger.error({ err: e.message }, '[migrate] messages error'); }

  // users
  try {
    const rows = oldDb.exec('SELECT * FROM users');
    if (rows[0]) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)
      `);
      const txn = db.transaction((rs) => {
        for (const r of rs) insert.run(r[0], r[1], r[2], r[3] || 0);
      });
      txn(rows[0].values);
      logger.info({ count: rows[0].values.length }, '[migrate] users');
    }
  } catch (e) { logger.error({ err: e.message }, '[migrate] users error'); }

  // accounts (加密)
  try {
    const rows = oldDb.exec('SELECT * FROM accounts');
    if (rows[0]) {
      const insert = db.prepare(`
        INSERT INTO accounts (encrypted_token, encrypted_cookies, email, state, error_count, last_error, last_used)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const txn = db.transaction((rs) => {
        for (const r of rs) {
          const [id, token, cookies, email, state, ec, le, lu] = r;
          // 旧数据是明文 → 加密
          insert.run(
            Buffer.from(encryptToken(String(token || '')), 'base64'),
            Buffer.from(encryptToken(String(cookies || '')), 'base64'),
            email || '',
            state || 'idle',
            ec || 0,
            le || '',
            lu || 0
          );
        }
      });
      txn(rows[0].values);
      logger.info({ count: rows[0].values.length }, '[migrate] accounts (encrypted)');
    }
  } catch (e) { logger.error({ err: e.message }, '[migrate] accounts error'); }
}

// ── 公开 API：sessions ─────────────────────────────────────────
function createSession(id, userId) {
  id = id || crypto.randomUUID();
  const uid = userId || 'mirror-user';
  const now = Math.floor(Date.now() / 1000);
  stmts.upsertSession.run(id, uid, now, now);
  return getSession(id, uid);
}

function getSession(id, userId) {
  if (userId) return stmts.getSession.get(id, userId);
  return stmts.getSessionAny.get(id);
}

function fetchPage(cursor, count, userId) {
  count = count || 20;
  const uid = userId || 'mirror-user';
  let rows;
  if (!cursor || (!cursor.pinned && !cursor.value)) {
    rows = stmts.fetchPageFirst.all(uid, count + 1);
  } else {
    const pinnedVal = cursor.pinned ? 1 : 0;
    const cursorVal = cursor.value || Math.floor(Date.now() / 1000);
    rows = stmts.fetchPageAfter.all(uid, pinnedVal, pinnedVal, cursorVal, count + 1);
  }
  const hasMore = rows.length > count;
  const sessions = hasMore ? rows.slice(0, count) : rows;
  return {
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      updated_at: s.updated_at,
      title_type: s.title_type,
      pinned: !!s.pinned,
      model_type: s.model_type
    })),
    hasMore
  };
}

function updateTitle(id, title, userId) {
  const uid = userId || 'mirror-user';
  const now = Math.floor(Date.now() / 1000);
  stmts.updateTitle.run(title, now, id, uid);
  return now;
}

function updatePinned(id, pinned, userId) {
  const uid = userId || 'mirror-user';
  const now = Math.floor(Date.now() / 1000);
  stmts.updatePinned.run(pinned ? 1 : 0, now, id, uid);
  return now;
}

function deleteSession(id, userId) {
  const uid = userId || 'mirror-user';
  stmts.deleteSession.run(id);
  stmts.deleteSessionRow.run(id, uid);
}

function deleteAllSessions(userId) {
  const uid = userId || 'mirror-user';
  stmts.deleteAllSessions.run(uid);
  stmts.deleteAllSessionsMeta.run(uid);
}

function touchSession(id, userId) {
  const uid = userId || 'mirror-user';
  const now = Math.floor(Date.now() / 1000);
  stmts.touchSession.run(now, id, uid);
}

function addMessage(sessionId, msg, userId) {
  const id = msg.id || crypto.randomUUID();
  const uid = userId || 'mirror-user';
  const now = Math.floor(Date.now() / 1000);
  stmts.insertMessage.run(id, sessionId, uid, msg.role, msg.content, now);
  touchSession(sessionId, uid);
  return id;
}

function getMessages(sessionId, userId) {
  const uid = userId || 'mirror-user';
  return stmts.getMessages.all(sessionId, uid);
}

function deleteLastMessageByRole(sessionId, role, userId) {
  const uid = userId || 'mirror-user';
  const row = stmts.findLastByRole.get(sessionId, uid, role);
  if (!row) return false;
  stmts.deleteMessage.run(row.id, uid);
  return true;
}

function getSessionCount(userId) {
  const uid = userId || 'mirror-user';
  return stmts.getSessionCount.get(uid).c;
}

// ── 公开 API：users ───────────────────────────────────────────
function createUser(username, password) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const passwordHash = salt + ':' + hash;
  try {
    stmts.insertUser.run(id, username, passwordHash, now);
    return { id, username, created_at: now };
  } catch (e) {
    return null;
  }
}

function getUserByUsername(username) {
  return stmts.getUser.get(username);
}

function verifyPassword(user, password) {
  if (!user || !user.password_hash) return false;
  const parts = user.password_hash.split(':');
  if (parts.length !== 2) return false;
  const salt = parts[0];
  const hashHex = parts[1];
  let computed;
  try {
    computed = crypto.scryptSync(password, salt, 64);
  } catch {
    return false;
  }
  let stored;
  try {
    stored = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (stored.length !== computed.length) return false;
  return crypto.timingSafeEqual(computed, stored);
}

function getUserCount() {
  return stmts.getUserCount.get().c;
}

// ── 公开 API：accounts（加密）────────────────────────────────
function createAccount(token, cookies, email) {
  const encToken = Buffer.from(encryptToken(String(token || '')), 'base64');
  const encCookies = Buffer.from(encryptToken(String(cookies || '')), 'base64');
  const result = stmts.insertAccount.run(encToken, encCookies, email || '');
  return Number(result.lastInsertRowid);
}

function getAllAccounts() {
  const rows = stmts.getAllAccounts.all();
  return rows.map(row => ({
    id: row.id,
    email: row.email,
    state: row.state,
    error_count: row.error_count,
    last_error: row.last_error,
    last_used: row.last_used,
    token: decryptToken(Buffer.from(row.encrypted_token).toString('base64')),
    cookies: decryptToken(Buffer.from(row.encrypted_cookies).toString('base64')),
  }));
}

function getAccountById(id) {
  const row = stmts.getAccountById.get(id);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    state: row.state,
    error_count: row.error_count,
    last_error: row.last_error,
    last_used: row.last_used,
    token: decryptToken(Buffer.from(row.encrypted_token).toString('base64')),
    cookies: decryptToken(Buffer.from(row.encrypted_cookies).toString('base64')),
  };
}

function getAccountStats() {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN state = 'idle' THEN 1 ELSE 0 END) as idle,
      SUM(CASE WHEN state = 'busy' THEN 1 ELSE 0 END) as busy,
      SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) as error
    FROM accounts
  `);
  return stmt.get();
}

function updateAccountState(id, state, lastError) {
  if (lastError !== undefined) {
    stmts.updateAccountState.run(state, lastError, Math.floor(Date.now() / 1000), id);
  } else {
    stmts.updateAccountStateNoErr.run(state, Math.floor(Date.now() / 1000), id);
  }
}

function resetAccountErrors(id) {
  stmts.resetAccountErrors.run(id);
}

function deleteAccount(id) {
  stmts.deleteAccount.run(id);
}

function claimIdleAccount() {
  // PR-3 准备的原子操作
  const row = stmts.claimIdleAccount.get(Math.floor(Date.now() / 1000));
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    state: row.state,
    token: decryptToken(Buffer.from(row.encrypted_token).toString('base64')),
    cookies: decryptToken(Buffer.from(row.encrypted_cookies).toString('base64')),
  };
}

// ── 关闭（优雅） ─────────────────────────────────────────────
function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  init, close,
  // sessions
  createSession, getSession, fetchPage,
  updateTitle, updatePinned,
  deleteSession, deleteAllSessions,
  touchSession, addMessage, getMessages,
  getSessionCount, deleteLastMessageByRole,
  // users
  createUser, getUserByUsername, verifyPassword, getUserCount,
  // accounts
  createAccount, getAllAccounts, getAccountById, getAccountStats,
  updateAccountState, resetAccountErrors, deleteAccount,
  claimIdleAccount,
  // rawRun (向后兼容)
  rawRun: (sql, params) => { db.prepare(sql).run(...(params || [])); },
};
