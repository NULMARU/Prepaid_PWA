# 06 — 테스트 체계

한 줄 요약: **`bash harness/verify-all.sh` → 16/16이 정상**(로컬 8 + 라이브 5 + 접속 3, 2026-11-13 기준). beta.60(2026-11-17, 배포 전) 로컬 수치: phase2 **919** · 마이그레이션 조합 **31** · 반응형 **3,725** · e2e beta.60 블록 53·36·64 · 설치 안내 **163** · 서비스워커 **12** · 담당자 웹 4종 **133** · 직원 앱 beta60 **78**. (beta.55 때: phase2 735 · 반응형 3,215 · e2e beta.55 블록 70·63·101 · 담당자 웹 4종 99 · 갱신 보존 beta.54→55 29/29.) verify-all 항목 구성은 `harness/verify-all.sh`가 원본이다. 실패 로그는 `/tmp/v1.log`~`/tmp/v9.log`.

> 아래 단언 개수는 **표에 적은 릴리스의 실행 기준**이며 릴리스마다 늘어난다. 개수 자체가 아니라 **책임 분담과 공백**을 보라.
> `git push` 시에는 GitHub Actions가 서버 계약 하니스·정적 검사·링크 검사·앱 기동 스모크를 **배포 게이트**로 먼저 돌린다(§2.1).
> **배포할 때마다 `git tag live-betaNN <배포 커밋>`을 남길 것** — 갱신 보존 게이트가 그 태그를 "지금 라이브인 앱"으로 쓴다(§2.2).

---

## 1. 하니스 책임 분담표 (브라우저·서버 하니스 + 정적 검사)

