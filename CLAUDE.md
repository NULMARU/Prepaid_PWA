# CLAUDE.md — 밥장부(선입금대장) 프로젝트 가이드

> 소규모 음식점의 단체·직원 식대 "선입금"을 종이 장부 없이 관리하는 무료 도구.
> 기관 담당자가 직원 명단을 브라우저에서 암호화해 보내고, 음식점 폰에서만 열린다.
> ⚠️ 이 리포는 public이다. 사업 전략·운영 민감 문서는 리포에 커밋하지 않는다(.gitignore 참조).

## 라이브 서비스 지도 (2026-07 기준)

| 대상 | 주소 | 호스팅 | 배포 방법 |
|---|---|---|---|
| 소개 홈페이지 | https://bapjangbu.com | Cloudflare Pages `bapjangbu-home` | `npx wrangler pages deploy homepage --project-name=bapjangbu-home --branch=main` |
| 음식점 앱(PWA) | https://app.bapjangbu.com | GitHub Pages(커스텀 도메인) | `git push` → Actions 자동 |
| 기관 담당자 웹 | https://agency.bapjangbu.com | Cloudflare Pages `prepaid-agency` | `npx wrangler pages deploy agency-web --project-name=prepaid-agency` |
| 문서(매뉴얼·방침·약관·관리자) | https://app.bapjangbu.com/docs/… | GitHub Pages(리포 docs/) | `git push` |
| 중계 서버 | https://prepaid-relay.sulsul-plus.workers.dev | Cloudflare Workers + D1 | `cd server && npx wrangler deploy` |

옛 주소(`nulmaru.github.io/Prepaid_PWA`, `prepaid-agency.pages.dev`)는 계속 작동(301/병행 서빙).

## 아키텍처 한 장

- `index.html` — 음식점 주인 PWA(단일 파일, 오프라인 우선, IndexedDB). 원장의 진실은 이 기기.
- `agency-web/index.html` — 기관 담당자 웹(단일 파일). 명단을 음식점 RSA 공개키로 브라우저 암호화.
- `server/src/worker.js` — zero-knowledge 중계(암호문·총액·해시만 저장). D1 스키마 `server/schema.sql`.
- 전달 2모드: 「바로 보내기」(서버 경유, 수령 즉시 삭제·미수령 72h 만료) / 「직접 전달」(서버 무보관 — 파일·QR·이메일·카톡 오픈채팅).
- 인증: 기관=이메일 OTP(Resend, `noreply@bapjangbu.com`) + `X-Agency-Token` 필수(`REQUIRE_AGENCY_AUTH=1`). 음식점=RSA 챌린지-응답 소유증명(approve/deregister/재등록/원장백업/연락처).
- 운영자: `docs/admin.html`(ADMIN_TOKEN secret, 비식별 집계+의견 표), `/api/feedback`.

## 절대 불변식 (깨는 PR·기능 금지)

1. 운영자는 자금을 수수·보관·이체·정산하지 않는다(결제 기능 금지).
2. 선금 기록은 해당 음식점 1곳에서만 유효(다점포 통용 잔액 금지 — 규제 지위가 바뀜).
3. 서버는 평문 개인정보를 저장하지 않는다(zero-knowledge). 직원명·개인금액·전화번호·이메일 평문 저장 금지.
4. 전화번호는 어떤 서버 경로에도 실리지 않는다(직원 전화는 기기 로컬 AES 암호화, 클라우드 백업에서도 제외).
5. 원장의 진실은 음식점 기기다(서버는 중계·암호화 백업 보관만).
6. 완전 무료 운영(광고·유료 기능 금지). Cloudflare Workers 무료 플랜 유지(유료 업그레이드 금지 — 이메일은 Resend 무료로 해결).

## 검증·개발 명령

```bash
bash harness/verify-all.sh          # 원터치 전체 검증(로컬 e2e + 목 + 반응형 + 라이브 + 3앱 접속) — 10/10 기대
node harness/prepaid.e2e.js         # 음식점 앱 Playwright e2e
node harness/phase2.e2e.mjs         # 서버 인메모리 목 하니스(200+ 검증)
node harness/responsive.e2e.mjs     # 폰 반응형 기하 검증(360/390/412/768, 가로스크롤·잘림·모달 버튼)
node harness/phase2.live.mjs <URL>  # 배포 서버 스모크(인증 강제 검증 포함)
```

