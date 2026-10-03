// Run with: sed 's/__SPACE_ID__/20/' harness/export-manual-pdfs.mjs | ego-browser nodejs
// Replace 20 with the existing Ego task space ID; never create a second task space.
// Start homepage-preview.mjs first. Operates on the existing local-only task space.
const spaceId=Number('__SPACE_ID__');
if(!spaceId)throw new Error('Replace the space ID placeholder with the existing task space ID');
const task=await taskSpace(spaceId),page=task.page('p1'),fs=await import('node:fs/promises');
await page.cdp('Network.setCacheDisabled',{cacheDisabled:true});
const root='/Users/spacenulmaru/Prepaid_PWA';
const names={restaurant:'밥장부-안내서-음식점-사장님',agency:'밥장부-안내서-기관-담당자-서무',staff:'밥장부-안내서-직원',guest:'밥장부-손님용-태블릿-안내문-A4'};
// The role guides are the default. Add guest explicitly only when its HTML changes.
const roles=['restaurant','agency','staff'];
for(const role of roles){
  const name=names[role];if(!name)throw new Error('Unknown role: '+role);
  await page.goto('http://127.0.0.1:'+(process.env.PREVIEW_PORT||4403)+'/docs/'+(role==='guest'?'guest-tablet-guide.html':'manual-'+role+'.html')+'?export='+Date.now());
  await page.waitForLoadState();
  await page.cdp('Emulation.setDeviceMetricsOverride',{width:1000,height:1000,deviceScaleFactor:1,mobile:false});
  await page.cdp('Emulation.setEmulatedMedia',{media:'print'});
  await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
  await page.evaluate(async()=>{
    await document.fonts.ready;
    for(const a of document.querySelectorAll('a[href]')){
      if(a.getAttribute('href').startsWith('#'))continue;
      const u=new URL(a.href);
      if(u.hostname==='127.0.0.1'){
        a.href=u.pathname.startsWith('/homepage/')?'https://bapjangbu.com/'+u.pathname.slice(10)+u.hash:'https://app.bapjangbu.com'+u.pathname+u.hash;
      }
    }
  });
  const pdf=await page.cdp('Page.printToPDF',{
    printBackground:true,preferCSSPageSize:true,displayHeaderFooter:role!=='guest',
    headerTemplate:'<span></span>',
    footerTemplate:'<div style="font:10px sans-serif;width:100%;text-align:center;color:#666"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
  });
  const bytes=Buffer.from(pdf.data,'base64');
  await fs.writeFile(root+'/output/pdf/'+name+'.pdf',bytes);
  await fs.writeFile(root+'/docs/manuals/'+name+'.pdf',bytes);
  console.log({role,bytes:bytes.length});
}
await page.cdp('Emulation.setEmulatedMedia',{media:'screen'});
