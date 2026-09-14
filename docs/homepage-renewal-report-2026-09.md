# 밥장부 홈페이지 리뉴얼 결과 — 2026-09-14

## 1. 작업 범위와 바꾼 파일

- 기준: `docs/homepage-renewal-brief-2026-09.md`, 시작 HEAD `5357829`, 시작 작업트리 clean.
- 사용자에게 영상 요약을 먼저 확인받고, 디자인 방향·팔레트·타이포를 제안한 뒤 구현했어요.
- `homepage/index.html`: 레이아웃·타이포·접근성·설명 문구 정리. 정적 단일 HTML과 인라인 CSS/JS를 유지했어요.
- `homepage/img/restaurant-ledger.webp`: 새 히어로 사진, 1200×800, 75,726 bytes.
- `homepage/img/restaurant-meal.webp`: 새 사장님 섹션 사진, 1100×733, 55,502 bytes.
- `homepage/og-image.png`: 새 공유 이미지, 1200×630, 221,350 bytes.
- `docs/homepage-renewal-report-2026-09.md`: 이 검토 인계용 결과 보고서. 서비스 실행에 필요한 파일이 아니라 `homepage/` 배포 묶음 밖에 둡니다.
- `homepage/_headers` 변경 없음. 루트 앱·기관 웹·서버·docs 변경 없음. 커밋·푸시·배포·운영 데이터 변경 없음.

## 2. 영상 핵심 요약과 적용한 한 줄

