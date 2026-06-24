const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'sessions.db');

let db = null;
let initQueue = [];

// sql.js operations are sync once initialized, but initSqlJs() is async (WASM load).
// We expose sync-looking functions by queueing callers until init completes.
function ensureDb() {
  if (db) return;
  if (initQueue) {
    // Not yet initialized; push a waiter
    return new Promise(resolve => initQueue.push(resolve));
  }
}

function withDb(fn) {
  if (db) return fn();
  const waiter = ensureDb();
  if (waiter) {
    throw new Error('db not initialized - call db.init() first and await it');
  }
  return fn();
}

async function init() {
  if (db) return;
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const buf = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
    db = new SQL.Database(buf);
    db.run('PRAGMA foreign_keys = ON');
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        title         TEXT DEFAULT '',
        title_type    TEXT DEFAULT 'DEFAULT',
        updated_at    INTEGER DEFAULT 0,
        pinned        INTEGER DEFAULT 0,
        model_type    TEXT DEFAULT 'deepseek-chat',
        version       INTEGER DEFAULT 1,
        created_at    INTEGER DEFAULT 0
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        role          TEXT NOT NULL,
        content       TEXT DEFAULT '',
        created_at    INTEGER DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)');
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    INTEGER DEFAULT 0
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        token         TEXT NOT NULL,
        cookies       TEXT NOT NULL,
        email         TEXT DEFAULT '',
        state         TEXT DEFAULT 'idle',
        error_count   INTEGER DEFAULT 0,
        last_error    TEXT DEFAULT '',
        last_used     INTEGER DEFAULT 0
      )
    `);
    // Flush any pending waiters
    const q = initQueue;
    initQueue = null;
    if (q) q.forEach(r => r());
  } catch (e) {
    console.error('DB init error:', e);
    initQueue = null;
    throw e;
  }
}

function save() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('db save error:', e.message);
  }
}

function createSession(id) {
  id = id || crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.run('INSERT OR IGNORE INTO sessions (id, title, updated_at, created_at) VALUES (?, ?, ?, ?)', [id, '', now, now]);
  save();
  return getSession(id);
}

function getSession(id) {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function fetchPage(cursor, count) {
  count = count || 20;
  let rows;
  if (!cursor || (!cursor.pinned && !cursor.value)) {
    const stmt = db.prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC LIMIT ?');
    stmt.bind([count + 1]);
    rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  } else {
    const pinnedVal = cursor.pinned ? 1 : 0;
    const cursorVal = cursor.value || Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      'SELECT * FROM sessions WHERE (pinned < ? OR (pinned = ? AND updated_at < ?)) ORDER BY pinned DESC, updated_at DESC LIMIT ?'
    );
    stmt.bind([pinnedVal, pinnedVal, cursorVal, count + 1]);
    rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
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

function updateTitle(id, title) {
  const now = Math.floor(Date.now() / 1000);
  db.run("UPDATE sessions SET title = ?, title_type = 'USER', updated_at = ? WHERE id = ?", [title, now, id]);
  save();
  return now;
}

function updatePinned(id, pinned) {
  const now = Math.floor(Date.now() / 1000);
  db.run('UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?', [pinned ? 1 : 0, now, id]);
  save();
  return now;
}

function deleteSession(id) {
  db.run('DELETE FROM messages WHERE session_id = ?', [id]);
  db.run('DELETE FROM sessions WHERE id = ?', [id]);
  save();
}

function deleteAllSessions() {
  db.run('DELETE FROM messages');
  db.run('DELETE FROM sessions');
  save();
}

function touchSession(id) {
  const now = Math.floor(Date.now() / 1000);
  db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, id]);
  save();
}

function addMessage(sessionId, msg) {
  const id = msg.id || crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.run('INSERT OR IGNORE INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', [id, sessionId, msg.role, msg.content, now]);
  touchSession(sessionId);
  return id;
}

function getMessages(sessionId) {
  const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
  stmt.bind([sessionId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteLastMessageByRole(sessionId, role) {
  const stmt = db.prepare('SELECT id FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1');
  stmt.bind([sessionId, role]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    db.run('DELETE FROM messages WHERE id = ?', [row.id]);
    save();
    return true;
  }
  stmt.free();
  return false;
}

function rawRun(sql, params) {
  db.run(sql, params || []);
  save();
}

function getSessionCount() {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM sessions');
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row.count;
}

// ── User management ───────────────────────────────────────────

function createUser(username, password) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const passwordHash = salt + ':' + hash;
  try {
    db.run('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', [id, username, passwordHash, now]);
    save();
    return { id, username, created_at: now };
  } catch (e) {
    return null;
  }
}

function getUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  stmt.bind([username]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function verifyPassword(user, password) {
  if (!user || !user.password_hash) return false;
  const parts = user.password_hash.split(':');
  if (parts.length !== 2) return false;
  const salt = parts[0];
  const hashHex = parts[1];
  // [PR-0.9] 用 timingSafeEqual 防时序攻击
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
  const stmt = db.prepare('SELECT COUNT(*) as count FROM users');
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row.count;
}

// ── Account pool persistence ─────────────────────────────────

function createAccount(token, cookies, email) {
  const stmt = db.prepare('INSERT INTO accounts (token, cookies, email) VALUES (?, ?, ?)');
  stmt.run([token, cookies, email || '']);
  stmt.free();
  save();
  const row = db.prepare('SELECT last_insert_rowid() as id').getAsObject();
  return row.id;
}

function getAllAccounts() {
  const stmt = db.prepare('SELECT * FROM accounts ORDER BY id ASC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function updateAccountState(id, state, lastError) {
  if (lastError !== undefined) {
    db.run('UPDATE accounts SET state = ?, error_count = error_count + 1, last_error = ?, last_used = ? WHERE id = ?',
      [state, lastError, Math.floor(Date.now() / 1000), id]);
  } else {
    db.run('UPDATE accounts SET state = ?, last_used = ? WHERE id = ?',
      [state, Math.floor(Date.now() / 1000), id]);
  }
  save();
}

function resetAccountErrors(id) {
  db.run('UPDATE accounts SET state = ?, error_count = 0, last_error = ? WHERE id = ?',
    ['idle', '', id]);
  save();
}

function deleteAccount(id) {
  db.run('DELETE FROM accounts WHERE id = ?', [id]);
  save();
}

function getAccountStats() {
  const stmt = db.prepare(`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN state = 'idle' THEN 1 ELSE 0 END) as idle,
    SUM(CASE WHEN state = 'busy' THEN 1 ELSE 0 END) as busy,
    SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) as error
    FROM accounts`);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row;
}

function getAccountById(id) {
  const stmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

module.exports = {
  init,
  createSession, getSession, fetchPage,
  updateTitle, updatePinned,
  deleteSession, deleteAllSessions,
  touchSession, addMessage, getMessages,
  getSessionCount, deleteLastMessageByRole, rawRun,
  createUser, getUserByUsername, verifyPassword, getUserCount,
  createAccount, getAllAccounts, updateAccountState,
  resetAccountErrors, deleteAccount, getAccountStats, getAccountById
};
