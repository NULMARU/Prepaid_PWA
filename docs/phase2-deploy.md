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

# data.go.kr 인증키를 시크릿으로 등록 (파일에 두지 말 것, Decoding/일반 키 사용)
wrangler secret put PUBLIC_API_KEY       # 프롬프트에 키 붙여넣기

wrangler deploy            # → https://prepaid-relay.<계정>.workers.dev
```
배포 후 `wrangler.toml`의 `ALLOW_ORIGIN`을 실제 PWA/담당자 웹 도메인으로 좁힐 것(보안).

---

## C. data.go.kr 인증키 검증 (가장 먼저 확인)

승인된 서비스: **행정안전부_식품_일반음식점 조회서비스** (REST, JSON+XML)
End Point: `https://apis.data.go.kr/1741000/general_restaurants`

**남은 확인 1가지** — data.go.kr 서비스 상세의 **"상세기능정보/요청변수"**에서:
- 지역(자치단체코드) **파라미터명** (기본값 `localCode`로 설정됨 — 다르면 `wrangler.toml`의 `PUBLIC_API_REGION_PARAM` 교정)
- 상호 검색 파라미터 존재 여부 (있으면 `PUBLIC_API_NAME_PARAM` 지정, 없으면 서버가 이름 필터)
- 페이징 파라미터가 `pageNo/numOfRows`가 맞는지 (data.go.kr 표준)

**로컬 실키 테스트** (Decoding/일반 키 사용):
```bash
PUBLIC_API_KEY=<Decoding키> node server/dev-server.mjs
curl "http://localhost:8788/api/restaurants?region=<자치단체코드>&q=<상호일부>"
```
→ `[{restaurant_id,name,address,status}]` 배열이 나오면 성공.

응답 필드 매핑은 `server/src/worker.js`의 `pick()`/`extractRows()`가 data.go.kr 표준(`response.body.items.item`, `bplcNm`·`rdnWhlAddr`·`trdStateNm`·`mgtNo`)과 다양한 변형을 처리한다. 필드명이 다르면 `pick()` 후보 배열에 추가.

> 참고: 이 서비스는 **상호 직접 검색 파라미터가 없을 가능성이 높아** 지역(자치단체코드)으로 받아와 서버에서 이름 필터링한다(스펙 §10-4 "지역 필수"와 일치). 자치단체코드는 참고문서 `개방자치단체코드_영업상태코드.xlsx` 참조.

---

## D. 보안·법률 게이트 (출시 전 필수)
- 서버는 평문 개인정보를 저장·로깅하지 않는다(불변식). `worker.js`는 평문 ciphertext 제출을 거부한다.
- 담당자 웹 동의문(§5.1)·전화번호 직접수집 고지(§5.2, 음식점 앱)는 **법률 검토 후 문구 확정**(현재 placeholder).
- 기관 이메일 인증은 현재 **도메인 확인 스텁** — 실제 발송 인증(매직링크/OTP)은 메일 서비스 연결 필요.
- 개인키는 음식점 기기에만 존재(서버 미보관). 분실 대비 [개인키 백업](../CHANGELOG.md) 필수.
