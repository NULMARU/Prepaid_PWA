#!/usr/bin/env node
// 가게 색인(storeidx) 생성기 — 행안부 일반음식점 전체 파일(CSV, cp949) → 시군구별 정적 JSON.
//
//   node harness/build-storeidx.mjs <전국 CSV 경로> [옵션]
//   node harness/build-storeidx.mjs --download [--keep <내려받을 파일 경로>] [옵션]
//   node harness/build-storeidx.mjs --mirror https://app.bapjangbu.com/storeidx/ [--out 폴더]   ← 라이브 색인을 그대로 받아 오기
//
//   옵션: --out <폴더>        출력 폴더(기본: 리포/storeidx). 끝까지 성공해야 이 폴더를 바꿔 끼운다(실패하면 예전 것 그대로).
//         --zipmap <폴더>     지역 이름표(기본: 리포/zipmap) — 시도·시군구 표기를 여기에 맞춘다.
//         --built YYYY-MM-DD  meta.built 값(기본: 오늘, 한국 시각).
//         --min-total <N>     영업 가게가 N보다 적으면 실패(CI에서 반쪽 자료가 배포되지 않게). 기본 0.
//         --report <파일>     집계(버린 행·못 맞춘 지역 등)를 JSON으로 저장.
//
// 원자료: https://file.localdata.go.kr/file/download/general_restaurants/info (전국, 약 700MB)
//         `?orgCode=3040000`(시군구 코드)를 붙이면 그 시군구만. 브라우저 User-Agent와 Referer가 있어야 200(없으면 403).
// 형식(v1, 계약서 .claude/reviews/beta61-contract.md 2절):
//   storeidx/meta.json        { v:1, built, total, regions:{ <시도>:{ <시군구>:{ f:"<slug>/<번호>.json", n } } } }
//   storeidx/<slug>/<번호>.json { v:1, rows:[[관리번호, 사업장명, 도로명주소, 지번주소, 도로명우편번호], …] } (사업장명 가나다순)
//   · 영업상태코드 01(영업)만. **전화번호는 넣지 않는다**(불변식 4).
//   · 지역은 주소(도로명주소, 없으면 지번주소)의 앞머리로 정하고 zipmap 키에 맞춘다. 주소 앞머리가 zipmap에 없으면
//     (인천 중구·서구처럼 이름이 바뀐 구, 시 아래 일반구가 빠진 주소) 우편번호 → 동 이름 순으로 zipmap에서 찾는다.
//   · <번호>는 zipmap/index.json의 그 시도 시군구 목록 순번(2자리) — zipmap이 그대로면 날마다 같은 파일 이름.
//
// 외부 패키지 없음. Node 내장 TextDecoder('euc-kr')는 Node 빌드에 따라 cp949 확장 한글(똠·햏 등 8,822자)을
// 풀지 못하므로(Node 24에서 실측), cp949 표는 KS X 1001 영역만 내장 해석기로 얻고 확장 한글은 규칙으로 채운다.
import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── cp949 해석기 ────────────────────────────────────────────────────────────────
let CP949 = null;
export function cp949Table() {
  if (CP949) return CP949;
  const t = new Uint16Array(65536).fill(0xFFFD);
  const nat = new TextDecoder('euc-kr');
  const ksHangul = new Set();
  // ① KS X 1001(EUC-KR) 영역: 리드·트레일 0xA1~0xFE — 내장 해석기로 한 칸씩
  for (let l = 0xA1; l <= 0xFE; l++) for (let r = 0xA1; r <= 0xFE; r++) {
    const s = nat.decode(Uint8Array.of(l, r));
    const c = s.length === 1 ? s.charCodeAt(0) : 0xFFFD;
    // 사용자 정의 영역(C9xx·FExx)은 내장 해석기가 사설 영역(U+E000~)으로 주지만 cp949(윈도 949)에는 없다 → 풀 수 없음으로
    if (c !== 0xFFFD && !(c >= 0xE000 && c <= 0xF8FF)) {
      t[(l << 8) | r] = c;
      if (c >= 0xAC00 && c <= 0xD7A3) ksHangul.add(c);
    }
  }
  // 윈도 949가 나중에 더한 두 글자(내장 해석기에 없는 빌드가 있다)
  t[0xA2E6] = 0x20AC; t[0xA2E7] = 0x00AE;   // € ®
  // ② 확장 한글(UHC): KS X 1001에 없는 한글 음절 8,822자를 코드 순서대로 다음 자리에 채운다(WHATWG index-euc-kr와 같은 배치)
  //    리드 0x81~0xA0: 트레일 41~5A, 61~7A, 81~FE / 리드 0xA1~0xC6: 트레일 41~5A, 61~7A, 81~A0
  const rest = [];
  for (let c = 0xAC00; c <= 0xD7A3; c++) if (!ksHangul.has(c)) rest.push(c);
  let k = 0;
  for (let l = 0x81; l <= 0xC6 && k < rest.length; l++) {
    const trails = [];
    for (let r = 0x41; r <= 0x5A; r++) trails.push(r);
    for (let r = 0x61; r <= 0x7A; r++) trails.push(r);
    for (let r = 0x81; r <= (l < 0xA1 ? 0xFE : 0xA0); r++) trails.push(r);
    for (const r of trails) { if (k >= rest.length) break; t[(l << 8) | r] = rest[k++]; }
  }
  // ③ 자기 점검 — 어긋나면 만들지 않는다(CI는 라이브 색인으로 대신한다)
  const must = { 0xB0A1: '가', 0xC8FE: '힝', 0xA1A1: '　', 0xCAA1: '伽', 0x8141: '갂', 0x8C63: '똠', 0xC652: '힣', 0xAE9D: '츧' };
  for (const [code, ch] of Object.entries(must))
    if (t[+code] !== ch.charCodeAt(0)) throw new Error(`cp949 표 자기 점검 실패: 0x${(+code).toString(16)} → U+${t[+code].toString(16)} (기대 ${ch})`);
  if (ksHangul.size !== 2350 || k !== 8822) throw new Error(`cp949 표 자기 점검 실패: KS 한글 ${ksHangul.size}(기대 2350), 확장 ${k}(기대 8822)`);
  CP949 = t;
  return t;
}

