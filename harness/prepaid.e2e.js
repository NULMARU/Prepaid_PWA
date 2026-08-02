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

// beta.18: 잠금 화면의 기본값은 "손님 화면"이다 — PIN 패드는 [사장님용 잠금 해제]를 눌러야 나온다.
//   (PIN 최초 설정·변경 단계에서는 손님 화면이 없으므로 그때는 곧바로 패드가 떠 있다.)
// beta.19: 손님이 [사장님께 보여주기]를 누른 뒤에는 이미 PIN 패드("사장님 확인")가 떠 있다 —
//   그때는 [사장님용 잠금 해제]가 없으므로 이 헬퍼가 곧바로 4자리를 누른다(인계 경로와 그대로 정합).
async function unlockPin(page) {
  await page.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 8000 });
  if (await page.locator('[data-a="lock-to-pin"]').count()) {
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
  }
  for (const key of ['1', '2', '3', '4']) {
    await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
  }
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

    // (e) 검색 결과가 딱 1명이면 그룹 헤더 없이 "확대 카드" 한 장만 남는다(손님 앞에서 동료 정보 비노출).
    await page.locator('#searchInput').fill('User Q');
    await page.waitForTimeout(150);
    await assert(await count(page, '.card.employee.solo') === 1, 'a single search hit must render exactly one enlarged solo card');
    await assert(await count(page, '.group-head') === 0, 'the solo card must drop the group headers entirely');
    await assert(await count(page, '.card.employee') === 1, 'no other employee card may render beside the solo card');
    await assert(!(await page.locator('.app').innerText()).includes('User A'), 'the solo card must not leak the other employee name on screen');
    // 확대 카드는 손님에게 그대로 보여주는 화면이다 — 가게 매출이 드러나는 요약(오늘 사용·전체 잔액)은 함께 감춰야 한다.
    await assert(await count(page, '.card.summary') === 0, 'the shop revenue summary (오늘 사용 · 전체 잔액) must be hidden while the solo card is shown to a customer');
    await assert(!(await page.locator('.app').innerText()).includes('전체 잔액'), 'no shop-wide balance may remain on screen behind the solo card');
    // 확대 카드는 "크기만" 다르다 — [사용]·[증표] 조작은 그대로 있어야 한다.
    await assert(await count(page, '.card.employee.solo [data-a="use"]') === 1, 'the solo card must keep the 사용 button');
    await assert(await count(page, '.card.employee.solo [data-a="receipt"]') === 1, 'the solo card must keep the 증표 button');
    const soloSize = await page.evaluate(() => {
      const c = document.querySelector('.card.employee.solo');
      const px = sel => parseFloat(getComputedStyle(c.querySelector(sel)).fontSize);
      const use = c.querySelector('[data-a="use"]').getBoundingClientRect();
      return { name: px('.name'), bal: px('.bal'), useH: use.height };
    });
    await assert(soloSize.name >= 24 && soloSize.bal >= 30, `the solo card must really be enlarged (name ${soloSize.name}px, balance ${soloSize.bal}px)`);
    await assert(soloSize.useH >= 56, `the solo card [사용] button must be enlarged too (got ${Math.round(soloSize.useH)}px)`);
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(150);
    await assert(await count(page, '.card.employee') === 0, 'clearing the search should return the groups to the collapsed default');
    await assert(await count(page, '.card.employee.solo') === 0, 'the solo card must disappear once the search is cleared');

    // 소속 필터는 검색과 달리 그룹 구조를 유지한다 — 고른 그룹만 남고 자동으로 펼쳐진다(옵션 문구 = 그룹 헤더 문구).
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
    const unlock = async () => { await unlockPin(page); };
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

    // (3) 활동 있는 지난달이 미백업(미등록) → 홈 상단바 [장부 저장] 버튼에 ⚠️ 배지가 붙는다(beta.17: 월말 배너 폐지).
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="screen"][data-screen="home"]');
    const saveBtn = page.locator('.top .tool [data-a="monthly-backup-now"]');
    await assert(await saveBtn.count() === 1, 'home top bar must carry exactly one always-on [장부 저장] button');
    await assert((await saveBtn.innerText()).includes('장부 저장'), 'the top-bar backup button must read 장부 저장');
    await assert(await count(page, '.banner [data-a="monthly-backup-now"]') === 0, 'the month-end backup banner must be gone — the top-bar button replaces it');
    await assert(!(await page.locator('.app').innerText()).includes('지금 저장하기'), 'the old 지금 저장하기 banner wording must no longer render anywhere on home');
    await assert((await saveBtn.getAttribute('data-due')) === '1', 'an unbacked month with activity must flag the [장부 저장] button as due');
    await assert((await saveBtn.innerText()).includes('⚠️'), 'a due [장부 저장] button must carry the ⚠️ badge');
    const dueTip = await saveBtn.getAttribute('title');
    await assert(dueTip.includes(prevYmStr) && dueTip.includes('이번 달 아직'), `the due button must name the due month ${prevYmStr} and say it is still pending (got ${JSON.stringify(dueTip)})`);
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'backup-banner.png') }).catch(() => {});
    // 눌러 보면 옛 배너의 [지금 저장하기]와 똑같은 저장 흐름(백업 파일 다운로드 + "정말 저장됐나요?" 확인)이 돈다.
    const savedByBtn = [];
    const onSaveBtnDownload = d => savedByBtn.push(d);
    page.on('download', onSaveBtnDownload);
    const dialogsBefore = dialogs.length;
    await saveBtn.click();
    for (let i = 0; i < 30 && !savedByBtn.length; i += 1) await page.waitForTimeout(100);
    page.off('download', onSaveBtnDownload);
    await assert(savedByBtn.length === 1 && /^밥장부백업_\d{4}-\d{2}\.json$/.test(savedByBtn[0].suggestedFilename()),
      `tapping [장부 저장] must download the monthly backup file (got ${JSON.stringify(savedByBtn.map(d => d.suggestedFilename()))})`);
    await assert(dialogs.slice(dialogsBefore).some(d => d.type === 'confirm' && d.message.includes('파일이 실제로 저장된 것을 확인')),
      'tapping [장부 저장] must run the save-confirmation dialog flow, exactly like the old banner button');

    // (4) 자동 백업 토글: 기본 켜짐 → 끄면 저장·복원되고 [장부 저장] 버튼 설명에 "꺼져 있어요" 경고가 붙는다
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
    await page.waitForTimeout(150);
    const offTip = await page.locator('.top .tool [data-a="monthly-backup-now"]').getAttribute('title');
    await assert(offTip.includes('꺼져 있어요'), `with auto backup off, the [장부 저장] button must warn that auto backup is disabled (got ${JSON.stringify(offTip)})`);
    // 재로드 후 토글 상태 복원(꺼짐 유지) 확인 → 다시 켠다
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('[data-a="toggle-auto-cloud"]');
    await assert(!(await page.locator('[data-a="toggle-auto-cloud"]').isChecked()), 'auto backup toggle state should be restored (still off) after reload');
    await page.locator('[data-a="toggle-auto-cloud"]').check();
    await page.waitForTimeout(150);

    // (5) 이미 이번 대상 달을 백업했으면(lastMonthlyBackup 기록) [장부 저장] 배지 해제 + monthlyBackupDue()=='' (버튼 자체는 계속 남는다)
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
    const recordedBtn = page.locator('.top .tool [data-a="monthly-backup-now"]');
    await assert(await recordedBtn.count() === 1, 'the [장부 저장] button must stay on the home top bar in every state (it is always-on, not a banner)');
    if (isLastDayToday) {
      await assert(dueAfterRecord === curYmStr, `on the last day of the month the due target must roll over from ${prevYmStr} to ${curYmStr} (got "${dueAfterRecord}")`);
      await assert((await recordedBtn.getAttribute('data-due')) === '1', 'the rolled-over due month must keep the [장부 저장] button flagged as due');
      const rollTip = await recordedBtn.getAttribute('title');
      await assert(rollTip.includes(curYmStr), `the rolled-over due button must name ${curYmStr} (got ${JSON.stringify(rollTip)})`);
      await assert(!rollTip.includes(prevYmStr), `the month already recorded as backed up must not be named by the button any more (got ${JSON.stringify(rollTip)})`);
    } else {
      await assert((await recordedBtn.getAttribute('data-due')) === '0', 'a month already backed up must clear the due flag on the [장부 저장] button');
      await assert(!(await recordedBtn.innerText()).includes('⚠️'), 'a non-due [장부 저장] button must not show the ⚠️ badge');
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
    await unlock();
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

    // (f) 잠금 상태에서 뒤로가기 → 잠금 유지(홈 안 열림, 잠금 우회 금지). beta.18: 잠금 화면 = 손님 화면.
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    st = await bt();
    await assert(st.locked === true, 'app should be locked after reload');
    await back();
    st = await bt();
    await assert(st.locked === true, '(f) back on the customer (lock) screen must keep the app locked (no lock bypass)');
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '.nav') === 0, '(f) customer lock screen must remain; home/nav must not appear');
    // PIN 화면으로 넘어간 뒤에도 뒤로가기가 잠금을 풀면 안 된다.
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    await back();
    st = await bt();
    await assert(st.locked === true, '(f) back on the PIN screen must keep the app locked as well');
    await assert(await count(page, '.pin-screen') === 1 && await count(page, '.nav') === 0, '(f) PIN screen must remain; home/nav must not appear');

    // (10) PIN 5회 실패 → 즉시 [앱 초기화]가 아니라 60초 입력 지연(meta 영속).
    //      초기화는 [PIN을 잊으셨나요?] 복구 화면 안에서 "60초 활성화 게이트"를 지나야만 눌린다.
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    // 프로덕션 상수 값 자체를 못 박는다 — 검증 편의로 짧게 줄여놓고 커밋하는 사고를 막는다.
    const prodTimers = await page.evaluate(() => Object.assign({}, window.__prepaidTestHooks.TIMERS));
    await assert(prodTimers.custIdle === 30000, `TIMERS.custIdle must stay 30000 in production (got ${prodTimers.custIdle})`);
    await assert(prodTimers.autoLock === 90000, `TIMERS.autoLock must stay 90000 in production (got ${prodTimers.autoLock})`);
    await assert(prodTimers.pendingTtl === 120000, `TIMERS.pendingTtl must stay 120000 in production (got ${prodTimers.pendingTtl})`);
    await assert(prodTimers.pinDelay === 60000, `TIMERS.pinDelay must stay 60000 in production (got ${prodTimers.pinDelay})`);
    await assert(prodTimers.recoveryGate === 60000, `TIMERS.recoveryGate must stay 60000 in production (got ${prodTimers.recoveryGate})`);
    await assert(prodTimers.modalIdleCap === 600000, `TIMERS.modalIdleCap must stay 600000 in production (got ${prodTimers.modalIdleCap})`);
    await assert(prodTimers.ownerPinIdle === 120000, `TIMERS.ownerPinIdle must stay 120000 in production (got ${prodTimers.ownerPinIdle})`);
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    for (let i = 0; i < 5; i += 1) {
      for (const key of ['9', '9', '9', '9']) {
        await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
      }
    }
    await page.waitForSelector('.pin-delay');
    const delayText = await page.locator('.pin-delay').innerText();
    await assert(/\d+초/.test(delayText) && delayText.includes('5번'), `five PIN failures must show a countdown delay, got ${JSON.stringify(delayText)}`);
    await assert(await count(page, '.pin-screen [data-a="pin-reset"]') === 0, 'the PIN screen must NOT offer [앱 초기화] after five failures (a customer could tap it)');
    await assert(await page.locator('[data-a="pin-key"][data-key="1"]').isDisabled(), 'the PIN pad must be disabled while the 60s delay is running');
    // 영속 검증(P1) — 새로고침 한 번으로 실패 횟수·지연이 사라지면 지연이 아니다(무제한 브루트포스).
    const guardMeta = (await readDb(page)).meta.reduce((acc, row) => (acc[row.key] = row.value, acc), {});
    await assert(Number(guardMeta.pinFails) === 5, `pinFails must be persisted to meta (got ${JSON.stringify(guardMeta.pinFails)})`);
    await assert(Number(guardMeta.pinDelayUntil) > Date.now(), 'pinDelayUntil must be persisted to meta and still in the future');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('.pin-delay');
    await assert((await page.locator('.pin-delay').innerText()).includes('5번'), 'the failure count must survive a reload');
    await assert(await page.locator('[data-a="pin-key"][data-key="1"]').isDisabled(), 'a reload must NOT clear the input delay (brute-force bypass)');
    // 지연 중에도 [PIN을 잊으셨나요?] 복구 경로는 열려 있어야 한다 — 초기화는 오직 이 안에서, 그것도 60초 뒤에만.
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 700 }));
    await page.locator('[data-a="pin-forgot"]').click();
    await page.waitForSelector('[data-a="pin-forgot-restore"]');
    await assert(await count(page, '[data-a="pin-reset"]') === 1, 'app reset must live inside the PIN-recovery screen only');
    // 게이트가 도는 동안 두 파괴 버튼은 비활성 + 사유가 화면에 보여야 한다.
    await assert(await page.locator('[data-a="pin-reset"]').isDisabled(), 'the recovery [초기화] button must be disabled while the 60s gate is running');
    await assert(await page.locator('[data-a="pin-forgot-restore"]').isDisabled(), 'the recovery [백업 파일로 복구] button must be disabled while the 60s gate is running');
    const gateText = await page.locator('.pin-screen .pin-delay').innerText();
    await assert(gateText.includes('잘못 누름 방지') && /\d+초/.test(gateText), `the recovery gate must explain itself (got ${JSON.stringify(gateText)})`);
    // 비활성 버튼에 합성 클릭을 쏘아도 핸들러 자체가 막아야 한다(disabled에만 기대지 않는다).
    const dialogsBeforeGateProbe = dialogs.length;
    const gateProbeBefore = await readDb(page);
    await page.evaluate(() => {
      ['pin-reset', 'pin-forgot-restore'].forEach(a => {
        const el = document.querySelector(`[data-a="${a}"]`);
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    });
    await page.waitForTimeout(400);
    await assert(dialogs.length === dialogsBeforeGateProbe, 'no confirm dialog may open from the recovery screen before the gate elapses');
    const gateProbeAfter = await readDb(page);
    await assert(JSON.stringify(gateProbeAfter.employees) === JSON.stringify(gateProbeBefore.employees), 'the gated recovery buttons must not touch the ledger before the gate elapses');
    // 게이트 경과 → 그때서야 활성화된다.
    await page.waitForTimeout(1000);
    await assert(!(await page.locator('[data-a="pin-reset"]').isDisabled()), 'the recovery buttons must become enabled once the gate elapses');
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
    await assert((await page.locator('#deptFilterSelect').inputValue()) === '', 'a department filter whose group key no longer exists should fall back to 전체 소속');

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
    // 필터 첫 옵션 문구는 '전체 소속' — 공공기관뿐 아니라 사기업·개인 그룹도 담기 때문에 '부서'가 아니다(beta.17).
    await assert((await filterOptions())[0] === '전체 소속', `the first filter option must read 전체 소속 (got ${JSON.stringify((await filterOptions())[0])})`);
    await assert((await page.locator('#deptFilterSelect').getAttribute('aria-label')).includes('소속'), 'the filter select must be labelled by 소속, not 부서');
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

    // (3) 필터를 켠 채 소속을 수정하면 필터 키가 사라진다 → 홈 복귀 시 전체 소속으로 자기치유되고 직원이 보여야 한다.
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
    await assert((await page.locator('#deptFilterSelect').inputValue()) === '', 'editing the filtered group away should reset the filter to 전체 소속');
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
    // '갑돌'은 (6)에서 검색 결과가 2건이 되게 하는 씨앗이다 — 1건이면 확대 카드로 바뀌어 그룹 헤더가 사라진다(beta.17).
    await seedHome([
      { id: 'kb-1', org: 'A사', orgKind: '', dept: '1팀', name: '갑', amount: 1000 },
      { id: 'kb-2', org: 'B사', orgKind: '', dept: '2팀', name: '을', amount: 2000 },
      { id: 'kb-3', org: 'B사', orgKind: '', dept: '2팀', name: '갑돌', amount: 3000 }
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
    //     검색 결과가 2건이므로 그룹 구조(헤더)가 유지된다 — 1건이면 확대 카드로 바뀌어 이 회귀를 볼 수 없다.
    await page.locator('#searchInput').fill('갑');
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee.solo') === 0, 'two search hits must NOT collapse into the solo card');
    await assert(await count(page, '.group-head') === 2 && await count(page, '.card.employee') === 2, 'a search should leave the matching groups, auto-expanded');
    await page.locator('.group-head').first().click();
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 2, 'tapping a force-expanded header must be ignored (it cannot be collapsed right now)');
    await assert((await page.locator('.group-head').first().getAttribute('aria-expanded')) === 'true', 'a force-expanded header must keep reporting aria-expanded=true');
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 0, 'clearing the search must return every group to collapsed — a ghost tap must not have recorded state');
    await assert(await count(page, '.group-head[aria-expanded="true"]') === 0, 'no group should linger expanded after the search is cleared');

    // ───────────────────────────────────────────────────────────────
    // (7) 검색·차감 1단계(beta.17): 초성 검색 · 공백 무시 · 최근 사용 순 · 확대 카드 · 사용 모달 빠른 금액 · 저장 후 검색어 초기화
    // ───────────────────────────────────────────────────────────────
    await seedHome([
      { id: 'sx-1', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '김민수', amount: 50000 },
      { id: 'sx-2', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '김미래', amount: 60000 },
      { id: 'sx-3', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '이순신', amount: 70000 },
      { id: 'sx-4', org: '가나상사', orgKind: '', dept: '', name: '박보검', amount: 80000 }
    ]);
    const cardNames = async () => (await page.locator('.card.employee .name').allInnerTexts()).map(t => t.trim());

    // (7-a) 초성 검색 — 'ㄱㅁ'은 김민수·김미래만 잡고 이순신(ㅇㅅㅅ)·박보검(ㅂㅂㄱ)은 잡지 않는다.
    await page.locator('#searchInput').fill('ㄱㅁ');
    await page.waitForTimeout(200);
    const chosungNames = await cardNames();
    await assert(chosungNames.length === 2 && chosungNames.includes('김민수') && chosungNames.includes('김미래'),
      `초성 'ㄱㅁ' must match exactly 김민수/김미래 (got ${JSON.stringify(chosungNames)})`);
    await assert(!chosungNames.includes('이순신') && !chosungNames.includes('박보검'), '초성 검색 must not match unrelated names');
    // 초성 검색은 이름에만 걸린다 — 소속·부서는 검색 대상이 아니다('ㅎㅂ' = 한빛물산의 초성).
    await page.locator('#searchInput').fill('ㅎㅂ');
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 0, '초성 검색 must stay name-only — 소속/부서 must not be searched');

    // (7-b) 공백 무시 — '이 순신'으로 쳐도 이순신이 잡힌다.
    await page.locator('#searchInput').fill('이 순신');
    await page.waitForTimeout(200);
    await assert((await cardNames()).join('|') === '이순신', `spaces typed inside a name must be ignored (got ${JSON.stringify(await cardNames())})`);

    // (7-c) 확대 카드 — 결과 1건이면 그룹 헤더 없이 그 한 명만 크게, 다른 직원 카드는 없다.
    await assert(await count(page, '.card.employee.solo') === 1 && await count(page, '.group-head') === 0, 'a single hit must render the solo card with no group headers');
    await assert(!(await page.locator('.app').innerText()).includes('김민수'), 'the solo card must hide every other employee');

    // (7-d) 최근 사용 순 — 검색 중에는 마지막 거래가 최신인 직원이 위로 온다(검색이 없을 때 그룹 정렬은 불변).
    await page.evaluate(({ ts }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['transactions'], 'readwrite');
        // 김민수(sx-1)에게 가장 최근 사용 거래를 하나 붙인다. txHash 없이 넣어 해시체인 검증은 건너뛴다.
        tx.objectStore('transactions').put({ id: 'sx-recent', employeeId: 'sx-1', type: 'use', amount: 1000, beforeBalance: 50000, afterBalance: 49000, reason: '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: ts });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { ts: Date.now() + 60000 });
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await expandHomeGroups(page);
    const defaultOrder = await cardNames();
    await assert(defaultOrder.indexOf('김미래') < defaultOrder.indexOf('김민수'),
      `without a search the group order must stay unchanged (가나다: 김미래 → 김민수, got ${JSON.stringify(defaultOrder)})`);
    await page.locator('#searchInput').fill('ㄱㅁ');
    await page.waitForTimeout(200);
    const recentOrder = await cardNames();
    await assert(recentOrder.join('|') === '김민수|김미래',
      `during a search the most recently used employee must come first (got ${JSON.stringify(recentOrder)})`);

    // (7-e) 사용 모달 빠른 금액 — 한 번 눌러 금액이 채워지고, 그대로 고쳐 쓸 수 있다.
    await page.locator('#searchInput').fill('박보검');
    await page.waitForTimeout(200);
    await page.locator('#deptFilterSelect').selectOption({ label: '가나상사' });
    await page.waitForTimeout(200);
    const keptFilter = await page.locator('#deptFilterSelect').inputValue();
    await assert(await count(page, '.card.employee.solo') === 1, 'the filtered + searched single hit should still be the solo card');
    await page.locator('.card.employee.solo [data-a="use"]').click();
    await page.waitForSelector('#useAmount');
    await assert(await count(page, '[data-a="fill-use"]') === 3, 'the usage modal must offer three quick-amount buttons');
    await page.locator('[data-a="fill-use"][data-amount="18000"]').click();
    await assert((await page.locator('#useAmount').inputValue()) === '18000', 'one tap on a quick amount must fill the usage amount field');
    await page.locator('#useAmount').fill('9000');
    await assert((await page.locator('#useAmount').inputValue()) === '9000', 'a quick-filled amount must remain hand-editable');

    // (7-f) 저장이 끝나면 검색어는 비워지고(다음 손님) 소속 필터는 그대로 남는다.
    const sBox = await page.locator('#signCanvas').boundingBox();
    await page.mouse.move(sBox.x + 30, sBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(sBox.x + 120, sBox.y + 45, { steps: 5 });
    await page.mouse.move(sBox.x + 220, sBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-a="save-use"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 5000 });
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.waitForTimeout(150);
    await assert((await page.locator('#searchInput').inputValue()) === '', 'saving a deduction must clear the search box for the next customer');
    await assert((await page.locator('#deptFilterSelect').inputValue()) === keptFilter, 'saving a deduction must keep the 소속 filter (the group usually keeps coming)');
    await assert(await count(page, '.card.employee.solo') === 0, 'clearing the search after a save must drop the solo card');
    const sxDb = await readDb(page);
    await assert(balanceOfId(sxDb, 'sx-4') === 71000, 'the deduction itself must still be recorded (80000 - 9000)');


    // ═══════════════════════════════════════════════════════════════════════
    // (8) 잠금 화면 = 손님 화면 (beta.18)
    //   지도 원칙: "손님은 '요청'을 만들 수 있고 '기록'은 만들 수 없다."
    //   잠금 상태에서 원장 쓰기(makeTx/repo.apply)에 닿는 경로가 단 하나도 없어야 한다.
    // ═══════════════════════════════════════════════════════════════════════
    await seedHome([
      // 동명이인은 구분 마커('·2','·3'…)로 갈라진다 — 첫 사람은 이름 그대로, 두 번째부터 마커를 받는다.
      { id: 'cx-1', org: '광진구청', orgKind: 'public', dept: '세무과', name: '홍길동', amount: 50000 },
      { id: 'cx-2', org: '광진구청', orgKind: 'public', dept: '세무과', name: '홍길동·2', amount: 60000 },
      { id: 'cx-3', org: '광진구청', orgKind: 'public', dept: '세무과', name: '김철수', amount: 30000 },
      { id: 'cx-4', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '김영희', amount: 20000 },
      { id: 'cx-5', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '이순신', amount: 10000 }
    ], { orgName: '광진구청' });
    // 김철수에게 거래 6건을 더 심는다(취소된 사용 1건 + 서명 있는 사용 1건) → 최근 5건 렌더러 검증용.
    const cxBase = Date.now();
    await page.evaluate(({ t }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['transactions'], 'readwrite');
        const ts = tx.objectStore('transactions');
        // txHash 없이 넣는다(레거시 취급) — 해시체인 검증은 건너뛰고 잔액 재계산은 그대로 맞는다.
        const put = (id, type, amount, at, extra) => ts.put(Object.assign({ id, employeeId: 'cx-3', type, amount, beforeBalance: 0, afterBalance: 0, reason: '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: at }, extra || {}));
        put('cxt-1', 'use', 1000, t + 1000);
        put('cxt-2', 'use', 2000, t + 2000);
        put('cxt-3', 'void', 2000, t + 3000, { targetTransactionId: 'cxt-2' });
        put('cxt-4', 'topup', 5000, t + 4000);
        put('cxt-5', 'use', 3000, t + 5000, { signatureData: 'data:image/png;base64,iVBORw0KGgo=' });
        put('cxt-6', 'use', 500, t + 6000);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { t: cxBase });
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    // 테스트용 상수 주입 — 프로덕션 상수(30초/90초/120초/60초)는 index.html의 TIMERS에 그대로 남는다.
    const setTimers = async (t) => page.evaluate(v => Object.assign(window.__prepaidTestHooks.TIMERS, v), t);

    // (8-a) [손님 셀프 조회] — 1탭으로 즉시 잠금 + 손님 화면. PIN 화면과 왕복도 된다.
    await assert(await count(page, '.top .tool [data-a="hand-to-customer"]') === 1, 'the home top bar must carry exactly one [손님 셀프 조회] button');
    // beta.19 문구 — 액션명(data-a)은 그대로, 라벨·aria-label만 "손님 셀프 조회"로 바뀌었다.
    const handoffLabel = await page.locator('.top .tool [data-a="hand-to-customer"]').innerText();
    await assert(handoffLabel.trim() === '손님 셀프 조회', `the handover button must read 손님 셀프 조회 (got ${JSON.stringify(handoffLabel)})`);
    await assert((await page.locator('.top .tool [data-a="hand-to-customer"]').getAttribute('aria-label') || '').includes('손님 셀프 조회'), 'the handover button must carry a matching aria-label');
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await assert((await bt()).locked === true, '[손님에게 넘기기] must lock the app immediately');
    await assert(await count(page, '.nav') === 0 && await count(page, '.card.employee') === 0, 'the customer screen must not leak any owner UI');
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('.pin-screen');
    await assert(await count(page, '[data-a="pin-to-cust"]') === 1, 'the PIN screen must offer a way back to the customer screen');
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('.cust-screen');

    // (8-b) 질의 전 명단 0명 · 결과 행에 잔액 비표시 · 초성 검색
    await assert(await count(page, '.cust-row') === 0, 'the customer screen must list nobody before a query is typed');
    const custIdle0 = await page.locator('.cust-screen').innerText();
    await assert(!/\d{1,3},\d{3}원/.test(custIdle0), 'no balance may appear on the idle customer screen');
    await page.locator('#custSearchInput').fill('김');
    await page.waitForTimeout(200);
    const custNames = (await page.locator('.cust-row-name').allInnerTexts()).map(t => t.trim());
    await assert(custNames.length === 2 && custNames.includes('김철수') && custNames.includes('김영희'), `the customer search must match by name (got ${JSON.stringify(custNames)})`);
    const custListText = await page.locator('.cust-list').innerText();
    await assert(!/\d{1,3},\d{3}원/.test(custListText), 'the customer result list must NEVER show balances');
    await assert((await page.locator('.cust-row-label').first().innerText()).includes('광진구청 세무과'), 'each result row must carry the 기관명 부서명 label above the name');
    await page.locator('#custSearchInput').fill('ㄱㅊㅅ');
    await page.waitForTimeout(200);
    await assert(await count(page, '.cust-ask') === 1, '초성 검색 with a single hit must jump straight to the confirmation card');
    const custConfirmText = await page.locator('.cust-card').innerText();
    await assert(custConfirmText.includes('김철수') && custConfirmText.includes('광진구청 세무과'), 'the confirmation card must show the label and the name');
    await assert(!/\d{1,3},\d{3}원/.test(custConfirmText), 'the confirmation card must not reveal the balance yet');
    await page.locator('[data-a="cust-cancel"]').click();
    await page.waitForSelector('#custSearchInput');

    // (8-b2) 부분 갱신 계약(beta.20) — 손님이 한 글자씩 칠 때 **입력창 노드가 살아 있어야** 한다.
    //   전체 재렌더는 포커스된 입력 노드를 DOM에서 들어내 폰의 소프트키보드·한글 IME 조합을 끊는다
    //   ("데스크톱은 되는데 스마트폰에서는 입력이 안 된다"의 정체). 결과 영역(#custResults)만 갈아끼운다.
    //   상세 회귀(실제 디바이스 프로파일·IME 조합)는 harness/responsive.e2e.mjs가 맡는다.
    await assert(await count(page, '#custResults') === 1, 'the customer search screen must carry a #custResults region (partial-update landing spot)');
    await page.locator('#custSearchInput').click();
    await page.evaluate(() => { document.querySelector('#custSearchInput').__bapProbe = 'alive'; });
    // '홍'·'홍길'·'홍길동' 은 어느 단계에서도 동명이인 병합 행 1줄이라 확인 카드로 넘어가지 않는다 — 검색 단계가 유지된다.
    for (const ch of ['홍', '길', '동']) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(120);
      const s = await page.evaluate(() => {
        const el = document.querySelector('#custSearchInput');
        return { same: !!el && el.__bapProbe === 'alive', focused: !!el && document.activeElement === el, value: el ? el.value : null };
      });
      await assert(s.same, `typing "${ch}" must not replace the customer search input node (mobile keyboard/IME would be torn down)`);
      await assert(s.focused, `typing "${ch}" must not steal focus from the customer search input`);
    }
    await assert((await page.locator('#custSearchInput').inputValue()) === '홍길동', 'every typed character must land in the customer search input');

    // (8-b3) 검색 결과 0건 안내(beta.20) — 손님이 친 이름을 그대로 되돌려 주고 초성 팁을 병기한다.
    //   질의 전(빈 검색어)에는 0건 문구를 절대 띄우지 않는다.
    await page.locator('#custSearchInput').fill('없는사람');
    await page.waitForTimeout(200);
    const noneText = (await page.locator('#custResults').innerText()).replace(/\n/g, ' ');
    await assert(await count(page, '.cust-row') === 0, 'an unmatched query must produce no result rows');
    await assert(noneText.includes("'없는사람'(으)로 등록된 이름이 없어요."), `the empty-result notice must echo the typed name (got ${JSON.stringify(noneText)})`);
    await assert(noneText.includes('사장님께 말씀해 주세요'), `the empty-result notice must tell the customer to ask the owner (got ${JSON.stringify(noneText)})`);
    await assert(noneText.includes('초성만 쳐도 돼요'), `the empty-result notice must carry the 초성 tip (got ${JSON.stringify(noneText)})`);
    // 이스케이프 — 손님이 친 글자는 절대 HTML로 해석되지 않는다.
    await page.locator('#custSearchInput').fill('<img src=x onerror=alert(1)>');
    await page.waitForTimeout(200);
    const escText = await page.evaluate(() => {
      const r = document.querySelector('#custResults');
      return { text: r.innerText.replace(/\n/g, ' '), injected: r.querySelectorAll('img, script').length };
    });
    await assert(escText.injected === 0, 'the empty-result notice must never inject the query as HTML');
    await assert(escText.text.includes('<img src=x onerror=alert(1)>'), `the empty-result notice must show the query as literal text (got ${JSON.stringify(escText.text)})`);
    // 질의를 비우면 0건 문구가 사라지고 안내 문구로 되돌아간다(✕ 버튼도 함께 사라진다).
    await page.locator('[data-a="cust-clear"]').click();
    await page.waitForTimeout(200);
    const emptyText = (await page.locator('#custResults').innerText()).replace(/\n/g, ' ');
    await assert(emptyText.includes('이름을 입력하면'), `the pre-query customer screen must show the guidance line (got ${JSON.stringify(emptyText)})`);
    await assert(!emptyText.includes('없어요'), 'the pre-query customer screen must NEVER show the empty-result notice');
    await assert(await count(page, '.cust-clear') === 0, 'the ✕ clear button must disappear once the query is empty');

    // (8-c) 동명이인(구분 마커 ·2)은 한 줄로 병합되고 선택할 수 없다. 표시 이름은 마커를 뗀 기본 이름이다.
    await page.locator('#custSearchInput').fill('홍길동');
    await page.waitForTimeout(200);
    await assert(await count(page, '.cust-row.dup') === 1, 'marked 동명이인 must merge into a single row');
    await assert(await count(page, '.cust-row[data-a]') === 0, 'the merged 동명이인 row must not be selectable');
    const dupText = await page.locator('.cust-row.dup').innerText();
    await assert(dupText.includes('홍길동 (동명이인 2명)'), `the merged row must show the base name untruncated (got ${JSON.stringify(dupText)})`);
    await assert(dupText.includes('동명이인 2명') && dupText.includes('사장님께'), `the merged row must ask the customer to talk to the owner (got ${JSON.stringify(dupText)})`);
    await page.locator('.cust-row.dup').click();
    await page.waitForTimeout(200);
    await assert(await count(page, '#custSearchInput') === 1 && await count(page, '.cust-ask') === 0, 'tapping the merged row must do nothing at all');

    // (8-d) 본인 확인 → 잔액 + 최근 5건(서명 이미지 없음 · 취소 버튼 없음 · 취소건 회색)
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('.cust-bal');
    await assert((await page.locator('.cust-bal').innerText()).includes('30,500원'), `the customer balance must match the ledger (got ${await page.locator('.cust-bal').innerText()})`);
    await assert(await count(page, '.cust-tx') === 5, `the customer detail must show exactly the 5 most recent transactions (got ${await count(page, '.cust-tx')})`);
    await assert(await count(page, '.cust-screen img') === 0, 'signature images must never render on the customer screen');
    await assert(await count(page, '.cust-screen [data-a="void"]') === 0, 'the customer screen must not offer the void button');
    const custTxText = await page.locator('.cust-txs').innerText();
    await assert(custTxText.includes('서명 있음'), 'a signed transaction must be marked with text only');
    await assert(await count(page, '.cust-tx.voided') === 1 && (await page.locator('.cust-tx.voided').innerText()).includes('취소됨'), 'a voided transaction must render grayed out with a 취소됨 mark');

    // (8-e) 게이트 스윕 — 허용 목록 밖의 모든 액션은 잠금 상태에서 통째로 차단된다(원장 불변).
    const lockAllowed = (await page.evaluate(() => window.__prepaidTestHooks.lockAllowed())).slice().sort();
    const expectedAllowed = ['pin-key', 'pin-reset', 'pin-forgot', 'pin-forgot-cancel', 'pin-forgot-restore', 'lock-to-pin', 'pin-to-cust', 'cust-pick', 'cust-confirm', 'cust-cancel', 'cust-clear', 'cust-back', 'cust-call-owner'].sort();
    await assert(JSON.stringify(lockAllowed) === JSON.stringify(expectedAllowed), `the lock allowlist must stay exactly the PIN/customer actions (got ${JSON.stringify(lockAllowed)})`);
    const gateBefore = await readDb(page);
    const swept = await page.evaluate(() => {
      const allowed = new Set(window.__prepaidTestHooks.lockAllowed());
      const keys = window.__prepaidTestHooks.clickActionKeys().filter(k => !allowed.has(k));
      keys.forEach(k => {
        const b = document.createElement('button');
        Object.assign(b.dataset, { a: k, id: 'cx-3', sid: 'sid', key: '1', screen: 'settings', dept: 'X', ctx: 'settings', tab: 'employee', amount: '9000', g: 'g', idx: '0' });
        document.body.appendChild(b);
        b.click();
        b.remove();
      });
      return keys;
    });
    await page.waitForTimeout(800);
    await assert(swept.length >= 40, `the gate sweep must cover every non-allowlisted action (got ${swept.length})`);
    const gateAfter = await readDb(page);
    await assert(JSON.stringify(gateAfter.employees) === JSON.stringify(gateBefore.employees), 'no locked-screen action may touch the employee store');
    await assert(JSON.stringify(gateAfter.transactions) === JSON.stringify(gateBefore.transactions), 'no locked-screen action may touch the ledger');
    await assert((await bt()).locked === true, 'the gate sweep must leave the app locked');
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '.modal-back') === 0 && await count(page, '.nav') === 0, 'no modal or owner screen may open from the lock screen');

    // (8-e2) 관대함 봉인 — 허용 목록까지 **포함한 전 액션**을 눌러도 원장 바이트는 그대로여야 한다.
    //   pin-reset은 이제 "복구 화면에만 있다"가 아니라 "복구 화면 + 60초 게이트를 지나야 산다"로 지켜진다.
    //   이 스윕은 복구 화면에 막 들어간 직후를 만들어내므로(게이트 0초 경과) 초기화가 실행되면 즉시 잡힌다.
    const fullBefore = await readDb(page);
    const fullDialogsBefore = dialogs.length;
    const sweptAll = await page.evaluate(() => {
      const keys = window.__prepaidTestHooks.clickActionKeys();
      keys.forEach(k => {
        const b = document.createElement('button');
        Object.assign(b.dataset, { a: k, id: 'cx-3', sid: 'sid', key: '1', screen: 'settings', dept: 'X', ctx: 'settings', tab: 'employee', amount: '9000', g: 'g', idx: '0' });
        document.body.appendChild(b);
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        b.remove();
      });
      return keys;
    });
    await page.waitForTimeout(1000);
    await assert(sweptAll.length === swept.length + lockAllowed.length, `the full sweep must be exactly "every action" (${sweptAll.length} vs ${swept.length}+${lockAllowed.length})`);
    await assert(sweptAll.includes('pin-reset') && sweptAll.includes('pin-forgot-restore') && sweptAll.includes('full-reset'), 'the full sweep must include the destructive actions');
    const fullAfter = await readDb(page);
    await assert(JSON.stringify(fullAfter.employees) === JSON.stringify(fullBefore.employees), 'not one action — allowlisted or not — may change the employee store while locked');
    await assert(JSON.stringify(fullAfter.transactions) === JSON.stringify(fullBefore.transactions), 'not one action — allowlisted or not — may change the ledger while locked');
    await assert(dialogs.length === fullDialogsBefore, 'no destructive confirm may open from the lock screen (the 60s recovery gate has not elapsed)');
    await assert((await bt()).locked === true, 'the full sweep must leave the app locked');
    await assert(await count(page, '.nav') === 0 && await count(page, '.modal-back') === 0, 'the full sweep must not open any owner screen or modal');
    // 복구 화면에 들어갔다면 두 파괴 버튼은 반드시 비활성 상태여야 한다.
    const sweptRecovery = await page.locator('[data-a="pin-reset"]');
    if (await sweptRecovery.count()) {
      await assert(await sweptRecovery.isDisabled(), 'the recovery reset button must be disabled right after entering the recovery screen');
    }
    // 스윕이 휘발 상태를 헤집어 놓았으므로 깨끗한 잠금 화면에서 다시 시작한다.
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    await assert((await bt()).locked === true, 'a reload after the sweep must come back locked');
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('.cust-bal');

    // (8-e3) 게이트 스윕 확장(beta.19) — 손님이 넘긴 "사장님 확인" 화면에서도 **전 액션**을 눌러본다.
    //   이 화면은 손님 손에서 사장님 손으로 넘어가는 유일한 지점이라, 여기서 원장 쓰기가 한 바이트라도
    //   통과하면 잠금 화면 전체의 보장이 무너진다.
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    const hoGateBefore = await readDb(page);
    const hoDialogsBefore = dialogs.length;
    const hoSwept = await page.evaluate(() => {
      const keys = window.__prepaidTestHooks.clickActionKeys();
      keys.forEach(k => {
        const b = document.createElement('button');
        Object.assign(b.dataset, { a: k, id: 'cx-3', sid: 'sid', key: '1', screen: 'settings', dept: 'X', ctx: 'settings', tab: 'employee', amount: '9000', g: 'g', idx: '0' });
        document.body.appendChild(b);
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        b.remove();
      });
      return keys.length;
    });
    // 숨은 파일 input 3종(#restoreFile·#csvFile·#directTransferFile)은 onClick 화이트리스트를 **거치지 않는다**
    //   — 각자 change 리스너로 직접 들어온다. 스윕이 클릭만 훑으면 이 세 경로가 통째로 검증 밖에 남는다.
    //   그래서 실제 파일(악성 복원 백업·CSV·직접 전달)을 물려 change를 발화시킨다.
    const hoEvilBackup = JSON.stringify({
      app: '선입금대장', version: 1, exportedAt: new Date().toISOString(),
      employees: [{ id: 'evil-1', org: '침입기관', orgKind: '', dept: '침입과', name: '침입자', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: Date.now(), updatedAt: Date.now() }],
      transactions: [{ id: 'evil-tx-1', employeeId: 'evil-1', type: 'open', amount: 999999, beforeBalance: 0, afterBalance: 999999, reason: 'x', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: Date.now() }],
      meta: { setupComplete: true, shopName: '침입식당', departments: [] }
    });
    const hoEvilCsv = '소속,부서,이름,금액\n침입기관,침입과,침입자,999999\n';
    const hoFilePaths = [
      ['#restoreFile', 'evil-restore.json', 'application/json', hoEvilBackup],
      ['#csvFile', 'evil-roster.csv', 'text/csv', hoEvilCsv],
      ['#directTransferFile', 'evil-transfer.json', 'application/json', hoEvilBackup]
    ];
    for (const [sel, name, mimeType, body] of hoFilePaths) {
      await page.setInputFiles(sel, { name, mimeType, buffer: Buffer.from(body, 'utf8') });
    }
    await page.waitForTimeout(1000);
    // 임계는 "50개쯤"이 아니라 **액션 맵 전량**이다 — 맵에 액션이 추가돼도 스윕이 자동으로 따라간다.
    //   (하한 50은 맵 자체가 쪼그라들어 전량 단언이 공허해지는 사고를 막는 보조 장치다.)
    const hoActionTotal = await page.evaluate(() => window.__prepaidTestHooks.clickActionKeys().length);
    await assert(hoSwept === hoActionTotal, `the 사장님 확인 sweep must fire every action in the map (fired ${hoSwept} of ${hoActionTotal})`);
    await assert(hoActionTotal >= 50, `the action map must not shrink out from under the sweep (got ${hoActionTotal})`);
    const hoGateAfter = await readDb(page);
    await assert(JSON.stringify(hoGateAfter.employees) === JSON.stringify(hoGateBefore.employees), 'no action fired on the 사장님 확인 screen may touch the employee store');
    await assert(JSON.stringify(hoGateAfter.transactions) === JSON.stringify(hoGateBefore.transactions), 'no action fired on the 사장님 확인 screen may touch the ledger');
    await assert(dialogs.length === hoDialogsBefore, 'no destructive confirm may open from the 사장님 확인 screen');
    await assert((await bt()).locked === true, 'the 사장님 확인 sweep must leave the app locked');
    await assert(await count(page, '.nav') === 0 && await count(page, '.modal-back') === 0, 'the 사장님 확인 sweep must not open any owner screen or modal');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('.cust-bal');

    // (8-f) [사장님께 보여주기] → beta.19: 안내 화면 없이 **곧바로 PIN 화면("사장님 확인")**.
    //       요청은 휘발성이고, PIN이 맞으면 사용 모달이 자동으로 열린다(금액 빈 칸) → 저장까지.
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert(await count(page, '#custSearchInput') === 0, '[사장님께 보여주기] must go straight to the PIN screen (no extra "call the owner" step)');
    const hoTitle = (await page.locator('.pin-title').innerText()).trim();
    await assert(hoTitle === '사장님 확인', `the handover PIN screen must be titled 사장님 확인 (got ${JSON.stringify(hoTitle)})`);
    const hoSub = (await page.locator('.pin-sub').innerText()).replace(/\n/g, ' ');
    await assert(hoSub.includes('김철수'), `the handover PIN screen must name the customer who handed the phone over (got ${JSON.stringify(hoSub)})`);
    await assert(hoSub.includes('광진구청 세무과'), `the handover subtitle must show the customer's 소속 too (got ${JSON.stringify(hoSub)})`);
    await assert(hoSub.includes('비밀번호'), `the handover subtitle must tell the owner to enter the PIN (got ${JSON.stringify(hoSub)})`);
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).pinContext === 'handoff', 'the handover PIN screen must run in the handoff context');
    await assert(await count(page, '[data-a="pin-forgot"]') === 1, 'the handover PIN screen must keep the PIN-recovery entry point');
    await assert((await page.locator('.cust-foot button').innerText()).includes('처음으로'), 'the handover PIN screen must offer [처음으로] as the way out');
    await assert((await bt()).locked === true, 'calling the owner must keep the app locked');
    // 뒤로가기(안드로이드 하단 버튼)로 잠금을 우회하거나 인계 요청을 흘리면 안 된다 — 화면 그대로 유지된다.
    await back();
    await assert((await bt()).locked === true, 'back on the 사장님 확인 screen must keep the app locked (no lock bypass)');
    await assert((await page.locator('.pin-title').innerText()).trim() === '사장님 확인' && await count(page, '.nav') === 0, 'back must leave the 사장님 확인 screen exactly as it was');
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).pendingCustomerId !== '', 'back must not drop the handover request');
    // 화면을 껐다 켜도(visibilitychange) 인계 요청·화면이 그대로여야 한다.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(200);
    await assert((await bt()).locked === true && (await page.locator('.pin-title').innerText()).trim() === '사장님 확인', 'visibilitychange/online must not disturb the 사장님 확인 screen');
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).pendingCustomerId !== '', 'visibilitychange/online must not drop the handover request');
    const pendDb = await readDb(page);
    await assert(!JSON.stringify(pendDb).includes('pendingCustomer'), 'the pending handover request must never be written to IndexedDB');
    const txBeforeHandover = pendDb.transactions.length;
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    await assert((await page.locator('#useAmount').inputValue()) === '', 'the auto-opened usage modal must NOT prefill the amount');
    await assert((await page.locator('.modal .receipt').innerText()).includes('김철수'), 'the handover must open the usage modal for the customer who asked');
    await page.locator('#useAmount').fill('1500');
    const hBox = await page.locator('#signCanvas').boundingBox();
    await page.mouse.move(hBox.x + 30, hBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(hBox.x + 120, hBox.y + 45, { steps: 5 });
    await page.mouse.move(hBox.x + 210, hBox.y + 95, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-a="save-use"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 6000 });
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.waitForTimeout(150);
    const handoverDb = await readDb(page);
    await assert(handoverDb.transactions.length === txBeforeHandover + 1, 'the handover flow must record exactly one new transaction');
    await assert(balanceOfId(handoverDb, 'cx-3') === 29000, `the handover deduction must land on the right employee (30,500 - 1,500 = 29,000, got ${balanceOfId(handoverDb, 'cx-3')})`);

    // (8-g0) TTL 경계 — 기한 **직전**의 요청은 반드시 살아 있어야 한다(만료 판정이 앞당겨지면 인계가 무너진다).
    //   프로덕션 120초를 그대로 기다릴 수 없으므로 같은 비교식을 축척(1200ms)으로 검증한다.
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await setTimers({ pendingTtl: 1200 });
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await page.waitForTimeout(600);
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    await assert((await page.locator('.modal .receipt').innerText()).includes('김철수'), 'a handover still inside the TTL must open the usage modal');
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForSelector('[data-a="quick-find-emp"]');

    // (8-g) 인계 요청 TTL 만료 → 조용히 폐기(사용 모달이 열리지 않는다)
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await setTimers({ pendingTtl: 300 });
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await page.waitForTimeout(700);
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await assert(await count(page, '#useAmount') === 0, 'an expired handover request must be dropped silently (no usage modal)');
    // 조용히 버리되 사장님에게는 한 줄 알린다 — 안 그러면 "왜 안 열리지?" 하고 헤맨다(P4).
    await assert((await page.locator('.toast').innerText().catch(() => '')).includes('만료'), 'an expired handover must tell the owner why nothing opened');

    // (8-h) 손님 화면 무조작 자동 복귀(프로덕션 30초) — 질의·선택·요청이 전부 폐기된다.
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await setTimers({ custIdle: 500 });
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.waitForTimeout(1400);
    await assert(await count(page, '.cust-ask') === 0 && await count(page, '#custSearchInput') === 1, 'the customer screen must fall back to the empty search after the idle timeout');
    await assert((await page.locator('#custSearchInput').inputValue()) === '', 'the idle reset must discard the previous query');
    await assert((await bt()).locked === true, 'the idle reset must never unlock the app');

    // (8-i) 자동 잠금(프로덕션 90초) — 모달이 열려 있는 동안(서명 중)에는 잠기지 않는다.
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await setTimers({ autoLock: 500 });
    await expandHomeGroups(page);
    await page.locator('[data-a="use"][data-id="cx-3"]').click();
    await page.waitForSelector('#useAmount');
    await page.waitForTimeout(1400);
    await assert(await count(page, '#useAmount') === 1 && (await bt()).locked === false, 'an open modal (signature in progress) must block the auto-lock');
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(1400);
    await assert((await bt()).locked === true && await count(page, '.cust-screen') === 1, 'the app must auto-lock straight into the customer screen when idle');
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');

    // (8-i2) 모달 방치 상한(프로덕션 10분) — 서명 중 즉시 잠김은 여전히 막되, 방치는 결국 잠근다(MEDIUM-3).
    await setTimers({ autoLock: 100000, modalIdleCap: 900 });
    await expandHomeGroups(page);
    await page.locator('[data-a="use"][data-id="cx-3"]').click();
    await page.waitForSelector('#useAmount');
    await page.waitForTimeout(1800);
    await assert((await bt()).locked === true, 'a modal left untouched past the cap must eventually auto-lock');
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '.modal-back') === 0, 'the capped auto-lock must close the modal and show the customer screen');
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await setTimers({ custIdle: 30000, autoLock: 90000, pendingTtl: 120000, pinDelay: 60000, recoveryGate: 60000, modalIdleCap: 600000, ownerPinIdle: 120000 });

    // ───────────────────────────────────────────────────────────────
    // (9) 소속 목록에 등록된 공공기관 추가 — 제안 목록 + orgKind 자동 분류
    //     ⚠️ 매칭 키(라벨|이름)는 그대로다 — 저장되는 org/dept 문자열이 바뀌면 안 된다.
    // ───────────────────────────────────────────────────────────────
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('#quickAddOrg');
    const quickOrgOpts = await page.locator('#quickAddOrgList option').evaluateAll(els => els.map(e => e.value));
    await assert(quickOrgOpts[0] === '개인' && quickOrgOpts[1] === '광진구청', `빠른 등록 소속 제안은 '개인' 다음에 등록된 공공기관명이어야 한다 (got ${JSON.stringify(quickOrgOpts)})`);
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empOrg');
    const modalOrgOpts = await page.locator('#empOrgList option').evaluateAll(els => els.map(e => e.value));
    await assert(modalOrgOpts[0] === '개인' && modalOrgOpts[1] === '광진구청', `한 명씩 등록 소속 제안도 '개인' + 공공기관명이어야 한다 (got ${JSON.stringify(modalOrgOpts)})`);
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(120);
    await page.locator('#quickAddOrg').fill('광진구청');
    await page.locator('#quickAddDept').fill('민원과');
    await page.locator('#quickAddName').fill('새직원');
    await page.locator('#quickAddOpen').fill('9000');
    await page.locator('[data-a="quick-add-employee"]').click();
    await page.waitForTimeout(300);
    const pubDb = await readDb(page);
    const pubEmp = pubDb.employees.find(e => e.name === '새직원');
    await assert(Boolean(pubEmp) && pubEmp.orgKind === 'public', `registering with the registered agency name must mark the employee public (got orgKind="${pubEmp && pubEmp.orgKind}")`);
    await assert(pubEmp.org === '광진구청' && pubEmp.dept === '민원과', 'org/dept must be stored exactly as typed — the match key must not change');
    await assert(balanceOfId(pubDb, pubEmp.id) === 9000, 'the initial charge must still go through the existing open-transaction logic');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(200);
    const pubTitles = await groupTitles();
    await assert(pubTitles.includes('광진구청 민원과'), `a public-classified employee must land in the 공공기관 block (got ${JSON.stringify(pubTitles)})`);
    await assert(pubTitles.indexOf('광진구청 민원과') < pubTitles.indexOf('한빛물산'), `the 공공기관 block must sort ahead of the company block (got ${JSON.stringify(pubTitles)})`);

    // (10) 손님 화면 상태는 백업 파일에도 남지 않는다.
    const custBackups = [];
    const onCustBackup = d => custBackups.push(d);
    page.on('download', onCustBackup);
    await page.locator('.top .tool [data-a="monthly-backup-now"]').click();
    for (let i = 0; i < 25 && !custBackups.length; i += 1) await page.waitForTimeout(100);
    page.off('download', onCustBackup);
    await assert(custBackups.length >= 1, 'the [장부 저장] button should still download a backup');
    const custBackupText = await fsp.readFile(await custBackups[0].path(), 'utf8');
    await assert(!/pendingCustomer|custQuery|lockView|custStage/.test(custBackupText), 'no customer-screen state may leak into the backup file');
    await assert(!/"pinFails"|"pinDelayUntil"/.test(custBackupText), 'the device lock state (pinFails/pinDelayUntil) must not travel inside a backup file');

    // ═══════════════════════════════════════════════════════════════════════
    // (11) 동명이인 구분 마커 '·N' — 라틴 이름 회귀 (HIGH-1/2)
    //   옛 규칙(이름 끝 라틴 소문자)은 ① 'Alex'에 접미사를 못 붙이고 ② 'Alex'/'Alec'을 오병합했다.
    // ═══════════════════════════════════════════════════════════════════════
    // 해시체인이 깨끗한 상태에서 시작한다(앞 절들이 레거시 거래를 섞어 넣어 잔액 검증이 경고를 띄운다).
    await seedHome([
      { id: 'dp-1', org: '광진구청', orgKind: 'public', dept: '세무과', name: '김철수', amount: 30000 }
    ], { orgName: '광진구청' });
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('#csvFile', { state: 'attached' });
    const latinCsv = '소속,부서,이름,금액\r\n한빛물산,영업1팀,Alex,10000\r\n한빛물산,영업1팀,Alex,20000\r\n한빛물산,영업1팀,Alec,30000\r\n';
    await page.locator('#csvFile').setInputFiles({ name: 'latin-dup.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + latinCsv, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 5000 });
    const latinPreview = await page.locator('.modal').innerText();
    await assert(latinPreview.includes('·2'), `the CSV preview must show the new 구분 마커 for a Latin duplicate (got ${JSON.stringify(latinPreview.slice(0, 400))})`);
    await assert(!/[a-z]\/[a-z]\/[a-z] 접미사/.test(latinPreview), 'the CSV preview must no longer promise a/b/c suffixes');
    await page.locator('[data-a="exec-csv"]').click();
    await page.waitForTimeout(500);
    const latinDb = await readDb(page);
    const latinNames = latinDb.employees.filter(e => /^Ale/.test(e.name)).map(e => e.name).sort();
    await assert(JSON.stringify(latinNames) === JSON.stringify(['Alec', 'Alex', 'Alex·2']), `a Latin-name duplicate must get the '·2' marker while a different name is left alone (got ${JSON.stringify(latinNames)})`);
    // first-wins 회귀: 같은 라벨|이름 활성 직원은 절대 두 명이 될 수 없다(마커가 키를 갈라놓는다).
    const activeKeys = latinDb.employees.filter(e => !e.isDeleted).map(e => `${[e.org, e.dept].filter(Boolean).join(' ')}|${e.name}`);
    await assert(new Set(activeKeys).size === activeKeys.length, `duplicate match keys must not exist among active employees (got ${JSON.stringify(activeKeys.filter((k, i) => activeKeys.indexOf(k) !== i))})`);
    // 사장님용 토스트가 떠 있는 채로 손님에게 넘겨도 손님 화면에는 그 문구가 남으면 안 된다(P4).
    await page.locator('[data-a="quick-add-employee"]').click();
    await page.waitForSelector('.toast');
    await assert((await page.locator('.toast').innerText()).includes('직원명'), 'the owner toast must be showing before the handover');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(150);
    // 손님 화면: Alex 두 사람만 병합, Alec은 그대로 조회 가능해야 한다.
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await assert(await count(page, '.toast') === 0, 'an owner-facing toast must never survive into the customer screen');
    await page.locator('#custSearchInput').fill('Alex');
    await page.waitForTimeout(250);
    await assert(await count(page, '.cust-row.dup') === 1, 'the two Alex rows must merge into exactly one 동명이인 row');
    await assert((await page.locator('.cust-row.dup').innerText()).includes('Alex (동명이인 2명)'), `the merged Latin row must keep the full base name (got ${JSON.stringify(await page.locator('.cust-row.dup').innerText())})`);
    await page.locator('#custSearchInput').fill('Alec');
    await page.waitForTimeout(250);
    await assert(await count(page, '.cust-row.dup') === 0, 'Alec must never be merged with Alex');
    await page.waitForSelector('.cust-ask', { timeout: 4000 });
    await assert((await page.locator('.cust-card').innerText()).includes('Alec'), 'Alec must be able to reach the confirmation card on their own');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('.cust-card .cust-name', { timeout: 6000 });
    await assert((await page.locator('.cust-card').innerText()).includes('Alec님'), 'Alec must reach their own detail screen (not merged away)');
    const alecId = latinDb.employees.find(e => e.name === 'Alec').id;
    await assert(balanceOfId(latinDb, alecId) === 30000, 'Alec must own their own balance in the ledger');
    // 손님 화면의 잔액 숫자 — 바로 위에서 3행 CSV를 한 번에 임포트했으므로, 예전(createdAt=now()+Math.random())
    //   이라면 정렬과 체인 순서가 어긋나 여기서 "잔액을 표시할 수 없어요"가 떴다(실행마다 흔들리는 오판).
    //   이제 배치 거래 시각은 단조 증가하고 검증은 체인 연결을 따라가므로 항상 숫자가 보여야 한다.
    await assert(await count(page, '.cust-warn') === 0, 'a healthy ledger must never show the "잔액을 표시할 수 없어요" warning right after a CSV batch import');
    await assert((await page.locator('.cust-bal').innerText()).includes('30,000원'), 'the customer screen must show the balance figure after a batch import');
    await page.locator('[data-a="cust-back"]').click();
    await page.waitForSelector('#custSearchInput');

    // ═══════════════════════════════════════════════════════════════════════
    // (12) "사장님 확인" 화면 방치(HIGH-3) — 손님이 넘긴 PIN 화면에서도 30초 유휴 시계가 돈다.
    //   예전에는 PIN 화면에 들어선 순간 시계가 꺼져 앞 손님의 조회 상태·인계 요청이 무기한 살아남았다.
    //   beta.19: 시계는 손님 흔적이 남는 handoff 맥락에만 건다(owner 맥락은 12-a2에서 반대로 못 박는다).
    // ═══════════════════════════════════════════════════════════════════════
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { custIdle: 700 }));
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    // 손님이 [사장님께 보여주기]로 폰을 넘긴 뒤 사장님이 오지 않은 채 시간이 흐른다.
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    const pinIdleState = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(pinIdleState.custQuery === '' && pinIdleState.custStage === 'search', 'the handover must drop the previous customer search/lookup immediately');
    await assert(pinIdleState.pendingCustomerId !== '', 'the handover must keep the request (that is the whole point of the 사장님 확인 screen)');
    await assert(pinIdleState.pinContext === 'handoff', 'the handover PIN screen must be marked as the handoff context');
    await page.waitForTimeout(1600);
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '[data-a="pin-key"]') === 0, 'an untouched 사장님 확인 screen must fall back to the customer screen after the idle timeout');
    await assert((await bt()).locked === true, 'the PIN-screen idle fallback must never unlock the app');
    const afterPinIdle = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(afterPinIdle.pendingCustomerId === '' && afterPinIdle.custStage === 'search', 'the PIN-screen idle fallback must discard the handover request too');
    await assert(afterPinIdle.pinContext === '', 'the idle fallback must clear the PIN context');
    await assert((await page.locator('#custSearchInput').inputValue()) === '', 'the PIN-screen idle fallback must land on the empty customer search');

    const lockSt = () => page.evaluate(() => window.__prepaidTestHooks.lockState());
    // (12-a2) owner 맥락 PIN 화면의 **두 시계 눈금** — 무한 체류가 아니라 120초(ownerPinIdle)다.
    //   예전 하니스는 여기서 "owner 화면은 유휴 복귀하지 않는다"를 못 박아 두 결함을 통과시켰다:
    //     (a) 부분 입력 PIN이 무기한 남아 다음 사람이 1자리만 맞히면 되는 상태(탐색공간 1/10),
    //     (b) 손님이 [사장님용 잠금 해제]를 오탭하면 태블릿이 PIN 패드에 영구 체류(셀프 조회 정지).
    //   그래서 단언을 뒤집는다 — 30초(custIdle) 눈금에서는 **버티고**(입력 중 보호), 120초 눈금에서는
    //   **손님 화면으로 복귀하며 입력하던 숫자가 지워진다**. custIdle=700 / ownerPinIdle=2800(4배 축척).
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { ownerPinIdle: 2800 }));
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    const ownerPinState = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(ownerPinState.pinContext === 'owner', 'the owner-initiated PIN screen must run in the owner context');
    await assert(ownerPinState.pendingCustomerId === '' && ownerPinState.custQuery === '' && ownerPinState.custStage === 'search', 'the owner-initiated PIN screen must carry no leftover customer state at all');
    await assert((await page.locator('.pin-title').innerText()).trim() === '비밀번호 입력', 'the owner-initiated PIN screen must keep the plain 비밀번호 입력 title');
    await assert((await page.locator('.cust-foot button').innerText()).includes('손님 화면으로'), 'the owner-initiated PIN screen keeps the [손님 화면으로] label');
    // 부분 입력 3자리 — 마지막 키 입력이 시계를 다시 무장시키므로 여기서부터 눈금을 잰다.
    for (const key of ['1', '2', '3']) await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
    await assert((await lockSt()).pinLen === 3, 'the three keys must actually land in the PIN buffer');
    await page.waitForTimeout(1400);  // custIdle(700)의 2배 — 여기서 튀면 "입력 중 화면 튐"이다
    await assert(await count(page, '.pin-screen [data-a="pin-key"]') > 0, 'the owner-initiated PIN screen must NOT bounce back at the 30s (custIdle) mark — the owner may still be picking the four digits');
    await assert((await lockSt()).pinLen === 3, 'the partially typed PIN must survive the 30s mark');
    await page.waitForTimeout(1800);  // 누계 3200ms > ownerPinIdle 2800
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '[data-a="pin-key"]') === 0, 'an abandoned owner-initiated PIN screen must fall back to the customer screen at the 120s (ownerPinIdle) mark');
    const afterOwnerIdle = await lockSt();
    await assert(afterOwnerIdle.locked === true, 'the owner PIN idle fallback must never unlock the app');
    await assert(afterOwnerIdle.pinLen === 0, 'the owner PIN idle fallback must wipe the partially typed PIN (leaving 3 of 4 digits cuts the search space to 1/10)');
    await assert(afterOwnerIdle.pinContext === '' && afterOwnerIdle.custQuery === '' && afterOwnerIdle.custStage === 'search', 'the owner PIN idle fallback must land on the clean customer screen');
    await assert((await page.locator('#custSearchInput').inputValue()) === '', 'the owner PIN idle fallback must land on the empty customer search');
    // 회귀 못 박기: 되돌아온 화면에서 PIN을 다시 열면 점이 하나도 차 있지 않아야 하고,
    //   남은 1자리('4')를 눌러도 잠금이 풀리면 안 된다(옛 동작에서는 이 한 번으로 풀렸다).
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert(await count(page, '.pin-dot.filled') === 0, 'reopening the PIN screen must show an empty PIN buffer');
    await page.locator('[data-a="pin-key"][data-key="4"]').click();
    await page.waitForTimeout(200);
    await assert((await lockSt()).locked === true, 'guessing the single remaining digit must not unlock the app');
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');

    // (12-a2b) 손님 오탭 시나리오 — 손님이 [사장님용 잠금 해제]를 잘못 누르고 그냥 가 버린다.
    //   태블릿이 PIN 패드에 영구 체류하면 다음 손님은 셀프 조회를 시작할 수단 자체가 없다
    //   (매뉴얼 약속: "계산대 위 태블릿은 늘 잠금=손님 화면"). 120초 뒤에는 반드시 되돌아와야 한다.
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await page.waitForTimeout(3400);  // ownerPinIdle(2800)의 1.2배
    await assert(await count(page, '#custSearchInput') === 1, 'a customer who mis-tapped [사장님용 잠금 해제] and walked away must not strand the tablet on the PIN pad');
    await assert((await page.locator('#custSearchInput').inputValue()) === '', 'the mis-tap fallback must clear the previous customer query too');
    await assert((await lockSt()).locked === true, 'the mis-tap fallback must keep the app locked');

    // (12-a2c) 근본 방어 — 인계 요청이 **살아 있는** 상태에서 lock-to-pin이 들어오면 요청을 버린다.
    //   (예전 단언은 "owner 화면엔 pending이 없다"를 손님 상태가 애초에 비어 있는 자리에서 확인해
    //    공허하게 통과했다. 여기서는 요청이 실제로 살아 있는 handoff 화면에서 눌러 본다.
    //    인계 화면에는 그 버튼이 없으므로, 리포 하니스의 위협모델대로 합성 발화로 들어간다.)
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert((await lockSt()).pendingCustomerId !== '', 'the handover request must be alive before the lock-to-pin probe');
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.dataset.a = 'lock-to-pin';
      document.body.appendChild(b);
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      b.remove();
    });
    const afterLockToPin = await lockSt();
    await assert(afterLockToPin.pinContext === 'owner', 'the lock-to-pin probe must land in the owner context');
    await assert(afterLockToPin.pendingCustomerId === '', 'lock-to-pin must discard a live handover request — an "owner context + live request" pair has no cleanup clock of its own and unlocks into a usage modal the owner never asked for');
    await assert(afterLockToPin.locked === true, 'the lock-to-pin probe must keep the app locked');
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { ownerPinIdle: 120000 }));

    // (12-a2d) handoffEmp TTL — 요청이 TTL(pendingTtl)을 넘겼는데도 화면이 "사장님 확인 / ○○○님"을
    //   계속 광고하면 안 된다(잠금 해제 판정과 기준이 달라 사장님이 헛걸음한다). 만료되면 평범한
    //   [비밀번호 입력]으로 폴백하고 요청 자체를 버린다.
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { custIdle: 30000, pendingTtl: 600 }));
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert((await page.locator('.pin-title').innerText()).trim() === '사장님 확인', 'a fresh handover must still be advertised as 사장님 확인');
    // 조작 없이 기다린다 — 화면이 "조작이 있을 때만" 갱신된다면 죽은 요청을 계속 광고하게 된다.
    await page.waitForTimeout(1300);  // TTL 2배 경과(화면 유휴 30초는 아직 멀었다)
    await assert((await page.locator('.pin-title').innerText()).trim() === '비밀번호 입력', 'an expired handover request must fall back to the plain 비밀번호 입력 title on its own (no user action required)');
    await assert(!(await page.locator('.pin-sub').innerText()).includes('김철수'), 'an expired handover request must stop naming the customer');
    await assert((await lockSt()).pendingCustomerId === '', 'an expired handover request must be discarded, not merely hidden');
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { custIdle: 700, pendingTtl: 120000 }));

    // (12-a3) 타이머 교차 ① — "사장님 확인" 화면에서 PIN 5회 실패(60초 지연)로 카운트다운이 도는 중에도
    //   30초 유휴 복귀가 살아 있어야 하고, 되돌아가더라도 **지연 자체는 사라지면 안 된다**(브루트포스 우회 금지).
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { pinDelay: 3000 }));
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    for (let i = 0; i < 5; i += 1) {
      for (const key of ['9', '9', '9', '9']) await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
    }
    await page.waitForSelector('.pin-delay');
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).pinDelayLeft > 0, 'five failures on the 사장님 확인 screen must start the input delay');
    await page.waitForTimeout(1600);
    await assert(await count(page, '.cust-screen') === 1, 'the idle fallback must still fire while the PIN input delay counts down');
    const delayAfterIdle = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(delayAfterIdle.pinDelayLeft > 0, 'bouncing back to the customer screen must NOT clear the input delay (brute-force bypass)');
    await assert(delayAfterIdle.pendingCustomerId === '', 'the idle fallback must drop the handover request even mid-delay');
    await page.waitForTimeout(2200);
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    await assert(!(await page.locator('[data-a="pin-key"][data-key="1"]').isDisabled()), 'the PIN pad must come back once the delay elapses');
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { pinDelay: 60000 }));

    // (12-a4) 타이머 교차 ② — "사장님 확인" 화면에서 [PIN을 잊으셨나요?]로 들어간 복구 화면은
    //   60초 파괴 게이트가 그대로 살아 있고, 게이트가 끝난 뒤 30초를 더 기다렸다가 손님 화면으로 되돌아간다.
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 300 }));
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await page.locator('[data-a="pin-forgot"]').click();
    await page.waitForSelector('[data-a="pin-forgot-restore"]');
    await assert(await page.locator('[data-a="pin-reset"]').isDisabled(), 'the 60s destruction gate must still hold on the recovery screen reached from 사장님 확인');
    await page.waitForTimeout(1800);
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '[data-a="pin-forgot-restore"]') === 0, 'an abandoned recovery screen must fall back to the customer screen');
    const afterRecoveryIdle = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(afterRecoveryIdle.pinRecovery === false && afterRecoveryIdle.pendingCustomerId === '' && afterRecoveryIdle.pinContext === '', 'the recovery idle fallback must clear recovery, the handover request and the PIN context');
    await assert((await bt()).locked === true, 'the recovery idle fallback must never unlock the app');
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { custIdle: 30000, recoveryGate: 60000 }));

    // (12-b) 앞 손님의 인계 요청이 뒷 손님에게 붙으면 안 된다(P3) — [처음으로]가 요청을 즉시 버리고,
    //   그 뒤 새 손님이 넘긴 요청만 살아남아야 한다(결과 1건이면 [cust-pick] 없이 확인 카드로 바로 넘어간다).
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).pendingCustomerId !== '', 'the handover request must exist before [처음으로]');
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');
    const afterCancel = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(afterCancel.pendingCustomerId === '' && afterCancel.pinContext === '', '[처음으로] on the 사장님 확인 screen must discard the handover request');
    await page.locator('#custSearchInput').fill('Alec');
    await page.waitForSelector('.cust-ask');
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).pendingCustomerId === '', 'typing a new query must never resurrect a previous handover request');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert((await page.locator('.pin-sub').innerText()).includes('Alec'), 'the 사장님 확인 screen must name the customer who is standing there now');
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    await assert((await page.locator('.modal .receipt').innerText()).includes('Alec'), 'the handover must open the usage modal for the new customer, never the previous one');
    await assert(!(await page.locator('.modal .receipt').innerText()).includes('김철수'), 'the previous customer must never reappear in the auto-opened modal');
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForSelector('[data-a="quick-find-emp"]');

    // ═══════════════════════════════════════════════════════════════════════
    // (12-c) 원장 해시체인 결정성 — 배치 등록(CSV·기관 승인·직접 전달)의 거래 시각.
    //   회귀 대상: createdAt을 `Date.now()+Math.random()`으로 만들던 시절, 한 배치가 같은
    //   밀리초에 몰리면 "만든 순서"(체인 연결)와 "시각 순서"(검증·표시 정렬)가 어긋나
    //   멀쩡한 장부가 '체인 단절'로 오판됐다 → 손님 화면 "잔액을 표시할 수 없어요",
    //   잔액증표 경고. 실행마다 결과가 흔들리는 비결정적 버그였으므로 반복 실행으로 증명한다.
    // ═══════════════════════════════════════════════════════════════════════
    const chainReport = () => page.evaluate(async () => {
      const c = await window.__prepaidTestHooks.verifyChain();
      return { ok: c.ok, checked: c.checked, legacy: c.legacy, broken: (c.broken || []).map(b => `${b.id}(${b.reason})`) };
    });
    const balanceReport = id => page.evaluate(eid => window.__prepaidTestHooks.verifyBalanceFor(eid), id);
    // 배치 거래를 체인 연결 순서(prevHash→txHash)대로 늘어놓는다.
    //   이 순서와 createdAt 순서가 어긋나는 순간이 바로 예전의 오판 조건이다.
    const chainWalk = (batch) => {
      const byPrev = new Map();
      batch.forEach(t => byPrev.set(String(t.prevHash || ''), t));
      const own = new Set(batch.map(t => String(t.txHash)));
      const head = batch.find(t => !own.has(String(t.prevHash || '')));
      const out = [];
      let cur = head;
      while (cur && out.length <= batch.length) { out.push(cur); cur = byPrev.get(String(cur.txHash)); }
      return out;
    };
    const assertBatchOrder = async (batch, label) => {
      const walk = chainWalk(batch);
      await assert(walk.length === batch.length, `${label}: a batch must form exactly one unbroken chain (walked ${walk.length} of ${batch.length})`);
      for (let i = 0; i < walk.length; i += 1) {
        await assert(Number.isInteger(walk[i].createdAt), `${label}: createdAt must be an integer millisecond, got ${walk[i].createdAt}`);
        if (i) await assert(walk[i].createdAt > walk[i - 1].createdAt, `${label}: chain order must equal time order (#${i} ${walk[i].createdAt} <= #${i - 1} ${walk[i - 1].createdAt})`);
      }
    };
    const waitForNewTx = async (before, n, label) => {
      for (let i = 0; i < 75; i += 1) {
        const txs = (await readDb(page)).transactions.filter(t => !before.has(t.id));
        if (txs.length >= n) return txs;
        await page.waitForTimeout(200);
      }
      throw new Error(`${label}: timed out waiting for ${n} new transactions`);
    };

    // 깨끗한 장부 + 가게 등록 상태(공공기관 수신함·직접 전달 경로를 쓰기 위해)에서 시작한다.
    await seedHome([
      { id: 'det-seed', org: '체인상사', orgKind: '', dept: '회계과', name: '기준직원', amount: 10000 }
    ], { restaurantId: 'harness-chain-shop', relayStoreName: 'Harness Chain Shop', relayRegisteredAt: Date.now(), receivedBatchHashes: [] });
    const chainStart = await chainReport();
    await assert(chainStart.ok, `the determinism suite must start from a healthy ledger (broken: ${chainStart.broken.join(', ')})`);

    // ── (a) CSV 10행 임포트 × 20회 — 매번 체인 검증·손님 화면 판정이 통과해야 한다 ──
    const detNames = Array.from({ length: 10 }, (_, i) => `체인직원${i + 1}`);
    const detCsv = amount => '﻿소속,부서,이름,금액\r\n' + detNames.map(n => `체인상사,회계과,${n},${amount}`).join('\r\n') + '\r\n';
    const runCsvImport = async (csvText, label) => {
      const before = new Set((await readDb(page)).transactions.map(t => t.id));
      await page.locator('#csvFile').setInputFiles({ name: 'chain.csv', mimeType: 'text/csv', buffer: Buffer.from(csvText, 'utf8') });
      await page.waitForSelector('.csv-table', { timeout: 8000 });
      await page.locator('[data-a="exec-csv"]').click();
      await page.waitForSelector('.csv-table', { state: 'detached', timeout: 15000 });
      return waitForNewTx(before, 1, label);
    };
    let detExpected = 0;
    let detEmpId = '';
    for (let round = 1; round <= 20; round += 1) {
      const amount = 1000 + round;
      const batch = await runCsvImport(detCsv(amount), `CSV round ${round}`);
      detExpected += amount;
      await assert(batch.length === 10, `CSV round ${round}: 10 rows must produce 10 transactions (got ${batch.length})`);
      await assertBatchOrder(batch, `CSV round ${round}`);
      const rep = await chainReport();
      await assert(rep.ok, `CSV round ${round}: the hash chain must verify (broken: ${rep.broken.join(', ')})`);
      if (!detEmpId) detEmpId = (await readDb(page)).employees.find(e => e.name === '체인직원1').id;
      const bal = await balanceReport(detEmpId);
      await assert(bal.integrityOk && bal.crossOk, `CSV round ${round}: the customer screen / receipt verdict must pass (integrity=${bal.integrityOk}, cross=${bal.crossOk})`);
    }
    const detDb = await readDb(page);
    await assert(detDb.employees.filter(e => detNames.includes(e.name)).length === 10, 'repeating the same roster must top up the same 10 employees, not stack duplicates');
    await assert(balanceOfId(detDb, detEmpId) === detExpected, `20 imports should accumulate to ${detExpected}, got ${balanceOfId(detDb, detEmpId)}`);

    // 잔액증표(사장님)도 실제로 숫자를 보여줘야 한다(경고 화면이 아니라).
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('#searchInput');
    await page.locator('#searchInput').fill('체인직원1');
    await page.locator(`[data-a="receipt"][data-id="${detEmpId}"]`).click();
    await page.waitForSelector('.receipt-modal', { timeout: 5000 });
    await assert(await count(page, '.receipt-warn') === 0, 'after 20 batch imports the receipt must still show a balance, not an integrity warning');
    await assert((await page.locator('.namecard').innerText()).includes(detExpected.toLocaleString('en-US')), 'the receipt must show the accumulated balance');
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.waitForTimeout(50);
    await page.locator('#searchInput').fill('');

    // ── (c) 같은 밀리초 강제 — Date.now를 고정한 채 배치를 만든다(옛 코드가 무너지던 조건) ──
    await page.evaluate(() => { const fixed = Date.now(); window.__frozenNow = Date.now; Date.now = () => fixed; });
    let frozenBatch;
    try {
      frozenBatch = await runCsvImport(detCsv(9900), 'frozen-clock import');
    } finally {
      await page.evaluate(() => { if (window.__frozenNow) { Date.now = window.__frozenNow; delete window.__frozenNow; } });
    }
    await assert(frozenBatch.length === 10, `a frozen-clock import must still write all 10 transactions (got ${frozenBatch.length})`);
    await assertBatchOrder(frozenBatch, 'frozen-clock import');
    const frozenStamps = frozenBatch.map(t => t.createdAt);
    await assert(new Set(frozenStamps).size === frozenStamps.length, 'transactions created within one millisecond must still get distinct createdAt values');
    const frozenRep = await chainReport();
    await assert(frozenRep.ok, `a frozen-clock batch must verify (broken: ${frozenRep.broken.join(', ')})`);
    detExpected += 9900;
    await assert(balanceOfId(await readDb(page), detEmpId) === detExpected, 'a frozen-clock batch must still land the right balance');
    const frozenBal = await balanceReport(detEmpId);
    await assert(frozenBal.integrityOk && frozenBal.crossOk, 'a frozen-clock batch must leave the customer-screen verdict healthy');

    // ── (b) 기관 배치 — 공공기관 승인(수신함) 10회 + 담당자 직접 전달 5회 ──
    const detMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(Boolean(detMeta.pubKey), 'the institution batch scenarios need the device keypair');
    await page.evaluate(({ pubKey }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const h = async t => { const d = await crypto.subtle.digest('SHA-256', enc.encode(String(t))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      window.__mkBatch = async (items) => {
        const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
        const aesRaw = crypto.getRandomValues(new Uint8Array(32));
        const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
        const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
        const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
        return { batch_hash, ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) } };
      };
      window.__chainInbox = [];
      const orig = window.fetch.bind(window);
      const json = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (u, o) => {
        const url = String(u);
        if (url.includes('/api/inbox?')) return json(JSON.stringify(window.__chainInbox));
        if (url.includes('/api/approve')) return json('{"ok":true}');
        if (url.includes('/api/ledger-backup')) return json('{"ok":true,"updated_at":"2026-08-01T00:00:00Z"}');
        if (url.includes('/api/challenge')) {
          const pk = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
          const cc = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pk, enc.encode('TESTTOKEN'));
          return json(JSON.stringify({ challenge_ct: u2b(cc) }));
        }
        return orig(u, o);
      };
    }, { pubKey: detMeta.pubKey });

    const relayRounds = 10;
    const relayRosters = Array.from({ length: relayRounds }, (_, r) => Array.from({ length: 10 }, (_, i) => ({
      name: i < 5 ? `기관직원${i + 1}` : `기관신규${r + 1}_${i + 1}`,
      dept: '세무과',
      amount: 2000 + r * 10 + i
    })));
    await page.evaluate(async (rosters) => {
      const items = [];
      for (let i = 0; i < rosters.length; i += 1) {
        const b = await window.__mkBatch(rosters[i]);
        items.push({
          summary_id: 'chain-sum-' + i,
          summary: {
            restaurant_name: 'Harness Chain Shop', institution: '강남구청', department: '세무과', year_month: '2026-08',
            total_amount: rosters[i].reduce((s, x) => s + x.amount, 0), member_count: rosters[i].length, batch_hash: b.batch_hash
          },
          ciphertext: b.ciphertext
        });
      }
      window.__chainInbox = items;
    }, relayRosters);
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('[data-a="relay-inbox"]', { timeout: 8000 });
    await page.locator('[data-a="relay-inbox"]').first().click();
    await page.waitForSelector('[data-a="relay-approve"]', { timeout: 10000 });
    for (let r = 0; r < relayRounds; r += 1) {
      const sid = 'chain-sum-' + r;
      const before = new Set((await readDb(page)).transactions.map(t => t.id));
      await page.locator(`[data-a="relay-approve"][data-sid="${sid}"]`).click();
      await page.waitForSelector(`[data-a="relay-approve"][data-sid="${sid}"]`, { state: 'detached', timeout: 20000 });
      const batch = await waitForNewTx(before, 10, `institution approval ${r + 1}`);
      await assertBatchOrder(batch, `institution approval ${r + 1}`);
      const rep = await chainReport();
      await assert(rep.ok, `institution approval ${r + 1}: the hash chain must verify (broken: ${rep.broken.join(', ')})`);
    }
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(100);
    const relayDb = await readDb(page);
    const relayEmp = relayDb.employees.find(e => e.name === '기관직원1');
    await assert(Boolean(relayEmp), 'the approved roster must create the employee');
    await assert(relayDb.employees.filter(e => e.name === '기관직원1').length === 1, 're-approving the same roster must never stack duplicate cards');
    const relayExpected = relayRosters.reduce((s, roster) => s + roster[0].amount, 0);
    await assert(balanceOfId(relayDb, relayEmp.id) === relayExpected, `10 approvals should accumulate to ${relayExpected}, got ${balanceOfId(relayDb, relayEmp.id)}`);
    const relayVerdict = await balanceReport(relayEmp.id);
    await assert(relayVerdict.integrityOk && relayVerdict.crossOk, 'the customer-screen verdict must stay healthy after 10 institution approvals');

    for (let r = 0; r < 5; r += 1) {
      const items = Array.from({ length: 10 }, (_, i) => ({
        name: i < 5 ? `전달직원${i + 1}` : `전달신규${r + 1}_${i + 1}`, dept: '복지과', amount: 3000 + r * 10 + i
      }));
      const payloadJson = await page.evaluate(async ({ items, rid }) => {
        const b = await window.__mkBatch(items);
        return JSON.stringify({
          v: 1, type: 'direct-transfer', restaurant_id: rid, restaurant_name: 'Harness Chain Shop',
          institution: '서초구청', department: '복지과', year_month: '2026-08',
          summary: { total_amount: items.reduce((s, x) => s + x.amount, 0), member_count: items.length, batch_hash: b.batch_hash },
          ciphertext: b.ciphertext
        });
      }, { items, rid: 'harness-chain-shop' });
      const before = new Set((await readDb(page)).transactions.map(t => t.id));
      await page.locator('#directTransferFile').setInputFiles({ name: 'transfer.json', mimeType: 'application/json', buffer: Buffer.from(payloadJson, 'utf8') });
      const batch = await waitForNewTx(before, 10, `direct transfer ${r + 1}`);
      await assertBatchOrder(batch, `direct transfer ${r + 1}`);
      const rep = await chainReport();
      await assert(rep.ok, `direct transfer ${r + 1}: the hash chain must verify (broken: ${rep.broken.join(', ')})`);
    }

    // ── (d) 레거시 장부 호환 — 소수·동률 createdAt이 섞인 옛 백업을 복원해도 검증이 통과해야 한다 ──
    //   옛 배치는 `now()+Math.random()`으로 시각을 뿌렸으므로 "체인 연결 순서 ≠ 시각 순서"인 장부가
    //   이미 사용자 기기에 남아 있다. 그런 장부에서 검증이 깨지면 잔액이 영영 안 보인다.
    const legBase = Date.now() - 3600000;
    const legEmpOf = (id, name) => ({ id, org: '강남상사', orgKind: '', dept: '총무부', name, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: legBase, updatedAt: legBase });
    const legRaw = [
      // [id, 직원, 유형, 금액, 전잔액, 후잔액, createdAt] — 만든 순서(=체인 순서). 시각은 뒤죽박죽이다.
      ['lt-1', 'leg-a', 'open', 31000, 0, 31000, legBase + 0.83],
      ['lt-2', 'leg-b', 'open', 21000, 0, 21000, legBase + 0.12],
      ['lt-3', 'leg-c', 'open', 11000, 0, 11000, legBase + 0.55],
      ['lt-4', 'leg-a', 'topup', 5200, 31000, 36200, legBase + 60000],     // 동률(같은 밀리초)
      ['lt-5', 'leg-b', 'topup', 5300, 21000, 26300, legBase + 60000],     // 동률(같은 밀리초)
      ['lt-6', 'leg-c', 'topup', 5400, 11000, 16400, legBase + 60000.9],
      ['lt-7', 'leg-a', 'use', 2100, 36200, 34100, legBase + 120000]
    ];
    let legPrev = '';
    const legTx = legRaw.map(([id, employeeId, type, amount, beforeBalance, afterBalance, createdAt]) => {
      const txHash = crypto.createHash('sha256').update(`${employeeId}|${amount}|${afterBalance}|${legPrev}|${createdAt}`, 'utf8').digest('hex');
      const row = { id, employeeId, type, amount, beforeBalance, afterBalance, reason: '레거시 기록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash, prevHash: legPrev, createdAt };
      legPrev = txHash;
      return row;
    });
    // 해시가 아예 없던 더 옛 거래(체인 밖) — 예전처럼 legacy로 세고 검증에서 건너뛰어야 한다.
    legTx.push({ id: 'lt-8', employeeId: 'leg-c', type: 'topup', amount: 1700, beforeBalance: 16400, afterBalance: 18100, reason: '해시 이전 기록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: legBase + 180000 });
    const legacyBackup = JSON.stringify({
      schemaVersion: 3, appName: '선입금대장', appVersion: 'legacy', exportedAt: Date.now(),
      payload: {
        employees: [legEmpOf('leg-a', '레거시가'), legEmpOf('leg-b', '레거시나'), legEmpOf('leg-c', '레거시다')],
        transactions: legTx,
        meta: Object.assign({}, detMeta)   // PIN·열쇠·가게 등록은 이 기기 것 그대로 유지
      }
    });
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('#restoreFile', { state: 'attached' });
    await page.locator('#restoreFile').setInputFiles({ name: 'legacy-backup.json', mimeType: 'application/json', buffer: Buffer.from(legacyBackup, 'utf8') });
    for (let i = 0; i < 60; i += 1) {
      const db = await readDb(page);
      if (db.employees.length === 3 && db.employees.every(e => /^레거시/.test(e.name))) break;
      await page.waitForTimeout(200);
    }
    const legDb = await readDb(page);
    await assert(legDb.employees.length === 3 && legDb.transactions.length === 8, `the legacy backup must restore (got ${legDb.employees.length} employees / ${legDb.transactions.length} transactions)`);
    const legRep = await chainReport();
    await assert(legRep.ok, `a legacy ledger with fractional/tied createdAt must still verify (broken: ${legRep.broken.join(', ')})`);
    await assert(legRep.checked === 7 && legRep.legacy === 1, `the hashless legacy transaction must be counted as legacy, not verified (checked=${legRep.checked}, legacy=${legRep.legacy})`);
    await assert(balanceOfId(legDb, 'leg-a') === 34100 && balanceOfId(legDb, 'leg-b') === 26300 && balanceOfId(legDb, 'leg-c') === 18100, 'restoring a legacy ledger must reproduce the exact same balances');
    for (const id of ['leg-a', 'leg-b', 'leg-c']) {
      const verdict = await balanceReport(id);
      await assert(verdict.integrityOk && verdict.crossOk, `${id}: a legacy ledger must pass the customer-screen / receipt verdict`);
    }
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('#searchInput');
    await page.locator('#searchInput').fill('레거시가');
    await page.locator('[data-a="receipt"][data-id="leg-a"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 5000 });
    await assert(await count(page, '.receipt-warn') === 0, 'a restored legacy ledger must show the balance on the receipt, not a warning');
    await assert((await page.locator('.namecard').innerText()).includes('34,100원'), 'the legacy receipt must show the recomputed balance');
    await page.locator('.receipt-modal [data-a="close-modal"]').click();
    await page.locator('#searchInput').fill('');

    // ── (e) 거래 순서는 이력·잔액·검증에서 동일해야 한다 ──
    //   화면(이력)이 쓰는 순서와 잔액 재계산이 쓰는 순서가 같은 비교자(createdAt→id)여야 한다.
    await page.locator('[data-a="screen"][data-screen="history"]').click();
    await page.waitForSelector('.txn', { timeout: 8000 });
    const shownAmounts = (await page.locator('.txn .amt').allInnerTexts()).map(s => s.trim());
    const expectedOrder = ['+1,700원', '-2,100원', '+5,400원', '+5,300원', '+5,200원', '+31,000원', '+11,000원', '+21,000원'];
    await assert(JSON.stringify(shownAmounts) === JSON.stringify(expectedOrder), `the history screen must list transactions in the canonical order (createdAt, then id) — got ${JSON.stringify(shownAmounts)}`);
    const orderIds = await page.evaluate(() => window.__prepaidTestHooks.txOrder());
    await assert(JSON.stringify(orderIds) === JSON.stringify(['lt-2', 'lt-3', 'lt-1', 'lt-4', 'lt-5', 'lt-6', 'lt-7', 'lt-8']), `the canonical ascending order must be stable for tied/fractional timestamps — got ${JSON.stringify(orderIds)}`);
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('#searchInput');

    // 레거시 장부 위에 새 거래를 얹어도 체인이 갈라지면 안 된다(체인 꼬리 = 시각 최댓값이 아니다).
    const legTopupBatch = await runCsvImport('﻿소속,부서,이름,금액\r\n강남상사,총무부,레거시가,900\r\n', 'legacy top-up import');
    await assert(legTopupBatch.length === 1, 'the legacy top-up import must write exactly one transaction');
    const afterLegacyRep = await chainReport();
    await assert(afterLegacyRep.ok, `appending to a legacy ledger must keep the chain verifiable (broken: ${afterLegacyRep.broken.join(', ')})`);
    await assert(balanceOfId(await readDb(page), 'leg-a') === 35000, 'the legacy top-up must land on the existing employee');
    const legacyAfterVerdict = await balanceReport('leg-a');
    await assert(legacyAfterVerdict.integrityOk && legacyAfterVerdict.crossOk, 'appending to a legacy ledger must keep the customer-screen verdict healthy');

    // ═══════════════════════════════════════════════════════════════════════
    // (13) 잠금 중 파일 input 3종 직접 발화 — change 이벤트만으로도 뚫리면 안 된다(CRITICAL-2).
    // ═══════════════════════════════════════════════════════════════════════
    const evilBackup = JSON.stringify({
      schemaVersion: 3, appName: '선입금대장', appVersion: 'x', exportedAt: Date.now(),
      payload: {
        employees: [{ id: 'evil-1', org: '침입자', orgKind: '', dept: '', name: '해커', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: Date.now(), updatedAt: Date.now() }],
        transactions: [],
        meta: { setupComplete: true, shopName: 'PWNED', departments: [], orgName: '침입자' }
      }
    });
    // 반드시 잠금(손님) 화면에서 쏜다 — 사장님 화면에서는 이 경로가 정상 기능이다.
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    const fileGateBefore = await readDb(page);
    const fileDialogsBefore = dialogs.length;
    await page.locator('#restoreFile').setInputFiles({ name: 'evil.json', mimeType: 'application/json', buffer: Buffer.from(evilBackup, 'utf8') });
    await page.waitForTimeout(600);
    await page.locator('#csvFile').setInputFiles({ name: 'evil.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿부서,이름,금액\r\n침입,해커,99999\r\n', 'utf8') });
    await page.waitForTimeout(600);
    await page.locator('#directTransferFile').setInputFiles({ name: 'evil-transfer.json', mimeType: 'application/json', buffer: Buffer.from(evilBackup, 'utf8') });
    await page.waitForTimeout(600);
    const fileGateAfter = await readDb(page);
    await assert(JSON.stringify(fileGateAfter.employees) === JSON.stringify(fileGateBefore.employees), 'firing change on the hidden file inputs while locked must not touch the employee store');
    await assert(JSON.stringify(fileGateAfter.transactions) === JSON.stringify(fileGateBefore.transactions), 'firing change on the hidden file inputs while locked must not touch the ledger');
    await assert(dialogs.length === fileDialogsBefore, 'no restore preview dialog may open from a locked screen');
    await assert((await bt()).locked === true && await count(page, '.cust-screen') === 1, 'the file-input probes must leave the customer screen locked');
    await assert(await count(page, '.busy') === 0, 'a blocked file probe must not leave the busy overlay stuck on screen');

    // ═══════════════════════════════════════════════════════════════════════
    // (14) 정식 복구 경로 — 60초 게이트를 지난 [① 백업 파일로 복구]만이 잠금 중 복원을 통과한다.
    //   ⚠️ 이 검증은 장부를 백업 내용으로 갈아치우므로 반드시 마지막에 둔다.
    // ═══════════════════════════════════════════════════════════════════════
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 700 }));
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    await page.locator('[data-a="pin-forgot"]').click();
    await page.waitForSelector('[data-a="pin-forgot-restore"]');
    await assert(await page.locator('[data-a="pin-forgot-restore"]').isDisabled(), 'the restore button must start disabled behind the gate');
    // 게이트 전에는 allowLockedRestore 플래그가 절대 서지 않는다.
    await page.evaluate(() => document.querySelector('[data-a="pin-forgot-restore"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).allowLockedRestore === false, 'the locked-restore exception must not be granted before the gate elapses');
    await page.waitForTimeout(1200);
    await assert(!(await page.locator('[data-a="pin-forgot-restore"]').isDisabled()), 'the restore button must enable once the gate elapses');
    const goodBackup = JSON.stringify({
      schemaVersion: 3, appName: '선입금대장', appVersion: 'x', exportedAt: Date.now(),
      payload: {
        employees: [{ id: 'rec-1', org: '', orgKind: '', dept: '복구부', name: '복구된직원', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: Date.now(), updatedAt: Date.now() }],
        transactions: [],
        meta: { setupComplete: true, shopName: '복구된가게', departments: [] }
      }
    });
    const [recoveryChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('[data-a="pin-forgot-restore"]').click()
    ]);
    await recoveryChooser.setFiles({ name: 'good-backup.json', mimeType: 'application/json', buffer: Buffer.from(goodBackup, 'utf8') });
    await page.waitForTimeout(1500);
    const recoveredDb = await readDb(page);
    await assert(recoveredDb.employees.length === 1 && recoveredDb.employees[0].name === '복구된직원', `the gated recovery path must actually restore the backup (got ${JSON.stringify(recoveredDb.employees.map(e => e.name))})`);
    // 플래그는 1회용 — 복원이 끝난 뒤 곧바로 회수돼야 한다.
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).allowLockedRestore === false, 'the locked-restore exception must be consumed exactly once');
    // 백업에는 pinHash가 없으므로 복구 뒤에는 새 비밀번호 설정 화면이 떠야 한다.
    await page.waitForSelector('.pin-screen', { timeout: 5000 });
    await assert((await page.locator('.pin-title').innerText()).includes('비밀번호 설정'), 'after a PIN-loss recovery the owner must be asked to set a new PIN');
    // 복원 직후에도 잠금 중 파일 경로는 다시 닫혀 있어야 한다(플래그가 남지 않았다는 증거).
    const postRestoreBefore = await readDb(page);
    await page.locator('#restoreFile').setInputFiles({ name: 'evil2.json', mimeType: 'application/json', buffer: Buffer.from(evilBackup, 'utf8') });
    await page.waitForTimeout(600);
    const postRestoreAfter = await readDb(page);
    await assert(JSON.stringify(postRestoreAfter.employees) === JSON.stringify(postRestoreBefore.employees), 'the restore file path must be closed again right after a legitimate recovery');

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
        homeGroupRegressions: true,
        customerLockScreen: true,
        publicOrgSuggestions: true,
        lockedDestructiveGate: true,
        duplicateNameMarker: true,
        pinScreenIdleFallback: true,
        pinGuardPersisted: true,
        ledgerChainDeterminism: true
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
