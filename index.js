const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
let currentQR = '';

app.get('/', (req, res) => res.send('Miracle Bot is Running! Go to /qr to scan'));
app.get('/qr', async (req, res) => {
    if (!currentQR) return res.send('<h2>No QR yet. Wait 10 seconds and refresh. If already connected, no QR needed.</h2>');
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<h1>Scan this with WhatsApp</h1><img src="${qrImage}" style="width:350px"><br><p>WhatsApp > Linked Devices > Link a Device > Scan</p><script>setTimeout(()=>location.reload(), 15000)</script>`);
});

app.listen(10000, () => console.log('Website running on port 10000'));

async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '22.04.4']
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            console.log('NEW QR READY! Go to /qr to scan am!');
        }
        if (connection === 'open') {
            currentQR = '';
            console.log('✅ Connected Successfully!');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });
}
startBot();
