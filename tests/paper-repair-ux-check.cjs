"use strict";
const {chromium}=require(process.env.PAPER_PLAYWRIGHT_MODULE||"playwright");
const assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),server=http.createServer((req,res)=>{
 const file=path.resolve(root,"."+new URL(req.url,"http://local").pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
async function run(){
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAPER_CHROMIUM_PATH||(fs.existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"ja-JP"}),page=await context.newPage(),errors=[];
  page.on("pageerror",e=>errors.push(e.message));let downloads=0;page.on("download",()=>downloads++);
  await page.clock.install({time:new Date("2026-10-27T12:00:00Z")});
  await page.goto("http://127.0.0.1:"+server.address().port+"/day-designs/a-paper.html?screen=1");
  await page.evaluate(()=>{
   const C=window.PaperAttendance,now=C.clock(),state=C.seed(now);state.records={};
   for(const day of C.dates(C.month(now.day).start,now.day))if(C.workday(day))state.records[day]={...C.empty(state),leave:"holiday"};
   const work=(changes={})=>({...C.empty(state),start:"09:00",end:"18:00",note:"通常業務",allocation:{P1:8,P2:0,P3:0,P4:0,SET:0},...changes});
   state.records["2026-10-01"]=work({note:" "});
   state.records["2026-10-02"]=work({end:"14:00",allocation:{P1:4,P2:0,P3:0,P4:0,SET:0}});
   delete state.records["2026-10-05"];
   state.records["2026-10-06"]=work({end:"09:30",allocation:{P1:0,P2:0,P3:0,P4:0,SET:0}});
   localStorage.setItem(C.KEY,JSON.stringify(state));
  });await page.reload();
  const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem(window.PaperAttendance.KEY)));
  const editDay=day=>page.waitForFunction(value=>document.querySelector("#editDate")?.value===value,day);
  const confirmOpen=()=>page.waitForFunction(()=>document.querySelector("#paperDialog").open&&document.querySelector("[data-action=confirm-submission]"));
  const save=()=>page.locator("#dayForm button[type=submit]").click();
  await page.locator("#nav-submit").click();await page.locator("#testSubmission").uncheck();
  await page.locator('[data-action="submit-period"][data-index="2"]').click();
  assert.equal(await page.locator(".submission-issue").count(),4);
  await page.locator('[data-action="missing-day"][data-day="2026-10-01"]').click();await editDay("2026-10-01");
  assert.match(await page.locator(".submission-repair-context").innerText(),/あと\s*4日/);
  await page.locator("#editNote").fill("修正中の作業内容");await page.goBack();await confirmOpen();
  assert.match(await page.locator("#paperDialog").innerText(),/2026\/10\/01 〜 2026\/10\/31/);
  assert.equal(await page.locator("[data-action=confirm-submission]").innerText(),"Excel出力");
  await page.goForward();await editDay("2026-10-01");assert.equal(await page.locator("#editNote").inputValue(),"修正中の作業内容");
  console.log("PASS repair preserves selected period, submission mode and editor drafts through browser Back/Forward");
  for(const width of [320,390,430]){
   await page.setViewportSize({width,height:740});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"repair screen must not overflow at "+width);
   for(const selector of [".form-save-primary","[data-action=repair-save-return]"]){
    const visible=await page.locator(selector).evaluate(button=>{const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&button.contains(hit);});
    assert.ok(visible,"repair action must stay reachable at "+width+": "+selector);
   }
   if(process.env.PAPER_SCREENSHOT_DIR){fs.mkdirSync(process.env.PAPER_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PAPER_SCREENSHOT_DIR,"repair-"+width+".png")});}
  }
  await page.setViewportSize({width:390,height:844});
  const before=(await state()).revision;await page.locator("#editAllocP1").fill("7");await save();
  assert.equal((await state()).revision,before);assert.equal(await page.locator("#editDate").inputValue(),"2026-10-01");assert.match(await page.locator("#studyToast").innerText(),/工数合計/);
  await page.locator("#editAllocP1").fill("8");
  await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error("quota")};});await save();
  assert.equal(await page.locator("#editDate").inputValue(),"2026-10-01");assert.equal(await page.locator("#editNote").inputValue(),"修正中の作業内容");
  await page.evaluate(()=>Storage.prototype.setItem=window.originalSetItem);await save();await editDay("2026-10-02");
  assert.match(await page.locator(".submission-repair-context").innerText(),/あと\s*3日/);
  console.log("PASS failed or invalid saves cannot advance; valid save advances directly to the next issue");
  await page.locator('[data-action="editor-leave"][data-leave="am"]').click();await save();
  assert.equal(await page.locator("[data-action=confirm-leave-request]").count(),1);
  await page.locator('.paper-actions [data-action="close-dialog"]').click();assert.equal(await page.locator("#editDate").inputValue(),"2026-10-02");
  await save();await page.locator("[data-action=confirm-leave-request]").click();await editDay("2026-10-05");
  assert.equal((await state()).records["2026-10-02"].leave,"am");
  await page.locator('[data-action="editor-leave"][data-leave="paid"]').click();await save();await page.locator("[data-action=confirm-leave-request]").click();await editDay("2026-10-06");
  assert.equal((await state()).records["2026-10-05"].leave,"paid");
  console.log("PASS half-day and full-day leave confirmation continues the same repair flow; cancellation keeps the draft");
  await page.locator("#editBreak").fill("01:30");await save();
  assert.equal((await state()).records["2026-10-06"].breakMinutes,90);assert.equal(await page.locator("#editDate").inputValue(),"2026-10-06");
  assert.match(await page.locator("#studyToast").innerText(),/マイナス/);
  await page.locator("[data-action=repair-save-return]").click();await confirmOpen();
  assert.equal(await page.locator(".submission-issue").count(),1);assert.equal(await page.locator("[data-action=confirm-submission]").isDisabled(),true);
  await page.locator('[data-action="missing-day"][data-day="2026-10-06"]').click();await editDay("2026-10-06");
  await page.locator("#editEnd").fill("18:00");await page.locator("#editBreak").fill("01:00");await save();await confirmOpen();
  assert.equal(await page.locator(".submission-issue").count(),0);assert.equal(await page.locator("[data-action=confirm-submission]").isEnabled(),true);assert.equal(downloads,0);
  assert.match(await page.locator("#paperDialog").innerText(),/2026\/10\/01 〜 2026\/10\/31/);assert.equal(await page.locator("[data-action=confirm-submission]").innerText(),"Excel出力");
  console.log("PASS negative hours can be saved but remain an issue; the final valid repair returns to the same revalidated confirmation without submitting");
  await page.locator('.paper-actions [data-action="close-dialog"]').click();await page.locator("#nav-records").click();await page.locator('[data-action="edit-day"][data-day="2026-10-01"]').click();
  assert.equal(await page.locator(".submission-repair-context").count(),0);await page.locator("#editNote").fill("通常の編集に戻りました");await save();
  assert.equal(await page.locator("#editDate").inputValue(),"2026-10-01");assert.equal(await page.locator("dialog[open]").count(),0);assert.equal((await state()).records["2026-10-01"].note,"通常の編集に戻りました");
  assert.deepEqual(errors,[]);console.log("PASS ordinary editor saves do not enter a stale submission repair flow");
 }finally{await browser.close();}
}
run().then(()=>server.close(),error=>{console.error(error);server.close();process.exitCode=1});
