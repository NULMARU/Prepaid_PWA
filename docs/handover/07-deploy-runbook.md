# 07 — 배포 런북

5개 서피스는 **배포 파이프라인이 서로 다르다.** `git push` 하나로 전부 나가지 않는다 — 이것이 이 리포에서 가장 흔한 사고 원인이다.

> ⚠️ 원본 배포 문서 `docs/phase2-deploy.md`는 **`.gitignore`에 등재되어 리포에 포함되지 않는다.** 이 런북이 리포에 남는 유일한 배포 문서다.

---

## 1. 서피스별 배포 명령

| # | 서피스 | 명령 | git push로 나가나 |
|---|---|---|---|
| 1 | 음식점 앱 + 문서(`docs/`) + 가게 색인(`storeidx/`, beta.61) | `git push` → GitHub Actions `pages.yml`(**`test` job 통과 후** 리포 루트 전체를 아티팩트로 업로드). 색인은 리포에 없고 배포 단계에서 아티팩트에만 싣는다 — push 때는 라이브 색인 그대로, 매일 한국 03:23 예약 실행이 새로 만든다([storeidx-pipeline.md](../storeidx-pipeline.md)) | ✅ |
| 2 | 담당자 웹 | `npx wrangler pages deploy agency-web --project-name=prepaid-agency --branch=main` | ❌ |
| 3 | 소개 홈페이지 | `npx wrangler pages deploy homepage --project-name=bapjangbu-home --branch=main` | ❌ |
| 4 | 중계 서버 | `cd server && npx wrangler deploy` | ❌ |
| 5 | D1 마이그레이션 | `npx wrangler d1 execute prepaid-relay --remote --command "<한 문장>"` (§4) | ❌ |

직원용 앱(`staff.bapjangbu.com`)은 **별도 리포 `NULMARU/bapjangbu-staff`** 에서 배포된다. 이 리포에서 나가지 않는다.

⚠️ **CI 배포 게이트는 1번에만 걸린다.** `pages.yml`의 `test` job(`node harness/phase2.e2e.mjs`)이 실패하면 음식점 앱·docs는 배포되지 않지만, 2~5번은 `wrangler`로 직접 나가므로 **게이트를 거치지 않는다**([06](06-testing.md) §2.1).

---

## 2. 배포 순서 (계약 변경이 있을 때)

```
① D1 마이그레이션   →  ② 서버(wrangler deploy)  →  ③ 프론트
```

**이유**: 서버가 먼저 새 필드·새 응답을 **받아들일 수 있어야** 신버전 클라이언트가 깨지지 않고, 구버전 클라이언트도 계속 동작해야 한다(서버는 하위 호환을 유지하도록 작성돼 있다). 순서가 어긋나면 라이브 승인/제출이 **일시적으로 깨진다**. ①을 건너뛰고 ②를 하면 새 컬럼이 없어 제출이 500으로 떨어진다.

**③의 내부 순서** — 원칙은 **"새 필드를 읽는 쪽을 먼저"**(수신자가 받을 수 있게 된 뒤에 발신을 바꾼다). 양쪽 새 필드가 전부 **선택 필드**라 구버전이 무시해도 안전한 릴리스라면 순서는 자유다.

