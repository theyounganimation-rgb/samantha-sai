// Appearance (Owner, October 25, 2026): follow the system, or force light/dark from Settings. Runs before first paint.
(function(){
 var KEY='sai-theme',root=document.documentElement,media=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;
 function saved(){try{var v=localStorage.getItem(KEY);return v==='light'||v==='dark'?v:'system';}catch(e){return 'system';}}
 function effective(){var v=saved();return v==='system'?(media&&media.matches?'dark':'light'):v;}
 function apply(){var v=saved();if(v==='system')root.removeAttribute('data-theme');else root.setAttribute('data-theme',v);
  var dark=effective()==='dark';var meta=document.querySelector('meta[name=theme-color]');if(meta)meta.setAttribute('content',dark?'#17130f':'#f6f1ea');
  var bar=document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]');if(bar)bar.setAttribute('content',dark?'black-translucent':'default');
  var select=document.getElementById('theme-select');if(select&&select.value!==v)select.value=v;
  try{window.dispatchEvent(new CustomEvent('sai-theme',{detail:{theme:v,effective:effective()}}));}catch(e){}
  try{window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.sai&&window.webkit.messageHandlers.sai.postMessage({event:'theme',theme:v,effective:effective()});}catch(e){}
 }
 window.saiTheme={get:saved,effective:effective,set:function(v){try{v==='system'?localStorage.removeItem(KEY):localStorage.setItem(KEY,v);}catch(e){}apply();}};
 apply();
 if(media&&media.addEventListener)media.addEventListener('change',apply);
 document.addEventListener('DOMContentLoaded',function(){var select=document.getElementById('theme-select');if(select){select.value=saved();select.addEventListener('change',function(){window.saiTheme.set(select.value);});}apply();});
})();