// 흘려 읽기용 해석기: decode(바이트 조각) → 문자열. 조각 끝에 걸친 리드 바이트는 다음 조각으로 넘긴다.
// 풀 수 없는 2바이트는 U+FFFD 하나 — 트레일이 ASCII면 그 바이트는 다시 ASCII로 읽는다(쉼표·따옴표를 먹지 않게).
export function makeCp949Decoder() {
  const t = cp949Table();
  const u16 = new TextDecoder('utf-16le');
  let carry = -1;
  return function decode(chunk, last = false) {
    const out = new Uint16Array(chunk.length + 2);
    let o = 0, i = 0;
    if (carry >= 0) {
      if (chunk.length) { i = pair(carry, chunk[0]); } else if (last) { out[o++] = 0xFFFD; }
      carry = -1;
    }
    function pair(l, r) {
      const c = t[(l << 8) | r];
      if (c !== 0xFFFD) { out[o++] = c; return 1; }
      out[o++] = 0xFFFD;
      return r < 0x80 ? 0 : 1;      // ASCII 트레일은 다시 읽는다
    }
    const n = chunk.length;
    while (i < n) {
      const b = chunk[i];
      if (b < 0x80) { out[o++] = b; i++; continue; }
      if (b === 0x80 || b === 0xFF) { out[o++] = 0xFFFD; i++; continue; }
      if (i + 1 >= n) { if (last) out[o++] = 0xFFFD; else carry = b; i++; break; }
      i += 1 + pair(b, chunk[i + 1]);
    }
    return u16.decode(out.subarray(0, o));
  };
}

