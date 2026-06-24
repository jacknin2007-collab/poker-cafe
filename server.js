const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./database');
const { startDiscordBot } = require('./discordBot');

// Lưới an toàn: lỗi async bất ngờ chỉ ghi log, KHÔNG làm sập server.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.message ? err.message : err);
});

const app = express();
app.use(cors());
app.use(express.json());

// Schema (tables + migrations) is created in database.js on first connection.

// Current active staff sessions (in memory, reset on server restart)
// Support multiple concurrent sessions per staff member
let activeSessions = {}; // { staffName: [{ sessionId, app, loginTime }, ...] }

// Health check nhẹ (dùng cho keep-alive giữ server thức)
app.get('/healthz', (req, res) => res.json({ ok: true, t: Date.now() }));

// Trang dealer
app.get('/dealer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dealer.html'));
});

// Trang floor
app.get('/floor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'floor.html'));
});

// Trang report
app.get('/report', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// Tournament Clock
app.get('/clock', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'clock.html'));
});
app.get('/clock-control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'clock-control.html'));
});

// Clock state
let clockState = {
  running: false, levelIndex: 0, timeLeft: 20*60,
  players: 0, totalPlayers: 0, buyIn: 0, rebuy: 0,
  startingStack: 50000, rebuyStack: 50000, totalStack: 0,
  prizePool: 0, payout: null,
  showPayout: false,
  lateReg: '–',
  tournamentName: 'GOLDEN COFFEE TOURNAMENT',
  bgImage: '', payoutPct: [33,25,17,11,8,6],
  levels: [
    {sb:100,bb:200,ante:200,duration:20},   // Level 1
    {sb:150,bb:300,ante:300,duration:20},   // Level 2
    {sb:200,bb:400,ante:400,duration:20},   // Level 3
    {sb:300,bb:600,ante:600,duration:20},   // Level 4
    {sb:400,bb:800,ante:800,duration:20},   // Level 5
    {isBreak:true,duration:15},              // BREAK
    {sb:500,bb:1000,ante:1000,duration:20}, // Level 6
    {sb:600,bb:1200,ante:1200,duration:20}, // Level 7
    {sb:800,bb:1600,ante:1600,duration:20}, // Level 8
    {sb:1000,bb:2000,ante:2000,duration:20},// Level 9
    {sb:1500,bb:3000,ante:3000,duration:20},// Level 10
    {isBreak:true,duration:10},              // BREAK
    {sb:2000,bb:4000,ante:4000,duration:20},// Level 11
    {sb:3000,bb:6000,ante:6000,duration:20},// Level 12
  ],
  updatedAt: Date.now()
};

let clockTimer = null;
let resetScheduleTimer = null;
let tournamentDataLocked = false; // Nếu true, không update buy-in/re-buy từ DB

function resetClockState(){
  console.log('🔄 Resetting clock for new day:', new Date().toLocaleString('vi-VN'));
  clockState = {
    running: false, levelIndex: 0, timeLeft: 20*60,
    players: 0, totalPlayers: 0, buyIn: 0, rebuy: 0,
    startingStack: 50000, rebuyStack: 50000, totalStack: 0,
    prizePool: 0, payout: null,
    showPayout: false,
    lateReg: '–',
    tournamentName: 'GOLDEN COFFEE TOURNAMENT',
    bgImage: clockState.bgImage, payoutPct: [33,25,17,11,8,6],
    levels: clockState.levels,
    updatedAt: Date.now()
  };
  tournamentDataLocked = false; // Unlock để fetch từ DB ngày mới
  if(clockTimer) {clearInterval(clockTimer); clockTimer=null;}
  scheduleNextReset();
}

function scheduleNextReset(){
  if(resetScheduleTimer) clearTimeout(resetScheduleTimer);

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 59, 0, 0); // 23h59p

  const msUntilReset = tomorrow.getTime() - now.getTime();
  console.log('⏰ Next reset scheduled in', Math.floor(msUntilReset/1000/60), 'minutes');

  resetScheduleTimer = setTimeout(resetClockState, msUntilReset);
}

function calculatePayout(){
  const prize = clockState.prizePool || 0;
  if(!prize) return null;
  const pcts = [33,25,17,11,8,6];
  // prizePool tính bằng triệu * 1000000, nên tính rồi chia lại về triệu
  const vals = pcts.map(p => Math.round(prize * p / 100 / 1000000));
  return vals;
}

function tickClock(){
  if(!clockState.running)return;
  clockState.timeLeft=Math.max(0,clockState.timeLeft-1);
  if(clockState.timeLeft<=0){
    if(clockState.levelIndex<clockState.levels.length-1){
      clockState.levelIndex++;
      const lv=clockState.levels[clockState.levelIndex];
      clockState.timeLeft=(lv.duration||20)*60;
    } else {
      clockState.running=false;
      if(clockTimer){clearInterval(clockTimer);clockTimer=null;}
    }
  }
  // Tự động hiện payout khi đến Level 11
  const lvs=clockState.levels||[];
  let realLevel=0;
  for(let i=0;i<=clockState.levelIndex;i++) if(!lvs[i]?.isBreak) realLevel++;
  clockState.showPayout=(realLevel>=11);
  if(clockState.showPayout&&(clockState.prizePool||0)>0){
    clockState.payout=calculatePayout();
  } else {
    clockState.payout=null;
  }

  clockState.updatedAt=Date.now();
}

