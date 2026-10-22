const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CHAT_MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const WHISPER_MODEL = "whisper-large-v3";
const TTS_MODEL = "playai-tts";
const TTS_VOICE = "Celeste-PlayAI"; // Female voice
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

// ---------- VOICE -> TEXT ----------
async function transcribeVoice(ctx) {
  let tempPath = null;
  try {
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const audioRes = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    tempPath = path.join(__dirname, `../voice_${Date.now()}.ogg`);
    fs.writeFileSync(tempPath, audioRes.data);

    const form = new FormData();
    form.append('file', fs.createReadStream(tempPath));
    form.append('model', WHISPER_MODEL);

    const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${GROQ_API_KEY}` }
    });
    return res.data.text;
  } catch (e) {
    console.log('Whisper Error:', e.response?.data || e.message);
    return null;
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// ---------- TEXT -> FEMALE VOICE (OGG/OPUS for Telegram) ----------
async function textToVoice(text) {
  // 1) Groq PlayAI TTS (female) -> wav
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/audio/speech', {
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text.slice(0, 1800),
      response_format: "wav"
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 60000
    });
    const wavPath = path.join(__dirname, `../tts_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, res.data);
    return wavPath;
  } catch (e) {
    console.log('Groq TTS Error:', e.response?.data?.toString?.().slice(0, 200) || e.message);
  }

  // 2) Fallback: Google TTS (free, no key)
  try {
    const q = encodeURIComponent(text.slice(0, 200));
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${q}&tl=si&client=tw-ob`;
    const res = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const mp3Path = path.join(__dirname, `../tts_${Date.now()}.mp3`);
    fs.writeFileSync(mp3Path, res.data);
    return mp3Path;
  } catch (e) {
    console.log('Google TTS Error:', e.message);
    return null;
  }
}

// ---------- AI CALLS ----------
async function askGroqChat(prompt) {
  const systemPrompt = `You are SiAA Pro V4, funny Sri Lankan Telegram bot with a FEMALE assistant personality (reply like a cute funny girl, but keep dev knowledge sharp).
- Talk in Singlish (Sinhala+English), funny 😂
- If user asks for CODE, give it in a copyable markdown code box with language name (js, python, html...)
- Explain code briefly in Sinhala after the box.
- Keep replies short when possible.`;

  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ],
    temperature: 0.8,
    max_tokens: 900
  }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });

  return res.data.choices[0].message.content;
}

async function askVision(prompt, imageUrl) {
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: VISION_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }],
      max_tokens: 600
    }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });
    return res.data.choices[0].message.content;
  } catch (e) {
    console.log('Groq Vision Error:', e.response?.data || e.message);
    // Fallback: OpenRouter vision
    if (OPENROUTER_KEY) {
      const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: "google/gemini-2.0-flash-exp:free",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }]
      }, { headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' } });
      return r.data.choices[0].message.content;
    }
    throw e;
  }
}

// ---------- MAIN ----------
async function cmdPro(ctx) {
  try {
    let prompt = ((ctx.message.text || ctx.message.caption || "") + "").replace(/^\/(pro|siaapro)\s*/i, '').trim();
    let imageUrl = null;
    let wantVoice = false;

    // VOICE
    if (ctx.message.voice) {
      wantVoice = true;
      await ctx.sendChatAction('typing');
      const t = await transcribeVoice(ctx);
      if (t) {
        prompt = t;
        await ctx.reply(`🗣️ ඔයා කිව්වේ: "${t}"`);
      } else {
        prompt = "User sent a voice message";
      }
    }

    // PHOTO (caption එකත් support කරනවා)
    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      imageUrl = (await ctx.telegram.getFileLink(photo.file_id)).href;
      if (!prompt) prompt = "මේ photo එක මොකක්ද? විහිළුවෙන් විස්තර කරන්න";
    }

    if (!prompt) return ctx.reply("😎 /pro <msg> දාන්න, නැත්තම් Voice/Photo එකක් එවන්න!");
    if (!GROQ_API_KEY) return ctx.reply("⚠️ GROQ_API_KEY නෑ! Secrets එකේ දාන්න.");

    await ctx.sendChatAction('typing');

    const aiReply = imageUrl
      ? await askVision(prompt, imageUrl)
      : await askGroqChat(prompt);

    // Voice reply ඕන නම් / හෝ කෙටි reply නම් voice එකක් එවන්න
    const cleanText = aiReply.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>|]/g, '').trim();
    const shouldVoice = wantVoice || (cleanText.length < 400 && !/```/.test(aiReply));

    if (shouldVoice) {
      const voicePath = await textToVoice(cleanText);
      if (voicePath) {
        await ctx.replyWithVoice({ source: fs.createReadStream(voicePath) });
        fs.unlinkSync(voicePath);
        if (imageUrl || /```/.test(aiReply)) await ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
        return;
      }
    }

    await ctx.reply(aiReply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(aiReply));
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('Pro V4 Error:', msg);
    await ctx.reply(`😵 Error: ${msg}`).catch(() => {});
  }
}

module.exports = { cmdPro };
