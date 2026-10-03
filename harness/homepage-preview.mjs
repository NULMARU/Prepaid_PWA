// Local-only preview. No production requests or persisted customer data.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp','.pdf':'application/pdf'};
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/agency-demo.html'){
    let html=fs.readFileSync(path.join(root,'agency-web/index.html'),'utf8');
    html=html.replace('loadAgencyIndex(); //','// loadAgencyIndex(); //');
    html=html.replace('if(hasAgreedTerms())restoreToken();','');
    html=html.replace("if(!hasAgreedTerms()){$('authBtn').disabled=true;showTermsGate();}",`
      S.authed=true; S.agency={name:'예시기관'}; S.dept='총무과';
      S.restaurants=[{restaurant_id:'demo-store',name:'예시식당'}];
      S.rows=[{rest:'예시식당',org:'예시기관',dept:'총무과',name:'김밥',amount:90000,payer:'예시기관',payMethod:'계좌이체'}];
      S.valid=true;
      $('csvCard').classList.remove('hide');$('confirmCard').classList.remove('hide');
      $('submitCard').classList.remove('hide');setView(3);renderConfirm();
      stepMax=4;paintStepper(4);
    `);
    res.setHeader('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'");
    res.setHeader('Content-Type',types['.html']);res.end(html);return;
  }
  if(url.pathname==='/api/feedback'&&req.method==='POST'){
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{console.log('MOCK FEEDBACK',body);res.writeHead(200);res.end('ok');});return;
  }
  if(url.pathname==='/demo.html'){
    let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
    html=html.replace("if('serviceWorker' in navigator)","if(false)");
    html=html.replace('async function init(){',`async function init(){
      await Promise.resolve();
      state.data=norm({employees:[{id:'demo-guest',name:'김밥',org:'예시기관',dept:'총무과',orgKind:'public',isDeleted:false}],transactions:[{id:'demo-tx',employeeId:'demo-guest',type:'topup',amount:90000,beforeBalance:0,afterBalance:90000,createdAt:Date.now()}],meta:{setupComplete:true,shopName:'밥장부 예시식당',pinHash:'demo-not-a-real-pin',departments:[]}});
      state.data.meta.termsAgreedAt=Date.now();
      state.loaded=true;state.mode='IndexedDB';state.pinLocked=true;state.lockView='customer';state.custStage='compose';state.custSelectedId='demo-guest';state.custAmount='9000';
      if(${JSON.stringify(url.searchParams.get('screen'))}==='search'){state.custStage='search';state.custQuery='김';state.custSelectedId='';state.custAmount='';}
      if(${JSON.stringify(url.searchParams.get('screen'))}==='settings'){state.pinLocked=false;state.screen='settings';}
      render();return;
    `);
    res.setHeader('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'");
    res.setHeader('Content-Type',types['.html']);res.end(html);return;
  }
  const relative=url.pathname==='/'?'homepage/index.html':decodeURIComponent(url.pathname.slice(1));
  const file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PREVIEW_PORT||4403),'127.0.0.1',()=>console.log('Preview port '+(process.env.PREVIEW_PORT||4403)));
