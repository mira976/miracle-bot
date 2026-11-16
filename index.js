const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');

// Keep Render alive
http.createServer((req, res) => res.end('Miracle Bot is Running!')).listen(process.env.PORT || 3000);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ['Miracle Bot', 'Chrome', '1.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Miracle Bot Connected Successfully!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cmd = text.trim().toLowerCase();
        console.log('Message:', text, 'from:', from);

        if (cmd === '.ping' || cmd === 'ping') {
            await sock.sendMessage(from, { text: '🏓 Pong! Miracle Bot is Alive!' });
        }
        if (cmd === '.menu' || cmd === 'menu' || cmd === '.help') {
            await sock.sendMessage(from, { text: `✨ *MIRACLE BOT MENU* ✨\n\n.ping - Check if bot is alive\n.menu - Show this menu\n.hi - Say hello\n.owner - Owner info\n\nMore commands coming soon!` });
        }
        if (cmd === '.hi' || cmd === 'hi' || cmd === 'hello') {
            await sock.sendMessage(from, { text: 'Hello! 👋 I am Miracle Bot. Type .menu to see what I can do.' });
        }
        if (cmd === '.owner') {
            await sock.sendMessage(from, { text: '👑 Owner: Mira\nBot made with love ❤️' });
        }
    });
}

startBot();