| 릴리스 | 실제 순서 | 비고 |
|---|---|---|
| beta.61 (2026-11, 배포 전 — 계획) | 서버 → 음식점 앱·문서(색인 포함) → 담당자 웹 → 직원 앱 → `git tag live-beta61` | D1 마이그레이션 없음. 서버를 먼저: 새 담당자 웹의 [로그아웃]은 예전 서버의 404도 오류로 보지 않지만, 서버 토큰은 새 서버부터 90일이다(예전 서버가 준 24시간 토큰은 그대로 만료되고 다시 인증하면 90일). 담당자 웹·직원 앱은 `app.bapjangbu.com/storeidx/`를 읽으므로, 색인이 실린 앱 배포가 먼저면 첫날부터 색인을 쓴다(없어도 예전 방식으로 찾는다). 푸시 직후 `workflow_dispatch`(`storeidx_only`)로 GitHub 러너에서 공공데이터 내려받기가 되는지 시험할 것 |
| beta.60 (2026-11, 배포 전) | 마이그레이션 7문(`migrations-2026-11b.sql`) → 서버 → 음식점 앱·문서 → 담당자 웹 → 홈페이지 → 직원 앱 → `git tag live-beta60` | 🔴 **문 1(`auth_challenge.pk`)을 서버 배포 전에** — 새 서버의 `/api/challenge`가 이 컬럼에 쓰므로 없으면 챌린지 발급이 500 → 승인·서버 백업·등록 해제·연락처가 **전부** 막힌다. 문 2~6(보관 칸)이 없으면 다른 열쇠 인수가 500, 문 7(`agency_keycheck_dom`)이 없으면 담당자 웹의 지문 확인이 500. 서버를 올리면 cron이 **매시 17분**으로 바뀐다(§8). 구버전 앱(beta.59)은 토큰 없이 같은 열쇠로 재등록하는데, 서버가 `REACTIVATE_COMPAT`(기본 켜짐)으로 상호·관할이 같을 때만 받아 준다(§8). 새 오류 코드(`segments_missing`·`state_conflict`·`takeover_conflict`·`store_name_required`·`backup_quota_exceeded`)는 구버전 앱에 일반 오류로 보일 뿐 깨지지 않는다 |
| beta.55 (2026-11) | 마이그레이션 3문(`migrations-2026-11.sql`) → 서버 → 음식점 앱·문서 → 담당자 웹 → 홈페이지 → 직원 앱 (2026-11-14 이 순서로 배포, 태그 `live-beta55`) | 🔴 **문 2(`taken_over_at`)·문 3(`ledger_backup.gen`) 컬럼을 서버 배포 전에** — 새 서버의 `getPublicKey`·백업 저장이 이 컬럼을 읽고 쓰므로 없으면 등록·챌린지·백업이 전부 500. 프론트 쪽 새 필드(`gen`, `confirm_change`)는 선택 필드이고 새 오류 코드(`not_registered`·`too_many_pending`·`takeover_locked`·`invalid_public_key`·`fingerprint_changed`)는 구버전 프론트가 일반 오류로 보여 줄 뿐 깨지지 않는다 |
| beta.48 (2026-09) | 마이그레이션 7문 → 서버 → **담당자 웹 → 음식점 앱** | `submission_id`·`transfer_id`가 둘 다 선택 필드라 어느 쪽을 먼저 내도 깨지지 않는다. `migrations-2026-09.sql` 머리말·`PROTOCOL.md` §9가 이 순서로 적혀 있다 |
| beta.26 (2026-08) | 마이그레이션 → 서버 → 음식점 앱 → 담당자 웹 | 앱이 **수신자**인 계약 변경이었다(`org` 선택 필드 + district) |

- 계약 변경이 없는 단순 수정이면 순서는 자유.
- 계약 변경의 정의는 [04-contracts.md](04-contracts.md) 참조.

---

## 3. 검증 — ⚠️ 상태가 아니라 **라이브 콘텐츠 문자열**로 확인한다

배포 도구의 "성공" 메시지는 **배포되었다는 뜻이지 프로덕션 도메인에 반영되었다는 뜻이 아니다.**

```bash
# 1) 음식점 앱 — 방금 올린 버전이 실제로 서빙되는가
curl -s https://app.bapjangbu.com/ | grep -o "1\.0\.0-beta\.[0-9]*" | head -1
curl -s https://app.bapjangbu.com/sw.js | head -1     # CACHE_NAME도 같이 올랐는가

# 2) 담당자 웹 — 이번 변경에서 새로 들어간 고유 문자열로 확인
curl -s https://agency.bapjangbu.com/ | grep -c "<이번 변경의 고유 문자열>"

# 3) 홈페이지
curl -s https://bapjangbu.com/ | grep -c "<이번 변경의 고유 문자열>"

# 4) 서버 — 새 엔드포인트/새 응답 필드를 직접 찌른다
curl -s "https://prepaid-relay.sulsul-plus.workers.dev/api/registered-list?sido=서울특별시" | head -c 200

# 5) 전체
bash harness/verify-all.sh    # 12/12 기대
```

**`verify-all.sh`의 앱 체크(10번)는 라이브와 로컬 `index.html`의 `APP_VERSION`을 대조**하므로 음식점 앱의 구버전 서빙은 잡아낸다. 그러나 **담당자 웹·홈페이지·서버는 HTTP 200만 본다** — 그쪽 배포 판정은 반드시 위의 콘텐츠 문자열로 할 것([06-testing.md](06-testing.md) §2).

**커스텀 도메인 반영에 수십 초~1분 지연**이 있을 수 있다. 한 번 실패했다고 재배포하지 말고 다시 확인할 것.

---

