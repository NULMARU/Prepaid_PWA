// 담당자 웹: 급량개수 × 1식 단가 계산(3단계) + 보내기 완료 안내·재전송 잠금(5단계) (2026-11 서무 현장 의견)
// 사용: node harness/agency-sent.e2e.mjs [agency-web/index.html]  — 외부 요청은 전부 막고 /api/submit만 목으로 받는다.
import { chromium } from 'playwright';
import fs from 'fs';
import crypto from 'crypto';
const SPKI=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'}).toString('base64');
const src=fs.readFileSync(process.argv[2]||new URL('../agency-web/index.html',import.meta.url),'utf8')
  .replace("const S={","const S=window.__S={")
  .replace("function validateAndRenderCsv(){","window.__v=()=>validateAndRenderCsv();window.__sv=n=>setView(n);function validateAndRenderCsv(){");
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++}else{fail++;console.log('FAIL',m)}};
const b=await chromium.launch();const p=await b.newPage();
let dialogs=0;p.on('dialog',d=>{dialogs++;d.dismiss()});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
let submits=0;
await p.route('**/*',r=>{const u=r.request().url();
  if(u==='https://t.test/')return r.fulfill({contentType:'text/html',body:src});
  if(/\/api\/public-key\?/.test(u))return r.fulfill({contentType:'application/json',body:JSON.stringify({public_key:SPKI})});
  if(/\/api\/submit$/.test(u)){submits++;return r.fulfill({contentType:'application/json',body:JSON.stringify({summary_id:'s'+submits})})}
  return r.fulfill({status:404,body:''});});
await p.goto('https://t.test/');
const R1='만계옥닭갈비',R2='가나다 김밥';
await p.evaluate(([R1,R2])=>{const S=window.__S;S.authed=true;S.agency={name:'광진구청'};S.dept='보건의료과';
  S.restaurants=[{name:R1,restaurant_id:'r1'},{name:R2,restaurant_id:'r2'}];
  // 열쇠 지문 확인은 이 하니스의 대상이 아니다 — 구서버(지문 기능 없음) 경로로 통과시킨다. 공개키는 목 서버가 준다.
  S.kcUnsupported=true;
  document.getElementById('csvCard').classList.remove('hide');window.__v();window.__sv(3);document.getElementById('modalRoot').innerHTML=''},[R1,R2]);
const H='음식점명,소속기관,부서명,직원명,급량개수,선금금액,입금자명,결제구분\n';
const up=async(name,txt)=>{await p.setInputFiles('#csv',{name,mimeType:'text/csv',buffer:Buffer.from('﻿'+txt)});await p.waitForTimeout(200)};
const st=()=>p.evaluate(()=>{const S=window.__S;return{fmt:S.csvFormat,valid:S.valid,
  rows:(S.rows||[]).map(r=>[r.name,r.amount,r.err].join('|')),text:document.getElementById('csvResult').innerText}});
