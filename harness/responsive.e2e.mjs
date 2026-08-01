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
// orgKind:'public' = 자동 등록(승인·직접 전달)으로 들어온 공공기관 직원 → 홈 그룹 헤더가 "기관명 부서명" 결합 라벨로 나온다(beta.15).
// 그래서 공공기관 헤더는 앱에서 가장 긴 제목이 된다 — 일부러 최악의 실제 사례(광역시명이 붙은 기관명 + 긴 과 이름)를 심는다.
const LONG_ORG = '서울특별시 강남구청';
const LONG_DEPT = '어르신복지과';
const LONG_PUBLIC_TITLE = `${LONG_ORG} ${LONG_DEPT}`;
const SEED_EMPLOYEES = [
  { id: 'r-emp-1', org: '', orgKind: '', dept: '총무부', name: '김민수', amount: 9000 },
  { id: 'r-emp-2', org: LONG_ORG, orgKind: 'public', dept: LONG_DEPT, name: LONG_NAME, amount: 1234567 },
  { id: 'r-emp-3', org: '한빛물산', orgKind: '', dept: '총무부', name: '이서연', amount: 1000000 }
];

async function seed(page) {
  const pinHash = crypto.createHash('sha256').update('1234').digest('hex');
  await page.evaluate(({ emps, pinHash, t, longDept }) => new Promise((resolve, reject) => {
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
      ms.put({ key: 'departments', value: ['총무부', longDept] });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  }), { emps: SEED_EMPLOYEES, pinHash, t: Date.now(), longDept: LONG_DEPT });
}

