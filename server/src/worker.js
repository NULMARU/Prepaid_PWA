// 중계 서버 (Cloudflare Worker). 스펙 §1.1·§2.2. 개인정보 평문 미저장·미로깅.
// 핵심 로직은 store 인터페이스에 의존 → D1(운영)과 메모리(테스트)에서 동일 동작.

const CORS = env => ({
  'Access-Control-Allow-Origin': (env && env.ALLOW_ORIGIN) || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
});
const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS(env) } });

function uuid() {
  return (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// 공공 음식점 조회서비스 프록시 (지역 필수). 키는 서버 시크릿.
// 기본값: data.go.kr 행정안전부_식품_일반음식점 조회서비스(apis.data.go.kr/1741000/general_restaurants).
// serviceKey 는 반드시 "Decoding(일반)" 키를 사용(URL 재인코딩 이중처리 방지).
function extractRows(data) {
  // data.go.kr 표준: response.body.items.item[]
  const b = data && data.response && data.response.body;
  if (b && b.items) { const it = b.items.item != null ? b.items.item : b.items; return Array.isArray(it) ? it : (it ? [it] : []); }
  // LOCALDATA: result.body.rows[0].row[]
  const ld = data && data.result && data.result.body && data.result.body.rows;
  if (Array.isArray(ld)) return (ld[0] && ld[0].row) || [];
  // 배열 그대로
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}
function pick(r, keys) { for (const k of keys) { if (r[k] != null && String(r[k]).trim() !== '') return String(r[k]); } return ''; }
async function defaultSearch(env, region, q) {
  // data.go.kr 행정안전부_식품_일반음식점 조회서비스 /info 오퍼레이션.
  // cond[OPN_ATMY_GRP_CD::EQ]=개방자치단체코드(지역), cond[BPLC_NM::LIKE]=사업장명 검색.
  const key = env.PUBLIC_API_KEY || env.LOCALDATA_KEY;
  if (!key) throw new Error('PUBLIC_API_KEY 미설정');
  const base = env.PUBLIC_API_BASE || 'https://apis.data.go.kr/1741000/general_restaurants/info';
  const regionParam = env.PUBLIC_API_REGION_PARAM || 'cond[OPN_ATMY_GRP_CD::EQ]';
  const nameParam = env.PUBLIC_API_NAME_PARAM || 'cond[BPLC_NM::LIKE]';
  // cond[...] 파라미터명은 브래킷을 리터럴로 유지하고 값만 인코딩(값에 serviceKey +,/,= 포함 가능).
  const params = [['serviceKey', key], ['pageNo', '1'], ['numOfRows', '100'], ['returnType', 'json']];
  if (region) params.push([regionParam, region]);
  if (q) params.push([nameParam, q]);
  const qs = params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const res = await fetch(base + '?' + qs);
  if (!res.ok) throw new Error('공공API HTTP ' + res.status);
  const data = await res.json();
  const hdr = data && data.response && data.response.header;
  if (hdr && hdr.resultCode != null && !['0', '00'].includes(String(hdr.resultCode)))
    throw new Error('공공API 오류: ' + (hdr.resultMsg || hdr.resultCode));
  const rows = extractRows(data);
  const kw = (q || '').trim();
  return rows
    .map(r => ({
      // 행정안전부_식품_일반음식점 조회서비스 실제 필드 우선, LOCALDATA 변형 후순위
      restaurant_id: pick(r, ['MNG_NO', 'mgtNo', 'MGTNO', '관리번호']),
      name: pick(r, ['BPLC_NM', 'bplcNm', 'BPLCNM', '사업장명']),
      address: pick(r, ['ROAD_NM_ADDR', 'LOTNO_ADDR', 'rdnWhlAddr', 'siteWhlAddr', '소재지전체주소']),
      status: pick(r, ['SALS_STTS_NM', 'DTL_SALS_STTS_NM', 'trdStateNm', '영업상태명']),
      category: pick(r, ['BZSTAT_SE_NM', 'SNTTN_BZSTAT_NM']),
      region_code: pick(r, ['OPN_ATMY_GRP_CD'])
    }))
    .filter(r => r.restaurant_id && r.name)
    .filter(r => !r.status.includes('폐업'))   // 영업 중인 곳만
    .filter(r => !kw || r.name.includes(kw));
}

export async function handle(request, env, store) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(env) });

  try {
    if (path === '/api/register-key' && request.method === 'POST') {
      const b = await request.json();
      if (!b.restaurant_id || !b.public_key) return json(env, { error: 'restaurant_id·public_key 필요' }, 400);
      await store.registerKey({
        restaurant_id: String(b.restaurant_id),
        restaurant_name: String(b.restaurant_name || ''),
        public_key: String(b.public_key),
        registered_at: Date.now()
      });
      return json(env, { ok: true });
    }

    if (path === '/api/public-key' && request.method === 'GET') {
      const id = url.searchParams.get('restaurant_id') || '';
      const row = await store.getPublicKey(id);
      if (!row) return json(env, { error: '등록된 공개키 없음' }, 404);
      return json(env, { restaurant_id: row.restaurant_id, public_key: row.public_key });
    }

    // 음식점 주인 등록 해제 (선금 받기 중단). 공개키 삭제 → 담당자가 더는 전송 불가.
    if (path === '/api/deregister' && request.method === 'POST') {
      const b = await request.json();
      if (!b.restaurant_id) return json(env, { error: 'restaurant_id 필요' }, 400);
      await store.deregisterKey(String(b.restaurant_id));
      return json(env, { ok: true });
    }

    // 담당자 웹: 후보 음식점 중 '선금 받기 가능(등록된)' 목록만 반환.
    if (path === '/api/registered' && request.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      return json(env, await store.registeredAmong(ids));
    }

    if (path === '/api/restaurants' && request.method === 'GET') {
      const region = url.searchParams.get('region') || '';
      const q = url.searchParams.get('q') || '';
      if (!region && !q) return json(env, { error: '지역 또는 가게 이름이 필요합니다' }, 400);
      const search = env.searchRestaurants || defaultSearch;
      const list = await search(env, region, q);
      return json(env, list);
    }

    if (path === '/api/submit' && request.method === 'POST') {
      const b = await request.json();
      const s = b.summary, blob = b.blob, consent = b.consent;
      if (!s || !blob || !blob.ciphertext) return json(env, { error: 'summary·blob 필요' }, 400);
      // 평문 PII 방어: ciphertext는 객체(암호 blob)여야 하며, 알려진 평문 필드가 오면 거부
      if (typeof blob.ciphertext !== 'object' || !blob.ciphertext.ct || !blob.ciphertext.encKey)
        return json(env, { error: 'ciphertext 형식 오류(암호 blob 아님)' }, 400);
      const summary_id = uuid();
      await store.insertSummary({
        id: summary_id,
        institution: String(s.institution || ''), department: String(s.department || ''),
        restaurant_id: String(s.restaurant_id || ''), restaurant_name: String(s.restaurant_name || ''),
        year_month: String(s.year_month || ''),
        total_amount: Number(s.total_amount) | 0, member_count: Number(s.member_count) | 0,
        batch_hash: String(s.batch_hash || ''), status: 'PENDING', created_at: Date.now()
      });
      await store.insertBlob({
        id: uuid(), summary_id, restaurant_id: String(blob.restaurant_id || s.restaurant_id || ''),
        ciphertext: JSON.stringify(blob.ciphertext), delivered: 0, created_at: Date.now()
      });
      if (consent) await store.insertConsent({
        id: uuid(), institution: String(consent.institution || ''),
        department: String(consent.department || ''), year_month: String(consent.year_month || ''),
        consented_at: Date.now()
      });
      return json(env, { summary_id });
    }

    if (path === '/api/inbox' && request.method === 'GET') {
      const id = url.searchParams.get('restaurant_id') || '';
      if (!id) return json(env, { error: 'restaurant_id 필요' }, 400);
      const items = await store.inbox(id);
      return json(env, items);
    }

    if (path === '/api/approve' && request.method === 'POST') {
      const b = await request.json();
      const status = b.status === 'APPROVED' ? 'APPROVED' : b.status === 'REJECTED' ? 'REJECTED' : null;
      if (!b.summary_id || !status) return json(env, { error: 'summary_id·status 필요' }, 400);
      await store.setStatus(String(b.summary_id), status);
      if (status === 'APPROVED') await store.markDelivered(String(b.summary_id));
      return json(env, { ok: true });
    }

    return json(env, { error: 'not found' }, 404);
  } catch (e) {
    return json(env, { error: String((e && e.message) || e) }, 500);
  }
}

