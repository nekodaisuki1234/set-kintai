"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const directory=path.join(__dirname,"../day-designs"),base="https://nekodaisuki1234.github.io/set-kintai/day-designs/",app=base+"a-paper-app.html?v=paper-reminders34";
const helper=fs.readFileSync(path.join(directory,"paper-push.js"),"utf8"),worker=fs.readFileSync(path.join(directory,"paper-notifications-sw.js"),"utf8");
const plain=value=>JSON.parse(JSON.stringify(value));
function environment(options={}){
 const calls={permission:0,register:[],shown:[]},timers=new Map(),state={permission:"default",standalone:true,secure:true,ios:true,...options};
 let timerId=0;
 const registration={active:{state:"activated"},showNotification:async(title,body)=>{calls.shown.push({title,...plain(body)});if(state.displayError)throw Error("display");}};
 function Notification(){}
 Object.defineProperty(Notification,"permission",{get:()=>state.permission});
 Notification.requestPermission=()=>{
  calls.permission++;calls.promptBeforeRegister=calls.register.length===0;
  if(state.permissionError)throw Error("permission");
  return state.holdPermission?new Promise(resolve=>{state.releasePermission=resolve;}):Promise.resolve(state.answer||"granted");
 };
 const nav={userAgent:state.ios?"iPhone":"Desktop",platform:state.ios?"iPhone":"Linux",maxTouchPoints:state.ios?5:0,serviceWorker:{register(url,settings){
  calls.register.push({url,settings:plain(settings)});if(state.registerError)throw Error("register");
  return state.holdRegister?new Promise(()=>{}):Promise.resolve(registration);
 }}};
 Object.defineProperty(nav,"standalone",{get:()=>state.standalone});
 const sandbox={URL,Promise,navigator:nav,Notification,PushManager:function(){},document:{currentScript:{src:base+"paper-push.js"}},location:{href:app},matchMedia:()=>({matches:false}),
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 Object.defineProperty(sandbox,"isSecureContext",{get:()=>state.secure});
 Object.defineProperty(sandbox,"localStorage",{get(){throw Error("notification helper must not access attendance storage");}});
 sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(helper,sandbox);
 return {P:sandbox.PaperPush,state,calls,registration,timers,expire(){for(const [id,timer] of [...timers]){timers.delete(id);timer.fn();}}};
}
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
async function run(){
 const fresh=environment();assert.equal(fresh.calls.permission,0);assert.deepEqual(fresh.calls.register,[]);assert.equal(fresh.P.getState().canTest,true);
 const home=environment({standalone:false});assert.equal(home.P.getState().reason,"home-screen");assert.deepEqual(plain(await home.P.testNotification()),{ok:false,reason:"home-screen"});assert.equal(home.calls.permission,0);
 const desktop=environment({ios:false,standalone:false});assert.equal(desktop.P.getState().canTest,true,"desktop capability support does not require iPhone installation");
 const insecure=environment({secure:false});assert.equal(insecure.P.getState().reason,"unsupported");assert.equal((await insecure.P.testNotification()).reason,"unsupported");assert.equal(insecure.calls.permission,0);
 for(const permission of ["denied","default"]){
  const denied=environment(permission==="denied"?{permission}:{answer:"default"});
  assert.equal((await denied.P.testNotification()).reason,permission==="denied"?"denied":"dismissed");assert.equal(denied.calls.register.length,0);assert.equal(denied.calls.shown.length,0);
 }
 const pending=environment({holdPermission:true}),first=pending.P.testNotification(),second=pending.P.testNotification();
 assert.equal(first,second,"concurrent taps must share the same operation");assert.equal(pending.calls.permission,1);assert.equal(pending.calls.promptBeforeRegister,true);assert.equal(pending.calls.register.length,0);
 pending.state.permission="granted";pending.state.releasePermission("granted");
 assert.deepEqual(plain(await first),{ok:true});assert.equal(pending.calls.register.length,1);assert.equal(pending.calls.shown.length,1);
 assert.equal(pending.calls.register[0].url,base+"paper-notifications-sw.js");assert.equal(pending.calls.register[0].settings.scope,base);assert.equal(pending.calls.register[0].settings.updateViaCache,"none");
 assert.match(pending.calls.shown[0].body,/テスト通知/);assert.equal(pending.calls.shown[0].data.url,app);assert.equal(pending.timers.size,0);
 await pending.P.testNotification();assert.equal(pending.calls.permission,1,"already granted permission must not prompt again");assert.equal(pending.calls.shown.length,2);
 for(const [settings,reason] of [[{permissionError:true},"dismissed"],[{permission:"granted",registerError:true},"worker"],[{permission:"granted",displayError:true},"display"]]){
  const failed=environment(settings);assert.equal((await failed.P.testNotification()).reason,reason);
 }
 const hanging=environment({permission:"granted",holdRegister:true}),expired=hanging.P.testNotification();await settle();assert.ok(hanging.timers.size>0);hanging.expire();assert.equal((await expired).reason,"worker");assert.equal(hanging.calls.shown.length,0);
 const activating=environment({permission:"granted"}),listeners=new Map(),registrationListeners=new Map();
 const candidate={state:"installing",addEventListener(type,fn){listeners.set(type,fn);},removeEventListener:type=>listeners.delete(type)};
 activating.registration.active=null;activating.registration.installing=candidate;activating.registration.addEventListener=(type,fn)=>registrationListeners.set(type,fn);activating.registration.removeEventListener=type=>registrationListeners.delete(type);
 const activation=activating.P.testNotification();await settle();assert.equal(activating.calls.shown.length,0);
 candidate.state="activated";activating.registration.active=candidate;listeners.get("statechange")();
 assert.equal((await activation).ok,true);assert.equal(listeners.size,0);assert.equal(registrationListeners.size,0);
 candidate.state="installing";activating.registration.active=null;
 const stalled=activating.P.testNotification();await settle();activating.expire();
 assert.equal((await stalled).reason,"worker");assert.equal(listeners.size,0);assert.equal(registrationListeners.size,0,"activation timeout must remove worker listeners");
 console.log("PASS no automatic permission or registration, iPhone installation gate, capability checks, explicit gesture permission, concurrent taps, bounded failures and worker activation");

 const events={},shown=[],opened=[],focused=[],clients=[];
 const self={location:{href:base+"paper-notifications-sw.js"},registration:{showNotification:async(title,options)=>shown.push({title,...plain(options)})},
  clients:{matchAll:async()=>clients,openWindow:async url=>opened.push(url),claim(){throw Error("worker must not claim unrelated pages");}},
  addEventListener:(name,fn)=>events[name]=fn};
 vm.runInNewContext(worker,{self,URL});
 assert.equal(events.fetch,undefined,"notification worker must not intercept app data");assert.equal(events.activate,undefined,"worker must not claim other designs");
 const dispatch=async(name,properties={})=>{const promises=[];events[name]({...properties,waitUntil:promise=>promises.push(promise)});await Promise.all(promises);};
 for(const data of [undefined,{json(){throw Error("invalid");}},{json(){throw Error("payload must not influence lock-screen content");},text(){throw Error("untrusted payload");}}]){
  await dispatch("push",{data});assert.equal(shown.at(-1).data.url,app);assert.match(shown.at(-1).body,/勤怠/);assert.doesNotMatch(shown.at(-1).body,/https:|社員名|秘密/);
 }
 let closed=0;const notification={data:{url:"https://evil.invalid/"},close(){closed++;}};
 clients.push({url:base+"a-paper.html",focus:async()=>focused.push("demo")},{url:base+"a-paper-app.html?notifications=1",focus:async()=>focused.push("local")});
 await dispatch("notificationclick",{notification});assert.deepEqual(focused,["local"]);assert.deepEqual(opened,[]);
 clients.length=0;clients.push({url:"https://evil.invalid/a-paper-app.html",focus:async()=>focused.push("evil")});
 await dispatch("notificationclick",{notification});assert.deepEqual(opened,[app]);assert.equal(closed,2);
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,"paper.webmanifest"),"utf8"));
 assert.equal(new URL(manifest.id,base).href,base+"a-paper-app.html");assert.equal(new URL(manifest.start_url,base).href,app);assert.equal(new URL(manifest.scope,base).href,base);assert.equal(manifest.display,"standalone");
 for(const icon of manifest.icons)assert.ok(fs.existsSync(path.join(directory,icon.src)),"manifest icon exists: "+icon.src);
 const demo=fs.readFileSync(path.join(directory,"a-paper.html"),"utf8"),local=fs.readFileSync(path.join(directory,"a-paper-app.html"),"utf8");
 assert.doesNotMatch(demo,/<link[^>]+rel=["']manifest["']/);assert.match(local,/<link[^>]+rel=["']manifest["'][^>]+paper\.webmanifest/);
 console.log("PASS generic visible push handling, untrusted URL rejection, fixed local-app click target, no fetch/cache claims and local-only install manifest");
}
run().catch(error=>{console.error(error);process.exitCode=1;});