| 하니스 | 대상 | 브라우저 | 서버 | 검증 규모 | 실패 방식 |
|---|---|---|---|---|---|
| `prepaid.e2e.js` | **실제 `index.html`** (로컬 정적 서버 + Playwright chromium) | ✅ | ❌ 전 `/api/**`를 `context.route`로 목킹 | `assert()` 호출 1,111곳 | fail-fast, `exit 1` + 성공 시 `{"ok": true, …}` JSON. beta.55 블록은 `E2E_ONLY=beta55`(A1a 70)·`beta55b`(A1b 63)·`beta55c`(A2·A3 백업 101)로, beta.60 블록은 `E2E_ONLY=beta60a`(잠금·복구 53)·`beta60b`(명단·CSV 26)·`beta60c`(기타 57)로 따로, `E2E_SOFT=1`이면 단언별 실패 목록 |
| `phase2.e2e.mjs` | **실제 worker 코드** — `import { handle, makeMemoryStore } from '../server/src/worker.js'` | ❌ | ✅ 로직은 진짜. 저장소는 메모리 store **와** `node:sqlite` D1 어댑터(실제 `makeD1Store` SQL)를 같은 시나리오로 | 최근 실행 **919 통과**(beta.60) | 누적 카운트, `결과: N 통과, M 실패` |
| `phase2.migrate.mjs` | **라이브 태그(기본 `live-beta59`)의 옛 `schema.sql` + 라이브에 있을 법한 행** 위에 `migrations-2026-11b.sql`을 **한 문장씩** 실행한 DB | ❌ | ✅ 새 `worker.js`를 그 DB에 붙여 beta.59 앱식 호출·beta.60 호출·cron을 돌린다 | **31 검사**(beta.60 신설) | 누적 카운트. 기준 태그는 `MIGRATE_BASE_REF` |
| `phase2.live.mjs` | **배포된 라이브 서버 + 실제 D1** | ❌ | ✅ 진짜(프로덕션 D1을 실제로 쓴다) | 6단계 | 누적 카운트 |
| `responsive.e2e.mjs` | **실제 `index.html`** 의 기하(레이아웃) | ✅ | ❌ `/api/**` 전부 `200 []` 스텁 | 폰 4뷰포트(+디바이스 프로파일) + **태블릿 가로·세로 6종**(beta.55) · 최근 실행 **3,725 검사**(beta.60) | 누적, 실패 목록 출력 |
| `dongsearch.e2e.mjs` | **실제 `index.html`** 의 동 이름 검색(zipmap 순회 보조 경로) | ✅ | ❌ 공공 API 한글 장애를 목으로 재현 | **46 검사**(beta.52) | 누적 카운트 |
| `agency-xlsx.e2e.mjs` | **실제 `agency-web/index.html`** — 엑셀(.xlsx) 양식 다운로드·업로드·금액 검증(beta.60: 수식 칸·이름 길이·3,000명) | ✅ | ❌ 외부 요청 전부 404 | **39 검사**(beta.60) | 누적, `N pass` |
| `agency-csvchoice.e2e.mjs` | 담당자 웹 3단계 — 명단 파일 바꾸기/덧붙이기·되돌리기·비우기 | ✅ | ❌ 외부 요청 전부 404 | **19 검사**(2026-10-31) | 누적, `N pass` |
| `agency-sent.e2e.mjs` | 담당자 웹 — 급량개수×1식 단가, 보내기 완료 잠금·다시 보내기 | ✅ | ❌ `/api/submit`만 목 | **47 검사**(beta.60 — 보내는 중 잠금·만료 표시와 새로 보내기·재시도 지문 재검증 추가) | 누적, `N pass` |
| `agency-net.e2e.mjs` | 담당자 웹 — 전송 중 인증 만료(즉시 중단·1단계 이동·같은 접수번호 재시도), 목록 조회 실패 [다시 시도]·늦은 응답 버림, 지문 기록 조회 실패 시 전송 차단 | ✅ | ❌ 네트워크 목 | **28 검사**(beta.60 — 인증 만료 뒤 화면 가림·무조작 폐기·직접 입력 기관 추가) | 누적, `N pass` |
| `experimental/upgrade.e2e.js` (+ 래퍼 `upgrade-check.sh`) | **구버전 앱의 실제 UI로 만든 장부**를 신버전 앱이 그대로 여는지(IndexedDB 필드 단위 비교) | ✅ | ❌ 전부 목 | beta.54→55 2모드 합계 **29/29**(래퍼 출력) | 누적, 실패 시 보고서 JSON |
| `install.e2e.mjs` | **실제 `index.html`** — 홈 화면에 추가 안내(UA·`display-mode`·`navigator.standalone`·터치 수를 흉내 낸 안드로이드 크롬/iOS 사파리/카카오톡 인앱/설치됨 등 분기), 설치 창 1회, 홈 배너, "이 기기에 저장" 안내 | ✅ | ❌ 외부 요청 전부 목 | **163 검사**(beta.60 신설) | 누적. `APP_HTML=`로 수정 전 사본 |
| `sw.e2e.mjs` | **실제 `sw.js`를 서비스워커로 등록**하고 서버가 앱 화면에 503·404를 줄 때 캐시 화면으로 대신하는지 | ✅ | ❌ 로컬 정적 서버 | **12 검사**(beta.60 신설) | 누적. `SW_FILE=`로 수정 전 사본 |
| `backup-pass.e2e.mjs`·`unregistered.e2e.mjs` | 백업 암호 기억(beta.59, 33)·미등록 가게 서버 호출 0(beta.58, 29) | ✅ | ❌ 목 | 33 · 29 | 누적 |
| 직원 앱 `harness/beta60.e2e.mjs` (별도 리포 `bapjangbu-staff`) | 직원용 기록장 beta.60 수정 묶음(문장 입력 충전/사용 고르기·지점·날짜·200곳·전체 초기화 등) | ✅ | ❌ 목 | **78 검사** | 누적. Playwright는 이 리포 `node_modules` 참조 |
| `app-smoke.mjs` | 빈 브라우저로 `index.html?e2e=1` 기동 — 첫 화면·[시작하기]·콘솔 오류 0·외부 요청 0 | ✅ | ❌ 외부 요청 전부 차단 | 5 검사 | `exit 1` (CI 게이트용) |
| `check-static.mjs` | 파일만 읽음 — meta 키⊂`META_KEYS`(+`META_DEVICE_KEYS`·`backupCore` 제외 키), `APP_VERSION`=`CACHE_NAME`, `server/src` NUL 바이트, 기관 수 vs 문서 표기 | ❌ | ❌ | 7 검사 | `exit 1` |
| `check-links.mjs` | 파일만 읽음 — `homepage/*.html`·`docs/*.html`의 상대 링크·파일·앵커, 우리 도메인 절대 주소(로컬 파일로 대응), 오래된 "beta.NN 기준" 표기 경고 | ❌ | ❌ | 링크 217개(2026-11-13) | `exit 1`(경고는 실패 아님) |

이전 기록: phase2 427(beta.48)→478(beta.53)→735(beta.55, D1 어댑터 포함)→**919**(beta.60), 반응형 2,625(beta.49)→2,781(beta.53)→3,215(beta.55)→**3,725**(beta.60), 담당자 웹 4종 99(beta.55)→**133**(beta.60: xlsx 39·csvchoice 19·sent 47·net 28).

보조: `harness/build-agencies.mjs`·`harness/build-zipmap.mjs`는 **테스트가 아니라 데이터 생성기**(기관 목록·우편번호 매핑 재생성). `verify-all.sh`가 돌리지 않는다.
`harness/check-manual-pdfs.py`는 안내서 PDF(`docs/manuals/*.pdf`) 검사기다(파일 0개·빈 쪽·쪽 밖 글 상자 = 실패, 쪽수 출력). pymupdf가 필요해 verify-all에는 넣지 않았다 — PDF를 다시 만들 때 `uv run --with pymupdf python harness/check-manual-pdfs.py`.

### 무엇을 검증하는가 / 무엇을 검증하지 않는가

