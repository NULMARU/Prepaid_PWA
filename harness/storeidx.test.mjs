#!/usr/bin/env node
// 가게 색인 생성기(harness/build-storeidx.mjs) 검사 — 네트워크 없음, 외부 패키지 없음.
//   node harness/storeidx.test.mjs
//   STOREIDX_SAMPLE=<광진구 원본 CSV(cp949)> node harness/storeidx.test.mjs   ← 실제 견본으로도 한 번 더(선택)
//
// 견본: harness/fixtures/storeidx-sample.cp949.csv (cp949, 42행) — 광진구 실제 행 26개(필드테스트 두 가게·폐업 8곳 포함)
//   + 경계 사례 합성 행(주소 없음·관리번호 중복·확장 한글·"" 따옴표·칸 안 줄바꿈·지번만·옛 이름 지역 7종·휴업·풀 수 없는 바이트·깨진 행·CRLF).
//   만든 방법: harness/fixtures/make-storeidx-sample.py (파이썬 cp949 인코더 — 이 생성기의 해석기와 독립).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cp949Table, makeCp949Decoder, CsvParser, buildIndex, mirrorLive } from './build-storeidx.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'harness/fixtures/storeidx-sample.cp949.csv');
const ZIPMAP = join(ROOT, 'zipmap');
const zidx = JSON.parse(readFileSync(join(ZIPMAP, 'index.json'), 'utf8'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + m); } };
const quiet = () => {};
const tmp = mkdtempSync(join(tmpdir(), 'storeidx-test-'));

// ── A. cp949 해석 ───────────────────────────────────────────────────────────────
{
  const t = cp949Table();
  ok(t[0x8C63] === '똠'.charCodeAt(0) && t[0xC652] === '힣'.charCodeAt(0), 'A1 확장 한글(똠·힣)을 푼다');
  ok(t[0xB0A1] === '가'.charCodeAt(0) && t[0xCAA1] === '伽'.charCodeAt(0), 'A2 KS X 1001 한글·한자');
  ok(t[0xA2E6] === 0x20AC && t[0xC9A1] === 0xFFFD, 'A3 € 있음, 사용자 정의 영역은 풀 수 없음');
  const d = makeCp949Decoder();
  ok(d(Uint8Array.of(0xC9, 0x2C, 0x41), true) === '�,A', 'A4 풀 수 없는 2바이트의 ASCII 트레일(쉼표)은 쉼표로 다시 읽는다');
  ok(makeCp949Decoder()(Uint8Array.of(0x41, 0xB0), true) === 'A�', 'A5 끝에 홀로 남은 리드 바이트 → U+FFFD');
  const buf = readFileSync(FIX);
  const whole = makeCp949Decoder()(buf, true);
  for (const size of [1, 2, 3, 7, 4096]) {
    const dd = makeCp949Decoder(); let s = '';
    for (let i = 0; i < buf.length; i += size) s += dd(buf.subarray(i, i + size));
    s += dd(new Uint8Array(0), true);
    ok(s === whole, `A6 조각 ${size}바이트로 흘려 읽어도 한 번에 읽은 것과 같다`);
  }
  ok(whole.includes('똠얌꿍 쌀국수 츧') && whole.includes('육회바른연어 구의역점'), 'A7 견본의 확장 한글·가게 이름이 그대로 풀린다');
  ok((whole.match(/�/g) || []).length === 1, 'A8 견본에서 풀 수 없는 글자는 일부러 넣은 1개뿐');
}

// ── B. CSV ──────────────────────────────────────────────────────────────────────
{
  const text = 'a,b,c\n"x,1","줄\n바꿈","그 ""원조"""\r\n,,\n끝,"",z';
  const parse = (pieces) => { const rows = []; const p = new CsvParser(r => rows.push(r)); for (const s of pieces) p.push(s); p.end(); return rows; };
  const want = JSON.stringify([['a', 'b', 'c'], ['x,1', '줄\n바꿈', '그 "원조"'], ['', '', ''], ['끝', '', 'z']]);
  ok(JSON.stringify(parse([text])) === want, 'B1 따옴표 칸의 쉼표·줄바꿈·"" 와 CRLF, 빈 칸');
  ok(JSON.stringify(parse([...text])) === want, 'B2 한 글자씩 나눠 넣어도 같다(조각 경계의 따옴표)');
  ok(JSON.stringify(parse(['a\n\nb\n'])) === JSON.stringify([['a'], ['b']]), 'B3 빈 줄은 행이 아니다');
}

