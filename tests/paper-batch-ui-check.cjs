"use strict";
// Run with Playwright/Chromium; PAPER_PLAYWRIGHT_MODULE can point to an installed module.
const {chromium}=require(process.env.PAPER_PLAYWRIGHT_MODULE||"playwright");
const assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),server=http.createServer((req,res)=>{
 const file=path.resolve(root,"."+new URL(req.url,"http://local").pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
async function run(){
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAPER_CHROMIUM_PATH||(fs.existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]}),errors=[];
 const url="http://127.0.0.1:"+server.address().port+"/day-designs/a-paper.html?screen=1";
 const fresh=async time=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"ja-JP"}),page=await context.newPage();
  page.on("pageerror",error=>errors.push(error.message));await page.clock.install({time:new Date(time)});await page.goto(url);
  await page.evaluate(()=>{
   const C=window.PaperAttendance,now=C.clock(),state=C.seed(now);state.records={};
   for(const day of C.dates(C.FIRST,C.add(now.day,-1)))if(C.workday(day))state.records[day]={...C.empty(state),leave:"holiday"};
   const work=(end,breakMinutes,hours)=>({...C.empty(state),start:"09:00",end,breakMinutes,note:"休日のシステム対応",allocation:{P1:hours,P2:0,P3:0,P4:0,SET:0}});
   state.records["2026-10-20"]={...C.empty(state),leave:"paid"};
   state.records["2026-10-24"]=work("18:00",60,8);
   state.records["2026-10-25"]=work("11:00",0,2);
   localStorage.setItem(C.KEY,JSON.stringify(state));
  });await page.reload();return page;
 };
 const state=page=>page.evaluate(()=>JSON.parse(localStorage.getItem(window.PaperAttendance.KEY)));
 const record=async(page,day="2026-10-27")=>(await state(page)).records[day];
 const change=async(page,id,value)=>{if(['startTime','endTime'].includes(id))await page.locator('#homeTimeEditor').evaluate(n=>n.open=true);await page.locator("#"+id).fill(value);await page.locator("#"+id).dispatchEvent("change");};
 const edit=async(page,day)=>{await page.locator("#nav-records").click();await page.locator(".paper-record[data-day='"+day+"']").click();assert.equal(await page.locator("#editDate").inputValue(),day);};
 const jump=async(page,day)=>{await change(page,"editDate",day);assert.equal(await page.locator("#editDate").inputValue(),day);};
 const save=async page=>{await page.locator("#dayForm button[type=submit]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();};
 const positions=page=>page.evaluate(()=>Object.fromEntries([".hero-composition","#punchActions",".time-area","#restEditor",".detail-tabs"].map(selector=>{const box=document.querySelector(selector).getBoundingClientRect();return[selector,{top:box.top+scrollY,height:box.height}];})));
 try{
  // An ordinary first punch must not warn about a break that has not yet occurred.
  const page=await fresh("2026-10-27T00:00:00Z");
  await page.locator("#startPunch").click();await page.clock.runFor(900);
  assert.equal((await record(page)).start,"09:00");assert.equal((await record(page)).allocation.P1,0);
  assert.doesNotMatch(await page.locator("#studyToast").innerText(),/マイナス|休憩時間を引いた/);
  assert.equal(await page.locator("#studyToast").evaluate(node=>node.classList.contains("is-warning")),false);
  assert.equal(await page.locator("#todayWorked").innerText(),"0:00");
  await page.clock.setSystemTime(new Date("2026-10-27T02:00:00Z"));
  await edit(page,"2026-10-27");await page.locator("#editNote").fill("退勤前の作業メモ");const workingRevision=(await state(page)).revision;await save(page);
  assert.ok((await state(page)).revision>workingRevision);assert.equal((await record(page)).end,"");assert.equal((await record(page)).allocation.P1,0);assert.equal((await record(page)).note,"退勤前の作業メモ");
  console.log("PASS first-punch warning suppression, nonnegative running hours and editing an unfinished workday");

  // Automatic P1 follows time/break edits while every manually split non-P1 value survives.
  await page.locator("#nav-home").click();await page.clock.setSystemTime(new Date("2026-10-27T09:00:00Z"));await page.locator("#endPunch").click();await page.clock.runFor(900);assert.equal((await record(page)).allocation.P1,8);
  await page.locator("[data-detail=allocation]").click();await page.locator("#allocP1").fill("4");await page.locator("#allocP2").fill("4");await page.locator("#allocationForm button[type=submit]").click();
  await page.clock.setSystemTime(new Date("2026-10-27T09:15:00Z"));await page.locator("#endPunch").click();await page.clock.runFor(900);assert.equal((await record(page)).allocation.P1,4.25);assert.equal((await record(page)).allocation.P2,4);
  await page.locator("#allocP1").fill("4.75");await page.locator("#allocP2").fill("3.5");
  await page.locator("[data-action=rest]").click();await page.locator("#restHours").fill("1");await page.locator("#restMinutes").fill("30");await page.locator("#restForm button[type=submit]").click();assert.equal((await record(page)).allocation.P1,3.75);assert.equal((await record(page)).allocation.P2,4);
  assert.equal(Number(await page.locator("#allocP1").inputValue()),4.25);assert.equal(Number(await page.locator("#allocP2").inputValue()),3.5,"unsaved non-P1 draft must survive without becoming a saved allocation");
  await page.locator("#allocP1").fill("3.75");await page.locator("#allocP2").fill("4");await page.locator("#allocationForm button[type=submit]").click();
  await change(page,"endTime","18:45");assert.equal((await record(page)).allocation.P1,4.25);assert.equal((await record(page)).allocation.P2,4);
  await edit(page,"2026-10-27");await change(page,"editEnd","19:45");assert.equal(Number(await page.locator("#editAllocP1").inputValue()),5.25);assert.equal(Number(await page.locator("#editAllocP2").inputValue()),4);
  await change(page,"editBreak","02:00");assert.equal(Number(await page.locator("#editAllocP1").inputValue()),4.75);
  await page.locator("#editAllocP1").fill("4.25");await page.locator("#editAllocP2").fill("4.5");await page.locator("#editNote").fill("手動配分を維持する");await save(page);assert.equal((await record(page)).allocation.P1,4.25);assert.equal((await record(page)).allocation.P2,4.5);
  const splitRevision=(await state(page)).revision;await change(page,"editBreak","09:00");assert.equal(Number(await page.locator("#editAllocP1").inputValue()),0);assert.equal(Number(await page.locator("#editAllocP2").inputValue()),4.5);await save(page);
  assert.equal((await state(page)).revision,splitRevision);assert.match(await page.locator("#studyToast").innerText(),/工数合計/);assert.equal((await record(page)).breakMinutes,120);
  await change(page,"editBreak","20:00");await save(page);assert.equal((await record(page)).breakMinutes,1200);assert.equal((await record(page)).allocation.P2,4.5);assert.match(await page.locator("#studyToast").innerText(),/マイナス|休憩時間を引いた/);
  await page.locator("#nav-submit").click();await page.locator("[data-action=submit-period][data-index='2']").click();assert.match(await page.locator(".submission-issue").filter({has:page.locator("[data-day='2026-10-27']")}).innerText(),/マイナス/);assert.equal(await page.locator("[data-action=confirm-submission]").isDisabled(),true);
  console.log("PASS home/editor P1 adjustments preserve manual splits, reject over-allocation and preserve negative-save/submit separation");

  // The home leave editor and daily editor must share the same one-day source rules.
  const comp=await fresh("2026-10-27T12:00:00Z");await comp.locator("[data-detail=leave]").click();await comp.locator('[data-action="home-leave"][data-leave="comp"]').click();assert.equal(await comp.locator("#leaveSourceDay").isVisible(),true);
  await comp.locator("#leaveSourceDay").selectOption("2026-10-24");await comp.locator("#leaveForm button[type=submit]").click();await comp.locator("[data-action=confirm-leave-request]").click();await comp.waitForFunction(()=>!document.querySelector("#paperDialog").open&&document.querySelector("#previewApp").getAttribute("aria-busy")!=="true");assert.equal((await record(comp)).leave,"comp");assert.equal((await record(comp)).sourceDay,"2026-10-24");
  await comp.reload();await comp.locator("[data-detail=leave]").click();assert.equal(await comp.locator("#leaveType").inputValue(),"comp");assert.equal(await comp.locator("#leaveSourceDay").inputValue(),"2026-10-24");
  for(const width of [320,390,430]){
   await comp.setViewportSize({width,height:844});assert.ok(await comp.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"home comp overflow "+width);
   const contentRight=await comp.locator("#leaveForm").evaluate(node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth);}),button=await comp.locator("#leaveForm button[type=submit]").boundingBox();assert.ok(Math.abs(contentRight-button.x-button.width)<=1,"leave send must align with the form content's right edge at "+width);
  }
  await comp.setViewportSize({width:390,height:844});await comp.locator("[data-detail=summary]").click();assert.equal(await comp.locator("#homePaidLeave").innerText(),"1日");
  await edit(comp,"2026-10-26");await comp.locator('[data-action="editor-leave"][data-leave="comp"]').click();assert.equal(await comp.locator("#editSourceDay").isVisible(),true);assert.equal(await comp.locator("#editSourceDay option[value='2026-10-24']").count(),0,"already-used source must not be offered twice");
  // Deliberately bypass the option filter: save processing must still reject duplicate use.
  await comp.locator("#editSourceDay").evaluate(node=>node.add(new Option("使用済み元日","2026-10-24")));await comp.locator("#editSourceDay").selectOption("2026-10-24");const duplicateRevision=(await state(comp)).revision;await save(comp);assert.equal((await state(comp)).revision,duplicateRevision);assert.equal((await record(comp,"2026-10-26")).leave,"holiday");assert.match(await comp.locator("#studyToast").innerText(),/代休|使用|紐付/);
  await comp.locator("#editSourceDay").selectOption("2026-10-25");await save(comp);assert.equal((await record(comp,"2026-10-26")).sourceDay,"2026-10-25");
  await jump(comp,"2026-10-24");const linkedRevision=(await state(comp)).revision;await comp.locator("[data-action=clear-day]").click();assert.equal((await state(comp)).revision,linkedRevision);assert.equal((await record(comp,"2026-10-24")).start,"09:00");assert.match(await comp.locator("#studyToast").innerText(),/代休|紐付/);
  await change(comp,"editEnd","09:30");await save(comp);assert.equal((await state(comp)).revision,linkedRevision);assert.equal((await record(comp,"2026-10-24")).end,"18:00");
  await jump(comp,"2026-10-26");await comp.locator('[data-action="editor-leave"][data-leave="holiday"]').click();await save(comp);assert.equal((await record(comp,"2026-10-26")).sourceDay,"");await jump(comp,"2026-10-25");await comp.locator("[data-action=clear-day]").click();assert.equal(await record(comp,"2026-10-25"),undefined);
  console.log("PASS one-to-one compensatory leave in both editors, right-aligned send, duplicate-save protection and safe source removal");

  // A comp day suppresses missing-entry warnings without becoming paid leave or shifting the home layout.
  await comp.locator("#nav-home").click();const clearPositions=await positions(comp);assert.equal(await comp.locator("#homeMissingNotice").isVisible(),false);assert.equal(await comp.locator("#homePaidLeave").innerText(),"1日");
  await comp.evaluate(()=>{const C=window.PaperAttendance,s=JSON.parse(localStorage.getItem(C.KEY));delete s.records["2026-10-23"];s.revision++;localStorage.setItem(C.KEY,JSON.stringify(s));});await comp.reload();assert.equal(await comp.locator("#homeMissingNotice").isVisible(),true);assert.deepEqual(await positions(comp),clearPositions);
  await edit(comp,"2026-10-27");for(const width of [320,390,430]){await comp.setViewportSize({width,height:844});assert.ok(await comp.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"comp editor overflow "+width);assert.equal(await comp.locator("#editSourceDay").isVisible(),true);}
  console.log("PASS compensatory leave excluded from paid totals, missing-warning layout stability and mobile source controls");

  // Persisted or forged duplicate links must also fail the guarded submission path.
  const guard=await fresh("2026-10-27T12:00:00Z");await guard.evaluate(()=>{const C=window.PaperAttendance,s=JSON.parse(localStorage.getItem(C.KEY));for(const day of ["2026-10-26","2026-10-27"])s.records[day]={...C.empty(s),leave:"comp",sourceDay:"2026-10-24"};s.revision++;localStorage.setItem(C.KEY,JSON.stringify(s));});await guard.reload();
  const openSubmission=async()=>{
   if(await guard.locator("#paperDialog[open] [data-action=confirm-submission]").count()){
    assert.match(await guard.locator("#paperDialog .dialog-heading").innerText(),/2026\/10\/01 〜 2026\/10\/31/);return;
   }
   await guard.locator("#nav-submit").click();await guard.locator("[data-action=submit-period][data-index='2']").click();
  };await openSubmission();
  assert.equal(await guard.locator("[data-action=confirm-submission]").isDisabled(),true);const issues=await guard.locator(".submission-issues").innerText();assert.match(issues,/2026\/10\/26/);assert.match(issues,/2026\/10\/27/);assert.match(issues,/代休|使用|紐付/);assert.equal(await guard.locator(".submission-issue [data-day='2026-10-25']").count(),0,"a valid two-hour Sunday must not require paid leave");
  let downloads=0;guard.on("download",()=>downloads++);await guard.locator("[data-action=confirm-submission]").evaluate(node=>node.disabled=false);await guard.locator("[data-action=confirm-submission]").click();assert.equal(downloads,0);assert.equal(Object.keys((await state(guard)).submissions).length,0);assert.equal(await guard.locator("[data-action=confirm-submission]").isDisabled(),true);
  await guard.locator("[data-action=missing-day][data-day='2026-10-27']").click();await guard.locator("#editSourceDay").selectOption("2026-10-25");await save(guard);await guard.waitForFunction(()=>document.querySelector("#paperDialog[open] [data-action=confirm-submission]"));await openSubmission();assert.equal(await guard.locator(".submission-issue").count(),0);assert.equal(await guard.locator("[data-action=confirm-submission]").isEnabled(),true);
  assert.deepEqual(errors,[]);console.log("PASS duplicate-link submission guard and valid short holiday work after all links are corrected");
 }finally{await browser.close();}
}
run().then(()=>server.close(),error=>{console.error(error);server.close();process.exitCode=1});
