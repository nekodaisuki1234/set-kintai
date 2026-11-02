"use strict";
const {chromium}=require(process.env.PAPER_PLAYWRIGHT_MODULE||"playwright");
const assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),server=http.createServer((req,res)=>{
 const file=path.resolve(root,"."+new URL(req.url,"http://local").pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
async function run(){
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAPER_CHROMIUM_PATH||(fs.existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"ja-JP"}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date('2026-10-27T12:00:00Z')});
  await page.goto('http://127.0.0.1:'+server.address().port+'/day-designs/a-paper.html?screen=1');
  const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem(window.PaperAttendance.KEY)));
  const heading=value=>page.waitForFunction(t=>document.querySelector('main h1')?.textContent===t,value);
  assert.equal(await page.locator('#homeTimeEditor').evaluate(n=>n.open),false);
  assert.equal(await page.locator('#startTime').isVisible(),false);
  const tabs=await page.locator('.detail-tabs').boundingBox(),nav=await page.locator('.app-nav').boundingBox();
  assert.ok(tabs.y+tabs.height<=nav.y,'detail tabs must fit above mobile bottom navigation');
  await page.locator('[data-action=quick-rest][data-minutes="45"]').click();
  assert.equal((await state()).records['2026-10-27'].breakMinutes,45);
  assert.equal(await page.locator('#homeTimeEditor').evaluate(n=>n.open),false);
  await page.locator('#homeTimeEditor summary').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#startTime').isVisible(),true);
  await page.locator('#startTime').fill('09:00');await page.locator('#startTime').dispatchEvent('change');await page.clock.runFor(300);
  assert.equal((await state()).records['2026-10-27'].start,'09:00');
  await page.locator('[data-action=rest]').click();await page.locator('#restMinutes').fill('17');
  await page.locator('#nav-records').click();await page.locator('#nav-home').click();
  assert.equal(await page.locator('#homeTimeEditor').evaluate(n=>n.open),true,'manual time disclosure survives navigation');
  await page.locator('[data-action=rest]').click();assert.equal(await page.locator('#restMinutes').inputValue(),'17','custom rest draft survives navigation');
  await page.locator('#homeTimeEditor summary').click();
  assert.equal(await page.locator('[data-action=quick-rest][data-minutes="60"]').isVisible(),true);
  console.log('PASS compact home, keyboard disclosure, immediate rest save and preserved manual/rest state');
  // Two past missing weekdays, plus holiday/full-leave/today/future records that must not appear as past missing.
  await page.evaluate(()=>{
   const C=window.PaperAttendance,s=JSON.parse(localStorage.getItem(C.KEY));
   for(const day of C.dates('2026-10-01','2026-10-26'))if(C.workday(day))s.records[day]={...C.empty(s),leave:'holiday'};
   delete s.records['2026-10-02'];s.records['2026-10-26']={...C.empty(s),start:'09:00'};
   s.records['2026-10-27']={...C.empty(s)};localStorage.setItem(C.KEY,JSON.stringify(s));
  });await page.reload();await page.locator('#nav-records').click();
  assert.equal(await page.locator('#recordsChart').evaluate(n=>n.open),false);
  assert.equal(await page.locator('#recordList').evaluate(n=>getComputedStyle(n).overflowY),'visible');
  assert.equal(await page.locator('#recordList [data-day]').count(),31);
  await page.locator('[data-action=record-filter][data-filter=missing]').click();
  assert.deepEqual(await page.locator('#recordList [data-day]').evaluateAll(nodes=>nodes.map(n=>n.dataset.day)),['2026-10-02','2026-10-26']);
  await page.locator('[data-day="2026-10-26"]').scrollIntoViewIfNeeded();const position=await page.evaluate(()=>scrollY);
  await page.locator('[data-day="2026-10-26"]').click();await heading('勤怠の編集');
  await page.locator('#editNote').fill('一覧に戻っても下書きを保持');
  await page.goBack();await heading('10月の勤怠');
  assert.equal(await page.locator('[data-action=record-filter][data-filter=missing]').getAttribute('aria-pressed'),'true');
  await page.waitForFunction(y=>Math.abs(scrollY-y)<=1,position);
  await page.goForward();await heading('勤怠の編集');assert.equal(await page.locator('#editNote').inputValue(),'一覧に戻っても下書きを保持');
  await page.goBack();await heading('10月の勤怠');
  await page.locator('#monthInput').fill('2026-09');await page.locator('#monthInput').dispatchEvent('change');
  await page.locator('[data-action=records-today]').click();
  assert.equal(await page.locator('#monthInput').inputValue(),'2026-10');
  assert.equal(await page.locator('[data-action=record-filter][data-filter=all]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.day),'2026-10-27');
  const today=await page.locator('#recordList .is-today').boundingBox();assert.ok(today.y>=60&&today.y<400,'today jump clears sticky filter controls');
  await page.locator('#recordsChart summary').click();assert.equal(await page.locator('.annual-chart').isVisible(),true);
  await page.locator('[data-action=chart-month][data-month="2026-09-01"]').click();assert.equal(await page.locator('#monthInput').inputValue(),'2026-09');
  assert.equal(await page.locator('#recordsChart').evaluate(n=>n.open),true);
  console.log('PASS list filters, holiday/full-leave exclusions, page-scroll restoration, editor drafts and current-day/month jump');
  await page.locator('#nav-home').click();
  for(const width of [320,390,430,1280]){
   await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'home overflow '+width);
   await page.locator('#nav-records').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'records overflow '+width);
   for(const selector of ['[data-action=records-today]','[data-action=record-filter][data-filter=missing]']){const box=await page.locator(selector).boundingBox();assert.ok(box.height>=44&&box.width>=44);}
   await page.locator('#nav-home').click();
  }
  assert.deepEqual(errors,[]);console.log('PASS 320–1280px layout, touch targets and no browser errors');
 }finally{await browser.close();}
}
run().then(()=>server.close(),e=>{console.error(e);server.close();process.exitCode=1});
