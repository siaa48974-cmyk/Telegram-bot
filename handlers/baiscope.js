// handlers/baiscope.js — බයිස්කෝප් සිංහලෙන් subtitle scraper (v2.3)
// Flow: /sub <name> → search → select → OMDb poster+details → auto subtitle upload
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://www.baiscope.lk';
const OMDB_KEY = process.env.OMDB_API_KEY || '';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,si;q=0.8',
  'Referer': BASE + '/'
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Search ----------
async function searchBaiscope(query) {
  const { data: html } = await axios.get(`${BASE}/?s=${encodeURIComponent(query)}`, {
    headers: HEADERS, timeout: 20000
  });
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('a[href*="/movies/"], a[href*="/tv/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = ($(el).attr('title') || $(el).text() || '').trim();
    if (!text || text.length < 5) return;
    if (seen.has(href)) return;
    seen.add(href);
    results.push({ title: text, url: href.startsWith('http') ? href : BASE + href });
  });

  return results.slice(0, 10);
}

// ---------- OMDb details ----------
function parseTitleYear(rawTitle) {
  const m = rawTitle.match(/^(.*?)\s*\((\d{4})\)/);
  if (m) return { name: m[1].trim(), year: m[2] };
  const name = rawTitle.replace(/Sinhala Subtitles?.*$/i, '')
                       .replace(/\|.*$/, '')
                       .replace(/\[.*?\]/g, '')
                       .trim();
  return { name, year: null };
}

