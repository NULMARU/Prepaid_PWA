// 다자간 연동 엔드투엔드 검증 (Cloudflare/실키 불필요).
// 실제 Worker 로직(handle) + 메모리 store + 목 LOCALDATA로 암호 전 구간 증명.
import { handle, makeMemoryStore } from '../server/src/worker.js';

const subtle = globalThis.crypto.subtle;
const encU = new TextEncoder(), decU = new TextDecoder();
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + m); };

// ── 공유 crypto (PROTOCOL §2·§3·§4.1, 웹/앱과 동일) ──
function b64(buf){let s='';const b=new Uint8Array(buf);for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s)}
function unb64(s){const x=atob(s),u=new Uint8Array(x.length);for(let i=0;i<x.length;i++)u[i]=x.charCodeAt(i);return u.buffer}
async function sha256hex(str){const h=await subtle.digest('SHA-256',encU.encode(str));return Array.from(new Uint8Array(h)).map(v=>v.toString(16).padStart(2,'0')).join('')}
async function batchHash(items){return sha256hex(items.map(i=>i.name+'|'+i.dept+'|'+i.amount).sort().join('\n'))}
async function genKeyPair(){return subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt'])}
async function encryptBlob(items,pub){
  const aesKey=await subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await subtle.encrypt({name:'AES-GCM',iv},aesKey,encU.encode(JSON.stringify({v:1,items})));
  const raw=await subtle.exportKey('raw',aesKey);
  const encKey=await subtle.encrypt({name:'RSA-OAEP'},pub,raw);
  return{alg:'RSA-OAEP-2048+AES-256-GCM',encKey:b64(encKey),iv:b64(iv),ct:b64(ct)};
}
async function decryptBlob(blob,priv){
  const raw=await subtle.decrypt({name:'RSA-OAEP'},priv,unb64(blob.encKey));
  const aesKey=await subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
  const pt=await subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(unb64(blob.iv))},aesKey,unb64(blob.ct));
  return JSON.parse(decU.decode(pt));
}
function assignDuplicateSuffix(rows){const g=new Map();rows.forEach(r=>{const k=(r.dept||'')+'|'+r.name;if(!g.has(k))g.set(k,[]);g.get(k).push(r)});let c=0;g.forEach(l=>{if(l.length<2)return;l.forEach((r,i)=>{if(!/[a-z]$/.test(r.name)){r.name+=String.fromCharCode(97+i);c++}})});return c}

// 공공데이터 목 카탈로그(F-01 등록 검증용). 서버는 최초 등록 시 이 목록으로 "그 restaurant_id가
// 실제로 있고 상호가 일치하는지"를 대조한다. 아래 call()은 /api/register-key 호출을 만나면
// 그 가게를 자동으로 카탈로그에 등재해 준다(기존 시나리오가 전부 '실존 가게'로 동작하게).
// 실존/이름 불일치·공공API 장애 회귀는 등재를 건너뛰는 callRaw()로 직접 호출해 검증한다.
const publicCatalog = new Map([['MGT-0001', '정식김밥'], ['MGT-0002', '한밭식당']]);
const seedStore = (id, name) => publicCatalog.set(String(id), String(name == null ? '' : name));

const callRaw = (store, env, method, path, body) =>
  handle(new Request('http://x' + path, body !== undefined
    ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { method }), env, store);
const call = (store, env, method, path, body) => {
  if (method === 'POST' && path === '/api/register-key' && body && body.restaurant_id)
    seedStore(body.restaurant_id, body.restaurant_name);
  return callRaw(store, env, method, path, body);
};
// 헤더(X-Agency-Token 등)까지 지정해야 하는 호출용.
const callH = (store, env, method, path, body, headers) =>
  handle(new Request('http://x' + path, { method, headers: { 'content-type': 'application/json', ...(headers||{}) }, body: body !== undefined ? JSON.stringify(body) : undefined }), env, store);

// 소유 증명 챌린지-응답 전 과정을 실제 RSA 키로 수행 → auth_token(base64) 문자열 반환.
async function getAuthToken(store, env, restaurant_id, privateKey) {
  const r = await call(store, env, 'POST', '/api/challenge', { restaurant_id });
  if (r.status !== 200) return null;
  const { challenge_ct } = await r.json();
  const pt = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, unb64(challenge_ct));
  return decU.decode(pt);
}
// 수신함은 소유 증명 필수(F-02) — 매 호출마다 1회용 auth_token을 새로 받아 쿼리에 싣는다.
async function inboxOf(store, env, restaurant_id, privateKey) {
  const t = await getAuthToken(store, env, restaurant_id, privateKey);
  return await call(store, env, 'GET', '/api/inbox?restaurant_id=' + encodeURIComponent(restaurant_id) + '&auth_token=' + encodeURIComponent(t || ''));
}

