#!/usr/bin/env node
// 폰 반응형 회귀 테스트 — 좁은 화면에서 "화면 밖으로 밀려나는 것"과 "이름/금액이 잘리는 것"을 막는다.
//   · 뷰포트: 360(갤럭시 소형) / 390(아이폰) / 412(안드로이드 대형) / 768(태블릿)
//   · 시나리오: 짧은 이름 · 아주 긴 이름 · 7자리 금액 · 긴 "소속 부서" 라벨
//   · 온보딩은 IndexedDB 직접 시드로 우회한다(PIN 1234만 입력).
// 실행: node harness/responsive.e2e.mjs
'use strict';

import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (err) {
  console.error('Playwright is required. Install it or run with NODE_PATH pointing to a Playwright installation.');
  console.error(err.message);
  process.exit(1);
}

function findChrome() {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean).find(p => fs.existsSync(p));
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const name = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.resolve(root, '.' + name);
      if (!file.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, url: `http://127.0.0.1:${server.address().port}/index.html`
  })));
}

const failures = [];
let checks = 0;
function check(cond, message) {
  checks += 1;
  if (!cond) failures.push(message);
}

// 시드 데이터: 짧은 이름 / 아주 긴 이름 / 7자리 금액 / 긴 "소속 부서" 라벨을 한 화면에 모두 올린다.
const LONG_NAME = '김수한무거북이와두루미';
// orgKind:'public' = 자동 등록(승인·직접 전달)으로 들어온 공공기관 직원 → 홈 그룹 헤더가 부서명만으로 나온다.
const SEED_EMPLOYEES = [
  { id: 'r-emp-1', org: '', orgKind: '', dept: '총무부', name: '김민수', amount: 9000 },
  { id: 'r-emp-2', org: '강남구청', orgKind: 'public', dept: '여성가족정책과', name: LONG_NAME, amount: 1234567 },
  { id: 'r-emp-3', org: '한빛물산', orgKind: '', dept: '총무부', name: '이서연', amount: 1000000 }
];

async function seed(page) {
  const pinHash = crypto.createHash('sha256').update('1234').digest('hex');
  await page.evaluate(({ emps, pinHash, t }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['employees', 'transactions', 'meta'], 'readwrite');
      const es = tx.objectStore('employees'), ts = tx.objectStore('transactions'), ms = tx.objectStore('meta');
      emps.forEach((e, i) => {
        es.put({ id: e.id, org: e.org, orgKind: e.orgKind, dept: e.dept, name: e.name, note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t, updatedAt: t });
        // txHash 없이 넣는다(레거시 취급) — 잔액 계산에는 영향이 없고 해시체인 검증도 건너뛴다.
        ts.put({ id: 'r-tx-' + i, employeeId: e.id, type: 'open', amount: e.amount, beforeBalance: 0, afterBalance: e.amount, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: t });
      });
      ms.put({ key: 'setupComplete', value: true });
      ms.put({ key: 'termsAgreedAt', value: t });
      ms.put({ key: 'storeRegisterPending', value: false });
      ms.put({ key: 'pinHash', value: pinHash });
      ms.put({ key: 'shopName', value: '반응형 테스트 식당' });
      ms.put({ key: 'shopAddr', value: '서울특별시 광진구 구의동 123-45' });
      ms.put({ key: 'departments', value: ['총무부', '여성가족정책과'] });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  }), { emps: SEED_EMPLOYEES, pinHash, t: Date.now() });
}

async function unlock(page) {
  await page.waitForSelector('[data-a="pin-key"]');
  for (const key of ['1', '2', '3', '4']) await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
  await page.waitForSelector('[data-a="quick-find-emp"]', { timeout: 8000 });
}

// 홈 그룹은 기본 접힘(아코디언, beta.14) — 기하 검증은 "펼친 상태"에서 해야 의미가 있다.
async function expandHomeGroups(page) {
  for (let guard = 0; guard < 40; guard += 1) {
    const collapsed = page.locator('.group-head[aria-expanded="false"]');
    if (await collapsed.count() === 0) return;
    await collapsed.first().click();
    await page.waitForTimeout(60);
  }
  throw new Error('failed to expand every home group header');
}

async function noHorizontalOverflow(page, label, w) {
  const m = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth
  }));
  check(m.docScroll <= m.docClient + 1, `${w}px ${label}: 문서 가로 스크롤 발생 (scrollWidth ${m.docScroll} > clientWidth ${m.docClient})`);
  check(m.bodyScroll <= m.docClient + 1, `${w}px ${label}: body 가로 스크롤 발생 (${m.bodyScroll} > ${m.docClient})`);
}

