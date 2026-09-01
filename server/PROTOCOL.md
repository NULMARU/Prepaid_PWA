# 다자간 연동 프로토콜 v1 (담당자 웹 ↔ 중계 서버 ↔ 음식점 앱)

> 본 문서는 세 컴포넌트가 공유하는 **암호 blob 포맷·batch_hash 규칙·REST 계약**의 단일 기준이다.
> 스펙 §1.2(불변식), §2.2(서버 스키마), §4.2(암호화)를 구현으로 고정한다.

## 0. 절대 불변식 (서버 코드가 반드시 지킴)
- 서버는 **평문 개인정보(직원명·금액 리스트·전화번호)를 저장·로깅하지 않는다.** 저장 대상은 암호문(`ciphertext`)뿐이며 서버는 복호화 키가 없다.
- 전화번호는 담당자 경로(웹·서버·blob)에 **존재하지 않는다.**
- 집계(`deposit_summary`)는 총액·인원수·해시만 보관한다(개인별 금액·이름 ❌).
- **기관 담당자 이메일도 평문으로 저장하지 않는다.** `agency_otp`·`agency_token`의 `email` 컬럼에는
  이메일의 **해시(64자 hex)** 만 들어가며(§4.4), `consent_log.agency_email_hash`도 같은 해시다.
  해시 방식은 `EMAIL_PEPPER`(wrangler secret)가 설정돼 있으면 **HMAC-SHA256(EMAIL_PEPPER, email)**,
  없으면 기존 **SHA-256(email)**이다(§4.4 — 전환기에는 구 SHA-256 키도 조회 폴백으로 인식).
  평문 이메일은 OTP 발송(Resend) 호출에만 일시적으로 쓰이고 저장·로깅되지 않는다.
  단, **도메인부만**(로컬파트 제외, 예 `gwangjin.go.kr`)은 `agency_token.email_domain`·
  `deposit_summary.agency_domain`에 평문으로 남는다 — 사람을 가리키는 부분이 없어 개인정보가
  아니며, 음식점 앱이 기관명 대조에 쓰도록 전달하기 위한 값이다(§4.11).
- **전화번호는 자유 입력 창구로도 들어오지 못한다.** `POST /api/feedback`은 `message`·`contact`에
  휴대전화번호 패턴(`01[0-9]-?\d{3,4}-?\d{4}`)이 있으면 저장하지 않고 `400 {error:'no_personal_info'}`
  로 거부한다(§8.3 — 불변식 "전화번호는 어떤 서버 경로에도 실리지 않는다"의 마지막 방어선).

## 1. 키
- 음식점 앱: `RSA-OAEP` 2048 / SHA-256 키페어. 공개키는 SPKI를 base64로 인코딩해 등록.
- 식별자 `restaurant_id`: LOCALDATA 관리번호(`mgtNo`) 또는 음식점이 설정에서 정한 값. 등록·blob·summary에서 동일하게 사용.

## 2. 암호 blob 포맷 (하이브리드: AES-GCM 본문 + RSA-OAEP 키 봉인)
명단이 RSA 직접 암호화 한계(~190B)를 넘으므로 하이브리드 고정.

평문(직원 명단):
```json
{ "v":1, "items":[ {"name":"홍길동","dept":"세무과","amount":90000}, ... ] }
```
items의 **선택 필드**(구버전 앱은 무시, batch_hash 계산에 불포함 — §3):
- `org` — 소속(공공기관명·회사명). 없으면 앱이 summary.institution으로 폴백.
- `payer` — **결제자·입금자명(선택, 2026-08)**. CSV '입금자명' 열. 사장님이 결제 내역과 명단을 대조하는 **보조값**.
  ⚠️ 2026-08 정정: 결제는 **음식점별로 각각** 이뤄지며 **카드결제가 다수**다(계좌이체도 있음).
  **카드결제 시 비어 있는 것이 정상**이며, 값이 없어도 어떤 검증에도 영향을 주지 않는다(필수 강제 금지).
  개인 이름(PII)이므로 **암호문 안에서만** 이동하고 summary(평문)에는 절대 싣지 않는다.
- `payMethod` — **결제구분(선택, 2026-08 / 제로페이 추가 2026-09)**. CSV '결제구분' 열,
  값 `카드`|`계좌이체`|`제로페이`(그 외 값은 담당자 웹이 경고만 하고 원문 전달).
  음식점 앱이 승인 확인 화면에서 **그 방식에 맞는 확인 안내**(카드=매출전표·POS 정산,
  계좌이체=통장 입금 내역, 제로페이=가맹점 앱 정산 내역 또는 통장 입금 내역)만 보여주는 데 쓴다.
  값이 없거나 앱이 모르는 값이면 앱은 모든 방식을 병기한다(구버전 앱 호환의 근거).
  batch_hash 계산에 불포함(§3) — 값이 있든 없든 해시가 달라지지 않는다.
  → 그래서 **표준값 추가는 통신 계약 변경이 아니다**(서버 무변경, 기존 양식 파일·구버전 앱 그대로 동작).
암호화 절차:
1. `aesKey` = 무작위 AES-256-GCM 키
2. `iv` = 무작위 12바이트
3. `ct` = AES-GCM(aesKey, iv, UTF8(JSON(plaintext)))
4. `encKey` = RSA-OAEP(restaurant_public_key, raw(aesKey))

blob(서버로 전송·저장되는 ciphertext, base64 필드):
```json
{ "alg":"RSA-OAEP-2048+AES-256-GCM", "encKey":"<b64>", "iv":"<b64>", "ct":"<b64>" }
```
복호화(음식점 앱): `aesKey = RSA-OAEP^-1(priv, encKey)` → `plaintext = AES-GCM^-1(aesKey, iv, ct)`.

## 3. batch_hash (전송 변조 탐지, 스펙 §4.3)
담당자 웹이 평문 명단으로 계산, summary에 실어 보냄. 음식점 앱이 복호화 후 재계산해 대조.
```
canonical = items 정렬(name,dept,amount 오름차순)을 "name|dept|amount" 줄로 join("\n")
batch_hash = SHA-256(hex)
```
canonical에 들어가는 필드는 **`name`·`dept`·`amount` 셋뿐이며 고정이다.** items에 그 밖의 선택 필드
(예: 소속 표기 `org`)가 실려도 batch_hash 계산·대조에 **영향을 주지 않는다** — 선택 필드는 blob 안에서
음식점 앱까지 그대로 전달될 뿐이다(서버는 암호문을 열지 않으므로 존재조차 알지 못한다). 새 필드를
canonical에 끼워 넣으면 담당자 웹/음식점 앱 버전이 엇갈릴 때 정상 전송이 '변조'로 오탐된다.
같은 이유로 **summary(메타)에 필드가 추가돼도 batch_hash와는 무관하다** — 예: `agency_domain`
(§4.11)은 서버가 요약에 덧붙이는 값일 뿐 canonical에 들어가지 않는다.

## 4. REST 계약 (서버)
모든 응답 JSON. 오류는 `{error}` + 상태코드.

