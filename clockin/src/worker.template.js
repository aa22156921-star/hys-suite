/**
 * 現場出勤定位系統（Cloudflare Pages _worker.js + D1）
 *
 *   /        員工頁：同意書 → 輸入自己的姓名綁定手機 → 之後每次打開自動記錄位置
 *   /admin   後台：出勤報表、員工、工地、班別、月班表
 *
 * Cloudflare 設定：
 *   - D1 繫結，變數名稱 DB
 *   - 密碼 ADMIN_KEY（後台登入密碼）
 */

const EMPLOYEE_HTML = __EMPLOYEE_HTML__;
const ADMIN_HTML = __ADMIN_HTML__;
const ANDROID_HTML = __ANDROID_HTML__;
const ICONS = __ICONS__;
const APP_NAME = '洪英夥伴';
const MANIFEST = JSON.stringify({ name: APP_NAME, short_name: APP_NAME, start_url: '/', scope: '/', display: 'standalone',
  background_color: '#ffffff', theme_color: '#e8b931',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] });

const WINDOW_MIN = 15;        // 上下班前後幾分鐘算打卡時段
const TZ_OFFSET = 8 * 3600e3; // 台灣時間
const COOKIE = 'ck_dev';

// ---------------- 資料表 ----------------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      radius INTEGER NOT NULL DEFAULT 200, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, site_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1, reg_code TEXT NOT NULL, device_hash TEXT, bound_at TEXT, bound_ua TEXT, consent_at TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shifts (code TEXT PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS schedule (emp_id INTEGER NOT NULL, date TEXT NOT NULL, shift_code TEXT NOT NULL, site_id INTEGER,
      PRIMARY KEY (emp_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pings (id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, ms INTEGER NOT NULL,
      lat REAL, lng REAL, acc REAL, err TEXT, ip TEXT, ua TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, version TEXT, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pings_emp_ms ON pings(emp_id, ms)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule(date)`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emp_device ON employees(device_hash)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, device_hash TEXT NOT NULL UNIQUE, ua TEXT, bound_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_emp ON devices(emp_id)`),
    // NUEIP 部門 → 工地對照（每天由排程同步）；mode：site 有工地、roam 機動不比對、none 尚無座標
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS dept_map (dept_id TEXT PRIMARY KEY, dept_name TEXT NOT NULL, code TEXT, site_id INTEGER, mode TEXT NOT NULL DEFAULT 'site')`),
    // 補卡／請假申請
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', date TEXT NOT NULL, date_to TEXT, io TEXT, time TEXT, time_to TEXT, leave_type TEXT, reason TEXT,
      lat REAL, lng REAL, acc REAL, created_ms INTEGER NOT NULL, decided_ms INTEGER, decided_by TEXT, note TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_requests_emp ON requests(emp_id, date)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)`),
    // 假別（由排程從 NUEIP 同步；sort 小的排前面，-1 隱藏）
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS leave_types (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 50)`),
    // 人事名冊（每天由排程從 NUEIP 複製一份；只留出勤需要的欄位，不存電話、Email、身分證）
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS staff (uid TEXT PRIMARY KEY, emp_no TEXT NOT NULL, name TEXT NOT NULL, dept_id TEXT, dept_name TEXT, title TEXT,
      arrive TEXT, active INTEGER NOT NULL DEFAULT 1, synced_ms INTEGER)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_staff_name ON staff(name)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_staff_no ON staff(emp_no COLLATE NOCASE)`),
    // 操作紀錄（只新增，不提供刪改）
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)`),
    // 舊版單一綁定搬到 devices
    env.DB.prepare(`INSERT OR IGNORE INTO devices (emp_id, device_hash, ua, bound_at) SELECT id, device_hash, bound_ua, bound_at FROM employees WHERE device_hash IS NOT NULL`),
  ]);
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 2').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN emp_no TEXT').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN auto_ping TEXT').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN locate_req INTEGER').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN roam INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN nueip_uid TEXT').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN nueip_dept TEXT').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE dept_map ADD COLUMN leader_uid TEXT').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE employees ADD COLUMN viewer INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE requests ADD COLUMN place_lat REAL').run(); } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('ALTER TABLE requests ADD COLUMN place_lng REAL').run(); } catch (e) { /* 已存在 */ }
  // 人事名冊延伸欄位（每天由排程從 NUEIP「員工組成」資料集同步；只在後台顯示、匯出會留紀錄）
  for (const c of ['gender TEXT', 'age INTEGER', 'work_type TEXT', 'country TEXT', 'military TEXT', 'marriage TEXT', 'identity TEXT', 'email TEXT', 'status TEXT'])
    try { await env.DB.prepare('ALTER TABLE staff ADD COLUMN ' + c).run(); } catch (e) { /* 已存在 */ }
  schemaReady = true;
}

// ---------------- 工具 ----------------
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'geolocation=(self)', 'X-Frame-Options': 'DENY' };
const html = (b) => new Response(b, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC } });
const json = (d, s = 200, extra = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra } });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function twDate(ms) { return new Date(ms + TZ_OFFSET).toISOString().slice(0, 10); }
function twClock(ms) { return new Date(ms + TZ_OFFSET).toISOString().slice(11, 16); }
function twStamp(ms) { return ms ? new Date(ms + TZ_OFFSET).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/') : ''; } // 補卡申請／核准的實際時間（到秒）
function twMs(date, hhmm) { const [y, m, d] = date.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - TZ_OFFSET; }
function addDays(date, n) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function distanceM(a, b, c, d) { const R = 6371000, r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2);
  return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y)); }
async function sha256(s) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function regCode() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(100000 + (a[0] % 900000)); }
function safeEq(a, b) { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0); return d === 0; }
async function body(req) { try { return await req.json(); } catch { return null; } }

function shiftSpan(date, shift) {
  const start = twMs(date, shift.start);
  let end = twMs(date, shift.end);
  if (end <= start) end += 86400e3; // 跨夜班
  return { start, end };
}

// ---------------- 幹部定時定位 ----------------
// 格式：「1-5 09:00,12:00,18:00」＝週一到週五的 9 點、12 點、18 點；也可寫「12345 09:00」
function parseAuto(str) {
  const m = String(str || '').trim().match(/^([1-7](?:-[1-7])?|[1-7]{1,7})\s+(.+)$/);
  if (!m) return null;
  const days = new Set();
  if (/^[1-7]-[1-7]$/.test(m[1])) { const [a, b] = m[1].split('-').map(Number); for (let d = a; d <= b; d++) days.add(d); }
  else for (const c of m[1]) days.add(Number(c));
  const times = m[2].split(/[,，、\s]+/).filter(Boolean).map((t) => t.replace(/^(\d):/, '0$1:'));
  if (!times.length || times.length > 8 || !times.every((t) => TIME_RE.test(t))) return null;
  return { days, times: [...new Set(times)].sort() };
}
// 現在是不是在幹部的上班時段內（定時定位的第一個～最後一個時間，例如 09:00～18:00）
function inWorkWindow(str, nowMs) {
  const a = parseAuto(str); if (!a) return false;
  const d = twDate(nowMs), wd = new Date(twMs(d, '12:00') + TZ_OFFSET).getUTCDay() || 7;
  if (!a.days.has(wd)) return false;
  return nowMs >= twMs(d, a.times[0]) && nowMs <= twMs(d, a.times[a.times.length - 1]);
}
function autoChecks(str, nowMs) {
  const a = parseAuto(str); if (!a) return [];
  const out = [], today = twDate(nowMs);
  for (const d of [today, addDays(today, 1), addDays(today, 2)]) {
    const wd = new Date(twMs(d, '12:00') + TZ_OFFSET).getUTCDay() || 7;
    if (!a.days.has(wd)) continue;
    for (const t of a.times) { const ms = twMs(d, t); if (ms > nowMs) out.push(ms); }
  }
  return out.slice(0, 6);
}

// 幹部、機動的追蹤時段。auto_ping = '班表'：依排班（班前 15 分到班後 15 分可定位；每班定時抓 3 次：上班後 30 分、班中、下班前 30 分）
const SHIFT_MODE = '班表';
const NO_TRACK = '不追蹤'; // 稽核等職務：平時不定位，只在外出申報時段定位；也不會被職稱規則自動開啟
const CADRE_RE = /經理|協理|襄理|督導|副理/;
const MOBILE_RE = /機動/;
async function trackState(env, emp, now) {
  const base = await trackBase(env, emp, now);
  // 外出申報期間：不論職務都定位（開始後 15 分、中間、結束前 15 分），期間內可立即定位
  const d = twDate(now);
  const outs = (await env.DB.prepare("SELECT date, time, time_to FROM requests WHERE emp_id = ? AND kind = 'out' AND status IN ('pending', 'approved') AND date IN (?, ?)").bind(emp.id, d, addDays(d, 1)).all()).results;
  if (!outs.length) return base;
  const all = base.all.slice(), extra = [];
  let inOut = false;
  for (const o of outs) {
    const a = twMs(o.date, o.time), b = twMs(o.date, o.time_to), mid = Math.round((a + b) / 2);
    for (const t of [Math.min(a + 15 * 60e3, mid), mid, Math.max(b - 15 * 60e3, mid)]) { extra.push(t); all.push(t); }
    if (now >= a && now <= b) inOut = true;
  }
  const checks = [...new Set(base.checks.concat(extra.filter((t) => t > now)))].sort((x, y) => x - y).slice(0, 8);
  return { inWin: base.inWin || inOut, checks, all: all.sort((x, y) => x - y) };
}
async function trackBase(env, emp, now) {
  if (emp.auto_ping !== SHIFT_MODE) return { inWin: inWorkWindow(emp.auto_ping, now), checks: autoChecks(emp.auto_ping, now), all: [] };
  const sh = await shiftsAround(env, emp.id, now), all = [];
  for (const x of sh) { const len = x.end - x.start; for (const t of [x.start + 30 * 60e3, x.start + len / 2, x.end - 30 * 60e3]) all.push(Math.round(t)); }
  all.sort((a, b) => a - b);
  return { inWin: sh.some((x) => now >= x.start - 15 * 60e3 && now <= x.end + 15 * 60e3), checks: all.filter((t) => t > now).slice(0, 6), all };
}
// 依人事名冊職稱自動開啟追蹤：經理／協理／襄理／督導／副理 → 平日 9、12、18 點；職稱含「機動」→ 依班表。後台手動設定過的不覆蓋
async function applyTrackRules(DB) {
  await DB.prepare(`UPDATE employees SET roam = 1,
      auto_ping = CASE WHEN (SELECT title FROM staff WHERE uid = employees.nueip_uid) LIKE '%機動%' THEN '班表' ELSE '1-5 09:00,12:00,18:00' END
    WHERE auto_ping IS NULL AND active = 1 AND nueip_uid IN (SELECT uid FROM staff WHERE active = 1 AND (title LIKE '%機動%' OR title LIKE '%經理%' OR title LIKE '%協理%' OR title LIKE '%襄理%' OR title LIKE '%督導%' OR title LIKE '%副理%'))`).run();
}

// iPhone 捷徑：手機每個整點問一次「現在要不要回報？」，由後台設定決定（回 1 或 0）
// 規則：在他的上班日、且某個設定時間落在「過去 65 分鐘～未來 5 分鐘」內、而那之後還沒回報過 → 1；
//      或後台按了「立即定位」且還沒回報 → 1（同樣只限上班時段）。其餘一律 0，手機就不會抓定位。
async function apiShouldReport(req, env) {
  const txt = (v) => new Response(v, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const emp = await currentEmployee(req, env);
  if (!emp || !emp.active) return txt('0');
  const now = Date.now();
  const last = await env.DB.prepare('SELECT MAX(ms) AS ms FROM pings WHERE emp_id = ?').bind(emp.id).first();
  const lastMs = (last && last.ms) || 0;
  if (emp.auto_ping === SHIFT_MODE) {
    const st = await trackState(env, emp, now);
    for (const ms of st.all) if (ms <= now + 5 * 60e3 && ms > now - 65 * 60e3 && lastMs < ms - 5 * 60e3) return txt('1');
    if (st.inWin && emp.locate_req && now - emp.locate_req < 90 * 60e3 && lastMs < emp.locate_req) return txt('1');
    return txt('0');
  }
  const a = parseAuto(emp.auto_ping); if (!a) return txt('0');
  const d = twDate(now);
  const wd = new Date(twMs(d, '12:00') + TZ_OFFSET).getUTCDay() || 7;
  if (!a.days.has(wd)) return txt('0');
  for (const t of a.times) {
    const ms = twMs(d, t);
    if (ms <= now + 5 * 60e3 && ms > now - 65 * 60e3 && lastMs < ms - 5 * 60e3) return txt('1');
  }
  if (inWorkWindow(emp.auto_ping, now) && emp.locate_req && now - emp.locate_req < 90 * 60e3 && lastMs < emp.locate_req) return txt('1');
  return txt('0');
}

// ---------------- 裝置驗證 ----------------
function deviceToken(req) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([0-9a-f]{64})'));
  if (m) return m[1];
  const h = req.headers.get('X-Device') || '';
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}
async function currentEmployee(req, env) {
  const t = deviceToken(req); if (!t) return null;
  return env.DB.prepare('SELECT e.id, e.name, e.site_id, e.active, e.auto_ping, e.locate_req, e.roam, e.nueip_uid, e.nueip_dept, e.emp_no, e.viewer FROM devices d JOIN employees e ON e.id = d.emp_id WHERE d.device_hash = ?').bind(await sha256(t)).first();
}
const cookieHeader = (t) => `${COOKIE}=${t}; Path=/; Max-Age=315360000; HttpOnly; Secure; SameSite=Lax`;

// 某員工在某時間點附近的班（昨天跨夜 + 今天 + 明天凌晨）
async function shiftsAround(env, empId, nowMs) {
  const today = twDate(nowMs), dates = [addDays(today, -1), today, addDays(today, 1)];
  const { results } = await env.DB.prepare(
    `SELECT s.date, s.site_id, sh.code, sh.name, sh.start, sh.end FROM schedule s JOIN shifts sh ON sh.code = s.shift_code
     WHERE s.emp_id = ? AND s.date IN (?, ?, ?) ORDER BY s.date`).bind(empId, ...dates).all();
  return results.map((r) => ({ ...r, ...shiftSpan(r.date, r) }));
}

// ---------------- 補卡／請假申請與核准 ----------------
const KIND_NAME = { punch: '補卡', leave: '請假', out: '外出' };
const STATUS_NAME = { pending: '待核准', approved: '已核准', rejected: '已退回', cancelled: '已取消' };
async function audit(env, actor, action, detail) {
  try { await env.DB.prepare('INSERT INTO audit (ms, actor, action, detail) VALUES (?, ?, ?, ?)').bind(Date.now(), String(actor).slice(0, 60), String(action).slice(0, 60), detail == null ? null : String(detail).slice(0, 1000)).run(); } catch (e) { /* 紀錄失敗不影響主流程 */ }
}
function reqText(r) {
  if (r.kind === 'out') return r.date + ' ' + r.time + '–' + (r.time_to || '') + ' 外出到 ' + (r.leave_type || '');
  if (r.kind === 'punch') return r.date + ' ' + (r.io === 'out' ? '下班' : '上班') + ' ' + r.time;
  const d = r.date === r.date_to || !r.date_to ? r.date : r.date + '～' + r.date_to;
  return (r.leave_type || '請假') + ' ' + d + (r.time ? ' ' + r.time + '–' + (r.time_to || '') : ' 全天');
}
// 我能核准誰：NUEIP 部門主管 = 我
async function canApprove(env, approver, requestEmpId) {
  if (!approver || !approver.nueip_uid) return false;
  const r = await env.DB.prepare(`SELECT 1 FROM employees e JOIN dept_map m ON m.dept_id = e.nueip_dept WHERE e.id = ? AND m.leader_uid = ? AND e.id <> ?`)
    .bind(requestEmpId, approver.nueip_uid, approver.id).first();
  return !!r;
}
const REQ_COLS = 'r.id, r.emp_id, e.name, e.emp_no, r.kind, r.status, r.date, r.date_to, r.io, r.time, r.time_to, r.leave_type, r.reason, r.lat, r.lng, r.acc, r.created_ms, r.decided_ms, r.decided_by, r.note, r.place_lat, r.place_lng';
async function decorate(env, rows) {
  if (!rows.length) return rows;
  const sites = await activeSites(env), out = [];
  for (const r of rows) {
    const m = r.lat != null ? matchSite(sites, r.lat, r.lng) : null;
    out.push({ ...r, text: reqText(r), kindName: KIND_NAME[r.kind], statusName: STATUS_NAME[r.status], at: m && m.at ? m.at.name : null,
      check: r.kind === 'out' ? await outCheck(env, sites, r) : null,
      created: twStamp(r.created_ms), decided: r.decided_ms ? twStamp(r.decided_ms) : null });
  }
  return out;
}
// 出行地點 → 座標：先找我們的案場，找不到再查 OpenStreetMap（台灣範圍）
async function geocodePlace(env, place) {
  const key = siteKey(place);
  const site = key ? (await activeSites(env)).find((x) => siteKey(x.name) && (siteKey(x.name).includes(key) || key.includes(siteKey(x.name)))) : null;
  if (site) return { lat: site.lat, lng: site.lng, site: site.name };
  try {
    const r = await Promise.race([fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&accept-language=zh-TW&q=' + encodeURIComponent(place),
      { headers: { 'User-Agent': 'hys-attendance/1.0 (clockin.aa22156921.workers.dev)' } }), new Promise((ok) => setTimeout(() => ok(null), 5000))]);
    if (!r || !r.ok) return null;
    const j = await r.json();
    return j && j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
  } catch (e) { return null; }
}
// 外出申報 vs 實際定位：申報的地點是案場就比對有沒有到；不是案場就列出那段時間人在哪
const siteKey = (n) => String(n || '').replace(/社區|大樓|大廈|管理委員會|公寓|\s/g, '');
async function outCheck(env, sites, r) {
  const a = twMs(r.date, r.time), b = twMs(r.date, r.time_to || r.time), now = Date.now();
  if (now < a) return { level: 'wait', text: '尚未開始' };
  const { results } = await env.DB.prepare('SELECT ms, lat, lng FROM pings WHERE emp_id = ? AND ms BETWEEN ? AND ? AND lat IS NOT NULL ORDER BY ms').bind(r.emp_id, a - 15 * 60e3, b + 15 * 60e3).all();
  if (!results.length) return { level: now > b ? 'bad' : 'wait', text: now > b ? '外出期間沒有任何定位紀錄' : '外出中，還沒有定位' };
  if (r.place_lat != null) { // 有出行地點座標：看外出期間有沒有到那附近（500 公尺內）
    const near = results.map((p) => ({ t: twClock(p.ms), d: Math.round(distanceM(r.place_lat, r.place_lng, p.lat, p.lng)) }));
    const hit = near.find((x) => x.d <= 500);
    if (hit) return { level: 'ok', text: '有到 ' + r.leave_type + '（' + hit.t + '，' + hit.d + ' 公尺內）' };
    const best = near.reduce((m, x) => (x.d < m.d ? x : m), near[0]);
    return { level: 'bad', text: '外出期間沒有到 ' + r.leave_type + '（最近一次 ' + best.t + ' 距離 ' + (best.d >= 1000 ? (best.d / 1000).toFixed(1) + ' 公里' : best.d + ' 公尺') + '）' };
  }
  const key = siteKey(r.leave_type), target = key ? sites.find((x) => siteKey(x.name) && (siteKey(x.name).includes(key) || key.includes(siteKey(x.name)))) : null;
  const where = results.map((p) => { const m = matchSite(sites, p.lat, p.lng); return { t: twClock(p.ms), at: m.at ? m.at.name : null }; });
  const summary = where.map((w) => w.t + ' ' + (w.at || '非案場')).join('、');
  if (target) {
    const hit = where.find((w) => w.at === target.name);
    return hit ? { level: 'ok', text: '有到 ' + target.name + '（' + hit.t + '）' } : { level: 'bad', text: '申報到 ' + target.name + '，但定位不在該處：' + summary };
  }
  return { level: 'info', text: '定位：' + summary };
}
async function decide(env, id, ok, note, actor) {
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  if (!r) return { error: '找不到這張申請', code: 404 };
  if (r.status !== 'pending') return { error: '這張申請已經' + STATUS_NAME[r.status], code: 409 };
  const st = ok ? 'approved' : 'rejected', now = Date.now();
  await env.DB.prepare('UPDATE requests SET status = ?, decided_ms = ?, decided_by = ?, note = ? WHERE id = ? AND status = ?')
    .bind(st, now, String(actor).slice(0, 60), note ? String(note).slice(0, 200) : null, id, 'pending').run();
  const e = await env.DB.prepare('SELECT name FROM employees WHERE id = ?').bind(r.emp_id).first();
  await audit(env, actor, (ok ? '核准' : '退回') + KIND_NAME[r.kind], (e ? e.name : '') + '｜' + reqText(r) + (note ? '｜' + note : ''));
  return { ok: true };
}

// 補卡理由自動審核：荒唐、與出勤無關的理由 → 退回並說明；挑釁、辱罵 → 退回、冷靜回覆、留存紀錄並在後台標示
// 只看員工自己打的說明；只選了制式原因（忘記打卡、手機沒電…）的不審，直接交給主管
const SCREEN_ACTOR = '系統自動審核';
const SCREEN_PROMPT = `你是保全物業公司出勤系統的「補卡理由」審核助手。只回一個 JSON：{"verdict":"ok|absurd|abusive","reply":"給員工看的話"}
- ok：任何說得通的理由都算（忘了打卡、手機沒電、沒網路、定位失敗、App 打不開、臨時支援其他案場、主管交辦、身體不適等）。拿不準就選 ok，交給主管判斷。reply 留空。
- absurd：明顯不可能是真的、或跟出勤無關（例如被外星人抓走、亂打的字、只有符號或表情、開玩笑）。reply 客氣但明確：說明這個理由無法作為補卡依據，請附上實際原因重新申請。
- abusive：辱罵、嘲諷、挑釁、威脅主管或公司。reply 冷靜、專業、不帶情緒：申請已退回、內容已留存紀錄，請遵守公司工作規則與職場禮儀；若內容是辱罵或威脅特定的人，可提醒此類言論可能涉及法律責任，但不要恐嚇、不要斷定他犯罪。
reply 用繁體中文，60 字以內，不要加引號以外的符號。`;
const OUT_PROMPT = `你是保全物業公司出勤系統的「外出申報」審核助手。申報人是保全或物業員工（含勤務主管、督導、機動），上班時間離開崗位外出要先申報。只回一個 JSON：{"verdict":"ok|absurd|abusive","reply":"給申報人看的話"}
- ok：和工作有關、說得通就算（巡查案場、拜訪管委會或客戶、處理客訴、支援其他案場、送公文、到銀行／公所／郵局辦公司事務、採購工作用品、開會、教育訓練、維修會勘）。時間長度大致合理即可。拿不準就選 ok 交給主管。reply 留空。
- absurd：理由不合邏輯或明顯是私事（例如上班時間去逛街、看電影、接小孩、辦私人事情卻申報公出、事由與地點完全對不上、時間長得不合理例如巡一個案場要 8 小時）。reply 客氣但明確：指出哪裡對不上；私事請改請假。不要故意刁難。
- abusive：辱罵、嘲諷、挑釁。reply 冷靜專業：申報已退回、內容已留存紀錄，請遵守工作規則與職場禮儀；若辱罵或威脅特定的人，可提醒可能涉及法律責任，但不要恐嚇、不要斷定犯罪。
reply 用繁體中文，60 字以內。`;
async function screenReason(env, text, kind, ctxText) {
  const t = String(text || '').trim();
  if (!t) return null;
  const part = t.includes('：') ? t.slice(t.indexOf('：') + 1).trim() : t;
  if (part && (!/[一-鿿A-Za-z]/.test(part) || /^(.)\1{3,}$/.test(part))) return { verdict: 'absurd', reply: kind === 'out' ? '外出說明看不出事由，請寫清楚實際原因後重新申報。' : '補卡說明看不出原因，請寫清楚實際狀況後重新申請。' };
  if (!env.AI) return null;
  try {
    const run = env.AI.run(env.SCREEN_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'system', content: kind === 'out' ? OUT_PROMPT : SCREEN_PROMPT }, { role: 'user', content: (kind === 'out' ? '外出申報：' + (ctxText || '') + '\n事由：' : '員工填的補卡說明：') + t.slice(0, 300) }], max_tokens: 200, temperature: 0 });
    const out = await Promise.race([run, new Promise((r) => setTimeout(() => r(null), 8000))]);
    const raw = !out ? '' : typeof out === 'string' ? out : typeof out.response === 'string' ? out.response : out.response ? JSON.stringify(out.response)
      : out.choices && out.choices[0] ? out.choices[0].message.content : '';
    const m = String(raw).match(/\{[\s\S]*\}/); if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!['ok', 'absurd', 'abusive'].includes(j.verdict)) return null;
    return { verdict: j.verdict, reply: String(j.reply || '').slice(0, 120) };
  } catch (e) { return null; } // AI 出錯就不自動處理，照常給主管審
}

async function apiMy(req, env) {
  const emp = await currentEmployee(req, env);
  if (!emp || !emp.active) return json({ error: '請先綁定' }, 401);
  const DB = env.DB;
  const mine = (await DB.prepare(`SELECT ${REQ_COLS} FROM requests r JOIN employees e ON e.id = r.emp_id WHERE r.emp_id = ? ORDER BY r.id DESC LIMIT 20`).bind(emp.id).all()).results;
  let approvals = [];
  if (emp.nueip_uid) {
    approvals = (await DB.prepare(`SELECT ${REQ_COLS} FROM requests r JOIN employees e ON e.id = r.emp_id JOIN dept_map m ON m.dept_id = e.nueip_dept
      WHERE r.status = 'pending' AND m.leader_uid = ? AND r.emp_id <> ? ORDER BY r.id LIMIT 50`).bind(emp.nueip_uid, emp.id).all()).results;
  }
  const types = (await DB.prepare('SELECT name FROM leave_types WHERE sort >= 0 ORDER BY sort, name').all()).results.map((x) => x.name);
  const today = twDate(Date.now());
  const sched = (await DB.prepare(`SELECT s.date, sh.name, sh.start, sh.end FROM schedule s JOIN shifts sh ON sh.code = s.shift_code
    WHERE s.emp_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date`).bind(emp.id, addDays(today, -7), today).all()).results;
  return json({ mine: await decorate(env, mine), approvals: await decorate(env, approvals),
    sites: (await activeSites(env)).map((x) => x.name), leaveTypes: types.length ? types : ['特休', '事假', '病假', '生理假', '家庭照顧假', '公假', '婚假', '喪假', '補休/調休'], recent: sched, today });
}

async function apiRequest(req, env) {
  const emp = await currentEmployee(req, env);
  if (!emp || !emp.active) return json({ error: '請先綁定' }, 401);
  const b = await body(req); if (!b) return json({ error: '資料格式錯誤' }, 400);
  const today = twDate(Date.now()), DB = env.DB;
  const reason = String(b.reason || '').trim().slice(0, 200);
  const loc = isNum(b.lat) && isNum(b.lng) ? [b.lat, b.lng, isNum(b.acc) ? b.acc : null] : [null, null, null];
  if (b.kind === 'punch') {
    if (!DATE_RE.test(b.date || '') || b.date > today || b.date < addDays(today, -7)) return json({ error: '補卡只能補最近 7 天' }, 400);
    if (b.io !== 'in' && b.io !== 'out') return json({ error: '請選上班或下班' }, 400);
    if (!TIME_RE.test(b.time || '')) return json({ error: '請選時間' }, 400);
    if (b.date === today && twMs(today, b.time) > Date.now() + 5 * 60e3) return json({ error: '不能補未來的時間' }, 400);
    if (!reason) return json({ error: '請選擇補卡原因' }, 400);
    const dup = await DB.prepare(`SELECT id FROM requests WHERE emp_id = ? AND kind = 'punch' AND date = ? AND io = ? AND status IN ('pending','approved')`).bind(emp.id, b.date, b.io).first();
    if (dup) return json({ error: '這天的' + (b.io === 'in' ? '上班' : '下班') + '已經申請過了' }, 409);
    await DB.prepare(`INSERT INTO requests (emp_id, kind, date, io, time, reason, lat, lng, acc, created_ms) VALUES (?, 'punch', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(emp.id, b.date, b.io, b.time, reason, ...loc, Date.now()).run();
    const note = String(reason).includes('：') ? String(reason).slice(String(reason).indexOf('：') + 1) : (/^(忘記打卡|手機沒電|沒有網路|定位失敗|臨時支援其他案場|其他)$/.test(reason) ? '' : reason);
    const sc = await screenReason(env, note, 'punch');
    if (sc && sc.verdict !== 'ok') {
      const last = await DB.prepare('SELECT id FROM requests WHERE emp_id = ? ORDER BY id DESC LIMIT 1').bind(emp.id).first();
      const msg = (sc.verdict === 'abusive' ? '【不當言語】' : '【理由不成立】') + (sc.reply || (sc.verdict === 'abusive' ? '申請內容含不當言語，已退回並留存紀錄，請遵守公司工作規則。' : '這個理由無法作為補卡依據，請附上實際原因重新申請。'));
      await decide(env, last.id, false, msg, SCREEN_ACTOR);
      return json({ ok: true, rejected: true, message: msg });
    }
  } else if (b.kind === 'leave') {
    const to = b.date_to || b.date;
    if (!DATE_RE.test(b.date || '') || !DATE_RE.test(to) || to < b.date) return json({ error: '請選正確的日期' }, 400);
    if (b.date < addDays(today, -30) || to > addDays(today, 180)) return json({ error: '日期超出可申請範圍' }, 400);
    if ((twMs(to, '00:00') - twMs(b.date, '00:00')) / 86400e3 > 60) return json({ error: '一次最多申請 60 天' }, 400);
    const type = String(b.leave_type || '').trim().slice(0, 30); if (!type) return json({ error: '請選假別' }, 400);
    let t1 = null, t2 = null;
    if (!b.allDay) { if (!TIME_RE.test(b.time || '') || !TIME_RE.test(b.time_to || '') || b.time_to <= b.time) return json({ error: '請選正確的請假時段' }, 400); t1 = b.time; t2 = b.time_to; }
    await DB.prepare(`INSERT INTO requests (emp_id, kind, date, date_to, time, time_to, leave_type, reason, lat, lng, acc, created_ms) VALUES (?, 'leave', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(emp.id, b.date, to, t1, t2, type, reason || null, ...loc, Date.now()).run();
  } else if (b.kind === 'out') {
    if (!DATE_RE.test(b.date || '') || b.date < addDays(today, -1) || b.date > addDays(today, 7)) return json({ error: '外出申報只能填昨天到 7 天內' }, 400);
    if (!TIME_RE.test(b.time || '') || !TIME_RE.test(b.time_to || '') || b.time_to <= b.time) return json({ error: '請選正確的外出時段' }, 400);
    const place = String(b.place || '').trim().slice(0, 40); if (place.length < 2) return json({ error: '請填要去哪裡' }, 400);
    if (!reason) return json({ error: '請選外出事由' }, 400);
    if (!reason.includes('：') || reason.slice(reason.indexOf('：') + 1).trim().length < 4) return json({ error: '請填寫說明（去做什麼、找誰），沒有說明不予通過' }, 400);
    const geo = await geocodePlace(env, place);
    await DB.prepare(`INSERT INTO requests (emp_id, kind, date, time, time_to, leave_type, reason, lat, lng, acc, created_ms, place_lat, place_lng) VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(emp.id, b.date, b.time, b.time_to, place, reason, isNum(b.lat) ? b.lat : null, isNum(b.lng) ? b.lng : null, isNum(b.acc) ? b.acc : null, Date.now(), geo ? geo.lat : null, geo ? geo.lng : null).run();
    const sc = await screenReason(env, reason, 'out', b.date + ' ' + b.time + '–' + b.time_to + '，地點：' + place + '，職稱：' + (((await DB.prepare('SELECT title FROM staff WHERE uid = ?').bind(emp.nueip_uid || '').first()) || {}).title || '未知'));
    if (sc && sc.verdict !== 'ok') {
      const last = await DB.prepare('SELECT id FROM requests WHERE emp_id = ? ORDER BY id DESC LIMIT 1').bind(emp.id).first();
      const msg = (sc.verdict === 'abusive' ? '【不當言語】' : '【事由不成立】') + (sc.reply || '外出事由與工作無關或對不上，私人事務請改請假。');
      await decide(env, last.id, false, msg, SCREEN_ACTOR);
      return json({ ok: true, rejected: true, message: msg });
    }
  } else return json({ error: '不支援的申請' }, 400);
  await audit(env, emp.name, '送出' + KIND_NAME[b.kind], b.kind === 'punch' ? b.date + ' ' + (b.io === 'in' ? '上班' : '下班') + ' ' + b.time : (b.leave_type + ' ' + b.date + '～' + (b.date_to || b.date)));
  return json({ ok: true });
}

