# MCA Dispatcher - AI Agent Service

This service automatically processes leads using AI to send follow-up messages via SMS.

## How It Works

The dispatcher runs every 15 minutes and:
1. **Finds leads that need attention** (NEW leads or stale conversations)
2. **Calls the AI Agent** on your backend to analyze conversation history
3. **Generates and sends appropriate responses** via Twilio
4. **Updates lead status** automatically based on AI decisions

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```

Edit `.env`:
```env
BACKEND_URL=https://your-crm-backend.up.railway.app
```

**Note**: You only need `BACKEND_URL`. The dispatcher no longer connects directly to the database - all database operations are handled by the backend API.

### 3. Run the Dispatcher
```bash
node index.js
```

Or deploy to Railway/Heroku for continuous operation.

## What Changed from n8n?

Previously, this dispatcher called an n8n webhook. Now it calls your own backend at:
```
POST /api/ai/process-lead
```

This gives you full control over the AI logic without depending on external services.

## How the AI Works

The AI Agent (`backend/services/aiAgent.js`):
- **Reads conversation history** to understand context
- **Uses OpenAI with tools** to decide actions
- **Can update lead status** (INTERESTED, QUALIFIED, DEAD, etc.)
- **Can stop outreach** if user says STOP/UNSUBSCRIBE
- **Generates appropriate replies** based on conversation state

## Lead Selection Logic

The dispatcher picks up leads that match either:
1. **NEW leads** that were created >5 minutes ago (gives time for import to finish)
2. **Stale leads** where we sent the last message >24 hours ago with no reply

Safety: Won't re-process leads checked in the last hour.

## Configuration

Edit `index.js` to adjust:
- `BATCH_SIZE`: Max leads per run (default: 10)
- `WAIT_TIME_MS`: Delay between messages (default: 5000ms)
- `RUN_INTERVAL_MS`: How often to run (default: 15 minutes)

## Monitoring

Watch the logs to see:
```
🚀 Triggering AI for NEW lead: ABC Construction LLC
✅ AI processed lead abc123: { success: true, reply: "..." }
```

## Troubleshooting

### Dispatcher not finding leads
- Check your database connection
- Verify leads exist in `conversations` table
- Check lead states (must not be DEAD, ARCHIVED, or FUNDED)

### AI not responding
- Verify BACKEND_URL is correct
- Check backend logs at `/api/ai/process-lead`
- Ensure OpenAI API key is configured in backend

### Messages not sending
- Check Twilio credentials in backend .env
- Verify phone numbers are in E.164 format (+1234567890)
- Check backend logs for Twilio errors
