// 讓網站可以「加到主畫面／安裝成 App」。一律走網路，不快取資料，數量永遠是最新的。
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });
