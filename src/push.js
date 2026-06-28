// ============================================================
// PATCH: push.js — Add to zenvik-gym-server/src/
// Sends Expo push notifications to registered devices
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Send push notification to all users of a gym
 * @param {string} gymId
 * @param {string} title
 * @param {string} body
 * @param {string} role - 'gym_owner', 'member', 'trainer', or null for all
 */
async function sendPushToGym(gymId, title, body, role = null) {
  try {
    let query = supabase
      .from('profiles')
      .select('push_token')
      .eq('gym_id', gymId)
      .not('push_token', 'is', null);

    if (role) query = query.eq('role', role);

    const { data: profiles } = await query;
    if (!profiles?.length) return;

    const tokens = profiles.map(p => p.push_token).filter(Boolean);
    if (!tokens.length) return;

    await sendExpoPush(tokens, title, body);
  } catch (e) {
    console.error('sendPushToGym error:', e.message);
  }
}

/**
 * Send push notification to a specific member
 */
async function sendPushToMember(memberId, title, body) {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('push_token')
      .eq('member_id', memberId)
      .not('push_token', 'is', null)
      .single();

    if (!profile?.push_token) return;
    await sendExpoPush([profile.push_token], title, body);
  } catch (e) {
    console.error('sendPushToMember error:', e.message);
  }
}

/**
 * Send Expo push notifications
 */
async function sendExpoPush(tokens, title, body) {
  const messages = tokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data: {},
  }));

  const r = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(messages),
  });

  if (!r.ok) {
    const d = await r.json();
    console.error('Expo push error:', d);
  } else {
    console.log(`✅ Push sent to ${tokens.length} device(s): ${title}`);
  }
}

module.exports = { sendPushToGym, sendPushToMember, sendExpoPush };