async function runViewport(context, url, w) {
  const page = await context.newPage();
  await page.setViewportSize({ width: w, height: 780 });
  page.on('dialog', d => d.accept());
  await page.goto(url, { waitUntil: 'load' });
  await seed(page);
  await page.reload({ waitUntil: 'load' });
  await unlock(page);

  // ── 홈: 가로 스크롤 없음 (접힌 기본 상태) ──
  await noHorizontalOverflow(page, '홈(그룹 접힘)', w);

  // ── 그룹 헤더(아코디언): 손가락 터치 타겟 + 화면 안쪽 ──
  const clientW = await page.evaluate(() => document.documentElement.clientWidth);
  const heads = await page.evaluate(() => [...document.querySelectorAll('.group-head')].map(h => {
    const r = h.getBoundingClientRect();
    return { text: h.innerText.replace(/\n/g, ' ').trim(), height: r.height, left: r.left, right: r.right };
  }));
  check(heads.length === 3, `${w}px 홈: 그룹 헤더 3개(여성가족정책과 / 한빛물산 / 총무부)가 렌더되어야 한다 (${heads.length}개)`);
  check(heads.some(h => h.text.startsWith('▶') && /직원 \d+명/.test(h.text)), `${w}px 홈: 접힌 그룹 헤더에 ▶와 인원수가 보여야 한다 ${JSON.stringify(heads.map(h => h.text))}`);
  heads.forEach(h => {
    if (w <= 640) check(h.height >= 48, `${w}px 홈: 그룹 헤더 터치 타겟이 48px 미만 (${Math.round(h.height)}px · "${h.text}")`);
    check(h.right <= clientW + 1 && h.left >= -1, `${w}px 홈: 그룹 헤더가 화면 밖으로 나갔다 ("${h.text}")`);
  });
  // 공공기관(자동 등록) 그룹 헤더는 부서명만, 회사 그룹은 회사명만 — 좁은 화면에서도 문구가 그대로여야 한다.
  const headTitles = (await page.locator('.group-title').allInnerTexts()).map(t => t.trim());
  check(headTitles.includes('여성가족정책과'), `${w}px 홈: 공공기관 그룹 헤더는 부서명만이어야 한다 ${JSON.stringify(headTitles)}`);
  check(headTitles.includes('한빛물산'), `${w}px 홈: 회사 그룹 헤더는 회사명만이어야 한다 ${JSON.stringify(headTitles)}`);

  // ── 펼친 뒤에도 가로로 밀리지 않아야 한다(기하 단언은 전부 펼친 상태에서) ──
  await expandHomeGroups(page);
  await noHorizontalOverflow(page, '홈(그룹 펼침)', w);
  const cardCount = await page.locator('.card.employee').count();
  check(cardCount === 3, `${w}px 홈: 그룹을 모두 펼치면 직원 카드 3장이 보여야 한다 (${cardCount}장)`);
  const subs = (await page.locator('.group-sub').allInnerTexts()).map(t => t.trim());
  check(subs.includes('총무부'), `${w}px 홈: 회사 그룹을 펼치면 부서 소제목이 보여야 한다 ${JSON.stringify(subs)}`);

  // ── 직원 이름/부서가 잘리지 않아야 한다(금액도 축약 금지 — 전액 표기) ──
  const clipped = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.card.employee').forEach(card => {
      ['.name', '.dept', '.bal'].forEach(sel => {
        const el = card.querySelector(sel);
        if (!el) return;
        if (el.scrollWidth > el.clientWidth + 1) out.push(sel + ' → ' + el.textContent.trim());
      });
    });
    return out;
  });
  check(clipped.length === 0, `${w}px 홈: 직원 카드에서 잘린 텍스트 ${JSON.stringify(clipped)}`);

  const balTexts = await page.locator('.card.employee .bal').allInnerTexts();
  check(balTexts.some(t => t.includes('1,234,567원')), `${w}px 홈: 7자리 잔액이 전액(1,234,567원)으로 표기되어야 한다 — 축약 금지`);
  const longCard = page.locator('.card.employee', { hasText: LONG_NAME }).first();
  check((await longCard.innerText()).includes('강남구청 여성가족정책과'), `${w}px 홈: 소속+부서 결합 라벨이 그대로 보여야 한다`);

  // ── 카드 행 구성: 폰(≤640)은 2행, 태블릿(768)은 1행 ──
  const rows = await page.evaluate(({ name }) => {
    const card = [...document.querySelectorAll('.card.employee')].find(c => c.innerText.includes(name));
    if (!card) return null;
    const av = card.querySelector('.emp-avatar').getBoundingClientRect();
    const use = card.querySelector('[data-a="use"]').getBoundingClientRect();
    return { avTop: av.top, avBottom: av.bottom, useTop: use.top, useRight: use.right, cardRight: card.getBoundingClientRect().right };
  }, { name: LONG_NAME });
  check(Boolean(rows), `${w}px: 긴 이름 직원 카드를 찾지 못했다`);
  if (rows) {
    if (w <= 640) check(rows.useTop >= rows.avBottom - 1, `${w}px: 폰에서는 [사용] 버튼이 두 번째 줄로 내려가야 한다 (useTop ${rows.useTop} < avatarBottom ${rows.avBottom})`);
    else check(rows.useTop < rows.avBottom, `${w}px: 태블릿에서는 카드가 1행을 유지해야 한다 (2행 규칙이 적용되면 안 됨)`);
    check(rows.useRight <= rows.cardRight + 1, `${w}px: [사용] 버튼이 카드 밖으로 나갔다`);
  }

  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-${w}.png`) }).catch(() => {});

  // ── 하단 내비게이션이 화면 안에 있어야 한다 ──
  const nav = await page.locator('.nav').boundingBox();
  check(Boolean(nav) && nav.x >= -1 && nav.x + nav.width <= w + 1, `${w}px: 하단 내비게이션이 화면 밖으로 나갔다 (${nav && (nav.x + nav.width)} > ${w})`);

  // ── 사용 등록 모달: 모든 액션 버튼이 화면 안에 있어야 한다(저장 버튼 미노출 회귀 방지) ──
  await page.locator(`[data-a="use"][data-id="r-emp-2"]`).click();
  await page.waitForSelector('#useAmount');
  await noHorizontalOverflow(page, '사용 등록 모달', w);
  const btns = await page.evaluate(() => [...document.querySelectorAll('.modal-actions button')].map(b => {
    const r = b.getBoundingClientRect();
    return { text: b.innerText.trim(), left: r.left, right: r.right, top: r.top, width: r.width };
  }));
  check(btns.length >= 3, `${w}px 모달: 액션 버튼이 모두 렌더되어야 한다 (${btns.length}개)`);
  check(btns.some(b => b.text.includes('서명 후 저장')), `${w}px 모달: [서명 후 저장] 버튼이 있어야 한다`);
  // 폰(≤640)은 세로 쌓기(column-reverse)라 주 동작 [서명 후 저장]이 맨 위에 와야 한다. 태블릿은 한 줄 유지.
  const saveBtn = btns.find(b => b.text.includes('서명 후 저장'));
  const otherBtns = btns.filter(b => b !== saveBtn);
  if (saveBtn && otherBtns.length) {
    if (w <= 640) check(otherBtns.every(b => saveBtn.top <= b.top + 1), `${w}px 모달: [서명 후 저장]이 다른 버튼보다 위에 있어야 한다 (엄지 근처)`);
    else check(otherBtns.every(b => Math.abs(saveBtn.top - b.top) <= 2), `${w}px 모달: 태블릿에서는 액션 버튼이 한 줄(같은 높이)을 유지해야 한다`);
  }
  const client = await page.evaluate(() => document.documentElement.clientWidth);
  btns.forEach(b => {
    check(b.right <= client + 1, `${w}px 모달: "${b.text}" 버튼 오른쪽 끝(${Math.round(b.right)})이 화면(${client}) 밖이다`);
    check(b.left >= -1, `${w}px 모달: "${b.text}" 버튼 왼쪽 끝이 화면 밖이다`);
    check(b.width > 40, `${w}px 모달: "${b.text}" 버튼이 사실상 보이지 않는 폭(${Math.round(b.width)})이다`);
  });
  await page.locator('.modal-actions [data-a="close-modal"]').click();
  await page.waitForTimeout(80);

  // ── 설정·이력 화면도 가로로 밀리면 안 된다 ──
  await page.locator('[data-a="screen"][data-screen="settings"]').click();
  await page.waitForSelector('[data-a="quick-add-employee"]');
  await noHorizontalOverflow(page, '설정', w);
  // 홈 하단에서 옮겨온 요약(활성 직원 수 · 잔액 합계)이 [직원 목록 관리] 카드 안에서 밀리지 않아야 한다.
  const mgr = await page.evaluate(() => {
    const el = document.querySelector('.mgr-summary');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText.replace(/\n/g, ' ').trim(), left: r.left, right: r.right, scroll: el.scrollWidth, client: el.clientWidth };
  });
  check(Boolean(mgr), `${w}px 설정: 직원 목록 관리 카드 상단 요약(.mgr-summary)이 있어야 한다`);
  if (mgr) {
    check(mgr.text.includes('활성 직원') && mgr.text.includes('잔액 합계'), `${w}px 설정: 요약 문구가 "활성 직원 N명 · 잔액 합계 X원"이어야 한다 ("${mgr.text}")`);
    check(mgr.right <= clientW + 1 && mgr.left >= -1, `${w}px 설정: 요약이 화면 밖으로 나갔다`);
    check(mgr.scroll <= mgr.client + 1, `${w}px 설정: 요약 텍스트가 잘렸다 (${mgr.scroll} > ${mgr.client})`);
  }
  await page.locator('[data-a="screen"][data-screen="history"]').click();
  await page.waitForTimeout(120);
  await noHorizontalOverflow(page, '이력', w);

  // ── 제목이 겹치는 그룹(공공 '여성가족정책과' vs 무소속 '여성가족정책과')은 구분자가 붙어 제목이 길어진다.
  //    좁은 화면에서 그 긴 제목이 화면 밖으로 밀리거나 잘리지 않아야 한다.
  await page.evaluate(({ t }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['employees', 'transactions'], 'readwrite');
      tx.objectStore('employees').put({ id: 'r-emp-4', org: '', orgKind: '', dept: '여성가족정책과', name: '박지훈', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t, updatedAt: t });
      tx.objectStore('transactions').put({ id: 'r-tx-9', employeeId: 'r-emp-4', type: 'open', amount: 9000, beforeBalance: 0, afterBalance: 9000, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: t });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  }), { t: Date.now() });
  await page.reload({ waitUntil: 'load' });
  await unlock(page);
  await noHorizontalOverflow(page, '홈(제목 구분자)', w);
  const dupTitles = (await page.locator('.group-title').allInnerTexts()).map(t => t.trim());
  check(dupTitles.includes('여성가족정책과 (강남구청)'), `${w}px 홈: 제목이 겹치는 공공기관 그룹은 "부서명 (기관명)"이어야 한다 ${JSON.stringify(dupTitles)}`);
  check(dupTitles.includes('여성가족정책과 (소속 없음)'), `${w}px 홈: 제목이 겹치는 무소속 그룹은 "제목 (소속 없음)"이어야 한다 ${JSON.stringify(dupTitles)}`);
  check(new Set(dupTitles).size === dupTitles.length, `${w}px 홈: 그룹 제목이 서로 같으면 구분할 수 없다 ${JSON.stringify(dupTitles)}`);
  const dupHeads = await page.evaluate(() => [...document.querySelectorAll('.group-head')].map(h => {
    const r = h.getBoundingClientRect(), t = h.querySelector('.group-title');
    return { text: t ? t.textContent.trim() : '', left: r.left, right: r.right, clipped: t ? t.scrollWidth > t.clientWidth + 1 : false };
  }));
  dupHeads.forEach(h => {
    check(h.right <= clientW + 1 && h.left >= -1, `${w}px 홈: 구분자가 붙은 그룹 헤더가 화면 밖으로 나갔다 ("${h.text}")`);
    check(!h.clipped, `${w}px 홈: 구분자가 붙은 그룹 제목이 잘렸다 ("${h.text}")`);
  });

  await page.close();
}

async function main() {
  await fsp.mkdir(path.join(root, 'harness', 'screenshots'), { recursive: true }).catch(() => {});
  const { server, url } = await startServer();
  const chromePath = findChrome();
  const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  try {
    for (const w of [360, 390, 412, 768]) {
      const context = await browser.newContext({
        viewport: { width: w, height: 780 },
        isMobile: w <= 640,
        hasTouch: w <= 640,
        deviceScaleFactor: 2
      });
      // 중계 서버 호출은 전부 차단(로컬 렌더링만 검증한다).
      await context.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' }));
      try {
        await runViewport(context, url, w);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length) {
    console.error(`❌ 반응형 검증 실패 ${failures.length}건 / ${checks} 검사`);
    failures.forEach(f => console.error('  · ' + f));
    process.exit(1);
  }
  console.log(`✅ 반응형 검증 ${checks} 통과 (360 / 390 / 412 / 768px)`);
}

main().catch(err => { console.error(err); process.exit(1); });
