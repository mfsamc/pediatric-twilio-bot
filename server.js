// ============================================================
// Pediatric AI Pre-Consultation WhatsApp Bot
// Powered by Twilio WhatsApp Sandbox + OpenRouter Free LLM
// ============================================================

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const app = express();
// Twilio sends webhooks as URL encoded form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Configuration from Environment Variables ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER; // e.g. +14155238886
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PORT = process.env.PORT || 3000;

let twilioClient;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// --- Patient Database (JSON file) ---
const DB_PATH = path.join(__dirname, 'patients.json');

function loadDB() {
    try {
        if (fs.existsSync(DB_PATH)) {
            return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        }
    } catch(e) { console.error('DB load error:', e); }
    return { patients: {} };
}

function saveDB(db) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    } catch(e) { console.error('DB save error:', e); }
}

// --- In-memory conversation store (keyed by phone number) ---
const conversations = {};

// --- Clinical System Prompt ---
const SYSTEM_PROMPT = `
You are an elite, empathetic, and rigorous Pediatric Pre-Consultation AI Assistant.
Target Audience: Parents/Caregivers of pediatric patients.
Core Function: Automated, culturally sensitive, clinically rigorous history extraction.
Platform: WhatsApp — keep responses concise and conversational (2-4 sentences max per reply).

**Part A: Global AI Guardrails**
1. The Objective Reporter: NEVER provide medical advice/diagnoses. Use Deflection: "I am an assistant. The doctor will examine your child and provide the diagnosis."
2. Terminology Verification: Never accept advanced medical jargon without asking to see/describe it.
3. Zero Assumptions: Record exactly what is described.
4. Normalizing Language: Use validating prefaces for sensitive questions.
5. Sequential Processing: Ask ONE question at a time.
6. Multilingual: ALWAYS respond in the EXACT language the user writes in. If they write in Urdu, reply in Urdu script. If in English, reply in English.

**Part B: Conversational Phases**
Guide the user sequentially. DO NOT move to the next phase until the current one is complete.
Phase 0: Demographic Intake (Name, Gender, Residence, Age).
Phase 1: Presenting Complaints (Main reason, exact temporal sequence for when EACH symptom started).
Phase 2: HPI & Systems Review (Elaborate on complaint severity, use Differential Interrogation explicitly, screen 'Red Flags' like lethargy/fluid output).
Phase 3: Past, Neonatal & Immunization.
Phase 4: Dietary, Family & Allergy (Confirm feeding hygiene, cousin marriage, Allergies).
Phase 5: Developmental & Social (Developmental milestones based on age, Environment).

**Part C: Doctor's Output Synthesis**
When Phase 5 is completed, output ONLY a raw JSON string matching this exact structure:
{
  "status": "COMPLETED",
  "data": {
    "demographics": { "name": "...", "gender": "...", "age": "...", "residence": "...", "entitlement": "..." },
    "complaints": ["symptom 1 x duration", "symptom 2 x duration"],
    "hpi": { "details": "...", "impact": "...", "systemic": "..." },
    "background": { "birth": "...", "diet": "...", "immunization": "...", "development": "...", "family": "..." },
    "problems": [
        { "type": "provisional", "text": "Provisional Diagnosis: ..." },
        { "type": "differential", "text": "Diff: ..." },
        { "type": "active", "text": "Active: ..." }
    ]
  }
}
WARNING: While chatting normally, NEVER output JSON. Only output JSON right at the very end.
`;

// --- OpenRouter LLM Call with Auto-Fallback ---
const FREE_MODELS = [
    "google/gemma-3-27b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "mistralai/mistral-small-3.1-24b-instruct:free",
    "qwen/qwen3-4b:free"
];

async function callLLM(messages) {
    for (const model of FREE_MODELS) {
        try {
            const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: model,
                messages: messages,
                temperature: 0.2
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://pediatric-ai-bot.onrender.com',
                    'X-Title': 'Pediatric AI WhatsApp Bot'
                },
                timeout: 30000
            });

            if (response.data && response.data.choices && response.data.choices[0]) {
                console.log(`[LLM] Used model: ${model}`);
                return response.data.choices[0].message.content.trim();
            }
        } catch(e) {
            const errMsg = e.response?.data?.error?.message || e.message;
            console.warn(`[LLM] Model ${model} failed: ${errMsg}`);
            continue;
        }
    }
    return "I'm sorry, I'm experiencing technical difficulties. Please try again in a moment. / معذرت، ابھی تکنیکی مسئلہ ہے۔ براہ کرم ایک لمحے میں دوبارہ کوشش کریں۔";
}

