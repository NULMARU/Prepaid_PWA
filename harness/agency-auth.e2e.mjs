// 담당자 웹 beta.61 — (가) 인증 90일 기억·로그아웃(계약서 4절) · (나) 가게 색인으로 이름 검색(계약서 3절)
// 사용: node harness/agency-auth.e2e.mjs [agency-web/index.html]
// 외부 요청은 전부 막는다: 페이지·기관 목록·/api/**·storeidx/**는 목으로만 받는다(라이브 중계 서버·app.bapjangbu.com에 가지 않음).
// 색인은 '있음'(목 meta·구 파일)과 '없음'(404·형식 다름·파일 404) 두 조건으로 돈다.
import { chromium } from 'playwright';
import fs from 'fs';
const src=fs.readFileSync(process.argv[2]||new URL('../agency-web/index.html',import.meta.url),'utf8')
  .replace("const S={","const S=window.__S={")
  .replace("function validateAndRenderCsv(){","window.__v=()=>validateAndRenderCsv();window.__sv=n=>setView(n);function validateAndRenderCsv(){")
  .replace("let sending=false;","let sending=false;window.__setSending=v=>{sending=v;paintEditLock()};");
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++}else{fail++;console.log('FAIL',m)}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const DAY=24*60*60*1000;
const EMAIL='a@gwangjin.go.kr';
const INDEX={regions:[
  {name:'서울특별시',agencies:[{id:'seoul',name:'서울특별시청'},{id:'gwangjin',name:'광진구청'},{id:'jung',name:'중구청'}]},
  {name:'경기도',agencies:[{id:'gg',name:'경기도청'},{id:'goyang',name:'고양시청'},{id:'guri',name:'구리시청'}]},
  {name:'세종특별자치시',agencies:[{id:'sejong',name:'세종특별자치시청'}]},
  {name:'광주광역시',agencies:[{id:'gwangju',name:'광주광역시청'},{id:'gj-nam',name:'남구청'}]}]};
const R_YUK='3040000-101-2017-00034';
const FILES={
  'seoul/05.json':{v:1,rows:[
    ['R-MAN','만계옥닭갈비','서울특별시 광진구 아차산로 2','서울특별시 광진구 화양동 2','05000'],
    [R_YUK,'육회바른연어 구의역점','서울특별시 광진구 자양로 1 (구의동)','서울특별시 광진구 구의동 1-1','05021'],
    ['R-YUK2','육회(지존)','서울특별시 광진구 능동로 3','서울특별시 광진구 군자동 3','05001']]},
  'seoul/23.json':{v:1,rows:[['R-JUNG','중구김밥','서울특별시 중구 세종대로 1','서울특별시 중구 태평로1가 1','04500']]},
  'gyeonggi/01.json':{v:1,rows:[['G1','고양국밥 덕양점','경기도 고양시 덕양구 1','경기도 고양시 덕양구 행신동 1','10500']]},
  'gyeonggi/02.json':{v:1,rows:[['G2','고양국밥 일산점','경기도 고양시 일산동구 2','경기도 고양시 일산동구 장항동 2','10400']]},
  'gyeonggi/03.json':{v:1,rows:[['G3','고양국밥 서구점','경기도 고양시 일산서구 3','경기도 고양시 일산서구 대화동 3','10300']]},
  'sejong/00.json':{v:1,rows:[['S1','세종한식','세종특별자치시 한누리대로 1','세종특별자치시 나성동 1','30100']]},
  'jeonnam-gwangju/05.json':{v:1,rows:[['J1','남구떡갈비','광주광역시 남구 봉선로 1','광주광역시 남구 봉선동 1','61600']]}};
const META={v:1,built:'2026-11-22',total:9,regions:{
  '서울특별시':{'광진구':{f:'seoul/05.json',n:3},'중구':{f:'seoul/23.json',n:1}},
  '경기도':{'고양시 덕양구':{f:'gyeonggi/01.json',n:1},'고양시 일산동구':{f:'gyeonggi/02.json',n:1},'고양시 일산서구':{f:'gyeonggi/03.json',n:1}},
  '세종특별자치시':{'세종특별자치시':{f:'sejong/00.json',n:1}},
  '전남광주통합특별시':{'남구':{f:'jeonnam-gwangju/05.json',n:1}}}};
