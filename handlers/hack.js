// handlers/hack.js
// /hack command - reply කරන user ගේ profile photo + info ලබාගෙන "Hacked" report එකක් යවයි
// (Bot API වලට group එකේ full member list ගන්න බැබැහැ, ඒ නිසා reply target එක විතරයි process කරන්නේ)

const TARGET_GROUP_ID = process.env.HACK_GROUP_ID || '';

async function hackHandler(ctx) {
  const chatId = ctx.chat.id;

  // Optional: target group එකේ විතරක් වැඩ කරන්න
  if (TARGET_GROUP_ID && chatId.toString() !== TARGET_GROUP_ID.toString()) {
    return ctx.reply('⚠️ Command only works in the target group.');
  }

  // Reply කරන user ගේ info ගන්න (reply නැත්නම් command දුන්න කෙනාම)
  const target = ctx.message?.reply_to_message?.from || ctx.from;

  if (!target || target.is_bot) {
    return ctx.reply('⚠️ Reply to a valid user message to hack!');
  }

  const username = target.username ? `@${target.username}` : target.first_name || 'Unknown';

  try {
    await ctx.reply(`🔎 Scanning ${username}...`);

    // ඇත්ත Telegram API method එක getUserProfilePhotos
    const photos = await ctx.telegram.getUserProfilePhotos(target.id, 0, 1);

    if (!photos || photos.total_count === 0) {
      return ctx.reply(
        `User: ${username}\nID: ${target.id}\nStatus: Hacked ✅\nExtracted Data: No profile photo found`
      );
    }

    const fileId = photos.photos[0][0].file_id; // largest size

    // sendPhoto වලට කෙලින්ම file_id එක දෙන්න පුළුවන් - download කරන්න අවශ්‍ය නෑ
    const caption =
      `User: ${username}\n` +
      `ID: ${target.id}\n` +
      `Status: Hacked ✅\n` +
      `Extracted Data...\n` +
      `Profile Photos: ${photos.total_count}`;

    await ctx.replyWithPhoto(fileId, { caption });
  } catch (error) {
    console.error(`[hack] Error processing ${username}:`, error.message);
    return ctx.reply(`❌ Error processing ${username}: ${error.message}`);
  }
}

module.exports = { hackHandler };
