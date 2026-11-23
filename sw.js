const CACHE_NAME = 'prepaid-ledger-v1.0.0-beta.62';
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

// HTML 화면을 네트워크에서 기다리는 최대 시간(beta.55, A-7). 넘으면 캐시 화면을 먼저 보여 준다.
const NAV_TIMEOUT_MS = 3500;
// 앱 화면 자체(./ 또는 ./index.html)인가 — 그 경우에만 캐시의 index.html로 대신할 수 있다(문서 페이지는 제 사본만).
function isAppShell(req) {
  try {
    const u = new URL(req.url);
    const scope = new URL(self.registration ? self.registration.scope : self.location.href);
    if (u.origin !== scope.origin || !u.pathname.startsWith(scope.pathname)) return false;
    const rest = u.pathname.slice(scope.pathname.length);
    return rest === '' || rest === 'index.html';
  } catch (err) { return false; }
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

  // beta.61: 가게 색인(storeidx/)은 서비스워커가 손대지 않는다 — 크고(구 하나에 수 MB) 매일 새로 만들어지는 자료라
  //   캐시에 쌓으면 저장 공간만 차지하고 낡은 목록을 보여 준다. 앱은 실행 중 메모리에만 둔다(브라우저 기본 경로로 통과).
  try { if (/\/storeidx\//.test(new URL(req.url).pathname)) return; } catch (err) { /* 그대로 아래로 */ }

  // HTML 문서(화면 자체)는 네트워크 우선: 온라인이면 항상 최신 버전을 받고,
  // 오프라인일 때만 캐시로 폴백한다. (구버전에 갇히는 문제 방지)
  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');
  // beta.55(A-7): 단, 네트워크를 **무한히 기다리지 않는다**. 가게 와이파이가 "연결은 됐는데 아무것도 오지 않는"
  //   상태면 예전에는 빈 화면이 끝없이 떠 있었고, 사장님은 고치려다 '사이트 데이터 삭제'(= 장부 삭제)에 손이 갔다.
  //   → 3.5초 안에 답이 없고 캐시에 화면이 있으면 캐시 화면을 먼저 보여 준다. 네트워크가 늦게라도 답하면
  //     그 응답으로 캐시를 갱신해 둔다(다음 실행에 최신 화면). 캐시가 없으면(첫 설치) 네트워크를 끝까지 기다린다.
  if (isHTML) {
    const network = fetch(req).then(response => {
      if (cacheable(response)) {
        const clone = response.clone();
        return caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {}).then(() => response);
      }
      return response;
    });
    e.waitUntil(network.catch(() => {}));
    const cachedShell = () => caches.match(req).then(r => r || (isAppShell(req) ? caches.match('./index.html') : undefined));
    // beta.60(앱 12): 서버가 **빨리** 오류(503 등)를 주면 위 race에서 그 오류 응답이 이겨, 정상 화면이 캐시에 있는데도 오류 페이지가 떴다
    //   (.catch는 '거절'에만 걸리고 오류 응답은 정상 완료다). 앱 화면의 비정상 응답은 캐시 화면으로 대신하고, 캐시가 없을 때만 그 응답을 보여 준다.
    //   대상: 앱 화면(./·index.html)은 모든 비정상 응답, 그 밖의 문서는 5xx·408·429(일시적 장애)만 — 지운 문서의 404는 그대로 404다.
    //   캐시에 넣는 규칙(cacheable: res.ok만)은 그대로라 404·5xx가 앱 셸을 덮는 일은 없다.
    //   주소 옮김(301 등 — 서비스워커에는 opaqueredirect로 온다)은 그대로 통과시킨다(옛 주소 → 새 주소 이동을 막지 않게).
    const transientBad = res => !!res && res.type !== 'opaqueredirect' && !res.ok && (isAppShell(req) || res.status >= 500 || res.status === 408 || res.status === 429);
    const networkOrCache = network.then(res => transientBad(res) ? cachedShell().then(c => c || res).catch(() => res) : res);
    const slowFallback = new Promise(resolve => {
      setTimeout(() => { cachedShell().then(r => { if (r) resolve(r); }).catch(() => {}); }, NAV_TIMEOUT_MS);
    });
    e.respondWith(
      Promise.race([networkOrCache, slowFallback])
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
