// 실행: node harness/dongsearch.e2e.mjs
// 동 이름 → 우편번호 순회 검색(보조 경로) 검증 — 공공 API 한글 장애(§7.4)를 목으로 재현하고
// ① 0건일 때만 동 검색 버튼이 뜨는지 ② zipmap의 실제 구역만 두드리는지 ③ 자동 2라운드(18구역) 상한과
// [계속 찾기] ④ 시·군·구 없는 입력은 전국을 뒤지지 않는지(비추측 원칙) 를 클라이언트 실동작으로 확인한다.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seoulMap = JSON.parse(readFileSync(ROOT + '/zipmap/seoul.json', 'utf8'));
const GUUI_ZIPS = seoulMap['광진구']['구의동'];
if (!Array.isArray(GUUI_ZIPS) || GUUI_ZIPS.length < 20) { console.error('❌ zipmap에 광진구 구의동이 없거나 구역이 20개 미만 — 데이터 재생성 필요'); process.exit(1); }
const EARLY_ZIP = GUUI_ZIPS[4];              // 첫 라운드(9구역) 안 — 조기 발견 시나리오
const LATE_ZIP = GUUI_ZIPS[20];              // 자동 2라운드(18구역) 밖 — [계속 찾기] 시나리오
const mkRow = (zip, name) => [{ restaurant_id: '3040000-101-2026-77' + zip.slice(-2), name, address: '서울특별시 광진구 구의동 어딘가 (' + zip + ')', status: '영업/정상', tel: '', zip }];

const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const file = p === '/' ? '/index.html' : p;
  try {
    const body = readFileSync(ROOT + decodeURIComponent(file));
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch (_) { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => srv.listen(0, r));
const base = 'http://127.0.0.1:' + srv.address().port + '/';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const cors = { 'Access-Control-Allow-Origin': '*' };

async function newPage(ctx, calls, respond) {
  await ctx.route('**/api/restaurants**', async route => {
    const u = new URL(route.request().url());
    calls.push({ q: u.searchParams.get('q') || '', zip: u.searchParams.get('zip') || '' });
    const zip = u.searchParams.get('zip');
    const q = u.searchParams.get('q') || '';
    if (respond) {
      const r = await respond({ q, zip, n: calls.length });
      return route.fulfill({ status: r.status || 200, contentType: 'application/json', headers: cors, body: JSON.stringify(r.body) });
    }
    // 실서버 계약 재현: zip으로 후보를 받고 상호(q)는 서버가 부분일치로 거른다. 한글 q 단독은 0건(장애).
    // 응답에 지연을 줘서 진행 표시·[그만 찾기]를 실제로 검증할 수 있게 한다.
    await new Promise(r => setTimeout(r, 90));
    let rows = [];
    if (zip === EARLY_ZIP) rows = mkRow(zip, '도쿄오므라이스 구의점');
    if (zip === LATE_ZIP) rows = mkRow(zip, '숨은가게 구의점');
    if (q) rows = rows.filter(r => r.name.replace(/\s/g, '').includes(q.replace(/\s/g, '')));
    route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(rows) });
  });
  await ctx.route('**/api/inbox-count**', route => route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{"error":"nf"}' }));
  // beta.49: 검색 결과의 "다른 기기에서 이미 등록됨" 배지는 /api/registered 를 조회한다.
  //   목이 없으면 이 로컬 하니스가 **라이브 중계 서버로 실제 요청을 보낸다** — 반드시 막는다(배지는 이 하니스의 관심사가 아니므로 빈 배열).
  await ctx.route('**/api/registered**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-a="setup-welcome-start"], #setupStoreName', { timeout: 8000 });
  if (await page.locator('[data-a="setup-welcome-start"]').count()) {
    await page.locator('[data-a="setup-welcome-start"]').click();
    await page.waitForSelector('#setupStoreName', { timeout: 8000 });
  }
  return { page, errors };
}

const browser = await chromium.launch();

