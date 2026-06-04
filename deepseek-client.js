const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://chat.deepseek.com';

class DeepSeekClient {
  constructor(token, cookies) {
    this.token = token;
    this.cookies = cookies;
    this.wasmInstance = null;
    this.exports = null;
    this.memory = null;
  }

  async _initWasm() {
    if (this.wasmInstance) return;
    const wasmBuffer = fs.readFileSync(path.join(__dirname, 'sha3_wasm_bg.wasm'));
    const wasmModule = new WebAssembly.Module(wasmBuffer);
    this.wasmInstance = new WebAssembly.Instance(wasmModule, {});
    this.exports = this.wasmInstance.exports;
    this.memory = this.exports.memory;
  }

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

  async _solveChallenge(challengeData) {
    const { algorithm, challenge, salt, signature, difficulty, expire_at, target_path } = challengeData;
    const prefix = `${salt}_${expire_at}_`;

    if (!this.wasmInstance) await this._initWasm();

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

  async _powHeaders(targetPath) {
    const resp = await fetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: this._makeHeaders(),
      body: JSON.stringify({ target_path: targetPath })
    });
    const data = await resp.json();
    const challenge = data.data?.biz_data?.challenge;
    if (!challenge) throw new Error('Failed to get PoW challenge');

    const powToken = await this._solveChallenge(challenge);

    return {
      ...this._makeHeaders(),
      'X-DS-PoW-Response': powToken
    };
  }

  async createSession() {
    const headers = await this._powHeaders('/api/v0/chat_session/create');
    const resp = await fetch(`${BASE_URL}/api/v0/chat_session/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });
    const data = await resp.json();
    const bizData = data.data?.biz_data;
    if (bizData?.chat_session?.id) return bizData.chat_session.id;
    if (bizData?.id) return bizData.id;
    throw new Error('Failed to create session: ' + JSON.stringify(data));
  }

  async *chatStream(sessionId, prompt, options = {}) {
    const {
      model_type = 'deepseek-chat',
      thinking_enabled = false,
      search_enabled = false
    } = options;

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

    const resp = await fetch(`${BASE_URL}/api/v0/chat/completion`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`DeepSeek API error ${resp.status}: ${errText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('event: ')) continue;
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          if (!dataStr) continue;
          try {
            const parsed = JSON.parse(dataStr);
            yield parsed;
          } catch (e) {
            // Skip unparseable data
          }
        }
      }
    }
  }

  async checkHealth() {
    try {
      const resp = await fetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
        method: 'POST',
        headers: this._makeHeaders(),
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

module.exports = DeepSeekClient;
