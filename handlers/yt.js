// handlers/yt.js — YouTube search + download (yt-dlp)
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const MAX_TG_SIZE = process.env.LOCAL_BOT_API ? 1900 * 1024 * 1024 : 48 * 1024 * 1024;
const MAX_DURATION = 10 * 60;

const BASE_ARGS = [
  '--extractor-args', 'youtube:player_client=default,web_safari;formats=duplicate,missing_pot',
  '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  '--force-ipv4', '--retries', '3', '--socket-timeout', '20', '--no-warnings'
];

const YT_COOKIES_B64 = process.env.YT_COOKIES_B64 || '';

function ensureCookies() {
  if (!YT_COOKIES_B64) return '';
  const p = '/tmp/yt_cookies.txt';
  if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(YT_COOKIES_B64, 'base64'));
  return p;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', [...BASE_ARGS, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 540000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;
          if (/Sign in to confirm/.test(msg)) {
            return reject(new Error('YouTube IP block කරලා — YT_COOKIES_B64 secret එක දාන්න.'));
          }
          return reject(new Error(msg.slice(-400)));
        }
        resolve(stdout);
      });
  });
}

function ytUrl(q) {
  return 'ytsearch10:' + q.trim();
}

// ---------- Search ----------
async function searchYouTube(query) {
  const out = await runYtdlp([
    ytUrl(query), '--flat-playlist', '--dump-json', '--no-warnings'
  ]);
  const results = out.trim().split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(v => v.id)
    .slice(0, 8)
    .map(v => ({
      id: v.id,
      title: v.title || 'Unknown',
      channel: v.uploader || v.channel || '',
      duration: v.duration || 0,
      url: `https://youtu.be/${v.id}`
    }));
  return results;
}

// ---------- Info ----------
async function getVideoInfo(url) {
  const out = await runYtdlp([url, '--dump-json', '--no-playlist']);
  const info = JSON.parse(out);

  if (info.duration && info.duration > MAX_DURATION) {
    throw new Error(`Video එක දිග වැඩියි (${Math.floor(info.duration / 60)} min). Limit: 10 min.`);
  }

  const qualities = new Set();
  (info.formats || []).forEach(f => {
    if (f.height && (f.video_codec || '').startsWith('avc')) qualities.add(f.height);
  });
  const heights = [...qualities].sort((a, b) => b - a).filter(h => h <= 1080);

  return { url, title: info.title, thumbnail: info.thumbnail, uploader: info.uploader, duration: info.duration, heights };
}

// ---------- Download ----------
async function downloadVideo(url, height) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytv-'));
  const format = height
    ? `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}]/best`
    : 'bestvideo+bestaudio/best';
  const args = [url, '-f', format, '--merge-output-format', 'mp4',
    '-o', path.join(dir, 'video.%(ext)s'), '--no-playlist'];
  const cf = ensureCookies();
  if (cf) args.push('--cookies', cf);
  await runYtdlp(args);
  const file = fs.readdirSync(dir).find(f => f.startsWith('video.'));
  return file ? path.join(dir, file) : null;
}

