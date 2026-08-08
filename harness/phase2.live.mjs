// 배포된 실제 서버 상대 엔드투엔드 데모(라이브 스모크).
//   node harness/phase2.live.mjs https://prepaid-relay.<계정>.workers.dev
//
// ※ 인증 정책: 서버는 REQUIRE_AGENCY_AUTH="1"로 운영된다 — /api/submit은 유효한
//    X-Agency-Token(기관 OTP 인증 후 발급)을 요구한다. 라이브 하니스는 이메일을 수신할
//    수 없어 OTP 토큰을 얻지 못하므로 제출 happy-path는 검증하지 않는다. 대신 "인증 강제가
//    실제로 작동하는지"(토큰 없는/무효한 제출이 401로 거부되는지)를 검증하고, 토큰이
//    필요 없는 구간(공개키 등록·조회, 담당자측 하이브리드 암호화, 챌린지-응답 소유 증명
//    기반 등록 해제)을 그대로 검증한다. 제출 happy-path·수신함·복호화·승인은 OTP 토큰이
//    필요하므로 목 하니스(harness/phase2.e2e.mjs)에서 검증한다.
const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) { console.error('사용법: node harness/phase2.live.mjs <서버URL>'); process.exit(1); }
const subtle = globalThis.crypto.subtle, encU = new TextEncoder(), decU = new TextDecoder();
const b64 = b => { let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i++)s += String.fromCharCode(u[i]); return btoa(s); };
const unb64 = s => { const x = atob(s), u = new Uint8Array(x.length); for (let i = 0; i < x.length; i++)u[i] = x.charCodeAt(i); return u.buffer; };
const sha = async s => { const h = await subtle.digest('SHA-256', encU.encode(s)); return Array.from(new Uint8Array(h)).map(v => v.toString(16).padStart(2, '0')).join(''); };
// 매 실행 고유 RID: 서버의 재등록 409·중복제출(batch_hash) 멱등 규칙과 충돌하지 않게 함
// 진단 전용 접두사(__diag_): 서버가 실존 대조를 건너뛰고 verified=0으로 등록하며,
// 담당자 목록(/api/registered-list)에서는 제외된다. 실제 가게 id로 스모크를 돌리면
// 그 자체가 '가게 선점'이 되므로 절대 쓰지 않는다.
const RID = '__diag_live-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + m); };
const jf = async (p, opt) => { const r = await fetch(BASE + p, opt); return { r, j: await r.json().catch(() => null) }; };

// 1) 공개키 등록 (토큰 불필요)
const kp = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
const spki = b64(await subtle.exportKey('spki', kp.publicKey));
ok((await jf('/api/register-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: RID, restaurant_name: '데모김밥', public_key: spki }) })).r.ok, '공개키 등록');

// 2) 공개키 조회 — 방금 등록한 키가 그대로 반환되는지 (토큰 불필요)
const { j: pk } = await jf('/api/public-key?restaurant_id=' + RID);
ok(pk && pk.public_key === spki, '공개키 조회(등록한 키 반환)');
const pub = await subtle.importKey('spki', unb64(pk.public_key), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);

// 3) 담당자측 하이브리드 암호화(RSA-OAEP-2048 + AES-256-GCM) + batch_hash 생성.
//    서버를 거치지 않는 클라이언트 크립토 파이프라인 — 로컬 복호화로 왕복 무결성을 확인한다.
const items = [{ name: '김철수', dept: '세무과', amount: 90000 }, { name: '이순신', dept: '세무과', amount: 90000 }, { name: '박영희', dept: '세무과', amount: 90000 }];
const bh = await sha(items.map(i => i.name + '|' + i.dept + '|' + i.amount).sort().join('\n'));
const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, encU.encode(JSON.stringify({ v: 1, items })));
const encKey = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, await subtle.exportKey('raw', aes));
const blob = { alg: 'RSA-OAEP-2048+AES-256-GCM', encKey: b64(encKey), iv: b64(iv), ct: b64(ct) };
const rawK = await subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, unb64(blob.encKey));
const akL = await subtle.importKey('raw', rawK, { name: 'AES-GCM' }, false, ['decrypt']);
const roundTrip = JSON.parse(decU.decode(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(unb64(blob.iv)) }, akL, unb64(blob.ct))));
ok(roundTrip.items.length === 3 && (await sha(roundTrip.items.map(i => i.name + '|' + i.dept + '|' + i.amount).sort().join('\n'))) === bh, '담당자측 하이브리드 암호화 + batch_hash 왕복 일치');

