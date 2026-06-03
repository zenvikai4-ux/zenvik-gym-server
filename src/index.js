require('dotenv').config();
const express = require('express');
const { startAllCrons } = require('./cron');
const { sendTemplateMessage } = require('./cron');
const supabase = require('./supabase');
const { insertMemberNotification, getGymWhatsAppConfig } = require('./notifications');
const { sendPushToGym, sendPushToMember } = require('./push');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Zenvik AI GymApp Cron Server',
    timestamp: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    jobs: ['member_expiry_9am', 'owner_subscription_9am'],
    triggers: ['diet_on_assignment', 'member_welcome', 'send_message'],
  });
});

// Manual trigger for testing
app.post('/trigger/member-reminders', async (req, res) => {
  const { runMemberExpiryReminders } = require('./cron');
  res.json({ message: 'Member reminder check triggered — check logs' });
  runMemberExpiryReminders();
});

/**
 * Send diet plan using utility template
 * Template: member_diet_plan
 * {{1}} = member name, {{2}} = gym name, {{3}} = diet content
 */
async function sendDietTemplate(gym, phone, memberName, dietContent) {
  if (!gym?.whatsapp_phone_id || !gym?.whatsapp_token) {
    console.warn(`⚠️ No WA credentials for gym ${gym?.name}`);
    return false;
  }
  try {
    let e164 = phone.replace(/[\s\-()]/g, '');
    if (!e164.startsWith('+')) e164 = '+91' + e164.replace(/^0/, '');
    e164 = e164.replace('+', '');

    const r = await fetch(`https://graph.facebook.com/v19.0/${gym.whatsapp_phone_id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${gym.whatsapp_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: e164,
        type: 'template',
        template: {
          name: 'member_diet_plan',
          language: { code: 'en' },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: memberName },
              { type: 'text', text: gym.name },
              { type: 'text', text: dietContent },
            ]
          }]
        }
      })
    });
    const d = await r.json();
    if (r.ok) { console.log(`✅ Diet WA sent to ${phone}`); return true; }
    else { console.error(`❌ Diet WA failed to ${phone}:`, d.error?.message); return false; }
  } catch (err) {
    console.error('sendDietTemplate error:', err.message);
    return false;
  }
}

/**
 * POST /diet/assigned
 * Called from the app when a trainer saves/updates a diet plan.
 */
app.post('/diet/assigned', async (req, res) => {
  const { client_profile_id, gym_id } = req.body;
  if (!client_profile_id || !gym_id) {
    return res.status(400).json({ error: 'client_profile_id and gym_id are required' });
  }

  res.json({ message: 'Diet assignment notification triggered' });

  try {
    const { data: cp } = await supabase
      .from('client_profiles')
      .select('id, gym_id, member:members(id, name, phone)')
      .eq('id', client_profile_id)
      .single();

    if (!cp?.member?.phone) {
      console.warn(`⚠️ No member phone for client_profile ${client_profile_id}`);
      return;
    }

    const member = cp.member;
    const todayIdx = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
    const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const { data: plans } = await supabase
      .from('diet_plans')
      .select('day_of_week, meal_slot, items')
      .eq('client_profile_id', client_profile_id)
      .order('meal_slot');

    if (!plans?.length) {
      console.warn(`⚠️ No diet plans found for ${member.name}`);
      return;
    }

    const grouped = {};
    for (const p of plans) {
      if (!grouped[p.day_of_week]) grouped[p.day_of_week] = [];
      grouped[p.day_of_week].push(`${p.meal_slot}: ${p.items}`);
    }

    let dietContent = '';
    if (grouped[todayIdx]) {
      dietContent = grouped[todayIdx].join('\n');
    } else {
      dietContent = Object.entries(grouped)
        .map(([day, meals]) => `${DAY_NAMES[Number(day)]}:\n${meals.join('\n')}`)
        .join('\n\n');
    }

    const [gym, automationConfig] = await Promise.all([
      getGymWhatsAppConfig(gym_id),
      supabase.from('gym_automation_config').select('diet_messages_enabled').eq('gym_id', gym_id).single().then(r => r.data),
    ]);

    // Always send in-app notification
    await insertMemberNotification(gym_id, member.id, '🥗 Your Diet Plan', dietContent, 'diet');

    // Send push notification to member
    await sendPushToMember(member.id, '🥗 Diet Plan Updated', `Your trainer has updated your diet plan`).catch(() => {});

    // Send WhatsApp only if diet_messages_enabled
    if (gym && automationConfig?.diet_messages_enabled !== false) {
      await sendDietTemplate(gym, member.phone, member.name, dietContent);
    } else if (!gym) {
      console.warn(`⚠️ No gym WA config for ${gym_id} — skipping WhatsApp`);
    } else {
      console.log(`ℹ️ Diet WhatsApp disabled for gym ${gym_id} — in-app only`);
    }

    await supabase
      .from('diet_plans')
      .update({ wa_sent_at: new Date().toISOString() })
      .eq('client_profile_id', client_profile_id);

    console.log(`✅ Diet notification sent to ${member.name}`);
  } catch (err) {
    console.error('Diet assignment endpoint error:', err.message);
  }
});

/**
 * POST /member/welcome
 * Called when a new member is added to the gym.
 */
app.post('/member/welcome', async (req, res) => {
  const { member_id, gym_id } = req.body;
  if (!member_id || !gym_id) {
    return res.status(400).json({ error: 'member_id and gym_id are required' });
  }
  res.json({ message: 'Welcome message triggered' });

  try {
    const { data: member } = await supabase
      .from('members')
      .select('id, name, phone, plan, expiry_date')
      .eq('id', member_id)
      .single();

    if (!member?.phone) {
      console.warn(`⚠️ No phone for member ${member_id}`);
      return;
    }

    const gym = await getGymWhatsAppConfig(gym_id);
    if (!gym) {
      console.warn(`⚠️ No gym WA config for ${gym_id}`);
      return;
    }

    const expiryText = member.expiry_date
      ? new Date(member.expiry_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'Not set';

    const welcomeMsg = `Welcome to ${gym.name}, ${member.name}! 🎉\n\nYour membership details:\n• Plan: ${member.plan || 'Standard'}\n• Valid until: ${expiryText}\n\nWe're excited to have you on your fitness journey! 💪`;

    const r = await fetch(`https://graph.facebook.com/v19.0/${gym.whatsapp_phone_id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${gym.whatsapp_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: member.phone.replace(/\D/g, '').length === 10 ? '91' + member.phone.replace(/\D/g, '') : member.phone.replace(/\D/g, ''),
        type: 'text',
        text: { body: welcomeMsg },
      })
    });

    if (r.ok) {
      console.log(`✅ Welcome message sent to ${member.name}`);
    } else {
      const d = await r.json();
      console.error(`❌ Welcome message failed:`, d.error?.message);
    }

    // In-app notification
    await insertMemberNotification(
      gym_id, member.id,
      `🎉 Welcome to ${gym.name}!`,
      `Your ${member.plan || 'Standard'} membership is active until ${expiryText}. Let's get started!`,
      'general'
    );

    // Push notification
    await sendPushToMember(member.id, `🎉 Welcome to ${gym.name}!`, `Your membership is active until ${expiryText}`).catch(() => {});

  } catch (err) {
    console.error('Welcome message error:', err.message);
  }
});