// beta.18: 잠금 화면의 기본값은 손님 화면 — PIN 패드는 [사장님용 잠금 해제]를 눌러야 나온다.
async function unlock(page) {
  await page.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 8000 });
  if (await page.locator('[data-a="lock-to-pin"]').count()) {
    await page.locator('[data-a="lock-to-pin"]').click();
    await page.waitForSelector('[data-a="pin-key"]');
  }
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

  // ── 홈 상단바 2행 구조(beta.17) ──
  //   1행: 검색창 전폭(폰에서도 300px 이상) / 2행: 소속 필터 + 음성 검색
  //   상단바는 sticky를 유지하고, [장부 저장] 버튼은 홈에 상시 존재해야 한다.
  const bar = await page.evaluate(() => {
    const top = document.querySelector('.top');
    const rows = [...document.querySelectorAll('.home-filters .filter-row')];
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const search = document.querySelector('#searchInput');
    const select = document.querySelector('#deptFilterSelect');
    const mic = document.querySelector('[data-a="voice-search"]');
    const save = document.querySelector('.top .tool [data-a="monthly-backup-now"]');
    const reset = document.querySelector('.top .tool [data-a="reset-filter"]');
    return {
      sticky: getComputedStyle(top).position,
      rows: rows.length,
      row1: rows[0] ? [...rows[0].children].map(c => c.id || c.dataset.a || c.tagName) : [],
      row2: rows[1] ? [...rows[1].children].map(c => c.id || c.dataset.a || c.tagName) : [],
      search: search ? box(search) : null,
      select: select ? box(select) : null,
      mic: mic ? box(mic) : null,
      save: save ? { ...box(save), due: save.dataset.due, text: save.innerText.trim() } : null,
      reset: reset ? box(reset) : null,
      firstOption: select ? select.options[0].textContent.trim() : ''
    };
  });
  check(bar.sticky === 'sticky', `${w}px 상단바: .top은 sticky를 유지해야 한다 (got ${bar.sticky})`);
  check(bar.rows === 2, `${w}px 상단바: 홈 필터는 2행(검색창 / 소속 필터+음성)이어야 한다 (${bar.rows}행)`);
  check(bar.row1.join(',') === 'searchInput', `${w}px 상단바: 첫 행에는 검색창만 있어야 한다 ${JSON.stringify(bar.row1)}`);
  check(bar.row2.join(',') === 'deptFilterSelect,voice-search', `${w}px 상단바: 둘째 행은 소속 필터 + 음성 검색이어야 한다 ${JSON.stringify(bar.row2)}`);
  check(Boolean(bar.search) && bar.search.width >= 300, `${w}px 상단바: 검색창이 전폭(300px 이상)이어야 한다 (${bar.search && Math.round(bar.search.width)}px)`);
  check(Boolean(bar.select) && bar.search.bottom <= bar.select.top + 1, `${w}px 상단바: 소속 필터는 검색창 아래(둘째 행)로 내려가야 한다`);
  check(bar.firstOption === '전체 소속', `${w}px 상단바: 필터 첫 옵션은 '전체 소속'이어야 한다 (got "${bar.firstOption}")`);
  [['검색창', bar.search], ['소속 필터', bar.select], ['음성 검색', bar.mic], ['장부 저장', bar.save], ['검색 초기화', bar.reset]].forEach(([label, b]) => {
    check(Boolean(b), `${w}px 상단바: ${label}이(가) 렌더되지 않았다`);
    if (b) check(b.right <= clientW + 1 && b.left >= -1, `${w}px 상단바: ${label}이(가) 화면 밖으로 나갔다 (${Math.round(b.left)}~${Math.round(b.right)} / ${clientW})`);
  });
  check(Boolean(bar.save) && bar.save.text.includes('장부 저장'), `${w}px 상단바: 홈에는 [장부 저장] 버튼이 상시 있어야 한다 (got "${bar.save && bar.save.text}")`);
  check(Boolean(bar.save) && bar.save.height >= 36, `${w}px 상단바: [장부 저장] 버튼 터치 타겟이 너무 작다 (${bar.save && Math.round(bar.save.height)}px)`);
  check(Boolean(bar.mic) && bar.mic.height >= 44, `${w}px 상단바: 음성 검색 버튼 터치 타겟이 너무 작다 (${bar.mic && Math.round(bar.mic.height)}px)`);
  check(await page.locator('.banner [data-a="monthly-backup-now"]').count() === 0, `${w}px 홈: 월말 백업 배너는 더 이상 렌더되지 않아야 한다(상단 [장부 저장] 버튼으로 대체)`);

  const heads = await page.evaluate(() => [...document.querySelectorAll('.group-head')].map(h => {
    const r = h.getBoundingClientRect();
    return { text: h.innerText.replace(/\n/g, ' ').trim(), height: r.height, left: r.left, right: r.right };
  }));
  check(heads.length === 3, `${w}px 홈: 그룹 헤더 3개(${LONG_PUBLIC_TITLE} / 총무부 / 한빛물산)가 렌더되어야 한다 (${heads.length}개)`);
  check(heads.some(h => h.text.startsWith('▶') && /직원 \d+명/.test(h.text)), `${w}px 홈: 접힌 그룹 헤더에 ▶와 인원수가 보여야 한다 ${JSON.stringify(heads.map(h => h.text))}`);
  heads.forEach(h => {
    if (w <= 640) check(h.height >= 48, `${w}px 홈: 그룹 헤더 터치 타겟이 48px 미만 (${Math.round(h.height)}px · "${h.text}")`);
    check(h.right <= clientW + 1 && h.left >= -1, `${w}px 홈: 그룹 헤더가 화면 밖으로 나갔다 ("${h.text}")`);
  });
  // 공공기관 그룹 헤더는 "기관명 부서명" 결합, 회사 그룹은 회사명만 — 좁은 화면에서도 문구가 그대로여야 한다(축약·생략 금지).
  const headTitles = (await page.locator('.group-title').allInnerTexts()).map(t => t.trim());
  check(headTitles.includes(LONG_PUBLIC_TITLE), `${w}px 홈: 공공기관 그룹 헤더는 "기관명 부서명" 결합 라벨이어야 한다 ${JSON.stringify(headTitles)}`);
  check(headTitles.includes('한빛물산'), `${w}px 홈: 회사 그룹 헤더는 회사명만이어야 한다 ${JSON.stringify(headTitles)}`);
  // 정렬(beta.16): ① 공공기관 ② 그 외 전부 한 블록으로 제목 가나다('총무부' < '한빛물산'). 헤더 순서 자체가 계약이다.
  check(headTitles.join('|') === [LONG_PUBLIC_TITLE, '총무부', '한빛물산'].join('|'),
    `${w}px 홈: 그룹 순서는 공공기관 먼저, 그다음 나머지 전부 제목 가나다여야 한다 ${JSON.stringify(headTitles)}`);
  // 긴 결합 제목이 좁은 화면에서 잘리거나 밖으로 밀리지 않아야 한다(줄바꿈은 허용, 생략표는 불가).
  const longHead = await page.evaluate(({ title }) => {
    const el = [...document.querySelectorAll('.group-title')].find(t => t.textContent.trim() === title);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1, left: r.left, right: r.right, text: el.textContent.trim() };
  }, { title: LONG_PUBLIC_TITLE });
  check(Boolean(longHead), `${w}px 홈: 긴 결합 제목 헤더("${LONG_PUBLIC_TITLE}")를 찾지 못했다 ${JSON.stringify(headTitles)}`);
  if (longHead) {
    check(!longHead.clipped, `${w}px 홈: 긴 결합 제목이 잘렸다 ("${longHead.text}")`);
    check(longHead.right <= clientW + 1 && longHead.left >= -1, `${w}px 홈: 긴 결합 제목이 화면 밖으로 나갔다 ("${longHead.text}")`);
  }

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
  check((await longCard.innerText()).includes(LONG_PUBLIC_TITLE), `${w}px 홈: 소속+부서 결합 라벨이 그대로 보여야 한다`);

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

  // ── 검색 결과 1건 확대 카드(beta.17): 그룹 헤더 없이 한 장만, 긴 이름도 잘리지 않고 화면 안에 ──
  await page.locator('#searchInput').fill('김수한무');
  await page.waitForTimeout(200);
  await noHorizontalOverflow(page, '홈(확대 카드)', w);
  const solo = await page.evaluate(() => {
    const c = document.querySelector('.card.employee.solo');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const px = sel => parseFloat(getComputedStyle(c.querySelector(sel)).fontSize);
    const clip = sel => { const el = c.querySelector(sel); return el.scrollWidth > el.clientWidth + 1; };
    const use = c.querySelector('[data-a="use"]').getBoundingClientRect();
    return {
      left: r.left, right: r.right,
      nameFont: px('.name'), balFont: px('.bal'),
      clipped: ['.name', '.dept', '.bal'].filter(clip),
      useRight: use.right, useHeight: use.height,
      cards: document.querySelectorAll('.card.employee').length,
      heads: document.querySelectorAll('.group-head').length,
      summaries: document.querySelectorAll('.card.summary').length
    };
  });
  check(Boolean(solo), `${w}px 홈: 검색 결과가 1명이면 확대 카드(.card.employee.solo)가 떠야 한다`);
  if (solo) {
    check(solo.cards === 1 && solo.heads === 0, `${w}px 홈: 확대 카드는 그룹 헤더 없이 한 장만이어야 한다 (카드 ${solo.cards}장 / 헤더 ${solo.heads}개)`);
    check(solo.summaries === 0, `${w}px 홈: 손님에게 보여주는 확대 카드 화면에는 매출 요약(오늘 사용·전체 잔액)이 남으면 안 된다`);
    check(solo.nameFont >= 24 && solo.balFont >= 30, `${w}px 홈: 확대 카드의 이름·잔액이 실제로 커야 한다 (이름 ${solo.nameFont}px / 잔액 ${solo.balFont}px)`);
    check(solo.clipped.length === 0, `${w}px 홈: 확대 카드에서 잘린 텍스트 ${JSON.stringify(solo.clipped)}`);
    check(solo.left >= -1 && solo.right <= clientW + 1, `${w}px 홈: 확대 카드가 화면 밖으로 나갔다`);
    check(solo.useRight <= clientW + 1, `${w}px 홈: 확대 카드의 [사용] 버튼이 화면 밖으로 나갔다`);
    check(solo.useHeight >= 56, `${w}px 홈: 확대 카드의 [사용] 버튼이 커져야 한다 (${Math.round(solo.useHeight)}px)`);
  }

  // ── 사용 등록 모달: 모든 액션 버튼이 화면 안에 있어야 한다(저장 버튼 미노출 회귀 방지) ──
  await page.locator(`[data-a="use"][data-id="r-emp-2"]`).click();
  await page.waitForSelector('#useAmount');
  await noHorizontalOverflow(page, '사용 등록 모달', w);
  // 빠른 금액 3버튼(beta.17)이 한 줄에 들어가고 화면 밖으로 나가지 않아야 한다.
  const quick = await page.evaluate(() => [...document.querySelectorAll('[data-a="fill-use"]')].map(b => {
    const r = b.getBoundingClientRect();
    return { text: b.innerText.trim(), left: r.left, right: r.right, top: r.top, height: r.height };
  }));
  check(quick.length === 3, `${w}px 모달: 빠른 금액 버튼이 3개여야 한다 (${quick.length}개)`);
  quick.forEach(b => {
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px 모달: 빠른 금액 "${b.text}" 버튼이 화면 밖이다`);
    check(b.height >= 44, `${w}px 모달: 빠른 금액 "${b.text}" 버튼 터치 타겟이 작다 (${Math.round(b.height)}px)`);
  });
  check(quick.length === 3 && quick.every(b => Math.abs(b.top - quick[0].top) <= 2), `${w}px 모달: 빠른 금액 3버튼은 한 줄에 있어야 한다 ${JSON.stringify(quick.map(b => Math.round(b.top)))}`);
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
  await page.locator('#searchInput').fill('');
  await page.waitForTimeout(120);

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

  // ── 제목이 겹치는 그룹(공공기관 결합 라벨 vs 레거시 합성 부서명이 글자까지 똑같은 경우)은 종류 꼬리표가 붙어
  //    제목이 더 길어진다. 좁은 화면에서 그 최악 길이의 제목이 화면 밖으로 밀리거나 잘리지 않아야 한다.
  await page.evaluate(({ t, dupDept }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('prepaid-ledger-db');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['employees', 'transactions'], 'readwrite');
      tx.objectStore('employees').put({ id: 'r-emp-4', org: '', orgKind: '', dept: dupDept, name: '박지훈', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t, updatedAt: t });
      tx.objectStore('transactions').put({ id: 'r-tx-9', employeeId: 'r-emp-4', type: 'open', amount: 9000, beforeBalance: 0, afterBalance: 9000, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: t });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  }), { t: Date.now(), dupDept: LONG_PUBLIC_TITLE });
  await page.reload({ waitUntil: 'load' });
  await unlock(page);
  await noHorizontalOverflow(page, '홈(제목 구분자)', w);
  const dupTitles = (await page.locator('.group-title').allInnerTexts()).map(t => t.trim());
  check(dupTitles.includes(`${LONG_PUBLIC_TITLE} (공공기관)`), `${w}px 홈: 제목이 겹치는 공공기관 그룹은 "제목 (공공기관)"이어야 한다 ${JSON.stringify(dupTitles)}`);
  check(dupTitles.includes(`${LONG_PUBLIC_TITLE} (소속 없음)`), `${w}px 홈: 제목이 겹치는 무소속 그룹은 "제목 (소속 없음)"이어야 한다 ${JSON.stringify(dupTitles)}`);
  check(new Set(dupTitles).size === dupTitles.length, `${w}px 홈: 그룹 제목이 서로 같으면 구분할 수 없다 ${JSON.stringify(dupTitles)}`);
  const dupHeads = await page.evaluate(() => [...document.querySelectorAll('.group-head')].map(h => {
    const r = h.getBoundingClientRect(), t = h.querySelector('.group-title');
    return { text: t ? t.textContent.trim() : '', left: r.left, right: r.right, clipped: t ? (t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1) : false };
  }));
  dupHeads.forEach(h => {
    check(h.right <= clientW + 1 && h.left >= -1, `${w}px 홈: 구분자가 붙은 그룹 헤더가 화면 밖으로 나갔다 ("${h.text}")`);
    check(!h.clipped, `${w}px 홈: 구분자가 붙은 그룹 제목이 잘렸다 ("${h.text}")`);
  });


  // ── 손님 화면(beta.18): 검색창·결과 행·확인 카드·최근 5건·버튼이 4개 뷰포트에서 온전해야 한다 ──
  //    손님이 직접 만지는 유일한 화면이라 터치 타겟(48px+)과 비잘림이 특히 중요하다.
  await page.locator('[data-a="hand-to-customer"]').click();
  await page.waitForSelector('.cust-screen');
  await noHorizontalOverflow(page, '손님 화면(검색)', w);
  const custSearch = await page.evaluate(() => {
    const i = document.querySelector('#custSearchInput');
    const owner = document.querySelector('[data-a="lock-to-pin"]');
    if (!i) return null;
    const r = i.getBoundingClientRect(), o = owner.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height, ownerTop: o.top, ownerHeight: o.height, rows: document.querySelectorAll('.cust-row').length };
  });
  check(Boolean(custSearch), `${w}px 손님 화면: 검색창(#custSearchInput)이 렌더되어야 한다`);
  if (custSearch) {
    check(custSearch.rows === 0, `${w}px 손님 화면: 이름을 입력하기 전에는 아무도 보이면 안 된다 (${custSearch.rows}행)`);
    check(custSearch.height >= 48, `${w}px 손님 화면: 검색창 터치 타겟이 작다 (${Math.round(custSearch.height)}px)`);
    check(custSearch.width >= 280, `${w}px 손님 화면: 검색창이 충분히 넓어야 한다 (${Math.round(custSearch.width)}px)`);
    check(custSearch.left >= -1 && custSearch.right <= clientW + 1, `${w}px 손님 화면: 검색창이 화면 밖으로 나갔다`);
  }
  // 결과 행 — 긴 "기관명 부서명" 라벨 + 긴 이름이 함께 있어도 잘리거나 밀리면 안 된다.
  await page.locator('#custSearchInput').fill('김');
  await page.waitForTimeout(200);
  await noHorizontalOverflow(page, '손님 화면(결과)', w);
  const custRows = await page.evaluate(() => [...document.querySelectorAll('.cust-row')].map(el => {
    const r = el.getBoundingClientRect();
    const clip = sel => { const t = el.querySelector(sel); return t ? (t.scrollWidth > t.clientWidth + 1) : false; };
    return { text: el.innerText.replace(/\n/g, ' ').trim(), height: r.height, left: r.left, right: r.right, clipped: ['.cust-row-label', '.cust-row-name'].filter(clip) };
  }));
  check(custRows.length === 2, `${w}px 손님 화면: '김' 검색은 2명(김민수·긴 이름)을 내놓아야 한다 (${custRows.length}행)`);
  custRows.forEach(r => {
    check(r.height >= 48, `${w}px 손님 화면: 결과 행 터치 타겟이 48px 미만 (${Math.round(r.height)}px · "${r.text}")`);
    check(r.left >= -1 && r.right <= clientW + 1, `${w}px 손님 화면: 결과 행이 화면 밖으로 나갔다 ("${r.text}")`);
    check(r.clipped.length === 0, `${w}px 손님 화면: 결과 행에서 잘린 텍스트 ${JSON.stringify(r.clipped)} ("${r.text}")`);
  });
  check(!/\d{1,3},\d{3}원/.test(custRows.map(r => r.text).join(' ')), `${w}px 손님 화면: 결과 행에는 잔액이 절대 보이면 안 된다`);

  // 확인 카드 — [네, 맞아요]/[아니요] 두 버튼 모두 큰 터치 타겟이어야 한다.
  await page.locator('#custSearchInput').fill('김수한무');
  await page.waitForSelector('.cust-ask');
  await noHorizontalOverflow(page, '손님 화면(확인 카드)', w);
  const custConfirm = await page.evaluate(() => {
    const card = document.querySelector('.cust-card'), r = card.getBoundingClientRect();
    const name = card.querySelector('.cust-name');
    return {
      left: r.left, right: r.right,
      nameClipped: name.scrollWidth > name.clientWidth + 1,
      buttons: [...card.querySelectorAll('.cust-actions button')].map(b => { const q = b.getBoundingClientRect(); return { text: b.innerText.trim(), height: q.height, left: q.left, right: q.right }; })
    };
  });
  check(custConfirm.left >= -1 && custConfirm.right <= clientW + 1, `${w}px 손님 화면: 확인 카드가 화면 밖으로 나갔다`);
  check(!custConfirm.nameClipped, `${w}px 손님 화면: 확인 카드의 이름이 잘렸다`);
  check(custConfirm.buttons.length === 2, `${w}px 손님 화면: 확인 카드에는 [네, 맞아요]/[아니요] 두 버튼이 있어야 한다 (${custConfirm.buttons.length}개)`);
  custConfirm.buttons.forEach(b => {
    check(b.height >= 48, `${w}px 손님 화면: 확인 버튼 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px 손님 화면: 확인 버튼 "${b.text}"이(가) 화면 밖이다`);
  });

  // 본인 화면 — 7자리 잔액 전액 표기 + 최근 거래 슬림 행(서명 이미지 없음) + 두 버튼.
  await page.locator('[data-a="cust-confirm"]').click();
  await page.waitForSelector('.cust-bal');
  await noHorizontalOverflow(page, '손님 화면(본인)', w);
  const custSelf = await page.evaluate(() => {
    const card = document.querySelector('.cust-card');
    const bal = card.querySelector('.cust-bal');
    const br = bal.getBoundingClientRect();
    return {
      balText: bal.textContent.trim(), balFont: parseFloat(getComputedStyle(bal).fontSize),
      balClipped: bal.scrollWidth > bal.clientWidth + 1, balLeft: br.left, balRight: br.right,
      imgs: card.querySelectorAll('img').length,
      txs: [...card.querySelectorAll('.cust-tx')].map(t => { const r = t.getBoundingClientRect(); return { left: r.left, right: r.right, clipped: t.scrollWidth > t.clientWidth + 1 }; }),
      buttons: [...card.querySelectorAll('.cust-actions button')].map(b => { const q = b.getBoundingClientRect(); return { text: b.innerText.trim(), height: q.height, left: q.left, right: q.right }; })
    };
  });
  check(custSelf.balText.includes('1,234,567원'), `${w}px 손님 화면: 7자리 잔액이 전액으로 표기되어야 한다 (got "${custSelf.balText}")`);
  check(!custSelf.balClipped, `${w}px 손님 화면: 잔액이 잘렸다 ("${custSelf.balText}")`);
  check(custSelf.balLeft >= -1 && custSelf.balRight <= clientW + 1, `${w}px 손님 화면: 잔액이 화면 밖으로 나갔다`);
  check(custSelf.balFont >= 30, `${w}px 손님 화면: 잔액 글자가 충분히 커야 한다 (${custSelf.balFont}px)`);
  check(custSelf.imgs === 0, `${w}px 손님 화면: 손님 화면에는 서명 이미지가 절대 없어야 한다 (${custSelf.imgs}장)`);
  check(custSelf.txs.length >= 1 && custSelf.txs.length <= 5, `${w}px 손님 화면: 최근 거래는 1~5건이어야 한다 (${custSelf.txs.length}건)`);
  custSelf.txs.forEach((t, i) => {
    check(t.left >= -1 && t.right <= clientW + 1, `${w}px 손님 화면: 최근 거래 ${i + 1}행이 화면 밖으로 나갔다`);
    check(!t.clipped, `${w}px 손님 화면: 최근 거래 ${i + 1}행이 잘렸다`);
  });
  check(custSelf.buttons.length === 2, `${w}px 손님 화면: 본인 화면에는 [사장님께 보여주기]/[처음으로] 두 버튼이 있어야 한다 (${custSelf.buttons.length}개)`);
  custSelf.buttons.forEach(b => {
    check(b.height >= 48, `${w}px 손님 화면: 버튼 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px 손님 화면: 버튼 "${b.text}"이(가) 화면 밖이다`);
  });
  await page.locator('[data-a="cust-call-owner"]').click();
  await page.waitForSelector('.cust-done');
  await noHorizontalOverflow(page, '손님 화면(호출 완료)', w);
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-customer-${w}.png`) }).catch(() => {});

  // ── PIN 분실 복구 화면(beta.18): 60초 활성화 게이트 안내와 두 파괴 버튼이 4개 뷰포트에서 온전해야 한다 ──
  //    잠금 화면에서 도달 가능한 유일한 파괴 경로라, 안내 문구가 잘리거나 버튼이 화면 밖으로 나가면 안 된다.
  await page.locator('[data-a="lock-to-pin"]').click();
  await page.waitForSelector('[data-a="pin-key"]');
  await noHorizontalOverflow(page, 'PIN 화면', w);
  await page.locator('[data-a="pin-forgot"]').click();
  await page.waitForSelector('[data-a="pin-forgot-restore"]');
  await noHorizontalOverflow(page, 'PIN 복구 화면', w);
  const recovery = await page.evaluate(() => {
    const gate = document.querySelector('.pin-screen .pin-delay');
    const g = gate ? gate.getBoundingClientRect() : null;
    return {
      gateText: gate ? gate.innerText.replace(/\n/g, ' ').trim() : '',
      gateLeft: g ? g.left : 0, gateRight: g ? g.right : 0,
      gateClipped: gate ? gate.scrollHeight > gate.clientHeight + 1 : false,
      buttons: [...document.querySelectorAll('.pin-screen .action-btn')].map(b => {
        const r = b.getBoundingClientRect();
        return { text: b.innerText.replace(/\n/g, ' ').trim().slice(0, 24), height: r.height, left: r.left, right: r.right, disabled: b.disabled };
      })
    };
  });
  check(recovery.gateText.includes('잘못 누름 방지'), `${w}px PIN 복구 화면: 60초 활성화 게이트 안내가 보여야 한다 (got "${recovery.gateText}")`);
  check(!recovery.gateClipped, `${w}px PIN 복구 화면: 게이트 안내 문구가 잘렸다 ("${recovery.gateText}")`);
  check(recovery.gateLeft >= -1 && recovery.gateRight <= clientW + 1, `${w}px PIN 복구 화면: 게이트 안내가 화면 밖으로 나갔다`);
  check(recovery.buttons.length === 2, `${w}px PIN 복구 화면: 복구/초기화 두 버튼이 있어야 한다 (${recovery.buttons.length}개)`);
  recovery.buttons.forEach(b => {
    check(b.disabled === true, `${w}px PIN 복구 화면: 게이트가 도는 동안 "${b.text}" 버튼은 비활성이어야 한다`);
    check(b.height >= 48, `${w}px PIN 복구 화면: "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px PIN 복구 화면: "${b.text}" 버튼이 화면 밖이다`);
  });
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-pin-recovery-${w}.png`) }).catch(() => {});

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
