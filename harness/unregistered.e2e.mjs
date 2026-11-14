// 실행: node harness/unregistered.e2e.mjs
// 등록하지 않고 쓰는 가게(직접 입력·오프라인 설치)의 계약 — 2026-11-14 사용자 확인 요청으로 고정.
//   공공기관 명단을 받지 않고 손으로만 선입금 장부를 쓰는 가게가 있다. 그런 가게에서
//   ① 앱이 스스로 서버를 두드리지 않는다(등록 시도·백업·새 명단 확인 0회) ② 오류·기본 팝업이 뜨지 않는다
//   ③ 홈의 "우리 가게 등록을 마무리하세요" 배너는 "공공기관 명단은 받지 않아요"를 한 번 누르면 다시 뜨지 않는다(beta.58)
//   ④ 그래도 상태 표시와 설정의 등록 길은 남아 있고, 등록을 시도했다 실패하면 배너가 돌아온다.
// 서버는 일부러 전부 500을 준다 — 한 번이라도 부르면 호출 목록과 콘솔에 그대로 드러난다.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0]; const file = p === '/' ? '/index.html' : p;
  try {
    const body = readFileSync(ROOT + decodeURIComponent(file));
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
    res.end(body);
  } catch (_) { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => srv.listen(0, r));
const base = 'http://127.0.0.1:' + srv.address().port + '/';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const cors = { 'Access-Control-Allow-Origin': '*' };
const BANNER = '.banner[data-a="go-register-store"]';
const browser = await chromium.launch();