## 4. D1 마이그레이션 (함정 있음)

- 마이그레이션 파일은 **월별로 나뉘고 각 파일이 append-only**다. 기존 문장을 수정하지 말고, 새 달이면 새 파일을 만든다.

  | 파일 | 내용 |
  |---|---|
  | `server/migrations-2026-07.sql` | `processed_at`, `district`, `contact_*`, `agency_email_hash`, 보존·집계 계열 |
  | `server/migrations-2026-08.sql` | 문 1~5 — `verified`, `agency_domain`(deposit_summary), `agency_keycheck` 등 |
  | `server/migrations-2026-09.sql` | 문 1~7 — beta.48(아래) |
  | `server/migrations-2026-10.sql` | 문 1~2 — `admin_action_log`(운영자 휴지통 처리) |
  | `server/migrations-2026-11.sql` | 문 1~3 — beta.55 `ledger_backup_seg`(조각 백업) + `public_key_registry.taken_over_at`(인수 시각) + `ledger_backup.gen`(머리의 세대 — 고아 조각 정리가 씀). **세 문 모두 `wrangler deploy` 전에** 적용. 문 2·3은 ALTER라 재실행하면 duplicate column — 이미 적용된 것 |
  | `server/migrations-2026-11b.sql` | 문 1~7 — beta.60. 문 1 `ALTER TABLE auth_challenge ADD COLUMN pk TEXT`(챌린지의 발급 키 — **빠지면 챌린지 발급 500으로 승인·백업·해제가 전부 막힌다**), 문 2~6 인수 전 옛 백업 **보관 칸**(`ledger_backup_archive`·`ledger_backup_archive_seg`·`archive_challenge` + 인덱스 2), 문 7 `agency_keycheck_dom`(도메인별 지문 확인 기록). **일곱 문 모두 `wrangler deploy` 전에**, `--command`로 한 문장씩 순서대로. 문 1을 다시 실행하면 duplicate column — 이미 적용된 것(정상). 문 2~7은 `IF NOT EXISTS`라 재실행 안전. 같은 달 두 번째 파일이라 이름에 `b`가 붙었다(같은 달 `-11.sql`은 append-only로 건드리지 않음) |

  신규 설치는 `server/schema.sql` 하나로 끝난다(마이그레이션 결과가 이미 반영돼 있다).
- 🔴 **`wrangler d1 execute --remote --file`을 쓰지 말 것.** OAuth 토큰과 import API가 비호환이라 **오류 2036**이 난다.
  → **`--command`로 문 단위 실행**할 것.
  ```bash
  cd server
  npx wrangler d1 execute prepaid-relay --remote --command "CREATE TABLE IF NOT EXISTS foo (…)"
  ```
