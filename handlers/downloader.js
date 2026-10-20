
const fs = require('fs');
const path = require('path');

const OMDB_API = process.env.OMDB_API || '';
const MOVIE_API_URL =
  process.env.MOVIE_API_URL ||
  'https://raw.githubusercontent.com/siaa1234/cineflix/main/cinesubz.json';

const MAX_TG_SIZE = process.env.LOCAL_BOT_API
  ? 1900 * 1024 * 1024
  : 48 * 1024 * 1024;

const ALIVE_LOCAL_PATH = path.join(__dirname, '..', 'alive.jpg');

const movieCache = new Map();
const dlCache = new Map();
const catalogCache = { data: null, time: 0 };

function createId() {
  return Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function fetchTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function cacheSet(map, id, value, ttl = 1800000) {
  map.set(id, value);
  setTimeout(() => map.delete(id), ttl).unref?.();
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function getTitle(item) {
  if (typeof item === 'string') return item;

  return String(
    item?.title ||
    item?.name ||
    item?.series_name ||
    item?.movie_name ||
    item?.original_title ||
    ''
  );
}

function getUrl(value) {
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? value : '';
  }

  if (value && typeof value === 'object') {
    return getUrl(
      value.url ||
      value.link ||
      value.download_url ||
      value.download ||
      value.file
    );
  }

  return '';
}

function getQuality(value) {
  const text = String(
    value?.quality ||
    value?.label ||
    value?.resolution ||
    value?.name ||
    ''
  );

  const match = text.match(/(480|720|1080)\s*p?/i);
  return match ? `${match[1]}p` : '';
}

/*
 * API compatibility layer.
 *
 * Recognizes common movie/series arrays and download-link formats.
 * If your JSON uses a different schema, adapt this function.
 */

function findLinkObject(item) {
  const output = {};

  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;

    if (Array.isArray(obj)) {
      for (const child of obj) walk(child, depth + 1);
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const match = key.match(/^(480|720|1080)\s*p?$/i);

      if (match) {
        const quality = `${match[1]}p`;
        const url = getUrl(value);

        if (url) output[quality] ||= [];
        if (url && !output[quality].some(x => x.url === url)) {
          output[quality].push({ quality, url });
        }
      } else if (
        typeof value === 'string' &&
        /^(480|720|1080)p$/i.test(key)
      ) {
        const quality = key.toLowerCase();
        if (/^https?:\/\//i.test(value)) {
          output[quality] ||= [];
          output[quality].push({ quality, url: value });
        }
      }

      if (
        /download.?links?|links|downloads|qualities|sources|files/i.test(key) &&
        Array.isArray(value)
      ) {
        for (const entry of value) {
          const url = getUrl(entry);
          const quality = getQuality(entry);

          if (!url || !quality) continue;
          output[quality] ||= [];

          if (!output[quality].some(x => x.url === url)) {
            output[quality].push({
              quality,
              url,
              size: entry?.size || ''
            });
          }
        }
      }

      if (value && typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  }

  walk(item);

  for (const q of ['480p', '720p', '1080p']) {
    output[q] ||= [];
  }

  return output;
}

function findEpisodes(item) {
  const candidates =
    item?.episodes ||
    item?.episode_list ||
    item?.seasons?.flatMap(s => s.episodes || []) ||
    item?.data?.episodes ||
    [];

  if (!Array.isArray(candidates)) return [];

  return candidates.map((ep, index) => {
    const episodeNumber =
      ep?.episode_number ??
      ep?.episode ??
      ep?.number ??
      index + 1;

    return {
      number: episodeNumber,
      title: ep?.title || ep?.name || `Episode ${episodeNumber}`,
      links: findLinkObject(ep)
    };
  });
}

function normalizeCatalog(json) {
  const root = json?.result || json?.data || json;
  let movies = [];
  let series = [];

  if (Array.isArray(root)) {
    movies = root.filter(x =>
      /movie|film/i.test(String(x?.type || x?.category || ''))
    );

    series = root.filter(x =>
      /series|tv|show/i.test(String(x?.type || x?.category || ''))
    );
  } else {
    movies =
      root?.movies ||
      root?.films ||
      root?.movie ||
      root?.data?.movies ||
      [];

    series =
      root?.tv_series ||
      root?.series ||
      root?.tv ||
      root?.shows ||
      root?.data?.series ||
      [];
  }

  if (!Array.isArray(movies)) movies = [];
  if (!Array.isArray(series)) series = [];

  // If the API supplies an untyped list, inspect its entries.
  if (Array.isArray(root) && !movies.length && !series.length) {
    for (const item of root) {
      const isSeries =
        Array.isArray(item?.episodes) ||
        Array.isArray(item?.episode_list) ||
        Array.isArray(item?.seasons) ||
        /series|tv|show/i.test(
          String(item?.type || item?.category || '')
        );

      (isSeries ? series : movies).push(item);
    }
  }

  return {
    movies: movies.map(item => ({
      ...item,
      title: getTitle(item),
      links: findLinkObject(item)
    })),
    series: series.map(item => ({
      ...item,
      title: getTitle(item),
      episodes: findEpisodes(item)
    }))
  };
}

async function getCatalog() {
  if (
    catalogCache.data &&
    Date.now() - catalogCache.time < 60000
  ) {
    return catalogCache.data;
  }

  const response = await fetchTimeout(MOVIE_API_URL);

  if (!response.ok) {
    throw new Error(`Movie API returned ${response.status}`);
  }

  const json = await response.json();
  const catalog = normalizeCatalog(json);

  catalogCache.data = catalog;
  catalogCache.time = Date.now();

  return catalog;
}

function searchItem(items, query) {
  const q = norm(query);
  if (!q) return null;

  const exact = items.find(item => norm(item.title) === q);
  if (exact) return exact;

  const contains = items.filter(item =>
    norm(item.title).includes(q) ||
    q.includes(norm(item.title))
  );

  if (contains.length === 1) return contains[0];

  // Prefer the closest title instead of blindly selecting
  // the first result when several items match.
  return contains.sort((a, b) =>
    Math.abs(norm(a.title).length - q.length) -
    Math.abs(norm(b.title).length - q.length)
  )[0] || null;
}

async function getOmdbData(title, type) {
  if (!OMDB_API) return null;

  try {
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('apikey', OMDB_API);
    url.searchParams.set('t', title);

    if (type === 'tv') url.searchParams.set('type', 'series');
    if (type === 'movie') url.searchParams.set('type', 'movie');

    const response = await fetchTimeout(url.toString());
    const data = await response.json();

    if (data.Response !== 'True') return null;

    return {
      title: data.Title || title,
      year: data.Year || 'N/A',
      released: data.Released || 'N/A',
      runtime: data.Runtime || 'N/A',
      rating: data.imdbRating || 'N/A',
      genre: data.Genre || 'N/A',
      country: data.Country || 'N/A',
      plot: data.Plot || 'No description available.',
      poster: data.Poster !== 'N/A' ? data.Poster : null
    };
  } catch (error) {
    console.error('OMDB error:', error.message);
    return null;
  }
}

function qualityKeyboard(id, links, prefix = 'dl') {
  const buttons = [];

  for (const quality of ['480p', '720p', '1080p']) {
    if (links?.[quality]?.length) {
      buttons.push({
        text: quality.toUpperCase(),
        callback_data: `${prefix}_${id}_${quality}`
      });
    }
  }

  return {
    inline_keyboard: buttons.length ? [buttons] : []
  };
}

function makeEpisodeKeyboard(id, episodes) {
  const rows = [];

  for (const ep of episodes) {
    rows.push([{
      text: `📥 ${ep.title}`,
      callback_data: `ep_${id}_${ep.number}`
    }]);
  }

  return { inline_keyboard: rows };
}

async function sendVideoFromUrl(ctx, url, title = 'video') {
  if (!url) {
    return { ok: false, error: 'No video URL' };
  }

  const caption = `✅ ${title}\nPOWERED BY CINEMAX`;

  // First let Telegram fetch the direct video URL.
  try {
    await ctx.replyWithVideo(url, {
      caption,
      supports_streaming: true
    });

    return { ok: true };
  } catch (error) {
    console.error('Telegram URL upload failed:', error.message);
  }

  // Fallback: download to the bot server and upload.
  let response;

  try {
    response = await fetchTimeout(url, {}, 600000);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (
      contentType &&
      !/video|octet-stream|application\/download/i.test(contentType)
    ) {
      throw new Error('URL did not return a video file');
    }

    const contentLength = Number(
      response.headers.get('content-length') || 0
    );

    if (contentLength && contentLength > MAX_TG_SIZE) {
      return {
        ok: false,
        tooBig: true,
        size: contentLength
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_TG_SIZE) {
      return {
        ok: false,
        tooBig: true,
        size: buffer.length
      };
    }

    await ctx.replyWithVideo(
      { source: buffer, filename: 'video.mp4' },
      { caption, supports_streaming: true }
    );

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function handleText(ctx) {
  const input = ctx.message?.text?.trim();
  if (!input || input.startsWith('/')) return;

  const match = input.match(/^(movie|tv)\s+(.+)$/i);

  if (!match) {
    return ctx.reply(
      '🎬 Film එකකට: movie Avatar\n' +
      '📺 Series එකකට: tv Wednesday'
    );
  }

  const type = match[1].toLowerCase() === 'tv' ? 'tv' : 'movie';
  const query = match[2].trim();

  if (!query) return ctx.reply('Film / Series නම ඇතුළත් කරන්න.');

  const status = await ctx.reply('🔍 Search කරනවා...');

  try {
    const catalog = await getCatalog();
    const item = searchItem(
      type === 'tv' ? catalog.series : catalog.movies,
      query
    );

    if (!item) {
      await ctx.telegram.deleteMessage(
        ctx.chat.id,
        status.message_id
      ).catch(() => {});

      return ctx.reply('❌ API එකේ මේ title එක හමු වුණේ නැහැ.');
    }

    const metadata = await getOmdbData(item.title, type);

    await ctx.telegram.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    const id = createId();

    if (type === 'movie') {
      const links = item.links || findLinkObject(item);
      const hasLinks = ['480p', '720p', '1080p']
        .some(q => links[q]?.length);

      if (!hasLinks) {
        return ctx.reply(
          '❌ මේ film එකට 480p / 720p / 1080p links හමු වුණේ නැහැ.'
        );
      }

      const details =
        `🎬 <b>${esc(metadata?.title || item.title)}</b>\n\n` +
        `📅 Year: ${esc(metadata?.year || 'N/A')}\n` +
        `⭐ IMDb: ${esc(metadata?.rating || 'N/A')}\n` +
        `⏱ Runtime: ${esc(metadata?.runtime || 'N/A')}\n` +
        `🎭 Genre: ${esc(metadata?.genre || 'N/A')}\n\n` +
        `${esc(metadata?.plot || 'No description available.')}\n\n` +
        `👇 Download quality එක තෝරන්න`;

      cacheSet(movieCache, id, {
        type: 'movie',
        title: item.title,
        links
      });

      const keyboard = qualityKeyboard(id, links, 'dl');

      if (metadata?.poster) {
        try {
          await ctx.replyWithPhoto(metadata.poster, {
            caption: details,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          return;
        } catch (error) {}
      }

      const localPoster = fs.existsSync(ALIVE_LOCAL_PATH)
        ? { source: fs.createReadStream(ALIVE_LOCAL_PATH) }
        : null;

      if (localPoster) {
        try {
          await ctx.replyWithPhoto(localPoster, {
            caption: details,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          return;
        } catch (error) {}
      }

      return ctx.reply(details, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    }

    // TV series: show metadata and all episodes.
    const episodes = item.episodes || [];

    if (!episodes.length) {
      return ctx.reply(
        '❌ Series එක හමු වුණා. නමුත් JSON API එකේ episodes නැහැ.'
      );
    }

    cacheSet(movieCache, id, {
      type: 'tv',
      title: item.title,
      episodes
    });

    const details =
      `📺 <b>${esc(metadata?.title || item.title)}</b>\n\n` +
      `📅 Year: ${esc(metadata?.year || 'N/A')}\n` +
      `⭐ IMDb: ${esc(metadata?.rating || 'N/A')}\n` +
      `🎭 Genre: ${esc(metadata?.genre || 'N/A')}\n` +
      `🌍 Country: ${esc(metadata?.country || 'N/A')}\n\n` +
      `${esc(metadata?.plot || 'No description available.')}\n\n` +
      `📦 Episodes: ${episodes.length}\n` +
      `👇 අවශ්‍ය episode එක තෝරන්න`;

    const keyboard = makeEpisodeKeyboard(id, episodes);

    if (metadata?.poster) {
      try {
        await ctx.replyWithPhoto(metadata.poster, {
          caption: details,
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
        return;
      } catch (error) {}
    }

    return ctx.reply(details, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Search error:', error);

    await ctx.telegram.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    return ctx.reply(
      '❌ API error එකක් ආවා. JSON URL එක සහ server logs පරීක්ෂා කරන්න.'
    );
  }
}

async function handleCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';

  await ctx.answerCbQuery().catch(() => {});

  // Movie quality selected.
  if (data.startsWith('dl_')) {
    const [, id, quality] = data.split('_');
    const cached = movieCache.get(id);

    if (!cached || cached.type !== 'movie') {
      return ctx.reply('⌛ Request එක expired. නැවත search කරන්න.');
    }

    const links = cached.links?.[quality] || [];

    if (!links.length) {
      return ctx.reply('❌ මේ quality එකට link එකක් නැහැ.');
    }

    return showLinksOrUpload(ctx, cached.title, quality, links);
  }

  // TV episode selected.
  if (data.startsWith('ep_')) {
    const [, id, episodeNumber] = data.split('_');
    const cached = movieCache.get(id);

    if (!cached || cached.type !== 'tv') {
      return ctx.reply('⌛ Request එක expired. නැවත series එක search කරන්න.');
    }

    const episode = cached.episodes.find(
      ep => String(ep.number) === String(episodeNumber)
    );

    if (!episode) return ctx.reply('❌ Episode එක හමු වුණේ නැහැ.');

    const available = ['480p', '720p', '1080p'].filter(
      q => episode.links?.[q]?.length
    );

    if (!available.length) {
      return ctx.reply('❌ මේ episode එකට download quality links නැහැ.');
    }

    const episodeId = createId();

    cacheSet(dlCache, episodeId, {
      title: `${cached.title} - ${episode.title}`,
      links: episode.links
    });

    return ctx.reply(
      `📺 <b>${esc(cached.title)}</b>\n` +
      `🎞 <b>${esc(episode.title)}</b>\n\n` +
      '👇 Quality එක තෝරන්න:',
      {
        parse_mode: 'HTML',
        reply_markup: qualityKeyboard(
          episodeId,
          episode.links,
          'epdl'
        )
      }
    );
  }

  // TV episode quality selected.
  if (data.startsWith('epdl_')) {
    const [, id, quality] = data.split('_');
    const cached = dlCache.get(id);

    if (!cached) return ctx.reply('⌛ Request එක expired.');

    const links = cached.links?.[quality] || [];

    if (!links.length) return ctx.reply('❌ Link එක නැහැ.');

    return showLinksOrUpload(ctx, cached.title, quality, links);
  }
}

async function showLinksOrUpload(ctx, title, quality, links) {
  // Try each URL until one successfully uploads.
  const status = await ctx.reply(
    `⏳ ${title} (${quality}) Telegram එකට upload කරනවා...`
  );

  let lastError = null;

  for (const item of links) {
    const result = await sendVideoFromUrl(ctx, item.url, title);

    if (result.ok) {
      await ctx.telegram.deleteMessage(
        ctx.chat.id,
        status.message_id
      ).catch(() => {});
      return;
    }

    lastError = result;
  }

  await ctx.telegram.deleteMessage(
    ctx.chat.id,
    status.message_id
  ).catch(() => {});

  const firstUrl = links[0]?.url;

  if (lastError?.tooBig) {
    return ctx.reply(
      `⚠️ Video file එක Telegram upload limit එකට වඩා විශාලයි.\n` +
      `📦 Size: ${(lastError.size / 1024 / 1024).toFixed(1)} MB\n\n` +
      `Direct link:\n${firstUrl}`
    );
  }

  return ctx.reply(
    `❌ Telegram upload අසාර්ථකයි.\n` +
    `Error: ${lastError?.error || 'Unknown error'}\n\n` +
    `Direct link:\n${firstUrl || 'Unavailable'}`
  );
}

module.exports = {
  handleText,
  handleCallback
};
