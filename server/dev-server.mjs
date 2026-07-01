// 로컬 개발용 중계 서버 (Cloudflare 없이 Worker 로직 그대로 실행).
// 메모리 저장 + 목 검색. 실제 data.go.kr 키가 있으면 PUBLIC_API_KEY 환경변수로 실호출.
//   node server/dev-server.mjs            # 목 검색
//   PUBLIC_API_KEY=<Decoding키> node server/dev-server.mjs   # 실제 검색
import http from 'node:http';
import { handle, makeMemoryStore } from './src/worker.js';

const store = makeMemoryStore();
const env = {
  ALLOW_ORIGIN: '*',
  PUBLIC_API_KEY: process.env.PUBLIC_API_KEY || '',
  PUBLIC_API_BASE: process.env.PUBLIC_API_BASE,
  PUBLIC_API_REGION_PARAM: process.env.PUBLIC_API_REGION_PARAM,
  PUBLIC_API_NAME_PARAM: process.env.PUBLIC_API_NAME_PARAM
};
if (!env.PUBLIC_API_KEY) {
  env.searchRestaurants = async (_e, region, q) =>
    [{ restaurant_id: 'MGT-0001', name: '정식김밥', address: '서울 강남구 1', status: '영업/정상' },
     { restaurant_id: 'MGT-0002', name: '한밭식당', address: '서울 강남구 2', status: '영업/정상' }]
      .filter(r => region && (!q || r.name.includes(q)));
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request('http://localhost' + req.url, {
    method: req.method, headers: req.headers,
    body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body
  });
  const r = await handle(request, env, store);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
const port = process.env.PORT || 8788;
server.listen(port, () => console.log('relay dev server on http://localhost:' + port + (env.LOCALDATA_KEY ? ' (real LOCALDATA)' : ' (mock search)')));
