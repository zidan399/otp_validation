const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");

/**
 * Covers adding and removing sender numbers at runtime — the path the admin
 * panel drives.
 *
 * Two things here are load-bearing and easy to regress:
 *  - a number linked from the panel must start sending WITHOUT an .env edit or a
 *    restart, otherwise the page is only half a feature;
 *  - the admin routes must not be openable with an ordinary login token, since
 *    both are signed with the same shared secret.
 */

let tempDir;

function freshEnv(env = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes("renile_evolution_otp/src")) delete require.cache[key];
  }
  tempDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "otp-admin-"));
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
    ...env,
  });
  return {
    get config() {
      return require("../src/config");
    },
    get pool() {
      return require("../src/services/channelPool").channelPool;
    },
  };
}

// --- registry persistence ---

test("a channel added at runtime is picked up on the next boot", () => {
  const registryFile = path.join(
    (tempDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "otp-admin-"))),
    `boot-${Math.floor(Math.random() * 1e9)}.json`,
  );

  const first = freshEnv({ WHATSAPP_REGISTRY_FILE: registryFile });
  first.config.channelRegistry.upsert({ name: "panel_1", phone: "201000000001" });

  // Simulate a restart: same registry file, fresh module graph.
  const second = freshEnv({ WHATSAPP_REGISTRY_FILE: registryFile });
  const names = second.config.channels.map((channel) => channel.name);
  assert.ok(names.includes("panel_1"), `expected panel_1 in ${names.join(", ")}`);
  assert.ok(names.includes("base"), "the env-declared channel must survive too");
});

test("env wins over the registry for the same name, so .env stays authoritative", () => {
  const registryFile = path.join(tempDir, `conflict-${Math.floor(Math.random() * 1e9)}.json`);
  fs.writeFileSync(
    registryFile,
    JSON.stringify({ version: 1, channels: [{ name: "n1", purposes: ["alert"] }] }),
  );

  const env = freshEnv({
    WHATSAPP_REGISTRY_FILE: registryFile,
    WHATSAPP_CHANNELS: "n1",
    WHATSAPP_OTP_CHANNELS: "n1",
  });

  const matching = env.config.channels.filter((channel) => channel.name === "n1");
  assert.equal(matching.length, 1, "the channel must not be duplicated");
  assert.deepEqual(matching[0].purposes, ["otp"], "env reservation must win over the registry entry");
});

test("registry channels alone are a valid configuration", () => {
  const registryFile = path.join(tempDir, `only-${Math.floor(Math.random() * 1e9)}.json`);
  fs.writeFileSync(registryFile, JSON.stringify({ version: 1, channels: [{ name: "panel_only" }] }));

  // No WHATSAPP_CHANNELS and no INSTANCE_NAME: booting must succeed rather than
  // throwing, because a panel-only setup is a legitimate deployment.
  const env = freshEnv({ WHATSAPP_REGISTRY_FILE: registryFile, INSTANCE_NAME: "" });
  assert.deepEqual(
    env.config.channels.map((channel) => channel.name),
    ["panel_only"],
  );
});

test("an unreadable registry file does not stop the service from booting", () => {
  const registryFile = path.join(tempDir, `corrupt-${Math.floor(Math.random() * 1e9)}.json`);
  fs.writeFileSync(registryFile, "{ this is not json");

  const env = freshEnv({ WHATSAPP_REGISTRY_FILE: registryFile });
  // Sending must keep working on the env-declared channel; a corrupt file is
  // recoverable, a service that refuses to start is not.
  assert.deepEqual(
    env.config.channels.map((channel) => channel.name),
    ["base"],
  );
});

// --- live rotation ---

test("addChannel puts a number into rotation without a restart", async () => {
  const env = freshEnv();
  const pool = env.pool;
  assert.equal(pool.channels.length, 1);

  pool.addChannel({ name: "panel_2", url: "http://127.0.0.1:8080", apiKey: "k", purposes: ["otp", "alert"] });

  assert.equal(pool.channels.length, 2);
  const added = pool.byName("panel_2");
  assert.ok(added, "the new channel must be findable by name");
  // Not yet probed, so it is deliberately not routable — reporting it as ready
  // before Evolution confirms the session would send a login into a black hole.
  assert.equal(added.connected, null);

  added.connected = true;
  const chosen = await pool.acquire({ purpose: "otp", phone: "201000000009" });
  assert.ok(chosen, "a probed, connected channel must be usable");
});

