# 01 — 서비스 개요와 용어집

---

## 1. 무슨 문제를 푸는가

소규모 음식점은 단체·직원 식대를 **선입금(선금)** 으로 받는다. 구청·시청 같은 공공기관 부서가 "이번 달 우리 과 12명 90,000원씩"을 결제(카드결제가 다수, 계좌이체도 있음)하고, 직원들이 그 잔액으로 밥을 먹는다. 담당자는 CSV 하나로 여러 음식점 명단을 보내지만 **결제는 음식점별로 각각** 일어난다(10개 가게면 결제 10건). 회사·개인 단골도 같은 방식으로 미리 맡긴다.

지금까지 이 관리는 **종이 장부와 사장님의 기억**으로 이루어졌다. 문제는 세 가지다.

1. **명단 전달이 아프다.** 담당자(서무)가 이름·부서·금액이 든 엑셀을 카톡·문자로 보낸다 — 개인정보가 평문으로 떠다니고, 기관 입장에서 근거가 남지 않는다.
2. **잔액 분쟁이 난다.** "나 아직 3만원 남았는데?" 를 확인할 방법이 종이뿐이다. 서명도 남지 않는다.
3. **기존 상용 도구는 결제 서비스다.** 충전·정산이 들어가는 순간 규제 대상이 되고 수수료가 붙는다. 동네 식당이 쓸 수 있는 가격이 아니다.

**밥장부의 답**: 명단은 담당자 **브라우저에서 암호화**되어 그 음식점 폰에서만 열린다. 잔액은 **음식점 기기 안에만** 있고 서버는 내용을 모른다. 돈은 여전히 **기관 ↔ 음식점 직접 결제**(카드·계좌이체)이며 운영자는 자금에 손대지 않는다 — 카드결제도 음식점 자기 가맹점 계정에서 일어나므로 운영자 자금 무접촉은 그대로다. 그래서 **완전 무료**로 운영할 수 있다.

---

## 2. 이용 주체 3주체

| 주체 | 쓰는 것 | 하는 일 | 안내서 |
|---|---|---|---|
| **음식점 사장님** (파랑) | 음식점 앱 PWA — https://app.bapjangbu.com | 장부의 주인. 명단 승인, 식사 차감, 잔액 관리, 백업 | `docs/manual-restaurant.html` |
| **공공기관 담당자(서무)** (금색) | 담당자 웹 — https://agency.bapjangbu.com | 부서 직원 명단(이름·부서·금액)을 암호화해 음식점에 보낸다 | `docs/manual-agency.html` |
| **직원(손님)** (초록) | ① 음식점 태블릿의 **손님 화면** ② (선택) 직원용 앱 https://staff.bapjangbu.com | 자기 잔액 조회, 사용 요청 작성·서명 | `docs/manual-staff.html` |

**직원의 위치가 헷갈리기 쉽다.**
- 직원이 **음식점에서** 하는 일은 전부 음식점 태블릿의 잠금 화면(=손님 화면)에서 일어난다. 별도 설치가 없다.
- **직원용 앱**은 별도 리포(`NULMARU/bapjangbu-staff`)의 **개인 기록장(PoC)** 이다. 음식점 앱·서버와 **연동되지 않으며 공식 잔액이 아니다.** 안내서 최상단이 이를 경고한다.

### 지배 원칙

> **"손님은 요청을 만들고, 사장님은 기록을 만든다."**

손님은 잠금 화면에서 자기 잔액 조회와 사용 **요청**(금액 입력 + 서명)까지만 할 수 있다. 장부에 실제로 기록되려면 사장님이 PIN으로 열어 금액을 확인·수정하고 저장해야 한다. 요청은 **2분 휘발성**이며 원장·백업·서버 어디에도 흔적을 남기지 않는다.

### 선금이 들어오는 두 경로

| 경로 | 누가 | 어떻게 |
|---|---|---|
| **자동 등록** | 공공기관 | 담당자(서무)가 보낸 암호화 명단을 사장님이 승인 |
| **수동 등록** | 회사(사기업)·개인 | 사장님이 직접 입력 — 한 명씩 등록 / 빠른 등록 / 엑셀 명단(CSV) 불러오기 |

두 경로 모두 **한 장부**에서 함께 관리되고, 직원마다 `소속`(선택)으로 구분한다.

---

