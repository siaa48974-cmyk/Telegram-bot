const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Markup } = require('telegraf');

// --- CONFIG ---
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = "llama-3.1-8b-instant"; // fast + funny

// Voice Reply Function (Free TTS)
async function sendVoiceReply(ctx, text) {
  try {
    // Clean text for TTS (emojis අයින් කරනවා)
    const cleanText = text.replace(/[*_~`]/g, '').slice(0, 250);
    if (!cleanText) return false;

    const ttsUrl = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(cleanText)}`;
    
    const response = await axios({
      method: 'GET',
      url: ttsUrl,
      responseType: 'arraybuffer'
    });

    const voicePath = path.join(__dirname, `../temp_${ctx.from.id}.mp3`);
    fs.writeFileSync(voicePath, response.data);

    await ctx.replyWithVoice({ source: voicePath }, {
      caption: `🎙️ SiAA Pro: ${text.slice(0, 100)}`
    });

    if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath);
    return true;
  } catch (e) {
    console.log('TTS Error:', e.message);
    return false;
  }
}

// Download voice file from Telegram
async function getVoiceText(ctx) {
  try {
    if (!ctx.message.voice) return null;
    const fileId = ctx.message.voice.file_id;
    const link = await ctx.telegram.getFileLink(fileId);
    return "User sent a voice message [Voice Input]";
  } catch { return null; }
}

async function cmdPro(ctx) {
  try {
    const msg = ctx.message.text || ctx.message.caption || "";
    let prompt = msg.replace(/^\/(pro|siaapro)\s*/i, '').trim();
    let imageUrl = null;

    // 1. Photo Handle
    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const link = await ctx.telegram.getFileLink(photo.file_id);
      imageUrl = link.href;
      if (!prompt) prompt = "Describe this photo in a funny way";
    }

    // 2. Voice Handle
    let isVoiceRequest = false;
    if (ctx.message.voice) {
      isVoiceRequest = true;
      const voiceNote = await getVoiceText(ctx);
      if (!prompt) prompt = "I sent a voice message, reply funny";
    }

    if (!prompt) {
      return ctx.reply("😎 මචං /pro <msg> කියලා යමක් දාන්න, නැත්තම් Photo/Voice එකක් එවන්න! Eg: /pro මට බඩගිනියි");
    }

    // 3. AI Call
    await ctx.sendChatAction('typing');

    const systemPrompt = `You are SiAA Pro, a funny, savage, friendly Sri Lankan bot. 
    - Talk in mixed Sinhala + English (Singlish), very funny, casual like "machan".
    - Make jokes, be savage but friendly.
    - Keep reply short under 150 words.
    - Use emojis 😂🔥😎
    - If photo described, roast it funny way.
    - User language is Sinhala mostly.`;

    let aiReply = "";

    if (!GROQ_API_KEY) {
      aiReply = `😂 මචං "${prompt}" කියලා කිව්වට GROQ_API_KEY එක නෑ! .env එකේ දාන්න.`;
    } else {
      const payload = {
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        temperature: 0.9,
        max_tokens: 300
      };

      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', payload, {
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
      });

      aiReply = res.data.choices[0]?.message?.content || "මචං Error එකක් ආවා 😅";
    }

    // 4. Send Reply - Voice + Text
    if (isVoiceRequest) {
      // Voice එකක් එවපු අයට Voice එකකින්ම Reply
      await ctx.sendChatAction('record_voice');
      const voiceSent = await sendVoiceReply(ctx, aiReply);
      if (!voiceSent) {
        await ctx.reply(aiReply, { parse_mode: 'Markdown' });
      }
    } else {
      // Normal Text Reply + Try Voice also?
      await ctx.reply(aiReply, { parse_mode: 'Markdown' });
      
      // Text එකටත් Voice එකක් එක්කම ඕන නම් මේ line එක uncomment කරන්න
      // await sendVoiceReply(ctx, aiReply);
    }

  } catch (e) {
    console.error('SiAA Pro Error:', e.message);
    await ctx.reply(`😵 Error මචං: ${e.message}`);
  }
}

module.exports = { cmdPro };
