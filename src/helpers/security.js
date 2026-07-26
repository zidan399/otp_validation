const crypto = require("crypto");

/**
 * Six-digit login code. Uses crypto.randomInt rather than Math.random: this
 * value is the only thing between a phone number and an account, and
 * Math.random is predictable from earlier outputs.
 */
exports.generateOTP = () => crypto.randomInt(100000, 1000000).toString();

exports.isSecureEqual = (userInput, storedCode) => {
  if (!userInput || !storedCode || userInput.length !== storedCode.length)
    return false;
  return crypto.timingSafeEqual(
    Buffer.from(userInput),
    Buffer.from(storedCode),
  );
};
