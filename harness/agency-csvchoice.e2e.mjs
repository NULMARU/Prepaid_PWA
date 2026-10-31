// 담당자 웹 3단계: 명단 파일 바꾸기/덧붙이기·되돌리기·비우기 (2026-10-31 현장 보고)
// 사용: node harness/agency-csvchoice.e2e.mjs [agency-web/index.html]  — 외부 요청은 전부 404로 막는다.
import { chromium } from 'playwright';
import fs from 'fs';
const src=fs.readFileSync(process.argv[2]||new URL('../agency-web/index.html',import.meta.url),'utf8')
  .replace("const S={","const S=window.__S={")
  .replace("function validateAndRenderCsv(){","window.__v=()=>validateAndRenderCsv();window.__sv=n=>setView(n);function validateAndRenderCsv(){");
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++}else{fail++;console.log('FAIL',m)}};
const H='음식점명,소속,부서명,직원명,선금금액,입금자명\n';
const R='육회바른연어 구의역점';
const A=H+`${R},광진구청,위생과,김진표,72000,배유정\n${R},광진구청,위생과,배유정,27000,배유정\n`;
const B=H+`${R},광진구청,위생과,김진표,70000,배유정\n${R},광진구청,위생과,배유정,25000,배유정\n`;
const C=H+`${R},광진구청,위생과,홍길동,10000,배유정\n`;
const BAD='엉뚱한,헤더\n1,2\n';
const b=await chromium.launch();const p=await b.newPage();
let dialogs=0;p.on('dialog',d=>{dialogs++;d.dismiss()});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.route('**/*',r=>{const u=r.request().url();
  if(u==='http://t.test/')return r.fulfill({contentType:'text/html',body:src});
  return r.fulfill({status:404,body:''});});
await p.goto('http://t.test/');
await p.evaluate(R=>{const S=window.__S;S.authed=true;S.agency={name:'광진구청'};S.dept='위생과';
  S.restaurants=[{name:R,restaurant_id:'r1'}];document.getElementById('csvCard').classList.remove('hide');window.__v();window.__sv(3);document.getElementById('modalRoot').innerHTML=''},R);
const up=async(name,txt)=>{await p.setInputFiles('#csv',{name,mimeType:'text/csv',buffer:Buffer.from(txt)});await p.waitForTimeout(150)};
const st=()=>p.evaluate(()=>{const S=window.__S;return{n:S.rawRows?S.rawRows.length:null,valid:S.valid,pending:!!S.pendingCsv,
  pendName:S.pendingCsv&&S.pendingCsv.fileName,amts:(S.rawRows||[]).map(r=>r.amount).join(','),
  choice:!!document.getElementById('csvChoice'),trs:document.querySelectorAll('#csvResult tbody tr').length,
  btns:[...document.querySelectorAll('#csvResult button[data-csv]')].map(x=>x.dataset.csv+':'+x.textContent),
  text:document.getElementById('csvResult').innerText}});
const click=async a=>{await p.click(`#csvResult button[data-csv="${a}"]`);await p.waitForTimeout(100)};
// 1 첫 업로드
await up('명단.csv',A);let s=await st();
ok(s.n===2&&!s.choice&&s.valid,'1 첫 업로드 2행·선택상자 없음·valid '+JSON.stringify(s));
ok(s.btns.join()==='clear:올린 명단 비우기','1 비우기 버튼 '+s.btns);
// 2 같은 이름 고친 파일 → 선택 상자, 기본 팝업 0
await up('명단.csv',B);s=await st();
ok(dialogs===0,'2 기본 팝업 0회 (실제 '+dialogs+')');
ok(s.choice&&s.pending&&!s.valid&&s.n===2&&s.amts==='72000,27000','2 선택 상자·고르기 전 진행 불가·표는 이전 명단 '+JSON.stringify(s));
ok(s.btns.join()==='replace:이 파일로 바꾸기,append:기존 명단에 덧붙이기','2 버튼 이름·순서 '+s.btns);
ok(await p.$eval('#csvResult button[data-csv="replace"]',e=>e.classList.contains('btn-primary'))&&
   !(await p.$eval('#csvResult button[data-csv="append"]',e=>e.classList.contains('btn-primary'))),'2 진한 버튼은 바꾸기 하나');
ok(/먼저 올린 2행은 지워집니다/.test(s.text)&&/먼저 올린 2행은 그대로 둡니다/.test(s.text),'2 버튼 옆 결과 설명');
// 3 바꾸기
await click('replace');s=await st();
ok(s.n===2&&s.amts==='70000,25000'&&!s.choice&&s.valid&&s.trs===2,'3 바꾸기 → 고친 2행·valid '+JSON.stringify(s));
// 4 덧붙이기 → 중복 → 되돌리기
await up('명단.csv',A);await click('append');s=await st();
ok(s.n===4&&!s.valid&&s.btns.includes('undo-append:방금 올린 파일로 바꾸기'),'4 덧붙이기 4행·중복으로 진행 불가·되돌리기 버튼 '+JSON.stringify(s));
ok(/덧붙였어요/.test(s.text),'4 덧붙임 안내');
await click('undo-append');s=await st();
ok(s.n===2&&s.amts==='72000,27000'&&s.valid&&!s.btns.some(x=>x.startsWith('undo')),'4 되돌리기 → 방금 올린 파일만 '+JSON.stringify(s));
// 5 정상 덧붙이기(빠뜨린 직원) → 되돌리기 버튼 없음
await up('추가.csv',C);await click('append');s=await st();
ok(s.n===3&&s.valid&&!s.btns.some(x=>x.startsWith('undo')),'5 정상 덧붙이기 3행·valid·되돌리기 없음 '+JSON.stringify(s));
// 6 고르는 중 다른 파일 → 최신 파일로 대체
await up('첫번째.csv',B);await up('두번째.csv',C);s=await st();
ok(s.pending&&s.pendName==='두번째.csv'&&s.n===3,'6 대기 파일은 마지막으로 고른 것 '+JSON.stringify(s));
await click('replace');s=await st();
ok(s.n===1&&s.valid,'6 바꾸기 → 1행 '+JSON.stringify(s));
// 7 깨진 파일 → 기존 유지, 선택 상자 없음
await up('깨짐.csv',BAD);s=await st();
ok(s.n===1&&!s.choice&&/반영되지 않았어요/.test(s.text),'7 깨진 파일은 기존 유지 '+JSON.stringify(s));
// 8 비우기
await click('clear');s=await st();
ok(s.n===null&&!s.valid&&s.btns.length===0&&s.trs===0,'8 비우기 '+JSON.stringify(s));
await up('명단.csv',A);s=await st();
ok(s.n===2&&!s.choice,'8 비운 뒤 업로드는 선택 없이 바로 '+JSON.stringify(s));
ok(dialogs===0,'전 과정 기본 팝업 0회');
ok(errs.length===0,'페이지 오류 0 '+errs.join('|'));
console.log(`csvchoice: ${pass} pass, ${fail} fail`);await b.close();process.exit(fail?1:0);
