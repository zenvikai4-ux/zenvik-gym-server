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
 * POST /diet/assigned
 * Called from the app when a trainer saves/updates a diet plan.
 * Sends a WhatsApp message to the member with their new diet plan.
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

    // Get all diet plans for this member grouped by day
    const { data: plans } = await supabase
      .from('diet_plans')
      .select('day_of_week, meal_slot, items')
      .eq('client_profile_id', client_profile_id)
      .order('day_of_week')
      .order('meal_slot');

    if (!plans?.length) {
      console.warn(`⚠️ No diet plans found for ${member.name}`);
      return;
    }

    // Build a summary of the diet plan
    const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // Group by day
    const grouped: Record<number, string[]> = {};
    for (const p of plans) {
      if (!grouped[p.day_of_week]) grouped[p.day_of_week] = [];
      grouped[p.day_of_week].push(`${p.meal_slot}: ${p.items}`);
    }

    // Build message — show today's plan if exists, else show full week summary
    const todayIdx = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
    let dietMsg = '';

    if (grouped[todayIdx]) {
      dietMsg = `Hi ${member.name}! Your trainer has updated your diet plan 🥗\n\nToday (${DAY_NAMES[todayIdx]}):\n${grouped[todayIdx].join(', ')}\n\nStay consistent and keep pushing! 💪`;
    } else {
      const weekSummary = Object.entries(grouped)
        .map(([day, meals]) => `${DAY_NAMES[Number(day)]}: ${meals.join(', ')}`)
        .join(' | ');
      dietMsg = `Hi ${member.name}! Your trainer has assigned your diet plan 🥗\n\n${weekSummary}\n\nStay consistent and keep pushing! 💪`;
    }

    // Get gym WA config
    const gym = await getGymWhatsAppConfig(gym_id);
    if (!gym) {
      console.warn(`⚠️ No gym WA config for ${gym_id}`);
      return;
    }

    // Send WhatsApp
    await sendTemplateMessage(gym, member.phone, member.name, dietMsg);

    // Insert in-app notification
    await insertMemberNotification(
      gym_id, member.id,
      '🥗 Diet Plan Updated',
      `Your trainer has updated your diet plan. Check the Diet section in your app.`,
      'diet'
    );

    // Update wa_sent_at on diet_plans for this member
    await supabase
      .from('diet_plans')
      .update({ wa_sent_at: new Date().toISOString() })
      .eq('client_profile_id', client_profile_id);

    console.log(`✅ Diet assignment WA sent to ${member.name} (${member.phone})`);
  } catch (err: any) {
    console.error('Diet assignment endpoint error:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 GymApp Cron Server running on port ${PORT}`);
  startAllCrons();
});
