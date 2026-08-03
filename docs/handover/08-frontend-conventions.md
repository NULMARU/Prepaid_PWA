# 08 — 음식점 앱 프런트엔드 규약

대상: `index.html`(약 2,600줄·370KB 단일 파일, 인라인 `<style>` + 단일 `<script>`).
**이 문서의 규칙은 취향이 아니라 전부 실사용 사고에서 나온 것이다.** 어기면 돈이 어긋나거나 손님이 입력을 못 한다.

---

## 0. 파일 구조 읽는 법

- 섹션 배너: JS는 `// ── 제목 ──`, CSS는 `/* ─── 제목 ─── */`. **배너로 grep해서 이동하는 것이 유일하게 실용적인 탐색법**이다(한 함수 = 한 줄인 경우가 많아 줄 번호는 금방 낡는다).
- 순서(대략): 상수·타이머 → 안드로이드 뒤로가기 → 유틸 → 그룹핑/정렬 → IndexedDB·잔액·해시체인 → 암호 모듈 → 중계 서버 연동 → 직접 전달 수신 → UI → PIN/손님 화면 → 부분 갱신 3종 → 초기 설정 → 렌더 → 화면 HTML → 모달 → 유휴 타이머 → 이벤트(액션 맵) → CRUD → 백업/복원 → CSV → 서명 패드 → 설정 화면 → SW 등록 → `init()`.
- 상태는 **`state` 리터럴 하나**(약 60개 최상위 키). `state.data`(= `{employees, transactions, meta}`)만 영속이고 나머지는 전부 휘발성이다. 특히 `lockView` 이하 손님 화면 상태는 코드 주석이 못을 박아 둔다:
  > `// 손님 화면 상태(lockView 이하)는 전부 휘발성이다 — IndexedDB·백업 JSON에 절대 기록하지 않는다.`
  > `//   "손님은 요청을 만들고, 사장님은 기록을 만든다" — 이 4개는 요청이지 기록이 아니다.`
- **라우터가 없다.** 화면 전환은 순수 상태: `state.screen`(`home|history|settings`), `state.pinLocked`+`state.lockView`, `state.custStage`(`search|confirm|compose|self`), `state.modal.type`, `state.setupStep`. History API는 **안드로이드 뒤로가기 트랩** 용도로만 쓴다(`__retrap`).

---

## 1. 전면 재렌더 구조 — 이 앱의 근본 제약

`render()` → `custComposeGuard()` 통과 시 `renderCore()` → **`#app`의 `innerHTML`을 통째로 교체**한다(5개 상호배타 분기: 로딩 / 초기설정 / 잠금 / 가이드 / 본 화면). 교체 후 포커스·캐럿(`fid`/`ss`/`se`)과 그룹 헤더 포커스(`fgKey`)를 수동 복구한다.

즉 **재렌더가 도는 순간, DOM에만 있던 모든 것은 사라진다** — 입력 중인 값, 그린 서명, 소프트키보드 연결, IME 조합 상태.

### 렌더 규칙 2대 원칙

> **원칙 1 — 입력이 있는 화면은 부분 갱신한다.**
> 실시간 필터·실시간 표시가 붙은 화면에서는 절대 전체 `render()`를 부르지 말고, **표시 조각만** 갈아끼운다.
>
> **원칙 2 — 사용자 입력값은 반드시 `state`에 흡수한다.**
> DOM에만 있는 값은 재렌더에서 살아남지 못한다. 프리필이 있는 화면에서는 되돌림이 **빈 칸이 아니라 '그럴듯한 오답'** 이라 실패가 눈에 보이지 않는다.

#### 원칙 1의 근거 — beta.20 모바일 IME 사고

손님 이름 검색이 글자마다 전체 재렌더를 돌렸다. 데스크톱은 무증상이었지만 폰에서는 치명적이었다(`custSearchPatch` 주석):

