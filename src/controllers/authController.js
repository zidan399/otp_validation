const jwt = require("jsonwebtoken");
const config = require("../config");
const { sanitizePhone } = require("../helpers/sanitizer");
const { generateOTP, isSecureEqual } = require("../helpers/security");
const { sendError } = require("../helpers/response");
const { logger, maskPhone } = require("../helpers/logger");
const { sendWhatsAppMessage } = require("../services/whatsappService");

/**
 * OTP issuing and verification.
 *
 * Both stores are in-memory and per-process: codes and blocks are lost on
 * restart, and running two copies of this service would give each its own view.
 * That is a known limitation (see Readme) — it does not affect channel
 * rotation, which is stateless with respect to these records.
 */
const userStore = {}; // keyed by sanitized phone
const ipStore = {}; // keyed by client IP, only when the caller identifies one

const FALLBACKS = {
  requestOtp: { maxRequests: 5, blockDurations: [15, 30, 180], otpExpiryMinutes: 2 },
  verifyOtp: { maxAttempts: 3, maxAttemptsIp: 20, blockDurations: [30, 60, 1440] },
  messageHeader: "ReNile",
};

// --- helpers -----------------------------------------------------------------

/** Verifies the backend's service-to-service token and returns its claims. */
function decodeToken(token, context) {
  try {
    return { decoded: jwt.verify(token, config.otpJwtSecret) };
  } catch (error) {
    logger.error({ context, error: error.message }, "[OTP] Token verification failed");
    return { error: "Invalid or expired authorization token." };
  }
}

/**
 * The client's IP, or null.
 *
 * `req.ip` is NOT usable here: every request arrives from the Nojo backend, so
 * req.ip is the backend's address for all users at once. Applying IP limits to
 * it would let twenty wrong codes from twenty different farmers block the
 * twenty-first — a self-inflicted outage. So IP rules only apply when the
 * caller explicitly forwards the real client IP.
 */
function clientIpOf(req, decoded) {
  const forwarded = decoded?.clientIp || req.get("x-client-ip");
  return typeof forwarded === "string" && forwarded.trim() ? forwarded.trim() : null;
}

function ipRecordOf(ip) {
  if (!ip) return null;
  if (!ipStore[ip]) ipStore[ip] = { attempts: 0, blockedUntil: null, blockCount: 0, lastActivityAt: 0 };
  ipStore[ip].lastActivityAt = Date.now();
  return ipStore[ip];
}

/**
 * Renders a block duration for English and Arabic, always both — this
 * service's messages have never been language-selective (see AGENTS.md:
 * "Messages are sent in English + Arabic"). Turkish is additive on top of
 * that, appended only when the caller's token says so, so an existing
 * English or Arabic farmer's message is untouched byte-for-byte.
 */
function describeDuration(durationMinutes) {
  const hours = durationMinutes / 60;

  if (hours >= 1) {
    const en = `${hours} hour${hours > 1 ? "s" : ""}`;
    const tr = hours === 1 ? "1 saat" : `${hours} saat`;
    if (hours === 24) return { en, ar: "يوم كامل", tr: "1 tam gün" };
    if (hours === 1) return { en, ar: "ساعة واحدة", tr };
    return { en, ar: `${hours} ساعات`, tr };
  }

  const en = `${durationMinutes} minutes`;
  const tr = durationMinutes === 1 ? "1 dakika" : `${durationMinutes} dakika`;
  if (durationMinutes === 1) return { en, ar: "دقيقة واحدة", tr };
  if (durationMinutes === 2) return { en, ar: "دقيقتين", tr };
  return { en, ar: `${durationMinutes} دقائق`, tr };
}

/**
 * Appends a Turkish segment to an English+Arabic message body, only when
 * `lang` is exactly "tr". Any other value (including undefined, or a
 * malformed one from an old/unrecognized token) leaves the message exactly
 * as it always was — additive, never a replacement, so an English or Arabic
 * farmer's message is provably unchanged (FR-011). Mirrors `resolveLang` on
 * the Nojo_back side without importing across the repo boundary.
 */
function appendTurkish(baseMessage, lang, turkishLine) {
  return lang === "tr" ? `${baseMessage}\n\n${turkishLine}` : baseMessage;
}

