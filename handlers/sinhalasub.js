// handlers/sinhalasub.js — sinhalasub.lk → OMDB info + Telegram direct upload
// Quality: 480p / 720p / 1080p | Puppeteer නැහැ — axios-only resolve
// Search: URL-pattern based (theme-independent) | OMDB: poster + details
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    .replace(/\s*(19|20)\d{2}[^\)]*\)/g, '')       // (2024) etc.
    .replace(/\s*[-–|]\s*Sinhala.*$/i, '')          // "| Sinhala Subtitles" etc.
    .replace(/Sinhala\s*Subtitles?.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const yearMatch = title.match(/\((19|20)\d{2}/);
  try {
    let url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(clean)}&plot=short`;
    if (yearMatch) url += `&y=${yearMatch[0].replace('(', '')}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (data.Response === 'True') return data;
    // TV/fallback: year නැතුව ආයේ try
    const { data: d2 } = await axios.get(
      `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(clean)}&plot=short`,
      { timeout: 15000 });
    if (d2.Response === 'True') return d2;
  } catch (e) { console.error('omdb:', e.message); }
  return null;
}

function fmtOmdb(m) {
  if (!m) return '';
  const g = (k) => (m[k] && m[k] !== 'N/A') ? m[k] : '—';
  return `\n☘️ *${m.Title} (${g('Year')})*\n` +
    `*▫️📅 𝗥𝗲𝗹𝗲𝗮𝘀𝗲* ☛ ${g('Released')}\n` +
    `*▫️⏱ 𝗗ᴜʀᴀᴛɪᴏɴ* ☛ ${g('Runtime')}\n` +
    `*▫️⭐ 𝗜𝗠𝗗𝗕* ☛ ${g('imdbRating')}\n\n` +
    `*▫️🎭 𝗚ᴇɴʀᴇs* ☛ ${g('Genre')}\n` +
    `*▫️🌎 𝗖ᴏᴜɴᴛʀʏ* ☛ ${g('Country')}\n\n` +
    `*▫️📃 𝗗ᴇsᴄʀɪᴘᴛɪᴏɴ* ☛ ${g('Plot')}\n`;
}

/* ================= 1. Search ================= */
async function search(query) {
  const { data } = await axios.get(`${BASE}/?s=${encodeURIComponent(query)}`, { headers, timeout: 20000 });
  const $ = cheerio.load(data);
  const out = [];
  const seen = new Set();

  // URL-pattern based — theme එක මොනවා වුණත් වැඩ කරනවා
  $('a').each((_, el) => {
    const href = ($(el).attr('href') || '').split('?')[0].replace(/\/$/, '');
    const title = ($(el).attr('title') || $(el).text() || '').replace(/\s+/g, ' ').trim();
    if (!/sinhalasub\.lk\/(movies|tvshows)\/.+/.test(href)) return;
    if (!title || title.length < 5) return;
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ title, url: href });
  });

  return out.slice(0, 15);
}

/* ================= 2. Quality links ================= */
async function getQualityLinks(url) {
  const { data } = await axios.get(url, { headers, timeout: 20000 });
  const $ = cheerio.load(data);
  const links = [];
  const seen = new Set();

  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = ($(el).text() || '') + ' ' + href;
    if (!/^https?:/.test(href)) return;
    let q = null;
    if (/1080/i.test(text)) q = 'FHD 1080p';
    else if (/720/i.test(text)) q = 'HD 720p';
    else if (/480/i.test(text)) q = 'SD 480p';
    if (!q) return;

    // table rows වල server එකත් අල්ලන්න (DLServer-01/02, Dotflix වගේ)
    const row = $(el).closest('tr');
    const server = row.length ? ($(row).find('td').first().text() || '').trim() : '';
    const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
    const key = href + q;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      quality: q,
      url: href,
      size: sizeMatch ? sizeMatch[1] + sizeMatch[2].toUpperCase() : '',
      server: server || 'Direct'
    });
  });

  return links;
}

