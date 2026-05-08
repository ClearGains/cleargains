module.exports = {
  apps: [
    {
      name:         'nexustrade-bot',
      script:       './dist/index.js',
      instances:    1,
      autorestart:  true,
      watch:        false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV:  'production',
        PORT:      '3001',
      },
      // Logs go to ~/.pm2/logs/nexustrade-bot-*.log
      error_file:   '/home/ubuntu/.pm2/logs/nexustrade-bot-error.log',
      out_file:     '/home/ubuntu/.pm2/logs/nexustrade-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
