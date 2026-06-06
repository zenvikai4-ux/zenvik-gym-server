const cron = require('node-cron');
const supabase = require('./supabase');
const { sendWhatsAppMessage } = require('./whatsapp');
const { insertMemberNotification, insertOwnerNotification, getGymWhatsAppConfig } = require('./notifications');
const { sendPushToMember, sendPushToGym } = require('./push');

// ── Send expiry reminder via approved gym_expiry_reminder template ────────
async function sendExpiryReminderTemplate(gym, phone, memberName, expiryDate) {
  const phoneId = gym?.whatsapp_phone_id || process.env.ZENVIK_PHONE_ID;
  const token   = gym?.whatsapp_token   || process.env.ZENVIK_WA_TOKEN;
  if (!phoneId || !token) {
    console.warn(`⚠️ No WA credentials for gym ${gym?.name} — skipping`);
    return false;
  }
  try {
    let e164 = phone.replace(/[\s\-()]/g, '');
    if (!e164.startsWith('+')) e164 = '+91' + e164.replace(/^0/, '');
    e164 = e164.replace('+', '');
    const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: e164,
        type: 'template',
        template: {
          name: 'gym_expiry_reminder',
          language: { code: 'en' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: memberName },
            { type: 'text', text: gym?.name || 'Your Gym' },
            { type: 'text', text: expiryDate },
          ]}]
        }
      }),
    });
    const d = await r.json();
    if (r.ok) { console.log(`✅ Expiry reminder sent to ${phone}`); return true; }
    console.error(`❌ Expiry reminder failed to ${phone}:`, d.error?.message);
    return false;
  } catch (e) {
    console.error(`❌ Expiry reminder error to ${phone}:`, e.message);
    return false;
  }
}

// ── Run expiry reminders for specific gym IDs ─────────────────────────────
async function runMemberExpiryRemindersForGyms(gymIds) {
  const today = new Date();
  try {
    const { data: members } = await supabase
      .from('members')
      .select('id, name, phone, plan, expiry_date, gym_id')
      .in('gym_id', gymIds)
      .not('expiry_date', 'is', null)
      .in('status', ['active', 'expiring']);
    if (!members?.length) return;

    const { data: configs } = await supabase
      .from('gym_automation_config').select('*').in('gym_id', gymIds);
    const configMap = {};
    (configs || []).forEach(c => { configMap[c.gym_id] = c; });

    for (const member of members) {
      const expiry = new Date(member.expiry_date);
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
      const cfg = configMap[member.gym_id];
      const daysBefore = cfg?.expiry_reminder_days_before ?? 1;

      if (daysLeft !== daysBefore && daysLeft !== 1 && daysLeft !== 0) continue;

      const gym = await getGymWhatsAppConfig(member.gym_id);
      if (!gym) continue;

      const formattedExpiry = new Date(member.expiry_date).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric'
      });
      const title = daysLeft === 0 ? '❌ Membership Expires Today'
        : daysLeft === 1 ? '🚨 Membership Expires Tomorrow'
        : `⚠️ Membership Expiring in ${daysLeft} Days`;
      const body = daysLeft === 0
        ? `Hi ${member.name}, your ${member.plan} membership expires TODAY. Renew now!`
        : daysLeft === 1
          ? `Hi ${member.name}, your ${member.plan} membership expires TOMORROW. Renew to avoid interruption.`
          : `Hi ${member.name}, your membership expires in ${daysLeft} days on ${formattedExpiry}.`;

      await insertMemberNotification(member.gym_id, member.id, title, body, 'fee_reminder');
      await sendPushToMember(member.id, title, body).catch(() => {});
      if (member.phone) await sendExpiryReminderTemplate(gym, member.phone, member.name, formattedExpiry);
    }
  } catch (err) {
    console.error('Gym-specific expiry cron error:', err.message);
  }
}

