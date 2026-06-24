// lib/admin-tokens.js
// 管理面板 token 存储：Map<token, {issuedAt, lastUsedAt}>，带 TTL 与定期 GC。
//
// [PR-0.6] 替代 server.js 中裸的 Set<token>：
//   - 默认 TTL 8h
//   - 每 30 分钟清理一次过期 token
//   - 验证时刷新 lastUsedAt（用于审计）

const crypto = require('crypto');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;       // 8h
const GC_INTERVAL_MS = 30 * 60 * 1000;            // 30min

class AdminTokenStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, gcIntervalMs = GC_INTERVAL_MS } = {}) {
    this.tokens = new Map();
    this.ttlMs = ttlMs;
    this._gcTimer = setInterval(() => this.gc(), gcIntervalMs);
    // unref 后不阻止进程退出
    if (this._gcTimer.unref) this._gcTimer.unref();
  }

  issue() {
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(token, { issuedAt: Date.now(), lastUsedAt: Date.now() });
    return token;
  }

  has(token) {
    if (!token) return false;
    const meta = this.tokens.get(token);
    if (!meta) return false;
    if (Date.now() - meta.issuedAt > this.ttlMs) {
      this.tokens.delete(token);
      return false;
    }
    meta.lastUsedAt = Date.now();
    return true;
  }

  revoke(token) {
    this.tokens.delete(token);
  }

  size() {
    return this.tokens.size;
  }

  gc() {
    const now = Date.now();
    for (const [t, meta] of this.tokens) {
      if (now - meta.issuedAt > this.ttlMs) this.tokens.delete(t);
    }
  }

  stop() {
    if (this._gcTimer) clearInterval(this._gcTimer);
    this._gcTimer = null;
  }
}

module.exports = { AdminTokenStore };