/**
 * Applies the next progressive block to a record and returns its duration.
 * Each successive block is longer, up to the last configured step.
 */
function applyBlock(record, blockDurations) {
  const blockIndex = Math.min(record.blockCount || 0, blockDurations.length - 1);
  const durationMinutes = blockDurations[blockIndex];

  record.blockedUntil = Date.now() + durationMinutes * 60 * 1000;
  record.blockCount = (record.blockCount || 0) + 1;

  return durationMinutes;
}

/** True when a record is currently blocked; sends the 403 if so. */
function rejectIfBlocked(res, record, label) {
  if (!record || !record.blockedUntil || Date.now() >= record.blockedUntil) return false;
  const minutesLeft = Math.ceil((record.blockedUntil - Date.now()) / 60000);
  sendError(res, 403, `${label} Try again in ${minutesLeft} mins.`);
  return true;
}

// --- handlers ----------------------------------------------------------------

exports.requestOtp = async (req, res) => {
  const { token } = req.body;
  if (!token) return sendError(res, 401, "Authorization token required.");

  const { decoded, error } = decodeToken(token, "requestOtp");
  if (error) return sendError(res, 401, error);

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  // Security policy is owned by the backend and travels in the token, so the
  // two services can't drift apart. These fallbacks only apply to old tokens.
  const maxRequests = decoded.maxRequests || FALLBACKS.requestOtp.maxRequests;
  const blockDurations = decoded.blockDurations || FALLBACKS.requestOtp.blockDurations;
  const otpExpiryMinutes = decoded.otpExpiryMinutes || FALLBACKS.requestOtp.otpExpiryMinutes;
  const messageHeader = decoded.messageHeader || FALLBACKS.messageHeader;
  // Only ever "tr" or absent — Nojo_back narrows this before signing the
  // token (resolveLang), so an unrecognized value can't reach here. Treated
  // as "not Turkish" regardless, since this file has no way to verify that
  // narrowing happened.
  const lang = decoded.lang;

  const now = Date.now();
  const ip = clientIpOf(req, decoded);

  if (rejectIfBlocked(res, ipRecordOf(ip), "IP blocked.")) return;

  // Created only after the IP check, so a rejected request doesn't leave an
  // empty record behind that the cleanup pass would never collect.
  const record =
    userStore[phone] ||
    (userStore[phone] = {
      code: null,
      expiresAt: null,
      requests: 0,
      attempts: 0,
      blockedUntil: null,
      blockCount: 0,
      lastFailedCode: null,
    });

  if (rejectIfBlocked(res, record, "Blocked.")) return;

  if (record.requests >= maxRequests) {
    const durationMinutes = applyBlock(record, blockDurations);
    record.requests = 0;
    const duration = describeDuration(durationMinutes);

    logger.warn(
      { phone: maskPhone(phone), durationMinutes },
      "[OTP] Blocked for too many code requests",
    );

    await sendWhatsAppMessage(
      phone,
      appendTurkish(
        `*${messageHeader}* 🛡️\nMultiple OTP requests detected. Account temporarily blocked for ${duration.en}.\n\n` +
          `تم اكتشاف طلبات متعددة لرمز التحقق. تم حظر الحساب مؤقتًا لمدة ${duration.ar}.`,
        lang,
        `Birden fazla OTP isteği tespit edildi. Hesap ${duration.tr} süreyle geçici olarak engellendi.`,
      ),
      { purpose: "otp" },
    );

    return sendError(res, 403, `Too many requests. Blocked for ${duration.en}.`);
  }

  const otp = generateOTP();
  record.code = otp;
  record.expiresAt = now + otpExpiryMinutes * 60 * 1000;
  record.requests += 1;
  record.lastFailedCode = null;

  const validity = otpExpiryMinutes === 1 ? "1 minute" : `${otpExpiryMinutes} minutes`;
  const validityAr = otpExpiryMinutes === 1 ? "دقيقة واحدة" : otpExpiryMinutes === 2 ? "دقيقتين" : `${otpExpiryMinutes} دقائق`;

  const validityTr = otpExpiryMinutes === 1 ? "1 dakika" : `${otpExpiryMinutes} dakika`;

  const sendResult = await sendWhatsAppMessage(
    phone,
    appendTurkish(
      `*${messageHeader}* 🔑\nYour login code is: *${otp}*\nValid for ${validity}.\n\n` +
        `رمز تسجيل الدخول الخاص بك هو: *${otp}*\nصالح لمدة ${validityAr}.`,
      lang,
      `Giriş kodunuz: *${otp}*\n${validityTr} boyunca geçerli.`,
    ),
    // Logins are what a person is waiting on, so they may use channels that are
    // reserved away from alert traffic.
    { purpose: "otp" },
  );

  if (sendResult.success) {
    logger.info(
      { phone: maskPhone(phone), channel: sendResult.channel, expiresInMinutes: otpExpiryMinutes },
      "[OTP] Code sent",
    );
    return res.json({ success: true, message: "OTP sent.", channel: sendResult.channel });
  }

  if (sendResult.error === "NOT_ON_WHATSAPP") {
    // Still counts as a request: otherwise a number that can never receive a
    // code could be retried forever, free of the request limit.
    record.code = null;
    return sendError(res, 400, "The number is not on WhatsApp. Please create an account first.");
  }

  // A timeout is the one case where the code MAY have been delivered — the
  // gateway just didn't answer in time. Invalidating it would strand a farmer
  // holding a code that no longer works, so the code stays valid and they are
  // told to enter it if it arrived.
  if (sendResult.error === "TIMEOUT") {
    record.requests = Math.max(0, record.requests - 1);
    logger.warn({ phone: maskPhone(phone) }, "[OTP] Send timed out — keeping the code valid in case it arrived");
    return sendError(
      res,
      503,
      "الشبكة بطيئة حالياً. إذا وصلك الكود فأدخله، وإن لم يصل فأعد المحاولة.",
    );
  }

  // Our fault, not theirs — the code never reached the user, so don't make them
  // burn a request on it.
  record.code = null;
  record.requests = Math.max(0, record.requests - 1);

  if (sendResult.error === "NO_CHANNEL_AVAILABLE") {
    // 503, not 500: the backend reads 5xx as "the gateway is unhealthy", and
    // this is exactly that — every sender number is down or saturated.
    return sendError(res, 503, "Messaging channels are busy. Please try again shortly.");
  }
  return sendError(res, 500, "Failed to send.");
};

