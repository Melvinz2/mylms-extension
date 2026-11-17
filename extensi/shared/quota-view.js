(function (global) {
  'use strict';
  const format = new Intl.NumberFormat('id-ID');
  const css = `.quota-meter{margin:14px 0;font:12px/1.5 system-ui,sans-serif}.quota-meter-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:7px}.quota-meter-value{color:var(--quota-accent,#a2cab9);font-variant-numeric:tabular-nums;font-weight:600}.quota-track{height:5px;background:var(--quota-track,#ffffff12);border-radius:9px;overflow:hidden}.quota-fill{height:100%;background:var(--quota-accent,#a2cab9);border-radius:9px;transition:width .2s}.quota-note{font-size:10px;color:var(--quota-muted,#94a39d);margin-top:5px;text-align:right}.quota-info{font:11px/1.5 system-ui,sans-serif;color:var(--quota-muted,#94a39d);margin:10px 0}`;
  function relative(value) {
    const ms = new Date(value).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    return minutes < 60 ? `${minutes} menit` : minutes < 1440 ? `${Math.floor(minutes/60)} jam ${minutes%60} menit` : `${Math.floor(minutes/1440)} hari ${Math.floor(minutes%1440/60)} jam`;
  }
  function render(container, state) {
    const doc = container.ownerDocument;
    const make = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
    container.replaceChildren();
    const style = make('style'); style.textContent = css; container.append(style);
    if (!state?.data) { container.append(make('p', state?.status === 'disconnected' ? 'Hubungkan Cloud di pengaturan.' : state?.status === 'error' ? 'Kuota belum dapat dimuat.' : 'Memuat kuota…', 'quota-info')); return; }
    const data = state.data;
    function meter(label, value, total, suffix, reset, percent = false) {
      const valid = Number.isFinite(value) && Number.isFinite(total) && total > 0;
      const row = make('div', undefined, 'quota-meter'); const head = make('div', undefined, 'quota-meter-head');
      const numeric = `${format.format(value ?? 0)}/${format.format(total ?? 0)}`;
      const display = percent && valid ? `${Math.round(Math.max(0,Math.min(100,value/total*100)))}% tersisa` : `${numeric} ${suffix}`;
      head.append(make('span', label), make('span', display, 'quota-meter-value'));
      row.append(head);
      if (valid) { const track = make('div', undefined, 'quota-track'); track.setAttribute('role','progressbar'); track.setAttribute('aria-label', label); track.setAttribute('aria-valuemin','0'); track.setAttribute('aria-valuemax',String(total)); track.setAttribute('aria-valuenow',String(Math.max(0,Math.min(total,value)))); const fill = make('div',undefined,'quota-fill'); fill.style.width = `${Math.max(0,Math.min(100,value/total*100))}%`; track.append(fill); row.append(track); }
      const note = [percent ? `${numeric} tersisa` : '', reset].filter(Boolean).join(' · ');
      if (note) row.append(make('div', note, 'quota-note')); container.append(row);
    }
    meter('Permintaan per menit',data.remainingThisMinute,data.requestsPerMinute,'tersedia',data.nextAvailableAt ? `Slot berikutnya dalam ${relative(data.nextAvailableAt)}` : 'Semua slot tersedia');
    meter('Sedang diproses',data.activeRequests,data.concurrentLimit,'aktif');
    const quota = data.quota || {};
    const resetTime = quota.nextResetAt ? relative(quota.nextResetAt) : '';
    const reset = resetTime ? `Reset dalam ${resetTime}` : '';
    if (quota.remainingRequests != null) meter('Permintaan akun',quota.remainingRequests,quota.effectiveMaxRequests,'tersisa',reset,true);
    if (quota.remainingTokens != null) meter('Token akun',quota.remainingTokens,quota.effectiveMaxTokens,'tersisa',reset,true);
    if (quota.remainingRequests == null && quota.remainingTokens == null) container.append(make('p','Kuota akun tanpa batas','quota-info'));
    if (state.stale || state.status === 'error') container.append(make('p','Data terakhir · koneksi belum diperbarui','quota-info'));
  }
  global.KamusQuotaView = { render };
})(typeof window !== 'undefined' ? window : self);