// Auto-sync đầy đủ từ DB và table-state
async function syncClockFromData(){
  // Nếu tournament data đã lock (vừa reset), không update gì cả
  if(tournamentDataLocked) return;

  try{
    const today=new Date().toISOString().slice(0,10);

    // Luôn đếm players từ ghế bàn tour
    let sitting=0;
    if(tableState){
      (tableState.tablesTour||[]).forEach(t=>{
        (t.seats||[]).forEach(s=>{if(s&&s.trim())sitting++;});
      });
    }
    clockState.players=sitting;

    // Lấy dữ liệu từ tournament_buyin table (tracking buy-in vs re-buy chính xác)
    const buyInCount=Number((await db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=0`).get(today))?.cnt)||0;
    const rebuyCount=Number((await db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=1`).get(today))?.cnt)||0;

    clockState.buyIn=buyInCount;
    clockState.rebuy=rebuyCount;
    clockState.totalPlayers=buyInCount+rebuyCount;
    clockState.totalStack=(clockState.startingStack||0)*buyInCount+(clockState.rebuyStack||0)*rebuyCount;

    // Không reset prizePool nếu đã được set bởi người dùng ở clock-control
    // Chỉ update nếu prizePool = 0 (chưa nhập)
    if(!clockState.prizePool){
      const filter=`(table_name LIKE 'Tour%' OR table_name LIKE 'tour%' OR note LIKE '%TIEN_MAT_TOUR%' OR note LIKE '%[TOUR]%') AND note NOT LIKE '%[NOPLAY]%'`;
      const prizeRow=await db.prepare(`SELECT SUM(amount) as total FROM transactions WHERE substr(created_at,1,10)=? AND ${filter} AND amount>0`).get(today);
      clockState.prizePool=Number(prizeRow?.total)||0;
    }

    clockState.updatedAt=Date.now();
  }catch(e){ console.log('[CLOCK SYNC ERR]',e.message); }
}

app.get('/api/clock',async(req,res)=>{
  // Không unlock tournamentDataLocked ở đây, để nó tự unlock theo thời gian
  await syncClockFromData();
  // Tính lại showPayout mỗi lần fetch
  const lvs=clockState.levels||[];
  let realLevel=0;
  for(let i=0;i<=clockState.levelIndex;i++) if(!lvs[i]?.isBreak) realLevel++;
  clockState.showPayout=(realLevel>=11);
  // Tính payout nếu đạt level 11 và có prizePool
  if(clockState.showPayout&&(clockState.prizePool||0)>0){
    clockState.payout=calculatePayout();
  } else {
    clockState.payout=null;
  }
  res.json(clockState);
});

// Tự sync mỗi 2 giây
setInterval(syncClockFromData, 2000);

app.post('/api/clock',(req,res)=>{
  const {action,...data}=req.body;
  if(action==='start'){
    clockState.running=true;
    if(!clockTimer) clockTimer=setInterval(tickClock,1000);
  } else if(action==='pause'){
    clockState.running=false;
  } else if(action==='next'){
    if(clockState.levelIndex<clockState.levels.length-1){
      clockState.levelIndex++;
      clockState.timeLeft=(clockState.levels[clockState.levelIndex].duration||20)*60;
    }
  } else if(action==='prev'){
    if(clockState.levelIndex>0){
      clockState.levelIndex--;
      clockState.timeLeft=(clockState.levels[clockState.levelIndex].duration||20)*60;
    }
  } else if(action==='addTime'){
    clockState.timeLeft=Math.max(0,clockState.timeLeft+(data.seconds||60));
  } else if(action==='update'){
    Object.assign(clockState,data);
    if(clockState.running&&!clockTimer) clockTimer=setInterval(tickClock,1000);
    if(!clockState.running&&clockTimer){clearInterval(clockTimer);clockTimer=null;}
  }
  clockState.updatedAt=Date.now();
  res.json(clockState);
});

// Reset Clock State (for new day or manual reset)
app.post('/api/clock/reset', async (req, res) => {
  console.log('🔄 Manual reset clock triggered');
  const today = new Date().toISOString().slice(0, 10);

  // Xóa tournament data từ database
  try {
    const r1 = await db.prepare('DELETE FROM tournament_buyin WHERE date=?').run(today);
    console.log(`  - Xóa ${r1.changes} record từ tournament_buyin`);

    const r2 = await db.prepare(`DELETE FROM transactions WHERE substr(created_at,1,10)=? AND (
      table_name LIKE 'Tour%' OR table_name LIKE 'tour%' OR
      note LIKE '%TIEN_MAT_TOUR%' OR note LIKE '%[TOUR]%'
    )`).run(today);
    console.log(`  - Xóa ${r2.changes} record từ transactions`);
  } catch(e) {
    console.error('[RESET] Lỗi xóa dữ liệu:', e.message);
  }

  resetClockState();

  // Reset toàn bộ thông tin giải đấu về 0
  clockState.buyIn = 0;
  clockState.rebuy = 0;
  clockState.players = 0;
  clockState.totalPlayers = 0;
  clockState.totalStack = 0;
  clockState.prizePool = 0;
  clockState.payout = null;
  clockState.showPayout = false;
  clockState.lateReg = '–';
  clockState.updatedAt = Date.now();

  // Xóa hàng chờ khách (queueTour)
  if(tableState && tableState.queueTour) {
    tableState.queueTour = [];
    saveTableStateFile();
    console.log('  - Xóa queueTour');
  }

  console.log('✅ Đã reset giải đấu - xóa hết dữ liệu');
  res.json(clockState);
});

