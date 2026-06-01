module.exports = {
  apps: [
    {
      name:          "tradeai-sim",
      script:        "src/index.js",
      watch:         false,
      autorestart:   true,
      max_restarts:  10,
      min_uptime:    "30s",
      restart_delay: 5000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file:    "./logs/pm2-error.log",
      out_file:      "./logs/pm2-out.log",
      merge_logs:    true,
      env: {
        NODE_ENV: "production",
        MODE:     "sim",        // simulação 24/7
      },
      env_demo: {
        NODE_ENV: "production",
        MODE:     "demo",
        BROKER:   "alpaca",
      },
      env_real: {
        NODE_ENV: "production",
        MODE:     "real",
        BROKER:   "alpaca",
      },
    },
  ],
};