test("addChannel is idempotent and does not reset an existing channel's counters", () => {
  const env = freshEnv({ WHATSAPP_CHANNELS: "n1" });
  const pool = env.pool;

  const existing = pool.byName("n1");
  existing.totalSent = 7;
  existing.cooldownUntil = Date.now() + 60_000;

  pool.addChannel({ name: "n1", url: "http://127.0.0.1:8080", apiKey: "k", purposes: ["otp", "alert"] });

  assert.equal(pool.channels.length, 1, "re-adding must not duplicate the channel");
  // Handing a resting number a clean slate would let a repeated link attempt
  // clear a cooldown that exists because the number is in trouble.
  assert.equal(pool.byName("n1").totalSent, 7);
  assert.ok(pool.byName("n1").cooldownUntil > Date.now());
});

test("removing a channel releases its farmers to the survivors", async () => {
  const env = freshEnv({ WHATSAPP_CHANNELS: "n1,n2" });
  const pool = env.pool;
  for (const channel of pool.channels) channel.connected = true;

  // Two farmers, one on each number thanks to least-loaded assignment.
  const first = await pool.acquire({ purpose: "otp", phone: "201000000001" });
  const second = await pool.acquire({ purpose: "otp", phone: "201000000002" });
  assert.notEqual(first.name, second.name);

  const doomed = first.name;
  const survivor = second.name;
  assert.equal(pool.removeChannel(doomed), true);
  assert.equal(pool.channels.length, 1);

  // The farmer who was on the removed number must land on the survivor rather
  // than staying pinned to a channel that no longer exists.
  const reassigned = await pool.acquire({ purpose: "otp", phone: "201000000001" });
  assert.equal(reassigned.name, survivor);
});

test("removing an unknown channel is a no-op rather than an error", () => {
  const pool = freshEnv().pool;
  assert.equal(pool.removeChannel("never_existed"), false);
});

test("status marks which channels the panel is allowed to remove", () => {
  const env = freshEnv({ WHATSAPP_CHANNELS: "from_env" });
  env.config.channelRegistry.upsert({ name: "from_panel" });
  const pool = env.pool;
  pool.addChannel({ name: "from_panel", url: "http://127.0.0.1:8080", apiKey: "k", purposes: ["otp", "alert"] });

  const byName = Object.fromEntries(pool.status().channels.map((channel) => [channel.name, channel]));
  assert.equal(byName.from_env.managed, false, "an env-declared channel would reappear on restart");
  assert.equal(byName.from_panel.managed, true);
});

// --- admin authentication ---

function runGuard(headers, env = {}) {
  const context = freshEnv(env);
  void context.config;
  const { requireAdmin, ADMIN_SCOPE } = require("../src/helpers/adminAuth");

  const req = { get: (name) => headers[name.toLowerCase()] ?? undefined };
  const result = { status: null, body: null, nextCalled: false };
  const res = {
    status(code) {
      result.status = code;
      return res;
    },
    json(payload) {
      result.body = payload;
      return res;
    },
  };
  requireAdmin(req, res, () => {
    result.nextCalled = true;
  });
  return { result, ADMIN_SCOPE, req };
}

