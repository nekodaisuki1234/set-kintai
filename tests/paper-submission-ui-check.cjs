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
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"ja-JP"}),page=await ctx.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.clock.install({time:new Date("2026-10-27T12:00:00Z")});
  const url="http://127.0.0.1:"+server.address().port+"/day-designs/a-paper.html?screen=1";await page.goto(url);
  await page.evaluate(()=>{
   const C=window.PaperAttendance,now=C.clock(),state=C.seed(now);state.records={};
   for(const day of C.dates(C.month(now.day).start,now.day))if(C.workday(day))state.records[day]={...C.empty(state),leave:"holiday"};
   const work=(changes={})=>({...C.empty(state),start:"09:00",end:"18:00",note:"通常の作業内容",allocation:{P1:8,P2:0,P3:0,P4:0,SET:0},...changes});
   state.records["2026-10-01"]=work({end:"14:00",allocation:{P1:4,P2:0,P3:0,P4:0,SET:0}});
   state.records["2026-10-02"]=work({note:" \u3000\t "});
   state.records["2026-10-05"]=work({allocation:{P1:7,P2:0,P3:0,P4:0,SET:0}});
   state.records["2026-10-06"]=work({end:"09:30",allocation:{P1:0,P2:0,P3:0,P4:0,SET:0}});
   localStorage.setItem(C.KEY,JSON.stringify(state));
  });await page.reload();
  const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem(window.PaperAttendance.KEY)));
  const heading=t=>page.waitForFunction(value=>document.querySelector("main h1")?.textContent===value,t);
  const open=async()=>{await page.locator("#nav-submit").click();await page.locator("[data-action=submit-period][data-index='2']").click();};
  const editorOpened=async day=>{await heading("勤怠の編集");assert.equal(await page.locator("#editDate").inputValue(),day);assert.equal(await page.locator("#nav-records").getAttribute("aria-current"),"page");assert.equal(await page.locator("#paperDialog").evaluate(node=>node.open),false);};
  const edit=async day=>{await page.locator("[data-action=missing-day][data-day='"+day+"']").click();await editorOpened(day);};
  const back=async()=>{if(await page.locator("#dayForm").count())await page.locator("[data-action=editor-back]").click();await heading("勤務表の提出");await page.waitForFunction(()=>document.querySelector("#paperDialog").open);};
  await open();assert.equal(await page.locator(".submission-issue").count(),4);assert.equal(await page.locator("[data-action=confirm-submission]").isDisabled(),true);
  const issues=await page.locator(".submission-issues").innerText();for(const text of ["2026/10/01","4時間以下","2026/10/02","作業内容","2026/10/05","工数合計","2026/10/06","マイナス"])assert.ok(issues.includes(text),text);
  let downloads=0;page.on("download",()=>downloads++);
  await page.locator("[data-action=confirm-submission]").evaluate(n=>n.disabled=false);await page.locator("[data-action=confirm-submission]").click();assert.equal(downloads,0);assert.equal(Object.keys((await stored()).submissions).length,0);assert.equal(await page.locator("[data-action=confirm-submission]").isDisabled(),true);
  console.log("PASS dated submission errors and processing guard despite forced button enable");
  const beforeRowNavigation=JSON.stringify(await stored());
  const explanationRow=page.locator("[data-action=missing-day][data-day='2026-10-02']");
  assert.match(await explanationRow.locator(".submission-issue-message").first().innerText(),/作業内容/);
  await explanationRow.locator(".submission-issue-message").first().click();await editorOpened("2026-10-02");await back();
  const paddedRow=page.locator(".submission-issue").filter({has:page.locator("[data-action=missing-day][data-day='2026-10-06']")}),paddedButton=paddedRow.locator("button[data-action=missing-day]");
  assert.equal(await paddedRow.locator("button").count(),1,"a dated issue must be one interactive row");
  const rowBox=await paddedRow.boundingBox(),buttonBox=await paddedButton.boundingBox();
  assert.ok(Math.abs(rowBox.width-buttonBox.width)<=2&&Math.abs(rowBox.height-buttonBox.height)<=2,"the interactive row must cover the full issue card");
  await paddedButton.click({position:{x:3,y:Math.floor(buttonBox.height/2)}});await editorOpened("2026-10-06");await back();
  const keyboardRow=page.locator("[data-action=missing-day][data-day='2026-10-01']");await keyboardRow.focus();await page.keyboard.press("Enter");await editorOpened("2026-10-01");await back();
  assert.equal(await page.locator(".submission-issue").count(),4);assert.equal(JSON.stringify(await stored()),beforeRowNavigation,"opening errors cannot alter attendance");
  console.log("PASS explanation-text and blank-padding row taps, keyboard Enter, matching editor day, Attendance navigation and return to Submit");
  await edit("2026-10-05");const before=(await stored()).revision;await page.locator("#editAllocP1").fill("5");await page.locator("[data-action=repair-save-return]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();assert.equal((await stored()).revision,before);assert.match(await page.locator("#studyToast").innerText(),/工数合計/);assert.equal((await stored()).records["2026-10-05"].allocation.P1,7);
  await page.locator("#editAllocP1").fill("8");await page.locator("[data-action=repair-save-return]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();await back();assert.equal(await page.locator(".submission-issue").count(),3);
  await edit("2026-10-01");await page.locator('[data-action="editor-leave"][data-leave="am"]').click();await page.locator("[data-action=repair-save-return]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();await back();assert.equal(await page.locator(".submission-issue").count(),2);
  await edit("2026-10-02");await page.locator("#editNote").fill("受入テストを実施");await page.locator("[data-action=repair-save-return]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();await back();assert.equal(await page.locator(".submission-issue").count(),1);
  await edit("2026-10-06");await page.locator("#editBreak").fill("01:30");await page.locator("[data-action=repair-save-return]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();assert.equal((await stored()).records["2026-10-06"].breakMinutes,90);await back();assert.match(await page.locator(".submission-issues").innerText(),/マイナス/);assert.equal(await page.locator("[data-action=confirm-submission]").isDisabled(),true);
  console.log("PASS strict allocation editing, half-day short-work exemption, blank-note correction and negative-save/submit separation");
  for(const width of [320,390,430]){await page.setViewportSize({width,height:740});const box=await page.locator("#paperDialog").boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=740,"dialog bounds "+width);}
  await edit("2026-10-06");await page.locator("#editEnd").fill("18:00");await page.locator("#editBreak").fill("01:00");await page.locator("#editAllocP1").fill("8");await page.locator("[data-action=repair-save-return]").click();if(await page.locator("[data-action=confirm-leave-request]").count())await page.locator("[data-action=confirm-leave-request]").click();await back();assert.equal(await page.locator(".submission-issue").count(),0);assert.equal(await page.locator("[data-action=confirm-submission]").isEnabled(),true);
  const download=page.waitForEvent("download");await page.locator("[data-action=confirm-submission]").click();await download;assert.equal((await stored()).submissions["2026-10-01|2026-10-31"].test,true);assert.equal(downloads,1);
  console.log("PASS successful guarded submission only after every issue is fixed");
  const punchCtx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),p=await punchCtx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.clock.install({time:new Date("2026-10-27T00:00:00Z")});await p.goto(url);
  const record=()=>p.evaluate(()=>JSON.parse(localStorage.getItem(window.PaperAttendance.KEY)).records["2026-10-27"]);
  await p.locator("#startPunch").click();await p.clock.runFor(900);assert.equal((await record()).allocation.P1,0);
  await p.clock.setSystemTime(new Date("2026-10-27T09:00:00Z"));await p.locator("#endPunch").click();await p.clock.runFor(900);assert.equal((await record()).allocation.P1,8);for(const key of ["P2","P3","P4","SET"])assert.equal((await record()).allocation[key],0);
  await p.locator("[data-detail=allocation]").click();await p.locator("#allocP1").fill("4");await p.locator("#allocP2").fill("4");await p.locator("#allocationForm button[type=submit]").click();assert.equal((await record()).allocation.P2,4);
  await p.locator("#allocP1").fill("3");await p.locator("#allocationForm button[type=submit]").click();assert.equal((await record()).allocation.P1,4);
  await p.clock.setSystemTime(new Date("2026-10-27T09:01:00Z"));await p.locator("#endPunch").click();await p.clock.runFor(900);assert.equal(Math.round((await record()).allocation.P1*60),241);assert.equal((await record()).allocation.P2,4);
  await p.locator("#homeTimeEditor").evaluate(n=>n.open=true);await p.locator("#endTime").fill("09:30");await p.locator("#endTime").dispatchEvent("change");assert.equal((await record()).end,"09:30");await p.locator("#nav-submit").click();await p.locator("[data-action=submit-period][data-index='2']").click();assert.match(await p.locator(".submission-issue").filter({has:p.locator("[data-day='2026-10-27']")}).innerText(),/マイナス/);
  assert.deepEqual(errors,[]);console.log("PASS P1 auto allocation, valid manual redistribution, mismatch rejection and negative punch records blocked on submit");
 }finally{await browser.close();}
}
run().then(()=>server.close(),e=>{console.error(e);server.close();process.exitCode=1});