async function apiRequestCancel(req, env) {
  const emp = await currentEmployee(req, env); if (!emp) return json({ error: '請先綁定' }, 401);
  const b = await body(req) || {};
  const r = await env.DB.prepare(`UPDATE requests SET status = 'cancelled', decided_ms = ? WHERE id = ? AND emp_id = ? AND status = 'pending'`).bind(Date.now(), b.id, emp.id).run();
  if (!r.meta.changes) return json({ error: '這張申請不能取消了' }, 409);
  await audit(env, emp.name, '取消申請', '#' + b.id);
  return json({ ok: true });
}

// 主管查詢帳號：手機上看今日未到班／遲到／不在案場、幹部・機動最後位置，可要求立即定位
async function apiBoss(req, env, url) {
  const emp = await currentEmployee(req, env);
  if (!emp || !emp.active || !emp.viewer) return json({ error: '沒有考勤查核權限' }, 403);
  const DB = env.DB;
  if (req.method === 'POST') { // 立即定位
    const b = await body(req); if (!b) return json({ error: '資料格式錯誤' }, 400);
    const e = await DB.prepare('SELECT id, name, auto_ping FROM employees WHERE id = ?').bind(b.id).first();
    if (!e) return json({ error: '找不到這個人' }, 404);
    if (!(await trackState(env, e, Date.now())).inWin) return json({ error: '他現在不是上班時段，不能要求定位' }, 400);
    await DB.prepare('UPDATE employees SET locate_req = ? WHERE id = ?').bind(Date.now(), e.id).run();
    await audit(env, emp.name + '（考勤查核）', '要求立即定位', e.name);
    return json({ ok: true });
  }
  const date = DATE_RE.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : twDate(Date.now());
  const x = await exceptionsData(env, date);
  const sites = await activeSites(env), now = Date.now();
  const { results } = await DB.prepare(`SELECT e.id, e.name, e.emp_no, e.auto_ping, s.title, s.dept_name,
      (SELECT COUNT(*) FROM devices d WHERE d.emp_id = e.id AND (d.ua LIKE '%ClockinApp%' OR d.ua = 'iPhone 捷徑')) AS app
    FROM employees e LEFT JOIN staff s ON s.uid = e.nueip_uid WHERE e.active = 1 AND e.auto_ping IS NOT NULL AND e.auto_ping <> '不追蹤' ORDER BY s.dept_name, e.name`).all();
  const tracked = [];
  for (const e of results) {
    const p = await DB.prepare('SELECT ms, lat, lng FROM pings WHERE emp_id = ? AND lat IS NOT NULL ORDER BY ms DESC LIMIT 1').bind(e.id).first();
    const m = p ? matchSite(sites, p.lat, p.lng) : null;
    tracked.push({ id: e.id, name: e.name, emp_no: e.emp_no, title: e.title, dept: e.dept_name, app: e.app > 0, can_locate: (await trackState(env, e, now)).inWin,
      last: p ? { when: twClock(p.ms) + (twDate(p.ms) === twDate(now) ? '' : '（' + twDate(p.ms).slice(5) + '）'), at: m && m.at ? m.at.name : (m && m.nearest ? '近 ' + m.nearest.name + ' ' + m.nearest.dist + 'm' : ''), lat: p.lat, lng: p.lng } : null });
  }
  await audit(env, emp.name + '（考勤查核）', '查看考勤查核', date);
  return json({ date, summary: x.summary, items: x.items, tracked });
}

