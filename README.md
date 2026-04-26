# Zenvik AI — Gym Server (Cron Jobs)

Handles all scheduled automations for gym management.

## What it does
- 7:00 AM IST — Sends daily diet plans to members with trainers
- 7:00 AM IST — Member fee expiry reminders (WhatsApp 1 day before, in-app 3/1/0 days)
- 9:00 AM IST — Gym owner subscription reminders (3/1/0 days before expiry)
- Manual trigger endpoints for testing

## Deploy on Railway
1. Connect this GitHub repo to Railway
2. Add environment variables from .env.example
3. Railway auto-deploys on every push to main

## Test Endpoints
- GET  /health                    → server status
- POST /trigger/member-reminders  → manually fire member expiry check
- POST /trigger/diet              → manually fire diet plan sending
