-- 2026-08 마이그레이션: 서버 보안 강화(OWASP/ASVS/STRIDE 점검 반영).
--   A. 열쇠 지문 확인 기록(agency_keycheck) — 가게 선점 방어
--   B. 가게 등록 강화(public_key_registry.verified) — 공공데이터 실존·상호 대조 결과 표시
--   C. 인증 도메인 전달(F-04) — agency_token.email_domain · deposit_summary.agency_domain
-- 이 파일은 append-only다(2026-07 파일과 마찬가지로 과거 문장을 수정하지 말 것).
--
-- ⚠️ 실행 방법(운영 함정): `wrangler d1 execute --remote --file`은 OAuth 토큰과 import API가
--    비호환이라 오류 2036이 난다 → **반드시 `--command`로 아래 문장을 하나씩** 실행할 것.
--
-- ⚠️ 실행 순서(클라이언트-서버 계약 순서):
--    1) 이 마이그레이션(문 1 → 문 2 → 문 3 → 문 4 → 문 5)을 라이브 D1에 적용
--    2) cd server && npx wrangler deploy      (신규 worker.js + wrangler.toml)
--    3) 프론트(agency-web / 음식점 앱) 배포
--    ※ 문 3(ALTER TABLE ... ADD COLUMN)은 이미 적용된 DB에 재실행하면 에러가 난다(SQLite에는
--      ADD COLUMN IF NOT EXISTS가 없다). 재실행 금지 — 이미 있으면 그 문만 건너뛸 것.
--    ※ 서버를 먼저 배포해도(순서 2가 1보다 앞서면) 신규 등록이 verified 컬럼 부재로 실패한다.
--      반드시 마이그레이션 → deploy 순서를 지킬 것.

-- ── 문 1: 열쇠 지문 확인 기록 테이블(신규) ──
-- 담당자(서무)가 사장님과 통화로 공개키 지문("ABCD-EF12")을 대조하고 "확인했다"를 체크한 사실을
-- 기관+부서 단위로 남긴다. 같은 부서는 재확인 불필요, 다른 부서는 처음에 다시 확인해야 한다.
-- 저장값은 조직정보(기관·부서)·음식점 공개ID·공개키 지문·시각뿐 — 개인정보 없음(§0 유지).
-- 보존: TTL cron 정리 대상이 **아니다**(확인 이력은 장기 보관 — 지우면 매번 다시 확인해야 한다).
CREATE TABLE IF NOT EXISTS agency_keycheck (
  institution   TEXT NOT NULL,
  department    TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  checked_at    INTEGER NOT NULL,
  PRIMARY KEY (institution, department, restaurant_id)
);

-- ── 문 2: 부서별 확인 목록 조회(GET /api/agency/keychecks) 인덱스 ──
CREATE INDEX IF NOT EXISTS idx_keycheck_dept ON agency_keycheck(institution, department);

-- ── 문 3: 가게 등록 강화 — 공공데이터 실존·상호 대조 결과 ──
-- 1 = 최초 등록 시 공공데이터(data.go.kr 일반음식점)에서 restaurant_id 실존 + 상호 일치를 확인함.
-- 0 = 미확인(공공 API 장애·키 미설정·결과 잘림 등 판정 불가 — 가용성 우선으로 등록은 허용했다).
-- 기존 행은 DEFAULT 0(미확인)으로 채워진다 — 마이그레이션 이전 등록분은 대조를 거치지 않았으므로 정확한 표기다.
-- registered_at 컬럼은 최초 설치본부터 존재하므로 추가하지 않는다(/api/registered-list 응답에 함께 실린다).
ALTER TABLE public_key_registry ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

-- ── 문 4·5: 인증 도메인 전달(보안 점검 F-04) ──
-- 배경: 유효한 X-Agency-Token 하나면 institution(기관명)에 아무 이름이나 적어 제출할 수 있다.
--   토큰 발급 도메인은 go.kr·korea.kr·or.kr·ac.kr까지 넓어, 대학 메일로 "○○구청 총무과" 명의
--   제출이 가능하다. 서버가 기관명의 진위를 검증할 수단은 없지만, **인증된 이메일의 도메인**은
--   서버가 실제로 확인한 사실이다. 그 도메인을 음식점 앱까지 전달해 사장님이 눈으로 대조한다.
-- 개인정보: 저장·전달되는 값은 **도메인부뿐**(로컬파트 제외 — "gwangjin.go.kr" 형태)이라 개인을
--   식별하지 않는다. 평문 이메일 미저장 불변식(§0)은 그대로 유지된다.
-- 하위호환: 이미 발급된 토큰과 기존 deposit_summary 행은 NULL이 되며, 서버는 NULL을 그대로 내보낸다
--   (음식점 앱이 "확인 불가"로 표시). 기존 토큰은 24시간 안에 자연 소멸한다.
-- batch_hash canonical("name|dept|amount")은 **불변**이다 — summary 필드 추가는 해시와 무관하다.
--
-- ⚠️ 실행 순서(문 3과 동일 원칙): 1) 아래 두 문을 --command로 하나씩 적용 →
--    2) cd server && npx wrangler deploy → 3) 프론트(음식점 앱) 배포.
--    서버를 먼저 배포하면 신규 verify-otp/submit이 컬럼 부재로 실패한다.
-- ⚠️ ADD COLUMN은 재실행 시 에러(SQLite에 ADD COLUMN IF NOT EXISTS 없음) — 이미 있으면 건너뛸 것.
ALTER TABLE agency_token ADD COLUMN email_domain TEXT;
ALTER TABLE deposit_summary ADD COLUMN agency_domain TEXT;
