#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
// beta.60: 앱의 passVerifierMake와 같은 모양의 백업 암호 검증자(PBKDF2-SHA256 60만 회) — 기기에 "백업 암호를 정해 둔 상태"를 심을 때 쓴다.
function makePassCheck(pass) { const salt = crypto.randomBytes(16); return { v: 1, it: 600000, salt: salt.toString('base64'), hash: crypto.pbkdf2Sync(pass, salt, 600000, 32, 'sha256').toString('hex') }; }
// 메인 시나리오의 기기 백업 암호(오래됨 배너 구간에서 심는다 — 복구 화면 ①②가 이 암호로 열린다).
const MAIN_PASS = 'main-pass-60';
const MAIN_PASS_CHECK = makePassCheck(MAIN_PASS);

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

// beta.55(A-7): 서비스워커의 "HTML 3.5초 시한"을 검증하려고 HTML 응답을 붙잡아 둘 수 있다(기본 꺼짐 — 다른 시나리오 무영향).
const serverCtl = { hangHtml: false, held: [] };
function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const name = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      if (serverCtl.hangHtml && name.endsWith('.html')) { serverCtl.held.push(res); return; }
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
// beta.19/21: 손님이 요청을 넘긴 뒤에는 이미 PIN 패드("사장님 확인")가 떠 있다 —
//   그때는 [사장님용 잠금 해제]가 없으므로 이 헬퍼가 곧바로 4자리를 누른다(인계 경로와 그대로 정합).
// PIN 키패드 입력. beta.31에서 PIN 저장이 PBKDF2(60만 회)로 바뀌면서 4자리째 입력 뒤 검증이
//   수백 ms 걸린다 — 그동안 들어온 탭은 앱이 (정상적으로) 무시한다. 하니스가 20타를 10ms 간격으로
//   때리면 5회 실패 시나리오가 1회로 줄어든다. 그래서 4자리마다 입력칸이 비워질 때까지 기다린다.
// beta.55(C3): "사장님 확인"에 막 들어온 0.5초는 앱이 숫자 키를 일부러 버린다(손님의 두 번째 탭 방지).
//   하니스는 그 창이 지날 때까지 기다렸다가 누른다 — 기다리지 않으면 첫 키가 사라져 4자리가 3자리가 된다.
async function waitPinGuard(page) {
  await page.waitForFunction(() => { const H = window.__prepaidTestHooks; return !H || !H.lockState || !(H.lockState().pinKeyGuardLeft > 0); }, null, { timeout: 5000 }).catch(() => {});
}
async function typePin(page, digits) {
  await waitPinGuard(page);
  for (let i = 0; i < digits.length; i += 1) {
    await page.locator(`[data-a="pin-key"][data-key="${digits[i]}"]`).click();
    if ((i + 1) % 4 === 0) {
      await page.waitForFunction(() => {
        const H = window.__prepaidTestHooks;
        return !H || !H.lockState || H.lockState().pinLen === 0;
      }, null, { timeout: 15000 }).catch(() => {});
    }
  }
}

// ── 씨앗 장부 체인 봉인 ────────────────────────────────────────────────────────
// beta.31부터 해시 체인은 canonical v2 + 꼬리 앵커(meta.chainTip·txCount)로 검증되고,
//   txHash가 없는 거래(구 형식)는 더 이상 조용히 통과하지 않는다("체인을 지우면 검증 우회" 차단).
//   그래서 IndexedDB에 직접 심는 씨앗 거래도 실제 앱이 만든 것과 같은 모양이어야 한다.
//   이 함수는 저장소의 거래 전부를 시간순으로 다시 이어 붙이고 앵커까지 맞춘다.
async function resealChain(page) {
  return page.evaluate(async () => {
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const hex = b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
    const h = async t => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t))));
    const canon = (t, prev) => 'bapjangbu/tx/v2\n' + JSON.stringify([str(t.id), str(t.employeeId), str(t.type),
      num(t.amount), num(t.beforeBalance), num(t.afterBalance), t.targetTransactionId ? str(t.targetTransactionId) : '',
      str(t.signatureHash), str(t.reason), str(t.note), str(prev || ''), num(t.createdAt)]);
    const cmp = (a, b) => (num(a.createdAt) - num(b.createdAt)) || (str(a.id) < str(b.id) ? -1 : str(a.id) > str(b.id) ? 1 : 0);
    const db = await new Promise((res, rej) => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rows = await new Promise((res, rej) => { const q = db.transaction('transactions', 'readonly').objectStore('transactions').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
    const sorted = rows.slice().sort(cmp);
    // 잔액 정합화: 실제 앱이 만든 장부는 언제나 beforeBalance = 직전 afterBalance 이고
    //   beforeBalance ± 금액 = afterBalance 다. beta.31의 금액 대조(reconcile)가 그 관계를 전건 검사하므로
    //   씨앗도 같은 모양이어야 한다(예전 씨앗은 0/0으로 두고 derive 재계산에만 기댔다).
    const run = new Map();
    for (const t of sorted) {
      const k = str(t.employeeId), before = num(run.get(k));
      t.beforeBalance = before;
      t.afterBalance = t.type === 'use' ? before - num(t.amount) : before + num(t.amount);
      run.set(k, t.afterBalance);
    }
    let tip = '';
    for (const t of sorted) {
      if (t.signatureData && !t.signatureHash) t.signatureHash = await h(String(t.signatureData));
      t.hv = 2; t.prevHash = tip; t.txHash = await h(canon(t, tip)); tip = t.txHash;
    }
    await new Promise((res, rej) => {
      const tx = db.transaction(['transactions', 'meta'], 'readwrite');
      const ts = tx.objectStore('transactions');
      sorted.forEach(v => ts.put(v));
      tx.objectStore('meta').put({ key: 'chainTip', value: tip });
      tx.objectStore('meta').put({ key: 'txCount', value: sorted.length });
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
    return { count: sorted.length, tip };
  });
}

// beta.55(A2): 이력 화면 [백업]·[지금 백업하기]는 선택창 → [이 기기에 저장] → 암호 창이다. 이 헬퍼는 '암호 없이'(평문 schemaVersion 3)를 고른다.
//   (서버 단계가 있으면 그 결과와 상관없이 같은 선택창이 뜬다.) 다운로드 뒤의 "파일이 저장됐나요?"는 호출부가 답한다.
async function ownPlainBackupFromDialog(page) {
  await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="save"]', { timeout: 20000 });
  await page.locator('.choice-modal [data-a="choice-pick"][data-val="save"]').click();
  await page.waitForSelector('#keyPassPlain', { timeout: 8000 });
  await page.locator('#keyPassPlain').check();
  await page.locator('[data-a="pass-ok"]').click();
  await page.waitForSelector('#choiceTitle', { timeout: 20000 });
}

// beta.55(A2): 되찾기(복원)의 덮어쓰기 확인과 결과 안내는 앱 안 선택창이다(window.confirm·alert 아님).
//   확인창에서 [되돌리기](data-val=go)를 누르고, 결과 창의 [확인](ok)을 누른다. 백업이 지금보다 적으면 진한 버튼이 [취소]지만 go 값은 같다.
async function confirmInAppRestore(page, timeout = 20000) {
  await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="go"]', { timeout });
  await page.locator('.choice-modal [data-a="choice-pick"][data-val="go"]').click();
  await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="ok"]', { timeout });
  await page.locator('.choice-modal [data-a="choice-pick"][data-val="ok"]').click();
  await page.waitForTimeout(150);
}

// beta.60: 잠금 화면 복구 화면의 [② 백업 파일로 되찾기]는 먼저 이 기기의 백업 암호를 확인하고([백업 암호로 확인해요] 창),
//   맞으면 [백업 파일 고르기]를 한 번 더 받아 그 탭이 파일 창을 연다. 복구 화면이 떠 있는 상태에서 부른다. 돌려주는 값은 파일 창(filechooser).
async function recoveryFileChooser(page, pass) {
  await page.locator('[data-a="pin-forgot-restore"]').click();
  await page.waitForSelector('#keyPass1', { timeout: 8000 });
  await page.locator('#keyPass1').fill(pass);
  await page.locator('[data-a="pass-ok"]').click();
  await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="pick"]', { timeout: 20000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.choice-modal [data-a="choice-pick"][data-val="pick"]').click()]);
  return chooser;
}

async function unlockPin(page) {
  await page.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 8000 });
  if (await page.locator('[data-a="lock-to-pin"]').count()) {
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
  }
  await typePin(page, ['1', '2', '3', '4']);
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

// beta.53: 설정 > 직원 목록 관리의 직원 행은 기본 한 줄(이름·잔액·[관리 ▸])이다. 전화·수정·충전·조정·숨김은
//   그 직원을 펼쳐야 DOM에 생긴다 — 기존 시나리오는 단언을 무르게 하지 않고 '펼치기' 한 단계를 더 밟는다.
async function expandEmpRow(page, id) {
  const tog = page.locator(`[data-a="toggle-emp"][data-id="${id}"]`);
  await tog.waitFor({ timeout: 8000 });
  if ((await tog.getAttribute('aria-expanded')) !== 'true') {
    await tog.click();
    await page.waitForSelector(`[data-a="toggle-emp"][data-id="${id}"][aria-expanded="true"]`, { timeout: 8000 });
  }
}

// beta.27: 온보딩 1/3 앞에 환영 화면(0단계)이 한 장 붙었다. 단계 번호(1/3)는 그대로이고,
//   [시작하기]를 한 번 누르면 다시 뜨지 않는다(meta.welcomeSeen). 설치 직후 화면을 여는 모든 흐름은
//   이 한 장을 먼저 지나야 하므로 헬퍼로 뽑는다 — 여기서 "안 뜨는 경우"도 그대로 통과시킨다(재실행 경로).
async function passWelcome(page) {
  await page.waitForSelector('[data-a="setup-welcome-start"], #setupStoreName, .cust-screen, [data-a="pin-key"]', { timeout: 8000 });
  if (await page.locator('[data-a="setup-welcome-start"]').count()) {
    await page.locator('[data-a="setup-welcome-start"]').click();
    await page.waitForSelector('#setupStoreName', { timeout: 8000 });
    return true;
  }
  return false;
}

// beta.27: 설정 화면의 카드 아코디언. 자주 쓰는 카드(등록·직원 목록)만 펼쳐져 있고 나머지는 접혀 있으며,
//   접힌 카드의 본문은 **DOM에 없다**. 그래서 기존 시나리오가 접힌 카드 안의 버튼을 누르려면
//   먼저 그 카드를 펼쳐야 한다 — 단언을 무르게 고치지 않고 조작 단계를 하나 더 밟는다.
//   이미 펼쳐져 있으면(같은 세션에서 앞 시나리오가 열어 둔 경우) 아무것도 하지 않는다.
async function openSettingsCard(page, key) {
  const head = page.locator(`.fold-head[data-card="${key}"]`);
  await head.waitFor({ timeout: 8000 });
  if ((await head.getAttribute('aria-expanded')) === 'false') {
    await head.click();
    await page.waitForTimeout(80);
  }
  await assert((await page.locator(`.fold-head[data-card="${key}"]`).getAttribute('aria-expanded')) === 'true',
    `settings card "${key}" should be expanded after tapping its header`);
}

// ── beta.55(A-1): 새 서명 = 폭 320px 1비트 흑백 PNG ────────────────────────────────────────
//   ① 헤더(IHDR)가 진짜 1비트 흑백(비트 깊이 1·색 유형 0)이고 폭이 320인지, ② node(zlib)로 직접 푼 픽셀과
//   크로미움이 그림으로 디코드한 픽셀이 **한 점도 다르지 않은지**, ③ 먹 픽셀이 실제로 있는지(빈 그림 아님)를 본다.
const SIG_PNG_LENGTHS = [];
async function checkSigPng(page, dataUrl, label) {
  const zlib = require('zlib');
  await assert(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,'), `${label}: a new signature must be stored as a PNG dataURL (got ${JSON.stringify(String(dataUrl).slice(0, 30))})`);
  await assert(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl), `${label}: the signature must still match SIG_DATAURL_RE`);
  const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  await assert(buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label}: PNG signature bytes`);
  let off = 8; const idat = []; let w = 0, h = 0, depth = -1, ctype = -1;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.slice(off + 4, off + 8).toString('latin1'), data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  await assert(w === 320 && h > 20 && h < 400, `${label}: the signature must be 320px wide with a proportional height (got ${w}x${h})`);
  await assert(depth === 1 && ctype === 0, `${label}: IHDR must say 1-bit grayscale (depth ${depth}, colour type ${ctype})`);
  const raw = zlib.inflateSync(Buffer.concat(idat)); const rowBytes = Math.ceil(w / 8);
  await assert(raw.length === (rowBytes + 1) * h, `${label}: decompressed scanlines must be exactly (1+${rowBytes})x${h} bytes (got ${raw.length})`);
  const nodeInk = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) nodeInk.push(((raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1) ? 0 : 1);
  const browserInk = await page.evaluate(src => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data; const out = [];
      for (let i = 0; i < d.length; i += 4) out.push(d[i] < 128 ? 1 : 0);
      resolve({ w: c.width, h: c.height, ink: out });
    };
    img.onerror = () => reject(new Error('chromium could not decode the signature PNG'));
    img.src = src;
  }), dataUrl);
  await assert(browserInk.w === w && browserInk.h === h, `${label}: chromium must decode the same size`);
  let diff = 0, inked = 0;
  for (let i = 0; i < nodeInk.length; i += 1) { if (nodeInk[i] !== browserInk.ink[i]) diff += 1; inked += nodeInk[i]; }
  await assert(diff === 0, `${label}: chromium-decoded pixels must equal the encoded bits exactly (${diff} differ)`);
  await assert(inked > 40, `${label}: the signature image must actually carry the strokes (${inked} ink pixels)`);
  SIG_PNG_LENGTHS.push({ label, chars: dataUrl.length, w, h, inked });
  return dataUrl.length;
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

// ── beta.26: 온보딩 1/3 "검색으로 고르기" 경로 (독립 컨텍스트) ────────────────────────
//   중복 입력 제거의 핵심 계약을 한 자리에서 못 박는다.
//     ① 1/3에서 **검색으로** 고르면 가게명·주소·전화가 자동으로 채워진다(직접 타이핑 없음).
//     ② 서버 전송은 **약관 동의 이후 단 한 번**(register-key 1회, 그 전에는 0회).
//     ③ 페이로드의 district가 "시도 시군구"로 정확히 실린다(라이브 D1 전건 NULL이었던 그 필드).
//     ④ 설정의 자동 등록 카드는 '등록됨'으로 뜨고 중복 등록 버튼이 없다.
//   본 흐름(아래 main 컨텍스트)은 **직접 입력 경로**를 걷기 때문에 이 경로는 여기서만 검증한다.
async function runSearchOnboarding(browser, url, cors) {
  const context = await browser.newContext({
    acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
  });
  const page = await context.newPage();
  const dialogs = [];
  const problems = [];
  const registerBodies = [];
  // 검색 결과에 전화번호가 실려 오면 그대로 자동 채움된다(현재 라이브 서버는 tel을 내려주지 않는다 — 그때는 빈 칸).
  const results = [
    { restaurant_id: 'rid-other-1', name: '남의 김밥', address: '서울특별시 강남구 역삼동 1-1', tel: '02-000-0000' },
    { restaurant_id: 'rid-mine-1', name: 'Harness Shop', address: '서울특별시 광진구 아차산로 399, 1층 B호 (구의동)', tel: '02-444-5555' }
  ];
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(results) }));
  // beta.49: 검색 결과의 "다른 기기에서 이미 등록됨" 배지는 담당자 웹과 같은 공개 엔드포인트를 쓴다.
  //   목이 없으면 이 호출이 라이브 서버로 새어 나간다 — 반드시 막는다.
  await context.route('**/api/registered**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(['rid-other-1']) }));
  await context.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not found"}' }));
  // beta.60(S-8): 앱은 등록 전에 늘 소유 증명(챌린지)을 먼저 청한다 — 처음 등록하는 가게는 서버에 열쇠가 없어 404(실서버와 같은 답).
  //   목이 없으면 이 요청이 실제 중계 서버로 나간다(하니스는 라이브 서버를 부르지 않는다).
  const challengeCalls = [];
  await context.route('**/api/challenge**', route => { challengeCalls.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"등록된 공개키 없음"}' }); });
  await context.route('**/api/register-key**', route => {
    registerBodies.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
  });
  // beta.49: 배지가 붙은 가게를 고를 때의 확인창만 [취소]로 눌러 보는 스위치(그 외 모든 대화상자는 예전처럼 [확인]).
  let dismissConfirmRe = null;
  page.on('dialog', async d => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === 'confirm' && dismissConfirmRe && dismissConfirmRe.test(d.message())) await d.dismiss();
    else await d.accept();
  });
  page.on('pageerror', err => problems.push(err.message));
  // inbox-count 404(구서버 호환 경로)는 목이 일부러 내는 것이라 콘솔 소음에서 제외한다.
  page.on('console', msg => { if (['error', 'warning'].includes(msg.type()) && !/status of 404/.test(msg.text())) problems.push(`${msg.type()}: ${msg.text()}`); });

  try {
    await page.goto(url, { waitUntil: 'load' });
    // ── beta.27 (0) 첫 실행 환영 화면 ────────────────────────────────────────────
    //   ① 1/3보다 **먼저** 뜬다(설치 직후 첫 화면). ② 단계 번호는 붙지 않는다(1/3·2/3·3/3 표기는 불변).
    //   ③ "돈을 받거나 보내지 않는다"는 안심 문구와 무료 표기가 그 자리에 있다(절대 불변식 1의 사장님 언어).
    //   ④ 버튼은 하나 — 여기서 고를 것이 생기면 인사가 아니라 관문이 된다.
    await page.waitForSelector('[data-a="setup-welcome-start"]');
    await assert(await count(page, '#setupStoreName') === 0, 'the welcome screen must come BEFORE step 1/3 (the store search form must not be on it)');
    await assert(await count(page, '.setup-step') === 0, 'the welcome screen must not carry a step number (1/3·2/3·3/3 numbering stays a 3-step count)');
    const welcomeText = await page.locator('.setup-welcome').innerText();
    // beta.33: 결제 수단은 카드가 대부분이라 "통장 입금"으로 못 박지 않는다 — 중립 표현이어야 한다.
    //   beta.47: 공공기관은 제로페이 결제가 많아 표현을 "결제(제로페이, 카드 등)"로 통일했다(사용자 지시).
    //   beta.57: 결제는 기관뿐 아니라 손님 개인이 하기도 한다 → "기관과 손님, 우리 가게가"(사용자 지시).
    await assert(welcomeText.includes('돈을 받거나 보내지 않아요') && welcomeText.includes('선금 결제(제로페이, 카드 등)') && welcomeText.includes('기관과 손님, 우리 가게가 앱 밖에서 직접'),
      `the welcome screen must carry the "the app never handles money" reassurance in payment-neutral wording (got ${JSON.stringify(welcomeText.slice(0, 200))})`);
    await assert(!/통장|은행 계좌/.test(welcomeText), `the welcome screen must not name the bank account as the only way money arrives (got ${JSON.stringify(welcomeText.slice(0, 200))})`);
    // beta.57(사용자 지시): 환영 화면은 인사 한 장 — 부제·①②③ 설명·"완전 무료" 줄을 뺐다(제목 + 돈 안내 + [시작하기]).
    await assert(!/대신 적어 드려요|①|②|③|완전 무료|광고/.test(welcomeText), `the welcome screen must be just the title, the money reassurance and [시작하기] (got ${JSON.stringify(welcomeText.slice(0, 200))})`);
    // beta.55(A3): "진한 버튼 하나 + 글씨 링크 하나" — 진한 버튼은 여전히 [시작하기] 하나뿐이고, 새 태블릿에서 예전 장부를 되찾는
    //   길은 그 아래 글씨 링크 한 줄이다(누르면 곧바로 파일 고르기). 링크까지 진한 버튼이 되면 인사가 아니라 관문이 된다.
    await assert(await count(page, '.setup-welcome .btn-primary') === 1 && await count(page, '.setup-welcome .btn-primary[data-a="setup-welcome-start"]') === 1, 'the welcome screen must keep exactly one primary button ([시작하기])');
    // beta.57(사용자 결정): 되찾기 글씨 링크는 환영 화면에서 뺐다 — 1/3에서 '이미 등록된 가게'가 나올 때와 [직접 입력할게요] 화면에만 있다
    //   (등록된 가게 쪽 계약은 harness/dongsearch.e2e.mjs 시나리오 K). 여기서는 환영 화면에 없음 + 직접 입력 화면에 있음을 고정한다.
    await assert(await count(page, '.setup-welcome button') === 1 && await count(page, '[data-a="welcome-restore"]') === 0, 'the welcome screen must offer exactly one control ([시작하기]) — the restore link moved to step 1/3');
    await page.locator('[data-a="setup-welcome-start"]').click();
    await page.waitForSelector('#setupStoreName');
    await assert(await count(page, '[data-a="welcome-restore"]') === 0, 'step 1/3 must not show the restore link before any search');
    await page.locator('[data-a="setup-manual-toggle"]').click();
    await page.waitForSelector('#setupManualName');
    await assert(await count(page, '.setup .link-btn[data-a="welcome-restore"]') === 1 && (await page.locator('[data-a="welcome-restore"]').innerText()).includes('백업 파일로 되찾기'), 'the direct-entry screen must carry the text link to restore an old ledger from a backup file');
    await page.locator('[data-a="setup-manual-toggle"]').click();
    await page.waitForSelector('#setupStoreName');
    await assert(await count(page, '[data-a="setup-welcome-start"]') === 0, '[시작하기] must lead straight into 1/3');
    // 재실행(새로고침)에서는 다시 뜨지 않는다 — 인사는 두 번 하지 않는다(meta.welcomeSeen).
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#setupStoreName');
    await assert(await count(page, '[data-a="setup-welcome-start"]') === 0, 'the welcome screen must not come back on a relaunch (meta.welcomeSeen)');
    await assert((await page.locator('.setup-step').innerText()).includes('1 / 3'), 'store search must be step 1 of a 3-step onboarding');
    await assert(await count(page, '#setupManualName') === 0, 'the manual entry form must stay behind the escape hatch (search first)');
    await assert(await count(page, '[data-a="setup-manual-toggle"]') === 1, 'the "직접 입력할게요" escape hatch must be available before searching');

    await page.locator('#setupStoreName').fill('하네스김밥');
    await page.locator('[data-a="setup-store-search"]').click();
    await page.waitForSelector('[data-a="setup-store-pick"]');
    await assert(await count(page, '[data-a="setup-store-pick"]') === 2, 'both mocked search results should be listed');
    await assert(await count(page, '[data-a="setup-manual-toggle"]') === 1, 'the escape hatch must stay visible even when the search DOES return results');
    // beta.49: 이미 다른 기기가 등록한 가게는 **고르기 전에** 말해 준다(예전에는 고른 뒤 401로만 알 수 있었다).
    //   배지는 검색을 지연시키지 않고 뒤따라 붙으며, 붙는 동안 입력칸(#setupStoreName)이 교체되면 안 된다
    //   — 폰에서 그것이 곧 한글 조합 유실이다(설계 원칙 ①). 그래서 전체 render가 아니라 슬롯만 갈아끼운다.
    const searchInputBefore = await page.evaluateHandle(() => document.getElementById('setupStoreName'));
    await page.waitForSelector('.badge-soft', { timeout: 8000 });
    await assert(await count(page, '.badge-soft') === 1, 'only the already-registered result may carry the badge');
    const badgedRow = await page.evaluate(() => {
      const b = document.querySelector('.badge-soft');
      const row = b && b.closest('div').parentElement;
      return { text: b ? b.innerText.trim() : '', name: row ? row.querySelector('div').innerText.trim() : '' };
    });
    await assert(badgedRow.text === '다른 기기에서 이미 등록됨', `the badge must say the store is registered on another device (got ${JSON.stringify(badgedRow.text)})`);
    await assert(badgedRow.name === '남의 김밥', `the badge must land on the already-registered row only (got ${JSON.stringify(badgedRow.name)})`);
    await assert(await page.evaluate(el => el === document.getElementById('setupStoreName'), searchInputBefore),
      'painting the badges must not replace the store-search input node (a full re-render would kill Korean IME input on a phone)');
    // 배지가 붙은 가게를 고르면 확인창이 한 번 더 뜨고, [취소]면 **아무것도 고르지 않은 채 검색 결과에 그대로 남는다**.
    //   (예전 설계인 alert는 "읽고 닫는" 문이라 잘못 고른 사장님에게 되돌릴 길을 주지 않았다.)
    {
      const takenPickRe = /그래도 이 가게로 계속할까요\?/;
      const before = dialogs.length;
      dismissConfirmRe = takenPickRe;
      await page.locator('[data-a="setup-store-pick"]').nth(0).click();// 남의 김밥 = 이미 다른 기기가 등록한 가게
      await page.waitForTimeout(300);
      const asked = dialogs.slice(before).filter(d => d.type === 'confirm' && takenPickRe.test(d.message));
      await assert(asked.length === 1, `picking a badged store must ask once before continuing (got ${asked.length})`);
      await assert(asked[0].message.includes('다른 기기에서 이미 등록돼 있어요') && asked[0].message.includes("'내 열쇠 백업'"),
        `the confirmation must keep the full explanation (got ${JSON.stringify(asked[0].message.slice(0, 120))})`);
      await assert(await count(page, '[data-a="setup-next"]') === 0 && await count(page, '.setup-selected') === 0,
        'declining the confirmation must leave the store unpicked (no selection card, no [다음])');
      await assert(await count(page, '#setupStoreName') === 1 && await count(page, '[data-a="setup-store-pick"]') === 2,
        'declining must leave the owner exactly where they were — in the search results, free to pick another store');
      dismissConfirmRe = null;
    }
    const dialogsBefore = dialogs.length;
    await page.locator('[data-a="setup-store-pick"]').nth(1).click();
    await page.waitForSelector('[data-a="setup-next"]');
    const pickConfirm = dialogs.slice(dialogsBefore).find(d => d.type === 'confirm');
    await assert(Boolean(pickConfirm) && pickConfirm.message.includes('아차산로 399'), 'picking a store must confirm with the store address, not just the name');
    // 자동 채움 계약: 이름·주소는 화면에, 전화는 입력칸에 그대로 들어와 있어야 한다(사장님이 다시 타이핑하지 않는다).
    const selected = await page.locator('.setup-selected').innerText();
    await assert(selected.includes('Harness Shop'), 'the picked store name should be filled in automatically');
    await assert(selected.includes('서울특별시 광진구 아차산로 399'), 'the picked store address should be filled in automatically');
    await assert((await page.locator('#setupStoreTel').inputValue()) === '02-444-5555', 'the picked store phone number should be filled in automatically');
    await assert(await count(page, '#setupStoreName') === 0, 'once a store is picked the search form collapses (the confirmation is the whole screen)');
    await assert(registerBodies.length === 0, 'searching/picking a store must not register anything on the server');

    await page.locator('[data-a="setup-next"]').click();
    await page.waitForSelector('#agencySelectSetup');
    await assert((await page.locator('.setup-step').innerText()).includes('2 / 3'), 'department setup should be step 2 of 3');
    await assert((await page.locator('#agencySelectSetup').inputValue()) === 'gwangjin', 'the picked store address should auto-select the 광진구청 agency');
    await page.locator('[data-a="agency-add-all"][data-ctx="setup"]').click();
    await page.locator('[data-a="setup-to-contact"]').click();
    await page.waitForSelector('#setupContactEmail');
    await assert((await page.locator('.setup-step').innerText()).includes('3 / 3'), 'contact + terms should be the last (3rd) onboarding step');
    await assert(registerBodies.length === 0, 'no register-key call may happen before the terms are agreed');
    await page.locator('#setupTermsChk').check();
    await page.locator('[data-a="setup-complete"]').click();
    await typePin(page, ['1', '2', '3', '4', '1', '2', '3', '4']);
    await page.waitForSelector('[data-a="guide-dismiss"]');

    // 등록은 정확히 한 번, 그리고 district가 실려 있어야 한다.
    await assert(registerBodies.length === 1, `finishing onboarding must call register-key exactly once (got ${registerBodies.length})`);
    await assert(registerBodies[0].restaurant_id === 'rid-mine-1', 'the register-key payload should carry the picked restaurant id');
    await assert(registerBodies[0].restaurant_name === 'Harness Shop', 'the register-key payload should carry the picked restaurant name');
    await assert(registerBodies[0].district === '서울특별시 광진구', `the register-key payload must carry district "시도 시군구" (got ${JSON.stringify(registerBodies[0].district)})`);
    await page.locator('[data-a="guide-dismiss"]').click();
    await assert(await count(page, '[data-a="go-register-store"]') === 0, 'a successful onboarding registration must leave no "finish the registration" banner');

    const meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(meta.shopName === 'Harness Shop', 'meta.shopName should come from the picked store');
    await assert(meta.shopAddr === '서울특별시 광진구 아차산로 399, 1층 B호 (구의동)', 'meta.shopAddr must hold the picked store address (district is derived from it)');
    await assert(meta.storeAddr === meta.shopAddr, 'meta.storeAddr must hold the official (LOCALDATA) address of the picked store');
    await assert(meta.shopTel === '02-444-5555', 'meta.shopTel should come from the picked store');
    await assert(meta.restaurantId === 'rid-mine-1', 'meta.restaurantId should be the picked store id');
    await assert(meta.storeRegisterPending === false, 'a successful onboarding registration should clear the pending flag');
    await assert(typeof meta.districtSyncedAt === 'number' && meta.districtSyncedAt > 0, 'sending a district should stamp districtSyncedAt so the self-heal never runs again');

    // 설정: 자동 등록 카드는 '등록됨' 상태. 중복 등록 버튼(우리 가게 등록 — 처음 한 번)은 없어야 한다.
    // beta.29: 자동 등록 카드도 접힘 — 접힌 요약이 등록 상태를 말하고, 본문 단언은 펼친 뒤에 한다.
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('.fold-head[data-card="enroll-auto"]');
    const enrollSummary = await page.locator('.fold-head[data-card="enroll-auto"]').innerText();
    await assert(enrollSummary.includes('Harness Shop') && enrollSummary.includes('명단 받는 중'), 'the collapsed auto-enroll header must show the registered store and its receiving state');
    await openSettingsCard(page, 'enroll-auto');
    await page.waitForSelector('.agency-current-name');
    const settingsText = await page.locator('.app').innerText();
    await assert(settingsText.includes('공공기관 명단 받는 중'), 'the settings auto-enrollment card must render the registered state');
    await assert(settingsText.includes('관할 지역: 서울특별시 광진구'), 'the settings auto-enrollment card should show the jurisdiction that was sent');
    await assert(await page.locator('[data-a="relay-find-store"]', { hasText: '우리 가게 등록' }).count() === 0, 'no duplicate "우리 가게 등록 (처음 한 번)" button may appear once onboarding registered the store');
    await assert(await page.locator('[data-a="relay-find-store"]', { hasText: '변경' }).count() === 1, 'the registered card should still offer a [변경] path');
    // beta.40: [신청 확인하기] → [온라인 자동 등록]. 이 시점의 inbox-count 목은 404(구서버 호환) → 0건 취급.
    //   0건이면 흐린 모습(btn-idle)이되 **탭은 가능**해야 한다(폴링이 놓친 신청을 사장님이 직접 확인하는 탈출구 — 완전 disabled 금지).
    {
      const inboxBtn = page.locator('[data-a="relay-inbox"]');
      await assert(await inboxBtn.count() === 1, 'the registered auto card must hold exactly one 온라인 자동 등록 button');
      await assert((await inboxBtn.innerText()).includes('온라인 자동 등록'), 'the inbox button must be labeled 온라인 자동 등록 (구 신청 확인하기)');
      await assert(((await inboxBtn.getAttribute('class')) || '').includes('btn-idle'), 'with zero pending requests the 온라인 자동 등록 button must look idle (btn-idle)');
      await assert(await inboxBtn.isEnabled(), 'the idle 온라인 자동 등록 button must stay tappable (never hard-disabled)');
    }

    // 재부팅: 이미 동기화된 기기는 자동 치유가 다시 돌지 않는다(register-key 추가 호출 0).
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    await assert(registerBodies.length === 1, `a device that already synced its district must not re-register on boot (got ${registerBodies.length})`);
    await assert(problems.length === 0, `search onboarding should produce no console errors ${JSON.stringify(problems.slice(0, 3))}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── beta.26: 지역(district) 자동 치유 (독립 컨텍스트) ───────────────────────────────
//   beta.25까지 등록한 기기는 D1에 district가 NULL이라 담당자 웹의 '관할 음식점' 목록에 아예 뜨지 않는다.
//   주소를 아는 기기는 부팅 때 조용히 재등록해 그 칸을 채워야 한다 — 사용자에게는 아무것도 보이지 않는다.
async function runDistrictHeal(browser, url, cors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const dialogs = [];
  const problems = [];
  const bodies = [];
  let status = 500;
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
  await context.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not found"}' }));
  await context.route('**/api/challenge**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"등록된 공개키 없음"}' }));
  await context.route('**/api/register-key**', route => {
    bodies.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status, contentType: 'application/json', headers: cors, body: status === 200 ? '{"ok":true}' : '{"error":"internal"}' });
  });
  page.on('dialog', async d => { dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on('pageerror', err => problems.push(err.message));
  // 자동 치유 실패는 앱이 조용히 삼키므로 콘솔에도 'relay …' 로그만 남는다(목의 404도 소음에서 제외).
  page.on('console', msg => { if (msg.type() === 'error' && !/^relay /.test(msg.text()) && !/status of (404|500)/.test(msg.text())) problems.push(msg.text()); });
  try {
    await page.goto(url, { waitUntil: 'load' });
    const pinHash = crypto.createHash('sha256').update('1234').digest('hex');
    // beta.25에서 등록을 마친 기기 그대로: restaurantId는 있는데 district를 보낸 적이 없다.
    await page.evaluate(({ hash, t }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        const ms = tx.objectStore('meta');
        ms.put({ key: 'setupComplete', value: true });
        ms.put({ key: 'termsAgreedAt', value: t });
        ms.put({ key: 'pinHash', value: hash });
        ms.put({ key: 'storeRegisterPending', value: false });
        ms.put({ key: 'restaurantId', value: 'rid-legacy-1' });
        ms.put({ key: 'relayStoreName', value: '치유식당' });
        ms.put({ key: 'shopName', value: '치유식당' });
        ms.put({ key: 'storeAddr', value: '서울특별시 광진구 아차산로 399, 1층 B호 (구의동)' });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { hash: pinHash, t: Date.now() });

    // (1) 실패해도 조용히 — 화면에는 아무 표시도 남지 않고 districtSyncedAt도 찍히지 않는다.
    const dialogsBefore = dialogs.length;
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    await assert(bodies.length === 1, `a legacy registration should attempt exactly one silent re-register (got ${bodies.length})`);
    await assert(bodies[0].district === '서울특별시 광진구', `the self-heal payload must carry district "시도 시군구" (got ${JSON.stringify(bodies[0].district)})`);
    await assert(dialogs.length === dialogsBefore, 'a failed self-heal must not open any dialog');
    await assert(await count(page, '.toast') === 0, 'a failed self-heal must not show a toast');
    let meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(!meta.districtSyncedAt, 'a failed self-heal must not stamp districtSyncedAt (it retries next boot)');

    // (2) 성공하면 도장이 찍히고, (3) 그 뒤로는 다시 돌지 않는다.
    status = 200;
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    await assert(bodies.length === 2, `a failed self-heal should retry on the next boot (got ${bodies.length})`);
    await assert(await count(page, '.toast') === 0, 'a successful self-heal must stay silent too');
    meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(typeof meta.districtSyncedAt === 'number' && meta.districtSyncedAt > 0, 'a successful self-heal must stamp districtSyncedAt');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    await assert(bodies.length === 2, `the self-heal must run only once after it succeeds (got ${bodies.length})`);
    await assert(problems.length === 0, `district self-heal should produce no unexpected console errors ${JSON.stringify(problems.slice(0, 3))}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// beta.28: 설정의 완전초기화는 열쇠가 지워지기 **전에** 서버 등록을 해제한다(wipeDeregisterGate).
//   안 그러면 서버에 예전 공개키의 고아 등록이 남아 다음 설치의 register-key가 401로 막힌다.
//   검증 3갈래: (A) 해제 실패 경고에서 [취소] → 초기화 중단·데이터 보존
//              (B) 오프라인 경고에서 [취소] → 중단(해제 시도 없음)
//              (C) 온라인 성공 → 소유증명 토큰을 실은 deregister 1회 → 로컬 삭제까지 완주
//   + 정적 계약: pinReset(무PIN 복구 경로)은 절대 해제하지 않는다(제3자 가게 가로채기 방지 — 의도된 비대칭).
async function runWipeDeregister(browser, url, cors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const dialogs = [];
  const problems = [];
  const deregCalls = [];
  const registerCalls = [];
  let deregStatus = 500;
  let dismissRe = null; // 이 정규식에 걸리는 confirm만 [취소], 나머지는 전부 [확인]
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
  await context.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not found"}' }));
  await context.route('**/api/register-key**', route => {
    registerCalls.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
  });
  await context.route('**/api/deregister**', route => {
    deregCalls.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: deregStatus, contentType: 'application/json', headers: cors, body: deregStatus === 200 ? '{"ok":true}' : '{"error":"internal"}' });
  });
  page.on('dialog', async d => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === 'confirm' && dismissRe && dismissRe.test(d.message())) await d.dismiss();
    else await d.accept();
  });
  page.on('pageerror', err => problems.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !/^relay /.test(msg.text()) && !/status of (404|500)/.test(msg.text())) problems.push(msg.text());
  });
  try {
    // 정적 계약부터: fullReset은 게이트를 지나고, pinReset은 지나지 않는다.
    const src = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
    const fullResetSrc = src.slice(src.indexOf('async function fullReset'), src.indexOf('// ── 부서 관리'));
    await assert(fullResetSrc.includes('wipeDeregisterGate'), 'fullReset must pass through wipeDeregisterGate before wiping');
    const pinResetSrc = src.slice(src.indexOf('async function pinReset'), src.indexOf('// ══ 잠금 화면'));
    await assert(!pinResetSrc.includes('wipeDeregisterGate') && !pinResetSrc.includes('/api/deregister'),
      'pinReset (the no-PIN recovery path) must never deregister the store — deliberate asymmetry against store takeover');

    await page.goto(url, { waitUntil: 'load' });
    const pinHash = crypto.createHash('sha256').update('1234').digest('hex');
    // 등록을 마친 기기 상태로 시드. districtSyncedAt을 찍어 부팅 자동 치유(register-key)가 돌지 않게 한다.
    await page.evaluate(({ hash, t }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        const ms = tx.objectStore('meta');
        ms.put({ key: 'setupComplete', value: true });
        ms.put({ key: 'welcomeSeen', value: true });
        ms.put({ key: 'termsAgreedAt', value: t });
        ms.put({ key: 'pinHash', value: hash });
        ms.put({ key: 'storeRegisterPending', value: false });
        ms.put({ key: 'restaurantId', value: 'rid-wipe-1' });
        ms.put({ key: 'relayStoreName', value: '초기화식당' });
        ms.put({ key: 'shopName', value: '초기화식당' });
        ms.put({ key: 'storeAddr', value: '서울특별시 광진구 아차산로 399, 1층 B호 (구의동)' });
        ms.put({ key: 'districtSyncedAt', value: t });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { hash: pinHash, t: Date.now() });
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await page.waitForSelector('[data-a="screen"][data-screen="settings"]', { timeout: 8000 });

    // 소유증명 챌린지는 페이지 fetch 스파이로 응답한다(앱이 방금 부팅에서 만든 공개키로 암호화).
    const bootMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(Boolean(bootMeta.pubKey), 'the seeded device should have generated a keypair at boot');
    const installChallengeSpy = () => page.evaluate(({ pub }) => {
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
        return orig(u, o);
      };
    }, { pub: bootMeta.pubKey });
    await installChallengeSpy();

    const tapFullReset = async () => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await page.waitForTimeout(150);
      const danger = page.locator('details', { hasText: '위험 작업' }).locator('summary');
      await danger.click();
      await page.locator('[data-a="full-reset"]').click();
      await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
      await page.waitForTimeout(250);
    };

    // (A) 해제 실패(500) → 경고 confirm에서 [취소] → 초기화가 중단되고 데이터가 그대로 남는다.
    dismissRe = /해제에 실패/;
    await tapFullReset();
    await assert(deregCalls.length === 1, `a registered wipe should attempt exactly one deregister (got ${deregCalls.length})`);
    const firstConfirm = dialogs.find(d => d.type === 'confirm' && d.message.includes('모든 장부'));
    await assert(Boolean(firstConfirm) && firstConfirm.message.includes('서버의 우리 가게 등록'),
      'the first wipe confirm must disclose that the server registration + cloud backup go too');
    let meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(meta.restaurantId === 'rid-wipe-1', 'declining the deregister-failure warning must abort the wipe (data intact)');

    // (B) 오프라인 → 해제 시도 없이 경고 confirm → [취소] → 중단.
    dismissRe = /인터넷이 연결되어 있지 않아/;
    await context.setOffline(true);
    await tapFullReset();
    await context.setOffline(false);
    await assert(deregCalls.length === 1, 'an offline wipe must not attempt a deregister call');
    await assert(dialogs.some(d => d.type === 'confirm' && /인터넷이 연결되어 있지 않아/.test(d.message)),
      'an offline wipe must warn that the server registration will be orphaned');
    meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(meta.restaurantId === 'rid-wipe-1', 'declining the offline warning must abort the wipe (data intact)');

    // (C) 온라인 성공 → 소유증명 토큰을 실은 deregister → 로컬 삭제 완주 → 온보딩으로.
    dismissRe = null;
    deregStatus = 200;
    await installChallengeSpy(); // (B)의 오프라인 토글로 페이지 상태가 흔들려도 스파이를 보장
    await tapFullReset();
    await assert(deregCalls.length === 2, `an online wipe should deregister exactly once (got ${deregCalls.length - 1})`);
    await assert(deregCalls[1].restaurant_id === 'rid-wipe-1' && deregCalls[1].auth_token === 'TESTTOKEN',
      'the wipe deregister must carry the restaurant id and the proven auth token');
    await page.waitForSelector('#setupStoreName', { timeout: 8000 });
    meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(!meta.restaurantId && !meta.pinHash, 'a completed wipe must clear the registration and the PIN');
    await assert(dialogs.some(d => d.type === 'alert' && d.message.includes('초기화 완료')), 'the wipe should end with the completion alert');
    await assert(registerCalls.length === 0, 'no register-key call may fire anywhere in the wipe scenarios');
    await assert(problems.length === 0, `wipe-deregister scenarios should produce no unexpected console errors ${JSON.stringify(problems.slice(0, 3))}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// beta.31 보안 강화 회귀 — 실제로 재현됐던 취약점이 다시 열리지 않는지 못 박는다.
//   ① CSV 오류 문구 XSS  ② 서명 dataURL XSS  ③ 조작된 백업의 meta 바꿔치기
//   ④ CSP 선언            ⑤ 서비스워커 캐시 오염(교차출처·404)
//   ⑥ 수신함 소유증명 토큰 ⑦⑧ 총액·인원 대조   ⑨ 열쇠 지문   ⑭ 잠금 중 자동 백업 금지
//   ⑯ 해시체인 v2(꼬리 앵커·유형/잔액/서명 변조)
// ══════════════════════════════════════════════════════════════════════════════
async function runSecurityHardening(browser, url, cors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const dialogs = [];
  const problems = [];
  page.on('dialog', async d => { dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on('pageerror', err => problems.push(err.message));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
  await context.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
  await context.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"nf"}' }));
  try {
    await page.goto(url, { waitUntil: 'load' });

    // ── ④ CSP 선언 ────────────────────────────────────────────────────────────
    const csp = await page.evaluate(() => {
      const el = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
      return el ? el.getAttribute('content') : '';
    });
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
      "img-src 'self' data:", 'connect-src', 'https://prepaid-relay.sulsul-plus.workers.dev', 'upgrade-insecure-requests']) {
      await assert(csp.includes(directive), `the CSP meta tag must declare ${directive} (got ${JSON.stringify(csp)})`);
    }
    // meta 형태에서는 frame-ancestors가 무시된다 — 넣어서 "막았다"고 착각하지 않는다(주석으로만 남긴다).
    await assert(!csp.includes('frame-ancestors'), 'frame-ancestors is ignored in a meta CSP — it must not be declared there (clickjacking stays unsolved; see the comment in index.html)');
    // djb2 폴백 제거 + http 차단 화면(정적 계약 — 보안 컨텍스트가 아니면 앱이 뜨면 안 된다)
    const appSrc = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
    await assert(!/x\s*=\s*5381/.test(appSrc), 'the djb2 hash fallback must be gone (a 32-bit hash makes the chain and the PIN forgeable by brute force)');
    await assert(appSrc.includes('안전하지 않은 주소') && appSrc.includes('if(!cryptoOk())'), 'init() must block the app outside a secure context instead of silently degrading');

    // 등록을 마친 기기 상태로 시드(PIN 1234는 구 형식 SHA-256 — 새 형식으로 자동 승격되어야 한다)
    const legacyPinHash = crypto.createHash('sha256').update('1234').digest('hex');
    await page.evaluate(({ hash, t }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        const ms = tx.objectStore('meta');
        ms.put({ key: 'setupComplete', value: true });
        ms.put({ key: 'welcomeSeen', value: true });
        ms.put({ key: 'termsAgreedAt', value: t });
        ms.put({ key: 'pinHash', value: hash });
        ms.put({ key: 'shopName', value: '보안식당' });
        ms.put({ key: 'departments', value: ['총무과'] });
        ms.put({ key: 'storeRegisterPending', value: false });
        ms.put({ key: 'restaurantId', value: 'rid-sec-1' });
        ms.put({ key: 'relayStoreName', value: '보안식당' });
        ms.put({ key: 'relayRegisteredAt', value: t });
        ms.put({ key: 'districtSyncedAt', value: t });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { hash: legacyPinHash, t: Date.now() });
    // 잠금이 실제로 풀렸는지로 판정한다 — 홈의 빠른 버튼은 직원이 있을 때만 그려진다.
    const awaitUnlocked = () => page.waitForFunction(() => {
      const H = window.__prepaidTestHooks;
      return !!H && H.lockState && H.lockState().locked === false;
    }, null, { timeout: 15000 });
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await awaitUnlocked();
    // ⑰ 구 형식 PIN은 첫 성공 즉시 PBKDF2 형식으로 조용히 승격된다(솔트·반복수가 값 안에 들어간다).
    const upgraded = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {}).pinHash;
    await assert(/^pbkdf2\$600000\$[A-Za-z0-9+/=]+\$[0-9a-f]{64}$/.test(String(upgraded)),
      `a legacy SHA-256 PIN must be re-saved as salted PBKDF2 on the first successful unlock (got ${JSON.stringify(String(upgraded).slice(0, 40))})`);
    await assert(String(upgraded) !== legacyPinHash, 'the upgraded PIN hash must not equal the unsalted SHA-256 value');

    // ── ① CSV 오류 문구 XSS ───────────────────────────────────────────────────
    //   재현: 금액 칸에 <img src=x onerror=…> 를 적은 CSV → 미리보기 표에서 그대로 실행됐다.
    const evilCsv = '﻿부서,이름,금액\r\n총무과,홍길동,"<img src=x onerror=window.__CSVXSS=1>"\r\n총무과,김서무,"<svg onload=window.__CSVXSS2=1>"\r\n';
    await page.evaluate(() => { window.__CSVXSS = 0; window.__CSVXSS2 = 0; });
    await page.locator('#csvFile').setInputFiles({ name: 'evil.csv', mimeType: 'text/csv', buffer: Buffer.from(evilCsv, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 8000 });
    const csvProbe = await page.evaluate(() => ({
      fired: !!window.__CSVXSS || !!window.__CSVXSS2,
      injected: document.querySelectorAll('.csv-table img, .csv-table svg, .csv-table [onerror], .csv-table [onload]').length,
      text: document.querySelector('.csv-table').innerText.replace(/\s+/g, ' ')
    }));
    await assert(csvProbe.fired === false, 'a malicious CSV cell must never execute script in the preview table');
    await assert(csvProbe.injected === 0, 'a malicious CSV cell must not inject any element into the preview table');
    await assert(csvProbe.text.includes('금액 오류'), 'the preview must still explain the amount error as plain text');
    // 오류 문구는 원본 셀을 **길이 제한 + 태그 문자 제거**한 뒤에만 싣는다(출력부 esc()가 2중 방어).
    await assert(!/[<>]/.test(csvProbe.text), `the error message must not echo raw markup back (got ${JSON.stringify(csvProbe.text.slice(0, 160))})`);
    await assert(/금액 오류: "[^"]{0,20}"/.test(csvProbe.text), `the echoed cell must stay short (<=20 chars) in the error message (got ${JSON.stringify(csvProbe.text.slice(0, 160))})`);
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(120);

    // ── ②③ 조작된 백업: 서명 dataURL XSS + meta 바꿔치기 ─────────────────────
    const beforeRestore = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(Boolean(beforeRestore.deviceSecret) && Boolean(beforeRestore.privKeyWrapped), 'the device should own a keypair before the tampered-restore test');
    const evilSig = 'data:image/png;base64,AAA" onerror="window.__SIGXSS=1" x="';
    const attackerPin = crypto.createHash('sha256').update('9999').digest('hex');
    const tNow = Date.now();
    const tamperedBackup = JSON.stringify({
      schemaVersion: 3, appName: '선입금대장', appVersion: 'x', exportedAt: tNow,
      payload: {
        employees: [{ id: 'sec-e1', org: '보안기관', orgKind: 'public', dept: '총무과', name: '홍길동', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: tNow - 2000, updatedAt: tNow - 2000 }],
        transactions: [
          { id: 'sec-t1', employeeId: 'sec-e1', type: 'open', amount: 10000, beforeBalance: 0, afterBalance: 10000, reason: '초기', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: tNow - 1500 },
          { id: 'sec-t2', employeeId: 'sec-e1', type: 'use', amount: 1000, beforeBalance: 10000, afterBalance: 9000, reason: '', note: '점심', targetTransactionId: null, signatureData: evilSig, signatureHash: '', txHash: '', prevHash: '', createdAt: tNow - 1000 }
        ],
        // 공격자가 노리는 값들 — 전부 무시되어야 한다.
        meta: { setupComplete: true, shopName: '보안식당', departments: [], pinHash: attackerPin, pinFails: 0, pinDelayUntil: 0, deviceSecret: 'ATTACKER-SECRET', privKeyWrapped: 'ATTACKER-KEY', __proto__: { polluted: 1 }, evilUnknownKey: 'x' }
      }
    });
    await page.evaluate(() => { window.__SIGXSS = 0; });
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('#restoreFile', { state: 'attached' });
    await page.locator('#restoreFile').setInputFiles({ name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(tamperedBackup, 'utf8') });
    await confirmInAppRestore(page);
    for (let i = 0; i < 60; i += 1) {
      const db = await readDb(page);
      if (db.employees.some(e => e.id === 'sec-e1')) break;
      await page.waitForTimeout(200);
    }
    const afterRestore = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(afterRestore.pinHash === beforeRestore.pinHash, 'a restored backup must NEVER replace this device PIN hash (an edited backup used to unlock the app with the attacker PIN)');
    await assert(afterRestore.deviceSecret === beforeRestore.deviceSecret, 'a restored backup must never replace the device secret');
    await assert(afterRestore.privKeyWrapped === beforeRestore.privKeyWrapped, 'a restored backup must never replace the wrapped private key');
    await assert(afterRestore.evilUnknownKey === undefined, 'unknown meta keys from a backup must be dropped by the whitelist');
    await assert(afterRestore.shopName === '보안식당', 'ordinary meta (shop name) must still restore normally');
    // 서명 페이로드: sigD 화이트리스트에서 걸러지고, 남았더라도 esc()로 문자로만 그려진다.
    await assert((await page.evaluate(() => !!window.__SIGXSS)) === false, 'a signature dataURL payload must never execute');
    const storedSig = (await readDb(page)).transactions.find(t => t.id === 'sec-t2');
    await assert(storedSig && storedSig.signatureData === '', `a signature dataURL that is not a clean base64 image must be dropped at the storage boundary (got ${JSON.stringify(storedSig && storedSig.signatureData)})`);
    // 복원 직후 열려 있을 수 있는 모달(안내 등)을 먼저 닫는다 — 화면 전환 클릭이 가려진다.
    // 복원본에 termsAgreedAt이 없으면 약관 동의 게이트가 다시 뜬다(정상) — 동의하고 지나간다.
    if (await count(page, '#termsChk')) {
      await page.locator('#termsChk').check();
      await page.locator('[data-a="terms-agree"]').click();
      await page.waitForTimeout(250);
    }
    for (let i = 0; i < 4 && await count(page, '.modal-back'); i += 1) {
      await page.locator('.modal-back [data-a="close-modal"]').first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(150);
    }
    await assert(await count(page, '.modal-back') === 0, `no modal may stay open after a restore: ${JSON.stringify((await page.evaluate(() => { const m = document.querySelector('.modal-back'); return m ? m.innerText.replace(/\s+/g, ' ').slice(0, 200) : ''; })))}`);
    await page.locator('[data-a="screen"][data-screen="history"]').click();
    await page.waitForTimeout(400);
    const domProbe = await page.evaluate(() => ({
      fired: !!window.__SIGXSS,
      badImgs: document.querySelectorAll('img[onerror], img.thumb[onerror]').length,
      thumbs: [...document.querySelectorAll('img.thumb')].map(i => i.getAttribute('src'))
    }));
    await assert(domProbe.fired === false, 'rendering the restored ledger must not execute the signature payload');
    await assert(domProbe.badImgs === 0, 'no rendered <img> may carry an onerror attribute smuggled through a dataURL');
    await assert(domProbe.thumbs.every(srcVal => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(srcVal || '')), `every rendered signature src must match the strict dataURL whitelist (got ${JSON.stringify(domProbe.thumbs)})`);
    // PIN이 그대로인지 실제로 잠갔다 풀어 확인한다 — 공격자 PIN(9999)은 통하지 않아야 한다.
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('[data-a="hand-to-customer"]');
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    await typePin(page, ['9', '9', '9', '9']);
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).locked === true, 'the attacker PIN from the tampered backup must NOT unlock the app');
    await typePin(page, ['1', '2', '3', '4']);
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).locked === false, 'the real device PIN must still unlock after a restore');
    await assert(afterRestore.pubKey === beforeRestore.pubKey, 'a restore must keep this device public key paired with its private key');
    // 복원은 가게 등록(restaurantId)을 백업 내용으로 바꾼다 — 이 백업에는 없었으므로 지워졌다. 아래 시나리오용으로 다시 심는다.
    await page.evaluate(t => new Promise((res, rej) => {
      const r = indexedDB.open('prepaid-ledger-db');
      r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); const ms = tx.objectStore('meta');
        ms.put({ key: 'restaurantId', value: 'rid-sec-1' }); ms.put({ key: 'relayStoreName', value: '보안식당' });
        ms.put({ key: 'relayRegisteredAt', value: t }); ms.put({ key: 'districtSyncedAt', value: t });
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); };
    }), Date.now());
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await awaitUnlocked();

    // ── ⑨ 열쇠 지문 ───────────────────────────────────────────────────────────
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'enroll-auto');
    await page.waitForSelector('#keyFp', { timeout: 8000 });
    const fpText = (await page.locator('#keyFp').innerText()).trim();
    await assert(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(fpText), `the store key fingerprint must render as ABCD-EF12 (got ${JSON.stringify(fpText)})`);
    const fpExpected = await page.evaluate(async () => {
      const b64 = new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const q = r.result.transaction('meta', 'readonly').objectStore('meta').get('pubKey'); q.onsuccess = () => res(q.result.value); }; });
      const pk = await b64;
      const bin = atob(pk); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const h = await crypto.subtle.digest('SHA-256', u.buffer);
      const hex = Array.from(new Uint8Array(h)).map(v => v.toString(16).padStart(2, '0')).join('').slice(0, 8).toUpperCase();
      return hex.slice(0, 4) + '-' + hex.slice(4, 8);
    });
    await assert(fpText === fpExpected, `the fingerprint must be SHA-256(SPKI) hex[0..8] (expected ${fpExpected}, got ${fpText})`);
    await assert((await page.locator('.settings-card', { hasText: '우리 가게 열쇠 지문' }).innerText()).includes('전화로'),
      'the fingerprint block must explain the phone-confirmation procedure in plain language');
    // beta.45: [복사]는 없앴다. beta.55(A2): 그 자리의 [내 열쇠 백업]도 없앴다 — 열쇠는 [장부 지키기]의 암호 건 백업 파일에
    //   장부와 함께 들어간다. 지문 옆에는 그 사실 한 줄 + [장부 지키기로 가기]만 남는다(메뉴 중복 금지).
    await assert(await count(page, '[data-a="copy-key-fp"]') === 0, 'the fingerprint copy button must be gone (beta.45)');
    await assert(await page.evaluate(() => {
      const card = [...document.querySelectorAll('.settings-card')].find(c => c.innerText.includes('우리 가게 열쇠 지문'));
      return !!(card && !card.querySelector('[data-a="export-key"]') && card.querySelector('[data-a="go-guard"]') && card.querySelector('.key-guard-line'));
    }), 'next to the fingerprint there must be a one-line pointer to 장부 지키기 (no separate key-backup button any more)');
    await assert(await count(page, '[data-a="export-key"]') === 0, 'no separate [내 열쇠 백업] button may remain anywhere (beta.55)');
    // 접힌 채로도 "아직 안 함"이 읽혀야 한다 — 안내 줄의 ⚠️ 배지와 카드 요약은 **같은 사실**(암호 건 내 보관 백업을 한 적 없음)을 말한다.
    const keyWarnSync = await page.evaluate(() => {
      const line = document.querySelector('.key-guard-line');
      const head = document.querySelector('.fold-head[data-card="enroll-auto"] .section-kicker');
      return { badge: !!(line && line.querySelector('.badge-count')), kicker: (head ? head.innerText : '').includes('내 보관 백업') };
    });
    await assert(keyWarnSync.badge === keyWarnSync.kicker, `the ⚠️ badge on the key pointer and the collapsed 자동 등록 summary must agree (${JSON.stringify(keyWarnSync)})`);
    // ── beta.45(현장 지시 7 — "간단명료"): 카드는 위에서부터 **오늘 할 일 → 참고 → 위험** 순이다 ──
    //   예전에는 열쇠 지문(참고 정보)이 맨 위였고, 매일 누르는 [온라인 자동 등록]이 그 아래였다.
    //   앱이 익숙하지 않은 사장님은 화면 맨 위를 "지금 해야 하는 일"로 읽는다.
    const autoOrder = await page.evaluate(() => {
      const card = document.querySelector('.card.settings-card:has(.fold-head[data-card="enroll-auto"])');
      const y = sel => { const el = card.querySelector(sel); return el ? el.getBoundingClientRect().top : NaN; };
      return { store: y('.agency-current'), inbox: y('[data-a="relay-inbox"]'), fp: y('#keyFp'), stop: y('[data-a="relay-stop"]') };
    });
    await assert(autoOrder.store < autoOrder.inbox && autoOrder.inbox < autoOrder.fp && autoOrder.fp < autoOrder.stop,
      `자동 등록 카드 order must read 등록된 가게 → 온라인 자동 등록 → 열쇠 지문 → 자동 등록 중단 (got ${JSON.stringify(autoOrder)})`);

    // ── ⑭ 잠금 중에는 개인키를 쓰는 자동 백업이 돌지 않는다 ──────────────────
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('[data-a="hand-to-customer"]');
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    const lockedBackup = await page.evaluate(async () => {
      window.__authCalls = 0;
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => { if (String(u).includes('/api/challenge') || String(u).includes('/api/ledger-backup')) window.__authCalls += 1; return orig(u, o); };
      const silent = await window.__prepaidTestHooks.relayBackupSilent();
      await window.__prepaidTestHooks.maybeMonthlyAutoBackup();
      window.fetch = orig;
      return { silent, calls: window.__authCalls, locked: window.__prepaidTestHooks.lockState().locked };
    });
    await assert(lockedBackup.locked === true, 'the auto-backup guard test must actually run on the locked screen');
    await assert(lockedBackup.silent === false, 'the silent cloud backup must refuse to run while the app is locked (it unwraps the private key)');
    await assert(lockedBackup.calls === 0, 'no challenge/backup request may leave the device before the PIN is entered');
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    await typePin(page, ['1', '2', '3', '4']);
    await awaitUnlocked();

    // ── ⑤ 서비스워커 캐시: 교차출처·비정상 응답을 담지 않는다 ────────────────
    const swProbe = await page.evaluate(async (relay) => {
      const out = { controller: !!navigator.serviceWorker.controller };
      try { await fetch(relay + '/api/inbox-count?restaurant_id=rid-sec-1'); } catch (e) { out.crossErr = String(e).slice(0, 60); }
      try { await fetch('./__does_not_exist__.json'); } catch (e) { out.missErr = String(e).slice(0, 60); }
      await new Promise(r => setTimeout(r, 400));
      const names = await caches.keys();
      const urls = [];
      for (const n of names) { const c = await caches.open(n); (await c.keys()).forEach(k => urls.push(k.url)); }
      out.urls = urls;
      return out;
    }, 'https://prepaid-relay.sulsul-plus.workers.dev');
    await assert(swProbe.controller === true, 'the service worker must control the page for this cache test to mean anything');
    await assert(!swProbe.urls.some(u => u.includes('/api/')), `the service worker must never cache relay API responses — ciphertext used to persist forever in Cache Storage (got ${JSON.stringify(swProbe.urls.filter(u => u.includes('/api/')))})`);
    await assert(!swProbe.urls.some(u => u.includes('__does_not_exist__')), 'a 404 must never be written into the app-shell cache (cache poisoning)');
    await assert(swProbe.urls.some(u => u.endsWith('/index.html') || u.endsWith('/')), 'the app shell itself must still be cached (offline-first must keep working)');

    // ── ⑥⑦⑧ 수신함 소유증명 + 총액·인원 대조 ───────────────────────────────
    const meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await page.evaluate(async ({ pubKey }) => {
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const sealBlob = async (items) => {
        const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify({ v: 1, items })));
        const raw = await crypto.subtle.exportKey('raw', aes);
        return { alg: 'RSA-OAEP-2048+AES-256-GCM', encKey: u2b(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw)), iv: u2b(iv), ct: u2b(ct) };
      };
      const items = [{ name: '보안가', dept: '총무과', amount: 10000 }, { name: '보안나', dept: '총무과', amount: 20000 }];
      window.__sealBlob = sealBlob; // beta.54 블록이 같은 가게 열쇠로 두 번째 명단을 봉한다
      window.__inboxHeaders = [];
      window.__approveBodies = [];
      // 요약은 서버가 보여 주는 값이다 — 일부러 실제 명단과 어긋나게 만든다(총액 30,000 → 99,000).
      window.__inboxItems = [{
        summary_id: 'sid-bad',
        summary: { institution: '보안기관', department: '총무과', restaurant_id: 'rid-sec-1', restaurant_name: '보안식당', year_month: '2026-08', total_amount: 99000, member_count: 2 },
        ciphertext: await sealBlob(items), status: 'PENDING'
      }];
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const s = String(u);
        if (s.includes('/api/challenge')) {
          const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, new TextEncoder().encode('SECTOKEN'));
          return new Response(JSON.stringify({ challenge_ct: u2b(ct) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (s.includes('/api/inbox?')) {
          const h = (o && o.headers) || {};
          window.__inboxHeaders.push(h['X-Auth-Token'] || h['x-auth-token'] || '');
          return new Response(JSON.stringify(window.__inboxItems), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (s.includes('/api/approve')) { window.__approveBodies.push(JSON.parse(o.body)); return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        return orig(u, o);
      };
    }, { pubKey: meta.pubKey });

    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'enroll-auto');
    await page.locator('[data-a="relay-inbox"]').click();
    await page.waitForSelector('[data-a="relay-approve"]', { timeout: 10000 });
    const inboxHeaders = await page.evaluate(() => window.__inboxHeaders);
    await assert(inboxHeaders.length === 1 && inboxHeaders[0] === 'SECTOKEN',
      `GET /api/inbox must carry the ownership proof token (got ${JSON.stringify(inboxHeaders)})`);
    const empsBefore = (await readDb(page)).employees.length;
    const alertsBefore = dialogs.filter(d => d.type === 'alert').length;
    await page.locator('[data-a="relay-approve"]').click();
    await page.waitForTimeout(1500);
    const blockAlerts = dialogs.filter(d => d.type === 'alert').slice(alertsBefore);
    await assert(blockAlerts.some(d => d.message.includes('차단') && d.message.includes('총액')),
      `a summary whose total does not match the decrypted list must block the import with an explicit reason (got ${JSON.stringify(blockAlerts.map(d => d.message.slice(0, 80)))})`);
    await assert((await readDb(page)).employees.length === empsBefore, 'a blocked batch must not add a single employee');
    await assert((await page.evaluate(() => window.__approveBodies)).length === 0, 'a blocked batch must not be reported as APPROVED to the server');

    // 총액·인원이 맞는 배치는 정상 등록된다(대조가 정상 경로를 막지 않는지 확인).
    await page.evaluate(() => { window.__inboxItems[0].summary.total_amount = 30000; window.__inboxItems[0].summary_id = 'sid-ok'; });
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(150);
    await page.locator('[data-a="relay-inbox"]').click();
    await page.waitForSelector('[data-a="relay-approve"]', { timeout: 10000 });
    await page.locator('[data-a="relay-approve"]').click();
    for (let i = 0; i < 60 && (await readDb(page)).employees.length <= empsBefore; i += 1) await page.waitForTimeout(200);
    const okDb = await readDb(page);
    await assert(okDb.employees.filter(e => /^보안(가|나)$/.test(e.name)).length === 2, 'a matching batch must still import normally');
    await assert((await page.evaluate(() => window.__approveBodies)).length === 1, 'a successful import must report APPROVED exactly once');
    if (await count(page, '.modal-back')) await page.locator('.modal-actions [data-a="close-modal"]').first().click().catch(() => {});
    await page.waitForTimeout(150);

    // ── beta.54: 비슷한 부서 갈림길 · 최근 등록 경고 · 명단 되돌리기 (현장 사고 2026-11-05 재현) ──
    //   ① '보안기관 총무과'(보안가·보안나)가 있는데 '보안기관보건소 총무과' 명단이 오면 승인 전에 앱 안 선택창이 뜬다(기본 confirm은 그 뒤).
    //   ② [기존 부서 이름을 고치고 받기] → 두 사람은 새 카드가 아니라 충전, 확인창에 "(M/D 등록)"과 "최근 14일" 경고가 실린다.
    //   ③ 설정의 [최근 받은 명단]에서 [이 명단 되돌리기] → adjust(targetTransactionId) 기록 + 잔액 원복. 앞선 명단은 뒤 기록 때문에 되돌릴 수 없다.
    const confirmsBefore = dialogs.filter(d => d.type === 'confirm').length;
    await page.evaluate(async () => {
      window.__inboxItems = [{ summary_id: 'sid-health', summary: { institution: '보안기관보건소', department: '총무과', restaurant_id: 'rid-sec-1', restaurant_name: '보안식당', year_month: '2026-09', total_amount: 30000, member_count: 2 },
        ciphertext: await window.__sealBlob([{ name: '보안가', dept: '총무과', amount: 10000 }, { name: '보안나', dept: '총무과', amount: 20000 }]), status: 'PENDING' }];
    });
    await page.locator('[data-a="relay-inbox"]').click();
    await page.waitForSelector('[data-a="relay-approve"]', { timeout: 10000 });
    await page.locator('[data-a="relay-approve"]').click();
    await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="rename"]', { timeout: 10000 });
    const choiceText = await page.locator('.choice-modal').innerText();
    await assert(choiceText.includes('비슷한 부서') && choiceText.includes('보안기관 총무과') && choiceText.includes('이름 2명 겹침'),
      `the near-duplicate dialog must name the existing group and the overlap (got "${choiceText.replace(/\n/g, ' ').slice(0, 200)}")`);
    await assert(dialogs.filter(d => d.type === 'confirm').length === confirmsBefore, 'the money confirm must not appear before the owner answers the near-duplicate question');
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="cancel"]').click();
    await page.waitForTimeout(300);
    await assert(await count(page, '.choice-modal') === 0 && dialogs.filter(d => d.type === 'confirm').length === confirmsBefore, 'cancelling the near-duplicate dialog must skip the money confirm');
    await assert((await readDb(page)).employees.every(e => e.org !== '보안기관보건소'), 'cancel must not rename anything');
    await page.locator('[data-a="relay-approve"]').click();
    await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="rename"]', { timeout: 10000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="rename"]').click();
    for (let i = 0; i < 60 && (await readDb(page)).transactions.filter(t => t.type === 'topup').length < 2; i += 1) await page.waitForTimeout(200);
    const reviewMsg = dialogs.filter(d => d.type === 'confirm').slice(confirmsBefore).map(d => d.message).find(m => m.includes('받으실 금액')) || '';
    await assert(reviewMsg.includes("기존 부서 '보안기관 총무과'의 이름을 '보안기관보건소 총무과'로 고쳐서 받아요"), `the review confirm must say the existing group is being renamed (got "${reviewMsg.slice(0, 200)}")`);
    await assert(/이미 있는 직원 충전 2명/.test(reviewMsg) && /\(\d+\/\d+ 등록\)/.test(reviewMsg), `renamed members must match as top-ups with their last deposit date (got "${reviewMsg.slice(0, 300)}")`);
    await assert(reviewMsg.includes('최근 14일 안에 선금이 등록됐어요') && reviewMsg.includes('승인하지 마세요'), 'a top-up onto a member whose last deposit is recent must carry the double-entry warning');
    {
      const db = await readDb(page);
      const ga = db.employees.find(e => e.name === '보안가'), gn = db.employees.find(e => e.name === '보안나');
      await assert(ga && gn && ga.org === '보안기관보건소' && gn.org === '보안기관보건소' && ga.orgKind === 'public', `rename-and-receive must relabel the existing members (got ${JSON.stringify([ga && ga.org, gn && gn.org])})`);
      await assert(db.employees.filter(e => /^보안(가|나)$/.test(e.name)).length === 2, 'rename-and-receive must not create duplicate cards');
      const tops = db.transactions.filter(t => t.type === 'topup' && t.reason === '공공기관 신청 승인 추가 충전');
      await assert(tops.length === 2 && tops.every(t => t.note.startsWith('보안기관보건소 총무과')), `the batch must land as two top-ups under the new label (got ${JSON.stringify(tops.map(t => t.note))})`);
    }
    if (await count(page, '.modal-back')) await page.locator('.modal-actions [data-a="close-modal"]').first().click().catch(() => {});
    await page.waitForTimeout(150);
    await openSettingsCard(page, 'enroll-auto');
    const batchList = await page.locator('.batch-list').innerText();
    await assert(batchList.includes('보안기관보건소 총무과') && batchList.includes('2명') && batchList.includes('30,000원'), `the enrol card must list the received batch (got "${batchList.replace(/\n/g, ' ').slice(0, 200)}")`);
    await assert(await count(page, '[data-a="undo-batch"]') === 1, 'only the latest batch (no later records) may be undone — the earlier open batch is blocked by the top-ups that followed');
    await page.locator('[data-a="undo-batch"]').click();
    await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="ok"]', { timeout: 5000 });
    await assert((await page.locator('.choice-modal').innerText()).includes('충전된 직원 2명은 그 금액만큼 빼요'), 'the undo dialog must say what will happen to the members');
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="ok"]').click();
    for (let i = 0; i < 60 && (await readDb(page)).transactions.filter(t => t.reason === '명단 등록 되돌리기').length < 2; i += 1) await page.waitForTimeout(200);
    {
      const db = await readDb(page);
      const undo = db.transactions.filter(t => t.reason === '명단 등록 되돌리기');
      const tops = db.transactions.filter(t => t.type === 'topup');
      await assert(undo.length === 2 && undo.every(t => t.type === 'adjust' && tops.some(x => x.id === t.targetTransactionId)), `undo must append one adjust per batch record pointing at the original (got ${JSON.stringify(undo.map(t => [t.type, t.amount, t.targetTransactionId]))})`);
      const bal = id => db.transactions.filter(t => t.employeeId === id).reduce((s, t) => s + (t.type === 'use' ? -Number(t.amount) : Number(t.amount)), 0);
      const ga = db.employees.find(e => e.name === '보안가'), gn = db.employees.find(e => e.name === '보안나');
      await assert(bal(ga.id) === 10000 && bal(gn.id) === 20000 && !ga.isDeleted && !gn.isDeleted, 'undoing a top-up batch must restore the previous balances and keep the members active');
    }
    const afterUndo = await page.locator('.batch-list').innerText();
    await assert(afterUndo.includes('되돌림') && await count(page, '[data-a="undo-batch"]') === 0, 'an undone batch must be marked and must not offer undo again');

    // ── ⑯ 해시체인 v2: 예전에 못 잡던 변조들 ─────────────────────────────────
    const chainRep = () => page.evaluate(async () => {
      const c = await window.__prepaidTestHooks.verifyChain();
      return { ok: c.ok, tamperOk: c.tamperOk, checked: c.checked, legacy: c.legacy, broken: (c.broken || []).map(b => `${b.id}(${b.reason})`) };
    });
    const patchTx = (mut) => page.evaluate(async (m) => new Promise((res, rej) => {
      const r = indexedDB.open('prepaid-ledger-db');
      r.onsuccess = () => {
        const db = r.result;
        const q = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
        q.onsuccess = () => {
          const rows = (q.result || []).slice().sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
          const tx = db.transaction('transactions', 'readwrite');
          const ts = tx.objectStore('transactions');
          const target = rows[rows.length - 1];
          if (m === 'drop-tail') ts.delete(target.id);
          if (m === 'flip-type') ts.put(Object.assign({}, target, { type: target.type === 'use' ? 'topup' : 'use' }));
          if (m === 'before-balance') ts.put(Object.assign({}, target, { beforeBalance: Number(target.beforeBalance) + 12345 }));
          if (m === 'strip-hashes') rows.forEach(row => ts.put(Object.assign({}, row, { txHash: '', prevHash: '', hv: 0 })));
          if (m === 'note') ts.put(Object.assign({}, target, { note: '조작', reason: '조작' }));
          tx.oncomplete = () => res(target.id); tx.onerror = () => rej(tx.error);
        };
      };
    }), mut);
    const reloadUnlocked = async () => { await page.reload({ waitUntil: 'load' }); await unlockPin(page); await awaitUnlocked(); await page.waitForTimeout(150); };

    await reloadUnlocked();
    const clean = await chainRep();
    await assert(clean.tamperOk === true && clean.checked > 0, `a freshly written ledger must verify cleanly (got ${JSON.stringify(clean)})`);
    const snapshot = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const q = r.result.transaction('transactions', 'readonly').objectStore('transactions').getAll(); q.onsuccess = () => res(JSON.parse(JSON.stringify(q.result || []))); }; }));
    const restoreSnapshot = () => page.evaluate(rows => new Promise((res, rej) => {
      const r = indexedDB.open('prepaid-ledger-db');
      r.onsuccess = () => { const tx = r.result.transaction('transactions', 'readwrite'); const ts = tx.objectStore('transactions'); ts.clear(); rows.forEach(v => ts.put(v)); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); };
    }), snapshot);

    for (const [mut, label] of [['drop-tail', '마지막 거래 삭제'], ['flip-type', '거래 유형 변조(use↔topup)'],
      ['before-balance', 'beforeBalance 변조'], ['note', '사유·비고 변조'], ['strip-hashes', '체인 전체 제거(legacy 강등)']]) {
      await patchTx(mut);
      await reloadUnlocked();
      const rep = await chainRep();
      await assert(rep.tamperOk === false, `${label} must be detected by the ledger integrity check (got ${JSON.stringify(rep)})`);
      await restoreSnapshot();
    }
    await reloadUnlocked();
    await assert((await chainRep()).tamperOk === true, 'restoring the untouched ledger must clear the warning again');

    // ── ⑫ 금액 대조가 실제로 무언가를 잡는가(예전 대조식은 항등식이라 언제나 통과했다) ──
    await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('prepaid-ledger-db');
      r.onsuccess = () => {
        const db = r.result;
        const q = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
        q.onsuccess = () => {
          const rows = (q.result || []).slice().sort((a, b) => a.createdAt - b.createdAt);
          const last = rows[rows.length - 1];
          const tx = db.transaction('transactions', 'readwrite');
          // 있지도 않은 충전 1건을 끼워 넣는다(전후 잔액을 전혀 맞추지 않은 채) — 예전 대조는 이것을 통과시켰다.
          tx.objectStore('transactions').put({ id: 'fake-topup', employeeId: last.employeeId, type: 'topup', amount: 999999, beforeBalance: 0, afterBalance: 0, reason: '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', hv: 0, txHash: '', prevHash: '', createdAt: last.createdAt + 5000 });
          tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
        };
      };
    }));
    await reloadUnlocked();
    const recon = await page.evaluate(() => {
      const H = window.__prepaidTestHooks;
      return H.reconcileLedger ? H.reconcileLedger() : null;
    });
    await assert(recon && recon.ok === false, `an injected top-up with inconsistent running balances must fail the amount reconciliation (got ${JSON.stringify(recon)})`);
    await restoreSnapshot();
    await reloadUnlocked();
    await assert((await page.evaluate(() => window.__prepaidTestHooks.reconcileLedger())).ok === true, 'the untouched ledger must reconcile');

    await assert(problems.filter(m => !/status of (401|404|500)/.test(m) && !/no mock/.test(m) && !/^error: (silent cloud backup|relay|register-key|keygen)/.test(m)).length === 0,
      `the security scenario must not raise unexpected console errors: ${JSON.stringify(problems.slice(0, 5))}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── beta.52 현장 결함 수정 (독립 컨텍스트) ─────────────────────────────────────────────
//   ① 내 열쇠 백업: 기기 기본 팝업(window.prompt) 대신 앱 안 입력창. 가입 직후 안내 화면(모달을 그리지 않는 분기)에서도
//      뜨고, 8자 조건을 미리 보여 주며, 두 번 입력해 맞춰 보고, 거절 사유는 창 안에 남는다(3초 토스트로 사라지지 않는다).
//      복원은 틀린 암호를 같은 창에서 다시 묻는다. 어느 단계에서도 기본 팝업은 한 번도 뜨지 않는다.
//   ② 새 명단 알림: 주기 폴링은 없다(사용자 결정). 잠금 해제·설정 진입 때 다시 묻고, 늘었으면 알린다.
//      손님 화면(잠금)에서는 알림을 띄우지 않고 미뤘다가 잠금을 풀 때 알린다. 같은 개수로는 다시 울리지 않는다.
async function runBeta52(browser, url, cors) {
  const context = await browser.newContext({
    acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
  });
  // 설정 진입 재확인 간격(15초)을 하니스에서만 0으로 — 앱은 localhost일 때만 이 값을 읽는다.
  await context.addInitScript(() => { window.__inboxAttnMinMs = 0; });
  const page = await context.newPage();
  const dialogs = [];
  const problems = [];
  let inboxCount = 0;
  const inboxCalls = [];
  const results = [{ restaurant_id: 'rid-b52', name: 'Beta52 Shop', address: '서울특별시 광진구 아차산로 399 (구의동)', tel: '02-444-5252' }];
  // beta.55(A2): 안전망 — 목이 없는 중계 호출(서버 백업 등)은 라이브로 나가지 않고 500으로 끊는다(나중에 건 라우트가 이긴다).
  await context.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(results) }));
  await context.route('**/api/registered**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
  await context.route('**/api/inbox-count**', route => { inboxCalls.push(Date.now()); return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ count: inboxCount }) }); });
  await context.route('**/api/register-key**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' }));
  // beta.60(S-8): 등록 전 소유 증명 시도 — 처음 등록하는 가게는 실서버처럼 404. 그 404 한 줄(브라우저의 자원 실패 로그)만 소음에서 뺀다.
  await context.route('**/api/challenge**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"등록된 공개키 없음"}' }));
  page.on('dialog', async d => { dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
  page.on('pageerror', err => problems.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error' && !(/status of 404/.test(msg.text()) && /\/api\/challenge/.test((msg.location() || {}).url || ''))) problems.push(`console: ${msg.text()}`); });
  const metaOf = async () => (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
  const hint = async () => ({ text: (await page.locator('#keyPassHint').innerText()).trim(), cls: (await page.locator('#keyPassHint').getAttribute('class')) || '' });
  const toastText = async () => (await page.locator('.toast').count()) ? (await page.locator('.toast').innerText()) : '';

  try {
    // 가게 검색 → 등록 → PIN → 가입 직후 안내 화면(setupGuide)
    await page.goto(url, { waitUntil: 'load' });
    await passWelcome(page);
    await page.locator('#setupStoreName').fill('베타52');
    await page.locator('[data-a="setup-store-search"]').click();
    await page.locator('[data-a="setup-store-pick"]').first().click();
    await page.waitForSelector('[data-a="setup-next"]');
    await page.locator('[data-a="setup-next"]').click();
    await page.waitForSelector('#agencySelectSetup');
    await page.locator('[data-a="agency-add-all"][data-ctx="setup"]').click();
    await page.locator('[data-a="setup-to-contact"]').click();
    await page.waitForSelector('#setupTermsChk');
    await page.locator('#setupTermsChk').check();
    await page.locator('[data-a="setup-complete"]').click();
    await typePin(page, ['1', '2', '3', '4', '1', '2', '3', '4']);
    await page.waitForSelector('[data-a="guide-dismiss"]');

    // ── ① 가입 직후 안내 화면에서 [지금 백업하기] — 이 분기는 모달을 그리지 않는다 ──
    //   beta.55(A2): 열쇠를 따로 백업하는 버튼은 없다. 가게 열쇠는 '백업 암호'로 잠근 내 보관 파일에 장부와 함께 들어간다.
    //   beta.52의 암호 창 계약(오버레이·8자 사전 표시·두 번 입력·창 안 사유·비동기 렌더에도 값 유지·보기 토글·끝 공백)은 그대로 이 창이 진다.
    const dlgFrom = dialogs.length;
    await page.locator('[data-a="backup-now"]').first().click();
    await page.waitForSelector('#choiceTitle', { timeout: 8000 });
    await assert((await page.locator('#choiceTitle').innerText()).includes('가게 열쇠'), `with an empty ledger the backup dialog must explain it keeps the shop key (got ${JSON.stringify(await page.locator('#choiceTitle').innerText())})`);
    await assert(await count(page, '[data-a="guide-dismiss"]') === 1, 'the choice box must sit OVER the guide screen, not replace it');
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="save"]').click();
    await page.waitForSelector('#keyPass1', { timeout: 5000 });
    await assert(await count(page, '.pass-back') === 1, 'the backup-password box must appear on the post-signup guide screen (a state.modal would not render there)');
    await assert(await count(page, '[data-a="guide-dismiss"]') === 1, 'the passphrase box must sit OVER the guide screen, not replace it');
    await assert(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'keyPass1', 'the first passphrase field must take focus when the box opens');
    await assert((await page.locator('#keyPass1').getAttribute('type')) === 'password', 'passphrase fields must be password inputs (the old window.prompt echoed the passphrase in clear text)');
    await assert((await page.locator('.pass-modal').innerText()).includes('8자 이상'), 'the 8-character rule must be visible BEFORE the owner types (the old prompt never said it)');
    await assert(await count(page, '#keyPass2') === 1, 'setting the backup password must ask for it twice (one typo = an unopenable backup)');
    // 짧은 암호: 입력 중에는 회색 안내, [저장]을 누르면 창 안에 빨간 사유가 남는다(창은 닫히지 않는다)
    await page.locator('#keyPass1').fill('1234');
    await assert((await hint()).text.includes('지금 4자'), `typing a short passphrase must show the live length hint (got ${JSON.stringify((await hint()).text)})`);
    await page.locator('#keyPass2').fill('1234');
    const dlBefore = [];
    const onDl = d => dlBefore.push(d);
    page.on('download', onDl);
    await page.locator('[data-a="pass-ok"]').click();
    await page.waitForTimeout(200);
    {
      const h = await hint();
      await assert(h.text.includes('너무 짧아요') && h.cls.includes('bad'), `a short passphrase must be refused INSIDE the box in red (got ${JSON.stringify(h)})`);
    }
    await assert(await count(page, '#keyPass1') === 1, 'refusing a short passphrase must keep the box open (the old flow silently quit)');
    await assert(dlBefore.length === 0 && !(await metaOf()).myKeyBackedUpAt && !(await metaOf()).backupPassCheck, 'a refused passphrase must not save anything');
    // 두 칸이 다르면 거절
    await page.locator('#keyPass1').fill('harness-key-01');
    await page.locator('#keyPass2').fill('harness-key-02');
    await page.locator('[data-a="pass-ok"]').click();
    await page.waitForTimeout(150);
    await assert((await hint()).text.includes('서로 달라요'), `mismatched passphrases must be refused inside the box (got ${JSON.stringify((await hint()).text)})`);
    // 비동기 렌더(온라인 복귀 등)가 친 암호를 날리지 않는다
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(250);
    await assert((await page.locator('#keyPass1').inputValue()) === 'harness-key-01', 'an async re-render (online event) must not wipe a passphrase being typed');
    // [입력한 암호 보기]는 값을 지운 채 다시 그리지 않는다
    await page.locator('#keyPassShow').check();
    await assert((await page.locator('#keyPass1').getAttribute('type')) === 'text' && (await page.locator('#keyPass1').inputValue()) === 'harness-key-01', 'show-passphrase must flip the field type and keep what was typed');
    // 맞춘 뒤 저장 — 끝 공백(모바일 자판 자동 띄어쓰기)은 떼고 만든다
    await page.locator('#keyPass2').fill('harness-key-01 ');
    await assert((await hint()).text.includes('두 암호가 같아요'), 'matching passphrases must show the ready hint');
    await page.locator('[data-a="pass-ok"]').click();
    // beta.59: 정한 직후 "📝 백업 암호를 종이에 적어 주세요" 창 — 끝 공백을 뗀 암호를 크게 보여 주고, [종이에 적어 두었어요]를 누르기 전에는 파일을 만들지 않는다.
    //   이 창도 가입 직후 안내 화면 **위에** 뜬다(선택창과 같은 자리).
    await page.waitForSelector('.choice-modal #passWrite', { timeout: 20000 });
    await assert((await page.locator('#passWrite').innerText()).trim() === 'harness-key-01' && (await page.locator('#choiceTitle').innerText()).includes('종이에 적어 주세요') && await count(page, '[data-a="guide-dismiss"]') === 1 && dlBefore.length === 0,
      'right after setting the backup password the write-it-down box must show the trimmed password over the guide screen, before any file is made');
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="ok"]').click();
    for (let i = 0; i < 80 && dlBefore.length < 1; i += 1) await page.waitForTimeout(100);
    page.off('download', onDl);
    await assert(dlBefore.length === 1, `a valid passphrase must download exactly one backup file (got ${dlBefore.length})`);
    const keyName = dlBefore[0].suggestedFilename();
    await assert(/^밥장부백업_\d{4}-\d{2}-\d{2}\.json$/.test(keyName), `the own backup file name (got ${JSON.stringify(keyName)})`);
    const keyPath = await dlBefore[0].path();
    const keyFile = JSON.parse(await fsp.readFile(keyPath, 'utf8'));
    await assert(keyFile.type === 'prepaid-pass-backup' && keyFile.kdf && keyFile.kdf.it === 600000, 'the downloaded file must be a password-locked backup (PBKDF2 600k)');
    await page.waitForSelector('#choiceTitle', { timeout: 8000 });
    await assert((await page.locator('#choiceTitle').innerText()).trim() === '파일이 저장됐나요?', 'the app must ask whether the file is visible instead of claiming it was saved');
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="yes"]').click();
    await page.waitForTimeout(200);
    await assert(await count(page, '.pass-back') === 0, 'the passphrase box must close after saving');
    await assert(typeof (await metaOf()).myKeyBackedUpAt === 'number', 'saving a locked backup (it carries the shop key) must stamp myKeyBackedUpAt (that is what clears the ⚠️ 아직 안 함 badge)');
    await page.waitForTimeout(100);
    await assert(await count(page, '.setup [data-a="backup-now"]') === 0, 'once backed up, the "지금 꼭 할 일: 장부 백업" block must leave the guide screen');
    await page.locator('[data-a="guide-dismiss"]').click();

    // ── 설정 카드에서 [백업 암호] 다시 열기 + Esc 취소(아무것도 저장하지 않는다) ──
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'ledger');
    const check0 = (await metaOf()).backupPassCheck;
    await page.locator('[data-a="backup-pass"]').click();
    await page.waitForSelector('#keyPass1');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await assert(await count(page, '.pass-back') === 0, 'Esc must cancel the passphrase box');
    await assert(JSON.stringify((await metaOf()).backupPassCheck) === JSON.stringify(check0), 'cancelling must not change the backup password');

    // ── 복원: 바쁨 가림막에 가리지 않고, 틀린 암호는 같은 창에서 다시 묻는다 ──
    await page.locator('#restoreFile').setInputFiles(keyPath);
    await page.waitForSelector('#keyPass1', { timeout: 5000 });
    await assert(await count(page, '#keyPass2') === 0, 'restoring asks for the passphrase once (no confirmation field)');
    await assert(await count(page, '.busy') === 0, 'the passphrase box must not sit under the busy overlay while restoring');
    await page.locator('#keyPass1').fill('wrong-pass-99');
    await page.locator('#keyPass1').press('Enter');
    await page.waitForFunction(() => { const h = document.getElementById('keyPassHint'); return h && /암호가 맞지 않아요/.test(h.textContent); }, null, { timeout: 20000 });
    await assert(await count(page, '#keyPass1') === 1, 'a wrong passphrase must ask again in the same box (no need to pick the file again)');
    // 백업은 끝 공백을 뗀 암호로 만들어졌다 → 공백 없이 입력해도 열린다
    await page.locator('#keyPass1').fill('harness-key-01');
    await page.locator('[data-a="pass-ok"]').click();
    await page.waitForSelector('#choiceTitle', { timeout: 20000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="go"]').click();
    await page.waitForFunction(() => { const t = document.getElementById('choiceTitle'); return t && /되찾기를 마쳤어요/.test(t.textContent); }, null, { timeout: 20000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="ok"]').click();
    await assert(dialogs.slice(dlgFrom).filter(d => d.type === 'prompt' || d.type === 'confirm').length === 0 && dialogs.filter(d => d.type === 'prompt').length === 0, `no native prompt/confirm may appear anywhere in the backup/restore flows (got ${JSON.stringify(dialogs.slice(dlgFrom).map(d => d.type + ':' + d.message.slice(0, 40)))})`);

    // ── PIN 분실 복구 화면(잠금 상태)에서도 예전 '내 열쇠 백업' 파일(beta.54 형식)이 열린다 — 암호 창·선택창 버튼이 잠금 게이트를 통과해야 하는 이유 ──
    {
      const keyAtBefore = (await metaOf()).keyCreatedAt;
      const fxKey = path.join(__dirname, 'fixtures', 'beta54-key.json');
      const fxPass = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'beta54-fixtures.meta.json'), 'utf8')).pass;
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await page.locator('[data-a="hand-to-customer"]').click();
      await page.waitForSelector('.cust-screen');
      await page.locator('[data-a="lock-to-pin"]').click();
      await page.waitForSelector('[data-a="pin-forgot"]');
      await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 500 }));
      await page.locator('[data-a="pin-forgot"]').click();
      await page.waitForTimeout(900);
      // beta.60: 복구 화면의 파일 되찾기는 이 기기의 백업 암호(위에서 정한 harness-key-01)가 먼저 맞아야 열린다.
      const chooser = await recoveryFileChooser(page, 'harness-key-01');
      await chooser.setFiles(fxKey);
      await page.waitForSelector('#keyPass1', { timeout: 5000 });
      await assert(await page.evaluate(() => window.__prepaidTestHooks.lockState().locked) === true, 'the recovery-screen key restore runs while the app is still locked');
      await page.locator('#keyPass1').fill(fxPass);
      await page.locator('[data-a="pass-ok"]').click();
      // 이 기기에는 다른 열쇠가 있다 → 바꿀지 묻는다(B-05). 선택창도 잠금 중에 눌려야 한다.
      await page.waitForSelector('.choice-modal [data-val="replace"]', { timeout: 20000 });
      await page.locator('.choice-modal [data-a="choice-pick"][data-val="replace"]').click();
      await page.waitForFunction(() => !document.getElementById('keyPass1') && !document.getElementById('choiceTitle'), null, { timeout: 15000 });
      await page.waitForTimeout(300);
      const keyAtAfter = (await metaOf()).keyCreatedAt;
      await assert(typeof keyAtAfter === 'number' && keyAtAfter > (keyAtBefore || 0), `restoring the key from the PIN-recovery screen must actually import it (keyCreatedAt ${keyAtBefore} → ${keyAtAfter})`);
      await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 60000 }));
      await unlockPin(page);
      await page.waitForSelector('.nav', { timeout: 8000 });
    }

    // ── ② 새 명단 알림 ──
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(300);
    inboxCount = 2;
    const idleFrom = inboxCalls.length;
    await page.waitForTimeout(3000);
    await assert(inboxCalls.length === idleFrom, `with the app left open and untouched there must be no periodic polling (got ${inboxCalls.length - idleFrom} extra calls)`);
    // 잠금 해제 = 바로 확인 → 늘었으면 알린다
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    const beforeUnlock = inboxCalls.length;
    await unlockPin(page);
    await page.waitForFunction(() => /명단 신청이 2건/.test(document.body.innerText), null, { timeout: 5000 });
    await assert(inboxCalls.length > beforeUnlock, 'unlocking must re-check the inbox count right away');
    // 설정 진입 = 바로 확인 → 버튼이 켜진다
    inboxCount = 3;
    const beforeSettings = inboxCalls.length;
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForFunction(() => /명단 신청이 3건/.test(document.body.innerText), null, { timeout: 5000 });
    await assert(inboxCalls.length > beforeSettings, 'entering the settings screen must re-check the inbox count right away');
    await openSettingsCard(page, 'enroll-auto');
    {
      const cls = (await page.locator('[data-a="relay-inbox"]').getAttribute('class')) || '';
      await assert(cls.includes('btn-primary') && !cls.includes('btn-idle'), `with pending requests the 온라인 자동 등록 button must light up (got class ${JSON.stringify(cls)})`);
    }
    // 손님 화면에서는 알림을 미루고, 잠금을 풀 때 알린다
    inboxCount = 4;
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));// 잠긴 동안 조회가 한 번 일어난다
    await page.waitForTimeout(400);
    await assert(!/명단 신청이 4건/.test(await page.locator('body').innerText()), 'the new-list notice must not appear on the customer (locked) screen');
    await unlockPin(page);
    await page.waitForFunction(() => /명단 신청이 4건/.test(document.body.innerText), null, { timeout: 5000 });
    // 같은 개수로는 다시 울리지 않는다
    await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 });
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await unlockPin(page);
    await page.waitForTimeout(600);
    await assert(!/명단 신청이/.test(await toastText()), 'the same pending count must not re-announce on every unlock');
    await assert(problems.length === 0, `beta.52 flows must produce no page errors ${JSON.stringify(problems.slice(0, 3))}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── beta.55 (A1a — 음식점 앱 안전) : 독립 컨텍스트 ─────────────────────────────────────────
//   명단 형식 검사(B-01·B-13)·직접 전달 도메인(B-03)·같은 직원 두 줄(A-10c)·되돌린 입금(B-14)·비슷한 부서(B-07)·
//   선택창 자동 잠금(B-10)·복원 막다른 길(A-10h)·금액 상한(A-10d)·저장 실패 앵커(A-4)·durability(A-10f)·persist(A-6)·
//   CSV 수식 주입(A-10e)·중계 시한(B-04)·쉬운 오류 말(B-12)·깨진 수신함(B-15)·열쇠 짝·덮어쓰기(B-05)·
//   한 창만(A-3, Web Locks와 대비책)·서비스워커 HTML 시한(A-7).
//   E2E_SOFT=1이면 첫 실패에서 멈추지 않고 실패 목록을 모은다 — "수정 전 코드에서 실패하는가"를 단언별로 확인하는 용도.
async function runBeta55(browser, url, cors) {
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.55] ' + msg);
  };
  // E2E_SKIP="B-04 inbox timeout,B-04 approve timeout" — 수정 전 코드에서 영원히 멈추는 구간을 건너뛰어 뒤 구간을 따로 확인할 때만 쓴다.
  const skip = String(process.env.E2E_SKIP || '').split(',').map(x => x.trim()).filter(Boolean);
  const guard = async (label, fn) => {
    if (skip.includes(label)) { console.log('  (건너뜀) ' + label); return; }
    try { await fn(); } catch (err) { if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 200)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 200)}`); }
  };
  const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
  const DAY = 86400000;
  const OLD_AT = Date.now() - 30 * DAY;
  const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const emp = (id, o) => Object.assign({ id, org: '', orgKind: '', dept: '총무과', name: id, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: OLD_AT, updatedAt: OLD_AT }, o);
  const seed = async (page, rid, employees, transactions) => {
    await page.evaluate(({ hash, t, rid, employees, transactions }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta', 'employees', 'transactions'], 'readwrite');
        const ms = tx.objectStore('meta');
        [['setupComplete', true], ['welcomeSeen', true], ['termsAgreedAt', t], ['pinHash', hash], ['shopName', '베타식당'], ['departments', ['세무과', '총무과']],
          ['storeRegisterPending', false], ['restaurantId', rid], ['relayStoreName', '베타식당'], ['relayRegisteredAt', t], ['districtSyncedAt', t], ['myKeyBackedUpAt', t]]
          .forEach(([k, v]) => ms.put({ key: k, value: v }));
        employees.forEach(e => tx.objectStore('employees').put(e));
        transactions.forEach(x => tx.objectStore('transactions').put(x));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { hash: legacyPin, t: Date.now(), rid, employees, transactions });
    if (transactions.length) await resealChain(page);
  };
  const metaOf = async page => (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
  // 설정 > 직원 목록 관리의 소속·부서 묶음은 접혀 있다 — 펼친 뒤 직원 행을 연다.
  const openMgrGroup = async (page, dept) => {
    const head = page.locator(`.mgr-head[data-dept="${dept}"]`).first();
    await head.waitFor({ timeout: 8000 });
    if ((await head.locator('.mgr-toggle').innerText()).includes('▶')) { await head.click(); await page.waitForTimeout(120); }
  };
  const awaitUnlocked = page => page.waitForFunction(() => { const H = window.__prepaidTestHooks; return !!H && H.lockState && H.lockState().locked === false; }, null, { timeout: 15000 });
  const toastText = async page => (await page.locator('.toast').count()) ? (await page.locator('.toast').innerText()) : '';
  const waitToast = async (page, re, ms = 8000) => { try { await page.waitForFunction(src => { const t = document.querySelector('.toast'); return !!t && new RegExp(src).test(t.innerText); }, re.source, { timeout: ms }); return true; } catch (e) { return false; } };
  // 페이지 안에서 직접 전달 파일·수신함 암호문을 실제 계약대로 만든다(가게 공개키로 봉함).
  const installMaker = async (page, rid) => {
    await page.evaluate(({ rid }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const h = async t => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(t))))).map(x => x.toString(16).padStart(2, '0')).join('');
      window.__b55u2b = u2b; window.__b55b2u = b2u;
      window.__b55seal = async (items, pubB64) => {
        const aesRaw = crypto.getRandomValues(new Uint8Array(32));
        const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
        const pub = await crypto.subtle.importKey('spki', b2u(pubB64 || window.__b55pub).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
        return { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw)), iv: u2b(iv), ct: u2b(ct) };
      };
      window.__b55mk = async (items, o) => {
        o = o || {};
        const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
        const total = items.reduce((a, i) => a + Number(i.amount), 0);
        return JSON.stringify({
          v: 1, type: 'direct-transfer', restaurant_id: rid, restaurant_name: '베타식당',
          institution: o.institution || '강남구청', department: o.department || '세무과', year_month: '2026-11',
          summary: Object.assign({ total_amount: total, member_count: items.length, batch_hash }, o.summaryExtra || {}),
          ciphertext: await window.__b55seal(items)
        });
      };
      // 다른 가게의 열쇠 한 쌍 + 그 개인키로 만든 '내 열쇠 백업' 파일(앱과 같은 형식: PBKDF2 120k + AES-GCM).
      window.__b55foreignKey = async pass => {
        const kp = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
        const pub = u2b(await crypto.subtle.exportKey('spki', kp.publicKey));
        const pkcs8 = u2b(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
        const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
        const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
        const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(pkcs8));
        return { pub, pkBackup: JSON.stringify({ v: 1, salt: u2b(salt), iv: u2b(iv), ct: u2b(ct) }) };
      };
    }, { rid });
    const m = await metaOf(page);
    await page.evaluate(pub => { window.__b55pub = pub; }, m.pubKey);
    return m;
  };

  // ───────────────────────── 본 컨텍스트: 등록된 가게 + 직원 ─────────────────────────
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async d => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (d.type() === 'confirm' && d.message().includes('장부 되찾기용 백업')) await d.dismiss(); else await d.accept();
  });
  await context.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' }));
  await context.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
  const RID = 'rid-b55';
  const waitDialog = async (pred, from, ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const d = dialogs.slice(from).find(pred); if (d) return d; await page.waitForTimeout(100); }
    return null;
  };
  const openTransfer = async json => page.locator('#directTransferFile').setInputFiles({ name: 'transfer.json', mimeType: 'application/json', buffer: Buffer.from(json, 'utf8') });
  const doneOrBlocked = d => d.type === 'alert' && (d.message.includes('등록 완료') || d.message.includes('명단 형식') || d.message.includes('차단'));
  const e1Bal = async () => { const db = await readDb(page); return db.transactions.filter(t => t.employeeId === 'b55-e1').reduce((s, t) => s + (t.type === 'use' ? -Number(t.amount) : Number(t.amount)), 0); };
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await seed(page, RID, [
      emp('b55-e1', { org: '강남구청', orgKind: 'public', dept: '세무과', name: '홍길동' }),
      emp('b55-d1', { dept: '총무과', name: '박복원', isDeleted: true }),
      emp('b55-d2', { dept: '총무과', name: '박복원' }),
      emp('b55-f1', { dept: '총무과', name: '=1+2' })
    ], [
      { id: 'b55-t0', employeeId: 'b55-e1', type: 'open', amount: 5000, beforeBalance: 0, afterBalance: 5000, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', createdAt: OLD_AT }
    ]);
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await awaitUnlocked(page);
    await installMaker(page, RID);

    // A-6: 저장소 보존 요청은 한 번 한다(결과는 묻지 않는다)
    await guard('A-6', async () => {
      await check(await page.evaluate(() => window.__persistRequested === true), 'A-6: the app must ask navigator.storage.persist() once after load');
    });

    // B-03: 직접 전달 파일에 적힌 agency_domain은 "인증 도메인"이 아니다
    let r1TxId = '';
    await guard('B-03', async () => {
      const from = dialogs.length;
      await openTransfer(await page.evaluate(() => window.__b55mk([{ name: '홍길동', dept: '세무과', amount: 1000 }], { summaryExtra: { agency_domain: 'gangnam.go.kr', sent_at: Date.UTC(2026, 10, 1, 1, 2, 0) } })));
      await waitDialog(doneOrBlocked, from);
      const review = dialogs.slice(from).find(d => d.type === 'confirm' && d.message.includes('받으실 금액'));
      await check(review && review.message.includes('인증 도메인: 확인 불가(직접 전달)'), `B-03: a direct transfer must always say 인증 도메인: 확인 불가(직접 전달) (got ${JSON.stringify(review && review.message.slice(0, 400))})`);
      await check(review && !review.message.includes('gangnam.go.kr'), 'B-03: a domain written inside the file must never be shown as authenticated');
      await check(review && review.message.includes('파일에 적힌 작성 시각'), 'B-03: the time in a direct-transfer file must be labelled as written-in-file');
      const db = await readDb(page);
      const t1 = db.transactions.find(t => t.employeeId === 'b55-e1' && t.type === 'topup');
      r1TxId = t1 ? t1.id : '';
      await check(t1 && t1.beforeBalance === 5000 && t1.afterBalance === 6000, 'B-03 setup: the first roster must top up 5,000 → 6,000');
    });

    // B-14: 되돌리기 창이 "고친 부서 이름은 되돌아가지 않는다"고 말한다
    await guard('B-14 undo note', async () => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'enroll-auto');
      await page.locator('[data-a="undo-batch"]').first().click();
      await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="ok"]', { timeout: 5000 });
      const txt = await page.locator('.choice-modal').innerText();
      await check(txt.includes('고친 부서 이름은 되돌아가지 않아요'), `B-14: the undo dialog must say a renamed department is not reverted (got ${JSON.stringify(txt.slice(0, 300))})`);
      await page.locator('.choice-modal [data-a="choice-pick"][data-val="ok"]').click();
      for (let i = 0; i < 40 && !(await readDb(page)).transactions.some(t => t.reason === '명단 등록 되돌리기'); i += 1) await page.waitForTimeout(150);
      await check(await e1Bal() === 5000, 'B-14 setup: undoing the first roster must bring 홍길동 back to 5,000');
    });

    // B-14 + A-10c: 되돌린 입금은 "최근 등록"이 아니고, 같은 직원 두 줄은 잔액을 이어 간다
    await guard('A-10c/B-14', async () => {
      const from = dialogs.length;
      await openTransfer(await page.evaluate(() => window.__b55mk([{ name: '홍길동', dept: '세무과', amount: 1000 }, { name: '홍길동', dept: '세무과', org: '강남구청', amount: 2000 }])));
      await waitDialog(doneOrBlocked, from);
      const review = dialogs.slice(from).find(d => d.type === 'confirm' && d.message.includes('받으실 금액'));
      const msg = review ? review.message : '';
      await check(!msg.includes('최근 14일'), `B-14: a deposit that was already undone must not trigger the 14-day warning (got ${JSON.stringify(msg.slice(0, 500))})`);
      await check(msg.includes(`(${md(OLD_AT)} 등록)`), `B-14: the last deposit shown must skip the undone one and fall back to ${md(OLD_AT)} (got ${JSON.stringify(msg.slice(0, 500))})`);
      await check(msg.includes('5,000원 → 6,000원') && msg.includes('6,000원 → 8,000원'), `A-10c: the review must chain the two rows (5,000→6,000→8,000) (got ${JSON.stringify(msg.slice(0, 500))})`);
      const db = await readDb(page);
      const tops = db.transactions.filter(t => t.employeeId === 'b55-e1' && t.type === 'topup' && t.id !== r1TxId).sort((a, b) => a.createdAt - b.createdAt);
      await check(tops.length === 2 && tops[0].beforeBalance === 5000 && tops[0].afterBalance === 6000 && tops[1].beforeBalance === 6000 && tops[1].afterBalance === 8000,
        `A-10c: two rows for one employee must carry a running balance (got ${JSON.stringify(tops.map(t => [t.beforeBalance, t.afterBalance]))})`);
      await check((await page.evaluate(() => window.__prepaidTestHooks.reconcileLedger())).ok === true, 'A-10c: the ledger must reconcile after a two-row roster');
    });

    // B-14: 1분 안에 받은 명단 둘은 되돌리기 창에서 따로 보이고, 이미 되돌린 거래는 다시 빼지 않는다
    await guard('B-14 two batches', async () => {
      await page.waitForTimeout(1200);// 사람 손으로 받는 두 번째 명단은 적어도 몇 초 뒤다
      const from = dialogs.length;
      await openTransfer(await page.evaluate(() => window.__b55mk([{ name: '홍길동', dept: '세무과', amount: 500 }])));
      await waitDialog(doneOrBlocked, from);
      await check(await e1Bal() === 8500, 'B-14 setup: the third roster must top up to 8,500');
      if (await count(page, '.modal-back')) await page.locator('.modal-actions [data-a="close-modal"]').first().click().catch(() => {});
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'enroll-auto');
      await page.locator('[data-a="undo-batch"]').first().click();
      await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="ok"]', { timeout: 5000 });
      const txt = await page.locator('.choice-modal').innerText();
      await check(/명단 2개가 함께/.test(txt) && txt.includes('명단 1:') && txt.includes('명단 2:') && txt.includes('3,000원') && txt.includes('500원'),
        `B-14: rosters merged by the 60-second rule must be listed with their own totals (got ${JSON.stringify(txt.slice(0, 400))})`);
      await page.locator('.choice-modal [data-a="choice-pick"][data-val="ok"]').click();
      for (let i = 0; i < 40 && (await readDb(page)).transactions.filter(t => t.reason === '명단 등록 되돌리기').length < 4; i += 1) await page.waitForTimeout(150);
      const db = await readDb(page);
      await check(db.transactions.filter(t => t.reason === '명단 등록 되돌리기' && t.targetTransactionId === r1TxId).length === 1, 'B-14: an already-undone deposit must never be undone a second time');
      await check(await e1Bal() === 5000, `B-14: undoing the merged group must land exactly on 5,000 (got ${await e1Bal()})`);
    });

    // B-01·B-13: 형식이 틀린 명단은 장부에 닿기 전에 막는다
    await guard('B-01', async () => {
      const empsBefore = (await readDb(page)).employees.length;
      const from = dialogs.length;
      await openTransfer(await page.evaluate(() => window.__b55mk([{ name: '가짜갑', dept: '세무과', amount: 1000000 }, { name: '가짜을', dept: '세무과', amount: -990000 }])));
      const d = await waitDialog(doneOrBlocked, from);
      await check(d && d.message.includes('명단 형식'), `B-01: a roster with a negative amount must be refused as 명단 형식 오류 (got ${JSON.stringify(d && d.message.slice(0, 200))})`);
      await check(!dialogs.slice(from).some(x => x.type === 'confirm' && x.message.includes('받으실 금액')), 'B-01: a malformed roster must not even reach the money confirm');
      await check((await readDb(page)).employees.length === empsBefore, 'B-01: a malformed roster must not add anyone');
    });
    await guard('B-13 bidi', async () => {
      let from = dialogs.length;
      await openTransfer(await page.evaluate(() => window.__b55mk([{ name: '‮⁦', dept: '세무과', amount: 1000 }])));
      let d = await waitDialog(doneOrBlocked, from);
      await check(d && d.message.includes('명단 형식') && d.message.includes('이름이 비어'), `B-13: a name made only of direction marks must be refused (got ${JSON.stringify(d && d.message.slice(0, 200))})`);
      from = dialogs.length;
      await openTransfer(await page.evaluate(() => window.__b55mk([{ name: '‮홍길순', dept: '세무과', amount: 1000 }])));
      d = await waitDialog(doneOrBlocked, from);
      const db = await readDb(page);
      await check(db.employees.some(e => e.name === '홍길순') && !db.employees.some(e => /[‪-‮⁦-⁩]/.test(e.name)), 'B-13: direction marks must be stripped before the name is stored');
    });

    // B-07 + B-10: 이름이 하나도 안 겹치면 진한 버튼은 [새 부서로 따로 등록] — 그 선택창을 띄운 채 두면 10분 상한으로 잠긴다
    await guard('B-07/B-10', async () => {
      await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { modalIdleCap: 2500 }));
      const empsBefore = (await readDb(page)).employees.length;
      await openTransfer(await page.evaluate(() => window.__b55mk([{ name: '김철수', dept: '세무과', amount: 3000 }], { institution: '강북구청' })));
      await page.waitForSelector('.choice-modal', { timeout: 8000 });
      const txt = await page.locator('.choice-modal').innerText();
      await check(txt.includes('이름이 하나도 겹치지 않아요'), `B-07: a dept-name-only match must say no names overlap (got ${JSON.stringify(txt.slice(0, 300))})`);
      const primary = await page.locator('.choice-modal .btn-primary').getAttribute('data-val').catch(() => '');
      await check(primary === 'separate', `B-07: with no overlapping names the primary button must be [새 부서로 따로 등록] (got ${JSON.stringify(primary)})`);
      await page.waitForTimeout(3600);
      const ls = await page.evaluate(() => window.__prepaidTestHooks.lockState());
      await check(ls.locked === true && await count(page, '.choice-modal') === 0, `B-10: an open choice dialog alone must still hit the idle cap and lock (locked=${ls.locked})`);
      await check((await readDb(page)).employees.length === empsBefore, 'B-10: locking must cancel the pending choice (nothing written)');
      await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { modalIdleCap: 600000 }));
      if (ls.locked) { await unlockPin(page); await awaitUnlocked(page); }
      else if (await count(page, '.choice-modal')) await page.locator('.choice-modal [data-a="choice-pick"][data-val="cancel"]').click();
    });
    await guard('B-10 pass', async () => {
      await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { modalIdleCap: 2500 }));
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      // beta.55(A2): 열쇠 백업 버튼은 없어졌다 — 같은 암호 창(passDialog)을 [장부 지키기 > 백업 암호]로 연다.
      await openSettingsCard(page, 'ledger');
      await page.locator('[data-a="backup-pass"]').first().click();
      await page.waitForSelector('#keyPass1', { timeout: 5000 });
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForTimeout(3600);
      const ls = await page.evaluate(() => window.__prepaidTestHooks.lockState());
      await check(ls.locked === true && await count(page, '#keyPass1') === 0, `B-10: an open key-passphrase box alone must still hit the idle cap and lock (locked=${ls.locked})`);
      await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { modalIdleCap: 600000 }));
      if (ls.locked) { await unlockPin(page); await awaitUnlocked(page); }
      else if (await count(page, '#keyPass1')) await page.locator('[data-a="pass-cancel"]').click();
    });

    // A-10h: 같은 이름의 활성 직원이 있어도 복원 길이 있다
    await guard('A-10h', async () => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'employees');
      await openMgrGroup(page, '__hidden__');
      await page.locator('[data-a="restore-emp"][data-id="b55-d1"]').click();
      await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="rename"]', { timeout: 5000 });
      const txt = await page.locator('.choice-modal').innerText();
      await check(txt.includes('같은 이름의 직원이 이미 있어요') && txt.includes('박복원·2'), `A-10h: the restore dead end must explain and offer a renamed restore (got ${JSON.stringify(txt.slice(0, 300))})`);
      await page.locator('.choice-modal [data-a="choice-pick"][data-val="rename"]').click();
      await page.waitForTimeout(400);
      const d1 = (await readDb(page)).employees.find(e => e.id === 'b55-d1');
      await check(d1 && d1.isDeleted === false && d1.name === '박복원·2', `A-10h: the renamed restore must bring the employee back as 박복원·2 (got ${JSON.stringify(d1 && [d1.name, d1.isDeleted])})`);
    });

    const openTopup = async () => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'employees');
      await openMgrGroup(page, '강남구청 세무과');
      await expandEmpRow(page, 'b55-e1');
      await page.locator('[data-a="topup"][data-id="b55-e1"]').first().click();
      await page.waitForSelector('#topupAmount', { timeout: 5000 });
    };
    // A-10d: 1억 원을 넘는 금액은 저장하지 않는다
    await guard('A-10d', async () => {
      const txBefore = (await readDb(page)).transactions.length;
      await openTopup();
      await page.locator('#topupAmount').fill('100000001');
      await page.locator('[data-a="save-topup"]').click();
      await check(await waitToast(page, /1억 원/), `A-10d: an amount above 100,000,000 must be refused with a clear message (toast ${JSON.stringify(await toastText(page))})`);
      await check((await readDb(page)).transactions.length === txBefore, 'A-10d: a refused amount must not be saved');
      if (await count(page, '.modal-back')) await page.locator('.modal-actions [data-a="close-modal"]').first().click().catch(() => {});
    });

    // A-4: 저장이 실패하면 메모리의 꼬리 앵커도 그대로다(오경보 없음) / A-10f: 쓰기는 durability strict
    await guard('A-4/A-10f', async () => {
      await page.evaluate(() => {
        window.__b55dur = [];
        const origTx = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (stores, mode, opts) { if (mode === 'readwrite') window.__b55dur.push(opts && opts.durability || ''); return origTx.apply(this, arguments); };
        window.__b55failOnce = true;
        const origPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () {
          if (window.__b55failOnce && this.name === 'transactions') { window.__b55failOnce = false; try { this.transaction.abort(); } catch (e) { } throw new DOMException('harness forced write failure', 'AbortError'); }
          return origPut.apply(this, arguments);
        };
      });
      const txBefore = (await readDb(page)).transactions.length;
      await openTopup();
      await page.locator('#topupAmount').fill('700');
      await page.locator('[data-a="save-topup"]').click();
      await page.waitForTimeout(600);
      await check((await readDb(page)).transactions.length === txBefore, 'A-4 setup: the injected failure must leave the store unchanged');
      const vc = await page.evaluate(async () => { const c = await window.__prepaidTestHooks.verifyChain(); return { ok: c.tamperOk, broken: (c.broken || []).map(b => b.reason) }; });
      await check(vc.ok === true, `A-4: a failed write must not leave a false "거래 건수 불일치" alarm (got ${JSON.stringify(vc.broken)})`);
      // 실패 뒤 다시 저장하면 정상 저장되고 장부가 맞는다
      if (!(await count(page, '#topupAmount'))) await openTopup();
      await page.locator('#topupAmount').fill('700');
      await page.locator('[data-a="save-topup"]').click();
      for (let i = 0; i < 30 && (await readDb(page)).transactions.length === txBefore; i += 1) await page.waitForTimeout(100);
      const vc2 = await page.evaluate(async () => { const c = await window.__prepaidTestHooks.verifyChain(); return c.tamperOk; });
      await check(vc2 === true && (await readDb(page)).transactions.length === txBefore + 1, 'A-4: the retried save must land and keep the chain sound');
      const dur = await page.evaluate(() => window.__b55dur);
      await check(dur.length > 0 && dur.every(x => x === 'strict'), `A-10f: every readwrite transaction must ask for durability "strict" (got ${JSON.stringify(dur.slice(0, 5))})`);
    });

    // A-10e: CSV 내보내기 수식 주입 방지
    await guard('A-10e', async () => {
      // beta.55(A2): 엑셀(CSV)은 이력 화면의 [엑셀로 내보내기]로 옮겼다(설정의 [장부 안전 저장]은 [장부 지키기]로 합쳐짐).
      await page.locator('[data-a="screen"][data-screen="history"]').click();
      const downloads = [];
      const onDl = d => downloads.push(d);
      page.on('download', onDl);
      await page.locator('.top [data-a="export-csv"]').first().click();
      for (let i = 0; i < 40 && downloads.length < 1; i += 1) await page.waitForTimeout(100);
      page.off('download', onDl);
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      const csvDl = downloads.find(d => /\.csv$/i.test(d.suggestedFilename()));
      const csv = csvDl ? await fsp.readFile(await csvDl.path(), 'utf8') : '';
      await check(csv.includes("'=1+2") && !/(^|,)=1\+2/m.test(csv), `A-10e: a text cell starting with "=" must be exported as '=… (got ${JSON.stringify((csv.match(/.{0,20}=1\+2.{0,5}/) || [''])[0])})`);
      await check(/,8,?000|,7,?400|5,?700|,5700/.test(csv) || /홍길동,\d/.test(csv), 'A-10e: numeric balance cells must stay numeric (no prefix)');
    });

    // B-12·B-15·B-04: 수신함 — 쉬운 말 오류, 깨진 항목 건너뛰기, 시한
    await page.evaluate(() => {
      window.__b55inbox = []; window.__b55inboxStatus = 200; window.__b55chal = 'ok'; window.__b55approveHang = false;
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const s = String(u);
        const json = (body, status) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
        if (s.includes('/api/challenge')) {
          if (window.__b55chal === 'hang') return new Promise(() => {});
          if (window.__b55chal === 'busy') return json({ error: 'too_many_challenges' }, 429);
          const pub = await crypto.subtle.importKey('spki', window.__b55b2u(window.__b55pub).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
          return json({ challenge_ct: window.__b55u2b(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, new TextEncoder().encode('B55TOKEN'))) });
        }
        if (s.includes('/api/inbox?')) return json(window.__b55inboxStatus === 200 ? window.__b55inbox : { error: 'not_found' }, window.__b55inboxStatus);
        if (s.includes('/api/approve')) { if (window.__b55approveHang) return new Promise(() => {}); return json('{"ok":true}'); }
        if (s.includes('/api/ledger-backup')) return json('{"ok":true}');
        return orig(u, o);
      };
    });
    const openInbox = async () => {
      if (await count(page, '.modal-back')) await page.locator('.modal-actions [data-a="close-modal"]').first().click().catch(() => {});
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'enroll-auto');
      await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 }).catch(() => {});
      await page.locator('[data-a="relay-inbox"]').first().click();
    };
    await guard('B-12 challenge', async () => {
      await page.evaluate(() => { window.__b55chal = 'busy'; });
      await openInbox();
      await check(await waitToast(page, /가게 확인 요청이 잠깐 몰렸어요/), `B-12: too_many_challenges must read as plain Korean (toast ${JSON.stringify(await toastText(page))})`);
      await check(!/too_many|오류: [a-z]/.test(await toastText(page)), 'B-12: no raw English error code may reach the screen');
    });
    await guard('B-12 404', async () => {
      await page.evaluate(() => { window.__b55chal = 'ok'; window.__b55inboxStatus = 404; });
      await openInbox();
      await check(await waitToast(page, /우리 가게 등록을 찾지 못했어요/), `B-12: a 404 from the inbox must say the store is not registered on the server (toast ${JSON.stringify(await toastText(page))})`);
    });
    await guard('B-15/B-12 decrypt', async () => {
      await page.evaluate(async () => {
        window.__b55inboxStatus = 200;
        const other = await window.__b55foreignKey('unused-pass-1');
        window.__b55inbox = [null, { summary_id: 5, summary: {} }, { summary_id: 'b55-sid-x', summary: { institution: '강남구청', department: '세무과', total_amount: 1000, member_count: 1, year_month: '2026-11' }, ciphertext: await window.__b55seal([{ name: '홍길동', dept: '세무과', amount: 1000 }], other.pub), status: 'PENDING' }];
      });
      await openInbox();
      await page.waitForSelector('[data-a="relay-approve"]', { timeout: 8000 }).catch(() => {});
      await check(await count(page, '[data-a="relay-approve"]') === 1, `B-15: malformed inbox items must be skipped and the valid one still shown (got ${await count(page, '[data-a="relay-approve"]')} approve buttons)`);
      await check(/형식이 맞지 않는 신청 2건/.test(await toastText(page)), `B-15: skipped items must be counted for the owner (toast ${JSON.stringify(await toastText(page))})`);
      await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 9000 }).catch(() => {});
      if (await count(page, '[data-a="relay-approve"]')) await page.locator('[data-a="relay-approve"]').first().click();
      await check(await waitToast(page, /이 명단은 지금 열쇠로 열 수 없어요/), `B-12: a roster sealed for another key must say so in plain Korean (toast ${JSON.stringify(await toastText(page))})`);
    });
    await guard('B-04 inbox timeout', async () => {
      await page.evaluate(() => { window.__relayTimeoutMs = 1500; window.__b55chal = 'hang'; });
      await openInbox();
      await page.waitForTimeout(2600);
      await check(await count(page, '.busy') === 0, 'B-04: a relay request that never answers must not leave the busy overlay up');
      await check(/서버 응답이 너무 늦어요/.test(await toastText(page)), `B-04: a timeout must be explained in plain Korean (toast ${JSON.stringify(await toastText(page))})`);
    });
    await guard('B-04 approve timeout', async () => {
      await page.evaluate(async () => {
        window.__b55chal = 'ok'; window.__b55approveHang = true;
        window.__b55inbox = [{ summary_id: 'b55-sid-ok', summary: { institution: '강남구청', department: '세무과', total_amount: 4000, member_count: 1, year_month: '2026-11' }, ciphertext: await window.__b55seal([{ name: '홍길동', dept: '세무과', amount: 4000 }]), status: 'PENDING' }];
      });
      const balBefore = await e1Bal();
      await openInbox();
      await page.waitForSelector('[data-a="relay-approve"]', { timeout: 8000 });
      const from = dialogs.length;
      await page.locator('[data-a="relay-approve"]').first().click();
      const d = await waitDialog(x => x.type === 'alert' && x.message.includes('등록 완료'), from, 15000);
      await check(d && d.message.includes('아직 알리지 못했어요'), `B-04: a hanging approve notice must time out into the outbox message (got ${JSON.stringify(d && d.message.slice(0, 200))})`);
      await page.waitForTimeout(300);
      await check(await count(page, '.busy') === 0, 'B-04: the busy overlay must be gone after the approve notice times out');
      const m = await metaOf(page);
      await check(Array.isArray(m.pendingNotify) && m.pendingNotify.some(x => x.sid === 'b55-sid-ok'), 'B-04: the timed-out notice must wait in pendingNotify (outbox semantics unchanged)');
      await check(await e1Bal() === balBefore + 4000, 'B-04: the roster itself must be in the ledger exactly once');
      await page.evaluate(() => { window.__b55approveHang = false; window.__relayTimeoutMs = 0; });
      // txLock가 풀렸는가 — 바로 다음 저장이 된다
      const txBefore = (await readDb(page)).transactions.length;
      if (await count(page, '.modal-back')) await page.locator('.modal-actions [data-a="close-modal"]').first().click().catch(() => {});
      await openTopup();
      await page.locator('#topupAmount').fill('100');
      await page.locator('[data-a="save-topup"]').click();
      for (let i = 0; i < 30 && (await readDb(page)).transactions.length === txBefore; i += 1) await page.waitForTimeout(100);
      await check((await readDb(page)).transactions.length === txBefore + 1, 'B-04: the save lock must be free again after a timed-out approve');
    });

    // B-13: 3,000명 상한
    await guard('B-13 count', async () => {
      const empsBefore = (await readDb(page)).employees.length;
      const from = dialogs.length;
      await openTransfer(await page.evaluate(() => window.__b55mk(Array.from({ length: 3001 }, (_, i) => ({ name: '대량' + i, dept: '세무과', amount: 1 })))));
      const d = await waitDialog(doneOrBlocked, from, 20000);
      await check(d && d.message.includes('명단 형식') && d.message.includes('3,000명'), `B-13: a roster over 3,000 rows must be refused (got ${JSON.stringify(d && d.message.slice(0, 200))})`);
      await check((await readDb(page)).employees.length === empsBefore, 'B-13: an oversized roster must not add anyone');
    });

    // B-05: 열쇠 백업 — 짝 확인 + 다른 열쇠 덮어쓰기 확인
    await guard('B-05', async () => {
      const before = await metaOf(page);
      const pass = 'b55-key-pass-01';
      const foreign = await page.evaluate(p => window.__b55foreignKey(p), pass);
      const restoreKey = async file => {
        await page.locator('#restoreFile').setInputFiles({ name: 'key.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file), 'utf8') });
        await page.waitForSelector('#keyPass1', { timeout: 8000 });
        await page.locator('#keyPass1').fill(pass);
        await page.locator('[data-a="pass-ok"]').click();
      };
      // ① 짝이 안 맞는 파일(공개키는 이 기기 것, 개인키는 남의 것)
      await restoreKey({ type: 'prepaid-key-backup', v: 1, pubKey: before.pubKey, pkBackup: foreign.pkBackup });
      await page.waitForSelector('.choice-modal', { timeout: 15000 }).catch(() => {});
      const t1 = await count(page, '.choice-modal') ? await page.locator('.choice-modal').innerText() : '';
      await check(t1.includes('짝이 맞지 않아요'), `B-05: a key backup whose two halves do not match must be refused (got ${JSON.stringify(t1.slice(0, 200))})`);
      if (await count(page, '.choice-modal')) await page.locator('.choice-modal [data-a="choice-pick"]').first().click();
      await page.waitForTimeout(300);
      const after1 = await metaOf(page);
      await check(after1.privKeyWrapped === before.privKeyWrapped && after1.pubKey === before.pubKey, 'B-05: a mismatched key backup must leave the device key untouched');
      // ② 다른 가게의 정상 열쇠 → 먼저 묻는다. [바꾸지 않기]면 그대로.
      await restoreKey({ type: 'prepaid-key-backup', v: 1, pubKey: foreign.pub, pkBackup: foreign.pkBackup });
      await page.waitForSelector('.choice-modal', { timeout: 15000 }).catch(() => {});
      const t2 = await count(page, '.choice-modal') ? await page.locator('.choice-modal').innerText() : '';
      await check(t2.includes('이미 다른 열쇠가 있어요'), `B-05: importing a different key must ask before overwriting (got ${JSON.stringify(t2.slice(0, 200))})`);
      if (await count(page, '.choice-modal [data-val="keep"]')) await page.locator('.choice-modal [data-a="choice-pick"][data-val="keep"]').click();
      await page.waitForTimeout(400);
      await check((await metaOf(page)).pubKey === before.pubKey, 'B-05: choosing 바꾸지 않기 must keep the current key');
      // ③ [가져온 열쇠로 바꾸기]면 바뀐다
      await restoreKey({ type: 'prepaid-key-backup', v: 1, pubKey: foreign.pub, pkBackup: foreign.pkBackup });
      await page.waitForSelector('.choice-modal [data-val="replace"]', { timeout: 15000 }).catch(() => {});
      if (await count(page, '.choice-modal [data-val="replace"]')) await page.locator('.choice-modal [data-a="choice-pick"][data-val="replace"]').click();
      for (let i = 0; i < 30 && (await metaOf(page)).pubKey !== foreign.pub; i += 1) await page.waitForTimeout(100);
      await check((await metaOf(page)).pubKey === foreign.pub, 'B-05: confirming the replacement must install the imported key');
    });
  } finally {
    await context.close();
  }

  // ───────────────────────── A-3: 한 번에 한 창 ─────────────────────────
  const seedOne = async (page, rid) => {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await seed(page, rid, [emp('w-e1', { org: '강남구청', orgKind: 'public', dept: '세무과', name: '창하나' })],
      [{ id: 'w-t0', employeeId: 'w-e1', type: 'open', amount: 5000, beforeBalance: 0, afterBalance: 5000, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', createdAt: OLD_AT }]);
  };
  const topupIn = async (page, amount) => {
    if (!(await count(page, '#topupAmount'))) {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'employees');
      await openMgrGroup(page, '강남구청 세무과');
      await expandEmpRow(page, 'w-e1');
      await page.locator('[data-a="topup"][data-id="w-e1"]').first().click(); await page.waitForSelector('#topupAmount', { timeout: 5000 });
    }
    await page.locator('#topupAmount').fill(String(amount));
    await page.locator('[data-a="save-topup"]').click();
    await page.waitForTimeout(700);
  };
  await guard('A-3 web locks', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' }));
    try {
      const p1 = await ctx.newPage();
      p1.on('dialog', d => d.accept());
      await seedOne(p1, 'rid-w1');
      await p1.reload({ waitUntil: 'load' });
      await unlockPin(p1);
      await awaitUnlocked(p1);
      await check(await p1.evaluate(() => { const H = window.__prepaidTestHooks; return H.instanceMode ? H.instanceMode() : ''; }) === 'held', 'A-3: the first window must hold the one-window Web Lock');
      const snapBefore = JSON.stringify(await readDb(p1));
      const p2 = await ctx.newPage();
      p2.on('dialog', d => d.accept());
      await p2.goto(url, { waitUntil: 'load' });
      await p2.waitForTimeout(2600);
      const msg = (await p2.locator('#instanceBlockedMsg').count()) ? await p2.locator('#instanceBlockedMsg').innerText() : '';
      await check(msg.includes('다른 창에서 이미 열려 있어요') && msg.includes('그 창을 쓰거나 닫아 주세요'), `A-3: a second window must show the in-app "already open" notice (got ${JSON.stringify(msg)})`);
      await check(await p2.locator('[data-a="pin-key"], .cust-screen, .nav').count() === 0, 'A-3: the second window must not open the ledger UI');
      await check(JSON.stringify(await readDb(p1)) === snapBefore, 'A-3: the blocked second window must not write anything');
      await topupIn(p1, 1000);
      const db1 = await readDb(p1);
      await check(db1.transactions.length === 2 && db1.transactions.some(t => t.type === 'topup' && t.afterBalance === 6000), 'A-3: the first window must keep working normally');
      await check(await p2.locator('#instanceBlockedMsg').count() === 1, 'A-3: the second window stays blocked while the first is open');
      await p1.close();
      await p2.waitForSelector('[data-a="pin-key"], .cust-screen', { timeout: 8000 }).catch(() => {});
      await check(await p2.locator('#instanceBlockedMsg').count() === 0 && await p2.locator('[data-a="pin-key"], .cust-screen').count() > 0, 'A-3: closing the first window must let the waiting window open the ledger by itself');
    } finally { await ctx.close(); }
  });
  await guard('A-3 fallback', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { try { Object.defineProperty(Navigator.prototype, 'locks', { get() { return undefined; }, configurable: true }); } catch (e) { } });
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' }));
    try {
      const p1 = await ctx.newPage();
      p1.on('dialog', d => d.accept());
      await seedOne(p1, 'rid-w2');
      await p1.reload({ waitUntil: 'load' });
      await unlockPin(p1);
      await awaitUnlocked(p1);
      const p2 = await ctx.newPage();
      p2.on('dialog', d => d.accept());
      await p2.goto(url, { waitUntil: 'load' });
      await unlockPin(p2);
      await awaitUnlocked(p2);
      await check(await p2.evaluate(() => { const H = window.__prepaidTestHooks; return !navigator.locks && (H.instanceMode ? H.instanceMode() : '') === 'unsupported'; }), 'A-3 fallback setup: Web Locks must be hidden and the app must know it');
      await topupIn(p1, 1000);
      // p2는 아직 5,000원이라고 믿고 있다 → 저장 직전 대조에서 멈추고 새로 읽어야 한다
      await topupIn(p2, 1000);
      let db = await readDb(p2);
      const tops = () => db.transactions.filter(t => t.type === 'topup').sort((a, b) => a.createdAt - b.createdAt);
      await check(tops().length === 1, `A-3 fallback: a stale second window must not write on top of the first (got ${tops().length} top-ups: ${JSON.stringify(tops().map(t => [t.beforeBalance, t.afterBalance]))})`);
      await check(/다른 창에서 장부가 바뀌어/.test((await p2.locator('.toast').count()) ? await p2.locator('.toast').innerText() : ''), 'A-3 fallback: the stale window must tell the owner it re-read the ledger');
      await topupIn(p2, 1000);
      db = await readDb(p2);
      await check(tops().length === 2 && tops()[1].beforeBalance === 6000 && tops()[1].afterBalance === 7000, `A-3 fallback: the retried save must use the fresh balance (got ${JSON.stringify(tops().map(t => [t.beforeBalance, t.afterBalance]))})`);
      await check((await p2.evaluate(() => window.__prepaidTestHooks.reconcileLedger())).ok === true, 'A-3 fallback: the ledger must reconcile after two windows');
    } finally { await ctx.close(); }
  });

  // ───────────────────────── A-7: 서비스워커 HTML 시한 ─────────────────────────
  await guard('A-7', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' }));
    try {
      const p = await ctx.newPage();
      await p.goto(url, { waitUntil: 'load' });
      await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await p.reload({ waitUntil: 'load' });
      await p.waitForFunction(async () => !!navigator.serviceWorker.controller && !!(await caches.match('./index.html')), null, { timeout: 15000, polling: 200 });
      serverCtl.hangHtml = true;
      const t0 = Date.now();
      let ok = true;
      try { await p.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }); } catch (e) { ok = false; }
      const took = Date.now() - t0;
      await check(ok && took < 9000, `A-7: with the network hanging, the cached app must appear after the ~3.5s limit (took ${took}ms, loaded=${ok})`);
      if (ok) await check(await p.locator('#app').count() === 1, 'A-7: the cached shell must be the app page');
    } finally {
      serverCtl.hangHtml = false;
      serverCtl.held.splice(0).forEach(res => { try { res.writeHead(503); res.end(); } catch (e) { } });
      await ctx.close();
    }
  });

  console.log(`beta.55 A1a 검증: ${passed} 통과, ${fails.length} 실패`);
  if (fails.length) console.log(JSON.stringify(fails, null, 2));
  return { passed, fails };
}

// ── beta.55 A1b: 음식점 앱 화면(키보드·태블릿·입력 보존·두 번 탭·증표·대기 60초·빠른 금액·약관·음성 제거·앱 안 입력창·문자 링크) ──
//   각 단언은 수정 전 코드(beta.55 A1a까지)에서 실패함을 확인했다(E2E_ONLY=beta55b E2E_SOFT=1로 단언별 실패 목록을 본다).
async function runBeta55b(browser, url, cors) {
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.55 A1b] ' + msg);
  };
  const guard = async (label, fn) => {
    try { await fn(); } catch (err) { if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 240)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 240)}`); }
  };
  const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
  const DAY = 86400000;
  const T0 = Date.now() - 40 * DAY;
  const emp = (id, o) => Object.assign({ id, org: '광진구청', orgKind: 'public', dept: '세무과', name: id, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: T0, updatedAt: T0 }, o);
  const tx = (id, employeeId, type, amount, k, extra) => Object.assign({ id, employeeId, type, amount, beforeBalance: 0, afterBalance: 0, reason: type === 'use' ? '서명 확인' : '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', createdAt: T0 + k * 1000 }, extra || {});
  const seed = async (page, employees, transactions, metaExtra) => {
    await page.evaluate(({ hash, t, employees, transactions, metaExtra }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const x = db.transaction(['meta', 'employees', 'transactions'], 'readwrite');
        const ms = x.objectStore('meta');
        const base = { setupComplete: true, welcomeSeen: true, termsAgreedAt: t, pinHash: hash, shopName: '화면식당', departments: ['세무과'], storeRegisterPending: false };
        Object.entries(Object.assign(base, metaExtra || {})).forEach(([k, v]) => { if (v === undefined) ms.delete(k); else ms.put({ key: k, value: v }); });
        employees.forEach(e => x.objectStore('employees').put(e));
        transactions.forEach(v => x.objectStore('transactions').put(v));
        x.oncomplete = () => resolve(true);
        x.onerror = () => reject(x.error);
      };
    }), { hash: legacyPin, t: Date.now(), employees, transactions, metaExtra: metaExtra || null });
    if (transactions.length) await resealChain(page);
  };
  const lockSt = page => page.evaluate(() => window.__prepaidTestHooks.lockState());
  const awaitUnlockedB = page => page.waitForFunction(() => window.__prepaidTestHooks.lockState().locked === false, null, { timeout: 15000 });
  const setTimers = (page, v) => page.evaluate(o => Object.assign(window.__prepaidTestHooks.TIMERS, o), v);
  const draw = async (page, sel) => {
    const b = await page.locator(sel).boundingBox();
    await page.mouse.move(b.x + 30, b.y + b.height * 0.6); await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.45, b.y + b.height * 0.3, { steps: 6 });
    await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.7, { steps: 6 }); await page.mouse.up();
  };
  const activeInfo = page => page.evaluate(() => { const a = document.activeElement; return { tag: a ? a.tagName : '', id: a ? a.id : '', act: a && a.dataset ? (a.dataset.a || '') : '' }; });
  const newPage = async (opts) => {
    const ctx = await browser.newContext(Object.assign({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' }, opts || {}));
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' }));
    await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
    const page = await ctx.newPage();
    const dialogs = [];
    const problems = [];
    const pa = { v: '' };// 수정 전 코드의 기본 팝업에 줄 답(수정 후에는 팝업이 없어야 한다 — 단언이 센다)
    page.on('dialog', async d => { dialogs.push({ type: d.type(), message: d.message() }); if (d.type() === 'prompt') await d.accept(pa.v); else await d.accept(); });
    page.on('pageerror', err => problems.push(err.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    return { ctx, page, dialogs, problems, pa };
  };
  // 손님 화면에서 이름 → 본인 확인 → 금액(빠른 금액 or 직접) → 서명 → [사장님 확인 받기]
  const composeAndSubmit = async (page, name, amount) => {
    await page.waitForSelector('#custSearchInput');
    await page.locator('#custSearchInput').fill(name);
    await page.waitForSelector('[data-a="cust-confirm"]');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('.cust-sig #signCanvas');
    await page.locator('#custAmountInput').fill(String(amount));
    await draw(page, '.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
  };

  // ═════ ① 손님 요청 → 사장님 확인: 키보드·두 번 탭·대기 60초·Enter 저장·증표 닫기 → 손님 화면 ═════
  //   하위 단언마다 guard로 나눈다 — 수정 전 코드에서도 한 단언이 무너진 뒤 다음 단언까지 실제로 돌아 "단언별로 실패"를 보인다.
  {
    const { ctx, page, dialogs, problems } = await newPage();
    const closeReceipt = async () => { const b = page.locator('.receipt-modal [data-a="receipt-close"], .receipt-modal [data-a="close-modal"]').first(); if (await b.count()) await b.click(); await page.waitForTimeout(200); };
    const toHome = async () => { if ((await lockSt(page)).locked) { await unlockPin(page); await awaitUnlockedB(page); } if (!(await page.locator('[data-a="quick-find-emp"]').count())) await page.locator('[data-a="screen"][data-screen="home"]').click(); await page.waitForSelector('[data-a="quick-find-emp"]'); };
    try {
      await seed(page, [emp('h-1', { name: '김요청' }), emp('h-2', { name: '이직접' })],
        [tx('h-t1', 'h-1', 'open', 50000, 1), tx('h-t2', 'h-2', 'open', 50000, 2)]);
      await page.reload({ waitUntil: 'load' });
      await guard('C8 timers', async () => {
        const timers = await page.evaluate(() => Object.assign({}, window.__prepaidTestHooks.TIMERS));
        await check(timers.handoffPinIdle === 60000, `C8: TIMERS.handoffPinIdle must be 60000 in production (got ${timers.handoffPinIdle})`);
        await check(timers.custIdle === 30000 && timers.ownerPinIdle === 120000, 'C8: the other idle clocks stay 30s (customer screen) / 120s (owner PIN)');
      });
      await composeAndSubmit(page, '김요청', 9000);
      await guard('C3 double tap', async () => {
        // 손님이 [사장님 확인 받기]를 두 번 누른 것처럼 — 숫자판이 뜨자마자 같은 자리를 한 번 더 누른다.
        await page.locator('[data-a="pin-key"][data-key="5"]').click();
        const afterDouble = await lockSt(page);
        await check(afterDouble.pinLen === 0 && afterDouble.pinFails === 0, `C3: a tap within 0.5s of the handoff PIN screen must not type a digit (pinLen ${afterDouble.pinLen}, fails ${afterDouble.pinFails})`);
        const pinActive = await activeInfo(page);
        await check(pinActive.tag !== 'INPUT' && pinActive.tag !== 'TEXTAREA', `C9: nothing on the 사장님 확인 screen may hold an input focus (got ${pinActive.tag}#${pinActive.id})`);
      });
      await guard('C8 countdown', async () => {
        const leftTxt = await page.locator('.pin-ho-left').innerText({ timeout: 1500 }).catch(() => '');
        const leftN = Number((leftTxt.match(/(\d+)\s*초/) || [])[1]);
        await check(leftN >= 55 && leftN <= 60, `C8: the 사장님 확인 screen must show the seconds left (~60) (got ${JSON.stringify(leftTxt)})`);
        await page.evaluate(() => { const el = document.querySelector('#handoffLeft'); if (el) el.__probe = 'same'; const pad = document.querySelector('.pin-pad'); if (pad) pad.__probe = 'same'; });
        await page.waitForTimeout(2300);
        const tick = await page.evaluate(() => { const el = document.querySelector('#handoffLeft'); const pad = document.querySelector('.pin-pad'); return { same: !!el && el.__probe === 'same', padSame: !!pad && pad.__probe === 'same', n: el ? Number(el.textContent) : -1 }; });
        await check(tick.same && tick.padSame && tick.n > 0 && tick.n < leftN, `C8: the countdown must tick down in place without re-rendering the screen (same=${tick.same}, pad=${tick.padSame}, ${leftN}→${tick.n})`);
      });
      // (수정 전 코드에서는 두 번째 탭이 한 자리를 남긴다 — 지우고 진행한다)
      await page.locator('[data-a="pin-key"][data-key="clear"]').click();
      await typePin(page, ['1', '2', '3', '4']);
      await page.waitForSelector('#useAmount', { timeout: 15000 });
      await page.waitForTimeout(150);
      await guard('C9 focus', async () => {
        const modalActive = await activeInfo(page);
        await check(modalActive.tag !== 'INPUT' && modalActive.tag !== 'TEXTAREA', `C9/§1-10: the usage modal opened from a customer request must not focus an input (got ${modalActive.tag}#${modalActive.id})`);
        await check(modalActive.act === 'save-use', `C9/§1-10: the first focus must sit on [저장] (got ${modalActive.tag} data-a=${modalActive.act})`);
        await check((await page.locator('#useAmount').inputValue()) === '9000', 'C9: the requested amount stays in the field');
      });
      await guard('C9 Enter', async () => {
        // Enter → 초점이 있는 [저장] = 평소 저장 경로(손님 금액 그대로, 확인창 없음)
        const confirmsBefore = dialogs.filter(d => d.type === 'confirm').length;
        await page.keyboard.press('Enter');
        const saved = await page.waitForSelector('.receipt-modal', { timeout: 6000 }).then(() => true, () => false);
        const used = (await readDb(page)).transactions.filter(t => t.employeeId === 'h-1' && t.type === 'use');
        await check(saved && used.length === 1 && used[0].amount === 9000 && String(used[0].note).includes('손님 요청 금액 9,000원'), `C9: Enter on [저장] must save exactly the customer's amount through the normal path (got ${JSON.stringify(used.map(u => [u.amount, u.note]))})`);
        await check(dialogs.filter(d => d.type === 'confirm').length === confirmsBefore, 'C9: saving the unchanged request still needs no extra confirm (beta.43)');
        if (!saved) { await page.locator('[data-a="save-use"]').click(); await page.waitForSelector('.receipt-modal', { timeout: 10000 }); }
      });
      await guard('C6 receipt → customer', async () => {
        const closeBtn = page.locator('.receipt-modal [data-a="receipt-close"]');
        await check(await closeBtn.count() === 1 && (await closeBtn.innerText()).includes('손님 화면'), 'C6: the receipt after a customer request must say it closes to the customer screen');
        const rcptActive = await activeInfo(page);
        await check(rcptActive.tag !== 'INPUT' && rcptActive.tag !== 'TEXTAREA', `C9: the receipt must not focus an input (got ${rcptActive.tag})`);
        await closeReceipt();
        const st = await lockSt(page);
        await check(st.locked === true && st.lockView === 'customer' && await page.locator('.cust-screen #custSearchInput').count() === 1, 'C6/§1-9: closing that receipt must land on the locked customer screen, not the owner home');
        await check(await page.locator('.app .card.employee, [data-a="quick-find-emp"]').count() === 0, 'C6: no owner home (all balances) may remain visible');
      });
      // 사장님이 직접 연 사용 등록 — 예전처럼 금액 칸이 첫 초점, 증표를 닫으면 홈
      await toHome();
      await expandHomeGroups(page);
      await page.locator('[data-a="use"][data-id="h-2"]').click();
      await page.waitForSelector('#useAmount');
      await page.waitForTimeout(150);
      await guard('C9 owner focus', async () => {
        const ownerActive = await activeInfo(page);
        await check(ownerActive.tag === 'INPUT' && ownerActive.id === 'useAmount', `C9: an owner-opened usage modal keeps the amount field as first focus (got ${ownerActive.tag}#${ownerActive.id})`);
      });
      await page.locator('#useAmount').fill('3000');
      await draw(page, '#signCanvas');
      await page.locator('[data-a="save-use"]').click();
      await page.waitForSelector('.receipt-modal', { timeout: 10000 });
      await guard('C6 owner receipt', async () => {
        const ownBtn = page.locator('.receipt-modal [data-a="receipt-close"]');
        await check(await ownBtn.count() === 1 && (await ownBtn.innerText()).trim() === '닫기', 'C6: an owner-initiated receipt keeps the plain [닫기]');
        await closeReceipt();
        await check((await lockSt(page)).locked === false && await page.locator('[data-a="quick-find-emp"]').count() === 1, 'C6: closing an owner-initiated receipt returns to the owner home as before');
      });
      await toHome();
      await guard('C8 scaled idle', async () => {
        // 사장님 확인 화면은 손님 조회 화면(custIdle)보다 오래 버티고(축척: custIdle 400 / handoffPinIdle 1800), 결국 손님 화면으로 돌아간다.
        await page.locator('[data-a="hand-to-customer"]').click();
        await setTimers(page, { custIdle: 400, handoffPinIdle: 1800 });
        await composeAndSubmit(page, '김요청', 1000);
        await page.waitForTimeout(1000);
        await check(await page.locator('.pin-screen [data-a="pin-key"]').count() > 0, 'C8: the 사장님 확인 screen must not fall back at the old 30s (custIdle) mark');
        await page.waitForTimeout(1600);
        await check(await page.locator('.cust-screen #custSearchInput').count() === 1 && (await lockSt(page)).pendingCustomerId === '', 'C8: after handoffPinIdle the 사장님 확인 screen returns to the clean customer screen');
        await setTimers(page, { custIdle: 30000, handoffPinIdle: 60000 });
      });
      await check(problems.length === 0, `handoff: no page errors (${JSON.stringify(problems.slice(0, 3))})`);
    } catch (err) { if (!soft) throw err; fails.push('handoff: ' + String(err && err.message || err).slice(0, 240)); console.log('  ✗ handoff: ' + String(err && err.message || err).slice(0, 240)); }
    finally { await ctx.close(); }
  }

  // ═════ ② 빠른 금액 = 이 가게에서 자주 쓴 사용 금액 3개(C7) ═════
  await guard('quick amounts', async () => {
    const { ctx, page } = await newPage();
    try {
      const txs = [tx('q-o1', 'q-1', 'open', 200000, 1), tx('q-o2', 'q-2', 'open', 9500, 2)];
      let k = 10;
      const use = (amt, voidIt) => { const id = 'q-u' + k; txs.push(tx(id, 'q-1', 'use', amt, k++)); if (voidIt) txs.push(tx('q-v' + k, 'q-1', 'void', amt, k++, { targetTransactionId: id, reason: '잘못 누름' })); };
      [5000, 5000, 5000, 5000, 5000].forEach(a => use(a, true));   // 취소된 사용은 세지 않는다(그대로 세면 1위다)
      [6500, 6500].forEach(a => use(a));                            // 2번(가장 오래됨)
      [7000, 7000].forEach(a => use(a));                            // 2번
      [8000, 8000, 8000].forEach(a => use(a));                      // 3번 → 1위
      [12000, 12000].forEach(a => use(a));                          // 2번(가장 최근) → 같은 횟수 중 최근이 이긴다
      await seed(page, [emp('q-1', { name: '김자주' }), emp('q-2', { name: '박적음' })], txs);
      await page.reload({ waitUntil: 'load' });
      const quickOf = async name => {
        await page.waitForSelector('#custSearchInput');
        await page.locator('#custSearchInput').fill(name);
        await page.waitForSelector('[data-a="cust-confirm"]');
        await page.locator('[data-a="cust-confirm"]').click();
        await page.waitForSelector('.cust-req-quick');
        const r = await page.evaluate(() => ({ btns: [...document.querySelectorAll('.cust-req-quick [data-a="cust-amt-quick"]')].map(b => Number(b.dataset.amount)), cells: document.querySelector('.cust-req-quick').children.length }));
        await page.locator('[data-a="cust-back"]').click();
        return r;
      };
      const a = await quickOf('김자주');
      await check(JSON.stringify(a.btns) === JSON.stringify([7000, 8000, 12000]), `C7: quick amounts must be the 3 most frequent non-voided uses (ties → more recent), ascending (got ${JSON.stringify(a.btns)})`);
      const b = await quickOf('박적음');
      await check(JSON.stringify(b.btns) === JSON.stringify([7000, 8000]) && b.cells === 3, `C7: a quick button above the balance (9,500원) must be hidden while its slot stays (got ${JSON.stringify(b)})`);
    } finally { await ctx.close(); }
    const fresh = await newPage();
    try {
      await seed(fresh.page, [emp('f-1', { name: '최처음' })], [tx('f-o', 'f-1', 'open', 100000, 1), tx('f-u', 'f-1', 'use', 10000, 2)]);
      await fresh.page.reload({ waitUntil: 'load' });
      await fresh.page.locator('#custSearchInput').fill('최처음');
      await fresh.page.waitForSelector('[data-a="cust-confirm"]');
      await fresh.page.locator('[data-a="cust-confirm"]').click();
      await fresh.page.waitForSelector('.cust-req-quick');
      const got = await fresh.page.evaluate(() => [...document.querySelectorAll('.cust-req-quick [data-a="cust-amt-quick"]')].map(b => Number(b.dataset.amount)));
      await check(JSON.stringify(got) === JSON.stringify([9000, 10000, 18000]), `C7: with fewer than 3 distinct amounts the slots are filled from 9,000/18,000/27,000 (got ${JSON.stringify(got)})`);
    } finally { await fresh.ctx.close(); }
  });

  // ═════ ③ 설정 칸 입력 보존(C1) · 음성 검색 제거(C11) · 앱 안 입력창(C12) · 문자 링크(B-09) · 글자·표적(C13) ═════
  {
    const { ctx, page, dialogs, problems, pa } = await newPage();
    const goScreen = async name => { if ((await lockSt(page)).locked) { await unlockPin(page); await awaitUnlockedB(page); } await page.locator(`[data-a="screen"][data-screen="${name}"]`).click(); await page.waitForTimeout(150); };
    const closeText = async () => { if (await page.locator('.text-modal [data-a="text-cancel"]').count()) await page.locator('.text-modal [data-a="text-cancel"]').click(); await page.waitForTimeout(100); };
    const openEmpRow = async () => {
      await openSettingsCard(page, 'employees');
      const head = page.locator('.mgr-head[data-dept]').first(); await head.waitFor({ timeout: 8000 });
      if ((await head.locator('.mgr-toggle').innerText()).includes('▶')) { await head.click(); await page.waitForTimeout(150); }
      await expandEmpRow(page, 's-1');
    };
    try {
      await seed(page, [emp('s-1', { name: '정전화' })], [tx('s-o', 's-1', 'open', 40000, 1), tx('s-u', 's-1', 'use', 6000, 2)]);
      await page.reload({ waitUntil: 'load' });
      await unlockPin(page);
      await page.waitForSelector('[data-a="quick-find-emp"]');
      await guard('C11', async () => {
        await check(await page.locator('[data-a="voice-search"]').count() === 0, 'C11: the microphone search button must be gone from home');
        await check(!(await page.evaluate(() => window.__prepaidTestHooks.clickActionKeys())).includes('voice-search'), 'C11: the voice-search action must be gone');
        await check(!/SpeechRecognition/.test(await page.evaluate(() => document.documentElement.innerHTML)), 'C11: no SpeechRecognition code may remain');
      });
      await guard('C13 home', async () => {
        const homeSizes = await page.evaluate(() => ({ meta: parseFloat(getComputedStyle(document.querySelector('.group-meta')).fontSize), arrow: parseFloat(getComputedStyle(document.querySelector('.group-toggle')).fontSize),
          tool: [...document.querySelectorAll('.tool button')].map(b => Math.round(b.getBoundingClientRect().height)) }));
        await check(homeSizes.meta >= 14 && homeSizes.arrow >= 14, `C13: home group "직원 N명" and its arrow must be ≥14px (got ${homeSizes.meta}/${homeSizes.arrow})`);
        await check(homeSizes.tool.length > 0 && homeSizes.tool.every(h => h >= 44), `C13: top-bar buttons must be ≥44px tall (got ${JSON.stringify(homeSizes.tool)})`);
      });
      await goScreen('history');
      await guard('C13 history', async () => {
        await page.waitForSelector('[data-a="history-tab"]');
        const tabsH = await page.evaluate(() => [...document.querySelectorAll('[data-a="history-tab"]')].map(b => Math.round(b.getBoundingClientRect().height)));
        await check(tabsH.every(h => h >= 44), `C13: history tabs must be ≥44px (got ${JSON.stringify(tabsH)})`);
      });
      const promptsBefore = dialogs.filter(d => d.type === 'prompt').length;
      await guard('C12 void', async () => {
        // 사용 취소 사유 — 기본 팝업 없이, 대상 기록이 보이고, 빈 사유는 창 안에서 거절
        pa.v = '';
        await page.locator('[data-a="void"]').first().click();
        const opened = await page.waitForSelector('.text-modal #textDlgInput', { timeout: 3000 }).then(() => true, () => false);
        await check(opened && dialogs.filter(d => d.type === 'prompt').length === promptsBefore, 'C12: voiding must open the in-app dialog, not window.prompt');
        if (!opened) return;
        const vtxt = await page.locator('.text-modal').innerText();
        await check(vtxt.includes('정전화') && vtxt.includes('6,000원'), `C12: the void dialog must name the record being voided (got ${JSON.stringify(vtxt.slice(0, 200))})`);
        await check((await activeInfo(page)).id === 'textDlgInput', 'C12: the reason field gets focus when the dialog opens');
        await page.locator('.text-modal [data-a="text-ok"]').click();
        await page.waitForTimeout(150);
        await check(await page.locator('.text-modal').count() === 1 && (await page.locator('#textDlgErr').innerText()).includes('사유'), 'C12: an empty reason is refused inside the dialog (the dialog stays, the reason stays visible)');
        await page.locator('.text-modal [data-a="text-chip"]').first().click();
        await page.locator('.text-modal [data-a="text-ok"]').click();
        for (let i = 0; i < 30 && !(await readDb(page)).transactions.some(t => t.type === 'void'); i += 1) await page.waitForTimeout(150);
        const vt = (await readDb(page)).transactions.find(t => t.type === 'void');
        await check(vt && vt.reason === '잘못 눌렀어요' && vt.targetTransactionId === 's-u', `C12: confirming must save the void with the picked reason (got ${JSON.stringify(vt && [vt.reason, vt.targetTransactionId])})`);
      });
      await closeText();
      await goScreen('settings');
      await guard('C12 phone', async () => {
        await openEmpRow();
        pa.v = '';
        const pBefore = dialogs.filter(d => d.type === 'prompt').length;
        await page.locator('[data-a="emp-phone-edit"][data-id="s-1"]').click();
        const opened = await page.waitForSelector('.text-modal #textDlgInput', { timeout: 3000 }).then(() => true, () => false);
        await check(opened && dialogs.filter(d => d.type === 'prompt').length === pBefore, 'C12: the phone edit must open the in-app dialog, not window.prompt');
        if (!opened) return;
        await check((await page.locator('.text-modal').innerText()).includes('정전화'), 'C12: the phone dialog must say whose number it is');
        await page.locator('#textDlgInput').fill('12345');
        await page.locator('.text-modal [data-a="text-ok"]').click();
        await page.waitForTimeout(150);
        await check(await page.locator('.text-modal').count() === 1 && (await page.locator('#textDlgErr').innerText()).includes('010'), 'C12: a malformed phone number is refused inside the dialog');
        await page.locator('#textDlgInput').fill('010-2222-3333');
        await page.keyboard.press('Enter');
        for (let i = 0; i < 30 && !((await readDb(page)).employees.find(e => e.id === 's-1') || {}).phone; i += 1) await page.waitForTimeout(150);
        const pe = (await readDb(page)).employees.find(e => e.id === 's-1');
        await check(pe && pe.phone && pe.phoneConsent === true && !/0102222/.test(JSON.stringify(pe)), 'C12: a valid number is stored (encrypted) through the in-app dialog');
      });
      await closeText();
      // 수정 전 코드(기본 팝업)에서도 아래 문자 링크 단언까지 가도록, 전화가 아직 없으면 옛 팝업 경로로 넣어 둔다.
      if (!((await readDb(page)).employees.find(e => e.id === 's-1') || {}).phone) {
        pa.v = '01022223333';
        await openEmpRow().catch(() => {});
        await page.locator('[data-a="emp-phone-edit"][data-id="s-1"]').click().catch(() => {});
        await page.waitForTimeout(400); pa.v = '';
      }
      await guard('C12 org', async () => {
        await openSettingsCard(page, 'depts');
        const pBefore = dialogs.filter(d => d.type === 'prompt').length;
        pa.v = '';
        await page.locator('[data-a="edit-org"]').click();
        const opened = await page.waitForSelector('.text-modal #textDlgInput', { timeout: 3000 }).then(() => true, () => false);
        await check(opened && dialogs.filter(d => d.type === 'prompt').length === pBefore, 'C12: the org name must be entered in the in-app dialog, not window.prompt');
        if (!opened) return;
        await page.locator('#textDlgInput').fill('화면구청');
        await page.locator('.text-modal [data-a="text-ok"]').click();
        await page.waitForTimeout(250);
        await check((await readDb(page)).meta.some(m => m.key === 'orgName' && m.value === '화면구청'), 'C12: the org name is saved through the in-app dialog');
        // 창이 열린 채 방치 → 상한에서 잠기고 창은 취소로 닫힌다(저장 없음)
        await setTimers(page, { modalIdleCap: 900 });
        await page.locator('[data-a="edit-org"]').click();
        await page.waitForSelector('.text-modal');
        await page.waitForTimeout(1800);
        await check((await lockSt(page)).locked === true && await page.locator('.text-modal').count() === 0, 'C12: an abandoned text dialog must be cancelled by the auto-lock cap');
      });
      await setTimers(page, { modalIdleCap: 600000 });
      await closeText();
      await goScreen('home');
      await page.waitForSelector('[data-a="quick-find-emp"]');
      await guard('B-09 owner path', async () => {
        // 사장님이 직접 넣은 금액(확인창 있음)은 자동 열기를 하지 않고, 증표에 진짜 링크를 둔다
        await page.evaluate(() => { window.__lastSmsHref = ''; });
        await expandHomeGroups(page);
        await page.locator('[data-a="use"][data-id="s-1"]').click();
        await page.waitForSelector('#useAmount');
        await page.locator('#useAmount').fill('2000');
        await draw(page, '#signCanvas');
        await page.locator('[data-a="save-use"]').click();
        await page.waitForSelector('.receipt-modal', { timeout: 10000 });
        await check(await page.evaluate(() => window.__lastSmsHref || '') === '', 'B-09: after a confirm dialog the app must not try to auto-open the SMS app (it silently fails)');
        const link = await page.evaluate(() => { const a = document.querySelector('.receipt-modal a[href^="sms:"]'); return a ? { href: a.getAttribute('href'), text: a.innerText.trim() } : null; });
        await check(link && link.href.startsWith('sms:01022223333?body=') && decodeURIComponent(link.href.split('body=')[1]).includes('2,000원'), `B-09: the receipt must carry a real sms: link with the body (got ${JSON.stringify(link)})`);
        await check(link && link.text.includes('문자'), 'B-09: the link reads as a 문자 안내 button');
      });
      { const b = page.locator('.receipt-modal [data-a="receipt-close"], .receipt-modal [data-a="close-modal"]').first(); if (await b.count()) await b.click(); await page.waitForTimeout(150); }
      await guard('B-09 request path', async () => {
        // 손님 요청 그대로 저장(확인창 없음)은 예전처럼 자동 열기를 시도한다
        await page.locator('[data-a="hand-to-customer"]').click();
        await composeAndSubmit(page, '정전화', 1000);
        await typePin(page, ['1', '2', '3', '4']);
        await page.waitForSelector('#useAmount', { timeout: 15000 });
        await page.locator('[data-a="save-use"]').click();
        await page.waitForSelector('.receipt-modal', { timeout: 10000 });
        await check((await page.evaluate(() => window.__lastSmsHref || '')).startsWith('sms:0102222'), 'B-09: the no-confirm path (unchanged customer request) still auto-opens the SMS app');
        { const b = page.locator('.receipt-modal [data-a="receipt-close"], .receipt-modal [data-a="close-modal"]').first(); if (await b.count()) await b.click(); await page.waitForTimeout(150); }
        if (!(await lockSt(page)).locked) await page.locator('[data-a="hand-to-customer"]').click();
        await page.waitForSelector('.cust-screen');
        const foot = await page.evaluate(() => { const b = document.querySelector('.cust-foot button'); const r = b.getBoundingClientRect(); return { h: r.height, f: parseFloat(getComputedStyle(b).fontSize) }; });
        await check(foot.h >= 44 && foot.f >= 14, `C13: [사장님용 잠금 해제] must be a ≥44px target with ≥14px text (got ${Math.round(foot.h)}px/${foot.f}px)`);
      });
      await goScreen('settings');
      await openSettingsCard(page, 'enroll-manual');
      await guard('C13 settings', async () => {
        const kick = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.fold-head .section-kicker')).fontSize));
        await check(kick >= 14, `C13: settings card summaries must be ≥14px (got ${kick}px)`);
      });
      await guard('C1 quick add', async () => {
        // 설정 칸에 적어 둔 글자는 토스트·오프라인/온라인 render에도 남는다
        await page.locator('#quickAddOrg').fill('보존구청');
        await page.locator('#quickAddDept').fill('보존과');
        await page.locator('#quickAddOpen').fill('7000');
        await page.locator('[data-a="quick-add-employee"]').click();   // 이름이 없어 토스트만 뜬다(초점은 버튼)
        await page.waitForTimeout(3400);                                // 토스트가 사라질 때의 render까지
        await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await page.waitForTimeout(200);
        await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.waitForTimeout(200);
        const kept = await page.evaluate(() => ['quickAddOrg', 'quickAddDept', 'quickAddOpen'].map(id => (document.getElementById(id) || {}).value));
        await check(JSON.stringify(kept) === JSON.stringify(['보존구청', '보존과', '7000']), `C1: quick-add fields must survive a toast and an offline/online render (got ${JSON.stringify(kept)})`);
        // 칸을 짚고 치는 중에는 노드 자체가 그대로다(키보드가 닫히지 않는다)
        await page.locator('#quickAddName').fill('보존이');
        await page.evaluate(() => { document.getElementById('quickAddName').__probe = 'same'; });
        await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
        await page.waitForTimeout(200);
        await check(await page.evaluate(() => { const el = document.getElementById('quickAddName'); return !!el && el.__probe === 'same' && document.activeElement === el; }), 'C1: while typing, the focused field node must survive (no full render)');
        await page.locator('#quickAddOrg').fill('보존구청'); await page.locator('#quickAddDept').fill('보존과'); await page.locator('#quickAddOpen').fill('7000');
        await page.locator('[data-a="quick-add-employee"]').click();
        for (let i = 0; i < 30 && !(await readDb(page)).employees.some(e => e.name === '보존이'); i += 1) await page.waitForTimeout(150);
        await page.waitForTimeout(200);
        const added = (await readDb(page)).employees.find(e => e.name === '보존이');
        await check(added && added.org === '보존구청' && added.dept === '보존과', 'C1: the kept values are the ones saved');
        const cleared = await page.evaluate(() => ['quickAddOrg', 'quickAddDept', 'quickAddName', 'quickAddOpen'].map(id => (document.getElementById(id) || {}).value));
        await check(cleared.every(v => v === ''), `C1: after a successful add the fields are empty again (got ${JSON.stringify(cleared)})`);
      });
      await guard('C1 shop name', async () => {
        await openSettingsCard(page, 'basic');
        await page.locator('#shopNameInput').fill('새이름식당');
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
        await page.waitForTimeout(250);
        await check((await page.locator('#shopNameInput').inputValue()) === '새이름식당', 'C1: the shop name field must survive an async render');
        await page.locator('[data-a="save-shop"]').click();
        await page.waitForTimeout(300);
        await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
        await page.waitForTimeout(200);
        await check((await readDb(page)).meta.some(m => m.key === 'shopName' && m.value === '새이름식당') && (await page.locator('#shopNameInput').inputValue()) === '새이름식당', 'C1: saving the shop name keeps the saved value in the field');
      });
      await check(problems.length === 0, `settings: no page errors (${JSON.stringify(problems.slice(0, 3))})`);
    } catch (err) { if (!soft) throw err; fails.push('settings: ' + String(err && err.message || err).slice(0, 240)); console.log('  ✗ settings: ' + String(err && err.message || err).slice(0, 240)); }
    finally { await ctx.close(); }
  }

  // ═════ ④ 약관 다시 동의 창(C4) — 버튼은 살아 있고, 동의 없이 누르면 이유가 체크 칸 옆에 남는다 ═════
  await guard('terms', async () => {
    const { ctx, page } = await newPage();
    try {
      await seed(page, [emp('t-1', { name: '약관이' })], [], { termsAgreedAt: undefined });
      await page.reload({ waitUntil: 'load' });
      await unlockPin(page);
      await page.waitForSelector('#termsAgreeBtn', { timeout: 15000 });
      await check(!(await page.locator('#termsAgreeBtn').isDisabled()), 'C4: the re-consent button must not be a disabled-but-active-looking button');
      const rowH = await page.evaluate(() => { const r = document.querySelector('.terms-row') || document.querySelector('#termsChk').closest('label'); return Math.round(r.getBoundingClientRect().height); });
      await check(rowH >= 44, `C4: the consent row must be a ≥44px tap target (got ${rowH}px)`);
      const linkH = await page.evaluate(() => [...document.querySelectorAll('.modal a[href*="terms"], .modal a[href*="privacy"]')].map(a => Math.round(a.getBoundingClientRect().height)));
      await check(linkH.length === 2 && linkH.every(h => h >= 44), `C13: terms links must be ≥44px targets (got ${JSON.stringify(linkH)})`);
      await page.locator('#termsAgreeBtn').click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(200);
      const why = await page.locator('#termsChkWhy').innerText({ timeout: 1000 }).catch(() => '');
      await check(await page.locator('#termsAgreeBtn').count() === 1 && why.includes('동의'), `C4: tapping without consent keeps the dialog and shows the reason next to the checkbox (got ${JSON.stringify(why)})`);
      await check(await page.evaluate(() => { const c = document.querySelector('.terms-card'); return !!c && c.classList.contains('terms-need'); }), 'C4: the consent box is highlighted');
      await page.locator('#termsChk').check();
      await check((await page.locator('#termsChkWhy').innerText({ timeout: 1000 }).catch(() => 'x')) === '' && await page.locator('#termsChk').isChecked(), 'C4: checking the box clears the reason');
      await page.locator('#termsAgreeBtn').click();
      await page.waitForTimeout(250);
      await check(await page.locator('#termsAgreeBtn').count() === 0 && (await readDb(page)).meta.some(m => m.key === 'termsAgreedAt' && m.value > 0), 'C4: after consent the dialog closes and the consent is stored');
    } finally { await ctx.close(); }
  });

  // ═════ ⑤ 좁은 폰(360px) 증표 카드(C5) ═════
  await guard('receipt 360', async () => {
    const { ctx, page } = await newPage({ viewport: { width: 360, height: 640 } });
    try {
      await seed(page, [emp('r-1', { org: '서울특별시 강남구청', dept: '어르신복지과', name: '김수한무거북이와두루미' })], [tx('r-o', 'r-1', 'open', 1234567, 1)]);
      await page.reload({ waitUntil: 'load' });
      await unlockPin(page);
      await page.waitForSelector('[data-a="quick-find-emp"]');
      await expandHomeGroups(page);
      await page.locator('[data-a="receipt"][data-id="r-1"]').click();
      await page.waitForSelector('.namecard');
      const r = await page.evaluate(() => { const c = document.querySelector('.namecard').getBoundingClientRect(); const m = document.querySelector('.receipt-modal').getBoundingClientRect(); return { l: c.left, r: c.right, ml: m.left, mr: m.right, cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }; });
      await check(r.l >= r.ml - 1 && r.r <= r.mr + 1 && r.r <= r.cw + 1 && r.sw <= r.cw + 1, `C5: the receipt card must fit inside the modal at 360px (card ${Math.round(r.l)}~${Math.round(r.r)}, modal ${Math.round(r.ml)}~${Math.round(r.mr)}, width ${r.cw})`);
    } finally { await ctx.close(); }
  });

  console.log(`beta.55 A1b 검증: ${passed} 통과, ${fails.length} 실패`);
  if (fails.length) console.log(JSON.stringify(fails, null, 2));
  return { passed, fails };
}

// ── beta.55 A2: 장부 지키기 — 서버 백업 v2(조각)·내 보관 백업(암호 건 파일)·되찾기 ───────────────────────────────
//   목 중계 서버는 계약(PROTOCOL §4.13)을 **강제**한다: 소유 증명 토큰 1회용(재사용 → 401·집계), gen 형식, seg_no 정수 0..999,
//   조각 blob ≤ 400,000자, 머리 blob ≤ 1,000,000자, 머리(gen 포함)가 오면 다른 gen 조각을 같은 자리에서 지움, 구서버 모드(조각 API 404).
//   예전 형식 파일은 수정 전 앱(beta.54 + A1a·A1b)의 실제 UI로 만든 harness/fixtures/beta54-*.json을 쓴다.
//   E2E_ONLY=beta55c 로 이 블록만, E2E_SOFT=1 로 단언별 실패 목록을 본다. B55_SHOTS_DIR=<폴더> 면 화면 캡처를 남긴다.
function makeBackupRelay(cors) {
  const st = { reg: new Map(), tokens: new Set(), head: new Map(), segs: new Map(), log: [], mode: 'v2', fail: '', challenges: 0, reused: 0, violations: [], rate429: 0, failHead: false, segBudget: null,
    // beta.60(A3) — 실서버(worker.js)의 새 동작을 그대로 흉내 낸다:
    //   graceMs: 머리 저장은 최근 15분 동안 쓰이지 않은 다른 세대만 지운다(S-9, HEAD_SEG_GRACE_MS) · seg_count가 오면 그 세대의 조각 0..n-1이 모두 있어야 머리를 쓴다(409 segments_missing)
    //   dropSegOnHead: 머리를 받기 직전 그 세대의 조각 0을 지운다(횟수, -1이면 늘) — "그 사이 조각이 사라짐"을 만든다
    //   segDelayMs: 조각 요청을 그만큼 붙잡아 둔다(삭제와 업로드의 경쟁) · quota: 조각 업로드에 400 backup_quota_exceeded
    //   archive: 인수된 가게의 옛 백업 보관 칸(§4.14) — 키 `${rid}|${공개키}` → {head, segs, archived_at, keep_until}. 토큰은 일반 토큰과 따로(atokens)
    //   dereg·names·compat·registerFail·registers: /api/register-key(§4.1·§4.12, S-8 — 휴지통 되돌리기는 소유 증명, 토큰 없는 호환은 상호가 같을 때만)
    graceMs: 15 * 60000, dropSegOnHead: 0, segDelayMs: 0, quota: false, archive: new Map(), atokens: new Set(),
    dereg: new Set(), names: new Map(), compat: true, registerFail: '', registers: [] };
  const GEN_RE = /^[A-Za-z0-9_-]{8,40}$/;
  const segsOf = rid => { if (!st.segs.has(rid)) st.segs.set(rid, new Map()); return st.segs.get(rid); };
  async function handle(route) {
    const req = route.request(); const p = new URL(req.url()).pathname; let b = {};
    try { b = JSON.parse(req.postData() || '{}'); } catch (e) { b = {}; }
    const reply = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(obj) });
    if (p === '/api/challenge') {
      if (st.rate429 > 0) { st.rate429 -= 1; return reply(429, { error: 'rate_limited' }); }
      const pub = st.reg.get(String(b.restaurant_id || ''));
      if (!pub) return reply(404, { error: '등록된 공개키 없음' });
      const tok = 'tok-' + crypto.randomBytes(8).toString('hex'); st.tokens.add(tok); st.challenges += 1;
      const key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
      const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(tok, 'utf8'));
      return reply(200, { challenge_ct: ct.toString('base64') });
    }
    if (p === '/api/register-key') {
      const rid0 = String(b.restaurant_id || ''), pub0 = String(b.public_key || ''), name0 = String(b.restaurant_name || '').trim();
      st.registers.push({ restaurant_id: rid0, public_key: pub0, restaurant_name: name0, auth_token: b.auth_token || null, district: b.district || null });
      if (st.registerFail) { const code = st.registerFail; return reply(code === 'store_name_required' ? 400 : 409, { error: code }); }
      const ex = st.reg.get(rid0);
      const authOk = () => { if (!b.auth_token || !st.tokens.has(b.auth_token)) return false; st.tokens.delete(b.auth_token); return true; };
      if (ex) {
        if (ex === pub0) {
          if (st.dereg.has(rid0)) {
            if (b.auth_token) { if (!authOk()) return reply(401, { error: 'auth_required' }); }
            else if (!st.compat || (name0 && name0 !== (st.names.get(rid0) || ''))) return reply(401, { error: 'auth_required' });
            st.dereg.delete(rid0); if (name0) st.names.set(rid0, name0);
            return reply(200, { ok: true, reactivated: true });
          }
          return reply(200, { ok: true });
        }
        if (st.dereg.has(rid0)) { if (!name0) return reply(400, { error: 'store_name_required' }); st.reg.set(rid0, pub0); st.dereg.delete(rid0); st.names.set(rid0, name0); return reply(200, { ok: true }); }
        if (!authOk()) return reply(401, { error: 'auth_required' });
        st.reg.set(rid0, pub0); return reply(200, { ok: true });
      }
      if (!name0) return reply(400, { error: 'store_name_required' });
      st.reg.set(rid0, pub0); st.names.set(rid0, name0); return reply(200, { ok: true });
    }
    if (p.startsWith('/api/ledger-archive/')) {
      const rid0 = String(b.restaurant_id || ''), pub0 = String(b.public_key || '');
      if (!rid0 || !pub0) return reply(400, { error: 'restaurant_id·public_key 필요' });
      const arc = st.archive.get(rid0 + '|' + pub0);
      if (p === '/api/ledger-archive/challenge') {
        st.log.push({ t: 'achallenge' });
        if (!arc) return reply(404, { error: 'not_found' });
        const tok = 'atok-' + crypto.randomBytes(8).toString('hex'); st.atokens.add(tok);
        const key = crypto.createPublicKey({ key: Buffer.from(pub0, 'base64'), format: 'der', type: 'spki' });
        const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(tok, 'utf8'));
        return reply(200, { challenge_ct: ct.toString('base64'), archived_at: arc.archived_at, keep_until: arc.keep_until, has_head: !!arc.head });
      }
      const isGet = p === '/api/ledger-archive/get', isSegGet = p === '/api/ledger-archive/seg/get', isSegList = p === '/api/ledger-archive/seg/list';
      if (!isGet && !isSegGet && !isSegList) return reply(404, { error: 'not found' });
      if (isSegGet) {
        if (!GEN_RE.test(String(b.gen == null ? '' : b.gen))) { st.violations.push('archive gen'); return reply(400, { error: 'invalid_gen' }); }
        if (!Array.isArray(b.seg_nos) || b.seg_nos.length < 1 || b.seg_nos.length > 5 || !b.seg_nos.every(n => Number.isInteger(n) && n >= 0 && n <= 999)) { st.violations.push('archive seg_nos'); return reply(400, { error: 'invalid_seg_nos', max: 5 }); }
      }
      if (!arc) return reply(404, { error: 'not_found' });
      // 보관 칸 토큰은 일반 토큰과 섞이지 않는다(일반 토큰이 오면 401 — 실서버와 같다).
      if (!b.auth_token || !st.atokens.has(b.auth_token)) { st.reused += 1; return reply(401, { error: 'auth_required' }); }
      st.atokens.delete(b.auth_token);
      if (isGet) { st.log.push({ t: 'aget' }); if (!arc.head) return reply(404, { error: 'not_found' }); return reply(200, { blob: arc.head.blob, blob_hash: arc.head.blob_hash, updated_at: arc.head.updated_at }); }
      if (isSegGet) { st.log.push({ t: 'asegget', nos: b.seg_nos }); const m = (arc.segs && arc.segs.get(String(b.gen))) || new Map(); return reply(200, { segments: [...new Set(b.seg_nos)].filter(n => m.has(n)).sort((x, y) => x - y).map(n => ({ seg_no: n, blob: m.get(n).blob, blob_hash: m.get(n).blob_hash, updated_at: m.get(n).updated_at })) }); }
      const out = []; (arc.segs || new Map()).forEach((m, gen) => m.forEach((v, n) => out.push({ gen, seg_no: n, blob_hash: v.blob_hash, updated_at: v.updated_at, size: v.blob.length })));
      return reply(200, { segments: out });
    }
    if (!p.startsWith('/api/ledger-backup')) return reply(500, { error: 'harness: no mock' });
    if (p.startsWith('/api/ledger-backup/seg') && st.mode === 'old') return reply(404, { error: 'not found' });
    if (st.fail === '500') return reply(500, { error: 'internal' });
    const rid = String(b.restaurant_id || '');
    const auth = () => { if (!st.tokens.has(b.auth_token)) { st.reused += 1; return false; } st.tokens.delete(b.auth_token); return true; };
    if (p === '/api/ledger-backup/seg/list') {
      if (!auth()) return reply(401, { error: 'auth_required' });
      st.log.push({ t: 'list' });
      const out = []; segsOf(rid).forEach((m, gen) => m.forEach((v, n) => out.push({ gen, seg_no: n, blob_hash: v.blob_hash, updated_at: v.updated_at, size: v.blob.length })));
      return reply(200, { segments: out });
    }
    if (p === '/api/ledger-backup/seg') {
      if (!GEN_RE.test(String(b.gen || ''))) { st.violations.push('gen ' + b.gen); return reply(400, { error: 'invalid_gen' }); }
      if (!Number.isInteger(b.seg_no) || b.seg_no < 0 || b.seg_no > 999) { st.violations.push('seg_no ' + b.seg_no); return reply(400, { error: 'invalid_seg_no' }); }
      if (typeof b.blob !== 'string' || !b.blob || b.blob.length > 400000) { st.violations.push('seg blob size'); return reply(400, { error: 'blob 크기 초과' }); }
      if (!auth()) return reply(401, { error: 'auth_required' });
      if (st.segDelayMs > 0) { st.log.push({ t: 'segstart', gen: b.gen, n: b.seg_no }); await new Promise(r => setTimeout(r, st.segDelayMs)); }
      if (st.quota) { st.log.push({ t: 'segquota', gen: b.gen, n: b.seg_no }); return reply(400, { error: 'backup_quota_exceeded', max_chars: 12000000 }); }
      // A3: segBudget(숫자)면 그만큼만 받고 그다음 조각부터 500 — '새 세대를 올리다 끊김'을 흉내 낸다.
      if (typeof st.segBudget === 'number') { if (st.segBudget <= 0) { st.log.push({ t: 'segfail', gen: b.gen, n: b.seg_no }); return reply(500, { error: 'internal' }); } st.segBudget -= 1; }
      const m = segsOf(rid); if (!m.has(b.gen)) m.set(b.gen, new Map());
      const at = Date.now(); m.get(b.gen).set(b.seg_no, { blob: b.blob, blob_hash: b.blob_hash || null, updated_at: at });
      st.log.push({ t: 'seg', gen: b.gen, n: b.seg_no, size: b.blob.length });
      // beta.60(보완): segHang — 서버는 조각을 저장했지만 응답이 오지 않는다(본문이 멈춘 상태). st.segHangRelease()를 부를 때까지 붙잡는다.
      if (st.segHang) { st.segHang = false; st.log.push({ t: 'seghang', gen: b.gen, n: b.seg_no }); await new Promise(r => { st.segHangRelease = r; }); }
      return reply(200, { ok: true, updated_at: at });
    }
    if (p === '/api/ledger-backup/seg/get') {
      if (!Array.isArray(b.seg_nos) || b.seg_nos.length < 1 || b.seg_nos.length > 5 || !b.seg_nos.every(n => Number.isInteger(n))) { st.violations.push('seg_nos ' + JSON.stringify(b.seg_nos)); return reply(400, { error: 'invalid_seg_nos' }); }
      if (!auth()) return reply(401, { error: 'auth_required' });
      st.log.push({ t: 'get', gen: b.gen, nos: b.seg_nos });
      const m = segsOf(rid).get(String(b.gen)) || new Map();
      return reply(200, { segments: b.seg_nos.filter(n => m.has(n)).map(n => ({ seg_no: n, blob: m.get(n).blob, blob_hash: m.get(n).blob_hash, updated_at: m.get(n).updated_at })) });
    }
    if (p === '/api/ledger-backup') {
      if (typeof b.blob !== 'string' || !b.blob || b.blob.length > 1000000) { st.violations.push('head blob size'); return reply(400, { error: 'blob 크기 초과(1MB)' }); }
      if (b.gen != null && !GEN_RE.test(String(b.gen))) { st.violations.push('head gen'); return reply(400, { error: 'invalid_gen' }); }
      if (b.seg_count != null && (!b.gen || !Number.isInteger(b.seg_count) || b.seg_count < 1 || b.seg_count > 1000)) { st.violations.push('seg_count ' + b.seg_count); return reply(400, { error: 'invalid_seg_count' }); }
      if (!auth()) return reply(401, { error: 'auth_required' });
      if (st.failHead) { st.log.push({ t: 'headfail', gen: b.gen || null }); return reply(500, { error: 'internal' }); }
      const at = Date.now();
      if (b.gen && b.seg_count != null) {
        const m0 = segsOf(rid).get(b.gen) || new Map();
        if (st.dropSegOnHead) { m0.delete(0); if (st.dropSegOnHead > 0) st.dropSegOnHead -= 1; }
        let have = 0; for (let n = 0; n < b.seg_count; n += 1) if (m0.has(n)) have += 1;
        if (have !== b.seg_count) { st.log.push({ t: 'headmissing', gen: b.gen, sc: b.seg_count }); return reply(409, { error: 'segments_missing' }); }
      }
      st.head.set(rid, { blob: b.blob, blob_hash: b.blob_hash || '', updated_at: at, gen: b.gen || null });
      // 실서버(S-9)처럼: 최근 graceMs 동안 쓰이지 않은 다른 세대만 지운다(세대의 최대 updated_at 기준).
      if (b.gen) { const m = segsOf(rid); [...m.keys()].filter(g => g !== b.gen && Math.max(...[...m.get(g).values()].map(v => v.updated_at)) < at - st.graceMs).forEach(g => m.delete(g)); }
      st.log.push({ t: 'head', gen: b.gen || null, size: b.blob.length, sc: b.seg_count == null ? null : b.seg_count });
      return reply(200, { ok: true });
    }
    if (p === '/api/ledger-backup/get') {
      if (!auth()) return reply(401, { error: 'auth_required' });
      st.log.push({ t: 'headget' });
      const h = st.head.get(rid); if (!h) return reply(404, { error: 'not_found' });
      return reply(200, { blob: h.blob, blob_hash: h.blob_hash, updated_at: h.updated_at });
    }
    if (p === '/api/ledger-backup/delete') {
      if (!auth()) return reply(401, { error: 'auth_required' });
      const had = st.head.delete(rid); st.segs.delete(rid); st.log.push({ t: 'delete' });
      return had ? reply(200, { ok: true }) : reply(404, { error: 'not_found' });
    }
    return reply(404, { error: 'not found' });
  }
  return { st, handle };
}

async function runBeta55c(browser, url, cors) {
  const os = require('os');
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.55c] ' + msg);
  };
  const guard = async (label, fn) => {
    if (process.env.E2E_VERBOSE) console.log('  · ' + label);
    try { await fn(); } catch (err) { if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 300)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 300)}`); }
  };
  const SHOTS = process.env.B55_SHOTS_DIR || '';
  if (SHOTS) await fsp.mkdir(SHOTS, { recursive: true }).catch(() => {});
  const shot = async (page, name) => {
    if (!SHOTS) return;
    if (/^card-/.test(name)) await page.evaluate(() => { const el = document.querySelector('.fold-head[data-card="ledger"]'); if (el) { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -120); } }).catch(() => {});
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') }).catch(() => {});
  };
  const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
  const DAY = 86400000, T0 = Date.now() - 20 * DAY;
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
  const RID = 'rid-b55c';
  const FIX = path.join(__dirname, 'fixtures');
  const relay = makeBackupRelay(cors);
  const emp = (id, name, dept, o) => Object.assign({ id, org: '광진구청', orgKind: 'public', dept, name, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: T0, updatedAt: T0 }, o || {});
  const tx = (id, e, type, amount, k, extra) => Object.assign({ id, employeeId: e, type, amount, beforeBalance: 0, afterBalance: 0, reason: type === 'use' ? '서명 확인' : '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', hv: 2, txHash: '', prevHash: '', createdAt: T0 + k * 60000, occurredAt: 0 }, extra || {});
  const putAll = (page, o) => page.evaluate(o2 => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result; const t = db.transaction(['meta', 'employees', 'transactions'], 'readwrite');
      Object.entries(o2.meta || {}).forEach(([k, v]) => t.objectStore('meta').put({ key: k, value: v }));
      (o2.employees || []).forEach(e => t.objectStore('employees').put(e));
      (o2.transactions || []).forEach(x => t.objectStore('transactions').put(x));
      t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error);
    };
  }), o);
  const metaOf = async page => (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
  const awaitUnlocked = page => page.waitForFunction(() => { const H = window.__prepaidTestHooks; return !!H && H.lockState && H.lockState().locked === false; }, null, { timeout: 20000 });
  const reloadUnlock = async page => { await page.reload({ waitUntil: 'load' }); await unlockPin(page); await awaitUnlocked(page); };
  const choiceTitle = async page => { await page.waitForSelector('#choiceTitle', { timeout: 20000 }); return (await page.locator('#choiceTitle').innerText()).trim(); };
  const choiceText = async page => (await page.locator('.choice-modal').innerText());
  const pick = async (page, val) => { await page.locator(`.choice-modal [data-a="choice-pick"][data-val="${val}"]`).click(); await page.waitForTimeout(150); };
  const goGuard = async page => { await page.locator('[data-a="screen"][data-screen="settings"]').click(); await openSettingsCard(page, 'ledger'); };
  const passHint = async page => (await page.locator('#keyPassHint').innerText().catch(() => ''));
  const waitDl = async (list, n, ms = 20000) => { const t0 = Date.now(); while (list.length < n && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 100)); return list[n - 1]; };
  const dlJson = async d => JSON.parse(await fsp.readFile(await d.path(), 'utf8'));
  const sortById = a => [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  // 필드 단위 비교(skip 필드 제외). 차이 목록을 돌려준다.
  const diffRecs = (A, B, skip) => {
    const out = []; const a = sortById(A), b = sortById(B);
    if (a.length !== b.length) out.push(`count ${a.length} → ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const keys = [...new Set([...Object.keys(a[i]), ...Object.keys(b[i])])].filter(k => !(skip || []).includes(k));
      for (const k of keys) if (JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) out.push(`${a[i].id}.${k}: ${JSON.stringify(a[i][k]).slice(0, 60)} → ${JSON.stringify(b[i][k]).slice(0, 60)}`);
    }
    return out;
  };
  const hookChain = page => page.evaluate(async () => { const H = window.__prepaidTestHooks; const v = await H.verifyChain(); const r = H.reconcileLedger ? H.reconcileLedger() : null; return { ok: v.ok, tamperOk: v.tamperOk, broken: v.broken.length, legacy: v.legacy, reconcile: !!(r && r.ok) }; });
  const newCtx = async (vp) => {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: vp || { width: 390, height: 844 }, isMobile: !vp || vp.width < 700, hasTouch: true });
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
    await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
    await ctx.route('**/api/challenge**', relay.handle);
    await ctx.route('**/api/ledger-backup**', relay.handle);
    const page = await ctx.newPage();
    const dialogs = []; const downloads = [];
    page.on('dialog', async d => { dialogs.push({ type: d.type(), message: d.message() }); await d.dismiss().catch(() => {}); });
    page.on('download', d => downloads.push(d));
    return { ctx, page, dialogs, downloads };
  };
  // 전화번호는 앱과 같은 방식(deviceSecret로 PBKDF2 12만 회 + AES-GCM)으로 봉해 둔다 — 복원 뒤 '같은 기기 전화 유지'를 보려고.
  const sealPhone = (page, phone) => page.evaluate(async phone => {
    const m = await new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('deviceSecret'); q.onsuccess = () => res(q.result && q.result.value); }; });
    const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(m)), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(phone));
    return JSON.stringify({ v: 1, salt: u2b(salt), iv: u2b(iv), ct: u2b(ct) });
  }, phone);

  // ═════════════════════ 기기 A: 등록된 가게 ═════════════════════
  const A = await newCtx();
  const page = A.page;
  let passFile1 = null; let passFileName1 = ''; let ledgerAtPass1 = null; let pubA = '';
  try {
    const vlog = m => { if (process.env.E2E_VERBOSE) console.log('    ' + m); };
    await page.goto(url, { waitUntil: 'load' });
    // 앱이 저장소(버전 3)를 먼저 열 때까지 기다린다 — 하니스가 먼저 열면 스토어 없는 빈 DB를 만들어 시드가 멈춘다.
    await page.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 });
    await page.waitForTimeout(200);
    vlog('loaded');
    const phoneEnc = await sealPhone(page, '01012345678');
    vlog('phone sealed');
    const emps = [emp('c-e1', '김지킴', '세무과', { phone: phoneEnc, phoneConsent: true }), emp('c-e2', '이보관', '세무과'), emp('c-e3', '박되찾', '총무과')];
    const base7 = [tx('c-t1', 'c-e1', 'open', 50000, 1), tx('c-t2', 'c-e2', 'open', 50000, 2), tx('c-t3', 'c-e3', 'open', 30000, 3),
      tx('c-t4', 'c-e1', 'use', 9000, 4, { signatureData: SIG, note: '점심' }), tx('c-t5', 'c-e2', 'use', 8000, 5, { signatureData: SIG }),
      tx('c-t6', 'c-e1', 'use', 9000, 6, { signatureData: SIG }), tx('c-t7', 'c-e3', 'topup', 10000, 7, { note: '추가 입금' })];
    const now = Date.now();
    await putAll(page, { meta: { setupComplete: true, welcomeSeen: true, termsAgreedAt: now, pinHash: legacyPin, shopName: '지킴식당', departments: ['세무과', '총무과'], orgName: '광진구청',
      storeRegisterPending: false, restaurantId: RID, relayStoreName: '지킴식당', relayRegisteredAt: now, districtSyncedAt: now, myKeyBackedUpAt: now }, employees: emps, transactions: base7 });
    await resealChain(page);
    pubA = (await metaOf(page)).pubKey;
    await check(!!pubA, 'setup: the device must have generated its shop key on first load');

    // ── ① 실패는 조용히 넘어가지 않는다: 자동 백업(잠금 해제 때) 실패 → 기록 + 상태 상자 + 홈 배너 ──
    await guard('fail-surfaced', async () => {
      await reloadUnlock(page);
      await page.waitForFunction(() => { const s = window.__prepaidTestHooks.cloudState(); return s && s.failSince > 0; }, null, { timeout: 20000 });
      const st = await page.evaluate(() => window.__prepaidTestHooks.cloudState());
      await check(st.failSince > 0 && st.lastError === 'store_not_registered', `a failed automatic server backup must be recorded with its reason (got ${JSON.stringify({ failSince: st.failSince, lastError: st.lastError })})`);
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await page.waitForSelector('.guard-banner', { timeout: 8000 });
      const bt = await page.locator('.guard-banner').innerText();
      await check(/서버 백업/.test(bt), `the home banner must say the server backup failed (got ${JSON.stringify(bt)})`);
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      const kicker = (await page.locator('.fold-head[data-card="ledger"] .section-kicker').innerText()).trim();
      const gs = await page.evaluate(() => window.__prepaidTestHooks.guardStatus());
      await check(kicker === gs.head && /서버 백업/.test(kicker), `the folded 장부 지키기 summary must be the same sentence as the status box (kicker ${JSON.stringify(kicker)} vs head ${JSON.stringify(gs.head)})`);
      await openSettingsCard(page, 'ledger');
      const box = await page.locator('#guardState').innerText();
      await check((await page.locator('#guardState.warn').count()) === 1 && box.includes('서버 백업이 안 됐어요') && box.includes('등록'), `the status box must turn into a warning that names the reason (got ${JSON.stringify(box)})`);
      await shot(page, 'card-warning-390');
    });

    // ── ② v2 업로드: 300건 대신 3건씩(하니스 훅) → 조각 3개 + 머리 1개, 머리는 마지막, 토큰은 요청마다 새로 ──
    let gen1 = '';
    await guard('v2-upload', async () => {
      relay.st.reg.set(RID, pubA);
      await page.evaluate(() => { window.__cloudSegSize = 3; });
      relay.st.log.length = 0; const ch0 = relay.st.challenges;
      await page.locator('[data-a="backup-now"]').first().click();
      const title = await choiceTitle(page);
      await check(title === '백업했어요. 내 보관용도 남길까요?', `after a successful server backup the dialog must ask about an own copy (got ${JSON.stringify(title)})`);
      const opts = await page.$$eval('.choice-modal [data-a="choice-pick"]', bs => bs.map(b => ({ v: b.dataset.val, t: b.innerText.replace(/\s+/g, ' ').trim(), primary: b.classList.contains('btn-primary') })));
      await check(opts.length === 3 && opts[0].v === 'share' && opts[0].primary && opts[1].v === 'save' && opts[2].v === 'none' && opts[2].t.includes('서버 백업만 할게요') && opts.filter(o => o.primary).length === 1,
        `the dialog must offer ① 카톡·메일로 보내기(primary) ② 이 기기에 저장 ③ 서버 백업만 할게요 (got ${JSON.stringify(opts)})`);
      await shot(page, 'choice-3-390');
      await pick(page, 'none');
      const log = relay.st.log.map(e => e.t + (e.n != null ? e.n : ''));
      await check(JSON.stringify(log) === JSON.stringify(['list', 'seg0', 'seg1', 'seg2', 'head']), `7 transactions in segments of 3 must upload list → seg0 → seg1 → seg2 → head (head LAST) (got ${JSON.stringify(log)})`);
      const head = relay.st.log.find(e => e.t === 'head'); gen1 = head && head.gen;
      await check(!!gen1 && relay.st.log.filter(e => e.t === 'seg').every(e => e.gen === gen1), `the head must carry the same gen as its segments (got ${JSON.stringify(relay.st.log)})`);
      await check(relay.st.challenges - ch0 === 5 && relay.st.reused === 0, `every authenticated request must use its own one-time token (challenges ${relay.st.challenges - ch0}, reused ${relay.st.reused})`);
      const m = await metaOf(page);
      await check(m.cloudBackupState && m.cloudBackupState.gen === gen1 && Object.keys(m.cloudBackupState.segs).length === 3 && !m.cloudBackupState.failSince && m.cloudBackupState.lastOkAt > 0 && m.lastCloudBackupAt > 0,
        `a successful backup must record gen, segment hashes and clear the failure (got ${JSON.stringify(m.cloudBackupState && { gen: m.cloudBackupState.gen, segs: m.cloudBackupState.segs, failSince: m.cloudBackupState.failSince })})`);
      const segSizes = relay.st.log.filter(e => e.t === 'seg').map(e => e.size);
      await check(segSizes.every(s => s < 5000), `segments must be compressed and carry no signature images (sizes ${JSON.stringify(segSizes)})`);
      const box = await page.locator('#guardState').innerText();
      // beta.60(가-1): 이 가게는 아직 백업 암호를 정하지 않았다 — 서버 경고가 걷힌 자리에는 "백업 암호를 아직 정하지 않았어요"(사실)가 선다.
      //   서버 쪽은 조용해야 한다: 서버 실패·멈춤 문장이 없고 '오늘'이 보인다. 백업 암호를 정한 뒤(⑫ 이후)의 '✓ 안전' 문장은 아래 단계가 본다.
      await check(!box.includes('서버 백업이') && box.includes('서버 자동 백업 (매주)') && box.includes('오늘') && (box.includes('장부가 안전하게 보관돼 있어요') || box.startsWith('⚠ 백업 암호를 아직 정하지 않았어요')), `after success the server part of the status box must be calm and say 오늘 (got ${JSON.stringify(box)})`);
      await shot(page, 'card-normal-390');
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await check((await page.locator('.guard-banner').count()) === 0 || !(await page.locator('.guard-banner').innerText()).includes('서버 백업'), 'the server-backup home banner must go away after a successful backup');
    });

    // ── ③ 닫힌 조각은 다시 올리지 않는다 ──
    await guard('v2-incremental', async () => {
      await putAll(page, { transactions: [tx('c-t8', 'c-e2', 'use', 5000, 8, { signatureData: SIG }), tx('c-t9', 'c-e3', 'use', 7000, 9)] });
      await resealChain(page);
      await reloadUnlock(page);
      await page.evaluate(() => { window.__cloudSegSize = 3; });
      await page.waitForTimeout(400);
      relay.st.log.length = 0;
      await goGuard(page);
      await page.locator('[data-a="backup-now"]').click();
      await choiceTitle(page); await pick(page, 'none');
      const log = relay.st.log.map(e => e.t + (e.n != null ? e.n : ''));
      await check(JSON.stringify(log) === JSON.stringify(['list', 'seg2', 'head']), `with 9 transactions only the changed segment (2) may be uploaded again (got ${JSON.stringify(log)})`);
      await check(relay.st.log.every(e => e.gen == null || e.gen === gen1), 'an incremental backup must keep the same gen');
    });

    // ── ④ 서버에서 되찾기: 백업(9건)이 지금(10건)보다 적으면 진한 버튼이 [취소] → 안전 사본 → 필드 단위 동일(서명 그림만 없음) ──
    await guard('cloud-restore', async () => {
      const ledgerA = await readDb(page);
      await putAll(page, { transactions: [tx('c-t10', 'c-e1', 'topup', 1000, 10)] });
      await resealChain(page);
      await reloadUnlock(page);
      await goGuard(page);
      await page.locator('[data-a="guard-restore"]').click();
      await choiceTitle(page);
      await check((await page.locator('.choice-modal [data-val="cloud"]').count()) === 1 && (await page.locator('.choice-modal [data-val="file"]').count()) === 1, 'a registered shop must be offered 서버에서 / 파일에서 되찾기');
      await pick(page, 'cloud');
      let t = await choiceTitle(page); let txt = await choiceText(page);
      const prim = await page.$$eval('.choice-modal [data-a="choice-pick"].btn-primary', bs => bs.map(b => b.dataset.val));
      await check(t.includes('거래가 적은 백업') && txt.includes('지금 10건') && txt.includes('백업 9건') && txt.includes('지금 3명') && txt.includes('백업 3명') && txt.includes('백업 시각') && JSON.stringify(prim) === '["cancel"]',
        `restoring fewer transactions must say 지금 10건 → 백업 9건 · 직원 수 · 백업 시각 and make [취소] the primary button (title ${JSON.stringify(t)}, primary ${JSON.stringify(prim)}, text ${JSON.stringify(txt.slice(0, 300))})`);
      await shot(page, 'restore-fewer-390');
      await pick(page, 'cancel');
      await check((await readDb(page)).transactions.length === 10, 'cancelling the restore must leave the ledger untouched');
      const dl0 = A.downloads.length;
      await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud');
      t = await choiceTitle(page); await pick(page, 'go');
      t = await choiceTitle(page);
      txt = await choiceText(page);
      await check(t === '되찾기를 마쳤어요' && txt.includes('서명 그림은 이 백업에 없어요') && txt.includes('잠긴 안전 사본') && txt.includes('전화번호 1건'), `the result must say what happened (snapshot, no signature images, phone kept) (got ${JSON.stringify(txt.slice(0, 400))})`);
      await pick(page, 'ok');
      const snapDl = A.downloads[dl0];
      await check(!!snapDl && /^밥장부_되돌리기전_잠긴사본_\d{4}-\d{2}-\d{2}\.json$/.test(snapDl.suggestedFilename()), `a locked safety snapshot must be downloaded before overwriting (got ${snapDl && snapDl.suggestedFilename()})`);
      const snap = await dlJson(snapDl);
      const snapCore = await page.evaluate(b => window.__prepaidTestHooks.decryptBlob(b), snap.blob);
      // beta.60b(이름): 화면 이름은 '밥장부'로 바뀌어도 파일 **안의** appName은 예전 값 그대로다(파일 형식 불변).
      await check(snap.appName === '선입금대장' && snapCore.appName === '선입금대장', `the locked file keeps the in-file appName 선입금대장 (got ${JSON.stringify({ outer: snap.appName, inner: snapCore && snapCore.appName })})`);
      await check(snap.type === 'prepaid-locked-backup' && snapCore.payload.transactions.length === 10, `the safety snapshot must hold the ledger as it was BEFORE the restore (10 transactions, got ${snapCore && snapCore.payload.transactions.length})`);
      const B = await readDb(page);
      const txDiff = diffRecs(ledgerA.transactions, B.transactions, ['signatureData']);
      await check(txDiff.length === 0, `restored transactions must equal the backed-up ledger field by field except signatureData (${txDiff.slice(0, 5).join(' | ')})`);
      await check(B.transactions.filter(x => x.type === 'use' && x.signatureHash).every(x => x.signatureData === ''), 'server backups carry no signature images (signatureHash only)');
      const empDiff = diffRecs(ledgerA.employees, B.employees, []);
      await check(empDiff.length === 0, `restored employees must equal the original, including the phone kept from this device (${empDiff.slice(0, 5).join(' | ')})`);
      const ch = await hookChain(page);
      await check(ch.tamperOk && ch.broken === 0 && ch.reconcile, `the hash chain and balances must still verify after a restore without signature images (got ${JSON.stringify(ch)})`);
      const m = await metaOf(page);
      await check(m.cloudBackupState == null && m.restaurantId === RID && m.pubKey === pubA, 'after a restore the cloud state is reset while the device registration and key stay');
      await page.locator('[data-a="screen"][data-screen="history"]').click();
      await page.waitForTimeout(200);
      await check((await page.locator('.sig-missing').count()) >= 3 && (await page.locator('.app').innerText()).includes('서명 기록은 확인됨'), 'history must say the signature image is not in this backup (signature record confirmed)');
      await page.locator('[data-a="screen"][data-screen="home"]').click();
    });

    // ── ⑤ 주 1회: 7일이 안 됐으면 올리지 않고, 7일이 지났고 바뀐 것이 있으면 잠금 해제 때 조용히 올린다(새 gen → 다른 gen 조각 정리) ──
    await guard('weekly', async () => {
      const set = async (ageDays, fpSame) => {
        const cur = await metaOf(page); const fp = fpSame ? await page.evaluate(() => window.__prepaidTestHooks.ledgerFp()) : 'stale';
        const at = Date.now() - ageDays * DAY;
        await putAll(page, { meta: { cloudBackupState: Object.assign({}, cur.cloudBackupState || {}, { lastOkAt: at, fp, failSince: 0, lastTryAt: 0 }), lastCloudBackupAt: at } });
      };
      await set(2, false); relay.st.log.length = 0;
      await reloadUnlock(page); await page.waitForTimeout(1500);
      await check(relay.st.log.length === 0, `a backup younger than 7 days must not be redone on unlock (got ${JSON.stringify(relay.st.log)})`);
      await set(8, true); relay.st.log.length = 0;
      await reloadUnlock(page); await page.waitForTimeout(1500);
      await check(relay.st.log.length === 0, `nothing changed since the last backup → no upload even after 7 days (got ${JSON.stringify(relay.st.log)})`);
      await set(8, false); relay.st.log.length = 0;
      // beta.60: 실서버는 최근 15분 안에 쓰인 다른 세대를 남긴다(S-9) — 일주일 전 세대처럼 보이게 그 조각들의 시각을 20분 앞당긴다.
      (relay.st.segs.get(RID) || new Map()).forEach(m => m.forEach(v => { v.updated_at -= 20 * 60000; }));
      await reloadUnlock(page);
      await page.waitForFunction(() => { const s = window.__prepaidTestHooks.cloudState(); return s && s.lastOkAt > Date.now() - 60000; }, null, { timeout: 20000 });
      const heads = relay.st.log.filter(e => e.t === 'head');
      await check(heads.length === 1 && relay.st.log[relay.st.log.length - 1].t === 'head', `a week-old backup with changes must upload once on unlock, head last (got ${JSON.stringify(relay.st.log.map(e => e.t))})`);
      const gens = [...(relay.st.segs.get(RID) || new Map()).keys()];
      await check(gens.length === 1 && gens[0] === heads[0].gen && gens[0] !== gen1, `a new gen (the ledger was replaced by the restore) must clean up the other gens' segments (gens ${JSON.stringify(gens)})`);
      await check((await page.locator('.choice-back').count()) === 0 && A.dialogs.length === 0, 'the weekly backup must run silently (no dialog)');
    });

    // ── ⑤-2 요청이 몰리면(429 rate_limited) 기다렸다 이어서 올린다 — 실패로 끝내지 않는다 ──
    await guard('rate-limited', async () => {
      await page.evaluate(() => { window.__cloudRetryWaitMs = 50; });
      relay.st.rate429 = 2; relay.st.log.length = 0;
      await goGuard(page);
      await page.locator('[data-a="backup-now"]').click();
      const t = await choiceTitle(page);
      await check(t === '백업했어요. 내 보관용도 남길까요?' && relay.st.rate429 === 0 && relay.st.log.some(e => e.t === 'head'), `two 429 rate_limited answers must be waited out and the backup must still finish (title ${JSON.stringify(t)}, left ${relay.st.rate429})`);
      await pick(page, 'none');
    });

    // ── ⑥ 서버가 실패하면 제목이 정직하다 + 상자에 남는다 + 오래되면 홈 배너 ──
    await guard('fail-dialog', async () => {
      relay.st.fail = '500';
      await goGuard(page);
      await page.locator('[data-a="backup-now"]').click();
      const t = await choiceTitle(page);
      await check(t.includes('서버에는 올리지 못했어요'), `a failed server backup must be said honestly in the dialog title (got ${JSON.stringify(t)})`);
      await check((await page.locator('.choice-modal [data-val="none"]').innerText()).trim() === '취소', 'when the server failed, the third choice is 취소 (not "서버 백업만")');
      await pick(page, 'none');
      const st = await page.evaluate(() => window.__prepaidTestHooks.cloudState());
      await check(st.failSince > 0 && st.lastError === 'internal', `the failure must be recorded (got ${JSON.stringify(st)})`);
      await check((await page.locator('#guardState.warn').count()) === 1, 'the status box must show the failure');
      const cur = await metaOf(page); const old = Date.now() - 10 * DAY;
      await putAll(page, { meta: { cloudBackupState: Object.assign({}, cur.cloudBackupState, { lastOkAt: old, failSince: old, lastTryAt: Date.now() }), lastCloudBackupAt: old } });
      await reloadUnlock(page);
      await page.waitForSelector('.guard-banner', { timeout: 8000 });
      const bt = await page.locator('.guard-banner').innerText();
      await check(/서버 백업이 10일째 안 되고 있어요/.test(bt), `after 10 days without a successful server backup the home banner must say so (got ${JSON.stringify(bt)})`);
      await shot(page, 'home-banner-390');
      relay.st.fail = '';
    });

    // ── ⑦ 구서버(조각 API 404) → v1 한 덩어리(서명 제외·압축)로 폴백, 그 v1에서 되찾기도 된다 ──
    await guard('old-server', async () => {
      relay.st.mode = 'old'; relay.st.log.length = 0;
      await goGuard(page);
      const before = await readDb(page);
      await page.locator('[data-a="backup-now"]').click();
      const t = await choiceTitle(page);
      await check(t === '백업했어요. 내 보관용도 남길까요?', `an old server must still get a backup (got ${JSON.stringify(t)})`);
      await pick(page, 'none');
      const head = relay.st.log.find(e => e.t === 'head');
      await check(!!head && head.gen === null && !relay.st.log.some(e => e.t === 'seg'), `on an old server the app must fall back to one v1 blob without gen (got ${JSON.stringify(relay.st.log)})`);
      const m = await metaOf(page);
      await check(m.cloudBackupState && m.cloudBackupState.mode === 'v1' && !m.cloudBackupState.failSince, 'the v1 fallback must be recorded as a success');
      await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud');
      const t2 = await choiceTitle(page);
      await check(t2 === '이 백업으로 되돌릴까요?', `restoring the same-size v1 backup asks normally (got ${JSON.stringify(t2)})`);
      await pick(page, 'go'); await choiceTitle(page); await pick(page, 'ok');
      const after = await readDb(page);
      const d = diffRecs(before.transactions, after.transactions, ['signatureData']);
      await check(d.length === 0, `a v1-fallback round trip must keep every transaction field except signature images (${d.slice(0, 4).join(' | ')})`);
      relay.st.mode = 'v2';
    });

    // ── ⑧ 내 보관 백업 — 처음엔 백업 암호를 두 번 정한다(8자·불일치는 창 안에서 거절) → 암호 건 파일(600k·gzip·열쇠 포함) ──
    await guard('own-save-first', async () => {
      await goGuard(page);
      await page.locator('[data-a="backup-now"]').click();
      await choiceTitle(page); await pick(page, 'save');
      await page.waitForSelector('#keyPass1', { timeout: 8000 });
      const title = (await page.locator('#keyPassTitle').innerText()).trim();
      await check(title.includes('백업 암호 정하기') && (await page.locator('#keyPass2').count()) === 1 && (await page.locator('#keyPassPlain').count()) === 1 && (await page.locator('#keyPassOk').innerText()).includes('잠가서 저장하기'),
        `the first own backup must ask to SET the backup password twice with a "암호 없이" option (title ${JSON.stringify(title)})`);
      await shot(page, 'pass-dialog-390');
      await page.locator('#keyPass1').fill('short'); await page.locator('#keyPass2').fill('short');
      await page.locator('[data-a="pass-ok"]').click(); await page.waitForTimeout(150);
      await check((await passHint(page)).includes('너무 짧아요') && (await page.locator('#keyPass1').count()) === 1, 'a short backup password must be refused inside the dialog');
      await page.locator('#keyPass1').fill('harness-pass-01'); await page.locator('#keyPass2').fill('harness-pass-02');
      await page.locator('[data-a="pass-ok"]').click(); await page.waitForTimeout(150);
      await check((await passHint(page)).includes('서로 달라요'), 'mismatched backup passwords must be refused inside the dialog');
      const dl0 = A.downloads.length;
      await page.locator('#keyPass2').fill('harness-pass-01');
      await page.locator('[data-a="pass-ok"]').click();
      // beta.59: 정한 직후 "종이에 적어 주세요" 창 — 암호를 그대로 크게 보여 주고, 버튼은 [종이에 적어 두었어요] 하나. 누르기 전에는 파일을 만들지 않는다.
      const tw = await choiceTitle(page);
      await check(tw.includes('백업 암호를 종이에 적어 주세요') && (await page.locator('.choice-modal #passWrite').innerText()).trim() === 'harness-pass-01' && (await choiceText(page)).includes('새 태블릿에서 장부를 되찾을 때 이 암호가 꼭 필요해요') && (await page.locator('.choice-modal [data-a="choice-pick"]').count()) === 1 && A.downloads.length === dl0,
        `right after setting the backup password the app must show it and ask the owner to write it down before making the file (got ${JSON.stringify(tw)})`);
      await pick(page, 'ok');
      const t = await choiceTitle(page);
      await check(t === '파일이 저장됐나요?' && (await choiceText(page)).includes('이 파일은 백업 암호로 열려요'), `after downloading, the app must ask whether the file is visible (with the written-password reminder) instead of claiming it was saved (got ${JSON.stringify(t)})`);
      const d = A.downloads[dl0];
      passFileName1 = d && d.suggestedFilename();
      await check(/^밥장부백업_\d{4}-\d{2}-\d{2}\.json$/.test(passFileName1 || ''), `the own backup file name (got ${passFileName1})`);
      const raw = await fsp.readFile(await d.path(), 'utf8'); passFile1 = JSON.parse(raw);
      await check(passFile1.type === 'prepaid-pass-backup' && passFile1.kdf && passFile1.kdf.it === 600000 && passFile1.kdf.name === 'PBKDF2' && passFile1.z === 1 && !raw.includes('김지킴') && !raw.includes('pkcs8'),
        `the file must be a password-locked backup (PBKDF2 600k, gzip) with no plaintext names or key (got ${JSON.stringify({ type: passFile1.type, kdf: passFile1.kdf, z: passFile1.z })})`);
      await check(passFile1.appName === '선입금대장', `the password-locked file keeps the in-file appName 선입금대장 (got ${JSON.stringify(passFile1.appName)})`);
      ledgerAtPass1 = await readDb(page);
      const m0 = await metaOf(page);
      await pick(page, 'yes');
      const m = await metaOf(page);
      await check(m.lastBackupAt > m0.lastBackupAt - 1 && m.lastBackupAt > Date.now() - 60000 && m.myKeyBackedUpAt > Date.now() - 60000 && m.backupPassCheck && m.backupPassCheck.it === 600000 && !('pass' in m.backupPassCheck) && typeof m.backupPassKeep === 'string' && m.backupPassKeep.length > 20 && !m.backupPassKeep.includes('harness-pass-01'),
        'confirming the file must stamp lastBackupAt and myKeyBackedUpAt; the device keeps a verifier and (beta.59) a device-key-locked copy of the password — never the plain text');
      await check((await page.locator('#guardPassNote').innerText()).includes('백업 암호는 종이에 적어 보관하세요'), 'once a backup password exists the guard card must keep reminding the owner to keep it written down');
      const bk = await page.locator('#guardState').innerText();
      await check(bk.includes('내 보관 백업') && bk.includes('오늘'), `the status box must show 내 보관 백업 오늘 (got ${JSON.stringify(bk)})`);
    });

    // ── ⑨ 두 번째부터는 묻지 않는다(beta.59 — 기기가 암호를 기억). 예전 기기(검증자만 있음)의 "한 번만 넣기"·틀린 암호는
    //    harness/backup-pass.e2e.mjs ⑥이 본다. ──
    await guard('own-save-enter', async () => {
      const dl0 = A.downloads.length;
      await page.locator('[data-a="backup-now"]').click();
      await choiceTitle(page);
      await check((await choiceText(page)).includes('암호 없이 파일 만들기') && (await page.locator('.choice-modal .choice-actions [data-a="choice-pick"]').count()) === 3, 'once the password is remembered the choice must still be three buttons, with the no-password path as a text link below');
      await pick(page, 'save');
      const t = await choiceTitle(page);
      await check(t === '파일이 저장됐나요?' && (await page.locator('#keyPass1').count()) === 0 && A.downloads.length === dl0 + 1, `once set, the backup password must not be asked again — the file is made straight away (got ${JSON.stringify(t)})`);
      const f = JSON.parse(await fsp.readFile(await A.downloads[dl0].path(), 'utf8'));
      await check(f.type === 'prepaid-pass-backup', 'the unasked backup must still be a password-locked file');
      await pick(page, 'yes');
    });

    // ── ⑩ 암호 없이 — 예전 평문 백업(schemaVersion 3), 열쇠 없음 ──
    await guard('own-plain', async () => {
      const k0 = (await metaOf(page)).myKeyBackedUpAt;
      await page.locator('[data-a="backup-now"]').click();
      await choiceTitle(page); await pick(page, 'plain');
      // beta.59: 암호를 기억한 뒤에는 암호 창이 뜨지 않으므로 "암호 없이"는 선택창 아래 글씨 → 확인 창(진한 버튼 = [취소])으로 고른다.
      const tp = await choiceTitle(page);
      await check(tp === '암호 없이 만들까요?' && (await choiceText(page)).includes('가게 열쇠는 들어가지 않아요') && (await page.locator('.choice-modal .btn-primary').innerText()).trim() === '취소', `the no-password path must warn and default to cancel (got ${JSON.stringify(tp)})`);
      const dl0 = A.downloads.length;
      await pick(page, 'save');
      await choiceTitle(page);
      const d = A.downloads[dl0]; const f = await dlJson(d);
      await check(/^밥장부백업_암호없음_/.test(d.suggestedFilename()) && f.schemaVersion === 3 && Array.isArray(f.payload.transactions) && !JSON.stringify(f).includes('pkcs8') && !('privKeyWrapped' in f.payload.meta) && !('backupPassCheck' in f.payload.meta) && !('backupPassKeep' in f.payload.meta) && !('cloudBackupState' in f.payload.meta),
        'an unpassworded backup must be today\'s plain schemaVersion 3 file without the key or device-only meta');
      await check(f.appName === '선입금대장', `the plain backup keeps the in-file appName 선입금대장 (got ${JSON.stringify(f.appName)})`);
      await pick(page, 'yes');
      await check((await metaOf(page)).myKeyBackedUpAt === k0, 'a plain backup must not count as a key backup');
    });

    // ── ⑪ 카톡·메일로 보내기: navigator.share(files) — 바로 / 활성 만료 시 [보내기] 한 번 더 / 공유 불가 시 내려받기로 바꾸고 그렇게 말한다 ──
    await guard('own-share', async () => {
      await page.evaluate(() => {
        window.__shared = []; window.__shareMode = 'ok';
        navigator.canShare = d => window.__shareMode !== 'nofiles' && !!(d && d.files && d.files.length);
        navigator.share = async d => { if (window.__shareMode === 'notallowed') { window.__shareMode = 'ok'; const e = new Error('activation'); e.name = 'NotAllowedError'; throw e; } const f = d.files[0]; window.__shared.push({ name: f.name, type: f.type, text: await f.text() }); };
      });
      const run = async () => { await page.locator('[data-a="backup-now"]').click(); await choiceTitle(page); await pick(page, 'share'); return choiceTitle(page); };   // beta.59: 암호는 기기가 기억 — 묻지 않는다
      let t = await run();
      let sh = await page.evaluate(() => window.__shared);
      await check(t === '카톡·메일로 잘 보냈나요?' && sh.length === 1 && /^밥장부백업_\d{4}-\d{2}-\d{2}\.txt$/.test(sh[0].name) && sh[0].type === 'text/plain' && JSON.parse(sh[0].text).type === 'prepaid-pass-backup',
        `sharing must hand a .txt text/plain locked file to navigator.share and then ask once whether it was sent (title ${JSON.stringify(t)}, shared ${JSON.stringify(sh.map(s => ({ name: s.name, type: s.type })))})`);
      const b0 = (await metaOf(page)).lastBackupAt;
      await pick(page, 'yes');
      await check((await metaOf(page)).lastBackupAt >= b0, 'answering 네, 보냈어요 records the own backup');
      await page.evaluate(() => { window.__shareMode = 'notallowed'; });
      t = await run();
      await check(t === '파일이 준비됐어요', `when the browser refuses (user activation expired) the app must offer a second [보내기] tap (got ${JSON.stringify(t)})`);
      await pick(page, 'send');
      t = await choiceTitle(page);
      sh = await page.evaluate(() => window.__shared);
      await check(t === '카톡·메일로 잘 보냈나요?' && sh.length === 2, 'the second tap must share the same file');
      await pick(page, 'no');
      await page.evaluate(() => { window.__shareMode = 'nofiles'; });
      const dl0 = A.downloads.length;
      t = await run();
      await check(t === '이 기기에서는 바로 보내기가 안 돼요' && A.downloads.length === dl0 + 1 && /\.txt$/.test(A.downloads[dl0].suggestedFilename()), `without file sharing the app must download the .txt and say so honestly (got ${JSON.stringify(t)})`);
      await pick(page, 'yes');
    });

    // ── ⑫ [백업 암호] 바꾸기 — 예전 파일은 예전 암호로 열린다고 말한다 ──
    await guard('pass-change', async () => {
      const v0 = (await metaOf(page)).backupPassCheck;
      await page.locator('[data-a="backup-pass"]').click();
      await page.waitForSelector('#keyPass2');
      await check((await page.locator('#keyPassTitle').innerText()).includes('백업 암호 바꾸기') && (await page.locator('.pass-modal').innerText()).includes('예전에 만든 백업 파일은 예전 암호로 열려요'), 'changing the backup password must explain that old files keep the old password');
      await page.locator('#keyPass1').fill('harness-pass-NEW'); await page.locator('#keyPass2').fill('harness-pass-NEW');
      await page.locator('[data-a="pass-ok"]').click();
      const t = await choiceTitle(page);
      await check(t.includes('새 백업 암호를 종이에 적어 주세요') && (await page.locator('.choice-modal #passWrite').innerText()).trim() === 'harness-pass-NEW' && (await choiceText(page)).includes('예전 암호로 열려요'), `the confirmation must show the new password to write down and repeat that old files open with the old password (got ${JSON.stringify(t)})`);
      await pick(page, 'ok');
      const v1 = (await metaOf(page)).backupPassCheck;
      await check(v1 && v1.hash !== v0.hash, 'the verifier must change');
    });

    // ── ⑬ 잠금 화면(PIN 분실 복구)에서 암호 건 파일로 되찾기 — 60초 게이트 → 암호 창·선택창이 잠금 중에도 눌린다 ──
    await guard('lock-restore', async () => {
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await page.locator('[data-a="hand-to-customer"]').click();
      await page.waitForSelector('[data-a="lock-to-pin"]');
      await page.locator('[data-a="lock-to-pin"]').click();
      await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 500 }));
      await page.locator('[data-a="pin-forgot"]').click();
      await page.waitForTimeout(900);
      const tmp = path.join(os.tmpdir(), 'b55c-pass-' + Date.now() + '.txt');
      await fsp.writeFile(tmp, JSON.stringify(passFile1));
      // beta.60: 파일을 고르기 전에 이 기기의 백업 암호(지금은 harness-pass-NEW)부터 확인한다. 예전 암호는 기기 확인을 통과하지 못한다.
      await page.locator('[data-a="pin-forgot-restore"]').click();
      await page.waitForSelector('#keyPass1', { timeout: 8000 });
      await check((await page.locator('#keyPassTitle').innerText()).includes('백업 암호로 확인해요'), 'beta.60: ② must ask for the device backup password before any file picker');
      await page.locator('#keyPass1').fill('harness-pass-01');
      await page.locator('[data-a="pass-ok"]').click();
      await page.waitForFunction(() => { const h = document.getElementById('keyPassHint'); return h && /맞지 않아요/.test(h.textContent); }, null, { timeout: 20000 });
      await page.locator('#keyPass1').fill('harness-pass-NEW');
      await page.locator('[data-a="pass-ok"]').click();
      await page.waitForSelector('.choice-modal [data-a="choice-pick"][data-val="pick"]', { timeout: 20000 });
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.choice-modal [data-a="choice-pick"][data-val="pick"]').click()]);
      await chooser.setFiles(tmp);
      // 이 파일은 예전 암호(harness-pass-01)로 잠겼다 — 방금 맞힌 암호로는 안 열리므로 파일 암호를 따로 묻는다.
      await page.waitForSelector('#keyPass1', { timeout: 8000 });
      await check(await page.evaluate(() => window.__prepaidTestHooks.lockState().locked) === true && (await page.locator('#keyPassTitle').innerText()).includes('백업 파일 암호'), 'the pass-backup password dialog must open on the locked recovery screen (.txt accepted)');
      await page.locator('#keyPass1').fill('harness-pass-NEW');
      await page.locator('[data-a="pass-ok"]').click();
      await page.waitForFunction(() => { const h = document.getElementById('keyPassHint'); return h && /암호가 맞지 않아요/.test(h.textContent); }, null, { timeout: 20000 });
      await page.locator('#keyPass1').fill('harness-pass-01');
      await page.locator('[data-a="pass-ok"]').click();
      const t = await choiceTitle(page);
      await check(t === '이 백업으로 되돌릴까요?' || t.includes('거래가 적은'), `the restore confirmation must appear while locked (got ${JSON.stringify(t)})`);
      const goVal = 'go';
      await pick(page, goVal);
      await choiceTitle(page); await pick(page, 'ok');
      const B = await readDb(page);
      const d = diffRecs(ledgerAtPass1.transactions, B.transactions, []);
      await check(d.length === 0, `restoring the pass-backup must bring back every transaction field INCLUDING signature images (${d.slice(0, 4).join(' | ')})`);
      await page.waitForSelector('[data-a="pin-key"]', { timeout: 8000 });
      await typePin(page, ['1', '2', '3', '4', '1', '2', '3', '4']);
      await awaitUnlocked(page);
      await fsp.unlink(tmp).catch(() => {});
    });

    // ═════ beta.55 A3(적대 검증)에서 찾아 고친 것 — 각 단언은 수정 전 코드에서 실패함을 확인했다 ═════
    const runCloud = () => page.evaluate(() => window.__prepaidTestHooks.cloudBackupRun({}).then(x => ({ ok: true, ...x }), e => ({ err: String(e && (e.code || e.message)) })));
    let a3Size = 3;
    // ── A3-1 같은 세대의 '열린' 마지막 조각을 다시 올린 뒤 머리 저장이 끊기면, 예전에는 서버 백업 전체가 '손상'으로 거절됐다(다음 성공까지 최대 1주).
    //    이제 머리가 말하는 건수만큼 앞부분을 잘라 확인값이 맞으면 **직전 백업(일관된 예전 장부)**을 그대로 되찾는다.
    await guard('a3-head-fail-keeps-old', async () => {
      const n0 = (await readDb(page)).transactions.length;
      a3Size = [3, 4, 5, 7].find(k => n0 % k !== 0);
      await page.evaluate(k => { window.__cloudSegSize = k; window.__cloudRetryWaitMs = 20; }, a3Size);
      const r0 = await runCloud();
      await check(r0.ok, `A3-1 baseline backup must succeed (got ${JSON.stringify(r0)})`);
      const db0 = await readDb(page); const last = Math.max(...db0.transactions.map(t => t.createdAt));
      await putAll(page, { transactions: [tx('a3-t1', db0.employees.find(e => !e.isDeleted).id, 'topup', 1000, 0, { createdAt: last + 1000 })] });
      await resealChain(page); await reloadUnlock(page);
      await page.evaluate(k => { window.__cloudSegSize = k; window.__cloudRetryWaitMs = 20; }, a3Size);
      relay.st.failHead = true; relay.st.log.length = 0;
      const r1 = await runCloud();
      relay.st.failHead = false;
      await check(!!r1.err && relay.st.log.some(e => e.t === 'seg') && relay.st.log.some(e => e.t === 'headfail'), `A3-1 setup: the open segment must be re-uploaded and then the head must fail (got ${JSON.stringify({ r1, log: relay.st.log.map(e => e.t) })})`);
      await goGuard(page); await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud');
      const t = await choiceTitle(page); const txt = await choiceText(page);
      await check(!/되찾지 못했어요/.test(t) && txt.includes(`백업 ${n0}건`), `A3-1 an interrupted incremental backup must leave the previous server backup restorable (${n0}건), never refuse it as corrupt (got ${JSON.stringify(t + ' / ' + txt.replace(/\s+/g, ' ').slice(0, 160))})`);
      await pick(page, /되찾지 못했어요/.test(t) ? 'ok' : 'cancel');
    });
    // ── A3-2 새 세대를 올리다 끊기면 다음 시도는 **같은 세대 번호**로 다시 올린다 — 예전엔 시도마다 새 세대라 고아 조각이 쌓여 가게당 1,000행 상한에 닿으면 영영 못 올렸다 ──
    await guard('a3-pending-gen', async () => {
      await page.evaluate(k => { window.__cloudSegSize = k; }, a3Size + 1);
      relay.st.log.length = 0;
      relay.st.segBudget = 1; const f1 = await runCloud();
      relay.st.segBudget = 1; const f2 = await runCloud();
      relay.st.segBudget = null;
      const gens = [...new Set(relay.st.log.filter(e => e.t === 'seg' || e.t === 'segfail').map(e => e.gen))];
      await check(!!f1.err && !!f2.err && gens.length === 1, `A3-2 two interrupted fresh uploads must reuse ONE pending gen (got ${JSON.stringify({ f1, f2, gens })})`);
      const ok = await runCloud();
      const head = relay.st.log.filter(e => e.t === 'head').pop();
      await check(ok.ok && head && head.gen === gens[0] && !(await page.evaluate(() => window.__prepaidTestHooks.cloudState())).pendingGen, `A3-2 the next successful run must finish that same gen and forget it (got ${JSON.stringify({ ok, head })})`);
    });
    // ── A3-3 등록된 가게인데 암호 건 내 보관 백업(열쇠 포함)을 한 번도 안 했으면 서버 백업이 '오늘'이어도 ✓가 아니다 — 상자·접힌 요약·홈 배너가 같은 문장 ──
    await guard('a3-key-honesty', async () => {
      const keep = (await metaOf(page)).myKeyBackedUpAt;
      await putAll(page, { meta: { myKeyBackedUpAt: null } }); await reloadUnlock(page);
      const gs = await page.evaluate(() => window.__prepaidTestHooks.guardStatus());
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await page.waitForSelector('.guard-banner', { timeout: 8000 });
      const bHead = (await page.locator('.guard-banner strong').innerText()).trim();
      await goGuard(page);
      const kicker = (await page.locator('.fold-head[data-card="ledger"] .section-kicker').innerText()).trim();
      const boxHead = (await page.locator('#guardState > b').innerText()).trim();
      await check(gs.cloudAt > 0 && /가게 열쇠가 이 기기에만/.test(boxHead) && !boxHead.includes('✓') && kicker === boxHead && bHead === boxHead,
        `A3-3 server-only + key never saved: box, folded summary and home banner must say the same key warning (box ${JSON.stringify(boxHead)}, kicker ${JSON.stringify(kicker)}, banner ${JSON.stringify(bHead)})`);
      await putAll(page, { meta: { myKeyBackedUpAt: keep || Date.now() } }); await reloadUnlock(page);
    });
    // ── A3-4 서버 자동 백업이 켜져 있는데 8일 넘게 못 올라갔으면(오프라인이라 실패 기록조차 없어도) ✓가 아니다 ──
    await guard('a3-cloud-stale', async () => {
      const cur = await metaOf(page); const fp = await page.evaluate(() => window.__prepaidTestHooks.ledgerFp()); const old = Date.now() - 25 * DAY;
      await putAll(page, { meta: { cloudBackupState: Object.assign({}, cur.cloudBackupState || {}, { lastOkAt: old, fp, failSince: 0, lastTryAt: 0 }), lastCloudBackupAt: old } });
      relay.st.log.length = 0; await reloadUnlock(page); await page.waitForTimeout(600);
      const gs = await page.evaluate(() => window.__prepaidTestHooks.guardStatus());
      await check(relay.st.log.length === 0 && gs.level === 'warn' && /서버 백업이 25일째 안 되고 있어요/.test(gs.head) && gs.banner && gs.banner.head === gs.head,
        `A3-4 a server backup 25 days old with newer transactions must be a warning (box = banner), not ✓ (got ${JSON.stringify({ head: gs.head, banner: gs.banner, log: relay.st.log.length })})`);
    });
    // ── A3-5 기기 시계가 미래로 갔다 온 기록(마지막 서버 백업 = 200일 뒤)은 믿지 않는다 — 예전엔 "오늘"로 보이고 주 1회 자동 백업이 그날까지 멈췄다 ──
    await guard('a3-clock-skew', async () => {
      const cur = await metaOf(page); const fut = Date.now() + 200 * DAY;
      await putAll(page, { meta: { cloudBackupState: Object.assign({}, cur.cloudBackupState || {}, { lastOkAt: fut, fp: 'stale', failSince: 0, lastTryAt: 0 }), lastCloudBackupAt: fut } });
      relay.st.log.length = 0; await reloadUnlock(page);
      await page.waitForFunction(() => { const s = window.__prepaidTestHooks.cloudState(); return s && s.lastOkAt > Date.now() - 60000 && s.lastOkAt < Date.now() + 60000; }, null, { timeout: 20000 }).catch(() => {});
      await check(relay.st.log.some(e => e.t === 'head'), `A3-5 a "last backup" stamped 200 days in the future must not stop the weekly automatic backup (log ${JSON.stringify(relay.st.log.map(e => e.t))})`);
    });

    await check(A.dialogs.filter(d => d.type === 'confirm' || d.type === 'prompt').length === 0, `no native confirm/prompt may appear in the backup/restore flows (got ${JSON.stringify(A.dialogs)})`);
    await check(relay.st.reused === 0 && relay.st.violations.length === 0, `the app must respect the relay contract (reused tokens ${relay.st.reused}, violations ${JSON.stringify(relay.st.violations)})`);

    // ── 화면 캡처(태블릿 가로 1024×768) ──
    if (SHOTS) {
      await page.setViewportSize({ width: 1024, height: 768 });
      await goGuard(page); await shot(page, 'card-normal-1024');
      await page.locator('[data-a="backup-now"]').click(); await choiceTitle(page); await shot(page, 'choice-3-1024');
      await pick(page, 'save'); await page.waitForSelector('#keyPass1'); await shot(page, 'pass-dialog-1024');
      await page.locator('[data-a="pass-cancel"]').click();
      await putAll(page, { transactions: [tx('c-t11', 'c-e1', 'topup', 500, 11)] }); await resealChain(page); await reloadUnlock(page);
      await goGuard(page); await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud'); await choiceTitle(page); await shot(page, 'restore-fewer-1024');
      await pick(page, 'cancel');
      await page.setViewportSize({ width: 390, height: 844 });
    }
  } finally { await A.ctx.close(); }

  // ═════════════════════ 기기 B: 새 태블릿 — 암호 건 파일 하나로 장부 + 가게 열쇠 ═════════════════════
  await guard('fresh-device', async () => {
    const B = await newCtx();
    try {
      await B.page.goto(url, { waitUntil: 'load' });
      await B.page.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 });
      // beta.55(A3) → beta.57: 새 태블릿의 입구 — [시작하기] → [직접 입력할게요] 화면의 글씨 링크 "예전 장부가 있어요 — 백업 파일로 되찾기"가 곧바로 파일 고르기를 연다.
      const pubB0 = (await metaOf(B.page)).pubKey;
      const tmpB = path.join(os.tmpdir(), 'b55c-fresh-' + Date.now() + '.txt');
      await fsp.writeFile(tmpB, JSON.stringify(passFile1));
      await B.page.locator('[data-a="setup-welcome-start"]').click(); await B.page.waitForSelector('#setupStoreName'); await B.page.locator('[data-a="setup-manual-toggle"]').click(); await B.page.waitForSelector('#setupManualName');
      const [chooserB] = await Promise.all([B.page.waitForEvent('filechooser', { timeout: 8000 }), B.page.locator('.setup [data-a="welcome-restore"]').click()]);
      await chooserB.setFiles(tmpB);
      await fsp.unlink(tmpB).catch(() => {});
      await B.page.waitForSelector('#keyPass1', { timeout: 8000 });
      await B.page.locator('#keyPass1').fill('nope-nope-1');
      await B.page.locator('[data-a="pass-ok"]').click();
      await B.page.waitForFunction(() => { const h = document.getElementById('keyPassHint'); return h && /암호가 맞지 않아요/.test(h.textContent); }, null, { timeout: 20000 });
      await B.page.locator('#keyPass1').fill('harness-pass-01');
      await B.page.locator('[data-a="pass-ok"]').click();
      const t = await choiceTitle(B.page); const txt = await choiceText(B.page);
      await check(t === '이 백업으로 되돌릴까요?' && txt.includes('지금 0건') && txt.includes('가게 열쇠도 파일에서 함께 가져와요'), `a fresh tablet must show 0건 → M건 and that the key comes along (got ${JSON.stringify(txt.slice(0, 300))})`);
      await pick(B.page, 'go');
      const t2 = await choiceTitle(B.page);
      await check(t2 === '되찾기를 마쳤어요' && (await choiceText(B.page)).includes('가게 열쇠도 함께 가져왔어요') && B.downloads.length === 0, 'a fresh tablet has nothing to snapshot and must report the imported key');
      await check((await choiceText(B.page)).includes('숫자 비밀번호 4자리'), 'after restoring on a fresh tablet the result must say the next step is setting a new 4-digit screen PIN');
      await pick(B.page, 'ok');
      await B.page.waitForSelector('[data-a="pin-key"]', { timeout: 8000 });
      await typePin(B.page, ['1', '2', '3', '4', '1', '2', '3', '4']);
      await awaitUnlocked(B.page);
      const m = await metaOf(B.page); const db = await readDb(B.page);
      await check(m.pubKey === pubA && m.pubKey !== pubB0 && m.privKeyWrapped && m.restaurantId === RID && m.backupPassCheck && m.backupPassCheck.it === 600000 && m.myKeyBackedUpAt > 0,
        'the pass-backup must bring the shop key (same public key), the registration and a backup-password verifier to the new tablet');
      const d1 = diffRecs(ledgerAtPass1.transactions, db.transactions, []);
      await check(d1.length === 0, `the new tablet's transactions must equal the original field by field incl. signatures (${d1.slice(0, 4).join(' | ')})`);
      await check(diffRecs(ledgerAtPass1.employees, db.employees, []).length === 0, 'the new tablet\'s employees must equal the original');
      const ch = await hookChain(B.page);
      await check(ch.ok && ch.broken === 0, `the restored ledger must verify on the new tablet (got ${JSON.stringify(ch)})`);
      // 가져온 열쇠로 서버 백업을 실제로 열 수 있다(소유 증명 + 복호)
      await goGuard(B.page);
      await B.page.locator('[data-a="guard-restore"]').click(); await choiceTitle(B.page); await pick(B.page, 'cloud');
      const t3 = await choiceTitle(B.page);
      await check(t3 === '이 백업으로 되돌릴까요?' || t3.includes('거래가 적은'), `the imported key must open the server backup on the new tablet (got ${JSON.stringify(t3)})`);
      await pick(B.page, 'cancel');
      await check(B.dialogs.filter(d => d.type !== 'beforeunload').length === 0, `no native dialogs on the new tablet (got ${JSON.stringify(B.dialogs)})`);
    } finally { await B.ctx.close(); }
  });

  // ═════ A3: PIN 분실 복구 화면(비밀번호를 모르는 사람도 60초 뒤 닿는다)에서 '남의' 암호 건 파일을 고르면,
  //   예전에는 지금 장부 + 이 가게 열쇠가 **그 사람의 암호**로 잠긴 사본으로 다운로드됐다(다른 기기에서 그 암호로 열림 — 실증).
  //   이제 그 경로의 안전 사본은 이 기기 열쇠로 잠근 파일(prepaid-locked-backup)이다(사장님 백업 암호와 같을 때만 암호 건 사본). ═════
  await guard('a3-forgotpin-foreign-file', async () => {
    const zlib = require('zlib');
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pubKey = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pkcs8 = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const core = JSON.parse(fs.readFileSync(path.join(FIX, 'beta54-plain.json'), 'utf8'));
    const pass = 'foreign-pass-9';
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const k = crypto.pbkdf2Sync(pass, salt, 600000, 32, 'sha256');
    const plain = zlib.gzipSync(Buffer.from(JSON.stringify({ core, key: { pubKey, pkcs8 } }), 'utf8'));
    const c = crypto.createCipheriv('aes-256-gcm', k, iv); const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const file = { type: 'prepaid-pass-backup', v: 1, appName: '선입금대장', appVersion: 'harness', exportedAt: Date.now(), z: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', it: 600000, salt: salt.toString('base64') }, iv: iv.toString('base64'), ct: ct.toString('base64') };
    const D = await newCtx(); const p = D.page;
    const tmp = path.join(os.tmpdir(), 'b55c-foreign-' + Date.now() + '.txt');
    try {
      await p.goto(url, { waitUntil: 'load' }); await p.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 }); await p.waitForTimeout(200);
      const now = Date.now();
      // beta.60: 백업 암호를 정해 둔 가게라야 복구 화면에 ②가 있다(없으면 ③뿐 — beta60a가 따로 지킨다). 사장님 암호 owner-pass-60을 심는다.
      const vsalt = crypto.randomBytes(16);
      const ownerCheck = { v: 1, it: 600000, salt: vsalt.toString('base64'), hash: crypto.pbkdf2Sync('owner-pass-60', vsalt, 600000, 32, 'sha256').toString('hex') };
      await putAll(p, { meta: { setupComplete: true, welcomeSeen: true, termsAgreedAt: now, pinHash: legacyPin, shopName: '피해식당', departments: ['총무과'], backupPassCheck: ownerCheck },
        employees: [emp('v-e1', '정피해', '총무과')], transactions: [tx('v-t1', 'v-e1', 'open', 30000, 1), tx('v-t2', 'v-e1', 'use', 9000, 2, { signatureData: SIG })] });
      await resealChain(p);
      await p.reload({ waitUntil: 'load' });
      await p.waitForSelector('[data-a="lock-to-pin"]', { timeout: 15000 }); await p.locator('[data-a="lock-to-pin"]').click();
      await p.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 500 }));
      await p.locator('[data-a="pin-forgot"]').click(); await p.waitForTimeout(900);
      await fsp.writeFile(tmp, JSON.stringify(file));
      const chooser = await recoveryFileChooser(p, 'owner-pass-60');
      await chooser.setFiles(tmp);
      await p.waitForSelector('#keyPass1', { timeout: 8000 }); await p.locator('#keyPass1').fill(pass); await p.locator('[data-a="pass-ok"]').click();
      let t = await choiceTitle(p);
      if (/다른 가게 열쇠/.test(t)) { await pick(p, 'replace'); t = await choiceTitle(p); }
      const n0 = D.downloads.length; await pick(p, 'go'); await choiceTitle(p);
      const d = await waitDl(D.downloads, n0 + 1, 10000);
      const snap = d ? await dlJson(d) : null;
      await check(!!snap && snap.type === 'prepaid-locked-backup' && !/정피해/.test(JSON.stringify(snap)),
        `A3 forgot-PIN restore of a foreign pass file must NOT hand the current ledger + shop key over in a file locked with the file's password (got ${JSON.stringify(snap && { type: snap.type, name: d.suggestedFilename() })})`);
      await pick(p, 'ok');
    } finally { await fsp.unlink(tmp).catch(() => {}); await D.ctx.close(); }
  });

  // ═════ A3: 새 태블릿(미등록)에서 **열쇠 없는** 파일(등록된 가게의 평문 백업)로 되찾으면 등록 정보는 파일에서 오지만 열쇠는 이 기기 것이다.
  //   그 파일의 '서버 백업 시각'·'열쇠 보관 시각'은 다른 열쇠의 기록 — 들여오면 상태가 "✓ 서버 1일 전"이고 자동 백업(=열쇠가 다르다는 걸
  //   화면에 올려 줄 유일한 시도)도 한 주 동안 멈췄다. 이제 이 기기 값으로 두고, 잠금을 풀면 곧바로 시도해 실패를 상자에 올린다. ═════
  await guard('a3-plain-file-other-key', async () => {
    const plainFx = JSON.parse(fs.readFileSync(path.join(FIX, 'beta54-plain.json'), 'utf8'));
    const day1 = Date.now() - DAY;
    plainFx.payload.meta.lastCloudBackupAt = day1; plainFx.payload.meta.myKeyBackedUpAt = day1; plainFx.payload.meta.lastBackupAt = day1; delete plainFx.checksum;
    const E = await newCtx(); const p = E.page;
    const tmp = path.join(os.tmpdir(), 'b55c-plainkey-' + Date.now() + '.json');
    try {
      await p.goto(url, { waitUntil: 'load' }); await p.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 }); await p.waitForTimeout(200);
      await fsp.writeFile(tmp, JSON.stringify(plainFx));
      await p.locator('[data-a="setup-welcome-start"]').click(); await p.waitForSelector('#setupStoreName'); await p.locator('[data-a="setup-manual-toggle"]').click(); await p.waitForSelector('#setupManualName');
      const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.locator('[data-a="welcome-restore"]').click()]);
      await chooser.setFiles(tmp);
      await choiceTitle(p); await pick(p, 'go');
      const txt = await choiceText(p);
      await check(txt.includes('이 파일에는 가게 열쇠가 없어요'), `A3 the result must tell the owner this file carries no shop key (got ${JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 200))})`);
      await pick(p, 'ok');
      await p.waitForSelector('[data-a="pin-key"]', { timeout: 8000 });
      relay.st.log.length = 0;
      await typePin(p, ['1', '2', '3', '4', '1', '2', '3', '4']); await awaitUnlocked(p);
      await p.waitForFunction(() => { const s = window.__prepaidTestHooks.cloudState(); return s && s.failSince > 0; }, null, { timeout: 15000 }).catch(() => {});
      const m = await metaOf(p); const gs = await p.evaluate(() => window.__prepaidTestHooks.guardStatus());
      await check(m.restaurantId === 'rid-fix54' && m.lastCloudBackupAt !== day1 && m.myKeyBackedUpAt !== day1 && gs.level === 'warn' && !gs.head.includes('✓'),
        `A3 another key's backup stamps must not be imported, and the status must not claim safety (got ${JSON.stringify({ lastCloud: m.lastCloudBackupAt, myKey: m.myKeyBackedUpAt, head: gs.head })})`);
    } finally { await fsp.unlink(tmp).catch(() => {}); await E.ctx.close(); }
  });

  // ═════════════════════ 기기 C: 미등록 가게 + 예전 형식 파일(수정 전 앱이 만든 픽스처) ═════════════════════
  await guard('unregistered-and-legacy', async () => {
    const C = await newCtx();
    const p = C.page;
    try {
      const fx = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
      const plainFx = fx('beta54-plain.json'), keyFx = fx('beta54-key.json'), lockedFx = fx('beta54-locked.json'), cloudFx = fx('beta54-cloud-v1.json'), fxMeta = fx('beta54-fixtures.meta.json');
      await p.goto(url, { waitUntil: 'load' }); await p.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 }); await p.waitForTimeout(200);
      const now = Date.now();
      await putAll(p, { meta: { setupComplete: true, welcomeSeen: true, termsAgreedAt: now, pinHash: legacyPin, shopName: '미등록식당', departments: ['총무과'], storeRegisterPending: true },
        employees: [emp('u-e1', '최미등', '총무과')], transactions: [tx('u-t1', 'u-e1', 'open', 20000, 1), tx('u-t2', 'u-e1', 'use', 9000, 2, { signatureData: SIG })] });
      await resealChain(p);
      await reloadUnlock(p);
      relay.st.log.length = 0;
      await goGuard(p);
      const box = await p.locator('#guardState').innerText();
      await check(!box.includes('서버 자동 백업') && box.includes('가게를 등록하면 서버에도 자동 보관돼요') && (await p.locator('[data-a="toggle-auto-cloud"]').count()) === 0 && (await p.locator('[data-a="cloud-backup-delete"]').count()) === 0 && (await p.locator('.settings-card [disabled]').count()) === 0,
        `an unregistered shop must see one reason line instead of the server row, no server links and no grey disabled buttons (got ${JSON.stringify(box)})`);
      await shot(p, 'card-unregistered-390');
      await p.locator('[data-a="backup-now"]').click();
      const t = await choiceTitle(p);
      const vals = await p.$$eval('.choice-modal [data-a="choice-pick"]', bs => bs.map(b => b.dataset.val + ':' + b.innerText.replace(/\s+/g, ' ').trim()));
      await check(t === '내 보관용 백업을 남겨요' && vals.length === 3 && vals[2] === 'none:취소' && relay.st.log.length === 0, `an unregistered shop gets only the two own-copy choices and no server call (got ${JSON.stringify({ t, vals, log: relay.st.log })})`);
      await pick(p, 'none');
      await p.locator('[data-a="guard-restore"]').click(); await choiceTitle(p);
      await check((await p.locator('.choice-modal [data-val="cloud"]').count()) === 0, 'an unregistered shop is not offered 서버에서 되찾기');
      await pick(p, 'cancel');
      // 예전 '내 열쇠 백업' 파일(12만 회) — 다른 열쇠가 이미 있고 거래가 있으므로 묻는다
      await p.locator('#restoreFile').setInputFiles({ name: 'beta54-key.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(keyFx), 'utf8') });
      await p.waitForSelector('#keyPass1', { timeout: 8000 });
      await p.locator('#keyPass1').fill(fxMeta.pass);
      await p.locator('[data-a="pass-ok"]').click();
      await choiceTitle(p); await pick(p, 'replace');
      await p.waitForFunction(pk => new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('pubKey'); q.onsuccess = () => res(q.result && q.result.value === pk); }; }), keyFx.pubKey, { timeout: 15000 });
      // 예전 잠긴 백업 → 그 열쇠로 열린다
      const dl0 = C.downloads.length;
      await p.locator('#restoreFile').setInputFiles({ name: 'beta54-locked.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(lockedFx), 'utf8') });
      await choiceTitle(p); await pick(p, 'go'); await choiceTitle(p); await pick(p, 'ok');
      let db = await readDb(p);
      let d = diffRecs(plainFx.payload.transactions, db.transactions, []);
      await check(d.length === 0 && db.transactions.length === fxMeta.transactions, `a beta.54 locked backup must restore every transaction field (${d.slice(0, 4).join(' | ')})`);
      await check(C.downloads.length === dl0 + 1, 'restoring over a non-empty ledger must download a safety snapshot first');
      // 예전 평문 백업
      await p.locator('#restoreFile').setInputFiles({ name: 'beta54-plain.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plainFx), 'utf8') });
      await choiceTitle(p); await pick(p, 'go'); await choiceTitle(p); await pick(p, 'ok');
      db = await readDb(p);
      d = diffRecs(plainFx.payload.transactions, db.transactions, []);
      await check(d.length === 0 && diffRecs(plainFx.payload.employees, db.employees, []).length === 0, `a beta.54 plain backup must restore field by field (${d.slice(0, 4).join(' | ')})`);
      // 등록된 기기에서 등록 전에 만든 옛 백업을 되돌려도 이 기기의 가게 등록(열쇠에 묶여 있다)은 조용히 사라지지 않는다(A-2).
      {
        const before = await metaOf(p);
        const older = JSON.parse(JSON.stringify(plainFx));
        ['restaurantId', 'relayRegisteredAt', 'relayStoreName', 'storeAddr', 'districtSyncedAt'].forEach(k => { delete older.payload.meta[k]; });
        delete older.checksum;
        await p.locator('#restoreFile').setInputFiles({ name: 'older.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(older), 'utf8') });
        await choiceTitle(p); await pick(p, 'go'); await choiceTitle(p); await pick(p, 'ok');
        const after = await metaOf(p);
        await check(before.restaurantId === fxMeta.restaurant_id && after.restaurantId === before.restaurantId && after.relayRegisteredAt === before.relayRegisteredAt && after.pubKey === before.pubKey,
          `restoring an older backup without registration must keep this device's registration and key (before ${before.restaurantId}, after ${after.restaurantId})`);
      }
      // 예전 서버 v1 blob(서명 그림 포함)
      relay.st.reg.set(cloudFx.restaurant_id, cloudFx.pubKey);
      relay.st.head.set(cloudFx.restaurant_id, { blob: cloudFx.blob, blob_hash: cloudFx.blob_hash, updated_at: cloudFx.updated_at, gen: null });
      // 고정 자료(fixture)의 '마지막 서버 백업'은 만든 날(2026-11-13)에 묶여 있다. 그날로부터 7일이 지나면 잠금을 푸는 순간 주 1회 자동 백업이
      //   돌아, 방금 목 서버에 놓은 예전 v1 사본을 새 형식(서명 그림 제외)으로 바꿔 버린다 — 이 검사가 2026-11-21부터 날짜만으로 실패했다.
      //   '방금 서버 백업을 한 기기'로 맞춰 자동 백업이 끼어들지 않게 한다(검사하려는 것은 v1 사본을 그대로 되찾는 길이다).
      await p.evaluate(t => new Promise((resolve, reject) => { const req = indexedDB.open('prepaid-ledger-db'); req.onerror = () => reject(req.error);
        req.onsuccess = () => { const tx = req.result.transaction(['meta'], 'readwrite'); tx.objectStore('meta').put({ key: 'lastCloudBackupAt', value: t }); tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error); }; }), Date.now());
      await p.reload({ waitUntil: 'load' }); await unlockPin(p); await awaitUnlocked(p);
      await goGuard(p);
      await p.locator('[data-a="guard-restore"]').click(); await choiceTitle(p); await pick(p, 'cloud');
      await choiceTitle(p); await pick(p, 'go'); await choiceTitle(p); await pick(p, 'ok');
      db = await readDb(p);
      d = diffRecs(plainFx.payload.transactions, db.transactions, []);
      await check(d.length === 0, `a beta.54 server v1 blob must restore field by field, signatures included (${d.slice(0, 4).join(' | ')})`);
      const ch = await hookChain(p);
      await check(ch.tamperOk && ch.broken === 0, `legacy restores must keep the chain verifiable (got ${JSON.stringify(ch)})`);
      await check(C.dialogs.length === 0, `no native dialogs in the legacy restore flows (got ${JSON.stringify(C.dialogs)})`);
    } finally { await C.ctx.close(); }
  });

  console.log(`beta.55 A2 검증: ${passed} 통과, ${fails.length} 실패`);
  if (fails.length) console.log(JSON.stringify(fails, null, 2));
  return { passed, fails };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// beta.60 A1 — 화면잠금 비밀번호 분실 복구(결정 1 가·가-1, 지금 1, 앱 2번). E2E_ONLY=beta60a 로 이 블록만, E2E_SOFT=1 로 단언별 실패 목록.
//   ① 백업 암호로 비밀번호 다시 정하기 ② 백업 파일로 되찾기(먼저 같은 백업 암호) ③ 전부 지우고 새로 시작(60초 게이트).
//   닫은 길: "③ 초기화 → 잠긴 파일 받기 → 마지막 확인 [취소] → 복구 화면에서 그 파일로 복원 → 새 비밀번호"(비밀번호·백업 암호 없이 장부 열기).
//   각 단언은 수정 전 코드(beta.59 HEAD)에서 실패함을 확인했다.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
async function runBeta60a(browser, url, cors) {
  const os = require('os');
  const zlib = require('zlib');
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.60a] ' + msg);
  };
  const guard = async (label, fn) => {
    if (process.env.E2E_VERBOSE) console.log('  · ' + label);
    try { await fn(); } catch (err) { if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 300)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 300)}`); }
  };
  const PASS = 'b60-pass-OK1';
  const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
  const DAY = 86400000, T0 = Date.now() - 5 * DAY;
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
  const FIX = path.join(__dirname, 'fixtures');
  // 앱의 passVerifierMake와 같은 모양(PBKDF2-SHA256 60만 회, 32바이트, 16진수) — 기기에 "백업 암호를 정해 둔 상태"를 심는다.
  const mkVerifier = pass => { const salt = crypto.randomBytes(16); return { v: 1, it: 600000, salt: salt.toString('base64'), hash: crypto.pbkdf2Sync(pass, salt, 600000, 32, 'sha256').toString('hex') }; };
  const emp = (id, name, dept) => ({ id, org: '광진구청', orgKind: 'public', dept, name, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: T0, updatedAt: T0 });
  const tx = (id, e, type, amount, k, extra) => Object.assign({ id, employeeId: e, type, amount, beforeBalance: 0, afterBalance: 0, reason: type === 'use' ? '서명 확인' : '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', hv: 2, txHash: '', prevHash: '', createdAt: T0 + k * 60000, occurredAt: 0 }, extra || {});
  const putAll = (page, o) => page.evaluate(o2 => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result; const t = db.transaction(['meta', 'employees', 'transactions'], 'readwrite');
      Object.entries(o2.meta || {}).forEach(([k, v]) => t.objectStore('meta').put({ key: k, value: v }));
      (o2.employees || []).forEach(e => t.objectStore('employees').put(e));
      (o2.transactions || []).forEach(x => t.objectStore('transactions').put(x));
      t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error);
    };
  }), o);
  const metaOf = async page => (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
  const lockState = page => page.evaluate(() => window.__prepaidTestHooks.lockState());
  const choiceTitle = async page => { await page.waitForSelector('#choiceTitle', { timeout: 20000 }); return (await page.locator('#choiceTitle').innerText()).trim(); };
  const pick = async (page, val) => { await page.locator(`.choice-modal [data-a="choice-pick"][data-val="${val}"]`).click(); await page.waitForTimeout(150); };
  const passHint = async page => (await page.locator('#keyPassHint').innerText().catch(() => ''));
  const ledgerSig = db => JSON.stringify({ e: db.employees.map(e => e.id + ':' + e.name).sort(), t: db.transactions.map(t => t.id + ':' + t.amount).sort() });
  const setTimers = (page, t) => page.evaluate(t2 => Object.assign(window.__prepaidTestHooks.TIMERS, t2), t);
  const newCtx = async () => {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
    await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
    const page = await ctx.newPage();
    const D = { ctx, page, dialogs: [], downloads: [], problems: [], decide: null };
    page.on('dialog', async d => { D.dialogs.push({ type: d.type(), message: d.message() }); const ok = D.decide ? D.decide(d.message(), d.type()) : false; if (ok) await d.accept().catch(() => {}); else await d.dismiss().catch(() => {}); });
    page.on('download', d => D.downloads.push(d));
    page.on('pageerror', e => D.problems.push(String(e && e.message || e)));
    return D;
  };
  const seed = async (D, opts) => {
    const p = D.page;
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 });
    await p.waitForTimeout(200);
    const meta = { setupComplete: true, welcomeSeen: true, termsAgreedAt: Date.now(), pinHash: legacyPin, shopName: '잠금식당', departments: ['총무과'] };
    if (opts.pass) meta.backupPassCheck = mkVerifier(opts.pass);
    await putAll(p, opts.empty ? { meta } : { meta, employees: [emp('a-e1', '김잠금', '총무과'), emp('a-e2', '이복구', '총무과')],
      transactions: [tx('a-t1', 'a-e1', 'open', 50000, 1), tx('a-t2', 'a-e2', 'open', 30000, 2), tx('a-t3', 'a-e1', 'use', 9000, 3, { signatureData: SIG })] });
    if (!opts.empty) await resealChain(p);
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('.cust-screen', { timeout: 15000 });
  };
  const toRecovery = async p => {
    if (await p.locator('[data-a="lock-to-pin"]').count()) { await p.locator('[data-a="lock-to-pin"]').click(); }
    await p.waitForSelector('[data-a="pin-forgot"]', { timeout: 8000 });
    await p.locator('[data-a="pin-forgot"]').click();
    await p.waitForSelector('.pin-recovery [data-a="pin-reset"]', { timeout: 8000 });
  };
  const enterPass = async (p, pass) => { await p.waitForSelector('#keyPass1', { timeout: 8000 }); await p.locator('#keyPass1').fill(pass); await p.locator('[data-a="pass-ok"]').click(); };
  const waitWrongHint = (p, n) => p.waitForFunction(n2 => { const h = document.getElementById('keyPassHint'); return h && h.textContent.includes('맞지 않아요') && h.textContent.includes('(' + n2 + '번'); }, n, { timeout: 20000 });
  const inject = (p, action) => p.evaluate(a => { const b = document.createElement('button'); b.dataset.a = a; b.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px'; document.body.appendChild(b); b.click(); b.remove(); }, action);
  const lockedFileText = async D => { const d = D.downloads[D.downloads.length - 1]; return { name: d.suggestedFilename(), raw: await fsp.readFile(await d.path(), 'utf8') }; };

  // ═════ 기기 A: 백업 암호를 정해 둔 가게 ═════
  const A = await newCtx();
  const p = A.page;
  let lockedFile = null;
  try {
    await seed(A, { pass: PASS });
    const db0 = await readDb(p);
    const pub0 = (await metaOf(p)).pubKey;

    // ── 1. 화면: ①②③ 순서·이름·안내, 60초 게이트는 ③에만 ──
    await guard('screen', async () => {
      await toRecovery(p);
      const acts = await p.locator('.pin-recovery .section-actions [data-a]').evaluateAll(els => els.map(e => e.dataset.a));
      await check(JSON.stringify(acts) === JSON.stringify(['pin-recover-pass', 'pin-forgot-restore', 'pin-reset']), `with a backup password the recovery screen must offer ①②③ in this order (got ${JSON.stringify(acts)})`);
      const txt = await p.locator('.pin-recovery').innerText();
      await check(txt.includes('비밀번호를 잊으셨나요?') && txt.includes('백업 암호로 비밀번호 다시 정하기') && txt.includes('장부는 그대로예요') && txt.includes('백업 파일로 되찾기') && txt.includes('파일을 열 때도 백업 암호를 넣어요') && txt.includes('전부 지우고 새로 시작') && txt.includes('백업 암호도 파일도 없을 때만'),
        `the recovery screen must use the agreed labels (got ${JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 300))})`);
      await check(!txt.includes('PIN만 따로') && !txt.includes('PIN을 잊으셨나요'), 'the old wording must be gone from the recovery screen');
      await check(await p.locator('.pin-recovery .btn-primary[data-a="pin-recover-pass"]').count() === 1 && await p.locator('.pin-recovery .btn-primary').count() === 1 && await p.locator('.pin-recovery .btn-danger').count() === 0, 'only ① may be a dark button (③ is outlined while the backup-password route exists)');
      await check(await p.locator('[data-a="pin-reset"]').isDisabled() && (await p.locator('.rec-gate').innerText()).includes('잘못 누름 방지'), 'the 60s mis-tap gate must still hold ③ and say why');
      await check(!(await p.locator('[data-a="pin-recover-pass"]').isDisabled()) && !(await p.locator('[data-a="pin-forgot-restore"]').isDisabled()), '①② need the backup password, so they are not held behind the 60s gate');
      await check((await p.evaluate(() => window.__prepaidTestHooks.lockAllowed())).filter(a => ['pin-recover-pass', 'pin-newpin-cancel'].includes(a)).length === 2, 'LOCK_ALLOWED must include the new recovery actions');
      await p.locator('[data-a="pin-forgot-cancel"]').click();
    });

    // ── 2. 닫은 길: ③ 초기화 → 잠긴 파일 → [취소] → ② 그 파일 — 이제 백업 암호 없이는 파일 창조차 열리지 않는다 ──
    await guard('hole-closed', async () => {
      await setTimers(p, { recoveryGate: 300 });
      await toRecovery(p);
      await p.waitForTimeout(600);
      const n0 = A.downloads.length, d0 = A.dialogs.length;
      A.decide = msg => !msg.includes('정말 지울까요');
      await p.locator('[data-a="pin-reset"]').click();
      for (let i = 0; i < 50 && A.downloads.length < n0 + 1; i += 1) await p.waitForTimeout(100);
      await p.waitForTimeout(400);
      A.decide = null;
      await check(A.downloads.length === n0 + 1, `③ must still save the locked final backup before asking (got ${A.downloads.length - n0})`);
      lockedFile = await lockedFileText(A);
      const conf = A.dialogs.slice(d0).filter(d => d.type === 'confirm');
      await check(conf.length === 2 && conf[0].message.includes('백업 암호를 알면') && !conf[0].message.includes('PIN만 따로'), `the first ③ confirm must point to ① honestly (got ${JSON.stringify(conf.map(c => c.message.slice(0, 80)))})`);
      await check(conf.length === 2 && conf[1].message.includes('없으면 되살릴 수 없어요') && conf[1].message.includes('암호 건 백업 파일') && !conf[1].message.includes('나중에 되살릴 수 있어요'), `the last ③ confirm must not promise the locked file can be opened later (got ${JSON.stringify(conf[1] && conf[1].message)})`);
      await check(ledgerSig(await readDb(p)) === ledgerSig(db0), 'cancelling ③ must leave the ledger');
      // 예전에는 여기서 [① 백업 파일로 복구] → 파일 창 → 방금 받은 잠긴 파일 → 새 비밀번호 → 장부 그대로였다.
      const chooserP = p.waitForEvent('filechooser', { timeout: 1500 }).catch(() => null);
      await p.locator('[data-a="pin-forgot-restore"]').click();
      const chooser = await chooserP;
      await check(chooser === null, 'tapping ② must NOT open a file picker before the backup password is checked');
      await check(await p.locator('#keyPass1').count() === 1 && (await p.locator('#keyPassTitle').innerText()).includes('백업 암호로 확인해요') && await p.locator('#keyPass2').count() === 0, '② must first ask for the backup password (one field) in the in-app box');
      await check((await lockState(p)).allowLockedRestore === false, 'the locked-restore permission must not be granted before the password is checked');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(200);
      // 숨은 파일 칸을 직접 채워도(파일 창 우회) 잠금 중에는 아무 일도 없다.
      await p.locator('#restoreFile').setInputFiles({ name: lockedFile.name, mimeType: 'application/json', buffer: Buffer.from(lockedFile.raw, 'utf8') });
      await p.waitForTimeout(800);
      await check(await p.locator('#choiceTitle').count() === 0 && (await lockState(p)).locked === true, 'feeding the locked file straight into the hidden input must not start a restore while locked');
      await check(ledgerSig(await readDb(p)) === ledgerSig(db0) && (await metaOf(p)).pinHash, 'the ledger and the old PIN must stay after the blocked attempt');
      await p.locator('[data-a="pin-forgot-cancel"]').click().catch(() => {});
    });

    // ── 3. 백업 암호 오답은 화면잠금 오답과 같은 지연(5번 → 기다림, meta 영속)에 합산된다 ──
    await guard('shared-delay', async () => {
      await setTimers(p, { pinDelay: 5000 });
      if (await p.locator('[data-a="lock-to-pin"]').count()) await p.locator('[data-a="lock-to-pin"]').click();
      await p.waitForSelector('[data-a="pin-key"]');
      await typePin(p, ['9', '9', '9', '9', '9', '9', '9', '9']);
      await check((await lockState(p)).pinFails === 2, 'two wrong PINs first');
      await p.locator('[data-a="pin-forgot"]').click();
      await p.locator('[data-a="pin-recover-pass"]').click();
      await enterPass(p, 'nope-nope-1');
      await waitWrongHint(p, 3);
      await check(await p.locator('#keyPass1').count() === 1, 'a wrong backup password must ask again in the same box');
      await check(Number((await metaOf(p)).pinFails) === 3, 'a wrong backup password must be counted in the persisted PIN failure counter');
      await p.locator('#keyPass1').fill('nope-nope-2'); await p.locator('[data-a="pass-ok"]').click();
      await waitWrongHint(p, 4);
      await p.locator('#keyPass1').fill('nope-nope-3'); await p.locator('[data-a="pass-ok"]').click();
      await p.waitForSelector('.rec-delay', { timeout: 20000 });
      const m = await metaOf(p);
      await check(Number(m.pinFails) === 5 && Number(m.pinDelayUntil) > Date.now(), `the fifth failure (PIN + backup password together) must start the persisted delay (got ${JSON.stringify({ f: m.pinFails, u: m.pinDelayUntil })})`);
      await check(await p.locator('#keyPass1').count() === 0 && await p.locator('[data-a="pin-recover-pass"]').count() === 0 && await p.locator('[data-a="pin-forgot-restore"]').count() === 0 && (await p.locator('.rec-delay').innerText()).includes('5번'), 'during the delay ①② must give way to the remaining seconds');
      await p.locator('[data-a="pin-forgot-cancel"]').click();
      await check(await p.locator('[data-a="pin-key"][data-key="1"]').isDisabled(), 'the PIN pad must share the same delay');
      await p.locator('[data-a="pin-forgot"]').click();
      await p.waitForSelector('[data-a="pin-recover-pass"]', { timeout: 9000 });
      await check(true, 'the recovery buttons come back when the delay ends');
      await setTimers(p, { pinDelay: 60000 });
    });

    // ── 4. ① 맞는 백업 암호 → 장부·열쇠 그대로, 새 비밀번호만 ──
    await guard('reset-pin', async () => {
      if (!(await p.locator('[data-a="pin-recover-pass"]').count())) await toRecovery(p);
      await p.locator('[data-a="pin-recover-pass"]').click();
      await enterPass(p, PASS + ' ');
      await p.waitForSelector('.pin-main [data-a="pin-key"]', { timeout: 20000 });
      const title = (await p.locator('.pin-title').innerText()).trim();
      await check(title === '새 비밀번호 정하기' && (await p.locator('.pin-sub').innerText()).includes('장부는 그대로'), `a correct backup password must lead straight to setting a new PIN (got ${JSON.stringify(title)})`);
      const ls = await lockState(p);
      await check(ls.locked === true && ls.pinMode === 'reset' && ls.pinFails === 0, `the reset step must stay locked and clear the failure counter (got ${JSON.stringify({ l: ls.locked, m: ls.pinMode, f: ls.pinFails })})`);
      await check(Number((await metaOf(p)).pinFails) === 0, 'the failure counter must be cleared in meta too');
      // 그만두기 → 아무것도 바뀌지 않는다(예전 비밀번호 그대로)
      await p.locator('[data-a="pin-newpin-cancel"]').click();
      await p.waitForSelector('.cust-screen');
      await check((await lockState(p)).pinMode === '', '[그만두기] must drop the reset step');
      await unlockPin(p);
      await p.waitForFunction(() => window.__prepaidTestHooks.lockState().locked === false, null, { timeout: 20000 });
      await check(true, 'after [그만두기] the old PIN still opens the app');
      await p.locator('[data-a="hand-to-customer"]').click();
      await toRecovery(p);
      await p.locator('[data-a="pin-recover-pass"]').click();
      await enterPass(p, PASS);
      await p.waitForSelector('.pin-main [data-a="pin-key"]', { timeout: 20000 });
      await typePin(p, ['5', '6', '7', '8']);
      await typePin(p, ['5', '6', '7', '8']);
      await p.waitForFunction(() => window.__prepaidTestHooks.lockState().locked === false, null, { timeout: 20000 });
      const db1 = await readDb(p);
      await check(ledgerSig(db1) === ledgerSig(db0) && (await metaOf(p)).pubKey === pub0, 'resetting the PIN with the backup password must keep the ledger and the shop key');
      await p.locator('[data-a="hand-to-customer"]').click();
      await p.locator('[data-a="lock-to-pin"]').click();
      await typePin(p, ['1', '2', '3', '4']);
      await check((await lockState(p)).locked === true && (await lockState(p)).pinFails === 1, 'the old PIN must no longer open the app');
      await typePin(p, ['5', '6', '7', '8']);
      await p.waitForFunction(() => window.__prepaidTestHooks.lockState().locked === false, null, { timeout: 20000 });
      await check(true, 'the new PIN opens the app');
    });

    // ── 5. ② 맞는 백업 암호 → [백업 파일 고르기] → 잠긴 파일(이 기기 열쇠)로 되찾기 → 새 비밀번호 ──
    await guard('restore-locked-with-pass', async () => {
      await p.locator('[data-a="hand-to-customer"]').click();
      await toRecovery(p);
      await p.locator('[data-a="pin-forgot-restore"]').click();
      await enterPass(p, PASS);
      const t = await choiceTitle(p);
      await check(t === '백업 암호가 맞아요', `a correct password on ② must offer the file picker button (got ${JSON.stringify(t)})`);
      const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 8000 }), pick(p, 'pick')]);
      await chooser.setFiles({ name: lockedFile.name, mimeType: 'application/json', buffer: Buffer.from(lockedFile.raw, 'utf8') });
      await confirmInAppRestore(p);
      await p.waitForSelector('.pin-main [data-a="pin-key"]', { timeout: 15000 });
      await check((await p.locator('.pin-title').innerText()).includes('비밀번호 설정'), 'after a recovery restore the owner sets a new PIN');
      await check((await lockState(p)).recoveryPassHeld === false && (await lockState(p)).allowLockedRestore === false, 'the checked password and the one-shot restore permission must be dropped after use');
      await typePin(p, ['1', '1', '1', '1']); await typePin(p, ['1', '1', '1', '1']);
      await p.waitForFunction(() => window.__prepaidTestHooks.lockState().locked === false, null, { timeout: 20000 });
      await check(ledgerSig(await readDb(p)) === ledgerSig(db0), 'the locked file must bring the same ledger back');
    });

    // ── 6. ② 같은 백업 암호로 잠근 파일은 다시 묻지 않고 열린다(되돌리기 전 확인창까지) ──
    await guard('restore-pass-file-no-reask', async () => {
      const core = JSON.parse(fs.readFileSync(path.join(FIX, 'beta54-plain.json'), 'utf8'));
      const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
      const k = crypto.pbkdf2Sync(PASS, salt, 600000, 32, 'sha256');
      const plain = zlib.gzipSync(Buffer.from(JSON.stringify({ core, key: null }), 'utf8'));
      const c = crypto.createCipheriv('aes-256-gcm', k, iv); const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
      const file = { type: 'prepaid-pass-backup', v: 1, appName: '선입금대장', appVersion: 'harness', exportedAt: Date.now(), z: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', it: 600000, salt: salt.toString('base64') }, iv: iv.toString('base64'), ct: ct.toString('base64') };
      await p.locator('[data-a="hand-to-customer"]').click();
      await toRecovery(p);
      await p.locator('[data-a="pin-forgot-restore"]').click();
      await enterPass(p, PASS);
      await choiceTitle(p);
      const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 8000 }), pick(p, 'pick')]);
      await chooser.setFiles({ name: 'b60-pass.txt', mimeType: 'text/plain', buffer: Buffer.from(JSON.stringify(file), 'utf8') });
      const t = await choiceTitle(p);
      await check((t === '이 백업으로 되돌릴까요?' || t.includes('거래가 적은')) && await p.locator('#keyPass1').count() === 0, `a pass-backup locked with the same password must open without asking again (got ${JSON.stringify(t)})`);
      await pick(p, 'cancel');
      await check(ledgerSig(await readDb(p)) === ledgerSig(db0), 'cancelling must leave the ledger');
    });

    // ── 7. 지금 1: 게이트가 끝난 뒤에도 30초(여기서는 줄인 값)는 화면이 남는다 ──
    await guard('gate-then-stay', async () => {
      if (await p.locator('#choiceTitle').count()) await pick(p, 'cancel').catch(() => {});
      await p.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 8000 });
      if (!(await p.locator('.cust-screen').count())) await p.locator('[data-a="pin-to-cust"]').click();
      await setTimers(p, { recoveryGate: 1500, custIdle: 1200 });
      await p.locator('[data-a="lock-to-pin"]').click();
      await p.waitForSelector('[data-a="pin-forgot"]');
      const t0 = Date.now();
      await p.locator('[data-a="pin-forgot"]').click();
      await p.waitForSelector('.pin-recovery');
      await p.waitForTimeout(Math.max(0, 2000 - (Date.now() - t0)));
      await check(await p.locator('.pin-recovery').count() === 1 && !(await p.locator('[data-a="pin-reset"]').isDisabled()), 'right after the gate ends the recovery screen must still be there with ③ enabled (it used to close at that very moment)');
      await p.waitForTimeout(Math.max(0, 3600 - (Date.now() - t0)));
      await check(await p.locator('.cust-screen').count() === 1 && (await lockState(p)).pinRecovery === false, 'an abandoned recovery screen must still fall back to the customer screen after gate + idle');
      await setTimers(p, { recoveryGate: 60000, custIdle: 30000 });
    });
    await check(A.problems.length === 0, `no page errors on device A (got ${JSON.stringify(A.problems.slice(0, 3))})`);
  } finally { await A.ctx.close(); }

  // ═════ 기기 B: 백업 암호를 정한 적 없는 가게 — ③만, 그리고 가-1 안내 ═════
  const B = await newCtx();
  const q = B.page;
  try {
    // 자료가 없으면 백업 암호 안내도 없다
    await guard('nopass-empty', async () => {
      await seed(B, { empty: true });
      await unlockPin(q);
      await q.waitForFunction(() => window.__prepaidTestHooks.lockState().locked === false, null, { timeout: 20000 });
      await q.waitForTimeout(300);
      await check(await q.locator('.guard-banner').count() === 0, 'an empty ledger must not raise the backup-password banner');
    });
    await guard('nopass-screen', async () => {
      await putAll(q, { employees: [emp('b-e1', '박무암', '총무과')], transactions: [tx('b-t1', 'b-e1', 'open', 20000, 1)] });
      await resealChain(q);
      await q.reload({ waitUntil: 'load' });
      await q.waitForSelector('.cust-screen', { timeout: 15000 });
      const db0 = await readDb(q);
      const pin0 = (await metaOf(q)).pinHash;
      await setTimers(q, { recoveryGate: 300 });
      await toRecovery(q);
      const acts = await q.locator('.pin-recovery .section-actions [data-a]').evaluateAll(els => els.map(e => e.dataset.a));
      await check(JSON.stringify(acts) === JSON.stringify(['pin-reset']), `without a backup password only ③ may be offered (got ${JSON.stringify(acts)})`);
      await check((await q.locator('#pinRecoverySub').innerText()).includes('백업 암호를 정해 둔 적이 없어 장부를 그대로 두고 비밀번호만 바꿀 수 없어요'), 'the screen must say in one line why only ③ is left');
      // 숨은 경로로 ①②를 눌러도 아무것도 열리지 않는다(게이트가 지난 뒤에도)
      await q.waitForTimeout(500);
      const chooserP = q.waitForEvent('filechooser', { timeout: 1500 }).catch(() => null);
      await inject(q, 'pin-forgot-restore');
      await inject(q, 'pin-recover-pass');
      await check((await chooserP) === null && await q.locator('#keyPass1').count() === 0 && (await lockState(q)).allowLockedRestore === false, 'without a backup password ①② must do nothing even when fired directly');
      // 예전 세 번째 길: ③ → 잠긴 파일 → [취소] → 그 파일
      await q.waitForTimeout(500);
      const n0 = B.downloads.length, d0 = B.dialogs.length;
      B.decide = msg => !msg.includes('정말 지울까요');
      await q.locator('[data-a="pin-reset"]').click();
      for (let i = 0; i < 50 && B.downloads.length < n0 + 1; i += 1) await q.waitForTimeout(100);
      await q.waitForTimeout(400);
      B.decide = null;
      const conf = B.dialogs.slice(d0).filter(d => d.type === 'confirm');
      await check(conf.length === 2 && conf[0].message.includes('백업 암호를 정해 둔 적이 없어') && !conf[0].message.includes('PIN만 따로'), `③ must explain honestly why the PIN alone cannot be reset (got ${JSON.stringify(conf[0] && conf[0].message)})`);
      const lf = await lockedFileText(B);
      const chooser2P = q.waitForEvent('filechooser', { timeout: 1200 }).catch(() => null);
      await inject(q, 'pin-forgot-restore');
      await check((await chooser2P) === null, 'no file picker after the cancelled reset');
      await q.locator('#restoreFile').setInputFiles({ name: lf.name, mimeType: 'application/json', buffer: Buffer.from(lf.raw, 'utf8') });
      await q.waitForTimeout(800);
      await check(await q.locator('#choiceTitle').count() === 0 && (await lockState(q)).locked === true && ledgerSig(await readDb(q)) === ledgerSig(db0) && (await metaOf(q)).pinHash === pin0,
        'the old third path (cancelled reset → its locked file → new PIN) must be closed: ledger, lock and PIN unchanged');
      await q.locator('[data-a="pin-forgot-cancel"]').click();
      await setTimers(q, { recoveryGate: 60000 });
    });
    // 가-1: 자료가 있는데 백업 암호를 정한 적 없으면 상자·홈 배너가 같은 문장으로 알리고 [지금 백업하기]로 이어진다.
    await guard('nopass-banner', async () => {
      await unlockPin(q);
      await q.waitForFunction(() => window.__prepaidTestHooks.lockState().locked === false, null, { timeout: 20000 });
      await q.waitForSelector('.guard-banner', { timeout: 8000 });
      const head = (await q.locator('.guard-banner strong').innerText()).trim();
      const bt = await q.locator('.guard-banner').innerText();
      await check(head === '⚠ 백업 암호를 아직 정하지 않았어요' && bt.includes('화면잠금 비밀번호를 잊으면 장부를 되찾을 수 없어요') && (await q.locator('.guard-banner[data-a="backup-now"]').count()) === 1,
        `the home banner must warn about the missing backup password and lead to [지금 백업하기] (got ${JSON.stringify(bt)})`);
      await q.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(q, 'ledger');
      const box = (await q.locator('#guardState > b').innerText()).trim();
      await check(box === head && await q.locator('#guardState.warn').count() === 1, `the status box must say the same sentence (got ${JSON.stringify(box)})`);
      await q.locator('[data-a="screen"][data-screen="home"]').click();
      await q.locator('.guard-banner').click({ position: { x: 30, y: 30 } });
      const t = await choiceTitle(q);
      await check(t.includes('내 보관용 백업을 남겨요'), `tapping the banner must open the [지금 백업하기] choice (got ${JSON.stringify(t)})`);
      await pick(q, 'none');
      await q.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(q, 'ledger');
      await q.locator('[data-a="backup-pass"]').click();
      await q.waitForSelector('#keyPass2');
      await q.locator('#keyPass1').fill('b60-new-pass'); await q.locator('#keyPass2').fill('b60-new-pass');
      await q.locator('[data-a="pass-ok"]').click();
      await choiceTitle(q); await pick(q, 'ok');
      await q.locator('[data-a="screen"][data-screen="home"]').click();
      await q.waitForTimeout(300);
      await check(await q.locator('.guard-banner').count() === 0, 'setting a backup password must clear the banner');
      // 이제 이 기기의 복구 화면에는 ①②가 생긴다
      await q.locator('[data-a="hand-to-customer"]').click();
      await toRecovery(q);
      await check(await q.locator('[data-a="pin-recover-pass"]').count() === 1, 'once a backup password exists the recovery screen offers ①');
    });
    await check(B.problems.length === 0, `no page errors on device B (got ${JSON.stringify(B.problems.slice(0, 3))})`);
  } finally { await B.ctx.close(); }
  console.log(`beta.60a: ${passed} checks passed${fails.length ? `, ${fails.length} failed` : ''}`);
  return { passed, fails };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// beta.60 A2 — 명단·CSV(지금 2·3, 앱 5). E2E_ONLY=beta60b 로 이 블록만, E2E_SOFT=1 로 단언별 실패 목록.
//   지금 2: CSV 합계 줄은 이름·부서·첫 칸의 **칸 전체**가 합계·소계·총계·total일 때만 건너뛴다('통합계획과'·'총괄합계팀' 직원은 등록).
//   지금 3·앱 5: 이미 붙은 '·N'은 지키고, 같은 이름 여러 줄일 때만 빈 번호를 붙이며, 기존 직원 매칭은 번호를 정한 **뒤** 이름으로.
//   (가) 승인: 기존 A '김민수'·B '김민수·2', 명단 ['김민수·2' 18만, '김민수' 9만] → B 18만·A 9만 (+ 직접 전달로 같은 모양 한 번 더)
//   (나) CSV: 기존 A '김철수'·B '김철수·2', '김철수' 두 줄(1만·2만) → A 1만·B 2만, 미리보기 표와 같음
//   (다) CSV: 기존 A만, 같은 이름 두 줄 → A 충전 + 새 '·2' 직원   (라) 승인: 기존 A·B, '정민수·3'만 → 새 직원 '정민수·3'
//   각 단언은 수정 전 코드(beta.60 A1까지, assignDuplicateSuffix·onCsvFile 손대기 전)에서 실패함을 확인했다((라)·(다)의 승인/직접 전달 쪽은 회귀 방지).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
async function runBeta60b(browser, url, cors) {
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.60b] ' + msg);
  };
  const guard = async (label, fn) => {
    if (process.env.E2E_VERBOSE) console.log('  · ' + label);
    try { await fn(); } catch (err) { if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 300)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 300)}`); }
  };
  const RID = 'rid-b60b';
  const T0 = Date.now() - 3 * 86400000;
  const ORG = '광진구청';
  const emp = (id, name, dept, org) => ({ id, org: org === undefined ? ORG : org, orgKind: org === '' ? '' : 'public', dept, name, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: T0, updatedAt: T0 });
  const seedEmps = [
    emp('b60b-ga-A', '김민수', '가과'), emp('b60b-ga-B', '김민수·2', '가과'),
    emp('b60b-na-A', '김철수', '나과'), emp('b60b-na-B', '김철수·2', '나과'),
    emp('b60b-da-A', '박영희', '다과'),
    emp('b60b-ra-A', '정민수', '라과'), emp('b60b-ra-B', '정민수·2', '라과'),
    emp('b60b-ma-A', '이영수', '마과'), emp('b60b-ma-B', '이영수·2', '마과')
  ];
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
  await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
  const page = await ctx.newPage();
  const dialogs = [];
  const problems = [];
  // 받기 확인창(검토 문구)과 CSV [등록하기] 확인만 [확인], 나머지 confirm은 [취소](서버로 나가는 후속 동작을 막는다).
  page.on('dialog', async d => {
    dialogs.push({ type: d.type(), message: d.message() });
    const m = d.message();
    if (d.type() === 'confirm' && !(m.includes('받으실 금액') || m.includes('처리하시겠습니까'))) await d.dismiss().catch(() => {});
    else await d.accept().catch(() => {});
  });
  page.on('pageerror', e => problems.push(String(e && e.message || e)));
  const empByName = (db, dept, name) => db.employees.find(e => e.dept === dept && e.name === name && !e.isDeleted);
  const txSum = (db, empId) => db.transactions.filter(t => t.employeeId === empId && (t.type === 'topup' || t.type === 'open')).reduce((s, t) => s + Number(t.amount || 0), 0);
  const waitTx = async n0 => { for (let i = 0; i < 80; i += 1) { if ((await readDb(page)).transactions.length > n0) return; await page.waitForTimeout(150); } };
  const closeModals = async () => {
    for (let i = 0; i < 4 && await count(page, '.modal-back'); i += 1) {
      await page.locator('.modal-back [data-a="close-modal"]').first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(150);
    }
  };
  const goSettings = async () => { await closeModals(); await page.locator('[data-a="screen"][data-screen="settings"]').click(); await page.waitForTimeout(150); };
  const openCsv = async (name, body) => {
    await page.locator('#csvFile').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from('﻿' + body, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 8000 });
  };
  // 미리보기 표는 소속 칸이 있을 때만 '소속' 열이 생긴다 — 칸 위치가 아니라 머리글 이름으로 읽는다.
  const csvPreview = () => page.evaluate(() => {
    const heads = [...document.querySelectorAll('.csv-table thead th')].map(th => th.innerText.trim());
    return [...document.querySelectorAll('.csv-table tbody tr')].map(tr => { const o = {}; [...tr.querySelectorAll('td')].forEach((td, i) => { o[heads[i]] = td.innerText.trim(); }); return o; });
  });
  try {
    await page.goto(url, { waitUntil: 'load' });
    const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
    await page.evaluate(({ hash, t, emps, rid }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction(['meta', 'employees'], 'readwrite');
        const ms = tx.objectStore('meta');
        const put = (k, v) => ms.put({ key: k, value: v });
        put('setupComplete', true); put('welcomeSeen', true); put('termsAgreedAt', t); put('pinHash', hash);
        put('shopName', '명단식당'); put('departments', ['가과', '나과', '다과', '라과', '마과']); put('storeRegisterPending', false);
        put('restaurantId', rid); put('relayStoreName', '명단식당'); put('relayRegisteredAt', t); put('districtSyncedAt', t);
        put('autoCloudBackup', false);
        emps.forEach(e => tx.objectStore('employees').put(e));
        tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error);
      };
    }), { hash: legacyPin, t: Date.now(), emps: seedEmps, rid: RID });
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await page.waitForFunction(() => { const H = window.__prepaidTestHooks; return !!H && H.lockState && H.lockState().locked === false; }, null, { timeout: 15000 });
    let meta = {};
    for (let i = 0; i < 40 && !meta.pubKey; i += 1) { meta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {}); if (!meta.pubKey) await page.waitForTimeout(200); }
    await check(Boolean(meta.pubKey), 'the device must own a store key before the roster scenarios');

    // ── 함수 단위: 붙은 번호는 지키고, 같은 이름이 겹칠 때만 빈 번호 ──
    await guard('assignDuplicateSuffix unit', async () => {
      const r = await page.evaluate(() => {
        const assignDuplicateSuffix = window.__prepaidTestHooks.assignDuplicateSuffix;
        const run = names => { const rows = names.map(n => ({ org: 'O', dept: 'D', name: n })); const c = assignDuplicateSuffix(rows); return { names: rows.map(x => x.name), changed: c }; };
        const a = run(['김민수·2', '김민수']);
        const b = run(['김민수·2', '김민수', '김민수']);
        const c = run(['김철수', '김철수']);
        const d = run(['김민수·3']);
        const e = run(['홍길동·2', '홍길동·2']);
        const again = names => { const rows = names.map(n => ({ org: 'O', dept: 'D', name: n })); assignDuplicateSuffix(rows); const n1 = rows.map(x => x.name); assignDuplicateSuffix(rows); return JSON.stringify(n1) === JSON.stringify(rows.map(x => x.name)); };
        return { a, b, c, d, e, idem: again(['김민수·2', '김민수', '김민수', '김민수']) };
      });
      await check(JSON.stringify(r.a.names) === JSON.stringify(['김민수·2', '김민수']) && r.a.changed === 0, `an explicit '·2' must be kept as-is, not renumbered by row order (got ${JSON.stringify(r.a)})`);
      await check(JSON.stringify(r.b.names) === JSON.stringify(['김민수·2', '김민수', '김민수·3']), `a repeated plain name must take the next number the roster does not already use (got ${JSON.stringify(r.b)})`);
      await check(JSON.stringify(r.c.names) === JSON.stringify(['김철수', '김철수·2']) && r.c.changed === 1, `two plain same names must still become 이름 / 이름·2 (got ${JSON.stringify(r.c)})`);
      await check(JSON.stringify(r.d.names) === JSON.stringify(['김민수·3']), `a lone '·3' must stay '·3' (got ${JSON.stringify(r.d)})`);
      await check(JSON.stringify(r.e.names) === JSON.stringify(['홍길동·2', '홍길동·3']), `the same explicit name twice must not end as two identical names (got ${JSON.stringify(r.e)})`);
      await check(r.idem === true, 'running the suffix twice must not change the result');
    });

    // ── 지금 2: 합계 줄은 칸 전체로만 ──
    await guard('CSV total rows', async () => {
      await goSettings();
      const csv = ['부서,이름,금액', '통합계획과,이통합,5000', '총괄합계팀,최총괄,6000', '총무과,박정상,7000', '통합계획과,합 계,11000', ' 소계 ,,18000', 'TOTAL,,18000'].join('\r\n') + '\r\n';
      await openCsv('totals.csv', csv);
      const rows = await csvPreview();
      const names = rows.map(r => r['이름']);
      await check(names.includes('이통합') && names.includes('최총괄') && names.includes('박정상'), `staff of '통합계획과'·'총괄합계팀' must be listed, not silently dropped (got ${JSON.stringify(names)})`);
      await check(!names.includes('합 계') && rows.length === 3, `only whole-cell total rows may be skipped (got ${JSON.stringify(rows)})`);
      const note = await page.locator('.csv-skip-note').innerText().catch(() => '');
      await check(note.includes('3개') && note.includes('건너뛰었어요'), `the preview must tell how many total rows were skipped (got ${JSON.stringify(note)})`);
      const n0 = (await readDb(page)).transactions.length;
      await page.locator('[data-a="exec-csv"]').click();
      await waitTx(n0);
      const db = await readDb(page);
      await check(Boolean(empByName(db, '통합계획과', '이통합')) && Boolean(empByName(db, '총괄합계팀', '최총괄')), 'the 통합계획과·총괄합계팀 staff must be saved to the ledger');
      await check(!db.employees.some(e => /합\s*계|소계|total/i.test(e.name)), 'no total row may become an employee');
    });

    // ── 지금 2 보완: 꾸밈이 붙은 합계 줄('합계(2명)'·'합계:')도 건너뛰고, '합계팀'·'소계동'·'총계약과'는 정상 부서 ──
    await guard('CSV decorated total rows unit', async () => {
      const r = await page.evaluate(() => {
        const f = window.__prepaidTestHooks.isCsvTotalRow;
        const yes = ['합계(2명)', '합계:', '합 계 :', '소계 - 3건', '총계 18,000원', 'Total:', 'TOTAL (5)', '합계[2인]', '소계·2개', '합계~'];
        const no = ['통합계획과', '총괄합계팀', '합계팀', '소계동', '총계약과', '합계금액', 'totals', '김합계', '합계(팀)'];
        return { yes: yes.filter(s => !f([s])), no: no.filter(s => f([s])), deptOnly: f(['', '합계(2명)', '']), firstOnly: f(['', '', '소계:']) };
      });
      await check(r.yes.length === 0, `decorated total cells must count as total rows (missed ${JSON.stringify(r.yes)})`);
      await check(r.no.length === 0, `real names/departments must not count as total rows (wrongly skipped ${JSON.stringify(r.no)})`);
      await check(r.deptOnly && r.firstOnly, 'a decorated total in the department or first cell must also count');
    });
    await guard('CSV decorated total rows preview', async () => {
      await goSettings();
      const csv = ['소속,부서,이름,금액', `${ORG},총무과,합계(2명),18000`, ',,합계:,18000', `${ORG},합계팀,한합계,4000`, `${ORG},소계동,유소계,4100`, `${ORG},총계약과,문총계,4200`].join('\r\n') + '\r\n';
      // 앞 시나리오가 만든 '총괄합계팀'(소속 없음) 때문에 '광진구청 합계팀'에 "비슷한 부서" 갈림길이 뜬다 — [새 부서로 따로 등록]을 고른다(정상 흐름).
      await page.locator('#csvFile').setInputFiles({ name: 'totals2.csv', mimeType: 'text/csv', buffer: Buffer.from('\ufeff' + csv, 'utf8') });
      for (let k = 0; k < 4; k += 1) {
        await page.waitForSelector('.csv-table, #choiceTitle', { timeout: 8000 });
        if (await page.locator('.csv-table').count()) break;
        await page.locator('.choice-modal [data-a="choice-pick"][data-val="separate"]').first().click();
        await page.waitForTimeout(200);
      }
      await page.waitForSelector('.csv-table', { timeout: 8000 });
      const rows = await csvPreview();
      const names = rows.map(r => r['이름']);
      await check(!names.some(n => /합계\(|합계:/.test(n)), `decorated total rows must not appear as staff in the preview (got ${JSON.stringify(names)})`);
      await check(rows.length === 3 && ['한합계', '유소계', '문총계'].every(n => names.includes(n)), `'합계팀'·'소계동'·'총계약과' staff must be listed (got ${JSON.stringify(rows)})`);
      await check(!rows.some(r => Object.values(r).some(v => /부서명 없음|오류/.test(v))), `no row may turn into an error (got ${JSON.stringify(rows)})`);
      const note = await page.locator('.csv-skip-note').innerText().catch(() => '');
      await check(note.includes('2개') && note.includes('건너뛰었어요'), `the preview must tell that 2 total rows were skipped (got ${JSON.stringify(note)})`);
      const execOk = await count(page, '[data-a="exec-csv"]');
      await check(execOk > 0, 'the [등록하기] button must be available (the file must not be blocked)');
      const n0 = (await readDb(page)).transactions.length;
      await page.locator('[data-a="exec-csv"]').click();
      await waitTx(n0);
      const db = await readDb(page);
      await check(Boolean(empByName(db, '합계팀', '한합계')) && Boolean(empByName(db, '소계동', '유소계')) && Boolean(empByName(db, '총계약과', '문총계')), 'the 합계팀·소계동·총계약과 staff must be saved to the ledger');
      await check(!db.employees.some(e => /^(합계|소계|총계)/.test(e.name)), `no decorated total row may become an employee (got ${JSON.stringify(db.employees.map(e => e.name))})`);
    });

    // ── (나) CSV: 같은 이름 두 줄 → 미리보기에 보인 이름이 곧 충전 대상 ──
    await guard('CSV (나)', async () => {
      await goSettings();
      await openCsv('dup-na.csv', ['소속,부서,이름,금액', `${ORG},나과,김철수,10000`, `${ORG},나과,김철수,20000`].join('\r\n') + '\r\n');
      const rows = await csvPreview();
      const shown = rows.map(r => `${r['이름']}|${r['금액']}|${r['상태']}`);
      await check(JSON.stringify(shown) === JSON.stringify(['김철수|10,000원|🔄 추가 충전', '김철수·2|20,000원|🔄 추가 충전']), `the preview must show 김철수 1만 and 김철수·2 2만 as top-ups (got ${JSON.stringify(shown)})`);
      const n0 = (await readDb(page)).transactions.length;
      await page.locator('[data-a="exec-csv"]').click();
      await waitTx(n0);
      const db = await readDb(page);
      await check(txSum(db, 'b60b-na-A') === 10000 && txSum(db, 'b60b-na-B') === 20000, `CSV must top up the employees the preview showed — A 10,000 / B 20,000 (got A ${txSum(db, 'b60b-na-A')}, B ${txSum(db, 'b60b-na-B')})`);
      await check(db.employees.filter(e => e.dept === '나과').length === 2, 'no extra 김철수 card may be created');
    });

    // ── (다) CSV: 기존 A만 + 같은 이름 두 줄 → A 충전 + 새 '·2' ──
    await guard('CSV (다)', async () => {
      await goSettings();
      await openCsv('dup-da.csv', ['소속,부서,이름,금액', `${ORG},다과,박영희,11000`, `${ORG},다과,박영희,22000`].join('\r\n') + '\r\n');
      const rows = await csvPreview();
      const shown = rows.map(r => `${r['이름']}|${r['상태']}`);
      await check(JSON.stringify(shown) === JSON.stringify(['박영희|🔄 추가 충전', '박영희·2|✅ 신규']), `the preview must show 박영희 as a top-up and 박영희·2 as new (got ${JSON.stringify(shown)})`);
      const n0 = (await readDb(page)).transactions.length;
      await page.locator('[data-a="exec-csv"]').click();
      await waitTx(n0);
      const db = await readDb(page);
      const nb = empByName(db, '다과', '박영희·2');
      await check(txSum(db, 'b60b-da-A') === 11000 && nb && txSum(db, nb.id) === 22000, `A must get 11,000 and a new 박영희·2 must get 22,000 (got A ${txSum(db, 'b60b-da-A')}, new ${nb ? txSum(db, nb.id) : 'none'})`);
    });

    // ── (가) 승인: 명단에 적힌 '·2'를 지킨다 ──
    await page.evaluate(async ({ pubKey }) => {
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      window.__b60bSeal = async items => {
        const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify({ v: 1, items })));
        const raw = await crypto.subtle.exportKey('raw', aes);
        return { alg: 'RSA-OAEP-2048+AES-256-GCM', encKey: u2b(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw)), iv: u2b(iv), ct: u2b(ct) };
      };
      window.__b60bHash = async items => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      window.__b60bInbox = [];
      window.__b60bApproved = [];
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const s = String(u);
        const J = (b, st) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json' } });
        if (s.includes('/api/challenge')) return J({ challenge_ct: u2b(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, new TextEncoder().encode('B60BTOKEN'))) });
        if (s.includes('/api/inbox?')) return J(window.__b60bInbox);
        if (s.includes('/api/approve')) { window.__b60bApproved.push(JSON.parse(o.body)); return J({ ok: true }); }
        return orig(u, o);
      };
    }, { pubKey: meta.pubKey });
    const approve = async (sid, dept, items) => {
      await page.evaluate(async ({ sid2, dept2, items2, rid, org }) => {
        window.__b60bInbox = [{ summary_id: sid2, summary: { institution: org, department: dept2, restaurant_id: rid, restaurant_name: '명단식당', year_month: '2026-11', total_amount: items2.reduce((s, i) => s + i.amount, 0), member_count: items2.length, batch_hash: await window.__b60bHash(items2) }, ciphertext: await window.__b60bSeal(items2), status: 'PENDING' }];
      }, { sid2: sid, dept2: dept, items2: items, rid: RID, org: ORG });
      await goSettings();
      await openSettingsCard(page, 'enroll-auto');
      await page.locator('[data-a="relay-inbox"]').click();
      await page.waitForSelector('[data-a="relay-approve"]', { timeout: 10000 });
      const before = dialogs.length;
      const n0 = (await readDb(page)).transactions.length;
      await page.locator('[data-a="relay-approve"]').click();
      await waitTx(n0);
      await page.waitForTimeout(300);
      return dialogs.slice(before).find(d => d.type === 'confirm' && d.message.includes('받으실 금액'));
    };
    await guard('approve (가)', async () => {
      const rev = await approve('sid-b60b-ga', '가과', [{ name: '김민수·2', dept: '가과', amount: 180000 }, { name: '김민수', dept: '가과', amount: 90000 }]);
      const msg = rev ? rev.message : '';
      await check(msg.includes('· 김민수·2: 0원 → 180,000원') && msg.includes('· 김민수: 0원 → 90,000원'), `the review must name 김민수·2 for 18만 and 김민수 for 9만 exactly as the roster wrote them (got ${JSON.stringify(msg.slice(0, 600))})`);
      const db = await readDb(page);
      await check(txSum(db, 'b60b-ga-B') === 180000 && txSum(db, 'b60b-ga-A') === 90000, `approval must top up B(김민수·2) 180,000 and A(김민수) 90,000 — not swapped (got A ${txSum(db, 'b60b-ga-A')}, B ${txSum(db, 'b60b-ga-B')})`);
      await check(db.employees.filter(e => e.dept === '가과').length === 2, 'no new 김민수 card may be created');
    });
    await guard('approve (라)', async () => {
      await closeModals();
      const rev = await approve('sid-b60b-ra', '라과', [{ name: '정민수·3', dept: '라과', amount: 40000 }]);
      const msg = rev ? rev.message : '';
      const db = await readDb(page);
      const n3 = empByName(db, '라과', '정민수·3');
      await check(n3 && txSum(db, n3.id) === 40000 && txSum(db, 'b60b-ra-A') === 0 && txSum(db, 'b60b-ra-B') === 0, `a lone '정민수·3' must become a new employee, leaving A and B untouched (got new ${n3 ? txSum(db, n3.id) : 'none'}, A ${txSum(db, 'b60b-ra-A')}, B ${txSum(db, 'b60b-ra-B')})`);
      await check(msg.includes('새 직원 등록 1명') && msg.includes('· 정민수·3: 40,000원'), `the review must list 정민수·3 as a new employee (got ${JSON.stringify(msg.slice(0, 600))})`);
    });

    // ── (가') 직접 전달: 같은 규칙 ──
    await guard('direct (가)', async () => {
      await closeModals();
      await goSettings();
      const items = [{ name: '이영수·2', dept: '마과', amount: 50000 }, { name: '이영수', dept: '마과', amount: 30000 }];
      const json = await page.evaluate(async ({ items2, rid, org }) => JSON.stringify({
        v: 1, type: 'direct-transfer', transfer_id: 'tid-b60b-ma', restaurant_id: rid, restaurant_name: '명단식당', institution: org, department: '마과', year_month: '2026-11',
        summary: { total_amount: items2.reduce((s, i) => s + i.amount, 0), member_count: items2.length, batch_hash: await window.__b60bHash(items2) },
        ciphertext: await window.__b60bSeal(items2)
      }), { items2: items, rid: RID, org: ORG });
      const before = dialogs.length;
      const n0 = (await readDb(page)).transactions.length;
      await page.locator('#directTransferFile').setInputFiles({ name: 'ma.json', mimeType: 'application/json', buffer: Buffer.from(json, 'utf8') });
      await waitTx(n0);
      await page.waitForTimeout(300);
      const rev = dialogs.slice(before).find(d => d.type === 'confirm' && d.message.includes('받으실 금액'));
      const msg = rev ? rev.message : '';
      await check(msg.includes('· 이영수·2: 0원 → 50,000원') && msg.includes('· 이영수: 0원 → 30,000원'), `the direct-transfer review must keep the roster's '·2' (got ${JSON.stringify(msg.slice(0, 600))})`);
      const db = await readDb(page);
      await check(txSum(db, 'b60b-ma-B') === 50000 && txSum(db, 'b60b-ma-A') === 30000, `direct transfer must top up B 50,000 and A 30,000 (got A ${txSum(db, 'b60b-ma-A')}, B ${txSum(db, 'b60b-ma-B')})`);
    });

    // 장부 검사: 위 모든 충전 뒤에도 사슬·잔액이 맞아야 한다.
    await guard('ledger integrity', async () => {
      const r = await page.evaluate(async ids => { const H = window.__prepaidTestHooks; const c = await H.verifyChain(); const bad = []; for (const id of ids) { const v = await H.verifyBalanceFor(id); if (!(v && v.integrityOk && v.crossOk)) bad.push(id); } return { ok: c.ok, broken: c.broken.length, bad }; }, seedEmps.map(e => e.id));
      await check(r.ok === true && r.bad.length === 0, `the ledger chain and every topped-up balance must stay consistent (got ${JSON.stringify(r)})`);
    });
    await check(problems.length === 0, `no page error may occur (got ${JSON.stringify(problems.slice(0, 3))})`);
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(`beta.60b: ${passed} checks passed${fails.length ? `, ${fails.length} failed` : ''}`);
  return { passed, fails };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// beta.60 A3a — 서버 연동·백업·입력 보존(결정 2, 앱 8·10·11, S 계약 9절). E2E_ONLY=beta60c 로 이 블록만, E2E_SOFT=1 로 단언별 실패 목록.
//   목 중계 서버(makeBackupRelay)는 worker.js의 새 동작을 그대로 흉내 낸다: 머리 seg_count → 409 segments_missing, 15분 유예,
//   backup_quota_exceeded, 보관 칸(/api/ledger-archive/* — 전용 토큰), register-key의 휴지통 되돌리기(소유 증명).
//   서비스워커(앱 12)는 harness/sw.e2e.mjs가 따로 본다(실제 등록이 필요해서).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
async function runBeta60c(browser, url, cors) {
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.60c] ' + msg);
  };
  const guard = async (label, fn) => {
    if (process.env.E2E_VERBOSE) console.log('  · ' + label);
    try { await fn(); } catch (err) { if (process.env.B60_SHOTS_DIR && shotPage) await shotPage.screenshot({ path: path.join(process.env.B60_SHOTS_DIR, 'fail-' + label + '.png') }).catch(() => {}); if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 300)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 300)}`); }
  };
  let shotPage = null;
  const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
  const DAY = 86400000, T0 = Date.now() - 10 * DAY;
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
  const RID = 'rid-b60c', TEL = '010-2222-3333';
  const relay = makeBackupRelay(cors);
  const otherPub = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const emp = (id, name, dept) => ({ id, org: '광진구청', orgKind: 'public', dept, name, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: T0, updatedAt: T0 });
  const tx = (id, e, type, amount, k, extra) => Object.assign({ id, employeeId: e, type, amount, beforeBalance: 0, afterBalance: 0, reason: type === 'use' ? '서명 확인' : '', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', hv: 2, txHash: '', prevHash: '', createdAt: T0 + k * 60000, occurredAt: 0 }, extra || {});
  const putAll = (page, o) => page.evaluate(o2 => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result; const t = db.transaction(['meta', 'employees', 'transactions'], 'readwrite');
      Object.entries(o2.meta || {}).forEach(([k, v]) => t.objectStore('meta').put({ key: k, value: v }));
      (o2.delMeta || []).forEach(k => t.objectStore('meta').delete(k));
      (o2.employees || []).forEach(e => t.objectStore('employees').put(e));
      (o2.transactions || []).forEach(x => t.objectStore('transactions').put(x));
      t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error);
    };
  }), o);
  const metaOf = async page => (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
  const awaitUnlocked = page => page.waitForFunction(() => { const H = window.__prepaidTestHooks; return !!H && H.lockState && H.lockState().locked === false; }, null, { timeout: 20000 });
  const reloadUnlock = async page => { await page.reload({ waitUntil: 'load' }); await unlockPin(page); await awaitUnlocked(page); };
  const choiceTitle = async (page, ms = 20000) => { await page.waitForSelector('#choiceTitle', { timeout: ms }); return (await page.locator('#choiceTitle').innerText()).trim(); };
  const choiceText = async page => (await page.locator('.choice-modal').innerText());
  const pick = async (page, val) => { await page.locator(`.choice-modal [data-a="choice-pick"][data-val="${val}"]`).click(); await page.waitForTimeout(150); };
  const goGuard = async page => { await page.locator('[data-a="screen"][data-screen="settings"]').click(); await openSettingsCard(page, 'ledger'); };
  const runCloud = page => page.evaluate(() => window.__prepaidTestHooks.cloudBackupRun({}).then(x => ({ ok: true, ...x }), e => ({ err: String(e && (e.code || e.message)) })));
  const openHead = (page, blob) => page.evaluate(b => window.__prepaidTestHooks.openFromCloud(b).then(u => u.obj), blob);
  const inject = (page, action, id) => page.evaluate(([a, i]) => { const b = document.createElement('button'); b.dataset.a = a; if (i) b.dataset.id = i; b.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px'; document.getElementById('app').appendChild(b); b.click(); b.remove(); }, [action, id || '']);
  const vals = (page, ids) => page.evaluate(list => list.map(i => { const el = document.getElementById(i); return el ? el.value : null; }), ids);
  const newCtx = async (opts) => {
    opts = opts || {};
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...(opts.blockSW ? { serviceWorkers: 'block' } : {}) });
    await ctx.addInitScript(() => { window.__cloudSegSize = 3; window.__cloudRetryWaitMs = 30; });
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
    await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
    await ctx.route('**/api/challenge**', relay.handle);
    await ctx.route('**/api/ledger-backup**', relay.handle);
    await ctx.route('**/api/ledger-archive/**', relay.handle);
    await ctx.route('**/api/register-key**', relay.handle);
    const page = await ctx.newPage();
    const D = { ctx, page, dialogs: [], downloads: [], problems: [] };
    page.on('dialog', async d => { D.dialogs.push({ type: d.type(), message: d.message() }); await d.accept().catch(() => {}); });
    page.on('download', d => D.downloads.push(d));
    page.on('pageerror', e => D.problems.push(String(e && e.message || e)));
    return D;
  };

  // ═════════════════════ 기기 A: 등록된 가게(가게 전화 있음) ═════════════════════
  const A = await newCtx();
  const page = A.page; shotPage = page;
  let pubA = '';
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 });
    await page.waitForTimeout(200);
    const emps = [emp('c60-e1', '김전화', '세무과'), emp('c60-e2', '이보관', '세무과'), emp('c60-e3', '박삭제', '총무과')];
    const base7 = [tx('c60-t1', 'c60-e1', 'open', 50000, 1), tx('c60-t2', 'c60-e2', 'open', 50000, 2), tx('c60-t3', 'c60-e3', 'open', 30000, 3),
      tx('c60-t4', 'c60-e1', 'use', 9000, 4, { signatureData: SIG }), tx('c60-t5', 'c60-e2', 'use', 8000, 5, { signatureData: SIG }),
      tx('c60-t6', 'c60-e1', 'use', 9000, 6, { signatureData: SIG }), tx('c60-t7', 'c60-e3', 'topup', 10000, 7)];
    const now0 = Date.now();
    await putAll(page, { meta: { setupComplete: true, welcomeSeen: true, termsAgreedAt: now0, pinHash: legacyPin, shopName: '전화식당', shopTel: TEL, shopAddr: '서울특별시 광진구 구의동 1', departments: ['세무과', '총무과'], orgName: '광진구청',
      storeRegisterPending: false, restaurantId: RID, relayStoreName: '전화식당', relayRegisteredAt: now0, districtSyncedAt: now0, myKeyBackedUpAt: now0 }, employees: emps, transactions: base7 });
    await resealChain(page);
    pubA = (await metaOf(page)).pubKey;
    relay.st.reg.set(RID, pubA); relay.st.names.set(RID, '전화식당');
    await check(!!pubA, 'setup: the device must have its shop key');

    // ── (A) 결정 2: 서버로 가는 백업에 가게 전화가 없다 — 머리·잠긴 파일. 조각은 거래만이라 그대로 ──
    await guard('shoptel-not-on-server', async () => {
      await reloadUnlock(page);
      // 잠금 해제 때 주 1회 자동 백업이 돈다(처음이라 due) — 끝날 때까지 기다린다.
      await page.waitForFunction(() => { const s = window.__prepaidTestHooks.cloudState(); return s && s.lastOkAt > 0; }, null, { timeout: 20000 });
      const h = relay.st.head.get(RID);
      await check(!!h, 'A setup: the automatic server backup must have uploaded a head');
      const head = await openHead(page, h.blob);
      await check(head && head.meta && !Object.prototype.hasOwnProperty.call(head.meta, 'shopTel') && head.meta.shopName === '전화식당' && head.meta.shopAddr,
        `결정 2: the server backup head must carry no shop phone (shopTel) but keep the other shop info (got meta keys ${JSON.stringify(head && head.meta && Object.keys(head.meta))})`);
      const locked = await page.evaluate(async () => { const H = window.__prepaidTestHooks; const b = await H.buildCloudBackupBlob(); const c = await H.decryptBlob(b); return c.payload.meta; });
      await check(!Object.prototype.hasOwnProperty.call(locked, 'shopTel') && locked.shopName === '전화식당', `결정 2: the locked (server-key) file must carry no shop phone either (got ${JSON.stringify(Object.keys(locked))})`);
      await check((await metaOf(page)).shopTel === TEL, 'the device ledger must still keep the shop phone');
      // 가게 전화만 바뀌면 조각은 다시 올라가지 않는다(머리만) — shopTel은 머리에만 있었다.
      await putAll(page, { meta: { shopTel: '010-9999-0000' } });
      await reloadUnlock(page);
      relay.st.log.length = 0;
      const r = await runCloud(page);
      const log = relay.st.log.map(e => e.t);
      await check(r.ok && JSON.stringify(log) === JSON.stringify(['list', 'head']), `changing only the shop phone must re-upload no segment (got ${JSON.stringify({ r, log })})`);
      await putAll(page, { meta: { shopTel: TEL } });
      await reloadUnlock(page);
    });

    // ── (A) 서버에서 되찾기: 같은 기기는 가게 전화를 지키고, 전화가 없는 기기는 빈 칸(오류 없음) ──
    await guard('shoptel-restore', async () => {
      await goGuard(page);
      await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud');
      let t = await choiceTitle(page); await pick(page, 'go');
      t = await choiceTitle(page);
      await check(t === '되찾기를 마쳤어요', `a same-device server restore must finish (got ${JSON.stringify(t)})`);
      await pick(page, 'ok');
      await check((await metaOf(page)).shopTel === TEL, 'after a server restore the same device must keep its shop phone');
      await putAll(page, { delMeta: ['shopTel'] });
      await reloadUnlock(page);
      await goGuard(page);
      await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud');
      await choiceTitle(page); await pick(page, 'go');
      t = await choiceTitle(page);
      await check(t === '되찾기를 마쳤어요' && A.problems.length === 0, `a device without a shop phone must restore without error (got ${JSON.stringify(t)}, errors ${JSON.stringify(A.problems)})`);
      await pick(page, 'ok');
      const m = await metaOf(page);
      await check(m.shopTel === '' || m.shopTel == null, `a server restore must leave the shop phone empty when this device has none (got ${JSON.stringify(m.shopTel)})`);
      await putAll(page, { meta: { shopTel: TEL } });
      await reloadUnlock(page);
    });

    // ── (A) 접수 이메일 칸 안내 ──
    await guard('contact-email-hint', async () => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'contact');
      const txt = await page.locator('.contact-email-hint').innerText().catch(() => '');
      await check(txt.includes('가게용 이메일을 넣어 주세요. 담당자 화면에 보여요'), `the contact email field must say to use a shop email (got ${JSON.stringify(txt)})`);
    });

    // ── (F2) 머리에 seg_count, 서버가 "조각이 모자라요"면 새 세대로 한 번만 다시 ──
    await guard('segments-missing-retry', async () => {
      await putAll(page, { meta: { cloudBackupState: null } });
      await reloadUnlock(page);
      await page.waitForTimeout(300);
      relay.st.log.length = 0; relay.st.dropSegOnHead = 1;
      const r = await runCloud(page);
      relay.st.dropSegOnHead = 0;
      const heads = relay.st.log.filter(e => e.t === 'head' || e.t === 'headmissing');
      await check(heads.length >= 1 && heads.every(e => e.sc === 3), `the head must carry seg_count = number of segments (3) (got ${JSON.stringify(heads)})`);
      await check(r.ok && heads.length === 2 && heads[0].t === 'headmissing' && heads[1].t === 'head' && heads[1].gen !== heads[0].gen,
        `segments_missing must trigger exactly one retry with a NEW gen that then succeeds (got ${JSON.stringify({ r, heads })})`);
      const st = await page.evaluate(() => window.__prepaidTestHooks.cloudState());
      await check(st.gen === heads[1].gen && !st.failSince && !st.pendingGen, `the retried gen must be recorded as the success (got ${JSON.stringify({ gen: st.gen, failSince: st.failSince, pendingGen: st.pendingGen })})`);
      // 늘 모자라면 두 번에서 멈추고(무한 반복 금지) 이유를 사람 말로 남긴다.
      relay.st.log.length = 0; relay.st.dropSegOnHead = -1;
      await putAll(page, { meta: { cloudBackupState: null } }); await reloadUnlock(page); await page.waitForTimeout(300);
      relay.st.log.length = 0;
      const r2 = await runCloud(page);
      const heads2 = relay.st.log.filter(e => e.t === 'headmissing' || e.t === 'head');
      await check(r2.err === 'segments_missing' && heads2.length === 2, `a second segments_missing must stop (2 head attempts, no loop) (got ${JSON.stringify({ r2, n: heads2.length })})`);
      await goGuard(page);
      await page.locator('[data-a="backup-now"]').click();
      const t = await choiceTitle(page); const txt = await choiceText(page);
      await check(t.startsWith('서버에는 올리지 못했어요') && txt.includes('장부 일부가 사라져') && !/segments_missing/.test(txt), `the backup dialog must say why in plain words (got ${JSON.stringify(t + ' / ' + txt.replace(/\s+/g, ' ').slice(0, 200))})`);
      await pick(page, 'none');
      const box = await page.locator('#guardState').innerText();
      await check(box.includes('장부 일부가 사라져'), `the 장부 지키기 box must keep the reason (got ${JSON.stringify(box.slice(0, 200))})`);
      relay.st.dropSegOnHead = 0;
    });

    // ── (F3) backup_quota_exceeded — 이유 + 다음 행동이 창과 상자에 남는다 ──
    await guard('quota-message', async () => {
      await putAll(page, { meta: { cloudBackupState: null } }); await reloadUnlock(page); await page.waitForTimeout(300);
      relay.st.quota = true;
      await goGuard(page);
      await page.locator('[data-a="backup-now"]').click();
      const t = await choiceTitle(page); const txt = await choiceText(page);
      await check(t.startsWith('서버에는 올리지 못했어요') && txt.includes('서버 백업 자리가 가득 찼어요') && txt.includes('내 보관용 파일'), `backup_quota_exceeded must be explained (got ${JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 200))})`);
      await pick(page, 'none');
      const box = await page.locator('#guardState').innerText();
      await check(box.includes('서버 백업 자리가 가득 찼어요'), `the box must keep the quota reason (got ${JSON.stringify(box.slice(0, 200))})`);
      relay.st.quota = false;
      const r = await runCloud(page);
      await check(r.ok, 'after the quota clears the backup must succeed again');
    });

    // ── (B) 앱 8: [서버 백업 지우기]는 진행 중인 업로드를 기다리거나 무효화한다 — 지운 뒤 되살아나지 않는다 ──
    await guard('delete-vs-upload', async () => {
      await putAll(page, { meta: { cloudBackupState: null, autoCloudBackup: true } }); await reloadUnlock(page); await page.waitForTimeout(300);
      relay.st.log.length = 0; relay.st.segDelayMs = 1500;
      await page.evaluate(() => { window.__b60silent = window.__prepaidTestHooks.relayBackupSilent(); });
      await page.waitForFunction(() => true, null);
      const t0 = Date.now(); while (!relay.st.log.some(e => e.t === 'segstart') && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50));
      await check(relay.st.log.some(e => e.t === 'segstart'), 'setup: an upload must be in flight');
      await goGuard(page);
      await page.locator('[data-a="cloud-backup-delete"]').click();
      await choiceTitle(page); await pick(page, 'del');
      const t1 = Date.now(); while (!relay.st.log.some(e => e.t === 'delete') && Date.now() - t1 < 20000) await new Promise(r => setTimeout(r, 50));
      await page.evaluate(() => window.__b60silent);
      await page.waitForTimeout(3500);
      relay.st.segDelayMs = 0;
      const log = relay.st.log.map(e => e.t);
      const di = log.indexOf('delete');
      await check(di >= 0 && !log.slice(di + 1).some(x => x === 'seg' || x === 'segstart' || x === 'head'), `after the delete no segment or head may be uploaded (log ${JSON.stringify(log)})`);
      await check(!relay.st.head.get(RID) && ![...((relay.st.segs.get(RID)) || new Map()).values()].some(m => m.size), `the server backup must stay deleted (head ${!!relay.st.head.get(RID)}, segs ${JSON.stringify([...((relay.st.segs.get(RID)) || new Map()).keys()])})`);
      const m = await metaOf(page);
      await check(m.cloudBackupState == null && m.lastCloudBackupAt == null && m.autoCloudBackup === false, `the cancelled upload must not record a success after the delete (got ${JSON.stringify({ st: m.cloudBackupState && { lastOkAt: m.cloudBackupState.lastOkAt, failSince: m.cloudBackupState.failSince }, last: m.lastCloudBackupAt, auto: m.autoCloudBackup })})`);
      await check(log.indexOf('seg') >= 0 && log.indexOf('seg') < di, `the delete must wait for the in-flight request to finish first (log ${JSON.stringify(log)})`);
    });

    // ── (B-2) 보완: 업로드 응답이 영영 오지 않아도 [서버 백업 지우기]는 상한 뒤 끝나고, 지운 백업은 되살아나지 않는다 ──
    //   상한은 하니스 훅(__cloudDeleteWaitMs, localhost·?e2e=1 전용)으로 2초로 줄인다. relayFetch 시한도 늘려 '영영'을 만든다.
    await guard('delete-cap-hang', async () => {
      // 잠금을 풀면 자동 백업이 곧바로 돈다 — 그 업로드의 첫 조각부터 응답이 멈추게 미리 걸어 둔다(새로 부르는 백업은 그것을 기다린다).
      relay.st.log.length = 0; relay.st.segDelayMs = 0; relay.st.segHang = true; relay.st.segHangRelease = null;
      await putAll(page, { meta: { cloudBackupState: null, autoCloudBackup: true } }); await reloadUnlock(page);
      await page.evaluate(() => { window.__cloudDeleteWaitMs = 2000; window.__relayTimeoutMs = 600000; window.__b60hang = window.__prepaidTestHooks.relayBackupSilent(); });
      const t0 = Date.now(); while (!relay.st.log.some(e => e.t === 'seghang') && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50));
      await check(relay.st.log.some(e => e.t === 'seghang'), `setup: an upload whose response never arrives must be in flight (log ${JSON.stringify(relay.st.log.map(e => e.t))})`);
      await goGuard(page);
      await page.locator('[data-a="cloud-backup-delete"]').click();
      await choiceTitle(page); await pick(page, 'del');
      const t1 = Date.now(); while (!relay.st.log.some(e => e.t === 'delete') && Date.now() - t1 < 15000) await new Promise(r => setTimeout(r, 50));
      const waited = Date.now() - t1;
      await check(relay.st.log.some(e => e.t === 'delete'), `the delete must go ahead after the wait cap even though the upload never finishes (waited ${waited}ms, log ${JSON.stringify(relay.st.log.map(e => e.t))})`);
      for (let i = 0; i < 40 && await page.locator('.busy').count(); i += 1) await page.waitForTimeout(100);
      await check(!(await page.locator('.busy').count()), 'the "deleting" busy screen must clear without a reload');
      const toastTxt = await page.evaluate(() => { const el = document.querySelector('.toast'); return el ? el.innerText : ''; });
      await check(toastTxt.includes('서버 백업을 지웠어요'), `the delete must report success (got ${JSON.stringify(toastTxt)})`);
      // 이제 멈춰 있던 응답이 뒤늦게 온다 — 무효가 된 업로드는 머리도, '성공' 기록도 남기지 않아야 한다.
      if (relay.st.segHangRelease) relay.st.segHangRelease();
      await page.evaluate(() => window.__b60hang);
      await page.waitForTimeout(1500);
      const log = relay.st.log.map(e => e.t);
      const di = log.indexOf('delete');
      await check(di >= 0 && !log.slice(di + 1).some(x => x === 'seg' || x === 'segstart' || x === 'seghang' || x === 'head'), `after the delete the woken upload must not send another segment or head (log ${JSON.stringify(log)})`);
      await check(!relay.st.head.get(RID) && ![...((relay.st.segs.get(RID)) || new Map()).values()].some(m => m.size), `the server backup must stay deleted (head ${!!relay.st.head.get(RID)})`);
      const m = await metaOf(page);
      await check(m.cloudBackupState == null && m.lastCloudBackupAt == null && m.autoCloudBackup === false, `the woken upload must not record a success (got ${JSON.stringify({ st: m.cloudBackupState && { lastOkAt: m.cloudBackupState.lastOkAt }, last: m.lastCloudBackupAt, auto: m.autoCloudBackup })})`);
      await page.evaluate(() => { window.__cloudDeleteWaitMs = 0; window.__relayTimeoutMs = 0; });
    });
    relay.st.segHang = false; if (relay.st.segHangRelease) relay.st.segHangRelease();

    // ── (C) 앱 10: 충전·잔액 조정·직원 등록 모달의 입력값 보존 ──
    await guard('modal-drafts', async () => {
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      const past = (() => { const d = new Date(Date.now() - 3 * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
      // 충전: 값 넣기 → 강제 render → 그대로
      await inject(page, 'topup', 'c60-e1'); await page.waitForSelector('#topupAmount', { timeout: 5000 });
      await page.locator('#topupAmount').fill('90000'); await page.locator('#topupReason').fill('3월분 선입금'); await page.locator('#topupDate').fill(past);
      await page.evaluate(() => window.__prepaidTestHooks.forceRender());
      let v = await vals(page, ['topupAmount', 'topupReason', 'topupDate']);
      await check(JSON.stringify(v) === JSON.stringify(['90000', '3월분 선입금', past]), `topup: a re-render must keep amount·reason·date (got ${JSON.stringify(v)})`);
      // 저장 실패(저장소 오류) → "다시 해 주세요" 뒤에도 그대로
      await page.evaluate(() => {
        window.__b60failOnce = true; const orig = IDBObjectStore.prototype.put;
        if (!window.__b60putPatched) { window.__b60putPatched = true; IDBObjectStore.prototype.put = function () { if (window.__b60failOnce && this.name === 'transactions') { window.__b60failOnce = false; try { this.transaction.abort(); } catch (e) { } throw new DOMException('harness forced write failure', 'AbortError'); } return orig.apply(this, arguments); }; }
      });
      const n0 = (await readDb(page)).transactions.length;
      await page.locator('[data-a="save-topup"]').click(); await page.waitForTimeout(700);
      v = await vals(page, ['topupAmount', 'topupReason', 'topupDate']);
      await check((await readDb(page)).transactions.length === n0 && JSON.stringify(v) === JSON.stringify(['90000', '3월분 선입금', past]), `topup: after a failed save the inputs must not fall back to 9,000원·today (got ${JSON.stringify(v)})`);
      await page.locator('[data-a="save-topup"]').click(); await page.waitForTimeout(700);
      const db = await readDb(page); const last = db.transactions.find(t => t.type === 'topup' && t.amount === 90000);
      await check(db.transactions.length === n0 + 1 && !!last && last.occurredAt > 0 && (await page.locator('#topupAmount').count()) === 0, 'topup: the retry must save the amount and date the owner typed, then close');
      await inject(page, 'topup', 'c60-e1'); await page.waitForSelector('#topupAmount', { timeout: 5000 });
      v = await vals(page, ['topupAmount', 'topupReason']);
      await check(v[0] === '9000' && v[1] === '', `topup: after a successful save the next modal starts fresh (got ${JSON.stringify(v)})`);
      await page.locator('.modal-actions [data-a="close-modal"]').first().click();
      // 잔액 조정
      await inject(page, 'adjust', 'c60-e2'); await page.waitForSelector('#adjustBalance', { timeout: 5000 });
      await page.locator('#adjustBalance').fill('12345'); await page.locator('#adjustReason').fill('장부 대조'); await page.locator('#adjustDate').fill(past);
      await page.evaluate(() => window.__prepaidTestHooks.forceRender());
      v = await vals(page, ['adjustBalance', 'adjustReason', 'adjustDate']);
      await check(JSON.stringify(v) === JSON.stringify(['12345', '장부 대조', past]), `adjust: a re-render must keep the new balance·reason·date (got ${JSON.stringify(v)})`);
      await page.locator('.modal-actions [data-a="close-modal"]').first().click();
      await inject(page, 'adjust', 'c60-e2'); await page.waitForSelector('#adjustBalance', { timeout: 5000 });
      v = await vals(page, ['adjustReason']);
      await check(v[0] === '', 'adjust: cancelling clears what was typed (next open starts fresh)');
      await page.locator('.modal-actions [data-a="close-modal"]').first().click();
      // 직원 등록·수정
      await inject(page, 'add-employee'); await page.waitForSelector('#empName', { timeout: 5000 });
      await page.locator('#empOrg').fill('한빛물산'); await page.locator('#empDept').fill('영업팀'); await page.locator('#empName').fill('최입력'); await page.locator('#empOpen').fill('45000'); await page.locator('#empNote').fill('메모 하나');
      await page.evaluate(() => window.__prepaidTestHooks.forceRender());
      v = await vals(page, ['empOrg', 'empDept', 'empName', 'empOpen', 'empNote']);
      await check(JSON.stringify(v) === JSON.stringify(['한빛물산', '영업팀', '최입력', '45000', '메모 하나']), `add employee: a re-render must keep every field (got ${JSON.stringify(v)})`);
      await page.locator('.modal-actions [data-a="close-modal"]').first().click();
      await inject(page, 'edit-employee', 'c60-e3'); await page.waitForSelector('#empName', { timeout: 5000 });
      await page.locator('#empName').fill('박고침'); await page.locator('#empDept').fill('재무과');
      await page.evaluate(() => window.__prepaidTestHooks.forceRender());
      v = await vals(page, ['empName', 'empDept']);
      await check(JSON.stringify(v) === JSON.stringify(['박고침', '재무과']), `edit employee: a re-render must keep the edits, not the saved values (got ${JSON.stringify(v)})`);
      await page.locator('.modal-actions [data-a="close-modal"]').first().click();
    });

    // ── (F4) 보관 칸: 서버 등록이 다른 열쇠로 바뀐 가게 — [되찾기] > [서버에서 되찾기]가 옛 백업을 찾아 같은 확인창으로 되돌린다 ──
    let arcEntry = null;
    await guard('archive-registered-device', async () => {
      const r0 = await runCloud(page);
      await check(r0.ok && !!relay.st.head.get(RID), `setup: a fresh server backup (got ${JSON.stringify(r0)})`);
      // 인수: 옛 백업·옛 공개키 → 보관 칸, 등록은 다른 열쇠
      arcEntry = { head: relay.st.head.get(RID), segs: relay.st.segs.get(RID) || new Map(), archived_at: Date.now(), keep_until: Date.now() + 29 * DAY };
      relay.st.archive.set(RID + '|' + pubA, arcEntry);
      relay.st.head.delete(RID); relay.st.segs.delete(RID); relay.st.reg.set(RID, otherPub);
      const before = await readDb(page); const m0 = await metaOf(page);
      const reg0 = relay.st.registers.length;
      relay.st.log.length = 0;
      await goGuard(page);
      await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud');
      let t = await choiceTitle(page);
      await check(t === '이 백업으로 되돌릴까요?', `a key-swapped shop must reach the normal restore confirmation from the archive (got ${JSON.stringify(t)})`);
      await pick(page, 'go');
      t = await choiceTitle(page); const txt = await choiceText(page);
      await check(t === '되찾기를 마쳤어요' && txt.includes('다른 기기(다른 열쇠)'), `the result must say the shop is now registered with another key (got ${JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 300))})`);
      await pick(page, 'ok');
      const log = relay.st.log.map(e => e.t);
      await check(log.includes('achallenge') && log.includes('aget') && log.includes('asegget') && !log.includes('headget'), `the archive must be read via its own endpoints, head then segments (log ${JSON.stringify(log)})`);
      await check(relay.st.registers.length === reg0, 'restoring from the archive must not try to register');
      const after = await readDb(page); const m1 = await metaOf(page);
      const ids = db => db.transactions.map(x => x.id + ':' + x.amount).sort().join(',');
      await check(ids(after) === ids(before) && m1.restaurantId === RID && m1.pubKey === pubA && Number(m1.lastCloudBackupAt || 0) === Number(m0.lastCloudBackupAt || 0) && m1.shopTel === TEL,
        `archive restore keeps device registration·key·last server-backup time·shop phone (got ${JSON.stringify({ rid: m1.restaurantId, lc: [m0.lastCloudBackupAt, m1.lastCloudBackupAt], tel: m1.shopTel })})`);
      await check(relay.st.violations.length === 0, `no contract violation (got ${JSON.stringify(relay.st.violations)})`);
      // 보관 칸에 없으면 사람 말로
      relay.st.archive.delete(RID + '|' + pubA);
      await goGuard(page);
      await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page); await pick(page, 'cloud');
      t = await choiceTitle(page); const t2 = await choiceText(page);
      await check(t === '서버에 남은 예전 백업이 없어요' && t2.includes('30일'), `no archive → "서버에 남은 예전 백업이 없어요(30일…)" (got ${JSON.stringify(t + ' / ' + t2.replace(/\s+/g, ' ').slice(0, 160))})`);
      await pick(page, 'ok');
    });

    // ── (F4) 등록이 막힌 기기(스스로 해제 → 남이 인수 → 다시 등록하다 401)도 같은 [서버에서 되찾기]로 ──
    await guard('archive-blocked-device', async () => {
      relay.st.archive.set(RID + '|' + pubA, arcEntry);
      await putAll(page, { meta: { restaurantId: '', relayRegisteredAt: null, relayStoreName: '', storeRegisterBlocked: { id: RID, name: '전화식당', addr: '', at: Date.now() } } });
      await reloadUnlock(page);
      await goGuard(page);
      await page.locator('[data-a="guard-restore"]').click(); await choiceTitle(page);
      await check((await page.locator('.choice-modal [data-val="cloud"]').count()) === 1, 'a blocked device that once uploaded a server backup must be offered 서버에서 되찾기');
      await pick(page, 'cloud');
      let t = await choiceTitle(page); await pick(page, 'go');
      t = await choiceTitle(page);
      await check(t === '되찾기를 마쳤어요', `the blocked device must restore from the archive (got ${JSON.stringify(t)})`);
      await pick(page, 'ok');
      const m = await metaOf(page);
      await check(!m.restaurantId && m.storeRegisterBlocked && m.storeRegisterBlocked.id === RID, `after an archive restore the device stays unregistered (blocked) — the archive's registration is not imported (got ${JSON.stringify({ rid: m.restaurantId, blocked: m.storeRegisterBlocked })})`);
    });

    // ── (F1) relayRegister: 열쇠가 있으면 언제나 소유 증명을 싣는다(휴지통 되돌리기) ──
    await guard('register-token', async () => {
      relay.st.reg.set(RID, pubA); relay.st.dereg.add(RID); relay.st.compat = false; relay.st.names.set(RID, '전화식당');
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'enroll-auto');
      const n0 = relay.st.registers.length, d0 = A.dialogs.length;
      await page.locator('[data-a="retry-blocked-register"]').click();
      await page.waitForFunction(() => { const H = window.__prepaidTestHooks; return !!H; }, null);
      const t0 = Date.now(); while (relay.st.registers.length === n0 && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50));
      await page.waitForTimeout(800);
      const rq = relay.st.registers[n0];
      await check(!!rq && !!rq.auth_token, `a device with the shop key must send an ownership token even before relayRegisteredAt (got ${JSON.stringify(rq && { token: !!rq.auth_token })})`);
      const m = await metaOf(page);
      await check(m.restaurantId === RID && Number(m.relayRegisteredAt || 0) > 0 && !m.storeRegisterBlocked && !relay.st.dereg.has(RID) && A.dialogs.length === d0, `the same-key reactivation must succeed with the token (got ${JSON.stringify({ rid: m.restaurantId, at: m.relayRegisteredAt, blocked: m.storeRegisterBlocked, dialogs: A.dialogs.slice(d0) })})`);
      relay.st.compat = true;
    });

    // ── (F3) 등록의 새 오류 — 3초 토스트가 아니라 창에 이유 + 다음 행동 ──
    for (const code of ['state_conflict', 'takeover_conflict', 'store_name_required']) {
      await guard('register-' + code, async () => {
        await putAll(page, { meta: { restaurantId: '', relayRegisteredAt: null, relayStoreName: '', storeRegisterBlocked: { id: RID, name: '전화식당', addr: '', at: Date.now() } } });
        await reloadUnlock(page);
        await page.locator('[data-a="screen"][data-screen="settings"]').click();
        await openSettingsCard(page, 'enroll-auto');
        relay.st.registerFail = code;
        await page.locator('[data-a="retry-blocked-register"]').click();
        const t = await choiceTitle(page, 15000).catch(() => '');
        const txt = t ? await choiceText(page) : '';
        relay.st.registerFail = '';
        const want = code === 'store_name_required' ? '가게 이름이 비어 있어요' : '그 사이 가게 등록이 바뀌었어요';
        await check(t === want && !/[a-z]+_[a-z]+/.test(txt) && (code === 'store_name_required' ? txt.includes('다시 골라') : txt.includes('등록 상태를 다시 확인')), `${code} must stay on screen as a dialog with the reason and the next step (got ${JSON.stringify(t + ' / ' + txt.replace(/\s+/g, ' ').slice(0, 200))})`);
        if (t) await pick(page, 'ok');
      });
    }
    await check(A.problems.length === 0, `device A: no page error (got ${JSON.stringify(A.problems.slice(0, 3))})`);
  } finally { await A.ctx.close().catch(() => {}); }

  // ═════ (D) 앱 11: 기관 자료 요청이 끝나지 않아도 장부부터 열린다 ═════
  await guard('agency-boot', async () => {
    const files = new Map();
    for (const f of ['agency-index.json', 'agency-departments.json', 'agency-depts/seoul.json']) files.set(f, await fsp.readFile(path.join(__dirname, '..', f), 'utf8'));
    for (const mode of ['late', 'hang']) {
      const D = await newCtx({ blockSW: true });
      const p = D.page;
      const held = [];
      try {
        await p.goto(url, { waitUntil: 'load' });
        await p.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 });
        await putAll(p, { meta: { setupComplete: true, welcomeSeen: true, termsAgreedAt: Date.now(), pinHash: legacyPin, shopName: '기관식당', departments: ['세무과'], orgName: '광진구청' },
          employees: [emp('d-e1', '정기관', '세무과')], transactions: [tx('d-t1', 'd-e1', 'open', 20000, 1)] });
        await resealChain(p);
        // 기관 자료: late = 2.5초 뒤 응답, hang = 영영 응답 없음
        await D.ctx.route(/agency-(index|departments)\.json|agency-depts\//, async route => {
          const f = [...files.keys()].find(k => route.request().url().includes(k));
          if (mode === 'hang') { held.push(route); return; }
          await new Promise(r => setTimeout(r, 2500));
          await route.fulfill({ status: 200, contentType: 'application/json', body: files.get(f) || '{}' }).catch(() => {});
        });
        // 시간 제한(앱 4초)을 하니스에서는 1초로 줄인다(E2E 훅) — 요청 둘(인덱스·예전 목록)이 차례로 포기하는 데 걸리는 시간만 짧아진다.
        if (mode === 'hang') await D.ctx.addInitScript(() => { window.__agencyFetchMs = 1000; });
        const t0 = Date.now();
        await p.reload({ waitUntil: 'commit' });
        const shown = await p.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 8000 }).then(() => true, () => false);
        const dt = Date.now() - t0;
        await check(shown && dt < 2400, `${mode}: the lock/customer screen must open before the agency data arrives (${dt}ms, shown ${shown})`);
        await unlockPin(p); await awaitUnlocked(p);
        await check((await p.locator('.nav, [data-a="screen"][data-screen="home"]').count()) > 0, `${mode}: the ledger home must be usable`);
        if (mode === 'late') {
          await p.waitForTimeout(3000);
          await p.locator('[data-a="screen"][data-screen="settings"]').click();
          await openSettingsCard(p, 'depts');
          const sel = await p.locator('#regionSelectSettings').count();
          await check(sel === 1, `late: agency data that arrives after the ledger opened must still fill the settings picker (region select ${sel})`);
        } else {
          await p.waitForTimeout(2500);
          await p.locator('[data-a="screen"][data-screen="settings"]').click();
          await openSettingsCard(p, 'depts');
          const tools = await p.locator('.agency-tools').innerText().catch(() => '');
          await check(tools.includes('불러올 수 없습니다') && (await p.locator('[data-a="agency-refresh"]').count()) === 1, `hang: after the time limit the picker must say why and offer [목록 불러오기] (got ${JSON.stringify(tools)})`);
          await D.ctx.unroute(/agency-(index|departments)\.json|agency-depts\//);
          await D.ctx.route(/agency-(index|departments)\.json|agency-depts\//, route => { const u = route.request().url(); const f = [...files.keys()].find(k => u.includes(k)); return route.fulfill({ status: 200, contentType: 'application/json', body: files.get(f) || '{}' }); });
          await p.locator('[data-a="agency-refresh"]').click();
          await p.waitForSelector('#regionSelectSettings', { timeout: 10000 });
          await check(true, 'hang: [목록 불러오기] loads the agency list once the network answers');
        }
      } finally { held.forEach(r => r.abort().catch(() => {})); await D.ctx.close().catch(() => {}); }
    }
  });

  console.log(`beta.60c: ${passed} checks passed${fails.length ? `, ${fails.length} failed` : ''}`);
  return { passed, fails };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// beta.60b A-ui — 카카오톡 오픈채팅 링크 숨김(앱)·홈 [손님 셀프 조회] 주황 버튼·가게 찾기 우편번호 칸 없음.
//   E2E_ONLY=beta60d 로 이 블록만, E2E_SOFT=1 로 단언별 실패 목록. [그만두기] 동작은 harness/dongsearch.e2e.mjs(시나리오 L·L2·L3)가 본다.
// ═════════════════════════════════════════════════════════════════════════════════════
async function runBeta60d(browser, url, cors) {
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.60d] ' + msg);
  };
  const guard = async (label, fn) => {
    if (process.env.E2E_VERBOSE) console.log('  · ' + label);
    try { await fn(); } catch (err) { if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 300)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 300)}`); }
  };
  const KAKAO_RE = /카톡|카카오|오픈채팅/;
  const LEAD = '접수 이메일을 등록해 두면, 담당자 화면에 [이메일로 보내기] 버튼이 생겨요.';
  const HINT = '가게용 이메일을 넣어 주세요. 담당자 화면에 보여요';
  const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
  const relay = makeBackupRelay(cors);
  const RID = 'rid-b60d', KEEP = 'https://open.kakao.com/o/keepMe60d';
  const contactBodies = [];
  const newCtx = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
    await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
    await ctx.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
    await ctx.route('**/api/registered**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
    await ctx.route('**/api/challenge**', relay.handle);
    await ctx.route('**/api/ledger-backup**', relay.handle);
    await ctx.route('**/api/register-key**', relay.handle);
    await ctx.route('**/api/contact**', async route => {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      contactBodies.push(b);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
    });
    const page = await ctx.newPage();
    const D = { ctx, page, dialogs: [], problems: [] };
    page.on('dialog', async d => { D.dialogs.push(d.type() + ': ' + d.message()); await d.accept().catch(() => {}); });
    page.on('pageerror', e => D.problems.push(String(e && e.message || e)));
    return D;
  };
  const putMeta = (page, meta) => page.evaluate(m => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { const t = req.result.transaction(['meta'], 'readwrite'); Object.entries(m).forEach(([k, v]) => t.objectStore('meta').put({ key: k, value: v })); t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error); };
  }), meta);
  const metaOf = async page => (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
  const awaitUnlocked = page => page.waitForFunction(() => { const H = window.__prepaidTestHooks; return !!H && H.lockState && H.lockState().locked === false; }, null, { timeout: 20000 });

  // ── (1) 처음 설정: 1/3 우편번호 칸 없음 → 3/3 오픈채팅 칸 없음, 접수 이메일 하나 ──
  const A = await newCtx();
  try {
    await guard('onboarding', async () => {
      const page = A.page;
      await page.goto(url, { waitUntil: 'load' });
      await passWelcome(page);
      const s1 = await page.evaluate(() => ({ ids: [...document.querySelectorAll('.setup input')].map(e => e.id), t: document.querySelector('.setup').innerText }));
      await check(!s1.ids.includes('setupStoreZip') && s1.ids.includes('setupStoreName') && s1.ids.includes('setupStoreRegion') && !/우편번호/.test(s1.t),
        `1/3: no postcode field or postcode wording (inputs ${JSON.stringify(s1.ids)})`);
      await page.locator('[data-a="setup-manual-toggle"]').click();
      await page.locator('#setupManualName').fill('카톡숨김식당'); await page.locator('#setupManualAddr').fill('서울특별시 광진구 구의동 1');
      await page.locator('[data-a="setup-manual-save"]').click(); await page.waitForSelector('[data-a="setup-next"]'); await page.locator('[data-a="setup-next"]').click();
      await page.waitForSelector('[data-a="setup-to-contact"]'); await page.locator('[data-a="setup-to-contact"]').click();
      await page.waitForSelector('#setupContactEmail');
      const s3 = await page.evaluate(() => ({ kakao: !!document.getElementById('setupContactKakao'), t: document.querySelector('.setup').innerText, inputs: [...document.querySelectorAll('.setup .form input')].map(e => e.id) }));
      await check(!s3.kakao && JSON.stringify(s3.inputs) === JSON.stringify(['setupContactEmail']), `3/3: the only contact field is the intake email (inputs ${JSON.stringify(s3.inputs)})`);
      await check(!KAKAO_RE.test(s3.t), `3/3: no KakaoTalk / open-chat wording on screen (got ${JSON.stringify(s3.t.slice(0, 240))})`);
      await check(s3.t.includes(LEAD) && s3.t.includes(HINT), '3/3: says the intake email turns on [이메일로 보내기] and asks for a shop email');
      await page.locator('#setupContactEmail').fill('owner@b60d.example');
      await page.locator('#setupTermsChk').check();
      await page.locator('[data-a="setup-complete"]').click();
      await typePin(page, ['1', '2', '3', '4', '1', '2', '3', '4']);
      await page.waitForSelector('[data-a="guide-dismiss"]', { timeout: 15000 });
      const m = await metaOf(page);
      await check(m.contactEmail === 'owner@b60d.example' && !m.contactKakaoLink, `onboarding saves the email and no open-chat link (got ${JSON.stringify({ e: m.contactEmail, k: m.contactKakaoLink })})`);
      await check(A.problems.length === 0, `onboarding: no page errors (${JSON.stringify(A.problems.slice(0, 2))})`);
    });
  } finally { await A.ctx.close().catch(() => {}); }

  // ── (2) 등록된 가게: 설정의 가게 연락처 카드 · 이메일 저장 때 이미 저장된 오픈채팅 값 보존 · 홈 주황 버튼 ──
  const B = await newCtx();
  try {
    const page = B.page;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 });
    await page.waitForTimeout(200);
    const now0 = Date.now();
    await putMeta(page, { setupComplete: true, welcomeSeen: true, termsAgreedAt: now0, pinHash: legacyPin, shopName: '보존식당', shopAddr: '서울특별시 광진구 구의동 1', departments: ['세무과'], orgName: '광진구청',
      storeRegisterPending: false, restaurantId: RID, relayStoreName: '보존식당', relayRegisteredAt: now0, districtSyncedAt: now0, myKeyBackedUpAt: now0, autoCloudBackup: false,
      contactKakaoLink: KEEP, contactEmail: 'old@b60d.example' });
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page); await awaitUnlocked(page);
    const pub = (await metaOf(page)).pubKey;
    relay.st.reg.set(RID, pub); relay.st.names.set(RID, '보존식당');
    await check(!!pub, 'setup: the device must have its shop key');

    await guard('home-customer-button', async () => {
      await page.locator('[data-a="screen"][data-screen="home"]').click().catch(() => {});
      await page.waitForSelector('[data-a="hand-to-customer"]', { timeout: 8000 });
      const c = await page.evaluate(() => {
        const lum = rgb => { const v = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
        const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
        const h = document.querySelector('[data-a="hand-to-customer"]'), e = document.querySelector('[data-a="go-employees"]');
        const hs = getComputedStyle(h), es = getComputedStyle(e);
        return { bg: hs.backgroundColor, img: hs.backgroundImage, fg: hs.color, ratio: ratio(hs.backgroundColor, hs.color), empBg: es.backgroundColor, empFg: es.color, cls: h.className };
      });
      await check(c.bg === 'rgb(194, 65, 12)' && c.img === 'none' && c.fg === 'rgb(255, 255, 255)', `[손님 셀프 조회] is orange (#c2410c) with white text (got ${JSON.stringify(c)})`);
      await check(c.ratio >= 4.5, `[손님 셀프 조회] text contrast must be at least 4.5:1 (got ${c.ratio.toFixed(2)})`);
      await check(c.empBg === 'rgb(255, 255, 255)', `[직원 목록 관리] stays white (got ${c.empBg})`);
      // 눌렀을 때(:active)·키보드 초점(:focus-visible)도 같은 주황 계열·흰 글씨로 대비 4.5:1 이상 — 규칙을 직접 읽는다(누르는 순간 화면이 바뀌므로).
      const rules = await page.evaluate(() => {
        const out = [];
        for (const sh of document.styleSheets) { let rs; try { rs = sh.cssRules; } catch (_) { continue; } for (const r of rs) if (r.selectorText && /\.handoff:(active|focus-visible)/.test(r.selectorText)) out.push({ sel: r.selectorText, bg: r.style.backgroundColor, fg: r.style.color }); }
        return out;
      });
      const lumHex = rgb => { const v = rgb.match(/\d+/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      const okRule = sel => { const r = rules.find(x => x.sel.includes(sel)); return !!r && /rgb/.test(r.bg) && /rgb\(255, 255, 255\)/.test(r.fg) && (1.05 / (lumHex(r.bg) + 0.05)) >= 4.5; };
      await check(okRule(':active') && okRule(':focus-visible'), `pressed / focused states keep white text on dark orange, 4.5:1 or more (got ${JSON.stringify(rules)})`);
    });

    await guard('settings-contact-card', async () => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      const head = await page.locator('.fold-head[data-card="contact"]').innerText();
      await check(!KAKAO_RE.test(head) && head.includes('접수 이메일'), `the contact card summary must not mention KakaoTalk (got ${JSON.stringify(head)})`);
      await openSettingsCard(page, 'contact');
      const card = await page.evaluate(() => { const h = document.querySelector('.fold-head[data-card="contact"]'); const box = h.closest('.card') || h.parentElement; return { t: box.innerText, kakao: !!document.getElementById('contactKakao'), inputs: [...box.querySelectorAll('input')].map(e => e.id) }; });
      await check(!card.kakao && JSON.stringify(card.inputs) === JSON.stringify(['contactEmail']), `the contact card has only the intake email field (got ${JSON.stringify(card.inputs)})`);
      await check(!KAKAO_RE.test(card.t), `the contact card has no KakaoTalk / open-chat wording (got ${JSON.stringify(card.t.slice(0, 300))})`);
      await check(card.t.includes(LEAD) && card.t.includes(HINT), 'the contact card says the intake email turns on [이메일로 보내기]');
      await page.locator('#contactEmail').fill('new@b60d.example');
      contactBodies.length = 0;
      await page.locator('[data-a="contact-save"]').click();
      await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      const b = contactBodies[contactBodies.length - 1] || {};
      await check(!card.kakao && contactBodies.length === 1 && b.email === 'new@b60d.example' && b.kakao_link === KEEP && b.restaurant_id === RID,
        `with the open-chat field hidden, saving the email must send the already-saved open-chat link unchanged so the server keeps it (got ${JSON.stringify(contactBodies)})`);
      const m = await metaOf(page);
      await check(m.contactKakaoLink === KEEP && m.contactEmail === 'new@b60d.example', `the device keeps the saved open-chat link (got ${JSON.stringify({ k: m.contactKakaoLink, e: m.contactEmail })})`);
      await check(B.dialogs.length === 0 && B.problems.length === 0, `no native dialog or page error (${JSON.stringify([...B.dialogs, ...B.problems].slice(0, 3))})`);
    });

    await guard('settings-store-search-no-postcode', async () => {
      // 설정의 가게 찾기 창(등록된 가게의 [변경])에도 우편번호 칸이 없다.
      await openSettingsCard(page, 'enroll-auto');
      await page.locator('[data-a="relay-find-store"]').first().click();
      await page.waitForSelector('#storeName', { timeout: 8000 });
      const mt = await page.evaluate(() => ({ t: document.querySelector('.modal').innerText, ids: [...document.querySelectorAll('.modal input')].map(e => e.id) }));
      await check(JSON.stringify(mt.ids) === JSON.stringify(['storeName', 'storeRegion']) && !/우편번호/.test(mt.t), `the settings store-search window has no postcode field or wording (got ${JSON.stringify(mt.ids)})`);
      await page.locator('[data-a="close-modal"]').first().click();
    });
  } finally { await B.ctx.close().catch(() => {}); }

  console.log(`beta.60d: ${passed} checks passed${fails.length ? `, ${fails.length} failed` : ''}`);
  return { passed, fails };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// beta.60b A-brand — 대표 이름 "밥장부"(홈 화면 아이콘 이름·탭 제목·머리글·앱을 부르는 말·내려받는 파일 이름).
//   "선입금대장"은 풀이말(manifest description·앱 정보 맨 아래 "밥장부(선입금대장)")과 백업 파일 **안의** 값(appName)에만 남는다.
//   ⚠️ 파일 형식 불변 — 새로 만든 백업의 appName은 예전 값('선입금대장') 그대로다(beta55c가 새 파일 3종의 appName을 본다).
//   예전 파일(harness/fixtures/beta54-*.json, appName '선입금대장')이 계속 열리는지는 beta55c, 예전 앱으로 만든 장부는 upgrade-check.sh가 본다.
//   E2E_ONLY=beta60e 로 이 블록만, E2E_SOFT=1 로 단언별 실패 목록.
// ═════════════════════════════════════════════════════════════════════════════════════
async function runBeta60e(browser, url, cors) {
  const soft = !!process.env.E2E_SOFT;
  const fails = [];
  let passed = 0;
  const check = async (cond, msg) => {
    if (cond) { passed += 1; return true; }
    if (soft) { fails.push(msg); console.log('  ✗ ' + msg); return false; }
    throw new Error('[beta.60e] ' + msg);
  };
  const guard = async (label, fn) => {
    if (process.env.E2E_VERBOSE) console.log('  · ' + label);
    try { await fn(); } catch (err) { if (!soft) throw err; fails.push(`${label}: ${String(err && err.message || err).slice(0, 300)}`); console.log(`  ✗ ${label}: ${String(err && err.message || err).slice(0, 300)}`); }
  };

  // ── (a) manifest — 이름만 바뀌고 설치 정체성(start_url·display·아이콘)은 그대로, id·scope 키는 새로 생기지 않는다 ──
  await guard('manifest', async () => {
    const m = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
    await check(m.name === '밥장부' && m.short_name === '밥장부', `manifest name/short_name must be 밥장부 (got ${JSON.stringify({ name: m.name, short_name: m.short_name })})`);
    await check(m.start_url === '.' && m.display === 'standalone' && !('id' in m) && !('scope' in m),
      `manifest start_url/display unchanged and no new id/scope key — a different id makes installed tablets a separate app (got ${JSON.stringify({ start_url: m.start_url, display: m.display, id: m.id, scope: m.scope })})`);
    const icons = JSON.stringify(m.icons);
    await check(icons === JSON.stringify([
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]), `manifest icons unchanged (got ${icons})`);
    await check(typeof m.description === 'string' && m.description.includes('밥장부(선입금대장)'), `manifest description carries the 선입금대장 explanation (got ${JSON.stringify(m.description)})`);
    const twa = JSON.parse(await fsp.readFile(path.join(root, 'twa', 'twa-manifest.json'), 'utf8'));
    await check(twa.name === '밥장부' && twa.launcherName === '밥장부' && twa.packageId === 'kr.nulmaru.prepaid', `twa draft name/launcherName = 밥장부, packageId unchanged (got ${JSON.stringify({ n: twa.name, l: twa.launcherName, p: twa.packageId })})`);
  });

  // ── (a') 소스 — 화면 문구에는 '선입금대장'이 풀이말 "밥장부(선입금대장)"로만 남는다. 파일 안의 값(APP)은 그대로. ──
  await guard('source', async () => {
    const src = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
    await check(/<title>밥장부<\/title>/.test(src) && /<meta name="apple-mobile-web-app-title" content="밥장부">/.test(src), 'index.html: tab title and iOS home-screen title are 밥장부');
    await check(/const APP='선입금대장',BRAND='밥장부',/.test(src), 'the in-file value APP stays 선입금대장 (backup appName — file format unchanged) and BRAND is 밥장부');
    await check(!/\$\{APP\}|\|\|APP;/.test(src), 'APP (the in-file value) must not be used as on-screen text');
    const shown = src.split('\n').filter(l => !/^\s*\/\//.test(l) && !/const APP='선입금대장'/.test(l)).join('\n');
    const left = (shown.match(/.{0,4}선입금대장.{0,1}/g) || []);
    await check(left.length === 1 && left[0].includes('밥장부(선입금대장)'), `outside comments and the APP constant, 선입금대장 appears only as the explanation 밥장부(선입금대장) (got ${JSON.stringify(left)})`);
    await check(!/선입금대장_|선입금장부_/.test(src), 'no download file name starts with 선입금대장_ / 선입금장부_');
  });

  // ── (b)(d) 앱 — 탭 제목·머리글·손님 화면 기본 이름·앱 정보의 풀이말·내려받는 파일 이름·전달 파일 안내 ──
  const legacyPin = crypto.createHash('sha256').update('1234').digest('hex');
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
  await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not_found"}' }));
  await ctx.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
  await ctx.route('**/api/registered**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
  const page = await ctx.newPage();
  const problems = [], dialogs = [], downloads = [];
  page.on('pageerror', e => problems.push(String(e && e.message || e)));
  page.on('dialog', async d => { dialogs.push(d.type() + ': ' + d.message()); await d.accept().catch(() => {}); });
  page.on('download', d => downloads.push(d));
  const putMeta = meta => page.evaluate(m => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { const t = req.result.transaction(['meta'], 'readwrite'); Object.entries(m).forEach(([k, v]) => t.objectStore('meta').put({ key: k, value: v })); t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error); };
  }), meta);
  const visible = () => page.evaluate(() => document.getElementById('app').innerText);
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-a="setup-welcome-start"]', { timeout: 15000 });
    await check((await page.title()) === '밥장부', `the browser tab title is 밥장부 from the first screen (got ${JSON.stringify(await page.title())})`);
    await page.waitForTimeout(200);
    const now0 = Date.now();
    // 가게 이름이 비어 있으면 앱 이름이 대신 나오는 자리(손님 화면 머리)를 보려고 shopName을 비워 둔다.
    await putMeta({ setupComplete: true, welcomeSeen: true, termsAgreedAt: now0, pinHash: legacyPin, shopName: '', departments: ['세무과'], orgName: '광진구청', storeRegisterPending: false, autoCloudBackup: false });
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await page.waitForSelector('[data-a="hand-to-customer"]', { timeout: 10000 });

    await guard('home-header', async () => {
      const h1 = (await page.locator('.top .title h1').innerText()).trim();
      await check(h1 === '밥장부', `the home header title is 밥장부 (got ${JSON.stringify(h1)})`);
      await check((await page.title()) === '밥장부', 'the tab title stays 밥장부 after unlocking');
      const t = await visible();
      await check(!/선입금대장/.test(t), `the home screen does not call the app 선입금대장 (got ${JSON.stringify(t.slice(0, 200))})`);
    });

    await guard('settings-about', async () => {
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await page.waitForSelector('.fold-head[data-card="info"]', { timeout: 8000 });
      const h1 = (await page.locator('.top .title h1').innerText()).trim();
      await check(h1 === '밥장부', `the settings header title is 밥장부 (got ${JSON.stringify(h1)})`);
      await openSettingsCard(page, 'info');
      const t = await visible();
      const all = t.match(/.{0,4}선입금대장.{0,1}/g) || [];
      await check(all.length === 1 && all[0].includes('밥장부(선입금대장)'), `settings shows 선입금대장 only once, as the explanation 밥장부(선입금대장) in 앱 정보 (got ${JSON.stringify(all)})`);
    });

    await guard('history-csv-name', async () => {
      await page.locator('[data-a="screen"][data-screen="history"]').click();
      await page.waitForSelector('[data-a="export-csv"]', { timeout: 8000 });
      await check((await page.locator('.top .title h1').innerText()).trim() === '밥장부', 'the history header title is 밥장부');
      const d0 = downloads.length;
      await page.locator('[data-a="export-csv"]').click();
      for (let i = 0; i < 40 && downloads.length === d0; i++) await page.waitForTimeout(100);
      const name = downloads[d0] ? downloads[d0].suggestedFilename() : '';
      await check(/^밥장부_.+_\d{4}-\d{2}-\d{2}\.csv$/.test(name), `the ledger CSV file name starts with 밥장부_ (got ${JSON.stringify(name)})`);
    });

    await guard('direct-transfer-wrong-file', async () => {
      await page.locator('#directTransferFile').setInputFiles({ name: 'not-a-transfer.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
      let tt = '';
      for (let i = 0; i < 40 && !/전달 형식/.test(tt); i++) { await page.waitForTimeout(100); tt = (await page.locator('.toast').count()) ? await page.locator('.toast').innerText() : ''; }
      await check(tt.includes('밥장부 전달 형식이 아닙니다') && !tt.includes('선입금대장'), `a wrong transfer file is called "not a 밥장부 transfer file" (got ${JSON.stringify(tt)})`);
    });

    await guard('customer-screen-name', async () => {
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await page.locator('[data-a="hand-to-customer"]').click();
      await page.waitForSelector('.cust-screen .cust-shop', { timeout: 8000 });
      const shop = (await page.locator('.cust-screen .cust-shop').innerText()).trim();
      await check(shop === '밥장부', `with no shop name the customer screen head shows 밥장부 (got ${JSON.stringify(shop)})`);
    });
    await check(problems.length === 0 && dialogs.length === 0, `no page error or native dialog (${JSON.stringify([...problems, ...dialogs].slice(0, 3))})`);
  } finally { await ctx.close().catch(() => {}); }

  console.log(`beta.60e: ${passed} checks passed${fails.length ? `, ${fails.length} failed` : ''}`);
  return { passed, fails };
}

async function main() {
  await fsp.mkdir(path.join(root, 'harness', 'screenshots'), { recursive: true }).catch(() => {});
  const { server, url } = await startServer();
  const chromePath = findChrome();
  const browser = await chromium.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {})
  });
  // E2E_ONLY=beta55 — beta.55 블록만 돌린다(수정 전 코드에서 단언별 실패를 확인할 때 E2E_SOFT=1과 함께 쓴다).
  // E2E_ONLY=beta55b — beta.55 A1b(화면) 블록만.
  if (process.env.E2E_ONLY === 'beta55b') {
    try {
      const r = await runBeta55b(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
  // E2E_ONLY=beta55c — beta.55 A2(장부 지키기·백업·되찾기) 블록만.
  if (process.env.E2E_ONLY === 'beta55c') {
    try {
      const r = await runBeta55c(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
  // E2E_ONLY=beta60a — beta.60 A1(화면잠금 비밀번호 분실 복구) 블록만.
  if (process.env.E2E_ONLY === 'beta60a') {
    try {
      const r = await runBeta60a(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
  // E2E_ONLY=beta60b — beta.60 A2(명단·CSV: 합계 줄·동명이인 번호) 블록만.
  if (process.env.E2E_ONLY === 'beta60b') {
    try {
      const r = await runBeta60b(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
  // E2E_ONLY=beta60c — beta.60 A3a(서버 연동·백업·입력 보존·기관 자료) 블록만.
  if (process.env.E2E_ONLY === 'beta60c') {
    try {
      const r = await runBeta60c(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
  // E2E_ONLY=beta60d — beta.60b A-ui(오픈채팅 숨김·[손님 셀프 조회] 색·우편번호 칸 없음) 블록만.
  if (process.env.E2E_ONLY === 'beta60d') {
    try {
      const r = await runBeta60d(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
  // E2E_ONLY=beta60e — beta.60b A-brand(대표 이름 '밥장부'·파일 이름·manifest) 블록만.
  if (process.env.E2E_ONLY === 'beta60e') {
    try {
      const r = await runBeta60e(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
  if (process.env.E2E_ONLY === 'beta55') {
    try {
      const r = await runBeta55(browser, url, { 'Access-Control-Allow-Origin': '*' });
      process.exitCode = r.fails.length ? 1 : 0;
    } finally { await browser.close(); server.close(); }
    return;
  }
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
  // beta.49: 검색 결과 배지용 공개 엔드포인트. 기본은 "아무도 등록 안 함"(배지 0) — 배지가 켜지면
  //   가게를 고를 때 안내 alert가 하나 더 붙어 다른 시나리오(401 안내 alert 1회)의 개수 단언이 흔들린다.
  let registeredIdsBody = [];
  let registeredFail = false;
  // 안전망: 목이 없는 중계 API 호출은 전부 500으로 끊는다 — 로컬 e2e가 라이브 서버에 절대 닿지 않게 한다.
  //   Playwright는 **나중에 등록한 라우트가 이긴다** → 이 catch-all을 먼저 걸고 개별 목을 뒤에 건다.
  await context.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(storeSearchResults) }));
  await context.route('**/api/registered**', route => (registeredFail
    ? route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"boom"}' })
    : route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(registeredIdsBody) })));
  await context.route('**/api/inbox-count**', route => (inboxCountBody === 'netfail'
    ? route.abort('failed')
    : inboxCountBody === null
    ? route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"not found"}' })
    : route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(inboxCountBody) })));
  const dialogs = [];
  const consoleProblems = [];
  let promptAnswer = '초기화';
  // confirm()의 기본 응답은 [확인]이다(기존 흐름 전부 그대로). beta.25에서 **[취소]를 눌렀을 때**를
  //   검증할 자리가 생겨서(손님이 적어 둔 금액·서명을 지킬 것인가) 잠깐 false로 두는 스위치를 뒀다.
  let confirmAnswer = true;
  // beta.48: 한 흐름 안에서 1차는 [확인], 2차는 [취소]처럼 **메시지별로** 갈라야 하는 자리가 생겼다
  //   (미인증 초기화의 "최종 백업만 받고 지우지는 않는다" 시나리오). null이면 기존 동작 그대로다.
  let confirmDecider = null;

  page.on('dialog', async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === 'prompt') await dialog.accept(promptAnswer);
    else if (dialog.type() === 'confirm' && confirmDecider && !confirmDecider(dialog.message())) await dialog.dismiss();
    else if (dialog.type() === 'confirm' && !confirmAnswer) await dialog.dismiss();
    else await dialog.accept();
  });
  page.on('pageerror', err => consoleProblems.push(err.message));
  // E2E_DEBUG=1 이면 페이지 콘솔·대화상자를 실시간으로 흘려 본다(실패 지점 추적용).
  if (process.env.E2E_DEBUG) {
    page.on('console', m => console.log('PAGE', m.type(), m.text().slice(0, 300)));
    page.on('requestfailed', r => console.log('REQFAIL', r.url().slice(0, 140), r.failure() && r.failure().errorText));
  }
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleProblems.push(`${msg.type()}: ${msg.text()}`);
  });

  try {
    // beta.26 신설 시나리오는 "새 설치" 상태가 필요하므로 각자 독립 컨텍스트에서 먼저 돌린다.
    await runSearchOnboarding(browser, url, cors);
    await runDistrictHeal(browser, url, cors);
    await runWipeDeregister(browser, url, cors);
    await runSecurityHardening(browser, url, cors);
    await runBeta52(browser, url, cors);
    await runBeta55(browser, url, cors);
    await runBeta55b(browser, url, cors);
    { const r55c = await runBeta55c(browser, url, cors); if (r55c.fails.length) throw new Error('[beta.55c] ' + r55c.fails[0]); }
    { const r60a = await runBeta60a(browser, url, cors); if (r60a.fails.length) throw new Error('[beta.60a] ' + r60a.fails[0]); }
    { const r60b = await runBeta60b(browser, url, cors); if (r60b.fails.length) throw new Error('[beta.60b] ' + r60b.fails[0]); }
    { const r60c = await runBeta60c(browser, url, cors); if (r60c.fails.length) throw new Error('[beta.60c] ' + r60c.fails[0]); }
    { const r60d = await runBeta60d(browser, url, cors); if (r60d.fails.length) throw new Error('[beta.60d] ' + r60d.fails[0]); }
    { const r60e = await runBeta60e(browser, url, cors); if (r60e.fails.length) throw new Error('[beta.60e] ' + r60e.fails[0]); }

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
    // beta.26: 온보딩은 3단계다 — 옛 1/4(가게 정보 직접 입력)과 2/4(가게 검색)의 중복 입력을 하나로 합쳤다.
    await assert(await count(page, '[data-a="setup-store-skip"]') === 0, 'the old "나중에 등록할게요" step must be gone (its role moved to the 직접 입력 escape hatch)');
    await assert(await count(page, '[data-a="setup-skip"]') === 0, 'the old 1/4 "건너뛰기" must be gone with the merged step');

    // ── 1/3 우리 가게 찾기 — 여기서는 **직접 입력(탈출구)** 경로를 걷는다.
    //    검색으로 고르는 주 경로는 runSearchOnboarding(독립 컨텍스트)이 통째로 검증한다.
    //    이 흐름이 탈출구를 걷는 이유: 아래 이어지는 시나리오들이 "아직 등록되지 않은 가게" 상태를 전제로 한다.
    // beta.27: 환영 화면(0단계)을 먼저 지난다. 이 흐름의 관심사는 1/3부터이므로 헬퍼로 한 번에 넘긴다.
    await assert(await passWelcome(page) === true, 'a fresh install must open on the welcome screen');
    await assert((await page.locator('.setup-step').innerText()).includes('1 / 3'), 'store search must be step 1 of a 3-step onboarding');
    await assert(await count(page, '#setupManualName') === 0, 'the manual entry form must stay behind the escape hatch (search first)');
    // 서버 등록은 약관 동의(3/3) 이후에만 — 그 전에 register-key가 호출되면 안 된다.
    const registerCalls = [];
    let registerStatus = 200;
    let registerErrorCode = 'internal'; // 비200일 때의 서버 오류 코드(auth_required 시나리오에서 갈아끼운다)
    await context.route('**/api/register-key**', route => {
      registerCalls.push(JSON.parse(route.request().postData() || '{}'));
      return registerStatus === 200
        ? route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' })
        : route.fulfill({ status: registerStatus, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: registerErrorCode }) });
    });
    // S1 회귀 방지: 직접 입력으로 빠져나갈 길은 검색 전에도, 결과가 0건일 때도 항상 보여야 한다(막다른 길 금지).
    await assert(await count(page, '[data-a="setup-manual-toggle"]') === 1, 'the escape hatch must be available before searching (no dead end)');
    await page.locator('#setupStoreName').fill('Harness Shop');
    await page.locator('[data-a="setup-store-search"]').click();
    await page.waitForSelector('.empty');
    await assert(await count(page, '[data-a="setup-manual-toggle"]') === 1, 'the escape hatch must stay visible when a search returns nothing');
    const emptyHelp = await page.locator('.setup').innerText();
    await assert(emptyHelp.includes('사업자등록증의 상호'), 'a "search by the business-registration name" hint should follow the result list');

    await page.locator('[data-a="setup-manual-toggle"]').click();
    await page.waitForSelector('#setupManualName');
    await page.locator('#setupManualName').fill('Harness Shop');
    await page.locator('[data-a="setup-manual-save"]').click();
    await page.waitForTimeout(120);
    // 주소는 필수다 — 담당자 웹의 관할 목록이 이 주소에서 뽑은 district로만 찾아진다.
    await assert(await count(page, '[data-a="setup-next"]') === 0, 'the manual path must refuse to continue without an address');
    await page.locator('#setupManualAddr').fill('광진구 구의동');
    await page.locator('#setupManualTel').fill('02-111-2222');
    await page.locator('[data-a="setup-manual-save"]').click();
    await page.waitForSelector('[data-a="setup-next"]');
    await assert((await page.locator('.setup-selected').innerText()).includes('Harness Shop'), 'the manually entered store should show up as the selection');
    await assert((await page.locator('#setupStoreTel').inputValue()) === '02-111-2222', 'the manually entered phone number should carry over to the confirmation');
    await assert(registerCalls.length === 0, 'entering the store by hand must not register anything on the server');
    await page.locator('[data-a="setup-next"]').click();

    await page.waitForSelector('#agencySelectSetup');
    await assert((await page.locator('.setup-step').innerText()).includes('2 / 3'), 'department setup should be step 2 of 3');
    // ① 신규 설치는 기본 부서 0개로 시작해야 한다(사무실/관리팀/현장팀/영업팀 같은 하드코딩 기본값 제거).
    await assert(await page.locator('.dept-tag').count() === 0, 'a fresh install should start with zero default departments');
    await assert((await page.locator('#agencySelectSetup').inputValue()) === 'gwangjin', 'region address "광진구 구의동" should auto-select 광진구청 agency');
    await page.locator('[data-a="agency-add-all"][data-ctx="setup"]').click();
    await assert(await page.locator('.dept-tag', { hasText: '재무과' }).count() > 0, 'agency departments should be added during setup');
    // 2026-11 보건소 분리: 보건의료과는 더 이상 광진구청 밑에 없고 '광진구보건소'(별도 기관)에 있다 — 양쪽(앱·담당자 웹)이 같은 이름을 고르게 하는 규칙.
    await assert(await page.locator('.dept-tag', { hasText: '보건의료과' }).count() === 0, 'health-centre departments must not be listed under the district office any more');
    await assert(await page.locator('#agencySelectSetup option', { hasText: '광진구보건소' }).count() === 1, 'the agency list must offer the health centre as its own agency');
    await page.locator('[data-a="setup-to-contact"]').click();
    await page.waitForSelector('#setupContactEmail');
    await assert((await page.locator('.setup-step').innerText()).includes('3 / 3'), 'contact + terms should be the last (3rd) onboarding step');
    // beta.60b: 오픈채팅 링크 칸은 숨김(KAKAO_LINK_ENABLED=false) — 연락처는 접수 이메일 하나.
    await assert(await count(page, '#setupContactKakao') === 0, 'the open-chat link field must be hidden in onboarding 3/3 (beta.60b)');
    await page.locator('#setupContactEmail').fill('owner@harness-shop.example');
    // 약관 동의 게이트: 미체크 시 완료 버튼 비활성, 체크 시 활성화되어야 한다
    // beta.55(C4): 예전에는 동의 전 [완료]가 disabled였다(살아 보이는데 눌러도 무반응). 이제 버튼은 늘 눌리고,
    //   동의 없이 누르면 3/3에 그대로 남은 채 체크 칸 옆에 이유가 뜬다. 체크하면 이유가 사라진다.
    await assert(!(await page.locator('#setupCompleteBtn').isDisabled()), 'complete button must stay enabled (no disabled-but-active-looking button)');
    await page.locator('#setupCompleteBtn').click();
    await page.waitForTimeout(150);
    await assert(await count(page, '#setupCompleteBtn') === 1 && (await page.locator('#setupTermsChkWhy').innerText()).includes('동의'), 'tapping 완료 without consent must stay on 3/3 and say why next to the checkbox');
    await page.locator('#setupTermsChk').check();
    await assert((await page.locator('#setupTermsChkWhy').innerText()) === '', 'agreeing must clear the reason line');
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'onboarding-contact.png') }).catch(() => {});
    await page.locator('[data-a="setup-complete"]').click();

    await typePin(page, ['1', '2', '3', '4', '1', '2', '3', '4']);

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
    await assert(!setupMetaMap.contactKakaoLink, 'no open-chat link may be saved from onboarding while the field is hidden (beta.60b)');
    await assert(setupMetaMap.contactEmail === 'owner@harness-shop.example', 'contact email entered during onboarding should be saved locally');
    await assert(typeof setupMetaMap.termsAgreedAt === 'number' && setupMetaMap.termsAgreedAt > 0, 'terms agreement timestamp should be saved after onboarding');
    // 약관 동의 이력이 있으므로 홈 진입 시 일회성 약관 모달이 뜨지 않아야 한다
    await assert(await count(page, '[data-a="terms-agree"]') === 0, 'no one-time terms modal should appear once termsAgreedAt is set');

    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await assert(await count(page, '[data-a="new-month"]') === 0, 'new-month action must be removed');
    await assert(await count(page, '[data-a="full-reset"]') === 1, 'full-reset action must appear once');
    // beta.41: 앱만 삭제하면 서버 등록이 남는다 — 위험 작업 구역이 "삭제 전 초기화/등록 해제 먼저"를 안내해야 한다.
    await assert(await page.evaluate(() => document.body.textContent.includes('앱을 삭제하거나 기기를 바꾸기 전에는')),
      'the danger zone must warn that deleting the app alone leaves the server registration behind (beta.41)');
    await assert(await count(page, '[data-a="export-csv"]') === 0, 'standalone CSV export action must be removed from settings');

    // ── beta.27→29: 설정 카드 아코디언 ──────────────────────────────────────────
    //   beta.29에서 등록(자동/수동)·직원 목록까지 전부 1단 접힘으로 통일했다(사용자 결정). 계약은 셋이다.
    //     ① 모든 카드는 기본 접힘이되 **제목과 한 줄 요약은 항상 보인다**(무엇이 들어 있는지 모르는 접힘 금지).
    //     ② 그룹 제목(직원 선금대장 등록·장부 지키기·가게 기본설정)은 섹션 헤더로 **항상 보인다** — 2단 중첩 접힘 금지.
    //     ③ 머리글을 누르면 열리고 그 안의 버튼에 실제로 닿는다(기능이 사라진 게 아니라 접힌 것뿐이다).
    // 이 시점은 미등록 상태라 '가게 연락처(contact)' 카드는 아직 없다(등록 후에만 렌더).
    // beta.30: 부서 목록 관리는 직원 목록 관리 바로 아래다(등록·직원 관리와 같은 일감 — 사용자 지시).
    const foldedKeys = (await page.locator('.fold-head').evaluateAll(els => els.map(e => e.dataset.card)));
    // beta.55(A2): [장부 안전 저장·복원·검사]와 [폰을 잃어버려도 장부 되찾기]는 [장부 지키기] 카드 하나(data-card='ledger')로 합쳤다.
    await assert(JSON.stringify(foldedKeys) === JSON.stringify(['enroll-auto', 'enroll-manual', 'employees', 'depts', 'ledger', 'basic', 'pin', 'info']),
      `the collapsible settings cards must be exactly [자동·수동·직원 목록·부서·장부 지키기·가게 정보·PIN·앱 정보] in order (got ${JSON.stringify(foldedKeys)})`);
    // 위계 시각화(beta.30): 하위 카드 제목은 섹션 헤더(주항목)보다 15% 작아야 한다(20px → 17px).
    const titleSizes = await page.evaluate(() => {
      const px = el => parseFloat(getComputedStyle(el).fontSize);
      const groupHead = [...document.querySelectorAll('.section-head:not(.fold-head) .section-title')].find(t => t.textContent.includes('직원 선금대장 등록'));
      const cardTitle = document.querySelector('.fold-head[data-card="enroll-auto"] .section-title');
      return { group: groupHead ? px(groupHead) : 0, card: cardTitle ? px(cardTitle) : 0 };
    });
    await assert(titleSizes.group > 0 && titleSizes.card > 0 && Math.abs(titleSizes.card / titleSizes.group - 0.85) < 0.03,
      `a sub-card title must be ~15% smaller than its group header (got group ${titleSizes.group}px vs card ${titleSizes.card}px)`);
    const foldedOpen = await page.locator('.fold-head').evaluateAll(els => els.map(e => e.getAttribute('aria-expanded')));
    await assert(foldedOpen.every(v => v === 'false'), `every collapsible settings card must start collapsed (got ${JSON.stringify(foldedOpen)})`);
    // 그룹 제목(섹션 헤더)은 접히지 않고 항상 보인다 — 접힘은 카드 1단까지만.
    const settingsAppText = await page.locator('.app').innerText();
    for (const groupTitle of ['직원 선금대장 등록', '장부 지키기', '가게 기본설정']) {
      await assert(settingsAppText.includes(groupTitle), `the group header "${groupTitle}" must stay visible while its cards are collapsed`);
    }
    // 접힌 수동 등록의 본문은 DOM에 없고, 펼치면 빠른 등록 폼이 그대로 나타난다.
    await assert(await count(page, '[data-a="quick-add-employee"]') === 0, 'the collapsed 수동 등록 card must not leave its quick-add form in the DOM');
    await openSettingsCard(page, 'enroll-manual');
    await assert(await count(page, '[data-a="quick-add-employee"]') === 1, 'expanding 수동 등록 must reveal the quick-add form');
    // 접힌 카드도 제목 + 한 줄 요약을 읽을 수 있어야 한다.
    const foldSummaries = await page.locator('.fold-head').evaluateAll(els => els.map(e => ({
      title: e.querySelector('.section-title').innerText.trim(),
      kicker: e.querySelector('.section-kicker').innerText.trim()
    })));
    for (const f of foldSummaries) {
      await assert(f.title.length > 0 && f.kicker.length > 0, `a collapsed settings card must show both a title and a one-line summary (got ${JSON.stringify(f)})`);
    }
    // beta.45: 열쇠 백업은 자동 등록 카드(열쇠 지문 옆)로 옮겼다 — "놓치면 안 되는 일"이라는 성격은
    //   그대로이므로, 아직 안 했다면 **자동 등록 카드의 접힌 요약**이 그 사실을 말해야 한다.
    // beta.55(A2): 장부 지키기 카드의 접힌 요약은 상태 상자와 **같은 함수**(guardStatus)에서 나온다.
    {
      const gs = await page.evaluate(() => window.__prepaidTestHooks.guardStatus());
      const gk = foldSummaries.find(f => f.title === '장부 지키기');
      await assert(!!gk && gk.kicker === gs.summary, `the 장부 지키기 summary must be the status function's sentence (got ${JSON.stringify(gk)} vs ${JSON.stringify(gs.summary)})`);
      await assert(!gs.reg && gk.kicker.includes('가게를 등록하면 서버에도'), 'an unregistered store\'s 장부 지키기 summary must not pretend a server backup exists');
    }
    // (등록 전이라 열쇠 자체가 없다 — 열쇠 백업 요약이 실제로 실리는지는 등록된 상태에서 ⑬이 검증한다.)
    // 접힌 상태에서는 본문이 DOM에 없다(숨김이 아니라 미렌더) → 펼치면 그 자리에 그대로 나타난다.
    await assert(await count(page, '.settings-card [data-a="backup-now"]') === 0, 'a collapsed card must not leave its actions in the DOM');
    await openSettingsCard(page, 'ledger');
    await assert(await count(page, '.settings-card [data-a="backup-now"]') === 1 && await count(page, '.settings-card [data-a="backup-now"].btn-primary') === 1, 'the single primary [지금 백업하기] must be reachable once 장부 지키기 is expanded');
    await assert(await count(page, '[data-a="export-key"]') === 0 && await count(page, '[data-a="verify-integrity"]') === 1 && await count(page, '[data-a="guard-restore"]') === 1 && await count(page, '[data-a="backup-pass"]') === 1, 'expanding 장부 지키기 must reveal [되찾기][백업 암호][장부 검사] (no separate key backup)');
    await assert(await count(page, '.card.settings-card:has(.fold-head[data-card="ledger"]) .btn-primary') === 1, 'the 장부 지키기 card must hold exactly one primary button');
    // 토글은 양방향이다(다시 누르면 접힌다).
    await page.locator('.fold-head[data-card="ledger"]').click();
    await page.waitForTimeout(80);
    await assert(await count(page, '.settings-card [data-a="backup-now"]') === 0, 'tapping the header again must collapse the card back');
    await openSettingsCard(page, 'ledger');
    // 접힘 상태는 세션 내에서만 산다 — 새로고침하면 다시 전부 접힌 짧은 설정 화면으로 돌아온다(영속화 금지).
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('.fold-head[data-card="ledger"]');
    await assert((await page.locator('.fold-head[data-card="ledger"]').getAttribute('aria-expanded')) === 'false',
      'the expanded state must NOT be persisted — a relaunch must give the owner the short settings screen again');

    await openSettingsCard(page, 'depts');
    await assert((await page.locator('.agency-current-name').textContent()).includes('광진구청'), 'setup agency should be reflected as current agency');
    // ── beta.45(현장 지시): 공공기관을 고르기 **전에는 과 목록을 펼치지 않는다** ──────────────
    //   예전에는 아무것도 고르지 않아도 목록의 첫 기관이 골라진 것처럼 보이고 그 아래 과 체크박스 수십 개가
    //   깔려 있었다. 사장님은 "이게 우리 가게 것인지" 알 수 없는 채로 체크박스 벽을 마주했다.
    const regionOriginal = await page.locator('#regionSelectSettings').inputValue();
    await page.locator('#agencySelectSettings').selectOption('');
    await page.waitForTimeout(150);
    await assert(await count(page, '.dept-check') === 0 && await count(page, '[data-a="agency-add-all"]') === 0,
      'with no agency chosen the 과 목록 and its buttons must not be rendered at all');
    await assert((await page.locator('.agency-tools').innerText()).includes('공공기관을 고르세요'),
      'the picker must ask for the agency instead of silently pretending one is chosen');
    // 시·도를 바꾸면 기관은 **다시 고르게** 된다(예전에는 새 시·도의 첫 기관이 자동으로 골라졌다).
    const otherRegion = await page.evaluate(() => {
      const sel = document.querySelector('#regionSelectSettings');
      const opt = [...sel.options].find(o => o.value && o.value !== sel.value);
      return opt ? opt.value : '';
    });
    if (otherRegion) {
      await page.locator('#regionSelectSettings').selectOption(otherRegion);
      await page.waitForTimeout(250);
      await assert((await page.locator('#agencySelectSettings').inputValue()) === '', 'changing the province must clear the agency, not auto-pick its first one');
      await assert(await count(page, '.dept-check') === 0, 'changing the province must fold the 과 목록 back until an agency is chosen');
      await page.locator('#regionSelectSettings').selectOption(regionOriginal);
      await page.waitForTimeout(250);
    }
    await page.locator('#agencySelectSettings').selectOption('gangnam');
    await page.waitForTimeout(150);
    await assert(await count(page, '.dept-check') > 0 && await count(page, '[data-a="agency-add-all"]') === 1,
      'choosing an agency must reveal its 과 목록 and the add/remove buttons');
    await page.waitForFunction(() => document.querySelector('.agency-current-name')?.textContent.includes('강남구청'));
    // 보조 경로로 유지된 기존 개별등록 모달 — beta.29부터 수동 등록 카드도 접히므로 먼저 펼친다.
    await openSettingsCard(page, 'enroll-manual');
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
    await assert((await page.locator('.section-title', { hasText: '수동 등록' }).count()) === 1, 'a 수동 등록 card should hold the manual enrollment actions (beta.40: 제목에서 "— 직접 입력하기" 제거)');
    // 돈 오해 차단 문구는 자동 등록 카드 본문에 있다 — beta.29부터 접혀 있으므로 펼쳐서 확인한다.
    await openSettingsCard(page, 'enroll-auto');
    const settingsText = await page.locator('.app').innerText();
    await assert(!/구청 선금|선금 받기|직원개별등록/.test(settingsText), 'the retired wording (구청 선금 / 선금 받기 / 직원개별등록) must be gone from settings');
    await assert(settingsText.includes('앱 밖에서 따로 결제(제로페이, 카드 등)'), 'the auto-enrollment card must state that the money is paid outside the app (zeropay/card etc), not through it');
    // beta.45: 등록 전에는 열쇠 지문·열쇠 백업을 보여주지 않는다 — 담당자가 지문을 묻는 일도, 열쇠를
    //   잃어 곤란해지는 일도 등록한 뒤의 일이다. 등록 전 화면의 첫 버튼은 [우리 가게 등록] 하나여야 한다.
    await assert(await count(page, '#keyFp') === 0 && await count(page, '[data-a="export-key"]') === 0,
      'an unregistered store must not be shown the key fingerprint or the key backup yet');
    const unregOrder = await page.evaluate(() => {
      const card = document.querySelector('.card.settings-card:has(.fold-head[data-card="enroll-auto"])');
      const y = sel => { const el = card.querySelector(sel); return el ? el.getBoundingClientRect().top : NaN; };
      return { find: y('[data-a="relay-find-store"]'), money: y('.notice-money') };
    });
    await assert(unregOrder.find < unregOrder.money, `the [우리 가게 등록] button must come before the fine print (got ${JSON.stringify(unregOrder)})`);
    // ── beta.48(F6)·beta.49(e) → beta.55(A2): 미등록 가게의 장부 지키기 — 서버 줄 대신 이유 한 줄 + [우리 가게 등록하기], 회색 disabled 없음 ──
    //   미등록인데 "자동 백업 켜짐"이 뜨면 사장님은 백업이 돌고 있다고 읽는다(거짓 안심). 서버 링크(끄기·지우기)도 없다.
    const guardScope = '.card.settings-card:has(.fold-head[data-card="ledger"])';
    await openSettingsCard(page, 'ledger');
    {
      const box = await page.locator('#guardState').innerText();
      await assert(!box.includes('서버 자동 백업') && box.includes('가게를 등록하면 서버에도 자동 보관돼요'), `an unregistered store must see one reason line instead of a server row (got ${JSON.stringify(box)})`);
      await assert(await count(page, `${guardScope} input[type="checkbox"]`) === 0 && await count(page, `${guardScope} [data-a="toggle-auto-cloud"]`) === 0 && await count(page, `${guardScope} [data-a="cloud-backup-delete"]`) === 0 && await count(page, `${guardScope} [disabled]`) === 0,
        'the unregistered 장부 지키기 card must not offer server toggles/links nor grey disabled buttons');
    }
    // 이유 줄의 [우리 가게 등록하기]는 막힌 상태가 아니면 검색 모달을 연다(go-register-store 재사용) — 막다른 길이 아니다.
    await page.locator(`${guardScope} [data-a="go-register-store"]`).click();
    await page.waitForSelector('#storeName', { timeout: 8000 });
    await page.locator('[data-a="close-modal"]').click();
    await page.waitForTimeout(120);
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'enroll-auto');
    await openSettingsCard(page, 'enroll-manual');
    // ── beta.40: 메뉴 재배치(사용자 지시) — 전달파일·QR 진입점은 자동 등록 카드가 아니라
    //    수동 등록 카드 하단("공공기관 담당자에게 직접 받기")에 있다. 이 시점은 미등록 상태지만
    //    수동 등록 카드 본문은 등록 여부와 무관하므로 여기서 구조를 고정한다.
    //    (온라인 자동 등록 버튼의 idle/활성 모습은 등록 상태 구간에서 별도 단언)
    const autoCardScope = '.card.settings-card:has(.fold-head[data-card="enroll-auto"])';
    const manualCardScope = '.card.settings-card:has(.fold-head[data-card="enroll-manual"])';
    await assert(await count(page, `${autoCardScope} [data-a="direct-transfer-open"]`) === 0 && await count(page, `${autoCardScope} [data-a="qr-scan-open"]`) === 0,
      'the auto card must no longer contain the file/QR entry points (moved to 수동 등록)');
    // ── beta.49(e): 전달받기 구역도 등록 전에는 잠긴다 ──────────────────────────────
    //   담당자가 보낸 파일은 **우리 가게 번호로 잠긴 암호문**이라 등록 전에는 애초에 열리지 않는다.
    //   버튼만 살려 두면 눌러 봐야 안 되는 것을 알게 된다 — 그 자리에 이유 한 줄과 되게 하는 버튼을 둔다.
    await assert(await count(page, `${manualCardScope} [data-a="direct-transfer-open"]`) === 0 && await count(page, `${manualCardScope} [data-a="qr-scan-open"]`) === 0,
      'before the store is registered the 전달받기 buttons must be removed (not left tappable-but-broken)');
    const manualCardTextUnreg = await page.locator(manualCardScope).innerText();
    await assert(manualCardTextUnreg.includes('공공기관 담당자에게 전달받기'), 'the 전달받기 section heading must stay even while it is locked');
    await assert(manualCardTextUnreg.includes('담당자가 보낸 파일은 우리 가게 번호로 잠겨 있어요 — 가게를 등록하면 열 수 있어요'),
      `the locked 전달받기 section must state the one-line reason (got ${JSON.stringify(manualCardTextUnreg.slice(0, 400))})`);
    await assert(await count(page, `${manualCardScope} [data-a="go-register-store"]`) === 1,
      'the locked 전달받기 section must offer exactly one way out ([우리 가게 등록하기])');
    // 카드 안의 진한 버튼은 하나뿐이다 — 여럿이면 "무엇부터"가 사라진다(잠금 안내 버튼도 진하면 안 된다).
    const manualPrimaryUnreg = await page.evaluate(scope => ({
      primary: document.querySelectorAll(scope + ' .btn-primary.action-btn').length,
      lockBtnClass: (document.querySelector(scope + ' [data-a="go-register-store"]') || {}).className || ''
    }), manualCardScope);
    await assert(manualPrimaryUnreg.primary === 1, `the 수동 등록 card must keep exactly one primary action button while locked (got ${manualPrimaryUnreg.primary})`);
    await assert(!manualPrimaryUnreg.lockBtnClass.includes('btn-primary'), `the lock-notice button must not be a second 진한 버튼 (got ${JSON.stringify(manualPrimaryUnreg.lockBtnClass)})`);
    await page.locator('#quickAddDept').fill('Dept Q');
    await page.locator('#quickAddName').fill('User Q');
    await page.locator('#quickAddOpen').fill('12000');
    await page.locator('[data-a="quick-add-employee"]').click();
    await page.waitForTimeout(150);
    await assert(await page.locator('.dept-tags .dept-tag', { hasText: 'Dept Q' }).count() > 0, 'quick add should auto-create the missing department');

    // ②-1 홈 하단에서 옮겨온 "활성 직원 N명 · 잔액 합계" 요약은 [직원 목록 관리] 카드 상단에 있어야 한다.
    //      (새 .section-title을 만들지 않는다 — e2e 계약상 "직원 목록 관리" 제목은 정확히 1개)
    await openSettingsCard(page, 'employees');
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
    await expandEmpRow(page, empQ.id);// beta.53: 직원 행은 한 줄로 시작 — 펼쳐야 전화 칸이 보인다
    // beta.55(C12): 전화번호는 앱 안 입력창으로 받는다(기본 팝업 없음).
    await page.locator(`[data-a="emp-phone-edit"][data-id="${empQ.id}"]`).click();
    await page.waitForSelector('.text-modal #textDlgInput');
    await page.locator('#textDlgInput').fill('01099998888');
    await page.locator('.text-modal [data-a="text-ok"]').click();
    for (let i = 0; i < 30 && !((await readDb(page)).employees.find(e => e.id === empQ.id) || {}).phone; i += 1) await page.waitForTimeout(100);
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
    //    beta.42: 이 차감을 **지난 날짜(실사용일)**로 저장한다 — 소급 입력이 sms·증표·잔액·체인 어디도
    //    깨뜨리지 않음을 같은 흐름에서 검증(별도 거래를 만들면 아래 'open,use' 정확 일치 단언이 깨진다).
    const bdYmd = await page.evaluate(() => { const d = new Date(Date.now() - 5 * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    await page.locator('#useAmount').fill('5000');
    await page.locator('#useDate').fill(bdYmd);
    const smsBox = await page.locator('#signCanvas').boundingBox();
    await page.mouse.move(smsBox.x + 30, smsBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(smsBox.x + 110, smsBox.y + 45, { steps: 5 });
    await page.mouse.move(smsBox.x + 210, smsBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(300);
    // beta.55(B-09): 이 저장은 확인창을 거쳤다 — 확인창을 읽는 사이 사용자 활성이 끝나 자동 열기는 조용히 실패한다.
    //   그래서 자동 열기를 하지 않고, 증표에 진짜 링크(a href="sms:…")를 둔다. 탭이 곧 문자 앱 열기다.
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    await assert((await page.evaluate(() => window.__lastSmsHref || '')) === '', 'after a confirm dialog the app must not try to auto-open the SMS app');
    const smsHref = await page.evaluate(() => { const a = document.querySelector('.receipt-modal a[href^="sms:"]'); return a ? a.getAttribute('href') : ''; });
    await assert(smsHref.startsWith('sms:0109999'), 'the receipt must carry a real sms: link for a phone+consent employee');
    await assert(smsHref.includes('body=') && decodeURIComponent(smsHref.split('body=')[1] || '').includes('5,000원'), 'the sms body should describe the amount used and the resulting balance');
    await assert(!(await page.locator('.receipt-modal').innerText()).includes('장부에 이상'), 'a backdated usage must not break the balance cross-check — the receipt must still show the balance');
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
    await page.waitForTimeout(50);
    await page.locator('#searchInput').fill('');

    // ── beta.42: 소급 입력(실사용일) 계약 — 방금 지난 날짜로 저장한 5000원 차감을 검사한다 ──
    //   ① 과거 날짜는 occurredAt에만 담기고 createdAt(원장 시계)은 여전히 꼬리(최댓값)다
    //   ② note에 '실사용일 YYYY-MM-DD'가 병기된다(해시 canonical 안 — 위·변조 방지 유지)
    //   ③ 잔액 교차검증이 깨지지 않는다(위에서 증표가 경고 없이 열렸다)
    //   ④ 이력 화면의 날짜 묶음이 발생일 그룹으로 잡힌다
    {
      const bdDb = await readDb(page);
      const bdTx = bdDb.transactions.find(t => t.type === 'use' && t.employeeId === empQ.id);
      await assert(bdTx && bdTx.occurredAt > 0, 'a backdated usage must store the picked day in occurredAt');
      await assert(String(bdTx.note || '').includes(`실사용일 ${bdYmd}`), 'the note must carry the human-readable 실사용일 so the date is hash-sealed');
      const bdMax = Math.max(...bdDb.transactions.map(t => Number(t.createdAt) || 0));
      await assert(bdTx.createdAt === bdMax, 'backdating must not touch createdAt — the new tx still sits at the ledger clock tail');
      await page.locator('[data-a="screen"][data-screen="history"]').click();
      await page.waitForTimeout(150);
      await assert((await page.locator('.app').innerText()).includes(bdYmd.replace(/-/g, '.')), 'the history date groups must file the backdated tx under its 실사용일');
      await page.locator('[data-a="screen"][data-screen="home"]').click();
      await page.waitForTimeout(100);
      await page.locator('#searchInput').fill('');
    }

    // 기존 사용 등록(차감) 플로우 — User A, 서명 포함
    await page.locator('#searchInput').fill('User A');
    await page.locator(`[data-a="use"][data-id="${empA.id}"]`).click();
    await page.locator('#useAmount').fill('9000');
    // ── beta.27: 빈 서명판 안내(사장님 사용 모달) ────────────────────────────────
    //   ⚠️ 캔버스 3중 보호 계약: 안내는 **캔버스에 그리지 않는다**. 그렸다면 그 픽셀이 그대로
    //     toDataURL에 들어가 원장에 남는 서명 그림에 "여기에 손가락으로 서명해 주세요"가 박힌다.
    //   그래서 안내는 (1) 캔버스의 형제 DOM 노드이고 (2) pointer-events가 통과하며
    //   (3) 안내가 떠 있는 그 순간에도 캔버스 백킹 스토어는 순백이어야 한다 — 아래에서 픽셀로 못 박는다.
    const sigHintOwner = await page.evaluate(() => {
      const canvas = document.getElementById('signCanvas');
      const hint = canvas.parentElement.querySelector('.sig-hint');
      if (!hint) return { missing: true };
      const cs = getComputedStyle(hint);
      // 안내가 표시된 그 상태에서 캔버스 픽셀을 읽는다. 안내가 차지하는 세로 중앙 띠(20%~70%)에
      // 흰색이 아닌 픽셀이 하나라도 있으면 = 글자가 캔버스에 그려졌다는 뜻이다(= dataURL 오염).
      const ctx = canvas.getContext('2d');
      const y0 = Math.round(canvas.height * 0.2), y1 = Math.round(canvas.height * 0.7);
      const d = ctx.getImageData(0, y0, canvas.width, y1 - y0).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) nonWhite += 1;
      // 두 번째(결정적) 증거: 안내를 보이게 두고 찍은 dataURL과, 잠시 숨기고 찍은 dataURL이 **바이트까지 같아야** 한다.
      //   toDataUrl()은 백킹 스토어만 읽으므로, 같다는 것은 곧 "안내는 저장되는 그림에 없다"는 뜻이다.
      const shown = canvas.toDataURL('image/jpeg', 0.5);
      const prev = hint.style.display;
      hint.style.display = 'none';
      void hint.offsetHeight;
      const hidden = canvas.toDataURL('image/jpeg', 0.5);
      hint.style.display = prev;
      return {
        dataUrlUnchanged: shown === hidden,
        isJpeg: shown.startsWith('data:image/jpeg'),
        text: hint.textContent.trim(),
        insideCanvas: canvas.contains(hint),
        siblingOfCanvas: hint.parentElement === canvas.parentElement,
        pointerEvents: cs.pointerEvents,
        visible: hint.offsetParent !== null,
        nonWhite
      };
    });
    await assert(!sigHintOwner.missing, 'the usage modal must render a hint inside the empty signature box');
    await assert(sigHintOwner.text.includes('서명') && sigHintOwner.text.includes('손가락'), `the signature hint must tell the customer to sign with a finger (got ${JSON.stringify(sigHintOwner.text)})`);
    await assert(sigHintOwner.siblingOfCanvas && !sigHintOwner.insideCanvas, 'the hint must be a CSS overlay next to the canvas — never a child of (or drawn onto) the canvas');
    await assert(sigHintOwner.pointerEvents === 'none', 'the hint must let pointer events through (a stroke started on the hint must reach the canvas)');
    await assert(sigHintOwner.visible === true, 'the hint must be visible while the canvas is empty');
    await assert(sigHintOwner.nonWhite === 0,
      `the hint must not touch the canvas backing store — the band it covers must stay pure white, otherwise the wording lands in the saved signature dataURL (got ${sigHintOwner.nonWhite} non-white pixels)`);
    await assert(sigHintOwner.isJpeg && sigHintOwner.dataUrlUnchanged,
      'the signature dataURL must be byte-identical whether the hint is shown or hidden — the wording must never reach the saved image');
    const box = await page.locator('#signCanvas').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 110, box.y + 45, { steps: 5 });
    await page.mouse.move(box.x + 210, box.y + 100, { steps: 5 });
    await page.mouse.move(box.x + 310, box.y + 65, { steps: 5 });
    await page.mouse.up();
    // 첫 획이 들어오면 안내는 사라진다 — 그리고 그 사라짐은 **재렌더가 아니라 클래스 토글**이어야 한다
    //   (재렌더가 일어나면 방금 그린 획이 캔버스와 함께 통째로 날아간다 = 캔버스 3중 보호 위반).
    const afterStroke = await page.evaluate(() => {
      const canvas = document.getElementById('signCanvas');
      const hint = canvas.parentElement.querySelector('.sig-hint');
      return {
        stillInDom: Boolean(hint),
        hidden: hint ? hint.offsetParent === null : null,
        boxSigned: canvas.parentElement.classList.contains('signed'),
        strokes: window.__prepaidTestHooks.lockState().signPadStrokes
      };
    });
    await assert(afterStroke.stillInDom && afterStroke.hidden === true && afterStroke.boxSigned,
      `the hint must disappear on the first stroke by a CSS class toggle, not by re-rendering (got ${JSON.stringify(afterStroke)})`);
    // beta.43: **사장님이 직접 입력한 금액**은 큰 화면에 뜬 적이 없으므로 저장 직전 확인창이 그대로 산다.
    //   (확인창이 빠지는 유일한 경로는 "손님 요청 금액을 그대로 저장할 때"다 — B단계 시나리오에서 검증)
    const ownerTypedDialogsBefore = dialogs.length;
    await page.locator('[data-a="save-use"]').click();
    // 사용(차감) 저장 직후 성공 안내 흐름에서 "잔액증표 보기"가 방금 차감된 직원 id로 자동 오픈된다
    await page.waitForSelector('.receipt-modal', { timeout: 3000 });
    const ownerTypedConfirm = dialogs.slice(ownerTypedDialogsBefore).find(d => d.type === 'confirm' && d.message.includes('저장하시겠습니까'));
    await assert(Boolean(ownerTypedConfirm) && ownerTypedConfirm.message.includes('9,000원') && ownerTypedConfirm.message.includes('18,000원'),
      `an owner-typed deduction must still be confirmed with its amount and resulting balance (got ${JSON.stringify(ownerTypedConfirm && ownerTypedConfirm.message)})`);
    const autoReceiptText = await page.locator('.namecard').innerText();
    await assert(autoReceiptText.includes('Dept A User A님'), 'post-save receipt should render "{부서} {이름}님" for the just-deducted employee');
    await assert(autoReceiptText.includes('18,000원'), 'post-save receipt should show the derive() balance (27000-9000)');
    await assert(autoReceiptText.includes('양도 불가'), 'receipt must carry the non-transfer notice');
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
    await page.waitForTimeout(50);
    await page.locator('#searchInput').fill('');

    const data = await readDb(page);
    await assert(data.employees.length === 2, 'both employees (modal + quick add) should be saved');
    const balanceOf = eid => data.transactions.filter(tx => tx.employeeId === eid).reduce((sum, tx) => sum + (tx.type === 'use' ? -Number(tx.amount || 0) : Number(tx.amount || 0)), 0);
    await assert(data.transactions.filter(tx => tx.employeeId === empA.id).map(tx => tx.type).join(',') === 'open,use', 'User A should carry an open + use transaction');
    await assert(balanceOf(empA.id) === 18000, 'User A balance should be 18000 after one use');
    await assert(Boolean(data.transactions.find(tx => tx.employeeId === empA.id && tx.type === 'use').signatureData), 'use transaction should contain signature data');
    await checkSigPng(page, data.transactions.find(tx => tx.employeeId === empA.id && tx.type === 'use').signatureData, 'owner usage-modal signature');
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
      const str = v => (typeof v === 'string' ? v.trim() : '');
      // canonical v2 (beta.31) — 거래를 이루는 값을 전부 넣는다. 앱의 txCanonical()과 한 글자도 달라선 안 된다.
      const canon = (t, prevHash) => 'bapjangbu/tx/v2\n' + JSON.stringify([str(t.id), str(t.employeeId), str(t.type),
        num(t.amount), num(t.beforeBalance), num(t.afterBalance), t.targetTransactionId ? str(t.targetTransactionId) : '',
        str(t.signatureHash), str(t.reason), str(t.note), str(prevHash || ''), num(t.createdAt)]);
      const sorted = txs.slice().sort((a,b)=>a.createdAt-b.createdAt||(a.id<b.id?-1:a.id>b.id?1:0));
      let prev='';
      for(const t of sorted){ if(!t.txHash){prev='';continue}
        if(Number(t.hv)!==2) return false;                      // 구 형식이 새로 만들어지면 안 된다
        const e=await h(canon(t, t.prevHash||'')); if(e!==t.txHash) return false;
        if((t.prevHash||'')!==prev) return false; prev=t.txHash;
        if(t.signatureData){ const sh=await h(String(t.signatureData)); if(sh!==String(t.signatureHash||'')) return false; }
      }
      return true;
    }, data.transactions);
    await assert(chainOk, 'integrity hash chain should recompute and verify');

    // 잔액증표(명함형) — empCard 보조 버튼 [🧾 증표]으로 표시 전용 카드 열기
    await assert(await count(page, '[data-a="receipt"]') >= 2, 'each employee card should expose a receipt (증표) button next to 사용');
    // beta.27: 아이콘만으로는 무엇인지 알 수 없다 → 🧾 옆(아래)에 "증표" 글자 라벨. 모든 카드에 빠짐없이.
    const rcptLabels = await page.locator('.card.employee [data-a="receipt"]').evaluateAll(els => els.map(e => {
      const l = e.querySelector('.rcpt-label');
      return { label: l ? l.textContent.trim() : null, icon: e.textContent.includes('🧾') };
    }));
    await assert(rcptLabels.length >= 2 && rcptLabels.every(r => r.label === '증표' && r.icon),
      `every 🧾 button must carry the "증표" text label next to the icon (got ${JSON.stringify(rcptLabels)})`);
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
    // ── beta.27: "사진으로 남겨두기" 안내 ────────────────────────────────────────
    //   증표는 손님이 들고 가는 것이 아니라 **보고 가는 것**이다. 사진을 찍어 두라고 말해 주지 않으면
    //   손님은 다음에 또 사장님을 부른다. 단, 안내는 명함(.namecard) **바깥**이어야 한다 —
    //   카드 안에 넣으면 손님이 찍은 사진에 앱 사용법이 함께 박힌다.
    const receiptTipText = await page.locator('.receipt-modal .receipt-tip').innerText();
    await assert(receiptTipText.includes('사진으로 찍어') && receiptTipText.includes('잔액을 확인'),
      `the owner receipt must tell the customer to photograph the screen (got ${JSON.stringify(receiptTipText)})`);
    await assert(await count(page, '.namecard .receipt-tip') === 0, 'the photo tip must live OUTSIDE the name card (a photographed receipt must stay clean)');
    await assert(await page.locator('.receipt-modal .receipt-tip').evaluate(el => {
      const btn = el.parentElement.querySelector('[data-a="receipt-close"]');// beta.55(C6): 증표 닫기는 receipt-close
      return Boolean(btn) && el.compareDocumentPosition(btn) === Node.DOCUMENT_POSITION_FOLLOWING;
    }), 'the photo tip should sit right above the close button (where the customer is already looking)');
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'receipt-card.png') }).catch(() => {});
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
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
    // beta.55(A2): [장부 안전 저장](CSV+JSON)은 없어졌다 — 백업은 [장부 지키기 > 지금 백업하기] 하나, 엑셀(CSV)은 이력 화면 [엑셀로 내보내기].
    //   이 가게는 미등록이라 서버 단계 없이 곧바로 "내 보관용" 선택창이 뜬다. 여기서는 '암호 없이'(예전 평문 형식)를 골라 그 파일을 검증한다.
    await openSettingsCard(page, 'ledger');
    const capturedDownloads = [];
    const onDownload = download => capturedDownloads.push(download);
    page.on('download', onDownload);
    await page.locator('.settings-card [data-a="backup-now"]').click();
    await page.waitForSelector('#choiceTitle', { timeout: 8000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="save"]').click();
    await page.waitForSelector('#keyPassPlain', { timeout: 8000 });
    await page.locator('#keyPassPlain').check();
    await page.locator('[data-a="pass-ok"]').click();
    for (let i = 0; i < 40 && capturedDownloads.length < 1; i += 1) await page.waitForTimeout(100);
    await page.waitForSelector('#choiceTitle', { timeout: 8000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="yes"]').click();
    await page.locator('[data-a="screen"][data-screen="history"]').click();
    await page.locator('.top [data-a="export-csv"]').click();
    for (let i = 0; i < 40 && capturedDownloads.length < 2; i += 1) {
      await page.waitForTimeout(100);
    }
    page.off('download', onDownload);
    await page.locator('[data-a="go-home"]').click();
    await assert(capturedDownloads.length >= 2, 'the plain own backup + the history CSV export should trigger two downloads');
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
    // beta.55(C6, 사용자 결정 §1-9): 손님 요청으로 시작한 저장의 증표를 닫으면 손님 화면(잠금)으로 간다.
    //   그 뒤에 사장님 홈이 필요한 기존 시나리오는 여기서 잠금을 풀고 홈으로 돌아온다(착지 단언 포함).
    const homeAfterReqReceipt = async () => {
      await page.waitForSelector('.cust-screen #custSearchInput', { timeout: 6000 });
      await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState().locked)) === true, 'closing a customer-request receipt must land on the locked customer screen (beta.55 C6)');
      await unlock();
      await page.waitForSelector('[data-a="quick-find-emp"]', { timeout: 15000 });
    };
    // (1) 내 보관 백업 파일명: 암호 없이 = 밥장부백업_암호없음_YYYY-MM-DD.json(beta.55), 최종백업은 날짜까지 유지
    await assert(/^밥장부백업_암호없음_\d{4}-\d{2}-\d{2}\.json$/.test(jsonDownload.name), `an unpassworded own backup should be named 밥장부백업_암호없음_YYYY-MM-DD.json, got ${jsonDownload.name}`);
    const finalFn = await page.evaluate(() => window.__prepaidTestHooks.backupFileName(true));
    await assert(/^밥장부백업_최종_\d{4}-\d{2}-\d{2}\.json$/.test(finalFn), `final backup file name should keep the day (밥장부백업_최종_YYYY-MM-DD.json), got ${finalFn}`);

    // (2) beta.55(A2): 월말 판정은 없어졌다 — 서버 백업은 주 1회이고, 등록 전 가게에는 아예 대상이 아니다.
    await assert(await page.evaluate(() => window.__prepaidTestHooks.cloudAutoDue()) === false, 'an unregistered store must never be due for a server backup');
    await assert(await page.evaluate(() => typeof window.__prepaidTestHooks.monthlyBackupDue) === 'undefined', 'the month-end backup judgement must be gone (weekly now)');

    // 지난달(15일) 씨앗 거래 주입. txHash 비워 해시체인 검증은 이 거래를 건너뛴다(무결성 경고 유발 안 함).
    // beta.31: 예전에는 여기서 relayServer를 'https://relay.invalid.test'로 바꿔 백그라운드 백업을 DNS 실패로 끊었다.
    //   앱에 CSP(connect-src)가 생기면서 기본 중계 서버 외 도메인은 브라우저가 아예 연결하지 않는다
    //   → 그 트릭은 이제 '검색 목'까지 함께 막아 버린다. 대신 아래 `**/api/**` 안전망 목(500)이 같은 역할을 한다.
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
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { ts: prevTs });
    await resealChain(page);

    // (3) beta.29: 홈 상단 [장부 저장] 상시 버튼 폐지 → ① [직원 목록 관리] 바로가기 ② 30일 백업 리마인더 배너로 대체.
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="screen"][data-screen="home"]');
    await assert(await count(page, '[data-a="monthly-backup-now"]') === 0, 'the always-on [장부 저장] top-bar button must be gone (beta.29)');
    await assert(await count(page, '.top .tool [data-a="go-employees"]') === 1, 'the home top bar must carry the [직원 목록 관리] shortcut instead');
    await assert(await count(page, '.top .tool [data-a="reset-filter"]') === 0, '[검색 초기화] must leave the top bar (it moves next to the search input)');
    // 검색 ✕: 지울 것이 없으면 없다 → 검색어를 넣으면 검색창 옆에 나타나고, 누르면 검색어가 지워진다.
    await assert(await count(page, '.filter-row [data-a="reset-filter"]') === 0, 'the search-clear ✕ must not render while there is nothing to clear');
    await page.locator('#searchInput').fill('User');
    await page.locator('#searchInput').dispatchEvent('input');
    await page.waitForTimeout(250);
    await assert(await count(page, '.filter-row [data-a="reset-filter"]') === 1, 'typing a query must reveal the ✕ clear button beside the search input');
    await page.locator('.filter-row [data-a="reset-filter"]').click();
    await page.waitForTimeout(150);
    await assert((await page.locator('#searchInput').inputValue()) === '', 'tapping ✕ must clear the search query');
    await assert(await count(page, '.filter-row [data-a="reset-filter"]') === 0, 'the ✕ must disappear again once the query is cleared');
    // [직원 목록 관리] 바로가기: 설정 화면의 직원 목록 카드를 자동 펼침으로 연다(모달 아님 — 모달 중첩 미지원 구조).
    await page.locator('.top .tool [data-a="go-employees"]').click();
    await page.waitForTimeout(200);
    await assert((await page.locator('.fold-head[data-card="employees"]').getAttribute('aria-expanded')) === 'true',
      'the home [직원 목록 관리] shortcut must open settings with the employees card expanded');
    await assert(await count(page, '.mgr-summary') === 1, 'the expanded employees card must show its summary right away');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(150);
    // 백업 배너(beta.55: 장부 지키기 상태 하나): 방금 내 보관 백업을 했으므로 '오래됨' 조건은 미충족.
    // beta.60(가-1): 그런데 그 백업은 '암호 없이'였다 — 백업 암호를 정한 적이 없으니 비밀번호를 잊으면 장부를 되찾을 길이 없다 → 그 안내만 선다.
    await assert(await count(page, '.guard-banner') === 1 && (await page.locator('.guard-banner strong').innerText()).trim() === '⚠ 백업 암호를 아직 정하지 않았어요' && !(await page.locator('.guard-banner').innerText()).includes('오래됐어요'),
      'right after a plain backup only the "no backup password yet" banner may show (not the stale one)');
    // 마지막 백업을 40일 전으로 되돌리면(지난달 15일 씨앗 거래가 그 뒤에 있음) 배너가 선다 — 서버·내 보관 둘 다 오래됐을 때만(옛 30일 규칙).
    await page.evaluate(({ old, check }) => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        tx.objectStore('meta').put({ key: 'lastBackupAt', value: old });
        tx.objectStore('meta').put({ key: 'lastCloudBackupAt', value: 0 });
        tx.objectStore('meta').put({ key: 'backupPassCheck', value: check });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }), { old: Date.now() - 40 * 86400000, check: MAIN_PASS_CHECK });
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('[data-a="screen"][data-screen="home"]');
    await assert(await count(page, '.guard-banner[data-a="backup-now"]') === 1, 'a 40-day-old backup with newer transactions must raise the backup banner');
    await assert((await page.locator('.guard-banner').innerText()).includes('백업한 지 오래됐어요'), 'the stale banner must say the ledger has not been backed up for a long time');
    // ✕로 닫으면 이번 실행 동안만 숨는다(다른 배너와 같은 규칙).
    await page.locator('.guard-banner [data-a="dismiss-guard-banner"]').click();
    await page.waitForTimeout(150);
    await assert(await count(page, '.guard-banner') === 0, 'dismissing the banner must hide it for this session');
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.waitForSelector('.guard-banner', { timeout: 8000 });
    // 배너 본문을 누르면 [지금 백업하기]와 같은 길 → 내 보관 파일 저장 → 저장 도장으로 배너가 스스로 내려간다.
    const savedByBanner = [];
    const onBannerDownload = d => savedByBanner.push(d);
    page.on('download', onBannerDownload);
    await page.locator('.guard-banner').click({ position: { x: 30, y: 40 } });
    await page.waitForSelector('#choiceTitle', { timeout: 8000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="save"]').click();
    await page.waitForSelector('#keyPassPlain', { timeout: 8000 });
    await page.locator('#keyPassPlain').check();
    await page.locator('[data-a="pass-ok"]').click();
    for (let i = 0; i < 40 && savedByBanner.length < 1; i += 1) await page.waitForTimeout(100);
    page.off('download', onBannerDownload);
    await assert(savedByBanner.length === 1 && /^밥장부백업_/.test(savedByBanner[0].suggestedFilename()),
      `tapping the backup banner must lead to the own backup (got ${JSON.stringify(savedByBanner.map(d => d.suggestedFilename()))})`);
    await page.waitForSelector('#choiceTitle', { timeout: 8000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="yes"]').click();
    await page.waitForTimeout(300);
    await assert(await count(page, '.guard-banner') === 0, 'a confirmed own backup must clear the banner without a reload');

    // (4) 서버 자동 백업 끄기·켜기(글씨 링크): 기본 켜짐 → 끄면 앱 안 확인창을 거쳐 저장·재시작 후 유지 → 다시 켠다.
    // beta.49: 이 조작은 **등록된 가게에만** 있다. 그래서 이 구간은 등록 상태를 먼저 심는다 — 아래 (6) 자동 서버 백업도 같은 상태를 쓴다.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        tx.objectStore('meta').put({ key: 'restaurantId', value: 'test-rid' });
        tx.objectStore('meta').put({ key: 'relayStoreName', value: 'Harness Shop' });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }));
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'ledger');
    await page.waitForSelector('[data-a="toggle-auto-cloud"]');
    await assert((await page.locator('[data-a="toggle-auto-cloud"]').innerText()).includes('끄기'), 'server auto backup should default to ON (the link offers 끄기)');
    await page.locator('[data-a="toggle-auto-cloud"]').scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(root, 'harness', 'screenshots', 'settings-auto-backup.png') }).catch(() => {});
    await page.locator('[data-a="toggle-auto-cloud"]').click();
    await page.waitForSelector('.choice-modal [data-val="off"]', { timeout: 8000 });
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="off"]').click();
    await page.waitForTimeout(150);
    let mm = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(mm.autoCloudBackup === false, 'turning server auto backup off should persist autoCloudBackup=false');
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'ledger');
    await page.waitForSelector('[data-a="toggle-auto-cloud"]');
    await assert((await page.locator('[data-a="toggle-auto-cloud"]').innerText()).includes('켜기') && (await page.locator('#guardState').innerText()).includes('꺼져 있어요'), 'the off state should survive a reload and be visible in the status box');
    await page.locator('[data-a="toggle-auto-cloud"]').click();
    await page.waitForTimeout(150);
    mm = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(mm.autoCloudBackup === true, 'turning it back on should persist (no confirmation needed to turn safety ON)');

    // (5)·(6) 주 1회 자동 서버 백업: 등록됨 + 켜짐 + 7일 넘음 + 바뀐 것 있음 → 조용히 서버를 부른다(네트워크 스파이).
    //   잠금 해제 때 한 번 시도한 실패(안전망 목 500)가 남긴 '한 시간 재시도 간격'은 하니스 전용 훅으로 비운다.
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
          return new Response(JSON.stringify({ ok: true, updated_at: Date.now(), segments: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return orig(u, opts);
      };
    }, { pubKey: mm.pubKey });
    const fired = await page.evaluate(async () => {
      window.__ledgerBackupCalls = [];
      window.__prepaidTestHooks.cloudRetryGapReset();
      await window.__prepaidTestHooks.maybeAutoCloudBackup();
      return window.__ledgerBackupCalls.slice();
    });
    await assert(fired.length >= 2 && fired[fired.length - 1].endsWith('/api/ledger-backup'), `a due weekly backup should upload segments then the head LAST (got ${JSON.stringify(fired)})`);
    mm = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(mm.cloudBackupState && mm.cloudBackupState.lastOkAt > Date.now() - 60000 && !mm.cloudBackupState.failSince && mm.lastCloudBackupAt > Date.now() - 60000, 'a successful weekly backup must record its time and clear the failure');
    // 성공한 뒤 7일이 안 됐으면 다시 불러도 서버를 부르지 않는다(1회/주·중복 방지).
    const again = await page.evaluate(async () => {
      window.__ledgerBackupCalls = [];
      await window.__prepaidTestHooks.maybeAutoCloudBackup();
      return window.__ledgerBackupCalls.length;
    });
    await assert(again === 0, 'within 7 days of a successful backup there must be no further server backup');

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
    await resealChain(page);
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
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
    await page.waitForTimeout(50);

    // ───────────────────────────────────────────────────────────────
    // 우리 가게 등록: 실패 롤백(S3) · 성공 후 열쇠 백업 유도(B3) · 배너 닫기(D2)
    // ───────────────────────────────────────────────────────────────
    const metaNow = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(Boolean(metaNow.pubKey), 'a keypair should exist before the store-registration scenarios');
    // ── beta.49(a): 미등록 홈은 등록 상태를 **항상** 말한다 ────────────────────────────
    //   예전에는 가게 이름만 크게 뜨고 상태는 ✕로 닫히는 배너뿐이라 "등록된 것처럼" 읽혔다(현장 결함).
    //   이름(내 가게 정보)은 사실이니 그대로 두고, 상태는 이름 옆의 칩이 닫기 없이 계속 말한다.
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(150);
    {
      const chip = page.locator('.pill-muted');
      await assert(await chip.count() === 1, 'an unregistered home must always carry the "등록 안 됨" status chip');
      await assert((await chip.innerText()).trim() === '공공기관 명단 받기: 등록 안 됨',
        `the unregistered status chip must name what is missing (got ${JSON.stringify((await chip.innerText()).trim())})`);
      const chipShape = await page.evaluate(() => {
        const el = document.querySelector('.pill-muted');
        return { tag: el.tagName, buttons: el.querySelectorAll('button').length };
      });
      await assert(chipShape.tag === 'SPAN' && chipShape.buttons === 0, 'the status chip must not be dismissible (no ✕, not a button)');
      await assert(await count(page, '.pill-alert-soft') === 0, 'an ordinary unregistered store must not claim it is registered on another device');
      // 배너는 "왜 등록해야 하는가"를 두 가지로 말한다 — 명단 받기 + 폰 분실 시 장부 되찾기.
      const bannerTxt = await page.locator('.banner[data-a="go-register-store"]').innerText();
      await assert(bannerTxt.includes('우리 가게 등록을 마무리하세요') && bannerTxt.includes('장부 되찾기'),
        `the finish-registration banner must name both reasons (got ${JSON.stringify(bannerTxt.replace(/\n/g, ' '))})`);
    }
    // 온보딩에서 직접 입력을 택했으니 아직 미등록이다 — 접힌 자동 등록 헤더가 '등록 필요'를 알리고,
    // 펼치면 [우리 가게 등록(처음 한 번)]이 **보여야** 한다(beta.29 접힘).
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForTimeout(120);
    await assert((await page.locator('.fold-head[data-card="enroll-auto"]').innerText()).includes('등록 필요'),
      'the collapsed auto-enroll header must badge the unregistered state (등록 필요)');
    await openSettingsCard(page, 'enroll-auto');
    await assert(await page.locator('[data-a="relay-find-store"]', { hasText: '우리 가게 등록' }).count() === 1, 'an unregistered store must keep the manual [우리 가게 등록] path in settings');
    // 검색 목: 주소가 실려야 등록 페이로드에 district가 실린다(설정 경로도 온보딩과 같은 계약).
    storeSearchResults = [
      { restaurant_id: 'rid-other-1', name: '남의 김밥', address: '서울특별시 강남구 역삼동 1-1' },
      { restaurant_id: 'rid-mine-1', name: 'Harness Shop', address: '서울특별시 광진구 아차산로 399, 1층 B호 (구의동)' }
    ];
    // ── beta.49(d): 검색 결과에 "다른 기기에서 이미 등록됨"을 **고르기 전에** 표시한다 ──────────
    //   예전에는 고른 뒤 401이 나야만 알 수 있었다. 판정 근거는 담당자 웹과 같은 공개 엔드포인트다.
    //   ⚠️ 진단용 __diag_ 접두 id는 배지 대상이 아니다(라이브 스모크용 가짜 가게 — "남이 가져갔다"가 아니다).
    {
      const withDiag = storeSearchResults.concat([{ restaurant_id: '__diag_smoke-1', name: '진단용 가게', address: '서울특별시 광진구 진단로 1' }]);
      storeSearchResults = withDiag;
      registeredIdsBody = ['rid-other-1', '__diag_smoke-1'];
      await page.locator(`${autoCardScope} [data-a="relay-find-store"]`).click();
      await page.waitForSelector('#storeName');
      await page.locator('#storeName').fill('하네스김밥');
      await page.locator('[data-a="relay-search-stores"]').click();
      await page.waitForSelector('[data-a="relay-pick-store"]');
      await page.waitForSelector('.badge-soft', { timeout: 8000 });
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-a="relay-pick-store"]')].map(b => {
        const slot = b.parentElement.querySelector('.store-badge-slot');
        return { id: b.dataset.id, badge: slot ? slot.innerText.trim() : '(no slot)' };
      }));
      await assert(JSON.stringify(rows) === JSON.stringify([
        { id: 'rid-other-1', badge: '다른 기기에서 이미 등록됨' },
        { id: 'rid-mine-1', badge: '' },
        { id: '__diag_smoke-1', badge: '' }
      ]), `only the already-registered, non-diagnostic row may carry the badge (got ${JSON.stringify(rows)})`);
      // 조회가 실패하면(오프라인·서버 오류) 조용히 배지 없음 — 검색 자체는 그대로 된다(가용성 우선).
      registeredFail = true;
      await page.locator('[data-a="relay-search-stores"]').click();
      await page.waitForSelector('[data-a="relay-pick-store"]');
      await page.waitForTimeout(600);
      await assert(await count(page, '.badge-soft') === 0, 'a failed /api/registered lookup must simply leave the badges off');
      await assert(await count(page, '[data-a="relay-pick-store"]') === 3, 'a failed badge lookup must never swallow the search results themselves');
      registeredFail = false;
      // 배지가 붙은 가게를 고르면 **되돌릴 수 있는 확인창**이 뜬다(alert가 아니다 — 잘못 골랐을 때 빠져나갈 길).
      registeredIdsBody = ['rid-mine-1'];
      await page.locator('[data-a="relay-search-stores"]').click();
      await page.waitForSelector('.badge-soft', { timeout: 8000 });
      const takenPickRe = /그래도 이 가게로 계속할까요\?/;
      {
        const callsBefore = registerCalls.length;
        const dialogsBefore = dialogs.length;
        confirmDecider = msg => !takenPickRe.test(msg);// 이 확인창만 [취소]
        await page.locator('[data-a="relay-pick-store"][data-id="rid-mine-1"]').click();
        await page.waitForTimeout(400);
        const asked = dialogs.slice(dialogsBefore).filter(d => d.type === 'confirm' && takenPickRe.test(d.message));
        await assert(asked.length === 1, `picking a badged store must ask once before continuing (got ${asked.length})`);
        await assert(asked[0].message.includes('다른 기기에서 이미 등록돼 있어요') && asked[0].message.includes("'내 열쇠 백업'"),
          `the confirmation must keep the full explanation (got ${JSON.stringify(asked[0].message.slice(0, 120))})`);
        await assert(registerCalls.length === callsBefore, 'declining the confirmation must not attempt any registration');
        const m = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
        await assert(!m.restaurantId, 'declining the confirmation must leave the store unpicked');
        await assert(await count(page, '[data-a="relay-pick-store"]') === 3,
          'declining must leave the owner exactly where they were — in the search results, free to pick another store');
        confirmDecider = null;
      }
      {
        // [확인]이면 예전 흐름 그대로 등록을 시도한다(여기서는 500 목이라 그대로 롤백된다).
        const callsBefore = registerCalls.length;
        registerStatus = 500;
        await page.locator('[data-a="relay-pick-store"][data-id="rid-mine-1"]').click();
        await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
        await page.waitForTimeout(300);
        await assert(registerCalls.length === callsBefore + 1, 'accepting the confirmation must go on to the normal registration attempt');
        registerStatus = 200;
        await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 }).catch(() => {});
      }
      registeredIdsBody = [];
      if (await page.locator('[data-a="close-modal"]').count()) await page.locator('[data-a="close-modal"]').click();
      await page.waitForTimeout(120);
      storeSearchResults = withDiag.filter(x => !/^__diag_/.test(x.restaurant_id));
    }
    // 등록 성공 경로는 소유증명(challenge)·연락처 저장까지 이어지므로 페이지 fetch 스파이로 막는다.
    // beta.49: 이 구간은 재시작(reload) 시나리오가 생겼다 — 스파이는 페이지와 함께 사라지므로 다시 심는다.
    //   안 심으면 등록 직후의 연락처 저장이 목 없는 500으로 떨어져 콘솔 오류 단언(마지막 구간)이 깨진다.
    const installRelaySpy = async () => page.evaluate(({ pubKey }) => {
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
    await installRelaySpy();

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

    // (1b) 재설치 충돌 경로(beta.28): 같은 가게가 예전 열쇠로 이미 등록됨 → 401 auth_required.
    //      네트워크 오류가 아니므로 "인터넷 확인" 토스트가 아니라 해결 3갈래(예전 폰 해제·열쇠 복원·문의)
    //      안내 alert가 떠야 하고, 로컬 상태는 (1)과 동일하게 롤백되어야 한다.
    registerStatus = 401;
    registerErrorCode = 'auth_required';
    // (1)의 "인터넷 확인" 토스트(3초)가 남아 있으면 아래 '토스트 겹침 금지' 단언이 잔상을 잡는다 — 먼저 걷어낸다.
    await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 });
    const dialogsBeforeTaken = dialogs.length;
    await pickStore();
    const takenAlerts = dialogs.slice(dialogsBeforeTaken).filter(d => d.type === 'alert');
    await assert(takenAlerts.length === 1, `an auth_required registration must open exactly one guidance alert (got ${takenAlerts.length})`);
    await assert(takenAlerts[0].message.includes('이미 등록되어 있어요'), 'the guidance alert must say the store is already registered');
    await assert(takenAlerts[0].message.includes('자동 등록 중단') && takenAlerts[0].message.includes('내 열쇠 백업') && takenAlerts[0].message.includes('contact@bapjangbu.com'),
      'the guidance alert must offer all three ways out (old-phone deregister · key-backup restore · operator contact)');
    await assert(!takenAlerts[0].message.includes('인터넷'), 'the auth_required guidance must not blame the network');
    // beta.31 ⑩ 선점 신고: 안내가 [신고하기]의 위치(자동 등록 카드)를 가리키고, 그 링크가 여는 메일에는
    //   가게 이름·가게 번호·시각·열쇠 지문만 담긴다(직원 명단·금액은 절대 담기지 않는다).
    //   beta.50부터 안내 뒤 confirm은 없다 — 훅(__lastReportHref)은 거절 시점에 링크를 만들며 채워진다.
    await assert(takenAlerts[0].message.includes('신고하기'), 'the auth_required guidance must point at the takeover report path');
    const report = await page.evaluate(() => window.__lastReportHref || '');
    await assert(report.startsWith('mailto:contact@bapjangbu.com?'), `accepting the report offer must open a prefilled mail draft (got ${JSON.stringify(report.slice(0, 60))})`);
    const reportBody = decodeURIComponent((report.split('&body=')[1] || ''));
    await assert(reportBody.includes('가게 번호:') && reportBody.includes('발생 시각:') && reportBody.includes('열쇠 지문:'),
      `the report draft must prefill the store id, the timestamp and the key fingerprint (got ${JSON.stringify(reportBody.slice(0, 160))})`);
    await assert(!/원|직원|명단/.test(reportBody), 'the report draft must not carry any employee or amount data');
    const takenToast = (await page.locator('.toast').count()) ? await page.locator('.toast').innerText() : '';
    await assert(!takenToast.includes('인터넷'), 'the misleading network toast must not stack on top of the auth_required alert');
    regMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(!regMeta.restaurantId, 'an auth_required registration must roll back restaurantId like any failure');
    await assert(regMeta.storeRegisterPending === true, 'an auth_required registration must keep storeRegisterPending');

    // ── beta.49(c): 401은 "등록 안 됨"이 아니라 **"다른 기기에 등록됨"** 이다 ─────────────────
    //   alert는 한 번 닫으면 사라진다 — 표지를 남겨 홈 칩·배너·설정 카드가 계속 같은 사실을 말하게 한다.
    await assert(regMeta.storeRegisterBlocked && regMeta.storeRegisterBlocked.id === 'rid-mine-1' && regMeta.storeRegisterBlocked.name === 'Harness Shop',
      `an auth_required registration must remember which store is taken (got ${JSON.stringify(regMeta.storeRegisterBlocked)})`);
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(150);
    await assert((await page.locator('.pill-alert-soft').innerText()).trim() === '공공기관 명단 받기: 다른 기기에 등록됨',
      'a blocked store must say so on the home status chip (not the generic 등록 안 됨)');
    await assert(await count(page, '.pill-muted') === 0, 'the generic "등록 안 됨" chip must not stack on top of the blocked chip');
    {
      const b = await page.locator('.banner[data-a="go-register-store"]').innerText();
      await assert(b.includes('예전 폰(다른 기기)에 등록된 가게예요') && b.includes('Harness Shop'),
        `the blocked banner must name the store it is talking about (got ${JSON.stringify(b.replace(/\n/g, ' '))})`);
    }
    // (f) 재시작해도 표지가 남는다(META_KEYS 등재 — 등재하지 않으면 저장돼도 재시작 후 사라진다).
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await installRelaySpy();
    await page.waitForTimeout(200);
    await assert(await count(page, '.pill-alert-soft') === 1, 'the blocked state must survive a restart (meta.storeRegisterBlocked in META_KEYS)');
    // 배너를 누르면 검색 모달이 아니라 **해결 방법**으로 간다 — 같은 가게를 다시 고르면 같은 실패로 되돌아온다.
    await page.locator('.banner[data-a="go-register-store"]').click({ position: { x: 30, y: 40 } });
    await page.waitForTimeout(250);
    await assert(await count(page, '#storeName') === 0, 'a blocked store must not be sent back into the store-search modal');
    await assert((await page.locator('.fold-head[data-card="enroll-auto"]').getAttribute('aria-expanded')) === 'true',
      'tapping the blocked banner must open the auto-enroll card with the guidance');
    {
      const cardTxt = await page.locator(autoCardScope).innerText();
      await assert(cardTxt.includes('이미 등록되어 있어요') && cardTxt.includes('Harness Shop'), 'the card must repeat the "already registered" fact inline');
      await assert(cardTxt.includes('자동 등록 중단') && cardTxt.includes('내 열쇠 백업') && cardTxt.includes('contact@bapjangbu.com'),
        `the inline guidance must keep all three ways out (got ${JSON.stringify(cardTxt.slice(0, 400))})`);
      await assert(await count(page, `${autoCardScope} [data-a="retry-blocked-register"]`) === 1, 'the blocked card must offer [다시 등록해 보기]');
      await assert(await count(page, `${autoCardScope} [data-a="relay-find-store"]`) === 1, 'the blocked card must offer [다른 가게 고르기]');
      await assert((await page.locator(`${autoCardScope} [data-a="relay-find-store"]`).innerText()).includes('다른 가게 고르기'),
        'the blocked card must relabel the search entry as [다른 가게 고르기] (the old [우리 가게 등록] leads straight back into the same failure)');
      await assert(await count(page, `${autoCardScope} [data-a="report-takeover"]`) === 1, 'the inline guidance must keep the takeover-report path reachable');
      // beta.50: [신고하기]는 confirm 뒤 location.href가 아니라 **진짜 mailto 링크**여야 한다 — 확인창을 읽는 동안
      //   브라우저의 사용자 활성(약 5초)이 만료돼 메일이 조용히 안 열리던 현장 결함. 메일 앱이 없는 폰을 위한 [복사]도 함께.
      const reportLink = await page.evaluate(scope => { const a = document.querySelector(scope + ' [data-a="report-takeover"]'); return a ? { tag: a.tagName, href: a.getAttribute('href') || '' } : null; }, autoCardScope);
      await assert(reportLink && reportLink.tag === 'A' && reportLink.href.startsWith('mailto:contact@bapjangbu.com?'),
        `[신고하기] must be a real mailto link, not a confirm+location.href handoff (got ${JSON.stringify(reportLink)})`);
      const reportLinkBody = decodeURIComponent((reportLink.href.split('&body=')[1] || ''));
      await assert(/가게 번호: \S/.test(reportLinkBody) && reportLinkBody.includes('열쇠 지문:') && !/원|직원|명단/.test(reportLinkBody),
        `the mailto link must carry the blocked store id and fingerprint and nothing about employees (got ${JSON.stringify(reportLinkBody.slice(0, 160))})`);
      await assert(await count(page, `${autoCardScope} [data-a="report-copy"]`) === 1, 'the inline guidance must offer [신고 내용 복사] for phones without a mail app');
      const primaries = await page.evaluate(scope => [...document.querySelectorAll(scope + ' .btn-primary')].map(b => b.dataset.a || ''), autoCardScope);
      await assert(primaries.length === 1 && primaries[0] === 'retry-blocked-register',
        `the blocked card must hold exactly one primary button, [다시 등록해 보기] (got ${JSON.stringify(primaries)})`);
    }
    // 예전 폰에서 등록을 해제한 뒤(= 서버가 200을 주기 시작) [다시 등록해 보기]로 그대로 끝낼 수 있어야 한다.
    registerStatus = 200;
    registerErrorCode = 'internal';
    await page.locator(`${autoCardScope} [data-a="retry-blocked-register"]`).click();
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 10000 });
    await page.waitForTimeout(300);
    {
      const m = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
      await assert(m.restaurantId === 'rid-mine-1', '[다시 등록해 보기] must register the very store the blocked marker pointed at');
      await assert(!m.storeRegisterBlocked, 'a successful registration must clear the blocked marker');
    }
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(150);
    await assert(await count(page, '.pill-alert-soft') === 0 && await count(page, '.pill-muted') === 0,
      'once registered, neither the blocked nor the unregistered chip may remain');
    await assert((await page.locator('.pill-relay').innerText()).includes('공공기관 명단 받는 중'), 'a retry that succeeds must flip the chip to 공공기관 명단 받는 중');
    // 아래 (2) 성공 경로는 "아직 미등록" 상태를 전제로 하므로 등록을 되돌려 둔다(서버 목만 바꾸는 구간이라 실제 해제는 불필요).
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta'], 'readwrite');
        const ms = tx.objectStore('meta');
        ['restaurantId', 'relayStoreName', 'relayRegisteredAt', 'storeAddr', 'districtSyncedAt', 'storeRegisterBlocked'].forEach(k => ms.delete(k));
        ms.put({ key: 'storeRegisterPending', value: true });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
    }));
    await page.reload({ waitUntil: 'load' });
    await unlock();
    await installRelaySpy();
    await page.waitForTimeout(200);

    // (2) 성공 경로: register-key 200 → 등록 확정 + 열쇠 백업 유도 + 새 신청 칩
    registerStatus = 200;
    registerErrorCode = 'internal';
    inboxCountBody = { count: 2 };
    await pickStore();
    regMeta = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
    await assert(regMeta.restaurantId === 'rid-mine-1', 'a successful register-key should persist the picked restaurant id');
    await assert(regMeta.storeRegisterPending === false, 'a successful registration should clear the pending flag');
    // 설정 경로도 온보딩과 같은 계약: 고른 가게의 공식 주소를 남기고 district를 실어 보낸다(라이브 D1 전건 NULL이었던 결함).
    await assert(regMeta.storeAddr === '서울특별시 광진구 아차산로 399, 1층 B호 (구의동)', 'picking a store in settings must persist its official address in meta.storeAddr');
    await assert(registerCalls[registerCalls.length - 1].district === '서울특별시 광진구', `the settings registration must carry district "시도 시군구" (got ${JSON.stringify(registerCalls[registerCalls.length - 1].district)})`);
    await assert(typeof regMeta.districtSyncedAt === 'number' && regMeta.districtSyncedAt > 0, 'sending a district should stamp districtSyncedAt');
    await assert(await page.locator('[data-a="relay-find-store"]', { hasText: '우리 가게 등록' }).count() === 0, 'the duplicate [우리 가게 등록] button must disappear once the store is registered');
    await assert((await page.locator('.app').innerText()).includes('관할 지역: 서울특별시 광진구'), 'the registered settings card should display the jurisdiction it sent');
    const settingsAfterReg = await page.locator('.app').innerText();
    await assert(settingsAfterReg.includes('공공기관 명단 받는 중'), 'the settings auto-enrollment card should label the registered store 공공기관 명단 받는 중');
    await assert(settingsAfterReg.includes('아직 안 함'), 'the key pointer should carry a ⚠️ badge while no locked own backup (with the key) has been made (B3)');
    // beta.40: 새 신청이 있으면(count=2) 설정의 [온라인 자동 등록] 버튼은 흐린 모습을 벗고 활성(btn-primary)+숫자 배지가 된다.
    {
      const activeInbox = page.locator('.card.settings-card:has(.fold-head[data-card="enroll-auto"]) [data-a="relay-inbox"]');
      await assert(await activeInbox.count() === 1, 'the expanded auto card must show the 온라인 자동 등록 button after registration (go-register-store deep-link keeps it open)');
      const cls = (await activeInbox.getAttribute('class')) || '';
      await assert(cls.includes('btn-primary') && !cls.includes('btn-idle'), `with pending requests the 온라인 자동 등록 button must be active btn-primary (got ${JSON.stringify(cls)})`);
      await assert((await activeInbox.innerText()).includes('2'), 'the active 온라인 자동 등록 button must carry the pending-count badge');
    }
    // ── beta.49(e 원복): 등록되면 잠겼던 두 곳이 원래 모습으로 돌아온다 ──────────────────────
    {
      // beta.55(A2): 장부 지키기 카드에 서버 줄·글씨 링크(자동 백업 끄기·서버 백업 지우기)가 돌아온다.
      await openSettingsCard(page, 'ledger');
      await assert(await count(page, `${guardScope} [data-a="toggle-auto-cloud"]`) === 1 && await count(page, `${guardScope} [data-a="cloud-backup-delete"]`) === 1,
        'the 장부 지키기 card must get its server links back once the store is registered');
      await assert((await page.locator('#guardState').innerText()).includes('서버 자동 백업 (매주)') && !(await page.locator('#guardState').innerText()).includes('가게를 등록하면'),
        'the status box must show the server row (not the registration reason) once the store is registered');
      await openSettingsCard(page, 'enroll-manual');
      await assert(await count(page, `${manualCardScope} [data-a="direct-transfer-open"]`) === 1,
        'the 수동 등록 card must hold the 담당자에게 받은 파일 entry point once the store is registered');
      await assert(await count(page, `${manualCardScope} [data-a="go-register-store"]`) === 0, 'the lock notice must be gone once the store is registered');
      const manualCardText = await page.locator(manualCardScope).innerText();
      // beta.45(현장 지시): 구역 이름은 '공공기관 담당자에게 전달받기'이고, 파일 버튼의 이름은 출처를 말한다
      //   ('전달파일'이라는 말은 바로 위 [엑셀 명단(CSV)]과 구별되지 않아 사장님이 둘을 헷갈렸다).
      await assert(manualCardText.includes('공공기관 담당자에게 전달받기'), 'the 수동 등록 card must label the 전달받기 section');
      await assert(manualCardText.includes('카톡·메일로 보낸 명단 파일'), 'the file entry point must name where the file came from, so it is not confused with the CSV import');
      await assert(manualCardText.includes('QR(사각 코드)'), 'the 수동 등록 card must hold the QR entry point (button or unsupported notice)');
      // 순서 계약(현장 지시): ①엑셀 명단(CSV) → ②담당자에게 전달받기(파일·QR) → ③한 명씩 → ④빠른 등록.
      const manualOrder = await page.evaluate(scope => {
        const card = document.querySelector(scope);
        const y = sel => { const el = card.querySelector(sel); return el ? el.getBoundingClientRect().top : NaN; };
        return { csv: y('[data-a="csv-import"]'), file: y('[data-a="direct-transfer-open"]'), one: y('[data-a="add-employee"]'), quick: y('[data-a="quick-add-employee"]') };
      }, manualCardScope);
      await assert(manualOrder.csv < manualOrder.file && manualOrder.file < manualOrder.one && manualOrder.one < manualOrder.quick,
        `수동 등록 order must read CSV → 담당자 파일 → 한 명씩 → 빠른 등록 (got ${JSON.stringify(manualOrder)})`);
      // 카드 안의 진한 버튼은 하나뿐이다 — 여럿이면 "무엇부터"가 사라진다.
      const manualPrimary = await page.evaluate(scope => document.querySelectorAll(scope + ' .btn-primary.action-btn').length, manualCardScope);
      await assert(manualPrimary === 1, `the 수동 등록 card must have exactly one primary action button (got ${manualPrimary})`);
    }
    // ── beta.49(d 계속): 검색 결과에 **이 기기가 등록한 우리 가게**가 나오면 "남이 가져갔다"가 아니다 ──
    {
      registeredIdsBody = ['rid-mine-1', 'rid-other-1'];
      await openSettingsCard(page, 'enroll-auto');
      await page.locator(`${autoCardScope} [data-a="relay-find-store"]`).click();
      await page.waitForSelector('#storeName');
      await page.locator('#storeName').fill('하네스김밥');
      await page.locator('[data-a="relay-search-stores"]').click();
      await page.waitForSelector('[data-a="relay-pick-store"]');
      await page.waitForSelector('.badge-soft.mine', { timeout: 8000 });
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-a="relay-pick-store"]')].map(b => {
        const slot = b.parentElement.querySelector('.store-badge-slot');
        return { id: b.dataset.id, badge: slot ? slot.innerText.trim() : '(no slot)' };
      }));
      await assert(JSON.stringify(rows) === JSON.stringify([
        { id: 'rid-other-1', badge: '다른 기기에서 이미 등록됨' },
        { id: 'rid-mine-1', badge: '우리 가게(등록됨)' }
      ]), `our own registered store must read 우리 가게(등록됨), not "다른 기기에서 이미 등록됨" (got ${JSON.stringify(rows)})`);
      registeredIdsBody = [];
      await page.locator('[data-a="close-modal"]').click();
      await page.waitForTimeout(150);
    }
    // ── beta.48(F5): 이미 등록된 기기가 **다시** 등록을 보낼 때는 소유 증명을 함께 싣는다 ─────────
    //   서버는 "같은 열쇠라도 저장된 관할(district)을 다른 값으로 덮어쓰려면" 인증을 요구한다.
    //   토큰 없이 보내면 401 → 앱이 "이미 등록되어 있어요"로 오안내한다(자기 가게인데 막힌다).
    {
      const before = registerCalls.length;
      await page.locator('[data-a="relay-send-district"]').click();
      await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 10000 });
      await page.waitForTimeout(300);
      await assert(registerCalls.length === before + 1, `[관할 정보 보내기] must call register-key exactly once (got ${registerCalls.length - before})`);
      const last = registerCalls[registerCalls.length - 1];
      await assert(typeof last.auth_token === 'string' && last.auth_token.length > 0,
        `a re-registration from an already-registered device must carry the ownership proof (got ${JSON.stringify(Object.keys(last))})`);
      await assert(last.district === '서울특별시 광진구', 're-registration must still carry the jurisdiction');
    }
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.evaluate(() => window.__prepaidTestHooks.refreshInboxCount());
    await page.waitForTimeout(300);
    await assert(await count(page, '[data-a="go-register-store"]') === 0, 'the finish-registration banner must disappear once the store is registered');
    await assert((await page.locator('.pill-relay').innerText()).includes('공공기관 명단 받는 중'), 'home should show the 공공기관 명단 받는 중 status chip');
    // beta.49(b): 등록되면 "등록 안 됨"·"다른 기기에 등록됨" 칩은 사라진다(상태는 하나만 말한다).
    await assert(await count(page, '.pill-muted') === 0 && await count(page, '.pill-alert-soft') === 0,
      'a registered store must not keep an "unregistered"/"blocked" chip beside the receiving chip');
    await assert(await count(page, '.guard-banner [data-a="dismiss-guard-banner"]') === 1 && (await page.locator('.guard-banner').innerText()).includes('가게 열쇠'), 'home should nudge an un-backed-up key with a dismissible banner (B3, beta.55: the 장부 지키기 banner)');
    const inboxPill = await page.locator('[data-a="relay-inbox"]').innerText();
    await assert(inboxPill.includes('📩') && inboxPill.includes('2건'), 'a 200 inbox-count should render the 📩 new-request chip on home');

    // ── beta.46: 현장 결함 고정 — 사무실 와이파이에서 배지를 본 태블릿이 가게(오프라인)에서
    //    다시 열렸을 때 배지가 사라져 보이던 문제. 계약 4개를 고정한다. ──
    // (a) 성공한 조회값은 기기(meta.inboxCountCache)에 저장된다
    await page.waitForTimeout(300);
    {
      const m46 = (await readDb(page)).meta.reduce((a, r) => (a[r.key] = r.value, a), {});
      await assert(m46.inboxCountCache === 2, `a successful inbox-count must persist the last-known badge to meta.inboxCountCache (got ${JSON.stringify(m46.inboxCountCache)})`);
    }
    // (b) 조회 실패(네트워크 오류) = 배지 유지 — 지우지 않는다
    inboxCountBody = 'netfail';
    await page.evaluate(() => window.__prepaidTestHooks.refreshInboxCount(0));
    await page.waitForTimeout(400);
    await assert((await page.locator('[data-a="relay-inbox"]').first().innerText()).includes('2건'), 'a failed inbox-count poll must keep the last-known badge (never clear it)');
    // (c) 재시작 복원 — 조회가 계속 실패해도(가게 이동 시나리오) 마지막 확인값이 되살아난다
    await page.reload({ waitUntil: 'load' });
    await unlockPin(page);
    await page.waitForTimeout(400);
    await assert((await page.locator('[data-a="relay-inbox"]').first().innerText()).includes('2건'), 'after a restart with the server unreachable the badge must be restored from the device cache');
    // (d) 오프라인 안내 — 등록 가게가 오프라인이면 명단 확인에 인터넷이 필요함을 홈에서 말한다
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(300);
    {
      const offTxt = await page.locator('.pill-row').innerText();
      await assert(offTxt.includes('인터넷'), `while offline a registered store must be told roster checks need internet (got ${JSON.stringify(offTxt.slice(0, 120))})`);
      await assert(offTxt.includes('2건'), 'the cached badge must stay visible even while offline');
    }
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    inboxCountBody = { count: 2 };
    await page.waitForTimeout(400);
    await page.locator('[data-a="dismiss-guard-banner"]').click();
    await page.waitForTimeout(150);
    await assert(await count(page, '.guard-banner') === 0, 'dismissing the key-backup banner should hide it for this session');

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
      // payer(입금자명, beta.32): 선택 필드 — batch_hash canonical(name|dept|amount)에 절대 불포함.
      const items = [{ name: '공공직원', dept: '세무과', amount: 30000, payer: '김서무' }];
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
    const dialogsBeforeDt = dialogs.length;
    await page.locator('#directTransferFile').setInputFiles({ name: 'transfer.json', mimeType: 'application/json', buffer: Buffer.from(dtJson, 'utf8') });
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    // beta.33 검토 확인창(결제 대조): 맨 위 3줄(받으실 금액·기관/부서·결제자)과 이름 단위 내역이 한 창에 있어야 한다.
    const dtReview = dialogs.slice(dialogsBeforeDt).find(d => d.type === 'confirm' && d.message.includes('받으실 금액'));
    await assert(Boolean(dtReview), 'the direct-transfer flow must show the payment-verification review confirm');
    await assert(/^받으실 금액 30,000원 · 1명\n기관·부서: .*강남구청/.test(dtReview.message),
      `the review confirm must open with 받으실 금액 then 기관·부서 (got ${JSON.stringify(dtReview.message.slice(0, 120))})`);
    await assert(dtReview.message.includes('결제자·입금자명: 김서무'), 'the review confirm must show the payer name from the roster (결제 대조 기준)');
    await assert(dtReview.message.includes('30,000') && dtReview.message.includes('공공직원'), 'the review confirm must itemize names and the total to verify against the payment record');
    // 직접 전달은 서버 인증을 거치지 않으므로 도메인은 "확인 불가"여야 한다(F-04).
    await assert(dtReview.message.includes('인증 도메인: 확인 불가(직접 전달)'),
      `a direct transfer carries no authenticated domain, so the review must say 확인 불가 (got ${JSON.stringify(dtReview.message)})`);
    await assert(dtReview.message.includes('기관명은 담당자가 직접 적는 값'), 'the review must warn that the institution name is self-declared');
    // 결제구분(payMethod)이 없는 명단이므로 모든 수단의 확인처를 병기해야 한다.
    await assert(dtReview.message.includes('실제로 받으셨는지 확인하셨으면') && dtReview.message.includes('(카드결제면 매출전표·POS 정산 내역, 계좌이체·제로페이면 통장 입금 내역)'),
      `without 결제구분 the confirm sentence must name both payment records (got ${JSON.stringify(dtReview.message)})`);
    await assert(!dtReview.message.includes('결제 방식:'), 'a roster without 결제구분 must not claim a payment method');
    // 아직 결제를 못 받은 사장님의 출구(취소)를 명시해야 한다 — 직접 전달은 받은 파일로 다시 열 수 있다.
    await assert(dtReview.message.includes('아직 결제를 못 받으셨으면 [취소]') && dtReview.message.includes('받은 파일(또는 QR)로 나중에 다시 열 수 있어요'),
      `the direct-transfer review must offer the "not paid yet → cancel" exit (got ${JSON.stringify(dtReview.message)})`);
    const orgDb = await readDb(page);
    const empRelay = orgDb.employees.find(e => e.name === '공공직원');
    await assert(Boolean(empRelay), 'a direct-transfer batch should create the employee');
    await assert(empRelay.org === '강남구청', 'the institution must be stored in the new org field, not merged into dept');
    await assert(empRelay.dept === '세무과', 'the department must be stored on its own (no "기관명 부서명" concatenation)');
    await assert(empRelay.orgKind === 'public', 'a direct-transfer (institution) employee must be flagged orgKind=public for home grouping');
    const payerTx = orgDb.transactions.find(tx => tx.employeeId === empRelay.id && tx.type === 'open');
    await assert(Boolean(payerTx) && payerTx.note.includes('· 결제 김서무'), `the transaction note must carry the payer for audit under the payment-neutral prefix (got ${JSON.stringify(payerTx && payerTx.note)})`);

    // ── 중복 명단 경고(beta.32) — 하드 차단이 아니라 "언제 올렸는지"를 실은 경고 + 사장님 판단 ──
    //   같은 파일을 다시 열면: ①경고 문구가 뜨고 ②[취소]하면 아무것도 변하지 않아야 한다.
    confirmAnswer = false;
    const dialogsBeforeDup = dialogs.length;
    const txCountBeforeDup = orgDb.transactions.length;
    await page.locator('#directTransferFile').setInputFiles({ name: 'transfer-again.json', mimeType: 'application/json', buffer: Buffer.from(dtJson, 'utf8') });
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
    await page.waitForTimeout(300);
    confirmAnswer = true;
    const dupReview = dialogs.slice(dialogsBeforeDup).find(d => d.type === 'confirm' && d.message.includes('완전히 같아요'));
    await assert(Boolean(dupReview), 're-opening the same transfer must warn that this roster was already registered (dated duplicate warning)');
    await assert(dupReview.message.includes('별도로 한 번 더 받으신 경우에만(카드 전표·입금 내역 확인)'), 'the duplicate warning must tell the owner to decide by the actual payment received, card or transfer (사용자 원칙)');
    await assert((await readDb(page)).transactions.length === txCountBeforeDup, 'declining the duplicate warning must leave the ledger untouched');

    // ── beta.48: 전달 번호(transfer_id)가 있는 파일은 **재열기 자체가 막힌다** ────────────────
    //   batch_hash는 "같은 이름·금액"이면 달이 달라도 같아서 경고까지만 할 수 있었다(사장님 판단).
    //   transfer_id는 파일 한 장을 가리키므로 "같은 파일을 두 번 올렸다"가 확실하다 — 그때는 묻지 않고 막는다.
    const tidJson = await page.evaluate(async ({ pubKey, rid }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const items = [{ name: '전달번호직원', dept: '자치행정과', amount: 7000 }];
      const h = async t => { const d = await crypto.subtle.digest('SHA-256', enc.encode(String(t))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
      const aesRaw = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
      return JSON.stringify({
        v: 1, type: 'direct-transfer', transfer_id: 'tid-harness-0001', restaurant_id: rid, restaurant_name: 'Harness Shop',
        institution: '강남구청', department: '자치행정과', year_month: '2026-07',
        summary: { total_amount: 7000, member_count: 1, batch_hash },
        ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
      });
    }, { pubKey: regMeta.pubKey, rid: regMeta.restaurantId });
    const txBeforeTid = (await readDb(page)).transactions.length;
    await page.locator('#directTransferFile').setInputFiles({ name: 'with-tid.json', mimeType: 'application/json', buffer: Buffer.from(tidJson, 'utf8') });
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
    await page.waitForTimeout(350);
    const afterTid = await readDb(page);
    await assert(afterTid.transactions.length === txBeforeTid + 1, 'a transfer carrying a transfer_id must still register normally the first time');
    const tidLog = (afterTid.meta.find(r => r.key === 'receivedTransferLog') || {}).value;
    await assert(Array.isArray(tidLog) && tidLog.some(r => r && r.id === 'tid-harness-0001'),
      `the transfer_id must be recorded in meta.receivedTransferLog (got ${JSON.stringify(tidLog)})`);
    const dialogsBeforeTidAgain = dialogs.length;
    await page.locator('#directTransferFile').setInputFiles({ name: 'with-tid-again.json', mimeType: 'application/json', buffer: Buffer.from(tidJson, 'utf8') });
    await page.waitForTimeout(500);
    const tidAgain = dialogs.slice(dialogsBeforeTidAgain);
    await assert(tidAgain.some(d => d.type === 'alert' && d.message.includes('이미 장부에 올렸어요')),
      `re-opening the very same transfer file must be blocked outright (got ${JSON.stringify(tidAgain.map(d => d.type + ':' + d.message.slice(0, 40)))})`);
    await assert(!tidAgain.some(d => d.type === 'confirm' && d.message.includes('받으실 금액')),
      'a blocked re-open must never reach the review confirm (the owner is not asked to judge a file we know we already used)');
    await assert((await readDb(page)).transactions.length === txBeforeTid + 1, 're-opening the same transfer file must not add a second transaction');

    // ── 결제구분(payMethod, beta.33) — 명단에 실려 오면 그 수단에 맞는 확인처만 안내한다 ──
    //   담당자 웹 CSV의 선택 열 '결제구분'(카드/계좌이체/공백)이 items[].payMethod로 실려 온다.
    //   batch_hash canonical(name|dept|amount)에는 들어가지 않으므로, 값이 있어도 확인값 검증은 그대로 통과해야 한다.
    const makePayMethodTransfer = (payMethod, name, amount) => page.evaluate(async ({ pubKey, rid, payMethod, name, amount }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const items = [{ name, dept: '세무과', amount, payMethod }];
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
        summary: { total_amount: amount, member_count: 1, batch_hash },
        ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
      });
    }, { pubKey: regMeta.pubKey, rid: regMeta.restaurantId, payMethod, name, amount });
    confirmAnswer = false;// 문구만 확인하고 전부 취소한다 — 장부는 그대로여야 한다.
    for (const c of [
      { pm: '카드', label: '카드결제', expect: '(카드 매출전표·POS 정산 내역)', forbid: '통장 입금 내역', name: '카드결제직원', amount: 11000 },
      { pm: '계좌이체', label: '계좌이체', expect: '(통장 입금 내역)', forbid: '매출전표', name: '이체결제직원', amount: 12000 },
      // beta.47: 공공기관 제로페이 결제. 돈은 가맹점 계좌로 들어오므로 통장 내역도 함께 안내한다.
      { pm: '제로페이', label: '제로페이', expect: '(제로페이 가맹점 앱 정산 내역 또는 통장 입금 내역)', forbid: '매출전표', name: '제로페이직원', amount: 13000 }
    ]) {
      const json = await makePayMethodTransfer(c.pm, c.name, c.amount);
      const before = dialogs.length;
      const txBefore = (await readDb(page)).transactions.length;
      await page.locator('#directTransferFile').setInputFiles({ name: 'pay-method.json', mimeType: 'application/json', buffer: Buffer.from(json, 'utf8') });
      await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
      await page.waitForTimeout(300);
      const rv = dialogs.slice(before).find(d => d.type === 'confirm' && d.message.includes('받으실 금액'));
      await assert(Boolean(rv), `a roster carrying 결제구분=${c.pm} must still open the review confirm (batch_hash unaffected by the optional field)`);
      await assert(rv.message.includes(`결제 방식: ${c.label} (명단에 표기됨)`), `the review must state the declared payment method (got ${JSON.stringify(rv.message)})`);
      await assert(rv.message.includes(c.expect) && !rv.message.includes(c.forbid),
        `결제구분=${c.pm} must point at that record only (got ${JSON.stringify(rv.message)})`);
      await assert((await readDb(page)).transactions.length === txBefore, 'cancelling the 결제구분 review must leave the ledger untouched');
    }
    // 카드결제면 입금자명이 비어 있는 것이 정상 — 그 사실을 폴백 문구로 알려야 한다.
    const cardReview = dialogs.filter(d => d.type === 'confirm' && d.message.includes('결제 방식: 카드결제')).pop();
    await assert(cardReview.message.includes('결제자·입금자명: (명단에 없음 — 카드결제면 비어 있을 수 있어요)'),
      `an empty payer must be explained as normal for card payments (got ${JSON.stringify(cardReview.message)})`);
    confirmAnswer = true;

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

    // (b)(c) 소속을 입력한 등록 / 소속을 비운 등록 — beta.29: 리로드 후라 수동 등록 카드를 다시 펼친다.
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'enroll-manual');
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
    const sentAtFixture = Date.UTC(2026, 7, 3, 4, 5, 0);// 명단 전송 시각(고정) — 확인창 표기와 대조한다.
    await page.evaluate(async ({ pubKey, sentAtFixture }) => {
      window.__sentAtFixture = sentAtFixture;
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
        // agency_domain(F-04): 서버가 담당자 이메일 OTP 토큰에서만 읽어 싣는 값. created_at은 명단 전송 시각.
        summary: { restaurant_name: 'Harness Shop', institution: '강남구청', department: '세무과', year_month: '2026-08', total_amount: 20000, member_count: 1, batch_hash, agency_domain: 'gangnam.go.kr', created_at: window.__sentAtFixture },
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
    }, { pubKey: relayMeta.pubKey, sentAtFixture });
    const beforeApprove = await readDb(page);
    const activeBefore = beforeApprove.employees.filter(e => !e.isDeleted).length;
    await openSettingsCard(page, 'enroll-auto');// beta.29: 신청 확인 버튼은 접힌 자동 등록 카드 안에 있다
    await page.locator('[data-a="relay-inbox"]').first().click();
    await page.waitForSelector('[data-a="relay-approve"]', { timeout: 8000 });
    // beta.33: 수신함 카드 자체가 인증 도메인·전송 시각을 보여주고, 승인 버튼은 "결제 확인 후 승인"이다.
    const inboxModalText = await page.locator('.modal').innerText();
    await assert(inboxModalText.includes('인증 도메인: gangnam.go.kr'), `the inbox card must show the authenticated agency domain (got ${JSON.stringify(inboxModalText)})`);
    await assert(inboxModalText.includes('명단 전송'), 'the inbox card must show when the roster was sent');
    await assert(inboxModalText.includes('결제 확인 후 승인') && !inboxModalText.includes('통장 확인 후 승인'),
      `the approve button must read 결제 확인 후 승인 (got ${JSON.stringify(inboxModalText)})`);
    await assert(inboxModalText.includes('결제 내역(카드 매출전표·통장 입금)과 금액을 대조한 뒤 승인하세요') && inboxModalText.includes('기관명은 담당자가 직접 적는 값이라'),
      `the inbox help must ask for a payment-record match and warn that the institution name is self-declared (got ${JSON.stringify(inboxModalText)})`);
    // 출구 안내가 사실인지 못 박는다 — [취소]하면 서버로 승인/거절 호출이 나가지 않아 신청은 PENDING으로 남는다.
    confirmAnswer = false;
    const txBeforeCancel = (await readDb(page)).transactions.length;
    await page.locator('[data-a="relay-approve"]').click();
    await page.waitForTimeout(500);
    await assert((await page.evaluate(() => window.__approveCalls.length)) === 0, 'cancelling the review must not call /api/approve — the request must stay PENDING so the owner can reopen it');
    await assert((await readDb(page)).transactions.length === txBeforeCancel, 'cancelling the review must leave the ledger untouched');
    confirmAnswer = true;
    const dialogsBeforeApprove = dialogs.length;
    await page.locator('[data-a="relay-approve"]').click();
    await page.waitForSelector('[data-a="relay-approve"]', { state: 'detached', timeout: 15000 });
    await page.waitForTimeout(500);
    // beta.33: 서버 승인도 같은 "결제 대조" 검토 확인창을 쓴다 — 충전 대상은 잔액 변화(현재 → 이후)까지 보인다.
    const apReview = dialogs.slice(dialogsBeforeApprove).find(d => d.type === 'confirm' && d.message.includes('받으실 금액'));
    await assert(Boolean(apReview), 'the server-approve flow must show the payment-verification review confirm');
    await assert(apReview.message.includes('이미 있는 직원 충전') && apReview.message.includes('공공직원: 30,000원 → 50,000원'),
      `the review confirm must show the balance change per topped-up employee (got ${JSON.stringify(apReview && apReview.message)})`);
    // F-04: 인증된 이메일 도메인이 있으면 그대로 보여야 한다(기관명은 자칭 값이라 사칭이 가능하다).
    await assert(apReview.message.includes('인증 도메인: gangnam.go.kr'), `the approve review must show the authenticated agency domain (got ${JSON.stringify(apReview.message)})`);
    // 명단 전송 시각 — 사장님이 그 날짜의 매출전표·통장 내역에서 결제 건을 찾을 수 있어야 한다.
    const sentStamp = (() => { const d = new Date(sentAtFixture), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
    await assert(apReview.message.includes(`명단 전송 시각: ${sentStamp}`), `the approve review must show when the roster was sent (expected ${sentStamp}, got ${JSON.stringify(apReview.message)})`);
    // 아직 결제를 못 받았으면 [취소] — 취소해도 서버 신청은 PENDING으로 남아 3일 안에 다시 열 수 있다.
    await assert(apReview.message.includes('아직 결제를 못 받으셨으면 [취소]') && apReview.message.includes('신청은 그대로 남아 나중에 다시 열 수 있어요(3일 이내)'),
      `the approve review must offer the "not paid yet → cancel" exit (got ${JSON.stringify(apReview.message)})`);
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

    // ── 교차 경로 중복(beta.32) — 서버 승인으로 이미 올린 명단을 직접 전달 파일로 다시 열면 경고가 떠야 한다 ──
    //   여러 담당자가 "앱으로도 보내고 파일로도 건네는" 혼용에서 잔액이 두 배로 잡히던 구멍(검토 항목 2).
    const crossJson = await page.evaluate(async ({ pubKey, rid }) => {
      const enc2 = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
      const b2u = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const items = [{ name: '공공직원', dept: '세무과', amount: 20000 }];// (h)에서 서버 승인한 명단과 동일
      const h2 = async t => { const d2 = await crypto.subtle.digest('SHA-256', enc2.encode(String(t))); return Array.from(new Uint8Array(d2)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      const batch_hash = await h2(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
      const aesRaw = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc2.encode(JSON.stringify({ items })));
      const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
      return JSON.stringify({
        v: 1, type: 'direct-transfer', restaurant_id: rid, restaurant_name: 'Harness Shop',
        institution: '강남구청', department: '세무과', year_month: '2026-08',
        summary: { total_amount: 20000, member_count: 1, batch_hash },
        ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
      });
    }, { pubKey: relayMeta.pubKey, rid: (await readDb(page)).meta.find(r => r.key === 'restaurantId').value });
    confirmAnswer = false;
    const dialogsBeforeCross = dialogs.length;
    const txCountBeforeCross = afterApprove.transactions.length;
    await page.locator('#directTransferFile').setInputFiles({ name: 'cross-dup.json', mimeType: 'application/json', buffer: Buffer.from(crossJson, 'utf8') });
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 8000 });
    await page.waitForTimeout(300);
    confirmAnswer = true;
    const crossReview = dialogs.slice(dialogsBeforeCross).find(d => d.type === 'confirm' && d.message.includes('완전히 같아요'));
    await assert(Boolean(crossReview), 'a direct-transfer of a roster already approved via the server must raise the duplicate warning (cross-mode)');
    await assert((await readDb(page)).transactions.length === txCountBeforeCross, 'declining the cross-mode duplicate must leave the ledger untouched');

    // ══ beta.48: 승인 아웃박스 — "장부에 넣었는데 서버에 못 알린" 상태를 앱이 기억한다 ══════════
    //   현장 결함: 승인은 ①장부 반영 ②서버 통보의 두 걸음인데, ②가 실패해도 앱은 항목을 지우고 넘어갔다.
    //   그 신청은 다음 조회에서 PENDING으로 되살아나고, 사장님이 다시 승인하면 **선금이 두 배**가 된다.
    const installOutboxSpy = async (specs, status) => page.evaluate(async ({ pubKey, specs, status }) => {
      const enc = new TextEncoder();
      const u2b = b => { const u = new Uint8Array(b); let s2 = ''; for (let i = 0; i < u.length; i++) s2 += String.fromCharCode(u[i]); return btoa(s2); };
      const b2u = s2 => { const bin = atob(s2); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      const h = async t => { const d = await crypto.subtle.digest('SHA-256', enc.encode(String(t))); return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join(''); };
      const mk = async (sid, items) => {
        const batch_hash = await h(items.map(i => i.name + '|' + i.dept + '|' + Number(i.amount)).sort().join('\n'));
        const aesRaw = crypto.getRandomValues(new Uint8Array(32));
        const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify({ items })));
        const pub = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
        const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, aesRaw);
        return {
          summary_id: sid,
          summary: { restaurant_name: 'Harness Shop', institution: '강남구청', department: '문화체육과', year_month: '2026-09', total_amount: items.reduce((a, x) => a + x.amount, 0), member_count: items.length, batch_hash, agency_domain: 'gangnam.go.kr' },
          ciphertext: { alg: 'RSA-OAEP+AES-GCM', encKey: u2b(encKey), iv: u2b(iv), ct: u2b(ct) }
        };
      };
      window.__inboxItems = [];
      for (const sp of specs) window.__inboxItems.push(await mk(sp.sid, sp.items));
      window.__approveStatus = status;
      window.__notifyCalls = [];
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const url = String(u);
        if (url.includes('/api/inbox?')) return new Response(JSON.stringify(window.__inboxItems), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.includes('/api/approve')) {
          window.__notifyCalls.push(String((o && o.body) || ''));
          const st = window.__approveStatus;
          return new Response(st === 200 ? '{"ok":true}' : JSON.stringify({ error: 'harness-forced-' + st }), { status: st, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/challenge')) {
          const pk = await crypto.subtle.importKey('spki', b2u(pubKey).buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
          const cc = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pk, enc.encode('TESTTOKEN'));
          return new Response(JSON.stringify({ challenge_ct: u2b(cc) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/ledger-backup')) return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return orig(u, o);
      };
    }, { pubKey: relayMeta.pubKey, specs, status });
    const metaOf = async key => ((await readDb(page)).meta.find(r => r.key === key) || {}).value;
    const openInbox = async () => {
      // 앞 단계에서 수신함 모달이 열린 채 남아 있을 수 있다(항목이 비어도 모달은 그대로다).
      if (await count(page, '.modal-back')) {
        await page.evaluate(() => { const b = document.querySelector('.modal-actions [data-a="close-modal"]'); if (b) b.click(); });
        await page.waitForTimeout(200);
      }
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'enroll-auto');
      await page.locator('[data-a="relay-inbox"]').first().click();
      await page.waitForSelector('.modal h2:has-text("공공기관 명단 신청 수신함")', { timeout: 8000 });
      await page.waitForTimeout(200);
    };

    // ── (a) 통보 실패(500): 거래는 1회, 항목은 남고, 상태 배지가 붙는다 ─────────────────────
    await installOutboxSpy([{ sid: 'sum-outbox', items: [{ name: '아웃박스직원', dept: '문화체육과', amount: 11000 }] }], 500);
    const txBeforeOutbox = (await readDb(page)).transactions.length;
    await openInbox();
    await page.locator('[data-a="relay-approve"][data-sid="sum-outbox"]').click();
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    const afterOutbox = await readDb(page);
    await assert(afterOutbox.transactions.length === txBeforeOutbox + 1, `a failed server notification must not cost (or duplicate) the ledger write (got ${afterOutbox.transactions.length - txBeforeOutbox})`);
    const approvedLog = await metaOf('approvedSummaryLog');
    const pendingLog = await metaOf('pendingNotify');
    await assert(Array.isArray(approvedLog) && approvedLog.some(r => r && r.sid === 'sum-outbox'), `the applied summary_id must be recorded (got ${JSON.stringify(approvedLog)})`);
    await assert(Array.isArray(pendingLog) && pendingLog.some(r => r && r.sid === 'sum-outbox'), `a failed notification must stay queued in meta.pendingNotify (got ${JSON.stringify(pendingLog)})`);
    const outboxModal = await page.locator('.modal').innerText();
    await assert(outboxModal.includes('장부에 반영됨 · 서버 알림 대기'), `the inbox row must say the roster is already in the ledger (got ${JSON.stringify(outboxModal)})`);
    await assert(await count(page, '[data-a="relay-approve"][data-sid="sum-outbox"]') === 0 && await count(page, '[data-a="relay-reject"][data-sid="sum-outbox"]') === 0,
      'an already-applied roster must not offer 승인/거절 again (that is the double-credit path)');
    await assert(await count(page, '[data-a="relay-notify"][data-sid="sum-outbox"]') === 1, 'an already-applied roster must offer [서버에 다시 알리기]');

    // ── (b) 같은 항목을 다시 눌러도(재알림) 거래는 늘지 않는다 ────────────────────────────
    const txBeforeRetry = (await readDb(page)).transactions.length;
    await page.locator('[data-a="relay-notify"][data-sid="sum-outbox"]').click();
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await assert((await readDb(page)).transactions.length === txBeforeRetry, 'retrying the notification must never touch the ledger again');
    const stillPending = await metaOf('pendingNotify');
    await assert(stillPending.some(r => r && r.sid === 'sum-outbox'), 'a notification that failed again must stay queued');
    await assert(await count(page, '[data-a="relay-notify"][data-sid="sum-outbox"]') === 1, 'the row stays until the server actually acknowledges');

    // ── (c) 재시작해도 대기열은 남는다 · 잠금(손님) 화면에서는 절대 통보하지 않는다 ─────────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    const afterRestartPending = await metaOf('pendingNotify');
    await assert(Array.isArray(afterRestartPending) && afterRestartPending.some(r => r && r.sid === 'sum-outbox'),
      `meta.pendingNotify must survive a restart (got ${JSON.stringify(afterRestartPending)})`);
    await installOutboxSpy([{ sid: 'sum-outbox', items: [{ name: '아웃박스직원', dept: '문화체육과', amount: 11000 }] }], 200);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(600);
    await assert((await page.evaluate(() => window.__notifyCalls.length)) === 0,
      'the customer (lock) screen must never run the ownership-proof notification — the private key is off limits there');
    await assert((await metaOf('pendingNotify')).some(r => r && r.sid === 'sum-outbox'), 'the queue must stay untouched while the app is locked');
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await page.waitForTimeout(700);
    await assert((await page.evaluate(() => window.__notifyCalls.length)) >= 1, 'unlocking must retry the queued notification right away');
    await assert(((await metaOf('pendingNotify')) || []).every(r => !r || r.sid !== 'sum-outbox'),
      `a successful retry must clear the queue (got ${JSON.stringify(await metaOf('pendingNotify'))})`);

    // ── (b') 서버가 같은 신청을 또 올려 보내도 승인 버튼은 돌아오지 않는다 ────────────────────
    await openInbox();
    await assert(await count(page, '[data-a="relay-approve"][data-sid="sum-outbox"]') === 0,
      'a roster already in the ledger must never regain an 승인 button, even when the server lists it as PENDING again');
    const txBeforeReNotify = (await readDb(page)).transactions.length;
    await page.locator('[data-a="relay-notify"][data-sid="sum-outbox"]').click();
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await assert((await readDb(page)).transactions.length === txBeforeReNotify, 're-notifying a listed-again roster must add zero transactions');

    // ── (d) 409(이미 처리됨)·404(없음)는 성공으로 본다 ───────────────────────────────────
    await installOutboxSpy([{ sid: 'sum-409', items: [{ name: '사구구직원', dept: '문화체육과', amount: 12000 }] }], 409);
    const txBefore409 = (await readDb(page)).transactions.length;
    await openInbox();
    await page.locator('[data-a="relay-approve"][data-sid="sum-409"]').click();
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    await assert((await readDb(page)).transactions.length === txBefore409 + 1, 'the 409 path must still write the ledger exactly once');
    await assert(((await metaOf('pendingNotify')) || []).every(r => !r || r.sid !== 'sum-409'),
      `409 (already processed) must count as a delivered notification (got ${JSON.stringify(await metaOf('pendingNotify'))})`);
    await assert(await count(page, '[data-a="relay-notify"][data-sid="sum-409"]') === 0 && await count(page, '[data-a="relay-approve"][data-sid="sum-409"]') === 0,
      'a 409-acknowledged roster must leave the inbox list');
    // ── 거절도 서버 응답을 보고 판단한다(beta.48) ────────────────────────────────────────
    //   예전에는 응답을 보지 않고 항목을 지웠다 — 서버가 못 받았는데 화면에서는 사라지니 사장님은
    //   처리됐다고 믿고, 그 신청은 다음 조회에서 PENDING으로 되살아난다.
    await installOutboxSpy([{ sid: 'sum-reject', items: [{ name: '거절직원', dept: '문화체육과', amount: 5000 }] }], 500);
    const txBeforeReject = (await readDb(page)).transactions.length;
    await openInbox();
    await page.locator('[data-a="relay-reject"][data-sid="sum-reject"]').click();
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await assert(await count(page, '[data-a="relay-reject"][data-sid="sum-reject"]') === 1, 'a rejection the server did not accept must keep the row in the inbox');
    await assert((await readDb(page)).transactions.length === txBeforeReject, 'a rejection must never touch the ledger');
    await page.evaluate(() => { window.__approveStatus = 200; });
    await page.locator('[data-a="relay-reject"][data-sid="sum-reject"]').click();
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await assert(await count(page, '[data-a="relay-reject"][data-sid="sum-reject"]') === 0, 'an acknowledged rejection removes the row');

    if (await count(page, '.modal-actions [data-a="close-modal"]')) await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(150);

    // ── beta.48: [저장] 연타(한 틱 안에 두 번)여도 거래는 **1건**이어야 한다 ────────────────
    //   폰에서 오탭은 흔하다. 예전에는 두 번째 탭이 첫 저장이 끝나기 전에 같은 잔액을 읽어 같은 금액을
    //   한 번 더 충전·차감했다(사장님은 나중에 늘어난 한 줄을 발견한다). withTxLock이 구조적으로 막는다.
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'employees');
    const outboxEmpId = (await readDb(page)).employees.find(e => e.name === '아웃박스직원').id;
    await page.locator('[data-a="toggle-dept"][data-dept="강남구청 문화체육과"]').click();
    await expandEmpRow(page, outboxEmpId);// beta.53: 직원 행은 한 줄로 시작 — 펼쳐야 [충전]이 보인다
    await page.waitForSelector(`[data-a="topup"][data-id="${outboxEmpId}"]`);
    await page.locator(`[data-a="topup"][data-id="${outboxEmpId}"]`).click();
    await page.waitForSelector('#topupAmount');
    await page.locator('#topupAmount').fill('5000');
    const beforeDoubleTap = (await readDb(page)).transactions.length;
    const doubleTapHook = await page.evaluate(async () => {
      const H = window.__prepaidTestHooks;
      if (!H || typeof H.saveTopup !== 'function') return false;
      await Promise.all([H.saveTopup(), H.saveTopup()]);
      return true;
    });
    await assert(doubleTapHook, 'the e2e hook for saveTopup must be exposed on localhost (double-tap contract)');
    await page.waitForTimeout(500);
    const afterDoubleTap = (await readDb(page)).transactions.length;
    await assert(afterDoubleTap === beforeDoubleTap + 1,
      `a double-tapped [충전 저장] must record exactly one transaction (got ${afterDoubleTap - beforeDoubleTap})`);
    await assert(await count(page, '#topupAmount') === 0, 'the topup modal must close after the (single) save');

    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    // 위 (c)에서 앱을 재시작했으므로 홈 그룹 펼침 상태(메모리 전용)가 초기화됐다 — 다시 펼쳐 둔다.
    await expandHomeGroups(page);

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
    await assert(prodTimers.custComposeIdle === 60000, `TIMERS.custComposeIdle must stay 60000 in production (got ${prodTimers.custComposeIdle})`);
    await assert(prodTimers.autoLock === 90000, `TIMERS.autoLock must stay 90000 in production (got ${prodTimers.autoLock})`);
    await assert(prodTimers.pendingTtl === 120000, `TIMERS.pendingTtl must stay 120000 in production (got ${prodTimers.pendingTtl})`);
    await assert(prodTimers.pinDelay === 60000, `TIMERS.pinDelay must stay 60000 in production (got ${prodTimers.pinDelay})`);
    await assert(prodTimers.recoveryGate === 60000, `TIMERS.recoveryGate must stay 60000 in production (got ${prodTimers.recoveryGate})`);
    await assert(prodTimers.modalIdleCap === 600000, `TIMERS.modalIdleCap must stay 600000 in production (got ${prodTimers.modalIdleCap})`);
    await assert(prodTimers.ownerPinIdle === 120000, `TIMERS.ownerPinIdle must stay 120000 in production (got ${prodTimers.ownerPinIdle})`);
    // beta.55(C8·C3): "사장님 확인" 화면 60초(예전 custIdle 30초), 진입 직후 숫자판 무시 0.5초
    await assert(prodTimers.handoffPinIdle === 60000, `TIMERS.handoffPinIdle must stay 60000 in production (got ${prodTimers.handoffPinIdle})`);
    await assert(prodTimers.pinKeyGuard === 500, `TIMERS.pinKeyGuard must stay 500 in production (got ${prodTimers.pinKeyGuard})`);
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    for (let i = 0; i < 5; i += 1) await typePin(page, ['9', '9', '9', '9']);
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
    // 지연 중에도 [비밀번호를 잊으셨나요?] 복구 화면은 열린다 — 초기화(③ 전부 지우고 새로 시작)는 오직 이 안에서, 그것도 60초 뒤에만.
    // beta.60: 백업 암호로 가는 ①②는 화면잠금과 **같은 지연**에 묶인다(백업 암호 오답도 같은 횟수로 센다) — 지연 중에는 남은 초만 보인다.
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 700 }));
    await page.locator('[data-a="pin-forgot"]').click();
    await page.waitForSelector('.pin-recovery [data-a="pin-reset"]');
    await assert(await count(page, '[data-a="pin-reset"]') === 1, 'app reset must live inside the PIN-recovery screen only');
    await assert(await count(page, '[data-a="pin-recover-pass"]') === 0 && await count(page, '[data-a="pin-forgot-restore"]') === 0 && (await page.locator('.rec-delay').innerText()).includes('5번'),
      'beta.60: during the PIN input delay the backup-password routes (①②) must wait too and say how long');
    // 게이트가 도는 동안 파괴 버튼은 비활성 + 사유가 화면에 보여야 한다.
    await assert(await page.locator('[data-a="pin-reset"]').isDisabled(), 'the recovery [전부 지우고 새로 시작] button must be disabled while the 60s gate is running');
    const gateText = await page.locator('.pin-screen .rec-gate').innerText();
    await assert(gateText.includes('잘못 누름 방지') && /\d+초/.test(gateText), `the recovery gate must explain itself (got ${JSON.stringify(gateText)})`);
    // 비활성·숨은 버튼에 합성 클릭을 쏘아도 핸들러 자체가 막아야 한다(disabled·화면 구성에만 기대지 않는다).
    const dialogsBeforeGateProbe = dialogs.length;
    const gateProbeBefore = await readDb(page);
    await page.evaluate(() => {
      ['pin-reset', 'pin-forgot-restore', 'pin-recover-pass'].forEach(a => {
        let el = document.querySelector(`[data-a="${a}"]`);
        if (!el) { el = document.createElement('button'); el.dataset.a = a; document.body.appendChild(el); }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    });
    await page.waitForTimeout(400);
    await assert(dialogs.length === dialogsBeforeGateProbe, 'no confirm dialog may open from the recovery screen before the gate elapses');
    await assert(await count(page, '#keyPass1') === 0 && (await page.evaluate(() => window.__prepaidTestHooks.lockState())).allowLockedRestore === false, 'beta.60: ①② fired during the delay must not open the password box or grant a locked restore');
    const gateProbeAfter = await readDb(page);
    await assert(JSON.stringify(gateProbeAfter.employees) === JSON.stringify(gateProbeBefore.employees), 'the gated recovery buttons must not touch the ledger before the gate elapses');
    // 게이트 경과 → 그때서야 활성화된다.
    await page.waitForTimeout(1000);
    await assert(!(await page.locator('[data-a="pin-reset"]').isDisabled()), 'the recovery buttons must become enabled once the gate elapses');

    // ── beta.48(F1): 미인증 초기화의 최종 백업은 **잠긴 파일**이어야 한다 ─────────────────────
    //   이 화면은 비밀번호를 모르는 사람도 누를 수 있다(그래야 잠긴 기기를 되살린다). 그런데 여태
    //   그 경로가 직원 이름·금액이 평문으로 든 백업을 폰 다운로드 폴더에 떨궜다 — 가게에 놓인 태블릿을
    //   잠깐 만진 사람이 [초기화]만 눌러 장부를 통째로 가져갈 수 있었다.
    const lockedDl = [];
    const onLockedDl = d => lockedDl.push(d);
    page.on('download', onLockedDl);
    const beforeLockedWipe = await readDb(page);
    const lastBackupBefore = (beforeLockedWipe.meta.find(r => r.key === 'lastBackupAt') || {}).value;
    const dialogsBeforeLockedBackup = dialogs.length;
    confirmDecider = msg => !msg.includes('정말 지울까요');   // 1차 [확인] → 파일 저장, 2차(마지막 관문) [취소]
    await page.locator('[data-a="pin-reset"]').click();
    for (let i = 0; i < 40 && lockedDl.length < 1; i += 1) await page.waitForTimeout(100);
    await page.waitForTimeout(400);
    confirmDecider = null;
    page.off('download', onLockedDl);
    await assert(lockedDl.length === 1, `the un-authenticated reset must still save exactly one final backup file (got ${lockedDl.length})`);
    const lockedName = lockedDl[0].suggestedFilename();
    await assert(/^밥장부_잠긴백업_\d{4}-\d{2}-\d{2}\.json$/.test(lockedName), `the PIN-recovery final backup must be a locked file (got ${lockedName})`);
    const lockedRaw = await fsp.readFile(await lockedDl[0].path(), 'utf8');
    const lockedJson = JSON.parse(lockedRaw);
    await assert(lockedJson.type === 'prepaid-locked-backup' && lockedJson.v === 1, `the locked backup must declare its own type (got ${JSON.stringify(lockedJson.type)})`);
    await assert(Boolean(lockedJson.blob && lockedJson.blob.encKey && lockedJson.blob.iv && lockedJson.blob.ct), 'the locked backup must carry the hybrid-encrypted blob');
    await assert(!lockedRaw.includes('"employees"') && !lockedRaw.includes('"transactions"'), 'the locked backup must not carry the plain ledger structure');
    const lockedNames = [...new Set(beforeLockedWipe.employees.map(e => e.name).filter(Boolean))];
    await assert(lockedNames.length > 0 && lockedNames.every(n => !lockedRaw.includes(n)),
      `no employee name may appear in the locked backup (checked ${lockedNames.length} names)`);
    const afterLockedTry = await readDb(page);
    await assert(String((afterLockedTry.meta.find(r => r.key === 'lastBackupAt') || {}).value) === String(lastBackupBefore),
      'the locked final backup must not stamp meta.lastBackupAt — it is not a backup the owner chose to make');
    await assert(JSON.stringify(afterLockedTry.employees) === JSON.stringify(beforeLockedWipe.employees)
      && JSON.stringify(afterLockedTry.transactions) === JSON.stringify(beforeLockedWipe.transactions),
      'cancelling the second confirm must leave the ledger untouched');
    const lockedConfirms = dialogs.slice(dialogsBeforeLockedBackup).filter(d => d.type === 'confirm');
    // beta.55(A-5): 다운로드는 '시작'만 확인된다 — "저장했습니다"라고 단정하지 않고 파일이 보이는지 묻는다.
    // beta.60(앱 2번): 잠긴 파일은 지우면 함께 사라지는 이 기기 열쇠로 잠겨 있다 — "나중에 되살릴 수 있어요"라고 하지 않고 무엇이 있어야 열리는지 말한다.
    //   첫 확인도 사실대로: "PIN만 따로 초기화할 수는 없어요(보안)"(그 옆 버튼으로 됐다) 대신 백업 암호 길(①)을 가리킨다.
    await assert(lockedConfirms.length === 2 && !lockedConfirms[0].message.includes('PIN만 따로') && lockedConfirms[0].message.includes('백업 암호를 알면')
      && lockedConfirms[1].message.includes('없으면 되살릴 수 없어요') && !lockedConfirms[1].message.includes('나중에 되살릴 수 있어요'),
      `beta.60: the reset confirms must be honest about the locked file (got ${JSON.stringify(lockedConfirms.map(d => d.message.slice(0, 120)))})`);
    await assert(lockedConfirms.length === 2 && lockedConfirms[1].message.includes('잠긴 백업 파일 다운로드가 시작됐어요') && lockedConfirms[1].message.includes('파일이 보이나요') && !lockedConfirms[1].message.includes('저장했습니다'),
      `the second confirm must say the saved file is locked (got ${JSON.stringify(lockedConfirms.map(d => d.message.slice(0, 60)))})`);

    // ── beta.60(결정 1-가): 예전에는 여기서 [① 백업 파일로 복구]로 방금 받은 잠긴 파일을 열어 새 비밀번호를 정했다 —
    //   비밀번호도 백업 암호도 모르는 사람이 장부를 그대로 여는 "세 번째 길"이었다(이 하니스가 그것을 성공으로 단언했다). 이제 막혀야 한다.
    await page.locator('#restoreFile').setInputFiles({ name: lockedName, mimeType: 'application/json', buffer: Buffer.from(lockedRaw, 'utf8') });
    await page.waitForTimeout(800);
    {
      const afterBlocked = await readDb(page);
      await assert(await count(page, '#choiceTitle') === 0 && (await page.evaluate(() => window.__prepaidTestHooks.lockState())).locked === true
        && JSON.stringify(afterBlocked.transactions) === JSON.stringify(beforeLockedWipe.transactions) && afterBlocked.meta.some(r => r.key === 'pinHash' && r.value),
        'beta.60: the cancelled reset\'s locked file must NOT open from the recovery screen without the backup password (old PIN kept, still locked)');
    }
    // 사장님(백업 암호를 아는 사람)에게는 막다른 길이 아니다 — 지연이 끝나면(여기서는 meta를 지워 앞당긴다) ②에서 백업 암호를 넣고
    //   [백업 파일 고르기]로 같은 파일을 연다. 개인키가 살아 있는 이 기기에서 그 파일은 그대로 열린다.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { const t = req.result.transaction(['meta'], 'readwrite'); t.objectStore('meta').put({ key: 'pinFails', value: 0 }); t.objectStore('meta').put({ key: 'pinDelayUntil', value: 0 }); t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error); };
    }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 700 }));
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.locator('[data-a="pin-forgot"]').click();
    await page.waitForSelector('[data-a="pin-forgot-restore"]');
    {
      const chooser = await recoveryFileChooser(page, MAIN_PASS);
      await chooser.setFiles({ name: lockedName, mimeType: 'application/json', buffer: Buffer.from(lockedRaw, 'utf8') });
    }
    await confirmInAppRestore(page);
    await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    const restoredLocked = await readDb(page);
    await assert(restoredLocked.employees.length === beforeLockedWipe.employees.length && restoredLocked.employees.length > 0,
      `restoring the locked backup on the same device must bring the ledger back (got ${restoredLocked.employees.length}/${beforeLockedWipe.employees.length})`);
    await assert(restoredLocked.transactions.length === beforeLockedWipe.transactions.length,
      'the restored locked backup must carry every transaction');
    // 복구 경로의 복원이므로 새 비밀번호를 설정하는 화면으로 간다 — 다시 잠그고 복구 화면으로 돌아와 초기화 검증을 잇는다.
    await page.waitForSelector('[data-a="pin-key"]', { timeout: 8000 });
    await typePin(page, ['1', '2', '3', '4']);
    await typePin(page, ['1', '2', '3', '4']);
    await page.waitForSelector('[data-a="quick-find-emp"]', { timeout: 8000 });
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('[data-a="lock-to-pin"]');
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-forgot"]');
    await page.locator('[data-a="pin-forgot"]').click();
    await page.waitForSelector('[data-a="pin-reset"]');
    await page.waitForTimeout(1000);
    await assert(!(await page.locator('[data-a="pin-reset"]').isDisabled()), 'the recovery gate must elapse again after re-locking');
    const dialogsBeforeReset = dialogs.length;
    await page.locator('[data-a="pin-reset"]').click();
    await page.waitForTimeout(500);
    const resetDialogs = dialogs.slice(dialogsBeforeReset);
    const resetConfirms = resetDialogs.filter(d => d.type === 'confirm');
    await assert(resetConfirms.length === 2, `reset from lock screen should use exactly two confirm() dialogs, got ${resetConfirms.length}`);
    await assert(!resetDialogs.some(d => d.type === 'prompt'), 'reset from lock screen must not require a typed-text prompt');
    await assert(await count(page, '#setupStoreName') === 1, 'app should return to setup (1/3 store search) after lock-screen reset');
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
      await resealChain(page);
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
      await openSettingsCard(page, 'employees');// beta.29: 직원 목록 카드도 접힌다
      await page.waitForTimeout(200);
      for (let guard = 0; guard < 12; guard += 1) {
        // beta.53: 행은 한 줄(.emp-mgr)로 시작한다 — 이름이 맞는 한 줄을 펼친 뒤 [수정]을 누른다.
        const line = page.locator('.emp-mgr', { hasText: name }).locator('[data-a="toggle-emp"]');
        if (await line.count()) {
          if ((await line.first().getAttribute('aria-expanded')) !== 'true') { await line.first().click(); await page.waitForTimeout(120); }
          const btn = page.locator('.emp-mgr', { hasText: name }).locator('[data-a="edit-employee"]');
          if (await btn.count()) { await btn.first().click(); await page.waitForSelector('#empOrg'); return; }
        }
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
    await openSettingsCard(page, 'employees');// beta.29: 직원 목록 카드도 접힌다
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
    // beta.60: 홈에 설치 안내 배너가 더해져(폰 크롬 프로필) 그룹 머리가 화면 아래쪽에 놓이면 focus()만으로 화면이 조금 내려간다.
    //   이 단언의 뜻은 "Space가 화면을 밀지 않는다"이므로, 누르기 전 위치와 비교한다(예전에는 0과 비교해 focus 스크롤까지 실패로 읽었다).
    const yBeforeSpace = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    await assert(await count(page, '.card.employee') === 0, 'Space on a focused group header must collapse it again');
    await assert(await page.evaluate(y0 => window.scrollY <= y0, yBeforeSpace), 'Space must not scroll the page when it activates a group header');

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
    // (6-b) beta.53 현장 보고: 개인 손님 20명(소속 '개인' 한 그룹)을 수동 등록하자 설정 > 직원 목록 관리가 끝없이 길어지고,
    //       홈도 그룹이 하나라서 20명이 늘 펼쳐진 채 접을 수조차 없었다.
    //   ① 설정 직원 행은 기본 한 줄(이름·잔액·[관리 ▸]) — 펼친 직원만 전화·수정·충전·조정·숨김이 생긴다.
    //   ② 홈 그룹이 하나여도 인원이 HOME_SINGLE_GROUP_AUTO_OPEN_MAX(8) 초과면 접힌 채 시작하고 탭으로 열고 닫는다.
    // ───────────────────────────────────────────────────────────────
    {
      const solo20 = Array.from({ length: 20 }, (_, i) => ({ id: `p-${String(i + 1).padStart(2, '0')}`, org: '개인', orgKind: '', dept: '', name: `개인손님${String(i + 1).padStart(2, '0')}`, amount: 10000 + i * 1000 }));
      await seedHome(solo20);
      // ② 홈: 그룹 1개 · 20명 → 접힘, data-forced 없음, 탭 → 열림, 다시 탭 → 닫힘
      await assert(await count(page, '.group-head') === 1, `20 개인 손님 must form exactly one home group (got ${await count(page, '.group-head')})`);
      await assert(await count(page, '.card.employee') === 0, 'beta.53: a single home group with 20 members must start collapsed (it used to be force-opened)');
      await assert((await page.locator('.group-head').getAttribute('aria-expanded')) === 'false', 'a collapsed single big group must report aria-expanded=false');
      await assert((await page.locator('.group-head').getAttribute('data-forced')) === null, 'a single group with 9+ members must not be data-forced (otherwise it can never be collapsed)');
      await assert((await page.locator('.group-head').innerText()).includes('직원 20명'), 'the collapsed header must still show the member count');
      await page.locator('.group-head').click();
      await page.waitForTimeout(150);
      await assert(await count(page, '.card.employee') === 20 && (await page.locator('.group-head').getAttribute('aria-expanded')) === 'true', 'tapping the single big group must open all 20 members');
      await page.locator('.group-head').click();
      await page.waitForTimeout(150);
      await assert(await count(page, '.card.employee') === 0, 'tapping it again must collapse it (a single big group is a normal toggleable group)');
      // 검색의 강제 펼침은 그대로 — 여러 명이 걸리면 펼쳐져 있고 탭으로 접히지 않는다
      await page.locator('#searchInput').fill('개인손님1');
      await page.waitForTimeout(200);
      await assert(await count(page, '.card.employee') === 10 && (await page.locator('.group-head').getAttribute('data-forced')) === '1', `a search must still force the matching group open (got ${await count(page, '.card.employee')} cards)`);
      await page.locator('#searchInput').fill('');
      await page.waitForTimeout(200);
      await assert(await count(page, '.card.employee') === 0, 'clearing the search must return the big single group to collapsed');

      // ① 설정: 그룹을 펼치면 20개의 한 줄 행만 — 전화 칸·버튼은 아직 없다
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'employees');
      await page.locator('.mgr-head', { hasText: '개인' }).first().click();
      await page.waitForTimeout(150);
      const compact = await page.evaluate(() => ({
        rows: document.querySelectorAll('.mgr-body .emp-mgr').length,
        toggles: document.querySelectorAll('.mgr-body [data-a="toggle-emp"]').length,
        phone: document.querySelectorAll('.mgr-body .phone-row').length,
        acts: ['edit-employee', 'topup', 'adjust', 'delete-emp'].map(a => document.querySelectorAll(`.mgr-body [data-a="${a}"]`).length),
        first: (document.querySelector('.mgr-body .emp-mgr') || { innerText: '' }).innerText.replace(/\s+/g, ' ').trim()
      }));
      await assert(compact.rows === 20 && compact.toggles === 20, `the expanded 개인 group must list 20 compact rows (got ${JSON.stringify(compact)})`);
      await assert(compact.phone === 0 && compact.acts.every(n => n === 0), `compact rows must not show phone controls or the 4 buttons until toggled (got ${JSON.stringify(compact)})`);
      await assert(compact.first.includes('개인손님01') && compact.first.includes('10,000원') && compact.first.includes('관리'), `a compact row must read name · balance · [관리 ▸] (got "${compact.first}")`);
      // 한 명만 펼친다 — 다른 19명은 한 줄 그대로
      await page.locator('[data-a="toggle-emp"][data-id="p-05"]').click();
      await page.waitForTimeout(150);
      const one = await page.evaluate(() => ({
        open: [...document.querySelectorAll('.emp-mgr.open [data-a="toggle-emp"]')].map(b => b.dataset.id),
        phone: document.querySelectorAll('.mgr-body .phone-row').length,
        topupIds: [...document.querySelectorAll('.mgr-body [data-a="topup"]')].map(b => b.dataset.id),
        label: (document.querySelector('[data-a="toggle-emp"][data-id="p-05"]') || { innerText: '' }).innerText,
        aria: (document.querySelector('[data-a="toggle-emp"][data-id="p-05"]') || { getAttribute: () => '' }).getAttribute('aria-expanded'),
        detail: (document.querySelector('.emp-mgr.open .emp-detail') || { innerText: '' }).innerText
      }));
      await assert(one.open.join(',') === 'p-05' && one.phone === 1 && one.topupIds.join(',') === 'p-05', `toggling one row must expand only that employee (got ${JSON.stringify(one)})`);
      await assert(one.aria === 'true' && one.label.includes('접기'), `an expanded row must say [접기 ▾] and report aria-expanded=true (got ${JSON.stringify(one)})`);
      await assert(one.detail.includes('개인') && one.detail.includes('현재 잔액 14,000원') && one.detail.includes('번호 등록'), `the expanded detail must keep the existing 소속·잔액·전화 content (got "${one.detail.replace(/\n/g, ' ')}")`);
      // 펼친 행 안의 버튼은 같은 data-a 그대로 동작한다 — 충전 모달
      await page.locator('[data-a="topup"][data-id="p-05"]').click();
      await page.waitForSelector('#topupAmount', { timeout: 5000 });
      await page.locator('.modal-actions [data-a="close-modal"]').click();
      await page.waitForTimeout(150);
      await assert(await count(page, '.emp-mgr.open') === 1, 'closing the topup modal must keep the expanded row expanded');
      // 펼침은 세션 UI 상태일 뿐 — 기기에 저장되지 않는다
      const metaKeys = (await readDb(page)).meta.map(r => r.key);
      await assert(!metaKeys.some(k => /expanded/i.test(k)), `row expansion must never be persisted (meta keys ${JSON.stringify(metaKeys)})`);
      // beta.54(현장 요청 "삭제 버튼이 없다"): [숨김](이름 입력 기본 팝업) → [삭제](앱 안 확인창). 잔액이 남은 직원은 0원 정리 조정이
      //   함께 남고(무결성 합계와 화면 합계가 어긋나지 않게), 돈 기록이 있으면 [기록까지 완전 삭제]는 보이지 않는다. "삭제한 직원" 그룹에서 [복원]된다.
      await page.locator('[data-a="toggle-emp"][data-id="p-20"]').click();
      await page.waitForTimeout(120);
      const promptsBefore = dialogs.filter(d => d.type === 'prompt').length;
      await page.locator('[data-a="delete-emp"][data-id="p-20"]').click();
      await page.waitForSelector('[data-a="delete-emp-soft"][data-id="p-20"]', { timeout: 5000 });
      const delModal = (await page.locator('.modal').innerText()).replace(/\s+/g, ' ');
      await assert(delModal.includes('개인손님20') && delModal.includes('29,000원') && delModal.includes('잔액 0원으로 정리하고 삭제'), `the delete dialog must show name, balance and the soft-delete button (got "${delModal.slice(0, 200)}")`);
      await assert(await count(page, '[data-a="delete-emp-hard"]') === 0 && delModal.includes('기록까지 지울 수는 없어요'), 'an employee with money records must not be offered a hard delete, and the dialog must say why');
      await page.locator('[data-a="delete-emp-soft"][data-id="p-20"]').click();
      await page.waitForTimeout(350);
      await assert(dialogs.filter(d => d.type === 'prompt').length === promptsBefore, 'deleting must not use the old name-typing prompt');
      {
        const db = await readDb(page);
        const p20 = db.employees.find(e => e.id === 'p-20');
        const adj = db.transactions.filter(t => t.employeeId === 'p-20' && t.type === 'adjust');
        await assert(p20.isDeleted === true, 'the [삭제] confirm must soft-delete the employee');
        await assert(adj.length === 1 && Number(adj[0].amount) === -29000 && Number(adj[0].afterBalance) === 0 && adj[0].reason === '삭제 시 잔액 정리', `soft delete must zero the balance with one adjust record (got ${JSON.stringify(adj.map(t => [t.amount, t.afterBalance, t.reason]))})`);
      }
      await assert(await count(page, '.mgr-head:has-text("삭제한 직원")') === 1, 'a deleted employee must move to the "삭제한 직원" group');
      await page.locator('.mgr-head', { hasText: '삭제한 직원' }).click();
      await page.waitForTimeout(150);
      const hid = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.emp-mgr')].find(r => r.querySelector('[data-a="toggle-emp"][data-id="p-20"]'));
        return row ? { text: row.querySelector('.emp-line-wrap').innerText.replace(/\s+/g, ' '), restore: row.querySelectorAll('.emp-line-wrap [data-a="restore-emp"]').length, open: row.classList.contains('open') } : null;
      });
      // 숨김 직원도 펼침 상태(p-20을 펼쳐 둔 채 숨겼다)를 이어받을 수 있다 — 어느 쪽이든 [복원]은 한 줄 줄에 있어야 한다.
      await assert(Boolean(hid) && hid.restore === 1 && hid.text.includes('삭제됨'), `a deleted employee's compact row must carry the 삭제됨 badge and a visible [복원] (got ${JSON.stringify(hid)})`);
      await assert(await count(page, '[data-a="restore-emp"][data-id="p-20"]') === 1, '[복원] must not be duplicated inside the expanded detail');
      await page.locator('[data-a="restore-emp"][data-id="p-20"]').click();
      await page.waitForTimeout(250);
      await assert((await readDb(page)).employees.find(e => e.id === 'p-20').isDeleted === false, '[복원] on the compact row must restore the employee');
      await assert(balanceOfId(await readDb(page), 'p-20') === 0, 'restoring keeps the zeroed balance — the owner tops up again if money is really there (the adjust record is the audit trail)');
      // 다시 접기
      await page.locator('[data-a="toggle-emp"][data-id="p-05"]').click();
      await page.waitForTimeout(120);
      await assert(await count(page, '.mgr-body [data-a="topup"][data-id="p-05"]') === 0, 'tapping [접기 ▾] must collapse the row again');
      // 새로고침(세션 종료) 뒤에는 전부 한 줄로 돌아온다
      await page.locator('[data-a="toggle-emp"][data-id="p-03"]').click();
      await page.waitForTimeout(120);
      await page.reload({ waitUntil: 'load' });
      await unlock();
      await page.waitForSelector('[data-a="quick-find-emp"]');
      await page.locator('[data-a="screen"][data-screen="settings"]').click();
      await openSettingsCard(page, 'employees');
      if (!(await count(page, '.mgr-body'))) await page.locator('.mgr-head', { hasText: '개인' }).first().click();
      await page.waitForTimeout(150);
      await assert(await count(page, '.emp-mgr.open') === 0, 'row expansion is session-only — a reload must bring every row back to one line');

      // ── beta.54: 거래 기록이 없는 직원만 [기록까지 완전 삭제]가 보이고, 누르면 레코드 자체가 사라진다 ──
      const putEmp = (e) => page.evaluate((e) => new Promise((res, rej) => {
        const r = indexedDB.open('prepaid-ledger-db');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => { const tx = r.result.transaction('employees', 'readwrite'); tx.objectStore('employees').put(Object.assign({ note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: Date.now(), updatedAt: Date.now(), orgKind: '' }, e)); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); };
      }), e);
      const reopenEmployees = async () => {
        await page.reload({ waitUntil: 'load' });
        await unlock();
        await page.waitForSelector('[data-a="quick-find-emp"]');
        await page.locator('[data-a="screen"][data-screen="settings"]').click();
        await openSettingsCard(page, 'employees');
        await page.waitForTimeout(150);
      };
      await putEmp({ id: 'p-zero', org: '개인', dept: '', name: '빈카드' });
      await reopenEmployees();
      await page.locator('.mgr-head', { hasText: '개인' }).first().click();
      await page.waitForTimeout(150);
      await page.locator('[data-a="toggle-emp"][data-id="p-zero"]').click();
      await page.waitForTimeout(120);
      await page.locator('[data-a="delete-emp"][data-id="p-zero"]').click();
      await page.waitForSelector('[data-a="delete-emp-hard"][data-id="p-zero"]', { timeout: 5000 });
      await assert(await count(page, '[data-a="delete-emp-soft"][data-id="p-zero"]') === 1, 'a record-less employee must be offered both the restorable delete and the hard delete');
      await page.locator('[data-a="delete-emp-hard"][data-id="p-zero"]').click();
      await page.waitForTimeout(350);
      await assert(!(await readDb(page)).employees.some(e => e.id === 'p-zero'), 'hard delete must remove a record-less employee from the database');
      await assert(await count(page, '[data-a="toggle-emp"][data-id="p-zero"]') === 0, 'a hard-deleted employee must vanish from the list without a reload');

      // ── beta.54: 부서 머리글의 [이름 고치기] — 그 그룹 직원 전체의 소속·부서 글자만 바뀐다(잔액·거래 불변). 삭제한 직원은 건드리지 않는다. ──
      await page.locator('[data-a="toggle-emp"][data-id="p-19"]').click(); // 삭제될 p-19: 잔액 28,000 → 정리 삭제
      await page.waitForTimeout(120);
      await page.locator('[data-a="delete-emp"][data-id="p-19"]').click();
      await page.waitForSelector('[data-a="delete-emp-soft"][data-id="p-19"]', { timeout: 5000 });
      await page.locator('[data-a="delete-emp-soft"][data-id="p-19"]').click();
      await page.waitForTimeout(350);
      const txBeforeRename = (await readDb(page)).transactions.length;
      await page.locator('[data-a="rename-group"][data-dept="개인"]').click();
      await page.waitForSelector('#renameOrg', { timeout: 5000 });
      await page.locator('#renameOrg').fill('개인손님');
      await page.locator('#renameDept').fill('단골');
      await page.locator('[data-a="save-rename-group"]').click();
      await page.waitForTimeout(400);
      {
        const db = await readDb(page);
        const active = db.employees.filter(e => !e.isDeleted);
        await assert(active.length === 19 && active.every(e => e.org === '개인손님' && e.dept === '단골'), `renaming a group must relabel every active member (got ${JSON.stringify(active.slice(0, 2).map(e => [e.org, e.dept]))})`);
        await assert(db.employees.find(e => e.id === 'p-19').org === '개인', 'renaming must not touch deleted employees');
        await assert(db.transactions.length === txBeforeRename, 'renaming must not add or change any transaction');
      }
      await assert(await count(page, '.mgr-head:has-text("개인손님 단골")') === 1 && await count(page, '[data-a="rename-group"][data-dept="개인"]') === 0, 'the renamed group must appear under its new label');
      // 고친 이름의 부서에 같은 이름이 있으면 멈춘다 — 어느 쪽이 충전되는지 알 수 없어지기 때문(먼저 한쪽을 삭제).
      await putEmp({ id: 'c-1', org: '개인손님', dept: 'VIP', name: '개인손님01' });
      await reopenEmployees();
      await page.locator('[data-a="rename-group"][data-dept="개인손님 VIP"]').click();
      await page.waitForSelector('#renameOrg', { timeout: 5000 });
      await page.locator('#renameDept').fill('단골');
      const alertsBeforeClash = dialogs.filter(d => d.type === 'alert').length;
      await page.locator('[data-a="save-rename-group"]').click();
      await page.waitForTimeout(300);
      const clashAlert = dialogs.filter(d => d.type === 'alert').slice(alertsBeforeClash);
      await assert(clashAlert.length === 1 && clashAlert[0].message.includes('같은 이름이 이미 있어요') && clashAlert[0].message.includes('개인손님01'), `renaming into a group that already has the same name must stop and say who clashes (got ${JSON.stringify(clashAlert)})`);
      await assert((await readDb(page)).employees.find(e => e.id === 'c-1').dept === 'VIP', 'a clashing rename must change nothing');
      await page.locator('.modal-actions [data-a="close-modal"]').click();
      await page.waitForTimeout(150);

      // 홈: 8명이면 예전처럼 자동 펼침(data-forced), 9명이면 접힘
      await seedHome(solo20.slice(0, 8));
      await assert(await count(page, '.card.employee') === 8 && (await page.locator('.group-head').getAttribute('data-forced')) === '1', `a single group of 8 must still auto-open (got ${await count(page, '.card.employee')} cards)`);
      await seedHome(solo20.slice(0, 9));
      await assert(await count(page, '.card.employee') === 0 && (await page.locator('.group-head').getAttribute('data-forced')) === null, 'a single group of 9 must start collapsed and be toggleable');
    }

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
    await resealChain(page);
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

    // (7-e) 사용 모달(beta.44) — 빠른 금액 3버튼은 **없다**. 금액은 사장님이 직접 친다.
    //   지운 이유: 이 모달은 손님이 보낸 금액·서명을 읽고 저장하는 자리다. 한 번 누르면 금액을 덮어쓰는
    //   버튼이 저장 버튼 곁에 있으면 오탭 한 번이 "손님이 서명한 금액과 다른 숫자"를 만든다.
    await page.locator('#searchInput').fill('박보검');
    await page.waitForTimeout(200);
    await page.locator('#deptFilterSelect').selectOption({ label: '가나상사' });
    await page.waitForTimeout(200);
    const keptFilter = await page.locator('#deptFilterSelect').inputValue();
    await assert(await count(page, '.card.employee.solo') === 1, 'the filtered + searched single hit should still be the solo card');
    await page.locator('.card.employee.solo [data-a="use"]').click();
    await page.waitForSelector('#useAmount');
    await assert(await count(page, '[data-a="fill-use"]') === 0, 'the usage modal must not offer quick-amount buttons any more (beta.44)');
    await assert(!(await page.locator('.modal').innerText()).includes('빠른 금액'), 'the 빠른 금액 label must be gone from the usage modal too (beta.44)');
    // 저장 버튼의 말은 [저장] 하나다 — "서명 후 저장"은 서명이 이미 있는 흔한 경우에 거짓말이 된다.
    const useSaveLabel = (await page.locator('[data-a="save-use"]').innerText()).trim();
    await assert(useSaveLabel === '저장', `the usage modal save button must read 저장 (got ${JSON.stringify(useSaveLabel)})`);
    await page.locator('#useAmount').fill('9000');
    await assert((await page.locator('#useAmount').inputValue()) === '9000', 'the usage amount must be hand-editable');

    // (7-f) 저장이 끝나면 검색어는 비워지고(다음 손님) 소속 필터는 그대로 남는다.
    const sBox = await page.locator('#signCanvas').boundingBox();
    await page.mouse.move(sBox.x + 30, sBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(sBox.x + 120, sBox.y + 45, { steps: 5 });
    await page.mouse.move(sBox.x + 220, sBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await page.locator('[data-a="save-use"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 5000 });
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
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
      { id: 'cx-5', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '이순신', amount: 10000 },
      // beta.22 접두 검색 회귀용 한 쌍 — '영'으로 시작하는 사람과, '영'이 **끝에** 들어간 사람.
      //   부분 일치로 되돌아가면 손님이 '영' 한 글자를 쳤을 때 이 둘이 함께 뜬다(남의 이름이 섞인 목록).
      { id: 'cx-6', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '영업맨', amount: 15000 },
      { id: 'cx-7', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '홍룬영', amount: 16000 }
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
    await resealChain(page);
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
    await assert(noneText.includes("'없는사람'(으)로 시작하는 이름이 없어요."), `the empty-result notice must echo the typed name (got ${JSON.stringify(noneText)})`);
    await assert(noneText.includes('사장님께 말씀해 주세요'), `the empty-result notice must tell the customer to ask the owner (got ${JSON.stringify(noneText)})`);
    await assert(noneText.includes('초성도 돼요'), `the empty-result notice must carry the 초성 tip (got ${JSON.stringify(noneText)})`);
    // beta.23(LOW-6) — 검색은 앞글자 일치다(nameStartsWith). 규칙을 말해 주지 않으면 손님은
    //   '홍길동'을 '길동'으로 치고 "등록이 안 됐다"고 오해한 채 돌아선다. 규칙 + 예시를 그 자리에서 준다.
    await assert(noneText.includes('앞글자부터'), `the 0-hit notice must teach the prefix rule (got ${JSON.stringify(noneText)})`);
    await assert(noneText.includes('뒷부분'), `the 0-hit notice must contrast with "not the tail" (got ${JSON.stringify(noneText)})`);
    await assert(noneText.includes('홍길동') && noneText.includes("'홍'"), `the 0-hit notice must carry a worked example (got ${JSON.stringify(noneText)})`);
    const custPlaceholder = await page.locator('#custSearchInput').getAttribute('placeholder');
    await assert(String(custPlaceholder).includes('앞글자부터') && String(custPlaceholder).includes('초성'),
      `the customer search placeholder must state the prefix rule and the 초성 hint (got ${JSON.stringify(custPlaceholder)})`);
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
    await assert(emptyText.includes('앞글자부터 입력하면'), `the pre-query customer screen must show the prefix guidance line (got ${JSON.stringify(emptyText)})`);
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

    // ── (8-c2) 손님 검색은 **접두(앞글자) 일치**다 (beta.22) ────────────────────
    //   손님은 자기 이름 하나만 찾으면 된다. 부분 일치면 '영' 한 글자에 '영업맨'과 '홍룬영'이 함께 뜨고,
    //   손님은 남의 이름이 섞인 목록에서 자기를 골라야 한다 — 오탭 한 번이면 남의 잔액 화면 앞에 선다.
    //   ⚠️ 이 규칙은 **손님 화면에만** 적용된다. 사장님 홈 검색(state.search)은 부분 일치 그대로다
    //     (사장님은 기억나는 조각으로 찾는다 — 아래에서 함께 못 박는다).
    //   결과가 1명이면 앱이 스스로 확인 카드로 넘어간다(기존 계약) — 그때는 카드의 이름 한 개를 결과로 읽는다.
    const custRowNames = async (q) => {
      if (await count(page, '#custSearchInput') === 0) {
        await page.locator('[data-a="cust-cancel"], [data-a="cust-back"]').first().click();
        await page.waitForSelector('#custSearchInput');
      }
      await page.locator('#custSearchInput').fill(q);
      await page.waitForTimeout(200);
      if (await count(page, '.cust-ask')) return (await page.locator('.cust-card .cust-name').allInnerTexts()).map(t => t.trim());
      return (await page.locator('.cust-row-name').allInnerTexts()).map(t => t.trim());
    };
    const yeong = await custRowNames('영');
    await assert(JSON.stringify(yeong) === JSON.stringify(['영업맨']), `'영' must match ONLY the name that starts with it (got ${JSON.stringify(yeong)})`);
    await assert(!yeong.some(n => n.includes('홍룬영')), "'영' must never surface 홍룬영 — a mid/tail match puts a stranger's name in front of the customer");
    const yeongCho = await custRowNames('ㅇㅇ');
    await assert(JSON.stringify(yeongCho) === JSON.stringify(['영업맨']), `초성 'ㅇㅇ' must also be prefix-only (got ${JSON.stringify(yeongCho)})`);
    // 중간 일치·꼬리 일치는 어느 쪽도 노출되지 않는다.
    for (const [q, why] of [['업', '가운데 글자'], ['맨', '끝 글자'], ['룬', '가운데 글자(다른 사람)'], ['ㅇㅁ', '가운데 초성']]) {
      const rows = await custRowNames(q);
      await assert(rows.length === 0, `${why} "${q}" must match nobody under the prefix rule (got ${JSON.stringify(rows)})`);
      const none = (await page.locator('#custResults').innerText()).replace(/\n/g, ' ');
      await assert(none.includes(`'${q}'(으)로 시작하는 이름이 없어요.`), `the 0-hit notice must still echo the query "${q}" (got ${JSON.stringify(none)})`);
      await assert(none.includes('초성도 돼요'), `the 0-hit notice must keep the 초성 tip for "${q}"`);
      await assert(none.includes('앞글자부터'), `the 0-hit notice must keep the prefix rule for "${q}"`);
    }
    // 접두 규칙은 공백 무시·동명이인 병합·20건 상한과 함께 살아 있어야 한다.
    await assert(JSON.stringify(await custRowNames(' 영 업 ')) === JSON.stringify(['영업맨']), 'the prefix rule must still ignore spaces on both sides');
    const hongRows = await custRowNames('ㅎ');
    await assert(hongRows.length === 2 && hongRows[0].startsWith('홍길동') && hongRows[1] === '홍룬영', `'ㅎ' must list both 홍-names (got ${JSON.stringify(hongRows)})`);
    await assert(await count(page, '.cust-row.dup') === 1, '동명이인 병합 행은 접두 검색에서도 한 줄이어야 한다(병합 판정도 접두 매처를 쓴다)');
    await assert(hongRows[0].includes('동명이인 2명'), `the merged row must keep its 동명이인 wording under the prefix rule (got ${JSON.stringify(hongRows[0])})`);
    // 사장님 홈 검색은 **부분 일치 그대로**다 — 두 매처가 한 몸이 되면 사장님의 사용 습관이 깨진다.
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await page.locator('#searchInput').fill('영');
    await page.waitForTimeout(250);
    await expandHomeGroups(page);
    const ownerText = (await page.locator('.app').innerText()).replace(/\n/g, ' ');
    await assert(ownerText.includes('영업맨') && ownerText.includes('홍룬영'), `the OWNER's home search must stay a substring match — '영' must still find both 영업맨 and 홍룬영 (got ${JSON.stringify(ownerText.slice(0, 400))})`);
    // 사장님 화면의 초성 검색도 부분 일치 그대로다('ㅇㅁ'은 영업맨의 가운데 초성).
    await page.locator('#searchInput').fill('ㅇㅁ');
    await page.waitForTimeout(250);
    await expandHomeGroups(page);
    await assert(((await page.locator('.app').innerText()).replace(/\n/g, ' ')).includes('영업맨'), "the owner's 초성 search must stay a substring match too (ㅇㅁ → 영업맨)");
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(150);
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('#custSearchInput');

    // (8-d) 본인 확인 → **곧바로 요청 작성 화면**(beta.24). 잔액·최근 5건은 [최근 사용 내역 보기]로 연다.
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('#custAmountInput');
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).custStage === 'compose', '[네, 맞아요] must land on the request screen itself — the intermediate balance screen is no longer a required step');
    await assert(await count(page, '.cust-bal') === 0, 'the compose screen must not be the balance screen (the customer must be at the amount field already)');
    // 그럼에도 이름·소속·현재 잔액은 이 화면 위쪽에 그대로 있어야 한다(잔액만 확인하러 온 손님의 목적도 여기서 끝난다).
    const composeHead = (await page.locator('.cust-card').innerText()).replace(/\n/g, ' ');
    await assert(composeHead.includes('김철수') && composeHead.includes('광진구청 세무과'), `the compose screen must still name the customer and their 소속 (got ${JSON.stringify(composeHead.slice(0, 160))})`);
    await assert((await page.locator('#custAmtBal').innerText()).includes('30,500원'), `the compose screen must show the current balance (got ${await page.locator('#custAmtBal').innerText()})`);
    // 최근 5건은 사라지지 않았다 — 보조 링크 한 번이면 열린다(선택적 상세 화면).
    await page.locator('[data-a="cust-history"]').click();
    await page.waitForSelector('.cust-bal');
    await assert((await page.locator('.cust-bal').innerText()).includes('30,500원'), `the customer balance must match the ledger (got ${await page.locator('.cust-bal').innerText()})`);
    await assert(await count(page, '.cust-tx') === 5, `the customer detail must show exactly the 5 most recent transactions (got ${await count(page, '.cust-tx')})`);
    await assert(await count(page, '.cust-screen img') === 0, 'signature images must never render on the customer screen');
    await assert(await count(page, '.cust-screen [data-a="void"]') === 0, 'the customer screen must not offer the void button');
    const custTxText = await page.locator('.cust-txs').innerText();
    await assert(custTxText.includes('서명 있음'), 'a signed transaction must be marked with text only');
    await assert(await count(page, '.cust-tx.voided') === 1 && (await page.locator('.cust-tx.voided').innerText()).includes('취소됨'), 'a voided transaction must render grayed out with a 취소됨 mark');
    // beta.27: 손님이 스스로 잔액을 본 이 화면에서도 "사진으로 남겨두기"를 알려 준다 —
    //   여기서 말해 주지 않으면 손님은 잔액이 궁금할 때마다 사장님을 부른다. 잔액 바로 아래 한 줄이다.
    const custPhotoTip = await page.evaluate(() => {
      const t = document.querySelector('.cust-photo-tip');
      if (!t) return null;
      const bal = document.querySelector('.cust-bal');
      return { text: t.innerText.trim(), lines: Math.round(t.getBoundingClientRect().height), belowBalance: bal ? t.getBoundingClientRect().top >= bal.getBoundingClientRect().top : false };
    });
    await assert(Boolean(custPhotoTip), 'the customer balance screen must also tell them they can photograph it');
    await assert(custPhotoTip.text.includes('사진으로 찍어') && custPhotoTip.text.includes('잔액을 확인'),
      `the customer-side photo tip must read naturally (got ${JSON.stringify(custPhotoTip.text)})`);
    await assert(custPhotoTip.belowBalance, 'the photo tip belongs directly under the balance — that is the thing worth photographing');
    // 이 화면의 세로 예산은 버튼 3개가 초기 뷰포트 안에 들어오는 것으로 이미 꽉 차 있다 → 안내는 한 줄이어야 한다.
    await assert(custPhotoTip.lines <= 34, `the customer photo tip must stay one line (height ${custPhotoTip.lines}px) — a second line pushes the action buttons below the fold`);

    // (8-e) 게이트 스윕 — 허용 목록 밖의 모든 액션은 잠금 상태에서 통째로 차단된다(원장 불변).
    const lockAllowed = (await page.evaluate(() => window.__prepaidTestHooks.lockAllowed())).slice().sort();
    // beta.21에서 손님 액션(요청 작성)이 더해졌다 — 전부 휘발성 state만 만지는 '요청' 경로다.
    //   beta.22에서 cust-amt-next가 빠졌다(금액·서명이 한 화면이 되어 '다음' 단계 자체가 없어졌다).
    //   이 목록이 늘어나는 것 자체가 위험 신호이므로 값을 통째로 못 박아 둔다(원장 쓰기 액션이 섞이면 즉시 실패).
    const expectedAllowed = ['pin-key', 'pin-reset', 'pin-forgot', 'pin-forgot-cancel', 'pin-forgot-restore', 'lock-to-pin', 'pin-to-cust', 'cust-pick', 'cust-confirm', 'cust-cancel', 'cust-clear', 'cust-back', 'cust-call-owner', 'cust-request', 'cust-history', 'cust-amt-quick', 'cust-sign-clear', 'cust-sign-submit',
      // beta.52: 내 열쇠 백업 암호 입력창의 [확인]·[취소]·[암호 보기]. PIN 분실 복구 화면(잠금 상태)에서 열쇠 복원은
      //   원래부터 되는 경로였고(pin-forgot-restore → 열쇠 파일), 예전에는 암호를 기기 기본 팝업으로 받아 게이트 밖이었다.
      //   앱 안 입력창으로 옮기면서 이 셋이 게이트 안으로 들어왔다 — 빼면 복구 화면의 열쇠 복원이 막힌다.
      //   셋 다 '이미 열린 입력창'이 없으면 아무 일도 하지 않고, 입력창은 허용된 경로로만 열린다(아래 8-e2 전 액션 스윕이 봉인).
      'pass-ok', 'pass-cancel', 'pass-toggle',
      // beta.55: 앱 안 선택창의 버튼. 복구 화면의 열쇠 복원이 "다른 열쇠로 바꿀까요?"·"짝이 안 맞아요"를 선택창으로 묻는다.
      //   열린 선택창이 없으면 무동작이고, 잠금 전환 때 열린 창은 취소로 닫힌다(아래 8-e2 전 액션 스윕이 봉인).
      'choice-pick',
      // beta.60: 복구 화면 ① [백업 암호로 비밀번호 다시 정하기]와 그 다음 화면의 [그만두기]. 원장을 쓰지 않는다 — ①은 이 기기의 백업 암호가
      //   맞을 때만 '새 비밀번호 정하기'(메모리 상태)로 넘어가고, 백업 암호를 정한 적 없는 기기에서는 무동작이다(beta60a가 봉인).
      'pin-recover-pass', 'pin-newpin-cancel'].sort();
    await assert(!lockAllowed.includes('cust-compose-back'), 'the removed [뒤로] action (cust-compose-back) must not linger in the lock allowlist');
    await assert(!lockAllowed.includes('cust-amt-next'), 'the removed intermediate step (cust-amt-next) must not linger in the lock allowlist');
    await assert(JSON.stringify(lockAllowed) === JSON.stringify(expectedAllowed), `the lock allowlist must stay exactly the PIN/customer actions (got ${JSON.stringify(lockAllowed)})`);
    // beta.53: 직원 한 줄 행 펼침(toggle-emp)은 설정 화면 조작이다 — 존재하되 잠금 허용 목록 밖이어야 한다(아래 스윕이 무동작을 확인).
    await assert((await page.evaluate(() => window.__prepaidTestHooks.clickActionKeys())).includes('toggle-emp') && !lockAllowed.includes('toggle-emp'), 'beta.53 toggle-emp must exist and stay outside the lock allowlist');
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
    await page.waitForSelector('#custAmountInput');

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
    await page.waitForSelector('#custAmountInput');

    // (8-f) [사장님 부르기](A단계) → beta.19: 안내 화면 없이 **곧바로 PIN 화면("사장님 확인")**.
    //       요청은 휘발성이고, PIN이 맞으면 사용 모달이 자동으로 열린다(금액 빈 칸) → 저장까지.
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert(await count(page, '#custSearchInput') === 0, '[사장님 부르기] must go straight to the PIN screen (no extra "call the owner" step)');
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
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
    await page.waitForTimeout(150);
    await homeAfterReqReceipt();
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
    await setTimers({ custIdle: 30000, custComposeIdle: 60000, autoLock: 90000, pendingTtl: 120000, pinDelay: 60000, recoveryGate: 60000, modalIdleCap: 600000, ownerPinIdle: 120000, handoffPinIdle: 60000, pinKeyGuard: 500 });

    // ═══════════════════════════════════════════════════════════════════════
    // (8-B) B단계 — 손님이 금액·서명까지 미리 작성하는 '요청' (beta.21 → beta.22 한 화면)
    //
    //   지도 원칙은 A단계와 한 글자도 다르지 않다:
    //     "손님은 '요청'을 만들고, 사장님은 '기록'을 만든다."
    //   손님이 금액을 치고 서명까지 해도 그것은 끝까지 요청이다 — 원장에 줄이 생기는 순간은
    //   오직 사장님이 PIN을 풀고 사용 모달의 confirm을 누른 때다. 이 절의 모든 단언은
    //   그 경계가 어디에서도 새지 않는지를 본다(요청이 저장되면 이 앱은 즉시 '무인 결제기'가 된다).
    //
    //   beta.22: 금액 화면과 서명 화면이 **한 화면**으로 합쳐졌다([사용 요청하기] → 곧바로 통합 화면).
    //   합치면서 생긴 유일한 새 위험은 "금액 한 글자가 서명을 지운다"이다 — 전면 재렌더 구조에서
    //   입력창과 캔버스가 같은 화면에 공존하기 때문이다. (B-u)가 그 위험을 전담해 못 박는다.
    // ═══════════════════════════════════════════════════════════════════════
    await seedHome([
      { id: 'br-1', org: '광진구청', orgKind: 'public', dept: '세무과', name: '김요청', amount: 30000 },
      { id: 'br-2', org: '광진구청', orgKind: 'public', dept: '세무과', name: '박두번', amount: 50000 },
      { id: 'br-3', org: '한빛물산', orgKind: '', dept: '영업1팀', name: '최소액', amount: 1000 }
    ], { orgName: '광진구청' });

    // 어디에 서 있든 "빈 손님 검색 화면"으로 되돌린다 — 잠금이 풀려 있으면 [손님 셀프 조회]로 잠그고,
    //   이미 잠겨 있으면(요청 작성 중·PIN 화면) 되돌아가기 버튼을 눌러 처음으로 나온다.
    const toCustomer = async () => {
      if (await count(page, '[data-a="quick-find-emp"]')) {
        if (await count(page, '.modal-back')) {
          await page.locator('.modal-actions [data-a="close-modal"]').first().click();
          await page.waitForTimeout(150);
        }
        await page.locator('[data-a="hand-to-customer"]').click();
      }
      await page.waitForSelector('.cust-screen, .pin-screen', { timeout: 8000 });
      for (let guard = 0; guard < 6 && await count(page, '#custSearchInput') === 0; guard += 1) {
        const backBtn = page.locator('[data-a="pin-to-cust"], [data-a="cust-back"], [data-a="cust-cancel"]');
        if (await backBtn.count() === 0) break;
        await backBtn.first().click();
        await page.waitForTimeout(150);
      }
      await page.waitForSelector('#custSearchInput', { timeout: 8000 });
    };
    // 이름으로 찾아 본인 확인까지 — 결과가 1건이면 앱이 스스로 확인 카드로 넘어간다(기존 계약).
    //   beta.24: [네, 맞아요]의 착지점은 **요청 작성 화면**이다. 잔액을 쓸 수 없는 손님(검증 실패·잔액 0 이하)만
    //   상세 화면(.cust-bal)으로 간다 — 두 착지점을 모두 받아들이되, 어느 쪽인지는 호출부가 단언한다.
    const custLookup = async (name) => {
      await page.locator('#custSearchInput').fill(name);
      await page.waitForSelector('.cust-ask');
      await page.locator('[data-a="cust-confirm"]').click();
      await page.waitForSelector('#custAmountInput, .cust-bal');
    };
    // 요청 작성 화면 → 선택적 상세 화면(잔액 + 최근 5건)으로 가는 보조 링크.
    const openHistory = async () => {
      await page.locator('[data-a="cust-history"]').click();
      await page.waitForSelector('.cust-bal');
    };
    const drawOn = async (selector) => {
      // 모달이 다시 그려지면 스크롤이 맨 위로 돌아간다 — 캔버스가 화면 밖에 있으면 마우스 좌표가 엉뚱한 곳에 떨어진다.
      await page.locator(selector).scrollIntoViewIfNeeded();
      await page.waitForTimeout(60);
      const box = await page.locator(selector).boundingBox();
      await page.mouse.move(box.x + 30, box.y + box.height * 0.6);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 6 });
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.7, { steps: 6 });
      await page.mouse.up();
    };
    const lockSt2 = () => page.evaluate(() => window.__prepaidTestHooks.lockState());
    const txCount = async () => (await readDb(page)).transactions.length;
    // 통합 요청 화면(금액 + 서명)까지 한 번에 — 서명을 그리고 [사장님 확인 받기]를 누르기 직전까지.
    //   beta.22: 금액 화면 → [다음] → 서명 화면 이었던 두 걸음이 여기서 사라졌다. 캔버스는 처음부터 떠 있다.
    //   beta.24: [사용 요청하기] 탭도 사라졌다 — 본인 확인이 곧 요청 작성 화면이다(3걸음 → 2걸음).
    const composeTo = async (name, amountText) => {
      await toCustomer();
      await custLookup(name);
      await page.waitForSelector('#custAmountInput');
      await page.waitForSelector('.cust-sig #signCanvas');
      if (amountText !== null) await page.locator('#custAmountInput').fill(amountText);
      await page.waitForTimeout(80);
    };
    // 캔버스에 남긴 표식(expando)과 획의 생존을 한 번에 읽는다 — 노드만 같고 그림이 비면 아무 의미가 없다.
    const markCanvas = () => page.evaluate(() => { document.querySelector('#signCanvas').__bapStroke = 'alive'; });
    const canvasState = () => page.evaluate(() => {
      const c = document.querySelector('#signCanvas');
      const i = document.querySelector('#custAmountInput');
      const H = window.__prepaidTestHooks.lockState();
      return {
        hasCanvas: !!c, sameNode: !!c && c.__bapStroke === 'alive',
        hasInput: !!i, sameInput: !!i && i.__bapProbe === 'alive', value: i ? i.value : null,
        focused: !!i && document.activeElement === i,
        blurs: window.__amtBlurs || 0,
        empty: H.signPadEmpty, live: H.signPadLive, amount: H.custAmount, stage: H.custStage
      };
    });

    // ── (B-u) 통합 화면(beta.22): 금액을 치는 동안 서명이 절대 지워지지 않는다 ────────────
    //   이 앱은 화면을 통째로 다시 그린다(#app.innerHTML). 그러므로 "금액 입력"과 "서명 캔버스"가 한 화면에
    //   있다는 사실 자체가 사고의 씨앗이다 — 한 글자마다 render가 돌면 캔버스 노드가 교체되고,
    //   손님이 절반쯤 쓴 이름이 소리 없이 사라진다. 손님은 자기가 잘못 쓴 줄 알고 처음부터 다시 쓴다.
    //   여기서 재는 것은 셋이다: ①캔버스 **노드 동일성** ②실제 **획**의 생존 ③입력 포커스 유실 0.
    await composeTo('김요청', null);
    await assert(await count(page, '#custAmountInput') === 1 && await count(page, '.cust-sig #signCanvas') === 1,
      'the request screen must carry the amount field and the signature canvas at the SAME time (the intermediate amount-only screen is gone)');
    await assert(await count(page, '[data-a="cust-amt-next"]') === 0, 'the intermediate [다음 (서명)] button must be gone — one screen means one step');
    const composeBtns = (await page.locator('.cust-actions button').allInnerTexts()).map(t => t.trim());
    await assert(JSON.stringify(composeBtns) === JSON.stringify(['사장님 확인 받기', '지우고 다시', '처음으로']),
      `the unified screen must end with exactly [사장님 확인 받기]·[지우고 다시]·[처음으로] (got ${JSON.stringify(composeBtns)})`);
    await assert(await count(page, '[data-a="cust-compose-back"]') === 0, 'the old [뒤로] (compose → balance) button must be gone — the balance screen is no longer behind this one');
    // 보조 링크 둘 — 최근 내역(선택적 상세)과 A단계 인계. 이 둘이 사라지면 손님이 갈 수 있는 길이 줄어든다.
    const composeLinks = (await page.locator('.cust-links button').allInnerTexts()).map(t => t.replace(/\n/g, ' ').trim());
    await assert(composeLinks.length === 2, `the compose screen must keep exactly two auxiliary links (got ${JSON.stringify(composeLinks)})`);
    await assert(composeLinks[0].includes('최근') && composeLinks[0].includes('내역'), `the first link must open the recent-history detail (got ${JSON.stringify(composeLinks)})`);
    await assert(composeLinks[1].includes('사장님 부르기') && composeLinks[1].includes('금액을 모르겠어요'),
      `the A-path escape hatch must stay reachable from the compose screen and say why one would use it (got ${JSON.stringify(composeLinks)})`);
    await assert(await count(page, '.cust-links [data-a="cust-history"]') === 1 && await count(page, '.cust-links [data-a="cust-call-owner"]') === 1,
      'the two auxiliary links must be the history link and the call-the-owner handover');
    // 순서도 계약이다 — 위에서 아래로 대상 → 잔액 → 금액칸 → 서명 → 버튼(beta.44: 큰 숫자 자리가 잔액 한 줄).
    const composeOrder = await page.evaluate(() => {
      const y = s => { const el = document.querySelector(s); return el ? el.getBoundingClientRect().top : NaN; };
      return { name: y('.cust-name'), bal: y('#custAmtBal'), input: y('#custAmountInput'), signTitle: y('.cust-sign-title'), canvas: y('#signCanvas'), submit: y('[data-a="cust-sign-submit"]') };
    });
    await assert(composeOrder.name < composeOrder.bal && composeOrder.bal < composeOrder.input
      && composeOrder.input < composeOrder.signTitle && composeOrder.signTitle < composeOrder.canvas
      && composeOrder.canvas < composeOrder.submit,
      `the unified screen must read top-to-bottom: 대상 → 잔액 → 금액칸 → 서명 안내 → 서명판 → 버튼 (got ${JSON.stringify(composeOrder)})`);
    // ── beta.27: 빈 서명판 안내(손님 요청 화면) ────────────────────────────────
    //   이 화면은 손님이 직접 만지는 유일한 화면이다. 흰 상자만 놓여 있으면 어르신은 무엇을 하는 칸인지 모른다.
    //   사장님 모달과 **같은 오버레이 구현**이어야 한다 — 캔버스에 그리는 순간 그 문구가 원장의 서명 그림에 박힌다.
    const custHint = await page.evaluate(() => {
      const canvas = document.querySelector('.cust-sig #signCanvas');
      const hint = canvas.parentElement.querySelector('.sig-hint');
      if (!hint) return { missing: true };
      const ctx = canvas.getContext('2d');
      const y0 = Math.round(canvas.height * 0.2), y1 = Math.round(canvas.height * 0.7);
      const d = ctx.getImageData(0, y0, canvas.width, y1 - y0).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) nonWhite += 1;
      const shown = canvas.toDataURL('image/jpeg', 0.5);
      hint.style.display = 'none';
      void hint.offsetHeight;
      const hidden = canvas.toDataURL('image/jpeg', 0.5);
      hint.style.display = '';
      return {
        text: hint.textContent.trim(), visible: hint.offsetParent !== null,
        pointerEvents: getComputedStyle(hint).pointerEvents,
        insideCanvas: canvas.contains(hint), nonWhite, dataUrlUnchanged: shown === hidden
      };
    });
    await assert(!custHint.missing, 'the customer request screen must render a hint inside the empty signature box');
    await assert(custHint.text.includes('서명') && custHint.text.includes('손가락'), `the customer signature hint must read naturally (got ${JSON.stringify(custHint.text)})`);
    await assert(custHint.visible === true && !custHint.insideCanvas && custHint.pointerEvents === 'none',
      'the customer hint must be a pass-through CSS overlay, never a child of the canvas');
    await assert(custHint.nonWhite === 0 && custHint.dataUrlUnchanged,
      `the customer hint must leave the canvas backing store untouched (nonWhite ${custHint.nonWhite}, dataURL identical ${custHint.dataUrlUnchanged})`);

    // ① 먼저 서명을 그리고, 그 위에서 금액을 한 글자씩 친다(현실의 순서 — 손님은 이름부터 쓰기도 한다).
    await drawOn('.cust-sig #signCanvas');
    await assert(await page.evaluate(() => {
      const c = document.querySelector('.cust-sig #signCanvas');
      const h = c.parentElement.querySelector('.sig-hint');
      return Boolean(h) && h.offsetParent === null && c.parentElement.classList.contains('signed');
    }), 'the customer hint must vanish as soon as the first stroke lands');
    await markCanvas();
    await page.evaluate(() => {
      window.__amtBlurs = 0;
      document.addEventListener('focusout', e => { if (e.target && e.target.id === 'custAmountInput') window.__amtBlurs += 1; }, true);
      document.querySelector('#custAmountInput').__bapProbe = 'alive';
    });
    await page.locator('#custAmountInput').click();
    for (const [i, ch] of [...'12345'].entries()) {
      await page.keyboard.type(ch, { delay: 25 });
      await page.waitForTimeout(60);
      const s = await canvasState();
      await assert(s.hasCanvas && s.sameNode, `typing character ${i + 1} must not replace the signature canvas node`);
      await assert(!s.empty, `typing character ${i + 1} must not wipe the strokes already drawn`);
      await assert(s.sameInput, `typing character ${i + 1} must not replace the amount input node (the phone keypad would close)`);
      await assert(s.focused, `typing character ${i + 1} must not steal focus from the amount input`);
      await assert(s.value === '12345'.slice(0, i + 1), `character ${i + 1} must land in the input (got ${JSON.stringify(s.value)})`);
      await assert(s.blurs === 0, `typing character ${i + 1} must not raise a focusout (${s.blurs} so far)`);
    }
    // beta.44: 큰 숫자가 없어졌으니 "글자가 들어갔다"의 증거는 입력칸 자신이다. 그리고 잔액 한 줄은
    //   타이핑에도 흔들리지 않아야 한다(현재 잔액 고정 — 손님 눈앞에서 잔액이 줄어드는 착시를 만들지 않는다).
    await assert((await page.locator('#custAmountInput').inputValue()) === '12345', 'every typed character must land in the input field');
    await assert(/^잔액 [\d,]+원이 남아있어요$/.test((await page.locator('#custAmtBal').innerText()).trim()), 'the balance line must keep its shape while the customer types');
    // ② 서명이 있는 상태에서 빠른 금액을 눌러도 서명은 그대로다.
    await page.locator('[data-a="cust-amt-quick"][data-amount="18000"]').click();
    await page.waitForTimeout(120);
    let s2 = await canvasState();
    await assert(s2.sameNode && !s2.empty, 'tapping a quick amount must not disturb the signature already drawn');
    await assert(s2.value === '18000' && s2.amount === '18000', `the quick amount must replace the typed one (got ${JSON.stringify(s2.value)})`);
    // ③ 지우고 서명을 다시 그려도 금액은 남는다 / 금액을 고쳐도 서명은 남는다.
    await page.locator('[data-a="cust-sign-clear"]').click();
    await page.waitForTimeout(120);
    s2 = await canvasState();
    await assert(s2.sameNode, '[지우고 다시] must not tear the canvas node down (a re-render would wipe the amount too)');
    await assert(s2.empty === true, '[지우고 다시] must actually clear the strokes');
    await assert(s2.value === '18000' && s2.amount === '18000', '[지우고 다시] must clear ONLY the signature — the amount the customer typed must stay');
    // 판이 다시 비었으면 안내도 다시 나온다 — 지우자마자 "여기 뭘 하는 칸이었지"가 되면 안 된다.
    await assert(await page.evaluate(() => {
      const c = document.querySelector('.cust-sig #signCanvas');
      const h = c.parentElement.querySelector('.sig-hint');
      return Boolean(h) && h.offsetParent !== null && !c.parentElement.classList.contains('signed');
    }), '[지우고 다시] must bring the empty-canvas hint back');
    await drawOn('.cust-sig #signCanvas');
    await markCanvas();
    await page.locator('#custAmountInput').fill('7000');
    await page.waitForTimeout(120);
    s2 = await canvasState();
    await assert(s2.sameNode && !s2.empty, 'editing the amount after signing must not wipe the signature');
    await assert((await page.locator('#custAmountInput').inputValue()) === '7000', 'the edited amount must stay in the input field');

    // ④ 비동기 render 공격 — 아무도 아무것도 누르지 않았는데 화면을 갈아엎으려는 경로들.
    //    토스트(3초 뒤 스스로 사라짐)·네트워크 플랩·탭 복귀·수신함 폴링. 어느 것도 서명·금액을 건드릴 수 없다.
    await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await page.evaluate(() => window.__prepaidTestHooks.refreshInboxCount());
    await page.evaluate(() => { window.__prepaidTestHooks.renderIsDisruptive(); });
    await page.waitForTimeout(500);
    s2 = await canvasState();
    await assert(s2.hasCanvas && s2.sameNode && !s2.empty, 'an async render (network flap / visibility / inbox poll) must never replace or blank the signature canvas');
    await assert(s2.value === '7000' && s2.amount === '7000', 'an async render must not roll the amount back either');
    await assert(await page.evaluate(() => window.__prepaidTestHooks.renderIsDisruptive()) === true, 'a screen carrying live strokes must be judged disruptive to render');
    // ⑤ 최후의 방벽 — 누군가 대놓고 render()를 불러도(향후 새 경로가 게이트를 빼먹는 경우) 서명은 살아남는다.
    await page.evaluate(() => { window.__prepaidTestHooks.forceRender(); });
    await page.waitForTimeout(150);
    s2 = await canvasState();
    await assert(s2.hasCanvas && s2.sameNode && !s2.empty, 'even a direct render() call must be downgraded to a partial update while strokes are alive');
    await assert(s2.value === '7000', 'the downgraded render must leave the typed amount untouched');

    // ── ⑤-b beta.23(MEDIUM-2): 가드가 막는 동안에도 **바뀌어야 할 것은 바뀐다** ────────────
    //   forceRender 훅만으로는 "서명이 살아남았다"는 절반만 본다. 나머지 절반이 더 위험하다:
    //   예전에는 render()가 가드로 강등돼도 꼬리의 armIdle()이 유휴 시계를 **처음부터 다시** 걸었다.
    //   → 게이트를 빼먹은 경로 하나가 반복해서 render를 부르면(200ms 폴링이면 충분하다)
    //     손님 이름·잔액이 뜬 화면이 **영원히** 사라지지 않는다. 화면이 굳는 것이 곧 개인정보 노출이다.
    //   beta.23부터 유휴 만료는 "마지막 사용자 조작 시각(lastInputAt)"으로 판정한다 — 렌더는 시계를 못 늘린다.
    await setTimers({ custIdle: 400, custComposeIdle: 1600 });
    await page.locator('#custAmountInput').fill('9000');
    await page.waitForTimeout(80);
    await drawOn('.cust-sig #signCanvas');
    await markCanvas();
    await page.evaluate(() => { window.__spamRender = setInterval(() => window.__prepaidTestHooks.forceRender(), 100); });
    await page.waitForTimeout(300);
    // (1) 폭격 중에도 부분 갱신은 살아 있다 — 손님이 누른 금액이 입력칸에 남고, 잔액·오류 줄이 정상이다.
    await page.locator('[data-a="cust-amt-quick"][data-amount="18000"]').click();
    await page.waitForTimeout(200);
    const spamPaint = await page.evaluate(() => ({
      value: document.querySelector('#custAmountInput').value,
      bal: document.querySelector('#custAmtBal').textContent.trim(),
      err: document.querySelector('#custAmtErr').textContent.trim()
    }));
    await assert(spamPaint.value === '18000' && spamPaint.err === '' && /^잔액 [\d,]+원이 남아있어요$/.test(spamPaint.bal),
      `while the guard is downgrading renders the amount display must STILL be repainted (got ${JSON.stringify(spamPaint)})`);
    const spamState = await canvasState();
    await assert(spamState.sameNode && !spamState.empty, 'the render storm must not cost the signature');
    await assert((await lockSt2()).idleSinceInput < 900, 'a real tap must reset the idle clock (only user input may)');
    // (2) 유휴 복귀는 렌더 폭격에 굶어 죽지 않는다 — 마지막 **조작**으로부터 1600ms 뒤 손님 초기 화면으로.
    await page.waitForTimeout(2400);
    await page.evaluate(() => { clearInterval(window.__spamRender); window.__spamRender = null; });
    await assert(await count(page, '#custSearchInput') === 1,
      'a repeating render() must NOT starve the idle return — the customer name/balance would otherwise stay on screen forever');
    await assert(await count(page, '#signCanvas') === 0, 'the idle return must also tear the canvas out (the draft signature must not survive it)');
    const starved = await lockSt2();
    await assert(starved.custStage === 'search' && starved.custAmount === '' && starved.signPadLive === false,
      `the idle return must discard the whole draft (got ${JSON.stringify({ stage: starved.custStage, amount: starved.custAmount, live: starved.signPadLive })})`);
    // (3) 반대 방향도 계약이다 — **실제 조작**은 시계를 확실히 밀어야 한다(서명하는 동안 화면이 튀면 안 된다).
    //     1000ms 시계를 250ms 간격의 드로잉 6번(총 1500ms)으로 넘긴다. 렌더가 아니라 손이 시계를 민다.
    await setTimers({ custIdle: 400, custComposeIdle: 1000 });
    await composeTo('김요청', '9000');
    await drawOn('.cust-sig #signCanvas');
    await markCanvas();
    for (let i = 0; i < 6; i += 1) { await drawOn('.cust-sig #signCanvas'); await page.waitForTimeout(150); }
    const keptAlive = await canvasState();
    await assert(keptAlive.hasCanvas && keptAlive.sameNode && !keptAlive.empty,
      'drawing (a real user input) must keep extending the idle clock — the screen must not jump while the customer is still signing');
    // (4) 가드가 걸린 상태에서도 **잠금 전환**은 반드시 일어난다(가드는 "같은 화면에 머무는 렌더"만 강등한다).
    // (beta.54: handToOwner도 전환 직전에 금액 칸 초점을 거두지만, 헤드리스 크로미움은 노드 제거 때도 blur를 내므로 여기서는
    //   구분이 안 된다 — 하니스는 서명 시작 blur(위)만 계약으로 고정한다. 실제 태블릿의 키보드는 그 시점에 이미 내려가 있다.)
    await page.evaluate(() => { window.__spamRender = setInterval(() => window.__prepaidTestHooks.forceRender(), 100); });
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]', { timeout: 5000 });
    await page.evaluate(() => { clearInterval(window.__spamRender); window.__spamRender = null; });
    await assert((await lockSt2()).lockView === 'pin' && await count(page, '#signCanvas') === 0,
      'a render storm must not be able to block the handoff to the owner PIN screen (screen transitions always win over the guard)');
    // 돌아와서 (5) 화면 전환([뒤로])도 같은 성질인지 본다.
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput', { timeout: 5000 });
    await setTimers({ custIdle: 30000, custComposeIdle: 60000 });
    await composeTo('김요청', '9000');
    await drawOn('.cust-sig #signCanvas');
    await page.evaluate(() => { window.__spamRender = setInterval(() => window.__prepaidTestHooks.forceRender(), 100); });
    await page.locator('[data-a="cust-history"]').click();
    await page.waitForSelector('.cust-bal', { timeout: 5000 });
    await page.evaluate(() => { clearInterval(window.__spamRender); window.__spamRender = null; });
    await assert(await count(page, '#signCanvas') === 0 && (await lockSt2()).custStage === 'self',
      'a render storm must not be able to block [최근 사용 내역 보기] either — the detail screen must actually repaint');

    // 이후 검사는 원래의 흐름(서명 있는 통합 화면)에서 이어진다.
    await page.locator('[data-a="cust-request"]').click();
    await page.waitForSelector('.cust-sig #signCanvas');
    await page.locator('#custAmountInput').fill('7000');
    await page.waitForTimeout(80);
    // beta.54(현장): 금액을 친 뒤 서명판을 터치하면 금액 칸의 초점이 거둬져야 한다(preventDefault 때문에 브라우저가 스스로 blur하지 않는다).
    //   초점이 남으면 태블릿 설치 앱의 숫자 키보드가 서명판과, 이어지는 "사장님 확인" 화면의 비밀번호 판을 가린다.
    await page.evaluate(() => { window.__amtBlur = 0; const i = document.getElementById('custAmountInput'); i.focus(); i.addEventListener('blur', () => { window.__amtBlur += 1; }); });
    await drawOn('.cust-sig #signCanvas');
    await markCanvas();
    await assert((await page.evaluate(() => ({ blur: window.__amtBlur, active: document.activeElement && document.activeElement.id }))).blur >= 1,
      'starting a signature must blur the amount input (otherwise the tablet keyboard stays up over the signature pad)');
    await assert((await page.evaluate(() => document.activeElement && document.activeElement.id)) !== 'custAmountInput', 'the amount input must not keep focus while the customer signs');
    // ⑥ 제출 검증 — 서명은 있으나 금액이 없으면 넘어가지 않는다(그리고 서명은 그대로 남는다).
    await page.locator('#custAmountInput').fill('');
    await page.waitForTimeout(100);
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(200);
    await assert((await lockSt2()).pendingCustomerId === '', 'an empty amount must not create a request even with a signature drawn');
    await assert((await page.locator('#custAmtErr').innerText()).trim().length > 0, 'an empty amount must say what is missing, right under the amount');
    s2 = await canvasState();
    await assert(s2.sameNode && !s2.empty, 'the amount error must not cost the customer the signature they already drew');
    // 잔액 초과도 같은 자리에서 막힌다.
    await page.locator('#custAmountInput').fill('30001');
    await page.waitForTimeout(120);
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(200);
    await assert((await lockSt2()).pendingCustomerId === '', 'an over-balance amount must not create a request');
    await assert((await page.locator('#custAmtErr').innerText()).includes('잔액보다 많아요'), 'the over-balance block must say so in the customer\'s own words');
    s2 = await canvasState();
    await assert(s2.sameNode && !s2.empty, 'the over-balance error must not cost the signature either');
    // ⑦ 금액은 있으나 서명이 없으면 넘어가지 않는다(그리고 금액은 그대로 남는다).
    await page.locator('#custAmountInput').fill('9000');
    await page.waitForTimeout(120);
    await page.locator('[data-a="cust-sign-clear"]').click();
    await page.waitForTimeout(120);
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(200);
    await assert((await lockSt2()).pendingCustomerId === '', 'a cleared signature must count as no signature');
    await assert((await page.locator('#custSignErr').innerText()).includes('서명'), 'the missing signature must be named right under the canvas');
    await assert((await page.locator('#custAmountInput').inputValue()) === '9000', 'the signature error must not cost the customer the amount they already typed');
    // ⑧ [처음으로]는 둘 다 버리고 검색 화면으로 — 다음 손님에게 앞 손님의 금액·서명이 남으면 안 된다.
    //    beta.24: 요청 작성 화면에서 나가는 길은 하나다(예전의 [뒤로] = 잔액 화면 복귀는 사라졌다).
    await drawOn('.cust-sig #signCanvas');
    await page.locator('.cust-actions [data-a="cust-back"]').click();
    await page.waitForSelector('#custSearchInput');
    const backState = await lockSt2();
    await assert(backState.custAmount === '' && backState.custStage === 'search', '[처음으로] must discard the draft amount and land on the empty search');
    await assert(backState.signPadLive === false, '[처음으로] must detach the signature canvas (the drawing must be unreachable, not merely off-screen)');
    await assert(await count(page, '#signCanvas') === 0, '[처음으로] must tear the canvas out of the DOM');
    // 다시 들어가면 처음부터다.
    await custLookup('김요청');
    await page.waitForSelector('.cust-sig #signCanvas');
    const reentry = await canvasState();
    await assert(reentry.value === '' && reentry.empty === true, 're-entering the request screen must start from an empty amount AND an empty canvas');

    // ── (B-r) 왕복 보존 계약 — [최근 사용 내역 보기] ↔ [사용 요청 계속하기] ──────────────
    //   손님이 "내가 지난번에 얼마 썼더라?"를 확인하고 돌아오는 길이다. 계약은 둘로 못 박는다:
    //     · **금액은 보존된다**(state.custAmount에 살아 있다).
    //     · **서명은 지워진다** — 캔버스는 DOM과 함께 사라지고 사본을 남기지 않는다('요청은 휘발성').
    //       그래서 상세 화면이 그 사실을 손님에게 글로 알려야 한다(모르면 서명한 줄 알고 제출한다).
    await page.locator('#custAmountInput').fill('12000');
    await page.waitForTimeout(100);
    await drawOn('.cust-sig #signCanvas');
    await assert((await lockSt2()).signPadEmpty === false, 'the round-trip check needs a real signature drawn first');
    await openHistory();
    const detailState = await lockSt2();
    await assert(detailState.custStage === 'self', '[최근 사용 내역 보기] must open the optional detail screen');
    await assert(detailState.custAmount === '12000', 'the amount the customer typed must survive the trip to the history screen');
    await assert(detailState.signPadLive === false && await count(page, '#signCanvas') === 0, 'the signature canvas must be gone while the customer reads their history');
    await assert(await count(page, '.cust-tx') >= 1, 'the detail screen must actually show the recent transactions');
    const detailNote = (await page.locator('.cust-draft-note').innerText()).replace(/\n/g, ' ');
    await assert(detailNote.includes('금액은 그대로') && detailNote.includes('서명만 다시'),
      `the detail screen must state the preservation contract in plain words — amount kept, signature redone (got ${JSON.stringify(detailNote)})`);
    const detailBtns = (await page.locator('.cust-actions button').allInnerTexts()).map(t => t.trim());
    await assert(JSON.stringify(detailBtns) === JSON.stringify(['사용 요청 계속하기', '사장님 부르기', '처음으로']),
      `the detail screen must offer [사용 요청 계속하기]·[사장님 부르기]·[처음으로] (got ${JSON.stringify(detailBtns)})`);
    await page.locator('[data-a="cust-request"]').click();
    await page.waitForSelector('.cust-sig #signCanvas');
    const roundTrip = await canvasState();
    await assert(roundTrip.value === '12000' && roundTrip.amount === '12000',
      `coming back from the history screen must keep the amount exactly as it was (got ${JSON.stringify(roundTrip.value)})`);
    await assert(roundTrip.empty === true, 'the signature must be blank after the round trip — the detail screen promised exactly that');
    await assert((await page.locator('#custAmountInput').inputValue()) === '12000', 'the preserved amount must be repainted into the input field');
    // 조회만 하러 온 손님은 상세 화면에서 [처음으로]로 끝낼 수 있어야 한다.
    await openHistory();
    await page.locator('.cust-actions [data-a="cust-back"]').click();
    await page.waitForSelector('#custSearchInput');
    const lookupOnly = await lockSt2();
    await assert(lookupOnly.custStage === 'search' && lookupOnly.custAmount === '' && lookupOnly.pendingCustomerId === '',
      'a lookup-only customer must be able to finish at [처음으로] with nothing left behind');

    // ── (B-c) [사장님 부르기]는 적어 둔 것을 **묻고 나서** 버린다 (beta.25 MEDIUM-1) ──────────
    //   요청 작성 화면의 보조 링크는 나란히 둘이다. 왼쪽([최근 사용 내역 보기])은 "금액은 그대로"라고
    //   약속하는데, 오른쪽([금액을 모르겠어요 / 사장님 부르기])은 beta.24까지 아무 말 없이 금액과 서명을
    //   버렸다 — 두 링크가 서로 반대되는 약속을 하면 손님은 어느 쪽도 믿을 수 없다.
    //   규칙은 셋이다: 적어 둔 것이 있으면 묻는다 · 취소하면 하나도 잃지 않는다 · 빈 화면에서는 묻지 않는다.
    await toCustomer();
    await custLookup('김요청');
    await page.locator('#custAmountInput').fill('7000');
    await page.waitForTimeout(120);
    await drawOn('.cust-sig #signCanvas');
    await assert((await lockSt2()).signPadEmpty === false, 'this check needs a real signature drawn first');
    confirmAnswer = false;
    const askBefore = dialogs.length;
    await page.locator('.cust-links [data-a="cust-call-owner"]').click();
    await page.waitForTimeout(300);
    const asked = dialogs.slice(askBefore).filter(d => d.type === 'confirm');
    await assert(asked.length === 1, `[사장님 부르기] must ask before throwing away the amount and signature the customer already wrote (got ${JSON.stringify(dialogs.slice(askBefore))})`);
    await assert(/금액/.test(asked[0].message) && /서명/.test(asked[0].message),
      `the question must name exactly what is about to be lost (got ${JSON.stringify(asked[0].message)})`);
    const kept = await lockSt2();
    await assert(kept.custStage === 'compose' && kept.custAmount === '7000', `cancelling must leave the customer exactly where they were (got stage=${kept.custStage} amount=${JSON.stringify(kept.custAmount)})`);
    await assert(kept.signPadEmpty === false, 'cancelling must keep the signature strokes too — the customer said "no, I am still writing"');
    await assert(kept.pendingCustomerId === '' && kept.lockView !== 'pin', 'cancelling must not hand anything over to the owner');
    await assert((await page.locator('#custAmountInput').inputValue()) === '7000', 'the amount must still be in the field after cancelling, not merely in state');
    confirmAnswer = true;
    await page.locator('.cust-links [data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    const handedOver = await lockSt2();
    await assert(handedOver.pendingAmount === 0 && handedOver.pendingSignLen === 0, 'the A path must hand over the target only — never the amount or the signature');
    await assert(handedOver.custAmount === '', 'confirming the question must actually discard the draft');
    // 빈 화면(대부분의 손님)에서는 아무것도 묻지 않는다 — 확인 절차가 탭 수를 늘리면 안 된다.
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');
    await custLookup('김요청');
    const quietBefore = dialogs.length;
    await page.locator('.cust-links [data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert(dialogs.length === quietBefore, `an empty request screen must hand over without asking anything (got ${JSON.stringify(dialogs.slice(quietBefore))})`);
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');

    // ── (B-a) 해피패스 — 손님 9,000원 + 서명 → 사장님 확인 → PIN → 프리필 → 저장 → 원장 ──
    await toCustomer();
    await custLookup('김요청');
    // beta.24: 본인 확인 직후가 곧 금액 칸이다(잔액 화면을 한 번 더 지나지 않는다).
    await assert(await count(page, '#custAmountInput') === 1, 'the happy path must reach the amount field straight from the confirmation card');
    // beta.44: 금액 안내는 한 줄이다 — "잔액 N원이 남아있어요". 큰 숫자(#custAmtBig)·사용 후 예상 잔액
    //   (#custAmtAfter)은 DOM에서 사라졌다. 손님이 읽어야 하는 숫자를 하나로 줄인 것이 이 변경의 전부다.
    await assert(await count(page, '#custAmtBig') === 0 && await count(page, '#custAmtAfter') === 0, 'beta.44: the big amount and the after-balance line must be gone from the request screen');
    const balLine0 = (await page.locator('#custAmtBal').innerText()).trim();
    await assert(balLine0 === '잔액 30,000원이 남아있어요', `the request screen must open with the single balance line (got ${JSON.stringify(balLine0)})`);
    // 이 줄이 화면에서 가장 큰 글자여야 한다(예전 큰 숫자가 맡던 자리를 그대로 물려받는다).
    const balFont = await page.evaluate(() => ({
      bal: parseFloat(getComputedStyle(document.querySelector('#custAmtBal')).fontSize),
      label: parseFloat(getComputedStyle(document.querySelector('.cust-req-field label')).fontSize)
    }));
    await assert(balFont.bal >= 20, `the balance line must be big enough for an older customer to read (got ${balFont.bal}px)`);
    // 서명 안내는 "서명하고 다음에 무엇을 누르는지"까지 말한다.
    const signTitle = (await page.locator('.cust-sign-title').innerText()).replace(/\s+/g, ' ').trim();
    await assert(signTitle === '여기에 서명하시고, 사장님 확인받기를 클릭해주세요', `the signature title must tell the customer what to press next (got ${JSON.stringify(signTitle)})`);
    await assert(parseFloat(String(await page.evaluate(() => getComputedStyle(document.querySelector('.cust-sign-title')).fontSize))) >= 15, 'the signature title must be at least 15px');
    const quickTexts = (await page.locator('.cust-req-quick button').allInnerTexts()).map(t => t.trim());
    await assert(JSON.stringify(quickTexts) === JSON.stringify(['9,000원', '18,000원', '27,000원']), `the customer quick amounts must match the usage modal (got ${JSON.stringify(quickTexts)})`);
    // 입력 노드 유실 금지(beta.20에서 배운 것) — 빠른 금액도, 타이핑도 입력창을 갈아치우면 안 된다.
    await page.evaluate(() => { document.querySelector('#custAmountInput').__bapProbe = 'alive'; });
    await page.locator('[data-a="cust-amt-quick"][data-amount="9000"]').click();
    await page.waitForTimeout(120);
    const quickState = await page.evaluate(() => {
      const el = document.querySelector('#custAmountInput');
      return { same: !!el && el.__bapProbe === 'alive', value: el ? el.value : null };
    });
    await assert(quickState.same, 'tapping a quick amount must not replace the amount input node (the phone keypad would close)');
    await assert(quickState.value === '9000', `the quick amount must land in the input (got ${JSON.stringify(quickState.value)})`);
    // beta.44(사용자 확정): 잔액 줄은 **현재 잔액 고정**이다 — 금액을 넣어도 숫자가 줄지 않는다.
    //   줄어드는 숫자를 보여주면 손님은 "이미 빠져나갔다"로 읽는다. 차감은 사장님이 저장할 때 한 번뿐이다.
    await assert((await page.locator('#custAmtBal').innerText()).trim() === '잔액 30,000원이 남아있어요', 'the balance line must stay on the CURRENT balance while the customer types an amount');
    await assert((await page.locator('#custAmtErr').innerText()).trim() === '', 'a valid amount must raise no error');
    // 요청은 아직 아무것도 아니다 — 이 시점에 저장소가 건드려졌다면 설계가 무너진 것이다.
    const composeDb = await readDb(page);
    await assert(!JSON.stringify(composeDb).includes('custAmount') && !JSON.stringify(composeDb).includes('pendingAmount'), 'a half-written request must never reach IndexedDB');

    // 손님이 넣은 금액이 확인되는 자리는 입력칸이다(큰 숫자를 없앤 뒤의 유일한 자리).
    await assert((await page.locator('#custAmountInput').inputValue()) === '9000', 'the amount the customer typed must remain visible in the input field, right above the canvas they sign on');
    await drawOn('.cust-sig #signCanvas');
    const submitLabel = (await page.locator('[data-a="cust-sign-submit"]').innerText()).trim();
    await assert(submitLabel === '사장님 확인 받기', `the request must be handed over with the [사장님 확인 받기] label (got ${JSON.stringify(submitLabel)})`);
    const txBeforeReq = await txCount();
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');

    // "사장님 확인" 화면 — 사장님이 PIN을 누르기 **전에** 대상·금액·서명을 눈으로 검증할 수 있어야 한다.
    await assert((await page.locator('.pin-title').innerText()).trim() === '사장님 확인', 'a B-stage request must land on the 사장님 확인 screen');
    await assert((await page.locator('.pin-sub').innerText()).includes('김요청'), 'the 사장님 확인 screen must still name the customer');
    await assert((await page.locator('.pin-req-label').innerText()).includes('손님이 입력한 금액'), 'the amount must be labelled as the CUSTOMER\'s number — an unlabelled figure reads as "the app decided this" and turns the owner\'s check into a formality');
    await assert((await page.locator('.pin-req-amt').innerText()).trim() === '9,000원', 'the requested amount must be shown on the 사장님 확인 screen');
    // 금액이 화면에서 가장 커야 한다(사장님이 읽어야 하는 것은 이름이 아니라 금액이다).
    const reqFonts = await page.evaluate(() => ({
      amt: parseFloat(getComputedStyle(document.querySelector('.pin-req-amt')).fontSize),
      title: parseFloat(getComputedStyle(document.querySelector('.pin-title')).fontSize),
      sub: parseFloat(getComputedStyle(document.querySelector('.pin-sub')).fontSize)
    }));
    await assert(reqFonts.amt > reqFonts.title && reqFonts.amt > reqFonts.sub, `the requested amount must be the biggest thing on the 사장님 확인 screen (amt ${reqFonts.amt} vs title ${reqFonts.title})`);
    const custSignSrc = await page.locator('.pin-req-sign img').getAttribute('src');
    await assert(String(custSignSrc || '').startsWith('data:image/'), 'the 사장님 확인 screen must show the signature the customer just drew');
    const reqState = await lockSt2();
    await assert(reqState.pendingAmount === 9000, `the request must carry the amount (got ${reqState.pendingAmount})`);
    await assert(reqState.pendingSignLen > 200, `the request must carry the signature (got ${reqState.pendingSignLen} chars)`);
    await assert(reqState.custAmount === '', 'handing the request over must clear the compose buffer (nothing may linger on the customer side)');
    await assert(reqState.signPadLive === false, 'handing the request over must detach the signature canvas — a live signPad on the customer side is a signature nobody is watching');
    await assert(await txCount() === txBeforeReq, 'building a request must not write a single ledger row');

    // (i) 요청은 IndexedDB 어디에도 없다 — 대상·금액·서명 전부.
    const reqDbRaw = JSON.stringify(await readDb(page));
    await assert(!reqDbRaw.includes('pendingCustomer') && !reqDbRaw.includes('pendingAmount') && !reqDbRaw.includes('pendingSign'), 'a live request must never be written to IndexedDB');
    await assert(!reqDbRaw.includes(String(custSignSrc).slice(0, 64)), 'the requested signature must not exist anywhere in IndexedDB before the owner saves');

    // PIN → 사용 모달이 금액·서명과 함께 열린다.
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    await assert((await page.locator('#useAmount').inputValue()) === '9000', 'the usage modal must prefill the amount the customer requested');
    await assert(await page.locator('#useAmount').isEditable(), 'the prefilled amount must stay editable — the owner is still the one who decides');
    await assert((await page.locator('.modal .receipt').innerText()).includes('손님이 입력한 금액'), 'the usage modal must name the source of the prefilled figure');
    const modalSignSrc = await page.locator('#usePreSign').getAttribute('src');
    await assert(modalSignSrc === custSignSrc, 'the signature must arrive at the owner byte-for-byte identical to what the customer drew');
    await assert(await count(page, '#signCanvas') === 0, 'a prefilled signature must replace the blank canvas (re-signing is a deliberate act, not the default)');
    await assert(await count(page, '[data-a="use-resign"]') === 1, 'the owner must always be able to take a fresh signature');
    // beta.44(사용자 지시): [저장]이 서명 바로 아래 첫 버튼이고, [서명 다시 받기]는 그 아래(예외 경로)다.
    //   버튼 묶음의 DOM 순서는 [… 취소 · 서명 다시 받기 · 저장] — 폰(≤640px)의 column-reverse가 이것을
    //   화면에서 저장 → 서명 다시 받기 → 취소로 뒤집는다(기하 검증은 responsive 하니스가 맡는다).
    const actionOrder = await page.evaluate(() => Array.from(document.querySelectorAll('.modal .modal-actions button')).map(b => b.dataset.a));
    await assert(actionOrder[actionOrder.length - 1] === 'save-use', `[저장] must be the last button in DOM order (got ${JSON.stringify(actionOrder)})`);
    await assert(actionOrder[actionOrder.length - 2] === 'use-resign', `[서명 다시 받기] must sit directly before [저장] in DOM order (got ${JSON.stringify(actionOrder)})`);
    await assert(await page.evaluate(() => !document.querySelector('.modal .form [data-a="use-resign"]')), 'the resign button must no longer live inside the signature field — it moved into the button group under [저장]');

    const dialogsBeforeSave = dialogs.length;
    await page.locator('[data-a="save-use"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 6000 });
    // beta.43: 손님 요청 금액을 **그대로** 저장할 때는 저장 직전 confirm을 띄우지 않는다(사용자 지시).
    //   사장님은 직전 "사장님 확인" 화면에서 같은 금액을 최대 크기로 보고 PIN까지 넣었다 — 같은 숫자를
    //   한 번 더 묻는 것은 확인이 아니라 절차 지연이다. 확인창이 남는 경로는 (n-2)에서 따로 검증한다.
    const saveConfirm = dialogs.slice(dialogsBeforeSave).find(d => d.type === 'confirm' && d.message.includes('저장하시겠습니까'));
    await assert(!saveConfirm, `saving a request at the requested amount must not ask again (got ${JSON.stringify(saveConfirm && saveConfirm.message)})`);
    // beta.44(사용자 지시): 저장 뒤 "✅ 저장 완료 … 증표를 보여줄까요?" 확인창도 없다 — 증표 화면이 곧바로
    //   열리고, 그 화면에 이름·잔액이 다 있으므로 확인창이 새로 알려 주는 것이 없었다(탭만 한 번 더 들었다).
    const postSaveDialogs = dialogs.slice(dialogsBeforeSave);
    await assert(!postSaveDialogs.some(d => d.message.includes('증표') || d.message.includes('저장 완료')), `the receipt must open by itself, with no confirm in front of it (got ${JSON.stringify(postSaveDialogs.map(d => d.message))})`);
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
    await page.waitForTimeout(150);
    await homeAfterReqReceipt();

    const happyDb = await readDb(page);
    await assert(happyDb.transactions.length === txBeforeReq + 1, `the B flow must record exactly one transaction (got ${happyDb.transactions.length - txBeforeReq})`);
    await assert(balanceOfId(happyDb, 'br-1') === 21000, `the ledger balance must be exact (30,000 - 9,000, got ${balanceOfId(happyDb, 'br-1')})`);
    const savedTx = happyDb.transactions.find(t => t.employeeId === 'br-1' && t.type === 'use');
    await assert(savedTx.amount === 9000 && savedTx.beforeBalance === 30000 && savedTx.afterBalance === 21000, 'the recorded row must carry the exact amount and both balances');
    await assert(savedTx.signatureData === custSignSrc, 'the stored signature must be the very image the customer drew (customer → owner → ledger, unchanged)');
    await checkSigPng(page, savedTx.signatureData, 'customer compose signature');
    // 요청 금액과 저장 금액이 **같을 때도** 요청 금액을 이력에 남긴다 — "달랐을 때만" 남기면
    //   흔적이 있는 행과 없는 행을 구분할 수 없어 대조 자체가 성립하지 않는다.
    await assert(String(savedTx.note || '').includes('손님 요청 금액 9,000원'), `a request-driven row must record the requested amount even when it matches (got note=${JSON.stringify(savedTx.note)})`);
    const wantHash = crypto.createHash('sha256').update(savedTx.signatureData).digest('hex');
    await assert(savedTx.signatureHash === wantHash, 'the signature hash must be the SHA-256 of the stored signature');
    // 요청은 저장과 동시에 완전히 사라진다.
    const afterSaveState = await lockSt2();
    await assert(afterSaveState.pendingAmount === 0 && afterSaveState.pendingSignLen === 0 && afterSaveState.pendingCustomerId === '', 'saving must leave no trace of the request behind');

    // (n) 서명은 이력의 썸네일과 [서명 확인] 창에서도 그대로 보여야 한다.
    await page.locator('[data-a="screen"][data-screen="history"]').click();
    await page.waitForSelector('.txn');
    const thumbSrc = await page.locator('.txn img.thumb').first().getAttribute('src');
    await assert(thumbSrc === custSignSrc, 'the history thumbnail must render the same signature');
    await page.locator('.txn img.thumb').first().click();
    await page.waitForSelector('.modal img');
    await assert((await page.locator('.modal img').getAttribute('src')) === custSignSrc, 'the [서명 확인] window must render the same signature');
    await assert((await page.locator('.modal .help').innerText()).includes('9,000원'), 'the signature window must show the amount it belongs to');
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(120);
    // 증표(잔액 명함)도 저장 뒤 정상적으로 열려야 한다.
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await expandHomeGroups(page);
    await page.locator('[data-a="receipt"][data-id="br-1"]').click();
    await page.waitForSelector('.receipt-modal');
    await assert((await page.locator('.receipt-modal').innerText()).includes('21,000원'), 'the balance receipt must show the post-request balance');
    await assert(await count(page, '.receipt-warn') === 0, 'a request-driven deduction must leave the ledger verifiable (no integrity warning on the receipt)');
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
    await page.waitForTimeout(120);

    // ── (B-b) 사장님이 금액을 고치면 손님 서명은 그 자리에서 무효가 된다 ──
    //   손님은 "자기가 적은 금액"에 서명했다. 사장님이 그 금액을 고치는 순간, 남아 있는 서명은
    //   **다른 금액의 증거**가 된다 — 나중에 다투면 그 서명은 사장님이 아니라 손님 편에 선다
    //   ("나는 9,000원에 서명했다"). 그래서 금액이 요청과 달라지면 저장을 멈추고 서명을 다시 받는다.
    //   ⚠️ 이 절은 옛 계약("금액을 고쳐도 서명은 잃지 않는다")을 **대체**한다. 되돌리지 말 것.
    await composeTo('김요청', '9000');
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    const beforeEditCount = await txCount();
    const beforeEditDb = await readDb(page);
    const reqSignSrc = await page.locator('#usePreSign').getAttribute('src');
    await page.locator('#useAmount').fill('12345');
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(400);
    // ① 저장은 일어나지 않는다 — 원장은 바이트 단위로 그대로다.
    const blockedDb = await readDb(page);
    await assert(JSON.stringify(blockedDb.transactions) === JSON.stringify(beforeEditDb.transactions), 'changing the requested amount must not save anything until a fresh signature is taken');
    await assert(await count(page, '.receipt-modal') === 0, 'the mismatched save must not reach the receipt');
    // ② 손님 서명은 사라지고 빈 캔버스가 그 자리에 온다 + 이유가 화면에 적힌다.
    await assert(await count(page, '#usePreSign') === 0, "the customer's signature must be voided the moment the amount stops matching it");
    await assert(await count(page, '#signCanvas') === 1, 'voiding the signature must put a blank canvas in its place (re-signing must be possible right there)');
    const resignNotice = await page.locator('.modal').innerText();
    await assert(resignNotice.includes('금액이 손님 요청과 달라') && resignNotice.includes('서명을 다시'), `the modal must say in plain words why the signature is gone (got ${JSON.stringify(resignNotice.slice(0, 300))})`);
    // ③ 사장님이 고친 금액은 그대로 살아 있다 — 재렌더가 요청 금액으로 되돌리면 안 된다.
    await assert((await page.locator('#useAmount').inputValue()) === '12345', "voiding the signature must not roll the owner's amount back to the requested one");
    // ④ 서명 없이 다시 눌러도 저장되지 않는다.
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(300);
    await assert(JSON.stringify((await readDb(page)).transactions) === JSON.stringify(beforeEditDb.transactions), 'an empty canvas must still count as no signature');
    // ⑤ 새 서명을 받으면 그때 저장된다.
    await drawOn('#signCanvas');
    await page.locator('[data-a="save-use"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 6000 });
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
    await page.waitForTimeout(150);
    await homeAfterReqReceipt();
    const editedDb = await readDb(page);
    await assert(editedDb.transactions.length === beforeEditCount + 1, 'editing the prefilled amount must still record exactly one row');
    await assert(balanceOfId(editedDb, 'br-1') === 21000 - 12345, `the owner's edited amount must be what lands in the ledger (got ${balanceOfId(editedDb, 'br-1')})`);
    const editedTx = editedDb.transactions.filter(t => t.employeeId === 'br-1' && t.type === 'use').sort((a, b) => b.createdAt - a.createdAt)[0];
    await assert(editedTx.amount === 12345, `the edited amount must override the requested one (got ${editedTx.amount})`);
    await assert(String(editedTx.signatureData || '').startsWith('data:image/'), 'the stored row must carry the fresh signature');
    await assert(editedTx.signatureData !== reqSignSrc, "the stored signature must be the NEW one — the customer's signature for 9,000원 must never sit under a 12,345원 row");
    // ⑥ 요청 금액은 이력에 흔적으로 남는다 — 나중에 대조할 기준이 없으면 무효화 규칙도 증명할 수 없다.
    await assert(String(editedTx.note || '').includes('손님 요청 금액 9,000원'), `the row must record what the customer had asked for (got note=${JSON.stringify(editedTx.note)})`);

    // ── (B-c) 사장님이 모달을 닫으면 요청은 폐기된다(원장 불변·재생 불가) ──
    const beforeCancel = await readDb(page);
    await composeTo('김요청', '5000');
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    const afterCancelDb = await readDb(page);
    await assert(JSON.stringify(afterCancelDb.transactions) === JSON.stringify(beforeCancel.transactions), 'closing the usage modal must leave the ledger byte-identical');
    const cancelState = await lockSt2();
    await assert(cancelState.pendingAmount === 0 && cancelState.pendingSignLen === 0, 'closing the modal must discard the request (no second chance to save it)');
    // 요청이 되살아나지 않는지 — 다시 잠그고 풀어도 모달이 열리면 안 된다.
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('.cust-screen');
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await assert(await count(page, '#useAmount') === 0, 'a discarded request must never re-open the usage modal on the next unlock');

    // ── (B-d) 잔액 초과 요청 차단 ──
    await composeTo('최소액', '2000');   // 잔액 1,000원
    await assert((await page.locator('#custAmtErr').innerText()).includes('잔액보다 많아요'), 'an over-balance amount must say so in the customer\'s own words');
    // beta.48(사용자 지시): "사장님께 말씀해 주세요"만으로는 손님이 무엇을 고쳐야 하는지 모른다 —
    //   얼마까지 되는지(잔액)를 그 자리에서 말한다.
    await assert((await page.locator('#custAmtErr').innerText()).includes('1,000원'),
      `the over-balance notice must name the amount the customer can actually spend (got ${JSON.stringify(await page.locator('#custAmtErr').innerText())})`);
    // beta.22: 넘어갈 '다음 화면'이 없으므로 차단은 제출 지점에서 일어난다 — 요청 자체가 세워지지 않는다.
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(200);
    await assert((await lockSt2()).pendingCustomerId === '', 'an over-balance amount must not become a request even when the signature is there');
    await assert(await count(page, '#custAmountInput') === 1, 'the blocked customer must stay on the request screen');
    // ── beta.48(사용자 지시): 막혔다는 사실을 **버튼 바로 위에서도** 말한다 ─────────────────
    //   손님의 시선·손가락은 [사장님 확인 받기]에 가 있는데, 예전에는 그 슬롯을 오히려 비웠다
    //   → "눌러도 아무 일이 없는 버튼"으로 읽혔다(현장 보고). 입력칸 테두리까지 빨개져 고칠 곳을 가리킨다.
    const overState = await page.evaluate(() => ({
      top: document.querySelector('#custAmtErr').innerText.trim(),
      bottom: document.querySelector('#custSignErr').innerText.trim(),
      inputErr: document.querySelector('#custAmountInput').classList.contains('err')
    }));
    await assert(overState.bottom.includes('잔액보다 많아요') && overState.bottom === overState.top,
      `an over-balance submit must repeat the same notice right above the button (got ${JSON.stringify(overState)})`);
    await assert(overState.bottom.includes('1,000원'), 'the notice above the button must also name the spendable balance');
    await assert(overState.inputErr, 'an over-balance amount must mark the input itself with the danger border');
    // 금액을 고치면 두 줄과 빨간 테두리가 그 자리에서 함께 걷힌다(부분 갱신 — 전체 render 금지 구간).
    await page.locator('#custAmountInput').fill('900');
    await page.waitForTimeout(150);
    const fixedState = await page.evaluate(() => ({
      top: document.querySelector('#custAmtErr').innerText.trim(),
      bottom: document.querySelector('#custSignErr').innerText.trim(),
      inputErr: document.querySelector('#custAmountInput').classList.contains('err'),
      empty: window.__prepaidTestHooks.lockState().signPadEmpty
    }));
    await assert(fixedState.top === '' && fixedState.bottom === '' && !fixedState.inputErr,
      `fixing the amount must clear both notices and the danger border (got ${JSON.stringify(fixedState)})`);
    await assert(fixedState.empty === false, 'clearing the notices must not cost the customer the signature already drawn');
    await assert((await lockSt2()).signPadEmpty === false, 'the over-balance block must not cost the customer the signature already drawn');
    await page.locator('[data-a="cust-sign-clear"]').click();
    await page.waitForTimeout(100);
    // 경계: 잔액과 정확히 같은 금액은 통과해야 한다(1원 차이로 막으면 "다 쓰기"가 불가능해진다).
    await page.locator('#custAmountInput').fill('1000');
    await page.waitForTimeout(120);
    await assert((await page.locator('#custAmtErr').innerText()).trim() === '', 'spending exactly the whole balance must be allowed');
    await assert((await page.locator('#custAmtBal').innerText()).includes('1,000원'), 'the balance line stays on the current balance even when the customer spends all of it');
    await page.locator('#custAmountInput').fill('1001');
    await page.waitForTimeout(120);
    await assert((await page.locator('#custAmtErr').innerText()).includes('잔액보다 많아요'), 'one won over the balance must already be blocked');

    // ── (B-e) 0 · 음수 · 소수 · 문자 입력 차단 ──
    // 0x·1e·0b·0o는 Number()가 조용히 숫자로 바꿔주는 표기다 — 화면에 적힌 글자와 전혀 다른 금액이 된다
    //   ('0x2710' → 10000원). 전각 숫자도 마찬가지로 "숫자처럼 보이는 것"이다. 돈 파서는 전부 거절해야 한다.
    // beta.44: 큰 숫자가 없어졌으니 "메아리치지 않는다"의 관측 지점은 잔액 한 줄이다 — 어떤 쓰레기 표기도
    //   이 줄을 흔들지 못해야 한다(흔들린다면 파서가 그것을 숫자로 받아들였다는 뜻이다).
    const balBeforeBad = (await page.locator('#custAmtBal').innerText()).trim();
    for (const [bad, why] of [['0', 'zero'], ['-100', 'a negative amount'], ['9000.5', 'a fractional amount'], ['abc', 'letters'], ['9-0', 'a mangled number'],
    ['0x2710', 'a hex literal'], ['1e4', 'an exponent literal'], ['0b11', 'a binary literal'], ['0o17', 'an octal literal'], ['１２３', 'full-width digits'], ['Infinity', 'Infinity']]) {
      await page.locator('#custAmountInput').fill(bad);
      await page.waitForTimeout(100);
      const err = (await page.locator('#custAmtErr').innerText()).trim();
      await assert(err.length > 0, `${why} ("${bad}") must raise a visible error`);
      // 서명까지 마친 상태로 제출해도 통과하지 않는다(요청이 세워지지 않는다).
      await drawOn('.cust-sig #signCanvas');
      await page.locator('[data-a="cust-sign-submit"]').click();
      await page.waitForTimeout(120);
      await assert((await lockSt2()).pendingCustomerId === '', `${why} ("${bad}") must never become a request`);
      await assert(await count(page, '#custAmountInput') === 1, `${why} ("${bad}") must leave the customer on the request screen`);
      await assert((await page.locator('#custAmtBal').innerText()).trim() === balBeforeBad, `${why} ("${bad}") must never be echoed as a real amount`);
      await page.locator('[data-a="cust-sign-clear"]').click();
      await page.waitForTimeout(80);
    }
    // 빈 칸으로 제출해도 넘어가지 않는다.
    await page.locator('#custAmountInput').fill('');
    await page.waitForTimeout(100);
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(120);
    await assert((await lockSt2()).pendingCustomerId === '', 'an empty amount must never become a request');
    await assert((await page.locator('#custAmtErr').innerText()).trim().length > 0, 'an empty amount must say what is missing');

    // ── (B-f) 서명 없이 진행 불가 ──
    await page.locator('#custAmountInput').fill('500');
    await page.waitForTimeout(100);
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(200);
    await assert(await count(page, '.cust-sig #signCanvas') === 1, 'submitting without a signature must keep the customer on the request screen');
    await assert((await page.locator('#custSignErr').innerText()).includes('서명'), 'submitting without a signature must say a signature is needed');
    await assert((await lockSt2()).pendingCustomerId === '', 'submitting without a signature must not create a request');
    await assert((await page.locator('#custAmountInput').inputValue()) === '500', 'the missing-signature notice must not cost the amount already typed');
    // [지우고 다시] 뒤에도 마찬가지다 — 지운 서명은 서명이 아니다.
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-clear"]').click();
    await page.waitForTimeout(120);
    await assert(await count(page, '.cust-sig #signCanvas') === 1, '[지우고 다시] must not tear the canvas down (a re-render would wipe the amount too)');
    await assert((await page.locator('#custAmountInput').inputValue()) === '500', '[지우고 다시] must clear only the signature — the amount must stay');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(200);
    await assert((await lockSt2()).pendingCustomerId === '', 'a cleared signature must count as no signature');
    // [처음으로]는 한 번에 검색 화면으로 — 금액과 서명을 함께 버린다(중간에 머무를 화면이 없다).
    await drawOn('.cust-sig #signCanvas');
    await page.locator('.cust-actions [data-a="cust-back"]').click();
    await page.waitForSelector('#custSearchInput');
    const backState2 = await lockSt2();
    await assert(backState2.custAmount === '' && backState2.signPadLive === false, '[처음으로] must discard the draft amount and the signature together');
    await assert(await count(page, '#custAmountInput') === 0 && await count(page, '#signCanvas') === 0, '[처음으로] must leave neither the amount field nor the canvas behind');

    // ── (g) 요청 작성 중 유휴 60초(custComposeIdle) — 조회 화면의 30초보다 길다 ──
    //   프로덕션 값은 index.html의 TIMERS에 그대로 남는다(아래에서 소스로 못 박는다). 여기서는 축척한다.
    //   ⚠️ 화면까지 가는 길은 넉넉한 시계로 걷고, 도착한 뒤에 눈금을 줄인다. 줄이는 것만으로는 이미 걸린
    //     타이머가 바뀌지 않으므로(armIdle은 조작에서만 다시 걸린다) 탭을 한 번 줘서 새 눈금으로 재무장시킨다.
    const rearm = async (selector) => { await page.locator(selector).click(); await page.waitForTimeout(60); };
    await composeTo('김요청', '1000');
    await setTimers({ custIdle: 400, custComposeIdle: 1600 });
    await rearm('#custAmountInput');
    await page.waitForTimeout(900);   // custIdle(400)의 2배 — 여기서 튀면 작성 중 화면이 사라진 것이다
    await assert(await count(page, '#custAmountInput') === 1, 'the request screen must NOT bounce back at the lookup-idle (30s) mark — the customer is still choosing');
    await assert((await page.locator('#custAmountInput').inputValue()) === '1000', 'the typed amount must survive the 30s mark');
    await page.waitForTimeout(1400);  // 누계 2300ms > custComposeIdle 1600
    await assert(await count(page, '#custSearchInput') === 1, 'an abandoned request screen must fall back to the empty customer search at the 60s mark');
    const afterComposeIdle = await lockSt2();
    await assert(afterComposeIdle.custAmount === '' && afterComposeIdle.custStage === 'search', 'the compose idle fallback must discard everything the customer had written');
    await assert((await bt()).locked === true, 'the compose idle fallback must never unlock the app');
    // 서명을 그리는 중에도 같은 시계다(같은 화면이므로 시계도 하나다).
    await setTimers({ custIdle: 30000, custComposeIdle: 60000 });
    await composeTo('김요청', '1000');
    await setTimers({ custIdle: 400, custComposeIdle: 1600 });
    await rearm('#custAmtBal');
    await page.waitForTimeout(900);
    await assert(await count(page, '.cust-sig #signCanvas') === 1, 'the request screen must also hold past the 30s mark while the customer is signing');
    // 서명을 그리는 동작(pointermove/touchmove)만으로도 시계가 다시 무장돼야 한다 —
    //   전역 캡처 리스너에는 그리는 이벤트가 잡히지 않아서, 이게 없으면 서명 도중에 화면이 튄다.
    for (let i = 0; i < 4; i += 1) {
      await drawOn('.cust-sig #signCanvas');
      await page.waitForTimeout(700);
    }
    await assert(await count(page, '.cust-sig #signCanvas') === 1, 'drawing must re-arm the idle clock — a slow signature must never be interrupted by the screen resetting');
    await page.waitForTimeout(2200);
    await assert(await count(page, '#custSearchInput') === 1, 'an abandoned request screen must still fall back once the drawing stops');
    const afterSignIdle = await lockSt2();
    await assert(afterSignIdle.signPadLive === false, 'the idle fallback must detach the signature canvas — the drawing must be unreachable, not merely off-screen');
    await assert(afterSignIdle.pendingSignLen === 0 && afterSignIdle.custAmount === '', 'the idle fallback must discard the drawn signature and the amount together');
    await assert(await count(page, '#signCanvas') === 0, 'the idle fallback must tear the signature canvas out of the DOM');
    await setTimers({ custIdle: 30000, custComposeIdle: 60000 });

    // ── (g-2) 초안을 든 채 상세 화면으로 — 시계는 화면이 아니라 **초안**을 따라간다 (beta.25 HIGH-2) ──
    //   상세 화면은 손님에게 "적어 둔 금액은 그대로 있어요"라고 글로 약속한다. 그런데 beta.24의 유휴
    //   선택은 stage==='compose'만 보았다 → 그 화면에서는 조회용 30초가 걸렸고, 어르신이 지난 내역을
    //   30초 넘게 들여다보는 동안 약속한 금액이 소리 없이 사라졌다(화면의 말과 코드의 행동이 어긋난 자리).
    //   반대쪽 위험도 함께 못 박는다 — 초안을 들었다고 시계가 멈추면 앞 손님의 금액이 다음 손님까지 남는다.
    await composeTo('김요청', '3000');
    await openHistory();
    await setTimers({ custIdle: 400, custComposeIdle: 1600 });
    await rearm('.cust-bal');
    await page.waitForTimeout(900);   // custIdle(400)의 2배 — 30초 지점
    let draftIdle = await lockSt2();
    await assert(draftIdle.custStage === 'self' && draftIdle.custAmount === '3000',
      `a draft carried into the history screen must survive the 30s lookup-idle mark — the screen literally promises the amount is still there (got stage=${draftIdle.custStage} amount=${JSON.stringify(draftIdle.custAmount)})`);
    await assert(await count(page, '.cust-bal') === 1, 'the history screen must still be up at the 30s mark while a draft is being held');
    await page.waitForTimeout(1400);  // 누계 2300ms > custComposeIdle 1600
    await assert(await count(page, '#custSearchInput') === 1, 'a held draft must still expire at the 60s compose mark — carrying a draft must not make the screen immortal');
    draftIdle = await lockSt2();
    await assert(draftIdle.custAmount === '' && draftIdle.custStage === 'search', 'the draft-idle fallback must discard the amount exactly like the compose fallback');
    await assert((await bt()).locked === true, 'the draft-idle fallback must never unlock the app');
    await setTimers({ custIdle: 30000, custComposeIdle: 60000 });

    // ── (h) TTL 경계 119 / 121 ──
    //   프로덕션 상수는 소스에 그대로 못 박고(120초), 경계 동작은 같은 비교식을 축척(10초)으로 확인한다.
    //   119/120 지점에서 살아 있고 121/120 지점에서 죽어야 한다 — 두 판정(handoffEmp·takePendingCustomer)이
    //   같은 식을 써야만 화면과 잠금 해제가 어긋나지 않는다.
    const srcForTtl = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
    await assert(/pendingTtl:120000/.test(srcForTtl), 'the production handover TTL must stay 120 seconds');
    await assert(/custComposeIdle:60000/.test(srcForTtl), 'the production compose idle must stay 60 seconds');
    await assert(/custIdle:30000/.test(srcForTtl), 'the production lookup idle must stay 30 seconds');
    await assert((srcForTtl.match(/now\(\)-at>TIMERS\.pendingTtl/g) || []).length === 2, 'the screen and the unlock path must judge expiry with the very same expression');
    const TTL = 10000;
    await setTimers({ pendingTtl: TTL });
    // 요청을 넘긴 시각을 기준으로 나이를 잰다. 4자리 중 3자리를 미리 눌러 두고 마지막 한 자리만 경계에서 누른다
    //   (잠금 해제 클릭 4번의 지연이 경계 판정에 섞이지 않게 하기 위함).
    const ttlProbe = async (ageMs) => {
      await composeTo('박두번', '3000');
      await drawOn('.cust-sig #signCanvas');
      const t0 = Date.now();
      await page.locator('[data-a="cust-sign-submit"]').click();
      await page.waitForSelector('.pin-screen [data-a="pin-key"]');
      await waitPinGuard(page);// beta.55(C3): 진입 직후 0.5초 숫자판 무시 — 지난 뒤에 누른다(TTL 경계 계산은 t0 기준이라 그대로다)
      for (const k of ['1', '2', '3']) await page.locator(`[data-a="pin-key"][data-key="${k}"]`).click();
      const wait = ageMs - (Date.now() - t0) - 40;
      if (wait > 0) await page.waitForTimeout(wait);
      await page.locator('[data-a="pin-key"][data-key="4"]').click();
      // PBKDF2 검증(beta.31)이 끝나 잠금이 풀릴 때까지 기다린다 — 고정 대기는 기기 속도에 따라 흔들린다.
      await page.waitForFunction(() => !window.__prepaidTestHooks.lockState().locked, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(300);
      return await count(page, '#useAmount') === 1;
    };
    await assert(await ttlProbe(Math.round(TTL * 119 / 120)) === true, 'a request at 119/120 of the TTL must still open the usage modal (an early expiry silently kills real handovers)');
    await assert((await page.locator('#useAmount').inputValue()) === '3000', 'the request that survived the boundary must still carry its amount');
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await assert(await ttlProbe(Math.round(TTL * 121 / 120)) === false, 'a request past 121/120 of the TTL must be dropped');
    await assert((await page.locator('.toast').innerText().catch(() => '')).includes('만료'), 'an expired B request must tell the owner why nothing opened');
    await setTimers({ pendingTtl: 120000 });

    // ── (j) 잠금 상태 전 액션 스윕 — 통합 요청 화면(서명 전·서명 후)에서도 원장 바이트는 그대로다 ──
    //   허용 목록 밖은 게이트가 통째로 막고, 허용 목록 안(손님 액션)은 애초에 원장에 닿지 않는다.
    for (const [stage, enter] of [
      ['요청(서명 전)', async () => { await composeTo('김요청', '7000'); }],
      ['요청(서명 후)', async () => { await composeTo('김요청', '7000'); await drawOn('.cust-sig #signCanvas'); }]
    ]) {
      await enter();
      const sweepBefore = await readDb(page);
      const sweepDialogs = dialogs.length;
      const fired = await page.evaluate(() => {
        const keys = window.__prepaidTestHooks.clickActionKeys();
        keys.forEach(k => {
          const b = document.createElement('button');
          Object.assign(b.dataset, { a: k, id: 'br-1', sid: 'sid', key: '1', screen: 'settings', dept: 'X', ctx: 'settings', tab: 'employee', amount: '9000', g: 'g', idx: '0' });
          document.body.appendChild(b);
          b.click();
          b.remove();
        });
        return keys.length;
      });
      await page.waitForTimeout(900);
      await assert(fired >= 45, `${stage} 화면 sweep must fire every action in the map (fired ${fired})`);
      const sweepAfter = await readDb(page);
      await assert(JSON.stringify(sweepAfter.transactions) === JSON.stringify(sweepBefore.transactions), `no action fired on the ${stage} screen may touch the ledger`);
      await assert(JSON.stringify(sweepAfter.employees) === JSON.stringify(sweepBefore.employees), `no action fired on the ${stage} screen may touch the employee store`);
      await assert(dialogs.length === sweepDialogs, `no destructive confirm may open from the ${stage} screen`);
      await assert((await bt()).locked === true, `the ${stage} screen sweep must leave the app locked`);
      await assert(await count(page, '.nav') === 0 && await count(page, '.modal-back') === 0, `the ${stage} screen sweep must not open any owner screen or modal`);
      // 스윕이 화면을 어디로 옮겨 놨든(요청이 세워졌을 수도 있다) 다음 절을 위해 깨끗한 홈으로 되돌린다.
      await unlock();
      await page.waitForSelector('[data-a="quick-find-emp"]');
      if (await count(page, '.modal-back')) {
        await page.locator('.modal-actions [data-a="close-modal"]').first().click();
        await page.waitForTimeout(150);
      }
    }

    // ── (k) 새 손님이 오면 앞 손님의 요청은 즉시 폐기된다(대상·금액·서명 전부) ──
    await composeTo('김요청', '1000');
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert((await lockSt2()).pendingAmount === 1000, 'the first customer\'s request must be alive before the second arrives');
    // 앞 손님이 그냥 가 버리고 뒷 손님이 [처음으로]를 눌러 자기 이름을 친다.
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');
    const afterHandBack = await lockSt2();
    await assert(afterHandBack.pendingAmount === 0 && afterHandBack.pendingSignLen === 0, '[처음으로] must discard the amount and the signature too, not just the target');
    await custLookup('박두번');
    await page.waitForSelector('#custAmountInput');
    await assert((await page.locator('#custAmountInput').inputValue()) === '', 'the new customer must start from an empty amount');
    await page.locator('#custAmountInput').fill('4000');
    await page.waitForTimeout(100);
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await assert((await page.locator('.pin-sub').innerText()).includes('박두번'), 'the 사장님 확인 screen must name the customer who is standing there now');
    await assert((await page.locator('.pin-req-amt').innerText()).trim() === '4,000원', 'the request shown must be the new customer\'s, never the previous one\'s');
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    await assert((await page.locator('.modal .receipt').innerText()).includes('박두번'), 'the usage modal must open for the new customer');
    await assert((await page.locator('#useAmount').inputValue()) === '4000', 'the usage modal must carry the new customer\'s amount, not the previous one\'s');
    // 검색창에 글자를 치는 것만으로도 앞 요청이 사라지는지(뿌리에서의 폐기).
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    await composeTo('김요청', '1000');
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await page.locator('[data-a="pin-to-cust"]').click();
    await page.waitForSelector('#custSearchInput');
    await page.locator('#custSearchInput').fill('최');
    await page.waitForTimeout(200);
    await assert((await lockSt2()).pendingAmount === 0, 'typing a new query must never resurrect a previous request');
    await assert((await lockSt2()).pendingSignLen === 0, 'typing a new query must drop the previous signature too');

    // ── (l) 같은 손님이 연달아 두 번 요청해도 중복 저장은 없다 ──
    await toCustomer();
    const beforeTwice = await txCount();
    const balBeforeTwice = balanceOfId(await readDb(page), 'br-2');
    for (const amt of ['1000', '2000']) {
      await custLookup('박두번');
      await page.waitForSelector('#custAmountInput');
      await page.locator('#custAmountInput').fill(amt);
      await page.waitForTimeout(100);
      await drawOn('.cust-sig #signCanvas');
      await page.locator('[data-a="cust-sign-submit"]').click();
      await page.waitForSelector('.pin-screen [data-a="pin-key"]');
      await unlock();
      await page.waitForSelector('#useAmount', { timeout: 6000 });
      await assert((await page.locator('#useAmount').inputValue()) === amt, `request #${amt} must prefill its own amount`);
      await page.locator('[data-a="save-use"]').click();
      await page.waitForSelector('.receipt-modal', { timeout: 6000 });
      await page.locator('.receipt-modal [data-a="receipt-close"]').click();
      await page.waitForTimeout(150);
      // beta.55(C6): 손님 요청 증표를 닫으면 곧바로 손님 화면이다 — [손님 셀프 조회]를 다시 누를 필요가 없다.
      await page.waitForSelector('.cust-screen');
      await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState().locked)) === true, 'the receipt of a customer request must close straight onto the locked customer screen');
    }
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');
    const twiceDb = await readDb(page);
    await assert(twiceDb.transactions.length === beforeTwice + 2, `two requests must produce exactly two rows (got ${twiceDb.transactions.length - beforeTwice})`);
    await assert(balanceOfId(twiceDb, 'br-2') === balBeforeTwice - 3000, `back-to-back requests must deduct 1,000 + 2,000 exactly once each (got ${balanceOfId(twiceDb, 'br-2')})`);

    // ── (m) 자동 잠금(90초)과 요청 작성 / 프리필 모달의 관계 ──
    //   작성 중에는 앱이 **이미 잠겨 있다** — 자동 잠금은 애초에 돌지 않고(canAutoLockBase가 !pinLocked를 본다)
    //   화면을 관리하는 시계는 오직 custComposeIdle이다. 그 사실을 명시적으로 못 박는다.
    //   모달 방치 상한은 **모달이 열리기 전에** 줄여 둔다 — armIdle은 조작에서만 다시 걸리므로
    //   모달을 연 뒤에 상수만 바꾸면 이미 걸린 10분짜리 타이머가 그대로 돈다.
    await setTimers({ autoLock: 400, custComposeIdle: 3000, custIdle: 3000, modalIdleCap: 3000 });
    await composeTo('김요청', '1000');
    await page.waitForTimeout(1200);   // autoLock(400)의 3배
    await assert(await count(page, '#custAmountInput') === 1, 'the auto-lock clock must not touch the compose screen — the app is already locked, and only custComposeIdle governs here');
    await assert((await bt()).locked === true, 'the compose screen must stay locked throughout');
    await drawOn('.cust-sig #signCanvas');
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    // 프리필 모달도 기존 사용 모달과 똑같이 다뤄진다: 90초로는 안 잠기고(작업 중), 방치 상한에서는 잠긴다.
    const beforeAutoLock = await readDb(page);
    await page.waitForTimeout(1400);
    await assert(await count(page, '#useAmount') === 1 && (await bt()).locked === false, 'an open prefilled modal must block the 90s auto-lock exactly like a hand-filled one');
    await page.waitForTimeout(2200);   // 누계 3600ms > modalIdleCap 3000
    await assert((await bt()).locked === true, 'a prefilled modal left untouched past the cap must eventually auto-lock');
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '.modal-back') === 0, 'the capped auto-lock must close the prefilled modal too');
    const afterAutoLock = await readDb(page);
    await assert(JSON.stringify(afterAutoLock.transactions) === JSON.stringify(beforeAutoLock.transactions), 'auto-locking over a prefilled modal must never save anything');
    await assert((await lockSt2()).pendingAmount === 0, 'auto-locking must leave no request behind');
    await setTimers({ custIdle: 30000, custComposeIdle: 60000, autoLock: 90000, pendingTtl: 120000, pinDelay: 60000, recoveryGate: 60000, modalIdleCap: 600000, ownerPinIdle: 120000, handoffPinIdle: 60000, pinKeyGuard: 500 });
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]');

    // ── (n) 모달 안에서 render가 돌아도 사장님이 고친 금액·비고는 절대 되돌아가지 않는다 ──
    //   뿌리는 하나였다: 사용 모달의 금액·비고가 **DOM에만** 있고 state에 없었다. state에 없는 값은
    //   재렌더에서 살아남지 못한다 → 사장님이 25,000원으로 고쳐 놓아도 render가 한 번 돌면 칸이 조용히
    //   손님 요청 금액으로 되돌아간다. 화면은 정합해 보이고(요청 금액이니까) 사장님은 그대로 저장한다.
    //   여기서 재는 것은 "돌아가지 않는다"이지 "보기 좋다"가 아니다 — 저장된 금액까지 따라간다.
    const openPrefilled = async (name, amountText) => {
      await composeTo(name, amountText);
      await drawOn('.cust-sig #signCanvas');
      await page.locator('[data-a="cust-sign-submit"]').click();
      await page.waitForSelector('.pin-screen [data-a="pin-key"]');
      await unlock();
      await page.waitForSelector('#useAmount', { timeout: 6000 });
    };
    const closePrefilled = async () => {
      if (await count(page, '.receipt-modal')) {
        await page.locator('.receipt-modal [data-a="receipt-close"]').click();
        await page.waitForTimeout(150);
        // beta.55(C6): 손님 요청 증표는 손님 화면(잠금)으로 닫힌다 — 다음 단계를 위해 잠금을 푼다.
        if (await page.evaluate(() => window.__prepaidTestHooks.lockState().locked)) await unlock();
      }
      if (await count(page, '.modal-back')) {
        await page.locator('.modal-actions [data-a="close-modal"]').first().click();
        await page.waitForTimeout(150);
      }
      await page.waitForSelector('[data-a="quick-find-emp"]');
    };

    // (n-1) [서명 다시 받기] — 모달 안에서 render를 부르는 대표 액션.
    await openPrefilled('박두번', '1000');
    await page.locator('#useAmount').fill('2000');
    await page.locator('#useNote').fill('저녁 특식 4인');
    await page.locator('[data-a="use-resign"]').click();
    await page.waitForSelector('#signCanvas');
    await assert((await page.locator('#useAmount').inputValue()) === '2000', "[서명 다시 받기] must not roll the owner's amount back to the customer's request");
    await assert((await page.locator('#useNote').inputValue()) === '저녁 특식 4인', '[서명 다시 받기] must not wipe the note the owner typed');
    await assert(await count(page, '#usePreSign') === 0, '[서명 다시 받기] must actually clear the pre-drawn signature');
    // 저장된 금액까지 따라가야 한다 — 화면만 맞고 원장이 다르면 아무것도 고친 게 아니다.
    const beforeResignSave = balanceOfId(await readDb(page), 'br-2');
    await drawOn('#signCanvas');
    await page.locator('[data-a="save-use"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 6000 });
    await closePrefilled();
    const resignDb = await readDb(page);
    const resignTx = resignDb.transactions.filter(t => t.employeeId === 'br-2' && t.type === 'use').sort((a, b) => b.createdAt - a.createdAt)[0];
    await assert(resignTx.amount === 2000, `the amount that survives on screen must be the amount that lands in the ledger (got ${resignTx.amount})`);
    await assert(balanceOfId(resignDb, 'br-2') === beforeResignSave - 2000, 'the ledger must move by the edited amount, not by the requested one');
    await assert(String(resignTx.note || '').includes('저녁 특식 4인'), `the owner's note must survive the re-render too (got ${JSON.stringify(resignTx.note)})`);
    await assert(String(resignTx.note || '').includes('손님 요청 금액 1,000원'), 'the row must still record what the customer had asked for');

    // (n-2) 네트워크가 끊겼다 붙는 것만으로 금액이 되돌아가면 안 된다.
    //   지하 주차장·와이파이 경계에서 online/offline은 몇 초에 한 번씩도 튄다. 사장님은 아무것도 누르지 않았다.
    await openPrefilled('박두번', '1000');
    await page.locator('#useAmount').fill('3000');
    await page.locator('#useNote').fill('점심 3인');
    for (const ev of ['offline', 'online', 'offline', 'online']) {
      await page.evaluate(name => { window.dispatchEvent(new Event(name)); }, ev);
      await page.waitForTimeout(120);
    }
    await assert(await count(page, '#useAmount') === 1, 'a network flap must not tear the open usage modal down');
    await assert((await page.locator('#useAmount').inputValue()) === '3000', "a network flap must not roll the owner's amount back to the customer's request");
    await assert((await page.locator('#useNote').inputValue()) === '점심 3인', 'a network flap must not wipe the note');
    await assert(await count(page, '#usePreSign') === 1, "a network flap must not disturb the customer's signature either");
    const beforeFlapSave = balanceOfId(await readDb(page), 'br-2');
    // 금액이 요청과 달라졌으니 (B-b)의 계약대로 서명을 다시 받아야 저장된다.
    await page.locator('[data-a="save-use"]').click();
    await page.waitForTimeout(400);
    await assert(await count(page, '#signCanvas') === 1, 'the mismatch rule must still fire after a network flap');
    await assert((await page.locator('#useAmount').inputValue()) === '3000', 'the amount must still be the edited one after the signature is voided');
    await drawOn('#signCanvas');
    // beta.43: **고친 금액**은 어느 큰 화면에도 뜬 적이 없다(손님 PIN 화면에는 요청 금액 1,000원이 떴다)
    //   → 요청 경로라도 저장 직전 확인창이 반드시 살아 있어야 한다. 금액·잔액 전후를 그대로 읽어 준다.
    const editedDialogsBefore = dialogs.length;
    await page.locator('[data-a="save-use"]').click();
    await page.waitForSelector('.receipt-modal', { timeout: 6000 });
    const editedConfirm = dialogs.slice(editedDialogsBefore).find(d => d.type === 'confirm' && d.message.includes('저장하시겠습니까'));
    await assert(Boolean(editedConfirm) && editedConfirm.message.includes('3,000원'),
      `an owner-edited amount must still be confirmed before it moves money (got ${JSON.stringify(editedConfirm && editedConfirm.message)})`);
    await closePrefilled();
    const flapDb = await readDb(page);
    await assert(balanceOfId(flapDb, 'br-2') === beforeFlapSave - 3000, `the saved amount must be the owner's 3,000원, not the requested 1,000원 (got ${balanceOfId(flapDb, 'br-2')})`);

    // (n-3) 손님이 금액을 치는 도중의 네트워크 튐 — 입력 노드도 포커스도 살아 있어야 한다.
    await toCustomer();
    await custLookup('박두번');
    await page.waitForSelector('#custAmountInput');
    await page.locator('#custAmountInput').click();
    await page.keyboard.type('4500');
    await page.waitForTimeout(120);
    await page.evaluate(() => { window.dispatchEvent(new Event('offline')); });
    await page.waitForTimeout(300);
    const flapCust = await page.evaluate(() => {
      const el = document.querySelector('#custAmountInput');
      return { value: el ? el.value : null, focused: !!el && document.activeElement === el };
    });
    await assert(flapCust.value === '4500', `a network flap must not wipe the amount the customer is typing (got ${JSON.stringify(flapCust.value)})`);
    await assert(flapCust.focused, 'a network flap must not steal focus from the amount input — the phone keypad would close mid-word');

    // ── (o) 서명은 비동기 render로 사라지지 않는다 ──
    //   서명 캔버스는 preventDefault 때문에 **절대 포커스를 받지 않는다** — activeElement만 보는 판정으로는
    //   "지금 서명 중"을 영원히 못 잡는다. 손님이 이름을 반쯤 쓴 순간 백그라운드 render 하나가 돌면
    //   획이 통째로 사라지고, 손님은 자기가 잘못 쓴 줄 안다.
    //   ⚠️ 먼저 금액 칸에서 포커스를 뗀다 — 통합 화면(beta.22)에서는 입력 포커스만으로도 판정이 true가 되므로,
    //     "빈 캔버스 자체는 렌더를 막지 않는다"를 재려면 다른 원인을 모두 걷어내야 한다.
    await page.evaluate(() => { const el = document.querySelector('#custAmountInput'); if (el) el.blur(); });
    await page.waitForTimeout(80);
    await assert(await page.evaluate(() => window.__prepaidTestHooks.renderIsDisruptive()) === false, 'a blank signature canvas must NOT block rendering — mere existence would freeze the screen forever');
    await assert(await page.evaluate(() => window.__prepaidTestHooks.custComposeActive()) === true, 'the unified request screen must report itself active (the guard keys off exactly this)');
    await drawOn('.cust-sig #signCanvas');
    await assert(await page.evaluate(() => window.__prepaidTestHooks.signInProgress()) === true, 'a canvas with strokes on it must count as "signing in progress"');
    await assert(await page.evaluate(() => window.__prepaidTestHooks.renderIsDisruptive()) === true, 'rendering over a signature in progress must be judged disruptive');
    await page.evaluate(() => { document.querySelector('#signCanvas').__bapStroke = 'alive'; });
    // 실제 비동기 경로들을 쏜다: 네트워크 플랩 + 수신함 폴링.
    await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
    await page.evaluate(() => window.__prepaidTestHooks.refreshInboxCount());
    await page.waitForTimeout(500);
    const sigAlive = await page.evaluate(() => {
      const c = document.querySelector('#signCanvas');
      return { same: !!c && c.__bapStroke === 'alive', has: !!c };
    });
    await assert(sigAlive.has && sigAlive.same, 'an async render must never replace the canvas the customer is signing on');
    // 획이 살아 있다는 증거는 "제출이 통과한다"이다 — 노드만 같고 그림이 비면 아무 소용이 없다.
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]', { timeout: 6000 });
    await assert((await lockSt2()).pendingSignLen > 200, 'the strokes themselves must survive the async render, not just the canvas node');
    await unlock();
    await page.waitForSelector('#useAmount', { timeout: 6000 });
    await closePrefilled();

    // ── (p) 프리필 모달의 첫 포커스는 [9,000원] 버튼이 아니다 ──
    //   첫 포커스가 빠른 금액 버튼이면, 모달이 열리자마자 Enter를 한 번 누르는 것만으로
    //   손님이 요청한 금액이 9,000원으로 덮여 쓴다(되돌릴 표시도, 흔적도 없다).
    await openPrefilled('박두번', '1000');
    const modalFocus = await page.evaluate(() => {
      const ae = document.activeElement;
      return { id: ae ? ae.id : '', tag: ae ? ae.tagName : '', a: ae && ae.dataset ? (ae.dataset.a || '') : '' };
    });
    await assert(modalFocus.a !== 'fill-use', `the modal must never open with a quick-amount button focused (got ${JSON.stringify(modalFocus)})`);
    // beta.55(사용자 결정 §1-10, 현장 보고): 손님 요청으로 열린 창의 첫 초점은 금액 칸이 아니라 [저장]이다 — 금액 칸에 초점이 가면
    //   태블릿 키보드가 저절로 올라와 서명과 [저장]을 가렸다. Enter는 [저장] = 평소 저장 경로(손님 금액 그대로)이며
    //   그 계약은 runBeta55b(C9 Enter)가 원장까지 확인한다. 여기서는 초점 위치와 금액 보존만 본다.
    await assert(modalFocus.a === 'save-use' && modalFocus.tag !== 'INPUT', `a request-opened modal must focus [저장], not an input (got ${JSON.stringify(modalFocus)})`);
    await assert((await page.locator('#useAmount').inputValue()) === '1000', 'the requested amount must sit untouched in the field');
    // 포커스 트랩은 그대로다 — Tab이 모달 밖으로 새지 않는다.
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    const trapped = await page.evaluate(() => !!(document.activeElement && document.activeElement.closest('.modal')));
    await assert(trapped, 'the focus trap must still hold the keyboard inside the modal');
    const beforeEscDb = await readDb(page);
    await closePrefilled();
    await assert(JSON.stringify((await readDb(page)).transactions) === JSON.stringify(beforeEscDb.transactions), 'closing the modal after the focus probes must leave the ledger untouched');

    // ── (q) 캔버스 위를 지나가기만 해서는 유휴 시계가 연장되지 않는다 ──
    //   태블릿을 계산대에 두면 캔버스 위에 손바닥·커서가 그냥 얹혀 있는 시간이 길다. 그 움직임까지
    //   "조작"으로 세면 이름·잔액이 뜬 화면이 무한히 방치된다(자동 복귀가 영원히 오지 않는다).
    await composeTo('박두번', '1000');
    await setTimers({ custIdle: 800, custComposeIdle: 1200 });
    await rearm('#custAmtBal');
    const hoverBox = await page.locator('.cust-sig #signCanvas').boundingBox();
    for (let i = 0; i < 7; i += 1) {
      await page.mouse.move(hoverBox.x + 20 + i * 6, hoverBox.y + hoverBox.height * 0.5);
      await page.waitForTimeout(280);   // 누계 ~1960ms > custComposeIdle 1200
    }
    await assert(await count(page, '#custSearchInput') === 1, 'hovering over the signature canvas must NOT keep the idle clock alive forever — only actual drawing counts');
    await assert((await lockSt2()).custAmount === '', 'the idle fallback must still discard the draft after a hover-only period');
    await setTimers({ custIdle: 30000, custComposeIdle: 60000 });

    // ── (r) 돈 파서는 십진 정수만 받는다 ──
    //   Number()는 '0x2710'을 10000으로, '1e4'를 10000으로 읽는다. 화면에 적힌 글자와 다른 금액이
    //   조용히 원장에 들어가는 유일한 길이다. 손님 금액·사용 모달·CSV·충전·조정이 전부 이 한 함수를 지난다.
    const wonProbe = (v) => page.evaluate(x => {
      const n = window.__prepaidTestHooks.parseWon(x);
      return (typeof n === 'number' && Number.isNaN(n)) ? 'NaN' : n;
    }, v);
    for (const bad of ['0x2710', '0X10', '1e4', '1E4', '0b11', '0o17', '１２３', 'Infinity', '-Infinity', '9_000', '.5', '9.', '1e-3']) {
      await assert(await wonProbe(bad) === 'NaN', `parseWon("${bad}") must be rejected — a number the owner never typed must never become money`);
    }
    for (const [good, want] of [['9000', 9000], ['9,000', 9000], ['9000원', 9000], [' 9 000 ', 9000], ['+9000', 9000], ['-100', -100], ['0', 0]]) {
      await assert(await wonProbe(good) === want, `parseWon("${good}") must still parse to ${want} (the tightening may not break plain input)`);
    }
    // 사장님 화면의 금액 칸은 type=number라 브라우저가 'x' 같은 글자를 애초에 받지 않는다 — 거기서는 파서를
    //   시험할 수 없다. 진짜 입구는 **파일**이다. CSV의 금액 칸은 브라우저가 아무것도 걸러주지 않는다.
    await unlock();
    await page.waitForSelector('[data-a="quick-find-emp"]', { timeout: 8000 });
    const beforeHexDb = await readDb(page);
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('#csvFile', { state: 'attached' });
    const hexCsv = '소속,부서,이름,금액\r\n한빛물산,영업1팀,헥사,0x2710\r\n';
    await page.locator('#csvFile').setInputFiles({ name: 'hex.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + hexCsv, 'utf8') });
    await page.waitForSelector('.csv-table', { timeout: 5000 });
    const hexPreview = await page.locator('.modal').innerText();
    await assert(!hexPreview.includes('10,000'), `a hex amount in a CSV must never be read as 10,000원 (got ${JSON.stringify(hexPreview.slice(0, 300))})`);
    await assert(await count(page, '[data-a="exec-csv"]') === 0, 'a CSV carrying a hex amount must not even offer the import button');
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(200);
    await assert(JSON.stringify((await readDb(page)).transactions) === JSON.stringify(beforeHexDb.transactions), 'the rejected CSV must leave the ledger byte-identical');
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(200);

    // ── (i) 요청은 백업 JSON에도 없다 — beta.29: 홈 상단 버튼이 사라져 이력 화면의 [백업] 버튼으로 받는다 ──
    const reqBackups = [];
    const onReqBackup = d2 => reqBackups.push(d2);
    page.on('download', onReqBackup);
    await page.locator('[data-a="screen"][data-screen="history"]').click();
    await page.waitForSelector('[data-a="export"]', { timeout: 8000 });
    await page.locator('[data-a="export"]').click();
    await ownPlainBackupFromDialog(page);
    for (let i = 0; i < 25 && !reqBackups.length; i += 1) await page.waitForTimeout(100);
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="yes"]').click().catch(() => {});
    page.off('download', onReqBackup);
    await assert(reqBackups.length >= 1, 'the backup button must still produce a file');
    await page.locator('[data-a="go-home"]').click();
    await page.waitForTimeout(150);
    const reqBackupText = await fsp.readFile(await reqBackups[0].path(), 'utf8');
    await assert(!/pendingAmount|pendingSign|custAmount|custQuery|pendingCustomer/.test(reqBackupText), 'no request state may leak into the backup file');
    // 구조적 보장 — 요청 4필드는 state.data 바깥에 산다. 저장·전송의 유일한 입구(repo.apply)에 닿는 줄이
    //   단 하나라도 생기면 여기서 잡힌다(클라우드 백업·서버 전송도 전부 backupCore→state.data를 지난다).
    const persistLines = srcForTtl.split('\n').filter(l => /repo\.apply\(/.test(l) && /pendingAmount|pendingSign|custAmount|pendingCustomer/.test(l));
    await assert(persistLines.length === 0, `no request field may ever reach the persistence entry point (found ${persistLines.length} line(s))`);
    await assert(!/payload:\{[^}]*pending/.test(srcForTtl), 'the backup payload builder must not learn about requests');

    // ───────────────────────────────────────────────────────────────
    // (9) 소속 목록에 등록된 공공기관 추가 — 제안 목록 + orgKind 자동 분류
    //     ⚠️ 매칭 키(라벨|이름)는 그대로다 — 저장되는 org/dept 문자열이 바뀌면 안 된다.
    // ───────────────────────────────────────────────────────────────
    //     ⚠️ 제안 목록은 **입력이 실제로 가리키는 datalist**에서 읽는다(id를 하니스가 직접 아는 순간
    //       "id는 맞는데 다른 곳을 가리키는" 사고를 통째로 못 본다). 문서에 같은 id가 두 개면 실패다 —
    //       브라우저는 앞의 것만 참조하므로, 중복 id는 곧 "모달의 추천이 조용히 비는" 현장 결함이다.
    const orgListOf = (inputId) => page.evaluate((id) => {
      const input = document.getElementById(id);
      if (!input) return { found: false };
      const listId = input.getAttribute('list');
      const dupes = document.querySelectorAll(`[id="${listId}"]`).length;
      const dl = document.getElementById(listId);
      return { found: true, listId, dupes, options: dl ? [...dl.options].map(o => o.value) : null };
    }, inputId);
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await openSettingsCard(page, 'enroll-manual');// beta.29: 빠른 등록 폼은 접힌 수동 등록 카드 안에 있다
    await page.waitForSelector('#quickAddOrg');
    const quickOrg = await orgListOf('quickAddOrg');
    await assert(quickOrg.found && quickOrg.options, `빠른 등록 소속 입력은 실재하는 datalist를 가리켜야 한다 (got ${JSON.stringify(quickOrg)})`);
    await assert(quickOrg.dupes === 1, `소속 추천 datalist id("${quickOrg.listId}")가 문서에 ${quickOrg.dupes}개 있다 — 중복 id는 브라우저가 앞의 것만 보게 만든다`);
    await assert(quickOrg.options[0] === '개인' && quickOrg.options[1] === '광진구청', `빠른 등록 소속 제안은 '개인' 다음에 등록된 공공기관명이어야 한다 (got ${JSON.stringify(quickOrg.options)})`);
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empOrg');
    const modalOrg = await orgListOf('empOrg');
    await assert(modalOrg.found && modalOrg.options, `한 명씩 등록 모달의 소속 입력도 실재하는 datalist를 가리켜야 한다 (got ${JSON.stringify(modalOrg)})`);
    await assert(modalOrg.dupes === 1, `모달이 열린 상태에서도 소속 추천 datalist는 문서에 하나여야 한다 (got ${modalOrg.dupes}개 · id="${modalOrg.listId}")`);
    await assert(modalOrg.listId === quickOrg.listId, `두 입력은 **같은 추천 목록**을 봐야 한다 (모달 "${modalOrg.listId}" vs 빠른 등록 "${quickOrg.listId}")`);
    await assert(JSON.stringify(modalOrg.options) === JSON.stringify(quickOrg.options), `두 입력의 소속 제안이 갈라졌다 (모달 ${JSON.stringify(modalOrg.options)} vs 빠른 등록 ${JSON.stringify(quickOrg.options)})`);
    await assert(modalOrg.options[0] === '개인' && modalOrg.options[1] === '광진구청', `한 명씩 등록 소속 제안도 '개인' + 공공기관명이어야 한다 (got ${JSON.stringify(modalOrg.options)})`);
    // datalist는 폰에서 **자동으로 열리지 않는다** — 목록이 있어도 사장님 눈에는 안 보인다(현장 보고의 정체).
    //   그래서 등록된 공공기관명은 눈에 보이는 칩으로도 반드시 떠 있어야 하고, 누르면 그 값이 칸에 들어가야 한다.
    const orgChips = (await page.locator('.field .org-pick').allInnerTexts()).map(t => t.trim());
    await assert(JSON.stringify(orgChips) === JSON.stringify(modalOrg.options), `소속 추천은 눈에 보이는 칩으로도 같은 순서로 떠 있어야 한다 (got ${JSON.stringify(orgChips)})`);
    await page.locator('.field .org-pick', { hasText: '광진구청' }).first().click();
    await page.waitForTimeout(80);
    await assert((await page.locator('#empOrg').inputValue()) === '광진구청', '소속 칩을 누르면 그 값이 소속 칸에 들어가야 한다');
    // 모달이 열릴 때 커서는 **직원명**에 놓인다 — 소속 칸에 미리 포커스가 가면 폰에서 추천 목록이 열리지 않는다.
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(120);
    await page.locator('[data-a="add-employee"]').click();
    await page.waitForSelector('#empOrg');
    const modalFocusId = await page.evaluate(() => (document.activeElement && document.activeElement.id) || '');
    await assert(modalFocusId === 'empName', `한 명씩 등록 모달의 첫 포커스는 직원명이어야 한다 (got "${modalFocusId}")`);
    await page.locator('.modal-actions [data-a="close-modal"]').click();
    await page.waitForTimeout(120);
    // ── 빠른 등록에도 **보이는 칩**이 있어야 한다 (beta.25 MEDIUM-2) ─────────────────────
    //   "폰에서는 datalist가 자동으로 열리지 않는다"는 근거는 [빠른 등록]에도 똑같이 성립한다 —
    //   같은 사장님이 같은 폰에서 같은 목록을 본다. 모달만 고치면 결함이 절반 그대로 남는다.
    //   그래서 여기서 재는 것은 datalist 옵션이 아니라 **눈에 보이는 칩**이다(옵션은 보이지 않아도 통과한다).
    const quickChips = (await page.locator('.quick-add-form .org-pick').allInnerTexts()).map(t => t.trim());
    await assert(JSON.stringify(quickChips) === JSON.stringify(quickOrg.options), `빠른 등록에도 소속 추천 칩이 같은 순서로 떠 있어야 한다 (got ${JSON.stringify(quickChips)})`);
    const quickChipsShown = await page.evaluate(() => [...document.querySelectorAll('.quick-add-form .org-pick')].every(c => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; }));
    await assert(quickChipsShown, '빠른 등록 소속 칩은 실제로 화면에 보여야 한다 — 폭·높이가 0이면 없는 것과 같다');
    // 칩 → 칸 → 등록까지 한 줄로 이어져야 의미가 있다(누르기만 하고 값이 안 들어가면 도로 아무것도 아니다).
    await page.locator('.quick-add-form .org-pick', { hasText: '광진구청' }).first().click();
    await page.waitForTimeout(100);
    await assert((await page.locator('#quickAddOrg').inputValue()) === '광진구청', '빠른 등록 소속 칩을 누르면 그 값이 소속 칸에 들어가야 한다');
    const quickChipOn = await page.evaluate(() => [...document.querySelectorAll('.quick-add-form .org-pick.on')].map(c => c.textContent.trim()));
    await assert(JSON.stringify(quickChipOn) === JSON.stringify(['광진구청']), `누른 칩 하나만 선택 표시가 되어야 한다 (got ${JSON.stringify(quickChipOn)})`);
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

    // ── (9-b) 최후 방벽은 화면만이 아니라 **state까지** 강등한다 (beta.25 LOW-2) ─────────────
    //   잔액 0원 손님을 요청 작성 화면으로 보내면 무엇을 넣어도 "잔액보다 많아요"에 걸리는 막다른 길이다.
    //   그래서 렌더 입구에 강등이 하나 있다. beta.24까지 그 강등은 **지역 변수만** 바꿨다 —
    //   화면은 상세인데 state.custStage는 'compose'로 남았고, 그 값을 읽는 곳이 셋이나 된다
    //   (custComposeActive → 있지도 않은 캔버스를 지키느라 render 강등 · armIdle의 시계 선택 · 하니스 단언).
    //   주석이 "강등한다"고 말하면 state도 실제로 강등되어야 한다.
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    await page.waitForSelector('#quickAddOrg');
    await page.locator('#quickAddOrg').fill('');
    await page.locator('#quickAddDept').fill('빈잔액과');
    await page.locator('#quickAddName').fill('영원');
    await page.locator('#quickAddOpen').fill('0');
    await page.locator('[data-a="quick-add-employee"]').click();
    await page.waitForTimeout(300);
    const zeroDb = await readDb(page);
    const zeroEmp = zeroDb.employees.find(e => e.name === '영원');
    await assert(Boolean(zeroEmp) && balanceOfId(zeroDb, zeroEmp.id) === 0, `the zero-balance fixture must actually have 0원 (got ${zeroEmp && balanceOfId(zeroDb, zeroEmp.id)})`);
    await page.locator('[data-a="screen"][data-screen="home"]').click();
    await page.waitForTimeout(150);
    await page.locator('[data-a="hand-to-customer"]').click();
    await page.waitForSelector('#custSearchInput');
    await page.locator('#custSearchInput').fill('영원');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('.cust-bal');
    const zeroLanding = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(zeroLanding.custStage === 'self', `a zero-balance customer must land on the detail screen, never the compose dead end (got ${zeroLanding.custStage})`);
    await assert(await count(page, '[data-a="cust-request"]') === 0, 'a zero-balance customer must not even be offered the request path');
    // 방벽 본체 — 액션을 직접 눌러 stage를 'compose'로 세팅해도 화면과 state가 **함께** 되돌아와야 한다.
    await page.evaluate(() => { const b = document.createElement('button'); b.setAttribute('data-a', 'cust-request'); document.body.appendChild(b); b.click(); b.remove(); });
    await page.waitForTimeout(300);
    const barrier = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(await count(page, '#custAmountInput') === 0 && await count(page, '.cust-bal') === 1, 'the last-ditch barrier must keep a zero-balance customer off the compose screen');
    await assert(barrier.custStage === 'self', `the barrier must correct state.custStage too — a screen that shows the detail while the state says 'compose' is a lie every other reader believes (got ${barrier.custStage})`);
    await assert(barrier.locked === true, 'the barrier must never unlock anything');
    await page.locator('.cust-actions [data-a="cust-back"]').click();
    await page.waitForSelector('#custSearchInput');
    await unlockPin(page);
    await page.waitForSelector('.top .tool [data-a="go-employees"]', { timeout: 8000 });

    // (10) 손님 화면 상태는 백업 파일에도 남지 않는다 — beta.29: 이력 화면 [백업] 버튼으로 받는다.
    const custBackups = [];
    const onCustBackup = d => custBackups.push(d);
    page.on('download', onCustBackup);
    await page.locator('[data-a="screen"][data-screen="history"]').click();
    await page.waitForSelector('[data-a="export"]', { timeout: 8000 });
    await page.locator('[data-a="export"]').click();
    await ownPlainBackupFromDialog(page);
    for (let i = 0; i < 25 && !custBackups.length; i += 1) await page.waitForTimeout(100);
    await page.locator('.choice-modal [data-a="choice-pick"][data-val="yes"]').click().catch(() => {});
    page.off('download', onCustBackup);
    await assert(custBackups.length >= 1, 'the [백업] button should still download a backup');
    await page.locator('[data-a="go-home"]').click();
    await page.waitForTimeout(150);
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
    await openSettingsCard(page, 'enroll-manual');// beta.29: 빠른 등록 버튼은 접힌 수동 등록 카드 안에 있다
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
    await assert((await page.locator('.cust-card').innerText()).includes('Alec님'), 'Alec must reach their own request screen (not merged away)');
    await page.locator('[data-a="cust-history"]').click();
    await page.waitForSelector('.cust-bal', { timeout: 6000 });
    const alecId = latinDb.employees.find(e => e.name === 'Alec').id;
    await assert(balanceOfId(latinDb, alecId) === 30000, 'Alec must own their own balance in the ledger');
    // 손님 화면의 잔액 숫자 — 바로 위에서 3행 CSV를 한 번에 임포트했으므로, 예전(createdAt=now()+Math.random())
    //   이라면 정렬과 체인 순서가 어긋나 여기서 "잔액을 표시할 수 없어요"가 떴다(실행마다 흔들리는 오판).
    //   이제 배치 거래 시각은 단조 증가하고 검증은 체인 연결을 따라가므로 항상 숫자가 보여야 한다.
    await assert(await count(page, '.cust-warn') === 0, 'a healthy ledger must never show the "잔액을 표시할 수 없어요" warning right after a CSV batch import');
    await assert((await page.locator('.cust-bal').innerText()).includes('30,000원'), 'the customer screen must show the balance figure after a batch import');
    await page.locator('.cust-actions [data-a="cust-back"]').click();
    await page.waitForSelector('#custSearchInput');

    // ═══════════════════════════════════════════════════════════════════════
    // (12) "사장님 확인" 화면 방치(HIGH-3) — 손님이 넘긴 PIN 화면에서도 30초 유휴 시계가 돈다.
    //   예전에는 PIN 화면에 들어선 순간 시계가 꺼져 앞 손님의 조회 상태·인계 요청이 무기한 살아남았다.
    //   beta.19: 시계는 손님 흔적이 남는 handoff 맥락에만 건다(owner 맥락은 12-a2에서 반대로 못 박는다).
    //   beta.55(C8, 사용자 결정 §1-8): 이 화면의 시계는 custIdle(30초)이 아니라 handoffPinIdle(60초)이다 — 축척도 그쪽으로 건다.
    // ═══════════════════════════════════════════════════════════════════════
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { custIdle: 700, handoffPinIdle: 700 }));
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    // 손님이 [사장님 부르기]로 폰을 넘긴 뒤 사장님이 오지 않은 채 시간이 흐른다.
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
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { handoffPinIdle: 60000 }));// beta.55: 축척한 "사장님 확인" 시계를 되돌린다

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
    // beta.55(C8): "사장님 확인" 화면의 유휴 시계는 handoffPinIdle이다 — custIdle과 같은 축척(700ms)을 건다.
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { pinDelay: 3000, handoffPinIdle: 700 }));
    await page.locator('#custSearchInput').fill('김철수');
    await page.waitForSelector('.cust-ask');
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('[data-a="cust-call-owner"]');
    await page.locator('[data-a="cust-call-owner"]').click();
    await page.waitForSelector('.pin-screen [data-a="pin-key"]');
    for (let i = 0; i < 5; i += 1) await typePin(page, ['9', '9', '9', '9']);
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
    // beta.60: 이 기기(초기화 뒤 새로 설정)는 백업 암호를 정한 적이 없다 → 복구 화면에는 ③(전부 지우고 새로 시작)만 있다.
    await page.waitForSelector('.pin-recovery [data-a="pin-reset"]');
    await assert(await page.locator('[data-a="pin-reset"]').isDisabled(), 'the 60s destruction gate must still hold on the recovery screen reached from 사장님 확인');
    await page.waitForTimeout(1800);
    await assert(await count(page, '.cust-screen') === 1 && await count(page, '.pin-recovery') === 0, 'an abandoned recovery screen must fall back to the customer screen');
    const afterRecoveryIdle = await page.evaluate(() => window.__prepaidTestHooks.lockState());
    await assert(afterRecoveryIdle.pinRecovery === false && afterRecoveryIdle.pendingCustomerId === '' && afterRecoveryIdle.pinContext === '', 'the recovery idle fallback must clear recovery, the handover request and the PIN context');
    await assert((await bt()).locked === true, 'the recovery idle fallback must never unlock the app');
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { custIdle: 30000, recoveryGate: 60000, handoffPinIdle: 60000 }));

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
      return { ok: c.ok, tamperOk: c.tamperOk, anchor: c.anchor, checked: c.checked, legacy: c.legacy, broken: (c.broken || []).map(b => `${b.id}(${b.reason})`) };
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
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
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
    await openSettingsCard(page, 'enroll-auto');// beta.29: 신청 확인 버튼은 접힌 자동 등록 카드 안에 있다
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

    // ── 담당자 웹의 CSV '소속' 선택 열 — items[].org가 있으면 그 값이, 없으면 기관명이 소속이 된다 ──
    //   batch_hash 계산식(name|dept|amount)은 **불변**이다: org를 넣어도 확인값이 달라지지 않아야 통과한다.
    const orgItems = [
      { name: '소속열있음', dept: '복지과', amount: 4100, org: '소속열회사' },
      { name: '소속열없음', dept: '복지과', amount: 4200 }
    ];
    const orgJson = await page.evaluate(async ({ items, rid }) => {
      const b = await window.__mkBatch(items);
      return JSON.stringify({
        v: 1, type: 'direct-transfer', restaurant_id: rid, restaurant_name: 'Harness Chain Shop',
        institution: '서초구청', department: '복지과', year_month: '2026-09',
        summary: { total_amount: items.reduce((s, x) => s + x.amount, 0), member_count: items.length, batch_hash: b.batch_hash },
        ciphertext: b.ciphertext
      });
    }, { items: orgItems, rid: 'harness-chain-shop' });
    const beforeOrgCol = new Set((await readDb(page)).transactions.map(t => t.id));
    await page.locator('#directTransferFile').setInputFiles({ name: 'transfer-org.json', mimeType: 'application/json', buffer: Buffer.from(orgJson, 'utf8') });
    await waitForNewTx(beforeOrgCol, 2, 'org-column direct transfer');
    const orgColEmps = (await readDb(page)).employees;
    const withOrg = orgColEmps.find(e => e.name === '소속열있음');
    const withoutOrg = orgColEmps.find(e => e.name === '소속열없음');
    await assert(Boolean(withOrg) && Boolean(withoutOrg), 'the org-column batch should create both employees (batch_hash must not change when org is present)');
    await assert(withOrg.org === '소속열회사', `items[].org must win over the institution name (got ${JSON.stringify(withOrg && withOrg.org)})`);
    await assert(withoutOrg.org === '서초구청', `an item without org must keep falling back to the institution name (got ${JSON.stringify(withoutOrg && withoutOrg.org)})`);
    await assert(withOrg.dept === '복지과' && withoutOrg.dept === '복지과', 'the department must stay untouched either way');

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
    await confirmInAppRestore(page);
    for (let i = 0; i < 60; i += 1) {
      const db = await readDb(page);
      if (db.employees.length === 3 && db.employees.every(e => /^레거시/.test(e.name))) break;
      await page.waitForTimeout(200);
    }
    const legDb = await readDb(page);
    await assert(legDb.employees.length === 3 && legDb.transactions.length === 8, `the legacy backup must restore (got ${legDb.employees.length} employees / ${legDb.transactions.length} transactions)`);
    const legRep = await chainReport();
    // beta.31: 구 형식(canonical v1 · 해시 없음) 거래는 더 이상 "조용히 통과"하지 않는다.
    //   ok=false(재검증 불가)이지만 **변조 증거는 없다**(tamperOk) — 그 구분이 아래 손님/증표 판정을 가른다.
    await assert(legRep.ok === false, 'a pre-v2 (legacy) ledger must NOT report a clean ok — hashless/old-format rows must raise the warning state');
    await assert(legRep.tamperOk === true, `a legacy ledger must still show no evidence of tampering (broken: ${legRep.broken.join(', ')})`);
    await assert(legRep.checked === 0 && legRep.legacy === 8, `every pre-v2 row must be counted as 구 형식, not verified (checked=${legRep.checked}, legacy=${legRep.legacy})`);
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
    await page.locator('.receipt-modal [data-a="receipt-close"]').click();
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
    // 구 형식 8건은 그대로 '재검증 불가'로 남는다(ok=false) — 다만 변조 증거는 없어야 하고,
    //   새로 얹은 v2 거래는 구 형식 꼬리에 이어져 '체인 단절'로 오판되면 안 된다.
    await assert(afterLegacyRep.tamperOk === true, `appending to a legacy ledger must not look like tampering (broken: ${afterLegacyRep.broken.join(', ')})`);
    await assert(afterLegacyRep.checked === 1 && afterLegacyRep.legacy === 8, `the appended row must verify as v2 while the old rows stay 구 형식 (checked=${afterLegacyRep.checked}, legacy=${afterLegacyRep.legacy})`);
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
    // (14) 정식 복구 경로 — beta.60: [② 백업 파일로 되찾기]에서 **이 기기의 백업 암호가 맞은 뒤** [백업 파일 고르기]만이 잠금 중 복원을 통과한다.
    //   (예전: 60초 게이트를 지난 [① 백업 파일로 복구] — 비밀번호도 백업 암호도 모르는 사람에게 열려 있었다.)
    //   ⚠️ 이 검증은 장부를 백업 내용으로 갈아치우므로 반드시 마지막에 둔다.
    // ═══════════════════════════════════════════════════════════════════════
    // 초기화 뒤 새로 설정한 이 기기는 아직 백업 암호가 없다 → 복구 화면에 ②가 없다. 사장님이 백업 암호를 정해 둔 상태를 심는다(검증자만).
    await page.evaluate(check => new Promise((resolve, reject) => {
      const req = indexedDB.open('prepaid-ledger-db');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { const t = req.result.transaction(['meta'], 'readwrite'); t.objectStore('meta').put({ key: 'backupPassCheck', value: check }); t.oncomplete = () => resolve(true); t.onerror = () => reject(t.error); };
    }), MAIN_PASS_CHECK);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.cust-screen');
    await page.evaluate(() => Object.assign(window.__prepaidTestHooks.TIMERS, { recoveryGate: 700 }));
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
    await page.locator('[data-a="pin-forgot"]').click();
    await page.waitForSelector('[data-a="pin-forgot-restore"]');
    // 백업 암호가 맞기 전에는 allowLockedRestore 플래그가 절대 서지 않는다(합성 클릭은 암호 창만 연다).
    await page.evaluate(() => document.querySelector('[data-a="pin-forgot-restore"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('#keyPass1');
    await assert((await page.evaluate(() => window.__prepaidTestHooks.lockState())).allowLockedRestore === false, 'the locked-restore exception must not be granted before the backup password is checked');
    await page.locator('[data-a="pass-cancel"]').click();
    await page.waitForTimeout(200);
    const goodBackup = JSON.stringify({
      schemaVersion: 3, appName: '선입금대장', appVersion: 'x', exportedAt: Date.now(),
      payload: {
        employees: [{ id: 'rec-1', org: '', orgKind: '', dept: '복구부', name: '복구된직원', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: Date.now(), updatedAt: Date.now() }],
        transactions: [],
        meta: { setupComplete: true, shopName: '복구된가게', departments: [] }
      }
    });
    const recoveryChooser = await recoveryFileChooser(page, MAIN_PASS);
    await recoveryChooser.setFiles({ name: 'good-backup.json', mimeType: 'application/json', buffer: Buffer.from(goodBackup, 'utf8') });
    await confirmInAppRestore(page);
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

    // ── beta.23: consoleProblems는 이제 **단언 대상**이다 ─────────────────────────────
    // 여태 이 배열은 수집만 하고 아무도 검사하지 않았다. 그 사이에 렌더 예외 10건이 조용히 통과했다:
    //   "Failed to set the 'innerHTML' property … The node to be removed is no longer a child of this node."
    //   = 사장님 홈 검색창이 화면에서 사라질 때 늦은 change 이벤트가 onInput→render를 재진입시켜
    //     **그 렌더가 통째로 실패**한 것이다(화면이 반쯤 옛 상태로 남는다). HEAD에도 있던 결함이다.
    //   beta.23에서 원인을 고쳤다(onInput이 searchInput의 change를 받지 않는다 — 손님 검색창과 같은 규칙).
    // 남겨 두는 예외는 **하니스가 일부러 만든 네트워크 실패**뿐이고, 그것도 상한을 둔다.
    //   상한을 넘거나 목록에 없는 오류가 하나라도 나오면 실패한다(신규·증가 = 회귀).
    const EXPECTED_CONSOLE = [
      { name: 'mocked HTTP 401/404/500', re: /Failed to load resource: the server responded with a status of (401|404|500)/, max: 65 },
      //   ↑ beta.60: 기준값 62(A1·A2 뒤 61 + A3a의 '등록 전 소유 증명 시도' 1건 — 처음 등록하는 가게의 /api/challenge는 실서버처럼 404). 여유 3을 유지해 65.
      //   ↑ 기준값은 60이다(beta.55·56 모두 60 — 2026-11-14 실측). 상한이 기준값과 같으면, 기기가 바쁜 날 재시도 한 번이 더 끼어
      //     61이 되어 무관한 실패가 난다(같은 날 실제로 겪음). 여유 3을 둔다 — 실제 수치는 아래 'console noise tally' 줄로 늘 찍힌다.
      { name: 'offline/DNS 실패 시나리오', re: /net::ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_REFUSED|FAILED)/, max: 8 },
      // beta.55(A2): 명단을 받은 직후의 "백업을 갱신할까요?" 확인창이 없어지고 조용한 서버 백업이 그 자리에서 돈다 — 등록된 가게의
      //   직접 전달·승인마다 시도하므로, 안전망 목(500)에 대한 'silent cloud backup' 로그가 몇 건 는다(예전에는 확인창을 닫아 시도 자체가 없었다).
      { name: '위 실패에 대한 앱의 정상적인 오류 로깅', re: /^error: (silent cloud backup|register-key|relay|keygen|key-backup)/, max: 12 }
    ];
    const consoleTally = new Map(EXPECTED_CONSOLE.map(e => [e.name, 0]));
    const consoleUnexpected = [];
    consoleProblems.forEach(msg => {
      const hit = EXPECTED_CONSOLE.find(e => e.re.test(msg));
      if (hit) consoleTally.set(hit.name, consoleTally.get(hit.name) + 1);
      else consoleUnexpected.push(msg);
    });
    const consoleOverflow = EXPECTED_CONSOLE
      .filter(e => consoleTally.get(e.name) > e.max)
      .map(e => `${e.name}: ${consoleTally.get(e.name)}건 > 상한 ${e.max} ${JSON.stringify(consoleProblems.filter(m => e.re.test(m)).map(m => m.slice(0, 60)))}`);
    // 상한까지 얼마나 남았는지 늘 찍는다 — 상한에 닿은 실패가 '회귀'인지 '원래 턱밑이었는지'를 로그만 보고 가릴 수 있게.
    console.log('console noise tally: ' + EXPECTED_CONSOLE.map(e => `${e.name} ${consoleTally.get(e.name)}/${e.max}`).join(' · '));
    await assert(consoleUnexpected.length === 0,
      `the browser console must stay clean — ${consoleUnexpected.length} unexpected error/warning(s): ${JSON.stringify([...new Set(consoleUnexpected)].slice(0, 5))}`);
    await assert(consoleOverflow.length === 0,
      `known harness-induced console noise must not grow: ${JSON.stringify(consoleOverflow)}`);
    await assert(!consoleProblems.some(m => /innerHTML/.test(m)),
      `no render may fail with an innerHTML replacement error (onInput→render re-entrancy): ${JSON.stringify(consoleProblems.filter(m => /innerHTML/.test(m)).slice(0, 2))}`);

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
      sigPngLengths: SIG_PNG_LENGTHS,
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
