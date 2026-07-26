const jwt = require("jsonwebtoken");
const config = require("../config");
const { logger } = require("./logger");

/**
 * Guards the channel-administration routes.
 *
 * These endpoints create and delete WhatsApp senders, so they are the most
 * privileged surface this service has — and it typically listens on a LAN address
 * with nothing else in front of it. So the check is deliberately narrow: a bearer
 * token signed with the secret shared with Nojo_back, carrying an explicit admin
 * scope.
 *
 * The scope claim is what stops an ordinary OTP token from reaching here. Those
 * are minted per login with only a `phone` claim and are signed with the same
 * secret, so without a required scope any farmer's login token would also open
 * instance management.
 */
const ADMIN_SCOPE = "channel-admin";

function requireAdmin(req, res, next) {
  // The same secret the OTP routes verify with (config.otpJwtSecret), because
  // Nojo_back signs both kinds of token with its single OTP_SERVICE_SECRET.
  // Reading JWT_SECRET directly would be identical today but would silently
  // break channel administration the moment OTP_JWT_SECRET is set.
  const secret = config.otpJwtSecret;

  if (!secret || secret === "default_otp_secret") {
    // Refusing beats falling back to a well-known default: with a guessable
    // secret anyone who can reach this port could create WhatsApp senders.
    logger.error("[AdminAuth] No shared secret configured — refusing channel administration");
    return res.status(503).json({ success: false, error: "Service is not configured for administration." });
  }

  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");

  if (!token || scheme.toLowerCase() !== "bearer") {
    return res.status(401).json({ success: false, error: "Missing bearer token." });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch (error) {
    logger.warn({ error: error.message }, "[AdminAuth] Rejected token");
    return res.status(401).json({ success: false, error: "Invalid or expired token." });
  }

  if (decoded?.scope !== ADMIN_SCOPE) {
    // Most likely an OTP token being replayed against an admin route.
    logger.warn({ scope: decoded?.scope ?? null }, "[AdminAuth] Token lacks the channel-admin scope");
    return res.status(403).json({ success: false, error: "Token is not permitted to manage channels." });
  }

  req.admin = { actor: decoded.actor || null };
  return next();
}

module.exports = { requireAdmin, ADMIN_SCOPE };
