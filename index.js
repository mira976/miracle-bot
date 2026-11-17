const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
let lastQR = '';
let sock;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OWNER_NUMBER = process.env.OWNER_NUMBER || '2349123358519';
const MODEL_TEXT = "openai/gpt-oss-120b";
const MODEL_FALLBACK = "openai/gpt-oss-20b";
const MODEL_VISION = "meta-llama/llama-4-scout-17b-16e-instruct";
const MODEL_WHISPER = "whisper-large-v3";
const MODEL_TTS = "playai-tts";

let isOfflineMode = false;
let lastOwnerReply = {};
let hasSentOfflineMsg = {};
let waitingForDropMessage = {};
let droppedMessages = {};
let botSentIds = new Set();
let userBuffers = {};
let userTimers = {};
let userHasBeenGreeted = {};

// --- PORTFOLIO - PROFESSIONAL ---
const PORTFOLIO_LINK = 'https://miracle-tech.netlify.app/';
const PORTFOLIO_CAPTION = `MIRA-TECH | Websites That Sell

Need a website for your business?

- E-commerce Website — ₦100,000 | 3-5 days
- Business Website — ₦80,000 | 2-3 days
- Landing Page — ₦50,000 | 1-2 days

Trusted by 15+ businesses: Proofmee Fibon Solar, Azon Gadget Store, Ping AI.

View my work:
https://miracle-tech.netlify.app/

DM to start your project.
Miracle — +234 912 335 8519`;
let lastStatusPostedDate = '';
let lastMondayStatusPostedDate = '';

async function postPortfolioStatus() {
  if (!sock) return false;
  try {
    console.log('📢 Sending Status to Miracle to post - so he will SEE it...');
    // We do NOT use status@broadcast anymore because you cannot see it on your own phone.
    // Bot sends it to YOU, you forward to Status in 2 seconds and YOU WILL SEE IT.
    await botSend(OWNER_NUMBER + '@s.whatsapp.net', {
      text: `📢 YOUR STATUS IS READY - POST IT NOW\n\nTap and hold this message below, tap Forward > My Status > Send. You will see it immediately.\n\n--- COPY BELOW ---\n\n${PORTFOLIO_CAPTION}`
    });
    console.log('✅ Status sent to Miracle for posting');
    return true;
  } catch (e) { console.log('❌ Failed:', e.message); return false; }
}
async function postStatusOnChat() {
  const today = new Date().toDateString();
  if (lastStatusPostedDate === today) return;
  lastStatusPostedDate = today;
  await postPortfolioStatus();
}
function startMondayStatusJob() {
  setInterval(async () => {
    try {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
      const isMonday = now.getDay() === 1;
      const is9AM = now.getHours() === 9 && now.getMinutes() < 2;
      const today = now.toDateString();
      if (isMonday && is9AM && lastMondayStatusPostedDate !== today) {
        lastMondayStatusPostedDate = today;
        lastStatusPostedDate = today;
        await postPortfolioStatus();
      }
    } catch (e) {}
  }, 60 * 1000);
  console.log('📅 Monday Status Job Started - Every Monday 9AM Lagos');
}

async function botSend(from, content) {
  if (content.text && content.text.includes('miracle-tech.netlify.app')) {
    content.linkPreview = true;
  }
  const sent = await sock.sendMessage(from, content);
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  return sent;
}

