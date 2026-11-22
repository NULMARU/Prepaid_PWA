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

async function newPage(ctx, calls, respond, opts = {}) {
  // 안전망: 목이 없는 중계 API 호출은 전부 500으로 끊는다(라이브 서버에 닿지 않게). 나중에 건 라우트가 이기므로 맨 먼저 건다.
  await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"harness: no mock"}' }));
  await ctx.route('**/api/restaurants**', async route => {
    const u = new URL(route.request().url());
    calls.push({ q: u.searchParams.get('q') || '', zip: u.searchParams.get('zip') || '', wait: u.searchParams.get('wait') || '' });
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
  await ctx.route('**/api/registered**', async route => { if (opts.registeredDelay) await new Promise(r => setTimeout(r, opts.registeredDelay)); route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(opts.registered ? opts.registered() : []) }); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-a="setup-welcome-start"], #setupStoreName', { timeout: 8000 });
  if (!opts.stayOnWelcome && await page.locator('[data-a="setup-welcome-start"]').count()) {
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
  // beta.60b: 입력 칸은 [가게 이름]·[지역 (구·군과 동)] 두 개뿐 — 우편번호 칸·우편번호 안내문은 사장님 눈에 없다(내부 구역 순회는 그대로).
  const labels = await page.$$eval('.setup label', els => els.map(e => e.textContent.trim()));
  const setupInputs = await page.$$eval('.setup .form input', els => els.map(e => e.id));
  ok(JSON.stringify(labels) === JSON.stringify(['가게 이름', '지역 (구·군과 동)']) && JSON.stringify(setupInputs) === JSON.stringify(['setupStoreName', 'setupStoreRegion']),
    '1/3 입력 칸은 가게 이름·지역 두 개뿐(우편번호 칸 없음) — ' + JSON.stringify({ labels, setupInputs }));
  const setupVisible = await page.evaluate(() => document.querySelector('.setup').innerText);
  ok(!/우편번호/.test(setupVisible) && setupVisible.includes('이름으로 안 나오면 지역(구·군과 동)을 함께 적어 주세요 — 동네 전체에서 자동으로 찾아봐요.'),
    '1/3 화면 글자에 "우편번호"가 없고 도움말은 계약 문장 그대로다');

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
  ok((await page.locator('[data-a="dong-scan-stop"]').innerText()).trim() === '그만두기', '순회가 시작되면 곧바로 [그만두기] 버튼이 보인다(beta.60b: 예전 [그만 찾기])');
  ok(!/우편번호/.test(await page.evaluate(() => document.querySelector('.setup').innerText)), '순회 진행 문구에도 "우편번호"가 없다');
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

// ── 시나리오 H(beta.56): 공공데이터가 제때 답하지 않으면(서버 503 public_api_timeout) "검색 결과 없음"이 아니라
//    "불러오지 못했어요 · 와이파이 확인 · 직접 입력"을 화면에 **남긴다**(3초 토스트로 사라지지 않는다) ──
{
  const ctx = await browser.newContext();
  const calls = [];
  let mode = 'timeout';
  const { page, errors } = await newPage(ctx, calls, async ({ zip }) => {
    await sleep(20);
    if (mode === 'timeout') return { status: 503, body: { error: 'public_api_timeout' } };
    if (mode === 'busy') return { status: 429, body: { error: 'rate_limited' } };
    return { body: mkRow(zip || EARLY_ZIP, '느린날식당') };
  });
  const setupText = () => page.evaluate(() => document.querySelector('.setup').innerText);
  ok((await page.locator('.store-search-err').count()) === 0, 'H: 검색 전(온라인)에는 실패 안내가 없다');
  await page.fill('#setupStoreName', '느린날식당');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('.store-search-err', { timeout: 8000 });
  let t = await setupText();
  ok(t.includes('가게 목록을 불러오지 못했어요') && t.includes('와이파이(인터넷)를 확인하고 다시 눌러 주세요') && t.includes('[직접 입력할게요]로 먼저 시작하세요'),
    'H: 서버 503(공공데이터 응답 없음) → "불러오지 못했어요 · 와이파이 확인 · 직접 입력" 안내 — ' + JSON.stringify(t.slice(-160)));
  ok(!t.includes('검색 결과가 없습니다') && !t.includes('목록에 우리 가게가 없나요') && !/public_api_timeout|internal/.test(t),
    'H: 실패를 "검색 결과 없음"으로 말하지 않고(간판·상호 안내도 없음) 영문 코드도 보이지 않는다');
  await sleep(4200); // 토스트(3초)였다면 사라졌을 시간
  ok((await page.locator('.store-search-err[data-code="fail"]').count()) === 1 && (await page.inputValue('#setupStoreName')) === '느린날식당',
    'H: 안내는 4초 뒤에도 화면에 남아 있고 입력한 가게 이름도 그대로다');
  ok(await page.locator('[data-a="setup-manual-toggle"]').isVisible(), 'H: [직접 입력할게요] 버튼이 함께 보인다(막다른 길 아님)');
  mode = 'busy';
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('.store-search-err[data-code="busy"]', { timeout: 8000 });
  ok((await setupText()).includes('검색 요청이 잠시 몰렸어요'), 'H: 429는 "요청이 몰렸어요 · 30초쯤 뒤" 안내');
  mode = 'ok';
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 8000 });
  ok((await page.locator('.store-search-err').count()) === 0 && (await setupText()).includes('느린날식당'), 'H: 다시 눌러 성공하면 안내는 사라지고 결과가 보인다');
  ok(errors.length === 0, 'H: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 I(beta.56): 와이파이(인터넷)가 없으면 누르기 전부터 한 줄로 알리고, 연결되면 스스로 사라진다 ──
{
  const ctx = await browser.newContext();
  const calls = [];
  const { page, errors } = await newPage(ctx, calls);
  const setupText = () => page.evaluate(() => document.querySelector('.setup').innerText);
  await page.fill('#setupStoreName', '오프라인식당');
  // 글자를 치는 중에는 화면을 갈아엎지 않는다(입력 보호) — 칸에서 손을 뗀 상태에서 연결이 끊기면 곧바로 안내가 뜬다.
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  await ctx.setOffline(true);
  await page.waitForSelector('.store-search-err[data-code="offline"]', { timeout: 8000 });
  let t = await setupText();
  ok(t.includes('와이파이(인터넷)에 연결해야 가게를 찾을 수 있어요') && t.includes('연결이 어려우면 [직접 입력할게요]로 먼저 시작하세요'),
    'I: 오프라인이 되면 검색을 누르기 전에도 "와이파이에 연결해야 찾을 수 있어요 · 직접 입력" 안내 — ' + JSON.stringify(t.slice(-120)));
  ok((await page.inputValue('#setupStoreName')) === '오프라인식당', 'I: 안내가 뜨는 동안 입력한 가게 이름이 그대로다');
  const before = calls.length;
  await page.click('[data-a="setup-store-search"]');
  await sleep(500);
  t = await setupText();
  ok(calls.length === before && (await page.locator('.store-search-err[data-code="offline"]').count()) === 1 && !t.includes('검색 결과가 없습니다'),
    'I: 오프라인에서 [가게 찾기]를 눌러도 서버를 두드리지 않고, "검색 결과 없음"이 아니라 와이파이 안내가 남는다');
  // 글자를 치는 중에 끊겨도(화면은 그대로) [가게 찾기]를 누르면 같은 안내가 뜬다
  await ctx.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.store-search-err'), null, { timeout: 8000 });
  await page.click('#setupStoreName');
  await ctx.setOffline(true);
  await sleep(300);
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('.store-search-err[data-code="offline"]', { timeout: 8000 });
  ok(calls.length === before && (await page.inputValue('#setupStoreName')) === '오프라인식당', 'I: 입력 중에 끊긴 경우에도 [가게 찾기]를 누르면 와이파이 안내가 뜬다(서버 호출 없음·입력 유지)');
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  await ctx.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.store-search-err'), null, { timeout: 8000 });
  ok((await page.inputValue('#setupStoreName')) === '오프라인식당', 'I: 다시 연결되면 안내가 스스로 사라지고 입력값은 그대로다');
  ok(errors.length === 0, 'I: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 J(beta.57): 첫 검색이 시간 초과(503)·끊김이면 49구역 순회로 넘어가기 전에 **같은 검색을 두 번 더** 한다.
//    현장(2026-11-14): 공공데이터가 한 번 응답에 8~40초 — 한 번 실패로 순회에 들어가면 "1/49 구역"에서 몇 분을 보냈다. ──
{
  const ctx = await browser.newContext();
  const calls = [];
  let plan = ['t', 't', 'ok'];
  const { page, errors } = await newPage(ctx, calls, async ({ zip }) => {
    if (zip) { await sleep(10); return { body: [] }; }
    await sleep(700);
    const step = plan.shift() || 'ok';
    if (step === 't') return { status: 503, body: { error: 'public_api_timeout' } };
    if (step === 'busy') return { status: 429, body: { error: 'rate_limited' } };
    return { body: mkRow(EARLY_ZIP, '서울김밥') };
  });
  const setupText = () => page.evaluate(() => document.querySelector('.setup').innerText);
  const nameCalls = () => calls.filter(c => !c.zip).length, zipCalls = () => calls.filter(c => c.zip).length;
  await page.fill('#setupStoreName', '서울김밥');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  await page.click('[data-a="setup-store-search"]');
  const busy1 = await page.waitForSelector('.store-search-busy[data-try="1"]', { timeout: 3000 }).then(() => true, () => false);
  ok(busy1 && (await setupText()).includes('가게 목록을 받아 오는 중이에요'), 'J: 검색하는 동안 무엇을 하는지 한 줄이 보인다("받아 오는 중 · 느린 날은 30초쯤")');
  // 다시 찾는 동안 사장님이 이름 칸을 누르고 있어도 입력 노드는 그대로다(진행 한 줄만 갈아끼움)
  await page.focus('#setupStoreName');
  await page.evaluate(() => { window.__nameNode = document.getElementById('setupStoreName'); });
  // 문구와 노드 동일성을 **같은 순간에** 읽는다(부하가 높은 날 그 사이 3번째 시도로 넘어가도 흔들리지 않게)
  const try2 = await page.waitForFunction(() => { const e = document.querySelector('.store-search-busy[data-try="2"]'); if (!e) return false; const n = document.getElementById('setupStoreName'); return { text: e.innerText, same: n === window.__nameNode && document.activeElement === n }; }, null, { timeout: 5000, polling: 40 }).then(h => h.jsonValue(), () => null);
  ok(!!try2 && try2.text.includes('공공데이터가 느려요. 다시 찾는 중 (2/3)'), 'J: 첫 응답이 시간 초과면 "공공데이터가 느려요. 다시 찾는 중 (2/3)"로 알리고 같은 검색을 다시 한다 — ' + JSON.stringify(try2 && try2.text));
  ok(!!try2 && try2.same, 'J: 다시 찾는 동안에도 가게 이름 입력 노드·포커스는 그대로다(전체 화면을 갈아엎지 않음)');
  const found = await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 8000 }).then(() => true, () => false);
  ok(found && nameCalls() === 3 && zipCalls() === 0, 'J: 세 번째에 답이 오면 곧바로 결과 — 이름 검색 3회, 동네 순회(우편번호 호출) 0회 — 이름 ' + nameCalls() + ' / 구역 ' + zipCalls());
  ok((await page.locator('.store-search-busy').count()) === 0 && (await page.locator('.store-search-err').count()) === 0 && (await setupText()).includes('서울김밥'),
    'J: 결과가 나오면 진행 한 줄·실패 안내는 없다');
  ok(calls.length > 0 && calls.every(c => c.wait === 'long'), 'J: 가게 찾기 요청은 모두 wait=long(서버가 25초까지 기다림)을 싣는다 — ' + JSON.stringify(calls.map(c => c.wait)));
  // 세 번 모두 시간 초과 + 지역(구·군+동)이 있으면 그제서야 동네 순회로 넘어간다
  calls.length = 0; plan = ['t', 't', 't'];
  await page.click('[data-a="setup-store-search"]');
  for (let i = 0; i < 100 && zipCalls() === 0; i++) await sleep(100);   // 이름 검색 3회(각 0.7초)가 끝나고 순회가 시작될 때까지
  await page.waitForFunction(() => !document.querySelector('[data-a="dong-scan-stop"]') && !document.querySelector('.store-search-busy'), null, { timeout: 30000 }).catch(() => {});
  ok(nameCalls() === 3 && zipCalls() === GUUI_ZIPS.length, 'J: 세 번 다 시간 초과면 이름 검색 3회 뒤에 동네 순회(' + GUUI_ZIPS.length + '구역)로 넘어간다 — 이름 ' + nameCalls() + ' / 구역 ' + zipCalls());
  // 분당 한도(429)는 다시 해도 같으므로 재시도하지 않는다
  calls.length = 0; plan = ['busy', 'ok'];
  await page.fill('#setupStoreRegion', '');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('.store-search-err[data-code="busy"]', { timeout: 5000 }).catch(() => {});
  await sleep(1200);
  ok(nameCalls() === 1 && (await page.locator('.store-search-err[data-code="busy"]').count()) === 1, 'J: 429(요청 몰림)는 재시도하지 않고 바로 안내한다 — 이름 ' + nameCalls() + '회');
  // 다시 찾는 중에 [가게 찾기]를 또 누르면 앞선 검색은 물러난다(늦게 온 옛 응답이 화면을 덮지 않음)
  calls.length = 0; plan = ['t', 'ok', 't', 't', 't'];
  await page.fill('#setupStoreName', '옛검색');
  await page.click('[data-a="setup-store-search"]');
  await sleep(150);
  await page.fill('#setupStoreName', '서울김밥');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 8000 }).catch(() => {});
  await sleep(1800);
  ok(calls.filter(c => c.q === '옛검색').length === 1 && (await page.locator('[data-a="setup-store-pick"]').count()) === 1 && (await page.locator('.store-search-err').count()) === 0 && (await page.locator('.store-search-busy').count()) === 0,
    'J: 새로 누른 검색이 이긴다 — 옛 검색은 1회로 멈추고 결과·안내를 덮지 않는다 — 옛 ' + calls.filter(c => c.q === '옛검색').length + '회');
  ok(errors.length === 0, 'J: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 K(beta.57): 환영 화면은 인사 한 장(제목·돈 안내·[시작하기])이고, "예전 장부가 있어요 — 백업 파일로 되찾기"는
//    ① 검색 결과에 이미 등록된 가게가 있을 때 ② 그런 가게를 골랐을 때 ③ [직접 입력할게요] 화면에서만 보인다(사용자 결정) ──
{
  const ctx = await browser.newContext();
  const calls = [];
  const TAKEN = mkRow(EARLY_ZIP, '서울김밥')[0].restaurant_id;
  let taken = false;
  const { page, errors } = await newPage(ctx, calls, async () => ({ body: mkRow(EARLY_ZIP, '서울김밥') }), { stayOnWelcome: true, registeredDelay: 400, registered: () => (taken ? [TAKEN] : []) });
  page.on('dialog', d => d.accept());
  const wt = await page.evaluate(() => document.querySelector('.setup-welcome').innerText);
  ok(wt.includes('밥장부에 오신 것을 환영합니다') && wt.includes('이 앱은 돈을 받거나 보내지 않아요') && wt.includes('기관과 손님, 우리 가게가 앱 밖에서 직접 해요'),
    'K: 환영 화면 — 제목과 "돈을 받거나 보내지 않아요 … 기관과 손님, 우리 가게가 앱 밖에서 직접 해요" — ' + JSON.stringify(wt.replace(/\s+/g, ' ').slice(0, 140)));
  ok(!/대신 적어 드려요|①|②|③|완전 무료|광고|백업 파일로 되찾기/.test(wt), 'K: 환영 화면에 부제·①②③·"완전 무료" 줄·되찾기 글씨가 없다');
  ok((await page.locator('.setup-welcome button').count()) === 1 && (await page.locator('.setup-welcome [data-a="setup-welcome-start"]').count()) === 1, 'K: 환영 화면의 조작은 [시작하기] 하나');
  await page.locator('[data-a="setup-welcome-start"]').click();
  await page.waitForSelector('#setupStoreName');
  ok((await page.locator('[data-a="welcome-restore"]').count()) === 0, 'K: 1/3 검색 전에는 되찾기 글씨가 없다');
  await page.fill('#setupStoreName', '서울김밥');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="setup-store-pick"]');
  await sleep(900);
  ok((await page.locator('[data-a="welcome-restore"]').count()) === 0, 'K: 결과에 등록된 가게가 없으면 되찾기 글씨가 없다');
  await page.click('[data-a="setup-store-pick"]');
  await page.waitForSelector('[data-a="setup-next"]');
  ok((await page.locator('[data-a="welcome-restore"]').count()) === 0, 'K: 등록 안 된 가게를 고른 확인 화면에도 없다');
  await page.click('[data-a="setup-store-again"]');
  taken = true;
  await page.click('[data-a="setup-store-search"]');
  await page.waitForFunction(() => !document.querySelector('.store-search-busy') && document.querySelector('[data-a="setup-store-pick"]'), null, { timeout: 8000 });   // 검색이 끝나 결과가 그려진 뒤
  await page.evaluate(() => { window.__nameNode = document.getElementById('setupStoreName'); });   // 등록 여부 응답(0.4초 뒤)이 오기 전의 노드
  const shown = await page.waitForSelector('#setupRestoreSlot [data-a="welcome-restore"]', { timeout: 5000 }).then(() => true, () => false);
  const st = await page.evaluate(() => document.querySelector('.setup').innerText);
  ok(shown && st.includes('다른 기기에서 이미 등록됨') && st.includes('예전 장부가 있어요 — 백업 파일로 되찾기') && st.includes('이미 등록된 가게가 우리 가게'),
    'K: 결과에 "다른 기기에서 이미 등록됨" 가게가 있으면 목록 아래에 되찾기 글씨가 뜬다');
  ok(await page.evaluate(() => document.getElementById('setupStoreName') === window.__nameNode), 'K: 되찾기 글씨는 그 자리만 갈아끼운다(이름 입력 노드 그대로)');
  const fc1 = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('#setupRestoreSlot [data-a="welcome-restore"]')]).then(() => true, () => false);
  ok(fc1, 'K: 글씨를 누르면 곧바로 파일 고르기가 열린다(검색 결과 화면)');
  await page.click('[data-a="setup-store-pick"]');
  await page.waitForSelector('[data-a="setup-next"]');
  ok((await page.locator('[data-a="welcome-restore"]').count()) === 1 && await page.locator('[data-a="setup-next"]').isVisible(), 'K: 등록된 가게를 고른 확인 화면에도 되찾기 글씨가 있다([다음]은 그대로)');
  await page.click('[data-a="setup-store-again"]');
  await page.click('[data-a="setup-manual-toggle"]');
  await page.waitForSelector('#setupManualName');
  ok((await page.locator('[data-a="welcome-restore"]').count()) === 1, 'K: [직접 입력할게요] 화면에 되찾기 글씨가 있다(등록한 적 없는 가게·검색이 안 되는 날의 길)');
  const fc2 = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('[data-a="welcome-restore"]')]).then(() => true, () => false);
  ok(fc2, 'K: 직접 입력 화면에서도 누르면 곧바로 파일 고르기가 열린다');
  ok(errors.length === 0, 'K: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 L(beta.60b): [가게 찾기]를 누른 뒤 15초가 지나도 끝나지 않으면 진행 표시 자리에 [그만두기]가 **나타난다**.
//    그 전에는 DOM에 없다(흐린 버튼 없음). 나타날 때도 진행 조각만 갈아끼워 입력 노드·포커스·커서가 그대로다.
//    누르면 찾기를 멈추고(늦게 온 응답은 버림) 결과 자리에 계약 문장을 남긴다. 하니스만 window.__storeStopAfterMs로 15초를 줄인다. ──
const STOP_SETUP_MSG = '찾기를 그만뒀어요. 가게 이름이나 지역을 고쳐 다시 찾거나, [직접 입력할게요]로 먼저 시작할 수 있어요.';
const STOP_MODAL_MSG = '찾기를 그만뒀어요. 가게 이름이나 지역을 고쳐 다시 찾아 주세요.';
{
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { window.__storeStopAfterMs = 1500; });
  const calls = [];
  let mode = 'slow';
  const { page, errors } = await newPage(ctx, calls, async ({ zip }) => {
    if (zip) { await sleep(10); return { body: [] }; }
    if (mode === 'slow') { await sleep(2600); return { body: mkRow(EARLY_ZIP, '늦게온가게') }; }   // 그만둔 뒤에 도착하는 응답
    await sleep(100); return { body: mkRow(EARLY_ZIP, '서울김밥') };
  });
  const setupText = () => page.evaluate(() => document.querySelector('.setup').innerText);
  ok(await page.evaluate(() => { const f = window.__prepaidTestHooks && window.__prepaidTestHooks.storeStopDefaultMs; return typeof f === 'function' ? f() : 0; }) === 15000, 'L: 배포본 기준 시간은 15초다(STORE_STOP_AFTER_MS)');
  await page.fill('#setupStoreName', '서울');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('.store-search-busy', { timeout: 3000 });
  await page.click('#setupStoreName');
  await page.keyboard.press('End');
  await page.evaluate(() => { window.__nameNode = document.getElementById('setupStoreName'); });
  await page.keyboard.type('김', { delay: 60 });
  ok(await page.locator('[data-a="store-search-stop"]').count() === 0, 'L: 기준 시간 전에는 [그만두기] 버튼이 DOM에 없다(흐린 버튼도 없음)');
  await page.keyboard.type('밥', { delay: 60 });
  const shown = await page.waitForSelector('#storeBusy-setup [data-a="store-search-stop"]', { timeout: 4000 }).then(() => true, () => false);
  const st = await page.evaluate(() => { const n = document.getElementById('setupStoreName'); return { same: n === window.__nameNode, focus: document.activeElement === n, value: n.value, caret: n.selectionStart, label: (document.querySelector('[data-a="store-search-stop"]') || {}).innerText }; });
  ok(shown && st.label && st.label.trim() === '그만두기', 'L: 기준 시간이 지나면 진행 표시 자리에 [그만두기]가 나타난다');
  ok(st.same && st.focus && st.value === '서울김밥' && st.caret === 4, 'L: 버튼이 나타나도 이름 입력 노드·포커스·커서가 그대로다(진행 조각만 갈아끼움) — ' + JSON.stringify(st));
  const nameCallsAtStop = calls.filter(c => !c.zip).length;
  await page.click('[data-a="store-search-stop"]');
  await page.waitForSelector('.store-search-err[data-code="stopped"]', { timeout: 3000 }).catch(() => {});
  let t = await setupText();
  ok(t.includes(STOP_SETUP_MSG), 'L: 누르면 결과 자리에 "찾기를 그만뒀어요 … [직접 입력할게요]로 먼저 시작할 수 있어요."가 남는다');
  ok(await page.locator('.store-search-busy').count() === 0 && await page.locator('[data-a="store-search-stop"]').count() === 0 && (await page.locator('[data-a="setup-store-search"]').innerText()).trim() === '가게 찾기',
    'L: 멈추면 진행 표시·[그만두기]가 사라지고 [가게 찾기]가 다시 살아 있다');
  ok(await page.inputValue('#setupStoreName') === '서울김밥', 'L: 멈춘 뒤에도 그 사이 고쳐 친 가게 이름이 남는다');
  await sleep(3200);   // 그만둔 검색의 늦은 응답이 도착할 시간
  t = await setupText();
  ok(await page.locator('[data-a="setup-store-pick"]').count() === 0 && !t.includes('늦게온가게') && t.includes(STOP_SETUP_MSG), 'L: 그만둔 뒤 늦게 온 응답은 버린다(결과가 화면을 덮지 않음)');
  ok(calls.filter(c => !c.zip).length === nameCallsAtStop && calls.filter(c => c.zip).length === 0, 'L: 그만둔 뒤에는 다시 찾기·동네 순회를 하지 않는다 — 이름 ' + calls.filter(c => !c.zip).length + '/' + nameCallsAtStop);
  await sleep(4000);
  ok(calls.filter(c => !c.zip).length === nameCallsAtStop, 'L: 시간이 더 지나도 그만둔 검색은 다시 묻지 않는다');
  // 다시 찾으면 안내는 사라지고 결과가 나온다
  mode = 'fast';
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('[data-a="setup-store-pick"]', { timeout: 5000 }).catch(() => {});
  ok(await page.locator('.store-search-err').count() === 0 && (await setupText()).includes('서울김밥'), 'L: 다시 찾으면 그만둔 안내는 사라지고 결과가 나온다');
  await sleep(1800);
  ok(await page.locator('[data-a="store-search-stop"]').count() === 0, 'L: 빨리 끝난 검색에는 [그만두기]가 나타나지 않는다');
  ok(errors.length === 0, 'L: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 L2(beta.60b): 동네 순회 단계 — 이름 찾기가 기준 시간 안에 0건으로 끝나 순회로 넘어가면 [그만두기]는 순회 블록에 곧바로 있고,
//    누르면 예전처럼 "검색 결과가 없습니다. (n/N 구역 확인) 남은 구역을 더 찾아보시겠습니까?" + [계속 찾기]다(동작 그대로). ──
{
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { window.__storeStopAfterMs = 60000; });
  const calls = [];
  const { page, errors } = await newPage(ctx, calls, async ({ zip }) => { await sleep(zip ? 300 : 50); return { body: [] }; });
  await page.fill('#setupStoreName', '없는가게');
  await page.fill('#setupStoreRegion', '광진구 구의동');
  await page.click('[data-a="setup-store-search"]');
  await page.waitForSelector('#dongBlock-setup [data-a="dong-scan-stop"]', { timeout: 8000 });
  ok((await page.locator('[data-a="dong-scan-stop"]').innerText()).trim() === '그만두기' && await page.locator('[data-a="store-search-stop"]').count() === 0,
    'L2: 순회 단계의 버튼은 [그만두기] 하나(이름 찾기용 버튼과 겹치지 않음)');
  await page.click('[data-a="dong-scan-stop"]');
  await page.waitForSelector('[data-a="dong-scan"][data-resume="1"]', { timeout: 10000 });
  const t = await page.evaluate(() => document.querySelector('.setup').innerText);
  ok(/검색 결과가 없습니다\. \(\d+\/\d+ 구역 확인\) 남은 구역을 더 찾아보시겠습니까\?/.test(t) && !t.includes('찾기를 그만뒀어요'), 'L2: 순회 중 [그만두기]는 예전 멈춤 문구 + [계속 찾기] 그대로');
  ok(errors.length === 0, 'L2: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

// ── 시나리오 L3(beta.60b): 설정의 가게 찾기 창 — 우편번호 칸 없음, [그만두기]가 나타나고 누르면 창 안에 "…다시 찾아 주세요."가 남는다.
//    기준 시간은 배포본 그대로 15초(훅 없음)로 한 번 실제로 잰다. ──
{
  const ctx = await browser.newContext();
  const calls = [];
  let slow = false;
  const { page, errors } = await newPage(ctx, calls, async ({ zip }) => {
    if (zip) { await sleep(10); return { body: [] }; }
    if (slow) { await sleep(9000); return { status: 503, body: { error: 'public_api_timeout' } }; }
    return { body: [] };
  });
  page.on('dialog', d => d.accept().catch(() => {}));
  const pin = async () => { for (const k of '1234') { await page.locator(`[data-a="pin-key"][data-key="${k}"]`).click(); await page.waitForTimeout(250); } };
  await page.click('[data-a="setup-manual-toggle"]');
  await page.fill('#setupManualName', '창검사식당'); await page.fill('#setupManualAddr', '서울특별시 광진구 구의동 1');
  await page.click('[data-a="setup-manual-save"]'); await page.waitForSelector('[data-a="setup-next"]'); await page.click('[data-a="setup-next"]');
  await page.waitForSelector('[data-a="setup-to-contact"]'); await page.click('[data-a="setup-to-contact"]');
  await page.waitForSelector('#setupTermsChk'); await page.check('#setupTermsChk'); await page.click('[data-a="setup-contact-skip"]');
  await page.waitForSelector('[data-a="pin-key"]'); await pin(); await page.waitForTimeout(400); await pin();
  await page.waitForFunction(() => !document.querySelector('.pin-screen'), null, { timeout: 20000 }); await page.waitForTimeout(800);
  if (await page.locator('[data-a="guide-dismiss"]').count()) await page.locator('[data-a="guide-dismiss"]').click();
  await page.waitForSelector('[data-a="go-register-store"]', { timeout: 8000 });
  await page.locator('[data-a="go-register-store"]').first().click();
  await page.waitForSelector('#storeName', { timeout: 8000 });
  const mlabels = await page.$$eval('.modal label', els => els.map(e => e.textContent.trim()));
  const mtext = await page.evaluate(() => document.querySelector('.modal').innerText);
  ok(JSON.stringify(mlabels) === JSON.stringify(['가게 이름', '지역 (구·군과 동)']) && await page.locator('#storeZip').count() === 0 && !/우편번호/.test(mtext),
    'L3: 설정의 가게 찾기 창도 칸은 가게 이름·지역 두 개, "우편번호" 글자 없음 — ' + JSON.stringify(mlabels));
  ok(mtext.includes('이름으로 안 나오면 지역(구·군과 동)을 함께 적어 주세요 — 동네 전체에서 자동으로 찾아봐요.'), 'L3: 창의 도움말도 계약 문장 그대로');
  slow = true; calls.length = 0;
  await page.fill('#storeName', '느린가게');
  const t0 = Date.now();
  await page.click('[data-a="relay-search-stores"]');
  await page.waitForSelector('#storeBusy-modal .store-search-busy', { timeout: 3000 });
  await sleep(12000);
  ok(await page.locator('[data-a="store-search-stop"]').count() === 0, 'L3: 12초째에도 [그만두기]는 아직 없다(배포본 15초)');
  await page.click('#storeName'); await page.keyboard.press('End');
  await page.evaluate(() => { window.__mNode = document.getElementById('storeName'); });
  const appeared = await page.waitForSelector('#storeBusy-modal [data-a="store-search-stop"]', { timeout: 6000 }).then(() => Date.now() - t0, () => 0);
  ok(appeared >= 14500 && appeared <= 18500, 'L3: 누른 뒤 15초 무렵 창 안 진행 표시 자리에 [그만두기]가 나타난다 — ' + appeared + 'ms');
  ok(await page.evaluate(() => document.getElementById('storeName') === window.__mNode && document.activeElement === window.__mNode), 'L3: 창에서도 버튼이 나타날 때 입력 노드·포커스가 그대로다');
  await page.click('[data-a="store-search-stop"]');
  await page.waitForSelector('.modal .store-search-err[data-code="stopped"]', { timeout: 3000 }).catch(() => {});
  const mt2 = await page.evaluate(() => document.querySelector('.modal').innerText);
  ok(mt2.includes(STOP_MODAL_MSG) && !mt2.includes('직접 입력할게요') && await page.locator('.modal .store-search-busy').count() === 0, 'L3: 창에서는 "찾기를 그만뒀어요. 가게 이름이나 지역을 고쳐 다시 찾아 주세요."가 남는다');
  const nAt = calls.filter(c => !c.zip).length;
  await sleep(10000);
  ok(calls.filter(c => !c.zip).length === nAt && (await page.evaluate(() => document.querySelector('.modal').innerText)).includes(STOP_MODAL_MSG), 'L3: 그만둔 뒤 늦게 온 503에도 다시 찾지 않고 안내가 그대로다 — 이름 ' + calls.filter(c => !c.zip).length + '/' + nAt);
  ok(errors.length === 0, 'L3: 페이지 예외 없음' + (errors.length ? ' — ' + errors[0] : ''));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
