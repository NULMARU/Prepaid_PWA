const CACHE_NAME = 'prepaid-ledger-v1.0.0-beta.46';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './agency-index.json',
  './agency-depts/seoul.json',
  './agency-departments.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
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

// 캐시에 넣어도 되는 응답인가.
//  · res.ok      : 404·5xx를 앱 셸로 캐시해 두면 서버가 복구된 뒤에도 오류 페이지가 계속 나온다(캐시 오염).
//  · type==='basic': 같은 출처의 정상 응답만. opaque(no-cors)·cors 응답은 담지 않는다.
function cacheable(res) {
  return !!(res && res.ok && res.type === 'basic');
}

// 요청 가로채기
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // ⚠️ 교차 출처 요청은 서비스워커가 아예 손대지 않는다(브라우저 기본 경로로 통과).
  //   예전에는 중계 서버(/api/inbox 등)의 응답까지 stale-while-revalidate로 캐시에 눌러 담아,
  //   기관 명단 **암호문**이 기기의 Cache Storage에 영구히 남았다(수신 즉시 서버에서 지워도 소용없음).
  //   앱 셸 캐시는 어차피 같은 출처의 정적 파일만 필요하다.
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (err) { sameOrigin = false; }
  if (!sameOrigin) return;

  // HTML 문서(화면 자체)는 네트워크 우선: 온라인이면 항상 최신 버전을 받고,
  // 오프라인일 때만 캐시로 폴백한다. (구버전에 갇히는 문제 방지)
  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then(response => {
          if (cacheable(response)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // 그 외 자산: 캐시 우선 + 백그라운드 갱신(stale-while-revalidate)
  e.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req).then(response => {
        if (cacheable(response)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
