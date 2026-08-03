# 02 — 아키텍처

이 문서는 **구성요소의 경계와 데이터 흐름**만 다룬다.
- API 세부 계약(요청/응답 필드·에러 코드) → `server/PROTOCOL.md` §4
- 깨면 안 되는 계약 → [04-contracts.md](04-contracts.md)
- 배포 명령 → [07-deploy-runbook.md](07-deploy-runbook.md)

---

## 1. 구성요소 5개

| # | 이름 | 소스 | 배포처 | 런타임 | 리포 |
|---|---|---|---|---|---|
| 1 | 음식점 PWA | `index.html`(단일 파일) + `sw.js` + `manifest.json` + `icons/` + `agency-index.json` + `agency-depts/*.json` | https://app.bapjangbu.com (GitHub Pages) | 브라우저(IndexedDB, Service Worker) | 이 리포 |
| 2 | 공공기관 담당자(서무) 웹 | `agency-web/index.html`(단일 파일) | https://agency.bapjangbu.com (Cloudflare Pages `prepaid-agency`) | 브라우저(WebCrypto, sessionStorage) | 이 리포 |
| 3 | 중계 서버 + D1 | `server/src/worker.js`, `server/schema.sql`, `server/wrangler.toml` | https://prepaid-relay.sulsul-plus.workers.dev (Cloudflare Workers + D1) | Workers(V8 isolate) | 이 리포 |
| 4 | 문서 사이트 + 소개 홈페이지 | `docs/*.html`(매뉴얼·방침·약관·관리자), `homepage/index.html` | `app.bapjangbu.com/docs/…` (GitHub Pages) / https://bapjangbu.com (Cloudflare Pages `bapjangbu-home`) | 정적 | 이 리포 |
| 5 | 직원용 앱 | — | https://staff.bapjangbu.com | 브라우저(localStorage) | **별도 리포 `NULMARU/bapjangbu-staff`** |

> ⚠️ #5는 이 리포에 소스가 없다. 이 리포에는 **안내서(`docs/manual-staff.html`)와 홈페이지 링크, 서버 CORS 화이트리스트 항목(`staff.bapjangbu.com`)** 만 존재한다. 직원용 앱은 음식점 앱과 **연동되지 않는 개인 기록장(PoC)** 이며 공식 잔액의 기준이 아니다(안내서 최상단 경고).

`homepage`는 #4에 묶었지만 **배포 파이프라인이 다른 별개 서피스**다(07 참조: git push로 나가지 않는다).

---

## 2. 데이터 흐름도

### 2.1 자동 등록 — 「바로 보내기」(서버 경유)

```
 [공공기관 담당자(서무) 브라우저]                [중계 서버 + D1]              [음식점 PWA(기기)]
  agency-web/index.html                      server/src/worker.js            index.html
        │                                             │                             │
        │ ① 이메일 OTP 인증                            │                             │
        │  POST /api/agency/request-otp ─────────────▶ │──(Resend)──▶ 담당자 메일함    │
        │  POST /api/agency/verify-otp  ─────────────▶ │                             │
        │  ◀──────────── {token} (24h, sessionStorage) │                             │
        │                                             │                             │
        │ ② 음식점 찾기                                │                             │
        │  GET /api/restaurants?region=&q= ──────────▶ │──▶ data.go.kr LOCALDATA     │
        │  GET /api/registered-list?sido=&sigungu= ──▶ │  (관할 등록 목록)             │
        │  GET /api/public-key?restaurant_id= ───────▶ │                             │
        │  ◀──────────── {public_key(SPKI b64), contact}                            │
        │                                             │                             │
        │ ③ 브라우저에서 암호화 (서버는 열 수 없음)       │                             │
        │   items = [{name, dept, amount, org?}]      │                             │
        │   batch_hash = SHA-256("name|dept|amount"…) │                             │
        │   blob = RSA-OAEP(pub, AES키) + AES-GCM(본문)│                             │
        │                                             │                             │
        │ ④ POST /api/submit  + X-Agency-Token ──────▶ │  deposit_summary(집계만)     │
        │                                             │  encrypted_blob(암호문)      │
        │                                             │  consent_log(이메일 해시)    │
        │  ◀── {summary_id} 또는 {deduped:true,status} │                             │
        │                                             │                             │
        │                                             │ ◀── ⑤ GET /api/inbox-count  │(배지, 무인증)
        │                                             │ ◀── ⑥ GET /api/inbox        │
        │                                             │ ──▶ [{summary, ciphertext}] │
        │                                             │                             │ ⑦ 개인키로 복호화
        │                                             │                             │   batch_hash 재계산·대조
        │                                             │                             │   화면에 명단 표시
        │                                             │ ◀── ⑧ POST /api/challenge   │(소유증명)
        │                                             │ ──▶ {challenge_ct}          │
        │                                             │ ◀── ⑨ POST /api/approve     │  + auth_token
        │                                             │  ⇒ encrypted_blob 즉시 파기   │
        │                                             │                             │ ⑩ IndexedDB에 직원·거래 기록
```

