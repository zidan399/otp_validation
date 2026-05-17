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
    const errorMsg = (errorData?.message || errorData?.error || error.message || "").toLowerCase();
    
    console.error(`[Evolution API Error] Details:`, {
      status: error.response?.status,
      message: errorMsg,
      data: errorData
    });

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
    if (error.response?.status === 404 || notOnWhatsApp.some(p => errorMsg.includes(p))) {
      return { success: false, error: "NOT_ON_WHATSAPP" };
    }
    
    return { success: false, error: "GATEWAY_ERROR" };
  }
};