/* ================= 3. Direct resolve ================= */
async function resolveDirect(url) {
  // Pixeldrain direct
  const pd = url.match(/pixeldrain\.com\/u\/(\w+)/i);
  if (pd) return { directUrl: `https://pixeldrain.com/api/file/${pd[1]}?download` };

  // අනිත් hosts — redirect follow කරලා final URL එක ගන්නවා
  try {
    const res = await axios.get(url, {
      headers, timeout: 60000, maxRedirects: 10, responseType: 'stream'
    });
    const finalUrl = res.request?.res?.responseUrl
      || res.request?._redirectable?._currentUrl
      || url;
    res.data.destroy?.(); // body download නොකර stream එක close

    if (/\.mp4|\.mkv|\.zip|\.rar(\?|$)/i.test(finalUrl)
      || /octet-stream|video/i.test(res.headers['content-type'] || '')) {
      return { directUrl: finalUrl };
    }
  } catch (e) { /* page එකක් නම් පහළින් ආයේ try */ }

  // Page එකක් නම් ඇතුළේ direct link හොයනවා
  const { data: html } = await axios.get(url, { headers, timeout: 30000 });
  const $ = cheerio.load(html);
  let found = null;
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!found && /pixeldrain|files-payout|filepayout|dlserver|\.mp4|\.mkv/i.test(href)) found = href;
  });
  if (!found) throw new Error('direct link හම්බුනේ නෑ');
  const pd2 = found.match(/pixeldrain\.com\/u\/(\w+)/i);
  if (pd2) found = `https://pixeldrain.com/api/file/${pd2[1]}?download`;
  return { directUrl: found };
}

/* ================= 4. Download ================= */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    axios.get(url, {
      headers, responseType: 'stream', timeout: 120000,
      maxContentLength: Infinity, maxBodyLength: Infinity
    }).then(res => {
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0, lastPct = -1;
      const ws = fs.createWriteStream(dest);
      res.data.on('data', (c) => {
        done += c.length;
        if (total) {
          const pct = Math.floor(done / total * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress?.(pct); }
        }
      });
      res.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      res.data.on('error', reject);
    }).catch(reject);
  });
}

/* ================= 5. Convert ================= */
function convertToMp4(inPath) {
  return new Promise((resolve) => {
    const outPath = inPath.replace(/\.mp4$/, '_c.mp4');
    const { execFile } = require('child_process');
    execFile('ffmpeg', ['-y', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath],
      { timeout: 30 * 60 * 1000 }, (err) => {
        if (err || !fs.existsSync(outPath)) {
          return resolve({ outPath: inPath, reencoded: false }); // original එකම යවන්න
        }
        fs.unlink(inPath, () => {});
        resolve({ outPath, reencoded: false });
      });
  });
}

/* ================= 6. Upload ================= */
async function uploadMp4(ctx, filePath, caption) {
  const stat = fs.statSync(filePath);
  if (stat.size > 1900 * 1024 * 1024) throw new Error('File එක Telegram limit එකට වඩා ලොකුයි (2GB)');
  await ctx.replyWithVideo({ source: fs.createReadStream(filePath) }, {
    caption, parse_mode: 'HTML', supports_streaming: true
  });
}

