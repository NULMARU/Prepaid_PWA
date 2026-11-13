#!/usr/bin/env node
// 정적 계약 검사 — 브라우저·네트워크 없이 파일만 읽는다. 실패가 하나라도 있으면 종료 코드 1.
//   사용법:  node harness/check-static.mjs
//
//   (a) index.html에서 읽거나 쓰는 meta 키가 전부 META_KEYS에 있다
//       (없으면 저장은 되어도 복원·재시작 때 normMeta가 버린다 — CLAUDE.md "장부 보존").
//       META_DEVICE_KEYS와 backupCore()가 빼는 키도 META_KEYS 안에 있어야 한다.
//   (b) index.html APP_VERSION = sw.js CACHE_NAME의 버전 (어긋나면 갱신이 옛 캐시를 계속 내준다).
//   (c) server/src/*.js에 리터럴 NUL 바이트가 없다 (grep이 바이너리로 보고 아무것도 못 찾는다).
//   (d) agency-index.json의 시도·기관 수를 세고, "현재 상태"를 말하는 문서의 숫자와 대조한다.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}${detail ? `\n     ${detail}` : ''}`);
  if (!cond) failures += 1;
};

// ── 작은 JS 스캐너: 문자열·주석을 건너뛰며 짝 맞는 괄호를 찾는다 ──────────────────
function matchClose(src, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [pairs[src[open]]];
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === '\\') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}
// 객체 리터럴 본문의 최상위 키 (스프레드는 건너뜀)
function topLevelKeys(body) {
  const parts = []; let depth = 0, cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      const s = i; for (i += 1; i < body.length && body[i] !== c; i += 1) if (body[i] === '\\') i += 1;
      cur += body.slice(s, i + 1); continue;
    }
    if ('{(['.includes(c)) depth += 1; else if ('})]'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(p => p && !p.startsWith('...'))
    .map(p => (p.match(/^['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|$)/) || [])[1]).filter(Boolean);
}
function literalKeysAfter(src, re) {
  const keys = []; let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0 || open > m.index + m[0].length + 2) continue;
    const close = matchClose(src, open);
    if (close > open) keys.push(...topLevelKeys(src.slice(open + 1, close)).map(k => [k, m[0]]));
  }
  return keys;
}
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ── (a) META_KEYS ───────────────────────────────────────────────────────────────
{
  const html = read('index.html');
  const arrOf = name => {
    const i = html.indexOf(`const ${name}=[`);
    if (i < 0) return null;
    const open = html.indexOf('[', i), close = matchClose(html, open);
    return [...html.slice(open + 1, close).matchAll(/'([^']+)'/g)].map(m => m[1]);
  };
  const META_KEYS = arrOf('META_KEYS');
  ok(Array.isArray(META_KEYS) && META_KEYS.length > 0, `META_KEYS 찾음 (${META_KEYS ? META_KEYS.length : 0}개)`);
  const known = new Set(META_KEYS || []);
  const used = new Map(); // key -> 처음 본 위치
  const add = (k, where) => { if (!used.has(k)) used.set(k, where); };
  const JS_METHODS = new Set(['values', 'keys', 'entries', 'has', 'get', 'set', 'delete', 'forEach', 'size', 'clear', 'hasOwnProperty', 'length']);
  // 1) X.meta.key  (state.data.meta.key, d.meta.key, …)
  for (const m of html.matchAll(/\.meta\.([A-Za-z_$][\w$]*)/g)) if (!JS_METHODS.has(m[1])) add(m[1], `${lineOf(html, m.index)}행 .meta.${m[1]}`);
  // 2) metaPatch.key =
  for (const m of html.matchAll(/\bmetaPatch\.([A-Za-z_$][\w$]*)\s*=/g)) add(m[1], `${lineOf(html, m.index)}행 metaPatch.${m[1]}=`);
  // 3) 객체 리터럴: meta:{…} / metaPatch={…} / Object.assign(state.data.meta,{…})
  for (const re of [/\bmeta:\s*\{/g, /\bmetaPatch\s*=\s*\{/g, /Object\.assign\(state\.data\.meta,\s*\{/g])
    for (const [k, w] of literalKeysAfter(html, re)) add(k, w);
  // 4) 이름이 …Meta인 함수가 돌려주는 객체 리터럴 (nextReceivedBatchMeta 등)
  for (const m of html.matchAll(/function\s+([A-Za-z_$][\w$]*Meta)\s*\([^)]*\)\s*\{/g)) {
    const open = m.index + m[0].length - 1, close = matchClose(html, open);
    if (m[1] === 'normMeta' || close < 0) continue; // normMeta는 META_KEYS 자체를 도는 함수
    const body = html.slice(open, close + 1);
    for (const [k] of literalKeysAfter(body, /return\s*\{/g)) add(k, `${m[1]}() 반환값`);
  }
  // 5) 테스트 훅·IDB 직접 키 문자열: {key:'x'}
  for (const m of html.matchAll(/\bkey:\s*'([A-Za-z_$][\w$]*)'/g)) add(m[1], `${lineOf(html, m.index)}행 key:'${m[1]}'`);
  const missing = [...used].filter(([k]) => !known.has(k));
  ok(missing.length === 0, `index.html이 쓰는 meta 키 ${used.size}개가 모두 META_KEYS에 있음`,
    missing.map(([k, w]) => `${k} (${w})`).join('\n     '));
  const dev = arrOf('META_DEVICE_KEYS') || [];
  const devMissing = dev.filter(k => !known.has(k));
  ok(dev.length > 0 && devMissing.length === 0, `META_DEVICE_KEYS ${dev.length}개 ⊂ META_KEYS`, devMissing.join(', '));
  const bc = html.match(/function backupCore\(\)\{const\{([^}]*)\}=state\.data\.meta/);
  const bcKeys = bc ? bc[1].split(',').map(s => s.trim()).filter(s => s && !s.startsWith('...')) : [];
  const bcMissing = bcKeys.filter(k => !known.has(k));
  ok(bc && bcMissing.length === 0, `backupCore()가 빼는 기기 전용 키 ${bcKeys.length}개(${bcKeys.join('·')}) ⊂ META_KEYS`, bc ? bcMissing.join(', ') : 'backupCore 패턴을 찾지 못함');
  const unused = (META_KEYS || []).filter(k => !used.has(k));
  if (unused.length) console.log(`   ℹ︎ META_KEYS에 있으나 코드에서 정적으로 안 보이는 키(참고): ${unused.join(', ')}`);
}

// ── (b) APP_VERSION = CACHE_NAME ───────────────────────────────────────────────
{
  const av = (read('index.html').match(/APP_VERSION='([^']+)'/) || [])[1];
  const cn = (read('sw.js').match(/CACHE_NAME\s*=\s*'([^']+)'/) || [])[1];
  ok(av && cn && cn === `prepaid-ledger-v${av}`, `APP_VERSION(${av || '?'}) = sw.js CACHE_NAME(${cn || '?'})`);
}

// ── (c) NUL 바이트 ──────────────────────────────────────────────────────────────
{
  const dir = join(ROOT, 'server', 'src');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /\.(m?js)$/.test(f)) : [];
  const bad = files.filter(f => readFileSync(join(dir, f)).includes(0));
  ok(files.includes('worker.js') && bad.length === 0, `server/src 리터럴 NUL 바이트 없음 (${files.join(', ')})`, bad.length ? `NUL 포함: ${bad.join(', ')} — '\\u0000' 이스케이프로 쓸 것` : '');
}

// ── (d) 기관 수 ─────────────────────────────────────────────────────────────────
{
  const idx = JSON.parse(read('agency-index.json'));
  const regions = idx.regions || [];
  const agencies = regions.reduce((s, r) => s + (r.agencies || []).length, 0);
  const health = regions.reduce((s, r) => s + (r.agencies || []).filter(a => /-health$/.test(a.id || '')).length, 0);
  console.log(`   ℹ︎ agency-index.json: ${regions.length}개 시도 · ${agencies}개 기관 (보건소 ${health}곳, updatedAt ${idx.updatedAt || '?'})`);
  // "현재 상태"를 말하는 문서만 대조한다(10~12는 날짜가 박힌 검토 기록이라 그 시점 숫자가 맞다).
  const docs = ['CLAUDE.md', 'docs/agency-data-pipeline.md',
    ...readdirSync(join(ROOT, 'docs/handover')).filter(f => /^0\d-.*\.md$/.test(f)).map(f => `docs/handover/${f}`)];
  const claims = [];
  for (const f of docs) {
    if (!existsSync(join(ROOT, f))) continue;
    const t = read(f);
    for (const m of t.matchAll(/(\d+)개 시도\s*[·・,]\s*(\d+)\s*(?:개\s*)?기관/g))
      claims.push({ f, line: lineOf(t, m.index), r: +m[1], a: +m[2] });
  }
  const wrong = claims.filter(c => c.r !== regions.length || c.a !== agencies);
  ok(wrong.length === 0, `문서의 "N개 시도·M 기관" 표기 ${claims.length}곳이 실제(${regions.length}·${agencies})와 일치`,
    wrong.map(c => `${c.f}:${c.line} → ${c.r}개 시도·${c.a} 기관`).join('\n     '));
}

console.log(failures ? `\n정적 검사 실패 ${failures}건` : '\n정적 검사 전부 통과');
process.exit(failures ? 1 : 0);
