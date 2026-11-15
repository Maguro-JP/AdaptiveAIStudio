/**
 * スマホの画面の service worker（docs/PHONE.md）。
 *
 * 写しを持つのは画面の殻（頁・見た目・script・絵柄）だけ。/api/ の答えは決して写さない（会話の中身やトークンを端末に残さない）。
 * 殻は「まず本体から取り、取れなければ写し」の順で出す。本体を更新したら、次に開いたときに新しい殻になる。
 */
const CACHE = 'aas-phone-shell-v1';
const SHELL = ['/phone.html', '/phone.css', '/phone.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin !== location.origin || ev.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // 写さない。そのまま本体へ
  if (!SHELL.includes(url.pathname)) return;
  ev.respondWith(fetch(ev.request).then((r) => {
    if (r.ok) { const copy = r.clone(); void caches.open(CACHE).then((c) => c.put(ev.request, copy)); }
    return r;
  }).catch(() => caches.match(ev.request).then((hit) => hit ?? Response.error())));
});