// PWA manifest
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
app.get('/report-manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report-manifest.json'));
});

// ── MÁY IN KV804 USB ─────────────────────────────────────────
// Cài bằng: npm install escpos escpos-usb
let escpos, USB;
try {
  escpos = require('escpos');
  USB    = require('escpos-usb');
  escpos.USB = USB;
  console.log('✅ Thư viện máy in đã sẵn sàng');
} catch(e) {
  console.warn('⚠️  Chưa cài escpos — chạy: npm install escpos escpos-usb');
}

function fmtVND(n){ return Number(n).toLocaleString('vi') + ' d'; }
function center(str, width){
  const pad = Math.max(0, Math.floor((width - str.length) / 2));
  return ' '.repeat(pad) + str;
}
function line(char='=', width=32){ return char.repeat(width); }

async function printBillUSB(order){
  if(!escpos || !USB){
    console.warn('[PRINT] Bỏ qua — thư viện chưa cài');
    return;
  }

  let device;
  try {
    // Tìm máy in USB — KV804 thường là vendor 0x0fe6 hoặc tự detect
    const devices = USB.findPrinter();
    if(!devices || devices.length === 0){
      console.warn('[PRINT] Không tìm thấy máy in USB');
      return;
    }
    device = new escpos.USB(devices[0]);
  } catch(e){
    console.error('[PRINT] Lỗi tìm máy in:', e.message);
    return;
  }

  const now   = new Date();
  const time  = now.toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'});
  const date  = now.toLocaleDateString('vi',{day:'2-digit',month:'2-digit',year:'numeric'});

  // Parse note để lấy tên nước
  const noteStr  = order.note || '';
  const drinkMatch = noteStr.match(/Nuoc:\s*([^+\n]+)/i);
  const drinkName  = drinkMatch ? drinkMatch[1].trim() : '—';

  // Tính tiền phiên (tổng - nước)
  // Lưu trong note dạng "Phien 65000 + Nuoc: ..."
  const phienMatch = noteStr.match(/Phien\s*([\d.]+)/i);
  const phienAmt   = phienMatch ? parseInt(phienMatch[1].replace(/\./g,'')) : order.amount;
  const drinkAmt   = order.amount - phienAmt;

  return new Promise((resolve) => {
    device.open(function(err){
      if(err){
        console.error('[PRINT] Không mở được máy in:', err.message);
        return resolve();
      }

      const printer = new escpos.Printer(device);

      printer
        .font('A')
        .align('CT')
        .style('B')
        .size(1, 1)
        .text('GOLDEN COFFEE')
        .style('NORMAL')
        .size(0, 0)
        .text('♠  BOARD GAME  ♠')
        .text(line('='))
        .align('LT')
        .text(`Khach:    ${order.payer}`)
        .text(`Thoi gian: ${time} - ${date}`)
        .text(line('-'))
        .text(`Phien choi:  ${fmtVND(phienAmt)}`)
        .text(`Nuoc (${drinkName}): ${fmtVND(drinkAmt > 0 ? drinkAmt : 0)}`)
        .text(line('-'))
        .style('B')
        .text(`TONG CONG:   ${fmtVND(order.amount)}`)
        .style('NORMAL')
        .text(line('='))
        .align('CT')
        .text('Cam on! Hen gap lai! ♠')
        .text(' ')
        .text(' ')
        .cut()
        .close(resolve);
    });
  }).catch(e => console.error('[PRINT] Lỗi in:', e.message));
}

// ⚠️ Chức năng in đã được xóa — máy in KV804 sẽ được xử lý riêng

// ── TRẠNG THÁI MÀN HÌNH PHỤ ─────────────────────────────────
let displayState = {
  mode    : 'idle',   // 'idle' | 'qr' | 'success'
  qrUrl   : '',
  amount  : 0,
  payer   : '',
  drink   : '',
  updatedAt: Date.now()
};

// Trang màn hình phụ cho khách
app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

// Nhân viên cập nhật trạng thái màn hình phụ
app.post('/api/display', (req, res) => {
  displayState = { ...displayState, ...req.body, updatedAt: Date.now() };
  res.json({ ok: true });
});

// Màn hình phụ polling lấy trạng thái
app.get('/api/display', (req, res) => {
  res.json(displayState);
});

// CUSTOMERS
app.get('/api/customers', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM customers').all());
});

app.post('/api/customers', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Tên không hợp lệ' });
  }
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'SĐT phải 10 chữ số' });
  }
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const pwd = (typeof req.body.password === 'string' && req.body.password) ? req.body.password : '';
    const isAdmin = req.body.is_admin === true;
    const r = await db.prepare('INSERT INTO customers (name,phone,password,is_admin,top1,top2,top3,rounds,drinks,created_at,last_top_increase) VALUES (?,?,?,?,0,0,0,0,0,?,?) RETURNING id').run(name.trim(), phone, pwd, isAdmin, now, now);
    res.json({ id: r.lastInsertRowid, name: name.trim(), phone, password: pwd, is_admin: isAdmin, top1:0, top2:0, top3:0, rounds:0, drinks:0 });
  } catch(e) {
    res.status(400).json({ error: 'SĐT hoặc tên đã tồn tại' });
  }
});

