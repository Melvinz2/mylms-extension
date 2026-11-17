'use strict';

(() => {
  const button = document.getElementById('btnUsage');
  const panel = document.getElementById('usagePanel');
  const readout = document.getElementById('usageReadout');
  const retry = document.getElementById('btnUsageRetry');
  const number = new Intl.NumberFormat('id-ID');
  let generation = 0;
  let timer;

  const count = value => value == null ? 'Tanpa batas' : number.format(value);

  async function refresh(showLoading = false) {
    const current = ++generation;
    clearTimeout(timer);
    retry.hidden = true;
    if (showLoading) readout.textContent = 'Memuat penggunaan…';
    try {
      const { apiKey } = await chrome.storage.local.get('apiKey');
      if (panel.hidden || current !== generation) return;
      if (!apiKey?.trim()) {
        readout.textContent = 'Belum terhubung. Atur API key Cloud di Pengaturan.';
        return;
      }
      const data = await KamusMiniCloud.getMyAiUsage(apiKey.trim());
      if (panel.hidden || current !== generation) return;
      const { quota } = data;
      const lines = [
        `Tersedia: ${count(data.remainingThisMinute)} dari ${count(data.requestsPerMinute)} per menit`,
        `Diproses: ${count(data.activeRequests)} dari maksimal ${count(data.concurrentLimit)} sekaligus`,
        `Kuota akun: ${count(quota.remainingRequests)} permintaan · ${count(quota.remainingTokens)} token`,
      ];
      if (quota.nextResetAt) lines.push(`Reset ${new Date(quota.nextResetAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
      const next = lines.join('\n');
      if (readout.textContent !== next) readout.textContent = next;
      timer = setTimeout(refresh, 10000);
    } catch {
      if (panel.hidden || current !== generation) return;
      readout.textContent = 'Gagal memuat penggunaan AI.';
      retry.hidden = false;
    }
  }

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) {
      ++generation;
      clearTimeout(timer);
    } else {
      void refresh(true);
    }
  });
  retry.addEventListener('click', () => void refresh(true));
})();
