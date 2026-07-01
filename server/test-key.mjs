// data.go.kr 인증키로 음식점 검색을 한 줄로 테스트.
//   PUBLIC_API_KEY=<Decoding키> node server/test-key.mjs <지역코드> <상호일부>
// 예) PUBLIC_API_KEY=abcd... node server/test-key.mjs 6510000 김밥
import { handle, makeMemoryStore } from './src/worker.js';

const key = process.env.PUBLIC_API_KEY;
const region = process.argv[2] || '6510000';   // 기본: 제주시
const q = process.argv[3] || '';

if (!key) {
  console.error('❌ 인증키가 없습니다.\n사용법: PUBLIC_API_KEY=<Decoding키> node server/test-key.mjs <지역코드> <상호>');
  process.exit(1);
}

const env = { PUBLIC_API_KEY: key };
const store = makeMemoryStore();
const url = 'http://x/api/restaurants?region=' + encodeURIComponent(region) + '&q=' + encodeURIComponent(q);
const res = await handle(new Request(url), env, store);
const data = await res.json();

if (!res.ok || !Array.isArray(data)) {
  console.error('❌ 오류:', (data && data.error) || res.status);
  console.error('   (인증키가 Decoding 키가 맞는지, 지역코드가 맞는지 확인하세요)');
  process.exit(1);
}

console.log(`✅ 검색 성공 — ${data.length}건 (지역 ${region}${q ? ', 상호 "' + q + '"' : ''})\n`);
for (const r of data.slice(0, 10)) {
  console.log(`  • ${r.name}  [${r.restaurant_id}]`);
  console.log(`    ${r.address}  (${r.status})`);
}
if (!data.length) console.log('  (결과 없음 — 지역코드나 상호를 바꿔보세요)');
