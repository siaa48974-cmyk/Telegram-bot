// handlers/ytm.js — YouTube Music search + MP3 download (InnerTube + yt-dlp multi-client fallback)
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const MAX_TG_SIZE = process.env.LOCAL_BOT_API ? 1900 * 1024 * 1024 : 48 * 1024 * 1024;

// NOTE: --extractor-args මෙතන නෑ — fallback chain එකේදී per-client විදිහට දානවා
const BASE_ARGS = [
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

// ---------- Single yt-dlp run (base) ----------
function runYtdlpBase(args) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', [...BASE_ARGS, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 540000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;
          if (/Sign in to confirm/.test(msg)) return reject(new Error('IP_BLOCK'));
          return reject(new Error(msg.slice(-400)));
        }
        resolve(stdout);
      });
  });
}

// ---------- Multi-client download with fallback ----------
// එක client එකක් "Sign in to confirm" block වුණාම ඊළඟ එක try කරනවා.
const CLIENTS = ['tv', 'web_safari', 'ios', 'mweb'];

function withClient(args, client) {
  return ['--extractor-args', `youtube:player_client=${client};formats=duplicate,missing_pot`, ...args];
}

async function runYtdlpWithFallback(args) {
  const cf = ensureCookies();
  let lastErr = null;
  for (const client of CLIENTS) {
    try {
      return await runYtdlpBase(withClient(args, client));
    } catch (e) {
      console.log(`[ytm] client "${client}" failed: ${String(e.message).slice(-120)}`);
      lastErr = e;
      if (e.message === 'IP_BLOCK') continue; // block → ඊළඟ client
      throw e; // වෙන error එකක් නම් retry කරන්න තේරුමක් නෑ
    }
  }
  if (cf) {
    // cookies තිබුණත් block වුණා නම් cookies force කරලා default client එකෙන් අන්තිම පාරක්
    try {
      return await runYtdlpBase(['--cookies', cf, ...args]);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    'YouTube එක මේ server IP එක block කරලා (හැම client එකකටම). ' +
    'YT_COOKIES_B64 secret එක add/refresh කරන්න, නැත්නම් VPS එකකින් run කරන්න. ' +
    'Details: ' + String(lastErr?.message || '').slice(-200)
  );
}

// ---------- YouTube Music search (InnerTube WEB_REMIX) ----------
const INNERTUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const CONTEXT = {
  context: {
    client: {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20250310.01.00',
      hl: 'en',
      gl: 'LK',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      originalUrl: 'https://music.youtube.com/'
    },
    user: { lockedSafetyMode: false }
  }
};

const SONGS_PARAMS = 'EgWKAQIIAWoKEAoQCRADEAQQBQ%3D%3D';

function joinRuns(col) {
  return (col?.musicResponsiveListItemColumn?.text?.runs || [])
    .map(r => r.text).join(' ').trim();
}

async function searchYtMusic(query, limit = 10) {
  const { data } = await axios.post(
    `https://music.youtube.com/youtubei/v1/search?alt=json&key=${INNERTUBE_KEY}`,
    { ...CONTEXT, query, params: SONGS_PARAMS },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Origin': 'https://music.youtube.com'
      },
      timeout: 15000
    }
  );

  const results = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.musicResponsiveListItemRenderer) {
      const r = o.musicResponsiveListItemRenderer;
      const videoId =
        r.playlistItemData?.videoId ||
        r.overlay?.[0]?.musicItemThumbnailOverlayRenderer?.content
          ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
        r.flexColumns?.[0]?.musicResponsiveListItemColumn?.text?.runs?.[0]
          ?.navigationEndpoint?.watchEndpoint?.videoId;
      const title = joinRuns(r.flexColumns?.[0] || {});
      if (videoId && title) {
        const cols = r.flexColumns || [];
        const artist = cols.slice(1).map(joinRuns).filter(Boolean).join(' · ');
        const durText = joinRuns(cols[cols.length - 1] || {});
        const dm = durText.match(/(\d+):(\d{2})/);
        results.push({
          videoId, title, artist,
          duration: dm ? Number(dm[1]) * 60 + Number(dm[2]) : null,
          url: `https://music.youtube.com/watch?v=${videoId}`
        });
      }
    }
    Object.values(o).forEach(walk);
  };
  walk(data);

  console.log(`[ytm] InnerTube results: ${results.length}`);
  return results.slice(0, limit);
}

