// handlers/moviebox.js — MovieBox (themoviebox.xyz) BFF API → Telegram direct upload
// Guest JWT (x-user header) → Bearer token flow included
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const SITE = 'https://themoviebox.xyz';
const API = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';

const REF_SITES = [
  { Referer: SITE + '/', Origin: SITE },
  { Referer: 'https://moviebox.ph/', Origin: 'https://moviebox.ph' },
];
let activeRef = 0;

const baseHeaders = () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  ...REF_SITES[activeRef],
  'X-Client-Info': '{"timezone":"Asia/Colombo"}',
  'X-Request-Lang': 'en',
  Accept: 'application/json',
  'Content-Type': 'application/json;charset=UTF-8',
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
});

/* ================= Guest JWT manager ================= */
let _token = null;

function harvestToken(resp) {
  // 1) x-user response header (JSON with .token)
  const xu = resp?.headers?.get ? resp.headers.get('x-user') : resp?.headers?.['x-user'];
  if (xu) {
    try {
      const t = JSON.parse(xu).token;
      if (t) { _token = t; console.log('🔑 Guest JWT refreshed (x-user)'); return; }
    } catch (_) {}
  }
  // 2) fallback: set-cookie token=
  const sc = (resp?.headers?.['set-cookie'] || (resp?.headers?.get && resp.headers.get('set-cookie')) || '');
  const m = /token=([^;]+)/.exec(sc);
  if (m) { _token = m[1]; console.log('🔑 Guest JWT refreshed (cookie)'); }
}

async function apiGet(url, extra = {}) {
  const h = baseHeaders();
  if (_token) h.Authorization = `Bearer ${_token}`;
  const resp = await axios.get(url, { headers: { ...h, ...extra }, timeout: 25000 });
  harvestToken(resp);
  return resp.data;
}

async function apiPost(url, payload) {
  const h = baseHeaders();
  if (_token) h.Authorization = `Bearer ${_token}`;
  const resp = await axios.post(url, payload, { headers: h, timeout: 25000 });
  harvestToken(resp);
  return resp.data;
}

// Bootstrap: /home එකෙන් guest JWT එක ගන්නවා (x-user header)
async function ensureToken() {
  if (_token) return _token;
  try {
    const resp = await axios.get(
      `${API}/home?host=themoviebox.xyz`,
      { headers: { ...baseHeaders(), Authorization: undefined }, timeout: 25000 }
    );
    harvestToken(resp);
  } catch (e) {
    // 403/4xx වුනත් response headers වල token එක එනවා ඇති
    if (e.response) harvestToken(e.response);
  }
  console.log(_token ? '✅ Guest JWT ready' : '⚠️ Guest JWT ලැබුණේ නෑ (token නැතුව continue)');
  return _token;
}

const cache = new Map();
const cacheSet = (k, v, ttl = 30 * 60 * 1000) => {
  cache.set(k, { v, time: Date.now() });
  setTimeout(() => cache.delete(k), ttl).unref?.();
};

/* ================= 1. Search ================= */
async function search(query, page = 1) {
  const data = await apiPost(`${API}/subject/search`, { keyword: query, page, perPage: 20 });
  const inner = data?.data || {};
  const raw = inner.items || inner.list || [];
  return raw.map(s => (s.subject || s)).filter(s => s && s.subjectId).map(s => ({
    title: s.title,
    subjectId: String(s.subjectId),
    slug: s.detailPath || '',
    poster: s.cover?.url || null,
    year: s.year || '',
    type: s.subjectType || 'movie',
  }));
}

async function searchWithFallback(query, page = 1) {
  await ensureToken();
  try {
    const r = await search(query, page);
    if (r.length) return r;
  } catch (e) { console.log('mb search fail:', e.response?.status || e.message); }
  // fallback: alt referer + fresh token
  activeRef = 1; _token = null;
  try {
    await ensureToken();
    return await search(query, page);
  } finally { activeRef = 0; }
}

/* ================= 2. Streams (direct MP4 480p/720p) ================= */
async function getDomain() {
  const d = await apiGet(`${API}/media-player/get-domain`);
  return (d?.data || 'https://netfilm.world').replace(/\/$/, '');
}

