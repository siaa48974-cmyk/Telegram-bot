// handlers/baiscope.js — v9.0 (FlareSolverr edition)
// Baiscope Sinhala subtitle handler with Cloudflare bypass
// Node.js >= 18
// Dependencies: axios, cheerio
// Requires: FlareSolverr running (see below for docker command)

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://www.baiscope.lk';

/* ================= FlareSolverr config ================= */
// FLARESOLVERR_URL env var — e.g. http://localhost:8191
// FLARESOLVERR නැත්නම් direct axios fallback කරනවා (පරණ විදිහ)
const FLARESOLVERR = process.env.FLARESOLVERR_URL || '';

let flareSession = null;        // FlareSolverr session id
let flareCookies = null;        // { name, value, domain }[] — cf_clearance etc.
let flareCookieFetchedAt = 0;
const COOKIE_TTL = 8 * 60 * 1000; // cf_clearance ~15min විතරයි; 8 min වලින් refresh

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8',
  Referer: `${BASE}/`,
};

const pending = new Map();
const PENDING_TTL = 10 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 45 * 1024 * 1024;

/* ================= Helpers ================= */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function absoluteUrl(raw, baseUrl) {
  try {
    const url = new URL(String(raw || '').trim(), baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function createId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function remember(id, value) {
  pending.set(id, value);
  const timer = setTimeout(() => pending.delete(id), PENDING_TTL);
  timer.unref?.();
}

function isLikelyDownloadUrl(url) {
  const lower = String(url || '').toLowerCase();
  return (
    lower.includes('dl.baiscope.lk') ||
    lower.includes('/download') ||
    /\.(zip|rar|7z|srt|sub)(\?|$)/.test(lower) ||
    lower.includes('sub')
  );
}

function decodeFilename(disposition, fallbackUrl) {
  if (disposition) {
    const utf8 = /filename\*=(?:UTF-8'')?([^;\r\n]+)/i.exec(disposition);
    if (utf8?.[1]) {
      try { return decodeURIComponent(utf8[1].replace(/"/g, '')); } catch {}
    }
    const plain = /filename="?([^";\r\n]+)"?/i.exec(disposition);
    if (plain?.[1]) return plain[1].trim();
  }
  try {
    const p = new URL(fallbackUrl).pathname;
    return decodeURIComponent(p.split('/').filter(Boolean).pop() || 'subtitle');
  } catch {
    return 'subtitle';
  }
}

function getFileExtension(name, contentType, data) {
  const fromName = path.extname(String(name || '')).toLowerCase();
  if (['.zip', '.rar', '.7z', '.srt', '.sub', '.ass'].includes(fromName)) return fromName;

  const type = String(contentType || '').toLowerCase();
  if (type.includes('zip')) return '.zip';
  if (type.includes('rar')) return '.rar';
  if (type.includes('x-subrip') || type.includes('srt')) return '.srt';
  if (type.includes('plain') && data.length > 0) {
    // SRT files: first bytes contain " --> " pattern usually
    const head = data.slice(0, 2000).toString('utf8');
    if (head.includes('-->')) return '.srt';
    return '.srt';
  }
  // magic bytes
  if (data.length > 4) {
    if (data[0] === 0x50 && data[1] === 0x4b) return '.zip';
    if (data[0] === 0x52 && data[1] === 0x61 && data[2] === 0x72) return '.rar';
  }
  return '.zip';
}

/* ================= FlareSolverr layer ================= */

async function flareRequest(url, { method = 'request.get', postData = null, returnRaw = false } = {}) {
  if (!FLARESOLVERR) throw new Error('FLARESOLVERR_URL not configured');

  // Reuse session; create if missing
  if (!flareSession) {
    const res = await axios.post(`${FLARESOLVERR}/v1`, {
      cmd: 'sessions.create',
    }, { timeout: 60000 });
    flareSession = res.data?.session || null;
    console.log('[flare] session created:', flareSession);
  }

  const body = {
    cmd: method,
    url,
    maxTimeout: 60000,
    session: flareSession || undefined,
  };
  if (postData) {
    body.cmd = 'request.post';
    body.postData = postData;
  }

  const res = await axios.post(`${FLARESOLVERR}/v1`, body, { timeout: 90000 });

  const sol = res.data?.solution;
  if (!sol) throw new Error(`FLARE_ERROR: ${res.data?.message || 'no solution'}`);

  // Refresh cookie cache
  if (Array.isArray(sol.cookies) && sol.cookies.length) {
    flareCookies = sol.cookies;
    flareCookieFetchedAt = Date.now();
  }

  if (returnRaw) return sol; // full solution (headers, cookies, etc.)
  return sol.response?.data ?? sol.response ?? '';
}

function flareCookieHeader(targetUrl) {
  if (!flareCookies || Date.now() - flareCookieFetchedAt > COOKIE_TTL) return null;
  try {
    const host = new URL(targetUrl).hostname;
    const parts = flareCookies
      .filter(c => host.endsWith(String(c.domain || '').replace(/^\./, '')))
      .map(c => `${c.name}=${c.value}`);
    return parts.length ? parts.join('; ') : null;
  } catch {
    return null;
  }
}

/* ================= HTTP fetchers ================= */

// HTML page එකක් ගන්නවා — FlareSolverr තියෙනවා නම් ඒකෙන්, නැත්නම් direct
async function fetchPage(url) {
  if (FLARESOLVERR) {
    try {
      return await flareRequest(url);
    } catch (e) {
      console.error('[baiscope] flare failed, trying direct:', e.message);
    }
  }
  const { data } = await axios.get(url, {
    headers: HEADERS,
    timeout: 30000,
    responseType: 'text',
    validateStatus: s => s < 500,
  });
  if (typeof data === 'string' && /Just a moment\.\.\.|cf-challenge|Checking your browser/i.test(data)) {
    throw new Error('SITE_BLOCKED_403');
  }
  if (data && data.status === 403) throw new Error('SITE_BLOCKED_403');
  if (data && data.status === 429) throw new Error('SITE_BLOCKED_429');
  if (data && data.status === 503) throw new Error('SITE_BLOCKED_503');
  return data;
}

// Binary/file download — FlareSolverr binary pass කරන්නේ නෑ,
// නමුත් එයා දෙන cookies (cf_clearance) + UA එක direct axios එකට දාලා download කරන්න පුළුවන්
async function fetchSubtitle(url, referer, depth = 0, seen = new Set()) {
  if (depth > 3) throw new Error('INTERMEDIATE_PAGE');
  if (seen.has(url)) throw new Error('INTERMEDIATE_PAGE');
  seen.add(url);

  const headers = { ...HEADERS, Referer: referer || `${BASE}/` };
  const cookie = flareCookieHeader(url);
  if (cookie) headers.Cookie = cookie;

  // FlareSolverr session UA එක use කරන්න — cookie UA match වෙන්න ඕනි (cf_clearance is UA-bound!)
  if (FLARESOLVERR && flareLastUserAgent) {
    headers['User-Agent'] = flareLastUserAgent;
  }

  const response = await axios.get(url, {
    headers,
    timeout: 120000,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  const status = response.status;
  if (status === 403 || status === 429 || status === 503) {
    throw new Error(`SITE_BLOCKED_${status}`);
  }
  if (status >= 400) throw new Error(`HTTP_${status}`);

  const contentType = String(response.headers['content-type'] || '');
  let data = Buffer.from(response.data);

  // HTML ආවොත් — intermediate page (ad page / redirect page) එකක්
  if (contentType.includes('text/html')) {
    const html = data.toString('utf8');
    if (/Just a moment\.\.\.|cf-challenge/i.test(html)) throw new Error('SITE_BLOCKED_403');

    const $ = cheerio.load(html);
    // meta refresh / JS redirect හොයනවා
    let next = null;
    const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
    if (metaRefresh) {
      const m = /url=(.+)/i.exec(metaRefresh);
      if (m) next = absoluteUrl(m[1], url);
    }
    if (!next) {
      $('a').each((_, el) => {
        if (next) return;
        const href = $(el).attr('href') || '';
        const text = ($(el).text() || '').toLowerCase();
        if ((isLikelyDownloadUrl(href) || text.includes('download')) && href.startsWith('http')) {
          next = absoluteUrl(href, url);
        }
      });
    }
    if (!next) throw new Error('INTERMEDIATE_PAGE');
    return fetchSubtitle(next, url, depth + 1, seen);
  }

  if (data.length > MAX_DOWNLOAD_BYTES) throw new Error('FILE_TOO_LARGE');
  if (data.length < 100) throw new Error('EMPTY_FILE');

  const originalName = decodeFilename(response.headers['content-disposition'], url);
  const extension = getFileExtension(originalName, contentType, data);
  const safeName = `subtitle${extension}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-'));
  const filePath = path.join(dir, safeName);

  try {
    fs.writeFileSync(filePath, data);
    return { filePath, dir, filename: safeName, size: data.length };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// FlareSolverr UA එක store කරන්න (cf_clearance UA-bound නිසා)
let flareLastUserAgent = null;
const _origFlareRequest = flareRequest;
flareRequest = async function (url, opts) {
  const sol = await _origFlareRequest(url, opts);
  if (sol?.userAgent) flareLastUserAgent = sol.userAgent;
  return sol;
};

async function downloadSubtitle(url, referer) {
  return fetchSubtitle(url, referer, 0, new Set());
}

/* ================= Scraping ================= */

async function searchBaiscope(query) {
  const searchUrl = `${BASE}/?s=${encodeURIComponent(query)}`;
  const html = await fetchPage(searchUrl);
  const $ = cheerio.load(html);
  const results = [];

  // WordPress search results — article/h2/a pattern
  $('article, .post, .item').each((_, el) => {
    const linkEl = $(el).find('a[href]').first();
    const href = linkEl.attr('href');
    const title =
      $(el).find('h2, .entry-title, .post-title').first().text().trim() ||
      linkEl.text().trim();
    if (href && title && absoluteUrl(href, BASE)) {
      results.push({ title, url: absoluteUrl(href, BASE) });
    }
  });

  // Fallback: plain h2 > a links
  if (!results.length) {
    $('h2 a, h3 a, .entry-title a').each((_, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (href && title && !href.includes('#')) {
        results.push({ title, url: absoluteUrl(href, BASE) });
      }
    });
  }

  // Dedupe + limit
  const seen = new Set();
  return results
    .filter(r => {
      if (seen.has(r.url) || !r.url.includes('baiscope')) return false;
      seen.add(r.url);
      return true;
    })
    .slice(0, 10);
}

async function getSubtitleLink(pageUrl) {
  const html = await fetchPage(pageUrl);
  const $ = cheerio.load(html);

  const title =
    $('h1.entry-title, h1.post-title, h1').first().text().trim() || 'Subtitle';
  const poster = absoluteUrl(
    $('img.wp-post-image, .post-thumb img, article img').first().attr('src'),
    pageUrl
  );

  const links = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = ($(el).text() || '').toLowerCase();
    const abs = absoluteUrl(href, pageUrl);
    if (!abs || seen.has(abs)) return;

    if (isLikelyDownloadUrl(abs) || text.includes('download') || text.includes('බාගන්න')) {
      seen.add(abs);
      links.push({ label: $(el).text().trim() || 'Download Subtitle', url: abs });
    }
  });

  return { title, poster, links };
}

/* ================= Telegram handlers ================= */

function browserFallback(url, error) {
  let reason = 'Download එක ස්වයංක්‍රීයව ලබාගන්න බැරි වුණා.';

  if (/SITE_BLOCKED_(403|429|503)/.test(error.message)) {
    reason = 'Baiscope server එක bot request එක block/rate-limit කළා.';
  } else if (error.message === 'INTERMEDIATE_PAGE') {
    reason = 'Download link එක අතරමැදි browser page එකක් හරහා යනවා.';
  } else if (error.message === 'FILE_TOO_LARGE') {
    reason = 'File එක Telegram upload limit එකට වඩා විශාලයි.';
  } else if (error.message.startsWith('FLARE_ERROR')) {
    reason = 'Cloudflare bypass (FlareSolverr) fail වුණා.';
  }

  return `${reason}\n\n📥 Browser එකෙන් උත්සාහ කරන්න:\n${url}`;
}

async function cmdSub(ctx) {
  const query = (ctx.message?.text || '').replace(/^\/sub\s*/i, '').trim();

  if (!query) {
    return ctx.reply('🎬 Usage: /sub <movie name>\nඋදා: /sub interstellar');
  }

  const status = await ctx.reply(`🔍 බයිස්කෝප් එකේ "${esc(query)}" search කරනවා...`);

  try {
    const results = await searchBaiscope(query);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

    if (!results.length) {
      return ctx.reply('❌ Results නැහැ. වෙන movie name එකක් try කරන්න.');
    }

    const id = createId();
    remember(id, results);

    const keyboard = {
      inline_keyboard: results.map((result, index) => [{
        text: result.title.slice(0, 60),
        callback_data: `bsc_${id}_${index}`,
      }]),
    };

    return ctx.reply('👇 Movie/Series එකක් තෝරන්න:', { reply_markup: keyboard });
  } catch (error) {
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    console.error('[baiscope] search failed:', error.message);
    return ctx.reply('❌ Search එක අසාර්ථකයි. ටිකකින් නැවත උත්සාහ කරන්න.');
  }
}

async function handleSubCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  await ctx.answerCbQuery().catch(() => {});

  try {
    if (data.startsWith('bscd_')) {
      const [, id, indexText] = data.split('_');
      const cached = pending.get(id);

      if (!cached) {
        return ctx.reply('⌛ Link එක expire වෙලා. නැවත /sub කරන්න.');
      }

      const link = cached.links?.[Number(indexText)];
      if (!link) return ctx.reply('❌ Download link එක හමු වුණේ නැහැ.');

      const status = await ctx.reply('⏳ Subtitle download කරනවා...');
      let downloaded;

      try {
        downloaded = await downloadSubtitle(link.url, cached.pageUrl);

        await ctx.replyWithDocument(
          { source: fs.createReadStream(downloaded.filePath), filename: downloaded.filename },
          { caption: `✅ ${esc(cached.title)}\n📝 Sinhala Subtitle` }
        );
      } catch (error) {
        console.error('[baiscope] download/upload failed:', error.message);
        await ctx.reply(browserFallback(link.url, error));
      } finally {
        if (downloaded?.dir) {
          fs.rmSync(downloaded.dir, { recursive: true, force: true });
        }
        await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      }

      return;
    }

    if (data.startsWith('bsc_')) {
      const [, id, indexText] = data.split('_');
      const results = pending.get(id);

      if (!results) {
        return ctx.reply('⌛ Search result expire වෙලා. නැවත /sub කරන්න.');
      }

      const picked = results[Number(indexText)];
      if (!picked) return ctx.reply('❌ Result එක හමු වුණේ නැහැ.');

      const status = await ctx.reply('🔍 Subtitle link එක හොයනවා...');

      try {
        const info = await getSubtitleLink(picked.url);
        await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

        const caption =
          `🎬 <b>${esc(info.title)}</b>\n📝 සිංහල උපසිරැසි\n🔗 ${esc(picked.url)}`;

        try {
          if (info.poster) {
            await ctx.replyWithPhoto(info.poster, { caption, parse_mode: 'HTML' });
          } else {
            await ctx.reply(caption, { parse_mode: 'HTML' });
          }
        } catch {
          await ctx.reply(caption, { parse_mode: 'HTML' });
        }

        if (!info.links.length) {
          return ctx.reply(
            `❌ Subtitle download link එක auto-detect කරන්න බැහැ.\n\n📥 Browser එකෙන් බලන්න:\n${picked.url}`
          );
        }

        const linkId = createId();
        remember(linkId, { ...info, pageUrl: picked.url });

        const keyboard = {
          inline_keyboard: info.links.slice(0, 5).map((item, index) => [{
            text: (item.label || 'Download Subtitle').slice(0, 40),
            callback_data: `bscd_${linkId}_${index}`,
          }]),
        };

        return ctx.reply(`📥 ${info.links.length} download link(s) හමු වුණා — එකක් තෝරන්න:`, {
          reply_markup: keyboard,
        });
      } catch (error) {
        await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
        console.error('[baiscope] link scrape failed:', error.message);
        return ctx.reply(`❌ Subtitle details ලබාගන්න බැරි වුණා.\n${picked.url}`);
      }
    }
  } catch (error) {
    console.error('[baiscope] callback crashed:', error);
    try {
      return await ctx.reply('⚠️ මේ ක්‍රියාව සම්පූර්ණ කරන්න බැරි වුණා. නැවත උත්සාහ කරන්න.');
    } catch {}
  }
}

module.exports = { cmdSub, handleSubCallback };
