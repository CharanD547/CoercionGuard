// "Test a live page in a private sandbox": capture a public page, try its choices in a private copy,
// check them against the visitor's goal. The server owns the review; this only renders what it returns.
import "../styles/page-review.css";

const API=(new URLSearchParams(location.search).get('api')||'').replace(/\/$/,'');
const $=id=>document.getElementById(id);
const el=(tag,props={},kids=[])=>{const n=Object.assign(document.createElement(tag),props);n.append(...kids);return n};
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;

let review=null;   // latest server copy
let workspace=null;
let reminderPreview=null;
let reminderVersion=0;

async function api(path,{method='GET',body,headers={}}={}){
  const res=await fetch(API+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){
    const d=data.detail;
    const err=new Error(typeof d==='string'?d:d?.message||`The server answered ${res.status}.`);
    err.status=res.status;err.detail=d;throw err;
  }
  return data;
}
function showError(node,msg,hint){node.replaceChildren(el('b',{textContent:msg}),...(hint?[hint]:[]));node.hidden=false}

// ---------- Capture ----------
const form=$('pr-form'),urlIn=$('pr-url'),goalIn=$('pr-goal');
$('pr-chips').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  const cur=goalIn.value.trim();
  goalIn.value=cur&&!cur.toLowerCase().includes(b.textContent.toLowerCase())?`${cur.replace(/[.,;]$/,'')}, ${b.textContent.toLowerCase()}`:cur||b.textContent;
  goalIn.focus();
});
form.querySelector('.pr-try').addEventListener('click',e=>{
  const b=e.target.closest('button[data-url]');if(!b)return;
  urlIn.value=b.dataset.url;goalIn.value=b.dataset.goal;$('pr-agents').focus();
});

// ---------- Where the page comes from: an address, an uploaded copy, or the archive ----------
let savedPage=null;   // {page_id, name, title} after an upload
let lastAction=null;  // 'agents' or 'choices', so a fallback can rerun it
const rerun=()=>{if(lastAction==='choices')form.requestSubmit();else $('pr-agents').click()};

async function uploadFrom(input,{thenRun=false}={}){
  const file=input.files[0];if(!file)return;
  const err=$('pr-error');err.hidden=true;
  $('pr-status').textContent='Uploading your saved page…';
  try{
    const data=new FormData();data.append('file',file);
    const res=await fetch(API+'/api/pages',{method:'POST',body:data});
    const body=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(typeof body.detail==='string'?body.detail:`The upload failed (${res.status}).`);
    savedPage=body;
    $('pr-file-name').textContent=`Using your saved page: ${body.title||body.name}`;
    $('pr-file-chip').hidden=false;$('pr-alt').hidden=true;urlIn.disabled=true;$('pr-fallback').hidden=true;
    $('pr-status').textContent='';
    if(thenRun)rerun();
  }catch(x){$('pr-status').textContent='';showError(err,x.message)}
  finally{input.value=''}
}
$('pr-file').onchange=()=>uploadFrom($('pr-file'));
$('pr-file-2').onchange=()=>uploadFrom($('pr-file-2'),{thenRun:true});  // from the failure prompt: carry on
$('pr-file-clear').onclick=()=>{
  savedPage=null;$('pr-file-chip').hidden=true;$('pr-alt').hidden=false;urlIn.disabled=false;urlIn.focus();
};

// Whenever a live page can't be used, say why and ask for a saved copy.
function showFallback(reason,url,{archive=false}={}){
  if(savedPage){showError($('pr-error'),reason);return}  // the upload itself failed: nothing better to suggest
  $('pr-error').hidden=true;
  const box=$('pr-fallback');
  $('pr-fallback-reason').textContent=reason;
  $('pr-archive-text').hidden=$('pr-archive-use').hidden=true;
  box.hidden=false;
  box.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});
  if(archive)offerArchive(url);
}
async function offerArchive(url){
  const text=$('pr-archive-text'),use=$('pr-archive-use');
  if(!url||/web\.archive\.org/.test(url))return;
  text.hidden=false;text.textContent='Or: looking for an archived copy of this page…';
  try{
    const found=await api('/api/archive?url='+encodeURIComponent(url));
    text.textContent=`Or try the Internet Archive's copy from ${found.date}. Archived copies can miss parts the site builds with scripts.`;
    use.hidden=false;
    use.onclick=()=>{urlIn.value=found.url;$('pr-fallback').hidden=true;rerun()};
  }catch{text.hidden=true}
}

