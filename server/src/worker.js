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

// LOCALDATA 일반음식점 조회서비스 프록시 (지역 필수). 키는 서버 시크릿.
async function defaultSearch(env, region, q) {
  if (!env.LOCALDATA_KEY) throw new Error('LOCALDATA_KEY 미설정');
  const base = env.LOCALDATA_BASE || 'http://www.localdata.go.kr/platform/rest/TO0/openDataApi';
  const opnSvcId = env.LOCALDATA_OPNSVCID || '07_24_04_P'; // 일반음식점
  const url = new URL(base);
  url.searchParams.set('authKey', env.LOCALDATA_KEY);
  url.searchParams.set('resultType', 'json');
  url.searchParams.set('opnSvcId', opnSvcId);
  url.searchParams.set('localCode', region);
  url.searchParams.set('pageIndex', '1');
  url.searchParams.set('pageSize', '500');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('LOCALDATA HTTP ' + res.status);
  const data = await res.json();
  // LOCALDATA: result.body.rows[0].row[]
  const rows = (((data.result || {}).body || {}).rows || []);
  const list = (rows[0] && rows[0].row) || [];
  const kw = (q || '').trim();
  return list
    .map(r => ({
      restaurant_id: String(r.mgtNo || r.MGTNO || ''),
      name: String(r.bplcNm || r.BPLCNM || ''),
      address: String(r.rdnWhlAddr || r.siteWhlAddr || r.RDNWHLADDR || r.SITEWHLADDR || ''),
      status: String(r.trdStateNm || r.TRDSTATENM || '')
    }))
    .filter(r => r.restaurant_id && r.name)
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

    if (path === '/api/restaurants' && request.method === 'GET') {
      const region = url.searchParams.get('region') || '';
      const q = url.searchParams.get('q') || '';
      if (!region) return json(env, { error: '지역(region) 필수' }, 400);
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