app.put('/api/customers/:phone', async (req, res) => {
  const { top1, top2, top3, rounds, drinks } = req.body;
  const old = await db.prepare('SELECT top1,top2,top3,rounds,drinks FROM customers WHERE phone=?').get(req.params.phone);
  // "Hoạt động" = tăng top HOẶC tăng round HOẶC tăng nước
  const activityIncreased = old && (
    top1 > (old.top1 || 0) || top2 > (old.top2 || 0) || top3 > (old.top3 || 0) ||
    rounds > (old.rounds || 0) || drinks > (old.drinks || 0)
  );
  const now = activityIncreased ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;

  if(activityIncreased){
    // last_top_increase giờ là "lần cuối có hoạt động" (top/round/nước)
    await db.prepare('UPDATE customers SET top1=?,top2=?,top3=?,rounds=?,drinks=?,last_top_increase=? WHERE phone=?')
      .run(top1, top2, top3, rounds, drinks, now, req.params.phone);
  } else {
    await db.prepare('UPDATE customers SET top1=?,top2=?,top3=?,rounds=?,drinks=? WHERE phone=?')
      .run(top1, top2, top3, rounds, drinks, req.params.phone);
  }
  res.json({ ok: true });
});

app.delete('/api/customers/:phone', async (req, res) => {
  await db.prepare('DELETE FROM customers WHERE phone=?').run(req.params.phone);
  res.json({ ok: true });
});

// Auto-cleanup: xóa khách 3 tháng KHÔNG có hoạt động nào (không top, không round, không nước)
app.post('/api/customers/cleanup', async (req, res) => {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const dateStr = threeMonthsAgo.toISOString().slice(0, 19).replace('T', ' ');

  // last_top_increase = lần cuối có hoạt động (top/round/nước). Quá 3 tháng -> xóa.
  const oldCustomers = await db.prepare(
    `SELECT phone FROM customers WHERE last_top_increase < ?`
  ).all(dateStr);

  let deleted = 0;
  for (const c of oldCustomers) {
    await db.prepare('DELETE FROM customers WHERE phone=?').run(c.phone);
    deleted++;
  }

  console.log(`[CLEANUP] Xóa ${deleted} khách 3 tháng không hoạt động (top/round/nước)`);
  res.json({ deleted });
});

// ── APP KHÁCH HÀNG: đăng nhập + quản lý tài khoản ────────────────
// Chuẩn hoá dữ liệu khách trả về cho app (tính bounty, ẩn mật khẩu)
function shapeCustomer(c) {
  const top1 = Number(c.top1) || 0;
  const top2 = Number(c.top2) || 0;
  const top3 = Number(c.top3) || 0;
  return {
    name: c.name,
    phone: c.phone,
    is_admin: c.is_admin === true || c.is_admin === 't' || c.is_admin === 1,
    bounty: top1 * 30 + top2 * 20 + top3 * 10,
    top1, top2, top3,
    rounds: Number(c.rounds) || 0,
    drinks: Number(c.drinks) || 0,
  };
}

// Đăng nhập khách: POST /api/customer/login { phone, password }
app.post('/api/customer/login', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const password = String(req.body.password || '');
  if (!phone || !password) return res.json({ ok: false, error: 'Thiếu SĐT hoặc mật khẩu' });
  try {
    const c = await db.prepare('SELECT * FROM customers WHERE phone=? AND password=? LIMIT 1').get(phone, password);
    if (!c) return res.json({ ok: false, error: 'SĐT hoặc mật khẩu không đúng' });
    res.json({ ok: true, customer: shapeCustomer(c) });
  } catch (e) {
    res.json({ ok: false, error: 'Lỗi hệ thống' });
  }
});

// Lấy thông tin 1 khách (cho app làm mới khi mở lại): GET /api/customer/:phone
app.get('/api/customer/:phone', async (req, res) => {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  const c = await db.prepare('SELECT * FROM customers WHERE phone=? LIMIT 1').get(phone);
  if (!c) return res.status(404).json({ error: 'Không tìm thấy khách' });
  res.json(shapeCustomer(c));
});

// Danh sách khách cho app admin (không trả mật khẩu): GET /api/customers/app-list
app.get('/api/customers/app-list', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM customers ORDER BY name').all();
  res.json(rows.map(shapeCustomer));
});

// Khách tự đổi mật khẩu: POST /api/customer/change-password { phone, oldPassword, newPassword }
app.post('/api/customer/change-password', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const oldP = String(req.body.oldPassword || '');
  const newP = String(req.body.newPassword || '');
  if (!phone || !newP) return res.json({ ok: false, error: 'Thiếu thông tin' });
  const c = await db.prepare('SELECT * FROM customers WHERE phone=? AND password=?').get(phone, oldP);
  if (!c) return res.json({ ok: false, error: 'Mật khẩu cũ không đúng' });
  await db.prepare('UPDATE customers SET password=? WHERE phone=?').run(newP, phone);
  res.json({ ok: true });
});