// ── CSV(RFC 4180) 흘려 읽기 ─────────────────────────────────────────────────────
// 따옴표 칸 안의 쉼표·줄바꿈·"" 처리. 행이 끝날 때마다 onRow(필드 배열).
export class CsvParser {
  constructor(onRow) { this.onRow = onRow; this.row = []; this.field = ''; this.st = 0; } // 0 칸 시작, 1 보통 칸, 2 따옴표 칸, 3 따옴표 칸에서 " 본 직후
  push(s) {
    let i = 0, st = this.st; const n = s.length;
    while (i < n) {
      if (st === 2) {
        const j = s.indexOf('"', i);
        if (j < 0) { this.field += s.slice(i); i = n; break; }
        this.field += s.slice(i, j); i = j + 1; st = 3; continue;
      }
      const c = s.charCodeAt(i);
      if (st === 3) { if (c === 34) { this.field += '"'; i++; st = 2; continue; } st = 1; }
      else if (st === 0) { if (c === 34) { st = 2; i++; continue; } st = 1; }
      let j = i;
      while (j < n) { const d = s.charCodeAt(j); if (d === 44 || d === 10 || d === 13) break; j++; }
      if (j > i) this.field += s.slice(i, j);
      i = j;
      if (j >= n) break;
      const d = s.charCodeAt(j); i++;
      if (d === 44) { this.row.push(this.field); this.field = ''; st = 0; }
      else if (d === 10) { this.row.push(this.field); this.field = ''; this.flush(); st = 0; }
      // \r 은 버린다(CRLF)
    }
    this.st = st;
  }
  flush() { const r = this.row; this.row = []; if (r.length === 1 && r[0] === '') return; this.onRow(r); }
  end() { if (this.st !== 0 || this.field !== '' || this.row.length) { this.row.push(this.field); this.field = ''; this.flush(); } this.st = 0; }
}

// ── 지역 해석(zipmap 키에 맞추기) ───────────────────────────────────────────────
// 주소에 적힌 예전·다른 시도 이름 → zipmap 이름. zipmap에 원래 이름이 있으면 그것을 먼저 쓴다.
const SIDO_ALIAS = {
  '서울': '서울특별시', '서울시': '서울특별시', '부산': '부산광역시', '부산시': '부산광역시', '대구': '대구광역시', '대구시': '대구광역시',
  '인천': '인천광역시', '인천시': '인천광역시', '대전': '대전광역시', '대전시': '대전광역시', '울산': '울산광역시', '울산시': '울산광역시',
  '세종': '세종특별자치시', '세종시': '세종특별자치시', '경기': '경기도',
  '강원도': '강원특별자치도', '강원': '강원특별자치도', '충북': '충청북도', '충남': '충청남도',
  '전라북도': '전북특별자치도', '전북': '전북특별자치도',
  '광주광역시': '전남광주통합특별시', '광주': '전남광주통합특별시', '전라남도': '전남광주통합특별시', '전남': '전남광주통합특별시',
  '경북': '경상북도', '경남': '경상남도', '제주도': '제주특별자치도', '제주': '제주특별자치도',
};
const DONG_RE = /^[가-힣0-9.·]+[동가리읍면]$/;

export function loadZipmap(dir) {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  const sido = new Map();               // 시도 → { slug, keys:[...], keySet, num:Map(key→번호), zip:Map(zip→Set(key)), dong:Map(dong→Set(key)) }
  const zipAll = new Map();             // zip → Set("시도|키")
  const keyAll = new Map();             // 키 → Set(시도)
  for (const s of index.sido) {
    const m = JSON.parse(readFileSync(join(dir, s.slug + '.json'), 'utf8'));
    const e = { slug: s.slug, keys: s.sigungu, keySet: new Set(s.sigungu), num: new Map(), zip: new Map(), dong: new Map() };
    s.sigungu.forEach((k, i) => e.num.set(k, String(i).padStart(2, '0')));
    for (const [k, dongs] of Object.entries(m)) {
      for (const [d, zips] of Object.entries(dongs)) {
        if (!e.dong.has(d)) e.dong.set(d, new Set()); e.dong.get(d).add(k);
        for (const z of zips) {
          if (!e.zip.has(z)) e.zip.set(z, new Set()); e.zip.get(z).add(k);
          if (!zipAll.has(z)) zipAll.set(z, new Set()); zipAll.get(z).add(s.name + '|' + k);
        }
      }
      if (!keyAll.has(k)) keyAll.set(k, new Set()); keyAll.get(k).add(s.name);
    }
    sido.set(s.name, e);
  }
  return { updatedAt: index.updatedAt, sido, zipAll, keyAll };
}

