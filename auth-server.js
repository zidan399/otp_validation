const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const pino = require("pino");
const dotenv = require("dotenv").config();
const jwt = require("jsonwebtoken");

// --- LOGGER INITIALIZATION ---
const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
const EVOLUTION_URL = process.env.EVOLUTION_URL || "http://127.0.0.1:8080";
const API_KEY = process.env.API_KEY || "local_test_key_123";
const INSTANCE_NAME = process.env.INSTANCE_NAME || "OTP_Service";

const MAX_REQUESTS = 3;
const MAX_ATTEMPTS = 3;
const BLOCK_DURATION_MS = 60 * 60 * 1000;

// --- STATE MANAGEMENT ---
const userStore = {};

// Garbage Collection: Clears inactive records every 10 minutes to prevent RAM leaks
setInterval(
  () => {
    const now = Date.now();
    let cleared = 0;
    for (const phone in userStore) {
      const r = userStore[phone];
      const isBlocked = r.blockedUntil && now < r.blockedUntil;
      const isCodeActive = r.code && r.expiresAt && now < r.expiresAt;

      if (!isBlocked && !isCodeActive) {
        delete userStore[phone];
        cleared++;
      }
    }
    if (cleared > 0)
      logger.debug(`[GC] Cleared ${cleared} inactive memory records.`);
  },
  10 * 60 * 1000,
);

// --- HELPER FUNCTIONS ---

/**
 * Sanitizes phone numbers to a common key.
 * 1. Removes all non-digits (fixes the "+" issue).
 * 2. Converts 01... (Egypt local) to 201... (International).
 */
const sanitizePhone = (phone) => {
  if (typeof phone !== "string") return null;

  // Remove all non-digits (removes +, spaces, -, etc.)
  let cleaned = phone.replace(/\D/g, "");

  // Convert Egyptian local format (01...) to International (201...)
  if (cleaned.length === 11 && cleaned.startsWith("01")) {
    cleaned = "2" + cleaned;
  }

  // Final length check (standard for MENA region is 10-15 digits)
  return cleaned.length >= 10 && cleaned.length <= 15 ? cleaned : null;
};

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const isSecureEqual = (userInput, storedCode) => {
  if (!userInput || !storedCode || userInput.length !== storedCode.length)
    return false;
  return crypto.timingSafeEqual(
    Buffer.from(userInput),
    Buffer.from(storedCode),
  );
};

const sendError = (res, status, message) => {
  return res
    .status(status)
    .json({ success: false, error: { code: status, message } });
};