const NOT_REG=new Set(['R-YUK2']); // 밥장부에 등록 안 된 가게(결과에 안 보여야 한다)
const b=await chromium.launch();
let dialogs=0;const errsAll=[];
// m: 목 동작. m.idx: 'on'(기본)|'off'(meta 404)|'bad'(meta v:2)|'file404'. m.logout: 'ok'|'404'|'abort'. m[key]=함수로 덮어쓰기.
async function mkPage(m,init,ctx){
  ctx=ctx||await b.newContext();const p=await ctx.newPage();
  p.on('dialog',d=>{dialogs++;d.dismiss()});
  const errs=[];p.on('pageerror',e=>{errs.push(e.message);errsAll.push(e.message)});p.errs=errs;
  if(init!==false)await p.addInitScript(init||(()=>{try{localStorage.setItem('bapjangbu_terms_agreed','1')}catch(e){}}));
  m.calls=m.calls||[];
  await ctx.route('**/*',async r=>{const req=r.request(),u=req.url();
    if(u==='https://t.test/')return r.fulfill({contentType:'text/html',body:src});
    if(u.endsWith('/agency-index.json'))return r.fulfill({contentType:'application/json',body:JSON.stringify(INDEX)});
    const sm=u.match(/^https:\/\/app\.bapjangbu\.com\/storeidx\/(.+)$/);
    if(sm){m.calls.push({key:'storeidx',path:sm[1],u});
      const mode=m.idx||'on';
      if(mode==='off')return r.fulfill({status:404,body:''});
      if(sm[1]==='meta.json')return r.fulfill({contentType:'application/json',body:JSON.stringify(mode==='bad'?{...META,v:2}:META)});
      if(mode==='file404'||!FILES[sm[1]])return r.fulfill({status:404,body:''});
      return r.fulfill({contentType:'application/json',body:JSON.stringify(FILES[sm[1]])});}
    const key=(u.match(/\/api\/[a-z\-\/]+/)||[''])[0];
    if(!key)return r.fulfill({status:404,body:''});
    m.calls.push({key,u,method:req.method(),tok:req.headers()['x-agency-token']||''});
    if(m[key]){const res=m[key](u,req);if(res&&res.delay)await sleep(res.delay);if(res&&res.abort)return r.abort('failed');
      if(res)return r.fulfill({status:res.status||200,contentType:'application/json',body:JSON.stringify(res.json==null?{}:res.json)})}
    if(key==='/api/agency/logout'){const md=m.logout||'ok';if(md==='abort')return r.abort('failed');if(md==='404')return r.fulfill({status:404,body:''});return r.fulfill({contentType:'application/json',body:'{"ok":true}'})}
    if(key==='/api/agency/request-otp')return r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,sent:true})});
    if(key==='/api/agency/verify-otp')return r.fulfill({contentType:'application/json',body:JSON.stringify({token:'TNEW'})});
    if(key==='/api/registered-list')return r.fulfill({contentType:'application/json',body:JSON.stringify({restaurants:[]})});
    if(key==='/api/agency/keychecks')return r.fulfill({contentType:'application/json',body:JSON.stringify({keychecks:[]})});
    if(key==='/api/registered'){const ids=decodeURIComponent((u.split('ids=')[1]||'')).split(',').filter(Boolean);
      return r.fulfill({contentType:'application/json',body:JSON.stringify(ids.filter(id=>!NOT_REG.has(id)))})}
    if(key==='/api/restaurants')return r.fulfill({contentType:'application/json',body:JSON.stringify(m.oldRows||[{restaurant_id:'OLD1',name:'예전방식가게',address:'서울특별시 광진구 어딘가 1',status:'영업/정상'}])});
    return r.fulfill({status:404,body:''});});
  if(m.clock)await p.clock.install();
  await p.goto('https://t.test/');
  return p;
}
const text=(p,sel)=>p.$eval(sel,e=>e.innerText).catch(()=>'');
const shown=(p,sel)=>p.$eval(sel,e=>!e.classList.contains('hide')&&!e.closest('.hide')&&e.offsetParent!==null).catch(()=>false);
const store=p=>p.evaluate(()=>{let l=null,s=null;try{l=localStorage.getItem('agency-token')}catch(e){l='(막힘)'}try{s=sessionStorage.getItem('agency-token')}catch(e){s='(막힘)'}return{l,s}});
const tokenInit=(rec,where)=>`(()=>{try{localStorage.setItem('bapjangbu_terms_agreed','1')}catch(e){}try{${where||'localStorage'}.setItem('agency-token',${JSON.stringify(JSON.stringify(rec))}.replace('"__NOW__"',String(Date.now()-(${rec.ago||0}))))}catch(e){}})()`;
const rec=(token,ago)=>({token,email:EMAIL,at:'__NOW__',ago});
async function authByOtp(p){
  await act(p.fill('#email',EMAIL,T));await act(p.click('#authBtn',T));await p.waitForSelector('#authStep2:not(.hide)',{timeout:3000}).catch(()=>{});
  await act(p.fill('#otp','123456',T));await act(p.click('#otpBtn',T));await p.waitForTimeout(300);
}
const T={timeout:3000};const act=pr=>pr.catch(e=>{console.log('  (동작 못 함: '+String(e.message).split('\n')[0]+')')});
const isAuthed=p=>p.evaluate(()=>!!(window.__S&&window.__S.authed));