// 1 1식 단가 칸: 처음 값 9,000
ok(await p.$eval('#unitPrice',e=>e.value)==='9,000','1 단가 기본값');
// 2 급량개수만 적으면 개수 × 단가, 금액만 적은 줄은 그대로, '10식'·'5개'도 허용, 표에 계산식
await up('a.csv',H+`${R1},광진구청,보건의료과,김진표,10,,보건의료과,제로페이\n${R1},광진구청,보건의료과,배유정,5개,,,\n${R2},광진구청,보건의료과,홍길동,,27000,,카드\n${R2},광진구청,보건의료과,이몽룡,3식,27000,,\n`);
let s=await st();
ok(s.fmt==='meal'&&s.valid,'2 급량 양식 인식 '+JSON.stringify(s));
ok(s.rows.join('/')==='김진표|90000|/배유정|45000|/홍길동|27000|/이몽룡|27000|','2 계산 '+JSON.stringify(s.rows));
ok(/10식 × 9,000/.test(s.text),'2 계산식 표시');
// 3 단가를 바꾸면 이미 올린 명단도 다시 계산 — 금액과 개수를 함께 적은 줄이 안 맞으면 막는다
await p.fill('#unitPrice','8000');await p.waitForTimeout(100);s=await st();
ok(s.rows[0]==='김진표|80000|'&&/급량개수 × 1식 단가와 달라요/.test(s.rows[3])&&!s.valid,'3 단가 변경·불일치 '+JSON.stringify(s.rows));
ok(await p.evaluate(()=>localStorage.getItem('agency-unit-price'))==='8000','3 단가 기억');
// 4 단가를 비우면 급량개수 줄은 진행 불가(금액만 적은 줄은 그대로)
await p.fill('#unitPrice','');await p.waitForTimeout(100);s=await st();
ok(/1식 단가/.test(s.rows[0])&&s.rows[2]==='홍길동|27000|'&&!s.valid,'4 단가 비움 '+JSON.stringify(s.rows));
// 5 잘못된 급량개수·둘 다 빈 줄
await p.fill('#unitPrice','9000');
await p.click('#csvResult button[data-csv="clear"]');
await up('b.csv',H+`${R1},광진구청,보건의료과,김진표,열개,,,\n${R1},광진구청,보건의료과,배유정,,,보건의료과,\n`);s=await st();
ok(/급량개수는 숫자만/.test(s.rows[0])&&/급량개수 또는 선금금액/.test(s.rows[1]),'5 오류 문구 '+JSON.stringify(s.rows));
// 6 정상 명단으로 바로 보내기 → 완료 창 + 버튼 잠금
await p.click('#csvResult button[data-csv="clear"]');
await up('c.csv',H+`${R1},광진구청,보건의료과,김진표,10,,보건의료과,제로페이\n${R2},광진구청,보건의료과,홍길동,3,,,\n`);
await p.click('.mode-card[data-mode="relay"]');
const send=async()=>{await p.click('#submitBtn');await p.check('#agree');await p.click('#okC');await p.waitForSelector('#sentTitle',{timeout:20000}).catch(async e=>{console.log('DBG',await p.$eval('#log',x=>x.textContent),await p.$eval('#sendResult',x=>x.innerText),submits);throw e})};
await send();
ok(submits===2,'6 2건 전송 '+submits);
const modal=await p.$eval('.modal',e=>e.innerText);
ok(/보내기 완료/.test(modal)&&/이제 이 창을 닫으셔도 됩니다/.test(modal)&&/음식점 2곳/.test(modal),'6 완료 창 '+modal);
await p.click('#sentOk');
ok(!(await p.$('#sentTitle')),'6 확인으로 닫힘');
const btn=()=>p.$eval('#submitBtn',e=>({d:e.disabled,t:e.textContent}));
let bt=await btn();
ok(bt.d&&/보내기 완료/.test(bt.t),'6 전송 버튼 잠김 '+JSON.stringify(bt));
ok(/이 창을 닫으셔도 됩니다/.test(await p.$eval('#sentDone',e=>e.innerText)),'6 결과 상자 문구');
ok(await p.$eval('#logWrap',e=>!e.open),'6 전송 기록은 접혀 있음');
// 7 방법 카드를 다시 눌러도 잠금·완료 안내 유지
await p.click('.mode-card[data-mode="direct"]');await p.click('.mode-card[data-mode="relay"]');
bt=await btn();
ok(bt.d&&!!(await p.$('#sentDone')),'7 카드 눌러도 유지 '+JSON.stringify(bt));
// 8 [그래도 다시 보내기]를 거쳐야만 다시 보낼 수 있다
ok(await p.$eval('#resendBox',e=>e.classList.contains('hide')),'8 재전송 안내는 처음엔 접힘');
await p.click('#resendToggle');await p.click('#resendGo');
bt=await btn();
ok(!bt.d&&/바로 보내기/.test(bt.t),'8 잠금 해제 '+JSON.stringify(bt));
await send();await p.click('#sentOk');
ok(submits===4&&(await btn()).d,'8 재전송 후 다시 잠김 '+submits);
// 9 명단을 바꾸면(새 파일) 잠금이 저절로 풀린다
await p.evaluate(()=>window.__sv(3));
await p.setInputFiles('#csv',{name:'d.csv',mimeType:'text/csv',buffer:Buffer.from('﻿'+H+`${R1},광진구청,보건의료과,김진표,11,,,\n${R2},광진구청,보건의료과,홍길동,3,,,\n`)});
await p.waitForTimeout(200);await p.click('#csvResult button[data-csv="replace"]');await p.waitForTimeout(100);
await p.click('.mode-card[data-mode="relay"]');
bt=await btn();
ok(!bt.d,'9 새 명단이면 다시 보낼 수 있음 '+JSON.stringify(bt));
ok(dialogs===0,'전 과정 기본 팝업 0회');
ok(errs.length===0,'페이지 오류 0 '+errs.join('|'));
console.log(`sent: ${pass} pass, ${fail} fail`);await b.close();process.exit(fail?1:0);
