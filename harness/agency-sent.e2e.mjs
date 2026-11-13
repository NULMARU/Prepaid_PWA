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
// ════ beta.55 (D-1 전송 중 인증 만료 · D-6 보낸 기록 보존·일부 실패 · D-8 전송 오류·크기·mailto) ════
// 아래 단언은 전부 수정 전 코드에서 실패한다. 페이지마다 목 서버 동작(m)을 바꿔 가며 쓴다.
const FP=(()=>{const h=crypto.createHash('sha256').update(Buffer.from(SPKI,'base64')).digest('hex').slice(0,8).toUpperCase();return h.slice(0,4)+'-'+h.slice(4)})();
const RIDS=['r1','r2','r3'],NAMES={r1:R1,r2:R2,r3:'다라마 국밥'};
async function mkPage(m){
  const ctx=await b.newContext();const q=await ctx.newPage();
  q.on('dialog',d=>{dialogs++;d.dismiss()});q.on('pageerror',e=>errs.push(e.message));
  await q.addInitScript(()=>{try{localStorage.setItem('bapjangbu_terms_agreed','1')}catch(e){}});
  m.subs=[];
  await q.route('**/*',async r=>{const u=r.request().url();
    if(u==='https://t.test/')return r.fulfill({contentType:'text/html',body:src});
    if(/\/api\/public-key\?/.test(u))return r.fulfill({contentType:'application/json',body:JSON.stringify({public_key:SPKI,contact:m.contact||null})});
    if(/\/api\/agency\/keychecks\?/.test(u))return r.fulfill({contentType:'application/json',body:JSON.stringify({keychecks:RIDS.map(id=>({restaurant_id:id,fingerprint:FP,checked_at:1}))})});
    if(/\/api\/agency\/request-otp$/.test(u))return r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,sent:true})});
    if(/\/api\/agency\/verify-otp$/.test(u))return r.fulfill({contentType:'application/json',body:JSON.stringify({token:'T2'})});
    if(/\/api\/submit$/.test(u)){
      const body=JSON.parse(r.request().postData()),tok=r.request().headers()['x-agency-token']||'';
      const rec={rid:body.summary.restaurant_id,sid:body.summary.submission_id,ym:body.summary.year_month,tok};m.subs.push(rec);
      if(m.hold)await m.hold;
      const res=m.submit?m.submit(rec,m.subs.length):null;
      return r.fulfill({status:(res&&res.status)||200,contentType:'application/json',body:JSON.stringify((res&&res.json)||{summary_id:'s'+m.subs.length})});
    }
    return r.fulfill({status:404,body:''});});
  await q.goto('https://t.test/');
  return q;
}
async function setup(q,rids,kc){
  await q.evaluate(([rids,NAMES,FP,kc])=>{const S=window.__S;S.authed=true;S.token='T1';S.otpMode='server';S.email='a@gwangjin.go.kr';
    S.agency={name:'광진구청',sido:'서울특별시',id:2};S.dept='보건의료과';
    S.restaurants=rids.map(id=>({name:NAMES[id],restaurant_id:id}));
    if(kc){S.kcUnsupported=false;S.fps=new Map(rids.map(id=>[id,FP]));S.keychecks=new Map(rids.map(id=>[id,{fingerprint:FP,checked_at:1}]))}else S.kcUnsupported=true;
    document.getElementById('csvCard').classList.remove('hide');document.getElementById('logoutBtn').classList.remove('hide');
    window.__v();window.__sv(3);document.getElementById('modalRoot').innerHTML=''},[rids,NAMES,FP,kc]);
}
const rosterOf=(rids,amt)=>H+rids.map((id,i)=>`${NAMES[id]},광진구청,보건의료과,직원${i+1},,${(amt&&amt[id])||9000*(i+1)},,카드`).join('\n')+'\n';
const closeModal=q=>q.evaluate(()=>{const c=document.querySelector('#modalRoot #sentOk');if(c)c.click()});
const upq=async(q,txt)=>{await closeModal(q);await q.setInputFiles('#csv',{name:'m.csv',mimeType:'text/csv',buffer:Buffer.from('﻿'+txt)});await q.waitForTimeout(250);
  if(await q.$('#csvResult button[data-csv="replace"]')){await q.click('#csvResult button[data-csv="replace"]');await q.waitForTimeout(100)}};
