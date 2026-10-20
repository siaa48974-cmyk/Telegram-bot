// handlers/sinhalasub.js — sinhalasub.lk scraper → Telegram direct upload
// Quality: 480p / 1080p | Servers: Pixeldrain, DLServer-01/02, FilesPayout, Telagram
// + 🔗 Direct Download URL option (3-step gateway unlock via Puppeteer, npm fallback)
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer');
let getDownload = null;
try { ({ getDownload } = require('sinhalasub.lk')); } catch (_) { /* optional */ }

const BASE = 'https://sinhalasub.lk';
const QUALITIES = ['SD 480p', 'FHD 1080p']; // 720p ඉවත් — 480p priority
const CB_PREFIX = 'ss_';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8',
  Referer: BASE + '/',
};

const DIRECT_HOST_RE = /pixeldrain|files-payout|filepayout|ddl\.sinhalasub|sinhalasub\.net|dlserver|t\.me|telegram|\.(mp4|mkv|zip|rar)(\?|$)/i;
const DIRECT_HOST_RE_SOURCE = DIRECT_HOST_RE.source;

const cache = new Map();
const cacheSet = (k, v, ttl = 30 * 60 * 1000) => {
  cache.set(k, { v, time: Date.now() });
  setTimeout(() => cache.delete(k), ttl).unref?.();
};

/* ================= 1. Search ================= */
async function search(query) {
  const { data } = await axios.get(`${BASE}/?s=${encodeURIComponent(query)}`, { headers, timeout: 20000 });
  const $ = cheerio.load(data);
  const results = [], seen = new Set();

  $('a[href*="sinhalasub.lk"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = ($(el).find('h2, h3, .entry-title').first().text()
      || $(el).attr('title') || '').trim();
    const match = href.match(/https:\/\/sinhalasub\.lk\/(movies|tv)\/[^/]+\/?/);
    if (match && title && !seen.has(match[0])) {
      seen.add(match[0]);
      results.push({ title, url: match[0] });
    }
  });
  return results.slice(0, 10);
}

/* ================= 2. Details page → quality links ================= */
async function getQualityLinks(postUrl) {
  const { data } = await axios.get(postUrl, { headers, timeout: 20000 });
  const $ = cheerio.load(data);
  const links = [];
  $('a[href*="/links/"]').each((_, el) => {
    const url = $(el).attr('href');
    if (!url) return;
    const row = $(el).closest('tr');
    const quality = (row.find('td').eq(1).text().trim() || $(el).text().trim());
    const size = row.find('td').eq(2).text().trim();
    const q = quality.match(/(FHD\s*1080p|HD\s*720p|SD\s*480p)/i);
    if (!q) return;
    const norm = q[1].replace(/\s+/g, ' ').trim();
    if (!links.some(l => l.url === url)) {
      links.push({ quality: norm, size, url: url.startsWith('http') ? url : BASE + url });
    }
  });
  return links;
}

