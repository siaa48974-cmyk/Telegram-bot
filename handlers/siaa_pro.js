const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Stable Models - 404 එන්නේ නෑ
const MODELS = ["llama3-8b-8192", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

async function sendVoiceReply(ctx, text) {
  try {
    const cleanText = text.replace(/[*_~`]/g, '').slice(0, 200);
    if (!cleanText) return false;
    // Working TTS
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(cleanText)}`;
    const res = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 15000 });
    const p = path.join(__dirname, `../temp_${Date.now()}.mp3`);
    fs.writeFileSync(p, res.data);
    await ctx.replyWithVoice({ source: p });
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (e) {
    console.log('Voice TTS Failed:', e.message);
    return false; // Voice බැරි නම් Error දෙන්නේ නෑ, false වෙනවා
  }
}

async function cmdPro(ctx) {
  try {
    const raw = ctx.message.text || ctx.message.caption || "";
    let prompt = raw.replace(/^\/(pro|siaapro)\s*/i, '').trim();
    let isVoice = !!ctx.message.voice;

    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const link = await ctx.telegram.getFileLink(photo.file_id);
      if (!prompt) prompt = "Roast this image funny";
    }

    if (!prompt && isVoice) prompt = "User sent a voice, reply funny in Singlish";
    if (!prompt) return ctx.reply("😎 /pro <msg> දාන්න මචං! Eg: /pro hi machan");

    if (!GROQ_API_KEY) return ctx.reply("⚠️ GROQ_API_KEY නෑ .env එකේ! Groq.com එකෙන් free key එකක් අරන් දාන්න.");

    await ctx.sendChatAction('typing');

    const systemPrompt = `You are SiAA Pro, funny Sri Lankan AI. Talk in Sinhala + English mix (Singlish), very funny, savage but friendly, use emojis 😂🔥. Keep reply under 120 words.`;

    let aiReply = null;
    let lastError = null;

    // Try models one by one - 404 ආවොත් next model එක try කරනවා
    for (const model of MODELS) {
      try {
        const res = await axios.post('https://api.groq.com/openai/v1/chat/completions',
          {
            model,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
            temperature: 0.9,
            max_tokens: 300
          },
          { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
        );
        aiReply = res.data.choices[0]?.message?.content;
        if (aiReply) break;
      } catch (e) {
        lastError = e.response?.data?.error?.message || e.message;
        console.log(`Model ${model} failed: ${lastError}`);
        continue;
      }
    }

    if (!aiReply) {
      return ctx.reply(`😵 AI Error: ${lastError}\n\nCheck GROQ_API_KEY valid da kiyala.`);
    }

    // Voice නම් Voice + Text, Text නම් Text විතරක්
    if (isVoice) {
      await ctx.sendChatAction('record_voice');
      const ok = await sendVoiceReply(ctx, aiReply);
      if (!ok) await ctx.reply(aiReply);
      else await ctx.reply(`📝 ${aiReply}`);
    } else {
      await ctx.reply(aiReply);
    }

  } catch (e) {
    console.error('SiAA Pro Crash:', e);
    await ctx.reply(`😵 Error: ${e.message}`);
  }
}

module.exports = { cmdPro };
