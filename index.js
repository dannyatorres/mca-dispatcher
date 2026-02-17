require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

// --- CONFIGURATION ---
const BACKEND_URL = "https://mcagent.io/api/agent/trigger";
const DATABASE_URL = process.env.DATABASE_URL;
const NEW_DELAY_MS = 2000;    // 2s between NEW lead sends (safe for Twilio long codes)
const AI_DELAY_MS = 2000;     // 2s between AI lead sends

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

let isDripRunning = false;
let isActiveRunning = false;

async function runDripLoop() {
    const now = new Date();
    const estHour = parseInt(now.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false
    }));

    if (estHour < 8 || estHour >= 22) return;

    const AI_KILLED = false;
    if (AI_KILLED) return;

    if (isDripRunning) {
        console.log('⭕ Drip loop still active - skipping');
        return;
    }
    isDripRunning = true;

    console.log('📨 DRIP LOOP -', new Date().toISOString());
    let client;

    try {
        client = await pool.connect();

        // NEW leads - hook templates
        const newLeadsQuery = `
            SELECT c.id, c.lead_phone, c.business_name, c.first_name,
                   u.agent_name,
                   u.service_settings->>'campaign_hook' AS campaign_hook
            FROM conversations c
            JOIN users u ON c.assigned_user_id = u.id
            WHERE c.state = 'NEW'
              AND c.ai_enabled != false
              AND c.created_at < NOW() - INTERVAL '1 minute'
            FOR UPDATE OF c SKIP LOCKED
            LIMIT 500
        `;

        const newLeads = await client.query(newLeadsQuery, []);
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

        // DRIP leads - follow-up templates
        const dripQuery = `
            SELECT c.id, c.lead_phone, c.state, c.business_name, c.first_name,
                   c.nudge_count, u.agent_name,
                   last_msg.direction AS last_direction
            FROM conversations c
            JOIN users u ON c.assigned_user_id = u.id
            LEFT JOIN LATERAL (
                SELECT direction FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.timestamp DESC LIMIT 1
            ) last_msg ON true
            WHERE c.state = 'DRIP'
              AND c.ai_enabled != false
              AND c.last_activity > NOW() - INTERVAL '3 days'
              AND NOT EXISTS (
                  SELECT 1 FROM messages m2
                  WHERE m2.conversation_id = c.id
                    AND m2.sent_by = 'user'
                    AND m2.direction = 'outbound'
                    AND m2.timestamp > NOW() - INTERVAL '5 minutes'
              )
              AND (
                  -- Inbound: lead replied during drip, switch to AI
                  (last_msg.direction = 'inbound'
                   AND c.last_activity < NOW() - INTERVAL '2 minutes')
                  OR
                  -- Outbound: time for next template
                  (c.nudge_count < 4
                   AND c.last_activity < NOW() - CASE
                       WHEN c.nudge_count = 0 THEN INTERVAL '15 minutes'
                       WHEN c.nudge_count = 1 THEN INTERVAL '30 minutes'
                       WHEN c.nudge_count = 2 THEN INTERVAL '1 hour'
                       ELSE INTERVAL '4 hours'
                   END)
              )
            FOR UPDATE OF c SKIP LOCKED
            LIMIT 500
        `;

        const dripLeads = await client.query(dripQuery, []);
        console.log(`📨 DRIP leads to process: ${dripLeads.rows.length}`);

        for (const lead of dripLeads.rows) {
            try {
                if (lead.last_direction === 'inbound') {
                    console.log(`📬 [${lead.business_name}] Lead replied during DRIP - switching to AI`);
                    await axios.post(BACKEND_URL, {
                        conversation_id: lead.id,
                        system_instruction: null,
                        is_nudge: false
                    });
                } else {
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
                }

                await new Promise(r => setTimeout(r, NEW_DELAY_MS));
            } catch (err) {
                console.error(`❌ [${lead.business_name}] Drip error:`, err.message);
            }
        }

    } catch (err) {
        console.error('🔥 Drip Loop Error:', err);
    } finally {
        isDripRunning = false;
        if (client) client.release();
    }
}