(async () => {
  const store = makeMemoryStore();
  const RID = 'MGT-0001';
  const env = {
    ALLOW_ORIGIN: '*',
    AUTH_MODE: 'dev',
    REQUIRE_AGENCY_AUTH: '0',
    // 목 LOCALDATA: 실제 키/엔드포인트 대체. 카탈로그(publicCatalog)를 그대로 돌려주되
    // 이름 부분일치 필터만 적용한다(defaultSearch와 동일한 계약 — region은 선택).
    searchRestaurants: async (_env, region, q) => {
      const kw = String(q || '').trim();
      return [...publicCatalog].map(([restaurant_id, name]) =>
        ({ restaurant_id, name, address: '서울 강남구', status: '영업/정상' }))
        .filter(r => !kw || r.name.includes(kw));
    }
  };
  const badCipher = { ct: 'x', encKey: 'y' };

  // 1) 음식점 앱: 키페어 생성 → 공개키 등록
  const kp = await genKeyPair();
  const spki = b64(await subtle.exportKey('spki', kp.publicKey));
  let r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID, restaurant_name: '정식김밥', public_key: spki });
  ok(r.status === 200, '공개키 등록 200');

  // 2) 담당자 웹: 음식점 검색(지역 필수)
  r = await call(store, env, 'GET', '/api/restaurants?region=6110000&q=김밥');
  const found = await r.json();
  ok(Array.isArray(found) && found.length === 1 && found[0].restaurant_id === RID, '음식점 검색 프록시 결과');
  r = await call(store, env, 'GET', '/api/restaurants');
  ok(r.status === 400, '지역 누락 시 400(지역 필수)');
  // 우편번호 경로(2026-08 공공API 한글 조건 장애 우회, PROTOCOL §7.4): 5자리 숫자만 허용하고
  // 우편번호만으로도 검색이 성립해야 한다(상호 없이 후보 목록을 받는 흐름).
  r = await call(store, env, 'GET', '/api/restaurants?zip=05021');
  ok(r.status === 200, '우편번호만으로 검색 200');
  r = await call(store, env, 'GET', '/api/restaurants?zip=123');
  ok(r.status === 400, '우편번호 5자리가 아니면 400');

  // 3) 담당자 웹: 공개키 조회 → 명단 암호화 → 제출
  r = await call(store, env, 'GET', '/api/public-key?restaurant_id=' + RID);
  const pkj = await r.json();
  const pub = await subtle.importKey('spki', unb64(pkj.public_key), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const items = [
    { name: '김철수', dept: '세무과', amount: 90000 },
    { name: '김철수', dept: '세무과', amount: 90000 }, // 동명이인(접미사 누락)
    { name: '박영희', dept: '세무과', amount: 90000 }
  ];
  const blob = await encryptBlob(items, pub);
  const bh = await batchHash(items);
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 강남구', department: '세무과', restaurant_id: RID, restaurant_name: '정식김밥', year_month: '2026-07', total_amount: 270000, member_count: 3, batch_hash: bh },
    blob: { restaurant_id: RID, ciphertext: blob },
    consent: { institution: '서울특별시 강남구', department: '세무과', year_month: '2026-07' }
  });
  const sj = await r.json();
  ok(r.status === 200 && sj.summary_id, '제출 200 + summary_id');

  // 평문 PII 거부 가드
  r = await call(store, env, 'POST', '/api/submit', { summary: {}, blob: { ciphertext: { items: [{ name: '평문', amount: 1 }] } } });
  ok(r.status === 400, '평문 ciphertext 제출 거부(불변식)');

  // 4) 서버는 개인정보 평문 미저장 확인
  const dump = store._dump();
  const summaryHasNoNames = dump.summaries.every(s => !('items' in s) && !('name' in s) && typeof s.total_amount === 'number');
  ok(summaryHasNoNames, 'deposit_summary에 이름/개인금액 없음(총액·해시만)');
  const blobsAreCipher = dump.blobs.every(b => { const c = JSON.parse(b.ciphertext); return c.ct && c.encKey && !c.items; });
  ok(blobsAreCipher, 'encrypted_blob은 암호문만(평문 명단 없음)');

  // 5) 음식점 앱: 수신함 폴링 → 표시(이름 미열람)
  r = await inboxOf(store, env, RID, kp.privateKey);
  const inbox = await r.json();
  ok(inbox.length === 1 && inbox[0].summary.member_count === 3 && inbox[0].summary.total_amount === 270000, '수신함: 부서·총액·인원만 노출(이름 ❌)');

  // 6) 소유 증명 인증 전 구간: approve 무토큰 401 → 챌린지→복호화→approve 200 → 토큰 재사용 401
  r = await call(store, env, 'POST', '/api/approve', { summary_id: inbox[0].summary_id, status: 'APPROVED', restaurant_id: RID });
  ok(r.status === 401, 'approve: auth_token 없이 401(auth_required)');

  const authToken1 = await getAuthToken(store, env, RID, kp.privateKey);
  ok(typeof authToken1 === 'string' && authToken1.length > 0, '챌린지 발급 + 개인키 복호화로 auth_token 획득');
  r = await call(store, env, 'POST', '/api/approve', { summary_id: inbox[0].summary_id, status: 'APPROVED', restaurant_id: RID, auth_token: authToken1 });
  ok(r.status === 200, '개별 승인 200(소유 증명 통과)');

  r = await call(store, env, 'POST', '/api/approve', { summary_id: inbox[0].summary_id, status: 'APPROVED', restaurant_id: RID, auth_token: authToken1 });
  ok(r.status === 401, 'approve: 동일 auth_token 재사용 401(1회용 토큰)');

  // 복호화 + 무결성
  const plain = await decryptBlob(inbox[0].ciphertext, kp.privateKey);
  ok(plain.items.length === 3 && plain.items[0].name === '김철수', '음식점 앱 복호화 성공');
  const reHash = await batchHash(plain.items);
  ok(reHash === bh, 'batch_hash 재계산 일치(전송 변조 없음)');
  // 오라클 차단(§4.9): 수신함 요약에는 batch_hash가 실리지 않는다 — 서버가 가진 값을 되돌려주면
  // "이 명단이 맞나"를 서버에 물어볼 수 있는 확인 채널이 된다. 수신 측 검증은 blob 내부 값으로.
  ok(!('batch_hash' in inbox[0].summary), '수신함 요약에 batch_hash 없음(오라클 차단)');
  const changed = assignDuplicateSuffix(plain.items);
  ok(changed === 2 && plain.items[0].name === '김철수a' && plain.items[1].name === '김철수b', '동명이인 자동 보완(a/b)');

  // 변조 탐지: ct 1바이트 변경 → 복호화 실패 또는 해시 불일치
  let tamperCaught = false;
  try { const bad = { ...inbox[0].ciphertext, ct: inbox[0].ciphertext.ct.slice(0, -2) + (inbox[0].ciphertext.ct.slice(-2) === 'AA' ? 'BB' : 'AA') }; await decryptBlob(bad, kp.privateKey); } catch { tamperCaught = true; }
  ok(tamperCaught, '암호문 변조 시 복호화 실패(탐지)');

  // 승인 후 수신함 비워짐(PENDING 아님)
  r = await inboxOf(store, env, RID, kp.privateKey);
  ok((await r.json()).length === 0, '승인 후 수신함에서 제거');

  // 이미 처리된 summary를 '새' 유효 토큰으로 재승인 시도 → 인증은 통과하지만 상태 전이 가드에서 409
  const authToken1b = await getAuthToken(store, env, RID, kp.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: inbox[0].summary_id, status: 'APPROVED', restaurant_id: RID, auth_token: authToken1b });
  const rj409 = await r.json();
  ok(r.status === 409 && rj409.error === 'already_processed', 'approve: 이미 처리된 summary는 새 토큰으로도 409(상태 전이 가드)');

  // restaurant_id 불일치(다른 음식점이 남의 summary를 승인 시도) → 403
  const RIDX = 'MGT-000X';
  const kpX = await genKeyPair();
  const spkiX = b64(await subtle.exportKey('spki', kpX.publicKey));
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDX, restaurant_name: '남의가게', public_key: spkiX });
  const authTokenX = await getAuthToken(store, env, RIDX, kpX.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: inbox[0].summary_id, status: 'APPROVED', restaurant_id: RIDX, auth_token: authTokenX });
  ok(r.status === 403, 'approve: summary의 restaurant_id와 불일치 시 403(auth_token은 소비되지 않음)');

  // 7) 담당자 등록 조회 + 음식점 등록 해제(선금 받기 중단, 인증 필요)
  r = await call(store, env, 'GET', '/api/registered?ids=' + RID + ',NOPE-999');
  ok((await r.json()).length === 1, '/api/registered: 등록된 것만 반환');
  r = await call(store, env, 'POST', '/api/deregister', { restaurant_id: RID });
  ok(r.status === 401, 'deregister: auth_token 없이 401');
  const deregToken = await getAuthToken(store, env, RID, kp.privateKey);
  r = await call(store, env, 'POST', '/api/deregister', { restaurant_id: RID, auth_token: deregToken });
  ok(r.status === 200, '등록 해제(선금 받기 중단) 200(소유 증명 통과)');
  ok((await call(store, env, 'GET', '/api/public-key?restaurant_id=' + RID)).status === 404, '해제 후 공개키 404(담당자 전송 불가)');
  r = await call(store, env, 'GET', '/api/registered?ids=' + RID);
  ok((await r.json()).length === 0, '해제 후 registered에서 제외');

  // 8) register-key 재등록 인증(감사 항목 1 갱신: 409 하드블록 → 소유 증명으로 대체)
  const RID3 = 'MGT-0003';
  const kp3 = await genKeyPair();
  const spki3 = b64(await subtle.exportKey('spki', kp3.publicKey));
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID3, restaurant_name: '테스트', public_key: spki3 });
  ok(r.status === 200, 'register-key: 최초 등록 200(인증 불요)');

  const kp3b = await genKeyPair();
  const spki3b = b64(await subtle.exportKey('spki', kp3b.publicKey));
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID3, restaurant_name: '테스트', public_key: spki3b });
  ok(r.status === 401, 'register-key: 무인증 다른 키 재등록 401(auth_required)');

  const tok3 = await getAuthToken(store, env, RID3, kp3.privateKey);
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID3, restaurant_name: '테스트', public_key: spki3b, auth_token: tok3 });
  ok(r.status === 200, 'register-key: 기존 키 소유 증명 후 다른 키로 재등록 200');

  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID3, restaurant_name: '테스트', public_key: spki3b });
  ok(r.status === 200, 'register-key: 재등록(동일 키, 재시도) 200 멱등(인증 불요)');

  r = await call(store, env, 'POST', '/api/deregister', { restaurant_id: RID3 });
  ok(r.status === 401, 'register-key 테스트: deregister 무인증 401');
  const tok3d = await getAuthToken(store, env, RID3, kp3b.privateKey);
  r = await call(store, env, 'POST', '/api/deregister', { restaurant_id: RID3, auth_token: tok3d });
  ok(r.status === 200, 'register-key 테스트: deregister 인증 후 200');

  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID3, restaurant_name: '테스트', public_key: spki3b });
  ok(r.status === 200, 'register-key: deregister 후 재등록(신규 최초 등록 취급) 200');
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'MGT-LEN', restaurant_name: 'x', public_key: 'A'.repeat(8193) });
  ok(r.status === 400, 'register-key: public_key 길이 상한(8KB) 초과 400');

  // 9) 금액/인원 검증(감사 항목 3): Number(v)|0 은 NaN·음수·32비트 랩어라운드를 조용히 통과시키던 버그
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0004', total_amount: 'abc', member_count: 1, batch_hash: 'h-nan' }, blob: { ciphertext: badCipher } });
  ok(r.status === 400, 'submit: total_amount NaN 400');
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0004', total_amount: -1, member_count: 1, batch_hash: 'h-neg' }, blob: { ciphertext: badCipher } });
  ok(r.status === 400, 'submit: total_amount 음수 400');
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0004', total_amount: 2e13, member_count: 1, batch_hash: 'h-huge' }, blob: { ciphertext: badCipher } });
  ok(r.status === 400, 'submit: total_amount 상한(1e13) 초과 400');
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0004', total_amount: 4294967301, member_count: 1, batch_hash: 'h-32wrap' }, blob: { ciphertext: badCipher } });
  const rj3 = await r.json();
  ok(r.status === 200 && !!rj3.summary_id, 'submit: 2^32 초과 금액도(1e13 이하면) 정상 처리(랩어라운드 없음)');
  const dump2 = store._dump();
  const stored32 = dump2.summaries.find(x => x.batch_hash === 'h-32wrap');
  ok(!!stored32 && stored32.total_amount === 4294967301, 'submit: 저장된 금액이 32비트 랩어라운드 없이 정확함(구 |0 버그면 5로 깨짐)');
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0004', total_amount: 100, member_count: -1, batch_hash: 'h-cnt-neg' }, blob: { ciphertext: badCipher } });
  ok(r.status === 400, 'submit: member_count 음수 400');
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0004', total_amount: 100, member_count: 200000, batch_hash: 'h-cnt-huge' }, blob: { ciphertext: badCipher } });
  ok(r.status === 400, 'submit: member_count 상한(100000) 초과 400');

  // 10) 중복 제출 방지(감사 항목 6): 동일 (restaurant_id,batch_hash) 재제출 시 기존 summary_id 반환(멱등)
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0005', restaurant_name: '중복테스트', total_amount: 500, member_count: 2, batch_hash: 'h-dup' }, blob: { ciphertext: badCipher } });
  const rjA = await r.json();
  ok(r.status === 200 && !!rjA.summary_id, 'submit: 최초 제출 200');
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0005', restaurant_name: '중복테스트', total_amount: 999, member_count: 9, batch_hash: 'h-dup' }, blob: { ciphertext: badCipher } });
  const rjB = await r.json();
  ok(r.status === 200 && rjB.summary_id === rjA.summary_id, 'submit: 동일 (restaurant_id,batch_hash) 재제출 시 기존 summary_id 반환(멱등)');
  const dump3 = store._dump();
  ok(dump3.summaries.filter(x => x.batch_hash === 'h-dup').length === 1, 'submit: 중복 제출로 새 summary 레코드가 생기지 않음');

  // 11) CORS 화이트리스트(감사 항목 7): 목록 안 Origin은 echo, 목록 밖/무 Origin은 헤더 생략(차단 아님)
  const envCors = { ...env, ALLOW_ORIGIN: 'https://a.example,https://b.example' };
  let rc = await handle(new Request('http://x/api/registered?ids=x', { method: 'GET', headers: { Origin: 'https://a.example' } }), envCors, store);
  ok(rc.headers.get('Access-Control-Allow-Origin') === 'https://a.example', 'CORS: 화이트리스트 Origin echo');
  rc = await handle(new Request('http://x/api/registered?ids=x', { method: 'GET', headers: { Origin: 'https://evil.example' } }), envCors, store);
  ok(rc.status === 200 && !rc.headers.get('Access-Control-Allow-Origin'), 'CORS: 화이트리스트 밖 Origin은 응답은 200이나 CORS 헤더 생략');
  rc = await handle(new Request('http://x/api/registered?ids=x', { method: 'GET' }), envCors, store);
  ok(rc.status === 200, 'CORS: Origin 헤더 없는 요청(curl/하니스/서버간)은 차단되지 않음');

  // 12) 최상위 에러 응답 일반화(감사 항목 4): 클라이언트에는 상세 노출 안 함
  r = await handle(new Request('http://x/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid json' }), env, store);
  const rjErr = await r.json();
  ok(r.status === 500 && rjErr.error === 'internal' && Object.keys(rjErr).length === 1, '최상위 오류 응답: {error:"internal"}만 반환(상세 미노출)');

  // 13) 암호화 원장 클라우드 백업(zero-knowledge) — 업로드/다운로드/무인증
  const RID6 = 'MGT-0006';
  const kp6 = await genKeyPair();
  const spki6 = b64(await subtle.exportKey('spki', kp6.publicKey));
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID6, restaurant_name: '백업테스트', public_key: spki6 });
  ok(r.status === 200, 'ledger-backup: 사전 공개키 등록 200');

  r = await call(store, env, 'POST', '/api/ledger-backup', { restaurant_id: RID6, blob: 'ZmFrZS1jaXBoZXJ0ZXh0LWJhY2t1cA==', blob_hash: 'hash-1' });
  ok(r.status === 401, 'ledger-backup: 무인증 업로드 401');

  const tok6 = await getAuthToken(store, env, RID6, kp6.privateKey);
  r = await call(store, env, 'POST', '/api/ledger-backup', { restaurant_id: RID6, auth_token: tok6, blob: 'ZmFrZS1jaXBoZXJ0ZXh0LWJhY2t1cA==', blob_hash: 'hash-1' });
  ok(r.status === 200, 'ledger-backup: 인증 후 업로드 200');

  r = await call(store, env, 'POST', '/api/ledger-backup/get', { restaurant_id: RID6 });
  ok(r.status === 401, 'ledger-backup: 무인증 다운로드 401');

  const tok6b = await getAuthToken(store, env, RID6, kp6.privateKey);
  r = await call(store, env, 'POST', '/api/ledger-backup/get', { restaurant_id: RID6, auth_token: tok6b });
  const rj6 = await r.json();
  ok(r.status === 200 && rj6.blob === 'ZmFrZS1jaXBoZXJ0ZXh0LWJhY2t1cA==' && rj6.blob_hash === 'hash-1', 'ledger-backup: 인증 후 다운로드 원본 blob 그대로 수신');

  const dumpLedger = store._dump();
  ok([...dumpLedger.ledgerBackups.values()].every(b => b.blob !== 'plaintext'), 'ledger-backup: 서버 저장본은 클라이언트 암호문 그대로(서버는 내용을 알지 못함)');

  // 13b) ledger_backup 삭제 경로(감사 항목 2): deregister 시 백업도 함께 삭제
  const RID6B = 'MGT-0006B';
  const kp6B = await genKeyPair();
  const spki6B = b64(await subtle.exportKey('spki', kp6B.publicKey));
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID6B, restaurant_name: '백업삭제테스트', public_key: spki6B });
  ok(r.status === 200, 'ledger-backup 삭제: 사전 공개키 등록 200');
  let tok6B = await getAuthToken(store, env, RID6B, kp6B.privateKey);
  r = await call(store, env, 'POST', '/api/ledger-backup', { restaurant_id: RID6B, auth_token: tok6B, blob: 'YmFja3VwLTE=', blob_hash: 'hb-1' });
  ok(r.status === 200, 'ledger-backup 삭제: 업로드 200');
  const tok6Bd = await getAuthToken(store, env, RID6B, kp6B.privateKey);
  r = await call(store, env, 'POST', '/api/deregister', { restaurant_id: RID6B, auth_token: tok6Bd });
  ok(r.status === 200, 'ledger-backup 삭제: deregister 200');
  // deregister로 공개키가 사라지면 더는 챌린지를 발급받을 수 없어(§4.1) 백업 조회 자체가 불가능해진다.
  r = await call(store, env, 'POST', '/api/challenge', { restaurant_id: RID6B });
  ok(r.status === 404, 'ledger-backup 삭제: deregister 후에는 챌린지 발급도 불가(공개키 없음 — 백업을 되찾을 길이 없음을 방증)');
  ok(!store._dump().ledgerBackups.has(RID6B), 'ledger-backup 삭제: deregister 시 ledger_backup도 함께 삭제됨(D1/메모리)');

  // POST /api/ledger-backup/delete: 무인증 401, 인증 후 200, 삭제 후 조회 404
  const RID6C = 'MGT-0006C';
  const kp6C = await genKeyPair();
  const spki6C = b64(await subtle.exportKey('spki', kp6C.publicKey));
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID6C, restaurant_name: '백업삭제테스트2', public_key: spki6C });
  ok(r.status === 200, 'ledger-backup/delete: 사전 공개키 등록 200');
  const tok6C1 = await getAuthToken(store, env, RID6C, kp6C.privateKey);
  r = await call(store, env, 'POST', '/api/ledger-backup', { restaurant_id: RID6C, auth_token: tok6C1, blob: 'YmFja3VwLTI=', blob_hash: 'hb-2' });
  ok(r.status === 200, 'ledger-backup/delete: 업로드 200');
  r = await call(store, env, 'POST', '/api/ledger-backup/delete', { restaurant_id: RID6C });
  ok(r.status === 401, 'ledger-backup/delete: 무인증 401');
  const tok6C2 = await getAuthToken(store, env, RID6C, kp6C.privateKey);
  r = await call(store, env, 'POST', '/api/ledger-backup/delete', { restaurant_id: RID6C, auth_token: tok6C2 });
  ok(r.status === 200, 'ledger-backup/delete: 인증 후 삭제 200');
  const tok6C3 = await getAuthToken(store, env, RID6C, kp6C.privateKey);
  r = await call(store, env, 'POST', '/api/ledger-backup/get', { restaurant_id: RID6C, auth_token: tok6C3 });
  ok(r.status === 404, 'ledger-backup/delete: 삭제 후 조회 404');
  const tok6C4 = await getAuthToken(store, env, RID6C, kp6C.privateKey);
  r = await call(store, env, 'POST', '/api/ledger-backup/delete', { restaurant_id: RID6C, auth_token: tok6C4 });
  ok(r.status === 404, 'ledger-backup/delete: 이미 없는 백업 재삭제 시도 404');

  // 14) 기관 OTP 인증(dev 플로우)
  r = await call(store, env, 'POST', '/api/agency/request-otp', { email: 'officer@example.com' });
  ok(r.status === 400, 'agency-otp: 비정부 도메인 400');

  r = await call(store, env, 'POST', '/api/agency/request-otp', { email: 'officer@seoul.go.kr' });
  const rjOtp = await r.json();
  ok(r.status === 200 && rjOtp.ok === true && typeof rjOtp.dev_otp === 'string' && /^\d{6}$/.test(rjOtp.dev_otp), 'agency-otp: AUTH_MODE=dev에서 dev_otp(6자리) 포함 응답');

  r = await call(store, env, 'POST', '/api/agency/request-otp', { email: 'officer@seoul.go.kr' });
  ok(r.status === 429, 'agency-otp: 이메일당 분당 1회 재요청 제한(429)');

  r = await call(store, env, 'POST', '/api/agency/verify-otp', { email: 'officer@seoul.go.kr', otp: '000000' });
  ok(r.status === 401, 'agency-otp: 오답 401(invalid_otp)');

  r = await call(store, env, 'POST', '/api/agency/verify-otp', { email: 'officer@seoul.go.kr', otp: rjOtp.dev_otp });
  const rjAgencyTok = await r.json();
  ok(r.status === 200 && typeof rjAgencyTok.token === 'string' && rjAgencyTok.token.length > 0, 'agency-otp: 정답 검증 → 24시간 기관 토큰 발급');

  r = await call(store, env, 'POST', '/api/agency/verify-otp', { email: 'officer@seoul.go.kr', otp: rjOtp.dev_otp });
  ok(r.status === 401, 'agency-otp: OTP는 1회용(검증 성공 후 삭제) — 재검증 401');

  // 14b) AUTH_MODE=pilot(감사 항목 1 — 베타 운영값): 어떤 응답에도 평문 OTP가 실려나가지 않고,
  // 이메일 발송 인프라가 아직 없음을 sent:false로 명시한다(미발송).
  const envPilot = { ...env, AUTH_MODE: 'pilot' };
  r = await call(store, envPilot, 'POST', '/api/agency/request-otp', { email: 'pilot-officer@seoul.go.kr' });
  const rjPilotOtp = await r.json();
  ok(r.status === 200 && rjPilotOtp.ok === true && rjPilotOtp.sent === false && !('dev_otp' in rjPilotOtp) && !('otp' in rjPilotOtp),
    'agency-otp: AUTH_MODE=pilot에서는 응답에 평문 OTP 필드가 전혀 없고(dev_otp/otp 모두 부재) sent:false(미발송)');

  // 14c) AUTH_MODE=prod: Resend REST API(env.RESEND_API_KEY secret)로 실제 발송.
  // globalThis.fetch를 이 블록 범위에서만 스텁하고 호출 직후 원래 fetch로 복원한다
  // (다른 테스트가 실 네트워크 fetch에 의존하지 않는지 위에서 확인함 — searchRestaurants는
  // 항상 env.searchRestaurants 목으로 주입되어 defaultSearch의 실 fetch 경로는 타지 않는다).
  const realFetch = globalThis.fetch;
  const makeFetchStub = (response) => ({
    calls: [],
    fn: async function (url, init) {
      this.calls.push({ url, init });
      if (response.reject) throw response.reject;
      return { ok: response.ok, status: response.status };
    }
  });
  const envProd = { ...env, AUTH_MODE: 'prod', RESEND_API_KEY: 'test-resend-key' };

  // 14c-1) 정상 발송(fetch 2xx): fetch 정확히 1회, URL·Authorization·from/to·6자리 본문 확인,
  // 응답은 sent:true이며 otp/dev_otp 없음.
  let stub = makeFetchStub({ ok: true, status: 200 });
  globalThis.fetch = stub.fn.bind(stub);
  try {
    r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: 'prod-officer@seoul.go.kr' });
  } finally { globalThis.fetch = realFetch; }
  const rjProdOtp = await r.json();
  ok(r.status === 200 && rjProdOtp.ok === true && rjProdOtp.sent === true && !('dev_otp' in rjProdOtp) && !('otp' in rjProdOtp),
    'agency-otp: AUTH_MODE=prod에서도 응답에 평문 OTP 필드 없음(+ sent:true, 실제 발송)');
  ok(stub.calls.length === 1, 'agency-otp: AUTH_MODE=prod → Resend fetch가 정확히 1회 호출됨');
  const sentCall = stub.calls[0] || {};
  ok(sentCall.url === 'https://api.resend.com/emails', 'agency-otp: Resend 호출 URL = https://api.resend.com/emails');
  ok(!!sentCall.init && !!sentCall.init.headers && sentCall.init.headers['Authorization'] === 'Bearer test-resend-key',
    'agency-otp: Resend 호출 Authorization 헤더 = Bearer RESEND_API_KEY');
  const sentBody = sentCall.init && sentCall.init.body ? JSON.parse(sentCall.init.body) : {};
  ok(sentBody.from === '밥장부 <noreply@bapjangbu.com>', 'agency-otp: Resend 발신자 = 밥장부 <noreply@bapjangbu.com>');
  ok(Array.isArray(sentBody.to) && sentBody.to[0] === 'prod-officer@seoul.go.kr', 'agency-otp: Resend 수신자 = 요청 이메일');
  ok(/\d{6}/.test(sentBody.text || '') && /\d{6}/.test(sentBody.html || ''),
    'agency-otp: Resend 요청 본문(text+html)에 6자리 인증번호 포함');

  // 14c-2) Resend가 비2xx 응답 → 500 email_send_failed, 평문 OTP는 어디에도 없음.
  stub = makeFetchStub({ ok: false, status: 500 });
  globalThis.fetch = stub.fn.bind(stub);
  try {
    r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: 'prod-officer-fail@seoul.go.kr' });
  } finally { globalThis.fetch = realFetch; }
  const rjProdFail = await r.json();
  ok(r.status === 500 && rjProdFail.error === 'email_send_failed' && !('dev_otp' in rjProdFail) && !('otp' in rjProdFail),
    'agency-otp: AUTH_MODE=prod + Resend 비2xx 응답 → 500 email_send_failed');

  // 14c-2b) Resend가 429(무료 플랜 하루/월 발송 한도 초과) → 429 email_quota_exceeded로 구분.
  //   담당자 입력 오류가 아니라 "오늘 한도 도달 — 다음 날 재시도" 안내를 띄우기 위한 코드다.
  stub = makeFetchStub({ ok: false, status: 429 });
  globalThis.fetch = stub.fn.bind(stub);
  try {
    r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: 'prod-officer-quota@seoul.go.kr' });
  } finally { globalThis.fetch = realFetch; }
  const rjProdQuota = await r.json();
  ok(r.status === 429 && rjProdQuota.error === 'email_quota_exceeded' && !('dev_otp' in rjProdQuota) && !('otp' in rjProdQuota),
    'agency-otp: AUTH_MODE=prod + Resend 429(발송 한도) → 429 email_quota_exceeded');

  // 14c-3) fetch 자체가 reject(네트워크 오류) → 500 email_send_failed.
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: 'prod-officer-fail2@seoul.go.kr' });
  } finally { globalThis.fetch = realFetch; }
  const rjProdFail2 = await r.json();
  ok(r.status === 500 && rjProdFail2.error === 'email_send_failed' && !('dev_otp' in rjProdFail2) && !('otp' in rjProdFail2),
    'agency-otp: AUTH_MODE=prod + fetch reject(네트워크 오류) → 500 email_send_failed');

  // 14c-4) RESEND_API_KEY 미설정 → 발송 시도 없이(fetch 미호출) 500 email_not_configured.
  stub = makeFetchStub({ ok: true, status: 200 });
  globalThis.fetch = stub.fn.bind(stub);
  const envProdNoKey = { ...env, AUTH_MODE: 'prod' };
  try {
    r = await call(store, envProdNoKey, 'POST', '/api/agency/request-otp', { email: 'prod-officer-nokey@seoul.go.kr' });
  } finally { globalThis.fetch = realFetch; }
  const rjProdNoKey = await r.json();
  ok(r.status === 500 && rjProdNoKey.error === 'email_not_configured' && stub.calls.length === 0,
    'agency-otp: AUTH_MODE=prod + RESEND_API_KEY 미설정 → fetch 미호출, 500 email_not_configured');

  // 14d) 발송 실패 시 60초 스로틀을 소모하지 않는다(재시도 블랙홀 방지):
  // 발송에 실패하면 방금 쓴 OTP 행을 되돌리므로 곧바로 재요청이 가능해야 한다(429가 아니어야 함).
  const RETRY_EMAIL = 'retry-officer@seoul.go.kr';
  const retryHash = await sha256hex(RETRY_EMAIL);
  stub = makeFetchStub({ ok: false, status: 500 });
  globalThis.fetch = stub.fn.bind(stub);
  try {
    r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: RETRY_EMAIL });
  } finally { globalThis.fetch = realFetch; }
  ok(r.status === 500 && (await r.json()).error === 'email_send_failed', 'agency-otp 재시도: 1차 발송 실패 500(email_send_failed)');
  ok(!store._dump().agencyOtps.has(retryHash), 'agency-otp 재시도: 발송 실패 시 방금 쓴 OTP 행이 삭제됨(스로틀 미소모)');
  // 즉시 재요청(같은 이메일) — 스로틀이 소모됐다면 429가 났을 것이다.
  stub = makeFetchStub({ ok: true, status: 200 });
  globalThis.fetch = stub.fn.bind(stub);
  try {
    r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: RETRY_EMAIL });
  } finally { globalThis.fetch = realFetch; }
  const rjRetry = await r.json();
  ok(r.status === 200 && rjRetry.sent === true, 'agency-otp 재시도: 발송 실패 직후 즉시 재요청 성공(429 rate_limited 아님)');
  // 반대 확인: 발송에 성공한 뒤에는 60초 스로틀이 정상 작동한다(행이 남아 있으므로).
  stub = makeFetchStub({ ok: true, status: 200 });
  globalThis.fetch = stub.fn.bind(stub);
  try {
    r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: RETRY_EMAIL });
  } finally { globalThis.fetch = realFetch; }
  ok(r.status === 429 && stub.calls.length === 0, 'agency-otp 재시도: 발송 성공 후 60초 내 재요청은 여전히 429(스로틀 유지)');

  // 14e) 이메일 형식 검증: 도메인 검사만으로는 통과하던 "@go.kr" 류를 400으로 거른다.
  for (const bad of ['@go.kr', 'no-at-sign.go.kr', 'a b@go.kr']) {
    r = await call(store, env, 'POST', '/api/agency/request-otp', { email: bad });
    const rjBad = await r.json();
    ok(r.status === 400 && rjBad.error === 'invalid_email', 'agency-otp: 형식 오류 이메일 400(invalid_email) — ' + JSON.stringify(bad));
  }

  // 14f) 허용 도메인 매트릭스(2026-08 확장): go.kr·korea.kr(공공기관) + or.kr(복지관·공단) +
  // ac.kr(학교). 라벨 경계를 정확히 잡으므로 부분 문자열 오매칭(evilgo.kr)·다른 TLD로 이어지는
  // 위장 도메인(go.kr.attacker.com)은 통과하지 못한다.
  for (const good of ['a@seoul.go.kr', 'a@korea.kr', 'a@sub.go.kr', 'a@welfare.or.kr', 'a@univ.ac.kr']) {
    r = await call(store, env, 'POST', '/api/agency/request-otp', { email: good });
    const rjGood = await r.json();
    ok(r.status === 200 && rjGood.ok === true && /^\d{6}$/.test(rjGood.dev_otp || ''),
      'agency-otp 도메인 허용: ' + good);
  }
  for (const bad of ['a@gmail.com', 'a@naver.com', 'a@evilgo.kr', 'a@go.kr.attacker.com', 'a@ac.kr.evil.com']) {
    r = await call(store, env, 'POST', '/api/agency/request-otp', { email: bad });
    const rjBad = await r.json();
    ok(r.status === 400 && rjBad.error === 'invalid_domain', 'agency-otp 도메인 거부(invalid_domain): ' + bad);
  }
  // 로컬파트가 빈 값은 도메인이 허용 목록이어도 형식 검증(invalid_email)에서 먼저 걸린다.
  r = await call(store, env, 'POST', '/api/agency/request-otp', { email: '@or.kr' });
  ok(r.status === 400 && (await r.json()).error === 'invalid_email', 'agency-otp 도메인 거부: 빈 로컬파트 "@or.kr" 400(invalid_email)');

  // 15) REQUIRE_AGENCY_AUTH=1일 때 /api/submit 게이트 + consent_log 이메일 해시 기록
  const envRequireAgency = { ...env, REQUIRE_AGENCY_AUTH: '1' };
  r = await call(store, envRequireAgency, 'POST', '/api/submit', {
    summary: { restaurant_id: 'MGT-0007', total_amount: 100, member_count: 1, batch_hash: 'h-agency-noauth' },
    blob: { ciphertext: badCipher }
  });
  ok(r.status === 401, 'submit: REQUIRE_AGENCY_AUTH=1 + 토큰 없음 → 401(agency_auth_required)');

  r = await callH(store, envRequireAgency, 'POST', '/api/submit', {
    summary: { restaurant_id: 'MGT-0007', total_amount: 100, member_count: 1, batch_hash: 'h-agency-badtoken' },
    blob: { ciphertext: badCipher }
  }, { 'X-Agency-Token': 'not-a-real-token' });
  ok(r.status === 401, 'submit: REQUIRE_AGENCY_AUTH=1 + 무효 토큰 → 401');

  r = await callH(store, envRequireAgency, 'POST', '/api/submit', {
    summary: { restaurant_id: 'MGT-0007', total_amount: 100, member_count: 1, batch_hash: 'h-agency-ok' },
    blob: { ciphertext: badCipher },
    consent: { institution: '서울특별시', department: '세무과', year_month: '2026-07' }
  }, { 'X-Agency-Token': rjAgencyTok.token });
  const rjAgencyOk = await r.json();
  ok(r.status === 200 && !!rjAgencyOk.summary_id, 'submit: REQUIRE_AGENCY_AUTH=1 + 유효 토큰 → 200 통과');

  // 15b) 저장소에 평문 이메일 부재(불변식 3): agency_otp·agency_token은 이메일의 SHA-256 해시(64자 hex)만
  // 보관한다. 위에서 여러 이메일로 request-otp/verify-otp를 돌린 뒤이므로 저장소 내부를 직접 검사한다.
  const dumpEmail = store._dump();
  const HEX64 = /^[0-9a-f]{64}$/;
  ok([...dumpEmail.agencyOtps.keys()].length > 0 && [...dumpEmail.agencyOtps.keys()].every(k => HEX64.test(k)),
    '이메일 해시화: agency_otp 키가 모두 64자 hex(평문 이메일 아님)');
  ok([...dumpEmail.agencyOtps.values()].every(o => HEX64.test(o.email_hash) && !JSON.stringify(o).includes('@')),
    '이메일 해시화: agency_otp 저장 값에 평문 이메일(@) 없음');
  ok([...dumpEmail.agencyTokens.values()].length > 0 && [...dumpEmail.agencyTokens.values()].every(t => HEX64.test(t.email_hash) && !JSON.stringify(t).includes('@')),
    '이메일 해시화: agency_token에도 이메일 해시만 저장(평문 없음)');

  const dumpConsent = store._dump();
  const expectedHash = await sha256hex('officer@seoul.go.kr');
  const consentRow = dumpConsent.consents.find(c => c.agency_email_hash === expectedHash);
  ok(!!consentRow, 'submit: consent_log에 기관 이메일의 SHA-256 해시가 기록됨');
  ok(dumpConsent.consents.every(c => !JSON.stringify(c).includes('officer@seoul.go.kr')), 'submit: consent_log 어디에도 평문 이메일 없음(해시만)');

  // REQUIRE_AGENCY_AUTH가 비활성(기본값)이면 여전히 토큰 없이 제출 가능(하위 호환)
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0007', total_amount: 100, member_count: 1, batch_hash: 'h-agency-off' }, blob: { ciphertext: badCipher } });
  ok(r.status === 200, 'submit: REQUIRE_AGENCY_AUTH=0(기본값)이면 토큰 없이도 여전히 통과');

  // ── 15c) 인증 도메인 전달(F-04, PROTOCOL §4.11) ──
  // 기관명(institution)은 담당자 자칭이라 서버가 검증할 수 없다. 검증 가능한 것은 '어느 도메인
  // 메일로 OTP 인증을 통과했는가'뿐이므로, 그 도메인을 요약에 실어 음식점 앱까지 전달해
  // 사장님이 눈으로 대조하게 한다. 로컬파트(사람 식별부)는 어디에도 저장되지 않는다.
  const agencyTokenFor = async (email) => {
    const q = await call(store, env, 'POST', '/api/agency/request-otp', { email });
    const qj = await q.json();
    const v = await call(store, env, 'POST', '/api/agency/verify-otp', { email, otp: qj.dev_otp });
    return (await v.json()).token;
  };
  const EMAIL_GU = 'somu-alpha@gwangjin.go.kr';   // 구청 담당자(정상 케이스)
  const EMAIL_AC = 'kyomu-beta@univ.ac.kr';       // 대학 메일(허용 도메인 — 구청 명의 사칭 시도 케이스)
  const EMAIL_MIX = 'Somu-Gamma@GwangJin.GO.KR';  // 대소문자 혼용(정규화 확인)
  const tokGu = await agencyTokenFor(EMAIL_GU);
  const tokAc = await agencyTokenFor(EMAIL_AC);
  const tokMix = await agencyTokenFor(EMAIL_MIX);
  const dumpTok = store._dump();
  const tokRowGu = dumpTok.agencyTokens.get(await sha256hex(tokGu));
  const tokRowAc = dumpTok.agencyTokens.get(await sha256hex(tokAc));
  const tokRowMix = dumpTok.agencyTokens.get(await sha256hex(tokMix));
  ok(!!tokRowGu && tokRowGu.email_domain === 'gwangjin.go.kr' && !!tokRowAc && tokRowAc.email_domain === 'univ.ac.kr',
    '도메인 전달: verify-otp 성공 시 agency_token에 인증 이메일의 도메인이 저장됨');
  ok(!!tokRowMix && tokRowMix.email_domain === 'gwangjin.go.kr',
    '도메인 전달: 대소문자 혼용 이메일도 도메인은 소문자로 정규화되어 저장');
  ok([tokRowGu, tokRowAc, tokRowMix].every(t => {
    const s = JSON.stringify(t);
    return !s.includes('@') && !s.includes('somu-alpha') && !s.includes('kyomu-beta')
      && !s.toLowerCase().includes('somu-gamma');
  }), '도메인 전달: 토큰 행에 로컬파트(사람 식별부)·평문 이메일이 전혀 저장되지 않음(도메인만)');

  // 제출→수신함 전 구간(실제 RSA 암호문)으로 도메인이 앱까지 전달되는지 확인.
  const RID_DOM = 'MGT-DOM1';
  const kpDom = await genKeyPair();
  const spkiDom = b64(await subtle.exportKey('spki', kpDom.publicKey));
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID_DOM, restaurant_name: '도메인식당', public_key: spkiDom });
  ok(r.status === 200, '도메인 전달: 테스트용 음식점 공개키 등록 200');
  const pubDom = await subtle.importKey('spki', unb64(spkiDom), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);

  const itemsDom = [{ name: '김서무', dept: '총무과', amount: 90000 }, { name: '이주사', dept: '총무과', amount: 60000 }];
  const bhDom = await batchHash(itemsDom);
  r = await callH(store, envRequireAgency, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 광진구', department: '총무과', restaurant_id: RID_DOM, restaurant_name: '도메인식당', year_month: '2026-08', total_amount: 150000, member_count: 2, batch_hash: bhDom },
    blob: { restaurant_id: RID_DOM, ciphertext: await encryptBlob(itemsDom, pubDom) }
  }, { 'X-Agency-Token': tokGu });
  const sjDom = await r.json();
  ok(r.status === 200 && !!sjDom.summary_id, '도메인 전달: 인증 토큰으로 제출 200');
  ok((store._dump().summaries.find(s => s.id === sjDom.summary_id) || {}).agency_domain === 'gwangjin.go.kr',
    '도메인 전달: deposit_summary.agency_domain에 토큰의 인증 도메인이 기록됨');

  // 다른 도메인 토큰으로 '같은 기관명'을 사칭해 제출 + body에 agency_domain 위조값까지 실어 보냄.
  // 서버는 body 값을 무시하고 토큰의 도메인만 기록해야 한다.
  const itemsDom2 = [{ name: '박대학', dept: '총무과', amount: 30000 }];
  const bhDom2 = await batchHash(itemsDom2);
  r = await callH(store, envRequireAgency, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 광진구', department: '총무과', agency_domain: 'gwangjin.go.kr', restaurant_id: RID_DOM, restaurant_name: '도메인식당', year_month: '2026-08', total_amount: 30000, member_count: 1, batch_hash: bhDom2 },
    blob: { restaurant_id: RID_DOM, ciphertext: await encryptBlob(itemsDom2, pubDom) }
  }, { 'X-Agency-Token': tokAc });
  const sjDom2 = await r.json();
  ok(r.status === 200 && (store._dump().summaries.find(s => s.id === sjDom2.summary_id) || {}).agency_domain === 'univ.ac.kr',
    '도메인 전달: 서로 다른 도메인 토큰의 제출이 각각 정확히 기록됨(body의 agency_domain 위조값은 무시)');

  // 하위호환: 마이그레이션 이전에 발급된 구버전 토큰(email_domain 없음)으로 제출해도 안전하게 통과하고
  // agency_domain은 null이어야 한다(앱이 "확인 불가"로 표시).
  const LEGACY_AGENCY_TOKEN = 'legacy-agency-token-without-domain';
  await store.createAgencyToken({
    token_hash: await sha256hex(LEGACY_AGENCY_TOKEN),
    email_hash: await sha256hex('old-officer@seoul.go.kr'),
    expires_at: Date.now() + 60 * 60 * 1000
  });
  const itemsDom3 = [{ name: '최구버전', dept: '총무과', amount: 10000 }];
  r = await callH(store, envRequireAgency, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 광진구', department: '총무과', restaurant_id: RID_DOM, restaurant_name: '도메인식당', year_month: '2026-08', total_amount: 10000, member_count: 1, batch_hash: await batchHash(itemsDom3) },
    blob: { restaurant_id: RID_DOM, ciphertext: await encryptBlob(itemsDom3, pubDom) }
  }, { 'X-Agency-Token': LEGACY_AGENCY_TOKEN });
  const sjDom3 = await r.json();
  ok(r.status === 200 && (store._dump().summaries.find(s => s.id === sjDom3.summary_id) || {}).agency_domain === null,
    '도메인 전달: 구버전 토큰(도메인 없음)으로 제출해도 200이며 agency_domain은 null(안전 처리)');
  ok((store._dump().summaries.find(s => s.batch_hash === 'h-agency-off') || {}).agency_domain === null,
    '도메인 전달: 토큰 없이(REQUIRE_AGENCY_AUTH=0) 제출된 건도 agency_domain은 null');

  // 수신함 응답에 도메인이 실려 음식점 앱까지 도달하는지 + null이 키째 사라지지 않는지 확인.
  r = await inboxOf(store, env, RID_DOM, kpDom.privateKey);
  const inboxDom = await r.json();
  const findDom = (id) => inboxDom.find(x => x.summary_id === id);
  ok(inboxDom.length === 3 && inboxDom.every(x => 'agency_domain' in x.summary),
    '도메인 전달: /api/inbox 응답 summary에 agency_domain 필드가 항상 존재(null이어도 키 유지)');
  ok((findDom(sjDom.summary_id) || {}).summary.agency_domain === 'gwangjin.go.kr'
    && (findDom(sjDom2.summary_id) || {}).summary.agency_domain === 'univ.ac.kr'
    && (findDom(sjDom3.summary_id) || {}).summary.agency_domain === null,
    '도메인 전달: 수신함이 각 건의 인증 도메인을 정확히 전달(구버전 건은 null)');
  ok(inboxDom.every(x => !('batch_hash' in x.summary)),
    '도메인 전달: summary 필드 추가 후에도 batch_hash는 여전히 응답에 없음(오라클 차단 유지)');
  // batch_hash canonical 불변(name|dept|amount): summary 필드 추가는 해시와 무관하다.
  const plainDom = await decryptBlob(findDom(sjDom.summary_id).ciphertext, kpDom.privateKey);
  ok(await batchHash(plainDom.items) === bhDom,
    '도메인 전달: 복호화 후 재계산한 batch_hash가 제출값과 일치(canonical "name|dept|amount" 불변)');

  // 회귀(불변식 3): 도메인 전달 도입 후에도 저장소 어디에도 평문 이메일·로컬파트가 없다.
  const dumpDom = store._dump();
  const domSerialized = JSON.stringify({
    tokens: [...dumpDom.agencyTokens.values()],
    otpKeys: [...dumpDom.agencyOtps.keys()], otps: [...dumpDom.agencyOtps.values()],
    summaries: dumpDom.summaries, consents: dumpDom.consents
  });
  ok(!domSerialized.includes('@') && !domSerialized.includes('somu-alpha') && !domSerialized.includes('kyomu-beta')
    && !domSerialized.toLowerCase().includes('somu-gamma') && !domSerialized.includes('old-officer'),
    '도메인 전달: agency_token·agency_otp·deposit_summary·consent_log 어디에도 평문 이메일·로컬파트 없음(도메인만)');

  // 16) 레이트 리밋 헤더 존재 시 429(베스트 에포트) — CF-Connecting-IP 없는 하니스 호출은 영향 없음 확인
  let limited = false;
  for (let i = 0; i < 65; i++) {
    const rr = await handle(new Request('http://x/api/registered?ids=rl-test', { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env, store);
    if (rr.status === 429) { limited = true; break; }
  }
  ok(limited, '레이트 리밋: CF-Connecting-IP 존재 시 분당 60회 초과하면 429');
  const rrNoHeader = await handle(new Request('http://x/api/registered?ids=rl-test2', { method: 'GET' }), env, store);
  ok(rrNoHeader.status === 200, '레이트 리밋: CF-Connecting-IP 헤더 없는 요청(하니스 등)은 영향 없음');

  // 16b) 연락처 크롤링 완화(감사 항목 3): /api/public-key는 더 낮은 한도(분당 20회)로 별도 제한.
  // 전역 한도(60)보다 훨씬 낮으므로 25회 이내에 429가 나와야 한다(같은 20회 카운터가 전역
  // 카운터와 별도임을 확인하기 위해 registered 엔드포인트에 쓰지 않은 새 IP를 사용).
  let pkLimited = false;
  for (let i = 0; i < 25; i++) {
    const rr = await handle(new Request('http://x/api/public-key?restaurant_id=RL-PK-TEST', { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.50' } }), env, store);
    if (rr.status === 429) { pkLimited = true; break; }
  }
  ok(pkLimited, 'public-key: 연락처 크롤링 완화 — 강화된 레이트리밋(분당 20회) 초과 시 429');
  // 같은 IP라도 다른 엔드포인트(registered)는 public-key 전용 카운터의 영향을 받지 않는다.
  const rrOtherEndpoint = await handle(new Request('http://x/api/registered?ids=rl-pk-other', { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.50' } }), env, store);
  ok(rrOtherEndpoint.status === 200, 'public-key: 강화된 레이트리밋은 public-key 엔드포인트 전용(다른 엔드포인트는 영향 없음)');

  // 17) 데이터 보존 최소화(PROTOCOL.md §6): 수령 즉시 파기 + 미수령 72시간 자동 파기.
  // 시각 주입은 전역 Date.now()를 몽키패치하지 않고, store에 저장된 created_at/processed_at을
  // 직접 되돌려 "시간이 흘렀다"를 시뮬레이션한다(cleanupTTL(now)가 이미 그렇듯 store는 순수
  // JS 객체이므로 이 방식이 자연스럽다).
  const RID7 = 'MGT-0008';
  const kp7 = await genKeyPair();
  const spki7 = b64(await subtle.exportKey('spki', kp7.publicKey));
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID7, restaurant_name: '보존테스트', public_key: spki7 });

  // 17-a) 승인 즉시 blob 파기
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { restaurant_id: RID7, restaurant_name: '보존테스트', total_amount: 1000, member_count: 1, batch_hash: 'h-retain-approve' },
    blob: { restaurant_id: RID7, ciphertext: badCipher }
  });
  const sjApprove = await r.json();
  ok(r.status === 200 && !!sjApprove.summary_id, '보존 테스트: 제출 200');
  ok(store._dump().blobs.some(b => b.summary_id === sjApprove.summary_id), '보존 테스트: 승인 전에는 encrypted_blob 존재');
  const tok7 = await getAuthToken(store, env, RID7, kp7.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: sjApprove.summary_id, status: 'APPROVED', restaurant_id: RID7, auth_token: tok7 });
  ok(r.status === 200, '보존 테스트: 승인 200');
  const dumpAfterApprove = store._dump();
  ok(!dumpAfterApprove.blobs.some(b => b.summary_id === sjApprove.summary_id), '보존 테스트: 승인 즉시 encrypted_blob 삭제(inbox 재조회로도 ciphertext 접근 불가)');
  r = await inboxOf(store, env, RID7, kp7.privateKey);
  ok(!(await r.json()).some(x => x.summary_id === sjApprove.summary_id), '보존 테스트: 승인 후 inbox 재조회에서도 해당 건 노출 안 됨(PENDING 아님)');
  const summaryAfterApprove = dumpAfterApprove.summaries.find(s => s.id === sjApprove.summary_id);
  ok(!!summaryAfterApprove && summaryAfterApprove.status === 'APPROVED' && summaryAfterApprove.total_amount === 1000, '보존 테스트: 비식별 요약(총액·인원·해시) 행은 즉시 삭제되지 않고 유지');

  // 17-b) 거절 시에도 즉시 파기(승인과 동일 경로)
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { restaurant_id: RID7, restaurant_name: '보존테스트', total_amount: 500, member_count: 1, batch_hash: 'h-retain-reject' },
    blob: { restaurant_id: RID7, ciphertext: badCipher }
  });
  const sjReject = await r.json();
  const tok7b = await getAuthToken(store, env, RID7, kp7.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: sjReject.summary_id, status: 'REJECTED', restaurant_id: RID7, auth_token: tok7b });
  ok(r.status === 200, '보존 테스트: 거절 200');
  ok(!store._dump().blobs.some(b => b.summary_id === sjReject.summary_id), '보존 테스트: 거절 시에도 즉시 encrypted_blob 삭제');

  // 17-c) 승인 처리 실패 시(이미 처리된 건 재시도) blob은 삭제되지 않아야 함 — 이미 삭제된 상태이므로
  // "새로 지워지는 부작용"이 없는지를 확인(상태 전이 성공과 같은 순서로만 삭제되는 안전성 회귀 방지).
  const tok7c = await getAuthToken(store, env, RID7, kp7.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: sjReject.summary_id, status: 'APPROVED', restaurant_id: RID7, auth_token: tok7c });
  ok(r.status === 409, '보존 테스트: 이미 처리된 건 재승인 시도는 409(전이 실패 시 삭제 로직도 실행 안 됨)');

  // 17-d) 미수령 72시간 경과 → inbox 조회 시점에도 즉시 제외(이중 방어 1단계, cron 이전)
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { restaurant_id: RID7, restaurant_name: '보존테스트', total_amount: 700, member_count: 2, batch_hash: 'h-retain-expire' },
    blob: { restaurant_id: RID7, ciphertext: badCipher }
  });
  const sjExpire = await r.json();
  r = await inboxOf(store, env, RID7, kp7.privateKey);
  ok((await r.json()).some(x => x.summary_id === sjExpire.summary_id), '보존 테스트: 만료 전(정상 PENDING)에는 inbox에 노출');
  const summaryToAge = store._dump().summaries.find(s => s.id === sjExpire.summary_id);
  summaryToAge.created_at = Date.now() - (72 * 60 * 60 * 1000 + 60 * 1000); // 72시간 + 1분 전 제출로 시뮬레이션
  r = await inboxOf(store, env, RID7, kp7.privateKey);
  ok(!(await r.json()).some(x => x.summary_id === sjExpire.summary_id), '보존 테스트: 미수령 72시간 경과 항목은 cron 실행 전에도 inbox 쿼리 조건으로 제외(이중 방어)');

  // 17-e) TTL cron: 72시간 경과 PENDING → EXPIRED 전이 + blob 즉시 삭제(이중 방어 2단계)
  const cleanup1 = await store.cleanupTTL(Date.now());
  ok(cleanup1.expiredSummaries >= 1, '보존 테스트: TTL cron이 미수령 만료 항목을 처리(expiredSummaries>=1)');
  const dumpAfterExpireCron = store._dump();
  const expiredSummary = dumpAfterExpireCron.summaries.find(s => s.id === sjExpire.summary_id);
  ok(!!expiredSummary && expiredSummary.status === 'EXPIRED', '보존 테스트: 미수령 72시간 경과 항목이 EXPIRED로 전이됨');
  ok(!dumpAfterExpireCron.blobs.some(b => b.summary_id === sjExpire.summary_id), '보존 테스트: EXPIRED 전이 시 encrypted_blob 즉시 삭제');

  // EXPIRED 상태는 더 이상 승인/거절 대상이 아님(PENDING 전이 가드에 걸림)
  const tok7d = await getAuthToken(store, env, RID7, kp7.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: sjExpire.summary_id, status: 'APPROVED', restaurant_id: RID7, auth_token: tok7d });
  ok(r.status === 409, '보존 테스트: EXPIRED 상태는 승인/거절 시도 시 409(상태 전이 가드)');

  // 17-f) 비식별 요약(총액·인원·해시)도 처리 후 30일 지나면 TTL cron이 삭제(APPROVED/REJECTED/EXPIRED 공통)
  expiredSummary.processed_at = Date.now() - (30 * 24 * 60 * 60 * 1000 + 60 * 1000);
  const cleanup2 = await store.cleanupTTL(Date.now());
  ok(cleanup2.deletedSummaries >= 1, '보존 테스트: 30일 지난 EXPIRED 비식별 요약도 TTL cron에서 삭제 대상에 포함');
  ok(!store._dump().summaries.some(s => s.id === sjExpire.summary_id), '보존 테스트: 30일 경과 후 EXPIRED summary 행 자체도 제거됨(30일 보관 정책 그대로 적용)');

  // 18) 업무용 연락처(§4.5): 카톡 오픈채팅 링크·공식 접수 이메일(둘 다 선택, 소유 증명 필요)
  const RID9 = 'MGT-0009';
  const kp9 = await genKeyPair();
  const spki9 = b64(await subtle.exportKey('spki', kp9.publicKey));
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID9, restaurant_name: '연락처테스트', public_key: spki9 });
  ok(r.status === 200, 'contact: 사전 공개키 등록 200');

  r = await call(store, env, 'POST', '/api/contact', { restaurant_id: RID9, kakao_link: 'https://open.kakao.com/o/abc123' });
  ok(r.status === 401, 'contact: auth_token 없이 401(auth_required)');

  const tok9 = await getAuthToken(store, env, RID9, kp9.privateKey);
  r = await call(store, env, 'POST', '/api/contact', { restaurant_id: RID9, auth_token: tok9, kakao_link: 'https://notkakao.example/o/abc' });
  ok(r.status === 400, 'contact: open.kakao.com 아닌 카톡 링크 400(invalid_kakao_link)');

  const tok9b = await getAuthToken(store, env, RID9, kp9.privateKey);
  r = await call(store, env, 'POST', '/api/contact', { restaurant_id: RID9, auth_token: tok9b, email: 'not-an-email' });
  ok(r.status === 400, 'contact: 형식 어긋난 이메일 400(invalid_email)');

  const tok9c = await getAuthToken(store, env, RID9, kp9.privateKey);
  r = await call(store, env, 'POST', '/api/contact', { restaurant_id: RID9, auth_token: tok9c, kakao_link: 'https://open.kakao.com/o/abc123', email: 'owner@restaurant.example' });
  ok(r.status === 200, 'contact: 정상 등록(카톡+이메일) 200');

  r = await call(store, env, 'GET', '/api/public-key?restaurant_id=' + RID9);
  const pk9 = await r.json();
  ok(pk9.contact && pk9.contact.kakao_link === 'https://open.kakao.com/o/abc123' && pk9.contact.email === 'owner@restaurant.example', 'contact: public-key 응답에 등록된 연락처 노출');

  // 미등록 음식점 연락처 등록은 auth_token 자체가 발급될 수 없어 401로 먼저 걸러짐(§4.1 전제).
  r = await call(store, env, 'GET', '/api/public-key?restaurant_id=MGT-NOPE-CONTACT');
  const pk9x = await r.json();
  ok(r.status === 404 && !('contact' in pk9x), 'contact: 미등록 restaurant_id의 public-key 조회는 여전히 404(연락처 필드 없음)');

  const tok9d = await getAuthToken(store, env, RID9, kp9.privateKey);
  r = await call(store, env, 'POST', '/api/contact', { restaurant_id: RID9, auth_token: tok9d, kakao_link: '', email: '' });
  ok(r.status === 200, 'contact: 빈 문자열로 삭제 요청 200');
  r = await call(store, env, 'GET', '/api/public-key?restaurant_id=' + RID9);
  const pk9b = await r.json();
  ok(pk9b.contact.kakao_link === null && pk9b.contact.email === null, 'contact: 빈 문자열 제출 후 연락처가 null로 삭제됨');

  // deregister 시 연락처도 함께 소멸(같은 행이므로 행 삭제로 자동 삭제) — 재등록 후 연락처가 비어있는지로 확인.
  const tok9e = await getAuthToken(store, env, RID9, kp9.privateKey);
  r = await call(store, env, 'POST', '/api/contact', { restaurant_id: RID9, auth_token: tok9e, kakao_link: 'https://open.kakao.com/o/xyz789' });
  ok(r.status === 200, 'contact: deregister 전 연락처 재등록 200');
  const tok9f = await getAuthToken(store, env, RID9, kp9.privateKey);
  r = await call(store, env, 'POST', '/api/deregister', { restaurant_id: RID9, auth_token: tok9f });
  ok(r.status === 200, 'contact: deregister 200');
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RID9, restaurant_name: '연락처테스트', public_key: spki9 });
  ok(r.status === 200, 'contact: deregister 후 재등록(신규 취급) 200');
  r = await call(store, env, 'GET', '/api/public-key?restaurant_id=' + RID9);
  const pk9c = await r.json();
  ok(pk9c.contact.kakao_link === null && pk9c.contact.email === null, 'contact: deregister로 이전 연락처가 소멸(재등록 후 null)');

  // 19) 비식별 집계 통계 + 관리자 통계 API + 피드백 수신
  // 현재 연월(UTC) — 서버의 stats_counter 월별 발송 키 및 admin this_month와 동일 규칙.
  const nowD = new Date();
  const curYM = nowD.getUTCFullYear() + '-' + String(nowD.getUTCMonth() + 1).padStart(2, '0');
  const envAdmin = { ...env, ADMIN_TOKEN: 'super-secret-admin-token' };

  // 19-a) 관리자 API 미설정 → 503
  r = await callH(store, env, 'GET', '/api/admin/stats', undefined, {});
  ok(r.status === 503 && (await r.json()).error === 'admin_not_configured', 'admin/stats: ADMIN_TOKEN 미설정 시 503(admin_not_configured)');

  // 19-b) 무토큰·오토큰 → 401
  r = await callH(store, envAdmin, 'GET', '/api/admin/stats', undefined, {});
  ok(r.status === 401 && (await r.json()).error === 'unauthorized', 'admin/stats: 토큰 없이 401(unauthorized)');
  r = await callH(store, envAdmin, 'GET', '/api/admin/stats', undefined, { 'X-Admin-Token': 'wrong-token' });
  ok(r.status === 401, 'admin/stats: 오토큰 401(상수시간 비교)');

  // 19-c) submit 성공 시 비식별 집계 증가(seen_institution·sends·members/amount)
  const RIDstat = 'MGT-STATS-1';
  const kpStat = await genKeyPair();
  const spkiStat = b64(await subtle.exportKey('spki', kpStat.publicKey));
  const dumpS0 = store._dump();
  const registrationsBefore = dumpS0.counters.get('registrations') || 0;
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDstat, restaurant_name: '집계테스트', public_key: spkiStat });
  const dumpS1 = store._dump();
  ok(dumpS1.seenRestaurants.has(RIDstat), '집계: register-key 신규 등록 시 seen_restaurant에 공개ID 기록');
  ok((dumpS1.counters.get('registrations') || 0) === registrationsBefore + 1, '집계: 신규 등록 시 registrations 카운터 +1');

  const sendsBefore = dumpS1.counters.get('sends') || 0;
  const monthBefore = dumpS1.counters.get('sends_' + curYM) || 0;
  const membersBefore = dumpS1.counters.get('members_total') || 0;
  const amountBefore = dumpS1.counters.get('amount_total') || 0;
  const pubStat = await subtle.importKey('spki', unb64(spkiStat), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const blobStat = await encryptBlob([{ name: 'A', dept: '집계부서', amount: 1000 }], pubStat);
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { institution: '집계기관', department: '집계부서', restaurant_id: RIDstat, restaurant_name: '집계테스트', year_month: curYM, total_amount: 1000, member_count: 5, batch_hash: 'h-stats-1' },
    blob: { restaurant_id: RIDstat, ciphertext: blobStat }
  });
  ok(r.status === 200, '집계: 제출 200');
  const dumpS2 = store._dump();
  ok((dumpS2.counters.get('sends') || 0) === sendsBefore + 1, '집계: 제출 성공 시 sends 카운터 +1');
  ok((dumpS2.counters.get('sends_' + curYM) || 0) === monthBefore + 1, '집계: 제출 성공 시 sends_현재월 카운터 +1');
  ok(dumpS2.seenInstitutions.has('집계기관'), '집계: seen_institution에 기관명(비개인 조직정보) 기록');
  ok((dumpS2.counters.get('members_total') || 0) === membersBefore + 5, '집계: members_total += member_count(집계값만)');
  ok((dumpS2.counters.get('amount_total') || 0) === amountBefore + 1000, '집계: amount_total += total_amount(집계값만)');
  // 불변식: 집계 어디에도 직원명·개인별 금액이 없다(조직정보·집계 카운터만).
  ok(dumpS2.seenInstitutions.size >= 1 && ![...dumpS2.seenInstitutions].some(v => v === 'A'),
    '집계: seen_institution에 직원명이 섞이지 않음(기관명만)');

  // 19-d) 관리자 API 정상 200 + 구조·집계 반영
  r = await callH(store, envAdmin, 'GET', '/api/admin/stats', undefined, { 'X-Admin-Token': 'super-secret-admin-token' });
  const st = await r.json();
  ok(r.status === 200 && st.restaurants && typeof st.restaurants.current === 'number' && typeof st.restaurants.total === 'number'
    && typeof st.institutions_total === 'number' && typeof st.departments_total === 'number'
    && st.sends && typeof st.sends.total === 'number' && typeof st.sends.this_month === 'number'
    && typeof st.pending === 'number' && typeof st.members_total === 'number' && typeof st.amount_total === 'number'
    && Array.isArray(st.feedback), 'admin/stats: 정상 토큰 200 + 계약 구조 일치');
  ok(st.restaurants.total >= 1 && st.institutions_total >= 1 && st.sends.total >= 1 && st.sends.this_month >= 1,
    'admin/stats: seen_restaurant·seen_institution·sends(총·이번달) 집계 반영');
  // 개인정보 필드 부재 확인: 응답 어디에도 직원명·개인금액·이메일 평문이 없다.
  const stStr = JSON.stringify(st);
  ok(!stStr.includes('"name"') && !/officer@|@seoul\.go\.kr/.test(stStr), 'admin/stats: 응답에 개인 식별 필드(직원명·기관이메일) 없음');

  // 19-e) 피드백 저장 → admin stats에 노출(최신순)
  r = await call(store, env, 'POST', '/api/feedback', { role: '음식점', message: '수수료가 없어서 좋아요', contact: 'https://open.kakao.com/o/fb1' });
  ok(r.status === 200 && (await r.json()).ok === true, 'feedback: 정상 저장 200(ok:true)');
  r = await call(store, env, 'POST', '/api/feedback', { role: '기관', message: '엑셀 업로드가 편합니다' });
  ok(r.status === 200, 'feedback: contact 없이도 저장 200');
  // 두 피드백이 동일 ms에 저장될 수 있으므로 '수수료가…' 저장 시각을 명시적으로 과거로 되돌려
  // 최신순 정렬(더 최근인 '엑셀…'이 앞)을 결정적으로 검증한다(다른 테스트의 시각 주입과 동일 기법).
  store._dump().feedbacks.forEach(f => { if (f.message === '수수료가 없어서 좋아요') f.created_at -= 60 * 1000; });
  r = await callH(store, envAdmin, 'GET', '/api/admin/stats', undefined, { 'X-Admin-Token': 'super-secret-admin-token' });
  const st2 = await r.json();
  ok(st2.feedback.some(f => f.message === '수수료가 없어서 좋아요' && f.role === '음식점'), 'feedback: admin stats feedback 배열에 최근 피드백 노출');
  const idxNew = st2.feedback.findIndex(f => f.message === '엑셀 업로드가 편합니다');
  const idxOld = st2.feedback.findIndex(f => f.message === '수수료가 없어서 좋아요');
  ok(idxNew !== -1 && idxOld !== -1 && idxNew < idxOld, 'feedback: admin stats feedback는 최신순 정렬(더 최근 항목이 앞)');

  // 19-f) 피드백 검증: role 화이트리스트·message/contact 길이
  r = await call(store, env, 'POST', '/api/feedback', { role: '해커', message: 'x' });
  ok(r.status === 400 && (await r.json()).error === 'invalid_role', 'feedback: 화이트리스트 밖 role 400(invalid_role)');
  r = await call(store, env, 'POST', '/api/feedback', { role: '기관', message: '' });
  ok(r.status === 400, 'feedback: 빈 message 400');
  r = await call(store, env, 'POST', '/api/feedback', { role: '기관', message: 'a'.repeat(2001) });
  ok(r.status === 400, 'feedback: message 2000자 초과 400');
  r = await call(store, env, 'POST', '/api/feedback', { role: '기타', message: '정상', contact: 'a'.repeat(201) });
  ok(r.status === 400, 'feedback: contact 200자 초과 400');
  r = await call(store, env, 'POST', '/api/feedback', { role: '기타', message: '정상', contact: 'a'.repeat(200) });
  ok(r.status === 200, 'feedback: 경계값(message 1자·contact 200자) 정상 저장 200');

  // 20) 관할 지역(district) 등록 + 지역별 조회(registered-list) — §4.6
  // 공개 사업장 정보(관할지역)는 §0 zero-knowledge 불변식과 무관(공개값 — 평문 저장 허용).
  const mkKey = async () => { const kp = await genKeyPair(); return { kp, spki: b64(await subtle.exportKey('spki', kp.publicKey)) }; };
  const kA = await mkKey(), kB = await mkKey(), kC = await mkKey(), kD = await mkKey(), kE = await mkKey(), kL = await mkKey();

  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-A', restaurant_name: '다라식당', public_key: kA.spki, district: '서울특별시 광진구' });
  ok(r.status === 200, 'registered-list: district 포함 등록 200');
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-B', restaurant_name: '가나분식', public_key: kB.spki, district: '서울특별시 광진구' });
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-C', restaurant_name: '나다김밥', public_key: kC.spki, district: '서울특별시 광진구' });
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-D', restaurant_name: '성동식당', public_key: kD.spki, district: '서울특별시 성동구' });
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-E', restaurant_name: '분당한정식', public_key: kE.spki, district: '경기도 성남시' });
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-L', restaurant_name: '레거시광진', public_key: kL.spki }); // district 없음(레거시)

  // 연락처를 등록해도 registered-list 응답에는 노출되지 않아야 함(공개 정보만) — 강한 검증용.
  const tokB = await getAuthToken(store, env, 'D-B', kB.kp.privateKey);
  await call(store, env, 'POST', '/api/contact', { restaurant_id: 'D-B', auth_token: tokB, kakao_link: 'https://open.kakao.com/o/dbcontact', email: 'db@example.example' });

  // 20-a) sido+sigungu 조회 → 광진구 3곳만, 이름 가나다 정렬, 레거시 제외, 연락처 미포함
  r = await call(store, env, 'GET', '/api/registered-list?sido=' + encodeURIComponent('서울특별시') + '&sigungu=' + encodeURIComponent('광진구'));
  const rl = await r.json();
  ok(r.status === 200 && Array.isArray(rl.restaurants), 'registered-list: 200 + restaurants 배열');
  ok(rl.restaurants.length === 3, 'registered-list: sido+sigungu 매칭 3곳만(레거시 미포함)');
  ok(rl.restaurants.map(x => x.restaurant_name).join(',') === '가나분식,나다김밥,다라식당', 'registered-list: 이름 가나다 정렬');
  ok(rl.restaurants.every(x => x.district === '서울특별시 광진구'), 'registered-list: 반환 district가 조회 지역과 일치');
  ok(!rl.restaurants.some(x => x.restaurant_id === 'D-L'), 'registered-list: district 없는 레거시 등록분은 미노출');
  ok(rl.restaurants.every(x => Object.keys(x).sort().join(',') === 'district,registered_at,restaurant_id,restaurant_name,verified'),
    'registered-list: 각 항목은 id·이름·district·registered_at·verified만(연락처 등 미포함 — 연락처 등록된 D-B도 노출 안 됨)');
  ok(rl.restaurants.every(x => typeof x.registered_at === 'number' && x.registered_at > 0),
    'registered-list: registered_at(등록 시각) 포함 — 담당자 웹 "신규 등록" 배지용');
  ok(rl.restaurants.every(x => x.verified === 1),
    'registered-list: 공공데이터 대조에 성공한 등록분은 verified=1');

  // 20-b) sigungu 없이 sido 전체 → 서울 4곳(광진3+성동1), 다른 시도(경기)·레거시 제외
  r = await call(store, env, 'GET', '/api/registered-list?sido=' + encodeURIComponent('서울특별시'));
  const rlSido = await r.json();
  ok(rlSido.restaurants.length === 4, 'registered-list: sigungu 없이 sido 전체 조회(서울 광진3+성동1=4)');
  ok(rlSido.restaurants.some(x => x.restaurant_id === 'D-D') && !rlSido.restaurants.some(x => x.restaurant_id === 'D-E'),
    'registered-list: 시도 전체는 다른 시군구 포함하되 다른 시도(경기)는 제외');

  // 20-c) sido 누락 400
  r = await call(store, env, 'GET', '/api/registered-list?sigungu=' + encodeURIComponent('광진구'));
  ok(r.status === 400 && (await r.json()).error === 'sido_required', 'registered-list: sido 누락 400(sido_required)');

  // 20-d) 같은 키 멱등 재등록으로 district 갱신(레거시 채우기)
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-L', restaurant_name: '레거시광진', public_key: kL.spki, district: '서울특별시 광진구' });
  ok(r.status === 200, 'registered-list: 레거시 동일 키 재등록(district 포함) 200(멱등)');
  r = await call(store, env, 'GET', '/api/registered-list?sido=' + encodeURIComponent('서울특별시') + '&sigungu=' + encodeURIComponent('광진구'));
  ok((await r.json()).restaurants.some(x => x.restaurant_id === 'D-L' && x.district === '서울특별시 광진구'),
    'registered-list: 동일 키 멱등 재등록으로 district가 채워져 목록에 노출됨');

  // 20-e) 소유증명(다른 키) 재등록 경로에서도 district 갱신(광진→성동 이동)
  const kA2 = await mkKey();
  const tokA = await getAuthToken(store, env, 'D-A', kA.kp.privateKey);
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-A', restaurant_name: '다라식당', public_key: kA2.spki, auth_token: tokA, district: '서울특별시 성동구' });
  ok(r.status === 200, 'registered-list: 소유증명 후 다른 키 재등록(district 변경) 200');
  r = await call(store, env, 'GET', '/api/registered-list?sido=' + encodeURIComponent('서울특별시') + '&sigungu=' + encodeURIComponent('성동구'));
  ok((await r.json()).restaurants.some(x => x.restaurant_id === 'D-A' && x.district === '서울특별시 성동구'),
    'registered-list: 소유증명 재등록 경로에서도 district 갱신(성동구 목록에 노출)');
  r = await call(store, env, 'GET', '/api/registered-list?sido=' + encodeURIComponent('서울특별시') + '&sigungu=' + encodeURIComponent('광진구'));
  ok(!(await r.json()).restaurants.some(x => x.restaurant_id === 'D-A'), 'registered-list: district 갱신 후 이전 시군구(광진구)에서는 제외');

  // 20-f) district 길이 상한(100자) 초과 400
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'D-LEN', restaurant_name: 'x', public_key: kD.spki, district: '서'.repeat(101) });
  ok(r.status === 400, 'registered-list: district 길이 상한(100자) 초과 400');

  // 20-g) 레이트리밋: registered-list는 public-key와 동일한 강화 한도(분당 20)로 별도(독립 카운터) 제한
  let rlLimited = false;
  for (let i = 0; i < 25; i++) {
    const rr = await handle(new Request('http://x/api/registered-list?sido=' + encodeURIComponent('서울특별시'), { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.77' } }), env, store);
    if (rr.status === 429) { rlLimited = true; break; }
  }
  ok(rlLimited, 'registered-list: 강화된 레이트리밋(분당 20회) 초과 시 429');
  const rlOther = await handle(new Request('http://x/api/registered?ids=rl-list-other', { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.77' } }), env, store);
  ok(rlOther.status === 200, 'registered-list: 강화된 레이트리밋은 registered-list 전용(다른 엔드포인트 영향 없음)');

  // 20-h) 회귀(중대): 시군구명이 다른 시군구명의 '부분문자열'인 실제 충돌 3쌍에서 남의 관할이 섞이면 안 됨.
  // 과거 구현(district LIKE '%{시군구}%')은 아래 3쌍에서 상대 구의 음식점을 함께 반환했고, 담당자가
  // '다른 구의 음식점'에 직원 명단을 보낼 수 있는 경로였다 → 정규화 후 정확 일치로 고정(§4.6).
  const kJ = await mkKey(); // 관할 매칭 검증용(등록 id만 다르면 되므로 키는 공유)
  const jur = [
    ['J-BS-SEO', '부산서구식당', '부산광역시 서구'], ['J-BS-GANGSEO', '부산강서구식당', '부산광역시 강서구'],
    ['J-DG-SEO', '대구서구식당', '대구광역시 서구'], ['J-DG-DALSEO', '대구달서구식당', '대구광역시 달서구'],
    ['J-GG-YJ', '양주시식당', '경기도 양주시'], ['J-GG-NYJ', '남양주시식당', '경기도 남양주시'],
  ];
  for (const [id, name, district] of jur)
    await call(store, env, 'POST', '/api/register-key', { restaurant_id: id, restaurant_name: name, public_key: kJ.spki, district });

  const listDistrict = async (sido, sigungu) => {
    const qs = '/api/registered-list?sido=' + encodeURIComponent(sido) + (sigungu !== undefined ? '&sigungu=' + encodeURIComponent(sigungu) : '');
    const rr = await call(store, env, 'GET', qs);
    return { status: rr.status, ids: ((await rr.json()).restaurants || []).map(x => x.restaurant_id) };
  };
  const pairs = [
    ['부산광역시', '서구', 'J-BS-SEO', '강서구', 'J-BS-GANGSEO'],
    ['대구광역시', '서구', 'J-DG-SEO', '달서구', 'J-DG-DALSEO'],
    ['경기도', '양주시', 'J-GG-YJ', '남양주시', 'J-GG-NYJ'],
  ];
  for (const [sido, shortName, shortId, longName, longId] of pairs) {
    const a = await listDistrict(sido, shortName);
    ok(a.ids.length === 1 && a.ids[0] === shortId,
      `registered-list: ${sido} ${shortName} 조회에 ${longName}(${longId}) 미포함 — 자기 관할 1곳만`);
    const bq = await listDistrict(sido, longName);
    ok(bq.ids.length === 1 && bq.ids[0] === longId,
      `registered-list: ${sido} ${longName} 조회에 ${shortName}(${shortId}) 미포함 — 자기 관할 1곳만`);
  }
  // 시도 전체 조회에서는 두 구가 모두(그리고 둘만) 나온다 — 정확 일치가 '누락'을 만들지 않음을 확인.
  const bsAll = await listDistrict('부산광역시');
  ok(bsAll.ids.length === 2 && bsAll.ids.includes('J-BS-SEO') && bsAll.ids.includes('J-BS-GANGSEO'),
    'registered-list: 시도 전체 조회는 서구·강서구 둘 다 반환(정확 일치가 누락을 만들지 않음)');
  // 다른 시도의 같은 이름 시군구(대구 서구)는 부산 서구 조회에 섞이지 않는다(시도 경계).
  const bsSeo = await listDistrict('부산광역시', '서구');
  ok(!bsSeo.ids.includes('J-DG-SEO'), 'registered-list: 동명 시군구(서구)라도 다른 시도(대구)는 제외');

  // 20-i) 공백 변형 관용: 저장 시 정규화(연속 공백·앞뒤 공백) + 조회 파라미터 정규화 + 레거시 행 관용.
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'J-WS', restaurant_name: '공백변형식당', public_key: kJ.spki, district: '  부산광역시   서구  ' });
  ok(r.status === 200, 'registered-list: 공백 변형 district 등록 200');
  let ws = await listDistrict('부산광역시', '서구');
  ok(ws.ids.includes('J-WS'), 'registered-list: 등록 시 공백 변형(앞뒤·연속)은 정규화되어 정확 일치로 조회됨');
  ok(store._dump().keys.get('J-WS').district === '부산광역시 서구', 'registered-list: 저장값 자체가 "{시도} {시군구}" 정규형으로 보관됨');
  ws = await listDistrict(' 부산광역시 ', ' 서구 ');
  ok(ws.ids.includes('J-WS') && ws.ids.includes('J-BS-SEO') && !ws.ids.includes('J-BS-GANGSEO'),
    'registered-list: 조회 파라미터의 앞뒤 공백도 정규화(관용) — 단 강서구는 여전히 제외');
  // 레거시/외부 유입으로 정규형이 아닌 값이 이미 저장돼 있어도 조회에서 관용(D1은 SQL TRIM/REPLACE로 동등 처리).
  await store.setDistrict('J-WS', '부산광역시  서구');
  ws = await listDistrict('부산광역시', '서구');
  ok(ws.ids.includes('J-WS'), 'registered-list: 정규형이 아닌 레거시 저장값(연속 공백)도 조회 시 관용');
  await store.setDistrict('J-WS', '부산광역시 강서구'); // 정리: 이후 카운트 테스트에 영향 없도록 다른 구로 이동
  ws = await listDistrict('부산광역시', '서구');
  ok(!ws.ids.includes('J-WS'), 'registered-list: district 변경 후 이전 시군구 목록에서 제외(정확 일치)');

  // 20-j) 경계 고정: 시도명의 부분문자열·와일드카드로는 조회되지 않는다(LIKE 이스케이프 포함).
  const partial = await listDistrict('부산');
  ok(partial.status === 200 && partial.ids.length === 0, 'registered-list: 시도명 부분문자열("부산")은 매칭되지 않음(경계 고정)');
  const wild = await listDistrict('%');
  ok(wild.status === 200 && wild.ids.length === 0, 'registered-list: sido 와일드카드(%)는 리터럴로 처리 — 전체 목록 유출 없음');
  const wild2 = await listDistrict('부산광역시', '%');
  ok(wild2.status === 200 && wild2.ids.length === 0, 'registered-list: sigungu 와일드카드(%)도 리터럴 — 시도 전체 유출 없음');
  // district가 NULL(레거시)인 행은 어떤 조회에도 나오지 않는다(3쌍 회귀 데이터와 무관하게 재확인).
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: 'J-NULL', restaurant_name: '무관할식당', public_key: kJ.spki });
  const nullAll = await listDistrict('부산광역시');
  ok(!nullAll.ids.includes('J-NULL'), 'registered-list: district NULL 행은 시도 전체 조회에서도 제외');

  // 21) 알림 배지·경량 폴링용 개수 조회(/api/inbox-count) — 응답은 {count} 뿐, inbox와 동일 필터
  const RIDC = 'MGT-CNT1';
  const kCnt = await mkKey();
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDC, restaurant_name: '카운트식당', public_key: kCnt.spki });
  ok(r.status === 200, 'inbox-count: 테스트용 음식점 공개키 등록 200');

  // 21-a) 신청 0건 → count 0 (미등록 id도 동일하게 0 — 등록 여부를 새로 노출하지 않음)
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDC);
  const cnt0 = await r.json();
  ok(r.status === 200 && cnt0.count === 0, 'inbox-count: 신청 0건이면 count 0');
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=MGT-NO-SUCH');
  ok(r.status === 200 && (await r.json()).count === 0, 'inbox-count: 미등록 음식점도 count 0(등록 여부 미노출)');

  // 21-b) 제출 후 → count 1, 응답에는 개수 외 아무 필드도 없음(요약 메타·암호문 미노출)
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDC, restaurant_name: '카운트식당', year_month: '2026-07', total_amount: 100000, member_count: 1, batch_hash: 'h-count-1' },
    blob: { restaurant_id: RIDC, ciphertext: badCipher }
  });
  const sjCnt = await r.json();
  ok(r.status === 200 && sjCnt.summary_id, 'inbox-count: 사전 제출 200');
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDC);
  const cnt1 = await r.json();
  ok(r.status === 200 && cnt1.count === 1, 'inbox-count: 제출 1건 후 count 1');
  ok(Object.keys(cnt1).join(',') === 'count', 'inbox-count: 응답은 count만(기관·부서·총액·암호문 등 미노출)');
  r = await inboxOf(store, env, RIDC, kCnt.kp.privateKey);
  ok((await r.json()).length === cnt1.count, 'inbox-count: inbox 항목 수와 count 일치(동일 필터)');

  // 21-c) 승인(수령) 후 → count 0 (PENDING 아님)
  const tokCnt = await getAuthToken(store, env, RIDC, kCnt.kp.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: sjCnt.summary_id, status: 'APPROVED', restaurant_id: RIDC, auth_token: tokCnt });
  ok(r.status === 200, 'inbox-count: 승인 200');
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDC);
  ok((await r.json()).count === 0, 'inbox-count: 승인 후 count 0');

  // 21-d) restaurant_id 누락 → 400 (기존 /api/inbox와 동일 메시지)
  r = await call(store, env, 'GET', '/api/inbox-count');
  ok(r.status === 400 && (await r.json()).error === 'restaurant_id 필요', 'inbox-count: restaurant_id 누락 400');
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=');
  ok(r.status === 400, 'inbox-count: 빈 restaurant_id도 400');

  // 21-e) 72시간 경과 미수령 건은 세지 않음(inbox와 동일한 이중 방어 1단계)
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { restaurant_id: RIDC, restaurant_name: '카운트식당', total_amount: 700, member_count: 2, batch_hash: 'h-count-expire' },
    blob: { restaurant_id: RIDC, ciphertext: badCipher }
  });
  const sjCntExp = await r.json();
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDC);
  ok((await r.json()).count === 1, 'inbox-count: 만료 전 신규 제출은 count 1');
  const cntToAge = store._dump().summaries.find(s => s.id === sjCntExp.summary_id);
  cntToAge.created_at = Date.now() - (72 * 60 * 60 * 1000 + 60 * 1000); // 72시간 + 1분 전 제출로 시뮬레이션
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDC);
  ok((await r.json()).count === 0, 'inbox-count: 72시간 경과 미수령 건은 cron 이전에도 카운트 제외');

  // 22) 재제출 멱등 응답의 상태 명시(재전송 블랙홀 수정): 동일 (restaurant_id,batch_hash) 재제출은
  // 새 행을 만들 수 없으므로(UNIQUE), 응답의 deduped·status로 "이미 어떻게 처리됐는지"를 알려준다.
  const RIDD = 'MGT-DEDUP';
  const kDup = await mkKey();
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDD, restaurant_name: '재전송식당', public_key: kDup.spki });
  ok(r.status === 200, 'dedup: 테스트용 공개키 등록 200');
  const submitDup = (batch_hash) => call(store, env, 'POST', '/api/submit', {
    summary: { restaurant_id: RIDD, restaurant_name: '재전송식당', total_amount: 1000, member_count: 1, batch_hash },
    blob: { restaurant_id: RIDD, ciphertext: badCipher }
  });

  // 22-a) 신규 제출 응답은 기존 계약 그대로(summary_id만 — deduped/status 없음)
  r = await submitDup('h-dedup-pending');
  const dupNew = await r.json();
  ok(r.status === 200 && !!dupNew.summary_id && !('deduped' in dupNew) && !('status' in dupNew),
    'dedup: 신규 제출 응답은 기존 그대로 {summary_id}만(deduped·status 없음)');

  // 22-b) PENDING 상태에서 재제출 → deduped:true, status:'PENDING'
  r = await submitDup('h-dedup-pending');
  const dupPending = await r.json();
  ok(r.status === 200 && dupPending.summary_id === dupNew.summary_id && dupPending.deduped === true && dupPending.status === 'PENDING',
    'dedup: PENDING 재제출 → {deduped:true, status:"PENDING"}');

  // 22-c) 승인 후 재제출 → deduped:true, status:'APPROVED'
  r = await submitDup('h-dedup-approved');
  const dupAppSubmit = await r.json();
  const tokDupA = await getAuthToken(store, env, RIDD, kDup.kp.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: dupAppSubmit.summary_id, status: 'APPROVED', restaurant_id: RIDD, auth_token: tokDupA });
  ok(r.status === 200, 'dedup: 승인 200');
  r = await submitDup('h-dedup-approved');
  const dupApproved = await r.json();
  ok(r.status === 200 && dupApproved.summary_id === dupAppSubmit.summary_id && dupApproved.deduped === true && dupApproved.status === 'APPROVED',
    'dedup: 승인 후 재제출 → {deduped:true, status:"APPROVED"}(같은 명단이 다시 안 뜨는 이유를 응답으로 알림)');

  // 22-d) 거절 후 재제출 → deduped:true, status:'REJECTED'
  r = await submitDup('h-dedup-rejected');
  const dupRejSubmit = await r.json();
  const tokDupR = await getAuthToken(store, env, RIDD, kDup.kp.privateKey);
  r = await call(store, env, 'POST', '/api/approve', { summary_id: dupRejSubmit.summary_id, status: 'REJECTED', restaurant_id: RIDD, auth_token: tokDupR });
  ok(r.status === 200, 'dedup: 거절 200');
  r = await submitDup('h-dedup-rejected');
  const dupRejected = await r.json();
  ok(r.status === 200 && dupRejected.summary_id === dupRejSubmit.summary_id && dupRejected.deduped === true && dupRejected.status === 'REJECTED',
    'dedup: 거절 후 재제출 → {deduped:true, status:"REJECTED"}');
  ok(store._dump().summaries.filter(s => s.restaurant_id === RIDD).length === 3,
    'dedup: 3종 재제출로도 새 summary 행이 생기지 않음(총 3건 유지)');

  // 23) blob 없는 고아 summary는 inbox·inbox-count 양쪽에서 동일하게 제외(D1 JOIN 시맨틱 통일)
  const RIDO = 'MGT-ORPHAN';
  const kOrp = await mkKey();
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDO, restaurant_name: '고아테스트', public_key: kOrp.spki });
  r = await submitDup('h-orphan-keep'); // 다른 음식점(RIDD) 건 — RIDO 계산에 영향 없음 확인용
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { restaurant_id: RIDO, restaurant_name: '고아테스트', total_amount: 300, member_count: 1, batch_hash: 'h-orphan' },
    blob: { restaurant_id: RIDO, ciphertext: badCipher }
  });
  const sjOrphan = await r.json();
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDO);
  ok((await r.json()).count === 1, 'orphan: blob 있는 PENDING은 count 1');
  // blob만 사라진 상태(고아 summary)를 저장소에서 직접 만든다 — 부분 정리·수령 실패의 잔재 시뮬레이션.
  const dumpOrphan = store._dump();
  const oi = dumpOrphan.blobs.findIndex(b => b.summary_id === sjOrphan.summary_id);
  dumpOrphan.blobs.splice(oi, 1);
  r = await inboxOf(store, env, RIDO, kOrp.kp.privateKey);
  const inboxOrphan = await r.json();
  ok(inboxOrphan.length === 0, 'orphan: blob 없는 summary는 inbox에서 제외(ciphertext:null 항목도 반환하지 않음)');
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDO);
  const cntOrphan = await r.json();
  ok(cntOrphan.count === 0, 'orphan: inbox-count도 동일하게 제외(열 수 없는 알림 배지 방지)');
  ok(cntOrphan.count === inboxOrphan.length, 'orphan: inbox 항목 수와 inbox-count 완전 일치(필터 시맨틱 동일)');

  // 24) TTL cron 배치화(B10) 회귀: 100개 청크 경계를 넘는 105건도 행 단위 루프와 동일하게 처리된다.
  const RIDB = 'MGT-BATCH';
  const kBat = await mkKey();
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDB, restaurant_name: '배치테스트', public_key: kBat.spki });
  const batchIds = [];
  for (let i = 0; i < 105; i++) {
    const rb = await call(store, env, 'POST', '/api/submit', {
      summary: { restaurant_id: RIDB, restaurant_name: '배치테스트', total_amount: 100, member_count: 1, batch_hash: 'h-batch-' + i },
      blob: { restaurant_id: RIDB, ciphertext: badCipher }
    });
    batchIds.push((await rb.json()).summary_id);
  }
  ok(batchIds.length === 105 && batchIds.every(Boolean), 'cron 배치: 105건 제출 완료(청크 경계 100 초과)');
  // 105건 중 100건만 72시간 경과로 늙히고, 5건은 최신으로 남겨 "대상만 처리"되는지 확인.
  const dumpBatch = store._dump();
  const agedIds = batchIds.slice(0, 100), freshIds = batchIds.slice(100);
  dumpBatch.summaries.forEach(s => { if (agedIds.includes(s.id)) s.created_at = Date.now() - (72 * 60 * 60 * 1000 + 60 * 1000); });
  const cleanupBatch = await store.cleanupTTL(Date.now());
  ok(cleanupBatch.expiredSummaries >= 100, 'cron 배치: 만료 대상 100건 이상이 한 번의 cron으로 EXPIRED 처리(expiredSummaries>=100)');
  const dumpBatch2 = store._dump();
  ok(agedIds.every(id => { const s = dumpBatch2.summaries.find(x => x.id === id); return s && s.status === 'EXPIRED' && s.processed_at; }),
    'cron 배치: 늙힌 100건이 모두 EXPIRED + processed_at 기록(행 단위 루프와 동일 결과)');
  ok(!dumpBatch2.blobs.some(b => agedIds.includes(b.summary_id)), 'cron 배치: 만료된 100건의 encrypted_blob이 모두 삭제됨');
  ok(freshIds.every(id => { const s = dumpBatch2.summaries.find(x => x.id === id); return s && s.status === 'PENDING'; })
    && dumpBatch2.blobs.filter(b => freshIds.includes(b.summary_id)).length === freshIds.length,
    'cron 배치: 만료되지 않은 5건은 PENDING·blob 그대로 유지(대상만 처리)');
  // 30일 경과 요약 삭제도 배치 경로로 동일 동작
  dumpBatch2.summaries.forEach(s => { if (agedIds.includes(s.id)) s.processed_at = Date.now() - (30 * 24 * 60 * 60 * 1000 + 60 * 1000); });
  const cleanupBatch2 = await store.cleanupTTL(Date.now());
  ok(cleanupBatch2.deletedSummaries >= 100, 'cron 배치: 30일 경과 비식별 요약 100건 이상도 한 번에 삭제(deletedSummaries>=100)');
  ok(!store._dump().summaries.some(s => agedIds.includes(s.id)), 'cron 배치: 30일 경과 요약 행이 모두 제거됨');

  // 24b) feedback 보존기한(180일): cron이 경과분만 삭제하고 최근 것은 남긴다.
  await call(store, env, 'POST', '/api/feedback', { role: '직원', message: '보존기한 테스트(오래된 것)' });
  await call(store, env, 'POST', '/api/feedback', { role: '직원', message: '보존기한 테스트(최근 것)' });
  store._dump().feedbacks.forEach(f => { if (f.message === '보존기한 테스트(오래된 것)') f.created_at = Date.now() - (180 * 24 * 60 * 60 * 1000 + 60 * 1000); });
  await store.cleanupTTL(Date.now());
  const dumpFb = store._dump();
  ok(!dumpFb.feedbacks.some(f => f.message === '보존기한 테스트(오래된 것)'), 'feedback TTL: 180일 경과 피드백은 cron이 삭제');
  ok(dumpFb.feedbacks.some(f => f.message === '보존기한 테스트(최근 것)'), 'feedback TTL: 최근 피드백은 유지');

  // 25) blob items의 '선택 필드 org'는 batch_hash 계산·검증에 영향을 주지 않는다(PROTOCOL §3 canonical
  // = "name|dept|amount" 불변). 서버 관점 왕복(제출 → inbox 조회 → 복호화 → 재계산)으로 확인한다.
  const RIDORG = 'MGT-ORG1';
  const kOrg = await mkKey();
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDORG, restaurant_name: '소속식당', public_key: kOrg.spki });
  ok(r.status === 200, 'org: 테스트용 음식점 공개키 등록 200');

  const orgItems = [
    { name: '김철수', dept: '총무과', amount: 50000, org: '강남구청' },
    { name: '이영희', dept: '세무과', amount: 70000, org: '강남구보건소' },
  ];
  const bareItems = orgItems.map(({ name, dept, amount }) => ({ name, dept, amount }));
  const hOrg = await batchHash(orgItems);
  ok(hOrg === await batchHash(bareItems), 'org: canonical(name|dept|amount)은 org 유무와 무관하게 동일한 batch_hash');

  r = await call(store, env, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDORG, restaurant_name: '소속식당', year_month: '2026-07', total_amount: 120000, member_count: 2, batch_hash: hOrg },
    blob: { restaurant_id: RIDORG, ciphertext: await encryptBlob(orgItems, kOrg.kp.publicKey) }
  });
  const sjOrg = await r.json();
  ok(r.status === 200 && !!sjOrg.summary_id && !sjOrg.deduped, 'org: org 포함 명단 제출 200(신규)');

  r = await inboxOf(store, env, RIDORG, kOrg.kp.privateKey);
  const inboxOrg = await r.json();
  const gotOrg = inboxOrg.find(x => x.summary_id === sjOrg.summary_id);
  ok(!!gotOrg && !('batch_hash' in gotOrg.summary), 'org: inbox 요약에는 batch_hash가 없다(오라클 차단 — 검증은 blob 내부 값으로)');
  const plainOrg = await decryptBlob(gotOrg.ciphertext, kOrg.kp.privateKey);
  ok(plainOrg.items.length === 2 && plainOrg.items[0].org === '강남구청' && plainOrg.items[1].org === '강남구보건소',
    'org: 복호화 결과에 선택 필드 org가 그대로 보존됨(서버가 blob을 건드리지 않음)');
  ok(await batchHash(plainOrg.items) === hOrg,
    'org: 수신 측 재계산 해시가 일치(org는 canonical에 포함되지 않음 — 변조 오탐 없음)');
  // 서버는 org를 평문으로 알지 못한다(요약에도, 저장된 암호문에도 평문 org 없음).
  const dumpOrg = store._dump();
  const sRowOrg = dumpOrg.summaries.find(s => s.id === sjOrg.summary_id);
  ok(!!sRowOrg && !('org' in sRowOrg) && !('items' in sRowOrg), 'org: deposit_summary에 org·명단 평문 없음(§0 불변식)');
  ok(dumpOrg.blobs.filter(b => b.summary_id === sjOrg.summary_id).every(b => !b.ciphertext.includes('강남구청')),
    'org: encrypted_blob에도 평문 org 없음(암호문만 저장)');

  // 같은 명단을 org 값만 바꿔 재제출 → 동일 batch_hash라 멱등(deduped) — org가 해시에 섞이지 않는다는 서버 측 증거.
  const orgItems2 = orgItems.map(i => ({ ...i, org: '(소속 표기 변경)' + i.org }));
  ok(await batchHash(orgItems2) === hOrg, 'org: org 값만 달라진 동일 명단의 batch_hash 동일');
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDORG, restaurant_name: '소속식당', year_month: '2026-07', total_amount: 120000, member_count: 2, batch_hash: await batchHash(orgItems2) },
    blob: { restaurant_id: RIDORG, ciphertext: await encryptBlob(orgItems2, kOrg.kp.publicKey) }
  });
  const sjOrg2 = await r.json();
  ok(r.status === 200 && sjOrg2.deduped === true && sjOrg2.summary_id === sjOrg.summary_id,
    'org: org만 다른 재제출은 동일 (restaurant_id,batch_hash)로 멱등 처리(deduped:true)');
  ok(dumpOrg.summaries.filter(s => s.restaurant_id === RIDORG).length === 1, 'org: 재제출로 새 summary 행이 생기지 않음');

  // ══════════════════════════════════════════════════════════════════════════
  // 2026-08 보안 강화(OWASP/ASVS/STRIDE 점검 반영) 회귀
  // ══════════════════════════════════════════════════════════════════════════

  // 26) 열쇠 지문 확인 기록(§4.8) — 가게 선점 방어의 핵심.
  // 지문 = SHA-256(공개키 SPKI raw) → hex 소문자 → 앞 8자 → 대문자 4자씩 하이픈("ABCD-EF12").
  // 세 컴포넌트가 같은 규칙으로 계산해야 하므로 하니스도 서버와 독립적으로 계산해 대조한다.
  const fingerprintOf = async (spkiB64) => {
    const h = await subtle.digest('SHA-256', unb64(spkiB64));
    const s = Array.from(new Uint8Array(h)).map(v => v.toString(16).padStart(2, '0')).join('').slice(0, 8).toUpperCase();
    return s.slice(0, 4) + '-' + s.slice(4, 8);
  };
  const AGT = { 'X-Agency-Token': rjAgencyTok.token };
  const RIDK = 'MGT-KEYCHECK-1';
  const kKc = await mkKey();
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDK, restaurant_name: '지문식당', public_key: kKc.spki });
  ok(r.status === 200, 'keycheck: 테스트용 음식점 등록 200');
  const fpK = await fingerprintOf(kKc.spki);
  ok(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(fpK), 'keycheck: 지문 형식 "ABCD-EF12"(대문자 hex 4-4)');

  // 26-a) 기관 토큰 없으면 401(저장·조회 양쪽)
  r = await call(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDK, fingerprint: fpK });
  ok(r.status === 401 && (await r.json()).error === 'agency_auth_required', 'keycheck: X-Agency-Token 없이 저장 401(agency_auth_required)');
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDK, fingerprint: fpK }, { 'X-Agency-Token': 'not-a-real-token' });
  ok(r.status === 401, 'keycheck: 무효 토큰으로 저장 401');
  r = await call(store, env, 'GET', '/api/agency/keychecks?institution=' + encodeURIComponent('서울특별시 강남구') + '&department=' + encodeURIComponent('총무과'));
  ok(r.status === 401, 'keycheck: X-Agency-Token 없이 조회 401');

  // 26-b) 정상 저장 200 + 서버가 재계산한 지문 반환
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDK, fingerprint: fpK }, AGT);
  const kcOk = await r.json();
  ok(r.status === 200 && kcOk.ok === true && kcOk.fingerprint === fpK, 'keycheck: 지문 일치 시 저장 200(서버 재계산 지문 반환)');

  // 26-c) 그 부서의 확인 목록 조회 — restaurant_id·fingerprint·checked_at만(인원·금액 등 금지)
  r = await callH(store, env, 'GET', '/api/agency/keychecks?institution=' + encodeURIComponent('서울특별시 강남구') + '&department=' + encodeURIComponent('총무과'), undefined, AGT);
  const kcList = await r.json();
  ok(r.status === 200 && Array.isArray(kcList.keychecks) && kcList.keychecks.length === 1
    && kcList.keychecks[0].restaurant_id === RIDK && kcList.keychecks[0].fingerprint === fpK
    && typeof kcList.keychecks[0].checked_at === 'number', 'keycheck: 확인 목록 조회 200(restaurant_id·fingerprint·checked_at)');
  ok(kcList.keychecks.every(x => Object.keys(x).sort().join(',') === 'checked_at,fingerprint,restaurant_id'),
    'keycheck: 응답 항목은 3필드만(인원·금액·기관 이메일 등 다른 정보 없음)');

  // 26-d) 부서 격리: 같은 기관이라도 다른 부서는 '미확인'으로 남는다(부서별 독립 확인)
  r = await callH(store, env, 'GET', '/api/agency/keychecks?institution=' + encodeURIComponent('서울특별시 강남구') + '&department=' + encodeURIComponent('세무과'), undefined, AGT);
  const kcOther = await r.json();
  ok(r.status === 200 && kcOther.keychecks.length === 0, 'keycheck: 같은 기관 다른 부서(세무과)는 미확인 — 부서 격리');
  // 다른 기관도 마찬가지로 격리
  r = await callH(store, env, 'GET', '/api/agency/keychecks?institution=' + encodeURIComponent('부산광역시 서구') + '&department=' + encodeURIComponent('총무과'), undefined, AGT);
  ok((await r.json()).keychecks.length === 0, 'keycheck: 다른 기관도 확인 기록이 공유되지 않음');

  // 26-e) upsert: 같은 (기관,부서,음식점) 재확인은 행이 늘지 않고 갱신만 된다
  const kcBefore = store._dump().keychecks.size;
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDK, fingerprint: fpK.toLowerCase() }, AGT);
  ok(r.status === 200, 'keycheck: 소문자 지문도 정규화되어 저장 200');
  ok(store._dump().keychecks.size === kcBefore, 'keycheck: 같은 부서 재확인은 upsert(행 증가 없음)');

  // 26-f) 지문 불일치 409 + 서버가 계산한 current 지문 안내
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDK, fingerprint: 'AAAA-BBBB' }, AGT);
  const kcMis = await r.json();
  ok(r.status === 409 && kcMis.error === 'fingerprint_mismatch' && kcMis.current === fpK,
    'keycheck: 지문 불일치 409(fingerprint_mismatch + current)');
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDK, fingerprint: '지문아님' }, AGT);
  ok(r.status === 400 && (await r.json()).error === 'invalid_fingerprint', 'keycheck: 지문 형식 오류 400(invalid_fingerprint)');
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: 'MGT-NO-SUCH-KC', fingerprint: fpK }, AGT);
  ok(r.status === 404, 'keycheck: 미등록 음식점 404');
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '', department: '총무과', restaurant_id: RIDK, fingerprint: fpK }, AGT);
  ok(r.status === 400, 'keycheck: 기관·부서 누락 400');
  r = await callH(store, env, 'GET', '/api/agency/keychecks?institution=' + encodeURIComponent('서울특별시 강남구'), undefined, AGT);
  ok(r.status === 400, 'keycheck: 조회 시 부서 누락 400');

  // 26-g) 핵심 시나리오: 공개키가 바뀌면(가게 선점·기기 교체) 예전 지문은 더 이상 통하지 않는다
  const kKc2 = await mkKey();
  const tokKc = await getAuthToken(store, env, RIDK, kKc.kp.privateKey);
  r = await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDK, restaurant_name: '지문식당', public_key: kKc2.spki, auth_token: tokKc });
  ok(r.status === 200, 'keycheck: 소유 증명 후 키 교체 200');
  const fpK2 = await fingerprintOf(kKc2.spki);
  r = await callH(store, env, 'POST', '/api/agency/keycheck', { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDK, fingerprint: fpK }, AGT);
  const kcAfter = await r.json();
  ok(r.status === 409 && kcAfter.current === fpK2, 'keycheck: 키 교체 후 예전 지문은 409(current는 새 지문 — 담당자가 재확인해야 함)');

  // 26-h) 보존: 열쇠 지문 확인 기록은 TTL cron 정리 대상이 아니다(장기 보관)
  const kcSizeBeforeCron = store._dump().keychecks.size;
  await store.cleanupTTL(Date.now());
  ok(store._dump().keychecks.size === kcSizeBeforeCron, 'keycheck: TTL cron이 확인 이력을 지우지 않음(장기 보관)');

  // 27) 가게 등록 강화(F-01) — 공공데이터 실존·상호 대조.
  // callRaw는 목 카탈로그에 자동 등재하지 않으므로 "공공데이터에 없는 가게" 상황을 만든다.
  const kFake = await mkKey();
  r = await callRaw(store, env, 'POST', '/api/register-key', { restaurant_id: 'MGT-NOT-REAL-1', restaurant_name: '유령식당', public_key: kFake.spki });
  ok(r.status === 400 && (await r.json()).error === 'store_not_found', 'register-key: 공공데이터에 없는 가게는 400(store_not_found)');
  ok(!store._dump().keys.has('MGT-NOT-REAL-1'), 'register-key: 실존 확인 실패 시 공개키가 저장되지 않음');

  seedStore('MGT-REAL-1', '진짜식당');
  r = await callRaw(store, env, 'POST', '/api/register-key', { restaurant_id: 'MGT-REAL-1', restaurant_name: '남의가게이름', public_key: kFake.spki });
  ok(r.status === 400 && (await r.json()).error === 'store_not_found', 'register-key: id는 실존하나 상호가 다르면 400(선점 방어)');

  const kReal = await mkKey();
  r = await callRaw(store, env, 'POST', '/api/register-key', { restaurant_id: 'MGT-REAL-1', restaurant_name: ' 진짜식당 (본점) ', public_key: kReal.spki });
  ok(r.status === 400, 'register-key: 괄호 안 표기가 공공데이터와 다르면 여전히 400(정규화는 공백·괄호 문자만 제거)');
  seedStore('MGT-REAL-2', '진짜식당(본점)');
  const kReal2 = await mkKey();
  r = await callRaw(store, env, 'POST', '/api/register-key', { restaurant_id: 'MGT-REAL-2', restaurant_name: '진짜식당 (본점)', public_key: kReal2.spki });
  ok(r.status === 200, 'register-key: 공백·괄호 표기 차이는 정규화 후 일치로 통과 200');
  ok(store._dump().keys.get('MGT-REAL-2').verified === 1, 'register-key: 대조 성공 시 verified=1');

  // 공공 API 장애(조회 실패)에는 등록을 막지 않는다 — 가용성 우선, verified=0으로 표시만.
  const envApiDown = { ...env, searchRestaurants: async () => { throw new Error('공공API HTTP 503'); } };
  const kDown = await mkKey();
  r = await callRaw(store, envApiDown, 'POST', '/api/register-key', { restaurant_id: 'MGT-APIDOWN-1', restaurant_name: '장애중식당', public_key: kDown.spki, district: '서울특별시 광진구' });
  ok(r.status === 200, 'register-key: 공공API 장애 시에도 등록 200(가용성 우선 — 등록을 막지 않음)');
  ok(store._dump().keys.get('MGT-APIDOWN-1').verified === 0, 'register-key: 공공API 장애로 판정 불가면 verified=0');
  r = await call(store, env, 'GET', '/api/registered-list?sido=' + encodeURIComponent('서울특별시') + '&sigungu=' + encodeURIComponent('광진구'));
  ok((await r.json()).restaurants.some(x => x.restaurant_id === 'MGT-APIDOWN-1' && x.verified === 0),
    'registered-list: 미확인 등록분은 verified=0으로 노출(담당자 웹이 배지로 구분)');

  // 재등록(다른 키, 소유 증명)은 실존 재대조를 하지 않는다 — 최초 등록에서만 검증(§4.10).
  const kDown2 = await mkKey();
  const tokDown = await getAuthToken(store, envApiDown, 'MGT-APIDOWN-1', kDown.kp.privateKey);
  r = await callRaw(store, envApiDown, 'POST', '/api/register-key', { restaurant_id: 'MGT-APIDOWN-1', restaurant_name: '장애중식당', public_key: kDown2.spki, auth_token: tokDown });
  ok(r.status === 200, 'register-key: 소유 증명 재등록은 공공API 조회 없이 200(최초 등록에서만 대조)');

  // 28) 수신함 인증(F-02/M-5)
  const RIDA = 'MGT-INBOXAUTH-1';
  const kIa = await mkKey();
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDA, restaurant_name: '수신함식당', public_key: kIa.spki });
  r = await call(store, env, 'POST', '/api/submit', {
    summary: { institution: '서울특별시 강남구', department: '총무과', restaurant_id: RIDA, restaurant_name: '수신함식당', year_month: '2026-08', total_amount: 10000, member_count: 1, batch_hash: 'h-inboxauth' },
    blob: { restaurant_id: RIDA, ciphertext: badCipher }
  });
  ok(r.status === 200, 'inbox 인증: 사전 제출 200');
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RIDA);
  ok(r.status === 401 && (await r.json()).error === 'auth_required', 'inbox: 무인증 조회 401(auth_required)');
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RIDA + '&auth_token=bogus');
  ok(r.status === 401, 'inbox: 위조 auth_token 401');
  // 다른 음식점의 유효한 토큰으로는 남의 수신함을 열 수 없다.
  const tokOtherShop = await getAuthToken(store, env, RIDK, kKc2.kp.privateKey);
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RIDA + '&auth_token=' + encodeURIComponent(tokOtherShop));
  ok(r.status === 401, 'inbox: 다른 음식점의 유효 토큰으로도 401(가게별 챌린지 격리)');
  // 헤더(X-Auth-Token) 경로도 동작
  const tokIa1 = await getAuthToken(store, env, RIDA, kIa.kp.privateKey);
  r = await callH(store, env, 'GET', '/api/inbox?restaurant_id=' + RIDA, undefined, { 'X-Auth-Token': tokIa1 });
  const inboxIa = await r.json();
  ok(r.status === 200 && inboxIa.length === 1, 'inbox: X-Auth-Token 헤더 인증으로 200');
  ok(!('batch_hash' in inboxIa[0].summary), 'inbox: 요약에 batch_hash 없음(오라클 차단 — 재확인)');
  // 토큰은 1회용
  r = await callH(store, env, 'GET', '/api/inbox?restaurant_id=' + RIDA, undefined, { 'X-Auth-Token': tokIa1 });
  ok(r.status === 401, 'inbox: 동일 auth_token 재사용 401(1회용)');
  // inbox-count는 현행대로 무인증(개수만 — /api/inbox로 알 수 있는 값의 부분집합)
  r = await call(store, env, 'GET', '/api/inbox-count?restaurant_id=' + RIDA);
  const cntIa = await r.json();
  ok(r.status === 200 && cntIa.count === 1 && Object.keys(cntIa).join(',') === 'count',
    'inbox-count: 인증 없이 200 유지(응답은 count만 — 요약 메타 없음)');

  // 29) OTP 발송 남용 차단(F-03)
  const ymd = new Date();
  const otpKey = 'otp_sent_' + ymd.getUTCFullYear() + '-' + String(ymd.getUTCMonth() + 1).padStart(2, '0') + '-' + String(ymd.getUTCDate()).padStart(2, '0');
  // 29-a) 발송 성공 시 일일 카운터 +1
  const otpUsedBefore = store._dump().counters.get(otpKey) || 0;
  stub = makeFetchStub({ ok: true, status: 200 });
  globalThis.fetch = stub.fn.bind(stub);
  try { r = await call(store, envProd, 'POST', '/api/agency/request-otp', { email: 'budget-1@seoul.go.kr' }); }
  finally { globalThis.fetch = realFetch; }
  ok(r.status === 200 && (store._dump().counters.get(otpKey) || 0) === otpUsedBefore + 1,
    'otp 예산: 발송 성공 시 일일 카운터(otp_sent_YYYY-MM-DD) +1');
  // 29-b) 예산 초과 → Resend 호출 없이 429
  const envBudget0 = { ...envProd, OTP_DAILY_BUDGET: '0' };
  stub = makeFetchStub({ ok: true, status: 200 });
  globalThis.fetch = stub.fn.bind(stub);
  try { r = await call(store, envBudget0, 'POST', '/api/agency/request-otp', { email: 'budget-2@seoul.go.kr' }); }
  finally { globalThis.fetch = realFetch; }
  const rjBudget = await r.json();
  ok(r.status === 429 && rjBudget.error === 'email_quota_exceeded' && stub.calls.length === 0,
    'otp 예산: 일일 상한 초과 시 Resend 호출 없이 429(email_quota_exceeded)');
  ok(!store._dump().agencyOtps.has(await sha256hex('budget-2@seoul.go.kr')),
    'otp 예산: 예산 초과 요청은 OTP 행을 만들지 않음(60초 스로틀 미소모)');
  // 예산은 prod에서만 검사 — dev/pilot은 발송 자체가 없으므로 영향 없음
  r = await call(store, { ...env, OTP_DAILY_BUDGET: '0' }, 'POST', '/api/agency/request-otp', { email: 'budget-3@seoul.go.kr' });
  ok(r.status === 200, 'otp 예산: 발송하지 않는 모드(dev)는 예산과 무관하게 통과');

  // 29-c) IP당 시간당 5회 저한도(per-isolate 한계는 §6.3 — 없는 것보단 낫다)
  let otpIpLimited = false;
  for (let i = 0; i < 8; i++) {
    const rr = await handle(new Request('http://x/api/agency/request-otp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.111' },
      body: JSON.stringify({ email: 'otp-ip-' + i + '@seoul.go.kr' })
    }), env, store);
    if (rr.status === 429 && (await rr.json()).error === 'rate_limited') { otpIpLimited = i >= 5; break; }
  }
  ok(otpIpLimited, 'otp: 같은 IP에서 시간당 5회 초과 요청은 429(rate_limited)');
  const otpIpOther = await handle(new Request('http://x/api/registered?ids=otp-ip-other', { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.111' } }), env, store);
  ok(otpIpOther.status === 200, 'otp: OTP 전용 IP 한도는 다른 엔드포인트에 영향 없음(독립 카운터)');

  // 30) 응답 보안 헤더(H-5 서버 몫) — 모든 응답에 공통 적용, CORS 동작 불변
  const secHdr = await handle(new Request('http://x/api/registered?ids=sec-1', { method: 'GET', headers: { Origin: 'https://a.example' } }), { ...env, ALLOW_ORIGIN: 'https://a.example' }, store);
  ok(secHdr.headers.get('Cache-Control') === 'no-store', '보안 헤더: Cache-Control: no-store');
  ok(secHdr.headers.get('X-Content-Type-Options') === 'nosniff', '보안 헤더: X-Content-Type-Options: nosniff');
  ok(secHdr.headers.get('Referrer-Policy') === 'no-referrer', '보안 헤더: Referrer-Policy: no-referrer');
  ok(secHdr.headers.get('Strict-Transport-Security') === 'max-age=31536000; includeSubDomains', '보안 헤더: Strict-Transport-Security');
  ok(secHdr.headers.get('Access-Control-Allow-Origin') === 'https://a.example', '보안 헤더: CORS 동작 불변(화이트리스트 Origin echo 유지)');
  const secErr = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RIDA);
  ok(secErr.status === 401 && secErr.headers.get('Cache-Control') === 'no-store' && secErr.headers.get('X-Content-Type-Options') === 'nosniff',
    '보안 헤더: 오류 응답(401)에도 동일하게 적용');
  const secOpt = await handle(new Request('http://x/api/inbox', { method: 'OPTIONS', headers: { Origin: 'https://a.example' } }), { ...env, ALLOW_ORIGIN: 'https://a.example' }, store);
  ok(secOpt.status === 204 && secOpt.headers.get('X-Content-Type-Options') === 'nosniff'
    && secOpt.headers.get('Access-Control-Allow-Headers').includes('X-Auth-Token'),
    '보안 헤더: OPTIONS 프리플라이트에도 적용 + X-Auth-Token 허용 헤더 등재');

  // 31) /api/registered ids 상한(F-14): 100개 초과는 500이 아니라 400
  const ids100 = Array.from({ length: 100 }, (_, i) => 'ID-' + i).join(',');
  r = await call(store, env, 'GET', '/api/registered?ids=' + ids100);
  ok(r.status === 200 && Array.isArray(await r.json()), 'registered: 경계값 100개는 200');
  const ids101 = Array.from({ length: 101 }, (_, i) => 'ID-' + i).join(',');
  r = await call(store, env, 'GET', '/api/registered?ids=' + ids101);
  const rjIds = await r.json();
  ok(r.status === 400 && rjIds.error === 'too_many_ids' && rjIds.max === 100,
    'registered: 101개는 400(too_many_ids) — 과거엔 D1 바인딩 초과로 500이었음');

  // 32) 피드백 전화번호 차단(불변식 4 보호)
  r = await call(store, env, 'POST', '/api/feedback', { role: '음식점', message: '연락주세요 010-1234-5678' });
  ok(r.status === 400 && (await r.json()).error === 'no_personal_info', 'feedback: message에 전화번호가 있으면 400(no_personal_info)');
  r = await call(store, env, 'POST', '/api/feedback', { role: '기관', message: '문의드립니다', contact: '01012345678' });
  ok(r.status === 400 && (await r.json()).error === 'no_personal_info', 'feedback: contact에 하이픈 없는 전화번호도 400');
  r = await call(store, env, 'POST', '/api/feedback', { role: '직원', message: '011-222-3333로 연락 부탁' });
  ok(r.status === 400, 'feedback: 011 등 다른 통신사 번호도 차단');
  ok(!store._dump().feedbacks.some(f => /01[0-9]-?\d{3,4}-?\d{4}/.test(String(f.message) + String(f.contact || ''))),
    'feedback: 저장소 어디에도 전화번호 패턴이 남지 않음');
  r = await call(store, env, 'POST', '/api/feedback', { role: '기타', message: '2026-08-01에 써봤어요. 좋네요', contact: 'https://open.kakao.com/o/ok1' });
  ok(r.status === 200, 'feedback: 전화번호가 아닌 숫자(날짜 등)는 정상 저장 200(오탐 없음)');

  // 33) 이메일 해시 pepper(F-09/M-8): 설정 시 HMAC, 미설정 시 기존 SHA-256, 구 해시 조회 폴백
  const hmacHex = async (key, msg) => {
    const k = await subtle.importKey('raw', encU.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return Array.from(new Uint8Array(await subtle.sign('HMAC', k, encU.encode(msg)))).map(v => v.toString(16).padStart(2, '0')).join('');
  };
  const envPepper = { ...env, EMAIL_PEPPER: 'test-pepper-value' };
  const PEP_EMAIL = 'pepper-officer@seoul.go.kr';
  r = await call(store, envPepper, 'POST', '/api/agency/request-otp', { email: PEP_EMAIL });
  const rjPep = await r.json();
  ok(r.status === 200 && /^\d{6}$/.test(rjPep.dev_otp || ''), 'pepper: EMAIL_PEPPER 설정 상태에서도 OTP 발급 정상');
  const pepKey = await hmacHex('test-pepper-value', PEP_EMAIL);
  const pepLegacyKey = await sha256hex(PEP_EMAIL);
  ok(store._dump().agencyOtps.has(pepKey) && !store._dump().agencyOtps.has(pepLegacyKey),
    'pepper: 저장 키가 HMAC-SHA256(EMAIL_PEPPER, email)이며 구 SHA-256 키가 아님');
  r = await call(store, envPepper, 'POST', '/api/agency/verify-otp', { email: PEP_EMAIL, otp: rjPep.dev_otp });
  const rjPepTok = await r.json();
  ok(r.status === 200 && typeof rjPepTok.token === 'string', 'pepper: HMAC 키로 verify-otp 정상 통과');
  ok([...store._dump().agencyTokens.values()].some(t => t.email_hash === pepKey), 'pepper: agency_token에도 HMAC 해시로 저장');

  // 미설정(기본): 기존 SHA-256 그대로 — 배포 순서 안전(secret 등록 전에도 동작)
  const NOPEP_EMAIL = 'nopepper-officer@seoul.go.kr';
  r = await call(store, env, 'POST', '/api/agency/request-otp', { email: NOPEP_EMAIL });
  ok(r.status === 200 && store._dump().agencyOtps.has(await sha256hex(NOPEP_EMAIL)),
    'pepper: EMAIL_PEPPER 미설정이면 기존 SHA-256 키로 동작(구 동작 보존)');

  // 전환기 폴백: pepper 도입 전에 구 SHA-256 키로 저장된 행도 계속 검증된다
  const LEGACY_EMAIL = 'legacy-officer@seoul.go.kr';
  const legacyKey = await sha256hex(LEGACY_EMAIL);
  await store.upsertAgencyOtp({ email_hash: legacyKey, otp_hash: await sha256hex('654321'), expires_at: Date.now() + 60000, attempts: 0, created_at: Date.now() - 120000 });
  r = await call(store, envPepper, 'POST', '/api/agency/verify-otp', { email: LEGACY_EMAIL, otp: '654321' });
  ok(r.status === 200 && typeof (await r.json()).token === 'string',
    'pepper 폴백: pepper 도입 전 SHA-256 키로 저장된 OTP 행도 검증 성공');
  ok(!store._dump().agencyOtps.has(legacyKey), 'pepper 폴백: 검증 성공 시 구 키 행이 삭제됨(1회용 유지)');
  // 구 키 행이 남아 있으면 재요청 스로틀도 그 행을 인식한다(두 키로 갈라지지 않음)
  const legacyKey2 = await sha256hex('legacy2-officer@seoul.go.kr');
  await store.upsertAgencyOtp({ email_hash: legacyKey2, otp_hash: await sha256hex('111111'), expires_at: Date.now() + 60000, attempts: 0, created_at: Date.now() });
  r = await call(store, envPepper, 'POST', '/api/agency/request-otp', { email: 'legacy2-officer@seoul.go.kr' });
  ok(r.status === 429, 'pepper 폴백: 구 키 행도 60초 재요청 스로틀에 그대로 반영');

  // 34) 챌린지 상한·정리·레이트리밋
  const RIDCH = 'MGT-CHAL-1';
  const kCh = await mkKey();
  await call(store, env, 'POST', '/api/register-key', { restaurant_id: RIDCH, restaurant_name: '챌린지식당', public_key: kCh.spki });
  let chalStatuses = [];
  for (let i = 0; i < 6; i++) {
    const rr = await call(store, env, 'POST', '/api/challenge', { restaurant_id: RIDCH });
    chalStatuses.push(rr.status);
  }
  ok(chalStatuses.slice(0, 5).every(s => s === 200) && chalStatuses[5] === 429,
    'challenge: 소비되지 않은 챌린지가 5개 차면 6번째는 429(too_many_challenges)');
  ok(store._dump().challenges.filter(c => c.restaurant_id === RIDCH).length === 5,
    'challenge: 상한 초과분은 저장되지 않음(미만료 5개 유지)');
  // 만료분은 발급 직전에 정리되므로 다시 발급받을 수 있다
  store._dump().challenges.forEach(c => { if (c.restaurant_id === RIDCH) c.expires_at = Date.now() - 1000; });
  r = await call(store, env, 'POST', '/api/challenge', { restaurant_id: RIDCH });
  ok(r.status === 200, 'challenge: 만료분은 발급 전에 정리되어 다시 발급 가능');
  ok(store._dump().challenges.filter(c => c.restaurant_id === RIDCH).length === 1,
    'challenge: 만료된 5개가 지워지고 새 1개만 남음(저장 남용 방지)');
  // 정상 소비 흐름(발급 즉시 1회용 소비)은 8회를 반복해도 상한에 걸리지 않는다.
  let consumeOk = true;
  for (let i = 0; i < 8; i++) { if ((await inboxOf(store, env, RIDCH, kCh.kp.privateKey)).status !== 200) consumeOk = false; }
  ok(consumeOk, 'challenge: 발급→소비를 반복하는 정상 흐름은 상한에 걸리지 않음');
  // IP당 분당 20회 별도 레이트리밋(독립 카운터)
  let chLimited = false;
  for (let i = 0; i < 25; i++) {
    const rr = await handle(new Request('http://x/api/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.222' },
      body: JSON.stringify({ restaurant_id: RIDCH })
    }), env, store);
    if (rr.status === 429 && (await rr.json()).error === 'rate_limited') { chLimited = true; break; }
  }
  ok(chLimited, 'challenge: 강화된 레이트리밋(IP당 분당 20회) 초과 시 429');
  const chOther = await handle(new Request('http://x/api/registered?ids=ch-other', { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.222' } }), env, store);
  ok(chOther.status === 200, 'challenge: 챌린지 전용 레이트리밋은 다른 엔드포인트에 영향 없음');

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
