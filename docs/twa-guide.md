# TWA(Trusted Web Activity) 등록 가이드

이 문서는 [android-deploy-plan.md](android-deploy-plan.md)에서 정한 TWA 방식을 실제로 실행하는 절차입니다.
`twa/twa-manifest.json`은 [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) 표준 형식으로 미리 채워둔 **틀(placeholder)**이며,
서명키·SHA-256 지문 등 실제 값은 아래 절차를 실행하는 사람이 로컬에서 생성해 채워야 합니다. 이 저장소에는 실제 서명키를 커밋하지 않습니다.

## 0. 전제

- 래핑 대상은 음식점 주인 앱(루트 `index.html`, GitHub Pages 배포): `https://nulmaru.github.io/Prepaid_PWA/`
- `manifest.json`(웹 앱 매니페스트)과 아이콘(`icons/icon-192.png`, `icons/icon-512.png`)은 이미 루트에 존재합니다.
- 담당자 웹(`agency-web/`)은 데스크톱 브라우저 대상이라 TWA 패키징 대상이 아닙니다.

## 1. Google Play 개발자 계정

1. https://play.google.com/console 에서 개발자 계정 생성 (1회 등록비, 신원확인 필요, 심사에 수일 소요될 수 있음).
2. 결제 프로필/사업자 정보 등록.
3. 새 앱 생성 → 앱 이름 "선입금대장", 기본 언어 한국어, 앱/게임 구분: 앱, 무료/유료: 무료.

## 2. Bubblewrap로 Android 프로젝트 생성

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest=https://nulmaru.github.io/Prepaid_PWA/manifest.json
```

`init`은 대화형으로 `twa/twa-manifest.json`과 동등한 설정을 다시 물어봅니다. 이미 이 저장소에 있는
`twa/twa-manifest.json`을 그대로 사용하려면, 새 빈 디렉터리에서:

```bash
mkdir prepaid-twa && cd prepaid-twa
cp /path/to/Prepaid_PWA/twa/twa-manifest.json .
bubblewrap build
```

`bubblewrap build`가 처음 실행되면:
- `android.keystore` 서명키를 새로 생성하라고 안내합니다(키 별칭·비밀번호 입력). **이 키스토어 파일과 비밀번호는 안전한 곳(비밀번호 관리자, 회사 금고 등)에 별도 백업하세요.** 분실 시 같은 앱으로 업데이트를 낼 수 없습니다. 저장소에는 커밋하지 마세요.
- 빌드가 끝나면 `app-release-signed.apk`(또는 `app-release-bundle.aab`)가 생성됩니다.

## 3. SHA-256 지문 확보

키스토어 생성 후 지문을 확인합니다:

```bash
keytool -list -v -keystore android.keystore -alias android
```

`Certificate fingerprints: SHA256:` 뒤에 나오는 값(콜론 포함 64바이트 hex)을 복사합니다.
`twa/twa-manifest.json`의 `fingerprints[0].value`를 이 값으로 교체하세요(현재는
`00:00:...` placeholder입니다). `packageId`도 실제 사용할 패키지명(`kr.nulmaru.prepaid` 등, Play Console에서
한 번 정하면 변경 불가)으로 확정해 둡니다.

## 4. assetlinks.json 배치 (PWA 리포 쪽 작업 — 별도 진행 필요)

TWA가 "주소창 없는 신뢰된 앱"으로 보이려면, Android 앱이 이 웹사이트의 소유자임을 증명하는
Digital Asset Links 파일을 **웹사이트(`nulmaru.github.io/Prepaid_PWA/`) 쪽에** 올려야 합니다.

- 이 작업 지시서는 루트 `index.html`을 수정할 수 없으므로, 실제 배치는 다른 작업(또는 사용자 본인)이 진행해야 합니다.
- 배치 위치: 저장소 루트에 `.well-known/assetlinks.json` 파일을 추가하고 GitHub Pages로 배포되게 합니다.
  최종 URL이 `https://nulmaru.github.io/Prepaid_PWA/.well-known/assetlinks.json`으로 접근 가능해야 합니다.
  (GitHub Pages는 정적 파일을 그대로 서빙하므로 `.well-known/assetlinks.json`을 루트에 커밋하면 됩니다.)
