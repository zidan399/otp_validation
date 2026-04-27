const jwt = require("jsonwebtoken");
const { sanitizePhone } = require("../helpers/sanitizer");
const { generateOTP, isSecureEqual } = require("../helpers/security");
const { sendError } = require("../helpers/response");
const { sendWhatsAppMessage } = require("../services/whatsappService");

const userStore = {}; // Memory Store
const MAX_REQUESTS = 3;
const MAX_ATTEMPTS = 3;
const BLOCK_TIME = 60 * 60 * 1000;

exports.requestOtp = async (req, res) => {
  const phone = sanitizePhone(req.body.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format.");

  let record = userStore[phone] || {
    code: null,
    expiresAt: null,
    requests: 0,
    attempts: 0,
    blockedUntil: null,
  };
  const now = Date.now();

  if (record.blockedUntil && now < record.blockedUntil) {
    return sendError(
      res,
      403,
      `Blocked. Try again in ${Math.ceil((record.blockedUntil - now) / 60000)} mins.`,
    );
  }

  if (record.requests >= MAX_REQUESTS) {
    record.blockedUntil = now + BLOCK_TIME;
    record.requests = 0;
    userStore[phone] = record;
    await sendWhatsAppMessage(
      phone,
      "*ReNile* 🛡️\nMultiple OTP requests detected. Account temporarily blocked for 1 hour.\n\nتم اكتشاف طلبات متعددة لرمز التحقق. تم حظر الحساب مؤقتًا لمدة ساعة واحدة.",
    );
    return sendError(res, 403, "Too many requests. Blocked for 1 hour.");
  }

  const otp = generateOTP();
  record.code = otp;
  record.expiresAt = now + 5 * 60 * 1000;
  record.requests += 1;
  userStore[phone] = record;

  const sent = await sendWhatsAppMessage(
    phone,
    `*ReNile OTP* 🔑\nYour login code is: *${otp}*\nValid for 5 minutes.\n\nرمز تسجيل الدخول الخاص بك هو: *${otp}*\nصالح لمدة 5 دقائق.`,
  );

  return sent
    ? res.json({ success: true, message: "OTP sent." })
    : sendError(res, 500, "Failed to send.");
};

exports.verifyOtp = async (req, res) => {
  const phone = sanitizePhone(req.body.phone);
  const { code } = req.body;
  if (!phone || !code) return sendError(res, 400, "Phone and code required.");

  const record = userStore[phone];
  const now = Date.now(); // Get current time

  // --- NEW SECURITY CHECK: Block Status ---
  if (record && record.blockedUntil && now < record.blockedUntil) {
    const timeLeft = Math.ceil((record.blockedUntil - now) / 60000);
    return sendError(
      res,
      403,
      `This account is currently blocked for security reasons. Try again in ${timeLeft} minutes.`,
    );
  }

  // --- EXISTING LOGIC ---
  if (!record || !record.code) return sendError(res, 400, "No OTP requested.");

  if (now > record.expiresAt) return sendError(res, 400, "OTP expired.");

  if (isSecureEqual(code.toString(), record.code)) {
    delete userStore[phone];
    const token = jwt.sign({ phone, role: "user" }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });
    return res.json({ success: true, token });
  } else {
    record.attempts += 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      record.blockedUntil = Date.now() + BLOCK_TIME;
      userStore[phone] = record;
      await sendWhatsAppMessage(
        phone,
        "*ReNile* 🛡️\nToo many failed login attempts. Account blocked for 1 hour.\n\nتم استنفاد محاولات تسجيل الدخول. تم حظر الحساب لمدة ساعة واحدة.",
      );
      return sendError(res, 403, "Blocked for 1 hour.");
    }
    userStore[phone] = record;
    return sendError(
      res,
      400,
      `Invalid code. ${MAX_ATTEMPTS - record.attempts} left.`,
    );
  }
};

// Export the store for the garbage collector in server.js
exports.userStore = userStore;
