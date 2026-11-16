document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const btnOpenOptions = document.getElementById('btnOpenOptions');
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  const themeIcon = document.getElementById('themeIcon');

  const statusBadge = document.getElementById('statusBadge');
  const statusLabel = document.getElementById('statusLabel');
  const engineInfo = document.getElementById('engineInfo');

  const btnModeSemi = document.getElementById('btnModeSemi');
  const btnModeAuto = document.getElementById('btnModeAuto');
  const chkAutoNext = document.getElementById('chkAutoNext');
  const autoNextLabel = document.getElementById('autoNextLabel');

  const btnStartAgent = document.getElementById('btnStartAgent');
  const btnStopAgent = document.getElementById('btnStopAgent');

  const manualQuery = document.getElementById('manualQuery');
  const btnManualSearch = document.getElementById('btnManualSearch');
  const manualResult = document.getElementById('manualResult');

  // THEME MANAGEMENT
  function updateThemeIcon() {
    if (!themeIcon || !window.KamusMiniTheme) return;
    const isDark = window.KamusMiniTheme.getEffectiveTheme() === 'dark';
    if (isDark) {
      // Sun icon (click to switch to light)
      themeIcon.innerHTML = `
        <circle cx="12" cy="12" r="5"></circle>
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path>
      `;
      btnThemeToggle.title = 'Ganti ke Mode Terang';
    } else {
      // Moon icon (click to switch to dark)
      themeIcon.innerHTML = `
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      `;
      btnThemeToggle.title = 'Ganti ke Mode Gelap';
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

  // NAVIGATION MODE SYNC
  function setNavMode(mode, save = true) {
    const isAuto = mode === 'full_auto';
    if (btnModeSemi && btnModeAuto) {
      btnModeSemi.classList.toggle('active', !isAuto);
      btnModeSemi.setAttribute('aria-checked', !isAuto ? 'true' : 'false');
      btnModeAuto.classList.toggle('active', isAuto);
      btnModeAuto.setAttribute('aria-checked', isAuto ? 'true' : 'false');
    }
    if (chkAutoNext) {
      chkAutoNext.checked = isAuto;
    }
    if (autoNextLabel) {
      autoNextLabel.textContent = isAuto ? 'Auto' : 'Semi';
    }
    if (save && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ navigationMode: isAuto ? 'full_auto' : 'semi_auto' });
    }
  }

  if (btnModeSemi) {
    btnModeSemi.addEventListener('click', () => setNavMode('semi_auto', true));
  }
  if (btnModeAuto) {
    btnModeAuto.addEventListener('click', () => setNavMode('full_auto', true));
  }

  // Initial nav mode load
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['navigationMode'], (res) => {
      setNavMode(res.navigationMode || 'semi_auto', false);
    });
  }

  // OPEN OPTIONS PAGE
  if (btnOpenOptions) {
    btnOpenOptions.addEventListener('click', () => {
      if (chrome.runtime && chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open(chrome.runtime.getURL('options.html'));
      }
    });
  }

  // RENDER ENGINE INFO
  function updateEngineBadge() {
    if (!engineInfo || typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get(['solverEngine', 'aiProvider', 'aiModel', 'aiCustomModel', 'ocrEnabled'], (res) => {
      const engine = res.solverEngine || 'direct_ai';
      const ocrSuffix = res.ocrEnabled ? ' + OCR' : '';

      if (engine === 'direct_ai') {
        const rawProvider = res.aiProvider || 'gemini';
        let label = 'Gemini';
        if (rawProvider === 'groq') label = 'Groq';
        else if (rawProvider === 'openai') label = 'OpenAI';
        else if (rawProvider === 'custom') label = res.aiCustomModel || 'Custom AI';
        engineInfo.textContent = `${label}${ocrSuffix}`;
      } else {
        engineInfo.textContent = `Kamus Mini Cloud${ocrSuffix}`;
      }
    });
  }
  updateEngineBadge();

  // SYNC AGENT STATUS
  function syncState() {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get(['agentState'], (res) => {
      const state = res.agentState || { status: 'idle' };

      statusBadge.className = 'status-dot';
      if (state.status === 'running') {
        statusBadge.classList.add('running');
        statusLabel.textContent = state.message || 'Sedang bekerja...';
        btnStartAgent.style.display = 'none';
        btnStopAgent.style.display = 'inline-flex';
        btnStopAgent.disabled = false;
      } else if (state.status === 'paused-by-captcha') {
        statusBadge.classList.add('paused');
        statusLabel.textContent = 'Captcha terdeteksi';
        btnStartAgent.style.display = 'none';
        btnStopAgent.style.display = 'inline-flex';
        btnStopAgent.disabled = false;
      } else if (state.status === 'completed') {
        statusBadge.classList.add('completed');
        statusLabel.textContent = 'Kuis selesai';
        btnStartAgent.style.display = 'inline-flex';
        btnStopAgent.style.display = 'none';
      } else {
        statusLabel.textContent = 'Siap';
        btnStartAgent.style.display = 'inline-flex';
        btnStopAgent.style.display = 'none';
      }
    });
  }
  syncState();

  // START AGENT
  if (btnStartAgent) {
    btnStartAgent.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        const activeTab = tabs[0];

        chrome.storage.local.set({ agentState: { status: 'running', message: 'Memulai agen...' } }, syncState);
        chrome.tabs.sendMessage(activeTab.id, { action: 'startAgent' }, () => {
          if (chrome.runtime.lastError) {}
        });
      });
    });
  }

  // STOP AGENT
  if (btnStopAgent) {
    btnStopAgent.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.storage.local.set({ agentState: { status: 'idle' } }, syncState);
        if (tabs && tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'stopAgent' }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
    });
  }

  // MANUAL QUICK SEARCH
  if (btnManualSearch && manualQuery) {
    btnManualSearch.addEventListener('click', performManualSearch);
    manualQuery.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performManualSearch();
    });
  }

  async function performManualSearch() {
    const query = manualQuery.value.trim();
    if (!query) return;

    manualResult.style.display = 'block';
    manualResult.textContent = 'Mencari...';

    const config = await new Promise(r => chrome.storage.local.get(['solverEngine', 'aiProvider', 'aiApiKey', 'aiModel', 'apiKey'], r));
    const engine = config.solverEngine || 'direct_ai';

    try {
      if (engine === 'direct_ai') {
        const apiKey = config.aiApiKey;
        const provider = config.aiProvider || 'gemini';
        const model = config.aiModel || 'gemini-1.5-flash';

        if (!apiKey) {
          manualResult.textContent = 'API Key belum diatur di Pengaturan.';
          return;
        }

        if (provider === 'gemini') {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Jawab pertanyaan ini secara singkat dan tepat:\n${query}` }] }]
            })
          });
          const data = await res.json();
          const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Tidak ada jawaban.';
          manualResult.textContent = answer.trim();
        } else {
          manualResult.textContent = 'Gunakan Gemini untuk hasil terbaik pada pencarian cepat.';
        }
      } else {
        const baseUrl = 'https://mylms.melvino.online';
        const headers = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers['x-api-key'] = config.apiKey;
        const res = await fetch(`${baseUrl}/api/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: query })
        });
        const data = await res.json();
        manualResult.textContent = data.jawaban || data.answer || 'Tidak ditemukan di database.';
      }
    } catch (err) {
      manualResult.textContent = `Gagal: ${err.message}`;
    }
  }

  // Storage listener for instant updates
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes.agentState) syncState();
      if (changes.navigationMode) setNavMode(changes.navigationMode.newValue, false);
      if (changes.solverEngine || changes.aiProvider || changes.ocrEnabled) updateEngineBadge();
    });
  }

  // Safety poll timer
  const stateTimer = setInterval(syncState, 1000);
  window.addEventListener('unload', () => {
    clearInterval(stateTimer);
  });
});
