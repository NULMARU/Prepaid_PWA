# 2차(다자간 연동) 배포·검증 가이드

3자 연동을 구성하는 컴포넌트와, 로컬 검증 → Cloudflare 배포 → 실제 LOCALDATA 키 연결 순서를 정리한다.
프로토콜·암호 포맷은 [`server/PROTOCOL.md`](../server/PROTOCOL.md) 기준.

```
담당자 웹(agency-web)  ──암호문──▶  중계 서버(server, Cloudflare Worker+D1)  ──암호문──▶  음식점 앱(index.html PWA)
       (직원명·선금만 RSA 암호화)        (총액·해시·암호문만 보관, 복호화 불가)        (개인키로 복호화·승인·원장 등록)
```

---

## A. 로컬 검증 (Cloudflare·실키 없이 — 이미 통과)

```bash
# 1) 자동 검증 (서버 로직 + 암호 전 구간)
node harness/phase2.e2e.mjs        # 14/14 통과: 등록→검색→암호화→제출→수신→복호화→batch_hash→변조탐지

# 2) 수동 로컬 구동
node server/dev-server.mjs                 # 중계 서버(목 검색) :8788
python3 -m http.server 8769                # PWA(음식점 앱)  → http://localhost:8769/index.html
python3 -m http.server 8770 -d agency-web  # 담당자 웹        → http://localhost:8770/
```
음식점 앱 설정 → "서버 연동"에 `http://localhost:8788` + 음식점 ID 입력 → **공개키 등록**.
담당자 웹에서 같은 서버 주소 입력 → 인증 → 검색(지역코드 입력) → CSV 업로드 → 동의·전송.
음식점 앱 → "기관 신청 수신함" → 승인 → 명단이 복호화되어 원장에 등록.

---

## B. Cloudflare 배포 (사용자 작업 — 로그인·계정 필요)

```bash
npm i -g wrangler          # 또는 npx 사용
cd server
wrangler login             # 브라우저 로그인 (대화형) → 터미널에서 직접 실행 필요

# D1 생성 → 출력된 database_id 를 wrangler.toml 의 REPLACE_WITH_D1_ID 에 기입
wrangler d1 create prepaid-relay
wrangler d1 execute prepaid-relay --remote --file=schema.sql

# LOCALDATA 인증키를 시크릿으로 등록 (파일에 두지 말 것)
wrangler secret put LOCALDATA_KEY        # 프롬프트에 키 붙여넣기

wrangler deploy            # → https://prepaid-relay.<계정>.workers.dev
```
배포 후 `wrangler.toml`의 `ALLOW_ORIGIN`을 실제 PWA/담당자 웹 도메인으로 좁힐 것(보안).

---

## C. LOCALDATA 인증키 검증 (가장 먼저 확인)

`행정안전부_식품_일반음식점 조회서비스` 키가 정상인지 1회 호출로 확인한다.
**정확한 엔드포인트·파라미터명은 data.go.kr 마이페이지 → 오픈API → 활용신청 현황 → 해당 서비스 상세의 "요청주소·샘플코드"에서 확인** 후 교정한다.

- 키가 **localdata.go.kr** 발급(authKey)일 때 예시:
```bash
curl "http://www.localdata.go.kr/platform/rest/TO0/openDataApi?authKey=<키>&resultType=json&opnSvcId=07_24_04_P&localCode=<지역코드>&pageIndex=1&pageSize=5"
```
- 키가 **data.go.kr** 발급(serviceKey)일 때 → 활용신청 상세의 샘플 URL을 그대로 사용(파라미터명이 `serviceKey`).

확인 포인트:
- `opnSvcId` 일반음식점 코드(예상 `07_24_04_P`) — 활용 페이지에서 실제 값 확인 후 `wrangler.toml`의 `LOCALDATA_OPNSVCID` 교정.
- `localCode`(지역코드, 시군구) — 담당자 웹의 `region` 입력값.
- 응답 필드 `bplcNm`(상호)·`rdnWhlAddr`/`siteWhlAddr`(주소)·`trdStateNm`(영업상태)·`mgtNo`(관리번호=restaurant_id). 실제 응답의 필드명이 다르면 `server/src/worker.js`의 `defaultSearch` 매핑을 교정.
- 로컬에서 실제 키로 검색 테스트:
```bash
LOCALDATA_KEY=<키> node server/dev-server.mjs
curl "http://localhost:8788/api/restaurants?region=<지역코드>&q=<상호일부>"
```

> 참고: LOCALDATA OpenAPI는 **사업장명 직접 검색 파라미터가 없어** 지역으로 받아와 서버에서 이름 필터링한다(스펙 §10-4 "지역 필수"와 일치). 데이터갱신일 기반 호출은 전월 24일~당일 범위 제한이 있으니, 전체 스냅샷이 필요하면 파일데이터(CSV) 적재 방식(스펙 대안)을 검토.

---

## D. 보안·법률 게이트 (출시 전 필수)
- 서버는 평문 개인정보를 저장·로깅하지 않는다(불변식). `worker.js`는 평문 ciphertext 제출을 거부한다.
- 담당자 웹 동의문(§5.1)·전화번호 직접수집 고지(§5.2, 음식점 앱)는 **법률 검토 후 문구 확정**(현재 placeholder).
- 기관 이메일 인증은 현재 **도메인 확인 스텁** — 실제 발송 인증(매직링크/OTP)은 메일 서비스 연결 필요.
- 개인키는 음식점 기기에만 존재(서버 미보관). 분실 대비 [개인키 백업](../CHANGELOG.md) 필수.
