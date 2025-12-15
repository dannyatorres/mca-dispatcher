require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

// --- CONFIGURATION ---
const BACKEND_URL = "https://mcagent.io/api/agent/trigger";
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 10;
// ⚡ TURBO MODE: Check every 60 seconds
const RUN_INTERVAL_MS = 60 * 1000; 

if (!DATABASE_URL) { console.error("❌ ERROR: DATABASE_URL is missing."); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function runDispatcher() {
    console.log('⏰ Starting Dispatcher Run:', new Date().toISOString());
    let client;

    try {
        client = await pool.connect();

        // QUERY: The "Free Brain"
        const query = `
            SELECT c.id, c.lead_phone, c.state, c.business_name,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(last_msg.timestamp, c.created_at)))/60 as minutes_since_last
            FROM conversations c
            LEFT JOIN LATERAL (
                SELECT direction, timestamp FROM messages m WHERE m.conversation_id = c.id ORDER BY m.timestamp DESC LIMIT 1
            ) last_msg ON true
            WHERE
                c.state NOT IN ('DEAD', 'ARCHIVED', 'FUNDED', 'INTERESTED', 'FCS_QUEUE') 
                AND (last_msg.direction = 'outbound' OR last_msg.direction IS NULL)
                AND (
                    -- STEP 1: NEW LEAD (> 2 mins old)
                    -- Changed from 5 minutes to 2 minutes for faster response
                    (c.state = 'NEW' AND c.created_at < NOW() - INTERVAL '2 minutes')
                    OR
                    -- STEP 2: 1st NUDGE (20 mins after Hook)
                    (c.state = 'SENT_HOOK' AND last_msg.timestamp < NOW() - INTERVAL '20 minutes')
                    OR
                    -- STEP 3: 2nd NUDGE (20 mins after 1st Nudge)
                    (c.state = 'SENT_FU_1' AND last_msg.timestamp < NOW() - INTERVAL '20 minutes')
                    OR
                    -- STEP 4: FINAL CHECK (4 hours after 2nd Nudge)
                    (c.state = 'SENT_FU_2' AND last_msg.timestamp < NOW() - INTERVAL '4 hours')
                    OR
                    -- STEP 5: MARK STALE (24 hours after Final Check)
                    (c.state = 'SENT_FU_3' AND last_msg.timestamp < NOW() - INTERVAL '24 hours')
                )
            LIMIT $1
        `;

        const { rows } = await client.query(query, [BATCH_SIZE]);
        if (rows.length === 0) { console.log('✅ No leads need attention.'); return; }

        for (const lead of rows) {
            let instruction = "";
            let nextState = "";
            let shouldTriggerAI = true;

            // --- LOGIC MAP ---
            if (lead.state === 'NEW') {
                console.log(`🚀 Sending Hook to: ${lead.business_name}`);
                instruction = "Execute the 'Underwriter Hook' strategy. You MUST use the exact 'Dan Torres' script defined in your system instructions.";
                nextState = 'SENT_HOOK';
            
            } else if (lead.state === 'SENT_HOOK') {
                console.log(`🚀 Sending 'Funded?' check to: ${lead.business_name}`);
                instruction = "Send exactly: 'Did you get funded already? The money is expensive as is, let me compete.'";
                nextState = 'SENT_FU_1';

            } else if (lead.state === 'SENT_FU_1') {
                console.log(`🚀 Sending 'File Open' nudge to: ${lead.business_name}`);
                instruction = "Send exactly: 'I have the file open right now, just need the email to send the terms.'";
                nextState = 'SENT_FU_2';

            } else if (lead.state === 'SENT_FU_2') {
                console.log(`🚀 Sending Final Check to: ${lead.business_name}`);
                instruction = "Ask if they are still looking or if you should close the file.";
                nextState = 'SENT_FU_3';
            
            } else if (lead.state === 'SENT_FU_3') {
                console.log(`💀 Marking lead as STALE: ${lead.business_name}`);
                shouldTriggerAI = false;
                nextState = 'STALE';
            }

            try {
                if (shouldTriggerAI) {
                    const response = await axios.post(BACKEND_URL, {
                        conversation_id: lead.id,
                        system_instruction: instruction
                    });

                    if (response.data.action === 'sent_message') {
                        console.log(`🗣️ AI Sent: "${response.data.ai_reply}"`);
                    }
                }

                await client.query(`UPDATE conversations SET state = $1, last_activity = NOW() WHERE id = $2`, [nextState, lead.id]);
                await new Promise(r => setTimeout(r, 2000)); 

            } catch (err) {
                console.error(`❌ Error triggering lead ${lead.id}:`, err.message);
            }
        }

    } catch (err) { console.error('🔥 Critical Error:', err); } 
    finally { if (client) client.release(); }
}

runDispatcher();
setInterval(runDispatcher, RUN_INTERVAL_MS);