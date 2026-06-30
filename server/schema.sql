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
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summary_restaurant ON deposit_summary(restaurant_id, status);

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
  id           TEXT PRIMARY KEY,
  institution  TEXT NOT NULL,
  department   TEXT NOT NULL,
  year_month   TEXT NOT NULL,
  consented_at INTEGER NOT NULL
);