// ── C. 견본으로 만들기 ──────────────────────────────────────────────────────────
const OUT = join(tmp, 'storeidx');
const rep = await buildIndex({ input: FIX, outDir: OUT, zipmapDir: ZIPMAP, built: '2026-11-22', log: quiet });
const meta = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8'));
const where = new Map();     // 관리번호 → { sido, key, row }
const allText = [];
{
  ok(meta.v === 1 && meta.built === '2026-11-22' && Object.keys(meta).join() === 'v,built,total,regions', 'C1 meta 모양(v·built·total·regions)');
  let sum = 0, formatOk = true, sortOk = true, rowOk = true, nOk = true, keyOk = true, asciiOk = true, dupIds = 0;
  const coll = new Intl.Collator('ko');
  for (const [sido, ks] of Object.entries(meta.regions)) {
    const z = zidx.sido.find(s => s.name === sido);
    for (const [key, ent] of Object.entries(ks)) {
      if (!z || !z.sigungu.includes(key)) keyOk = false;
      if (!/^[a-z-]+\/\d{2}\.json$/.test(ent.f) || !z || !ent.f.startsWith(z.slug + '/') || ent.f !== `${z.slug}/${String(z.sigungu.indexOf(key)).padStart(2, '0')}.json`) asciiOk = false;
      const raw = readFileSync(join(OUT, ent.f), 'utf8'); allText.push(raw);
      const j = JSON.parse(raw);
      if (j.v !== 1 || !Array.isArray(j.rows) || Object.keys(j).join() !== 'v,rows') formatOk = false;
      if (j.rows.length !== ent.n) nOk = false;
      sum += ent.n;
      j.rows.forEach((r, i) => {
        if (!Array.isArray(r) || r.length !== 5 || !r.every(x => typeof x === 'string') || !r[0] || !r[1] || !(r[2] || r[3]) || !/^(\d{5})?$/.test(r[4])) rowOk = false;
        if (i && coll.compare(j.rows[i - 1][1], r[1]) > 0) sortOk = false;
        if (where.has(r[0])) dupIds++;
        where.set(r[0], { sido, key, row: r });
      });
    }
  }
  ok(keyOk, 'C2 시도·시군구 키가 전부 zipmap/index.json 표기와 같다');
  ok(asciiOk, 'C3 파일 경로는 ASCII "<slug>/<zipmap 순번 2자리>.json"');
  ok(formatOk && rowOk, 'C4 파일 모양 {v:1,rows:[[관리번호,사업장명,도로명주소,지번주소,우편번호]]}');
  ok(nOk && sum === meta.total && meta.total === 29 && rep.kept === 29, `C5 n·total이 실제 행 수와 같다(29, 실제 ${meta.total})`);
  ok(sortOk, 'C6 사업장명 가나다순');
  ok(dupIds === 0, 'C7 관리번호가 두 번 실리지 않는다');
  ok(rep.rows === 42 && rep.active === 32, `C8 행 42 · 영업 32 (실제 ${rep.rows} · ${rep.active})`);
}
{
  const gj = meta.regions['서울특별시'] && meta.regions['서울특별시']['광진구'];
  ok(gj && gj.f === 'seoul/05.json', 'C9 광진구 파일 = seoul/05.json');
  const a = where.get('3040000-101-2024-00011'), b = where.get('3040000-101-2017-00245');
  ok(a && a.key === '광진구' && a.row[1] === '육회바른연어 구의역점' && a.row[4] === '05044', 'C10 필드테스트 가게 ① 육회바른연어 구의역점이 광진구 파일에');
  ok(b && b.key === '광진구' && b.row[1] === '만계옥닭갈비', 'C11 필드테스트 가게 ② 만계옥닭갈비가 광진구 파일에');
  ok(rep.drop.dup === 1 && a && a.row[1] !== '중복된관리번호', 'C12 관리번호 중복은 먼저 나온 행을 남기고 버린다(수 1)');
  const fixText = makeCp949Decoder()(readFileSync(FIX), true);
  const closedIds = fixText.split('\n').filter(l => /,폐업,/.test(l) || /,휴업,/.test(l)).map(l => (l.split(',')[1] || '').trim()).filter(Boolean);
  ok(closedIds.length === 9 && closedIds.every(id => !where.has(id)), `C13 폐업(03) 8곳·휴업(02) 1곳은 싣지 않는다(견본 ${closedIds.length})`);
  ok(rep.closedByCode['03'] === 8 && rep.closedByCode['02'] === 1, 'C14 영업이 아닌 행 수를 상태 코드별로 센다');
  ok(!where.has('T-ADDR-NONE') && rep.drop.noAddr === 1, 'C15 주소가 둘 다 빈 행은 버리고 센다');
  ok(!where.has('T-NOWHERE') && rep.drop.region === 1 && Object.keys(rep.unmatched).length === 1, 'C16 지역을 못 맞춘 행은 버리지 않고 사유·주소 앞머리별로 센다');
  ok(!where.has('T-COLS') && rep.drop.cols === 1, 'C17 열 개수가 틀린 행은 버리고 센다');
  const txt = allText.join('\n');
  ok(!txt.includes('029998877') && !txt.includes('0215550001') && !/0\d{8,10}"/.test(txt), 'C18 전화번호가 결과 어디에도 없다');
  ok(!txt.includes('�'), 'C19 결과에 U+FFFD가 없다');
  const u = where.get('T-UHC'), q = where.get('T-QUOTE'), rl = where.get('T-ROADLESS'), bb = where.get('T-BADBYTE');
  ok(u && u.row[1] === '똠얌꿍 쌀국수 츧', 'C20 cp949 확장 한글 이름');
  ok(q && q.row[1] === '그 집 "원조"' && q.row[2] === '서울특별시 광진구 자양로 2, 1층, 2층 (구의동)', 'C21 "" 따옴표·칸 안 줄바꿈(공백 하나로)');
  ok(rl && rl.row[2] === '' && rl.row[3] === '서울특별시 광진구 구의동 3-3' && rl.key === '광진구', 'C22 도로명주소가 없으면 지번주소로 지역을 정한다');
  ok(bb && bb.row[1] === 'K깨진글자' && rep.fffdRows === 1, 'C23 풀 수 없는 바이트는 빼고 행은 남기며 수를 센다');
  const R = (id, sido, key) => { const w = where.get(id); return !!w && w.sido === sido && w.key === key; };
  ok(R('T-INCHEON-ZIP', '인천광역시', '영종구'), 'C24 옛 "인천 중구" + 우편번호 → 영종구');
  ok(R('T-INCHEON-DONG', '인천광역시', '제물포구'), 'C25 옛 "인천 중구" + 동 이름(우편번호 없음) → 제물포구');
  ok(R('T-HWASEONG', '경기도', '화성시 동탄구'), 'C26 일반구가 빠진 "화성시" 주소 → 화성시 동탄구');
  ok(R('T-GUNWI', '대구광역시', '군위군'), 'C27 시도가 바뀐 군위군(경북 → 대구)');
  ok(R('T-GWANGJU', '전남광주통합특별시', '광산구'), 'C28 "광주광역시" → 전남광주통합특별시');
  ok(R('T-GANGWON', '강원특별자치도', '춘천시'), 'C29 "강원도" → 강원특별자치도');
  ok(R('T-SEJONG', '세종특별자치시', '세종특별자치시'), 'C30 세종은 zipmap처럼 시군구 자리에 시도 이름');
}

// ── D. 실패하면 예전 색인을 그대로 둔다 ─────────────────────────────────────────
{
  const out = join(tmp, 'keep');
  mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'meta.json'), '{"old":1}');
  let threw = false;
  try { await buildIndex({ input: FIX, outDir: out, zipmapDir: ZIPMAP, built: '2026-11-22', minTotal: 30, log: quiet }); } catch { threw = true; }
  ok(threw && readFileSync(join(out, 'meta.json'), 'utf8') === '{"old":1}', 'D1 최소 건수(--min-total)에 못 미치면 실패하고 예전 색인은 그대로');
  const badCsv = join(tmp, 'bad.csv');
  writeFileSync(badCsv, Buffer.from('개방자치단체코드,사업장명,영업상태코드\n1,가,01\n'.replace(/[^\x00-\x7f]/g, '?')));
  threw = false;
  try { await buildIndex({ input: badCsv, outDir: out, zipmapDir: ZIPMAP, built: '2026-11-22', log: quiet }); } catch { threw = true; }
  ok(threw && readFileSync(join(out, 'meta.json'), 'utf8') === '{"old":1}', 'D2 머리줄에 필요한 열이 없으면 실패하고 예전 색인은 그대로');
}

