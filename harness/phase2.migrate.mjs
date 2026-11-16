// 라이브 스키마 + 마이그레이션 문장 조합 검증(beta.60).
//
// phase2.e2e.mjs의 node:sqlite 어댑터는 **새 schema.sql을 통째로** 적재하므로 "지금 라이브 D1(옛 스키마 + 쌓인 행) 위에
// migrations-2026-11b.sql을 한 문장씩 실행한 DB"는 검증하지 않는다. 이 하니스가 그 조합을 본다:
//   ① 라이브 태그(기본 live-beta59)의 server/schema.sql을 git에서 꺼내 적재 — HEAD가 바뀌어도 같은 기준
//   ② 라이브에 있을 법한 행을 심는다: v1 머리(gen NULL) 가게, v2 머리+조각 가게, pk 없는 미사용 챌린지,
//      도메인이 적힌 옛 agency_keycheck 행, 처리 대기 명단(+암호문)
//   ③ migrations-2026-11b.sql을 **파일에서 읽어 한 문장씩** 실행(운영 방식 `--command` 그대로), 문 1 재실행 = duplicate column
//   ④ 새 schema.sql의 모든 표·컬럼·인덱스가 마이그레이션된 DB에 있는지
//   ⑤ 새 worker.js로 beta.59 앱식 호출(토큰 없는 재등록·seg_count 없는 머리 등)과 beta.60 새 호출이 통하는지, cron이 오류 없이 도는지
//
// 실행: node harness/phase2.migrate.mjs          (기준 태그를 바꾸려면 MIGRATE_BASE_REF=live-beta60 등)
// 네트워크·wrangler·라이브 서버 호출 없음(공공데이터는 '장애' 목, Resend는 fetch 스텁).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import worker, { handle, makeD1Store } from '../server/src/worker.js';

const REPO = new URL('..', import.meta.url).pathname;
const BASE_REF = process.env.MIGRATE_BASE_REF || 'live-beta59';
const MIG_FILE = new URL('../server/migrations-2026-11b.sql', import.meta.url);
const NEW_SCHEMA = new URL('../server/schema.sql', import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + m); };

let sqlite;
try { sqlite = await import('node:sqlite'); } catch (_) {
  console.log('⚠️  node:sqlite를 쓸 수 없는 Node 버전(' + process.version + ') — 이 하니스는 Node 22.5+가 필요하다');
  process.exit(1);
}

const subtle = globalThis.crypto.subtle, encU = new TextEncoder(), decU = new TextDecoder();
const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64')).buffer;
const sha = async (s) => Buffer.from(await subtle.digest('SHA-256', encU.encode(s))).toString('hex');
const genKey = () => subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
const spkiOf = async (kp) => b64(await subtle.exportKey('spki', kp.publicKey));