// ════ (가) 인증 90일 ════
// A1 인증하면 localStorage에 기억 — 같은 브라우저의 새 탭(새 페이지)에서는 다시 묻지 않는다 + 상태 줄 문구
{
  const m={};const p=await mkPage(m);
  const note=await text(p,'#authKeepNote');
  ok(note==='한 번 인증하면 이 컴퓨터에서 90일 동안 다시 묻지 않아요. 자리를 옮기거나 함께 쓰는 컴퓨터라면 [로그아웃]을 눌러 주세요.','A1-0 인증 화면 안내 한 줄 '+JSON.stringify(note));
  await authByOtp(p);
  const st=await store(p);
  const saved=(()=>{try{return JSON.parse(st.l)}catch(e){return null}})();
  ok(saved&&saved.token==='TNEW'&&saved.email===EMAIL&&!st.s,'A1-1 토큰은 localStorage에(세션 아님) '+JSON.stringify(st));
  const bar=await text(p,'#authBar');
  ok(await shown(p,'#authBar')&&bar.replace(/\s+/g,' ').trim()===EMAIL+' 으로 인증됨 · 로그아웃','A1-2 상태 줄 "○○ 으로 인증됨 · [로그아웃]" '+JSON.stringify(bar));
  ok(/90일 동안 다시 인증하지 않아도/.test(await text(p,'#authMsg')),'A1-3 인증 직후 안내(90일) '+(await text(p,'#authMsg')));
  const q=await mkPage(m,null,p.context());
  const otpCalls=m.calls.filter(c=>c.key==='/api/agency/request-otp').length;
  ok(await isAuthed(q)&&!(await shown(q,'#authStep1'))&&await shown(q,'#authBar')&&otpCalls===1,'A1-4 새 탭에서 다시 묻지 않음 '+JSON.stringify({otpCalls}));
  ok(/90일/.test(await text(q,'#authMsg')),'A1-5 되살린 인증 안내도 90일 '+(await text(q,'#authMsg')));
  await p.context().close();
}
// A2 89일 넘은 값은 스스로 버린다(88일은 그대로)
{
  const m={};const p=await mkPage(m,tokenInit(rec('TOLD',89*DAY+60*60*1000)));
  const st=await store(p);
  ok(!(await isAuthed(p))&&await shown(p,'#authStep1')&&!(await shown(p,'#authBar'))&&st.l===null,'A2-1 89일 넘은 값 버림 '+JSON.stringify(st));
  await p.context().close();
  const m2={};const q=await mkPage(m2,tokenInit(rec('T88',88*DAY)));
  ok(await isAuthed(q)&&(await q.evaluate(()=>window.__S.token))==='T88','A2-2 88일 값은 이어 씀');
  await q.context().close();
}
// A3 30분(그리고 2시간) 넘게 가만히 있어도 풀리지 않는다
{
  const m={clock:true};const p=await mkPage(m,tokenInit(rec('T30',0)));
  await p.waitForTimeout(200);
  const pre=await isAuthed(p);
  await p.clock.runFor(31*60*1000);await p.waitForTimeout(150);
  const mid=await isAuthed(p);
  await p.clock.runFor(2*60*60*1000);await p.waitForTimeout(150);
  const st=await store(p);
  ok(pre&&mid&&await isAuthed(p)&&await shown(p,'#authBar')&&!!st.l&&!/30분/.test(await text(p,'#authMsg')),'A3 무조작 31분·2시간 뒤에도 인증 유지 '+JSON.stringify({pre,mid,st}));
  await p.context().close();
}
// A4 로그아웃: 서버 길(POST /api/agency/logout, X-Agency-Token)을 부르고 기기 값을 지운다 — 404(예전 서버)·끊김에도 지운다
for(const mode of ['ok','404','abort']){
  const m={logout:mode};const p=await mkPage(m,tokenInit(rec('TLO',0)));
  await p.waitForTimeout(150);
  const vis=await shown(p,'#logoutBtn');
  await p.click('#logoutBtn',T).catch(()=>{});await p.waitForTimeout(300);
  const lo=m.calls.filter(c=>c.key==='/api/agency/logout');
  const st=await store(p);
  const msg=await text(p,'#authMsg');
  ok(vis&&lo.length===1&&lo[0].method==='POST'&&lo[0].tok==='TLO','A4-'+mode+' 서버 로그아웃 길 호출 '+JSON.stringify(lo));
  ok(st.l===null&&st.s===null&&!(await isAuthed(p))&&!(await shown(p,'#authBar'))&&await shown(p,'#authStep1')&&/로그아웃했어요/.test(msg)&&p.errs.length===0,
    'A4-'+mode+' 기기 값 삭제·인증 화면 '+JSON.stringify({st,msg,errs:p.errs}));
  // 같은 브라우저의 새 탭도 다시 묻는다
  const q=await mkPage({},null,p.context());
  ok(!(await isAuthed(q))&&await shown(q,'#authStep1'),'A4-'+mode+' 로그아웃 뒤 새 탭은 인증 화면');
  await p.context().close();
}
// A4b 보내는 중 [로그아웃]: 기본 팝업 0회 · 화면 안 한 줄 · 인증 유지 · 전송이 끝나면 그 줄은 스스로 없어짐
{
  const m={};const p=await mkPage(m,tokenInit(rec('TSD',0),'sessionStorage')); // 수정 전 코드도 인증된 채로 시작하도록 세션에
  await p.waitForTimeout(150);
  const d0=dialogs;
  await p.evaluate(()=>window.__setSending&&window.__setSending(true));
  await p.click('#logoutBtn',T).catch(()=>{});await p.waitForTimeout(200);
  const w=await text(p,'#logoutWait');const vis=await shown(p,'#logoutWait');
  const st=await store(p);
  ok(dialogs===d0&&vis&&w==='전송이 끝난 뒤에 로그아웃해 주세요.'&&await isAuthed(p)&&/TSD/.test((st.l||'')+(st.s||''))&&m.calls.filter(c=>c.key==='/api/agency/logout').length===0,
    'A4b-1 보내는 중 로그아웃: 팝업 0·화면 안 문구·인증 유지 '+JSON.stringify({dialogs:dialogs-d0,vis,w,st}));
  await p.waitForTimeout(3500);
  ok(await shown(p,'#logoutWait'),'A4b-2 문구는 몇 초 뒤에도 남아 있음(전송 중)');
  await p.evaluate(()=>window.__setSending&&window.__setSending(false));await p.waitForTimeout(100);
  ok(!(await shown(p,'#logoutWait'))&&await isAuthed(p),'A4b-3 전송이 끝나면 문구가 스스로 없어짐');
  dialogs=d0; // 수정 전 코드의 팝업이 맨 끝 '전 과정 팝업 0' 단언에 겹쳐 세지지 않게(이 블록에서 이미 판정)
  await p.context().close();
}
// A5 서버가 401(만료·로그아웃됨)을 주면 인증 화면으로, 기기 값도 지운다
{
  const m={'/api/agency/keychecks':()=>({status:401,json:{error:'agency_auth_required'}})};
  const p=await mkPage(m,tokenInit(rec('T401',0)));
  await p.waitForSelector('#sidoSel option[value="서울특별시"]',{state:'attached'});
  await act(p.selectOption('#sidoSel','서울특별시',T));await act(p.selectOption('#agencySel','gwangjin',T));
  await act(p.fill('#deptInput','총무과',T));await act(p.dispatchEvent('#deptInput','change',null,T));await p.waitForTimeout(500);
  const st=await store(p);
  ok(!(await isAuthed(p))&&await shown(p,'#authStep1')&&!(await shown(p,'#authBar'))&&st.l===null&&/다시 받아/.test(await text(p,'#authMsg')),'A5 401 → 인증 화면·기기 값 삭제 '+JSON.stringify(st));
  await p.context().close();
}
// A6 저장소(localStorage)가 막힌 PC: 이 창(세션)에만 조용히 기억, 오류 없음 · 새로 고침해도(동의 뒤) 이어 씀
{
  const blocked=()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('denied','SecurityError')}})};
  const m={};const p=await mkPage(m,blocked);
  await p.check('#termsAgree',T).catch(()=>{});await p.click('#termsOk',T).catch(()=>{});await p.waitForTimeout(100);
  await authByOtp(p);
  const ss=await p.evaluate(()=>sessionStorage.getItem('agency-token'));
  const msg=await text(p,'#authMsg');
  ok(await isAuthed(p)&&/TNEW/.test(ss||'')&&/이 창을 닫기 전까지/.test(msg)&&p.errs.length===0,'A6-1 저장소 막힘 → 세션에 기억 '+JSON.stringify({ss,msg,errs:p.errs}));
  await p.reload();await p.waitForTimeout(200);
  await p.check('#termsAgree',T).catch(()=>{});await p.click('#termsOk',T).catch(()=>{});await p.waitForTimeout(150);
  ok(await isAuthed(p)&&p.errs.length===0&&m.calls.filter(c=>c.key==='/api/agency/request-otp').length===1,'A6-2 새로 고침 → 동의 뒤 같은 창 인증 이어 씀(인증번호 다시 안 보냄)');
  await p.context().close();
}
// A7 예전 판(sessionStorage)에 있던 값을 그대로 이어 쓰고 localStorage로 옮긴다
{
  const m={};const p=await mkPage(m,tokenInit(rec('TLEG',3*60*60*1000),'sessionStorage'));
  const st=await store(p);
  ok(await isAuthed(p)&&(await p.evaluate(()=>window.__S.token))==='TLEG'&&/TLEG/.test(st.l||'')&&!st.s,'A7-1 예전 세션 값 이어 쓰기·옮기기 '+JSON.stringify(st));
  const at=(()=>{try{return JSON.parse(st.l).at}catch(e){return 0}})();
  ok(Date.now()-at>2.9*60*60*1000,'A7-2 옮길 때 인증 시각은 그대로 '+at);
  const q=await mkPage({},null,p.context());
  ok(await isAuthed(q),'A7-3 옮긴 뒤 새 탭에서도 인증 유지');
  await p.context().close();
}
// A8 명단 내용은 localStorage에 두지 않는다
{
  const m={'/api/registered-list':()=>({json:{restaurants:[{restaurant_id:'R-MAN',restaurant_name:'만계옥닭갈비',district:'광진구'}]}})};
  const p=await mkPage(m,tokenInit(rec('TL8',0)));
  await p.waitForSelector('#sidoSel option[value="서울특별시"]',{state:'attached'});
  await act(p.selectOption('#sidoSel','서울특별시',T));await act(p.selectOption('#agencySel','gwangjin',T));
  await p.waitForSelector('#jurisList input[data-a="chk"]',{timeout:3000}).catch(()=>{});await p.check('#jurisList input[data-a="chk"]',T).catch(()=>{});
  await act(p.setInputFiles('#csv',{name:'a.csv',mimeType:'text/csv',buffer:Buffer.from('﻿음식점명,소속,부서명,직원명,선금금액,입금자명\n만계옥닭갈비,광진구청,총무과,홍길동비밀,9000,\n')},T));await p.waitForTimeout(300);
  const dump=await p.evaluate(()=>{const o={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);o[k]=localStorage.getItem(k)}return JSON.stringify(o)});
  const rows=await p.evaluate(()=>(window.__S.rawRows||[]).length);
  ok(rows===1&&!/홍길동비밀/.test(dump)&&/agency-token/.test(dump),'A8 localStorage에 직원명 없음(토큰만) '+dump.slice(0,200));
  await p.context().close();
}

