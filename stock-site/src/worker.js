// 制服倉庫庫存管理：靜態頁在 public/，這裡只處理 /api/*
// 資料庫 DB = uniform-stock-db
//   items：每格每品項的數量（id 例 w1-0-2-0-0 = 第 1 面櫃、區、層、格、項）；deleted=1 表示從清單刪掉；
//          extra = 動態表新增品項的 JSON（name/size/unit/loc/note），這類 id 以 c- 開頭
//   log：每次加減紀錄
// 查看、修改都不用通行碼；之後若設定祕密 STOCK_CODE，修改（POST）就要帶通行碼（標頭 X-Code）
// /edit 跟 / 是同一頁（舊網址保留）
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const ID_RE = /^(w\d-\d+-\d+-\d+-\d+|c-[a-z0-9]{6,20})$/;
const LOCS = ['大門正面櫃', '門簾右排置物區', '層架'];
const str = (v, n) => String(v ?? '').trim().slice(0, n);

async function body(req) { try { return await req.json(); } catch { return null; } }
async function addLog(env, now, id, d, n, who) {
  await env.DB.prepare('INSERT INTO log (ts, item_id, d, n, who) VALUES (?1, ?2, ?3, ?4, ?5)').bind(now, id, d, n, who).run();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (p === '/edit' || p === '/edit/') return env.ASSETS.fetch(new Request(url.origin + '/', req));
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    if (req.method === 'POST' && env.STOCK_CODE) {
      const c = decodeURIComponent(req.headers.get('X-Code') || '');
      if (c !== env.STOCK_CODE) return J({ error: '通行碼不對' }, 401);
    }
    if (p === '/api/check' && req.method === 'POST') return J({ ok: true });

    if (p === '/api/state' && req.method === 'GET') {
      const items = await env.DB.prepare('SELECT id, qty, deleted, extra FROM items').all();
      const log = await env.DB.prepare('SELECT ts, item_id, d, n, who FROM log ORDER BY id DESC LIMIT 100').all();
      const qty = {}, deleted = {}, custom = [];
      for (const r of items.results) {
        qty[r.id] = r.qty;
        if (r.deleted) deleted[r.id] = 1;
        else if (r.extra) { try { custom.push({ id: r.id, ...JSON.parse(r.extra) }); } catch {} }
      }
      return J({ qty, deleted, custom, log: log.results });
    }

    if (req.method !== 'POST') return J({ error: '找不到' }, 404);
    const b = await body(req);
    if (!b) return J({ error: '格式錯誤' }, 400);
    const who = str(b.who, 30), now = new Date().toISOString();

    if (p === '/api/adjust') {
      const id = String(b.id || ''), d = Number(b.d);
      if (!ID_RE.test(id) || !Number.isInteger(d) || d === 0 || Math.abs(d) > 9999) return J({ error: '參數錯誤' }, 400);
      const r = await env.DB.prepare('UPDATE items SET qty = qty + ?1, updated_at = ?2 WHERE id = ?3 AND deleted = 0 AND qty + ?1 >= 0 RETURNING qty').bind(d, now, id).first();
      if (!r) {
        const cur = await env.DB.prepare('SELECT qty FROM items WHERE id = ?1 AND deleted = 0').bind(id).first();
        return J({ error: cur ? `只剩 ${cur.qty}，不夠減` : '找不到這個品項' }, 409);
      }
      await addLog(env, now, id, d, r.qty, who);
      return J({ n: r.qty });
    }

    if (p === '/api/set') {
      const id = String(b.id || ''), n = Number(b.n);
      if (!ID_RE.test(id) || !Number.isInteger(n) || n < 0 || n > 99999) return J({ error: '參數錯誤' }, 400);
      const cur = await env.DB.prepare('SELECT qty FROM items WHERE id = ?1 AND deleted = 0').bind(id).first();
      if (!cur) return J({ error: '找不到這個品項' }, 404);
      await env.DB.prepare('UPDATE items SET qty = ?1, updated_at = ?2 WHERE id = ?3').bind(n, now, id).run();
      if (n !== cur.qty) await addLog(env, now, id, n - cur.qty, n, who);
      return J({ n });
    }

    if (p === '/api/delete') {
      const id = String(b.id || '');
      if (!ID_RE.test(id)) return J({ error: '參數錯誤' }, 400);
      const cur = await env.DB.prepare('SELECT qty FROM items WHERE id = ?1 AND deleted = 0').bind(id).first();
      if (!cur) return J({ error: '找不到這個品項' }, 404);
      await env.DB.prepare('UPDATE items SET deleted = 1, updated_at = ?1 WHERE id = ?2').bind(now, id).run();
      await addLog(env, now, id, -cur.qty, 0, who + '（刪除）');
      return J({ ok: true });
    }

    if (p === '/api/add') {
      const name = str(b.name, 40), loc = LOCS.includes(b.loc) ? b.loc : LOCS[0], n = Number(b.qty);
      if (!name || !Number.isInteger(n) || n < 0 || n > 99999) return J({ error: '參數錯誤' }, 400);
      const extra = JSON.stringify({ name, size: str(b.size, 12), unit: str(b.unit, 4) || '件', loc, note: str(b.note, 80) });
      const id = 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.DB.prepare('INSERT INTO items (id, qty, updated_at, deleted, extra) VALUES (?1, ?2, ?3, 0, ?4)').bind(id, n, now, extra).run();
      await addLog(env, now, id, n, n, who + '（新增）');
      return J({ id });
    }

    return J({ error: '找不到' }, 404);
  },
};
