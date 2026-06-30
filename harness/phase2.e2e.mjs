// 다자간 연동 엔드투엔드 검증 (Cloudflare/실키 불필요).
// 실제 Worker 로직(handle) + 메모리 store + 목 LOCALDATA로 암호 전 구간 증명.
import { handle, makeMemoryStore } from '../server/src/worker.js';

const subtle = globalThis.crypto.subtle;
const encU = new TextEncoder(), decU = new TextDecoder();
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + m); };

// ── 공유 crypto (PROTOCOL §2·§3, 웹/앱과 동일) ──
function b64(buf){let s='';const b=new Uint8Array(buf);for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s)}
function unb64(s){const x=atob(s),u=new Uint8Array(x.length);for(let i=0;i<x.length;i++)u[i]=x.charCodeAt(i);return u.buffer}
async function sha256hex(str){const h=await subtle.digest('SHA-256',encU.encode(str));return Array.from(new Uint8Array(h)).map(v=>v.toString(16).padStart(2,'0')).join('')}
async function batchHash(items){return sha256hex(items.map(i=>i.name+'|'+i.dept+'|'+i.amount).sort().join('\n'))}
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

(async () => {
  const store = makeMemoryStore();
  const RID = 'MGT-0001';
  const env = {
    ALLOW_ORIGIN: '*',
    // 목 LOCALDATA: 실제 키/엔드포인트 대체
    searchRestaurants: async (_env, region, q) => {
      const all = [
        { restaurant_id: 'MGT-0001', name: '정식김밥', address: '서울 강남구 1', status: '영업/정상' },
        { restaurant_id: 'MGT-0002', name: '한밭식당', address: '서울 강남구 2', status: '영업/정상' }
      ];
      return all.filter(r => region && (!q || r.name.includes(q)));
    }
  };

  // 1) 음식점 앱: 키페어 생성 → 공개키 등록
  const kp = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['encrypt','decrypt']);
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

  // 5) 음식점 앱: 수신함 폴링 → 표시(이름 미열람) → 승인 → 복호화 → batch_hash 대조 → 동명이인 보완
  r = await call(store, env, 'GET', '/api/inbox?restaurant_id=' + RID);
  const inbox = await r.json();
  ok(inbox.length === 1 && inbox[0].summary.member_count === 3 && inbox[0].summary.total_amount === 270000, '수신함: 부서·총액·인원만 노출(이름 ❌)');

  // 승인
  r = await call(store, env, 'POST', '/api/approve', { summary_id: inbox[0].summary_id, status: 'APPROVED' });
  ok(r.status === 200, '개별 승인 200');

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

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
