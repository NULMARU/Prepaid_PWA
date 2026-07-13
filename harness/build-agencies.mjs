#!/usr/bin/env node
// build-agencies.mjs — 행정표준코드 기관코드 원자료(TSV)로 전국 광역·기초 자치단체
// 부서(과) 데이터를 재생성한다.  Node 표준 라이브러리만 사용.
//
//   node harness/build-agencies.mjs <org0_utf8.txt> [outDir]
//
// 산출물(파일 계약, 앱이 이미 이 계약으로 구현됨 — 변경 금지):
//   <outDir>/agency-index.json
//   <outDir>/agency-depts/{region}.json   (17개)
//
// 필터 규칙(원자료에서 직접 검증해 확정):
//   - 존속: 존폐여부(26번 열)=="0"  (폐지행은 "1"이며 전부 폐지일자 보유)
//   - 본청: 유형분류_대=="02"(자치행정조직) & 기관코드==대표기관코드
//           & 유형분류_중=="01"(광역) 또는 "02"(기초)
//   - 본청 '과': 유형분류_대=="02" & 유형분류_중=="09"(보조기관) & 유형분류_소=="05"(과)
//           → 팀·계·읍면동(중03)·보건소/직속기관(중05)·사업소(중06)·의회(중04)·출장소(중07)는 자동 제외
//   - 제주 행정시(제주시·서귀포시)는 하부행정기구라 과가 중03·소06으로 분류됨 → 별도 규칙(이름이 '과'로 끝나는 소06)
//
// 2026-07-01 행정구역 개편 반영 상태(원자료 기준, 웹 확인 완료):
//   - 인천: 2군 8구 → 2군 9구(제물포·영종구 신설, 서구→서해구 개칭, 검단구 신설)
//   - 광주+전남: '전남광주통합특별시'(최상위 6130000)로 통합 출범.
//     그러나 앱 파일계약은 gwangju·jeonnam 2개 지역을 요구하므로,
//     통합시 산하 기초자치단체 데이터를 광주(자치구 5)·전남(시군 22)으로 되분리한다.

import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || path.resolve(process.cwd());
if (!SRC || !fs.existsSync(SRC)) {
  console.error('사용법: node harness/build-agencies.mjs <org0_utf8.txt> [outDir]');
  process.exit(1);
}
const UPDATED_AT = '2026-07-14';
const SOURCE = '행정표준코드 기관코드(2026-07)';

// ── 컬럼 인덱스(0-base) ──
const C = {
  code: 0, fullName: 1, shortName: 2, level: 3, order: 4,
  parent: 6, top: 7, rep: 8,
  daeCode: 9, daeName: 10, jungCode: 11, jungName: 12, soCode: 13, soName: 14,
  abolishDate: 23, status: 25,
};