// 주소 안의 동 이름 후보: 지번주소의 시군구 뒤 토큰들 + 도로명주소 괄호 안 첫 이름
function dongCands(road, jibun) {
  const out = [];
  for (const tok of String(jibun || '').split(/\s+/).slice(1, 6)) if (DONG_RE.test(tok) && !/[시도군구]$/.test(tok)) out.push(tok);
  const p = String(road || '').match(/\(([^)]*)\)\s*$/);
  if (p) for (const tok of p[1].split(/[,\s]+/)) if (DONG_RE.test(tok)) out.push(tok);
  return out;
}

// 후보 키 집합 안에서 우편번호 → 동 이름으로 하나를 고른다. 하나로 안 갈리면 ''.
function pickIn(e, cands, zip, dongs) {
  if (zip && e.zip.has(zip)) { const hit = [...e.zip.get(zip)].filter(k => cands.has(k)); if (hit.length === 1) return [hit[0], 'zip']; }
  for (const d of dongs) {
    for (const dd of [d, d.replace(/\d+(?=동$)/, '')]) {
      const s = e.dong.get(dd); if (!s) continue;
      const hit = [...s].filter(k => cands.has(k)); if (hit.length === 1) return [hit[0], 'dong'];
    }
  }
  return ['', ''];
}

// → { sido, key, how } | { fail:'사유', head:'주소 앞머리' }
export function resolveRegion(zm, addr, zip, road, jibun) {
  const t = String(addr || '').trim().split(/\s+/);
  const head = t.slice(0, 2).join(' ');
  let sidoName = zm.sido.has(t[0]) ? t[0] : (SIDO_ALIAS[t[0]] && zm.sido.has(SIDO_ALIAS[t[0]]) ? SIDO_ALIAS[t[0]] : '');
  const dongs = dongCands(road, jibun);
  if (sidoName) {
    const e = zm.sido.get(sidoName);
    // 세종처럼 시군구가 없는 곳: zipmap 키가 시도 이름 하나
    if (e.keys.length === 1 && e.keys[0] === sidoName) return { sido: sidoName, key: sidoName, how: 'single' };
    const t1 = t[1] || '', t2 = t[2] || '';
    if (t2 && e.keySet.has(t1 + ' ' + t2)) return { sido: sidoName, key: t1 + ' ' + t2, how: 'exact' };
    const subs = e.keys.filter(k => k.startsWith(t1 + ' '));
    if (subs.length) {
      // "화성시 …"처럼 일반구가 빠진 주소 → 그 시의 일반구 중에서 우편번호·동으로
      const [k, how] = pickIn(e, new Set(subs), zip, dongs);
      if (k) return { sido: sidoName, key: k, how: 'city-' + how };
      if (e.keySet.has(t1)) return { sido: sidoName, key: t1, how: 'city-bare' };
      return { fail: '일반구를 정하지 못함', head };
    }
    if (e.keySet.has(t1)) return { sido: sidoName, key: t1, how: 'exact' };
    // 시군구 이름이 zipmap에 없음(인천 중구→제물포구·영종구 등) → 그 시도 안에서 우편번호·동으로
    const [k, how] = pickIn(e, e.keySet, zip, dongs);
    if (k) return { sido: sidoName, key: k, how: 'renamed-' + how };
  }
  // 시도가 바뀐 곳(경북 군위군 → 대구 군위군) 또는 시도 이름이 낯선 주소: 전국 우편번호 → 전국에서 하나뿐인 시군구 이름
  if (zip && zm.zipAll.has(zip) && zm.zipAll.get(zip).size === 1) {
    const [s, k] = [...zm.zipAll.get(zip)][0].split('|');
    return { sido: s, key: k, how: 'zip-national' };
  }
  for (const cand of [t[1] + ' ' + (t[2] || ''), t[1]]) {
    const ss = zm.keyAll.get(cand);
    if (ss && ss.size === 1) return { sido: [...ss][0], key: cand, how: 'name-national' };
  }
  return { fail: sidoName ? '시군구를 정하지 못함' : '시도 이름 모름', head };
}

// ── 만들기 ──────────────────────────────────────────────────────────────────────
const NEED = ['관리번호', '영업상태코드', '사업장명', '도로명주소', '지번주소', '도로명우편번호'];
const clean = s => String(s || '').replace(/�/g, '').replace(/\s+/g, ' ').trim();