// ── 시나리오 A: 조기 발견 + 비추측 원칙 ──
{
  const ctx = await browser.newContext();
  const calls = [];
  const { page, errors } = await newPage(ctx, calls);

  // 이름만 검색(한글 장애 재현: 0건) → 지역(구·군+동) 안내가 뜬다(지역이 기본, 우편번호는 보조)
  await page.fill('#setupStoreName', '도쿄오므라이스');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('.empty', { timeout: 8000 });
  ok(await page.locator('[data-a="dong-scan"]').count() === 0, '지역 칸이 비면 동 검색이 시작되지 않는다');
  ok((await page.textContent('.setup')).includes('지역 칸에 "광진구 구의동"처럼 구·군과 동을 적고 다시 검색해 주세요'), '지역이 비었으면 "입력이 필요하다"는 안내가 뜬다');

  // 지역에 구만 적으면(동 없음) — "동까지 붙여 달라"고 입력 내용을 짚어 안내한다
  await page.fill('#setupStoreRegion', '광진구');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForFunction(() => /동\(읍·면\) 이름까지/.test(document.body.textContent), null, { timeout: 8000 });
  ok((await page.textContent('.setup')).includes('"광진구" 뒤에 동(읍·면) 이름까지'), '구만 적으면 그 입력을 짚어 "동까지 붙여 달라"고 안내한다');
  const labels = await page.$$eval('.setup label', els => els.map(e => e.textContent));
  ok(labels.indexOf(labels.find(t => t.includes('지역'))) < labels.indexOf(labels.find(t => t.includes('우편번호'))), '지역 칸이 우편번호 칸보다 앞(기본)이다');
  ok(labels.some(t => t.includes('우편번호(선택)')), '우편번호는 "(선택)" 보조 칸이다');

  // 동만 적으면(구의동) 자동 검색이 시작돼도 전국을 뒤지지 않고, 안내가 화면에 남는다(토스트 아님)
  await page.fill('#setupStoreRegion', '구의동');
  const noGuessStart = calls.length;
  await page.click('[data-a="setup-store-search"]');
  await page.waitForTimeout(900);
  ok(calls.slice(noGuessStart).every(c => !c.zip), '시·군·구 없이 동만 적으면 우편번호 순회를 시작하지 않는다(비추측 원칙)');
  ok((await page.textContent('.setup')).includes('구·군(또는 시·도)을 동 이름과 함께'), '무엇을 고쳐야 하는지가 화면에 남는다(사라지는 토스트가 아니라)');

  // "광진구 구의동" → 검색 0건이면 **버튼 없이 자동으로** 동네 순회가 이어진다 → 찾는 즉시(배치 단위) 멈춤
  await page.fill('#setupStoreRegion', '광진구 구의동');
  const scanStart = calls.length;
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 20000 });
  const scanCalls = calls.slice(scanStart).filter(c => c.zip);
  ok(scanCalls.length > 0, '0건이면 자동으로 동네(우편번호 구역) 순회가 이어진다 — 탭 불필요');
  ok(scanCalls.every(c => GUUI_ZIPS.includes(c.zip)), '순회는 구의동 우편번호 구역만 두드린다 (' + scanCalls.length + '회)');
  ok(scanCalls.length <= 6, '찾은 배치에서 즉시 멈춘다(5번째 구역 → 최대 6회) — 실제 ' + scanCalls.length + '회');
  ok(scanCalls.every(c => c.q === '도쿄오므라이스'), '가게 이름 조건을 유지한 채 구역만 바꾼다');
  const rowText = await page.textContent('.setup');
  ok(rowText.includes('도쿄오므라이스 구의점') && rowText.includes('구역에서 1곳'), '찾은 가게가 기존 선택 목록에 실린다');
  ok(!rowText.includes('지역 칸에'), '동네 검색이 이미 돌았으면 "지역 칸에 적으세요"류 안내를 다시 보여주지 않는다');

  ok(errors.length === 0, 'A: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 B: 뒤쪽 구역(21번째)에 있어도 탭 없이 자동으로 끝까지 찾아낸다 + 진행 표시 ──
{
  const ctx = await browser.newContext();
  const calls = [];
  const { page, errors } = await newPage(ctx, calls);

  await page.fill('#setupStoreName', '숨은가게');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  const scanStart = calls.length;
  await page.click('[data-a="setup-store-search"]');
  // 순회 중간: 진행률·[그만 찾기]가 보인다
  await page.waitForSelector('[data-a="dong-scan-stop"]', { timeout: 20000 });
  ok(true, '순회 중 [그만 찾기] 버튼이 보인다');
  ok((await page.textContent('.setup')).includes('동네 전체에서 찾는 중'), '진행 문구("동네 전체에서 찾는 중… n/N 구역")가 보인다');
  // 21번째 구역의 가게 — 옛 자동 상한(18구역)이었다면 못 찾았을 자리. 탭 없이 발견돼야 한다.
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 30000 });
  ok((await page.textContent('.setup')).includes('숨은가게 구의점'), '뒤쪽 구역(21번째)의 가게도 탭 없이 자동으로 찾아낸다');
  const autoCalls = calls.slice(scanStart).filter(c => c.zip).length;
  ok(autoCalls >= 19 && autoCalls <= 24, '찾은 배치에서 멈춘다(21번째 → 21~24회) — 실제 ' + autoCalls + '회');

  ok(errors.length === 0, 'B: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 C: [그만 찾기] → "남은 구역을 더 찾아보시겠습니까?" → [계속 찾기] → 전 구역 소진 안내 ──
{
  const ctx = await browser.newContext();
  const calls = [];
  const { page, errors } = await newPage(ctx, calls);

  await page.fill('#setupStoreName', '어디에도없는가게');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="dong-scan-stop"]', { timeout: 20000 });
  await page.click('[data-a="dong-scan-stop"]');
  await page.waitForSelector('[data-a="dong-scan"][data-resume="1"]', { timeout: 10000 });
  const t = await page.textContent('.setup');
  ok(/검색 결과가 없습니다\./.test(t) && /남은 구역을 더 찾아보시겠습니까\?/.test(t), '중단하면 "검색 결과가 없습니다. 남은 구역을 더 찾아보시겠습니까?"로 잇는다');
  ok(!t.includes('지역 칸에'), '중단 안내와 "지역 칸에 적으세요" 안내가 겹쳐 나오지 않는다');
  const stoppedAt = calls.filter(c => c.zip).length;
  ok(stoppedAt < GUUI_ZIPS.length, '[그만 찾기]가 실제로 순회를 멈춘다 (' + stoppedAt + '/' + GUUI_ZIPS.length + ')');

  await page.click('[data-a="dong-scan"][data-resume="1"]');
  await page.waitForFunction(() => document.querySelector('.setup') && /모두 살펴봤지만/.test(document.querySelector('.setup').textContent), null, { timeout: 30000 });
  ok(/전 구역\(49곳\)|전 구역\(\d+곳\)/.test(await page.textContent('.setup')), '[계속 찾기] 후 전 구역 소진이면 "모두 살펴봤지만 찾지 못했어요" 안내가 뜬다');
  ok(calls.filter(c => c.zip).length === GUUI_ZIPS.length, '소진 시 정확히 동네 전 구역만 두드렸다(중복·초과 없음)');

  ok(errors.length === 0, 'C: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── beta.52 현장 결함: "같은 검색(가게 이름 + 광진구 구의동)이 될 때도, 안 될 때도 있다" ──
//   중계 서버는 IP당 분당 60회 한도(429)가 있고, 구의동은 구역이 49개다. 예전에는 실패한 구역을 '가게 없음'으로 치고
//   버렸고, 끝나면 "전 구역을 모두 살펴봤지만"이라고 말했다. 이제는 실패 구역을 다시 세우고(최대 3번) 429면 쉬었다 잇는다.
//   대기 시간은 하니스에서만 1초로 줄인다(window.__zipScanWaitSec — 앱은 localhost일 때만 읽는다).
const fastWait = ctx => ctx.addInitScript(() => { window.__zipScanWaitSec = [1, 1, 1]; });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 시나리오 D: 이름 검색부터 429 → 동네 순회로 넘어가고, 429 구역은 쉬었다가 다시 물어 결국 찾는다 ──
{
  const ctx = await browser.newContext();
  await fastWait(ctx);
  const calls = [];
  let zipCalls = 0;
  const { page, errors } = await newPage(ctx, calls, async ({ q, zip }) => {
    await sleep(40);
    if (!zip) return { status: 429, body: { error: 'rate_limited' } };          // 이름 검색: 한도 초과
    zipCalls++;
    if (zipCalls <= 6) return { status: 429, body: { error: 'rate_limited' } }; // 첫 두 묶음(6구역) 전부 429
    return { body: zip === EARLY_ZIP ? mkRow(zip, '육회바른연어 구의점') : [] };
  });
  await page.fill('#setupStoreName', '육회바른연어');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  await page.click('[data-a="setup-store-search"]');
  // ⚠️ body.textContent에는 앱 인라인 스크립트 원문도 들어 있다(같은 문구가 있다) — 화면에 보이는 글자(innerText)로 판정한다.
  await page.waitForFunction(() => /서버에 요청이 몰려 잠깐 쉬고 있어요/.test(document.querySelector('.setup').innerText), null, { timeout: 15000 });
  ok(true, '429를 받으면 "서버에 요청이 몰려 잠깐 쉬고 있어요 — N초 뒤 이어서" 안내를 보여 준다');
  ok(await page.locator('[data-a="dong-scan-stop"]').count() === 1, '쉬는 동안에도 [그만 찾기]가 있다');
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 60000 });
  const t = await page.textContent('.setup');
  ok(t.includes('육회바른연어 구의점'), '처음에 429로 막혔던 구역(5번째)의 가게도 다시 물어 결국 찾아낸다');
  ok(calls.filter(c => c.zip === EARLY_ZIP).length >= 2, '429였던 구역은 버리지 않고 다시 묻는다 (' + calls.filter(c => c.zip === EARLY_ZIP).length + '회)');
  ok(!/rate_limited/.test(await page.innerText('body')), '서버 영문 오류 코드(rate_limited)를 사장님께 그대로 보이지 않는다');
  ok(errors.length === 0, 'D: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 E: 끝까지 실패하는 구역이 있으면 "모두 살펴봤다"고 말하지 않고, 남은 구역을 다시 찾게 한다 ──
{
  const ctx = await browser.newContext();
  await fastWait(ctx);
  const calls = [];
  const BAD = [GUUI_ZIPS[10], GUUI_ZIPS[11]];
  let healed = false;
  const { page, errors } = await newPage(ctx, calls, async ({ zip }) => {
    await sleep(20);
    if (zip && BAD.includes(zip) && !healed) return { status: 500, body: { error: 'internal' } };
    if (zip === BAD[1] && healed) return { body: mkRow(zip, '깊은가게 구의점') };
    return { body: [] };
  });
  await page.fill('#setupStoreName', '깊은가게');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="dong-scan"][data-resume="1"]', { timeout: 60000 });
  const t = await page.textContent('.setup');
  ok(t.includes('2개 구역은 서버가 바빠 확인하지 못했어요'), '확인 못 한 구역 수를 정직하게 알린다');
  ok(!/모두 살펴봤지만/.test(t), '확인 못 한 구역이 남았는데 "모두 살펴봤지만 찾지 못했어요"라고 말하지 않는다');
  ok(BAD.every(z => calls.filter(c => c.zip === z).length === 3), '실패 구역은 구역당 정확히 3번까지만 묻는다 (' + BAD.map(z => calls.filter(c => c.zip === z).length).join('/') + ')');
  ok((await page.textContent('[data-a="dong-scan"][data-resume="1"]')).includes('확인 못 한 2개 구역 다시 찾기'), '[확인 못 한 2개 구역 다시 찾기] 버튼을 준다');
  healed = true;
  const before = calls.length;
  await page.click('[data-a="dong-scan"][data-resume="1"]');
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 20000 });
  ok((await page.textContent('.setup')).includes('깊은가게 구의점'), '다시 찾기로 그 구역의 가게를 찾아낸다');
  ok(calls.slice(before).every(c => !c.zip || BAD.includes(c.zip)), '다시 찾기는 확인 못 한 구역만 다시 묻는다(이미 본 구역 재요청 없음)');
  ok(errors.length === 0, 'E: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 F: 순회 중에 가게 이름을 고쳐 쳐도 글자가 되돌아가지 않고 커서(키보드)가 유지된다 ──
{
  const ctx = await browser.newContext();
  const calls = [];
  const { page, errors } = await newPage(ctx, calls, async () => { await sleep(250); return { body: [] }; });
  await page.fill('#setupStoreName', '육회');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="dong-scan-stop"]', { timeout: 20000 });
  const inputBefore = await page.evaluateHandle(() => document.getElementById('setupStoreName'));
  await page.click('#setupStoreName');
  await page.keyboard.press('End');
  const progressAt = async () => (await page.textContent('.setup')).match(/(\d+)\/\d+ 구역/);
  const p0 = await progressAt();
  await page.keyboard.type('바른연어', { delay: 120 });
  await page.waitForFunction(n => { const m = document.querySelector('.setup').textContent.match(/(\d+)\/\d+ 구역/); return m && Number(m[1]) >= n; }, Number(p0 ? p0[1] : 0) + 6, { timeout: 20000 });
  ok(await page.inputValue('#setupStoreName') === '육회바른연어', '순회 진행 중에 친 글자가 되돌아가지 않는다 (지금 값: ' + JSON.stringify(await page.inputValue('#setupStoreName')) + ')');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'setupStoreName', '순회 진행 표시가 바뀌어도 입력칸 포커스(폰 키보드)가 유지된다');
  ok(await page.evaluate(el => el === document.getElementById('setupStoreName'), inputBefore), '입력 중에는 진행 표시만 갈아끼우고 입력칸 노드는 그대로 둔다(한글 조합 보호)');
  await page.click('[data-a="dong-scan-stop"]');
  await page.click('#setupStoreName');
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await page.waitForSelector('[data-a="dong-scan"][data-resume="1"]', { timeout: 10000 });
  ok(await page.inputValue('#setupStoreName') === '육회바른연어X', '순회가 끝나 화면을 다시 그려도 고친 이름이 남는다');
  ok(errors.length === 0, 'F: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 G: 찾은 가게가 우리 가게가 아닐 때 [남은 구역 계속 찾기]가 실제로 더 찾는다 ──
//   (예전 조건 !ds.found.length 때문에 이미 찾은 곳이 있으면 한 바퀴도 돌지 않았다)
{
  const ctx = await browser.newContext();
  const calls = [];
  const { page, errors } = await newPage(ctx, calls, async ({ zip }) => {
    await sleep(20);
    if (zip === EARLY_ZIP) return { body: mkRow(zip, '두집 다른점') };
    if (zip === LATE_ZIP) return { body: [{ ...mkRow(zip, '두집 구의점')[0], restaurant_id: '3040000-101-2026-9999' }] };
    return { body: [] };
  });
  await page.fill('#setupStoreName', '두집');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="dong-scan"][data-resume="1"]', { timeout: 20000 });
  ok((await page.textContent('.setup')).includes('두집 다른점'), '먼저 찾은 가게를 보여 준다');
  await page.click('[data-a="dong-scan"][data-resume="1"]');
  await page.waitForFunction(() => /두집 구의점/.test(document.querySelector('.setup').textContent), null, { timeout: 20000 });
  const t = await page.textContent('.setup');
  ok(t.includes('두집 구의점') && t.includes('두집 다른점'), '[계속 찾기]가 남은 구역을 돌아 다음 가게를 찾고, 먼저 찾은 가게도 목록에 남는다');
  ok(errors.length === 0, 'G: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
