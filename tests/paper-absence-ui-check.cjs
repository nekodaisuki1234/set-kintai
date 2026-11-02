"use strict";
const {unknownTime}=require("./paper-calendar-fixture.cjs");
// Run with Playwright/Chromium; PAPER_PLAYWRIGHT_MODULE can point to an installed module.
const {chromium}=require(process.env.PAPER_PLAYWRIGHT_MODULE||"playwright");
const assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),server=http.createServer((req,res)=>{
 const file=path.resolve(root,"."+new URL(req.url,"http://local").pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
const DAY="2026-10-27",START="2026-10-27T00:00:00Z",FINISHED="2026-10-27T12:00:00Z";
const ENTRIES=[{file:"a-paper.html?screen=1",mode:"demo"},{file:"a-paper-app.html",mode:"local"}];
async function run(){
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAPER_CHROMIUM_PATH||(fs.existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]}),errors=[];
 const origin="http://127.0.0.1:"+server.address().port;
 const ready=async page=>{await page.locator('#startPunch').waitFor();await page.locator('#homeTimeEditor').evaluate(n=>n.open=true);};
 const raw=page=>page.evaluate(()=>localStorage.getItem(window.PaperConfig.storageKey));
 const stored=async page=>JSON.parse(await raw(page));
 const record=async(page,day=DAY)=>(await stored(page)).records[day];
 const text=async(page,selector)=>(await page.locator(selector).textContent()).replace(/\s+/g,"");
 const absence=async(page,selector,value)=>assert.equal(await text(page,selector),value);
 const change=async(page,id,value)=>{if(['startTime','endTime'].includes(id))await page.locator('#homeTimeEditor').evaluate(n=>n.open=true);await page.locator("#"+id).fill(value);await page.locator("#"+id).dispatchEvent("change");await page.clock.runFor(30);};
 const save=async page=>{await page.locator("#dayForm button[type=submit]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();await page.clock.runFor(30);};
 const home=async page=>{await page.locator("#nav-home").click();await page.locator("[data-detail=summary]").click();};
 const edit=async(page,day=DAY)=>{await page.locator("#nav-records").click();await page.locator(".paper-record[data-day='"+day+"']").click();assert.equal(await page.locator("#editDate").inputValue(),day);};
 const leave=async(page,value)=>{await page.locator("[data-detail=leave]").click();await page.locator('[data-action="home-leave"][data-leave="'+value+'"]').click();await page.locator("#leaveForm button[type=submit]").click();await page.locator("[data-action=confirm-leave-request]").click();await page.waitForFunction(()=>!document.querySelector("#paperDialog").open&&document.querySelector("#previewApp").getAttribute("aria-busy")!=="true");await page.clock.runFor(30);await page.locator("[data-detail=summary]").click();};
 const warning=async(page,value)=>{
  const toast=page.locator("#studyToast");assert.equal(await toast.evaluate(node=>node.classList.contains("is-warning")&&node.classList.contains("visible")),true);
  assert.match(await toast.innerText(),/欠勤/);assert.match(await toast.innerText(),value);
 };
 const noShortfallWarning=async page=>assert.doesNotMatch(await page.locator("#studyToast").innerText(),/欠勤時間|不足しています/);
 const positions=page=>page.evaluate(()=>Object.fromEntries([".hero-composition","#punchActions",".time-area","#restEditor",".detail-tabs",".performance-panel"].map(selector=>{const box=document.querySelector(selector).getBoundingClientRect();return[selector,{top:box.top+scrollY,height:box.height}];})));
 const noOverflow=async(page,label)=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+" must not overflow the viewport");
 const fresh=async entry=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"ja-JP"}),page=await context.newPage();
  page.on("pageerror",error=>errors.push(entry.mode+": "+error.message));await page.clock.install({time:new Date(START)});await page.goto(origin+"/day-designs/"+entry.file);await ready(page);
  await page.evaluate(()=>{
   const C=window.PaperAttendance,config=window.PaperConfig,now=C.clock(),state=config.mode==="local"?C.createState(now,{startDay:"2026-09-01"}):C.seed(now);
   state.settings.attendanceStartDay="2026-09-01";state.records={};state.submissions={};
   const work=(end,breakMinutes,hours)=>({...C.empty(state),start:"09:00",end,breakMinutes,note:"作業内容あり",allocation:{P1:hours,P2:0,P3:0,P4:0,SET:0}});
   state.records["2026-09-30"]=work("16:00",60,6);
   state.records["2026-10-12"]=work("10:00",0,1); // Official holiday.
   state.records["2026-10-20"]={...C.empty(state),leave:"am"}; // Incomplete half leave remains missing.
   state.records["2026-10-21"]={...C.empty(state),start:"09:00",note:"退勤未入力"};
   state.records["2026-10-22"]={...C.empty(state),leave:"paid"};
   state.records["2026-10-24"]=work("10:00",0,1); // Saturday.
   localStorage.setItem(config.storageKey,JSON.stringify(state));
  });await page.reload();await ready(page);return {context,page};
 };
 try{
  for(const entry of ENTRIES){
   const {context,page}=await fresh(entry),label=entry.mode;
   assert.equal(await page.evaluate(()=>window.PaperConfig.mode),entry.mode);
   await absence(page,"#homeAbsence","0時間00分");assert.equal(await page.locator("#homeMissingNotice").isVisible(),true);
   await page.locator("#startPunch").click();await page.clock.runFor(900);
   assert.equal((await record(page)).start,"09:00");await absence(page,"#homeAbsence","0時間00分");await noShortfallWarning(page);
   assert.equal(await page.locator("#studyToast").evaluate(node=>node.classList.contains("is-warning")),false);
   await page.clock.setSystemTime(new Date(FINISHED));

   // A completed workday counts net time after its break, without counting missing days.
   const beforeWarning=await positions(page);await change(page,"endTime","17:00");
   assert.equal((await record(page)).allocation.P1,7);await absence(page,"#homeAbsence","1時間00分");await warning(page,/1時間00分/);
   assert.deepEqual(await positions(page),beforeWarning,label+" a shortfall toast must not shift the home layout");
   await page.reload();await ready(page);await absence(page,"#homeAbsence","1時間00分");
   await page.locator("[data-action=edit-plan]").click();await page.locator("#planHoursInput").fill("40");await page.locator("#planForm button[type=submit]").click();
   await page.waitForFunction(()=>!document.querySelector("#paperDialog").open);await absence(page,"#homeAbsence","1時間00分");
   assert.equal((await stored(page)).settings.plannedHoursByMonth["2026-10"],40,"monthly plan changes must not redefine the daily eight-hour baseline");

   // Half leave credits four hours; a leave-only correction must replace an old warning.
   await change(page,"endTime","14:00");await absence(page,"#homeAbsence","4時間00分");await warning(page,/4時間00分/);
   await leave(page,"am");await absence(page,"#homeAbsence","0時間00分");await noShortfallWarning(page);
   assert.equal(await page.locator("#studyToast").evaluate(node=>node.classList.contains("is-warning")),false);
   await change(page,"endTime","13:00");await absence(page,"#homeAbsence","1時間00分");await warning(page,/1時間00分/);
   await leave(page,"");await absence(page,"#homeAbsence","5時間00分");await warning(page,/5時間00分/);
   await change(page,"endTime","18:00");await absence(page,"#homeAbsence","0時間00分");await noShortfallWarning(page);
   console.log("PASS "+label+" missing/incomplete/holiday/weekend exclusions, first-punch suppression, net-time shortage, four-hour half leave credit and independent monthly planning");

   // An editor preview cannot change monthly persisted totals until its save succeeds.
   await edit(page);const original=await raw(page);await change(page,"editEnd","17:00");
   await absence(page,"#editAbsence","1時間00分");assert.equal(await raw(page),original);await home(page);await absence(page,"#homeAbsence","0時間00分");
   await edit(page);assert.equal(await page.locator("#editEnd").inputValue(),"17:00");
   await page.evaluate(()=>{window.absenceOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error("quota")};});
   await save(page);assert.equal(await raw(page),original);assert.equal(await page.locator("#editEnd").inputValue(),"17:00");await noShortfallWarning(page);
   assert.match(await page.locator("#studyToast").innerText(),/保存|記録/);
   await page.evaluate(()=>Storage.prototype.setItem=window.absenceOriginalSetItem);await save(page);
   assert.equal((await record(page)).end,"17:00");await warning(page,/1時間00分/);await home(page);await absence(page,"#homeAbsence","1時間00分");
   await page.locator("#nav-records").click();await absence(page,"#monthAbsence","1時間00分");
   await page.locator("[data-action=month-prev]").click();assert.equal(await page.locator("#monthInput").inputValue(),"2026-09");await absence(page,"#monthAbsence","2時間00分");
   await page.locator("[data-action=month-next]").click();await absence(page,"#monthAbsence","1時間00分");

   // The daily editor shares the same leave credit and successful-save-only toast.
   await page.locator(".paper-record[data-day='"+DAY+"']").click();await change(page,"editEnd","14:00");await save(page);await warning(page,/4時間00分/);
   await page.locator('[data-action="editor-leave"][data-leave="pm"]').click();await save(page);await absence(page,"#editAbsence","0時間00分");await noShortfallWarning(page);
   await home(page);await absence(page,"#homeAbsence","0時間00分");

   // All widths retain the same positions when a shortfall is added or resolved.
   for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});await change(page,"endTime","14:00");const clear=await positions(page);
    await change(page,"endTime","13:00");await warning(page,/1時間00分/);await absence(page,"#homeAbsence","1時間00分");
    assert.deepEqual(await positions(page),clear,label+" shortfall/clear home geometry at "+width);await noOverflow(page,label+" home "+width);
   }
   await edit(page);
   for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});await absence(page,"#editAbsence","1時間00分");await noOverflow(page,label+" editor "+width);
    assert.equal(await page.locator("#editAbsence").evaluate(node=>node.tagName==="OUTPUT"&&!node.isContentEditable),true);
    const rect=await page.locator("#editAbsence").boundingBox();assert.ok(rect.width>0&&rect.x>=0&&rect.x+rect.width<=width+1,label+" daily absence must remain visible at "+width);
   }
   await page.setViewportSize({width:390,height:844});
   for(const day of ["2026-10-12","2026-10-24"]){
    await change(page,"editDate",day);await change(page,"editEnd","12:00");await save(page);await absence(page,"#editAbsence","0時間00分");await noShortfallWarning(page);
   }
   await home(page);await absence(page,"#homeAbsence","1時間00分");
   console.log("PASS "+label+" saved-versus-draft totals, storage-failure protection, selected-month isolation, editor leave correction and 320/390/430px warning geometry");

   // Invalid negative actual time keeps its own warning and never becomes a successful shortage hint.
   await edit(page);await page.locator('[data-action="editor-leave"][data-leave=""]').click();await change(page,"editEnd","10:00");await change(page,"editBreak","02:00");await save(page);
   assert.equal((await record(page)).breakMinutes,120);assert.equal((await record(page)).end,"10:00");
   assert.match(await page.locator("#studyToast").innerText(),/マイナス|休憩時間を引いた/);assert.doesNotMatch(await page.locator("#studyToast").innerText(),/欠勤/);
   await home(page);await absence(page,"#homeAbsence","8時間00分");
   assert.equal(await page.locator("#todayWorked").innerText(),"−1:00");
   await page.clock.setSystemTime(new Date(unknownTime));await page.reload();await ready(page);await absence(page,"#homeAbsence","—");
   console.log("PASS "+label+" preserved negative-save warning priority, bounded absence and unknown-calendar display");
   await context.close();
  }
  assert.deepEqual(errors,[]);console.log("PASS absence integration in both HTML entries without browser errors");
 }finally{await browser.close();}
}
run().then(()=>server.close(),error=>{console.error(error);server.close();process.exitCode=1});