// Check if user is asking Bot a question about services / Bot itself - Bot should ALWAYS answer these
function isBotQuestion(text) {
  const t = text.toLowerCase();
  return t.includes('price') || t.includes('cost') || t.includes('how much') || t.includes('how much is') ||
    t.includes('what do you do') || t.includes('what can you do') || t.includes('services') || t.includes('service') ||
    t.includes('portfolio') || t.includes('your work') || t.includes('his work') || t.includes('show me') ||
    t.includes('website') || t.includes('e-commerce') || t.includes('ecommerce') || t.includes('landing page') ||
    t.includes('business website') || t.includes('how long') || t.includes('how many days') ||
    t.includes('who be this') || t.includes('who are you') || t.includes('who is this') || t.includes('what is your name') ||
    t.includes('wetin be your name') || t.includes('who be you') || t.includes('are you miracle') || t.includes('are you real') ||
    t.includes('where are you') || t.includes('where is miracle') || t.includes('when will he') || t.includes('when will miracle') ||
    t.includes('can you') || t.includes('do you build') || t.includes('do you do') || t.includes('do you make');
}

const SYSTEM_PROMPT = `You are Miracle Virtual AI Assistant. You handle Miracle's WhatsApp when he is NOT on WhatsApp.

Miracle is a web developer in Lagos.
Email: mchansvi@gmail.com
WhatsApp: +2349123358519
Portfolio: https://miracle-tech.netlify.app/
Services: E-commerce N100,000 (3-5 days), Business Website N80,000 (2-3 days), Landing Page N50,000 (1-2 days)
Projects: Proofmee Fibon Solar, Azon Gadget Store, Ping AI. Built 15+ websites.

VERY IMPORTANT - EVERY REPLY MUST START LIKE THIS (in user's language):
First tell them: You are Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please.
Then answer their question.
Then add portfolio link: https://miracle-tech.netlify.app/

Example in English: "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. [Answer their question here]. Check his work here: https://miracle-tech.netlify.app/"
Example in Pidgin: "Na Miracle Virtual AI Assistant be this, na me dey handle am. Him no dey WhatsApp now, abeg try again later. [Answer here]. Check him work here: https://miracle-tech.netlify.app/"

GOLDEN RULE - LANGUAGE:
Reply EXACTLY the way user chatted you. EXACTLY the language user used.
- Pidgin -> Pidgin, English -> English, Igbo -> Igbo, Yoruba -> Yoruba, Hausa -> Hausa, French -> French, Spanish -> Spanish, German -> German, Chinese -> Chinese, ANY language -> SAME language.
- If user says "how far", reply "I dey". Copy their energy, slang, vibe. Never force English.
- Never say "As an AI". You are Miracle Virtual AI Assistant.

VOICE NOTE RULE:
When you reply with VOICE NOTE, ALWAYS use ENGLISH ONLY. Even if user spoke Pidgin or any language, voice must be clean clear English. But still start with "I am Miracle Virtual AI Assistant, he is not on WhatsApp now, try again later please."

OTHER RULES:
- Talk like real human, short and natural for WhatsApp.
- If user is Dad or Mum, be respectful, call them Sir / Ma.
- You are NOT Miracle. Miracle is your boss.
`;

async function callGroq(messages) {
  let res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_TEXT, messages, temperature: 0.75, max_tokens: 600 })
  });
  if (!res.ok) {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_FALLBACK, messages, temperature: 0.75, max_tokens: 600 })
    });
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function getOfflineMessage(userText) {
  try {
    let translated = await callGroq([
      { role: 'system', content: `You are a translator. User wrote: "${userText}". Detect EXACT language and style. Translate to that SAME language: "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please." Return ONLY translation.` },
      { role: 'user', content: userText }
    ]);
    if (translated && translated.trim()) return translated.trim();
  } catch (e) { }
  return "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please.";
}

async function transcribeVoice(buffer) {
  const form = new FormData();
  form.append('file', buffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
  form.append('model', MODEL_WHISPER);
  form.append('response_format', 'json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, ...form.getHeaders() },
    body: form
  });
  const data = await res.json();
  return data.text || '';
}

async function textToVoiceEnglish(text) {
  try {
    let englishText = await callGroq([
      { role: 'system', content: `Translate to clean clear simple English for voice note. Keep short, natural. Return ONLY English. Text: "${text}"` },
      { role: 'user', content: text }
    ]);
    if (!englishText) englishText = text;
    const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_TTS, input: englishText.trim(), voice: 'Atlas-PlayAI', response_format: 'wav' })
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) { return null; }
}

