const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

// Tạo bảng daily_consumed nếu chưa có
db.prepare(`CREATE TABLE IF NOT EXISTS daily_consumed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  qty INTEGER DEFAULT 1,
  UNIQUE(name,date)
)`).run();

// Thêm cột cost nếu chưa có (migration)
try { db.prepare('ALTER TABLE stock ADD COLUMN cost INTEGER DEFAULT 1').run(); } catch(e) {}

// Trang dealer
app.get('/dealer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dealer.html'));
});
app.get('/dealer-tour', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dealer-tour.html'));
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

// Static files - after route handlers
app.use(express.static('public'));

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
function syncClockFromData(){
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
    const buyInCount=db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=0`).get(today)?.cnt||0;
    const rebuyCount=db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=1`).get(today)?.cnt||0;

    clockState.buyIn=buyInCount;
    clockState.rebuy=rebuyCount;
    clockState.totalPlayers=buyInCount+rebuyCount;
    clockState.totalStack=(clockState.startingStack||0)*buyInCount+(clockState.rebuyStack||0)*rebuyCount;

    // Không reset prizePool nếu đã được set bởi người dùng ở clock-control
    // Chỉ update nếu prizePool = 0 (chưa nhập)
    if(!clockState.prizePool){
      const filter=`(table_name LIKE 'Tour%' OR table_name LIKE 'tour%' OR note LIKE '%TIEN_MAT_TOUR%' OR note LIKE '%[TOUR]%') AND note NOT LIKE '%[NOPLAY]%'`;
      const prizeRow=db.prepare(`SELECT SUM(amount) as total FROM transactions WHERE date(created_at)=? AND ${filter} AND amount>0`).get(today);
      clockState.prizePool=prizeRow?.total||0;
    }

    clockState.updatedAt=Date.now();
  }catch(e){ console.log('[CLOCK SYNC ERR]',e.message); }
}