- **미수령 72시간** 경과 시 서버가 `EXPIRED` 처리하고 암호문을 파기한다(`PENDING_TTL_MS`, cron + `/api/inbox` 이중 방어).
- 처리 완료(APPROVED/REJECTED/EXPIRED) 요약은 **30일** 후 삭제(`RETENTION_TTL_MS`).

### 2.2 자동 등록 — 「직접 전달」(서버 무보관)

```
 [담당자 웹] ──암호화──▶ .json 파일 / QR / 이메일 첨부 / 카톡 오픈채팅 ──▶ [음식점 PWA]
                     (서버를 경유하지 않음 — D1에 아무 흔적도 남지 않음)
```
파일 객체는 `{v:1, type:'direct-transfer', restaurant_id, restaurant_name, institution, department, year_month, summary:{total_amount, member_count, batch_hash}, ciphertext}`
(`agency-web/index.html`, 직접전달 생성부). 음식점 앱이 같은 복호화·`batch_hash` 대조를 수행한다.

### 2.3 수동 등록 (회사·개인 선금)

서버가 전혀 관여하지 않는다. 사장님이 앱에서 한 명씩 등록 / 빠른 등록 / CSV 불러오기로 직접 입력한다.

### 2.4 손님(직원) 셀프 조회·사용 요청

```
[태블릿 잠금 화면 = 손님 화면]                      [사장님]
 이름 검색(초성 가능) → 본인 확인 → 금액·서명 → [사장님 확인 받기]
                                                 → PIN 입력 → 금액 확인·수정 → 저장
                                                    ⇒ 이때 비로소 IndexedDB에 거래 기록
```
요청(pending)은 **메모리 휘발성 · 2분 TTL** 이며 원장·백업·서버 어디에도 흔적을 남기지 않는다([04](04-contracts.md) 참조).

### 2.5 암호화 원장 클라우드 백업(선택)

```
[음식점 PWA] ── 자기 공개키로 하이브리드 암호화 ──▶ POST /api/ledger-backup (+auth_token)
                                                    D1 ledger_backup (restaurant_id당 1행)
             ◀── POST /api/ledger-backup/get ────── (기기 분실 후 복구)
                 POST /api/ledger-backup/delete ── (사용자가 언제든 삭제)
```
서버는 복호화 키가 없다. **전화번호는 이 백업에서도 제외된다**(불변식 4).

---

## 3. 책임 경계