// Full run (used for manual trigger)
async function runMemberExpiryReminders() {
  console.log('⏰ Running member expiry reminders (all gyms)...');
  try {
    const { data: gyms } = await supabase.from('gyms').select('id');
    if (gyms?.length) await runMemberExpiryRemindersForGyms(gyms.map(g => g.id));
    console.log('✅ Member expiry check done');
  } catch (err) {
    console.error('Member expiry cron error:', err.message);
  }
}

// ── Send today's diet plans for gyms whose diet_message_time matches now ──
async function runDietMessagesForGyms(gymIds) {
  try {
    const { data: configs } = await supabase
      .from('gym_automation_config').select('gym_id, diet_messages_enabled').in('gym_id', gymIds);
    const enabledGymIds = (configs || [])
      .filter(c => c.diet_messages_enabled !== false)
      .map(c => c.gym_id);
    if (!enabledGymIds.length) return;

    // Get all active members with diet plans for today in these gyms
    const todayIdx = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
    const { data: plans } = await supabase
      .from('diet_plans')
      .select('client_profile_id, meal_slot, items, day_of_week, member:profiles!client_profile_id(id, name, phone, gym_id)')
      .eq('day_of_week', todayIdx)
      .in('member.gym_id', enabledGymIds);

    if (!plans?.length) return;

    // Group by member
    const memberPlans = {};
    for (const p of plans) {
      if (!p.member) continue;
      if (!memberPlans[p.client_profile_id]) memberPlans[p.client_profile_id] = { member: p.member, meals: [] };
      memberPlans[p.client_profile_id].meals.push(`${p.meal_slot}: ${p.items}`);
    }

    for (const { member, meals } of Object.values(memberPlans)) {
      const dietContent = meals.join('\n');
      const gym = await getGymWhatsAppConfig(member.gym_id);
      await insertMemberNotification(member.gym_id, member.id, '🥗 Your Diet Plan for Today', dietContent, 'diet');
      if (gym && member.phone) {
        const phoneId = gym.whatsapp_phone_id || process.env.ZENVIK_PHONE_ID;
        const token = gym.whatsapp_token || process.env.ZENVIK_WA_TOKEN;
        if (phoneId && token) {
          let e164 = member.phone.replace(/[\s\-()]/g, '');
          if (!e164.startsWith('+')) e164 = '+91' + e164.replace(/^0/, '');
          e164 = e164.replace('+', '');
          await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: e164,
              type: 'template',
              template: {
                name: 'member_diet_plan',
                language: { code: 'en' },
                components: [{ type: 'body', parameters: [
                  { type: 'text', text: member.name },
                  { type: 'text', text: gym.name },
                  { type: 'text', text: dietContent },
                ]}]
              }
            }),
          });
        }
      }
    }
    console.log(`✅ Diet messages sent for ${Object.keys(memberPlans).length} members`);
  } catch (err) {
    console.error('Diet cron error:', err.message);
  }
}

