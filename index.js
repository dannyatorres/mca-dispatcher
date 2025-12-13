require('dotenv').config();
const axios = require('axios');

// --- CONFIGURATION ---
// Point to your own backend instead of n8n
const BACKEND_URL = process.env.BACKEND_URL || process.env.N8N_WEBHOOK_URL; // Support legacy var name

const BATCH_SIZE = 10;       // Max leads to process per run
const WAIT_TIME_MS = 5000;   // 5 Seconds (Twilio Safety Buffer)
const RUN_INTERVAL_MS = 15 * 60 * 1000; // Run every 15 minutes

// Check for missing URL
if (!BACKEND_URL) {
    console.error("❌ ERROR: BACKEND_URL is missing from Environment Variables.");
    console.error("   Set BACKEND_URL to your CRM backend (e.g., https://your-crm.up.railway.app)");
    process.exit(1);
}

console.log(`🔗 Backend URL: ${BACKEND_URL}`);

async function runDispatcher() {
    console.log('⏰ Starting Dispatcher Run:', new Date().toISOString());

    try {
        // 1. FIND LEADS that need processing (from backend API)
        console.log('🔍 Fetching leads from backend...');
        const findResponse = await axios.get(`${BACKEND_URL}/api/dispatcher/find-leads`, {
            params: { limit: BATCH_SIZE }
        });

        if (!findResponse.data.success) {
            console.error('❌ Failed to find leads:', findResponse.data.error);
            return;
        }

        const leads = findResponse.data.leads || [];

        if (leads.length === 0) {
            console.log('✅ No leads need attention right now.');
            return;
        }

        console.log(`📋 Found ${leads.length} leads to process. Starting loop...`);

        // 2. PROCESS EACH LEAD
        for (const lead of leads) {
            console.log(`🚀 Triggering AI for ${lead.state} lead: ${lead.business_name || lead.lead_phone}`);

            // Determine the instruction based on state
            let instruction = "";
            if (lead.state === 'NEW') {
                instruction = "This is a NEW lead. Send an initial friendly outreach message introduction.";
            } else {
                instruction = `User hasn't replied in ${Math.round(lead.hours_since_last_action)} hours. Review history and send a polite follow-up.`;
            }

            try {
                // A. Call AI Agent to process lead
                const agentResponse = await axios.post(`${BACKEND_URL}/api/agent/trigger`, {
                    conversation_id: lead.id,
                    system_instruction: instruction
                });

                console.log(`✅ AI processed lead ${lead.id}:`, agentResponse.data);

                // B. Mark lead as processed (updates last_activity timestamp)
                await axios.post(`${BACKEND_URL}/api/dispatcher/mark-processed`, {
                    conversation_id: lead.id
                });

                console.log(`✅ Lead ${lead.id} marked as processed`);

                // C. THROTTLE: Wait 5 seconds before the next one
                await new Promise(r => setTimeout(r, WAIT_TIME_MS));

            } catch (err) {
                console.error(`❌ Failed to process lead ${lead.id}:`, err.message);
                if (err.response) {
                    console.error(`   Status: ${err.response.status}`);
                    console.error(`   Data:`, err.response.data);
                }
            }
        }

        console.log('✅ Dispatcher run completed');

    } catch (err) {
        console.error('🔥 Critical Dispatcher Error:', err.message);
        if (err.response) {
            console.error('   Response Status:', err.response.status);
            console.error('   Response Data:', err.response.data);
        }
    }
}

// Start the loop
console.log('🚀 Dispatcher Service Started');
runDispatcher(); // Run once immediately on start
setInterval(runDispatcher, RUN_INTERVAL_MS); // Then repeat every 15 mins
