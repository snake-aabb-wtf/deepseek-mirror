// lib/fetch-with-timeout.js
// 统一封装 fetch + AbortController 超时控制
//
// [PR-2.2] Node 18+ 的 fetch 默认无 timeout，长时间思考（专家模式 > 60s）
//     可能触发底层 timeout，导致连接挂死 + 账号池锁死。
//
// 用法：
//   const { fetchWithTimeout, abortableStreamFetch } = require('./lib/fetch-with-timeout');
//   const resp = await fetchWithTimeout(url, opts, 30000);
//
// 提供两个函数：
//   - fetchWithTimeout: 普通请求带总超时
//   - abortableStreamFetch: 流式请求带 idle timeout（每次 read 重置）

/**
 * 普通 fetch + 总超时
 * @param {string} url
 * @param {RequestInit} opts
 * @param {number} timeoutMs 总超时（默认 30s）
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式 fetch + 每次 read 后的 idle timeout
 * 用法：
 *   const { response, abort } = abortableStreamFetch(url, opts, idleTimeoutMs);
 *   const reader = response.body.getReader();
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     abort.reset();  // 重置 idle timer
 *     // ...
 *   }
 *
 * 或使用 parseSSEStream(response, abort) 简化调用。
 *
 * @returns {{response: Promise<Response>, abort: {reset: Function, cancel: Function}}}
 */
function abortableStreamFetch(url, opts = {}, idleTimeoutMs = 60000) {
  const ctl = new AbortController();
  let timer = null;

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      ctl.abort(new Error(`stream idle timeout after ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  };
  const reset = () => arm();
  const cancel = () => {
    if (timer) clearTimeout(timer);
    ctl.abort(new Error('cancelled'));
  };

  arm();  // 首次立即 arm（防止 connection hang）
  const response = fetch(url, { ...opts, signal: ctl.signal });

  return {
    response,
    abort: {
      reset,
      cancel,
      get isAborted() { return ctl.signal.aborted; },
    },
  };
}

module.exports = { fetchWithTimeout, abortableStreamFetch };