**`prepaid.e2e.js` — 음식점 앱 클라이언트의 행동 전부**
- 검증: 온보딩 3단계(검색 경로·직접 입력 탈출구·약관 게이트), **`register-key` payload의 `district`가 실제로 실리는지**, district 자동 치유, PIN·5회 실패 60초 지연(meta 영속), 홈 그룹 아코디언·정렬·라벨 규칙, CSV(소속 열·헤더 3종·레거시 혼합·재승인=충전), 백업 6종 계약 + 자동 클라우드 트리거, 등록 롤백/성공, 손님 셀프 조회 전 구간(초성·접두·동명이인 병합·부분 갱신 노드 동일성), **B단계 요청 흐름 전체**(TTL 119/121 경계, 유휴 시계, 잠금 스윕, 중복 저장 없음, 백업에 흔적 없음), 잠금 중 파일 input 3종 직접 발화 차단, 복구 60초 게이트, 해시 체인 결정성(20회 반복), 동명이인 `·N` 마커, 그리고 **콘솔 오류 자체를 단언**(화이트리스트 초과·미등록 오류·`innerHTML` 오류 = 실패).
- **beta.48 추가**: 승인 아웃박스 전 시나리오([04](04-contracts.md) C11) — 통보 500 시 거래 1회·항목 유지·상태 배지 / 재알림해도 거래 증가 없음 / **앱 재시작 후에도 대기열 유지, 잠금(손님) 화면에서는 통보하지 않음** / 서버가 같은 신청을 다시 올려도 승인 버튼이 돌아오지 않음 / 409·404는 성공 처리 / 거절도 응답을 보고 판단. 그리고 **[저장] 연타**(한 틱에 두 번 호출해도 거래 1건, C-`withTxLock`), **잠긴 백업**(평문 이름 미포함·`type` 확인·`lastBackupAt` 불변·2차 취소 시 장부 유지·같은 기기에서 복원 성공, C13), **`transfer_id` 재열기 차단**(C10), **`register-key`의 `auth_token` 동봉**(C14), 접힌 클라우드 카드 요약 문구(미등록 가게에 "켜짐"이 뜨지 않을 것), 손님 잔액 초과 시 **두 오류 슬롯 + 입력칸 테두리**.
- 미검증: 서버 실제 응답(전부 목), 서비스 워커, 데스크톱·태블릿 레이아웃, iOS 실엔진.
- ⚠️ HEAD `b60add2`(beta.47) 시점의 이 하니스는 **라벨 없는 `console.error` 때문에 이미 실패 상태**였다(콘솔 오류 단언에 걸림). beta.48에서 라벨을 부여해 해소했다 — "예전에는 통과했는데"라고 가정하지 말 것.

**`phase2.e2e.mjs` — 서버 계약 전부 (42개 섹션)**
- 검증: 공개키 등록/재등록(멱등·소유증명), 검색 프록시, 암호화 왕복 + `batch_hash` 대조, **평문 미저장**, 수신함, 소유증명 인증 전 구간(토큰 1회용), 금액/인원 검증, 멱등 중복 제출, CORS, 에러 일반화, 클라우드 백업/삭제, OTP 4모드(dev/pilot/prod/키 미설정) + Resend 429·비2xx·네트워크 실패, `REQUIRE_AGENCY_AUTH` 게이트 + consent 이메일 해시, 레이트리밋 2종, **보존 정책 §6 a~f**(즉시 파기·72h 만료·30일 삭제), 연락처, 비식별 집계·관리자 API·피드백, **§20 district a~j**(정확 일치·부분문자열 충돌 3쌍·와일드카드 이스케이프·100자 상한), `inbox-count`, `deduped/status`, 고아 summary 제외, **§25 `org`는 `batch_hash`에 영향 없음**, 열쇠 지문 확인, 등록 실존 대조, 수신함 인증, OTP 남용 차단, 보안 헤더, 이메일 해시 pepper, 챌린지 상한.
- **beta.48 추가 섹션**: §35 접수번호·중복 판정(같은 sid=1행 / 다른 sid=2행 / 구버전은 같은 달만 멱등), §36 **원자 저장**(blob 삽입 고장 주입 → 500 + summary·blob·inbox 전부 0건, 이어서 정상 재시도 → 각 1), §37 **고아 요약 복구**(PENDING·72h·blob 없음일 때만 `repaired:true`), §38 ciphertext 화이트리스트, §39 district 변경 권한 경계, §40 keycheck 도메인 결속, §41 **등록 해제 30일 휴지통 종합 시나리오**(public-key 404 → 목록 제외 → 백업 get 성공 → 백업 POST 409 → 같은 키 `reactivated` → 다른 키 선착순 인수 + 옛 백업 삭제 → 30일 경과 cron), §42 **cron 바인딩 상한**(목 store가 문장당 바인딩 ≤100을 직접 세어 `CLEANUP_CHUNK` 회귀를 잡는다).
- 미검증: **D1 SQL 자체**(§4 참조), 브라우저 클라이언트, 실제 이메일 발송.

**`phase2.live.mjs` — 배포 스모크 6단계**
- 검증: 등록 → 공개키 조회 → 하이브리드 암호화 + `batch_hash` 왕복 → **무토큰 제출 401** → **무효 토큰 제출 401** → 소유증명 등록 해제.
- 미검증(명시적 선언): "라이브 하니스는 이메일을 수신할 수 없어 OTP 토큰을 얻지 못하므로 **제출 happy-path는 검증하지 않는다**". 또한 `district`를 보내지 않으므로 **라이브 `registered-list` 경로는 한 번도 실제로 확인되지 않는다.**
- 부작용: 프로덕션 D1에 `DEMO-<ts>-<rand>` 행을 만들고 지운다.