async function apiApprove(req, env) {
  const emp = await currentEmployee(req, env); if (!emp || !emp.active) return json({ error: '請先綁定' }, 401);
  const b = await body(req) || {};
  const r = await env.DB.prepare('SELECT emp_id FROM requests WHERE id = ?').bind(b.id).first();
  if (!r) return json({ error: '找不到這張申請' }, 404);
  if (!(await canApprove(env, emp, r.emp_id))) return json({ error: '你不是這位同仁的主管' }, 403);
  const out = await decide(env, b.id, !!b.ok, b.note, emp.name);
  return json(out, out.code || 200);
}

// ---------------- 員工 API ----------------
async function apiMe(req, env) {
  const now = Date.now();
  const emp = await currentEmployee(req, env);
  if (!emp) return json({ bound: false, now });
  if (!emp.active) return json({ bound: false, disabled: true, now });
  const shifts = await shiftsAround(env, emp.id, now);
  const upcoming = shifts.filter((s) => s.end + WINDOW_MIN * 60e3 >= now).slice(0, 2)
    .map((s) => ({ date: s.date, name: s.name, start: s.start, end: s.end }));
  const track = await trackState(env, emp, now);
  const poll = track.inWin;
  let locate = false;
  if (poll && emp.locate_req && now - emp.locate_req < 30 * 60e3) {
    const last = await env.DB.prepare('SELECT MAX(ms) AS ms FROM pings WHERE emp_id = ?').bind(emp.id).first();
    locate = !(last && last.ms >= emp.locate_req);
  }
  // 還沒對上人事名冊的：名冊裡同名只有一位就自動補上員編
  if (!emp.nueip_uid) {
    const r = (await env.DB.prepare('SELECT uid, emp_no, dept_id FROM staff WHERE name = ? AND active = 1').bind(emp.name).all()).results;
    if (r.length === 1) {
      await env.DB.prepare('UPDATE employees SET nueip_uid = ?, emp_no = COALESCE(emp_no, ?), nueip_dept = COALESCE(nueip_dept, ?) WHERE id = ?').bind(r[0].uid, r[0].emp_no, r[0].dept_id, emp.id).run();
      emp.emp_no = emp.emp_no || r[0].emp_no;
      await applyTrackRules(env.DB);
    }
  }
  return json({ bound: true, name: emp.name, empNo: emp.emp_no || '', canOut: true, viewer: !!emp.viewer, now, windowMin: WINDOW_MIN, upcoming, checks: track.checks, poll, locate });
}

