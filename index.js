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

// HIDDEN KEYS - Set these in Render > Environment, NOT in code
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OWNER_NUMBER = process.env.OWNER_NUMBER || '2349123358519';
const MODEL_TEXT = "openai/gpt-oss-120b";
const MODEL_FALLBACK = "openai/gpt-oss-20b";
const MODEL_VISION = "meta-llama/llama-4-scout-17b-16e-instruct";
const MODEL_WHISPER = "whisper-large-v3";

// Your Portfolio Brain for Mira-Tech
const SYSTEM_PROMPT = `You are Mira-Tech, the AI Assistant for Miracle, a professional web developer in Lagos, Nigeria working worldwide. Your job is to be warm, confident, and helpful like a senior project manager, not a robot.

CONTACT:
Email: mchansvi@gmail.com
WhatsApp / Phone: +2349123358519
WhatsApp Link: https://wa.me/2349123358519

SERVICES:
- E-commerce Store: N100,000, 3-5 days. Premium e-commerce stores, fast PWA apps, solar brand websites.
- Business Website: N80,000, 2-3 days. Business websites that convert.
- Landing Page: N50,000, 1-2 days. Landing pages that sell.

PROJECTS:
- Proofmee Fibon Solar - solar e-commerce
- Azon Gadget Store - gadget store
- Ping AI - AI web app
- You have built 15+ websites

HOW TO SPEAK - VERY IMPORTANT:
- MIRROR THE USER'S LANGUAGE. If user speaks English, reply in clean English. If user speaks Pidgin, reply in Pidgin. If user speaks Yoruba/Hausa/Igbo mix, match them. Never force Pidgin on an English speaker.
- If the user is Dad or Mum, always be extra respectful, call them Sir / Ma.
- Greet warmly. If visitor gives their name, remember it and use it.
- Ask 1 clear question at a time.
- If they say price is high, explain value: mobile-first, fast, built to convert.
- If ready, say continue on WhatsApp: https://wa.me/2349123358519
- Keep replies short, clean, structured for WhatsApp.
- No emojis overload. No mention of models, APIs, Groq.
- Always end with one clear next step.
- You are Mira-Tech, not Miracle. Miracle is your owner/boss.
`;

async function callGroq(messages) {
  let res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_TEXT, messages, temperature: 0.7, max_tokens: 600 })
  });
  if (!res.ok) {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_FALLBACK, messages, temperature: 0.7, max_tokens: 600 })
    });
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Voice Note -> Text using Groq Whisper
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

