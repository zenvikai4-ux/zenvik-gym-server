const cron = require('node-cron');
const supabase = require('./supabase');
const { sendWhatsAppMessage } = require('./whatsapp');
const { insertMemberNotification, insertOwnerNotification, getGymWhatsAppConfig } = require('./notifications');

// Send WhatsApp using approved gym_broadcast template
async function sendTemplateMessage(gym, phone, memberName, message) {
  if (!gym?.whatsapp_phone_id || !gym?.whatsapp_token) {
    console.warn(`⚠️ No WA credentials for gym ${gym?.name} — skipping`);
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
          name: 'gym_broadcast',
          language: { code: 'en' },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: memberName },
              { type: 'text', text: message },
              { type: 'text', text: gym.name },
            ]
          }]
        }
      })
    });
    const d = await r.json();
    if (r.ok) {
      console.log(`✅ WA template sent to ${phone}`);
      return true;
    } else {
      console.error(`❌ Template send failed to ${phone}:`, d.error?.message);
      return false;
    }
  } catch (e) {
    console.error(`❌ WA send error to ${phone}:`, e.message);
    return false;
  }
}

async function sendExpiryReminderTemplate(gym, phone, memberName, expiryDate) {
  if (!gym?.whatsapp_phone_id || !gym?.whatsapp_token) {
    console.warn(`⚠️ No WA credentials for gym ${gym?.name} — skipping`);
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
          name: 'gym_expiry_reminder',
          language: { code: 'en' },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: memberName },  // {{1}} member name
              { type: 'text', text: gym.name },    // {{2}} gym name
              { type: 'text', text: expiryDate },  // {{3}} expiry date
            ]
          }]
        }
      })
    });
    const d = await r.json();
    if (r.ok) {
      console.log(`✅ Expiry reminder sent to ${phone}`);
      return true;
    } else {
      console.error(`❌ Expiry reminder failed to ${phone}:`, d.error?.message);
      return false;
    }
  } catch (e) {
    console.error(`❌ Expiry reminder error to ${phone}:`, e.message);
    return false;
  }
}
  console.log('⏰ Running member expiry reminders...');
  const today = new Date();

  try {
    const { data: members } = await supabase
      .from('members')
      .select('id, name, phone, plan, expiry_date, gym_id')
      .not('expiry_date', 'is', null)
      .in('status', ['active', 'expiring']);

    if (!members?.length) {
      console.log('ℹ️ No members found');
      return;
    }

    for (const member of members) {
      const expiry = new Date(member.expiry_date);
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);

      console.log(`👤 ${member.name} — ${daysLeft} days left`);

      const gym = await getGymWhatsAppConfig(member.gym_id);
      if (!gym) {
        console.warn(`⚠️ No gym config for ${member.gym_id}`);
        continue;
      }

      if (daysLeft === 3) {
        await insertMemberNotification(
          member.gym_id, member.id,
          '⚠️ Membership Expiring Soon',
          `Hi ${member.name}, your ${member.plan} membership expires in 3 days. Contact your gym to renew.`,
          'fee_reminder'
        );
        await sendExpiryReminderTemplate(gym, member.phone, member.name,
          new Date(member.expiry_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        );
      }

      if (daysLeft === 1) {
        await insertMemberNotification(
          member.gym_id, member.id,
          '🚨 Membership Expires Tomorrow',
          `Hi ${member.name}, your ${member.plan} membership expires TOMORROW. Renew now to avoid interruption.`,
          'fee_reminder'
        );
        await sendExpiryReminderTemplate(gym, member.phone, member.name,
          new Date(member.expiry_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        );
      }

      if (daysLeft === 0) {
        await insertMemberNotification(
          member.gym_id, member.id,
          '❌ Membership Expiring Today',
          `Hi ${member.name}, your ${member.plan} membership expires TODAY. Renew now to continue!`,
          'fee_reminder'
        );
        await sendExpiryReminderTemplate(gym, member.phone, member.name,
          new Date(member.expiry_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        );
      }
    }
    console.log(`✅ Processed ${members.length} member expiry checks`);
  } catch (err) {
    console.error('Member expiry cron error:', err.message);
  }
}

/**
 * Member expiry reminders
 * Runs at 9:00 AM IST (3:30 AM UTC) every day
 */
function scheduleMemberExpiryReminders() {
  cron.schedule('0 9 * * *', runMemberExpiryReminders, { timezone: 'Asia/Kolkata' });
}

/**
 * Check gym owner subscription expiry at 9 AM IST
 */
function scheduleOwnerExpiryReminders() {
  cron.schedule('0 9 * * *', async () => {
    console.log('🏢 Checking gym owner subscriptions...');
    const today = new Date();

    try {
      const { data: subs } = await supabase
        .from('gym_subscriptions')
        .select(`gym_id, end_date, amount, plan, gym:gyms(name, email, phone, whatsapp_number)`)
        .eq('status', 'active')
        .not('end_date', 'is', null);

      if (!subs?.length) return;

      for (const sub of subs) {
        const expiry = new Date(sub.end_date);
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
        const gym = sub.gym;

        if ([3, 1, 0].includes(daysLeft)) {
          await insertOwnerNotification(
            sub.gym_id,
            daysLeft === 0 ? '❌ Subscription Expired' : `⚠️ Subscription Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
            daysLeft === 0
              ? `Your Zenvik AI subscription has expired. Contact us to renew.`
              : `Your Zenvik AI subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew to avoid interruption.`,
            'fee_reminder'
          );
        }

        if ([3, 1, 0].includes(daysLeft) && gym?.whatsapp_number) {
          const phone = gym.whatsapp_number.replace(/[^0-9]/g, '');
          const formatted = phone.startsWith('91') ? phone : `91${phone}`;
          const msg = daysLeft === 0
            ? `Your Zenvik AI subscription has expired today. Contact info@zenvikai.com to renew immediately.`
            : `Your Zenvik AI subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Renew now to avoid interruption. info@zenvikai.com`;

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
  scheduleOwnerExpiryReminders();
  console.log('✅ All cron jobs started (IST timezone)');
  console.log('📅 Member expiry reminders: 9:00 AM IST daily');
  console.log('🏢 Owner subscription: 9:00 AM IST daily');
  console.log('🥗 Diet messages: sent on trainer assignment (not cron)');
}

module.exports = { startAllCrons, runMemberExpiryReminders, sendTemplateMessage };