async function scenario(tag, offline) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, locale: 'ko-KR' });
  const api = [], problems = [], dialogs = [];
  let apiMode = '500';
  await ctx.route('**/api/**', route => {
    const u = new URL(route.request().url());
    if (apiMode === 'store-found' && u.pathname === '/api/restaurants') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify([{ restaurant_id: '3040000-101-2026-00077', name: '수동장부식당', address: '서울특별시 광진구 구의동 123-45', status: '영업/정상', tel: '', zip: '05021' }]) });
    if (apiMode === 'store-found' && u.pathname === '/api/registered') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' });
    return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' });
  });
  const page = await ctx.newPage();
  let expectErrors = false;
  page.on('request', r => { if (r.url().includes('/api/')) api.push(r.method() + ' ' + new URL(r.url()).pathname); });
  page.on('console', m => { if (!expectErrors && (m.type() === 'error' || m.type() === 'warning')) problems.push(m.type() + ': ' + m.text().slice(0, 140)); });
  page.on('pageerror', e => problems.push('pageerror: ' + String(e).slice(0, 140)));
  page.on('dialog', d => { dialogs.push(d.type() + ': ' + d.message().replace(/\s+/g, ' ').slice(0, 100)); d.accept().catch(() => {}); });
  const pin = async () => { for (const k of '1234') { await page.locator(`[data-a="pin-key"][data-key="${k}"]`).click(); await page.waitForTimeout(300); } };
  const unlock = async () => {
    await page.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 10000 });
    if (await page.locator('[data-a="lock-to-pin"]').count()) { await page.locator('[data-a="lock-to-pin"]').click(); await page.waitForSelector('[data-a="pin-key"]'); }
    await pin();
    await page.waitForFunction(() => !document.querySelector('.pin-screen') && !document.querySelector('.cust-screen'), null, { timeout: 15000 });
  };
  const meta = keys => page.evaluate(ks => new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const out = {}; r.result.transaction('meta').objectStore('meta').openCursor().onsuccess = e => { const c = e.target.result; if (c) { if (ks.includes(c.value.key)) out[c.value.key] = c.value.value; c.continue(); } else res(out); }; }; }), keys);
  const appText = () => page.evaluate(() => document.querySelector('#app').innerText.replace(/\s+/g, ' '));

  // ── 처음 설정: [직접 입력할게요] ──
  await page.goto(base); await page.waitForSelector('[data-a="setup-welcome-start"]');
  if (offline) await ctx.setOffline(true);
  await page.click('[data-a="setup-welcome-start"]'); await page.waitForSelector('#setupStoreName');
  await page.click('[data-a="setup-manual-toggle"]');
  await page.fill('#setupManualName', '수동장부식당'); await page.fill('#setupManualAddr', '서울특별시 광진구 구의동 123-45');
  await page.click('[data-a="setup-manual-save"]'); await page.waitForSelector('[data-a="setup-next"]'); await page.click('[data-a="setup-next"]');
  await page.waitForSelector('[data-a="setup-to-contact"]'); await page.click('[data-a="setup-to-contact"]');
  await page.waitForSelector('#setupTermsChk'); await page.check('#setupTermsChk'); await page.click('[data-a="setup-contact-skip"]');
  await page.waitForSelector('[data-a="pin-key"]'); await pin(); await page.waitForTimeout(400); await pin();
  await page.waitForFunction(() => !document.querySelector('.pin-screen'), null, { timeout: 20000 }); await page.waitForTimeout(1200);
  if (await page.locator('[data-a="guide-dismiss"]').count()) await page.locator('[data-a="guide-dismiss"]').click();
  await page.waitForSelector(BANNER, { timeout: 8000 }).catch(() => {});
  const m0 = await meta(['restaurantId', 'relayRegisteredAt', 'storeRegisterPending', 'setupComplete']);
  ok(m0.setupComplete === true && !m0.restaurantId && !m0.relayRegisteredAt, `${tag}: 직접 입력으로 설정이 끝나고 서버 등록 정보는 비어 있다 — ${JSON.stringify(m0)}`);
  let t = await appText();
  ok((await page.locator(BANNER).count()) === 1 && t.includes('우리 가게 등록을 마무리하세요') && t.includes('등록 안 됨'), `${tag}: 홈에 등록 안내 배너와 "등록 안 됨" 표시가 있다`);

  // ── 평소 쓰기: 직원 올리기 · 설정 카드 · [지금 백업하기] · 다시 열기 · 연결 변화 ──
  await page.locator('[data-a="screen"][data-screen="settings"]').click(); await page.waitForSelector('.fold-head');
  await page.locator('.fold-head[data-card="enroll-manual"]').click(); await page.waitForSelector('[data-a="add-employee"]'); await page.click('[data-a="add-employee"]');
  await page.fill('#empDept', '총무과'); await page.fill('#empName', '홍길동'); await page.fill('#empOpen', '30000'); await page.click('[data-a="save-employee"]'); await page.waitForTimeout(500);
  for (const c of await page.evaluate(() => [...document.querySelectorAll('.fold-head[data-card]')].map(h => h.dataset.card))) {
    const h = page.locator(`.fold-head[data-card="${c}"]`); if ((await h.getAttribute('aria-expanded')) === 'false') { await h.click(); await page.waitForTimeout(200); }
  }
  await page.locator('[data-a="backup-now"]').first().click(); await page.waitForTimeout(700);
  const choice = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ok(choice.includes('내 보관용 백업을 남겨요') && choice.includes('이 기기에 저장') && !choice.includes('서버에는 올리지 못했어요'), `${tag}: [지금 백업하기]는 서버 단계 없이 곧바로 "내 보관용 백업"을 묻는다(실패 문구 없음)`);
  await page.locator('[data-a="choice-pick"][data-val="none"], [data-a="choice-pick"][data-v="none"]').first().click().catch(async () => { await page.keyboard.press('Escape'); });
  await page.waitForTimeout(300);
  await page.reload(); await unlock(); await page.waitForTimeout(2000);
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }); await page.waitForTimeout(2000);
  if (offline) { await ctx.setOffline(false); await page.waitForTimeout(4000); await page.reload(); await unlock(); await page.waitForTimeout(2500); }
  ok(api.length === 0, `${tag}: 설정부터 평소 사용${offline ? '·나중에 온라인이 된 뒤' : ''}까지 서버 호출 0회 — ${api.join(', ') || '없음'}`);
  ok(problems.length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·경고 0건, 기본 팝업 0건 — ${[...problems, ...dialogs].join(' | ') || '없음'}`);
  t = await appText();
  ok(t.includes('홍길동') && t.includes('30,000'), `${tag}: 손으로 올린 직원과 잔액이 홈에 그대로 보인다`);

  // ── beta.58: "공공기관 명단은 받지 않아요" → 배너가 다시 뜨지 않는다 ──
  ok((await page.locator(BANNER).count()) === 1, `${tag}: 앱을 다시 열면 배너가 또 떠 있다(예전 동작 — ✕는 이번 실행에서만 숨김)`);
  const never = page.locator(`${BANNER} [data-a="store-register-never"]`);
  ok((await never.count()) === 1 && (await never.innerText()).includes('공공기관 명단은 받지 않아요'), `${tag}: 배너 안에 "공공기관 명단은 받지 않아요 (이 안내 그만 보기)"가 있다`);
  if (await never.count()) await never.click();
  await page.waitForTimeout(500);
  const m1 = await meta(['storeRegisterPending', 'restaurantId']);
  ok((await page.locator(BANNER).count()) === 0 && (await page.locator('.modal').count()) === 0 && m1.storeRegisterPending === false && !m1.restaurantId,
    `${tag}: 누르면 배너만 사라진다(가게 찾기 창이 열리지 않음, 등록 상태 그대로) — ${JSON.stringify(m1)}`);
  t = await appText();
  ok(t.includes('등록 안 됨') && t.includes('설정 > 자동 등록에서 등록할 수 있어요'), `${tag}: "등록 안 됨" 표시는 남고, 어디서 등록하는지 알려 준다`);
  await page.reload(); await unlock(); await page.waitForTimeout(1500);
  ok((await page.locator(BANNER).count()) === 0 && (await appText()).includes('등록 안 됨'), `${tag}: 앱을 다시 열어도 배너가 뜨지 않는다(표시는 그대로)`);
  await page.locator('[data-a="screen"][data-screen="settings"]').click(); await page.waitForSelector('.fold-head');
  const auto = page.locator('.fold-head[data-card="enroll-auto"]'); if ((await auto.getAttribute('aria-expanded')) === 'false') await auto.click();
  await page.waitForTimeout(300);
  ok((await page.locator('[data-a="relay-find-store"]').count()) === 1 && (await appText()).includes('우리 가게 등록 (처음 한 번)'), `${tag}: 설정 > 자동 등록의 [우리 가게 등록 (처음 한 번)]은 그대로 있다(마음이 바뀌면 언제든 등록)`);
  ok(api.length === 0, `${tag}: 여기까지도 서버 호출 0회 — ${api.join(', ') || '없음'}`);

  // ── 등록을 시도했다가 실패하면 배너가 돌아온다(사장님이 등록할 뜻을 보였으므로) ──
  if (!offline) {
    apiMode = 'store-found'; expectErrors = true;
    await page.locator('[data-a="relay-find-store"]').click(); await page.waitForSelector('#storeName');
    await page.fill('#storeName', '수동장부식당'); await page.click('[data-a="relay-search-stores"]');
    await page.waitForSelector('[data-a="relay-pick-store"]', { timeout: 8000 });
    await page.click('[data-a="relay-pick-store"]');
    await page.waitForFunction(() => !document.querySelector('.modal') && !document.querySelector('.busy'), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const m2 = await meta(['storeRegisterPending', 'restaurantId', 'relayRegisteredAt']);
    ok(api.some(a => a.includes('/api/register-key')) && !m2.restaurantId && !m2.relayRegisteredAt && m2.storeRegisterPending === true,
      `${tag}: 등록을 시도했다 실패(서버 500) → 등록 상태는 되돌아가고 안내는 다시 켜진다 — ${JSON.stringify(m2)}`);
    await page.locator('[data-a="screen"][data-screen="home"]').click(); await page.waitForTimeout(400);
    ok((await page.locator(BANNER).count()) === 1, `${tag}: 홈에 등록 안내 배너가 다시 보인다`);
    ok(!problems.some(p => p.startsWith('pageerror')), `${tag}: 페이지 예외 없음`);
  }
  await ctx.close();
}

await scenario('온라인·직접 입력', false);
await scenario('오프라인 설치·직접 입력', true);
await browser.close();
srv.close();
console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