// ── E. 명령줄 종료 코드 ─────────────────────────────────────────────────────────
{
  const run = (...a) => spawnSync(process.execPath, [join(ROOT, 'harness/build-storeidx.mjs'), FIX, '--out', join(tmp, 'cli'), ...a], { encoding: 'utf8' });
  const r1 = run('--min-total', '29', '--report', join(tmp, 'rep.json'));
  ok(r1.status === 0 && existsSync(join(tmp, 'cli/meta.json')) && JSON.parse(readFileSync(join(tmp, 'rep.json'), 'utf8')).kept === 29, 'E1 명령줄 성공 → 종료 0, --report 저장');
  ok(run('--min-total', '30').status === 1, 'E2 최소 건수 미달 → 종료 1(CI가 라이브 색인으로 대신한다)');
}

// ── G. 라이브 색인 그대로 가져오기(--mirror) — 가짜 fetch로(요청 없음) ─────────
{
  const files = new Map([['meta.json', readFileSync(join(OUT, 'meta.json'), 'utf8')]]);
  for (const ks of Object.values(meta.regions)) for (const e of Object.values(ks)) files.set(e.f, readFileSync(join(OUT, e.f), 'utf8'));
  const fake = (map) => async (url) => { const rel = url.replace('https://live.test/storeidx/', ''); return map.has(rel) ? new Response(map.get(rel)) : new Response('', { status: 404 }); };
  const out = join(tmp, 'mirror');
  const m = await mirrorLive('https://live.test/storeidx', out, { log: quiet, fetchImpl: fake(files) });
  let same = m.total === 29;
  for (const [rel, body] of files) same = same && readFileSync(join(out, rel), 'utf8') === body;
  ok(same, 'G1 라이브 meta.json과 그 안의 파일을 전부 그대로 받아 온다');
  writeFileSync(join(out, 'meta.json'), '{"keep":1}');
  const broken = new Map(files); broken.set('seoul/05.json', '{"v":1,"rows":[]}');
  let threw = false;
  try { await mirrorLive('https://live.test/storeidx/', out, { log: quiet, fetchImpl: fake(broken) }); } catch { threw = true; }
  ok(threw && readFileSync(join(out, 'meta.json'), 'utf8') === '{"keep":1}', 'G2 파일 하나가 meta와 다르면 실패하고 그 자리는 그대로(반쪽 색인을 싣지 않음)');
  const evil = new Map(files); evil.set('meta.json', JSON.stringify({ v: 1, built: 'x', total: 1, regions: { a: { b: { f: '../../etc/passwd', n: 1 } } } }));
  threw = false;
  try { await mirrorLive('https://live.test/storeidx/', out, { log: quiet, fetchImpl: fake(evil) }); } catch { threw = true; }
  ok(threw, 'G3 meta.json의 파일 경로가 "<slug>/<2자리>.json"이 아니면 거절');
  const gone = new Map(files); gone.delete('meta.json');
  threw = false;
  try { await mirrorLive('https://live.test/storeidx/', join(tmp, 'mirror2'), { log: quiet, fetchImpl: fake(gone) }); } catch { threw = true; }
  ok(threw && !existsSync(join(tmp, 'mirror2')), 'G4 라이브에 색인이 없으면(404) 실패하고 폴더를 만들지 않는다');
}