export async function buildIndex({ input, outDir, zipmapDir, built, minTotal = 0, log = console.log }) {
  const t0 = Date.now();
  const zm = loadZipmap(zipmapDir);
  const st = { rows: 0, active: 0, kept: 0, closedByCode: {}, drop: { cols: 0, noId: 0, dup: 0, noName: 0, noAddr: 0, region: 0 }, fffdRows: 0, how: {}, unmatched: {} };
  const buckets = new Map();   // "시도|키" → [JSON 문자열] (원본 조각을 붙잡지 않게 문자열로 보관)
  const seen = new Set();
  let col = null, hdrLen = 0;
  const parser = new CsvParser(f => {
    if (!col) {
      f[0] = f[0].replace(/^﻿/, '');
      col = {}; f.forEach((h, i) => { col[h.trim()] = i; }); hdrLen = f.length;
      const miss = NEED.filter(h => !(h in col));
      if (miss.length) throw new Error('머리줄에 필요한 열이 없음: ' + miss.join(', ') + ' (머리줄: ' + f.slice(0, 8).join(',') + '…)');
      return;
    }
    st.rows++;
    if (f.length !== hdrLen) { st.drop.cols++; return; }
    const code = f[col['영업상태코드']].trim();
    if (code !== '01') { st.closedByCode[code] = (st.closedByCode[code] || 0) + 1; return; }
    st.active++;
    const id = clean(f[col['관리번호']]);
    if (!id) { st.drop.noId++; return; }
    if (seen.has(id)) { st.drop.dup++; return; }
    const rawName = f[col['사업장명']], rawRoad = f[col['도로명주소']], rawJibun = f[col['지번주소']];
    if ((rawName + rawRoad + rawJibun).includes('�')) st.fffdRows++;
    const name = clean(rawName), road = clean(rawRoad), jibun = clean(rawJibun);
    if (!name) { st.drop.noName++; return; }
    if (!road && !jibun) { st.drop.noAddr++; return; }
    const zr = f[col['도로명우편번호']].trim(); const zip = /^\d{5}$/.test(zr) ? zr : '';
    let r = resolveRegion(zm, road || jibun, zip, road, jibun);
    if (r.fail && road && jibun) { const r2 = resolveRegion(zm, jibun, zip, road, jibun); if (!r2.fail) r = r2; }
    if (r.fail) {
      st.drop.region++;
      const k = r.fail + ' · ' + r.head; st.unmatched[k] = (st.unmatched[k] || 0) + 1;
      return;
    }
    st.how[r.how] = (st.how[r.how] || 0) + 1;
    seen.add(Buffer.from(id).toString());          // 새 문자열(원본 조각을 붙잡지 않게)
    const bk = r.sido + '|' + r.key;
    let b = buckets.get(bk); if (!b) { b = []; buckets.set(bk, b); }
    b.push(JSON.stringify([id, name, road, jibun, zip]));
    st.kept++;
  });

  const decode = makeCp949Decoder();
  let bytes = 0;
  for await (const chunk of createReadStream(input, { highWaterMark: 1 << 20 })) {
    bytes += chunk.length;
    parser.push(decode(chunk));
  }
  parser.push(decode(new Uint8Array(0), true));
  parser.end();
  if (!col) throw new Error('빈 파일이거나 머리줄이 없음');
  const tParse = Date.now();
  if (st.kept < minTotal) throw new Error(`영업 가게 ${st.kept}건 — 기대 최소 ${minTotal}건보다 적음(자료가 잘렸거나 형식이 바뀐 듯)`);

  // 임시 폴더에 다 쓴 뒤 바꿔 끼운다
  const tmp = outDir + '.tmp-' + process.pid;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const coll = new Intl.Collator('ko');
  const meta = { v: 1, built, total: st.kept, regions: {} };
  const files = [];
  try {
    for (const sidoName of [...zm.sido.keys()].sort((a, b) => coll.compare(a, b))) {
      const e = zm.sido.get(sidoName);
      for (const key of e.keys) {
        const b = buckets.get(sidoName + '|' + key);
        if (!b || !b.length) continue;
        const rows = b.map(s => JSON.parse(s)).sort((x, y) => coll.compare(x[1], y[1]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        const rel = e.slug + '/' + e.num.get(key) + '.json';
        mkdirSync(join(tmp, e.slug), { recursive: true });
        const body = JSON.stringify({ v: 1, rows });
        writeFileSync(join(tmp, rel), body);
        (meta.regions[sidoName] ||= {})[key] = { f: rel, n: rows.length };
        files.push({ rel, sido: sidoName, key, n: rows.length, bytes: Buffer.byteLength(body) });
      }
    }
    writeFileSync(join(tmp, 'meta.json'), JSON.stringify(meta));
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  rmSync(outDir, { recursive: true, force: true });
  renameSync(tmp, outDir);

  const emptyKeys = [];
  for (const [sidoName, e] of zm.sido) for (const key of e.keys) if (!buckets.has(sidoName + '|' + key)) emptyKeys.push(sidoName + ' ' + key);
  const report = { input, bytes, zipmapUpdatedAt: zm.updatedAt, built, ...st, files: files.length,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0), biggest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    over3MB: files.filter(f => f.bytes > 3 * 1024 * 1024).map(f => f.rel), emptyKeys,
    ms: { parse: tParse - t0, write: Date.now() - tParse }, rssMB: Math.round(process.memoryUsage().rss / 1048576) };
  log(`✅ 색인 — 행 ${st.rows.toLocaleString()} · 영업 ${st.active.toLocaleString()} · 실은 가게 ${st.kept.toLocaleString()} · 파일 ${files.length} · ${(report.totalBytes / 1048576).toFixed(1)}MB → ${outDir}`);
  log(`   버린 영업 행: ${JSON.stringify(st.drop)} · 풀 수 없는 글자가 든 행 ${st.fffdRows}`);
  if (Object.keys(st.unmatched).length) log('   ⚠️ 지역을 못 맞춘 주소: ' + JSON.stringify(st.unmatched));
  if (report.over3MB.length) log('   ⚠️ 3MB 넘는 파일: ' + report.over3MB.join(', '));
  return report;
}

// ── 내려받기 ────────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://file.localdata.go.kr/file/general_restaurants/info';
export async function download(dest, { orgCode = '', log = console.log } = {}) {
  const h = { 'User-Agent': UA, Referer: REFERER, Accept: 'text/csv,*/*' };
  const v = await fetch('https://file.localdata.go.kr/file/validate/download-count', { headers: h, signal: AbortSignal.timeout(30000) });
  if (v.status === 429) throw new Error('내려받기 한도(429): ' + (await v.text()).slice(0, 200));
  if (!v.ok) throw new Error('내려받기 확인 실패 HTTP ' + v.status);
  const url = 'https://file.localdata.go.kr/file/download/general_restaurants/info' + (orgCode ? '?orgCode=' + encodeURIComponent(orgCode) : '');
  const res = await fetch(url, { headers: h, redirect: 'manual', signal: AbortSignal.timeout(30 * 60 * 1000) });
  const ct = res.headers.get('content-type') || '';
  if (res.status !== 200 || !/csv/i.test(ct)) throw new Error(`내려받기 실패 HTTP ${res.status} (${ct}) ${res.headers.get('location') || ''}`);
  mkdirSync(dirname(dest), { recursive: true });
  const t0 = Date.now();
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const size = statSync(dest).size;
  const len = +res.headers.get('content-length') || 0;
  if (len && size !== len) throw new Error(`내려받은 크기 ${size} ≠ Content-Length ${len}`);
  log(`⬇️  ${url} → ${dest} (${(size / 1048576).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  return dest;
}

// ── 라이브 색인 그대로 가져오기(배포 때 만들기가 실패하면) ─────────────────────
// base 예: https://app.bapjangbu.com/storeidx/ — meta.json과 그 안의 파일을 전부 받아 모양을 확인한 뒤에만 바꿔 끼운다.
const REL_RE = /^[a-z-]+\/\d{2}\.json$/;
export async function mirrorLive(base, outDir, { log = console.log, fetchImpl = fetch } = {}) {
  if (!base.endsWith('/')) base += '/';
  const get = async (rel) => {
    for (let a = 1; ; a++) {
      try {
        const r = await fetchImpl(base + rel, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.final = r.status === 404; throw e; }   // 404 = 라이브에 없음 → 다시 묻지 않는다
        return await r.text();
      } catch (e) { if (e.final || a >= 3) throw new Error(`${base + rel}: ${e.message}`); await new Promise(s => setTimeout(s, 2000 * a)); }
    }
  };
  const metaText = await get('meta.json');
  const meta = JSON.parse(metaText);
  if (meta.v !== 1 || !meta.regions || typeof meta.total !== 'number') throw new Error('라이브 meta.json 모양이 다름(v1 아님)');
  const list = [];
  for (const ks of Object.values(meta.regions)) for (const ent of Object.values(ks)) {
    if (!REL_RE.test(ent.f)) throw new Error('라이브 meta.json에 이상한 파일 경로: ' + ent.f);
    list.push(ent);
  }
  const tmp = outDir + '.tmp-' + process.pid;
  rmSync(tmp, { recursive: true, force: true });
  try {
    let next = 0, sum = 0;
    const worker = async () => {
      while (next < list.length) {
        const ent = list[next++];
        const body = await get(ent.f);
        const j = JSON.parse(body);
        if (j.v !== 1 || !Array.isArray(j.rows) || j.rows.length !== ent.n) throw new Error(`라이브 ${ent.f} 모양·건수가 meta와 다름`);
        sum += ent.n;
        mkdirSync(join(tmp, dirname(ent.f)), { recursive: true });
        writeFileSync(join(tmp, ent.f), body);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (sum !== meta.total) throw new Error(`라이브 색인 건수 합 ${sum} ≠ total ${meta.total}`);
    writeFileSync(join(tmp, 'meta.json'), metaText);
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  rmSync(outDir, { recursive: true, force: true });
  renameSync(tmp, outDir);
  log(`↩️  라이브 색인을 그대로 가져옴 — ${meta.built} 기준 · 가게 ${meta.total.toLocaleString()} · 파일 ${list.length} → ${outDir}`);
  return meta;
}

// ── 명령줄 ──────────────────────────────────────────────────────────────────────
function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
async function main(argv) {
  const opt = { out: join(ROOT, 'storeidx'), zipmap: join(ROOT, 'zipmap'), built: kstToday(), minTotal: 0, report: '', keep: '', download: false, orgCode: '', input: '', mirror: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--download') opt.download = true;
    else if (a === '--out') opt.out = resolve(argv[++i]);
    else if (a === '--zipmap') opt.zipmap = resolve(argv[++i]);
    else if (a === '--built') opt.built = argv[++i];
    else if (a === '--min-total') opt.minTotal = +argv[++i];
    else if (a === '--report') opt.report = resolve(argv[++i]);
    else if (a === '--keep') opt.keep = resolve(argv[++i]);
    else if (a === '--org-code') opt.orgCode = argv[++i];
    else if (a === '--mirror') opt.mirror = argv[++i];
    else if (!a.startsWith('--') && !opt.input) opt.input = resolve(a);
    else throw new Error('모르는 인자: ' + a);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opt.built)) throw new Error('--built 는 YYYY-MM-DD');
  if (opt.mirror) { await mirrorLive(opt.mirror, opt.out); return; }
  if (opt.download) {
    opt.input = opt.keep || join(tmpdir(), `storeidx-src-${process.pid}.csv`);
    await download(opt.input, { orgCode: opt.orgCode });
  }
  if (!opt.input || !existsSync(opt.input)) {
    console.error('사용법: node harness/build-storeidx.mjs <전국 CSV> [--out 폴더] [--min-total N] [--report 파일]\n       node harness/build-storeidx.mjs --download [--keep 파일] [--org-code 3040000] …\n       node harness/build-storeidx.mjs --mirror <라이브 storeidx 주소> [--out 폴더]');
    process.exit(2);
  }
  try {
    const rep = await buildIndex({ input: opt.input, outDir: opt.out, zipmapDir: opt.zipmap, built: opt.built, minTotal: opt.minTotal });
    if (opt.report) writeFileSync(opt.report, JSON.stringify(rep, null, 2));
  } finally {
    if (opt.download && !opt.keep) rmSync(opt.input, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(e => { console.error('❌ ' + (e && e.message || e)); process.exit(1); });
}
