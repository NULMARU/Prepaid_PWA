-- 2026-09 마이그레이션(beta.48). 이 파일도 append-only다(2026-07·2026-08 파일과 마찬가지로 과거 문장을 수정하지 말 것).
--
-- A. 접수번호(submission_id) 기반 중복 판정 — deposit_summary.dedupe_key + UNIQUE 인덱스 교체
--    배경: 예전 UNIQUE(restaurant_id, batch_hash)는 "같은 명단을 별도로 결제해 다시 보내는"
--    정상 업무를 영구히 삼켰다(달이 바뀌어도 막혔고, 담당자 화면에는 성공처럼 보였다).
--    이제 판정 키는 dedupe_key다 — 접수번호가 있으면 'sid:<submission_id>',
--    구버전 담당자 웹(접수번호 없음)이면 'bh:<batch_hash>|<year_month>'(같은 달 안에서만 멱등).
--    ※ batch_hash canonical("name|dept|amount")과 앱의 대조 로직은 **불변**이다.
-- B. 등록 해제 30일 휴지통 — public_key_registry.deregistered_at
--    해제해도 행·암호화 원장 백업을 30일 보관한다(담당자에게는 즉시 '없는 가게'). 그 안에 같은
--    열쇠로 재등록하면 백업을 되찾을 수 있고, 30일이 지나면 TTL cron이 둘 다 지운다.
-- C. 열쇠 지문 확인 이력의 도메인 결속 — agency_keycheck.agency_domain
--    기관·부서명은 담당자 자칭이라 남의 기관명을 적어 조회하면 그 부서의 거래처·지문이 샜다.
--    앞으로 조회는 토큰 도메인과 같은 행만 반환한다(NULL인 레거시 행은 제외 — 재확인 1회로 채워진다).
--
-- ⚠️ 실행 방법(운영 함정, 2026-08 파일과 동일): `wrangler d1 execute --remote --file`은 OAuth
--    토큰과 import API가 비호환이라 오류 2036이 난다 → **반드시 `--command`로 아래 문장을 하나씩**.
-- ⚠️ 실행 순서: 1) 아래 문 1~7을 순서대로 적용 → 2) cd server && npx wrangler deploy →
--    3) 프론트(담당자 웹 → 음식점 앱) 배포. 서버를 먼저 배포하면 신규 제출이 dedupe_key 컬럼
--    부재로 실패한다. ADD COLUMN은 재실행 시 에러(SQLite에 IF NOT EXISTS 없음) — 이미 있으면 건너뛸 것.
-- ⚠️ 문 2(백필)는 문 4(UNIQUE 인덱스)보다 반드시 먼저 실행할 것. 백필 없이 UNIQUE를 만들면
--    기존 행의 dedupe_key가 전부 NULL이라(NULL은 서로 충돌하지 않아 인덱스는 만들어지지만)
--    구버전 재제출이 기존 건을 찾지 못해 중복 행이 생긴다.
ALTER TABLE deposit_summary ADD COLUMN dedupe_key TEXT;
UPDATE deposit_summary SET dedupe_key='bh:'||batch_hash||'|'||year_month WHERE dedupe_key IS NULL;
DROP INDEX IF EXISTS idx_summary_batch;
CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_dedupe ON deposit_summary(restaurant_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_summary_batch_lookup ON deposit_summary(restaurant_id, batch_hash);
ALTER TABLE public_key_registry ADD COLUMN deregistered_at INTEGER;
ALTER TABLE agency_keycheck ADD COLUMN agency_domain TEXT;
