const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const BASE = process.env.CSZ_BASE || 'https://cinesubz.net';
const ASITHA_KEY = process.env.ASITHA_KEY || '';
const ASITHA_BASE = 'https://back.asitha.top/api';
const QUALITY = '720p'; // ✅ 720p විතරයි

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8',
  Referer: BASE + '/',
};

const cszCache = new Map();
const cacheSet = (k, v, ttl = 30 * 60 * 1000) => {
  cszCache.set(k, { v, time: Date.now() });
  setTimeout(() => cszCache.delete(k), ttl).unref?.();
};

/* ---------- 1. Search ---------- */
async function search(query) {
  const { data } = await axios.get(`${BASE}/?s=${encodeURIComponent(query)}`, { headers, timeout: 20000 });
  const $ = cheerio.load(data);
  const results = [], seen = new Set();
  $('a[href*="cinesubz"]').each((_, el) => {
    const $a = $(el), href = $a.attr('href') || '';
    const title = ($a.find('h2, h3').first().text() || $a.attr('title') || '').trim();
    if (!title || title.length < 8 || seen.has(href)) return;
    if (/\/(search|genre|release|keyword|account|category|tags?|wp-|page|contact|privacy|terms)/i.test(href)) return;
    if (/\/(movies|tvshows)\/?$/i.test(href)) return;
    if (/#|javascript:/i.test(href)) return;
    seen.add(href);
    const img = $a.find('img').first();
    results.push({ title, url: href, thumb: img.attr('src') || img.attr('data-src') || null });
  });
  return results.slice(0, 20);
}

/* ---------- 2. Quality links — 720p filter සමඟ ---------- */
async function getQualityLinks(postUrl) {
  const { data } = await axios.get(postUrl, { headers, timeout: 20000 });
  const $ = cheerio.load(data);
  const links = [], seen = new Set();

  $('#directdownloadlinks > div > div > table > tbody > tr, #directdownloadlinks table tbody tr').each((_, el) => {
    const $tr = $(el);
    const href = $tr.find('td > a').attr('href') || '';
    const qText = $tr.find('td > a > strong').text().trim();
    const size = $tr.find('td').eq(1).text().trim();
    if (!href || seen.has(href)) return;
    seen.add(href);
    const q = qText.match(/(1080p|720p|480p)/i)?.[1] || qText;
    links.push({
      quality: String(q).toLowerCase().trim(),
      text: qText || 'Download',
      size: size || '',
      url: href.startsWith('http') ? href : new URL(href, postUrl).href,
    });
  });

  if (!links.length) {
    $('#directdownloadlinks a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const qText = $(el).text().trim();
      if (!href || seen.has(href)) return;
      if (!/(720p|1080p|480p|\.zip($|\?)|\.mp4($|\?)|\.mkv($|\?)|\/dl)/i.test(`${qText} ${href}`)) return;
      seen.add(href);
      const q = `${qText} ${href}`.match(/(1080p|720p|480p)/i)?.[1] || 'unknown';
      links.push({ quality: q.toLowerCase(), text: qText || 'Download', size: '', url: href.startsWith('http') ? href : new URL(href, postUrl).href });
    });
  }

  if (!links.length) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!/\/dl\/|\?dl|download-sub/i.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);
      const qText = $(el).text().trim();
      const q = `${qText} ${href}`.match(/(1080p|720p|480p)/i)?.[1] || 'unknown';
      links.push({ quality: q.toLowerCase(), text: qText || 'Download', size: '', url: href.startsWith('http') ? href : new URL(href, postUrl).href });
    });
  }

  // ✅ 720p විතරයි — 1080p/480p filter out
  const only720 = links.filter(l => l.quality === QUALITY);

  // 720p නැත්නම් පහළ quality එකක් (480p) fallback — 1080p skip (ලොකු වේගයෙන් ලොකු)
  const fallback = only720.length ? only720 : links.filter(l => l.quality === '480p');

  return (fallback.length ? fallback : links).slice(0, 5);
}

