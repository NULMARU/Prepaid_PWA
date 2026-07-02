// 배포된 실제 서버 상대 엔드투엔드 데모.
//   node harness/phase2.live.mjs https://prepaid-relay.<계정>.workers.dev
const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) { console.error('사용법: node harness/phase2.live.mjs <서버URL>'); process.exit(1); }
const subtle = globalThis.crypto.subtle, encU = new TextEncoder(), decU = new TextDecoder();
const b64 = b => { let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i++)s += String.fromCharCode(u[i]); return btoa(s); };
const unb64 = s => { const x = atob(s), u = new Uint8Array(x.length); for (let i = 0; i < x.length; i++)u[i] = x.charCodeAt(i); return u.buffer; };
const sha = async s => { const h = await subtle.digest('SHA-256', encU.encode(s)); return Array.from(new Uint8Array(h)).map(v => v.toString(16).padStart(2, '0')).join(''); };
// 매 실행 고유 RID: 서버의 재등록 409·중복제출(batch_hash) 멱등 규칙과 충돌하지 않게 함
const RID = 'DEMO-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + m); };
const jf = async (p, opt) => { const r = await fetch(BASE + p, opt); return { r, j: await r.json().catch(() => null) }; };

const kp = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
const spki = b64(await subtle.exportKey('spki', kp.publicKey));
ok((await jf('/api/register-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: RID, restaurant_name: '데모김밥', public_key: spki }) })).r.ok, '공개키 등록');

const { j: pk } = await jf('/api/public-key?restaurant_id=' + RID);
const pub = await subtle.importKey('spki', unb64(pk.public_key), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
const items = [{ name: '김철수', dept: '세무과', amount: 90000 }, { name: '김철수', dept: '세무과', amount: 90000 }, { name: '이순신', dept: '세무과', amount: 90000 }];
const bh = await sha(items.map(i => i.name + '|' + i.dept + '|' + i.amount).sort().join('\n'));
const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, encU.encode(JSON.stringify({ v: 1, items })));
const encKey = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, await subtle.exportKey('raw', aes));
const blob = { alg: 'RSA-OAEP-2048+AES-256-GCM', encKey: b64(encKey), iv: b64(iv), ct: b64(ct) };
const { r: subR, j: sub } = await jf('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: { institution: '서울특별시 강남구', department: '세무과', restaurant_id: RID, restaurant_name: '데모김밥', year_month: '2026-07', total_amount: 270000, member_count: 3, batch_hash: bh }, blob: { restaurant_id: RID, ciphertext: blob }, consent: { institution: '서울특별시 강남구', department: '세무과', year_month: '2026-07' } }) });
ok(subR.ok && sub.summary_id, '담당자 암호화 제출');

const { j: inbox } = await jf('/api/inbox?restaurant_id=' + RID);
const mine = inbox.find(x => x.summary_id === sub.summary_id);
ok(mine && !JSON.stringify(mine.summary).includes('김철수'), '수신함(이름 미노출, 총액·인원만)');
const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, unb64(mine.ciphertext.encKey));
const ak = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
const plain = JSON.parse(decU.decode(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(unb64(mine.ciphertext.iv)) }, ak, unb64(mine.ciphertext.ct))));
ok(plain.items.length === 3 && (await sha(plain.items.map(i => i.name + '|' + i.dept + '|' + i.amount).sort().join('\n'))) === mine.summary.batch_hash, '음식점 앱 복호화 + batch_hash 일치');

// 소유 증명(챌린지-응답): 서버가 등록된 공개키로 무작위 토큰을 봉인해 돌려주면,
// 개인키로 복호화해 얻은 문자열을 그대로 auth_token으로 실어 보호 엔드포인트를 호출한다.
async function getAuthToken(privateKey) {
  const { j: ch } = await jf('/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: RID }) });
  const pt = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, unb64(ch.challenge_ct));
  return decU.decode(pt);
}

const approveToken = await getAuthToken(kp.privateKey);
ok((await jf('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary_id: sub.summary_id, status: 'APPROVED', restaurant_id: RID, auth_token: approveToken }) })).r.ok, '승인(소유 증명 통과)');
ok((await jf('/api/inbox?restaurant_id=' + RID)).j.length === 0, '승인 후 수신함 비워짐');
// 데모용 키 정리(검증 항목 아님 — 실패해도 무시)
const deregToken = await getAuthToken(kp.privateKey).catch(() => null);
await jf('/api/deregister', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: RID, auth_token: deregToken }) }).catch(() => {});

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