- SQLite `ALTER TABLE ADD COLUMN`은 **이미 존재하면 에러**다(`IF NOT EXISTS`가 없다). 재실행하지 말고, 이미 있으면 건너뛴다.
- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS`는 재실행 안전.
- 적용 후 즉시 `npx wrangler deploy`로 서버를 올릴 것(스키마만 바뀌고 코드가 구버전이면 새 컬럼이 채워지지 않는다).
- 확인:
  ```bash
  npx wrangler d1 execute prepaid-relay --remote --command "PRAGMA table_info(public_key_registry)"
  ```

### 4.1 beta.48 (2026-09) — 7문, 순서가 중요하다

```bash
cd server
npx wrangler d1 execute prepaid-relay --remote --command "ALTER TABLE deposit_summary ADD COLUMN dedupe_key TEXT"
npx wrangler d1 execute prepaid-relay --remote --command "UPDATE deposit_summary SET dedupe_key='bh:'||batch_hash||'|'||year_month WHERE dedupe_key IS NULL"
npx wrangler d1 execute prepaid-relay --remote --command "DROP INDEX IF EXISTS idx_summary_batch"
npx wrangler d1 execute prepaid-relay --remote --command "CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_dedupe ON deposit_summary(restaurant_id, dedupe_key)"
npx wrangler d1 execute prepaid-relay --remote --command "CREATE INDEX IF NOT EXISTS idx_summary_batch_lookup ON deposit_summary(restaurant_id, batch_hash)"
npx wrangler d1 execute prepaid-relay --remote --command "ALTER TABLE public_key_registry ADD COLUMN deregistered_at INTEGER"
npx wrangler d1 execute prepaid-relay --remote --command "ALTER TABLE agency_keycheck ADD COLUMN agency_domain TEXT"
```

🔴 **문 2(백필)는 문 4(UNIQUE 인덱스)보다 반드시 먼저.** 백필 없이 UNIQUE를 만들면 기존 행의 `dedupe_key`가 전부 NULL이라 — NULL은 서로 충돌하지 않으므로 인덱스는 **만들어지고 에러도 나지 않는다** — 구버전 담당자 웹의 재제출이 기존 건을 찾지 못해 중복 행이 생긴다.

확인:
```bash
npx wrangler d1 execute prepaid-relay --remote --command "PRAGMA table_info(deposit_summary)"
npx wrangler d1 execute prepaid-relay --remote --command "SELECT COUNT(*) n FROM deposit_summary WHERE dedupe_key IS NULL"   # 0이어야 한다
```

---

## 5. Cloudflare Pages 함정 — `--branch=main` 필수

```bash
npx wrangler pages deploy agency-web --project-name=prepaid-agency --branch=main
npx wrangler pages deploy homepage   --project-name=bapjangbu-home --branch=main
```

🔴 **`--branch=main`을 빠뜨리면** wrangler가 **현재 git 브랜치명**을 Pages 브랜치로 써서 **프리뷰 배포**가 되고, 커스텀 도메인(`agency.bapjangbu.com`·`bapjangbu.com`)은 **옛 내용 그대로 남는다**. 성공 메시지는 똑같이 나오므로 속기 쉽다. 반드시 §3의 콘텐츠 문자열로 확인.

---

## 6. GitHub Pages 함정 — 실패한 런을 rerun하지 말 것

워크플로: `.github/workflows/pages.yml`(push to `main` 또는 수동 dispatch, `concurrency: pages`, 리포 루트 `path: '.'`를 통째로 업로드).
**job 2개** — `test`(`node harness/phase2.e2e.mjs`) → `deploy`(`needs: test`). 서버 계약 하니스가 실패하면 배포 자체가 일어나지 않는다(beta.48부터).

🔴 실패한 런을 **rerun하면 중복 아티팩트 오류**가 난다.
→ rerun 금지. **새 런을 띄운다**:
```bash
gh workflow run pages.yml --ref main
gh run list --workflow=pages.yml --limit 3
```
그 다음 §3의 콘텐츠 문자열로 확인.

> 참고: 리포 루트 전체가 업로드되므로 `docs/`·`icons/`·`agency-depts/`도 함께 나간다. 반대로 **`.gitignore`된 파일은 절대 배포되지 않는다**(`docs/STATUS.md` 등).

---

## 7. 시크릿

현재 등록된 것 3개(전부 Workers secret):

| 이름 | 용도 | 미설정 시 |
|---|---|---|
| `PUBLIC_API_KEY` | data.go.kr LOCALDATA 검색 프록시(Decoding 일반 키) | 가게 검색 불가 |
| `RESEND_API_KEY` | 담당자 OTP 이메일 발송 | `500 email_not_configured` |
| `ADMIN_TOKEN` | `/api/admin/stats` 보호 | `503 admin_not_configured`(기능 비활성) |

등록:
```bash
cd server
npx wrangler secret put RESEND_API_KEY
# ↑ 실행 후 "프롬프트에" 값을 입력한다
```
🔴 **명령줄에 값을 쓰지 말 것** — 이름으로 등록되고 값이 셸 히스토리에 노출된다.

확인: `npx wrangler secret list`

---

## 8. 환경변수 (`server/wrangler.toml`, 값이 코드처럼 동작함)

| 변수 | 현재 값 | 의미 |
|---|---|---|
| `ALLOW_ORIGIN` | 7개 도메인 콤마 목록 | CORS 화이트리스트. **새 프론트 도메인은 여기 먼저 넣고 deploy** |
| `AUTH_MODE` | `prod` | `dev`=응답에 평문 OTP 포함(**운영 금지**) / `pilot`=발송 안 함 / `prod`=Resend 실발송 |
| `REQUIRE_AGENCY_AUTH` | `1` | `/api/submit`에 `X-Agency-Token` 필수(없으면 `401 agency_auth_required`) |
| `PUBLIC_API_BASE` / `*_REGION_PARAM` / `*_NAME_PARAM` | data.go.kr | 검색 프록시 파라미터 |
| `crons` | `17 * * * *` (beta.60, 예전 `17 18 * * *`) | **매시 17분** 한 개(무료 플랜 트리거 수를 늘리지 않음). 매시 회차는 **미수령 72시간 만료(암호문 파기)만** 한다 — "받지 않으면 3일 뒤 삭제" 약속을 72시간+1시간 안에 지킨다. **UTC 18시 회차(KST 03:17)만** 예전 일일 정리 전체(처리 완료 30일·인증 만료·180일 보존·휴지통·보관 칸 ⑧·고아 조각 ⑦, PROTOCOL §6.3). 분기는 `worker.js` `cronJobFor` |
| `REACTIVATE_COMPAT` | 설정 안 함(= `"1"`, 켜짐) | beta.60. 구버전 앱(beta.59 이하)이 [자동 등록 중단] 뒤 같은 열쇠로 다시 등록할 때 **토큰 없이** 오는 것을, 상호·관할이 같고 운영자 휴지통이 아닐 때만 받아 준다(PROTOCOL §4.12). 필드테스트 기기가 **모두 beta.60 이상**이 된 것을 확인하면 `[vars]`에 `REACTIVATE_COMPAT = "0"`을 넣고 deploy — 끄면 토큰 없는 되돌리기는 전부 `401 auth_required` |

`ALLOW_ORIGIN`에는 `staff.bapjangbu.com`이 **선등재**돼 있다.

---

## 9. 도메인·이메일 (건드리면 안 되는 것)

- **`bapjangbu.com`은 Cloudflare Email Obfuscation ON** — 라이브 소스에서 이메일이 `data-cfemail`로 난독화된다. **정상 동작이다.** `curl | grep contact@` 하면 0건이 나오지만 버그가 아니다.
- **발신 = Resend**(`send.` 서브도메인의 DKIM/SPF), **수신 = Cloudflare Email Routing**(`contact@bapjangbu.com` → 운영자 편지함).
  🔴 **apex MX 레코드는 수신 라우팅용이다. Resend와 별개이니 건드리지 말 것.**
- 옛 주소(`nulmaru.github.io/Prepaid_PWA`, `prepaid-agency.pages.dev`)는 계속 작동한다(301/병행 서빙). **다만 오리진이 다르므로 저장 데이터는 이전되지 않는다**([03-data-model.md](03-data-model.md) §9).

---

## 10. 릴리스 체크리스트 (음식점 앱)

1. `index.html`의 `APP_VERSION`과 `sw.js`의 `CACHE_NAME`을 **함께** 올린다(코드가 대조하지 않는다).
2. `bash harness/verify-all.sh` → 12/12.
3. 계약 변경이 있으면 §2 순서를 따른다.
4. `git push` → Actions 완료 대기.
5. §3의 콘텐츠 문자열로 **라이브 확인**.
6. `CLAUDE.md`의 「현재 상태」·「완료」 절에 상세 내역을 기록하고, **`CHANGELOG.md`에 해당 버전 항목을 추가한다**(릴리스 단위 요약 — 배경·설계 판단은 `CLAUDE.md`, 요약은 `CHANGELOG.md`).

---

## 11. 장애 대응 빠른 참조

| 증상 | 먼저 볼 곳 |
|---|---|
| 담당자 웹에 관할 음식점이 안 뜬다 | D1 `public_key_registry.district`가 채워졌는가 → 앱의 `relayDistrict()`·자동 치유([04](04-contracts.md) C2) |
| 사장님이 "가게 등록이 안 된다"(재설치 후) | 서버에 예전 열쇠의 등록이 남은 고아 등록 → §12 수동 해제 |
| 담당자가 "인증번호가 안 온다" | Resend 하루 100통 한도(`429 email_quota_exceeded`) / `AUTH_MODE`가 `prod`인가 / `RESEND_API_KEY` 등록 여부 |
| 음식점 앱이 명단을 못 받는다 | `batch_hash` 불일치([04](04-contracts.md) C1) / 72시간 만료 / 승인 후 재조회 |
| 담당자가 "보냈는데 없어졌다" | `deduped:true` 응답 확인([04](04-contracts.md) C6) / `batch_hash` 충돌([04](04-contracts.md) C1 부수 계약) / 담당자 웹이 `submission_id`를 싣는 버전인가(구버전은 같은 달 같은 내용이 멱등으로 삼켜진다) |
| 사장님이 "같은 명단이 두 번 들어갔다" | 승인 아웃박스([04](04-contracts.md) C11) — 수신함에 `장부에 반영됨 · 서버 알림 대기`가 떠 있는가 / 직접 전달 파일을 두 번 열었는가(`transfer_id`가 없는 구버전 파일이면 경고만 뜬다) |
| 등록 해제한 가게가 담당자 목록에 계속 보인다 | `deregistered_at`이 실제로 찍혔는가 — 활성 필터가 빠진 경로가 있는지 확인([04](04-contracts.md) C12) |
| "등록 해제했는데 백업을 되찾고 싶다" | 해제 후 **30일 안**이면 같은 열쇠로 재등록하면 된다(`reactivated:true` — beta.60 앱은 소유 증명 토큰을 싣는다). 30일이 지났으면 cron이 이미 지웠다 — 복구 불가. 그 사이 **다른 열쇠가 인수**했으면 beta.60부터 옛 백업이 **보관 칸**으로 옮겨져 해제 시각부터 30일 동안 남는다 — 옛 열쇠가 있는 기기(예전에 서버 백업을 올린 기기)에서 설정 > 장부 지키기 > [되찾기] > [서버에서 되찾기]로 사장님이 직접 받는다(운영자 작업 없음, PROTOCOL §4.14) |
| 사장님 앱이 "다른 기기에 등록됨"으로 재등록이 401 | 같은 열쇠의 해제 가게 되돌리기는 beta.60부터 소유 증명이 필요하다. beta.60 앱은 자동으로 토큰을 싣는다. 구버전 앱은 `REACTIVATE_COMPAT`이 켜져 있고 상호·관할이 같을 때만 통과(§8) — 앱을 beta.60으로 갱신하게 안내 |
| 사장님이 "가게 등록이 `takeover_locked`로 막힌다" | 운영자가 [휴지통으로] 처리한 지 7일이 안 된 가게를 **다른 열쇠**로 등록하려는 것(beta.55). 원래 기기는 같은 열쇠로 바로 되살릴 수 있다. 부당 선점 정리 직후라면 7일 뒤에 진짜 사장님이 등록하거나, 본인 확인 후 아래 §12 터미널 절차로 잠금 없이 처리 |
| 담당자가 "`too_many_pending`으로 안 보내진다" | 그 가게 수신함에 미수령 신청이 30건 쌓였다(beta.55). 사장님이 받기·거절을 하면 풀린다(72시간 지나면 자동 만료) |
| 사장님 앱이 "서버 백업 자리가 가득 찼어요"(`too_many_segments`) | 운영자가 할 일은 대개 없다(beta.55) — 서버가 스스로 고아 조각(머리가 오지 않은 세대)을 치운다: 업로드 때 24시간 지난 고아 세대를 바로 비우고, cron ⑦이 14일 지난 것을 지운다. 응답의 `reason`이 `recent_orphans`면 `retry_after_s` 뒤 다시 하면 풀리고, `full`이면 머리의 세대만으로 1,000행이 찬 것(장부가 비정상적으로 크다 — 앱의 조각 크기·압축을 볼 것). cron 로그의 `orphanSegments`·`errors`(`purge_orphan_segments`)로 정리 여부 확인. **머리(`ledger_backup`)는 지우지 말 것** |
| 가게 찾기 색인의 기준일이 며칠째 그대로 | Actions의 예약 실행 기록 — 공공데이터 내려받기 실패면 라이브 색인을 그대로 실은 것(요약 `### 가게 색인: …`). 공개 리포는 60일 동안 커밋이 없으면 예약 실행이 꺼지니 Actions 탭에서 다시 켠다([storeidx-pipeline.md](../storeidx-pipeline.md) §6) |
| 담당자가 "매번 인증번호를 다시 받는다"(beta.61 이후) | 브라우저가 저장소를 막는 기관 PC면 그 창을 닫을 때까지만 기억한다(화면 안내 "이 창을 닫기 전까지…"). 서버 토큰은 인증한 때부터 90일 |
| 배포했는데 안 바뀐다 | Pages `--branch=main` 누락(§5) / GitHub Pages 런 실패(§6) / 커스텀 도메인 반영 지연 |
| 새 프론트에서 CORS 오류 | `ALLOW_ORIGIN`에 추가 후 `wrangler deploy`(§8) |
| 관리자 통계가 503 | `ADMIN_TOKEN` 미등록(§7) |

