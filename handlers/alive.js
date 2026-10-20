const fs = require('fs');
const path = require('path');

const ALIVE_LOCAL_PATH = path.join(__dirname, '..', 'alive.jpg');

async function aliveHandler(ctx) {
  const userName = ctx.from.first_name || 'User';
  const now = new Date();
  const date = now.toLocaleDateString('en-GB');
  const time = now.toLocaleTimeString('en-GB', { hour12: false });

  const caption = `👋 HI, ${userName} [•_•] I AM Active NOW 👾

╭─「 DATE INFORMATION 」
│📅 Date: ${date}
│⏰ Time: ${time}
╰──────────●●►

╭─「 STATUS DETAILS 」
│👤 User: ${userName}
│🧬 Version: 6.0.0 Modular
│🎈 Platform: Linux
│📡 Host: github
╰──────────●●►
╭─「 OUR film site 」
│🚀 cinemaxlk.vercel.app
╰──────────●●►
╭──────────●●►
│ Hello, I am alive now!!
╰──────────●●►`;

  try {
    if (fs.existsSync(ALIVE_LOCAL_PATH)) {
      await ctx.replyWithPhoto({ source: fs.createReadStream(ALIVE_LOCAL_PATH) }, {
        caption: caption,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎬 Search Movie', switch_inline_query_current_chat: '' }],
            [{ text: '🌐 Visit Site', url: 'https://cinemaxlk.vercel.app' }]
          ]
        }
      });
    } else {
      await ctx.reply(caption);
    }
  } catch (e) {
    await ctx.reply(caption);
  }
}

module.exports = { aliveHandler };
