// lib/crypto.js
// AES-256-GCM 加密 / 解密工具，用于加密存储 DeepSeek 账号凭据。
//
// 设计要点：
//   - 密钥派生：从 DB_ENCRYPT_KEY（passphrase）经 scrypt 派生 32 字节 key
//   - 每次加密生成随机 12 字节 IV
//   - 密文格式：base64(IV || authTag || ciphertext)
//   - 失败时一律抛错（不让调用方拿 undefined）

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;       // GCM 标准 IV 长度
const SALT = 'ds-mirror-v1'; // 派生盐（写死即可，passphrase 才是关键）
const KEY_LEN = 32;      // AES-256
const SCRYPT_OPTS = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

let _key = null;

function getKey() {
  if (_key) return _key;
  const passphrase = process.env.DB_ENCRYPT_KEY;
  if (!passphrase) {
    throw new Error('DB_ENCRYPT_KEY is not set. Refusing to encrypt/decrypt.');
  }
  _key = crypto.scryptSync(passphrase, SALT, KEY_LEN, SCRYPT_OPTS);
  return _key;
}

/**
 * 加密明文，返回 base64 字符串。
 * @param {string} plaintext
 * @returns {string} base64(IV || authTag || ciphertext)
 */
function encryptToken(plaintext) {
  if (plaintext == null) throw new Error('encryptToken: plaintext is null');
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * 解密 base64 字符串，返回明文。
 * @param {string} payload
 * @returns {string}
 */
function decryptToken(payload) {
  if (!payload) throw new Error('decryptToken: payload is empty');
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + 16) {
    throw new Error('decryptToken: payload too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const enc = buf.subarray(IV_LEN + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * 探测一个字符串是否为加密格式（base64 且长度 >= 28）。
 * 用于 db.js 的迁移函数中判断旧/新数据。
 */
function looksEncrypted(s) {
  if (typeof s !== 'string' || s.length < 28) return false;
  return /^[A-Za-z0-9+/=]+$/.test(s);
}

module.exports = { encryptToken, decryptToken, looksEncrypted };