/* ---------- 3. DL page → direct link ---------- */
async function getDlPageDirect(dlUrl, depth = 0) {
  if (depth > 3) return dlUrl;
  const { data } = await axios.get(dlUrl, { headers, timeout: 20000, maxRedirects: 10 });
  const $ = cheerio.load(data);

  let candidates = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/(1080p|720p|480p|\.zip($|\?)|\.mp4($|\?)|\.mkv($|\?)|wp-content.*uploads)/i.test(href)) {
      candidates.push(href.startsWith('http') ? href : new URL(href, dlUrl).href);
    }
  });

  if (!candidates.length) {
    const m = data.match(/https?:\/\/[^"'\s<>]+\.(?:zip|mp4|mkv)[^"'\s<>]*/i);
    if (m) candidates.push(m[0]);
  }

  if (candidates.length) {
    const next = candidates[0];
    if (/\.(zip|mp4|mkv)($|\?)/i.test(next)) return next;
    try { return await getDlPageDirect(next, depth + 1); } catch (_) { return next; }
  }
  return dlUrl;
}

/* ---------- 3b. Direct file URL header check ---------- */
async function checkDirect(url) {
  const res = await axios.get(url, { headers, timeout: 30000, maxRedirects: 10, responseType: 'stream' });
  const finalUrl = res.request?.res?.responseUrl || url;
  const cd = res.headers['content-disposition'] || '';
  const name = cd.match(/filename="?([^";]+)"?/i)?.[1]
    || decodeURIComponent(finalUrl.split('/').pop().split('?')[0])
    || 'movie.mp4';
  const size = Number(res.headers['content-length']) || 0;
  res.destroy();
  return { directUrl: finalUrl, name, size };
}

/* ---------- 3c. Full resolve ---------- */
async function resolveDirect(linkUrl) {
  const direct = await getDlPageDirect(linkUrl);
  try {
    return await checkDirect(direct);
  } catch (_) {
    return { directUrl: direct, name: 'movie.mp4', size: 0 };
  }
}

/* ---------- 3d. Fallback: ASITHA API ---------- */
async function asithaDirectUrl(movieUrl) {
  if (!ASITHA_KEY) return null;
  const { data } = await axios.get(`${ASITHA_BASE}/cinesubz/downloadurl`, {
    params: { apiKey: ASITHA_KEY, url: movieUrl }, timeout: 30000,
  });
  return data?.direct_url || data?.url || data?.link || null;
}

/* ---------- 4. Convert: හැම එකක්ම proper MP4 (H.264/AAC) එකට ---------- */
// Source mp4 (H.264) නම් fast remux — නැත්නම් re-encode
async function convertToMp4(inputPath) {
  const outPath = inputPath.replace(/\.[^.]+$/, '') + '.mp4';

  // Step 1: fast remux (codec copy) — H.264/AAC නම් මේකෙන්ම ඇවිත් ඉවර
  const remuxOk = await new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outPath],
      { timeout: 30 * 60 * 1000 }, (err) => {
        if (err || !fs.existsSync(outPath)) return resolve(false);
        // ffprobe එකෙන් H.264 confirm — H.265/AV1 නම් re-encode ඕනෑ
        execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outPath],
        { timeout: 60 * 1000 }, (perr, stdout) => {
          if (perr) return resolve(fs.statSync(outPath).size > 1024);
          const codec = (stdout || '').trim();
          if (codec === 'h264') resolve(true);
          else { try { fs.unlinkSync(outPath); } catch (_) {} resolve(false); }
        });
      });
  });
  if (remuxOk) return { outPath, reencoded: false };

  // Step 2: full re-encode → proper H.264/AAC mp4 (slow — 720p 1.6GB ~30-60min VPS එකක)
  console.log('🎬 Re-encoding to H.264 mp4...');
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outPath,
    ], { timeout: 4 * 60 * 60 * 1000 }, (err) => {
      if (err || !fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) return reject(new Error('re-encode fail'));
      resolve();
    });
  });
  return { outPath, reencoded: true };
}

/* ---------- 5. Download ---------- */
async function downloadFile(url, filePath, onProgress) {
  const res = await axios.get(url, { headers, responseType: 'stream', timeout: 0 });
  const total = Number(res.headers['content-length']) || 0;
  let done = 0, lastPct = -10;
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    res.data.on('data', (chunk) => {
      done += chunk.length;
      if (total && onProgress) {
        const pct = Math.floor((done / total) * 100);
        if (pct >= lastPct + 10) { lastPct = pct; onProgress(pct); }
      }
    });
    res.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    res.data.on('error', reject);
  });
}

/* ---------- 6. Upload — දැන් mp4 video විතරයි ---------- */
async function uploadMp4(ctx, mp4Path, caption) {
  await ctx.replyWithVideo(
    { source: fs.createReadStream(mp4Path) },
    { caption, supports_streaming: true, parse_mode: 'HTML' }
  );
}

