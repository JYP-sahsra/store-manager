// 온라인이면 항상 최신 파일을 받고(network-first), 오프라인이면 캐시로 동작한다.
// 배포할 때마다 CACHE 버전을 올린다(앱 화면의 버전 표시와 새 버전 감지에 쓰인다).
const CACHE = 'store-manager-v15';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/calc.js',
  './js/storage.js',
  './js/api.js',
  './js/calendar.js',
  './js/config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Supabase 등 다른 출처 요청은 건드리지 않는다.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // GitHub Pages는 max-age=600이라, 브라우저 캐시를 건너뛰고 서버에 확인(ETag)해 배포 직후에도 새 파일을 받는다.
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
