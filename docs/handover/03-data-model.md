# 03 — 데이터 모델

**진실의 원본은 코드다.** 이 문서는 "어느 함수를 열어야 하는가"를 알려주는 지도이며, 필드 목록은 인수인계 시점(IndexedDB `VER=3`, 백업 `schemaVersion:3`) 기준이다. 앱 버전 문자열은 자주 올라가므로 `index.html`의 `APP_VERSION`을 직접 볼 것.

- 서버 D1 스키마 원본 → `server/schema.sql` (컬럼별 주석 포함, 여기서 복제하지 않는다)
- 마이그레이션 이력 → `server/migrations-2026-07.sql` · `server/migrations-2026-08.sql` · `server/migrations-2026-09.sql` (**월별로 파일이 나뉘고 각 파일은 append-only**. 과거 문장을 고치지 말고 새 달 파일을 추가한다)
- 암호 blob·`batch_hash` 규격 → `server/PROTOCOL.md` §2·§3

---

## 1. 음식점 앱 — IndexedDB

`index.html` 상단 상수:

```js
const APP='선입금대장', APP_VERSION='1.0.0-beta.NN', DB='prepaid-ledger-db', VER=3, LOCAL='prepaid-ledger-local'
```

| 스토어 | keyPath | 인덱스 | 내용 |
|---|---|---|---|
| `employees` | `id` | **없음** | 직원 레코드 |
| `transactions` | `id` | **없음** | 거래 레코드 |
| `meta` | `key` | **없음** | `{key, value}` 설정·키·상태 |

- 여는 함수: `openDb()`. 래퍼 `makeRepo()` → 실패 시 `makeLocalRepo()`(localStorage 호환 모드)로 폴백.
- **인덱스가 하나도 없다**(`createIndex` 미사용). 모든 조회는 `getAll()` 후 메모리 필터. 수천 명 규모까지는 문제없지만 설계 사실로 인지할 것.
- ⚠️ `onupgradeneeded`는 **없는 스토어를 만들기만** 한다. 필드 마이그레이션 로직이 없으므로 `VER`을 4로 올려도 기존 설치본에서는 아무 일도 일어나지 않는다. 스키마 변경이 필요하면 마이그레이션 코드를 먼저 넣어야 한다.
- Repo API: `loadAll()`, `apply(patch)`(upsert), `replaceAll(data)`(clear+put, 복원 경로).

### 1.1 직원(`employees`) 레코드

정규화 기준 함수: **`norm()`**. 생성 경로는 모두 이 형태를 따른다.

| 필드 | 타입 | 의미 | 누가 채우는가 |
|---|---|---|---|
| `id` | `'id-…'` (`uid()`) | PK | 전 경로 자동 |
| `org` | string | **소속** — 공공기관명·회사명·`개인`. 레거시 데이터는 `''`(옛날엔 `dept`에 합성돼 있었다) | 자동 등록(`summary.institution` 또는 `items[].org`), CSV `소속`/`회사` 열, 수동 등록 `#empOrg` |
| `orgKind` | `'public'` \| `''` | 표시·분류용 꼬리표 | 자동 등록 경로는 `'public'` 고정, 수동·CSV는 `orgKindFor(org)`(= `org === meta.orgName`일 때만 `'public'`) |
| `dept` | string | 부서 | 위와 동일 3경로 |
| `name` | string | 이름 | 위와 동일 |
| `note` | string | 메모 | 수동 등록만 |
| `isDeleted` | boolean | **소프트 삭제(숨김)** — 물리 삭제는 없다 | `hide`/`restore-emp` 액션 |
| `phone` | string | **AES-GCM 암호문 번들 JSON** 또는 `''` | 수동 입력만, `setPhone()` 경유 |
| `phoneConsent` | boolean | 문자 안내 동의 | `setPhone()`/`setPhoneConsent()` |
| `yearMonth` | `'YYYY-MM'` | 배치 귀속 연월 | 자동 등록(`summary.year_month`), CSV(현재 월). 수동은 `''` |
| `createdAt` / `updatedAt` | number(ms) | | 자동 |

