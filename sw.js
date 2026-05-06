const CACHE_NAME = 'prepaid-ledger-v2.3.2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// 설치: 파일들을 캐시에 저장
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 활성화: 이전 버전 캐시 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 요청 가로채기: 캐시 우선, 없으면 네트워크
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request)
      .then(cached => {
        if (cached) {
          // 캐시된 것을 먼저 돌려주고, 백그라운드에서 네트워크 업데이트
          const fetchPromise = fetch(e.request).then(response => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
            }
            return response;
          }).catch(() => {});
          return cached;
        }
        return fetch(e.request);
      })
  );
});