exports.verifyOtp = async (req, res) => {
  const { token, code } = req.body;
  if (!token || !code) return sendError(res, 400, "Token and code required.");

  const { decoded, error } = decodeToken(token, "verifyOtp");
  if (error) return sendError(res, 401, error);

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  const codeStr = code.toString();
  // A wrong-length entry is a typo, not an attempt — charging it against the
  // attempt budget would let fat fingers lock someone out.
  if (codeStr.length !== 6) return sendError(res, 400, "OTP must be 6 digits.", false);

  const maxAttempts = decoded.maxAttempts || FALLBACKS.verifyOtp.maxAttempts;
  const maxAttemptsIp = decoded.maxAttemptsIp || FALLBACKS.verifyOtp.maxAttemptsIp;
  const blockDurations = decoded.blockDurations || FALLBACKS.verifyOtp.blockDurations;
  const messageHeader = decoded.messageHeader || FALLBACKS.messageHeader;

  const now = Date.now();
  const ip = clientIpOf(req, decoded);
  const ipRecord = ipRecordOf(ip);
  const record = userStore[phone];

  if (rejectIfBlocked(res, ipRecord, "IP blocked.")) return;
  if (rejectIfBlocked(res, record, "This account is currently blocked for security reasons.")) return;

  if (!record || !record.code) {
    return sendError(res, 400, "Invalid or expired verification session.", false);
  }

  if (now > record.expiresAt) {
    logger.info({ phone: maskPhone(phone) }, "[OTP] Code expired");
    return sendError(res, 400, "OTP expired.", false);
  }

  if (isSecureEqual(codeStr, record.code)) {
    delete userStore[phone];
    if (ip) delete ipStore[ip];

    logger.info({ phone: maskPhone(phone) }, "[OTP] Verified");
    const sessionToken = jwt.sign({ phone, role: "user" }, config.jwtSecret, { expiresIn: "30d" });
    return res.json({ success: true, token: sessionToken });
  }

  // Re-submitting the SAME wrong code (a double-tap, a stale autofill) is one
  // mistake, not several, so only a new wrong code costs an attempt.
  if (record.lastFailedCode === codeStr) {
    return sendError(res, 400, "Invalid code.", false);
  }

  record.attempts += 1;
  record.lastFailedCode = codeStr;
  if (ipRecord) ipRecord.attempts += 1;

  logger.warn(
    { phone: maskPhone(phone), attempts: record.attempts, maxAttempts },
    "[OTP] Wrong code",
  );

  if (ipRecord && ipRecord.attempts >= maxAttemptsIp) {
    const durationMinutes = applyBlock(ipRecord, blockDurations);
    return sendError(res, 403, `IP Blocked for ${durationMinutes} mins.`);
  }

  if (record.attempts >= maxAttempts) {
    const durationMinutes = applyBlock(record, blockDurations);
    const duration = describeDuration(durationMinutes);

    logger.warn(
      { phone: maskPhone(phone), durationMinutes },
      "[OTP] Blocked for too many failed attempts",
    );

    await sendWhatsAppMessage(
      phone,
      `*${messageHeader}* 🛡️\nToo many failed login attempts. Account blocked for ${duration.en}.\n\n` +
        `تم استنفاد محاولات تسجيل الدخول. تم حظر الحساب لمدة ${duration.ar}.`,
      { purpose: "otp" },
    );

    return sendError(res, 403, `Blocked for ${duration.en}.`);
  }

  return sendError(res, 400, "Invalid code.");
};