**`responsive.e2e.mjs` — 폰 기하만**
- 검증: 360×640 / 390×664 / 412×732 / 768×1024에서 가로 스크롤 없음, 이름·금액 잘림 없음, 터치 타깃 크기, 모달 버튼이 화면 안, **`fits` 계약**(요청 화면·상세 화면·오류 표시 상태·손님 요청 사용 모달), 금액 입력 중 서명 비소멸, 손님 검색 타이핑 회귀(Pixel 7 / iPhone 13 프로파일, 한글 IME `compositionend` 시퀀스, **노드 동일성 expando + focusout 카운터**).
- beta.48: 손님 compose 화면의 잔액 초과 안내 — 위·아래 두 오류 줄의 문구가 같고, 잔액 금액을 함께 말하고, 입력칸 테두리가 danger가 되고, 글자가 15px 이상이고, **두 줄이 다 떠도 [사장님 확인 받기]의 좌표가 ±1px 안에서 고정**되며 `fits` 계약을 유지한다. 두 오류 슬롯이 뜨든 안 뜨든 **항상 한 줄 높이를 차지하도록** 만들어 둔 덕분이다(예전에는 오류가 뜨는 순간 버튼이 접힘 아래로 밀렸다).
- 미검증: 기능·데이터·서버(전부 스텁). 오직 레이아웃·입력 생존.

**`dongsearch.e2e.mjs` — 동 이름 검색 보조 경로**
- 검증: 0건일 때만 동 검색이 권해지는가, zipmap의 실제 구역만 두드리는가, 전 구역 완주·[그만 찾기]/[계속 찾기], **시·도 비추측 원칙**(동만 적으면 전국을 뒤지지 않는다).
- 목은 **실서버처럼 `q` 상호 필터를 재현해야 한다** — 재현하지 않으면 조기 발견 시나리오가 오염돼 상한 검증이 공허해진다(실제로 한 번 걸렸다).

---

## 2. `verify-all.sh` 16항목

| # | 그룹 | 라벨 | 판정 |
|---|---|---|---|
| 1 | [1] 로컬 | phase1 e2e (설정·PIN·차감·서명·백업·초기화) | `grep '"ok": true'` |
| 2 | | phase2 목 하니스 — 등록→암호화→복호화→batch_hash→변조탐지→해제 | exit code |
| 3 | | 폰 반응형 e2e — 360/390/412/768px | exit code |
| 4 | | 동 이름 검색 e2e — zipmap 전 구역 완주·비추측 원칙 | exit code |
| 5 | | 담당자 웹 e2e 4종(xlsx·csvchoice·sent·net) | 넷 다 exit 0 (통과 수 합계 표시) |
| 6 | | **정적 계약 검사** (`check-static.mjs`) | exit code |
| 7 | | **문서·홈페이지 링크** (`check-links.mjs`) | exit code(경고는 개수만 표시) |
| 8 | | **갱신 보존** (`upgrade-check.sh` — 최신 `live-beta*` 태그 → 작업 트리, 일반·서비스워커 2모드) | exit code |
| 9 | [2] 라이브 | phase2 라이브 6단계 — 인증강제 포함 | exit code |
| 10 | | 공공API 실검색(**우편번호** — ASCII) | 결과 건수 > 0 |
| 11 | | 공공API 상호 필터(우편번호 + 상호) | 결과 건수 > 0 |
| 12 | | 폐업 자동 제외 | 응답에 `폐업` 없음 |
| 13 | | **평문 개인정보 제출 거부(불변식)** | 응답에 `형식 오류` 포함 |
| 14 | [3] 접속 | 음식점 앱 | 라이브 `APP_VERSION` == 로컬 `APP_VERSION` |
| 15 | | 담당자 웹 | HTTP 200 |
| 16 | | 중계 서버 | HTTP 200 (레이트리밋 대비 1회 재시도) |

**⚠️ 14~16은 생존 확인일 뿐 배포 확인이 아니다.** 14는 라이브와 로컬의 `APP_VERSION`을 대조하므로 **앱은** 구버전 서빙을 잡아내지만, 담당자 웹·홈페이지·서버는 200만 본다. 그쪽 배포 성공은 반드시 [07-deploy-runbook.md](07-deploy-runbook.md)의 "라이브 콘텐츠 문자열" 방식으로 확인할 것.

