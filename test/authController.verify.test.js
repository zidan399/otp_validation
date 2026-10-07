const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");

/**
 * Wrong codes cancel the code instead of blocking the phone (plan D4).
 *
 * Calls the controller directly with a fake req (body + get()) and a fake
 * res, seeding userStore through requestOtp with the WhatsApp send stubbed.
 */

// channelAdmin.test.js busts the require cache with
// key.includes("renile_evolution_otp/src") — a forward-slash match on the old
// repo name, so it matches nothing when this service lives at otp_validation,
// and nothing on Windows where separators are backslashes. Normalising first
// makes the buster work on both paths and both platforms.
function bustSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, "/").includes("otp_validation/src")) delete require.cache[key];
  }
}

bustSrcCache();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "otp-verify-"));
const stamp = Math.floor(Math.random() * 1e9);
Object.assign(process.env, {
  WHATSAPP_ASSIGNMENTS_FILE: path.join(tempDir, `assignments-${stamp}.json`),
  WHATSAPP_REGISTRY_FILE: path.join(tempDir, `registry-${stamp}.json`),
  EVOLUTION_URL: "http://127.0.0.1:8080",
  API_KEY: "test-key",
  JWT_SECRET: "test-secret",
  // Always reset: process.env is shared across tests, so a case that overrides
  // this would otherwise leak its secret into every test that follows.
  OTP_JWT_SECRET: "",
  LOG_LEVEL: "silent",
  WHATSAPP_CHANNEL_JITTER_MS: "0",
  WHATSAPP_CHANNEL_PROBE_MS: "0",
  WHATSAPP_CHANNELS: "",
  WHATSAPP_OTP_CHANNELS: "",
  WHATSAPP_ALERT_CHANNELS: "",
  WHATSAPP_CHANNEL_DAILY_CAP: "0",
  INSTANCE_NAME: "base",
});

// Stub the send BEFORE requiring the controller: authController destructures
// sendWhatsAppMessage at require time, so a later reassignment would miss it.
const sentMessages = [];
const whatsappService = require("../src/services/whatsappService");
whatsappService.sendWhatsAppMessage = async (phone, message, options) => {
  sentMessages.push({ phone, message, options });
  return { success: true, channel: "test-channel" };
};

const config = require("../src/config");
const controller = require("../src/controllers/authController");

const BACKEND_SECRET = config.otpJwtSecret;

function backendToken(phone, claims = {}) {
  return jwt.sign({ phone, ...claims }, BACKEND_SECRET, { expiresIn: "3m" });
}

function fakeReq(body) {
  return { body, get: () => undefined };
}

function fakeRes() {
  const captured = { status: 200, body: null };
  const res = {
    status(code) {
      captured.status = code;
      return res;
    },
    json(payload) {
      captured.body = payload;
      return res;
    },
  };
  return { res, captured };
}

function clearStores() {
  for (const key of Object.keys(controller.userStore)) delete controller.userStore[key];
  for (const key of Object.keys(controller.ipStore)) delete controller.ipStore[key];
  sentMessages.length = 0;
}

async function issueCode(phone, claims = {}) {
  const { res, captured } = fakeRes();
  await controller.requestOtp(fakeReq({ token: backendToken(phone, claims) }), res);
  assert.equal(captured.status, 200, `requestOtp failed: ${JSON.stringify(captured.body)}`);
  return controller.userStore[phone].code;
}

async function submitCode(phone, code, claims = {}) {
  const { res, captured } = fakeRes();
  await controller.verifyOtp(fakeReq({ token: backendToken(phone, claims), code }), res);
  return captured;
}

function wrongCodesExcept(real, count) {
  const pool = ["111111", "222222", "333333", "444444", "555555", "666666", "777777"];
  return pool.filter((candidate) => candidate !== real).slice(0, count);
}

test("the 5th distinct wrong code cancels the code instead of blocking the phone", async () => {
  clearStores();
  const phone = "201012345678";
  const claims = { maxAttempts: 5 };
  const realCode = await issueCode(phone, claims);
  const [first, second, third, fourth, fifth] = wrongCodesExcept(realCode, 5);

  for (const wrong of [first, second, third, fourth]) {
    const captured = await submitCode(phone, wrong, claims);
    assert.equal(captured.status, 400);
    assert.match(captured.body.error.message, /Invalid code/);
  }

  const sendsBefore = sentMessages.length;
  const cancelled = await submitCode(phone, fifth, claims);
  assert.equal(cancelled.status, 400);
  assert.match(cancelled.body.error.message, /cancelled/);

  const record = controller.userStore[phone];
  assert.ok(!record.blockedUntil, "cancelling must not block the phone");
  assert.equal(record.code, null);
  assert.equal(record.expiresAt, null);
  assert.equal(record.attempts, 0);
  assert.equal(record.lastFailedCode, null);
  assert.equal(sentMessages.length, sendsBefore, "cancelling must not send a WhatsApp notice");
});

test("the correct old code is rejected after the code is cancelled", async () => {
  clearStores();
  const phone = "201012345679";
  const claims = { maxAttempts: 5 };
  const realCode = await issueCode(phone, claims);

  for (const wrong of wrongCodesExcept(realCode, 5)) {
    await submitCode(phone, wrong, claims);
  }

  const retry = await submitCode(phone, realCode, claims);
  assert.equal(retry.status, 400);
  assert.equal(retry.body.success, false);
});

test("a new requestOtp resets attempts and issues a working code", async () => {
  clearStores();
  const phone = "201012345680";
  const claims = { maxAttempts: 5 };
  await issueCode(phone, claims);

  const realCode = controller.userStore[phone].code;
  for (const wrong of wrongCodesExcept(realCode, 2)) {
    await submitCode(phone, wrong, claims);
  }
  assert.equal(controller.userStore[phone].attempts, 2);

  const freshCode = await issueCode(phone, claims);
  assert.equal(controller.userStore[phone].attempts, 0);

  const verified = await submitCode(phone, freshCode, claims);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.success, true);
  assert.ok(typeof verified.body.token === "string" && verified.body.token.length > 0);
});