## 운영 함정·주의 (재발 방지 노하우)

- **D1 마이그레이션**: `wrangler d1 execute --remote --file`은 OAuth 토큰과 import API 비호환(오류 2036) → **`--command`로 문 단위 실행**할 것. 마이그레이션 파일은 `server/migrations-2026-07.sql`(append-only).
- **GitHub Pages 배포 실패 시**: 실패한 런을 rerun하면 중복 아티팩트 오류 → **rerun 금지, `gh workflow run pages.yml --ref main`으로 새 런**. 배포 성공 판정은 상태가 아니라 **라이브 콘텐츠 문자열**로 확인(verify-all의 앱 체크는 버전 문자열만 봐서 구버전에서도 통과함).
- **secret 등록**: `npx wrangler secret put <이름>` 실행 후 **프롬프트에** 값 입력(명령줄에 값 쓰면 이름으로 등록+노출됨). 현재 secrets: `PUBLIC_API_KEY`, `RESEND_API_KEY`, `ADMIN_TOKEN`.
- **CORS**: `server/wrangler.toml`의 `ALLOW_ORIGIN` 콤마 목록. 새 프론트 도메인 추가 시 여기 먼저 넣고 deploy.
- **bapjangbu.com은 Cloudflare Email Obfuscation ON** — 라이브 소스에서 이메일이 `data-cfemail`로 난독화됨(정상, grep으로 이메일 검색하면 0건 나옴).
- **이메일**: 발신=Resend(`send.` 서브도메인 DKIM/SPF), 수신=Cloudflare Email Routing(`contact@bapjangbu.com` → 운영자 편지함). apex MX는 라우팅용 — Resend와 별개이니 건드리지 말 것.
- **agency-web와 homepage는 git push로 배포되지 않는다** — wrangler pages deploy를 각각 실행해야 라이브 반영.
- **Pages 배포는 반드시 `--branch=main`을 붙일 것** — 생략하면 wrangler가 **현재 git 브랜치명**을 Pages 브랜치로 써서 프리뷰 배포가 되고 커스텀 도메인(agency./bapjangbu.com)은 그대로 남는다(배포 성공 메시지는 똑같이 나오므로 속기 쉽다). 확인은 프로덕션 도메인의 **콘텐츠 문자열**로. 커스텀 도메인 반영에 수십 초~1분 지연이 있을 수 있다.
- 클라이언트-서버 계약 변경 시(예: 인증 필수화) **마이그레이션→서버 deploy→프론트 배포 순서** 지킬 것. 순서가 어긋나면 라이브 승인/제출이 일시 깨진다.

## 현재 상태 (2026-07-27)

- **필드테스트 직전 단계.** 전 기능 라이브: 이메일 OTP 인증 필수, 2모드 전달, 직원별 문자 동의·sms 자동 오픈, 약관·개인정보 동의 게이트(일회성), 클라우드 원장 백업(암호화·삭제 가능), 운영자 통계·의견, 도메인 통일(bapjangbu.com/app./agency. + noreply@/contact@).
- **개인정보처리방침·이용약관: 확정본 적용 완료**(`docs/privacy.html`·`docs/terms.html`, 시행 2026-07-06). 검토가 끝났으므로 문서·안내서에서 **'초안'·'법률 검토 후 확정' 표현은 쓰지 않는다**. 모든 서피스(음식점 앱·담당자 웹·홈페이지·안내서 3종)가 확정본 HTML을 링크한다 — `docs/PRIVACY_POLICY.md`·`docs/TERMS.md`(같은 내용의 md 미러)는 어디서도 링크하지 않는다.
- 남은 출시 게이트: 없음.
- 알려진 이슈 없음. verify-all 10/10(목 하니스 207 + 반응형 108).

### 완료 (2026-07-30 — 소속 필드·공공기관 용어·폰 반응형·UX 총점검, 검증 완료)

