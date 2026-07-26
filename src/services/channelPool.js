const axios = require("axios");
const config = require("../config");
const { logger, maskPhone } = require("../helpers/logger");
const { ChannelAssignments } = require("./channelAssignments");

/**
 * Picks which WhatsApp number sends each message.
 *
 * The ban problem is per-number: WhatsApp watches how fast and how repetitively
 * one session sends. So the pool enforces the quiet gap PER NUMBER rather than
 * globally — with five numbers the service sustains five times the throughput
 * while each individual number still looks as calm as before.
 *
 * Each farmer is assigned ONE sender number and keeps it. Receiving the same
 * kind of message from several different numbers is what a scam looks like to
 * the person reading it and what a spam ring looks like to WhatsApp, so the
 * rotation is across farmers, not across each farmer's messages.
 *
 * Assignment happens on first contact and goes to the number carrying the
 * fewest farmers, so a group of new farmers spreads evenly — five farmers over
 * three numbers land 2 / 2 / 1 rather than all on whichever number was free.
 *
 * A farmer is moved to a different number only when their own number cannot
 * deliver: disconnected, resting after repeated failures, or over its daily cap.
 * Merely being busy is not a reason to move them — the message waits out the
 * quiet gap instead. So one number per farmer holds, and a banned number still
 * costs nobody their login.
 *
 * The assignment map is on disk so it survives restarts; everything else is
 * per-process. The backend holds a Redis-backed global pacer in front of us, so
 * cross-process ordering is handled upstream.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

class ChannelPool {
  constructor() {
    this.channels = config.channels.map((channel) => freshChannel(channel));

    this.probeTimer = null;
    this.assignments = new ChannelAssignments();

    logger.info(
      {
        channels: this.channels.map((c) => ({ name: c.name, purposes: c.purposes })),
        minGapMs: config.channelMinGapMs,
        stickySender: config.stickySender,
      },
      `[Channels] ${this.channels.length} WhatsApp channel(s) configured`,
    );

    if (this.channels.length === 1) {
      logger.warn(
        "[Channels] Only one channel configured — a single ban silences the whole service. Set WHATSAPP_CHANNELS to add numbers.",
      );
    }

    if (!config.stickySender) {
      logger.warn(
        "[Channels] WHATSAPP_STICKY_SENDER is off — a farmer may receive messages from several different numbers.",
      );
    }

    if (config.purposeReservations && config.stickySender) {
      logger.warn(
        "[Channels] Purpose-reserved channels are configured, so a farmer gets login codes from one number and alerts from another. Remove WHATSAPP_OTP_CHANNELS / WHATSAPP_ALERT_CHANNELS for strictly one number per farmer.",
      );
    }
  }

  /** Starts periodic connection probing. Safe to call once, at boot. */
  start() {
    if (this.probeTimer || !config.channelProbeMs) return;

    // Report what each configured name actually resolved to, so a typo or an
    // unscanned QR is visible in the boot log rather than surfacing later as
    // mysteriously undelivered messages.
    this.probeAll({ force: true })
      .then(() => this.logBootSummary())
      .catch(() => {});

    this.probeTimer = setInterval(() => {
      this.probeAll().catch(() => {});
    }, config.channelProbeMs);
    this.probeTimer.unref?.();
  }

  logBootSummary() {
    const missing = this.channels.filter((c) => c.lastError === "INSTANCE_NOT_FOUND").map((c) => c.name);
    const offline = this.channels
      .filter((c) => c.connected === false && c.lastError !== "INSTANCE_NOT_FOUND")
      .map((c) => c.name);
    const ready = this.channels.filter((c) => c.connected === true).map((c) => c.name);

    if (missing.length > 0) {
      logger.error(
        { missing },
        `[Channels] ${missing.length} configured name(s) do not exist in Evolution: ${missing.join(", ")}`,
      );
    }
    if (offline.length > 0) {
      logger.warn(
        { offline },
        `[Channels] ${offline.length} number(s) exist but are not connected (scan the QR): ${offline.join(", ")}`,
      );
    }

    if (ready.length === 0) {
      logger.error("[Channels] No usable WhatsApp number — nothing can be sent until one connects.");
    } else {
      logger.info({ ready }, `[Channels] ${ready.length} number(s) ready: ${ready.join(", ")}`);
    }
  }

  stop() {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    // Writes are batched, so a shutdown between batches would otherwise lose the
    // most recent assignments and move those farmers on the next boot.
    this.assignments.flush();
  }

  /**
   * Reserves a number for one message, waiting for the shortest quiet gap if
   * every number is still resting. Returns null if nothing frees up in time.
   *
   * `exclude` carries the numbers a failing message has already tried, so a
   * retry lands somewhere new instead of on the number that just failed.
   */
  async acquire({ purpose = "alert", phone = "", exclude = [] } = {}) {
    const deadline = Date.now() + config.acquireTimeoutMs;
    const sticky = config.stickySender && Boolean(phone);

    for (;;) {
      const chosen = sticky
        ? this.assignedChannel(purpose, phone, exclude)
        : this.pickFree(purpose, exclude);

      if (!chosen) {
        // Nothing usable: either every number is genuinely down, or a probe
        // marked one offline that has since recovered. Re-probe once before
        // giving up, so a reconnected number returns to service immediately.
        if (exclude.length === 0 && this.hasUnhealthy(purpose)) {
          await this.probeAll();
          if (this.eligible(purpose).length > 0) continue;
        }
        logger.error({ purpose, exclude }, "[Channels] No channel available for this message");
        return null;
      }

      const waitMs = this.readyAt(chosen) - Date.now();

      if (waitMs <= 0) {
        // Reserve it now. Two concurrent callers therefore see different
        // numbers rather than both writing to the same one.
        chosen.lastSentAt = Date.now();
        return chosen;
      }

      if (Date.now() + waitMs > deadline) {
        logger.warn(
          { purpose, waitMs, channel: chosen.name },
          "[Channels] All channels busy past the acquire timeout",
        );
        return null;
      }

      await sleep(Math.min(waitMs, 500));
    }
  }

  /** Records a successful send on a channel. */
  reportSuccess(channel) {
    const entry = this.byName(channel.name);
    if (!entry) return;

    this.rollDay(entry);
    entry.lastSentAt = Date.now();
    entry.lastSuccessAt = Date.now();
    entry.sentToday += 1;
    entry.totalSent += 1;
    entry.failStreak = 0;
    entry.connected = true;
    entry.everConnected = true;
    entry.lastError = null;
  }

  /**
   * Records a failed send. A run of consecutive failures is the clearest signal
   * available that a number has been banned or logged out, so the channel is
   * rested rather than hammered — hammering a banned number extends the ban.
   *
   * `recipientFault` marks errors that are about the destination (not on
   * WhatsApp, bad number). Those say nothing about our number's health and must
   * not count against it, or a few wrong numbers would rest a healthy channel.
   */
  reportFailure(channel, { reason = "GATEWAY_ERROR", recipientFault = false } = {}) {
    const entry = this.byName(channel.name);
    if (!entry) return;

    entry.lastSentAt = Date.now();
    entry.totalFailed += 1;
    entry.lastError = reason;
    if (recipientFault) return;

    // A misconfigured instance name is not a transient fault, so don't spend two
    // more messages proving it. Out of rotation immediately; the probe puts it
    // back if the instance is later created.
    if (reason === "INSTANCE_NOT_FOUND") {
      if (entry.connected !== false) {
        logger.error(
          { channel: entry.name },
          `[Channels] '${entry.name}' does not exist in Evolution — removing it from rotation`,
        );
      }
      entry.connected = false;
      return;
    }

    entry.failStreak += 1;
    if (entry.failStreak >= config.channelFailThreshold) {
      entry.cooldownUntil = Date.now() + config.channelCooldownMs;
      entry.failStreak = 0;
      logger.error(
        { channel: entry.name, cooldownMs: config.channelCooldownMs, reason },
        `[Channels] '${entry.name}' rested after ${config.channelFailThreshold} consecutive failures`,
      );
    }
  }

  /**
   * Asks Evolution whether each number's session is still open — but only for
   * the numbers where that question is still open.
   *
   * A number that delivered a message since the last cycle has already proved
   * itself, more convincingly than the status endpoint could: sending IS the
   * health check. So under real traffic this does almost nothing, and the polling
   * concentrates on the numbers that actually need watching — the ones that are
   * down (to catch recovery) and the ones sitting idle (so the first farmer
   * routed to a silently-dead number doesn't absorb the failure).
   *
   * `force` probes everything regardless, for the boot summary.
   */
  async probeAll({ force = false } = {}) {
    const due = force ? this.channels : this.channels.filter((channel) => this.needsProbe(channel));
    if (due.length === 0) return;
    await Promise.all(due.map((channel) => this.probe(channel)));
  }

  needsProbe(channel) {
    // Unknown or known-bad: we have to ask.
    if (channel.connected !== true) return true;
    // Proved alive by a real send since the last cycle: don't ask.
    return Date.now() - channel.lastSuccessAt >= config.channelProbeMs;
  }

  async probe(channel) {
    try {
      const response = await axios.get(`${channel.url}/instance/connectionState/${channel.name}`, {
        headers: { apikey: channel.apiKey },
        timeout: config.requestTimeoutMs,
      });

      const state = response.data?.instance?.state;
      const wasConnected = channel.connected;
      channel.connected = state === "open";
      if (channel.connected) channel.everConnected = true;
      channel.lastProbeError = null;

      if (!channel.connected) {
        channel.lastError = `STATE_${String(state || "UNKNOWN").toUpperCase()}`;
        if (wasConnected !== false) {
          logger.error({ channel: channel.name, state }, `[Channels] '${channel.name}' is not connected`);
        }
      } else if (wasConnected === false) {
        // Back online: return it to rotation immediately rather than waiting
        // out a cooldown that was caused by the disconnection.
        channel.cooldownUntil = 0;
        channel.failStreak = 0;
        channel.lastError = null;
        logger.info({ channel: channel.name }, `[Channels] '${channel.name}' reconnected`);
      }
    } catch (error) {
      // Evolution answering 404 means this instance does not exist there — a
      // typo in WHATSAPP_CHANNELS, or an instance that was never created. No
      // amount of retrying fixes that, so keep it out of rotation entirely
      // rather than letting every message routed to it fail first.
      if (error.response?.status === 404) {
        channel.connected = false;
        channel.lastError = "INSTANCE_NOT_FOUND";

        // A channel added by the panel that Evolution has never confirmed is an
        // abandoned link attempt: the registry entry is written before the phone
        // approves, and when an attempt fails Evolution deletes the instance.
        // Left alone it lingers forever, erroring on every probe and showing as a
        // permanently broken sender. Forget it — nothing was ever linked.
        //
        // Deliberately narrow: a channel that HAS connected before stays visible
        // and broken, because that is a real fault the operator needs to see, and
        // an env-declared name is never touched since only .env can remove it.
        if (this.forgetFailedAttempt(channel)) return;

        if (!channel.reported404) {
          channel.reported404 = true;
          logger.error(
            { channel: channel.name },
            `[Channels] '${channel.name}' does not exist in Evolution — check WHATSAPP_CHANNELS for a typo, or create the instance`,
          );
        }
        return;
      }

      // Any other probe error means we couldn't reach Evolution at all, which
      // says nothing reliable about the WhatsApp session — it could be a blip on
      // the status endpoint while sending still works. Marking the channel dead
      // here would take the whole service offline on a transient error, so it
      // stays in rotation and real send failures are left to rest it if it
      // truly is down.
      channel.lastProbeError = `PROBE_FAILED: ${error.message}`;
      logger.warn(
        { channel: channel.name, error: error.message },
        "[Channels] Probe unreachable — leaving channel in rotation",
      );
    }
  }

  /** Snapshot for the /api/channels endpoint — no secrets included. */
  status() {
    const now = Date.now();
    const counts = this.assignments.counts();
    return {
      total: this.channels.length,
      /** Channels a message may currently be routed to. */
      available: this.eligible("otp").length,
      /** Channels Evolution has confirmed as an open session. */
      connected: this.channels.filter((channel) => channel.connected === true).length,
      minGapMs: config.channelMinGapMs,
      stickySender: config.stickySender,
      assignedRecipients: this.assignments.size(),
      channels: this.channels.map((channel) => {
        this.rollDay(channel);
        return {
          name: channel.name,
          purposes: channel.purposes,
          /**
           * True when this channel was linked through the admin API rather than
           * declared in .env. Only these may be removed from the panel — an
           * env-declared name would simply come back on the next restart.
           */
          managed: config.channelRegistry.has(channel.name),
          connected: channel.connected,
          resting: channel.cooldownUntil > now,
          restingForMs: Math.max(0, channel.cooldownUntil - now),
          readyInMs: Math.max(0, this.readyAt(channel) - now),
          /** Farmers this number is responsible for. */
          recipients: counts[channel.name] || 0,
          sentToday: channel.sentToday,
          dailyCap: config.channelDailyCap || null,
          totalSent: channel.totalSent,
          totalFailed: channel.totalFailed,
          failStreak: channel.failStreak,
          lastError: channel.lastError,
          lastProbeError: channel.lastProbeError,
        };
      }),
    };
  }

  // --- internals ---

  byName(name) {
    return this.channels.find((channel) => channel.name === name) || null;
  }

  serving(purpose) {
    return this.channels.filter((channel) => channel.purposes.includes(purpose));
  }

  eligible(purpose) {
    return this.serving(purpose).filter((channel) => this.isUsable(channel, purpose));
  }

  /**
   * Whether this number can carry this message at all. Deliberately excludes
   * "is it busy right now" — a busy number is still the farmer's number, they
   * just wait for it.
   */
  isUsable(channel, purpose) {
    this.rollDay(channel);
    if (!channel.purposes.includes(purpose)) return false;
    if (channel.connected === false) return false;
    if (channel.cooldownUntil > Date.now()) return false;
    if (config.channelDailyCap && channel.sentToday >= config.channelDailyCap) return false;
    return true;
  }

  hasUnhealthy(purpose) {
    const now = Date.now();
    return this.serving(purpose).some(
      (channel) => channel.connected === false || channel.cooldownUntil > now,
    );
  }

  /** When this number may next send: its own gap, plus jitter. */
  readyAt(channel) {
    const jitter = config.channelJitterMs ? Math.floor(Math.random() * config.channelJitterMs) : 0;
    return channel.lastSentAt + config.channelMinGapMs + jitter;
  }

  /**
   * The farmer's own number, assigning one on first contact and moving them only
   * if theirs genuinely cannot deliver.
   *
   * `exclude` carries numbers that already failed this message. A retry has to
   * go somewhere else, so the farmer is MIGRATED rather than borrowing a number
   * for one message — otherwise they would hear from two senders.
   */
  assignedChannel(purpose, phone, exclude) {
    const key = assignmentKey(purpose, phone);
    const assigned = this.byName(this.assignments.get(key));

    if (assigned && !exclude.includes(assigned.name) && this.isUsable(assigned, purpose)) {
      // Returned even when busy: the caller waits out its quiet gap rather than
      // switching the farmer to a different sender.
      this.assignments.touch(key);
      return assigned;
    }

    const candidates = this.eligible(purpose).filter((channel) => !exclude.includes(channel.name));
    if (candidates.length === 0) return null;

    const next = this.leastLoaded(candidates);
    this.assignments.set(key, next.name);

    if (assigned) {
      logger.warn(
        { phone: maskPhone(phone), from: assigned.name, to: next.name, reason: assigned.lastError || "unavailable" },
        `[Channels] Moved ${maskPhone(phone)} from '${assigned.name}' to '${next.name}'`,
      );
    } else {
      logger.info(
        { phone: maskPhone(phone), channel: next.name, purpose },
        `[Channels] Assigned ${maskPhone(phone)} to '${next.name}'`,
      );
    }

    return next;
  }

  /** Whichever usable number has rested longest. Used when stickiness is off. */
  pickFree(purpose, exclude) {
    const candidates = this.eligible(purpose).filter((channel) => !exclude.includes(channel.name));
    if (candidates.length === 0) return null;
    return candidates.reduce((best, channel) => (channel.lastSentAt < best.lastSentAt ? channel : best));
  }

  /**
   * The number carrying the fewest farmers, so new farmers spread evenly instead
   * of piling onto whichever number happened to be free. Ties break on the
   * longest-rested number.
   */
  leastLoaded(candidates) {
    const counts = this.assignments.counts();
    return candidates.reduce((best, channel) => {
      const load = counts[channel.name] || 0;
      const bestLoad = counts[best.name] || 0;
      if (load !== bestLoad) return load < bestLoad ? channel : best;
      return channel.lastSentAt < best.lastSentAt ? channel : best;
    });
  }

  /**
   * Brings a channel into rotation without a restart, so a number linked from
   * the admin panel can start sending immediately. Idempotent: re-adding an
   * existing name only refreshes its purposes, and deliberately keeps its
   * counters and cooldown rather than handing a rested number a clean slate.
   *
   * The caller is responsible for persisting it (channelRegistry), otherwise the
   * channel is lost on restart.
   */
  addChannel(channel) {
    const existing = this.byName(channel.name);
    if (existing) {
      existing.purposes = channel.purposes || existing.purposes;
      return existing;
    }

    const added = freshChannel(channel);
    this.channels.push(added);
    logger.info({ channel: added.name, purposes: added.purposes }, "[Channels] Channel added to rotation");
    // Find out straight away whether it is actually connected, so status shown
    // to the operator right after linking reflects reality.
    this.probe(added).catch(() => {});
    return added;
  }

  /**
   * Takes a channel out of rotation. Farmers assigned to it are released so they
   * are reassigned to a working number on their next message rather than being
   * pinned to a number that no longer exists.
   */
  removeChannel(name) {
    const existing = this.byName(name);
    if (!existing) return false;

    this.channels = this.channels.filter((channel) => channel.name !== name);
    const released = this.assignments.releaseChannel(name);
    logger.warn({ channel: name, released }, "[Channels] Channel removed from rotation");
    return true;
  }

  /**
   * Drops a panel-added channel that Evolution says does not exist and that never
   * connected — an abandoned link attempt. Returns true when it was forgotten.
   */
  forgetFailedAttempt(channel) {
    if (channel.everConnected || channel.totalSent > 0) return false;
    if (!config.channelRegistry.has(channel.name)) return false;

    logger.warn(
      { channel: channel.name },
      `[Channels] Forgetting '${channel.name}' — it was never linked and no longer exists in Evolution`,
    );
    config.channelRegistry.remove(channel.name);
    this.removeChannel(channel.name);
    return true;
  }

  /** Resets a channel's daily counter when the calendar day turns over. */
  rollDay(channel) {
    const today = currentDayStamp();
    if (channel.dayStamp !== today) {
      channel.dayStamp = today;
      channel.sentToday = 0;
    }
  }
}