**부수 주의**
- 체크 10~12는 `python3`가 없으면 조용히 실패로 떨어진다.
- 체크 10·11이 **우편번호(ASCII)** 기준인 것은 공공데이터 API가 2026-08-08부터 한글 조건값에 0건을 주는 회귀 상태이기 때문이다. 한글로 확인하면 **API가 살아 있어도 죽은 것으로 오판**한다.
- 체크 13은 worker.js의 한국어 오류 문구 `형식 오류`에 의존한다 — 문구를 바꾸면 **진짜 통과가 거짓 실패**가 된다([04](04-contracts.md) C7).
- 체크 6의 "기관 수"는 `agency-index.json`을 세어(2026-11-13: 17개 시도·475 기관, 보건소 229) `CLAUDE.md`·`docs/agency-data-pipeline.md`·`docs/handover/0*.md`의 "N개 시도·M 기관" 표기와 대조한다. 10~12번 문서는 날짜가 박힌 검토 기록이라 대조하지 않는다.
- 체크 8은 같은 origin에서 구버전→신버전을 차례로 연다. 일반 모드는 `/sw.js`를 404로 막아 순수 데이터 보존을, `--sw 1` 모드는 실제 태블릿처럼 서비스워커 배포를 흉내 낸다. 산출물은 `$TMPDIR/bapjangbu-upgrade/gate-*-report.json`.

### 2.1 CI 배포 게이트 (`.github/workflows/pages.yml`, beta.48 → 2026-11-13 확장)

`main`에 push하면 **`test`·`smoke` job이 먼저** 돌고, `deploy` job이 `needs: [test, smoke]`로 둘 다 기다린다.

```yaml
test:   node harness/phase2.e2e.mjs      # ubuntu-latest, setup-node@v4 (node 20), 의존성 없음
        node harness/check-static.mjs    # META_KEYS·APP_VERSION=CACHE_NAME·NUL·기관 수
        node harness/check-links.mjs     # 문서·홈페이지 상대 링크·앵커
smoke:  npm install && npx playwright install --with-deps chromium   # LANG=C.UTF-8
        node harness/app-smoke.mjs       # 빈 브라우저 기동 → 첫 화면·[시작하기]·콘솔 오류 0
deploy: needs: [test, smoke]             # 하나라도 실패하면 GitHub Pages 배포 자체가 일어나지 않는다
```

- `smoke`는 Playwright를 `package.json` 버전으로 깔고 **브라우저도 그 Playwright의 install 명령으로** 받는다 — 미리 깔린 브라우저와 빌드 번호가 어긋날 일이 없다(CLAUDE.md 리눅스 주의 ②). 앱 기동만 보므로 글꼴 차이(주의 ③)에 걸리지 않는다.
- 전체 시나리오(prepaid e2e·responsive·dongsearch·담당자 웹 3종·갱신 보존)는 **글꼴·로케일·실행 시간 때문에 CI에 넣지 않았다.** 그쪽은 여전히 로컬 `bash harness/verify-all.sh`의 몫이다.
- `check-static.mjs`의 기관 수 대조는 문서 표기에도 걸린다 — `agency-index.json`을 다시 만들면 CLAUDE.md 등의 "N개 시도·M 기관"도 같이 고쳐야 배포가 나간다.
- ⚠️ 이 게이트가 막는 것은 **음식점 앱·docs의 GitHub Pages 배포**뿐이다. 담당자 웹·홈페이지·중계 서버는 `wrangler`로 따로 나가므로 **게이트를 거치지 않는다**([07](07-deploy-runbook.md) §1).

### 2.2 배포 태그와 갱신 보존 게이트 (2026-11-13)

필드테스트 태블릿의 장부는 앱을 갱신해도 그대로 열려야 한다(CLAUDE.md "장부 보존"). 그래서 **"지금 라이브인 앱"으로 만든 장부를 "이번에 배포할 앱"이 여는지**를 배포 전에 본다.

- **배포가 끝나면 반드시 태그를 남긴다**: `git tag live-beta55 <배포한 커밋>` (그리고 `git push origin live-beta55`). 음식점 앱(`index.html`·`sw.js`)이 바뀐 배포에만 필요하다.
- `bash harness/upgrade-check.sh`가 구버전을 고르는 순서: `--old-ref`/`UPGRADE_OLD_REF` → **버전 순으로 가장 최신 `live-beta*` 태그** → `origin/main` → `main`. 태그가 없으면 폴백했다고 화면에 적는다(origin/main이 라이브와 다를 수 있다 — 배포 전 커밋이 push만 된 경우).
- 신버전: 기본은 작업 트리. `--new-ref HEAD`처럼 커밋을 줄 수도 있다(작업 중인 파일이 반쯤 고쳐져 있을 때 래퍼 자체를 확인하는 용도).
- 실행 시간 약 1분(2모드 합계). 외부 요청 없음(중계 서버 전부 목).

---

## 3. 알려진 커버리지 공백 (이관 시 반드시 인지)

