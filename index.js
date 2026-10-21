const fs = require('fs');
const path = require('path');
const ai2Path = path.join(__dirname, 'handlers', 'ai2.js');
if (!fs.existsSync(ai2Path)) {
  const code = `const axios=require('axios');async function cmdAi2(ctx){const p=ctx.message.text.split(' ').slice(1).join(' ').trim();if(!p)return ctx.reply('❗ /ai2 <ප්‍රශ්නය>');const t=await ctx.reply('🤖 SiAA AI 2 හිතනවා...');try{const u='https://text.pollinations.ai/'+encodeURIComponent(p)+'?model=openai';const{data}=await axios.get(u,{timeout:60000});const r=typeof data==='string'?data:JSON.stringify(data);await ctx.telegram.editMessageText(ctx.chat.id,t.message_id,null,r.slice(0,4096));}catch(e){await ctx.telegram.editMessageText(ctx.chat.id,t.message_id,null,'⚠️ Error');}}module.exports={cmdAi2};`;
  fs.mkdirSync(path.join(__dirname, 'handlers'), { recursive: true });
  fs.writeFileSync(ai2Path, code);
}

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
if (!BOT_TOKEN) throw new Error('TG_TOKEN not set');

const bot = new Telegraf(BOT_TOKEN, { apiRoot: process.env.BOT_API_SERVER || 'https://api.telegram.org', handlerTimeout: 900000 });

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

['video', 'photo', 'document', 'animation'].forEach(t => { bot.on(t, (ctx) => cacheMessage(ctx)); });

bot.on('callback_query', (ctx) => {
  const d = ctx.callbackQuery?.data || '';
  if (d.startsWith('bscd_') || d.startsWith('bsc_')) return handleSubCallback(ctx);
  if (d.startsWith('ytsel_') || d.startsWith('ytv_') || d.startsWith('yta_')) return handleYtCallback(ctx);
  if (d.startsWith('ytm_')) return handleYtmCallback(ctx);
  if (d.startsWith('ss_')) return handleSsCallback(ctx);
  if (d.startsWith('csz_')) return handleCszCallback(ctx);
  if (d.startsWith('mb_')) return handleMbCallback(ctx);
  if (d.startsWith('vid_') || d.startsWith('aud_')) return handleDlCallback(ctx);
  return handleCallback(ctx);
});

bot.launch().then(() => console.log('Bot Started ✅ ai2 ready')).catch(e => { console.error(e); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
