// handlers/results.js — doenets.lk A/L & O/L results (index + NIC flow)
const axios = require('axios');

const BASE = 'https://result.doenets.lk/result/service';

const api = axios.create({
  baseURL: BASE,
  timeout: 25000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.doenets.lk/'
  }
});

// ---------- API helpers ----------
async function fetchResult(kind, indexNo, nic) {
  // kind: 'al' | 'ol'
  const path = kind === 'al' ? `/AlResult/${encodeURIComponent(indexNo)}` : `/OlResult/${encodeURIComponent(indexNo)}`;

  // සමහර වෙලාවට NIC එක query param එකක් විදිහට ඕනි වෙනවා — දෙකම try කරනවා
  let data;
  if (nic) {
    try {
      const res = await api.get(path, { params: { nic } });
      data = res.data;
    } catch (e) {
      const res2 = await api.get(path);
      data = res2.data;
    }
  } else {
    const res = await api.get(path);
    data = res.data;
  }

  if (data && data.errMsge) throw new Error(data.errMsge);
  if (!data || (!data.name && !data.subjectResults)) throw new Error('RESULT_NOT_FOUND');
  return data;
}

async function fetchExamDetails() {
  try {
    const { data } = await api.get('/examDetails');
    return data || {};
  } catch {
    return {};
  }
}

// ---------- Formatting ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatResult(d, kind) {
  const lines = [];
  const examName = kind === 'al' ? 'G.C.E. (A/L) Examination' : 'G.C.E. (O/L) Examination';

  lines.push(`🎓 <b>${esc(examName)}${d.year ? ` — ${esc(d.year)}` : ''}</b>`);
  lines.push('');
  lines.push(`👤 Name: <b>${esc(d.name || '-')}</b>`);
  lines.push(`🔢 Index No: ${esc(d.indexNo || '-')}`);
  if (d.stream) lines.push(`📚 Stream: <b>${esc(d.stream)}</b>`);
  if (d.islandRank) lines.push(`🏆 Island Rank: <b>${esc(d.islandRank)}</b>`);
  if (d.districtRank) lines.push(`🏅 District Rank: <b>${esc(d.districtRank)}</b>`);
  if (d.zScore !== undefined && d.zScore !== null && d.zScore !== '') lines.push(`📊 Z-Score: <b>${esc(d.zScore)}</b>`);
  if (d.marks !== undefined && d.marks !== null) lines.push(`📊 Marks: <b>${esc(d.marks)}</b>`);

  if (Array.isArray(d.subjectResults) && d.subjectResults.length) {
    lines.push('');
    lines.push('📖 <b>Subject Results</b>');
    for (const s of d.subjectResults) {
      const name = s.subjectName || s.subject || s.name || 'Subject';
      const grade = s.result || s.grade || s.mark || '-';
      lines.push(`• ${esc(name)}: <b>${esc(grade)}</b>`);
    }
  }

  lines.push('');
  lines.push('🔎 තහවුරු කිරීමට: https://www.doenets.lk/examresults');
  return lines.join('\n');
}

// ---------- Session state ----------
// userId -> { step: 'index'|'nic'|'year', kind: 'al'|'ol', index, nic }
const sessions = new Map();
// 10 min පස්සේ session එක expire
function setSession(uid, val) {
  sessions.set(uid, val);
  setTimeout(() => sessions.delete(uid), 600000).unref?.();
}

function cancelSession(ctx) {
  if (sessions.has(ctx.from.id)) {
    sessions.delete(ctx.from.id);
    return ctx.reply('❌ Exam result session එක cancel කළා.');
  }
}

function validIndex(s) { return /^[0-9]{6,10}$/.test(s); }
function validNIC(s) { return /^([0-9]{9}[VvXx]|[0-9]{12})$/.test(s); }
function validYear(s) { return /^(19|20)\d{2}$/.test(s); }