- **소속(org) 필드 신설**: 직원 레코드에 소속(공공기관명·회사명·'개인') 추가 — 자동 등록 승인·직접 전달이 기관명·부서를 분리 저장(합성 중단), 표시는 결합 라벨(`orgDeptLabel`)로 기존과 동일. **매칭 원칙 = "화면에서 같아 보이는 직원 = 같은 직원"(라벨|이름 키)** — 레거시 결합 dept와 신규 분리 데이터가 섞여도 충전이 정확히 붙는다. 수동 등록에 "소속(선택)" 입력(datalist: 개인+기존 소속), CSV `소속|회사` 열 인식(단 `부서` 포함 헤더 제외 — '소속부서' 충돌 방어), 내보내기 잔액표 소속 열. 백업 schemaVersion 3 유지.
- **승인·직접 전달 = 기존 직원 충전**: 같은 소속·부서·이름 활성 직원은 신규 카드 대신 topup(매달 재전송 시 카드 증식 방지, CSV와 동일 원칙). 승인 안내 "신규 N명 · 기존 충전 M명".
- **용어**: 음식점 앱 사용자 노출 '기관' → **'공공기관'** 전수(55회), "공공기관 담당자(서무)"·"공공기관 부서 목록 관리"(공유 목록임을 키커에 명시), DEFAULT_ORG='공공기관'. 워크플로 확정: **공공기관=자동 등록, 회사(사기업)·개인=수동 등록** — 홈페이지 FAQ·안내서·전단에 명시.
- **폰 반응형**: `.stack` minmax(0,1fr)(가로 스크롤·설정 탭·모달 저장 버튼 문제 일괄 해결) + ≤640px 직원 카드 2행(이름·금액 전액 표시). `harness/responsive.e2e.mjs` 신설(기하 단언 108, verify-all 10번째 항목).
- **UX 총점검 반영 16건**: `.btn-primary.small` 흰글씨/흰배경 블로커(온보딩 "이 가게" 버튼 안 보임), 진한 버튼 위 저대비 설명·배지 깨짐, 홈·이력 빈 상태 CTA, 폰 모달 버튼 역순(저장이 맨 위), 취소 버튼 명확화, 해요체 통일, 글자 크기·터치 타겟(고령 가독), 토스트 위치 등. CSV 내보내기 잔액표가 홈 필터를 따라가던 누락 버그 수정. 앱 beta.13.
- **미적용(검토 후 결정 대상)**: 온보딩 1/4·2/4 가게 이름 중복 입력 통합, 0/4 환영 화면, 브랜드명 통일(앱 '선입금대장' vs 홈 '밥장부' — manifest 영향), 사용 모달 빠른 금액 버튼, 서명 캔버스 워터마크, 설정 화면 길이(아코디언), 잔액증표 🧾 아이콘 라벨.

### 완료 (2026-07-27 — 용어 대개편·복수 전송·알림·보안 강화, 로컬 검증 완료)