> `// (a) 포커스된 입력 노드가 DOM에서 제거되는 순간 소프트키보드의 입력 연결이 끊긴다 → 키보드가 닫힌다.`
> `// (b) 한글 IME는 음절이 확정될 때 compositionend → compositionstart → input 이 **한 키에서** 흐른다. … → 화면의 입력창에는 그 글자가 영영 안 찍힌다("스마트폰에서 입력이 안 된다"의 정체).`
> `//   ⚠️ 조합 중(composing)에는 절대 전체 render로 넘기지 않는다 — 조합 중 노드 교체가 곧 입력 유실이다.`

#### 원칙 2의 근거 — beta.21 금액 되돌림 사고

사장님이 손님 요청 9,000원을 25,000원으로 고쳐도, 그 사이 render가 한 번 돌면 조용히 9,000원으로 되돌아갔다(`captureUsageInputs` 주석):

> `// 화면은 멀쩡해 보이고 사장님은 그대로 저장한다.`

트리거는 사소한 것들이었다 — [서명 다시 받기], 토스트 표시, **`online`/`offline` 이벤트**(지하 식당의 와이파이 경계). 그래서 `render`를 부르기 전에 반드시 `captureUsageInputs()`를 지나도록 못을 박아 두었다.

### 현재 부분 갱신 함수 목록 (여기에 없는 화면에 입력을 붙이면 사고다)

| 함수 | 갱신 범위 |
|---|---|
| `custSearchPatch()` | `#custResults`만 + `syncCustClear()` |
| `syncCustClear(q)` | `.cust-clear` ✕ 버튼만 |
| `custAmountPatch()` | `#custAmtBig`·`#custAmtBal`·`#custAmtAfter`·`#custAmtErr`의 `textContent`만 |
| `custComposeGuard()` | 최후의 방벽 — `custAmountPatch()`+`paintToast()` 후 `renderCore()` 스킵 |
| `paintToast()` | `.toast` 노드 한 개 |
| `schedulePinDelayTick()` | `#pinDelayLeft`만 |
| `setup-terms-toggle` / `terms-toggle` 액션 | 버튼 `disabled`만 |
| `onInput`의 setup-manual draft 분기 | `state.setupManualDraft`에 쓰고 렌더 없이 return |

게이트 헬퍼: `signInProgress()`, `renderIsDisruptive()`, `custComposeActive()`, `custDraftDirty()`, `captureUsageInputs()`.

### `change` 이벤트를 받지 않는 이유 (규약)

`onInput`은 `input`만 받고 `change`는 **의도적으로 무시**한다:

> `// 화면이 바뀌며 입력창이 제거될 때 blur와 함께 늦은 change가 날아와 innerHTML 교체 도중 render를 재진입시킨다 → "The node to be removed is no longer a child of this node"로 그 렌더가 통째로 실패한다.`

새 입력을 추가할 때 `change` 리스너를 붙이지 말 것.

---

## 2. 캔버스 3중 보호 (서명)

금액 입력과 서명 캔버스가 **한 화면에 공존**하는 `custStage==='compose'` 화면 때문에 도입된 계약. 원문 주석이 규범이다:

> `//     방어는 3중이다 — 셋 다 있어야 한다:`
> `//       (1) 금액 입력·빠른 금액은 render를 부르지 않는다 → custAmountPatch가 표시 세 조각만 갈아끼운다.`
> `//       (2) 비동기 render(토스트·online/offline·visibilitychange·refreshInboxCount·QR/WebAuthn 감지)는 renderIsDisruptive() 게이트를 지난다 — 획이 있으면 signInProgress()가 true라 전부 미뤄진다.`
> `//       (3) 최후의 방벽: render() 자체가 custComposeGuard()로 강등된다(획이 있는 통합 화면에서는 전체 재렌더 대신 부분 갱신). 어떤 경로가 실수로 render를 불러도 서명이 살아남는다.`

**(1)** `#custAmtBig`·`#custAmtBal`·`#custAmtAfter`·`#custAmtErr` **네 id는 계약이다.** 하나라도 바꾸면 `custAmountPatch()`가 `false`를 돌려주고 전체 render로 빠져 서명이 사라진다.

