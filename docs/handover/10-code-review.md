# 10 — 이관 저해 요소 목록 (재점검 결과)

**이 문서는 목록이지 작업 지시가 아니다.** 인수인계 시점(2026-08-04)에 코드·문서를 읽으며 발견한 것들이며, 다른 작업자와의 충돌을 피하려 **아무것도 수정하지 않았다.**

권장 조치 표기: **지금**(이관 전/직후) · **나중**(다음 릴리스 사이클) · **방치 가능**(인지만)

| # | 항목 | 위치 | 위험도 | 조치 |
|---|---|---|---|---|
| R1 | `CHANGELOG.md`가 beta.8에서 멈춤 (18개 버전 누락) | `CHANGELOG.md` | 높음 | 지금 |
| R2 | 배포 문서가 `.gitignore`로 리포 밖 | `docs/phase2-deploy.md` | 높음 | 지금(해소됨) |
| R3 | `README.md`가 3서피스 구조를 반영하지 않음 | `README.md` | 높음 | 지금(부분 해소) |
| R4 | `docs/department-data-update.md`가 폐기된 방식을 설명 | `docs/` | 중 | 지금 |
| R5 | `CLAUDE.md`의 옛 "미적용" 항목 3개가 이미 해소됨 | `CLAUDE.md` | 중 | 나중 |
| R6 | `twa/twa-manifest.json`이 옛 주소를 가리킴 | `twa/` | 중 | 나중 |
| R7 | `package.json` `license: ISC` vs `LICENSE` All rights reserved | `package.json` | 중 | 지금 |
| R8 | 링크되지 않는 방침·약관 md 미러 2개 | `docs/PRIVACY_POLICY.md`, `docs/TERMS.md` | 중 | 나중 |
| R9 | IndexedDB 마이그레이션 경로 부재(`VER` 상승이 no-op) | `index.html` `openDb()` | 중 | 나중 |
| R10 | `hash()`의 djb2 폴백이 무음으로 비암호화 강등 | `index.html` `hash()` | 중 | 나중 |
| R11 | `APP_VERSION` ↔ `sw.js CACHE_NAME` 수동 동기화 | `index.html`, `sw.js` | 중 | 나중 |
| R12 | 메모리 store ↔ D1 store 등가성이 주석으로만 보장 | `server/src/worker.js` | 중 | 나중 |
| R13 | `verify-all.sh` 체크 7이 한국어 오류 문구에 의존 | `harness/verify-all.sh` | 중 | 나중 |
| R14 | `phase2.live.mjs`가 한 달 뒤처짐 | `harness/` | 중 | 나중 |
| R15 | `meta.storeAddr` vs `meta.shopAddr` — 이름이 구분을 안 알려줌 | `index.html` | 낮음 | 방치 가능 |
| R16 | `clickActions`에 `'fill-use'` 키 중복 | `index.html` | 낮음 | 나중 |
| R17 | `meta.keyCreatedAt` 기록만 되고 읽는 곳 없음 | `index.html` | 낮음 | 방치 가능 |
| R18 | `encrypted_blob.delivered` 레거시 미사용 컬럼 | `server/schema.sql` | 낮음 | 방치 가능 |
| R19 | 레거시 `agency-departments.json`이 여전히 배포·프리캐시 | 루트, `sw.js` | 낮음 | 방치 가능 |
| R20 | `package.json` `main: sw.js`, `test` 스크립트가 실패 문구 | `package.json` | 낮음 | 나중 |
| R21 | `docs/admin.html`에 서버 URL 하드코딩 | `docs/admin.html` | 낮음 | 방치 가능 |
| R22 | IndexedDB 인덱스 0개 — 전건 로드 후 메모리 필터 | `index.html` | 낮음 | 방치 가능 |
| R23 | 해시 체인이 `type`·`reason`을 포함하지 않음 | `index.html` `txHashOf()` | 낮음 | 방치 가능 |

---

## 상세