/* ================= 3. Gateway → direct URL (3-step unlock + fallback) ================= */
function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function resolveDirectViaBrowser(gatewayUrl) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(headers['User-Agent']);

    let captured = null;
    page.on('request', (req) => {
      const u = req.url();
      if (!captured && DIRECT_HOST_RE.test(u)) captured = u;
    });
    page.on('response', (res) => {
      const u = res.url();
      if (!captured && DIRECT_HOST_RE.test(u) && res.status() < 400) captured = u;
    });
    browser.on('targetcreated', (t) => {
      const u = t.url();
      if (!captured && DIRECT_HOST_RE.test(u)) captured = u;
    });

    await page.goto(gatewayUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    for (let step = 1; step <= 3; step++) {
      if (captured) break;
      try {
        await page.evaluate((n, reSrc) => {
          const re = new RegExp(reSrc, 'i');
          const els = [...document.querySelectorAll('a, button, div, span, [role="button"]')];
          const target = els.find(e => new RegExp(`step\\s*${n}`, 'i').test(e.textContent || '')
            && !new RegExp(`step\\s*${n + 1}`, 'i').test(e.textContent || ''));
          if (target) { target.click(); return; }
          const el = [...document.querySelectorAll('a, button')]
            .find(e => /download|continue|unlock|proceed/i.test(e.textContent || ''));
          if (el) el.click();
        }, step, DIRECT_HOST_RE_SOURCE);
        await new Promise(r => setTimeout(r, 8000));
      } catch (_) {}
    }

    if (!captured) {
      try {
        const href = await page.evaluate((reSrc) => {
          const re = new RegExp(reSrc, 'i');
          const a = [...document.querySelectorAll('a[href]')].find(e => re.test(e.href));
          return a ? a.href : null;
        }, DIRECT_HOST_RE_SOURCE);
        if (href) captured = href;
      } catch (_) {}
    }
    if (!captured && DIRECT_HOST_RE.test(page.url())) captured = page.url();
    if (!captured) throw new Error('3-step flow එකෙන් direct link හම්බුනේ නෑ');
    return { directUrl: captured, size: null };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function resolveDirect(gatewayUrl) {
  // fast path: npm package (static links)
  if (getDownload) {
    try {
      const res = await getDownload(gatewayUrl);
      const directUrl = res?.result || res?.link || (typeof res === 'string' ? res : null);
      if (directUrl && /^https?:\/\//.test(directUrl)) return { directUrl, size: null };
    } catch (_) { /* fallback */ }
  }
  // puppeteer 3-step flow
  return resolveDirectViaBrowser(gatewayUrl);
}

/* ================= 4. Download with progress ================= */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    axios.get(url, { headers, responseType: 'stream', timeout: 60000, maxContentLength: Infinity })
      .then(res => {
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let done = 0, lastPct = -1;
        const ws = fs.createWriteStream(dest);
        res.data.on('data', (chunk) => {
          done += chunk.length;
          if (total) {
            const pct = Math.floor(done / total * 100);
            if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; onProgress && onProgress(pct); }
          }
        });
        res.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        res.data.on('error', reject);
      })
      .catch(reject);
  });
}

/* ================= 5. Convert → proper mp4 (ffmpeg) ================= */
function convertToMp4(input) {
  return new Promise((resolve) => {
    const out = input.replace(/\.mp4$/, '_fixed.mp4');
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', input],
    (err, stdout) => {
      const codec = err ? null : (stdout || '').trim();
      if (codec === 'h264') {
        execFile('ffmpeg', ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', out],
          (e2) => resolve({ outPath: e2 ? input : out, reencoded: false }));
      } else {
        execFile('ffmpeg', ['-y', '-i', input,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out],
          { maxBuffer: 10 * 1024 * 1024 }, (e3) => resolve({ outPath: e3 ? input : out, reencoded: true }));
      }
    });
  });
}

/* ================= 6. Upload mp4 ================= */
async function uploadMp4(ctx, mp4Path, caption) {
  await ctx.replyWithVideo(
    { source: fs.createReadStream(mp4Path) },
    { caption, supports_streaming: true, parse_mode: 'HTML' }
  );
}