function readForm(){
  const url=urlIn.value.trim(),goal=goalIn.value.trim(),err=$('pr-error');
  err.hidden=true;$('pr-fallback').hidden=true;
  if(!savedPage&&!/^https?:\/\/\S+\.\S+/.test(url)){showError(err,'Enter the full page address, starting with https://, or upload a saved page.');urlIn.focus();return null}
  if(goal.length<3){showError(err,'Say what you want to avoid, so the agents have something to aim for.');goalIn.focus();return null}
  return savedPage?{page_id:savedPage.page_id,goal}:{url,goal};
}
// Run the agent comparison above on this page. lab.js owns the lanes and reports back when done.
$('pr-agents').onclick=()=>{
  const f=readForm();if(!f)return;
  lastAction='agents';
  $('pr-agents').disabled=true;
  $('pr-status').textContent=f.page_id?'Both agents are opening your saved page…':'Both agents are opening the live page…';
  document.dispatchEvent(new CustomEvent('cg-live-battle',{detail:f}));
};
document.addEventListener('cg-battle-done',e=>{
  $('pr-agents').disabled=false;$('pr-status').textContent='';
  const error=e.detail?.error;
  if(lastAction==='agents'&&error&&!/too many/i.test(error))showFallback(error,urlIn.value.trim(),{archive:/bot check/.test(error)});
});

const STAGES=['Opening the page in a private browser…','Reading its choices and their defaults…','Taking a snapshot of the original…','Almost there…'];
form.addEventListener('submit',async e=>{
  e.preventDefault();
  if($('pr-capture').disabled)return;
  const f=readForm();if(!f)return;
  lastAction='choices';
  const err=$('pr-error');
  $('pr-capture').disabled=true;
  let i=0;$('pr-status').textContent=STAGES[0];
  const tick=setInterval(()=>{i=Math.min(i+1,STAGES.length-1);$('pr-status').textContent=STAGES[i]},4000);
  try{
    const r=await api('/api/reviews',{method:'POST',body:f});
    history.replaceState(null,'',`#review=${r.id}`);
    open(r);
  }catch(x){
    const s=x.detail?.status;
    if(['blocked','login_required','unreachable'].includes(s))showFallback(captureMessage(x),f.url,{archive:s==='blocked'});
    else showError(err,captureMessage(x),x.detail?.hint);
  }
  finally{clearInterval(tick);$('pr-capture').disabled=false;$('pr-status').textContent=''}
});
function captureMessage(x){
  const s=x.detail?.status;
  if(s==='login_required')return 'This page needs you to sign in, so our browser could only see the sign-in screen.';
  if(s==='blocked')return 'The site blocked our private browser with a bot check.';
  if(s==='unreachable')return x.message+' The site may be slow or unavailable to our browser.';
  if(x.status===429)return 'Too many captures in a minute. Wait a moment and try again.';
  return x.message;
}