---

## 12. 고아 등록 수동 해제 (운영자 런북)

**언제 필요한가**: 사장님이 앱을 삭제 후 재설치했거나 열쇠 없이 초기화해서, 서버에 **예전 공개키의 등록만 남은** 경우. 새 설치의 등록 시도는 `register-key`가 401 `auth_required`로 거절하고, 앱은 "이 가게는 이미 등록되어 있어요" 안내에서 ①예전 폰 해제 ②열쇠 백업 복원 ③운영자 문의(contact@bapjangbu.com)를 권한다. ①·②가 불가능한 사장님이 ③으로 오면 이 절차를 따른다.

> beta.28부터 설정의 완전초기화는 지우기 전에 서버 등록을 스스로 해제하므로(`wipeDeregisterGate`), 이 절차가 필요한 경우는 **앱 삭제·브라우저 데이터 삭제·PIN 분실 복구 초기화** 뒤의 재등록뿐이다. PIN 분실 복구 경로가 등록을 해제하지 않는 것은 의도된 설계다(무PIN 화면 — 제3자의 가게 가로채기·백업 소실 방지).

**본인 확인(필수)**: 요청 이메일의 가게 이름·주소·전화번호를 받아, 공개된 가게 전화번호로 **직접 전화**해 사장님 본인이 요청했는지 확인한다. 확인 전에는 절대 지우지 않는다 — 이 절차 자체가 소유증명의 대체물이므로, 여기가 뚫리면 서버의 가로채기 방지가 통째로 무력화된다.

