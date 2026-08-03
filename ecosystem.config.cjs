module.exports = {
  apps: [{
    name: "texlite",
    script: "dist/server/index.js",
    cwd: __dirname,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    kill_timeout: 10000,
    env: {
      NODE_ENV: "production"
    }
  }]
};
