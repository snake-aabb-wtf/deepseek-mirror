// lib/logger.js
// [PR-4.3] 结构化日志封装 (pino)
//
// 设计：
//   - 默认输出 JSON (生产)
//   - NODE_ENV=development 时用 pino-pretty (人眼可读)
//   - 暴露 child logger helper: logger.child({ component: 'db' })
//
// 用法：
//   const { logger, createLogger } = require('./lib/logger');
//   logger.info({ userId }, 'user logged in');
//   const dbLog = createLogger('db');
//   dbLog.warn({ err }, 'migrate failed');

const pino = require('pino');

function buildLogger(component) {
  const isDev = process.env.NODE_ENV !== 'production';
  const opts = {
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    base: component ? { component } : undefined,
  };
  if (isDev) {
    opts.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    };
  }
  return pino(opts);
}

const logger = buildLogger();

function createLogger(component) {
  return buildLogger(component);
}

module.exports = { logger, createLogger };