### 우선 경로 — 관리자 화면 [휴지통으로] (2026-10~)

본인 확인을 마쳤으면 터미널 대신 `https://app.bapjangbu.com/docs/admin.html`(ADMIN_TOKEN 로그인) → **등록 가게** 표에서 해당 행의 [휴지통으로] → 사유(테스트 등록 / 폐업 / 사장님 요청·본인 확인 완료 / 부당 선점) 고르기 → 메모(선택, 개인정보 금지) → **가게 ID를 그대로 입력** → [휴지통으로 옮기기]. 효과는 아래 터미널 절차 3)과 같고(`/api/admin/deregister`, PROTOCOL §8.4), 미수령 건수·클라우드 백업 유무가 창에 미리 보이며, 처리 내역은 같은 화면의 **운영자 조치 기록**(`admin_action_log`)에 남는다. 전역 24시간 20건 상한이 있다.
- **부당 선점**이면 — ⚠️ beta.55부터 관리자 화면으로 휴지통에 넣은 가게는 **7일 동안 다른 열쇠로 인수할 수 없다**(`409 takeover_locked`, ADMIN_TOKEN 유출 시 "휴지통 → 곧바로 인수" 차단). 선점한 쪽은 같은 열쇠로 언제든 되살릴 수 있으므로, 진짜 사장님이 곧바로 등록해야 하는 부당 선점 정리는 **아래 터미널 절차 3)**으로 한다(감사 행이 없어 잠금이 걸리지 않는다 — 터미널 접근 = Cloudflare 계정 권한이라 토큰 유출과 같은 위험이 아니다). 그 뒤 진짜 사장님이 앱에서 바로 [우리 가게 등록]을 하게 안내한다(다른 열쇠로 먼저 등록하는 쪽이 선착순으로 인수).
- 관리자 화면에는 즉시 삭제·되돌리기·키 지정이 **일부러 없다**(아래 "하지 말 것"과 같은 이유). 화면을 쓸 수 없을 때(서버 배포 전 등)만 아래 터미널 절차를 쓴다.

