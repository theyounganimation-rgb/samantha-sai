const photoURL=url=>typeof url==='string'&&/^\/api\/media\/[a-f0-9]{64}$/.test(url);
let viewer;
function photoViewer(){
  if(viewer)return viewer;
  const dialog=document.createElement('dialog');dialog.className='photo-viewer';dialog.setAttribute('aria-label','Full-size photo');
  const header=document.createElement('div');header.className='photo-viewer-header';
  const title=document.createElement('span');title.textContent='Photo';
  const zoom=document.createElement('button');zoom.type='button';zoom.className='photo-viewer-control';zoom.textContent='Zoom in';
  const close=document.createElement('button');close.type='button';close.className='photo-viewer-control';close.textContent='Done';close.setAttribute('aria-label','Close photo');
  const stage=document.createElement('div');stage.className='photo-viewer-stage';stage.tabIndex=0;stage.setAttribute('aria-label','Photo; zoom in to pan');
  const image=document.createElement('img');image.draggable=false;stage.append(image);header.append(title,zoom,close);dialog.append(header,stage);document.body.append(dialog);
  const toggleZoom=()=>{const enlarged=dialog.classList.toggle('zoomed');zoom.textContent=enlarged?'Fit photo':'Zoom in';zoom.setAttribute('aria-pressed',String(enlarged));};
  zoom.onclick=toggleZoom;image.ondblclick=toggleZoom;close.onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{image.removeAttribute('src');dialog.classList.remove('zoomed');});
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  viewer={dialog,image,zoom,stage};return viewer;
}
function openPhoto(photo){
  document.activeElement?.blur();
  const v=photoViewer();v.image.src=photo.url;v.image.alt=photo.alt||'Photo from Samantha';v.image.width=photo.width;v.image.height=photo.height;
  v.zoom.textContent='Zoom in';v.zoom.setAttribute('aria-pressed','false');v.dialog.classList.remove('zoomed');v.dialog.showModal();v.stage.scrollTop=0;v.stage.scrollLeft=0;
}

// Keep loaded cards in place across history updates. Intrinsic dimensions reserve
// their space, so a late image load doesn't reorder bubbles or jump the thread.
export function setMessageMedia(wrap,items=[],{onLayout=()=>{}}={}) {
  const photos=items.filter(p=>photoURL(p.url)&&(p.type==='audio'||p.type==='image'&&Number.isInteger(p.width)&&p.width>0&&Number.isInteger(p.height)&&p.height>0));
  const signature=JSON.stringify(photos);if(wrap.dataset.mediaSignature===signature)return;
  wrap.dataset.mediaSignature=signature;wrap.classList.toggle('has-media',!!photos.length);
  let gallery=wrap.querySelector('.message-media');
  if(!photos.length){gallery?.querySelectorAll('audio').forEach(a=>a.pause());gallery?.remove();return;}
  if(!gallery){gallery=document.createElement('div');gallery.className='message-media';wrap.append(gallery);}
  const old=new Map([...gallery.children].map(n=>[n.dataset.mediaId,n])),cards=[];
  for(const photo of photos){
    const key=photo.id||photo.url;let card=old.get(key);
    if(photo.type==='audio'){
      if(!card){
        card=document.createElement('section');card.className='message-audio';card.dataset.mediaId=key;
        const title=document.createElement('div');title.className='audio-title';
        const name=String(photo.fileName||'Audio from Samantha').replace(/\.[a-z0-9]{1,5}$/i,'').replace(/[_-]+/g,' ');
        title.textContent=name.charAt(0).toUpperCase()+name.slice(1);
        const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.setAttribute('playsinline','');audio.setAttribute('aria-label',title.textContent);
        const status=document.createElement('button');status.type='button';status.className='audio-retry';status.hidden=true;status.textContent='Audio unavailable · tap to retry';
        audio.onerror=()=>{status.hidden=false;onLayout();};audio.onloadedmetadata=()=>{status.hidden=true;onLayout();};
        audio.onplay=()=>document.querySelectorAll('.message-audio audio').forEach(other=>{if(other!==audio)other.pause();});
        status.onclick=()=>{status.hidden=true;audio.load();audio.play().catch(()=>{status.hidden=false;});};
        audio.src=photo.url;card.append(title,audio,status);
      }
      cards.push(card);continue;
    }
    if(!card){
      card=document.createElement('button');card.type='button';card.className='message-photo';card.dataset.mediaId=key;card.dataset.state='loading';card.style.aspectRatio=photo.width+' / '+photo.height;
      card.setAttribute('aria-label','Open photo');
      const image=document.createElement('img');image.width=photo.width;image.height=photo.height;image.alt=photo.alt||'Photo from Samantha';image.loading='lazy';image.decoding='async';image.draggable=false;
      const status=document.createElement('span');status.className='photo-status';status.textContent='Loading photo…';
      const affordance=document.createElement('span');affordance.className='photo-open';affordance.textContent='View photo';affordance.setAttribute('aria-hidden','true');
      card.append(image,status,affordance);
      image.onload=()=>{card.dataset.state='ready';status.hidden=true;card.setAttribute('aria-label','Open photo');onLayout();};
      image.onerror=()=>{card.dataset.state='error';status.hidden=false;status.textContent='Photo unavailable · tap to retry';card.setAttribute('aria-label','Retry loading photo');};
      card.onclick=()=>{if(card.dataset.state==='error'){card.dataset.state='loading';status.textContent='Loading photo…';image.src=photo.url+'?retry='+Date.now();}else openPhoto(photo);};
      image.src=photo.url;
    }
    cards.push(card);
  }
  for(const card of [...gallery.children])if(!cards.includes(card)){card.querySelector('audio')?.pause();card.remove();}
  let cursor=gallery.firstChild;for(const card of cards){if(card!==cursor)gallery.insertBefore(card,cursor);cursor=card.nextSibling;}
}
