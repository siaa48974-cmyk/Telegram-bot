const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

let sock = null;
let paired = false;
let starting = false;
let reconnecting = false;

// ---------- /pair <number> ----------
async function cmdPair(ctx) {
  const args = (ctx.message?.text || '').split(/\s+/).slice(1);
  const number = (args[0] || '').replace(/[^0-9]/g, '');

  if (!number || number.length < 10) {
    return ctx.reply('📱 Usage:\n`/pair 947XXXXXXXXX`\n(country code එකත් එක්ක, + නැතුව)', { parse_mode: 'Markdown' });
  }

  if (paired) {
    return ctx.reply('✅ WhatsApp දැනටමත් connected වෙලා!\nUnpair කරන්න ඕනි නම් `/unpair` දෙන්න.', { parse_mode: 'Markdown' });
  }

  if (starting) {
    return ctx.reply('⏳ Pairing දැනටමත් start වෙලා. Code එක ටිකකින් එයි...');
  }

  starting = true;
  await ctx.reply(`🔄 WhatsApp එක connect වෙමින්...\nNumber: +${number}\n\n⏳ Pair code එක ටිකකින් මෙතනම එවනවා...`);

  try {
    await startWhatsApp(number, ctx);
  } catch (e) {
    starting = false;
    console.log('WA start failed:', e.message);
    await ctx.reply('❌ Start failed: ' + e.message);
  }
}

// ---------- /unpair ----------
async function cmdUnpair(ctx) {
  fs.rmSync('./wa_session', { recursive: true, force: true });
  paired = false;
  starting = false;
  reconnecting = false;
  try {
    if (sock) {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      try { await sock.logout(); } catch (e) {}
      try { sock.end(undefined); } catch (e) {}
    }
  } catch (e) {}
  sock = null;
  await ctx.reply('🗑️ WhatsApp session එක delete කළා.\nඅලුතින් pair කරන්න `/pair <number>` දෙන්න.');
}

// ---------- Start WhatsApp socket ----------
async function startWhatsApp(pairNumber, ctx) {
  const { state, saveCreds } = await useMultiFileAuthState('./wa_session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['SiAA Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    // connecting + fresh pair request → pair code ගන්න
    if (connection === 'connecting' && pairNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairNumber);
          console.log('📱 PAIR CODE:', code);
          await ctx.reply(
            `📱 *WhatsApp Pair Code:*\n\n\`${code}\`\n\n` +
            `*Steps:*\n` +
            `1️⃣ WhatsApp open කරන්න\n` +
            `2️⃣ Settings → Linked Devices → Link a Device\n` +
            `3️⃣ "Link with phone number" select කරන්න\n` +
            `4️⃣ Number එක (+${pairNumber}) දීලා මේ code එක enter කරන්න\n\n` +
            `⏰ Code එක ~2 minutes valid.`
          , { parse_mode: 'Markdown' });
        } catch (e) {
          console.log('Pair code error:', e.message);
          await ctx.reply(`❌ Pair code error: ${e.message}\n\n📌 දවසකට pair code request limit එකක් තියෙනවා. ටිකකින් try කරන්න.`).catch(() => {});
        }
      }, 4000);
    }

    if (connection === 'open') {
      paired = true;
      starting = false;
      reconnecting = false;
      console.log('✅ WhatsApp Connected!');
      await ctx.reply('✅ *WhatsApp Connected!*\nදැන් WhatsApp messages වලටත් bot එක reply කරනවා. 🎉', { parse_mode: 'Markdown' }).catch(() => {});
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        paired = false; starting = false; reconnecting = false;
        fs.rmSync('./wa_session', { recursive: true, force: true });
        console.log('❌ Logged out.');
        await ctx.reply('❌ WhatsApp logged out. `/pair <number>` දීලා අලුතින් pair කරන්න.').catch(() => {});
      } else if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
        // Baileys pair වුණාට පස්සේ restart එකක් කරනවා — reconnect without pair code
        console.log('🔄 Restart required, reconnecting...');
        startWhatsApp(null, null);
      } else if (!reconnecting) {
        reconnecting = true;
        console.log('🔄 Reconnecting...', statusCode);
        setTimeout(() => {
          reconnecting = false;
          startWhatsApp(null, null);
        }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', onMessage);
}

// ---------- WhatsApp messages ----------
async function onMessage({ messages }) {
  const msg = messages[0];
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

  const body =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption || '';

  const text = (body || '').trim();
  if (!text) return;

  console.log(`[WA] ${jid}: ${text}`);

  if (text.startsWith('/alive') || text.toLowerCase() === 'hi') {
    return sock.sendMessage(jid, { text: '🤖 Bot Alive ✅ (WhatsApp)' });
  }

  if (/(https?:\/\/\S+)/.test(text)) {
    // TODO: මෙතනට ඔයාගේ downloader logic එක connect කරන්න
    return sock.sendMessage(jid, { text: '🔗 Link එක received! (Downloader logic එක මෙතන connect කරන්න)' });
  }

  await sock.sendMessage(jid, { text: '➡️ Download link එකක් එවන්න (YouTube/Facebook/Instagram)' });
}

// ---------- Media download helper ----------
async function downloadMedia(msg, type) {
  const stream = await downloadContentFromMessage(msg.message[type], type.split('Message')[0]);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

function isWaConnected() { return paired && sock; }

module.exports = { cmdPair, cmdUnpair, isWaConnected, downloadMedia };
