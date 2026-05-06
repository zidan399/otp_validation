const jwt = require("jsonwebtoken");
const { sanitizePhone } = require("../helpers/sanitizer");
const { generateOTP, isSecureEqual } = require("../helpers/security");
const { sendError } = require("../helpers/response");
const { sendWhatsAppMessage } = require("../services/whatsappService");

const userStore = {}; // Memory Store for phones
const ipStore = {};   // Memory Store for IPs

exports.requestOtp = async (req, res) => {
  const { token } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  if (!token) return sendError(res, 401, "Authorization token required.");

  let decoded;
  try {
    const secret = process.env.OTP_JWT_SECRET || process.env.JWT_SECRET || "default_otp_secret";
    decoded = jwt.verify(token, secret);
    console.log(`[OTP Service] Received dynamic config from Backend:`, {
      maxAttempts: decoded.maxAttempts,
      maxAttemptsIp: decoded.maxAttemptsIp,
      blockDurations: decoded.blockDurations,
      otpExpiryMinutes: decoded.otpExpiryMinutes
    });
  } catch (err) {
    console.error("[OTP Service] JWT Verification Error:", err.message);
    return sendError(res, 401, "Invalid or expired authorization token.");
  }

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  // DYNAMIC CONFIG FROM BACKEND (with fallbacks)
  const maxAttempts = decoded.maxAttempts || 3;
  const maxAttemptsIp = decoded.maxAttemptsIp || 20;
  const blockDurations = decoded.blockDurations || [30, 60, 1440];
  const maxRequests = decoded.maxRequests || 3;
  const otpExpiryMinutes = decoded.otpExpiryMinutes || 2;

  const now = Date.now();

  // 1. CHECK IP BLOCK
  let ipRecord = ipStore[ip] || { attempts: 0, blockedUntil: null, blockCount: 0 };
  if (ipRecord.blockedUntil && now < ipRecord.blockedUntil) {
    const mins = Math.ceil((ipRecord.blockedUntil - now) / 60000);
    return sendError(res, 403, `IP Blocked. Try again in ${mins} mins.`);
  }

  // 2. CHECK PHONE BLOCK
  let record = userStore[phone] || {
    code: null,
    expiresAt: null,
    requests: 0,
    attempts: 0,
    blockedUntil: null,
    blockCount: 0,
  };

  if (record.blockedUntil && now < record.blockedUntil) {
    const minutesLeft = Math.ceil((record.blockedUntil - now) / 60000);
    return sendError(
      res,
      403,
      `Blocked. Try again in ${minutesLeft} mins.`,
    );
  }

  if (record.requests >= maxRequests) {
    // Progressive Block Calculation
    const blockIndex = Math.min(record.blockCount, blockDurations.length - 1);
    const durationMinutes = blockDurations[blockIndex];
    const blockTimeMs = durationMinutes * 60 * 1000;

    record.blockedUntil = now + blockTimeMs;
    record.requests = 0;
    record.blockCount += 1; // Increment block count for next time
    userStore[phone] = record;

    const hours = durationMinutes / 60;
    const blockMsg = hours >= 1 
      ? `${hours} hour${hours > 1 ? 's' : ''}` 
      : `${durationMinutes} minutes`;

    await sendWhatsAppMessage(
      phone,
      `*ReNile* 🛡️\nMultiple OTP requests detected. Account temporarily blocked for ${blockMsg}.\n\nتم اكتشاف طلبات متعددة لرمز التحقق. تم حظر الحساب مؤقتًا لمدة ${hours >= 1 ? (hours === 24 ? 'يوم' : 'ساعة') : 'دقائق'}.`,
    );
    return sendError(res, 403, `Too many requests. Blocked for ${blockMsg}.`);
  }

  const otp = generateOTP();
  record.code = otp;
  record.expiresAt = now + otpExpiryMinutes * 60 * 1000;
  record.requests += 1;
  record.lastFailedCode = null; // NEW: Reset failed code on new request
  userStore[phone] = record;

  console.log(`[OTP Service] Generated OTP for ${phone}. Expires at: ${record.expiresAt} (in ${otpExpiryMinutes}m)`);

  const sent = await sendWhatsAppMessage(
    phone,
    `*ReNile OTP* 🔑\nYour login code is: *${otp}*\nValid for 2 minutes.\n\nرمز تسجيل الدخول الخاص بك هو: *${otp}*\nصالح لمدة دقيقتين.`,
  );

  return sent
    ? res.json({ success: true, message: "OTP sent." })
    : sendError(res, 500, "Failed to send.");
};

