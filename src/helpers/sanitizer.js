exports.sanitizePhone = (phone) => {
  if (typeof phone !== "string") return null;
  
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, "");

  // Handle Egyptian numbers
  // 1. If it starts with 01... (11 digits), replace 0 with 20
  if (cleaned.length === 11 && cleaned.startsWith("01")) {
    cleaned = "20" + cleaned.substring(1);
  } 
  // 2. If it starts with 2001... (13 digits), it's likely 20 + 01...
  // We should remove the extra 0: 2001... -> 201...
  else if (cleaned.length === 13 && cleaned.startsWith("2001")) {
    cleaned = "20" + cleaned.substring(3);
  }
  // 3. If it's 10 digits starting with 1 (e.g., 1026217283), add 20
  else if (cleaned.length === 10 && /^(10|11|12|15)/.test(cleaned)) {
    cleaned = "20" + cleaned;
  }

  return cleaned.length >= 10 && cleaned.length <= 15 ? cleaned : null;
};
