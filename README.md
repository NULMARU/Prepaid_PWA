# 선입금대장 (Prepaid Ledger PWA)

소규모 음식점에서 단체·직원 식대 선입금을 관리하는 오프라인 지원 PWA 앱입니다.

## 주요 기능
- 부서별 직원 잔액 관리
- 서울시청·서울시 25개 구청 과 단위 부서 선택
- 식사 사용 시 서명 기반 차감
- 일자별/직원별 거래 이력 조회
- 장부 안전 저장 (엑셀용 CSV + 복원용 JSON)
- 저장한 데이터 복원 (JSON)
- 4자리 PIN 잠금
- 초기 설정 마법사 (가게 정보 직접 입력)
- Android PWA 설치용 PNG 아이콘 제공

## 사용 방법
브라우저에서 `index.html`을 열거나, 웹 서버에 호스팅하여 사용합니다.

```bash
python -m http.server 8765
```

## 파일 구성
| 파일 | 설명 |
|------|------|
| `index.html` | 앱 전체 (HTML/CSS/JS 단일 파일) |
| `manifest.json` | PWA 매니페스트 |
| `sw.js` | 서비스 워커 (오프라인 캐시) |
| `agency-departments.json` | 서울시청·25개 구청 과 단위 부서 목록 |
| `icons/` | Android PWA 설치용 PNG 아이콘 |
| `manual.html` | 사용자 매뉴얼 (인쇄용) |

## 라이선스
© 2026 선입금대장