### R1 — `CHANGELOG.md`가 `1.0.0-beta.8`(2026-07-01)에서 멈춰 있다 · 높음 · **지금**
현재 앱은 `1.0.0-beta.27`대이고 계속 올라간다. 그 사이의 모든 변경(용어 대개편, 소속 필드, 홈 그룹핑, 손님 셀프 조회, B단계 요청, district, 온보딩 재편…)이 `CHANGELOG.md`에 없고 **`CLAUDE.md`의 「완료」 절**에만 있다.
- **왜 문제인가**: 제3자 개발사는 관례상 `CHANGELOG.md`를 먼저 본다. 거기만 보면 **한 달 반 전 상태를 현재로 오인**한다.
- **권장**: `CHANGELOG.md` 최상단에 "beta.9 이후 변경 이력은 `CLAUDE.md`의 「완료」 절에 기록한다"는 한 줄을 넣거나, 아예 CLAUDE.md 내용을 역순으로 옮긴다. **둘 중 하나만 진실의 원본이어야 한다.**

### R2 — 배포 절차 문서가 리포에 없다 · 높음 · **지금(이 작업으로 해소)**
`docs/phase2-deploy.md`는 `.gitignore`에 등재되어 있다. `CHANGELOG.md`가 이 파일을 참조하지만 **클론한 사람에게는 존재하지 않는다**(끊어진 참조). 같은 이유로 `docs/STATUS.md`·`docs/COMPLIANCE.md`·`docs/BUSINESS_PLAN.md`·`docs/COST_MODEL.md`도 리포 밖이다.
- **해소**: [07-deploy-runbook.md](07-deploy-runbook.md)가 배포 절차의 리포 내 원본이 되었다.
- **남은 조치**: `CHANGELOG.md`의 `docs/phase2-deploy.md` 참조를 정리할 것. 그리고 **로컬 전용 문서에 의존하는 새 참조를 만들지 말 것.**
- 참고: 로컬 `docs/STATUS.md`는 내용도 낡았다(예: `ALLOW_ORIGIN=*`, "기관 이메일은 형식만 확인" — 둘 다 현재와 다르다). 리포에 안 나가므로 이관 영향은 없으나, 이관 시 넘길 문서로 착각하지 말 것.

### R3 — 루트 `README.md`가 음식점 앱 단독 시절 구조 · 높음 · **지금(부분 해소)**
서버·담당자 웹·홈페이지·직원용 앱이 README에 없고, "초기 설정 마법사 4단계"(현재 3단계) 같은 낡은 서술이 남아 있다.
- **해소**: README 최상단에 이관 문서 링크와 3줄 안내를 추가했다(기존 내용은 보존).
- **남은 조치**: 「주요 기능」·「파일 구성」 절을 현재 구조로 갱신.

### R4 — `docs/department-data-update.md`가 폐기된 방식을 설명 · 중 · **지금**
이 문서는 **서울시청 + 25개 구청**짜리 단일 파일 `agency-departments.json`을 수정하라고 안내한다. 현재는 `agency-index.json`(17개 시도·246 기관, `schemaVersion` 2) + `agency-depts/{region}.json` 구조이며 재생성은 `harness/build-agencies.mjs`다(`docs/agency-data-pipeline.md`).
- **권장**: 문서 상단에 "이 방식은 레거시 폴백에만 해당한다 → 현행은 `agency-data-pipeline.md`" 한 줄을 넣거나 삭제.

### R5 — `CLAUDE.md`의 옛 "미적용/남은 권고" 항목이 이미 해소됨 · 중 · **나중**
2026-07-27·07-30 절에 남은 것 중 최소 3건이 그 뒤에 해결됐는데 그 자리에는 표시가 없다.

| 옛 항목 | 실제 |
|---|---|
| "온보딩 1/4·2/4 가게 이름 중복 입력 통합" | 2026-08-03에 온보딩 4→3단계로 해소 |
| "사용 모달 빠른 금액 버튼" | beta.17에 적용됨(`fill-use` 액션) |
| "OTP 화이트리스트가 go.kr/korea.kr뿐" | 2026-08에 `or.kr`·`ac.kr` 추가로 해소 |
| "staff.bapjangbu.com 전환(수동 작업)" | 2026-08-03 전환 완료(같은 파일 뒤쪽에 기록됨) |