**(2)** `signInProgress()`는 `document.activeElement`가 아니라 **캔버스에 직접 획 유무를 묻는다** — 캔버스는 `preventDefault` 때문에 절대 포커스를 받지 못하므로 activeElement 기반 판정은 죽은 조건이었다. 동시에 **빈 캔버스는 막지 않는다**(막으면 화면이 영구히 굳는다).

**(3)** `function render(){ if(!custComposeGuard()) renderCore(); armIdle() }` — 게이트를 빼먹은 새 경로가 생겨도 살아남게 하는 구조적 방어.

### 부속 규칙

- **획 좌표 기억(사실상 4번째 보호)** — `initSignPad()`가 `strokes`를 보관하고 리사이즈/회전 시 재렌더한다. 예전에는 backing store가 한 번만 잡혀 **오른쪽 약 12%가 아예 기록되지 않고**, 이미 그린 획은 눌려 보였다(`손님은 아무 경고 없이 "찌그러진 서명"을 남긴다`). 재렌더 배율은 반드시 **작은 쪽 하나**(`Math.min(d.w/w, d.h/h)`) — 가로·세로를 따로 쓰면 서명이 찌그러진다.
- **리스너는 앱 전역에 딱 하나** — `resize`/`orientationchange` → `onSignViewportChange()`(100ms 디바운스) → `signPad.resize()`.
  > `// 캔버스마다 달면 렌더 교체 때마다 떨어져 나간 캔버스를 붙든 리스너가 쌓인다.`
- **`signPad`는 먼저 끊고 다시 잡는다** — 죽은 캔버스를 가리키는 `signPad`는 ① 빈 서명이 저장을 통과하고 ② `signInProgress()`가 영원히 true가 되어 화면이 굳는, 두 가지 사고를 동시에 만든다.
- **캔버스 위 움직임만으로 유휴 시계를 연장하지 않는다**(`armIfDrawing`이 `drawing===true`일 때만 `markInput()`). 태블릿에 손바닥만 얹혀 있어도 자동 잠금이 무한히 미뤄진다.
- 서명 저장 형식은 JPEG q=0.5 data URL.

---

## 3. 액션 맵 (`data-a`) 패턴

- 레지스트리: `const clickActions = { 'action-id': (el)=>{…} }` — 약 112개.
- 위임: `document.addEventListener('click', onClick)` 하나. `onClick`은
  ```js
  const el = e.target.closest('[data-a]'); if(!el) return;
  if (lockScreenActive() && !LOCK_ALLOWED.has(el.dataset.a)) return;
  const fn = clickActions[el.dataset.a]; if (fn) await fn(el);
  ```
- 페이로드는 형제 `data-*` 속성으로 전달: `data-id`, `data-screen`, `data-dept`, `data-g`, `data-amount`, `data-idx`, `data-ctx`, `data-sid`, `data-name`, `data-addr`, `data-tel`.
- 네이밍: 소문자 케밥, 도메인 접두어로 묶는다 — `cust-*`(손님/잠금 화면), `pin-*`, `setup-*`, `relay-*`, `agency-*`, `guide-*`, `emp-phone-*`, `save-*`, `fill-*`, `toggle-*`, `quick-*`, `terms-*`, `cloud-*`.
- **키보드 등가성**: `[role="button"][tabindex="0"]`(홈 그룹 헤더 등)은 브라우저가 Enter/Space를 눌러주지 않으므로 전역 `keydown` 위임이 `.click()`을 합성한다. `role="button"` 요소를 새로 만들면 이 규칙에 얹혀 있는지 확인할 것.
- 테스트 훅: `window.__prepaidTestHooks.clickActionKeys()`.

### 잠금(손님) 화면 allowlist — `LOCK_ALLOWED`

