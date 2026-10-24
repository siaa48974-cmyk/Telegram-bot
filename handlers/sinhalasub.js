// handlers/sinhalasub.js — sinhalasub.lk search → poster + OMDb details + download portal buttons
// Movies + TV Series (episode aware) | axios + cheerio only
const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://sinhalasub.lk';
const OMDB_KEY = process.env.OMDB_API_KEY || '';

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
    .replace(/\s*[-–]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function omdbGet(params) {
  try {
    const qs = new URLSearchParams({ apikey: OMDB_KEY, plot: 'short', ...params });
    const { data } = await axios.get(`https://www.omdbapi.com/?${qs}`, { timeout: 10000 });
    return data && data.Response !== 'False' ? data : null;
  } catch { return null; }
}

async function fetchOmdb(title) {
  if (!OMDB_KEY) return null;
  const clean = cleanTitle(title);
  const year = (title.match(/\(((?:19|20)\d{2})\)/) || [])[1];
  let d = year ? await omdbGet({ t: clean, y: year }) : null;
  if (!d) d = await omdbGet({ t: clean }); // year නැතුව retry (අලුත් films වලට)
  return d;
}

function fmtOmdb(o) {
  const ok = (v) => v && v !== 'N/A';
  let s = '\n';
  if (ok(o.Year)) s += `📅 <b>Year:</b> ${esc(o.Year)}\n`;
  if (ok(o.Rated)) s += `🔞 <b>Rated:</b> ${esc(o.Rated)}\n`;
  if (ok(o.imdbRating)) s += `⭐ <b>IMDb:</b> ${esc(o.imdbRating)}/10\n`;
  if (ok(o.Runtime)) s += `⏱ <b>Runtime:</b> ${esc(o.Runtime)}\n`;
  if (ok(o.Genre)) s += `🎭 <b>Genre:</b> ${esc(o.Genre)}\n`;
  if (ok(o.Country)) s += `🌍 <b>Country:</b> ${esc(o.Country)}\n`;
  if (ok(o.Language)) s += `🗣 <b>Language:</b> ${esc(o.Language)}\n`;
  if (ok(o.Director)) s += `🎬 <b>Director:</b> ${esc(o.Director)}\n`;
  if (ok(o.Actors)) s += `👥 <b>Cast:</b> ${esc(o.Actors)}\n`;
  if (ok(o.Plot)) s += `📖 <i>${esc(o.Plot.slice(0, 300))}</i>\n`;
  return s;
}

/* ================= Search ================= */
async function search(query) {
  const url = `${BASE}/?s=${encodeURIComponent(query)}`;
  const { data: html } = await axios.get(url, { headers, timeout: 20000 });
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').split('?')[0].replace(/\/$/, '');
    if (!/^https?:\/\/sinhalasub\.lk\//.test(href)) return;
    const m = href.match(/sinhalasub\.lk\/(movies|tvshows|tv|series|tvo|tva|tvc)\/([a-z0-9\-]+)/i);
    if (!m) return;
    if (['movies', 'tvshows', 'tv', 'series', 'tvo', 'tva', 'tvc'].includes(m[2])) return;
    if (seen.has(href)) return;
    seen.add(href);
    const img = $(el).find('img').first();
    const title = ($(img).attr('alt') || $(el).attr('title') || $(el).text() || m[2].replace(/-/g, ' '))
      .replace(/\s+/g, ' ').trim();
    out.push({
      title: title || m[2],
      url: href + '/',
      image: $(img).attr('src') || $(img).attr('data-src') || null,
      type: /tvshows|\/tv\/|series|tvo|tva|tvc/.test(href) ? 'tv' : 'movie',
    });
  });
  return out.slice(0, 20);
}

/* ================= Download links (portal rows) ================= */
function normQuality(text) {
  const m = String(text).match(/(1080|720|480)\s*p?/i);
  if (!m) return null;
  return m[1] === '1080' ? 'FHD 1080p' : m[1] === '720' ? 'HD 720p' : 'SD 480p';
}

function sectionLabel($, el) {
  let cur = $(el);
  for (let d = 0; d < 6 && cur.length; d++) {
    let prev = cur.prev();
    for (let i = 0; i < 6 && prev.length; i++) {
      if (/^(h[1-6]|strong|b)$/i.test(prev.get(0).tagName || '')) {
        const t = prev.text().trim();
        if (/((S\d{1,2})?\s*-?\s*E(P)?\s*\d{1,3})|Episode\s*\d+/i.test(t)) return t.replace(/\s+/g, ' ').trim();
      }
      prev = prev.prev();
    }
    cur = cur.parent();
  }
  return null;
}

// sinhalasub.lk වල download table: Options | Quality | Size
// හැම row එකකම link එක = https://sinhalasub.lk/links/<id>/
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

/* ================= Command ================= */
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

/* ================= Callbacks ================= */
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

  /* ---- Episode select → ඒ episode එකේ links ---- */
  if (epIdx !== null) {
    const stored = cache.get(`ss_l_${ctx.chat.id}`)?.v;
    const eps = stored ? [...new Set(stored.links.map(l => l.episode))] : [];
    const ep = eps[epIdx];
    if (!ep) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');
    const kb = stored.links.filter(l => l.episode === ep).map(l => [{ text: btnText(l), url: l.url }]);
    return ctx.reply(`📺 <b>${esc(post.title)}</b>\n📌 <b>${esc(ep)}</b>`, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
    });
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
      links.forEach(l => kb.push([{ text: btnText(l), url: l.url }]));
    }
    kb.push([{ text: '🌐 Website එකේ open කරන්න', url: post.url }]);

    const omdb = await fetchOmdb(post.title);
    const caption = (`${post.type === 'tv' ? '📺' : '🎬'} <b>${esc(post.title)}</b>` + (omdb ? '\n' + fmtOmdb(omdb) : '')).slice(0, 1020);
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } };

    // OMDb poster → නැත්නම් site එකේ poster
    const poster = (omdb?.Poster && omdb.Poster !== 'N/A') ? omdb.Poster : post.image;
    if (poster) {
      try { return await ctx.replyWithPhoto({ url: poster }, { caption, ...opts }); } catch { /* text fallback */ }
    }
    return ctx.reply(caption, opts);
  } catch (e) {
    console.error('ss links:', e.message);
    ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    return ctx.reply('⚠️ Details error: ' + e.message + '\n' + post.url);
  }
}

module.exports = { cmdSinhalasub, handleSsCallback, search, getQualityLinks };