const sendq=async q=>{await q.click('.mode-card[data-mode="relay"]');await q.click('#submitBtn');await q.check('#agree');await q.click('#okC')};
const settle=async(q,n,ms=15000)=>{const t=Date.now();while(Date.now()-t<ms){if(await q.evaluate(()=>!document.getElementById('sendProgress').classList.contains('hide')))await q.waitForTimeout(100);else{await q.waitForTimeout(150);return}}};
const vis=(q,id)=>q.$eval('#'+id,e=>!e.classList.contains('hide')&&e.offsetParent!==null).catch(()=>false);
const resultText=q=>q.$eval('#sendResult',e=>e.innerText).catch(()=>'');
const btnq=q=>q.$eval('#submitBtn',e=>({d:e.disabled,t:e.textContent}));
const safe=async(f,label)=>{try{return await f()}catch(e){console.log('  ('+label+' 진행 불가: '+String(e.message).split('\n')[0]+')');return null}};
// ── D-1: 전송 중 인증 만료(401) ──
{
  const m={submit:(rec,n)=>rec.rid==='r2'&&rec.tok==='T1'?{status:401,json:{error:'agency_auth_required'}}:null};
  const q=await mkPage(m);await setup(q,RIDS,true);await upq(q,rosterOf(RIDS));
  await sendq(q);await settle(q);await q.waitForTimeout(200);
  const rt=await q.evaluate(()=>[...document.querySelectorAll('#sendResult tbody tr')].map(t=>t.innerText).join('\n'));
  ok(m.subs.length===2&&(rt.match(/인증 만료로 보내지 않음/g)||[]).length===2&&!/달라요/.test(rt),'D1-1 401에서 즉시 멈춤·남은 건은 "인증 만료로 보내지 않음"(지문 오류 아님) '+m.subs.length+' '+JSON.stringify(rt));
  const am=await q.$eval('#authMsg',e=>e.innerText);
  ok(await vis(q,'view-1')&&!(await vis(q,'view-3'))&&/인증이 만료/.test(am)&&/보내지 못한 2건/.test(am),'D1-2 1단계 화면으로 이동·안내 '+am);
  ok(!(await q.$('#retryFailBtn'))&&!!(await q.$('#reauthBtn')),'D1-3 인증 없이는 [다시 보내기] 버튼 없음(대신 [다시 인증하기])');
  const sid2=(m.subs.find(x=>x.rid==='r2')||{}).sid,ym2=(m.subs.find(x=>x.rid==='r2')||{}).ym;
  const okRe=await safe(async()=>{
    await q.fill('#email','a@gwangjin.go.kr',{timeout:3000});await q.click('#authBtn',{timeout:3000});await q.waitForSelector('#authStep2:not(.hide)',{timeout:3000});
    await q.fill('#otp','123456');await q.click('#otpBtn');await q.waitForSelector('#retryFailBtn',{state:'visible',timeout:5000});
    await q.click('#retryFailBtn');await settle(q);return true},'다시 인증 후 재시도');
  const after=m.subs.slice(2);
  const rt2=await resultText(q);
  ok(okRe&&after.length===2&&after.every(x=>x.tok==='T2')&&(after.find(x=>x.rid==='r2')||{}).sid===sid2&&(after.find(x=>x.rid==='r2')||{}).ym===ym2&&!/달라요|인증 만료로/.test(rt2)&&/모두 보냈습니다/.test(rt2),
    'D1-4 다시 인증 → 같은 접수번호·연월로 남은 2건만 이어 보냄 '+JSON.stringify(after)+' '+rt2.slice(0,120));
  await q.context().close();
}
// ── D-6: 일부 실패 문구 · 탭 저장소 보존 · 새로 고침 · 월 경계 · 수정 재전송 · 로그아웃 ──
{
  let fail2=true;
  const m={submit:rec=>rec.rid==='r2'&&fail2?{status:409,json:{error:'deregistered'}}:null};
  const q=await mkPage(m);
  await q.clock.setFixedTime(new Date('2026-11-30T23:59:00+09:00'));
  await setup(q,['r1','r2'],false);await upq(q,rosterOf(['r1','r2']));
  await sendq(q);await settle(q);
  let bt=await btnq(q);const rt=await resultText(q);
  ok(bt.d&&/일부 실패/.test(bt.t)&&!/보내기 완료/.test(bt.t)&&/등록이 해제돼 있어/.test(rt)&&!(await q.$('#sentTitle')),'D6-1 일부 실패 문구(버튼·사유) '+JSON.stringify(bt)+' '+rt.slice(0,160));
  const raw=await q.evaluate(()=>sessionStorage.getItem('agency-sent-v1'));
  ok(!!raw&&!/직원|보건의료과|광진구청|9000|18000/.test(raw)&&(raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-4/g)||[]).length>=2,'D6-2 탭 저장소에 접수번호만(이름·금액·부서 원문 없음) '+raw);
  const sid2=(m.subs.find(x=>x.rid==='r2')||{}).sid;
  // 새로 고침 → 같은 명단을 다시 올리면 보낸 결과가 되살아나고, 실패 건만 같은 접수번호·첫 시도 연월(11월)로 다시 보냄(이제 12월)
  await q.clock.setFixedTime(new Date('2026-12-01T00:05:00+09:00'));
  await q.reload();await setup(q,['r1','r2'],false);await upq(q,rosterOf(['r1','r2']));
  bt=await btnq(q);const rt3=await resultText(q);
  ok(bt.d&&/일부 실패/.test(bt.t)&&/새로 고침 전 기록/.test(rt3)&&!!(await q.$('#retryFailBtn')),'D6-3 새로 고침 뒤 같은 명단: 잠금·결과표·재시도 버튼 복원 '+JSON.stringify(bt)+' '+rt3.slice(0,120));
  fail2=false;const n0=m.subs.length;
  await safe(async()=>{await q.click('#retryFailBtn',{timeout:3000});await settle(q)},'재시도');
  const re=m.subs.slice(n0);
  ok(re.length===1&&re[0].rid==='r2'&&re[0].sid===sid2&&re[0].ym==='2026-11','D6-4 재시도는 같은 접수번호·첫 시도 연월 '+JSON.stringify(re));
  // 일부만 고친 명단(r2 금액만 바뀜)을 다시 보내면 이미 보낸 r1에는 다시 가지 않는다
  const n1=m.subs.length;
  await upq(q,rosterOf(['r1','r2'],{r2:27000}));await sendq(q).catch(()=>{});await settle(q);
  const re2=m.subs.slice(n1);
  ok(re2.length===1&&re2[0].rid==='r2'&&/앞서 보냄/.test(await resultText(q)),'D6-5 고친 명단 재전송은 바뀐 가게만 '+JSON.stringify(re2));
  // 로그아웃하면 보낸 기록·잠금도 지워져, 다시 인증해 같은 명단을 올려도 막다른 길(잠긴 버튼만)이 되지 않는다
  await closeModal(q);
  await q.click('#logoutBtn');
  const gone=await q.evaluate(()=>sessionStorage.getItem('agency-sent-v1'));
  await setup(q,['r1','r2'],false);await upq(q,rosterOf(['r1','r2'],{r2:27000}));await q.click('.mode-card[data-mode="relay"]');
  bt=await btnq(q);
  ok(gone===null&&!bt.d&&/바로 보내기/.test(bt.t),'D6-6 로그아웃 후 같은 명단은 다시 보낼 수 있음 '+JSON.stringify({gone,bt}));
  // 보내는 중 창 닫기·새로 고침 경고
  let release;m.hold=new Promise(r=>release=r);
  await q.evaluate(()=>{const S=window.__S;S.rows[0].amount+=1}).catch(()=>{});
  await upq(q,rosterOf(['r1','r2'],{r1:1000,r2:2000}));await sendq(q).catch(()=>{});await q.waitForTimeout(400);
  const prevented=await q.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented});
  release();m.hold=null;await settle(q);
  ok(prevented,'D6-7 보내는 중에는 창 닫기 경고');
  await q.context().close();
}
// ── D-8: 전송 오류 문구 · 크기 상한 미리 막기 · mailto 주입 ──
{
  const m={submit:rec=>rec.rid==='r2'?{status:429,json:{error:'too_many_pending',max:30}}:null};
  const q=await mkPage(m);await setup(q,['r1','r2'],false);await upq(q,rosterOf(['r1','r2']));
  const t0=Date.now();await sendq(q);await settle(q,30000);
  const rt=await resultText(q);
  ok(m.subs.filter(x=>x.rid==='r2').length===1&&/받지 않은 명단이 30건 쌓여/.test(rt)&&Date.now()-t0<8000,'D8-1 too_many_pending은 다시 시도하지 않고 바로 이유 안내 '+m.subs.length+' '+rt.slice(0,160));
  await q.context().close();
}
{
  const m={};const q=await mkPage(m);await setup(q,['r1'],false);
  const big=H+Array.from({length:2200},(_,i)=>`${R1},광진구청,보건의료과,직원${String(i).padStart(4,'0')}가나다라마바사,,9000,입금자홍길동,카드`).join('\n')+'\n';
  await upq(q,big);await q.waitForTimeout(300);
  const warn=await q.$eval('#tooBigWarn',e=>e.innerText).catch(()=>'');
  await sendq(q);await settle(q,30000);
  const rt=await resultText(q);
  ok(/너무 커서/.test(warn)&&m.subs.length===0&&/너무 커서/.test(rt),'D8-2 200KB 넘는 명단은 4단계에서 알리고 서버로 보내지 않음 '+m.subs.length+' '+warn.slice(0,60));
  await q.context().close();
}
{
  const m={contact:{email:'boss@shop.kr?body=%EB%AA%85%EB%8B%A8%EC%97%86%EC%9D%8C',kakao_link:''}};const q=await mkPage(m);await setup(q,['r1'],false);
  await upq(q,rosterOf(['r1']));await q.click('.mode-card[data-mode="direct"]');await q.click('#submitBtn');await q.check('#agree');await q.click('#okC');
  await q.waitForSelector('.group-card',{timeout:10000});
  ok(!(await q.$('.group-card a[data-act="mail"]')),'D8-3 ?·& 가 든 이메일은 mailto 링크로 만들지 않음');
  await q.context().close();
}
ok(dialogs===0,'전 과정 기본 팝업 0회');
ok(errs.length===0,'페이지 오류 0 '+errs.join('|'));
console.log(`sent: ${pass} pass, ${fail} fail`);await b.close();process.exit(fail?1:0);
