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
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAPER_CHROMIUM_PATH||(fs.existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]}),errors=[];
 try{
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"ja-JP"}),page=await ctx.newPage();page.on("pageerror",error=>errors.push(error.message));
  await page.clock.install({time:new Date("2026-10-27T12:00:00Z")});await page.goto("http://127.0.0.1:"+server.address().port+"/day-designs/a-paper.html?screen=1");await page.locator("#startPunch").waitFor();
  const raw=()=>page.evaluate(()=>localStorage.getItem(window.PaperConfig.storageKey));
  const stored=async()=>JSON.parse(await raw());
  const save=async()=>{await page.locator("#formSaveBar button[type=submit]").click();await page.waitForFunction(()=>document.querySelector("#previewApp").getAttribute("aria-busy")!=="true");};
  const visibleSave=async label=>{
   const button=await page.locator("#formSaveBar button[type=submit]").boundingBox(),nav=await page.locator(".app-nav").boundingBox();
   assert.ok(button.y>=0&&button.y+button.height<=nav.y+1,label+" save must be above mobile navigation");
   assert.ok(button.y+button.height<=await page.evaluate(()=>innerHeight),label+" save must stay inside the viewport");
   assert.ok(button.x>=0&&button.x+button.width<=await page.evaluate(()=>innerWidth),label+" save must fit viewport");
  };
  await page.locator("#nav-settings").click();await page.locator("#defaultNote").fill("いつもの新しい作業");assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/);
  await save();assert.match(await page.locator("#formSaveStatus").innerText(),/保存済み/);const original=await raw(),existing=(await stored()).records;
  await page.locator("[data-action=reset-defaults]").click();assert.equal(await raw(),original,"standard reset must not write anything");assert.notEqual(await page.locator("#defaultNote").inputValue(),"いつもの新しい作業");assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/);
  await page.locator("[data-action=settings-tab][data-tab=sheet]").click();await page.locator("#minHours").fill("145");assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/,"generic numeric fields must expose dirty status immediately");
  await page.locator("[data-action=settings-tab][data-tab=defaults]").click();assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/);assert.equal(await raw(),original,"tab navigation must keep reset and sheet edits as drafts");
  for(const width of [320,390,430,1280]){await page.setViewportSize({width,height:844});await page.evaluate(()=>scrollTo(0,0));await visibleSave("defaults "+width);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.setViewportSize({width:390,height:844});
  await page.locator("#defaultBreak").fill("");await save();assert.equal(await raw(),original,"fixed save retains browser required-field validation");assert.equal(await page.locator("#defaultBreak").evaluate(node=>node.validity.valueMissing),true);
  const invalidBox=await page.locator('#defaultBreak').boundingBox(),invalidBar=await page.locator('#formSaveBar').boundingBox();assert.ok(invalidBox.y>=0&&invalidBox.y+invalidBox.height<=invalidBar.y,'validation focuses the invalid input above the save bar');
  await page.locator("#defaultBreak").fill("60");await page.evaluate(()=>{window.__saveOriginalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error("quota")};});await save();assert.equal(await raw(),original);assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/,"failed save must retain dirty state");
  await page.evaluate(()=>Storage.prototype.setItem=window.__saveOriginalSet);await save();assert.match(await page.locator("#formSaveStatus").innerText(),/保存済み/);assert.deepEqual((await stored()).records,existing,"default reset never rewrites daily records");assert.equal((await stored()).settings.workSummary,(await stored()).defaults.note);
  await page.locator("[data-action=settings-tab][data-tab=sheet]").click();assert.equal(await page.locator("#minHours").inputValue(),"145");assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/);await page.evaluate(()=>scrollTo(0,0));await visibleSave("sheet");await save();assert.equal((await stored()).settings.minHours,145);assert.match(await page.locator("#formSaveStatus").innerText(),/保存済み/);
  console.log("PASS reset stages until Update, independent drafts persist, native validation and failed-save recovery retain status");
  await page.locator("#nav-records").click();await page.locator('[data-day="2026-10-26"]').click();await page.locator("#editNote").fill("保存バーで更新する内容");assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/);
  await page.locator("#nav-settings").click();await page.locator("#nav-records").click();await page.locator('[data-day="2026-10-26"]').click();assert.equal(await page.locator("#editNote").inputValue(),"保存バーで更新する内容");assert.match(await page.locator("#formSaveStatus").innerText(),/未保存/);
  for(const width of [320,390,430,1280]){await page.setViewportSize({width,height:844});await page.evaluate(()=>scrollTo(0,0));await visibleSave("editor "+width);await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await visibleSave("editor bottom "+width);}
  await page.setViewportSize({width:390,height:480});await page.locator('#editAllocSET').focus();await page.locator('#editAllocSET').evaluate(node=>node.scrollIntoView({block:'nearest'}));
  const focusedBox=await page.locator('#editAllocSET').boundingBox(),saveBar=await page.locator('#formSaveBar').boundingBox();assert.ok(focusedBox.y>=0&&focusedBox.y+focusedBox.height<=saveBar.y,'focused field remains above toolbar in a shortened mobile viewport');await visibleSave('short mobile viewport');
  await save();assert.equal((await stored()).records['2026-10-26'].note,"保存バーで更新する内容");assert.match(await page.locator("#formSaveStatus").innerText(),/保存済み/);
  await page.locator("#nav-home").click();assert.equal(await page.locator("#formSaveBar").count(),0,"home keeps automatic saving without manual toolbar");
  assert.deepEqual(errors,[]);console.log("PASS fixed save accessible at 320/390/430/1280px, editor drafts and status survive navigation, home auto-save unchanged");
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);server.close();process.exitCode=1;});
