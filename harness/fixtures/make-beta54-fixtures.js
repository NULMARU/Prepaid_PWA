#!/usr/bin/env node
'use strict';
// beta.54 형식 백업 픽스처 생성기 (beta.55 A2) — **예전 앱의 실제 UI**로 백업 파일 4종을 만들어 harness/fixtures/에 남긴다.
//   새 앱(beta.55)이 예전 형식을 계속 읽는지를 prepaid.e2e.js(runBeta55c)가 이 파일들로 검증한다.
//   · beta54-plain.json   — 이력 화면 [백업] (평문 schemaVersion 3, 서명 그림 포함)
//   · beta54-key.json     — 설정 > 자동 등록 > [내 열쇠 백업] (prepaid-key-backup, PBKDF2 12만 회, 암호 FIXTURE_PASS)
//   · beta54-cloud-v1.json — [지금 저장하기]가 서버로 보낸 v1 한 덩어리 blob (+ 목 서버가 돌려줄 restaurant_id·pubKey)
//   · beta54-locked.json  — PIN 분실 복구 화면 [백업 파일이 없어요] → 1차 확인 → 잠긴 최종 백업(prepaid-locked-backup), 2차 확인에서 취소
//   네 파일은 **같은 가게 열쇠** 하나로 만들어진다(열쇠 백업으로 그 열쇠를 들여오면 잠긴 파일·v1 blob이 열린다).
//
//   사용법(워크트리에서): node harness/fixtures/make-beta54-fixtures.js [git-ref]   (기본 ref: HEAD — beta.55 A2 작업 전 커밋)
//   외부 요청 없음 — 중계 서버는 전부 목이고, 서비스워커는 막는다.
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', '..');
const OUT = __dirname;
const REF = process.argv[2] || 'HEAD';
const FIXTURE_PASS = 'fixture-pass-54';
const RID = 'rid-fix54';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
// 1x1 PNG (서명 그림 자리 — 서명 정규식만 통과하면 된다)
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';