app.get('/api/clock',(req,res)=>{
  // Không unlock tournamentDataLocked ở đây, để nó tự unlock theo thời gian
  syncClockFromData();
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
app.post('/api/clock/reset', (req, res) => {
  console.log('🔄 Manual reset clock triggered');
  const today = new Date().toISOString().slice(0, 10);

  // Xóa tournament data từ database
  try {
    const r1 = db.prepare('DELETE FROM tournament_buyin WHERE date=?').run(today);
    console.log(`  - Xóa ${r1.changes} record từ tournament_buyin`);

    const r2 = db.prepare(`DELETE FROM transactions WHERE date(created_at)=? AND (
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

// PWA Manifest cho báo cáo
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
app.get('/api/customers', (req, res) => {
  res.json(db.prepare('SELECT * FROM customers').all());
});

app.post('/api/customers', (req, res) => {
  const { name, phone } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Tên không hợp lệ' });
  }
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'SĐT phải 10 chữ số' });
  }
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const r = db.prepare('INSERT INTO customers (name,phone,top1,top2,top3,rounds,drinks,created_at,last_top_increase) VALUES (?,?,0,0,0,0,0,?,?)').run(name.trim(), phone, now, now);
    res.json({ id: r.lastInsertRowid, name: name.trim(), phone, top1:0, top2:0, top3:0, rounds:0, drinks:0 });
  } catch(e) {
    res.status(400).json({ error: 'SĐT hoặc tên đã tồn tại' });
  }
});

app.put('/api/customers/:phone', (req, res) => {
  const { top1, top2, top3, rounds, drinks } = req.body;
  const old = db.prepare('SELECT top1,top2,top3 FROM customers WHERE phone=?').get(req.params.phone);
  const topIncreased = old && (top1 > (old.top1 || 0) || top2 > (old.top2 || 0) || top3 > (old.top3 || 0));
  const now = topIncreased ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;

  if(topIncreased){
    db.prepare('UPDATE customers SET top1=?,top2=?,top3=?,rounds=?,drinks=?,last_top_increase=? WHERE phone=?')
      .run(top1, top2, top3, rounds, drinks, now, req.params.phone);
  } else {
    db.prepare('UPDATE customers SET top1=?,top2=?,top3=?,rounds=?,drinks=? WHERE phone=?')
      .run(top1, top2, top3, rounds, drinks, req.params.phone);
  }
  res.json({ ok: true });
});

app.delete('/api/customers/:phone', (req, res) => {
  db.prepare('DELETE FROM customers WHERE phone=?').run(req.params.phone);
  res.json({ ok: true });
});

// Auto-cleanup: xóa khách hàng 3 tháng ko tăng top
app.post('/api/customers/cleanup', (req, res) => {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const dateStr = threeMonthsAgo.toISOString().slice(0, 19).replace('T', ' ');

  const oldCustomers = db.prepare(
    `SELECT phone FROM customers WHERE last_top_increase < ?`
  ).all(dateStr);

  let deleted = 0;
  oldCustomers.forEach(c => {
    db.prepare('DELETE FROM customers WHERE phone=?').run(c.phone);
    deleted++;
  });

  console.log(`[CLEANUP] Xóa ${deleted} khách hàng 3 tháng không tăng top`);
  res.json({ deleted });
});

// TRANSACTIONS
app.get('/api/transactions', (req, res) => {
  res.json(db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 500').all());
});

app.post('/api/transactions', (req, res) => {
  const { payer, phone, amount, table_name, note } = req.body;
  // Chống lưu trùng: kiểm tra giao dịch tương tự trong vòng 10 giây
  const recent = db.prepare(
    `SELECT id FROM transactions WHERE payer=? AND amount=? AND created_at >= datetime('now','-10 seconds','localtime')`
  ).get(payer, amount);
  if(recent){
    console.log(`[TX] Bỏ qua trùng lặp — ${payer} ${amount}đ`);
    return res.json({ id: recent.id, duplicate: true });
  }
  const r = db.prepare('INSERT INTO transactions (payer,phone,amount,table_name,note) VALUES (?,?,?,?,?)')
    .run(payer, phone, amount, table_name, note);
  res.json({ id: r.lastInsertRowid });
});

// STOCK
app.get('/api/stock', (req, res) => {
  res.json(db.prepare('SELECT * FROM stock').all());
});

app.post('/api/stock', (req, res) => {
  const { name, qty, price, cost } = req.body;
  db.prepare(`INSERT INTO stock (name,qty,price,cost) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET qty=qty+excluded.qty, price=excluded.price, cost=excluded.cost`)
    .run(name, qty, price || 0, cost || 1);
  res.json(db.prepare('SELECT * FROM stock WHERE name=?').get(name));
});

app.delete('/api/stock/:name', (req, res) => {
  db.prepare('DELETE FROM stock WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});

app.put('/api/stock/:name/use', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const name = req.params.name;
  db.prepare('UPDATE stock SET qty=MAX(0,qty-1), consumed=consumed+1 WHERE name=?').run(name);
  // Lưu tiêu thụ theo ngày riêng
  try {
    db.prepare(`INSERT INTO daily_consumed (name,date,qty) VALUES (?,?,1)
      ON CONFLICT(name,date) DO UPDATE SET qty=qty+1`).run(name, today);
  } catch(e) {
    // Nếu bảng chưa có thì tạo
    db.prepare(`CREATE TABLE IF NOT EXISTS daily_consumed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      qty INTEGER DEFAULT 1,
      UNIQUE(name,date)
    )`).run();
    db.prepare(`INSERT INTO daily_consumed (name,date,qty) VALUES (?,?,1)
      ON CONFLICT(name,date) DO UPDATE SET qty=qty+1`).run(name, today);
  }
  res.json({ ok: true });
});

// Tiêu thụ hôm nay từ database
app.get('/api/stock-daily', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  try {
    const rows = db.prepare(`
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
  res.json({
    tablesNormal: tableState.tablesNormal || [],
    tablesTour: tableState.tablesTour || [],
    activeTab: tableState.activeTab || 'normal',
    queueTour: tableState.queueTour || [],
    updatedAt: tableState.updatedAt
  });
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
app.delete('/api/transactions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const tx = db.prepare('SELECT note FROM transactions WHERE id=?').get(id);
  if(!tx){ return res.status(404).json({ok:false,error:'Không tìm thấy'}); }
  // Chỉ cho xóa giao dịch tiền mặt tour
  if(!(tx.note||'').includes('[TIEN_MAT_TOUR]')){
    return res.status(403).json({ok:false,error:'Chỉ xóa được giao dịch tiền mặt tour'});
  }
  db.prepare('DELETE FROM transactions WHERE id=?').run(id);
  res.json({ok:true});
});

app.delete('/api/transactions/day/:date', (req, res) => {
  const date = req.params.date;
  const r = db.prepare(`DELETE FROM transactions WHERE date(created_at)=?`).run(date);
  // Xóa tiêu thụ kho ngày đó luôn
  try { db.prepare(`DELETE FROM daily_consumed WHERE date=?`).run(date); } catch(e){}
  console.log(`[RESET] Xóa ${r.changes} giao dịch ngày ${date}`);
  res.json({ ok: true, deleted: r.changes });
});

app.delete('/api/transactions/month/:month', (req, res) => {
  const month = req.params.month;
  const r = db.prepare(`DELETE FROM transactions WHERE strftime('%Y-%m', created_at)=?`).run(month);
  console.log(`[RESET] Xóa ${r.changes} giao dịch tháng ${month}`);
  res.json({ ok: true, deleted: r.changes });
});

// ── TOURNAMENT BUY-IN TRACKING ──────────────────────────────────
// Record buy-in/re-buy
app.post('/api/tournament/buyin', (req, res) => {
  const { customerPhone, customerName, isRebuy } = req.body;
  const today = new Date().toISOString().split('T')[0];
  try {
    db.prepare(`INSERT INTO tournament_buyin (customer_phone, customer_name, date, is_rebuy)
               VALUES (?, ?, ?, ?)`).run(customerPhone, customerName, today, isRebuy ? 1 : 0);
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Check if customer has tournament_buyin entry for a date
app.get('/api/tournament-buyin-check', (req, res) => {
  const { phone, date } = req.query;
  if (!phone || !date) {
    return res.json({ count: 0 });
  }
  try {
    const result = db.prepare(
      `SELECT COUNT(*) as cnt FROM tournament_buyin WHERE customer_phone=? AND date=?`
    ).get(phone, date);
    res.json({ count: result?.cnt || 0 });
  } catch(e) {
    res.json({ count: 0 });
  }
});

// Get today's tournament stats
app.get('/api/tournament/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const buyIns = db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=0`)
    .get(today)?.cnt || 0;
  const reBuys = db.prepare(`SELECT COUNT(*) as cnt FROM tournament_buyin WHERE date=? AND is_rebuy=1`)
    .get(today)?.cnt || 0;

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

app.listen(3000, '0.0.0.0', () => console.log('Server dang chay tai http://192.168.1.146:3000'));
