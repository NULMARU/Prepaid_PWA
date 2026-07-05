// 중계 서버 (Cloudflare Worker). 스펙 §1.1·§2.2. 개인정보 평문 미저장·미로깅.
// 핵심 로직은 store 인터페이스에 의존 → D1(운영)과 메모리(테스트)에서 동일 동작.

// CORS: ALLOW_ORIGIN은 콤마 구분 화이트리스트(또는 "*"). Origin 헤더가 없는 요청
// (curl, 하니스, 서버 간 호출)은 차단하지 않고 그냥 CORS 헤더 없이 통과시킨다 —
// CORS는 브라우저 강제 정책이지 서버 인증이 아니므로 여기서 막을 이유가 없다.
function CORS(env, request) {
  const list = String((env && env.ALLOW_ORIGIN) || '*').split(',').map(s => s.trim()).filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agency-Token'
  };
  if (list.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }
  const origin = request && request.headers && request.headers.get('Origin');
  if (origin && list.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}
const json = (env, request, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS(env, request) } });

// 입력 길이 상한(방어적 검증). 초과 시 400.
const MAX_STR = 200;            // 일반 문자열 필드(기관명·부서·연월·검색어·이메일 등)
const MAX_PUBKEY = 8 * 1024;    // 공개키(SPKI base64)
const MAX_CIPHERTEXT = 200 * 1024; // 암호 blob 직렬화(JSON.stringify) 바이트 근사
const MAX_LEDGER_BLOB = 1024 * 1024; // 암호화 원장 백업 blob(base64 문자열) 상한 ~1MB

// 데이터 보존 최소화(PROTOCOL.md §6): 암호문은 수령(승인/거절) 즉시 파기, 미수령 시
// 최대 72시간 후 자동 파기. 비식별 요약(총액·인원·해시)만 30일 보관 후 삭제.
const PENDING_TTL_MS = 72 * 60 * 60 * 1000;       // 미수령 3일(72시간) 만료
const RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 처리 완료(APPROVED/REJECTED/EXPIRED) 후 비식별 요약 보관 기간
const CONSENT_RETENTION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // consent_log(기관·부서·연월·이메일 해시) 보관 기간(§6)
function tooLong(v, max) { return typeof v === 'string' && v.length > max; }
// 업무용 연락처(선택): 오픈채팅 링크는 전화번호·개인 프로필 비노출 형식(open.kakao.com)만 허용.
const KAKAO_LINK_RE = /^https:\/\/open\.kakao\.com\//;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validKakaoLink(v) { return typeof v === 'string' && v.length <= MAX_STR && KAKAO_LINK_RE.test(v); }
function validEmailFormat(v) { return typeof v === 'string' && v.length <= MAX_STR && EMAIL_RE.test(v); }
function validAmount(v) { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 && n <= 1e13; }
function validCount(v) { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 && n <= 100000; }

function uuid() {
  return (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ── 서버측 소유 증명 인증(챌린지-응답)용 crypto 유틸. PROTOCOL.md §2와 동일한 인코딩. ──
const subtle = globalThis.crypto.subtle;
const encU = new TextEncoder(), decU = new TextDecoder();
function b64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function unb64(s) { const x = atob(s), u = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) u[i] = x.charCodeAt(i); return u.buffer; }
async function sha256hex(str) {
  const h = await subtle.digest('SHA-256', encU.encode(str));
  return Array.from(new Uint8Array(h)).map(v => v.toString(16).padStart(2, '0')).join('');
}
function randomB64(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return b64(b.buffer);
}
function randomOtp6() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}
// RSA-OAEP-2048/SHA-256 평문 상한 = 256 - 2*32 - 2 = 190바이트. token_b64(44자)는 여유롭게 들어감.
async function encryptChallenge(publicKeySpkiB64, tokenB64) {
  const pub = await subtle.importKey('spki', unb64(publicKeySpkiB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, encU.encode(tokenB64));
  return b64(ct);
}
// 보호 엔드포인트 공통 인증 검사: SHA-256(auth_token)이 해당 restaurant_id의 미만료 챌린지와
// 일치하면 그 챌린지 행을 삭제(1회용)하고 true. 아니면 false → 호출부에서 401 auth_required.
async function verifyAuth(store, restaurant_id, auth_token) {
  if (!auth_token || !restaurant_id) return false;
  const token_hash = await sha256hex(String(auth_token));
  return await store.consumeChallenge(String(restaurant_id), token_hash);
}
// 기관 OTP 인증 토큰 검증(소비하지 않음 — 24시간 재사용 가능).
async function verifyAgencyToken(store, token) {
  if (!token) return null;
  const token_hash = await sha256hex(String(token));
  const row = await store.getAgencyToken(token_hash);
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}
function isAgencyEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return false;
  const domain = e.slice(at + 1);
  return domain === 'go.kr' || domain.endsWith('.go.kr') || domain === 'korea.kr' || domain.endsWith('.korea.kr');
}

// ── 레이트 리밋(베스트 에포트) ──
// Cloudflare Workers Rate Limiting 바인딩은 wrangler.toml에서 `[[unsafe.bindings]]
// type="ratelimit"`로 선언 가능하지만 이 프로젝트의 compatibility_date/플랜에서 안정적으로
// 검증하지 못해(문서상으로도 계정·플랜 제약이 있어) per-isolate 메모리 Map으로 대체한다.
// 한계(주석으로 명시): Workers는 요청마다 다른 isolate로 라우팅될 수 있어 이 Map은 전역 카운터가
// 아니다 — 완전한 보장이 아닌 베스트 에포트. 운영에서는 Cloudflare 대시보드의
// Rate Limiting Rule(요청 기반, 전역 집계)을 병행 적용할 것을 권장(PROTOCOL.md §6).
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const rateLimitMap = new Map();
function checkRateLimitWith(map, request, max) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return true; // 헤더 없는 요청(로컬·하니스·서버간 호출)은 대상 밖
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    map.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= max;
}
function checkRateLimit(request) { return checkRateLimitWith(rateLimitMap, request, RATE_LIMIT_MAX); }

