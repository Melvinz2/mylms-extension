'use strict';
(() => {
  const button = document.getElementById('btnUsage');
  const panel = document.getElementById('usagePanel');
  const readout = document.getElementById('usageReadout');
  const retry = document.getElementById('btnUsageRetry');
  const toggle = document.getElementById('quotaOverlayToggle');
  let port = null;
  let lastState;
  function open() {
    if (port) return;
    KamusQuotaView.render(readout, {status:'loading'});
    port = chrome.runtime.connect({name:'kamus-usage'});
    port.onMessage.addListener(state => {
      lastState = state;
      KamusQuotaView.render(readout, state);
      retry.hidden = !['error','disconnected'].includes(state.status);
      retry.textContent = state.status === 'disconnected' ? 'Hubungkan Cloud' : 'Coba lagi';
    });
    port.onDisconnect.addListener(() => { port = null; if (!panel.hidden) { retry.hidden = false; } });
  }
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) { const previous = port; port = null; previous?.disconnect(); }
    else open();
  });
  retry.addEventListener('click', () => { if(lastState?.status === 'disconnected'){chrome.runtime.openOptionsPage();return;} if (port) port.postMessage({action:'refresh'}); else open(); });
  toggle.addEventListener('change', () => chrome.storage.local.set({quotaOverlayEnabled:toggle.checked}));
  chrome.storage.local.get(['quotaOverlayEnabled'], state => { toggle.checked = state.quotaOverlayEnabled === true; });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.quotaOverlayEnabled) toggle.checked = changes.quotaOverlayEnabled.newValue === true; });
  window.addEventListener('pagehide', () => { port?.disconnect(); port = null; });
})();