## 3. 비즈니스 제약 (기능 요구가 아니라 존립 조건)

- **완전 무료** — 광고·유료 기능 없음. Cloudflare Workers 무료 플랜 유지.
- **운영자 자금 무접촉** — 운영자는 자금을 수수·보관·이체·정산하지 않는다(앱에 결제 기능 없음). 선금 결제는 기관 ↔ 음식점이 앱 밖에서 직접 한다.
- **다점포 통용 잔액 없음** — 선금 기록은 해당 음식점 1곳에서만 유효.
- **서버는 평문 개인정보를 모른다**(zero-knowledge). 전화번호는 어떤 서버 경로에도 실리지 않는다.
- **원장의 진실은 음식점 기기**다.

이유와 코드상 강제 지점은 [05-invariants.md](05-invariants.md).

먼저 막히는 무료 한도: **Resend 하루 100통**(담당자 OTP) → data.go.kr 일일 한도 → D1 5GB.

---

## 4. 용어집 — 한국어 UI 용어 ↔ 코드 식별자

### 4.1 브랜드·서비스

| UI 용어 | 코드 | 비고 |
|---|---|---|
| 밥장부 | (도메인 `bapjangbu.com`, 백업 파일명 `밥장부백업_*.json`) | **대외 브랜드** |
| 선입금대장 | `APP = '선입금대장'`, `manifest.json` `name` | **앱 내부 이름.** 브랜드와 불일치 — 통일은 미결 항목([09](09-open-items.md)) |

### 4.2 등록 경로

| UI 용어 | 코드 | 의미 |
|---|---|---|
| **직원 선금대장 등록** | — | 상위 개념(자동+수동) |
| **자동 등록** (= 기관에서 보낸 명단 받기) | `relayInbox` 계열, `relayApprove(sid)`, `/api/inbox` → `/api/approve` | 공공기관 경로 |
| **직접 전달** (파일·QR) | `onDirectTransferFile()`, 파일 `type:'direct-transfer'` | 서버 무경유 자동 등록 |
| **수동 등록** | `saveEmployee()`, `executeCsvImport()` | 직접 입력 |
| 한 명씩 등록 / 빠른 등록 | `saveEmployee()` / `quick-*` 액션 | |
| 엑셀 명단(CSV) 불러오기 | `onCsvFile()` → `executeCsvImport()` | |
| **우리 가게 등록** | `POST /api/register-key` | 공개키를 서버에 올려 "명단 받기 가능" 상태가 되는 것. **돈과 무관** |
| 명단 받기 가능 (담당자 웹 배지) | `GET /api/registered`, `GET /api/registered-list` | |
| 바로 보내기 / 직접 전달 (담당자 웹) | `POST /api/submit` / 파일·QR 생성 | 전달 2모드 |

### 4.3 직원·조직

| UI 용어 | 코드 | 의미 |
|---|---|---|
| **소속** | `employee.org`, blob `items[].org`, 서버 `summary.institution` | 공공기관명·회사명·`개인`. **선택 입력** |
| **부서** | `employee.dept`, `summary.department` | |
| 공공기관 | `DEFAULT_ORG = '공공기관'`, `meta.orgName`, `orgKind:'public'` | 앱 UI는 '기관'이 아니라 **'공공기관'** 으로 통일돼 있다 |
| 표시 라벨 | `orgDeptLabel(e)` | 화면에 보이는 "기관명 부서명" 결합 문자열 |
| 동일인 판정 키 | `empMatchKey(e)` = `orgDeptLabel(e) + '|' + name` | **"화면에서 같아 보이는 직원 = 같은 직원"** |
| 동명이인 마커 | `assignDuplicateSuffix()` → `·2`, `·3` | |
| 그룹 정렬 | `groupSortTuple()` | 공공기관 → 회사 → 개인 → 무소속 |
| 숨김 | `employee.isDeleted` | 소프트 삭제(물리 삭제 없음) |

### 4.4 거래·잔액

| UI 용어 | 코드 `type` | 잔액 영향 |
|---|---|---|
| 최초 선입금 등록 | `open` | + |
| 추가 충전 | `topup` | + |
| **사용**(식사 차감) | `use` | − |
| 취소 | `void` (+ `targetTransactionId`) | + |
| 조정 | `adjust` | ± (`amount`가 증감분) |
| 잔액 | **저장 안 함** — `derive()` / `balanceOf()` 파생값 | |
| 잔액증표 | `receiptCardHtml()` | |
| 무결성 검증 | `verifyChain()`, `runIntegrityCheck()` | 해시 체인 |

