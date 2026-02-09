require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

// --- CONFIGURATION ---
const BACKEND_URL = "https://mcagent.io/api/agent/trigger";
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 10;        // AI leads per cycle
const NEW_BATCH_SIZE = 50;    // NEW leads per cycle (template-only, no AI)
const NEW_DELAY_MS = 5000;    // 5s between NEW lead sends (safe for Twilio long codes)
const AI_DELAY_MS = 2000;     // 2s between AI lead sends
// ⚡ TURBO MODE: Check every 3 minutes
const RUN_INTERVAL_MS = 3 * 60 * 1000;

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

        // === PASS 1: Blast through NEW leads (no AI, just templates) ===
        const newLeadsQuery = `
            SELECT c.id, c.lead_phone, c.business_name, c.first_name,
                   u.agent_name,
                   u.service_settings->>'campaign_hook' AS campaign_hook
            FROM conversations c
            JOIN users u ON c.assigned_user_id = u.id
            WHERE c.state = 'NEW'
              AND c.ai_enabled != false
              AND c.created_at < NOW() - INTERVAL '1 minute'
            LIMIT $1
        `;

        const newLeads = await client.query(newLeadsQuery, [NEW_BATCH_SIZE]);
        console.log(`📨 NEW leads to hook: ${newLeads.rows.length}`);

        for (const lead of newLeads.rows) {
            try {
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

                await new Promise(r => setTimeout(r, NEW_DELAY_MS));
            } catch (err) {
                console.error(`❌ [${lead.business_name}] Hook error:`, err.message);
            }
        }

        // === PASS 2: AI-driven leads (DRIP, QUALIFIED, ACTIVE, etc.) ===
        const aiLeadsQuery = `
            SELECT c.id, c.lead_phone, c.state, c.business_name, c.first_name,
                   c.nudge_count, u.agent_name,
                   last_msg.direction AS last_direction,
                   EXTRACT(EPOCH FROM (NOW() - c.last_activity))/60 as minutes_idle
            FROM conversations c
            JOIN users u ON c.assigned_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT direction FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.timestamp DESC LIMIT 1
            ) last_msg ON true
            WHERE c.state NOT IN ('NEW', 'DEAD', 'FUNDED', 'SUBMITTED', 'ARCHIVED')
              AND c.ai_enabled != false
              AND (
                  (c.state = 'DRIP' AND c.nudge_count < 4
                   AND c.last_activity < NOW() - CASE
                       WHEN c.nudge_count = 0 THEN INTERVAL '15 minutes'
                       WHEN c.nudge_count = 1 THEN INTERVAL '30 minutes'
                       WHEN c.nudge_count = 2 THEN INTERVAL '1 hour'
                       ELSE INTERVAL '4 hours'
                   END)
                  OR
                  (c.state = 'QUALIFIED' AND c.nudge_count = 0
                   AND c.last_activity < NOW() - INTERVAL '5 minutes')
                  OR
                  (c.state = 'PITCH_READY'
                   AND last_msg.direction = 'inbound'
                   AND c.last_activity < NOW() - INTERVAL '5 minutes')
                  OR
                  (c.state = 'PITCH_READY'
                   AND (last_msg.direction = 'outbound' OR last_msg.direction IS NULL)
                   AND c.nudge_count < 2
                   AND c.last_activity < NOW() - INTERVAL '30 minutes')
                  OR
                  (c.state IN ('ACTIVE', 'CLOSING')
                   AND last_msg.direction = 'inbound'
                   AND c.last_activity < NOW() - INTERVAL '5 minutes')
                  OR
                  (c.state IN ('ACTIVE', 'CLOSING')
                   AND (last_msg.direction = 'outbound' OR last_msg.direction IS NULL)
                   AND c.nudge_count < 3
                   AND c.last_activity < NOW() - INTERVAL '15 minutes' * POWER(2, c.nudge_count))
              )
            LIMIT $1
        `;

        const aiLeads = await client.query(aiLeadsQuery, [BATCH_SIZE]);
        console.log(`🤖 AI leads to process: ${aiLeads.rows.length}`);

        if (newLeads.rows.length === 0 && aiLeads.rows.length === 0) {
            console.log('✅ No leads need attention.');
            return;
        }

        for (const lead of aiLeads.rows) {
            console.log(`➡️ Processing: ${lead.business_name} [${lead.state}] nudge:${lead.nudge_count}`);

            try {
                if (lead.state === 'DRIP') {
                    // DRIP follow-ups - templates, no AI
                    const templates = [
                        "Did you get funded already?",
                        "The money is expensive as is let me compete.",
                        "Hey just following up again, should i close the file out?",
                        "Hey let me know if i should close this out"
                    ];

                    if (lead.nudge_count < templates.length) {
                        await axios.post(BACKEND_URL, {
                            conversation_id: lead.id,
                            direct_message: templates[lead.nudge_count],
                            is_nudge: true
                        });
                    }

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

                } else if (lead.state === 'PITCH_READY') {
                    // Commander has strategy, time to pitch
                    await axios.post(BACKEND_URL, {
                        conversation_id: lead.id,
                        system_instruction: 'PITCH: Present the offer confidently.',
                        is_nudge: true
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

                await new Promise(r => setTimeout(r, AI_DELAY_MS));
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

// --- DAILY REPORT SCHEDULER ---
let lastDailyReport = null;

function checkDailyReport() {
    const now = new Date();
    const estHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    const today = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });

    if (estHour === 22 && lastDailyReport !== today) {
        lastDailyReport = today;
        console.log('📊 10pm EST - Generating daily report');

        const { generateDailyReport } = require('./services/dailyAgent');
        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
        generateDailyReport(dateStr)
            .then(() => console.log('📊 Daily report complete'))
            .catch(err => console.error('📊 Daily report failed:', err.message));
    }
}

setInterval(checkDailyReport, 60 * 1000);
