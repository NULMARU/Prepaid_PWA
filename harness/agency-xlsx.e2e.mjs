// 담당자 웹 3단계: 엑셀(.xlsx) 양식 다운로드(고른 음식점·소속기관·부서 미리 채움)와 .xlsx 업로드 (2026-10-31 현장 보고)
// 사용: node harness/agency-xlsx.e2e.mjs [agency-web/index.html]  — 외부 요청은 전부 404로 막는다.
import { chromium } from 'playwright';
import fs from 'fs';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
const src=fs.readFileSync(process.argv[2]||new URL('../agency-web/index.html',import.meta.url),'utf8')
  .replace("const S={","const S=window.__S={")
  .replace("function validateAndRenderCsv(){","window.__v=()=>validateAndRenderCsv();window.__sv=n=>setView(n);function validateAndRenderCsv(){");
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++}else{fail++;console.log('FAIL',m)}};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agxlsx-'));
// 엑셀이 실제로 저장하는 모양(deflate 압축 · sharedStrings · 숫자 칸 · 행 번호 r)을 흉내 낸 파일
function crc32(b){let c=~0;for(const x of b){c^=x;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1}return (~c)>>>0}
function zipDeflate(files){const parts=[],cd=[];let off=0;
  for(const [name,text] of files){const nm=Buffer.from(name),raw=Buffer.from(text),d=zlib.deflateRawSync(raw),crc=crc32(raw);
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(d.length,18);h.writeUInt32LE(raw.length,22);h.writeUInt16LE(nm.length,26);
    parts.push(h,nm,d);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(d.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(nm.length,28);c.writeUInt32LE(off,42);
    cd.push(c,nm);off+=30+nm.length+d.length}
  const cds=Buffer.concat(cd),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(files.length,8);e.writeUInt16LE(files.length,10);e.writeUInt32LE(cds.length,12);e.writeUInt32LE(off,16);
  return Buffer.concat([...parts,cds,e])}
const NS='xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
function excelLike(rows){ // rows: [[...]] — 문자열은 sharedStrings, 숫자는 n 칸, 빈 문자열은 칸 생략
  const ss=[],idx=new Map();const si=v=>{if(!idx.has(v)){idx.set(v,ss.length);ss.push(v)}return idx.get(v)};
  const col=i=>String.fromCharCode(65+i);
  const sheet=`<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData>`+rows.map((r,ri)=>r==null?'':`<row r="${ri+1}">`+r.map((v,ci)=>v===''?'':typeof v==='number'?`<c r="${col(ci)}${ri+1}"><v>${v}</v></c>`:`<c r="${col(ci)}${ri+1}" t="s"><v>${si(v)}</v></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>';
  const sst=`<?xml version="1.0" encoding="UTF-8"?><sst ${NS}>`+ss.map(v=>`<si><r><t>${v.slice(0,1)}</t></r><r><t>${v.slice(1)}</t></r><rPh sb="0" eb="1"><t>X</t></rPh></si>`).join('')+'</sst>';
  return zipDeflate([['[Content_Types].xml','<Types/>'],['xl/workbook.xml',`<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId9"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="x" Target="worksheets/data.xml"/></Relationships>'],
    ['xl/sharedStrings.xml',sst],['xl/worksheets/data.xml',sheet]])}
const b=await chromium.launch();const ctx=await b.newContext({acceptDownloads:true});const p=await ctx.newPage();
let dialogs=0;p.on('dialog',d=>{dialogs++;d.dismiss()});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.route('**/*',r=>{const u=r.request().url();
  if(u==='http://t.test/')return r.fulfill({contentType:'text/html',body:src});
  return r.fulfill({status:404,body:''});});
await p.goto('http://t.test/');
const R1='육회바른연어 구의역점',R2='가나다 김밥';
await p.evaluate(([R1,R2])=>{const S=window.__S;S.authed=true;S.agency={name:'광진구청'};S.dept='위생과';
  S.restaurants=[{name:R1,restaurant_id:'r1'},{name:R2,restaurant_id:'r2'}];document.getElementById('csvCard').classList.remove('hide');window.__v();window.__sv(3);document.getElementById('modalRoot').innerHTML=''},[R1,R2]);
// 1 엑셀 양식 다운로드 — 진짜 zip, 첫 줄 '소속기관', 고른 가게(가나다순)×3줄 미리 채움
let [dl]=await Promise.all([p.waitForEvent('download'),p.click('#csvTemplateBtn')]);
const xf=path.join(tmp,'t.xlsx');await dl.saveAs(xf);
ok(dl.suggestedFilename()==='밥장부_명단양식.xlsx','1 파일 이름 '+dl.suggestedFilename());
{const [dc]=await Promise.all([p.waitForEvent('download'),p.click('#csvTemplateCsvLink')]);
  ok(dc.suggestedFilename()==='밥장부_명단양식.csv','1 CSV 양식 파일 이름 '+dc.suggestedFilename());}
const listing=execFileSync('unzip',['-Z1',xf]).toString();
ok(/\[Content_Types\]\.xml/.test(listing)&&/xl\/worksheets\/sheet1\.xml/.test(listing)&&/xl\/styles\.xml/.test(listing),'1 xlsx 구성 파일 '+listing);
execFileSync('unzip',['-tq',xf]); // CRC 오류면 예외
const sx=execFileSync('unzip',['-p',xf,'xl/worksheets/sheet1.xml']).toString();
const cells=[...sx.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)].map(m=>[...m[2].matchAll(/<t xml:space="preserve">(.*?)<\/t>/g)].map(x=>x[1]));
ok(cells[0].join()==='음식점명,소속기관,부서명,직원명,급량개수,선금금액,입금자명,결제구분','1 첫 줄 '+cells[0]);
ok(cells.length===7&&cells.slice(1,4).every(r=>r.join()===R2+',광진구청,위생과')&&cells.slice(4).every(r=>r.join()===R1+',광진구청,위생과'),'1 미리 채운 줄 '+JSON.stringify(cells));
ok(/state="frozen"/.test(sx),'1 첫 줄 고정');
const up=async(name,buf,mime)=>{await p.setInputFiles('#csv',{name,mimeType:mime||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:buf});await p.waitForTimeout(300)};
const st=()=>p.evaluate(()=>{const S=window.__S;return{rows:(S.rawRows||[]).map(r=>[r.rest,r.org,r.dept,r.name,r.amount,r.payer,r.payMethod,r.line].join('|')),
  valid:S.valid,fmt:S.csvFormat,warn:(S.fileWarnings||[]).join('\n'),err:(S.fileErrors||[]).join('\n'),text:document.getElementById('csvResult').innerText}});
