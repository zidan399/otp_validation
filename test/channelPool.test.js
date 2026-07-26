const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let tempDir;

/**
 * The pool is loaded fresh per test with its own env, because config.js reads
 * process.env once at require time. Each test gets its own assignments file so
 * they can't inherit each other's farmer-to-number map.
 */
function loadPool(env) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes("renile_evolution_otp/src")) delete require.cache[key];
  }
  tempDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "otp-pool-"));
  Object.assign(process.env, {
    WHATSAPP_ASSIGNMENTS_FILE: path.join(
      tempDir,
      `assignments-${Math.floor(Math.random() * 1e9)}.json`,
    ),
    // Isolated per test too: a real data/channels.json on the developer's machine
    // would otherwise add its channels to every test's pool.
    WHATSAPP_REGISTRY_FILE: path.join(tempDir, `registry-${Math.floor(Math.random() * 1e9)}.json`),
    EVOLUTION_URL: "http://127.0.0.1:8080",
    API_KEY: "test-key",
    JWT_SECRET: "test-secret",
    LOG_LEVEL: "silent",
    WHATSAPP_CHANNEL_JITTER_MS: "0",
    WHATSAPP_CHANNEL_PROBE_MS: "0",
    WHATSAPP_CHANNELS: "",
    WHATSAPP_OTP_CHANNELS: "",
    WHATSAPP_ALERT_CHANNELS: "",
    WHATSAPP_CHANNEL_DAILY_CAP: "0",
    ...env,
  });
  return require("../src/services/channelPool").channelPool;
}

test("falls back to INSTANCE_NAME when no channel list is given", () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "", INSTANCE_NAME: "legacy" });
  assert.equal(pool.channels.length, 1);
  assert.equal(pool.channels[0].name, "legacy");
});

test("reservation lists alone still define the channel list", () => {
  // Listing numbers only in the reservation lists is an easy mistake; silently
  // dropping to one INSTANCE_NAME channel would restore the ban condition.
  const pool = loadPool({
    WHATSAPP_CHANNELS: "",
    INSTANCE_NAME: "legacy",
    WHATSAPP_OTP_CHANNELS: "a,b",
    WHATSAPP_ALERT_CHANNELS: "c,d,e",
  });

  assert.deepEqual(
    pool.channels.map((c) => c.name),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(pool.byName("a").purposes, ["otp"]);
  assert.deepEqual(pool.byName("c").purposes, ["alert"]);
});

test("spreads a burst across every channel instead of reusing one", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b,c", WHATSAPP_CHANNEL_MIN_GAP_MS: "60000" });

  const used = [];
  for (let i = 0; i < 3; i += 1) {
    const channel = await pool.acquire({ purpose: "alert", phone: `2010000000${i}` });
    assert.ok(channel, "expected a channel");
    used.push(channel.name);
  }

  assert.deepEqual(used.sort(), ["a", "b", "c"], "each channel used exactly once");
});

test("5 recipients over 3 channels distribute 2/2/1", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b,c", WHATSAPP_CHANNEL_MIN_GAP_MS: "0" });

  await Promise.all(
    ["201000001", "201000002", "201000003", "201000004", "201000005"].map((phone) =>
      pool.acquire({ purpose: "otp", phone }),
    ),
  );

  const load = Object.values(pool.assignments.counts()).sort();
  assert.deepEqual(load, [1, 2, 2], "new recipients go to the least-loaded number");
});

test("a recipient is never served by a second number while theirs works", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b,c,d", WHATSAPP_CHANNEL_MIN_GAP_MS: "0" });
  const phone = "201234567890";

  const used = new Set();
  for (let i = 0; i < 10; i += 1) {
    const channel = await pool.acquire({ purpose: "alert", phone });
    pool.reportSuccess(channel);
    used.add(channel.name);
  }

  assert.equal(used.size, 1, "ten messages, one sender number");
});

