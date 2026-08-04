const axios = require("axios");
const config = require("../config");
const { logger } = require("../helpers/logger");
const { channelPool } = require("./channelPool");

/**
 * Creating, linking and removing WhatsApp sender numbers.
 *
 * The Evolution manager UI only calls its REST API, so all of it can be driven
 * from here. That matters because Evolution runs on the same machine as this
 * service and often isn't reachable from anywhere else — exposing these
 * operations over this service's own API is what lets an operator add a number
 * from the admin panel instead of needing a shell on that machine.
 *
 * What cannot be automated is the single approval on the phone: WhatsApp requires
 * the phone to authorize a linked device because the phone holds the account's
 * identity keys. A pairing code is the best available shape for that — an
 * 8-character code that can be read to whoever holds the SIM over a call,
 * instead of a QR that needs the handset in front of you.
 */

const api = axios.create({
  baseURL: config.evolutionUrl,
  headers: { apikey: config.evolutionApiKey, "Content-Type": "application/json" },
  timeout: config.requestTimeoutMs,
  // 4xx as data rather than an exception, so "does not exist" is a normal answer.
  validateStatus: null,
});

/** Instance names Evolution accepts, and that can't be confused with a path. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,48}$/;

class LinkError extends Error {
  constructor(message, { status = 502, code = "EVOLUTION_ERROR" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Normalizes to what requestPairingCode expects: digits only, full international,
 * no plus sign and no trunk zero. The pairing code is bound to this exact number,
 * so a mismatch with the phone entering it fails with no useful error.
 */
