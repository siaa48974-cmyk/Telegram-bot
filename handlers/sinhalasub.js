// handlers/sinhalasub.js — sinhalasub.lk scraper → OMDB info + Telegram direct upload
// Movies + TV Series (episode aware) | axios + cheerio only | ffmpeg optional
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const BASE = 'https://sinhalasub.lk';
const QUALITIES = ['SD 480p', 'HD 720p', 'FHD 1080p'];
const OMDB_KEY = process.env.OMDB_API_KEY || '';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8',
  Referer: BASE + '/',
};

const cache = new Map();
const cacheSet = (k, v, ttl = 30 * 60 * 1000) => {
  cache.set(k, { v, time: Date.now() });
  setTimeout(() => cache.delete(k), ttl).unref?.();
};

/* ================= OMDB ================= */
async function fetchOmdb(title) {
  if (!OMDB_KEY) return null;
  const clean = title
    .replace(/\s*\((19|20)\d{2}\)/g, '')
    .replace(/\s*[-–|]\s*Sinhala.*$/i, '')
    .replace(/Sinhala\s*Subtitles?.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const yearMatch = title.match(/\((19|20)\d{2}/);
  try {
    let url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(clean)}&plot=short`;
    if (yearMatch) url += `&y=${yearMatch[0].replace('(', '')}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data && data.Response !== 'False' ? data : null;
  } catch { return null; }
}

function fmtOmdb(o) {
  let s = '\n';
  if (o.Year) s += `📅 <b>Year:</b> ${o.Year}\n`;
  if (o.Rated && o.Rated !== 'N/A') s += `🔞 <b>Rated:</b> ${o.Rated}\n`;
  if (o.imdbRating && o.imdbRating !== 'N/A') s += `⭐ <b>IMDb:</b> ${o.imdbRating}/10\n`;
  if (o.Genre && o.Genre !== 'N/A') s += `🎭 <b>Genre:</b> ${o.Genre}\n`;
  if (o.Director && o.Director !== 'N/A') s += `🎬 <b>Director:</b> ${o.Director}\n`;
  if (o.Actors && o.Actors !== 'N/A') s += `👥 <b>Cast:</b> ${o.Actors}\n`;
  if (o.Plot && o.Plot !== 'N/A') s += `📖 <i>${o.Plot}</i>\n`;
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
    if (['movies', 'tvshows', 'tv', 'series', 'tvo', 'tva', 'tvc'].includes(m[2])) return; // category pages
    if (seen.has(href)) return;
    seen.add(href);
    const img = $(el).find('img').first();
    const title = ($(img).attr('alt') || $(el).attr('title') || $(el).text() || m[2].replace(/-/g, ' '))
      .replace(/\s+/g, ' ').trim();
    const isTv = /tvshows|\/tv\/|series|tvo|tva|tvc/.test(href);
    out.push({
      title: title || m[2],
      url: href + '/',
      image: $(img).attr('src') || $(img).attr('data-src') || null,
      type: isTv ? 'tv' : 'movie',
    });
  });
  return out.slice(0, 20);
}

/* ================= Quality/Episode extraction ================= */
const FILE_HOST_RE = /pixeldrain|drive\.google\.com|filespayout|dotflix|dlserver|mega\.nz|mediafire|1fichier|rcloud|terabox|gofile|streamtape|mp4upload|doors|sinhalasub\.lk\/(go|dl)/i;

const BAD_HOST_RE = /adserver|adstudio|gravatar|image\.tmdb|google-analytics|googletagmanager|fonts\.|wp-content|wp-login|wp-json|schema\.org|facebook\.com\/sharer|twitter\.com\/intent|whatsapp\.com\/channel|youtube\.com\/@|fb\.me|reddit\.com\/submit|tumblr\.com\/widgets|pinterest\.com\/pin|blogger\.com|vk\.com|mailto:|javascript:/i;

