const supabase = require('./supabase');
const { sendWhatsAppMessage } = require('./whatsapp');

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
 * Insert in-app notification for gym owner (via their profile)
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
 * Get gym's WhatsApp config
 * Falls back to central Zenvik credentials if gym doesn't have its own
 */
async function getGymWhatsAppConfig(gymId) {
  const { data: gym } = await supabase
    .from('gyms')
    .select('name, whatsapp_number, whatsapp_phone_id, whatsapp_token, instagram_handle, auto_reply_message')
    .eq('id', gymId)
    .single();

  if (!gym) return null;

  // Fall back to central Zenvik credentials if gym has none
  return {
    ...gym,
    whatsapp_phone_id: gym.whatsapp_phone_id || process.env.ZENVIK_PHONE_ID,
    whatsapp_token: gym.whatsapp_token || process.env.ZENVIK_WA_TOKEN,
  };
}

/**
 * Send WhatsApp to member using gym's number
 */
async function sendMemberWhatsApp(gym, memberPhone, message) {
  if (!gym?.whatsapp_phone_id || !gym?.whatsapp_token || !memberPhone) return;
  // Format phone: remove spaces, +, etc → e.g. 919876543210
  const phone = memberPhone.replace(/[^0-9]/g, '');
  if (phone.length < 10) return;
  const formatted = phone.startsWith('91') ? phone : `91${phone}`;
  await sendWhatsAppMessage(gym.whatsapp_phone_id, gym.whatsapp_token, formatted, message);
}

module.exports = { insertMemberNotification, insertOwnerNotification, getGymWhatsAppConfig, sendMemberWhatsApp };
