// 중계 서버 (Cloudflare Worker). 스펙 §1.1·§2.2. 개인정보 평문 미저장·미로깅.
// 핵심 로직은 store 인터페이스에 의존 → D1(운영)과 메모리(테스트)에서 동일 동작.
// 기관 담당자 이메일도 예외가 아니다: agency_otp·agency_token·consent_log 어디에도 평문을
// 저장하지 않고 SHA-256 해시(64자 hex)만 남긴다(개인정보처리방침 "해시값(평문 미보관)"과 일치).
// 평문 이메일은 Resend 발송 호출에만 일시적으로 쓰이고 어떤 저장소·로그에도 남지 않는다.

// CORS: ALLOW_ORIGIN은 콤마 구분 화이트리스트(또는 "*"). Origin 헤더가 없는 요청
// (curl, 하니스, 서버 간 호출)은 차단하지 않고 그냥 CORS 헤더 없이 통과시킨다 —
// CORS는 브라우저 강제 정책이지 서버 인증이 아니므로 여기서 막을 이유가 없다.
function CORS(env, request) {
  const list = String((env && env.ALLOW_ORIGIN) || '*').split(',').map(s => s.trim()).filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agency-Token, X-Admin-Token'
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
const MAX_DISTRICT = 100;       // 관할 지역(공개 사업장 정보, 예 "서울특별시 광진구")
const MAX_PUBKEY = 8 * 1024;    // 공개키(SPKI base64)
const MAX_CIPHERTEXT = 200 * 1024; // 암호 blob 직렬화(JSON.stringify) 바이트 근사
const MAX_LEDGER_BLOB = 1024 * 1024; // 암호화 원장 백업 blob(base64 문자열) 상한 ~1MB

// 데이터 보존 최소화(PROTOCOL.md §6): 암호문은 수령(승인/거절) 즉시 파기, 미수령 시
// 최대 72시간 후 자동 파기. 비식별 요약(총액·인원·해시)만 30일 보관 후 삭제.
const PENDING_TTL_MS = 72 * 60 * 60 * 1000;       // 미수령 3일(72시간) 만료
const RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 처리 완료(APPROVED/REJECTED/EXPIRED) 후 비식별 요약 보관 기간
const CONSENT_RETENTION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // consent_log(기관·부서·연월·이메일 해시) 보관 기간(§6)
const FEEDBACK_RETENTION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // feedback(자유 입력) 보관 기간(§6) — 무기한 보관 금지
// 대량 정리(cron)에서 IN (...) 배치 문 하나에 넣을 최대 id 개수. SQLite 변수 상한·문장 길이를 감안한 값.
const CLEANUP_CHUNK = 100;
function chunkIds(ids, size) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
function tooLong(v, max) { return typeof v === 'string' && v.length > max; }

// 관할 지역(district) 정규화 — 저장·조회 양쪽에 같은 규칙을 적용해 "정확 일치" 비교를 가능하게 한다.
// district는 항상 "{시도} {시군구}" 규칙으로 만들어진다(앱 relayDistrict() = 시도명 + ' ' + 기관명에서
// '청' 제거, 담당자 웹 jurisQuery()도 동일 규칙). 유니코드 정규화(NFC — macOS/iOS 입력의 NFD 조합형
// 방지) + 연속 공백 1칸 + 앞뒤 공백 제거만 수행하고 그 외 문자는 건드리지 않는다.
function normalizeDistrict(v) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFC').replace(/\s+/g, ' ').trim();
}
// LIKE 패턴 이스케이프(사용자 입력 sido에 %·_가 섞여 와일드카드로 동작하지 않게). ESCAPE '\' 와 함께 사용.
function likeEscape(v) { return String(v).replace(/[\\%_]/g, m => '\\' + m); }
// D1 컬럼값을 normalizeDistrict와 동등하게 정규화하는 SQL 식(공백 변형만 — 저장 시 이미 정규화하므로
// 레거시/외부 유입 행의 앞뒤·연속 공백만 관용하면 충분). REPLACE 3중첩으로 최대 8칸 연속 공백까지 축약.
const SQL_NORM_DISTRICT = "REPLACE(REPLACE(REPLACE(TRIM(district),'  ',' '),'  ',' '),'  ',' ')";
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
// 저장된 기관 이메일 값이 이미 SHA-256 해시(64자 hex)인지 판별. 전환기(구 평문 행) 방어용.
const HEX64_RE = /^[0-9a-f]{64}$/;
function isEmailHash(v) { return typeof v === 'string' && HEX64_RE.test(v); }
// 이미 해시면 그대로, (구버전이 남긴) 평문이면 해싱해서 반환 — 평문이 하위 저장소로 흘러가지 않게 한다.
async function normalizeEmailHash(v) {
  if (v == null) return null;
  return isEmailHash(v) ? v : await sha256hex(String(v));
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
// Resend REST API로 기관 OTP 이메일을 발송한다(Cloudflare Email Sending 대신 — Workers
// 유료 플랜 없이도 쓸 수 있는 무료 이메일 API). env.RESEND_API_KEY는 `wrangler secret put`으로
// 등록하는 비밀값이며 코드/파일에는 값을 두지 않는다. 반환값은 {ok:true} 또는
// {ok:false, reason}(호출부가 reason만 로깅하고 이메일/코드 평문은 로깅하지 않는다).
export async function sendOtpEmail(env, email, otp) {
  const text = '[밥장부] 기관 담당자 본인확인용 인증번호: ' + otp + '\n\n' +
    '유효시간: 10분\n' +
    '본 인증번호는 기관 담당자 본인확인용입니다. 타인에게 알리지 마세요.\n' +
    '본인이 요청하지 않았다면 이 메일을 무시하세요.';
  const html = '<p>[밥장부] 기관 담당자 본인확인용 인증번호입니다.</p>' +
    '<p style="font-size:28px;font-weight:bold;letter-spacing:4px;">' + otp + '</p>' +
    '<p>유효시간: <b>10분</b></p>' +
    '<p>본 인증번호는 기관 담당자 본인확인용입니다. <b>타인에게 알리지 마세요.</b></p>' +
    '<p>본인이 요청하지 않았다면 이 메일을 무시하세요.</p>';
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: '밥장부 <noreply@bapjangbu.com>',
        to: [email],
        subject: '[밥장부] 인증번호 ' + otp,
        text,
        html
      })
    });
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'fetch_error' };
  }
  if (!res.ok) return { ok: false, reason: 'resend_http_' + res.status };
  return { ok: true };
}
// 담당자 인증 허용 도메인. 공공기관(go.kr·korea.kr)이 주 대상이고, 복지관·공단 등
// 비영리·공공성 기관(or.kr)과 학교(ac.kr)까지 허용한다(2026-08 확장).
// 경계 규칙: 도메인이 허용값 **그 자체**이거나 그 **하위 도메인**(`.` + 허용값으로 끝남)일 때만 통과.
// 부분 문자열 매칭이 아니므로 `evilgo.kr`(라벨 경계 없음)·`go.kr.attacker.com`(끝이 다름)은 거부된다.
// 담당자 웹(agency-web/index.html AGENCY_EMAIL_RE)과 **동일한 규칙**을 유지할 것.
const AGENCY_EMAIL_DOMAIN_RE = /^([a-z0-9-]+\.)*(go|korea|or|ac)\.kr$/;
function isAgencyEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return false;
  const domain = e.slice(at + 1);
  return AGENCY_EMAIL_DOMAIN_RE.test(domain);
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