- **`balance` 필드는 저장하지 않는다**(§3 참조).
- 동일인 판정: `empMatchKey(e)` = `orgDeptLabel(e) + '|' + name` — **"화면에서 같아 보이는 직원 = 같은 직원"** 원칙. 레거시 결합 `dept`와 신규 분리 `org`/`dept`가 섞여도 충전이 정확히 붙는다. 인덱스 빌더는 `activeEmployeeIndex()`.
- 매칭되면 새 카드를 만들지 않고 `topup` 거래를 추가한다(매달 재전송 시 카드 증식 방지).
- 동명이인: `assignDuplicateSuffix()`가 `·2`, `·3` 마커를 부여(라틴 이름 오병합을 피하려 라틴 접미사 `a/b`에서 바꾼 것).

### 1.2 거래(`transactions`) 레코드

생성 함수: **`makeTx(fields, prevTip)`**.

| 필드 | 타입 | 비고 |
|---|---|---|
| `id` | string | PK |
| `employeeId` | string | FK |
| `type` | `'open'` \| `'topup'` \| `'use'` \| `'void'` \| `'adjust'` | 허용 집합은 `validateRestoreData()`가 강제 |
| `amount` | 정수(원) | `adjust`는 **증감분**(음수 가능), 나머지는 `>0` |
| `beforeBalance` / `afterBalance` | number | 스냅샷. `afterBalance`만 해시에 들어간다 |
| `reason` | string | `'공공기관 신청 승인'`, `'CSV 임포트'`, `'서명 확인'` 등 |
| `note` | string | 비고. 자동 등록은 `기관명 부서명` 라벨, 손님 요청 거래는 `손님 요청 금액 N원` |
| `targetTransactionId` | string\|null | `void`에서만 — 취소 대상 `use` |
| `signatureData` | string | **data URL**(`sigD()`가 `^data:image/` 강제). `use`에만 존재 |
| `signatureHash` | string | `SHA-256(signatureData)`. **txHash에는 포함되지 않는다** |
| `txHash` / `prevHash` | hex | 해시 체인(§2) |
| `createdAt` | number(ms) | 항상 `nextTxTime()` — **엄격 단조 증가(+1ms)** 로 배치 순서 = 체인 순서 |

잔액 반영: `applyTx()` — **`use`만 차감, 나머지(`open`·`topup`·`void`·`adjust`)는 가산.**

주요 작성자: `saveEmployee` / `saveTopup` / `saveAdjust` / `saveUse` / `voidUsage` / `executeCsvImport` / `relayApprove` / 직접 전달 수신부.

---

## 2. 해시 체인

계산 함수 **`txHashOf()`** — canonical 문자열이 계약이다:

```
employeeId | amount | afterBalance | prevHash | createdAt
```

`type`·`reason`·`note`·`beforeBalance`·`signatureData`는 **해시에 들어가지 않는다**(사양 사실이지 버그 아님 — 다만 "사유만 조작한 변조"는 체인으로 탐지되지 않는다는 뜻이므로 인지할 것).

- 꼬리 판정: **`chainTip()`** — "다른 어떤 거래의 `prevHash`로도 참조되지 않은 `txHash`". `createdAt` 최대값이 아니다(레거시 소수 타임스탬프·동률 백업 호환).
- 검증: **`verifyChain()`** — ① 각 거래의 자기 해시 재계산(불일치 = `해시 변조`) ② 건전한 거래의 `prevHash`가 실재하는지(부재 = `체인 단절`). `txHash`가 빈 레거시 거래는 `legacy[]`로 분리해 제외. **시각 정렬이 아니라 링크 추적**으로 구현돼 있다(2026-08-01에 오판 근본 수정).
- **깨졌을 때**: 자동 복구도, 쓰기 차단도 없다. 대신
  - `runIntegrityCheck()`가 경고 토스트 + 설정 화면 결과 표시,
  - `verifyBalanceFor(id)`가 잔액증표에서 잔액 대신 "장부에 이상이 있어 잔액을 표시할 수 없습니다",
  - 손님 화면에서 해당 직원의 **사용 요청(compose) 진입 차단**.
