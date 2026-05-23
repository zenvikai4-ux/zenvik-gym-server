require('dotenv').config();
const express = require('express');
const { startAllCrons } = require('./cron');
const { sendTemplateMessage } = require('./cron');
const supabase = require('./supabase');
const { insertMemberNotification, getGymWhatsAppConfig } = require('./notifications');

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
    triggers: ['diet_on_assignment'],
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
              { type: 'text', text: memberName },  // {{1}} member name
              { type: 'text', text: gym.name },     // {{2}} gym name
              { type: 'text', text: dietContent },  // {{3}} actual diet
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
 * Sends the actual diet content to the member via WhatsApp utility template.
 *
 * Body: { client_profile_id, gym_id }
 */
app.post('/diet/assigned', async (req, res) => {
  const { client_profile_id, gym_id } = req.body;
  if (!client_profile_id || !gym_id) {
    return res.status(400).json({ error: 'client_profile_id and gym_id are required' });
  }

  res.json({ message: 'Diet assignment notification triggered' });

  try {
    // Get member info via client_profile
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

    // Get today's diet plans for this member
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

    // Build diet content — today's meals if available, else full week
    const grouped = {};
    for (const p of plans) {
      if (!grouped[p.day_of_week]) grouped[p.day_of_week] = [];
      grouped[p.day_of_week].push(`• ${p.meal_slot}: ${p.items}`);
    }

    let dietContent = '';
    if (grouped[todayIdx]) {
      dietContent = `${DAY_NAMES[todayIdx]}:\n${grouped[todayIdx].join('\n')}`;
    } else {
      // Show full week
      dietContent = Object.entries(grouped)
        .map(([day, meals]) => `${DAY_NAMES[Number(day)]}: ${meals.join(', ')}`)
        .join('\n');
    }

    // Get gym WA config
    const gym = await getGymWhatsAppConfig(gym_id);
    if (!gym) {
      console.warn(`⚠️ No gym WA config for ${gym_id}`);
      return;
    }

    // Send via utility template
    await sendDietTemplate(gym, member.phone, member.name, dietContent);

    // In-app notification with actual diet content
    await insertMemberNotification(
      gym_id, member.id,
      '🥗 Your Diet Plan',
      dietContent,
      'diet'
    );

    // Update wa_sent_at
    await supabase
      .from('diet_plans')
      .update({ wa_sent_at: new Date().toISOString() })
      .eq('client_profile_id', client_profile_id);

    console.log(`✅ Diet WA sent to ${member.name} (${member.phone})`);
  } catch (err) {
    console.error('Diet assignment endpoint error:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 GymApp Cron Server running on port ${PORT}`);
  startAllCrons();
});