출처: [투더제이 TTJ 영상](https://www.youtube.com/watch?v=pYK2inPc4E4)의 전체 자막과 제작자 설명을 직접 확인했어요.

1. 텍스트 위주로 반복되는 전형적인 AI 디자인은 서비스의 첫인상과 신뢰를 떨어뜨릴 수 있다는 이야기예요.
2. 핵심 요청은 “사이트에 필요한 이미지를 GPT Image로 생성해서 넣고, 이미지와 어울리도록 웹페이지를 디자인해줘.”예요.
3. 이미지를 나중에 끼워 넣기보다 서비스 맥락에 맞는 이미지와 레이아웃을 함께 설계하는 방식이에요.
4. 페이지·섹션별로 나눠 다듬고, 필요한 효과를 구체적으로 요청하라고 설명해요.

적용한 한 줄: **동네 밥집의 따뜻한 종이 장부를, 크고 또렷한 디지털 안내판으로.**

영상의 슬라이드·스크롤 애니메이션 제안은 이번 브리프의 50대 이상 접근성·정적 페이지 제약에 따라 적용하지 않았어요.

## 3. 팔레트·타이포·화면 구성

| 역할 | 값 |
|---|---|
| 종이빛 기본 배경 | `#F7F3EA` |
| 먹색 본문 | `#252B28` |
| 주 버튼·링크 | 기존 파랑 `#1E4E86` |
| 갈색 강조 | `#8A5A38` |
| 보조 본문 | `#5A605B` |
| 흰 종이 섹션 | `#FFFDF8` |
| 안전 안내 배경 | `#233B36` |

- 기기 기본 한글 고딕체: `-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`. 폰트 파일·외부 CDN·새 라이선스 의존성을 추가하지 않았어요.
- 본문 18px, 보조문 16px 이상, 버튼 18px(버튼 내부 보조 글자 최소 17px), 모바일 제목 36–39px, 데스크톱 제목 54px.
- 히어로: “정성은 밥상에. 장부는 폰 안에.” + 식대 장부 설명 + 무료/가입 없음/비결제 안내.
- 세 주체 진입은 첫 화면에 유지하고 사장님 버튼 하나를 가장 강조했어요. 모바일 사진은 버튼 아래에 배치했어요.
- 반복 카드·그라데이션·장식 이모지를 없애고 번호·구분선·여백으로 안내해요. 첫 사용 흐름은 넓은 화면에서 설명과 순서를 나란히 배치했어요.
- 안내서 3개의 정보·링크를 유지하면서 반복 3열 카드 대신 행 형태로 바꿨어요.
- 중복 모바일 고정 CTA를 제거했어요. 첫 화면과 각 역할 섹션에 진입 버튼은 유지했어요.
- 본문 바로가기, 기본 focus outline, 역할 선택 fieldset/legend, 개인정보를 의견에 적지 말라는 안내를 추가했어요.
- 직원용은 공식 잔액과 자동 동기화되지 않는 개인 기록장임을 더 먼저 알 수 있게 했어요.

## 4. 이미지 출처와 실제 생성 프롬프트

모두 이번 작업에서 내장 GPT Image 도구로 생성한 이미지예요. 실제 음식점·손님·거래 데이터를 촬영한 것이 아니에요. 페이지 사진에는 AI 생성 표시와 alt를 넣었어요. 사진은 cwebp로, OG는 기존 설치된 Sharp로 크기와 PNG 색상 수를 최적화했어요. 생성 외부 API를 사이트 실행 코드에 추가하지 않았어요.

### 4.1 restaurant-ledger.webp

```text
Use case: photorealistic-natural. Asset type: Bapjangbu Korean meal ledger website hero photo, landscape 3:2. Primary request: a warm, authentic small Korean neighborhood restaurant counter just before lunch. Foreground a worn cream paper ledger opened to blank ruled pages, a simple navy pen, and a modest black tablet on a stand seen at a subtle side angle with a plain dim neutral screen without interface or text. Beyond the counter a beautifully simple Korean meal: white rice in a stainless bowl, a small soup bowl and two side dishes on a well-used honey-brown wooden table. Editorial documentary photography, natural soft window light, believable everyday textures, restrained cream #F7F3EA, wood brown and subtle dark navy #1E4E86. Composition: main ledger and tablet centered in the inner 70%, uncluttered, eye-level three-quarter view, fits a 510x500 hero crop and a wider mobile crop. No people, no money, no payment terminal, no QR code, no brand logos, no readable names or numbers, no watermark, no illustration or 3D, no text overlays. Deliver one finished photographic image.
```

### 4.2 restaurant-meal.webp

```text
Use case: photorealistic-natural. Asset type: supporting landscape photo for Bapjangbu, a simple meal ledger for small Korean restaurants. Primary request: intimate candid close-up of the hands and navy apron torso of a Korean restaurant owner in their late 50s setting a modest Korean lunch tray on a worn wooden table. Show rice in stainless bowl, warm soup, kimchi and greens in small ceramic dishes, naturally arranged. No face visible. Warm window daylight, cream wall and blurred neighborhood restaurant counter in background. Authentic natural hands, slightly worn cotton apron, ordinary restaurant rather than luxury, high-end documentary editorial photography, muted warm cream #F7F3EA and brown with a restrained navy accent. Landscape 3:2 image, scene subject within center, suitable for a wide 1100x460 section crop. No money, no payment terminal, no signage, no text, no logos, no watermarks, no collage, no illustration. One finished photograph.
```

### 4.3 og-image.png

```text
Create a single finished 1200 by 630 pixel landscape social sharing card for Korean meal ledger website 밥장부. Design direction: a warm neighborhood restaurant paper ledger reimagined as a crisp large-type digital guide. Editorial restrained layout, solid warm paper cream background #F7F3EA. Left 60%: oversized beautifully typeset bold Korean gothic text in ink #252B28, exact heading '밥장부', below in two lines '단체·직원 식대 장부' and '수첩 대신 폰으로'. Small lower left exact line '완전 무료 · 가입 없음' in deep blue #1E4E86. Right 40%: photorealistic documentary closeup of an open blank ruled ledger and navy pen on a worn wooden Korean restaurant counter, with a stainless rice bowl. Natural warm light, no actual customer data, no tablet UI, no people, no money, no other wording, no icons, no gradients, no watermark. Strong readable Korean text, generous margins, harmonious professional editorial composition. Output precisely wide social card ratio 1200:630.
```

## 5. §6 자체 점검 결과

검증 환경: macOS의 ego-browser/Chromium + `http://127.0.0.1:4399/` 로컬 서버. 로컬 서버에서 기존 `_headers`의 CSP 등 보안 헤더를 적용했어요. 운영 배포 검증·실기기 Safari E2E·실제 이용자 테스트는 아니에요. 요청 관찰은 Playwright 대신 브라우저 CDP와 Performance API를 사용했어요.

| # | 결과 | 확인 내용 |
|---|---|---|
| V1 | 로컬 통과 | 새로고침 후 페이지 HTTP(S) 요청은 로컬 홈페이지 오리진뿐이에요. 외부 폰트·스크립트·이미지·분석 요청 0건. 브라우저 확장 프로그램의 chrome-extension 요청은 사이트 요청과 구분했어요. 운영 도메인 상태는 미배포라 미검증이에요. |
| V2 | 통과 | 기존 a 요소의 href 목적지 누락·변경 0건. 홈페이지·앱3종·안내서3종·방침·약관, HTTPS URL 9개 GET 모두 200. mailto 주소 형식/값 및 내부 앵커 목적지 확인(메일은 HTTP 200 대상이 아니에요). |
| V3 | 통과 | 닫힌 FAQ 내용까지 포함한 전체 본문에서 허용된 두 안내 문맥을 제외하고 금지어 0건. |
| V4 | 통과 | 돈은 앱을 거치지 않아요 / 결제앱이 아닙니다 / 무료 / 가입 없이, 모두 존재해요. 무료·가입 없음 문구도 유지했어요. |
| V5 | 통과 | 히어로 세 주체 버튼, 순서 5단계, FAQ 13문항, 의견 폼, 푸터 존재. 기존 FAQ 질문 13개 모두 유지했어요. |
| V6 | 목 서버 통과 | 테스트 페이지에서 fetch 목적지만 로컬 목 서버로 연결했어요. 원래 릴레이 URL·POST·headers·JSON body를 캡처했고, 목 서버 실제 POST /api/feedback 1회 수신. role=기관, message만 전송. 역할4개 값 음식점/기관/직원/기타 유지. 의견 폼 JS는 원본과 문자 단위 동일. 운영 릴레이에는 의견을 보내지 않았어요. |
| V7 | 표본 통과 | lang=ko, body computed 18px, 본문 16px 미만 0, 버튼·summary·역할 label·헤더 메뉴 44px 미만 0. 대비 표본12개 모두 4.5 이상(최저4.72). 버튼 보조 글자도17px 이상이에요. |
| V8 | 통과 | 아래 4개 정확한 CSS 뷰포트에서 가로 넘침0, 히어로3버튼 전부 첫 화면 안. FAQ 전부 펼친390px에서도 넘침0. |
| V9 | 통과 | title/description/canonical/OG/Twitter 유지. OG 실제파일1200×630 확인. OG 폭·높이·alt 보강했어요. |
| V10 | 통과 | 페이지+사진2개+OG 원본 파일 합계401,132 bytes. 페이지 전체 사진 로드 시 실제 관측 전송량256,708 bytes(테스트 서버 no-store라 favicon으로 재사용한 사진 재요청 포함). 이미지 각300KB 이하. 히어로 eager+fetchpriority high+width/height, 보조사진 lazy. |
| V11 | 통과 | _headers diff 없음. CSP 완화하지 않았어요. |
| V12 | 자체 시각 확인 / 최종 확인 남음 | 390·1280 히어로와 본문·폼을 직접 열어 확인했어요. 사진·타이포·구분선 구성 및 잘림 여부를 점검했어요. 50대 이상 실제 사용자의 이해도와 디자인 선호는 Claude·사용자 최종 확인 대상으로 남겨요. |

### 뷰포트별 측정

| 뷰포트 | 문서 scrollWidth | 마지막 역할 버튼 하단 |
|---|---:|---:|
| 360×800 | 360 | 543.1px |
| 390×844 | 390 | 550.3px |
| 768×1024 | 768 | 656.9px |
| 1280×900 | 1280 | 680.5px |

### 추가 동작 검증

- 빈 의견: 요청0회, 오류 안내와 입력 포커스.
- 목 서버 성공: 요청1회, 성공 안내, 입력 초기화, 글자 수0/500.
- HTTP500 모의 실패: 오류 안내, 입력 내용 유지, 보내기 버튼 재활성화.
- 가게 등록 해제 FAQ 펼치기: 정상 동작, “앱 삭제만으로 서버 등록이 없어지지 않는다”는 핵심 유지.
- reduced-motion 에뮬레이션: matchMedia=true / scroll-behavior=auto / 버튼 transition=0s.
- 최종 새로고침 콘솔 예외·로그 오류0건.
- `git diff --check` 통과.
- 서비스의 거래 처리·인증 기능 자체는 이번 작업에서 수정·재검증하지 않았어요.

### 시각 검토 증거

검토 세션의 임시 산출물이며 배포 자산은 아니에요.

- `/tmp/bapjangbu-final-390.png`
- `/tmp/bapjangbu-final-1280.png`
- `/tmp/bapjangbu-check-try.png`
- `/tmp/bapjangbu-check-owner.png`
- `/tmp/bapjangbu-check-manuals.png`
- `/tmp/bapjangbu-check-feedback.png`
- `/tmp/bapjangbu-check-feedback-390.png`

## 6. 남긴 의문·검토 시 주의점

1. **FAQ 개인정보 표현 정정은 명시적 검토 대상이에요.** 기존 “손님이 다른 사람 잔액을 볼 수 없어요”는 실제 이름 확인 버튼을 비밀번호 인증처럼 오해하게 해요. 현재 루트 앱의 `confirmCard` 및 `cust-confirm`도 읽어, 이름 선택 후 별도 비밀번호 없이 compose/self로 가는 것을 확인했어요(앱 파일 수정 없음). 그래서 질문·PIN 저장 제한 설명은 유지하면서 “이름 확인은 비밀번호 인증이 아니다”로 정정했어요. 이는 단순 디자인 변경보다 의미가 있는 정정이므로, 브리프의 FAQ 의미 보존 조항과 함께 검토해 주세요. 개인정보 보호를 강화하는 코드를 구현했다는 뜻은 아니에요.
2. “이름을 누르면 자동 차감”이라는 축약도 “사용 기록을 저장하면 차감”으로 정확히 썼어요. 손님 입력 후 사장님 비밀번호 확인·저장 흐름을 유지해요.
3. 금지어 제거 때문에 직원 앱 버튼의 실제 라벨을 그대로 인용하지 않고 “선금·사용 내역 기록, 말로 입력”으로 설명했어요. 기능을 삭제한 것이 아니며 연결된 직원 앱·안내서는 수정하지 않았어요.
4. Safari/Android 실기기, 스크린리더, 50대 이상 사장님의 실제 이해도 테스트는 아직 하지 않았어요. OG의 사진은 용량 제한을 맞추기 위해 색상 최적화했으므로 원본보다 세부 색조가 줄었어요.
5. 이 보고서는 검토용 문서예요. 추후 실제 배포 시 이 파일을 공개 배포 자산에 포함할지는 검토자가 별도로 결정해 주세요. 이번 인계는 검토 요청뿐이며 **커밋·배포 승인이 아니에요.**

