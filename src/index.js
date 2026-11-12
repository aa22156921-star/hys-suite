// 洪英整合系統：一個網址、一個 App，裡面三個系統
//   /            打卡（員工）      ← clockin.js（由 clockin/ 原始碼產生）
//   /admin       整合後台          ← clockin.js
//   /hr/         人事掃描建檔      ← hr/index.js（複製自 hr-scan，API 加上 /hr 前綴）
//   /pay         薪資查詢          ← 服務綁定 PAY（薪資系統原本的 Worker，原樣轉送）
// 資料庫共用：DB = clockin-db（打卡）、HR = hr-scan-db（人事建檔）。三個舊系統照常運作、互不影響。

import clockin from './clockin.js';
import hr from './hr/index.js';
import HR_PAGE from './hr/page.html';
import HR_ICON from './hr/icon.svg';

const PAY_FALLBACK = 'https://honyingsecurity.aa22156921.workers.dev/';
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

// 每一頁右上角的「回主畫面」小按鈕（人事建檔、薪資查詢頁用）
const backBtn = (href, text) =>
  `<a href="${href}" style="position:fixed;right:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:99;background:#0f766e;color:#fff;` +
  `padding:10px 16px;border-radius:999px;font:600 15px/1 -apple-system,'PingFang TC','Noto Sans TC',sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.25)">${text}</a>`;

// 人事建檔頁：API 改走 /hr/api，拿掉離線快取（避免快取到整個網站），加上回後台按鈕
const hrPage = HR_PAGE
  .replace(/(['"`])\/api\//g, '$1/hr/api/')
  .replace(/<link rel="manifest"[^>]*>/, '')
  .replace('href="/icon.svg"', 'href="/hr/icon.svg"')
  .replace(/if \('serviceWorker' in navigator\)[^\n]*\n/, '')
  .replace('</body>', backBtn('/admin', '← 回後台') + '</body>');

function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC } });
}

async function pay(req, env) {
  const url = new URL(req.url);
  const target = new URL('/' + url.search, PAY_FALLBACK);
  const sub = new Request(target, { method: 'GET', headers: { 'User-Agent': req.headers.get('User-Agent') || '' } });
  let r;
  try { r = env.PAY ? await env.PAY.fetch(sub) : await fetch(sub); } catch (e) { r = null; }
  if (!r || !r.ok) return html('<meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:18px sans-serif;padding:24px">薪資查詢暫時連不上，請稍後再試。</p>' + backBtn('/', '← 回打卡'));
  const ct = r.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return r;
  const page = (await r.text()).replace('</body>', backBtn(req.headers.get('Referer') && /\/admin/.test(req.headers.get('Referer')) ? '/admin' : '/', '← 回主畫面') + '</body>');
  return html(page);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;

    // 人事掃描建檔
    if (p === '/hr') return Response.redirect(url.origin + '/hr/', 302);
    if (p === '/hr/' || p === '/hr/index.html') return html(hrPage);
    if (p === '/hr/icon.svg') return new Response(HR_ICON, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
    if (p.startsWith('/hr/api/')) {
      if (!env.HR) return Response.json({ error: '尚未綁定人事資料庫（變數名稱 HR）' }, { status: 500 });
      const sub = new Request(url.origin + p.slice(3) + url.search, req);
      return hr.fetch(sub, { ...env, DB: env.HR, ASSETS: undefined }, ctx);
    }

    // 薪資查詢
    if (p === '/pay' || p === '/pay/') return pay(req, env);

    // 其他全部是打卡（員工頁、後台、App API）
    return clockin.fetch(req, env, ctx);
  },
};
