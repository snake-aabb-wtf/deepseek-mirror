// lib/wasm-singleton.js
// 共享 WebAssembly.Module 编译结果（每个 DeepSeekClient 实例化一次 Instance + Memory）
//
// [PR-2.1] 修复 deepseek-client.js 中每实例重编译的浪费：
//   - 旧实现: 每次 new DeepSeekClient() 都重读 fs、重建 Module、重建 Instance
//   - 新实现: 进程级 Module 共享；每个 client 仍可有独立 memory（PoW 中间态隔离）
//
// 用法：
//   const { getWasmModule, createInstance } = require('./lib/wasm-singleton');
//   const module = await getWasmModule();           // 进程级单例
//   const { instance, exports, memory } = createInstance(module);  // 每实例

const path = require('path');
const fs = require('fs');

let _modulePromise = null;

/**
 * 获取编译后的 WebAssembly.Module（进程级单例）
 * 失败抛错。
 */
function getWasmModule(wasmPath) {
  if (_modulePromise) return _modulePromise;
  const p = wasmPath || path.join(__dirname, '..', 'sha3_wasm_bg.wasm');
  _modulePromise = (async () => {
    const buf = fs.readFileSync(p);
    return await WebAssembly.compile(buf);
  })();
  return _modulePromise;
}

/**
 * 从已编译的 Module 创建 Instance + 暴露常用字段
 */
function createInstance(module) {
  const instance = new WebAssembly.Instance(module, {});
  const exports = instance.exports;
  const memory = exports.memory;
  return { instance, exports, memory };
}

/**
 * 重置单例（仅用于测试）
 */
function _reset() {
  _modulePromise = null;
}

module.exports = { getWasmModule, createInstance, _reset };