test("admin routes reject a request with no token", () => {
  const { result } = runGuard({});
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test("admin routes reject an ordinary OTP login token", () => {
  // The critical case: login tokens are signed with the SAME secret, so only the
  // scope claim separates a farmer's token from instance management.
  const loginToken = jwt.sign({ phone: "201000000001" }, "test-secret", { expiresIn: "3m" });
  const { result } = runGuard({ authorization: `Bearer ${loginToken}` });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 403);
});

test("admin routes reject a token signed with the wrong secret", () => {
  const forged = jwt.sign({ scope: "channel-admin" }, "not-the-secret");
  const { result } = runGuard({ authorization: `Bearer ${forged}` });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test("admin routes accept a correctly scoped token", () => {
  const token = jwt.sign({ scope: "channel-admin", actor: "admin-1" }, "test-secret", { expiresIn: "2m" });
  const { result, req } = runGuard({ authorization: `Bearer ${token}` });
  assert.equal(result.nextCalled, true);
  assert.equal(result.status, null);
  assert.equal(req.admin.actor, "admin-1");
});

test("admin routes refuse to operate when no JWT secret is configured", () => {
  const token = jwt.sign({ scope: "channel-admin" }, "test-secret");
  const { result } = runGuard({ authorization: `Bearer ${token}` }, { JWT_SECRET: "" });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 503);
});

// --- input validation ---

test("phone numbers are normalized to full international form", () => {
  freshEnv();
  const { normalizeNumber } = require("../src/services/channelLinker");

  // A pairing code is bound to the exact number, so a trunk zero or a plus sign
  // left in place fails on the phone with no useful error.
  assert.equal(normalizeNumber("01012345678"), "201012345678");
  assert.equal(normalizeNumber("+20 101 234 5678"), "201012345678");
  assert.equal(normalizeNumber("0020101234 5678"), "201012345678");
  assert.equal(normalizeNumber("201012345678"), "201012345678");
});

test("instance names that could escape the API path are rejected", async () => {
  freshEnv();
  const linker = require("../src/services/channelLinker");

  for (const name of ["../etc", "a b", "", "-leading", "x".repeat(60)]) {
    await assert.rejects(
      () => linker.link({ name, phone: "201012345678" }),
      (error) => error.code === "INVALID_NAME" && error.status === 400,
      `expected '${name}' to be rejected`,
    );
  }
});

test("linking without a usable phone number is rejected before Evolution is called", async () => {
  freshEnv();
  const linker = require("../src/services/channelLinker");

  await assert.rejects(
    () => linker.link({ name: "valid_name", phone: "123" }),
    (error) => error.code === "INVALID_PHONE" && error.status === 400,
  );
});

// --- controller error mapping ---
// Exercised through the controller rather than the linker, because the linker
// throwing the right error is only half of it: the handler that turns that error
// into a response has its own way to fail, and when it does every 4xx becomes an
// opaque 500 that tells the operator nothing.

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

test("a rejected instance name reaches the client as 400, not 500", async () => {
  // A level at which warn actually writes, on purpose: pino's disabled methods
  // are no-ops that survive being called without a receiver, so a silent logger
  // would hide exactly the failure this test exists to catch.
  freshEnv({ LOG_LEVEL: "warn" });
  const controller = require("../src/controllers/channelController");
  const { res, captured } = fakeRes();

  await controller.link({ body: { name: "../etc", phone: "201012345678" } }, res);

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, "INVALID_NAME");
});

test("a rejected name on delete reaches the client as 400, not 500", async () => {
  freshEnv({ LOG_LEVEL: "warn" });
  const controller = require("../src/controllers/channelController");
  const { res, captured } = fakeRes();

  await controller.unlink({ params: { name: "../etc" } }, res);

  assert.equal(captured.status, 400);
  assert.equal(captured.body.code, "INVALID_NAME");
});


test("admin routes follow OTP_JWT_SECRET when it is set, like the OTP routes do", () => {
  // Nojo_back signs every service token with one secret. If the admin guard read
  // JWT_SECRET while the OTP routes read OTP_JWT_SECRET, setting the latter would
  // break channel administration while logins kept working — a confusing failure.
  const token = jwt.sign({ scope: "channel-admin" }, "override-secret", { expiresIn: "2m" });
  const { result } = runGuard({ authorization: `Bearer ${token}` }, {
    JWT_SECRET: "test-secret",
    OTP_JWT_SECRET: "override-secret",
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.status, null);
});

test("admin routes refuse the well-known default secret", () => {
  // config falls back to 'default_otp_secret' when nothing is configured. Honouring
  // it would let anyone who can reach this port create WhatsApp senders.
  const token = jwt.sign({ scope: "channel-admin" }, "default_otp_secret");
  const { result } = runGuard({ authorization: `Bearer ${token}` }, {
    JWT_SECRET: "",
    OTP_JWT_SECRET: "",
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 503);
});