exports.verifyOtp = async (req, res) => {
  const { token, code } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  if (!token || !code) return sendError(res, 400, "Token and code required.");

  let decoded;
  try {
    const secret = process.env.OTP_JWT_SECRET || process.env.JWT_SECRET || "default_otp_secret";
    decoded = jwt.verify(token, secret);
  } catch (err) {
    console.error("[OTP Service] JWT Verification Error (Verify):", err.message);
    return sendError(res, 401, "Invalid or expired authorization token.");
  }

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  // NEW: OTP Length Validation
  if (!code || code.toString().length !== 6) {
    console.log(`[OTP Service] Invalid code length (${code?.toString()?.length}) for ${phone}. Skipping increment.`);
    return sendError(res, 400, "OTP must be 6 digits.", false);
  }

  // DYNAMIC CONFIG FROM BACKEND
  const maxAttempts = decoded.maxAttempts || 3;
  const maxAttemptsIp = decoded.maxAttemptsIp || 20;
  const blockDurations = decoded.blockDurations || [30, 60, 1440];

  const record = userStore[phone];
  const now = Date.now(); // Get current time

  // 1. CHECK IP BLOCK
  let ipRecord = ipStore[ip] || { attempts: 0, blockedUntil: null, blockCount: 0 };
  if (ipRecord.blockedUntil && now < ipRecord.blockedUntil) {
    const mins = Math.ceil((ipRecord.blockedUntil - now) / 60000);
    return sendError(res, 403, `IP Blocked. Try again in ${mins} mins.`);
  }

  // 2. CHECK PHONE BLOCK
  if (record && record.blockedUntil && now < record.blockedUntil) {
    const timeLeft = Math.ceil((record.blockedUntil - now) / 60000);
    return sendError(
      res,
      403,
      `This account is currently blocked for security reasons. Try again in ${timeLeft} minutes.`,
    );
  }

  // --- EXISTING LOGIC ---
  if (!record || !record.code) return sendError(res, 400, "Invalid or expired verification session.", false);

  console.log(`[OTP Service] Verifying OTP for ${phone}. Now: ${now}, ExpiresAt: ${record.expiresAt}, Diff: ${record.expiresAt - now}ms`);

  if (now > record.expiresAt) {
    console.warn(`[OTP Service] OTP expired for ${phone}.`);
    return sendError(res, 400, "OTP expired.", false);
  }


  if (isSecureEqual(code.toString(), record.code)) {
    delete userStore[phone];
    // Reset IP attempts on success
    if (ipStore[ip]) delete ipStore[ip];

    const token = jwt.sign({ phone, role: "user" }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });
    return res.json({ success: true, token });
  } else {
    const codeStr = code.toString();
    console.log(`[OTP Service] Wrong code comparison for ${phone}: Input='${codeStr}', LastFailed='${record.lastFailedCode}'`);

    // ONLY increment attempts if they entered a DIFFERENT wrong code
    if (record.lastFailedCode !== codeStr) {
      record.attempts += 1;
      ipRecord.attempts += 1; // Increment IP attempts too
      record.lastFailedCode = codeStr; 
      
      console.log(`[OTP Service] NEW unique failure. Incrementing! Phone: ${record.attempts}/${maxAttempts}, IP: ${ipRecord.attempts}/${maxAttemptsIp}`);
      
      // CHECK IP LIMIT
      if (ipRecord.attempts >= maxAttemptsIp) {
        const blockIndex = Math.min(ipRecord.blockCount || 0, blockDurations.length - 1);
        const durationMinutes = blockDurations[blockIndex];
        ipRecord.blockedUntil = Date.now() + (durationMinutes * 60 * 1000);
        ipRecord.blockCount = (ipRecord.blockCount || 0) + 1;
        ipStore[ip] = ipRecord;
        return sendError(res, 403, `IP Blocked for ${durationMinutes} mins.`);
      }
      ipStore[ip] = ipRecord;

    } else {
      console.log(`[OTP Service] DUPLICATE failure detected for ${phone}. Skipping increment.`);
      return sendError(res, 400, "Invalid code.", false);
    }

    if (record.attempts >= maxAttempts) {
      // Progressive Block Calculation (Circular: 2 -> 4 -> 6 -> 2...)
      const blockIndex = (record.blockCount || 0) % blockDurations.length;
      const durationMinutes = blockDurations[blockIndex];

      const blockTimeMs = durationMinutes * 60 * 1000;

      record.blockedUntil = Date.now() + blockTimeMs;
      record.blockCount = (record.blockCount || 0) + 1;
      userStore[phone] = record;

      const hours = durationMinutes / 60;
      const blockMsg = hours >= 1 
        ? `${hours} hour${hours > 1 ? 's' : ''}` 
        : `${durationMinutes} minutes`;

      await sendWhatsAppMessage(
        phone,
        `*ReNile* 🛡️\nToo many failed login attempts. Account blocked for ${blockMsg}.\n\nتم استنفاد محاولات تسجيل الدخول. تم حظر الحساب لمدة ${hours >= 1 ? (hours === 24 ? 'يوم' : 'ساعة') : 'دقائق'}.`,
      );
      return sendError(res, 403, `Blocked for ${blockMsg}.`);
    }
    userStore[phone] = record;
    return sendError(res, 400, "Invalid code.");
  }
};

