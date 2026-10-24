// handlers/sinhalasub.js — sinhalasub.lk search → poster + OMDb details + TV direct upload
// Movies + TV Series (episode aware) | axios + cheerio only
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://sinhalasub.lk';
const OMDB_KEY = process.env.OMDB_API_KEY || '';
const MAX_DL = Number(process.env.SS_MAX_SIZE_MB || 2000) * 1024 * 1024; // upload limit

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8',
  Referer: BASE + '/',
};

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const cache = new Map();
const cacheSet = (k, v, ttl = 30 * 60 * 1000) => {
  cache.set(k, { v, time: Date.now() });
  setTimeout(() => cache.delete(k), ttl).unref?.();
};

/* ================= OMDB ================= */
function cleanTitle(title) {
  return title
    .split('|')[0]
    .replace(/Sinhala\s*Subtitles?.*$/i, '')
    .replace(/\s*\((19|20)\d{2}\)/g, '')
    .replace(/S\d{1,2}\s*[-–]?\s*E\d{1,2}.*/i, '')
    .replace(/\s*[-–]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function omdbGet(params) {
  try {
    const qs = new URLSearchParams({ apikey: OMDB_KEY, plot: 'full', ...params });
    const { data } = await axios.get(`https://www.omdbapi.com/?${qs}`, { timeout: 10000 });
    return data && data.Response !== 'False' ? data : null;
  } catch { return null; }
}

async function fetchOmdb(title) {
  if (!OMDB_KEY) return null;
  const clean = cleanTitle(title);
  const year = (title.match(/\((19|20)\d{2}\)/) || [])[1];
  let d = await omdbGet({ t: clean, ...(year ? { y: year } : {}) });
  if (!d && /S\d/i.test(title)) d = await omdbGet({ t: clean, type: 'series' });
  if (!d) d = await omdbGet({ s: clean }).then(r => r?.Search?.[0] ? omdbGet({ i: r.Search[0].imdbID }) : null);
  return d;
}

/* ඔයාට ඕනා caption format එක */
function fmtOmdb(o) {
  const g = (k) => (o[k] && o[k] !== 'N/A' ? String(o[k]) : '');
  const cast = g('Actors').split(',').slice(0, 4).join(',');
  let out = '';
  out += `🎁 <b>NAME</b> - <b>${esc(g('Title'))}</b>\n`;
  if (g('imdbRating')) out += `▫️⭐ Rᴀᴛɪɴɢ ➟ ${esc(g('imdbRating'))}/10 ⭐ (IMDb)\n`;
  if (g('Released') || g('Year')) out += `▫️📅 Rᴇʟᴇᴀꜱᴇ ➟ ${esc(g('Released') !== 'N/A' ? g('Released') : g('Year'))}\n`;
  if (g('Genre')) out += `▫️🎭 Gᴇɴʀᴇꜱ ➟ ${esc(g('Genre'))}\n`;
  if (cast) out += `▫️👥 Cᴀꜱᴛ ➟ ${esc(cast)}\n`;
  if (g('Plot')) out += `▫️📖 Sᴛᴏʀʏ ➟ ${esc(g('Plot').slice(0, 300))}\n`;
  out += `\n<b>CINEMAX BY CINEMAX</b>`;
  return out;
}

/* ================= SEARCH ================= */
async function search(q) {
  const { data: html } = await axios.get(`${BASE}/?s=${encodeURIComponent(q)}`, { headers, timeout: 25000 });
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('article, .result-item, .item, .post').each((_, el) => {
    const a = $(el).find('a[href]').filter((i, x) => /sinhalasub\.lk\/(movies|tvshows|series|episodes)\//i.test($(x).attr('href'))).first();
    const href = a.attr('href');
    if (!href || seen.has(href)) return;
    const img = $(el).find('img').first();
    const image = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
    const title = ($(el).find('h2, h3, .title, .tt').first().text()
      || img.attr('alt') || a.text() || '').replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    const isTv = /\/(tvshows|series|episodes)\//i.test(href);
    results.push({ title, url: href, image, type: isTv ? 'tv' : 'movie' });
  });
  return results.slice(0, 15);
}

/* ================= QUALITY LINKS ================= */
const normQuality = (t) => {
  const m = String(t).match(/\b(4K|2160p|1080p|720p|480p|WEB[- ]?DL|BluRay|HDRip|HDTV|HDR|10bit)\b/i);
  return m ? m[1].toUpperCase() : '';
};
const sectionLabel = ($, $row) => {
  const $h = $row.closest('div, section, table, ul').prevAll('h2, h3, h4, strong, p').first();
  const t = ($h.text() || '').replace(/\s+/g, ' ').trim();
  return /^episode/i.test(t) || /E\d{1,3}/i.test(t) ? t.slice(0, 40) : '';
};

async function getQualityLinks(postUrl) {
  const { data: html } = await axios.get(postUrl, { headers, timeout: 25000 });
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();
  const sizeOf = (t) => (String(t).match(/\d+(?:\.\d+)?\s*(?:GB|MB)/i) || [''])[0].trim();

  $('a[href*="/links/"]').each((_, a) => {
    let href;
    try { href = new URL($(a).attr('href'), postUrl).href; } catch { return; }
    if (!/sinhalasub\.lk\/links\//i.test(href) || seen.has(href)) return;
    const $row = $(a).closest('tr').length ? $(a).closest('tr') : $(a).closest('li,div,p').first();
    const rowText = $row.text();
    seen.add(href);
    links.push({
      server: $(a).text().trim() || 'Download',
      quality: normQuality(rowText) || '',
      size: sizeOf(rowText),
      url: href,
      episode: sectionLabel($, $row),
    });
  });
  return links;
}

const btnText = (l) => [l.server, l.quality, l.size].filter(Boolean).join(' • ').slice(0, 60);

/* ================= DIRECT LINK RESOLVE + UPLOAD ================= */
// /links/<id> page එකෙන් ඇතුළේ තියෙන file-host link ගන්න
async function resolveDirectFile(linkPageUrl) {
  let candidate = null;
  try {
    const { data: html } = await axios.get(linkPageUrl, { headers, timeout: 20000 });
    const $ = cheerio.load(html);
    const hosts = [];
    $('a[href]').each((_, a) => {
      const h = $(a).attr('href') || '';
      if (/pixeldrain\.com\/(u|l)\/|gofile\.io\/d\/|krakenfiles\.com\/|cdn\.pixeldrain|\.mp4$|\.mkv$|\.zip$/i.test(h)) hosts.push(h);
    });
    if (hosts.length) candidate = hosts[0];
  } catch { /* fallthrough */ }

  if (!candidate) return null;

  // pixeldrain → direct api
  let m = candidate.match(/pixeldrain\.com\/(u|l)\/(\w+)/i);
  if (m) return { url: `https://pixeldrain.com/api/file/${m[2]}?download`, name: 'file' };

  // gofile → api
  m = candidate.match(/gofile\.io\/d\/(\w+)/i);
  if (m) {
    try {
      const t = (await axios.get(`https://api.gofile.io/getServer`, { timeout: 10000 })).data?.data?.server;
      if (t) return { url: `https://${t}.gofile.io/download/web/${m[1]}/`, name: 'file' };
    } catch { }
    return null;
  }

  // කෙලින්ම direct file
  if (/\.(mp4|mkv|avi|zip|rar)$/i.test(candidate)) return { url: candidate, name: decodeURIComponent(candidate.split('/').pop().split('?')[0]) || 'file' };

  return null;
}

async function uploadToTelegram(ctx, post, epLabel, direct, statusMsg) {
  const tmp = path.join(os.tmpdir(), `ss_${Date.now()}.bin`);
  try {
    const head = await axios.head(direct.url, { headers, timeout: 15000, maxRedirects: 5 }).catch(() => null);
    const size = Number(head?.headers?.['content-length'] || 0);
    if (size && size > MAX_DL) throw new Error(`File එක විශාලයි (${(size / 1048576).toFixed(0)}MB) — limit එකට වඩා`);

    await ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined,
      `⬇️ Download කරනවා... ${size ? '(' + (size / 1048576).toFixed(0) + 'MB)' : ''}`).catch(() => {});

    const res = await axios.get(direct.url, {
      headers: { ...headers, Referer: BASE + '/' },
      responseType: 'stream', timeout: 0, maxRedirects: 5,
    });
    await new Promise((ok, no) => { res.data.pipe(fs.createWriteStream(tmp)).on('finish', ok).on('error', no); });
    const fsize = fs.statSync(tmp).size;
    if (!fsize) throw new Error('Download fail');

    const name = direct.name && direct.name !== 'file' ? direct.name : `${cleanTitle(post.title)}${epLabel ? ' - ' + epLabel : ''}.mp4`;
    const caption = `📺 <b>${esc(post.title)}</b>${epLabel ? `\n📌 ${esc(epLabel)}` : ''}\n\n<b>CINEMAX BY CINEMAX</b>`.slice(0, 1020);
    const sendOpts = { caption, parse_mode: 'HTML', supports_streaming: true };

    if (/\.(mp4|mkv|avi|webm)$/i.test(name)) {
      await ctx.replyWithVideo({ source: fs.createReadStream(tmp), filename: name }, sendOpts);
    } else {
      await ctx.replyWithDocument({ source: fs.createReadStream(tmp), filename: name }, { caption: sendOpts.caption, parse_mode: 'HTML' });
    }
    return true;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

/* ================= COMMAND ================= */
async function cmdSinhalasub(ctx) {
  const q = (ctx.message.text || '').replace(/^\/ss(@\w+)?\s*/i, '').trim();
  if (!q) return ctx.reply('🎬 Usage: <code>/ss movie or tv series name</code>', { parse_mode: 'HTML' });

  const status = await ctx.reply('🔍 sinhalasub.lk එකේ search කරනවා...');
  try {
    const results = await search(q);
    ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    if (!results.length) return ctx.reply(`❌ "<b>${esc(q)}</b>" සඳහා results නෑ.`, { parse_mode: 'HTML' });

    cacheSet(`ss_r_${ctx.chat.id}`, results);
    const kb = results.map((r, i) => [{
      text: `${r.type === 'tv' ? '📺' : '🎬'} ${r.title.slice(0, 45)}`,
      callback_data: `ss_${i}`,
    }]);
    return ctx.reply(`🔎 <b>${esc(q)}</b> — ${results.length} results\nඑකක් select කරන්න:`, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
    });
  } catch (e) {
    console.error('ss search:', e.message);
    ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    return ctx.reply('⚠️ Search error: ' + e.message);
  }
}

/* ================= CALLBACKS ================= */
async function handleSsCallback(ctx) {
  const raw = ctx.callbackQuery?.data || '';
  ctx.answerCbQuery?.().catch(() => {});
  if (raw === 'ss_none') return;

  let epIdx = null, idx;
  if (raw.startsWith('sse_')) { const p = raw.split('_'); epIdx = parseInt(p[1], 10); idx = parseInt(p[2], 10); }
  else idx = parseInt(raw.replace(/^ss_/, ''), 10);
  if (isNaN(idx)) return;

  const post = cache.get(`ss_r_${ctx.chat.id}`)?.v?.[idx];
  if (!post) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');

  /* ---- Episode select ---- */
  if (epIdx !== null) {
    const stored = cache.get(`ss_l_${ctx.chat.id}`)?.v;
    const eps = stored ? [...new Set(stored.links.map(l => l.episode))] : [];
    const ep = eps[epIdx];
    if (!ep) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');
    const status = await ctx.reply(`⏳ ${ep} — link බලනවා...`);
    try {
      const epLinks = stored.links.filter(l => l.episode === ep);
      const kb = [];
      for (const l of epLinks) {
        const direct = await resolveDirectFile(l.url);
        if (direct) {
          const ok = await uploadToTelegram(ctx, post, ep, direct, status).catch(() => false);
          if (ok) return; // upload වුනා → done
        }
        kb.push([{ text: btnText(l), url: l.url }]);
      }
      ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
      if (!kb.length) return ctx.reply('❌ Direct upload fail — links නෑ.');
      return ctx.reply(`📺 <b>${esc(post.title)}</b>\n📌 <b>${esc(ep)}</b>\n\n⚠️ Direct upload බැරි උනා — link එකෙන් download කරන්න:`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
      });
    } catch (e) {
      ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
      return ctx.reply('⚠️ Upload error: ' + e.message);
    }
  }

  /* ---- Post select → poster + OMDb + links ---- */
  const status = await ctx.reply('⏳ Links බලනවා...');
  try {
    const links = await getQualityLinks(post.url);
    ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    if (!links.length) return ctx.reply(`❌ Download links හම්බුනේ නෑ.\n${post.url}`);
    cacheSet(`ss_l_${ctx.chat.id}`, { post, links });

    const hasEpisodes = links.some(l => l.episode);
    const kb = [];
    if (hasEpisodes) {
      const eps = [...new Set(links.map(l => l.episode).filter(Boolean))];
      eps.slice(0, 40).forEach((ep, ei) => {
        kb.push([{ text: `📺 ${ep} (${links.filter(l => l.episode === ep).length})`.slice(0, 60), callback_data: `sse_${ei}_${idx}` }]);
      });
    } else {
      // Movie → direct upload attempt කරනවා
      for (const l of links) {
        const direct = await resolveDirectFile(l.url);
        if (direct) {
          const ok = await uploadToTelegram(ctx, post, '', direct, status).catch(() => false);
          if (ok) return;
        }
      }
      links.forEach(l => kb.push([{ text: btnText(l), url: l.url }]));
    }
    kb.push([{ text: '🌐 Website එකේ open කරන්න', url: post.url }]);

    const omdb = await fetchOmdb(post.title);
    const det = omdb ? fmtOmdb(omdb) : '';
    const caption = det.slice(0, 1020);
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } };

    const poster = (omdb?.Poster && omdb.Poster !== 'N/A') ? omdb.Poster : post.image;
    if (poster) {
      try { return await ctx.replyWithPhoto({ url: poster }, { caption, ...opts }); } catch { }
    }
    return ctx.reply(caption, opts);
  } catch (e) {
    console.error('ss links:', e.message);
    ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    return ctx.reply('⚠️ Details error: ' + e.message + '\n' + post.url);
  }
}

module.exports = { cmdSinhalasub, handleSsCallback, search, getQualityLinks };
