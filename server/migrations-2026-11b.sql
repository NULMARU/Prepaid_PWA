-- 2026-11 두 번째 마이그레이션(beta.60 — 서버 보강 S-4~S-14, 2026-11-16). 이 파일도 append-only다
-- (CLAUDE.md "새 릴리스는 새 파일" — 같은 달의 beta.55 파일 migrations-2026-11.sql은 건드리지 않는다).
-- 전부 **추가만**이다(새 표·새 컬럼·새 인덱스). 기존 행을 고치거나 지우는 문장은 없다.
--
-- A. 챌린지의 발급 키 — auth_challenge.pk (S-6, PROTOCOL §4.1)
--    새 서버의 /api/challenge가 이 컬럼에 쓰고 소유 증명이 이 컬럼을 읽는다 → **서버 배포 전에** 적용(없으면 챌린지 발급이 500 —
--    승인·백업·해제·연락처가 전부 막힌다).
-- B. 인수 전 옛 백업 보관 칸 — ledger_backup_archive · ledger_backup_archive_seg · archive_challenge (S-5, PROTOCOL §4.14)
--    다른 열쇠 인수가 이 표에 옮겨 쓴다(인수 배치 전체가 실패하면 인수가 500). cron(일일 8단계)도 읽는다.
-- C. 도메인별 지문 확인 기록 — agency_keycheck_dom (S-12, PROTOCOL §4.8)
--    /api/agency/keycheck(s)가 읽고 쓴다(없으면 담당자 웹의 지문 확인이 500).
--
-- ⚠️ 실행 방법(운영 함정): `--file`은 오류 2036 → **반드시 `--command`로 아래 문장을 하나씩**(문 1~7 순서대로):
--      cd server && npx wrangler d1 execute prepaid-relay --remote --command "<문 N>"
-- ⚠️ 실행 순서: 1) 문 1~7 **모두** 적용 → 2) cd server && npx wrangler deploy(wrangler.toml cron이 매시로 바뀐다) → 3) 앱.
--    문 2~7은 IF NOT EXISTS라 재실행해도 안전하다. 문 1(ALTER)을 다시 실행하면 duplicate column 오류 — 정상(이미 적용됨).
ALTER TABLE auth_challenge ADD COLUMN pk TEXT;
CREATE TABLE IF NOT EXISTS ledger_backup_archive (archive_id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, public_key TEXT NOT NULL, deregistered_at INTEGER NOT NULL, archived_at INTEGER NOT NULL, blob TEXT, blob_hash TEXT, updated_at INTEGER, gen TEXT);
CREATE INDEX IF NOT EXISTS idx_archive_restaurant ON ledger_backup_archive(restaurant_id, archived_at);
CREATE TABLE IF NOT EXISTS ledger_backup_archive_seg (archive_id TEXT NOT NULL, gen TEXT NOT NULL, seg_no INTEGER NOT NULL, blob TEXT NOT NULL, blob_hash TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (archive_id, gen, seg_no));
CREATE TABLE IF NOT EXISTS archive_challenge (archive_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_archive_challenge ON archive_challenge(archive_id, token_hash);
CREATE TABLE IF NOT EXISTS agency_keycheck_dom (agency_domain TEXT NOT NULL, institution TEXT NOT NULL, department TEXT NOT NULL, restaurant_id TEXT NOT NULL, fingerprint TEXT NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (agency_domain, institution, department, restaurant_id));
