const axios = require('axios');
const fs = require('fs');

async function searchWeb(query) {
  try {
    const r = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`, { timeout: 6000 });
    if (r.data.AbstractText) return r.data.AbstractText;
  } catch {}
  return '';
}

// Funny System Prompt
const FUNNY_SYSTEM = `
You are SiAA Pro, created by SiAA.
PERSONALITY:
- You are super funny, roast lightly, friendly, savage but cute.
- Talk like a Sri Lankan Gen-Z friend. Use Sinhala + English mix.
- Use emojis a lot 😂🔥😎.
- You are SiAA Pro, not ChatGPT.

RULES FOR ANSWER:
1. Answer clean, step by step with headings.
2. If user sends code question, ALWAYS reply in beautiful copy box like:
\`\`\`language
code here
\`\`\`
3. If user asks about a photo, describe funny but accurately.
4. Keep answers short, clean, not too long.
5. Be funny!
`;

async function getAIReply(prompt, webData) {
  let system = FUNNY_SYSTEM;
  if (webData) system += `\nLIVE DATA: ${webData}`;
  
  const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai&system=${encodeURIComponent(system)}`;
  const { data } = await axios.get(url, { timeout: 90000 });
  return typeof data === 'string' ? data : JSON.stringify(data);
}

// Text to Female Voice
async function sendVoiceReply(ctx, text) {
  try {
    // Female voice using pollinations audio
    const cleanText = text.slice(0, 500); // voice එකට කෙටියෙන්
    const ttsUrl = `https://text.pollinations.ai/${encodeURIComponent(cleanText)}?model=openai-audio&voice=nova`;
    const audioRes = await axios.get(ttsUrl, { responseType: 'arraybuffer', timeout: 20000 });
    
    const filePath = `/tmp/pro_${Date.now()}.mp3`;
    fs.writeFileSync(filePath, audioRes.data);
    
    await ctx.replyWithVoice({ source: filePath });
    fs.unlinkSync(filePath);
  } catch (e) {
    console.log('Voice Error:', e.message);
  }
}

async function cmdPro(ctx) {
  let q = '';
  let hasPhoto = false;

  // Photo එකක් එක්කද?
  if (ctx.message.photo) {
    hasPhoto = true;
    q = ctx.message.caption ? ctx.message.caption.replace('/pro','').replace('/siaapro','').trim() : 'මේ photo එකේ මොකද්ද තියෙන්නේ? funny විදිහට කියන්න';
    if (!q) q = 'මේ photo එකේ මොකද්ද තියෙන්නේ?';
    q = `User sent a photo. User question: ${q}. Describe the photo funny way if you can.`;
  } else if (ctx.message.voice || ctx.message.audio) {
    // Voice Message එකක්
    await ctx.reply('🎧 SiAA Pro අහගෙන ඉන්නවා...');
    q = 'User sent a voice message. They said hello and asked something. Reply funny and say you heard their voice.';
  } else {
    q = ctx.message.text.split(' ').slice(1).join(' ').trim();
  }

  if (!q) return ctx.reply('⚡ *SiAA Pro* 😎\n\nභාවිතය:\n`/pro oyage prashnaya`\nPhoto එකක් එක්ක `/pro meka mokakda?`\nVoice එකක් එවන්න 🎤', { parse_mode: 'Markdown' });

  const thinking = await ctx.reply('⚡ SiAA Pro 😂 හිතනවා...');

  try {
    const web = await searchWeb(q);
    const replyText = await getAIReply(q, web);

    // Clean Format
    let finalText = `⚡ *SiAA Pro* 😎🔥\n\n${replyText}`;
    if (web) finalText += `\n\n🌐 _Live Internet_`;

    await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, null, finalText.slice(0, 4000), { parse_mode: 'Markdown' });

    // Female Voice එකත් එවනවා (Text එකෙන් කෙටි කොටසක්)
    if (ctx.message.voice || q.toLowerCase().includes('voice')) {
      await sendVoiceReply(ctx, replyText);
    } else if (Math.random() > 0.5) { // සමහර වෙලාවට auto voice දානවා
      // නිකන් voice ඕන නම් /pro voice කියලා type කරන්න කියලා ඉල්ලුවොත් විතරක් voice දාමු
      if (q.toLowerCase().includes('voice eka') || q.toLowerCase().includes('voice')) {
        await sendVoiceReply(ctx, replyText);
      }
    }

  } catch (e) {
    console.error(e);
    await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, null, '😵 SiAA Pro ට පොඩි error එකක්, ආයේ try කරන්න මචං!');
  }
}

module.exports = { cmdPro };
