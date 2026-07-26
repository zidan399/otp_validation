const pino = require("pino");
const config = require("../config");

/**
 * One logger for the whole service. Phone numbers are personal data and end up
 * in log aggregators, so they go through maskPhone() before being logged.
 */
const logger = pino({ level: config.logLevel });

function maskPhone(phone) {
  const value = String(phone || "");
  return value.length > 4 ? `${"*".repeat(value.length - 4)}${value.slice(-4)}` : value;
}

module.exports = { logger, maskPhone };
