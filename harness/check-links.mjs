#!/usr/bin/env node
// 링크 검사 (네트워크 없음) — homepage/*.html · docs/*.html의 상대 링크·파일·앵커가 실제로 있는지 본다.
//   사용법:  node harness/check-links.mjs        (실패 1건 이상이면 종료 코드 1)
//
//   · href·src·srcset·CSS url() 의 상대 경로 → 파일 존재 확인, `#앵커` → 대상 HTML에 id/name 존재 확인.
//   · 우리 도메인 절대 주소도 로컬 파일로 바꿔 확인한다(요청은 보내지 않는다):
//       https://bapjangbu.com/…          → homepage/…        (Cloudflare Pages bapjangbu-home)
//       https://app.bapjangbu.com/…      → 리포 루트/…       (GitHub Pages)
//     agency.·staff.는 다른 리포·다른 배포라 확인하지 않는다.
//   · 경고(실패 아님): 화면 예시 기준 버전 표기("beta.51 기준")가 현재 APP_VERSION보다 오래된 곳.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITES = [
  { dir: 'homepage', root: join(ROOT, 'homepage'), host: 'bapjangbu.com' },
  { dir: 'docs', root: ROOT, host: 'app.bapjangbu.com' },
];
const HOSTS = { 'bapjangbu.com': join(ROOT, 'homepage'), 'www.bapjangbu.com': join(ROOT, 'homepage'), 'app.bapjangbu.com': ROOT };
const SKIP = /^(mailto:|tel:|sms:|javascript:|data:|blob:|about:|intent:|kakaotalk:)/i;

const idCache = new Map();
function idsOf(file) {
  if (!idCache.has(file)) {
    const t = readFileSync(file, 'utf8');
    idCache.set(file, new Set([...t.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/g)].map(m => m[1])));
  }
  return idCache.get(file);
}
const lineOf = (t, i) => t.slice(0, i).split('\n').length;

const errors = [], warns = [];
let checked = 0;
const appVer = +((readFileSync(join(ROOT, 'index.html'), 'utf8').match(/APP_VERSION='[^']*beta\.(\d+)'/) || [])[1] || 0);

function checkRef(srcFile, siteRoot, ref, line) {
  ref = ref.trim().replace(/&amp;/g, '&');
  if (!ref || SKIP.test(ref)) return;
  let base = dirname(srcFile), path = ref;
  const abs = ref.match(/^(?:https?:)?\/\/([^/?#]+)(.*)$/i);
  if (abs) {
    const host = abs[1].toLowerCase();
    if (!HOSTS[host]) return;           // 남의 사이트·다른 배포 — 확인 안 함
    base = HOSTS[host]; path = abs[2] || '/';
    if (path.startsWith('/')) path = '.' + path;
  } else if (ref.startsWith('/')) { base = siteRoot; path = '.' + ref; }
  const [pathPart, hash] = path.split('#');
  const clean = decodeURIComponent(pathPart.split('?')[0]);
  let target = clean ? resolve(base, clean) : srcFile;
  if (clean && existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
  checked += 1;
  const where = `${relative(ROOT, srcFile)}:${line}`;
  if (!existsSync(target)) { errors.push(`${where}  없는 파일: ${ref}`); return; }
  if (hash && extname(target) === '.html' && !idsOf(target).has(decodeURIComponent(hash)))
    errors.push(`${where}  없는 앵커: ${ref}`);
}

for (const site of SITES) {
  const dir = join(ROOT, site.dir);
  const files = readdirSync(dir).filter(f => /\.(html|css)$/.test(f)).map(f => join(dir, f));
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    if (f.endsWith('.html')) {
      for (const m of t.matchAll(/\s(?:href|src)\s*=\s*"([^"]*)"/g)) checkRef(f, site.root, m[1], lineOf(t, m.index));
      for (const m of t.matchAll(/\s(?:href|src)\s*=\s*'([^']*)'/g)) checkRef(f, site.root, m[1], lineOf(t, m.index));
      for (const m of t.matchAll(/\ssrcset\s*=\s*"([^"]*)"/g))
        m[1].split(',').map(s => s.trim().split(/\s+/)[0]).forEach(u => checkRef(f, site.root, u, lineOf(t, m.index)));
      for (const m of t.matchAll(/beta\.(\d+)\s*(?:버전\s*)?기준/g))
        if (appVer && +m[1] < appVer) warns.push(`${relative(ROOT, f)}:${lineOf(t, m.index)}  오래된 기준 표기 "${m[0]}" (현재 beta.${appVer})`);
    }
    for (const m of t.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) checkRef(f, site.root, m[1], lineOf(t, m.index));
  }
}

warns.forEach(w => console.log(`⚠️  ${w}`));
errors.forEach(e => console.log(`❌ ${e}`));
console.log(`\n링크 ${checked}개 확인 — 깨짐 ${errors.length}건, 경고 ${warns.length}건`);
process.exit(errors.length ? 1 : 0);
