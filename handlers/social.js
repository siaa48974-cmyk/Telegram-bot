const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const MAX_TG_SIZE = 48 * 1024 * 1024; // GitHub Actions + public Bot API = 50MB
const MAX_DURATION = 10 * 60; // runner limit නිසා 10 min වඩා දිග videos skip

// YouTube bot-check bypass සඳහා common args
const BASE_ARGS = [
  '--extractor-args', 'youtube:player_client=default,web_safari;formats=duplicate,missing_pot',
  '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  '--force-ipv4',
  '--retries', '3',
  '--socket-timeout', '20',
  '--no-warnings'
];

const YT_COOKIES_B64 = process.env.YT_COOKIES_B64 || '';

function ensureCookies() {
  if (!YT_COOKIES_B64) return '';
  const p = '/tmp/cookies.txt';
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, Buffer.from(YT_COOKIES_B64, 'base64'));
  }
  return p;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', [...BASE_ARGS, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 540000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;

          if (/Sign in to confirm/.test(msg)) {
            return reject(new Error(
              'YouTub server IP එක block කරලා.' 
            ));
          }

          return reject(new Error(msg.split('\n').filter(Boolean).slice(-3).join(' | ')));
        }
        resolve(stdout.trim());
      });
  });
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'YouTube';
  if (/instagram\.com/.test(u)) return 'Instagram';
  if (/facebook\.com|fb\.watch/.test(u)) return 'Facebook';
  if (/tiktok\.com/.test(u)) return 'TikTok';
  if (/twitter\.com|x\.com/.test(u)) return 'Twitter';
  return 'Video';
}

function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

async function getInfo(url) {
  const args = [url, '--dump-json', '--no-playlist', '-R', '2'];
  const cookieFile = ensureCookies();
  if (cookieFile) args.push('--cookies', cookieFile);

  const info = JSON.parse((await runYtdlp(args)).split('\n')[0]);

  if (info.duration && info.duration > MAX_DURATION) {
    throw new Error(
      `Video එක දිග වැඩියි (${Math.floor(info.duration / 60)} min). ` +
      `GitHub Actions limit නිසා ${MAX_DURATION / 60} min ට අඩු videos විතරයි.`
    );
  }

  const formats = (info.formats || [])
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const seen = new Set();
  const qualities = [];
  for (const f of formats) {
    if (seen.has(f.height)) continue;
    const size = f.filesize || f.filesize_approx || 0;
    if (size && size > MAX_TG_SIZE) continue;
    seen.add(f.height);
    qualities.push({
      height: f.height,
      formatId: f.format_id,
      ext: f.ext || 'mp4',
      filesize: size
    });
  }

  return {
    title: info.title || 'video',
    duration: info.duration || 0,
    uploader: info.uploader || '',
    thumbnail: info.thumbnail || null,
    platform: detectPlatform(url),
    url,
    qualities
  };
}

async function downloadVideo(url, height) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytd-'));
  const format = height
    ? `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}]/best`
    : 'bestvideo+bestaudio/best';

  const args = [url, '-f', format, '--merge-output-format', 'mp4',
    '-o', path.join(dir, 'video.%(ext)s'), '--no-playlist'];
  const cookieFile = ensureCookies();
  if (cookieFile) args.push('--cookies', cookieFile);

  await runYtdlp(args);

  const file = fs.readdirSync(dir).find(f => f.startsWith('video.'));
  return file ? path.join(dir, file) : null;
}