| # | 공백 | 근거·이력 | 위험도 |
|---|---|---|---|
| G1 | **(일부 메움)** `agency-web/index.html`을 브라우저로 구동하는 하니스는 4종(xlsx·csvchoice·sent 2026-10-31~11-06, net beta.55)이 생겼다 — 엑셀 양식·업로드, 파일 바꾸기/덧붙이기, 급량개수×단가, 보내기 완료 잠금, 인증 만료·목록 실패 | 아직 미검증: `canonOf()`/`batchHash()`가 앱·서버와 같은 값을 내는지, `jurisQuery()`, OTP UI, 열쇠 지문 확인 게이트, 복수 전송·429 페이싱, **`submission_id` 발급 규칙**([04](04-contracts.md) C9 — "재시도는 같은 sid, 새 [보내기]는 새 sid"). 하니스들은 각자 `batch_hash`를 **독립 재구현**해서 쓴다(3벌) | 중 |
| G2 | **실제 클라이언트 ↔ 실제 worker를 잇는 테스트가 없다** | `prepaid.e2e.js`는 API 전부 목, `phase2.e2e.mjs`는 브라우저 없음. 필드명 불일치는 "독립적으로 쓰인 두 기대값이 우연히 일치"할 때만 잡힌다 — **`district` 장애가 정확히 이 계열**이었다 | **높음** |
| G3 | **(beta.55에서 메움)** ~~`makeD1Store`(실제 SQL)를 실행하는 테스트가 없다~~ — phase2가 `node:sqlite` 어댑터로 실제 D1 문장을 같은 시나리오로 돈다. 남은 차이: 운영 D1의 배치·타이밍·바인딩 상한은 로컬 sqlite와 다를 수 있다 | `phase2.e2e.mjs`는 `makeMemoryStore()`(같은 파일 안의 두 번째 구현)를 쓴다. §20-h(부분문자열 충돌·LIKE 이스케이프), §23(JOIN 시맨틱), §24(100개 청크)처럼 **SQL 성격의 단언이 전부 JS 메모리 구현에 대해서만 증명**돼 있다. 등가성은 주석으로만 주장된다 | **높음** |
| G4 | 라이브 제출 happy-path 미검증(OTP 수신 불가) + 라이브 `district`/`registered-list` 미검증 | `phase2.live.mjs` 스스로 선언. 라이브 관할 목록이 비어 있어도 하니스는 모른다 | 중 |
| G5 | **(일부 메움)** `sw.js` | `APP_VERSION`↔`CACHE_NAME` 일치는 `check-static.mjs`가, 구→신 서비스워커 배포 경로(새 버전 로드·구 캐시 정리)는 갱신 보존 게이트 `--sw 1` 모드가 본다. 오프라인 동작·교차 출처 캐시 차단은 여전히 무단언 | 낮음 |
| G6 | `docs/admin.html` 미검증 | 엔드포인트(`/api/admin/stats`)만 §19에서 검증 | 낮음 |
| G7 | **(일부 메움)** 홈페이지·안내서·방침 | 상대 링크·앵커·우리 도메인 절대 주소는 `check-links.mjs`가 본다(2026-11-13). 문구가 앱 동작과 맞는지는 여전히 사람 확인 | 낮음 |
| G8 | 체크인된 `agency-index.json`이 `build-agencies.mjs` 산출물과 일치하는지 미검증 | 원자료 TSV가 리포에 없다 | 낮음 |
| G9 | 데스크톱·태블릿(>768px), iOS 실엔진, 접근성, TWA 래퍼 미검증 | chromium 단일 | 낮음 |
| G10 | **동시성·중단 경계가 "헤드리스 한 틱" 기준으로만 증명돼 있다** | beta.48이 `withTxLock`을 `page.evaluate`의 `Promise.all` 두 호출로 단언한다. 실제 폰의 **더블탭**(수십 ms 간격 · 두 번의 실제 터치 이벤트)과, 운영 D1에서의 `DB.batch` 타이밍·부분 실패는 여전히 재현되지 않는다. 승인 아웃박스의 재시작 시나리오도 **같은 프로세스 안의 재로드**다 | 중 |

### beta.48에서 메운 공백

전부 "돈이 두 번 들어가는 길"이었고, 전부 **수정 전 코드로 되돌리면 실패하는 형태**로 고정했다.

| 메운 것 | 어디에 |
|---|---|
| 승인 통보 실패 후 재시도 — 장부 1회·대기열 유지·재시작 후에도 유지·잠금 화면 미실행 | `prepaid.e2e.js` (C11) |
| 저장 연타(한 틱 두 번)여도 거래 1건 | `prepaid.e2e.js` (`withTxLock`) |
| 제출의 원자 저장 — 고장 주입 시 summary·blob·inbox **전부 0건** | `phase2.e2e.mjs` §36 |
| 고아 요약 복구의 3조건(PENDING·72h·blob 없음) | `phase2.e2e.mjs` §37 |
| cron 바인딩 상한 — 목 store가 문장당 바인딩 수를 직접 센다 | `phase2.e2e.mjs` §42 |
| 잠긴 백업 파일에 평문 직원 이름이 없음 + 같은 기기 복원 성공 | `prepaid.e2e.js` (C13) |

**남은 것**: 위 G10(실기기 더블탭·운영 D1 타이밍), G1(담당자 웹 자동 하니스 — `submission_id` 규칙이 사람 확인에만 의존), G4(라이브 제출 happy-path).

### beta.60에서 메운 공백

