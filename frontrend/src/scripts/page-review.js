// "Test a live page in a private sandbox": capture a public page, try its choices in a private copy,
// check them against the visitor's goal. The server owns the review; this only renders what it returns.
import "../styles/page-review.css";

const API=(new URLSearchParams(location.search).get('api')||'').replace(/\/$/,'');
const $=id=>document.getElementById(id);
const el=(tag,props={},kids=[])=>{const n=Object.assign(document.createElement(tag),props);n.append(...kids);return n};
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;

let review=null;   // latest server copy
let pending=null;  // in-flight selection save, so Check waits for it

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
  const f=readForm();if(!f)return;
  lastAction='choices';
  const err=$('pr-error');
  $('pr-capture').disabled=true;
  let i=0;$('pr-status').textContent=STAGES[0];
  const tick=setInterval(()=>{i=Math.min(i+1,STAGES.length-1);$('pr-status').textContent=STAGES[i]},4000);
  try{
    const r=await api('/api/reviews',{method:'POST',body:f});
    if(r.status==='no_controls'&&!savedPage){
      showFallback('This page loaded, but it has no choices to try. Many sites only show them after their scripts run or after you sign in.',f.url);
    }else{
      history.replaceState(null,'',`#review=${r.id}`);
      open(r);
    }
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
  $('pr-work').hidden=false;
  $('pr-page').textContent=r.title||r.final_url;
  const link=$('pr-link');
  if(r.final_url.startsWith('https://saved-page.coercionguard.local/')){link.removeAttribute('href');link.textContent=`${r.url} (your saved copy)`}
  else{link.href=r.final_url;link.textContent=r.final_url.replace(/^https?:\/\//,'').replace(/\/$/,'')}
  const mins=Math.max(0,Math.round((r.expires_at*1000-Date.now())/60000));
  $('pr-expiry').textContent=` · private sandbox for “${r.goal}”, expires in ${mins} min`;
  $('pr-notes').replaceChildren(...r.notes.map(n=>el('li',{textContent:n})));
  if(r.screenshot){$('pr-shot').src='data:image/jpeg;base64,'+r.screenshot;$('pr-shot').alt=`Screenshot of ${r.title||'the page'} as captured`}
  $('pr-check').disabled=$('pr-reset').disabled=false;$('pr-work-status').textContent='';
  $('pr-event').hidden=true;
  renderControls();renderPrice();renderAssessment();
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
  $('pr-check').disabled=$('pr-reset').disabled=true;
  return true;
}
function merge(r){review={...review,...r,screenshot:review.screenshot};renderControls();renderPrice();renderAssessment()}
async function save(change){
  $('pr-work-status').textContent='Saving your choice…';
  const p=api(`/api/reviews/${review.id}/selections`,{method:'PATCH',body:{selections:change}});
  pending=p;
  try{const r=await p;if(pending===p){merge(r);$('pr-work-status').textContent=''}}
  catch(x){gone(x)||($('pr-work-status').textContent='That choice couldn\'t be saved: '+x.message);renderControls()}
}
$('pr-reset').onclick=async()=>{
  try{merge(await api(`/api/reviews/${review.id}/reset`,{method:'POST'}));$('pr-work-status').textContent='Back to the page\'s own defaults.'}
  catch(x){gone(x)||($('pr-work-status').textContent=x.message)}
};
$('pr-check').onclick=async()=>{
  const btn=$('pr-check');btn.disabled=true;$('pr-work-status').textContent='Checking your choices against your goal…';
  try{
    await pending?.catch(()=>{});
    merge(await api(`/api/reviews/${review.id}/check`,{method:'POST',body:{}}));
    $('pr-work-status').textContent='';
    $('pr-verdict').scrollIntoView({behavior:reduced()?'auto':'smooth',block:'start'});
    $('pr-verdict-title').focus({preventScroll:true});
  }catch(x){gone(x)||($('pr-work-status').textContent='The check didn\'t finish: '+x.message)}
  finally{if(!$('pr-reset').disabled)btn.disabled=false}
};

// ---------- Findings ----------
const VERDICT={conflicts:'Conflicts with your goal',fits_goal:'Fits your goal',unclear:'Unclear'};
const hostPath=u=>u.replace(/^https?:\/\//,'').replace(/\/$/,'');
function renderAssessment(){
  const a=review.assessment,panel=$('pr-verdict');
  if(!a){panel.hidden=true;$('pr-remind').hidden=true;return}
  panel.hidden=false;
  const stamp=$('pr-stamp');stamp.dataset.state=a.verdict;stamp.textContent=VERDICT[a.verdict]||a.verdict;
  $('pr-stale').hidden=!review.assessment_stale;
  $('pr-conflicts').replaceChildren(...a.conflicts.map(c=>{
    const li=el('li',{},[el('p',{className:'issue',textContent:c.issue})]);
    if(c.control_id){
      const jump=el('button',{type:'button',textContent:bare(c.control_label)});
      jump.onclick=()=>{const t=$('pr-ctl-'+c.control_id);t?.scrollIntoView({block:'center'});t?.querySelector('input,select')?.focus()};
      li.append(el('p',{className:'about'},['About: ',jump]));
    }
    li.append(el('blockquote',{className:'pr-quote',textContent:c.evidence.excerpt}),
      el('span',{className:'pr-source'},[c.evidence.source==='linked'?'From the linked page ':'From this page ',
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
  $('pr-engine').textContent=`${a.engine.startsWith('vultr:')?'Checked by '+a.engine.slice(6)+' on Vultr':'Checked by CoercionGuard\'s rules'} at ${when}${a.linked_page?`, including ${hostPath(a.linked_page)}`:''}.`;
  renderReminder(a.follow_up);
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
$('pr-remind-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const err=$('pr-remind-error');err.hidden=true;$('pr-event').hidden=true;$('pr-approved').textContent='';
  if(!$('pr-trial-end').value){showError(err,'Pick the date your trial ends.');$('pr-trial-end').focus();return}
  try{
    const {event,ics_url}=await api(`/api/reviews/${review.id}/reminder/preview`,{method:'POST',body:reminderBody()});
    const start=new Date(event.start.dateTime);
    $('pr-event-when').textContent=start.toLocaleString([],{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:event.start.timeZone})+` (${event.start.timeZone.replace(/_/g,' ')})`;
    $('pr-event-title').textContent=event.summary;
    $('pr-event-desc').textContent=event.description;
    $('pr-ics').href=API+ics_url;
    $('pr-event').hidden=false;
  }catch(x){gone(x)||showError(err,x.message)}
});
try{$('pr-token').value=sessionStorage.getItem('cg-op')||''}catch{}
$('pr-approve').addEventListener('submit',async e=>{
  e.preventDefault();
  const token=$('pr-token').value.trim(),out=$('pr-approved');
  out.textContent='Adding to the team calendar…';
  try{
    const r=await api(`/api/reviews/${review.id}/reminder/approve`,{method:'POST',body:reminderBody(),headers:{Authorization:'Bearer '+token}});
    try{sessionStorage.setItem('cg-op',token)}catch{}
    const msg={created:'Added to the team calendar. ',already_created:'This reminder is already on the team calendar, so nothing was duplicated. ',restored:'The reminder was restored on the team calendar. '}[r.status]||'';
    out.replaceChildren(msg,...(r.html_link?[el('a',{href:r.html_link,target:'_blank',rel:'noopener noreferrer',textContent:'Open the event'})]:[]));
  }catch(x){out.textContent=x.status===401?'That operator token isn\'t right.':x.message}
});

// ---------- Reopen a sandbox from its private link ----------
const saved=location.hash.match(/^#review=([\w-]+)/);
if(saved){
  $('pr-status').textContent='Opening your sandbox…';
  api(`/api/reviews/${saved[1]}`).then(open).catch(x=>{
    history.replaceState(null,'',location.pathname+location.search);
    showError($('pr-error'),x.status===404?'That sandbox has expired. Sandboxes last one hour, so build a new one.':x.message);
  }).finally(()=>$('pr-status').textContent='');
}