async function downloadAudio(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-'));

  const args = [url, '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '-o', path.join(dir, 'audio.%(ext)s'), '--no-playlist'];
  const cookieFile = ensureCookies();
  if (cookieFile) args.push('--cookies', cookieFile);

  await runYtdlp(args);

  const file = fs.readdirSync(dir).find(f => f.startsWith('audio.'));
  return file ? path.join(dir, file) : null;
}

function cleanup(filePath) {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {}
}

const pendingCache = new Map();

function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function handleDlCommand(ctx) {
  const url = extractUrl(ctx.message?.text);

  if (!url) {
    return ctx.reply(
      '🔗 Video link එකක් එවන්න:\n\n' +
      '• YouTube (10 min ≤)\n• Instagram\n• Facebook\n• TikTok\n\n' +
      'උදා: /dl https://youtu.be/xxxx'
    );
  }

  const platform = detectPlatform(url);
  const status = await ctx.reply(`🔍 ${platform} link එක analyze කරනවා...`);

  try {
    const info = await getInfo(url);

    if (!info.qualities.length) {
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      return ctx.reply('❌ 50MB limit ඇතුළට ගැලපෙන video format එකක් නැහැ.');
    }

    const id = createId();
    pendingCache.set(id, info);
    setTimeout(() => pendingCache.delete(id), 600000).unref?.();

    const buttons = info.qualities.slice(0, 6).map(q => ({
      text: `${q.height}p${q.filesize ? ` (${(q.filesize / 1048576).toFixed(0)}MB)` : ''}`,
      callback_data: `vid_${id}_${q.height}`
    }));

    const rows = [buttons.slice(0, 3)];
    if (buttons.length > 3) rows.push(buttons.slice(3));
    rows.push([{ text: '🎵 Audio (MP3)', callback_data: `aud_${id}` }]);

    const caption =
      `📥 <b>${esc(info.title)}</b>\n` +
      `📱 Platform: ${info.platform}\n` +
      (info.uploader ? `👤 ${esc(info.uploader)}\n` : '') +
      (info.duration ? `⏱ ${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')}\n` : '') +
      `\n👇 Quality එකක් තෝරන්න`;

    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

    if (info.thumbnail) {
      try {
        return await ctx.replyWithPhoto(info.thumbnail, {
          caption, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: rows }
        });
      } catch {}
    }

    return ctx.reply(caption, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows }
    });
  } catch (error) {
    console.error('DL info error:', error.message);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    return ctx.reply(`❌ ${error.message}`);
  }
}

async function handleDlCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery().catch(() => {});

  const isAudio = data.startsWith('aud_');
  if (!isAudio && !data.startsWith('vid_')) return;

  const [, id, heightStr] = data.split('_');
  const info = pendingCache.get(id);

  if (!info) return ctx.reply('⌛ Request එක expired. නැවත link එක එවන්න.');

  pendingCache.delete(id);
  const height = isAudio ? null : Number(heightStr);

  const status = await ctx.reply(
    isAudio ? '🎵 Audio download කරනවා...' : `⏳ ${height}p download කරනවා...`
  );

  let filePath = null;

  try {
    filePath = isAudio
      ? await downloadAudio(info.url)
      : await downloadVideo(info.url, height);

    if (!filePath) throw new Error('Download failed');

    const size = fs.statSync(filePath).size;

    if (size > MAX_TG_SIZE) {
      cleanup(filePath);
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      return ctx.reply(
        `⚠️ File එක 50MB limit එකට වඩා ලොකුයි (${(size / 1048576).toFixed(1)} MB).\n` +
        `කුඩා quality එකක් try කරන්න.`
      );
    }

    const caption = `✅ ${info.title}\nPOWERED BY CINEMAX`;

    if (isAudio) {
      await ctx.replyWithAudio(
        { source: fs.createReadStream(filePath), filename: path.basename(filePath) },
        { caption }
      );
    } else {
      await ctx.replyWithVideo(
        { source: fs.createReadStream(filePath), filename: path.basename(filePath) },
        { caption, supports_streaming: true }
      );
    }

    cleanup(filePath);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (error) {
    console.error('DL error:', error.message);
    if (filePath) cleanup(filePath);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    return ctx.reply(`❌ Upload අසාර්ථකයි.\nError: ${error.message}`);
  }
}

function isSocialCommand(ctx) {
  const text = ctx.message?.text || '';
  if (text.startsWith('/dl')) return true;
  if (!text.startsWith('/') && extractUrl(text)) return true;
  return false;
}

module.exports = { handleDlCommand, handleDlCallback, isSocialCommand };