### 터미널 절차(대체) — **삭제가 아니라 휴지통에 넣는다** (beta.48~)

`/api/deregister`와 같은 방식으로 `deregistered_at`만 찍는다. 담당자에게는 **즉시** '없는 가게'가 되어 재등록이 열리지만, 사장님이 나중에 열쇠 백업을 찾아내면 **30일 안에는 원장 백업을 되찾을 수 있다**([04](04-contracts.md) C12). 즉시 삭제는 그 마지막 복구선까지 함께 없앤다.

```bash
cd server
# 1) 대상 행 확인 — restaurant_id·이름·district가 요청과 일치하는가, 이미 해제된 건 아닌가
npx wrangler d1 execute prepaid-relay --remote --command \
  "SELECT restaurant_id, restaurant_name, district, registered_at, deregistered_at FROM public_key_registry WHERE restaurant_name LIKE '%가게명%'"

# 2) 미수령 신청·잔존 데이터 확인(있으면 사장님에게 고지 후 진행)
npx wrangler d1 execute prepaid-relay --remote --command \
  "SELECT COUNT(*) AS pending FROM deposit_summary WHERE restaurant_id='<ID>' AND status='PENDING'"

# 3) 휴지통에 넣는다(현재 epoch ms를 직접 적는다 — `date +%s000`)
npx wrangler d1 execute prepaid-relay --remote --command \
  "UPDATE public_key_registry SET deregistered_at=<now_ms> WHERE restaurant_id='<ID>' AND deregistered_at IS NULL"
```

