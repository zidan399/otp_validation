const axios = require("axios");
const config = require("../config");
const { channelPool } = require("./channelPool");
const { logger, maskPhone } = require("../helpers/logger");

/**
 * Sends one WhatsApp message through the healthiest available number.
 *
 * If the chosen number fails for a reason that suggests the number itself is in
 * trouble, the message is retried on a DIFFERENT number instead of being lost.
 * That is the main reliability gain from running several channels: a ban used to
 * mean no logins at all, and now it means one number quietly drops out.
 *
 * Returns { success, channel } on success, or { success: false, error, channel }
 * where error is 'NOT_ON_WHATSAPP' (the recipient's fault, no retry),
 * 'NO_CHANNEL_AVAILABLE' (every number is down or busy) or 'GATEWAY_ERROR'.
 */
exports.sendWhatsAppMessage = async (phone, text, { purpose = "alert" } = {}) => {
  const attemptLimit = Math.max(1, Math.min(config.maxSendAttempts, config.channels.length));
  const deadline = Date.now() + config.sendDeadlineMs;
  const tried = [];
  let lastError = "GATEWAY_ERROR";

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    // Stop retrying once the message has used its whole budget, so a hung
    // gateway can't turn one login into a minute of waiting.
    const remainingMs = deadline - Date.now();
    if (attempt > 1 && remainingMs < 1000) {
      logger.warn(
        { phone: maskPhone(phone), purpose, tried, lastError },
        "[WhatsApp] Send deadline reached — giving up rather than retrying further",
      );
      return { success: false, error: lastError };
    }

    const channel = await channelPool.acquire({ purpose, phone, exclude: tried });

    if (!channel) {
      // Only report starvation if we never got a channel at all; otherwise the
      // real story is the failure that made us retry.
      return { success: false, error: tried.length === 0 ? "NO_CHANNEL_AVAILABLE" : lastError };
    }

    tried.push(channel.name);
    // Never let one attempt run past the whole message's budget.
    const result = await dispatch(channel, phone, text, Math.max(1000, Math.min(config.requestTimeoutMs, deadline - Date.now())));

    if (result.success) {
      channelPool.reportSuccess(channel);
      logger.info(
        { channel: channel.name, phone: maskPhone(phone), purpose, attempt, messageId: result.messageId },
        `[WhatsApp] Sent via '${channel.name}'`,
      );
      return { success: true, channel: channel.name };
    }

    const recipientFault = result.error === "NOT_ON_WHATSAPP";
    channelPool.reportFailure(channel, { reason: result.error, recipientFault });
    lastError = result.error;

    if (recipientFault) {
      // The number isn't on WhatsApp — no other channel will do better.
      logger.warn({ phone: maskPhone(phone) }, "[WhatsApp] Recipient is not on WhatsApp");
      return { success: false, error: "NOT_ON_WHATSAPP", channel: channel.name };
    }

    // Every other failure means the message definitely did not go out, so
    // retrying elsewhere is free. A TIMEOUT does not: Evolution may already have
    // handed the message to WhatsApp and simply not answered us in time. Retry
    // it and the farmer can receive the same message twice, from two different
    // numbers — the exact pattern the one-number rule exists to avoid.
    //
    // So the trade is made per purpose. A login code is worth a possible
    // duplicate, because being unable to log in is far worse than getting the
    // same code twice. An alert is not: it is already visible in the dashboard,
    // and a duplicate from a second number is a real cost.
    if (result.error === "TIMEOUT" && purpose !== "otp") {
      logger.warn(
        { channel: channel.name, phone: maskPhone(phone), purpose },
        "[WhatsApp] Timed out — not retrying an alert elsewhere, it may already have been delivered",
      );
      return { success: false, error: "TIMEOUT", channel: channel.name };
    }

    logger.warn(
      { channel: channel.name, phone: maskPhone(phone), attempt, attemptLimit, error: result.error },
      `[WhatsApp] Send failed on '${channel.name}'${attempt < attemptLimit ? ", trying another channel" : ""}`,
    );
  }

  return { success: false, error: lastError };
};

/** Reports which numbers are healthy — used by /api/channels and /health. */
exports.channelStatus = () => channelPool.status();

/** Begins periodic connection probing of every channel. */
exports.startChannelMonitor = () => channelPool.start();

/** Stops probing and flushes the farmer-to-number map to disk. */
exports.stopChannelMonitor = () => channelPool.stop();

/** One HTTP call to one Evolution instance. */
async function dispatch(channel, phone, text, timeoutMs = config.requestTimeoutMs) {
  const payload = {
    number: phone,
    options: { delay: 1200, presence: "composing" },
    text,
  };

  try {
    const response = await axios.post(`${channel.url}/message/sendText/${channel.name}`, payload, {
      headers: { apikey: channel.apiKey, "Content-Type": "application/json" },
      timeout: timeoutMs,
    });
    return { success: true, messageId: response.data?.key?.id };
  } catch (error) {
    return { success: false, error: classifyError(error, channel) };
  }
}

/**
 * Works out whether a failure is about the recipient or about our own number.
 * Evolution reports both through the same shape, and the distinction decides
 * whether we retry elsewhere and whether the channel gets penalised.
 */
function classifyError(error, channel) {
  const status = error.response?.status;
  const data = error.response?.data;

  const raw = data?.response?.message ?? data?.message;
  let message = "";
  if (typeof raw === "string") message = raw;
  else if (raw) message = JSON.stringify(raw);
  else message = data?.error || error.message || "";
  message = message.toLowerCase();

  logger.error(
    { channel: channel.name, status, code: error.code, message, data },
    "[Evolution API] Send error",
  );

  // Checked first, and deliberately broadly: a timeout is the one failure where
  // we do not know whether the message went out, and the caller needs that
  // distinction before deciding whether to retry elsewhere.
  if (
    error.code === "ECONNABORTED" ||
    error.code === "ETIMEDOUT" ||
    error.code === "ERR_CANCELED" ||
    message.includes("timeout")
  ) {
    return "TIMEOUT";
  }

  // Evolution answers an unreachable recipient with exists: false, in one of
  // several nesting depths depending on version.
  const explicitlyNotOnWhatsApp =
    data?.response?.message?.[0]?.exists === false ||
    data?.message?.[0]?.exists === false ||
    data?.exists === false;

  if (explicitlyNotOnWhatsApp || RECIPIENT_ERRORS.some((pattern) => message.includes(pattern))) {
    return "NOT_ON_WHATSAPP";
  }

  // A 404 on the send endpoint means the INSTANCE doesn't exist, which is a
  // configuration problem with our number — not the recipient's fault. The
  // original code conflated the two, so a typo'd instance name looked to the
  // backend like every farmer being off WhatsApp.
  if (status === 404) return "INSTANCE_NOT_FOUND";
  if (CHANNEL_DOWN_ERRORS.some((pattern) => message.includes(pattern))) return "CHANNEL_DISCONNECTED";

  return "GATEWAY_ERROR";
}

/** The recipient cannot receive — retrying on another number won't help. */
const RECIPIENT_ERRORS = [
  "not on whatsapp",
  "invalid jid",
  "does not exist",
  "not registered",
  "user not found",
  "recipient not found",
  "account not found",
  "number not found",
];

/** Our own session is down — another number very much will help. */
const CHANNEL_DOWN_ERRORS = ["disconnected", "not connected", "unavailable", "close", "connection closed"];
