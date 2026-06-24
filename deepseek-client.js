// deepseek-client.js — PR-2 重写版
// 上游 DeepSeek API 客户端 + WASM PoW 求解 + SSE 解析
//
// [PR-2] 关键修复：
//   1. WASM Module 进程级单例（lib/wasm-singleton.js）—— 避免每实例重编译
//   2. WASM Memory 预 grow 16 页（1MB）—— 防止 memory.grow 导致 buffer 失效
//   3. fetch 全部走 timeout 工具（lib/fetch-with-timeout.js）—— 防止连接挂死
//   4. SSE 解析器：状态机 + buffer 上限 + UTF-8 收尾 + reader.releaseLock
//   5. _powHeaders: resp.ok 检查 + 过期重试
//   6. chatStream: idle timeout (默认 10min, 专家模式 30min)

const path = require('path');
const { getWasmModule, createInstance } = require('./lib/wasm-singleton');
const { fetchWithTimeout, abortableStreamFetch } = require('./lib/fetch-with-timeout');

const BASE_URL = 'https://chat.deepseek.com';
const DEFAULT_FETCH_TIMEOUT = 30 * 1000;      // 30s
const DEFAULT_IDLE_TIMEOUT = 10 * 60 * 1000;  // 10min
const EXPERT_IDLE_TIMEOUT = 30 * 60 * 1000;   // 30min
const WASM_MEM_PAGES = 16;                     // 1MB 预分配
const SSE_BUFFER_LIMIT = 1024 * 1024;          // 1MB buffer 上限

class DeepSeekClient {
  constructor(token, cookies) {
    this.token = token;
    this.cookies = cookies;
    this.module = null;        // 延迟加载
    this.instance = null;
    this.exports = null;
    this.memory = null;
  }

  // ── WASM 初始化（单例 Module + 每实例 Instance） ─────────
  async _initWasm() {
    if (this.instance) return;
    if (!this.module) this.module = await getWasmModule();
    const created = createInstance(this.module);
    this.instance = created.instance;
    this.exports = created.exports;
    this.memory = created.memory;
    // [PR-2.3 关键修复] 预 grow 内存，避免 memory.grow() 时 buffer 失效
    // 旧实现：每次 wasm_solve 都可能 grow，触发 detached ArrayBuffer 报错
    // 新实现：先 grow 1MB，后续 grow 不会发生
    this._ensureMemory(WASM_MEM_PAGES);
  }

  _ensureMemory(pages) {
    const current = this.memory.buffer.byteLength / 65536;
    if (current >= pages) return;
    const grow = pages - current;
    const prev = this.memory.grow(grow);
    if (prev === -1) {
      throw new Error('WASM memory grow failed');
    }
  }

  // ── 请求头 ─────────────────────────────────────────────
  _makeHeaders() {
    return {
      'Content-Type': 'application/json',
      'Cookie': this.cookies || '',
      'Authorization': this.token ? `Bearer ${this.token}` : '',
      'X-App-Version': '20241129.1',
      'X-Client-Version': '2.0.0',
      'X-Client-Platform': 'web',
      'X-Client-Locale': 'zh_CN',
    };
  }

  // ── PoW 求解 ───────────────────────────────────────────
  async _solveChallenge(challengeData) {
    const { algorithm, challenge, salt, signature, difficulty, expire_at, target_path } = challengeData;
    const prefix = `${salt}_${expire_at}_`;

    await this._initWasm();
    const exports = this.exports;
    const memory = this.memory;

    const encode = (str) => {
      const data = new TextEncoder().encode(str);
      const ptr = exports.__wbindgen_export_0(data.length);
      const mem = new Uint8Array(memory.buffer);
      mem.set(data, ptr);
      return { ptr, len: data.length };
    };

    const addStack = (offset) => exports.__wbindgen_add_to_stack_pointer(offset);
    const stackPtr = addStack(-16);

    try {
      const { ptr: chalPtr, len: chalLen } = encode(challenge);
      const { ptr: prefixPtr, len: prefixLen } = encode(prefix);

      exports.wasm_solve(stackPtr, chalPtr, chalLen, prefixPtr, prefixLen, parseFloat(difficulty));

      // [PR-2.3] 重新捕获 buffer（防止 grow 后 detached）
      const mem = new Uint8Array(memory.buffer);
      const ret = new Int32Array(mem.buffer, stackPtr, 1)[0];
      if (ret === 0) {
        throw new Error('WASM solver found no solution');
      }

      const result = new Float64Array(mem.buffer, stackPtr + 8, 1)[0];
      const nonce = Math.floor(result);

      const powData = JSON.stringify({
        algorithm,
        challenge,
        salt,
        answer: nonce,
        signature,
        target_path: target_path || '/api/v0/chat/completion'
      });

      return Buffer.from(powData).toString('base64');
    } finally {
      addStack(16);
    }
  }

