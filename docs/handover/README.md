# 밥장부(선입금대장) — 인수인계 문서

이 리포를 **처음 받은 개발자**를 위한 문서 묶음이다. 기준일 **2026-08-04**, 백업 `schemaVersion 3`, IndexedDB `VER 3`.
현재 앱 버전은 `index.html`의 `APP_VERSION` 상수에서 직접 읽을 것(작성 시점 `1.0.0-beta.27` 대 — 활발히 올라가는 중이다).

## 이 문서들의 원칙

- **중복하지 않는다.** 이미 정확한 원본이 있는 것은 링크만 한다.
  | 주제 | 진실의 원본 |
  |---|---|
  | REST API 스펙·에러 코드·보존 정책 상세 | `server/PROTOCOL.md` |
  | D1 스키마(컬럼 주석 포함) | `server/schema.sql` · `server/migrations-2026-07.sql` |
  | 릴리스 이력·의사결정 로그 | `CLAUDE.md`(「완료」 절) |
  | 사용자 관점 사용법 | `docs/manual-restaurant.html` · `docs/manual-agency.html` · `docs/manual-staff.html` |
  | 개인정보처리방침·이용약관 확정본 | `docs/privacy.html` · `docs/terms.html` |
  | 기관 데이터 재생성 절차 | `docs/agency-data-pipeline.md` |
- **코드를 읽고 확인한 것만 쓴다.** 확인 못 한 것은 `미확인`으로 표기했다.
- **라인 번호를 쓰지 않는다.** 특정은 `파일:함수명` 단위로 한다.

---

## 30분 온보딩 경로

### 0~5분 — 무엇을 하는 서비스인지
1. [01-overview.md](01-overview.md) §1~2를 읽는다. **3주체**와 `"손님은 요청을 만들고, 사장님은 기록을 만든다"` 원칙만 확실히 잡는다.
2. 실물을 본다: https://bapjangbu.com → https://app.bapjangbu.com

### 5~10분 — 지금 돌아가는지 확인
```bash
npm i                          # playwright 설치
bash harness/verify-all.sh     # 10/10 기대 (약 2~4분)
```
- 실패 시 로그: `/tmp/v1.log` ~ `/tmp/v4.log`.
- 이게 통과해야 이후 모든 판단의 기준선이 생긴다. **먼저 실행해 두고 다음 문서를 읽으면 시간이 겹친다.**

### 10~20분 — 구조와 절대 조건
3. [02-architecture.md](02-architecture.md) — 구성요소 5개와 **데이터 흐름도**. §2.1 다이어그램 하나가 서비스의 전부다.
4. [05-invariants.md](05-invariants.md) — 절대 불변식 6개. **읽지 않고 코드를 고치면 안 되는 유일한 문서.**
5. [04-contracts.md](04-contracts.md) — 깨면 조용히 망가지는 계약 8개. 특히 **C1(`batch_hash`)·C2(`district`)** 는 실제 라이브 장애 이력이 있다.

### 20~30분 — 손대기 전 마지막
6. 고칠 곳이 **음식점 앱**이면 → [08-frontend-conventions.md](08-frontend-conventions.md) (전면 재렌더 구조·렌더 규칙 2대 원칙·캔버스 3중 보호). **이 문서 없이 `index.html`을 고치면 높은 확률로 사고가 난다.**
7. 고칠 곳이 **서버**면 → `server/PROTOCOL.md` §4 + [03-data-model.md](03-data-model.md) §8.
8. 배포할 거라면 → [07-deploy-runbook.md](07-deploy-runbook.md). **`git push` 하나로 다 나가지 않는다.**

### 그 다음 (선택)
- 데이터 필드가 궁금하면 [03-data-model.md](03-data-model.md)
- 테스트를 추가해야 하면 [06-testing.md](06-testing.md) — 특히 §4 "새 기능을 추가할 때"
- 남은 일이 궁금하면 [09-open-items.md](09-open-items.md)
- 코드 냄새·문서 모순 목록은 [10-code-review.md](10-code-review.md)

---

## 문서 인덱스

