#!/usr/bin/env bash
# 갱신 데이터 보존 게이트 — "지금 라이브인 앱"으로 만든 장부가 "이번에 배포할 앱"에서 그대로 열리는지 확인한다.
#
#   사용법:  bash harness/upgrade-check.sh                 # 구버전 = 최신 live-beta* 태그(없으면 origin/main), 신버전 = 작업 트리
#            bash harness/upgrade-check.sh --old-ref live-beta54 --new-ref HEAD
#            UPGRADE_OLD_REF=... UPGRADE_NEW_REF=... bash harness/upgrade-check.sh
#
#   · 구버전 결정 순서: --old-ref / UPGRADE_OLD_REF → 가장 최신 `live-beta*` 태그(버전 순) → origin/main → main.
#     배포할 때마다 `git tag live-betaNN <배포 커밋>`을 남겨야 이 게이트가 "실제 라이브"와 비교한다
#     (docs/handover/06-testing.md "배포 태그" 절).
#   · 신버전: 기본은 작업 트리의 index.html·sw.js. --new-ref <ref>를 주면 그 커밋의 파일을 꺼내 쓴다.
#   · 실제 검증은 harness/experimental/upgrade.e2e.js가 한다(구 앱의 실제 UI로 장부를 만들고 신 앱에서 필드 단위 비교).
#     두 모드를 모두 돈다: ① 일반(서비스워커 배제 — 순수 데이터 보존) ② 서비스워커 배포 경로(실제 태블릿과 같은 갱신 흐름).
#   · 중계 서버는 전부 목이다 — 외부로 나가는 요청이 없다.
set -u
cd "$(dirname "$0")/.."
REPO="$(pwd)"

OLD_REF="${UPGRADE_OLD_REF:-}"
NEW_REF="${UPGRADE_NEW_REF:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --old-ref) OLD_REF="$2"; shift 2 ;;
    --new-ref) NEW_REF="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$OLD_REF" ]; then
  OLD_REF="$(git tag -l 'live-beta*' --sort=-version:refname | head -1)"
  OLD_HOW="최신 배포 태그"
  if [ -z "$OLD_REF" ]; then
    if git rev-parse -q --verify origin/main >/dev/null; then OLD_REF="origin/main"; else OLD_REF="main"; fi
    OLD_HOW="배포 태그 없음 → ${OLD_REF} 폴백 (배포 후 git tag live-betaNN 을 남길 것)"
  fi
else
  OLD_HOW="지정"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bapjangbu-upgrade-check.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
OUT="${UPGRADE_OUT:-${TMPDIR:-/tmp}/bapjangbu-upgrade}"
mkdir -p "$OUT"

extract() { # <ref> <path> <dest>
  git show "$1:$2" > "$3" 2>/dev/null || { echo "❌ $1:$2 를 꺼낼 수 없습니다" >&2; exit 2; }
}
extract "$OLD_REF" index.html "$TMP/old.html"
extract "$OLD_REF" sw.js      "$TMP/old-sw.js"
if [ -n "$NEW_REF" ]; then
  extract "$NEW_REF" index.html "$TMP/new.html"
  extract "$NEW_REF" sw.js      "$TMP/new-sw.js"
  NEW_DESC="$NEW_REF"
else
  cp index.html "$TMP/new.html"; cp sw.js "$TMP/new-sw.js"
  NEW_DESC="작업 트리"
fi

ver() { grep -oE "APP_VERSION='[^']+'" "$1" | head -1 | sed -E "s/APP_VERSION='([^']+)'/\1/"; }
OV="$(ver "$TMP/old.html")"; NV="$(ver "$TMP/new.html")"
echo "갱신 보존 검증: 구=${OLD_REF} (${OV:-?}, ${OLD_HOW})  →  신=${NEW_DESC} (${NV:-?})"
echo "기준: ${OLD_REF} ${OV:-?}→${NV:-?}"   # verify-all이 이 줄을 읽어 요약에 쓴다

rc=0
node harness/experimental/upgrade.e2e.js --out "$OUT" \
  --old "$TMP/old.html" --new "$TMP/new.html" \
  --label "${OV}→${NV}" --slug gate-plain || rc=1
node harness/experimental/upgrade.e2e.js --out "$OUT" --sw 1 \
  --old "$TMP/old.html" --oldsw "$TMP/old-sw.js" --new "$TMP/new.html" --newsw "$TMP/new-sw.js" \
  --label "${OV}→${NV}(SW)" --slug gate-sw || rc=1

if [ "$rc" = "0" ]; then echo "✅ 갱신 보존 2모드 통과 (${OV}→${NV})"; else echo "❌ 갱신 보존 실패 — 보고서: $OUT/gate-*-report.json"; fi
exit $rc
