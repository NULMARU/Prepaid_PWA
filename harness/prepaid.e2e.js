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

// 홈 그룹은 기본 접힘(아코디언, beta.14)이다 — 직원 카드를 눌러야 하는 시나리오에서는 먼저 그룹 헤더를 탭해 펼친다.
// 검색어·부서 필터를 켠 경로는 앱이 스스로 펼치므로 이 함수를 쓰지 않는다(자동 펼침을 그대로 검증하기 위함).
async function expandHomeGroups(page) {
  for (let guard = 0; guard < 40; guard += 1) {
    const collapsed = page.locator('.group-head[aria-expanded="false"]');
    if (await collapsed.count() === 0) return;
    await collapsed.first().click();
    await page.waitForTimeout(60);
  }
  throw new Error('failed to expand every home group header');
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
  // 중계 서버 호출은 전부 목으로 가로챈다(로컬 e2e가 라이브 서버에 의존하지 않도록).
  //  · 가게 검색: 빈 결과 → 온보딩 2/4에서 "지금은 넘어가기" 예외 경로가 노출된다.
  //  · 새 명단 신청 개수: 404(구서버 호환 경로) → 앱은 조용히 무시해야 한다.
  // 목은 반드시 context.route로 — 이 앱은 서비스워커가 모든 GET을 가로채므로 page.route로는 잡히지 않는다.
  // 중계 서버는 교차 출처라 목 응답에도 CORS 헤더가 필요하다.
  const cors = { 'Access-Control-Allow-Origin': '*' };
  // 목 응답은 시나리오마다 바뀌므로 라우트는 한 번만 걸고 변수로 갈아끼운다.
  let storeSearchResults = [];        // 기본: 검색 결과 없음
  let inboxCountBody = null;          // null = 404(구서버 호환 경로)
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(storeSearchResults) }));
  await context.route('**/api/inbox-count**', route => (inboxCountBody === null
    ? route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not found"}' })
    : route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(inboxCountBody) })));
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

    // 2/4 우리 가게 등록(신설) — 온보딩 화면에는 모달이 없으므로 검색 UI가 단계 화면에 인라인으로 있어야 한다.
    await page.waitForSelector('#setupStoreName');
    await assert((await page.locator('.setup-step').innerText()).includes('2 / 4'), 'store registration must be step 2 of a 4-step onboarding');
    await assert((await page.locator('#setupStoreName').inputValue()) === 'Harness Shop', 'the shop name from step 1 should prefill the store search box');
    // 서버 등록은 약관 동의(4/4) 이후에만 — 이 단계에서 register-key가 호출되면 안 된다.
    const registerCalls = [];
    let registerStatus = 200;
    await context.route('**/api/register-key**', route => {
      registerCalls.push(route.request().url());
      return registerStatus === 200
        ? route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' })
        : route.fulfill({ status: registerStatus, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' });
    });
    // S1 회귀 방지: "나중에 등록할게요"는 검색 전에도, 결과가 있어도 항상 보여야 한다(막다른 길 금지).
    await assert(await count(page, '[data-a="setup-store-skip"]') === 1, 'the skip link must be available before searching (no dead end)');
    await page.locator('[data-a="setup-store-search"]').click();
    await page.waitForSelector('.empty');
    await assert(await count(page, '[data-a="setup-store-skip"]') === 1, 'the skip link must stay visible when a search returns nothing');
    const emptyHelp = await page.locator('.setup').innerText();
    await assert(emptyHelp.includes('사업자등록증의 상호'), 'a "search by the business-registration name" hint should follow the result list');
    // 결과가 있는데 내 가게가 아닌 경우 — 여기서도 빠져나갈 길이 있어야 한다(리뷰 S1).
    storeSearchResults = [
      { restaurant_id: 'rid-other-1', name: '남의 김밥', address: '서울특별시 강남구 역삼동 1-1' },
      { restaurant_id: 'rid-mine-1', name: 'Harness Shop', address: '서울특별시 광진구 구의동 2-2' }
    ];
    // 서비스워커가 GET을 캐시-우선으로 처리하므로 다른 검색어(=다른 캐시 키)로 다시 조회해야 새 목이 적용된다.
    await page.locator('#setupStoreName').fill('하네스김밥');
    await page.locator('[data-a="setup-store-search"]').click();
    await page.waitForSelector('[data-a="setup-store-pick"]');
    await assert(await count(page, '[data-a="setup-store-pick"]') === 2, 'both mocked search results should be listed');
    await assert(await count(page, '[data-a="setup-store-skip"]') === 1, 'the skip link must stay visible even when the search DOES return results (none of them mine)');
    // 남의 가게 오선택 방지: [이 가게] 확인 문구에 주소가 들어가야 한다.
    const dialogsBeforePick = dialogs.length;
    await page.locator('[data-a="setup-store-pick"]').nth(1).click();
    await page.waitForTimeout(150);
    const pickConfirm = dialogs.slice(dialogsBeforePick).find(d => d.type === 'confirm');
    await assert(Boolean(pickConfirm) && pickConfirm.message.includes('서울특별시 광진구 구의동 2-2'), 'picking a store must confirm with the store address, not just the name');
    await assert((await page.locator('.setup-selected').innerText()).includes('Harness Shop'), 'the confirmed store should show up as the picked store');
    await assert(registerCalls.length === 0, 'searching/picking a store must not register anything on the server');
    await page.locator('[data-a="setup-store-skip"]').click();

    await page.waitForSelector('#agencySelectSetup');
    await assert((await page.locator('.setup-step').innerText()).includes('3 / 4'), 'department setup should be step 3 of 4');
    // ① 신규 설치는 기본 부서 0개로 시작해야 한다(사무실/관리팀/현장팀/영업팀 같은 하드코딩 기본값 제거).
    await assert(await page.locator('.dept-tag').count() === 0, 'a fresh install should start with zero default departments');
    await assert((await page.locator('#agencySelectSetup').inputValue()) === 'gwangjin', 'region address "광진구 구의동" should auto-select 광진구청 agency');
    await page.locator('[data-a="agency-add-all"][data-ctx="setup"]').click();
    await assert(await page.locator('.dept-tag', { hasText: '보건의료과' }).count() > 0, 'agency departments should be added during setup');
    await page.locator('[data-a="setup-to-contact"]').click();
    await page.waitForSelector('#setupContactKakao');
    await assert((await page.locator('.setup-step').innerText()).includes('4 / 4'), 'contact + terms should be the last (4th) onboarding step');
    await page.locator('#setupContactKakao').fill('https://open.kakao.com/o/sHarness');
    await page.locator('#setupContactEmail').fill('owner@harness-shop.example');
    // 약관 동의 게이트: 미체크 시 완료 버튼 비활성, 체크 시 활성화되어야 한다
    await assert(await page.locator('#setupCompleteBtn').isDisabled(), 'complete button must be disabled until terms are agreed');
    await page.locator('#setupTermsChk').check();
    await assert(!(await page.locator('#setupCompleteBtn').isDisabled()), 'complete button should enable after agreeing to terms');
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

    // 가게 등록을 넘긴 경우: 서버 등록은 일어나지 않고, 홈에 마무리 배너가 남아야 한다.
    await assert(registerCalls.length === 0, 'skipping the store step must not send anything to the relay server');
    await assert(await count(page, '[data-a="go-register-store"]') === 1, 'home should keep a persistent banner asking to finish the store registration');

    // 직원이 0명인 홈은 안내로 끝내지 않고 바로 누를 수 있는 CTA를 보여야 한다(막다른 빈 화면 금지).
    const emptyHome = await page.locator('.card.empty').innerText();
    await assert(emptyHome.includes('아직 올린 직원이 없어요'), 'the empty home state should use the friendly "아직 올린 직원이 없어요" wording');
    await assert(await count(page, '.card.empty [data-a="guide-add-employee"]') === 1, 'the empty home state must render a one-tap CTA button to add the first employee');
    const emptyCta = await page.locator('.card.empty [data-a="guide-add-employee"]').boundingBox();
    await assert(Boolean(emptyCta) && emptyCta.height >= 52, `the empty-home CTA must be a comfortable tap target (got ${emptyCta && Math.round(emptyCta.height)}px)`);

    const setupMeta = await readDb(page);
    const setupMetaMap = (setupMeta.meta || []).reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(setupMetaMap.contactKakaoLink === 'https://open.kakao.com/o/sHarness', 'contact kakao link entered during onboarding should be saved locally');
    await assert(setupMetaMap.contactEmail === 'owner@harness-shop.example', 'contact email entered during onboarding should be saved locally');
    await assert(typeof setupMetaMap.termsAgreedAt === 'number' && setupMetaMap.termsAgreedAt > 0, 'terms agreement timestamp should be saved after onboarding');
    // 약관 동의 이력이 있으므로 홈 진입 시 일회성 약관 모달이 뜨지 않아야 한다
    await assert(await count(page, '[data-a="terms-agree"]') === 0, 'no one-time terms modal should appear once termsAgreedAt is set');

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
    // 용어 체계: 상위 그룹 "직원 선금대장 등록" 아래 [자동 등록]·[수동 등록] 두 카드
    await assert((await page.locator('.section-title', { hasText: '직원 선금대장 등록' }).count()) === 1, 'settings should group enrollment under a single 직원 선금대장 등록 heading');
    await assert((await page.locator('.section-title', { hasText: '자동 등록 — 공공기관에서 보낸 명단 받기' }).count()) === 1, 'the relay card should be titled 자동 등록 — 공공기관에서 보낸 명단 받기');
    await assert((await page.locator('.section-title', { hasText: '수동 등록 — 직접 입력하기' }).count()) === 1, 'a 수동 등록 — 직접 입력하기 card should hold the manual enrollment actions');
    const settingsText = await page.locator('.app').innerText();
    await assert(!/구청 선금|선금 받기|직원개별등록/.test(settingsText), 'the retired wording (구청 선금 / 선금 받기 / 직원개별등록) must be gone from settings');
    await assert(settingsText.includes('가게 은행 계좌로 따로 입금'), 'the auto-enrollment card must state that money is deposited to the bank account, not the app');
    await page.locator('#quickAddDept').fill('Dept Q');
    await page.locator('#quickAddName').fill('User Q');
    await page.locator('#quickAddOpen').fill('12000');
    await page.locator('[data-a="quick-add-employee"]').click();
    await page.waitForTimeout(150);
    await assert(await page.locator('.dept-tags .dept-tag', { hasText: 'Dept Q' }).count() > 0, 'quick add should auto-create the missing department');

    // ②-1 홈 하단에서 옮겨온 "활성 직원 N명 · 잔액 합계" 요약은 [직원 목록 관리] 카드 상단에 있어야 한다.
    //      (새 .section-title을 만들지 않는다 — e2e 계약상 "직원 목록 관리" 제목은 정확히 1개)
    const mgrSummary = await page.locator('.mgr-summary').innerText();
    await assert(mgrSummary.includes('활성 직원 2명') && mgrSummary.includes('잔액 합계 39,000원'), `직원 목록 관리 카드 상단에 활성 직원 수·잔액 합계 요약이 있어야 한다 (got "${mgrSummary.replace(/\n/g, ' ')}")`);
    await assert((await page.locator('.section-title').allInnerTexts()).filter(t => t.includes('직원 목록 관리')).length === 1, 'the moved summary must not introduce a second 직원 목록 관리 section title');

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

    // ── 홈 그룹 아코디언(beta.14) ────────────────────────────────────────────
    // 그룹이 2개 이상이면 기본 접힘: 헤더에 인원수·잔액 소계만 보이고 직원 카드는 감춰진다.
    await assert(await count(page, '.group-head') === 2, 'home should render one collapsible header per group (Dept A / Dept Q)');
    await assert(await count(page, '.card.employee') === 0, 'with more than one group, home groups must start collapsed');
    const collapsedHead = await page.locator('.group-head').first().innerText();
    await assert(/직원 \d+명/.test(collapsedHead), `a collapsed group header must show the member count (got "${collapsedHead.replace(/\n/g, ' ')}")`);
    await assert(/[\d,]+원/.test(collapsedHead), `a collapsed group header must show the balance subtotal (got "${collapsedHead.replace(/\n/g, ' ')}")`);
    await assert(collapsedHead.includes('▶'), 'a collapsed group header must show a ▶ affordance');
    const headBox = await page.locator('.group-head').first().boundingBox();
    await assert(Boolean(headBox) && headBox.height >= 48, `a group header must be a comfortable tap target on a phone (got ${headBox && Math.round(headBox.height)}px)`);
    // 하단 요약은 홈에서 제거되어 설정 > 직원 목록 관리로 옮겨졌다.
    await assert(!(await page.locator('.app').innerText()).includes('잔액 합계'), 'the "잔액 합계" summary must no longer sit at the bottom of home');

    // (e) 검색어가 있으면 매칭 그룹이 자동으로 펼쳐져야 한다(검색이 "안 되는 것처럼" 보이면 안 됨).
    await page.locator('#searchInput').fill('User Q');
    await page.waitForTimeout(150);
    await assert(await count(page, '.card.employee') === 1, 'a search must auto-expand the matching group without an extra tap');
    await assert(await count(page, '.group-head[aria-expanded="true"]') === 1, 'the matching group header should report itself expanded during a search');
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(150);
    await assert(await count(page, '.card.employee') === 0, 'clearing the search should return the groups to the collapsed default');

    // 부서 필터도 동일 — 고른 그룹만 남고 자동으로 펼쳐진다(옵션 문구 = 그룹 헤더 문구).
    await page.locator('#deptFilterSelect').selectOption({ label: 'Dept Q' });
    await page.waitForTimeout(150);
    await assert(await count(page, '.group-head') === 1 && await count(page, '.card.employee') === 1, 'picking a department in the filter should leave exactly that group, auto-expanded');
    await page.locator('[data-a="reset-filter"]').click();
    await page.waitForTimeout(150);

    await expandHomeGroups(page);
    await assert(await count(page, '.card.employee') === 2, 'tapping the group headers should reveal the employee cards');
    await assert((await page.locator('.group-head').first().innerText()).includes('▼'), 'an expanded group header should flip the arrow to ▼');

    // 디자인 3종: 직원 아바타 배지 + 홈 퀵액션 2버튼이 홈에 존재해야 한다
    await assert(await count(page, '.emp-avatar') >= 2, 'each employee card should render a first-letter avatar badge');
    await assert(await count(page, '[data-a="quick-find-emp"]') === 1, 'home should offer a quick "find employee" action button');
    await assert(await count(page, '[data-a="quick-history"]') === 1, 'home should offer a quick "view history" action button');

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
    // 차감 저장 성공 안내(confirm)를 수락하면 방금 차감된 직원의 잔액증표가 자동으로 열린다(dialog handler가 자동 수락)
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.waitForTimeout(50);
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
    // 사용(차감) 저장 직후 성공 안내 흐름에서 "잔액증표 보기"가 방금 차감된 직원 id로 자동 오픈된다
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    const autoReceiptText = await page.locator('.namecard').innerText();
    await assert(autoReceiptText.includes('Dept A User A님'), 'post-save receipt should render "{부서} {이름}님" for the just-deducted employee');
    await assert(autoReceiptText.includes('18,000원'), 'post-save receipt should show the derive() balance (27000-9000)');
    await assert(autoReceiptText.includes('양도 불가'), 'receipt must carry the non-transfer notice');
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.waitForTimeout(50);
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

    // 잔액증표(명함형) — empCard 보조 버튼 [🧾 증표]으로 표시 전용 카드 열기
    await assert(await count(page, '[data-a="receipt"]') >= 2, 'each employee card should expose a receipt (증표) button next to 사용');
    // 홈 상단 배너 때문에 목록이 접힐 수 있으므로, 대상 직원만 남기고(검색) 증표를 연다.
    await page.locator('#searchInput').fill('User Q');
    await page.locator(`[data-a="receipt"][data-id="${empQ.id}"]`).click();
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    const receiptText = await page.locator('.namecard').innerText();
    await assert(receiptText.includes('Dept Q User Q님'), 'receipt card should show "{부서} {이름}님" for a departmented employee');
    await assert(receiptText.includes('7,000원'), 'receipt card should show the current derive() balance');
    await assert(receiptText.includes('양도 불가') && receiptText.includes('잔액 확인용'), 'receipt card should carry the fixed non-transfer/verify-only notice');
    await assert(receiptText.includes('Harness Shop'), 'receipt card should show the shop name');
    await assert(await count(page, '.receipt-warn') === 0, 'a healthy ledger receipt should show a balance, not an integrity warning');
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'receipt-card.png') }).catch(() => {});
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.waitForTimeout(50);
    await page.locator('#searchInput').fill('');

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

    // ───────────────────────────────────────────────────────────────
    // 월 단위 백업: 파일명 · 활동 게이트 · 월말 배너 · 자동백업 토글 · 조용한 클라우드 트리거
    // ───────────────────────────────────────────────────────────────
    const unlock = async () => {
      for (const key of ['1', '2', '3', '4']) {
        await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
      }
    };
    // (1) 일반 백업 파일명은 월 기준(밥장부백업_YYYY-MM.json), 최종백업은 날짜까지 유지
    await assert(/^밥장부백업_\d{4}-\d{2}\.json$/.test(jsonDownload.name), `monthly backup file name should be 밥장부백업_YYYY-MM.json, got ${jsonDownload.name}`);
    const finalFn = await page.evaluate(() => window.__prepaidTestHooks.backupFileName(true));
    await assert(/^밥장부백업_최종_\d{4}-\d{2}-\d{2}\.json$/.test(finalFn), `final backup file name should keep the day (밥장부백업_최종_YYYY-MM-DD.json), got ${finalFn}`);

    // (2) 활동 게이트: 이번 달은 씨앗 거래로 활동 있음, 임의의 빈 달은 활동 0 → 어떤 트리거도 대상 아님
    const gate = await page.evaluate(() => {
      const H = window.__prepaidTestHooks, n = new Date();
      const cur = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
      return { curHas: H.monthHasActivity(cur), emptyHas: H.monthHasActivity('2099-01') };
    });
    await assert(gate.curHas === true, 'current month must register activity from seeded transactions');
    await assert(gate.emptyHas === false, 'a zero-transaction month must report no activity (empty-month gate)');

    // 지난달(15일) 씨앗 거래 주입 + 더미 릴레이 서버 지정. txHash 비워 해시체인 검증은 이 거래를 건너뛴다(무결성 경고 유발 안 함).
    const pm = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15);
    const prevTs = pm.getTime();
    const prevYmStr = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`;
    await page.evaluate(({ ts }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['transactions', 'meta'], 'readwrite');
        tx.objectStore('transactions').put({ id: 'seed-prev-' + ts, employeeId: 'seed-emp', type: 'use', amount: 1000, beforeBalance: 0, afterBalance: 0, reason: '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: ts });
        tx.objectStore('meta').put({ key: 'relayServer', value: 'https://relay.invalid.test' });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { ts: prevTs });

    // (3) 활동 있는 지난달이 미백업(미등록) → 홈에 월말 배너 + [지금 저장하기]
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="screen"][data-screen="home"]');
    await assert(await count(page, '[data-a="monthly-backup-now"]') === 1, 'an unbacked month with activity must show the month-end backup banner on home');
    const bannerText = await page.locator('.banner.warn', { hasText: '지금 저장하기' }).first().innerText();
    await assert(bannerText.includes(prevYmStr), `month-end banner should name the due month ${prevYmStr}`);
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'backup-banner.png') }).catch(() => {});

    // (4) 자동 백업 토글: 기본 켜짐 → 끄면 저장·복원되고 배너에 "꺼져 있어요" 문구가 붙는다
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('[data-a="toggle-auto-cloud"]');
    await assert(await page.locator('[data-a="toggle-auto-cloud"]').isChecked(), 'auto cloud backup toggle should default to ON');
    await page.locator('[data-a="toggle-auto-cloud"]').scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'settings-auto-backup.png') }).catch(() => {});
    await page.locator('[data-a="toggle-auto-cloud"]').uncheck();
    await page.waitForTimeout(150);
    let mm = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(mm.autoCloudBackup === false, 'unchecking the toggle should persist autoCloudBackup=false');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    const bannerOff = await page.locator('.banner.warn', { hasText: '지금 저장하기' }).first().innerText();
    await assert(bannerOff.includes('꺼져 있어요'), 'with auto backup off, the banner should warn that auto backup is disabled');
    // 재로드 후 토글 상태 복원(꺼짐 유지) 확인 → 다시 켠다
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('[data-a="toggle-auto-cloud"]');
    await assert(!(await page.locator('[data-a="toggle-auto-cloud"]').isChecked()), 'auto backup toggle state should be restored (still off) after reload');
    await page.locator('[data-a="toggle-auto-cloud"]').check();
    await page.waitForTimeout(150);

    // (5) 이미 이번 대상 달을 백업했으면(lastMonthlyBackup 기록) 배너 미표시 + monthlyBackupDue()==''
    await page.evaluate(({ ym }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        tx.objectStore('meta').put({ key: 'lastMonthlyBackup', value: ym });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { ym: prevYmStr });
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="screen"][data-screen="home"]');
    // ⚠️ 달력 의존 주의: 오늘이 "말일"이면 앱 규칙②(말일 + 이번 달 활동 + 미백업 → 이번 달)가 곧바로 이어 발동한다.
    //    lastMonthlyBackup은 값이 하나뿐이라 지난달·이번 달을 동시에 기록할 수 없으므로, 말일에는 대상이 이번 달로
    //    넘어가는 것이 정상 동작이다. 두 갈래 모두 완전한 계약을 단언한다(달력에 따라 검증이 느슨해지지 않게).
    const nowD = new Date();
    const curYmStr = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`;
    const isLastDayToday = (() => { const n = new Date(), t = new Date(); t.setDate(n.getDate() + 1); return t.getMonth() !== n.getMonth(); })();
    const dueAfterRecord = await page.evaluate(() => window.__prepaidTestHooks.monthlyBackupDue());
    if (isLastDayToday) {
      await assert(dueAfterRecord === curYmStr, `on the last day of the month the due target must roll over from ${prevYmStr} to ${curYmStr} (got "${dueAfterRecord}")`);
      const rollBanner = await page.locator('.banner.warn', { hasText: '지금 저장하기' }).first().innerText();
      await assert(rollBanner.includes(curYmStr), `the rolled-over month-end banner must name ${curYmStr} (got ${JSON.stringify(rollBanner)})`);
      await assert(!rollBanner.includes(prevYmStr), `the month already recorded as backed up must not be named by the banner any more (got ${JSON.stringify(rollBanner)})`);
    } else {
      await assert(await count(page, '[data-a="monthly-backup-now"]') === 0, 'a month already backed up must not show the month-end banner');
      await assert(dueAfterRecord === '', 'monthlyBackupDue() must return empty once the due month is recorded as backed up');
    }
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'no-banner-backed-up.png') }).catch(() => {});

    // (6) 자동 클라우드 트리거: 토글 ON + 등록됨 + due 이면 조용히 서버 백업을 호출한다(네트워크 스파이).
    //     활동 게이트/미등록/토글오프는 호출을 차단한다(스텁 fetch로 검증).
    const spyResult = await page.evaluate(async ({ pubKey }) => {
      const out = {};
      // 등록 상태로 전환 + lastMonthlyBackup 초기화(due 복원)
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('prepaid-ledger-db');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['meta'], 'readwrite');
          tx.objectStore('meta').put({ key: 'restaurantId', value: 'test-rid' });
          tx.objectStore('meta').put({ key: 'lastMonthlyBackup', value: '' });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
      return { pubKey, seeded: true };
    }, { pubKey: mm.pubKey });
    await assert(spyResult.seeded, 'registration state should be seeded for the auto-backup spy');
    // 재로드해 등록 상태를 state에 반영(로드 시 자동 트리거는 더미 서버라 조용히 실패)
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="screen"][data-screen="home"]');
    // fetch 스파이 설치: /api/challenge는 pubKey로 암호화한 토큰을 돌려주고, /api/ledger-backup 호출을 기록한다.
    await page.evaluate(({ pubKey }) => {
      window.__ledgerBackupCalls = [];
      const orig = window.fetch.bind(window);
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      window.fetch = async (u, opts) => {
        const url = String(u);
        if (url.includes('/api/challenge')) {
          const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
          const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, new TextEncoder().encode('TESTTOKEN'));
          return new Response(JSON.stringify({ challenge_ct: u2b(ct) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/ledger-backup')) {
          window.__ledgerBackupCalls.push(url);
          return new Response(JSON.stringify({ ok: true, updated_at: new Date().toISOString() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return orig(u, opts);
      };
    }, { pubKey: mm.pubKey });
    // 성공 경로: 토글 ON + 등록됨 + due 상태에서 트리거 → 서버 호출 발생 + lastMonthlyBackup 기록.
    const fired = await page.evaluate(async () => {
      window.__ledgerBackupCalls = [];
      await window.__prepaidTestHooks.maybeMonthlyAutoBackup();
      return window.__ledgerBackupCalls.length;
    });
    await assert(fired >= 1, 'auto monthly backup should POST to /api/ledger-backup when toggle is on, registered, and due');
    mm = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(mm.lastMonthlyBackup === prevYmStr, 'a successful auto backup should record lastMonthlyBackup for the due month');
    // 기록된 뒤에는 재트리거해도 due가 아니므로 추가 서버 호출이 없어야 한다(1회/로드·중복 방지)
    const again = await page.evaluate(async () => {
      window.__ledgerBackupCalls = [];
      await window.__prepaidTestHooks.maybeMonthlyAutoBackup();
      return window.__ledgerBackupCalls.length;
    });
    if (isLastDayToday) {
      // 말일: 지난달을 기록한 순간 이번 달이 새 대상이 되므로 한 번 더 저장되고, 기록도 이번 달로 넘어간다.
      await assert(again >= 1, `on the last day the rolled-over current month should back up once more (got ${again})`);
      const mmRoll = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
      await assert(mmRoll.lastMonthlyBackup === curYmStr, `the rolled-over backup must record ${curYmStr} (got ${mmRoll.lastMonthlyBackup})`);
    } else {
      await assert(again === 0, 'once recorded, the due month must not trigger another server backup');
    }

    // 정리: 씨앗 지난달 거래·릴레이 메타를 제거해 이후 변조/리셋 시나리오에 영향 주지 않게 한다
    await page.evaluate(({ ts }) => new Promise((resolve) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['transactions', 'meta'], 'readwrite');
        tx.objectStore('transactions').delete('seed-prev-' + ts);
        tx.objectStore('meta').delete('restaurantId');
        tx.oncomplete = () => resolve(true);
      };
    }), { ts: prevTs });
    await page.reload({ waitUntil: 'load' });
    await unlock();
    // 새로고침하면 그룹 펼침 상태(세션 상태)가 초기화되므로 다시 펼쳐야 직원 카드가 보인다.
    await page.waitForSelector('.group-head');
    await expandHomeGroups(page);
    await page.waitForSelector('[data-a="receipt"]');

    // 무결성 실패(변조 감지) 시 증표는 잔액 숫자 대신 경고를 표시해야 한다 (안전장치 ②: 해시체인 재검증)
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['transactions'], 'readwrite');
        const store = tx.objectStore('transactions');
        const g = store.getAll();
        g.onsuccess = () => {
          const all = g.result || [];
          const target = all.find(t => t.txHash);
          if (!target) { reject(new Error('no hashed transaction to tamper')); return; }
          target.afterBalance = Number(target.afterBalance) + 100000; // txHash와 불일치 → 변조 감지
          store.put(target);
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }));
    await page.reload({ waitUntil: 'load' });
    for (const key of ['1', '2', '3', '4']) {
      await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
    }
    await page.waitForSelector('.group-head');
    await expandHomeGroups(page);
    await page.waitForSelector('[data-a="receipt"]');
    await page.locator('[data-a="receipt"]').first().click();
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    await assert(await count(page, '.receipt-warn') === 1, 'a tampered ledger receipt must replace the balance with an integrity warning');
    const warnText = await page.locator('.receipt-warn').innerText();
    await assert(warnText.includes('장부에 이상') && warnText.includes('장부 검사'), 'integrity warning should direct the user to 설정 → 장부 검사');
    await assert(await count(page, '.receipt-bal') === 0, 'no balance figure should be shown when integrity fails');
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.waitForTimeout(50);

    // ───────────────────────────────────────────────────────────────
    // 우리 가게 등록: 실패 롤백(S3) · 성공 후 열쇠 백업 유도(B3) · 배너 닫기(D2)
    // ───────────────────────────────────────────────────────────────
    const metaNow = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(Boolean(metaNow.pubKey), 'a keypair should exist before the store-registration scenarios');
    // 등록 성공 경로는 소유증명(challenge)·연락처 저장까지 이어지므로 페이지 fetch 스파이로 막는다.
    await page.evaluate(({ pubKey }) => {
      const orig = window.fetch.bind(window);
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      window.fetch = async (u, opts) => {
        const url = String(u);
        if (url.includes('/api/challenge')) {
          const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
          const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, new TextEncoder().encode('TESTTOKEN'));
          return new Response(JSON.stringify({ challenge_ct: u2b(ct) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/contact')) return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return orig(u, opts);
      };
    }, { pubKey: metaNow.pubKey });

    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('[data-a="go-register-store"]');
    await assert(await count(page, '[data-a="dismiss-store-banner"]') === 1, 'the finish-registration banner should carry a ✕ dismiss button (D2)');

    const pickStore = async () => {
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await page.waitForSelector('[data-a="go-register-store"]');
      await page.locator('[data-a="go-register-store"]').click();
      await page.waitForSelector('#storeName');
      await page.locator('#storeName').fill('하네스김밥');
      await page.locator('[data-a="relay-search-stores"]').click();
      await page.waitForSelector('[data-a="relay-pick-store"]');
      await page.locator('[data-a="relay-pick-store"]').nth(1).click();
      await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
      await page.waitForTimeout(200);
    };

    // (1) 롤백 경로: register-key 500 → restaurantId가 남아 '받는 중'으로 오표시되면 안 된다.
    registerStatus = 500;
    const callsBeforeFail = registerCalls.length;
    await pickStore();
    await assert(registerCalls.length === callsBeforeFail + 1, 'picking a store should attempt exactly one register-key call');
    let regMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(!regMeta.restaurantId, 'a failed register-key must roll back restaurantId (no false "받는 중" state)');
    await assert(regMeta.storeRegisterPending === true, 'a failed registration must keep storeRegisterPending so the home banner stays');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await assert(await count(page, '[data-a="go-register-store"]') === 1, 'the finish-registration banner must remain after a failed registration');
    await assert(!(await page.locator('.app').innerText()).includes('공공기관 명단 받는 중'), 'a failed registration must not render the "receiving" chip');

    // (2) 성공 경로: register-key 200 → 등록 확정 + 열쇠 백업 유도 + 새 신청 칩
    registerStatus = 200;
    inboxCountBody = { count: 2 };
    await pickStore();
    regMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(regMeta.restaurantId === 'rid-mine-1', 'a successful register-key should persist the picked restaurant id');
    await assert(regMeta.storeRegisterPending === false, 'a successful registration should clear the pending flag');
    const settingsAfterReg = await page.locator('.app').innerText();
    await assert(settingsAfterReg.includes('공공기관 명단 받는 중'), 'the settings auto-enrollment card should label the registered store 공공기관 명단 받는 중');
    await assert(settingsAfterReg.includes('아직 안 함'), 'the key-backup button should carry a ⚠️ badge while the key has never been backed up (B3)');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.evaluate(() => window.__prepaidTestHooks.refreshInboxCount());
    await page.waitForTimeout(300);
    await assert(await count(page, '[data-a="go-register-store"]') === 0, 'the finish-registration banner must disappear once the store is registered');
    await assert((await page.locator('.pill-relay').innerText()).includes('공공기관 명단 받는 중'), 'home should show the 공공기관 명단 받는 중 status chip');
    await assert(await count(page, '[data-a="dismiss-key-banner"]') === 1, 'home should nudge an un-backed-up key with a dismissible banner (B3)');
    const inboxPill = await page.locator('[data-a="relay-inbox"]').innerText();
    await assert(inboxPill.includes('📩') && inboxPill.includes('2건'), 'a 200 inbox-count should render the 📩 new-request chip on home');
    await page.locator('[data-a="dismiss-key-banner"]').click();
    await page.waitForTimeout(150);
    await assert(await count(page, '[data-a="dismiss-key-banner"]') === 0, 'dismissing the key-backup banner should hide it for this session');

    // ───────────────────────────────────────────────────────────────
    // 소속(org) 필드: 저장은 분리, 표시는 무변화
    //   (a) 공공기관 명단(직접 전달) 승인 → org/dept 분리 저장 + 화면은 "공공기관명 부서명" 결합 유지
    //   (b) 소속을 입력한 한 명씩 등록 → 그룹 헤더가 "소속 부서"
    //   (c) 소속을 비운 등록 → 현행과 동일(부서만)
    //   (d) CSV 소속 열 임포트
    //   (e) 동일인 판정 키 org|dept|name — 같은 키 재등록은 충전 유도, org만 다르면 별개 직원
    // ───────────────────────────────────────────────────────────────
    // 직접 전달 성공 후 뒤따르는 "백업 갱신" 확인창이 존재하지 않는 서버로 나가지 않도록 스텁을 덧씌운다.
    await page.evaluate(() => {
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const url = String(u);
        if (url.includes('/api/ledger-backup')) return new Response('{"ok":true,"updated_at":"2026-07-01T00:00:00Z"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return orig(u, o);
      };
    });
    // 담당자 전달 파일(직접 전달)을 실제 계약대로 만들어 연다 — 서버를 거치지 않는 경로.
    const dtJson = await page.evaluate(async ({ pubKey, rid }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const items = [{ name: '공공직원', dept: '세무과', amount: 30000 }];
      const h = async t => { const d = await crypto.subtle.digest('SHA-256', enc.encode(String(t))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
      const aesRaw = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
      return JSON.stringify({
        v: 1, type: 'direct-transfer', restaurant_id: rid, restaurant_name: 'Harness Shop',
        institution: '강남구청', department: '세무과', year_month: '2026-07',
        summary: { total_amount: 30000, member_count: 1, batch_hash },
        ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
      });
    }, { pubKey: regMeta.pubKey, rid: regMeta.restaurantId });
    await page.locator('#directTransferFile').setInputFiles({ name: 'transfer.json', mimeType: 'application/json', buffer: Buffer.from(dtJson, 'utf8') });
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    const orgDb = await readDb(page);
    const empRelay = orgDb.employees.find(e => e.name === '공공직원');
    await assert(Boolean(empRelay), 'a direct-transfer batch should create the employee');
    await assert(empRelay.org === '강남구청', 'the institution must be stored in the new org field, not merged into dept');
    await assert(empRelay.dept === '세무과', 'the department must be stored on its own (no "기관명 부서명" concatenation)');
    await assert(empRelay.orgKind === 'public', 'a direct-transfer (institution) employee must be flagged orgKind=public for home grouping');

    // 레거시(합성 dept, org 없음) 직원을 심어 표시 결과가 신규 저장 방식과 동일함을 확인한다.
    await page.evaluate(({ t }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['employees'], 'readwrite');
        tx.objectStore('employees').put({ id: 'legacy-org-1', dept: '서초구청 총무과', name: '레거시직원', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t, updatedAt: t });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { t: Date.now() });
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    const homeGroupTitles = async () => (await page.locator('.group-title').allInnerTexts()).map(t => t.trim());
    let titles = await homeGroupTitles();
    // (a) 공공기관(자동 등록) 그룹 헤더는 항상 "기관명 부서명" 결합 라벨이다(beta.15).
    await assert(titles.includes('강남구청 세무과'), `an auto-enrolled institution group header should show the combined "기관명 부서명" label (got ${JSON.stringify(titles)})`);
    await assert(!titles.includes('세무과'), 'a public group header must not drop the institution name');
    // (d) 레거시(합성 dept, org 없음) 직원의 헤더는 예전 그대로 결합 라벨을 유지한다.
    await assert(titles.includes('서초구청 총무과'), 'a legacy employee (concatenated dept, no org) must keep its combined header unchanged');
    await expandHomeGroups(page);
    const relayCardText = await page.locator('.card.employee', { hasText: '공공직원' }).first().innerText();
    await assert(relayCardText.includes('강남구청 세무과'), 'the employee card dept line should still show the combined org+dept label');

    // (b)(c) 소속을 입력한 등록 / 소속을 비운 등록
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empOrg');
    await page.locator('#empOrg').fill('한빛물산');
    await page.locator('#empDept').fill('총무부');
    await page.locator('#empName').fill('소속직원');
    await page.locator('#empOpen').fill('30000');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(250);
    let orgEmps = (await readDb(page)).employees;
    const empCorp = orgEmps.find(e => e.name === '소속직원');
    await assert(Boolean(empCorp) && empCorp.org === '한빛물산' && empCorp.dept === '총무부', 'the optional 소속 input should be saved into org, separate from dept');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    titles = await homeGroupTitles();
    // (b) 회사(소속이 있고 공공기관·개인이 아닌 경우) 헤더 = 회사명만, 부서는 펼쳤을 때 소제목으로 나온다.
    await assert(titles.includes('한빛물산'), `an employee registered with a company 소속 should be grouped under the company name alone (got ${JSON.stringify(titles)})`);
    await assert(!titles.some(t => t.includes('한빛물산 총무부')), 'a company group header must not repeat the department name');
    await page.locator('.group-head', { hasText: '한빛물산' }).first().click();
    await page.waitForTimeout(150);
    const corpGroup = page.locator('.card.group', { hasText: '한빛물산' }).first();
    const corpSubs = (await corpGroup.locator('.group-sub').allInnerTexts()).map(t => t.trim());
    await assert(corpSubs.includes('총무부'), `expanding a company group should list its department as a sub-heading (got ${JSON.stringify(corpSubs)})`);
    await assert((await corpGroup.locator('.card.employee').count()) === 1, 'the company group should hold its employee card under the department sub-heading');
    await assert(titles.includes('Dept A'), 'an employee registered with an empty 소속 must behave exactly as before (dept only)');

    // (c) 소속='개인' → 홈에서 "개인" 그룹 하나로 묶인다.
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empOrg');
    await page.locator('#empOrg').fill('개인');
    await page.locator('#empName').fill('개인고객');
    await page.locator('#empOpen').fill('11000');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(250);
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    titles = await homeGroupTitles();
    await assert(titles.filter(t => t === '개인').length === 1, `소속='개인' employees should land in exactly one "개인" group (got ${JSON.stringify(titles)})`);
    // 정렬(beta.16): ① 공공기관(기관명 가나다 → 부서 오름차순) ② 그 외 전부 한 블록으로 제목 가나다.
    await assert(titles[0] === '강남구청 세무과', `the only public group must sort ahead of every non-public group (got ${JSON.stringify(titles)})`);
    const restTitles = titles.slice(1);
    await assert(restTitles.join('|') === restTitles.slice().sort((a, b) => a.localeCompare(b, 'ko')).join('|'),
      `every non-public group (회사·개인·무소속) must form ONE 가나다 block (got ${JSON.stringify(restTitles)})`);
    // 합쳐진 블록의 증거 — 옛 규칙(회사 → 개인 → 무소속)이면 한빛물산이 개인보다 앞이고 Dept A가 마지막이 아니다.
    await assert(restTitles.indexOf('개인') < restTitles.indexOf('한빛물산'), `"개인" must now sort before "한빛물산" by title, not by kind (got ${JSON.stringify(restTitles)})`);
    await assert(restTitles.indexOf('서초구청 총무과') < restTitles.indexOf('한빛물산'), `a legacy group must sort by title against a company group (got ${JSON.stringify(restTitles)})`);
    await assert(restTitles.indexOf('한빛물산') < restTitles.indexOf('Dept A'), `ko collation puts Latin titles last inside the merged block (got ${JSON.stringify(restTitles)})`);

    // (e) 동일인 판정 키 org|dept|name
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    const dupDialogsBefore = dialogs.length;
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empOrg');
    await page.locator('#empOrg').fill('한빛물산');
    await page.locator('#empDept').fill('총무부');
    await page.locator('#empName').fill('소속직원');
    await page.locator('#empOpen').fill('5000');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(250);
    const dupConfirm = dialogs.slice(dupDialogsBefore).find(d => d.type === 'confirm' && d.message.includes('이미 등록되어'));
    await assert(Boolean(dupConfirm), 're-registering the same org|dept|name must offer a top-up instead of creating a duplicate');
    await assert(dupConfirm.message.includes('한빛물산 총무부'), 'the duplicate prompt should identify the employee by the combined 소속·부서 label');
    orgEmps = (await readDb(page)).employees;
    await assert(orgEmps.filter(e => e.name === '소속직원').length === 1, 'the top-up path must not create a second employee record');
    // 같은 부서·이름이라도 소속이 다르면 별개 직원이어야 한다(매칭 키 확장의 핵심).
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empOrg');
    await page.locator('#empOrg').fill('다른상사');
    await page.locator('#empDept').fill('총무부');
    await page.locator('#empName').fill('소속직원');
    await page.locator('#empOpen').fill('7000');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(250);
    orgEmps = (await readDb(page)).employees;
    await assert(orgEmps.filter(e => e.name === '소속직원').length === 2, 'the same dept+name under a different 소속 must be a separate employee');

    // (d) CSV 소속 열 임포트 — 소속이 일치하는 기존 직원은 추가 충전, 새 소속·이름은 신규
    const csvBody = '소속,부서,이름,금액\r\n한빛물산,총무부,소속직원,3000\r\n한빛물산,총무부,씨에스브이,15000\r\n';
    await page.locator('#csvFile').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + csvBody, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 5000 });
    const csvHeaders = await page.locator('.csv-table th').allInnerTexts();
    await assert(csvHeaders.some(h => h.trim() === '소속'), 'the CSV preview should add a 소속 column when the file carries one');
    const csvBodyText = await page.locator('.csv-table').innerText();
    await assert(csvBodyText.includes('추가 충전') && csvBodyText.includes('신규'), 'org-aware matching should mark the known employee as a top-up and the new one as new');
    await page.locator('[data-a="exec-csv"]').click();
    await page.waitForTimeout(400);
    orgEmps = (await readDb(page)).employees;
    const empCsv = orgEmps.find(e => e.name === '씨에스브이');
    await assert(Boolean(empCsv) && empCsv.org === '한빛물산' && empCsv.dept === '총무부', 'a CSV 소속 column should land in org, not be merged into dept');
    await assert(orgEmps.filter(e => e.name === '소속직원').length === 2, 'the CSV top-up row must not duplicate the matched employee');

    // (f) "소속부서" 한 칸짜리 헤더: 소속 열로도 읽혀 org=dept로 중복 저장되면 안 된다(부서로만 처리).
    const mergedHeaderCsv = '소속부서,이름,금액\r\n영업1과,단일칸직원,10000\r\n';
    await page.locator('#csvFile').setInputFiles({ name: 'merged-header.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + mergedHeaderCsv, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 5000 });
    const mergedHeaders = await page.locator('.csv-table th').allInnerTexts();
    await assert(!mergedHeaders.some(h => h.trim() === '소속'), 'a single "소속부서" column must not be treated as a 소속 column in the preview');
    await page.locator('[data-a="exec-csv"]').click();
    await page.waitForTimeout(400);
    orgEmps = (await readDb(page)).employees;
    const empMerged = orgEmps.find(e => e.name === '단일칸직원');
    await assert(Boolean(empMerged), 'the "소속부서" CSV row should be imported');
    await assert(!empMerged.org && empMerged.dept === '영업1과', `a "소속부서" header must land in dept only (org must stay empty), got org="${empMerged.org}" dept="${empMerged.dept}"`);

    // (g) 레거시(합성 dept, org 없음) 직원 + 소속·부서가 분리된 CSV → 화면 라벨이 같으므로 "충전"이어야 한다(신규 카드 금지).
    const legacyCsv = '소속,부서,이름,금액\r\n서초구청,총무과,레거시직원,4000\r\n';
    await page.locator('#csvFile').setInputFiles({ name: 'legacy-match.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + legacyCsv, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 5000 });
    const legacyPreview = await page.locator('.csv-table').innerText();
    await assert(legacyPreview.includes('추가 충전'), 'a split 소속/부서 CSV row must match the legacy concatenated-dept employee as a top-up, not a new employee');
    await page.locator('[data-a="exec-csv"]').click();
    await page.waitForTimeout(400);
    const afterLegacyCsv = await readDb(page);
    await assert(afterLegacyCsv.employees.filter(e => e.name === '레거시직원').length === 1, 'matching a legacy employee must not create a visually identical duplicate card');
    const legacyTopup = afterLegacyCsv.transactions.find(tx => tx.employeeId === 'legacy-org-1' && tx.type === 'topup');
    await assert(Boolean(legacyTopup) && Number(legacyTopup.amount) === 4000, 'the legacy match should be recorded as a top-up transaction on the existing employee');

    // (h) 같은 명단을 다음 달에 다시 승인(자동 등록 수신함) → 새 직원이 아니라 기존 직원 충전, 카드 수 불변.
    const relayMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await page.evaluate(async ({ pubKey }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const h = async t => { const d = await crypto.subtle.digest('SHA-256', enc.encode(String(t))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      // 지난달과 같은 직원(공공직원 · 강남구청 세무과), 이번 달치 금액만 다른 명단.
      const items = [{ name: '공공직원', dept: '세무과', amount: 20000 }];
      const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
      const aesRaw = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
      const inboxItem = {
        summary_id: 'sum-next-month',
        summary: { restaurant_name: 'Harness Shop', institution: '강남구청', department: '세무과', year_month: '2026-08', total_amount: 20000, member_count: 1, batch_hash },
        ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
      };
      window.__approveCalls = [];
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const url = String(u);
        if (url.includes('/api/inbox?')) return new Response(JSON.stringify([inboxItem]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/api/approve')) { window.__approveCalls.push(url); return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        if (url.includes('/api/challenge')) {
          const pk = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
          const cc = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pk, enc.encode('TESTTOKEN'));
          return new Response(JSON.stringify({ challenge_ct: u2b(cc) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/ledger-backup')) return new Response('{"ok":true,"updated_at":"2026-08-01T00:00:00Z"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return orig(u, o);
      };
    }, { pubKey: relayMeta.pubKey });
    const beforeApprove = await readDb(page);
    const activeBefore = beforeApprove.employees.filter(e => !e.isDeleted).length;
    await page.locator('[data-a="relay-inbox"]').first().click();
    await page.waitForSelector('[data-a="relay-approve"]', { timeout: 8000 });
    await page.locator('[data-a="relay-approve"]').click();
    await page.waitForSelector('[data-a="relay-approve"]', { state: 'detached', timeout: 15000 });
    await page.waitForTimeout(500);
    const afterApprove = await readDb(page);
    await assert(afterApprove.employees.filter(e => e.name === '공공직원').length === 1, 're-approving the same roster must top up the existing employee instead of stacking a duplicate card');
    await assert(afterApprove.employees.filter(e => !e.isDeleted).length === activeBefore, 'the active employee card count must not change when a known roster is approved again');
    const relayEmpId = afterApprove.employees.find(e => e.name === '공공직원').id;
    const relayTopup = afterApprove.transactions.find(tx => tx.employeeId === relayEmpId && tx.type === 'topup');
    await assert(Boolean(relayTopup) && Number(relayTopup.amount) === 20000, 'the second approval should be recorded as a top-up transaction of the new amount');
    const relayBalance = afterApprove.transactions.filter(tx => tx.employeeId === relayEmpId).reduce((s, tx) => s + (tx.type === 'use' ? -Number(tx.amount || 0) : Number(tx.amount || 0)), 0);
    await assert(relayBalance === 50000, `the topped-up employee balance should be 30000 + 20000, got ${relayBalance}`);
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(100);

    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('[data-a="quick-find-emp"]');

    // ───────────────────────────────────────────────────────────────
    // 안드로이드 하단 뒤로가기: 히스토리 동기화 계층 (돈 다루는 앱 — 안전 최우선)
    //   OS 뒤로가기는 브라우저 히스토리를 소진해 popstate를 발생시키므로 history.back()으로 충실히 흉내낸다.
    // ───────────────────────────────────────────────────────────────
    const back = async () => { await page.evaluate(() => window.history.back()); await page.waitForTimeout(140); };
    const bt = () => page.evaluate(() => ({ armed: window.__prepaidBackTest.armed(), screen: window.__prepaidBackTest.screen(), modal: window.__prepaidBackTest.modal(), locked: window.__prepaidBackTest.locked() }));
    // 시작 지점 정리: 홈·모달 없음·잠금 해제
    await page.evaluate(() => window.__prepaidBackTest.disarm());
    let st = await bt();
    await assert(st.screen === 'home' && !st.modal && !st.locked, 'back-nav suite should start on home, no modal, unlocked');

    // (a) 설정 화면에서 뒤로가기 → 홈 (앱 유지)
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForTimeout(80);
    st = await bt();
    await assert(st.screen === 'settings', 'nav to settings should set screen=settings');
    await back();
    st = await bt();
    await assert(st.screen === 'home' && !st.modal, '(a) back from settings should return to home, app still alive');
    await assert(await count(page, '[data-a="quick-find-emp"]') === 1, '(a) home content should be rendered after back');

    // (b) 모달을 열고 뒤로가기 → 모달만 닫힘, 화면(홈) 유지
    await page.locator('[data-a="receipt"]').first().click();
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    st = await bt();
    await assert(st.modal === 'receipt', 'opening receipt should set an active modal');
    await back();
    st = await bt();
    await assert(!st.modal && st.screen === 'home', '(b) back should close the modal and keep the home screen');
    await assert(await count(page, '.modal-back') === 0, '(b) modal DOM should be gone after back');

    // (e) 뒤로 1번 = 1단계: 모달만 열었을 때 back 한 번에 모달 닫힘 + 홈 유지(종료 안 됨), armed=false
    await page.locator('[data-a="receipt"]').first().click();
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    await back();
    st = await bt();
    await assert(!st.modal && st.screen === 'home' && st.armed === false, '(e) one back = one step: modal closed, home kept, exit NOT yet armed');

    // (d) usage(사용) 모달에서 금액 입력 후 뒤로가기 → 모달 닫힘 + 트랜잭션 미생성(닫기 only, 저장/차감 없음)
    //     카드의 [사용] 버튼으로 직접 연다(검색 없이). 뒤로가기가 저장/차감을 실행하지 않음을 검증한다.
    const txBefore = (await readDb(page)).transactions.length;
    await page.locator(`[data-a="use"][data-id="${empA.id}"]`).click();
    await page.waitForSelector('#useAmount');
    await page.locator('#useAmount').fill('9999');
    st = await bt();
    await assert(st.modal === 'usage', 'usage modal should be open before back');
    await back();
    st = await bt();
    await assert(!st.modal, '(d) back should close the usage modal');
    const txAfter = (await readDb(page)).transactions.length;
    await assert(txAfter === txBefore, '(d) back from usage must NOT create a transaction (close only, no save/deduct)');

    // (c) 홈에서 뒤로가기 → "한 번 더 누르면 종료" 토스트 + 즉시 종료 안 됨(앱 유지, armed=true)
    await page.evaluate(() => window.__prepaidBackTest.disarm());
    await back();
    st = await bt();
    await assert(st.armed === true, '(c) back on home should arm the "press again to exit" guard');
    await assert(st.screen === 'home' && !st.modal, '(c) app must NOT exit immediately on the first home back');
    const toastTxt = await page.locator('.toast').innerText().catch(() => '');
    await assert(toastTxt.includes('한 번 더'), '(c) a "press once more to exit" toast should be shown');
    await page.evaluate(() => window.__prepaidBackTest.disarm());

    // (f) PIN 잠금 상태에서 뒤로가기 → 잠금 유지(홈 안 열림, 잠금 우회 금지)
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('[data-a="pin-key"]');
    st = await bt();
    await assert(st.locked === true, 'app should be PIN-locked after reload');
    await back();
    st = await bt();
    await assert(st.locked === true, '(f) back on the lock screen must keep the app locked (no lock bypass)');
    await assert(await count(page, '.pin-screen') === 1 && await count(page, '.nav') === 0, '(f) lock screen must remain; home/nav must not appear');

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

    // ───────────────────────────────────────────────────────────────
    // 홈 그룹 회귀 (집중 리뷰 7건) — 초기화 직후의 빈 장부에 시나리오별 데이터를 직접 심어 검증한다.
    //   원칙 고정: 매칭 키(orgDeptLabel + 이름)와 충전 로직은 아래 어떤 검증에서도 바뀌지 않는다.
    // ───────────────────────────────────────────────────────────────
    inboxCountBody = null;
    const pinHash = crypto.createHash('sha256').update('1234').digest('hex');
    // 시드 → 리로드 → PIN 해제까지 한 번에. 직원·거래는 매번 새로 깔고(clear) 나머지 메타는 인자로 덧붙인다.
    const seedHome = async (emps, extraMeta = {}) => {
      await page.evaluate(({ emps, hash, t, extraMeta }) => new Promise((resolve, reject) => {
        const req = indexedDB.open('prepaid-ledger-db');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['employees', 'transactions', 'meta'], 'readwrite');
          const es = tx.objectStore('employees'), ts = tx.objectStore('transactions'), ms = tx.objectStore('meta');
          es.clear(); ts.clear();
          emps.forEach((e, i) => {
            es.put({ id: e.id, org: e.org || '', orgKind: e.orgKind || '', dept: e.dept || '', name: e.name, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t, updatedAt: t });
            ts.put({ id: 'grp-tx-' + i, employeeId: e.id, type: 'open', amount: e.amount || 1000, beforeBalance: 0, afterBalance: e.amount || 1000, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: t });
          });
          ms.put({ key: 'setupComplete', value: true });
          ms.put({ key: 'termsAgreedAt', value: t });
          ms.put({ key: 'storeRegisterPending', value: false });
          ms.put({ key: 'pinHash', value: hash });
          ms.put({ key: 'shopName', value: 'Harness Shop' });
          ms.put({ key: 'departments', value: [] });
          Object.entries(extraMeta).forEach(([k, v]) => ms.put({ key: k, value: v }));
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
      }), { emps, hash: pinHash, t: Date.now(), extraMeta });
      await page.reload({ waitUntil: 'load' });
      await unlock();
      await page.waitForSelector('[data-a="quick-find-emp"]', { timeout: 8000 });
    };
    const groupTitles = async () => (await page.locator('.group-title').allInnerTexts()).map(t => t.trim());
    const filterOptions = async () => (await page.locator('#deptFilterSelect option').allInnerTexts()).map(t => t.trim());
    const balanceOfId = (db, id) => db.transactions.filter(tx => tx.employeeId === id).reduce((s, tx) => s + (tx.type === 'use' ? -Number(tx.amount || 0) : Number(tx.amount || 0)), 0);
    // 설정 > 직원 목록 관리는 부서별 아코디언이다(펼침 상태가 세션 내 유지됨) — 이름으로 행을 찾아 [수정]을 연다.
    const openEditFor = async (name) => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await page.waitForTimeout(200);
      for (let guard = 0; guard < 12; guard += 1) {
        const btn = page.locator('.row', { hasText: name }).locator('[data-a="edit-employee"]');
        if (await btn.count()) { await btn.first().click(); await page.waitForSelector('#empOrg'); return; }
        const collapsed = page.locator('.mgr-head', { hasText: '▶' });
        if (!(await collapsed.count())) break;
        await collapsed.first().click();
        await page.waitForTimeout(120);
      }
      throw new Error(`could not open the edit modal for ${name}`);
    };

    // (1) 부분 백필 — 레거시 3명(합성 dept) 중 2명만 이번 달 명단에 있어도 홈에서는 한 부서(한 그룹)로 남아야 한다.
    //     같은 결합 라벨 = 같은 그룹이라는 원칙상, 명단에 이름이 없는 동료도 함께 소속·부서 분리 저장으로 정리된다.
    await seedHome([
      { id: 'bf-1', org: '', orgKind: '', dept: '강남구청 세무과', name: '김레거시', amount: 5000 },
      { id: 'bf-2', org: '', orgKind: '', dept: '강남구청 세무과', name: '박레거시', amount: 6000 },
      { id: 'bf-3', org: '', orgKind: '', dept: '강남구청 세무과', name: '명단없음', amount: 7000 }
    ], { restaurantId: 'rid-group-1', relayStoreName: 'Harness Shop', relayRegisteredAt: Date.now() });
    await assert((await groupTitles()).length === 1, 'the three legacy employees should start as a single combined-label group');
    // 백업 갱신 확인(승인 직후 confirm)이 실제 서버로 나가지 않게 도장을 찍어둔다.
    await page.evaluate(({ pub }) => {
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const url = String(u);
        if (url.includes('/api/challenge')) {
          const pk = await crypto.subtle.importKey('spki', b2u(pub).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
          const cc = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pk, new TextEncoder().encode('TESTTOKEN'));
          return new Response(JSON.stringify({ challenge_ct: u2b(cc) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/ledger-backup')) return new Response('{"ok":true,"updated_at":"2026-07-01T00:00:00Z"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return orig(u, o);
      };
    }, { pub: (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {}).pubKey });
    // 부서 필터를 레거시 그룹에 걸어둔 상태로 수신한다 — 백필로 그룹 키가 바뀌어도 화면이 막히면 안 된다(자기치유).
    await page.locator('#deptFilterSelect').selectOption({ index: 1 });
    await page.waitForTimeout(150);
    const bfMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    const bfJson = await page.evaluate(async ({ pubKey, rid }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      // 3명 중 2명만 명단에 있고, 1명은 신규다.
      const items = [{ name: '김레거시', dept: '세무과', amount: 1000 }, { name: '박레거시', dept: '세무과', amount: 2000 }, { name: '신규직원', dept: '세무과', amount: 3000 }];
      const h = async t => { const d = await crypto.subtle.digest('SHA-256', enc.encode(String(t))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
      const aesRaw = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
      return JSON.stringify({
        v: 1, type: 'direct-transfer', restaurant_id: rid, restaurant_name: 'Harness Shop',
        institution: '강남구청', department: '세무과', year_month: '2026-07',
        summary: { total_amount: 6000, member_count: 3, batch_hash },
        ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
      });
    }, { pubKey: bfMeta.pubKey, rid: 'rid-group-1' });
    await page.locator('#directTransferFile').setInputFiles({ name: 'partial.json', mimeType: 'application/json', buffer: Buffer.from(bfJson, 'utf8') });
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    const bfDb = await readDb(page);
    const bfLeft = bfDb.employees.find(e => e.name === '명단없음');
    await assert(Boolean(bfLeft) && bfLeft.org === '강남구청' && bfLeft.dept === '세무과' && bfLeft.orgKind === 'public',
      `an active colleague with the same combined label must be backfilled too, even when this month's roster omits them (got org="${bfLeft && bfLeft.org}" dept="${bfLeft && bfLeft.dept}" orgKind="${bfLeft && bfLeft.orgKind}")`);
    await assert(balanceOfId(bfDb, 'bf-3') === 7000, 'backfilling a colleague who is not on the roster must not touch their balance');
    await assert(bfDb.employees.filter(e => !e.isDeleted).length === 4, 'the roster should add exactly one new employee (2 matched + 1 new)');
    let bfTitles = await groupTitles();
    await assert(bfTitles.length === 1 && bfTitles[0] === '강남구청 세무과', `a partially-matched roster must leave one single home group titled "기관명 부서명", not split the department in two (got ${JSON.stringify(bfTitles)})`);
    await assert((await page.locator('.group-meta').first().innerText()).includes('직원 4명'), 'the single group should hold all four employees');
    await assert(await count(page, '.card.empty') === 0, 'the stale department filter must heal itself instead of showing an empty home');
    await assert((await page.locator('#deptFilterSelect').inputValue()) === '', 'a department filter whose group key no longer exists should fall back to 전체 부서');

    // (2) 공공기관 '세무과'와 무소속 '세무과'는 이제 결합 라벨 덕분에 꼬리표 없이도 서로 구분된다(beta.15).
    await seedHome([
      { id: 'dup-1', org: '강남구청', orgKind: 'public', dept: '세무과', name: '공공갑', amount: 1000 },
      { id: 'dup-2', org: '', orgKind: '', dept: '세무과', name: '무소속을', amount: 2000 },
      { id: 'dup-3', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '회사병', amount: 3000 }
    ]);
    const dupTitles = await groupTitles();
    await assert(new Set(dupTitles).size === dupTitles.length, `home group headers must be unique — the owner cannot tell two identically titled groups apart (got ${JSON.stringify(dupTitles)})`);
    await assert(dupTitles.includes('강남구청 세무과'), `the public group should read "기관명 부서명" with no qualifier (got ${JSON.stringify(dupTitles)})`);
    await assert(dupTitles.includes('세무과'), `the unaffiliated group keeps its bare label — the combined public title already distinguishes them (got ${JSON.stringify(dupTitles)})`);
    await assert(!dupTitles.some(t => t.includes('(')), `no qualifier tail should be needed when titles already differ (got ${JSON.stringify(dupTitles)})`);
    const dupOpts = (await filterOptions()).slice(1);
    await assert(new Set(dupOpts).size === dupOpts.length, `department filter options must be unique too (got ${JSON.stringify(dupOpts)})`);
    await assert(dupOpts.join('|') === dupTitles.join('|'), `filter option wording must match the group headers 1:1 (opts ${JSON.stringify(dupOpts)} vs titles ${JSON.stringify(dupTitles)})`);
    // 겹치지 않는 회사 그룹에는 군더더기 꼬리표가 붙지 않는다.
    await assert(dupTitles.includes('한빛물산'), 'a group whose title does not collide must stay unqualified');

    // (2-a) 안전망 유지 — 종류가 다른 그룹끼리 제목이 진짜로 겹치면(회사명을 결합 라벨과 똑같이 입력) 꼬리표가 붙어야 한다.
    await seedHome([
      { id: 'clash-1', org: '강남구청', orgKind: 'public', dept: '세무과', name: '공공갑', amount: 1000 },
      { id: 'clash-2', org: '강남구청 세무과', orgKind: '', dept: '', name: '회사을', amount: 2000 },
      { id: 'clash-3', org: '', orgKind: '', dept: '강남구청 세무과', name: '레거시병', amount: 3000 }
    ]);
    const clashTitles = await groupTitles();
    await assert(new Set(clashTitles).size === clashTitles.length, `titles that really collide across kinds must still be disambiguated (got ${JSON.stringify(clashTitles)})`);
    await assert(clashTitles.includes('강남구청 세무과 (공공기관)'), `a colliding public group should be tagged 공공기관 (got ${JSON.stringify(clashTitles)})`);
    await assert(clashTitles.includes('강남구청 세무과 (회사)'), `a colliding company group should be tagged 회사 (got ${JSON.stringify(clashTitles)})`);
    await assert(clashTitles.includes('강남구청 세무과 (소속 없음)'), `a colliding legacy group should be tagged 소속 없음 (got ${JSON.stringify(clashTitles)})`);
    const clashOpts = (await filterOptions()).slice(1);
    await assert(clashOpts.join('|') === clashTitles.join('|'), `filter options must mirror the disambiguated headers (opts ${JSON.stringify(clashOpts)} vs titles ${JSON.stringify(clashTitles)})`);

    // (2-c) 그룹 순서(beta.16) — ① 공공기관(기관명 가나다 → 부서 오름차순) ② 그 외 전부 한 블록으로 제목 가나다.
    await seedHome([
      { id: 'ord-1', org: '서초구청', orgKind: 'public', dept: '세무과', name: '가', amount: 1000 },
      { id: 'ord-2', org: '강남구청', orgKind: 'public', dept: '총무과', name: '나', amount: 1000 },
      { id: 'ord-3', org: '강남구청', orgKind: 'public', dept: '세무과', name: '다', amount: 1000 },
      { id: 'ord-4', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '라', amount: 1000 },
      { id: 'ord-5', org: '가나상사', orgKind: '', dept: '', name: '마', amount: 1000 },
      { id: 'ord-6', org: '개인', orgKind: '', dept: '', name: '바', amount: 1000 },
      { id: 'ord-7', org: '', orgKind: '', dept: '흥부식당 배달팀', name: '사', amount: 1000 },
      { id: 'ord-8', org: '', orgKind: '', dept: '가정지원과', name: '아', amount: 1000 }
    ]);
    const ordTitles = await groupTitles();
    // 공공기관 3개가 먼저(강남구청 세무과 → 강남구청 총무과 → 서초구청 세무과), 나머지 5개는 종류 구분 없이 제목 가나다.
    const ordExpected = ['강남구청 세무과', '강남구청 총무과', '서초구청 세무과', '가나상사', '가정지원과', '개인', '한빛물산', '흥부식당 배달팀'];
    await assert(ordTitles.join('|') === ordExpected.join('|'),
      `home groups must sort 공공기관(기관→부서) first, then ALL other groups as one 가나다 block (expected ${JSON.stringify(ordExpected)}, got ${JSON.stringify(ordTitles)})`);
    const ordOpts = (await filterOptions()).slice(1);
    await assert(ordOpts.join('|') === ordExpected.join('|'), `the department filter must follow the same group order (got ${JSON.stringify(ordOpts)})`);
    // 설정 > 직원 목록 관리도 같은 원칙으로 정렬된다(그룹핑 키는 결합 라벨 그대로 — 순서만 맞춘다).
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForTimeout(200);
    const mgrTitles = (await page.locator('.mgr-dept').allInnerTexts()).map(t => t.trim());
    // 설정 화면의 그룹 이름은 결합 라벨(deptKey) 그대로다 — 회사는 홈과 달리 "회사명 부서명"으로 묶인다(그룹핑 키 불변, 순서만 변경).
    // 정렬 1차키는 회사명('한빛물산')이므로 "한빛물산 영업1팀"은 홈의 '한빛물산'과 같은 자리에 들어간다.
    const mgrExpected = ['강남구청 세무과', '강남구청 총무과', '서초구청 세무과', '가나상사', '가정지원과', '개인', '한빛물산 영업1팀', '흥부식당 배달팀'];
    await assert(mgrTitles.join('|') === mgrExpected.join('|'),
      `설정 > 직원 목록 관리 groups must follow the same order as home (expected ${JSON.stringify(mgrExpected)}, got ${JSON.stringify(mgrTitles)})`);
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(150);

    // (2-b) 그룹 키는 자유 입력 문자열로 깨지지 않아야 한다(구분자 이스케이프) — 두 그룹이 한 그룹으로 합쳐지면 잔액 소계가 섞인다.
    await seedHome([
      { id: 'sep-1', org: 'A⟩B', orgKind: 'public', dept: 'C', name: '첫째', amount: 1000 },
      { id: 'sep-2', org: 'A', orgKind: 'public', dept: 'B⟩C', name: '둘째', amount: 2000 }
    ]);
    await assert(await count(page, '.group-head') === 2, 'a separator character typed into 소속/부서 must not merge two different groups into one');
    const sepKeys = await page.$$eval('.group-head', els => els.map(el => el.dataset.g));
    await assert(new Set(sepKeys).size === 2, `group keys must stay distinct for values containing the separator (got ${JSON.stringify(sepKeys)})`);

    // (3) 필터를 켠 채 소속을 수정하면 필터 키가 사라진다 → 홈 복귀 시 전체 부서로 자기치유되고 직원이 보여야 한다.
    await seedHome([
      { id: 'heal-1', org: 'A사', orgKind: '', dept: '1팀', name: '갑', amount: 1000 },
      { id: 'heal-2', org: 'B사', orgKind: '', dept: '2팀', name: '을', amount: 2000 }
    ]);
    await page.locator('#deptFilterSelect').selectOption({ label: 'A사' });
    await page.waitForTimeout(150);
    await assert(await count(page, '.group-head') === 1, 'picking a company filter should leave that group only');
    await openEditFor('갑');
    await page.locator('#empOrg').fill('A사(변경)');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(250);
    await assert((await page.locator('#deptFilterSelect').inputValue()) === '', 'editing the filtered group away should reset the filter to 전체 부서');
    await assert(await count(page, '.card.empty') === 0, 'home must not be stuck on "검색 결과가 없습니다" after the filtered group key changed');
    await assert(await count(page, '.group-head') === 2, 'both groups should be listed again after the filter healed');
    await assert((await groupTitles()).includes('A사(변경)'), 'the renamed 소속 should show up as its own group');

    // (4) 자동 등록(공공기관) 직원의 소속을 '개인'으로 바꾸면 개인 그룹으로 옮겨져야 한다(orgKind 고착 금지).
    await seedHome([
      { id: 'kind-1', org: '강남구청', orgKind: 'public', dept: '세무과', name: '공공직원', amount: 4000 },
      { id: 'kind-2', org: '강남구청', orgKind: 'public', dept: '세무과', name: '남는직원', amount: 5000 }
    ]);
    const movedName = '공공직원', stayName = '남는직원';
    await openEditFor(movedName);
    await page.locator('#empOrg').fill('개인');
    await page.locator('#empDept').fill('');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(200);
    const kindDb = await readDb(page);
    const kindEdited = kindDb.employees.find(e => e.name === movedName);
    await assert(kindEdited.org === '개인' && kindEdited.dept === '' && kindEdited.orgKind === '',
      `changing 소속/부서 by hand must clear the auto-enrollment grouping flag (got org="${kindEdited.org}" orgKind="${kindEdited.orgKind}")`);
    const kindTitles = await groupTitles();
    await assert(kindTitles.includes('개인'), `an employee moved to 소속='개인' must land in the 개인 group (got ${JSON.stringify(kindTitles)})`);
    await assert(kindTitles.includes('강남구청 세무과'), 'the untouched colleague should stay in the institution group');
    // 소속·부서를 그대로 두고 메모만 고치면 표식은 유지된다(자동 등록 이력 보존).
    await openEditFor(stayName);
    await page.locator('#empNote').fill('메모만 변경');
    await page.locator('[data-a="save-employee"]').click();
    await page.waitForTimeout(300);
    const keptKind = (await readDb(page)).employees.find(e => e.name === stayName);
    await assert(keptKind.orgKind === 'public', 'editing only the memo must keep orgKind=public (the employee did not move)');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(200);

    // (5) 그룹 헤더 키보드 조작 — role="button"이므로 Enter/Space로도 펼치고 접을 수 있어야 한다.
    await seedHome([
      { id: 'kb-1', org: 'A사', orgKind: '', dept: '1팀', name: '갑', amount: 1000 },
      { id: 'kb-2', org: 'B사', orgKind: '', dept: '2팀', name: '을', amount: 2000 }
    ]);
    await assert(await count(page, '.card.employee') === 0, 'two groups should start collapsed');
    await page.locator('.group-head').first().focus();
    await assert(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('group-head')), 'a group header must be reachable by keyboard focus');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 1, 'Enter on a focused group header must expand it (keyboard parity with tap)');
    await assert(await count(page, '.group-head[aria-expanded="true"]') === 1, 'the expanded group should report aria-expanded=true after Enter');
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 0, 'Space on a focused group header must collapse it again');
    await assert(await page.evaluate(() => window.scrollY === 0), 'Space must not scroll the page when it activates a group header');

    // (6) 자동 펼침(강제 펼침) 상태의 헤더 탭은 상태를 오염시키지 않아야 한다 — 검색을 지우면 원래대로 접혀 있어야 한다.
    await page.locator('#searchInput').fill('갑');
    await page.waitForTimeout(200);
    await assert(await count(page, '.group-head') === 1 && await count(page, '.card.employee') === 1, 'a search should leave the matching group, auto-expanded');
    await page.locator('.group-head').first().click();
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 1, 'tapping a force-expanded header must be ignored (it cannot be collapsed right now)');
    await assert((await page.locator('.group-head').first().getAttribute('aria-expanded')) === 'true', 'a force-expanded header must keep reporting aria-expanded=true');
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 0, 'clearing the search must return every group to collapsed — a ghost tap must not have recorded state');
    await assert(await count(page, '.group-head[aria-expanded="true"]') === 0, 'no group should linger expanded after the search is cleared');

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
        pinResetWipesData: true,
        backNavigationHistory: true,
        homeGroupRegressions: true
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
