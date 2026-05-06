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
    return true;
  } catch (error) {
    logger.error({ error: error.response?.data || error.message }, "[Evolution API Error]");
    return false;
  }
};
