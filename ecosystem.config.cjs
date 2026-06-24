// ecosystem.config.cjs — PR-5.8
// PM2 进程管理配置
//
// 用法:
//   npm i -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 logs
//   pm2 stop deepseek-mirror
//   pm2 reload deepseek-mirror  # 0-downtime 重载

module.exports = {
  apps: [{
    name: 'deepseek-mirror',
    script: 'server.js',
    instances: 1,  // 单实例（SQLite 不支持多写）
    exec_mode: 'fork',
    max_memory_restart: '512M',
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      LOG_LEVEL: 'info',
    },
    // 日志
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,

    // 优雅关停（最长等 10s）
    kill_timeout: 10000,
    listen_timeout: 10000,

    // 启动后健康检查
    wait_ready: false,
  }],
};