/* ================= Commands ================= */
async function cmdSinhalasub(ctx) {
  const query = (ctx.message?.text || '').replace(/^\/ss\s*/i, '').trim();
  if (!query) return ctx.reply('🎬 Usage: /ss <movie name>\nඋදා: /ss hope');
  const wait = await ctx.reply('🔎 SinhalaSub search...');
  try {
    const results = await search(query);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    if (!results.length) return ctx.reply(`❌ "${query}" වලට results නෑ.`);
    cacheSet(`ss_r_${ctx.chat.id}`, results);
    const buttons = results.map((r, i) => [{ text: r.title.slice(0, 60), callback_data: `ss_${i}` }]);
    await ctx.reply(`🎬 <b>${query}</b> — results:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error('ss search:', e.message);
    ctx.telegram.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    ctx.reply('⚠️ SinhalaSub connect වෙන්න බැරි වුණා.');
  }
}

async function handleSsCallback(ctx) {
  const raw = ctx.callbackQuery?.data || '';
  let quality = null, idx;
  if (raw.startsWith('ssq_')) { [, quality, idx] = raw.split('_'); }
  else { idx = raw.replace(/^ss_/, ''); }
  idx = parseInt(idx, 10);
  if (isNaN(idx)) { await ctx.answerCbQuery(); return; }

  const cached = cache.get(`ss_r_${ctx.chat.id}`);
  const post = cached?.v?.[idx];
  if (!post) { await ctx.answerCbQuery(); return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.'); }

  /* ---- Step 1: film select → 480p / 1080p / Direct URL buttons ---- */
  if (!quality) {
    await ctx.answerCbQuery('⏳ Links බලනවා...');
    try {
      const links = await getQualityLinks(post.url);
      if (!links.length) return ctx.reply(`❌ Download links හම්බුනේ නෑ.\n${post.url}`);
      cacheSet(`ss_l_${ctx.chat.id}`, { post, links });

      const kb = QUALITIES.map(q => {
        const l = links.find(x => x.quality === q);
        return [{ text: l ? `🎬 ${q}${l.size ? ' • ' + l.size : ''}` : `${q} ❌`,
                  callback_data: l ? `ssq_${q.split(' ')[1]}_${idx}` : 'ss_none' }];
      });
      kb.push([{ text: '🔗 Direct Download URL', callback_data: `ssq_direct_${idx}` }]);
      await ctx.editMessageText(`<b>${post.title}</b>\n\nQuality select කරන්න:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      console.error('ss links:', e.message);
      ctx.reply('⚠️ Details error.\n' + post.url);
    }
    return;
  }

  const cached2 = cache.get(`ss_l_${ctx.chat.id}`);
  const { links } = cached2?.v || {};

  /* ---- Step 2a: Direct URL option ---- */
  if (quality === 'direct') {
    await ctx.answerCbQuery('⏳ Direct URL resolve...');
    const allLinks = links || [];
    if (!allLinks.length) return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.');
    const msg = await ctx.reply('🔗 <b>Direct Download URLs</b> resolve කරනවා...', { parse_mode: 'HTML' });
    let out = `🔗 <b>${post.title}</b> — Direct Download URLs\n\n`;
    let any = false;
    for (const l of allLinks) {
      try {
        const r = await resolveDirect(l.url);
        any = true;
        out += `🎥 <b>${l.quality}${l.size ? ' • ' + l.size : ''}</b>\n⬇️ <code>${r.directUrl}</code>\n\n`;
      } catch (e) {
        console.error(`❌ resolve fail [${l.quality}] ${l.url}: ${e.message}`);
      }
    }
    ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    if (!any) return ctx.reply('⚠️ Direct URL resolve කරන්න බැරි වුණා. ටිකකින් ආයේ try කරන්න.');
    return ctx.reply(out, { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  /* ---- Step 2b: quality select → resolve → download → convert → upload ---- */
  const qKey = quality === '1080' || quality === '1080p' ? 'FHD 1080p'
             : quality === '480'  || quality === '480p'  ? 'SD 480p'
             : null;
  const chosen = (links || []).filter(l => l.quality === qKey);
  if (!qKey || !chosen.length) { await ctx.answerCbQuery(); return ctx.reply('⌛ Expired. නැවත /ss search කරන්න.'); }
  await ctx.answerCbQuery(`⏳ ${qKey} resolve...`);

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
      '🎬 MP4 එකට convert කරනවා... (mkv නම් ටිකක් යනවා)',
      { parse_mode: 'HTML' }).catch(() => {});
    const conv = await convertToMp4(tmp);
    console.log(`✅ Convert ${conv.reencoded ? '(re-encoded)' : '(remuxed)'}: ${conv.outPath}`);

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
    ctx.reply(`⚠️ Fail: ${e.message}\n\n💡 50MB+ uploads වලට LOCAL BOT API SERVER ඕනෑ.`);
  }
}

module.exports = { cmdSinhalasub, handleSsCallback, search, getQualityLinks, resolveDirect };