// ── F. (선택) 실제 광진구 견본 ──────────────────────────────────────────────────
if (process.env.STOREIDX_SAMPLE) {
  const out = join(tmp, 'sample');
  const r = await buildIndex({ input: process.env.STOREIDX_SAMPLE, outDir: out, zipmapDir: ZIPMAP, built: '2026-11-22', log: quiet });
  const f = JSON.parse(readFileSync(join(out, 'seoul/05.json'), 'utf8'));
  const ids = new Set(f.rows.map(x => x[0]));
  ok(r.rows === 18402 && r.active === 4218 && r.kept === 4218 && r.drop.dup === 0, `F1 광진구 견본 18,402행 · 영업 4,218 · 중복 0 (실제 ${r.rows}·${r.active}·${r.kept}·${r.drop.dup})`);
  ok(ids.has('3040000-101-2024-00011') && ids.has('3040000-101-2017-00245'), 'F2 필드테스트 두 가게가 광진구 파일에');
  ok(r.fffdRows === 0 && Object.keys(r.unmatched).length === 0, 'F3 견본에 풀 수 없는 글자·못 맞춘 지역 0');
  ok(!readFileSync(join(out, 'seoul/05.json'), 'utf8').includes('�'), 'F4 결과에 U+FFFD 없음');
}

rmSync(tmp, { recursive: true, force: true });
console.log(`${fail ? '❌' : '✅'} storeidx ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
