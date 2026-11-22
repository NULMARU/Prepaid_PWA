// 실행: node harness/install.e2e.mjs            (APP_HTML=<다른 index.html 경로> 로 수정 전 사본을 돌릴 수 있다)
// beta.60(A3b) — "홈 화면에 추가(설치)" 안내와 "이 기기에만 저장한 백업" 안내의 계약.
//   ① 판별 함수 installEnv(순수) — UA·display-mode·navigator.standalone·터치 수로 7가지 상태
//   ② 처음 설정 전 환영 화면 — 상태마다 문구·진한 버튼·작은 글씨 탈출구, 360×640에서 스크롤 없이, 가로 넘침 0, 기본 팝업 0
//      설치된 앱(필드테스트 태블릿)·PC는 지금 화면과 **바이트까지 같다**
//   ③ 안드로이드 크롬 설치 창 — beforeinstallprompt를 붙잡아(preventDefault) [홈 화면에 추가]에서 prompt() 1회, 화면은 설치 칸만 갈아끼움
//   ④ 장부가 있는 상태의 홈 배너 — 등록·백업 배너 아래, ✕는 이번 실행 동안만, 설치·PC는 칸 자체가 없음, 잠금·손님 화면에는 안 나옴
//   ⑤ [이 기기에 저장] 확인 창·장부 지키기 카드의 "기기와 함께 사라져요" 안내(마지막 내 보관 백업이 기기 저장일 때만)
// 판정은 innerText·해당 영역으로만 한다(document.body.textContent 금지). 서버 호출은 전부 500(호출하지 않아야 정상인 화면들이다).
import { chromium } from 'playwright';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_HTML = process.env.APP_HTML ? resolve(process.env.APP_HTML) : '';
const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0]; const file = p === '/' ? '/index.html' : p;
  try {
    const body = (file === '/index.html' && APP_HTML) ? readFileSync(APP_HTML) : readFileSync(ROOT + decodeURIComponent(file));
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
    res.end(body);
  } catch (_) { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => srv.listen(0, r));
const base = 'http://127.0.0.1:' + srv.address().port + '/';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const cors = { 'Access-Control-Allow-Origin': '*' };
const browser = await chromium.launch();

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidTabletDesktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipadMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  kakaoAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.86 Mobile Safari/537.36;KAKAOTALK 2411020 (INAPP)',
  kakaoIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 11.1.2',
  naverIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.10.1; 15PRO)',
  androidWebview: 'Mozilla/5.0 (Linux; Android 14; SM-S918N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36',
  headlessMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
};

// 화면 흉내: display-mode standalone · navigator.standalone · 터치 수 · (선택) 파일 공유
// displayMode: 'standalone' 말고 'minimal-ui'·'window-controls-overlay'·'fullscreen'도 흉내 낸다(설치된 앱의 다른 표시 방식, beta.60 보완).
async function makeCtx({ ua, standalone = false, displayMode = '', navStandalone = false, mtp = null, w = 360, h = 640, share = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'ko-KR', ...(ua ? { userAgent: ua } : {}), acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') }).catch(() => {});
  await ctx.addInitScript(({ standalone, displayMode, navStandalone, mtp, share }) => {
    window.__promptCalls = 0;
    const mode = displayMode || (standalone ? 'standalone' : '');
    if (mode) {
      const orig = window.matchMedia.bind(window);
      const re = new RegExp('display-mode:\\s*' + mode.replace(/-/g, '\\-') + '\\s*\\)?$');
      window.matchMedia = q => re.test(String(q).trim()) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : orig(q);
    }
    if (navStandalone) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
    if (mtp != null) Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => mtp, configurable: true });
    if (share) {
      Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(Navigator.prototype, 'share', { value: () => Promise.resolve(), configurable: true });
    }
    // 하니스가 쏘는 가짜 설치 창. outcome은 window.__installOutcome(기본 accepted).
    window.__fireInstallPrompt = () => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = () => { window.__promptCalls += 1; return Promise.resolve(); };
      e.userChoice = Promise.resolve({ outcome: window.__installOutcome || 'accepted', platform: 'web' });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
  }, { standalone, displayMode, navStandalone, mtp, share });
  await ctx.route('**/api/**', route => route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"internal"}' }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const problems = [], dialogs = [];
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text().slice(0, 140)); });
  page.on('pageerror', e => problems.push('pageerror: ' + String(e).slice(0, 140)));
  page.on('dialog', d => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
  return { ctx, page, problems, dialogs };
}
const welcomeText = page => page.evaluate(() => { const el = document.querySelector('.setup-welcome'); return el ? el.innerText.replace(/\s+/g, ' ') : ''; });
const geom = page => page.evaluate(() => {
  window.scrollTo(0, 0);
  const vh = window.innerHeight, cw = document.documentElement.clientWidth;
  const vis = sel => [...document.querySelectorAll(sel)].map(el => { const r = el.getBoundingClientRect(); return { b: Math.round(r.bottom), h: Math.round(r.height), r: Math.round(r.right) }; });
  return { vh, cw, sw: document.documentElement.scrollWidth, primary: vis('.setup-welcome .btn-primary'), skip: vis('.install-skip .link-btn'), box: vis('#installBox') };
});
// 환영 화면 기하: 진한 버튼·탈출구가 스크롤 없이 보이고 44px 이상, 가로 넘침 0
async function fits(page, tag) {
  const g = await geom(page);
  ok(g.sw <= g.cw + 1, `${tag}: 가로 넘침 없음 (scrollWidth ${g.sw} / ${g.cw})`);
  const targets = [...g.primary, ...g.skip];
  ok(targets.length > 0 && targets.every(t => t.b <= g.vh + 1 && t.h >= 44 && t.r <= g.cw + 1), `${tag}: 진한 버튼·작은 글씨 탈출구가 스크롤 없이 화면 안·44px 이상 (${JSON.stringify(targets)} / vh ${g.vh})`);
}