```js
const LOCK_ALLOWED = new Set(['pin-key','pin-reset','pin-forgot','pin-forgot-cancel','pin-forgot-restore',
 'lock-to-pin','pin-to-cust','cust-pick','cust-confirm','cust-cancel','cust-clear','cust-back',
 'cust-call-owner','cust-request','cust-history','cust-amt-quick','cust-sign-clear','cust-sign-submit']);
```

> `//   ⚠️ 이 목록에 원장을 쓰는 액션을 추가하지 말 것. 손님은 '요청'만 만들 수 있고 '기록'은 만들 수 없다.`

4중 강제:
1. `onClick` 진입부 화이트리스트.
2. `onInput` — 잠금 중에는 `#custSearchInput`·`#custAmountInput` 두 개만, 그리고 `change`는 거부.
3. 파일 input 3종(`onRestoreFile`·`onCsvFile`·`onDirectTransferFile`)이 각자 재차 방어(`// 잠금 중 파일 경로 차단(2중 안전장치)`). 유일한 예외는 1회성 `allowLockedRestore`(PIN 분실 복구).
4. 안드로이드 뒤로가기: `if(state.pinLocked){__retrap();return}`.

추가로 `toast()`는 잠금 중 억제된다. 유일한 파괴 경로인 PIN 분실 복구 화면은 **진입 후 60초 카운트다운**(`recoveryReady()`)으로 이중 방어된다.

자세한 계약 성격은 [04-contracts.md](04-contracts.md) 참조.

---

## 4. 접힘(fits) 계약

⚠️ **`fits`는 `index.html`의 식별자가 아니다.** 하니스 `harness/responsive.e2e.mjs`의 `fitsInFirstViewport(page, tag)`가 검증하는 **레이아웃 계약**의 이름이다.

무엇을 단언하나:
- **초기 뷰포트(`scrollY === 0`)에서 잰다** — `scrollIntoView` 후에 재지 않는다(관대함 봉인).
- 대상: `#custAmountInput`, `.cust-sig #signCanvas`의 **윗변·아랫변 모두**, `.cust-actions` 버튼 3개 **전부**, `.cust-links` 버튼 2개.
- 조건: `top >= -1 && bottom <= innerHeight + 1`. 버튼 높이 ≥ 48px, 온보딩 터치 타깃 ≥ 44px.
- 적용 폭: `width <= 767`.
- 실측 근거: beta.22 iPhone 13에서 서명판은 180px 중 107px만 보였고 [사장님 확인 받기]는 **화면 밖 174px 아래**였다.

CSS 쪽 대응 규칙: 폰 세로 여유는 CSS로만 되돌려 받는다.
> `⚠️ 여기는 전부 CSS다 — 캔버스 노드를 만들거나 갈아치우지 않는다(3중 보호 계약 불변).`

**새 화면을 만들면 fits 계약도 함께 확장할 것**(CLAUDE.md 2026-08-03 항목의 교훈: 한 화면에만 걸면 나머지는 구조적으로 검증되지 않는다). 서명판 높이는 `clamp(120px, 20svh, 170px)` — **`dvh`가 아니라 `svh`** 다(주소창이 접힐 때마다 캔버스가 출렁여 채택).

---

## 5. 그 밖의 못 박힌 규칙 (짧게, 근거와 함께)

