
 // handlers/baiscope.js
// Baiscope Sinhala subtitle handler
// Node.js >= 18
// Dependencies: axios, cheerio

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://www.baiscope.lk';
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
  return `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
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
    /\.(zip|rar|7z|srt|ass|ssa|sub)(?:[?#]|$)/i.test(lower)
  );
}

async function searchBaiscope(query) {
  const { data: html } = await axios.get(
    `${BASE}/?s=${encodeURIComponent(query)}`,
    {
      headers: HEADERS,
      timeout: 25000,
      maxRedirects: 5,
    }
  );

  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('a[href*="/movies/"], a[href*="/tv/"]').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'), BASE);
    const title = (
      $(el).attr('title') ||
      $(el).text() ||
      ''
    ).replace(/\s+/g, ' ').trim();

    if (!href || !title || title.length < 3 || seen.has(href)) return;

    seen.add(href);
    results.push({ title, url: href });
  });

  return results.slice(0, 10);
}

async function getSubtitleLink(pageUrl) {
  const { data: html } = await axios.get(pageUrl, {
    headers: { ...HEADERS, Referer: `${BASE}/` },
    timeout: 25000,
    maxRedirects: 5,
  });

  const $ = cheerio.load(html);
  const title = (
    $('h1').first().text() ||
    $('title').text() ||
    'Subtitle'
  ).replace(/\s+/g, ' ').trim();

  const poster = absoluteUrl(
    $('meta[property="og:image"]').attr('content'),
    pageUrl
  );

  const links = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') || '';
    const url = absoluteUrl(raw, pageUrl);

    if (!url || !isLikelyDownloadUrl(url) || seen.has(url)) return;

    const lower = url.toLowerCase();
    if (/facebook|twitter|instagram|youtube|whatsapp|mailto:|\/category\//i.test(lower)) {
      return;
    }

    seen.add(url);

    const label = (
      $(el).text() ||
      $(el).attr('title') ||
      'Download Subtitle'
    ).replace(/\s+/g, ' ').trim();

    links.push({
      url,
      label: label.slice(0, 50) || 'Download Subtitle',
    });
  });

  for (const url of extractRealLinks(html, pageUrl)) {
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ url, label: 'Download Subtitle' });
    }
  }

  links.sort((a, b) => {
    const score = (url) => {
      const u = url.toLowerCase();
      if (/\.(zip|rar|7z|srt|ass|ssa|sub)(?:[?#]|$)/i.test(u)) return 0;
      if (u.includes('dl.baiscope.lk')) return 1;
      if (u.includes('/download')) return 2;
      return 3;
    };
    return score(a.url) - score(b.url);
  });

  return { title, poster, links: links.slice(0, 10) };
}

function extractRealLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const found = new Set();

  function add(raw) {
    const url = absoluteUrl(raw, pageUrl);
    if (url && isLikelyDownloadUrl(url)) found.add(url);
  }

  $('a[href], form[action]').each((_, el) => {
    add($(el).attr('href') || $(el).attr('action'));
  });

  $('meta[http-equiv="refresh"]').each((_, el) => {
    const content = $(el).attr('content') || '';
    const match = content.match(/url\s*=\s*['"]?([^'";]+)/i);
    if (match) add(match[1].trim());
  });

  const patterns = [
    /(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/gi,
    /location\.replace\(\s*['"]([^'"]+)['"]\s*\)/gi,
    /(?:window\.)?open\(\s*['"]([^'"]+)['"]/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) add(match[1]);
  }

  $('[data-href], [data-url]').each((_, el) => {
    add($(el).attr('data-href') || $(el).attr('data-url'));
  });

  return [...found];
}

function getFileExtension(filename, contentType, buffer) {
  const ext = path.extname(filename || '').toLowerCase();

  if (/^\.(zip|rar|7z|srt|ass|ssa|sub|gz|txt)$/i.test(ext)) return ext;

  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('zip')) return '.zip';
  if (ct.includes('rar')) return '.rar';
  if (ct.includes('7z')) return '.7z';
  if (ct.includes('subrip') || ct.includes('x-subrip')) return '.srt';
  if (ct.includes('text/plain')) return '.srt';

  if (buffer && buffer.length >= 4) {
    if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return '.zip';
    if (buffer.subarray(0, 4).toString('ascii') === 'Rar!') return '.rar';
    if (buffer.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '.7z';
  }

  return '.zip';
}

function decodeFilename(contentDisposition, url) {
  const cd = String(contentDisposition || '');
  let match = cd.match(/filename\*=UTF-8''([^;]+)/i);

  if (match) {
    try {
      return decodeURIComponent(match[1].replace(/"/g, '').trim());
    } catch {}
  }

  match = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (match) return match[1].trim();

  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'subtitle');
  } catch {
    return 'subtitle';
  }
}

async function fetchSubtitle(url, referer, depth = 0, visited = new Set()) {
  if (depth > 3) throw new Error('TOO_MANY_REDIRECT_PAGES');
  if (visited.has(url)) throw new Error('REDIRECT_LOOP');
  visited.add(url);

  let response;

  try {
    response = await axios.get(url, {
      headers: { ...HEADERS, Referer: referer || `${BASE}/` },
      responseType: 'arraybuffer',
      timeout: 60000,
      maxRedirects: 8,
      maxContentLength: MAX_DOWNLOAD_BYTES,
      maxBodyLength: MAX_DOWNLOAD_BYTES,
      validateStatus: () => true,
    });
  } catch (error) {
    if (
      error.code === 'ERR_BAD_RESPONSE' ||
      error.message?.toLowerCase().includes('maxcontentlength')
    ) {
      throw new Error('FILE_TOO_LARGE');
    }
    throw new Error(`REQUEST_FAILED: ${error.code || error.message}`);
  }

  const status = response.status;
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const data = Buffer.from(response.data || []);

  if ([403, 429, 503].includes(status)) {
    throw new Error(`SITE_BLOCKED_${status}`);
  }

  if (status < 200 || status >= 300) throw new Error(`HTTP_${status}`);
  if (!data.length) throw new Error('EMPTY_FILE');
  if (data.length > MAX_DOWNLOAD_BYTES) throw new Error('FILE_TOO_LARGE');

  const start = data.subarray(0, 1000).toString('utf8').trimStart().toLowerCase();

  const looksLikeHtml =
    contentType.includes('text/html') ||
    start.startsWith('<!doctype html') ||
    start.startsWith('<html') ||
    start.startsWith('<head') ||
    start.startsWith('<body');

  if (looksLikeHtml) {
    if (depth >= 3) throw new Error('INTERMEDIATE_PAGE');

    const candidates = extractRealLinks(data.toString('utf8'), url)
      .filter((candidate) => !visited.has(candidate));

    if (!candidates.length) throw new Error('INTERMEDIATE_PAGE');

    let lastError;

    for (const candidate of candidates.slice(0, 4)) {
      try {
        return await fetchSubtitle(
          candidate,
          url,
          depth + 1,
          new Set(visited)
        );
      } catch (error) {
        lastError = error;
        console.log('[baiscope] candidate failed:', error.message);
      }
    }

    throw lastError || new Error('INTERMEDIATE_PAGE');
  }

  const originalName = decodeFilename(
    response.headers['content-disposition'],
    url
  );

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

async function downloadSubtitle(url, referer) {
  return fetchSubtitle(url, referer, 0, new Set());
}

function browserFallback(url, error) {
  let reason = 'Download එක ස්වයංක්‍රීයව ලබාගන්න බැරි වුණා.';

  if (/SITE_BLOCKED_(403|429|503)/.test(error.message)) {
    reason = 'Baiscope server එක bot request එක block/rate-limit කළා.';
  } else if (error.message === 'INTERMEDIATE_PAGE') {
    reason = 'Download link එක අතරමැදි browser page එකක් හරහා යනවා.';
  } else if (error.message === 'FILE_TOO_LARGE') {
    reason = 'File එක Telegram upload limit එකට වඩා විශාලයි.';
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

    return ctx.reply('👇 Movie/Series එකක් තෝරන්න:', {
      reply_markup: keyboard,
    });
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
          {
            source: fs.createReadStream(downloaded.filePath),
            filename: downloaded.filename,
          },
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
          `🎬 <b>${esc(info.title)}</b>\n` +
          `📝 සිංහල උපසිරැසි\n` +
          `🔗 ${esc(picked.url)}`;

        try {
          if (info.poster) {
            await ctx.replyWithPhoto(info.poster, {
              caption,
              parse_mode: 'HTML',
            });
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

        return ctx.reply(
          `📥 ${info.links.length} download link(s) හමු වුණා — එකක් තෝරන්න:`,
          { reply_markup: keyboard }
        );
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
