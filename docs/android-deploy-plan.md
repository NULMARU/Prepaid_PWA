# Android 배포 방식 추천

## 추천: Trusted Web Activity (TWA)

현재 앱은 정적 PWA입니다. IndexedDB, 서비스워커, 오프라인 캐시를 이미 사용하고 있으므로 Android 배포는 TWA가 가장 작고 유지보수 비용이 낮습니다.

## 장점

- 기존 PWA 코드를 거의 그대로 재사용합니다.
- Chrome 기반 실행 환경이라 서비스워커와 IndexedDB 호환성이 좋습니다.
- Play Store용 Android 패키지를 만들 수 있습니다.
- 네이티브 WebView보다 브라우저 업데이트 혜택을 받기 쉽습니다.

## 단점

- 웹 origin과 Android 앱의 Digital Asset Links 설정이 필요합니다.
- 파일 저장, 생체인증, 공유 같은 깊은 네이티브 기능은 별도 연동이 필요합니다.
- 앱 품질은 웹 배포 품질에 직접 의존합니다.

## 보류한 대안

- Capacitor: 네이티브 기능을 많이 붙일 때 적합하지만 현재 단계에서는 프로젝트 복잡도가 큽니다.
- 순수 WebView: 서비스워커/스토리지/호환성 책임을 직접 져야 하므로 추천하지 않습니다.

## 내부 테스트 후 진행 순서

1. 배포 URL 확정
2. PWA manifest와 아이콘 보강
3. TWA Android 프로젝트 생성
4. `assetlinks.json` 설정
5. 서명키 생성 및 보관
6. 내부 테스트 트랙 업로드
7. Play Store 심사 자료 제출
