// handlers/ai.js — Llama 3 (Groq) Chat + AI Image Generation (fixed: model fallback)
const axios = require('axios');

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ==== Free tier models (fallback order) ====
const MODELS = [
  'llama-3.1-8b-instant',        // free tier ✅ fast
  'openai/gpt-oss-20b',          // free tier ✅
  'meta-llama/llama-4-scout-17b-16e-instruct', // free tier (Meta Llama 4)
  'llama-3.3-70b-versatile'      // enterprise only — last try
];
let activeModel = null;

// ==== Chat memory (per chat) ====
const memory = new Map();
function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

const SYSTEM_PROMPT = 'You are a helpful, friendly AI assistant. Reply in the same language the user uses (Sinhala, English, or mixed). Keep answers concise but informative.';

async function groqChat(messages) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set in Secrets');

  const models = activeModel ? [activeModel, ...MODELS.filter(m => m !== activeModel)] : MODELS;
  let lastErr;

  for (const model of models) {
    try {
      const { data } = await axios.post(GROQ_URL, {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 1024
      }, {
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        timeout: 60000
      });
      activeModel = model;   // වැඩ කරන model එක remember කරගන්නවා
      console.log(`✅ AI model in use: ${model}`);
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e;
      const errMsg = e.response?.data?.error?.message || e.message;
      console.warn(`⚠️ Model ${model} failed: ${errMsg}`);
      // model එකට access නැත්නම් ඊළඟ model එකට try කරනවා
      if (errMsg.includes('does not exist') || errMsg.includes('access') || errMsg.includes('decommissioned') || e.response?.status === 404 || e.response?.status === 403) {
        continue;
      }
      // rate limit / වෙනත් error එකක් නම් throw කරනවා
      throw e;
    }
  }
  throw lastErr;
}

/* ============ /ai — Chat ============ */
async function cmdAi(ctx) {
  const prompt = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!prompt) return ctx.reply('❗ භාවිතය: /ai <ඔයාගේ ප්‍රශ්නය>');

  const thinking = await ctx.reply('🤔 හිතමින්...');
  try {
    const history = getHistory(ctx.chat.id);
    if (history.length === 0) history.push({ role: 'system', content: SYSTEM_PROMPT });
    history.push({ role: 'user', content: prompt });
    while (history.length > 13) history.splice(1, 1);

    const reply = await groqChat(history);
    history.push({ role: 'assistant', content: reply });

    const text = `🤖 ${reply}`.slice(0, 4096);
    await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, null, text);
  } catch (e) {
    console.error('AI error:', e.response?.data || e.message);
    const msg = e.response?.data?.error?.message || e.message;
    await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, null, `⚠️ AI error: ${msg}`);
  }
}

/* ============ /reset — clear chat memory ============ */
async function cmdReset(ctx) {
  memory.delete(ctx.chat.id);
  ctx.reply('🔄 Chat memory reset ✅');
}

/* ============ /img — AI image generation (Pollinations, free) ============ */
async function cmdImg(ctx) {
  const prompt = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!prompt) return ctx.reply('❗ භාවිතය: /img <image description>');

  const msg = await ctx.reply('🎨 Image එක generate කරමින්...');
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now() % 100000}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000 });
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
    await ctx.replyWithPhoto({ source: Buffer.from(res.data) }, { caption: `🎨 ${prompt}` });
  } catch (e) {
    console.error('IMG error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '⚠️ Image generation failed. නැවත try කරන්න.');
  }
}

module.exports = { cmdAi, cmdImg, cmdReset };
