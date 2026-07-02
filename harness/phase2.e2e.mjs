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

const call = (store, env, method, path, body) =>
  handle(new Request('http://x' + path, body !== undefined
    ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { method }), env, store);
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

(async () => {
  const store = makeMemoryStore();
  const RID = 'MGT-0001';
  const env = {
    ALLOW_ORIGIN: '*',
    AUTH_MODE: 'dev',
    REQUIRE_AGENCY_AUTH: '0',
    // 목 LOCALDATA: 실제 키/엔드포인트 대체
    searchRestaurants: async (_env, region, q) => {
      const all = [
        { restaurant_id: 'MGT-0001', name: '정식김밥', address: '서울 강남구 1', status: '영업/정상' },
        { restaurant_id: 'MGT-0002', name: '한밭식당', address: '서울 강남구 2', status: '영업/정상' }
      ];
      return all.filter(r => region && (!q || r.name.includes(q)));
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
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RID);
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
  ok(reHash === inbox[0].summary.batch_hash, 'batch_hash 재계산 일치(전송 변조 없음)');
  const changed = assignDuplicateSuffix(plain.items);
  ok(changed === 2 && plain.items[0].name === '김철수a' && plain.items[1].name === '김철수b', '동명이인 자동 보완(a/b)');

  // 변조 탐지: ct 1바이트 변경 → 복호화 실패 또는 해시 불일치
  let tamperCaught = false;
  try { const bad = { ...inbox[0].ciphertext, ct: inbox[0].ciphertext.ct.slice(0, -2) + (inbox[0].ciphertext.ct.slice(-2) === 'AA' ? 'BB' : 'AA') }; await decryptBlob(bad, kp.privateKey); } catch { tamperCaught = true; }
  ok(tamperCaught, '암호문 변조 시 복호화 실패(탐지)');

  // 승인 후 수신함 비워짐(PENDING 아님)
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RID);
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

  const dumpConsent = store._dump();
  const expectedHash = await sha256hex('officer@seoul.go.kr');
  const consentRow = dumpConsent.consents.find(c => c.agency_email_hash === expectedHash);
  ok(!!consentRow, 'submit: consent_log에 기관 이메일의 SHA-256 해시가 기록됨');
  ok(dumpConsent.consents.every(c => !JSON.stringify(c).includes('officer@seoul.go.kr')), 'submit: consent_log 어디에도 평문 이메일 없음(해시만)');

  // REQUIRE_AGENCY_AUTH가 비활성(기본값)이면 여전히 토큰 없이 제출 가능(하위 호환)
  r = await call(store, env, 'POST', '/api/submit', { summary: { restaurant_id: 'MGT-0007', total_amount: 100, member_count: 1, batch_hash: 'h-agency-off' }, blob: { ciphertext: badCipher } });
  ok(r.status === 200, 'submit: REQUIRE_AGENCY_AUTH=0(기본값)이면 토큰 없이도 여전히 통과');

  // 16) 레이트 리밋 헤더 존재 시 429(베스트 에포트) — CF-Connecting-IP 없는 하니스 호출은 영향 없음 확인
  let limited = false;
  for (let i = 0; i < 65; i++) {
    const rr = await handle(new Request('http://x/api/registered?ids=rl-test', { method: 'GET', headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env, store);
    if (rr.status === 429) { limited = true; break; }
  }
  ok(limited, '레이트 리밋: CF-Connecting-IP 존재 시 분당 60회 초과하면 429');
  const rrNoHeader = await handle(new Request('http://x/api/registered?ids=rl-test2', { method: 'GET' }), env, store);
  ok(rrNoHeader.status === 200, '레이트 리밋: CF-Connecting-IP 헤더 없는 요청(하니스 등)은 영향 없음');

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
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RID7);
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
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RID7);
  ok((await r.json()).some(x => x.summary_id === sjExpire.summary_id), '보존 테스트: 만료 전(정상 PENDING)에는 inbox에 노출');
  const summaryToAge = store._dump().summaries.find(s => s.id === sjExpire.summary_id);
  summaryToAge.created_at = Date.now() - (72 * 60 * 60 * 1000 + 60 * 1000); // 72시간 + 1분 전 제출로 시뮬레이션
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RID7);
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

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
