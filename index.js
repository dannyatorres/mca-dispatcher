require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

// --- CONFIGURATION ---
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL; 
const BATCH_SIZE = 10;       // Max leads to process per run
const WAIT_TIME_MS = 5000;   // 5 Seconds (Twilio Safety Buffer)
const RUN_INTERVAL_MS = 15 * 60 * 1000; // Run every 15 minutes

// Check for missing URL
if (!N8N_WEBHOOK_URL) {
    console.error("❌ ERROR: N8N_WEBHOOK_URL is missing from Environment Variables.");
    process.exit(1);
}

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Railway/AWS
});

async function runDispatcher() {
    console.log('⏰ Starting Dispatcher Run:', new Date().toISOString());
    const client = await pool.connect();

    try {
        // QUERY: Find 'NEW' leads OR 'STALE' leads (No reply in 24h)
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
                    -- CASE 1: Brand New Leads (Touched > 5 mins ago to let import finish)
                    (c.state = 'NEW' AND c.last_activity < NOW() - INTERVAL '5 minutes')
                    OR
                    -- CASE 2: Stale Follow-ups (We texted last, > 24 hours ago)
                    (last_msg.direction = 'outbound' AND last_msg.timestamp < NOW() - INTERVAL '24 hours')
                )
                -- SAFETY: Don't pick up anyone we checked in the last hour
                AND c.last_activity < NOW() - INTERVAL '1 hour'
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
            console.log(`🚀 Triggering AI for ${lead.state} lead: ${lead.business_name || lead.lead_phone}`);

            // Determine the instruction based on state
            let instruction = "";
            if (lead.state === 'NEW') {
                instruction = "This is a NEW lead. Send an initial friendly outreach message introduction.";
            } else {
                instruction = `User hasn't replied in ${Math.round(lead.hours_since_last_action)} hours. Review history and send a polite follow-up.`;
            }

            try {
                // 1. Call your n8n AI Agent
                await axios.post(N8N_WEBHOOK_URL, {
                    conversation_id: lead.id,
                    system_instruction: instruction
                });

                // 2. Update 'last_activity' to prevent infinite loops
                // We set state to 'ACTIVE' if it was 'NEW' so we don't send the intro twice
                await client.query(`
                    UPDATE conversations 
                    SET last_activity = NOW(),
                        state = CASE WHEN state = 'NEW' THEN 'INITIAL_CONTACT' ELSE state END
                    WHERE id = $1
                `, [lead.id]);

                // 3. THOTTLE: Wait 5 seconds before the next one
                await new Promise(r => setTimeout(r, WAIT_TIME_MS));

            } catch (err) {
                console.error(`❌ Failed to trigger for ${lead.id}:`, err.message);
            }
        }

    } catch (err) {
        console.error('🔥 Critical Dispatcher Error:', err);
    } finally {
        client.release();
    }
}

// Start the loop
console.log('🚀 Dispatcher Service Started');
runDispatcher(); // Run once immediately on start
setInterval(runDispatcher, RUN_INTERVAL_MS); // Then repeat every 15 mins