/* ================= Command ================= */
async function cmdSinhalasub(ctx) {
  const q = ctx.message.text.replace(/^\/ss\s*/i, '').trim();
  if (!q) return ctx.reply('🔎 මේ විදිහට දෙන්න: <code>/ss venom</code>', { parse_mode: 'HTML' });
  const wait = await ctx.reply('🔎 SinhalaSub එකේ හොයනවා...', { parse_mode: 'HTML' });
  try {
    const results = await search(q);
    if (!results.length) {
      ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
      return ctx.reply(`❌ "${q}" සඳහා results නෑ.\n💡 වෙන title එකකින් උත්සාහ කරන්න (උදා: /ss fall)`);
    }
    cacheSet(`ss_r_${ctx.chat.id}`, results);
    const buttons = results.map((r, i) => [{ text: '🎬 ' + r.title.slice(0, 60), callback_data: `ss_${i}` }]);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    await ctx.reply(`🎬 <b>${q}</b> — results:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error('ss search:', e.message);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    ctx.reply('⚠️ SinhalaSub connect වෙන්න බැරි වුණා.');
  }
}

/* ================= Callback ================= */
async function handleSsCallback(ctx) {
  const raw = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery().catch(() => {});  // spinner කිටින්ම clear — hang fix
  let quality = null, idx;
  if (raw.startsWith('ssq_')) { [, quality, idx] = raw.split('_'); }
  else { idx = raw.replace(/^ss_/, ''); }
  idx = parseInt(idx, 10);
  if (isNaN(idx)) return;

  const cached = cache.get(`ss_r_${ctx.chat.id}`);
  const post = cached?.v?.[idx];
  if (!post) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');

  /* ---- Step 1: film select → OMDB details + quality buttons ---- */
  if (!quality) {
    const status = await ctx.reply('⏳ Movie details + links බලනවා...', { parse_mode: 'HTML' });
    try {
      const links = await getQualityLinks(post.url);
      if (!links.length) {
        ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
        return ctx.reply(`❌ Download links හම්බුනේ නෑ.\n${post.url}`);
      }
      cacheSet(`ss_l_${ctx.chat.id}`, { post, links });

      const omdb = await fetchOmdb(post.title);
      const kb = QUALITIES.map(q => {
        const l = links.find(x => x.quality === q);
        return [{ text: l ? `🎬 ${q}${l.size ? ' • ' + l.size : ''}` : `${q} ❌`,
                  callback_data: l ? `ssq_${q.split(' ')[1]}_${idx}` : 'ss_none' }];
      });
      kb.push([{ text: '🔗 Direct Download URL', callback_data: `ssq_direct_${idx}` }]);

      const caption = `🎬 <b>${post.title}</b>\n🔗 ${post.url}` + (omdb ? fmtOmdb(omdb) : '');
      ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});

      // OMDB poster → photo විදිහට + quality buttons ඒකම යටින්
      if (omdb?.Poster && omdb.Poster !== 'N/A') {
        return ctx.replyWithPhoto({ url: omdb.Poster },
          { caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } })
          .catch(() => ctx.reply(caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }));
      }
      return ctx.reply(caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      console.error('ss links:', e.message);
      ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
      return ctx.reply('⚠️ Details error: ' + e.message + '\n' + post.url);
    }
  }

  const cached2 = cache.get(`ss_l_${ctx.chat.id}`);
  const { links } = cached2?.v || {};

  /* ---- Step 2a: Direct URL ---- */
  if (quality === 'direct') {
    if (!links?.length) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');
    const msg = await ctx.reply('🔗 <b>Direct Download URLs</b> resolve කරනවා...', { parse_mode: 'HTML' });
    let out = `🔗 <b>${post.title}</b> — Direct Download URLs\n\n`;
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

  /* ---- Step 2b: quality select → download → upload ---- */
  const qKey = quality === '1080' || quality === '1080p' ? 'FHD 1080p'
             : quality === '720'  || quality === '720p'  ? 'HD 720p'
             : quality === '480'  || quality === '480p'  ? 'SD 480p'
             : null;
  const chosen = (links || []).filter(l => l.quality === qKey);
  if (!qKey || !chosen.length) return ctx.reply(`❌ ${qKey || quality} links නෑ. අනිත් quality එකක් select කරන්න.`);

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
    });

    ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
      '🎬 MP4 convert කරනවා... (mkv නම් ටිකක් යනවා)',
      { parse_mode: 'HTML' }).catch(() => {});
    const conv = await convertToMp4(tmp);
    console.log(`✅ Convert done: ${conv.outPath}`);

    ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
      '⬆️ Telegram එකට upload... (ලොකු file නම් 10-30min)',
      { parse_mode: 'HTML' }).catch(() => {});
    await uploadMp4(ctx, conv.outPath,
      `🎬 <b>${post.title}</b>\n🎥 <b>${qKey}</b> • MP4\n🔗 ${post.url}`);

    fs.unlink(tmp, () => {});
    if (conv.outPath !== tmp) fs.unlink(conv.outPath, () => {});
    ctx.telegram.deleteMessage(prog.chat.id, prog.message_id).catch(() => {});
  } catch (e) {
    console.error('ss flow:', e.message);
    fs.unlink(tmp, () => {});
    ctx.telegram.deleteMessage(prog.chat.id, prog.message_id).catch(() => {});
    ctx.reply(`⚠️ Fail: ${e.message}\n\n💡 50MB+ uploads වලට LOCAL BOT API SERVER ඕනෑ.`);
  }
}

module.exports = { cmdSinhalasub, handleSsCallback, search, getQualityLinks, resolveDirect };
