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
let hasSentOfflineMsg = {}; // Offline message ONLY ONCE per person
let waitingForDropMessage = {}; // Who wants to drop message
let droppedMessages = {};

const SYSTEM_PROMPT = `You are Mira-Tech, Miracle's boy who handles his WhatsApp when he is busy.

Miracle is a web developer in Lagos.
Email: mchansvi@gmail.com
WhatsApp: +2349123358519
Services: E-commerce N100,000 (3-5 days), Business Website N80,000 (2-3 days), Landing Page N50,000 (1-2 days)
Projects: Proofmee Fibon Solar, Azon Gadget Store, Ping AI. Built 15+ websites.

GOLDEN RULE - MOST IMPORTANT:
Once anybody chats you, reply EXACTLY the way the user chatted you. EXACTLY the language the user used to chat you, that is the way you reply.
- If user chats in Pidgin, reply in Pidgin, same style, same slang.
- If user chats in English, reply in English.
- If user chats in Igbo, Yoruba, Hausa, Spanish, French, German, Chinese, Arabic, Italian, ANY language, reply in that SAME language.
- If user mixes, mix the same way.
- If user says "how far", reply like "I dey, how far". Don't change it to formal English. Copy their energy, their words, their vibe.
- Never force a language. Never correct them. Just mirror them 100%. You know ALL languages.

IF USER ASKS WHO BE THIS:
If user says "who be this", "who are you", "who is this", "wetin be your name", "what is your name", "tani e", "kedu onye bu gi", "qui es-tu", "quien eres", "wer bist du", "chi sei" - introduce yourself WELL in the EXACT same language they used.
Example in Pidgin: "Na Mira-Tech be this o, I be Miracle boy wey dey handle him WhatsApp when him no dey around. How I fit help you?"
Example in English: "I am Mira-Tech, Miracle's assistant. I handle his WhatsApp when he is busy. How can I help you?"
Do the same for ANY other language.

VOICE NOTE RULE - VERY IMPORTANT:
- When you reply with VOICE NOTE, ALWAYS use ENGLISH ONLY. Even if user spoke Pidgin, Igbo, Yoruba, French, or any language, your voice note must be in clean clear English.
- Text replies can be in any language, but voice replies are ENGLISH ONLY.

OTHER RULES:
- Talk like a real human boy, with sense, short and natural. Never say "As an AI".
- If user is gisting, gist with them. If they ask about website, answer smart in their language.
- If user is Dad or Mum, be respectful, call them Sir / Ma.
- Keep it short for WhatsApp.
- You are Mira-Tech, not Miracle. Miracle is your boss.
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

// SMART OFFLINE - Knows ALL languages, translates offline message to user's exact language, ONLY ONCE
async function getOfflineMessage(userText) {
  try {
    let translated = await callGroq([
      { role: 'system', content: `You are a translator. User wrote: "${userText}". Detect the EXACT language, slang, and style they used. Translate this sentence to that EXACT same language and style: "Please try again later, Miracle will reply soon." Return ONLY the translation, nothing else. If user used Pidgin, return Pidgin like "Abeg try again later, Miracle go reply you soon." If German, return German. If Chinese, return Chinese.` },
      { role: 'user', content: userText }
    ]);
    if (translated && translated.trim()) return translated.trim();
  } catch (e) { }
  return "Please try again later, Miracle will reply soon.";
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

// VOICE NOTE - ENGLISH ONLY
async function textToVoiceEnglish(text) {
  try {
    // Force English for voice
    let englishText = await callGroq([
      { role: 'system', content: `Translate this text to clean, clear, simple English for a voice note. Keep it short, natural, like a human speaking. Return ONLY the English translation. Text: "${text}"` },
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
      messages: [{ role: "user", content: [{ type: "text", text: `You are Mira-Tech. User sent image. Caption: "${caption}". Reply EXACTLY in the language user used. Keep short for WhatsApp.` }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }],
      max_tokens: 600
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function smartLocalReply(q) {
  const t = q.toLowerCase();
  if (t.includes('price') || t.includes('cost') || t.includes('how much')) return `E-commerce Store - N100,000 (3-5 days)\nBusiness Website - N80,000 (2-3 days)\nLanding Page - N50,000 (1-2 days)\n\nWhich one fits your business?`;
  if (t.includes('project') || t.includes('work')) return `Miracle has built 15+ websites: Proofmee Fibon Solar, Azon Gadget Store, Ping AI. Which type you want?`;
  return `Hello, welcome to Mira-Tech. I am Mira-Tech, assistant to Miracle. What would you like to build today? E-commerce, Business Website, or Landing Page?`;
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
    } else if (connection === 'open') { console.log('✅ Connected! Mira-Tech Online!'); lastQR = ''; }
  });

  sock.ev.on('call', async (calls) => {
    for (let call of calls) {
      if (call.status === 'offer') {
        try {
          await sock.sendMessage(call.from, { text: "Sorry, I missed your call. Please send a voice note or type your message here and I will reply immediately." });
          await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `📞 MISSED CALL: ${call.from} just called.` });
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

      // --- YOUR COMMANDS - Type to YOURSELF (Message Yourself) ---
      if (msg.key.fromMe) {
        const myText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const lowerMy = myText.toLowerCase().trim();
        if (lowerMy === '.offline') { isOfflineMode = true; console.log('🔴 OFFLINE MODE ON'); return; }
        if (lowerMy === '.online') { isOfflineMode = false; hasSentOfflineMsg = {}; console.log('🟢 ONLINE MODE ON'); return; }
        if (lowerMy === '.bot') { lastOwnerReply = {}; waitingForDropMessage = {}; console.log('🤖 BOT RESUMED'); return; }
        if (lowerMy === '.stop') { console.log('🛑 BOT STOPPED'); return; }
        if (from && !from.includes('status')) lastOwnerReply[from] = Date.now();
        return;
      }

      // If Miracle has replied to this user, bot STOPS for that user ONLY
      if (lastOwnerReply[from]) return;

      const isVoice = msg.message.audioMessage || msg.message.pttMessage;
      const isImage = msg.message.imageMessage;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';

      // --- VOICE -> VOICE NOTE (ENGLISH ONLY) ---
      if (isVoice) {
        try {
          const buffer = await downloadBuffer(msg.message.audioMessage || msg.message.pttMessage, 'audio');
          const transcribed = await transcribeVoice(buffer);
          if (!transcribed) { await sock.sendMessage(from, { text: "Sorry, I could not hear your voice note clearly. Please type it or send it again." }); return; }
          // Check if user wants to drop message via voice
          const lowTrans = transcribed.toLowerCase();
          if (lowTrans.includes('drop message') || lowTrans.includes('tell him') || lowTrans.includes('leave a message')) {
            waitingForDropMessage[from] = true;
            await sock.sendMessage(from, { text: "Okay, drop your message now, I will tell Miracle when he comes online." });
            return;
          }
          if (waitingForDropMessage[from]) {
            waitingForDropMessage[from] = false;
            lastOwnerReply[from] = Date.now();
            await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `📩 NEW DROPPED VOICE MESSAGE from ${from}:\n\n"${transcribed}"` });
            const voiceDone = await textToVoiceEnglish("Done, I have saved your message. Miracle will see it when he comes online.");
            if (voiceDone) await sock.sendMessage(from, { audio: voiceDone, mimetype: 'audio/mp4', ptt: true });
            else await sock.sendMessage(from, { text: "Done, I have saved it. Miracle will see it when he comes online." });
            return;
          }
          let reply = await callGroq([
            { role: 'system', content: SYSTEM_PROMPT + "\n\nUser sent VOICE. You will reply with VOICE NOTE in ENGLISH ONLY. Reply in clean clear English, short 3-4 sentences, natural for voice." },
            { role: 'user', content: `[User voice]: ${transcribed}` }
          ]);
          if (!reply) reply = smartLocalReply(transcribed);
          reply = reply.replace(/\*\*/g, '').trim();
          // Offline message ONLY ONCE, and voice offline is also English
          if (isOfflineMode && !hasSentOfflineMsg[from]) {
            reply = reply + " Please try again later, Miracle will reply soon.";
            hasSentOfflineMsg[from] = true;
          }
          const voiceBuffer = await textToVoiceEnglish(reply);
          if (voiceBuffer) await sock.sendMessage(from, { audio: voiceBuffer, mimetype: 'audio/mp4', ptt: true });
          else await sock.sendMessage(from, { text: reply });
        } catch (e) { await sock.sendMessage(from, { text: "Sorry, I had trouble with your voice note. Please type your message." }); }
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
            await sock.sendMessage(from, { text: replyImg });
          }
        } catch (e) {}
        return;
      }

      if (!text) return;
      console.log('Message from:', from, 'Text:', text);
      const lowerText = text.toLowerCase();

      // --- DROP MESSAGE MODE ---
      if (waitingForDropMessage[from]) {
        const droppedMsg = text;
        droppedMessages[from] = droppedMsg;
        waitingForDropMessage[from] = false;
        lastOwnerReply[from] = Date.now(); // Bot STOPS for this user now
        try {
          await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `📩 NEW DROPPED MESSAGE from ${from}:\n\n"${droppedMsg}"\n\nReply them when you are back. Type .bot to let bot talk again.` });
        } catch (e) {}
        let doneMsg = await callGroq([
          { role: 'system', content: SYSTEM_PROMPT + `\n\nUser just dropped a message for Miracle. Reply in EXACT same language user used. Tell them: "Done, I have saved it, Miracle will see it when he comes online. He will reply you." Keep it short.` },
          { role: 'user', content: text }
        ]);
        if (!doneMsg) doneMsg = "Done, I have saved it. Miracle will see it when he comes online.";
        await sock.sendMessage(from, { text: doneMsg.replace(/\*\*/g, '').trim() });
        return;
      }

      if (lowerText.includes('drop message') || lowerText.includes('drop a message') || lowerText.includes('leave a message') || lowerText.includes('leave message') || lowerText.includes('tell him') || lowerText.includes('tell miracle') || lowerText.includes('when he comes online') || lowerText.includes('when he come online') || lowerText.includes('tell am') || lowerText.includes('drop this message') || lowerText.includes('i want to tell him') || lowerText.includes('message for him') || lowerText.includes('message for miracle')) {
        waitingForDropMessage[from] = true;
        let askMsg = await callGroq([
          { role: 'system', content: SYSTEM_PROMPT + `\n\nUser wants to DROP a message for Miracle. Reply in EXACT same language user used. Tell them: "Okay, drop your message now, I will tell Miracle when he comes online." Don't add offline message. Keep it short.` },
          { role: 'user', content: text }
        ]);
        if (!askMsg) askMsg = "Okay, drop your message now, I will tell Miracle when he comes online.";
        await sock.sendMessage(from, { text: askMsg.replace(/\*\*/g, '').trim() });
        return;
      }

      // WHO BE THIS? - Introduce well in SAME language
      if (lowerText.includes('who be this') || lowerText.includes('who are you') || lowerText.includes('who is this') || lowerText.includes('wetin be your name') || lowerText.includes('what is your name') || lowerText.includes('who be you') || lowerText.includes('tani e') || lowerText.includes('kedu onye') || lowerText.includes('qui es-tu') || lowerText.includes('quien eres') || lowerText.includes('wer bist du') || lowerText.includes('chi sei')) {
        let intro = await callGroq([
          { role: 'system', content: SYSTEM_PROMPT + "\n\nUser is asking who you are. Introduce yourself WELL in the EXACT same language and style user used. Do not change language." },
          { role: 'user', content: text }
        ]);
        if (!intro) intro = "Na Mira-Tech be this o, I be Miracle boy wey dey handle him WhatsApp when him no dey around. How I fit help you?";
        intro = intro.replace(/\*\*/g, '').trim();
        if (isOfflineMode && !hasSentOfflineMsg[from]) { intro = intro + "\n\n" + await getOfflineMessage(text); hasSentOfflineMsg[from] = true; }
        await sock.sendMessage(from, { text: intro });
        return;
      }

      // NORMAL TEXT -> TEXT - EXACT SAME LANGUAGE
      let reply = '';
      try {
        if (GROQ_API_KEY) {
          reply = await callGroq([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text }
          ]);
        }
      } catch (e) {}
      if (!reply || !reply.trim()) reply = smartLocalReply(text);
      reply = reply.replace(/\*\*/g, '').replace(/##/g, '').trim();
      // Offline message ONLY ONCE per person
      if (isOfflineMode && !hasSentOfflineMsg[from]) { reply = reply + "\n\n" + await getOfflineMessage(text); hasSentOfflineMsg[from] = true; }
      await sock.sendMessage(from, { text: reply });

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
