// 制服倉庫庫存管理：靜態頁在 public/，這裡只處理 /api/*
// 資料庫 DB = uniform-stock-db（items：每格每品項的數量；log：每次加減紀錄）
// 若設定了祕密 STOCK_CODE，所有 API 都要帶通行碼（標頭 X-Code）
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    if (env.STOCK_CODE) {
      const c = decodeURIComponent(req.headers.get('X-Code') || '');
      if (c !== env.STOCK_CODE) return J({ error: '通行碼不對' }, 401);
    }

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

    return J({ error: '找不到' }, 404);
  },
};
