(function(){
"use strict";
const C=window.PaperAttendance,config=window.PaperConfig,root=document.getElementById("previewApp"),dialog=document.getElementById("paperDialog");
if(!C||!config||!root||!dialog)return;
const $=id=>document.getElementById(id),h=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const embed=new URLSearchParams(location.search).get("embed")==="1";
if(embed)document.documentElement.setAttribute("data-embed","");
if(new URLSearchParams(location.search).get("screen")==="1")document.documentElement.setAttribute("data-screen","");
const PRESETS=[0,30,45,60,90];
const DETAIL_TABS=[["work","work","勤務内容"],["summary","chart","勤務実績"],["leave","leave","休暇"],["allocation","settings","工数"]];
let now=C.clock(),renderedDay=now.day,sampleClock="",view=config.mode==='local'&&new URLSearchParams(location.search).get('notifications')==='1'?'settings':'home',detail="summary",restOpen=false,error="",toastTimer,lockUntil=0;
let selectedMonth=C.month(now.day).start,settingsTab="defaults",projectIndex=0,placeIndex=0,settingsDraft=null,defaultsDraft=null,editDay="",submitPeriod=null,testSubmission=true;
const settingsPlanDrafts=new Map();
let storageProblem="",data=null,repository=null,unsubscribe=null,loading=false,saving=false;
const pendingControls=new Map();
let punchFeedback=null,feedbackTimer,warningTimer;
let editorReturn="records";const editorDrafts=new Map();
let submissionRepair=null,repairReturnRequested=false;
const editorTimeSignatures=new Map();
const homeDrafts=new Map(),listPositions=new Map();let lastMinute="";
let homeTimeOpen=false,recordsFilter='all',recordsChartOpen=false;
const queuedPhaseDays=new Set();let phaseSaveTimer=null;
let homeWorkTab='note',editorWorkTab='note',leaveConfirmation=null;
let pushTesting=false;
let notificationLanding=config.mode==='local'&&new URLSearchParams(location.search).get('notifications')==='1';
let undoChange=null;
const homeDraft=(day=now.day)=>homeDrafts.get(day)||{};
function setHomeDraft(key,value,day=now.day){homeDrafts.set(day,{...homeDraft(day),[key]:value});}
function clearHomeDraft(...keys){const draft={...homeDraft()};keys.forEach(key=>delete draft[key]);homeDrafts.set(now.day,draft);}
function clearSavedHomeDraft(day,values){const draft={...homeDraft(day)};for(const [key,value] of Object.entries(values))if(JSON.stringify(draft[key])===JSON.stringify(value))delete draft[key];homeDrafts.set(day,draft);}
const listPositionKey=()=>selectedMonth+':'+recordsFilter;
function rememberList(){if(view==="records"&&$("recordList"))listPositions.set(listPositionKey(),{page:window.scrollY});}
function rememberRoute(replace=false){try{history[replace?'replaceState':'pushState']({paper:true,view,month:selectedMonth,day:editDay,origin:editorReturn,recordFilter:recordsFilter,repair:submissionRepair},"");}catch{}}
function restorePosition(){if(view==="records"&&listPositions.has(listPositionKey()))window.scrollTo(0,listPositions.get(listPositionKey()).page);else root.scrollIntoView({block:"start"});}
const record=day=>data.records[day]||C.empty(data);
function editorRecord(day){const saved=record(day),draft=homeDraft(day);return {...saved,...Object.fromEntries(['note','locationId','phases'].filter(key=>Object.hasOwn(draft,key)).map(key=>[key,draft[key]]))};}
function sameRecord(a,b){
 if(!a||!b)return false;
 return ['start','end','overnight','breakMinutes','locationId','note','leave'].every(key=>a[key]===b[key])&&(a.sourceDay||'')===(b.sourceDay||'')&&C.PROJECTS.every(key=>a.allocation?.[key]===b.allocation?.[key])&&C.PHASE_IDS.every(id=>(a.phases||[]).includes(id)===(b.phases||[]).includes(id))&&['P5','SET'].every(key=>a.legacyProjectAllocation?.[key]===b.legacyProjectAllocation?.[key]);
}
const demoMode=()=>config.mode==="demo"&&C.isDemo(data);
const clockNow=()=>{const real=C.clock();return config.mode==="demo"&&sampleClock?{...real,time:sampleClock.slice(0,5),full:sampleClock,minutes:C.timeToMin(sampleClock.slice(0,5))}:real;};
const firstMonth=()=>C.month(C.firstDay(data)).start;
const dayLabel=day=>Number(day.slice(5,7))+"月"+Number(day.slice(8,10))+"日（"+C.WEEK[C.weekday(day)]+"）";
const periodLabel=p=>p.start.replaceAll("-","/")+" 〜 "+p.end.replaceAll("-","/");
const placeName=id=>data.settings.places.find(p=>p.id===id)?.code||"—";
const allocationTotal=r=>C.PROJECTS.reduce((sum,k)=>sum+Math.round(r.allocation[k]*60),0);
function retainLegacyAllocation(next,source){
 if(C.allocationMax(source,"SET")>24&&next.allocation?.SET===source.allocation.SET)next.legacyProjectAllocation=C.clone(source.legacyProjectAllocation);
 else delete next.legacyProjectAllocation;
 return next;
}
const options=(list,current)=>list.map(([value,label])=>'<option value="'+h(value)+'"'+(value===current?' selected':'')+'>'+h(label)+'</option>').join("");
const placeOptions=id=>options(data.settings.places.map(p=>[p.id,p.code]),id);
function compSourceOptions(targetDay,current=""){
 const days=C.compSources(data,targetDay,clockNow()),list=[["",days.length?"元の休日出勤を選択":"対象になる休日出勤がありません"],...days.map(day=>[day,dayLabel(day)+' · '+C.hours(C.worked(data.records[day],day,clockNow()))+'時間'])];
 if(current&&!days.includes(current))list.push([current,dayLabel(current)+'（要確認）']);
 return options(list,current);
}
function syncCompSourceFields(editorMode=false){
 const leave=$(editorMode?'editLeave':'leaveType'),source=$(editorMode?'editSourceDay':'leaveSourceDay');if(!leave||!source)return;
 const comp=leave.value==='comp',targetDay=editorMode?editDay:now.day;
 document.querySelectorAll(editorMode?'.editor-comp-source':'#leaveSourceFields').forEach(node=>node.hidden=!comp);
 if(!comp)source.value='';else{const selected=source.value;source.innerHTML=compSourceOptions(targetDay,selected);}
}
const timeSignature=r=>JSON.stringify([r.start,r.end,r.overnight,r.breakMinutes]);
const paths={home:"M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",calendar:"M5 5h14v16H5zM8 3v4m8-4v4M5 10h14",send:"m3 3 19 9-19 9 4-9-4-9Zm4 9h15",settings:"M4 7h16M4 17h16M8 4v6m8 4v6",chart:"M4 19h17M5 15l5-5 4 3 6-8m-5 0h5v5",leave:"M9 3h6v7h7v5h-7v7H9v-7H2v-5h7V3",work:"M5 7h14v13H5zM9 7V4h6v3M5 12h14m-7-2v4"};
function icon(name){return '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
const phasePaths={requirements:'M8 4h8v4H8zM8 6H5v15h14V6h-3M8 12h8m-8 4h5',design:'m4 18 1-4L16 3l5 5L10 19l-4 1-2-2Zm10-13 5 5M3 6l4-3 3 4m7 10 4 3-3 3',implementation:'m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',test:'M9 3h6m-5 0v6l-6 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-6-9V3M8 15h8m-6 3 1 1 3-3',operations:'M3 4h18v13H3zM8 21h8m-4-4v4M6 12l3-3 3 3 5-5',maintenance:'M21 6a6 6 0 0 1-8 7l-7 7a2 2 0 0 1-3-3l7-7a6 6 0 0 1 7-8l-4 4 4 4 4-4Z',investigation:'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',meeting:'M6 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0m7 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0m7 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0'};
function phaseIcon(id){return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+phasePaths[id]+'"/></svg>';}
function phaseChoices(selected=[],editorMode=false){
 const prefix=editorMode==='defaults'?'defaults':editorMode?'editor':'home',action=editorMode==='defaults'?'default-phase':editorMode?'editor-phase':'work-phase';
 return '<div class="work-phase-field"><div class="work-field-heading"><span class="phase-field-label" id="'+prefix+'PhaseLabel">'+(editorMode==='defaults'?'初期選択するフェーズ':'作業フェーズ')+'</span><span>複数選択可</span></div><div id="'+prefix+'PhaseChoices" class="phase-choices" role="group" aria-labelledby="'+prefix+'PhaseLabel">'+C.PHASES.map(phase=>'<button type="button" class="phase-button" data-action="'+action+'" data-phase="'+phase.id+'" aria-pressed="'+selected.includes(phase.id)+'">'+phaseIcon(phase.id)+'<span>'+phase.label+'</span></button>').join('')+'</div></div>';
}
function selectedPhases(editorMode=false){
 if(editorMode)return [...($('editorPhaseChoices')?.querySelectorAll('[aria-pressed="true"]')||[])].map(button=>button.dataset.phase);
 return homeDraft().phases??record(now.day).phases??[];
}
function syncPhaseChoices(){
 const selected=selectedPhases();$('homePhaseChoices')?.querySelectorAll('[data-phase]').forEach(button=>button.setAttribute('aria-pressed',String(selected.includes(button.dataset.phase))));
 syncWorkTabCount();
}
function workTabs(note,selected=[],editorMode=false){
 const prefix=editorMode?'editor':'home',active=editorMode?editorWorkTab:homeWorkTab;
 return '<div class="work-content-tabs" data-work-context="'+prefix+'"><div class="work-tab-list" role="tablist" aria-label="勤務内容の入力">'+[['note','作業内容','requirements'],['phases','フェーズ','design']].map(([id,label,ic])=>'<button type="button" role="tab" id="'+prefix+'WorkTab-'+id+'" data-action="work-content-tab" data-panel="'+id+'" aria-controls="'+prefix+'WorkPanel-'+id+'" aria-selected="'+(active===id)+'" tabindex="'+(active===id?'0':'-1')+'">'+phaseIcon(ic)+'<span>'+label+'</span>'+(id==='phases'?'<span class="phase-count" aria-label="'+selected.length+'件選択">'+selected.length+'</span>':'')+'</button>').join('')+'</div><div class="work-tab-panels"><div role="tabpanel" class="work-tab-panel" id="'+prefix+'WorkPanel-note" aria-labelledby="'+prefix+'WorkTab-note" '+(active==='note'?'':'hidden')+'>'+note+'</div><div role="tabpanel" class="work-tab-panel" id="'+prefix+'WorkPanel-phases" aria-labelledby="'+prefix+'WorkTab-phases" '+(active==='phases'?'':'hidden')+'>'+phaseChoices(selected,editorMode)+'</div></div></div>';
}
function switchWorkTab(button,focus=false){
 const container=button.closest('.work-content-tabs'),panel=button.dataset.panel;if(!container||!['note','phases'].includes(panel))return;
 if(container.dataset.workContext==='editor')editorWorkTab=panel;else homeWorkTab=panel;
 container.querySelectorAll('[role="tab"]').forEach(tab=>{const active=tab===button;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$(tab.getAttribute('aria-controls')).hidden=!active;});
 if(focus)button.focus({preventScroll:true});
}
function syncWorkTabCount(editorMode=false){
 const count=$(editorMode?'editorWorkTab-phases':'homeWorkTab-phases')?.querySelector('.phase-count');if(!count)return;
 const size=selectedPhases(editorMode).length;count.textContent=size;count.setAttribute('aria-label',size+'件選択');
}
const leavePaths={
 '':'M5 5h14v16H5zM8 3v4m8-4v4M8 14l3 3 5-6',
 paid:'M3 11a9 9 0 0 1 18 0H3Zm9-9v17a2 2 0 0 0 4 0M7 11a17 17 0 0 1 5-8 17 17 0 0 1 5 8',
 am:'M3 17h18M5 13a7 7 0 0 1 14 0M12 2v3M4 5l2 2m12 0 2-2M9 21l3-3 3 3',
 pm:'M3 17h18M5 13a7 7 0 0 1 14 0M12 2v3M4 5l2 2m12 0 2-2M9 19l3 3 3-3',
 holiday:'M4 7h12v8a5 5 0 0 1-10 0V7Zm12 1h2a3 3 0 0 1 0 6h-2M3 21h17M8 2v2m4-2v2',
 special:'M12 21 3.5 12.5a5.7 5.7 0 0 1 8.5-7.6 5.7 5.7 0 0 1 8.5 7.6L12 21Z',
 comp:'M5 5h14v16H5zM8 3v4m8-4v4M8 12h8m-2-2 2 2-2 2m2 3H8m2-2-2 2 2 2'
};
function leaveChoices(value,editorMode=false){
 const prefix=editorMode?'editor':'home',field=editorMode?'editLeave':'leaveType';
 return '<div class="leave-choice-field"><span class="paper-label" id="'+prefix+'LeaveLabel">'+(editorMode?'休日設定':'今日の休暇')+'</span><input type="hidden" id="'+field+'" value="'+h(value)+'"><div class="leave-choices" role="group" aria-labelledby="'+prefix+'LeaveLabel">'+Object.entries(C.LEAVES).map(([id,label])=>'<button type="button" class="leave-choice" data-action="'+(editorMode?'editor-leave':'home-leave')+'" data-leave="'+id+'" aria-label="'+h(label)+'" aria-pressed="'+(value===id)+'"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+leavePaths[id]+'"/></svg><span>'+h(id==='paid'?'有給休暇':label)+'</span></button>').join('')+'</div></div>';
}
function syncLeaveChoices(editorMode=false){
 const input=$(editorMode?'editLeave':'leaveType');if(!input)return;
 input.closest('.leave-choice-field').querySelectorAll('[data-leave]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.leave===input.value)));
}
function latestLeaveRequest(day){return Object.values(data.leaveRequests||{}).filter(request=>request.day===day).at(-1);}
function syncLeaveStatus(){
 for(const [id,editorMode] of [['leaveSaveStatus',false],['editorLeaveSaveStatus',true]]){
  const node=$(id);if(!node)continue;
  const day=editorMode?editDay:now.day,r=record(day),draft=homeDraft(day),leave=editorMode?$('editLeave').value:draft.leave??r.leave,sourceDay=editorMode?$('editSourceDay').value:draft.sourceDay??r.sourceDay??'',dirty=leave!==r.leave||(leave==='comp'?sourceDay:'')!==(r.sourceDay||'');
  node.dataset.saveState=saving?'saving':dirty?'dirty':'automatic';node.textContent=saving?'保存中です':dirty?'選択中・送信で確定します':latestLeaveRequest(day)?'申請内容を保存済み・管理者送信は未接続':'休暇を選んで送信してください';
 }
}
function leaveRequestedAt(current){return new Date(current.day+'T'+(current.full||C.time(current.minutes)+':00')+'+09:00').toISOString();}
function openLeaveRequest(editorMode=false,repairIntent=null){
 if(saving)return;
 const current=clockNow();if(!editorMode&&current.day!==renderedDay){render();toast('日付が変わりました。今日の画面を確認して再操作してください。',{warning:true});return;}
 now=current;const day=editorMode?editDay:renderedDay,leave=$(editorMode?'editLeave':'leaveType').value,sourceDay=leave==='comp'?$(editorMode?'editSourceDay':'leaveSourceDay').value:'',r=record(day),last=latestLeaveRequest(day);
 if(!leave&&!r.leave){toast('申請する休暇を選んでください。',{warning:true});return;}
 if(last&&last.leave===leave&&last.sourceDay===sourceDay&&r.leave===leave&&(r.sourceDay||'')===sourceDay){toast('同じ内容の申請は、この端末に保存済みです。勤怠の変更は「更新」で保存してください。管理者への送信先は未接続です。');return;}
 if(editorMode&&C.PROJECTS.some(key=>$("editAlloc"+key).value.trim()===""||!$("editAlloc"+key).validity.valid)){toast("工数を0〜24時間で入力してください。",{warning:true});return;}
 if(editorMode)captureEditor();
 const edited=editorMode?C.clone(readEditor().record):null,id='lr-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12)),snapshot={id,day,leave,sourceDay,revision:data.revision,editor:editorMode,record:edited,homeDraft:homeDraft(day),repair:repairIntent&&repairActive()?submissionRepair:null,repairIntent};
 const checked=C.prepareLeaveRequest(data,{id,day,leave,sourceDay,requestedAt:leaveRequestedAt(current)},current,editorMode?{record:edited,strictAllocation:true}:{});
 if(!checked.ok){toast(checked.error,{warning:true});return;}
 openDialog(dialogHeader(leave?'休暇申請の確認':'休暇の解除申請',dayLabel(day))+'<p class="leave-request-message">'+(leave?'管理者に休暇申請を行います':'管理者に休暇の解除を申請します')+'</p><dl class="summary-lines leave-request-summary"><div><dt>対象日</dt><dd>'+h(dayLabel(day))+'</dd></div><div><dt>休暇区分</dt><dd>'+h(C.LEAVES[leave])+'</dd></div>'+(sourceDay?'<div><dt>元の休日出勤</dt><dd>'+h(dayLabel(sourceDay))+'</dd></div>':'')+'</dl>'+(C.fullLeave({leave})?'<p class="panel-note">確定すると出勤・退勤時刻をクリアし、実働・工数を0時間にします。</p>':'')+'<div class="paper-notice"><strong>管理者への送信先は未接続です</strong><p>ここでは申請内容をこのブラウザに保存します。管理者にはまだ送信されません。承認待ちは行わず、確定した休暇を勤怠へ反映します。</p></div>'+dialogError()+'<div class="paper-actions"><button type="button" class="paper-button secondary" data-action="close-dialog">キャンセル</button><button type="button" class="paper-button" data-action="confirm-leave-request">送信する</button></div>');
 leaveConfirmation=snapshot;
}
async function confirmLeaveRequest(){
 const snapshot=leaveConfirmation;if(saving||!snapshot)return;
 if(snapshot.revision!==data.revision){toast('記録が更新されています。確認画面を閉じ、内容を確認して再送信してください。',{warning:true});return;}
 const current=clockNow(),{id,day,leave,sourceDay}=snapshot,prepared=C.prepareLeaveRequest(data,{id,day,leave,sourceDay,requestedAt:leaveRequestedAt(current)},current,snapshot.editor?{record:snapshot.record,strictAllocation:true}:{});
 if(!prepared.ok){toast(prepared.error,{warning:true});return;}
 const previous=record(day),editorDraft=editorDrafts.get(day);now=current;
 if(!await commit(prepared.value,'申請内容をこの端末に保存しました。管理者への送信先は未接続です。',{expectedRevision:snapshot.revision})){syncLeaveStatus();return;}
 const pendingEditor=editorDrafts.get(day);if(pendingEditor&&(snapshot.editor?sameRecord(pendingEditor.record,snapshot.record):pendingEditor===editorDraft&&(sameRecord(pendingEditor.record,previous)||sameRecord(pendingEditor.record,prepared.record))))editorDrafts.delete(day);
 const resolved=snapshot.editor&&homeDraft(day)===snapshot.homeDraft?{...prepared.record,...Object.fromEntries(['note','locationId','phases'].filter(key=>Object.hasOwn(snapshot.homeDraft,key)).map(key=>[key,snapshot.homeDraft[key]]))}:{leave,sourceDay};
 clearSavedHomeDraft(day,resolved);if(C.fullLeave(prepared.record))clearSavedHomeDraft(day,{allocation:homeDraft(day).allocation});
 if(leaveConfirmation===snapshot)closeDialog();
 if(snapshot.repair&&continueSubmissionRepair(day,snapshot.repairIntent,snapshot.repair))return;
 if(view==='home'&&renderedDay===clockNow().day)syncHome();else render();
 if(prepared.warnings?.length)showWarning(dayLabel(day)+'：'+prepared.warnings.join(' '));
}
function cancelPhaseSave(){queuedPhaseDays.clear();if(phaseSaveTimer!==null){clearTimeout(phaseSaveTimer);phaseSaveTimer=null;}}
function schedulePhaseSave(){
 if(saving||!queuedPhaseDays.size||phaseSaveTimer!==null)return;
 phaseSaveTimer=setTimeout(async()=>{
  phaseSaveTimer=null;if(saving||!queuedPhaseDays.size)return;
  const day=queuedPhaseDays.values().next().value;queuedPhaseDays.delete(day);
  const selected=homeDraft(day).phases;if(!Array.isArray(selected))return;
  await saveWork({phases:[...selected]},day===clockNow().day?'フェーズを保存しました':dayLabel(day)+'のフェーズを保存しました',{day});
  schedulePhaseSave();
 },0);
}
function dismissUndo(){
 undoChange=null;const button=$('undoLastChange');if(button)button.remove();$('studyToast')?.classList.remove('has-undo');
}
function toast(message,{warning=false,undo=null}={}){
 if(embed)return;clearTimeout(warningTimer);dismissUndo();const node=$('studyToast');node.textContent=message;
 node.classList.toggle('is-warning',warning);node.classList.add('visible');clearTimeout(toastTimer);
 if(undo){undoChange=undo;node.classList.add('has-undo');const button=document.createElement('button');button.type='button';button.id='undoLastChange';button.dataset.action='undo-change';button.textContent='元に戻す';node.appendChild(button);}
 toastTimer=setTimeout(()=>{node.classList.remove('visible');dismissUndo();},undo?15000:warning?7000:3600);
}
function undoSnapshot(day){
 return {day,record:data.records[day]?C.clone(data.records[day]):null,home:homeDrafts.has(day)?C.clone(homeDrafts.get(day)):null,editor:editorDrafts.has(day)?C.clone(editorDrafts.get(day)):null,homeToken:homeDrafts.get(day),editorToken:editorDrafts.get(day)};
}
function refreshUndoDrafts(snapshot){
 if(homeDrafts.get(snapshot.day)!==snapshot.homeToken)snapshot.home=homeDrafts.has(snapshot.day)?C.clone(homeDrafts.get(snapshot.day)):null;
 if(editorDrafts.get(snapshot.day)!==snapshot.editorToken)snapshot.editor=editorDrafts.has(snapshot.day)?C.clone(editorDrafts.get(snapshot.day)):null;
}
function offerUndo(snapshot,message){toast(message,{undo:{...snapshot,revision:data.revision}});}
async function restoreUndo(){
 const snapshot=undoChange;if(!snapshot||saving)return;
 if(snapshot.revision!==data.revision){toast('その後に変更があるため、元に戻せません。勤怠の内容を確認してください。',{warning:true});return;}
 const {day}=snapshot,current=clockNow(),relation=C.validateRecordChange(data,day,snapshot.record,current);
 if(!relation.ok){toast(relation.error,{warning:true});return;}
 const pendingHome=homeDrafts.get(day),pendingEditor=editorDrafts.get(day),editorAtStart=pendingEditor||(view==='editor'&&editDay===day?readEditor():null);
 const next=C.clone(data);if(snapshot.record)next.records[day]=C.clone(snapshot.record);else delete next.records[day];C.invalidateSubmissions(next,day);
 if(!await commit(next,dayLabel(day)+'の取消を元に戻しました',{expectedRevision:snapshot.revision}))return;
 if(homeDrafts.get(day)===pendingHome){if(snapshot.home)homeDrafts.set(day,C.clone(snapshot.home));else homeDrafts.delete(day);}
 const latestEditor=editorDrafts.get(day);
 if(latestEditor===pendingEditor||editorAtStart&&latestEditor&&sameRecord(latestEditor.record,editorAtStart.record)&&latestEditor.breakText===editorAtStart.breakText){if(snapshot.editor)editorDrafts.set(day,C.clone(snapshot.editor));else editorDrafts.delete(day);}
 now=current;const top=window.scrollY;render();window.scrollTo(0,top);
}
function showError(message){error=message;const box=dialog.open?$("dialogError"):$("previewError");if(box)box.textContent=message;toast(message);}
function showWarning(message){
 toast(message,{warning:true});
}
function repositoryMessage(issue,fallback){
 if(issue?.code==="conflict")return "別の画面で記録が更新されています。再読み込みしてから操作してください。";
 return issue?.message||fallback;
}
function syncPendingControls(){
 if(!saving)return;
 const selector='input,select,textarea,button[type="submit"],[data-action="rest"],[data-action="quick-rest"],[data-action="allocate-rest"],[data-action="clear-day"],[data-action="reset-defaults"],[data-action="retry-work"],[data-action="confirm-submission"],[data-action="plan-auto"],[data-action="project-tab"],[data-action="project-step"],[data-action="place-tab"],[data-action="default-break"],[data-action="editor-phase"],[data-action="home-leave"],[data-action="editor-leave"],[data-action="default-phase"],[data-action="confirm-leave-request"],[data-action="editor-leave-request"],[data-action="logout"],[data-action="confirm-logout"],[data-action="push-test"]';
 const controls=[...root.querySelectorAll(selector),...dialog.querySelectorAll(selector),...document.querySelectorAll('[data-state],[data-action="reset"],[data-action="live"]')];
 for(const node of controls){if(node.id==="workNote")continue;if(!pendingControls.has(node))pendingControls.set(node,node.disabled);node.disabled=true;}
}
function setSaving(value){
 saving=value;root.setAttribute("aria-busy",String(value));
 if(value)syncPendingControls();else{for(const [node,disabled] of pendingControls)node.disabled=disabled;pendingControls.clear();}
 if($("punchActions"))$("punchActions").innerHTML=punches();
 syncWorkStatus();
 syncLeaveStatus();syncPushSettings();syncSaveStatus();
 if(!value)schedulePhaseSave();
}
function beginSave(){
 if(!data||!repository||storageProblem){showError(storageProblem||"記録を読み込んでから操作してください。");return false;}
 if(saving){showError("保存中です。完了してから操作してください。");return false;}
 setSaving(true);return true;
}
async function commit(next,message,{locked=false,expectedRevision=data?.revision}={}){
 if(!locked&&!beginSave())return false;
 try{
  const saved=await repository.save(next,{expectedRevision});
  data=saved;error="";for(const id of ["previewError","dialogError"])if($(id))$(id).textContent="";if(message)toast(message);return true;
 }catch(issue){cancelPhaseSave();showError(repositoryMessage(issue,"保存できませんでした。記録は変更していません。保存設定を確認して再操作してください。"));return false;}
 finally{if(!locked)setSaving(false);}
}
async function assertCurrent(){
 const expectedRevision=data?.revision;if(!beginSave())return false;
 try{await repository.assertCurrent(expectedRevision);error="";if($("previewError"))$("previewError").textContent="";return true;}
 catch(issue){cancelPhaseSave();showError(repositoryMessage(issue,"記録を確認できませんでした。もう一度お試しください。"));return false;}
 finally{setSaving(false);}
}
async function saveRecord(day,next,message,options={}){
 next={...next,sourceDay:next.leave==='comp'?(next.sourceDay||''):''};
 const check=C.validateRecord(next,day,now,data.settings,options);if(!check.ok){if(options.strictAllocation||options.toastOnly||next.leave==='comp')toast("保存できません。"+check.error,{warning:true});else showError(check.error);return false;}
 const relation=C.validateRecordChange(data,day,check.value,now);if(!relation.ok){toast(relation.error,{warning:true});return false;}
 const previous=data.records[day],editorDraft=editorDrafts.get(day);
 if(previous&&Object.keys(check.value).every(k=>JSON.stringify(previous[k])===JSON.stringify(check.value[k]))){
  return await assertCurrent();
 }
 const changed=["start","end","overnight","breakMinutes","leave"].some(k=>previous?.[k]!==next[k])||C.PROJECTS.some(k=>previous?.allocation[k]!==next.allocation[k]);
 const candidate=C.clone(data);candidate.records[day]=check.value;C.invalidateSubmissions(candidate,day);
 const saved=await commit(candidate,message);
 if(saved&&editorDraft&&editorDrafts.get(day)===editorDraft&&(sameRecord(editorDraft.record,check.value)||sameRecord(editorDraft.record,previous||C.empty(data))))editorDrafts.delete(day);
 if(saved&&changed){clearTimeout(warningTimer);if(check.warnings?.length){const revision=data.revision;warningTimer=setTimeout(()=>{if(!saving&&data.revision===revision)showWarning(dayLabel(day)+"："+check.warnings.join(" "));},0);}}
 return saved;
}
async function updateToday(change,message,options={}){
 now=clockNow();
 if(now.day!==renderedDay){render();showError("日付が変わりました。今日の画面を確認して再操作してください。");return false;}
 const day=now.day,previous=record(day),base=Object.hasOwn(change,'leave')?C.changeLeave(previous,change.leave,day,now):previous,next=retainLegacyAllocation({...base,...change},base),candidate=options.autoAllocate?C.allocateToP1(next,day,now):next;
 const saved=await saveRecord(day,candidate,message,options);
 if(saved&&options.autoAllocate&&homeDraft(day).allocation){
  const draft=homeDraft(day).allocation,valid=C.PROJECTS.every(k=>String(draft[k]??'').trim()!==''&&Number.isFinite(Number(draft[k]))&&Number(draft[k])>=0&&Number(draft[k])<=C.allocationMax(next,k)&&Math.abs(Number(draft[k])*60-Math.round(Number(draft[k])*60))<=1e-5);
  if(valid){const pending=C.allocateToP1({...next,allocation:Object.fromEntries(C.PROJECTS.map(k=>[k,Number(draft[k])]))},day,clockNow());setHomeDraft('allocation',Object.fromEntries(C.PROJECTS.map(k=>[k,String(pending.allocation[k])])),day);}
 }
 return saved;
}
async function saveWork(change,message,{day=renderedDay}={}){
 if(saving){syncWorkStatus();return false;}
 now=clockNow();const saved=await saveRecord(day,{...record(day),...change},message);
 if(saved)clearSavedHomeDraft(day,change);
 else cancelPhaseSave();
 if(now.day!==renderedDay)render();
 syncPhaseChoices();syncWorkStatus();return saved;
}
function status(r){return C.fullLeave(r)?C.LEAVES[r.leave]:r.end?"退勤済み":r.start?"勤務中":"出勤前";}
function punches(){
 const r=record(now.day),locked=saving||Date.now()<lockUntil;
 return ["start","end"].map(kind=>{
  const name=kind==="start"?"出勤":"退勤",value=r[kind],disabled=locked||C.fullLeave(r)||kind==="end"&&!r.start;
  const success=!!value&&punchFeedback?.time===value&&punchFeedback?.kind===kind&&punchFeedback.day===now.day&&Date.now()<punchFeedback.until;
  const caption=success?'<span class="punch-success"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'+name+'完了</span>':'<span class="punch-caption">'+name+'打刻</span>';
  return '<button id="'+kind+'Punch" type="button" class="punch-button'+(value?' is-recorded':'')+(success?' is-success':'')+'" data-action="punch" data-kind="'+kind+'" aria-label="'+name+'打刻'+(value?'、'+value+'。現在時刻で上書き':'')+'" '+(disabled?'disabled':'')+'>'+caption+(value?'<time class="punch-time">'+(kind==="end"&&r.overnight?'翌 ':'')+value+'</time>':'')+'</button>';
 }).join("")+'<button id="resetPunch" type="button" class="punch-button punch-reset" data-action="reset-punches" aria-label="今日の出勤・退勤と工数を取り消す" '+(locked||!r.start&&!r.end?'disabled':'')+'><span class="punch-caption">打刻取消</span></button>';
}
function lockPunches(ms=500){lockUntil=Date.now()+ms;if($("punchActions"))$("punchActions").innerHTML=punches();setTimeout(()=>{if($("punchActions"))$("punchActions").innerHTML=punches();},ms+10);}
function animatePunch(kind){
 const feedback={kind,time:record(now.day)[kind],day:now.day,until:Date.now()+850};punchFeedback=feedback;clearTimeout(feedbackTimer);
 feedbackTimer=setTimeout(()=>{if(punchFeedback!==feedback)return;punchFeedback=null;if($("punchActions"))$("punchActions").innerHTML=punches();},850);
}
function editIcon(){return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 4 4 4M5 15 16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-5 2 2-5Z"/></svg>';}
function customRestIcon(open){return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(open?'<path d="m6 6 12 12M6 18 18 6"/>':'<path d="M12 20a9 9 0 1 1 8-13M11 5v6l-3 2m7 2 5-5 2 2-5 5-3 1 1-3Z"/>')+'</svg>';}
function restEditor(){
 const r=record(now.day);
 const draft=homeDraft().rest||{hours:String(Math.floor(r.breakMinutes/60)),minutes:String(r.breakMinutes%60)};
 return '<div class="rest-row"><span>休憩時間</span><strong>'+C.duration(r.breakMinutes)+'</strong><button class="text-button paper-edit-button rest-change'+(homeDraft().rest?' has-draft':'')+'" type="button" data-action="rest" aria-expanded="'+restOpen+'" aria-label="'+(restOpen?'休憩の自由入力を閉じる':homeDraft().rest?'休憩時間を自由入力、未保存の入力あり':'休憩時間を自由入力')+'" aria-controls="restCustomFields">'+customRestIcon(restOpen)+'</button></div><div class="rest-presets rest-quick-presets" role="group" aria-label="休憩時間を選んで保存">'+PRESETS.map(n=>'<button type="button" data-action="quick-rest" data-minutes="'+n+'" aria-pressed="'+(r.breakMinutes===n)+'">'+n+'分'+(n===60?'<span class="sr-only">（標準の1時間）</span>':'')+'</button>').join("")+'</div><p class="rest-quick-note">タップで保存・標準は60分（1時間）</p>'+'<div id="restCustomFields" '+(restOpen?'':'hidden')+'>'+(restOpen?'<form id="restForm" class="rest-form"><div class="rest-inputs"><label class="sr-only" for="restHours">休憩の時間</label><input id="restHours" type="number" min="0" max="24" required value="'+h(draft.hours)+'"><span>時間</span><label class="sr-only" for="restMinutes">休憩の分</label><input id="restMinutes" type="number" min="0" max="59" required value="'+h(draft.minutes)+'"><span>分</span><button type="submit" class="small-save">保存</button></div></form>':'')+'</div>';
}
function readRest(){
 if((!restOpen||!$("restHours"))&&!homeDraft().rest)return record(now.day).breakMinutes;
 const a=restOpen&&$("restHours")?$("restHours").value:homeDraft().rest.hours,b=restOpen&&$("restMinutes")?$("restMinutes").value:homeDraft().rest.minutes;
 if(!/^\d{1,2}$/.test(a)||!/^\d{1,2}$/.test(b)||Number(a)>24||Number(b)>59||Number(a)*60+Number(b)>1440){showError("休憩は0時間00分〜24時間00分で入力してください。");return null;}
 return Number(a)*60+Number(b);
}
function planningCaption(planned){
 const manual=Object.hasOwn(data.settings.plannedHoursByMonth||{},now.day.slice(0,7)),days=C.monthWorkdays(now.day);
 return '<div class="planned-caption" role="group" aria-label="今月の勤務予定"><div class="planned-heading"><span>勤務予定</span><button type="button" class="text-button paper-edit-button planned-change" data-action="edit-plan" aria-label="今月の勤務予定を変更">'+editIcon()+'<span>変更</span></button></div><strong class="planned-value"><span id="plannedHoursValue">'+(planned==null?'—':planned)+'</span><small id="plannedHoursUnit">'+(planned==null?'':'時間')+'</small></strong><span class="planned-source">'+(manual?'手動設定':days==null?'祝日データ未収録':'平日'+days+'日 × 8時間')+'</span></div>';
}
function absenceSummary(minutes,id,day){
 const known=C.monthWorkdays(day)!=null;
 return '<div class="absence-summary" role="group" aria-label="月の欠勤時間"><p class="absence-summary-line"><span>'+(id==='homeAbsence'?'今月の欠勤時間':'この月の欠勤時間')+'</span><strong id="'+id+'">'+(known?C.duration(minutes):'—')+'</strong></p><p class="absence-summary-note">'+(known?id==='homeAbsence'?'入力済み平日・半休4時間分':'記録済みの平日を集計・半休は4時間分':'祝日データ未収録のため集計できません')+'</p></div>';
}
function summaryPanel(){
 const fiscalYear=Number(now.day.slice(0,4))-(Number(now.day.slice(5,7))<4?1:0);
 const r=record(now.day),month=C.summary(data,C.month(now.day),now),annual=C.summary(data,{start:fiscalYear+"-04-01",end:(fiscalYear+1)+"-03-31"},now);
 const monthDays=C.monthWorkdays(now.day),planned=C.plannedHours(data.settings,now.day),ratio=planned>0?Math.max(0,month.minutes/(planned*60)):0,percent=planned>0?Math.round(ratio*100):null,totalAllocation=C.PROJECTS.reduce((sum,k)=>sum+month.allocation[k],0),today=C.worked(r,now.day,now);
 const remaining=planned-C.hours(month.minutes),leftText=planned==null?'予定未設定':planned<=0?'予定未設定':remaining>=0?'予定まで '+Number(remaining.toFixed(2))+'時間':Number((-remaining).toFixed(2))+'時間 予定を達成';
 return '<section class="detail-panel performance-panel" aria-labelledby="performanceTitle"><div class="performance-heading"><h2 id="performanceTitle">勤務実績</h2><span>'+now.day.slice(0,4)+' / '+now.day.slice(5,7)+'</span></div><div class="monthly-summary-card"><div class="performance-overview"><div class="progress-ring" role="img" aria-label="今月の勤務予定に対して'+(percent==null?'予定未設定':percent+'パーセント')+'"><svg viewBox="0 0 160 160" aria-hidden="true"><circle class="ring-track" cx="80" cy="80" r="64"/><circle id="progressArc" class="ring-progress" cx="80" cy="80" r="64" pathLength="100" stroke-dasharray="100" stroke-dashoffset="'+(100-Math.min(1,ratio)*100)+'"/></svg><div class="ring-label"><span id="monthlyPercent">'+(percent==null?'—':percent)+'<small>'+(percent==null?'':'%')+'</small></span><span>予定に対して</span></div></div><div class="monthly-figure"><span class="performance-eyebrow">今月の勤務時間</span><strong id="monthWorked">'+C.hours(month.minutes)+'<small>時間</small></strong><span class="remaining-caption" id="remainingHours">'+leftText+'</span></div></div><div class="monthly-summary-details">'+absenceSummary(month.absenceMinutes,"homeAbsence",now.day)+planningCaption(planned)+'</div></div><dl class="performance-facts performance-facts-four"><div><dt>本日の勤務</dt><dd id="todayWorked"'+(today<0?' class="negative-value"':'')+'>'+C.short(today)+'</dd></div><div><dt>今月の勤務日</dt><dd>'+month.days+'<small>日</small></dd></div><div><dt>有給取得</dt><dd id="homePaidLeave">'+annual.leave+'<small>日</small></dd><span class="performance-fact-note">'+fiscalYear+'/4〜'+(fiscalYear+1)+'/3</span></div><div><dt>今月の平日</dt><dd id="homeWorkdays">'+(monthDays==null?'—':monthDays)+'<small>日</small></dd><span class="performance-fact-note">'+(monthDays==null?'祝日データ未収録':'土日・祝日を除く')+'</span></div></dl><div class="project-chart-heading"><h3>工数の内訳</h3><span>計 '+Number(totalAllocation.toFixed(2))+'時間</span></div><div class="allocation-strip" aria-hidden="true">'+C.PROJECTS.map((k,i)=>'<span class="project-color-'+i+'" style="width:'+(totalAllocation>0?month.allocation[k]/totalAllocation*100:0)+'%"></span>').join("")+'</div><dl class="project-breakdown">'+C.PROJECTS.map((k,i)=>'<div><dt><i class="project-color-'+i+'" aria-hidden="true"></i>'+k+'</dt><dd>'+Number(month.allocation[k].toFixed(2))+'<small>時間</small></dd><span class="project-mini-track" aria-hidden="true"><i class="project-color-'+i+'" style="width:'+(totalAllocation>0?month.allocation[k]/totalAllocation*100:0)+'%"></i></span></div>').join("")+'</dl></section>';
}
function syncPerformance(){
 if(!$("monthWorked"))return;
 const sum=C.summary(data,C.month(now.day),now),planned=C.plannedHours(data.settings,now.day),ratio=planned>0?Math.max(0,sum.minutes/(planned*60)):0,percent=planned>0?Math.round(ratio*100):null,today=C.worked(record(now.day),now.day,now),remaining=planned-C.hours(sum.minutes);
 $("todayWorked").textContent=C.short(today);$("todayWorked").classList.toggle("negative-value",today<0);
 $("monthWorked").innerHTML=C.hours(sum.minutes)+'<small>時間</small>';
 $("homeAbsence").textContent=C.monthWorkdays(now.day)==null?'—':C.duration(sum.absenceMinutes);
 $("monthlyPercent").innerHTML=(percent==null?'—':percent)+'<small>'+(percent==null?'':'%')+'</small>';
 $("progressArc").setAttribute("stroke-dashoffset",100-Math.min(1,ratio)*100);
 $("progressArc").closest(".progress-ring").setAttribute("aria-label",'今月の勤務予定に対して'+(percent==null?'予定未設定':percent+'パーセント'));
 $("plannedHoursValue").textContent=planned==null?'—':planned;
 $("plannedHoursUnit").textContent=planned==null?'':'時間';
 $("remainingHours").textContent=planned==null?'予定未設定':planned<=0?'予定未設定':remaining>=0?'予定まで '+Number(remaining.toFixed(2))+'時間':Number((-remaining).toFixed(2))+'時間 予定を達成';
}
function leavePanel(){
 const r=record(now.day),leave=homeDraft().leave??r.leave,sourceDay=homeDraft().sourceDay??r.sourceDay??'';
 return '<section class="detail-panel" aria-labelledby="leaveTitle"><h2 id="leaveTitle">休暇の申請</h2><form id="leaveForm" class="paper-form-card">'+leaveChoices(leave)+'<div id="leaveSourceFields" class="comp-source-fields" '+(leave==='comp'?'':'hidden')+'><label class="paper-label" for="leaveSourceDay">元の休日出勤</label><select id="leaveSourceDay" class="paper-input">'+compSourceOptions(now.day,sourceDay)+'</select><p class="panel-note">代休より前の土日・祝日に勤務した日を選びます。1日の休日出勤につき1日分の代休を登録できます。</p></div><p class="panel-note">全日休暇は実働・工数が0時間になり、入力済みの出勤・退勤時刻もクリアします。半休は勤務時間と併せて記録できます。</p><div class="leave-save-row"><p id="leaveSaveStatus" class="leave-save-status" role="status"></p><div class="leave-form-actions"><button type="submit" class="paper-button">'+icon('send')+'<span>送信</span></button></div></div></form></section>';
}
function allocationFields(r,prefix){return '<div class="allocation-grid">'+C.PROJECTS.map(k=>'<label for="'+prefix+k+'"><span>'+k+'</span><input class="paper-input" id="'+prefix+k+'" name="'+k+'" type="number" min="0" max="'+C.allocationMax(r,k)+'" step="any" inputmode="decimal" required value="'+h(C.fullLeave(r)?0:prefix==="alloc"?(homeDraft().allocation?.[k]??r.allocation[k]):r.allocation[k])+'" '+(C.fullLeave(r)?'disabled':'')+'></label>').join("")+'</div>';}
function allocationPanel(){
 const r=record(now.day),total=C.worked(r,now.day,now);
 return '<section class="detail-panel" aria-labelledby="allocationTitle"><h2 id="allocationTitle">工数の設定</h2><p class="panel-note">'+(C.fullLeave(r)?'全日休暇のため、実働・工数は0時間です。':total<0?'入力済みの工数は保持しています。出退勤と休憩時間を確認してください。':r.start&&r.end?'勤務時間に合わせて、時間単位で配分してください。':'出勤・退勤を入力してから工数を設定してください。')+'</p><form id="allocationForm" class="paper-form-card">'+allocationFields(r,"alloc")+'<div class="allocation-sum"><span>工数合計 <strong id="allocationTotal">'+C.short(allocationTotal(r))+'</strong></span><span>勤務時間 <strong>'+C.short(total)+'</strong></span></div><div class="paper-actions"><button type="button" class="paper-button secondary" data-action="allocate-rest" '+(C.fullLeave(r)||!r.end||total<0?'disabled':'')+'>残りをP1へ</button><button type="submit" class="paper-button" '+(!r.end?'disabled':'')+'>更新</button></div></form></section>';
}
function detailPanel(){return DETAIL_TABS.map(([id])=>'<div class="home-detail-panel" id="detailPanel-'+id+'" role="tabpanel" aria-labelledby="detailTab-'+id+'" '+(detail===id?'':'hidden')+'>'+({work:workFields,summary:summaryPanel,leave:leavePanel,allocation:allocationPanel}[id])()+'</div>').join('');}
function switchDetail(id,focus=false){
 if(!DETAIL_TABS.some(([key])=>key===id))return;detail=id;
 for(const [key] of DETAIL_TABS){const tab=$('detailTab-'+key),panel=$('detailPanel-'+key);if(!tab||!panel)continue;const active=key===id;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;panel.hidden=!active;}
 if(id==='summary')syncPerformance();syncAllocationTotal();syncLeaveStatus();if(focus)$('detailTab-'+id)?.focus({preventScroll:true});
}
function homeOverview(){
 const missingDays=C.pastMissing(data,now);
 return '<div id="homeMissingSlot" class="home-missing-slot" aria-live="polite"><button type="button" id="homeMissingNotice" class="home-missing-notice" data-action="missing-records" '+(missingDays.length?'':'hidden')+'><span class="missing-notice-mark" aria-hidden="true">!</span><span>過去の平日に未入力 <strong>'+missingDays.length+'日</strong></span><span class="missing-notice-link">確認 <span aria-hidden="true">›</span></span></button></div>';
}
function missing(){
 const days=C.pastMissing(data,now),groups=new Map();
 for(const day of days){const key=day.slice(0,7);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(day);}
 return '<section class="subpage missing-page"><button type="button" class="editor-back" data-action="missing-back">← ホームへ</button><h1>過去の未入力</h1><p class="subpage-lede">今日より前の平日で、勤怠の入力が必要な日です。土日祝と、全日休み・全日有休の入力済み日は除いています。</p><div class="missing-page-total"><span>入力が必要な日</span><strong>'+days.length+'<small>日</small></strong></div>'+(days.length?Array.from(groups,([key,list])=>'<section class="missing-month"><h2>'+key.slice(0,4)+'年'+Number(key.slice(5))+'月</h2>'+list.map(day=>'<button type="button" class="missing-day-link" data-action="edit-day" data-day="'+day+'"><span>'+dayLabel(day)+'</span><small>'+ (data.records[day]?.start?'退勤未入力':'未入力')+'</small><span aria-hidden="true">›</span></button>').join('')+'</section>').join(''):'<p class="missing-complete">✓ 過去の平日の未入力はありません。</p>')+'</section>';
}
function week(){
 const start=C.add(now.day,-((C.weekday(now.day)+6)%7)),days=C.dates(start,C.add(start,6)),values=days.map(d=>C.worked(data.records[d],d,now)),max=Math.max(480,...values.map(Math.abs)),total=values.reduce((a,b)=>a+b,0);
 return '<section class="week-section"><div class="week-heading"><h2>今週の記録</h2><span>計 <strong>'+C.short(total)+'</strong></span></div><div class="week-chart">'+days.map((d,i)=>{
  const r=data.records[d],n=values[i],future=d>now.day,before=d<C.firstDay(data),label=before?'利用開始前':future?'これから':C.fullLeave(r)?C.LEAVES[r.leave]:r?.start?C.short(n):C.workday(d)?'未入力':'休み';
  return '<button type="button" class="week-day'+(d===now.day?' is-today':'')+'" data-action="edit-day" data-day="'+d+'" '+(future||before?'disabled':'')+' aria-label="'+dayLabel(d)+' '+label+'"><span class="week-track">'+(n?'<span class="week-bar'+(n<0?' is-negative':'')+'" style="--bar:'+Math.round(Math.abs(n)/max*57)+'px"></span>':'<span class="week-mark">'+(future?'·':C.fullLeave(r)||!C.workday(d)?'—':'○')+'</span>')+'</span><span class="week-value">'+label+'</span><span class="week-date">'+C.WEEK[C.weekday(d)]+' '+Number(d.slice(8))+'</span></button>';
 }).join("")+'</div><p class="week-note">実働・時間:分　日付を選んで記録を確認</p></section>';
}
function workFields(){
 const r=record(now.day),draft=homeDraft(),note='<div class="work-note-field"><div class="work-field-heading"><label for="workNote">作業内容</label><span>1,000文字まで</span></div><textarea class="paper-input" id="workNote" maxlength="1000" rows="3" placeholder="例：テスト対応、仕様の確認">'+h(draft.note??r.note)+'</textarea></div>';
 return '<section class="work-fields paper-form-card" aria-labelledby="homeWorkTitle"><header class="home-work-heading"><span class="home-work-icon" aria-hidden="true">'+icon('work')+'</span><div><h2 id="homeWorkTitle">勤務内容</h2><p>今日の場所と作業を記録</p></div></header><div class="work-place"><label for="workPlace">勤務場所</label><div class="work-place-control"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><select class="paper-input" id="workPlace">'+placeOptions(draft.locationId??r.locationId)+'</select></div></div>'+phaseChoices(draft.phases??r.phases??[])+note+'<div id="workSaveStatus" class="work-save-status" role="status"></div></section>';
}
function home(){
 const r=record(now.day),off=C.fullLeave(r);
 return '<section class="punch-pane"><div class="dayline"><h1>今日の勤怠</h1><strong id="punchState" class="state-tag">'+status(r)+'</strong></div><div id="homeOverview" class="home-overview">'+homeOverview()+'</div><div class="hero-composition"><time class="hero-date" datetime="'+now.day+'">'+dayLabel(now.day)+'<span class="hero-holiday"'+(C.holiday(now.day)?'':' aria-hidden="true"')+'>'+h(C.holiday(now.day))+'</span></time><div class="clock-wrap"><time id="paperClock" class="digital-clock" datetime="'+now.day+'T'+now.full+'+09:00">'+now.time+'<span class="seconds">:'+now.full.slice(-2)+'</span></time><p class="clock-caption">'+(sampleClock?'サンプル時刻':'現在時刻')+'・日本時間'+(sampleClock?' <button type="button" class="clock-live" data-action="live">現在時刻に戻す</button>':'')+'</p></div></div><div id="punchActions" class="punch-actions" aria-label="出退勤の打刻">'+punches()+'</div><section class="paper-form-card home-time-card" aria-label="勤務時間の入力"><details id="homeTimeEditor" class="home-time-disclosure" '+(homeTimeOpen?' open':'')+'><summary>'+editIcon()+'<span>出退勤時刻を手入力・修正</span><span class="disclosure-chevron" aria-hidden="true">⌄</span></summary><div class="time-area"><p id="timeHelp" class="time-help"><strong>時刻は手入力・修正できます</strong><span>自動保存</span></p><div class="time-fields">'+["start","end"].map(k=>'<label for="'+k+'Time"><span>'+ (k==="start"?'出勤':'退勤')+'時刻を'+(r[k]?'編集':'入力')+'</span><input class="time-input" id="'+k+'Time" type="time" value="'+r[k]+'" data-time="'+k+'" aria-describedby="timeHelp" '+(off||k==="end"&&!r.start?'disabled':'')+'></label>').join("")+'</div><label class="nextday"><input id="nextday" type="checkbox" '+(r.overnight?'checked ':'')+(off||!r.start?'disabled':'')+'>翌日に退勤</label></div></details><div id="restEditor">'+restEditor()+'</div></section>'+'</section><nav class="detail-tabs" aria-label="今日の詳細" role="tablist">'+DETAIL_TABS.map(([id,ic,label])=>'<button type="button" role="tab" id="detailTab-'+id+'" data-action="detail" data-detail="'+id+'" aria-controls="detailPanel-'+id+'" aria-selected="'+(detail===id)+'" tabindex="'+(detail===id?'0':'-1')+'">'+icon(ic)+'<span>'+label+'</span></button>').join("")+'</nav><div id="detailArea">'+detailPanel()+'</div><div id="weekArea">'+week()+'</div>';
}
function monthChooser(){return '<div class="month-chooser"><button type="button" class="month-arrow" data-action="month-prev" aria-label="前の月" '+(selectedMonth<=firstMonth()?'disabled':'')+'>←</button><label><span class="sr-only">表示する月</span><input class="month-input" id="monthInput" type="month" min="'+C.firstDay(data).slice(0,7)+'" max="'+now.day.slice(0,7)+'" value="'+selectedMonth.slice(0,7)+'"></label><button type="button" class="month-arrow" data-action="month-next" aria-label="次の月" '+(selectedMonth>=C.month(now.day).start?'disabled':'')+'>→</button></div>';}
function monthChart(){
 const start=C.month(selectedMonth,-6).start<firstMonth()?firstMonth():C.month(selectedMonth,-6).start,months=Array.from({length:10},(_,i)=>C.month(start,i)),totals=months.map(p=>C.summary(data,p,now).minutes),max=Math.max(60,...totals.map(Math.abs));
 return '<section class="annual-section" aria-labelledby="chartTitle"><h2 id="chartTitle">勤務時間集計</h2><div class="annual-scroll"><div class="annual-chart">'+months.map((p,i)=>'<button type="button" class="month-bar'+(p.start===selectedMonth?' selected':'')+(totals[i]<0?' is-negative':'')+'" data-action="chart-month" data-month="'+p.start+'" aria-label="'+p.start.slice(0,7)+' '+C.hours(totals[i])+'時間" '+(p.start>now.day?'disabled':'')+'><span class="month-bar-track"><span style="height:'+Math.round(Math.abs(totals[i])/max*98)+'px"></span></span><b>'+C.hours(totals[i])+'h</b><small>'+p.start.slice(0,7).replace("-","/")+'</small></button>').join("")+'</div></div><p class="week-note">実働時間・月を選択して一覧を表示</p></section>';
}
function monthHolidayNotice(period){
 const label=period.start.slice(0,4)+'年'+Number(period.start.slice(5,7))+'月の祝日';
 const known=C.holidayKnown(period.start)&&C.holidayKnown(period.end),days=known?C.dates(period.start,period.end).filter(day=>C.holiday(day)):[];
 return '<aside class="month-holidays" aria-label="'+label+'"><span class="month-holidays-label">今月の祝日</span>'+(days.length?'<ul class="month-holiday-list">'+days.map(day=>'<li><time datetime="'+day+'">'+Number(day.slice(5,7))+'/'+Number(day.slice(8))+'</time><span>'+h(C.holiday(day))+'</span></li>').join('')+'</ul>':'<p class="month-holiday-empty">'+(known?'今月の祝日はありません':'この月の祝日データは未収録です')+'</p>')+'</aside>';
}
function records(){
 const p=C.month(selectedMonth),summary=C.summary(data,p,now),missingDays=C.pastMissing(data,now).filter(day=>day>=p.start&&day<=p.end),days=recordsFilter==='missing'?missingDays:C.dates(p.start,p.end);
 const rows=days.map(d=>{
  const r=data.records[d],n=C.worked(r,d,now),future=d>now.day,before=d<C.firstDay(data),holiday=C.holiday(d),dayStatus=before?'利用開始前':future?'これから':C.fullLeave(r)?C.LEAVES[r.leave]:r?.start?(r.leave?C.LEAVES[r.leave]+' · ':'')+(r.end?'休憩 '+C.short(r.breakMinutes):'退勤未入力'):C.workday(d)?'未入力':'休み';
  const range=before?'利用開始前':r?.start?r.start+' → '+(r.end?(r.overnight?'翌 ':'')+r.end:'—'):C.fullLeave(r)?dayStatus:holiday||dayStatus;
  const caption=r?.start?[holiday,dayStatus,placeName(r.locationId)].filter(Boolean).join(' · '):holiday?(C.fullLeave(r)?holiday:'祝日'):'';
  return '<button type="button" class="record-item paper-record'+(d===now.day?' is-today':'')+(holiday?' is-holiday':'')+'" data-action="edit-day" data-day="'+d+'" '+(future||before?'disabled':'')+' aria-label="'+h(dayLabel(d)+' '+holiday+' '+range)+'"><span class="record-date weekday-'+C.weekday(d)+'"><b>'+Number(d.slice(8))+'</b><small>'+C.WEEK[C.weekday(d)]+'曜日</small></span><span class="record-times">'+h(range)+'<small>'+h(caption)+'</small></span><span class="record-hours">'+(r?.start?C.short(n):'—')+'<span class="row-chevron" aria-hidden="true">›</span></span></button>';
 }).join("");
 return '<section class="subpage records-page"><h1>'+Number(selectedMonth.slice(5,7))+'月の勤怠</h1><p class="subpage-lede">日付を選んで、打刻・休暇・工数を確認・修正できます。</p>'+monthChooser()+monthHolidayNotice(p)+'<div class="month-summary"><span>勤務 '+summary.days+'日</span><strong>計 '+C.short(summary.minutes)+'</strong><button type="button" class="text-button" data-action="export-month">Excel出力</button></div>'+absenceSummary(summary.absenceMinutes,"monthAbsence",p.start)+'<details id="recordsChart" class="records-chart-disclosure"'+(recordsChartOpen?' open':'')+'><summary>'+icon('chart')+'<span>月ごとの勤務時間</span><span class="disclosure-chevron" aria-hidden="true">⌄</span></summary>'+monthChart()+'</details><div class="record-controls" aria-label="勤怠一覧の表示"><div class="record-filters" role="group" aria-label="表示する記録"><button type="button" data-action="record-filter" data-filter="all" aria-pressed="'+(recordsFilter==='all')+'">すべて</button><button type="button" data-action="record-filter" data-filter="missing" aria-pressed="'+(recordsFilter==='missing')+'">未入力 <span>'+missingDays.length+'</span></button></div><button type="button" class="record-today" data-action="records-today">今日へ</button></div><div class="record-list" id="recordList" aria-label="'+(recordsFilter==='missing'?'過去の平日の未入力':'日別の勤怠')+'">'+(rows||'<p class="records-empty" role="status">この月の過去の平日に未入力はありません。</p>')+'</div><p class="week-note">'+(recordsFilter==='missing'?'今日より前の平日が対象です。土日祝と全日休暇を除きます。':'出勤 → 退勤 ／ 実働時間　未来の日付は編集できません。')+'</p></section>';
}
function submit(){
 const periods=C.periods(selectedMonth);
 return '<section class="subpage"><h1>勤務表の提出</h1><p class="subpage-lede">未入力を確認して、勤務表をまとめます。</p>'+monthChooser()+'<div class="paper-notice"><strong>'+(demoMode()?'提出の操作デモ':'勤務表のExcel出力と履歴')+'</strong><p>勤務表をExcelでダウンロードし、履歴をこの端末に保存します。メールは送信されません。</p></div><h2 class="paper-heading">'+selectedMonth.slice(0,4)+'年'+Number(selectedMonth.slice(5,7))+'月の提出状況</h2><dl class="submission-status">'+[periods[0],periods[2]].map(p=>'<div><dt>'+p.label+'</dt><dd>'+(p.end<C.firstDay(data)?'対象期間なし':C.submissionStatus(data,p))+'</dd></div>').join("")+'</dl><label class="test-toggle"><input id="testSubmission" type="checkbox" role="switch" '+(testSubmission?'checked':'')+'><span class="switch-track" aria-hidden="true"></span><span>'+(demoMode()?'事前確認送信':'テスト提出の履歴')+'<span class="toggle-note">オン：テスト提出 ／ オフ：Excel出力</span></span></label><div class="submit-periods">'+periods.map((p,i)=>'<button type="button" class="period-button" data-action="submit-period" data-index="'+i+'" '+(p.end<C.firstDay(data)?'disabled':'')+'><small>'+p.label+'</small><span>'+Number(p.start.slice(5,7))+'月'+Number(p.start.slice(8))+'日〜'+Number(p.end.slice(5,7))+'月'+(p.end===C.month(p.end).end?'末日':Number(p.end.slice(8))+'日')+'</span><b>'+(p.end<C.firstDay(data)?'対象期間なし':'勤務表を確認 <span aria-hidden="true">→</span>')+'</b></button>').join("")+'</div></section>';
}
function planningHint(manual,day){
 const monthLabel=day.slice(0,4)+'年'+Number(day.slice(5,7))+'月';
 if(manual)return monthLabel+'は「時間を指定」で設定します。ほかの月には影響しません。';
 const days=C.monthWorkdays(day);
 return days==null?monthLabel+'の祝日データは未収録です。時間欄に勤務予定を入力してください。':monthLabel+'：平日'+days+'日 × 8時間 = '+(days*8)+'時間（土日・祝日を除く）。時間を入力すると「時間を指定」に切り替わります。';
}
function planningSettings(s){
 const key=now.day.slice(0,7),manual=Object.hasOwn(s.plannedHoursByMonth||{},key),planned=C.plannedHours(s,now.day),value=Number.isFinite(planned)?planned:'',manualValue=settingsPlanDrafts.has(key)?settingsPlanDrafts.get(key):value;
 return '<div class="planned-settings" data-month="'+key+'" data-planning-mode="'+(manual?'manual':'auto')+'"><label class="paper-label" for="plannedHoursMode">勤務予定の設定</label><select id="plannedHoursMode" class="paper-input">'+options([['auto','平日数 × 8時間（自動）'],['manual','時間を指定（この月のみ）']],manual?'manual':'auto')+'</select><label class="paper-label" for="plannedHours">'+key.slice(0,4)+'年'+Number(key.slice(5))+'月の勤務予定<span class="sr-only">（時間）</span></label><div class="field-unit"><input class="paper-input" type="number" id="plannedHours" min="0" max="744" step="any" inputmode="decimal"'+(manual||value!==''?' required':'')+' value="'+value+'" data-manual-value="'+h(manualValue)+'" data-planning-mode="'+(manual?'manual':'auto')+'" placeholder="—" aria-describedby="plannedHoursHint"><span aria-hidden="true">時間</span></div><p class="panel-note" id="plannedHoursHint" role="status" aria-live="polite" aria-atomic="true">'+planningHint(manual,key+'-01')+'</p></div>';
}
function syncPlanningControls(input){
 const compact=!!input?.closest?.('#planForm'),field=$(compact?'planHoursInput':'plannedHours'),mode=$(compact?'planMode':'plannedHoursMode');
 if(!field||!mode)return;
 const container=compact?$('planForm'):field.closest('.planned-settings'),day=container.dataset.month+'-01',typed=input===field,wasManual=field.dataset.planningMode==='manual';
 if(typed)mode.value='manual';
 const manual=mode.value==='manual';
 if(manual){if(!typed&&!wasManual)field.value=field.dataset.manualValue??'';field.dataset.manualValue=field.value;}
 else{if(wasManual)field.dataset.manualValue=field.value;const days=C.monthWorkdays(day);field.value=days==null?'':days*8;}
 if(!compact&&(manual||wasManual))settingsPlanDrafts.set(container.dataset.month,field.dataset.manualValue);
 field.dataset.planningMode=manual?'manual':'auto';
 container.dataset.planningMode=field.dataset.planningMode;
 field.required=manual||C.monthWorkdays(day)!=null;
 $(compact?'planHoursHint':'plannedHoursHint').textContent=planningHint(manual,day);
}
function reconcilePlanningControls(field){
 if(!field)return;
 const compact=!!field.closest('#planForm'),mode=$(compact?'planMode':'plannedHoursMode'),container=compact?$('planForm'):field.closest('.planned-settings');
 if(!mode||!container||mode.value!=='auto')return;
 const days=C.monthWorkdays(container.dataset.month+'-01'),automatic=days==null?'':String(days*8);
 // Some autofill paths change a value without dispatching input/change; retain that edit too.
 if(field.value!==automatic)syncPlanningControls(field);
}
function openPlan(){
 captureSettings();
 const day=clockNow().day,key=day.slice(0,7),manual=Object.hasOwn(data.settings.plannedHoursByMonth||{},key),planned=C.plannedHours(data.settings,day),value=Number.isFinite(planned)?planned:'';
 openDialog(dialogHeader('勤務予定を変更',key.slice(0,4)+'年'+Number(key.slice(5))+'月の設定')+dialogError()+'<form id="planForm" class="plan-form" data-month="'+key+'"><label class="paper-label" for="planHoursInput">この月の勤務予定（時間）</label><div class="plan-hours-field"><input class="paper-input" type="number" id="planHoursInput" min="0" max="744" step="any" inputmode="decimal"'+(manual||value!==''?' required':'')+' value="'+value+'" data-manual-value="'+value+'" data-planning-mode="'+(manual?'manual':'auto')+'" placeholder="時間を入力" aria-describedby="planHoursHint" autofocus><span aria-hidden="true">時間</span></div><p class="panel-note" id="planHoursHint">'+planningHint(manual,key+'-01')+'</p><label class="paper-label" for="planMode">計算方法</label><select id="planMode" class="paper-input">'+options([['auto','平日数 × 8時間（自動）'],['manual','時間を指定（この月のみ）']],manual?'manual':'auto')+'</select><button type="button" class="text-button plan-auto" data-action="plan-auto">自動計算に戻す</button><div class="paper-actions"><button type="button" class="paper-button secondary" data-action="close-dialog">キャンセル</button><button type="submit" class="paper-button">保存</button></div></form>');
 $('planHoursInput').focus();
}
function projectChanged(project,index){
 const saved=data.settings.projects[index];return !saved||project.name!==saved.name||project.description!==saved.description;
}
function projectSettingsContents(s){
 const p=s.projects[projectIndex];
 return '<h2 id="projectSettingsTitle" class="form-card-heading">プロジェクト</h2><div class="project-tabs" role="group" aria-label="編集するプロジェクト">'+s.projects.map((item,index)=>'<button type="button" data-action="project-tab" data-index="'+index+'" aria-pressed="'+(index===projectIndex)+'" aria-label="'+h(item.id+' '+(item.name.trim()||'名称未入力')+(projectChanged(item,index)?'、未保存の変更あり':''))+'"><strong>'+h(item.id)+'</strong><span class="project-tab-name">'+h(item.name.trim()||'未入力')+'</span><span class="project-tab-draft"'+(projectChanged(item,index)?'':' hidden')+' aria-label="未保存"></span></button>').join('')+'</div><div class="project-editor-title"><span class="project-code">'+h(p.id)+'</span><div><h3>'+h(p.id)+'の情報</h3><span id="projectDraftState" role="status">'+(projectChanged(p,projectIndex)?'未保存の変更あり':'保存済みの内容')+'</span></div></div><label class="paper-label" for="projectName">プロジェクト名・略称</label><input class="paper-input" id="projectName" maxlength="80" required placeholder="例：社内基盤" autocomplete="off" value="'+h(p.name)+'"><label class="paper-label" for="projectDescription">概要・担当する作業</label><textarea class="paper-input" id="projectDescription" maxlength="1000" rows="3" placeholder="担当する業務や作業内容">'+h(p.description)+'</textarea><div class="project-stepper"><button class="paper-button secondary" type="button" data-action="project-step" data-index="'+(projectIndex-1)+'" '+(projectIndex===0?'disabled':'')+'>← '+(projectIndex>0?h(s.projects[projectIndex-1].id)+'へ':'前へ')+'</button><button class="paper-button secondary" type="button" data-action="project-step" data-index="'+(projectIndex+1)+'" '+(projectIndex===s.projects.length-1?'disabled':'')+'>'+(projectIndex<s.projects.length-1?h(s.projects[projectIndex+1].id)+'へ':'次へ')+' →</button></div><p class="project-save-note">入力内容は画面下の「更新」で保存します。</p>';
}
function projectSettings(s){
 projectIndex=Math.max(0,Math.min(projectIndex,s.projects.length-1));
 return '<section id="projectSettingsCard" class="paper-form-card project-settings-card" aria-labelledby="projectSettingsTitle">'+projectSettingsContents(s)+'</section>';
}
function switchProject(index,{focus=false}={}){
 if(saving||!Number.isInteger(index))return;
 captureSettings();const s=settingsDraft||data.settings;if(index<0||index>=s.projects.length)return;
 projectIndex=index;const card=$('projectSettingsCard');if(!card)return;card.innerHTML=projectSettingsContents(s);syncPendingControls();
 if(focus)$('projectName').focus({preventScroll:true});else card.querySelector('[data-action="project-tab"][data-index="'+index+'"]').focus({preventScroll:true});
}
function syncProjectDraft(){
 if(!$('projectSettingsCard')||!settingsDraft)return;
 settingsDraft.projects.forEach((p,index)=>{const button=root.querySelector('[data-action="project-tab"][data-index="'+index+'"]');if(!button)return;const name=p.name.trim()||'未入力';button.querySelector('.project-tab-name').textContent=name;button.setAttribute('aria-label',p.id+' '+name+(projectChanged(p,index)?'、未保存の変更あり':''));button.querySelector('.project-tab-draft').hidden=!projectChanged(p,index);});
 $('projectDraftState').textContent=projectChanged(settingsDraft.projects[projectIndex],projectIndex)?'未保存の変更あり':'保存済みの内容';
}
function invalidProject(s){
 return s.projects.findIndex(p=>typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.description!=='string'||p.description.length>1000);
}
function placeChanged(place,index){
 const saved=data.settings.places[index];return !saved||place.code!==saved.code||place.name!==saved.name||place.address!==saved.address;
}
function placeSettingsContents(s){
 const place=s.places[placeIndex];
 return '<h2 id="placeSettingsTitle" class="form-card-heading">作業場所</h2><div class="place-tabs" role="group" aria-label="編集する作業場所">'+s.places.map((item,index)=>'<button type="button" data-action="place-tab" data-index="'+index+'" aria-pressed="'+(index===placeIndex)+'" aria-label="'+h('場所'+(index+1)+' '+(item.code.trim()||'表示名未入力')+' '+(item.name.trim()||'名称未入力')+(placeChanged(item,index)?'、未保存の変更あり':''))+'"><strong>場所'+(index+1)+'</strong><span class="place-tab-code">'+h(item.code.trim()||'未入力')+'</span><span class="place-tab-name">'+h(item.name.trim()||'名称未入力')+'</span><span class="place-tab-draft"'+(placeChanged(item,index)?'':' hidden')+' aria-label="未保存"></span></button>').join('')+'</div><div class="place-editor-title"><span class="place-code">'+C.pad(placeIndex+1)+'</span><div><h3>場所'+(placeIndex+1)+'の情報</h3><span id="placeDraftState" role="status">'+(placeChanged(place,placeIndex)?'未保存の変更あり':'保存済みの内容')+'</span></div></div><div class="place-fields"><div class="form-field"><label class="paper-label" for="placeCode">表示名・略称</label><input class="paper-input" id="placeCode" required maxlength="80" value="'+h(place.code)+'" placeholder="例：本社" aria-describedby="placeCodeHint"><p id="placeCodeHint" class="field-help">ホームなどの勤務場所の選択肢に表示します。</p></div><div class="form-field"><label class="paper-label" for="placeName">正式名称</label><input class="paper-input" id="placeName" required maxlength="80" value="'+h(place.name)+'" placeholder="例：本社オフィス"></div><div class="form-field"><label class="paper-label" for="placeAddress">住所・建物名</label><textarea class="paper-input" id="placeAddress" maxlength="1000" rows="3" placeholder="住所や建物名、フロアなど">'+h(place.address)+'</textarea></div></div><p class="project-save-note">入力内容は画面下の「更新」で保存します。</p>';
}
function placeSettings(s){
 placeIndex=Math.max(0,Math.min(placeIndex,s.places.length-1));
 return '<section id="placeSettingsCard" class="paper-form-card place-settings-card" aria-labelledby="placeSettingsTitle">'+placeSettingsContents(s)+'</section>';
}
function switchPlace(index,{focus=false}={}){
 if(saving||!Number.isInteger(index))return;
 captureSettings();const s=settingsDraft||data.settings;if(index<0||index>=s.places.length)return;
 placeIndex=index;const card=$('placeSettingsCard');if(!card)return;card.innerHTML=placeSettingsContents(s);syncPendingControls();
 if(focus)$('placeCode').focus({preventScroll:true});else card.querySelector('[data-action="place-tab"][data-index="'+index+'"]').focus({preventScroll:true});
}
function syncPlaceDraft(){
 if(!$('placeSettingsCard')||!settingsDraft)return;
 settingsDraft.places.forEach((place,index)=>{const button=root.querySelector('[data-action="place-tab"][data-index="'+index+'"]');if(!button)return;const code=place.code.trim()||'未入力',name=place.name.trim()||'名称未入力';button.querySelector('.place-tab-code').textContent=code;button.querySelector('.place-tab-name').textContent=name;button.setAttribute('aria-label','場所'+(index+1)+' '+code+' '+name+(placeChanged(place,index)?'、未保存の変更あり':''));button.querySelector('.place-tab-draft').hidden=!placeChanged(place,index);});
 $('placeDraftState').textContent=placeChanged(settingsDraft.places[placeIndex],placeIndex)?'未保存の変更あり':'保存済みの内容';
}
function invalidPlace(s){
 return s.places.findIndex(place=>typeof place.code!=='string'||!place.code.trim()||place.code.length>80||typeof place.name!=='string'||!place.name.trim()||place.name.length>80||typeof place.address!=='string'||place.address.length>1000);
}
function captureDefaults(){
 if(!$('defaultsForm'))return;
 defaultsDraft={locationId:$('defaultPlace').value,note:$('defaultNote').value,phases:[...document.querySelectorAll('#defaultsPhaseChoices [aria-pressed="true"]')].map(button=>button.dataset.phase),breakMinutes:$('defaultBreak').value};
 syncSaveStatus();
}
function defaultsChanged(draft){
 return draft.locationId!==data.defaults.locationId||draft.note!==data.defaults.note||C.PHASE_IDS.some(id=>(draft.phases||[]).includes(id)!==(data.defaults.phases||[]).includes(id))||String(draft.breakMinutes).trim()===''||Number(draft.breakMinutes)!==data.defaults.breakMinutes;
}
function defaultBreakText(value){
 const text=String(value).trim(),minutes=Number(text);
 return text!==''&&Number.isInteger(minutes)&&minutes>=0&&minutes<=1440?C.duration(minutes):'0〜1440分で入力してください。';
}
function syncDefaultsDraft(){
 if(!$('defaultsForm'))return;
 captureDefaults();
 $('defaultBreakHint').textContent=defaultBreakText(defaultsDraft.breakMinutes);
 document.querySelectorAll('[data-action="default-break"]').forEach(button=>button.setAttribute('aria-pressed',String(defaultsDraft.breakMinutes.trim()!==''&&Number(defaultsDraft.breakMinutes)===Number(button.dataset.minutes))));
 $('defaultsDraftState').textContent=defaultsChanged(defaultsDraft)?'未保存の変更あり':'保存済みの内容';
}
function saveToolbar(form,label='更新'){
 const context=form==='dayForm'?dayLabel(editDay):form==='defaultsForm'?'いつもの勤務':'勤務表の設定';
 const primary=form==='dayForm'&&typeof repairSaveLabel==='function'?(repairSaveLabel()||label):label;
 const extra=form==='dayForm'&&typeof repairToolbarAction==='function'?repairToolbarAction():'';
 return '<div id="formSaveBar" class="form-save-bar'+(extra?' has-repair-actions':'')+'" data-form="'+form+'"><div class="form-save-summary"><span class="form-save-context">'+h(context)+'</span><span id="formSaveStatus" role="status" aria-live="polite">変更は更新で保存</span></div><div class="save-toolbar-actions">'+extra+'<button class="paper-button form-save-primary" type="submit">'+h(primary)+'</button></div></div>';
}
function syncSaveStatus(){
 const bar=$('formSaveBar'),status=$('formSaveStatus');if(!bar||!status||!data)return;
 let dirty=false,recorded=true;
 if(bar.dataset.form==='dayForm'&&$('dayForm')){
  dirty=!sameRecord(readEditor().record,record(editDay))||C.PROJECTS.some(key=>$('editAlloc'+key).value.trim()==='');recorded=!!data.records[editDay];
 }else if(bar.dataset.form==='defaultsForm')dirty=!!defaultsDraft&&defaultsChanged(defaultsDraft);
 else if(bar.dataset.form==='settingsForm')dirty=!!settingsDraft&&JSON.stringify(settingsDraft)!==JSON.stringify(data.settings);
 bar.dataset.saveState=saving?'saving':dirty?'dirty':'saved';
 status.textContent=saving?'保存中…':dirty?'未保存の変更あり':recorded?'保存済み':'変更は更新で保存';
 bar.querySelectorAll('.save-toolbar-actions button').forEach(button=>button.disabled=saving);
 root.classList.add('has-save-toolbar');
}
function defaultsSettings(d){
 return '<section class="settings-section"><form id="defaultsForm" class="paper-form-card defaults-settings-card"><div class="defaults-summary">'+icon('settings')+'<div><h2>新しい日の初期値</h2><p>自分の勤務場所・作業概要・フェーズ・休憩の初期値です。</p><span id="defaultsDraftState" role="status">'+(defaultsChanged(d)?'未保存の変更あり':'保存済みの内容')+'</span></div></div><div class="defaults-fields"><div class="form-field"><label class="paper-label" for="defaultPlace">いつもの勤務場所</label><select class="paper-input" id="defaultPlace">'+placeOptions(d.locationId)+'</select></div><div class="form-field"><label class="paper-label" for="defaultNote">共通の作業概要</label><textarea class="paper-input" id="defaultNote" maxlength="1000" rows="3" placeholder="新しい日に入力しておく作業内容">'+h(d.note)+'</textarea><p class="field-help">新しい日の作業内容に入力する文章です。</p></div>'+phaseChoices(d.phases||[],'defaults')+'<div class="form-field"><label class="paper-label" for="defaultBreak">初期の休憩時間</label><div class="field-unit"><input class="paper-input" id="defaultBreak" type="number" min="0" max="1440" step="1" inputmode="numeric" required value="'+h(d.breakMinutes)+'" aria-label="初期の休憩時間（分）" aria-describedby="defaultBreakHint"><span aria-hidden="true">分</span></div><p id="defaultBreakHint" class="field-help" role="status">'+defaultBreakText(d.breakMinutes)+'</p><div class="default-break-presets" role="group" aria-label="初期休憩時間の候補">'+PRESETS.map(minutes=>'<button type="button" data-action="default-break" data-minutes="'+minutes+'" aria-pressed="'+(String(d.breakMinutes).trim()!==''&&Number(d.breakMinutes)===minutes)+'">'+minutes+'分'+(minutes===60?'<span class="sr-only">（標準の1時間）</span>':'')+'</button>').join('')+'</div></div></div><p class="settings-save-hint">変更は「更新」で保存し、新しい日の入力に使います。</p><div class="paper-actions settings-save-row"><button type="button" class="paper-button secondary" data-action="reset-defaults">標準に戻す</button></div>'+saveToolbar('defaultsForm')+'</form><button type="button" class="totals-button" data-action="totals">勤怠時間合計 <span aria-hidden="true">→</span></button></section>';
}
function pushDisplay(){
 const state=window.PaperPush?.getState()||{canTest:false,reason:'unsupported',permission:'default'};
 const help=state.reason==='home-screen'?'Safariの共有メニューからホーム画面に追加し、追加したSETを開いてください。':state.reason==='unsupported'?'iPhoneはiOS 16.4以降で、ホーム画面から開くと通知を使えます。':state.reason==='denied'?'端末の「設定」→「通知」で、このアプリの通知許可を確認してください。':'この端末にテスト通知を表示できます。';
 const status=pushTesting?'確認中':state.reason==='home-screen'?'ホーム画面で開く':state.reason==='unsupported'?'対象外':state.permission==='denied'?'許可なし':state.permission==='granted'?'端末の許可あり':'未設定';
 return {state,help,status,label:pushTesting?'通知を確認中…':state.permission==='granted'?'通知をテスト':'通知を許可してテスト'};
}
function reminderNextLabel(){
 const next=window.PaperReminders?.nextMissingAt(clockNow());
 return next?dayLabel(next.day)+' '+next.time:'祝日データの確認後に表示します';
}
function reminderRules(){
 const rules=window.PaperReminders?.policy;if(!rules)return '';
 return '<section class="push-reminder-rules" aria-labelledby="reminderRulesTitle"><h3 id="reminderRulesTitle">自動通知のルール（準備中）</h3><dl><div><dt>未入力のお知らせ</dt><dd>翌営業日 '+h(rules.missing.time)+'</dd></div><div><dt>提出期限</dt><dd>15日・月末日（当日）</dd></div><div><dt>期限のお知らせ</dt><dd>期限当日 '+h(rules.submission.time)+'</dd></div></dl><p>未入力が残っている場合、営業日の朝にまとめて1回お知らせします。全日休暇の日は対象に含めません。</p><p class="push-next-reminder">次の確認予定：<span id="reminderNext">'+h(reminderNextLabel())+'</span></p></section>';
}
function pushSettings(){
 const bell='<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
 if(config.mode!=='local')return '<section id="pushSettings" class="push-settings" aria-labelledby="pushTitle" aria-busy="false"><div class="push-heading">'+bell+'<h2 id="pushTitle">iPhoneの通知</h2><span id="pushStatus">準備画面で確認</span></div><p class="push-help">サンプルのない準備画面で、ホーム画面への追加とテスト通知を確認できます。デモの勤怠は引き継がれません。</p><a class="paper-button secondary push-test" data-push-local href="./a-paper-app.html?notifications=1&amp;v=paper-reminders34" target="_blank" rel="noopener">通知の準備画面を開く <span aria-hidden="true">↗</span></a></section>';
 const p=pushDisplay();
 return '<section id="pushSettings" class="push-settings" aria-labelledby="pushTitle" aria-busy="'+pushTesting+'"><div class="push-heading">'+bell+'<h2 id="pushTitle">iPhoneの通知</h2><span id="pushStatus">'+p.status+'</span></div><p id="pushHelp" class="push-help">'+p.help+'</p><details class="push-install-guide"><summary>iPhoneで通知を使う手順</summary><ol><li>この準備画面をSafariで開きます。</li><li>共有メニューから「ホーム画面に追加」を選びます。</li><li>追加したSETを開き、「設定」から通知をテストします。</li><li>通知の確認画面が出たら「許可」を選びます。</li></ol></details><button type="button" id="pushTestButton" class="paper-button push-test" data-action="push-test"'+(!p.state.canTest||pushTesting||saving?' disabled':'')+'>'+p.label+'</button><p class="push-delivery-note">自動通知は準備中です。現在はこの端末でのテストのみ利用できます。</p>'+reminderRules()+'</section>';
}
function syncPushSettings(){
 const card=$('pushSettings');if(!card||config.mode!=='local')return;
 const p=pushDisplay();card.setAttribute('aria-busy',String(pushTesting));$('pushStatus').textContent=p.status;$('pushHelp').textContent=p.help;
 const button=$('pushTestButton');button.textContent=p.label;button.disabled=!p.state.canTest||pushTesting||saving;
 if($('reminderNext'))$('reminderNext').textContent=reminderNextLabel();
}
async function testPush(){
 if(config.mode!=='local'||pushTesting||saving||!window.PaperPush)return;
 pushTesting=true;syncPushSettings();
 let result;
 try{result=await window.PaperPush.testNotification();}catch{result={ok:false,reason:'display'};}
 finally{pushTesting=false;syncPushSettings();}
 if(result.ok){toast('端末にテスト通知の表示を依頼しました。通知センターも確認してください。');return;}
 const messages={'home-screen':'ホーム画面に追加したSETから通知をテストしてください。',unsupported:'この環境は通知に対応していません。iPhoneはiOS 16.4以降でホーム画面から開いてください。',denied:'通知が許可されていません。端末の通知設定を確認してください。',dismissed:'通知の許可は変更されていません。準備ができたらもう一度お試しください。',worker:'通知の準備ができませんでした。接続を確認してもう一度お試しください。',display:'通知を表示できませんでした。端末の通知設定を確認してください。'};
 toast(messages[result.reason]||messages.display,{warning:true});
}
function settings(){
 const d=defaultsDraft||data.defaults,s=settingsDraft||data.settings;
 let body;
 if(settingsTab==='defaults')body=defaultsSettings(d);
 else body='<section class="settings-section"><form id="settingsForm"><section class="paper-form-card"><div class="settings-card-heading"><h2 class="form-card-heading">勤務時間</h2><p>勤務表に使う時間を設定します。</p></div><div class="hours-range"><div class="form-field"><label for="minHours"><span>基準時間の下限</span></label><div class="field-unit"><input id="minHours" class="paper-input" type="number" min="0" max="744" step="any" required value="'+(Number.isFinite(s.minHours)?s.minHours:'')+'" aria-label="基準時間の下限（時間）"><span aria-hidden="true">時間</span></div></div><span aria-hidden="true">〜</span><div class="form-field"><label for="maxHours"><span>基準時間の上限</span></label><div class="field-unit"><input id="maxHours" class="paper-input" type="number" min="0" max="744" step="any" required value="'+(Number.isFinite(s.maxHours)?s.maxHours:'')+'" aria-label="基準時間の上限（時間）"><span aria-hidden="true">時間</span></div></div></div>'+planningSettings(s)+'</section>'+projectSettings(s)+placeSettings(s)+'<div class="settings-save-row settings-sheet-actions"><p class="settings-save-hint">勤務予定・プロジェクト・作業場所をまとめて保存します。</p></div>'+saveToolbar('settingsForm')+'</form></section>';
 return '<section class="subpage"><h1>設定</h1><p class="subpage-lede">いつもの入力と、勤務表に使う情報を整えます。</p><div class="settings-tabs" aria-label="設定項目">'+[['defaults','いつもの勤務'],['sheet','勤務表の設定']].map(([id,label])=>'<button type="button" data-action="settings-tab" data-tab="'+id+'" aria-pressed="'+(settingsTab===id)+'">'+label+'</button>').join('')+'</div>'+body+'<section class="settings-utilities" aria-label="アカウント・通知"><a class="login-preview-link" href="./a-paper-login.html?v=paper-reminders34" target="_blank" rel="noopener" aria-label="Microsoft 365ログイン画面のプレビュー（新しいタブで開く）"><span>Microsoft 365ログイン</span><span>プレビュー <span aria-hidden="true">↗</span></span></a>'+pushSettings()+'</section></section>';
}
function nav(){return '<nav class="app-nav" aria-label="メインナビゲーション">'+[["home","home","ホーム"],["records","calendar","勤怠"],["submit","send","提出"],["settings","settings","設定"]].map(([id,ic,label])=>'<button id="nav-'+id+'" type="button" class="nav-button" data-action="tab" data-tab="'+id+'" '+(view===id||view==="editor"&&id==="records"||view==="missing"&&id==="home"?'aria-current="page"':'')+'>'+icon(ic)+'<span>'+label+'</span></button>').join("")+'</nav>';}
function logoutButton(){return '<button type="button" class="logout-button" data-action="logout"'+(saving?' disabled':'')+'><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4H4v16h6m4-13 5 5-5 5m-6-5h13"/></svg><span>ログアウト</span></button>';}
function openLogout(){
 if(saving){toast('保存が完了してからログアウトしてください。',{warning:true});return;}
 openDialog(dialogHeader('ログアウトしますか？')+'<p id="logoutDetails" class="panel-note">保存済みの勤怠データは、このブラウザに残ります。<br>未保存の入力は破棄されます。</p><p class="panel-note">現在は認証未接続のため、ログイン画面に戻ります。</p><div class="paper-actions"><button type="button" class="paper-button secondary" data-action="close-dialog" autofocus>キャンセル</button><button type="button" class="paper-button" data-action="confirm-logout">ログアウト</button></div>');
}
function confirmLogout(button){
 if(saving){toast('保存が完了してからログアウトしてください。',{warning:true});return;}
 if(!dialog.open||!$('logoutDetails')||!dialog.contains(button))return;
 cancelPhaseSave();
 location.replace('./a-paper-login.html?v=paper-reminders34&from='+(config.mode==='local'?'local':'demo'));
}
function render(){
 if(!data){
  root.setAttribute("aria-busy",String(loading));
  root.innerHTML='<header class="app-masthead"><span class="wordmark">SET</span>'+logoutButton()+'</header><main class="preview-main"><section class="subpage"><h1>勤怠記録</h1><p id="previewError" class="preview-error" role="alert">'+h(storageProblem)+'</p><p class="subpage-lede">'+(loading?'保存した記録を読み込んでいます。':'記録を読み込めるまで操作を停止しています。保存内容は変更していません。')+'</p>'+(!loading?'<button type="button" class="paper-button" data-action="retry-load">再読み込み</button>':'')+'</section></main>';
  if(embed)root.inert=true;
  return;
 }
 now=clockNow();renderedDay=now.day;root.classList.toggle('has-save-toolbar',view==='settings'||view==='editor');
 const employee=C.employee(data),employeeMeta=[employee.department,employee.id].filter(Boolean).join(' / ');
 root.innerHTML='<header class="app-masthead"><button type="button" class="wordmark" data-action="home" aria-label="SET ホーム">SET</button><div class="account-controls"><div class="employee"><b>'+h(employee.name||'利用者未設定')+'</b>'+h(employeeMeta)+'</div>'+logoutButton()+'</div></header><main class="preview-main"><div id="previewError" class="preview-error" role="alert">'+h(error||storageProblem)+'</div>'+({home,records,submit,settings,editor,missing}[view])()+'<p class="local-data-note">'+(demoMode()?'架空の社員の操作デモ · このブラウザに保存':'このブラウザに保存 · API・認証は未接続')+'</p></main>'+nav();
 root.setAttribute("aria-busy",String(saving));
 if(view==="editor"){editorTimeSignatures.set(editDay,timeSignature(readEditor().record));syncEditor();}
 if(embed)root.inert=true;
 syncWorkStatus();syncLeaveStatus();syncSaveStatus();
 syncAllocationTotal();
 if(notificationLanding&&view==='settings'){
  notificationLanding=false;$('pushSettings')?.scrollIntoView({block:'start'});
 }
 document.querySelectorAll("[data-state]").forEach(b=>{b.disabled=saving||!demoMode();b.setAttribute("aria-pressed",String(b.dataset.state===(record(now.day).end?'after':record(now.day).start?'working':'before')));});
}
function syncHome(preserveRest=false){
 if(view!=="home")return;
 const r=record(now.day);
 $("homeOverview").innerHTML=homeOverview();
 $("punchActions").innerHTML=punches();$("punchState").textContent=status(r);
 for(const k of ["start","end"]){const input=$(k+"Time");input.value=r[k];input.disabled=C.fullLeave(r)||k==="end"&&!r.start;input.previousElementSibling.textContent=(k==="start"?'出勤':'退勤')+'時刻を'+(r[k]?'編集':'入力');}
 $("nextday").checked=r.overnight;$("nextday").disabled=C.fullLeave(r)||!r.start;
 if(!preserveRest)$("restEditor").innerHTML=restEditor();for(const [key,panel] of [['summary',summaryPanel],['leave',leavePanel],['allocation',allocationPanel]])$('detailPanel-'+key).innerHTML=panel();syncAllocationTotal();$("weekArea").innerHTML=week();$("previewError").textContent=error||storageProblem;
 syncPhaseChoices();syncLeaveStatus();
}
function openDialog(content){
 error="";dialog.innerHTML=content;if(!dialog.open)dialog.showModal();syncPendingControls();
}
function dialogError(){return '<p id="dialogError" class="preview-error" role="alert"></p>';}
function closeDialog(){leaveConfirmation=null;dialog.close();dialog.innerHTML="";error="";}
function dialogHeader(title,caption=""){return '<div class="dialog-heading"><div><h2 id="dialogTitle">'+h(title)+'</h2>'+(caption?'<p>'+h(caption)+'</p>':'')+'</div><button type="button" data-action="close-dialog" class="dialog-close" aria-label="閉じる">×</button></div>';}
function openEditor(day,{repair=false}={}){
 now=clockNow();if(!C.validDay(day)||day<C.firstDay(data)||day>now.day)return;
 const sameView=view==="editor";rememberList();
 if(sameView)captureEditor();else{editorReturn=view;if(!repair)submissionRepair=null;}
 editDay=day;view="editor";error="";render();rememberRoute(sameView);root.scrollIntoView({block:"start"});
}
const breakText=n=>C.pad(Math.floor(n/60))+":"+C.pad(n%60);
function parseEditorBreak(text){
 const match=/^(\d{1,2}):([0-5]\d)$/.exec(text.trim());if(!match)return null;
 const minutes=Number(match[1])*60+Number(match[2]);return minutes<=1440?minutes:null;
}
function readEditor(){
 const source=editorDrafts.get(editDay)?.record||editorRecord(editDay),next={start:$("editStart").value,end:$("editEnd").value,overnight:$("editOvernight").checked,breakMinutes:parseEditorBreak($("editBreak").value),locationId:$("editPlace").value,note:$("editNote").value,phases:selectedPhases(true),leave:$("editLeave").value,sourceDay:$("editLeave").value==='comp'?$("editSourceDay").value:'',allocation:Object.fromEntries(C.PROJECTS.map(k=>[k,Number($("editAlloc"+k).value)]))};
 return {record:retainLegacyAllocation(next,source),breakText:$("editBreak").value};
}
function captureEditor(){if(view==="editor"&&$("dayForm")){editorDrafts.set(editDay,readEditor());syncSaveStatus();}}
function editor(){
 const draft=editorDrafts.get(editDay),r=draft?.record||editorRecord(editDay),rest=draft?.breakText??breakText(r.breakMinutes),backLabel={records:"勤怠一覧へ",home:"ホームへ",submit:"提出画面へ",missing:"未入力一覧へ"}[editorReturn]||"勤怠一覧へ";
 const fullDate=editDay.slice(0,4)+"年"+Number(editDay.slice(5,7))+"月"+Number(editDay.slice(8))+"日（"+C.WEEK[C.weekday(editDay)]+"）";
 const presets=[0,15,30,45,60,75,90,105,120,150,180,240,300,360,480,720,1440];
 return '<section class="subpage day-editor"><div class="editor-title"><button type="button" class="editor-back" data-action="editor-back">← '+backLabel+'</button><span>変更は更新で保存</span></div>'+(typeof repairContext==='function'?repairContext():'')+'<h1>勤怠の編集</h1><div class="editor-date-switcher"><button type="button" class="month-arrow" data-action="editor-prev" aria-label="前の日" '+(editDay<=C.firstDay(data)?'disabled':'')+'>←</button><label class="editor-date-picker" for="editDate"><span>'+fullDate+'</span>'+icon('calendar')+'<input id="editDate" type="date" min="'+C.firstDay(data)+'" max="'+now.day+'" value="'+editDay+'" aria-label="編集する日付"></label><button type="button" class="month-arrow" data-action="editor-next" aria-label="次の日" '+(editDay>=now.day?'disabled':'')+'>→</button></div><p class="editor-holiday-name"'+(C.holiday(editDay)?'':' aria-hidden="true"')+'>'+h(C.holiday(editDay))+'</p><form id="dayForm"><section class="paper-form-card"><h2 class="form-card-heading">勤務時間</h2><div class="editor-time-grid"><div class="form-field"><label for="editStart">出勤時刻</label><input class="time-input" id="editStart" type="time" value="'+r.start+'"></div><div class="form-field"><label for="editEnd">退勤時刻</label><input class="time-input" id="editEnd" type="time" value="'+r.end+'"></div></div><label class="nextday"><input id="editOvernight" type="checkbox" '+(r.overnight?'checked':'')+'>翌日に退勤</label><div class="editor-rest-worked"><div class="form-field"><label for="editBreak">休憩時間 <small>hh:mm</small></label><input class="paper-input editor-break-input" id="editBreak" type="text" inputmode="text" value="'+h(rest)+'" list="editorBreaks" placeholder="01:00" maxlength="5" required aria-label="休憩時間、時間と分"><datalist id="editorBreaks">'+presets.map(n=>'<option value="'+breakText(n)+'"></option>').join('')+'</datalist></div><div class="form-field"><div class="calculated-label"><span id="workedLabel">実働時間</span><span class="calculated-badge">自動計算</span></div><output id="editWorked" class="editor-worked" for="editStart editEnd editBreak editOvernight" aria-labelledby="workedLabel">—</output></div></div><div class="editor-absence" role="group" aria-labelledby="editAbsenceLabel"><div><span id="editAbsenceLabel">この日の欠勤時間</span><output id="editAbsence" for="editStart editEnd editBreak editOvernight editLeave" aria-labelledby="editAbsenceLabel">未確定</output></div><p>1日8時間・半休は4時間分として計算</p></div></section><section class="paper-form-card"><h2 class="form-card-heading">勤務内容</h2><div class="editor-fields">'+leaveChoices(r.leave,true)+'<div class="form-field editor-comp-source" '+(r.leave==='comp'?'':'hidden')+'><label for="editSourceDay">元の休日出勤</label><select class="paper-input" id="editSourceDay">'+compSourceOptions(editDay,r.sourceDay||'')+'</select><small class="comp-source-note">休日出勤1日につき代休1日</small></div><div class="leave-save-row"><p id="editorLeaveSaveStatus" class="leave-save-status" role="status"></p><div class="leave-form-actions"><button type="button" class="paper-button" data-action="editor-leave-request">'+icon('send')+'<span>送信</span></button></div></div><div class="form-field"><label for="editPlace">勤務場所</label><select class="paper-input" id="editPlace">'+placeOptions(r.locationId)+'</select></div>'+workTabs('<div class="form-field work-note-field"><label for="editNote">作業内容</label><textarea class="paper-input" id="editNote" maxlength="1000" rows="3">'+h(r.note)+'</textarea></div>',r.phases??[],true)+'</div></section><section class="paper-form-card editor-allocation-card"><div class="editor-allocation-heading"><h2>工数の振り分け</h2><span>時間単位</span></div><p id="allocationState" class="editor-allocation-state" role="status"></p><div class="editor-allocation">'+C.PROJECTS.map(k=>'<label for="editAlloc'+k+'"><span>'+k+'</span><input class="paper-input" id="editAlloc'+k+'" name="'+k+'" type="number" min="0" max="'+C.allocationMax(r,k)+'" step="any" inputmode="decimal" required value="'+r.allocation[k]+'"></label>').join('')+'</div></section><button type="button" class="editor-clear" data-action="clear-day">この日を未入力に戻す</button>'+saveToolbar('dayForm')+'</form></section>';
}
function syncEditor(){
 if(!$("dayForm"))return;
 const r=readEditor().record,off=C.fullLeave(r),total=off?0:r.breakMinutes==null?null:C.worked(r,editDay,clockNow()),allocated=allocationTotal(r),complete=off||!!r.start&&!!r.end&&total!=null&&total>=0&&allocated===total;
 for(const id of ['editStart','editEnd','editOvernight','editBreak',...C.PROJECTS.map(k=>'editAlloc'+k)])$(id).disabled=off||saving;
 $("editWorked").innerHTML=total==null?'—':C.hours(total)+'<small>時間</small>';
 $("editWorked").classList.toggle("negative-value",total<0);
 const businessDay=C.workday(editDay),absence=C.absenceMinutes(r,editDay,clockNow()),start=C.timeToMin(r.start),end=C.timeToMin(r.end),determined=start!=null&&end!=null&&end+(r.overnight?1440:0)>=start&&total!=null;
 $("editAbsence").textContent=C.fullLeave(r)||businessDay===false?C.duration(0):businessDay==null?'—':!determined?'未確定':C.duration(absence);
 for(const k of C.PROJECTS)$("editAlloc"+k).max=C.allocationMax(r,k);
 const validAllocation=C.PROJECTS.every(k=>$("editAlloc"+k).value.trim()!==""&&$("editAlloc"+k).validity.valid);
 $("allocationState").textContent=off?'全日休暇のため実働・工数は0時間です':!validAllocation?'工数を0〜24時間で入力してください':r.breakMinutes==null?'休憩を hh:mm で入力してください':!r.start||!r.end?'出社・退社時間を入力してください':total<0?'入力済みの工数は保持します':complete?'✓ 振り分け完了':allocated<total?'あと '+C.duration(total-allocated)+'を振り分け':C.duration(allocated-total)+' 超過しています';
 $("allocationState").classList.toggle("is-complete",complete&&validAllocation);syncLeaveStatus();
}
function applyEditorTimeAllocation(input){
 if(!['editStart','editEnd','editOvernight','editBreak'].includes(input.id))return;
 const r=readEditor().record,signature=timeSignature(r);if(signature===editorTimeSignatures.get(editDay))return;
 editorTimeSignatures.set(editDay,signature);
 if(r.breakMinutes==null||!C.PROJECTS.every(k=>$("editAlloc"+k).value.trim()!==''&&$("editAlloc"+k).validity.valid))return;
 const updated=C.allocateToP1(r,editDay,clockNow());$("editAllocP1").value=updated.allocation.P1;
}
function syncWorkStatus(){
 const node=$("workSaveStatus");if(!node)return;
 const dirty=homeDraft().note!=null||homeDraft().locationId!=null||homeDraft().phases!=null;
 $('detailTab-work')?.classList.toggle('has-draft',dirty);$('detailTab-work')?.setAttribute('aria-label',dirty?'勤務内容、未保存の入力あり':'勤務内容');
 node.dataset.saveState=saving?'saving':dirty?'dirty':'automatic';
 node.innerHTML=saving?'<span>保存中です</span>':dirty?'<span>勤務内容が未保存です</span><button type="button" class="text-button" data-action="retry-work">再保存</button>':'<span>勤務内容は自動保存</span>';
}
function syncAllocationTotal(){syncPendingControls();if(!$("allocationForm"))return;const inputs=C.PROJECTS.map(k=>$("alloc"+k)),total=inputs.reduce((n,input)=>n+Math.round(Number(input.value)*60),0);$("allocationTotal").textContent=inputs.every(input=>input.value.trim()!==""&&input.validity.valid)?C.short(total):'—';}
function validRepair(value){
 return value&&typeof value.test==='boolean'&&value.period&&C.validDay(value.period.start)&&C.validDay(value.period.end)&&value.period.start<=value.period.end&&C.validDay(value.month);
}
function repairActive(){return view==='editor'&&editorReturn==='submit'&&validRepair(submissionRepair);}
function repairIssues(){return repairActive()?C.submissionCheck(data,submissionRepair.period,clockNow()).errors:[];}
function repairContext(){
 if(!repairActive())return '';
 const count=new Set(repairIssues().filter(issue=>issue.day).map(issue=>issue.day)).size;
 return '<aside class="submission-repair-context" aria-label="提出前の修正"><div><strong>提出前の修正</strong><span>あと <b>'+count+'</b>日</span></div><p>'+h(periodLabel(submissionRepair.period))+'</p></aside>';
}
function repairSaveLabel(){return repairActive()?(repairIssues().filter(issue=>issue.day).length>1?'保存して次へ':'保存して再確認'):'';}
function repairToolbarAction(){return repairActive()?'<button type="button" class="paper-button secondary repair-return" data-action="repair-save-return">保存して確認へ</button>':'';}
function returnToSubmissionRepair(){
 if(!repairActive())return;
 captureEditor();history.back();
}
function continueSubmissionRepair(day,intent,context){
 if(!context||submissionRepair!==context||!repairActive()||editDay!==day)return false;
 const check=C.submissionCheck(data,context.period,clockNow());
 if(intent==='return'||check.ok){returnToSubmissionRepair();return true;}
 const current=check.errors.find(issue=>issue.day===day);
 if(current){render();toast('保存しました。提出前に'+current.messages.join(' '),{warning:true});return true;}
 const days=[...new Set(check.errors.filter(issue=>issue.day).map(issue=>issue.day))].sort(),next=days.find(value=>value>day)||days[0];
 if(next)openEditor(next,{repair:true});else returnToSubmissionRepair();
 return true;
}
function openSubmission(period,{remember=true}={}){
 if(!period||period.end<C.firstDay(data))return showError("この期間には利用開始日以降の記録がありません。");
 submitPeriod=period;now=clockNow();const check=C.submissionCheck(data,period,now),validPeriod=period&&C.validDay(period.start)&&C.validDay(period.end),summary=validPeriod?C.summary(data,period,now):{days:0,minutes:0};
 if(validPeriod){submissionRepair={period:{start:period.start,end:period.end},test:testSubmission,month:selectedMonth};if(remember&&view==='submit')rememberRoute(true);}
 const list=check.ok?'<p class="complete-message">✓ 提出前のチェックがすべて完了しました。</p>':'<section class="submission-errors" aria-labelledby="submissionIssuesTitle"><h3 id="submissionIssuesTitle">提出できない日があります <small>'+check.errors.filter(issue=>issue.day).length+'日</small></h3><p>日付を選んで修正してください。</p><div class="submission-issues">'+check.errors.map(issue=>'<div class="submission-issue'+(issue.day?'':' submission-issue-static')+'">'+(issue.day?'<button type="button" data-action="missing-day" data-day="'+h(issue.day)+'"><span class="submission-issue-heading"><strong>'+h(issue.day.replaceAll('-','/')+'（'+C.WEEK[C.weekday(issue.day)]+'）')+'</strong><span aria-hidden="true">›</span></span><span class="submission-issue-messages">'+issue.messages.map(message=>'<span class="submission-issue-message">'+h(message)+'</span>').join('')+'</span></button>':'<strong>対象期間・記録を確認してください</strong><ul>'+issue.messages.map(message=>'<li>'+h(message)+'</li>').join('')+'</ul>')+'</div>').join('')+'</div></section>';
 openDialog(dialogHeader('勤務表の確認',validPeriod?periodLabel(period):'対象期間を確認してください')+'<p class="submission-total">勤務 '+summary.days+'日 ／ '+C.duration(summary.minutes)+'</p>'+list+'<p class="panel-note">平日の4時間以下の勤務は有休登録を確認します（半休登録済みは対象外）。作業概要・工数・マイナス実働も確認し、エラーがある間は提出できません。</p><div class="paper-notice"><strong>'+(testSubmission?'テスト提出です。':'Excelを出力します。')+'</strong><p>メールは送信されません。'+(testSubmission?'テスト提出の履歴をこの端末に保存します。':'出力の履歴をこの端末に保存します。')+'</p></div>'+dialogError()+'<div class="paper-actions"><button type="button" class="paper-button secondary" data-action="close-dialog">閉じる</button><button type="button" class="paper-button" data-action="confirm-submission" '+(check.ok?'':'disabled aria-describedby="submissionIssuesTitle"')+'>'+(testSubmission?'テスト提出':'Excel出力')+'</button></div>');
}
function download(bytes,name){
 const blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),url=URL.createObjectURL(blob),link=document.createElement("a");
 link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function exportPeriod(period,mark=false){
 const expectedRevision=data?.revision;if(!beginSave())return;
 now=clockNow();const exportTest=testSubmission;
 try{
  await repository.assertCurrent(expectedRevision);
  const prepared=mark?C.prepareSubmission(data,period,now):null;
  if(prepared&&!prepared.ok){openSubmission(period);return;}
  const bytes=mark?prepared.bytes:C.workbook(data,period,now),candidate=C.clone(data);
  download(bytes,'day_'+period.start+'_'+period.end+'.xlsx');
  if(mark){candidate.submissions[C.periodKey(period)]={at:new Date().toISOString(),test:exportTest};if(!(await commit(candidate,"",{locked:true,expectedRevision}))){showError("Excelのダウンロードは開始しましたが、履歴を保存できませんでした。"+error);return;}}
  rememberList();
  if(dialog.open)closeDialog();if(mark){submissionRepair=null;rememberRoute(true);}render();toast(mark?'勤務表の出力操作と'+(exportTest?'テスト提出':'出力')+'履歴を記録しました':'勤務表のダウンロードを開始しました');
 }catch(issue){const message="勤務表を出力できませんでした。もう一度お試しください。";showError(issue?.code?repositoryMessage(issue,message):message);}
 finally{setSaving(false);}
}
function captureSettings(){
 captureDefaults();
 if(!$("settingsForm"))return;
 reconcilePlanningControls($('plannedHours'));
 settingsDraft=settingsDraft||C.clone(data.settings);
 Object.assign(settingsDraft,{minHours:$("minHours").value.trim()===""?NaN:Number($("minHours").value),maxHours:$("maxHours").value.trim()===""?NaN:Number($("maxHours").value)});
 const monthKey=document.querySelector('.planned-settings').dataset.month;
 settingsDraft.plannedHoursByMonth={...(settingsDraft.plannedHoursByMonth||{})};
 if($('plannedHoursMode').value==='manual')settingsDraft.plannedHoursByMonth[monthKey]=$('plannedHours').value.trim()===''?NaN:Number($('plannedHours').value);
 else delete settingsDraft.plannedHoursByMonth[monthKey];
 Object.assign(settingsDraft.projects[projectIndex],{name:$("projectName").value,description:$("projectDescription").value});
 Object.assign(settingsDraft.places[placeIndex],{code:$("placeCode").value,name:$("placeName").value,address:$("placeAddress").value});
 syncSaveStatus();
}
async function sample(mode){
 if(!demoMode()||saving)return;
 const clocks={before:"08:57:16",working:"14:35:08",after:"18:04:12"},r=C.empty(data);
 if(!Object.hasOwn(clocks,mode))return;
 if(mode!=="before")r.start="09:10";
 if(mode==="after")r.end="18:02";
 const previous=sampleClock;sampleClock=clocks[mode];now=clockNow();
 if(await saveRecord(now.day,r,'今日の'+{before:'出勤前',working:'勤務中',after:'退勤後'}[mode]+'サンプルに切り替えました')){restOpen=false;view="home";render();}
 else{sampleClock=previous;now=clockNow();}
}
function changeMonth(offset){const month=C.month(selectedMonth,offset).start;if(month<firstMonth()||month>C.month(clockNow().day).start)return;rememberList();selectedMonth=month;error="";render();rememberRoute(true);restorePosition();}
document.addEventListener('toggle',event=>{
 if(!event.target.isConnected)return;
 if(event.target.id==='homeTimeEditor')homeTimeOpen=event.target.open;
 if(event.target.id==='recordsChart')recordsChartOpen=event.target.open;
},true);
document.addEventListener('keydown',event=>{
 const button=event.target.closest?.('[data-action="work-content-tab"],[data-action="detail"]');if(!button||embed||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();const buttons=[...button.closest('[role="tablist"]').querySelectorAll('[role="tab"]')],index=buttons.indexOf(button),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
 if(button.dataset.action==='detail')switchDetail(buttons[next].dataset.detail,true);else switchWorkTab(buttons[next],true);
});
document.addEventListener("click",async event=>{
 if(embed)return;
 if((event.target.matches?.(".time-input")||event.target.id==="editDate")&&!event.target.disabled){try{event.target.showPicker?.();}catch{}return;}
 const button=event.target.closest?.("[data-action],[data-state]");if(!button||button.disabled)return;
 if(button.dataset.action==="retry-load"){await loadData();return;}
 if(button.dataset.action==='logout'){openLogout();return;}
 if(button.dataset.action==='confirm-logout'){confirmLogout(button);return;}
 if(button.dataset.action==='push-test'){await testPush();return;}
 if(!data)return;
 if(button.dataset.state){await sample(button.dataset.state);return;}
 const action=button.dataset.action;
 if(action==='undo-change'){await restoreUndo();return;}
 if(undoChange&&['home-leave','editor-leave','editor-phase','default-phase','default-break','work-phase','plan-auto','allocate-rest','reset-defaults'].includes(action))dismissUndo();
 if(action==='work-content-tab'){switchWorkTab(button);return;}
 if(action==='default-phase'){
  if(saving||!C.PHASE_IDS.includes(button.dataset.phase))return;
  button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));syncDefaultsDraft();return;
 }
 if(action==='home-leave'||action==='editor-leave'){
  const leave=button.dataset.leave,editorMode=action==='editor-leave';if(saving||!Object.hasOwn(C.LEAVES,leave))return;
  const prior=editorMode?readEditor().record:null;
  if(!editorMode&&clockNow().day!==renderedDay){render();toast('日付が変わりました。今日の画面を確認して再操作してください。',{warning:true});return;}
  $(editorMode?'editLeave':'leaveType').value=leave;
  if(editorMode){const next=C.changeLeave(prior,leave,editDay,clockNow());$('editStart').value=next.start;$('editEnd').value=next.end;$('editOvernight').checked=next.overnight;for(const key of C.PROJECTS)$('editAlloc'+key).value=next.allocation[key];if(C.fullLeave(next)&&next.breakMinutes==null)$('editBreak').value=breakText(record(editDay).breakMinutes);syncLeaveChoices(true);syncCompSourceFields(true);syncEditor();captureEditor();return;}
  setHomeDraft('leave',leave);setHomeDraft('sourceDay',leave==='comp'?(homeDraft().sourceDay??record(now.day).sourceDay??''):'');syncLeaveChoices();syncCompSourceFields();syncLeaveStatus();
  return;
 }
 if(action==='editor-leave-request'){openLeaveRequest(true);return;}
 if(action==='confirm-leave-request'){await confirmLeaveRequest();return;}
 if(action==='edit-plan'){openPlan();return;}
 if(action==='work-phase'){
  const phase=button.dataset.phase;if(!C.PHASE_IDS.includes(phase))return;
  const current=clockNow();if(current.day!==renderedDay){render();showError('日付が変わりました。今日の画面を確認して再操作してください。');return;}
  now=current;const selected=selectedPhases(),next=C.PHASE_IDS.filter(id=>id===phase?!selected.includes(id):selected.includes(id));
  setHomeDraft('phases',next);syncPhaseChoices();syncWorkStatus();queuedPhaseDays.add(now.day);schedulePhaseSave();return;
 }
 if(action==='editor-phase'){
  if(saving||!C.PHASE_IDS.includes(button.dataset.phase))return;
  button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));syncWorkTabCount(true);captureEditor();return;
 }
 if(action==="project-tab"||action==="project-step"){switchProject(Number(button.dataset.index),{focus:action==="project-step"});return;}
 if(action==="place-tab"){switchPlace(Number(button.dataset.index));return;}
 if(action==="default-break"){const minutes=Number(button.dataset.minutes);if(!saving&&PRESETS.includes(minutes)&&$("defaultBreak")){$("defaultBreak").value=String(minutes);syncDefaultsDraft();}return;}
 if(action==='plan-auto'){$('planMode').value='auto';syncPlanningControls($('planMode'));return;}
 if(action==="missing-records"){view="missing";error="";render();rememberRoute();root.scrollIntoView({block:"start"});return;}
 if(action==="missing-back"){history.back();return;}
 if(action==="tab"||action==="home"){
  submissionRepair=null;
  const previous=view;rememberList();if(view==="settings")captureSettings();if(view==="editor"){captureEditor();if(button.dataset.tab==="records")selectedMonth=C.month(editDay).start;}view=action==="home"?'home':button.dataset.tab;error="";restOpen=false;render();rememberRoute(previous===view);restorePosition();return;
 }
 if(action==="editor-prev"||action==="editor-next"){openEditor(C.add(editDay,action==="editor-prev"?-1:1));return;}
 if(action==="editor-back"){captureEditor();history.back();return;}
 if(action==='repair-save-return'){
  if(!saving&&repairActive()){
   repairReturnRequested=true;
   try{$('dayForm').requestSubmit($('dayForm button[type="submit"]'));}finally{repairReturnRequested=false;}
  }
  return;
 }
 if(action==="retry-work"){
  await saveWork({note:$("workNote").value,locationId:$("workPlace").value,phases:[...selectedPhases()]},'勤務内容を保存しました');return;
 }
 if(action==="punch"){
  if(Date.now()<lockUntil)return;
  const kind=button.dataset.kind,r=record(now.day),rest=readRest();if(rest==null)return;
  if(kind==="end"&&!r.start)return showError("先に出勤を記録してください。");
  const current=clockNow();
  if(await updateToday({[kind]:current.time,breakMinutes:rest,overnight:kind==="end"?false:r.overnight},(kind==="start"?'出勤':'退勤')+'を'+current.time+'で記録しました',{autoAllocate:true})){clearHomeDraft("rest");restOpen=false;animatePunch(kind);lockPunches(850);syncHome();}return;
 }
 if(action==="reset-punches"){
  if(Date.now()<lockUntil)return;
  const snapshot=undoSnapshot(renderedDay);
  if(await updateToday({start:"",end:"",overnight:false,allocation:Object.fromEntries(C.PROJECTS.map(k=>[k,0]))},'出勤・退勤と工数を取り消しました')){refreshUndoDrafts(snapshot);clearSavedHomeDraft(snapshot.day,{allocation:snapshot.home?.allocation});lockPunches();syncHome(true);offerUndo(snapshot,'出勤・退勤と工数を取り消しました');}return;
 }
 if(action==="reset"){await sample('before');return;}
 if(action==="live"){if(!demoMode())return;sampleClock="";render();return;}
 if(action==="rest"){if(restOpen)clearHomeDraft("rest");restOpen=!restOpen;$("restEditor").innerHTML=restEditor();return;}
 if(action==="quick-rest"){
  const minutes=Number(button.dataset.minutes);if(!PRESETS.includes(minutes))return;
  const day=clockNow().day,draft=homeDraft(day).rest;
  if(await updateToday({breakMinutes:minutes},'休憩時間を'+C.duration(minutes)+'に変更しました',{autoAllocate:true})){
   if(homeDraft(day).rest===draft)clearSavedHomeDraft(day,{rest:draft});
   if(view==="home"&&renderedDay===day&&clockNow().day===day){restOpen=false;syncHome();}
  }
  return;
 }
 if(action==="detail"){error="";switchDetail(button.dataset.detail);$("previewError").textContent="";return;}
 if(action==="allocate-rest"){
  const total=C.worked(record(now.day),now.day,now),other=C.PROJECTS.slice(1).reduce((n,k)=>n+Math.round(Number($("alloc"+k).value)*60),0);
  if(other>total)return showError("P2〜SETの合計が勤務時間を超えています。");
  $("allocP1").value=Number(((total-other)/60).toFixed(8));setHomeDraft("allocation",Object.fromEntries(C.PROJECTS.map(k=>[k,$("alloc"+k).value])));syncAllocationTotal();return;
 }
 if(action==='record-filter'){
  const filter=button.dataset.filter;if(!['all','missing'].includes(filter))return;
  rememberList();recordsFilter=filter;render();rememberRoute(true);
  document.querySelector('.record-controls')?.scrollIntoView({block:'start'});
  document.querySelector('[data-action="record-filter"][data-filter="'+filter+'"]')?.focus({preventScroll:true});return;
 }
 if(action==='records-today'){
  rememberList();now=clockNow();selectedMonth=C.month(now.day).start;recordsFilter='all';render();rememberRoute(true);
  const today=$('recordList')?.querySelector('[data-day="'+now.day+'"]');
  if(today){today.scrollIntoView({block:'start'});today.focus({preventScroll:true});}return;
 }
 if(action==="month-prev"){changeMonth(-1);return;}
 if(action==="month-next"){changeMonth(1);return;}
 if(action==="chart-month"){const month=button.dataset.month;if(!C.validDay(month)||month<firstMonth()||month>C.month(clockNow().day).start)return;rememberList();selectedMonth=month;render();rememberRoute(true);restorePosition();return;}
 if(action==="edit-day"){openEditor(button.dataset.day);return;}
 if(action==="close-dialog"){if(dialog.querySelector('[data-action="confirm-submission"]')){submissionRepair=null;rememberRoute(true);}closeDialog();return;}
 if(action==="clear-day"){
  now=clockNow();const day=editDay,pendingEditor=editorDrafts.get(day),pendingHome=homeDrafts.get(day),relation=C.validateRecordChange(data,day,null,now);if(!relation.ok){toast(relation.error,{warning:true});return;}
  const snapshot=undoSnapshot(day);
  const next=C.clone(data);delete next.records[day];C.invalidateSubmissions(next,day);
  if(await commit(next,'この日を未入力に戻しました')){refreshUndoDrafts(snapshot);if(editorDrafts.get(day)===pendingEditor)editorDrafts.delete(day);if(homeDrafts.get(day)===pendingHome)homeDrafts.delete(day);render();offerUndo(snapshot,dayLabel(day)+'を未入力に戻しました');}return;
 }
 if(action==="export-month"){await exportPeriod(C.month(selectedMonth));return;}
 if(action==="submit-period"){openSubmission(C.periods(selectedMonth)[Number(button.dataset.index)]);return;}
 if(action==="confirm-submission"){await exportPeriod(submitPeriod,true);return;}
 if(action==="missing-day"){const day=button.dataset.day;closeDialog();openEditor(day,{repair:true});return;}
 if(action==="settings-tab"){captureSettings();settingsTab=button.dataset.tab;error="";render();return;}
 if(action==="reset-defaults"){
  if(saving)return;
  const standard=C.clone(config.initialState(clockNow()).defaults);
  defaultsDraft={...standard,breakMinutes:String(standard.breakMinutes)};render();toast('標準の値を入力しました。「更新」で保存します。');return;
 }
 if(action==="totals"){
  const month=C.month(now.day),sum=C.summary(data,month,now);
  openDialog(dialogHeader('勤怠時間合計',periodLabel(month))+'<dl class="summary-lines"><div><dt>勤務時間合計</dt><dd>'+C.duration(sum.minutes)+'</dd></div><div><dt>勤務日数</dt><dd>'+sum.days+'日</dd></div>'+C.PROJECTS.map(k=>'<div><dt>'+k+'</dt><dd>'+Number(sum.allocation[k].toFixed(2))+'時間</dd></div>').join("")+'</dl><button type="button" class="paper-button full-width" data-action="close-dialog">閉じる</button>');
 }
});
document.addEventListener("change",async event=>{
 if(embed||!data)return;const input=event.target;
 if(undoChange&&input.matches?.('input,select,textarea'))dismissUndo();
 if(input.id==="editDate"){
  if(C.validDay(input.value)&&input.value>=C.firstDay(data)&&input.value<=clockNow().day)openEditor(input.value);else{input.value=editDay;toast("今日までの日付を選んでください。",{warning:true});}return;
 }
 if(input.closest?.("#dayForm")){if(input.id==='editLeave')syncCompSourceFields(true);applyEditorTimeAllocation(input);syncEditor();captureEditor();return;}
 if(input.id==='leaveSourceDay'){setHomeDraft('sourceDay',input.value);syncLeaveStatus();return;}
 if(input.dataset.time){
  const kind=input.dataset.time,r=record(now.day),rest=readRest();
  if(!input.value){input.value=r[kind];return showError("時刻を入力してください。取消は「打刻取消」ボタンで行えます。");}
  if(rest==null){input.value=r[kind];return;}
  if(await updateToday({[kind]:input.value,breakMinutes:rest,overnight:$("nextday").checked},'時刻を保存しました',{autoAllocate:true})){clearHomeDraft("rest");restOpen=false;lockPunches(250);syncHome();}else input.value=r[kind];return;
 }
 if(input.id==="nextday"){
  const r=record(now.day);if(await updateToday({overnight:input.checked},'退勤日の設定を保存しました',{autoAllocate:true}))syncHome();else input.checked=r.overnight;return;
 }
 if(input.id==="workPlace"||input.id==="workNote"){
  const key=input.id==="workPlace"?'locationId':'note';setHomeDraft(key,input.value);await saveWork({[key]:input.value},'勤務内容を保存しました');return;
 }
 if(input.id==="monthInput"){
  const day=input.value+'-01';if(C.validDay(day)&&day>=firstMonth()&&day<=now.day){rememberList();selectedMonth=day;render();rememberRoute(true);restorePosition();}else{input.value=selectedMonth.slice(0,7);showError("表示できる月を選んでください。");}return;
 }
 if(input.id==="testSubmission"){testSubmission=input.checked;return;}
 if(input.id==='planMode'||input.id==='planHoursInput'){syncPlanningControls(input);return;}
 if(input.id==='plannedHoursMode'||input.id==='plannedHours'){syncPlanningControls(input);captureSettings();return;}
 if(input.closest?.("#defaultsForm")){syncDefaultsDraft();return;}
 if(input.closest?.("#settingsForm")){captureSettings();return;}
});
document.addEventListener("input",event=>{
 if(embed||!data)return;
 if(undoChange)dismissUndo();
 if(event.target.closest?.("#defaultsForm")){syncDefaultsDraft();return;}
 if(["placeCode","placeName","placeAddress"].includes(event.target.id)){captureSettings();syncPlaceDraft();return;}
 if(event.target.id==="projectName"||event.target.id==="projectDescription"){captureSettings();syncProjectDraft();return;}
 if(event.target.id==='planHoursInput'){syncPlanningControls(event.target);return;}
 if(event.target.id==='plannedHours'||event.target.id==='plannedHoursMode'){syncPlanningControls(event.target);captureSettings();return;}
 if(event.target.closest?.("#settingsForm")){captureSettings();return;}
 if(event.target.id==="workNote"){setHomeDraft("note",event.target.value);syncWorkStatus();return;}
 if(event.target.id==="restHours"||event.target.id==="restMinutes"){setHomeDraft("rest",{hours:$("restHours").value,minutes:$("restMinutes").value});return;}
 if(event.target.closest?.("#dayForm")){if(event.target.id==='editLeave')syncCompSourceFields(true);applyEditorTimeAllocation(event.target);syncEditor();captureEditor();return;}
 if(event.target.closest?.("#allocationForm")){
  setHomeDraft("allocation",Object.fromEntries(C.PROJECTS.map(k=>[k,$("alloc"+k).value])));syncAllocationTotal();
 }
});
document.addEventListener("submit",async event=>{
 if(embed||!data)return;event.preventDefault();const id=event.target.id;
 if(id==='planForm'){
  reconcilePlanningControls($('planHoursInput'));
  const form=event.target,key=form.dataset.month,field=$('planHoursInput'),manual=$('planMode').value==='manual',value=field.value.trim()===''?NaN:Number(field.value);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)||!C.validDay(key+'-01'))return showError('変更する年月を確認してください。');
  if(manual&&(!Number.isFinite(value)||value<0||value>744))return showError('勤務予定は0〜744時間で入力してください。');
  const next=C.clone(data);next.settings.plannedHoursByMonth={...(next.settings.plannedHoursByMonth||{})};
  if(manual)next.settings.plannedHoursByMonth[key]=value;else delete next.settings.plannedHoursByMonth[key];
  const issue=C.validateSettings(next.settings);if(issue)return showError(issue);
  if(await commit(next,'勤務予定を更新しました')){
   if(settingsDraft){settingsDraft.plannedHoursByMonth={...(settingsDraft.plannedHoursByMonth||{})};if(Object.hasOwn(data.settings.plannedHoursByMonth,key))settingsDraft.plannedHoursByMonth[key]=data.settings.plannedHoursByMonth[key];else delete settingsDraft.plannedHoursByMonth[key];}
   if(Object.hasOwn(data.settings.plannedHoursByMonth,key))settingsPlanDrafts.set(key,String(data.settings.plannedHoursByMonth[key]));else settingsPlanDrafts.delete(key);
   if($('planForm')===form)closeDialog();
   if(view==='home'&&renderedDay===clockNow().day)syncHome(true);else render();
  }
  return;
 }
 if(id==="restForm"){
  const total=readRest();if(total==null)return;if(await updateToday({breakMinutes:total},'休憩時間を保存しました',{autoAllocate:true})){clearHomeDraft("rest");restOpen=false;syncHome();}return;
 }
 if(id==="leaveForm"){openLeaveRequest();return;}
 if(id==="allocationForm"){
  const allocation=Object.fromEntries(C.PROJECTS.map(k=>[k,Number($("alloc"+k).value)]));
  if(await updateToday({allocation},'工数を保存しました',{strictAllocation:true})){clearHomeDraft("allocation");syncHome();}return;
 }
 if(id==="dayForm"){
  now=clockNow();const day=editDay,r=readEditor().record,workDraftAtSave=homeDraft(day),repair=repairActive()?submissionRepair:null,repairIntent=repairReturnRequested?'return':'next';
  if(r.breakMinutes==null)return showError("休憩時間は 01:00 のように、0:00〜24:00で入力してください。");
  if(r.leave!==record(day).leave||(r.sourceDay||'')!==(record(day).sourceDay||'')){openLeaveRequest(true,repair?repairIntent:null);return;}
  if(await saveRecord(day,r,'勤怠を更新しました',{strictAllocation:true})){
   const resolved=homeDraft(day)===workDraftAtSave?{...r,...Object.fromEntries(['note','locationId','phases'].filter(key=>Object.hasOwn(workDraftAtSave,key)).map(key=>[key,workDraftAtSave[key]]))}:r;
   clearSavedHomeDraft(day,resolved);if(!continueSubmissionRepair(day,repairIntent,repair))render();
  }return;
 }
 if(id==="defaultsForm"){
  captureDefaults();
  const next=C.clone(data),d={locationId:$("defaultPlace").value,note:$("defaultNote").value,phases:[...defaultsDraft.phases],breakMinutes:$("defaultBreak").value.trim()===""?NaN:Number($("defaultBreak").value)};
  if(!Number.isInteger(d.breakMinutes)||d.breakMinutes<0||d.breakMinutes>1440)return showError("休憩は0〜1440分の整数で入力してください。");
  next.defaults=d;next.settings.workSummary=d.note;if(await commit(next,'新しい日の初期値を更新しました')){if(settingsDraft)settingsDraft.workSummary=d.note;if(defaultsDraft&&defaultsDraft.locationId===d.locationId&&defaultsDraft.note===d.note&&JSON.stringify(defaultsDraft.phases)===JSON.stringify(d.phases)&&defaultsDraft.breakMinutes.trim()!==''&&Number(defaultsDraft.breakMinutes)===d.breakMinutes)defaultsDraft=null;render();}return;
 }
 if(id==="settingsForm"){
  captureSettings();const invalid=invalidProject(settingsDraft);
  if(invalid>=0){switchProject(invalid);const p=settingsDraft.projects[invalid],nameInvalid=typeof p.name!=='string'||!p.name.trim()||p.name.length>80;$(nameInvalid?'projectName':'projectDescription').focus();toast(p.id+'の'+(nameInvalid?'プロジェクト名':'概要')+'を確認してください。',{warning:true});return;}
  const invalidLocation=invalidPlace(settingsDraft);
  if(invalidLocation>=0){switchPlace(invalidLocation);const place=settingsDraft.places[invalidLocation],field=typeof place.code!=='string'||!place.code.trim()||place.code.length>80?'placeCode':typeof place.name!=='string'||!place.name.trim()||place.name.length>80?'placeName':'placeAddress';$(field).focus();toast('場所'+(invalidLocation+1)+'の入力内容を確認してください。',{warning:true});return;}
  const issue=C.validateSettings(settingsDraft);if(issue)return showError(issue);
  const next=C.clone(data);next.settings=C.clone(settingsDraft);next.submissions={};
  if(await commit(next,'勤務表設定を更新しました')){settingsDraft=null;settingsPlanDrafts.clear();render();}
 }
});
dialog.addEventListener("close",()=>{if(!dialog.open){leaveConfirmation=null;error="";}});
dialog.addEventListener('cancel',()=>{if(dialog.querySelector('[data-action="confirm-submission"]')){submissionRepair=null;rememberRoute(true);}});
window.addEventListener("popstate",event=>{
 if(!data)return;
 const route=event.state;if(!route?.paper)return;
 rememberList();captureEditor();if(view==="settings")captureSettings();if(dialog.open)closeDialog();
 view=["home","records","submit","settings","editor","missing"].includes(route.view)?route.view:"home";
 submissionRepair=validRepair(route.repair)?C.clone(route.repair):null;
 recordsFilter=route.recordFilter==='missing'?'missing':'all';
 const routeMonth=route.month||C.month(clockNow().day).start;selectedMonth=C.validDay(routeMonth)&&routeMonth>=firstMonth()&&routeMonth<=C.month(clockNow().day).start?routeMonth:C.month(clockNow().day).start;editDay=route.day||"";editorReturn=route.origin||"records";
 if(view==="editor"&&(!C.validDay(editDay)||editDay<C.firstDay(data)||editDay>clockNow().day))view="records";
 restOpen=false;error="";render();restorePosition();
 if(view==='submit'&&submissionRepair){testSubmission=submissionRepair.test;selectedMonth=submissionRepair.month;render();openSubmission(submissionRepair.period,{remember:false});}
});
function tick(){
 if(!data)return;
 const current=clockNow(),newDay=current.day!==now.day;now=current;
 if(newDay){sampleClock="";if(!dialog.open&&view==="home")render();return;}
 if(view!=="home")return;
 const node=$("paperClock");if(node){node.innerHTML=now.time+'<span class="seconds">:'+now.full.slice(-2)+'</span>';node.dateTime=now.day+'T'+now.full+'+09:00';}
 if(detail==="summary")syncPerformance();
 const minute=now.day+now.time;if(lastMinute!==minute){lastMinute=minute;if($("weekArea"))$("weekArea").innerHTML=week();}
}
async function loadData(){
 if(loading)return;loading=true;storageProblem="";render();
 try{
  if(!repository){
   const options={key:config.storageKey,mode:config.mode,initialState:()=>config.initialState(clockNow()),now:()=>clockNow()};
   repository=await (typeof window.PaperRepositoryFactory==="function"?window.PaperRepositoryFactory(options):window.PaperRepository.createLocal(options));
  }
  const loaded=await repository.load();
  data=loaded;storageProblem="";error="";selectedMonth=C.month(clockNow().day).start;
  if(!unsubscribe)unsubscribe=repository.subscribe(()=>showError("別の画面で記録が更新されました。再読み込みして最新の記録を確認してください。"));
  render();rememberRoute(true);
 }catch(issue){storageProblem=repositoryMessage(issue,"保存した記録を読み込めません。ブラウザの保存設定を確認してください。");data=null;}
 finally{loading=false;render();}
}
setInterval(tick,1000);document.addEventListener("visibilitychange",()=>{if(!document.hidden){tick();syncPushSettings();}});
window.addEventListener("focus",syncPushSettings);
void loadData();
})();
