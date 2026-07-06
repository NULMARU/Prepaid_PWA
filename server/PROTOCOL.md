# 다자간 연동 프로토콜 v1 (담당자 웹 ↔ 중계 서버 ↔ 음식점 앱)

> 본 문서는 세 컴포넌트가 공유하는 **암호 blob 포맷·batch_hash 규칙·REST 계약**의 단일 기준이다.
> 스펙 §1.2(불변식), §2.2(서버 스키마), §4.2(암호화)를 구현으로 고정한다.

## 0. 절대 불변식 (서버 코드가 반드시 지킴)
- 서버는 **평문 개인정보(직원명·금액 리스트·전화번호)를 저장·로깅하지 않는다.** 저장 대상은 암호문(`ciphertext`)뿐이며 서버는 복호화 키가 없다.
- 전화번호는 담당자 경로(웹·서버·blob)에 **존재하지 않는다.**
- 집계(`deposit_summary`)는 총액·인원수·해시만 보관한다(개인별 금액·이름 ❌).

## 1. 키
- 음식점 앱: `RSA-OAEP` 2048 / SHA-256 키페어. 공개키는 SPKI를 base64로 인코딩해 등록.
- 식별자 `restaurant_id`: LOCALDATA 관리번호(`mgtNo`) 또는 음식점이 설정에서 정한 값. 등록·blob·summary에서 동일하게 사용.

## 2. 암호 blob 포맷 (하이브리드: AES-GCM 본문 + RSA-OAEP 키 봉인)
명단이 RSA 직접 암호화 한계(~190B)를 넘으므로 하이브리드 고정.

평문(직원 명단):
```json
{ "v":1, "items":[ {"name":"홍길동","dept":"세무과","amount":90000}, ... ] }
```
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

## 4. REST 계약 (서버)
모든 응답 JSON. 오류는 `{error}` + 상태코드.

| 메서드·경로 | 요청 | 응답 | 비고 |
|---|---|---|---|
| `POST /api/register-key` | `{restaurant_id, restaurant_name, public_key, auth_token?}` | `{ok:true}` | 공개키 등록. 최초 등록·동일 키 재등록은 인증 불요. 다른 키로 재등록 시 `auth_token` 필요(§4.1) |
| `POST /api/challenge` | `{restaurant_id}` | `{challenge_ct}` / 404 | 소유 증명 챌린지 발급(§4.1) |
| `POST /api/deregister` | `{restaurant_id, auth_token}` | `{ok:true}` / 401 | 음식점 주인 등록 해제(선금 받기 중단) → 공개키 삭제(연락처·원장 클라우드 백업도 함께 삭제, §4.2). 인증 필요 |
| `POST /api/contact` | `{restaurant_id, auth_token, kakao_link, email}` | `{ok:true}` / 400/401/404 | 업무용 연락처 등록·수정·삭제(§4.5). 인증 필요 |
| `GET /api/public-key?restaurant_id=` | — | `{restaurant_id, public_key, contact:{kakao_link,email}}` / 404 | 담당자 웹이 암호화 전 조회. `contact`는 미등록 시 각 필드 `null`. IP당 분당 20회로 별도 레이트리밋(§6.3) |
| `GET /api/registered?ids=a,b,c` | — | `[등록된 id…]` | 담당자 웹: '선금 받기 가능' 표시용 |
| `GET /api/restaurants?region=&q=` | — | `[{restaurant_id,name,address,status}]` | data.go.kr 프록시(키 은닉). 지역 또는 이름 중 하나 필수, 폐업 제외 |
| `POST /api/submit` | `{summary, blob, consent}` (아래) + 헤더 `X-Agency-Token`(운영 시 필수) | `{summary_id}` / 401 | 부서·음식점 단위 1건(§4.3) |
| `GET /api/inbox?restaurant_id=` | — | `[{summary_id, summary, ciphertext, status}]` | 음식점 앱 폴링(PENDING만) |
| `POST /api/approve` | `{summary_id, status:"APPROVED"\|"REJECTED", restaurant_id, auth_token}` | `{ok:true}` / 401/403/404/409 | 승인/거절. 상태 전이 성공 시 암호문(`encrypted_blob`) 즉시 파기(§6). 인증 필요 |
| `POST /api/ledger-backup` | `{restaurant_id, auth_token, blob, blob_hash}` | `{ok:true}` | 암호화 원장 클라우드 백업 upsert(§4.2). 인증 필요 |
| `POST /api/ledger-backup/get` | `{restaurant_id, auth_token}` | `{blob, blob_hash, updated_at}` / 404 | 백업 조회. 인증 필요 |
| `POST /api/ledger-backup/delete` | `{restaurant_id, auth_token}` | `{ok:true}` / 401/404 | 백업 삭제(예: 기기를 되찾아 클라우드 백업이 더 이상 필요 없을 때). 인증 필요 |
| `POST /api/agency/request-otp` | `{email}` | `{ok:true, dev_otp?, sent?}` / 500 | 기관 이메일 OTP 발급(§4.4) |
| `POST /api/agency/verify-otp` | `{email, otp}` | `{token}` / 401 | OTP 검증 → 24시간 기관 토큰 발급 |

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
**이메일의 SHA-256 해시만** 기록한다(평문 이메일은 절대 저장하지 않음).