- 해시 구현: `hash()` = `crypto.subtle.digest('SHA-256')` → hex. ⚠️ **`crypto.subtle`이 없으면 djb2 32비트 정수 문자열로 조용히 강등**된다(비보안 오리진). 체인·checksum·`pinHash`가 동시에 무력화되므로 반드시 HTTPS/localhost에서만 운영할 것.

---

## 3. 잔액 계산 규칙

**잔액은 저장 필드가 아니라 파생값이다.**

- `balanceOf(id)` — 해당 직원 거래를 `applyTx`로 reduce(정렬하지 않음. 가감산 교환법칙이라 성립).
- `derive()` — 오름차순 1패스로 `balances` Map을 만들고, 직원 **뷰 객체**에 `balance`·`deptKey`를 붙인다. `voided` Set·그룹·합계도 여기서 나온다. **화면이 쓰는 잔액은 전부 `derive()` 산출물이다.**
- 교차 검증 3종:
  - `runIntegrityCheck()` — `(open+topup) + adjust + void == use + Σbalance` 대조(숨김 직원 포함).
  - `verifyBalanceFor(id)` — `derive()` 값 vs 시간 정렬 독립 reduce 값(`crossOk`).
  - `validateRestoreData()` — 복원 시 저장된 `before/afterBalance`와 재계산값 불일치를 **경고**(차단 아님).

---

## 4. 백업 JSON 포맷

생성: **`backupCore()`** → `buildBackupPayload()`. 파일명 `backupFileName()`(`밥장부백업_YYYY-MM.json`, 최종본은 `밥장부백업_최종_YYYY-MM-DD.json`).

```jsonc
{
  "schemaVersion": 3,
  "appName": "선입금대장",
  "appVersion": "1.0.0-beta.NN",
  "exportedAt": 0,
  "payload": { "employees": [], "transactions": [], "meta": {} },
  "summary": { "employeeCount": 0, "totalEmployeeCount": 0, "transactionCount": 0 },
  "checksum": "<SHA-256 of core>"
}
```

`checksum`은 `core`(= `schemaVersion`~`payload`)만 대상으로 하고 `summary`·`checksum` 자신은 제외한다.

**포함**: 숨김 직원 포함 전 직원, 전 거래(**`signatureData` data URL 그대로** — 백업 용량의 지배적 요인), `meta.pubKey`, **암호화된 `phone`·`phoneConsent`**, 그리고 **"이미 받았다/이미 반영했다" 기록 4종**(`receivedBatchLog`·`receivedBatchHashes`·`receivedTransferLog`·`approvedSummaryLog`)과 미통보 대기열 `pendingNotify`.
→ 이 기록들이 백업에서 빠지면 **복원한 기기가 같은 명단을 중복 경고 없이 다시 받아들인다**(선금 이중 반영). 기기 전용이라 일부러 빼는 값(`inboxCountCache`)과 혼동하지 말 것 — 판단 기준은 "다른 기기에서 되살아나야 하는 사실인가"다.
**제외**(`backupCore()`가 구조분해로 제거): `deviceSecret`, `privKeyWrapped`, `pinHash`, `pinFails`, `pinDelayUntil`, `inboxCountCache`.
→ `deviceSecret`이 빠지므로 **다른 기기에서 복원하면 `phone` 암호문은 복호화 불가**(설계상 안전 동작).

### schemaVersion 정책 (`parseBackupPayload()`)

| 입력 | 처리 |
|---|---|
| `schemaVersion` 2 또는 3 + `payload.{employees,transactions}` 배열 | 수용 |
| 최상위 평면 `{employees, transactions}` | `version:1` 레거시로 수용 |
| 그 외 | `throw '지원하지 않는 백업 형식'` |