// 把名冊的員編／NUEIP 帳號補進已建立、但還沒對上的員工（姓名在名冊裡唯一才自動對）
async function mergeRoster(DB) {
  const r = await DB.prepare(`UPDATE employees SET
      nueip_uid = (SELECT uid FROM staff WHERE staff.name = employees.name AND active = 1),
      emp_no = COALESCE(emp_no, (SELECT emp_no FROM staff WHERE staff.name = employees.name AND active = 1)),
      nueip_dept = COALESCE(nueip_dept, (SELECT dept_id FROM staff WHERE staff.name = employees.name AND active = 1))
    WHERE nueip_uid IS NULL AND (SELECT COUNT(*) FROM staff WHERE staff.name = employees.name AND active = 1) = 1`).run();
  await applyTrackRules(DB);
  return r.meta ? r.meta.changes : 0;
}

async function apiRegister(req, env) {
  const b = await body(req); if (!b) return json({ error: '資料格式錯誤' }, 400);
  if (b.consent !== true) return json({ error: '需要先同意出勤定位說明' }, 400);
  const existing = await currentEmployee(req, env);
  if (existing) return json({ error: '這支手機已經綁定「' + existing.name + '」' }, 409);
  const name = String(b.name || '').replace(/\s+/g, '').slice(0, 30);
  const no = String(b.empNo || '').replace(/\s+/g, '').slice(0, 20);
  if (name.length < 2) return json({ error: '請輸入你的完整姓名' }, 400);
  const now = new Date().toISOString(), token = randHex(32), hash = await sha256(token), ua = (req.headers.get('User-Agent') || '').slice(0, 300);
  const DB = env.DB;
  // 姓名＋員編 對人事名冊：同名不同人、冒名綁定都擋得住
  // 只要姓名：人事名冊裡姓名唯一就自動帶入員編；對不到或同名多人，照樣綁定，後台「資料待補」列出來給人資補
  const roster = (await DB.prepare('SELECT uid, emp_no, name, dept_id FROM staff WHERE name = ? AND active = 1').bind(name).all()).results;
  let st = roster.length === 1 ? roster[0] : (no ? roster.find((r) => r.emp_no.toUpperCase() === no.toUpperCase()) || null : null);
  const SEL = 'SELECT id, name, nueip_uid, active, max_devices, (SELECT COUNT(*) FROM devices WHERE emp_id = employees.id) AS n FROM employees WHERE ';
  let emp = st ? await DB.prepare(SEL + 'nueip_uid = ?').bind(st.uid).first() : null;
  if (!emp) {
    const byName = await DB.prepare(SEL + 'name = ?').bind(name).first();
    // 同名但已是另一位（已對上別的 NUEIP 帳號，或同名多人且已有人綁定）就另開一筆
    const other = byName && ((st && byName.nueip_uid && byName.nueip_uid !== st.uid) || (!st && roster.length > 1 && byName.n > 0));
    if (byName && !other) emp = byName;
  }
  if (emp && !emp.active) return json({ error: '「' + emp.name + '」已停用，請聯絡管理員' }, 403);
  if (emp && emp.n >= emp.max_devices) return json({ error: '「' + emp.name + '」已綁定 ' + emp.n + ' 台裝置，請聯絡管理員' }, 409);
  if (!emp) {
    let store = name;
    for (let i = 2; await DB.prepare('SELECT id FROM employees WHERE name = ?').bind(store).first(); i++) store = name + '(' + (st && i === 2 ? st.emp_no : i) + ')';
    await DB.prepare('INSERT OR IGNORE INTO employees (name, reg_code, created_at) VALUES (?, ?, ?)').bind(store, regCode(), now).run();
    emp = await DB.prepare(SEL + 'name = ?').bind(store).first();
  }
  await DB.prepare('INSERT INTO devices (emp_id, device_hash, ua, bound_at) VALUES (?, ?, ?, ?)').bind(emp.id, hash, ua, now).run();
  await DB.prepare('UPDATE employees SET bound_at = COALESCE(bound_at, ?), bound_ua = COALESCE(bound_ua, ?), consent_at = COALESCE(consent_at, ?) WHERE id = ?').bind(now, ua, now, emp.id).run();
  if (st && !emp.nueip_uid) await DB.prepare('UPDATE employees SET emp_no = ?, nueip_uid = ?, nueip_dept = COALESCE(?, nueip_dept) WHERE id = ?').bind(st.emp_no, st.uid, st.dept_id, emp.id).run();
  await applyTrackRules(DB);
  return json({ ok: true, name: emp.name, token }, 200, { 'Set-Cookie': cookieHeader(token) });
}

// 找出最近、且在範圍內的工地；都不在範圍內時 at = null，並回報最近的一個
function matchSite(sites, lat, lng) {
  if (lat == null || lng == null || !sites.length) return { at: null, nearest: null };
  let best = null, nearest = null;
  for (const s of sites) {
    const d = distanceM(s.lat, s.lng, lat, lng);
    if (!nearest || d < nearest.d) nearest = { s, d };
    if (d <= s.radius && (!best || d < best.d)) best = { s, d };
  }
  return { at: best ? { name: best.s.name, dist: Math.round(best.d) } : null,
           nearest: nearest ? { name: nearest.s.name, dist: Math.round(nearest.d) } : null };
}
const activeSites = async (env) => (await env.DB.prepare('SELECT id, name, lat, lng, radius FROM sites WHERE active = 1').all()).results;

async function apiPing(req, env) {
  const emp = await currentEmployee(req, env);
  if (!emp || !emp.active) return json({ error: '這支手機尚未綁定' }, 401);
  const b = await body(req); if (!b) return json({ error: '資料格式錯誤' }, 400);
  const now = Date.now();
  const ok = isNum(b.lat) && isNum(b.lng) && Math.abs(b.lat) <= 90 && Math.abs(b.lng) <= 180;
  const err = ok ? null : String(b.err || 'no_location').slice(0, 40);

  // 防灌爆：同一人 20 秒內只記一筆
  const last = await env.DB.prepare('SELECT ms FROM pings WHERE emp_id = ? ORDER BY ms DESC LIMIT 1').bind(emp.id).first();
  if (!(last && now - last.ms < 20e3)) {
    await env.DB.prepare('INSERT INTO pings (emp_id, ms, lat, lng, acc, err, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(emp.id, now, ok ? b.lat : null, ok ? b.lng : null, ok && isNum(b.acc) ? b.acc : null, err,
            req.headers.get('CF-Connecting-IP') || '', (req.headers.get('User-Agent') || '').slice(0, 300)).run();
  }

  const sites = await activeSites(env);
  const m = ok ? matchSite(sites, b.lat, b.lng) : { at: null, nearest: null };

  const W = WINDOW_MIN * 60e3, shifts = await shiftsAround(env, emp.id, now);
  let hit = null;
  for (const s of shifts) {
    if (Math.abs(now - s.start) <= W) { hit = { kind: 'in', s }; break; }
    if (Math.abs(now - s.end) <= W) { hit = { kind: 'out', s }; break; }
  }
  // 班表有指定工地 → 跟指定工地比；沒指定 → 只要在任一工地範圍內就算
  let site = null, distance = null, inRange = null;
  if (hit && (emp.roam || emp.auto_ping)) { // 幹部／機動：不比對案場，只記時間與位置
    site = m.at ? m.at.name : '外勤'; distance = m.at ? m.at.dist : null; inRange = ok ? true : null;
  } else if (hit) {
    const sid = hit.s.site_id || emp.site_id;
    const assigned = sid ? sites.find((x) => x.id === sid) : null;
    if (assigned) {
      site = assigned.name;
      if (ok) { distance = Math.round(distanceM(assigned.lat, assigned.lng, b.lat, b.lng)); inRange = distance <= assigned.radius; }
    } else if (ok) {
      site = m.at ? m.at.name : null; distance = m.at ? m.at.dist : null; inRange = !!m.at;
    }
  }
  return json({
    ok: true, now, located: ok, at: m.at, nearest: m.nearest,
    hit: hit ? { kind: hit.kind, shift: hit.s.name, start: hit.s.start, end: hit.s.end } : null,
    site, distance, inRange,
  });
}

// ---------------- 出勤判定 ----------------
async function buildReport(env, from, to) {
  const { results: rows } = await env.DB.prepare(
    `SELECT s.emp_id, s.date, s.site_id AS s_site, e.name, e.emp_no, e.site_id AS e_site, e.roam, e.auto_ping, sh.code, sh.name AS shift, sh.start, sh.end
     FROM schedule s JOIN employees e ON e.id = s.emp_id JOIN shifts sh ON sh.code = s.shift_code
     WHERE s.date BETWEEN ? AND ? ORDER BY s.date, sh.start, e.name`).bind(from, to).all();
  const sites = await activeSites(env);
  const siteMap = Object.fromEntries(sites.map((s) => [s.id, s]));
  const W = WINDOW_MIN * 60e3;
  const minMs = twMs(from, '00:00') - 86400e3, maxMs = twMs(to, '23:59') + 2 * 86400e3;
  const { results: pings } = await env.DB.prepare(`SELECT p.emp_id, e.name, p.ms, p.lat, p.lng, p.acc, p.ip FROM pings p JOIN employees e ON e.id = p.emp_id
     WHERE p.ms BETWEEN ? AND ? AND p.lat IS NOT NULL ORDER BY p.ms`).bind(minMs, maxMs).all();
  const byEmp = {};
  for (const p of pings) (byEmp[p.emp_id] ||= []).push(p);
  // 主管核准的補卡 → 當作一筆打卡（標記為補卡）
  const { results: fixes } = await env.DB.prepare(`SELECT emp_id, date, io, time, decided_by, created_ms, decided_ms FROM requests WHERE kind = 'punch' AND status = 'approved' AND date BETWEEN ? AND ?`)
    .bind(addDays(from, -1), to).all();
  for (const f of fixes) (byEmp[f.emp_id] ||= []).push({ emp_id: f.emp_id, ms: 0, manual: true, io: f.io, date: f.date, time: f.time, by: f.decided_by, asked: f.created_ms, okAt: f.decided_ms });
  // 核准的請假
  const { results: leaves } = await env.DB.prepare(`SELECT emp_id, date, date_to, time, time_to, leave_type FROM requests WHERE kind = 'leave' AND status = 'approved' AND date <= ? AND date_to >= ?`)
    .bind(to, from).all();
  const now = Date.now();

  const report = rows.map((r) => {
    const { start, end } = shiftSpan(r.date, r);
    const roam = !!(r.roam || r.auto_ping); // 幹部／機動不比對案場
    const site = roam ? null : (siteMap[r.s_site || r.e_site] || null);
    const all = byEmp[r.emp_id] || [];
    const ps = all.filter((p) => !p.manual);
    const fixIn = all.find((p) => p.manual && p.io === 'in' && p.date === r.date);
    const fixOut = all.find((p) => p.manual && p.io === 'out' && p.date === r.date);
    const leave = leaves.find((l) => l.emp_id === r.emp_id && l.date <= r.date && l.date_to >= r.date);
    const pack = (p) => {
      if (!p) return null;
      if (p.manual) return { time: p.time, ms: p.ms, lat: null, lng: null, acc: null, dist: null, inRange: true, at: '補卡（' + (p.by || '主管') + '核准）', manual: true, fixNote: '補卡｜申請 ' + twStamp(p.asked) + '｜核准 ' + twStamp(p.okAt) + '｜核准人 ' + (p.by || '主管') };
      const m = matchSite(sites, p.lat, p.lng);
      const dist = site ? Math.round(distanceM(site.lat, site.lng, p.lat, p.lng)) : (m.at ? m.at.dist : null);
      return { time: twClock(p.ms), ms: p.ms, lat: p.lat, lng: p.lng, acc: p.acc != null ? Math.round(p.acc) : null,
               dist, inRange: roam ? true : site ? dist <= site.radius : !!m.at, at: m.at ? m.at.name : null };
    };

    let inStatus, inP = ps.find((p) => p.ms >= start - W && p.ms <= start + W);
    if (inP) inStatus = 'ok';
    else {
      inP = ps.find((p) => p.ms > start + W && p.ms < end - W);
      if (inP) inStatus = 'late';
      else inStatus = now < start + W ? 'pending' : 'missing';
    }
    const outCands = ps.filter((p) => p.ms >= end - W && p.ms <= end + W);
    let outStatus, outP = outCands[outCands.length - 1];
    if (outP) outStatus = 'ok';
    else outStatus = now < end + W ? 'pending' : 'missing';

    // 補卡：時間以申請為準（上班依時間判斷是否遲到）
    if (fixIn && (inStatus === 'missing' || inStatus === 'late' || inStatus === 'pending')) {
      fixIn.ms = twMs(r.date, fixIn.time); if (fixIn.ms < start - 12 * 3600e3) fixIn.ms += 86400e3;
      inP = fixIn; inStatus = fixIn.ms <= start + W ? 'ok' : 'late';
    }
    if (fixOut && (outStatus === 'missing' || outStatus === 'pending')) {
      fixOut.ms = twMs(r.date, fixOut.time); if (fixOut.ms < start) fixOut.ms += 86400e3;
      outP = fixOut; outStatus = 'ok';
    }
    // 整天請假：不算缺勤
    const fullLeave = leave && !leave.time;
    if (fullLeave) { if (!inP) inStatus = 'leave'; if (!outP) outStatus = 'leave'; }
    const inPack = pack(inP), outPack = pack(outP);
    if (inPack && inStatus === 'late') inPack.lateMin = Math.round((inP.ms - start) / 60e3);
    return { date: r.date, name: r.name, empNo: r.emp_no || '', shift: r.shift, code: r.code, start: r.start, end: r.end, site: roam ? '外勤（不比對案場）' : site ? site.name : '（班表未指定）', roam,
             inStatus, in: inPack, outStatus, out: outPack, leave: leave ? (leave.leave_type + (leave.time ? ' ' + leave.time + '–' + leave.time_to : '')) : null };
  });

  // 有定位但當天沒排班的人
  const scheduled = new Set(rows.map((r) => r.emp_id + '|' + r.date));
  const extra = {};
  for (const p of pings) {
    const d = twDate(p.ms);
    if (d < from || d > to || scheduled.has(p.emp_id + '|' + d)) continue;
    const k = p.emp_id + '|' + d;
    (extra[k] ||= { date: d, name: p.name, first: p, last: p, count: 0 }); extra[k].last = p; extra[k].count++;
  }
  const unscheduled = Object.values(extra).map((x) => {
    const m = matchSite(sites, x.first.lat, x.first.lng);
    return { date: x.date, name: x.name, count: x.count, first: twClock(x.first.ms), last: twClock(x.last.ms),
             lat: x.first.lat, lng: x.first.lng, at: m.at ? m.at.name : null, dist: m.at ? m.at.dist : null };
  }).sort((a, b) => (a.date + a.name).localeCompare(b.date + b.name));
  return { report, unscheduled };
}

