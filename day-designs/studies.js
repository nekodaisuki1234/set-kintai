(function(){
"use strict";
const EMPLOYEE={id:"E001",name:"田中 花子",department:"営業"};
const DATE="2026-10-27",HISTORY={day:"2026-10-26",start:"09:00",end:"18:00",breakMinutes:60,overnight:false};
const KEY="day-design-studies-v1",PRESETS=[0,30,45,60,90];
const SAMPLES={
 before:{clock:"08:57:16",start:"",end:"",breakMinutes:60,overnight:false},
 working:{clock:"14:35:08",start:"09:10",end:"",breakMinutes:60,overnight:false},
 after:{clock:"18:04:12",start:"09:10",end:"18:02",breakMinutes:60,overnight:false}
};
const SOFT_SCENES={morning:SAMPLES.before,day:SAMPLES.working,evening:SAMPLES.after,night:{...SAMPLES.after,clock:"21:12:06"}};
function clockPeriod(clock){
 const hour=Number(clock.slice(0,2));
 const id=hour>=5&&hour<11?"morning":hour>=11&&hour<16?"day":hour>=16&&hour<19?"evening":"night";
 return {id,name:{morning:"朝",day:"昼",evening:"夕方",night:"夜"}[id],meridiem:hour<12?"午前":"午後",hour:hour%12||12};
}
const clone=value=>JSON.parse(JSON.stringify(value));
const h=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad=n=>String(n).padStart(2,"0");
function minutes(value){if(!/^\d{2}:\d{2}$/.test(value||""))return null;const[a,b]=value.split(":").map(Number);return a<24&&b<60?a*60+b:null;}
function duration(total){return Math.floor(Math.max(0,total)/60)+"時間"+pad(Math.max(0,total)%60)+"分";}
function short(total){return Math.floor(Math.max(0,total)/60)+":"+pad(Math.max(0,total)%60);}
function mode(value){return !value.start?"before":value.end?"after":"working";}
function worked(value){
 const start=minutes(value.start);if(start==null)return 0;
 const end=value.end?minutes(value.end)+(value.overnight?1440:0):minutes(value.clock.slice(0,5));
 return Math.max(0,end-start-value.breakMinutes);
}
function validate(value){
 if(!/^\d{2}:\d{2}:\d{2}$/.test(value.clock||"")||minutes(value.clock.slice(0,5))==null||Number(value.clock.slice(-2))>59)return "サンプル時刻を確認してください。";
 if(!Number.isInteger(value.breakMinutes)||value.breakMinutes<0||value.breakMinutes>1440)return "休憩時間は0時間00分〜24時間00分で入力してください。";
 if(value.start&&minutes(value.start)==null||value.end&&minutes(value.end)==null)return "時刻を確認してください。";
 if(value.end&&!value.start)return "先に出勤時刻を入力してください。";
 if(value.start&&!value.end&&minutes(value.start)>minutes(value.clock.slice(0,5)))return "出勤時刻は表示中の時刻より前にしてください。";
 if(value.start&&value.end){
  const span=minutes(value.end)+(value.overnight?1440:0)-minutes(value.start);
  if(span<0)return "翌日の退勤なら「翌日に退勤」を選んでください。";
  if(value.breakMinutes>span)return "休憩時間が勤務の時間幅を超えています。";
 }
 return "";
}
function hydrate(raw){
 if(!raw||typeof raw!=="object"||typeof raw.start!=="string"||typeof raw.end!=="string"||typeof raw.clock!=="string"||typeof raw.overnight!=="boolean")return null;
 const value={clock:raw.clock,start:raw.start,end:raw.end,breakMinutes:raw.breakMinutes,overnight:raw.overnight};
 return validate(value)?null:value;
}
function restore(){try{return hydrate(JSON.parse(sessionStorage.getItem(KEY)||"null"))||clone(SAMPLES.working);}catch{return clone(SAMPLES.working);}}
const root=document.getElementById("previewApp");if(!root)return;
const embed=/(?:[?&])embed=1(?:&|$)/.test(window.location.search||"");
if(embed)document.documentElement.setAttribute("data-embed","");
if(/(?:[?&])screen=1(?:&|$)/.test(window.location.search||""))document.documentElement.setAttribute("data-screen","");
let state=restore(),view="home",restOpen=false,error="",toastTimer=null,guard={kind:"",until:0},guardToken=0;
const $=id=>document.getElementById(id);
const paths={home:"M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9",calendar:"M5 5h14v16H5zM8 3v4m8-4v4M5 10h14",menu:"M4 6h16M4 12h16M4 18h16"};
function icon(name){return '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
function toast(message){if(embed)return;$("studyToast").textContent=message;$("studyToast").classList.add("visible");clearTimeout(toastTimer);toastTimer=setTimeout(()=>$("studyToast").classList.remove("visible"),2600);}
function persist(next,message){
 const issue=validate(next);if(issue){showError(issue);return false;}
 try{sessionStorage.setItem(KEY,JSON.stringify(next));}catch{showError("保存できませんでした。記録は変更していません。もう一度お試しください。");return false;}
 state=next;error="";if(message)toast(message);return true;
}
function label(kind){return(kind==="start"?"出勤時刻":"退勤時刻")+"を"+(state[kind]?"編集":"入力");}
function isGuarded(kind){return Date.now()<guard.until&&(guard.kind==="all"||guard.kind===kind);}
function lock(kind,ms){
 const token=++guardToken;guard={kind,until:Date.now()+ms};
 setTimeout(()=>{if(token!==guardToken)return;guard={kind:"",until:0};if($("punchActions"))$("punchActions").innerHTML=punches();},ms);
}
function hasPunchReset(){return ["paper","soft"].includes(document.documentElement.dataset.theme);}
function resetPunchButtons(){
 const buttons=["start","end"].map(kind=>{
  const record=state[kind],name=kind==="start"?"出勤":"退勤",caption=name+"打刻",blocked=kind==="end"&&!state.start||isGuarded(kind);
  const nextDay=kind==="end"&&state.overnight;
  const accessible=caption+(record?"、"+(nextDay?"翌日 ":"")+record+"。現在時刻で打刻を上書き":kind==="end"&&!state.start?"。出勤後に使えます":"");
  const body='<span class="punch-caption">'+caption+'</span>'+(record?'<time class="punch-time" datetime="'+record+'">'+(nextDay?"翌 ":"")+record+'</time>':"");
  return '<button id="'+kind+'Punch" type="button" class="punch-button'+(record?" is-recorded":"")+'" data-action="punch" data-punch="'+kind+'" aria-label="'+accessible+'" '+(blocked?"disabled":"")+'>'+body+'</button>';
 }).join("");
 const disabled=!state.start&&!state.end||isGuarded("reset");
 return buttons+'<button id="resetPunch" type="button" class="punch-button punch-reset" data-action="reset-punches" aria-label="今日の出勤と退勤の打刻を取り消す" title="出勤・退勤の打刻を未打刻に戻します" '+(disabled?"disabled":"")+'><span class="punch-caption">取消</span></button>';
}
function punches(){
 if(hasPunchReset())return resetPunchButtons();
 return ["start","end"].map(kind=>{
  const record=state[kind],name=kind==="start"?"出勤":"退勤",blocked=kind==="end"&&!state.start||isGuarded(kind);
  const hint=kind==="end"&&!state.start?"出勤後に使えます":"";
  const body=record?'<span class="stamp"><span>'+name+'</span><time datetime="'+record+'">'+(kind==="end"&&state.overnight?"翌 ":"")+record+'</time></span><span class="overwrite">打刻を上書き</span>':name+(hint?'<span class="hint">'+hint+'</span>':"");
  return '<button id="'+kind+'Punch" type="button" class="punch-button'+(record?" is-recorded":"")+'" data-action="punch" data-punch="'+kind+'" aria-label="'+name+(record?" "+record+"。現在時刻で打刻を上書き":"")+'" '+(blocked?"disabled":"")+'>'+body+'</button>';
 }).join("");
}
function dial(){
 if(document.documentElement.dataset.theme!=="soft")return "";
 const lines=Array.from({length:60},(_,i)=>{
  const a=i*Math.PI/30,r1=i%5===0?101:107,r2=113;
  return '<line class="tick '+(i%5===0?"hour-tick":"")+'" x1="'+(128+Math.sin(a)*r1).toFixed(2)+'" y1="'+(128-Math.cos(a)*r1).toFixed(2)+'" x2="'+(128+Math.sin(a)*r2).toFixed(2)+'" y2="'+(128-Math.cos(a)*r2).toFixed(2)+'"/>';
 }).join("");
 return '<svg class="clock-dial" viewBox="0 0 256 256" aria-hidden="true">'+lines+'</svg>';
}
function clockWrap(){
 const soft=document.documentElement.dataset.theme==="soft",period=clockPeriod(state.clock),mm=state.clock.slice(3,5),ss=state.clock.slice(-2);
 const digits=soft?'<span class="clock-digits">'+period.hour+':'+mm+'</span>':state.clock.slice(0,5);
 const context=soft?'<span class="clock-period">'+period.meridiem+'</span>':"";
 const accessible=soft?' aria-label="'+period.name+'、'+period.meridiem+period.hour+'時'+Number(mm)+'分'+Number(ss)+'秒、日本時間"':"";
 const caption=soft?'<span class="clock-daypart">'+period.name+'</span><span>'+state.clock.slice(0,5)+'・日本時間</span>':'現在時刻・日本時間';
 return '<div class="clock-wrap"'+(soft?' data-daypart="'+period.id+'"':"")+'>'+dial()+context+'<time class="digital-clock" datetime="'+DATE+'T'+state.clock+'+09:00"'+accessible+'>'+digits+'<span class="seconds">:'+ss+'</span></time><p class="clock-caption">'+caption+'</p></div>';
}
function timeFields(){
 return '<div class="time-area"><p id="timeHelp" class="time-help"><strong>時刻は手入力・修正できます</strong><span>自動保存</span></p><div class="time-fields">'+["start","end"].map(kind=>'<label for="'+kind+'Time"><span id="'+kind+'Label">'+label(kind)+'</span><input id="'+kind+'Time" class="time-input" type="time" step="60" value="'+h(state[kind])+'" data-time="'+kind+'" aria-label="'+label(kind)+'" aria-describedby="timeHelp" '+(kind==="end"&&!state.start?"disabled":"")+'></label>').join("")+'</div><label class="nextday"><input id="nextday" type="checkbox" '+(state.overnight?"checked ":"")+(!state.start?"disabled":"")+'>翌日に退勤</label></div>';
}
function restEditor(){
 const summary='<div class="rest-row"><span>休憩時間</span><strong>'+duration(state.breakMinutes)+'</strong><button type="button" class="text-button" data-action="rest">'+(restOpen?"やめる":"変更")+'</button></div>';
 if(!restOpen)return summary;
 return summary+'<form id="restForm" class="rest-form" novalidate><div class="rest-inputs"><label class="sr-only" for="restHours">休憩の時間</label><input id="restHours" type="number" min="0" max="24" inputmode="numeric" value="'+Math.floor(state.breakMinutes/60)+'"><span>時間</span><label class="sr-only" for="restMinutes">休憩の分</label><input id="restMinutes" type="number" min="0" max="59" inputmode="numeric" value="'+pad(state.breakMinutes%60)+'"><span>分</span><button type="submit" class="small-save">保存</button></div><div class="rest-presets" role="group" aria-label="休憩時間の候補">'+PRESETS.map(n=>'<button type="button" id="preset'+n+'" data-action="preset" data-minutes="'+n+'" aria-pressed="'+(state.breakMinutes===n)+'">'+n+'分</button>').join("")+'</div></form>';
}
function week(){
 const current=worked(state),total=480+current,days=["月","火","水","木","金","土","日"];
 const chart=days.map((name,i)=>{
  const date=new Date(Date.UTC(2026,9,26+i)),dayNumber=date.getUTCDate(),monthNumber=date.getUTCMonth()+1;
  const n=i===0?480:i===1?current:0,value=i===0?"8:00":i===1?(state.start?short(n):"未打刻"):"—";
  const mark=i<2&&n>0?'<span class="week-bar" style="--bar:'+(n/Math.max(480,current)*57).toFixed(2)+'px"></span>':'<span class="week-mark">'+(i>1?"·":state.start&&i===1?"—":"○")+'</span>';
  return '<button type="button" class="week-day'+(i===1?" is-today":"")+'" data-action="records" '+(i>1?"disabled ":"")+'aria-label="'+monthNumber+'月'+dayNumber+'日 '+name+'曜日 '+(i>1?"これから":value)+'"><span class="week-track" aria-hidden="true">'+mark+'</span><span class="week-value">'+value+'</span><span class="week-date">'+name+' '+dayNumber+'</span></button>';
 }).join("");
 return '<section class="week-section" aria-labelledby="weekTitle"><div class="week-heading"><h2 id="weekTitle">今週の記録</h2><span>計 <strong>'+short(total)+'</strong></span></div><div class="week-chart">'+chart+'</div><p class="week-note">実働・時間:分　日付を選んで記録を確認</p></section>';
}
function errorHtml(){return error?h(error)+(error.includes("休憩時間が勤務")?'<button type="button" class="text-button" data-action="fix-rest">休憩時間を変更</button>':""):"";}
function home(){
 const status=state.end?"退勤済み":state.start?"勤務中":"出勤前";
 return '<section class="punch-pane"><div class="dayline"><h1>今日の勤怠</h1><strong id="punchState" class="state-tag">'+status+'</strong></div><div class="hero-composition"><time class="hero-date" datetime="'+DATE+'" aria-label="2026年10月27日、火曜日"><span class="date-short">10月27日（火）</span><span class="date-poster" aria-hidden="true"><b>27</b><small>OCT<br>TUESDAY</small></span></time>'+clockWrap()+'</div><div id="punchActions" class="punch-actions" role="group" aria-label="出退勤の打刻">'+punches()+'</div>'+timeFields()+'<div id="restEditor">'+restEditor()+'</div><div id="previewError" class="preview-error" role="alert">'+errorHtml()+'</div></section><div id="weekArea">'+week()+'</div>';
}
function records(){
 const rows=[{day:"26",weekday:"月",value:HISTORY,today:false},{day:"27",weekday:"火",value:state,today:true}].map(item=>{
  const r=item.value,range=r.start?(r.start+" → "+(r.end?r.end+(r.overnight?" 翌日":""):"—")):"未打刻";
  const inside='<span class="record-date"><b>'+item.day+'</b><small>10月・'+item.weekday+'</small></span><span class="record-times">'+range+'<small>'+(r.start?"休憩 "+duration(r.breakMinutes):"今日の打刻はホームから")+'</small></span><span class="record-hours">'+(r.start?short(worked(item.today?r:{...r,clock:"18:00:00"})):"—")+'</span>';
  return item.today?'<button type="button" class="record-item" data-action="today">'+inside+'</button>':'<div class="record-item">'+inside+'</div>';
 }).join("");
 return '<section class="subpage"><h1>10月の勤怠</h1><p class="subpage-lede">'+EMPLOYEE.name+'さんの記録<br>2日分の共通サンプルです。</p>'+rows+'<p class="week-note">今日の記録を選ぶと、ホームで時刻を編集できます。</p></section>';
}
function menu(){return '<section class="subpage"><h1>メニュー</h1><p class="subpage-lede">あなたのアカウント</p><div class="profile-panel"><h2>'+EMPLOYEE.name+'</h2><p>'+EMPLOYEE.department+' / '+EMPLOYEE.id+'</p></div><a class="menu-link" href="./?v=overwrite1"><span>デザイン候補を比べる</span><span aria-hidden="true">↗</span></a><a class="menu-link" href="../attendance-demo/?v=overwrite1"><span>現在のアプリを開く</span><span aria-hidden="true">↗</span></a></section>';}
function nav(){return '<nav class="app-nav" aria-label="メインナビゲーション">'+[["home","home","ホーム"],["records","calendar","勤怠"],["menu","menu","メニュー"]].map(([tab,ic,text])=>'<button id="nav-'+tab+'" type="button" class="nav-button" data-action="tab" data-tab="'+tab+'" '+(view===tab?'aria-current="page"':"")+'>'+icon(ic)+'<span>'+text+'</span></button>').join("")+'</nav>';}
function syncControls(){document.querySelectorAll("[data-state]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.state===mode(state))));document.querySelectorAll("[data-scene]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.scene===clockPeriod(state.clock).id)));}
function render(){
 root.innerHTML='<header class="app-masthead"><button type="button" class="wordmark" data-action="home" aria-label="day. ホーム">day.</button><div class="employee"><b>'+EMPLOYEE.name+'</b>'+EMPLOYEE.department+' / '+EMPLOYEE.id+'</div></header><main class="preview-main">'+(view==="records"?records():view==="menu"?menu():home())+'</main>'+nav();
 if(embed)root.inert=true;
 syncControls();
}
function syncHome(preserveRest=false){
 if(view!=="home"){render();return;}
 if($("punchActions"))$("punchActions").innerHTML=punches();
 $("punchState").textContent=state.end?"退勤済み":state.start?"勤務中":"出勤前";
 for(const kind of ["start","end"]){
  const input=$(kind+"Time");if(input.value!==state[kind])input.value=state[kind];
  input.disabled=kind==="end"&&!state.start;input.setAttribute("aria-label",label(kind));$(kind+"Label").textContent=label(kind);
 }
 $("nextday").disabled=!state.start;$("nextday").checked=state.overnight;
 if(!preserveRest)$("restEditor").innerHTML=restEditor();$("weekArea").innerHTML=week();$("previewError").innerHTML=errorHtml();syncControls();
}
function showError(message){error=message;if($("previewError"))$("previewError").innerHTML=errorHtml();toast(message);}
function breakInput(){
 if(!restOpen||!$("restHours"))return {ok:true,value:state.breakMinutes};
 const a=$("restHours").value,b=$("restMinutes").value;
 if(!/^\d{1,2}$/.test(a)||!/^\d{1,2}$/.test(b)||Number(a)>24||Number(b)>59||Number(a)*60+Number(b)>1440)return {ok:false,error:"休憩は時間と分を0以上の整数で入力してください。"};
 return {ok:true,value:Number(a)*60+Number(b)};
}
function restoreTimeInput(kind){if($(kind+"Time"))$(kind+"Time").value=state[kind];if(state.end&&$("nextday"))$("nextday").checked=state.overnight;}
function editTime(kind,value,nextDay=$("nextday")?.checked){
 if(!value){showError("時刻を入力してください。");restoreTimeInput(kind);return;}
 const rest=breakInput();if(!rest.ok){restoreTimeInput(kind);return showError(rest.error);}
 const candidate={...state,[kind]:value,breakMinutes:rest.value,overnight:kind==="end"?!!nextDay:state.overnight};
 if(!candidate.end)candidate.overnight=false;
 if(!persist(candidate,(kind==="start"?"出勤":"退勤")+"時刻を"+value+"で保存しました")){restoreTimeInput(kind);return;}
 restOpen=false;lock("all",250);syncHome();
}
function resetPunches(){
 if(!hasPunchReset()||view!=="home"||isGuarded("reset")||!state.start&&!state.end)return;
 const next={...state,start:"",end:"",overnight:false};
 if(!persist(next,"出勤・退勤の打刻を取り消しました"))return;
 lock("reset",500);syncHome(true);
}
function punch(kind){
 if(!["start","end"].includes(kind)||isGuarded(kind))return;
 if(kind==="end"&&!state.start)return showError("先に出勤を記録してください。");
 const rest=breakInput();if(!rest.ok)return showError(rest.error);
 const name=kind==="start"?"出勤":"退勤",recorded=!!state[kind];
 const next={...state,[kind]:state.clock.slice(0,5),breakMinutes:rest.value};
 if(kind==="end"||!next.end)next.overnight=false;
 if(!persist(next,next[kind]+"に"+name+(recorded?"を上書きしました":"しました")))return;
 restOpen=false;lock(kind,500);syncHome();
}
document.addEventListener("click",event=>{
 if(embed)return;
 const time=event.target;if(time.matches?.(".time-input")&&!time.disabled){try{time.showPicker?.();}catch{}return;}
 const button=event.target.closest?.("[data-state],[data-action],[data-scene]");if(!button||button.disabled)return;
 if(button.dataset.state||button.dataset.scene){const chosen=button.dataset.scene?(document.documentElement.dataset.theme==="soft"?SOFT_SCENES[button.dataset.scene]:null):SAMPLES[button.dataset.state];if(!chosen)return;state=clone(chosen);view="home";error="";restOpen=false;guard={kind:"",until:0};guardToken++;try{sessionStorage.setItem(KEY,JSON.stringify(state));}catch{}render();return;}
 const action=button.dataset.action;
 if(action==="reset"){state=clone(SAMPLES.working);view="home";restOpen=false;error="";guard={kind:"",until:0};guardToken++;try{sessionStorage.setItem(KEY,JSON.stringify(state));}catch{}render();toast("共通サンプルに戻しました");return;}
 if(action==="reset-punches"){resetPunches();return;}
 if(action==="punch"){punch(button.dataset.punch);return;}
 if(action==="home"||action==="today"){view="home";render();if(action==="today")$("startTime")?.focus({preventScroll:true});return;}
 if(action==="tab"||action==="records"){view=action==="records"?"records":["home","records","menu"].includes(button.dataset.tab)?button.dataset.tab:"home";render();$("nav-"+view)?.focus({preventScroll:true});return;}
 if(action==="rest"||action==="fix-rest"){restOpen=action==="fix-rest"||!restOpen;error="";$("restEditor").innerHTML=restEditor();$("previewError").textContent="";if(restOpen)$("restMinutes").focus({preventScroll:true});return;}
 if(action==="preset"){const n=Number(button.dataset.minutes);if(!PRESETS.includes(n)||!$("restHours"))return;$("restHours").value=Math.floor(n/60);$("restMinutes").value=pad(n%60);PRESETS.forEach(value=>$("preset"+value)?.setAttribute("aria-pressed",String(n===value)));return;}
});
document.addEventListener("change",event=>{
 if(embed)return;const input=event.target;
 if(input.dataset.time){editTime(input.dataset.time,input.value);return;}
 if(input.id==="nextday"&&state.end){editTime("end",state.end,input.checked);return;}
});
document.addEventListener("input",event=>{
 if(embed||!["restHours","restMinutes"].includes(event.target.id))return;
 const rest=breakInput();PRESETS.forEach(value=>$("preset"+value)?.setAttribute("aria-pressed",String(rest.ok&&rest.value===value)));
});
document.addEventListener("submit",event=>{
 if(event.target.id!=="restForm")return;event.preventDefault();if(embed)return;
 const rest=breakInput();if(!rest.ok)return showError(rest.error);
 if(!persist({...state,breakMinutes:rest.value},"休憩時間を"+duration(rest.value)+"で保存しました"))return;
 restOpen=false;syncHome();
});
window.addEventListener("pageshow",event=>{if(event.persisted){state=restore();restOpen=false;error="";render();}});
render();
})();
