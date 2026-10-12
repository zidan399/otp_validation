// pm2 start ecosystem.config.js
// One instance only: OTP codes and blocks live in process memory, so cluster
// mode would issue a code on one worker and verify it on another.
module.exports = {
  apps: [
    {
      name: "nojo-otp",
      script: "server.js",
      // .env and ./data/*.json are read relative to cwd.
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      // Time for the SIGTERM handler to flush channel assignments.
      kill_timeout: 5000,
      max_memory_restart: "300M",
    },
  ],
};