| 문서 | 무엇을 다루나 | 언제 읽나 |
|---|---|---|
| [01-overview.md](01-overview.md) | 푸는 문제, 3주체, 비즈니스 제약, **용어집**(UI 용어 ↔ 코드 식별자) | 처음 / 용어가 막힐 때마다 |
| [02-architecture.md](02-architecture.md) | 구성요소 5개, 데이터 흐름도, 책임 경계, 왜 이렇게 나뉘었나 | 처음 |
| [03-data-model.md](03-data-model.md) | IndexedDB 스토어·필드, 해시 체인, 잔액 규칙, 백업 포맷·버전 정책, D1 요약, **오리진 종속성** | 데이터를 만질 때 |
| [04-contracts.md](04-contracts.md) | 깨면 안 되는 계약 8개 + **깨졌을 때 무슨 일이 벌어지는가** | 계약을 건드릴 때 / PR 리뷰 |
| [05-invariants.md](05-invariants.md) | 절대 불변식 6개와 **코드상 강제 지점**, 규제·신뢰 리스크 | 처음, 그리고 기능 제안 때마다 |
| [06-testing.md](06-testing.md) | 하니스 4종 책임 분담표, verify-all 10항목, **커버리지 공백 G1~G9**, 테스트 추가 규칙 | 테스트를 쓸 때 |
| [07-deploy-runbook.md](07-deploy-runbook.md) | 5서피스 배포 명령·순서·검증, 시크릿, D1/Pages/GitHub Pages 함정, 장애 대응 | 배포 전 반드시 |
| [08-frontend-conventions.md](08-frontend-conventions.md) | 전면 재렌더 구조, 렌더 2대 원칙, 캔버스 3중 보호, `data-a` 액션 맵, `fits` 계약 | `index.html`을 고치기 전 반드시 |
| [09-open-items.md](09-open-items.md) | 미결·보류 항목과 판단 근거·재개 조건 | 로드맵을 짤 때 |
| [10-code-review.md](10-code-review.md) | 이관 저해 요소(죽은 코드·문서 모순·오해 부르는 이름) + 위험도·권장 조치 | 이관 직후 정리 작업 |

---

## 리포 밖에 있는 것 (⚠️ 클론해도 안 온다)

`.gitignore`로 제외된 로컬 전용 문서들 — **이관 시 별도로 넘겨야 한다.**

| 파일 | 내용 |
|---|---|
| `docs/BUSINESS_PLAN.md` | 사업 계획 |
| `docs/COMPLIANCE.md` | 규제 검토 |
| `docs/COST_MODEL.md` | 비용 추계(무료 한도 분석) |
| `docs/STATUS.md` | 옛 현황 문서(**내용이 낡음** — [10](10-code-review.md) R2) |
| `docs/phase2-deploy.md` | 옛 배포 절차(→ [07](07-deploy-runbook.md)이 대체) |

그리고 **직원용 앱은 별도 리포**다: `NULMARU/bapjangbu-staff` → https://staff.bapjangbu.com

시크릿(`PUBLIC_API_KEY`·`RESEND_API_KEY`·`ADMIN_TOKEN`)은 Cloudflare Workers secret으로만 존재하며 리포에 없다([07](07-deploy-runbook.md) §7).

---

## 자주 쓰는 명령 한 장

```bash
# 검증
bash harness/verify-all.sh                       # 전체 10/10
node harness/prepaid.e2e.js                      # 음식점 앱 e2e
node harness/phase2.e2e.mjs                      # 서버 목 하니스
node harness/responsive.e2e.mjs                  # 폰 반응형
node harness/phase2.live.mjs <서버URL>            # 라이브 스모크(프로덕션 D1을 건드림)

# 로컬 실행
python3 -m http.server 8765                      # 음식점 앱 (http://localhost:8765)
node server/dev-server.mjs                       # 중계 서버 로컬(메모리 store)

# 배포
git push                                          # 음식점 앱 + docs (GitHub Pages)
npx wrangler pages deploy agency-web --project-name=prepaid-agency --branch=main
npx wrangler pages deploy homepage   --project-name=bapjangbu-home --branch=main
cd server && npx wrangler deploy                  # 중계 서버
```