async function getOmdbInfo(rawTitle) {
  if (!OMDB_KEY) return null;
  try {
    const { name, year } = parseTitleYear(rawTitle);
    if (!name) return null;

    let url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(name)}&plot=short`;
    if (year) url += `&y=${year}`;
    let { data } = await axios.get(url, { timeout: 15000 });

    if (data.Response === 'False') {
      url = `https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(name)}&plot=short&type=series`;
      ({ data } = await axios.get(url, { timeout: 15000 }));
    }

    if (data.Response !== 'True') return null;
    return data;
  } catch (e) {
    console.log('[baiscope] omdb failed:', e.message);
    return null;
  }
}

function omdbCaption(info, pageUrl) {
  const lines = [
    `🎬 <b>${esc(info.Title)}</b> (${esc(info.Year)})`,
  ];
  if (info.Rated && info.Rated !== 'N/A') lines.push(`🔖 ${esc(info.Rated)}`);
  if (info.Genre && info.Genre !== 'N/A') lines.push(`🎭 ${esc(info.Genre)}`);
  if (info.imdbRating && info.imdbRating !== 'N/A') lines.push(`⭐ IMDb: ${esc(info.imdbRating)}/10`);
  if (info.Runtime && info.Runtime !== 'N/A') lines.push(`⏱ ${esc(info.Runtime)}`);
  if (info.Director && info.Director !== 'N/A') lines.push(`🎥 Director: ${esc(info.Director)}`);
  lines.push('');
  lines.push(`📝 සිංහල උපසිරැසි — බයිස්කෝප්`);
  lines.push(`🔗 ${esc(pageUrl)}`);
  return lines.join('\n');
}

// ---------- Subtitle link extraction ----------
async function getSubtitleLink(pageUrl) {
  const { data: html } = await axios.get(pageUrl, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);

  const title = ($('h1').first().text() || 'Subtitle').trim();
  const poster = $('meta[property="og:image"]').attr('content') || null;

  const links = [];
  const seen = new Set();

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const lower = href.toLowerCase();

    const isReal =
      lower.includes('dl.baiscope.lk') ||
      lower.includes('/download') ||
      /\.(zip|rar|7z|srt)(\?|$)/.test(lower);

    const isJunk =
      lower.includes('advertise') ||
      lower.includes('facebook') || lower.includes('twitter') ||
      lower.includes('instagram') || lower.includes('t.me/') ||
      lower.includes('whatsapp') || lower.includes('youtube') ||
      lower.includes('mailto:') || lower.includes('javascript:') ||
      lower.includes(BASE.toLowerCase() + '/category') ||
      lower.includes(BASE.toLowerCase() + '/#') ||
      lower.includes(BASE.toLowerCase() + '/movies') ||
      lower.includes(BASE.toLowerCase() + '/tv');

    if (isReal && !isJunk && !seen.has(href)) {
      seen.add(href);
      links.push({
        url: href.startsWith('http') ? href : BASE + href,
        label: ($(el).text() || 'Download').trim().slice(0, 40)
      });
    }
  });

  links.sort((a, b) => {
    const score = u => u.url.toLowerCase().includes('dl.baiscope') ? 0 :
      /\.(zip|rar|7z|srt)/.test(u.url.toLowerCase()) ? 1 :
      u.url.toLowerCase().includes('/download') ? 2 : 3;
    return score(a.url) - score(b.url);
  });

  return { title, poster, links };
}

// ---------- Download subtitle file (intermediate page follow) ----------
function extractRealLinks(html) {
  const $ = cheerio.load(html);
  const found = [];
  const seen = new Set();

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const lower = href.toLowerCase();
    if (lower.includes('dl.baiscope') || /\.(zip|rar|7z|srt)(\?|$)/.test(lower)) {
      if (!seen.has(href)) { seen.add(href); found.push(href.startsWith('http') ? href : BASE + href); }
    }
  });

  $('form[action]').each((i, el) => {
    const action = $(el).attr('action') || '';
    if (action.startsWith('http')) found.push(action);
  });

  const m = html.match(/https?:\/\/[^\s"'<>]*dl\.baiscope[^\s"'<>]*/i);
  if (m && !seen.has(m[0])) found.push(m[0]);

  return found;
}

async function fetchSubtitle(url, referer, depth = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-'));

  let res;
  try {
    res = await axios.get(url, {
      headers: { ...HEADERS, Referer: referer },
      responseType: 'arraybuffer',
      timeout: 60000,
      maxRedirects: 5,
      validateStatus: () => true
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  const status = res.status;
  const ct = (res.headers['content-type'] || '').toLowerCase();
  const data = res.data;

  if (status === 403 || status === 429 || status === 503) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('CLOUDFLARE_BLOCKED (' + status + ')');
  }

  if (ct.includes('text/html')) {
    if (depth < 2) {
      const html = Buffer.from(data).toString('utf8');
      const candidates = extractRealLinks(html);
      const next = candidates.find(u => u !== url);
      if (next) {
        console.log('[baiscope] intermediate page → following:', next);
        fs.rmSync(dir, { recursive: true, force: true });
        return fetchSubtitle(next, url, depth + 1);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('INTERMEDIATE_PAGE');
  }

  const cd = res.headers['content-disposition'] || '';
  const filename = (cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1]
    || url.split('/').pop().split('?')[0] || 'subtitle').replace(/["']/g, '');

  const ext = path.extname(filename) || '.zip';
  const filePath = path.join(dir, `subtitle${ext}`);
  fs.writeFileSync(filePath, data);
  return filePath;
}

async function downloadSubtitle(url, referer) {
  return fetchSubtitle(url, referer, 0);
}

// ---------- State ----------
const pending = new Map();
function createId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---------- /sub command ----------
async function cmdSub(ctx) {
  const query = (ctx.message?.text || '').replace(/^\/sub\s*/i, '').trim();
  if (!query) {
    return ctx.reply('🎬 Usage: `/sub <movie name>`\nඋදා: /sub interstellar', { parse_mode: 'Markdown' });
  }

  const status = await ctx.reply(`🔍 බයිස්කෝප් එකේ "${esc(query)}" search කරනවා...`);
  try {
    const results = await searchBaiscope(query);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

    if (!results.length) {
      return ctx.reply('❌ Results නැහැ. වෙන movie name එකක් try කරන්න.');
    }

    const id = createId();
    pending.set(id, results);
    setTimeout(() => pending.delete(id), 600000).unref?.();

    const keyboard = {
      inline_keyboard: results.map((r, i) => [{
        text: r.title.slice(0, 60),
        callback_data: `bsc_${id}_${i}`
      }])
    };
    return ctx.reply('👇 Movie/Series එකක් තෝරන්න — subtitle එක auto upload වෙනවා:', { reply_markup: keyboard });
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    console.log('[baiscope] search failed:', e.message);
    return ctx.reply(`❌ Search error: ${e.message}`);
  }
}

// ---------- Callbacks ----------
async function handleSubCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  console.log('[baiscope] callback:', data);
  await ctx.answerCbQuery().catch(e => console.log('[baiscope] answerCb fail:', e.message));

  try {
    // ----- Movie select (bsc_) → OMDb info → auto download → upload -----
    if (data.startsWith('bsc_')) {
      const [, id, idx] = data.split('_');
      const results = pending.get(id);
      if (!results) return ctx.reply('⌛ Expired. නැවත /sub කරන්න.');

      const picked = results[Number(idx)];
      if (!picked) return ctx.reply('❌ Result එක හමු වුණේ නැහැ.');

      const status = await ctx.reply('🔍 Subtitle link එක හොයනවා...');
      try {
        const info = await getSubtitleLink(picked.url);
        await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

        if (!info.links.length) {
          console.log('[baiscope] no links found for', picked.url);
          return ctx.reply('❌ Subtitle link auto-detect කරන්න බැහැ.\n\n📥 Browser එකෙන් ගන්න:\n' + picked.url);
        }

        // --- OMDb poster + details ---
        const omdb = await getOmdbInfo(picked.title);
        const caption = omdb
          ? omdbCaption(omdb, picked.url)
          : `🎬 <b>${esc(info.title)}</b>\n📝 සිංහල උපසිරැසි\n🔗 ${esc(picked.url)}`;
        const posterUrl = (omdb && omdb.Poster && omdb.Poster !== 'N/A') ? omdb.Poster : info.poster;

        try {
          if (posterUrl) await ctx.replyWithPhoto(posterUrl, { caption, parse_mode: 'HTML' });
          else await ctx.reply(caption, { parse_mode: 'HTML' });
        } catch {
          await ctx.reply(caption, { parse_mode: 'HTML' });
        }

        // --- Auto download: පළවෙනි (best-scored) link එක ---
        const dlStatus = await ctx.reply(`⏳ Subtitle download කරනවා...\n📥 ${info.links[0].url}`);

        let filePath = null;
        try {
          filePath = await downloadSubtitle(info.links[0].url, picked.url);
        } catch (e) {
          console.log('[baiscope] auto download failed:', e.message);
          await ctx.telegram.deleteMessage(ctx.chat.id, dlStatus.message_id).catch(() => {});

          const linkId = createId();
          pending.set(linkId, { ...info, pageUrl: picked.url });
          setTimeout(() => pending.delete(linkId), 600000).unref?.();

          const keyboard = {
            inline_keyboard: info.links.slice(0, 5).map((l, i) => [{
              text: (l.label || 'Download').slice(0, 40),
              callback_data: `bscd_${linkId}_${i}`
            }])
          };
          return ctx.reply(`⚠️ Auto download fail (${e.message}) — link එකක් අතින් තෝරන්න:`, { reply_markup: keyboard });
        }

        try {
          console.log('[baiscope] uploading file:', filePath);
          await ctx.replyWithDocument(
            { source: fs.createReadStream(filePath), filename: `${info.title.replace(/[^\w\s()-]/g, '').slice(0, 50)}${path.extname(filePath) || '.zip'}` },
            { caption: `✅ ${esc(info.title)}\nසිංහල උපසිරැසි — POWERED BY CINEMAX` }
          );
        } catch (e) {
          console.log('[baiscope] upload failed:', e.message);
          return ctx.reply(`⚠️ Upload fail: ${e.message}\n\n📥 Link:\n${info.links[0].url}`);
        } finally {
          try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {}
          await ctx.telegram.deleteMessage(ctx.chat.id, dlStatus.message_id).catch(() => {});
        }
        return;

      } catch (e) {
        await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
        console.log('[baiscope] link scrape failed:', e.message);
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // ----- Manual link select (bscd_) — auto fail fallback එකට -----
    if (data.startsWith('bscd_')) {
      const [, id, idx] = data.split('_');
      const cached = pending.get(id);
      if (!cached) return ctx.reply('⌛ Expired. නැවත /sub කරන්න.');

      const dl = cached.links[Number(idx)];
      if (!dl) return ctx.reply('❌ Link එක හමු වුණේ නැහැ.');

      console.log('[baiscope] downloading:', dl.url);

      const status = await ctx.reply('⏳ Subtitle download කරනවා...');

      let filePath = null;
      try {
        filePath = await downloadSubtitle(dl.url, cached.pageUrl);
      } catch (e) {
        await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
        console.log('[baiscope] download failed:', e.message);
        return ctx.reply(`⚠️ Direct download fail වුණා.\n\n📥 Browser එකෙන් ගන්න:\n${dl.url}`);
      }

      try {
        console.log('[baiscope] uploading file:', filePath);
        await ctx.replyWithDocument(
          { source: fs.createReadStream(filePath) },
          { caption: `✅ ${cached.title}\nPOWERED BY CINEMAX` }
        );
      } catch (e) {
        console.log('[baiscope] upload failed:', e.message);
        return ctx.reply(`⚠️ Upload fail: ${e.message}\n\n📥 Link:\n${dl.url}`);
      } finally {
        try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch {}
        await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      }
      return;
    }
  } catch (e) {
    console.error('[baiscope] handler crash:', e);
    try {
      return await ctx.reply(`⚠️ Error: ${e.message}`);
    } catch {}
  }
}

module.exports = { cmdSub, handleSubCallback };
