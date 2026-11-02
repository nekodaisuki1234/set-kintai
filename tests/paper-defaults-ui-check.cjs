"use strict";
const {chromium}=require(process.env.PAPER_PLAYWRIGHT_MODULE||"playwright");
const assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),server=http.createServer((req,res)=>{
 const file=path.resolve(root,"."+new URL(req.url,"http://local").pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
const DAY="2026-10-27",NOTE="共通の作業概要から初期表示する文章";
const screenshots=process.env.PAPER_SCREENSHOT_DIR;if(screenshots)fs.mkdirSync(screenshots,{recursive:true});
async function run(){
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAPER_CHROMIUM_PATH||(fs.existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]}),errors=[];
 const origin="http://127.0.0.1:"+server.address().port;
 const ready=page=>page.locator("#startPunch").waitFor();
 const raw=page=>page.evaluate(()=>localStorage.getItem(window.PaperConfig.storageKey));
 const stored=async page=>JSON.parse(await raw(page));
 const settle=async page=>{await page.waitForFunction(()=>document.querySelector("#previewApp").getAttribute("aria-busy")!=="true");await page.clock.runFor(40);};
 const openDefaults=async page=>{await page.locator('#nav-settings').click();await page.locator('[data-action="settings-tab"][data-tab="defaults"]').click();};
 const phase=(page,id)=>page.locator('[data-action="default-phase"][data-phase="'+id+'"]');
 const chosen=page=>page.locator('#defaultsPhaseChoices [aria-pressed=true]').evaluateAll(nodes=>nodes.map(node=>node.dataset.phase));
 const save=async page=>{await page.locator('#defaultsForm button[type=submit]').click();await settle(page);};
 try{
  for(const entry of ['a-paper.html?screen=1','a-paper-app.html']){
   const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:'ja-JP'}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{const control=window.__defaultsAdapter={hold:false};window.PaperRepositoryFactory=options=>{const repo=window.PaperRepository.createLocal(options);return {...repo,async save(next,saveOptions){if(control.hold)await new Promise(resolve=>{control.release=resolve});return repo.save(next,saveOptions)}};};});
   await page.clock.install({time:new Date('2026-10-27T12:00:00Z')});await page.goto(origin+'/day-designs/'+entry);await ready(page);
   await page.evaluate(day=>{const C=window.PaperAttendance,state=window.PaperConfig.mode==='local'?C.createState(C.clock(),{startDay:'2026-10-01'}):C.seed(C.clock());state.records={[day]:{...C.empty(state),note:'入力済みの文章',phases:['maintenance']}};state.submissions={};localStorage.setItem(window.PaperConfig.storageKey,JSON.stringify(state));},DAY);
   await page.reload();await ready(page);const existing=(await stored(page)).records;
   await openDefaults(page);assert.equal(await page.locator('label[for=defaultNote]').innerText(),'共通の作業概要');assert.equal(await page.locator('#defaultsPhaseChoices .phase-button').count(),8);
   const before=await raw(page);await page.locator('#defaultNote').fill(NOTE);await phase(page,'design').click();await phase(page,'test').click();await phase(page,'meeting').click();await phase(page,'meeting').click();
   assert.deepEqual(await chosen(page),['design','test']);assert.equal(await raw(page),before,'choosing initial phases must wait for the settings Update');
   await page.locator('[data-action="settings-tab"][data-tab="sheet"]').click();assert.equal(await page.locator('#workSummary').count(),0,'there is one summary initial-value editor');
   await page.locator('#maxHours').fill('185');await page.locator('[data-action="settings-tab"][data-tab="defaults"]').click();
   assert.equal(await page.locator('#defaultNote').inputValue(),NOTE);assert.deepEqual(await chosen(page),['design','test']);
   for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    for(const button of await page.locator('#defaultsPhaseChoices button').all()){const box=await button.boundingBox();assert.ok(box.width>=43.5&&box.height>=43.5);assert.ok(await button.locator('svg[aria-hidden=true]').count());}
   }
   await page.setViewportSize({width:390,height:844});
   await page.evaluate(()=>{window.defaultsOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('quota')};});
   await save(page);assert.equal(await raw(page),before);assert.equal(await page.locator('#defaultNote').inputValue(),NOTE);assert.deepEqual(await chosen(page),['design','test']);
   await page.evaluate(()=>Storage.prototype.setItem=window.defaultsOriginalSetItem);await save(page);
   const saved=await stored(page);assert.equal(saved.defaults.note,NOTE);assert.equal(saved.settings.workSummary,NOTE);assert.deepEqual(saved.defaults.phases,['design','test']);assert.deepEqual(saved.records,existing);
   await page.locator('[data-action="settings-tab"][data-tab="sheet"]').click();assert.equal(await page.locator('#maxHours').inputValue(),'185');assert.equal(saved.settings.maxHours,180,'saving initial values must not save another settings draft');
   await page.reload();await ready(page);await openDefaults(page);assert.equal(await page.locator('#defaultNote').inputValue(),NOTE);assert.deepEqual(await chosen(page),['design','test']);
   if(screenshots){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(screenshots,(entry.includes('-app')?'local':'demo')+'-paper-batch23-defaults.png'),fullPage:true});}

   await page.locator('#nav-records').click();await page.locator('#recordList [data-day="2026-10-26"]').click();
   assert.equal(await page.locator('#editNote').inputValue(),NOTE);assert.deepEqual(await page.locator('#editorPhaseChoices [aria-pressed=true]').evaluateAll(nodes=>nodes.map(node=>node.dataset.phase)),['design','test']);
   await page.locator('#editStart').fill('09:00');await page.locator('#editEnd').fill('18:00');await page.locator('#editEnd').dispatchEvent('change');await page.locator('#dayForm button[type=submit]').click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();await settle(page);
   assert.equal((await stored(page)).records['2026-10-26'].note,NOTE);assert.deepEqual((await stored(page)).records[DAY],existing[DAY]);
   await page.locator('#nav-home').click();await page.clock.setSystemTime(new Date('2026-10-28T00:00:00Z'));await page.clock.runFor(1200);await page.reload();await ready(page);await page.locator('[data-detail=work]').click();
   assert.equal(await page.locator('#workNote').inputValue(),NOTE);assert.deepEqual(await page.locator('#homePhaseChoices [aria-pressed=true]').evaluateAll(nodes=>nodes.map(node=>node.dataset.phase)),['design','test']);
   await page.locator('[data-action="work-phase"][data-phase="meeting"]').click();await page.clock.runFor(40);await settle(page);assert.deepEqual((await stored(page)).defaults.phases,['design','test']);
   assert.deepEqual((await stored(page)).records['2026-10-28'].phases,['design','test','meeting']);
   const custom=page.locator('[data-action=rest]'),beforeRest=await raw(page);assert.equal((await custom.textContent()).trim(),'');assert.match(await custom.getAttribute('aria-label'),/自由入力/);assert.equal(await custom.locator('svg').count(),1);
   await custom.click();assert.equal(await raw(page),beforeRest,'opening the custom-time editor does not confirm a duration');
   await page.locator('#restHours').fill('1');await page.locator('#restMinutes').fill('15');await page.locator('#restForm button[type=submit]').click();await settle(page);
   assert.equal((await stored(page)).records['2026-10-28'].breakMinutes,75);
   await page.locator('[data-action="quick-rest"][data-minutes="60"]').click();await settle(page);assert.equal((await stored(page)).records['2026-10-28'].breakMinutes,60);
   assert.equal(await page.locator('#restForm').count(),0);

   await openDefaults(page);await phase(page,'operations').click();const recordsBeforePending=(await stored(page)).records;
   await page.evaluate(()=>window.__defaultsAdapter.hold=true);await page.locator('#defaultsForm button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#previewApp').getAttribute('aria-busy')==='true');
   for(const button of await page.locator('#defaultsPhaseChoices button').all())assert.equal(await button.isDisabled(),true,'pending settings saves freeze phase choices');
   await page.evaluate(()=>{window.__defaultsAdapter.hold=false;window.__defaultsAdapter.release()});await settle(page);assert.deepEqual((await stored(page)).defaults.phases,['design','test','operations']);assert.deepEqual((await stored(page)).records,recordsBeforePending);
   const beforeReset=await raw(page);await page.locator('[data-action=reset-defaults]').click();await settle(page);
   assert.equal(await raw(page),beforeReset,'resetting defaults must only stage a draft');assert.deepEqual(await chosen(page),[]);assert.match(await page.locator('#formSaveStatus').innerText(),/未保存/);
   await save(page);assert.deepEqual((await stored(page)).defaults.phases,[]);assert.deepEqual((await stored(page)).records,recordsBeforePending);
   console.log('PASS '+entry+' personal summary/phase defaults, staged drafts, failed/pending saves, new-day inheritance, unchanged existing records, reset and icon-only custom breaks');
   await context.close();
  }
  assert.deepEqual(errors,[]);console.log('PASS new-day defaults and custom rest in both entries without browser errors');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);server.close();process.exitCode=1;});
