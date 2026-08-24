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

let chromium, devices;
try {
  ({ chromium, devices } = await import('playwright'));
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
// beta.25: 긴 이름 직원에게는 거래를 **5건** 심는다(등록 1 + 충전 4).
//   상세(최근 내역) 화면은 "최근 5건"을 보여주는 화면이다 — 1건짜리 시드로 재면 그 화면이 가장 길어지는
//   실제 상태를 통째로 못 본다. beta.24의 결함(버튼 3개가 전부 접힘 아래)이 정확히 그 사각지대에 있었다.
//   합계는 그대로 1,234,567원이다(등록 1,234,563 + 1원 충전 4번) — 다른 금액 단언은 하나도 흔들리지 않는다.
const TOPUPS = 4;
const SEED_EMPLOYEES = [
  { id: 'r-emp-1', org: '', orgKind: '', dept: '총무부', name: '김민수', amount: 9000, topups: 0 },
  { id: 'r-emp-2', org: LONG_ORG, orgKind: 'public', dept: LONG_DEPT, name: LONG_NAME, amount: 1234567, topups: TOPUPS },
  { id: 'r-emp-3', org: '한빛물산', orgKind: '', dept: '총무부', name: '이서연', amount: 1000000, topups: 0 }
];

async function seed(page, employees = SEED_EMPLOYEES) {
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
        const n = e.topups || 0, open = e.amount - n;
        ts.put({ id: 'r-tx-' + i, employeeId: e.id, type: 'open', amount: open, beforeBalance: 0, afterBalance: open, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: t });
        for (let k = 0; k < n; k += 1) {
          ts.put({ id: `r-tx-${i}-t${k}`, employeeId: e.id, type: 'topup', amount: 1, beforeBalance: open + k, afterBalance: open + k + 1, reason: '추가 선입금', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: t + k + 1 });
        }
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
  }), { emps: employees, pinHash, t: Date.now(), longDept: LONG_DEPT });
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

// ── 온보딩 1/3 "우리 가게 찾기" (beta.26) ─────────────────────────────────────────
//   신규 설치가 **가장 먼저** 만나는 화면이다. 여기서 막히면 그 뒤 모든 화면은 존재하지 않는 것과 같다.
//   계약: 검색창 두 칸 · [가게 찾기] · [직접 입력할게요](탈출구)가 **초기 뷰포트**(스크롤 0) 안에 있고,
//         검색 결과 첫 줄과 고른 뒤의 [다음]도 마찬가지다. 손가락 표적은 전부 44px 이상.
const STORE_MOCK = [
  { restaurant_id: 'rid-a', name: '하네스김밥 본점', address: '서울특별시 광진구 아차산로 399, 1층 (구의동)', tel: '02-111-2222' },
  { restaurant_id: 'rid-b', name: '하네스김밥 2호점', address: '서울특별시 광진구 능동로 120 (화양동)', tel: '02-333-4444' }
];
async function checkOnboardingStep1(page, label) {
  // beta.27: 1/3 앞에 환영 화면(0단계)이 한 장 붙었다 — 그 화면도 [시작하기]까지 스크롤 없이 들어와야 한다
  //   (여기서 막히면 1/3에는 닿지도 못한다). 지나면 곧바로 1/3이고, 다시 뜨지 않는다.
  await page.waitForSelector('[data-a="setup-welcome-start"], #setupStoreName', { timeout: 8000 });
  if (await page.locator('[data-a="setup-welcome-start"]').count()) {
    await noHorizontalOverflow(page, '온보딩 0(환영)', label);
    const wm = await page.evaluate(() => {
      window.scrollTo(0, 0);
      const b = document.querySelector('[data-a="setup-welcome-start"]').getBoundingClientRect();
      return { vh: window.innerHeight, scrollY: window.scrollY, top: b.top, bottom: b.bottom, height: b.height, steps: document.querySelectorAll('.setup-step').length };
    });
    check(wm.scrollY === 0, `${label} 환영 화면: 검사는 초기 뷰포트(스크롤 0)에서 이뤄져야 한다`);
    check(wm.steps === 0, `${label} 환영 화면: 단계 번호(1/3·2/3·3/3)를 달지 않는다 — 이 화면은 세는 단계가 아니다`);
    check(wm.bottom <= wm.vh + 1, `${label} 환영 화면: [시작하기]가 스크롤 없이 보이지 않는다 (아래로 ${Math.max(0, Math.round(wm.bottom - wm.vh))}px 벗어남 / vh ${wm.vh})`);
    check(wm.height >= 44, `${label} 환영 화면: [시작하기] 터치 타겟이 44px 미만 (${Math.round(wm.height)}px)`);
    await page.locator('[data-a="setup-welcome-start"]').click();
  }
  await page.waitForSelector('#setupStoreName', { timeout: 8000 });
  await noHorizontalOverflow(page, '온보딩 1/3(검색)', label);
  const measure = () => page.evaluate(() => {
    window.scrollTo(0, 0);
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
    const q = s => document.querySelector(s);
    return {
      vh: window.innerHeight, scrollY: window.scrollY, clientW: document.documentElement.clientWidth,
      step: (q('.setup-step') || {}).textContent || '',
      name: box(q('#setupStoreName')), region: box(q('#setupStoreRegion')),
      search: box(q('[data-a="setup-store-search"]')), manual: box(q('[data-a="setup-manual-toggle"]')),
      firstResult: box(q('[data-a="setup-store-pick"]')),
      tel: box(q('#setupStoreTel')), next: box(q('[data-a="setup-next"]'))
    };
  });
  const pre = await measure();
  const vis = (m, r) => Boolean(r) && r.top >= -1 && r.bottom <= m.vh + 1;
  const inside = (m, r) => Boolean(r) && r.left >= -1 && r.right <= m.clientW + 1;
  check(pre.scrollY === 0, `${label} 온보딩 1/3: 검사는 초기 뷰포트(스크롤 0)에서 이뤄져야 한다`);
  check(pre.step.includes('1 / 3'), `${label} 온보딩 1/3: 단계 표시가 "1 / 3"이어야 한다 (got "${pre.step.trim()}")`);
  [['가게 이름 칸', pre.name], ['지역 칸', pre.region], ['[가게 찾기]', pre.search], ['[직접 입력할게요]', pre.manual]].forEach(([nm, r]) => {
    check(Boolean(r), `${label} 온보딩 1/3: ${nm}이(가) 렌더되지 않았다`);
    check(vis(pre, r), `${label} 온보딩 1/3: ${nm}이(가) 스크롤 없이 보이지 않는다 (아래로 ${r ? Math.max(0, Math.round(r.bottom - pre.vh)) : '?'}px 벗어남 / vh ${pre.vh})`);
    check(inside(pre, r), `${label} 온보딩 1/3: ${nm}이(가) 화면 밖으로 나갔다`);
    check(Boolean(r) && r.height >= 44, `${label} 온보딩 1/3: ${nm} 터치 타겟이 44px 미만 (${r ? Math.round(r.height) : '?'}px)`);
  });

  // 검색 결과 — 첫 줄의 [이 가게] 버튼이 접힘 아래로 밀리면 고를 수가 없다.
  await page.locator('#setupStoreName').fill('하네스김밥');
  await page.locator('[data-a="setup-store-search"]').click();
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 8000 });
  await noHorizontalOverflow(page, '온보딩 1/3(결과)', label);
  const found = await measure();
  check(vis(found, found.firstResult), `${label} 온보딩 1/3: 검색 결과 첫 줄의 [이 가게]가 스크롤 없이 보이지 않는다 (아래로 ${found.firstResult ? Math.max(0, Math.round(found.firstResult.bottom - found.vh)) : '?'}px 벗어남 / vh ${found.vh})`);
  check(inside(found, found.firstResult), `${label} 온보딩 1/3: 검색 결과 첫 줄이 화면 밖으로 나갔다`);
  check(Boolean(found.firstResult) && found.firstResult.height >= 44, `${label} 온보딩 1/3: [이 가게] 터치 타겟이 44px 미만 (${found.firstResult ? Math.round(found.firstResult.height) : '?'}px)`);
  check(vis(found, found.manual), `${label} 온보딩 1/3: 결과가 있어도 탈출구([직접 입력할게요])는 남아야 한다`);

  // 고른 뒤 확인 화면 — 전화가 자동으로 채워지고 [다음]까지 한 화면에 들어와야 한다.
  if (page.listenerCount('dialog') === 0) page.once('dialog', d => d.accept());
  await page.locator('[data-a="setup-store-pick"]').first().click();
  await page.waitForSelector('[data-a="setup-next"]', { timeout: 8000 });
  await noHorizontalOverflow(page, '온보딩 1/3(선택 확인)', label);
  const picked = await measure();
  check((await page.locator('#setupStoreTel').inputValue()) === '02-111-2222', `${label} 온보딩 1/3: 고른 가게의 전화번호가 자동으로 채워져야 한다`);
  [['전화번호 칸', picked.tel], ['[다음]', picked.next]].forEach(([nm, r]) => {
    check(vis(picked, r), `${label} 온보딩 1/3: ${nm}이(가) 스크롤 없이 보이지 않는다 (아래로 ${r ? Math.max(0, Math.round(r.bottom - picked.vh)) : '?'}px 벗어남 / vh ${picked.vh})`);
    check(inside(picked, r), `${label} 온보딩 1/3: ${nm}이(가) 화면 밖으로 나갔다`);
    check(Boolean(r) && r.height >= 44, `${label} 온보딩 1/3: ${nm} 터치 타겟이 44px 미만 (${r ? Math.round(r.height) : '?'}px)`);
  });
}

// ── 통합 요청 화면이 "폰 세로 한 화면"에 들어오는가 (beta.23 HIGH-1의 못) ──────────────
// 관대함 봉인: scrollIntoView 뒤에 재지 않는다. **초기 뷰포트**(scrollY=0)에서 잰다.
//   대상은 셋이다 — 금액 입력칸 / 서명판 **전체**(윗변·아랫변 모두) / 버튼 3개 전부.
//   하나라도 접힌 곳(fold) 아래에 있으면 실패다. 실측 근거: beta.22 iPhone 13에서 서명판은
//   180px 중 107px만 보였고 [사장님 확인 받기]는 화면 밖 174px 아래였다.
async function fitsInFirstViewport(page, tag) {
  const m = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
    return {
      scrollY: window.scrollY, vh: window.innerHeight,
      input: box(document.querySelector('#custAmountInput')),
      canvas: box(document.querySelector('.cust-sig #signCanvas')),
      buttons: [...document.querySelectorAll('.cust-actions button')].map(b => ({ text: b.innerText.trim(), ...box(b) })),
      links: [...document.querySelectorAll('.cust-links button')].map(b => ({ text: b.innerText.replace(/\n/g, ' ').trim(), ...box(b) }))
    };
  });
  const vis = r => r.top >= -1 && r.bottom <= m.vh + 1;
  check(m.scrollY === 0, `${tag} 통합 요청 화면: 검사는 초기 뷰포트(스크롤 0)에서 이뤄져야 한다`);
  check(vis(m.input), `${tag} 통합 요청 화면: 금액 입력칸이 스크롤 없이 보이지 않는다 (${Math.round(m.input.top)}~${Math.round(m.input.bottom)} / vh ${m.vh})`);
  check(vis(m.canvas), `${tag} 통합 요청 화면: 서명판이 스크롤 없이 **전부** 보이지 않는다 (${Math.round(m.canvas.top)}~${Math.round(m.canvas.bottom)} / vh ${m.vh}, 잘린 높이 ${Math.max(0, Math.round(m.canvas.bottom - m.vh))}px)`);
  check(m.buttons.length === 3, `${tag} 통합 요청 화면: 버튼이 3개여야 한다 (${m.buttons.length}개)`);
  m.buttons.forEach(b => {
    check(vis(b), `${tag} 통합 요청 화면: 버튼 "${b.text}"이(가) 스크롤 없이 보이지 않는다 (아래로 ${Math.max(0, Math.round(b.bottom - m.vh))}px 벗어남 / vh ${m.vh})`);
    check(b.height >= 48, `${tag} 통합 요청 화면: 버튼 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
  });
  // beta.24: 보조 링크 두 개([최근 사용 내역 보기] · [금액을 모르겠어요/사장님 부르기])도 같은 계약을 진다.
  //   이 둘은 "조회만 하러 온 손님"과 "금액을 정할 수 없는 손님"이 갈 수 있는 유일한 길이다 —
  //   접힌 곳 아래로 밀려나면 그 손님들에게는 없는 것과 같다(작은 링크라도 48px 표적을 지킨다).
  check(m.links.length === 2, `${tag} 통합 요청 화면: 보조 링크는 2개여야 한다 (${m.links.length}개)`);
  m.links.forEach(b => {
    check(vis(b), `${tag} 통합 요청 화면: 보조 링크 "${b.text}"이(가) 스크롤 없이 보이지 않는다 (아래로 ${Math.max(0, Math.round(b.bottom - m.vh))}px 벗어남 / vh ${m.vh})`);
    check(b.height >= 48, `${tag} 통합 요청 화면: 보조 링크 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
  });
  // beta.25(L4): 여유(slack)까지 계약이다. "간신히 들어온다"는 상태는 오류 한 줄·글꼴 한 단계에 곧바로 깨진다.
  const slack = Math.round(m.vh - Math.max(m.canvas.bottom, ...m.buttons.map(b => b.bottom), ...m.links.map(b => b.bottom)));
  check(slack >= 30, `${tag} 통합 요청 화면: 마지막 요소 아래 여유가 ${slack}px뿐이다(30px 이상이어야 한다 — 오류 한 줄이면 곧바로 접힌다)`);
  return { ...m, slack };
}