// ── node:sqlite → D1 바인딩 흉내(phase2.e2e.mjs와 같은 규칙: 문장당 바인딩 100개 상한, batch는 한 트랜잭션) ──
function makeD1(db) {
  const stmt = (sql, args) => {
    if (args.length > 100) throw new Error('D1 바인딩 상한 초과: ' + args.length);
    const runSync = () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; };
    return {
      bind: (...a) => stmt(sql, a),
      first: async (col) => { const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
      all: async () => ({ success: true, results: db.prepare(sql).all(...args).map(r => ({ ...r })), meta: {} }),
      run: async () => runSync(),
      _runSync: runSync
    };
  };
  return {
    prepare: (sql) => stmt(sql, []),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._runSync()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
}

// ── ① 라이브 기준 스키마 ──
let oldSchema;
try { oldSchema = execFileSync('git', ['show', BASE_REF + ':server/schema.sql'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) {
  console.log('❌ git show ' + BASE_REF + ':server/schema.sql 실패 — 태그가 없으면 `git fetch --tags` 또는 MIGRATE_BASE_REF로 기준을 지정');
  process.exit(1);
}
const db = new sqlite.DatabaseSync(':memory:');
db.exec(oldSchema);
const colsOf = (d, tbl) => d.prepare('PRAGMA table_info(' + tbl + ')').all().map(c => c.name);
ok(!colsOf(db, 'auth_challenge').includes('pk') && colsOf(db, 'ledger_backup').includes('gen'),
  '기준(' + BASE_REF + ') 스키마 적재 — auth_challenge.pk 없음(마이그레이션 전), ledger_backup.gen 있음(beta.55 -11.sql 반영분)');

// ── ② 라이브에 있을 법한 행 ──
const now = Date.now(), DAY = 864e5;
const A = '3040000-101-2099-90001', B = '3040000-101-2099-90002', C = '3040000-101-2099-90003';
const kA = await genKey(), kB = await genKey(), kB2 = await genKey(), kC = await genKey();
const pkA = await spkiOf(kA), pkB = await spkiOf(kB), pkB2 = await spkiOf(kB2), pkC = await spkiOf(kC);
const regRow = db.prepare('INSERT INTO public_key_registry (restaurant_id,restaurant_name,public_key,registered_at,district,verified) VALUES (?,?,?,?,?,0)');
regRow.run(A, '시험가게가', pkA, now - 100 * DAY, '서울특별시 광진구');
regRow.run(B, '시험가게나', pkB, now - 90 * DAY, '서울특별시 광진구');
regRow.run(C, '시험가게다', pkC, now - 80 * DAY, null); // 관할 미채움(레거시) — 토큰 없는 치유 대상
// A = v1 머리(gen NULL, 한 덩어리), B = v2 머리 + 조각 2개
db.prepare('INSERT INTO ledger_backup (restaurant_id,blob,blob_hash,updated_at,gen) VALUES (?,?,?,?,NULL)').run(A, 'V1BLOB'.repeat(1000), 'h1', now - 3 * DAY);
db.prepare('INSERT INTO ledger_backup (restaurant_id,blob,blob_hash,updated_at,gen) VALUES (?,?,?,?,?)').run(B, 'HEADB', 'hb', now - 3 * DAY, 'gOLDGEN0001');
for (const n of [0, 1]) db.prepare('INSERT INTO ledger_backup_seg (restaurant_id,gen,seg_no,blob,blob_hash,updated_at) VALUES (?,?,?,?,?,?)').run(B, 'gOLDGEN0001', n, 'S'.repeat(57000), 'sh' + n, now - 3 * DAY);
// 옛 서버가 발급한 미사용 챌린지(pk 컬럼 없음 → 마이그레이션 뒤 NULL). 앱이 이미 복호화해 들고 있는 토큰이라고 가정.
const oldTok = 'OLDTOKEN-before-migration';
db.prepare('INSERT INTO auth_challenge (restaurant_id,token_hash,expires_at) VALUES (?,?,?)').run(A, await sha(oldTok), now + 4 * 60e3);
// 담당자가 이미 확인한 지문(옛 표, 도메인 있음) — 지문 값은 실제 공개키에서 얻는다(아래 ⑤에서 대조).
// 처리 대기 명단 + 암호문
db.prepare("INSERT INTO deposit_summary (id,institution,department,restaurant_id,restaurant_name,year_month,total_amount,member_count,batch_hash,dedupe_key,status,created_at) VALUES ('mig-sum1','광진구청','재무과',?,'시험가게가','2026-11',90000,1,'bh','sid:mig-1','PENDING',?)").run(A, now - 3600e3);
db.prepare("INSERT INTO encrypted_blob (id,summary_id,restaurant_id,ciphertext,created_at) VALUES ('mig-blob1','mig-sum1',?,'{}',?)").run(A, now - 3600e3);

// ── ③ 마이그레이션 문장을 파일에서 읽어 한 문장씩 ──
const migStmts = fs.readFileSync(MIG_FILE, 'utf8').split('\n')
  .filter(l => l.trim() && !l.trim().startsWith('--')).join('\n')
  .split(';').map(s => s.trim()).filter(Boolean);
ok(migStmts.length === 7, 'migrations-2026-11b.sql 실행 문장 7개(실제 ' + migStmts.length + ')');
let migErr = null;
for (const [i, s] of migStmts.entries()) { try { db.exec(s); } catch (e) { migErr = '문 ' + (i + 1) + ': ' + e.message; break; } }
ok(!migErr, '옛 스키마 + 기존 행 위에 7문을 순서대로 한 문장씩 실행 — 오류 없음' + (migErr ? ' (' + migErr + ')' : ''));
let dup = false;
try { db.exec(migStmts[0]); } catch (e) { dup = /duplicate column/i.test(e.message); }
ok(dup, '문 1(ALTER) 재실행은 duplicate column 오류(운영 문서대로 — 이미 적용됨)');
let rerunErr = null;
for (const s of migStmts.slice(1)) { try { db.exec(s); } catch (e) { rerunErr = e.message; } }
ok(!rerunErr, '문 2~7 재실행은 오류 없음(IF NOT EXISTS)' + (rerunErr ? ' (' + rerunErr + ')' : ''));
// 이후는 예외(컬럼·표 없음 등)도 실패 1건으로 세고 결과를 찍는다.
try {
ok(db.prepare('SELECT pk FROM auth_challenge WHERE restaurant_id=?').get(A).pk === null
  && db.prepare('SELECT COUNT(*) c FROM ledger_backup_seg').get().c === 2
  && db.prepare('SELECT COUNT(*) c FROM public_key_registry').get().c === 3,
  '마이그레이션은 기존 행을 고치거나 지우지 않음(옛 챌린지 pk=NULL, 조각·가게 행 그대로)');

// ── ④ 새 schema.sql의 표·컬럼·인덱스가 모두 있는가 ──
const ref = new sqlite.DatabaseSync(':memory:');
ref.exec(fs.readFileSync(NEW_SCHEMA, 'utf8'));
const objs = (d, type) => d.prepare("SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%'").all(type).map(r => r.name);
const missing = [];
for (const t of objs(ref, 'table')) {
  if (!objs(db, 'table').includes(t)) { missing.push('표 ' + t); continue; }
  const have = colsOf(db, t);
  for (const c of colsOf(ref, t)) if (!have.includes(c)) missing.push(t + '.' + c);
}
for (const ix of objs(ref, 'index')) if (!objs(db, 'index').includes(ix)) missing.push('인덱스 ' + ix);
ok(missing.length === 0, '마이그레이션된 라이브 DB ⊇ 새 schema.sql(표·컬럼·인덱스)' + (missing.length ? ' — 빠짐: ' + missing.join(', ') : ''));

// ── ⑤ 새 worker.js로 호출 ──
const store = makeD1Store(makeD1(db));
const env = { ALLOW_ORIGIN: '*', REQUIRE_AGENCY_AUTH: '1', AUTH_MODE: 'dev', searchRestaurants: async () => { throw new Error('공공API 장애(목)'); } };
const call = (method, path, body, headers, e = env) => handle(new Request('http://x' + path, {
  method, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined
}), e, store);
const jsonOf = async (r) => { try { return await r.json(); } catch (_) { return {}; } };
const tok = async (rid, kp) => {
  const r = await call('POST', '/api/challenge', { restaurant_id: rid });
  if (r.status !== 200) return 'no-token-' + r.status;
  const { challenge_ct } = await r.json();
  return decU.decode(await subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, unb64(challenge_ct)));
};
let r, jb;

// beta.59 앱식 호출
r = await call('GET', '/api/inbox?restaurant_id=' + A + '&auth_token=' + encodeURIComponent(oldTok));
ok(r.status === 200, 'beta.59: 마이그레이션 전에 발급된(pk NULL) 토큰으로 수신함 200 (실제 ' + r.status + ')');
r = await call('GET', '/api/inbox?restaurant_id=' + A + '&auth_token=' + encodeURIComponent(await tok(A, kA)));
jb = await jsonOf(r);
ok(r.status === 200 && JSON.stringify(jb).includes('mig-sum1'), 'beta.59: 새 챌린지(pk 기록)로 수신함 200 — 처리 대기 명단 보임');
r = await call('POST', '/api/challenge', { restaurant_id: A });
ok(r.status === 200 && db.prepare('SELECT COUNT(*) c FROM auth_challenge WHERE restaurant_id=? AND pk=?').get(A, pkA).c >= 1,
  '새 챌린지 발급이 pk 컬럼(문 1)에 발급 키를 씀');
r = await call('POST', '/api/approve', { summary_id: 'mig-sum1', status: 'APPROVED', restaurant_id: A, auth_token: await tok(A, kA) });
ok(r.status === 200 && !db.prepare("SELECT 1 FROM encrypted_blob WHERE summary_id='mig-sum1'").get(), 'beta.59: 승인 200 + 암호문 삭제');
r = await call('POST', '/api/approve', { summary_id: 'mig-sum1', status: 'APPROVED', restaurant_id: A, auth_token: await tok(A, kA) });
ok(r.status === 409, 'beta.59: 같은 명단 재승인 409(통보 재시도 경로)');
r = await call('POST', '/api/ledger-backup/get', { restaurant_id: A, auth_token: await tok(A, kA) });
jb = await jsonOf(r);
ok(r.status === 200 && String(jb.blob || '').startsWith('V1BLOB'), 'beta.59: v1 머리(gen NULL) 가게의 백업 get 200');
r = await call('POST', '/api/ledger-backup/seg/list', { restaurant_id: A, auth_token: await tok(A, kA) });
ok(r.status === 200, 'beta.59: v1 가게 seg/list 200');
let segOk = true;
for (const n of [0, 1]) {
  r = await call('POST', '/api/ledger-backup/seg', { restaurant_id: A, auth_token: await tok(A, kA), gen: 'gNEWA000001', seg_no: n, blob: 'Q'.repeat(57000), blob_hash: 'q' + n });
  if (r.status !== 200) segOk = false;
}
ok(segOk, 'beta.59: v1 가게가 v2 조각 2개 업로드 200(verified=0 — 미확인 할당량 안)');
r = await call('POST', '/api/ledger-backup', { restaurant_id: A, auth_token: await tok(A, kA), blob: 'HEADA', blob_hash: 'ha', gen: 'gNEWA000001' });
ok(r.status === 200 && db.prepare('SELECT gen FROM ledger_backup WHERE restaurant_id=?').get(A).gen === 'gNEWA000001',
  'beta.59: seg_count 없는 v2 머리 200(머리 gen 갱신)');
r = await call('POST', '/api/ledger-backup/seg', { restaurant_id: B, auth_token: await tok(B, kB), gen: 'gOLDGEN0001', seg_no: 1, blob: 'T'.repeat(58000), blob_hash: 'th' });
const rB = await call('POST', '/api/ledger-backup', { restaurant_id: B, auth_token: await tok(B, kB), blob: 'HEADB2', blob_hash: 'hb2', gen: 'gOLDGEN0001' });
ok(r.status === 200 && rB.status === 200 && db.prepare("SELECT COUNT(*) c FROM ledger_backup_seg WHERE restaurant_id=? AND gen='gOLDGEN0001'").get(B).c === 2,
  'beta.59: v2 가게가 같은 세대의 열린 조각 갱신 + 머리 200(조각 2개 유지)');
r = await call('POST', '/api/ledger-backup/seg/get', { restaurant_id: B, auth_token: await tok(B, kB), gen: 'gOLDGEN0001', seg_nos: [0, 1] });
jb = await jsonOf(r);
ok(r.status === 200 && (jb.segments || []).length === 2, 'beta.59: 기존 조각 seg/get 200');
r = await call('POST', '/api/register-key', { restaurant_id: C, restaurant_name: '시험가게다', public_key: pkC, district: '서울특별시 광진구' });
ok(r.status === 200 && db.prepare('SELECT district FROM public_key_registry WHERE restaurant_id=?').get(C).district != null,
  'beta.59: 토큰 없는 같은 키 재등록으로 비어 있던 관할 치유 200');
r = await call('POST', '/api/register-key', { restaurant_id: A, restaurant_name: '시험가게가', public_key: pkA, district: '서울특별시 광진구' });
ok(r.status === 200, 'beta.59: 토큰 없는 같은 키·같은 관할 재등록 200(멱등)');
r = await call('POST', '/api/deregister', { restaurant_id: A, auth_token: await tok(A, kA) });
ok(r.status === 200, 'beta.59: 등록 해제 200');
r = await call('POST', '/api/register-key', { restaurant_id: A, restaurant_name: '시험가게가', public_key: pkA, district: '서울특별시 광진구' });
jb = await jsonOf(r);
ok(r.status === 200 && jb.reactivated === true, 'beta.59: 토큰 없는 같은 키·같은 상호 되돌리기 200(구버전 호환)');
r = await call('POST', '/api/ledger-backup/get', { restaurant_id: A, auth_token: await tok(A, kA) });
ok(r.status === 200, 'beta.59: 되돌린 뒤 백업 get 200');

// 담당자: 옛 표(agency_keycheck)의 확인 기록이 새 서버 목록에 그대로 + 새 표(agency_keycheck_dom)에 쓰기
const agTok = 'MIG-AGENCY-TOKEN';
db.prepare('INSERT INTO agency_token (token_hash,email,email_domain,expires_at) VALUES (?,?,?,?)').run(await sha(agTok), 'h', 'gwangjin.go.kr', now + 3600e3);
const AGH = { 'X-Agency-Token': agTok };
r = await call('POST', '/api/agency/keycheck', { institution: '광진구청', department: '재무과', restaurant_id: A, fingerprint: '0000-0000' }, AGH);
const fpA = (await jsonOf(r)).current;
db.prepare('INSERT INTO agency_keycheck (institution,department,restaurant_id,fingerprint,checked_at,agency_domain) VALUES (?,?,?,?,?,?)').run('광진구청', '재무과', A, fpA, now - 10 * DAY, 'gwangjin.go.kr');
r = await call('GET', '/api/agency/keychecks?institution=' + encodeURIComponent('광진구청') + '&department=' + encodeURIComponent('재무과'), undefined, AGH);
jb = await jsonOf(r);
ok(r.status === 200 && (jb.keychecks || []).length === 1 && jb.keychecks[0].fingerprint === fpA, '옛 표(도메인 있음)의 지문 확인 기록이 새 서버 목록에 그대로 보임');
r = await call('POST', '/api/agency/keycheck', { institution: '광진구청', department: '재무과', restaurant_id: B, fingerprint: '0000-0000' }, AGH);
const fpB = (await jsonOf(r)).current;
r = await call('POST', '/api/agency/keycheck', { institution: '광진구청', department: '재무과', restaurant_id: B, fingerprint: fpB }, AGH);
ok(r.status === 200 && db.prepare('SELECT COUNT(*) c FROM agency_keycheck_dom WHERE restaurant_id=?').get(B).c === 1, 'beta.60: 새 지문 확인은 agency_keycheck_dom(문 7)에 기록');

// beta.60 새 호출: seg_count 머리, 다른 열쇠 인수 → 보관 칸(문 2~6), 보관 칸 읽기
for (const n of [0, 1]) await call('POST', '/api/ledger-backup/seg', { restaurant_id: B, auth_token: await tok(B, kB), gen: 'gNEWB000001', seg_no: n, blob: 'U'.repeat(1000), blob_hash: 'u' + n });
r = await call('POST', '/api/ledger-backup', { restaurant_id: B, auth_token: await tok(B, kB), blob: 'HEADB3', blob_hash: 'hb3', gen: 'gNEWB000001', seg_count: 2 });
ok(r.status === 200, 'beta.60: seg_count 실은 머리 200');
r = await call('POST', '/api/deregister', { restaurant_id: B, auth_token: await tok(B, kB) });
const rTk = await call('POST', '/api/register-key', { restaurant_id: B, restaurant_name: '시험가게나', public_key: pkB2, district: '서울특별시 광진구' });
ok(r.status === 200 && rTk.status === 200 && db.prepare('SELECT COUNT(*) c FROM ledger_backup_archive WHERE restaurant_id=?').get(B).c === 1
  && db.prepare('SELECT COUNT(*) c FROM ledger_backup_archive_seg').get().c >= 2,
  'beta.60: 해제된 가게를 다른 열쇠로 인수 200 — 옛 머리·조각이 보관 칸(문 2·4)으로');
r = await call('POST', '/api/ledger-archive/challenge', { restaurant_id: B, public_key: pkB });
jb = await jsonOf(r);
let arcTok = null;
if (r.status === 200) arcTok = decU.decode(await subtle.decrypt({ name: 'RSA-OAEP' }, kB.privateKey, unb64(jb.challenge_ct)));
r = await call('POST', '/api/ledger-archive/get', { restaurant_id: B, public_key: pkB, auth_token: arcTok });
jb = await jsonOf(r);
ok(r.status === 200 && jb.blob === 'HEADB3', 'beta.60: 옛 열쇠로 보관 칸 챌린지(문 6)·읽기 200');

// 인증번호 예산(옛 stats_counter 표에 새 조건부 upsert 문장)
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200 });
try { r = await call('POST', '/api/agency/request-otp', { email: 'mig-otp@gwangjin.go.kr' }, undefined, { ...env, AUTH_MODE: 'prod', RESEND_API_KEY: 'mig', OTP_DAILY_BUDGET: '5' }); }
finally { globalThis.fetch = realFetch; }
ok(r.status === 200 && db.prepare("SELECT count FROM stats_counter WHERE name LIKE 'otp_sent_%'").get().count === 1, 'beta.60: 인증번호 예약(조건부 upsert)이 옛 stats_counter 표에서 동작');

// cron: 매시(미수령 만료만)·일일 전체 정리가 오류 없이
const logO = console.log, errO = console.error;
const errs = [];
console.log = () => {}; console.error = (...a) => errs.push(a.join(' '));
try {
  const waits = [];
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-16T05:17:00Z'), cron: '17 * * * *' }, { DB: makeD1(db) }, { waitUntil: (p) => waits.push(p) });
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-16T18:17:00Z'), cron: '17 * * * *' }, { DB: makeD1(db) }, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
} finally { console.log = logO; console.error = errO; }
ok(errs.length === 0, '매시 cron·일일 정리(보관 칸 정리 8단계 포함)가 마이그레이션된 DB에서 오류 없이' + (errs.length ? ' — ' + errs.join(' | ') : ''));
const cr = await store.cleanupTTL(Date.now() + 31 * DAY);
ok(Array.isArray(cr.errors) && cr.errors.length === 0 && cr.archivesPurged === 1, '31일 뒤 일일 정리: 오류 0, 보관 칸 1건 정리');

} catch (e) { ok(false, '예외로 중단됨: ' + ((e && e.message) || e)); }

console.log(`\n결과: ${pass} 통과, ${fail} 실패 (기준 ${BASE_REF} + migrations-2026-11b.sql)`);
process.exit(fail ? 1 : 0);
