const { Telegraf } = require('telegraf');

function safeRequire(p) {
  try { return require(p); } 
  catch (e) { console.log(`Load failed ${p}: ${e.message}`); return null; }
}

const aliveMod = safeRequire('./handlers/alive');
const downloader = safeRequire('./handlers/downloader') || {};
const social = safeRequire('./handlers/social') || {};
const share = safeRequire('./handlers/share') || {};
const cinesubz = safeRequire('./handlers/cinesubz') || {};
const sinhalasub = safeRequire('./handlers/sinhalasub') || {};
const moviebox = safeRequire('./handlers/moviebox') || {};
const yt = safeRequire('./handlers/yt') || {};
const baiscope = safeRequire('./handlers/baiscope') || {};
const ytm = safeRequire('./handlers/ytm') || {};
const ai = safeRequire('./handlers/ai') || {};
const ai2 = safeRequire('./handlers/ai2');
const siaa_pro = safeRequire('./handlers/siaa_pro');

const aliveHandler = aliveMod?.aliveHandler || (async (ctx) => ctx.reply('🤖 Bot Alive ✅'));
const { handleText, handleCallback } = downloader;
const { handleDlCommand, handleDlCallback, isSocialCommand } = social;
const { cacheMessage, cmdShare, cmdId } = share;
const { cmdCinesubz, handleCszCallback } = cinesubz;
const { cmdSinhalasub, handleSsCallback } = sinhalasub;
const { cmdMoviebox, handleMbCallback } = moviebox;
const { cmdYt, handleYtCallback } = yt;
const { cmdSub, handleSubCallback } = baiscope;
const { cmdSong, handleYtmCallback } = ytm;
const { cmdAi, cmdImg, cmdReset } = ai;
const cmdAi2 = ai2?.cmdAi2 || ((ctx) => ctx.reply('⚠️ ai2.js නෑ'));
const cmdPro = siaa_pro?.cmdPro || ((ctx) => ctx.reply('⚠️ siaa_pro.js නෑ'));

const BOT_TOKEN = process.env.TG_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('TG_TOKEN not set');

// Local Bot API Server support — 2GB upload සඳහා
const LOCAL_API = process.env.LOCAL_API_URL || 'https://api.telegram.org';

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 900000,
  telegram: {
    apiRoot: LOCAL_API
  }
});

bot.start((ctx) => aliveHandler(ctx));
bot.command('alive', (ctx) => aliveHandler(ctx));
bot.command('dl', (ctx) => handleDlCommand && handleDlCommand(ctx));
bot.command('yt', (ctx) => cmdYt && cmdYt(ctx));
bot.command('song', (ctx) => cmdSong && cmdSong(ctx));
bot.command('sub', (ctx) => cmdSub && cmdSub(ctx));
bot.command('share', (ctx) => cmdShare && cmdShare(ctx));
bot.command('id', (ctx) => cmdId && cmdId(ctx));
bot.command('cinesubz', (ctx) => cmdCinesubz && cmdCinesubz(ctx));
bot.command('ss', (ctx) => cmdSinhalasub && cmdSinhalasub(ctx));
bot.command('mb', (ctx) => cmdMoviebox && cmdMoviebox(ctx));
bot.command('ai', (ctx) => cmdAi && cmdAi(ctx));
bot.command('ai2', (ctx) => cmdAi2(ctx));
bot.command('pro', (ctx) => cmdPro(ctx));
bot.command('siaapro', (ctx) => cmdPro(ctx));
bot.command('img', (ctx) => cmdImg && cmdImg(ctx));
bot.command('reset', (ctx) => cmdReset && cmdReset(ctx));

bot.on('photo', (ctx) => { if(cacheMessage) cacheMessage(ctx); const cap=ctx.message.caption||''; if(cap.startsWith('/pro')||cap.startsWith('/siaapro')) return cmdPro(ctx); });
bot.on('voice', (ctx) => { if(cacheMessage) cacheMessage(ctx); return cmdPro(ctx); });
bot.on('text', (ctx) => { if(cacheMessage) cacheMessage(ctx); if(isSocialCommand && isSocialCommand(ctx)) return handleDlCommand(ctx); if(handleText) return handleText(ctx); });
['video','document','animation'].forEach(t=>{ bot.on(t,(ctx)=> cacheMessage && cacheMessage(ctx)); });

bot.on('callback_query', (ctx) => {
  const d = ctx.callbackQuery?.data || '';
  if (d === 'alive_refresh') return aliveHandler(ctx);
  if (d.startsWith('bscd_')||d.startsWith('bsc_')) return handleSubCallback && handleSubCallback(ctx);
  if (d.startsWith('ytsel_')||d.startsWith('ytv_')||d.startsWith('yta_')) return handleYtCallback && handleYtCallback(ctx);
  if (d.startsWith('ytm_')) return handleYtmCallback && handleYtmCallback(ctx);
  if (d.startsWith('ss_')) return handleSsCallback && handleSsCallback(ctx);
  if (d.startsWith('csz_')) return handleCszCallback && handleCszCallback(ctx);
  if (d.startsWith('mb_')) return handleMbCallback && handleMbCallback(ctx);
  if (d.startsWith('vid_')||d.startsWith('aud_')) return handleDlCallback && handleDlCallback(ctx);
  if (handleCallback) return handleCallback(ctx);
});

bot.launch().then(()=>console.log(`✅ Bot Started via ${LOCAL_API}`)).catch(e=>{console.error(e);process.exit(1);});
process.once('SIGINT',()=>bot.stop('SIGINT')); process.once('SIGTERM',()=>bot.stop('SIGTERM'));