/* ---------- Commands ---------- */
async function cmdCinesubz(ctx) {
  const query = (ctx.message?.text || '').replace(/^\/cinesubz\s*/i, '').trim();
  if (!query) return ctx.reply('🎬 Usage: /cinesubz <movie name>\nඋදා: /cinesubz tarzan');
  const wait = await ctx.reply('🔎 CineSubz search...');
  try {
    const results = await search(query);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    if (!results.length) return ctx.reply(`❌ "${query}" වලට results නෑ.`);
    cacheSet(`r_${ctx.chat.id}`, results);
    const buttons = results.slice(0, 10).map((r, i) => [{ text: r.title.slice(0, 60), callback_data: `csz_${i}` }]);
    await ctx.reply(`🎬 <b>${query}</b> — results:`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error('csz search:', e.message);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    ctx.reply('⚠️ CineSubz connect වෙන්න බැරි වුණා.');
  }
}

async function handleCszCallback(ctx) {
  const raw = ctx.callbackQuery.data; // 'csz_3' / 'cszq_720p_3'

  let action = '', quality = null, idx = null;
  if (raw.startsWith('cszq_')) {
    [, quality, idx] = raw.split('_');
    action = 'q';
  } else {
    idx = raw.replace(/^csz_/, '');
  }
  idx = parseInt(idx, 10);

  const cached = cszCache.get(`r_${ctx.chat.id}`);
  const post = cached?.v?.[idx];
  if (!post) { await ctx.answerCbQuery(); return ctx.reply('⌛ Expired. නැවත /cinesubz search කරන්න.'); }

  /* Step 1: film select → 720p button */
  if (!action) {
    await ctx.answerCbQuery('⏳ 720p link බලනවා...');
    try {
      const links = await getQualityLinks(post.url);
      if (!links.length) return ctx.reply(`❌ Download links හම්බුනේ නෑ.\n${post.url}`);
      cacheSet(`l_${ctx.chat.id}`, { post, links });
      const kb = links.map(l => [{
        text: `🎬 ${l.text.slice(0, 40)}${l.size ? ` • ${l.size}` : ''}`,
        callback_data: `cszq_${l.quality}_${idx}`,
      }]);
      await ctx.editMessageText(`<b>${post.title}</b>\n\n720p download කරන්න:`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
      });
    } catch (e) {
      console.error('csz links:', e.message);
      ctx.reply('⚠️ Details error.\n' + post.url);
    }
    return;
  }

  /* Step 2: 720p select → resolve → download → convert mp4 → upload */
  const cached2 = cszCache.get(`l_${ctx.chat.id}`);
  const link = cached2?.v?.links.find(l => l.quality === quality);
  if (!link) { await ctx.answerCbQuery(); return ctx.reply('⌛ Expired. නැවත /cinesubz search කරන්න.'); }
  await ctx.answerCbQuery();

  const prog = await ctx.reply(`⬇️ <b>${link.text || QUALITY}</b> download... 0%`, { parse_mode: 'HTML' });
  const tmp = path.join(os.tmpdir(), `csz_${Date.now()}_${quality}` + path.extname(link.url.split('?')[0]) || '.mp4');
  try {
    // 1) resolve
    const result = await resolveDirect(link.url);

    // 2) download
    await downloadFile(result.directUrl, tmp, (pct) => {
      ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
        `⬇️ Download: ${pct}%\n🎬 ${post.title}`, { parse_mode: 'HTML' }).catch(() => {});
    });

    // 3) convert → proper mp4
    ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
      '🎬 MP4 එකට convert කරනවා... (mkv නම් ටිකක් යනවා)', { parse_mode: 'HTML' }).catch(() => {});
    const conv = await convertToMp4(tmp);
    console.log(`✅ Convert ${conv.reencoded ? '(re-encoded)' : '(remuxed)'}: ${conv.outPath}`);

    // 4) upload mp4 video (streaming)
    ctx.telegram.editMessageText(prog.chat.id, prog.message_id,
      '⬆️ Telegram එකට upload... (ලොකු file නම් 10-30min)', { parse_mode: 'HTML' }).catch(() => {});
    await uploadMp4(ctx, conv.outPath,
      `🎬 <b>${post.title}</b>\n🎥 <b>${link.text || QUALITY}</b> • MP4`);

    // 5) cleanup
    fs.unlink(tmp, () => {});
    if (conv.outPath !== tmp) fs.unlink(conv.outPath, () => {});
    ctx.telegram.deleteMessage(prog.chat.id, prog.message_id).catch(() => {});
  } catch (e) {
    console.error('csz flow:', e.message);
    fs.unlink(tmp, () => {});
    ctx.reply(`⚠️ Fail: ${e.message}\n\n💡 50MB+ uploads වලට LOCAL BOT API SERVER ඕනෑ.`);
  }
}

module.exports = { cmdCinesubz, handleCszCallback, search, getQualityLinks, resolveDirect };
