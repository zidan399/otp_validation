const fs = require("fs");
const path = require("path");

/**
 * Channels added at runtime, on disk.
 *
 * WHATSAPP_CHANNELS in .env is the declared list, but a number linked from the
 * admin panel isn't in it — and asking the operator to SSH in, edit .env and
 * restart would defeat the point of having the panel at all. So a channel
 * created through the API is recorded here, and config unions this file with the
 * env list at boot.
 *
 * Env stays authoritative for anything it names: if the same name appears in
 * both, the env entry wins, so .env remains the place to pin a channel's URL,
 * key or purposes.
 *
 * The file also records SUPPRESSED names: channels declared in .env that the
 * operator has removed from the panel. Without that, removing an env-declared
 * sender could only ever be cosmetic — it would come back on the next restart —
 * and the panel would be unable to clean up names that no longer exist in
 * Evolution. .env itself is never rewritten; it is treated as the declared
 * list, and this is the operator's list of exceptions to it.
 */

const FILE_VERSION = 1;

class ChannelRegistry {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    const loaded = this.load();
    this.entries = loaded.channels;
    this.suppressed = loaded.suppressed;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        // Drop anything unusable rather than letting a hand-edited file crash boot
        // and take logins down with it.
        channels: Array.isArray(parsed?.channels)
          ? parsed.channels.filter((entry) => entry && typeof entry.name === "string" && entry.name)
          : [],
        suppressed: Array.isArray(parsed?.suppressed)
          ? parsed.suppressed.filter((name) => typeof name === "string" && name)
          : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        // eslint-disable-next-line no-console -- config loads before the logger.
        console.error(`[ChannelRegistry] Ignoring unreadable ${this.filePath}: ${error.message}`);
      }
      return { channels: [], suppressed: [] };
    }
  }

  /** True when .env declares this name but the operator removed it here. */
  isSuppressed(name) {
    return this.suppressed.includes(name);
  }

  suppress(name) {
    if (this.suppressed.includes(name)) return false;
    this.suppressed.push(name);
    this.persist();
    return true;
  }

  /** Undoes a suppression, so re-linking an env-declared name works again. */
  unsuppress(name) {
    if (!this.suppressed.includes(name)) return false;
    this.suppressed = this.suppressed.filter((entry) => entry !== name);
    this.persist();
    return true;
  }

  list() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  has(name) {
    return this.entries.some((entry) => entry.name === name);
  }

  /** Adds or updates a channel. Returns true when the file changed. */
  upsert(entry) {
    const index = this.entries.findIndex((existing) => existing.name === entry.name);
    if (index >= 0) {
      this.entries[index] = { ...this.entries[index], ...entry };
    } else {
      this.entries.push(entry);
    }
    this.persist();
    return true;
  }

  remove(name) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.name !== name);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  persist() {
    const payload = JSON.stringify(
      { version: FILE_VERSION, channels: this.entries, suppressed: this.suppressed },
      null,
      2,
    );
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write then rename, so a crash mid-write can't leave a truncated file that
    // would silently drop every runtime-added channel on the next boot.
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, payload);
    fs.renameSync(temp, this.filePath);
  }
}

module.exports = { ChannelRegistry };
