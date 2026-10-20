const lastMessageCache = new Map(); // chatId -> last message info

function cacheMessage(ctx) {
  const msg = ctx.message;
  if (!msg) return;
  lastMessageCache.set(msg.chat.id, {
    message_id: msg.message_id,
    chat_title: msg.chat.title || msg.chat.username || msg.chat.first_name || 'chat',
    text: (msg.text || msg.caption || '').slice(0, 40),
    time: Date.now()
  });
  setTimeout(() => lastMessageCache.delete(msg.chat.id), 3600000).unref?.();
}

async function cmdShare(ctx) {
  // Usage:
  // /share -1001234567890 Hello world          → text යවනවා
  // /share -1001234567890                      → reply කරපු message/video එක forward කරනවා
  const text = ctx.message?.text || '';
  const match = text.match(/^\/share\s+(-?\d+)\s*([\s\S]*)$/);

  if (!match) {
    return ctx.reply(
      '📢 Usage:\n\n' +
      '• Text යවන්න:\n' +
      '  `/share -1001234567890 Hello!`\n\n' +
      '• Message/video එකකට **reply** කරලා forward කරන්න:\n' +
      '  `/share -1001234567890`\n\n' +
      '• Group එකකට යවන්න නම් bot එක ඒ group එකට add කරලා තියෙන්න ඕන\n' +
      '• User කෙනෙක්ට යවන්න නම් ඒ user bot එකට /start කරලා තියෙන්න ඕන',
      { parse_mode: 'Markdown' }
    );
  }

  const target = match[1];
  const body = match[2]?.trim() || '';
  const replied = ctx.message.reply_to_message;

  try {
    // Reply කරලා /share කරලා නම් → ඒ message එක forward කරනවා
    if (!body && replied) {
      await ctx.telegram.copyMessage(target, ctx.chat.id, replied.message_id);
      return ctx.reply(`✅ Reply කරපු message එක ${target} එකට forward කළා.`);
    }

    if (body) {
      await ctx.telegram.sendMessage(target, body);
      return ctx.reply(`✅ Text එක ${target} එකට යැව්වා.`);
    }

    return ctx.reply('❌ යවන්න text එකක් දෙන්න, නැත්නම් message එකකට reply කරන්න.');
  } catch (error) {
    return ctx.reply(
      `❌ යවන්න බැරි වුණා: ${error.message}\n\n` +
      '• ID එක වැරදියි දැයි බලන්න (group/channel IDs -100 ට පස්සේ එනවා)\n' +
      '• Bot එක ඒ chat එකේ member/admin ද බලන්න\n' +
      '• User කෙනෙක් නම් ඒ user bot එකට /start කරලා ඇත්තෙන් දැයි බලන්න'
    );
  }
}

// Bot එක group එකකට add වුණාම / ID එක පෙන්නනවා
async function cmdId(ctx) {
  const chat = ctx.chat;
  const info =
    `🆔 Chat ID: \`${chat.id}\`\n` +
    `📛 Name: ${chat.title || chat.username || chat.first_name || '—'}\n` +
    `📌 Type: ${chat.type}\n\n` +
    'මේ ID එක /share command එකේ target එක විදිහට පාවිච්චි කරන්න පුළුවන්.';

  if (ctx.message?.reply_to_message?.from) {
    const u = ctx.message.reply_to_message.from;
    return ctx.reply(
      info + `\n\n👤 Reply කරපු user: \`${u.id}\` (@${u.username || u.first_name})`,
      { parse_mode: 'Markdown' }
    );
  }

  return ctx.reply(info, { parse_mode: 'Markdown' });
}

module.exports = { cacheMessage, cmdShare, cmdId };