function normQuality(text) {
  const m = String(text).match(/(1080|720|480)\s*p?/i);
  if (!m) return null;
  const n = m[1];
  return n === '1080' ? 'FHD 1080p' : n === '720' ? 'HD 720p' : 'SD 480p';
}

function sectionLabel($, el) {
  // climb up to 6 ancestors looking for a heading that looks like an episode label
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

const isInternal = (u) => {
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    const h = new URL(u).hostname;
    return /sinhalasub\.lk$/i.test(h);
  } catch { return true; }
};

async function getQualityLinks(postUrl) {
  const { data: html } = await axios.get(postUrl, { headers, timeout: 25000 });
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();
  const sizeOf = (t) => (String(t).match(/\d+(?:\.\d+)?\s*(?:GB|MB)/i) || [''])[0].trim();

  const push = (href, qText, size, ep) => {
    if (!href) return;
    href = href.trim();
    if (!href || href.startsWith('javascript') || href === '#') return;
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//i.test(href)) {
      // relative → absolute
      try { href = new URL(href, postUrl).href; } catch { return; }
    }
    // url-encoded inner URL unwrap (?url=https%3A%2F%2Fpixeldrain...)
    const enc = href.match(/(?:url|link|target|u|go)=(https?%3A%2F%2F[^&]+)/i);
    if (enc) { try { href = decodeURIComponent(enc[1]); } catch {} }
    if (BAD_HOST_RE.test(href)) return;
    const quality = normQuality(qText);
    if (!quality) return;
    if (isInternal(href) && !/sinhalasub\.lk\/(go|dl)/i.test(href)) return;
    const key = href + '|' + quality + '|' + (ep || '');
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ quality, size: size || '', url: href, episode: ep || null });
  };

  /* --- 1) Tables: rows with quality + ANY external link (host check නැහැ) --- */
  $('table').each((_, tbl) => {
    $(tbl).find('tr').each((__, tr) => {
      const $tr = $(tr);
      const rowText = $tr.text();
      const ep = sectionLabel($, $tr);
      let found = false;
      $tr.find('a[href]').each((___, a) => {
        const href = $(a).attr('href') || '';
        if (isInternal(href)) return;
        push(href, rowText, sizeOf(rowText), ep);
        found = true;
      });
      // onclick / data attributes fallback
      $tr.find('[data-href],[data-link],[onclick]').each((___, el) => {
        const d = $(el).attr('data-href') || $(el).attr('data-link')
          || ($(el).attr('onclick') || '').match(/https?:\/\/[^'"]+/)?.[0];
        if (d) push(d, rowText, sizeOf(rowText), ep);
      });
      // plain-text URL inside row
      if (!found) {
        const m = rowText.match(/https?:\/\/[^\s|<>"']+/);
        if (m && !isInternal(m[0]) && !BAD_HOST_RE.test(m[0])) push(m[0], rowText, sizeOf(rowText), ep);
      }
    });
  });

  /* --- 2) Standalone anchors (button-style themes) --- */
  $('a[href]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    if (isInternal(href)) return;
    const ctxText = $a.closest('tr,div,li,p').first().text() || $a.text();
    const q = normQuality(ctxText);
    if (!q && !FILE_HOST_RE.test(href)) return; // quality context නැත්නම් file-host link විතරක් ගන්න
    push(href, ctxText, sizeOf(ctxText), sectionLabel($, $a));
  });

  /* --- 3) Raw HTML regex fallback (JS-rendered / escaped links) --- */
  if (!links.length) {
    const rawMatches = html.match(/https?:\\?\/\\?\/[^"'\\\s<>]{8,}/g) || [];
    const cleaned = rawMatches.map(u => u.replace(/\\\//g, '/'));
    const hosts = cleaned.filter(u => FILE_HOST_RE.test(u) && !BAD_HOST_RE.test(u));
    [...new Set(hosts)].forEach(u => {
      const quality = normQuality(u) || 'HD 720p';
      links.push({ quality, size: '', url: u, episode: null });
    });
  }

  return links;
}

/* ================= Direct URL resolve ================= */
async function resolveDirect(url) {
  url = url.trim();

  // Pixeldrain → API direct stream
  const px = url.match(/pixeldrain\.com\/(?:u|l)\/([A-Za-z0-9]+)/);
  if (px) {
    return { directUrl: `https://pixeldrain.com/api/file/${px[1]}?download`, headers: { Referer: 'https://pixeldrain.com/' } };
  }

  // Google Drive (confirm-token flow for large files)
  const gd = url.match(/drive\.google\.com\/(?:file\/d\/|uc\?(?:.*&)?id=|open\?id=)([A-Za-z0-9_-]{10,})/);
  if (gd) {
    const id = gd[1];
    let durl = `https://drive.google.com/uc?export=download&id=${id}`;
    try {
      const r = await axios.get(durl, { headers, maxRedirects: 0, validateStatus: () => true, responseType: 'arraybuffer', timeout: 30000 });
      const body = r.data ? Buffer.from(r.data).toString() : '';
      const ct = (r.headers['content-type'] || '');
      if (/text\/html/i.test(ct)) {
        const action = body.match(/action="([^"]+)"/)?.[1];
        const confirm = body.match(/name="confirm" value="([^"]+)"/)?.[1];
        const uuid = body.match(/name="uuid" value="([^"]+)"/)?.[1];
        if (action) {
          durl = action.includes('http') ? action : 'https://drive.google.com' + action;
          if (confirm) durl += `&confirm=${confirm}`;
          if (uuid) durl += `&uuid=${uuid}`;
        } else {
          const t = body.match(/confirm=([\w-]+)/)?.[1];
          if (t) durl += `&confirm=${t}`;
        }
      }
    } catch { /* plain uc url එකෙන් try කරනවා */ }
    return { directUrl: durl, headers: {} };
  }

  // FilesPayout — delay page එකෙන් direct link එක ගන්නවා
  if (/filespayout\.com/i.test(url)) {
    try {
      const r = await axios.get(url, { headers, timeout: 30000, maxRedirects: 5, validateStatus: () => true });
      const body = r.data || '';
      // form action / direct file url එකක් තියෙනවද බලනවා
      const action = body.match(/action="(https?:\/\/[^"]+)"[^>]*>\s*<button/i)?.[1]
        || body.match(/https?:\/\/[^\s"'<>]+\/files?\/[^\s"'<>]+/i)?.[0]
        || body.match(/location\.href\s*=\s*['"]([^'"]+)['"]/)?.[1];
      if (action && !/filespayout\.com\/?$/i.test(action)) return { directUrl: action, headers: { Referer: url } };
      // POST flow (token form) — common on filespayout
      const token = body.match(/name="token"[^>]*value="([^"]+)"/)?.[1];
      if (token) {
        const p = await axios.post(url, `token=${token}`, {
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: url },
          timeout: 30000, maxRedirects: 5, validateStatus: () => true,
        });
        const m2 = (p.data || '').match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|avi|zip|rar)[^\s"'<>]*/i)
          || (p.data || '').match(/action="(https?:\/\/[^"]+)"[^>]*>\s*<button/i)?.[1];
        if (m2) return { directUrl: m2, headers: { Referer: url } };
      }
      return { directUrl: url, headers: {} }; // browser එකෙන් open කරන්න වෙන්න පුළුවන්
    } catch { return { directUrl: url, headers: {} }; }
  }

  // Generic: follow redirect chain manually, return final URL
  let current = url;
  for (let i = 0; i < 10; i++) {
    let res;
    try {
      res = await axios.get(current, { headers, maxRedirects: 0, validateStatus: () => true, responseType: 'stream', timeout: 30000 });
    } catch (e) { throw new Error('resolve fail: ' + (e.message || e)); }
    const loc = res.headers.location;
    if (loc && [301, 302, 303, 307, 308].includes(res.status)) {
      res.data.destroy?.();
      current = new URL(loc, current).href;
      continue;
    }
    const ct = res.headers['content-type'] || '';
    if (/text\/html/i.test(ct)) {
      const chunks = [];
      for await (const c of res.data) { chunks.push(c); if (chunks.length > 40) break; }
      const body = Buffer.concat(chunks).toString();
      res.data.destroy?.();
      const cand = body.match(/https?:\/\/[^"'\\\s]+(?:pixeldrain\.com\/api\/[^"'\\\s]+|drive\.google\.com\/uc[^"'\\\s]+|\.(?:mp4|mkv|avi)[^\s"'\\]*)/i);
      if (cand) return resolveDirect(cand[0]);
      throw new Error('HTML page, direct link හම්බුනේ නෑ');
    }
    res.data.destroy?.();
    return { directUrl: current, headers: { Referer: new URL(current).origin } };
  }
  throw new Error('Too many redirects');
}

/* ================= Download / Convert / Upload ================= */
async function downloadFile(url, dest, onProgress, extraHeaders = {}) {
  const res = await axios.get(url, {
    headers: { ...headers, ...extraHeaders },
    responseType: 'stream', timeout: 60000, maxRedirects: 5,
  });
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let received = 0, lastPct = -5;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    res.data.on('data', (c) => {
      received += c.length;
      if (total && onProgress) {
        const pct = Math.floor((received / total) * 100);
        if (pct >= lastPct + 5) { lastPct = pct; onProgress(pct); }
      }
    });
    res.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    res.data.on('error', reject);
  });
}

async function convertToMp4(inPath) {
  if (/\.mp4$/i.test(inPath)) return { outPath: inPath };
  const outPath = inPath.replace(/\.[^.]+$/, '') + '_conv.mp4';
  const ff = (args) => new Promise((resolve) => execFile('ffmpeg', args, { timeout: 3 * 3600e3 }, (err) => resolve(!err)));
  if (await ff(['-y', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath])) return { outPath };
  if (await ff(['-y', '-i', inPath, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', outPath])) return { outPath };
  return { outPath: inPath }; // ffmpeg නැත්නම් raw file එකම
}

async function uploadMp4(ctx, filePath, caption) {
  const size = fs.statSync(filePath).size;
  const opts = { caption, parse_mode: 'HTML' };
  if (size <= 49 * 1024 * 1024) {
    await ctx.replyWithVideo({ source: filePath, filename: path.basename(filePath) },
      { ...opts, supports_streaming: true });
  } else {
    await ctx.replyWithDocument({ source: filePath, filename: path.basename(filePath) }, opts);
  }
}

/* ================= Command ================= */
async function cmdSinhalasub(ctx) {
  const q = (ctx.message.text || '').replace(/^\/ss(@\w+)?\s*/i, '').trim();
  if (!q) return ctx.reply('🎬 Usage: <code>/ss movie or tv series name</code>', { parse_mode: 'HTML' });

  const status = await ctx.reply('🔍 sinhalasub.lk එකේ search කරනවා...', { parse_mode: 'HTML' });
  try {
    const results = await search(q);
    ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    if (!results.length) return ctx.reply(`❌ "<b>${q}</b>" සඳහා results නෑ.`, { parse_mode: 'HTML' });

    cacheSet(`ss_r_${ctx.chat.id}`, results);
    const kb = results.map((r, i) => [{
      text: `${r.type === 'tv' ? '📺' : '🎬'} ${r.title.slice(0, 45)}`,
      callback_data: `ss_${i}`,
    }]);
    return ctx.reply(`🔎 <b>${q}</b> — ${results.length} results\nඑකක් select කරන්න:`, {
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
  let quality = null, epIdx = null, idx;
  if (raw.startsWith('ssq_')) { const parts = raw.split('_'); quality = parts[1]; idx = parts[2]; epIdx = parts[3] ?? null; }
  else if (raw.startsWith('sse_')) { const parts = raw.split('_'); epIdx = parts[1]; idx = parts[2]; }
  else { idx = raw.replace(/^ss_/, ''); }
  idx = parseInt(idx, 10);
  if (isNaN(idx)) return;

  const cached = cache.get(`ss_r_${ctx.chat.id}`);
  const post = cached?.v?.[idx];
  if (!post) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');
  ctx.answerCbQuery?.().catch(() => {});

  /* ---- Step 1: post select → links (+OMDB) ---- */
  if (!quality && epIdx === null) {
    const status = await ctx.reply('⏳ Links බලනවා...', { parse_mode: 'HTML' });
    try {
      const links = await getQualityLinks(post.url);
      if (!links.length) {
        ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
        return ctx.reply(`❌ Download links හම්බුනේ නෑ.\n${post.url}`);
      }
      cacheSet(`ss_l_${ctx.chat.id}`, { post, links });

      const hasEpisodes = links.some(l => l.episode);
      const kb = [];
      let omdb = null;
      if (hasEpisodes) {
        const eps = [...new Set(links.map(l => l.episode))];
        eps.slice(0, 40).forEach((ep, ei) => {
          kb.push([{ text: `📺 ${ep} (${links.filter(l => l.episode === ep).length})`, callback_data: `sse_${ei}_${idx}` }]);
        });
        if (eps.length > 40) kb.push([{ text: `⚠️ තව episodes ${eps.length - 40}ක් ඇති — site එකෙන් බලන්න`, callback_data: 'ss_none' }]);
      } else {
        omdb = await fetchOmdb(post.title);
        QUALITIES.forEach(q => {
          const l = links.find(x => x.quality === q);
          kb.push([{ text: l ? `🎬 ${q}${l.size ? ' • ' + l.size : ''}` : `${q} ❌`,
                     callback_data: l ? `ssq_${q.split(' ')[1].replace('p', '')}_${idx}` : 'ss_none' }]);
        });
        kb.push([{ text: '🔗 Direct Download URLs', callback_data: `ssq_direct_${idx}` }]);
      }

      const caption = `${post.type === 'tv' ? '📺' : '🎬'} <b>${post.title}</b>\n🔗 ${post.url}`;
      ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
      const sendOpts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } };
      const posterUrl = post.image || (omdb?.Poster && omdb.Poster !== 'N/A' ? omdb.Poster : null);
      if (posterUrl) {
        return ctx.replyWithPhoto({ url: posterUrl }, { caption: caption + (omdb && !hasEpisodes ? fmtOmdb(omdb) : ''), ...sendOpts })
          .catch(() => ctx.reply(caption, sendOpts));
      }
      return ctx.reply(caption, sendOpts);
    } catch (e) {
      console.error('ss links:', e.message);
      ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
      return ctx.reply('⚠️ Details error: ' + e.message + '\n' + post.url);
    }
  }

  const cached2 = cache.get(`ss_l_${ctx.chat.id}`);
  let links = cached2?.v?.links || [];

  /* ---- Step 1b: episode select ---- */
  if (!quality && epIdx !== null) {
    const eps = [...new Set(links.map(l => l.episode))];
    const ep = eps[epIdx];
    if (!ep) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');
    const epLinks = links.filter(l => l.episode === ep);
    cacheSet(`ss_e_${ctx.chat.id}`, { post, links: epLinks, ep });
    const kb = QUALITIES.map(q => {
      const l = epLinks.find(x => x.quality === q);
      return [{ text: l ? `🎬 ${q}${l.size ? ' • ' + l.size : ''}` : `${q} ❌`,
                callback_data: l ? `ssq_${q.split(' ')[1].replace('p', '')}_${idx}_${epIdx}` : 'ss_none' }];
    });
    kb.push([{ text: '🔗 Direct Download URLs', callback_data: `ssq_direct_${idx}_${epIdx}` }]);
    return ctx.editMessageText(`📺 <b>${post.title}</b>\n📌 <b>${ep}</b> — quality එකක් තෝරන්න:`, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
    }).catch(() => ctx.reply(`📺 ${ep} — quality එකක් තෝරන්න:`, { reply_markup: { inline_keyboard: kb } }));
  }

  /* ---- Step 2a: Direct URLs ---- */
  if (quality === 'direct') {
    // episode flow නම් episode links භාවිතා කරන්න
    const epStore = cache.get(`ss_e_${ctx.chat.id}`)?.v;
    if (epStore && epIdx !== null) links = epStore.links;
    if (!links?.length) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');
    const msg = await ctx.reply('🔗 <b>Direct URLs</b> resolve කරනවා...', { parse_mode: 'HTML' });
    let out = `🔗 <b>${post.title}</b>${epStore?.ep ? ' — ' + epStore.ep : ''} — Direct URLs\n\n`;
    let any = false;
    for (const l of links) {
      try {
        const r = await resolveDirect(l.url);
        any = true;
        out += `🎥 <b>${l.quality}${l.size ? ' • ' + l.size : ''}</b>\n⬇️ <code>${r.directUrl}</code>\n\n`;
      } catch (e) { console.error(`❌ resolve fail [${l.quality}] ${l.url}: ${e.message}`); }
    }
    ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    if (!any) return ctx.reply('⚠️ Direct URL resolve කරන්න බැරි වුණා.');
    return ctx.reply(out, { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  /* ---- Step 2b: quality → download → upload ---- */
  const qKey = quality === '1080' ? 'FHD 1080p' : quality === '720' ? 'HD 720p' : quality === '480' ? 'SD 480p' : null;
  const epStore = cache.get(`ss_e_${ctx.chat.id}`)?.v;
  const pool = (epStore && epIdx !== null) ? epStore.links : links;
  const chosen = (pool || []).filter(l => l.quality === qKey);
  if (!qKey || !chosen.length) return ctx.reply(`❌ ${qKey || quality} links නෑ. අනිත් quality එකක් තෝරන්න.`);

  const prog = await ctx.reply(`⬇️ <b>${qKey}</b> resolve + download... 0%`, { parse_mode: 'HTML' });
  const tmp = path.join(os.tmpdir(), `ss_${Date.now()}.mp4`);
  try {
    let resolved = null, lastErr;
    for (const l of chosen) {
      try { resolved = await resolveDirect(l.url); break; } catch (e) { lastErr = e; }
    }
    if (!resolved) throw lastErr || new Error('resolve fail');
    console.log(`✅ Resolved: ${resolved.directUrl}`);

    await downloadFile(resolved.directUrl, tmp, (pct) => {
      ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
        `⬇️ Download: ${pct}%\n🎬 ${post.title}`, { parse_mode: 'HTML' }).catch(() => {});
    }, resolved.headers || {});

    ctx.telegram.editMessageText(prog.chat.id, prog.message_id, '🎬 MP4 convert කරනවා... (mkv නම් ටිකක් යනවා)', { parse_mode: 'HTML' }).catch(() => {});
    const conv = await convertToMp4(tmp);

    ctx.telegram.editMessageText(prog.chat.id, prog.message_id, '⬆️ Telegram එකට upload... (ලොකු file නම් 10-30min)', { parse_mode: 'HTML' }).catch(() => {});
    const label = (epStore && epIdx !== null ? epStore.ep + ' • ' : '') + qKey;
    await uploadMp4(ctx, conv.outPath, `🎬 <b>${post.title}</b>\n🎥 <b>${label}</b> • MP4\n🔗 ${post.url}`);

    fs.unlink(tmp, () => {});
    if (conv.outPath !== tmp) fs.unlink(conv.outPath, () => {});
    ctx.telegram.deleteMessage(prog.chat.id, prog.message_id).catch(() => {});
  } catch (e) {
    console.error('ss flow:', e.message);
    fs.unlink(tmp, () => {});
    ctx.telegram.deleteMessage(prog.chat.id, prog.message_id).catch(() => {});
    ctx.reply(`⚠️ Fail: ${e.message}\n\n💡 50MB+ uploads වලට LOCAL BOT API SERVER ඕනෑ (LOCAL_API_URL env).`);
  }
}

module.exports = { cmdSinhalasub, handleSsCallback, search, getQualityLinks, resolveDirect };
