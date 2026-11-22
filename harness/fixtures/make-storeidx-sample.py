# 가게 색인 검사용 작은 견본(cp949) 생성 — 광진구 실제 행 26개 + 경계 사례 합성 행 16개.
#   python3 -I harness/fixtures/make-storeidx-sample.py <광진구 원본 CSV(cp949)> harness/fixtures/storeidx-sample.cp949.csv
# 원본: https://file.localdata.go.kr/file/download/general_restaurants/info?orgCode=3040000 (리포에 넣지 않는다, 약 5MB)
# 인코딩은 파이썬 cp949 — 생성기(harness/build-storeidx.mjs)의 해석기와 독립이라 서로를 검증한다.
# 실제 행의 전화번호는 표식 값(029998877)으로 바꿔 넣는다 — 색인에 전화번호가 새지 않는지 보는 용도.
import csv, io, sys
src = open(sys.argv[1],'rb').read().decode('cp949')
rows = list(csv.reader(io.StringIO(src)))
hdr = rows[0]; H = {h:i for i,h in enumerate(hdr)}
data = rows[1:]
want = ['3040000-101-2024-00011','3040000-101-2017-00245']
pick = [r for r in data if r[H['관리번호']] in want]
act = [r for r in data if r[H['영업상태코드']]=='01' and r[H['관리번호']] not in want]
clo = [r for r in data if r[H['영업상태코드']]=='03']
sel = act[::300][:14]
sel += [r for r in act if ('"' in r[H['사업장명']] or '(' in r[H['사업장명']]) and r not in sel][:2]
sel_c = clo[::1500][:8]
real = pick + sel + sel_c
for r in real: r[H['전화번호']] = '029998877'   # 전화번호가 결과에 새지 않는지 볼 표식
def syn(id_, name, road, jibun, zip_, code='01', phone='0215550001'):
    r = ['']*len(hdr)
    r[H['개방자치단체코드']]='9999999'; r[H['관리번호']]=id_; r[H['사업장명']]=name
    r[H['도로명주소']]=road; r[H['지번주소']]=jibun; r[H['도로명우편번호']]=zip_
    r[H['영업상태코드']]=code; r[H['영업상태명']]={'01':'영업/정상','02':'휴업','03':'폐업'}[code]
    r[H['전화번호']]=phone
    return r
S = [
 syn('T-ADDR-NONE','주소없는집','','','05044'),
 syn('3040000-101-2024-00011','중복된관리번호','서울특별시 광진구 어딘가 1','','05044'),
 syn('T-UHC','똠얌꿍 쌀국수 츧','서울특별시 광진구 자양로 1, 1층 (구의동)','서울특별시 광진구 구의동 1-1','05044'),
 syn('T-QUOTE','그 집 "원조"','서울특별시 광진구 자양로 2, 1층,\n2층 (구의동)','서울특별시 광진구 구의동 2-2','05044'),
 syn('T-ROADLESS','지번만있는집','','서울특별시 광진구 구의동 3-3','05044'),
 syn('T-INCHEON-ZIP','옛중구영종','인천광역시 중구 공항로 1','인천광역시 중구 운서동 1-1','23203'),
 syn('T-INCHEON-DONG','옛중구신포','인천광역시 중구 신포로 1 (신포동)','인천광역시 중구 신포동 1-1',''),
 syn('T-HWASEONG','동탄구빠진주소','경기도 화성시 동탄대로 1','경기도 화성시 반송동 1-1','18434'),
 syn('T-GUNWI','군위옛시도','경상북도 군위군 군위읍 중앙길 1','경상북도 군위군 군위읍 동부리 1','43106'),
 syn('T-GWANGJU','광주옛이름','광주광역시 광산구 우산로 1','광주광역시 광산구 우산동 1-1','62316'),
 syn('T-SEJONG','세종가게','세종특별자치시 한누리대로 1','세종특별자치시 나성동 1','30128'),
 syn('T-GANGWON','강원옛이름','강원도 춘천시 효자로 1','강원도 춘천시 효자동 1-1','24257'),
 syn('T-NOWHERE','어디인지모름','어딘가도 모름시 길 1','',''),
 syn('T-CLOSED-02','휴업한집','서울특별시 광진구 자양로 9','','05044', code='02'),
]
out = io.StringIO()
w = csv.writer(out, lineterminator='\n')
w.writerow(hdr)
for r in real[:13]: w.writerow(r)
for r in S: w.writerow(r)
for r in real[13:]: w.writerow(r)
text = out.getvalue()
# 열 개수가 틀린 행(깨진 행) 하나, CRLF 줄 하나
text += 'T,T-COLS,깨진행\n'
lines = text.split('\n'); lines[3] = lines[3] + '\r'; text = '\n'.join(lines)
b = text.encode('cp949')
# 풀 수 없는 바이트(0xC9 0x4B)를 이름에 넣은 행 — cp949로 인코딩할 수 없으니 바이트로 붙인다
bad = syn('T-BADBYTE','XX깨진글자','서울특별시 광진구 자양로 3','','05044')
o2 = io.StringIO(); csv.writer(o2, lineterminator='\n').writerow(bad)
b += o2.getvalue().encode('cp949').replace(b'XX', b'\xc9\x4b')
open(sys.argv[2],'wb').write(b)
print(len(b), 'bytes', len(real), 'real', len(S)+2, 'synthetic')