// ── 로마자 슬러그(개정 로마자 표기) : 최하위기관명 → 슬러그 ──
const ROMA = {
  // 광역시 자치구/군 및 도 시군 (서울 25구는 기존 id 재사용하므로 제외)
  '중구':'jung','서구':'seo','동구':'dong','남구':'nam','북구':'buk',
  '영도구':'yeongdo','부산진구':'busanjin','동래구':'dongnae','해운대구':'haeundae','사하구':'saha',
  '금정구':'geumjeong','강서구':'gangseo','연제구':'yeonje','수영구':'suyeong','사상구':'sasang','기장군':'gijang',
  '수성구':'suseong','달서구':'dalseo','달성군':'dalseong','군위군':'gunwi',
  '영종구':'yeongjong','제물포구':'jemulpo','미추홀구':'michuhol','연수구':'yeonsu','남동구':'namdong',
  '부평구':'bupyeong','계양구':'gyeyang','서해구':'seohae','검단구':'geomdan','강화군':'ganghwa','옹진군':'ongjin',
  '유성구':'yuseong','대덕구':'daedeok','울주군':'ulju',
  '광산구':'gwangsan',
  // 전남
  '목포시':'mokpo','여수시':'yeosu','순천시':'suncheon','나주시':'naju','광양시':'gwangyang',
  '담양군':'damyang','곡성군':'gokseong','구례군':'gurye','고흥군':'goheung','보성군':'boseong',
  '화순군':'hwasun','장흥군':'jangheung','강진군':'gangjin','해남군':'haenam','영암군':'yeongam',
  '무안군':'muan','함평군':'hampyeong','영광군':'yeonggwang','장성군':'jangseong','완도군':'wando',
  '진도군':'jindo','신안군':'sinan',
  // 경기
  '수원시':'suwon','성남시':'seongnam','의정부시':'uijeongbu','안양시':'anyang','부천시':'bucheon',
  '광명시':'gwangmyeong','평택시':'pyeongtaek','동두천시':'dongducheon','안산시':'ansan','고양시':'goyang',
  '과천시':'gwacheon','구리시':'guri','남양주시':'namyangju','오산시':'osan','시흥시':'siheung',
  '군포시':'gunpo','의왕시':'uiwang','하남시':'hanam','용인시':'yongin','파주시':'paju',
  '이천시':'icheon','안성시':'anseong','김포시':'gimpo','연천군':'yeoncheon','가평군':'gapyeong',
  '양평군':'yangpyeong','화성시':'hwaseong','광주시':'gwangju','양주시':'yangju','포천시':'pocheon','여주시':'yeoju',
  // 충북
  '충주시':'chungju','제천시':'jecheon','보은군':'boeun','옥천군':'okcheon','영동군':'yeongdong',
  '진천군':'jincheon','괴산군':'goesan','음성군':'eumseong','단양군':'danyang','증평군':'jeungpyeong','청주시':'cheongju',
  // 충남
  '천안시':'cheonan','공주시':'gongju','보령시':'boryeong','아산시':'asan','서산시':'seosan',
  '논산시':'nonsan','금산군':'geumsan','부여군':'buyeo','서천군':'seocheon','청양군':'cheongyang',
  '홍성군':'hongseong','예산군':'yesan','태안군':'taean','계룡시':'gyeryong','당진시':'dangjin',
  // 경북
  '포항시':'pohang','경주시':'gyeongju','김천시':'gimcheon','안동시':'andong','구미시':'gumi',
  '영주시':'yeongju','영천시':'yeongcheon','상주시':'sangju','문경시':'mungyeong','경산시':'gyeongsan',
  '의성군':'uiseong','청송군':'cheongsong','영양군':'yeongyang','영덕군':'yeongdeok','청도군':'cheongdo',
  '고령군':'goryeong','성주군':'seongju','칠곡군':'chilgok','예천군':'yecheon','봉화군':'bonghwa',
  '울진군':'uljin','울릉군':'ulleung',
  // 경남
  '진주시':'jinju','통영시':'tongyeong','사천시':'sacheon','김해시':'gimhae','밀양시':'miryang',
  '거제시':'geoje','양산시':'yangsan','의령군':'uiryeong','함안군':'haman','창녕군':'changnyeong',
  '고성군':'goseong','남해군':'namhae','하동군':'hadong','산청군':'sancheong','함양군':'hamyang',
  '거창군':'geochang','합천군':'hapcheon','창원시':'changwon',
  // 강원
  '춘천시':'chuncheon','원주시':'wonju','강릉시':'gangneung','동해시':'donghae','태백시':'taebaek',
  '속초시':'sokcho','삼척시':'samcheok','홍천군':'hongcheon','횡성군':'hoengseong','영월군':'yeongwol',
  '평창군':'pyeongchang','정선군':'jeongseon','철원군':'cheorwon','화천군':'hwacheon','양구군':'yanggu',
  '인제군':'inje','양양군':'yangyang',
  // 전북
  '전주시':'jeonju','군산시':'gunsan','익산시':'iksan','정읍시':'jeongeup','남원시':'namwon',
  '김제시':'gimje','완주군':'wanju','진안군':'jinan','무주군':'muju','장수군':'jangsu',
  '임실군':'imsil','순창군':'sunchang','고창군':'gochang','부안군':'buan',
  // 제주 행정시
  '제주시':'jeju','서귀포시':'seogwipo',
};