function normalizeNumber(input) {
  let digits = String(input ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  // Egyptian mobiles are written 01XXXXXXXXX locally; the trunk 0 must go.
  if (digits.length === 11 && digits.startsWith("01")) digits = `20${digits.slice(1)}`;
  if (digits.length === 13 && digits.startsWith("2001")) digits = `20${digits.slice(3)}`;
  return digits;
}

function assertValidName(name) {
  if (!NAME_PATTERN.test(String(name ?? ""))) {
    throw new LinkError(
      "Instance name must be 2-49 characters, letters/numbers/dash/underscore, starting with a letter or number.",
      { status: 400, code: "INVALID_NAME" },
    );
  }
}

function assertValidPhone(phone) {
  // A pairing code needs a number; without one Evolution can only give a QR,
  // which is the thing the panel exists to avoid.
  if (phone.length < 8 || phone.length > 15) {
    throw new LinkError("Phone number must be in full international format, e.g. 201234567890.", {
      status: 400,
      code: "INVALID_PHONE",
    });
  }
}

/** Evolution's view of one instance: 'open' | 'connecting' | 'close' | 'missing'. */
async function stateOf(name) {
  assertValidName(name);
  const res = await api.get(`/instance/connectionState/${name}`);
  if (res.status === 404) return "missing";
  if (res.status >= 400) {
    throw new LinkError(`Evolution returned HTTP ${res.status} for '${name}'.`);
  }
  return res.data?.instance?.state || "unknown";
}

/**
 * Creates the instance and returns the pairing code it already produced.
 *
 * Evolution's create endpoint, given `number` and `qrcode: true`, calls
 * connectToWhatsapp() itself, waits for the handshake to start, and returns the
 * pairing code in `qrcode`. So there is nothing further to ask for — calling
 * /instance/connect afterwards would only restart what is already running.
 */
async function createInstance(name, phone) {
  const body = { instanceName: name, qrcode: true, integration: "WHATSAPP-BAILEYS" };
  if (phone) body.number = phone;

  const res = await api.post("/instance/create", body);
  if (res.status >= 400) {
    const message = JSON.stringify(res.data);
    if (message.includes("already in use")) return { existed: true, pairingCode: null, qrCode: null };
    throw new LinkError(`Could not create '${name}': HTTP ${res.status} ${message}`);
  }

  return {
    existed: false,
    pairingCode: res.data?.qrcode?.pairingCode || null,
    qrCode: res.data?.qrcode?.base64 || null,
  };
}

/**
 * Asks an existing, closed instance for a fresh pairing code.
 *
 * Only valid when the instance is in state 'close'. Evolution generates a new
 * code only from 'close'; asked while 'connecting' it returns the code it already
 * made, which by then is usually expired.
 */
async function requestPairingCode(name, phone) {
  const res = await api.get(`/instance/connect/${name}`, { params: phone ? { number: phone } : {} });
  if (res.status >= 400) {
    throw new LinkError(`Could not start linking '${name}': HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { pairingCode: res.data?.pairingCode || null, qrCode: res.data?.base64 || null };
}

/**
 * Tears a stalled attempt down so a fresh code can be issued.
 *
 * Only ever called when the operator explicitly asks to start over. Restarting an
 * instance destroys the session its current code belongs to, so doing it while
 * the phone is mid-handshake makes the phone report "Couldn't link device" —
 * which looks like a rejected code but is really the server pulling the rug.
 */
async function resetAttempt(name) {
  await api.post(`/instance/restart/${name}`, {});
  for (let i = 0; i < 10 && (await stateOf(name)) === "connecting"; i += 1) {
    await sleep(1000);
  }
}

/**
 * Creates the instance if needed and returns ONE pairing code.
 *
 * Never restarts an instance on its own. A restart destroys the session the
 * current code belongs to, so doing it while the phone is mid-handshake — showing
 * "Logging in..." — makes the phone report "Couldn't link device" and Evolution
 * then tear the instance down with a 401 Connection Failure. That looks like a
 * rejected code but is really the server pulling the rug, and it is the single
 * easiest way to make linking never work.
 *
 * So each state has exactly one safe action:
 *   missing    → create; the create call itself starts the handshake and returns
 *                the code, so nothing else is needed
 *   close      → ask for a fresh code
 *   connecting → an attempt is already live. Refuse, unless the caller explicitly
 *                passes `force` to start over.
 *   open       → already linked, nothing to do
 */
async function link({ name, phone, purposes, force = false }) {
  assertValidName(name);
  const number = normalizeNumber(phone);
  assertValidPhone(number);

  let state = await stateOf(name);

  if (state === "open") {
    // Already linked — register it and report that, rather than restarting a
    // working sender to issue a code nobody needs.
    register({ name, phone: number, purposes });
    return { name, phone: number, state: "open", pairingCode: null, alreadyConnected: true };
  }

  if (state === "connecting") {
    if (!force) {
      throw new LinkError(
        `'${name}' already has a link attempt in progress. Wait for the phone to finish, then retry only if it fails — starting over now would cancel it.`,
        { status: 409, code: "LINK_IN_PROGRESS" },
      );
    }
    await resetAttempt(name);
    state = await stateOf(name);
  }

  let pairingCode = null;
  let qrCode = null;

  if (state === "missing") {
    // Creating with a number starts the handshake and hands back the code, so
    // asking /instance/connect afterwards would restart what is already running.
    ({ pairingCode, qrCode } = await createInstance(name, number));
  }

  // Either the instance already existed and is closed, or the create raced with
  // another caller and reported it as existing. Both need a code requested.
  if (!pairingCode && !qrCode) {
    ({ pairingCode, qrCode } = await requestPairingCode(name, number));
  }

  // Register now, not on success: the operator is about to enter the code, and a
  // channel that connects a minute later should already be known. It is skipped
  // for routing until a probe confirms the session is open, so registering an
  // attempt that ultimately fails costs nothing but a row in the file.
  register({ name, phone: number, purposes });

  logger.info({ channel: name, hasPairingCode: Boolean(pairingCode) }, "[Linker] Linking started");

  return { name, phone: number, state: "connecting", pairingCode, qrCode, alreadyConnected: false };
}

/** Persists a channel and brings it into rotation immediately. */
function register({ name, phone, purposes }) {
  const entry = { name, phone, addedAt: Date.now() };
  if (Array.isArray(purposes) && purposes.length > 0) entry.purposes = purposes;

  // Linking a name that was previously removed must undo the suppression, or the
  // link would appear to succeed and then be filtered straight back out at boot.
  config.channelRegistry.unsuppress(name);
  config.channelRegistry.upsert(entry);
  channelPool.addChannel({
    name,
    url: config.evolutionUrl,
    apiKey: config.evolutionApiKey,
    purposes: entry.purposes || ["otp", "alert"],
  });
}

/**
 * Removes a sender: out of rotation, forgotten, and logged out of Evolution so
 * the number is free to be linked elsewhere.
 *
 * A name declared in .env cannot be deleted from .env by this service, so it is
 * recorded as suppressed instead. That makes the removal durable — without it the
 * name would come back on the next restart, and a name that no longer exists in
 * Evolution could never be cleared from anywhere but the file itself. .env stays
 * the declared list; the registry keeps the operator's exceptions to it.
 */
async function unlink(name) {
  assertValidName(name);

  const managed = config.channelRegistry.has(name);

  channelPool.removeChannel(name);

  if (managed) {
    config.channelRegistry.remove(name);
  } else {
    config.channelRegistry.suppress(name);
    logger.warn(
      { channel: name },
      `[Linker] '${name}' is declared in the environment; suppressing it so it stays removed across restarts`,
    );
  }

  // Take it out of rotation first and only then tell Evolution, so no message
  // can be routed to a number that is being torn down.
  const res = await api.delete(`/instance/delete/${name}`);
  if (res.status >= 400 && res.status !== 404) {
    // The channel is already gone from our side, which is what matters for
    // delivery. Surface the rest as a warning rather than failing the request.
    logger.warn(
      { channel: name, status: res.status },
      "[Linker] Removed locally but Evolution refused to delete the instance",
    );
    return { name, removed: true, evolutionDeleted: false, suppressed: !managed };
  }

  logger.warn({ channel: name }, "[Linker] Channel unlinked and deleted from Evolution");
  return { name, removed: true, evolutionDeleted: true, suppressed: !managed };
}

/**
 * Logs a number out without forgetting it — for re-linking the same instance to
 * a different phone, or forcing a fresh session.
 */
async function logout(name) {
  assertValidName(name);
  const res = await api.delete(`/instance/logout/${name}`);
  if (res.status >= 400 && res.status !== 404) {
    throw new LinkError(`Could not log '${name}' out: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  logger.warn({ channel: name }, "[Linker] Channel logged out");
  return { name, loggedOut: true };
}

/** Live Evolution state for one channel, for polling after a code is entered. */
async function describe(name) {
  const state = await stateOf(name);
  const pooled = channelPool.byName(name);
  return {
    name,
    state,
    connected: state === "open",
    inRotation: Boolean(pooled),
    managed: config.channelRegistry.has(name),
  };
}

/**
 * Every channel the pool knows about, plus every instance that exists in
 * Evolution but is not configured here — so an instance created by hand in the
 * manager UI is visible and can be adopted rather than being invisible.
 */
async function listAll() {
  const status = channelPool.status();
  const known = new Set(status.channels.map((channel) => channel.name));

  let unregistered = [];
  // name -> { ownerJid, number, profileName }. Evolution reports the sender's own
  // WhatsApp number and display name on the instance row, and this response
  // already carries both — they were being read for the name and state and then
  // discarded, which is why the admin panel's "Sender number" and "WhatsApp name"
  // columns had nothing to show and rendered a dash for every row.
  const identities = new Map();

  const res = await api.get("/instance/fetchInstances");
  if (res.status < 400 && Array.isArray(res.data)) {
    for (const item of res.data) {
      const name = item?.name ?? item?.instance?.instanceName ?? item?.instanceName;
      if (!name) continue;

      const ownerJid = item?.ownerJid ?? item?.instance?.owner ?? null;
      // The JID's local part wins over Evolution's own `number` column. That
      // column holds whatever was typed when the instance was linked, which is
      // often the local format — one real row pairs number "xxxxxxxxxxx" with
      // ownerJid "2xxxxxxxxxxx@s.whatsapp.net", i.e. the country code is
      // missing and the value is not dialable. The JID is the identity WhatsApp
      // itself reports, so it is the one to trust; `number` is only the
      // fallback for older builds that do not send a JID.
      const number = (ownerJid ? String(ownerJid).split("@")[0] : null) || item?.number || null;

      // The account's own display name ("Ahmed Zidan") — what a farmer sees the
      // message arrive from, as opposed to the instance name ("ReNile_1"), which
      // is only our label for it. Sent as null rather than an empty string when
      // WhatsApp has none, so the panel can tell "no name" from "blank name".
      const rawProfileName = item?.profileName ?? item?.instance?.profileName ?? null;
      const profileName = typeof rawProfileName === "string" && rawProfileName.trim() ? rawProfileName.trim() : null;

      if (ownerJid || number || profileName) identities.set(name, { ownerJid, number, profileName });

      if (!known.has(name)) {
        unregistered.push({
          name,
          state: item?.connectionStatus ?? item?.instance?.state ?? null,
        });
      }
    }
  } else {
    logger.warn({ status: res.status }, "[Linker] Could not list Evolution instances");
  }

  // A channel with no match keeps its existing shape rather than gaining null
  // fields: it is either not present in Evolution (the panel already flags
  // that) or it lives on a different Evolution server — WHATSAPP_CHANNELS_JSON
  // allows per-channel urls, and this lookup only covers the default one.
  const channels = status.channels.map((channel) => {
    const identity = identities.get(channel.name);
    return identity ? { ...channel, ...identity } : channel;
  });

  return { ...status, channels, unregistered };
}

/** Brings an instance that already exists in Evolution under this service. */
async function adopt({ name, purposes }) {
  assertValidName(name);

  const state = await stateOf(name);
  if (state === "missing") {
    throw new LinkError(`'${name}' does not exist in Evolution — create it first.`, {
      status: 404,
      code: "INSTANCE_NOT_FOUND",
    });
  }

  register({ name, purposes });
  return { name, state, adopted: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  LinkError,
  link,
  unlink,
  logout,
  describe,
  listAll,
  adopt,
  stateOf,
  createInstance,
  requestPairingCode,
  resetAttempt,
  normalizeNumber,
};