// ── ① 판별 함수(순수) ───────────────────────────────────────────────────────────────
{
  const { ctx, page } = await makeCtx({ w: 412, h: 900 });
  try {
  await page.goto(base); await page.waitForSelector('#app');
  const has = await page.evaluate(() => typeof (window.__prepaidTestHooks && window.__prepaidTestHooks.installEnv) === 'function');
  ok(has, '판별 함수 installEnv가 하니스에 노출돼 있다(순수 계산)');
  if (has) {
    const cases = [
      [{ ua: UA.androidChrome }, 'android-chrome'],
      [{ ua: UA.androidChrome, standalone: true }, 'installed'],
      [{ ua: UA.iphoneSafari, navStandalone: true }, 'installed'],
      [{ ua: UA.androidChrome, bridge: true }, 'installed'],
      [{ ua: UA.samsung }, 'android-other'],
      [{ ua: UA.iphoneSafari }, 'ios-safari'],
      [{ ua: UA.ipadMac, maxTouchPoints: 5 }, 'ios-safari'],
      [{ ua: UA.ipadMac, maxTouchPoints: 0 }, 'desktop'],
      [{ ua: UA.iphoneChrome }, 'ios-other'],
      [{ ua: UA.kakaoAndroid }, 'inapp'],
      [{ ua: UA.kakaoIos }, 'inapp'],
      [{ ua: UA.naverIos }, 'inapp'],
      [{ ua: UA.androidWebview }, 'inapp'],
      [{ ua: UA.androidTabletDesktop, platform: 'Android', maxTouchPoints: 5 }, 'android-chrome'],
      [{ ua: UA.androidTabletDesktop, platform: 'Linux' }, 'desktop'],
      [{ ua: UA.headlessMac, maxTouchPoints: 5 }, 'desktop'],
      [{ ua: UA.headlessMac }, 'desktop'],
      [{ ua: UA.winChrome, maxTouchPoints: 10 }, 'desktop']
    ];
    const got = await page.evaluate(cs => cs.map(([o]) => window.__prepaidTestHooks.installEnv(o)), cases);
    cases.forEach(([o, want], i) => ok(got[i] === want, `installEnv(${o.ua.slice(13, 60)}… ${JSON.stringify({ ...o, ua: undefined })}) = ${want} (got ${got[i]})`));
    // 기본 크로미움(하니스들이 쓰는 데스크톱 UA)은 PC — 다른 하니스의 화면이 그대로여야 한다.
    ok((await page.evaluate(() => (window.__prepaidTestHooks.installEnvNow ? window.__prepaidTestHooks.installEnvNow() : "(없음)"))) === 'desktop', '기본 크로미움(412×900, 데스크톱 UA)은 desktop으로 판별 — 기존 하니스 화면 불변');
  }
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}

// ── ② 환영 화면 — 설치·PC는 예전과 바이트까지 같다 ──────────────────────────────────────
const welcomeHtml = page => page.evaluate(() => { const el = document.querySelector('#app .setup'); return el ? el.outerHTML : ''; });
let desktopWelcome = '';
{
  const { ctx, page, problems, dialogs } = await makeCtx({ w: 412, h: 900 });
  try {
  await page.goto(base); await page.waitForSelector('[data-a="setup-welcome-start"]');
  desktopWelcome = await welcomeHtml(page);
  ok(!(await page.locator('#welcomeInstall, .install-box').count()), 'PC: 환영 화면에 설치 안내가 없다');
  const fired = await page.evaluate(() => window.__fireInstallPrompt());
  await page.waitForTimeout(150);
  ok(!(await page.locator('#welcomeInstall, .install-box, #installPromptBtn').count()) && (await welcomeHtml(page)) === desktopWelcome, `PC: 설치 창 신호가 와도 화면 변화 0 (preventDefault=${fired})`);
  ok(problems.length === 0 && dialogs.length === 0, `PC: 콘솔 오류·기본 팝업 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}
for (const [tag, opt] of [['설치된 앱(안드로이드)', { ua: UA.androidChrome, standalone: true }], ['설치된 앱(아이폰 홈 화면)', { ua: UA.iphoneSafari, navStandalone: true }], ['설치된 앱(태블릿 가로)', { ua: UA.androidChrome, standalone: true, w: 1280, h: 800 }], ['설치된 앱(minimal-ui)', { ua: UA.androidChrome, displayMode: 'minimal-ui' }], ['설치된 앱(window-controls-overlay)', { ua: UA.androidChrome, displayMode: 'window-controls-overlay', w: 1280, h: 800 }]]) {
  const { ctx, page, problems, dialogs } = await makeCtx({ w: 412, h: 900, ...opt });
  try {
  await page.goto(base); await page.waitForSelector('[data-a="setup-welcome-start"]');
  ok((await page.evaluate(() => (window.__prepaidTestHooks.installEnvNow ? window.__prepaidTestHooks.installEnvNow() : "(없음)"))) === 'installed', `${tag}: installed로 판별`);
  ok((await welcomeHtml(page)) === desktopWelcome, `${tag}: 환영 화면이 PC·예전과 바이트까지 같다(화면 변화 0)`);
  await page.evaluate(() => window.__fireInstallPrompt()); await page.waitForTimeout(150);
  ok((await welcomeHtml(page)) === desktopWelcome && !(await page.locator('#installPromptBtn').count()), `${tag}: 설치 창 신호가 와도 그대로`);
  ok(problems.length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·기본 팝업 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}

// ── ② 환영 화면 — 설치 안 된 폰·태블릿 ─────────────────────────────────────────────────
// 안드로이드 크롬: 설치 창이 오기 전에는 메뉴 안내 + [시작하기](막지 않음 — 저장소가 같다), 오면 [홈 화면에 추가] + 탈출구
for (const outcome of ['accepted', 'dismissed']) {
  const tag = `안드로이드 크롬(${outcome})`;
  const { ctx, page, problems, dialogs } = await makeCtx({ ua: UA.androidChrome });
  try {
  await page.goto(base); await page.waitForSelector('.setup-welcome');
  let t = await welcomeText(page);
  ok(t.includes('먼저 홈 화면에 추가해 주세요') && t.includes('⋮') && t.includes('[홈 화면에 추가]') && t.includes("'밥장부'"), `${tag}: 설치 창 전 — 메뉴(⋮) 안내와 아이콘 이름 '밥장부' (got ${t.slice(0, 200)})`);
  ok((await page.locator('#welcomeInstall [data-a="setup-welcome-start"].btn-primary').count()) === 1 && !(await page.locator('#installPromptBtn').count()), `${tag}: 설치 창 전 — 진한 버튼은 [시작하기](막지 않음)`);
  ok(t.includes('밥장부에 오신 것을 환영합니다') && t.includes('돈을 받거나 보내지 않아요'), `${tag}: 인사·돈 안내는 그대로`);
  ok(!/PWA|standalone|install|브라우저 저장소/i.test(t), `${tag}: 영어·개발 용어 없음`);
  await fits(page, `${tag} 설치 창 전 360×640`);
  // 설치 창 신호 — 설치 칸만 갈아끼운다(인사 상자 노드는 그대로)
  await page.evaluate(() => { document.querySelector('.setup-welcome-safe').__keep = 'alive'; window.__installOutcome = undefined; });
  await page.evaluate(o => { window.__installOutcome = o; }, outcome);
  const prevented = await page.evaluate(() => window.__fireInstallPrompt());
  await page.waitForSelector('#installPromptBtn', { timeout: 3000 }).catch(() => {});
  ok(prevented === true, `${tag}: 크롬의 작은 설치 막대를 막는다(preventDefault)`);
  ok((await page.locator('#installPromptBtn.btn-primary').count()) === 1 && (await page.locator('.install-skip [data-a="setup-welcome-start"]').count()) === 1, `${tag}: 설치 창 뒤 — 진한 버튼 [홈 화면에 추가] 하나 + 작은 글씨 탈출구`);
  t = await welcomeText(page);
  ok(t.includes('나중에 추가하고 지금 시작') && (await page.locator('.setup-welcome .btn-primary').count()) === 1, `${tag}: 탈출구 "나중에 추가하고 지금 시작", 진한 버튼은 하나`);
  ok((await page.evaluate(() => document.querySelector('.setup-welcome-safe').__keep)) === 'alive', `${tag}: 설치 창 신호가 화면 전체를 갈아엎지 않는다(설치 칸만 교체)`);
  await fits(page, `${tag} 설치 창 뒤 360×640`);
  await page.locator('#installPromptBtn').click();
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.__promptCalls)) === 1, `${tag}: [홈 화면에 추가]를 누르면 설치 창 prompt() 1회`);
  t = await welcomeText(page);
  if (outcome === 'accepted') {
    ok(t.includes('홈 화면에 아이콘을 만들었어요') && t.includes("'밥장부' 아이콘으로 열어 주세요") && (await page.locator('#welcomeInstall [data-a="setup-welcome-start"]').innerText()).includes('여기서 바로 시작'), `${tag}: 수락 뒤 — "아이콘으로 열어 주세요" + [여기서 바로 시작] (got ${t.slice(0, 200)})`);
  } else {
    ok(!(await page.locator('#installPromptBtn').count()) && t.includes('⋮') && (await page.locator('#welcomeInstall [data-a="setup-welcome-start"]').count()) === 1, `${tag}: 거절 뒤 — 같은 창을 다시 띄우지 않고 메뉴 안내 + [시작하기]`);
  }
  await page.locator('#welcomeInstall [data-a="setup-welcome-start"]').first().click();
  await page.waitForSelector('#setupStoreName', { timeout: 5000 }).catch(() => {});
  ok((await page.locator('#setupStoreName').count()) === 1, `${tag}: 시작하면 1/3 가게 찾기로 간다(막다른 길 없음)`);
  ok(problems.length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·기본 팝업 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}
// 아이폰·아이패드 사파리: 3단계 글 + "여기(사파리)에서 만든 장부는 홈 화면 앱에서 보이지 않아요", 진한 버튼 없음, 탈출구
for (const [tag, opt, where] of [['아이폰 사파리', { ua: UA.iphoneSafari }, '화면 아래'], ['아이패드 사파리(가로)', { ua: UA.ipadMac, mtp: 5, w: 1180, h: 820 }, '화면 위'], ['아이패드 사파리(세로)', { ua: UA.ipadMac, mtp: 5, w: 820, h: 1180 }, '화면 위']]) {
  const { ctx, page, problems, dialogs } = await makeCtx(opt);
  try {
  await page.goto(base); await page.waitForSelector('.setup-welcome');
  const t = await welcomeText(page);
  ok((await page.locator('.install-steps li').count()) === 3 && t.includes(where) && t.includes('공유 버튼') && t.includes('[홈 화면에 추가]') && t.includes("'밥장부' 아이콘으로 열어 주세요"), `${tag}: 3단계 글(${where}의 공유 버튼 → [홈 화면에 추가] → '밥장부' 아이콘) (got ${t.slice(0, 260)})`);
  ok(t.includes('여기(사파리)에서 만든 장부는 홈 화면 앱에서 보이지 않아요'), `${tag}: 사파리 장부는 홈 화면 앱에서 안 보인다는 경고`);
  ok((await page.locator('.setup-welcome .btn-primary').count()) === 0, `${tag}: 진한 버튼 없음(안내가 주인공)`);
  ok(t.includes('설치 없이 사파리에서 시작') && (await page.locator('.install-skip [data-a="setup-welcome-start"]').count()) === 1, `${tag}: 작은 글씨 탈출구 "설치 없이 사파리에서 시작"`);
  await fits(page, `${tag} ${opt.w || 360}×${opt.h || 640}`);
  await page.locator('.install-skip [data-a="setup-welcome-start"]').click();
  await page.waitForSelector('#setupStoreName', { timeout: 5000 }).catch(() => {});
  ok((await page.locator('#setupStoreName').count()) === 1, `${tag}: 탈출구를 누르면 1/3으로 간다`);
  ok(problems.length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·기본 팝업 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}
// 아이폰 크롬 등: 공유 메뉴 안내 + 사파리로 열기 + [주소 복사]
{
  const tag = '아이폰 크롬';
  const { ctx, page, problems, dialogs } = await makeCtx({ ua: UA.iphoneChrome });
  try {
  await page.goto(base); await page.waitForSelector('.setup-welcome');
  const t = await welcomeText(page);
  ok(t.includes('[홈 화면에 추가]') && t.includes('사파리') && t.includes('여기에서 만든 장부는 홈 화면 앱에서 보이지 않아요'), `${tag}: 공유 메뉴 안내·사파리·경고 (got ${t.slice(0, 220)})`);
  ok((await page.locator('#installUrlText').innerText()) === base, `${tag}: 주소 칸에 이 앱 주소(검색어 없음)`);
  ok(t.includes('설치 없이 이 브라우저에서 시작'), `${tag}: 탈출구 "설치 없이 이 브라우저에서 시작"`);
  await fits(page, `${tag} 360×640`);
  await page.locator('[data-a="install-copy-url"]').click(); await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '(read fail)'));
  const toastTxt = await page.evaluate(() => { const el = document.querySelector('.toast'); return el ? el.innerText : ''; });
  ok(clip === base && toastTxt.includes('주소를 복사했어요') && toastTxt.includes('사파리'), `${tag}: [주소 복사] → 주소가 복사되고 "사파리를 열고 붙여 넣어" 안내 (clip ${clip}, toast ${toastTxt})`);
  ok(problems.length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·기본 팝업(확인창) 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}
// 인앱(카카오톡) — 안드로이드: 진짜 링크 [크롬으로 열기] + 나가는 방법 + [주소 복사] / 아이폰: 사파리로 열기 안내(링크 없음)
const intentRe = new RegExp('^intent://127\\.0\\.0\\.1:\\d+/#Intent;scheme=http;package=com\\.android\\.chrome;S\\.browser_fallback_url=' + encodeURIComponent(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ';end$');
for (const [tag, ua, android] of [['카카오톡(안드로이드)', UA.kakaoAndroid, true], ['카카오톡(아이폰)', UA.kakaoIos, false], ['삼성 인터넷', UA.samsung, true]]) {
  const { ctx, page, problems, dialogs } = await makeCtx({ ua });
  try {
  await page.goto(base); await page.waitForSelector('.setup-welcome');
  const t = await welcomeText(page);
  const samsung = tag === '삼성 인터넷';
  if (samsung) ok(t.includes('크롬으로 열어서 설치하는 것을 권해요') && t.includes('이 브라우저에서 시작') && t.includes('나중에 크롬으로 옮기려면 백업 파일로 옮겨야 해요'), `${tag}: 크롬 권유 + 탈출구 + 경고 (got ${t.slice(0, 220)})`);
  else ok(t.includes('이 화면(카카오톡 등)에서는 장부가 안전하게 저장되지 않아요') && t.includes(android ? '[다른 브라우저로 열기]' : '[사파리로 열기]') && t.includes('그래도 여기서 시작') && (await page.locator('[data-a="install-copy-url"]').count()) === 1, `${tag}: 위험 한 줄 + 나가는 방법 + [주소 복사] + 탈출구 (got ${t.slice(0, 260)})`);
  const link = await page.evaluate(() => { const a = document.querySelector('#installChromeLink'); return a ? { tag: a.tagName, href: a.getAttribute('href'), inDataA: !!a.parentElement.closest('[data-a]'), txt: a.innerText } : null; });
  if (android) ok(!!link && link.tag === 'A' && intentRe.test(link.href) && !link.inDataA && link.txt === '크롬으로 열기', `${tag}: [크롬으로 열기]는 진짜 링크(intent://, 확인창 없음) (${JSON.stringify(link)})`);
  else ok(!link, `${tag}: 아이폰에는 크롬 링크를 두지 않는다`);
  await fits(page, `${tag} 360×640`);
  ok(problems.length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·기본 팝업 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}

// ── ④ 장부가 있는 상태의 홈 배너 ──────────────────────────────────────────────────────
const pinHash = crypto.createHash('sha256').update('1234').digest('hex');
async function seedLedger(page, extraMeta = {}) {
  await page.evaluate(({ pinHash, t, extra }) => new Promise((res, rej) => {
    const r = indexedDB.open('prepaid-ledger-db');
    r.onsuccess = () => { const tx = r.result.transaction(['employees', 'transactions', 'meta'], 'readwrite');
      tx.objectStore('employees').put({ id: 'e1', org: '광진구청', orgKind: 'public', dept: '총무과', name: '홍길동', note: '', isDeleted: false, phone: '', phoneConsent: false, yearMonth: '', createdAt: t, updatedAt: t });
      tx.objectStore('transactions').put({ id: 't1', employeeId: 'e1', type: 'open', amount: 30000, beforeBalance: 0, afterBalance: 30000, reason: '초기 선입금 등록', note: '', targetTransactionId: null, signatureData: '', signatureHash: '', txHash: '', prevHash: '', createdAt: t });
      const ms = tx.objectStore('meta');
      const meta = { setupComplete: true, welcomeSeen: true, termsAgreedAt: t, storeRegisterPending: true, pinHash, shopName: '설치 시험 식당', departments: ['총무과'], ...extra };
      Object.entries(meta).forEach(([key, value]) => ms.put({ key, value }));
      tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); };
    r.onerror = () => rej(r.error);
  }), { pinHash, t: Date.now() - 60000, extra: extraMeta });
}
async function unlock(page) {
  await page.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 10000 });
  if (await page.locator('[data-a="lock-to-pin"]').count()) { await page.locator('[data-a="lock-to-pin"]').click(); await page.waitForSelector('[data-a="pin-key"]'); }
  for (const k of '1234') await page.locator(`[data-a="pin-key"][data-key="${k}"]`).click();
  await page.waitForSelector('[data-a="quick-find-emp"]', { timeout: 10000 });
  if (await page.locator('[data-a="guide-dismiss"]').count()) await page.locator('[data-a="guide-dismiss"]').click();
}
const stackText = page => page.evaluate(() => { const el = document.querySelector('.stack'); return el ? el.innerText.replace(/\s+/g, ' ') : ''; });
for (const [tag, opt, kind] of [
  ['안드로이드 크롬', { ua: UA.androidChrome, w: 390, h: 844 }, 'android'],
  ['아이폰 사파리', { ua: UA.iphoneSafari, w: 390, h: 844 }, 'ios'],
  ['카카오톡(안드로이드)', { ua: UA.kakaoAndroid, w: 390, h: 844 }, 'inapp'],
  ['설치된 앱(태블릿)', { ua: UA.androidChrome, standalone: true, w: 1280, h: 800 }, 'none'],
  ['설치된 앱(아이폰)', { ua: UA.iphoneSafari, navStandalone: true, w: 390, h: 844 }, 'none'],
  ['설치된 앱(minimal-ui)', { ua: UA.androidChrome, displayMode: 'minimal-ui', w: 390, h: 844 }, 'none'],
  ['설치된 앱(window-controls-overlay)', { ua: UA.androidChrome, displayMode: 'window-controls-overlay', w: 1280, h: 800 }, 'none'],
  ['PC', { w: 1280, h: 900 }, 'none']
]) {
  const { ctx, page, problems, dialogs } = await makeCtx(opt);
  try {
  await page.goto(base); await page.waitForSelector('#app');
  await seedLedger(page); await page.reload();
  // 잠금(손님) 화면에는 설치 안내가 끼어들지 않는다
  await page.waitForSelector('.cust-screen, [data-a="pin-key"]', { timeout: 10000 });
  const lockTxt = await page.evaluate(() => document.querySelector('#app').innerText.replace(/\s+/g, ' '));
  ok(!lockTxt.includes('홈 화면에 추가') && !(await page.locator('#installBanner, .install-box').count()), `${tag}: 손님(잠금) 화면에 설치 안내 없음`);
  await unlock(page);
  const t = await stackText(page);
  const order = await page.evaluate(() => { const all = [...document.querySelectorAll('.stack > .card.banner, .stack #installBannerSlot')]; return all.map(e => e.id || e.className.replace(/\s+/g, '.')); });
  if (kind === 'none') {
    ok(!(await page.locator('#installBannerSlot, #installBanner').count()) && !t.includes('홈 화면에 추가') && !t.includes('홈 화면 앱'), `${tag}: 홈에 설치 배너 칸 자체가 없다(화면 변화 0)`);
    await page.evaluate(() => window.__fireInstallPrompt()); await page.waitForTimeout(150);
    ok(!(await page.locator('#installBannerSlot, #installPromptBtn').count()), `${tag}: 설치 창 신호가 와도 배너가 생기지 않는다`);
  } else {
    ok((await page.locator('#installBanner').count()) === 1, `${tag}: 홈에 설치 배너 하나`);
    ok(order.indexOf('installBannerSlot') === order.length - 1 && order.length >= 2, `${tag}: 설치 배너는 등록·백업 배너 아래(마지막) (${JSON.stringify(order)})`);
    const b = await page.locator('#installBanner').innerText();
    ok((await page.locator('#installBanner [data-a="install-hint-off"]').count()) === 1 && b.includes('이 안내 그만 보기'), `${tag}: 배너에 작은 글씨 [이 안내 그만 보기]`);
    if (kind === 'android') {
      ok(b.includes('홈 화면에 추가해 두세요') && b.includes('⋮') && b.includes("'밥장부'"), `${tag}: 배너 — 메뉴 안내·아이콘 이름 (got ${b.replace(/\s+/g, ' ')})`);
      await page.evaluate(() => { document.querySelector('#searchInput').__keep = 'alive'; });
      await page.evaluate(() => window.__fireInstallPrompt());
      await page.waitForSelector('#installBanner #installPromptBtn', { timeout: 3000 }).catch(() => {});
      ok((await page.locator('#installBanner #installPromptBtn').count()) === 1 && (await page.evaluate(() => document.querySelector('#searchInput').__keep)) === 'alive', `${tag}: 설치 창이 오면 배너 칸만 [홈 화면에 추가]로 바뀐다(검색창 노드 그대로)`);
      await page.locator('#installBanner #installPromptBtn').click(); await page.waitForTimeout(400);
      ok((await page.evaluate(() => window.__promptCalls)) === 1 && (await page.locator('#installBanner').innerText()).includes('아이콘을 만들었어요'), `${tag}: 배너의 [홈 화면에 추가] → prompt() 1회 → "아이콘을 만들었어요"`);
    } else if (kind === 'ios') {
      ok(b.includes('지금은 사파리 안에서 쓰고 계세요') && b.includes('[지금 백업하기]') && b.includes('[홈 화면에 추가]') && b.includes('[예전 장부가 있어요 — 백업 파일로 되찾기]') && (await page.locator('#installBanner .install-steps li').count()) === 3, `${tag}: 배너 — 백업 → 홈 화면에 추가 → 되찾기 3단계 (got ${b.replace(/\s+/g, ' ')})`);
      ok((await page.locator('#installBanner [data-a="backup-now"]').count()) === 1 && !(await page.locator('#installBanner[data-a]').count()), `${tag}: [지금 백업하기]는 배너 안의 버튼(배너 전체를 누르는 동작은 없다)`);
    } else {
      const href = await page.locator('#installBanner a').getAttribute('href').catch(() => '');
      ok(b.includes('크롬으로 옮겨 쓰는 것을 권해요') && b.includes('[지금 백업하기]') && intentRe.test(href || ''), `${tag}: 배너 — 백업으로 옮기는 순서 + 진짜 크롬 링크 (got ${b.replace(/\s+/g, ' ')} / ${href})`);
    }
    const g = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ok(g.sw <= g.cw + 1, `${tag}: 배너가 있어도 가로 넘침 없음 (${g.sw}/${g.cw})`);
    await page.locator('#installBanner [data-a="dismiss-install-banner"]').click(); await page.waitForTimeout(150);
    ok(!(await page.locator('#installBanner').count()), `${tag}: ✕로 닫힌다`);
    await page.locator('[data-a="screen"][data-screen="settings"]').click(); await page.waitForTimeout(150);
    await page.locator('[data-a="screen"][data-screen="home"]').click(); await page.waitForTimeout(150);
    ok(!(await page.locator('#installBanner').count()), `${tag}: 닫은 배너는 이번 실행 동안 다시 안 뜬다`);
    await page.reload(); await unlock(page);
    ok((await page.locator('#installBanner').count()) === 1, `${tag}: 다시 열면 배너가 돌아온다(세션 한정 — 새 저장 값 없음)`);
  }
  ok(problems.filter(p => !/Failed to load resource|internal|500/.test(p)).length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·기본 팝업 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}

// ── ④-2 [이 안내 그만 보기] — 그 기기에서 다시 띄우지 않는다(meta.installHintOff, 기기 전용·백업 파일에 싣지 않음) ──
for (const [tag, opt] of [['삼성 인터넷(바로가기)', { ua: UA.samsung, w: 390, h: 844 }], ['아이폰 사파리', { ua: UA.iphoneSafari, w: 390, h: 844 }]]) {
  const { ctx, page, problems, dialogs } = await makeCtx(opt);
  try {
  await page.goto(base); await page.waitForSelector('#app');
  await seedLedger(page); await page.reload(); await unlock(page);
  ok((await page.locator('#installBanner').count()) === 1, `${tag}: 그만 보기 전에는 홈에 설치 배너가 있다`);
  const keysBefore = await page.evaluate(() => window.__prepaidTestHooks.backupCoreMetaKeys ? window.__prepaidTestHooks.backupCoreMetaKeys() : null);
  await page.locator('#installBanner [data-a="install-hint-off"]').click(); await page.waitForTimeout(250);
  ok(!(await page.locator('#installBanner, #installBannerSlot').count()), `${tag}: [이 안내 그만 보기]를 누르면 배너가 사라진다`);
  const toastTxt = await page.evaluate(() => { const el = document.querySelector('.toast, #toast'); return el ? el.innerText : ''; });
  ok(toastTxt.includes('이 안내를 다시 띄우지 않을게요'), `${tag}: 토스트 한 줄 "이 안내를 다시 띄우지 않을게요" (got ${JSON.stringify(toastTxt)})`);
  const stored = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('installHintOff'); q.onsuccess = () => res(q.result ? q.result.value : null); q.onerror = () => res(null); }; r.onerror = () => res(null); }));
  ok(typeof stored === 'number' && stored > 0, `${tag}: meta.installHintOff에 누른 시각이 저장된다 (got ${JSON.stringify(stored)})`);
  const keys = await page.evaluate(() => window.__prepaidTestHooks.backupCoreMetaKeys ? window.__prepaidTestHooks.backupCoreMetaKeys() : null);
  ok(Array.isArray(keys) && keys.includes('shopName') && !keys.includes('installHintOff') && Array.isArray(keysBefore), `${tag}: 백업 파일(backupCore)에 installHintOff가 실리지 않는다 (${JSON.stringify(keys)})`);
  await page.reload(); await unlock(page);
  ok(!(await page.locator('#installBanner, #installBannerSlot').count()), `${tag}: 새로고침 뒤에도 배너가 다시 뜨지 않는다`);
  await page.evaluate(() => window.__fireInstallPrompt()); await page.waitForTimeout(150);
  ok(!(await page.locator('#installBanner, #installBannerSlot, #installPromptBtn').count()), `${tag}: 설치 창 신호가 와도 배너가 생기지 않는다`);
  ok((await page.locator('.stack > .card.banner').count()) >= 1, `${tag}: 다른 안내(가게 등록 등)는 그대로 남는다`);
  ok(problems.filter(p => !/Failed to load resource|internal|500/.test(p)).length === 0 && dialogs.length === 0, `${tag}: 콘솔 오류·기본 팝업 0 (${problems.concat(dialogs).join(' | ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}

// ── ⑤ [이 기기에 저장] 안내 — 확인 창과 장부 지키기 카드 ──────────────────────────────────
{
  const tag = '이 기기에 저장';
  const { ctx, page } = await makeCtx({ w: 412, h: 900, share: true });
  try {
  await page.goto(base); await page.waitForSelector('#app');
  await seedLedger(page, { storeRegisterPending: false }); await page.reload(); await unlock(page);
  const openGuard = async () => {
    await page.locator('[data-a="screen"][data-screen="settings"]').click();
    if (!(await page.locator('#guardState').count())) await page.locator('.fold-head[data-card="ledger"]').click();
    await page.waitForSelector('#guardState');
  };
  const choice = () => page.evaluate(() => { const el = document.querySelector('.choice-dialog, [role="dialog"]'); return el ? el.innerText.replace(/\s+/g, ' ') : ''; });
  const pickChoice = async val => { await page.locator(`[data-a="choice-pick"][data-val="${val}"]`).first().click(); await page.waitForTimeout(250); };
  await openGuard();
  await page.locator('[data-a="backup-now"]').first().click(); await page.waitForSelector('[data-a="choice-pick"][data-val="save"]');
  await pickChoice('save');
  // 처음 백업 — 백업 암호 정하기 → 적어 두기
  await page.waitForSelector('#keyPass1'); await page.fill('#keyPass1', 'install-test-77'); await page.fill('#keyPass2', 'install-test-77');
  await page.locator('#keyPassOk').click();
  await page.waitForSelector('[data-a="choice-pick"][data-val="ok"]', { timeout: 15000 }); await pickChoice('ok');
  await page.waitForSelector('[data-a="choice-pick"][data-val="yes"]', { timeout: 15000 });
  const ask = await choice();
  ok(ask.includes('파일이 저장됐나요?') && ask.includes('태블릿(폰)이 고장 나거나 없어지면 이 기기에 저장한 파일도 함께 사라져요') && ask.includes('[카톡·메일로 보내기]'), `${tag}: "파일이 저장됐나요?" 창에 기기와 함께 사라진다는 안내 (got ${ask.slice(0, 300)})`);
  await pickChoice('yes'); await page.waitForTimeout(300);
  await openGuard();
  let box = await page.locator('#guardState').innerText();
  let gs = await page.evaluate(() => window.__prepaidTestHooks.guardStatus());
  ok(gs.head === '⚠ 백업 파일이 이 기기 안에만 있어요' && box.includes('⚠ 백업 파일이 이 기기 안에만 있어요') && box.includes('폰이나 USB로 옮겨 두거나') && box.includes('(이 기기에 저장)'), `${tag}: 서버 사본이 없는 가게 — 상자 제목이 경고로 선다 (got ${box.replace(/\s+/g, ' ')})`);
  const kicker = await page.evaluate(() => { const h = document.querySelector('.fold-head[data-card="ledger"] .section-kicker'); return h ? h.innerText.trim() : ''; });
  ok(gs.summary === gs.head && (!kicker || kicker === gs.head), `${tag}: 접힌 요약도 같은 문장 (${kicker})`);
  ok(!gs.banner, `${tag}: 이 안내로 홈 배너는 띄우지 않는다(손으로만 쓰는 가게에 재촉하지 않음)`);
  // 카톡·메일로 보내면 안내가 사라진다
  await page.locator('[data-a="backup-now"]').first().click(); await page.waitForSelector('[data-a="choice-pick"][data-val="share"]');
  await pickChoice('share');
  await page.waitForSelector('[data-a="choice-pick"][data-val="yes"]', { timeout: 15000 });
  const ask2 = await choice();
  ok(ask2.includes('카톡·메일로 잘 보냈나요?') && !ask2.includes('함께 사라져요'), `${tag}: 보내기 확인 창에는 기기 안내가 없다`);
  await pickChoice('yes'); await page.waitForTimeout(300); await openGuard();
  box = await page.locator('#guardState').innerText(); gs = await page.evaluate(() => window.__prepaidTestHooks.guardStatus());
  ok(!box.includes('함께 사라져요') && !gs.deviceOnly && gs.level === 'ok', `${tag}: 카톡·메일로 보낸 뒤에는 안내가 사라지고 ✓ (got ${box.replace(/\s+/g, ' ')})`);
  const m = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('prepaid-ledger-db'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('ownBackupWhere'); q.onsuccess = () => res(q.result && q.result.value); }; }));
  ok(m && m.how === 'share' && m.at > 0, `${tag}: 기기 전용 기록 ownBackupWhere = share (${JSON.stringify(m)})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}
// 서버 사본이 최신인 등록 가게 — 제목은 그대로(✓), 상자 안 한 줄로만
{
  const tag = '이 기기에 저장(서버 사본 있음)';
  const { ctx, page } = await makeCtx({ w: 412, h: 900 });
  try {
  await page.goto(base); await page.waitForSelector('#app');
  const t = Date.now() - 30000;
  await seedLedger(page, { storeRegisterPending: false, restaurantId: 'rid-install', relayStoreName: '설치 시험 식당', relayRegisteredAt: t, districtSyncedAt: t, myKeyBackedUpAt: t, lastCloudBackupAt: t, cloudBackupState: { lastOkAt: t, lastTryAt: t }, backupPassCheck: { hash: 'x', salt: 'y', iter: 1 }, lastBackupAt: t, ownBackupWhere: { how: 'save', at: t } });
  await page.reload(); await unlock(page);
  await page.locator('[data-a="screen"][data-screen="settings"]').click();
  if (!(await page.locator('#guardState').count())) await page.locator('.fold-head[data-card="ledger"]').click();
  await page.waitForSelector('#guardState');
  const box = await page.locator('#guardState').innerText();
  const gs = await page.evaluate(() => window.__prepaidTestHooks.guardStatus());
  ok(gs.head.startsWith('✓') && (await page.locator('#guardDeviceNote').count()) === 1 && box.includes('함께 사라져요'), `${tag}: 제목은 ✓ 그대로, 상자 안 한 줄로 기기 안내 (got ${gs.head} / ${box.replace(/\s+/g, ' ')})`);
  } catch (e) { ok(false, `시나리오가 끝까지 가지 못했다: ${String(e && e.message || e).split('\n')[0].slice(0, 140)}`); }
  await ctx.close();
}

await browser.close(); srv.close();
console.log(`\n${fail ? '❌' : '✅'} 설치 안내 하니스: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