// 유효한 형식의 제출 본문(암호화까지 끝난 실제 페이로드) — 아래 두 케이스는 인증만 다르다.
const submitBody = JSON.stringify({ summary: { institution: '서울특별시 강남구', department: '세무과', restaurant_id: RID, restaurant_name: '데모김밥', year_month: '2026-07', total_amount: 270000, member_count: 3, batch_hash: bh }, blob: { restaurant_id: RID, ciphertext: blob }, consent: { institution: '서울특별시 강남구', department: '세무과', year_month: '2026-07' } });

// 4) 인증 강제(핵심): REQUIRE_AGENCY_AUTH=1 하에서 토큰 없는 제출은 401 agency_auth_required로 거부.
const { r: noTokR, j: noTokJ } = await jf('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: submitBody });
ok(noTokR.status === 401 && noTokJ && noTokJ.error === 'agency_auth_required', '인증 강제: 토큰 없는 제출 401(agency_auth_required)');

// 5) 무효한 X-Agency-Token으로도 제출은 401로 거부(위조 토큰 방어).
const { r: badTokR } = await jf('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agency-Token': 'not-a-real-token' }, body: submitBody });
ok(badTokR.status === 401, '인증 강제: 무효 토큰 제출 401');

// 6) 등록 해제 — 챌린지-응답 소유 증명(기관 토큰과 무관, 음식점 개인키 기반).
//    서버가 등록된 공개키로 무작위 토큰을 봉인해 돌려주면 개인키로 복호화해 auth_token으로 제출한다.
async function getAuthToken(privateKey) {
  const { j: ch } = await jf('/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: RID }) });
  const pt = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, unb64(ch.challenge_ct));
  return decU.decode(pt);
}
// 6-a) 신규 보안 계약(2026-08): 실존하지 않는 가게 id는 등록 거부(가게 선점 방어).
//   서버는 공공 API가 응답하지 않으면 '판정 불가 → 등록 허용(verified=0)'로 빠진다(가용성 우선 설계).
//   그래서 공공 API가 살아 있을 때만 엄격히 단언하고, 죽어 있으면 건너뛴다(거짓 실패 방지).
//   ⚠️ 생존 확인은 **우편번호(ASCII)** 로 한다 — 공공 API는 2026-08-08부터 조건값에 한글이 들어가면
//   0건을 돌려주는 회귀 상태라, 상호(한글) 검색으로 확인하면 살아 있어도 죽은 것으로 오판한다.
const { j: apiProbe } = await jf('/api/restaurants?zip=05021');
const apiUp = Array.isArray(apiProbe) && apiProbe.length > 0;
if (apiUp) {
  const fakeKp = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const fakeSpki = b64(await subtle.exportKey('spki', fakeKp.publicKey));
  // 실존 상호(검색 결과 있음) + 가짜 id → 서버가 'mismatch'로 판정해 400을 내야 한다.
  const { r: fakeR, j: fakeJ } = await jf('/api/register-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: '__nope_9999-0000-0000', restaurant_name: '김밥천국', public_key: fakeSpki }) });
  ok(fakeR.status === 400 && fakeJ && fakeJ.error === 'store_not_found', '가게 선점 방어: 미실존 id 등록 거부(400 store_not_found)');
} else {
  console.log('⏭  가게 선점 방어 단언 건너뜀 — 공공 API 미응답(설계상 등록 허용 경로)');
}

// 6-b) 수신함은 소유 증명 필수(무인증 조회 차단) + 진단 id는 담당자 목록에서 제외.
ok((await jf('/api/inbox?restaurant_id=' + RID)).r.status === 401, '수신함 무인증 조회 401');
const inboxToken = await getAuthToken(kp.privateKey);
const { r: inbR } = await jf('/api/inbox?restaurant_id=' + RID + '&auth_token=' + encodeURIComponent(inboxToken));
ok(inbR.ok, '수신함 소유증명 조회 200');
const { j: listJ } = await jf('/api/registered-list?sido=' + encodeURIComponent('서울특별시'));
ok(listJ && Array.isArray(listJ.restaurants) && !listJ.restaurants.some(x => String(x.restaurant_id).startsWith('__diag_')), '진단용 등록은 담당자 목록에서 제외');

// 6-c) 보안 응답 헤더 4종.
const hres = await fetch(BASE + '/api/registered-list?sido=' + encodeURIComponent('서울특별시'));
ok(hres.headers.get('cache-control') === 'no-store' && hres.headers.get('x-content-type-options') === 'nosniff' && (hres.headers.get('referrer-policy') || '').includes('no-referrer') && (hres.headers.get('strict-transport-security') || '').includes('max-age'), '보안 응답 헤더 4종');

const deregToken = await getAuthToken(kp.privateKey);
ok((await jf('/api/deregister', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: RID, auth_token: deregToken }) })).r.ok, '등록 해제(챌린지-응답 소유 증명 통과)');

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