### 4.5 요청 vs 기록 (⚠️ 가장 중요한 구분)

| UI 용어 | 코드 | 저장되나 |
|---|---|---|
| **요청** (손님이 만든 것) | `state.pendingCustomerId / pendingCustomerAt / pendingAmount / pendingSign` | ❌ 메모리만, **2분 TTL**(`TIMERS.pendingTtl`) |
| **기록** (사장님이 만든 것) | `transactions` 스토어 레코드 | ✅ IndexedDB |
| 사장님 확인 받기 | `handToOwner(id, amount, sign)` → `cust-sign-submit` | 요청 인계 |
| 사장님 부르기 | `cust-call-owner` | 대상만 인계(금액은 사장님이 정함) |
| 요청 회수 | `takePendingCustomer()` | PIN 해제 시 1회성 |
| 요청 폐기 | `clearPendingRequest()` | 단일 폐기 지점 |

### 4.6 손님 셀프 조회 / 잠금

| UI 용어 | 코드 |
|---|---|
| **손님 셀프 조회** (버튼) / 손님 화면 | `state.pinLocked` + `state.lockView === 'customer'` |
| 손님 화면 단계 | `state.custStage` ∈ `search` \| `confirm` \| `compose` \| `self` |
| 잠금 중 허용 액션 | `LOCK_ALLOWED` (Set, 18개) |
| 자동 잠금 90초 / 손님 유휴 30초 / 사장님 PIN 화면 120초 | `TIMERS.autoLock` / `custIdle` / `ownerPinIdle` |
| 손님 검색(접두 일치) | `nameStartsWith()` — 사장님 홈 검색은 **부분 일치**로 다르다 |

### 4.7 암호·서버

| UI 용어 | 코드 |
|---|---|
| **명단 확인값** (불일치 시 수신 차단) | `batch_hash` — `batchHashOf()`(앱) / `canonOf()`+`batchHash()`(담당자 웹) |
| **관할 지역** | `district` — `relayDistrict()`(앱) / `jurisQuery()`(담당자 웹) / `normalizeDistrict()`(서버) |
| **내 열쇠 백업** | `exportKeyBackup()` / `importKeyBackup()` — RSA 개인키를 사용자 암호로 봉인 |
| **장부 안전 저장** | `exportSafeLedger()` — 복원용 JSON + 엑셀용 CSV 쌍 |
| 클라우드 원장 백업 | `buildCloudBackupBlob()` → `/api/ledger-backup` |
| 소유 증명 | `/api/challenge` → `auth_token` (RSA 챌린지-응답, 1회용) |
| 기관 인증 | 이메일 OTP → `X-Agency-Token`(24시간) |
| 수신함 | `/api/inbox`, 배지는 `/api/inbox-count` |

### 4.8 상태값

| 값 | 위치 | 의미 |
|---|---|---|
| `PENDING` | `deposit_summary.status` | 음식점이 아직 안 받음 |
| `APPROVED` / `REJECTED` | | 수령 처리됨(암호문 즉시 파기) |
| `EXPIRED` | | 미수령 72시간 경과(암호문 파기) |
| `deduped: true` | `/api/submit` 응답 | 같은 명단 재제출 — 새 건이 생기지 않았음 |

---

## 5. 서비스 지도 한 장

| 대상 | 주소 | 호스팅 |
|---|---|---|
| 소개 홈페이지 | https://bapjangbu.com | Cloudflare Pages `bapjangbu-home` |
| 음식점 앱(PWA) | https://app.bapjangbu.com | GitHub Pages |
| 담당자 웹 | https://agency.bapjangbu.com | Cloudflare Pages `prepaid-agency` |
| 문서(매뉴얼·방침·약관·관리자) | https://app.bapjangbu.com/docs/… | GitHub Pages |
| 중계 서버 | https://prepaid-relay.sulsul-plus.workers.dev | Cloudflare Workers + D1 |
| 직원용 앱(별도 리포) | https://staff.bapjangbu.com | GitHub Pages |

문의: contact@bapjangbu.com · 발신: noreply@bapjangbu.com
