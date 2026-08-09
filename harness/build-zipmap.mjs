// 동(법정동·행정동·읍면·리) 이름 → 도로명 우편번호(5자리) 목록 정적 매핑 생성기.
//
//   node harness/build-zipmap.mjs <추출된 txt 디렉터리>
//
// 원자료: 우체국 우편번호 DB(구역번호 5자리) — https://www.epost.go.kr/search/zipcode/areacdAddressDown.jsp
//   의 "우편번호 DB"(zipcode_DB.zip, 로그인 불필요). 압축 안 파일명이 cp949라 macOS unzip이 실패하므로
//   `python3 -c "import zipfile; zipfile.ZipFile('zipcode_DB.zip').extractall('areacd')"` 로 풀 것(내용은 UTF-8).
// 출력: zipmap/index.json (시도·시군구 색인) + zipmap/{slug}.json ({시군구:{동명:[zip...]}})
// 갱신 주기: 연 1회면 충분(기초구역번호는 2015년 이후 안정적). 생성 후 커밋하면 GitHub Pages로 서빙된다.
//
// 열(파이프 구분, 0-기준): 0 우편번호, 1 시도, 3 시군구, 5 읍면, 17 법정동명, 18 리명, 19 행정동명
import { createReadStream, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';

const srcDir = process.argv[2];
if (!srcDir) { console.error('사용법: node harness/build-zipmap.mjs <추출된 txt 디렉터리>'); process.exit(1); }
const outDir = resolve(new URL('..', import.meta.url).pathname, 'zipmap');
mkdirSync(outDir, { recursive: true });

// 시도명 → 파일 slug (ASCII — GitHub Pages 경로 안전). 새 시도명이 나타나면 여기 추가.
const SLUGS = {
  '서울특별시': 'seoul', '부산광역시': 'busan', '대구광역시': 'daegu', '인천광역시': 'incheon',
  '광주광역시': 'gwangju', '대전광역시': 'daejeon', '울산광역시': 'ulsan', '세종특별자치시': 'sejong',
  '경기도': 'gyeonggi', '강원특별자치도': 'gangwon', '강원도': 'gangwon',
  '충청북도': 'chungbuk', '충청남도': 'chungnam',
  '전북특별자치도': 'jeonbuk', '전라북도': 'jeonbuk', '전라남도': 'jeonnam',
  '전남광주통합특별시': 'jeonnam-gwangju',
  '경상북도': 'gyeongbuk', '경상남도': 'gyeongnam', '제주특별자치도': 'jeju', '제주도': 'jeju'
};

// { 시도: { 시군구: { 동명: Set<zip> } } }
const map = new Map();
let rows = 0, skipped = 0;

function add(sido, sigungu, dong, zip) {
  const d = String(dong || '').trim();
  if (!d) return;
  let s1 = map.get(sido); if (!s1) { s1 = new Map(); map.set(sido, s1); }
  let s2 = s1.get(sigungu); if (!s2) { s2 = new Map(); s1.set(sigungu, s2); }
  let set = s2.get(d); if (!set) { set = new Set(); s2.set(d, set); }
  set.add(zip);
}

const files = readdirSync(srcDir).filter(f => f.endsWith('.txt'));
if (!files.length) { console.error('❌ txt 파일이 없습니다: ' + srcDir); process.exit(1); }
for (const f of files) {
  const rl = createInterface({ input: createReadStream(join(srcDir, f), 'utf8'), crlfDelay: Infinity });
  let first = true;
  for await (const line0 of rl) {
    const line = first ? line0.replace(/^﻿/, '') : line0; first = false;
    const c = line.split('|');
    if (c.length < 20 || c[0] === '우편번호') continue;
    const zip = c[0].trim(), sido = c[1].trim();
    // 세종특별자치시는 시군구가 없는 단층제 — 시군구 자리에 시도명을 그대로 쓴다.
    const sigungu = c[3].trim() || sido;
    if (!/^\d{5}$/.test(zip) || !sido) { skipped++; continue; }
    rows++;
    // 동 단위 키 4종 전부 등록 — 사장님이 어느 이름으로 불러도(법정동·행정동·읍/면·리) 걸리게.
    add(sido, sigungu, c[17], zip);  // 법정동명
    add(sido, sigungu, c[19], zip);  // 행정동명
    add(sido, sigungu, c[5], zip);   // 읍면
    add(sido, sigungu, c[18], zip);  // 리명
  }
}

const index = { v: 1, updatedAt: new Date().toISOString().slice(0, 10), sido: [] };
let totalDongs = 0;
for (const [sido, s1] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'))) {
  const slug = SLUGS[sido];
  if (!slug) { console.error('⚠️ slug 미등록 시도(건너뜀 — SLUGS에 추가 필요): ' + sido); continue; }
  const out = {};
  for (const [sg, s2] of [...s1.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'))) {
    out[sg] = {};
    for (const [dong, set] of [...s2.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'))) {
      out[sg][dong] = [...set].sort();
      totalDongs++;
    }
  }
  writeFileSync(join(outDir, slug + '.json'), JSON.stringify(out));
  index.sido.push({ name: sido, slug, sigungu: Object.keys(out) });
  console.log(`  ${sido} → zipmap/${slug}.json (시군구 ${Object.keys(out).length})`);
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
console.log(`✅ 완료 — 행 ${rows.toLocaleString()}건(제외 ${skipped}), 동 키 ${totalDongs.toLocaleString()}개, 출력 ${outDir}`);