- **용어 체계 확정**: 상위 개념 **"직원 선금대장 등록"** = **자동 등록(기관에서 보낸 명단 받기)** / **수동 등록(직접 입력: 한 명씩 등록·엑셀 명단(CSV) 불러오기·빠른 등록)**. "구청/기관 선금 받기" 계열 전면 폐기(돈은 계좌 이체 — 오해 차단 문구를 앱·담당자 웹·홈페이지에 배치). 담당자 웹 배지 "✅ 명단 받기 가능", 상태칩 "기관 명단 받는 중".
- **앱(beta.12)**: 설정 최상단 "직원 선금대장 등록" 그룹(자동/수동 카드), 직원 목록 관리 분리. 온보딩 4단계(2/4 **우리 가게 등록** — "나중에 등록할게요" 상시 탈출구+간판≠인허가 상호 팁, 실제 등록은 약관 동의 후, 실패 시 롤백+홈 배너, 기존 사용자 1회성 마이그레이션). 등록 성공 직후 **내 열쇠 백업 강권**(가이드·설정 배지·홈 배너 — 폰 분실=영구 잠금 방지). 루트 manual.html 삭제(sw 캐시 포함).
- **알림**: `GET /api/inbox-count` 신설(개수만·무인증·inbox와 동일 JOIN 필터) → 앱 시작·online·visibilitychange(60s 스로틀) 시 확인, 홈 "📩 새 명단 신청 N건" 칩.
- **담당자 웹 복수 전송**: 목록 전체 선택/선택 전체 해제·선택 카운터, 진행률(음식점 N곳·부서 조합 M건), 429 백오프+요청 예산 페이싱(전역 60/분·공개키 20/분), 가게별 결과표+실패 재시도, **동명 음식점 오배송 3중 차단**, 공백 행 rid=undefined·직접전달 파일명 충돌 버그 수정, CSV 오류 '사유' 열, 토큰 sessionStorage 보존(새로고침마다 OTP 소모 방지 — Resend 절약 1순위 레버), 에러 코드 전면 한글화.
- **서버**: 담당자 이메일 **해시 저장**(방침 문구와 일치화 — 불변식 3; 라이브 구 평문 행은 10분/24h TTL 자연 소멸), OTP 발송 실패 시 스로틀 미소모+형식 검증, **submit 멱등 응답 `{deduped,status}`**(승인/거절 후 재전송 블랙홀 해소 — 담당자 웹이 3분기 표시), feedback 180일 TTL, 크론 IN-배치화.
- **문서**: 안내서 3종을 실제 구현 라벨·흐름과 전수 일치화(제3자 제공 동의 모달, 재전송 규칙, 제외 vs 체크해제 등) + A4 인쇄 CSS → **PDF 3종 `docs/manuals/`**. 홈페이지·전단·덱 용어 정합.
- **남은 권고(미적용)**: ① 약관·방침에 수동 등록(사장님=수집주체)·register-key(가게명·공개키·공개 목록 게시) 항목 반영 검토, ② `/api/inbox` 암호문 반환에 소유증명 인증 추가 검토, ③ 72h 만료 미수령을 담당자가 알 수단(보낸 건 상태 조회) 부재, ④ OTP 화이트리스트가 go.kr/korea.kr뿐(.or.kr 복지관 등 협의 필요), ⑤ staff.bapjangbu.com 전환(수동 작업), ⑥ 레이트리밋이 per-isolate 메모리(베스트 에포트).

### 완료 (2026-07-26 — PR #5 머지 + 랜딩 3주체 재구성, 전부 라이브 배포·검증)