// 등록 음식점 지역별 조회(/api/registered-list)도 대량 수집(크롤링) 유인이 있어 public-key와 동일한
// 별도 낮은 한도(IP당 분당 20회)를 재사용 패턴으로 적용한다(독립 카운터). per-isolate 한계는 동일(§6.3).
const registeredListRateLimitMap = new Map();
function checkRegisteredListRateLimit(request) { return checkRateLimitWith(registeredListRateLimitMap, request, PUBLIC_KEY_RATE_LIMIT_MAX); }

// 관리자 통계 API(/api/admin/stats)는 브루트포스 방어를 위해 훨씬 낮은 한도(IP당 분당 10회)로
// 별도 제한한다(전역 한도와 무관한 독립 카운터). per-isolate 한계는 위와 동일(§6.3).
const ADMIN_RATE_LIMIT_MAX = 10;
const adminRateLimitMap = new Map();
function checkAdminRateLimit(request) { return checkRateLimitWith(adminRateLimitMap, request, ADMIN_RATE_LIMIT_MAX); }
// 피드백 수신(/api/feedback)은 스팸 방지를 위해 IP당 분당 5회로 별도 제한한다(독립 카운터).
const FEEDBACK_RATE_LIMIT_MAX = 5;
const feedbackRateLimitMap = new Map();
function checkFeedbackRateLimit(request) { return checkRateLimitWith(feedbackRateLimitMap, request, FEEDBACK_RATE_LIMIT_MAX); }

// 상수시간 문자열 비교(관리자 토큰 검증용 타이밍 공격 방어). 길이 정보는 노출될 수 있으나
// 랜덤 시크릿에서는 실질 위험이 낮다. 내용 비교는 XOR 누적으로 조기 반환 없이 수행한다.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = encU.encode(a), bb = encU.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
// 현재 연월(UTC 기준) "YYYY-MM" — stats_counter의 월별 발송 카운터 키에 사용.
function currentYearMonth(now) {
  const d = now || new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

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
      region_code: pick(r, ['OPN_ATMY_GRP_CD']),
      // 온보딩 1/3에서 가게를 고르면 전화번호까지 자동으로 채워 주기 위한 필드(사장님이 수정 가능).
      tel: pick(r, ['LOCP_TEL_NO', 'SITE_TEL_NO', 'siteTel', 'LOCPLC_TEL_NO', '소재지전화'])
    }))
    .filter(r => r.restaurant_id && r.name)
    .filter(r => !r.status.includes('폐업'))   // 영업 중인 곳만
    .filter(r => !kw || r.name.includes(kw));
}

