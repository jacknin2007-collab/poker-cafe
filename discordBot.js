// ============================================================
//  2 BOT DISCORD + KIỂM DUYỆT — cùng chạy trong server poker-cafe
//
//   1) BOT CHECK-BOUNTY (token DISCORD_BOUNTY_TOKEN)
//        Kênh check-bounty: "$check <sđt>" -> tra DB -> trả về bounty
//        (Bot này cũng kiêm KIỂM DUYỆT tất cả kênh)
//
//   2) BOT TOP (token DISCORD_TOP_TOKEN)
//        Kênh top: "<sđt> <top>" -> trả về mẫu xác nhận (KHÔNG lưu DB)
//
//  KIỂM DUYỆT (chạy trên bot CHECK-BOUNTY, hoặc bot TOP nếu không có bounty):
//   - Quét MỌI kênh (trừ 2 kênh lệnh check-bounty/top)
//   - Nếu có từ thô tục hoặc từ về tiền -> XÓA tin nhắn + CẤM CHAT 5 phút
//
//  Token đặt qua biến môi trường (bí mật). Thiếu token nào thì bot đó không chạy.
// ============================================================

const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('./database');

// ── CẤU HÌNH ────────────────────────────────────────────────
const BOUNTY_TOKEN = process.env.DISCORD_BOUNTY_TOKEN || '';
const TOP_TOKEN    = process.env.DISCORD_TOP_TOKEN || '';

const BOUNTY_CHANNEL_ID = process.env.BOUNTY_CHANNEL_ID || '1513784518799261746';
const TOP_CHANNEL_ID    = process.env.TOP_CHANNEL_ID    || '1513784002291699732';
const CHECK_COMMAND     = process.env.CHECK_COMMAND     || '$check';

// Thời gian cấm chat (phút) khi vi phạm
const TIMEOUT_MINUTES = Math.max(1, Number(process.env.MOD_TIMEOUT_MINUTES) || 5);

// ── DANH SÁCH TỪ CẤM (chỉnh được qua env, ngăn cách bằng dấu phẩy) ──
// So khớp trên văn bản đã bỏ dấu + viết thường, nên "địt" = "dit", "lồn" = "lon"...
const PROFANITY_DEFAULT = [
  'dit', 'djt', 'lon', 'cac', 'cak', 'buoi', 'cu', 'dam', 'dái',
  'dm', 'dmm', 'dcm', 'vcl', 'vkl', 'vl', 'cc', 'clm', 'cmm', 'cmnr',
  'ditme', 'dume', 'do ngu', 'thang ngu', 'con cho', 'cho de', 'súc vat', 'suc vat',
  'oc cho', 'khốn nạn', 'khon nan', 'đĩ', 'di diem', 'dam dang', 'phò', 'pho',
];
const MONEY_DEFAULT = [
  'tien', 'chuyen khoan', 'ck tien', 'nap tien', 'rut tien', 'coc tien',
  'vnd', 'vnđ', 'dola', 'usd', 'bank', 'momo', 'so tai khoan', 'stk',
];

