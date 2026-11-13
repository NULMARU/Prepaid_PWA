#!/usr/bin/env node
// 음식점 앱 기동 스모크 — 배포 게이트(.github/workflows/pages.yml)용으로 짧고 안정적이게 만든 검사.
//   사용법:  node harness/app-smoke.mjs            (리포 루트 또는 아무 곳에서나)
//
//   · 리포 루트를 127.0.0.1로 서빙하고 깨끗한 브라우저(빈 IndexedDB)로 index.html?e2e=1 을 연다.
//   · 첫 화면(환영 인사 또는 PIN 패드)이 그려지는지, [시작하기]를 누르면 1/3 단계로 넘어가는지 본다.
//   · 콘솔 오류·페이지 예외가 0건이어야 한다. 외부(127.0.0.1 밖) 요청은 전부 막고, 기동 중에 하나라도 나가면 실패.
//   · 장부를 만들지 않는다(전체 시나리오는 prepaid.e2e.js의 몫).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = resolve(ROOT, '.' + (p === '/' ? '/index.html' : p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ck = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures += 1; };
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  const external = [];
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    external.push(u); return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message || e)));

  await page.goto(`${base}/index.html?e2e=1`, { waitUntil: 'load' });
  const first = await page.waitForSelector('[data-a="setup-welcome-start"], [data-a="pin-key"]', { timeout: 15000 }).catch(() => null);
  ck(!!first, '첫 화면(환영 인사 또는 PIN 패드)이 그려짐');
  const ver = ((await page.content()).match(/APP_VERSION='([^']+)'/) || [])[1] || '';
  ck(/^1\.0\.0-beta\.\d+$/.test(ver), `APP_VERSION 읽힘 (${ver || '?'})`);
  if (await page.locator('[data-a="setup-welcome-start"]').count()) {
    await page.click('[data-a="setup-welcome-start"]');
    const moved = await page.waitForFunction(() => !document.querySelector('[data-a="setup-welcome-start"]')
      && (document.querySelector('#app .setup') || {}).innerText?.length > 20, null, { timeout: 10000 }).then(() => true, () => false);
    ck(moved, '[시작하기] → 가게 설정 1단계로 넘어감');
  }
  await page.waitForTimeout(800); // 늦게 뜨는 비동기 오류(서비스워커 등록 등)까지 기다린다
  ck(errors.length === 0, `콘솔 오류·페이지 예외 0건${errors.length ? ' — ' + errors.join(' | ').slice(0, 600) : ''}`);
  ck(external.length === 0, `기동 중 외부 요청 0건${external.length ? ' — ' + external.slice(0, 5).join(', ') : ''}`);
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n앱 기동 스모크 실패 ${failures}건` : '\n앱 기동 스모크 통과');
process.exit(failures ? 1 : 0);
