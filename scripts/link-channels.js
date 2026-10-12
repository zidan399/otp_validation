#!/usr/bin/env node
/**
 * Command-line equivalent of the admin panel's Instances page: creates and links
 * WhatsApp sender numbers without touching the Evolution manager UI.
 *
 * Prefer the admin panel — it works from anywhere, whereas this needs a shell on
 * the machine running Evolution. This exists for first-time setup, when there may
 * not be a linked number yet, and for recovery when the panel can't reach the
 * service.
 *
 * Both paths call src/services/channelLinker.js, so they behave identically. A
 * number linked here is registered and picked up by the service without an .env
 * edit or a restart.
 *
 * Usage:
 *   node scripts/link-channels.js ReNile_2=201234567890    # create + pairing code
 *   node scripts/link-channels.js ReNile_2=2012... ReNile_3=2011...
 *   node scripts/link-channels.js --status                 # what is linked
 *   node scripts/link-channels.js --remove ReNile_2        # unlink and delete
 *   node scripts/link-channels.js --force ReNile_2=2012...  # abandon a stuck attempt
 */

const config = require("../src/config");
const linker = require("../src/services/channelLinker");

const POLL_INTERVAL_MS = 3000;
// Generous on purpose: entering the code takes a moment, and the handshake that
// follows ("Logging in...") can take another minute. Cutting this short is worse
// than waiting, because the only way to retry is a restart that would abort a
// handshake already in progress.
const POLL_ATTEMPTS = 80; // ~4 minutes

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilOpen(name) {
  const startedAt = Date.now();

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);

    let state;
    try {
      state = await linker.stateOf(name);
    } catch {
      // A transient Evolution blip must not abandon a handshake in progress.
      state = "unknown";
    }
    if (state === "open") return true;

    // A time marker every 30s, so a long handshake doesn't look like a hang.
    process.stdout.write(attempt % 10 === 9 ? ` ${Math.round((Date.now() - startedAt) / 1000)}s ` : ".");
  }
  return false;
}

async function reportStatus() {
  console.log(`\nEvolution API: ${config.evolutionUrl}\n`);

  const status = await linker.listAll();

  for (const channel of status.channels) {
    const mark =
      channel.connected === true
        ? "OK      "
        : channel.lastError === "INSTANCE_NOT_FOUND"
          ? "MISSING "
          : "OFFLINE ";
    const origin = channel.managed ? "panel" : ".env";
    console.log(
      `  ${mark} ${channel.name.padEnd(22)} ${origin.padEnd(6)} ${channel.recipients} farmer(s)` +
        `${channel.lastError ? `  last error: ${channel.lastError}` : ""}`,
    );
  }

  if (status.unregistered.length > 0) {
    console.log("\n  Exists in Evolution but not used by this service:");
    for (const item of status.unregistered) {
      console.log(`     ${item.name.padEnd(22)} ${item.state || "unknown"}`);
    }
    console.log("  Adopt one with: node scripts/link-channels.js --adopt <name>");
  }

  console.log();
}

async function linkOne(name, phone, force) {
  let result;
  try {
    result = await linker.link({ name, phone, purposes: null, force });
  } catch (error) {
    if (error.code !== "LINK_IN_PROGRESS") throw error;
    // Restarting would cancel an attempt the phone may be completing right now,
    // so this is never done implicitly.
    console.log(`\n  ${name}: a link attempt is already running.`);
    console.log("  Wait for the phone to finish. If it has clearly failed, start over with:");
    console.log(`     node scripts/link-channels.js --force ${name}=${phone}\n`);
    return false;
  }

  if (result.alreadyConnected) {
    console.log(`  ${name}: already connected — nothing to do`);
    return true;
  }

  if (result.pairingCode) {
    const code = result.pairingCode;
    console.log(`\n  ${name} — pairing code: ${code.slice(0, 4)}-${code.slice(4)}`);
    console.log(`  Enter it on the phone holding ${result.phone}:`);
    console.log("     WhatsApp > Settings > Linked devices > Link a device");
    console.log("     > Link with phone number instead");
  } else {
    console.log(`\n  ${name} — no pairing code returned. Scan the QR instead:`);
    console.log(`     ${config.evolutionUrl}/manager`);
  }

  // Deliberately ONE code per run, with no automatic regeneration. Generating a
  // new code means restarting the instance, and restarting mid-handshake makes
  // the phone report "Couldn't link device" — which looks like a rejected code
  // but is really the server pulling the rug. So wait generously and let the
  // operator re-run this if it genuinely fails.
  process.stdout.write("  waiting for the phone to approve (do not re-run this script meanwhile)");
  const linked = await waitUntilOpen(name);

  if (linked) {
    console.log(`\n  ${name}: CONNECTED — now in rotation, no restart needed\n`);
    return true;
  }

  console.log(`\n  ${name}: not linked yet.`);
  console.log("  If the phone showed 'Logging in...' it may still finish — check:");
  console.log("     node scripts/link-channels.js --status");
  console.log("  To try a fresh code, re-run this script. If it keeps failing, scan the QR at");
  console.log(`     ${config.evolutionUrl}/manager`);
  console.log("  (QR is less sensitive to the WhatsApp Web version than pairing codes are.)\n");
  return false;
}

async function main() {
  if (!config.evolutionUrl || !config.evolutionApiKey) {
    console.error("EVOLUTION_URL and API_KEY must be set in .env");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));

  if (flags.includes("--status") || args.length === 0) return reportStatus();

  if (flags.includes("--remove")) {
    for (const name of positional) {
      const result = await linker.unlink(name);
      console.log(`  ${name}: removed${result.evolutionDeleted ? " and deleted from Evolution" : " (locally only)"}`);
    }
    return reportStatus();
  }

  if (flags.includes("--adopt")) {
    for (const name of positional) {
      const result = await linker.adopt({ name, purposes: null });
      console.log(`  ${name}: adopted (state: ${result.state})`);
    }
    return reportStatus();
  }

  const targets = positional.map((arg) => {
    const [name, phone] = arg.split("=");
    return { name, phone };
  });

  const missingPhone = targets.find((target) => !target.phone);
  if (missingPhone) {
    console.error(
      `\n'${missingPhone.name}' has no phone number. A pairing code is bound to a specific number, so use:\n` +
        `  node scripts/link-channels.js ${missingPhone.name}=201234567890\n`,
    );
    process.exit(1);
  }

  console.log(`\nEvolution API: ${config.evolutionUrl}`);
  console.log(`Linking ${targets.length} channel(s)\n`);

  for (const { name, phone } of targets) {
    await linkOne(name, phone, flags.includes("--force"));
  }

  return reportStatus();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nFailed: ${error.message}\n`);
    process.exit(1);
  });