- **왜 문제인가**: 시간순 로그 형식이라 **같은 파일 안에서 앞뒤가 모순**된다. 새 개발자가 위쪽 절을 읽고 이미 끝난 일을 다시 한다.
- **권장**: 해당 줄에 `(→ 2026-08-03 해소)` 표기만 덧붙인다. 이력 자체는 지우지 말 것(사고 맥락이 자산이다).

### R6 — `twa/twa-manifest.json`이 옛 주소 · 중 · **나중**
`"host": "nulmaru.github.io"`, `"startUrl": "/Prepaid_PWA/"`, 아이콘 URL도 옛 주소. 현재 정식 주소는 `app.bapjangbu.com`.
- **위험**: 이 상태로 TWA를 빌드하면 앱이 **옛 오리진**을 감싼다 → 저장 데이터가 앱 설치본과 웹 설치본으로 갈라진다([03](03-data-model.md) §9).
- **권장**: Play Store 착수 시 갱신. 그전에는 placeholder임을 문서로만 인지.

### R7 — 라이선스 표기 충돌 · 중 · **지금**
`package.json`은 `"license": "ISC"`(오픈소스 허용 라이선스)인데 `LICENSE` 파일은 **All Rights Reserved**(복제·수정·재배포·상업적 이용 금지)다.
- **왜 문제인가**: 이관 대상 개발사가 `package.json`만 보고 재배포 가능하다고 오판할 수 있다. 도구(npm·SBOM 스캐너)도 ISC로 읽는다.
- **권장**: `package.json`을 `"license": "SEE LICENSE IN LICENSE"` 또는 `"UNLICENSED"`로 정정. **법적 성격이 걸린 항목이라 우선순위가 높다.**

### R8 — 링크되지 않는 방침·약관 md 미러 · 중 · **나중**
확정본은 `docs/privacy.html`·`docs/terms.html`이고 **모든 서피스가 HTML만 링크**한다. `docs/PRIVACY_POLICY.md`·`docs/TERMS.md`는 같은 내용의 미러이지만 어디서도 링크되지 않는다.
- **위험**: 방침 개정 시 HTML만 고치면 md가 조용히 낡는다. 리포는 public이므로 **낡은 md가 검색·인용될 수 있다.**
- **권장**: 삭제하거나, 파일 상단에 "정본 아님 — `privacy.html` 참조" 배너를 넣는다.

### R9 — IndexedDB 마이그레이션 경로 부재 · 중 · **나중**
`openDb()`의 `onupgradeneeded`는 **없는 스토어를 만들기만** 한다(`if(!contains) createObjectStore`). 필드 변환 로직이 없다.
- **위험**: `VER`을 4로 올려도 기존 설치본에서는 사실상 아무 일도 일어나지 않는다. "버전 올렸으니 마이그레이션 됐겠지"라는 **가장 흔한 오해**가 여기서 데이터 손상을 만든다.
- **권장**: 지금 고칠 필요는 없다. 다만 스키마를 바꾸는 첫 PR에서 마이그레이션 프레임을 **함께** 넣을 것. 관련 계약은 [03](03-data-model.md) §1·§4.

### R10 — `hash()`의 djb2 폴백 · 중 · **나중**
`crypto.subtle`이 없으면 SHA-256 대신 **djb2 32비트 정수 문자열**을 반환한다. 이 경우 해시 체인·백업 checksum·`pinHash`가 **동시에** 비암호화로 강등되는데, **사용자에게 아무 표시가 없다.**
- **현실적 위험**: 비보안 오리진(HTTP)에서만 발생. 현재 모든 서피스가 HTTPS라 실사용 노출은 없다. 로컬에서 `file://`이나 HTTP로 열었을 때가 유일한 경로.
- **권장**: 폴백을 없애기보다 **경고 배너**를 띄우는 편이 안전하다(오프라인 도구라 완전 차단은 위험).