| 메서드·경로 | 요청 | 응답 | 비고 |
|---|---|---|---|
| `POST /api/register-key` | `{restaurant_id, restaurant_name, public_key, auth_token?, district?}` | `{ok:true}` / 400 | 공개키 등록. **최초 등록은 공공데이터로 실존·상호를 대조**하고 어긋나면 `400 {error:'store_not_found'}`(§4.10). 최초 등록·동일 키 재등록은 인증 불요. 다른 키로 재등록 시 `auth_token` 필요(§4.1). 선택 필드 `district`(관할 지역, 공개 사업장 정보, ≤100자, 예 "서울특별시 광진구") 저장. **재등록(멱등·소유증명 경로 모두)에서 `district`가 오면 갱신**(레거시/미채움 등록분을 앱 재등록으로 채울 수 있게, §4.6) |
| `POST /api/challenge` | `{restaurant_id}` | `{challenge_ct}` / 404 | 소유 증명 챌린지 발급(§4.1) |
| `POST /api/deregister` | `{restaurant_id, auth_token}` | `{ok:true}` / 401 | 음식점 주인 등록 해제(명단 받기 중단) → 공개키 삭제(연락처·원장 클라우드 백업도 함께 삭제, §4.2). 인증 필요 |
| `POST /api/contact` | `{restaurant_id, auth_token, kakao_link, email}` | `{ok:true}` / 400/401/404 | 업무용 연락처 등록·수정·삭제(§4.5). 인증 필요 |
| `GET /api/public-key?restaurant_id=` | — | `{restaurant_id, public_key, contact:{kakao_link,email}}` / 404 | 담당자 웹이 암호화 전 조회. `contact`는 미등록 시 각 필드 `null`. IP당 분당 20회로 별도 레이트리밋(§6.3) |
| `GET /api/registered?ids=a,b,c` | — | `[등록된 id…]` / 400 | 담당자 웹: '명단 받기 가능' 표시용. **한 번에 100개까지**(초과 시 `400 {error:'too_many_ids', max:100}` — 청킹은 클라이언트 몫) |
| `GET /api/registered-list?sido=&sigungu=` | — | `{restaurants:[{restaurant_id,restaurant_name,district,registered_at,verified}]}` / 400 | 시도(+선택 시군구)의 등록 음식점 목록(§4.6). `sido` 필수(없으면 `400 {error:'sido_required'}`). **매칭은 정규화 후 정확 일치**(`district == "{sido} {sigungu}"` — 부분 일치 금지, §4.6). 공개 정보만(연락처 미포함), 레거시(district 없음) 제외, 이름 가나다 정렬. `registered_at`(등록 시각)·`verified`(0\|1, §4.10)는 담당자 웹의 "신규 등록"·"실존 확인" 배지용(개인정보 아님). IP당 분당 20회 별도 레이트리밋(§6.3) |
| `GET /api/restaurants?region=&q=&zip=` | — | `[{restaurant_id,name,address,status,category,region_code,tel,zip}]` | data.go.kr 프록시(키 은닉). `region`(개방자치단체코드)·`q`(상호)·`zip`(도로명 우편번호 5자리) 중 **하나 이상 필수**, 폐업 제외. `zip`이 오면 우편번호로 후보를 받아(최대 3페이지=300건) **상호는 서버가 부분일치로 거른다** — §7.4의 상대 서비스 회귀 우회 경로. `zip`이 5자리가 아니면 `400`. |
| `POST /api/submit` | `{summary, blob, consent}` (아래) + 헤더 `X-Agency-Token`(운영 시 필수) | 신규 `{summary_id}` / 재제출 `{summary_id, deduped:true, status}` / 401 | 부서·음식점 단위 1건(§4.3). 동일 `(restaurant_id,batch_hash)` 재제출은 멱등(§4.7). 서버가 **토큰에서 읽은 인증 이메일 도메인**을 `deposit_summary.agency_domain`에 함께 기록한다(§4.11 — body로 온 값은 무시) |
| `GET /api/inbox?restaurant_id=&auth_token=` (또는 헤더 `X-Auth-Token`) | — | `[{summary_id, summary, ciphertext, status}]` / 401 | 음식점 앱 폴링(PENDING만, `encrypted_blob` JOIN — 암호문 없는 건은 제외). **소유 증명 필수**(§4.1의 1회용 `auth_token`, 없거나 무효면 `401 {error:'auth_required'}`). `summary`에 **`batch_hash`는 실리지 않는다**(§4.9). `summary.agency_domain`(인증 이메일 도메인, 미인증·구버전이면 `null`)이 실린다(§4.11) |
| `GET /api/inbox-count?restaurant_id=` | — | `{"count":2}` / 400 | 알림 배지·경량 폴링용 **개수만**. `/api/inbox`와 동일 필터(PENDING + 72시간 이내 + `encrypted_blob` JOIN)를 COUNT로만 수행하고 요약 메타·암호문은 반환하지 않는다. `restaurant_id` 누락 시 `400 {error:'restaurant_id 필요'}`. **인증 없음** — 같은 id로 `/api/inbox`를 호출하면 이미 알 수 있는 값의 부분집합이라 새로 노출되는 정보가 0(남용 방어는 전역 레이트리밋 분당 60, §6.3) |
| `POST /api/approve` | `{summary_id, status:"APPROVED"\|"REJECTED", restaurant_id, auth_token}` | `{ok:true}` / 401/403/404/409 | 승인/거절. 상태 전이 성공 시 암호문(`encrypted_blob`) 즉시 파기(§6). 인증 필요 |
| `POST /api/ledger-backup` | `{restaurant_id, auth_token, blob, blob_hash}` | `{ok:true}` | 암호화 원장 클라우드 백업 upsert(§4.2). 인증 필요 |
| `POST /api/ledger-backup/get` | `{restaurant_id, auth_token}` | `{blob, blob_hash, updated_at}` / 404 | 백업 조회. 인증 필요 |
| `POST /api/ledger-backup/delete` | `{restaurant_id, auth_token}` | `{ok:true}` / 401/404 | 백업 삭제(예: 기기를 되찾아 클라우드 백업이 더 이상 필요 없을 때). 인증 필요 |
| `POST /api/agency/request-otp` | `{email}` | `{ok:true, dev_otp?, sent?}` / 500 | 기관 이메일 OTP 발급(§4.4) |
| `POST /api/agency/verify-otp` | `{email, otp}` | `{token}` / 401 | OTP 검증 → 24시간 기관 토큰 발급 |
| `POST /api/agency/keycheck` | 헤더 `X-Agency-Token` + `{institution, department, restaurant_id, fingerprint}` | `{ok:true, fingerprint}` / 400/401/404/409 | 열쇠 지문 확인 기록(§4.8). 서버가 현재 공개키로 지문을 재계산해 **일치할 때만** 저장(upsert). 불일치 시 `409 {error:'fingerprint_mismatch', current}` |
| `GET /api/agency/keychecks?institution=&department=` | 헤더 `X-Agency-Token` | `{keychecks:[{restaurant_id, fingerprint, checked_at}]}` / 400/401 | 그 **부서가** 확인해 둔 음식점 목록(§4.8). 다른 정보(인원·금액 등)는 절대 싣지 않는다 |
| `GET /api/admin/stats` | 헤더 `X-Admin-Token` | `{restaurants, institutions_total, …, feedback[]}` / 401/503/429 | 비식별 집계 통계(관리자 전용, §8) |
| `POST /api/feedback` | `{role, message, contact?}` | `{ok:true}` / 400/429 | 피드백 수신(§8.3) |

`POST /api/submit` 본문:
```json
{
  "summary": { "institution":"서울특별시 강남구", "department":"세무과",
    "restaurant_id":"...", "restaurant_name":"정식김밥", "year_month":"2026-07",
    "total_amount":2700000, "member_count":30, "batch_hash":"<hex>" },
  "blob":   { "restaurant_id":"...", "ciphertext": { ...§2 blob... } },
  "consent":{ "institution":"서울특별시 강남구", "department":"세무과", "year_month":"2026-07" }
}
```
`summary`에 `agency_domain`을 넣어 보내도 **서버는 무시한다** — 이 값은 서버가 `X-Agency-Token`에서만
읽어 기록하는 필드다(§4.11).

`GET /api/inbox` 응답의 `summary`:
```json
{ "institution":"서울특별시 강남구", "department":"세무과", "restaurant_id":"...",
  "restaurant_name":"정식김밥", "year_month":"2026-07",
  "total_amount":2700000, "member_count":30, "agency_domain":"gangnam.go.kr",
  "created_at":1785900000000 }
```
`batch_hash`는 없고(§4.9), `agency_domain`은 미인증·구버전 제출이면 `null`이다(§4.11).
`created_at`은 **명단 전송 시각(epoch ms)** — 음식점 앱이 승인 확인 화면에 표시해, 사장님이
그 날짜 근처의 **결제 내역(카드 매출전표·통장 입금)**을 찾아 대조할 수 있게 한다(2026-08 추가).
개인정보가 아니며 구버전 앱은 무시한다.

### 4.1 소유 증명 인증 (챌린지-응답)

승인/거절, 등록 해제, 다른 키로의 재등록, 원장 백업 업/다운로드는 "그 음식점 개인키를 실제로
갖고 있다"는 증명(`auth_token`)을 요구한다. 흐름:

