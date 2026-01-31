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
    // Check business hours (8am - 10pm EST)
    const now = new Date();
    const estHour = parseInt(now.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false
    }));

    if (estHour < 8 || estHour >= 22) {
        console.log(`😴 Outside business hours (${estHour}:00 EST) - sleeping`);
        return;
    }

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
                   c.nudge_count, u.agent_name,
                   u.service_settings->>'campaign_hook' AS campaign_hook,
                   last_msg.direction AS last_direction,
                   EXTRACT(EPOCH FROM (NOW() - c.last_activity))/60 as minutes_idle
            FROM conversations c
            JOIN users u ON c.assigned_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT direction FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.timestamp DESC LIMIT 1
            ) last_msg ON true
            WHERE c.state NOT IN ('DEAD', 'FUNDED', 'SUBMITTED', 'ARCHIVED')
              AND c.ai_enabled != false
              AND (
                  (c.state = 'NEW' AND c.created_at < NOW() - INTERVAL '2 minutes')
                  OR
                  (c.state = 'DRIP' AND c.nudge_count < 4
                   AND c.last_activity < NOW() - INTERVAL '1 hour' * POWER(2, c.nudge_count))
                  OR
                  (c.state IN ('ACTIVE', 'QUALIFIED', 'CLOSING')
                   AND last_msg.direction = 'inbound'
                   AND c.last_activity < NOW() - INTERVAL '2 minutes')
                  OR
                  (c.state IN ('ACTIVE', 'QUALIFIED', 'CLOSING')
                   AND (last_msg.direction = 'outbound' OR last_msg.direction IS NULL)
                   AND c.nudge_count < 3
                   AND c.last_activity < NOW() - INTERVAL '15 minutes' * POWER(2, c.nudge_count))
              )
            LIMIT $1
        `;

        const { rows } = await client.query(query, [BATCH_SIZE]);
        console.log(`📊 Found ${rows.length} leads to process`);
        if (rows.length === 0) { console.log('✅ No leads need attention.'); return; }

        for (const lead of rows) {
            console.log(`➡️ Processing: ${lead.business_name} [${lead.state}] nudge:${lead.nudge_count}`);

            try {
                if (lead.state === 'NEW') {
                    // Send hook directly, no AI needed
                    const hook = lead.campaign_hook || "Hi {{first_name}}, my name is {{AGENT_NAME}}...";
                    const firstName = formatName(lead.first_name) || 'there';
                    const agentName = lead.agent_name || 'Dan Torres';
                    const directMessage = hook
                        .replace(/\{\{first_name\}\}/gi, firstName)
                        .replace(/\{\{AGENT_NAME\}\}/gi, agentName);

                    await axios.post(BACKEND_URL, {
                        conversation_id: lead.id,
                        direct_message: directMessage,
                        next_state: 'DRIP'
                    });
                } else if (lead.state === 'QUALIFIED') {
                    // Lead is qualified - time to soft pitch
                    const isNudge = lead.last_direction === 'outbound' || lead.last_direction === null;

                    let instruction;
                    if (isNudge) {
                        instruction = 'QUALIFIED FOLLOW-UP: You told them you\'d run the numbers. Come back with good news - mention you reviewed their file and have a solid offer ready. Ask if now is a good time to go over it.';
                    } else {
                        instruction = 'QUALIFIED RESPONSE: Lead is qualified and waiting. Present the offer or ask what amount would actually help them.';
                    }

                    await axios.post(BACKEND_URL, {
                        conversation_id: lead.id,
                        system_instruction: instruction
                    });

                } else {
                    // ACTIVE, CLOSING - let AI decide
                    const isNudge = lead.last_direction === 'outbound' || lead.last_direction === null;

                    await axios.post(BACKEND_URL, {
                        conversation_id: lead.id,
                        system_instruction: isNudge ? 'NUDGE: Follow up, they went quiet.' : null,
                        is_nudge: isNudge
                    });
                }

                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                console.error(`❌ [${lead.business_name}] Error:`, err.message);
            }
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