// ---------------- 後台 API ----------------
async function apiAdmin(req, env, url) {
  if (!env.ADMIN_KEY) return json({ error: '尚未設定 ADMIN_KEY' }, 500);
  if (!safeEq(req.headers.get('X-Admin-Key') || '', env.ADMIN_KEY)) return json({ error: '未授權' }, 401);
  const p = url.pathname.replace('/api/admin', ''), M = req.method, DB = env.DB;
  const b = M === 'POST' ? await body(req) : null;
  if (M === 'POST' && !b) return json({ error: '資料格式錯誤' }, 400);
  const res = await adminRoutes(req, env, url, p, M, DB, b);
  // 後台所有修改動作都留紀錄（申請核准另有詳細紀錄）
  if (M === 'POST' && res.status < 400 && p !== '/requests/decide') {
    const d = { ...b }; delete d.data;
    const who = d.id ? await DB.prepare('SELECT name FROM employees WHERE id = ?').bind(d.id).first().catch(() => null) : null;
    await audit(env, '管理員', ADMIN_ACTION[p] || p, (who && p.startsWith('/employees') ? who.name + '｜' : '') + JSON.stringify(d).slice(0, 600));
  }
  return res;
}
const ADMIN_ACTION = { '/sites': '修改工地', '/sites/bulk': '批次匯入工地', '/sites/delete': '刪除工地', '/employees': '新增員工', '/staff/merge': '名冊對應員工', '/employees/update': '修改員工',
  '/employees/unbind': '解除綁定', '/employees/empno': '修改員編', '/employees/auto': '修改定時定位', '/employees/roam': '修改外勤', '/employees/viewer': '修改主管查詢', '/employees/locate': '要求立即定位',
  '/employees/shortcut': '產生捷徑代碼', '/shifts': '修改班別', '/schedule': '匯入班表', '/apk': '上架 App', '/apk/pull': '上架整合版 App', '/requests/reopen': '系統退回改回待審' };

// 今日異常（後台與主管查詢共用）：沒到班、遲到、不在案場、缺下班卡、外出不符、待核准
async function exceptionsData(env, date) {
  const DB = env.DB;
  const { report } = await buildReport(env, addDays(date, -1), date);
  const items = [];
  for (const r of report) {
    const add = (level, what) => items.push({ level, what, date: r.date, name: r.name, empNo: r.empNo, shift: r.shift, start: r.start, end: r.end, site: r.site, leave: r.leave });
    if (r.inStatus === 'missing' && r.outStatus === 'missing') add('red', '未到班');
    else {
      if (r.inStatus === 'missing') add('red', '上班未打卡');
      if (r.inStatus === 'late') add('amber', '遲到 ' + (r.in && r.in.lateMin || '') + ' 分');
      if (r.in && r.in.inRange === false) add('amber', '上班不在案場（' + (r.in.at || '無對應地點') + '）');
      if (r.outStatus === 'missing') add('amber', '下班未打卡');
      if (r.out && r.out.inRange === false) add('amber', '下班不在案場（' + (r.out.at || '無對應地點') + '）');
    }
  }
  const pend = (await DB.prepare(`SELECT ${REQ_COLS} FROM requests r JOIN employees e ON e.id = r.emp_id WHERE r.status = 'pending' ORDER BY r.id`).all()).results;
  // 外出申報 vs 定位不符
  const outs = (await DB.prepare(`SELECT ${REQ_COLS} FROM requests r JOIN employees e ON e.id = r.emp_id WHERE r.kind = 'out' AND r.status IN ('pending', 'approved') AND r.date BETWEEN ? AND ?`).bind(addDays(date, -1), date).all()).results;
  for (const o of await decorate(env, outs)) if (o.check && o.check.level === 'bad')
    items.push({ level: 'red', what: '外出不符：' + o.check.text, date: o.date, name: o.name, empNo: o.emp_no, shift: '外出 ' + o.time + '–' + o.time_to, site: o.leave_type });
  const noNo = (await DB.prepare("SELECT name FROM employees WHERE active = 1 AND nueip_uid IS NULL AND EXISTS (SELECT 1 FROM devices WHERE emp_id = employees.id)").all()).results.map((x) => x.name);
  const noSite = (await DB.prepare(`SELECT dept_name FROM dept_map WHERE mode = 'none' ORDER BY dept_name`).all()).results.map((x) => x.dept_name);
  const sched = report.filter((r) => r.date === date).length, arrived = report.filter((r) => r.date === date && (r.inStatus === 'ok' || r.inStatus === 'late')).length;
  const dupNo = (await DB.prepare("SELECT UPPER(emp_no) AS no, GROUP_CONCAT(name, '、') AS names FROM employees WHERE active = 1 AND emp_no IS NOT NULL AND emp_no <> '' GROUP BY UPPER(emp_no) HAVING COUNT(*) > 1").all()).results.map((x) => x.no + '（' + x.names + '）');
  const sameName = (await DB.prepare("SELECT e.name, GROUP_CONCAT(s.emp_no, '、') AS nos FROM employees e JOIN staff s ON s.name = e.name AND s.active = 1 WHERE e.active = 1 AND e.nueip_uid IS NULL GROUP BY e.id HAVING COUNT(*) > 1").all()).results.map((x) => x.name + '（名冊有 ' + x.nos + '）');
  return ({ date, items, pending: await decorate(env, pend), noEmpNo: noNo, dupNo, sameName, noSiteDepts: noSite, summary: { scheduled: sched, arrived } });
}

