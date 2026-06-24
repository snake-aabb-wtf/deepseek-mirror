// lib/account-pool.js
// 账号池管理：原子选取 / 释放 / 跟踪 in-flight
//
// [PR-3.1] 解决 server.js 中 getAvailableAccount 的 TOCTOU 竞态：
//   旧实现：getAllAccounts() 遍历 + updateAccountState(acccount.id, 'busy')
//           两个并发请求都拿到同一个 idle 账号
//   新实现：用 SQL 原子操作（UPDATE ... WHERE state='idle' RETURNING *）
//           加上 Set<id> 跟踪 in-flight 避免内存重号
//
// 用法：
//   const pool = new AccountPool(db);
//   const acct = pool.claim();   // 返回账号或 null
//   pool.release(acct);          // 释放
//   pool.error(acct, msg);       // 标记错误

class AccountPool {
  constructor(db) {
    this.db = db;
    // 内存中的 in-flight 集合（额外保护：即使 DB 层面原子，JS 端也保证不重用）
    this._inFlight = new Set();
  }

  /**
   * 原子获取一个 idle 账号
   * @returns {object|null} { id, email, state, token, cookies } 或 null
   */
  claim() {
    // 多次尝试（考虑 in-flight 与 DB 状态可能短暂不一致）
    for (let i = 0; i < 3; i++) {
      const acct = this.db.claimIdleAccount();
      if (!acct) return null;
      if (this._inFlight.has(acct.id)) {
        // 内存中已 in-flight, 释放 DB 端的 busy 状态
        this.db.updateAccountState(acct.id, 'idle');
        continue;
      }
      this._inFlight.add(acct.id);
      return acct;
    }
    return null;
  }

  /**
   * 释放账号（设为 idle）
   */
  release(acct) {
    if (!acct) return;
    this._inFlight.delete(acct.id);
    this.db.updateAccountState(acct.id, 'idle');
  }

  /**
   * 标记账号错误
   */
  error(acct, message) {
    if (!acct) return;
    this._inFlight.delete(acct.id);
    this.db.updateAccountState(acct.id, 'error', message);
  }

  /**
   * 当前 in-flight 数（用于 stats）
   */
  get inFlightCount() {
    return this._inFlight.size;
  }
}

module.exports = { AccountPool };
