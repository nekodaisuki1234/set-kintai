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
  page.on("pageerror",e=>errors.push(e.message));await page.clock.install({time:new Date("2026-10-27T12:00:00Z")});
  const url="http://127.0.0.1:"+server.address().port+"/day-designs/a-paper.html?screen=1";
  await page.goto(url);
  await page.evaluate(()=>{const C=window.PaperAttendance,s=C.seed(C.clock());s.records["2026-10-27"]={...C.empty(s),start:"09:00",end:"18:00",note:"設計とレビュー",phases:["design"],allocation:{P1:4,P2:3,P3:1,P4:0,SET:0}};localStorage.setItem(C.KEY,JSON.stringify(s));});await page.reload();
  const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem(window.PaperAttendance.KEY)));
  const before=(await state()).records["2026-10-27"];
  await page.locator('#resetPunch').click();assert.equal((await state()).records['2026-10-27'].start,'');assert.equal(await page.locator('dialog[open]').count(),0);
  await page.locator('#undoLastChange').click();assert.deepEqual((await state()).records['2026-10-27'],before);
  assert.equal(await page.locator('#undoLastChange').count(),0);console.log('PASS punch undo restores both times, manual project allocation and work details');
  await page.clock.runFor(900);await page.locator('#resetPunch').click();await page.locator('[data-action=quick-rest][data-minutes="30"]').click();assert.equal(await page.locator('#undoLastChange').count(),0);assert.equal((await state()).records['2026-10-27'].breakMinutes,30);
  console.log('PASS a later saved change supersedes undo');
  await page.locator('#nav-records').click();await page.locator('[data-day="2026-10-01"]').click();
  const saved=(await state()).records['2026-10-01'];await page.locator('#editNote').fill('まだ保存していない下書き');
  await page.locator('[data-action=clear-day]').click();assert.equal((await state()).records['2026-10-01'],undefined);
  await page.locator('#undoLastChange').click();assert.deepEqual((await state()).records['2026-10-01'],saved);assert.equal(await page.locator('#editNote').inputValue(),'まだ保存していない下書き');
  console.log('PASS day deletion undo restores the saved record and unsaved editor draft separately');
  await page.locator('[data-action=clear-day]').click();await page.locator('#editNote').fill('取消後の新しい内容');assert.equal(await page.locator('#undoLastChange').count(),0);assert.equal(await page.locator('#editNote').inputValue(),'取消後の新しい内容');
  await page.reload();await page.locator('#nav-records').click();await page.locator('[data-day="2026-10-02"]').click();await page.locator('[data-action=clear-day]').click();
  await page.evaluate(()=>{const C=window.PaperAttendance,s=JSON.parse(localStorage.getItem(C.KEY));s.revision++;s.records['2026-10-02']={...C.empty(s),start:'10:00',end:'19:00',note:'別の画面で修正',allocation:{P1:8,P2:0,P3:0,P4:0,SET:0}};localStorage.setItem(C.KEY,JSON.stringify(s));});
  await page.locator('#undoLastChange').click();assert.equal((await state()).records['2026-10-02'].note,'別の画面で修正');assert.match(await page.locator('#studyToast').innerText(),/別の画面/);
  console.log('PASS undo cannot overwrite a newer external record');
  await page.reload();await page.locator('#nav-records').click();await page.locator('[data-day="2026-10-02"]').click();await page.locator('[data-action=clear-day]').click();await page.clock.runFor(15050);assert.equal(await page.locator('#undoLastChange').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS undo expires and new drafts are never replaced');
  for(const stage of ['reset','undo']){
   const raceContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:'ja-JP'}),racePage=await raceContext.newPage();
   try{
    racePage.on('pageerror',e=>errors.push(e.message));
    await racePage.addInitScript(()=>{
     const control=window.__undoAdapter={hold:false,release:null};
     window.PaperRepositoryFactory=options=>{
      const repository=window.PaperRepository.createLocal(options);
      return {...repository,async save(next,saveOptions){if(control.hold)await new Promise(resolve=>{control.release=resolve});return repository.save(next,saveOptions);}};
     };
    });
    await racePage.clock.install({time:new Date('2026-10-27T12:00:00Z')});await racePage.goto(url);
    await racePage.evaluate(()=>{const C=window.PaperAttendance,s=C.seed(C.clock());s.records['2026-10-27']={...C.empty(s),start:'09:00',end:'18:00',note:'保存済みの作業',phases:['design'],allocation:{P1:4,P2:3,P3:1,P4:0,SET:0}};localStorage.setItem(C.KEY,JSON.stringify(s));});await racePage.reload();
    const raceState=()=>racePage.evaluate(()=>JSON.parse(localStorage.getItem(window.PaperAttendance.KEY))),savedRecord=(await raceState()).records['2026-10-27'];
    const settle=()=>racePage.waitForFunction(()=>document.querySelector('#previewApp').getAttribute('aria-busy')!=='true');
    await racePage.locator('#detailTab-work').click();
    if(stage==='undo'){await racePage.locator('#resetPunch').click();await settle();}
    await racePage.evaluate(()=>window.__undoAdapter.hold=true);
    await racePage.locator(stage==='reset'?'#resetPunch':'#undoLastChange').click();
    await racePage.waitForFunction(()=>typeof window.__undoAdapter.release==='function');
    const newNote=stage==='reset'?'打刻取消の保存中に書き足した内容':'元に戻す処理の保存中に書き足した内容';
    await racePage.locator('#workNote').fill(newNote);
    await racePage.locator('#detailTab-work').click();
    assert.equal((await raceState()).records['2026-10-27'].note,savedRecord.note,'typing during a pending save remains a separate draft');
    await racePage.evaluate(()=>{const control=window.__undoAdapter;control.hold=false;control.release();control.release=null;});await settle();
    if(stage==='reset'){await racePage.locator('#undoLastChange').click();await settle();}
    assert.deepEqual((await raceState()).records['2026-10-27'],savedRecord,'Undo restores the persisted record independently of newer drafts');
    assert.equal(await racePage.locator('#workNote').inputValue(),newNote,'Undo must retain work typed while '+stage+' persistence was pending');
    assert.match(await racePage.locator('#workSaveStatus').innerText(),/未保存/);
    await racePage.locator('[data-action=retry-work]').click();await settle();
    assert.deepEqual((await raceState()).records['2026-10-27'],{...savedRecord,note:newNote},'the retained draft can be saved without losing restored times or allocation');
    console.log('PASS work notes typed during delayed '+stage+' persistence survive Undo and can be saved');
   }finally{await raceContext.close();}
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
}
run().then(()=>server.close(),e=>{console.error(e);server.close();process.exitCode=1});