/**
 * POST /send-message
 * Send a WhatsApp message from owner to any phone number (member, trainer, lead)
 * Body: { phone, message, gym_id }
 */
app.post('/send-message', async (req, res) => {
  const { phone, message, gym_id } = req.body;
  if (!phone || !message || !gym_id) {
    return res.status(400).json({ error: 'phone, message and gym_id are required' });
  }

  try {
    const gym = await getGymWhatsAppConfig(gym_id);
    if (!gym) {
      return res.status(404).json({ error: 'Gym WhatsApp not configured' });
    }

    // Format phone to E.164
    let e164 = phone.replace(/[\s\-()]/g, '');
    if (!e164.startsWith('+')) e164 = '+91' + e164.replace(/^0/, '');
    e164 = e164.replace('+', '');

    const r = await fetch(`https://graph.facebook.com/v19.0/${gym.whatsapp_phone_id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gym.whatsapp_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: e164,
        type: 'text',
        text: { body: message },
      }),
    });

    const d = await r.json();
    if (!r.ok) {
      console.error('Send message error:', d.error?.message);
      return res.status(400).json({ error: d.error?.message || 'Failed to send' });
    }

    // Log in direct_messages table
    const tenDigit = phone.replace(/\D/g, '').slice(-10);
    await supabase.from('direct_messages').insert({
      gym_id,
      to_phone: tenDigit,
      message,
      direction: 'outbound',
    }).catch(e => console.warn('direct_messages insert failed:', e.message));

    console.log(`✅ Message sent to ${phone}`);
    res.json({ success: true, message_id: d.messages?.[0]?.id });
  } catch (err) {
    console.error('send-message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 GymApp Cron Server running on port ${PORT}`);
  startAllCrons();
});