export async function handle(request, env, store) {
  const url = new URL(request.url);
  const path = url.pathname;
  const j = (body, status = 200) => json(env, request, body, status);
  // 비식별 집계 통계 증가(베스트 에포트): 실패해도 본 기능이 깨지지 않도록 삼켜서 처리하며,
  // 개인정보(직원명·개인금액·이메일)는 절대 기록·로깅하지 않는다(조직정보·공개ID·누적 카운터만).
  const bumpStats = async (fn) => { try { await fn(); } catch (_) { /* 집계 실패 무시(개인정보 로깅 금지) */ } };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(env, request) });
  if (!checkRateLimit(request)) return j({ error: 'rate_limited' }, 429);
  // 연락처 크롤링 완화(감사 항목 3): public-key 조회만 더 낮은 한도로 추가 제한.
  if (path === '/api/public-key' && request.method === 'GET' && !checkPublicKeyRateLimit(request))
    return j({ error: 'rate_limited' }, 429);
  // 등록 음식점 지역별 조회도 동일한 강화 한도(분당 20)로 별도 제한.
  if (path === '/api/registered-list' && request.method === 'GET' && !checkRegisteredListRateLimit(request))
    return j({ error: 'rate_limited' }, 429);

  try {
    if (path === '/api/register-key' && request.method === 'POST') {
      const b = await request.json();
      if (!b.restaurant_id || !b.public_key) return j({ error: 'restaurant_id·public_key 필요' }, 400);
      const restaurant_id = String(b.restaurant_id);
      const restaurant_name = String(b.restaurant_name || '');
      const public_key = String(b.public_key);
      // district(선택): 관할 지역(공개 사업장 정보, 예 "서울특별시 광진구"). 개인정보 아님(§0 허용).
      // 길이 제한은 원문 기준으로 검사한 뒤 정규화해 저장한다(저장값을 항상 "{시도} {시군구}" 정규형으로
      // 유지 → 조회의 정확 일치가 성립).
      const districtRaw = b.district != null ? String(b.district) : '';
      const district = normalizeDistrict(districtRaw);
      if (tooLong(restaurant_id, MAX_STR) || tooLong(restaurant_name, MAX_STR) || tooLong(public_key, MAX_PUBKEY) || tooLong(districtRaw, MAX_DISTRICT))
        return j({ error: '입력 길이 초과' }, 400);
      // 침묵 덮어쓰기 방지: 이미 등록된 restaurant_id에 '다른' 공개키로 재등록하려면
      // 기존 키 소유를 증명(챌린지-응답)해야 한다. 동일 키 재등록은 앱 재시도(네트워크 실패 등)일
      // 수 있으므로 인증 없이 200(멱등). 최초 등록은 선착순으로 인증 불요.
      // 어느 재등록 경로든 district가 오면 갱신한다(레거시/미채움 등록분을 앱 재등록으로 채울 수 있게).
      const existing = await store.getPublicKey(restaurant_id);
      if (existing) {
        if (existing.public_key === public_key) {
          if (district) await store.setDistrict(restaurant_id, district);
          return j({ ok: true });
        }
        const authed = await verifyAuth(store, restaurant_id, b.auth_token);
        if (!authed) return j({ error: 'auth_required' }, 401);
        await store.updateKey({ restaurant_id, restaurant_name, public_key, registered_at: Date.now() });
        if (district) await store.setDistrict(restaurant_id, district);
        return j({ ok: true });
      }
      await store.registerKey({ restaurant_id, restaurant_name, public_key, registered_at: Date.now(), district: district || null });
      // 비식별 집계: 신규 등록된 음식점 공개ID(LOCALDATA mgtNo — 공개값)만 기록, 누적 등록 카운터 +1.
      await bumpStats(async () => {
        await store.noteRestaurant(restaurant_id);
        await store.incrCounter('registrations', 1);
      });
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

    // 음식점 주인 등록 해제 (명단 받기 중단). 공개키 삭제 → 담당자가 더는 전송 불가.
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

    // 담당자 웹: 후보 음식점 중 '명단 받기 가능(등록된)' 목록만 반환.
    if (path === '/api/registered' && request.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      return j(await store.registeredAmong(ids));
    }

    // 담당자 웹: 특정 시도(+선택 시군구)의 '등록된(명단 받기 가능)' 음식점 목록.
    // 공개 정보만 반환(id·이름·district — 연락처 미포함). district 없는(레거시) 등록분은 제외.
    // 매칭(정확 일치): sigungu가 있으면 district == "{sido} {sigungu}", 없으면 district == sido 이거나
    // "{sido} "로 시작(시도 경계 고정). 과거 부분 일치(LIKE '%시군구%')는 시군구명이 다른 시군구명의
    // 부분문자열인 실제 3쌍(부산 서구⊂강서구, 대구 서구⊂달서구, 경기 양주시⊂남양주시)에서 남의 관할
    // 음식점을 노출시켰다 — 담당자가 다른 구의 음식점으로 명단을 보낼 수 있는 경로라 정확 일치로 고정.
    if (path === '/api/registered-list' && request.method === 'GET') {
      const sidoRaw = String(url.searchParams.get('sido') || ''), sigunguRaw = String(url.searchParams.get('sigungu') || '');
      const sido = normalizeDistrict(sidoRaw), sigungu = normalizeDistrict(sigunguRaw);
      if (!sido) return j({ error: 'sido_required' }, 400);
      if (tooLong(sidoRaw, MAX_STR) || tooLong(sigunguRaw, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      const restaurants = await store.registeredByDistrict(sido, sigungu);
      return j({ restaurants });
    }

    if (path === '/api/restaurants' && request.method === 'GET') {
      const region = url.searchParams.get('region') || '';
      const q = url.searchParams.get('q') || '';
      if (!region && !q) return j({ error: '지역 또는 가게 이름이 필요합니다' }, 400);
      if (tooLong(region, MAX_STR) || tooLong(q, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      const search = env.searchRestaurants || defaultSearch;
      const list = await search(env, region, q);
      await bumpStats(async () => { await store.incrCounter('searches', 1); });
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
      // 이때 deduped:true와 기존 건의 status를 함께 돌려준다 — UNIQUE 인덱스 구조상 재제출로 새 행이
      // 생길 수 없으므로, "왜 아무 일도 안 일어난 것처럼 보이는지"(이미 승인·거절·만료됨)를 담당자가
      // 알 수 있는 유일한 통로가 응답이다. 신규 제출 응답은 기존과 동일하게 {summary_id}만 반환한다.
      if (batch_hash) {
        const dup = await store.findSummaryByBatch(restaurant_id, batch_hash);
        if (dup) return j({ summary_id: dup.id, deduped: true, status: dup.status });
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
        // agency_token에 저장된 값은 이미 이메일의 SHA-256 해시(64자 hex)이므로 재해싱하지 않는다.
        // 전환기 방어: 구버전이 평문으로 남긴 토큰 행(24시간 내 자연 소멸)이 오면 해시로 바꿔 기록한다 —
        // 어떤 경로로도 평문 이메일이 consent_log에 들어가지 않게 하는 마지막 방어선.
        await store.insertConsent({
          id: uuid(), institution: cInstitution, department: cDepartment, year_month: cYearMonth,
          agency_email_hash: agencyRow ? await normalizeEmailHash(agencyRow.email_hash) : null,
          consented_at: Date.now()
        });
      }
      // 비식별 집계(성공 제출만): 기관명(조직정보)·기관+부서 조합·발송 카운터·인원/금액 누적.
      // 직원명·개인별 금액은 절대 저장하지 않는다 — summary의 집계값(총액·인원수)만 누적한다.
      await bumpStats(async () => {
        if (institution) await store.noteInstitution(institution);
        if (institution || department) await store.noteDepartment(institution + '' + department);
        await store.incrCounter('sends', 1);
        if (year_month) await store.incrCounter('sends_' + year_month, 1);
        await store.incrCounter('members_total', member_count);
        await store.incrCounter('amount_total', total_amount);
      });
      return j({ summary_id });
    }

    if (path === '/api/inbox' && request.method === 'GET') {
      const id = url.searchParams.get('restaurant_id') || '';
      if (!id) return j({ error: 'restaurant_id 필요' }, 400);
      const items = await store.inbox(id);
      return j(items);
    }

    // 경량 알림용(배지·백그라운드 폴링): 수신함 '개수만' 반환. 요약 메타(기관·부서·총액)나
    // 암호문은 일절 담지 않는다 — 응답은 {count:N} 뿐. 필터는 /api/inbox와 동일
    // (PENDING + created_at > 72시간 cutoff, 이중 방어 §6)하되 COUNT로만 수행한다.
    // 인증 없음: 같은 restaurant_id로 /api/inbox를 그냥 호출하면 이미 알 수 있는 값의
    // 부분집합(개수)이라 새로 노출되는 정보가 0이다. 남용 방어는 전역 레이트리밋(분당 60).
    if (path === '/api/inbox-count' && request.method === 'GET') {
      const id = url.searchParams.get('restaurant_id') || '';
      if (!id) return j({ error: 'restaurant_id 필요' }, 400);
      const count = await store.inboxCount(id);
      return j({ count });
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

    // ── 기관 OTP 인증 인프라 (단계적 활성화, AUTH_MODE 3분기) ──
    // dev: 로컬 개발 전용 — 응답에 평문 dev_otp 포함, 이메일 미발송.
    // pilot: 이메일 발송 인프라를 아직 온보딩(도메인 인증) 전 단계로 잠가둔 베타 운영값 —
    //   OTP는 생성·해시 저장하지만 발송하지 않고 {ok:true, sent:false}만 응답한다. agency-web은
    //   sent:false를 보고 "형식 확인됨(파일럿)" 수준으로만 진행(REQUIRE_AGENCY_AUTH='0' 유지로
    //   제출 자체는 막히지 않음).
    // prod: Resend REST API(env.RESEND_API_KEY secret, sendOtpEmail 헬퍼)로 실제 발송 —
    //   Cloudflare Email Sending은 Workers 유료 플랜이 필요해 무료 대안인 Resend로 전환했다.
    //   감사 항목 1(정직성 원칙): 어떤 모드의 응답에도 평문 OTP가 실려나가서는 안 되므로
    //   dev_otp는 AUTH_MODE==='dev'일 때만 포함하고, prod는 발송 성공 시 sent:true만 반환한다.
    if (path === '/api/agency/request-otp' && request.method === 'POST') {
      const b = await request.json();
      const email = String(b.email || '').trim();
      if (!email) return j({ error: 'email 필요' }, 400);
      if (tooLong(email, MAX_STR)) return j({ error: '입력 길이 초과' }, 400);
      // 형식 검증(§4.4): "@go.kr"처럼 로컬파트가 없는 값도 도메인 검사만으로는 통과했었다.
      if (!validEmailFormat(email)) return j({ error: 'invalid_email' }, 400);
      if (!isAgencyEmail(email)) return j({ error: 'invalid_domain' }, 400);
      const now = Date.now();
      // 저장 키는 이메일의 SHA-256 해시(평문 미저장, §0). 60초 재요청 스로틀도 해시 키 기준.
      const email_hash = await sha256hex(email);
      const existing = await store.getAgencyOtp(email_hash);
      if (existing && existing.created_at && now - existing.created_at < 60 * 1000)
        return j({ error: 'rate_limited' }, 429);
      const otp = randomOtp6();
      const otp_hash = await sha256hex(otp);
      await store.upsertAgencyOtp({ email_hash, otp_hash, expires_at: now + 10 * 60 * 1000, attempts: 0, created_at: now });
      if (env.AUTH_MODE === 'dev') return j({ ok: true, dev_otp: otp });
      if (env.AUTH_MODE === 'prod') {
        // 발송에 실패하면 방금 쓴 OTP 행을 되돌린다 — 남겨두면 60초 스로틀에 걸려 담당자가
        // 재시도조차 못 하는 블랙홀이 된다(행이 없으면 다음 요청이 곧바로 새 OTP를 발급받는다).
        if (!env.RESEND_API_KEY) {
          // secret 미등록 상태로 prod 전환됨 — 발송 시도조차 하지 않고 명확히 알린다.
          console.error('agency-otp email not configured: RESEND_API_KEY missing');
          await store.deleteAgencyOtp(email_hash);
          return j({ error: 'email_not_configured' }, 500);
        }
        // 평문 이메일은 여기(Resend 발송)에서만 쓰이고 저장·로깅되지 않는다.
        const result = await sendOtpEmail(env, email, otp);
        if (!result.ok) {
          // 개인정보 보호: 이메일 평문·OTP는 로깅하지 않는다. 실패 사유만 남긴다.
          console.error('agency-otp email send failed: ' + (result.reason || 'unknown'));
          // 발송이 안 된 요청이 60초 스로틀을 소모하지 않도록 방금 쓴 OTP 행은 되돌린다.
          await store.deleteAgencyOtp(email_hash);
          // Resend 무료 플랜은 하루 100통·월 3,000통 한도가 있어 트래픽이 몰리는 날에는
          // 429가 돌아온다. 일시적 한도 초과와 진짜 발송 실패를 구분해 담당자에게
          // "내일 다시" 같은 정확한 안내를 할 수 있게 별도 코드로 응답한다.
          if (String(result.reason || '').startsWith('resend_http_429'))
            return j({ error: 'email_quota_exceeded' }, 429);
          return j({ error: 'email_send_failed' }, 500);
        }
        return j({ ok: true, sent: true });
      }
      // pilot(및 그 외 값): 발송 인프라 미가동 — 형식만 확인.
      return j({ ok: true, sent: false });
    }

    if (path === '/api/agency/verify-otp' && request.method === 'POST') {
      const b = await request.json();
      const email = String(b.email || '').trim();
      const otp = String(b.otp || '');
      if (!email || !otp) return j({ error: 'email·otp 필요' }, 400);
      if (tooLong(email, MAX_STR) || tooLong(otp, 20)) return j({ error: '입력 길이 초과' }, 400);
      // 조회·삭제 모두 해시 키 기준(평문 미저장, §0).
      const email_hash = await sha256hex(email);
      const row = await store.getAgencyOtp(email_hash);
      if (!row || row.expires_at < Date.now()) return j({ error: 'invalid_otp' }, 401);
      if (row.attempts >= 5) return j({ error: 'too_many_attempts' }, 429);
      const otp_hash = await sha256hex(otp);
      if (otp_hash !== row.otp_hash) {
        await store.incrementAgencyOtpAttempts(email_hash);
        return j({ error: 'invalid_otp' }, 401);
      }
      await store.deleteAgencyOtp(email_hash);
      const token = randomB64(32);
      const token_hash = await sha256hex(token);
      // 토큰 행에도 이메일 해시만 저장한다(consent_log 기록에 그대로 재사용).
      await store.createAgencyToken({ token_hash, email_hash, expires_at: Date.now() + 24 * 60 * 60 * 1000 });
      return j({ token });
    }

    // ── 관리자 통계 API (비밀번호 보호, 비식별 집계만 노출) ──
    // env.ADMIN_TOKEN(secret) 미설정이면 기능 자체를 잠근다(503). 토큰 불일치는 상수시간
    // 비교로 401. 개인정보 필드는 응답에 없다(조직정보·공개ID·누적 카운터·피드백만).
    if (path === '/api/admin/stats' && request.method === 'GET') {
      if (!env.ADMIN_TOKEN) return j({ error: 'admin_not_configured' }, 503);
      if (!checkAdminRateLimit(request)) return j({ error: 'rate_limited' }, 429);
      const token = request.headers.get('X-Admin-Token') || '';
      if (!timingSafeEqual(token, String(env.ADMIN_TOKEN))) return j({ error: 'unauthorized' }, 401);
      const stats = await store.getStats(currentYearMonth());
      return j(stats);
    }

    // ── 피드백 수신 API ──
    // 자유 입력이므로 저장은 그대로 하되 응답·로그에 내용을 반영하지 않는다. 스팸 방지 레이트리밋.
    if (path === '/api/feedback' && request.method === 'POST') {
      if (!checkFeedbackRateLimit(request)) return j({ error: 'rate_limited' }, 429);
      const b = await request.json();
      const role = String(b.role || '');
      const message = String(b.message || '');
      const contact = b.contact != null ? String(b.contact) : '';
      if (!['음식점', '기관', '직원', '기타'].includes(role)) return j({ error: 'invalid_role' }, 400);
      if (message.length < 1 || message.length > 2000) return j({ error: 'invalid_message' }, 400);
      if (contact.length > 200) return j({ error: 'invalid_contact' }, 400);
      await store.insertFeedback({ id: uuid(), role, message, contact: contact || null, created_at: Date.now() });
      return j({ ok: true });
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
      await DB.prepare('INSERT INTO public_key_registry (restaurant_id,restaurant_name,public_key,registered_at,district) VALUES (?,?,?,?,?)')
        .bind(r.restaurant_id, r.restaurant_name, r.public_key, r.registered_at, r.district != null ? r.district : null).run();
    },
    // 관할 지역(공개 사업장 정보) 갱신. 재등록 경로에서 district가 오면 호출(§ 등록 목록).
    async setDistrict(restaurant_id, district) {
      await DB.prepare('UPDATE public_key_registry SET district=? WHERE restaurant_id=?').bind(district, restaurant_id).run();
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
    // 시도(+선택 시군구)로 등록 음식점 조회 — 정규화 후 '정확 일치'.
    //  · sigungu 있음: 정규화(district) = "{sido} {sigungu}"  (부분 일치 금지 — 서구/강서구 오매칭 방지)
    //  · sigungu 없음: 정규화(district) = sido  또는  "{sido} "로 시작(시도 경계를 공백으로 고정)
    // NULL district(레거시)는 제외. 이름 가나다 정렬(BINARY=한글 순서).
    // 정규화 식(SQL_NORM_DISTRICT)은 인덱스를 타지 못하지만 등록 음식점 테이블은 소규모라 무시 가능.
    async registeredByDistrict(sido, sigungu) {
      let sql = 'SELECT restaurant_id, restaurant_name, district FROM public_key_registry WHERE district IS NOT NULL AND ';
      const params = [];
      if (sigungu) {
        sql += SQL_NORM_DISTRICT + ' = ?';
        params.push(sido + ' ' + sigungu);
      } else {
        sql += '(' + SQL_NORM_DISTRICT + " = ? OR " + SQL_NORM_DISTRICT + " LIKE ? ESCAPE '\\')";
        params.push(sido, likeEscape(sido) + ' %');
      }
      sql += ' ORDER BY restaurant_name';
      const r = await DB.prepare(sql).bind(...params).all();
      return (r.results || []).map(x => ({ restaurant_id: x.restaurant_id, restaurant_name: x.restaurant_name, district: x.district }));
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
    // 멱등 응답에 기존 건의 처리 상태(PENDING/APPROVED/REJECTED/EXPIRED)를 함께 실어주기 위해 status도 조회.
    async findSummaryByBatch(restaurant_id, batch_hash) {
      return await DB.prepare('SELECT id, status FROM deposit_summary WHERE restaurant_id=? AND batch_hash=? LIMIT 1')
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
    // inbox와 동일 필터를 COUNT로만(행 본문·암호문을 읽지 않음). 알림 배지용 경량 조회.
    // encrypted_blob JOIN까지 동일하게 건다 — blob이 이미 파기된 고아 summary(수령 실패·부분 정리 등)는
    // /api/inbox에 나오지 않으므로, 세기만 하면 "열 수 없는 알림 배지"가 남는다.
    async inboxCount(restaurant_id) {
      const cutoff = Date.now() - PENDING_TTL_MS;
      const r = await DB.prepare("SELECT COUNT(*) c FROM deposit_summary s JOIN encrypted_blob b ON b.summary_id=s.id WHERE s.restaurant_id=? AND s.status='PENDING' AND s.created_at>?")
        .bind(restaurant_id, cutoff).first();
      return (r && r.c) || 0;
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
    // agency_otp.email / agency_token.email 컬럼에는 **이메일의 SHA-256 해시**만 넣는다(평문 미저장,
    // §0). 스키마 변경 없이 같은 TEXT 컬럼을 재사용하며, 코드에서는 email_hash로 별칭해 읽는다.
    async getAgencyOtp(emailHash) {
      return await DB.prepare('SELECT email AS email_hash, otp_hash, expires_at, attempts, created_at FROM agency_otp WHERE email=?').bind(emailHash).first();
    },
    async upsertAgencyOtp(o) {
      await DB.prepare('DELETE FROM agency_otp WHERE email=?').bind(o.email_hash).run();
      await DB.prepare('INSERT INTO agency_otp (email,otp_hash,expires_at,attempts,created_at) VALUES (?,?,?,?,?)')
        .bind(o.email_hash, o.otp_hash, o.expires_at, o.attempts, o.created_at).run();
    },
    async incrementAgencyOtpAttempts(emailHash) {
      await DB.prepare('UPDATE agency_otp SET attempts=attempts+1 WHERE email=?').bind(emailHash).run();
    },
    async deleteAgencyOtp(emailHash) {
      await DB.prepare('DELETE FROM agency_otp WHERE email=?').bind(emailHash).run();
    },
    async createAgencyToken(t) {
      await DB.prepare('INSERT INTO agency_token (token_hash,email,expires_at) VALUES (?,?,?)')
        .bind(t.token_hash, t.email_hash, t.expires_at).run();
    },
    async getAgencyToken(token_hash) {
      return await DB.prepare('SELECT email AS email_hash, expires_at FROM agency_token WHERE token_hash=?').bind(token_hash).first();
    },
    // ── 비식별 집계 통계(조직정보·공개ID·누적 카운터·피드백만 — 개인정보 없음) ──
    async noteInstitution(name) { await DB.prepare('INSERT OR IGNORE INTO seen_institution (name) VALUES (?)').bind(name).run(); },
    async noteDepartment(key) { await DB.prepare('INSERT OR IGNORE INTO seen_department (key) VALUES (?)').bind(key).run(); },
    async noteRestaurant(restaurant_id) { await DB.prepare('INSERT OR IGNORE INTO seen_restaurant (restaurant_id) VALUES (?)').bind(restaurant_id).run(); },
    async incrCounter(name, by) {
      await DB.prepare('INSERT INTO stats_counter (name,count) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET count=count+?')
        .bind(name, by, by).run();
    },
    async insertFeedback(f) {
      await DB.prepare('INSERT INTO feedback (id,role,message,contact,created_at) VALUES (?,?,?,?,?)')
        .bind(f.id, f.role, f.message, f.contact, f.created_at).run();
    },
    async getStats(currentYM) {
      const num = async (sql) => { const r = await DB.prepare(sql).first(); return (r && r.c) || 0; };
      const counter = async (name) => { const r = await DB.prepare('SELECT count FROM stats_counter WHERE name=?').bind(name).first(); return (r && r.count) || 0; };
      const fb = await DB.prepare('SELECT role,message,contact,created_at FROM feedback ORDER BY created_at DESC LIMIT 50').all();
      return {
        restaurants: {
          current: await num('SELECT COUNT(*) c FROM public_key_registry'),
          total: await num('SELECT COUNT(*) c FROM seen_restaurant')
        },
        institutions_total: await num('SELECT COUNT(*) c FROM seen_institution'),
        departments_total: await num('SELECT COUNT(*) c FROM seen_department'),
        sends: { total: await counter('sends'), this_month: await counter('sends_' + currentYM) },
        pending: await num("SELECT COUNT(*) c FROM deposit_summary WHERE status='PENDING'"),
        members_total: await counter('members_total'),
        amount_total: await counter('amount_total'),
        feedback: (fb.results || []).map(f => ({ role: f.role, message: f.message, contact: f.contact, created_at: f.created_at }))
      };
    },
    // ── TTL 정리(개인정보 최소화 목적). cron에서 호출. ──
    async cleanupTTL(now) {
      // 1) 미수령 72시간 경과 PENDING → EXPIRED 전이 + blob 즉시 파기(§6). inbox 쿼리도
      // 별도로 created_at 조건을 걸어 이중 방어하므로, 이 단계는 cron 주기(1일) 동안의
      // 저장 최소화를 담당한다.
      const pendingCutoff = now - PENDING_TTL_MS;
      const expiredRows = await DB.prepare("SELECT id FROM deposit_summary WHERE status='PENDING' AND created_at < ?").bind(pendingCutoff).all();
      // 행마다 문장 2개를 발행하면 만료 건이 몰린 날 D1 왕복이 폭증하므로 100개씩 IN (...) 배치로 실행한다
      // (동작 결과는 행 단위 루프와 동일 — 같은 id 집합에 같은 삭제·전이를 적용).
      const expiredIds = (expiredRows.results || []).map(r => r.id);
      for (const part of chunkIds(expiredIds, CLEANUP_CHUNK)) {
        const ph = part.map(() => '?').join(',');
        await DB.prepare('DELETE FROM encrypted_blob WHERE summary_id IN (' + ph + ')').bind(...part).run();
        await DB.prepare("UPDATE deposit_summary SET status='EXPIRED', processed_at=? WHERE id IN (" + ph + ")").bind(now, ...part).run();
      }
      // 2) 처리 완료(APPROVED/REJECTED/EXPIRED) 후 30일 지난 비식별 요약 삭제(동일하게 배치 실행).
      const cutoff = now - RETENTION_TTL_MS;
      const rows = await DB.prepare("SELECT id FROM deposit_summary WHERE status IN ('APPROVED','REJECTED','EXPIRED') AND processed_at IS NOT NULL AND processed_at < ?").bind(cutoff).all();
      const ids = (rows.results || []).map(r => r.id);
      for (const part of chunkIds(ids, CLEANUP_CHUNK)) {
        const ph = part.map(() => '?').join(',');
        await DB.prepare('DELETE FROM encrypted_blob WHERE summary_id IN (' + ph + ')').bind(...part).run();
        await DB.prepare('DELETE FROM deposit_summary WHERE id IN (' + ph + ')').bind(...part).run();
      }
      await DB.prepare('DELETE FROM auth_challenge WHERE expires_at<?').bind(now).run();
      await DB.prepare('DELETE FROM agency_otp WHERE expires_at<?').bind(now).run();
      await DB.prepare('DELETE FROM agency_token WHERE expires_at<?').bind(now).run();
      // 3) consent_log(기관·부서·연월·이메일 해시)도 무기한 보관하지 않고 180일 후 삭제(§6).
      await DB.prepare('DELETE FROM consent_log WHERE consented_at < ?').bind(now - CONSENT_RETENTION_TTL_MS).run();
      // 4) feedback(자유 입력 본문)도 보존기한을 둔다 — 180일 경과분 삭제(§6).
      await DB.prepare('DELETE FROM feedback WHERE created_at IS NOT NULL AND created_at < ?').bind(now - FEEDBACK_RETENTION_TTL_MS).run();
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
  // 만료된 인증 챌린지/기관 OTP/기관 토큰, ③ 180일 지난 consent_log·feedback을 정리한다(암호 blob은 승인/거절 시 이미 즉시
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
  // 비식별 집계 통계(하니스용 — D1과 동등 구조): 조직정보·공개ID 집합, 누적 카운터, 피드백.
  const seenInstitutions = new Set(), seenDepartments = new Set(), seenRestaurants = new Set();
  const counters = new Map(), feedbacks = [];
  return {
    _dump: () => ({ keys, summaries, blobs, consents, challenges, ledgerBackups, agencyOtps, agencyTokens, seenInstitutions, seenDepartments, seenRestaurants, counters, feedbacks }),
    // 침묵 덮어쓰기 방지: 이미 등록된 restaurant_id는 handle()에서 사전 차단하므로
    // 여기서는 신규 삽입만 수행(다른 키로의 재등록은 updateKey를 통해서만 가능).
    async registerKey(r) { keys.set(r.restaurant_id, r); },
    // D1의 updateKey(UPDATE ... SET restaurant_name=,public_key=,registered_at= WHERE ...)는
    // contact_kakao/contact_email 컬럼을 건드리지 않아 보존된다. 메모리 store도 전체 치환이
    // 아닌 병합으로 동일하게 동작시켜야 한다(연락처가 키 재등록 시 조용히 사라지면 안 됨).
    async updateKey(r) { keys.set(r.restaurant_id, { ...(keys.get(r.restaurant_id) || {}), ...r }); },
    async getPublicKey(id) { return keys.get(id) || null; },
    // 관할 지역(공개 사업장 정보) 갱신 — D1 setDistrict와 동등(대상 없으면 no-op).
    async setDistrict(restaurant_id, district) { const row = keys.get(restaurant_id); if (row) row.district = district; },
    // 연락처(contact_kakao/contact_email)도 같은 레코드에 있으므로 삭제로 함께 사라진다.
    async deregisterKey(id) { keys.delete(id); },
    async registeredAmong(ids) { return ids.filter(id => keys.has(id)); },
    // 시도(+선택 시군구)로 등록 음식점 조회 — D1 registeredByDistrict와 동등(정규화 후 정확 일치).
    // 레거시(district 없음) 제외, 이름 가나다 정렬.
    async registeredByDistrict(sido, sigungu) {
      const out = [];
      const want = sigungu ? sido + ' ' + sigungu : '';
      for (const row of keys.values()) {
        const d = row.district;
        if (typeof d !== 'string' || !d) continue;
        const nd = normalizeDistrict(d);
        if (want) { if (nd !== want) continue; }
        else if (nd !== sido && !nd.startsWith(sido + ' ')) continue;
        out.push({ restaurant_id: row.restaurant_id, restaurant_name: row.restaurant_name, district: d });
      }
      out.sort((a, b) => String(a.restaurant_name || '').localeCompare(String(b.restaurant_name || ''), 'ko'));
      return out;
    },
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
    // D1과 동등: 멱등 응답에 실을 status도 함께 반환.
    async findSummaryByBatch(restaurant_id, batch_hash) {
      const s = summaries.find(x => x.restaurant_id === restaurant_id && x.batch_hash === batch_hash);
      return s ? { id: s.id, status: s.status } : null;
    },
    async getSummary(id) {
      const s = summaries.find(x => x.id === id);
      return s ? { id: s.id, restaurant_id: s.restaurant_id, status: s.status } : null;
    },
    // D1 inbox는 encrypted_blob과 JOIN이므로 blob 없는(고아) summary는 애초에 나오지 않는다.
    // 메모리 store도 동일 시맨틱으로 통일한다(과거엔 ciphertext:null로 반환해 D1과 달랐음).
    async inbox(restaurant_id) {
      // 이중 방어(§6): cron이 하루 1회뿐이므로 status='PENDING'이어도 72시간 지난 항목은
      // 여기서 created_at으로 직접 걸러낸다.
      const cutoff = Date.now() - PENDING_TTL_MS;
      const out = [];
      for (const s of summaries) {
        if (s.restaurant_id !== restaurant_id || s.status !== 'PENDING' || !(s.created_at > cutoff)) continue;
        const b = blobs.find(x => x.summary_id === s.id);
        if (!b) continue; // D1의 JOIN과 동일 — blob이 없으면 제외
        out.push({ summary_id: s.id, summary: { institution: s.institution, department: s.department, restaurant_id: s.restaurant_id, restaurant_name: s.restaurant_name, year_month: s.year_month, total_amount: s.total_amount, member_count: s.member_count, batch_hash: s.batch_hash }, ciphertext: JSON.parse(b.ciphertext), status: s.status });
      }
      return out;
    },
    // inbox와 동일 필터의 개수만(D1 inboxCount와 동등 — blob JOIN 포함). 알림 배지용 경량 조회.
    async inboxCount(restaurant_id) {
      const cutoff = Date.now() - PENDING_TTL_MS;
      return summaries.filter(s => s.restaurant_id === restaurant_id && s.status === 'PENDING' && s.created_at > cutoff
        && blobs.some(b => b.summary_id === s.id)).length;
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
    // ── 기관 OTP ── (키·저장값 모두 이메일의 SHA-256 해시 — D1과 동일하게 평문 미저장)
    async getAgencyOtp(emailHash) { return agencyOtps.get(emailHash) || null; },
    async upsertAgencyOtp(o) { agencyOtps.set(o.email_hash, o); },
    async incrementAgencyOtpAttempts(emailHash) { const o = agencyOtps.get(emailHash); if (o) o.attempts++; },
    async deleteAgencyOtp(emailHash) { agencyOtps.delete(emailHash); },
    async createAgencyToken(t) { agencyTokens.set(t.token_hash, t); },
    async getAgencyToken(token_hash) { return agencyTokens.get(token_hash) || null; },
    // ── 비식별 집계 통계(조직정보·공개ID·누적 카운터·피드백만 — 개인정보 없음) ──
    async noteInstitution(name) { seenInstitutions.add(name); },
    async noteDepartment(key) { seenDepartments.add(key); },
    async noteRestaurant(restaurant_id) { seenRestaurants.add(restaurant_id); },
    async incrCounter(name, by) { counters.set(name, (counters.get(name) || 0) + by); },
    async insertFeedback(f) { feedbacks.push({ ...f }); },
    async getStats(currentYM) {
      const feedback = feedbacks.slice().sort((a, b) => b.created_at - a.created_at).slice(0, 50)
        .map(f => ({ role: f.role, message: f.message, contact: f.contact, created_at: f.created_at }));
      return {
        restaurants: { current: keys.size, total: seenRestaurants.size },
        institutions_total: seenInstitutions.size,
        departments_total: seenDepartments.size,
        sends: { total: counters.get('sends') || 0, this_month: counters.get('sends_' + currentYM) || 0 },
        pending: summaries.filter(s => s.status === 'PENDING').length,
        members_total: counters.get('members_total') || 0,
        amount_total: counters.get('amount_total') || 0,
        feedback
      };
    },
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
      // 4) feedback(자유 입력)도 180일 경과분 삭제(§6) — D1과 동등.
      const feedbackCutoff = now - FEEDBACK_RETENTION_TTL_MS;
      for (let i = feedbacks.length - 1; i >= 0; i--) if (feedbacks[i].created_at != null && feedbacks[i].created_at < feedbackCutoff) feedbacks.splice(i, 1);
      return { deletedSummaries: toDelete.length, expiredSummaries: toExpire.length };
    }
  };
}
