// index.js — Modular v8.0 (+ AI2)
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
const { cmdAi2 } = require('./handlers/ai2');

const BOT_TOKEN = process.env.TG_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('TG_TOKEN not set!');

const API_ROOT = process.env.BOT_API_SERVER || 'https://api.telegram.org';

async function registerLocalToken(apiRoot, token) {
  const axios = require('axios');
  try {
    await axios.get(`${apiRoot}/bot${token}/logOut`, { timeout: 10000 });
    console.log('🔑 Cloud logOut ✅');
  } catch (e) {
    console.log('ℹ️ logOut:', e.message);
  }
  try {
    const { data } = await axios.get(`${apiRoot}/bot${token}/logIn`, { timeout: 10000 });
    if (data.ok) console.log('🔑 Local logIn ✅');
  } catch (e) {
    console.log('ℹ️ logIn:', e.message);
  }
}

const bot = new Telegraf(BOT_TOKEN, { apiRoot: API_ROOT, handlerTimeout: 900000 });

if (process.env.BOT_API_SERVER) {
  registerLocalToken(API_ROOT, BOT_TOKEN);
}

bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err);
  try { ctx.reply(`⚠️ Bot error: ${err.message}`); } catch {}
});

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
bot.command('ai2', (ctx) => cmdAi2(ctx));
bot.command('img', (ctx) => cmdImg(ctx));
bot.command('reset', (ctx) => cmdReset(ctx));

bot.on('text', (ctx) => {
  cacheMessage(ctx);
  if (isSocialCommand(ctx)) return handleDlCommand(ctx);
  return handleText(ctx);
});

['video', 'photo', 'document', 'animation'].forEach(t => {
  bot.on(t, (ctx) => cacheMessage(ctx));
});

bot.on('callback_query', (ctx) => {
  const data = ctx.callbackQuery?.data || '';
  if (data.startsWith('bscd_') || data.startsWith('bsc_')) return handleSubCallback(ctx);
  if (data.startsWith('ytsel_') || data.startsWith('ytv_') || data.startsWith('yta_')) return handleYtCallback(ctx);
  if (data.startsWith('ytm_')) return handleYtmCallback(ctx);
  if (data.startsWith('ss_')) return handleSsCallback(ctx);
  if (data.startsWith('csz_')) return handleCszCallback(ctx);
  if (data.startsWith('mb_')) return handleMbCallback(ctx);
  if (data.startsWith('vid_') || data.startsWith('aud_')) return handleDlCallback(ctx);
  return handleCallback(ctx);
});

async function launchWithRetry(attempt = 1) {
  try {
    await bot.launch();
    console.log('Bot Started ✅ ai2 ready');
  } catch (e) {
    console.error(`❌ Launch ${attempt} failed:`, e.message);
    if (attempt < 5) setTimeout(() => launchWithRetry(attempt + 1), 15000);
    else process.exit(1);
  }
}
launchWithRetry();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
