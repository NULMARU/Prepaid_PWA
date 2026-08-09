// 동 이름 검색(A안) 타당성 probe — 공공 API에 "법정동코드(ASCII) 조건"이 있는지 확인한다.
//
//   PUBLIC_API_KEY=<Decoding키> node server/probe-emd.mjs
//
// 하는 일(총 호출 10회 안팎 — 일일 쿼터에 부담 없음):
//   1) 우편번호 05021로 원본 행을 받아 **응답 필드 키 전체**를 덤프(우리가 명세를 못 구해서 실물로 확인)
//   2) 한글 조건 장애가 아직인지 재확인(cond[BPLC_NM::LIKE]=김밥)
//   3) 응답에서 "숫자 코드로 보이는 필드"를 골라 cond[<필드>::EQ]=<그 행의 값> 을 하나씩 실험
//      → totalCount가 여러 건 나오는 동(EMD)급 코드 필드가 있으면 A안 성립.
//
// 결과 마지막 줄의 판정을 그대로 Claude에게 붙여넣어 주면 된다.
const KEY = process.env.PUBLIC_API_KEY;
if (!KEY) {
  console.error('❌ 사용법: PUBLIC_API_KEY=<Decoding키> node server/probe-emd.mjs');
  process.exit(1);
}
const BASE = process.env.PUBLIC_API_BASE || 'https://apis.data.go.kr/1741000/general_restaurants/info';

async function call(extra) {
  const params = [['serviceKey', KEY], ['returnType', 'json'], ...extra];
  const qs = params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const res = await fetch(BASE + '?' + qs);
  if (!res.ok) return { error: 'HTTP ' + res.status };
  let data;
  try { data = await res.json(); } catch { return { error: 'JSON 파싱 실패' }; }
  const hdr = data?.response?.header;
  if (hdr && hdr.resultCode != null && !['0', '00'].includes(String(hdr.resultCode)))
    return { error: hdr.resultMsg || hdr.resultCode };
  const body = data?.response?.body;
  const it = body?.items?.item ?? body?.items;
  const rows = Array.isArray(it) ? it : (it ? [it] : []);
  return { rows, total: Number(body?.totalCount ?? rows.length) };
}

// 1) 원본 행 필드 덤프
console.log('── 1) 응답 필드 실물 확인 (cond[ROAD_NM_ZIP::EQ]=05021) ──');
const base = await call([['cond[ROAD_NM_ZIP::EQ]', '05021'], ['pageNo', '1'], ['numOfRows', '3']]);
if (base.error || !base.rows?.length) {
  console.error('❌ 기준 조회 실패:', base.error || '0건 — 키가 Decoding 키인지 확인');
  process.exit(1);
}
const row = base.rows[0];
for (const [k, v] of Object.entries(row)) {
  const s = String(v ?? '');
  console.log(`  ${k} = ${s.length > 40 ? s.slice(0, 40) + '…' : s}`);
}

// 2) 한글 조건 장애 재확인
const kr = await call([['cond[BPLC_NM::LIKE]', '김밥'], ['pageNo', '1'], ['numOfRows', '1']]);
console.log('\n── 2) 한글 조건 상태 ──');
console.log(kr.error ? `  오류: ${kr.error}` : `  cond[BPLC_NM::LIKE]=김밥 → ${kr.total}건 ${kr.total > 0 ? '(✅ 복구됨!)' : '(⛔ 장애 지속)'}`);

// 3) 숫자 코드 필드 후보로 EQ 조건 실험
console.log('\n── 3) ASCII 코드 조건 실험 ──');
const known = new Set(['MNG_NO', 'ROAD_NM_ZIP', 'LCTN_ZIP', 'OPN_ATMY_GRP_CD']);
const candidates = Object.entries(row)
  .filter(([k, v]) => !known.has(k) && /^\d{5,}$/.test(String(v ?? '').trim()))
  .slice(0, 6);
for (const guess of ['LCTN_EMD_CD', 'EMD_CD', 'STDG_CD', 'RDN_CD']) // 명세 추정 이름(응답에 없어도 시도)
  if (!(guess in row)) candidates.push([guess, null]);
const results = [];
for (const [k, v] of candidates.slice(0, 8)) {
  const val = v ?? '1121510700'; // 응답에 없는 추정 필드는 광진구 구의동 법정동코드로 시도
  const r = await call([[`cond[${k}::EQ]`, String(v ?? val).trim()], ['pageNo', '1'], ['numOfRows', '1']]);
  const line = r.error ? `오류(${r.error})` : `${r.total}건`;
  console.log(`  cond[${k}::EQ]=${String(v ?? val).trim()} → ${line}`);
  if (!r.error) results.push({ k, total: r.total });
}

// 판정: 어떤 코드 필드가 "여러 건"을 돌려주면 그 필드로 동 단위 검색이 가능하다는 뜻
console.log('\n── 판정 ──');
const hit = results.filter(r => r.total > 1);
if (hit.length) console.log(`✅ A안 가능성: ${hit.map(r => r.k + '(' + r.total + '건)').join(', ')} — 이 출력 전체를 Claude에게 붙여넣어 주세요.`);
else console.log('❔ 동급 코드 조건을 찾지 못함 — 이 출력 전체를 Claude에게 붙여넣어 주세요(B안 검토).');