1. 클라이언트가 `POST /api/challenge {restaurant_id}` 호출.
2. 서버: 등록된 공개키가 있으면 32바이트 무작위 토큰을 생성해 `token_b64=base64(토큰)`으로 만들고,
   `SHA-256(token_b64)`만 D1(`auth_challenge`)에 5분 TTL로 저장(평문 토큰은 저장하지 않음).
   응답으로 `challenge_ct = base64(RSA-OAEP-2048/SHA-256(UTF8(token_b64), 등록된 공개키))`를 반환.
   (RSA-OAEP-2048 평문 상한 190바이트 — `token_b64`는 44자이므로 직접 봉인 가능, 하이브리드 불필요.)
3. 클라이언트가 자신의 개인키로 `challenge_ct`를 복호화해 `token_b64` 문자열을 얻고, 이를 그대로
   보호 엔드포인트의 `auth_token` 필드에 실어 보낸다.
4. 서버는 `SHA-256(auth_token)`이 해당 `restaurant_id`의 미만료 챌린지와 일치하면 그 챌린지 행을
   즉시 삭제(1회용)하고 요청을 진행한다. 불일치·만료·미제공 시 `401 {error:'auth_required'}`.

`POST /api/approve`는 body에 `restaurant_id`도 함께 받아 summary의 `restaurant_id`와 일치하는지
검증한다(불일치 시 `403 {error:'restaurant_mismatch'}`) — 다른 음식점의 챌린지로 엉뚱한 summary를
승인하는 것을 막기 위함.

### 4.2 암호화 원장 클라우드 백업

음식점 기기가 유실되어도 복구할 수 있도록, 클라이언트가 **자기 공개키로 하이브리드 암호화한**
원장 blob(base64, 최대 1MB)을 서버에 보관할 수 있다. 서버는 이 blob을 복호화할 수 없다
(zero-knowledge 불변식 유지 — §0). `restaurant_id`당 최신본 1행만 유지(upsert).
`POST /api/ledger-backup/delete`로 직접 지울 수도 있고(인증 필요, 없으면 404), `POST
/api/deregister`로 등록을 해제하면 공개키와 함께 **자동으로도** 삭제된다 — 공개키가 없으면
소유 증명(챌린지-응답, §4.1) 자체를 더는 발급받을 수 없어 백업을 되찾을 길이 없어지므로,
서버에 죽은 채로 남기지 않고 즉시 정리한다.

### 4.3 `/api/submit`과 기관 인증

`env.REQUIRE_AGENCY_AUTH==='1'`이면 `X-Agency-Token` 헤더가 유효한 기관 토큰이어야 하며,
없거나 무효하면 `401 {error:'agency_auth_required'}`. 비활성(`'0'`)이면 토큰 없이도
제출을 허용한다. 어느 쪽이든 유효한 토큰이 있으면 검증 후 `consent_log.agency_email_hash`에
**이메일의 SHA-256 해시만** 기록한다(평문 이메일은 절대 저장하지 않음). `agency_token`에 이미
해시가 저장돼 있으므로 재해싱하지 않고 그대로 옮겨 적으며, 값이 64자 hex가 아니면(구버전이
평문으로 남긴 행 — 최대 24시간 내 자연 소멸) 그 자리에서 해싱해 기록한다(평문 유입 차단).

**운영 상태(2026-07~)**: `REQUIRE_AGENCY_AUTH="1"`(필수). OTP 이메일 인증(Resend,
`AUTH_MODE="prod"`)이 라이브에서 `.go.kr` 실주소로 발송·검증까지 정상 확인되어 기관
제출 인증을 필수화했다. 담당자 웹은 `/api/agency/verify-otp`로 받은 토큰을 자동으로
`X-Agency-Token`에 첨부하므로 정상 사용자 흐름은 영향이 없고, 인증 없는 제출만 차단된다.
직접전달 모드는 서버를 경유하지 않으므로 이 게이트와 무관하다.

### 4.4 기관 OTP 인증

