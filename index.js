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
                c.state NOT IN ('DEAD', 'ARCHIVED', 'FUNDED', 'FCS_QUEUE') 
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

                    -- 🟢 REPLIED NUDGES (gathering info)
                    OR
                    -- Nudge 1: Stalled for 15 mins
                    (c.state = 'REPLIED' AND last_msg.timestamp < NOW() - INTERVAL '15 minutes')
                    OR
                    -- Nudge 2: Ignored Nudge 1 for 30 mins
                    (c.state = 'REPLIED_NUDGE_1' AND last_msg.timestamp < NOW() - INTERVAL '30 minutes')
                    OR
                    -- HAIL MARY: Ignored Nudge 2 for 60 mins
                    (c.state = 'REPLIED_NUDGE_2' AND last_msg.timestamp < NOW() - INTERVAL '60 minutes')
                    OR
                    -- DEAD: Ignored Hail Mary for 75 mins
                    (c.state = 'HAIL_MARY' AND last_msg.timestamp < NOW() - INTERVAL '75 minutes')
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

            // --- 🟢 REPLIED NUDGES (Pre-Vetter still gathering info) ---

            else if (lead.state === 'REPLIED') {
                console.log(`🤔 [${lead.business_name}] Stalled 15m → Nudge 1`);
                instruction = "";
                nextState = 'REPLIED_NUDGE_1';

            } else if (lead.state === 'REPLIED_NUDGE_1') {
                console.log(`🤔 [${lead.business_name}] Ignored nudge → Nudge 2`);
                instruction = "";
                nextState = 'REPLIED_NUDGE_2';

            } else if (lead.state === 'REPLIED_NUDGE_2') {
                console.log(`🏈 [${lead.business_name}] HAIL MARY → Vetter throws ballpark`);
                instruction = "";
                nextState = 'HAIL_MARY';

            } else if (lead.state === 'HAIL_MARY') {
                console.log(`💀 [${lead.business_name}] Ignored ballpark → DEAD`);
                shouldTriggerAI = false;
                nextState = 'DEAD';
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

// --- MORNING FOLLOW-UP SCHEDULER ---
let lastMorningRun = null;

function checkMorningRun() {
    const now = new Date();
    const estTime = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const estHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    const today = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });

    // Log every 10 minutes
    if (now.getMinutes() % 10 === 0) {
        console.log(`🕐 EST Time: ${estTime} | Hour: ${estHour}`);
    }

    if (estHour === 9 && lastMorningRun !== today) {
        console.log('🌅 9am EST - Triggering morning follow-up');
        lastMorningRun = today;

        axios.post('https://mcagent.io/api/agent/morning-followup', {}, {
            headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET }
        })
            .then(res => console.log('🌅 Morning follow-up result:', res.data))
            .catch(err => console.error('🌅 Morning follow-up failed:', err.message));
    }
}

setInterval(checkMorningRun, 60 * 1000);
