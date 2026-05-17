# renile_evolution_otp

WhatsApp OTP authentication service. Requires a running Evolution API instance.

## Commands

```bash
npm start       # node server.js
npm run dev     # node server.js --watch
```

## Architecture

- **Plain JS Express** (`"type": "commonjs"`), no TypeScript
- **Entry**: `server.js`
- **`src/controllers/authController.js`** — OTP generation, validation, block logic
- **`src/services/whatsappService.js`** — Evolution API integration for sending WhatsApp messages
- **`src/middleware/`** — rate limiting
- **`src/helpers/`** — phone sanitization, constant-time comparison, response utils

## Security

| Setting | Value |
|---------|-------|
| Max OTP requests | 3 (then blocked 1h) |
| Max verify attempts | 3 (then blocked 1h) |
| OTP expiry | 5 minutes |
| JWT expiry | 30 days |
| IP rate limit | 20 req / 15 min |

## Key constraints

- **In-memory store** — all OTPs and blocks reset on server restart. Needs Redis for production
- Must be **behind a running Evolution API** — configured via `EVOLUTION_URL`, `API_KEY`, `INSTANCE_NAME`
- Phone sanitization handles Egyptian formats (`sanitizePhone` in helpers)
- OTP comparison uses `crypto.timingSafeEqual` (`isSecureEqual`)
- Messages sent in English + Arabic
