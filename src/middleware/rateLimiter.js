const rateLimit = require("express-rate-limit");
const { sendError } = require("../helpers/response");

exports.ipRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  handler: (req, res) =>
    sendError(res, 429, "Too many requests. Please wait 15 minutes."),
  standardHeaders: true,
  legacyHeaders: false,
});
