# 07 — 배포 런북

5개 서피스는 **배포 파이프라인이 서로 다르다.** `git push` 하나로 전부 나가지 않는다 — 이것이 이 리포에서 가장 흔한 사고 원인이다.

> ⚠️ 원본 배포 문서 `docs/phase2-deploy.md`는 **`.gitignore`에 등재되어 리포에 포함되지 않는다.** 이 런북이 리포에 남는 유일한 배포 문서다.

---

## 1. 서피스별 배포 명령

| # | 서피스 | 명령 | git push로 나가나 |
|---|---|---|---|
| 1 | 음식점 앱 + 문서(`docs/`) | `git push` → GitHub Actions `pages.yml`(리포 루트 전체를 아티팩트로 업로드) | ✅ |
| 2 | 담당자 웹 | `npx wrangler pages deploy agency-web --project-name=prepaid-agency --branch=main` | ❌ |
| 3 | 소개 홈페이지 | `npx wrangler pages deploy homepage --project-name=bapjangbu-home --branch=main` | ❌ |
| 4 | 중계 서버 | `cd server && npx wrangler deploy` | ❌ |
| 5 | D1 마이그레이션 | `npx wrangler d1 execute prepaid-relay --remote --command "<한 문장>"` (§4) | ❌ |

직원용 앱(`staff.bapjangbu.com`)은 **별도 리포 `NULMARU/bapjangbu-staff`** 에서 배포된다. 이 리포에서 나가지 않는다.

---

## 2. 배포 순서 (계약 변경이 있을 때)

```
① D1 마이그레이션   →  ② 서버(wrangler deploy)  →  ③ 음식점 앱(git push)  →  ④ 담당자 웹(pages deploy)
```

**이유**: 서버가 먼저 새 필드·새 응답을 **받아들일 수 있어야** 신버전 클라이언트가 깨지지 않고, 구버전 클라이언트도 계속 동작해야 한다(서버는 하위 호환을 유지하도록 작성돼 있다). 순서가 어긋나면 라이브 승인/제출이 **일시적으로 깨진다**.

- 음식점 앱을 담당자 웹보다 먼저 내보내는 이유: 앱은 **수신자**다. 수신 가능해진 뒤에 발신을 바꾼다.
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
bash harness/verify-all.sh    # 10/10 기대
```

**`verify-all.sh`의 앱 체크(8번)는 `beta.[0-9]+` 패턴만 본다 — 구버전이 떠 있어도 통과한다.** 배포 판정에 쓰지 말 것([06-testing.md](06-testing.md) §2).

**커스텀 도메인 반영에 수십 초~1분 지연**이 있을 수 있다. 한 번 실패했다고 재배포하지 말고 다시 확인할 것.

---

## 4. D1 마이그레이션 (함정 있음)

- 마이그레이션 파일: `server/migrations-2026-07.sql` — **append-only**. 기존 문장을 수정하지 말고 아래에 추가한다.
- 🔴 **`wrangler d1 execute --remote --file`을 쓰지 말 것.** OAuth 토큰과 import API가 비호환이라 **오류 2036**이 난다.
  → **`--command`로 문 단위 실행**할 것.
  ```bash
  cd server
  npx wrangler d1 execute prepaid-relay --remote --command "CREATE TABLE IF NOT EXISTS foo (…)"
  ```
- SQLite `ALTER TABLE ADD COLUMN`은 **이미 존재하면 에러**다. 파일 안에 주석으로 `이미 적용된 D1에는 재실행 금지`라고 표시된 문장들이 그 대상이다(예: `processed_at`, `agency_email_hash`, `contact_kakao`, `contact_email`, `district`).
- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`는 재실행 안전.
- 적용 후 즉시 `npx wrangler deploy`로 서버를 올릴 것(스키마만 바뀌고 코드가 구버전이면 새 컬럼이 채워지지 않는다).
- 확인:
  ```bash
  npx wrangler d1 execute prepaid-relay --remote --command "PRAGMA table_info(public_key_registry)"
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
| `crons` | `17 18 * * *` | TTL 정리(UTC 18:17 = KST 03:17) |

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
2. `bash harness/verify-all.sh` → 10/10.
3. 계약 변경이 있으면 §2 순서를 따른다.
4. `git push` → Actions 완료 대기.
5. §3의 콘텐츠 문자열로 **라이브 확인**.
6. `CLAUDE.md`의 「현재 상태」·「완료」 절에 변경 내역을 기록한다(이 리포의 실질적 릴리스 노트다 — `CHANGELOG.md`는 beta.8에서 멈춰 있다, [10-code-review.md](10-code-review.md) 참조).

---

## 11. 장애 대응 빠른 참조

| 증상 | 먼저 볼 곳 |
|---|---|
| 담당자 웹에 관할 음식점이 안 뜬다 | D1 `public_key_registry.district`가 채워졌는가 → 앱의 `relayDistrict()`·자동 치유([04](04-contracts.md) C2) |
| 담당자가 "인증번호가 안 온다" | Resend 하루 100통 한도(`429 email_quota_exceeded`) / `AUTH_MODE`가 `prod`인가 / `RESEND_API_KEY` 등록 여부 |
| 음식점 앱이 명단을 못 받는다 | `batch_hash` 불일치([04](04-contracts.md) C1) / 72시간 만료 / 승인 후 재조회 |
| 담당자가 "보냈는데 없어졌다" | `deduped:true` 응답 확인([04](04-contracts.md) C6) / `batch_hash` 충돌([04](04-contracts.md) C1 부수 계약) |
| 배포했는데 안 바뀐다 | Pages `--branch=main` 누락(§5) / GitHub Pages 런 실패(§6) / 커스텀 도메인 반영 지연 |
| 새 프론트에서 CORS 오류 | `ALLOW_ORIGIN`에 추가 후 `wrangler deploy`(§8) |
| 관리자 통계가 503 | `ADMIN_TOKEN` 미등록(§7) |
