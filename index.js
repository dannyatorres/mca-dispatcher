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

        const query = `
            SELECT c.id, c.lead_phone, c.state, c.business_name,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(last_msg.timestamp, c.created_at)))/60 as minutes_since_last
            FROM conversations c
            LEFT JOIN LATERAL (
                SELECT direction, timestamp FROM messages m WHERE m.conversation_id = c.id ORDER BY m.timestamp DESC LIMIT 1
            ) last_msg ON true
            WHERE
                c.state NOT IN ('DEAD', 'ARCHIVED', 'FUNDED', 'FCS_QUEUE', 'STALE') 
                AND (last_msg.direction = 'outbound' OR last_msg.direction IS NULL)
                AND (
                    -- COLD DRIP (Existing)
                    (c.state = 'NEW' AND c.created_at < NOW() - INTERVAL '2 minutes')
                    OR
                    (c.state = 'SENT_HOOK' AND last_msg.timestamp < NOW() - INTERVAL '20 minutes')
                    OR
                    (c.state = 'SENT_FU_1' AND last_msg.timestamp < NOW() - INTERVAL '20 minutes')
                    OR
                    (c.state = 'SENT_FU_2' AND last_msg.timestamp < NOW() - INTERVAL '4 hours')
                    OR
                    (c.state = 'SENT_FU_3' AND last_msg.timestamp < NOW() - INTERVAL '24 hours')

                    -- 🟢 WARM VETTING (RAPID FIRE)
                    OR
                    -- STRIKE 1: Stalled for 15 mins
                    (c.state = 'INTERESTED' AND last_msg.timestamp < NOW() - INTERVAL '15 minutes')
                    OR
                    -- STRIKE 2: Ignored Nudge 1 for 30 mins (Total 45m)
                    (c.state = 'VETTING_NUDGE_1' AND last_msg.timestamp < NOW() - INTERVAL '30 minutes')
                    OR
                    -- STRIKE 3 (HAIL MARY): Ignored Nudge 2 for 60 mins
                    (c.state = 'VETTING_NUDGE_2' AND last_msg.timestamp < NOW() - INTERVAL '60 minutes')
                    OR
                    -- STRIKE 4 (GIVE UP): Ignored Hail Mary for 75 mins
                    (c.state = 'SENT_BALLPARK' AND last_msg.timestamp < NOW() - INTERVAL '75 minutes')
                )
            LIMIT $1
        `;

        const { rows } = await client.query(query, [BATCH_SIZE]);
        if (rows.length === 0) { console.log('✅ No leads need attention.'); return; }

        for (const lead of rows) {
            let instruction = "";
            let nextState = "";
            let shouldTriggerAI = true;

            // --- COLD DRIP LOGIC (Keep as is) ---
            if (lead.state === 'NEW') {
                instruction = "Underwriter Hook"; nextState = 'SENT_HOOK';
            } else if (lead.state === 'SENT_HOOK') {
                instruction = "Send exactly: 'Did you get funded already?'"; nextState = 'SENT_FU_1';
            } else if (lead.state === 'SENT_FU_1') {
                instruction = "Send exactly: 'The money is expensive as is let me compete.'"; nextState = 'SENT_FU_2';
            } else if (lead.state === 'SENT_FU_2') {
                instruction = "Send exactly: 'Hey just following up again, should i close the file out?'"; nextState = 'SENT_FU_3';
            } else if (lead.state === 'SENT_FU_3') {
                instruction = "Send exactly: 'hey any response would be appreciated here, close this out?'"; nextState = 'SENT_FU_4'; // or STALE
            }

            // --- 🟢 WARM VETTING (RAPID FIRE) ---
            
            else if (lead.state === 'INTERESTED') {
                // 15 Mins later
                console.log(`🤔 Lead ${lead.business_name} stalled (15m). Sending Nudge 1.`);
                instruction = "The user stopped responding. Read history. Gently nudge them about the last question (Credit or Funding). Keep it very short.";
                nextState = 'VETTING_NUDGE_1';

            } else if (lead.state === 'VETTING_NUDGE_1') {
                // 30 Mins after Nudge 1
                console.log(`🤔 Lead ${lead.business_name} ignored nudge. Sending Final Warning.`);
                instruction = "User hasn't replied. Ask: 'Hey, I haven't heard back—should I assume you're all set or should I keep this file open?'";
                nextState = 'VETTING_NUDGE_2';

            } else if (lead.state === 'VETTING_NUDGE_2') {
                // 60 Mins after Nudge 2 -> HAIL MARY
                console.log(`🏈 HAIL MARY: Sending Ballpark Offer to ${lead.business_name}`);
                instruction = "Generate Ballpark Offer"; // Triggers Gemini logic in aiAgent.js
                nextState = 'SENT_BALLPARK';
            
            } else if (lead.state === 'SENT_BALLPARK') {
                // 75 Mins after Offer -> DEAD
                console.log(`💀 Lead ${lead.business_name} ignored the money. Marking STALE.`);
                shouldTriggerAI = false;
                nextState = 'STALE';
            }

            try {
                if (shouldTriggerAI) {
                    await axios.post(BACKEND_URL, { conversation_id: lead.id, system_instruction: instruction });
                }
                await client.query(`UPDATE conversations SET state = $1, last_activity = NOW() WHERE id = $2`, [nextState, lead.id]);
                await new Promise(r => setTimeout(r, 2000)); 
            } catch (err) { console.error(err.message); }
        }

    } catch (err) { console.error('🔥 Critical Error:', err); } 
    finally { if (client) client.release(); }
}

runDispatcher();
setInterval(runDispatcher, RUN_INTERVAL_MS);
