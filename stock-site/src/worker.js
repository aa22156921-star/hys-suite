// 制服倉庫庫存管理：靜態頁在 public/，這裡只處理 /api/*
// 資料庫 DB = uniform-stock-db（items：每格每品項的數量；log：每次加減紀錄）
// 查看（GET）不用通行碼；修改（POST）目前也不用。之後若設定祕密 STOCK_CODE，修改就要帶通行碼（標頭 X-Code）
// /edit = 管理版（同一個頁面，顯示加減按鈕）
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

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
      const items = await env.DB.prepare('SELECT id, qty FROM items').all();
      const log = await env.DB.prepare('SELECT ts, item_id, d, n, who FROM log ORDER BY id DESC LIMIT 100').all();
      const qty = {};
      for (const r of items.results) qty[r.id] = r.qty;
      return J({ qty, log: log.results });
    }

    if (p === '/api/adjust' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return J({ error: '格式錯誤' }, 400); }
      const id = String(b.id || ''), d = Number(b.d), who = String(b.who || '').slice(0, 30);
      if (!/^w\d-\d+-\d+-\d+-\d+$/.test(id) || (d !== 1 && d !== -1)) return J({ error: '參數錯誤' }, 400);
      const now = new Date().toISOString();
      const r = await env.DB.prepare('UPDATE items SET qty = qty + ?1, updated_at = ?2 WHERE id = ?3 AND qty + ?1 >= 0 RETURNING qty').bind(d, now, id).first();
      if (!r) {
        const cur = await env.DB.prepare('SELECT qty FROM items WHERE id = ?1').bind(id).first();
        return J({ error: cur ? '已經是 0，不能再減' : '找不到這個品項' }, 409);
      }
      await env.DB.prepare('INSERT INTO log (ts, item_id, d, n, who) VALUES (?1, ?2, ?3, ?4, ?5)').bind(now, id, d, r.qty, who).run();
      return J({ n: r.qty });
    }

    if (p === '/api/set' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return J({ error: '格式錯誤' }, 400); }
      const id = String(b.id || ''), n = Number(b.n), who = String(b.who || '').slice(0, 30);
      if (!/^w\d-\d+-\d+-\d+-\d+$/.test(id) || !Number.isInteger(n) || n < 0 || n > 99999) return J({ error: '參數錯誤' }, 400);
      const cur = await env.DB.prepare('SELECT qty FROM items WHERE id = ?1').bind(id).first();
      if (!cur) return J({ error: '找不到這個品項' }, 404);
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE items SET qty = ?1, updated_at = ?2 WHERE id = ?3').bind(n, now, id).run();
      if (n !== cur.qty) await env.DB.prepare('INSERT INTO log (ts, item_id, d, n, who) VALUES (?1, ?2, ?3, ?4, ?5)').bind(now, id, n - cur.qty, n, who).run();
      return J({ n });
    }

    return J({ error: '找不到' }, 404);
  },
};
