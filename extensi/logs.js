'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const keys = ['questionSummaries', 'questionPreviews', 'agentLogs', 'agentDebugLogs', 'lastCapturedDebug'];
  let snapshot = {}; let selected = null; let signature = '';
  const labels = { success: 'Berhasil', error: 'Gagal', running: 'Berjalan' };
  const seconds = ms => Number.isFinite(ms) ? (ms / 1000).toFixed(1) + ' dtk' : '—';
  function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  function stages(row) { return (row.stages || []).filter(e => !$('stage').value || ($('stage').value === 'WARN' ? ['WARN','ERROR'].includes(e.level) : String(e.category).includes($('stage').value))); }
  function render() {
    const query = $('search').value.toLocaleLowerCase();
    const rows = (snapshot.questionSummaries || []).slice().reverse().filter(r => (!$('status').value || r.status === $('status').value) && (!query || [r.qNum,r.answer,r.choice,r.mode].join(' ').toLocaleLowerCase().includes(query)) && (!$('stage').value || stages(r).length));
    if (!selected && rows.length) selected = rows[0].id;
    const scrollTop = $('questions').scrollTop;
    $('questions').replaceChildren();
    for (const r of rows) {
      const button = node('button'); button.type = 'button'; button.setAttribute('aria-current', String(r.id === selected));
      const top = node('span', undefined, 'row'); top.append(node('strong', `Soal ${r.qNum}`), node('span', labels[r.status] || r.status, `status ${r.status}`));
      button.append(top, node('span', [r.choice,r.answer].filter(Boolean).join(' · ') || 'Menunggu jawaban…', 'answer-short'), node('small', `${r.mode || 'Memproses'} · ${seconds(r.totalDurationMs)}`));
      button.onclick = () => { selected = r.id; signature = ''; render(); }; $('questions').append(button);
    }
    $('questions').scrollTop = scrollTop;
    const row = (snapshot.questionSummaries || []).find(r => r.id === selected);
    if (!row) { if (selected) { $('detail').replaceChildren(node('h2', 'Ringkasan ini sudah tidak tersedia'), node('p', 'Riwayat menyimpan maksimal 50 soal terbaru. Pilih soal lain.')); } return; }
    const image = (snapshot.questionPreviews || []).find(p => p.id === row.id);
    const next = JSON.stringify([row,image,$('stage').value]);
    if (next === signature) return; signature = next;
    const detail = $('detail'); const open = detail.querySelector('details')?.open;
    detail.replaceChildren(node('h2', `Soal ${row.qNum}`), node('p', `${labels[row.status] || row.status} · ${row.mode || 'Memproses'} · ${new Date(row.startedAt).toLocaleString('id-ID')}`, 'muted'));
    const metrics = node('div', undefined, 'metrics');
    for (const [name,ms] of [['Total',row.totalDurationMs],['AI server',row.timings?.aiMs],['OCR server',row.timings?.ocrMs],['Pencarian bank',row.timings?.databaseMs]]) { const metric = node('div'); metric.append(node('strong',seconds(ms)),node('span',name)); metrics.append(metric); }
    detail.append(metrics, node('div', [row.choice,row.answer].filter(Boolean).join('\n') || 'Belum ada jawaban.', 'answer'));
    if (image && /^data:image\/(png|jpeg|webp);base64,/.test(image.dataUrl) && image.dataUrl.length <= 200*1024) { const img = node('img',undefined,'thumbnail'); img.alt = 'Preview area soal, klik untuk memperbesar'; img.src = image.dataUrl; img.tabIndex = 0; const show = () => { $('largeImage').src = image.dataUrl; $('preview').showModal(); }; img.onclick = show; img.onkeydown = e => { if (e.key === 'Enter') show(); }; detail.append(img); }
    detail.append(node('h3', 'Tahapan proses'));
    const list = node('ol'); for (const event of stages(row).filter(e => e.category !== 'NETWORK')) { const li = node('li'); li.append(node('span',new Date(event.iso).toLocaleTimeString('id-ID'),'time'),node('span',event.message)); list.append(li); } detail.append(list);
    const technical = node('details'); technical.open = !!open; technical.append(node('summary','Detail teknis'),node('pre',JSON.stringify(row,null,2))); detail.append(technical);
  }
  const load = () => chrome.storage.local.get(keys, data => { snapshot = data; render(); });
  $('search').oninput = render; $('status').onchange = render; $('stage').onchange = render;
  $('refresh').onclick = load; $('theme').onclick = () => window.KamusMiniTheme?.toggleCycle();
  $('closePreview').onclick = () => $('preview').close();
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(snapshot,null,2)); $('feedback').textContent = 'Log disalin.'; } catch { $('feedback').textContent = 'Penyalinan gagal; gunakan Ekspor.'; } };
  $('export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'})); const link = node('a'); link.href = url; link.download = 'kamus-mini-logs.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
  $('clear').onclick = () => { if (!confirm('Hapus riwayat lokal dan preview? Sumber Cloud yang sudah tersimpan tetap ada di server.')) return; chrome.storage.local.remove(keys, () => { snapshot = {}; selected = null; signature = ''; $('detail').replaceChildren(node('h2','Riwayat lokal dihapus')); render(); }); };
  chrome.storage.onChanged.addListener((changes, area) => { if (area !== 'local') return; for (const key of keys) if (changes[key]) snapshot[key] = changes[key].newValue; render(); });
  load();
});
