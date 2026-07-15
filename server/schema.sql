-- 중계 서버 D1 스키마 (스펙 §2.2). 개인정보 평문 컬럼 없음.

CREATE TABLE IF NOT EXISTS public_key_registry (
  restaurant_id   TEXT PRIMARY KEY,
  restaurant_name TEXT,
  public_key      TEXT NOT NULL,       -- SPKI base64
  registered_at   INTEGER NOT NULL,
  contact_kakao   TEXT,                -- 업무용 카카오 오픈채팅 링크(선택, https://open.kakao.com/ 로 시작)
  contact_email   TEXT,                -- 업무용 공식 접수 이메일(선택)
  district        TEXT                 -- 관할 지역(공개 사업장 정보, 예 "서울특별시 광진구"). 개인정보 아님(§0 허용). 등록 목록 조회용.
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
  batch_hash      TEXT NOT NULL,       -- 배치 무결성 해시
  status          TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|APPROVED|REJECTED|EXPIRED(미수령 72시간 경과)
  created_at      INTEGER NOT NULL,
  processed_at    INTEGER              -- APPROVED/REJECTED/EXPIRED 전이 시각(TTL 정리 30일 기준)
);
CREATE INDEX IF NOT EXISTS idx_summary_restaurant ON deposit_summary(restaurant_id, status);
-- 감사 항목: 동일 (restaurant_id,batch_hash) 중복 제출 방지(멱등 처리와 짝을 이룸).
CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_batch ON deposit_summary(restaurant_id, batch_hash);
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
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

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
