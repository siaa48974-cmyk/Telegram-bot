// index.js — Modular v8.0 (+ AI: Llama 3 chat /ai, /ai2, image gen /img, /reset)
const { Telegraf } = require('telegraf');
const { aliveHandler } = require('./handlers/alive');
const { handleText, handleCallback } = require('./handlers/downloader');
const { handleDlCommand, handleDlCallback, isSocialCommand } = require('./handlers/social');
const { cacheMessage, cmdShare, cmdId } = require('./handlers/share');
const { cmdCinesubz, handleCszCallback } = require('./handlers/cinesubz');
const { cmdSinhalasub, handleSsCallback } = require('./handlers/sinhalasub');
const { cmdMoviebox, handleMbCallback } = require('./handlers/moviebox');
const { cmdYt, handleYtCallback } = require('./handlers/yt');
const { cmdSub, handleSubCallback } = require('./handlers/baiscope');
const { cmdSong, handleYtmCallback } = require('./handlers/ytm');
const { cmdAi, cmdImg, cmdReset } = require('./handlers/ai');
const { cmdAiz } = require('./handlers/ai2'); // <-- අලුතෙන් add කරා

// ==== මෙතන වෙනස් කරලා තියෙන්නේ ====
const BOT_TOKEN = process.env.TG_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('TG_TOKEN not set! Set TG_TOKEN in GitHub Secrets');

/* ================= Local Bot API Server (2GB upload limit) ================= */
const API_ROOT = process.env.BOT_API_SERVER || 'https://api.telegram.org';

async function registerLocalToken(apiRoot, token) {
  const axios = require('axios');
  try {
    await axios.get(`${apiRoot}/bot${token}/logOut`, { timeout: 10000 });
    console.log('🔑 Cloud එකෙන් token logOut ✅');
  } catch (e) {
    console.log('ℹ️ logOut:', e.response?.status || e.message);
  }
  try {
    const { data } = await axios.get(`${apiRoot}/bot${token}/logIn`, { timeout: 10000 });
    if (data.ok) console.log('🔑 Local server එකේ token logIn ✅');
    else console.log('⚠️ logIn:', data);
  } catch (e) {
    console.log('ℹ️ logIn:', e.response?.status || e.message);
  }
}

/* ================= Bot instance ================= */
const bot = new Telegraf(BOT_TOKEN, {
  apiRoot: API_ROOT,
  handlerTimeout: 900000
});

if (process.env.BOT_API_SERVER) {
  registerLocalToken(API_ROOT, BOT_TOKEN).then(() => {
    console.log(`🛠️ Local Bot API: ${API_ROOT}`);
  });
}

/* ================= Global error handler ================= */
bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err);
  try {
    ctx.reply(`⚠️ Bot error: ${err.message || 'Unknown error'}`);
  } catch {}
});

/* ================= Commands ================= */
bot.start((ctx) => aliveHandler(ctx));
bot.command('alive', (ctx) => aliveHandler(ctx));
bot.command('dl', (ctx) => handleDlCommand(ctx));
bot.command('yt', (ctx) => cmdYt(ctx));
bot.command('song', (ctx) => cmdSong(ctx));
bot.command('sub', (ctx) => cmdSub(ctx));
bot.command('share', (ctx) => cmdShare(ctx));
bot.command('id', (ctx) => cmdId(ctx));
bot.command('cinesubz', (ctx) => cmdCinesubz(ctx));
bot.command('ss', (ctx) => cmdSinhalasub(ctx));
bot.command('mb', (ctx) => cmdMoviebox(ctx));
bot.command('ai', (ctx) => cmdAi(ctx));
bot.command('aiz', (ctx) => cmdAi2(ctx)); // <-- අලුතෙන් add කරා
bot.command('img', (ctx) => cmdImg(ctx));
bot.command('reset', (ctx) => cmdReset(ctx));

/* ================= Text routing ================= */
bot.on('text', (ctx) => {
  cacheMessage(ctx);
  if (isSocialCommand(ctx)) return handleDlCommand(ctx);
  return handleText(ctx);
});

/* ================= Media cache ================= */
['video', 'photo', 'document', 'animation'].forEach(t => {
  bot.on(t, (ctx) => cacheMessage(ctx));
});

/* ================= Callback routing ================= */
bot.on('callback_query', (ctx) => {
  const data = ctx.callbackQuery?.data || '';
  if (data.startsWith('bscd_') || data.startsWith('bsc_')) {
    return handleSubCallback(ctx);
  }
  if (data.startsWith('ytsel_') || data.startsWith('ytv_') || data.startsWith('yta_')) {
    return handleYtCallback(ctx);
  }
  if (data.startsWith('ytm_')) return handleYtmCallback(ctx);
  if (data.startsWith('ssq_')) return handleSsCallback(ctx);
  if (data.startsWith('ss_')) return handleSsCallback(ctx);
  if (data.startsWith('cszq_')) return handleCszCallback(ctx);
  if (data.startsWith('csz_')) return handleCszCallback(ctx);
  if (data.startsWith('mbq_')) return handleMbCallback(ctx);
  if (data.startsWith('mb_')) return handleMbCallback(ctx);
  if (data.startsWith('vid_') || data.startsWith('aud_')) {
    return handleDlCallback(ctx);
  }
  return handleCallback(ctx);
});

/* ================= Launch (with retry) ================= */
const MAX_RETRIES = 5;
const RETRY_DELAY = 15000;
let launched = false;
async function launchWithRetry(attempt = 1) {
  if (launched) return;
  try {
    await bot.launch();
    launched = true;
    console.log('Bot Started ✅ Modular v8.0 (+ AI: /ai /aiz /img /reset)');
  } catch (e) {
    console.error(`❌ Launch attempt ${attempt} failed:`, e.message);
    if (attempt < MAX_RETRIES) {
      console.log(`⏳ ${RETRY_DELAY / 1000}s පස්සේ retry කරනවා... (${attempt}/${MAX_RETRIES})`);
      setTimeout(() => launchWithRetry(attempt + 1), RETRY_DELAY);
    } else {
      console.error('❌ Max retries ඉක්මවා ගියා. Exiting.');
      process.exit(1);
    }
  }
}
launchWithRetry();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