async function downloadAudio(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-'));
  const args = [url, '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '-o', path.join(dir, 'audio.%(ext)s'), '--no-playlist'];
  const cf = ensureCookies();
  if (cf) args.push('--cookies', cf);
  await runYtdlp(args);
  const file = fs.readdirSync(dir).find(f => f.startsWith('audio.'));
  return file ? path.join(dir, file) : null;
}

function cleanup(fp) { try { fs.rmSync(path.dirname(fp), { recursive: true, force: true }); } catch {} }

const pending = new Map();
function createId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function fmtDur(s) {
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- /yt command ----------
async function cmdYt(ctx) {
  const raw = ctx.message?.text || '';
  const arg = raw.replace(/^\/yt\s*/i, '').trim();
  if (!arg) {
    return ctx.reply('🎬 Usage:\n• `/yt <search text>` — search කරන්න\n• `/yt <youtube url>` — direct download', { parse_mode: 'Markdown' });
  }

  const isUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/i.test(arg);

  if (isUrl) return sendQualityMenu(ctx, { url: arg, title: 'YouTube Video' });

  const status = await ctx.reply(`🔍 YouTube එකේ "${esc(arg)}" search කරනවා...`);
  try {
    const results = await searchYouTube(arg);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

    if (!results.length) return ctx.reply('❌ Results නැහැ. වෙන text එකක් try කරන්න.');

    const id = createId();
    pending.set(id, { type: 'search', results });
    setTimeout(() => pending.delete(id), 600000).unref?.();

    const keyboard = {
      inline_keyboard: results.map(r => [{
        text: `${r.title.slice(0, 40)}${r.duration ? ` [${fmtDur(r.duration)}]` : ''}`,
        callback_data: `ytsel_${id}_${results.indexOf(r)}`
      }])
    };
    return ctx.reply('👇 Video එකක් තෝරන්න:', { reply_markup: keyboard });
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    return ctx.reply(`❌ Search error: ${e.message}`);
  }
}

async function sendQualityMenu(ctx, info) {
  const status = await ctx.reply('🔍 Video info ගන්නවා...');
  try {
    const infoFull = await getVideoInfo(info.url);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

    const id = createId();
    pending.set(id, { type: 'video', ...infoFull });
    setTimeout(() => pending.delete(id), 600000).unref?.();

    const rows = infoFull.heights.slice(0, 6).map(h => [{
      text: `${h}p`,
      callback_data: `ytv_${id}_${h}`
    }]);
    rows.push([{ text: '🎵 Audio (MP3)', callback_data: `yta_${id}` }]);

    const caption =
      `📥 <b>${esc(infoFull.title)}</b>\n` +
      (infoFull.uploader ? `👤 ${esc(infoFull.uploader)}\n` : '') +
      (infoFull.duration ? `⏱ ${fmtDur(infoFull.duration)}\n` : '') +
      '\n👇 Quality එකක් තෝරන්න';

    if (infoFull.thumbnail) {
      try {
        return await ctx.replyWithPhoto(infoFull.thumbnail, {
          caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows }
        });
      } catch {}
    }
    return ctx.reply(caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    return ctx.reply(`❌ ${e.message}`);
  }
}

// ---------- Callbacks ----------
async function handleYtCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery().catch(() => {});

  if (data.startsWith('ytsel_')) {
    const [, id, idx] = data.split('_');
    const cached = pending.get(id);
    if (!cached) return ctx.reply('⌛ Expired. නැවත search කරන්න.');
    const r = cached.results[Number(idx)];
    if (!r) return ctx.reply('❌ Result එක හමු වුණේ නැහැ.');
    return sendQualityMenu(ctx, { url: r.url });
  }

  const isAudio = data.startsWith('yta_');
  if (!isAudio && !data.startsWith('ytv_')) return;

  const [, id, hStr] = data.split('_');
  const info = pending.get(id);
  if (!info) return ctx.reply('⌛ Expired. නැවත link/search එවන්න.');
  pending.delete(id);

  const height = isAudio ? null : Number(hStr);
  const status = await ctx.reply(isAudio ? '🎵 MP3 download කරනවා...' : `⏳ ${height}p download කරනවා...`);

  let filePath = null;
  try {
    filePath = isAudio ? await downloadAudio(info.url) : await downloadVideo(info.url, height);
    if (!filePath) throw new Error('Download failed');

    const size = fs.statSync(filePath).size;
    if (size > MAX_TG_SIZE) {
      cleanup(filePath);
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      return ctx.reply(`⚠️ File එක limit එකට වඩා ලොකුයි (${(size / 1048576).toFixed(1)} MB). කුඩා quality එකක් try කරන්න.`);
    }

    const caption = `✅ ${info.title}\nPOWERED BY CINEMAX`;
    if (isAudio) {
      await ctx.replyWithAudio({ source: fs.createReadStream(filePath), filename: path.basename(filePath) }, { caption });
    } else {
      await ctx.replyWithVideo({ source: fs.createReadStream(filePath), filename: path.basename(filePath) }, { caption, supports_streaming: true });
    }
    cleanup(filePath);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    console.error('YT error:', e.message);
    if (filePath) cleanup(filePath);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    return ctx.reply(`❌ අසාර්ථකයි: ${e.message}`);
  }
}

module.exports = { cmdYt, handleYtCallback };
