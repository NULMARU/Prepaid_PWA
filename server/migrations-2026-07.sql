-- 2026-07 마이그레이션: 소유 증명 인증(챌린지-응답), 암호화 원장 클라우드 백업,
-- 기관 OTP 인증 인프라, TTL 정리 cron에 필요한 스키마 변경.
-- 개인정보 최소화 목적(TTL cron)을 위한 타임스탬프 컬럼 추가 포함.
-- 주의: 라이브 D1에 직접 실행하지 말 것 — 오케스트레이터가 별도로 적용한다.
--   실행 순서: 1) 이 마이그레이션 적용  2) wrangler deploy(신규 worker.js + wrangler.toml)

-- ── 신규 테이블 (기존 설치본에 없음) ──

CREATE TABLE IF NOT EXISTS auth_challenge (
  restaurant_id TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_challenge_lookup ON auth_challenge(restaurant_id, token_hash);

CREATE TABLE IF NOT EXISTS ledger_backup (
  restaurant_id TEXT PRIMARY KEY,
  blob          TEXT NOT NULL,     -- 클라이언트 자체 공개키로 하이브리드 암호화(서버 복호화 불가)
  blob_hash     TEXT,
  updated_at    INTEGER NOT NULL
);

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

-- ── 기존 테이블 컬럼 추가 (SQLite: 컬럼 존재 시 에러이므로 이미 적용된 D1에는 재실행 금지) ──

-- deposit_summary: TTL 정리(30일)를 위한 처리 시각 컬럼.
ALTER TABLE deposit_summary ADD COLUMN processed_at INTEGER;

-- consent_log: 기관 OTP 인증 시 이메일을 평문으로 남기지 않고 SHA-256 해시만 기록.
ALTER TABLE consent_log ADD COLUMN agency_email_hash TEXT;

-- ── 중복 정리 후 유니크 인덱스 (감사 항목: 동일 restaurant_id+batch_hash 중복 방지) ──
-- 그룹별로 가장 먼저 들어온 행(최소 rowid)만 남기고 나머지 중복은 삭제.
DELETE FROM deposit_summary
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM deposit_summary GROUP BY restaurant_id, batch_hash
);

-- 위 정리로 고아가 된 encrypted_blob 행도 함께 제거(암호문만 있으므로 개인정보 유출은 아니지만
-- 불필요한 저장을 줄인다).
DELETE FROM encrypted_blob WHERE summary_id NOT IN (SELECT id FROM deposit_summary);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_batch ON deposit_summary(restaurant_id, batch_hash);

-- ── 2026-07(2차) 추가: 보존 기간 단축 — 수령 즉시 파기, 미수령 최대 72시간 후 자동 파기 ──
-- deposit_summary.created_at·processed_at은 최초 설치본부터 이미 존재하므로 컬럼 추가 불필요.
-- status에 'EXPIRED' 값이 추가되지만 CHECK 제약이 없는 컬럼이라 스키마 변경 불요(코드 레벨 처리).
-- PENDING 72시간 만료 스캔(inbox 이중 방어·TTL cron)을 위한 인덱스만 추가한다.
CREATE INDEX IF NOT EXISTS idx_summary_status_created ON deposit_summary(status, created_at);

-- ── 2026-07(3차) 추가: 음식점 "업무용 연락처"(선택) — 카카오 오픈채팅 링크·공식 접수 이메일 ──
-- 음식점 주인이 직접 등록·삭제하는 선택적 사업장 연락 정보. 전화번호·개인 프로필은 저장하지 않는다.
ALTER TABLE public_key_registry ADD COLUMN contact_kakao TEXT;
ALTER TABLE public_key_registry ADD COLUMN contact_email TEXT;

-- ── 2026-07(4차) 추가: 비식별 집계 통계 + 피드백 수신 ──
-- 개인정보(직원명·개인별 금액·이메일)는 저장하지 않는다 — 조직정보·공개ID·누적 카운터만.
-- 전부 IF NOT EXISTS로 무손실이며 기존 데이터에 영향 없음. 관리자 통계 API(/api/admin/stats)의 재료.
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
  name  TEXT PRIMARY KEY,             -- sends, sends_YYYY-MM, registrations, searches, members_total, amount_total 등
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  role       TEXT,                    -- '음식점'|'기관'|'기타'
  message    TEXT,                    -- 자유 입력 본문(응답·로그에 내용 반영 금지)
  contact    TEXT,                    -- 선택 회신 채널(자유 입력)
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