// Image -> Understand picture
async function understandImage(base64Image, caption) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_VISION,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `You are Mira-Tech. User sent this image. Caption: "${caption}". Describe what you see and answer helpfully. If it's a product, price, receipt, or screenshot, explain it. Keep it short for WhatsApp.` },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ]
      }],
      max_tokens: 600
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function smartLocalReply(q) {
  const t = q.toLowerCase();
  if (t.includes('price') || t.includes('cost') || t.includes('how much') || t.includes('charge')) return `Here are Mira-Tech packages:\n\n- E-commerce Store - N100,000 (3-5 days)\n- Business Website - N80,000 (2-3 days)\n- Landing Page - N50,000 (1-2 days)\n\nAll projects are mobile-first, fast, and built to convert.\n\nWhich one fits your business?`;
  if (t.includes('project') || t.includes('work') || t.includes('portfolio')) return `Miracle has built 15+ websites, including:\n\n- Proofmee Fibon Solar - solar e-commerce\n- Azon Gadget Store - gadget store\n- Ping AI - AI web app\n\nWhich type of project do you want?`;
  if (t.includes('time') || t.includes('long') || t.includes('delivery')) return `Delivery is fast:\n- Landing Page: 1-2 days\n- Business Website: 2-3 days\n- E-commerce Store: 3-5 days\n\nWhat is your deadline?`;
  if (t.includes('contact') || t.includes('email') || t.includes('phone') || t.includes('whatsapp')) return `You can reach Miracle here:\n\nEmail: mchansvi@gmail.com\nWhatsApp / Phone: +2349123358519\nLink: https://wa.me/2349123358519`;
  return `Hello, welcome to Mira-Tech. I am Mira-Tech, assistant to Miracle.\n\nI can help you choose the right website, explain pricing, and connect you to Miracle.\n\nWhat would you like to build today? E-commerce, Business Website, or Landing Page?`;
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
      console.log('Connection closed, reconnect?', shouldReconnect);
      if (shouldReconnect) setTimeout(() => startBot(), 3000);
    } else if (connection === 'open') {
      console.log('✅ Connected Successfully! Mira-Tech is Online!');
      lastQR = '';
    }
  });

  // MISSED CALL HANDLER
  sock.ev.on('call', async (calls) => {
    for (let call of calls) {
      if (call.status === 'offer') {
        const caller = call.from;
        try {
          await sock.sendMessage(caller, { text: "Sorry, I missed your call. I cannot take voice or video calls on this number. Please send a voice note or type your message here and I will reply immediately." });
          await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: `📞 MISSED CALL ALERT: ${caller} just called Mira-Tech. I have told them to send a message. Please call them back if needed.` });
        } catch (e) { console.log('Call handler error:', e.message); }
      }
    }
  });

  // Brain - reply to anybody
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid;
      if (from.includes('@g.us')) return;
      
      const isVoice = msg.message.audioMessage || msg.message.pttMessage;
      const isImage = msg.message.imageMessage;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';

      // --- VOICE NOTE ---
      if (isVoice) {
        console.log('Voice note from:', from);
        await sock.sendMessage(from, { text: "Listening to your voice note... one sec." });
        try {
          const buffer = await downloadBuffer(msg.message.audioMessage || msg.message.pttMessage, 'audio');
          const transcribed = await transcribeVoice(buffer);
          console.log('Transcribed:', transcribed);
          if (!transcribed) {
            await sock.sendMessage(from, { text: "Sorry, I could not hear your voice note clearly. Please type it or send it again." });
            return;
          }
          let reply = await callGroq([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `[User sent a voice note, transcribed as]: ${transcribed}` }
          ]);
          if (!reply) reply = smartLocalReply(transcribed);
          reply = reply.replace(/\*\*/g, '').replace(/##/g, '').trim();
          await sock.sendMessage(from, { text: reply });
        } catch (e) {
          console.log('Voice error:', e.message);
          await sock.sendMessage(from, { text: "Sorry, I had trouble with your voice note. Please type your message." });
        }
        return;
      }

      // --- IMAGE ---
      if (isImage) {
        console.log('Image from:', from);
        try {
          const buffer = await downloadBuffer(msg.message.imageMessage, 'image');
          const base64 = buffer.toString('base64');
          const replyImg = await understandImage(base64, text);
          if (replyImg) {
            await sock.sendMessage(from, { text: replyImg.replace(/\*\*/g, '').trim() });
          } else {
            await sock.sendMessage(from, { text: "I saw your picture. Can you tell me what you want me to do with it?" });
          }
        } catch (e) {
          console.log('Image error:', e.message);
          await sock.sendMessage(from, { text: "I saw your picture but could not open it well. Please send it again." });
        }
        return;
      }

      if (!text) return;
      console.log('Message from:', from, 'Text:', text);

      if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello' || text.toLowerCase() === 'hey') {
        await sock.sendMessage(from, { text: 'Hello, welcome to Mira-Tech! 👋\n\nI am Mira-Tech, assistant to Miracle, a professional web developer in Lagos.\n\nI can help you with websites, pricing, and projects.\n\nWhat would you like to build today? E-commerce, Business Website, or Landing Page?' });
        return;
      }

      let reply = '';
      try {
        if (GROQ_API_KEY) {
          reply = await callGroq([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text }
          ]);
        }
      } catch (e) { console.log('Groq error:', e.message); }

      if (!reply || !reply.trim()) reply = smartLocalReply(text);
      reply = reply.replace(/\*\*/g, '').replace(/##/g, '').trim();
      await sock.sendMessage(from, { text: reply });

    } catch (e) { console.log('Reply error:', e.message); }
  });
}

startBot();

// Website for QR + Keep Alive (fixes Render sleeping)
app.get('/', (req, res) => res.send('<h1>Mira-Tech is Running! Go to /qr to scan</h1>'));
app.get('/qr', async (req, res) => {
  if (!lastQR) return res.send('<h1>Mira-Tech Already Connected! No QR Needed.</h1><p>If you need a new QR, log out the Ubuntu device on your phone and redeploy.</p>');
  const qrImage = await qrcode.toDataURL(lastQR);
  res.send(`<h1>Scan Mira-Tech QR</h1><img src="${qrImage}" style="width:300px"/>`);
});
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log('Website running on port ' + PORT));

// Keep alive ping every 10 mins to prevent Render sleep
setInterval(() => { console.log('Keep alive ping... Bot still running'); }, 10 * 60 * 1000);