// ── D1 store (운영) ──
export function makeD1Store(DB) {
  return {
    async registerKey(r) {
      await DB.prepare('INSERT INTO public_key_registry (restaurant_id,restaurant_name,public_key,registered_at) VALUES (?,?,?,?) ON CONFLICT(restaurant_id) DO UPDATE SET restaurant_name=excluded.restaurant_name, public_key=excluded.public_key, registered_at=excluded.registered_at')
        .bind(r.restaurant_id, r.restaurant_name, r.public_key, r.registered_at).run();
    },
    async getPublicKey(id) {
      return await DB.prepare('SELECT restaurant_id,public_key FROM public_key_registry WHERE restaurant_id=?').bind(id).first();
    },
    async deregisterKey(id) {
      await DB.prepare('DELETE FROM public_key_registry WHERE restaurant_id=?').bind(id).run();
    },
    async registeredAmong(ids) {
      if (!ids.length) return [];
      const ph = ids.map(() => '?').join(',');
      const r = await DB.prepare('SELECT restaurant_id FROM public_key_registry WHERE restaurant_id IN (' + ph + ')').bind(...ids).all();
      return (r.results || []).map(x => x.restaurant_id);
    },
    async insertSummary(s) {
      await DB.prepare('INSERT INTO deposit_summary (id,institution,department,restaurant_id,restaurant_name,year_month,total_amount,member_count,batch_hash,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(s.id, s.institution, s.department, s.restaurant_id, s.restaurant_name, s.year_month, s.total_amount, s.member_count, s.batch_hash, s.status, s.created_at).run();
    },
    async insertBlob(b) {
      await DB.prepare('INSERT INTO encrypted_blob (id,summary_id,restaurant_id,ciphertext,delivered,created_at) VALUES (?,?,?,?,?,?)')
        .bind(b.id, b.summary_id, b.restaurant_id, b.ciphertext, b.delivered, b.created_at).run();
    },
    async insertConsent(c) {
      await DB.prepare('INSERT INTO consent_log (id,institution,department,year_month,consented_at) VALUES (?,?,?,?,?)')
        .bind(c.id, c.institution, c.department, c.year_month, c.consented_at).run();
    },
    async inbox(restaurant_id) {
      const r = await DB.prepare("SELECT s.id as summary_id, s.institution, s.department, s.restaurant_id, s.restaurant_name, s.year_month, s.total_amount, s.member_count, s.batch_hash, s.status, b.ciphertext FROM deposit_summary s JOIN encrypted_blob b ON b.summary_id=s.id WHERE s.restaurant_id=? AND s.status='PENDING' ORDER BY s.created_at").bind(restaurant_id).all();
      return (r.results || []).map(row => ({
        summary_id: row.summary_id,
        summary: { institution: row.institution, department: row.department, restaurant_id: row.restaurant_id, restaurant_name: row.restaurant_name, year_month: row.year_month, total_amount: row.total_amount, member_count: row.member_count, batch_hash: row.batch_hash },
        ciphertext: JSON.parse(row.ciphertext), status: row.status
      }));
    },
    async setStatus(summary_id, status) {
      await DB.prepare('UPDATE deposit_summary SET status=? WHERE id=?').bind(status, summary_id).run();
    },
    async markDelivered(summary_id) {
      await DB.prepare('UPDATE encrypted_blob SET delivered=1 WHERE summary_id=?').bind(summary_id).run();
    }
  };
}

// Cloudflare 진입점
export default {
  async fetch(request, env) {
    return handle(request, env, makeD1Store(env.DB));
  }
};

// ── 메모리 store (테스트) ──
export function makeMemoryStore() {
  const keys = new Map(), summaries = [], blobs = [], consents = [];
  return {
    _dump: () => ({ keys, summaries, blobs, consents }),
    async registerKey(r) { keys.set(r.restaurant_id, r); },
    async getPublicKey(id) { return keys.get(id) || null; },
    async deregisterKey(id) { keys.delete(id); },
    async registeredAmong(ids) { return ids.filter(id => keys.has(id)); },
    async insertSummary(s) { summaries.push(s); },
    async insertBlob(b) { blobs.push(b); },
    async insertConsent(c) { consents.push(c); },
    async inbox(restaurant_id) {
      return summaries.filter(s => s.restaurant_id === restaurant_id && s.status === 'PENDING').map(s => {
        const b = blobs.find(x => x.summary_id === s.id);
        return { summary_id: s.id, summary: { institution: s.institution, department: s.department, restaurant_id: s.restaurant_id, restaurant_name: s.restaurant_name, year_month: s.year_month, total_amount: s.total_amount, member_count: s.member_count, batch_hash: s.batch_hash }, ciphertext: b ? JSON.parse(b.ciphertext) : null, status: s.status };
      });
    },
    async setStatus(id, status) { const s = summaries.find(x => x.id === id); if (s) s.status = status; },
    async markDelivered(id) { const b = blobs.find(x => x.summary_id === id); if (b) b.delivered = 1; }
  };
}
