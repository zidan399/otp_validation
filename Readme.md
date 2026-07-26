# ReNile OTP — WhatsApp Gateway

Sends Nojo's login codes and farm alerts over WhatsApp through the Evolution API.
Built with Node.js and Express.

Every outbound WhatsApp message in the platform leaves through this service, so
it is also where sender rotation and rate limiting live.

## 🚀 Features

- **OTP delivery** — 6-digit codes from `crypto.randomInt`, sent in English + Arabic.
- **Multi-number sending** — spreads traffic over several WhatsApp numbers so no
  single number looks bursty enough to get banned. See below.
- **Automatic failover** — a message whose number fails is retried on a different
  number instead of being lost.
- **Self-healing** — a number that fails repeatedly is rested; connection state is
  re-checked continuously and a reconnected number returns to service.
- **Brute-force protection** — progressive blocks on repeated wrong codes.
- **Request limiting** — progressive blocks on repeated code requests.
- **Secure comparison** — `crypto.timingSafeEqual`, so codes can't be guessed by timing.
- **Observability** — `/health` and `/api/channels` report every number's state.

## 📡 Multi-channel sending

WhatsApp bans an unofficial (WhatsApp Web) sender for hours when its traffic
looks bursty or repetitive. The fix is to stop sending everything from one
number: list every connected Evolution instance and the service routes each
message to the healthiest, least-recently-used one.

```env
WHATSAPP_CHANNELS=ReNile_service,ReNile_2,ReNile_3,ReNile_4,ReNile_5
```

With five numbers each one sends at a fifth of the rate, and one number going
down no longer stops logins. The minimum gap is enforced **per number**, so N
numbers sustain N times the throughput while each stays as calm as it was.

### One farmer, one number

The rotation is across *farmers*, not across each farmer's messages. A farmer is
assigned one sender number on first contact and keeps it — hearing the same kind
of message from several numbers reads as a scam to the farmer and as a spam ring
to WhatsApp, and reports are the fastest route to a ban.

New farmers go to the number carrying the fewest of them, so five farmers over
three numbers land **2 / 2 / 1** rather than all on whichever number was free.

A farmer is moved to another number only when theirs genuinely cannot deliver —
disconnected, resting after repeated failures, or over its daily cap. If it is
merely *busy*, the message waits out the quiet gap instead of switching sender.
Once moved, they stay moved; they don't flap back when the old number recovers.

The map is stored at `WHATSAPP_ASSIGNMENTS_FILE` so a restart doesn't silently
reassign everyone, and `GET /api/channels` reports how many farmers each number
carries.

### Reserving numbers by purpose

Optionally reserve numbers so a flood of farm alerts can never delay a login:

```env
WHATSAPP_OTP_CHANNELS=ReNile_service
WHATSAPP_ALERT_CHANNELS=ReNile_2,ReNile_3,ReNile_4,ReNile_5
```

**This trades away the one-number-per-farmer guarantee** — a farmer necessarily
gets codes from the login number and alerts from an alert number. Leave both
unset unless you want that trade; the service warns at boot if they are set.

### Adding a number

**From the Nojo admin panel → WhatsApp Senders.** This is the normal path and it
works from anywhere: the browser calls the backend, which calls this service,
which calls Evolution. That indirection is the whole point — Evolution and this
service usually listen on a private address that a laptop outside the network
cannot reach, so without it adding a number would need a shell on that machine.

The page shows every sender's connection state, how many farmers it carries, its
volume and its last error; lets you link, log out and remove numbers; and lists
instances that exist in Evolution but carry no traffic so they can be adopted.

**From a shell on this machine**, for first-time setup (when there may be no
sender to manage the panel with yet) or for recovery:

```bash
node scripts/link-channels.js ReNile_2=201234567890 ReNile_3=201234567891
node scripts/link-channels.js --status
node scripts/link-channels.js --remove ReNile_2
node scripts/link-channels.js --adopt ReNile_3     # already exists in Evolution
```

Both paths call `src/services/channelLinker.js`, so they behave identically.

A **pairing code** is an 8-character code you type into the phone under
*Linked devices → Link a device → Link with phone number instead*. It replaces
scanning a QR, so you can read the code to whoever holds the SIM over a call
instead of needing the handset in front of you.

A linked number **joins rotation immediately** — it is recorded in
`WHATSAPP_REGISTRY_FILE` and unioned with `WHATSAPP_CHANNELS` at boot, so there
is no `.env` edit and no restart. A name in `WHATSAPP_CHANNELS` always wins on a
collision, so env stays the place to pin a channel's URL, key or purposes; those
channels are marked as coming from the service config in the panel and cannot be
deleted there, since they would reappear on the next restart.

> **Do not request a second pairing code while the phone shows "Logging in…".**
> Issuing one restarts the instance, and restarting mid-handshake makes the phone
> report *"Couldn't link device"* — which looks like a rejected code but is really
> the server pulling the rug. Wait it out; retry only after it has clearly failed.