// ── 상세(최근 내역) 화면도 같은 계약을 진다 (beta.25) ──────────────────────────
//   beta.24 실측: 거래 5건 손님 기준 360×640·390×664에서 [사용 요청 계속하기]·[사장님 부르기]·[처음으로]
//   **셋 다** 초기 뷰포트 밖이었다(412×732에서도 둘이 밖). 초안을 들고 잠깐 내역을 보러 온 손님에게
//   작성 화면으로 돌아갈 길이 통째로 보이지 않았다 — 그런데 이 계약이 compose에만 걸려 있어 못 봤다.
//   → 목록(.cust-txs)은 잘려도 된다(내부 스크롤로 닿는다). **버튼 줄은 언제나 화면 안**이다.
async function detailFitsInFirstViewport(page, tag) {
  const m = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
    const txs = document.querySelector('.cust-txs');
    return {
      scrollY: window.scrollY, vh: window.innerHeight, docH: document.documentElement.scrollHeight,
      bal: box(document.querySelector('.cust-bal')),
      txCount: document.querySelectorAll('.cust-tx').length,
      txsScrollable: txs ? getComputedStyle(txs).overflowY : '',
      txsClipped: txs ? txs.scrollHeight > txs.clientHeight + 1 : false,
      note: document.querySelector('.cust-draft-note') ? box(document.querySelector('.cust-draft-note')) : null,
      noteLines: document.querySelector('.cust-draft-note') ? Math.round(document.querySelector('.cust-draft-note').getBoundingClientRect().height) : 0,
      buttons: [...document.querySelectorAll('.cust-actions button')].map(b => ({ text: b.innerText.trim(), ...box(b) }))
    };
  });
  const vis = r => r.top >= -1 && r.bottom <= m.vh + 1;
  check(m.scrollY === 0, `${tag} 상세 화면: 검사는 초기 뷰포트(스크롤 0)에서 이뤄져야 한다`);
  check(m.txCount === 5, `${tag} 상세 화면: 최근 5건 시드에서는 5건이 렌더되어야 한다 (${m.txCount}건)`);
  check(vis(m.bal), `${tag} 상세 화면: 잔액이 스크롤 없이 보이지 않는다 (${Math.round(m.bal.top)}~${Math.round(m.bal.bottom)} / vh ${m.vh})`);
  check(m.buttons.length === 3, `${tag} 상세 화면: 버튼이 3개여야 한다 (${m.buttons.length}개)`);
  m.buttons.forEach(b => {
    check(vis(b), `${tag} 상세 화면: 버튼 "${b.text}"이(가) 스크롤 없이 보이지 않는다 (아래로 ${Math.max(0, Math.round(b.bottom - m.vh))}px 벗어남 / vh ${m.vh})`);
    check(b.height >= 48, `${tag} 상세 화면: 버튼 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
  });
  // 초안 안내는 **한 줄**이다 — 두 줄이 되면 그 자체가 버튼을 밀어내는 원가가 된다(beta.24의 실제 원인).
  if (m.note) {
    check(vis(m.note), `${tag} 상세 화면: 초안 안내가 스크롤 없이 보이지 않는다`);
    check(m.noteLines <= 34, `${tag} 상세 화면: 초안 안내는 한 줄이어야 한다 (높이 ${m.noteLines}px)`);
  }
  // 목록이 잘릴 때는 반드시 목록 **자체가** 스크롤 영역이어야 한다(화면 전체가 스크롤되면 버튼이 접힘 아래로 간다).
  if (m.txsClipped) check(m.txsScrollable === 'auto' || m.txsScrollable === 'scroll', `${tag} 상세 화면: 최근 내역이 잘렸는데 목록이 스크롤 영역이 아니다 (overflow-y: ${m.txsScrollable})`);
  return m;
}

// ⚠️ 높이는 더 이상 780 고정이 아니다(beta.23) — 780px는 어떤 실기기의 가시영역보다도 넉넉해서
//   "폰에서 버튼이 화면 밖에 있다"는 결함을 통째로 가려 준다. 실제 브라우저 가시높이로 잰다.
//   360×640(작은 안드로이드) · 390×664(iPhone 13 Safari) · 412×732(Pixel 7 Chrome) · 768×1024(태블릿).
const VIEWPORTS = [
  { w: 360, h: 640 },
  { w: 390, h: 664 },
  { w: 412, h: 732 },
  { w: 768, h: 1024 }
];
async function runViewport(context, url, w, h) {
  const page = await context.newPage();
  await page.setViewportSize({ width: w, height: h });
  page.on('dialog', d => d.accept());
  // 가게 검색만 목 데이터를 내려준다(catch-all `**/api/**`보다 나중에 등록해 우선순위를 얻는다).
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(STORE_MOCK) }));
  await page.goto(url, { waitUntil: 'load' });
  // 신규 설치가 처음 만나는 화면(온보딩 1/3)을 시드 전에 먼저 검증한다.
  await checkOnboardingStep1(page, `${w}px`);
  await seed(page);
  await page.reload({ waitUntil: 'load' });
  await unlock(page);

  // ── 홈: 가로 스크롤 없음 (접힌 기본 상태) ──
  await noHorizontalOverflow(page, '홈(그룹 접힘)', w);

  // ── 그룹 헤더(아코디언): 손가락 터치 타겟 + 화면 안쪽 ──
  const clientW = await page.evaluate(() => document.documentElement.clientWidth);

  // ── 홈 상단바 2행 구조(beta.17 → beta.29 개편) ──
  //   1행: 검색창 전폭(폰에서도 300px 이상, 지울 것이 있으면 ✕가 옆에 붙음) / 2행: 소속 필터 + 음성 검색
  //   상단바는 sticky를 유지하고, [장부 저장] 상시 버튼은 폐지 → [직원 목록 관리] 바로가기가 자리를 잇는다.
  const readBar = () => page.evaluate(() => {
    const top = document.querySelector('.top');
    const rows = [...document.querySelectorAll('.home-filters .filter-row')];
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const search = document.querySelector('#searchInput');
    const select = document.querySelector('#deptFilterSelect');
    const mic = document.querySelector('[data-a="voice-search"]');
    const goEmp = document.querySelector('.top .tool [data-a="go-employees"]');
    const clear = document.querySelector('.filter-row [data-a="reset-filter"]');
    return {
      sticky: getComputedStyle(top).position,
      rows: rows.length,
      row1: rows[0] ? [...rows[0].children].map(c => c.id || c.dataset.a || c.tagName) : [],
      row2: rows[1] ? [...rows[1].children].map(c => c.id || c.dataset.a || c.tagName) : [],
      search: search ? box(search) : null,
      select: select ? box(select) : null,
      mic: mic ? box(mic) : null,
      goEmp: goEmp ? { ...box(goEmp), text: goEmp.innerText.trim() } : null,
      clear: clear ? box(clear) : null,
      saveBtnCount: document.querySelectorAll('[data-a="monthly-backup-now"]').length,
      topReset: document.querySelectorAll('.top .tool [data-a="reset-filter"]').length,
      firstOption: select ? select.options[0].textContent.trim() : ''
    };
  });
  const bar = await readBar();
  check(bar.sticky === 'sticky', `${w}px 상단바: .top은 sticky를 유지해야 한다 (got ${bar.sticky})`);
  check(bar.rows === 2, `${w}px 상단바: 홈 필터는 2행(검색창 / 소속 필터+음성)이어야 한다 (${bar.rows}행)`);
  check(bar.row1.join(',') === 'searchInput', `${w}px 상단바: 지울 것이 없으면 첫 행에는 검색창만 있어야 한다 ${JSON.stringify(bar.row1)}`);
  check(bar.row2.join(',') === 'deptFilterSelect,voice-search', `${w}px 상단바: 둘째 행은 소속 필터 + 음성 검색이어야 한다 ${JSON.stringify(bar.row2)}`);
  check(Boolean(bar.search) && bar.search.width >= 300, `${w}px 상단바: 검색창이 전폭(300px 이상)이어야 한다 (${bar.search && Math.round(bar.search.width)}px)`);
  check(Boolean(bar.select) && bar.search.bottom <= bar.select.top + 1, `${w}px 상단바: 소속 필터는 검색창 아래(둘째 행)로 내려가야 한다`);
  check(bar.firstOption === '전체 소속', `${w}px 상단바: 필터 첫 옵션은 '전체 소속'이어야 한다 (got "${bar.firstOption}")`);
  check(bar.saveBtnCount === 0, `${w}px 상단바: [장부 저장] 상시 버튼은 폐지되었어야 한다(beta.29 — 30일 리마인더 배너로 대체)`);
  check(bar.topReset === 0, `${w}px 상단바: [검색 초기화]는 상단바를 떠나 검색창 옆 ✕가 되었어야 한다(beta.29)`);
  check(bar.clear === null, `${w}px 상단바: 지울 것이 없으면 ✕(검색 초기화)는 렌더되지 않아야 한다`);
  [['검색창', bar.search], ['소속 필터', bar.select], ['음성 검색', bar.mic], ['직원 목록 관리', bar.goEmp]].forEach(([label, b]) => {
    check(Boolean(b), `${w}px 상단바: ${label}이(가) 렌더되지 않았다`);
    if (b) check(b.right <= clientW + 1 && b.left >= -1, `${w}px 상단바: ${label}이(가) 화면 밖으로 나갔다 (${Math.round(b.left)}~${Math.round(b.right)} / ${clientW})`);
  });
  check(Boolean(bar.goEmp) && bar.goEmp.text.includes('직원 목록 관리'), `${w}px 상단바: 홈에는 [직원 목록 관리] 바로가기가 있어야 한다 (got "${bar.goEmp && bar.goEmp.text}")`);
  check(Boolean(bar.goEmp) && bar.goEmp.height >= 36, `${w}px 상단바: [직원 목록 관리] 버튼 터치 타겟이 너무 작다 (${bar.goEmp && Math.round(bar.goEmp.height)}px)`);
  check(Boolean(bar.mic) && bar.mic.height >= 44, `${w}px 상단바: 음성 검색 버튼 터치 타겟이 너무 작다 (${bar.mic && Math.round(bar.mic.height)}px)`);
  check(await page.locator('.banner [data-a="monthly-backup-now"]').count() === 0, `${w}px 홈: 월말 백업 배너는 더 이상 렌더되지 않아야 한다`);
  // 검색어를 넣으면 ✕가 검색창 옆(같은 행)에 나타나고, 검색창과 함께 화면 안에 들어와야 한다.
  await page.locator('#searchInput').fill('직');
  await page.locator('#searchInput').dispatchEvent('input');
  await page.waitForTimeout(250);
  const barQ = await readBar();
  check(barQ.row1.join(',') === 'searchInput,reset-filter', `${w}px 상단바: 검색 중 첫 행은 검색창+✕여야 한다 ${JSON.stringify(barQ.row1)}`);
  check(Boolean(barQ.clear) && barQ.clear.height >= 44, `${w}px 상단바: ✕(검색 초기화) 터치 타겟이 너무 작다 (${barQ.clear && Math.round(barQ.clear.height)}px)`);
  check(Boolean(barQ.clear) && barQ.clear.right <= clientW + 1, `${w}px 상단바: ✕(검색 초기화)가 화면 밖으로 나갔다`);
  check(Boolean(barQ.search) && barQ.search.width >= 220, `${w}px 상단바: ✕가 붙어도 검색창이 충분히 넓어야 한다 (${barQ.search && Math.round(barQ.search.width)}px)`);
  await page.locator('.filter-row [data-a="reset-filter"]').click();
  await page.waitForTimeout(150);

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

  // ── beta.27: 🧾 버튼에 "증표" 글자 라벨 ────────────────────────────────────────
  //   아이콘 하나만으로는 무엇인지 알 수 없다는 것이 현장 피드백이었다. 라벨을 붙이되
  //   ① 카드 밖으로 나가지 않고 ② 손가락 표적(44px)을 유지하고 ③ [사용] 버튼과 같은 줄에 남아야 한다
  //   (라벨 때문에 카드가 3행이 되면 폰 2행 계약이 깨진다).
  const rcpt = await page.evaluate(({ name }) => {
    const card = [...document.querySelectorAll('.card.employee')].find(c => c.innerText.includes(name));
    if (!card) return null;
    const btn = card.querySelector('[data-a="receipt"]');
    if (!btn) return null;
    const lbl = btn.querySelector('.rcpt-label');
    const r = btn.getBoundingClientRect(), u = card.querySelector('[data-a="use"]').getBoundingClientRect();
    return {
      label: lbl ? lbl.textContent.trim() : null,
      w: r.width, h: r.height, right: r.right, top: r.top, bottom: r.bottom,
      cardRight: card.getBoundingClientRect().right,
      sameRowAsUse: Math.abs(r.top - u.top) <= 12,
      clipped: btn.scrollWidth > btn.clientWidth + 1 || btn.scrollHeight > btn.clientHeight + 1
    };
  }, { name: LONG_NAME });
  check(Boolean(rcpt), `${w}px 홈: 직원 카드의 🧾 버튼을 찾지 못했다`);
  if (rcpt) {
    check(rcpt.label === '증표', `${w}px 홈: 🧾 버튼에 "증표" 글자 라벨이 있어야 한다 (got ${JSON.stringify(rcpt.label)})`);
    check(!rcpt.clipped, `${w}px 홈: 🧾 버튼 안에서 라벨이 잘렸다 (${Math.round(rcpt.w)}×${Math.round(rcpt.h)})`);
    check(rcpt.h >= 44, `${w}px 홈: 🧾 버튼 터치 타겟이 44px 미만 (${Math.round(rcpt.h)}px)`);
    check(rcpt.right <= rcpt.cardRight + 1, `${w}px 홈: 🧾 버튼이 카드 밖으로 나갔다`);
    check(rcpt.sameRowAsUse, `${w}px 홈: 🧾 버튼과 [사용] 버튼은 같은 줄에 있어야 한다(라벨이 카드를 3행으로 만들면 안 된다)`);
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
  // 모달이 열릴 때 커서가 놓이는 곳은 **금액 칸**이어야 한다.
  //   (beta.44에서 빠른 금액 버튼 자체를 없앴지만 이 계약은 남긴다 — 첫 포커스가 버튼이면 Enter 한 번이
  //    곧 저장·덮어쓰기가 되는 사고 경로는 새 버튼이 생기는 순간 되살아난다.) 그리고 커서가 놓인 칸은
  //   어느 폭에서도 화면 안에 있어야 한다 — 보이지 않는 칸에 커서가 있으면 사장님은 무엇을 고치는지 모른다.
  const focusBox = await page.evaluate(() => {
    const ae = document.activeElement;
    if (!ae) return null;
    const r = ae.getBoundingClientRect();
    return { id: ae.id || '', a: (ae.dataset && ae.dataset.a) || '', left: r.left, right: r.right, width: r.width };
  });
  check(Boolean(focusBox) && focusBox.id === 'useAmount', `${w}px 모달: 첫 포커스는 금액 칸이어야 한다 (id="${focusBox && focusBox.id}" data-a="${focusBox && focusBox.a}")`);
  check(Boolean(focusBox) && focusBox.left >= -1 && focusBox.right <= clientW + 1, `${w}px 모달: 포커스된 금액 칸이 화면 밖이다 (${focusBox && Math.round(focusBox.left)}~${focusBox && Math.round(focusBox.right)} / ${clientW})`);
  // beta.44: 빠른 금액 3버튼은 이 모달에서 사라졌다(손님이 서명한 금액을 오탭 한 번으로 덮어쓰는 경로).
  const quick = await page.evaluate(() => document.querySelectorAll('[data-a="fill-use"]').length);
  check(quick === 0, `${w}px 모달: 사용 등록 모달에는 빠른 금액 버튼이 없어야 한다 (${quick}개)`);
  check(!(await page.locator('.modal').innerText()).includes('빠른 금액'), `${w}px 모달: '빠른 금액' 라벨도 남아 있으면 안 된다`);
  const btns = await page.evaluate(() => [...document.querySelectorAll('.modal-actions button')].map(b => {
    const r = b.getBoundingClientRect();
    return { text: b.innerText.trim(), left: r.left, right: r.right, top: r.top, width: r.width };
  }));
  check(btns.length >= 3, `${w}px 모달: 액션 버튼이 모두 렌더되어야 한다 (${btns.length}개)`);
  check(btns.some(b => b.text === '저장'), `${w}px 모달: [저장] 버튼이 있어야 한다 (beta.44: '서명 후 저장' → '저장')`);
  // 폰(≤640)은 세로 쌓기(column-reverse)라 주 동작 [저장]이 맨 위에 와야 한다. 태블릿은 한 줄 유지.
  const saveBtn = btns.find(b => b.text === '저장');
  const otherBtns = btns.filter(b => b !== saveBtn);
  if (saveBtn && otherBtns.length) {
    if (w <= 640) check(otherBtns.every(b => saveBtn.top <= b.top + 1), `${w}px 모달: [저장]이 다른 버튼보다 위에 있어야 한다 (엄지 근처)`);
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
  await page.waitForSelector('.fold-head[data-card="enroll-manual"]');
  await noHorizontalOverflow(page, '설정(접힘)', w);
  // beta.29: 등록·직원 목록 카드도 접힘 — 접힌 헤더의 터치 타겟과 화면 안쪽을 확인한 뒤 펼쳐서 기하를 잰다.
  const foldHeads = await page.evaluate(() => [...document.querySelectorAll('.fold-head')].map(h => {
    const r = h.getBoundingClientRect();
    return { card: h.dataset.card, height: r.height, left: r.left, right: r.right };
  }));
  foldHeads.forEach(h => {
    check(h.height >= 44, `${w}px 설정: 접힘 카드 헤더(${h.card}) 터치 타겟이 너무 작다 (${Math.round(h.height)}px)`);
    check(h.right <= clientW + 1 && h.left >= -1, `${w}px 설정: 접힘 카드 헤더(${h.card})가 화면 밖으로 나갔다`);
  });
  for (const key of ['enroll-auto', 'enroll-manual', 'employees']) {
    const head = page.locator(`.fold-head[data-card="${key}"]`);
    if ((await head.getAttribute('aria-expanded')) === 'false') { await head.click(); await page.waitForTimeout(100); }
  }
  await page.waitForSelector('[data-a="quick-add-employee"]');
  await noHorizontalOverflow(page, '설정(펼침)', w);
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-settings-enroll-${w}.png`), fullPage: true }).catch(() => {});
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

  // beta.24: [네, 맞아요]는 **요청 작성 화면**으로 곧장 간다 — 그 전에 확인 카드 다음이 무엇인지부터 못 박는다.
  await page.locator('[data-a="cust-confirm"]').click();
  await page.waitForSelector('#custAmountInput');
  await noHorizontalOverflow(page, '손님 화면(본인 확인 직후)', w);
  const straightToCompose = await page.evaluate(() => ({
    hasAmount: !!document.querySelector('#custAmountInput'),
    hasCanvas: !!document.querySelector('.cust-sig #signCanvas'),
    hasBalScreen: !!document.querySelector('.cust-bal'),
    links: [...document.querySelectorAll('.cust-links button')].map(b => { const r = b.getBoundingClientRect(); return { text: b.innerText.replace(/\n/g, ' ').trim(), height: r.height, left: r.left, right: r.right, clipped: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1 }; })
  }));
  check(straightToCompose.hasAmount && straightToCompose.hasCanvas, `${w}px 손님 화면: [네, 맞아요] 직후 곧바로 금액칸+서명판이 떠야 한다(중간 잔액 화면 경유 금지)`);
  check(!straightToCompose.hasBalScreen, `${w}px 손님 화면: 본인 확인 직후 화면은 잔액 화면이 아니어야 한다`);
  check(straightToCompose.links.length === 2, `${w}px 손님 요청 화면: 보조 링크 2개(최근 내역·사장님 부르기)가 있어야 한다 (${straightToCompose.links.length}개)`);
  straightToCompose.links.forEach(b => {
    check(b.height >= 48, `${w}px 손님 요청 화면: 보조 링크 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px 손님 요청 화면: 보조 링크 "${b.text}"이(가) 화면 밖이다`);
    check(!b.clipped, `${w}px 손님 요청 화면: 보조 링크 "${b.text}" 라벨이 잘렸다`);
  });

  // 상세 화면(선택) — 7자리 잔액 전액 표기 + 최근 거래 슬림 행(서명 이미지 없음) + 세 버튼.
  //   beta.24부터 이 화면은 [최근 사용 내역 보기]로만 열린다(필수 단계가 아니다).
  //   beta.25: **초안(금액)을 든 채로** 들어간다 — 그것이 실제 왕복 경로이고, beta.24에서 버튼 3개가
  //   전부 접힘 아래로 사라졌던 바로 그 상태다(거래 5건 + 초안 안내 한 줄이 함께 있는 최악 높이).
  await page.locator('#custAmountInput').fill('12000');
  await page.waitForTimeout(120);
  await page.locator('[data-a="cust-history"]').click();
  await page.waitForSelector('.cust-bal');
  await noHorizontalOverflow(page, '손님 화면(최근 내역)', w);
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
  // beta.24: 상세 화면의 갈림길 셋 — [사용 요청 계속하기](작성하던 요청으로 복귀) · [사장님 부르기](A) · [처음으로].
  check(custSelf.buttons.length === 3, `${w}px 손님 화면: 상세 화면에는 [사용 요청 계속하기]/[사장님 부르기]/[처음으로] 세 버튼이 있어야 한다 (${custSelf.buttons.length}개)`);
  check(custSelf.buttons[0] && custSelf.buttons[0].text === '사용 요청 계속하기', `${w}px 손님 화면: 첫 버튼은 [사용 요청 계속하기]여야 한다 (got "${custSelf.buttons[0] && custSelf.buttons[0].text}")`);
  // 왕복 보존 계약을 손님에게 알리는 한 줄이 이 화면에 있어야 한다(없으면 서명한 줄 알고 제출한다).
  const draftNote = await page.evaluate(() => {
    const el = document.querySelector('.cust-draft-note');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText.replace(/\n/g, ' ').trim(), left: r.left, right: r.right, clipped: el.scrollWidth > el.clientWidth + 1 };
  });
  check(Boolean(draftNote) && draftNote.text.includes('서명만 다시'), `${w}px 손님 화면: 상세 화면은 "돌아가면 서명만 다시"를 알려야 한다 (got ${JSON.stringify(draftNote && draftNote.text)})`);
  check(Boolean(draftNote) && draftNote.text.includes('금액은 그대로'), `${w}px 손님 화면: 초안을 들고 들어왔으면 "금액은 그대로"라고 말해야 한다 (got ${JSON.stringify(draftNote && draftNote.text)})`);
  if (draftNote) {
    check(draftNote.left >= -1 && draftNote.right <= clientW + 1, `${w}px 손님 화면: 보존 계약 안내가 화면 밖으로 나갔다`);
    check(!draftNote.clipped, `${w}px 손님 화면: 보존 계약 안내가 잘렸다`);
  }
  // ── beta.25 HIGH-1 회귀: 상세 화면도 **스크롤 없이** 버튼 줄까지 보여야 한다 ──────────
  await detailFitsInFirstViewport(page, `${w}px`);
  custSelf.buttons.forEach(b => {
    check(b.height >= 48, `${w}px 손님 화면: 버튼 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px 손님 화면: 버튼 "${b.text}"이(가) 화면 밖이다`);
  });
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-customer-${w}.png`) }).catch(() => {});

  // ── 요청 작성 화면(beta.22): 금액 입력 **+** 서명이 한 화면 ────────────────────
  //    손님이 직접 숫자를 치고 손가락으로 서명하는, 이 앱에서 손님 손이 가장 오래 머무는 화면이다.
  //    7자리 잔액(1,234,567원)을 가진 시드로 들어오므로 큰 숫자가 잘리기 가장 쉬운 조건이기도 하다.
  //    beta.22에서 두 화면이 하나가 되면서 세로가 길어졌다 — 좁은 폰에서 무엇 하나 잘리거나
  //    화면 밖으로 밀려나지 않는지, 그리고 가로 스크롤이 절대 생기지 않는지가 이 절의 핵심이다.
  // [사용 요청 계속하기]로 요청 작성 화면에 되돌아온다(왕복의 반대 방향).
  await page.locator('[data-a="cust-request"]').click();
  await page.waitForSelector('#custAmountInput');
  await page.waitForSelector('.cust-sig #signCanvas');
  // 왕복 보존 계약 — 상세 화면이 약속한 대로 금액이 그대로 돌아와야 한다. 확인한 뒤 비우고 아래 검사를 이어간다.
  check((await page.locator('#custAmountInput').inputValue()) === '12000', `${w}px 손님 요청 화면: 상세 화면을 다녀와도 적어 둔 금액은 그대로여야 한다`);
  await page.locator('#custAmountInput').fill('');
  await page.waitForTimeout(150);
  await noHorizontalOverflow(page, '손님 요청 화면', w);
  const amtView = await page.evaluate(() => {
    const bal = document.querySelector('.cust-req-bal'), input = document.querySelector('#custAmountInput');
    const br = bal.getBoundingClientRect(), ir = input.getBoundingClientRect();
    return {
      balFont: parseFloat(getComputedStyle(bal).fontSize), balLeft: br.left, balRight: br.right,
      inputHeight: ir.height, inputLeft: ir.left, inputRight: ir.right, inputWidth: ir.width,
      inputFont: parseFloat(getComputedStyle(input).fontSize),
      balText: bal.innerText.trim(),
      balClipped: bal.scrollWidth > bal.clientWidth + 1,
      quick: [...document.querySelectorAll('.cust-req-quick button')].map(b => { const r = b.getBoundingClientRect(); return { text: b.innerText.trim(), height: r.height, left: r.left, right: r.right, clipped: b.scrollWidth > b.clientWidth + 1 }; }),
      actions: [...document.querySelectorAll('.cust-actions button')].map(b => { const r = b.getBoundingClientRect(); return { text: b.innerText.trim(), height: r.height, left: r.left, right: r.right }; })
    };
  });
  // beta.44: 금액 안내는 '잔액 N원이 남아있어요' 한 줄이고, 그것이 이 화면에서 가장 큰 글자다.
  check(amtView.balText === '잔액 1,234,567원이 남아있어요', `${w}px 손님 금액 화면: 잔액 한 줄이 그대로 보여야 한다 (got "${amtView.balText.replace(/\n/g, ' ')}")`);
  check(amtView.balFont >= 20, `${w}px 손님 금액 화면: 잔액 글자가 충분히 커야 한다 (${amtView.balFont}px)`);
  check(amtView.balFont >= amtView.inputFont, `${w}px 손님 금액 화면: 잔액 줄이 입력 글자보다 작으면 안 된다 (${amtView.balFont} vs ${amtView.inputFont})`);
  check(amtView.balLeft >= -1 && amtView.balRight <= clientW + 1, `${w}px 손님 금액 화면: 잔액 줄이 화면 밖으로 나갔다`);
  check(amtView.inputHeight >= 48, `${w}px 손님 금액 화면: 입력창 터치 타겟이 작다 (${Math.round(amtView.inputHeight)}px)`);
  check(amtView.inputWidth >= 240, `${w}px 손님 금액 화면: 입력창이 충분히 넓어야 한다 (${Math.round(amtView.inputWidth)}px)`);
  check(amtView.inputLeft >= -1 && amtView.inputRight <= clientW + 1, `${w}px 손님 금액 화면: 입력창이 화면 밖으로 나갔다`);
  check(!amtView.balClipped, `${w}px 손님 금액 화면: 잔액 안내가 잘렸다`);
  check(amtView.quick.length === 3, `${w}px 손님 금액 화면: 빠른 금액 3개가 있어야 한다 (${amtView.quick.length}개)`);
  amtView.quick.forEach(b => {
    check(b.height >= 48, `${w}px 손님 금액 화면: 빠른 금액 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px 손님 금액 화면: 빠른 금액 "${b.text}"이(가) 화면 밖이다`);
    check(!b.clipped, `${w}px 손님 금액 화면: 빠른 금액 "${b.text}" 라벨이 잘렸다`);
  });
  // 버튼은 이제 셋이다 — 통합 화면의 끝은 [사장님 확인 받기]·[지우고 다시]·[처음으로]다(beta.24: [뒤로]는 사라졌다).
  check(amtView.actions.length === 3, `${w}px 손님 요청 화면: [사장님 확인 받기]/[지우고 다시]/[처음으로] 세 버튼이어야 한다 (${amtView.actions.length}개)`);
  check(amtView.actions[2] && amtView.actions[2].text === '처음으로', `${w}px 손님 요청 화면: 마지막 버튼은 [처음으로]여야 한다 (got "${amtView.actions[2] && amtView.actions[2].text}")`);
  check(amtView.actions[0] && amtView.actions[0].text === '사장님 확인 받기', `${w}px 손님 요청 화면: 첫 버튼은 [사장님 확인 받기]여야 한다 (got "${amtView.actions[0] && amtView.actions[0].text}")`);
  amtView.actions.forEach(b => {
    check(b.height >= 48, `${w}px 손님 요청 화면: 버튼 "${b.text}" 터치 타겟이 48px 미만 (${Math.round(b.height)}px)`);
    check(b.left >= -1 && b.right <= clientW + 1, `${w}px 손님 요청 화면: 버튼 "${b.text}"이(가) 화면 밖이다`);
  });

  // ── 캔버스도 같은 화면 안에 있다 — 금액 칸 아래, 버튼 위 ────────────────────
  //    캔버스가 충분히 크고(어르신이 손가락으로 이름을 쓴다) 화면 밖으로 나가지 않아야 한다.
  const signView = await page.evaluate(() => {
    const box = document.querySelector('.cust-sig'), canvas = document.querySelector('#signCanvas');
    const br = box.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    const amt = document.querySelector('.cust-req-bal'), input = document.querySelector('#custAmountInput');
    const title = document.querySelector('.cust-sign-title');
    const submit = document.querySelector('[data-a="cust-sign-submit"]');
    return {
      boxLeft: br.left, boxRight: br.right,
      canvasW: cr.width, canvasH: cr.height, canvasLeft: cr.left, canvasRight: cr.right, canvasTop: cr.top, canvasBottom: cr.bottom,
      backingW: canvas.width, backingH: canvas.height,
      amtText: amt.textContent.trim(), amtClipped: amt.scrollWidth > amt.clientWidth + 1,
      inputBottom: input.getBoundingClientRect().bottom,
      titleText: title ? title.innerText.trim() : '', titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : false,
      submitTop: submit.getBoundingClientRect().top,
      actions: [...document.querySelectorAll('.cust-actions button')].map(b => { const r = b.getBoundingClientRect(); return { text: b.innerText.trim(), height: r.height, left: r.left, right: r.right, clipped: b.scrollWidth > b.clientWidth + 1 }; })
    };
  });
  check(signView.amtText === '잔액 1,234,567원이 남아있어요', `${w}px 손님 요청 화면: 잔액 한 줄이 서명판 위에 그대로 있어야 한다 (got "${signView.amtText}")`);
  check(!signView.amtClipped, `${w}px 손님 요청 화면: 잔액 줄이 잘렸다`);
  // beta.44: 서명 안내는 "서명하고 다음에 무엇을 누르는지"까지 말한다 — 손님이 서명만 하고 멈추던 자리다.
  check(signView.titleText.replace(/\s+/g, ' ') === '여기에 서명하시고, 사장님 확인받기를 클릭해주세요', `${w}px 손님 요청 화면: 서명 안내 문구가 달라졌다 (got "${signView.titleText}")`);
  check(!signView.titleClipped, `${w}px 손님 요청 화면: 서명 안내 문구가 잘렸다`);
  // 배치 순서 — 금액 칸 → 캔버스 → 버튼. 이 순서가 뒤집히면 손님이 서명부터 하고 금액을 못 찾는다.
  check(signView.inputBottom <= signView.canvasTop + 1, `${w}px 손님 요청 화면: 서명 캔버스는 금액 칸 아래에 와야 한다 (input ${Math.round(signView.inputBottom)} / canvas ${Math.round(signView.canvasTop)})`);
  check(signView.canvasBottom <= signView.submitTop + 1, `${w}px 손님 요청 화면: [사장님 확인 받기]는 캔버스 아래에 와야 한다`);
  // beta.23: 서명판 높이는 뷰포트 비례(clamp(120px,20dvh,170px), 태블릿 220px)다 — 최소 보장선은 120px.
  check(signView.canvasH >= 120, `${w}px 손님 요청 화면: 서명 캔버스가 너무 낮다 (${Math.round(signView.canvasH)}px)`);
  if (w >= 768) check(signView.canvasH >= 200, `${w}px(태블릿) 손님 요청 화면: 태블릿에서는 서명판이 더 커야 한다 (${Math.round(signView.canvasH)}px)`);
  check(signView.canvasW >= 240, `${w}px 손님 요청 화면: 서명 캔버스가 너무 좁다 (${Math.round(signView.canvasW)}px)`);
  check(signView.canvasLeft >= -1 && signView.canvasRight <= clientW + 1, `${w}px 손님 요청 화면: 서명 캔버스가 화면 밖으로 나갔다`);
  check(signView.boxLeft >= -1 && signView.boxRight <= clientW + 1, `${w}px 손님 요청 화면: 서명 상자가 화면 밖으로 나갔다`);
  // 캔버스 백킹 스토어가 CSS 크기 × DPR로 맞춰져야 흐릿하지 않고, 좌표도 어긋나지 않는다(initSignPad 계약).
  check(Math.abs(signView.backingW - signView.canvasW * 2) <= 2, `${w}px 손님 요청 화면: 캔버스 해상도가 화면 크기와 어긋났다 (backing ${signView.backingW} vs css ${Math.round(signView.canvasW)}×2)`);
  check(Math.abs(signView.backingH - signView.canvasH * 2) <= 2, `${w}px 손님 요청 화면: 캔버스 세로 해상도가 어긋났다 (backing ${signView.backingH} vs css ${Math.round(signView.canvasH)}×2)`);
  signView.actions.forEach(b => {
    check(!b.clipped, `${w}px 손님 요청 화면: 버튼 "${b.text}" 라벨이 잘렸다`);
  });
  // ── beta.23 최우선 회귀: **스크롤 없이** 한 화면에 다 들어와야 한다 ─────────────────
  //   beta.22의 이 자리는 scrollIntoView로 버튼을 끌어올린 **뒤에** 재는 관대한 검사였다.
  //   그래서 "iPhone 13에서 [사장님 확인 받기]가 화면 밖 174px 아래"인 상태가 그대로 통과했다.
  //   어르신 손님은 화면을 밀어 버튼을 찾지 않는다 — 보이지 않으면 그 자리에서 멈춘다.
  //   → 기준을 초기 뷰포트(scrollY=0)로 되돌린다. 금액 칸 · 서명판 **전체** · 버튼 **셋 다**가 대상이다.
  const fitClean = await fitsInFirstViewport(page, `${w}px`);
  // ── beta.25(L4): **오류가 떠 있는 상태**에서도 같은 계약이다 ─────────────────────────
  //   beta.24에서는 오류 한 줄이 나타날 때만 자리를 차지해(23px) 화면 전체가 아래로 밀렸다.
  //   여유가 6~15px까지 떨어졌고 둘 다 뜨면 -7px, 즉 [사장님 확인 받기]가 접힘 아래로 사라졌다 —
  //   손님이 "잔액보다 많아요"를 읽는 바로 그 순간에 고칠 버튼이 없어지는 셈이다.
  //   → 오류 줄은 항상 자리를 잡고 있어야 하고(배치 이동 0), 그 상태에서도 전부 화면 안이어야 한다.
  const submitTop = () => page.evaluate(() => Math.round(document.querySelector('[data-a="cust-sign-submit"]').getBoundingClientRect().top));
  const cleanTop = await submitTop();
  await page.locator('#custAmountInput').fill('99999999');
  await page.waitForTimeout(150);
  check((await page.locator('#custAmtErr').innerText()).includes('잔액보다 많아요'), `${w}px 손님 요청 화면: 잔액 초과는 금액 칸 바로 위에서 말해야 한다`);
  await fitsInFirstViewport(page, `${w}px(잔액 초과 오류)`);
  check(Math.abs((await submitTop()) - cleanTop) <= 1, `${w}px 손님 요청 화면: 잔액 초과 오류가 떴다고 [사장님 확인 받기]가 움직이면 안 된다 (${cleanTop} → ${await submitTop()})`);
  await page.locator('#custAmountInput').fill('9000');
  await page.waitForTimeout(120);
  await page.locator('[data-a="cust-sign-submit"]').click();
  await page.waitForTimeout(180);
  check((await page.locator('#custSignErr').innerText()).includes('서명'), `${w}px 손님 요청 화면: 서명 누락은 캔버스 바로 아래에서 말해야 한다`);
  await fitsInFirstViewport(page, `${w}px(서명 누락 오류)`);
  check(Math.abs((await submitTop()) - cleanTop) <= 1, `${w}px 손님 요청 화면: 서명 누락 오류가 떴다고 버튼이 움직이면 안 된다 (${cleanTop} → ${await submitTop()})`);
  check(fitClean.slack >= 30, `${w}px 손님 요청 화면: 오류 없는 상태의 여유가 ${fitClean.slack}px뿐이다`);
  await page.locator('#custAmountInput').fill('');
  await page.waitForTimeout(150);
  // 아래로 끝까지 내려도 가로 스크롤은 여전히 0이어야 한다(세로만 허용).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(80);
  await noHorizontalOverflow(page, '손님 요청 화면(하단까지 스크롤)', w);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);

  // ── beta.22 최우선 회귀: **금액을 치는 동안 서명이 지워지면 안 된다** ─────────────
  //    먼저 서명을 그려 두고 그 위에서 한 글자씩 친다. 캔버스 노드 동일성·획 생존·포커스 유실 0을 함께 본다.
  //    (beta.20의 입력 노드 유실 규칙은 그대로다 — 빠른 금액 탭도 값만 대입하고 표시 조각만 갈아끼운다.)
  const sigDraw = await page.locator('.cust-sig #signCanvas').boundingBox();
  await page.mouse.move(sigDraw.x + 25, sigDraw.y + sigDraw.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(sigDraw.x + sigDraw.width * 0.5, sigDraw.y + sigDraw.height * 0.3, { steps: 6 });
  await page.mouse.move(sigDraw.x + sigDraw.width * 0.8, sigDraw.y + sigDraw.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.evaluate(() => {
    window.__amtBlurs = 0;
    document.addEventListener('focusout', e => { if (e.target && e.target.id === 'custAmountInput') window.__amtBlurs += 1; }, true);
    document.querySelector('#custAmountInput').__bapProbe = 'alive';
    document.querySelector('#signCanvas').__bapStroke = 'alive';
  });
  check((await page.evaluate(() => window.__prepaidTestHooks.lockState().signPadEmpty)) === false, `${w}px 손님 요청 화면: 사전 서명이 실제로 그려져야 이후 회귀 검증이 성립한다`);
  if (w <= 640) await page.locator('#custAmountInput').tap(); else await page.locator('#custAmountInput').click();
  for (const [i, ch] of [...'12000'].entries()) {
    await page.keyboard.type(ch, { delay: 30 });
    await page.waitForTimeout(50);
    const s = await page.evaluate(() => {
      const el = document.querySelector('#custAmountInput'), c = document.querySelector('#signCanvas');
      return {
        same: !!el && el.__bapProbe === 'alive', value: el ? el.value : null, focused: !!el && document.activeElement === el,
        blurs: window.__amtBlurs, canvasSame: !!c && c.__bapStroke === 'alive',
        empty: window.__prepaidTestHooks.lockState().signPadEmpty
      };
    });
    check(s.same, `${w}px 손님 금액 입력: ${i + 1}번째 글자에서 입력 노드가 교체됐다(폰 숫자 키보드가 닫힌다)`);
    check(s.focused, `${w}px 손님 금액 입력: ${i + 1}번째 글자 뒤 포커스가 입력창에서 벗어났다`);
    check(s.value === '12000'.slice(0, i + 1), `${w}px 손님 금액 입력: ${i + 1}번째 글자가 입력창에 남아야 한다 (got ${JSON.stringify(s.value)})`);
    check(s.canvasSame, `${w}px 손님 금액 입력: ${i + 1}번째 글자에서 서명 캔버스 노드가 교체됐다(그린 서명이 사라진다)`);
    check(s.empty === false, `${w}px 손님 금액 입력: ${i + 1}번째 글자에서 그려 둔 서명 획이 지워졌다`);
  }
  const typedState = await page.evaluate(() => ({
    blurs: window.__amtBlurs,
    value: document.querySelector('#custAmountInput').value,
    bal: document.querySelector('.cust-req-bal').textContent.trim()
  }));
  check(typedState.blurs === 0, `${w}px 손님 금액 입력: 타이핑 중 포커스를 ${typedState.blurs}번 잃었다(0이어야 한다)`);
  check(typedState.value === '12000', `${w}px 손님 금액 입력: 친 글자가 입력칸에 그대로 남아야 한다 (got "${typedState.value}")`);
  // beta.44(사용자 확정): 잔액 줄은 **현재 잔액 고정**이다 — 금액을 쳐도 줄어들지 않는다.
  check(typedState.bal === '잔액 1,234,567원이 남아있어요', `${w}px 손님 금액 입력: 잔액 줄은 현재 잔액에 고정돼야 한다 (got "${typedState.bal}")`);
  if (w <= 640) await page.locator('[data-a="cust-amt-quick"][data-amount="18000"]').tap(); else await page.locator('[data-a="cust-amt-quick"][data-amount="18000"]').click();
  await page.waitForTimeout(100);
  const quickState = await page.evaluate(() => {
    const el = document.querySelector('#custAmountInput'), c = document.querySelector('#signCanvas');
    return {
      same: !!el && el.__bapProbe === 'alive', value: el ? el.value : null,
      bal: document.querySelector('.cust-req-bal').textContent.trim(),
      canvasSame: !!c && c.__bapStroke === 'alive', empty: window.__prepaidTestHooks.lockState().signPadEmpty
    };
  });
  check(quickState.same, `${w}px 손님 요청 화면: 빠른 금액 탭이 입력 노드를 갈아치웠다`);
  check(quickState.value === '18000', `${w}px 손님 요청 화면: 빠른 금액이 입력창에 반영돼야 한다 (got ${JSON.stringify(quickState.value)})`);
  check(quickState.bal === '잔액 1,234,567원이 남아있어요', `${w}px 손님 요청 화면: 빠른 금액 탭도 잔액 줄을 흔들면 안 된다 (got "${quickState.bal}")`);
  check(quickState.canvasSame && quickState.empty === false, `${w}px 손님 요청 화면: 빠른 금액 탭이 그려 둔 서명을 지웠다`);
  // 통합 화면은 세로로 길다 — 그럼에도 가로 스크롤은 절대 생기지 않아야 한다(세로 스크롤은 허용).
  await noHorizontalOverflow(page, '손님 요청 화면(입력 후)', w);
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-cust-compose-${w}.png`) }).catch(() => {});

  // 요청을 실제로 넘겨 "사장님 확인" 화면의 요청 블록(금액·서명 썸네일) 기하까지 본다.
  const sigBox = await page.locator('.cust-sig #signCanvas').boundingBox();
  await page.mouse.move(sigBox.x + 25, sigBox.y + sigBox.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(sigBox.x + sigBox.width * 0.5, sigBox.y + sigBox.height * 0.3, { steps: 6 });
  await page.mouse.move(sigBox.x + sigBox.width * 0.8, sigBox.y + sigBox.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.locator('[data-a="cust-sign-submit"]').click();
  await page.waitForSelector('.pin-req-amt');
  await noHorizontalOverflow(page, '사장님 확인 화면(요청)', w);
  const reqBlock = await page.evaluate(() => {
    const amt = document.querySelector('.pin-req-amt'), label = document.querySelector('.pin-req-label');
    const img = document.querySelector('.pin-req-sign img'), title = document.querySelector('.pin-title');
    const ar = amt.getBoundingClientRect(), ir = img ? img.getBoundingClientRect() : null;
    return {
      amtText: amt.textContent.trim(), amtFont: parseFloat(getComputedStyle(amt).fontSize),
      titleFont: parseFloat(getComputedStyle(title).fontSize),
      amtClipped: amt.scrollWidth > amt.clientWidth + 1, amtLeft: ar.left, amtRight: ar.right,
      labelText: label.textContent.trim(),
      imgLeft: ir ? ir.left : 0, imgRight: ir ? ir.right : 0, imgH: ir ? ir.height : 0,
      hasImg: !!img, padKeys: document.querySelectorAll('.pin-key').length
    };
  });
  check(reqBlock.amtText === '18,000원', `${w}px 사장님 확인 화면: 손님이 넣은 금액이 보여야 한다 (got "${reqBlock.amtText}")`);
  check(reqBlock.labelText.includes('손님이 입력한 금액'), `${w}px 사장님 확인 화면: 금액의 출처가 적혀 있어야 한다 (got "${reqBlock.labelText}")`);
  check(reqBlock.amtFont > reqBlock.titleFont, `${w}px 사장님 확인 화면: 금액이 제목보다 커야 한다 (${reqBlock.amtFont}px vs ${reqBlock.titleFont}px)`);
  check(!reqBlock.amtClipped, `${w}px 사장님 확인 화면: 금액이 잘렸다`);
  check(reqBlock.amtLeft >= -1 && reqBlock.amtRight <= clientW + 1, `${w}px 사장님 확인 화면: 금액이 화면 밖으로 나갔다`);
  check(reqBlock.hasImg && reqBlock.imgH >= 40, `${w}px 사장님 확인 화면: 서명 썸네일이 보여야 한다 (${Math.round(reqBlock.imgH)}px)`);
  check(reqBlock.imgLeft >= -1 && reqBlock.imgRight <= clientW + 1, `${w}px 사장님 확인 화면: 서명 썸네일이 화면 밖으로 나갔다`);
  check(reqBlock.padKeys === 12, `${w}px 사장님 확인 화면: 요청 블록이 생겨도 숫자판 12키가 그대로 있어야 한다 (${reqBlock.padKeys}개)`);
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-cust-request-pin-${w}.png`) }).catch(() => {});

  // ── 손님 요청으로 열린 사용 등록 모달 — beta.44 버튼 배치(사용자 지시) ────────
  //    PIN을 풀면 금액·서명이 채워진 모달이 열린다. 폰에서 사장님이 하는 일은 사실상 [저장] 하나이므로
  //    저장이 **서명 그림 바로 아래 첫 버튼**이어야 한다. [서명 다시 받기]는 예외 경로라 그 아래,
  //    [취소]가 맨 아래다. DOM 순서(취소·서명 다시 받기·저장)를 CSS column-reverse가 뒤집는 구조라
  //    여기서 재는 것은 **실제 화면 좌표**다 — 순서가 뒤집히는 사고는 CSS 한 줄로 일어난다.
  for (const key of ['1', '2', '3', '4']) await page.locator(`[data-a="pin-key"][data-key="${key}"]`).click();
  await page.waitForSelector('#useAmount', { timeout: 8000 });
  await noHorizontalOverflow(page, '손님 요청 사용 모달', w);
  const preModal = await page.evaluate(() => {
    const sig = document.querySelector('.sig-pre');
    return {
      sigBottom: sig ? sig.getBoundingClientRect().bottom : null,
      quick: document.querySelectorAll('[data-a="fill-use"]').length,
      inForm: !!document.querySelector('.modal .form [data-a="use-resign"]'),
      btns: [...document.querySelectorAll('.modal-actions button')].map(b => {
        const r = b.getBoundingClientRect();
        return { a: (b.dataset && b.dataset.a) || '', text: b.innerText.trim(), top: r.top, height: r.height, left: r.left, right: r.right };
      })
    };
  });
  const preSave = preModal.btns.find(b => b.a === 'save-use');
  const preResign = preModal.btns.find(b => b.a === 'use-resign');
  const preCancel = preModal.btns.find(b => b.a === 'close-modal');
  check(preModal.quick === 0, `${w}px 손님 요청 사용 모달: 빠른 금액 버튼이 없어야 한다 (${preModal.quick}개)`);
  check(preModal.sigBottom !== null, `${w}px 손님 요청 사용 모달: 손님이 미리 한 서명이 보여야 한다`);
  check(!preModal.inForm, `${w}px 손님 요청 사용 모달: [서명 다시 받기]는 서명칸이 아니라 버튼 묶음에 있어야 한다`);
  check(Boolean(preSave && preResign && preCancel), `${w}px 손님 요청 사용 모달: [저장]·[서명 다시 받기]·[취소] 세 버튼이 있어야 한다 (${JSON.stringify(preModal.btns.map(b => b.text))})`);
  if (preSave && preResign && preCancel) {
    check(preSave.text === '저장', `${w}px 손님 요청 사용 모달: 저장 버튼의 말은 [저장]이어야 한다 (got "${preSave.text}")`);
    if (w <= 640) {
      check(preSave.top < preResign.top, `${w}px 손님 요청 사용 모달: [저장]이 [서명 다시 받기]보다 위에 있어야 한다`);
      check(preResign.top < preCancel.top, `${w}px 손님 요청 사용 모달: [서명 다시 받기]가 [취소]보다 위에 있어야 한다`);
      check(preSave.top >= preModal.sigBottom - 1, `${w}px 손님 요청 사용 모달: [저장]은 서명 그림 아래에 와야 한다`);
    } else {
      check([preResign, preCancel].every(b => Math.abs(preSave.top - b.top) <= 2), `${w}px 손님 요청 사용 모달: 태블릿에서는 버튼이 한 줄(같은 높이)을 유지해야 한다`);
    }
    [preSave, preResign, preCancel].forEach(b => {
      check(b.height >= 44, `${w}px 손님 요청 사용 모달: "${b.text}" 터치 타겟이 작다 (${Math.round(b.height)}px)`);
      check(b.left >= -1 && b.right <= clientW + 1, `${w}px 손님 요청 사용 모달: "${b.text}" 버튼이 화면 밖이다`);
    });
  }
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-usage-prefilled-${w}.png`) }).catch(() => {});
  // 저장하지 않고 닫는다 — 이 절은 기하만 본다(원장을 건드리면 뒤 검사의 잔액 전제가 흔들린다).
  await page.locator('.modal-actions [data-a="close-modal"]').click();
  await page.waitForTimeout(150);

  // A단계 인계 화면 검증으로 되돌아간다([손님 셀프 조회]로 다시 손님 화면).
  await page.locator('[data-a="hand-to-customer"]').click();
  await page.waitForSelector('#custSearchInput');
  await page.locator('#custSearchInput').fill('김수한무');
  await page.waitForSelector('.cust-ask');
  await page.locator('[data-a="cust-confirm"]').click();
  await page.waitForSelector('#custAmountInput');

  // ── "사장님 확인" 인계 화면(beta.19): [사장님 부르기]는 곧바로 PIN 화면으로 넘어간다 ──
  //    beta.24: 이 A단계 인계는 이제 **요청 작성 화면의 보조 링크**에서 출발한다 — 금액을 넣을 수 없는
  //    손님(단체 식사·잔액 초과·사장님이 금액을 정하는 자리)의 탈출구가 여기서도 살아 있는지 함께 본다.
  //    긴 이름·긴 부서명(LONG_DEPT)이 그대로 실리는 화면이라 잘림·화면 밖 이탈이 특히 위험하다.
  await page.locator('[data-a="cust-call-owner"]').click();
  await page.waitForSelector('.pin-screen [data-a="pin-key"]');
  await noHorizontalOverflow(page, '사장님 확인 화면', w);
  const handoff = await page.evaluate(() => {
    const title = document.querySelector('.pin-title'), sub = document.querySelector('.pin-sub');
    const t = title.getBoundingClientRect(), s = sub.getBoundingClientRect();
    const foot = document.querySelector('.cust-foot button'), f = foot ? foot.getBoundingClientRect() : null;
    const pad = [...document.querySelectorAll('.pin-key')].map(b => { const r = b.getBoundingClientRect(); return { height: r.height, left: r.left, right: r.right }; });
    return {
      title: title.innerText.trim(),
      subText: sub.innerText.replace(/\n/g, ' ').trim(),
      subLeft: s.left, subRight: s.right, subClipped: sub.scrollWidth > sub.clientWidth + 1,
      titleLeft: t.left, titleRight: t.right, titleClipped: title.scrollWidth > title.clientWidth + 1,
      footText: foot ? foot.innerText.trim() : '', footHeight: f ? f.height : 0, footLeft: f ? f.left : 0, footRight: f ? f.right : 0,
      pad
    };
  });
  check(handoff.title === '사장님 확인', `${w}px 사장님 확인 화면: 제목이 "사장님 확인"이어야 한다 (got "${handoff.title}")`);
  check(!handoff.titleClipped && handoff.titleLeft >= -1 && handoff.titleRight <= clientW + 1, `${w}px 사장님 확인 화면: 제목이 잘리거나 화면 밖으로 나갔다`);
  check(handoff.subText.includes('김수한무'), `${w}px 사장님 확인 화면: 인계 대상 이름이 보여야 한다 (got "${handoff.subText}")`);
  check(handoff.subText.includes('비밀번호'), `${w}px 사장님 확인 화면: 사장님에게 비밀번호 입력을 안내해야 한다 (got "${handoff.subText}")`);
  check(!handoff.subClipped, `${w}px 사장님 확인 화면: 대상 표시가 잘렸다 ("${handoff.subText}")`);
  check(handoff.subLeft >= -1 && handoff.subRight <= clientW + 1, `${w}px 사장님 확인 화면: 대상 표시가 화면 밖으로 나갔다`);
  check(handoff.footText === '처음으로', `${w}px 사장님 확인 화면: 되돌아가기 버튼은 [처음으로]여야 한다 (got "${handoff.footText}")`);
  check(handoff.footHeight >= 30 && handoff.footLeft >= -1 && handoff.footRight <= clientW + 1, `${w}px 사장님 확인 화면: [처음으로] 버튼이 화면 밖이거나 너무 작다 (${Math.round(handoff.footHeight)}px)`);
  check(handoff.pad.length === 12, `${w}px 사장님 확인 화면: 숫자판 12키가 모두 있어야 한다 (${handoff.pad.length}개)`);
  handoff.pad.forEach((k, i) => {
    check(k.height >= 44, `${w}px 사장님 확인 화면: 숫자키 ${i + 1} 터치 타겟이 작다 (${Math.round(k.height)}px)`);
    check(k.left >= -1 && k.right <= clientW + 1, `${w}px 사장님 확인 화면: 숫자키 ${i + 1}이(가) 화면 밖이다`);
  });
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-handoff-pin-${w}.png`) }).catch(() => {});

  // ── owner 맥락 PIN 화면: [사장님용 잠금 해제]로 사장님이 스스로 여는 화면 ──
  //    handoff 화면과 같은 마크업이지만 제목·소제목·되돌아가기 라벨이 다르다(라벨이 6글자로 더 길다).
  //    beta.19에서 이 화면은 120초 유휴 복귀를 가지므로, 손님이 오탭해도 결국 여기로 되돌아온다 —
  //    즉 실사용에서 실제로 노출되는 화면이라 4뷰포트 레이아웃 검증을 유지한다.
  await page.locator('[data-a="pin-to-cust"]').click();
  await page.waitForSelector('#custSearchInput');
  await page.locator('[data-a="lock-to-pin"]').click();
  await page.waitForSelector('.pin-screen [data-a="pin-key"]');
  await noHorizontalOverflow(page, 'owner PIN 화면', w);
  const ownerPin = await page.evaluate(() => {
    const title = document.querySelector('.pin-title'), sub = document.querySelector('.pin-sub');
    const t = title.getBoundingClientRect(), s = sub.getBoundingClientRect();
    const foot = document.querySelector('.cust-foot button'), f = foot ? foot.getBoundingClientRect() : null;
    const dots = [...document.querySelectorAll('.pin-dot')].map(d => { const r = d.getBoundingClientRect(); return { left: r.left, right: r.right, filled: d.classList.contains('filled') }; });
    const pad = [...document.querySelectorAll('.pin-key')].map(b => { const r = b.getBoundingClientRect(); return { height: r.height, left: r.left, right: r.right }; });
    return {
      title: title.innerText.trim(), titleClipped: title.scrollWidth > title.clientWidth + 1,
      titleLeft: t.left, titleRight: t.right,
      subText: sub.innerText.replace(/\n/g, ' ').trim(), subClipped: sub.scrollWidth > sub.clientWidth + 1,
      subLeft: s.left, subRight: s.right,
      footText: foot ? foot.innerText.trim() : '',
      footClipped: foot ? (foot.scrollWidth > foot.clientWidth + 1 || foot.scrollHeight > foot.clientHeight + 1) : false,
      footHeight: f ? f.height : 0, footLeft: f ? f.left : 0, footRight: f ? f.right : 0,
      dots, pad
    };
  });
  check(ownerPin.title === '비밀번호 입력', `${w}px owner PIN 화면: 제목이 "비밀번호 입력"이어야 한다 (got "${ownerPin.title}")`);
  check(!ownerPin.titleClipped && ownerPin.titleLeft >= -1 && ownerPin.titleRight <= clientW + 1, `${w}px owner PIN 화면: 제목이 잘리거나 화면 밖으로 나갔다`);
  check(ownerPin.subText === '비밀번호를 입력하세요', `${w}px owner PIN 화면: 소제목은 손님 이름 없는 일반 안내여야 한다 (got "${ownerPin.subText}")`);
  check(!ownerPin.subClipped && ownerPin.subLeft >= -1 && ownerPin.subRight <= clientW + 1, `${w}px owner PIN 화면: 소제목이 잘리거나 화면 밖으로 나갔다`);
  check(ownerPin.footText === '손님 화면으로', `${w}px owner PIN 화면: 되돌아가기 버튼은 [손님 화면으로]여야 한다 (got "${ownerPin.footText}")`);
  check(!ownerPin.footClipped, `${w}px owner PIN 화면: [손님 화면으로] 라벨이 잘렸다 (좁은 화면에서 가장 먼저 깨지는 6글자 라벨)`);
  check(ownerPin.footHeight >= 30 && ownerPin.footLeft >= -1 && ownerPin.footRight <= clientW + 1, `${w}px owner PIN 화면: [손님 화면으로] 버튼이 화면 밖이거나 너무 작다 (${Math.round(ownerPin.footHeight)}px)`);
  check(ownerPin.dots.length === 4, `${w}px owner PIN 화면: 입력 점 4개가 있어야 한다 (${ownerPin.dots.length}개)`);
  check(ownerPin.dots.every(d => !d.filled), `${w}px owner PIN 화면: 새로 연 화면의 입력 점은 하나도 차 있으면 안 된다`);
  ownerPin.dots.forEach((d, i) => {
    check(d.left >= -1 && d.right <= clientW + 1, `${w}px owner PIN 화면: 입력 점 ${i + 1}이(가) 화면 밖이다`);
  });
  check(ownerPin.pad.length === 12, `${w}px owner PIN 화면: 숫자판 12키가 모두 있어야 한다 (${ownerPin.pad.length}개)`);
  ownerPin.pad.forEach((k, i) => {
    check(k.height >= 44, `${w}px owner PIN 화면: 숫자키 ${i + 1} 터치 타겟이 작다 (${Math.round(k.height)}px)`);
    check(k.left >= -1 && k.right <= clientW + 1, `${w}px owner PIN 화면: 숫자키 ${i + 1}이(가) 화면 밖이다`);
  });
  await page.screenshot({ path: path.join(root, 'harness', 'screenshots', `responsive-owner-pin-${w}.png`) }).catch(() => {});

  // ── PIN 분실 복구 화면(beta.18): 60초 활성화 게이트 안내와 두 파괴 버튼이 4개 뷰포트에서 온전해야 한다 ──
  //    잠금 화면에서 도달 가능한 유일한 파괴 경로라, 안내 문구가 잘리거나 버튼이 화면 밖으로 나가면 안 된다.
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

// ══════════════════════════════════════════════════════════════════════════
// 손님 검색 타이핑 회귀 (beta.20) — "폰에서 입력이 안 된다"의 재발 방지
//
// 원인이었던 것: 한 글자마다 render()가 #app.innerHTML을 통째로 갈아치웠다. 데스크톱에서는 티가 안 났지만
//   폰에서는 (a) 포커스된 입력 노드가 DOM에서 사라지며 소프트키보드 연결이 끊기고,
//   (b) 한글 IME가 음절을 확정할 때 compositionend → compositionstart → input 이 **한 키에서** 흐르는데
//       앱이 compositionend 안에서 노드를 교체하면 그 키의 나머지 이벤트가 떨어져 나간 옛 노드로 들어가
//       화면의 입력창에는 그 글자가 영영 안 찍혔다.
// 그래서 여기서는 "글자마다 결과가 갱신되는가"만 보지 않는다. **입력 노드가 살아남는가**를 못 박는다.
//   · 노드 동일성: 자바스크립트 expando(HTML에서 복원되지 않는 표식)로 확인한다.
//   · 포커스 유실: document 캡처 focusout 카운터로 확인한다(폰에서 곧 키보드가 닫히는 신호).
const TYPING_EMPLOYEES = [
  { id: 't-emp-1', org: '광진구청', orgKind: 'public', dept: '세무과', name: '김민수', amount: 30500 },
  { id: 't-emp-2', org: '광진구청', orgKind: 'public', dept: '세무과', name: '김민수아', amount: 12000 },
  { id: 't-emp-3', org: '광진구청', orgKind: 'public', dept: '세무과', name: '김민정', amount: 8000 },
  { id: 't-emp-4', org: '한빛물산', orgKind: '', dept: '총무부', name: '이서연', amount: 5000 }
];

// 입력창 노드에 표식을 심고 focusout을 세기 시작한다. 이후 어떤 검사에서도 이 표식이 사라지면 = 노드가 교체된 것.
async function markTypingProbe(page) {
  await page.evaluate(() => {
    window.__typingBlurs = 0;
    document.addEventListener('focusout', e => { if (e.target && e.target.id === 'custSearchInput') window.__typingBlurs += 1; }, true);
    const el = document.querySelector('#custSearchInput');
    el.__bapProbe = 'alive';
  });
}

async function typingState(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('#custSearchInput');
    const results = document.querySelector('#custResults');
    return {
      exists: !!el,
      sameNode: !!el && el.__bapProbe === 'alive',
      value: el ? el.value : null,
      focused: !!el && document.activeElement === el,
      blurs: window.__typingBlurs,
      rows: document.querySelectorAll('.cust-row').length,
      hint: results ? results.innerText.replace(/\n/g, ' ').trim() : '',
      stage: document.querySelector('.cust-ask') ? 'confirm' : (document.querySelector('.cust-bal') ? 'self' : 'search')
    };
  });
}

// 안드로이드 한글 IME 키 시퀀스를 그대로 흉내낸다.
//   브라우저는 "키가 눌린 시점의 포커스 요소"를 편집 컨텍스트로 고정하고, 음절이 확정되는 키에서는
//   compositionend → compositionstart → compositionupdate → input 을 한 흐름으로 내보낸다.
//   앱이 그 사이에 노드를 갈아치우면 나머지 이벤트는 화면에 없는 노드로 들어간다(= 글자 유실).
async function imeTypeHangul(page, steps) {
  return await page.evaluate((steps) => {
    const trace = [];
    for (const s of steps) {
      const target = document.activeElement;
      if (s.end) target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: s.end }));
      if (s.start) target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      target.value = s.value;
      target.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: s.data }));
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: s.data }));
      const live = document.querySelector('#custSearchInput');
      trace.push({
        key: s.data,
        expected: s.value,
        targetStillLive: target === live,
        onScreen: live ? live.value : null,
        sameNode: !!live && live.__bapProbe === 'alive',
        focused: !!live && document.activeElement === live,
        rows: document.querySelectorAll('.cust-row').length,
        stage: document.querySelector('.cust-ask') ? 'confirm' : 'search'
      });
    }
    return trace;
  }, steps);
}

// 서명 캔버스에 획을 하나 긋는다. 터치 프로파일(iPhone 13 등)에서는 브라우저가 마우스 이벤트를 내주지
//   않으므로 실제 손가락과 같은 TouchEvent를 직접 만들어 쏜다(캔버스가 듣는 것도 touchstart/touchmove/touchend다).
async function drawSignature(page, touch) {
  const box = await page.locator('.cust-sig #signCanvas').boundingBox();
  if (!touch) {
    await page.mouse.move(box.x + 20, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 6 });
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 6 });
    await page.mouse.up();
    return;
  }
  await page.evaluate(pts => {
    const c = document.querySelector('#signCanvas');
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: c, clientX: x, clientY: y });
      const list = type === 'touchend' ? [] : [t];
      return new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [t] });
    };
    c.dispatchEvent(mk('touchstart', pts[0][0], pts[0][1]));
    for (let i = 1; i < pts.length; i += 1) c.dispatchEvent(mk('touchmove', pts[i][0], pts[i][1]));
    c.dispatchEvent(mk('touchend', pts[pts.length - 1][0], pts[pts.length - 1][1]));
  }, [
    [box.x + 20, box.y + box.height * 0.6],
    [box.x + box.width * 0.35, box.y + box.height * 0.4],
    [box.x + box.width * 0.5, box.y + box.height * 0.3],
    [box.x + box.width * 0.8, box.y + box.height * 0.7]
  ]);
}

// 실제 디바이스 프로파일(터치·모바일 UA·모바일 뷰포트)로 손님 화면 타이핑을 통째로 검증한다.
async function runTypingProfile(browser, url, label, contextOpts) {
  const context = await browser.newContext(contextOpts);
  await context.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' }));
  await context.route('**/api/restaurants**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(STORE_MOCK) }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
  try {
    await page.goto(url, { waitUntil: 'load' });
    // 실기기 프로파일에서도 온보딩 1/3이 한 화면에 들어와야 한다(데스크톱 포함 — 여기서 막히면 시작조차 못 한다).
    await checkOnboardingStep1(page, label);
    await seed(page, TYPING_EMPLOYEES);
    await page.reload({ waitUntil: 'load' });
    // 잠금 화면의 기본값이 손님 화면이다 — PIN을 풀지 않고 그대로 검증한다(손님이 실제로 만나는 화면).
    await page.waitForSelector('#custSearchInput', { timeout: 8000 });

    const touch = Boolean(contextOpts.hasTouch);
    const tapInput = async () => {
      if (touch) await page.locator('#custSearchInput').tap();
      else await page.locator('#custSearchInput').click();
    };

    // ── 질의 전: 0건 문구가 아니라 안내 문구여야 한다 ──
    const before = await page.evaluate(() => {
      const r = document.querySelector('#custResults');
      return { has: !!r, html: r ? r.innerHTML : '', text: r ? r.innerText.replace(/\n/g, ' ').trim() : '', clear: document.querySelectorAll('.cust-clear').length };
    });
    // 결과 영역(#custResults)은 부분 갱신의 착지점이다 — 없으면 타이핑마다 전체 render로 되돌아간 것이다.
    check(before.has, `${label} 손님 화면: 결과 영역 #custResults가 있어야 한다(부분 갱신의 착지점 — 없으면 글자마다 전체 재렌더로 되돌아간 것)`);
    check(before.text.includes('앞글자부터 입력하면'), `${label} 손님 화면: 질의 전 안내도 접두 규칙을 알려 줘야 한다 (got "${before.text}")`);
    check(!before.text.includes('없어요'), `${label} 손님 화면: 질의 전에는 0건 문구를 절대 띄우면 안 된다 (got "${before.text}")`);
    check(before.clear === 0, `${label} 손님 화면: 질의 전에는 ✕ 지우기 버튼이 없어야 한다`);

    // ── (1) 탭 → 포커스 ──
    await tapInput();
    await markTypingProbe(page);
    let st = await typingState(page);
    check(st.focused, `${label} 손님 화면: 검색창을 탭하면 포커스가 잡혀야 한다 (activeElement=${st.value === null ? 'none' : 'other'})`);

    // ── (2) 조합 없는 한 글자씩 타이핑(초성 'ㄱㅁ' 포함) — 글자마다 입력값·포커스·노드가 유지돼야 한다 ──
    for (const [i, ch] of [...'ㄱㅁ'].entries()) {
      await page.keyboard.type(ch, { delay: 40 });
      await page.waitForTimeout(60);
      st = await typingState(page);
      const want = 'ㄱㅁ'.slice(0, i + 1);
      check(st.value === want, `${label} 초성 입력: ${i + 1}번째 글자 뒤 입력값이 "${want}"여야 한다 (got ${JSON.stringify(st.value)})`);
      check(st.sameNode, `${label} 초성 입력: 타이핑 중 입력창 노드가 교체됐다(폰에서 소프트키보드가 닫히는 원인) — ${i + 1}번째 글자`);
      check(st.focused, `${label} 초성 입력: ${i + 1}번째 글자 뒤 포커스가 검색창에서 벗어났다`);
      check(st.blurs === 0, `${label} 초성 입력: 타이핑 중 검색창이 ${st.blurs}번 포커스를 잃었다(0이어야 한다)`);
    }
    check(st.rows === 3, `${label} 초성 입력: 'ㄱㅁ'는 3명(김민수·김민수아·김민정)을 내놓아야 한다 (${st.rows}행)`);
    check(await page.locator('.cust-clear').count() === 1, `${label} 초성 입력: 글자가 있으면 ✕ 지우기 버튼이 나와야 한다`);

    // ── (3) ✕ 지우기도 입력창 노드를 죽이면 안 된다(폰에서 키보드가 닫힌다) ──
    if (touch) await page.locator('.cust-clear').tap(); else await page.locator('.cust-clear').click();
    await page.waitForTimeout(80);
    st = await typingState(page);
    check(st.value === '', `${label} ✕ 지우기: 검색어가 비워져야 한다 (got ${JSON.stringify(st.value)})`);
    check(st.sameNode, `${label} ✕ 지우기: 입력창 노드가 교체됐다(폰 키보드가 닫힌다)`);
    check(st.focused, `${label} ✕ 지우기: 지운 뒤에도 포커스는 검색창에 남아야 한다`);
    check(st.rows === 0 && st.hint.includes('앞글자부터 입력하면'), `${label} ✕ 지우기: 질의 전 안내로 되돌아가야 한다 (got "${st.hint}")`);
    check(await page.locator('.cust-clear').count() === 0, `${label} ✕ 지우기: 검색어가 비면 ✕ 버튼도 사라져야 한다`);

    // ── (4) 한글 조합(IME) '김민수' — 음절 확정 키에서 글자가 유실되면 안 된다 ──
    //   ✕ 버튼을 탭하면 그 순간 focusout이 한 번 나는 게 정상이다(포커스는 곧바로 되돌아온다) — 여기서 0으로 되돌린다.
    await page.evaluate(() => { window.__typingBlurs = 0; });
    const trace = await imeTypeHangul(page, [
      { end: null, start: true, data: 'ㄱ', value: 'ㄱ' },
      { end: null, start: false, data: '기', value: '기' },
      { end: null, start: false, data: '김', value: '김' },
      { end: '김', start: true, data: 'ㅁ', value: '김ㅁ' },   // ← 확정 + 다음 음절 시작이 한 키에서
      { end: null, start: false, data: '미', value: '김미' },
      { end: null, start: false, data: '민', value: '김민' },
      { end: '민', start: true, data: 'ㅅ', value: '김민ㅅ' },
      { end: null, start: false, data: '수', value: '김민수' }
    ]);
    trace.forEach(t => {
      check(t.targetStillLive, `${label} 한글 조합: '${t.key}' 키를 처리하는 도중 입력창 노드가 교체됐다 — 이 키의 나머지 이벤트가 화면 밖 노드로 들어간다`);
      check(t.sameNode, `${label} 한글 조합: '${t.key}' 입력 뒤 입력창 노드가 교체됐다(조합·키보드가 끊긴다)`);
      check(t.onScreen === t.expected, `${label} 한글 조합: '${t.key}' 입력 뒤 화면의 검색창이 "${t.expected}"여야 한다 (got ${JSON.stringify(t.onScreen)})`);
      check(t.focused, `${label} 한글 조합: '${t.key}' 입력 뒤 포커스가 검색창에서 벗어났다`);
      check(t.stage === 'search', `${label} 한글 조합: 조합 중에는 확인 카드로 넘어가면 안 된다 ('${t.key}')`);
    });
    st = await typingState(page);
    check(st.blurs === 0, `${label} 한글 조합: 타이핑 내내 포커스 유실이 0이어야 한다 (got ${st.blurs})`);
    check(st.rows === 2, `${label} 한글 조합: '김민수'는 2명(김민수·김민수아)을 내놓아야 한다 (${st.rows}행)`);

    // ── (5) 조합이 끝나면(compositionend) 기존 계약대로 1명 → 확인 카드 ──
    await page.evaluate(() => {
      const el = document.querySelector('#custSearchInput');
      el.value = '김민정';
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '정' }));
    });
    await page.waitForSelector('.cust-ask', { timeout: 4000 });
    check(await page.locator('.cust-ask').count() === 1, `${label} 조합 종료: 결과가 1명이면 확인 카드로 넘어가야 한다(기존 계약)`);
    check((await page.locator('.cust-name').innerText()).includes('김민정'), `${label} 조합 종료: 확인 카드에 찾은 사람이 나와야 한다`);
    await page.locator('[data-a="cust-cancel"]').click();
    await page.waitForSelector('#custSearchInput');
    await markTypingProbe(page);

    // ── (6) 결과 없음 안내 — 손님이 친 글자를 되돌려 주고 초성 팁을 함께 준다 ──
    await tapInput();
    for (const ch of [...'홍길동']) { await page.keyboard.type(ch, { delay: 30 }); await page.waitForTimeout(40); }
    const none = await typingState(page);
    check(none.rows === 0, `${label} 결과 없음: '홍길동'은 0건이어야 한다 (${none.rows}행)`);
    check(none.hint.includes("'홍길동'(으)로 시작하는 이름이 없어요."), `${label} 결과 없음: 손님이 친 이름을 그대로 되돌려 줘야 한다 (got "${none.hint}")`);
    check(none.hint.includes('사장님께 말씀해 주세요'), `${label} 결과 없음: 사장님께 말씀해 달라는 안내가 있어야 한다 (got "${none.hint}")`);
    check(none.hint.includes('초성도 돼요'), `${label} 결과 없음: 초성 검색 팁을 한 줄 병기해야 한다 (got "${none.hint}")`);
    // ── beta.23(LOW-6): 검색은 **앞글자 일치**다. 0건 안내가 그 규칙을 말하지 않으면 손님은 "등록이 안 됐다"고
    //   오해한 채 돌아선다 — 실제로는 '홍길동'을 '길동'으로 친 경우가 대부분이다. 규칙 + 예시를 그 자리에서 준다.
    check(none.hint.includes('앞글자부터'), `${label} 결과 없음: "앞글자부터" 입력하라는 접두 규칙 안내가 있어야 한다 (got "${none.hint}")`);
    check(none.hint.includes('뒷부분'), `${label} 결과 없음: "뒷부분 말고"라는 대비 설명이 있어야 한다 (got "${none.hint}")`);
    check(none.hint.includes('홍길동') && none.hint.includes("'홍'"), `${label} 결과 없음: 접두 규칙은 예시(홍길동 → '홍')와 함께 줘야 한다 (got "${none.hint}")`);
    const ph = await page.locator('#custSearchInput').getAttribute('placeholder');
    check(String(ph).includes('앞글자부터'), `${label} 검색창: placeholder가 접두 규칙을 알려 줘야 한다 (got "${ph}")`);
    check(String(ph).includes('초성'), `${label} 검색창: placeholder에 초성 안내도 남아 있어야 한다 (got "${ph}")`);
    check(none.sameNode && none.focused && none.blurs === 0, `${label} 결과 없음: 0건이어도 입력창 노드·포커스는 그대로여야 한다`);

    // ── (7) 결과 없음 문구의 이스케이프 — 손님이 친 글자는 절대 HTML로 해석되지 않는다 ──
    await page.locator('#custSearchInput').fill('<img src=x onerror=alert(1)>&');
    await page.waitForTimeout(80);
    const escaped = await page.evaluate(() => {
      const r = document.querySelector('#custResults') || document.querySelector('.cust-body');
      if (!r) return { text: '', injected: -1, html: '' };
      return { text: r.innerText.replace(/\n/g, ' ').trim(), injected: r.querySelectorAll('img, script').length, html: r.innerHTML };
    });
    check(escaped.injected === 0, `${label} 결과 없음: 입력값이 HTML로 주입되면 안 된다`);
    check(escaped.text.includes('<img src=x onerror=alert(1)>&'), `${label} 결과 없음: 입력값이 글자 그대로 보여야 한다 (got "${escaped.text}")`);
    check(escaped.html.includes('&amp;') && escaped.html.includes('&lt;img'), `${label} 결과 없음: 입력값은 esc()를 거쳐야 한다`);

    // ── (8) 통합 요청 화면(beta.22): 실제 디바이스 프로파일에서도 금액 타이핑이 서명을 지우면 안 된다 ──
    //   4뷰포트 검증(runViewport)과 같은 회귀를 **터치·모바일 UA·모바일 뷰포트**에서 한 번 더 못 박는다.
    //   이 화면은 손님 손이 가장 오래 머무는 자리이고, 여기서 서명이 사라지면 손님은 처음부터 다시 써야 한다.
    await page.locator('#custSearchInput').fill('이서연');
    await page.waitForSelector('.cust-ask', { timeout: 4000 });
    await page.locator('[data-a="cust-confirm"]').click();
    await page.waitForSelector('#custAmountInput');
    await page.waitForSelector('.cust-sig #signCanvas');
    // beta.24: 실기기 프로파일에서도 [네, 맞아요] 다음이 곧바로 금액 칸이어야 한다(중간 잔액 화면 없음).
    check(await page.locator('.cust-bal').count() === 0, `${label} 손님 화면: [네, 맞아요] 직후에 잔액 화면이 끼어들면 안 된다`);
    check(await page.locator('#custAmountInput').count() === 1 && await page.locator('.cust-sig #signCanvas').count() === 1,
      `${label} 통합 요청 화면: 금액 칸과 서명 캔버스가 한 화면에 함께 있어야 한다`);
    await drawSignature(page, touch);
    await page.evaluate(() => {
      window.__composeBlurs = 0;
      document.addEventListener('focusout', e => { if (e.target && e.target.id === 'custAmountInput') window.__composeBlurs += 1; }, true);
      document.querySelector('#custAmountInput').__bapProbe = 'alive';
      document.querySelector('#signCanvas').__bapStroke = 'alive';
    });
    check((await page.evaluate(() => window.__prepaidTestHooks.lockState().signPadEmpty)) === false, `${label} 통합 요청 화면: 사전 서명이 실제로 그려져야 회귀 검증이 성립한다`);
    if (touch) await page.locator('#custAmountInput').tap(); else await page.locator('#custAmountInput').click();
    for (const [i, ch] of [...'12345'].entries()) {
      await page.keyboard.type(ch, { delay: 30 });
      await page.waitForTimeout(50);
      const s = await page.evaluate(() => {
        const el = document.querySelector('#custAmountInput'), c = document.querySelector('#signCanvas');
        return {
          same: !!el && el.__bapProbe === 'alive', value: el ? el.value : null, focused: !!el && document.activeElement === el,
          blurs: window.__composeBlurs, canvasSame: !!c && c.__bapStroke === 'alive',
          empty: window.__prepaidTestHooks.lockState().signPadEmpty
        };
      });
      check(s.same, `${label} 통합 요청 화면: ${i + 1}번째 글자에서 금액 입력 노드가 교체됐다`);
      check(s.focused && s.blurs === 0, `${label} 통합 요청 화면: ${i + 1}번째 글자에서 포커스를 잃었다 (blurs=${s.blurs})`);
      check(s.value === '12345'.slice(0, i + 1), `${label} 통합 요청 화면: ${i + 1}번째 글자가 입력창에 남아야 한다 (got ${JSON.stringify(s.value)})`);
      check(s.canvasSame, `${label} 통합 요청 화면: ${i + 1}번째 글자에서 서명 캔버스 노드가 교체됐다`);
      check(s.empty === false, `${label} 통합 요청 화면: ${i + 1}번째 글자에서 그려 둔 서명이 지워졌다`);
    }
    // [지우고 다시]는 서명만 지운다 — 금액은 그대로여야 한다.
    if (touch) await page.locator('[data-a="cust-sign-clear"]').tap(); else await page.locator('[data-a="cust-sign-clear"]').click();
    await page.waitForTimeout(100);
    const cleared = await page.evaluate(() => ({
      value: document.querySelector('#custAmountInput').value,
      empty: window.__prepaidTestHooks.lockState().signPadEmpty,
      canvasSame: !!document.querySelector('#signCanvas') && document.querySelector('#signCanvas').__bapStroke === 'alive'
    }));
    check(cleared.empty === true, `${label} 통합 요청 화면: [지우고 다시]가 서명을 실제로 지워야 한다`);
    check(cleared.value === '12345', `${label} 통합 요청 화면: [지우고 다시]는 금액을 건드리면 안 된다 (got ${JSON.stringify(cleared.value)})`);
    check(cleared.canvasSame, `${label} 통합 요청 화면: [지우고 다시]가 캔버스 노드를 갈아치우면 안 된다`);

    // ── beta.23 HIGH-1: **실기기 가시영역**에서 스크롤 없이 한 화면 ────────────────────
    //   devices['iPhone 13'].viewport(390×664)는 그 기기 Safari의 실제 가시높이다 — 780 고정 뷰포트가
    //   가려 주던 결함이 여기서 드러난다. 데스크톱(≥768px)은 폰 압축 규칙 대상이 아니라 제외한다.
    const vp = page.viewportSize();
    if (vp && vp.width <= 767) await fitsInFirstViewport(page, label);

    // ── beta.23 MEDIUM-3: 화면 회전 — 획을 보존한 채 백킹 스토어를 다시 잡아야 한다 ──────
    //   예전 initSignPad는 백킹 스토어를 최초 1회만 잡았다. 회전하면
    //     (a) 넓어진 CSS 폭의 오른쪽 12%가 아예 기록되지 않고(손님이 그어도 아무것도 안 남는다)
    //     (b) 이미 그린 획은 새 크기에 눌려 압축돼 보인다.
    //   둘 다 **아무 안내 없이** 일어난다 — 손님은 자기가 남긴 서명이 왜곡된 줄 모른다.
    if (vp) {
      await drawSignature(page, touch);
      await page.waitForTimeout(80);
      const rot0 = await page.evaluate(() => {
        const st = window.__prepaidTestHooks.lockState(); const c = document.querySelector('#signCanvas');
        c.__bapRot = 'alive';
        return { empty: st.signPadEmpty, strokes: st.signPadStrokes };
      });
      check(rot0.empty === false && rot0.strokes >= 1, `${label} 회전: 회전 전에 서명이 실제로 그려져 있어야 검증이 성립한다 (strokes=${rot0.strokes})`);
      await page.setViewportSize({ width: vp.height, height: vp.width });
      await page.waitForTimeout(450);
      const rot1 = await page.evaluate(() => {
        const st = window.__prepaidTestHooks.lockState(); const c = document.querySelector('#signCanvas');
        const r = c.getBoundingClientRect(), ratio = Math.max(window.devicePixelRatio || 1, 1);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) ink += 1;
        return { empty: st.signPadEmpty, strokes: st.signPadStrokes, sameNode: c.__bapRot === 'alive', ink,
          backW: c.width, backH: c.height, cssW: r.width, cssH: r.height, ratio };
      });
      check(rot1.sameNode, `${label} 회전: 캔버스 노드가 교체되면 안 된다(3중 보호 계약 — 노드가 바뀌면 획도 사라진다)`);
      check(rot1.empty === false && rot1.strokes === rot0.strokes && rot1.ink > 0,
        `${label} 회전: 그려 둔 서명이 보존돼야 한다 (empty=${rot1.empty} strokes=${rot0.strokes}→${rot1.strokes} ink=${rot1.ink})`);
      check(Math.abs(rot1.backW - rot1.cssW * rot1.ratio) <= 2,
        `${label} 회전: 백킹 스토어 가로가 새 CSS 폭×DPR로 다시 잡혀야 한다 (backing ${rot1.backW} vs ${Math.round(rot1.cssW * rot1.ratio)})`);
      check(Math.abs(rot1.backH - rot1.cssH * rot1.ratio) <= 2,
        `${label} 회전: 백킹 스토어 세로가 새 CSS 높이×DPR로 다시 잡혀야 한다 (backing ${rot1.backH} vs ${Math.round(rot1.cssH * rot1.ratio)})`);
      // 넓어진 폭의 **오른쪽 끝까지** 실제로 기록되는가 — 회전 전 백킹 스토어를 그대로 쓰면 여기서 잉크가 끊긴다.
      await page.locator('[data-a="cust-sign-clear"]').click();
      await page.waitForTimeout(80);
      const edge = await page.evaluate(() => {
        const c = document.querySelector('#signCanvas'), r = c.getBoundingClientRect();
        const mk = (t, x, y) => new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1 });
        const y = r.top + r.height / 2;
        c.dispatchEvent(mk('mousedown', r.left + 20, y));
        for (let x = 20; x <= r.width - 20; x += 8) c.dispatchEvent(mk('mousemove', r.left + x, y));
        c.dispatchEvent(mk('mousemove', r.left + r.width - 20, y));// 끝점을 정확히 찍는다(측정 오차 제거)
        c.dispatchEvent(mk('mouseup', r.left + r.width - 20, y));
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let last = -1;
        for (let x = c.width - 1; x >= 0; x -= 1) { let hit = false;
          for (let yy = 0; yy < c.height; yy += 1) { const o = (yy * c.width + x) * 4; if (d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) { hit = true; break; } }
          if (hit) { last = x; break; } }
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        return { last, expect: Math.round((r.width - 20) * ratio), backW: c.width };
      });
      check(edge.last > 0 && Math.abs(edge.last - edge.expect) <= 12,
        `${label} 회전: 회전 뒤 서명판 오른쪽 끝까지 기록돼야 한다 (잉크 끝 ${edge.last} / 기대 ${edge.expect} / 백킹 폭 ${edge.backW})`);
      await page.setViewportSize(vp);
      await page.waitForTimeout(450);
      await page.locator('[data-a="cust-sign-clear"]').click();
      await page.waitForTimeout(80);
    }

    // ── beta.23 LOW-7: 서명을 하면 "서명을 해주세요." 오류 문구가 그 자리에서 사라져야 한다 ──
    //   남아 있으면 손님은 자기가 뭘 잘못한 줄 알고 [지우고 다시]를 눌러 처음부터 다시 쓴다.
    await page.locator('#custAmountInput').fill('1000');
    await page.waitForTimeout(80);
    await page.locator('[data-a="cust-sign-submit"]').click();
    await page.waitForTimeout(150);
    const signErrBefore = (await page.locator('#custSignErr').innerText()).trim();
    check(signErrBefore.includes('서명'), `${label} 무서명 제출: 서명을 요구하는 안내가 나와야 한다 (got "${signErrBefore}")`);
    await drawSignature(page, touch);
    await page.waitForTimeout(150);
    const signErrAfter = (await page.locator('#custSignErr').innerText()).trim();
    check(signErrAfter === '', `${label} 서명 후: "${signErrBefore}" 문구가 즉시 사라져야 한다 (got "${signErrAfter}")`);

    check(pageErrors.length === 0, `${label} 손님 화면 타이핑: 콘솔/페이지 오류가 없어야 한다 (${JSON.stringify(pageErrors.slice(0, 3))})`);
  } finally {
    await page.close();
    await context.close();
  }
}

async function main() {
  await fsp.mkdir(path.join(root, 'harness', 'screenshots'), { recursive: true }).catch(() => {});
  const { server, url } = await startServer();
  const chromePath = findChrome();
  const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  try {
    for (const { w, h } of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: w, height: h },
        isMobile: w <= 640,
        hasTouch: w <= 640,
        deviceScaleFactor: 2
      });
      // 중계 서버 호출은 전부 차단(로컬 렌더링만 검증한다).
      await context.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' }));
      try {
        await runViewport(context, url, w, h);
      } finally {
        await context.close();
      }
    }
    // 손님 검색 타이핑 회귀(beta.20) — 실제 디바이스 프로파일(터치·모바일 UA)과 데스크톱을 함께 돌린다.
    for (const [label, opts] of [
      ['Pixel 7', devices['Pixel 7']],
      ['iPhone 13', { ...devices['iPhone 13'], isMobile: true, hasTouch: true }],
      ['데스크톱', { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false }]
    ]) {
      await runTypingProfile(browser, url, label, opts);
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
  console.log(`✅ 반응형 검증 ${checks} 통과 (${VIEWPORTS.map(v => `${v.w}×${v.h}`).join(' / ')})`);
}

main().catch(err => { console.error(err); process.exit(1); });
