// 담당자 웹: 조회 실패를 '없음'으로 말하지 않기(D-2) · 인증번호 요청 제한 안내(D-3) · 열쇠 지문 확인 기록 조회 실패·경합(D-7)
//            · 저장소가 막힌 PC에서도 화면이 살아 있기(D-8) — beta.55
// 사용: node harness/agency-net.e2e.mjs [agency-web/index.html]  — 외부 요청은 전부 막고 필요한 API만 목으로 받는다.
// 이 파일의 단언은 전부 수정 전 코드(beta.54)에서 실패한다.
import { chromium } from 'playwright';
import fs from 'fs';
import crypto from 'crypto';
const SPKI=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'}).toString('base64');
const FP=(()=>{const h=crypto.createHash('sha256').update(Buffer.from(SPKI,'base64')).digest('hex').slice(0,8).toUpperCase();return h.slice(0,4)+'-'+h.slice(4)})();
const src=fs.readFileSync(process.argv[2]||new URL('../agency-web/index.html',import.meta.url),'utf8')
  .replace("const S={","const S=window.__S={")
  .replace("function validateAndRenderCsv(){","window.__v=()=>validateAndRenderCsv();window.__sv=n=>setView(n);window.__rs=()=>renderSelected();function validateAndRenderCsv(){");
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++}else{fail++;console.log('FAIL',m)}};
const INDEX={regions:[{name:'서울특별시',agencies:[{id:1,name:'서울특별시청'},{id:2,name:'광진구청'},{id:3,name:'성동구청'}]}]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch();
const errsAll=[];let dialogs=0;
// m: 목 서버 동작. 각 API는 함수(url,req)→{status,json,delay} 또는 null(기본).
async function mkPage(m,init){
  const ctx=await b.newContext();const p=await ctx.newPage();
  p.on('dialog',d=>{dialogs++;d.dismiss()});
  const errs=[];p.on('pageerror',e=>{errs.push(e.message);errsAll.push(e.message)});p.errs=errs;
  await p.addInitScript(init||(()=>{try{localStorage.setItem('bapjangbu_terms_agreed','1');sessionStorage.setItem('agency-token',JSON.stringify({token:'T1',email:'a@gwangjin.go.kr',at:Date.now()}))}catch(e){}}));
  m.calls=[];
  await p.route('**/*',async r=>{const u=r.request().url();
    if(u==='https://t.test/')return r.fulfill({contentType:'text/html',body:src});
    if(u.endsWith('/agency-index.json'))return r.fulfill({contentType:'application/json',body:JSON.stringify(m.index||INDEX)});
    const key=(u.match(/\/api\/[a-z\-\/]+/)||[''])[0];
    m.calls.push({key,u,body:r.request().postData()});
    const h=m[key];
    const res=h?h(u,r.request()):null;
    if(res&&res.delay)await sleep(res.delay);
    if(res)return r.fulfill({status:res.status||200,contentType:'application/json',body:JSON.stringify(res.json==null?{}:res.json)});
    if(key==='/api/public-key')return r.fulfill({contentType:'application/json',body:JSON.stringify({public_key:SPKI})});
    return r.fulfill({status:404,body:''});});
  if(m.clock)await p.clock.install();
  await p.goto('https://t.test/');
  return p;
}
const text=(p,sel)=>p.$eval(sel,e=>e.innerText).catch(()=>'');
const pickAgency=async(p,id)=>{await p.selectOption('#sidoSel','서울특별시');await p.selectOption('#agencySel',String(id))};

// ── D-2-1: 관할 목록 조회가 429면 "없어요"가 아니라 "불러오지 못했어요 [다시 시도]" ──
{
  let n=0;
  const m={'/api/registered-list':()=>(++n===1?{status:429,json:{error:'rate_limited'}}:{json:{restaurants:[{restaurant_id:'r1',restaurant_name:'만계옥닭갈비',district:'광진구'}]}})};
  const p=await mkPage(m);await p.waitForSelector('#sidoSel option[value="서울특별시"]',{state:'attached'});
  await pickAgency(p,2);await p.waitForTimeout(300);
  const t=await text(p,'#jurisList');
  ok(/불러오지 못했어요/.test(t)&&!/관할 등록 음식점이 없어요/.test(t)&&/1분/.test(t)&&!!(await p.$('#jurisRetryBtn')),'D2-1 429는 실패로 안내 + [다시 시도] '+t);
  await p.click('#jurisRetryBtn').catch(()=>{});await p.waitForTimeout(300);
  ok(/만계옥닭갈비/.test(await text(p,'#jurisList')),'D2-1 [다시 시도]로 목록 표시');
  await p.context().close();
}
// ── D-2-2: 기관을 빨리 바꾸면 앞 기관의 늦은 응답은 버린다 ──
{
  const m={'/api/registered-list':u=>/sigungu=%EA%B4%91%EC%A7%84%EA%B5%AC/.test(u)
    ?{delay:700,json:{restaurants:[{restaurant_id:'g1',restaurant_name:'광진가게',district:'광진구'}]}}
    :{json:{restaurants:[{restaurant_id:'s1',restaurant_name:'성동가게',district:'성동구'}]}}};
  const p=await mkPage(m);await p.waitForSelector('#sidoSel option[value="서울특별시"]',{state:'attached'});
  await pickAgency(p,2);await p.waitForTimeout(80);await p.selectOption('#agencySel','3');await p.waitForTimeout(1100);
  const t=await text(p,'#jurisList');
  ok(/성동가게/.test(t)&&!/광진가게/.test(t),'D2-2 늦게 온 앞 기관 응답 버림 '+t);
  await p.context().close();
}
// ── D-2-3: 이름 검색 — 429·영문 코드 노출 금지, 등록 여부 조회 실패를 "등록 음식점 없음"으로 말하지 않기 ──
{
  let mode='429';
  const m={'/api/restaurants':()=>mode==='429'?{status:429,json:{error:'rate_limited'}}:{json:[{restaurant_id:'x1',name:'김밥천국',address:'서울 광진구 구의동 1',status:'영업'}]},
    '/api/registered':()=>({status:500,json:{error:'internal'}})};
  const p=await mkPage(m);
  await p.evaluate(()=>{document.getElementById('searchCard').classList.remove('hide');window.__sv(2);document.getElementById('nameSearch').open=true});
  await p.fill('#q','김밥');await p.click('#searchBtn');await p.waitForTimeout(300);
  let t=await text(p,'#results');
  ok(/검색하지 못했어요/.test(t)&&/1분/.test(t)&&!/rate_limited/.test(t),'D2-3 검색 429는 한국어 안내(코드 노출 없음) '+t);
  mode='ok';await p.click('#searchBtn');await p.waitForTimeout(300);t=await text(p,'#results');
  ok(/등록 여부를 확인하지 못했어요/.test(t)&&!/등록된 음식점이 없어요/.test(t),'D2-3 등록 여부 조회 실패는 "확인하지 못했어요" '+t);
  await p.context().close();
}
// ── D-3: 인증번호 요청 제한 문구 ──
{
  let resp={status:429,json:{error:'rate_limited',scope:'ip',retry_after_s:1800}};
  const m={'/api/agency/request-otp':()=>resp};
  const p=await mkPage(m,()=>{try{localStorage.setItem('bapjangbu_terms_agreed','1')}catch(e){}});
  const ask=async()=>{await p.fill('#email','a@gwangjin.go.kr');await p.click('#authBtn');await p.waitForTimeout(250);return text(p,'#authMsg')};
  let t=await ask();
  ok(/같은 사무실 인터넷 주소/.test(t)&&/최대 1시간/.test(t)&&/약 30분/.test(t),'D3-1 IP 제한(scope:ip) 안내 '+t);
  resp={status:429,json:{error:'rate_limited',scope:'email',retry_after_s:40}};t=await ask();
  ok(/같은 이메일로 방금/.test(t)&&/40초/.test(t),'D3-2 같은 이메일 제한(scope:email) 안내 '+t);
  resp={status:429,json:{error:'rate_limited'}};t=await ask();
  ok(/1분 뒤/.test(t)&&/최대 1시간/.test(t),'D3-3 예전 서버(scope 없음)는 두 원인을 함께 안내 '+t);
  await p.context().close();
}
// ── D-7: 확인 기록 조회 실패 · fingerprint_changed · 부서 전환 경합 ──
{
  let kcMode='fail';
  const m={'/api/agency/keychecks':()=>kcMode==='fail'?{status:500,json:{error:'internal'}}:{json:{keychecks:[]}}};
  const p=await mkPage(m);
  await p.evaluate(()=>{const S=window.__S;S.agency={name:'광진구청',sido:'서울특별시',id:2};S.restaurants=[{name:'만계옥닭갈비',restaurant_id:'r1'}];window.__sv(2);window.__rs()});
  await p.fill('#deptInput','보건의료과');await p.dispatchEvent('#deptInput','change');await p.waitForTimeout(800);
  let t=await text(p,'#keycheckList');
  const hasCheck=!!(await p.$('#keycheckList input[data-a="kc"]'));
  ok(/확인 기록을 불러오지 못했어요/.test(t)&&!hasCheck&&!!(await p.$('#keycheckList [data-a="kc-reload"]')),'D7-1 확인 기록 조회 실패는 [다시 시도]만, 확인 체크 없음 '+t.slice(0,120));
  const blocked=await p.evaluate(()=>{try{return document.getElementById('keycheckList')&&window.__S.kcLoadErr===true}catch(e){return false}});
  ok(blocked,'D7-1 조회 실패 동안 전송 차단 상태');
  kcMode='ok';const reloaded=await p.click('#keycheckList [data-a="kc-reload"]',{timeout:2000}).then(()=>true,()=>false);await p.waitForTimeout(600);
  ok(reloaded&&!!(await p.$('#keycheckList input[data-a="kc"]'))&&!/불러오지 못했어요/.test(await text(p,'#keycheckList')),'D7-2 [다시 시도] 성공 → 확인 카드');
  // fingerprint_changed: 체크해도 자동으로 덮어쓰지 않고(confirm_change 미전송) 빨간 카드로 바꿔 다시 확인받는다
  let posts=[];
  m['/api/agency/keycheck']=(u,req)=>{const bd=JSON.parse(req.postData());posts.push(bd);return bd.confirm_change?{json:{ok:true,fingerprint:FP}}:{status:409,json:{error:'fingerprint_changed',current:FP,had_previous:true}}};
  await p.check('#keycheckList input[data-a="kc"]').catch(()=>{});await p.waitForTimeout(500);
  t=await text(p,'#keycheckList');
  ok(posts.length===1&&!posts[0].confirm_change&&!!(await p.$('#keycheckList .kc-danger'))&&/예전에/.test(t),'D7-3 fingerprint_changed → 자동 덮어쓰기 없이 빨간 카드 '+JSON.stringify(posts)+' '+t.slice(0,100));
  const dangerChecked=await p.check('#keycheckList .kc-danger input[data-a="kc"]',{timeout:2000}).then(()=>true,()=>false);await p.waitForTimeout(500);
  ok(dangerChecked&&posts.length===2&&posts[1].confirm_change===true&&/확인 완료/.test(await text(p,'#keycheckList')),'D7-4 빨간 카드에서 다시 체크해야 confirm_change로 저장 '+JSON.stringify(posts));
  await p.context().close();
}
{
  // 부서를 빨리 바꾸면 앞 부서 조회의 늦은 응답(r1 확인됨)이 뒤 부서(기록 없음)를 덮지 않는다
  const m={'/api/agency/keychecks':u=>/department=%EC%B4%9D%EB%AC%B4%EA%B3%BC/.test(u)
    ?{delay:700,json:{keychecks:[{restaurant_id:'r1',fingerprint:FP,checked_at:1}]}}:{json:{keychecks:[]}}};
  const p=await mkPage(m);
  await p.evaluate(()=>{const S=window.__S;S.agency={name:'광진구청',sido:'서울특별시',id:2};S.restaurants=[{name:'만계옥닭갈비',restaurant_id:'r1'}]});
  await p.fill('#deptInput','총무과');await p.dispatchEvent('#deptInput','change');await p.waitForTimeout(100);
  await p.fill('#deptInput','위생과');await p.dispatchEvent('#deptInput','change');await p.waitForTimeout(1200);
  const st=await p.evaluate(()=>{const S=window.__S;return{dept:S.dept,has:S.keychecks.has('r1')}});
  ok(st.dept==='위생과'&&!st.has,'D7-5 앞 부서의 늦은 확인 기록이 뒤 부서를 덮지 않음 '+JSON.stringify(st));
  await p.context().close();
}
// ── D-8: 저장소가 막힌 PC · 깨진 저장값에서도 화면이 살아 있음 ──
{
  const p=await mkPage({},()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('denied','SecurityError')}})});
  await p.waitForTimeout(300);
  const gate=!!(await p.$('#termsAgree'));
  await p.check('#termsAgree').catch(()=>{});await p.click('#termsOk').catch(()=>{});await p.waitForTimeout(100);
  const st=await p.evaluate(()=>({modal:!!document.querySelector('#modalRoot .modal'),authDisabled:document.getElementById('authBtn').disabled}));
  ok(p.errs.length===0&&gate&&!st.modal&&!st.authDisabled,'D8-4 저장소 차단 PC: 오류 없이 동의 → 인증 진행 가능 '+JSON.stringify({errs:p.errs,gate,st}));
  await p.context().close();
}
{
  const p=await mkPage({},()=>{try{localStorage.setItem('bapjangbu_terms_agreed','1');localStorage.setItem('agency-excluded','{깨짐');localStorage.setItem('agency-selection','[1,');}catch(e){}});
  await p.waitForTimeout(300);
  ok(p.errs.length===0&&!(await p.$eval('#authBtn',e=>e.disabled))&&dialogs===0,'D8-5 깨진 저장값에도 오류 없이 시작(전 과정 기본 팝업 0회) '+p.errs.join('|')+' dialogs='+dialogs);
  await p.context().close();
}
// ════ beta.60 (W-7 인증 만료 뒤 화면 잠금·무조작 폐기 · W-11 목록에 없는 기관 직접 입력) — 전부 수정 전 코드에서 실패한다 ════
const R1N='만계옥닭갈비',H6='음식점명,소속,부서명,직원명,선금금액,입금자명\n';
const safe=async(f,label)=>{try{return await f()}catch(e){console.log('  ('+label+' 진행 불가: '+String(e.message).split('\n')[0]+')');return null}};
const visible=(p,sel)=>p.$eval(sel,e=>!!e.offsetParent&&!e.closest('.hide')).catch(()=>false);
async function w7Page(m){
  Object.assign(m,{'/api/agency/keychecks':()=>m.kc401?{status:401,json:{error:'agency_auth_required'}}:{json:{keychecks:[{restaurant_id:'r1',fingerprint:FP,checked_at:1}]}},
    '/api/registered-list':()=>({json:{restaurants:[{restaurant_id:'r1',restaurant_name:R1N,district:'광진구'}]}}),
    '/api/agency/request-otp':()=>({json:{ok:true,sent:true}}),'/api/agency/verify-otp':()=>({json:{token:'T2'}})});
  const p=await mkPage(m);await p.waitForSelector('#sidoSel option[value="서울특별시"]',{state:'attached'});
  await pickAgency(p,2);await p.waitForSelector('#jurisList input[data-a="chk"]');await p.check('#jurisList input[data-a="chk"]');
  await p.fill('#deptInput','총무과');await p.dispatchEvent('#deptInput','change');await p.waitForTimeout(300);
  await p.setInputFiles('#csv',{name:'a.csv',mimeType:'text/csv',buffer:Buffer.from('﻿'+H6+`${R1N},광진구청,총무과,홍길동비밀,9000,\n`)});await p.waitForTimeout(250);
  await p.click('#step-3');await p.waitForTimeout(100);
  return p;
}
const expireNow=async p=>{await p.evaluate(()=>{const S=window.__S;S.dept='';}); await p.$eval('#deptInput',e=>{e.value='위생과';e.dispatchEvent(new Event('change'))});await p.waitForSelector('#authStep1:not(.hide)',{timeout:3000}).catch(()=>{});await p.waitForTimeout(150)};
{
  const m={};const p=await w7Page(m);
  const pre=await visible(p,'#csvResult')&&/홍길동비밀/.test(await text(p,'#csvResult'));
  m.kc401=true;await expireNow(p);
  await p.click('#step-3').catch(()=>{});await p.click('#step-2').catch(()=>{});await p.waitForTimeout(150);
  const st=await p.evaluate(()=>({v2:!document.getElementById('view-2').classList.contains('hide'),v3:!document.getElementById('view-3').classList.contains('hide'),
    csvCard:document.getElementById('csvCard').classList.contains('hide'),s3:document.getElementById('step-3').getAttribute('aria-disabled')}));
  const shown=await visible(p,'#csvResult');
  ok(pre&&!st.v2&&!st.v3&&st.csvCard&&st.s3==='true'&&!shown,'W7-1 인증 만료 뒤 단계 탭으로 명단 표를 열 수 없음 '+JSON.stringify({pre,st,shown}));
  ok(await p.evaluate(()=>window.__S.rawRows&&window.__S.rawRows.length===1),'W7-1 올린 명단은 메모리에 남김(다시 인증하면 이어서)');
  // 다시 인증하면 올린 명단이 다시 보인다
  m.kc401=false;
  await safe(async()=>{await p.click('#step-1',{timeout:2000});
    await p.fill('#email','a@gwangjin.go.kr',{timeout:3000});await p.click('#authBtn',{timeout:3000});await p.waitForSelector('#authStep2:not(.hide)',{timeout:3000}).catch(()=>{});
    await p.fill('#otp','123456',{timeout:3000});await p.click('#otpBtn',{timeout:3000});await p.waitForTimeout(400)},'다시 인증');
  await p.click('#step-3').catch(()=>{});await p.waitForTimeout(150);
  ok(await visible(p,'#csvResult')&&/홍길동비밀/.test(await text(p,'#csvResult')),'W7-2 다시 인증하면 올린 명단이 다시 보임');
  await p.context().close();
}
{
  const m={clock:true};const p=await w7Page(m);
  m.kc401=true;await expireNow(p);
  const held=await p.evaluate(()=>!!window.__S.rawRows);
  await p.clock.runFor(31*60*1000);await p.waitForTimeout(200);
  const st=await p.evaluate(()=>({rows:window.__S.rawRows,sel:window.__S.restaurants.length}));
  const am=await text(p,'#authMsg');
  // beta.61(계약서 4절): 30분 무조작 자동 해제를 없앴다 — 가만히 두어도 올린 명단·선택을 지우지 않는다(공용 PC는 [로그아웃]).
  ok(held&&st.rows&&st.rows.length===1&&st.sel===1&&!/30분/.test(am),'W7-3(beta.61) 30분 무조작이어도 명단을 지우지 않음 '+JSON.stringify({held,rows:st.rows&&st.rows.length,sel:st.sel,am}));
  await p.context().close();
}
// ── W-11: 목록에 없는 기관(학교·복지관 등) 직접 입력 ──
{
  const INDEX2={regions:[
    {name:'서울특별시',agencies:[{id:'seoul',name:'서울특별시청'},{id:'gwangjin',name:'광진구청'},{id:'gwangjin-health',name:'광진구보건소',district:'광진구'},{id:'seoul-jung-health',name:'중구보건소',district:'중구'}]},
    {name:'부산광역시',agencies:[{id:'busan-city',name:'부산광역시청'},{id:'busan-jung-health',name:'중구보건소',district:'중구'},{id:'busan-gs-health',name:'강서구보건소',district:'강서구'}]},
    {name:'세종특별자치시',agencies:[{id:'sejong-city',name:'세종특별자치시청'}]}]};
  const m={index:INDEX2,'/api/registered-list':()=>({json:{restaurants:[{restaurant_id:'r1',restaurant_name:R1N,district:'광진구'}]}}),'/api/agency/keychecks':()=>({json:{keychecks:[]}})};
  const p=await mkPage(m);await p.waitForSelector('#sidoSel option[value="서울특별시"]',{state:'attached'});
  const box=()=>p.$eval('#customAgencyBox',e=>!e.classList.contains('hide')).catch(()=>false);
  const cmsg=()=>text(p,'#customAgencyMsg');
  // maxlength(60)를 넘는 값도 검사되는지 보려고 값을 직접 넣는다(붙여넣기·자동 완성 등 maxlength를 넘는 경로 대비).
  const okBtn=(name,sg)=>safe(async()=>{await p.$eval('#customAgencyName',(e,v)=>{e.value=v},name);if(sg!=null)await p.selectOption('#customSigunguSel',sg,{timeout:2000});await p.click('#customAgencyOk',{timeout:2000});await p.waitForTimeout(150)},'직접 입력');
  const hasBtn=await p.click('#customAgencyBtn',{timeout:2000}).then(()=>true,()=>false);
  ok(hasBtn&&!(await box())&&/시·도/.test(await text(p,'#agencyMsg')),'W11-1 [목록에 없어요 — 직접 입력]: 시·도 먼저 안내');
  await p.selectOption('#sidoSel','서울특별시');await p.click('#customAgencyBtn').catch(()=>{});
  const opts=await p.$$eval('#customSigunguSel option',os=>os.map(o=>o.textContent)).catch(()=>[]);
  ok(await box()&&opts.join('|')==='시·군·구 선택|광진구|중구|서울특별시 전체','W11-2 시·군·구는 고른 시·도의 자료에서만(부산 강서구 없음) '+opts.join('|'));
  await okBtn('가'.repeat(61),'광진구');const e61=await cmsg();
  await okBtn('​한국대학교','광진구');const eZw=await cmsg();
  await okBtn('한국대학교','');const eSg=await cmsg();
  const none=await p.evaluate(()=>window.__S.agency);
  ok(/60자/.test(e61)&&/보이지 않는/.test(eZw)&&/지역/.test(eSg)&&!none,'W11-3 기관 이름·지역 검사 '+JSON.stringify([e61,eZw,eSg,none]));
  const n0=m.calls.length;
  await okBtn('한국대학교','광진구');await p.waitForTimeout(300);
  const ag=await p.evaluate(()=>window.__S.agency);
  const rl=m.calls.slice(n0).find(c=>c.key==='/api/registered-list');
  ok(ag&&ag.name==='한국대학교'&&ag.district==='광진구'&&!(await box())&&rl&&/sido=%EC%84%9C%EC%9A%B8%ED%8A%B9%EB%B3%84%EC%8B%9C&sigungu=%EA%B4%91%EC%A7%84%EA%B5%AC/.test(rl.u)&&/만계옥닭갈비/.test(await text(p,'#jurisList')),
    'W11-4 직접 입력 기관으로 관할 음식점 목록 '+JSON.stringify({ag,u:rl&&rl.u}));
  await p.check('#jurisList input[data-a="chk"]',{timeout:3000}).catch(()=>{});
  await p.fill('#deptInput','학생지원팀');await p.dispatchEvent('#deptInput','change');await p.waitForTimeout(300);
  const kc=m.calls.filter(c=>c.key==='/api/agency/keychecks').pop();
  await p.setInputFiles('#csv',{name:'a.csv',mimeType:'text/csv',buffer:Buffer.from('﻿'+H6+`${R1N},,학생지원팀,홍길동,9000,\n`)});await p.waitForTimeout(250);
  const rows=await p.evaluate(()=>(window.__S.rows||[]).map(r=>[r.org,r.err,r.skip].join('|')));
  ok(kc&&/institution=%ED%95%9C%EA%B5%AD%EB%8C%80%ED%95%99%EA%B5%90/.test(kc.u)&&rows.join()==='한국대학교||false','W11-5 지문 확인 범위·명단 소속 기본값 = 직접 입력한 기관 '+JSON.stringify({u:kc&&kc.u,rows}));
  await p.reload();await p.waitForTimeout(500);
  const ag2=await p.evaluate(()=>window.__S.agency);
  ok(ag2&&ag2.custom&&ag2.name==='한국대학교'&&ag2.district==='광진구'&&/한국대학교/.test(await text(p,'#agencyMsg')),'W11-6 새로 고쳐도 직접 입력 기관 유지 '+JSON.stringify(ag2));
  await p.selectOption('#sidoSel','세종특별자치시');await p.click('#customAgencyBtn').catch(()=>{});
  const sj=await p.$$eval('#customSigunguSel option',os=>os.map(o=>o.textContent+(o.selected?'*':''))).catch(()=>[]);
  await p.selectOption('#sidoSel','서울특별시');await p.click('#customAgencyBtn').catch(()=>{});await okBtn('광진구보건소','광진구');
  const ag3=await p.evaluate(()=>window.__S.agency);
  ok(sj.join('|')==='세종특별자치시 전체*'&&ag3&&!ag3.custom&&ag3.id==='gwangjin-health','W11-7 세종은 시 전체만 · 목록에 있는 이름이면 목록 기관으로 '+JSON.stringify({sj,ag3}));
  ok(p.errs.length===0,'W11 페이지 오류 0 '+p.errs.join('|'));
  await p.context().close();
}
console.log(`net: ${pass} pass, ${fail} fail`);await b.close();process.exit(fail?1:0);