  // ── PoW 头（带重试） ──────────────────────────────────
  async _powHeaders(targetPath) {
    const url = `${BASE_URL}/api/v0/chat/create_pow_challenge`;
    const body = JSON.stringify({ target_path: targetPath });

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: this._makeHeaders(),
        body,
      }, DEFAULT_FETCH_TIMEOUT);

      // [PR-2.4] 检查 HTTP 状态
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        lastErr = new Error(`PoW challenge HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        continue;
      }

      const data = await resp.json().catch(() => null);
      if (!data) {
        lastErr = new Error('PoW challenge: invalid JSON response');
        continue;
      }

      const challenge = data.data?.biz_data?.challenge;
      if (!challenge) {
        lastErr = new Error('PoW challenge: missing challenge in response');
        continue;
      }

      // [PR-2.4] 检查 challenge 是否过期（expire_at 是 Unix 秒）
      const expireAt = Number(challenge.expire_at);
      if (Number.isFinite(expireAt) && expireAt * 1000 < Date.now() + 1000) {
        // 距过期 < 1s，重试一次
        lastErr = new Error('PoW challenge already expired');
        continue;
      }

      try {
        const powToken = await this._solveChallenge(challenge);
        return {
          ...this._makeHeaders(),
          'X-DS-PoW-Response': powToken,
        };
      } catch (e) {
        lastErr = e;
        // 继续重试
      }
    }
    throw lastErr || new Error('PoW challenge failed');
  }

  // ── 创建 DeepSeek 会话 ───────────────────────────────
  async createSession() {
    const headers = await this._powHeaders('/api/v0/chat_session/create');
    const resp = await fetchWithTimeout(`${BASE_URL}/api/v0/chat_session/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }, DEFAULT_FETCH_TIMEOUT);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`createSession HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const bizData = data.data?.biz_data;
    if (bizData?.chat_session?.id) return bizData.chat_session.id;
    if (bizData?.id) return bizData.id;
    throw new Error('createSession: invalid response: ' + JSON.stringify(data).slice(0, 200));
  }

  // ── 流式聊天 ─────────────────────────────────────────
  async *chatStream(sessionId, prompt, options = {}) {
    const {
      model_type = 'deepseek-chat',
      thinking_enabled = false,
      search_enabled = false,
    } = options;

    // 专家模式（thinking）可能更久 → 更长 idle timeout
    const idleTimeoutMs = thinking_enabled ? EXPERT_IDLE_TIMEOUT : DEFAULT_IDLE_TIMEOUT;

    const headers = await this._powHeaders('/api/v0/chat/completion');

    const body = {
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type,
      prompt,
      ref_file_ids: [],
      stream: true,
      thinking_enabled,
      search_enabled,
      preempt: false
    };

    const { response, abort } = abortableStreamFetch(`${BASE_URL}/api/v0/chat/completion`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, idleTimeoutMs);

    let resp;
    let reader;
    try {
      resp = await response;
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`DeepSeek API HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      }
      if (!resp.body) throw new Error('DeepSeek API: empty response body');

      reader = resp.body.getReader();
    } catch (e) {
      abort.cancel();
      throw e;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // 冲刷残余
          buffer += decoder.decode();
          break;
        }
        abort.reset();
        buffer += decoder.decode(value, { stream: true });

        // [PR-2.6] buffer 上限保护
        if (buffer.length > SSE_BUFFER_LIMIT) {
          throw new Error('SSE buffer overflow (>1MB), upstream may be malicious');
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            // 空行 = 事件边界
            if (currentEvent) currentEvent = null;
            continue;
          }
          if (trimmed.startsWith('event:')) {
            // [PR-2.3 修复] 记录 event 名 (原本直接 continue 丢弃)
            currentEvent = trimmed.slice(6).trim();
            continue;
          }
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr) continue;
            try {
              const parsed = JSON.parse(dataStr);
              // 透传 currentEvent 给调用方（可选）
              if (currentEvent) parsed._event = currentEvent;
              yield parsed;
            } catch {
              // 跳过非 JSON 行
            }
          }
          // 注释行 ": xxx" 忽略
        }
      }
    } finally {
      // [PR-2.6] 释放 reader
      try { reader.releaseLock(); } catch { /* ignore */ }
      abort.cancel();
    }
  }

  // ── 健康检查 ─────────────────────────────────────────
  async checkHealth() {
    try {
      const resp = await fetchWithTimeout(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
        method: 'POST',
        headers: this._makeHeaders(),
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      }, DEFAULT_FETCH_TIMEOUT);
      return resp.ok;
    } catch {
      return false;
    }
  }
}

module.exports = DeepSeekClient;
