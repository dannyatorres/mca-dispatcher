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

function formatName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

let isRunning = false;

async function runDispatcher() {
    if (isRunning) {
        console.log('⏭️ Previous run still active - skipping');
        return;
    }
    isRunning = true;

    console.log('🚀 DISPATCHER v2.1 -', new Date().toISOString());
    let client;

    try {
        client = await pool.connect();

        const query = `
            SELECT c.id, c.lead_phone, c.state, c.business_name, c.first_name,
                   u.agent_name,
                   u.service_settings->>'campaign_hook' AS campaign_hook,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(last_msg.timestamp, c.created_at)))/60 as minutes_since_last
            FROM conversations c
            JOIN users u ON c.assigned_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT direction, timestamp FROM messages m WHERE m.conversation_id = c.id ORDER BY m.timestamp DESC LIMIT 1
            ) last_msg ON true
            WHERE
                c.state NOT IN ('DEAD', 'ARCHIVED', 'FUNDED', 'FCS_QUEUE')
                AND (
                    -- PRE_VETTED: Always trigger (Vetter reads convo and decides)
                    (c.state = 'PRE_VETTED')
                    OR
                    (
                        (last_msg.direction = 'outbound' OR last_msg.direction IS NULL)
                        AND (
                            (c.state = 'NEW' AND c.created_at < NOW() - INTERVAL '2 minutes')
                            OR
                            (c.state = 'SENT_HOOK' AND last_msg.timestamp < NOW() - INTERVAL '20 minutes')
                            OR
                            (c.state = 'SENT_FU_1' AND last_msg.timestamp < NOW() - INTERVAL '20 minutes')
                            OR
                            (c.state = 'SENT_FU_2' AND last_msg.timestamp < NOW() - INTERVAL '4 hours')
                            OR
                            (c.state = 'SENT_FU_3' AND last_msg.timestamp < NOW() - INTERVAL '24 hours')
                            OR
                            (c.state = 'REPLIED' AND last_msg.timestamp < NOW() - INTERVAL '15 minutes')
                            OR
                            (c.state = 'REPLIED_NUDGE_1' AND last_msg.timestamp < NOW() - INTERVAL '30 minutes')
                            OR
                            (c.state = 'REPLIED_NUDGE_2' AND last_msg.timestamp < NOW() - INTERVAL '60 minutes')
                            OR
                            (c.state = 'HAIL_MARY' AND last_msg.timestamp < NOW() - INTERVAL '75 minutes')
                            OR
                            (c.state = 'VETTING' AND last_msg.timestamp < NOW() - INTERVAL '15 minutes')
                            OR
                            (c.state = 'VETTING_NUDGE_1' AND last_msg.timestamp < NOW() - INTERVAL '30 minutes')
                            OR
                            (c.state = 'VETTING_NUDGE_2' AND last_msg.timestamp < NOW() - INTERVAL '60 minutes')
                            OR
                            (c.state = 'HAIL_MARY_FINAL' AND last_msg.timestamp < NOW() - INTERVAL '24 hours')
                        )
                    )
                )
            LIMIT $1
        `;

        const { rows } = await client.query(query, [BATCH_SIZE]);
        console.log(`📊 Found ${rows.length} leads to process`);
        if (rows.length === 0) { console.log('✅ No leads need attention.'); return; }

        for (const lead of rows) {
            console.log(`➡️ Processing: ${lead.business_name} [${lead.state}]`);
            let instruction = "";
            let nextState = "";
            let shouldTriggerAI = true;

            // --- COLD DRIP LOGIC (Keep as is) ---
            if (lead.state === 'NEW') {
                // Build direct message - no AI needed
                const hook = lead.campaign_hook || "Hi {{first_name}}, my name is {{AGENT_NAME}} im one of the underwriters at JMS Global. I'm currently going over the bank statements and the application you sent in and I wanted to make an offer. What's the best email to send the offer to?";

                const firstName = formatName(lead.first_name) || 'there';
                const agentName = lead.agent_name || 'Dan Torres';

                const directMessage = hook
                    .replace(/\{\{first_name\}\}/gi, firstName)
                    .replace(/\{\{AGENT_NAME\}\}/gi, agentName);

                // Update state FIRST to prevent duplicate pickup
                await client.query(`UPDATE conversations SET state = $1, last_activity = NOW() WHERE id = $2`, ['SENT_HOOK', lead.id]);

                // Then send the message
                await axios.post(BACKEND_URL, {
                    conversation_id: lead.id,
                    direct_message: directMessage
                });
                await new Promise(r => setTimeout(r, 2000));
                continue;
            } else if (lead.state === 'SENT_HOOK') {
                instruction = "Send exactly: 'Did you get funded already?'"; nextState = 'SENT_FU_1';
            } else if (lead.state === 'SENT_FU_1') {
                instruction = "Send exactly: 'The money is expensive as is let me compete.'"; nextState = 'SENT_FU_2';
            } else if (lead.state === 'SENT_FU_2') {
                instruction = "Send exactly: 'Hey just following up again, should i close the file out?'"; nextState = 'SENT_FU_3';
            } else if (lead.state === 'SENT_FU_3') {
                instruction = "Send exactly: 'hey any response would be appreciated here, close this out?'";
                nextState = 'DEAD';
            }

            // --- 🟢 REPLIED NUDGES (Pre-Vetter still gathering info) ---

            else if (lead.state === 'REPLIED') {
                instruction = "NUDGE: They went quiet. Follow up on your last unanswered question.";
                nextState = 'REPLIED_NUDGE_1';

            } else if (lead.state === 'REPLIED_NUDGE_1') {
                instruction = "NUDGE 2: Still no response. Send a short 'you there?' type message.";
                nextState = 'REPLIED_NUDGE_2';

            } else if (lead.state === 'REPLIED_NUDGE_2') {
                instruction = "FINAL NUDGE: Last chance - ask if you should close the file.";
                nextState = 'HAIL_MARY';

            } else if (lead.state === 'HAIL_MARY') {
                console.log(`💀 [${lead.business_name}] Ignored ballpark → DEAD`);
                shouldTriggerAI = false;
                nextState = 'DEAD';
            }

            else if (lead.state === 'HAIL_MARY_FINAL') {
                console.log(`💀 [${lead.business_name}] No response after morning follow-up → DEAD`);
                shouldTriggerAI = false;
                nextState = 'DEAD';
            }

            // --- 🔵 VETTING NUDGES (Vetter pitching) ---

            else if (lead.state === 'VETTING') {
                instruction = "NUDGE: They went quiet after your pitch. Follow up on the offer.";
                nextState = 'VETTING_NUDGE_1';

            } else if (lead.state === 'VETTING_NUDGE_1') {
                instruction = "NUDGE 2: Still no response. Ask if the numbers work or if they need something different.";
                nextState = 'VETTING_NUDGE_2';

            } else if (lead.state === 'VETTING_NUDGE_2') {
                instruction = "FINAL NUDGE: Last chance - ask if you should close the file.";
                nextState = 'DEAD';
            }

            else if (lead.state === 'PRE_VETTED') {
                const strategyCheck = await client.query(
                    `SELECT 1 FROM lead_strategy WHERE conversation_id = $1`,
                    [lead.id]
                );

                if (strategyCheck.rows.length === 0) {
                    console.log(`⏳ [${lead.business_name}] PRE_VETTED - waiting for strategy`);
                    continue;
                }

                console.log(`🔍 [${lead.business_name}] PRE_VETTED → VETTING`);
                instruction = "";
                nextState = 'VETTING';
            }

            try {
                if (shouldTriggerAI) {
                    await axios.post(BACKEND_URL, { conversation_id: lead.id, system_instruction: instruction });
                }
                await client.query(`UPDATE conversations SET state = $1, last_activity = NOW() WHERE id = $2`, [nextState, lead.id]);
                await new Promise(r => setTimeout(r, 2000)); 
            } catch (err) { console.error(err.message); }
        }

    } catch (err) {
        console.error('🔥 Critical Error:', err);
    } finally {
        isRunning = false;
        if (client) client.release();
    }
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
