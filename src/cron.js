const cron = require('node-cron');
const supabase = require('./supabase');
const { sendWhatsAppMessage } = require('./whatsapp');
const { insertMemberNotification, insertOwnerNotification, getGymWhatsAppConfig, sendMemberWhatsApp } = require('./notifications');

/**
 * Check member plan expiry and send reminders
 * Runs every day at 7:00 AM IST (1:30 AM UTC)
 */
function scheduleMemberExpiryReminders() {
  cron.schedule('30 1 * * *', async () => {
    console.log('⏰ Running member expiry reminders...');
    const today = new Date();

    try {
      // Get all active members with expiry dates
      const { data: members } = await supabase
        .from('members')
        .select('id, name, phone, plan, expiry_date, gym_id')
        .not('expiry_date', 'is', null)
        .in('status', ['active', 'expiring']);

      if (!members?.length) return;

      for (const member of members) {
        const expiry = new Date(member.expiry_date);
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);

        const gym = await getGymWhatsAppConfig(member.gym_id);
        if (!gym) continue;

        // IN-APP: 3 days, 1 day, 0 days (day of)
        if (daysLeft === 3) {
          await insertMemberNotification(
            member.gym_id, member.id,
            '⚠️ Membership Expiring Soon',
            `Hi ${member.name}, your ${member.plan} membership expires in 3 days on ${member.expiry_date}. Contact your gym to renew.`,
            'fee_reminder'
          );
        }
        if (daysLeft === 1) {
          await insertMemberNotification(
            member.gym_id, member.id,
            '🚨 Membership Expires Tomorrow',
            `Hi ${member.name}, your ${member.plan} membership expires TOMORROW. Renew now to avoid interruption.`,
            'fee_reminder'
          );
          // WHATSAPP: only 1 day before
          const msg = `🏋️ *${gym.name}*\n\nHi ${member.name}! Your *${member.plan} membership* expires *tomorrow*.\n\nContact us to renew and continue your fitness journey! 💪\n\n_Powered by Zenvik AI_`;
          await sendMemberWhatsApp(gym, member.phone, msg);
        }
        if (daysLeft === 0) {
          await insertMemberNotification(
            member.gym_id, member.id,
            '❌ Membership Expired Today',
            `Hi ${member.name}, your membership has expired today. Please renew to continue.`,
            'fee_reminder'
          );
        }
      }
      console.log(`✅ Processed ${members.length} member expiry checks`);
    } catch (err) {
      console.error('Member expiry cron error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
}

/**
 * Send daily diet plans via WhatsApp at 7 AM IST
 */
function scheduleDailyDietMessages() {
  cron.schedule('0 7 * * *', async () => {
    console.log('🥗 Sending daily diet plans...');
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1; // 0=Mon...6=Sun

    try {
      // Get all client_profiles that have trainer assigned
      const { data: clientProfiles } = await supabase
        .from('client_profiles')
        .select(`
          id, gym_id, trainer_id,
          member:members(id, name, phone, gym_id)
        `)
        .not('trainer_id', 'is', null);

      if (!clientProfiles?.length) return;

      for (const cp of clientProfiles) {
        const member = cp.member;
        if (!member?.phone) continue;

        // Get today's diet plan
        const { data: plans } = await supabase
          .from('diet_plans')
          .select('meal_slot, items')
          .eq('client_profile_id', cp.id)
          .eq('day_of_week', dayOfWeek)
          .order('meal_slot');

        if (!plans?.length) continue;

        const gym = await getGymWhatsAppConfig(cp.gym_id);
        if (!gym) continue;

        const dayName = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][dayOfWeek];

        // Format diet message
        const mealLines = plans.map(p =>
          `🍽️ *${p.meal_slot.charAt(0).toUpperCase() + p.meal_slot.slice(1)}:* ${p.items}`
        ).join('\n');

        const msg = `🏋️ *${gym.name} — Diet Plan*\n📅 *${dayName}*\n\n${mealLines}\n\n💧 Stay hydrated! Drink 8+ glasses of water today.\n\n_Your trainer has customized this plan for you_ 💪`;

        // Send WhatsApp
        await sendMemberWhatsApp(gym, member.phone, msg);

        // Also send in-app notification
        await insertMemberNotification(
          cp.gym_id, member.id,
          `🥗 Today's Diet Plan — ${dayName}`,
          plans.map(p => `${p.meal_slot}: ${p.items}`).join(' | '),
          'diet'
        );
      }
      console.log(`✅ Diet plans sent for ${clientProfiles.length} clients`);
    } catch (err) {
      console.error('Diet cron error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
}

/**
 * Check gym owner subscription expiry (from Zenvik to gym owners)
 * Runs daily at 9 AM IST
 */
function scheduleOwnerExpiryReminders() {
  cron.schedule('0 9 * * *', async () => {
    console.log('🏢 Checking gym owner subscriptions...');
    const today = new Date();

    try {
      const { data: subs } = await supabase
        .from('gym_subscriptions')
        .select(`
          gym_id, end_date, amount, plan,
          gym:gyms(name, email, phone, whatsapp_number)
        `)
        .eq('status', 'active')
        .not('end_date', 'is', null);

      if (!subs?.length) return;

      for (const sub of subs) {
        const expiry = new Date(sub.end_date);
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
        const gym = sub.gym;

        // IN-APP: 3 days, 1 day, 0 days
        if ([3, 1, 0].includes(daysLeft)) {
          await insertOwnerNotification(
            sub.gym_id,
            daysLeft === 0 ? '❌ Subscription Expired' : `⚠️ Subscription Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
            daysLeft === 0
              ? `Your Zenvik AI subscription has expired. Contact us to renew and keep your gym running.`
              : `Your Zenvik AI subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew to avoid service interruption.`,
            'fee_reminder'
          );
        }

        // WHATSAPP to gym owner: 3 days, 1 day, 0 days
        if ([3, 1, 0].includes(daysLeft) && gym?.whatsapp_number) {
          const phone = gym.whatsapp_number.replace(/[^0-9]/g, '');
          const formatted = phone.startsWith('91') ? phone : `91${phone}`;
          const msg = daysLeft === 0
            ? `❌ *Zenvik AI — Subscription Expired*\n\nHi *${gym.name}*,\n\nYour Zenvik AI gym management subscription has *expired today*.\n\nPlease renew immediately to restore access.\n📧 ${process.env.ZENVIK_CONTACT_EMAIL || "info@zenvikai.com"}\n🌐 ${process.env.ZENVIK_WEBSITE || "https://zenvikai.com"}`
            : `⚠️ *Zenvik AI — Subscription Reminder*\n\nHi *${gym.name}*,\n\nYour subscription expires in *${daysLeft} day${daysLeft !== 1 ? 's' : ''}*.\n\nRenew now to avoid interruption.\n📧 ${process.env.ZENVIK_CONTACT_EMAIL || "info@zenvikai.com"}\n🌐 ${process.env.ZENVIK_WEBSITE || "https://zenvikai.com"}`;

          await sendWhatsAppMessage(
            process.env.ZENVIK_PHONE_ID || '1011169425416020',
            process.env.ZENVIK_WA_TOKEN,
            formatted,
            msg
          );
        }
      }
      console.log(`✅ Owner subscription checks done for ${subs.length} gyms`);
    } catch (err) {
      console.error('Owner expiry cron error:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
}

function startAllCrons() {
  scheduleMemberExpiryReminders();
  scheduleDailyDietMessages();
  scheduleOwnerExpiryReminders();
  console.log('✅ All cron jobs started (IST timezone)');
}

module.exports = { startAllCrons };