// Admin sửa hồ sơ khách (tên / mật khẩu / quyền admin):
// PUT /api/customers/:phone/profile { name, password, is_admin }
app.put('/api/customers/:phone/profile', async (req, res) => {
  const { name, password, is_admin } = req.body;
  const c = await db.prepare('SELECT * FROM customers WHERE phone=?').get(req.params.phone);
  if (!c) return res.status(404).json({ error: 'Không tìm thấy khách' });
  const newName = (typeof name === 'string' && name.trim()) ? name.trim() : c.name;
  // Có gửi 'password' (kể cả chuỗi rỗng để xoá) -> dùng; không gửi -> giữ nguyên
  const newPwd = (password !== undefined && password !== null) ? String(password) : c.password;
  const newAdmin = (typeof is_admin === 'boolean') ? is_admin : c.is_admin;
  await db.prepare('UPDATE customers SET name=?, password=?, is_admin=? WHERE phone=?')
    .run(newName, newPwd, newAdmin, req.params.phone);
  res.json({ ok: true });
});

// ── BOUNTY API (cho Discord bot tra cứu theo SĐT) ───────────────
// Bot gọi: GET /api/bounty?sdt=0901234567  (kèm header x-api-key)
// Bounty = top1*30 + top2*20 + top3*10
const BOUNTY_API_KEY = process.env.BOUNTY_API_KEY || '';
app.get('/api/bounty', async (req, res) => {
  // 1) Bảo mật: chỉ ai có đúng khóa bí mật (bot của bạn) mới gọi được
  if (!BOUNTY_API_KEY || req.get('x-api-key') !== BOUNTY_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2) Lấy SĐT, bỏ ký tự không phải số
  const sdt = String(req.query.sdt || '').replace(/\D/g, '');
  if (!sdt) {
    return res.status(400).json({ error: 'missing sdt' });
  }

  try {
    // 3) Tra database (PostgreSQL) theo cột phone
    const c = await db.prepare(
      'SELECT name, top1, top2, top3, rounds, drinks FROM customers WHERE phone = ? LIMIT 1'
    ).get(sdt);

    if (!c) {
      return res.json({ found: false });
    }

    // 4) Tính bounty từ top
    const top1 = Number(c.top1) || 0;
    const top2 = Number(c.top2) || 0;
    const top3 = Number(c.top3) || 0;
    const bounty = top1 * 30 + top2 * 20 + top3 * 10;

    // 5) Trả kết quả cho bot
    return res.json({
      found: true,
      sdt: sdt,
      ten: c.name,
      bounty: bounty,
      top1: top1,
      top2: top2,
      top3: top3,
      rounds: Number(c.rounds) || 0,
      drinks: Number(c.drinks) || 0,
    });
  } catch (err) {
    console.error('Loi /api/bounty:', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// TRANSACTIONS
app.get('/api/transactions', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 500').all());
});

app.post('/api/transactions', async (req, res) => {
  const { payer, phone, amount, table_name, note } = req.body;
  // Chống lưu trùng: kiểm tra giao dịch tương tự trong vòng 10 giây
  const cutoff = new Date(Date.now() - 10000).toISOString().slice(0, 19).replace('T', ' ');
  const recent = await db.prepare(
    `SELECT id FROM transactions WHERE payer=? AND amount=? AND created_at >= ?`
  ).get(payer, amount, cutoff);
  if(recent){
    console.log(`[TX] Bỏ qua trùng lặp — ${payer} ${amount}đ`);
    return res.json({ id: recent.id, duplicate: true });
  }
  const r = await db.prepare('INSERT INTO transactions (payer,phone,amount,table_name,note) VALUES (?,?,?,?,?) RETURNING id')
    .run(payer, phone, amount, table_name, note);
  res.json({ id: r.lastInsertRowid });
});

// STOCK
app.get('/api/stock', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM stock').all());
});

app.post('/api/stock', async (req, res) => {
  const { name, qty, price, cost } = req.body;
  await db.prepare(`INSERT INTO stock (name,qty,price,cost) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET qty=stock.qty+excluded.qty, price=excluded.price, cost=excluded.cost`)
    .run(name, qty, price || 0, cost || 1);
  res.json(await db.prepare('SELECT * FROM stock WHERE name=?').get(name));
});

app.delete('/api/stock/:name', async (req, res) => {
  await db.prepare('DELETE FROM stock WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});

app.put('/api/stock/:name/use', async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const name = req.params.name;
  await db.prepare('UPDATE stock SET qty=GREATEST(0,qty-1), consumed=consumed+1 WHERE name=?').run(name);
  // Lưu tiêu thụ theo ngày riêng
  await db.prepare(`INSERT INTO daily_consumed (name,date,qty) VALUES (?,?,1)
    ON CONFLICT(name,date) DO UPDATE SET qty=daily_consumed.qty+1`).run(name, today);
  res.json({ ok: true });
});

// Tiêu thụ hôm nay từ database
app.get('/api/stock-daily', async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  try {
    const rows = await db.prepare(`
      SELECT dc.name, dc.qty, s.price
      FROM daily_consumed dc
      LEFT JOIN stock s ON s.name=dc.name
      WHERE dc.date=?
    `).all(today);
    res.json(rows);
  } catch(e) {
    res.json([]);
  }
});

// ── MỞ KHAY TIỀN KV405 ───────────────────────────────────────
// ── TRẠNG THÁI BÀN (persist qua restart) ─────────────────────
const TABLE_STATE_FILE = './table-state.json';
let tableState = null;

// Load từ file khi khởi động
try {
  const raw = require('fs').readFileSync(TABLE_STATE_FILE, 'utf8');
  tableState = JSON.parse(raw);
  console.log('[TABLE] Khôi phục table state từ file');
} catch(e) { tableState = null; }

// Khởi tạo table state mặc định nếu chưa có
if (!tableState) {
  tableState = {
    tablesNormal: [
      { id: 1, name: 'Bàn 1', status: 'idle', seats: [null, null, null, null, null, null, null, null, null], started: null, type: 'normal' },
      { id: 2, name: 'Bàn 2', status: 'idle', seats: [null, null, null, null, null, null, null, null, null], started: null, type: 'normal' },
      { id: 3, name: 'Bàn 3', status: 'idle', seats: [null, null, null, null, null, null, null, null, null], started: null, type: 'normal' }
    ],
    tablesTour: [
      { id: 4, name: 'Tour 1', status: 'idle', seats: [null, null, null, null, null, null, null, null, null], started: null, type: 'tour' },
      { id: 5, name: 'Tour 2', status: 'idle', seats: [null, null, null, null, null, null, null, null, null], started: null, type: 'tour' },
      { id: 6, name: 'Tour 3', status: 'idle', seats: [null, null, null, null, null, null, null, null, null], started: null, type: 'tour' }
    ],
    queue: [],
    queueTour: [],
    floorStaffHistory: [],
    floorStaffActive: null,
    lastFloorActivity: null,
    updatedAt: Date.now()
  };
  saveTableStateFile();
  console.log('[TABLE] Khởi tạo table state mặc định');
}

function saveTableStateFile() {
  try { require('fs').writeFileSync(TABLE_STATE_FILE, JSON.stringify(tableState)); } catch(e) {}
}

app.post('/api/table-state', (req, res) => {
  tableState = req.body;
  saveTableStateFile();
  res.json({ ok: true });
});

app.get('/api/table-state', (req, res) => {
  // Chỉ trả về trạng thái bàn + queueTour (queue reset mỗi lần load)
  if(!tableState) return res.json(null);

  // Kiểm tra nếu floor staff không hoạt động trong 5 phút, coi như logout
  if(tableState.floorStaffActive && tableState.lastFloorActivity){
    const now = Date.now();
    const inactiveTime = (now - tableState.lastFloorActivity) / 1000 / 60; // minutes
    if(inactiveTime > 5){
      tableState.floorStaffActive = null;
      tableState.lastFloorActivity = null;
      saveTableStateFile();
    }
  }

  res.json({
    tablesNormal: tableState.tablesNormal || [],
    tablesTour: tableState.tablesTour || [],
    activeTab: tableState.activeTab || 'normal',
    queueTour: tableState.queueTour || [],
    floorStaffHistory: tableState.floorStaffHistory || [],
    floorStaffActive: tableState.floorStaffActive,
    updatedAt: tableState.updatedAt
  });
});

// ── STAFF MANAGEMENT ───────────────────────────────────────────
// Get all staff members
app.get('/api/staff', async (req, res) => {
  try {
    const staff = await db.prepare('SELECT name FROM staff_members ORDER BY name').all();
    res.json(staff);
  } catch(e) {
    res.json([]);
  }
});

// Add new staff member
app.post('/api/staff', async (req, res) => {
  const { name, password } = req.body;
  if(!name || !password) return res.json({ ok: false, error: 'Thiếu tên hoặc mật khẩu' });

  try {
    await db.prepare('INSERT INTO staff_members (name, password) VALUES (?, ?)').run(name, password);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: 'Nhân viên đã tồn tại' });
  }
});

// Delete staff member
app.delete('/api/staff/:name', async (req, res) => {
  const { name } = req.params;
  try {
    await db.prepare('DELETE FROM staff_members WHERE name = ?').run(decodeURIComponent(name));
    // Also remove from active sessions
    delete activeSessions[decodeURIComponent(name)];
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false });
  }
});