이 시점부터 새 열쇠의 `register-key`는 **선착순 신규 등록**으로 통과한다(공공데이터 실존·상호 대조 수행). 다른 키로 등록되는 순간 서버가 **옛 연락처를 스스로 지운다**. 옛 원장 백업(`ledger_backup`·`ledger_backup_seg`)은 beta.55부터 **그 순간 지우지 않는다** — `taken_over_at`(인수 시각)보다 오래된 백업은 새 주인에게 보이지 않고, 인수 30일 뒤 cron이 지운다. 운영자가 따로 지울 필요가 없다. 30일이 지나도록 아무도 등록하지 않으면 cron이 행과 백업(머리·조각)을 함께 정리한다.

#### 인수 뒤 옛 백업 (beta.55 → beta.60)

**beta.60부터**: 다른 열쇠가 인수하는 순간 옛 백업(머리·조각)과 옛 공개키가 **보관 칸**(`ledger_backup_archive*`)으로 옮겨지고, 옛 주인의 해제 시각부터 30일 동안 옛 열쇠로 **읽기만** 할 수 있다(PROTOCOL §4.14). 옛 주인은 앱의 [되찾기] > [서버에서 되찾기]로 직접 받으므로 운영자가 행을 고칠 일은 없다. 아래 수작업은 beta.60 배포 **전에** 인수된 가게(산 표에 `taken_over_at`보다 오래된 백업이 남은 경우)에만 해당한다.

잘못된 인수(착오·토큰 유출)였다면, 인수 후 **30일 안**에는 옛 주인의 백업 행이 그대로 있다(옛 열쇠로 암호화된 상태). 이때 옛 주인이 열쇠 백업을 갖고 있다면 본인 확인 후 운영자가 수작업으로 되돌릴 수 있다 — 단, 새 키를 심는 것이 아니라 **새 주인 등록을 휴지통에 넣고(3) 옛 주인이 자기 열쇠로 다시 등록**하게 하는 순서다(다시 '다른 열쇠 인수'가 되므로 `taken_over_at`이 갱신되고, 그보다 오래된 옛 백업은 여전히 숨겨진다 → 필요하면 `UPDATE ledger_backup SET updated_at=<now_ms> WHERE restaurant_id='<ID>'`로 '지금 주인 것'으로 표시. 이 UPDATE는 본인 확인을 마친 경우에만).

사장님에게는 "앱에서 다시 [우리 가게 등록]을 해 주세요"라고 회신한다. beta.26+ 앱은 district도 함께 실어 보내므로 담당자 웹 관할 목록에 바로 나타난다.

### 즉시 삭제가 필요한 경우 (예외)

폐업·사업자 변경처럼 **되돌릴 일이 없고 옛 백업을 남겨 둘 이유도 없는** 경우, 또는 사장님이 "지금 전부 지워 달라"고 명시적으로 요청한 경우에만.

```bash
# 백업(머리·조각)을 먼저, 키 행을 나중에 — 순서가 뒤바뀌면 아무도 되찾을 수 없는 백업만 남는다
npx wrangler d1 execute prepaid-relay --remote --command \
  "DELETE FROM ledger_backup WHERE restaurant_id='<ID>'"
npx wrangler d1 execute prepaid-relay --remote --command \
  "DELETE FROM ledger_backup_seg WHERE restaurant_id='<ID>'"
npx wrangler d1 execute prepaid-relay --remote --command \
  "DELETE FROM public_key_registry WHERE restaurant_id='<ID>'"
```

**하지 말 것**: `UPDATE public_key_registry SET public_key=...`(새 키를 대신 심는 것 — 사장님 기기의 키를 운영자가 알 방법이 없고 알아서도 안 된다). 자동 만료·무인증 덮어쓰기 기능 추가(활성 가게 가로채기 경로가 된다 — [05](05-invariants.md)). **`deregistered_at`을 되돌려 활성으로 만드는 것**(재활성은 같은 공개키를 가진 기기만 `register-key`로 할 수 있다 — 운영자가 손으로 켜 주면 소유 증명을 우회하는 셈이다).