// 연락처 크롤링 완화(감사 항목 3): /api/public-key는 연락처(카톡 링크·이메일)까지 노출하므로
// 위 전역 한도(분당 60)보다 더 엄격한 IP당 분당 20회로 별도 제한한다. 완전한 방어는 아니다 —
// per-isolate 메모리 Map 한계는 위와 동일(§6.3). 대량 수집을 노리는 공격자는 여러 isolate/IP로
// 분산할 수 있으므로, 운영에서는 Cloudflare 대시보드 Rate Limiting Rule 또는 Turnstile을
// 이 엔드포인트에 병행 적용할 것을 권장한다(PROTOCOL.md §6.3).
const PUBLIC_KEY_RATE_LIMIT_MAX = 20;
const publicKeyRateLimitMap = new Map();
function checkPublicKeyRateLimit(request) { return checkRateLimitWith(publicKeyRateLimitMap, request, PUBLIC_KEY_RATE_LIMIT_MAX); }

// 공공 음식점 조회서비스 프록시 (지역 필수). 키는 서버 시크릿.
// 기본값: data.go.kr 행정안전부_식품_일반음식점 조회서비스(apis.data.go.kr/1741000/general_restaurants).
// serviceKey 는 반드시 "Decoding(일반)" 키를 사용(URL 재인코딩 이중처리 방지).
function extractRows(data) {
  // data.go.kr 표준: response.body.items.item[]
  const b = data && data.response && data.response.body;
  if (b && b.items) { const it = b.items.item != null ? b.items.item : b.items; return Array.isArray(it) ? it : (it ? [it] : []); }
  // LOCALDATA: result.body.rows[0].row[]
  const ld = data && data.result && data.result.body && data.result.body.rows;
  if (Array.isArray(ld)) return (ld[0] && ld[0].row) || [];
  // 배열 그대로
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}
function pick(r, keys) { for (const k of keys) { if (r[k] != null && String(r[k]).trim() !== '') return String(r[k]); } return ''; }
async function defaultSearch(env, region, q) {
  // data.go.kr 행정안전부_식품_일반음식점 조회서비스 /info 오퍼레이션.
  // cond[OPN_ATMY_GRP_CD::EQ]=개방자치단체코드(지역), cond[BPLC_NM::LIKE]=사업장명 검색.
  const key = env.PUBLIC_API_KEY || env.LOCALDATA_KEY;
  if (!key) throw new Error('PUBLIC_API_KEY 미설정');
  const base = env.PUBLIC_API_BASE || 'https://apis.data.go.kr/1741000/general_restaurants/info';
  const regionParam = env.PUBLIC_API_REGION_PARAM || 'cond[OPN_ATMY_GRP_CD::EQ]';
  const nameParam = env.PUBLIC_API_NAME_PARAM || 'cond[BPLC_NM::LIKE]';
  // cond[...] 파라미터명은 브래킷을 리터럴로 유지하고 값만 인코딩(값에 serviceKey +,/,= 포함 가능).
  const params = [['serviceKey', key], ['pageNo', '1'], ['numOfRows', '100'], ['returnType', 'json']];
  if (region) params.push([regionParam, region]);
  if (q) params.push([nameParam, q]);
  const qs = params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const res = await fetch(base + '?' + qs);
  if (!res.ok) throw new Error('공공API HTTP ' + res.status);
  const data = await res.json();
  const hdr = data && data.response && data.response.header;
  if (hdr && hdr.resultCode != null && !['0', '00'].includes(String(hdr.resultCode)))
    throw new Error('공공API 오류: ' + (hdr.resultMsg || hdr.resultCode));
  const rows = extractRows(data);
  const kw = (q || '').trim();
  return rows
    .map(r => ({
      // 행정안전부_식품_일반음식점 조회서비스 실제 필드 우선, LOCALDATA 변형 후순위
      restaurant_id: pick(r, ['MNG_NO', 'mgtNo', 'MGTNO', '관리번호']),
      name: pick(r, ['BPLC_NM', 'bplcNm', 'BPLCNM', '사업장명']),
      address: pick(r, ['ROAD_NM_ADDR', 'LOTNO_ADDR', 'rdnWhlAddr', 'siteWhlAddr', '소재지전체주소']),
      status: pick(r, ['SALS_STTS_NM', 'DTL_SALS_STTS_NM', 'trdStateNm', '영업상태명']),
      category: pick(r, ['BZSTAT_SE_NM', 'SNTTN_BZSTAT_NM']),
      region_code: pick(r, ['OPN_ATMY_GRP_CD'])
    }))
    .filter(r => r.restaurant_id && r.name)
    .filter(r => !r.status.includes('폐업'))   // 영업 중인 곳만
    .filter(r => !kw || r.name.includes(kw));
}

