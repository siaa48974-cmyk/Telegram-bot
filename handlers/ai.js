// handlers/ai.js — Llama 3 (Groq) Chat + AI Image Generation
const axios = require('axios');

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

// ==== Chat memory (per chat) ====
const memory = new Map();
function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

const SYSTEM_PROMPT = 'You are a helpful, friendly AI assistant. Reply in the same language the user uses (Sinhala, English, or mixed). Keep answers concise but informative.';

async function groqChat(messages) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set in Secrets');
  const { data } = await axios.post(GROQ_URL, {
    model: MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 1024
  }, {
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    timeout: 60000
  });
  return data.choices[0].message.content;
}

/* ============ /ai — Chat with Llama 3 ============ */
async function cmdAi(ctx) {
  const prompt = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!prompt) return ctx.reply('❗ භාවිතය: /ai <ඔයාගේ ප්‍රශ්නය>');

  const thinking = await ctx.reply('🤔 හිතමින්...');
  try {
    const history = getHistory(ctx.chat.id);
    if (history.length === 0) history.push({ role: 'system', content: SYSTEM_PROMPT });
    history.push({ role: 'user', content: prompt });
    // memory limit: keep system + last 12 messages
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
  ctx.reply('🔄 Chat memory reset ✅ අලුතෙන් කතා කරන්න පුළුවන්!');
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
