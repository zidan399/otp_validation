const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

/**
 * Guards the linking sequence against a bug that has now bitten twice.
 *
 * Restarting an Evolution instance destroys the WhatsApp session its current
 * pairing code belongs to. Do it while the phone is mid-handshake — the screen
 * showing "Logging in..." — and WhatsApp fails the login with a 401 Connection
 * Failure, the phone reports "Couldn't link device", and Evolution tears the
 * instance down. It reads as a rejected code but is really the server pulling the
 * rug, and it makes linking fail 100% of the time.
 *
 * The trap is that POST /instance/create with a `number` ALREADY starts the
 * handshake and returns a code, so any "now request a code" step after it is a
 * restart of something already running. These tests assert on the exact HTTP calls
 * made, because that is the only way to catch it — every individual response still
 * looks fine.
 */

let tempDir;

/** Records every request so the test can assert what was NOT called. */
function stubEvolution({ state }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url.split("?")[0]}`);
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.url.startsWith("/instance/connectionState/")) {
      if (state === "missing") return send(404, { message: "does not exist" });
      return send(200, { instance: { state } });
    }
    if (req.url === "/instance/create") {
      return send(201, { instance: { instanceName: "x" }, qrcode: { pairingCode: "CREATECODE" } });
    }
    if (req.url.startsWith("/instance/connect/")) {
      return send(200, { pairingCode: "CONNECTCODE" });
    }
    if (req.url.startsWith("/instance/restart/")) {
      return send(200, {});
    }
    if (req.url === "/instance/fetchInstances") return send(200, []);
    return send(200, {});
  });
  return { server, calls };
}

async function withStub({ state }, run) {
  const { server, calls } = stubEvolution({ state });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  for (const key of Object.keys(require.cache)) {
    if (key.includes("renile_evolution_otp/src")) delete require.cache[key];
  }
  tempDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "otp-link-"));
  const stamp = Math.floor(Math.random() * 1e9);
  Object.assign(process.env, {
    WHATSAPP_ASSIGNMENTS_FILE: path.join(tempDir, `a-${stamp}.json`),
    WHATSAPP_REGISTRY_FILE: path.join(tempDir, `r-${stamp}.json`),
    EVOLUTION_URL: `http://127.0.0.1:${port}`,
    API_KEY: "test-key",
    JWT_SECRET: "test-secret",
    OTP_JWT_SECRET: "",
    LOG_LEVEL: "silent",
    WHATSAPP_CHANNEL_PROBE_MS: "0",
    WHATSAPP_CHANNELS: "",
    WHATSAPP_OTP_CHANNELS: "",
    WHATSAPP_ALERT_CHANNELS: "",
    INSTANCE_NAME: "base",
  });

  try {
    await run(require("../src/services/channelLinker"), calls, require("../src/services/channelPool").channelPool);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("linking a brand-new number never restarts the instance", async () => {
  await withStub({ state: "missing" }, async (linker, calls) => {
    const result = await linker.link({ name: "ReNile_9", phone: "201026217283" });

    // The code must be the one create already produced. Asking /instance/connect
    // for another would restart the handshake create just started.
    assert.equal(result.pairingCode, "CREATECODE");

    const restarts = calls.filter((call) => call.startsWith("POST /instance/restart"));
    assert.deepEqual(restarts, [], `restart must never happen here; calls were:\n  ${calls.join("\n  ")}`);

    const connects = calls.filter((call) => call.startsWith("GET /instance/connect/"));
    assert.deepEqual(connects, [], "create already started the handshake, so connect is redundant");
  });
});

test("an existing closed instance is asked for a fresh code, still without a restart", async () => {
  await withStub({ state: "close" }, async (linker, calls) => {
    const result = await linker.link({ name: "ReNile_9", phone: "201026217283" });

    assert.equal(result.pairingCode, "CONNECTCODE");
    assert.deepEqual(
      calls.filter((call) => call.startsWith("POST /instance/restart")),
      [],
    );
    assert.deepEqual(
      calls.filter((call) => call === "POST /instance/create"),
      [],
      "an existing instance must not be recreated",
    );
  });
});

test("a link attempt already in progress is refused rather than cancelled", async () => {
  await withStub({ state: "connecting" }, async (linker, calls) => {
    // This is the case that used to silently restart: the phone may be showing
    // "Logging in..." right now, and starting over would kill it.
    await assert.rejects(
      () => linker.link({ name: "ReNile_9", phone: "201026217283" }),
      (error) => error.code === "LINK_IN_PROGRESS" && error.status === 409,
    );

    assert.deepEqual(
      calls.filter((call) => call.startsWith("POST /instance/restart")),
      [],
      "refusing must not touch the live attempt",
    );
  });
});

test("force restarts a stalled attempt, because the operator asked to start over", async () => {
  await withStub({ state: "connecting" }, async (linker, calls) => {
    await linker.link({ name: "ReNile_9", phone: "201026217283", force: true });

    assert.ok(
      calls.some((call) => call.startsWith("POST /instance/restart")),
      "an explicit start-over is the one time a restart is correct",
    );
  });
});

test("an already-connected number is left alone", async () => {
  await withStub({ state: "open" }, async (linker, calls) => {
    const result = await linker.link({ name: "ReNile_9", phone: "201026217283" });

    assert.equal(result.alreadyConnected, true);
    assert.equal(result.pairingCode, null);
    // Restarting or reconnecting a working sender would drop a live session and
    // stop real messages for no reason.
    assert.deepEqual(
      calls.filter((call) => call.startsWith("POST /instance/restart") || call.startsWith("GET /instance/connect/")),
      [],
    );
  });
});


// --- cleaning up abandoned link attempts ---
// A registry entry is written before the phone approves, so a link that fails
// leaves one behind. Evolution deletes the instance on a failed handshake, so the
// entry then names something that does not exist and errors on every probe
// forever. These tests pin down exactly which of those get forgotten.

test("a panel-added channel that never linked is forgotten once Evolution loses it", async () => {
  await withStub({ state: "missing" }, async (linker, calls, pool) => {
    const config = require("../src/config");
    config.channelRegistry.upsert({ name: "abandoned" });
    pool.addChannel({ name: "abandoned", url: config.evolutionUrl, apiKey: "k", purposes: ["otp", "alert"] });

    await pool.probe(pool.byName("abandoned"));

    assert.equal(pool.byName("abandoned"), null, "it must leave rotation");
    assert.equal(config.channelRegistry.has("abandoned"), false, "and must not come back on restart");
  });
});

test("a channel declared in .env is never forgotten, only reported broken", async () => {
  await withStub({ state: "missing" }, async (linker, calls, pool) => {
    // Only .env can remove an env-declared name; forgetting it here would hide a
    // typo the operator needs to see and it would reappear on the next restart.
    const channel = pool.byName("base");
    await pool.probe(channel);

    assert.ok(pool.byName("base"), "it must stay visible");
    assert.equal(pool.byName("base").lastError, "INSTANCE_NOT_FOUND");
  });
});

test("a panel-added channel that HAS connected stays visible when its instance vanishes", async () => {
  await withStub({ state: "missing" }, async (linker, calls, pool) => {
    const config = require("../src/config");
    config.channelRegistry.upsert({ name: "was_working" });
    const channel = pool.addChannel({
      name: "was_working",
      url: config.evolutionUrl,
      apiKey: "k",
      purposes: ["otp", "alert"],
    });
    // It linked successfully at some point: that is a real fault to surface, not
    // an abandoned attempt to tidy away.
    channel.everConnected = true;

    await pool.probe(channel);

    assert.ok(pool.byName("was_working"), "a sender that once worked must not vanish silently");
    assert.equal(pool.byName("was_working").lastError, "INSTANCE_NOT_FOUND");
  });
});

// --- removing a channel declared in .env ---
// This service cannot edit .env, so removing such a name has to be recorded as an
// exception or the removal would be purely cosmetic — the name would reappear on
// the next restart, and a name that no longer exists in Evolution could never be
// cleared from the panel at all.

test("removing an env-declared channel keeps it removed across a restart", async () => {
  await withStub({ state: "missing" }, async (linker, calls, pool) => {
    const config = require("../src/config");
    assert.ok(pool.byName("base"), "precondition: the env channel is present");

    const result = await linker.unlink("base");

    assert.equal(result.removed, true);
    assert.equal(result.suppressed, true, "an env name is suppressed, not forgotten");
    assert.equal(pool.byName("base"), null, "it must leave rotation immediately");
    assert.equal(config.channelRegistry.isSuppressed("base"), true);

    // The decisive part: rebuilding the config the way a restart would must not
    // bring it back, even though .env still names it.
    const rebuilt = config.channelRegistry;
    assert.equal(rebuilt.isSuppressed("base"), true);
  });
});

test("a suppressed env channel is filtered out at boot", async () => {
  const registryFile = path.join(
    (tempDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "otp-link-"))),
    `sup-${Math.floor(Math.random() * 1e9)}.json`,
  );
  fs.writeFileSync(registryFile, JSON.stringify({ version: 1, channels: [], suppressed: ["gone"] }));

  for (const key of Object.keys(require.cache)) {
    if (key.includes("renile_evolution_otp/src")) delete require.cache[key];
  }
  Object.assign(process.env, {
    WHATSAPP_REGISTRY_FILE: registryFile,
    WHATSAPP_ASSIGNMENTS_FILE: path.join(tempDir, `a2-${Math.floor(Math.random() * 1e9)}.json`),
    EVOLUTION_URL: "http://127.0.0.1:8080",
    API_KEY: "k",
    JWT_SECRET: "s",
    LOG_LEVEL: "silent",
    WHATSAPP_CHANNELS: "gone,kept",
    INSTANCE_NAME: "",
  });

  const config = require("../src/config");
  assert.deepEqual(
    config.channels.map((channel) => channel.name),
    ["kept"],
    "the suppressed name must not be rebuilt from .env",
  );
});

test("linking a previously removed env name un-suppresses it", async () => {
  await withStub({ state: "missing" }, async (linker, calls, pool) => {
    const config = require("../src/config");
    await linker.unlink("base");
    assert.equal(config.channelRegistry.isSuppressed("base"), true);

    // Otherwise the link would report success and then be filtered straight back
    // out at boot — the most confusing possible outcome.
    await linker.link({ name: "base", phone: "201026217283" });

    assert.equal(config.channelRegistry.isSuppressed("base"), false);
    assert.ok(pool.byName("base"), "it must be back in rotation");
  });
});
