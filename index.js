require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

// --- CONFIGURATION ---
// 1. Point to your Backend API Trigger
const BACKEND_URL = "https://mcagent.io/api/agent/trigger";
// 2. Database Connection
const DATABASE_URL = process.env.DATABASE_URL;

const BATCH_SIZE = 10;       // Max leads to process per run
const WAIT_TIME_MS = 5000;   // 5 Seconds between texts
const RUN_INTERVAL_MS = 5 * 60 * 1000; // <--- CHANGED: Run every 5 minutes (was 15)

if (!DATABASE_URL) {
    console.error("❌ ERROR: DATABASE_URL is missing.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runDispatcher() {
    console.log('⏰ Starting Dispatcher Run:', new Date().toISOString());
    let client;

    try {
        client = await pool.connect();

        // QUERY: Find 'NEW' leads OR 'STALE' leads
        const query = `
            SELECT
                c.id,
                c.lead_phone,
                c.state,
                c.business_name,
                EXTRACT(EPOCH FROM (NOW() - COALESCE(last_msg.timestamp, c.created_at)))/3600 as hours_since_last_action
            FROM conversations c
            LEFT JOIN LATERAL (
                SELECT direction, timestamp
                FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.timestamp DESC
                LIMIT 1
            ) last_msg ON true
            WHERE
                c.state NOT IN ('DEAD', 'ARCHIVED', 'FUNDED')
                AND (
                    -- RULE 1: If NEW, check after 5 minutes
                    -- FIX: We use COALESCE to check created_at if last_activity is NULL
                    (c.state = 'NEW' AND COALESCE(c.last_activity, c.created_at) < NOW() - INTERVAL '5 minutes')
                    OR
                    -- RULE 2: If STALE (no reply in 24h), check if we haven't touched it in 1h
                    (
                        last_msg.direction = 'outbound'
                        AND last_msg.timestamp < NOW() - INTERVAL '24 hours'
                        AND COALESCE(c.last_activity, c.created_at) < NOW() - INTERVAL '1 hour'
                    )
                )
            LIMIT $1
        `;

        const { rows } = await client.query(query, [BATCH_SIZE]);

        if (rows.length === 0) {
            console.log('✅ No leads need attention right now.');
            return;
        }

        console.log(`found ${rows.length} leads to process. Starting loop...`);

        // --- THE LOOP ---
        for (const lead of rows) {
            console.log(`🚀 Triggering AI for ${lead.state} lead: ${lead.business_name}`);

            let instruction = "";
            if (lead.state === 'NEW') {
                instruction = "This is a NEW lead. Send an initial friendly outreach message.";
            } else {
                instruction = `User hasn't replied in ${Math.round(lead.hours_since_last_action)} hours. Send a polite follow-up.`;
            }

            try {
                // CALL YOUR BACKEND API
                const response = await axios.post(BACKEND_URL, {
                    conversation_id: lead.id,
                    system_instruction: instruction
                });

                if (response.data.action === 'sent_message') {
                    console.log(`🗣️ AI SAID: "${response.data.ai_reply}"`);
                } else {
                    console.log(`🤫 AI stayed silent (Action: ${response.data.action})`);
                }

                // UPDATE DB
                await client.query(`
                    UPDATE conversations
                    SET last_activity = NOW(),
                        state = CASE WHEN state = 'NEW' THEN 'INITIAL_CONTACT' ELSE state END
                    WHERE id = $1
                `, [lead.id]);

                // Wait 5s
                await new Promise(r => setTimeout(r, WAIT_TIME_MS));

            } catch (err) {
                console.error(`❌ Failed to trigger for ${lead.id}:`, err.response?.data || err.message);
            }
        }

    } catch (err) {
        console.error('🔥 Critical Dispatcher Error:', err);
    } finally {
        if (client) client.release();
    }
}

// Start
console.log('🚀 Dispatcher Service Started (Interval: 5 mins)');
runDispatcher();
setInterval(runDispatcher, RUN_INTERVAL_MS);
