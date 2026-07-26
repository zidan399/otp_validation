const linker = require("../services/channelLinker.js");
const { logger } = require("../helpers/logger");

/**
 * HTTP surface for managing WhatsApp sender numbers.
 *
 * Thin on purpose: every decision lives in channelLinker, which the CLI script
 * shares, so the panel and the command line cannot drift apart in behaviour.
 */

/** Turns a LinkError into its own status, and anything else into a 502. */
function fail(res, error, context) {
  const status = error instanceof linker.LinkError ? error.status : 502;
  const code = error instanceof linker.LinkError ? error.code : "EVOLUTION_UNREACHABLE";

  // 4xx is the operator's input; 5xx means Evolution or this service is broken.
  // Called as a method rather than through a detached reference — pino's log
  // functions need their receiver, and an unbound one throws inside the error
  // handler, turning every 4xx into an opaque 500.
  const payload = { ...context, error: error.message, code };
  if (status >= 500) logger.error(payload, "[Channels] Administration request failed");
  else logger.warn(payload, "[Channels] Administration request failed");

  return res.status(status).json({ success: false, error: error.message, code });
}

exports.list = async (req, res) => {
  try {
    res.json({ success: true, ...(await linker.listAll()) });
  } catch (error) {
    fail(res, error, { action: "list" });
  }
};

/**
 * Creates the instance if needed and returns ONE pairing code.
 *
 * The code has to be entered on the phone that owns the number, under
 * Linked devices → Link a device → Link with phone number instead. The client
 * then polls GET /api/channels/:name until it reports connected. It must not
 * re-request a code while the phone shows "Logging in...": that restarts the
 * instance mid-handshake and the phone reports "Couldn't link device".
 */
exports.link = async (req, res) => {
  const { name, phone, purposes } = req.body || {};
  try {
    const result = await linker.link({ name, phone, purposes });
    res.status(result.alreadyConnected ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    fail(res, error, { action: "link", name });
  }
};

exports.adopt = async (req, res) => {
  const { name, purposes } = req.body || {};
  try {
    res.json({ success: true, ...(await linker.adopt({ name, purposes })) });
  } catch (error) {
    fail(res, error, { action: "adopt", name });
  }
};

exports.describe = async (req, res) => {
  try {
    res.json({ success: true, ...(await linker.describe(req.params.name)) });
  } catch (error) {
    fail(res, error, { action: "describe", name: req.params.name });
  }
};

exports.logout = async (req, res) => {
  try {
    res.json({ success: true, ...(await linker.logout(req.params.name)) });
  } catch (error) {
    fail(res, error, { action: "logout", name: req.params.name });
  }
};

exports.unlink = async (req, res) => {
  try {
    res.json({ success: true, ...(await linker.unlink(req.params.name)) });
  } catch (error) {
    fail(res, error, { action: "unlink", name: req.params.name });
  }
};
