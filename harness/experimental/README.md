# harness/experimental — verify-all에 아직 편입하지 않은 검증 스크립트

## upgrade.e2e.js — 구버전 → 신버전 갱신 데이터 보존 검증 (2026-09-13)

필드테스트 태블릿이 앱을 갱신할 때 기기의 IndexedDB(직원·거래·서명·meta)가 필드 단위로 그대로 남는지
실브라우저로 증명한다. 구버전 앱의 **실제 UI**로 장부를 만든 뒤(온보딩·PIN·한 명씩/CSV/직접 전달 등록·전화·충전·사용(서명)·취소·조정·연락처·백업),
같은 origin에서 신버전을 열어 스냅샷 A/B를 비교하고 장부 검사·증표·콘솔까지 본다. 중계 서버는 전부 목이며 운영 서버를 부르지 않는다.

```bash
cd /path/to/Prepaid_PWA
git show b60add2:index.html > /tmp/old.html      # 예: beta.47
git show b60add2:sw.js      > /tmp/old-sw.js
node harness/experimental/upgrade.e2e.js --old /tmp/old.html --new index.html --label "beta.47→HEAD" --slug b47
node harness/experimental/upgrade.e2e.js --sw 1 --old /tmp/old.html --oldsw /tmp/old-sw.js --new index.html --newsw sw.js --label "beta.47→HEAD(SW)" --slug b47sw
```
산출물(스냅샷·보고서·실패 HTML)은 `--out`(기본 `$TMPDIR/bapjangbu-upgrade`)에 쌓인다. 2026-09-13 실행 결과: beta.45/47 → beta.50/51 6개 조합 전부 통과.
편입 계획은 `docs/handover/09-open-items.md` G1-b.
