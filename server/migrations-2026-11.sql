-- 2026-11 마이그레이션(beta.55 — 조각 백업 · 인수 시 옛 백업 보존). 이 파일도 append-only다
-- (2026-07·08·09·10 파일과 마찬가지로 과거 문장을 수정하지 말 것).
--
-- A. 조각 백업 — ledger_backup_seg (PROTOCOL §4.13)
--    장부가 1MB 단일 blob(ledger_backup)에 들어가지 않는 가게를 위해 음식점 앱이 장부를 조각으로 나눠
--    각각 암호화해 올린다. 서버는 내용을 모른다(암호문). 새 엔드포인트 /api/ledger-backup/seg ·
--    /seg/get · /seg/list가 이 테이블을 쓰고, 기존 /api/ledger-backup에 선택 필드 gen이 오면 머리 저장과
--    같은 배치로 다른 세대 조각을 지운다.
-- B. 인수 시각 — public_key_registry.taken_over_at (§4.12)
--    휴지통 가게를 다른 열쇠가 인수해도 옛 원장 백업을 즉시 지우지 않는다. 이 시각보다 먼저 쓰인 백업은
--    새 주인에게 숨기고 30일 뒤 cron이 지운다. 서버 코드(getPublicKey)가 이 컬럼을 SELECT하므로
--    **반드시 서버 배포 전에** 적용해야 한다(없으면 모든 등록 관련 요청이 500).
-- C. 머리의 세대 — ledger_backup.gen (§4.13)
--    조각 백업 머리 업로드에 실려 온 gen을 머리 행에 적는다(v1 머리는 NULL). 고아 조각 정리(cron ⑦·업로드 중
--    상한)가 이 값으로 '머리의 세대'를 정확히 지킨다. 서버 코드(getLedgerBackup·upsertLedgerBackup·cron)가 이 컬럼을
--    읽고 쓰므로 **반드시 서버 배포 전에** 적용해야 한다(없으면 원장 백업·되찾기 요청과 cron ⑦이 실패).
--
-- ⚠️ 실행 방법(운영 함정): `wrangler d1 execute --remote --file`은 OAuth 토큰과 import API가 비호환이라
--    오류 2036이 난다 → **반드시 `--command`로 아래 문장을 하나씩**:
--      cd server && npx wrangler d1 execute prepaid-relay --remote --command "<문 1>"
--      cd server && npx wrangler d1 execute prepaid-relay --remote --command "<문 2>"
--      cd server && npx wrangler d1 execute prepaid-relay --remote --command "<문 3>"
-- ⚠️ 실행 순서: 1) 아래 문 1~3을 **모두** 적용 → 2) cd server && npx wrangler deploy →
--    3) 프론트 배포(음식점 앱 git push, 담당자 웹 `pages deploy --branch=main`).
--    문 1은 IF NOT EXISTS라 재실행해도 안전하다. 문 2·3(ALTER)을 다시 실행하면 duplicate column 오류가 난다 — 정상(이미 적용됨).
CREATE TABLE IF NOT EXISTS ledger_backup_seg (restaurant_id TEXT NOT NULL, gen TEXT NOT NULL, seg_no INTEGER NOT NULL, blob TEXT NOT NULL, blob_hash TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (restaurant_id, gen, seg_no));
ALTER TABLE public_key_registry ADD COLUMN taken_over_at INTEGER;
ALTER TABLE ledger_backup ADD COLUMN gen TEXT;
