// handlers/ai2.js — SiAA AI 2 - NO API + LIVE SEARCH
const axios = require('axios');

const BOT_NAME_2 = 'SiAA AI 2';
const SYSTEM_2 = `
You are SiAA AI 2, created by SiAA for CINEFLIX NEW GEN BOT SRI.
You are a friendly movie expert + pro coder.
RULES:
1. Reply in same language user uses (Sinhala/English/Mix).
2. When writing code, ALWAYS use fenced code blocks: \`\`\`python ... \`\`\`
3. Add Sinhala comments inside code.
4. Be friendly, helpful, concise.
5. If Live Web Data is provided, use it.
6. Reply in the same language the user uses (Sinhala, English, or mixed).
7. You are helpful, friendly, and highly capable.
8. Your name is SiAA Ai. If asked who you are, say: "I am SiAA Ai, created by SiAA"
9. If you write any code, ALWAYS wrap it in fenced code block with language tag, e.g. \`\`\`python ... \`\`\`
10. Be concise but informa
`;

function mdToTelegramHtml(md) {
  const parts = [];
  const codeRe = /```(\w+)?\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = codeRe.exec(md)) !== null) {
    parts.push(inline(md.slice(last, m.index)));
    const lang = m[1] || '';
    const code = escapeHtml(m[2].replace(/\n$/, ''));
    parts.push(lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre><code>${code}</code></pre>`);
    last = m.index + m[0].length;
  }
  parts.push(inline(md.slice(last)));
  return parts.join('');
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    return s;
  }
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

async function safeEdit(ctx, msgId, text) {
  const html = mdToTelegramHtml(text).slice(0, 4096);
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text.slice(0, 4096));
  }
}

async function doSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&pretty=0`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data.AbstractText) return `Search Result: ${data.AbstractText}`;
    if (data.RelatedTopics && data.RelatedTopics[0]?.Text) return `Search Result: ${data.RelatedTopics[0].Text}`;
    return '';
  } catch { return ''; }
}

async function cmdAi2(ctx) {
  const prompt = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!prompt) return ctx.reply(`❗ භාවිතය: /ai2 <ප්‍රශ්නය>\nEx: /ai2 python bot එකක් හදන හැටි`);

  const thinking = await ctx.reply(`🤖 ${BOT_NAME_2} හිතනවා...`);
  try {
    const needSearch = /latest|news|today|price|movie|2025|2026|release/i.test(prompt);
    let searchContext = '';
    if (needSearch) {
      const result = await doSearch(prompt);
      if (result) searchContext = `\n\nLive Web Data: ${result}\n`;
    }
    const fullPrompt = `${prompt}${searchContext}`;
    const url = `https://text.pollinations.ai/${encodeURIComponent(fullPrompt)}?model=openai&system=${encodeURIComponent(SYSTEM_2)}`;
    const { data } = await axios.get(url, { timeout: 60000 });
    const reply = typeof data === 'string' ? data : JSON.stringify(data);
    await safeEdit(ctx, thinking.message_id, `🤖 ${BOT_NAME_2}\n\n${reply}`);
  } catch (e) {
    console.error('AI2 error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, null, `⚠️ ${BOT_NAME_2} error, ආයේ try කරන්න.`);
  }
}

module.exports = { cmdAi2 };