exports.notifyBlock = async (req, res) => {
  const { token, durationMinutes, reason } = req.body;
  if (!token) return sendError(res, 401, "Authorization token required.");

  const { decoded, error } = decodeToken(token, "notifyBlock");
  if (error) return sendError(res, 401, error);

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  const messageHeader = decoded.messageHeader || FALLBACKS.messageHeader;
  const duration = describeDuration(Number(durationMinutes) || 0);

  const result = await sendWhatsAppMessage(
    phone,
    `*${messageHeader}* 🛡️\nSecurity Alert: Your account has been temporarily blocked for ${duration.en} due to suspicious activity.\n\n` +
      `تنبيه أمني: تم حظر حسابك مؤقتًا لمدة ${duration.ar} بسبب نشاط مشبوه.`,
    { purpose: "otp" },
  );

  logger.info(
    { phone: maskPhone(phone), reason, durationMinutes, success: result.success, channel: result.channel },
    "[OTP] Block notification",
  );

  return respondToSend(res, result);
};

exports.sendNotification = async (req, res) => {
  const { token, message } = req.body;
  if (!token || !message) return sendError(res, 400, "Token and message required.");

  const { decoded, error } = decodeToken(token, "sendNotification");
  if (error) return sendError(res, 401, error);

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  const result = await sendWhatsAppMessage(phone, message, { purpose: "alert" });

  logger.info(
    { phone: maskPhone(phone), success: result.success, channel: result.channel, error: result.error },
    "[OTP] Notification",
  );

  return respondToSend(res, result);
};

/**
 * Turns a send result into a response.
 *
 * This used to answer `success: !!sendResult` — and sendResult is an object, so
 * a failed send reported success. The backend's circuit breaker watches these
 * status codes to decide whether the WhatsApp session is in trouble, so it was
 * being told everything was fine no matter what.
 */
function respondToSend(res, result) {
  if (result.success) return res.json({ success: true, channel: result.channel });

  if (result.error === "NOT_ON_WHATSAPP") {
    return sendError(res, 400, "The number is not on WhatsApp.");
  }
  if (result.error === "NO_CHANNEL_AVAILABLE" || result.error === "TIMEOUT") {
    // Both are transient and retryable, and both are 5xx so the backend's
    // circuit breaker still counts them against the gateway's health.
    return sendError(res, 503, "Messaging channels are unavailable. Please try again shortly.");
  }
  return sendError(res, 502, "WhatsApp gateway failed to deliver the message.");
}

exports.userStore = userStore;
exports.ipStore = ipStore;