// 2 받은 양식을 그대로 올리면(아무것도 안 적음) 빈 줄만 → '데이터 행이 없습니다', 오류 없이 처리
await up('t.xlsx',fs.readFileSync(xf));let s=await st();
ok(s.rows.length===0&&/데이터 행이 없습니다/.test(s.err),'2 빈 양식 업로드 '+JSON.stringify(s));
// 3 (예전 7열 첫 줄 — 급량개수 없음도 그대로) 엑셀이 저장한 모양의 파일: deflate·sharedStrings(서식 조각+윗주)·숫자 금액·빈 줄 끼움·미리 채운 줄 남김
const filled=excelLike([['음식점명','소속기관','부서명','직원명','선금금액','입금자명','결제구분'],
  [R2,'광진구청','위생과','김진표',72000,'배유정','카드'],
  null,
  [R2,'광진구청','위생과','배유정','27,000','',''],
  [R2,'광진구청','위생과','','','',''],
  [R1,'광진구청','위생과','홍길동',9000,'','계좌이체'],
  [R1,'광진구청','위생과','','','',''],[R1,'광진구청','위생과','','','','']]);
await up('명단.xlsx',filled);s=await st();
ok(s.rows.join('/')===[R2+'|광진구청|위생과|김진표|72000|배유정|카드|2',R2+'|광진구청|위생과|배유정|27000|||4',R1+'|광진구청|위생과|홍길동|9000||계좌이체|6'].join('/'),'3 읽은 행·행 번호 '+JSON.stringify(s.rows));
ok(s.fmt==='pay'&&s.valid,'3 결제 양식으로 인식·진행 가능 '+JSON.stringify({fmt:s.fmt,valid:s.valid,err:s.err}));
ok(/빈 줄/.test(s.warn)&&/3개/.test(s.warn),'3 건너뛴 빈 줄 3개 안내 '+s.warn);
// 4 CSV 양식 링크 — BOM·첫 줄·미리 채운 줄, 그 파일에 적어 올리면 그대로 읽힘
await p.click('#csvResult button[data-csv="clear"]');
[dl]=await Promise.all([p.waitForEvent('download'),p.click('#csvTemplateCsvLink')]);
const cf=path.join(tmp,'t.csv');await dl.saveAs(cf);const cb=fs.readFileSync(cf);
ok(cb[0]===0xEF&&cb[1]===0xBB&&cb[2]===0xBF,'4 CSV BOM');
const ct=cb.toString('utf8').slice(1).split('\r\n');
ok(ct[0]==='음식점명,소속기관,부서명,직원명,급량개수,선금금액,입금자명,결제구분'&&ct[1]===R2+',광진구청,위생과,,,,,'&&ct.length===8,'4 CSV 내용 '+JSON.stringify(ct));
ct[1]=R2+',광진구청,위생과,김진표,,10000,,';
await up('t.csv',Buffer.from('﻿'+ct.join('\r\n')),'text/csv');s=await st();
ok(s.rows.length===1&&s.valid&&/5개/.test(s.warn),'4 CSV 적어 올리기 '+JSON.stringify(s));
// 5 예전 엑셀(.xls)·한셀 같은 OLE 파일 → 저장 방법 안내, 기존 명단 유지
await up('옛.xls',Buffer.from([0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1,0,0,0,0]),'application/vnd.ms-excel');s=await st();
ok(s.rows.length===1&&/\.xlsx/.test(s.text)&&/반영되지 않았어요/.test(s.text),'5 .xls 안내·기존 유지 '+JSON.stringify(s.text.slice(0,200)));
// 6 깨진 zip → 기존 명단 유지
await up('깨짐.xlsx',Buffer.from('PK\x03\x04garbage'));s=await st();
ok(s.rows.length===1&&/엑셀 파일을 읽지 못했어요/.test(s.text),'6 깨진 엑셀 '+JSON.stringify(s.text.slice(0,200)));
// 7 예전 첫 줄('소속')·5열 CSV도 그대로
await p.click('#csvResult button[data-csv="clear"]');
await up('옛.csv',Buffer.from('음식점명,소속,부서명,직원명,선금금액,입금자명\n'+R1+',광진구청,위생과,김진표,5000,\n'),'text/csv');s=await st();
ok(s.rows.length===1&&s.fmt==='org'&&s.valid,'7 예전 소속 첫 줄 '+JSON.stringify(s));
ok(await p.$eval('#csv',e=>e.accept)==='.xlsx,.csv','8 파일 선택 허용 형식');
// ── beta.55 (D-4·D-5·D-8) — 아래 단언은 전부 수정 전 코드에서 실패한다 ──
const H5='음식점명,소속,부서명,직원명,선금금액,입금자명\n';
const csvUp=async(name,txt)=>{await p.click('#csvResult button[data-csv="clear"]').catch(()=>{});await up(name,Buffer.from('﻿'+txt),'text/csv')};
const rowsOf=()=>p.evaluate(()=>(window.__S.rows||[]).map(r=>({name:r.name,amount:r.amount,err:r.err,line:r.line,rest:r.rest,skip:r.skip})));
// 9 금액은 숫자만: 16진수·지수·소수·음수·20자리·문자는 거부, ￦/₩/원/전각 숫자는 받는다(예전엔 0x2328·1e4가 통과, ￦9,000이 거부)
await csvUp('a.csv',H5+[['헥사','0x2328'],['지수','1e4'],['소수','9000.5'],['음수','-9000'],['스무자리','12345678901234567890'],['원화','￦9,000'],['원화2','₩ 9,000원'],['전각','９０００']]
  .map(([n,a])=>`${R1},광진구청,위생과,${n},"${a}",`).join('\n')+'\n');
