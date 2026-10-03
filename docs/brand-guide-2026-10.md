# 밥장부 브랜드 사용 안내

2026-10-03. 음식점 사장님과 손님에게 친근하되, 금전 기록 도구의 진지함을 잃지 않는 작은 밥그릇.

- 캐릭터: 밥그릇에 담긴 밥과 작은 미소. 그릇의 두 줄은 장부의 기록을 뜻합니다.
- 로고: 캐릭터와 읽기 쉬운 ‘밥장부’ 글자 조합. 홈페이지는 이미지에 글자를 구워 넣지 않고 실제 텍스트를 사용합니다.
- 색: 잉크 남색 #173c66, 종이색 #f7f3ea, 본문 #252b28, 작은 갈색 포인트 #8a5a38.
- 서체: 시스템 한글 고딕. 외부 폰트·CDN 없음.
- 캐릭터: `homepage/img/bapjangbu-mascot.png` (512×512, 투명 PNG).
- 로고 조합: `homepage/img/bapjangbu-logo.png` (560×160).
- 문서 공용 복사본: `docs/assets/bapjangbu-mascot.png`.
- 공유 이미지: `homepage/og-image.png` (1200×630).
- 캐릭터는 주 행동 버튼과 경쟁하지 않게 머리말에서 작게 사용합니다. 보증·인증 표시로 사용하지 않습니다.
- 내장 이미지 생성 도구로 제작했습니다. 기존 기업 로고를 참고하거나 모방하지 않았습니다. 상표 선행조사나 등록 가능성 검토는 하지 않았습니다.

## 생성 프롬프트

Use case: logo-brand. Create one final brand mascot emblem for a sincere Korean neighborhood restaurant ledger tool named 밥장부. No lettering at all; wordmark will be real text beside it. A simple rice bowl character whose body subtly resembles an open ledger: cream cooked rice mound, dark ink-navy bowl with two tiny ledger lines at lower right, two quiet dot eyes and a small friendly smile on the rice. Restrained flat two-color hand-drawn print identity, soft human slightly imperfect contour, confident thick strokes, not childish, not glossy, no limbs, no money, no hats, no utensils, no extra objects. Square composition, centered single mark filling 78 percent width, generous clean surrounding space. Background flat warm cream #f7f3ea matching the current website. Palette ink navy #173c66, rice ivory #fffdf8, one restrained warm brown #8a5a38 detail. A trustworthy humble rice bowl for owners age50+, recognizable at48px and in black-and-white print. No typography, no watermark, no mockup, no shadows, no gradients. Output a high quality square PNG.

실제 결과는 투명 배경이어서 알파를 보존했습니다. 로고 조합·공유 이미지는 `harness/homepage-brand-preview.html`에서 실제 한글 텍스트와 캐릭터를 함께 렌더링했습니다.

## 실제 화면 예시

`homepage/img/guest-screen.webp`는 beta.51 음식점 앱을 로컬에서 렌더링한 화면입니다. ‘밥장부 예시식당 / 예시기관 / 김밥 / 90,000원’은 모두 설명용 가상 데이터입니다. 앱 소스는 수정하지 않았고, 미리보기 서버가 응답 메모리에만 예시를 넣었습니다. 저장소·운영 서버로 전송하지 않았습니다.