### R11 — 버전 문자열 이중 관리 · 중 · **나중**
`index.html`의 `APP_VERSION`과 `sw.js`의 `CACHE_NAME`을 **코드가 대조하지 않는다.** 릴리스마다 사람이 둘 다 올려야 한다.
- **완화 요인**: SW가 HTML을 네트워크 우선으로 서빙해 온라인이면 대체로 자가 치유된다.
- **권장**: 릴리스 체크리스트로 관리([07](07-deploy-runbook.md) §10), 또는 하니스에 "두 문자열이 같다"는 단언 1줄 추가(가장 저렴한 방어).

### R12 — 메모리 store ↔ D1 store 등가성 · 중 · **나중**
`server/src/worker.js`에는 `makeD1Store`(운영)와 `makeMemoryStore`(테스트)가 **나란히** 있다. 하니스는 후자만 실행한다. district 정확 일치, `LIKE` 이스케이프, 고아 summary JOIN 제외, cron 100개 청크 등 **SQL 성격의 단언이 전부 JS 구현에 대해서만 증명**돼 있고, 등가성은 주석("D1과 동등")으로만 주장된다.
- **위험**: `makeD1Store`의 SQL만 바꾸거나 D1 특유의 동작(콜레이션·`ESCAPE`·`IN` 상한)에 걸리면 **230/230 통과인 채로 운영이 깨진다.**
- **권장**: 새 SQL을 쓸 때 메모리 구현을 반드시 같은 시맨틱으로 고칠 것. 여력이 되면 miniflare/D1 로컬 실행을 하니스에 추가([06](06-testing.md) G3).

### R13 — `verify-all.sh` 체크 7이 문구 의존 · 중 · **나중**
`curl … /api/submit … | grep -q "형식 오류"` — worker.js의 한국어 오류 메시지에 의존한다. 문구를 다듬는 순간 **진짜 통과가 거짓 실패**로 바뀐다(반대로 오류 코드가 바뀌어도 문구만 같으면 통과한다).
- **권장**: HTTP 상태코드(400)나 `error` 키로 판정하도록 바꾸는 편이 견고하다.
- 같은 파일의 체크 5·6은 `python3` 부재 시 조용히 실패로 떨어진다(환경 의존).

### R14 — `phase2.live.mjs`가 한 달 뒤처짐 · 중 · **나중**
파일 mtime 기준 2026-07-06 — 나머지 하니스·worker(08-03)보다 한 달 낡았다. 그 사이 추가된 `district`/`registered-list`, `inbox-count`, `feedback`, `admin/stats`, `deduped/status`를 **라이브에서 한 번도 확인하지 않는다.** 깨진 것은 아니고 커버리지가 6월 API 표면에 동결된 상태.
- **권장**: 최소한 `register-key`에 `district`를 실어 보내고 `registered-list`로 되받는 1단계를 추가([09](09-open-items.md) G4).

### R15 — `meta.storeAddr` vs `meta.shopAddr` · 낮음 · **방치 가능**
`storeAddr` = LOCALDATA 공식 주소(district 유도의 1순위), `shopAddr` = 가게 정보 화면의 주소. **이름만 봐서는 구분이 안 된다**(둘 다 "가게 주소"). `relayDistrict()`의 우선순위 체인(`addrHint → storeAddr → shopAddr → setupSelected.addr`)을 읽어야 알 수 있다.
- 실제로 이 애매함 때문에 문서·하니스에서 두 이름이 혼용된 흔적이 있다(둘 다 단언되고 있어 동작은 정상).
- **권장**: 지금 리네임하면 백업 호환(`meta`는 백업에 포함)을 건드린다. **주석 한 줄로 구분을 명시하는 편이 안전하다.**

### R16 — `clickActions`에 `'fill-use'` 키 중복 · 낮음 · **나중**
동일한 본문이 두 번 정의돼 있다(뒤엣것이 이긴다). 동작에는 영향이 없지만, **키가 중복돼도 아무도 모르는 구조**라는 신호다(112개 리터럴).
- **권장**: 중복 제거 + 하니스의 `clickActionKeys()` 훅으로 "키 개수 == Set 크기" 단언 1줄.