// ── Owner subscription reminders for gyms whose time matches now ──────────
async function runOwnerSubscriptionRemindersForGyms(gymIds) {
  const today = new Date();
  try {
    const { data: subs } = await supabase
      .from('gym_subscriptions')
      .select('gym_id, end_date, amount, plan, gym:gyms(name, email, phone, whatsapp_number)')
      .eq('status', 'active')
      .in('gym_id', gymIds)
      .not('end_date', 'is', null);
    if (!subs?.length) return;

    for (const sub of subs) {
      const expiry = new Date(sub.end_date);
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
      const gym = sub.gym;
      if (![3, 1, 0].includes(daysLeft)) continue;

      await insertOwnerNotification(
        sub.gym_id,
        daysLeft === 0 ? '❌ Subscription Expired' : `⚠️ Subscription Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
        daysLeft === 0
          ? `Your Zenvik AI subscription has expired. Contact us to renew.`
          : `Your Zenvik AI subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew to avoid interruption.`,
        'fee_reminder'
      );
      // Push notification to gym owner
      await sendPushToGym(sub.gym_id,
        daysLeft === 0 ? '❌ Subscription Expired' : `⚠️ Subscription Expiring`,
        daysLeft === 0 ? 'Your Zenvik AI subscription has expired.' : `Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew now.`,
        'gym_owner'
      ).catch(() => {});

      if (gym?.whatsapp_number) {
        const phone = gym.whatsapp_number.replace(/[^0-9]/g, '');
        const formatted = phone.startsWith('91') ? phone : `91${phone}`;
        const msg = daysLeft === 0
          ? `Your Zenvik AI subscription has expired. Contact info@zenvikai.com to renew.`
          : `Your Zenvik AI subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew now. info@zenvikai.com`;
        await sendWhatsAppMessage(
          process.env.ZENVIK_PHONE_ID || '1011169425416020',
          process.env.ZENVIK_WA_TOKEN,
          formatted, msg
        );
      }
    }
  } catch (err) {
    console.error('Owner subscription reminder error:', err.message);
  }
}

// ── Master per-minute cron — dispatches to gym-specific handlers ──────────
function scheduleMinuteCron() {
  cron.schedule('* * * * *', async () => {
    try {
      // Get current IST time explicitly
      const now = new Date();
      const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const HH = String(istTime.getHours()).padStart(2, '0');
      const MM = String(istTime.getMinutes()).padStart(2, '0');
      const currentTime = `${HH}:${MM}`;

      const { data: configs } = await supabase
        .from('gym_automation_config')
        .select('gym_id, expiry_reminders_enabled, expiry_reminder_time, diet_messages_enabled, diet_message_time, subscription_reminders_enabled, subscription_reminder_time');

      const expiryGyms = [];
      const dietGyms = [];
      const subscriptionGyms = [];

      for (const cfg of (configs || [])) {
        const expiryTime = (cfg.expiry_reminder_time || '09:00').slice(0, 5);
        const dietTime = (cfg.diet_message_time || '07:00').slice(0, 5);
        const subTime = (cfg.subscription_reminder_time || '09:00').slice(0, 5);

        if (cfg.expiry_reminders_enabled !== false && expiryTime === currentTime) expiryGyms.push(cfg.gym_id);
        if (cfg.diet_messages_enabled === true && dietTime === currentTime) dietGyms.push(cfg.gym_id);
        if (cfg.subscription_reminders_enabled !== false && subTime === currentTime) subscriptionGyms.push(cfg.gym_id);
      }

      // Gyms with no config row → default 09:00 for expiry + subscription
      if (currentTime === '09:00') {
        const configuredIds = (configs || []).map(c => c.gym_id);
        const { data: allGyms } = await supabase.from('gyms').select('id');
        const unconfigured = (allGyms || []).filter(g => !configuredIds.includes(g.id)).map(g => g.id);
        expiryGyms.push(...unconfigured);
        subscriptionGyms.push(...unconfigured);
      }

      if (expiryGyms.length) {
        console.log(`⏰ Expiry reminders for ${expiryGyms.length} gym(s) at ${currentTime}`);
        await runMemberExpiryRemindersForGyms(expiryGyms);
      }
      if (dietGyms.length) {
        console.log(`🥗 Diet messages for ${dietGyms.length} gym(s) at ${currentTime}`);
        await runDietMessagesForGyms(dietGyms);
      }
      if (subscriptionGyms.length) {
        console.log(`🏢 Subscription reminders for ${subscriptionGyms.length} gym(s) at ${currentTime}`);
        await runOwnerSubscriptionRemindersForGyms(subscriptionGyms);
      }
    } catch (err) {
      console.error('Minute cron error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
}

function startAllCrons() {
  scheduleMinuteCron();
  console.log('✅ All cron jobs started (IST timezone)');
  console.log('📅 All reminders: per-gym configured time (default 9:00 AM IST)');
  console.log('🥗 Diet messages: at gym-configured time daily (if enabled)');
  console.log('🏢 Owner subscription: per-gym configured time (default 9:00 AM IST)');
}

module.exports = { startAllCrons, runMemberExpiryReminders, sendExpiryReminderTemplate };
