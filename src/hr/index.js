// 人事掃描建檔 — Cloudflare Worker 後端
// API：/api/login /api/extract /api/records /api/departments /api/export.csv /api/audit
// 權限：以三組通行碼（Worker secrets）區分 viewer / editor / admin

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

const FIELDS = [
  'name', 'id_no', 'gender', 'birth_date', 'mobile', 'phone', 'email',
  'address_reg', 'address_mail', 'emergency_name', 'emergency_relation',
  'emergency_phone', 'dept_id', 'dept_name', 'title', 'hire_date', 'note', 'status',
  'salary', 'insurance_salary', 'dispatch_type',
];

const FIELD_LABELS = {
  name: '姓名', id_no: '身分證字號', gender: '性別', birth_date: '出生日期',
  mobile: '手機', phone: '市話', email: 'Email', address_reg: '戶籍地址',
  address_mail: '通訊地址', emergency_name: '緊急聯絡人', emergency_relation: '關係',
  emergency_phone: '緊急聯絡電話', dept_id: '部門ID', dept_name: '派駐社區', title: '職位',
  salary: '月薪', insurance_salary: '投保級距', dispatch_type: '派應',
  hire_date: '到職日', note: '備註', status: '狀態',
};

const STATUSES = ['pending', 'confirmed', 'imported'];
const MAX_IMAGE_CHARS = 8_000_000; // 約 6MB 圖片的 base64
const MAX_FILE = 10 * 1024 * 1024;  // 個人檔案單檔上限 10MB
const CHUNK_CHARS = 1_500_000;      // 每段 base64 長度（D1 單列上限 2MB）
const ALLOWED_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error(err);
      return json({ error: '伺服器錯誤：' + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// ---------- 權限 ----------
const MAX_FAILS = 5;                 // 連續錯幾次就鎖
const LOCK_MS = 15 * 60 * 1000;      // 鎖多久

async function authenticate(request, env) {
  const code = (request.headers.get('x-access-code') || '').trim();
  let who = '';
  try { who = decodeURIComponent(request.headers.get('x-user-name') || '').trim().slice(0, 40); } catch { /* ignore */ }
  if (!env.ADMIN_CODE && !env.EDITOR_CODE && !env.VIEWER_CODE) {
    throw new HttpError(503, '尚未設定通行碼（ADMIN_CODE / EDITOR_CODE / VIEWER_CODE），系統暫停使用');
  }
  if (!code) throw new HttpError(401, '請先登入');

  // 防暴力破解：同一來源連續輸錯會被暫時鎖住
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const rec = await env.DB.prepare('SELECT fails, locked_until FROM login_fail WHERE ip = ?').bind(ip).first();
  if (rec && rec.locked_until > now) {
    const mins = Math.ceil((rec.locked_until - now) / 60000);
    throw new HttpError(429, `通行碼錯誤太多次，請 ${mins} 分鐘後再試`);
  }

  let role = null;
  if (env.ADMIN_CODE && safeEqual(code, env.ADMIN_CODE)) role = 'admin';
  else if (env.EDITOR_CODE && safeEqual(code, env.EDITOR_CODE)) role = 'editor';
  else if (env.VIEWER_CODE && safeEqual(code, env.VIEWER_CODE)) role = 'viewer';

  if (!role) {
    const fails = (rec && rec.locked_until <= now && rec.fails >= MAX_FAILS ? 0 : (rec ? rec.fails : 0)) + 1;
    const lockedUntil = fails >= MAX_FAILS ? now + LOCK_MS : 0;
    await env.DB.prepare(
      'INSERT INTO login_fail (ip, fails, locked_until, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at',
    ).bind(ip, fails, lockedUntil, now).run();
    if (lockedUntil) {
      await env.DB.prepare('INSERT INTO audit_log (who, role, action, target) VALUES (?, ?, ?, ?)')
        .bind(who || '(未填姓名)', '-', '通行碼錯誤過多，已鎖定', ip).run();
      throw new HttpError(429, '通行碼錯誤太多次，已鎖定 15 分鐘');
    }
    throw new HttpError(401, `通行碼錯誤（再錯 ${MAX_FAILS - fails} 次會鎖定 15 分鐘）`);
  }
  if (rec) await env.DB.prepare('DELETE FROM login_fail WHERE ip = ?').bind(ip).run();
  return { role, who: who || '(未填姓名)' };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function need(user, role) {
  if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw new HttpError(403, '權限不足');
}

async function audit(env, user, action, target = '') {
  await env.DB.prepare('INSERT INTO audit_log (who, role, action, target) VALUES (?, ?, ?, ?)')
    .bind(user.who, user.role, action, String(target).slice(0, 200)).run();
}

// ---------- 路由 ----------
async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') return json({ ok: true });

  const user = await authenticate(request, env);

  if (path === '/api/login' && method === 'POST') {
    await audit(env, user, '登入');
    return json({ role: user.role, who: user.who });
  }

  if (path === '/api/departments' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, name, code, path FROM departments ORDER BY code IS NULL, code, name').all();
    return json({ items: results });
  }

  if (path === '/api/extract' && method === 'POST') {
    need(user, 'editor');
    const body = await readJson(request);
    const image = String(body.image || '');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(image)) throw new HttpError(400, '圖片格式不正確');
    if (image.length > MAX_IMAGE_CHARS) throw new HttpError(413, '圖片太大，請重拍');
    const docType = String(body.doc_type || 'auto').slice(0, 20);
    const raw = await extractWithAI(env, image, docType);
    const fields = normalizeExtracted(raw);
    const check = validate(fields);
    await audit(env, user, '辨識照片', docType);
    return json({ fields, uncertain: raw.uncertain || [], warnings: check.warnings, doc_type: raw.doc_type || docType });
  }

  if (path === '/api/records' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const status = url.searchParams.get('status') || '';
    const dept = url.searchParams.get('dept') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
    const where = [];
    const args = [];
    if (q) {
      where.push('(name LIKE ? OR id_no LIKE ? OR mobile LIKE ? OR dept_name LIKE ?)');
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      // viewer 不能用身分證號碼或手機反查
      if (user.role === 'viewer') args.push(like, '\u0000', '\u0000', like);
      else args.push(like, like, like, like);
    }
    if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
    if (dept) { where.push('dept_id = ?'); args.push(dept); }
    const sqlWhere = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const { results } = await env.DB.prepare(
      `SELECT employees.*, (SELECT COUNT(*) FROM files WHERE files.employee_id = employees.id) AS file_count FROM employees${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).bind(...args, limit, offset).all();
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM employees${sqlWhere}`).bind(...args).first();
    await audit(env, user, '查詢名單', q);
    return json({ items: results.map((r) => maskFor(user, r)), total: total ? total.n : 0 });
  }

  const recMatch = path.match(/^\/api\/records\/(\d+)$/);
  if (recMatch && method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM employees WHERE id = ?').bind(recMatch[1]).first();
    if (!row) throw new HttpError(404, '找不到資料');
    await audit(env, user, '調閱個人資料', `#${row.id} ${row.name}`);
    return json({ item: maskFor(user, row) });
  }

  if (path === '/api/records' && method === 'POST') {
    need(user, 'editor');
    const body = await readJson(request);
    const rec = cleanRecord(body);
    if (!rec.name) throw new HttpError(400, '姓名必填');
    const check = validate(rec);
    if (check.errors.length) throw new HttpError(400, check.errors.join('；'));
    if (rec.id_no) {
      const dup = await env.DB.prepare('SELECT id, name FROM employees WHERE id_no = ?').bind(rec.id_no).first();
      if (dup) throw new HttpError(409, `此身分證字號已建檔（#${dup.id} ${dup.name}）`, { existing_id: dup.id });
    }
    await fillDeptName(env, rec);
    rec.status = STATUSES.includes(rec.status) ? rec.status : 'pending';
    const cols = FIELDS.filter((f) => rec[f] !== undefined);
    const res = await env.DB.prepare(
      `INSERT INTO employees (${cols.join(',')}, created_by) VALUES (${cols.map(() => '?').join(',')}, ?)`,
    ).bind(...cols.map((c) => rec[c]), user.who).run();
    const id = res.meta.last_row_id;
    await audit(env, user, '新增', `#${id} ${rec.name}`);
    return json({ id, warnings: check.warnings }, 201);
  }

  if (recMatch && method === 'PUT') {
    need(user, 'editor');
    const id = recMatch[1];
    const existing = await env.DB.prepare('SELECT id FROM employees WHERE id = ?').bind(id).first();
    if (!existing) throw new HttpError(404, '找不到資料');
    const body = await readJson(request);
    const rec = cleanRecord(body);
    if ('name' in body && !rec.name) throw new HttpError(400, '姓名必填');
    const check = validate(rec);
    if (check.errors.length) throw new HttpError(400, check.errors.join('；'));
    if (rec.id_no) {
      const dup = await env.DB.prepare('SELECT id, name FROM employees WHERE id_no = ? AND id <> ?').bind(rec.id_no, id).first();
      if (dup) throw new HttpError(409, `此身分證字號已建檔（#${dup.id} ${dup.name}）`, { existing_id: dup.id });
    }
    if ('dept_id' in rec) await fillDeptName(env, rec);
    if ('status' in rec && !STATUSES.includes(rec.status)) delete rec.status;
    const cols = FIELDS.filter((f) => rec[f] !== undefined);
    if (!cols.length) return json({ id: Number(id), warnings: [] });
    await env.DB.prepare(
      `UPDATE employees SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(...cols.map((c) => rec[c]), user.who, id).run();
    await audit(env, user, '修改', `#${id} ${cols.join(',')}`);
    return json({ id: Number(id), warnings: check.warnings });
  }

  // ---------- 個人檔案 ----------
  const filesOf = path.match(/^\/api\/records\/(\d+)\/files$/);
  if (filesOf && method === 'GET') {
    need(user, 'editor');
    const { results } = await env.DB.prepare(
      'SELECT id, kind, filename, mime, size, uploaded_by, uploaded_at FROM files WHERE employee_id = ? ORDER BY id DESC',
    ).bind(filesOf[1]).all();
    return json({ items: results });
  }

  if (filesOf && method === 'POST') {
    need(user, 'editor');
    const emp = await env.DB.prepare('SELECT id, name FROM employees WHERE id = ?').bind(filesOf[1]).first();
    if (!emp) throw new HttpError(404, '找不到這位人員');
    const body = await readJson(request);
    const m = String(body.data || '').match(/^data:([\w.+\-/]+);base64,(.+)$/s);
    if (!m) throw new HttpError(400, '檔案格式不正確');
    const mime = m[1].toLowerCase();
    if (!ALLOWED_MIME.test(mime)) throw new HttpError(415, '只接受照片（JPG/PNG/WEBP/HEIC）或 PDF');
    const b64 = m[2].replace(/\s/g, '');
    const size = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    if (size > MAX_FILE) throw new HttpError(413, `檔案太大（上限 ${MAX_FILE / 1024 / 1024}MB）`);
    const filename = String(body.filename || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
    const kind = String(body.kind || '其他').slice(0, 20);
    const res = await env.DB.prepare(
      'INSERT INTO files (employee_id, kind, filename, mime, size, r2_key, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(emp.id, kind, filename, mime, size, 'd1:' + crypto.randomUUID(), user.who).run();
    const fileId = res.meta.last_row_id;
    const stmts = [];
    for (let i = 0, seq = 0; i < b64.length; i += CHUNK_CHARS, seq++) {
      stmts.push(env.DB.prepare('INSERT INTO file_chunks (file_id, seq, data) VALUES (?, ?, ?)').bind(fileId, seq, b64.slice(i, i + CHUNK_CHARS)));
    }
    try { await env.DB.batch(stmts); } catch (e) {
      await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run();
      throw e;
    }
    await audit(env, user, '上傳檔案', `#${emp.id} ${emp.name}：${kind} ${filename}`);
    return json({ id: fileId }, 201);
  }

  const fileMatch = path.match(/^\/api\/files\/(\d+)$/);
  if (fileMatch && method === 'GET') {
    need(user, 'editor');
    const f = await env.DB.prepare('SELECT f.*, e.name AS emp_name FROM files f LEFT JOIN employees e ON e.id = f.employee_id WHERE f.id = ?').bind(fileMatch[1]).first();
    if (!f) throw new HttpError(404, '找不到檔案');
    const { results } = await env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY seq').bind(f.id).all();
    const bin = atob(results.map((r) => r.data).join(''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await audit(env, user, '調閱檔案', `#${f.employee_id} ${f.emp_name || ''}：${f.kind} ${f.filename}`);
    return new Response(bytes, {
      headers: {
        'content-type': f.mime,
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (fileMatch && method === 'DELETE') {
    need(user, 'admin');
    const f = await env.DB.prepare('SELECT id, employee_id, kind, filename FROM files WHERE id = ?').bind(fileMatch[1]).first();
    if (!f) throw new HttpError(404, '找不到檔案');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(f.id),
      env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f.id),
    ]);
    await audit(env, user, '刪除檔案', `#${f.employee_id}：${f.kind} ${f.filename}`);
    return json({ ok: true });
  }

  if (recMatch && method === 'DELETE') {
    need(user, 'admin');
    const row = await env.DB.prepare('SELECT id, name FROM employees WHERE id = ?').bind(recMatch[1]).first();
    if (!row) throw new HttpError(404, '找不到資料');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM files WHERE employee_id = ?)').bind(row.id),
      env.DB.prepare('DELETE FROM files WHERE employee_id = ?').bind(row.id),
    ]);
    await env.DB.prepare('DELETE FROM employees WHERE id = ?').bind(row.id).run();
    await audit(env, user, '刪除', `#${row.id} ${row.name}`);
    return json({ ok: true });
  }

  if (path === '/api/export.csv' && method === 'GET') {
    need(user, 'admin');
    const status = url.searchParams.get('status') || '';
    const where = STATUSES.includes(status) ? ' WHERE status = ?' : '';
    const stmt = env.DB.prepare(`SELECT e.*, d.code AS dept_code FROM employees e LEFT JOIN departments d ON d.id = e.dept_id${where.replace('status', 'e.status')} ORDER BY e.id`);
    const { results } = await (where ? stmt.bind(status) : stmt).all();
    const cols = ['id', 'name', 'id_no', 'gender', 'birth_date', 'mobile', 'phone', 'email', 'address_reg', 'address_mail',
      'emergency_name', 'emergency_relation', 'emergency_phone', 'dept_code', 'dept_name', 'title', 'dispatch_type',
      'salary', 'insurance_salary', 'hire_date', 'note', 'status'];
    const header = cols.map((c) => (c === 'id' ? '系統編號' : c === 'dept_code' ? '派駐社區代號' : FIELD_LABELS[c]));
    const lines = [header, ...results.map((r) => cols.map((c) => r[c] ?? ''))].map((row) => row.map(csvCell).join(','));
    await audit(env, user, '匯出CSV', `${results.length} 筆 ${status}`);
    const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    return new Response('﻿' + lines.join('\r\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="hr-export-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  if (path === '/api/audit' && method === 'GET') {
    need(user, 'admin');
    const { results } = await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
    return json({ items: results });
  }

  throw new HttpError(404, '找不到此 API');
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, '資料格式錯誤'); }
}

async function fillDeptName(env, rec) {
  if (!rec.dept_id) { if ('dept_id' in rec) rec.dept_name = rec.dept_name || null; return; }
  const d = await env.DB.prepare('SELECT name FROM departments WHERE id = ?').bind(rec.dept_id).first();
  if (!d) throw new HttpError(400, '部門不存在，請從清單選擇');
  rec.dept_name = d.name;
}

function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // 防止 Excel 公式注入
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------- 資料清理與檢查 ----------
function cleanRecord(body) {
  const rec = {};
  for (const f of FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (v === null || v === undefined) { rec[f] = null; continue; }
    v = String(v).trim().slice(0, 300);
    rec[f] = v === '' ? null : v;
  }
  if (rec.id_no) rec.id_no = rec.id_no.toUpperCase().replace(/\s/g, '');
  for (const f of ['birth_date', 'hire_date']) if (rec[f]) rec[f] = normalizeDate(rec[f]) || rec[f];
  for (const f of ['mobile', 'phone', 'emergency_phone']) if (rec[f]) rec[f] = rec[f].replace(/[^\d+#\-()]/g, '');
  for (const f of ['salary', 'insurance_salary']) {
    if (rec[f] == null) continue;
    const n = String(rec[f]).replace(/[,，\s元$NT]/gi, '');
    rec[f] = /^\d+(\.\d+)?$/.test(n) ? Math.round(Number(n)) : rec[f];
  }
  return rec;
}

export function normalizeDate(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/\s/g, '');
  let m = t.match(/^(?:民國)?(\d{2,3})[年./\-](\d{1,2})[月./\-](\d{1,2})日?$/);
  if (m && Number(m[1]) < 200) return fmtDate(Number(m[1]) + 1911, m[2], m[3]);
  m = t.match(/^(\d{4})[年./\-](\d{1,2})[月./\-](\d{1,2})日?$/);
  if (m) return fmtDate(Number(m[1]), m[2], m[3]);
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return fmtDate(Number(m[1]), m[2], m[3]);
  m = t.match(/^(\d{3})(\d{2})(\d{2})$/); // 民國 0790102
  if (m) return fmtDate(Number(m[1]) + 1911, m[2], m[3]);
  return null;
}

function fmtDate(y, mo, d) {
  const mm = Number(mo); const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(Date.UTC(y, mm - 1, dd));
  if (dt.getUTCMonth() !== mm - 1) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

const ID_LETTERS = { A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21, N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33 };

export function checkTwId(id) {
  if (!/^[A-Z][1289]\d{8}$/.test(id)) return false;
  const n = ID_LETTERS[id[0]];
  let sum = Math.floor(n / 10) + (n % 10) * 9;
  const w = [8, 7, 6, 5, 4, 3, 2, 1];
  for (let i = 0; i < 8; i++) sum += Number(id[i + 1]) * w[i];
  sum += Number(id[9]);
  return sum % 10 === 0;
}

function validate(rec) {
  const errors = [];
  const warnings = [];
  if (rec.id_no) {
    if (!/^[A-Z][A-Z0-9]\d{8}$/.test(rec.id_no)) errors.push('身分證字號格式不正確（應為 1 個英文字母加 9 碼）');
    else if (/^[A-Z][1289]/.test(rec.id_no) && !checkTwId(rec.id_no)) warnings.push('身分證字號檢查碼不符，請再核對一次');
    else if (/^[A-Z][1289]/.test(rec.id_no)) {
      const g = { 1: '男', 8: '男', 2: '女', 9: '女' }[rec.id_no[1]];
      if (rec.gender && g && rec.gender !== g) warnings.push(`性別與身分證字號不一致（字號顯示為${g}）`);
    }
  }
  for (const f of ['birth_date', 'hire_date']) {
    if (rec[f] && !/^\d{4}-\d{2}-\d{2}$/.test(rec[f])) errors.push(`${FIELD_LABELS[f]}無法辨識，請用 YYYY-MM-DD`);
  }
  if (rec.birth_date && /^\d{4}/.test(rec.birth_date)) {
    const y = Number(rec.birth_date.slice(0, 4));
    const now = new Date().getUTCFullYear();
    if (y < now - 90 || y > now - 14) warnings.push('出生年份看起來不合理，請核對');
  }
  if (rec.mobile && !/^09\d{8}$/.test(rec.mobile.replace(/\D/g, ''))) warnings.push('手機號碼不是 09 開頭 10 碼');
  if (rec.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) warnings.push('Email 格式看起來不正確');
  for (const f of ['salary', 'insurance_salary']) {
    if (rec[f] != null && typeof rec[f] !== 'number') errors.push(`${FIELD_LABELS[f]}請填數字`);
  }
  if (typeof rec.salary === 'number' && typeof rec.insurance_salary === 'number' && rec.insurance_salary < rec.salary) {
    warnings.push('投保級距低於月薪，請確認是否以多報少');
  }
  return { errors, warnings };
}

// 檢視者看不到完整敏感資料
function maskFor(user, r) {
  if (user.role !== 'viewer') return r;
  const m = { ...r };
  if (m.id_no) m.id_no = m.id_no.slice(0, 2) + '*****' + m.id_no.slice(-3);
  for (const f of ['mobile', 'phone', 'emergency_phone']) if (m[f]) m[f] = m[f].slice(0, 4) + '***' + m[f].slice(-3);
  for (const f of ['address_reg', 'address_mail']) if (m[f]) m[f] = m[f].slice(0, 6) + '…';
  if (m.birth_date) m.birth_date = m.birth_date.slice(0, 4) + '-**-**';
  delete m.salary; delete m.insurance_salary;
  return m;
}

// ---------- AI 辨識 ----------
const EXTRACT_PROMPT = `你是台灣人事資料建檔助手。請讀取這張照片（可能是身分證正面、身分證背面、居留證、到職資料表、履歷或其他人事表單），擷取人事資料。

只輸出一個 JSON 物件，不要任何說明文字，格式：
{
  "doc_type": "id_front | id_back | arc | form | resume | other",
  "name": "", "id_no": "", "gender": "男或女", "birth_date": "YYYY-MM-DD（民國年請換算成西元）",
  "mobile": "", "phone": "", "email": "",
  "address_reg": "戶籍地址", "address_mail": "通訊地址",
  "emergency_name": "", "emergency_relation": "", "emergency_phone": "",
  "dept_name": "照片上若有寫派駐社區、部門或案場", "title": "職位", "hire_date": "YYYY-MM-DD",
  "salary": "月薪，只填數字", "insurance_salary": "投保級距／投保薪資，只填數字", "dispatch_type": "派應",
  "note": "其他值得記錄但沒有對應欄位的資訊（不要放配偶、父母姓名）",
  "uncertain": ["看不清楚或沒把握的欄位名稱"]
}

規則：
- 照片上沒有的欄位留空字串，絕對不要猜或編造。
- 身分證字號是 1 個大寫英文字母加 9 碼數字。
- 身分證背面的「住址」填入 address_reg。
- 字跡模糊、反光或被遮住的欄位，照看到的填，並把欄位名放進 uncertain。`;

async function extractWithAI(env, image, docType) {
  if (env.MOCK_AI === '1') {
    return { doc_type: 'id_front', name: '王小明', id_no: 'A123456789', gender: '男', birth_date: '民國79年1月2日', uncertain: ['birth_date'] };
  }
  const hint = docType && docType !== 'auto' ? `\n（使用者表示這是：${docType}）` : '';
  let text;
  if (env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.slice(5, image.indexOf(';')), data: image.slice(image.indexOf(',') + 1) } },
            { type: 'text', text: EXTRACT_PROMPT + hint },
          ],
        }],
      }),
    });
    if (!res.ok) throw new HttpError(502, 'AI 辨識服務錯誤（' + res.status + '）');
    const data = await res.json();
    text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  } else {
    if (!env.AI) throw new HttpError(503, '尚未設定 AI 辨識服務');
    const out = await env.AI.run(env.AI_MODEL || '@cf/qwen/qwen3.8-27b', {
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: EXTRACT_PROMPT + hint },
        ],
      }],
      max_tokens: 2000,
      temperature: 0,
      // 這個模型預設推理強度是最高（xhigh），很慢；讀證件不需要深度推理
      reasoning_effort: env.AI_REASONING || 'low',
    });
    text = typeof out === 'string' ? out
      : out && typeof out.response === 'string' ? out.response
        : out && out.response && typeof out.response === 'object' ? JSON.stringify(out.response)
          : out && out.choices && out.choices[0] && out.choices[0].message ? out.choices[0].message.content
            : JSON.stringify(out);
  }
  return parseJsonLoose(text);
}

export function parseJsonLoose(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new HttpError(502, '辨識失敗，請重拍（照片可能太模糊）');
  try { return JSON.parse(t.slice(start, end + 1)); } catch { throw new HttpError(502, '辨識結果無法解析，請重拍'); }
}

function normalizeExtracted(raw) {
  const rec = cleanRecord(raw || {});
  delete rec.status;
  delete rec.dept_id;
  if (rec.gender && !['男', '女'].includes(rec.gender)) rec.gender = /女|F/i.test(rec.gender) ? '女' : /男|M/i.test(rec.gender) ? '男' : null;
  if (!rec.gender && rec.id_no && /^[A-Z][1289]/.test(rec.id_no)) rec.gender = { 1: '男', 8: '男', 2: '女', 9: '女' }[rec.id_no[1]];
  return rec;
}