- **v2와 v3는 읽기 동작이 동일**하다. 필드 마이그레이션 코드가 없고, v2에 없는 `org`는 `norm()`이 `''`로 채운다.
- checksum 불일치는 **경고**(사용자가 진행 가능). `validateRestoreData().errors`(id/이름 누락, 중복 id, 미지 type, 고아 `employeeId`, 비정수 금액, 대상 없는 `void`)는 **복원 중단**.
- 복원은 `safety` 스냅샷을 떠 두고 실패 시 `repo.replaceAll(safety)`로 롤백. 데이터가 있으면 `setupComplete`를 강제 true(복원 후 마법사로 되돌아가 데이터에 못 들어가던 사고의 방어).
- **새 필드를 추가할 때**: v3를 읽는 코드가 미지 필드를 무시하고 `norm()`이 기본값을 채우는 구조이므로, **필드 추가만이라면 `schemaVersion`을 올리지 않는다**(실제로 `org` 추가 때 3을 유지했다). 기존 필드의 **의미가 바뀌거나 제거될 때만** 올리고, 그때는 `parseBackupPayload()`에 변환 분기를 반드시 함께 넣을 것.

### 잠긴 백업 파일 `prepaid-locked-backup` (beta.48)

**평문 백업이 나가면 안 되는 유일한 경로**를 위한 별도 파일 형식이다. 생성 함수 `exportLockedBackup()`, 파일명 `선입금대장_잠긴백업_YYYYMMDD.json`.

```jsonc
{
  "type": "prepaid-locked-backup",
  "v": 1,
  "appName": "선입금대장",
  "appVersion": "1.0.0-beta.NN",
  "exportedAt": 0,
  "pubKeyFp": "ABCD-EF12",          // 이 파일을 열 수 있는 열쇠의 지문(keyFingerprint)
  "restaurantId": "…",              // 등록돼 있으면
  "blob": { "encKey": "", "iv": "", "ct": "" }   // buildCloudBackupBlob() 산출물 그대로
}
```

- 본문은 **클라우드 원장 백업과 같은 하이브리드 암호**다(`buildCloudBackupBlob()` 재사용) — 따라서 **전화번호 제외**(`stripPhonesForCloud`)도 그대로 따라온다. 여는 열쇠는 이 기기의 개인키와 「내 열쇠 백업」 파일에만 있다.
- **쓰는 곳은 PIN 분실 복구 화면의 초기화(`pinReset`) 하나뿐**: `confirmWipeWithBackup(introMsg, {locked:true})`. 이 화면은 비밀번호를 모르는 사람도 누를 수 있어야 하는데(잠긴 기기를 되살리는 유일한 길), 그동안 그 경로가 **직원 이름·금액이 평문으로 든 백업**을 다운로드 폴더에 떨궜다. 설정의 **인증된 전체 초기화는 지금도 평문 백업**이다(PIN을 통과한 사장님 본인이므로).
- 이 경로는 **`markBackupSaved()`를 부르지 않는다** — 사장님이 스스로 한 백업이 아니므로 `meta.lastBackupAt`을 옮기면 백업 리마인더가 거짓으로 꺼진다.
- `pubKey`가 없는 기기면 파일을 만들지 않고 2차 확인창에 `⚠️ 이 기기에는 열쇠가 없어 백업 없이 지웁니다.`를 붙인다.
- 복원: 복원 파일 선택기가 `type==='prepaid-locked-backup'`을 보면 `restoreLockedBackup()`으로 보내 개인키로 `decryptBlob` → 나온 core를 **기존 `restoreFromParsed()`** 에 그대로 태운다. 개인키가 없거나 `pubKeyFp`가 다르면 복호화를 시도하기 전에 `LOCKED_BACKUP_HELP` 안내를 띄운다("…'내 열쇠 백업'을 먼저 가져온 뒤(설정 > 자동 등록 카드) 다시 선택해 주세요").

### 관련 파일 산출물

- `exportSafeLedger()` — 「장부 안전 저장」: 복원용 JSON + 사람이 읽는 CSV 쌍.
- `exportCsvLedger()` — 엑셀용 CSV(소속/부서/직원명/잔액/메모 + 거래내역). **복원 불가**.
- `exportKeyBackup()` / `importKeyBackup()` — 「내 열쇠 백업」 `{type:'prepaid-key-backup', v:1, pubKey, pkBackup}`. `pkBackup`은 **사용자 암호(8자 이상)** 로 래핑되며 그 암호는 어디에도 저장되지 않는다. 이 파일을 잃으면 폰 분실 시 클라우드 백업도 영구 복호화 불가 → 앱이 배너·배지로 백업을 강권한다.

---

