document.addEventListener('DOMContentLoaded', () => {
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  const themeIcon = document.getElementById('themeIcon');

  const captureAlert = document.getElementById('captureAlert');
  const captureMeta = document.getElementById('captureMeta');
  const previewBox = document.getElementById('previewBox');
  const captureExtra = document.getElementById('captureExtra');
  const ocrPreviewSection = document.getElementById('ocrPreviewSection');
  const ocrModeBadge = document.getElementById('ocrModeBadge');
  const ocrDiagramThumbs = document.getElementById('ocrDiagramThumbs');
  const ocrMarkdownBox = document.getElementById('ocrMarkdownBox');
  const aiReasoningSection = document.getElementById('aiReasoningSection');
  const aiReasoningBadge = document.getElementById('aiReasoningBadge');
  const aiAnswerBanner = document.getElementById('aiAnswerBanner');
  const aiReasoningBox = document.getElementById('aiReasoningBox');
  const logList = document.getElementById('logList');
  const logCount = document.getElementById('logCount');
  const filterBar = document.getElementById('filterBar');

  const btnCopyAll = document.getElementById('btnCopyAll');
  const btnDownloadTxt = document.getElementById('btnDownloadTxt');
  const btnRefresh = document.getElementById('btnRefresh');
  const btnClearAll = document.getElementById('btnClearAll');

  let activeFilter = 'ALL';
  let latestSnapshot = { agentLogs: [], agentDebugLogs: [], lastCapturedDebug: null };

  // THEME TOGGLE
  function updateThemeIcon() {
    if (!themeIcon || !window.KamusMiniTheme) return;
    const isDark = window.KamusMiniTheme.getEffectiveTheme() === 'dark';
    if (isDark) {
      themeIcon.innerHTML = `
        <circle cx="12" cy="12" r="5"></circle>
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path>
      `;
      if (btnThemeToggle) btnThemeToggle.title = 'Ganti ke Mode Terang';
    } else {
      themeIcon.innerHTML = `
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      `;
      if (btnThemeToggle) btnThemeToggle.title = 'Ganti ke Mode Gelap';
    }
  }

  if (btnThemeToggle && window.KamusMiniTheme) {
    btnThemeToggle.addEventListener('click', () => {
      window.KamusMiniTheme.toggleCycle();
      updateThemeIcon();
    });
    window.KamusMiniTheme.onChange(updateThemeIcon);
    updateThemeIcon();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatReportText(data) {
    const cap = data.lastCapturedDebug ? { ...data.lastCapturedDebug } : null;
    if (cap && cap.dataUrlPreview) {
      cap.dataUrlPreview = `[data:image/png;base64 omitted, len=${cap.dataUrlPreview.length}]`;
    }
    if (cap && Array.isArray(cap.ocrDiagramPreviews)) {
      cap.ocrDiagramPreviews = cap.ocrDiagramPreviews.map(item => ({
        ...item,
        dataUrl: item.dataUrl ? `[omitted, len=${item.dataUrl.length}]` : null
      }));
    }
    return [
      '=== KAMUS MINI FULL DIAGNOSTIC REPORT ===',
      `Exported: ${new Date().toISOString()}`,
      '',
      '--- LAST CAPTURED SCREENSHOT DEBUG ---',
      JSON.stringify(cap, null, 2),
      '',
      '--- STRUCTURED DIAGNOSTIC TIMELINE ---',
      ...(data.agentDebugLogs || []).map(item =>
        `[${item.ts}] [${item.frame}] [${item.category}] [${item.level}] ${item.message}${item.data ? '\n  DATA: ' + JSON.stringify(item.data) : ''}`
      ),
      '',
      '--- POPUP ACTIVITY LOGS ---',
      ...(data.agentLogs || [])
    ].join('\n');
  }

  function renderCapturePreview(cap) {
    if (!cap) {
      captureAlert.style.display = 'none';
      captureMeta.innerHTML = `
        <div class="meta-item"><span class="meta-label">Status</span><span class="meta-val">Belum ada</span></div>
        <div class="meta-item"><span class="meta-label">Dimensi</span><span class="meta-val">-</span></div>
        <div class="meta-item"><span class="meta-label">Ukuran / Slice</span><span class="meta-val">-</span></div>
        <div class="meta-item"><span class="meta-label">Piksel Non-Putih</span><span class="meta-val">-</span></div>
      `;
      previewBox.innerHTML = '<span class="empty-note">Belum ada gambar yang ditangkap.</span>';
      captureExtra.textContent = '';
      if (ocrPreviewSection) ocrPreviewSection.style.display = 'none';
      return;
    }

    if (cap.failed) {
      captureAlert.className = 'alert alert-error';
      captureAlert.style.display = 'block';
      captureAlert.textContent = `Capture gagal (Soal #${cap.qNum || '?'}): ${cap.failReason || 'Unknown error'}`;
    } else if (cap.isLikelyBlank) {
      captureAlert.className = 'alert alert-warn';
      captureAlert.style.display = 'block';
      captureAlert.textContent = 'Gambar terdeteksi putih polos (0 piksel non-putih).';
    } else {
      captureAlert.className = 'alert alert-ok';
      captureAlert.style.display = 'block';
      captureAlert.textContent = `Gambar Soal #${cap.qNum || '?'} berhasil ditangkap & terverifikasi.`;
    }

    const statusLabel = cap.failed ? 'GAGAL' : (cap.isLikelyBlank ? 'PUTIH POLOS' : 'OK');
    const dimLabel = (cap.width && cap.height) ? `${cap.width} x ${cap.height} px` : '-';
    const sizeSliceLabel = cap.sizeKB !== undefined ? `${cap.sizeKB} KB / ${cap.slices || 1} slice` : '-';
    const pixelLabel = cap.nonWhitePixels !== null && cap.nonWhitePixels !== undefined ? `${cap.nonWhitePixels} / 1024` : '-';

    captureMeta.innerHTML = `
      <div class="meta-item"><span class="meta-label">Status (Soal #${escapeHtml(cap.qNum || '?')})</span><span class="meta-val">${statusLabel}</span></div>
      <div class="meta-item"><span class="meta-label">Dimensi</span><span class="meta-val">${escapeHtml(dimLabel)}</span></div>
      <div class="meta-item"><span class="meta-label">Ukuran / Slice</span><span class="meta-val">${escapeHtml(sizeSliceLabel)}</span></div>
      <div class="meta-item"><span class="meta-label">Piksel Non-Putih</span><span class="meta-val">${escapeHtml(pixelLabel)}</span></div>
    `;

    if (cap.dataUrlPreview) {
      previewBox.innerHTML = `<img src="${cap.dataUrlPreview}" alt="Captured question preview">`;
    } else if (cap.failed) {
      previewBox.innerHTML = `<pre class="log-data" style="width:100%;text-align:left;">${escapeHtml(JSON.stringify(cap.diag || {}, null, 2))}</pre>`;
    } else {
      previewBox.innerHTML = '<span class="empty-note">Preview tidak disimpan (ukuran melebihi batas).</span>';
    }

    const hiddenList = Array.isArray(cap.overlaysHidden) && cap.overlaysHidden.length > 0
      ? cap.overlaysHidden.join(', ')
      : 'Tidak ada';
    captureExtra.textContent = `Sumber: ${cap.sourceType || '-'} | Scroller: ${cap.scrollContainer || '-'} | Overlay disembunyikan: ${hiddenList}`;

    if (ocrPreviewSection) {
      if (cap.ocrUsed) {
        ocrPreviewSection.style.display = 'block';
        const dur = cap.ocrDurationMs ? ` • ${cap.ocrDurationMs}ms` : '';
        ocrModeBadge.textContent = `${cap.ocrMode || 'OCR'}${dur}`;
        ocrDiagramThumbs.innerHTML = '';
        if (Array.isArray(cap.ocrDiagramPreviews) && cap.ocrDiagramPreviews.length > 0) {
          for (const dImg of cap.ocrDiagramPreviews) {
            if (!dImg.dataUrl) continue;
            const wrap = document.createElement('div');
            wrap.style.cssText = 'background:var(--p-surface);border:1px solid var(--line);border-radius:6px;padding:4px;text-align:center;';
            const thumb = document.createElement('img');
            thumb.src = dImg.dataUrl;
            thumb.alt = dImg.marker || 'Diagram OCR';
            thumb.style.cssText = 'max-height:95px;max-width:140px;display:block;border-radius:4px;background:#fff;';
            const capLbl = document.createElement('div');
            capLbl.style.cssText = 'font-size:10px;color:var(--p-muted);margin-top:3px;';
            capLbl.textContent = `${dImg.marker || 'Diagram'} (${dImg.sizeKB ?? '?'} KB)`;
            wrap.appendChild(thumb);
            wrap.appendChild(capLbl);
            ocrDiagramThumbs.appendChild(wrap);
          }
        }
        ocrMarkdownBox.textContent = cap.ocrError
          ? `[OCR Error] ${cap.ocrError}`
          : (cap.ocrMarkdown || '(Markdown kosong)');
      } else {
        ocrPreviewSection.style.display = 'none';
      }
    }

    if (aiReasoningSection) {
      if (cap && (cap.aiChoice || cap.aiReasoning)) {
        aiReasoningSection.style.display = 'block';
        const modelInfo = cap.aiModel ? String(cap.aiModel) : 'AI Solver';
        const durInfo = cap.aiDurationMs ? ` • ${cap.aiDurationMs}ms` : '';
        aiReasoningBadge.textContent = `${modelInfo}${durInfo}`;

        const choiceText = cap.aiChoice ? `Pilihan: ${cap.aiChoice}` : '';
        const ansText = cap.aiAnswer ? ` (${cap.aiAnswer})` : '';
        aiAnswerBanner.textContent = `${choiceText}${ansText}` || 'Jawaban Terpilih';

        aiReasoningBox.textContent = cap.aiReasoning || '(Penjabaran langkah matematis tersimpan)';

        // Render simbol & rumus LaTeX dengan KaTeX
        if (typeof renderMathInElement === 'function') {
          try {
            renderMathInElement(aiReasoningBox, {
              delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true }
              ],
              throwOnError: false
            });
          } catch (e) {
            console.warn('[KaTeX] renderMathInElement error:', e);
          }
        }
      } else {
        aiReasoningSection.style.display = 'none';
      }
    }
  }

  function matchesFilter(item) {
    if (activeFilter === 'ALL') return true;
    if (activeFilter === 'CAPTURE') return item.category === 'CAPTURE' || item.category === 'SOLVER';
    if (activeFilter === 'OCR') return item.category === 'OCR';
    if (activeFilter === 'AI') return item.category === 'AI_VISION' || item.category === 'AI_TEXT' || item.category === 'NETWORK';
    if (activeFilter === 'WARN_ERROR') return item.level === 'WARN' || item.level === 'ERROR';
    return true;
  }

  function renderDebugLogs(logs) {
    const list = (logs || []).filter(matchesFilter);
    logCount.textContent = String(list.length);

    if (list.length === 0) {
      logList.innerHTML = '<div class="empty-note">Belum ada log untuk filter ini.</div>';
      return;
    }

    const html = list.slice().reverse().map(item => {
      const dataHtml = item.data
        ? `<pre class="log-data">${escapeHtml(JSON.stringify(item.data, null, 2))}</pre>`
        : '';
      return `
        <div class="log-entry level-${escapeHtml(item.level || 'INFO')}">
          <div class="log-meta">
            <span class="tag">${escapeHtml(item.ts || '')}</span>
            <span class="tag">${escapeHtml(item.frame || 'TOP')}</span>
            <span class="tag">${escapeHtml(item.category || 'SYS')}</span>
            <span class="tag tag-level-${escapeHtml(item.level || 'INFO')}">${escapeHtml(item.level || 'INFO')}</span>
          </div>
          <div class="log-msg">${escapeHtml(item.message || '')}</div>
          ${dataHtml}
        </div>
      `;
    }).join('');
    logList.innerHTML = html;
  }

  function loadAndRender() {
    chrome.storage.local.get(['agentLogs', 'agentDebugLogs', 'lastCapturedDebug'], (res) => {
      latestSnapshot = {
        agentLogs: res.agentLogs || [],
        agentDebugLogs: res.agentDebugLogs || [],
        lastCapturedDebug: res.lastCapturedDebug || null
      };
      renderCapturePreview(latestSnapshot.lastCapturedDebug);
      renderDebugLogs(latestSnapshot.agentDebugLogs);
    });
  }

  filterBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    filterBar.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter || 'ALL';
    renderDebugLogs(latestSnapshot.agentDebugLogs);
  });

  btnCopyAll.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(formatReportText(latestSnapshot));
      const orig = btnCopyAll.textContent;
      btnCopyAll.textContent = 'Tersalin!';
      setTimeout(() => { btnCopyAll.textContent = orig; }, 1600);
    } catch (err) {
      alert('Gagal menyalin ke clipboard: ' + err.message);
    }
  });

  btnDownloadTxt.addEventListener('click', () => {
    const blob = new Blob([formatReportText(latestSnapshot)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kamus-mini-logs-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  btnRefresh.addEventListener('click', loadAndRender);

  btnClearAll.addEventListener('click', () => {
    chrome.storage.local.set({ agentLogs: [], agentDebugLogs: [], lastCapturedDebug: null, paddleOcrCache: {} }, loadAndRender);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.agentDebugLogs || changes.lastCapturedDebug || changes.agentLogs)) {
      loadAndRender();
    }
  });

  loadAndRender();
});