| 구성요소 | 책임 | 명시적 비책임 |
|---|---|---|
| 음식점 PWA | 원장의 **유일한 진실**. 잔액·거래·해시 체인·서명·PIN·전화번호(로컬 암호화). 복호화·`batch_hash` 대조·승인 판단. | 서버에 원장 평문을 보내지 않는다. 다른 음식점의 잔액을 알지 못한다. |
| 담당자 웹 | CSV 파싱·검증, 그룹핑, **브라우저 내 암호화**, `batch_hash` 산출, OTP 인증, 복수 전송·진행률·재시도. | 개인키를 갖지 않는다(암호화 전용). 전화번호를 다루지 않는다. 서버에 평문 명단을 보내지 않는다. |
| 중계 서버 | 공개키 레지스트리, LOCALDATA 검색 프록시(API 키 은닉), 암호문 **일시** 중계, 비식별 집계, OTP 발급·검증, 소유증명 챌린지, 암호화 백업 보관, TTL 파기. | **복호화 불가**. 평문 개인정보 저장·로깅 금지. 자금 취급 금지. 원장의 진실이 아니다. |
| 문서 사이트 | 매뉴얼·방침·약관·운영자 대시보드. | 개인정보를 다루지 않는다(`docs/admin.html`은 비식별 집계만 조회). |
| 직원용 앱(별도 리포) | 직원 **개인 기록장**(메모). | 공식 잔액이 아니다. 음식점 앱·서버와 **연동 없음**. |

---

## 4. 왜 이렇게 나뉘었는가

1. **원장이 기기에 있는 이유 (불변식 5)** — 서버가 잔액을 들고 있으면 그 순간 서비스는 "선불충전금 보관"으로 읽히고 규제 지위가 바뀐다. 서버는 값을 알 수 없어야(zero-knowledge) 안전하게 무료로 운영된다.
2. **담당자 웹이 별도 서피스인 이유** — 담당자는 음식점 앱을 설치하지 않는다. 관공서 PC 브라우저에서 열리는 무설치 단일 파일이어야 하고, 개인키를 절대 갖지 않아야 한다.
3. **중계 서버가 필요한 이유** — 담당자가 음식점의 **공개키**를 얻고 암호문을 전달할 채널이 필요하다. 그러나 서버 없이도 성립하도록 「직접 전달」 경로를 함께 둔다(서버 장애·폐업 시에도 서비스가 죽지 않는다).
4. **단일 파일(index.html)인 이유** — 빌드 없이 GitHub Pages에 올라가고, 오프라인 캐시가 단순하며, 음식점이 파일 하나만 보관해도 복구된다. 대가는 [08-frontend-conventions.md](08-frontend-conventions.md)의 전면 재렌더 제약이다.
5. **직원용 앱이 별도 리포인 이유** — 연동되지 않는 PoC이고, 연동하는 순간 "다점포 통용 잔액"(불변식 2)·"서버가 잔액을 안다"(불변식 5) 쪽으로 미끄러질 위험이 있다. 물리적으로 분리해 둔 것이 안전장치다.

---

## 5. 외부 의존성

| 대상 | 용도 | 실패 시 영향 | 비고 |
|---|---|---|---|
| Cloudflare Workers + D1 | 중계·저장 | 자동 등록 「바로 보내기」만 중단. 앱 자체·수동 등록·직접 전달은 정상 | **무료 플랜 유지**(불변식 6) |
| Cloudflare Pages | 담당자 웹·홈페이지 | 해당 사이트 접속 불가 | |
| GitHub Pages | 음식점 앱·문서 | 설치된 PWA는 SW 캐시로 계속 동작 | |
| data.go.kr LOCALDATA 일반음식점 | 가게 검색 | 검색 불가 → 「직접 입력」 폴백 | 키는 `PUBLIC_API_KEY` secret |
| Resend | 담당자 OTP 메일 | 담당자 인증 불가 → 제출 차단 | **무료 하루 100통**이 가장 먼저 막히는 한도 |
| code.go.kr 행정표준코드 | 기관·부서 목록 원자료 | 없음(연 1회 오프라인 갱신) | `harness/build-agencies.mjs` |
