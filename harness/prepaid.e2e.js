#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (err) {
  console.error('Playwright is required. Install it or run with NODE_PATH pointing to a Playwright installation.');
  console.error(err.message);
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const name = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.resolve(root, '.' + name);
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/index.html`
    }));
  });
}

async function count(page, selector) {
  return page.locator(selector).count();
}

async function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readDb(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error && req.error.message || 'IndexedDB open failed');
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

async function main() {
  await fsp.mkdir(path.join(root, 'harness', 'screenshots'), { recursive: true }).catch(() => {});
  const { server, url } = await startServer();
  const chromePath = findChrome();
  const browser = await chromium.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {})
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Android UA so the SMS-app-open feature (iOS/Android only, desktop is silently skipped) is exercised.
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
  });
  const page = await context.newPage();
  const dialogs = [];
  const consoleProblems = [];
  let promptAnswer = '초기화';

  page.on('dialog', async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === 'prompt') await dialog.accept(promptAnswer);
    else await dialog.accept();
  });
  page.on('pageerror', err => consoleProblems.push(err.message));
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleProblems.push(`${msg.type()}: ${msg.text()}`);
  });

  try {
    await page.goto(url, { waitUntil: 'load' });

    const manifest = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
    const icon192 = manifest.icons && manifest.icons.find(icon => icon.src === 'icons/icon-192.png' && icon.sizes === '192x192' && icon.type === 'image/png');
    const icon512 = manifest.icons && manifest.icons.find(icon => icon.src === 'icons/icon-512.png' && icon.sizes === '512x512' && icon.type === 'image/png');
    await assert(Boolean(icon192), 'manifest should contain 192x192 PNG icon');
    await assert(Boolean(icon512), 'manifest should contain 512x512 PNG icon');
    for (const icon of [icon192, icon512]) {
      const bytes = await fsp.readFile(path.join(root, icon.src));
      await assert(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${icon.src} should be a PNG file`);
    }

    // 전화번호는 이 기기(로컬)에만 저장 — 기관 승인/직접전달로 만들어지는 직원, 클라우드 백업 페이로드에는 절대 포함되면 안 된다 (코드 검사).
    const indexSrc = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
    const relaySection = indexSrc.slice(indexSrc.indexOf('async function relayApprove'), indexSrc.indexOf('// ── 직접 전달'));
    await assert(relaySection.includes("phone:'',phoneConsent:false"), 'employees created from relay-approved institution batches must never carry a phone number');
    const directSection = indexSrc.slice(indexSrc.indexOf('async function processDirectTransfer'), indexSrc.indexOf('async function onDirectTransferFile'));
    await assert(directSection.includes("phone:'',phoneConsent:false"), 'employees created from direct-transfer institution batches must never carry a phone number');
    await assert(indexSrc.includes('stripPhonesForCloud'), 'cloud backup builder must sanitize phone fields before encrypting the payload for the server');

    await assert(await count(page, '[data-a="setup-search"]') === 0, 'public shop search button must be removed');
    await assert(await count(page, '[data-a="setup-source"]') === 0, 'public API source toggle must be removed');
    await assert(await count(page, '[data-a="voice-shop"]') === 0, 'shop-search voice button must be removed');

    await page.locator('#setupManualName').fill('Harness Shop');
    await page.locator('#setupManualAddr').fill('광진구 구의동');
    await page.locator('#setupManualTel').fill('02-111-2222');
    await page.locator('[data-a="setup-manual-save"]').click();
    await page.locator('[data-a="setup-next"]').click();
    await page.waitForSelector('#agencySelectSetup');
    // ① 신규 설치는 기본 부서 0개로 시작해야 한다(사무실/관리팀/현장팀/영업팀 같은 하드코딩 기본값 제거).
    await assert(await page.locator('.dept-tag').count() === 0, 'a fresh install should start with zero default departments');
    await assert((await page.locator('#agencySelectSetup').inputValue()) === 'gwangjin', 'region address "광진구 구의동" should auto-select 광진구청 agency');
    await page.locator('[data-a="agency-add-all"][data-ctx="setup"]').click();
    await assert(await page.locator('.dept-tag', { hasText: '보건의료과' }).count() > 0, 'agency departments should be added during setup');
    await page.locator('[data-a="setup-to-contact"]').click();
    await page.waitForSelector('#setupContactKakao');
    await page.locator('#setupContactKakao').fill('https://open.kakao.com/o/sHarness');
    await page.locator('#setupContactEmail').fill('owner@harness-shop.example');
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'onboarding-contact.png') }).catch(() => {});
    await page.locator('[data-a="setup-complete"]').click();

    for (const key of ['1', '2', '3', '4', '1', '2', '3', '4']) {
      await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
    }

    await page.waitForSelector('[data-a="guide-dismiss"]');
    await assert(await count(page, '[data-a="guide-add-employee"]') === 1, 'setup completion guide should offer employee registration path');
    await assert(await count(page, '[data-a="guide-start-agency"]') === 1, 'setup completion guide should offer agency onboarding path');
    await page.waitForTimeout(3200); // let the "PIN set" toast fade before the completion screenshot
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'onboarding-complete.png') }).catch(() => {});
    await page.locator('[data-a="guide-dismiss"]').click();

    const setupMeta = await readDb(page);
    const setupMetaMap = (setupMeta.meta || []).reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(setupMetaMap.contactKakaoLink === 'https://open.kakao.com/o/sHarness', 'contact kakao link entered during onboarding should be saved locally');
    await assert(setupMetaMap.contactEmail === 'owner@harness-shop.example', 'contact email entered during onboarding should be saved locally');

    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await assert(await count(page, '[data-a="new-month"]') === 0, 'new-month action must be removed');
    await assert(await count(page, '[data-a="full-reset"]') === 1, 'full-reset action must appear once');
    await assert(await count(page, '[data-a="export-safe"]') === 1, 'combined safe export action must be visible');
    await assert(await count(page, '[data-a="export-csv"]') === 0, 'standalone CSV export action must be removed from settings');
    await assert((await page.locator('.agency-current-name').textContent()).includes('광진구청'), 'setup agency should be reflected as current agency');
    await page.locator('#agencySelectSettings').selectOption('gangnam');
    await page.waitForFunction(() => document.querySelector('.agency-current-name')?.textContent.includes('강남구청'));
    // 보조 경로로 유지된 기존 개별등록 모달
    await page.locator('[data-a="add-employee"]').click();
    await page.locator('#empDept').fill('Dept A');
    await page.locator('#empName').fill('User A');
    await page.locator('#empOpen').fill('27000');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(150);

    // ② 직원 목록 관리 하단의 인라인 빠른 등록 폼: 부서 자동 생성 + 직원 생성 + 초기 충전(기존 open 트랜잭션 로직 재사용)
    await assert(await count(page, '[data-a="quick-add-employee"]') === 1, 'inline quick-add form should replace the standalone employee-registration section');
    await assert(await count(page, '.section-title:has-text("직원 등록")') === 0, 'the old standalone "직원 등록" section must be removed');
    await assert((await page.locator('.section-title', { hasText: '직원 목록 관리' }).count()) === 1, '직원 관리 section should be renamed to 직원 목록 관리');
    await page.locator('#quickAddDept').fill('Dept Q');
    await page.locator('#quickAddName').fill('User Q');
    await page.locator('#quickAddOpen').fill('12000');
    await page.locator('[data-a="quick-add-employee"]').click();
    await page.waitForTimeout(150);
    await assert(await page.locator('.dept-tags .dept-tag', { hasText: 'Dept Q' }).count() > 0, 'quick add should auto-create the missing department');

    const afterQuickAdd = await readDb(page);
    const empA = afterQuickAdd.employees.find(e => e.name === 'User A');
    const empQ = afterQuickAdd.employees.find(e => e.name === 'User Q');
    await assert(Boolean(empA) && Boolean(empQ), 'both the modal-registered and the quick-added employee should be saved');
    const openTxQ = afterQuickAdd.transactions.find(tx => tx.employeeId === empQ.id && tx.type === 'open');
    await assert(Boolean(openTxQ) && Number(openTxQ.amount) === 12000, 'quick add initial balance should be recorded via the existing charge (open) transaction logic');

    // ③ 직원 목록 관리 행에서 전화번호 등록 + 문자 안내 동의 (이 폰에만 저장)
    await page.locator(`[data-a="toggle-dept"][data-dept="Dept Q"]`).click();
    promptAnswer = '01099998888';
    await page.locator(`[data-a="emp-phone-edit"][data-id="${empQ.id}"]`).click();
    promptAnswer = '초기화';
    await page.waitForTimeout(150);
    const afterPhone = await readDb(page);
    const empQAfterPhone = afterPhone.employees.find(e => e.id === empQ.id);
    await assert(Boolean(empQAfterPhone.phone) && empQAfterPhone.phoneConsent === true, 'registering a phone number should store it locally and default the SMS-consent checkbox on');
    await assert(!/0109999/.test(JSON.stringify(afterPhone.employees)), 'the phone number must be stored encrypted, never as raw digits, in IndexedDB');

    await page.locator('[data-a="screen"][data-screen="home"]').click();

    // ④ 전화번호가 없는 직원은 사용 등록 창에 문자 안내 영역 자체가 표시되지 않아야 한다
    await page.locator('#searchInput').fill('User A');
    await page.locator(`[data-a="use"][data-id="${empA.id}"]`).click();
    const noPhoneModalText = await page.locator('.modal').innerText();
    await assert(!noPhoneModalText.includes('문자 안내'), 'usage modal must not show the SMS section for an employee with no registered phone/consent');
    await page.locator('[data-a="close-modal"]').click();
    await page.locator('#searchInput').fill('');

    // ③ 전화+동의가 등록된 직원은 번호가 자동으로 채워져 표시되어야 한다
    await page.locator('#searchInput').fill('User Q');
    await page.locator(`[data-a="use"][data-id="${empQ.id}"]`).click();
    const phoneModalText = await page.locator('.modal').innerText();
    await assert(phoneModalText.includes('문자 안내') && phoneModalText.includes('010-9999-8888'), 'usage modal should auto-fill the registered phone number for a consenting employee');

    // ⑤ 차감 저장 직후 sms: URI로 이동을 시도해야 한다(문자 앱 자동 오픈 시도, location 변경 감지)
    await page.locator('#useAmount').fill('5000');
    const smsBox = await page.locator('#signCanvas').boundingBox();
    await page.mouse.move(smsBox.x + 30, smsBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(smsBox.x + 110, smsBox.y + 45, { steps: 5 });
    await page.mouse.move(smsBox.x + 210, smsBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(300);
    const smsHref = await page.evaluate(() => window.__lastSmsHref || '');
    await assert(smsHref.startsWith('sms:0109999'), 'saving a deduction for a phone+consent employee should attempt to navigate to an sms: URI');
    await assert(smsHref.includes('body=') && decodeURIComponent(smsHref.split('body=')[1] || '').includes('5,000원'), 'the sms body should describe the amount used and the resulting balance');
    await page.locator('#searchInput').fill('');

    // 기존 사용 등록(차감) 플로우 — User A, 서명 포함
    await page.locator('#searchInput').fill('User A');
    await page.locator(`[data-a="use"][data-id="${empA.id}"]`).click();
    await page.locator('#useAmount').fill('9000');
    const box = await page.locator('#signCanvas').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 110, box.y + 45, { steps: 5 });
    await page.mouse.move(box.x + 210, box.y + 100, { steps: 5 });
    await page.mouse.move(box.x + 310, box.y + 65, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(300);
    await page.locator('#searchInput').fill('');

    const data = await readDb(page);
    await assert(data.employees.length === 2, 'both employees (modal + quick add) should be saved');
    const balanceOf = eid => data.transactions.filter(tx => tx.employeeId === eid).reduce((sum, tx) => sum + (tx.type === 'use' ? -Number(tx.amount || 0) : Number(tx.amount || 0)), 0);
    await assert(data.transactions.filter(tx => tx.employeeId === empA.id).map(tx => tx.type).join(',') === 'open,use', 'User A should carry an open + use transaction');
    await assert(balanceOf(empA.id) === 18000, 'User A balance should be 18000 after one use');
    await assert(Boolean(data.transactions.find(tx => tx.employeeId === empA.id && tx.type === 'use').signatureData), 'use transaction should contain signature data');
    await assert(data.transactions.filter(tx => tx.employeeId === empQ.id).map(tx => tx.type).join(',') === 'open,use', 'User Q should carry an open (quick add) + use (sms deduction) transaction');
    await assert(balanceOf(empQ.id) === 7000, 'User Q balance should be 7000 after the 5000 use');
    // 다자간 확장(beta.7): tx 무결성 체인 + 키페어
    const useTx = data.transactions.find(tx => tx.employeeId === empA.id && tx.type === 'use');
    const openTx = data.transactions.find(tx => tx.employeeId === empA.id && tx.type === 'open');
    await assert(Boolean(useTx.txHash) && Boolean(openTx.txHash), 'transactions should carry integrity txHash');
    const metaMap = (data.meta || []).reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(Boolean(metaMap.pubKey) && Boolean(metaMap.privKeyWrapped) && Boolean(metaMap.deviceSecret), 'keypair should be generated and private key wrapped');
    // 페이지 함수로 체인 무결성 재검증 (verifyChain은 IIFE 내부이므로 동일 알고리즘으로 재계산)
    const chainOk = await page.evaluate(async (txs) => {
      const subtle = window.crypto.subtle;
      const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
      async function h(t){const b=new TextEncoder().encode(String(t)),d=await subtle.digest('SHA-256',b);return Array.from(new Uint8Array(d)).map(x=>x.toString(16).padStart(2,'0')).join('')}
      const sorted = txs.slice().sort((a,b)=>a.createdAt-b.createdAt||(a.id<b.id?-1:a.id>b.id?1:0));
      let prev='';
      for(const t of sorted){ if(!t.txHash){prev='';continue} const e=await h(String(t.employeeId)+'|'+num(t.amount)+'|'+num(t.afterBalance)+'|'+(t.prevHash||'')+'|'+t.createdAt); if(e!==t.txHash) return false; if((t.prevHash||'')!==prev) return false; prev=t.txHash; }
      return true;
    }, data.transactions);
    await assert(chainOk, 'integrity hash chain should recompute and verify');

    // ⑥ 클라우드 백업(서버 전송) 페이로드를 실제로 만들어 복호화한 뒤 전화번호가 전혀 없는지 덤프에서 확인한다
    const cloudCheck = await page.evaluate(async () => {
      const hooks = window.__prepaidTestHooks;
      if (!hooks) return { dump: '', hasHooks: false };
      const blob = await hooks.buildCloudBackupBlob();
      const core = await hooks.decryptBlob(blob);
      return { dump: JSON.stringify(core), hasHooks: true };
    });
    await assert(cloudCheck.hasHooks, 'test hooks for cloud backup verification should be exposed');
    await assert(!/"phone"/.test(cloudCheck.dump) && !/"phoneConsent"/.test(cloudCheck.dump), 'cloud backup payload must not include phone/phoneConsent fields for any employee');
    await assert(!cloudCheck.dump.includes('0109999') && !cloudCheck.dump.includes('01099998888'), 'cloud backup payload must not leak raw phone digits');

    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    const capturedDownloads = [];
    const onDownload = download => capturedDownloads.push(download);
    page.on('download', onDownload);
    await page.locator('[data-a="export-safe"]').click();
    for (let i = 0; i < 20 && capturedDownloads.length < 2; i += 1) {
      await page.waitForTimeout(100);
    }
    page.off('download', onDownload);
    await assert(capturedDownloads.length >= 2, 'safe export should trigger two downloads');
    const downloads = capturedDownloads.map(d => ({ item: d, name: d.suggestedFilename() }));
    const csvDownload = downloads.find(d => d.name.endsWith('.csv'));
    const jsonDownload = downloads.find(d => d.name.endsWith('.json'));
    await assert(Boolean(csvDownload), 'safe export should download a CSV ledger file');
    await assert(Boolean(jsonDownload), 'safe export should download a JSON backup file');
    const backupPath = await jsonDownload.item.path();
    const backup = JSON.parse(await fsp.readFile(backupPath, 'utf8'));
    const core = {
      schemaVersion: backup.schemaVersion,
      appName: backup.appName,
      appVersion: backup.appVersion,
      exportedAt: backup.exportedAt,
      payload: backup.payload
    };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
    await assert(backup.schemaVersion === 3, 'backup schemaVersion should be 3');
    await assert(backup.payload && Array.isArray(backup.payload.transactions), 'backup payload should contain transactions');
    await assert(backup.payload.meta && backup.payload.meta.orgName === '강남구청', 'selected agency name should be saved in backup meta');
    await assert(checksum === backup.checksum, 'backup checksum should match payload');

    await page.reload({ waitUntil: 'load' });
    for (let i = 0; i < 5; i += 1) {
      for (const key of ['9', '9', '9', '9']) {
        await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
      }
    }
    await assert(await count(page, '[data-a="pin-reset"]') === 1, 'app reset should appear after five PIN failures');
    const dialogsBeforeReset = dialogs.length;
    await page.locator('[data-a="pin-reset"]').click();
    await page.waitForTimeout(500);
    const resetDialogs = dialogs.slice(dialogsBeforeReset);
    const resetConfirms = resetDialogs.filter(d => d.type === 'confirm');
    await assert(resetConfirms.length === 2, `reset from lock screen should use exactly two confirm() dialogs, got ${resetConfirms.length}`);
    await assert(!resetDialogs.some(d => d.type === 'prompt'), 'reset from lock screen must not require a typed-text prompt');
    await assert(await count(page, '#setupManualName') === 1, 'app should return to setup after lock-screen reset');
    const wiped = await readDb(page);
    await assert(wiped.employees.length === 0 && wiped.transactions.length === 0, 'lock-screen reset should wipe local data');

    console.log(JSON.stringify({
      ok: true,
      url,
      dialogs: dialogs.map(d => d.type),
      checks: {
        apiUiRemoved: true,
        manifestPngIcons: true,
        agencyDepartmentPicker: true,
        settingsMenuCleanup: true,
        safeLedgerExport: true,
        transactionFlow: true,
        backupV2: true,
        pinResetWipesData: true
      },
      consoleProblems
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
