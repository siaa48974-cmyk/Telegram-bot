const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CHAT_MODEL = "llama3-8b-8192";
const VISION_MODEL = "llama-3.2-11b-vision-preview";
const WHISPER_MODEL = "whisper-large-v3";

// Voice එක Text එකක් කරනවා
async function transcribeVoice(ctx) {
  try {
    const fileId = ctx.message.voice.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    
    const audioRes = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const tempPath = path.join(__dirname, `../voice_${Date.now()}.ogg`);
    fs.writeFileSync(tempPath, audioRes.data);

    const form = new FormData();
    form.append('file', fs.createReadStream(tempPath));
    form.append('model', WHISPER_MODEL);

    const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${GROQ_API_KEY}` }
    });

    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return res.data.text;
  } catch (e) {
    console.log('Whisper Error:', e.response?.data || e.message);
    return null;
  }
}

async function cmdPro(ctx) {
  try {
    let prompt = (ctx.message.text || ctx.message.caption || "").replace(/^\/(pro|siaapro)\s*/i, '').trim();
    let imageUrl = null;

    // 1. VOICE HANDLE
    if (ctx.message.voice) {
      await ctx.sendChatAction('typing');
      await ctx.reply("🎙️ Voice එක අහනවා මචං... sec");
      const textFromVoice = await transcribeVoice(ctx);
      if (textFromVoice) {
        prompt = textFromVoice;
        await ctx.reply(`🗣️ ඔයා කිව්වේ: "${textFromVoice}"`);
      } else {
        prompt = "User sent a voice message";
      }
    }

    // 2. PHOTO HANDLE
    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      imageUrl = (await ctx.telegram.getFileLink(photo.file_id)).href;
      if (!prompt) prompt = "මේ photo එක මොකක්ද? විහිළුවෙන් විස්තර කරන්න";
    }

    if (!prompt) return ctx.reply("😎 මචං /pro <msg> දාන්න, නැත්තම් Voice/Photo එකක් එවන්න!");

    if (!GROQ_API_KEY) return ctx.reply("⚠️ GROQ_API_KEY නෑ!");

    await ctx.sendChatAction('typing');

    let aiReply = "";

    // 3. VISION MODEL for Photo
    if (imageUrl) {
      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: VISION_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }],
        max_tokens: 400
      }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });
      aiReply = res.data.choices[0].message.content;
    } else {
      // 4. NORMAL CHAT + CODE BOX INSTRUCTION
      const systemPrompt = `You are SiAA Pro V3, funny Sri Lankan dev bot.
- Talk in Singlish (Sinhala+English), funny 😂
- If user asks for CODE, you MUST give it in a beautiful copyable box like this:
\`\`\`js
// code here
\`\`\`
- Use language name: js, python, html, etc.
- Explain code in Sinhala after the box.
- Keep jokes short.
- If not code, reply normal funny.`;

      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 800
      }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });
      aiReply = res.data.choices[0].message.content;
    }

    // 5. Send with Markdown for Code Box Copy
    await ctx.reply(aiReply, { parse_mode: 'Markdown' });

  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('Pro V3 Error:', msg);
    await ctx.reply(`😵 Error: ${msg}`);
  }
}

module.exports = { cmdPro };