// ---------- Fallback: yt-dlp search ----------
async function searchViaYtdlp(query, limit = 10) {
  const out = await runYtdlpWithFallback(['--dump-json', '--flat-playlist', `ytsearch${limit}:${query}`]);
  const items = out.trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return items.map(v => ({
    videoId: v.id,
    title: v.title,
    artist: v.uploader || '',
    duration: v.duration,
    url: v.url || `https://www.youtube.com/watch?v=${v.id}`
  }));
}

async function searchSongs(query) {
  try {
    const r = await searchYtMusic(query);
    if (r.length) return { source: 'ytm', results: r };
  } catch (e) {
    console.log('[ytm] InnerTube failed:', e.message);
  }
  return { source: 'yt', results: await searchViaYtdlp(query) };
}

// ---------- MP3 download (best quality + cover art) ----------
async function downloadMp3(url, title) {
  const dir = path.join(os.tmpdir(), 'ytm_' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const safe = title.replace(/[^\w\s()-]/g, '').slice(0, 60).trim() || 'song';
  const args = [
    '-f', 'bestaudio/best',
    '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
    '--embed-thumbnail', '--add-metadata',
    '-o', path.join(dir, safe + '.%(ext)s'), '--no-playlist', url
  ];
  await runYtdlpWithFallback(args);
  const file = fs.readdirSync(dir).find(f => f.endsWith('.mp3'));
  return file ? path.join(dir, file) : null;
}

function cleanup(fp) { try { fs.rmSync(path.dirname(fp), { recursive: true, force: true }); } catch {} }

const pending = new Map();
const createId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDur = (s) => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';

// ---------- /song command ----------
async function cmdSong(ctx) {
  const arg = (ctx.message?.text || '').replace(/^\/song\s*/i, '').trim();
  if (!arg) return ctx.reply('🎵 Usage: `/song <song name>`', { parse_mode: 'Markdown' });

  const status = await ctx.reply(`🎧 YouTube Music එකේ "${esc(arg)}" search කරනවා...`);
  try {
    const { source, results } = await searchSongs(arg);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    if (!results.length) return ctx.reply('❌ Results නැහැ. වෙන text එකක් try කරන්න.');

    const id = createId();
    pending.set(id, results);
    setTimeout(() => pending.delete(id), 600000).unref?.();

    const header = source === 'ytm' ? '🎶 YouTube Music:' : '🎶 YouTube (fallback):';
    const keyboard = {
      inline_keyboard: results.map((r, i) => [{
        text: `🎵 ${r.title.slice(0, 35)} — ${String(r.artist).slice(0, 20)}${r.duration ? ` [${fmtDur(r.duration)}]` : ''}`,
        callback_data: `ytm_${id}_${i}`
      }])
    };
    return ctx.reply(`${header}\n👇 Song එකක් තෝරන්න (MP3):`, { reply_markup: keyboard });
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    return ctx.reply(`❌ Search error: ${e.message}`);
  }
}

// ---------- Callback ----------
async function handleYtmCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery().catch(() => {});
  if (!data.startsWith('ytm_')) return;

  const [, id, idx] = data.split('_');
  const results = pending.get(id);
  if (!results) return ctx.reply('⌛ Expired. නැවත `/song` දාන්න.');
  pending.delete(id);

  const r = results[Number(idx)];
  if (!r) return ctx.reply('❌ Result එක හමු වුණේ නැහැ.');

  const status = await ctx.reply(`⬇️ "${esc(r.title)}" MP3 download කරනවා...`);
  let filePath = null;
  try {
    filePath = await downloadMp3(r.url, r.title);
    if (!filePath) throw new Error('Download failed');

    const size = fs.statSync(filePath).size;
    if (size > MAX_TG_SIZE) {
      cleanup(filePath);
      return ctx.reply(`⚠️ File එක ලොකු වැඩියි (${(size / 1048576).toFixed(1)} MB).`);
    }

    await ctx.replyWithAudio(
      { source: fs.createReadStream(filePath), filename: path.basename(filePath) },
      { caption: `✅ ${r.title} — ${r.artist}\nPOWERED BY CINEMAX`, title: r.title, performer: r.artist }
    );
    cleanup(filePath);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    console.error('YTM error:', e.message);
    if (filePath) cleanup(filePath);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    return ctx.reply(`❌ අසාර්ථකයි: ${e.message}`);
  }
}

module.exports = { cmdSong, handleYtmCallback };
