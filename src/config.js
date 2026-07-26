require("dotenv").config();

const { ChannelRegistry } = require("./services/channelRegistry");

/**
 * Every environment value the service reads, parsed and validated once at boot.
 *
 * Sending everything from one WhatsApp number is what gets that number banned
 * for hours: WhatsApp scores an unofficial (WhatsApp Web) session on how bursty
 * and how repetitive its traffic looks. Spreading the same volume over several
 * numbers divides each number's rate by the number of channels, and means one
 * number going down no longer takes logins with it.
 */

const DEFAULTS = {
  port: 4040,
  channelMinGapMs: 5000,
  channelJitterMs: 2000,
  channelDailyCap: 0, // 0 = unlimited
  channelFailThreshold: 3,
  channelCooldownMs: 30 * 60 * 1000,
  channelProbeMs: 60 * 1000,
  maxSendAttempts: 3,
  acquireTimeoutMs: 20 * 1000,
  requestTimeoutMs: 15 * 1000,
  sendDeadlineMs: 30 * 1000,
  assignmentTtlDays: 90,
};

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function list(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Builds the channel list. Three ways to configure it, most specific first:
 *
 *  1. WHATSAPP_CHANNELS_JSON — full control, one object per channel, for when
 *     the numbers live on different Evolution API servers or need different
 *     keys. e.g. [{"name":"a","url":"http://x","apiKey":"k","purposes":["otp"]}]
 *  2. WHATSAPP_CHANNELS — comma-separated instance names sharing EVOLUTION_URL
 *     and API_KEY. This is the normal case: one Evolution server, N instances.
 *  3. INSTANCE_NAME — the original single-channel setup, still works untouched.
 *
 * On top of whichever of those is used, channels linked at runtime through the
 * admin API are unioned in from the registry file. Env wins on a name collision,
 * so .env stays the place to pin a channel's URL, key or purposes.
 */
function buildChannels(env, registryEntries = [], isSuppressed = () => false) {
  const sharedUrl = (env.EVOLUTION_URL || "").replace(/\/+$/, "");
  const sharedKey = env.API_KEY;

  const fromRegistry = registryEntries.map((entry, index) =>
    normalizeChannel(entry, index, sharedUrl, sharedKey),
  );

  const withRegistry = (envChannels) => {
    // Env-declared names the operator removed from the panel are dropped here.
    // Without this, removing one could only be cosmetic: it would reappear on the
    // next restart, and names that no longer exist in Evolution could never be
    // cleaned up from anywhere but the .env file itself.
    const kept = envChannels.filter((channel) => !isSuppressed(channel.name));
    const declared = new Set(kept.map((channel) => channel.name));
    return [...kept, ...fromRegistry.filter((channel) => !declared.has(channel.name))];
  };

  if (env.WHATSAPP_CHANNELS_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.WHATSAPP_CHANNELS_JSON);
    } catch (error) {
      throw new Error(`WHATSAPP_CHANNELS_JSON is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("WHATSAPP_CHANNELS_JSON must be a non-empty array.");
    }
    return withRegistry(parsed.map((entry, index) => normalizeChannel(entry, index, sharedUrl, sharedKey)));
  }

  const otpOnly = list(env.WHATSAPP_OTP_CHANNELS);
  const alertOnly = list(env.WHATSAPP_ALERT_CHANNELS);

  // WHATSAPP_CHANNELS is the master list and the reservation lists only filter
  // it. But listing numbers ONLY in the reservation lists is an easy and very
  // reasonable mistake, and silently falling through to a single INSTANCE_NAME
  // channel would restore exactly the burst-from-one-number ban this exists to
  // prevent. So treat the union of the reservation lists as the master list.
  const names =
    list(env.WHATSAPP_CHANNELS).length > 0
      ? list(env.WHATSAPP_CHANNELS)
      : [...new Set([...otpOnly, ...alertOnly])];

  if (names.length > 0) {
    return withRegistry(
      names.map((name, index) =>
        normalizeChannel(
          {
            name,
            // A channel named in only one of the two reservation lists serves
            // only that purpose; a channel in neither list serves both.
            purposes: purposesFor(name, otpOnly, alertOnly),
          },
          index,
          sharedUrl,
          sharedKey,
        ),
      ),
    );
  }

  if (env.INSTANCE_NAME) {
    return withRegistry([normalizeChannel({ name: env.INSTANCE_NAME }, 0, sharedUrl, sharedKey)]);
  }

  // Nothing declared in env, but the panel may have linked numbers already —
  // that is a perfectly valid setup and must not stop the service from booting.
  if (fromRegistry.length > 0) return fromRegistry;

  throw new Error("No WhatsApp channel configured — set WHATSAPP_CHANNELS or INSTANCE_NAME.");
}

function purposesFor(name, otpOnly, alertOnly) {
  const reservedForOtp = otpOnly.includes(name);
  const reservedForAlerts = alertOnly.includes(name);
  if (reservedForOtp && !reservedForAlerts) return ["otp"];
  if (reservedForAlerts && !reservedForOtp) return ["alert"];
  return ["otp", "alert"];
}

function normalizeChannel(entry, index, sharedUrl, sharedKey) {
  const name = typeof entry === "string" ? entry : entry.name;
  if (!name) throw new Error(`Channel #${index + 1} has no instance name.`);

  const url = ((typeof entry === "object" && entry.url) || sharedUrl || "").replace(/\/+$/, "");
  const apiKey = (typeof entry === "object" && entry.apiKey) || sharedKey;

  if (!url) throw new Error(`Channel '${name}' has no Evolution API URL (set EVOLUTION_URL or the channel's url).`);
  if (!apiKey) throw new Error(`Channel '${name}' has no API key (set API_KEY or the channel's apiKey).`);

  const purposes =
    typeof entry === "object" && Array.isArray(entry.purposes) && entry.purposes.length > 0
      ? entry.purposes
      : ["otp", "alert"];

  return { name, url, apiKey, purposes };
}

const env = process.env;

/**
 * Channels linked through the admin API live here rather than in .env, so adding
 * a number needs no file edit and no restart.
 */
const channelRegistry = new ChannelRegistry(env.WHATSAPP_REGISTRY_FILE || "./data/channels.json");

const config = {
  port: num(env.PORT, DEFAULTS.port),
  jwtSecret: env.JWT_SECRET,
  otpJwtSecret: env.OTP_JWT_SECRET || env.JWT_SECRET || "default_otp_secret",

  /** Shared Evolution API endpoint, used when creating channels at runtime. */
  evolutionUrl: (env.EVOLUTION_URL || "").replace(/\/+$/, ""),
  evolutionApiKey: env.API_KEY,

  channelRegistry,
  channels: buildChannels(env, channelRegistry.list(), (name) => channelRegistry.isSuppressed(name)),

  /** Minimum quiet time on ONE number between two of its own messages. */
  channelMinGapMs: num(env.WHATSAPP_CHANNEL_MIN_GAP_MS, DEFAULTS.channelMinGapMs),
  /** Random padding on top of the gap so a number's traffic isn't metronomic. */
  channelJitterMs: num(env.WHATSAPP_CHANNEL_JITTER_MS, DEFAULTS.channelJitterMs),
  /** Messages one number may send per day. 0 disables the cap. */
  channelDailyCap: num(env.WHATSAPP_CHANNEL_DAILY_CAP, DEFAULTS.channelDailyCap),
  /** Consecutive gateway failures before a number is rested. */
  channelFailThreshold: num(env.WHATSAPP_CHANNEL_FAIL_THRESHOLD, DEFAULTS.channelFailThreshold),
  /** How long a rested number stays out of rotation. */
  channelCooldownMs: num(env.WHATSAPP_CHANNEL_COOLDOWN_MS, DEFAULTS.channelCooldownMs),
  /** How often each number's Evolution connection state is checked. */
  channelProbeMs: num(env.WHATSAPP_CHANNEL_PROBE_MS, DEFAULTS.channelProbeMs),
  /** Different numbers tried before one message is given up on. */
  maxSendAttempts: num(env.WHATSAPP_MAX_SEND_ATTEMPTS, DEFAULTS.maxSendAttempts),
  /** How long a caller waits for any number to become free. */
  acquireTimeoutMs: num(env.WHATSAPP_ACQUIRE_TIMEOUT_MS, DEFAULTS.acquireTimeoutMs),
  /** Timeout on a single Evolution API call, so a hung gateway can't hang us. */
  requestTimeoutMs: num(env.WHATSAPP_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
  /**
   * Ceiling on ONE message end to end, across every retry. Without this, three
   * attempts against a hung gateway would each burn the full request timeout and
   * a farmer's login request would hang for the sum of them.
   */
  sendDeadlineMs: num(env.WHATSAPP_SEND_DEADLINE_MS, DEFAULTS.sendDeadlineMs),

  /**
   * One farmer, one sender number. Turning this off reverts to picking whichever
   * number is free, which spreads load slightly better but means a farmer can
   * receive from several numbers — which reads as a scam and gets numbers
   * reported.
   */
  stickySender: bool(env.WHATSAPP_STICKY_SENDER, true),
  /** Where the farmer-to-number map is kept, so it survives a restart. */
  assignmentsFile: env.WHATSAPP_ASSIGNMENTS_FILE || "./data/channel-assignments.json",
  /** Forget a farmer's number after this long without a message. */
  assignmentTtlDays: num(env.WHATSAPP_ASSIGNMENT_TTL_DAYS, DEFAULTS.assignmentTtlDays),

  logLevel: env.LOG_LEVEL || "info",
};

/**
 * True when any channel is restricted to a single purpose. Reserving numbers by
 * purpose necessarily means a farmer gets login codes from one number and alerts
 * from another, so the assignment map has to key on purpose as well.
 */
config.purposeReservations = config.channels.some((channel) => channel.purposes.length === 1);

module.exports = config;
