const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Concurrency guarantees.
 *
 * The whole point of running several numbers is that N people logging in at the
 * same moment are served at the same moment. The per-number quiet gap exists to
 * stop ONE number looking bursty; it must never become a service-wide queue.
 * These tests pin that down, because the failure mode is invisible in
 * production — it looks like "the service is a bit slow", not like a bug.
 */

let tempDir;

function loadPool(env) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes("renile_evolution_otp/src")) delete require.cache[key];
  }
  tempDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "otp-conc-"));
  Object.assign(process.env, {
    WHATSAPP_ASSIGNMENTS_FILE: path.join(tempDir, `a-${Math.floor(Math.random() * 1e9)}.json`),
    WHATSAPP_REGISTRY_FILE: path.join(tempDir, `r-${Math.floor(Math.random() * 1e9)}.json`),
    EVOLUTION_URL: "http://127.0.0.1:8080",
    API_KEY: "test-key",
    JWT_SECRET: "test-secret",
    LOG_LEVEL: "silent",
    WHATSAPP_CHANNEL_JITTER_MS: "0",
    WHATSAPP_CHANNEL_PROBE_MS: "0",
    WHATSAPP_CHANNEL_MIN_GAP_MS: "5000",
    WHATSAPP_CHANNEL_DAILY_CAP: "0",
    // Restated every time: process.env is only added to, never cleared, so a
    // value set by one test would otherwise silently apply to the next.
    WHATSAPP_ACQUIRE_TIMEOUT_MS: "20000",
    WHATSAPP_OTP_CHANNELS: "",
    WHATSAPP_ALERT_CHANNELS: "",
    INSTANCE_NAME: "",
    ...env,
  });
  return require("../src/services/channelPool").channelPool;
}

/** Marks channels as confirmed-open, the way a successful probe would. */
function connectAll(pool) {
  for (const channel of pool.channels) channel.connected = true;
}

test("three users, three senders: all acquire at once, nobody waits", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "s1,s2,s3" });
  connectAll(pool);

  const started = Date.now();
  const got = await Promise.all(
    ["201111111111", "202222222222", "203333333333"].map((phone) =>
      pool.acquire({ purpose: "otp", phone }),
    ),
  );
  const elapsed = Date.now() - started;

  assert.equal(got.filter(Boolean).length, 3, "every user should get a sender");
  assert.equal(
    new Set(got.map((c) => c.name)).size,
    3,
    "three users must land on three DIFFERENT senders",
  );
  // The gap is 5000ms. Anything approaching it means someone queued.
  assert.ok(elapsed < 500, `all three should acquire immediately, took ${elapsed}ms`);
});

test("the quiet gap applies per number, not service-wide", async () => {
  const pool = loadPool({ WHATSAPP_CHANNELS: "s1,s2,s3" });
  connectAll(pool);

  // Burn s1 by sending on it, so it is the one number that must rest.
  const first = await pool.acquire({ purpose: "otp", phone: "201111111111" });
  assert.ok(first);

  // A different farmer must not inherit s1's gap.
  const started = Date.now();
  const second = await pool.acquire({ purpose: "otp", phone: "202222222222" });
  const elapsed = Date.now() - started;

  assert.notEqual(second.name, first.name);
  assert.ok(elapsed < 500, `second user waited ${elapsed}ms on another number's gap`);
});

test("a fourth user shares a number and therefore does wait", async () => {
  // The flip side, so the gap isn't silently lost: with more people than
  // numbers, someone genuinely has to queue.
  const pool = loadPool({ WHATSAPP_CHANNELS: "s1,s2,s3", WHATSAPP_ACQUIRE_TIMEOUT_MS: "500" });
  connectAll(pool);

  for (const phone of ["201111111111", "202222222222", "203333333333"]) {
    assert.ok(await pool.acquire({ purpose: "otp", phone }));
  }

  // Everyone is resting; a fourth farmer can't be served inside 500ms.
  const fourth = await pool.acquire({ purpose: "otp", phone: "204444444444" });
  assert.equal(fourth, null, "a fourth user should wait rather than burst a busy number");
});

test("REGRESSION: farmers pinned to one number do not spread when senders are added", async () => {
  // The production symptom: three users all served by one sender, 5-7s apart,
  // while two healthy senders sit idle. Sticky assignment only moves a farmer
  // when their number is UNUSABLE, and 'busy' does not count as unusable.
  const pool = loadPool({ WHATSAPP_CHANNELS: "s1" });
  connectAll(pool);

  // assignedChannel rather than acquire: this is about which number each farmer
  // is PINNED to, and acquire would additionally sit out s1's 5s gap three times.
  const phones = ["201111111111", "202222222222", "203333333333"];
  for (const phone of phones) {
    assert.equal(pool.assignedChannel("otp", phone, []).name, "s1");
  }

  // Operator links two more senders from the admin panel.
  pool.addChannel({ name: "s2", url: "http://127.0.0.1:8080", apiKey: "test-key", purposes: ["otp", "alert"] });
  pool.addChannel({ name: "s3", url: "http://127.0.0.1:8080", apiKey: "test-key", purposes: ["otp", "alert"] });
  connectAll(pool);

  const counts = pool.assignments.counts();
  assert.equal(counts.s1, 3, "all three farmers are still pinned to the original sender");
  assert.equal(counts.s2, undefined);
  assert.equal(counts.s3, undefined);
});