// Staff login
app.post('/api/staff/login', async (req, res) => {
  const { name, password, app } = req.body;
  if(!name || !password || !app) return res.json({ ok: false });

  try {
    const staff = await db.prepare('SELECT * FROM staff_members WHERE name = ? AND password = ?').get(name, password);
    if(!staff) return res.json({ ok: false, error: 'Tên hoặc mật khẩu sai' });

    // Generate unique session ID
    const sessionId = `${name}_${app}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Record login in database
    await db.prepare('INSERT INTO staff_sessions (staff_name, app_name, login_time) VALUES (?, ?, CURRENT_TIMESTAMP)').run(name, app);

    // Track session in memory - support multiple concurrent sessions
    if (!activeSessions[name]) activeSessions[name] = [];
    activeSessions[name].push({
      sessionId: sessionId,
      app: app,
      loginTime: Date.now(),
      lastSeen: Date.now()
    });

    res.json({ ok: true, staffName: name, sessionId: sessionId });
  } catch(e) {
    res.json({ ok: false, error: 'Lỗi hệ thống' });
  }
});

// Staff logout
app.post('/api/staff/logout', async (req, res) => {
  const { name, sessionId } = req.body;
  if(!name) return res.json({ ok: false });

  try {
    // Record logout in database
    await db.prepare('UPDATE staff_sessions SET logout_time = CURRENT_TIMESTAMP WHERE staff_name = ? AND logout_time IS NULL').run(name);

    // Remove specific session from active sessions
    if (activeSessions[name]) {
      if (sessionId) {
        // Remove only this session
        activeSessions[name] = activeSessions[name].filter(s => s.sessionId !== sessionId);
      }
      // If no sessions left for this staff, remove them
      if (activeSessions[name].length === 0) {
        delete activeSessions[name];
      }
    }

    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false });
  }
});

// Heartbeat: app gọi định kỳ để báo còn đang dùng (chống phiên "ghost")
app.post('/api/staff/heartbeat', (req, res) => {
  const { name, sessionId } = req.body;
  if (!name || !sessionId) return res.json({ ok: false });
  const sessions = activeSessions[name];
  if (Array.isArray(sessions)) {
    const s = sessions.find(x => x.sessionId === sessionId);
    if (s) s.lastSeen = Date.now();
  }
  res.json({ ok: true });
});

// Tự xóa phiên "ghost": nhân viên đóng app mà không bấm Thoát -> sau 5 phút
// không có heartbeat thì coi như offline và xóa khỏi danh sách đang online.
const GHOST_TIMEOUT_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  Object.keys(activeSessions).forEach(name => {
    activeSessions[name] = (activeSessions[name] || []).filter(
      s => now - (s.lastSeen || s.loginTime || 0) <= GHOST_TIMEOUT_MS
    );
    if (activeSessions[name].length === 0) delete activeSessions[name];
  });
}, 60 * 1000);

// Get active staff sessions
app.get('/api/staff/active', (req, res) => {
  try {
    const active = [];

    // Iterate through all active sessions
    Object.keys(activeSessions).forEach(staffName => {
      const sessions = activeSessions[staffName];
      if (Array.isArray(sessions)) {
        sessions.forEach(session => {
          active.push({
            name: staffName,
            app: session.app,
            loginTime: session.loginTime,
            sessionId: session.sessionId
          });
        });
      }
    });

    res.json(active);
  } catch(e) {
    res.json([]);
  }
});

// ── DEALER CONFIG ─────────────────────────────────────────────
let dealerConfig = {
  'Dealer 1': [1, 4],  // Bàn 1 (thường) + Tour 1
  'Dealer 2': [2, 5],  // Bàn 2 (thường) + Tour 2
  'Dealer 3': [3, 6],  // Bàn 3 (thường) + Tour 3
};

app.get('/api/dealers', (req, res) => {
  res.json(Object.keys(dealerConfig).map(name => ({
    name,
    tables: dealerConfig[name]
  })));
});

app.get('/api/dealers/:name/tables', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const tables = dealerConfig[name] || [];
  res.json({ name, tables });
});

// Dealer cập nhật ghế (out/vào bàn) → cập nhật table-state
app.post('/api/dealer/seat', (req, res) => {
  const { tableId, seatIndex, playerName } = req.body;
  if(!tableState) return res.status(400).json({ error: 'Chưa có table state' });
  const allTables = [...(tableState.tablesNormal||[]), ...(tableState.tablesTour||[])];
  const t = allTables.find(x => x.id === tableId);
  if(!t) return res.status(404).json({ error: 'Không tìm thấy bàn' });
  t.seats[seatIndex] = playerName || '';
  tableState.updatedAt = Date.now();
  console.log(`[DEALER] Bàn ${tableId} ghế ${seatIndex+1}: "${playerName||'(trống)'}" `);
  res.json({ ok: true });
});


// Xóa 1 giao dịch theo ID (chỉ dùng cho tiền mặt tour)
app.delete('/api/transactions/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const tx = await db.prepare('SELECT note FROM transactions WHERE id=?').get(id);
  if(!tx){ return res.status(404).json({ok:false,error:'Không tìm thấy'}); }
  // Chỉ cho xóa giao dịch tiền mặt tour
  if(!(tx.note||'').includes('[TIEN_MAT_TOUR]')){
    return res.status(403).json({ok:false,error:'Chỉ xóa được giao dịch tiền mặt tour'});
  }
  await db.prepare('DELETE FROM transactions WHERE id=?').run(id);
  res.json({ok:true});
});

app.delete('/api/transactions/day/:date', async (req, res) => {
  const date = req.params.date;
  const r = await db.prepare(`DELETE FROM transactions WHERE substr(created_at,1,10)=?`).run(date);
  // Xóa tiêu thụ kho ngày đó luôn
  try { await db.prepare(`DELETE FROM daily_consumed WHERE date=?`).run(date); } catch(e){}
  console.log(`[RESET] Xóa ${r.changes} giao dịch ngày ${date}`);
  res.json({ ok: true, deleted: r.changes });
});

app.delete('/api/transactions/month/:month', async (req, res) => {
  const month = req.params.month;
  const r = await db.prepare(`DELETE FROM transactions WHERE substr(created_at,1,7)=?`).run(month);
  console.log(`[RESET] Xóa ${r.changes} giao dịch tháng ${month}`);
  res.json({ ok: true, deleted: r.changes });
});

// ── TOURNAMENT BUY-IN TRACKING ──────────────────────────────────
// Record buy-in/re-buy
app.post('/api/tournament/buyin', async (req, res) => {
  const { customerPhone, customerName, isRebuy } = req.body;
  const today = new Date().toISOString().split('T')[0];
  try {
    await db.prepare(`INSERT INTO tournament_buyin (customer_phone, customer_name, date, is_rebuy)
               VALUES (?, ?, ?, ?)`).run(customerPhone, customerName, today, isRebuy ? 1 : 0);
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Check if customer has tournament_buyin entry for a date
app.get('/api/tournament-buyin-check', async (req, res) => {
  const { phone, date } = req.query;
  if (!phone || !date) {
    return res.json({ count: 0 });
  }
  try {
    const result = await db.prepare(
      `SELECT COUNT(*) as cnt FROM tournament_buyin WHERE customer_phone=? AND date=?`
    ).get(phone, date);
    res.json({ count: Number(result?.cnt) || 0 });
  } catch(e) {
    res.json({ count: 0 });
  }
});

// Get today's tournament stats
app.get('/api/tournament/stats', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const buyIns = Number((await db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=0`)
    .get(today))?.cnt) || 0;
  const reBuys = Number((await db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=1`)
    .get(today))?.cnt) || 0;

  // Get current players on tour tables
  const playersOnTables = tableState?.tablesTour?.reduce((sum, t) =>
    sum + t.seats.filter(s => s).length, 0) || 0;

  res.json({ buyIns, reBuys, playersOnTables, totalPlayers: buyIns + reBuys });
});

// Upload ảnh nền cho clock
const multer = require('multer');
const uploadStorage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, path.join(__dirname,'public','uploads')),
  filename: (req,file,cb) => cb(null,'bg-'+Date.now()+path.extname(file.originalname))
});
const upload = multer({storage:uploadStorage, limits:{fileSize:10*1024*1024}});
// Tạo thư mục uploads nếu chưa có
const fs = require('fs');
const uploadDir = path.join(__dirname,'public','uploads');
if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir,{recursive:true});

app.post('/api/upload-bg', upload.single('image'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  const url='/uploads/'+req.file.filename;
  clockState.bgImage=url;
  clockState.updatedAt=Date.now();
  res.json({ok:true, url});
});

// ── PRINT SERVER ──────────────────────────────────────────

app.post('/api/print', (req, res) => {
  const { billData } = req.body;
  if (!billData) {
    return res.status(400).json({ ok: false, error: 'Thiếu dữ liệu bill' });
  }

  try {
    // Kiểm tra máy in USB
    const devices = USB.getDeviceList();
    if (devices.length === 0) {
      return res.status(400).json({ ok: false, error: 'Không tìm thấy máy in USB' });
    }

    const device = new USB.Device(devices[0]);
    const printer = new escpos.Printer(device);

    device.open(function() {
      printer
        .font('a')
        .align('ct')
        .style('b')
        .size(1, 1)
        .text('HOÁ ĐƠN')
        .text('GOLDEN COFFEE')
        .style('normal')
        .size(0, 0)
        .text('─'.repeat(32))
        .align('lt')
        .text('Khách: ' + (billData.customer || 'Khách lẻ'))
        .text('Bàn: ' + (billData.table || '–'))
        .text('─'.repeat(32));

      // In các mặt hàng
      if (billData.items && billData.items.length) {
        billData.items.forEach(item => {
          const line = (item.name || '').padEnd(20) + (item.price || 0).toString().padStart(10);
          printer.text(line);
        });
        printer.text('─'.repeat(32));
      }

      // Tổng tiền
      printer
        .align('rt')
        .style('b')
        .text('Tổng: ' + (billData.total || 0) + ' ₫')
        .style('normal')
        .text('─'.repeat(32))
        .align('ct')
        .text(new Date().toLocaleString('vi-VN'))
        .feed(3)
        .cut()
        .close(function() {
          console.log('✅ In xong!');
          res.json({ ok: true, message: 'In thành công!' });
        });
    });
  } catch(err) {
    console.error('❌ Lỗi in:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Schedule auto-reset hàng ngày lúc 23h59p
scheduleNextReset();

// Static files - after all API routes to prevent shadowing
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server dang chay tai cong ' + PORT);
  console.log('✓ All routes configured: /dealer, /floor, /report, /clock, /clock-control');
  // Khởi động 2 bot Discord (nếu có token)
  startDiscordBot();
  // Giữ server thức để bot luôn online (chỉ chạy trên Render)
  startKeepAlive();
});

// ── KEEP-ALIVE ──────────────────────────────────────────────
// Tự ping chính mình định kỳ để Render free không cho server "ngủ".
// Render tự cấp biến RENDER_EXTERNAL_URL = URL công khai của web.
// Mặc định 10 phút (đủ vì Render chỉ ngủ sau 15 phút). Đổi qua KEEPALIVE_SECONDS.
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) {
    console.log('[KEEPALIVE] Không có RENDER_EXTERNAL_URL (chạy local) — bỏ qua.');
    return;
  }
  const seconds = Math.max(60, Number(process.env.KEEPALIVE_SECONDS) || 600);
  console.log(`[KEEPALIVE] Tự ping ${url}/healthz mỗi ${seconds}s để giữ server thức.`);
  setInterval(async () => {
    try {
      await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(20000) });
    } catch (e) {
      console.error('[KEEPALIVE] Ping lỗi:', e.message);
    }
  }, seconds * 1000);
}