// --- WhatsApp Message Sender ---
async function sendWhatsAppMessage(to, text) {
    if (!twilioClient) {
        console.error('[WA] Twilio client not initialized. Cannot send message.');
        return;
    }

    try {
        await twilioClient.messages.create({
            body: text,
            from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
            to: to // Twilio webhooks pass the sender as 'whatsapp:+1234567890'
        });
        console.log(`[WA] Sent reply to ${to}`);
    } catch(e) {
        console.error('[WA] Send failed:', e.message);
    }
}

// --- Process Incoming Message ---
async function processMessage(from, messageText) {
    // Initialize conversation if new
    if (!conversations[from]) {
        conversations[from] = {
            history: [],
            patientId: 'PT-' + Math.floor(1000 + Math.random() * 9000),
            startedAt: new Date().toISOString()
        };
        console.log(`[NEW] Patient conversation started: ${from} -> ${conversations[from].patientId}`);
    }

    const conv = conversations[from];
    conv.history.push({ role: "user", content: messageText });

    // Build messages array for LLM
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...conv.history.map(m => ({
            role: m.role === "bot" ? "assistant" : m.role,
            content: m.content
        }))
    ];

    // Get AI response
    const reply = await callLLM(messages);

    // Check if conversation is complete (JSON dashboard)
    if (reply.includes('"status": "COMPLETED"') || (reply.includes("{") && reply.includes('"demographics"'))) {
        try {
            const jsonClean = reply.replace(/&#x60;&#x60;&#x60;json/g, '').replace(/&#x60;&#x60;&#x60;/g, '').trim();
            const si = jsonClean.indexOf('{'), ei = jsonClean.lastIndexOf('}');
            if (si !== -1 && ei !== -1) {
                const dashData = JSON.parse(jsonClean.substring(si, ei + 1));
                
                // Save to database
                const db = loadDB();
                db.patients[from] = {
                    id: conv.patientId,
                    phone: from.replace('whatsapp:', ''),
                    demographics: dashData.data.demographics,
                    encounters: db.patients[from]?.encounters || [],
                };
                db.patients[from].encounters.push({
                    date: new Date().toISOString(),
                    data: dashData.data,
                    messageCount: conv.history.length
                });
                saveDB(db);

                // Send completion message
                await sendWhatsAppMessage(from, 
                    "✅ Thank you! Your child's pre-consultation history has been compiled and sent to the doctor.\n\n" +
                    "شکریہ! آپ کے بچے کی پری کنسلٹیشن ہسٹری ڈاکٹر کو بھیج دی گئی ہے۔\n\n" +
                    `Patient ID: ${conv.patientId}`
                );

                // Clear conversation for next visit
                delete conversations[from];
                console.log(`[DONE] Encounter finalized for ${from}`);
                return;
            }
        } catch(e) {
            console.error('[JSON] Parse error:', e);
        }
    }

    // Store bot reply and send
    conv.history.push({ role: "bot", content: reply });
    await sendWhatsAppMessage(from, reply);
}

// ============================================================
// ROUTES
// ============================================================

// --- Webhook Receiver (Twilio sends POST with form data) ---
app.post('/webhook', async (req, res) => {
    // Twilio expects a valid empty TwiML response. We'll send it immediately.
    res.type('text/xml');
    res.status(200).send('<Response></Response>');

    try {
        const from = req.body.From; // e.g. "whatsapp:+1234567890"
        const messageText = req.body.Body;

        if (from && messageText) {
            console.log(`[MSG] From ${from}: ${messageText}`);
            await processMessage(from, messageText);
        } else if (req.body.MediaUrl0) {
            // Voice notes, images etc — tell user to type for now
            await sendWhatsAppMessage(from, 
                "I can currently only read text messages. Please type your response.\n" +
                "ابھی میں صرف ٹیکسٹ پڑھ سکتا ہوں۔ براہ کرم ٹائپ کریں۔"
            );
        }
    } catch(e) {
        console.error('[WEBHOOK] Error processing:', e);
    }
});

// --- Doctor Dashboard ---
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// --- Dashboard API ---
app.get('/api/patients', (req, res) => {
    const db = loadDB();
    res.json(db);
});

// --- Health Check ---
app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        service: 'Pediatric AI WhatsApp Bot (Twilio)',
        activeConversations: Object.keys(conversations).length,
        totalPatients: Object.keys(loadDB().patients).length
    });
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log('============================================');
    console.log('  Pediatric AI WhatsApp Bot (Twilio)');
    console.log(`  Running on port ${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
    console.log('============================================');
    
    if (!TWILIO_ACCOUNT_SID) console.warn('⚠️  TWILIO_ACCOUNT_SID not set!');
    if (!TWILIO_AUTH_TOKEN) console.warn('⚠️  TWILIO_AUTH_TOKEN not set!');
    if (!TWILIO_PHONE_NUMBER) console.warn('⚠️  TWILIO_PHONE_NUMBER not set!');
    if (!OPENROUTER_API_KEY) console.warn('⚠️  OPENROUTER_API_KEY not set!');
});
