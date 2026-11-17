(function (global) {
  'use strict';
  let host, shadow, body, port, observer, scanTimer, quizTimer, position = null, minimized = false, enabled = false, captureDepth = 0;
  let drag = null;
  function quizPresent() {
    if (typeof global.isManagedByTopFrame === 'function' && global.isManagedByTopFrame()) return false;
    return typeof global.getQuizDocument === 'function' && Boolean(global.getQuizDocument());
  }
  function clampPosition(x, y, width, height, viewportWidth = innerWidth, viewportHeight = innerHeight) {
    return { x:Math.max(8,Math.min(x,Math.max(8,viewportWidth-width-8))), y:Math.max(8,Math.min(y,Math.max(8,viewportHeight-height-8))) };
  }
  function place() {
    if (!host) return;
    const rect = host.getBoundingClientRect();
    position = clampPosition(position?.x ?? innerWidth-rect.width-20, position?.y ?? innerHeight-rect.height-20, rect.width, rect.height);
    host.style.left = position.x + 'px'; host.style.top = position.y + 'px';
  }
  function destroy() {
    const previous = port; port = null; previous?.disconnect();
    host?.remove(); host = shadow = body = null; drag = null;
  }
  function build() {
    host = document.createElement('div'); host.id = 'kamus-mini-quota-overlay';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;width:min(290px,calc(100vw - 16px));display:block;';
    shadow = host.attachShadow({mode:'closed'});
    const style = document.createElement('style'); style.textContent = `:host{--quota-accent:#a2cab9;--quota-track:#ffffff12;--quota-muted:#94a39d}.card{background:#19221e;color:#eef5f0;border:1px solid #3a4840;border-radius:12px;box-shadow:0 8px 32px #0003;font:12px/1.5 system-ui,sans-serif;padding:0 14px 4px}.card.light{background:#fff;color:#18271f;border-color:#ccd8d1;--quota-accent:#397b64;--quota-track:#e8efeb;--quota-muted:#586c61}header{display:flex;align-items:center;gap:7px;padding:11px 0;cursor:grab;touch-action:none;user-select:none}header:active{cursor:grabbing}strong{flex:1;font-size:12px}button{border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;font:16px system-ui;padding:1px 5px}button:hover{background:#879b8b25}button:focus-visible,header:focus-visible{outline:2px solid var(--quota-accent);outline-offset:2px}.retry{font-size:11px;border:1px solid #75887b66;padding:4px 8px;margin-bottom:8px}[hidden]{display:none!important}`;
    const card = document.createElement('section'); card.className = 'card'; card.setAttribute('aria-label','Kuota Kamus Mini Cloud');
    chrome.storage.local.get(['uiTheme'], state => { if (state.uiTheme === 'light' || state.uiTheme !== 'dark' && matchMedia('(prefers-color-scheme:light)').matches) card.classList.add('light'); });
    const header = document.createElement('header'); header.tabIndex = 0; header.setAttribute('aria-label','Geser tracker kuota dengan tombol panah');
    const title = document.createElement('strong'); title.textContent = 'Kuota Cloud';
    const collapse = document.createElement('button'); collapse.type = 'button'; collapse.setAttribute('aria-label','Minimalkan tracker'); collapse.textContent = '−';
    const close = document.createElement('button'); close.type = 'button'; close.setAttribute('aria-label','Tutup tracker'); close.textContent = '×';
    body = document.createElement('div'); body.hidden = minimized;
    let lastState;
    const readout = document.createElement('div'); const retry = document.createElement('button'); retry.className = 'retry'; retry.textContent = 'Coba lagi'; retry.hidden = true;
    body.append(readout, retry); header.append(title,collapse,close); card.append(header,body); shadow.append(style,card); document.documentElement.append(host);
    collapse.onclick = () => { minimized = !minimized; body.hidden = minimized; collapse.textContent = minimized ? '+' : '−'; collapse.setAttribute('aria-label',minimized ? 'Buka tracker' : 'Minimalkan tracker'); chrome.storage.local.set({quotaOverlayMinimized:minimized}); if(minimized){const previous=port;port=null;previous?.disconnect();}else connect(); place(); };
    close.onclick = () => chrome.storage.local.set({quotaOverlayEnabled:false});
    retry.onclick = () => { if(lastState?.status==='disconnected'){chrome.runtime.sendMessage({action:'openOptions'});return;} if (port) port.postMessage({action:'refresh'}); else connect(); };
    header.onpointerdown = event => { if (event.target.closest('button') || event.button !== 0) return; const rect=host.getBoundingClientRect(); drag={id:event.pointerId,x:event.clientX-rect.left,y:event.clientY-rect.top}; header.setPointerCapture(event.pointerId); event.preventDefault(); };
    header.onpointermove = event => { if (!drag || event.pointerId !== drag.id) return; position={x:event.clientX-drag.x,y:event.clientY-drag.y}; place(); };
    const finishDrag = () => { if (drag) {drag=null;chrome.storage.local.set({quotaOverlayPosition:position});} };
    header.onpointerup = finishDrag; header.onpointercancel = finishDrag;
    header.onkeydown = event => { const vectors={ArrowLeft:[-12,0],ArrowRight:[12,0],ArrowUp:[0,-12],ArrowDown:[0,12]}; const vector=vectors[event.key]; if (!vector || event.target !== header) return; event.preventDefault(); position={x:position.x+vector[0],y:position.y+vector[1]};place();chrome.storage.local.set({quotaOverlayPosition:position}); };
    function connect() {
      if (port || !host) return;
      KamusQuotaView.render(readout,{status:'loading'});
      port=chrome.runtime.connect({name:'kamus-usage'});
      port.onMessage.addListener(state => { if (!host) return; lastState=state;KamusQuotaView.render(readout,state);retry.hidden=!['error','disconnected'].includes(state.status);retry.textContent=state.status==='disconnected'?'Hubungkan Cloud':'Coba lagi';place(); });
      port.onDisconnect.addListener(() => { port=null; if(host) retry.hidden=false; });
    }
    if(!minimized) connect(); place(); if(captureDepth) host.style.visibility='hidden';
  }
  function scan() {
    if (!enabled || document.visibilityState === 'hidden' || !quizPresent()) { destroy(); return; }
    if (!host) build();
  }
  function schedule() { clearTimeout(scanTimer);scanTimer=setTimeout(scan,200); }
  function monitor() {
    observer?.disconnect(); clearInterval(quizTimer); clearTimeout(scanTimer);
    if (enabled) {
      // Frame content can change without a mutation in the parent document.
      quizTimer=setInterval(scan,2000);
      observer=new MutationObserver(schedule);
      observer.observe(document.documentElement,{childList:true,subtree:true});
    }
    scan();
  }
  function start() {
    chrome.storage.local.get(['quotaOverlayEnabled','quotaOverlayPosition','quotaOverlayMinimized'], state => {
      enabled=state.quotaOverlayEnabled===true; minimized=state.quotaOverlayMinimized===true;
      const saved=state.quotaOverlayPosition;if(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position=saved;
      monitor();
    });
    document.addEventListener('load',schedule,true);
  }
  chrome.storage.onChanged.addListener((changes,area) => { if(area!=='local')return; if(changes.quotaOverlayEnabled){enabled=changes.quotaOverlayEnabled.newValue===true;monitor();} if(changes.uiTheme && shadow){const value=changes.uiTheme.newValue;shadow.querySelector('.card').classList.toggle('light',value==='light'||value!=='dark'&&matchMedia('(prefers-color-scheme:light)').matches);} });
  window.addEventListener('resize',place); document.addEventListener('visibilitychange',scan);
  window.addEventListener('pagehide',()=>{observer?.disconnect();clearTimeout(scanTimer);clearInterval(quizTimer);destroy();});
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
  global.KamusQuotaOverlay={ clampPosition, beginCapture(){captureDepth++;if(host)host.style.visibility='hidden';}, endCapture(){captureDepth=Math.max(0,captureDepth-1);if(host && !captureDepth)host.style.visibility='visible';} };
})(window);
