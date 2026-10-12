const fs = require("fs");
const path = require("path");
const config = require("../config");
const { logger } = require("../helpers/logger");

/**
 * Remembers which sender number belongs to which farmer.
 *
 * A farmer must hear from ONE number. Receiving the same kind of message from
 * several different senders is what a scam looks like to the person reading it,
 * and what a spam ring looks like to WhatsApp — the numbers get reported, and
 * reports are the fastest route to a ban.
 *
 * The map is written to disk because an in-memory-only guarantee would break on
 * every restart: a farmer would be silently migrated to a different number each
 * time the service was redeployed, which is exactly what it exists to prevent.
 * Disk problems are non-fatal — the map still works for the life of the process.
 */
class ChannelAssignments {
  constructor() {
    this.filePath = config.assignmentsFile;
    this.ttlMs = config.assignmentTtlDays * 24 * 60 * 60 * 1000;
    /** key -> { channel, lastUsedAt } */
    this.entries = new Map();
    this.persistTimer = null;
    this.writeFailed = false;

    this.load();
  }

  get(key) {
    return this.entries.get(key)?.channel ?? null;
  }

  /** Records that this key used its channel, so it isn't pruned as stale. */
  touch(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    this.schedulePersist();
  }

  set(key, channel) {
    this.entries.set(key, { channel, lastUsedAt: Date.now() });
    this.schedulePersist();
  }

  /** How many farmers each number currently carries, for balancing. */
  counts() {
    const counts = {};
    for (const entry of this.entries.values()) {
      counts[entry.channel] = (counts[entry.channel] || 0) + 1;
    }
    return counts;
  }

  size() {
    return this.entries.size;
  }

  /**
   * Forgets every farmer assigned to one number, for when that number is removed.
   * Leaving them pinned to a channel that no longer exists would send each of
   * them through the migrate path on their next message anyway; dropping the
   * entries now means they are simply reassigned to the least-loaded survivor.
   * Returns how many farmers were released.
   */
  releaseChannel(channelName) {
    let released = 0;
    for (const [key, value] of this.entries) {
      if (value.channel !== channelName) continue;
      this.entries.delete(key);
      released += 1;
    }
    if (released > 0) this.schedulePersist();
    return released;
  }

  // --- persistence ---

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const cutoff = Date.now() - this.ttlMs;
      let pruned = 0;

      for (const [key, value] of Object.entries(parsed.assignments || {})) {
        // Drop farmers who haven't been messaged in a long time, so the map
        // doesn't grow forever and freed numbers can rebalance.
        if (!value?.channel || (value.lastUsedAt || 0) < cutoff) {
          pruned += 1;
          continue;
        }
        this.entries.set(key, { channel: value.channel, lastUsedAt: value.lastUsedAt || Date.now() });
      }

      logger.info(
        { file: this.filePath, loaded: this.entries.size, pruned },
        "[Channels] Loaded sender assignments",
      );
    } catch (error) {
      // A corrupt or unreadable map must not stop the service from sending.
      // Starting empty means farmers get reassigned, which is recoverable.
      logger.error(
        { file: this.filePath, error: error.message },
        "[Channels] Could not read sender assignments — starting empty",
      );
    }
  }

  /**
   * Batches writes: a burst of logins would otherwise rewrite the file once per
   * message.
   */
  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 2000);
    this.persistTimer.unref?.();
  }

  persist() {
    try {
      const assignments = {};
      for (const [key, value] of this.entries) assignments[key] = value;

      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Write-then-rename, so a crash mid-write can't leave a truncated file
      // that the next boot would discard as corrupt.
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, assignments }, null, 2));
      fs.renameSync(temp, this.filePath);
      this.writeFailed = false;
    } catch (error) {
      if (!this.writeFailed) {
        this.writeFailed = true;
        logger.error(
          { file: this.filePath, error: error.message },
          "[Channels] Cannot persist sender assignments — they will reset on restart",
        );
      }
    }
  }

  /** Flushes immediately, for shutdown. */
  flush() {
    // Keyed on a pending write rather than on the map being non-empty: removing
    // a channel releases its farmers, and an emptied map still has to be written
    // or the next boot would restore the assignments that were just dropped.
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persist();
  }
}

module.exports = { ChannelAssignments };