## 5. 키·암호화 자산 (모두 기기 로컬)

| meta 키 | 내용 |
|---|---|
| `deviceSecret` | 32바이트 랜덤 base64. **평문으로 IndexedDB `meta`에 저장**(같은 기기 안이므로). 전화번호·개인키 래핑의 마스터. 백업 제외 |
| `pubKey` | RSA-OAEP 2048 공개키 SPKI base64. 서버 등록·클라우드 백업 암호화에 사용 |
| `privKeyWrapped` | 개인키 PKCS8을 `aesEncryptStr(…, deviceSecret)`로 래핑 |
| `pinHash` / `pinFails` / `pinDelayUntil` | 4자리 PIN. 5회 실패 60초 지연은 **meta 영속**(새로고침 우회 차단) |

- 전화번호 암호화: `setPhone()`/`getPhone()` → `aesEncryptStr`/`aesDecryptStr` = **PBKDF2-SHA256 120,000회 + 16바이트 salt → AES-GCM-256 + 12바이트 IV**, 저장 형태 `{v:1, salt, iv, ct}` JSON.
- 생성기: `ensureKeyPair()` (`deviceSecret`·`pubKey`·`privKeyWrapped`·`keyCreatedAt`).

**`meta` 키의 진실의 원본은 `index.html`의 `META_KEYS` 배열**이다(그 옆의 `META_DEVICE_KEYS`가 "이 기기에만 속하는 값" — 복원 시 백업이 아니라 현재 기기 값으로 되돌아간다).
🔴 **새 meta 키를 만들면 `META_KEYS`에 반드시 등재할 것** — 등재하지 않으면 `normMeta()`가 걸러 내므로 저장은 되어도 재시작·복원 후 사라진다. 화이트리스트 방식인 이유는 조작된 백업으로 `pinHash`·열쇠·가게 id를 치환하던 경로를 막기 위해서다(2026-08 보안 점검).

주요 키의 의미(전체 목록은 코드를 볼 것):

| 키 | 의미 |
|---|---|
| `storeAddr` | LOCALDATA 검색으로 고른 가게의 **공식 주소**. `relayDistrict(addrHint)`의 1순위 입력이며, 이게 비어 있어서 라이브 D1의 `district`가 전국 0건이던 장애가 있었다([04](04-contracts.md) C2) |
| `districtSyncedAt` | 부팅 시 1회 자동 치유(district 재전송) 완료 표시 |
| `receivedBatchHashes` | 이미 받은 배치 `batch_hash` 목록(구 키 — 다운그레이드 호환용으로 계속 채운다) |
| `receivedBatchLog` | 위의 후속 형태 `[{h, at}]` 최근 300 — "**언제** 이미 올렸는지"를 중복 경고에 실어 준다 |
| `receivedTransferLog` | **beta.48** `[{id, at}]` 최근 300. 직접 전달 파일·QR의 `transfer_id` 처리 기록 |
| `approvedSummaryLog` | **beta.48** `[{sid, h, at}]` 최근 300. 서버 승인으로 **장부에 반영한** `summary_id` |
| `pendingNotify` | **beta.48** `[{sid, at}]`. 장부에는 반영했으나 서버에 `APPROVED` 통보가 아직 성공하지 못한 건(상한 없음 — 통보가 성공하면 즉시 빠진다) |
| `inboxCountCache` | 마지막으로 확인한 📩 배지 개수. **기기 전용**(backupCore 제외) |
| `chainTip` / `txCount` | 해시 체인 꼬리 앵커(§2) |

**beta.48의 세 키는 전부 "돈이 두 번 들어가는 것"을 막는 장치**다. `receivedTransferLog`는 같은 파일 재열기를 아예 차단하고, `approvedSummaryLog`는 이미 반영한 신청을 다시 열지 못하게 하며, `pendingNotify`는 "장부에는 넣었는데 서버에 못 알린" 상태를 기억해 두었다가 인터넷이 되면 통보만 재시도한다([04](04-contracts.md) C11). 셋 다 `backupCore()`에 **포함**된다 — 복원한 기기에서도 같은 중복 방어가 살아 있어야 하기 때문이다.