async function getStreams(subjectId, slug, se = 1, ep = 1) {
  const domain = await getDomain();
  const referer = `${domain}/spa/videoPlayPage/movies/${slug}?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
  const d = await apiGet(
    `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(slug)}`,
    { Referer: referer, Accept: 'application/json' }
  );
  const pd = d?.data || {};
  if (!pd.hasResource) return [];
  return (pd.streams || []).map(s => ({
    quality: `${s.resolutions}p`,
    url: s.url,
    format: (s.format || 'MP4').toUpperCase(),
    size: s.size || 0,
    duration: s.duration || 0,
    codec: s.codecName || '',
  })).filter(s => s.url && s.format === 'MP4');
}

/* ================= Download + convert + upload ================= */
function downloadFile(url, dest, onPct, referer) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? require('http') : require('https');
    mod.get(url, {
      headers: {
        'User-Agent': baseHeaders()['User-Agent'],
        Referer: referer || domainReferer(),
        Range: 'bytes=0-',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, dest, onPct, referer));
      }
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      const out = fs.createWriteStream(dest);
      let got = 0, last = -1;
      res.on('data', (c) => {
        got += c.length;
        if (total && onPct) {
          const pct = Math.floor(got / total * 100);
          if (pct !== last) { last = pct; onPct(pct); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      res.on('error', reject);
    }).on('error', reject);
  });
}

let _domain = null;
function domainReferer() {
  return `${_domain || 'https://netfilm.world'}/`;
}

function convertToMp4(inPath) {
  return new Promise((resolve) => {
    const outPath = inPath.replace(/\.[^.]+$/, '') + '_c.mp4';
    execFile('ffmpeg', ['-y', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath],
      { timeout: 30 * 60 * 1000 }, (err) => {
        if (err || !fs.existsSync(outPath)) return resolve({ outPath: inPath, reencoded: false });
        fs.unlink(inPath, () => {});
        resolve({ outPath, reencoded: false });
      });
  });
}

async function uploadMp4(ctx, mp4Path, caption) {
  await ctx.replyWithVideo(
    { source: fs.createReadStream(mp4Path) },
    { caption, supports_streaming: true, parse_mode: 'HTML' }
  );
}

/* ================= Commands ================= */
async function cmdMoviebox(ctx) {
  const query = (ctx.message?.text || '').replace(/^\/mb\s*/i, '').trim();
  if (!query) return ctx.reply('🎬 Usage: /mb <movie name>\nඋදා: /mb fast x');
  const wait = await ctx.reply('🔎 MovieBox (themoviebox.xyz) search...');
  try {
    const results = await searchWithFallback(query);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    if (!results.length) return ctx.reply(`❌ "${query}" වලට results නෑ.`);
    cacheSet(`mb_r_${ctx.chat.id}`, results);
    const buttons = results.slice(0, 10).map((r, i) =>
      [{ text: `${r.title}${r.year ? ' (' + r.year + ')' : ''}`.slice(0, 60), callback_data: `mb_${i}` }]);
    await ctx.reply(`🎬 <b>${query}</b> — MovieBox results:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error('mb search:', e.response?.status, e.message);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    ctx.reply(`⚠️ MovieBox connect වෙන්න බැරි වුණා.\n\n🛠️ Debug: ${e.response?.status || ''} ${e.message}`);
  }
}

async function handleMbCallback(ctx) {
  const raw = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery();
  const parts = raw.split('_'); // mb_<idx> | mbq_<q>_<idx>_<se>_<ep>

  if (parts[0] === 'mb') {
    const idx = parseInt(parts[1], 10);
    const cached = cache.get(`mb_r_${ctx.chat.id}`);
    const item = cached?.v?.[idx];
    if (!item) return ctx.reply('⌛ Expired. නැවත /mb search කරන්න.');
    cacheSet(`mb_i_${ctx.chat.id}`, { item, idx });
    try {
      _domain = await getDomain();
      const streams = await getStreams(item.subjectId, item.slug, 1, 1);
      if (!streams.length) return ctx.reply(`❌ Streams හම්බුනේ නෑ.\n${SITE}/detail/${item.slug}`);
      cacheSet(`mb_s_${ctx.chat.id}`, streams);

      const kb = ['480', '720'].map(q => {
        const s = streams.find(x => x.quality === q + 'p');
        return [{ text: s ? `🎬 ${s.quality}${s.size ? ' • ' + (s.size / 1024 / 1024 / 1024).toFixed(2) + ' GB' : ''}` : `${q}p ❌`,
                  callback_data: s ? `mbq_${q}_${idx}_1_1` : 'mb_none' }];
      });
      await ctx.editMessageText(`<b>${item.title}</b>\n\nQuality select කරන්න:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      console.error('mb streams:', e.response?.status, e.message);
      ctx.reply(`⚠️ Streams error.\n🛠️ Debug: ${e.response?.status || ''} ${e.message}`);
    }
    return;
  }

  if (parts[0] === 'mbq') {
    const [, q, idx, se, ep] = parts;
    const item = cache.get(`mb_i_${ctx.chat.id}`)?.v?.item;
    const streams = cache.get(`mb_s_${ctx.chat.id}`)?.v || [];
    const chosen = streams.find(s => s.quality === q + 'p');
    if (!item || !chosen) return ctx.reply('⌛ Expired. නැවත /mb search කරන්න.');

    const prog = await ctx.reply(`⬇️ <b>${q}p</b> direct download... 0%`, { parse_mode: 'HTML' });
    const tmp = path.join(os.tmpdir(), `mb_${Date.now()}.mp4`);
    try {
      console.log(`✅ MB direct: ${chosen.url}`);
      await downloadFile(chosen.url, tmp, (pct) => {
        ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
          `⬇️ Download: ${pct}%\n🎬 ${item.title} (${q}p)`, { parse_mode: 'HTML' }).catch(() => {});
      });

      ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
        '🎬 MP4 faststart...', { parse_mode: 'HTML' }).catch(() => {});
      const conv = await convertToMp4(tmp);

      ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
        '⬆️ Telegram upload... (ලොකු file නම් 10-30min)', { parse_mode: 'HTML' }).catch(() => {});
      await uploadMp4(ctx, conv.outPath,
        `🎬 <b>${item.title}</b> (${item.year || ''})\n🎥 <b>${q}p</b> • MP4 • MovieBox\n🔗 ${SITE}/detail/${item.slug}`);

      if (conv.outPath !== tmp) fs.unlink(conv.outPath, () => {});
      fs.unlink(tmp, () => {});
      ctx.telegram.deleteMessage(prog.chat.id, prog.message_id).catch(() => {});
    } catch (e) {
      console.error('mb flow:', e.message);
      fs.unlink(tmp, () => {});
      ctx.reply(`⚠️ Fail: ${e.message}\n\n💡 50MB+ uploads වලට LOCAL BOT API SERVER ඕනෑ.`);
    }
  }
}

module.exports = { cmdMoviebox, handleMbCallback, search, searchWithFallback, getStreams };
