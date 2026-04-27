require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pino = require("pino")();
const authController = require("./src/controllers/authController.js");
const { ipRateLimiter } = require("./src/middleware/rateLimiter");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cors({
  origin: true, // Reflects the request origin
  credentials: true
}));

// Routes
app.post("/api/login", ipRateLimiter, authController.requestOtp);
app.post("/api/verify", ipRateLimiter, authController.verifyOtp);

// Garbage Collector (Cleanup Memory)
setInterval(
  () => {
    const store = authController.userStore;
    const now = Date.now();
    for (const k in store) {
      if (
        (!store[k].blockedUntil || now > store[k].blockedUntil) &&
        now > store[k].expiresAt
      ) {
        delete store[k];
      }
    }
  },
  10 * 60 * 1000,
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => pino.info(`Auth Server running on http://localhost:${PORT}`));
