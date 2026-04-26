const axios = require('axios');

const META_API = 'https://graph.facebook.com/v18.0';

/**
 * Send a WhatsApp text message
 * @param {string} phoneId - The WhatsApp Phone Number ID to send FROM
 * @param {string} token - Access token for that phone number
 * @param {string} to - Recipient phone number (with country code, no +)
 * @param {string} message - Text message to send
 */
async function sendWhatsAppMessage(phoneId, token, to, message) {
  try {
    const res = await axios.post(
      `${META_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`✅ WA sent to ${to}: ${message.substring(0, 50)}...`);
    return res.data;
  } catch (err) {
    console.error(`❌ WA failed to ${to}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Send template message (for first contact / marketing)
 */
async function sendWhatsAppTemplate(phoneId, token, to, templateName, languageCode = 'en', components = []) {
  try {
    const res = await axios.post(
      `${META_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return res.data;
  } catch (err) {
    console.error(`❌ Template failed:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Mark message as read
 */
async function markAsRead(phoneId, token, messageId) {
  try {
    await axios.post(
      `${META_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // Non-critical, don't throw
  }
}

module.exports = { sendWhatsAppMessage, sendWhatsAppTemplate, markAsRead };