async function runActiveLoop() {
    const now = new Date();
    const estHour = parseInt(now.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false
    }));

    if (estHour < 8 || estHour >= 22) {
        console.log(`😴 Outside business hours (${estHour}:00 EST)`);
        return;
    }

    const AI_KILLED = false;
    if (AI_KILLED) return;

    if (isActiveRunning) {
        console.log('⭕ Active loop still active - skipping');
        return;
    }
    isActiveRunning = true;

    console.log('🤖 ACTIVE LOOP -', new Date().toISOString());
    let client;

    try {
        client = await pool.connect();

        const activeQuery = `
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
            WHERE c.state IN ('ACTIVE', 'CLOSING')
              AND c.ai_enabled != false
              AND c.last_activity > NOW() - INTERVAL '3 days'
              AND NOT EXISTS (
                  SELECT 1 FROM messages m2
                  WHERE m2.conversation_id = c.id
                    AND m2.sent_by = 'user'
                    AND m2.direction = 'outbound'
                    AND m2.timestamp > NOW() - INTERVAL '5 minutes'
              )
              AND (
                  -- INBOUND: Lead replied, respond fast
                  (last_msg.direction = 'inbound'
                   AND c.last_activity < NOW() - INTERVAL '2 minutes')
                  OR
                  -- OUTBOUND NUDGE: They went quiet
                  ((last_msg.direction = 'outbound' OR last_msg.direction IS NULL)
                   AND c.nudge_count < 6
                   AND c.last_activity < NOW() - CASE
                       WHEN c.nudge_count = 0 THEN INTERVAL '15 minutes'
                       WHEN c.nudge_count = 1 THEN INTERVAL '30 minutes'
                       WHEN c.nudge_count = 2 THEN INTERVAL '1 hour'
                       WHEN c.nudge_count = 3 THEN INTERVAL '4 hours'
                       WHEN c.nudge_count = 4 THEN INTERVAL '8 hours'
                       ELSE INTERVAL '24 hours'
                   END)
              )
            ORDER BY
                CASE WHEN last_msg.direction = 'inbound' THEN 0 ELSE 1 END,
                c.last_activity ASC
            FOR UPDATE OF c SKIP LOCKED
            LIMIT 200
        `;

        const activeLeads = await client.query(activeQuery, []);
        console.log(`🤖 Active leads to process: ${activeLeads.rows.length}`);

        for (const lead of activeLeads.rows) {
            console.log(`➡️ Processing: ${lead.business_name} [${lead.state}] nudge:${lead.nudge_count}`);

            try {
                const isNudge = lead.last_direction === 'outbound' || lead.last_direction === null;

                await axios.post(BACKEND_URL, {
                    conversation_id: lead.id,
                    system_instruction: isNudge ? `NUDGE #${lead.nudge_count + 1}` : null,
                    is_nudge: isNudge
                });

                await new Promise(r => setTimeout(r, AI_DELAY_MS));
            } catch (err) {
                console.error(`❌ [${lead.business_name}] Error:`, err.message);
            }
        }

    } catch (err) {
        console.error('🔥 Active Loop Error:', err);
    } finally {
        isActiveRunning = false;
        if (client) client.release();
    }
}

// Drip loop - every 60s (templates are fast)
async function dripLoop() {
    await runDripLoop();
    setTimeout(dripLoop, 60 * 1000);
}

// Active loop - every 30s (prioritize responsiveness)
async function activeLoop() {
    await runActiveLoop();
    setTimeout(activeLoop, 30 * 1000);
}

dripLoop();
activeLoop();

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

        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
        axios.post(BACKEND_URL.replace('/api/agent/trigger', '/api/daily-reports/generate'), { date: dateStr }, {
            headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET }
        })
            .then(() => console.log('📊 Daily report triggered via API'))
            .catch(err => console.error('📊 Daily report trigger failed:', err.message));
    }
}

setInterval(checkDailyReport, 60 * 1000);