/** A configured channel plus the per-process counters the pool routes on. */
function freshChannel(channel) {
  return {
    ...channel,
    /** Set at acquire time, not send time, so concurrent callers can't both grab one number. */
    lastSentAt: 0,
    /** Distinct from lastSentAt, which also moves on reservation and failure. */
    lastSuccessAt: 0,
    sentToday: 0,
    dayStamp: currentDayStamp(),
    failStreak: 0,
    cooldownUntil: 0,
    /** null until the first probe; false only when Evolution says it's not open. */
    connected: null,
    /** True once Evolution has confirmed an open session, even if nothing was sent yet. */
    everConnected: false,
    /** Keeps the "does not exist" error to one line per channel rather than one per probe. */
    reported404: false,
    totalSent: 0,
    totalFailed: 0,
    lastError: null,
    /** Kept apart from lastError: an unreachable probe is not a send failure. */
    lastProbeError: null,
  };
}

/**
 * Normally one number per farmer, full stop. When channels are reserved by
 * purpose the farmer necessarily needs one per purpose, so the key includes it —
 * still stable, just two numbers instead of one.
 */
function assignmentKey(purpose, phone) {
  return config.purposeReservations ? `${purpose}|${phone}` : String(phone);
}

function currentDayStamp() {
  return Math.floor(Date.now() / DAY_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { channelPool: new ChannelPool(), maskPhone };