exports.notifyBlock = async (req, res) => {
  const { token, durationMinutes, reason } = req.body;
  if (!token) return sendError(res, 401, "Authorization token required.");

  let decoded;
  try {
    const secret = process.env.OTP_JWT_SECRET || process.env.JWT_SECRET || "default_otp_secret";
    decoded = jwt.verify(token, secret);
  } catch (err) {
    return sendError(res, 401, "Invalid or expired authorization token.");
  }

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  const hours = durationMinutes / 60;
  const blockMsg = hours >= 1 
    ? `${hours} hour${hours > 1 ? 's' : ''}` 
    : `${durationMinutes} minutes`;

  let arTimeStr = "";
  if (hours >= 1) {
    if (hours === 24) arTimeStr = "يوم كامل";
    else if (hours === 1) arTimeStr = "ساعة واحدة";
    else arTimeStr = `${hours} ساعة`;
  } else {
    if (durationMinutes === 1) arTimeStr = "دقيقة واحدة";
    else if (durationMinutes === 2) arTimeStr = "دقيقتين";
    else arTimeStr = `${durationMinutes} دقائق`;
  }

  console.log(`[OTP Service] notifyBlock request received for ${phone}. Reason: ${reason}, Duration: ${durationMinutes}m`);

  const sent = await sendWhatsAppMessage(
    phone,
    `*ReNile* 🛡️\nSecurity Alert: Your account has been temporarily blocked for ${blockMsg} due to suspicious activity.\n\nتنبيه أمني: تم حظر حسابك مؤقتًا لمدة ${arTimeStr} بسبب نشاط مشبوه.`,
  );

  console.log(`[OTP Service] notifyBlock WhatsApp status for ${phone}: ${sent ? 'SUCCESS' : 'FAILED'}`);
  return res.json({ success: !!sent });
};

exports.sendNotification = async (req, res) => {
  const { token, message } = req.body;
  if (!token || !message) return sendError(res, 400, "Token and message required.");

  let decoded;
  try {
    const secret = process.env.OTP_JWT_SECRET || process.env.JWT_SECRET || "default_otp_secret";
    decoded = jwt.verify(token, secret);
  } catch (err) {
    console.error("[OTP Service] JWT Verification Error (sendNotification):", err.message);
    return sendError(res, 401, "Invalid or expired authorization token.");
  }

  const phone = sanitizePhone(decoded.phone);
  if (!phone) return sendError(res, 400, "Invalid phone format in token.");

  console.log(`[OTP Service] sendNotification request received for ${phone}.`);

  const sent = await sendWhatsAppMessage(phone, message);

  console.log(`[OTP Service] sendNotification WhatsApp status for ${phone}: ${sent ? 'SUCCESS' : 'FAILED'}`);
  return res.json({ success: !!sent });
};

// Export the stores
exports.userStore = userStore;
exports.ipStore = ipStore;