const sendWhatsAppMessage = async (phone, textMessage) => {
  const payload = {
    number: phone,
    options: { delay: 1200, presence: "composing" },
    text: textMessage,
  };

  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`,
      payload,
      {
        headers: { apikey: API_KEY, "Content-Type": "application/json" },
      },
    );
    return true;
  } catch (error) {
    logger.error(
      `[Evolution API] Failure: ${error.response?.data?.message || error.message}`,
    );
    return false;
  }
};

// --- SECURITY MIDDLEWARE ---
const ipRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  handler: (req, res) =>
    sendError(
      res,
      429,
      "Too many requests from your network. Please wait 15 minutes.",
    ),
  standardHeaders: true,
  legacyHeaders: false,
});

// --- ENDPOINT 1: REQUEST OTP ---
app.post("/api/login", ipRateLimiter, async (req, res) => {
  const { phone: rawPhone } = req.body;
  const phone = sanitizePhone(rawPhone);

  if (!phone)
    return sendError(
      res,
      400,
      "Invalid phone format. Please use a valid number.",
    );

  let record = userStore[phone] || {
    code: null,
    expiresAt: null,
    requests: 0,
    attempts: 0,
    blockedUntil: null,
  };
  const now = Date.now();

  if (record.blockedUntil && now < record.blockedUntil) {
    const timeLeft = Math.ceil((record.blockedUntil - now) / 60000);
    return sendError(
      res,
      403,
      `Account blocked. Try again in ${timeLeft} minutes.`,
    );
  }

  if (record.requests >= MAX_REQUESTS) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
    record.requests = 0;
    record.attempts = 0;
    userStore[phone] = record;

    logger.warn(`[SECURITY] Blocked ${phone} for spamming requests.`);
    await sendWhatsAppMessage(
      phone,
      "*ReNile* 🛡️\nMultiple OTP requests detected. Account temporarily blocked for 1 hour.\n\nتم اكتشاف طلبات متعددة لرمز التحقق. تم حظر الحساب مؤقتًا لمدة ساعة واحدة.",
    );
    return sendError(res, 403, "Too many OTP requests. Blocked for 1 hour.");
  }

  const otpCode = generateOTP();
  record.code = otpCode;
  record.expiresAt = now + 5 * 60 * 1000;
  record.requests += 1;
  userStore[phone] = record;

  const sent = await sendWhatsAppMessage(
    phone,
    `*ReNile OTP* 🔑\nYour login code is: *${otp}*\nValid for 5 minutes.\n\nرمز تسجيل الدخول الخاص بك هو: *${otp}*\nصالح لمدة 5 دقائق.`,
  );

  if (sent) {
    logger.info(
      `[OTP Sent] Target: ${phone} | Request: ${record.requests}/${MAX_REQUESTS}`,
    );
    return res
      .status(200)
      .json({ success: true, message: "OTP sent successfully." });
  } else {
    return sendError(res, 500, "Failed to send OTP.");
  }
});

// --- ENDPOINT 2: VERIFY OTP ---
app.post("/api/verify", ipRateLimiter, async (req, res) => {
  const { phone: rawPhone, code } = req.body;
  const phone = sanitizePhone(rawPhone);

  if (!phone || !code)
    return sendError(res, 400, "Valid phone and code are required.");

  const record = userStore[phone];
  const now = Date.now();

  if (!record || !record.code)
    return sendError(res, 400, "No OTP requested for this number.");

  if (record.blockedUntil && now < record.blockedUntil) {
    const timeLeft = Math.ceil((record.blockedUntil - now) / 60000);
    return sendError(
      res,
      403,
      `Account blocked. Try again in ${timeLeft} minutes.`,
    );
  }

  if (now > record.expiresAt) {
    record.code = null;
    return sendError(res, 400, "OTP has expired. Please request a new one.");
  }

  if (isSecureEqual(code.toString(), record.code)) {
    delete userStore[phone];

    // Create the payload (data you want to store in the token)
    const payload = {
      phone: phone,
      role: "user", // or fetch from your user database if you had one
      company: "ReNile",
    };

    // Sign the token
    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET || "your_super_secret_key",
      {
        expiresIn: "7d", // User stays logged in for 7 days
      },
    );

    logger.info(`[Auth Success] Target: ${phone}`);
    return res.status(200).json({
      success: true,
      message: "Login successful!",
      token: token, // This is the real JWT
    });
  } else {
    record.attempts += 1;

    if (record.attempts >= MAX_ATTEMPTS) {
      record.blockedUntil = now + BLOCK_DURATION_MS;
      record.attempts = 0;
      record.requests = 0;
      record.code = null;
      userStore[phone] = record;

      logger.warn(`[SECURITY] Blocked ${phone} for brute-force attempts.`);
      await sendWhatsAppMessage(
        phone,
        "*ReNile* 🛡️\nToo many failed login attempts. Account blocked for 1 hour.\n\nتم استنفاد محاولات تسجيل الدخول. تم حظر الحساب لمدة ساعة واحدة.",
      );
      return sendError(
        res,
        403,
        "Too many wrong attempts. Blocked for 1 hour.",
      );
    }

    userStore[phone] = record;
    return sendError(
      res,
      400,
      `Invalid OTP code. You have ${MAX_ATTEMPTS - record.attempts} attempts left.`,
    );
  }
});

// --- SERVER & GRACEFUL SHUTDOWN ---
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () =>
  logger.info(`Auth Server running on port ${PORT}`),
);

const gracefulShutdown = () => {
  logger.info("Termination signal received. Shutting down gracefully...");
  server.close(() => {
    logger.info("Closed remaining connections.");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("Forcefully shutting down due to timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