function parseList(envVal, fallback) {
  if (!envVal) return fallback;
  return envVal.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
const PROFANITY = parseList(process.env.PROFANITY_WORDS, PROFANITY_DEFAULT);
const MONEY     = parseList(process.env.MONEY_WORDS, MONEY_DEFAULT);

// Bỏ dấu tiếng Việt + viết thường để bắt cả khi gõ có dấu
function chuanHoa(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

// Kiểm tra 1 câu có chứa từ cấm không -> trả về 'thô tục' / 'tiền' / null
function timTuCam(noiDung) {
  const text = ' ' + chuanHoa(noiDung).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const w of PROFANITY) {
    const nw = chuanHoa(w);
    if (nw.length <= 3 ? text.includes(' ' + nw + ' ') : text.includes(nw)) return 'thô tục';
  }
  for (const w of MONEY) {
    const nw = chuanHoa(w);
    if (nw.length <= 3 ? text.includes(' ' + nw + ' ') : text.includes(nw)) return 'tiền';
  }
  // Bắt số tiền dạng "50k", "2tr", "1 triệu", "100 ngàn"
  if (/\b\d+\s*(k|tr|trieu|nghin|ngan|m)\b/.test(chuanHoa(noiDung))) return 'tiền';
  return null;
}

// ── PARSE TIN NHẮN BOT ──────────────────────────────────────
function laySdtCheck(noiDung) {
  const re = new RegExp(CHECK_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d{9,11})\\b', 'i');
  const m = noiDung.trim().match(re);
  return m ? m[1] : null;
}
function tachTop(noiDung) {
  const m = noiDung.trim().match(/(\d{9,11})\s+(?:top\s*)?(\d+)/i);
  return m ? { sdt: m[1], top: m[2] } : null;
}
function mauTop(sdt, top) {
  return '━━━━━━━━━━━━━━━━━━\n'
       + `📱 Số điện thoại: ${sdt}\n`
       + `🔝 Số top: ${top}\n`
       + '━━━━━━━━━━━━━━━━━━\n'
       + '✅ Đã ghi nhận thông tin.';
}

// ── TRA CỨU BOUNTY ──────────────────────────────────────────
async function traBounty(sdt) {
  const c = await db.prepare(
    'SELECT name, top1, top2, top3 FROM customers WHERE phone = ? LIMIT 1'
  ).get(sdt);
  if (!c) return null;
  const top1 = Number(c.top1) || 0, top2 = Number(c.top2) || 0, top3 = Number(c.top3) || 0;
  return { ten: c.name, bounty: top1 * 30 + top2 * 20 + top3 * 10 };
}

// ── KIỂM DUYỆT 1 TIN NHẮN ───────────────────────────────────
// Trả về true nếu đã xử lý (vi phạm) để bỏ qua các xử lý khác.
async function kiemDuyet(message) {
  // Không kiểm duyệt 2 kênh lệnh bot
  if (message.channel.id === BOUNTY_CHANNEL_ID || message.channel.id === TOP_CHANNEL_ID) return false;
  if (!message.content) return false;

  const loai = timTuCam(message.content);
  if (!loai) return false;

  // 1) Xóa tin nhắn
  try { await message.delete(); } catch (e) { console.error('[MOD] Không xóa được tin:', e.message); }

  // 2) Cấm chat (timeout) tác giả
  try {
    const member = message.member;
    if (member && member.moderatable) {
      await member.timeout(TIMEOUT_MINUTES * 60 * 1000, `Vi phạm: từ ${loai}`);
    }
  } catch (e) { console.error('[MOD] Không cấm chat được:', e.message); }

  // 3) Cảnh báo ngắn (tự xóa sau 6 giây)
  try {
    const warn = await message.channel.send(
      `🚫 <@${message.author.id}> tin nhắn bị xóa do chứa **từ ${loai}**. Bạn bị cấm chat ${TIMEOUT_MINUTES} phút.`
    );
    setTimeout(() => warn.delete().catch(() => {}), 6000);
  } catch (e) {}

  return true;
}

// ── TẠO 1 BOT ───────────────────────────────────────────────
function taoBot(label, token, { moderate = false, onMessage } = {}) {
  if (!token) {
    console.log(`[BOT ${label}] Chưa đặt token — bỏ qua, không chạy.`);
    return;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.once(Events.ClientReady, (c) => {
    console.log(`[BOT ${label}] Đã đăng nhập Discord: ${c.user.tag}${moderate ? ' (kiêm kiểm duyệt)' : ''}`);
  });
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;
      // Kiểm duyệt trước (nếu bot này được giao)
      if (moderate) {
        const viPham = await kiemDuyet(message);
        if (viPham) return; // đã xóa, không xử lý tiếp
      }
      if (onMessage) await onMessage(message);
    } catch (err) {
      console.error(`[BOT ${label}] Lỗi xử lý tin nhắn:`, err.message);
    }
  });
  client.on('error', (e) => console.error(`[BOT ${label}] Discord error:`, e.message));
  client.login(token).catch((e) => console.error(`[BOT ${label}] Đăng nhập thất bại:`, e.message));
}

// ── KHỞI ĐỘNG ───────────────────────────────────────────────
function startDiscordBot() {
  // Kiểm duyệt giao cho bot CHECK-BOUNTY; nếu không có thì giao cho bot TOP.
  const modOnBounty = !!BOUNTY_TOKEN;

  // Bot 1: CHECK-BOUNTY (+ kiểm duyệt)
  taoBot('CHECK-BOUNTY', BOUNTY_TOKEN, {
    moderate: modOnBounty,
    onMessage: async (message) => {
      if (message.channel.id !== BOUNTY_CHANNEL_ID) return;
      const sdt = laySdtCheck(message.content);
      if (!sdt) return;
      const data = await traBounty(sdt);
      if (!data) {
        await message.channel.send(`❌ Không tìm thấy khách với SĐT **${sdt}**.`);
        return;
      }
      await message.channel.send(
        `📱 SĐT: ${sdt}\n👤 Khách: ${data.ten}\n🏆 Số bounty: ${data.bounty}`
      );
    },
  });

  // Bot 2: TOP (kiêm kiểm duyệt nếu không có bot bounty)
  taoBot('TOP', TOP_TOKEN, {
    moderate: !modOnBounty,
    onMessage: async (message) => {
      if (message.channel.id !== TOP_CHANNEL_ID) return;
      const kq = tachTop(message.content);
      if (!kq) return;
      await message.channel.send(mauTop(kq.sdt, kq.top));
    },
  });
}

module.exports = { startDiscordBot };