let rr=await rowsOf();const by=n=>rr.find(r=>r.name===n)||{};
ok(['헥사','지수','소수','음수'].every(n=>/숫자만/.test(by(n).err||''))&&/1,000만 원/.test(by('스무자리').err||''),'9 엄격한 금액 거부 '+JSON.stringify(rr));
ok(by('원화').amount===9000&&!by('원화').err&&by('원화2').amount===9000&&!by('원화2').err&&by('전각').amount===9000&&!by('전각').err,'9 ￦·₩·원·전각 숫자 허용 '+JSON.stringify(rr));
// 10 1인 상한 1,000만 원(정확히 1,000만은 허용) · 급량개수×단가가 상한을 넘어도 막음
await csvUp('b.csv','음식점명,소속기관,부서명,직원명,급량개수,선금금액,입금자명,결제구분\n'+`${R1},광진구청,위생과,천만,,10000000,,\n${R1},광진구청,위생과,초과,,10000001,,\n${R1},광진구청,위생과,급량초과,2000,,,\n`);
rr=await rowsOf();
ok(!by('천만').err&&/1,000만 원/.test(by('초과').err||'')&&/1,000만 원/.test(by('급량초과').err||''),'10 1인 상한 '+JSON.stringify(rr));
// 11 따옴표 없는 10,000: 칸이 넘치면 '쉼표·따옴표' 원인을 말하고, 넘치지 않아도(입금자명 칸에 000) 잡는다
await csvUp('c.csv',H5+`${R1},광진구청,위생과,넘침,10,000,배유정\n`);rr=await rowsOf();
ok(/칸 수가 첫 줄보다 많아요/.test(by('넘침').err||'')&&/따옴표/.test(by('넘침').err||''),'11 칸 넘침 '+JSON.stringify(rr));
await csvUp('d.csv',H5+`${R1},광진구청,위생과,갈라짐,10,000\n`);rr=await rowsOf();
ok(/쉼표 때문에 칸이 나뉜/.test(by('갈라짐').err||''),'11 쉼표로 갈라진 금액 '+JSON.stringify(rr));
// 12 날짜로 바뀐 금액: CSV 글자(2026-11-01)와 엑셀 날짜 서식 칸(46327) 모두 막음
await csvUp('e.csv',H5+`${R1},광진구청,위생과,날짜글자,2026-11-01,\n`);rr=await rowsOf();
ok(/날짜로 바뀌어/.test(by('날짜글자').err||''),'12 CSV 날짜 금액 '+JSON.stringify(rr));
const styles=`<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`;
const dsheet=`<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData><row r="1">`+['음식점명','소속','부서명','직원명','선금금액','입금자명'].map((v,i)=>`<c r="${String.fromCharCode(65+i)}1" t="inlineStr"><is><t>${v}</t></is></c>`).join('')+
  `</row><row r="2"><c r="A2" t="inlineStr"><is><t>${R1}</t></is></c><c r="B2" t="inlineStr"><is><t>광진구청</t></is></c><c r="C2" t="inlineStr"><is><t>위생과</t></is></c><c r="D2" t="inlineStr"><is><t>날짜칸</t></is></c><c r="E2" s="1"><v>46327</v></c></row>`+
  `<row r="3"><c r="A3" t="inlineStr"><is><t>${R1}</t></is></c><c r="B3" t="inlineStr"><is><t>광진구청</t></is></c><c r="C3" t="inlineStr"><is><t>위생과</t></is></c><c r="D3" t="inlineStr"><is><t>숫자칸</t></is></c><c r="E3"><v>46327</v></c></row></sheetData></worksheet>`;
