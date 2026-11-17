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
let botSentIds = new Set(); // FIX: Remember bot's own messages, so bot does NOT think they are Miracle's replies

// --- PORTFOLIO ---
const PORTFOLIO_LINK = 'https://miracle-tech.netlify.app/';
const PORTFOLIO_CAPTION = `🔥 Mira-Tech - I Build Websites That Sell 🔥\n\n✅ E-commerce Website - N100,000\n✅ Business Website - N80,000\n✅ Landing Page - N50,000\n\nCheck my work here:\n${PORTFOLIO_LINK}\n\nDM me to start your project today!\nMiracle - +2349123358519`;
let lastStatusPostedDate = '';
let lastMondayStatusPostedDate = '';

async function postPortfolioStatus() {
  if (!sock) return false;
  try {
    console.log('📢 Posting Portfolio to Status...');
    try {
      await sock.sendMessage('status@broadcast', { image: { url: 'https://miracle-tech.netlify.app/og-image.jpg' }, caption: PORTFOLIO_CAPTION });
      console.log('✅ Portfolio Status Posted with Image!');
      return true;
    } catch (imgErr) { console.log('Image status failed, trying text:', imgErr.message); }
    await sock.sendMessage('status@broadcast', { text: PORTFOLIO_CAPTION });
    console.log('✅ Portfolio Status Posted with Text!');
    return true;
  } catch (e) { console.log('❌ Failed to post status:', e.message); return false; }
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

// Helper to send message AND remember it is bot's message
async function botSend(from, content) {
  const sent = await sock.sendMessage(from, content);
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  return sent;
}

const SYSTEM_PROMPT = `You are Miracle Virtual AI Assistant, that's all. You handle Miracle's WhatsApp when he is NOT on WhatsApp.

Miracle is a web developer in Lagos.
Email: mchansvi@gmail.com
WhatsApp: +2349123358519
Portfolio: https://miracle-tech.netlify.app/
Services: E-commerce N100,000 (3-5 days), Business Website N80,000 (2-3 days), Landing Page N50,000 (1-2 days)
Projects: Proofmee Fibon Solar, Azon Gadget Store, Ping AI. Built 15+ websites.

VERY IMPORTANT - EVERY REPLY MUST START LIKE THIS (in user's language):
First tell them: You are Miracle Virtual AI Assistant, that's all. He is not on WhatsApp now, try again later please.
Then answer their question.
Then add portfolio link: https://miracle-tech.netlify.app/

Example in English: "I am Miracle Virtual AI Assistant, that's all. He is not on WhatsApp now, try again later please. [Answer their question here]. Check his work here: https://miracle-tech.netlify.app/"
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
      { role: 'system', content: `You are a translator. User wrote: "${userText}". Detect EXACT language and style. Translate to that SAME language: "I am Miracle Virtual AI Assistant, that's all. He is not on WhatsApp now, try again later please." Return ONLY translation.` },
      { role: 'user', content: userText }
    ]);
    if (translated && translated.trim()) return translated.trim();
  } catch (e) { }
  return "I am Miracle Virtual AI Assistant, that's all. He is not on WhatsApp now, try again later please.";
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
          await botSend(call.from, { text: "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. Please send a voice note or type your message here." });
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
      if (from.includes('@g.us')) return;

      // --- YOUR COMMANDS + OWNER TAKEOVER DETECTION ---
      if (msg.key.fromMe) {
        // If this message was sent by BOT itself, IGNORE it - do NOT stop bot
        if (botSentIds.has(msg.key.id)) return;
        const myText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const lowerMy = myText.toLowerCase().trim();
        if (lowerMy === '.offline') { isOfflineMode = true; console.log('🔴 OFFLINE MODE ON'); return; }
        if (lowerMy === '.online') { isOfflineMode = false; hasSentOfflineMsg = {}; console.log('🟢 ONLINE MODE ON'); return; }
        if (lowerMy === '.bot') { lastOwnerReply = {}; waitingForDropMessage = {}; console.log('🤖 BOT RESUMED - Miracle is offline again'); return; }
        if (lowerMy === '.stop') { console.log('🛑 BOT STOPPED'); return; }
        if (lowerMy === '.status') { await postPortfolioStatus(); return; }
        // THIS IS MIRACLE HIMSELF REPLYING TO A USER -> BOT MUST STOP FOR THAT USER
        // Only if you reply to a real user chat (not status, not yourself)
        if (from && !from.includes('status') && from !== OWNER_NUMBER + '@s.whatsapp.net') {
          lastOwnerReply[from] = Date.now();
          console.log('👤 Miracle replied to', from, '- Bot stopped for this user');
        }
        return;
      }

      // If Miracle has replied to this user, bot STOPS for that user ONLY until .bot
      if (lastOwnerReply[from]) return;

      const isVoice = msg.message.audioMessage || msg.message.pttMessage;
      const isImage = msg.message.imageMessage;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';

      // OWNER sends .status from another phone
      if (from === OWNER_NUMBER + '@s.whatsapp.net' || from.includes('2349123358519')) {
        const ownerText = (text || '').toLowerCase().trim();
        if (ownerText === '.status') {
          await postPortfolioStatus();
          await botSend(from, { text: 'Done, I have posted your portfolio to your Status. Check your Status now.' });
          return;
        }
      }

      // --- VOICE ---
      if (isVoice) {
        try {
          const buffer = await downloadBuffer(msg.message.audioMessage || msg.message.pttMessage, 'audio');
          const transcribed = await transcribeVoice(buffer);
          if (!transcribed) { await botSend(from, { text: "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. Sorry, I could not hear your voice note clearly." }); return; }
          const lowTrans = transcribed.toLowerCase();
          if (lowTrans.includes('drop message') || lowTrans.includes('tell him') || lowTrans.includes('leave a message')) {
            waitingForDropMessage[from] = true;
            await botSend(from, { text: "Okay, drop your message now, I will tell Miracle when he comes online." });
            return;
          }
          if (waitingForDropMessage[from]) {
            waitingForDropMessage[from] = false;
            lastOwnerReply[from] = Date.now();
            await botSend(OWNER_NUMBER + '@s.whatsapp.net', { text: `📩 NEW DROPPED VOICE MESSAGE from ${from}:\n\n"${transcribed}"` });
            const voiceDone = await textToVoiceEnglish("I am Miracle Virtual AI Assistant. Done, I have saved your message. Miracle will see it when he comes online. He is not on WhatsApp now, try again later please.");
            if (voiceDone) await botSend(from, { audio: voiceDone, mimetype: 'audio/mp4', ptt: true });
            else await botSend(from, { text: "Done, I have saved it. Miracle will see it when he comes online." });
            return;
          }
          let reply = await callGroq([
            { role: 'system', content: SYSTEM_PROMPT + "\n\nUser sent VOICE. Reply with VOICE NOTE in ENGLISH ONLY. Short 3-4 sentences." },
            { role: 'user', content: `[User voice]: ${transcribed}` }
          ]);
          if (!reply) reply = "I am Miracle Virtual AI Assistant. He is not on WhatsApp now, try again later please. " + smartLocalReply(transcribed);
          reply = reply.replace(/\*\*/g, '').trim();
          if (isOfflineMode && !hasSentOfflineMsg[from]) { reply = reply + " Please try again later, Miracle will reply soon."; hasSentOfflineMsg[from] = true; }
          const voiceBuffer = await textToVoiceEnglish(reply);
          if (voiceBuffer) await botSend(from, { audio: voiceBuffer, mimetype: 'audio/mp4', ptt: true });
          else await botSend(from, { text: reply });
          await postStatusOnChat();
        } catch (e) { await botSend(from, { text: "Sorry, I had trouble with your voice note. Please type your message." }); }
        return;
      }

      if (isImage) {
        try {
          const buffer = await downloadBuffer(msg.message.imageMessage, 'image');
          const base64 = buffer.toString('base64');
          let replyImg = await understandImage(base64, text);
          if (replyImg) {
            replyImg = replyImg.replace(/\*\*/g, '').trim();
            if (isOfflineMode && !hasSentOfflineMsg[from]) { replyImg = replyImg + "\n\n" + await getOfflineMessage(text || 'hello'); hasSentOfflineMsg[from] = true; }
            await botSend(from, { text: replyImg });
            await postStatusOnChat();
          }
        } catch (e) {}
        return;
      }

      if (!text) return;
      console.log('Message from:', from, 'Text:', text);
      const lowerText = text.toLowerCase();

      // --- USER SAYS STOP ---
      if (lowerText === 'stop' || lowerText === 'stop pls' || lowerText === 'stop please' || lowerText.includes('stop replying') || lowerText.includes('stop disturbing') || lowerText.includes('leave me alone') || lowerText.includes('do not reply') || lowerText.includes("don't reply") || lowerText.includes('dont reply') || lowerText.includes('stop messaging') || lowerText.includes('stop chatting') || lowerText.includes('stop texting')) {
        lastOwnerReply[from] = Date.now();
        await botSend(from, { text: "Okay, I understand. I will stop replying now. If you need Miracle, you can message him directly on +2349123358519. Have a good day." });
        return;
      }

      // --- DROP MESSAGE ---
      if (waitingForDropMessage[from]) {
        const droppedMsg = text;
        droppedMessages[from] = droppedMsg;
        waitingForDropMessage[from] = false;
        lastOwnerReply[from] = Date.now();
        try { await botSend(OWNER_NUMBER + '@s.whatsapp.net', { text: `📩 NEW DROPPED MESSAGE from ${from}:\n\n"${droppedMsg}"\n\nReply them when you are back. Type .bot to let bot talk again.` }); } catch (e) {}
        let doneMsg = await callGroq([
          { role: 'system', content: SYSTEM_PROMPT + `\n\nUser just dropped a message for Miracle. Reply in EXACT same language user used. Tell them: "Done, I have saved it, Miracle will see it when he comes online. He will reply you." Keep it short.` },
          { role: 'user', content: text }
        ]);
        if (!doneMsg) doneMsg = "Done, I have saved it. Miracle will see it when he comes online.";
        await botSend(from, { text: doneMsg.replace(/\*\*/g, '').trim() });
        return;
      }

      if (lowerText.includes('drop message') || lowerText.includes('drop a message') || lowerText.includes('leave a message') || lowerText.includes('leave message') || lowerText.includes('tell him') || lowerText.includes('tell miracle') || lowerText.includes('when he comes online') || lowerText.includes('when he come online') || lowerText.includes('tell am') || lowerText.includes('drop this message') || lowerText.includes('i want to tell him') || lowerText.includes('message for him') || lowerText.includes('message for miracle')) {
        waitingForDropMessage[from] = true;
        let askMsg = await callGroq([
          { role: 'system', content: SYSTEM_PROMPT + `\n\nUser wants to DROP a message for Miracle. Reply in EXACT same language user used. Tell them: "Okay, drop your message now, I will tell Miracle when he comes online." Don't add offline message. Keep it short.` },
          { role: 'user', content: text }
        ]);
        if (!askMsg) askMsg = "Okay, drop your message now, I will tell Miracle when he comes online.";
        await botSend(from, { text: askMsg.replace(/\*\*/g, '').trim() });
        return;
      }

      // WHO BE THIS?
      if (lowerText.includes('who be this') || lowerText.includes('who are you') || lowerText.includes('who is this') || lowerText.includes('wetin be your name') || lowerText.includes('what is your name') || lowerText.includes('who be you') || lowerText.includes('tani e') || lowerText.includes('kedu onye') || lowerText.includes('qui es-tu') || lowerText.includes('quien eres') || lowerText.includes('wer bist du') || lowerText.includes('chi sei')) {
        let intro = await callGroq([
          { role: 'system', content: SYSTEM_PROMPT + "\n\nUser is asking who you are. Introduce yourself as Miracle Virtual AI Assistant in EXACT same language user used. Say he is not on WhatsApp now, try again later. Add portfolio link." },
          { role: 'user', content: text }
        ]);
        if (!intro) intro = "I am Miracle Virtual AI Assistant, that's all. He is not on WhatsApp now, try again later please. Check his work: https://miracle-tech.netlify.app/";
        intro = intro.replace(/\*\*/g, '').trim();
        if (isOfflineMode && !hasSentOfflineMsg[from]) { intro = intro + "\n\n" + await getOfflineMessage(text); hasSentOfflineMsg[from] = true; }
        await botSend(from, { text: intro });
        await postStatusOnChat();
        return;
      }

      // NORMAL TEXT
      let reply = '';
      try {
        if (GROQ_API_KEY) {
          reply = await callGroq([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text }
          ]);
        }
      } catch (e) {}
      if (!reply || !reply.trim()) {
        const introLocal = await getOfflineMessage(text);
        reply = introLocal + " " + smartLocalReply(text);
      }
      reply = reply.replace(/\*\*/g, '').replace(/##/g, '').trim();
      // Make sure portfolio link is always inside
      if (!reply.includes('miracle-tech.netlify.app')) {
        reply = reply + "\n\nCheck his work: https://miracle-tech.netlify.app/";
      }
      if (isOfflineMode && !hasSentOfflineMsg[from]) { reply = reply + "\n\n" + await getOfflineMessage(text); hasSentOfflineMsg[from] = true; }
      await botSend(from, { text: reply });
      await postStatusOnChat();

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