test("a busy assigned channel makes the message wait rather than switching sender", async () => {
  const pool = loadPool({
    WHATSAPP_CHANNELS: "a,b,c",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "300",
    WHATSAPP_ACQUIRE_TIMEOUT_MS: "5000",
  });
  const phone = "201999888777";

  const first = await pool.acquire({ purpose: "alert", phone });
  pool.reportSuccess(first);

  const startedAt = Date.now();
  const second = await pool.acquire({ purpose: "alert", phone });

  assert.equal(second.name, first.name, "same sender, even though others were free");
  assert.ok(Date.now() - startedAt >= 250, "it waited out the gap instead of switching");
});

test("a recipient is migrated when their own channel goes down", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b", WHATSAPP_CHANNEL_MIN_GAP_MS: "0" });
  const phone = "201777666555";

  const first = await pool.acquire({ purpose: "alert", phone });
  pool.reportSuccess(first);

  // Their number drops off WhatsApp.
  pool.byName(first.name).connected = false;
  pool.probeAll = async () => {};

  const second = await pool.acquire({ purpose: "alert", phone });
  assert.ok(second, "a login must not fail just because one number died");
  assert.notEqual(second.name, first.name, "migrated to a working number");

  // And the migration sticks — they don't bounce back and forth.
  const third = await pool.acquire({ purpose: "alert", phone });
  assert.equal(third.name, second.name);
});

test("assignments survive a restart", async () => {
  const file = path.join(tempDir || os.tmpdir(), `persist-${Date.now()}.json`);
  const phone = "201444333222";

  const first = loadPool({
    WHATSAPP_CHANNELS: "a,b,c,d",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "0",
    WHATSAPP_ASSIGNMENTS_FILE: file,
  });
  const before = await first.acquire({ purpose: "alert", phone });
  first.assignments.flush();

  const restarted = loadPool({
    WHATSAPP_CHANNELS: "a,b,c,d",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "0",
    WHATSAPP_ASSIGNMENTS_FILE: file,
  });
  const after = await restarted.acquire({ purpose: "alert", phone });

  assert.equal(after.name, before.name, "same sender number after a restart");
});

test("stickiness can be turned off", async () => {
  const pool = loadPool({
    WHATSAPP_CHANNELS: "a,b,c",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "0",
    WHATSAPP_STICKY_SENDER: "false",
  });
  const phone = "201222111000";

  const used = new Set();
  for (let i = 0; i < 3; i += 1) {
    const channel = await pool.acquire({ purpose: "alert", phone });
    pool.reportSuccess(channel);
    used.add(channel.name);
  }

  assert.ok(used.size > 1, "without stickiness the sender rotates per message");
});

test("a channel is not reused until its own gap has elapsed", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a", WHATSAPP_CHANNEL_MIN_GAP_MS: "60000", WHATSAPP_ACQUIRE_TIMEOUT_MS: "200" });

  assert.ok(await pool.acquire({ purpose: "alert" }));
  assert.equal(await pool.acquire({ purpose: "alert" }), null, "second send must wait past the timeout");
});

test("reserved channels only carry their own purpose", async () => {
  const pool = loadPool({
    WHATSAPP_CHANNELS: "login_only,alerts_only",
    WHATSAPP_OTP_CHANNELS: "login_only",
    WHATSAPP_ALERT_CHANNELS: "alerts_only",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "0",
  });

  const otp = await pool.acquire({ purpose: "otp" });
  const alert = await pool.acquire({ purpose: "alert" });

  assert.equal(otp.name, "login_only");
  assert.equal(alert.name, "alerts_only");
});

test("alert saturation cannot starve logins when a channel is reserved", async () => {
  const pool = loadPool({
    WHATSAPP_CHANNELS: "login_only,shared",
    WHATSAPP_OTP_CHANNELS: "login_only",
    WHATSAPP_ALERT_CHANNELS: "shared",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "60000",
    WHATSAPP_ACQUIRE_TIMEOUT_MS: "100",
  });

  const alert = await pool.acquire({ purpose: "alert" });
  assert.equal(alert.name, "shared");
  // The alert channel is now busy for a minute; the login channel is untouched.
  assert.equal(await pool.acquire({ purpose: "alert" }), null);

  const otp = await pool.acquire({ purpose: "otp" });
  assert.equal(otp?.name, "login_only", "login still goes out during an alert flood");
});