await p.click('#csvResult button[data-csv="clear"]').catch(()=>{});
await up('날짜.xlsx',zipDeflate([['xl/styles.xml',styles],['xl/worksheets/sheet1.xml',dsheet]]));rr=await rowsOf();
ok(/날짜로 바뀌어/.test(by('날짜칸').err||'')&&by('숫자칸').amount===46327&&!by('숫자칸').err,'12 엑셀 날짜 서식 칸만 막음 '+JSON.stringify(rr));
// 13 CSV 줄 번호 = 실제 파일 줄(빈 줄이 끼어도)
await csvUp('f.csv',H5+`\n${R1},광진구청,위생과,셋째줄,9000,\n\n\n${R1},광진구청,위생과,여섯째줄,abc,\n`);rr=await rowsOf();
ok(by('셋째줄').line===3&&by('여섯째줄').line===6,'13 줄 번호 '+JSON.stringify(rr));
// 14 UTF-16(엑셀 [유니코드 텍스트] — BOM FF FE, 탭 구분)
const u16=Buffer.concat([Buffer.from([0xFF,0xFE]),Buffer.from(['음식점명','소속','부서명','직원명','선금금액','입금자명'].join('\t')+'\r\n'+[R1,'광진구청','위생과','유니코드','9000',''].join('\t')+'\r\n','utf16le')]);
await p.click('#csvResult button[data-csv="clear"]').catch(()=>{});
await up('u16.txt',u16,'text/plain');rr=await rowsOf();
ok(rr.length===1&&by('유니코드').amount===9000&&!by('유니코드').err,'14 UTF-16 읽기 '+JSON.stringify(rr));
// 15 CSV 양식의 수식 주입 방지: = + - @ 로 시작하는 미리 채운 칸에 ' 를 붙이고, 올릴 때 떼어 원래 가게와 맞춘다
const EVIL='=1+1 식당',AT='@김밥';
await p.evaluate(([EVIL,AT])=>{const S=window.__S;S.restaurants=[{name:EVIL,restaurant_id:'e1'},{name:AT,restaurant_id:'e2'}];window.__v()},[EVIL,AT]);
await p.click('#csvResult button[data-csv="clear"]').catch(()=>{});
[dl]=await Promise.all([p.waitForEvent('download'),p.click('#csvTemplateCsvLink')]);
const gf=path.join(tmp,'g.csv');await dl.saveAs(gf);const gl=fs.readFileSync(gf).toString('utf8').slice(1).split('\r\n');
// 엑셀 양식(.xlsx)은 모든 칸이 글자라 따옴표를 붙이지 않는다(원래 이름 그대로)
[dl]=await Promise.all([p.waitForEvent('download'),p.click('#csvTemplateBtn')]);
const xf2=path.join(tmp,'t2.xlsx');await dl.saveAs(xf2);
const sx2=execFileSync('unzip',['-p',xf2,'xl/worksheets/sheet1.xml']).toString();
ok(gl[1]==="'"+AT+',광진구청,위생과,,,,,'&&gl[4]==="'"+EVIL+',광진구청,위생과,,,,,'&&sx2.includes('<t xml:space="preserve">'+EVIL+'</t>')&&!sx2.includes("'"+EVIL),'15 CSV 양식만 머리 따옴표(xlsx는 그대로) '+JSON.stringify(gl.slice(0,5)));
gl[1]="'"+AT+',광진구청,위생과,김진표,,9000,,';gl[4]="'"+EVIL+',광진구청,위생과,배유정,,9000,,';
await up('g.csv',Buffer.from('﻿'+gl.join('\r\n')),'text/csv');rr=await rowsOf();
ok(rr.length===2&&rr.every(r=>!r.skip&&!r.err)&&by('김진표').rest===AT&&by('배유정').rest===EVIL,'15 올릴 때 따옴표 떼고 가게와 맞춤 '+JSON.stringify(rr));
// ── beta.60 (W-6·W-13) — 아래 단언은 전부 수정 전 코드에서 실패한다 ──
await p.evaluate(R1=>{const S=window.__S;S.restaurants=[{name:R1,restaurant_id:'r1'}];window.__v()},R1);
// 16 받는 음식점 앱과 같은 제한(앱 validateRosterItems: 이름 40자·소속/부서 60자·한 명단 3,000명, 보이지 않는 문자를 뗀 이름이 비면 거부)
const N41='가'.repeat(41),N40='나'.repeat(40),D61='과'.repeat(61),O61='기'.repeat(61),ZW='​​',RLO='‮오른쪽',D60='부'.repeat(60);
await csvUp('w6.csv',H5+[[ '광진구청','위생과',N41],['광진구청','위생과',N40],['광진구청',D61,'긴부서'],[O61,'위생과','긴소속'],['광진구청',D60,'육십자부서'],['광진구청','위생과',ZW],['광진구청','위생과',RLO]]
  .map(([o,d,n])=>`${R1},${o},${d},${n},9000,`).join('\n')+'\n');
