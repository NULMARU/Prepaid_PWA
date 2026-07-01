#!/usr/bin/env bash
# 선입금대장 전체 재점검 — 한 번에 모든 것을 검증한다.
#   사용법:  bash harness/verify-all.sh
#   (선택) 다른 배포를 가리키려면: RELAY=... PAGES=... APP=... bash harness/verify-all.sh
set -u
cd "$(dirname "$0")/.."
RELAY="${RELAY:-https://prepaid-relay.sulsul-plus.workers.dev}"
PAGES="${PAGES:-https://prepaid-agency.pages.dev}"
APP="${APP:-https://nulmaru.github.io/Prepaid_PWA/index.html}"
pass=0; fail=0
ok(){ if [ "$1" = "0" ]; then echo "  ✅ $2"; pass=$((pass+1)); else echo "  ❌ $2"; fail=$((fail+1)); fi; }

echo "=================================================="
echo " 선입금대장 전체 재점검  $(date '+%Y-%m-%d %H:%M')"
echo "=================================================="

echo; echo "[1] 로컬 자동 테스트"
node harness/prepaid.e2e.js >/tmp/v1.log 2>&1; grep -q '"ok": true' /tmp/v1.log; ok $? "phase1 e2e (설정·PIN·차감·서명·백업·초기화)"
node harness/phase2.e2e.mjs >/tmp/v2.log 2>&1; test $? -eq 0; ok $? "phase2 목 하니스 ($(grep -oE '[0-9]+ 통과' /tmp/v2.log | head -1)) — 등록→암호화→복호화→batch_hash→변조탐지→해제"

echo; echo "[2] 라이브 서버 (배포된 실제 시스템 + D1)"
node harness/phase2.live.mjs "$RELAY" >/tmp/v3.log 2>&1; test $? -eq 0; ok $? "phase2 라이브 6단계 ($(grep -oE '[0-9]+ 통과' /tmp/v3.log | head -1))"
N=$(curl -s "$RELAY/api/restaurants?q=%EA%B9%80%EB%B0%A5" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else 0)" 2>/dev/null)
test "${N:-0}" -gt 0; ok $? "공공API 실검색(이름) — ${N:-0}건"
PE=$(curl -s "$RELAY/api/restaurants?region=6510000&q=%EA%B9%80%EB%B0%A5" | python3 -c "import sys,json;d=json.load(sys.stdin);print('OK' if not any('폐업' in x['status'] for x in d) else 'BAD')" 2>/dev/null)
test "$PE" = "OK"; ok $? "폐업 자동 제외"
curl -s -X POST "$RELAY/api/submit" -H "Content-Type: application/json" -d '{"summary":{},"blob":{"ciphertext":{"items":[1]}}}' | grep -q "형식 오류"; ok $? "평문 개인정보 제출 거부 (불변식 §1.2-1)"

echo; echo "[3] 3개 앱 접속"
V=$(curl -s "$APP" | grep -oE "beta\.[0-9]+" | head -1); test -n "$V"; ok $? "음식점 앱 (${V:-?})"
test "$(curl -s -o /dev/null -w '%{http_code}' "$PAGES/")" = "200"; ok $? "담당자 웹 (200)"
test "$(curl -s -o /dev/null -w '%{http_code}' "$RELAY/api/restaurants?q=x")" = "200"; ok $? "중계 서버 (200)"

echo; echo "=================================================="
echo " 결과: $pass 통과 / $fail 실패"
echo "=================================================="
if [ "$fail" = "0" ]; then echo "🎉 전부 통과 — 시스템 정상"; else echo "⚠️ 실패 항목 로그: /tmp/v1.log /tmp/v2.log /tmp/v3.log"; fi
exit $fail
