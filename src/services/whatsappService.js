require("dotenv").config();
const axios = require("axios");
const pino = require("pino");

const logger = pino({ level: "info" });

exports.sendWhatsAppMessage = async (phone, text) => {
  const payload = {
    number: phone,
    options: { delay: 1200, presence: "composing" },
    text: text,
  };

  try {
    console.log(`[Evolution API] Attempting to send message to ${phone}...`);
    const response = await axios.post(
      `${process.env.EVOLUTION_URL}/message/sendText/${process.env.INSTANCE_NAME}`,
      payload,
      {
        headers: {
          apikey: process.env.API_KEY,
          "Content-Type": "application/json",
        },
      },
    );
    console.log(`[Evolution API] Message sent successfully to ${phone}. ID: ${response.data?.key?.id}`);
    return { success: true };
  } catch (error) {
    const errorData = error.response?.data;
    
    // Convert error message to string safely
    let errorMsg = "";
    const rawMessage = errorData?.response?.message || errorData?.message;
    
    if (typeof rawMessage === "string") {
      errorMsg = rawMessage;
    } else if (rawMessage) {
      errorMsg = JSON.stringify(rawMessage);
    } else {
      errorMsg = errorData?.error || error.message || "";
    }
    errorMsg = errorMsg.toLowerCase();
    
    // Use JSON.stringify(..., null, 2) to see the full content of Arrays in the console
    console.error(`[Evolution API Error] Details:`, JSON.stringify({
      status: error.response?.status,
      message: errorMsg,
      data: errorData
    }, null, 2));

    // Check for explicit 'exists: false' from Evolution API (checking both paths)
    const explicitlyNotOnWA = 
      errorData?.response?.message?.[0]?.exists === false || 
      errorData?.message?.[0]?.exists === false || 
      errorData?.exists === false;

    const notOnWhatsApp = [
      "not on whatsapp",
      "invalid jid",
      "does not exist",
      "not registered",
      "user not found",
      "recipient not found",
      "account not found",
      "number not found",
      "unavailable",
      "disconnected",
      "not connected",
    ];

    if (
      error.response?.status === 404 || 
      explicitlyNotOnWA || 
      notOnWhatsApp.some(p => errorMsg.includes(p))
    ) {
      return { success: false, error: "NOT_ON_WHATSAPP" };
    }
    
    return { success: false, error: "GATEWAY_ERROR" };
  }
};