| 규칙 | 근거 |
|---|---|
| `empMatchKey`는 표시 라벨 기준(`orgDeptLabel|name`)을 **좁히지 말 것** | `⚠️ 이 키를 org\|dept\|name 같은 "저장 형태" 기준으로 되돌리면 돈이 두 장부로 갈라진다` |
| 금액 파싱은 `parseWon`만, 10진 정수만 허용 | `Number()`는 `0x2710`·`1e4`·`0b11`·전각을 조용히 받는다 — `돈에서는 그 관용이 곧 사고다` |
| 새 거래의 `createdAt`은 반드시 `nextTxTime()` | `Math.random()`·`Date.now()` 직접 사용 금지 — 비결정적 버그로 체인 오판이 났다 |
| 유휴 만료는 `lastInputAt` 기준 절대시각, `markInput()`만 연장 | 예전엔 `armIdle`이 리셋이라 `반복 호출되는 렌더 하나가 유휴 복귀를 영원히 밀어냈다`(손님 이름·잔액 무기한 노출) |
| `clearBusy`는 반드시 렌더한다 | 안 하면 "저장 중" 오버레이가 남고 자동 잠금이 안 걸린다 |
| 소속 `datalist`는 문서에 **하나만** 렌더 | 중복 id 때문에 모달 입력이 빈 목록을 읽었다 |
| 화면 전환은 지역 변수 `stage`가 아니라 `state.custStage`를 함께 고쳐야 한다 | beta.25 — 강등을 지역 변수로만 하면 세 곳의 리더가 어긋난다 |
| 사장님 홈 검색은 **부분 일치**, 손님 검색은 **접두 일치**(`nameStartsWith`) | 용도가 다르다(주석 명시). 통일하지 말 것 |
| 손님 화면 왕복 시 **금액은 보존, 서명은 재작성** | 서명 dataURL 사본을 만들면 "요청은 휘발성" 불변식이 깨진다 |

---

## 6. Service Worker / 버전 문자열 (⚠️ 수동 동기화)

- `index.html`: `const APP_VERSION='1.0.0-beta.NN'` — 백업 JSON의 `appVersion`과 설정 화면 표시용. **캐시 버스팅에 쓰이지 않는다.**
- `sw.js`: `const CACHE_NAME='prepaid-ledger-v1.0.0-beta.NN'` — **실제 캐시 키.**
- **두 문자열을 코드가 대조하지 않는다.** 릴리스마다 사람이 둘 다 올려야 한다.
- SW 등록은 `navigator.serviceWorker.register('./sw.js').catch(()=>{})`뿐 — `updatefound`/`waiting`/`controllerchange` 처리도, 새로고침 프롬프트도 없다.
- fetch 전략: **HTML은 네트워크 우선**(오프라인일 때만 캐시 폴백 — 구버전에 갇히는 문제 방지), 그 외 자산은 stale-while-revalidate. 그래서 온라인이면 `CACHE_NAME`을 안 올려도 대체로 자가 치유된다.
- `ASSETS` 프리캐시는 `agency-depts/` 중 `seoul.json` 하나뿐. 나머지 시도는 lazy fetch 후 SWR로 캐시에 들어간다.
- 전면 초기화 경로 `clearAppCachesAndWorker()`가 모든 캐시 삭제 + SW 등록 해제를 수행한다.

---

## 7. 새 화면·새 기능을 추가할 때 체크리스트

1. 입력이 있는 화면인가 → **부분 갱신 함수를 만든다**(전체 render 금지). 조합 중(`composing`)에는 절대 render로 넘기지 않는다.
2. 프리필이 있는가 → **입력값을 `state`에 흡수**하는 capture 함수를 만들고, 모든 render 호출 앞에 둔다.
3. 캔버스가 있는가 → 3중 보호 전부에 등록(부분 갱신 대상 id, `renderIsDisruptive` 게이트, `custComposeGuard` 강등 분기).
4. 잠금 화면에서 도달 가능한가 → `LOCK_ALLOWED`에 넣되 **원장 쓰기 경로가 아닌지** 확인. `onInput` 화이트리스트도 함께.
5. 폰에서 한 화면에 들어오는가 → `harness/responsive.e2e.mjs`의 `fits` 계약을 그 화면으로 **확장**([06-testing.md](06-testing.md)).
6. `role="button"`을 썼는가 → 키보드 등가성(Enter/Space) 위임에 걸리는 마크업인지 확인.
7. 거래를 쓰는가 → `nextTxTime()`·`makeTx(…, chainTip())` 경유, `parseWon`으로 금액 파싱.
8. 릴리스 → `APP_VERSION`과 `sw.js`의 `CACHE_NAME`을 **함께** 올린다.