rr=await rowsOf();
ok(/40자/.test(by(N41).err||'')&&!by(N40).err,'16 직원명 40자 한도 '+JSON.stringify(rr.map(r=>[r.name.length,r.err])));
ok(/60자/.test(by('긴부서').err||'')&&/60자/.test(by('긴소속').err||'')&&!by('육십자부서').err,'16 소속·부서 60자 한도 '+JSON.stringify(rr.map(r=>[r.name.slice(0,4),r.err])));
ok(/빈 칸/.test(by(ZW).err||'')&&!by(RLO).err,'16 보이지 않는 문자만 있는 이름은 빈 칸(앱처럼 정리 뒤 판정) '+JSON.stringify(rr.map(r=>[r.name.length,r.err])));
ok(await p.evaluate(()=>window.__S.valid)===false,'16 문제 줄이 있으면 다음 단계로 못 감');
// 3,000명 한도는 '음식점·소속·부서 한 묶음'(= 음식점 앱이 받는 명단 한 건) 단위
const many=n=>H5+Array.from({length:n},(_,i)=>`${R1},광진구청,위생과,직원${i},9000,`).join('\n')+'\n';
await csvUp('w6b.csv',many(3001));
let g6=await p.evaluate(()=>{const rs=window.__S.rows||[];return{n:rs.length,errN:rs.filter(r=>/3,000명/.test(r.err||'')).length,valid:window.__S.valid}});
ok(g6.n===3001&&g6.errN===3001&&!g6.valid,'16 한 묶음 3,001명은 막음 '+JSON.stringify(g6));
await csvUp('w6c.csv',many(3000));
g6=await p.evaluate(()=>{const rs=window.__S.rows||[];return{n:rs.length,errN:rs.filter(r=>r.err).length}});
ok(g6.n===3000&&g6.errN===0,'16 3,000명은 그대로 '+JSON.stringify(g6));
// 17 엑셀 수식 칸(W-13): 저장된 계산값이 없으면 막고, 있으면 읽되 경고, 수동 계산으로 저장된 파일은 막는다
const ic=(ref,v)=>`<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
const head6=`<row r="1">`+['음식점명','소속','부서명','직원명','선금금액','입금자명'].map((v,i)=>ic(String.fromCharCode(65+i)+'1',v)).join('')+`</row>`;
const frow=(r,name,amtCell)=>`<row r="${r}">${ic('A'+r,R1)}${ic('B'+r,'광진구청')}${ic('C'+r,'위생과')}${ic('D'+r,name)}${amtCell}</row>`;
const fsheet=rows=>`<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData>${head6}${rows}</sheetData></worksheet>`;
const wbx=calc=>`<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>${calc}</workbook>`;
const relx='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>';
const fx=(calc,rows)=>zipDeflate([['xl/workbook.xml',wbx(calc)],['xl/_rels/workbook.xml.rels',relx],['xl/worksheets/sheet1.xml',fsheet(rows)]]);
await p.click('#csvResult button[data-csv="clear"]').catch(()=>{});
await up('수식.xlsx',fx('<calcPr calcId="191029"/>',frow(2,'수식값있음','<c r="E2"><f>20*9000</f><v>180000</v></c>')+frow(3,'수식값없음','<c r="E3"><f>20*9000</f></c>')+frow(4,'보통값','<c r="E4"><v>9000</v></c>')));
rr=await rowsOf();s=await st();
ok(/수식/.test(by('수식값없음').err||'')&&/값으로 붙여넣기/.test(by('수식값없음').err||''),'17 계산값 없는 수식 칸은 막음 '+JSON.stringify(rr));
ok(by('수식값있음').amount===180000&&!by('수식값있음').err&&by('보통값').amount===9000&&!by('보통값').err,'17 계산값 있는 수식 칸은 읽음 '+JSON.stringify(rr));
ok(/수식이 든 칸이 있어요/.test(s.warn)&&/엑셀 2번째 줄/.test(s.warn)&&/수식이 든 칸이 있어요/.test(s.text),'17 수식 칸 경고(줄 번호) '+s.warn);
await p.click('#csvResult button[data-csv="clear"]').catch(()=>{});
await up('수동.xlsx',fx('<calcPr calcId="191029" calcMode="manual"/>',frow(2,'수동수식','<c r="E2"><f>20*9000</f><v>90000</v></c>')+frow(3,'수동보통','<c r="E3"><v>9000</v></c>')));
rr=await rowsOf();
ok(/수동 계산/.test(by('수동수식').err||'')&&!by('수동보통').err,'17 수동 계산 파일의 수식 칸은 막음(일반 칸은 그대로) '+JSON.stringify(rr));
ok(dialogs===0,'전 과정 기본 팝업 0회');
ok(errs.length===0,'페이지 오류 0 '+errs.join('|'));
console.log(`xlsx: ${pass} pass, ${fail} fail`);await b.close();fs.rmSync(tmp,{recursive:true,force:true});process.exit(fail?1:0);