// ════ (나) 가게 색인으로 이름 검색 ════
async function searchPage(m,sido,aid){
  const p=await mkPage(m,tokenInit(rec('TS',0),'sessionStorage')); // 예전 판도 인증된 채로 시작하도록 세션에 둔다
  await p.waitForSelector('#sidoSel option[value="서울특별시"]',{state:'attached'});
  if(sido){await act(p.selectOption('#sidoSel',sido,T));if(aid)await act(p.selectOption('#agencySel',aid,T));await p.waitForTimeout(150)}
  await p.evaluate(()=>{document.getElementById('searchCard').classList.remove('hide');window.__sv(2);document.getElementById('nameSearch').open=true});
  return p;
}
async function search(p,m,q,opt){
  opt=opt||{};const n0=m.calls.length;
  await act(p.fill('#q',q,T));await act(p.fill('#region',opt.region||'',T));await act(p.fill('#zip',opt.zip||'',T));
  await act(p.click('#searchBtn',T));await p.waitForTimeout(opt.wait||350);
  const c=m.calls.slice(n0);
  return {c,old:c.filter(x=>x.key==='/api/restaurants').length,idx:c.filter(x=>x.key==='storeidx').map(x=>x.path),
    reg:c.filter(x=>x.key==='/api/registered').map(x=>decodeURIComponent(x.u.split('ids=')[1]||'')),t:await text(p,'#results')};
}
// I1 색인 있음: 광진구청 → 광진구 파일에서 이름(띄어쓰기·괄호 무시)으로 찾고, 등록 여부를 거쳐 같은 모양으로 보인다
{
  const m={};const p=await searchPage(m,'서울특별시','gwangjin');
  let s=await search(p,m,'육회 바른');
  ok(s.old===0&&s.idx.join()==='meta.json,seoul/05.json'&&s.reg.join()===R_YUK,'I1-1 색인에서 찾음(공공데이터 검색 안 부름) '+JSON.stringify({old:s.old,idx:s.idx,reg:s.reg}));
  ok(/육회바른연어 구의역점/.test(s.t)&&/명단 받기 가능/.test(s.t)&&/자양로/.test(s.t)&&!!(await p.$('#results button[data-a="select"][data-id="'+R_YUK+'"]')),'I1-2 결과 행 모양(배지·주소·[선택]) '+s.t.slice(0,160));
  await p.click('#results button[data-a="select"]',T).catch(()=>{});await p.waitForTimeout(150);
  ok(await p.evaluate(id=>window.__S.restaurants.some(r=>r.restaurant_id===id),R_YUK),'I1-3 [선택] → 선택된 음식점(지문 확인 흐름으로)');
  s=await search(p,m,'육회');
  ok(s.idx.length===0&&s.old===0&&/육회바른연어/.test(s.t)&&!/육회\(지존\)|육회지존/.test(s.t)&&s.reg[0]&&s.reg[0].split(',').length===2,'I1-4 같은 구 두 번째 검색: 파일 다시 안 받음·미등록 가게 숨김 '+JSON.stringify({idx:s.idx,reg:s.reg}));
  s=await search(p,m,'육회',{region:'구의동'});
  ok(s.old===0&&s.reg.join()===R_YUK,'I1-5 지역 칸(동)은 지번 주소로 거름 '+JSON.stringify(s.reg));
  s=await search(p,m,'(만계옥)');
  ok(s.old===0&&/만계옥닭갈비/.test(s.t),'I1-6 괄호 무시');
  ok(p.errs.length===0,'I1 페이지 오류 0 '+p.errs.join('|'));
  await p.context().close();
}
// I2 색인에서 0건: 안내 + 기준일, 공공데이터로 저절로 넘어가지 않음 → [공공데이터에서 다시 찾기]로만
{
  const m={};const p=await searchPage(m,'서울특별시','gwangjin');
  let s=await search(p,m,'없는가게');
  const em=await text(p,'#idxEmpty'),bd=await text(p,'#idxBuilt');
  ok(s.old===0&&em==="『광진구』에서 '없는가게' 이름의 영업 중인 가게를 찾지 못했어요. 이름을 줄여 보거나(예: '육회바른연어 구의역점' → '육회'), 다른 지역 가게라면 아래 [공공데이터에서 다시 찾기]를 눌러 주세요."&&bd==='2026-11-22 기준 공공데이터',
    'I2-1 0건 안내·기준일·자동 전환 없음 '+JSON.stringify({old:s.old,em,bd}));
  const n0=m.calls.length;
  await p.click('#results [data-a="idx-old"]',T).catch(()=>{});await p.waitForTimeout(300);
  const c=m.calls.slice(n0);
  ok(c.some(x=>x.key==='/api/restaurants'&&/q=%EC%97%86%EB%8A%94%EA%B0%80%EA%B2%8C/.test(x.u))&&/예전방식가게/.test(await text(p,'#results')),'I2-2 [공공데이터에서 다시 찾기] → 지금 방식');
  s=await search(p,m,'만계옥',{region:'구의동'});
  ok(s.old===0&&/있지만 '구의동' 주소에는 없어요/.test(await text(p,'#idxEmpty')),'I2-3 이름은 있는데 지역 칸에 걸린 경우 안내 '+(await text(p,'#idxEmpty')));
  await p.context().close();
}
// I3 색인 없음(404) · 형식 다름 · 구 파일 404 → 지금 방식 그대로
for(const mode of ['off','bad','file404']){
  const m={idx:mode};const p=await searchPage(m,'서울특별시','gwangjin');
  const s=await search(p,m,'육회');
  ok(s.old===1&&/예전방식가게/.test(s.t)&&p.errs.length===0,'I3-'+mode+' 색인 못 씀 → 지금 방식 '+JSON.stringify({old:s.old,idx:s.idx}));
  await p.context().close();
}
// I4 관할을 알 수 없으면 지금 방식: 기관 미선택 · 시·도 전체 기관(서울특별시청) · 색인에 없는 시군구(구리시) · 우편번호를 적은 검색
{
  const cases=[['미선택',null,null,{}],['시도 전체','서울특별시','seoul',{}],['키 없음','경기도','guri',{}],['우편번호','서울특별시','gwangjin',{zip:'05021'}]];
  for(const [lab,sido,aid,opt] of cases){
    const m={};const p=await searchPage(m,sido,aid);
    const s=await search(p,m,'육회',opt);
    ok(s.old===1&&!s.idx.some(x=>x!=='meta.json'),'I4 '+lab+' → 지금 방식(구 파일 안 받음) '+JSON.stringify({old:s.old,idx:s.idx}));
    await p.context().close();
  }
}
// I5 키 맞추기: 일반구가 있는 시(고양시 → 세 구 파일 합침) · 세종(시군구 없음) · 서울 중구(같은 이름 구는 고른 시·도 안에서만) · 광주(합쳐진 시·도 이름)
{
  const cases=[['고양시','경기도','goyang','고양국밥',['meta.json','gyeonggi/01.json','gyeonggi/02.json','gyeonggi/03.json'],['G1','G3','G2']],
    ['세종','세종특별자치시','sejong','세종',['meta.json','sejong/00.json'],['S1']],
    ['서울 중구','서울특별시','jung','김밥',['meta.json','seoul/23.json'],['R-JUNG']],
    ['광주 남구','광주광역시','gj-nam','떡갈비',['meta.json','jeonnam-gwangju/05.json'],['J1']]];
  for(const [lab,sido,aid,q,files,ids] of cases){
    const m={};const p=await searchPage(m,sido,aid);
    const s=await search(p,m,q);
    ok(s.old===0&&s.idx.join()===files.join()&&s.reg.join()===ids.join(),'I5 '+lab+' '+JSON.stringify({old:s.old,idx:s.idx,reg:s.reg}));
    await p.context().close();
  }
}
// I6 찾은 가게가 100곳을 넘으면 등록 여부는 100곳까지(서버 한도) + 안내
{
  const many={v:1,rows:Array.from({length:130},(_,i)=>['M'+String(i).padStart(3,'0'),'김밥나라 '+String(i).padStart(3,'0')+'호점','서울특별시 광진구 길 '+i,'서울특별시 광진구 구의동 '+i,'05021'])};
  const m={};FILES['seoul/05.json.bak']=FILES['seoul/05.json'];FILES['seoul/05.json']=many;
  const p=await searchPage(m,'서울특별시','gwangjin');
  const s=await search(p,m,'김밥나라');
  ok(s.old===0&&s.reg.length===1&&s.reg[0].split(',').length===100&&/앞의 100곳만 확인했어요/.test(await text(p,'#resultNote')),'I6 100곳 한도·안내 '+JSON.stringify({n:s.reg[0]&&s.reg[0].split(',').length}));
  FILES['seoul/05.json']=FILES['seoul/05.json.bak'];delete FILES['seoul/05.json.bak'];
  await p.context().close();
}
ok(errsAll.length===0&&dialogs===0,'전 과정 페이지 오류 0·기본 팝업 0 '+JSON.stringify({errs:errsAll.slice(0,3),dialogs}));
console.log(`auth+storeidx: ${pass} pass, ${fail} fail`);await b.close();process.exit(fail?1:0);
