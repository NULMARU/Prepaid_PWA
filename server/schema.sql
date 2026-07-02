-- 중계 서버 D1 스키마 (스펙 §2.2). 개인정보 평문 컬럼 없음.

CREATE TABLE IF NOT EXISTS public_key_registry (
  restaurant_id   TEXT PRIMARY KEY,
  restaurant_name TEXT,
  public_key      TEXT NOT NULL,       -- SPKI base64
  registered_at   INTEGER NOT NULL
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
  status          TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|APPROVED|REJECTED
  created_at      INTEGER NOT NULL,
  processed_at    INTEGER              -- APPROVED/REJECTED 전이 시각(TTL 정리 30일 기준)
);
CREATE INDEX IF NOT EXISTS idx_summary_restaurant ON deposit_summary(restaurant_id, status);
-- 감사 항목: 동일 (restaurant_id,batch_hash) 중복 제출 방지(멱등 처리와 짝을 이룸).
CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_batch ON deposit_summary(restaurant_id, batch_hash);

CREATE TABLE IF NOT EXISTS encrypted_blob (
  id            TEXT PRIMARY KEY,      -- uuid
  summary_id    TEXT NOT NULL,         -- → deposit_summary.id
  restaurant_id TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,         -- §2 blob의 JSON 문자열 (서버는 복호화 불가)
  delivered     INTEGER NOT NULL DEFAULT 0,
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