- `receivedBatchLog`·`receivedTransferLog`·`approvedSummaryLog`는 **장부(직원·거래)와 같은 `repo.apply()` 한 번**으로 커밋한다. 나눠 쓰면 그 사이의 중단이 곧 이중 반영 경로가 된다(`nextReceivedBatchMeta()`가 "무엇을 저장할지"만 계산하고 저장은 호출부가 하는 이유).

---

## 6. 클라우드 원장 백업 blob

- 생성: **`buildCloudBackupBlob()`**
  1. `stripPhonesForCloud(backupCore())` — 모든 직원에서 **`phone`·`phoneConsent` 제거**(불변식 4의 마지막 방어선).
  2. 랜덤 AES-GCM-256 키 + 12바이트 IV로 본문 암호화.
  3. 그 AES 키를 **자기 자신의 `meta.pubKey`(RSA-OAEP)** 로 봉인.
  4. `{encKey, iv, ct}` base64 반환 → base64 문자열로 감싸 업로드.
- 업로드: `relayBackupNow()`(수동) / `relayBackupSilent()` / `maybeMonthlyAutoBackup()`(월 1회, `autoCloudBackup !== false` + 그 달 활동 있음). **blob base64 100만 자 상한**, 초과 시 중단.
- 복원: `relayRestoreFromCloud()` — `blob_hash` 재검증 → `decryptBlob()`(로컬 개인키) → `restoreFromParsed()`.
- 서버 측 상한: `MAX_LEDGER_BLOB = 1MB` (`server/src/worker.js`).

---

## 7. 요청(pending) — 손님 사용 요청

**메모리 전용.** IndexedDB·localStorage·서버 어디에도 쓰지 않는다.

`state.pendingCustomerId`, `state.pendingCustomerAt`, `state.pendingAmount`, `state.pendingSign`, `state.pendingExpired`.

- TTL **120초** — `TIMERS.pendingTtl`. 타이머 상수 전체:
  ```js
  const TIMERS={custIdle:30000,custComposeIdle:60000,autoLock:90000,pendingTtl:120000,
                pinDelay:60000,recoveryGate:60000,modalIdleCap:600000,ownerPinIdle:120000};
  ```
- 생성 `handToOwner(id, amount, sign)` → 만료 판정 `handoffEmp()`(렌더 시점)·`takePendingCustomer()`(PIN 해제 시 1회성 회수) → 폐기 단일 지점 `clearPendingRequest()`.
- 사장님이 `saveUse()`로 확인·저장해야만 원장 레코드가 생긴다. 자동 저장 없음.
- 관측 훅은 `pendingAmount`·`pendingSignLen`만 노출한다(서명 이미지는 절대 내보내지 않음).

---

## 8. 서버 D1 요약

원본은 `server/schema.sql`(컬럼 주석 포함). 여기서는 **역할과 수명**만.

| 테이블 | 역할 | 수명 |
|---|---|---|
| `public_key_registry` | 음식점 공개키·이름·`district`·업무용 연락처 · **`deregistered_at`**(NULL=활성) | 해제 시 삭제가 아니라 **30일 휴지통** → 그 뒤 cron이 삭제 |
| `deposit_summary` | 기관·부서·총액·인원수·`batch_hash`·**`dedupe_key`**·상태 (**개인별 금액·이름 없음**) | 처리 후 30일 |
| `encrypted_blob` | 암호문 | **수령 즉시 파기**, 미수령 72시간 |
| `consent_log` | 기관·부서·연월 + 담당자 이메일 **SHA-256 해시** | 180일 |
| `auth_challenge` | 소유증명 챌린지 토큰 **해시** | 5분, 1회용 |
| `ledger_backup` | 음식점당 암호화 원장 1행 | 사용자 삭제 시까지 · **등록 해제 후에는 30일**(그 안에 같은 열쇠로 재등록하면 되찾는다) |
| `agency_otp` / `agency_token` | OTP 해시 / 세션 토큰 해시 (**이메일도 해시**, 도메인부만 `email_domain`에 평문) | 10분 / 24시간 |
| `agency_keycheck` | 열쇠 지문 확인 이력(기관·부서·가게 id·지문·**`agency_domain`**) | **TTL 정리 대상 아님**(장기 보관 — 개인정보 없음) |
| `seen_institution` / `seen_department` / `seen_restaurant` / `stats_counter` | 비식별 집계 | 무기한(비개인) |
| `feedback` | 의견 자유 입력 | 180일 |

