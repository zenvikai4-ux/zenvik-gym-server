require('dotenv').config();
const express = require('express');
const { startAllCrons } = require('./cron');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Health check only - no webhook needed
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Zenvik AI GymApp Cron Server',
    timestamp: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    jobs: ['member_expiry_7am', 'diet_plans_7am', 'owner_subscription_9am']
  });
});

// Manual trigger for testing (remove in production)
app.post('/trigger/member-reminders', async (req, res) => {
  const { scheduleMemberExpiryReminders } = require('./cron');
  res.json({ message: 'Member reminder check triggered — check logs' });
  console.log('🔧 Manual trigger: member reminders');
});

app.post('/trigger/diet', async (req, res) => {
  res.json({ message: 'Diet plan trigger — check logs' });
  console.log('🔧 Manual trigger: diet plans');
});

app.listen(PORT, () => {
  console.log(`🚀 GymApp Cron Server running on port ${PORT}`);
  startAllCrons();
});
