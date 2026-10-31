-- 2026-10 마이그레이션(운영자 휴지통 처리). 이 파일도 append-only다(2026-07·08·09 파일과 마찬가지로 과거 문장을 수정하지 말 것).
--
-- A. 운영자 조치 감사 기록 — admin_action_log
--    docs/admin.html의 [휴지통으로](POST /api/admin/deregister)가 남기는 기록이다. 효과는 사장님의
--    /api/deregister와 같은 30일 휴지통(deregistered_at 기록)이고, 여기에는 "누가 아니라 무엇을·왜"만
--    남긴다(조치 종류·가게 공개ID·사유 코드·짧은 메모·시각 — 운영자 IP·이메일 없음).
--    서버는 이 테이블 행수로 전역 24시간 상한(하루 20건)도 판정한다.
--
-- ⚠️ 실행 방법(운영 함정): `wrangler d1 execute --remote --file`은 OAuth 토큰과 import API가 비호환이라
--    오류 2036이 난다 → **반드시 `--command`로 아래 문장을 하나씩**:
--      cd server && npx wrangler d1 execute prepaid-relay --remote --command "<문 1>"
--      cd server && npx wrangler d1 execute prepaid-relay --remote --command "<문 2>"
-- ⚠️ 실행 순서: 1) 아래 문 1~2 적용 → 2) cd server && npx wrangler deploy →
--    3) git push(docs/admin.html — GitHub Pages가 app.bapjangbu.com/docs/admin.html로 배포).
--    서버를 먼저 배포해도 기존 기능은 그대로지만, 테이블이 없으면 새 /api/admin/deregister·actions가 500을 낸다.
--    두 문 모두 IF NOT EXISTS라 재실행해도 안전하다.
CREATE TABLE IF NOT EXISTS admin_action_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, restaurant_id TEXT NOT NULL, reason_code TEXT NOT NULL, memo TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_admin_action_created ON admin_action_log(created_at);
