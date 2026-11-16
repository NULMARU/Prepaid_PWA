#!/usr/bin/env node
// 서비스워커(sw.js) 앱 화면 폴백 검사 — beta.60(앱 12).
//   사용법:  node harness/sw.e2e.mjs                 (작업 트리의 sw.js)
//           SW_FILE=/path/to/sw.js node harness/sw.e2e.mjs   (다른 sw.js로 — 수정 전 파일에서 실패하는지 볼 때)
//
//   리포 루트를 127.0.0.1로 서빙하고 **서비스워커를 실제로 등록**한 뒤, 서버가 앱 화면 요청에 비정상 응답을 주게 바꿔 가며 본다.
//   ① 서버가 곧바로 503을 주면(3.5초 시한보다 빨리) 캐시된 앱 화면이 떠야 한다 — 예전에는 503 오류 페이지가 그대로 떴다.
//   ② 앱 화면(index.html)이 404여도 캐시 화면 ③ 캐시가 없는 문서가 503이면 그 응답을 그대로(빈 화면을 지어내지 않는다)
//   ④ 지운 문서의 404는 그대로 404 ⑤ 비정상 응답이 캐시를 덮지 않았다(서버가 돌아오면 정상 화면).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
const SW_FILE = process.env.SW_FILE ? resolve(process.env.SW_FILE) : join(ROOT, 'sw.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };

// 서버 모드: 경로별로 강제 응답을 건다. { '/index.html': 503, '/': 503, '/docs/terms.html': 503 }
const force = new Map();
const hits = [];
const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    hits.push(p);
    if (force.has(p)) { const code = force.get(p); res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(`<!doctype html><title>${code}</title><h1 id="errpage">server error ${code}</h1>`); return; }
    const file = p === '/sw.js' ? SW_FILE : resolve(ROOT, '.' + (p === '/' ? '/index.html' : p));
    if (p !== '/sw.js' && !file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  } catch { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><h1 id="errpage">Not found</h1>'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0, passes = 0;
const ck = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (cond) passes += 1; else failures += 1; };
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  await ctx.route('**/*', route => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  const isApp = async () => page.evaluate(() => !!document.querySelector('#app') && !document.getElementById('errpage') && /APP_VERSION='/.test(document.documentElement.innerHTML)).catch(() => false);
  const errText = async () => page.evaluate(() => { const e = document.getElementById('errpage'); return e ? e.innerText : ''; }).catch(() => '');

  // ── 준비: 서비스워커 등록 → 활성 → 이 페이지를 제어 ──
  await page.goto(`${base}/index.html?e2e=1`, { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload({ waitUntil: 'load' });
  const controlled = await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).then(() => true, () => false);
  ck(controlled, '준비: 서비스워커가 등록되어 이 페이지를 제어함');
  const cached = await page.evaluate(async () => { const r = await caches.match('./index.html'); return r ? (await r.text()).includes("APP_VERSION='") : false; });
  ck(cached, '준비: 앱 화면(index.html)이 캐시에 있음');

  // ── ① 앱 화면에 서버가 곧바로 503 → 캐시 화면 ──
  force.set('/index.html', 503); force.set('/', 503);
  let t0 = Date.now();
  await page.goto(`${base}/index.html?e2e=1`, { waitUntil: 'load' });
  let dt = Date.now() - t0;
  ck(await isApp(), `① 앱 화면이 빠른 503을 받아도 캐시된 앱 화면이 뜸 (오류 페이지: ${JSON.stringify(await errText())})`);
  ck(dt < 3000, `① 3.5초 시한을 기다리지 않고 바로 캐시 화면 (${dt}ms)`);
  t0 = Date.now();
  await page.goto(`${base}/?e2e=1`, { waitUntil: 'load' });
  ck(await isApp(), `① 루트 주소(./)도 503이면 캐시 앱 화면 (오류 페이지: ${JSON.stringify(await errText())})`);

  // ── ② 앱 화면 500·404도 캐시 화면 ──
  force.set('/index.html', 500);
  await page.goto(`${base}/index.html?e2e=1`, { waitUntil: 'load' });
  ck(await isApp(), `② 앱 화면 500도 캐시 화면 (오류 페이지: ${JSON.stringify(await errText())})`);
  force.set('/index.html', 404);
  await page.goto(`${base}/index.html?e2e=1`, { waitUntil: 'load' });
  ck(await isApp(), `② 앱 화면 404도 캐시 화면 (오류 페이지: ${JSON.stringify(await errText())})`);
  force.delete('/index.html'); force.delete('/');

  // ── ③ 캐시에 없는 문서가 503이면 그 응답을 그대로 보여 준다(앱 화면으로 바꿔치지 않음) ──
  force.set('/docs/terms.html', 503);
  await page.goto(`${base}/docs/terms.html`, { waitUntil: 'load' });
  ck((await errText()).includes('503') && !(await isApp()), `③ 캐시 없는 문서의 503은 그대로 (보인 글: ${JSON.stringify(await errText())})`);
  force.delete('/docs/terms.html');
  // 문서를 한 번 정상으로 받아 캐시에 넣은 뒤 503 → 그 문서의 캐시 사본
  await page.goto(`${base}/docs/terms.html`, { waitUntil: 'load' });
  const docOk = await page.evaluate(() => !document.getElementById('errpage') && document.body.innerText.length > 50);
  force.set('/docs/terms.html', 503);
  await page.goto(`${base}/docs/terms.html`, { waitUntil: 'load' });
  ck(docOk && !(await errText()) && (await page.evaluate(() => document.body.innerText.length > 50)), '③ 한 번 받아 둔 문서는 503이어도 캐시 사본');
  force.delete('/docs/terms.html');

  // ── ④ 없는 문서의 404는 그대로 404 ──
  await page.goto(`${base}/docs/no-such-page-b60.html`, { waitUntil: 'load' });
  ck((await errText()).includes('Not found') && !(await isApp()), `④ 없는 문서의 404는 앱 화면으로 바뀌지 않음 (보인 글: ${JSON.stringify(await errText())})`);

  // ── ⑤ 비정상 응답이 캐시를 덮지 않았다 ──
  const stillGood = await page.evaluate(async () => { const a = await caches.match('/index.html'); const b = await caches.match('/'); const ta = a ? await a.text() : ''; return ta.includes("APP_VERSION='") && !ta.includes('errpage') && (!b || !(await b.text()).includes('errpage')); });
  ck(stillGood, '⑤ 503·404 응답이 캐시된 앱 화면을 덮지 않음');
  await page.goto(`${base}/index.html?e2e=1`, { waitUntil: 'load' });
  ck(await isApp(), '⑤ 서버가 돌아오면 정상 앱 화면');
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n서비스워커 검사 실패 ${failures}건 (통과 ${passes})` : `\n서비스워커 검사 통과 ${passes}건`);
process.exit(failures ? 1 : 0);