| 메운 것 | 어디에 |
|---|---|
| **라이브 옛 스키마 + 마이그레이션 문장**의 조합(새 `schema.sql` 통째 적재만으로는 안 보이던 것) | `phase2.migrate.mjs` |
| 복구 화면 — PIN도 백업 암호도 모르면 "전부 지우기"뿐(예전 시나리오는 이제 **막혀야** 함), 게이트 종료 뒤 화면 유지 | `prepaid.e2e.js` `runBeta60a` |
| CSV 합계 줄은 칸 전체일 때만·동명이인 `·N` 보존·미리보기 이름 = 충전 대상(세 경로) | `runBeta60b` |
| 서버 백업 가게 전화 제외·서버 백업 삭제 직렬화·모달 입력 보존·보관 칸 되찾기·재등록 토큰·`segments_missing` 한 번 재시도 | `runBeta60c` |
| 설치 안내 분기(실기기 없이 UA 흉내) | `install.e2e.mjs` |
| 서비스워커의 앱 화면 비정상 응답 폴백 | `sw.e2e.mjs` |

새 단언은 구역마다 수정 전 코드에서 실패함을 확인했다(구역 보고). 남은 것(실기기): 아이폰 홈 화면 앱의 파일 저장·공유, 카카오톡 인앱 화면의 크롬 링크, iOS 26의 공유 버튼 위치, 삼성 인터넷 설치 — [09](09-open-items.md) G3.

### beta.55에서 메운 공백

| 메운 것 | 어디에 |
|---|---|
| 실제 D1 SQL 문장 실행(G3) | `phase2.e2e.mjs` — node:sqlite 어댑터 |
| 서버 백업 v2 계약을 **강제하는** 목(토큰 1회용·gen 형식·조각/머리 상한·머리가 다른 세대 삭제·구서버 404) + 끊긴 업로드·고아 조각·열린 조각 복원 | `prepaid.e2e.js` `runBeta55c` |
| 예전 형식 파일(평문·잠긴·열쇠·클라우드 v1)을 **beta.54 실제 UI로 만든 픽스처**로 복원 | `harness/fixtures/beta54-*.json` + `runBeta55c` |
| 태블릿 가로·세로 fits(손님 compose·사장님 확인·사용 모달·증표) | `responsive.e2e.mjs` |
| 두 창 동시 열기(Web Locks)·명단 음수 금액·1비트 서명 | `runBeta55` |
| 사용 등록 창 초점·확인 대기 60초·증표 닫으면 손님 화면 | `runBeta55b` |
| 담당자 웹 인증 만료·목록 실패 | `agency-net.e2e.mjs` |

새 단언은 구역마다 **수정 전 코드에서 실패함을 확인**했다. 남은 것: 실기기(안드로이드 태블릿 공유 시트·가로 키보드), 엑셀 실물로 .xlsx 열기.

### 이 공백들이 만든 실제 사고 (반복 금지)

- **district 전국 0건(2026-08-03)** — G2·G3의 결과. 서버 계약 테스트는 만점인데 클라이언트가 그 필드를 만들어 보내지 않았다. **verify-all 9/9인 채로 라이브가 비어 있었다.** 대응으로 `prepaid.e2e.js`가 **실제 payload를 가로채 단언**하도록 바꿨다.
- **모바일 IME 입력 불가(beta.20)** — 헤드리스 테스트가 "화면이 갱신되는가"만 봤다. **"입력 노드가 살아남는가"(노드 동일성·focusout 0회)** 로 단언을 바꾸자 수정 전 코드에서 141건이 실패했다.
- **접힘(fits) 계약을 한 화면에만 걸었던 것(beta.25)** — 나머지 화면은 구조적으로 검증되지 않았고 상세 화면 버튼 3개가 폰에서 전부 접힘 아래에 있었다.
- **`consoleProblems` 수집만 하고 검사 안 하던 구멍(beta.23)** — 렌더 예외 10건이 조용히 지나가고 있었다. 이제 단언 대상이다. ⚠️ 이 단언은 **라벨 없는 `console.error`에도 걸린다** — beta.47 HEAD가 실제로 그 이유로 실패 상태였다. 오류를 찍을 때는 반드시 식별 가능한 라벨을 붙일 것.
- **"승인은 했는데 서버가 못 받은" 상태를 아무 하니스도 보지 않던 것(beta.48)** — 승인은 두 걸음인데 테스트는 happy-path(둘 다 성공)만 태웠다. 현장에서 같은 명단이 두 번 들어간 뒤에야 드러났다. 지금은 500·throw·409·404·재시작·잠금 화면 6갈래가 전부 계약이다.

---

## 4. 새 기능을 추가할 때 — 어떤 하니스에 무엇을 넣는가

