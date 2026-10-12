const express = require("express");
const cors = require("cors");
const config = require("./src/config");
const { logger } = require("./src/helpers/logger");
const authController = require("./src/controllers/authController.js");
const channelController = require("./src/controllers/channelController.js");
const { requireAdmin } = require("./src/helpers/adminAuth.js");
const {
  channelStatus,
  startChannelMonitor,
  stopChannelMonitor,
} = require("./src/services/whatsappService.js");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// --- routes ---
app.post("/api/login", authController.requestOtp);
app.post("/api/verify", authController.verifyOtp);
app.post("/api/notify-block", authController.notifyBlock);
app.post("/api/notify", authController.sendNotification);

/**
 * Liveness plus a one-glance answer to "are my numbers up?". Reports unhealthy
 * when every channel is down, so a load balancer or uptime check notices a
 * service that is running but cannot actually send anything.
 */
app.get("/health", (req, res) => {
  const channels = channelStatus();
  const healthy = channels.available > 0;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptimeSeconds: Math.round(process.uptime()),
    channels: {
      total: channels.total,
      // 'available' is what messages can be routed to; 'connected' is what
      // Evolution has actually confirmed. They differ when the status endpoint
      // is unreachable but sending has not been proven broken.
      available: channels.available,
      connected: channels.connected,
    },
  });
});

// --- channel administration ---
// Admin-scoped: these create and delete WhatsApp senders. The listing is behind
// the same guard because it names every sender and its last error, which is
// reconnaissance for anyone probing the service.
app.get("/api/channels", requireAdmin, channelController.list);
app.post("/api/channels/link", requireAdmin, channelController.link);
app.post("/api/channels/adopt", requireAdmin, channelController.adopt);
app.get("/api/channels/:name", requireAdmin, channelController.describe);
app.post("/api/channels/:name/logout", requireAdmin, channelController.logout);
app.delete("/api/channels/:name", requireAdmin, channelController.unlink);

// --- memory store cleanup ---
// Records are dropped once their code has expired AND any block has elapsed,
// which is also what resets a phone's request counter over time.
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const IP_RECORD_IDLE_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();

  for (const [phone, record] of Object.entries(authController.userStore)) {
    const blocked = record.blockedUntil && now < record.blockedUntil;
    if (blocked) continue;
    // No live code left either because it expired or because it was never
    // issued (a request rejected before sending).
    if (!record.expiresAt || now > record.expiresAt) delete authController.userStore[phone];
  }

  // The IP store had no cleanup at all, so it grew for the life of the process.
  for (const [ip, record] of Object.entries(authController.ipStore)) {
    const blocked = record.blockedUntil && now < record.blockedUntil;
    if (!blocked && now - (record.lastActivityAt || 0) > IP_RECORD_IDLE_MS) {
      delete authController.ipStore[ip];
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

// Start probing each WhatsApp number's connection before accepting traffic, so
// the first message doesn't get routed to a channel that is already logged out.
startChannelMonitor();

const server = app.listen(config.port, () =>
  logger.info(
    { port: config.port, channels: config.channels.length },
    `Auth server listening on http://localhost:${config.port}`,
  ),
);

// Flush the farmer-to-number map before exiting, so a restart doesn't move
// farmers whose assignment was made in the last couple of seconds.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    logger.info({ signal }, "Shutting down");
    stopChannelMonitor();
    server.close(() => process.exit(0));
  });
}