async function understandImage(base64Image, caption) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_VISION,
      messages: [{ role: "user", content: [{ type: "text", text: `You are Miracle Virtual AI Assistant. User sent image. Caption: "${caption}". First say in user's language: I am Miracle Virtual AI Assistant, he is not on WhatsApp now, try again later. Then reply about image. Keep short.` }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }],
      max_tokens: 600
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function smartLocalReply(q) {
  const t = q.toLowerCase();
  if (t.includes('price') || t.includes('cost') || t.includes('how much')) return `E-commerce Store - N100,000 (3-5 days)\nBusiness Website - N80,000 (2-3 days)\nLanding Page - N50,000 (1-2 days)\n\nCheck his work: https://miracle-tech.netlify.app/\n\nWhich one fits your business?`;
  if (t.includes('project') || t.includes('work') || t.includes('portfolio')) return `Miracle has built 15+ websites: Proofmee Fibon Solar, Azon Gadget Store, Ping AI. Check them here: https://miracle-tech.netlify.app/ Which type you want?`;
  return `Hello, welcome. What would you like to build today? E-commerce, Business Website, or Landing Page? Check his work: https://miracle-tech.netlify.app/`;
}

async function downloadBuffer(msg, type) {
  const stream = await downloadContentFromMessage(msg, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
  return buffer;
}

// Process all messages user sent together, after they finished - WAIT SYSTEM
async function processUserBatch(from) {
  if (!from || from === 'status@broadcast' || from.includes('status@broadcast') || from.includes('@broadcast')) return;
  const batch = userBuffers[from] || [];
  userBuffers[from] = [];
  if (userTimers[from]) { clearTimeout(userTimers[from]); delete userTimers[from]; }
  if (batch.length === 0) return;

  console.log(`📦 Processing batch for ${from}: ${batch.length} messages`);

  let hasSticker = batch.some(b => b.type === 'sticker');
  let hasVoice = batch.some(b => b.type === 'voice');
  let hasImage = batch.some(b => b.type === 'image');
  let hasVideo = batch.some(b => b.type === 'video');
  let hasDocument = batch.some(b => b.type === 'document');
  let allTexts = batch.filter(b => b.type === 'text').map(b => b.text).join('\n');
  let firstText = batch[0].text || '';
  let lowerAll = allTexts.toLowerCase().trim();

  if (!allTexts && !hasVoice && !hasImage && !hasVideo && !hasDocument && !hasSticker) return;

  // --- AFTER USER DROPPED MESSAGE: Bot should NOT reply again, EXCEPT if user is asking Bot a question ---
  if (lastOwnerReply[from]) {
    if (isBotQuestion(allTexts)) {
      // User is asking Bot a question after dropping message - Bot SHOULD talk as assistant
      console.log(`❓ User ${from} asked Bot a question after dropping message - Bot will answer`);
      delete lastOwnerReply[from]; // Allow Bot to answer this question
      // Fall through to question handling below
    } else {
      console.log(`🔇 User ${from} already dropped message - Bot stays silent`);
      return;
    }
  }

  // --- USER SAYS STOP ---
  if (lowerAll === 'stop' || lowerAll.includes('stop replying') || lowerAll.includes('stop disturbing') || lowerAll.includes('leave me alone') || lowerAll.includes('do not reply') || lowerAll.includes("don't reply") || lowerAll.includes('dont reply') || lowerAll.includes('stop messaging') || lowerAll.includes('stop chatting') || lowerAll.includes('stop texting')) {
    lastOwnerReply[from] = Date.now();
    await botSend(from, { text: "Okay, I understand. I will stop replying now. If you need Miracle, you can message him directly on +2349123358519. Have a good day." });
    return;
  }

  // --- STICKER ONLY ---
  if (hasSticker && batch.length === 1 && !allTexts) {
    let reply = await callGroq([
      { role: 'system', content: SYSTEM_PROMPT + `\n\nUser sent a STICKER. Reply friendly. Say: "Nice sticker 😄 I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. Send your message for him." Keep short.` },
      { role: 'user', content: '[User sent a sticker]' }
    ]);
    if (!reply) reply = "Nice sticker 😄 I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. Send your message for him.";
    await botSend(from, { text: reply.replace(/\*\*/g, '').trim() });
    await postStatusOnChat();
    return;
  }

  // --- GREETING - Hi / Hello -> 2 Messages - LOCAL GREETING, NO AI MIX ---
  const greetings = ['hi', 'hello', 'hey', 'hii', 'hiii', 'heyy', 'how far', 'how are you', 'good morning', 'good afternoon', 'good evening', 'morning', 'afternoon', 'evening', 'yo', 'sup', 'wassup', 'hola', 'bonjour', 'salut', 'ciao', 'hallo', 'sannu', 'ndewo', 'bawo', 'e nle', 'kedu', 'nnoo', 'e kaaro', 'selam', 'ola', 'oi'];
  const cleanGreet = lowerAll.replace(/[!?. ,]/g, '').trim();
  const isGreetingOnly = batch.length === 1 && !hasVoice && !hasImage && !hasSticker && greetings.includes(cleanGreet);

  if (isGreetingOnly && !userHasBeenGreeted[from]) {
    userHasBeenGreeted[from] = true;
    const lowerFirst = firstText.toLowerCase().trim();
    let greetReply = "Hello!";
    if (lowerFirst.includes('how far')) greetReply = "How far, I dey o 👋";
    else if (lowerFirst.includes('good morning')) greetReply = "Good morning!";
    else if (lowerFirst.includes('good afternoon')) greetReply = "Good afternoon!";
    else if (lowerFirst.includes('good evening')) greetReply = "Good evening!";
    else if (lowerFirst.includes('hola')) greetReply = "Hola!";
    else if (lowerFirst.includes('bonjour')) greetReply = "Bonjour!";
    else if (lowerFirst.includes('salut')) greetReply = "Salut!";
    else if (lowerFirst.includes('ciao')) greetReply = "Ciao!";
    else if (lowerFirst.includes('sannu')) greetReply = "Sannu!";
    else if (lowerFirst.includes('ndewo')) greetReply = "Ndewo!";
    else if (lowerFirst.includes('bawo') || lowerFirst.includes('e nle')) greetReply = "E nle!";
    else if (lowerFirst.includes('kedu')) greetReply = "Kedu!";
    else if (lowerFirst.includes('yo') || lowerFirst.includes('sup')) greetReply = "Yo, what's up?";
    else if (lowerFirst.includes('hi') || lowerFirst.includes('hello') || lowerFirst.includes('hey')) greetReply = "Hello!";

    let introReply = await callGroq([
      { role: 'system', content: `IGNORE the rule that says EVERY reply must start with intro. For THIS message only, you are sending the SECOND message. You MUST say: "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. What is your message for him?" Translate that to EXACT same language user used. Return ONLY that, nothing else, no link.` },
      { role: 'user', content: firstText }
    ]);
    if (!introReply) introReply = "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. What is your message for him?";
    await botSend(from, { text: greetReply.replace(/\*\*/g, '').trim() });
    await new Promise(r => setTimeout(r, 1000));
    await botSend(from, { text: introReply.replace(/\*\*/g, '').trim() });
    await postStatusOnChat();
    return;
  }

  // --- BOT QUESTION: User asking about price / services / Bot itself - Bot MUST answer as assistant, do NOT forward, do NOT stop ---
  if (isBotQuestion(allTexts) && !hasVoice && !hasImage && batch.length >= 1 && !lowerAll.includes('tell him') && !lowerAll.includes('tell miracle')) {
    // But if user already dropped message before, we already allowed it above. Answer here and keep Bot alive.
    let answer = await callGroq([
      { role: 'system', content: SYSTEM_PROMPT + `\n\nUser is asking you a QUESTION about Miracle / services / price / who you are. Answer as his assistant in EXACT same language user used. Be professional, short, helpful. Add portfolio link at end. Do NOT say "Thanks for your message" and do NOT stop talking.` },
      { role: 'user', content: firstText }
    ]);
    if (!answer) answer = "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. Check his work: https://miracle-tech.netlify.app/";
    await botSend(from, { text: answer.replace(/\*\*/g, '').trim() });
    // Do NOT set lastOwnerReply here - Bot stays alive to answer more questions
    return;
  }

  // --- WHO BE THIS? ---
  if (lowerAll.includes('who be this') || lowerAll.includes('who are you') || lowerAll.includes('who is this') || lowerAll.includes('wetin be your name') || lowerAll.includes('what is your name') || lowerAll.includes('who be you') || lowerAll.includes('tani e') || lowerAll.includes('kedu onye') || lowerAll.includes('qui es-tu') || lowerAll.includes('quien eres') || lowerAll.includes('wer bist du') || lowerAll.includes('chi sei')) {
    let intro = await callGroq([
      { role: 'system', content: SYSTEM_PROMPT + "\n\nUser is asking who you are. Introduce yourself as Miracle Virtual AI Assistant in EXACT same language user used. Say he is not on WhatsApp now, try again later. Add portfolio link." },
      { role: 'user', content: firstText }
    ]);
    if (!intro) intro = "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. Check his work: https://miracle-tech.netlify.app/";
    await botSend(from, { text: intro.replace(/\*\*/g, '').trim() });
    await postStatusOnChat();
    return;
  }

  // --- USER SAYS OK (including typos like Okn) ---
  const okWords = ['ok', 'okay', 'okn', 'okk', 'okey', 'okay o', 'ok na', 'alright', 'fine', 'yes', 'k', 'kk', 'yea', 'yeah', 'no wahala', 'good'];
  const cleanOk = lowerAll.replace(/[!?. ,]/g, '').trim();
  if (okWords.includes(cleanOk) || lowerAll.startsWith('okn')) {
    let askMsg = await callGroq([
      { role: 'system', content: `IGNORE the rule that says add portfolio link. For THIS message ONLY, do NOT add any link. You MUST say in EXACT same language: "Okay, send your message now, I will give it to my Boss." Return ONLY that.` },
      { role: 'user', content: firstText }
    ]);
    if (!askMsg) askMsg = "Okay, send your message now, I will give it to my Boss.";
    await botSend(from, { text: askMsg.replace(/\*\*/g, '').trim() });
    return;
  }

  // --- USER WANTS TO DROP MESSAGE ---
  const wantsToDrop = lowerAll.includes('drop message') || lowerAll.includes('leave a message') || lowerAll.includes('tell him') || lowerAll.includes('tell miracle') || lowerAll.includes('tell am') || lowerAll.includes('tell your oga') || lowerAll.includes('tell your boss') || lowerAll.includes('help me tell') || lowerAll.includes('i wan tell') || lowerAll.includes('message for him') || lowerAll.includes('message for miracle') || lowerAll.includes('can you tell') || lowerAll.includes('please tell') || lowerAll.includes('abeg tell') || lowerAll.includes('pass my message');
  if (wantsToDrop && !hasVoice && !hasImage && batch.length === 1 && allTexts.split(' ').length < 8) {
    let askMsg = await callGroq([
      { role: 'system', content: `IGNORE the rule that says add portfolio link. For THIS message ONLY, do NOT add any link. You MUST say in EXACT same language user used: "Okay, drop your message now, I will tell Miracle when he comes online." Return ONLY that, no link, no extra intro.` },
      { role: 'user', content: firstText }
    ]);
    if (!askMsg) askMsg = "Okay, drop your message now, I will tell Miracle when he comes online.";
    await botSend(from, { text: askMsg.replace(/\*\*/g, '').trim() });
    return;
  }

  // --- USER HAS FINISHED SENDING MESSAGE FOR MIRACLE - Forward to Miracle + Professional Closing + STOP ---
  let summaryForMiracle = `📩 NEW MESSAGE FOR YOU from ${from}:\n\n`;
  if (allTexts) summaryForMiracle += `Text: "${allTexts}"\n`;
  if (hasVoice) summaryForMiracle += `+ Voice Note\n`;
  if (hasImage) summaryForMiracle += `+ Image\n`;
  if (hasVideo) summaryForMiracle += `+ Video\n`;
  if (hasDocument) summaryForMiracle += `+ Document\n`;
  if (hasSticker) summaryForMiracle += `+ Sticker\n`;
  summaryForMiracle += `\nReply them when you are back. Type .bot to let bot talk again.`;

  for (let b of batch) {
    if (b.type === 'voice') {
      try {
        const buffer = await downloadBuffer(b.rawMsg.message.audioMessage || b.rawMsg.message.pttMessage, 'audio');
        const transcribed = await transcribeVoice(buffer);
        if (transcribed) summaryForMiracle += `\nVoice said: "${transcribed}"`;
      } catch (e) {}
    }
    if (b.type === 'image') {
      try {
        const buffer = await downloadBuffer(b.rawMsg.message.imageMessage, 'image');
        const base64 = buffer.toString('base64');
        const desc = await understandImage(base64, b.text || '');
        if (desc) summaryForMiracle += `\nImage: ${desc.substring(0, 300)}`;
      } catch (e) {}
    }
  }

  try { await botSend(OWNER_NUMBER + '@s.whatsapp.net', { text: summaryForMiracle }); } catch (e) {}
  // STOP Bot after user drops message - Bot will NOT reply again unless user asks Bot a question
  lastOwnerReply[from] = Date.now();

  let thanksMsg = '';
  if (hasVoice && !allTexts) {
    thanksMsg = "Thanks For Your Message, I have received your voice note. My Boss Will Reply to you soon.";
  } else if (hasImage && !allTexts) {
    thanksMsg = "Thanks For Your Message, I have seen your image. My Boss Will Reply to you soon.";
  } else {
    thanksMsg = await callGroq([
      { role: 'system', content: `IGNORE the rule that says add portfolio link. For THIS message ONLY, do NOT add any link. User just finished sending message(s) for Miracle. They sent: "${allTexts}" ${hasVoice ? '+ voice note' : ''} ${hasImage ? '+ image' : ''} ${hasSticker ? '+ sticker' : ''}. Reply in EXACT same language user used: "Thanks For Your Message, My Boss Will Reply to you soon." If they sent image/voice, mention you have seen it. Return ONLY that professional closing message, no link.` },
      { role: 'user', content: allTexts || '[voice/image/sticker]' }
    ]);
  }
  if (!thanksMsg) thanksMsg = "Thanks For Your Message, My Boss Will Reply to you soon.";
  await botSend(from, { text: thanksMsg.replace(/\*\*/g, '').trim() });
  await postStatusOnChat();
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) lastQR = qr;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(() => startBot(), 3000);
    } else if (connection === 'open') { console.log('✅ Connected! Mira-Tech Online!'); lastQR = ''; startMondayStatusJob(); }
  });

  sock.ev.on('call', async (calls) => {
    for (let call of calls) {
      if (call.status === 'offer') {
        try {
          await botSend(call.from, { text: "I have seen your Call. I am Miracle Virtual AI Assistant. My Boss Will Reply you when he is back online. Please send your message here as text or voice note, I will give it to him." });
          await botSend(OWNER_NUMBER + '@s.whatsapp.net', { text: `📞 MISSED CALL: ${call.from} just called.` });
        } catch (e) {}
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message) return;
      const from = msg.key.remoteJid;
      if (!from) return;
      if (from.includes('@g.us')) return;
      if (from === 'status@broadcast' || from.includes('status@broadcast') || from.includes('@broadcast') || from.includes('broadcast')) return;

      if (msg.key.fromMe) {
        if (botSentIds.has(msg.key.id)) return;
        const myText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const lowerMy = myText.toLowerCase().replace(/\s+/g, '').trim();
        if (lowerMy === '.offline') { isOfflineMode = true; console.log('🔴 OFFLINE MODE ON'); return; }
        if (lowerMy === '.online') { isOfflineMode = false; hasSentOfflineMsg = {}; console.log('🟢 ONLINE MODE ON'); return; }
        if (lowerMy === '.bot') { lastOwnerReply = {}; waitingForDropMessage = {}; userHasBeenGreeted = {}; userBuffers = {}; console.log('🤖 BOT RESUMED - Miracle is offline again'); return; }
        if (lowerMy === '.stop') { console.log('🛑 BOT STOPPED'); return; }
        if (lowerMy === '.status') {
          console.log('📢 .status command from Miracle - posting...');
          const ok = await postPortfolioStatus();
          try {
            if (ok) await botSend(from, { text: '✅ Done, I have sent your Status to you. Forward it to your Status now - you will see it.' });
            else await botSend(from, { text: '❌ Failed to post Status. Check Render logs. Try again.' });
          } catch (e) {}
          return;
        }
        if (from && !from.includes('status') && from !== OWNER_NUMBER + '@s.whatsapp.net') {
          lastOwnerReply[from] = Date.now();
          console.log('👤 Miracle replied to', from, '- Bot stopped for this user');
        }
        return;
      }

      // NOTE: We do NOT block here with lastOwnerReply anymore - processUserBatch handles it
      // so Bot can still answer questions after user drops message
      const ownerTextCheck = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().replace(/\s+/g, '').trim();
      if (from === OWNER_NUMBER + '@s.whatsapp.net' || from.includes('2349123358519')) {
        if (ownerTextCheck === '.status') {
          await postPortfolioStatus();
          await botSend(from, { text: '✅ Done, I have sent your Status to you. Forward it to your Status now.' });
          return;
        }
      }

      if (!userBuffers[from]) userBuffers[from] = [];
      let msgType = 'text';
      let msgContent = '';
      if (msg.message.stickerMessage) msgType = 'sticker';
      else if (msg.message.audioMessage || msg.message.pttMessage) msgType = 'voice';
      else if (msg.message.imageMessage) { msgType = 'image'; msgContent = msg.message.imageMessage?.caption || ''; }
      else if (msg.message.videoMessage) msgType = 'video';
      else if (msg.message.documentMessage) msgType = 'document';
      else msgContent = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

      userBuffers[from].push({ type: msgType, text: msgContent, rawMsg: msg });
      if (userTimers[from]) clearTimeout(userTimers[from]);
      userTimers[from] = setTimeout(() => { processUserBatch(from); }, 10000);
      console.log(`⏳ Waiting for ${from} to finish... buffered ${userBuffers[from].length} messages`);
      return;

    } catch (e) { console.log('Reply error:', e.message); }
  });
}

startBot();
app.get('/', (req, res) => res.send('<h1>Mira-Tech is Running! Go to /qr to scan</h1>'));
app.get('/qr', async (req, res) => {
  if (!lastQR) return res.send('<h1>Mira-Tech Already Connected!</h1>');
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send(`<h1>Scan Mira-Tech QR</h1><img src="${qrImage}" style="width:300px"/>`);
});
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log('Website running on port ' + PORT));
setInterval(() => { console.log('Keep alive ping...'); }, 10 * 60 * 1000);