- 파일 내용 예시(§3에서 얻은 SHA-256 지문과 §3에서 정한 `packageId`로 채움):

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "kr.nulmaru.prepaid",
    "sha256_cert_fingerprints": [
      "SHA256_지문을_여기에_콜론포함_대문자로"
    ]
  }
}]
```

- **순서 주의**: 지문은 §3에서 실제 키스토어를 만든 뒤에만 알 수 있으므로, `assetlinks.json`은
  키스토어 생성 → 지문 확인 → `twa-manifest.json` 갱신 → `assetlinks.json` 작성/배포, 이 순서로만 진행할 수 있습니다.
  지문 없이 미리 배포하면 검증에 실패합니다.
- 배포 후 확인: `bubblewrap validate` 또는 Google의
  [Digital Asset Links API 테스트 도구](https://developers.google.com/digital-asset-links/tools/generator)로
  `assetlinks.json`이 올바르게 연결됐는지 확인합니다. 연결이 안 되면 TWA가 주소창이 보이는 커스텀 탭으로 표시됩니다(기능은 동작하나 앱처럼 보이지 않음).

## 5. 내부 테스트 트랙 업로드

1. Play Console → 앱 선택 → 테스트 → 내부 테스트 → 새 릴리스 만들기.
2. `bubblewrap build`로 만든 `.aab` 업로드.
3. 릴리스 노트 작성, 테스터 이메일 목록(내부 테스터 그룹) 등록.
4. 검토 후 게시 → 테스터에게 옵트인 링크 전달, 실기기에서 설치·동작 확인.

## 6. 심사 주의점 (Google Play 정책)

- **데이터 안전성 섹션**: [play-store-prep-plan.md](play-store-prep-plan.md)의 "데이터 안전성" 항목대로,
  직원명·부서명·거래 내역은 기기 로컬(IndexedDB)에만 저장되고 외부 서버로 전송되지 않는다는 점을
  Play Console 데이터 안전성 설문에 정확히 반영해야 합니다. (Phase 2 연동을 켠 경우 기관 명단이
  암호화되어 중계 서버를 거친다는 점도 별도로 명시해야 함 — 현재 앱은 이 기능이 선택적입니다.)
- **개인정보처리방침 URL 필수**: 스토어 등록 시 공개 URL이 있어야 합니다. 아직 없다면 게시 전에 작성·게시해야 합니다.
- **금융/결제 앱 오인 방지**: 앱 설명에 "결제·이체 기능 없음, 사전 등록된 선금 잔액 관리 도구"임을 명확히 기재해야
  Google의 금융 서비스 앱 추가 정책 검토를 피하거나 원활히 통과할 수 있습니다. (`agency-web/index.html` 하단
  컴플라이언스 문구와 동일한 취지로 스토어 설명도 작성 권장)
- **TWA 최소 기능 요건**: Google은 TWA가 "그냥 웹뷰 래핑"이 아니라 실제 앱다운 경험(오프라인 지원, 적절한
  스플래시/아이콘, 뒤로가기 동작)을 갖추길 요구합니다. 이 앱은 이미 서비스워커 오프라인 캐시(`sw.js`)를
  사용하므로 기본 요건은 충족하나, 실기기 테스트에서 뒤로가기 버튼 동작과 오프라인 진입을 반드시 확인하세요.
- **패키지명은 사실상 영구적**: 한 번 Play Console에 앱을 만들면 `packageId` 변경이 사실상 불가능합니다.
  `kr.nulmaru.prepaid`를 최종안으로 쓸지 미리 확정하세요.
- **서명키 분실 = 복구 불가**: §2에서 만든 키스토어를 분실하면 같은 앱 리스팅에 업데이트를 올릴 수 없고
  새 앱으로 다시 등록해야 합니다(기존 설치자는 이전 지원). 반드시 이중 백업하세요.

## 7. 관련 문서

- [android-deploy-plan.md](android-deploy-plan.md) — 배포 방식 선정 배경(TWA vs Capacitor vs WebView).
- [play-store-prep-plan.md](play-store-prep-plan.md) — 스토어 등록 자료·데이터 안전성 체크리스트.
- `twa/twa-manifest.json` — Bubblewrap 설정 틀(placeholder). 실제 값 채우는 법은 위 §2~§3 참고.