| 변경 성격 | 필수 추가 |
|---|---|
| 음식점 앱 UI·흐름 | `prepaid.e2e.js`에 시나리오. **부분 갱신 화면이면 "입력 노드가 살아남는가"(노드 동일성·focusout 0)를 단언**할 것 — "화면이 갱신되는가"는 헤드리스에서 무력하다 |
| 새 화면(폰) | `responsive.e2e.mjs`의 **`fits` 계약을 그 화면으로 확장**. 초기 뷰포트(`scrollY=0`) 기준, 서명판은 윗변·아랫변 둘 다 |
| 서버 엔드포인트·검증 규칙 | `phase2.e2e.mjs`에 섹션 추가(성공·경계·거부 3종). 응답 오류 코드까지 단언 |
| **클라이언트가 서버로 보내는 새 필드** | 🔴 **두 곳 모두** — `phase2.e2e.mjs`(서버가 받는가) **그리고** `prepaid.e2e.js`에서 `context.route`로 **실제 payload를 가로채 값 자체를 단언**(클라이언트가 만들어 보내는가). 한쪽만 하면 district 장애가 재발한다 |
| SQL을 바꾸는 변경 | `makeMemoryStore`의 대응 구현도 **같은 시맨틱으로** 고치고, 메모리↔D1 등가성 가정이 깨지지 않는지 주석에 남길 것(G3) |
| 계약 변경(`batch_hash`·`district`·백업 버전 등) | `phase2.e2e.mjs`에 **회귀 단언**(되돌리면 실패하는 형태)으로 고정 + [04-contracts.md](04-contracts.md) 갱신 |
| **원장에 쓰는 새 경로**(승인·충전·차감·임포트…) | 🔴 `withTxLock`으로 감싸고, **한 틱에 두 번 호출해도 거래가 1건인지** 단언할 것. 그리고 "장부 + 받은 기록"은 **`repo.apply()` 한 번**으로 커밋할 것([04](04-contracts.md) C11) |
| **새 meta 키** | `META_KEYS`에 등재(안 하면 재시작·복원 후 사라진다) + 기기 전용이면 `backupCore()` 제외 목록에도. "복원한 기기에서 되살아나야 하는 사실인가"로 판단([03](03-data-model.md) §5) |
| 배포 대상 문자열(버전·주소) | `verify-all.sh`가 아니라 [07](07-deploy-runbook.md)의 콘텐츠 문자열 확인 절차로 |

**원칙**: 사고가 났으면 고치는 것으로 끝내지 말고 **"수정 전 코드로 되돌렸을 때 반드시 실패하는" 단언**을 남긴다. 이 리포의 하니스가 커진 이유가 전부 그것이다.

---

## 5. 실행 방법

```bash
bash harness/verify-all.sh                      # 전체 16/16 (약 4~6분, [2]·[3]은 라이브에 접속한다)
node harness/prepaid.e2e.js                     # 음식점 앱 e2e
node harness/phase2.e2e.mjs                     # 서버 목 하니스 (CI 게이트와 같은 명령)
node harness/responsive.e2e.mjs                 # 폰 반응형
node harness/dongsearch.e2e.mjs                 # 동 이름 검색
node harness/agency-xlsx.e2e.mjs                # 담당자 웹 엑셀 양식 (csvchoice·sent·net도 같은 방식)
E2E_ONLY=beta55c node harness/prepaid.e2e.js    # beta.55 백업 블록만 (beta55·beta55b도 같은 방식, E2E_SOFT=1이면 실패 목록)
E2E_ONLY=beta60a node harness/prepaid.e2e.js    # beta.60 잠금·복구 블록만 (beta60b 명단·CSV, beta60c 기타)
node harness/install.e2e.mjs                    # 홈 화면에 추가 안내(beta.60)
node harness/sw.e2e.mjs                         # 서비스워커 앱 화면 폴백(beta.60)
node harness/phase2.migrate.mjs                 # 라이브 옛 스키마 + migrations-2026-11b.sql 조합(beta.60)
node harness/check-static.mjs                   # 정적 계약 (CI 게이트)
node harness/check-links.mjs                    # 문서·홈페이지 링크 (CI 게이트)
node harness/app-smoke.mjs                      # 앱 기동 스모크 (CI 게이트)
bash harness/upgrade-check.sh                   # 갱신 보존 — 최신 live-beta* 태그 → 작업 트리
uv run --with pymupdf python harness/check-manual-pdfs.py   # 안내서 PDF
node harness/phase2.live.mjs <서버URL>           # 라이브 스모크 (프로덕션 D1을 건드린다)
```

- 의존성: `npm i`로 `playwright`(devDependency). 브라우저는 Playwright chromium, 없으면 `CHROME_PATH`로 시스템 Chrome/Edge 지정 가능. **`phase2.e2e.mjs`·`check-static.mjs`·`check-links.mjs`는 의존성 없이 돈다.**
- 스크린샷은 `harness/screenshots/`에 쌓인다(gitignore).
- 다른 배포를 가리키려면 `RELAY= PAGES= APP= bash harness/verify-all.sh`.
- ⚠️ 샌드박스 환경에서는 Playwright 실행이 막힐 수 있다(mach port 권한). 그럴 때 목·순수함수로 대체했다면 **로컬에서 16/16을 한 번 확인**하고 넘어갈 것 — 실제로 그렇게 미뤘던 적이 있다.
