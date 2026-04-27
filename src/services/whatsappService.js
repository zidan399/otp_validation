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
    await axios.post(
      `${process.env.EVOLUTION_URL}/message/sendText/${process.env.INSTANCE_NAME}`,
      payload,
      {
        headers: {
          apikey: process.env.API_KEY,
          "Content-Type": "application/json",
        },
      },
    );
    return true;
  } catch (error) {
    logger.error({ error: error.response?.data || error.message }, "[Evolution API Error]");
    return false;
  }
};
