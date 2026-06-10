// ============================================================
//  2 BOT DISCORD RIÊNG — cùng chạy trong server poker-cafe
//
//  Giữ nguyên 2 bot riêng (2 token, 2 danh tính Discord), nhưng cả hai
//  cùng chạy chung trong 1 server / 1 lần deploy:
//
//   1) BOT CHECK-BOUNTY (token DISCORD_BOUNTY_TOKEN)
//        Kênh check-bounty: gõ "$check <sđt>" -> tra DB -> trả về bounty
//
//   2) BOT TOP (token DISCORD_TOP_TOKEN)
//        Kênh top: gõ "<sđt> <top>" -> trả về mẫu xác nhận (KHÔNG lưu DB)
//
//  Token đặt qua biến môi trường (bí mật, không ghi vào code).
//  Thiếu token nào thì bot đó không chạy; server web vẫn hoạt động bình thường.
// ============================================================

const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('./database');

// ── CẤU HÌNH ────────────────────────────────────────────────
const BOUNTY_TOKEN = process.env.DISCORD_BOUNTY_TOKEN || '';
const TOP_TOKEN     = process.env.DISCORD_TOP_TOKEN || '';

// ID kênh (đổi qua env nếu cần; mặc định lấy từ 2 bot cũ của bạn)
const BOUNTY_CHANNEL_ID = process.env.BOUNTY_CHANNEL_ID || '1513784518799261746';
const TOP_CHANNEL_ID    = process.env.TOP_CHANNEL_ID    || '1513784002291699732';
const CHECK_COMMAND     = process.env.CHECK_COMMAND     || '$check';

// ── PARSE TIN NHẮN ──────────────────────────────────────────
// "$check 0901234567" -> "0901234567"
function laySdtCheck(noiDung) {
  const re = new RegExp(CHECK_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d{9,11})\\b', 'i');
  const m = noiDung.trim().match(re);
  return m ? m[1] : null;
}

// "0901234567 5" / "0901234567 top 5" / "0901234567 top5" -> { sdt, top }
function tachTop(noiDung) {
  const m = noiDung.trim().match(/(\d{9,11})\s+(?:top\s*)?(\d+)/i);
  return m ? { sdt: m[1], top: m[2] } : null;
}

// Mẫu trả lời cho kênh TOP (kèm tên khách)
function mauTop(sdt, top, ten) {
  return '━━━━━━━━━━━━━━━━━━\n'
       + `📱 Số điện thoại: ${sdt}\n`
       + (ten ? `👤 Khách: ${ten}\n` : '')
       + `🔝 Số top: ${top}\n`
       + '━━━━━━━━━━━━━━━━━━\n'
       + '✅ Đã ghi nhận thông tin.';
}

// ── TRA CỨU BOUNTY TỪ DATABASE ──────────────────────────────
async function traBounty(sdt) {
  const c = await db.prepare(
    'SELECT name, top1, top2, top3 FROM customers WHERE phone = ? LIMIT 1'
  ).get(sdt);
  if (!c) return null;
  const top1 = Number(c.top1) || 0;
  const top2 = Number(c.top2) || 0;
  const top3 = Number(c.top3) || 0;
  return { ten: c.name, bounty: top1 * 30 + top2 * 20 + top3 * 10 };
}

// ── HÀM TẠO 1 BOT ───────────────────────────────────────────
// label: tên để in log; token: token bot; onMessage: hàm xử lý tin nhắn
function taoBot(label, token, onMessage) {
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
    console.log(`[BOT ${label}] Đã đăng nhập Discord: ${c.user.tag}`);
  });
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;
      await onMessage(message);
    } catch (err) {
      console.error(`[BOT ${label}] Lỗi xử lý tin nhắn:`, err.message);
      try { await message.channel.send('⚠️ Có lỗi xảy ra, thử lại sau.'); } catch (e) {}
    }
  });
  client.on('error', (e) => console.error(`[BOT ${label}] Discord error:`, e.message));
  client.login(token).catch((e) => console.error(`[BOT ${label}] Đăng nhập thất bại:`, e.message));
}

// ── KHỞI ĐỘNG CẢ 2 BOT ──────────────────────────────────────
function startDiscordBot() {
  // Bot 1: CHECK-BOUNTY
  taoBot('CHECK-BOUNTY', BOUNTY_TOKEN, async (message) => {
    if (message.channel.id !== BOUNTY_CHANNEL_ID) return;
    const sdt = laySdtCheck(message.content);
    if (!sdt) return;
    const data = await traBounty(sdt);
    if (!data) {
      await message.channel.send(`❌ Không tìm thấy khách với SĐT **${sdt}**.`);
      return;
    }
    await message.channel.send(
      `📱 SĐT: ${sdt}\n` +
      `👤 Khách: ${data.ten}\n` +
      `🏆 Số bounty: ${data.bounty}`
    );
  });

  // Bot 2: TOP
  taoBot('TOP', TOP_TOKEN, async (message) => {
    if (message.channel.id !== TOP_CHANNEL_ID) return;
    const kq = tachTop(message.content);
    if (!kq) return;
    // Kiểm tra SĐT có trong hệ thống main app không (CHỈ ĐỌC — không thêm/sửa main app)
    const khach = await db.prepare(
      'SELECT name FROM customers WHERE phone = ? LIMIT 1'
    ).get(kq.sdt);
    if (!khach) {
      await message.channel.send(`❌ Không tìm thấy khách với SĐT **${kq.sdt}**.`);
      return;
    }
    // Có khách -> xác nhận kèm tên (chỉ lưu trên Discord, không đụng main app)
    await message.channel.send(mauTop(kq.sdt, kq.top, khach.name));
  });
}

module.exports = { startDiscordBot };
