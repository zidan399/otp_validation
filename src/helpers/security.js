const crypto = require("crypto");

exports.generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

exports.isSecureEqual = (userInput, storedCode) => {
  if (!userInput || !storedCode || userInput.length !== storedCode.length)
    return false;
  return crypto.timingSafeEqual(
    Buffer.from(userInput),
    Buffer.from(storedCode),
  );
};