async function main() {
  const oldHtml = execFileSync('git', ['show', `${REF}:index.html`], { cwd: root });
  const ver = (String(oldHtml).match(/APP_VERSION='([^']+)'/) || [])[1];
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const name = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
      if (name === '/index.html') { res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(oldHtml); return; }
      const file = path.resolve(root, '.' + name);
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    } catch { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const cors = { 'Access-Control-Allow-Origin': '*' };
  let pubKey = '';
  const cloudPosts = [];
  await context.route('**/api/**', r => r.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"no mock"}' }));
  await context.route('**/api/inbox-count**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not found"}' }));
  await context.route('**/api/challenge**', r => {
    if (!pubKey) return r.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"nf"}' });
    const key = crypto.createPublicKey({ key: Buffer.from(pubKey, 'base64'), format: 'der', type: 'spki' });
    const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from('tok-' + crypto.randomBytes(6).toString('hex')));
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ challenge_ct: ct.toString('base64') }) });
  });
  await context.route('**/api/ledger-backup', r => { cloudPosts.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' }); });
  const page = await context.newPage();
  page.on('dialog', async d => { const m = d.message(); if (d.type() === 'confirm' && m.includes('정말 지울까요')) await d.dismiss(); else await d.accept(); });
  const downloads = [];
  page.on('download', d => downloads.push(d));
  const typePin = async digits => { for (const k of digits) { await page.locator(`[data-a="pin-key"][data-key="${k}"]`).click(); } await page.waitForTimeout(1500); };

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const t0 = Date.now() - 3 * 86400000;
  const emps = [
    { id: 'fx-e1', org: '광진구청', orgKind: 'public', dept: '세무과', name: '김픽스', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t0, updatedAt: t0 },
    { id: 'fx-e2', org: '광진구청', orgKind: 'public', dept: '총무과', name: '이픽스', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t0, updatedAt: t0 }
  ];
  const tx = (id, emp, type, amount, at, extra) => Object.assign({ id, employeeId: emp, type, amount, beforeBalance: 0, afterBalance: 0, reason: type === 'use' ? '서명 확인' : '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', hv: 2, txHash: '', prevHash: '', createdAt: at, occurredAt: 0 }, extra || {});
  const txs = [
    tx('fx-t1', 'fx-e1', 'open', 90000, t0 + 1000), tx('fx-t2', 'fx-e2', 'open', 50000, t0 + 2000),
    tx('fx-t3', 'fx-e1', 'use', 9000, t0 + 3000, { signatureData: SIG, note: '점심' }), tx('fx-t4', 'fx-e2', 'use', 8000, t0 + 4000, { signatureData: SIG }),
    tx('fx-t5', 'fx-e1', 'use', 9000, t0 + 5000, { signatureData: SIG }), tx('fx-t6', 'fx-e1', 'topup', 20000, t0 + 6000, { note: '추가 입금' })
  ];
  await page.evaluate(({ emps, txs, rid, hash }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onsuccess = () => {
      const db = req.result; const t = db.transaction(['meta', 'employees', 'transactions'], 'readwrite'); const ms = t.objectStore('meta'); const now = Date.now();
      [['setupComplete', true], ['welcomeSeen', true], ['termsAgreedAt', now], ['pinHash', hash], ['shopName', '픽스처식당'], ['departments', ['세무과', '총무과']], ['orgName', '광진구청'],
        ['storeRegisterPending', false], ['restaurantId', rid], ['relayStoreName', '픽스처식당'], ['relayRegisteredAt', now], ['districtSyncedAt', now], ['lastMonthlyBackup', '2099-01']].forEach(([k, v]) => ms.put({ key: k, value: v }));
      emps.forEach(e => t.objectStore('employees').put(e)); txs.forEach(x => t.objectStore('transactions').put(x));
      t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  }), { emps, txs, rid: RID, hash: crypto.createHash('sha256').update('1234').digest('hex') });
  // 체인 봉인(앱과 같은 canonical v2)
  await page.evaluate(async () => {
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; }; const str = v => (typeof v === 'string' ? v.trim() : '');
    const hex = b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
    const h = async t => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t))));
    const canon = (t, prev) => 'bapjangbu/tx/v2\n' + JSON.stringify([str(t.id), str(t.employeeId), str(t.type), num(t.amount), num(t.beforeBalance), num(t.afterBalance), t.targetTransactionId ? str(t.targetTransactionId) : '', str(t.signatureHash), str(t.reason), str(t.note), str(prev || ''), num(t.createdAt)]);
    const db = await new Promise((res, rej) => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rows = await new Promise((res, rej) => { const q = db.transaction('transactions').objectStore('transactions').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    rows.sort((a, b) => a.createdAt - b.createdAt); const run = new Map(); let tip = '';
    for (const t of rows) { const b = num(run.get(t.employeeId)); t.beforeBalance = b; t.afterBalance = t.type === 'use' ? b - t.amount : b + t.amount; run.set(t.employeeId, t.afterBalance); }
    for (const t of rows) { if (t.signatureData) t.signatureHash = await h(t.signatureData); t.prevHash = tip; t.txHash = await h(canon(t, tip)); tip = t.txHash; }
    await new Promise((res, rej) => { const t = db.transaction(['transactions', 'meta'], 'readwrite'); rows.forEach(v => t.objectStore('transactions').put(v)); t.objectStore('meta').put({ key: 'chainTip', value: tip }); t.objectStore('meta').put({ key: 'txCount', value: rows.length }); t.oncomplete = res; t.onerror = () => rej(t.error); });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-a="lock-to-pin"], [data-a="pin-key"]', { timeout: 15000 });
  if (await page.locator('[data-a="lock-to-pin"]').count()) await page.locator('[data-a="lock-to-pin"]').click();
  await typePin(['1', '2', '3', '4']);
  await page.waitForSelector('[data-a="screen"][data-screen="settings"]', { timeout: 15000 });
  pubKey = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('pubKey'); q.onsuccess = () => res(q.result && q.result.value); }; }));
  if (!pubKey) throw new Error('no pubKey');
  const waitDl = async n => { for (let i = 0; i < 80 && downloads.length < n; i += 1) await page.waitForTimeout(100); if (downloads.length < n) throw new Error('download missing #' + n); return downloads[n - 1]; };
  const save = async (d, name) => { const p = await d.path(); await fsp.copyFile(p, path.join(OUT, name)); return JSON.parse(await fsp.readFile(path.join(OUT, name), 'utf8')); };

  // ① 평문 백업 — 이력 화면 [백업]
  await page.locator('[data-a="screen"][data-screen="history"]').click();
  await page.locator('[data-a="export"]').click();
  const plain = await save(await waitDl(1), 'beta54-plain.json');
  // ② 내 열쇠 백업
  await page.locator('[data-a="screen"][data-screen="settings"]').click();
  const head = page.locator('.fold-head[data-card="enroll-auto"]');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await page.locator('[data-a="export-key"]').first().click();
  await page.locator('#keyPass1').fill(FIXTURE_PASS); await page.locator('#keyPass2').fill(FIXTURE_PASS);
  await page.locator('[data-a="pass-ok"]').click();
  const keyFile = await save(await waitDl(2), 'beta54-key.json');
  // ③ 서버 v1 blob — [지금 저장하기]
  const ch = page.locator('.fold-head[data-card="cloud"]');
  if ((await ch.getAttribute('aria-expanded')) === 'false') await ch.click();
  const before = cloudPosts.length;
  await page.locator('[data-a="cloud-backup-now"]').click();
  for (let i = 0; i < 80 && cloudPosts.length <= before; i += 1) await page.waitForTimeout(100);
  const post = cloudPosts[cloudPosts.length - 1];
  if (!post || !post.blob) throw new Error('no cloud post');
  await fsp.writeFile(path.join(OUT, 'beta54-cloud-v1.json'), JSON.stringify({ restaurant_id: RID, pubKey, blob: post.blob, blob_hash: post.blob_hash, updated_at: Date.now() }, null, 2));
  // ④ 잠긴 백업 — PIN 분실 복구 화면의 초기화 1차 확인(2차에서 취소 → 아무것도 지우지 않는다)
  await page.locator('[data-a="screen"][data-screen="home"]').click();
  await page.locator('[data-a="hand-to-customer"]').click();
  await page.waitForSelector('[data-a="lock-to-pin"]');
  await page.locator('[data-a="lock-to-pin"]').click();
  await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 300 }));
  await page.locator('[data-a="pin-forgot"]').click();
  await page.waitForTimeout(800);
  await page.locator('[data-a="pin-reset"]').click();
  const locked = await save(await waitDl(3), 'beta54-locked.json');
  const meta = { appVersion: ver, ref: REF, pass: FIXTURE_PASS, restaurant_id: RID, employees: plain.payload.employees.length, transactions: plain.payload.transactions.length, keyType: keyFile.type, lockedType: locked.type, generatedAt: new Date().toISOString() };
  await fsp.writeFile(path.join(OUT, 'beta54-fixtures.meta.json'), JSON.stringify(meta, null, 2));
  console.log('fixtures written:', JSON.stringify(meta));
  await browser.close(); server.close();
}
main().catch(e => { console.error(e); process.exit(1); });