// ── 지역 메타 ──
const REGIONS = [
  { code:'seoul',    name:'서울특별시',       gwang:'서울특별시청',       gwangCode:'6110000', top:'6110000' },
  { code:'busan',    name:'부산광역시',       gwang:'부산광역시청',       gwangCode:'6260000', top:'6260000' },
  { code:'daegu',    name:'대구광역시',       gwang:'대구광역시청',       gwangCode:'6270000', top:'6270000' },
  { code:'incheon',  name:'인천광역시',       gwang:'인천광역시청',       gwangCode:'6280000', top:'6280000' },
  { code:'gwangju',  name:'광주광역시',       gwang:'광주광역시청',       gwangCode:null,      top:'6130000', pick:'gu'    },
  { code:'daejeon',  name:'대전광역시',       gwang:'대전광역시청',       gwangCode:'6300000', top:'6300000' },
  { code:'ulsan',    name:'울산광역시',       gwang:'울산광역시청',       gwangCode:'6310000', top:'6310000' },
  { code:'sejong',   name:'세종특별자치시',   gwang:'세종특별자치시청',   gwangCode:'5690000', top:null },
  { code:'gyeonggi', name:'경기도',           gwang:'경기도청',           gwangCode:'6410000', top:'6410000' },
  { code:'gangwon',  name:'강원특별자치도',   gwang:'강원특별자치도청',   gwangCode:'6530000', top:'6530000' },
  { code:'chungbuk', name:'충청북도',         gwang:'충청북도청',         gwangCode:'6430000', top:'6430000' },
  { code:'chungnam', name:'충청남도',         gwang:'충청남도청',         gwangCode:'6440000', top:'6440000' },
  { code:'jeonbuk',  name:'전북특별자치도',   gwang:'전북특별자치도청',   gwangCode:'6540000', top:'6540000' },
  { code:'jeonnam',  name:'전라남도',         gwang:'전라남도청',         gwangCode:null,      top:'6130000', pick:'notgu' },
  { code:'gyeongbuk',name:'경상북도',         gwang:'경상북도청',         gwangCode:'6470000', top:'6470000' },
  { code:'gyeongnam',name:'경상남도',         gwang:'경상남도청',         gwangCode:'6480000', top:'6480000' },
  { code:'jeju',     name:'제주특별자치도',   gwang:'제주특별자치도청',   gwangCode:'6500000', top:null, admCities:['6510000','6520000'] },
];

// ── 원자료 파싱 ──
const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split('\n');
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const ln = lines[i];
  if (!ln) continue;
  const f = ln.split('\t');
  if (f.length < 26) continue;
  if (f[C.status] !== '0') continue; // 존속만
  rows.push(f);
}

const kcol = new Intl.Collator('ko');
const suffixToChung = (short) =>
  short.endsWith('구') ? short + '청' :
  short.endsWith('시') ? short + '청' :
  short.endsWith('군') ? short + '청' : short + '청';

const slug = (short) => ROMA[short] || null;

// ── 본청(자치단체) 목록: 대=02 & 기관코드==대표 & 중∈{01,02} ──
const hongchung = rows.filter(f =>
  f[C.daeCode] === '02' && f[C.code] === f[C.rep] &&
  (f[C.jungCode] === '01' || f[C.jungCode] === '02'));

// 대표기관코드 → 본청 short/최상위/소
const repMeta = new Map();
for (const f of hongchung) repMeta.set(f[C.code], { short: f[C.shortName], top: f[C.top], so: f[C.soCode], jung: f[C.jungCode] });