async function adminRoutes(req, env, url, p, M, DB, b) {
  // 今日異常：沒到班、遲到、不在案場、缺下班卡、待核准申請
  if (p === '/exceptions' && M === 'GET') {
    const date = DATE_RE.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : twDate(Date.now());
    return json(await exceptionsData(env, date));
  }

  // 申請一覽與核准
  if (p === '/requests' && M === 'GET') {
    const st = url.searchParams.get('status') || 'pending';
    const rows = (await DB.prepare(`SELECT ${REQ_COLS} FROM requests r JOIN employees e ON e.id = r.emp_id WHERE (? = 'all' OR r.status = ?) ORDER BY r.id DESC LIMIT 300`).bind(st, st).all()).results;
    return json({ requests: await decorate(env, rows) });
  }
  if (p === '/requests/reopen' && M === 'POST') { // 系統自動退回的，管理員可改回待審
    const r = await DB.prepare("UPDATE requests SET status = 'pending', decided_ms = NULL, decided_by = NULL, note = NULL WHERE id = ? AND status = 'rejected' AND decided_by = ?").bind(b.id, SCREEN_ACTOR).run();
    return r.meta.changes ? json({ ok: true }) : json({ error: '只有系統自動退回的申請可以改回待審' }, 409);
  }
  if (p === '/requests/decide' && M === 'POST') {
    const out = await decide(env, b.id, !!b.ok, b.note, '管理員');
    return json(out, out.code || 200);
  }
  // 人事名冊
  if (p === '/staff' && M === 'GET') {
    const { results } = await DB.prepare(`SELECT s.uid, s.emp_no, s.name, s.dept_name, s.title, s.arrive, s.active, s.synced_ms, e.id AS emp_id,
      (SELECT COUNT(*) FROM devices WHERE emp_id = e.id) AS devices FROM staff s LEFT JOIN employees e ON e.nueip_uid = s.uid
      WHERE s.active = 1 ORDER BY s.dept_name, s.name`).all();
    const synced = results.reduce((m, r) => Math.max(m, r.synced_ms || 0), 0);
    const unmatched = (await DB.prepare("SELECT id, name, emp_no, bound_at FROM employees WHERE active = 1 AND nueip_uid IS NULL AND EXISTS (SELECT 1 FROM devices WHERE emp_id = employees.id) ORDER BY bound_at DESC").all()).results;
    const dupNo = (await DB.prepare("SELECT UPPER(emp_no) AS no, GROUP_CONCAT(name, '、') AS names FROM employees WHERE active = 1 AND emp_no IS NOT NULL AND emp_no <> '' GROUP BY UPPER(emp_no) HAVING COUNT(*) > 1").all()).results;
    // 人事掃描建檔（hr-scan-db，繫結名稱 HR）：依姓名對上名冊；只取狀態與檔案數，不帶身分證等個資
    let hrOn = false, hrOnly = [];
    if (env.HR) {
      try {
        const hr = (await env.HR.prepare(`SELECT e.id, e.name, e.status, e.dept_name, e.title, e.hire_date, e.created_at,
            (SELECT COUNT(*) FROM files f WHERE f.employee_id = e.id) AS files FROM employees e ORDER BY e.id DESC`).all()).results;
        const byName = {}; for (const h of hr) if (!byName[h.name]) byName[h.name] = h;
        const names = new Set(results.map((r) => r.name));
        // 人易名冊已出現的人，人事建檔自動改成「已匯入 NUEIP」（閉環：後台新增 → 匯入人易 → 隔天同步對上）
        const done = hr.filter((h) => h.status !== 'imported' && names.has(h.name)).map((h) => h.id);
        if (done.length) {
          await env.HR.prepare(`UPDATE employees SET status = 'imported', updated_by = '洪英系統', updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`).bind(new Date().toISOString(), JSON.stringify(done)).run();
          for (const h of hr) if (done.includes(h.id)) h.status = 'imported';
          await audit(env, '系統', '人事建檔標記已入人易', done.length + ' 筆');
        }
        for (const r of results) { const h = byName[r.name]; if (h) r.hr = { status: h.status, files: h.files }; }
        hrOnly = hr.filter((h) => !names.has(h.name)).map((h) => ({ name: h.name, status: h.status, dept_name: h.dept_name, title: h.title, hire_date: h.hire_date, created: (h.created_at || '').slice(0, 10), files: h.files }));
        hrOn = true;
      } catch (e) { hrOn = false; }
    }
    return json({ staff: results, unmatched, dupNo, hrOn, hrOnly, synced: synced ? twDate(synced) + ' ' + twClock(synced) : null });
  }
  if (p === '/staff/merge' && M === 'POST') return json({ ok: true, merged: await mergeRoster(DB) });
  // 後台有、人易還沒有的人 → 產生人易「新增員工」匯入檔（人事建檔的完整資料＋後台自建帳號）；每次匯出都留紀錄
  if (p === '/staff/to-nueip' && M === 'GET') {
    const names = new Set((await DB.prepare('SELECT name FROM staff WHERE active = 1').all()).results.map((r) => r.name));
    const rows = [], seen = new Set();
    const G = { M: '男', F: '女', male: '男', female: '女' };
    if (env.HR) {
      try {
        const hr = (await env.HR.prepare(`SELECT e.*, d.code AS dept_code FROM employees e LEFT JOIN departments d ON d.id = e.dept_id WHERE e.status <> 'imported' ORDER BY e.id`).all()).results;
        for (const h of hr) {
          if (names.has(h.name) || seen.has(h.name)) continue; seen.add(h.name);
          rows.push({ '來源': '人事建檔', '員工編號': '', '姓名': h.name, '性別': G[h.gender] || h.gender || '', '身分證字號': h.id_no || '', '出生日期': h.birth_date || '', '到職日': h.hire_date || '',
            '部門': h.dept_name || '', '部門代號': h.dept_code || '', '職稱': h.title || '', '手機': h.mobile || '', '市話': h.phone || '', 'Email': h.email || '',
            '戶籍地址': h.address_reg || '', '通訊地址': h.address_mail || '', '緊急聯絡人': h.emergency_name || '', '緊急聯絡人關係': h.emergency_relation || '', '緊急聯絡人電話': h.emergency_phone || '',
            '建檔狀態': { pending: '待核對', confirmed: '已確認' }[h.status] || h.status, '備註': h.note || '' });
        }
      } catch (e) { /* 人事建檔未連線 */ }
    }
    const own = (await DB.prepare(`SELECT e.name, e.emp_no, e.created_at, s.name AS site FROM employees e LEFT JOIN sites s ON s.id = e.site_id
      WHERE e.active = 1 AND e.nueip_uid IS NULL AND e.viewer = 0 ORDER BY e.id`).all()).results;
    for (const e of own) {
      const nm = e.name.replace(/\(.*\)$/, '');
      if (names.has(nm) || seen.has(nm)) continue; seen.add(nm);
      rows.push({ '來源': '洪英系統後台', '員工編號': e.emp_no || '', '姓名': nm, '性別': '', '身分證字號': '', '出生日期': '', '到職日': (e.created_at || '').slice(0, 10),
        '部門': e.site || '', '部門代號': '', '職稱': '', '手機': '', '市話': '', 'Email': '', '戶籍地址': '', '通訊地址': '', '緊急聯絡人': '', '緊急聯絡人關係': '', '緊急聯絡人電話': '',
        '建檔狀態': '只有後台帳號（請先到人事建檔補資料）', '備註': '' });
    }
    if (url.searchParams.get('log') === '1') await audit(env, '管理員', '匯出人易新增員工檔', rows.length + ' 人：' + rows.map((r) => r['姓名']).join('、').slice(0, 300));
    return json({ rows, at: twDate(Date.now()), hrOn: !!env.HR });
  }
  // 人員清冊完整匯出：名冊全部欄位＋本系統的帳號、綁定、追蹤、排班、最近定位；每次匯出都寫進操作紀錄
  if (p === '/staff/export' && M === 'GET') {
    const today = twDate(Date.now()), mFrom = today.slice(0, 7) + '-01', mTo = today.slice(0, 7) + '-31';
    const { results } = await DB.prepare(`SELECT s.emp_no, s.name, s.dept_name, s.title, s.arrive, s.status, s.gender, s.age, s.work_type, s.country, s.military, s.marriage, s.identity, s.email,
        e.id AS emp_id, e.name AS sys_name, e.active AS sys_active, e.bound_at, e.consent_at, e.auto_ping, e.roam, e.viewer, e.created_at,
        (SELECT name FROM sites WHERE id = e.site_id) AS home_site,
        (SELECT COUNT(*) FROM devices WHERE emp_id = e.id) AS devices,
        (SELECT h.shift_code || '｜' || COALESCE(t.name, '') FROM schedule h LEFT JOIN sites t ON t.id = h.site_id WHERE h.emp_id = e.id AND h.date = ?1) AS today_shift,
        (SELECT COUNT(*) FROM schedule WHERE emp_id = e.id AND date BETWEEN ?2 AND ?3) AS month_days,
        (SELECT shift_code FROM schedule WHERE emp_id = e.id AND date BETWEEN ?2 AND ?3 GROUP BY shift_code ORDER BY COUNT(*) DESC LIMIT 1) AS main_shift,
        (SELECT t.name FROM schedule h JOIN sites t ON t.id = h.site_id WHERE h.emp_id = e.id AND h.date BETWEEN ?2 AND ?3 GROUP BY h.site_id ORDER BY COUNT(*) DESC LIMIT 1) AS main_site,
        (SELECT MAX(ms) FROM pings WHERE emp_id = e.id AND err IS NULL) AS last_ms,
        (SELECT COUNT(*) FROM requests WHERE emp_id = e.id AND date BETWEEN ?2 AND ?3) AS month_req
      FROM staff s LEFT JOIN employees e ON e.nueip_uid = s.uid WHERE s.active = 1 ORDER BY s.dept_name, s.emp_no`).bind(today, mFrom, mTo).all();
    const days = (d) => { if (!d) return ''; const t = Date.parse(d.slice(0, 10)); return isNaN(t) ? '' : Math.floor((Date.parse(today) - t) / 864e5); };
    const ping = (v) => v === '不追蹤' ? '不追蹤' : v === '班表' ? '依班表' : v ? '定時 ' + v : '';
    const rows = results.map((r) => ({
      '員編': r.emp_no, '姓名': r.name, '部門／案場': r.dept_name || '', '職稱': r.title || '', '到職日': r.arrive || '', '年資（天）': days(r.arrive), '在職狀態': r.status || '在職',
      '性別': r.gender || '', '年齡': r.age == null ? '' : r.age, '工作型態': r.work_type || '', '國籍': r.country || '', '兵役': r.military || '', '婚姻': r.marriage || '', '身分': r.identity || '', 'Email': r.email || '',
      '系統帳號': r.emp_id ? (r.sys_active ? '已建立' : '已停用') : '未建立', '系統顯示名稱': r.sys_name || '', '綁定裝置數': r.devices || 0, '綁定時間': (r.bound_at || '').slice(0, 10),
      '同意定位': (r.consent_at || '').slice(0, 10), '預設案場': r.home_site || '', '外勤': r.roam ? '是' : '', '考勤查核帳號': r.viewer ? '是' : '', '位置追蹤': ping(r.auto_ping),
      '今日班別': r.today_shift || '', '本月排班天數': r.month_days || 0, '本月主要班別': r.main_shift || '', '本月主要案場': r.main_site || '',
      '最近打卡／定位': r.last_ms ? twDate(r.last_ms) + ' ' + twClock(r.last_ms) : '', '本月申請件數': r.month_req || 0,
    }));
    await audit(env, '管理員', '匯出人員清冊', rows.length + ' 人，' + Object.keys(rows[0] || {}).length + ' 欄');
    return json({ rows, at: today });
  }
  if (p === '/audit' && M === 'GET') {
    const { results } = await DB.prepare('SELECT ms, actor, action, detail FROM audit ORDER BY id DESC LIMIT 500').all();
    return json({ audit: results.map((a) => ({ ...a, when: twDate(a.ms) + ' ' + twClock(a.ms) })) });
  }

  // 工地
  if (p === '/sites' && M === 'GET') return json({ sites: (await DB.prepare('SELECT id, name, lat, lng, radius FROM sites WHERE active = 1 ORDER BY id').all()).results });
  if (p === '/sites' && M === 'POST') {
    const name = String(b.name || '').trim().slice(0, 60), radius = Math.round(Number(b.radius));
    if (!name) return json({ error: '請輸入工地名稱' }, 400);
    if (!isNum(b.lat) || !isNum(b.lng) || Math.abs(b.lat) > 90 || Math.abs(b.lng) > 180) return json({ error: '座標不正確' }, 400);
    if (!(radius >= 20 && radius <= 5000)) return json({ error: '範圍請設 20～5000 公尺' }, 400);
    if (b.id) await DB.prepare('UPDATE sites SET name = ?, lat = ?, lng = ?, radius = ? WHERE id = ?').bind(name, b.lat, b.lng, radius, b.id).run();
    else await DB.prepare('INSERT INTO sites (name, lat, lng, radius, created_at) VALUES (?, ?, ?, ?, ?)').bind(name, b.lat, b.lng, radius, new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (p === '/sites/bulk' && M === 'POST') { // sites: [{name, lat, lng, radius}]，同名更新、新名新增
    const list = Array.isArray(b.sites) ? b.sites : [];
    if (!list.length || list.length > 500) return json({ error: '一次 1～500 筆' }, 400);
    const bad = [];
    const clean = list.map((s, i) => ({ name: String(s.name || '').trim().slice(0, 60), lat: s.lat, lng: s.lng, radius: Math.round(Number(s.radius) || 200), i }))
      .filter((s) => { const ok = s.name && isNum(s.lat) && isNum(s.lng) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180 && s.radius >= 20 && s.radius <= 5000; if (!ok) bad.push(s.i + 1); return ok; });
    if (bad.length) return json({ error: '第 ' + bad.join('、') + ' 筆資料不正確，沒有匯入' }, 400);
    const existing = Object.fromEntries((await DB.prepare('SELECT id, name FROM sites WHERE active = 1').all()).results.map((s) => [s.name, s.id]));
    const now = new Date().toISOString(); let added = 0, updated = 0;
    const stmts = clean.map((s) => {
      if (existing[s.name]) { updated++; return DB.prepare('UPDATE sites SET lat = ?, lng = ?, radius = ? WHERE id = ?').bind(s.lat, s.lng, s.radius, existing[s.name]); }
      added++; return DB.prepare('INSERT INTO sites (name, lat, lng, radius, created_at) VALUES (?, ?, ?, ?, ?)').bind(s.name, s.lat, s.lng, s.radius, now);
    });
    for (let i = 0; i < stmts.length; i += 100) await DB.batch(stmts.slice(i, i + 100));
    return json({ ok: true, added, updated });
  }
  if (p === '/sites/delete' && M === 'POST') { await DB.prepare('UPDATE sites SET active = 0 WHERE id = ?').bind(b.id).run(); return json({ ok: true }); }

  // 員工
  if (p === '/employees' && M === 'GET') {
    await mergeRoster(DB);
    const { results } = await DB.prepare(`SELECT e.id, e.name, e.emp_no, e.viewer, e.nueip_uid, (SELECT title FROM staff WHERE uid = e.nueip_uid) AS title, (SELECT dept_name FROM staff WHERE uid = e.nueip_uid) AS dept_name, e.auto_ping, e.roam, e.site_id, s.name AS site, e.active, e.created_at, e.bound_at, e.consent_at, e.max_devices,
      (SELECT COUNT(*) FROM devices WHERE emp_id = e.id) AS devices,
      (SELECT GROUP_CONCAT(ua, '||') FROM devices WHERE emp_id = e.id) AS uas,
      (SELECT MAX(ms) FROM pings WHERE emp_id = e.id) AS last_ms FROM employees e LEFT JOIN sites s ON s.id = e.site_id ORDER BY e.active DESC, e.name`).all();
    const kind = (ua) => /ClockinApp/.test(ua) ? '安卓App' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? '安卓' : /Windows|Macintosh|Linux/.test(ua) ? '電腦' : '其他';
    return json({ employees: results.map((e) => ({ ...e, bound: e.devices > 0, self: e.devices > 0 && e.created_at === e.consent_at,
      deviceKinds: e.uas ? e.uas.split('||').map(kind) : [], uas: undefined, last: e.last_ms ? twDate(e.last_ms) + ' ' + twClock(e.last_ms) : null })) });
  }
  if (p === '/employees' && M === 'POST') { // 一次新增多位：names: [..]
    const names = (Array.isArray(b.names) ? b.names : []).map((n) => String(n).trim().slice(0, 30)).filter(Boolean);
    if (!names.length) return json({ error: '請輸入姓名' }, 400);
    const now = new Date().toISOString(), site = b.site_id || null;
    await DB.batch(names.map((n) => DB.prepare('INSERT OR IGNORE INTO employees (name, site_id, reg_code, created_at) VALUES (?, ?, ?, ?)').bind(n, site, regCode(), now)));
    await mergeRoster(DB);
    return json({ ok: true });
  }
  if (p === '/employees/update' && M === 'POST') {
    const max = [1, 2, 3, 20].includes(Number(b.max_devices)) ? Number(b.max_devices) : null;
    await DB.prepare('UPDATE employees SET site_id = ?, active = ?, max_devices = COALESCE(?, max_devices) WHERE id = ?').bind(b.site_id || null, b.active ? 1 : 0, max, b.id).run();
    return json({ ok: true });
  }
  if (p === '/employees/empno' && M === 'POST') { // NUEIP 員工編號
    const no = String(b.emp_no || '').trim().slice(0, 30);
    if (no && !/^[A-Za-z0-9_-]+$/.test(no)) return json({ error: '員工編號只能是英數字' }, 400);
    await DB.prepare('UPDATE employees SET emp_no = ? WHERE id = ?').bind(no || null, b.id).run();
    // 填的員編在人事名冊裡 → 一併對上 NUEIP 帳號與部門
    const st = no ? await DB.prepare('SELECT uid, dept_id, name FROM staff WHERE emp_no = ? COLLATE NOCASE AND active = 1').bind(no).first() : null;
    if (st) await DB.prepare('UPDATE employees SET nueip_uid = ?, nueip_dept = COALESCE(?, nueip_dept) WHERE id = ?').bind(st.uid, st.dept_id, b.id).run();
    return json({ ok: true, matched: st ? st.name : null });
  }
  if (p === '/employees/viewer' && M === 'POST') { // 主管查詢帳號（同時免比對案場）
    await DB.prepare('UPDATE employees SET viewer = ?, roam = CASE WHEN ? = 1 THEN 1 ELSE roam END WHERE id = ?').bind(b.viewer ? 1 : 0, b.viewer ? 1 : 0, b.id).run();
    return json({ ok: true });
  }
  if (p === '/employees/roam' && M === 'POST') { // 幹部／機動：不比對案場
    await DB.prepare('UPDATE employees SET roam = ? WHERE id = ?').bind(b.roam ? 1 : 0, b.id).run();
    return json({ ok: true });
  }
  if (p === '/employees/auto' && M === 'POST') { // 幹部定時定位
    const v = String(b.auto_ping || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (v && v !== SHIFT_MODE && v !== NO_TRACK && !parseAuto(v)) return json({ error: '格式像這樣：1-5 09:00,12:00,18:00；填「班表」依排班追蹤；填「不追蹤」只在外出申報時段定位' }, 400);
    await DB.prepare('UPDATE employees SET auto_ping = ? WHERE id = ?').bind(v || null, b.id).run();
    return json({ ok: true });
  }
  if (p === '/employees/locate' && M === 'POST') { // 後台要求「立即定位」
    const e = await DB.prepare('SELECT id, auto_ping FROM employees WHERE id = ?').bind(b.id).first();
    if (!e) return json({ error: '找不到這個人' }, 404);
    if (!(await trackState(env, e, Date.now())).inWin) return json({ error: !e.auto_ping ? '他沒有開啟定位追蹤，也不在外出申報時段' : e.auto_ping === SHIFT_MODE ? '他現在沒有排班，不能要求定位' : '現在不是他的上班時段（' + e.auto_ping + '），不能要求定位' }, 400);
    const now = Date.now();
    await DB.prepare('UPDATE employees SET locate_req = ? WHERE id = ?').bind(now, b.id).run();
    return json({ ok: true, at: now });
  }
  if (p === '/employees/shortcut' && M === 'POST') { // iPhone 捷徑自動回報：產生一組專用代碼（舊的捷徑代碼作廢）
    const e = await DB.prepare('SELECT id FROM employees WHERE id = ?').bind(b.id).first();
    if (!e) return json({ error: '找不到這個人' }, 404);
    const token = randHex(32);
    await DB.batch([DB.prepare("DELETE FROM devices WHERE emp_id = ? AND ua = 'iPhone 捷徑'").bind(b.id),
      DB.prepare("INSERT INTO devices (emp_id, device_hash, ua, bound_at) VALUES (?, ?, 'iPhone 捷徑', ?)").bind(b.id, await sha256(token), new Date().toISOString())]);
    return json({ ok: true, token, url: url.origin + '/api/ping' });
  }
  if (p === '/employees/unbind' && M === 'POST') {
    await DB.batch([DB.prepare('DELETE FROM devices WHERE emp_id = ?').bind(b.id),
      DB.prepare('UPDATE employees SET device_hash = NULL, bound_at = NULL, bound_ua = NULL WHERE id = ?').bind(b.id)]);
    return json({ ok: true });
  }

  // 班別
  if (p === '/shifts' && M === 'GET') return json({ shifts: (await DB.prepare('SELECT code, name, start, end FROM shifts ORDER BY start').all()).results });
  if (p === '/shifts' && M === 'POST') {
    const code = String(b.code || '').trim().slice(0, 10), name = String(b.name || code).trim().slice(0, 20);
    if (!code) return json({ error: '請輸入班別代號' }, 400);
    if (!TIME_RE.test(b.start || '') || !TIME_RE.test(b.end || '')) return json({ error: '時間格式要像 08:00' }, 400);
    await DB.prepare('INSERT INTO shifts (code, name, start, end) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, start = excluded.start, end = excluded.end')
      .bind(code, name, b.start, b.end).run();
    return json({ ok: true });
  }
  if (p === '/shifts/delete' && M === 'POST') { await DB.prepare('DELETE FROM shifts WHERE code = ?').bind(b.code).run(); return json({ ok: true }); }

  // 班表
  if (p === '/schedule' && M === 'GET') {
    const month = url.searchParams.get('month') || '';
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: '月份格式錯誤' }, 400);
    const { results } = await DB.prepare('SELECT emp_id, date, shift_code, site_id FROM schedule WHERE date LIKE ?').bind(month + '-%').all();
    return json({ schedule: results });
  }
  if (p === '/schedule' && M === 'POST') { // entries: [{name|emp_id, date, code, site?}], createMissing
    const entries = Array.isArray(b.entries) ? b.entries : [];
    if (!entries.length) return json({ error: '沒有班表資料' }, 400);
    if (entries.length > 5000) return json({ error: '一次最多 5000 筆' }, 400);
    const shifts = new Set((await DB.prepare('SELECT code FROM shifts').all()).results.map((s) => s.code));
    const sites = Object.fromEntries((await DB.prepare('SELECT id, name FROM sites WHERE active = 1').all()).results.map((s) => [s.name, s.id]));
    let emps = Object.fromEntries((await DB.prepare('SELECT id, name FROM employees').all()).results.map((e) => [e.name, e.id]));
    const missing = [...new Set(entries.filter((e) => e.name && !emps[e.name]).map((e) => String(e.name).trim().slice(0, 30)))];
    if (missing.length && b.createMissing) {
      const now = new Date().toISOString();
      await DB.batch(missing.map((n) => DB.prepare('INSERT OR IGNORE INTO employees (name, reg_code, created_at) VALUES (?, ?, ?)').bind(n, regCode(), now)));
      emps = Object.fromEntries((await DB.prepare('SELECT id, name FROM employees').all()).results.map((e) => [e.name, e.id]));
    }
    const stmts = [], problems = [];
    for (const e of entries) {
      const empId = e.emp_id || emps[e.name];
      if (!empId) { problems.push(`找不到員工「${e.name}」`); continue; }
      if (!DATE_RE.test(e.date || '')) { problems.push(`日期錯誤：${e.date}`); continue; }
      const code = String(e.code || '').trim();
      if (!code) { stmts.push(DB.prepare('DELETE FROM schedule WHERE emp_id = ? AND date = ?').bind(empId, e.date)); continue; }
      if (!shifts.has(code)) { problems.push(`${e.name || empId} ${e.date}：沒有「${code}」這個班別`); continue; }
      const siteId = e.site ? sites[e.site] : null;
      if (e.site && !siteId) { problems.push(`${e.name || empId} ${e.date}：沒有「${e.site}」這個工地`); continue; }
      stmts.push(DB.prepare('INSERT INTO schedule (emp_id, date, shift_code, site_id) VALUES (?, ?, ?, ?) ON CONFLICT(emp_id, date) DO UPDATE SET shift_code = excluded.shift_code, site_id = excluded.site_id')
        .bind(empId, e.date, code, siteId));
    }
    if (problems.length && !b.force) return json({ error: '班表有問題，沒有匯入', problems: [...new Set(problems)].slice(0, 50) }, 400);
    for (let i = 0; i < stmts.length; i += 100) await DB.batch(stmts.slice(i, i + 100));
    return json({ ok: true, saved: stmts.length, created: b.createMissing ? missing : [] });
  }

  // 出勤報表
  if (p === '/report' && M === 'GET') {
    const today = twDate(Date.now());
    const from = DATE_RE.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : today;
    const to = DATE_RE.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : from;
    if (to < from || (twMs(to, '00:00') - twMs(from, '00:00')) > 62 * 86400e3) return json({ error: '日期區間最多兩個月' }, 400);
    const r = await buildReport(env, from, to);
    return json({ report: r.report, unscheduled: r.unscheduled, now: Date.now() });
  }

  // 薪資查核：整月出勤證據彙總（薪資條以管理處算好的為準，這裡核對「有沒有真的到班」）
  if (p === '/payaudit' && M === 'GET') {
    const mo = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : twDate(Date.now()).slice(0, 7);
    const from = mo + '-01', last = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).getUTCDate();
    const today = twDate(Date.now()), to = (mo + '-' + String(last).padStart(2, '0')) < today ? mo + '-' + String(last).padStart(2, '0') : today;
    if (to < from) return json({ month: mo, people: [], from, to });
    const { report, unscheduled } = await buildReport(env, from, to);
    const P = {};
    for (const r of report) {
      const k = r.name, x = (P[k] ||= { name: r.name, empNo: r.empNo, site: r.site, shifts: 0, done: 0, evidence: 0, partial: 0, absent: 0, missIn: 0, missOut: 0,
        late: 0, lateMin: 0, leave: 0, manual: 0, offsite: 0, poorGps: 0, planMin: 0, workMin: 0, unsched: 0, roam: r.roam });
      if (r.inStatus === 'pending' && r.outStatus === 'pending') continue; // 還沒到的班不算
      x.shifts++;
      const [sh, sm] = r.start.split(':').map(Number), [eh, em] = r.end.split(':').map(Number);
      const plan = ((eh * 60 + em) - (sh * 60 + sm) + 1440) % 1440 || 1440;
      if (r.inStatus === 'leave' && r.outStatus === 'leave') { x.leave++; continue; }
      x.done++; x.planMin += plan;
      if (!r.in && !r.out) { x.absent++; continue; }
      if (!r.in) x.missIn++;
      if (!r.out && r.outStatus === 'missing') x.missOut++;
      if (r.inStatus === 'late') { x.late++; x.lateMin += (r.in && r.in.lateMin) || 0; }
      const pts = [r.in, r.out].filter(Boolean);
      x.manual += pts.filter((q) => q.manual).length;
      x.offsite += pts.filter((q) => !q.manual && !q.inRange).length;
      x.poorGps += pts.filter((q) => !q.manual && q.acc != null && q.acc > 150).length;
      const good = (q) => q && !q.manual && q.inRange;
      if (good(r.in) && good(r.out)) x.evidence++; else x.partial++;
      if (r.in && r.out && r.in.ms && r.out.ms && r.out.ms > r.in.ms) x.workMin += Math.round((r.out.ms - r.in.ms) / 60e3);
    }
    for (const u of unscheduled) if (P[u.name]) P[u.name].unsched++;
    const people = Object.values(P).map((x) => {
      const rate = x.done ? Math.round(x.evidence / x.done * 100) : null;
      const flags = [];
      if (x.absent) flags.push('未到 ' + x.absent + ' 天');
      if (x.manual >= 3) flags.push('補卡 ' + x.manual + ' 次');
      if (x.offsite >= 2) flags.push('不在案場打卡 ' + x.offsite + ' 次');
      if (x.missIn + x.missOut >= 3) flags.push('缺卡 ' + (x.missIn + x.missOut) + ' 次');
      if (x.poorGps >= 3) flags.push('定位不準 ' + x.poorGps + ' 次');
      if (rate != null && rate < 70) flags.push('完整證據只有 ' + rate + '%');
      const risk = x.absent || (rate != null && rate < 70) || x.manual >= 5 || x.offsite >= 4 ? 'high' : flags.length ? 'mid' : 'low';
      return { ...x, rate, flags, risk };
    }).sort((a, b) => ({ high: 0, mid: 1, low: 2 }[a.risk] - { high: 0, mid: 1, low: 2 }[b.risk]) || a.name.localeCompare(b.name));
    return json({ month: mo, from, to, people });
  }

  // NUEIP 打卡檔（給公司電腦的 NueAttendance 自動上傳用）
  // ?date=班表日期（預設昨天）&fmt={no},{date},{time}&dfmt=yyyy/MM/dd&all=1（連範圍外也匯出）
  if (p === '/nueip-forms' && M === 'GET') { // 已核准的請假、外出：NUEIP 不能用程式寫入，整理成清單給人資登錄
    const from = DATE_RE.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : twDate(Date.now());
    const to = DATE_RE.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : from;
    const rows = (await DB.prepare(`SELECT ${REQ_COLS} FROM requests r JOIN employees e ON e.id = r.emp_id WHERE r.kind IN ('leave', 'out') AND r.status = 'approved'
      AND r.date <= ? AND COALESCE(r.date_to, r.date) >= ? ORDER BY r.date, e.name`).bind(to, from).all()).results;
    return json({ rows: await decorate(env, rows) });
  }
  if (p === '/nueip' && M === 'GET') {
    const date = DATE_RE.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : addDays(twDate(Date.now()), -1);
    const fmt = (url.searchParams.get('fmt') || '{no},{date},{time}').slice(0, 200);
    const dfmt = (url.searchParams.get('dfmt') || 'yyyy/MM/dd').slice(0, 20);
    const all = url.searchParams.get('all') === '1';
    const io = { in: url.searchParams.get('in') || '上班', out: url.searchParams.get('out') || '下班' };
    const nl = url.searchParams.get('crlf') === '0' ? '\n' : '\r\n';
    const to = DATE_RE.test(url.searchParams.get('to') || '') && url.searchParams.get('to') >= date && url.searchParams.get('to') <= addDays(date, 31) ? url.searchParams.get('to') : date;
    const { report } = await buildReport(env, date, to);
    const lines = [], skipped = [];
    const fd = (ms) => { const t = new Date(ms + TZ_OFFSET).toISOString(); return dfmt.replace('yyyy', t.slice(0, 4)).replace('MM', t.slice(5, 7)).replace('dd', t.slice(8, 10)); };
    const ft = (ms) => new Date(ms + TZ_OFFSET).toISOString().slice(11, 16);
    for (const r of report) {
      for (const [k, st, pk] of [['in', r.inStatus, r.in], ['out', r.outStatus, r.out]]) {
        if (!pk || (st !== 'ok' && st !== 'late')) continue;
        if (!r.empNo) { skipped.push(r.name + '（沒有員工編號）'); continue; }
        if (!all && !pk.inRange) { skipped.push(r.name + ' ' + io[k] + '（不在案場範圍）'); continue; }
        lines.push(fmt.replace(/\{no\}/g, r.empNo).replace(/\{name\}/g, r.name).replace(/\{date\}/g, fd(pk.ms)).replace(/\{time\}/g, ft(pk.ms))
          .replace(/\{sec\}/g, new Date(pk.ms + TZ_OFFSET).toISOString().slice(11, 19)).replace(/\{io\}/g, io[k]).replace(/\{site\}/g, r.roam ? (pk.at || '外勤') : r.site)
          .replace(/\{kind\}/g, pk.manual ? '補卡' : '打卡').replace(/\{note\}/g, pk.fixNote || ''));
      }
    }
    return new Response(lines.join(nl) + (lines.length ? nl : ''), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Count': String(lines.length), 'X-Skipped': encodeURIComponent([...new Set(skipped)].join('、')).slice(0, 4000), ...SEC } });
  }

  // 安卓 App 上架
  if (p === '/apk' && M === 'GET') {
    const f = await DB.prepare('SELECT size, version, updated_at FROM files WHERE name = ?').bind('app.apk').first();
    const best = await latestApk(env);
    return json({ apk: f || null, latest: best.version, source: best.source });
  }
  if (p === '/apk/pull' && M === 'POST') { // 把 GitHub 上最新的整合版 App 存進資料庫：舊網址的打卡 App 也會跟著升級到整合版
    const v = (await (await fetch(GH_DIST + 'VERSION', { cf: { cacheTtl: 0 } })).text()).trim();
    const r = await fetch(GH_DIST + 'clockin.apk', { cf: { cacheTtl: 0 } });
    if (!/^v?\d+\.\d+\.\d+$/.test(v) || !r.ok) return json({ error: 'GitHub 上找不到整合版 App' }, 502);
    const buf = new Uint8Array(await r.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    const data = btoa(bin); if (!data.startsWith('UEsDB') || data.length > 1_800_000) return json({ error: 'APK 檔案不正確' }, 400);
    await DB.prepare('INSERT INTO files (name, data, mime, size, version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, size = excluded.size, version = excluded.version, updated_at = excluded.updated_at')
      .bind('app.apk', data, 'application/vnd.android.package-archive', buf.length, v.startsWith('v') ? v : 'v' + v, new Date().toISOString()).run();
    return json({ ok: true, version: v });
  }
  if (p === '/apk' && M === 'POST') {
    const data = String(b.data || ''), version = String(b.version || '').slice(0, 30);
    if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 1000) return json({ error: 'APK 檔案不正確' }, 400);
    if (data.length > 1_800_000) return json({ error: 'APK 太大（上限約 1.3MB）' }, 400);
    if (!data.startsWith('UEsDB')) return json({ error: '這不是 APK 檔' }, 400); // ZIP 開頭
    await DB.prepare('INSERT INTO files (name, data, mime, size, version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, size = excluded.size, version = excluded.version, updated_at = excluded.updated_at')
      .bind('app.apk', data, 'application/vnd.android.package-archive', Math.floor(data.length * 3 / 4), version || null, new Date().toISOString()).run();
    return json({ ok: true });
  }

  // 安卓 App 人員：最後一次定位
  if (p === '/app-staff' && M === 'GET') {
    const { results } = await DB.prepare(`SELECT e.id, e.name, e.emp_no, e.nueip_uid, (SELECT title FROM staff WHERE uid = e.nueip_uid) AS title, (SELECT dept_name FROM staff WHERE uid = e.nueip_uid) AS dept_name, e.auto_ping, e.active, e.locate_req,
        (SELECT MAX(d.bound_at) FROM devices d WHERE d.emp_id = e.id AND (d.ua LIKE '%ClockinApp%' OR d.ua = 'iPhone 捷徑')) AS app_since,
        (SELECT COUNT(*) FROM devices d WHERE d.emp_id = e.id AND d.ua LIKE '%ClockinApp%') AS has_app,
        (SELECT d.ua FROM devices d WHERE d.emp_id = e.id AND d.ua LIKE '%ClockinApp%' ORDER BY d.bound_at DESC LIMIT 1) AS app_ua
      FROM employees e WHERE EXISTS (SELECT 1 FROM devices d WHERE d.emp_id = e.id AND (d.ua LIKE '%ClockinApp%' OR d.ua = 'iPhone 捷徑')) ORDER BY e.name`).all();
    const sites = await activeSites(env), out = [];
    for (const e of results) {
      const last = await DB.prepare('SELECT ms, lat, lng, acc, err FROM pings WHERE emp_id = ? ORDER BY ms DESC LIMIT 1').bind(e.id).first();
      const lastOk = await DB.prepare('SELECT ms, lat, lng, acc FROM pings WHERE emp_id = ? AND lat IS NOT NULL ORDER BY ms DESC LIMIT 1').bind(e.id).first();
      const m = lastOk ? matchSite(sites, lastOk.lat, lastOk.lng) : { at: null, nearest: null };
      const lp = await DB.prepare("SELECT ua FROM pings WHERE emp_id = ? AND ua LIKE '%ClockinApp%' ORDER BY ms DESC LIMIT 1").bind(e.id).first();
      const ver = (String((lp && lp.ua) || e.app_ua || '').match(/ClockinApp\/([\d.]+)/) || [])[1] || ''; // 以最近一次 App 回報的版本為準
      out.push({ id: e.id, name: e.name, emp_no: e.emp_no, auto_ping: e.auto_ping, active: e.active, app_version: ver, has_app: !!e.has_app, can_locate: (await trackState(env, e, Date.now())).inWin,
        locate_req: e.locate_req, waiting: !!(e.locate_req && Date.now() - e.locate_req < (e.has_app ? 30 : 90) * 60e3 && !(last && last.ms >= e.locate_req)),
        app_since: e.app_since, last: last ? { when: twDate(last.ms) + ' ' + twClock(last.ms), ms: last.ms, err: last.err } : null,
        loc: lastOk ? { when: twDate(lastOk.ms) + ' ' + twClock(lastOk.ms), ms: lastOk.ms, lat: lastOk.lat, lng: lastOk.lng, acc: lastOk.acc, at: m.at, nearest: m.nearest } : null });
    }
    return json({ staff: out, now: Date.now() });
  }

  // 應追蹤名單：人事名冊裡所有幹部、機動，以及綁定狀況
  if (p === '/tracked' && M === 'GET') {
    await mergeRoster(DB);
    const { results } = await DB.prepare(`SELECT s.emp_no, s.name, s.title, s.dept_name, e.id AS emp_id, e.auto_ping,
        (SELECT COUNT(*) FROM devices d WHERE d.emp_id = e.id AND (d.ua LIKE '%ClockinApp%' OR d.ua = 'iPhone 捷徑')) AS app,
        (SELECT COUNT(*) FROM devices d WHERE d.emp_id = e.id) AS dev,
        (SELECT MAX(ms) FROM pings WHERE emp_id = e.id AND lat IS NOT NULL) AS last_ms
      FROM staff s LEFT JOIN employees e ON e.nueip_uid = s.uid
      WHERE s.active = 1 AND (s.title LIKE '%機動%' OR s.title LIKE '%經理%' OR s.title LIKE '%協理%' OR s.title LIKE '%襄理%' OR s.title LIKE '%督導%' OR s.title LIKE '%副理%')
      ORDER BY (s.title LIKE '%機動%'), s.dept_name, s.name`).all();
    return json({ list: results.map((r) => ({ ...r, kind: MOBILE_RE.test(r.title) ? '機動' : '幹部', last: r.last_ms ? twDate(r.last_ms) + ' ' + twClock(r.last_ms) : null })) });
  }
  // 原始定位紀錄（可指定 emp＝只看一個人）
  if (p === '/pings' && M === 'GET') {
    const date = DATE_RE.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : twDate(Date.now());
    const emp = Number(url.searchParams.get('emp')) || 0;
    const { results } = await DB.prepare(`SELECT p.ms, e.name, p.lat, p.lng, p.acc, p.err, p.ip FROM pings p JOIN employees e ON e.id = p.emp_id
      WHERE p.ms BETWEEN ? AND ? AND (? = 0 OR p.emp_id = ?) ORDER BY p.ms DESC LIMIT 2000`).bind(twMs(date, '00:00'), twMs(date, '00:00') + 86400e3 - 1, emp, emp).all();
    const sites = await activeSites(env);
    return json({ pings: results.map((r) => { const m = matchSite(sites, r.lat, r.lng); return { ...r, time: twClock(r.ms), at: m.at, nearest: m.nearest }; }) });
  }
  return json({ error: 'Not found' }, 404);
}

// ---------------- 安卓 App 下載 ----------------
// GitHub 自動打包的最新版（每次改程式自動產生），5 分鐘快取
const GH_DIST = 'https://raw.githubusercontent.com/aa22156921-star/hys-suite/dist/';
function verNum(v) { return String(v || '').replace(/[^0-9.]/g, '').split('.').map((x) => Number(x) || 0); }
function verNewer(a, b) { const x = verNum(a), y = verNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
async function latestApk(env) {
  const f = await env.DB.prepare('SELECT version FROM files WHERE name = ?').bind('app.apk').first();
  let gh = '';
  try { const r = await fetch(GH_DIST + 'VERSION', { cf: { cacheTtl: 300, cacheEverything: true } }); if (r.ok) gh = (await r.text()).trim(); } catch (e) { /* GitHub 連不到就用後台上架版 */ }
  if (/^v?\d+\.\d+\.\d+$/.test(gh) && verNewer(gh, f && f.version)) return { version: gh, source: 'github' };
  return { version: (f && f.version) || '', source: 'db' };
}
async function serveApk(env) {
  const best = await latestApk(env);
  if (best.source === 'github') {
    try {
      const r = await fetch(GH_DIST + 'clockin.apk', { cf: { cacheTtl: 300, cacheEverything: true } });
      if (r.ok) return new Response(r.body, { headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="hongying-clockin-${best.version}.apk"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (e) { /* 改用後台上架版 */ }
  }
  const f = await env.DB.prepare('SELECT data, size, version FROM files WHERE name = ?').bind('app.apk').first();
  if (!f) return new Response('安卓 App 還沒上架，請先用網頁版打卡。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const bin = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': `attachment; filename="hongying-clockin-${f.version || 'app'}.apk"`,
    'Content-Length': String(bin.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// ---------------- 進入點 ----------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.DB) return new Response('尚未綁定 D1 資料庫（變數名稱需為 DB），設定後要重新部署一次。', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    try {
      await ensureSchema(env);
      const p = url.pathname, M = req.method;
      if (p === '/' && (M === 'GET' || M === 'HEAD')) return html(EMPLOYEE_HTML);
      if (p === '/admin' && M === 'GET') return html(ADMIN_HTML);
      if (ICONS[p] && M === 'GET') return new Response(Uint8Array.from(atob(ICONS[p]), (c) => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
      if (p === '/manifest.json' && M === 'GET') return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
      if (p === '/app.apk' && (M === 'GET' || M === 'HEAD')) return serveApk(env);
      if (p === '/android' && M === 'GET') return html(ANDROID_HTML);
      if (p === '/api/me' && M === 'GET') return apiMe(req, env);
      if (p === '/api/should-report' && M === 'GET') return apiShouldReport(req, env);
      if (p === '/api/app-version' && M === 'GET') { // App 檢查更新用：取 GitHub 最新版與後台上架版中較新的
        const best = await latestApk(env);
        return json({ version: best.version, source: best.source });
      }
      if (p === '/api/register' && M === 'POST') return apiRegister(req, env);
      if (p === '/api/ping' && M === 'POST') return apiPing(req, env);
      if (p === '/api/my' && M === 'GET') return apiMy(req, env);
      if (p === '/api/request' && M === 'POST') return apiRequest(req, env);
      if (p === '/api/request/cancel' && M === 'POST') return apiRequestCancel(req, env);
      if (p === '/api/approve' && M === 'POST') return apiApprove(req, env);
      if (p === '/api/boss') return apiBoss(req, env, url);
      if (p.startsWith('/api/admin/')) return apiAdmin(req, env, url);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: '伺服器錯誤：' + (e && e.message ? e.message : e) }, 500);
    }
  },
};
