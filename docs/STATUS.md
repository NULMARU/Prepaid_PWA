# 선입금대장 — 개발 현황 & 재점검 가이드

> 최종 갱신: 2026-07-01 · 이 문서 하나로 전체를 재점검할 수 있도록 구성했습니다.
> **먼저 [§4 원터치 검증](#4-원터치-자동-검증)을 실행하고, [§5 수동 체크리스트](#5-수동-검증-체크리스트-브라우저)로 눈으로 확인하세요.**

---

## 1. 한눈에 보기

**무엇을 만들었나:** 소규모 음식점의 단체·직원 식대 **선입금 관리 PWA**(오프라인) + **기관–음식점–직원 3자 연동**(암호화 중계).

**라이브 주소 (고정 — 이걸 공유):**
| 대상 | 주소 |
|---|---|
| 📱 음식점 주인 앱 | https://nulmaru.github.io/Prepaid_PWA/ |
| 💻 기관 담당자 웹 | https://prepaid-agency.pages.dev |
| 🖥 중계 서버 | https://prepaid-relay.sulsul-plus.workers.dev |

**현재 상태:** phase 1(오프라인 원장) + phase 2(3자 연동) **구현·배포·검증 완료**. 자동검증 9/9 통과.

---

## 2. 개발 현황

### Phase 1 — 음식점 앱(오프라인 원장) · `index.html` 단일 파일 PWA
- 부서별 직원 선입금 등록/충전/조정, **서명 기반 차감**, 거래·취소 이력
- **정수(원) 금액 검증**(`parseWon`), **원자적 차감**(IndexedDB 트랜잭션), 잔액부족 거부
- **거래 무결성 해시 체인**(`tx_hash`/`prev_hash`) + 설정 「무결성 검증」(체인 재계산 + 입금·사용·잔액 대조)
- **RSA-OAEP 2048 키페어** 자동 생성, 개인키 AES-GCM 래핑 저장, **개인키 암호화 백업**
- CSV 임포트(**동명이인 a/b/c 자동 보완**), 장부 백업/복원(체크섬), 4자리 PIN, 서울시 25개 구청 부서 picker
- (선택) 잔액 문자 안내(기기 문자앱, 직원명 제외), 전화번호 동의·암호화·일괄 파기

### Phase 2 — 3자 연동
- **중계 서버**(`server/`, Cloudflare Worker + D1): 공개키 등록/해제, 공공API 음식점 검색 프록시, 암호문 중계, 부서별 총액·해시 저장. **개인정보 평문 미저장·미로깅, 평문 제출 거부.**
- **담당자 웹**(`agency-web/`): 기관 이메일 확인(도메인), 음식점 검색(등록 배지·기관별 로컬 제외), CSV 검증, 제3자 제공 동의, **RSA+AES 하이브리드 암호화** 후 전송.
- **음식점 앱 연동**: 「기관 단체 선금 받기」— 우리 가게 이름검색→자동등록, 「기관에서 온 신청 확인」(승인 시에만 복호화 + `batch_hash` 대조 + 동명이인 보완 → 원장 등록), 「선금 받기 중단」(등록 해제).
- 공공 데이터: **행정안전부_식품_일반음식점 조회서비스**(`apis.data.go.kr/1741000/general_restaurants/info`) — 지역(`cond[OPN_ATMY_GRP_CD::EQ]`)·이름(`cond[BPLC_NM::LIKE]`) 검색, 폐업 제외.

---

## 3. 아키텍처 & 데이터 흐름

```
음식점 주인 앱(PWA)              담당자 웹                    중계 서버(Worker+D1)
  RSA 키페어 생성                                             
  ── 공개키 등록 ─────────────────────────────────────────▶  public_key_registry
                          이메일확인·음식점검색 ◀──프록시──   공공API(data.go.kr)
                          CSV검증·동의                        
                          직원명·선금만 공개키로 암호화        
                          ── 암호문 blob + 총액·해시 ──────▶  deposit_summary + encrypted_blob
  ── 수신함 폴링 ◀───────────────────────────────────────  (이름 미노출: 총액·인원만)
  통장대조 → 승인 → 개인키로 복호화 → batch_hash 대조 → 원장 등록
```
**핵심 불변식:** 서버는 암호문만 중계(복호화 키 없음), 전화번호는 담당자 경로에 부재, 원장의 진실은 음식점 기기.

---

## 4. 원터치 자동 검증

프로젝트 폴더에서:
```bash
bash harness/verify-all.sh
```
**기대 결과: `결과: 9 통과 / 0 실패` + `🎉 전부 통과`**

검증 항목:
| # | 항목 | 의미 |
|---|---|---|
| 1 | phase1 e2e | 설정·PIN·차감·서명·백업·초기화 (Playwright) |
| 2 | phase2 목 하니스 (18) | 등록→암호화→복호화→batch_hash→변조탐지→해제 |
| 3 | phase2 라이브 (6) | 배포 서버+D1 상대 전 구간 |
| 4 | 공공API 실검색 | 이름으로 실제 음식점 조회 |
| 5 | 폐업 제외 | 영업 중인 곳만 반환 |
| 6 | 평문 제출 거부 | 개인정보 평문 차단(불변식) |
| 7~9 | 3개 앱 접속 | 음식점앱·담당자웹·서버 |

> 개별 실행: `node harness/prepaid.e2e.js` / `node harness/phase2.e2e.mjs` / `node harness/phase2.live.mjs <서버URL>`

---

## 5. 수동 검증 체크리스트 (브라우저)

실제 3자 흐름을 눈으로 확인합니다. 순서대로 진행하세요.

### A. 음식점 주인 — 가게 등록
- [ ] https://nulmaru.github.io/Prepaid_PWA/ 접속(또는 설치 앱 두 번 닫았다 열기), 버전이 **beta.10** 이상
- [ ] (첫 실행 시) 가게 설정 + PIN 설정
- [ ] 설정 → **「기관 단체 선금 받기」** 카드 확인 (서버주소 입력칸 없음)
- [ ] **「우리 가게 등록하기」** → 가게 이름 검색 → 목록에서 **「이 가게」** 선택
- [ ] "우리 가게를 등록했습니다" 토스트 + "등록된 우리 가게: ○○" 표시
- [ ] **「내 열쇠 백업」** 눌러 암호 넣고 키 백업 파일 저장(중요)

### B. 기관 담당자 — 명단 전송
- [ ] https://prepaid-agency.pages.dev 접속 (서버 주소 자동 입력됨)
- [ ] 기관 이메일(`…@…go.kr`) 입력 → 인증(도메인 확인)
- [ ] 음식점 검색: A에서 등록한 가게가 **"✅ 선금 받기 가능"** 으로 표시 → **선택**
- [ ] 미등록 가게는 **"미등록(전송 불가)"**, 각 행에 **「제외」**(기관별 로컬 목록) 동작 확인
- [ ] CSV 업로드(컬럼: 음식점명,기관명,부서명,직원명,선금금액,입금자명,입금예정금액) → 검증 표 확인(오류=빨강)
- [ ] **동의** 체크 → 전송 → 로그에 "✅ … → summary_id" 성공

### C. 음식점 주인 — 신청 승인
- [ ] 설정 → **「기관에서 온 신청 확인」** → 방금 보낸 신청이 **부서·총액·인원만** 표시(이름 안 보임)
- [ ] **「통장 확인 후 승인」** → 직원 명단이 홈 화면 원장에 등록됨(동명이인은 a/b 자동)
- [ ] 홈에서 직원 차감(서명) 정상

### D. 제외(폐업/미운영) 흐름
- [ ] (음식점 앱) 「선금 받기 중단」 → "중단했습니다" → 담당자 웹에서 그 가게가 **"미등록(전송 불가)"** 로 바뀜(전송 차단)

### E. 보안 불변식 눈으로 확인
- [ ] 담당자 전송 후에도 음식점이 **승인하기 전엔 이름이 안 보임**
- [ ] (개발자도구 Network) 서버로 가는 요청 본문의 `ciphertext`가 **암호문**(직원명 평문 없음)

---

## 6. 미결 과제 (실서비스 출시 전)
| 과제 | 상태 | 비고 |
|---|---|---|
| 동의문 법률 검토 | ⏸ 보류(차후) | §5.1 제3자 제공 / §5.2 직접수집 문구 확정 = 출시 게이트 |
| 기관 이메일 실인증 | ⏸ 보류 | 현재 도메인(.go.kr/.korea.kr) 모양만 확인. 실인증은 이메일 발송 서비스(Resend 등) 연결 필요 |
| 폐업 미신고 대비 | 미구현 | 신청 자동 만료·장기 무응답 표시(자가치유) — 필요 시 |
| 운영자 강제 제외 | 의도적 미구현 | 원칙: 운영자는 "결정자"가 아닌 "신호 제공자". 강제 차단 대신 당사자 처리(주인 중단 + 담당자 제외) |

---

## 7. 알려진 한계 / 설계 원칙
- **PWA엔 Android Keystore 없음**: 개인키는 IndexedDB + 기기시크릿 래핑 수준. 강한 보호는 「내 열쇠 백업」(사용자 암호) 파일로 보완.
- **개방자치단체코드**는 참고문서 `개방자치단체코드_영업상태코드.xlsx` 참조(지역 검색 시).
- **numOfRows 최대 100**: 지역+이름으로 좁히면 충분. 매우 흔한 이름은 상위 100건.
- **CORS**: 현재 `ALLOW_ORIGIN=*`. 출시 시 실제 도메인으로 좁히기 권장(`server/wrangler.toml`).
- **원칙**: 서버 zero-knowledge(개인정보 평문 미보유), 원장 진실은 음식점 기기, 운영자 미개입(신호만).

---

## 8. 커밋 이력 (phase 1·2)
```
7fbed9d Bake relay server URL into agency web
380a63f Add restaurant exclusion controls; reorganize settings
d2ff3b8 Simplify server-integration UX for restaurant owners
60bb17a Add live end-to-end demo against deployed server
e2f8182 Set D1 database_id in wrangler.toml
c251056 Add one-line key test helper (server/test-key.mjs)
af2b3b2 Finalize data.go.kr restaurant search (region + name filter)
92eee5c Map real data.go.kr general_restaurants response fields
83b0ce8 Configure public-restaurant proxy for data.go.kr endpoint
2c255f8 Add multi-party extension phase 2 (relay server + agency web)
6797ca2 Add Playwright dev dependency and gitignore for e2e
9a2e450 Add multi-party extension phase 1 (local ledger foundation)
```

## 9. 파일 구성
| 경로 | 내용 |
|---|---|
| `index.html` | 음식점 앱(PWA) 전체 (단일 파일) |
| `sw.js` / `manifest.json` / `icons/` | PWA 오프라인·설치 |
| `agency-departments.json` | 서울 25개 구청 부서 |
| `agency-web/index.html` | 담당자 웹 |
| `server/src/worker.js` | 중계 서버 로직 (D1 + 메모리 store) |
| `server/schema.sql` / `wrangler.toml` | D1 스키마 / 배포 설정 |
| `server/PROTOCOL.md` | 암호 blob·batch_hash·REST 계약 |
| `server/dev-server.mjs` / `test-key.mjs` | 로컬 구동 / 키 테스트 |
| `harness/prepaid.e2e.js` | phase1 e2e (Playwright) |
| `harness/phase2.e2e.mjs` / `phase2.live.mjs` | phase2 목/라이브 |
| `harness/verify-all.sh` | **원터치 전체 검증** |
| `docs/phase2-deploy.md` | 배포·재배포 절차 |
| `docs/STATUS.md` | (이 문서) 현황·재점검 |
