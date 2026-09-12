-- 중계 서버 D1 스키마 (스펙 §2.2). 개인정보 평문 컬럼 없음.

CREATE TABLE IF NOT EXISTS public_key_registry (
  restaurant_id   TEXT PRIMARY KEY,
  restaurant_name TEXT,
  public_key      TEXT NOT NULL,       -- SPKI base64
  registered_at   INTEGER NOT NULL,
  contact_kakao   TEXT,                -- 업무용 카카오 오픈채팅 링크(선택, https://open.kakao.com/ 로 시작)
  contact_email   TEXT,                -- 업무용 공식 접수 이메일(선택)
  district        TEXT,                -- 관할 지역(공개 사업장 정보, 예 "서울특별시 광진구"). 개인정보 아님(§0 허용). 등록 목록 조회용.
  verified        INTEGER NOT NULL DEFAULT 0, -- 1=최초 등록 시 공공데이터에서 실존·상호 대조 성공, 0=미확인(공공API 장애 등). 개인정보 아님.
  deregistered_at INTEGER              -- 등록 해제 시각(NULL=활성). 해제는 즉시 삭제가 아니라 **30일 휴지통**이다(§4.12):
                                       -- 담당자에게는 즉시 '없는 가게'(public-key 404·목록 제외)지만, 소유 증명과
                                       -- 원장 백업 되찾기는 30일간 그대로 된다. 30일이 지나면 TTL cron이 이 행과
                                       -- ledger_backup을 함께 삭제한다. 활성 조회는 전부 `deregistered_at IS NULL`.
);

CREATE TABLE IF NOT EXISTS deposit_summary (
  id              TEXT PRIMARY KEY,    -- uuid
  institution     TEXT NOT NULL,       -- 기관명
  department      TEXT NOT NULL,       -- 부서명
  restaurant_id   TEXT NOT NULL,
  restaurant_name TEXT,
  year_month      TEXT NOT NULL,       -- "2026-07"
  total_amount    INTEGER NOT NULL,    -- 부서·음식점별 선금 합계 (개인별 금액 ❌)
  member_count    INTEGER NOT NULL,    -- 대상 인원수 (이름 ❌)
  agency_domain   TEXT,                -- 제출자가 OTP 인증에 사용한 이메일의 도메인부(예 "gwangjin.go.kr").
                                       -- 로컬파트 없음 → 개인정보 아님(§0 허용). 기관명은 자칭이라 서버가
                                       -- 검증할 수 없으므로, 검증 가능한 이 도메인을 음식점 앱에 함께 보내
                                       -- 사장님이 눈으로 대조하게 한다(PROTOCOL §4.11). 미인증·구버전 토큰이면 NULL.
  batch_hash      TEXT NOT NULL,       -- 배치 무결성 해시(canonical "name|dept|amount" — 불변)
  dedupe_key      TEXT,                -- 중복 판정 키(§4.7): 접수번호가 있으면 'sid:<submission_id>',
                                       -- 없으면(구버전 담당자 웹) 'bh:<batch_hash>|<year_month>'.
                                       -- UNIQUE(restaurant_id, dedupe_key) — 같은 내용이라도 새 접수번호면 새 건이 된다.
  status          TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|APPROVED|REJECTED|EXPIRED(미수령 72시간 경과)
  created_at      INTEGER NOT NULL,
  processed_at    INTEGER              -- APPROVED/REJECTED/EXPIRED 전이 시각(TTL 정리 30일 기준)
);
CREATE INDEX IF NOT EXISTS idx_summary_restaurant ON deposit_summary(restaurant_id, status);
-- 중복 제출 방지(멱등 처리와 짝을 이룸). 2026-09부터 판정 키는 batch_hash가 아니라 dedupe_key다 —
-- 예전 UNIQUE(restaurant_id,batch_hash)는 "같은 명단을 별도로 결제해 다시 보내는" 정상 업무를
-- 영구히 삼켰고(달이 바뀌어도 막혔다), 담당자에게는 성공처럼 보였다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_dedupe ON deposit_summary(restaurant_id, dedupe_key);
-- batch_hash는 이제 UNIQUE가 아니다 — 조회·운영 진단용 인덱스만 둔다.
CREATE INDEX IF NOT EXISTS idx_summary_batch_lookup ON deposit_summary(restaurant_id, batch_hash);
-- PENDING 72시간 만료 스캔(inbox 이중 방어·TTL cron)을 위한 인덱스.
CREATE INDEX IF NOT EXISTS idx_summary_status_created ON deposit_summary(status, created_at);

-- 행은 승인/거절(수령) 즉시 또는 미수령 72시간 만료 시 삭제된다(§6) — 장기 보관되지 않음.
CREATE TABLE IF NOT EXISTS encrypted_blob (
  id            TEXT PRIMARY KEY,      -- uuid
  summary_id    TEXT NOT NULL,         -- → deposit_summary.id
  restaurant_id TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,         -- §2 blob의 JSON 문자열 (서버는 복호화 불가)
  delivered     INTEGER NOT NULL DEFAULT 0,  -- 레거시 필드(미사용): 행이 즉시 삭제되므로 의미 없음
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_summary ON encrypted_blob(summary_id);

CREATE TABLE IF NOT EXISTS consent_log (
  id                TEXT PRIMARY KEY,
  institution       TEXT NOT NULL,
  department        TEXT NOT NULL,
  year_month        TEXT NOT NULL,
  agency_email_hash TEXT,              -- 기관 OTP 인증 이메일의 SHA-256 해시(평문 이메일 미저장)
  consented_at      INTEGER NOT NULL
);

-- 소유 증명(챌린지-응답) 인증. 토큰 평문은 저장하지 않고 해시만 5분 보관.
CREATE TABLE IF NOT EXISTS auth_challenge (
  restaurant_id TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_challenge_lookup ON auth_challenge(restaurant_id, token_hash);

-- 암호화 원장 클라우드 백업 (zero-knowledge). blob은 클라이언트 자체 공개키로 암호화되어
-- 서버는 복호화할 수 없다. restaurant_id당 최신본 1행.
CREATE TABLE IF NOT EXISTS ledger_backup (
  restaurant_id TEXT PRIMARY KEY,
  blob          TEXT NOT NULL,
  blob_hash     TEXT,
  updated_at    INTEGER NOT NULL
);

-- 기관 OTP 인증(단계적 활성화). 이메일 도메인은 .go.kr/.korea.kr만 허용.
CREATE TABLE IF NOT EXISTS agency_otp (
  email      TEXT PRIMARY KEY,
  otp_hash   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_token (
  token_hash   TEXT PRIMARY KEY,
  email        TEXT NOT NULL,   -- 이메일의 해시(HMAC/SHA-256) — 평문 미저장
  expires_at   INTEGER NOT NULL,
  email_domain TEXT             -- 인증된 이메일의 도메인부만(예 "gwangjin.go.kr", 로컬파트 제외 — 개인정보 아님).
                                -- /api/submit이 deposit_summary.agency_domain으로 옮겨 적어 음식점 앱까지 전달(§4.11).
);

-- 열쇠 지문 확인 기록(§4.8). 담당자(서무)가 사장님과 통화로 공개키 지문을 대조하고 "확인했다"를
-- 체크한 사실을 기관+부서 단위로 남긴다(같은 부서는 재확인 불필요, 다른 부서는 처음에 다시 확인).
-- 저장값은 조직정보(기관·부서)·공개ID·공개키 지문·시각뿐 — 개인정보 없음. TTL 정리 대상이 아니다
-- (확인 이력은 장기 보관해야 "이미 확인한 가게"를 계속 알아볼 수 있다).
CREATE TABLE IF NOT EXISTS agency_keycheck (
  institution   TEXT NOT NULL,
  department    TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,   -- "ABCD-EF12" (SHA-256(SPKI) hex 앞 8자, 대문자 4자씩 하이픈)
  checked_at    INTEGER NOT NULL,
  agency_domain TEXT,            -- 기록을 남긴 담당자가 OTP 인증한 이메일 도메인(로컬파트 없음 — 개인정보 아님).
                                 -- 기관·부서명은 담당자 자칭이라, 남의 기관명을 적어 조회하면 그 부서의 거래처·지문을
                                 -- 읽어갈 수 있었다. 조회는 **토큰 도메인과 같은 행만** 반환한다(NULL 레거시 행은 제외).
  PRIMARY KEY (institution, department, restaurant_id)
);
CREATE INDEX IF NOT EXISTS idx_keycheck_dept ON agency_keycheck(institution, department);

-- ── 비식별 집계 통계 (개인정보 아님 — 조직정보·공개ID·누적 카운터만 저장) ──
-- 직원명·개인별 금액·이메일은 어디에도 저장하지 않는다(§0 불변식). 관리자 통계 API의 재료.
CREATE TABLE IF NOT EXISTS seen_institution (
  name TEXT PRIMARY KEY               -- 기관명(조직정보, 비개인)
);
CREATE TABLE IF NOT EXISTS seen_department (
  key  TEXT PRIMARY KEY               -- "기관명부서명" 조합(조직정보, 비개인)
);
CREATE TABLE IF NOT EXISTS seen_restaurant (
  restaurant_id TEXT PRIMARY KEY      -- 음식점 공개ID(LOCALDATA mgtNo — 공개값)
);
CREATE TABLE IF NOT EXISTS stats_counter (
  name  TEXT PRIMARY KEY,             -- 예: sends, sends_2026-07, registrations, searches, members_total, amount_total
  count INTEGER NOT NULL DEFAULT 0    -- 누적 카운터(집계값만 — 개인 식별 불가)
);
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  role       TEXT,                    -- '음식점'|'기관'|'기타'
  message    TEXT,                    -- 자유 입력 본문(응답·로그에 내용 반영 금지)
  contact    TEXT,                    -- 선택 회신 채널(자유 입력)
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