**The phone is needed exactly once, for about a minute, per number.** WhatsApp
requires the phone to authorize a linked device — it holds the account's identity
keys, and nothing server-side can substitute for that. After the approval it is
never needed again: the session is stored in Evolution's `Session` table, survives
restarts, and reconnects itself after anything short of a real logout or ban.

The only sender type that needs no phone at all is an official Cloud API instance
(`integration: "WHATSAPP-BUSINESS"`), where the identity is a Meta token rather
than a phone-held key. Those can be mixed into `WHATSAPP_CHANNELS_JSON` alongside
Baileys numbers — this service sends to both through the same endpoint and cannot
tell them apart.

A new number is trusted less by WhatsApp than an established one, so warm it up
with `WHATSAPP_CHANNEL_DAILY_CAP` for the first days rather than letting it take
a full share of traffic immediately.

## 🛠 Prerequisites

A running **Evolution API** with at least one connected instance.

## 📦 Installation

```bash
npm install
cp .env.example .env   # then fill in EVOLUTION_URL, API_KEY, JWT_SECRET, WHATSAPP_CHANNELS
npm start
```

`.env.example` documents every variable. The only required ones are
`EVOLUTION_URL`, `API_KEY`, `JWT_SECRET`, and either `WHATSAPP_CHANNELS` or
`INSTANCE_NAME`.

## 🚦 Usage

```bash
npm start     # production
npm run dev   # watch mode
npm test      # channel routing tests
```

### Endpoints

All POST endpoints take a service-to-service JWT signed with `JWT_SECRET`; the
phone number travels inside the token rather than in the body.

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/api/login` | `{ token }` | Issue and send an OTP |
| POST | `/api/verify` | `{ token, code }` | Verify a code, return a 30-day JWT |
| POST | `/api/notify` | `{ token, message }` | Send an arbitrary message |
| POST | `/api/notify-block` | `{ token, durationMinutes, reason }` | Send a block notice |
| GET | `/health` | — | Liveness + usable number count |

### Channel administration

Separate from the OTP routes above and guarded differently: a bearer token in the
`Authorization` header, signed with the same shared secret but carrying
`scope: "channel-admin"`. The scope claim is load-bearing — without it any
farmer's login token, signed with that same secret, would open sender management.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/channels` | Per-number health, volume, last error, plus unused Evolution instances |
| POST | `/api/channels/link` | Create a sender and return one pairing code |
| POST | `/api/channels/adopt` | Bring an existing Evolution instance into rotation |
| GET | `/api/channels/:name` | Live connection state, for polling after a code is entered |
| POST | `/api/channels/:name/logout` | End the session, keep the sender configured |
| DELETE | `/api/channels/:name` | Remove the sender and delete it from Evolution |

`/api/channels` is behind the guard because it names every sender and its last
error, which is reconnaissance for anyone probing the service. Reach these through
the backend at `/api/admin/whatsapp/channels`, which mints the scoped token and
audit-logs every mutation against the acting admin.

Token claims: `phone` (required), plus optional `messageHeader`, `maxRequests`,
`maxAttempts`, `maxAttemptsIp`, `blockDurations`, `otpExpiryMinutes`, `clientIp`.
Nojo_back sends the security policy in the token so the two services cannot
drift apart.

Response codes worth knowing:

| Code | Meaning |
|---|---|
| 400 | Bad request, or the recipient is not on WhatsApp |
| 403 | Phone or IP is blocked |
| 502 | Every attempted number failed to deliver |
| 503 | Every number is down or saturated |

Nojo_back's circuit breaker reads these: 5xx means the WhatsApp session looks
unhealthy, 4xx means the request itself was wrong.

## 📂 Project structure

```
server.js                        routes, store cleanup, channel monitor
src/config.js                    env parsing and validation
src/controllers/                 OTP issue and verify, channel administration
src/services/channelPool.js      which number sends this message
src/services/channelLinker.js    create, link and remove senders (shared with the CLI)
src/services/channelRegistry.js  senders added at runtime, on disk
src/services/whatsappService.js  one send, with failover
src/helpers/                     sanitizer, security, logger, admin auth
scripts/link-channels.js         CLI equivalent of the admin panel's page
test/                            channel routing and administration tests
```

## 🛡 Security notes

- **In-memory store.** OTPs and blocks are lost on restart, and two replicas of
  this service would each keep their own. Redis is needed to run more than one.
  Channel routing is unaffected — it holds no per-user state.
- **IP limits need a forwarded IP.** Every request arrives from Nojo_back, so
  `req.ip` is the backend's address for all users at once. IP rules therefore
  apply only when the caller passes the real client IP (`clientIp` in the token
  or an `X-Client-Ip` header); otherwise they are skipped rather than applied to
  the shared proxy address.
- **Progressive blocks.** Each successive block is longer, up to the last step in
  `blockDurations`.
- Codes come from `crypto.randomInt`, not `Math.random`.
- Phone numbers are masked in logs.

---
Built for ReNile.