// ---------- Command handlers ----------
async function cmdAl(ctx) {
  const details = await fetchExamDetails();
  const year = details.yearAlResult || '';
  setSession(ctx.from.id, { step: 'index', kind: 'al', year });
  return ctx.reply(
    `🎓 <b>G.C.E. (A/L) Results${year ? ` — ${esc(year)}` : ''}</b>\n\n` +
    '🔢 ඔබේ <b>Index අංකය</b> එවන්න (උදා: <code>5026024</code>)\n\n' +
    '❌ Cancel කරන්න: /cancel',
    { parse_mode: 'HTML' }
  );
}

async function cmdOl(ctx) {
  const details = await fetchExamDetails();
  const year = details.yearOlResult || '';
  setSession(ctx.from.id, { step: 'index', kind: 'ol', year });
  return ctx.reply(
    `🎓 <b>G.C.E. (O/L) Results${year ? ` — ${esc(year)}` : ''}</b>\n\n` +
    '🔢 ඔබේ <b>Index අංකය</b> එවන්න (උදා: <code>60043156</code>)\n\n' +
    '❌ Cancel කරන්න: /cancel',
    { parse_mode: 'HTML' }
  );
}

// ---------- Text flow handler (index → NIC → result) ----------
async function resultsHandler(ctx) {
  const text = (ctx.message?.text || '').trim();
  const uid = ctx.from?.id;

  // /cancel හැමවිටම check
  if (text.startsWith('/cancel')) return cancelSession(ctx);

  const s = sessions.get(uid);
  if (!s) return false; // මේ user ගේ active session එකක් නෑ — අනිත් handlers වලට යන්න දෙන්න

  if (s.step === 'index') {
    if (!validIndex(text)) {
      return ctx.reply('⚠️ වලංගු Index අංකයක් එවන්න (ඉලක්කම් 6-10ක්).\n\n❌ Cancel: /cancel');
    }
    s.index = text;
    s.step = 'nic';
    setSession(uid, s);
    return ctx.reply(
      '🪪 දැන් ඔබේ <b>NIC අංකය</b> එවන්න:\n' +
      '• අලුත් NIC: <code>200123456789</code>\n' +
      '• පරණ NIC: <code>941234567V</code>\n\n' +
      '❌ Cancel: /cancel',
      { parse_mode: 'HTML' }
    );
  }

  if (s.step === 'nic') {
    const nic = text.toUpperCase();
    if (!validNIC(nic)) {
      return ctx.reply('⚠️ වලංගු NIC අංකයක් එවන්න.\n• අලුත්: <code>200123456789</code>\n• පරණ: <code>941234567V</code>\n\n❌ Cancel: /cancel', { parse_mode: 'HTML' });
    }
    s.nic = nic;
    sessions.delete(uid); // flow එක ඉවර — fetch කරනවා

    const status = await ctx.reply('⏳ ප්‍රතිඵල ලබාගන්නවා...');
    try {
      const data = await fetchResult(s.kind, s.index, s.nic);
      await ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
      return ctx.reply(formatResult(data, s.kind), { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[results] fetch error:', e.response?.status, e.message);
      await ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
      const hint =
        e.message === 'RESULT_NOT_FOUND'
          ? 'මේ index අංකයට ප්‍රතිඵලයක් publish වෙලා නැත හෝ අංකය වැරදියි.'
          : 'doenets.lk API එකට connect වෙන්න බැරි වුණා. ටිකකින් නැවත try කරන්න.';
      return ctx.reply(
        `❌ ප්‍රතිඵලය ලබාගන්න බැරි වුණා.\n${hint}\n\n` +
        'නැවත උත්සාහ කරන්න: /al හෝ /ol\n' +
        '🔎 Official site: https://www.doenets.lk/examresults'
      );
    }
  }

  return false;
}

// වෙන text handler එකකට pass කරන්න ඕනි දැයි check කරන helper
function hasSession(ctx) { return sessions.has(ctx.from?.id); }

module.exports = { cmdAl, cmdOl, resultsHandler, hasSession, cancelSession };