- `POST /api/agency/request-otp {email}`: 이메일 **형식 검증**(`^[^\s@]+@[^\s@]+\.[^\s@]+$`,
  200자 이하 — 실패 시 `400 {error:'invalid_email'}`) 후 **허용 도메인**만 통과
  (실패 시 `400 {error:'invalid_domain'}`). 6자리 OTP를 생성해 해시만 저장(10분 TTL, 5회 시도
  제한, 이메일당 60초 재요청 제한).
  - **허용 도메인(2026-08 확장)**: `go.kr`, `korea.kr`, `or.kr`, `ac.kr`. 주 대상은 공공기관
    (`go.kr`·`korea.kr`)이며, 복지관·공단 등 공공성 기관(`or.kr`)과 학교(`ac.kr`)를 추가했다.
    판정은 도메인부(마지막 `@` 뒤)에 대한 정규식 `^([a-z0-9-]+\.)*(go|korea|or|ac)\.kr$`
    (worker.js `AGENCY_EMAIL_DOMAIN_RE`) — 허용값 **그 자체**이거나 그 **하위 도메인**만
    통과한다. 라벨 경계를 강제하므로 `evilgo.kr`(경계 없는 부분 일치)·`go.kr.attacker.com`
    (다른 TLD로 이어짐)·`ac.kr.evil.com`은 모두 거부된다. 담당자 웹의 `AGENCY_EMAIL_RE`
    (`agency-web/index.html`)는 여기에 로컬파트 검사만 덧댄 **동일 규칙**이므로, 한쪽을
    바꾸면 반드시 다른 쪽도 함께 바꿀 것.
  - **저장 키는 이메일의 해시**다. `agency_otp.email`·`agency_token.email` 컬럼(TEXT)에
    해시 문자열을 넣어 재사용하므로 스키마 변경이 없다. 60초 재요청 스로틀·시도 횟수 증가·
    삭제 모두 해시 키 기준으로 동작하며, 서버 어디에도 평문 이메일이 남지 않는다(§0).
    - **pepper(2026-08~)**: `env.EMAIL_PEPPER`(wrangler secret)가 설정돼 있으면 해시는
      `HMAC-SHA256(EMAIL_PEPPER, email)`이다. 순수 SHA-256은 후보 공간이 좁아(허용 도메인 +
      짧은 로컬파트) D1이 유출되면 무차별 대입으로 원본 주소를 역산할 수 있는데, 서버만 아는
      비밀값을 섞으면 그 계산이 불가능해진다.
    - **미설정이면 기존 SHA-256으로 그대로 동작**하므로 secret 등록 전에 배포해도 안전하다
      (배포 순서 자유). 등록 후에도 **구 SHA-256 키로 저장된 행을 조회 폴백**으로 함께 찾으므로
      전환 순간에 진행 중이던 인증이 깨지지 않는다(그 행은 검증 성공 시 삭제되고, 새 행은 항상
      HMAC 키로 저장된다 — 최대 24시간 안에 구 키 행은 자연 소멸한다).
  - **발송 남용 차단(2026-08~)**:
    - **서버 자체 일일 예산**: `AUTH_MODE='prod'`에서 하루 발송량을 D1 카운터
      (`stats_counter`의 `otp_sent_YYYY-MM-DD` — 비식별 집계, 수신자 정보 없음)로 세고,
      `env.OTP_DAILY_BUDGET`(기본 80)을 넘으면 **Resend를 호출하지 않고**
      `429 {error:'email_quota_exceeded'}`를 반환한다(Resend가 429를 준 경우와 같은 코드 —
      담당자에게는 "오늘 한도 도달" 안내로 동일하게 보인다). Resend 무료 플랜의 "하루 100통"에
      닿기 전에 우리 쪽에서 먼저 멈추기 위한 안전 여유값이다. 이 검사는 OTP 행을 만들기
      **전**에 하므로 60초 스로틀을 소모하지 않고, 카운터는 **발송 성공분만** 증가한다.
      D1 카운터라 isolate 분산과 무관한 전역 집계다.
    - **IP당 저한도**: `POST /api/agency/request-otp`는 `CF-Connecting-IP`당 **시간당 5회**로
      별도 제한한다(`429 {error:'rate_limited'}`). 이쪽은 per-isolate 메모리 Map이라 §6.3의
      한계를 그대로 가진다(여러 isolate/IP로 분산하면 우회 가능) — 전역 차단은 위 D1 일일
      예산과 Cloudflare 대시보드 Rate Limiting Rule이 담당한다.
    - **후속 권장(이번 범위 밖)**: `request-otp`와 `/api/public-key`에 **Turnstile**을 붙이면
      봇 기반 대량 요청을 근본적으로 줄일 수 있다. 위젯 발급이 Cloudflare 대시보드 작업이라
      이번 변경에는 포함하지 않았다.
  - **발송 실패 시 스로틀을 소모하지 않는다**: OTP 행을 먼저 쓰고 발송하되, 발송이 실패하면
    (`email_send_failed`·`email_not_configured`) 방금 쓴 행을 삭제한다 — 남겨두면 60초 스로틀에
    걸려 담당자가 재시도조차 못 하는 상태가 된다. 발송에 성공한 뒤에는 스로틀이 정상 적용된다.
  - `env.AUTH_MODE` 세 값 — 응답 분기가 서로 다르다:
    - `"dev"`(로컬 개발 전용): 응답 `{ok:true, dev_otp}` — 평문 OTP를 포함해 이메일 없이 테스트
      가능. **운영 배포 절대 금지.** 이메일 미발송.
    - `"pilot"`(베타 운영값): 응답 `{ok:true, sent:false}` — OTP는 생성·해시 저장하지만
      **발송하지 않는다**(이메일 발송 도메인 온보딩 전 단계). `dev_otp`/`otp` 필드는 포함하지 않음.
    - `"prod"`: Resend REST API(`POST https://api.resend.com/emails`, `worker.js`의
      `sendOtpEmail(env, email, otp)` 헬퍼)로 **실제 이메일을 발송**한다. Cloudflare Email
      Sending은 Workers 유료 플랜이 필요해 쓰지 않고, 무료로 쓸 수 있는 Resend로 전환했다.
      인증 헤더는 `Authorization: Bearer ${env.RESEND_API_KEY}`(wrangler secret, 코드/파일에
      값을 두지 않음). 발신 주소는 `noreply@bapjangbu.com`(표시명 "밥장부"), 제목
      `[밥장부] 인증번호 <6자리>`, 본문(text+html 둘 다)에 6자리 코드·유효시간(10분)·"기관
      담당자 본인확인용, 타인에게 알리지 마세요" 안내를 한국어로 담는다.
      - `env.RESEND_API_KEY`가 설정돼 있지 않으면 발송을 **시도조차 하지 않고**
        `500 {error:'email_not_configured'}`를 반환한다.
      - Resend 응답이 2xx가 아니거나 `fetch` 자체가 실패(reject)하면
        `500 {error:'email_send_failed'}`를 반환하고, 서버 로그에는 실패 사유만 남기며
        이메일 주소·OTP 평문은 로깅하지 않는다.
      - 단, Resend가 **429**(무료 플랜 하루 100통·월 3,000통 한도 초과)를 반환하면
        일시적 한도 초과이므로 `429 {error:'email_quota_exceeded'}`로 구분해 응답한다.
        agency-web은 이 코드에서 "오늘 발송 한도 도달 — 잠시 후 또는 다음 날 재시도"를
        안내한다(담당자 입력 오류가 아님을 명확히 하기 위함).
      - 발송 성공(Resend 2xx) 시 응답 `{ok:true, sent:true}`이며 `otp`/`dev_otp`는 **절대**
        포함하지 않는다.
      **prod 전환 전 선행 조건**: `bapjangbu.com` 도메인을 Resend 대시보드에서 도메인
      인증(DNS 레코드 등록)하고, `wrangler secret put RESEND_API_KEY`로 API 키를 등록해야
      한다 — 완료 전에 `AUTH_MODE`를 `"prod"`로 바꾸면 모든 요청이 `email_not_configured`
      또는 `email_send_failed`로 실패한다.
  - **정직성 원칙(감사 항목 1)**: 어떤 응답에도 평문 OTP가 실려나가서는 안 되므로 `dev_otp`는
    `AUTH_MODE==='dev'`일 때만 포함한다. `wrangler.toml`의 베타 운영값은 `AUTH_MODE="pilot"`이며,
    이 모드에서는 이메일 발송 인프라가 아직 온보딩 전이라 담당자가 실제로 OTP를 받을 방법이
    없다(`sent:false`로 이를 명시). 이 상태에서 "인증됨"이라고 표시하면 거짓이므로, agency-web은
    서버가 실제 이메일 소유를 검증하지 못한 경우(`sent:false` 응답, 그리고 구버전 서버 호환용
    fallback 경로) "✅ 인증됨" 대신 "기관 이메일 형식만 확인됨 — 이 서버에서는 인증번호 확인이
    진행되지 않았습니다"라고 정직하게 표시하고, 실제 OTP 검증 단계를 건너뛴다. `sent:true` 응답을 받으면(prod)
    실제 OTP 입력 단계를 표시하고 `/api/agency/verify-otp`로 검증을 완료한다. 운영 서버는
    이제 `AUTH_MODE="prod"`(실제 이메일 발송) + `REQUIRE_AGENCY_AUTH="1"`(제출 시 토큰 필수)
    이므로 담당자는 verify-otp로 받은 토큰으로만 제출할 수 있다(§4.3의 운영 상태 참조).
    위 `"pilot"` 관련 설명은 인프라 온보딩 전 단계의 fallback 동작 기록이다.
- `POST /api/agency/verify-otp {email, otp}`: 성공 시 32바이트 토큰 발급, 24시간 유효
  (`agency_token`). 이 토큰이 `X-Agency-Token` 헤더 값이 된다. (`AUTH_MODE==='pilot'`에서는
  담당자가 실제 OTP 값을 알 방법이 없으므로 이 엔드포인트가 정상 호출되는 경우가 드물다 —
  위 정직성 원칙 참조.)

### 4.5 업무용 연락처 (선택)

연락처는 음식점 주인이 직접 등록·삭제하는 선택적 사업장 연락 정보다(카카오 오픈채팅 링크는
전화번호·개인 프로필이 비노출되는 형식만 허용) — 담당자가 승인/거절 전에 문의할 수 있는
채널을 제공하되, 전화번호 등 개인 식별 정보는 서버에 두지 않는다는 §0 불변식을 유지한다.
`POST /api/contact`는 소유 증명(`auth_token`, §4.1)을 요구하며, `kakao_link`는 비어 있으면
필드를 삭제(NULL)하고 값이 있으면 `https://open.kakao.com/`로 시작하고 200자 이하여야
한다(`400 {error:'invalid_kakao_link'}`). `email`도 마찬가지로 비어 있으면 삭제하고 값이
있으면 기본 이메일 형식(200자 이하)이어야 한다(`400 {error:'invalid_email'}`). 미등록
`restaurant_id`는 `404`. 등록된 연락처는 `GET /api/public-key` 응답의 `contact` 필드로
노출되며, `POST /api/deregister`로 등록을 해제하면 공개키와 함께 즉시 삭제된다.

### 4.6 관할 지역(선택) · 등록 음식점 지역별 조회

음식점 앱은 `POST /api/register-key` 시 선택 필드 `district`(관할 지역, 예 "서울특별시 광진구")를
함께 보낼 수 있다. `district`는 **가게 주소에서 유도한 공개 사업장 정보**(시도 전체명 + 시군구명)
이므로 §0의 zero-knowledge 불변식을 위반하지 않는다(관할지역은 공개값이라 평문 저장 허용).
서버는 이를 `public_key_registry.district`(≤100자)에 저장한다. **재등록 시 `district`가 오면
갱신**한다 — 멱등 재등록(동일 키, 200)·소유증명 재등록(다른 키) 어느 경로든, 이미 등록된
행(레거시·미채움 포함)이 앱 재등록으로 관할을 채울 수 있게 한다.

