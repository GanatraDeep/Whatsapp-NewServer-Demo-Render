module.exports = {
  apps: [{
    name: 'whatsapp-api',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    log_file: '/var/log/whatsapp-api/combined.log',
    out_file: '/var/log/whatsapp-api/out.log',
    error_file: '/var/log/whatsapp-api/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};