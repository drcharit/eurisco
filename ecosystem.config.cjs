module.exports = {
  apps: [{
    name: "eurisco",
    script: "dist/index.js",
    cwd: "/home/admin/kit",
    env_file: ".env",
    max_memory_restart: "300M",
    restart_delay: 5000,
    max_restarts: 10,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true,
  }],
};