export async function handle(request, env, store) {
  const url = new URL(request.url);
  const path = url.pathname;
  const j = (body, status = 200) => json(env, request, body, status);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(env, request) });
  if (!checkRateLimit(request)) return j({ error: 'rate_limited' }, 429);
  // 연락처 크롤링 완화(감사 항목 3): public-key 조회만 더 낮은 한도로 추가 제한.
  if (path === '/api/public-key' && request.method === 'GET' && !checkPublicKeyRateLimit(request))
    return j({ error: 'rate_limited' }, 429);

  try {
    if (path === '/api/register-key' && request.method === 'POST') {
      const b = await request.json();
      if (!b.restaurant_id || !b.public_key) return j({ error: 'restaurant_id·public_key 필요' }, 400);
      const restaurant_id = String(b.restaurant_id);
      const restaurant_name = String(b.restaurant_name || '');
      const public_key = String(b.public_key);
      if (tooLong(restaurant_id, MAX_STR) || tooLong(restaurant_name, MAX_STR) || tooLong(public_key, MAX_PUBKEY))
        return j({ error: '입력 길이 초과' }, 400);
      // 침묵 덮어쓰기 방지: 이미 등록된 restaurant_id에 '다른' 공개키로 재등록하려면
      // 기존 키 소유를 증명(챌린지-응답)해야 한다. 동일 키 재등록은 앱 재시도(네트워크 실패 등)일
      // 수 있으므로 인증 없이 200(멱등). 최초 등록은 선착순으로 인증 불요.
      const existing = await store.getPublicKey(restaurant_id);
      if (existing) {
        if (existing.public_key === public_key) return j({ ok: true });
        const authed = await verifyAuth(store, restaurant_id, b.auth_token);
        if (!authed) return j({ error: 'auth_required' }, 401);
        await store.updateKey({ restaurant_id, restaurant_name, public_key, registered_at: Date.now() });
        return j({ ok: true });
      }
      await store.registerKey({ restaurant_id, restaurant_name, public_key, registered_at: Date.now() });
      return j({ ok: true });
    }

    if (path === '/api/public-key' && request.method === 'GET') {
      const id = url.searchParams.get('restaurant_id') || '';
      const row = await store.getPublicKey(id);
      if (!row) return j({ error: '등록된 공개키 없음' }, 404);
      return j({
        restaurant_id: row.restaurant_id, public_key: row.public_key,
        contact: { kakao_link: row.contact_kakao || null, email: row.contact_email || null }
      });
    }

    // 소유 증명 챌린지 발급. 등록된 공개키로 무작위 토큰을 봉인해 돌려주고,
    // 해시만 서버에 5분 보관한다(평문 토큰은 저장하지 않음).
    if (path === '/api/challenge' && request.method === 'POST') {
      const b = await request.json();
      const restaurant_id = String(b.restaurant_id || '');
      if (!restaurant_id) return j({ error: 'restaurant_id 필요' }, 400);
      if (tooLong(restaurant_id, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      const row = await store.getPublicKey(restaurant_id);
      if (!row) return j({ error: '등록된 공개키 없음' }, 404);
      const token_b64 = randomB64(32);
      const token_hash = await sha256hex(token_b64);
      await store.createChallenge({ restaurant_id, token_hash, expires_at: Date.now() + 5 * 60 * 1000 });
      const challenge_ct = await encryptChallenge(row.public_key, token_b64);
      return j({ challenge_ct });
    }

    // 음식점 주인 등록 해제 (선금 받기 중단). 공개키 삭제 → 담당자가 더는 전송 불가.
    // 소유 증명(auth_token) 필요.
    if (path === '/api/deregister' && request.method === 'POST') {
      const b = await request.json();
      const restaurant_id = String(b.restaurant_id || '');
      if (!restaurant_id) return j({ error: 'restaurant_id 필요' }, 400);
      const authed = await verifyAuth(store, restaurant_id, b.auth_token);
      if (!authed) return j({ error: 'auth_required' }, 401);
      await store.deregisterKey(restaurant_id);
      // 등록 해제 시 클라우드 원장 백업(§4.2)도 함께 삭제(감사 항목 2) — 공개키가 없으면
      // 더는 소유 증명(챌린지-응답)을 발급할 수 없어 백업을 되찾을 방법이 사라지므로,
      // 서버에 죽은 데이터로 남기지 않고 즉시 정리한다.
      await store.deleteLedgerBackup(restaurant_id);
      return j({ ok: true });
    }

    // 음식점 주인이 직접 등록·삭제하는 선택적 "업무용 연락처"(카톡 오픈채팅 링크·공식 접수
    // 이메일). 소유 증명(auth_token) 필요. 빈 문자열을 보내면 해당 필드를 삭제(NULL)한다.
    if (path === '/api/contact' && request.method === 'POST') {
      const b = await request.json();
      const restaurant_id = String(b.restaurant_id || '');
      if (!restaurant_id) return j({ error: 'restaurant_id 필요' }, 400);
      if (tooLong(restaurant_id, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      const authed = await verifyAuth(store, restaurant_id, b.auth_token);
      if (!authed) return j({ error: 'auth_required' }, 401);
      const kakaoRaw = b.kakao_link != null ? String(b.kakao_link) : '';
      const emailRaw = b.email != null ? String(b.email) : '';
      if (kakaoRaw && !validKakaoLink(kakaoRaw)) return j({ error: 'invalid_kakao_link' }, 400);
      if (emailRaw && !validEmailFormat(emailRaw)) return j({ error: 'invalid_email' }, 400);
      const row = await store.getPublicKey(restaurant_id);
      if (!row) return j({ error: 'not_found' }, 404);
      await store.setContact(restaurant_id, { kakao_link: kakaoRaw || null, email: emailRaw || null });
      return j({ ok: true });
    }

    // 담당자 웹: 후보 음식점 중 '선금 받기 가능(등록된)' 목록만 반환.
    if (path === '/api/registered' && request.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      return j(await store.registeredAmong(ids));
    }

    if (path === '/api/restaurants' && request.method === 'GET') {
      const region = url.searchParams.get('region') || '';
      const q = url.searchParams.get('q') || '';
      if (!region && !q) return j({ error: '지역 또는 가게 이름이 필요합니다' }, 400);
      if (tooLong(region, MAX_STR) || tooLong(q, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      const search = env.searchRestaurants || defaultSearch;
      const list = await search(env, region, q);
      return j(list);
    }

    if (path === '/api/submit' && request.method === 'POST') {
      const b = await request.json();
      const s = b.summary, blob = b.blob, consent = b.consent;
      if (!s || !blob || !blob.ciphertext) return j({ error: 'summary·blob 필요' }, 400);
      // 평문 PII 방어: ciphertext는 객체(암호 blob)여야 하며, 알려진 평문 필드가 오면 거부
      if (typeof blob.ciphertext !== 'object' || !blob.ciphertext.ct || !blob.ciphertext.encKey)
        return j({ error: 'ciphertext 형식 오류(암호 blob 아님)' }, 400);
      const institution = String(s.institution || ''), department = String(s.department || '');
      const restaurant_id = String(s.restaurant_id || ''), restaurant_name = String(s.restaurant_name || '');
      const year_month = String(s.year_month || ''), batch_hash = String(s.batch_hash || '');
      const blob_restaurant_id = String(blob.restaurant_id || s.restaurant_id || '');
      if ([institution, department, restaurant_id, restaurant_name, year_month, batch_hash, blob_restaurant_id]
        .some(v => tooLong(v, MAX_STR)))
        return j({ error: '입력 길이 초과' }, 400);
      const ciphertextStr = JSON.stringify(blob.ciphertext);
      if (ciphertextStr.length > MAX_CIPHERTEXT) return j({ error: '입력 길이 초과' }, 400);
      // 금액/인원 검증: Number()|0 은 NaN·음수·32비트 랩어라운드를 조용히 0/오값으로 만드는 버그였음.
      if (!validAmount(s.total_amount)) return j({ error: 'total_amount 유효하지 않음' }, 400);
      if (!validCount(s.member_count)) return j({ error: 'member_count 유효하지 않음' }, 400);
      const total_amount = Number(s.total_amount), member_count = Number(s.member_count);

      // 기관 OTP 인증(단계적 활성화): REQUIRE_AGENCY_AUTH="1"이면 X-Agency-Token 필수.
      // 아니면 토큰이 없어도 허용하되, 있으면 검증 후 consent_log에 이메일 '해시'만 남긴다.
      const agencyToken = request.headers.get('X-Agency-Token') || '';
      let agencyRow = null;
      if (agencyToken) agencyRow = await verifyAgencyToken(store, agencyToken);
      if (env.REQUIRE_AGENCY_AUTH === '1' && !agencyRow) return j({ error: 'agency_auth_required' }, 401);

      // 중복 제출 방지(멱등): 동일 (restaurant_id, batch_hash) 조합이 이미 있으면 새로 만들지 않고 기존 id 반환.
      if (batch_hash) {
        const dup = await store.findSummaryByBatch(restaurant_id, batch_hash);
        if (dup) return j({ summary_id: dup.id });
      }

      const summary_id = uuid();
      await store.insertSummary({
        id: summary_id,
        institution, department, restaurant_id, restaurant_name, year_month,
        total_amount, member_count,
        batch_hash, status: 'PENDING', created_at: Date.now()
      });
      await store.insertBlob({
        id: uuid(), summary_id, restaurant_id: blob_restaurant_id,
        ciphertext: ciphertextStr, delivered: 0, created_at: Date.now()
      });
      if (consent) {
        const cInstitution = String(consent.institution || ''), cDepartment = String(consent.department || '');
        const cYearMonth = String(consent.year_month || '');
        if ([cInstitution, cDepartment, cYearMonth].some(v => tooLong(v, MAX_STR)))
          return j({ error: '입력 길이 초과' }, 400);
        await store.insertConsent({
          id: uuid(), institution: cInstitution, department: cDepartment, year_month: cYearMonth,
          agency_email_hash: agencyRow ? await sha256hex(agencyRow.email) : null,
          consented_at: Date.now()
        });
      }
      return j({ summary_id });
    }

    if (path === '/api/inbox' && request.method === 'GET') {
      const id = url.searchParams.get('restaurant_id') || '';
      if (!id) return j({ error: 'restaurant_id 필요' }, 400);
      const items = await store.inbox(id);
      return j(items);
    }

    if (path === '/api/approve' && request.method === 'POST') {
      const b = await request.json();
      const status = b.status === 'APPROVED' ? 'APPROVED' : b.status === 'REJECTED' ? 'REJECTED' : null;
      if (!b.summary_id || !status || !b.restaurant_id) return j({ error: 'summary_id·status·restaurant_id 필요' }, 400);
      const summary_id = String(b.summary_id), restaurant_id = String(b.restaurant_id);
      const existing = await store.getSummary(summary_id);
      if (!existing) return j({ error: 'not_found' }, 404);
      if (existing.restaurant_id !== restaurant_id) return j({ error: 'restaurant_mismatch' }, 403);
      // 소유 증명(auth_token) 필요 — 챌린지를 발급받은 그 음식점만 승인/거절 가능.
      const authed = await verifyAuth(store, restaurant_id, b.auth_token);
      if (!authed) return j({ error: 'auth_required' }, 401);
      // 상태 전이 가드: PENDING → (APPROVED|REJECTED) 만 허용. 이미 처리·만료된 건 재처리 방지.
      const changed = await store.setStatus(summary_id, status);
      if (!changed) return j({ error: 'already_processed' }, 409);
      // 데이터 보존 최소화(PROTOCOL.md §6): 수령(승인/거절) 즉시 암호문 파기. 상태 전이가
      // 성공한 경우에만 삭제하므로(같은 순서로만 실행) 전이 실패 시 blob은 남아 재시도 가능.
      await store.deleteBlob(summary_id);
      return j({ ok: true });
    }

    // ── 암호화 원장 클라우드 백업 (zero-knowledge). blob은 클라이언트가 자기 공개키로
    // 하이브리드 암호화한 base64 — 서버는 복호화할 수 없다. 소유 증명 필요. ──
    if (path === '/api/ledger-backup' && request.method === 'POST') {
      const b = await request.json();
      const restaurant_id = String(b.restaurant_id || '');
      const blob = b.blob, blob_hash = String(b.blob_hash || '');
      if (!restaurant_id || typeof blob !== 'string' || !blob) return j({ error: 'restaurant_id·blob 필요' }, 400);
      if (tooLong(restaurant_id, MAX_STR) || tooLong(blob_hash, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      if (blob.length > MAX_LEDGER_BLOB) return j({ error: 'blob 크기 초과(1MB)' }, 400);
      const authed = await verifyAuth(store, restaurant_id, b.auth_token);
      if (!authed) return j({ error: 'auth_required' }, 401);
      await store.upsertLedgerBackup({ restaurant_id, blob, blob_hash, updated_at: Date.now() });
      return j({ ok: true });
    }

    if (path === '/api/ledger-backup/get' && request.method === 'POST') {
      const b = await request.json();
      const restaurant_id = String(b.restaurant_id || '');
      if (!restaurant_id) return j({ error: 'restaurant_id 필요' }, 400);
      const authed = await verifyAuth(store, restaurant_id, b.auth_token);
      if (!authed) return j({ error: 'auth_required' }, 401);
      const row = await store.getLedgerBackup(restaurant_id);
      if (!row) return j({ error: 'not_found' }, 404);
      return j({ blob: row.blob, blob_hash: row.blob_hash, updated_at: row.updated_at });
    }

    // 백업을 직접 지우고 싶을 때(예: 기기를 되찾아 클라우드 백업이 더는 필요 없을 때) 사용.
    // 소유 증명(auth_token) 필요(감사 항목 2).
    if (path === '/api/ledger-backup/delete' && request.method === 'POST') {
      const b = await request.json();
      const restaurant_id = String(b.restaurant_id || '');
      if (!restaurant_id) return j({ error: 'restaurant_id 필요' }, 400);
      const authed = await verifyAuth(store, restaurant_id, b.auth_token);
      if (!authed) return j({ error: 'auth_required' }, 401);
      const row = await store.getLedgerBackup(restaurant_id);
      if (!row) return j({ error: 'not_found' }, 404);
      await store.deleteLedgerBackup(restaurant_id);
      return j({ ok: true });
    }

    // ── 기관 OTP 인증 인프라 (단계적 활성화). 실제 이메일 발송은 아직 미구현. ──
    if (path === '/api/agency/request-otp' && request.method === 'POST') {
      const b = await request.json();
      const email = String(b.email || '').trim();
      if (!email) return j({ error: 'email 필요' }, 400);
      if (tooLong(email, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      if (!isAgencyEmail(email)) return j({ error: 'invalid_domain' }, 400);
      const now = Date.now();
      const existing = await store.getAgencyOtp(email);
      if (existing && existing.created_at && now - existing.created_at < 60 * 1000)
        return j({ error: 'rate_limited' }, 429);
      const otp = randomOtp6();
      const otp_hash = await sha256hex(otp);
      await store.upsertAgencyOtp({ email, otp_hash, expires_at: now + 10 * 60 * 1000, attempts: 0, created_at: now });
      // TODO: EMAIL 바인딩 연결 — Cloudflare Email Sending/Workers 이메일 라우팅으로 OTP를
      // 실제 발송하도록 교체(PROTOCOL.md §7 업그레이드 경로 참조). 감사 항목 1: 어떤 응답에도
      // 평문 OTP가 실려나가서는 안 되므로, dev_otp는 AUTH_MODE==='dev'(로컬 개발 전용)일 때만
      // 포함한다. "pilot"(베타 운영값)·"prod"는 dev_otp를 절대 포함하지 않는다 — pilot은 실제
      // 이메일 발송 인프라가 아직 없어 담당자가 OTP를 받을 방법이 없으므로, agency-web이 이
      // 사실을 "정식 이메일 인증은 준비 중"이라고 정직하게 표시하고 형식 확인 수준으로만
      // 진행하도록 처리한다(REQUIRE_AGENCY_AUTH='0' 유지로 제출 자체는 막히지 않음).
      if (env.AUTH_MODE === 'dev') return j({ ok: true, dev_otp: otp });
      return j({ ok: true });
    }

    if (path === '/api/agency/verify-otp' && request.method === 'POST') {
      const b = await request.json();
      const email = String(b.email || '').trim();
      const otp = String(b.otp || '');
      if (!email || !otp) return j({ error: 'email·otp 필요' }, 400);
      if (tooLong(email, MAX_STR) || tooLong(otp, 20)) return j({ error: '입력 길이 초과' }, 400);
      const row = await store.getAgencyOtp(email);
      if (!row || row.expires_at < Date.now()) return j({ error: 'invalid_otp' }, 401);
      if (row.attempts >= 5) return j({ error: 'too_many_attempts' }, 429);
      const otp_hash = await sha256hex(otp);
      if (otp_hash !== row.otp_hash) {
        await store.incrementAgencyOtpAttempts(email);
        return j({ error: 'invalid_otp' }, 401);
      }
      await store.deleteAgencyOtp(email);
      const token = randomB64(32);
      const token_hash = await sha256hex(token);
      await store.createAgencyToken({ token_hash, email, expires_at: Date.now() + 24 * 60 * 60 * 1000 });
      return j({ token });
    }

    return j({ error: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    return json(env, request, { error: 'internal' }, 500);
  }
}

// ── D1 store (운영) ──
export function makeD1Store(DB) {
  return {
    async registerKey(r) {
      // 침묵 덮어쓰기 방지: 이미 등록된 restaurant_id는 handle()에서 사전 차단하므로
      // 여기서는 신규 삽입만 수행(다른 키로의 재등록은 updateKey를 통해서만 가능).
      await DB.prepare('INSERT INTO public_key_registry (restaurant_id,restaurant_name,public_key,registered_at) VALUES (?,?,?,?)')
        .bind(r.restaurant_id, r.restaurant_name, r.public_key, r.registered_at).run();
    },
    async updateKey(r) {
      // 소유 증명(챌린지-응답) 통과 후에만 handle()에서 호출됨.
      await DB.prepare('UPDATE public_key_registry SET restaurant_name=?, public_key=?, registered_at=? WHERE restaurant_id=?')
        .bind(r.restaurant_name, r.public_key, r.registered_at, r.restaurant_id).run();
    },
    async getPublicKey(id) {
      return await DB.prepare('SELECT restaurant_id,public_key,contact_kakao,contact_email FROM public_key_registry WHERE restaurant_id=?').bind(id).first();
    },
    async deregisterKey(id) {
      // 연락처(contact_kakao/contact_email)도 같은 행에 있으므로 행 삭제로 함께 삭제된다.
      await DB.prepare('DELETE FROM public_key_registry WHERE restaurant_id=?').bind(id).run();
    },
    // 업무용 연락처(선택) upsert. 대상 restaurant_id가 없으면 영향 row 0(호출부에서 404 사전 체크).
    async setContact(restaurant_id, contact) {
      await DB.prepare('UPDATE public_key_registry SET contact_kakao=?, contact_email=? WHERE restaurant_id=?')
        .bind(contact.kakao_link, contact.email, restaurant_id).run();
    },
    async registeredAmong(ids) {
      if (!ids.length) return [];
      const ph = ids.map(() => '?').join(',');
      const r = await DB.prepare('SELECT restaurant_id FROM public_key_registry WHERE restaurant_id IN (' + ph + ')').bind(...ids).all();
      return (r.results || []).map(x => x.restaurant_id);
    },
    async insertSummary(s) {
      await DB.prepare('INSERT INTO deposit_summary (id,institution,department,restaurant_id,restaurant_name,year_month,total_amount,member_count,batch_hash,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(s.id, s.institution, s.department, s.restaurant_id, s.restaurant_name, s.year_month, s.total_amount, s.member_count, s.batch_hash, s.status, s.created_at).run();
    },
    async insertBlob(b) {
      await DB.prepare('INSERT INTO encrypted_blob (id,summary_id,restaurant_id,ciphertext,delivered,created_at) VALUES (?,?,?,?,?,?)')
        .bind(b.id, b.summary_id, b.restaurant_id, b.ciphertext, b.delivered, b.created_at).run();
    },
    async insertConsent(c) {
      await DB.prepare('INSERT INTO consent_log (id,institution,department,year_month,agency_email_hash,consented_at) VALUES (?,?,?,?,?,?)')
        .bind(c.id, c.institution, c.department, c.year_month, c.agency_email_hash || null, c.consented_at).run();
    },
    async findSummaryByBatch(restaurant_id, batch_hash) {
      return await DB.prepare('SELECT id FROM deposit_summary WHERE restaurant_id=? AND batch_hash=? LIMIT 1')
        .bind(restaurant_id, batch_hash).first();
    },
    async getSummary(id) {
      return await DB.prepare('SELECT id, restaurant_id, status FROM deposit_summary WHERE id=?').bind(id).first();
    },
    async inbox(restaurant_id) {
      // 이중 방어(§6): cron이 하루 1회뿐이므로 status='PENDING'이어도 72시간 지난 항목은
      // 쿼리 조건(created_at)으로 직접 걸러낸다(cron이 아직 EXPIRED로 전이시키기 전이어도 안전).
      const cutoff = Date.now() - PENDING_TTL_MS;
      const r = await DB.prepare("SELECT s.id as summary_id, s.institution, s.department, s.restaurant_id, s.restaurant_name, s.year_month, s.total_amount, s.member_count, s.batch_hash, s.status, b.ciphertext FROM deposit_summary s JOIN encrypted_blob b ON b.summary_id=s.id WHERE s.restaurant_id=? AND s.status='PENDING' AND s.created_at>? ORDER BY s.created_at").bind(restaurant_id, cutoff).all();
      return (r.results || []).map(row => ({
        summary_id: row.summary_id,
        summary: { institution: row.institution, department: row.department, restaurant_id: row.restaurant_id, restaurant_name: row.restaurant_name, year_month: row.year_month, total_amount: row.total_amount, member_count: row.member_count, batch_hash: row.batch_hash },
        ciphertext: JSON.parse(row.ciphertext), status: row.status
      }));
    },
    async setStatus(summary_id, status) {
      // 상태 전이 가드: PENDING인 건만 전이 가능. 영향 row 0이면 이미 처리·만료된 것.
      // processed_at: TTL 정리(30일) 기준 시각.
      const r = await DB.prepare("UPDATE deposit_summary SET status=?, processed_at=? WHERE id=? AND status='PENDING'")
        .bind(status, Date.now(), summary_id).run();
      return !!(r && r.meta && r.meta.changes > 0);
    },
    async deleteBlob(summary_id) {
      // 데이터 보존 최소화: 수령(승인/거절) 즉시 또는 미수령 만료 시 암호문 파기.
      await DB.prepare('DELETE FROM encrypted_blob WHERE summary_id=?').bind(summary_id).run();
    },
    // ── 소유 증명 챌린지 ──
    async createChallenge(c) {
      await DB.prepare('INSERT INTO auth_challenge (restaurant_id,token_hash,expires_at) VALUES (?,?,?)')
        .bind(c.restaurant_id, c.token_hash, c.expires_at).run();
    },
    async consumeChallenge(restaurant_id, token_hash) {
      // 단일 DELETE로 조회+소비를 원자적으로 수행(경쟁 상태 방지).
      const now = Date.now();
      const r = await DB.prepare('DELETE FROM auth_challenge WHERE restaurant_id=? AND token_hash=? AND expires_at>?')
        .bind(restaurant_id, token_hash, now).run();
      return !!(r && r.meta && r.meta.changes > 0);
    },
    // ── 암호화 원장 백업 ──
    async upsertLedgerBackup(b) {
      await DB.prepare('INSERT INTO ledger_backup (restaurant_id,blob,blob_hash,updated_at) VALUES (?,?,?,?) ON CONFLICT(restaurant_id) DO UPDATE SET blob=excluded.blob, blob_hash=excluded.blob_hash, updated_at=excluded.updated_at')
        .bind(b.restaurant_id, b.blob, b.blob_hash, b.updated_at).run();
    },
    async getLedgerBackup(restaurant_id) {
      return await DB.prepare('SELECT blob, blob_hash, updated_at FROM ledger_backup WHERE restaurant_id=?').bind(restaurant_id).first();
    },
    async deleteLedgerBackup(restaurant_id) {
      await DB.prepare('DELETE FROM ledger_backup WHERE restaurant_id=?').bind(restaurant_id).run();
    },
    // ── 기관 OTP ──
    async getAgencyOtp(email) {
      return await DB.prepare('SELECT email, otp_hash, expires_at, attempts, created_at FROM agency_otp WHERE email=?').bind(email).first();
    },
    async upsertAgencyOtp(o) {
      await DB.prepare('DELETE FROM agency_otp WHERE email=?').bind(o.email).run();
      await DB.prepare('INSERT INTO agency_otp (email,otp_hash,expires_at,attempts,created_at) VALUES (?,?,?,?,?)')
        .bind(o.email, o.otp_hash, o.expires_at, o.attempts, o.created_at).run();
    },
    async incrementAgencyOtpAttempts(email) {
      await DB.prepare('UPDATE agency_otp SET attempts=attempts+1 WHERE email=?').bind(email).run();
    },
    async deleteAgencyOtp(email) {
      await DB.prepare('DELETE FROM agency_otp WHERE email=?').bind(email).run();
    },
    async createAgencyToken(t) {
      await DB.prepare('INSERT INTO agency_token (token_hash,email,expires_at) VALUES (?,?,?)')
        .bind(t.token_hash, t.email, t.expires_at).run();
    },
    async getAgencyToken(token_hash) {
      return await DB.prepare('SELECT email, expires_at FROM agency_token WHERE token_hash=?').bind(token_hash).first();
    },
    // ── TTL 정리(개인정보 최소화 목적). cron에서 호출. ──
    async cleanupTTL(now) {
      // 1) 미수령 72시간 경과 PENDING → EXPIRED 전이 + blob 즉시 파기(§6). inbox 쿼리도
      // 별도로 created_at 조건을 걸어 이중 방어하므로, 이 단계는 cron 주기(1일) 동안의
      // 저장 최소화를 담당한다.
      const pendingCutoff = now - PENDING_TTL_MS;
      const expiredRows = await DB.prepare("SELECT id FROM deposit_summary WHERE status='PENDING' AND created_at < ?").bind(pendingCutoff).all();
      const expiredIds = (expiredRows.results || []).map(r => r.id);
      for (const id of expiredIds) {
        await DB.prepare('DELETE FROM encrypted_blob WHERE summary_id=?').bind(id).run();
        await DB.prepare("UPDATE deposit_summary SET status='EXPIRED', processed_at=? WHERE id=?").bind(now, id).run();
      }
      // 2) 처리 완료(APPROVED/REJECTED/EXPIRED) 후 30일 지난 비식별 요약 삭제.
      const cutoff = now - RETENTION_TTL_MS;
      const rows = await DB.prepare("SELECT id FROM deposit_summary WHERE status IN ('APPROVED','REJECTED','EXPIRED') AND processed_at IS NOT NULL AND processed_at < ?").bind(cutoff).all();
      const ids = (rows.results || []).map(r => r.id);
      for (const id of ids) {
        await DB.prepare('DELETE FROM encrypted_blob WHERE summary_id=?').bind(id).run();
        await DB.prepare('DELETE FROM deposit_summary WHERE id=?').bind(id).run();
      }
      await DB.prepare('DELETE FROM auth_challenge WHERE expires_at<?').bind(now).run();
      await DB.prepare('DELETE FROM agency_otp WHERE expires_at<?').bind(now).run();
      await DB.prepare('DELETE FROM agency_token WHERE expires_at<?').bind(now).run();
      // 3) consent_log(기관·부서·연월·이메일 해시)도 무기한 보관하지 않고 180일 후 삭제(§6).
      await DB.prepare('DELETE FROM consent_log WHERE consented_at < ?').bind(now - CONSENT_RETENTION_TTL_MS).run();
      return { deletedSummaries: ids.length, expiredSummaries: expiredIds.length };
    }
  };
}

// Cloudflare 진입점
export default {
  async fetch(request, env) {
    return handle(request, env, makeD1Store(env.DB));
  },
  // 개인정보 최소화 목적 TTL cron: ① 미수령(PENDING) 72시간 경과 항목을 EXPIRED로 전이하고
  // 암호 blob을 즉시 파기, ② 처리 완료(APPROVED/REJECTED/EXPIRED) 후 30일 지난 비식별 집계와
  // 만료된 인증 챌린지/기관 OTP/기관 토큰을 정리한다(암호 blob은 승인/거절 시 이미 즉시
  // 삭제되므로 이 단계에서는 대개 no-op). 서버는 zero-knowledge이므로 원장 진실은 항상 음식점
  // 기기에 있다 — 이 정리는 서버 보관 데이터를 최소화할 뿐 데이터 손실이 아니다.
  async scheduled(event, env, ctx) {
    const store = makeD1Store(env.DB);
    ctx.waitUntil((async () => {
      const result = await store.cleanupTTL(Date.now());
      console.log('TTL cleanup', result);
    })());
  }
};

// ── 메모리 store (테스트) ──
export function makeMemoryStore() {
  const keys = new Map(), summaries = [], blobs = [], consents = [];
  const challenges = [], ledgerBackups = new Map(), agencyOtps = new Map(), agencyTokens = new Map();
  return {
    _dump: () => ({ keys, summaries, blobs, consents, challenges, ledgerBackups, agencyOtps, agencyTokens }),
    // 침묵 덮어쓰기 방지: 이미 등록된 restaurant_id는 handle()에서 사전 차단하므로
    // 여기서는 신규 삽입만 수행(다른 키로의 재등록은 updateKey를 통해서만 가능).
    async registerKey(r) { keys.set(r.restaurant_id, r); },
    // D1의 updateKey(UPDATE ... SET restaurant_name=,public_key=,registered_at= WHERE ...)는
    // contact_kakao/contact_email 컬럼을 건드리지 않아 보존된다. 메모리 store도 전체 치환이
    // 아닌 병합으로 동일하게 동작시켜야 한다(연락처가 키 재등록 시 조용히 사라지면 안 됨).
    async updateKey(r) { keys.set(r.restaurant_id, { ...(keys.get(r.restaurant_id) || {}), ...r }); },
    async getPublicKey(id) { return keys.get(id) || null; },
    // 연락처(contact_kakao/contact_email)도 같은 레코드에 있으므로 삭제로 함께 사라진다.
    async deregisterKey(id) { keys.delete(id); },
    async registeredAmong(ids) { return ids.filter(id => keys.has(id)); },
    // 업무용 연락처(선택) upsert. 대상이 없으면 false(호출부에서 404 사전 체크 후 호출하므로
    // 정상 경로에서는 발생하지 않지만 방어적으로 처리).
    async setContact(restaurant_id, contact) {
      const row = keys.get(restaurant_id);
      if (!row) return false;
      row.contact_kakao = contact.kakao_link;
      row.contact_email = contact.email;
      return true;
    },
    async insertSummary(s) { summaries.push(s); },
    async insertBlob(b) { blobs.push(b); },
    async insertConsent(c) { consents.push(c); },
    async findSummaryByBatch(restaurant_id, batch_hash) {
      const s = summaries.find(x => x.restaurant_id === restaurant_id && x.batch_hash === batch_hash);
      return s ? { id: s.id } : null;
    },
    async getSummary(id) {
      const s = summaries.find(x => x.id === id);
      return s ? { id: s.id, restaurant_id: s.restaurant_id, status: s.status } : null;
    },
    async inbox(restaurant_id) {
      // 이중 방어(§6): cron이 하루 1회뿐이므로 status='PENDING'이어도 72시간 지난 항목은
      // 여기서 created_at으로 직접 걸러낸다.
      const cutoff = Date.now() - PENDING_TTL_MS;
      return summaries.filter(s => s.restaurant_id === restaurant_id && s.status === 'PENDING' && s.created_at > cutoff).map(s => {
        const b = blobs.find(x => x.summary_id === s.id);
        return { summary_id: s.id, summary: { institution: s.institution, department: s.department, restaurant_id: s.restaurant_id, restaurant_name: s.restaurant_name, year_month: s.year_month, total_amount: s.total_amount, member_count: s.member_count, batch_hash: s.batch_hash }, ciphertext: b ? JSON.parse(b.ciphertext) : null, status: s.status };
      });
    },
    // 상태 전이 가드: PENDING인 건만 전이 가능. 처리 성공 여부(boolean)를 반환.
    async setStatus(id, status) {
      const s = summaries.find(x => x.id === id && x.status === 'PENDING');
      if (!s) return false;
      s.status = status;
      s.processed_at = Date.now();
      return true;
    },
    async deleteBlob(summary_id) {
      // 데이터 보존 최소화: 수령(승인/거절) 즉시 또는 미수령 만료 시 암호문 파기.
      const bi = blobs.findIndex(b => b.summary_id === summary_id);
      if (bi !== -1) blobs.splice(bi, 1);
    },
    // ── 소유 증명 챌린지 ──
    async createChallenge(c) { challenges.push({ ...c }); },
    async consumeChallenge(restaurant_id, token_hash) {
      const now = Date.now();
      const idx = challenges.findIndex(c => c.restaurant_id === restaurant_id && c.token_hash === token_hash && c.expires_at > now);
      if (idx === -1) return false;
      challenges.splice(idx, 1);
      return true;
    },
    // ── 암호화 원장 백업 ──
    async upsertLedgerBackup(b) { ledgerBackups.set(b.restaurant_id, b); },
    async getLedgerBackup(restaurant_id) { return ledgerBackups.get(restaurant_id) || null; },
    async deleteLedgerBackup(restaurant_id) { ledgerBackups.delete(restaurant_id); },
    // ── 기관 OTP ──
    async getAgencyOtp(email) { return agencyOtps.get(email) || null; },
    async upsertAgencyOtp(o) { agencyOtps.set(o.email, o); },
    async incrementAgencyOtpAttempts(email) { const o = agencyOtps.get(email); if (o) o.attempts++; },
    async deleteAgencyOtp(email) { agencyOtps.delete(email); },
    async createAgencyToken(t) { agencyTokens.set(t.token_hash, t); },
    async getAgencyToken(token_hash) { return agencyTokens.get(token_hash) || null; },
    // ── TTL 정리 ──
    async cleanupTTL(now) {
      // 1) 미수령 72시간 경과 PENDING → EXPIRED 전이 + blob 즉시 파기(§6).
      const pendingCutoff = now - PENDING_TTL_MS;
      const toExpire = summaries.filter(s => s.status === 'PENDING' && s.created_at < pendingCutoff);
      toExpire.forEach(s => {
        const bi = blobs.findIndex(b => b.summary_id === s.id); if (bi !== -1) blobs.splice(bi, 1);
        s.status = 'EXPIRED';
        s.processed_at = now;
      });
      // 2) 처리 완료(APPROVED/REJECTED/EXPIRED) 후 30일 지난 비식별 요약 삭제.
      const cutoff = now - RETENTION_TTL_MS;
      const toDelete = summaries.filter(s => (s.status === 'APPROVED' || s.status === 'REJECTED' || s.status === 'EXPIRED') && s.processed_at && s.processed_at < cutoff);
      toDelete.forEach(s => {
        const bi = blobs.findIndex(b => b.summary_id === s.id); if (bi !== -1) blobs.splice(bi, 1);
        const si = summaries.indexOf(s); if (si !== -1) summaries.splice(si, 1);
      });
      for (let i = challenges.length - 1; i >= 0; i--) if (challenges[i].expires_at < now) challenges.splice(i, 1);
      for (const [email, o] of agencyOtps) if (o.expires_at < now) agencyOtps.delete(email);
      for (const [th, t] of agencyTokens) if (t.expires_at < now) agencyTokens.delete(th);
      // 3) consent_log도 무기한 보관하지 않고 180일 후 삭제(§6).
      const consentCutoff = now - CONSENT_RETENTION_TTL_MS;
      for (let i = consents.length - 1; i >= 0; i--) if (consents[i].consented_at < consentCutoff) consents.splice(i, 1);
      return { deletedSummaries: toDelete.length, expiredSummaries: toExpire.length };
    }
  };
}
