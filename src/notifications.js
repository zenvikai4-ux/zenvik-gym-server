const supabase = require('./supabase');
const { sendWhatsAppMessage } = require('./whatsapp');

// The gym's dedicated WhatsApp number phone ID
// This is used as fallback for gyms that don't have their own number configured
const GYM_PHONE_ID = process.env.GYM_PHONE_ID || '1051544281382053';
const GYM_WA_TOKEN = process.env.GYM_WA_TOKEN || process.env.ZENVIK_WA_TOKEN;

/**
 * Insert in-app notification for a member
 */
async function insertMemberNotification(gymId, memberId, title, body, type = 'general') {
  const { error } = await supabase.from('notifications').insert({
    gym_id: gymId,
    member_id: memberId,
    title,
    body,
    type,
    is_read: false,
  });
  if (error) console.error('Notification insert failed:', error.message);
}

/**
 * Insert in-app notification for gym owner
 */
async function insertOwnerNotification(gymId, title, body, type = 'general') {
  const { error } = await supabase.from('notifications').insert({
    gym_id: gymId,
    title,
    body,
    type,
    is_read: false,
  });
  if (error) console.error('Owner notification insert failed:', error.message);
}

/**
 * Get gym's WhatsApp config.
 * Uses gym's own credentials if configured, otherwise falls back to the
 * central gym WhatsApp number (GYM_PHONE_ID / GYM_WA_TOKEN env vars).
 * NOTE: GYM_PHONE_ID is the gym number (9059...), NOT the Zenvik website number.
 */
async function getGymWhatsAppConfig(gymId) {
  const { data: gym } = await supabase
    .from('gyms')
    .select('name, whatsapp_number, whatsapp_phone_id, whatsapp_token, instagram_handle, auto_reply_message')
    .eq('id', gymId)
    .single();

  if (!gym) return null;

  return {
    ...gym,
    whatsapp_phone_id: gym.whatsapp_phone_id || GYM_PHONE_ID,
    whatsapp_token: gym.whatsapp_token || GYM_WA_TOKEN,
  };
}

/**
 * Send WhatsApp to member using gym's number
 */
async function sendMemberWhatsApp(gym, memberPhone, message) {
  if (!gym?.whatsapp_phone_id || !gym?.whatsapp_token || !memberPhone) return;
  const phone = memberPhone.replace(/[^0-9]/g, '');
  if (phone.length < 10) return;
  const formatted = phone.startsWith('91') ? phone : `91${phone}`;
  await sendWhatsAppMessage(gym.whatsapp_phone_id, gym.whatsapp_token, formatted, message);
}

module.exports = { insertMemberNotification, insertOwnerNotification, getGymWhatsAppConfig, sendMemberWhatsApp };
