export function createScene(THREE,host,{$,el,TERMS,termValues,FIXTURES,activeFixture,setState}){
  const canvas=document.createElement('canvas');host.prepend(canvas);
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  const s=new THREE.Scene();s.background=new THREE.Color('#2f3a38');
  const camera=new THREE.PerspectiveCamera(30,1,.1,80);

  // Light table: soft key from upper left, cool rim, a pool of light on the blotter.
  s.add(new THREE.HemisphereLight('#f4f6f2','#1f2725',.75));
  const key=new THREE.DirectionalLight('#fff6e8',2.4);key.position.set(-3.5,8,4.5);key.castShadow=true;
  key.shadow.mapSize.set(1024,1024);Object.assign(key.shadow.camera,{left:-6,right:6,top:6,bottom:-6,near:1,far:20});key.shadow.bias=-.0004;key.shadow.radius=4;
  s.add(key);
  const rim=new THREE.DirectionalLight('#a9c7ff',.7);rim.position.set(5,3,-5);s.add(rim);
  const table=new THREE.Mesh(new THREE.PlaneGeometry(40,40),new THREE.MeshStandardMaterial({color:'#2f3a38',roughness:.96}));
  table.rotation.x=-Math.PI/2;table.receiveShadow=true;s.add(table);
  const pool=new THREE.Mesh(new THREE.PlaneGeometry(12,9),new THREE.MeshBasicMaterial({map:radial(),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,opacity:.55}));
  pool.rotation.x=-Math.PI/2;pool.position.set(.4,.002,.2);s.add(pool);

  const rig=new THREE.Group();s.add(rig);
  const W=3,H=2,TAB=.42,S=300;

  function canvasTex(w,h){
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=renderer.capabilities.getMaxAnisotropy();
    return {c,ctx:c.getContext('2d'),t};
  }
  function radial(){
    const {c,ctx,t}=canvasTex(256,256);const g=ctx.createRadialGradient(128,128,0,128,128,128);
    g.addColorStop(0,'#3d4c48');g.addColorStop(1,'#000');ctx.fillStyle=g;ctx.fillRect(0,0,256,256);return t;
  }
  let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  function paper(ctx,w,h,tint){
    ctx.fillStyle=tint;ctx.fillRect(0,0,w,h);seed=7;
    for(let i=0;i<w*h/90;i++){ctx.fillStyle=rnd()>.5?'#ffffff12':'#00000009';ctx.fillRect(rnd()*w,rnd()*h,1+rnd()*2,1)}
  }
  function fit(ctx,text,font,maxW,size){ctx.font=font(size);while(ctx.measureText(text).width>maxW&&size>10){size-=2;ctx.font=font(size)}return size}

  // A copy is a rounded sheet with an index tab, extruded with a small bevel.
  function rr(shape,x,y,w,h,r){shape.moveTo(x+r,y);shape.lineTo(x+w-r,y);shape.quadraticCurveTo(x+w,y,x+w,y+r);shape.lineTo(x+w,y+h-r);shape.quadraticCurveTo(x+w,y+h,x+w-r,y+h);shape.lineTo(x+r,y+h);shape.quadraticCurveTo(x,y+h,x,y+h-r);shape.lineTo(x,y+r);shape.quadraticCurveTo(x,y,x+r,y);return shape}
  function sheetGeometry(tabY){
    const shapes=[rr(new THREE.Shape(),-W/2,-H/2,W,H,.05)];
    if(tabY!==null)shapes.push(rr(new THREE.Shape(),W/2-.1,tabY-.2,TAB+.1,.4,.06));
    const g=new THREE.ExtrudeGeometry(shapes,{depth:.012,bevelEnabled:true,bevelThickness:.003,bevelSize:.003,bevelSegments:2,curveSegments:6});
    g.rotateX(-Math.PI/2);return g;
  }
  function sheet(tint,tabY,texW){
    const tex=canvasTex(Math.round(texW*S),H*S);
    tex.t.repeat.set(1/texW,1/H);tex.t.offset.set(W/2/texW,.5);
    const face=new THREE.MeshStandardMaterial({map:tex.t,roughness:.86});
    const side=new THREE.MeshStandardMaterial({color:new THREE.Color(tint).multiplyScalar(.82),roughness:.9});
    const mesh=new THREE.Mesh(sheetGeometry(tabY),[face,side]);mesh.castShadow=mesh.receiveShadow=true;
    const g=new THREE.Group();g.add(mesh);rig.add(g);return {g,mesh,tex};
  }

  const STACK_X=-1.05,PULL_X=.2,PULL_Z=.5;
  const layers={},TAB_Y={charge:.6,renewal:0,data:-.6},BASE_Y={charge:.18,renewal:.12,data:.06};
  for(const t of TERMS){layers[t.key]=sheet(t.tint,TAB_Y[t.key],W+TAB);layers[t.key].mesh.userData.term=t.key}
  const top=sheet('#fbfbf8',null,W);

  // Acetate: the user's instruction, printed on clear film.
  const acetate=new THREE.Group();rig.add(acetate);
  const film=new THREE.Mesh(new THREE.BoxGeometry(1.85,.008,1.2),new THREE.MeshPhysicalMaterial({color:'#d7ebe4',transparent:true,opacity:.34,roughness:.08,clearcoat:1,clearcoatRoughness:.05,depthWrite:false}));
  const printTex=canvasTex(740,480);
  const print=new THREE.Mesh(new THREE.PlaneGeometry(1.85,1.2),new THREE.MeshBasicMaterial({map:printTex.t,transparent:true,depthWrite:false}));
  print.rotation.x=-Math.PI/2;print.position.y=.006;acetate.add(film,print);

  function drawLayer(t,vals){
    const {ctx,c,t:tex}=layers[t.key].tex,w=c.width,h=c.height,px=x=>(x+W/2)*S,py=y=>(H/2-y)*S;
    paper(ctx,w,h,t.tint);
    ctx.strokeStyle='#00000018';ctx.lineWidth=2;
    for(let y=-.9;y<.75;y+=.22){ctx.beginPath();ctx.moveTo(px(-1.4),py(y));ctx.lineTo(px(1.4),py(y));ctx.stroke()}
    ctx.fillStyle='#18211e';ctx.font='650 28px Archivo';ctx.fillText(t.name,px(-1.28),py(.78));
    ctx.font='500 22px Archivo';ctx.fillStyle='#18211eb0';ctx.fillText('Proposal asks',px(-1.28),py(.15));
    ctx.fillStyle='#18211e';const v=vals[t.key].requested;
    const size=fit(ctx,v,s=>`700 ${s}px "Courier Prime"`,2.35*S,86);ctx.font=`700 ${size}px "Courier Prime"`;ctx.fillText(v,px(-1.28),py(-.42));
    ctx.save();ctx.fillStyle='#18211e';ctx.font='650 22px Archivo';ctx.textAlign='center';
    ctx.fillText(t.tab,px(W/2+TAB/2-.02),py(TAB_Y[t.key])+8);ctx.restore();
    tex.needsUpdate=true;
  }
  function drawTop(fx,result){
    const {ctx,c,t:tex}=top.tex,w=c.width,h=c.height;
    paper(ctx,w,h,'#fbfbf8');
    ctx.fillStyle='#18211e99';ctx.font='500 28px Archivo';ctx.fillText('Proposal',60,100);
    ctx.fontStretch='expanded';const size=fit(ctx,fx.headline,s=>`800 ${s}px Archivo`,w*.42,128);
    ctx.fillStyle='#18211e';ctx.font=`800 ${size}px Archivo`;ctx.textAlign='right';ctx.fillText(fx.headline,w-36,h*.58);ctx.textAlign='left';
    ctx.fontStretch='normal';ctx.fillStyle='#18211e22';for(let i=0;i<4;i++)ctx.fillRect(60,h-150+i*26,(w-120)*(i===3?.5:1),8);
    if(result){
      const pass=result.decision==='WITHIN POLICY',col=pass?'#1f4ea8':'#b3243f',label=result.decision;
      ctx.save();ctx.translate(w-300,150);ctx.rotate(-.08);ctx.globalAlpha=.88;ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=7;
      ctx.font='800 34px Archivo';const tw=ctx.measureText(label).width;ctx.strokeRect(-tw/2-22,-36,tw+44,64);ctx.textAlign='center';ctx.fillText(label,0,10);ctx.restore();
    }
    tex.needsUpdate=true;
  }
  function drawAcetate(term,vals,check,hint){
    const {ctx,c,t:tex}=printTex,w=c.width,h=c.height;ctx.clearRect(0,0,w,h);
    ctx.strokeStyle='#1f4ea8cc';ctx.lineWidth=3;ctx.strokeRect(10,10,w-20,h-20);
    for(const [x,y] of [[10,10],[w-10,10],[10,h-10],[w-10,h-10]]){ctx.beginPath();ctx.moveTo(x-8,y);ctx.lineTo(x+8,y);ctx.moveTo(x,y-8);ctx.lineTo(x,y+8);ctx.stroke()}
    ctx.fillStyle='#1f4ea8';ctx.font='650 28px Archivo';ctx.fillText('You allowed',32,64);
    const v=vals[term].allowed,size=fit(ctx,v,s=>`800 ${s}px Archivo`,w-64,84);ctx.font=`800 ${size}px Archivo`;ctx.fillText(v,32,64+size+10);
    const stamp=check?(check.pass?['Within scope','#1f4ea8']:[check.status==='unknown'?'Needs review':'Outside scope','#b3243f']):hint?['Outside the instruction','#b3243f']:null;
    if(stamp){ctx.save();ctx.fillStyle=stamp[1];ctx.strokeStyle=stamp[1];ctx.lineWidth=4;ctx.font='800 26px Archivo';
      const tw=ctx.measureText(stamp[0]).width;ctx.strokeRect(28,h-78,tw+28,48);ctx.fillText(stamp[0],42,h-46);ctx.restore()}
    tex.needsUpdate=true;
  }

  // Interruptible motion: every animated value eases toward a target.
  const anims=[];
  function smooth(get,set,k=5){const a={v:get(),target:get(),k,set};anims.push(a);return a}
  const v3=(x,y,z)=>new THREE.Vector3(x,y,z);
  const cam={pos:v3(0,6,6),look:v3(0,0,0),up:v3(0,1,0)};
  const tCam={pos:cam.pos.clone(),look:cam.look.clone(),up:cam.up.clone(),k:3};
  const layerState={};
  for(const t of TERMS){
    const L=layers[t.key];L.g.position.set(STACK_X,BASE_Y[t.key],0);
    layerState[t.key]={pos:L.g.position.clone(),target:L.g.position.clone(),rot:0,rotT:0,k:4};
  }
  top.g.position.set(STACK_X,.24,0);
  const acetateHome=()=>v3(PULL_X+.62,.68,PULL_Z-.08);
  const acetateState={pos:acetateHome(),target:acetateHome(),op:0,opT:1,k:4};
  acetate.position.copy(acetateState.pos);
  let yaw=0,yawT=0,pitch=0,pitchT=0,instant=false;

  function fitDist(aspect,width,height){
    const v=THREE.MathUtils.degToRad(camera.fov),hf=2*Math.atan(Math.tan(v/2)*aspect);
    return Math.max(width/Math.tan(hf/2),height/Math.tan(v/2));
  }
  function lab(aspect){
    const look=v3(PULL_X-.15,.36,PULL_Z-.2),dir=v3(.04,.86,1).normalize();
    return {pos:look.clone().addScaledVector(dir,fitDist(aspect,2.15,1.55)*1.06),look,up:v3(0,1,0)};
  }
  function poseA(aspect){
    const look=v3(STACK_X,.26,0),d=fitDist(aspect,W*.56,H*.52);
    return {pos:v3(look.x,look.y+d,look.z+.01),look,up:v3(0,0,-1)};
  }
  function poseB(aspect){
    const look=v3(PULL_X-.35,.4,PULL_Z),dir=v3(.2,.48,1).normalize();
    return {pos:look.clone().addScaledVector(dir,fitDist(aspect,1.7,1.15)),look,up:v3(0,1,0)};
  }
  function aimCamera(p,snap){tCam.pos.copy(p.pos);tCam.look.copy(p.look);tCam.up.copy(p.up);if(snap){cam.pos.copy(p.pos);cam.look.copy(p.look);cam.up.copy(p.up)}invalidate()}

  function pull(term,snap){
    for(const t of TERMS){
      const st=layerState[t.key],out=t.key===term;
      st.target.set(out?PULL_X:STACK_X,out?.42:BASE_Y[t.key],out?PULL_Z:0);st.rotT=out?-.04:0;
      if(snap){st.pos.copy(st.target);st.rot=st.rotT}
    }
    acetateState.target.copy(acetateHome());
    if(snap)acetateState.pos.copy(acetateState.target);
    invalidate();
  }

  let current={caseIndex:-1,term:null,result:undefined,revised:false},introHint=false;
  function show(st,{snap=false}={}){
    const fx=activeFixture(st),vals=termValues(fx);
    if(st.caseIndex!==current.caseIndex||st.revised!==current.revised||st.result!==current.result){for(const t of TERMS)drawLayer(t,vals);drawTop(fx,st.result)}
    drawAcetate(st.term,vals,st.result?.checks.find(c=>c.key===st.term),introHint);
    if(st.term!==current.term||snap)pull(st.term,snap||instant);
    current={caseIndex:st.caseIndex,term:st.term,result:st.result,revised:st.revised};
    acetateState.opT=1;
    tags.term=st.term;tags.vals=vals;
    invalidate();
  }

  // Projected HTML tags keep the two compared values crisp at any size.
  const tagAllowed=$('tag-allowed'),tagReq=$('tag-requested'),tags={term:null,vals:null,on:false};
  function placeTags(){
    const w=host.clientWidth,h=host.clientHeight,show=tags.on&&w>=680&&h>=420&&tags.vals;
    tagAllowed.classList.toggle('off',!show);tagReq.classList.toggle('off',!show);if(!show)return;
    const v=tags.vals[tags.term];
    tagAllowed.replaceChildren('You allowed',el('b',{textContent:v.allowed}));
    tagReq.replaceChildren('Proposal asks',el('b',{textContent:v.requested}));
    const proj=(p,node,dx,dy)=>{const q=p.clone().applyMatrix4(rig.matrixWorld).project(camera);
      const x=Math.min(Math.max((q.x+1)/2*w+dx,8),w-node.offsetWidth-8),y=Math.min(Math.max((1-q.y)/2*h+dy,8),h-node.offsetHeight-56);
      node.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px)`};
    proj(acetate.position.clone().add(v3(-.85,0,-.58)),tagAllowed,-tagAllowed.offsetWidth-6,-tagAllowed.offsetHeight-4);
    const L=layers[tags.term].g.position;proj(v3(L.x+W/2,L.y,L.z+H/2),tagReq,8,4);
  }

  // Render on demand only.
  let raf=0,last=0,visible=true,dragging=false;
  const ease=(k,dt)=>instant?1:1-Math.exp(-k*dt);
  function frame(now){
    raf=0;const dt=Math.min(.05,(now-(last||now))/1000);last=now;let moving=false;
    const e=ease(tCam.k,dt);
    for(const key of ['pos','look','up']){cam[key].lerp(tCam[key],e);if(cam[key].distanceTo(tCam[key])>1e-4)moving=true}
    camera.position.copy(cam.pos);camera.up.copy(cam.up).normalize();camera.lookAt(cam.look);
    for(const t of TERMS){const st=layerState[t.key],L=layers[t.key].g,f=ease(st.k,dt);
      st.pos.lerp(st.target,f);st.rot+=(st.rotT-st.rot)*f;L.position.copy(st.pos);L.rotation.y=st.rot;
      if(st.pos.distanceTo(st.target)>1e-4||Math.abs(st.rotT-st.rot)>1e-4)moving=true}
    const fa=ease(acetateState.k,dt);acetateState.pos.lerp(acetateState.target,fa);acetateState.op+=(acetateState.opT-acetateState.op)*fa;
    acetate.position.copy(acetateState.pos);acetate.rotation.y=-.06;
    film.material.opacity=.34*acetateState.op;print.material.opacity=acetateState.op;
    if(acetateState.pos.distanceTo(acetateState.target)>1e-4||Math.abs(acetateState.opT-acetateState.op)>1e-3)moving=true;
    const fy=ease(6,dt);yaw+=(yawT-yaw)*fy;pitch+=(pitchT-pitch)*fy;rig.rotation.set(pitch,yaw,0);
    rig.position.set(0,0,0);if(Math.abs(yawT-yaw)>1e-4||Math.abs(pitchT-pitch)>1e-4)moving=true;
    rig.updateMatrixWorld();
    if(visible)renderer.render(s,camera);
    if(visible)placeTags();
    if(visible&&(moving||dragging))raf=requestAnimationFrame(frame);else last=0;
  }
  function invalidate(){if(!raf)raf=requestAnimationFrame(frame)}

  function resize(){const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
    if(mode==='lab')aimCamera(lab(camera.aspect),false);rig.updateMatrixWorld();renderer.render(s,camera);invalidate()}
  let mode='lab';
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(visible)invalidate()}).observe(host);
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();host.classList.remove('ready')});

  // Direct manipulation: drag turns the form, a click on a copy pulls it out.
  const ray=new THREE.Raycaster(),ptr=new THREE.Vector2();let down=null;
  canvas.addEventListener('pointerdown',e=>{if(mode!=='lab')return;down={x:e.clientX,y:e.clientY,yaw:yawT,pitch:pitchT,moved:false};canvas.setPointerCapture(e.pointerId)});
  canvas.addEventListener('pointermove',e=>{
    if(!down)return;const dx=e.clientX-down.x,dy=e.clientY-down.y;
    if(Math.abs(dx)+Math.abs(dy)>5){down.moved=true;dragging=true}
    if(down.moved){yawT=THREE.MathUtils.clamp(down.yaw+dx*.006,-.6,.6);pitchT=THREE.MathUtils.clamp(down.pitch+dy*.003,-.12,.18);invalidate()}
  });
  canvas.addEventListener('pointerup',e=>{
    const wasDrag=down?.moved;down=null;dragging=false;
    if(wasDrag||mode!=='lab')return;
    const r=canvas.getBoundingClientRect();ptr.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
    ray.setFromCamera(ptr,camera);
    const hit=ray.intersectObjects(TERMS.map(t=>layers[t.key].mesh))[0];
    if(hit)setState({term:hit.object.userData.term});
  });
  canvas.addEventListener('pointercancel',()=>{down=null;dragging=false});
  $('reset-view').onclick=()=>{yawT=0;pitchT=0;invalidate()};

  // Intro choreography. Each beat only moves targets, so skipping or resizing mid-beat is safe.
  function intro(){
    mode='intro';instant=false;tags.on=false;yaw=yawT=pitch=pitchT=0;
    const fx=FIXTURES[0],vals=termValues(fx);
    for(const t of TERMS)drawLayer(t,vals);drawTop(fx,null);
    introHint=true;drawAcetate('renewal',vals,null,true);
    current={caseIndex:0,term:null,result:null};
    for(const t of TERMS){const st=layerState[t.key];st.target.set(STACK_X,BASE_Y[t.key],0);st.pos.copy(st.target);st.rot=st.rotT=0;st.k=3.2}
    const parked=acetateHome();parked.y=2.8;
    acetateState.pos.copy(parked);acetateState.target.copy(parked);acetateState.op=acetateState.opT=0;
    aimCamera(poseA(camera.aspect),true);tCam.k=2.4;
    return {
      reveal(){layerState.renewal.target.set(PULL_X,.42,PULL_Z);layerState.renewal.rotT=-.04;aimCamera(poseB(camera.aspect),false)},
      compare(){acetateState.target.copy(acetateHome());acetateState.opT=1;acetateState.k=3.6;tCam.k=2.2;aimCamera(lab(camera.aspect),false)},
      finish(fast){mode='lab';introHint=false;tags.on=false;tCam.k=3;for(const t of TERMS)layerState[t.key].k=4;acetateState.k=4;acetateState.opT=1;
        if(fast){acetateState.op=1;acetateState.target.copy(acetateHome());acetateState.pos.copy(acetateState.target)}
        aimCamera(lab(camera.aspect),fast)},
    };
  }
  function setInstant(on){instant=on}
  resize();aimCamera(lab(camera.aspect),true);
  return {show,intro,setInstant,resize,get current(){return current}};
}