// ---------- Sandbox ----------
function open(r){
  review=r;
  workspace={id:r.id,pending:Promise.resolve(),saves:0,failed:0,operation:false,expired:false};
  $('pr-work').hidden=false;
  $('pr-page').textContent=r.title||r.final_url;
  const link=$('pr-link');
  const saved=r.final_url.startsWith('https://saved-page.coercionguard.local/');
  const archived=new URL(r.final_url).hostname==='web.archive.org';
  $('pr-source-kind').textContent=saved?'Saved copy':archived?'Archived copy':'Live capture';
  if(saved){link.removeAttribute('href');link.textContent=r.url}
  else{link.href=r.final_url;link.textContent=r.final_url.replace(/^https?:\/\//,'').replace(/\/$/,'')}
  const mins=Math.max(0,Math.round((r.expires_at*1000-Date.now())/60000));
  $('pr-expiry').textContent=` · private sandbox for “${r.goal}”, expires in ${mins} min`;
  $('pr-notes').replaceChildren(...r.notes.map(n=>el('li',{textContent:n})));
  $('pr-shot').removeAttribute('src');
  if(r.screenshot){$('pr-shot').src='data:image/jpeg;base64,'+r.screenshot;$('pr-shot').alt=`Screenshot of ${r.title||'the page'} as captured`}
  const hasChoices=r.controls.length>0;
  $('pr-choices-title').textContent=hasChoices?"Try the page's choices":"Review the captured terms";
  $('pr-check').textContent=hasChoices?'Check these choices':'Check these terms';
  for(const id of ['pr-controls','pr-price','pr-reset'])$(id).hidden=!hasChoices;
  $('pr-work-status').textContent='';
  invalidateReminder();
  renderControls();renderPrice();renderAssessment();
  updateControls();
  $('pr-work').scrollIntoView({behavior:reduced()?'auto':'smooth',block:'start'});
  $('pr-page').focus({preventScroll:true});
}

const ON=v=>v?'on':'off';
const optionLabel=(c,id)=>c.options?.find(o=>o.id===id)?.label??'none';
function renderControls(){
  const box=$('pr-controls');
  const flagged=new Set((review.assessment?.conflicts||[]).map(c=>c.control_id).filter(Boolean));
  if(!review.controls.length){
    box.replaceChildren(el('p',{className:'pr-empty',textContent:'This page has no choices to try. You can still check it against your goal.'}));
    return;
  }
  box.replaceChildren(...review.controls.map(c=>{
    const now=review.selections[c.id],def=review.defaults[c.id],changed=now!==def;
    const wrap=el('div',{className:'pr-control'+(changed?' changed':'')+(flagged.has(c.id)?' flagged':''),id:'pr-ctl-'+c.id});
    if(c.kind==='checkbox'){
      const input=el('input',{type:'checkbox',checked:!!now});
      input.onchange=()=>save({[c.id]:input.checked});
      wrap.append(el('label',{className:'pr-opt'},[input,el('span',{textContent:c.label})]),
        el('span',{className:'pr-default'},['Page default: ',el('b',{textContent:ON(def)}),changed?` · you changed it to ${ON(now)}`:'']));
    }else if(c.kind==='radio'){
      const fs=el('fieldset',{},[el('legend',{textContent:c.label})]);
      for(const o of c.options){
        const input=el('input',{type:'radio',name:'pr-'+c.id,value:o.id,checked:o.id===now});
        input.onchange=()=>input.checked&&save({[c.id]:o.id});
        const text=el('span',{textContent:o.label});
        if(o.id===def)text.append(el('span',{className:'pr-tag',textContent:'page default'}));
        fs.append(el('label',{className:'pr-opt'},[input,text]));
      }
      wrap.append(fs);
      if(changed)wrap.append(el('span',{className:'pr-default'},['Page default: ',el('b',{textContent:optionLabel(c,def)})]));
    }else{
      const id='pr-sel-'+c.id;
      const sel=el('select',{id},c.options.map(o=>el('option',{value:o.id,textContent:o.label,selected:o.id===now})));
      sel.onchange=()=>save({[c.id]:sel.value});
      wrap.append(el('label',{className:'pr-sel-label',htmlFor:id,textContent:c.label}),sel,
        el('span',{className:'pr-default'},['Page default: ',el('b',{textContent:optionLabel(c,def)})]));
    }
    return wrap;
  }));
}

const bare=s=>s.replace(/:\s*$/,'');
function renderPrice(){
  const t=review.totals,box=$('pr-price');
  box.dataset.known=String(t.known);
  const items=[...t.changes.map(ch=>el('li',{},[bare(ch.label)+': ',el('span',{className:'amount',textContent:(ch.delta_minor>0?'+':'')+ch.display})])),
    ...t.unknown.map(u=>el('li',{textContent:`${bare(u.label)}: price unknown. ${u.reason}`}))];
  box.replaceChildren(el('p',{textContent:t.explanation||''}),...(items.length?[el('ul',{},items)]:[]));
}

function gone(x){
  if(x.status!==404)return false;
  $('pr-work-status').textContent='This sandbox has expired. Build a new one to keep going.';
  workspace.expired=true;
  invalidateReminder();
  renderAssessment();
  updateControls();
  return true;
}
function merge(r){
  review={...review,...r,screenshot:review.screenshot};
  renderControls();renderPrice();renderAssessment();updateControls();
}
function updateControls(){
  const disabled=workspace.operation||workspace.expired;
  $('pr-check').disabled=$('pr-reset').disabled=disabled;
  for(const input of $('pr-controls').querySelectorAll('input,select'))input.disabled=disabled;
}
function save(change){
  const current=workspace;
  if(current.operation||current.expired)return;
  current.saves++;
  invalidateReminder();
  renderAssessment();
  $('pr-work-status').textContent='Saving your choice…';
  current.pending=current.pending.then(async()=>{
    try{
      if(current!==workspace||current.expired)return;
      const r=await api(`/api/reviews/${current.id}/selections`,{method:'PATCH',body:{selections:change}});
      if(current===workspace)review={...review,...r,screenshot:review.screenshot};
    }catch(x){
      current.failed++;
      if(current===workspace&&!gone(x))$('pr-work-status').textContent="A choice couldn't be saved: "+x.message;
    }finally{
      current.saves--;
      if(current===workspace&&!current.saves){
        renderControls();renderPrice();renderAssessment();updateControls();
        if(!current.failed&&!current.operation)$('pr-work-status').textContent='';
      }
    }
  });
}
async function reviewAction(action){
  const current=workspace;
  if(current.operation||current.expired)return;
  const check=action==='check',failures=current.failed;
  current.operation=true;
  invalidateReminder();
  updateControls();
  renderAssessment();
  $('pr-work-status').textContent=check?'Checking your review against your goal…':'Restoring page defaults…';
  try{
    await current.pending;
    if(current!==workspace||current.expired)return;
    if(check&&current.failed!==failures)throw new Error('A choice could not be saved. Review the displayed choices and try again.');
    const r=await api(`/api/reviews/${current.id}/${action}`,{method:'POST',body:check?{}:undefined});
    if(current!==workspace)return;
    merge(r);
    current.failed=0;
    $('pr-work-status').textContent=check?'':'Back to the page defaults.';
    if(check){
      $('pr-verdict').scrollIntoView({behavior:reduced()?'auto':'smooth',block:'start'});
      $('pr-verdict-title').focus({preventScroll:true});
    }
  }catch(x){
    if(current===workspace&&!gone(x))$('pr-work-status').textContent=x.message;
  }finally{
    current.operation=false;
    if(current===workspace){updateControls();renderAssessment()}
  }
}
$('pr-reset').onclick=()=>reviewAction('reset');
$('pr-check').onclick=()=>reviewAction('check');

// ---------- Findings ----------
const VERDICT={conflicts:'Conflict found',fits_goal:'No conflict found in the captured terms',unclear:'Needs review'};
const hostPath=u=>u.replace(/^https?:\/\//,'').replace(/\/$/,'');
const isSavedSource=url=>new URL(url).hostname==='saved-page.coercionguard.local';
function renderAssessment(){
  const a=review.assessment,panel=$('pr-verdict');
  if(!a){panel.hidden=true;$('pr-remind').hidden=true;return}
  panel.hidden=false;
  const stamp=$('pr-stamp');stamp.dataset.state=a.verdict;stamp.textContent=VERDICT[a.verdict]||a.verdict;
  const stale=review.assessment_stale||workspace.saves>0||workspace.operation||workspace.expired;
  $('pr-stale').hidden=!stale;
  $('pr-conflicts').replaceChildren(...a.conflicts.map(c=>{
    const li=el('li',{},[el('p',{className:'issue',textContent:c.issue})]);
    if(c.control_id){
      const jump=el('button',{type:'button',textContent:bare(c.control_label)});
      jump.onclick=()=>{const t=$('pr-ctl-'+c.control_id);t?.scrollIntoView({block:'center'});t?.querySelector('input,select')?.focus()};
      li.append(el('p',{className:'about'},['About: ',jump]));
    }
    li.append(el('blockquote',{className:'pr-quote',textContent:c.evidence.excerpt}),
      el('span',{className:'pr-source'},isSavedSource(c.evidence.url)?['From your saved copy']:
        [c.evidence.source==='linked'?'From the linked page ':'From this page ',
          el('a',{href:c.evidence.url,target:'_blank',rel:'noopener noreferrer',textContent:hostPath(c.evidence.url)})]));
    return li;
  }));
  const un=$('pr-unverified'),n=a.unverified.length;
  un.hidden=!n;
  if(n){
    un.querySelector('summary').textContent=`${n} claim${n>1?'s':''} couldn't be matched to the page text, so ${n>1?'they aren\'t':'it isn\'t'} shown as evidence`;
    un.querySelector('ul').replaceChildren(...a.unverified.map(u=>el('li',{textContent:u.issue+(u.claimed_excerpt?` (quoted as “${u.claimed_excerpt}”)`:'')})));
  }
  $('pr-rec').textContent=a.recommendation;
  $('pr-next').textContent=a.next_step;$('pr-next').hidden=!a.next_step;
  const when=new Date(a.checked_at*1000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const engine=a.analysis_mode==='rules_fallback'?'Vultr Inference unavailable. Checked by CoercionGuard rules':
    a.engine.startsWith('vultr:')?'Checked by '+a.engine.slice(6)+' on Vultr':'Checked by CoercionGuard rules';
  $('pr-engine').textContent=`${engine} at ${when}${a.linked_page?`, including ${hostPath(a.linked_page)}`:''}.`;
  renderReminder(stale?null:a.follow_up);
}

// ---------- Reminder ----------
const tz=$('pr-tz');
(()=>{
  const here=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  const zones=Intl.supportedValuesOf?Intl.supportedValuesOf('timeZone'):[here,'UTC'];
  if(!zones.includes(here))zones.unshift(here);
  tz.replaceChildren(...zones.map(z=>el('option',{value:z,textContent:z.replace(/_/g,' '),selected:z===here})));
  $('pr-trial-end').min=new Date().toISOString().slice(0,10);
})();
function renderReminder(f){
  $('pr-remind').hidden=!f;if(!f)return;
  $('pr-remind-quote').textContent=f.evidence.excerpt;
  $('pr-remind-hint').textContent=`Use the trial end date the site shows you. ${f.hint||''}`.trim();
}
const reminderBody=()=>({trial_end_date:$('pr-trial-end').value,timezone:tz.value,days_before:Number($('pr-days').value)});
function invalidateReminder(){
  reminderVersion++;
  reminderPreview=null;
  $('pr-event').hidden=true;
  $('pr-remind-error').hidden=true;
  $('pr-ics').removeAttribute('href');
  $('pr-approved').replaceChildren();
  $('pr-approve').querySelector('button').disabled=false;
  $('pr-token').value='';
}
$('pr-remind-form').addEventListener('input',invalidateReminder);
$('pr-remind-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const button=e.currentTarget.querySelector('button[type="submit"]');
  if(button.disabled)return;
  invalidateReminder();
  const err=$('pr-remind-error'),current=workspace,version=reminderVersion;
  if(!$('pr-trial-end').value){showError(err,'Pick the date your trial ends.');$('pr-trial-end').focus();return}
  button.disabled=true;
  try{
    const {event,ics_url,preview_id}=await api(`/api/reviews/${current.id}/reminder/preview`,{method:'POST',body:reminderBody()});
    if(current!==workspace||version!==reminderVersion)return;
    reminderPreview=preview_id;
    const start=new Date(event.start.dateTime);
    $('pr-event-when').textContent=start.toLocaleString([],{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:event.start.timeZone})+` (${event.start.timeZone.replace(/_/g,' ')})`;
    $('pr-event-title').textContent=event.summary;
    $('pr-event-desc').textContent=event.description;
    $('pr-ics').href=API+ics_url;
    $('pr-event').hidden=false;
  }catch(x){if(current===workspace&&version===reminderVersion&&!gone(x))showError(err,x.message)}
  finally{button.disabled=false}
});
try{sessionStorage.removeItem('cg-op')}catch{}
$('pr-approve').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!reminderPreview)return;
  const current=workspace,version=reminderVersion,preview_id=reminderPreview;
  const input=$('pr-token'),token=input.value.trim(),out=$('pr-approved'),button=e.currentTarget.querySelector('button');
  input.value='';
  button.disabled=true;
  out.textContent='Adding to the team calendar…';
  try{
    const r=await api(`/api/reviews/${current.id}/reminder/approve`,{method:'POST',body:{preview_id},headers:{Authorization:'Bearer '+token}});
    if(current!==workspace||version!==reminderVersion)return;
    const msg={created:'Added to the team calendar. ',already_created:'This reminder is already on the team calendar, so nothing was duplicated. ',restored:'The reminder was restored on the team calendar. '}[r.status]||'';
    out.replaceChildren(msg,...(r.html_link?[el('a',{href:r.html_link,target:'_blank',rel:'noopener noreferrer',textContent:'Open the event'})]:[]));
  }catch(x){
    if(current===workspace&&version===reminderVersion&&!gone(x))out.textContent=x.message;
  }finally{
    if(current===workspace&&version===reminderVersion)button.disabled=false;
  }
});

// ---------- Reopen a sandbox from its private link ----------
const saved=location.hash.match(/^#review=([\w-]+)/);
if(saved){
  $('pr-status').textContent='Opening your sandbox…';
  api(`/api/reviews/${saved[1]}`).then(r=>{if(!workspace&&lastAction===null)open(r)}).catch(x=>{
    if(workspace||lastAction!==null)return;
    history.replaceState(null,'',location.pathname+location.search);
    showError($('pr-error'),x.status===404?'That sandbox has expired. Sandboxes last one hour, so build a new one.':x.message);
  }).finally(()=>{if(lastAction===null)$('pr-status').textContent=''});
}
