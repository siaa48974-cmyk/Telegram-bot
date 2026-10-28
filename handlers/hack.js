const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// Replace with your credentials
const TOKEN = 'YOUR_BOT_TOKEN_HERE';
const GROUP_ID = 'YOUR_GROUP_ID_HERE';

const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- USER CACHE (@username -> user info) ----------
const CACHE_FILE = path.join(__dirname, 'user_cache.json');
let userCache = {};
try {
    if (fs.existsSync(CACHE_FILE)) userCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (e) { userCache = {}; }

function saveCache() {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(userCache, null, 2)); } catch (e) {}
}

function cacheUser(user) {
    if (!user || user.is_bot) return;
    const entry = {
        id: user.id,
        username: user.username || null,
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        ts: Date.now()
    };
    if (user.username) userCache[user.username.toLowerCase()] = entry;
    userCache['id:' + user.id] = entry;
    saveCache();
}

function findUser(query) {
    let q = query.trim().replace(/^@/, '').toLowerCase();
    if (userCache[q]) return userCache[q];
    // name එකෙන් හොයන්නත් try කරන්න
    const byName = Object.values(userCache).find(u =>
        `${u.first_name} ${u.last_name || ''}`.trim().toLowerCase() === q
    );
    return byName || null;
}

// ---------- HACK LOGIC ----------
async function hackUser(chatId, user) {
    const userId = user.id;
    const username = user.username ? `@${user.username}` : (user.first_name || 'Unknown User');

    try {
        // ✅ ඇත්ත method එක getUserProfilePhotos (getChatPhotos කියලි දෙයක් නෑ)
        const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });

        if (photos.total_count === 0) {
            await bot.sendMessage(chatId,
                `User: ${username}\nID: ${userId}\nStatus: Hacked\n(No profile photo found)`);
            return;
        }

        // Telegram API returns photos sorted by size - largest first
        const largestPhoto = photos.photos[0][0];
        const fileId = largestPhoto.file_id;

        const caption = `User: ${username}\nID: ${userId}\nStatus: Hacked\nExtracted Data...`;

        // ✅ file_id කෙලින්ම sendPhoto වලට දෙන්න පුළුවන් (download ඕනි නෑ)
        await bot.sendPhoto(chatId, fileId, { caption: caption });

    } catch (error) {
        console.error(`Error processing ${username}:`, error.message);
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
}

// ---------- /hack COMMAND ----------
bot.onText(/\/hack(?:@\w+)?\s*(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = (match[1] || '').trim();

    if (chatId.toString() !== GROUP_ID.toString()) {
        await bot.sendMessage(chatId, "Command only works in the target group.");
        return;
    }

    // /hack @username හෝ /hack <name> දැම්මොත්
    if (query) {
        const user = findUser(query);
        if (!user) {
            await bot.sendMessage(chatId,
                `❌ "${query}" ගැන bot එකට දන්නේ නෑ.\n\n` +
                `ඒ user ගේ ID එක ගන්න මුලින්ම ඒ කෙනා මේ group එකේ message එකක් දාන්න ඕනි ` +
                `(bot එකට ඒ වෙලාවේ user ගේ ID එක ලැබෙනවා).\n\n` +
                `Cached users: ${Object.keys(userCache).filter(k => !k.startsWith('id:')).length}`);
            return;
        }
        return hackUser(chatId, user);
    }

    // /hack reply එකක් විදිහට දැම්මොත් - ඒ user ගේම photo එක එයි
    if (msg.reply_to_message && msg.reply_to_message.from) {
        cacheUser(msg.reply_to_message.from);
        return hackUser(chatId, msg.reply_to_message.from);
    }

    await bot.sendMessage(chatId,
        "Usage:\n• /hack @username\n• /hack <name>\n• හෝ user කෙනෙක්ගේ message එකකට reply කරලා /hack");
});

// ---------- CACHE EVERY USER SEEN IN THE GROUP ----------
// මේක තමයි key point එක - group එකේ දැම්ම හැම message එකකින්ම user info cache කරගන්නවා
bot.on('message', (msg) => {
    if (msg.from) cacheUser(msg.from);
    if (msg.reply_to_message && msg.reply_to_message.from) cacheUser(msg.reply_to_message.from);
    // media group (album) වල තියෙන users ලත් cache කරන්න
    if (msg.media_group_id === undefined && msg.caption_entities) { /* no-op */ }
});

// new members join උනාමත් cache කරන්න
bot.on('new_chat_members', (msg) => {
    (msg.new_chat_members || []).forEach(cacheUser);
});

// helper: /users - cache එකේ තියෙන අය බලන්න
bot.onText(/\/users/, async (msg) => {
    const list = Object.values(userCache)
        .filter(u => u.username)
        .slice(0, 50)
        .map(u => `@${u.username} → ${u.id}`);
    await bot.sendMessage(msg.chat.id,
        list.length ? `Cached users:\n${list.join('\n')}` : 'Cache එක හිස් - group එකේ messages ටිකක් එනකම් ඉන්න.');
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('Bot is running...');