// ── 부서(과) 추출 ──
// 분류체계가 지자체마다 불균일하다(같은 '과'라도 어떤 곳은 중09·소05[보조기관],
// 어떤 도청은 중01[광역 자체], 다수 군은 중02[기초 자체]·소03으로 태깅).
// 따라서 신뢰 가능한 신호는 (a) 최하위기관명이 '과'로 끝나고 (b) 유형분류_중이
// 본청 본체(01 광역 / 02 기초 / 09 보조기관)이며 (c) 상위 경로가 본청 밖 기관
// (소방본부/보건소/사업소/의회/공단/직속기관 등)이 아닌 것.
const PROPER_JUNG = new Set(['01', '02', '09']);
// 상위 경로(전체기관명의 마지막 '과' 앞 토큰들)에 이 표지가 있으면 본청 밖 조직 → 제외
const PARENT_BLOCK = ['소방', '119', '보건소', '보건지소', '보건의료원',
  '사업소', '공단', '상수도', '하수', '농업기술', '연구원', '연구소', '보건환경',
  '의회', '시립대학', '인재개발', '출장소', '직속'];
function parentExcluded(fullName) {
  const parents = fullName.split(' ').slice(0, -1); // 마지막(과 자신) 제외
  return parents.some(t =>
    t.endsWith('읍') || t.endsWith('면') || t.endsWith('동') ||   // 읍·면·행정동 소속 과 제외
    PARENT_BLOCK.some(b => t.includes(b)));
}
const JEJU_ADM = new Set(['6510000', '6520000']);

const deptByRep = new Map(); // repCode -> [names]
const add = (rep, name) => { if (!deptByRep.has(rep)) deptByRep.set(rep, []); deptByRep.get(rep).push(name); };
for (const f of rows) {
  if (f[C.daeCode] !== '02') continue;
  const name = f[C.shortName];
  if (!name.endsWith('과')) continue;
  const rep = f[C.rep];
  if (parentExcluded(f[C.fullName])) continue;
  // 본청 본체(01 광역 / 02 기초 / 09 보조기관). 제주 행정시는 하부행정기구라
  // 국 소속 과가 중09로, 일부는 중03·소06으로 분류되므로 특례 허용.
  const ok = PROPER_JUNG.has(f[C.jungCode]) ||
    (JEJU_ADM.has(rep) && f[C.jungCode] === '03' && f[C.soCode] === '06');
  if (ok) add(rep, name);
}
const dedup = (arr) => { const s = new Set(), out = []; for (const x of arr) if (!s.has(x)) { s.add(x); out.push(x); } return out; };

// ── 서울 큐레이션 로드 ──
const curationPath = path.join(OUT, 'agency-departments.json');
const curation = JSON.parse(fs.readFileSync(curationPath, 'utf8'));
const seoulIds = curation.agencies.map(a => ({ id: a.id, name: a.name, departments: a.departments }));

// ── 지역별 조립 ──
const index = { schemaVersion: 2, updatedAt: UPDATED_AT, scope: '전국 광역·기초 자치단체(중앙정부 제외)', regions: [] };
const deptFiles = {}; // code -> {updatedAt, source, depts:{}}
const report = { regionBasicCount: {}, deptCoverage: {}, notes: [] };

