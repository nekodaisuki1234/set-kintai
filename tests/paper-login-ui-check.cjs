"use strict";
const {chromium}=require(process.env.PAPER_PLAYWRIGHT_MODULE||"playwright");
const assert=require("node:assert/strict"),http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),server=http.createServer((req,res)=>{
 const file=path.resolve(root,"."+new URL(req.url,"http://local").pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
const screenshotDir=process.env.PAPER_SCREENSHOT_DIR;
const snapshot=page=>page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)])));
async function run(){
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAPER_CHROMIUM_PATH||(fs.existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]});
 try{
  const origin="http://127.0.0.1:"+server.address().port,errors=[],external=[];
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:"ja-JP",reducedMotion:"reduce"});let page=await context.newPage();
  page.on("pageerror",error=>errors.push(error.message));
  await context.route("**/*",route=>{
   if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}
   return route.continue();
  });
  await page.clock.install({time:new Date("2026-10-27T12:00:00Z")});
  await page.goto(origin+"/day-designs/a-paper.html?screen=1");await page.locator("#startPunch").waitFor();
  await page.evaluate(()=>{
   const C=window.PaperAttendance,now=C.clock(),demo=C.seed(now),local=C.createState(now,{startDay:"2026-10-01"});
   demo.revision=17;local.revision=29;local.settings.employee={name:"保存済みの社員",department:"確認用",id:"LOCAL-29"};
   localStorage.setItem("day-paper-attendance-v1",JSON.stringify(demo));
   localStorage.setItem("day-paper-local-v1",JSON.stringify(local));
   localStorage.setItem("login-test-unrelated","そのまま残す");
  });
  await page.reload();await page.locator("#startPunch").waitFor();
  const before=await snapshot(page);
  await page.goto(origin+"/index.html");await page.locator("#microsoftLogin").waitFor();
  assert.equal(new URL(page.url()).pathname,"/day-designs/a-paper-login.html","the repository entry opens the attendance login preview");
  assert.deepEqual(await snapshot(page),before,"the new entry must preserve all existing attendance and unrelated data");
  await page.goto(origin+"/day-designs/a-paper.html?screen=1");await page.locator("#startPunch").waitFor();
  await page.locator("#nav-settings").click();
  const preview=page.locator("a.login-preview-link");assert.match(await preview.getAttribute("href"),/a-paper-login\.html/);
  assert.equal(await preview.getAttribute("target"),"_blank");
  const app=page,popup=page.waitForEvent("popup");await preview.click();page=await popup;
  page.on("pageerror",error=>errors.push(error.message));await page.clock.install({time:new Date("2026-10-27T12:00:00Z")});
  await page.locator("#microsoftLogin").waitFor();
  assert.equal(await app.locator("#nav-settings").getAttribute("aria-current"),"page","preview discovery must preserve the existing settings screen");
  assert.match(new URL(page.url()).pathname,/\/a-paper-login\.html$/);
  assert.equal(await page.locator("input,textarea").count(),0,"a mock must not collect credentials");
  assert.match(await page.locator("#loginPreview").innerText(),/プレビュー|モック|未接続|接続/);
  assert.deepEqual(await snapshot(page),before,"opening the login preview must preserve both app stores and unrelated data");
  assert.equal(await page.evaluate(()=>window.PaperAttendance||window.PaperConfig||null),null,"the standalone mock must not boot or impersonate an authenticated app");

  for(const viewport of [{width:320,height:568},{width:390,height:844},{width:430,height:844},{width:1280,height:900}]){
   await page.setViewportSize(viewport);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"login overflow at "+viewport.width);
   for(const selector of ["#microsoftLogin","#loginDemo"]){
    const box=await page.locator(selector).boundingBox();assert.ok(box.width>=44&&box.height>=44,selector+" touch target at "+viewport.width);
    assert.ok(box.x>=-1&&box.x+box.width<=viewport.width+1,selector+" inside viewport at "+viewport.width);
   }
   if(screenshotDir&&(viewport.width===390||viewport.width===1280)){
    fs.mkdirSync(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,"paper-login29-"+viewport.width+".png"),fullPage:true});
   }
  }
  await page.setViewportSize({width:390,height:844});
  const login=page.locator("#microsoftLogin"),box=await login.boundingBox(),url=page.url();
  await login.click();assert.match(await page.locator("#loginToast").innerText(),/未接続|準備中|接続されていません/);
  assert.equal(await page.locator("#loginToast").getAttribute("role"),"status");
  assert.equal(page.url(),url,"mock sign-in must not claim a completed login or redirect to a pretend account");
  assert.deepEqual(await login.boundingBox(),box,"login feedback must not move the action or page layout");
  await page.clock.runFor(6100);await login.focus();await page.keyboard.press("Enter");
  assert.equal(await page.locator("#loginToast").getAttribute("data-visible"),"true");
  await page.clock.runFor(6100);await page.keyboard.press("Space");
  assert.equal(await page.locator("#loginToast").getAttribute("data-visible"),"true");
  assert.deepEqual(await snapshot(page),before,"clicking or keyboard-activating the mock cannot create sessions or alter attendance");
  assert.deepEqual(external,[],"the mock must not call authentication services or any external host");
  console.log("PASS login preview discovery, credential-free mock, untouched demo/local records, accessible unconnected feedback and mobile/desktop layout");

  await page.locator("#loginDemo").click();await page.locator("#startPunch").waitFor();
  assert.equal(new URL(page.url()).pathname,"/day-designs/a-paper.html");
  assert.equal(await page.locator("html").getAttribute("data-app-mode"),"demo");
  assert.equal(await page.evaluate(()=>window.PaperConfig.mode),"demo");
  assert.deepEqual(await snapshot(page),before,"opening the explicit demo must not create an auth session or rewrite existing records");
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log("PASS explicit demo navigation retains demo mode and all previously saved data without browser errors");
  let returnedApp;
  for(const [mode,entry] of [["demo","a-paper.html?screen=1"],["local","a-paper-app.html"]]){
   const current=await context.newPage();current.on("pageerror",error=>errors.push(error.message));
   await current.addInitScript(()=>{
    const control=window.__logoutAdapter={calls:0,hold:false};
    window.PaperRepositoryFactory=options=>{
     const repository=window.PaperRepository.createLocal(options);
     return {...repository,async save(next,saveOptions){control.calls++;if(control.hold)await new Promise(resolve=>{control.release=resolve;});return repository.save(next,saveOptions);}};
    };
   });
   await current.clock.install({time:new Date("2026-10-27T12:00:00Z")});
   await current.goto(origin+"/day-designs/"+entry);await current.locator("#startPunch").waitFor();
   const storedBefore=await snapshot(current),logout=current.locator("button[data-action=logout]");
   assert.match(await logout.innerText(),/ログアウト/);
   await current.setViewportSize({width:320,height:568});
   const target=await logout.boundingBox();assert.ok(target.width>=44&&target.height>=44,"logout needs a44px target");
   assert.ok(await current.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),mode+" masthead must fit320px");
   await current.setViewportSize({width:390,height:844});
   if(screenshotDir&&mode==="demo")await current.screenshot({path:path.join(screenshotDir,"paper-logout30-home.png")});
   await current.locator("#nav-settings").click();await current.locator("#defaultNote").fill("保存しない下書き・"+mode);
   await logout.focus();await current.keyboard.press("Enter");
   assert.equal(await current.locator("#paperDialog").evaluate(node=>node.open),true);
   assert.match(await current.locator("#paperDialog").innerText(),/未保存/);
   if(screenshotDir&&mode==="demo")await current.screenshot({path:path.join(screenshotDir,"paper-logout30-confirm.png")});
   assert.deepEqual(await snapshot(current),storedBefore,"opening logout confirmation cannot change saved data");
   await current.locator("#paperDialog [data-action=close-dialog]").last().click();
   assert.equal(await current.locator("#defaultNote").inputValue(),"保存しない下書き・"+mode,"cancel must retain unsaved form input");
   await logout.click();await current.locator("[data-action=confirm-logout]").click();
   await current.locator("#microsoftLogin").waitFor();
   assert.equal(new URL(current.url()).pathname,"/day-designs/a-paper-login.html");
   assert.equal(new URL(current.url()).searchParams.get("from"),mode,"logout return mode follows the actual HTML entry");
   assert.deepEqual(await snapshot(current),storedBefore,"logout cannot erase or rewrite attendance, other-mode data or unrelated storage");
   if(mode==="local"){
    assert.match(await current.locator("#loginReturn").getAttribute("href"),/a-paper-app\.html/);
    await current.locator("#loginReturn").click();
   }else await current.locator("#loginDemo").click();
   await current.locator("#startPunch").waitFor();
   assert.equal(await current.evaluate(()=>window.PaperConfig.mode),mode,"return must preserve demo/local separation");
   await current.locator("#nav-settings").click();
   assert.notEqual(await current.locator("#defaultNote").inputValue(),"保存しない下書き・"+mode,"unaccepted form drafts are not persisted by logout");
   assert.deepEqual(await snapshot(current),storedBefore);
   await current.locator("#nav-home").click();returnedApp=current;
  }
  console.log("PASS demo/local logout confirmation, cancellation retains drafts, keyboard/mobile control and data-preserving login return");

  const pending=returnedApp,pendingUrl=pending.url();
  await pending.evaluate(()=>window.__logoutAdapter.hold=true);
  const beforePending=await snapshot(pending);await pending.locator("#startPunch").click();
  await pending.waitForFunction(()=>window.__logoutAdapter.calls===1&&document.querySelector("#previewApp").getAttribute("aria-busy")==="true");
  assert.equal(await pending.locator("[data-action=logout]").isDisabled(),true,"logout must wait for an in-flight save");
  await pending.evaluate(()=>{
   document.querySelector("[data-action=logout]").dispatchEvent(new MouseEvent("click",{bubbles:true}));
   const confirm=document.createElement("button");confirm.dataset.action="confirm-logout";document.body.append(confirm);confirm.click();confirm.remove();
  });
  assert.equal(pending.url(),pendingUrl,"even synthetic logout actions cannot abandon an in-flight save");
  assert.equal(await pending.locator("#paperDialog").evaluate(node=>node.open),false);
  assert.deepEqual(await snapshot(pending),beforePending,"pending saves cannot be treated as already accepted");
  await pending.evaluate(()=>window.__logoutAdapter.release());
  await pending.waitForFunction(()=>document.querySelector("#previewApp").getAttribute("aria-busy")==="false");
  const accepted=await snapshot(pending);assert.notEqual(accepted["day-paper-local-v1"],beforePending["day-paper-local-v1"]);
  await pending.locator("[data-action=logout]").click();await pending.locator("[data-action=confirm-logout]").click();await pending.locator("#microsoftLogin").waitFor();
  assert.deepEqual(await snapshot(pending),accepted,"a completed save must survive the following logout");
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log("PASS pending-save logout guard and preservation of the accepted record after logout without auth traffic");
  await context.close();
 }finally{await browser.close();}
}
run().then(()=>server.close(),error=>{console.error(error);server.close();process.exitCode=1});
