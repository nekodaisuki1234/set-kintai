"use strict";
// Run with Playwright installed, or set PAPER_PLAYWRIGHT_MODULE to its module path.
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
  page.on("pageerror",e=>errors.push(e.message));
  await page.clock.install({time:new Date("2026-10-27T12:00:00Z")});
  await page.goto("http://127.0.0.1:"+server.address().port+"/day-designs/a-paper.html?screen=1");
  const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem("day-paper-attendance-v1")));
  const fill=async(id,value)=>{if(id==="workNote"||id==="workPlace")await page.locator("[data-detail=work]").click();if((id==='startTime'||id==='endTime')&&!await page.locator('#homeTimeEditor').evaluate(n=>n.open))await page.locator('#homeTimeEditor summary').click();await page.locator("#"+id).fill(value);await page.locator("#"+id).dispatchEvent("change");await page.clock.runFor(300);};
  const heading=title=>page.waitForFunction(t=>document.querySelector("main h1")?.textContent===t,title);
  await fill("startTime","09:00");await fill("endTime","18:00");
  await page.locator("[data-detail=allocation]").click();await page.locator("#allocP1").fill("8");await page.locator("#allocationForm button[type=submit]").click();
  await fill("endTime","18:15");assert.equal((await state()).records["2026-10-27"].end,"18:15");assert.equal((await state()).records["2026-10-27"].allocation.P1,8.25);
  assert.doesNotMatch(await page.locator("#studyToast").innerText(),/工数合計/);assert.equal(await page.locator("dialog[open]").count(),0);
  console.log("PASS positive time corrections automatically adjust P1 without a mismatch warning");
  // Unsaved allocation and rest must survive partial home updates and tab switches.
  await page.locator("#allocP1").fill("7.5");await page.locator("[data-detail=summary]").click();await page.locator("[data-detail=allocation]").click();assert.equal(await page.locator("#allocP1").inputValue(),"7.5");
  await page.locator("[data-action=rest]").click();await page.locator("#restMinutes").fill("37");await page.locator("#nav-records").click();await page.locator("#nav-home").click();
  await page.locator("[data-action=rest]").click();assert.equal(await page.locator("#restMinutes").inputValue(),"37");assert.equal(await page.locator("#allocP1").inputValue(),"7.5");
  await page.locator("#restForm button[type=submit]").click();assert.equal((await state()).records["2026-10-27"].breakMinutes,97);assert.equal(Math.round(Number(await page.locator("#allocP1").inputValue())*60),458);assert.equal(Math.round((await state()).records["2026-10-27"].allocation.P1*60),458);
  console.log("PASS rest and allocation drafts survive navigation, with P1 recalculated when working time changes");
  // A failed auto-save must keep text and expose a working retry action.
  await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error("quota")};});
  await fill("workNote","保存失敗でも残す文章 <test>");assert.equal(await page.locator("#workNote").inputValue(),"保存失敗でも残す文章 <test>");assert.match(await page.locator("#workSaveStatus").innerText(),/未保存/);
  await page.locator("#nav-records").click();await page.locator("#nav-home").click();assert.equal(await page.locator("#workNote").inputValue(),"保存失敗でも残す文章 <test>");
  await page.evaluate(()=>Storage.prototype.setItem=window.originalSetItem);await page.locator("[data-action=retry-work]").click();assert.equal((await state()).records["2026-10-27"].note,"保存失敗でも残す文章 <test>");assert.equal(await page.locator("#previewError").innerText(),"");
  console.log("PASS failed-save text retention, safe escaping and explicit retry");
  await page.locator("#nav-records").click();
  await page.locator("[data-day='2026-10-03']").scrollIntoViewIfNeeded();const before=await page.evaluate(()=>scrollY);
  await page.locator("[data-day='2026-10-03']").click();await page.locator("#editNote").fill("未保存の編集");
  await page.goBack();await heading("10月の勤怠");await page.waitForFunction(y=>Math.abs(scrollY-y)<=1,before);
  await page.goForward();await heading("勤怠の編集");assert.equal(await page.locator("#editNote").inputValue(),"未保存の編集");
  await page.locator("[data-action=editor-prev]").click();await page.locator("[data-action=editor-next]").click();assert.equal(await page.locator("#editNote").inputValue(),"未保存の編集");
  await page.locator("[data-action=editor-back]").click();await heading("10月の勤怠");
  console.log("PASS browser Back/Forward, editor drafts and list scroll restoration");
  await page.locator("#nav-settings").click();await page.locator("#defaultBreak").fill("");const revision=(await state()).revision;await page.locator("#defaultsForm button[type=submit]").click();assert.equal((await state()).revision,revision);
  await page.locator("[data-action=settings-tab][data-tab=sheet]").click();await page.locator("#minHours").fill("");await page.locator('[data-action="project-tab"][data-index="1"]').click();assert.equal(await page.locator("#minHours").inputValue(),"");await page.locator("#settingsForm button[type=submit]").click();assert.equal((await state()).revision,revision);
  console.log("PASS blank numeric fields are not silently stored as zero");
  // Minute changes update the weekly chart, without reconstructing the user's fields.
  await page.locator("#nav-home").click();await page.locator("#resetPunch").click();await page.clock.runFor(600);await fill("startTime","09:00");
  const weekBefore=await page.locator("#weekArea .week-heading strong").innerText();await page.locator("#workNote").focus();await page.clock.runFor(61000);
  assert.notEqual(await page.locator("#weekArea .week-heading strong").innerText(),weekBefore);assert.equal(await page.locator("#workNote").evaluate(n=>n===document.activeElement),true);
  await page.locator("#nav-records").click();await page.locator("[data-day='2026-10-26']").click();await page.locator("#editAllocP1").fill("");assert.doesNotMatch(await page.locator("#allocationState").innerText(),/振り分け完了/);
  for(const width of [320,390,430,1280]){
   await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"editor overflow "+width);
   const arrow=await page.locator("[data-action=editor-prev]").boundingBox();assert.ok(arrow.width>=44&&arrow.height>=44);
   const small=await page.locator("#dayForm input,#dayForm select,#dayForm textarea").evaluateAll(nodes=>nodes.filter(n=>n.type!=="checkbox").filter(n=>parseFloat(getComputedStyle(n).fontSize)<16).map(n=>n.id));assert.deepEqual(small,[]);
  }
  // Download preparation failure must not mark the period as submitted.
  await page.evaluate(()=>{const C=window.PaperAttendance,state=JSON.parse(localStorage.getItem(C.KEY)),now=C.clock(),p=C.month(now.day);for(const day of C.dates(p.start,now.day))if(C.workday(day))state.records[day]={...C.empty(state),leave:"holiday"};state.revision++;localStorage.setItem(C.KEY,JSON.stringify(state));});await page.reload();
  await page.locator("#nav-submit").click();await page.locator("[data-action=submit-period][data-index='2']").click();await page.evaluate(()=>{URL.createObjectURL=()=>{throw Error("download unavailable")};});await page.locator("[data-action=confirm-submission]").click();assert.equal(Object.keys((await state()).submissions).length,0);assert.match(await page.locator("#dialogError").innerText(),/出力できません/);
  assert.deepEqual(errors,[]);console.log("PASS live weekly graph, mobile fonts/touch targets/overflow and failed-export status safety");
 }finally{await browser.close();}
}
run().then(()=>server.close(),e=>{console.error(e);server.close();process.exitCode=1});