test("a channel rests after consecutive failures and stops receiving traffic", async () => {
  const pool = loadPool({
    WHATSAPP_CHANNELS: "a,b",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "0",
    WHATSAPP_CHANNEL_FAIL_THRESHOLD: "2",
    WHATSAPP_CHANNEL_COOLDOWN_MS: "60000",
  });

  const bad = pool.byName("a");
  pool.reportFailure(bad, { reason: "GATEWAY_ERROR" });
  pool.reportFailure(bad, { reason: "GATEWAY_ERROR" });

  assert.ok(bad.cooldownUntil > Date.now(), "channel a is resting");
  assert.deepEqual(
    pool.eligible("alert").map((c) => c.name),
    ["b"],
  );
});

test("a channel name that doesn't exist in Evolution leaves rotation at once", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "real,typo", WHATSAPP_CHANNEL_MIN_GAP_MS: "0", WHATSAPP_CHANNEL_FAIL_THRESHOLD: "3" });

  // A typo is not a transient fault, so it must not take three messages to
  // notice — one 404 is conclusive.
  pool.reportFailure(pool.byName("typo"), { reason: "INSTANCE_NOT_FOUND" });

  assert.equal(pool.byName("typo").connected, false);
  assert.deepEqual(
    pool.eligible("alert").map((c) => c.name),
    ["real"],
  );

  const chosen = await pool.acquire({ purpose: "otp", phone: "201000000009" });
  assert.equal(chosen.name, "real", "no recipient is ever assigned to a missing instance");
});

test("recipient-side failures do not penalise the sending channel", () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a", WHATSAPP_CHANNEL_FAIL_THRESHOLD: "1" });
  const channel = pool.byName("a");

  pool.reportFailure(channel, { reason: "NOT_ON_WHATSAPP", recipientFault: true });

  assert.equal(channel.cooldownUntil, 0, "a wrong recipient number must not rest our sender");
  assert.equal(channel.failStreak, 0);
});

test("a success clears an in-progress failure streak", () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a", WHATSAPP_CHANNEL_FAIL_THRESHOLD: "3" });
  const channel = pool.byName("a");

  pool.reportFailure(channel, {});
  pool.reportFailure(channel, {});
  pool.reportSuccess(channel);

  assert.equal(channel.failStreak, 0);
  assert.equal(channel.cooldownUntil, 0);
});

test("a channel at its daily cap drops out of rotation", async () => {
  const pool = loadPool({
    WHATSAPP_CHANNELS: "a,b",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "0",
    WHATSAPP_CHANNEL_DAILY_CAP: "1",
  });

  pool.reportSuccess(pool.byName("a"));

  assert.deepEqual(
    pool.eligible("alert").map((c) => c.name),
    ["b"],
  );
});

test("disconnected channels are skipped and return once reconnected", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b", WHATSAPP_CHANNEL_MIN_GAP_MS: "0" });

  pool.byName("a").connected = false;
  assert.deepEqual(
    pool.eligible("alert").map((c) => c.name),
    ["b"],
  );

  pool.byName("a").connected = true;
  assert.equal(pool.eligible("alert").length, 2);
});

test("retries land on a different channel than the one that just failed", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b,c", WHATSAPP_CHANNEL_MIN_GAP_MS: "0" });

  const first = await pool.acquire({ purpose: "alert", phone: "201111111111" });
  const retry = await pool.acquire({ purpose: "alert", phone: "201111111111", exclude: [first.name] });

  assert.notEqual(retry.name, first.name);
});

test("returns null rather than sending when every channel is down", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b", WHATSAPP_ACQUIRE_TIMEOUT_MS: "100" });

  pool.channels.forEach((channel) => {
    channel.connected = false;
  });
  // probeAll would normally re-check; point it at a dead port so it stays down.
  pool.probeAll = async () => {};

  assert.equal(await pool.acquire({ purpose: "otp" }), null);
});

test("status reports every channel without leaking api keys", () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "a,b" });
  const status = pool.status();

  assert.equal(status.total, 2);
  assert.equal(status.channels.length, 2);
  assert.equal(JSON.stringify(status).includes("test-key"), false);
});
