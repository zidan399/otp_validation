const rateLimit = require("express-rate-limit");
const { sendError } = require("../helpers/response");

const WINDOW_MINUTES = process.env.RATE_LIMIT_WINDOW_MINUTES || 15;

exports.ipRateLimiter = rateLimit({
  windowMs: WINDOW_MINUTES * 60 * 1000,
  max: 20,
  handler: (req, res) =>
    sendError(res, 429, `Too many requests. Please wait ${WINDOW_MINUTES} minutes.`),
  standardHeaders: true,
  legacyHeaders: false,
});