for (const R of REGIONS) {
  const agencies = [];       // [{id,name}]
  const depts = {};          // agencyId -> [과]
  let filled = 0;

  if (R.code === 'seoul') {
    // 서울: 큐레이션 그대로 이식(id 재사용). 광역명만 계약 표기('서울특별시청')로.
    const city = seoulIds[0];
    agencies.push({ id: city.id, name: R.gwang });
    depts[city.id] = city.departments.slice();
    if (depts[city.id].length) filled++;
    const gu = seoulIds.slice(1).slice().sort((a, b) => kcol.compare(a.name, b.name));
    for (const g of gu) {
      agencies.push({ id: g.id, name: g.name });
      depts[g.id] = g.departments.slice();
      if (depts[g.id].length) filled++;
    }
    deptFiles[R.code] = { updatedAt: '2026-06-16', source: '큐레이션(2026-06-16)', depts };
    report.regionBasicCount[R.code] = gu.length;
    index.regions.push({ code: R.code, name: R.name, deptsFile: `agency-depts/${R.code}.json`, agencies });
    report.deptCoverage[R.code] = { filled, total: agencies.length };
    continue;
  }

  // 광역청
  const gwangId = `${R.code}-city`;
  agencies.push({ id: gwangId, name: R.gwang });
  if (R.gwangCode) {
    const d = dedup(deptByRep.get(R.gwangCode) || []);
    depts[gwangId] = d;
    if (d.length) filled++;
  } else {
    depts[gwangId] = []; // 광주·전남: 통합시 광역 부서를 분리 불가 → 비움
  }

  // 제주 행정시
  if (R.admCities) {
    const adm = [];
    for (const ac of R.admCities) {
      const m = repMeta.get(ac) || { short: (ac === '6510000' ? '제주시' : '서귀포시') };
      // 제주시/서귀포시는 본청 목록엔 없을 수 있으므로 이름 직접
      const short = (ac === '6510000') ? '제주시' : (ac === '6520000') ? '서귀포시' : m.short;
      const id = `${R.code}-${slug(short)}`;
      const d = dedup(deptByRep.get(ac) || []);
      adm.push({ id, name: suffixToChung(short) });
      depts[id] = d;
      if (d.length) filled++;
    }
    adm.sort((a, b) => kcol.compare(a.name, b.name));
    for (const a of adm) agencies.push(a);
    report.regionBasicCount[R.code] = adm.length;
  }

  // 기초자치단체
  if (R.top) {
    let basics = hongchung.filter(f =>
      f[C.jungCode] === '02' && f[C.top] === R.top);
    if (R.pick === 'gu') basics = basics.filter(f => f[C.soCode] === '04');
    if (R.pick === 'notgu') basics = basics.filter(f => f[C.soCode] !== '04');
    const list = basics.map(f => {
      const short = f[C.shortName];
      const sl = slug(short);
      if (!sl) report.notes.push(`로마자 미정: ${R.code} ${short}`);
      return { id: `${R.code}-${sl}`, name: suffixToChung(short), rep: f[C.code], short };
    });
    list.sort((a, b) => kcol.compare(a.name, b.name));
    for (const b of list) {
      agencies.push({ id: b.id, name: b.name });
      const d = dedup(deptByRep.get(b.rep) || []);
      depts[b.id] = d;
      if (d.length) filled++;
    }
    report.regionBasicCount[R.code] = (report.regionBasicCount[R.code] || 0) + list.length;
  }
  if (report.regionBasicCount[R.code] === undefined) report.regionBasicCount[R.code] = 0;

  deptFiles[R.code] = { updatedAt: UPDATED_AT, source: SOURCE, depts };
  index.regions.push({ code: R.code, name: R.name, deptsFile: `agency-depts/${R.code}.json`, agencies });
  report.deptCoverage[R.code] = { filled, total: agencies.length };
}

// ── 파일 쓰기 ──
fs.writeFileSync(path.join(OUT, 'agency-index.json'), JSON.stringify(index, null, 2) + '\n');
const deptDir = path.join(OUT, 'agency-depts');
fs.mkdirSync(deptDir, { recursive: true });
for (const [code, obj] of Object.entries(deptFiles)) {
  fs.writeFileSync(path.join(deptDir, `${code}.json`), JSON.stringify(obj, null, 2) + '\n');
}

// ── 리포트 출력(stderr) ──
const err = (...a) => console.error(...a);
err('=== 시도별 기초 자치단체(광역·행정시 제외) 수 ===');
let sum = 0;
for (const R of REGIONS) {
  const n = report.regionBasicCount[R.code] || 0;
  if (R.code !== 'seoul' && R.code !== 'jeju') sum += n;
  err(`${R.code.padEnd(10)} ${String(n).padStart(3)}  (부서채움 ${report.deptCoverage[R.code].filled}/${report.deptCoverage[R.code].total})`);
}
err('--- 서울 25 + 제주 행정시 2 는 위 표에 포함 ---');
err('총 지역:', index.regions.length);
if (report.notes.length) { err('경고:'); report.notes.forEach(n => err('  ' + n)); }
err('완료: agency-index.json + agency-depts/*.json (' + Object.keys(deptFiles).length + '개)');