TTL 상수는 `server/src/worker.js` 상단(`PENDING_TTL_MS`, `RETENTION_TTL_MS`, `CONSENT_RETENTION_TTL_MS`, `FEEDBACK_RETENTION_TTL_MS`, **`DEREGISTER_GRACE_MS`**), 정리는 cron(`wrangler.toml` `crons = ["17 18 * * *"]`, KST 03:17). cron이 id를 묶어 지울 때의 청크 크기는 **`CLEANUP_CHUNK = 99`** — D1의 문장당 바인딩 100개 상한에서 `processed_at` 1개를 뺀 값이다(100으로 올리면 만료 처리가 통째로 실패한다).

### 2026-09(beta.48)에 들어온 세 컬럼

| 컬럼 | 왜 생겼나 |
|---|---|
| `deposit_summary.dedupe_key` | 중복 판정 키. 접수번호가 있으면 `sid:<submission_id>`, 없으면(구버전 담당자 웹) `bh:<batch_hash>\|<year_month>`. **`UNIQUE(restaurant_id, dedupe_key)`** 가 옛 `UNIQUE(restaurant_id, batch_hash)`를 대신한다 — 옛 규칙은 "같은 명단을 별도로 결제해 다시 보내는" 정상 업무를 영구히 삼켰다. `batch_hash`에는 조회용 **비유니크** 인덱스(`idx_summary_batch_lookup`)만 남는다 |
| `public_key_registry.deregistered_at` | 등록 해제 = 30일 휴지통(PROTOCOL §4.12). 담당자에게는 즉시 '없는 가게'지만 소유 증명과 백업 되찾기는 30일간 그대로 된다 |
| `agency_keycheck.agency_domain` | 확인 이력을 남긴 담당자의 **인증된 이메일 도메인**. 기관·부서명은 담당자 자칭이라, 이 결속이 없으면 남의 기관명을 적어 그 부서의 거래처·지문을 읽어갈 수 있었다. 조회는 토큰 도메인이 같은 행만 반환하고 **NULL인 레거시 행은 반환하지 않는다**(재확인 1회로 채워진다) |

마이그레이션 7문은 `server/migrations-2026-09.sql`에 있다 — **문 2(백필)가 문 4(UNIQUE 인덱스)보다 먼저** 실행되어야 한다([07](07-deploy-runbook.md) §4).

---

## 9. ⚠️ localStorage / 저장소 오리진 종속성

**IndexedDB·localStorage·sessionStorage는 모두 오리진(scheme+host+port) 단위다.** 도메인을 바꾸면 데이터는 이전되지 않는다.

| 서피스 | 저장소 | 오리진 이동 시 |
|---|---|---|
| 음식점 앱 | IndexedDB `prepaid-ledger-db` (+ 폴백 `localStorage['prepaid-ledger-local']`) | **원장 전체 소실.** 백업 JSON + 열쇠 백업으로만 이전 가능 |
| 담당자 웹 | `localStorage`(`relay-server`, `bapjangbu_terms_agreed`), `sessionStorage`(`agency-token`) | 재인증·재동의만 하면 됨(피해 작음) |
| 직원용 앱(별도 리포) | `localStorage` | 개인 기록 소실. 백업 JSON으로만 이전 |

- 옛 주소 `nulmaru.github.io/Prepaid_PWA` → `app.bapjangbu.com` 은 **다른 오리진**이다. 옛 주소로 설치한 사용자가 남아 있다면 자동 이전은 없다.
- `staff.bapjangbu.com` 전환은 시범 사용자 0명일 때 끝냈기 때문에 이전 비용이 0이었다. **앞으로 어떤 서피스든 도메인을 바꾸려면 "사용자가 생기기 전"이 유일한 무비용 시점**이다.
- Chrome "사이트 데이터 삭제"도 동일하게 전멸시킨다 — 앱이 백업 배너로 상시 경고한다.