### R17 — `meta.keyCreatedAt` 미사용 · 낮음 · **방치 가능**
`ensureKeyPair()`·`importKeyBackup()`이 쓰지만 읽는 곳을 찾지 못했다(**미확인** — 전수 확인은 아니다). "키 만든 지 N일" 같은 UI를 넣으려던 흔적으로 보인다.

### R18 — `encrypted_blob.delivered` 레거시 컬럼 · 낮음 · **방치 가능**
스키마 주석이 스스로 `레거시 필드(미사용): 행이 즉시 삭제되므로 의미 없음`이라고 밝히고 있다. D1 컬럼 삭제는 비용이 있으니 그대로 두는 편이 낫다.

### R19 — 레거시 `agency-departments.json`(21KB) · 낮음 · **방치 가능**
서울 25개 구청짜리 구형 단일 파일. 현재는 폴백 용도로만 참조되지만 **`sw.js`의 프리캐시 목록에 아직 들어 있다**(설치 시 매번 받는다). 반대로 `agency-depts/` 17개 중에는 `seoul.json`만 프리캐시된다(의도적 — 나머지는 lazy).
- **권장**: 폴백 경로가 실제로 쓰이는지 확인 후 프리캐시에서만 빼도 된다. 파일 자체는 구버전 백업 호환을 위해 남겨둘 근거가 있다.

### R20 — `package.json` 잔여 스캐폴딩 · 낮음 · **나중**
`"main": "sw.js"`(의미 없음), `"scripts": {"test": "echo \"Error: no test specified\" && exit 1"}`.
- **권장**: `test`를 `bash harness/verify-all.sh`로 바꾸면 `npm test`가 실제로 동작한다 — **이관받는 개발자가 가장 먼저 치는 명령**이다.

### R21 — `docs/admin.html`에 서버 URL 하드코딩 · 낮음 · **방치 가능**
`var RELAY = "https://prepaid-relay.sulsul-plus.workers.dev";`. 운영자 전용 단일 파일이라 실용상 문제없으나, 서버 주소가 바뀌면 여기도 고쳐야 한다는 것을 기억할 것(`sulsul-plus`라는 옛 계정명이 URL에 남아 있는 점도 참고).

### R22 — IndexedDB 인덱스 0개 · 낮음 · **방치 가능**
`createIndex` 미사용. 모든 조회가 `getAll()` + 메모리 필터다. 음식점 1곳 규모(직원 수백 명, 거래 수만 건)에서는 문제가 되지 않지만, **거래에 서명 data URL이 인라인 저장**되므로 장기 사용 시 `getAll()` 비용이 서명 이미지 총량에 비례한다는 점은 인지할 것.

### R23 — 해시 체인이 `type`·`reason`을 포함하지 않음 · 낮음 · **방치 가능**
canonical은 `employeeId|amount|afterBalance|prevHash|createdAt`. 금액과 잔액이 들어가므로 **돈이 바뀌는 변조는 잡힌다**. 다만 `reason`·`note`만 바꾼 변조나 `type` 라벨 변경은 체인으로 탐지되지 않는다(잔액이 안 맞으면 교차 검증이 잡는다).
- 사양 사실이지 버그가 아니다. **바꾸려면 기존 장부 전체가 "해시 변조"로 뜨므로 사실상 변경 불가**로 취급할 것.

---

## 종합 — 이관 직후 권장 순서

1. **R7**(라이선스 표기) — 법적 오해 소지, 1줄.
2. **R1 + R2 + R3**(문서 진실의 원본 정리) — 새 개발자가 가장 먼저 읽는 3개 파일.
3. **R4 + R5 + R8**(모순되는 문서 정리) — 잘못된 작업 유발원.
4. **R20**(`npm test`) — 가장 저렴한 온보딩 개선.
5. 이후는 릴리스 사이클에 태워 처리.