**운영 상태(2026-07~)**: `REQUIRE_AGENCY_AUTH="1"`(필수). OTP 이메일 인증(Resend,
`AUTH_MODE="prod"`)이 라이브에서 `.go.kr` 실주소로 발송·검증까지 정상 확인되어 기관
제출 인증을 필수화했다. 담당자 웹은 `/api/agency/verify-otp`로 받은 토큰을 자동으로
`X-Agency-Token`에 첨부하므로 정상 사용자 흐름은 영향이 없고, 인증 없는 제출만 차단된다.
직접전달 모드는 서버를 경유하지 않으므로 이 게이트와 무관하다.

### 4.4 기관 OTP 인증

- `POST /api/agency/request-otp {email}`: `.go.kr`/`.korea.kr` 도메인만 허용. 6자리 OTP를
  생성해 해시만 저장(10분 TTL, 5회 시도 제한, 이메일당 60초 재요청 제한).
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
    fallback 경로) "✅ 인증됨" 대신 "기관 이메일 형식 확인됨 (파일럿 — 정식 이메일 인증은 준비
    중)"이라고 정직하게 표시하고, 실제 OTP 검증 단계를 건너뛴다. `sent:true` 응답을 받으면(prod)
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
`consent_log`(기관·부서·연월·기관 이메일의 SHA-256 해시)는 180일 후 TTL cron이 삭제한다
(§6.3). 이메일 해시에 salt/pepper를 추가하는 것은 이번 범위 밖이며 향후 개선 제안으로만
남긴다(무차별 대입으로 `.go.kr` 이메일 후보를 역산하는 것을 더 어렵게 하는 목적).

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
2. **cron 시점**: TTL cron이 하루 1회 돌 때, 72시간 지난 `PENDING` 항목을 `status='EXPIRED'`로
   전이시키고 연결된 `encrypted_blob`을 즉시 삭제한다(`processed_at`을 전이 시각으로 기록).

### 6.3 TTL cron · 레이트 리밋

- **TTL cron** (`wrangler.toml` `[triggers] crons`, 매일 UTC 18:17=KST 새벽 03:17): 개인정보
  최소화 목적으로 ① 72시간 지난 `PENDING`을 `EXPIRED`로 전이하며 `encrypted_blob`을 즉시 삭제
  (§6.2 — 승인/거절 건은 §6.1에서 이미 즉시 삭제되었으므로 이 단계는 대개 no-op),
  ② `APPROVED`/`REJECTED`/`EXPIRED` 후 30일 지난 `deposit_summary`(+ 혹시 남아있는
  `encrypted_blob`)를 삭제, ③ 만료된 `auth_challenge`/`agency_otp`/`agency_token`을 삭제,
  ④ 180일 지난 `consent_log`를 삭제(§6.0). 서버는 zero-knowledge이며 원장 진실은 항상 음식점
  기기에 있으므로, 이 정리는 서버 보관 데이터를 줄이는 것일 뿐 데이터 손실이 아니다.
- **레이트 리밋(베스트 에포트)**: `CF-Connecting-IP`당 분당 60회로 per-isolate 메모리 Map을
  사용해 제한한다(초과 시 `429 {error:'rate_limited'}`). Cloudflare Workers는 요청마다 다른
  isolate로 라우팅될 수 있어 이 Map은 전역 카운터가 아니며 **완전한 보장이 아니다**. 운영에서는
  Cloudflare 대시보드의 Rate Limiting Rule(요청 기반, 전역 집계)을 **병행 적용**할 것을 권장한다.
  - **`GET /api/public-key`는 별도로 더 낮은 한도(IP당 분당 20회)를 추가 적용한다**(감사 항목
    3) — 이 엔드포인트는 업무용 연락처(카톡 링크·이메일)까지 노출하므로 대량 수집(크롤링)
    유인이 더 크다. 다만 이 역시 per-isolate 메모리 Map의 한계를 그대로 가지는 **베스트
    에포트일 뿐 완전한 방어가 아니다** — 공격자가 여러 IP/isolate로 분산하면 우회 가능하다.
    운영에서는 이 엔드포인트에 Cloudflare 대시보드 Rate Limiting Rule 또는 **Turnstile**을
    병행 적용할 것을 권장한다.

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
