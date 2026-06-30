# 다자간 연동 프로토콜 v1 (담당자 웹 ↔ 중계 서버 ↔ 음식점 앱)

> 본 문서는 세 컴포넌트가 공유하는 **암호 blob 포맷·batch_hash 규칙·REST 계약**의 단일 기준이다.
> 스펙 §1.2(불변식), §2.2(서버 스키마), §4.2(암호화)를 구현으로 고정한다.

## 0. 절대 불변식 (서버 코드가 반드시 지킴)
- 서버는 **평문 개인정보(직원명·금액 리스트·전화번호)를 저장·로깅하지 않는다.** 저장 대상은 암호문(`ciphertext`)뿐이며 서버는 복호화 키가 없다.
- 전화번호는 담당자 경로(웹·서버·blob)에 **존재하지 않는다.**
- 집계(`deposit_summary`)는 총액·인원수·해시만 보관한다(개인별 금액·이름 ❌).

## 1. 키
- 음식점 앱: `RSA-OAEP` 2048 / SHA-256 키페어. 공개키는 SPKI를 base64로 인코딩해 등록.
- 식별자 `restaurant_id`: LOCALDATA 관리번호(`mgtNo`) 또는 음식점이 설정에서 정한 값. 등록·blob·summary에서 동일하게 사용.

## 2. 암호 blob 포맷 (하이브리드: AES-GCM 본문 + RSA-OAEP 키 봉인)
명단이 RSA 직접 암호화 한계(~190B)를 넘으므로 하이브리드 고정.

평문(직원 명단):
```json
{ "v":1, "items":[ {"name":"홍길동","dept":"세무과","amount":90000}, ... ] }
```
암호화 절차:
1. `aesKey` = 무작위 AES-256-GCM 키
2. `iv` = 무작위 12바이트
3. `ct` = AES-GCM(aesKey, iv, UTF8(JSON(plaintext)))
4. `encKey` = RSA-OAEP(restaurant_public_key, raw(aesKey))

blob(서버로 전송·저장되는 ciphertext, base64 필드):
```json
{ "alg":"RSA-OAEP-2048+AES-256-GCM", "encKey":"<b64>", "iv":"<b64>", "ct":"<b64>" }
```
복호화(음식점 앱): `aesKey = RSA-OAEP^-1(priv, encKey)` → `plaintext = AES-GCM^-1(aesKey, iv, ct)`.

## 3. batch_hash (전송 변조 탐지, 스펙 §4.3)
담당자 웹이 평문 명단으로 계산, summary에 실어 보냄. 음식점 앱이 복호화 후 재계산해 대조.
```
canonical = items 정렬(name,dept,amount 오름차순)을 "name|dept|amount" 줄로 join("\n")
batch_hash = SHA-256(hex)
```

## 4. REST 계약 (서버)
모든 응답 JSON. 오류는 `{error}` + 상태코드.

| 메서드·경로 | 요청 | 응답 | 비고 |
|---|---|---|---|
| `POST /api/register-key` | `{restaurant_id, restaurant_name, public_key}` | `{ok:true}` | 공개키 upsert |
| `GET /api/public-key?restaurant_id=` | — | `{restaurant_id, public_key}` / 404 | 담당자 웹이 암호화 전 조회 |
| `GET /api/restaurants?region=&q=` | — | `[{restaurant_id,name,address,status}]` | LOCALDATA 프록시(키 은닉), 지역 필수 |
| `POST /api/submit` | `{summary, blob, consent}` (아래) | `{summary_id}` | 부서·음식점 단위 1건 |
| `GET /api/inbox?restaurant_id=` | — | `[{summary_id, summary, ciphertext, status}]` | 음식점 앱 폴링(PENDING만) |
| `POST /api/approve` | `{summary_id, status:"APPROVED"\|"REJECTED"}` | `{ok:true}` | 승인/거절, blob delivered 표시 |

`POST /api/submit` 본문:
```json
{
  "summary": { "institution":"서울특별시 강남구", "department":"세무과",
    "restaurant_id":"...", "restaurant_name":"정식김밥", "year_month":"2026-07",
    "total_amount":2700000, "member_count":30, "batch_hash":"<hex>" },
  "blob":   { "restaurant_id":"...", "ciphertext": { ...§2 blob... } },
  "consent":{ "institution":"서울특별시 강남구", "department":"세무과", "year_month":"2026-07" }
}
```

## 5. 상태 머신
`deposit_summary.status`: `PENDING` →(approve)→ `APPROVED` / `REJECTED`.
거절 시 음식점 앱은 복호화하지 않고 폐기. 승인 시에만 blob 복호화.