담당자 웹은 `GET /api/registered-list?sido=<시도명>&sigungu=<시군구명>`으로 특정 지역의
'등록된(명단 받기 가능)' 음식점을 조회한다.
- 응답 `200 {"restaurants":[{"restaurant_id","restaurant_name","district"}]}`, 이름 가나다 정렬.
- `sido` 필수(없으면 `400 {error:'sido_required'}`), `sigungu`는 선택(없으면 시도 전체).
- **매칭은 정규화 후 '정확 일치'다**(부분 일치 금지):
  - `sigungu`가 있으면 `정규화(district) == "{sido} {sigungu}"`.
  - `sigungu`가 없으면 `정규화(district) == sido` 이거나 `"{sido} "`로 시작(시도 경계를 공백으로 고정).
  - 정규화 = 유니코드 NFC + 연속 공백 1칸 축약 + 앞뒤 공백 제거. `POST /api/register-key`는 **저장 시점에도
    같은 정규화**를 적용하므로 저장값은 항상 `"{시도} {시군구}"` 정규형이다(레거시·외부 유입 행의 공백
    변형은 조회 시 관용 — D1은 `TRIM`+`REPLACE`로 동등 처리).
  - `district` 생성 규칙(3개 컴포넌트 공통): 음식점 앱 `relayDistrict()` = `시도명 + ' ' + 기관명에서 '청' 제거`,
    담당자 웹 `jurisQuery()` = `sido=시도명`, `sigungu=기관명에서 '청' 제거`. 양쪽이 같은 규칙이라 정확 일치가 성립한다.
  - ⚠️ 과거 구현은 `district LIKE '{sido}%' AND district LIKE '%{sigungu}%'`(부분 일치)여서, 시군구명이
    다른 시군구명의 부분문자열인 실제 3쌍 — **부산 서구⊂강서구, 대구 서구⊂달서구, 경기 양주시⊂남양주시** —
    에서 남의 관할 음식점을 함께 반환했다(담당자가 다른 구의 음식점에 명단을 보낼 수 있는 경로). 정확
    일치로 고정된 이유이며, 되돌리면 안 된다(`harness/phase2.e2e.mjs` §20-h 회귀 단언).
  - `sido`·`sigungu`는 LIKE 와일드카드로 해석되지 않는다(`%`·`_`·`\` 이스케이프 + `ESCAPE '\'`).
- `district` 없는(레거시) 등록분은 결과에서 **제외**. 반환은 **공개 정보만**(id·이름·district —
  연락처는 미포함).
- 대량 수집(크롤링) 완화를 위해 `GET /api/public-key`와 동일한 강화 레이트리밋(IP당 분당 20회,
  독립 카운터)을 적용한다(§6.3).

### 4.7 `/api/submit` 멱등(재제출) 응답

동일 `(restaurant_id, batch_hash)` 조합이 이미 있으면 새 행을 만들지 않고 기존 건을 가리키는
응답을 준다. UNIQUE 인덱스 구조상 재제출로 새 summary가 생길 수 없으므로, **"왜 아무 일도
일어나지 않은 것처럼 보이는지"를 알려주는 유일한 통로가 응답**이다.

- 신규 제출: `200 {summary_id}` — 기존 계약 그대로(추가 필드 없음).
- 재제출(중복): `200 {summary_id, deduped:true, status}` — `status`는 기존 건의 현재 상태
  (`PENDING` | `APPROVED` | `REJECTED` | `EXPIRED`).

담당자 웹은 `deduped:true`이고 `status`가 `PENDING`이 아니면 "✅ 보냄"이 아니라 "이미 있는 명단 ·
상태 X"로 표시한다(이미 거절·만료된 명단을 다시 보냈다고 착각하지 않게). `deduped` 필드가 없는
구서버 응답은 기존 동작(그냥 성공)으로 처리된다 — 하위 호환.

### 4.8 열쇠 지문 확인 (가게 선점 방어)

`restaurant_id`(LOCALDATA 관리번호)는 공개값이라, 나쁜 마음을 먹은 사람이 **남의 가게 id로 먼저
공개키를 등록**해 담당자가 보낸 명단을 가로챌 수 있다(선점). §4.10의 공공데이터 실존·상호 대조가
1차 방어지만, 상호까지 그대로 베끼면 통과한다. 최종 방어는 **사람이 육성으로 대조하는 열쇠 지문**이다.

- **지문 정의(세 컴포넌트 공통, 절대 바꾸지 말 것)**:
  `SHA-256(공개키 SPKI raw bytes)` → hex 소문자 → **앞 8자** → 대문자로 4자씩 하이픈 → `ABCD-EF12`.
  음식점 앱은 설정 화면에 이 값을 크게 보여주고, 담당자 웹은 명단을 보내기 전에 같은 값을 계산해
  화면에 띄운다. 담당자(서무)가 사장님께 **전화로 여덟 글자를 불러 대조**한다.
- `POST /api/agency/keycheck`(X-Agency-Token 필수): 담당자가 "확인했다"를 체크하면 호출한다.
  서버는 클라이언트가 보낸 `fingerprint`를 믿지 않고 **`public_key_registry`의 현재 공개키로 직접
  재계산**해 대조한다. 일치하면 `(institution, department, restaurant_id)` 기준 upsert로 저장하고
  `200 {ok:true, fingerprint}`. 불일치면 저장하지 않고 `409 {error:'fingerprint_mismatch', current}`
  (`current`는 서버가 계산한 현재 지문 — 담당자 화면에 "지금 지문은 XXXX-YYYY입니다"로 안내).
  형식이 `^[0-9A-F]{4}-[0-9A-F]{4}$`가 아니면 `400 {error:'invalid_fingerprint'}`(소문자 입력은
  대문자로 정규화), 미등록 음식점은 `404 {error:'not_found'}`.
- `GET /api/agency/keychecks?institution=&department=`(X-Agency-Token 필수): 그 부서가 확인해 둔
  목록. 응답 항목은 **`restaurant_id`·`fingerprint`·`checked_at` 세 필드뿐**이며 인원·금액 등 다른
  정보는 절대 싣지 않는다. `institution`·`department` 둘 다 필수(없으면 400).
- **부서 단위 격리**: 같은 부서는 재확인이 필요 없지만, **같은 기관의 다른 부서**는 처음 보낼 때
  다시 확인해야 한다(한 부서의 확인이 기관 전체의 신뢰로 번지지 않게). 기관 간에도 물론 격리된다.
- **키가 바뀌면 확인은 무효가 된다**: 음식점이 소유 증명 후 다른 키로 재등록하면(기기 교체·탈취 모두
  이 경로다) 지문이 달라져 이전 지문 제출은 `409`가 되고, 담당자 웹은 재확인을 요구해야 한다.
- **보존**: `agency_keycheck`는 **TTL 정리 대상이 아니다**(장기 보관). 확인 이력을 지우면 담당자가
  매번 다시 전화해야 하므로, 개인정보가 없는(조직정보·공개ID·지문·시각) 이 표만 예외로 유지한다.
  음식점이 등록을 해제해도 행은 남지만, 재등록 시 지문이 바뀌면 위 규칙으로 자연히 무효화된다.

### 4.9 `/api/inbox` 인증 · `batch_hash` 오라클 차단

- **인증 필수(2026-08~)**: `GET /api/inbox`는 §4.1의 1회용 `auth_token`을 **쿼리(`?auth_token=`)
  또는 헤더(`X-Auth-Token`)** 로 요구한다. 예전에는 `restaurant_id`만 알면(공개값이다) 누구나 그
  음식점의 기관·부서·총액·인원과 암호문까지 받아갈 수 있었다 — 암호문은 개인키 없이 못 열지만
  요약 메타 자체가 조직 정보이므로 인증 뒤로 옮겼다.
  - ⚠️ **하위호환 주의**: 구버전 음식점 앱은 인증 없이 호출하므로 **서버를 먼저 배포하면 그 사이
    구버전 앱의 수신함이 401로 일시 실패**한다(승인 전 단계라 데이터 손실은 없고, 앱을 새로
    받으면 즉시 복구된다). 앱과 같은 릴리스로 나가는 것을 전제로 수용한 변경이다.
  - `GET /api/inbox-count`는 **현행대로 무인증**이다 — 응답이 `{count}`뿐이라 새로 노출되는
    정보가 0이기 때문이다. 이 엔드포인트에는 앞으로도 요약 메타를 절대 넣지 말 것.
- **`batch_hash`는 응답에서 제거**: 서버가 보관 중인 `batch_hash`를 그대로 돌려주면, 명단 후보를
  가진 자가 "이 배치가 맞나"를 서버에 물어볼 수 있는 확인 채널(오라클)이 된다. 따라서
  `/api/inbox` 응답의 `summary`에는 `batch_hash`가 없다(서버 저장은 유지 — 멱등 판정용).
- **수신 측 검증 규칙(계약)**: 음식점 앱은 **blob 내부(암호문을 연 평문)의 `batch_hash`** 로 변조를
  검증한다. 담당자 웹은 평문 blob에 이 값을 함께 넣는다:
  ```json
  { "v":1, "batch_hash":"<hex>", "items":[ {"name":"…","dept":"…","amount":0}, … ] }
  ```
  `batch_hash` 계산식은 §3 그대로(`name|dept|amount` canonical) — **계산식은 불변이고, 실려 오는
  자리만 요약에서 blob 안으로 옮긴 것**이다. 서버는 blob을 열지 못하므로 이 값을 알 수도, 바꿀
  수도 없다(오라클이 성립하지 않는 이유). blob에 `batch_hash`가 없는 구버전 담당자 웹 전송분을
  앱이 어떻게 처리할지(경고 후 진행 / 차단)는 앱·담당자 웹 릴리스 정책에서 정한다.

### 4.10 가게 등록 강화 (공공데이터 실존·상호 대조)

`POST /api/register-key`의 **최초 등록**(그 `restaurant_id`가 아직 없을 때)에는 공공데이터
(data.go.kr 일반음식점)로 실존 여부와 상호를 대조한다. 실서비스 경로는 **관리번호(MNG_NO) 정확
일치 조회**(`cond[MNG_NO::EQ]` — 값이 ASCII라 §7.4의 한글 조건 장애를 타지 않는다)이고,
`env.searchRestaurants`가 주입된 경우(테스트 목·대체 데이터원)에만 기존 이름 검색 경로를 쓴다.

- 조회 키워드는 상호의 **첫 토큰**(공백·괄호 앞까지)으로 넓게 잡고, 대조는 **정규화 후 전체 이름
  일치**로 판정한다. 정규화 = NFC + 모든 공백 제거 + 괄호류(`()[]{}（）［］｛｝`) 제거 — 앱이 보낸
  `"진짜식당 (본점)"`과 공공데이터의 `"진짜식당(본점)"`이 같은 값으로 취급된다.
- 판정 3분기:
  - **일치** → 등록 200, `public_key_registry.verified = 1`.
  - **불일치**(조회는 됐는데 그 id가 없거나 상호가 다름) → `400 {error:'store_not_found'}`. 공개키는
    저장되지 않는다.
  - **판정 불가**(공공 API 장애·`PUBLIC_API_KEY` 미설정·타임아웃, 또는 결과가 한 페이지 100건을
    가득 채워 잘렸을 가능성) → **등록을 막지 않고** 200, `verified = 0`. **가용성 우선** —
    공공 API가 죽었다고 새 가게가 서비스를 못 쓰게 되어서는 안 된다.
- **재등록(멱등·소유 증명 경로)에서는 재대조하지 않는다** — 이미 그 가게의 개인키를 증명한
  주체이므로 공공 API 상태에 등록 갱신이 좌우되지 않게 한다.
- `verified`는 개인정보가 아니며 `/api/registered-list` 응답에 `registered_at`과 함께 실린다.
  담당자 웹은 `verified=0`·최근 `registered_at`을 "실존 미확인"·"신규 등록" 배지로 표시해 §4.8의
  지문 확인을 유도하는 데 쓴다. 마이그레이션 이전 등록분은 모두 `verified=0`이다(대조를 거치지
  않았으므로 정확한 표기).

### 4.11 인증 도메인 전달 (기관명 자칭 문제, 보안 점검 F-04)

**설계 의도 — 서버가 검증할 수 있는 것과 없는 것을 구분한다.**
`summary.institution`(기관명)·`department`(부서명)는 담당자가 **직접 적어 보내는 자칭 값**이며,
서버는 그것이 참인지 검증할 수단이 없다(기관 명부와 대조할 권위 있는 API가 없고, 있어도
"이 사람이 그 기관 소속"임은 증명되지 않는다). 게다가 §4.4의 허용 도메인은 `go.kr`·`korea.kr`·
`or.kr`·`ac.kr`까지 넓어, **대학 메일 계정 하나로도 "○○구청 총무과" 명의의 제출이 가능**하다.

반면 **어느 도메인의 메일로 OTP 인증을 통과했는가**는 서버가 실제로 확인한 사실이다.
그래서 서버는 그 도메인을 제출 건에 함께 실어 음식점 앱까지 전달하고, **음식점 앱이 기관명과
나란히 표시해 사장님이 눈으로 대조**하게 한다(서버는 판정하지 않는다 — 판단은 사람이 한다).

- **저장 위치·시점**
  - `POST /api/agency/verify-otp` 성공 시: 인증된 이메일의 **도메인부만** 소문자로 정규화해
    `agency_token.email_domain`에 저장한다(예 `gwangjin.go.kr`). **로컬파트는 저장하지 않는다** —
    저장·전달되는 값에 사람을 가리키는 부분이 없으므로 개인정보가 아니며, 평문 이메일 미저장
    불변식(§0)은 그대로 유지된다(이메일 자체는 여전히 해시로만 남는다).
  - `POST /api/submit`: 유효한 `X-Agency-Token`이 있으면 그 토큰 행의 도메인을
    `deposit_summary.agency_domain`에 옮겨 적는다. **출처는 토큰 행뿐이며, 요청 body의
    `summary.agency_domain`은 무시한다**(자칭 값이 끼어들 틈을 남기지 않는다).
  - `GET /api/inbox`: 응답 `summary.agency_domain`으로 그대로 노출한다.
- **`null`의 의미(하위호환)**: 아래 경우 `agency_domain`은 `null`이며, 서버는 `null`을 그대로
  내보낸다. **음식점 앱은 `null`을 "확인 불가"로 표시**한다(빈칸으로 두지 말 것 — 표시가 없으면
  사장님은 검증된 것으로 오해한다).
  - 마이그레이션 이전에 발급된 구버전 토큰(`email_domain` 없음) — 24시간 내 자연 소멸.
  - 마이그레이션 이전에 저장된 `deposit_summary` 행.
  - `REQUIRE_AGENCY_AUTH='0'`이거나 `AUTH_MODE`가 `pilot`/fallback이라 토큰 없이 제출된 건
    (pilot에서는 담당자 웹이 OTP 검증 단계를 건너뛰므로 애초에 토큰이 없다).
  - 도메인 모양이 아닌 손상 값(방어적으로 `null` 처리).
- **`batch_hash`와 무관**: canonical은 §3의 `name|dept|amount` **그대로 불변**이다. `agency_domain`은
  summary(메타)에만 추가되는 필드이며 해시 계산에 들어가지 않으므로, 이 변경으로 기존 담당자 웹·
  음식점 앱의 해시 대조가 깨지지 않는다.
- **한계(정직하게)**: 이것은 "기관명이 참임"의 증명이 아니라 **대조 재료의 제공**이다. 같은 기관의
  다른 부서를 사칭하는 경우처럼 도메인이 일치하는 사칭은 이것으로 걸러지지 않는다(그쪽은 §4.8
  열쇠 지문 확인과 수령 전 사장님 확인이 담당한다).
- **배포 순서**: `server/migrations-2026-08.sql`의 문 4·5 적용 → `wrangler deploy` → 프론트 배포.

## 5. 상태 머신
`deposit_summary.status`: `PENDING` →(approve)→ `APPROVED` / `REJECTED`, 또는
`PENDING` →(72시간 미수령)→ `EXPIRED`.
거절 시 음식점 앱은 복호화하지 않고 폐기. 승인 시에만 blob 복호화.
`APPROVED`/`REJECTED`/`EXPIRED` 어느 쪽이든 상태 전이 시점에 `encrypted_blob` 행이 파기된다(§6).
`processed_at`(상태 전이 시각)은 비식별 요약의 TTL 정리(30일, §6)의 기준이 된다.

## 6. 보존 기간 · TTL 정리(cron) · 레이트 리밋

### 6.0 보존 정책 (요약)

암호문(`encrypted_blob`)은 **음식점이 수령(승인/거절)하는 즉시 파기**되며, 수령하지 않은
경우에도 **최대 72시간(3일) 후 자동 파기**된다. 개인을 식별할 수 없는 요약 정보
(`deposit_summary`의 총액·인원수·해시·상태)만 처리 완료 후 30일간 보관 후 삭제된다.
`consent_log`(기관·부서·연월·기관 이메일 해시)와 `feedback`(자유 입력 본문)은 180일 후
TTL cron이 삭제한다(§6.3). 이메일 해시의 pepper(HMAC)는 2026-08에 도입됐다(§4.4).

**예외(장기 보관)**: `agency_keycheck`(§4.8 열쇠 지문 확인 이력)와 `public_key_registry`(등록 유지 중인
공개키·관할·연락처)는 TTL 정리 대상이 아니다 — 전자는 지우면 담당자가 매번 다시 전화해야 하고,
후자는 등록이 유지되는 동안 필요한 현재 상태다. 둘 다 개인정보를 담지 않는다(조직정보·공개ID·
공개키·지문·시각).

이와 별도로 담당자 웹에는 **무보관 모드("직접 전달")**가 존재한다 — 담당자가 암호화한 blob을
서버로 전송하지 않고 파일·QR 등으로 음식점에 직접 전달하는 경로로, 이 경로에서는 명단(암호문
포함)이 **서버에 일절 저장되지 않는다**. 이 모드는 담당자 웹(클라이언트) 구현이며, 본 문서가
기술하는 서버(`worker.js`)에는 해당 경로를 위한 별도 코드가 없다 — 서버는 그저 호출되지 않을
뿐이다.

### 6.1 즉시 파기 (승인/거절)

`POST /api/approve`가 `deposit_summary.status`를 `PENDING`에서 `APPROVED` 또는 `REJECTED`로
전이시키는 데 성공하면, 같은 요청 처리 안에서 곧바로 해당 `summary_id`에 연결된
`encrypted_blob` 행을 삭제한다. 상태 전이가 실패(이미 처리됨 등)하면 blob은 삭제되지
않으므로 재시도가 안전하다. `deposit_summary` 행(비식별 요약) 자체는 삭제하지 않고 §6.3의
30일 TTL까지 유지한다.

### 6.2 미수령 72시간 만료

`PENDING` 상태로 72시간(제출 시각 `created_at` 기준) 지난 항목은 이중으로 방어된다:

1. **조회 시점**: `GET /api/inbox`는 `status='PENDING'`이어도 `created_at`이 72시간을
   넘었으면 결과에서 제외한다(아래 cron이 아직 돌지 않았어도 노출되지 않음).
   `GET /api/inbox-count`도 같은 조건을 COUNT에 적용해 만료분을 세지 않는다.
   두 엔드포인트는 **`encrypted_blob` JOIN까지 동일**하다 — 암호문이 이미 파기된 고아 summary는
   `/api/inbox`에 나오지 않으므로 개수에서도 빠져야 한다(그렇지 않으면 "열 수 없는 알림 배지"가
   남는다). 즉 언제나 `inbox-count == inbox.length`.
2. **cron 시점**: TTL cron이 하루 1회 돌 때, 72시간 지난 `PENDING` 항목을 `status='EXPIRED'`로
   전이시키고 연결된 `encrypted_blob`을 즉시 삭제한다(`processed_at`을 전이 시각으로 기록).

### 6.3 TTL cron · 레이트 리밋

- **TTL cron** (`wrangler.toml` `[triggers] crons`, 매일 UTC 18:17=KST 새벽 03:17): 개인정보
  최소화 목적으로 ① 72시간 지난 `PENDING`을 `EXPIRED`로 전이하며 `encrypted_blob`을 즉시 삭제
  (§6.2 — 승인/거절 건은 §6.1에서 이미 즉시 삭제되었으므로 이 단계는 대개 no-op),
  ② `APPROVED`/`REJECTED`/`EXPIRED` 후 30일 지난 `deposit_summary`(+ 혹시 남아있는
  `encrypted_blob`)를 삭제, ③ 만료된 `auth_challenge`/`agency_otp`/`agency_token`을 삭제,
  ④ 180일 지난 `consent_log`와 `feedback`을 삭제(§6.0). 서버는 zero-knowledge이며 원장 진실은 항상
  음식점 기기에 있으므로, 이 정리는 서버 보관 데이터를 줄이는 것일 뿐 데이터 손실이 아니다.
  - ①②는 대상 id를 **100개씩 묶어 `IN (...)` 배치 문**으로 실행한다(행마다 문장 2개를 발행하던
    구현과 결과는 동일하고 D1 왕복만 줄인다 — 만료 건이 몰린 날 cron이 폭주하지 않게).
- **레이트 리밋(베스트 에포트)**: `CF-Connecting-IP`당 분당 60회로 per-isolate 메모리 Map을
  사용해 제한한다(초과 시 `429 {error:'rate_limited'}`). Cloudflare Workers는 요청마다 다른
  isolate로 라우팅될 수 있어 이 Map은 전역 카운터가 아니며 **완전한 보장이 아니다**. 운영에서는
  Cloudflare 대시보드의 Rate Limiting Rule(요청 기반, 전역 집계)을 **병행 적용**할 것을 권장한다.
  - **엔드포인트별 강화 한도(각각 독립 카운터)**: `GET /api/public-key`·`GET /api/registered-list`·
    `POST /api/challenge` = IP당 분당 20회, `GET /api/admin/stats` = 분당 10회,
    `POST /api/feedback` = 분당 5회, `POST /api/agency/request-otp` = **시간당 5회**(§4.4).
  - **미소비 챌린지 상한**: `POST /api/challenge`는 발급 전에 그 `restaurant_id`의 만료된
    챌린지를 지우고, 그래도 미만료 챌린지가 **5개** 이상이면 `429 {error:'too_many_challenges'}`
    로 거절한다. 정상 클라이언트는 발급 즉시 1회용으로 소비하므로 영향이 없고, 저장 남용
    (무한 발급으로 `auth_challenge`를 부풀리기)만 막힌다.
  - **`GET /api/public-key`는 별도로 더 낮은 한도(IP당 분당 20회)를 추가 적용한다**(감사 항목
    3) — 이 엔드포인트는 업무용 연락처(카톡 링크·이메일)까지 노출하므로 대량 수집(크롤링)
    유인이 더 크다. 다만 이 역시 per-isolate 메모리 Map의 한계를 그대로 가지는 **베스트
    에포트일 뿐 완전한 방어가 아니다** — 공격자가 여러 IP/isolate로 분산하면 우회 가능하다.
    운영에서는 이 엔드포인트에 Cloudflare 대시보드 Rate Limiting Rule 또는 **Turnstile**을
    병행 적용할 것을 권장한다.

### 6.4 응답 보안 헤더

모든 API 응답(성공·오류·OPTIONS 프리플라이트 포함)에 아래 4개를 붙인다. `worker.js`의 응답 헬퍼
한 곳(`SECURITY_HEADERS` + `json()`)에서 나오므로 엔드포인트별로 빠질 수 없다.

| 헤더 | 값 | 이유 |
|---|---|---|
| `Cache-Control` | `no-store` | API 응답(수신함 요약 등)이 중간 캐시·브라우저 디스크에 남지 않게 |
| `X-Content-Type-Options` | `nosniff` | JSON을 다른 타입으로 해석시키는 스니핑 공격 차단 |
| `Referrer-Policy` | `no-referrer` | 쿼리(`restaurant_id`·`auth_token`)가 리퍼러로 외부에 새지 않게 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | 평문 HTTP 다운그레이드 차단 |

CORS 헤더와는 독립이므로 **CORS 동작(화이트리스트 echo / Origin 없으면 헤더 생략)은 그대로**다.

## 7. 컴플라이언스

- **이 서버는 자금 이동·결제·정산 기능이 없으며, 앞으로도 추가하지 않는다.** 계좌번호·카드번호·
  이체 API 연동, 잔액 보관, 정산 자동화 등은 전자금융거래법(전금법) 상 별도 인허가가 필요한
  영역이므로 범위 밖이다. 이 서버가 하는 일은 오직 (1) 공개키 등록/조회, (2) 암호문 중계,
  (3) 소유 증명 인증, (4) 최소한의 집계(총액·인원수) 보관뿐이다.
- **암호문 외 개인정보를 저장하지 않는다.** 직원명·개인별 금액·전화번호는 서버 어디에도
  평문으로 존재하지 않는다(§0). 기관 OTP 인증의 이메일도 해시로만 남긴다(§4.3).
- **암호문은 수령 즉시 파기, 미수령 시 최대 72시간(3일) 후 자동 파기한다.** 비식별 요약
  (총액·인원·해시)만 30일 보관한다(§6). 무보관 모드("직접 전달")를 이용하면 명단이 서버에
  일절 저장되지 않는다(구현은 담당자 웹 클라이언트 측 — 서버 코드 변경 없음).
- 원장의 진실은 항상 음식점 기기에 있다(로컬 우선). 서버는 전송 중계와 백업 보관소일 뿐,
  권위 있는 원장이 아니다.

## 8. 비식별 집계 통계 · 관리자 API · 피드백

운영 현황 파악을 위해 **개인을 식별할 수 없는 집계·조직 정보만** 수집한다. 직원명·개인별
금액·전화번호·이메일 평문/해시는 이 통계 어디에도 저장하지 않는다(§0 불변식 유지). 통계
증가 로직은 모두 `try/catch`로 감싸 실패해도 본 기능이 깨지지 않게 하며, 개인정보를 로깅하지
않는다.

### 8.1 집계 대상 테이블 (모두 비개인)

- `seen_institution(name)` — 기관명(조직정보). 중복 없이 몇 개 기관이 사용했는지.
- `seen_department(key)` — "기관명부서명" 조합(조직정보). 부서 단위 사용 폭.
- `seen_restaurant(restaurant_id)` — 음식점 공개ID(LOCALDATA `mgtNo` — 공개값). 누적 등록 음식점 수.
- `stats_counter(name, count)` — 누적 카운터. `sends`(총 발송), `sends_YYYY-MM`(월별 발송),
  `registrations`(신규 등록), `searches`(검색), `members_total`(집계 인원 누적),
  `amount_total`(집계 금액 누적).
- `feedback(id, role, message, contact, created_at)` — 사용자 피드백(§8.3). 180일 후 TTL cron이 삭제(§6.3).
- `stats_counter`의 `otp_sent_YYYY-MM-DD` — OTP 이메일 일일 발송 건수(§4.4의 예산 검사에 사용).
  수신자 정보 없이 "그날 몇 통" 숫자만 남는 비식별 카운터다.
- `agency_keycheck(institution, department, restaurant_id, fingerprint, checked_at)` — 열쇠 지문 확인
  이력(§4.8). 조직정보·공개ID·공개키 지문·시각만 — 개인정보 없음. **TTL 정리 대상 아님(장기 보관).**

증가 시점(성공 시에만):
- `POST /api/submit` 성공: `seen_institution(institution)`·`seen_department(institution+department)`
  INSERT OR IGNORE, `sends`+1·`sends_${year_month}`+1·`members_total`+=member_count·
  `amount_total`+=total_amount. **직원명·개인별 금액은 저장하지 않고 summary의 집계값만 누적.**
- `POST /api/register-key` 신규 등록(기존에 없던 `restaurant_id`): `seen_restaurant` INSERT OR
  IGNORE, `registrations`+1. (다른 키로의 재등록·동일 키 재시도는 신규가 아니므로 카운트 안 함.)
- `GET /api/restaurants` 검색: `searches`+1.

### 8.2 관리자 통계 API

`GET /api/admin/stats`, 헤더 `X-Admin-Token`:
- `env.ADMIN_TOKEN`(wrangler secret) 미설정 → `503 {error:'admin_not_configured'}`(기능 잠금).
- 토큰 불일치 → `401 {error:'unauthorized'}`(상수시간 비교로 타이밍 공격 방어).
- 브루트포스 방어를 위해 IP당 분당 10회 별도 레이트리밋(`429 {error:'rate_limited'}`).
- 성공 시 JSON(개인정보 필드 없음):

```json
{
  "restaurants": { "current": 0, "total": 0 },
  "institutions_total": 0,
  "departments_total": 0,
  "sends": { "total": 0, "this_month": 0 },
  "pending": 0,
  "members_total": 0,
  "amount_total": 0,
  "feedback": [ { "role": "음식점", "message": "…", "contact": "…", "created_at": 0 } ]
}
```

- `restaurants.current` = `public_key_registry` 행수(현재 등록 유지 중), `restaurants.total` =
  `seen_restaurant` 행수(역대 누적, 해제해도 유지).
- `sends.this_month`는 **서버가 계산한 현재 UTC 연월**(`sends_YYYY-MM`) 카운터.
- `feedback`은 최근 50개, 최신순.
- `admin.html`은 `nulmaru.github.io`에서 서빙되어 이미 `ALLOW_ORIGIN`에 포함(CORS는
  `X-Admin-Token` 헤더 허용).

### 8.3 피드백 수신 API

`POST /api/feedback` body `{role, message, contact?}`:
- `role`: `'음식점'|'기관'|'직원'|'기타'` 화이트리스트(그 외 `400 {error:'invalid_role'}`).
- `message`: 1~2000자 필수(범위 밖 `400 {error:'invalid_message'}`).
- `contact`: 선택, 0~200자(초과 `400 {error:'invalid_contact'}`).
- **전화번호 차단(불변식 4)**: `message`·`contact` 어느 쪽이든 휴대전화번호 패턴
  (`01[0-9]-?\d{3,4}-?\d{4}`)이 있으면 **저장하지 않고** `400 {error:'no_personal_info'}`.
  자유 입력은 사용자가 "연락처: 010-…"을 무심코 적기 가장 쉬운 창구라 서버에서 막는다.
  날짜(`2026-08-01`) 등 다른 숫자는 통과한다.
- 스팸 방지로 IP당 분당 5회 레이트리밋(`429`). 성공 시 `200 {ok:true}`.
- **주의**: 자유 입력이므로 저장은 그대로 하되, 응답·서버 로그에 입력 내용을 반영하지 않는다.

## 7.4 공공데이터 API 한글 조건 장애 (2026-08-08 확인, 진행 중)

data.go.kr **행정안전부_식품_일반음식점 조회서비스**(`apis.data.go.kr/1741000/general_restaurants/info`)가
**조건값에 한글이 들어가면 언제나 0건**을 돌려준다. 우리 쪽 문제가 아님을 다음으로 확인했다.

- `cond[BPLC_NM::LIKE]=김밥` → `resultCode "0"`(정상) + `totalCount 0`.
  UTF-8·EUC-KR·이중 인코딩·소문자 퍼센트 표기 모두 동일.
- 같은 조건에 **ASCII 값**(`cond[BPLC_NM::LIKE]=1`)을 주면 정상(23,661건). 상호 아닌 다른 한글 필드
  (`cond[ROAD_NM_ADDR::LIKE]=광진`, `cond[BZSTAT_SE_NM::EQ]=기타`)도 똑같이 0건 — **필드가 아니라
  값의 한글 여부**가 갈림선이다.
- 지역코드(`cond[OPN_ATMY_GRP_CD::EQ]=3040000`, 18,284건)·우편번호(`cond[ROAD_NM_ZIP::EQ]=05021`,
  149건)·관리번호(`cond[MNG_NO::EQ]`, 1건)는 ASCII라 정상 동작한다. 연산자는 `::EQ`/`::LIKE`만 유효
  (`::CONTAIN` 등은 HTTP_ERROR), `numOfRows`는 500·1000을 넣어도 **100이 상한**이다.

**우회 설계(현재 구현):** 상호(한글)는 서버가 후보를 받아 **우리 코드에서** 부분일치로 거른다.
후보를 좁히는 키는 ASCII인 우편번호(`zip`)·지역코드(`region`)다. 상호 조건은 요청에 그대로 남겨
두므로 **상대가 고치면 자동으로 예전 성능으로 복귀**한다(코드 변경 불필요).

**재확인 방법:** `curl "https://prepaid-relay.sulsul-plus.workers.dev/api/restaurants?q=김밥"` 이
0건이 아니게 되면 복구된 것이다. 복구 후에도 우편번호 경로는 유지한다(더 정확한 검색 수단).

**동 이름 보조 경로(2026-08-09, beta.36):** 사장님이 우편번호를 모를 때를 위해 앱이
"광진구 구의동" 같은 동 이름을 정적 zipmap(`zipmap/…`, 우체국 우편번호 DB에서 생성)으로 우편번호
목록으로 바꿔 이 `?zip=` 검색을 구역별로 순회한다(클라이언트 전용 — 서버 계약 무변경).
probe(`server/probe-emd.mjs`) 실측 결과 공공 API 응답·조건에 법정동 코드 필드가 없어
동코드 직접 조회는 불가능하다.
