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
bash harness/verify-all.sh          # 원터치 전체 검증(로컬 e2e + 목 하니스 + 라이브 + 3앱 접속) — 9/9 기대
node harness/prepaid.e2e.js         # 음식점 앱 Playwright e2e
node harness/phase2.e2e.mjs         # 서버 인메모리 목 하니스(144+ 검증)
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
- 클라이언트-서버 계약 변경 시(예: 인증 필수화) **마이그레이션→서버 deploy→프론트 배포 순서** 지킬 것. 순서가 어긋나면 라이브 승인/제출이 일시 깨진다.

## 현재 상태 (2026-07-13)

- **필드테스트 직전 단계.** 전 기능 라이브: 이메일 OTP 인증 필수, 2모드 전달, 직원별 문자 동의·sms 자동 오픈, 약관·개인정보 동의 게이트(일회성), 클라우드 원장 백업(암호화·삭제 가능), 운영자 통계·의견, 도메인 통일(bapjangbu.com/app./agency. + noreply@/contact@).
- 개인정보처리방침·이용약관 확정본: `docs/privacy.html`·`docs/terms.html`(시행 2026-07-06).
- 남은 출시 게이트: 기관 웹 **전송 동의 모달 문구의 법률 검토**(파일럿 배지로 표시 중).
- 알려진 이슈 없음. verify-all 9/9.

## 문서 위치

- 사용법: `docs/manual-restaurant.html`(음식점), `docs/manual-agency.html`(기관)
- 홍보물: `docs/marketing/`(전단·기관 안내문·협회 덱, 인쇄용)
- 프로토콜·API 계약: `server/PROTOCOL.md`
- 사업·운영 민감 문서: 리포 미포함(로컬 보관, .gitignore 등재) — 커밋 금지 유지
