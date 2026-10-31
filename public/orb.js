// Samantha's orb: a sphere holding a sky and a bank of cloud, drawn on the GPU.
// One shader serves every size, from the header dot to the voice view. The clouds
// are volumetric noise (not drawn shapes), lit from the upper left so they have
// bright tops and sky-coloured undersides, inside a matte sphere with a soft shadow.
//
//   const orb=createOrb(canvas); orb.frame({...state}); orb.resize(devicePixels);
//
// frame(state) fields (all optional, sensible defaults):
//   t            seconds, drives drift and the slow breathing
//   skyTop, skyHorizon, cloud, paper   [r,g,b] 0..255
//   line         cloud line in orb units, +down (0 = centre, .15 = a little below)
//   drift,churn  accumulated motion phases (advance them yourself so speed can vary)
//   swell        0..1, her voice: clouds lift and billow
//   veil         0..1, your voice: a cool haze settles over the sky
//   glow         0..1, awake / thinking: the sky brightens from within
//   dim          0..1, out of reach: colour drains and the sphere goes flat
//   finger       [x,y] orb units or null: a touch warms the cloud where it lands
//   scale        sphere radius multiplier (breathing)
const VERT=`attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;
const FRAG=`precision highp float;
uniform vec2 uRes;uniform float uT,uLine,uDrift,uChurn,uSwell,uVeil,uGlow,uDim,uScale,uPx;
uniform vec3 uSkyTop,uSkyHorizon,uCloud,uPaper;uniform vec2 uFinger;uniform float uHasFinger;
float hash(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.07+vec3(1.7,9.2,3.1);a*=.5;}return v;}
void main(){
  vec2 p=(gl_FragCoord.xy/uRes*2.-1.)/(.78*uScale);
  float r=length(p);
  // paper and the sphere's shadow, pooled a little below it
  float sh=smoothstep(1.32,.9,length((p-vec2(0.,-.14))*vec2(1.,1.12)));
  vec3 bg=mix(uPaper,uPaper*vec3(.86,.82,.78)*.98+uSkyTop*.06,sh*.55*(1.-uDim*.5));
  if(r>1.+uPx*2.){gl_FragColor=vec4(bg,1.);return;}
  float z=sqrt(max(0.,1.-r*r));vec3 n=vec3(p,z);
  // sky inside the sphere: deep above, pale toward the cloud line, a touch of the horizon colour low down
  float lineY=-uLine+uSwell*.12;
  // the bank's top wanders: big slow swells so it never reads as a straight band
  lineY+=(noise(vec3(n.x*1.4+uDrift*.6,.37,uChurn*.09))-.5)*.5+(noise(vec3(n.x*3.1+uDrift*.9,2.1,uChurn*.13))-.5)*.18;
  vec3 sky=mix(uSkyHorizon,uSkyTop,smoothstep(lineY-.15,1.05,p.y));
  sky=mix(sky,sky*1.07+.03,uGlow*.8);
  // cloud: fbm on the sphere surface so it wraps; a slow warp keeps the masses billowing
  vec3 q=vec3(n.x*1.6+uDrift,n.y*1.9,n.z*1.1+uChurn*.16);
  float warp=fbm(q*.7+vec3(0.,uChurn*.06,0.));
  q+=(warp-.5)*.7;
  float f=fbm(q*1.15);
  // a solid bank below the line, cauliflower tops at it, a few loose puffs above
  float profile=smoothstep(lineY+.4,lineY-.28,p.y);
  float dens=f+profile*.5+uSwell*.05;
  float a=smoothstep(.55,.68,dens);
  a*=smoothstep(1.02,.88,r*(1.-profile*.5));                   // thin out against the rim so the sphere reads
  // lighting: the same field sampled toward the light tells tops from undersides
  vec3 L=normalize(vec3(-.42,.72,.56));
  float f2=fbm((q+vec3(-.09,.16,.04))*1.15);
  float lit=clamp(.6+(f2-f)*mix(7.,3.5,profile)+(1.-profile)*.25,0.,1.);
  float under=smoothstep(lineY-.05,lineY-.7,p.y);              // the bank's belly takes a little of the sky
  vec3 shade=mix(uCloud*.86,uSkyHorizon,.3);
  vec3 cloudCol=mix(shade,uCloud,lit*(1.-under*.22));
  cloudCol=mix(cloudCol,cloudCol*1.06,a*uGlow*.5);
  vec3 col=mix(sky,cloudCol,a);
  if(uHasFinger>.5){float warm=smoothstep(.55,0.,length(p-uFinger));col=mix(col,uCloud,warm*.35*a+warm*.12);}
  // the sphere: soft lambert from the upper left, a darker rim, a quiet sheen
  float lam=max(0.,dot(n,L));
  col*=.86+.2*lam;
  col*=1.-.26*pow(1.-z,2.4);
  col+=vec3(.05)*pow(max(0.,dot(reflect(-L,n),vec3(0.,0.,1.))),60.);
  // your voice: a cool haze over everything
  col=mix(col,mix(col,vec3(.79,.84,.93),.5),uVeil);
  // out of reach: colour drains, light flattens
  float lum=dot(col,vec3(.3,.59,.11));
  col=mix(col,mix(vec3(lum),uPaper,.25),uDim*.75);
  float edge=1.-smoothstep(1.-uPx*1.2,1.+uPx*.8,r);
  gl_FragColor=vec4(mix(bg,col,edge),1.);
}`;
const c255=v=>[v[0]/255,v[1]/255,v[2]/255];
export function createOrb(canvas){
  const gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
  if(!gl)return null;
  const compile=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
  let program,U={};
  // Everything the GPU holds is rebuilt here, because iOS throws it away when the app is backgrounded
  // (webglcontextlost) and hands back an empty context on return (webglcontextrestored).
  function setup(){
    program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,VERT));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAG));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(program,'a');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    U={};for(const name of ['uRes','uT','uLine','uDrift','uChurn','uSwell','uVeil','uGlow','uDim','uScale','uPx','uSkyTop','uSkyHorizon','uCloud','uPaper','uFinger','uHasFinger'])U[name]=gl.getUniformLocation(program,name);
  }
  try{setup();}catch(error){console.warn('orb shader',error.message);return null;}
  let size=0,lost=false,lostAt=0;
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;lostAt=Date.now();});
  canvas.addEventListener('webglcontextrestored',()=>{try{setup();const px=size;size=0;if(px)gl.viewport(0,0,px,px),size=px;lost=false;}catch(error){console.warn('orb restore',error.message);}});
  return {
    get lost(){return lost;},
    get lostAt(){return lostAt;},
    // True when the context went away and did not come back (iOS often never restores a backgrounded page's context).
    get dead(){return lost||gl.isContextLost();},
    resize(px){px=Math.max(8,Math.round(px));if(px!==size){size=canvas.width=canvas.height=px;gl.viewport(0,0,px,px);}return size;},
    frame(s={}){
      if(lost||!size)return;
      gl.useProgram(program);
      gl.uniform2f(U.uRes,size,size);gl.uniform1f(U.uT,s.t??0);
      gl.uniform1f(U.uLine,s.line??.12);gl.uniform1f(U.uDrift,s.drift??0);gl.uniform1f(U.uChurn,s.churn??0);
      gl.uniform1f(U.uSwell,s.swell??0);gl.uniform1f(U.uVeil,s.veil??0);gl.uniform1f(U.uGlow,s.glow??0);gl.uniform1f(U.uDim,s.dim??0);
      const scale=s.scale??1;gl.uniform1f(U.uScale,scale);gl.uniform1f(U.uPx,2/(size*.78*scale));
      gl.uniform3fv(U.uSkyTop,c255(s.skyTop??[206,96,66]));gl.uniform3fv(U.uSkyHorizon,c255(s.skyHorizon??[242,176,138]));
      gl.uniform3fv(U.uCloud,c255(s.cloud??[255,249,240]));gl.uniform3fv(U.uPaper,c255(s.paper??[246,241,234]));
      gl.uniform2f(U.uFinger,s.finger?.[0]??0,s.finger?.[1]??0);gl.uniform1f(U.uHasFinger,s.finger?1:0);
      gl.drawArrays(gl.TRIANGLES,0,3);
    },
    destroy(){try{gl.getExtension('WEBGL_lose_context')?.loseContext();}catch{}}
  };
}
