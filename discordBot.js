// ============================================================
//  BOT DISCORD GỘP — chạy chung trong server poker-cafe
//
//  Gộp 2 bot cũ thành 1:
//   1) Kênh CHECK-BOUNTY : gõ "$check <sđt>"  -> tra DB, trả về bounty
//   2) Kênh TOP          : gõ "<sđt> <top>"   -> trả về mẫu xác nhận (KHÔNG lưu DB)
//
//  Token đặt qua biến môi trường DISCORD_BOT_TOKEN (bí mật, không ghi vào code).
//  Nếu không có token -> bot không chạy, server web vẫn hoạt động bình thường.
// ============================================================

const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('./database');

// ── CẤU HÌNH ────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_BOT_TOKEN || '';

// ID kênh (có thể đổi qua env; mặc định lấy từ 2 bot cũ của bạn)
const BOUNTY_CHANNEL_ID = process.env.BOUNTY_CHANNEL_ID || '1513784518799261746';
const TOP_CHANNEL_ID    = process.env.TOP_CHANNEL_ID    || '1513784002291699732';
const CHECK_COMMAND     = process.env.CHECK_COMMAND     || '$check';

// Mẫu trả lời cho kênh TOP (giống discord_bot.py cũ)
function mauTop(sdt, top) {
  return '━━━━━━━━━━━━━━━━━━\n'
       + `📱 Số điện thoại: ${sdt}\n`
       + `🔝 Số top: ${top}\n`
       + '━━━━━━━━━━━━━━━━━━\n'
       + '✅ Đã ghi nhận thông tin.';
}

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

// ── TRA CỨU BOUNTY TỪ DATABASE ──────────────────────────────
async function traBounty(sdt) {
  const c = await db.prepare(
    'SELECT name, top1, top2, top3 FROM customers WHERE phone = ? LIMIT 1'
  ).get(sdt);
  if (!c) return null;
  const top1 = Number(c.top1) || 0;
  const top2 = Number(c.top2) || 0;
  const top3 = Number(c.top3) || 0;
  return { ten: c.name, bounty: top1 * 30 + top2 * 20 + top3 * 10, top1, top2, top3 };
}

// ── KHỞI ĐỘNG BOT ───────────────────────────────────────────
function startDiscordBot() {
  if (!TOKEN) {
    console.log('[BOT] Chưa đặt DISCORD_BOT_TOKEN — bỏ qua, không chạy bot.');
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
    console.log(`[BOT] Đã đăng nhập Discord với tên: ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return; // bỏ qua tin nhắn của bot

      // ── Kênh CHECK-BOUNTY ──
      if (message.channel.id === BOUNTY_CHANNEL_ID) {
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
        return;
      }

      // ── Kênh TOP ──
      if (message.channel.id === TOP_CHANNEL_ID) {
        const kq = tachTop(message.content);
        if (!kq) return;
        await message.channel.send(mauTop(kq.sdt, kq.top));
        return;
      }
    } catch (err) {
      console.error('[BOT] Lỗi xử lý tin nhắn:', err.message);
      try { await message.channel.send('⚠️ Có lỗi xảy ra, thử lại sau.'); } catch (e) {}
    }
  });

  // Không để lỗi của bot làm sập server web
  client.on('error', (e) => console.error('[BOT] Discord error:', e.message));
  client.login(TOKEN).catch((e) => console.error('[BOT] Đăng nhập Discord thất bại:', e.message));
}

module.exports = { startDiscordBot };