- **PR #5(머지됨)**: 홈페이지 5단계 인포그래픽(시연 애니메이션 JS 제거), 전용 태블릿 비치 권장 문구(홈페이지·음식점 안내서·전단·협회 덱), 전체 흐름 5단계 양쪽 매뉴얼 반영, 직원용(베타) 링크, 전단·덱 주소 app.bapjangbu.com 갱신, ALLOW_ORIGIN에 staff.bapjangbu.com 선등재.
- **랜딩 3주체 재구성**: 이용 주체를 **음식점 사장님(파랑)·기관 담당자(서무)(금색)·직원(초록)** 3색으로 코딩 — 히어로 3버튼(직원용 추가), 역할 섹션 배지, 헤더 **'사용 매뉴얼'** 탭(#manuals 3장 카드)·푸터 링크. '기관 담당자' → **'기관 담당자(서무)'** 문구 통일. 흐름 아래 "실제 앱도 이만큼 쉬워요/지금 시작하기" 블록 삭제(대신 "직원은 어디에 있나요?" 한 줄 안내). 의견 폼 role에 **'직원'** 추가(서버 화이트리스트·PROTOCOL.md 반영).
- **`docs/manual-staff.html` 신설(직원 안내서)**: 직원용 앱(bapjangbu-staff) 실제 기능 기준 — 이용 지역 설정·음식점 등록(LOCALDATA 검색)·충전/사용 기록·말로 입력(자연어)·이력 수정·백업/복원. **"공식 잔액은 음식점 장부가 기준"**(직원용은 개인 기록장, 음식점 앱과 미연동)을 최상단 경고로 명시.
- 기존 매뉴얼 2종에 `charset`·`viewport` 메타 추가(모바일 확대·로컬 열람 깨짐 방지) + 안내서 3종 상호 링크.
- **비용추계 문서**: `docs/COST_MODEL.md`(gitignore, 로컬 보관) — 결론: 전국 10만 음식점에서도 월 ~₩10만. 먼저 막히는 것은 **Resend 무료 "하루 100통"**(OTP), 그다음 data.go.kr 일일 한도, D1 저장 5GB. 무료 연장 레버 1순위 = 담당자 세션 유효기간 연장.
- **OTP 발송 한도 안내(신규)**: Resend가 429(하루/월 한도)를 주면 서버가 `429 {error:'email_quota_exceeded'}`로 구분 응답 → 담당자 웹이 "오늘 인증번호 발송 한도 도달 · 잠시 후/다음 날 재시도" 안내를 띄운다(1단계 화면에 상시 고지문도 표시). 기관 안내서 1단계에도 같은 안내 + "마감 직전보다 여유 있게" 권고. 목 하니스 14c-2b로 회귀 검증.
- **기관 안내서 정리**: 9번 '문의' 섹션(담당 부서 연락처 자리표시자) 삭제, 인증번호 관련 stale 문구("파일럿 기간에는 자동 입력") → 실제 동작(기관 이메일로 발송·유효시간 10분·스팸함 확인)으로 교체.
- **담당자 웹 전송 동의 모달 문구 정리**: 파일럿 배지("⚠ 파일럿 테스트 모드 — 동의 문구는 법률 검토 후 확정됩니다")와 "※ 문구는 법률 검토(출시 게이트) 후 확정됩니다" 삭제 → 확정본 링크(개인정보처리방침·이용약관, 시행 2026-07-06) + "대상 직원 본인의 사전 동의 확보는 제공 기관의 책임" 고지로 교체. 미사용 `.pilot-badge` CSS 제거. 형식확인 fallback 문구도 "(파일럿 — 정식 이메일 인증은 준비 중)" → "이 서버에서는 인증번호 확인이 진행되지 않았습니다"로 수정(정직성 원칙 유지, PROTOCOL.md 반영).
- **직원용 앱(별도 리포 NULMARU/bapjangbu-staff, PoC)**: 현 라이브 https://nulmaru.github.io/bapjangbu-staff/. staff.bapjangbu.com 전환 검토 완료 — 코드는 상대경로라 무수정 동작. 남은 수동 작업: Cloudflare DNS에 CNAME staff→nulmaru.github.io 추가, staff 리포 Settings→Pages→Custom domain 설정(+HTTPS 강제), 서버 deploy(CORS), 홈페이지 링크 2곳 교체. ⚠️ localStorage는 오리진 단위라 도메인 전환은 **시범 사용자 생기기 전에** 완료할 것(전환 시 기존 데이터는 백업 JSON으로만 이전 가능).

## 기관·부서 데이터 (전국)

- `agency-index.json`(시도→기관 2단, schemaVersion 2, 17개 시도·246 기관) + `agency-depts/{region}.json`(시도별 과 목록, lazy 로드). 서울은 큐레이션, 나머지는 행정표준코드 기관코드에서 자동 추출(빈 기관은 앱이 공통 템플릿 폴백).
- 재생성: `node harness/build-agencies.mjs <기관코드 전체자료.txt>` — 원자료는 code.go.kr 기관코드 조회자료 다운로드. 연 1회(조직개편 후 2~3월) 갱신. 상세: `docs/agency-data-pipeline.md`.
- 주소→기관 자동 매칭은 시도 우선 2단계 — 동명 구(중구 등)는 시도 없이 매칭하지 않는다(오매칭 방지). 수정 시 6개 광역시 "중구" 케이스 필수 테스트.

## 문서 위치

- 사용법: `docs/manual-restaurant.html`(음식점), `docs/manual-agency.html`(기관)
- 홍보물: `docs/marketing/`(전단·기관 안내문·협회 덱, 인쇄용)
- 프로토콜·API 계약: `server/PROTOCOL.md`
- 사업·운영 민감 문서: 리포 미포함(로컬 보관, .gitignore 등재) — 커밋 금지 유지
