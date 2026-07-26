# renile_evolution_otp

WhatsApp OTP and notification gateway for Nojo. Every outbound WhatsApp message
in the platform leaves through this service, so it is also where sender rotation
and per-number rate limiting live. Requires a running Evolution API.

## Commands

```bash
npm start       # node server.js
npm run dev     # node --watch server.js
npm test        # node --test test/
```

## Architecture

- **Plain JS Express 5** (`"type": "commonjs"`), no TypeScript
- **Entry**: `server.js` — routes, in-memory store cleanup, channel monitor
- **`src/config.js`** — all env parsing and validation, once at boot. Throws on a
  misconfigured channel rather than failing on the first send.
- **`src/services/channelPool.js`** — picks which WhatsApp number sends each
  message; tracks per-number health, pacing and daily volume
- **`src/services/channelAssignments.js`** — the farmer-to-number map, kept on
  disk so restarts don't reassign everyone
- **`src/services/whatsappService.js`** — one send, failing over to another number
  when the chosen one fails
- **`src/controllers/authController.js`** — OTP generation, verification, blocks
- **`src/helpers/`** — phone sanitization, constant-time compare, logger, responses

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/login` | Issue and send an OTP |
| POST | `/api/verify` | Verify an OTP, return a 30-day JWT |
| POST | `/api/notify` | Send an arbitrary message (farm alerts) |
| POST | `/api/notify-block` | Send a security-block notice |
| GET | `/health` | Liveness + how many numbers are usable |
| GET | `/api/channels` | Per-number health, volume and last error |

The POST endpoints authenticate with a service-to-service JWT signed by
Nojo_back with the shared secret; the phone number travels inside the token.

## Multi-channel sending

Sending everything from one number is what gets it banned for hours — WhatsApp
scores an unofficial (WhatsApp Web) session on how bursty and repetitive its
traffic looks. `WHATSAPP_CHANNELS` lists every connected Evolution instance and
the pool spreads traffic across all of them.

The minimum gap is enforced **per number**, not globally, so N numbers sustain N
times the throughput while each individual number stays as calm as before.

**Rotation is across farmers, not across a farmer's messages.** Each farmer is
assigned one sender number and keeps it (`channelAssignments.js`, persisted to
disk). A farmer hearing the same kind of message from several numbers reads as a
scam and gets numbers reported, which is the fastest route to a ban. New farmers
go to the number carrying the fewest, so load stays balanced (5 farmers over 3
numbers → 2/2/1).

A farmer is migrated only when their number is *unusable* — disconnected,
resting, or over its daily cap. A merely **busy** number is still theirs and the
message waits for it (`isUsable()` deliberately excludes busyness). A retry after
a send failure migrates the farmer rather than borrowing another number for one
message, so the invariant holds even on the failure path.

`WHATSAPP_OTP_CHANNELS` / `WHATSAPP_ALERT_CHANNELS` reserve numbers per purpose.
This guarantees an alert flood can't delay a login, but it necessarily gives a
farmer two senders, so the assignment key includes the purpose
(`config.purposeReservations`). The service warns at boot when both are in play.

## Key constraints

- **In-memory store** — OTPs and blocks reset on restart, and two copies of this
  service would each keep their own. Needs Redis to run more than one replica.
  Channel routing is unaffected (it holds no per-user state).
- **`req.ip` is useless here.** Every request arrives from Nojo_back, so `req.ip`
  is the backend's address for all users at once. IP limits therefore apply only
  when the caller forwards a real client IP (`clientIp` in the token, or an
  `X-Client-Ip` header). Do not "fix" this by falling back to `req.ip` — twenty
  wrong codes from twenty farmers would then block the twenty-first.
- **Failure reporting is load-bearing.** Nojo_back's circuit breaker reads the
  HTTP status: 5xx means the WhatsApp session looks unhealthy, 4xx means the
  request was wrong. Never return 200 for a send that did not happen.
- Security policy (attempt limits, block durations, OTP expiry) is owned by
  Nojo_back and arrives in the token. Values here are fallbacks for old tokens.
- Phone sanitization handles Egyptian formats (`sanitizePhone`)
- OTP comparison uses `crypto.timingSafeEqual`; codes come from `crypto.randomInt`
- Messages are sent in English + Arabic
- Log phone numbers only through `maskPhone`

## Relationship to Nojo_back

Nojo_back has its own Redis-backed pacer (`src/shared/whatsapp/`) in front of
this service, which batches farm alerts and gives logins priority. That pacer's
`WHATSAPP_MIN_GAP_MS` is **global** — it does not know how many numbers exist
here — so with N channels configured it becomes the bottleneck unless it is
lowered to roughly `WHATSAPP_CHANNEL_MIN_GAP_MS / N`.
