#!/usr/bin/env node
'use strict';
/**
 * 밥장부 업그레이드 보존 검증 하니스 (읽기 전용 — 리포 파일을 만들거나 고치지 않는다)
 *
 * 목적: 필드테스트 태블릿이 <OLD>에서 <NEW>로 갱신될 때 기기에 저장된
 *       직원·거래·설정(IndexedDB)이 원소 단위로 그대로 남는지 실브라우저로 증명한다.
 *
 * 사용: node upgrade.e2e.js --old <old.html> --new <new.html> --label beta.47→beta.50
 *
 * 방법:
 *   · 로컬 정적 서버가 리포 루트를 서빙하되 /old.html·/index.html 만 스냅샷 HTML로 바꿔치기한다.
 *     (IndexedDB는 origin 단위 — 경로가 달라도 같은 DB를 본다)
 *   · /sw.js 는 404 — 서비스워커 캐시가 두 버전 사이에 끼지 못하게.
 *   · 중계 서버(/api/**)는 전부 목.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
// (OUT 계산용 최소 인자 파서 — 아래 arg()와 같은 규칙)
function arg0(n, d) { const a = process.argv.slice(2), i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : d; }

const REPO = path.resolve(__dirname, "..", "..");
// 산출물(스냅샷·보고서)은 리포 밖에 둔다 — 인자 --out 으로 바꿀 수 있다.
const OUT = arg0("out", path.join(require("os").tmpdir(), "bapjangbu-upgrade"));
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const OLD_FILE = arg('old', path.join(OUT, 'old-beta47.html'));
const NEW_FILE = arg('new', path.join(OUT, 'new-beta50.html'));
const LABEL = arg('label', 'old→new');
const SLUG = arg('slug', 'run');
// --sw 1 : 실제 태블릿과 같은 경로 — 서비스워커를 살려 두고 구→신 배포를 흉내 낸다.
//          (기본 모드는 /sw.js를 404로 막아 SW 캐시를 배제한 순수 데이터 보존 검증)
const SW_MODE = arg('sw', '') === '1';
const OLD_SW = arg('oldsw', path.join(OUT, 'sw-beta47.js'));
const NEW_SW = arg('newsw', path.join(OUT, 'sw-beta50.js'));

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8'
};

// ── 결과 표 ────────────────────────────────────────────────────────────────────
const results = [];   // {id, title, ok, detail}
const notes = [];
function check(id, title, ok, detail) {
  results.push({ id, title, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${title}${detail ? '\n        ' + String(detail).slice(0, 2000) : ''}`);
  return !!ok;
}

function startServer(oldHtml, newHtml, oldSw, newSw) {
  // SW 모드에서는 "배포"를 흉내 내려고 서버가 내주는 내용을 도중에 갈아끼운다.
  const live = { index: SW_MODE ? oldHtml : newHtml, sw: oldSw, deployed: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    if (p === '/sw.js') {
      if (!SW_MODE) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('blocked by harness'); return; }
      res.writeHead(200, { 'Content-Type': mime['.js'], 'Cache-Control': 'no-cache' }); res.end(live.sw); return;
    }
    if (p === '/old.html') { res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(oldHtml); return; }
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(live.index); return; }
    try {
      const file = path.resolve(REPO, '.' + decodeURIComponent(p));
      if (!file.startsWith(REPO)) { res.writeHead(403); res.end('no'); return; }
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, live, deploy: () => { live.index = newHtml; live.sw = newSw; live.deployed = true; } })));
}

// ── IndexedDB 직접 읽기 (harness/prepaid.e2e.js 188행과 같은 방식) ───────────────
async function readDb(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject((req.error && req.error.message) || 'IndexedDB open failed');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['employees', 'transactions', 'meta'], 'readonly');
      const read = store => new Promise((res, rej) => {
        const q = tx.objectStore(store).getAll();
        q.onsuccess = () => res(q.result || []);
        q.onerror = () => rej(q.error);
      });
      Promise.all([read('employees'), read('transactions'), read('meta')])
        .then(([employees, transactions, meta]) => resolve({ employees, transactions, meta }))
        .catch(reject);
    };
  }));
}

const byId = rows => rows.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
const metaMap = rows => rows.reduce((a, r) => (a[r.key] = r.value, a), {});
const j = v => JSON.stringify(v);

async function typePin(page, digits) {
  for (let i = 0; i < digits.length; i += 1) {
    await page.locator(`[data-a="pin-key"][data-key="${digits[i]}"]`).click();
    if ((i + 1) % 4 === 0) {
      await page.waitForFunction(() => {
        const H = window.__prepaidTestHooks;
        return !H || !H.lockState || H.lockState().pinLen === 0;
      }, null, { timeout: 20000 }).catch(() => {});
    }
  }
}

async function openSettingsCard(page, key) {
  const head = page.locator(`.fold-head[data-card="${key}"]`);
  await head.waitFor({ timeout: 8000 });
  if ((await head.getAttribute('aria-expanded')) === 'false') { await head.click(); await page.waitForTimeout(120); }
}

async function drawSignature(page) {
  const box = await page.locator('#signCanvas').boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.3, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.8, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.35, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

(async () => {
  const oldHtml = await fsp.readFile(OLD_FILE, 'utf8');
  const newHtml = await fsp.readFile(NEW_FILE, 'utf8');
  const oldVer = (oldHtml.match(/APP_VERSION='([^']+)'/) || [])[1];
  const newVer = (newHtml.match(/APP_VERSION='([^']+)'/) || [])[1];
  console.log(`\n=== 업그레이드 보존 검증: ${LABEL}  (old=${oldVer}  new=${newVer}) ===\n`);

  const oldSw = SW_MODE ? await fsp.readFile(OLD_SW, 'utf8') : '';
  const newSw = SW_MODE ? await fsp.readFile(NEW_SW, 'utf8') : '';
  const { server, port, deploy } = await startServer(oldHtml, newHtml, oldSw, newSw);
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
  });

  // ── 중계 서버 목 ───────────────────────────────────────────────────────────────
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const storeResults = [
    { restaurant_id: 'rid-other-9', name: '남의 김밥', address: '서울특별시 강남구 역삼동 1-1', tel: '02-000-0000' },
    { restaurant_id: 'rid-upgrade-1', name: '업그레이드식당', address: '서울특별시 광진구 아차산로 399, 1층 B호 (구의동)', tel: '02-444-5555' }
  ];
  let capturedPubKey = '';
  const registerBodies = [];
  const contactBodies = [];
  await context.route('**/api/**', r => r.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
  await context.route('**/api/restaurants**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(storeResults) }));
  await context.route('**/api/registered**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
  await context.route('**/api/inbox-count**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not found"}' }));
  await context.route('**/api/register-key**', r => {
    const b = JSON.parse(r.request().postData() || '{}');
    registerBodies.push(b);
    if (b.public_key) capturedPubKey = b.public_key;
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
  });
  // 소유증명 챌린지: 앱의 공개키(SPKI)로 nonce를 RSA-OAEP(SHA-256) 암호화해 돌려준다.
  let lastNonce = '';
  const issuedNonces = new Set();
  await context.route('**/api/challenge**', r => {
    if (!capturedPubKey) return r.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"no pubkey"}' });
    lastNonce = 'nonce-' + crypto.randomBytes(8).toString('hex');
    issuedNonces.add(lastNonce);
    const key = crypto.createPublicKey({ key: Buffer.from(capturedPubKey, 'base64'), format: 'der', type: 'spki' });
    const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(lastNonce, 'utf8'));
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ challenge_ct: ct.toString('base64') }) });
  });
  await context.route('**/api/ledger-backup**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true,"updated_at":"2026-09-01T00:00:00Z"}' }));
  await context.route('**/api/contact**', r => {
    contactBodies.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
  });

  const page = await context.newPage();
  const dialogs = [];
  let promptAnswer = '';
  page.on('dialog', async d => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === 'prompt') await d.accept(promptAnswer);
    else await d.accept();
  });
  // 콘솔 수집 — 단계(phase)별로 나눠 담아 "갱신 직후 오류 0"을 따로 볼 수 있게.
  let phase = 'old';
  const consoleLog = [];
  page.on('pageerror', e => consoleLog.push({ phase, type: 'pageerror', text: e.message }));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) consoleLog.push({ phase, type: m.type(), text: m.text() }); });
  const downloads = [];
  page.on('download', async d => {
    try {
      const p = await d.path();
      downloads.push({ name: d.suggestedFilename(), bytes: p ? (await fsp.stat(p)).size : 0, path: p });
    } catch (e) { downloads.push({ name: d.suggestedFilename(), error: e.message }); }
  });

  const fail = (id, title, e) => check(id, title, false, `EXCEPTION: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);

  let snapA = null, snapB = null;
  try {
    // ══════════════════════════════════════════════════════════════════════════
    // 1) 구버전 앱에서 실제 UI로 데이터 만들기
    // ══════════════════════════════════════════════════════════════════════════
    const START_URL = SW_MODE ? `${origin}/index.html?e2e=1` : `${origin}/old.html?e2e=1`;
    await page.goto(START_URL, { waitUntil: 'load' });
    await page.waitForSelector('[data-a="setup-welcome-start"], #setupStoreName', { timeout: 15000 });
    if (SW_MODE) {
      // 구버전 서비스워커가 실제로 설치·활성화되어 앱 셸을 캐시한 상태에서 시작한다.
      await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
      const sw = await page.evaluate(async () => {
        const keys = await caches.keys();
        return { controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller), caches: keys };
      });
      check('W1', '구버전 서비스워커 설치·활성화(앱 셸 캐시 생성)', sw.controller && sw.caches.some(k => /beta\./.test(k)),
        `controller=${sw.controller}, caches=${j(sw.caches)}`);
    }
    // 자동 잠금(90초)이 긴 시나리오 중간에 끼어들지 않게 테스트 훅으로만 늘린다(프로덕션 상수 불변).
    await page.evaluate(() => { try { Object.assign(window.__prepaidTestHooks.TIMERS, { autoLock: 3600000, custIdle: 3600000, ownerPinIdle: 3600000, modalIdleCap: 3600000 }); } catch (e) {} });

    if (await page.locator('[data-a="setup-welcome-start"]').count()) {
      await page.locator('[data-a="setup-welcome-start"]').click();
      await page.waitForSelector('#setupStoreName', { timeout: 8000 });
    }
    // 1/3 가게 검색 → 선택
    await page.locator('#setupStoreName').fill('업그레이드식당');
    await page.locator('[data-a="setup-store-search"]').click();
    await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 10000 });
    await page.locator('[data-a="setup-store-pick"]').nth(1).click();
    await page.waitForSelector('[data-a="setup-next"]', { timeout: 8000 });
    await page.locator('[data-a="setup-next"]').click();
    // 2/3 부서
    await page.waitForSelector('#agencySelectSetup', { timeout: 10000 });
    await page.locator('[data-a="agency-add-all"][data-ctx="setup"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-a="setup-to-contact"]').click();
    // 3/3 연락처 + 약관
    await page.waitForSelector('#setupContactKakao', { timeout: 8000 });
    await page.locator('#setupContactKakao').fill('https://open.kakao.com/o/sUpgrade');
    await page.locator('#setupContactEmail').fill('shop@example.com');
    await page.locator('#setupTermsChk').check();
    await page.locator('[data-a="setup-complete"]').click();
    // PIN 새로 설정 (4자리 두 번)
    await page.waitForSelector('[data-a="pin-key"]', { timeout: 10000 });
    await typePin(page, ['2', '5', '8', '1', '2', '5', '8', '1']);
    await page.waitForSelector('[data-a="guide-dismiss"]', { timeout: 15000 });
    await page.locator('[data-a="guide-dismiss"]').click();
    await page.waitForTimeout(200);
    await page.evaluate(() => { try { Object.assign(window.__prepaidTestHooks.TIMERS, { autoLock: 3600000, custIdle: 3600000, ownerPinIdle: 3600000, modalIdleCap: 3600000 }); } catch (e) {} });
    check('S1', '구버전 온보딩 3단계 + 서버 등록 완료', registerBodies.length === 1 && registerBodies[0].restaurant_id === 'rid-upgrade-1',
      `register-key ${registerBodies.length}회, rid=${registerBodies[0] && registerBodies[0].restaurant_id}, district=${registerBodies[0] && registerBodies[0].district}`);

    // ── 직원 ① 한 명씩 등록 (공공기관) ───────────────────────────────────────────
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForTimeout(250);
    await openSettingsCard(page, 'enroll-manual');
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empName', { timeout: 8000 });
    await page.locator('#empOrg').fill('광진구청');
    await page.locator('#empDept').fill('재무과');
    await page.locator('#empName').fill('김철수');
    await page.locator('#empOpen').fill('50000');
    await page.locator('#empNote').fill('구청 서무 전달');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(350);

    // ── 직원 ②③ CSV 명단 — 같은 소속·부서·이름 2행 → 동명이인 마커('·2') 생성 경로 ──
    const csvBody = '﻿소속,부서,이름,금액\r\n한빛물산,총무부,이영희,30000\r\n한빛물산,총무부,이영희,20000\r\n';
    await page.locator('#csvFile').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(csvBody, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 8000 });
    await page.locator('[data-a="exec-csv"]').click();
    await page.waitForTimeout(500);

    let db = await readDb(page);
    const emp = name => db.employees.find(e => e.name === name);
    const e1 = emp('김철수'), e2 = emp('이영희'), e3 = emp('이영희·2');
    check('S2', `구버전에서 직원 3명 생성 (동명이인 마커 포함)`, !!(e1 && e2 && e3) && db.employees.length === 3,
      `employees=${db.employees.length} :: ${db.employees.map(e => `${e.org}/${e.dept}/${e.name}`).join(' , ')}`);
    if (!(e1 && e2 && e3)) throw new Error('직원 생성 실패 — 이후 시나리오 진행 불가');

    // ── 담당자 직접 전달 파일(.json) 열기 — meta.receivedBatchLog(수신 배치 로그)를 만드는 유일한 경로 ──
    //    기존 직원과 소속·부서·이름이 같으므로 신규 카드가 아니라 '충전'으로 붙는다(직원 수 3명 유지).
    const dtJson = await page.evaluate(async ({ pubKey, rid }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const items = [{ name: '이영희', dept: '총무부', amount: 5000, payer: '한빛물산' }];
      const h = async t => { const d = await crypto.subtle.digest('SHA-256', enc.encode(String(t))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
      const aesRaw = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
      return JSON.stringify({
        v: 1, type: 'direct-transfer', restaurant_id: rid, restaurant_name: '업그레이드식당',
        institution: '한빛물산', department: '총무부', year_month: '2026-09',
        summary: { total_amount: 5000, member_count: 1, batch_hash },
        ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
      });
    }, { pubKey: capturedPubKey, rid: 'rid-upgrade-1' });
    await page.locator('#directTransferFile').setInputFiles({ name: 'transfer.json', mimeType: 'application/json', buffer: Buffer.from(dtJson, 'utf8') });
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1200);
    db = await readDb(page);
    const rbl = db.meta.find(m => m.key === 'receivedBatchLog');
    check('S2b', '담당자 직접 전달 수신 → meta.receivedBatchLog 기록 (직원 수 3명 유지)',
      !!(rbl && Array.isArray(rbl.value) && rbl.value.length === 1) && db.employees.length === 3,
      `receivedBatchLog=${JSON.stringify(rbl && rbl.value)}, 직원 ${db.employees.length}명`);

    // ── 전화번호 저장(기기 로컬 AES) — 직원 ① (설정 > 직원 목록 관리의 번호 등록) ──
    await openSettingsCard(page, 'employees');
    // 직원 목록 관리는 부서 그룹 아코디언(▶/▼) — 접힌 그룹만 골라 전부 펼친다.
    for (let i = 0; i < 30; i += 1) {
      const collapsed = page.locator('.mgr-head:has(.mgr-toggle:text-is("▶"))');
      if (await collapsed.count() === 0) break;
      await collapsed.first().click();
      await page.waitForTimeout(120);
    }
    await page.locator(`[data-a="emp-phone-edit"][data-id="${e1.id}"]`).waitFor({ timeout: 10000 });
    promptAnswer = '01012345678';
    await page.locator(`[data-a="emp-phone-edit"][data-id="${e1.id}"]`).click();
    await page.waitForTimeout(600);
    // 문자 동의 스위치가 따로 있으면 켠다(없으면 setPhone이 이미 consent=true).
    const consentBtn = page.locator(`[data-a="emp-phone-consent"][data-id="${e1.id}"]`);
    if (await consentBtn.count()) {
      const need = await page.evaluate(id => {
        const el = document.querySelector(`[data-a="emp-phone-consent"][data-id="${id}"]`);
        return el ? el.innerText : '';
      }, e1.id);
      notes.push(`문자 동의 버튼 라벨: ${JSON.stringify(need)}`);
    }
    db = await readDb(page);
    const e1phone = db.employees.find(e => e.id === e1.id);
    check('S3', '직원 ①에 전화번호 저장(기기 로컬 AES 암호문)', !!(e1phone && e1phone.phone && e1phone.phoneConsent),
      `phone ciphertext len=${e1phone && e1phone.phone ? e1phone.phone.length : 0}, consent=${e1phone && e1phone.phoneConsent}`);

    const expandMgr = async () => {
      for (let i = 0; i < 30; i += 1) {
        const collapsed = page.locator('.mgr-head:has(.mgr-toggle:text-is("▶"))');
        if (await collapsed.count() === 0) break;
        await collapsed.first().click(); await page.waitForTimeout(120);
      }
    };
    // ── 충전 (직원 ①) — 설정 > 직원 목록 관리의 [충전] ──────────────────────────
    await expandMgr();
    await page.locator(`[data-a="topup"][data-id="${e1.id}"]`).click();
    await page.waitForSelector('#topupAmount', { timeout: 8000 });
    await page.locator('#topupAmount').fill('12000');
    if (await page.locator('#topupReason').count()) await page.locator('#topupReason').fill('9월 추가 선금');
    await page.locator('[data-a="save-topup"]').click();
    await page.waitForTimeout(700);

    // ── 잔액 조정 (직원 ③) — 같은 카드의 [조정] ─────────────────────────────────
    await expandMgr();
    await page.locator(`[data-a="adjust"][data-id="${e3.id}"]`).click();
    await page.waitForSelector('#adjustBalance', { timeout: 8000 });
    await page.locator('#adjustBalance').fill('18500');
    await page.locator('#adjustReason').fill('현금 반환 1,500원');
    await page.locator('[data-a="save-adjust"]').click();
    await page.waitForTimeout(700);

    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(300);
    await page.evaluate(() => { try { Object.assign(window.__prepaidTestHooks.TIMERS, { autoLock: 3600000 }); } catch (e) {} });
    // 홈 그룹 펼치기
    for (let i = 0; i < 20; i += 1) {
      const c = page.locator('.group-head[aria-expanded="false"]');
      if (await c.count() === 0) break;
      await c.first().click(); await page.waitForTimeout(60);
    }

    // ── 사용 등록 (직원 ②, 서명 + 비고 + 소급 날짜) ─────────────────────────────
    const bdYmd = await page.evaluate(() => { const d = new Date(Date.now() - 5 * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    await page.locator(`[data-a="use"][data-id="${e2.id}"]`).click();
    await page.waitForSelector('#useAmount', { timeout: 8000 });
    await page.locator('#useAmount').fill('7000');
    await page.locator('#useNote').fill('점심 정식 2인');
    await page.locator('#useDate').fill(bdYmd);
    await drawSignature(page);
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(700);
    // 저장 직후 증표가 자동으로 열린다 — 닫는다.
    if (await page.locator('.receipt-modal').count()) { await page.locator('.receipt-modal [data-a="close-modal"]').click(); await page.waitForTimeout(150); }

    // ── 사용 등록 후 취소(void) — 직원 ① ─────────────────────────────────────────
    await page.locator(`[data-a="use"][data-id="${e1.id}"]`).click();
    await page.waitForSelector('#useAmount', { timeout: 8000 });
    await page.locator('#useAmount').fill('3000');
    await page.locator('#useNote').fill('취소될 건');
    await drawSignature(page);
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(700);
    if (await page.locator('.receipt-modal').count()) { await page.locator('.receipt-modal [data-a="close-modal"]').click(); await page.waitForTimeout(150); }
    db = await readDb(page);
    const toVoid = db.transactions.filter(t => t.type === 'use' && t.employeeId === e1.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    await page.locator('[data-a="screen"][data-screen="history"]').click();
    await page.waitForTimeout(300);
    promptAnswer = '손님 요청으로 취소';
    await page.locator(`[data-a="void"][data-id="${toVoid.id}"]`).click();
    await page.waitForTimeout(500);

    // ── 부서 1개 추가 ───────────────────────────────────────────────────────────
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForTimeout(250);
    await openSettingsCard(page, 'depts');
    await page.locator('#newDeptInput').fill('검증과');
    await page.locator('[data-a="add-dept"]').click();
    await page.waitForTimeout(400);

    // ── 가게 연락처(카톡 링크) 저장 — 서버 소유증명 경유(목 200) ──────────────────
    await openSettingsCard(page, 'contact');
    await page.locator('#contactKakao').fill('https://open.kakao.com/o/sUpgradeSaved');
    await page.locator('[data-a="contact-save"]').click();
    await page.waitForTimeout(1200);
    const lastContact = contactBodies[contactBodies.length - 1];
    check('S4', '연락처 저장이 서버 소유증명(challenge)을 타고 200으로 완료', !!lastContact
      && issuedNonces.has(lastContact.auth_token) && lastContact.kakao_link === 'https://open.kakao.com/o/sUpgradeSaved',
      `contact 호출 ${contactBodies.length}회 (${contactBodies.map(b => b.kakao_link).join(' , ')}), 마지막 auth_token이 발급 nonce와 일치=${!!lastContact && issuedNonces.has(lastContact.auth_token)}`);

    // ── 로컬 백업(장부 안전 저장) 1회 ───────────────────────────────────────────
    await openSettingsCard(page, 'ledger');
    downloads.length = 0;
    await page.locator('[data-a="export-safe"]').click();
    await page.waitForTimeout(2500);
    check('S5', '로컬 백업 파일 저장(CSV + JSON)', downloads.length >= 2 && downloads.every(d => d.bytes > 0),
      downloads.map(d => `${d.name} (${d.bytes}B)`).join(' , '));
    for (const d of downloads) {
      if (d.path) await fsp.copyFile(d.path, path.join(OUT, `${SLUG}-${d.name}`)).catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 2) 스냅샷 A
    // ══════════════════════════════════════════════════════════════════════════
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(800);
    snapA = await readDb(page);
    const homeTextA = await page.locator('.app').innerText();
    const balancesA = await page.evaluate(() => {
      const H = window.__prepaidTestHooks;
      return null; // 잔액은 아래 DB derive로 계산한다(훅 의존 없이)
    });
    await fsp.writeFile(path.join(OUT, `${SLUG}-snapshot-A.json`), JSON.stringify(snapA, null, 2));

    // ══════════════════════════════════════════════════════════════════════════
    // 3) 업그레이드 — 같은 origin에서 새 버전으로 이동 + 새로고침
    // ══════════════════════════════════════════════════════════════════════════
    const consoleBeforeUpgrade = consoleLog.length;
    phase = 'upgrade';
    if (SW_MODE) {
      // ── 실제 배포 순간: 서버가 내주는 index.html·sw.js가 새 버전으로 바뀐다 ──
      deploy();
      let loads = 0, got = false;
      for (; loads < 5 && !got; loads += 1) {
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(2000);
        got = (await page.content()).includes(`APP_VERSION='${newVer}'`);
      }
      const swAfter = await page.evaluate(async () => ({ caches: await caches.keys() }));
      check('W2', '배포 후 새 버전 HTML이 서비스워커를 통과해 실제로 로드됨', got,
        `새로고침 ${loads}회 만에 ${newVer} 로드=${got}, 남은 캐시=${j(swAfter.caches)}`);
    } else {
      await page.goto(`${origin}/index.html?e2e=1`, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(1500);
    }
    const verNow = await page.evaluate(() => {
      const m = document.body.innerText.match(/1\.0\.0-beta\.\d+/); return m ? m[0] : '';
    });
    // 잠금 화면 → 사장님용 잠금 해제 → 같은 PIN
    const lockShown = await page.locator('.cust-screen, [data-a="lock-to-pin"]').count();
    if (await page.locator('[data-a="lock-to-pin"]').count()) await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]', { timeout: 10000 });
    await typePin(page, ['2', '5', '8', '1']);
    await page.waitForSelector('[data-a="screen"][data-screen="settings"]', { timeout: 15000 });
    await page.waitForTimeout(900);
    await page.evaluate(() => { try { Object.assign(window.__prepaidTestHooks.TIMERS, { autoLock: 3600000, custIdle: 3600000, ownerPinIdle: 3600000, modalIdleCap: 3600000 }); } catch (e) {} });
    check('S6', '새 버전 로드 + 같은 PIN으로 잠금 해제', lockShown > 0 && (await page.locator('[data-a="screen"][data-screen="home"]').count()) > 0,
      `잠금화면 노출=${lockShown > 0}, 앱 버전 문자열=${verNow || '(화면 미표시)'}`);

    phase = 'after';
    snapB = await readDb(page);
    await fsp.writeFile(path.join(OUT, `${SLUG}-snapshot-B.json`), JSON.stringify(snapB, null, 2));

    // ══════════════════════════════════════════════════════════════════════════
    // (a) 원소 단위 동일성
    // ══════════════════════════════════════════════════════════════════════════
    const empA = byId(snapA.employees), empB = byId(snapB.employees);
    const txA = byId(snapA.transactions), txB = byId(snapB.transactions);
    const empDiff = [];
    if (empA.length !== empB.length) empDiff.push(`직원 수 ${empA.length} → ${empB.length}`);
    for (let i = 0; i < Math.min(empA.length, empB.length); i += 1) {
      const a = empA[i], b = empB[i];
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      for (const k of keys) if (j(a[k]) !== j(b[k])) empDiff.push(`emp ${a.id || b.id} .${k}: ${j(a[k])} → ${j(b[k])}`);
    }
    const txDiff = [];
    if (txA.length !== txB.length) txDiff.push(`거래 수 ${txA.length} → ${txB.length}`);
    for (let i = 0; i < Math.min(txA.length, txB.length); i += 1) {
      const a = txA[i], b = txB[i];
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      for (const k of keys) if (j(a[k]) !== j(b[k])) txDiff.push(`tx ${a.id || b.id} .${k}: ${j(a[k])} → ${j(b[k])}`);
    }
    check('a1', '직원 레코드 전 필드 동일', empDiff.length === 0, empDiff.slice(0, 20).join('\n        ') || `직원 ${empA.length}건 전 필드 일치`);
    check('a2', '거래 레코드 전 필드 동일(txHash·prevHash·signatureData·note·occurredAt 포함)', txDiff.length === 0,
      txDiff.slice(0, 20).join('\n        ') || `거래 ${txA.length}건 전 필드 일치`);

    const mA = metaMap(snapA.meta), mB = metaMap(snapB.meta);
    const metaDiff = [];
    for (const k of Object.keys(mA)) if (j(mA[k]) !== j(mB[k])) metaDiff.push(`meta.${k}: ${j(mA[k]).slice(0, 120)} → ${j(mB[k]).slice(0, 120)}`);
    const watch = ['restaurantId', 'relayRegisteredAt', 'shopName', 'shopAddr', 'shopTel', 'storeAddr', 'departments', 'pinHash', 'deviceSecret', 'privKeyWrapped', 'pubKey', 'receivedBatchLog', 'contactKakaoLink', 'contactEmail', 'chainTip', 'txCount', 'setupComplete', 'termsAgreedAt', 'districtSyncedAt', 'keyCreatedAt', 'orgName', 'lastBackupAt'];
    const watchDiff = watch.filter(k => j(mA[k]) !== j(mB[k])).map(k => `meta.${k}: ${j(mA[k]).slice(0, 120)} → ${j(mB[k]).slice(0, 120)}`);
    check('a3', 'meta 핵심 키(가게·열쇠·PIN·부서·체인앵커) 값 동일', watchDiff.length === 0, watchDiff.join('\n        ') || `핵심 키 ${watch.filter(k => k in mA).length}개 일치`);
    const newKeys = ['approvedSummaryLog', 'pendingNotify', 'receivedTransferLog', 'storeRegisterBlocked'];
    const newKeyState = newKeys.map(k => `${k}=${k in mB ? j(mB[k]) : '(없음)'}`);
    const newKeyOk = newKeys.every(k => !(k in mB) || mB[k] === null || mB[k] === undefined || j(mB[k]) === '[]' || j(mB[k]) === '{}' || mB[k] === '');
    check('a4', '새 버전 전용 meta 키는 없거나 빈 값', newKeyOk, newKeyState.join(' , '));
    const addedKeys = Object.keys(mB).filter(k => !(k in mA));
    const removedKeys = Object.keys(mA).filter(k => !(k in mB));
    check('a5', 'meta 키 집합 변화(추가/삭제) 보고', removedKeys.length === 0,
      `추가=${addedKeys.length ? addedKeys.join(',') : '없음'} / 삭제=${removedKeys.length ? removedKeys.join(',') : '없음'}` +
      (metaDiff.length ? `\n        전체 값 변화: ${metaDiff.join(' ; ')}` : '\n        전체 값 변화: 없음'));

    // ══════════════════════════════════════════════════════════════════════════
    // (b) 홈 화면 — 직원 3명 · 잔액 · 동명이인 마커
    // ══════════════════════════════════════════════════════════════════════════
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(400);
    for (let i = 0; i < 20; i += 1) {
      const c = page.locator('.group-head[aria-expanded="false"]');
      if (await c.count() === 0) break;
      await c.first().click(); await page.waitForTimeout(60);
    }
    const homeTextB = await page.locator('.app').innerText();
    // 장부에서 직접 계산한 잔액(표시 계층과 독립)
    const balOf = (snap, id) => snap.transactions.filter(t => t.employeeId === id)
      .reduce((s, t) => s + (t.type === 'use' ? -Number(t.amount) : Number(t.amount)), 0);
    const balA = {}, balB = {};
    for (const e of empA) { balA[e.name] = balOf(snapA, e.id); balB[e.name] = balOf(snapB, e.id); }
    const cardCount = await page.locator('.card.employee').count();
    const money = n => n.toLocaleString('en-US');
    const shownAll = empB.every(e => homeTextB.includes(e.name) && homeTextB.includes(money(balB[e.name])));
    check('b1', '홈에 직원 3명 + 잔액이 A와 같게 표시', cardCount === 3 && shownAll && j(balA) === j(balB),
      `카드 ${cardCount}개 / 잔액 A=${j(balA)} B=${j(balB)} / 화면표시=${shownAll}`);
    check('b2', '동명이인 마커(·2) 유지', homeTextB.includes('이영희·2') && homeTextB.includes('이영희'),
      `'이영희' 표시=${homeTextB.includes('이영희')}, '이영희·2' 표시=${homeTextB.includes('이영희·2')}`);

    // ══════════════════════════════════════════════════════════════════════════
    // (c) 장부 검사(무결성)
    // ══════════════════════════════════════════════════════════════════════════
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForTimeout(300);
    await openSettingsCard(page, 'ledger');
    await page.locator('[data-a="verify-integrity"]').click();
    await page.waitForTimeout(1800);
    const verifyText = await page.locator('.app').innerText();
    const verifyOk = verifyText.includes('장부에 이상이 없습니다') && !verifyText.includes('장부 기록에 이상이 발견');
    check('c1', '설정 > 장부 검사 = 이상 없음(체인 검증 통과)', verifyOk,
      (verifyText.match(/✅[^\n]*|⚠️[^\n]*/g) || []).slice(0, 4).join(' | '));

    // ══════════════════════════════════════════════════════════════════════════
    // (d) 등록 상태 유지 — 홈 칩 · 자동 등록 카드 · 클라우드 카드
    // ══════════════════════════════════════════════════════════════════════════
    const infoSummary = await page.locator('.fold-head[data-card="info"]').innerText().catch(() => '');
    check('d0', '설정 > 앱 정보에 새 버전 번호가 표시(사장님이 갱신 여부를 눈으로 확인 가능)',
      infoSummary.includes('v' + newVer), `앱 정보 요약: ${j(infoSummary).slice(0, 160)}`);
    const enrollSummary = await page.locator('.fold-head[data-card="enroll-auto"]').innerText().catch(() => '');
    const cloudHead = await page.locator('.fold-head[data-card="cloud"]').innerText().catch(() => '');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(350);
    const chipText = await page.locator('.pill, .chip, .status-chip').allInnerTexts().catch(() => []);
    const homeAll = await page.locator('.app').innerText();
    check('d1', '홈 상태 칩 = "공공기관 명단 받는 중"', homeAll.includes('공공기관 명단 받는 중'),
      `칩 목록: ${j(chipText).slice(0, 300)}`);
    check('d2', '설정 자동 등록 카드 = 등록 상태(가게명 + 명단 받는 중)', enrollSummary.includes('업그레이드식당') && enrollSummary.includes('명단 받는 중'),
      `요약: ${j(enrollSummary).slice(0, 200)}`);
    check('d3', '클라우드 카드 잠금 아님', cloudHead.includes('📱') && !cloudHead.includes('🔒') && !cloudHead.includes('가게 등록 후 사용 가능'),
      `요약: ${j(cloudHead).slice(0, 200)}`);

    // ══════════════════════════════════════════════════════════════════════════
    // (e) 직원별 증표 — "잔액 표시 불가" 경고 없음
    // ══════════════════════════════════════════════════════════════════════════
    for (let i = 0; i < 20; i += 1) {
      const c = page.locator('.group-head[aria-expanded="false"]');
      if (await c.count() === 0) break;
      await c.first().click(); await page.waitForTimeout(60);
    }
    const receiptReport = [];
    let receiptAllOk = true;
    for (const e of empB) {
      await page.locator(`[data-a="receipt"][data-id="${e.id}"]`).click();
      await page.waitForSelector('.receipt-modal', { timeout: 8000 });
      const rt = await page.locator('.receipt-modal').innerText();
      const warn = await page.locator('.receipt-warn').count();
      const okBal = rt.includes(money(balB[e.name]) + '원');
      receiptReport.push(`${e.name}: warn=${warn} 잔액표시=${okBal}`);
      if (warn !== 0 || !okBal) receiptAllOk = false;
      await page.locator('.receipt-modal [data-a="close-modal"]').click();
      await page.waitForTimeout(200);
    }
    check('e1', '직원 3명 증표 모두 경고 없이 잔액 표시', receiptAllOk, receiptReport.join(' / '));

    // ══════════════════════════════════════════════════════════════════════════
    // (f) 전화번호 복호화
    // ══════════════════════════════════════════════════════════════════════════
    await page.locator(`[data-a="use"][data-id="${e1.id}"]`).click();
    await page.waitForSelector('#useAmount', { timeout: 8000 });
    const useModalText = await page.locator('.modal').innerText();
    const phoneShown = /010-?1234-?5678/.test(useModalText.replace(/\s/g, '')) || useModalText.includes('010-1234-5678');
    check('f1', '갱신 후에도 직원 전화번호가 복호화되어 표시', phoneShown && useModalText.includes('문자 안내'),
      `모달에서 발췌: ${j((useModalText.match(/문자 안내[\s\S]{0,80}/) || [''])[0])}`);

    // ══════════════════════════════════════════════════════════════════════════
    // (g) 새 버전에서 거래 1건 추가 → 체인·잔액 정합
    // ══════════════════════════════════════════════════════════════════════════
    await page.locator('#useAmount').fill('4000');
    await page.locator('#useNote').fill('업그레이드 후 첫 거래');
    await drawSignature(page);
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(900);
    if (await page.locator('.receipt-modal').count()) { await page.locator('.receipt-modal [data-a="close-modal"]').click(); await page.waitForTimeout(200); }
    const snapC = await readDb(page);
    const newTx = snapC.transactions.filter(t => !snapB.transactions.some(o => o.id === t.id));
    const balE1after = balOf(snapC, e1.id);
    const expectE1 = balB[e1.name] - 4000;
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForTimeout(300);
    await openSettingsCard(page, 'ledger');
    await page.locator('[data-a="verify-integrity"]').click();
    await page.waitForTimeout(1800);
    const verify2 = await page.locator('.app').innerText();
    const verify2Ok = verify2.includes('장부에 이상이 없습니다') && !verify2.includes('장부 기록에 이상이 발견');
    check('g1', '새 버전에서 거래 1건 추가 후 체인 검사 통과 · 잔액 정합', newTx.length === 1 && balE1after === expectE1 && verify2Ok,
      `새 거래 ${newTx.length}건 (${newTx.map(t => `${t.type} ${t.amount} prev=${String(t.prevHash).slice(0, 8)}… hash=${String(t.txHash).slice(0, 8)}…`).join(',')}) / 잔액 ${balB[e1.name]}→${balE1after} (기대 ${expectE1}) / 체인검사=${verify2Ok}`);
    // 기존 거래가 새 거래 추가로 변형되지 않았는지도 확인
    const tamper = [];
    for (const a of byId(snapB.transactions)) {
      const b = snapC.transactions.find(t => t.id === a.id);
      if (!b) { tamper.push(`tx ${a.id} 사라짐`); continue; }
      for (const k of Object.keys(a)) if (j(a[k]) !== j(b[k])) tamper.push(`tx ${a.id} .${k} 변경`);
    }
    check('g2', '새 거래 추가가 기존 거래를 건드리지 않음', tamper.length === 0, tamper.slice(0, 10).join(' ; ') || '기존 거래 전건 불변');

    // ══════════════════════════════════════════════════════════════════════════
    // (h) 콘솔 오류
    // ══════════════════════════════════════════════════════════════════════════
    // 허용 패턴: 하니스가 일부러 만드는 소음만. (1) /sw.js를 404로 막아 서비스워커 등록이 실패한다
    //   ("A bad HTTP response code (404) …" — 구버전 단계에서도 똑같이 난다) (2) /api/inbox-count 404 목.
    const EXPECTED = [/status of 404/, /Failed to load resource.*404/, /sw\.js/i, /ServiceWorker/i,
      /bad HTTP response code \(404\)/, /status of 500/, /^relay /, /net::ERR_FAILED/, /Manifest/i];
    const upgradeIssues = consoleLog.filter(c => c.phase !== 'old').filter(c => !EXPECTED.some(re => re.test(c.text)));
    check('h1', '갱신 직후~이후 예상 밖 콘솔 오류 0', upgradeIssues.length === 0,
      upgradeIssues.length ? upgradeIssues.map(c => `[${c.phase}] ${c.type}: ${c.text}`).slice(0, 10).join('\n        ')
        : `수집 ${consoleLog.filter(c => c.phase !== 'old').length}건 전부 허용 패턴(404 sw/inbox-count, 목 500)`);

    if (SW_MODE) {
      const swEnd = await page.evaluate(async () => ({
        caches: await caches.keys(),
        controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
      }));
      check('W3', '새 서비스워커가 활성화되고 구 캐시가 정리됨(장부는 IndexedDB라 무관)',
        swEnd.controller && swEnd.caches.length === 1 && swEnd.caches[0].includes(newVer),
        `controller=${swEnd.controller}, caches=${j(swEnd.caches)}`);
    }

    // 요약 통계
    notes.push(`스냅샷 A: 직원 ${snapA.employees.length}명 / 거래 ${snapA.transactions.length}건 / meta ${snapA.meta.length}키 / 잔액합 ${Object.values(balA).reduce((s, v) => s + v, 0).toLocaleString('en-US')}원`);
    notes.push(`스냅샷 B: 직원 ${snapB.employees.length}명 / 거래 ${snapB.transactions.length}건 / meta ${snapB.meta.length}키 / 잔액합 ${Object.values(balB).reduce((s, v) => s + v, 0).toLocaleString('en-US')}원`);
    notes.push(`거래 구성: ${byId(snapB.transactions).map(t => `${t.type}/${t.amount}/sig${String(t.signatureData || '').length}/h${String(t.txHash || '').slice(0, 6)}`).join(' | ')}`);
    notes.push(`콘솔(old 단계 포함) 전체 ${consoleLog.length}건`);
  } catch (e) {
    fail('X', '시나리오 실행 중 예외', e);
    try { await page.screenshot({ path: path.join(OUT, `${SLUG}-failure.png`) }); } catch {}
    try {
      const html = await page.content();
      await fsp.writeFile(path.join(OUT, `${SLUG}-failure.html`), html);
    } catch {}
  } finally {
    const report = {
      label: LABEL, old: OLD_FILE, new: NEW_FILE, oldVer, newVer,
      results, notes,
      console: consoleLog,
      dialogs: dialogs.map(d => `${d.type}: ${String(d.message).slice(0, 160)}`),
      downloads: downloads.map(d => ({ name: d.name, bytes: d.bytes })),
      snapshotSummary: snapA && snapB ? {
        A: { employees: snapA.employees.length, transactions: snapA.transactions.length, meta: snapA.meta.length },
        B: { employees: snapB.employees.length, transactions: snapB.transactions.length, meta: snapB.meta.length }
      } : null
    };
    await fsp.writeFile(path.join(OUT, `${SLUG}-report.json`), JSON.stringify(report, null, 2));
    console.log('\n----- 요약 -----');
    notes.forEach(n => console.log('  ' + n));
    const bad = results.filter(r => !r.ok);
    console.log(`\n결과: ${results.length - bad.length}/${results.length} 통과` + (bad.length ? ` — 실패: ${bad.map(b => b.id).join(', ')}` : ''));
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    server.close();
    process.exit(bad.length ? 1 : 0);
  }
})();
