document.addEventListener('DOMContentLoaded', () => {
  // Model dictionaries for providers
  const PROVIDER_MODELS = {
    gemini: [
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (Cepat & Vision)' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Generasi Terbaru)' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (Penalaran Kompleks)' }
    ],
    groq: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' }
    ],
    openai: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4o', name: 'GPT-4o' }
    ]
  };

  // DOM Elements - Tabs
  const tabBtnAi = document.getElementById('tabBtnAi');
  const tabBtnOcr = document.getElementById('tabBtnOcr');
  const tabBtnPref = document.getElementById('tabBtnPref');
  const panelSectionAi = document.getElementById('panelSectionAi');
  const panelSectionOcr = document.getElementById('panelSectionOcr');
  const panelSectionPref = document.getElementById('panelSectionPref');

  const tabs = [
    { btn: tabBtnAi, panel: panelSectionAi },
    { btn: tabBtnOcr, panel: panelSectionOcr },
    { btn: tabBtnPref, panel: panelSectionPref }
  ];

  tabs.forEach(t => {
    if (t.btn && t.panel) {
      t.btn.addEventListener('click', () => {
        tabs.forEach(other => {
          const isActive = (other === t);
          other.btn.classList.toggle('active', isActive);
          other.btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          other.panel.style.display = isActive ? 'flex' : 'none';
        });
      });
    }
  });

  // DOM Elements - Engines & AI
  const cardDirectAi = document.getElementById('cardDirectAi');
  const cardLocalBackend = document.getElementById('cardLocalBackend');
  const panelDirectAi = document.getElementById('panelDirectAi');
  const panelLocalBackend = document.getElementById('panelLocalBackend');

  const aiProviderSelect = document.getElementById('aiProvider');
  const groupCustomBaseUrl = document.getElementById('groupCustomBaseUrl');
  const aiCustomBaseUrlInput = document.getElementById('aiCustomBaseUrl');
  const aiApiKeyInput = document.getElementById('aiApiKey');
  const btnToggleApiKey = document.getElementById('btnToggleApiKey');

  const groupAiModel = document.getElementById('groupAiModel');
  const aiModelSelect = document.getElementById('aiModel');
  const groupCustomModel = document.getElementById('groupCustomModel');
  const aiCustomModelInput = document.getElementById('aiCustomModel');

  const btnTestAiConnection = document.getElementById('btnTestAiConnection');
  const aiTestFeedback = document.getElementById('aiTestFeedback');
  const backendApiKeyInput = document.getElementById('backendApiKey');
  const btnToggleCloudApiKey = document.getElementById('btnToggleCloudApiKey');
  const btnTestCloudConnection = document.getElementById('btnTestCloudConnection');
  const cloudTestFeedback = document.getElementById('cloudTestFeedback');

  const CLOUD_ENDPOINT = 'https://mylms.melvino.online';

  // DOM Elements - OCR
  const ocrEnabledInput = document.getElementById('ocrEnabled');
  const paddleOcrTokenInput = document.getElementById('paddleOcrToken');
  const btnToggleOcrToken = document.getElementById('btnToggleOcrToken');
  const paddleOcrModelInput = document.getElementById('paddleOcrModel');
  const btnTestPaddleOcr = document.getElementById('btnTestPaddleOcr');
  const ocrTestFeedback = document.getElementById('ocrTestFeedback');

  // DOM Elements - Preferences
  const themeChoiceAuto = document.getElementById('themeChoiceAuto');
  const themeChoiceLight = document.getElementById('themeChoiceLight');
  const themeChoiceDark = document.getElementById('themeChoiceDark');
  const navigationModeSelect = document.getElementById('navigationMode');
  const baselineDelayInput = document.getElementById('baselineDelay');
  const matchThresholdInput = document.getElementById('matchThreshold');

  // DOM Elements - Actions
  const btnSaveAll = document.getElementById('btnSaveAll');
  const btnResetDefault = document.getElementById('btnResetDefault');
  const toastSave = document.getElementById('toastSave');

  let currentEngine = 'direct_ai';

  // Populate models dropdown
  function populateModels(provider, selectedModel) {
    if (provider === 'custom') {
      if (groupCustomBaseUrl) groupCustomBaseUrl.style.display = 'flex';
      if (groupCustomModel) groupCustomModel.style.display = 'flex';
      if (groupAiModel) groupAiModel.style.display = 'none';
      return;
    }

    if (groupCustomBaseUrl) groupCustomBaseUrl.style.display = 'none';
    if (groupCustomModel) groupCustomModel.style.display = 'none';
    if (groupAiModel) groupAiModel.style.display = 'flex';

    aiModelSelect.innerHTML = '';
    const models = PROVIDER_MODELS[provider] || [];
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === selectedModel) opt.selected = true;
      aiModelSelect.appendChild(opt);
    });
  }

  // Switch engine UI ('direct_ai' vs 'cloud')
  function setEngine(engine) {
    const normalized = (engine === 'cloud' || engine === 'local_backend') ? 'cloud' : 'direct_ai';
    currentEngine = normalized;
    if (normalized === 'cloud') {
      cardDirectAi.classList.remove('active');
      cardLocalBackend.classList.add('active');
      panelDirectAi.style.display = 'none';
      panelLocalBackend.style.display = 'block';
    } else {
      cardDirectAi.classList.add('active');
      cardLocalBackend.classList.remove('active');
      panelDirectAi.style.display = 'block';
      panelLocalBackend.style.display = 'none';
    }
  }

  cardDirectAi.addEventListener('click', () => setEngine('direct_ai'));
  cardLocalBackend.addEventListener('click', () => setEngine('cloud'));

  aiProviderSelect.addEventListener('change', () => {
    populateModels(aiProviderSelect.value);
    aiTestFeedback.style.display = 'none';
  });

  // Secret Toggle Helper with SVG icons (no text replacement)
  function bindSecretToggle(inputEl, btnEl) {
    if (!inputEl || !btnEl) return;
    btnEl.addEventListener('click', () => {
      const isPassword = inputEl.type === 'password';
      inputEl.type = isPassword ? 'text' : 'password';
      btnEl.setAttribute('aria-pressed', isPassword ? 'true' : 'false');
      btnEl.title = isPassword ? 'Sembunyikan' : 'Lihat';
      btnEl.innerHTML = isPassword
        ? `<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    });
  }

  bindSecretToggle(aiApiKeyInput, btnToggleApiKey);
  bindSecretToggle(paddleOcrTokenInput, btnToggleOcrToken);
  bindSecretToggle(backendApiKeyInput, btnToggleCloudApiKey);

  // Theme selector handling
  const themeButtons = [
    { el: themeChoiceAuto, val: 'auto' },
    { el: themeChoiceLight, val: 'light' },
    { el: themeChoiceDark, val: 'dark' }
  ];

  function updateThemeUI(pref) {
    themeButtons.forEach(tb => {
      if (!tb.el) return;
      const match = (tb.val === pref);
      tb.el.classList.toggle('active', match);
      tb.el.setAttribute('aria-checked', match ? 'true' : 'false');
    });
  }

  themeButtons.forEach(tb => {
    if (!tb.el) return;
    tb.el.addEventListener('click', () => {
      if (window.KamusMiniTheme) {
        window.KamusMiniTheme.setTheme(tb.val);
      }
      updateThemeUI(tb.val);
    });
  });

  // Load existing configuration from chrome.storage.local
  chrome.storage.local.get([
    'solverEngine',
    'aiProvider',
    'aiApiKey',
    'aiModel',
    'aiCustomBaseUrl',
    'aiCustomModel',
    'ocrEnabled',
    'paddleOcrToken',
    'paddleOcrModel',
    'baseUrl',
    'apiKey',
    'baselineDelay',
    'matchThreshold',
    'navigationMode',
    'uiTheme'
  ], (res) => {
    const engine = res.solverEngine || 'direct_ai';
    setEngine(engine);

    if (backendApiKeyInput) backendApiKeyInput.value = res.apiKey || '';

    const provider = res.aiProvider || 'gemini';
    aiProviderSelect.value = provider;
    aiCustomBaseUrlInput.value = res.aiCustomBaseUrl || 'https://api.deepseek.com/v1';
    aiCustomModelInput.value = res.aiCustomModel || 'deepseek-chat';
    populateModels(provider, res.aiModel || 'gemini-1.5-flash');

    aiApiKeyInput.value = res.aiApiKey || '';

    if (ocrEnabledInput) ocrEnabledInput.checked = res.ocrEnabled !== false;
    if (paddleOcrTokenInput) paddleOcrTokenInput.value = res.paddleOcrToken || '';
    if (paddleOcrModelInput) paddleOcrModelInput.value = res.paddleOcrModel || 'PaddleOCR-VL-1.6';

    baselineDelayInput.value = res.baselineDelay !== undefined ? res.baselineDelay : 3;
    matchThresholdInput.value = res.matchThreshold !== undefined ? res.matchThreshold : 75;
    navigationModeSelect.value = res.navigationMode || 'semi_auto';

    const currentThemePref = res.uiTheme || (window.KamusMiniTheme ? window.KamusMiniTheme.getPreference() : 'auto');
    updateThemeUI(currentThemePref);
  });

  // Save Settings
  function saveSettings(showToast = true) {
    const activeThemeBtn = themeButtons.find(tb => tb.el && tb.el.classList.contains('active'));
    const chosenTheme = activeThemeBtn ? activeThemeBtn.val : 'auto';

    const config = {
      solverEngine: currentEngine,
      aiProvider: aiProviderSelect.value,
      aiApiKey: aiApiKeyInput.value.trim(),
      aiModel: (aiProviderSelect.value === 'custom') ? (aiCustomModelInput.value.trim() || 'deepseek-chat') : aiModelSelect.value,
      aiCustomBaseUrl: aiCustomBaseUrlInput.value.trim() || 'https://api.deepseek.com/v1',
      aiCustomModel: aiCustomModelInput.value.trim() || 'deepseek-chat',
      ocrEnabled: ocrEnabledInput ? Boolean(ocrEnabledInput.checked) : true,
      paddleOcrToken: paddleOcrTokenInput ? paddleOcrTokenInput.value.trim() : '',
      paddleOcrModel: paddleOcrModelInput ? (paddleOcrModelInput.value.trim() || 'PaddleOCR-VL-1.6') : 'PaddleOCR-VL-1.6',
      baseUrl: CLOUD_ENDPOINT,
      apiKey: backendApiKeyInput ? backendApiKeyInput.value.trim() : '',
      baselineDelay: parseFloat(baselineDelayInput.value) || 3,
      matchThreshold: parseInt(matchThresholdInput.value, 10) || 75,
      navigationMode: navigationModeSelect.value || 'semi_auto',
      uiTheme: chosenTheme
    };

    chrome.storage.local.set(config, () => {
      if (showToast && toastSave) {
        toastSave.classList.add('show');
        setTimeout(() => {
          toastSave.classList.remove('show');
        }, 2000);
      }
    });
  }

  btnSaveAll.addEventListener('click', () => saveSettings(true));

  // Reset to default
  btnResetDefault.addEventListener('click', () => {
    if (confirm('Kembalikan pengaturan ke default?')) {
      setEngine('direct_ai');
      aiProviderSelect.value = 'gemini';
      aiCustomBaseUrlInput.value = 'https://api.deepseek.com/v1';
      aiCustomModelInput.value = 'deepseek-chat';
      populateModels('gemini', 'gemini-1.5-flash');
      aiApiKeyInput.value = '';
      if (backendApiKeyInput) backendApiKeyInput.value = '';
      if (ocrEnabledInput) ocrEnabledInput.checked = true;
      if (paddleOcrTokenInput) paddleOcrTokenInput.value = '';
      if (paddleOcrModelInput) paddleOcrModelInput.value = 'PaddleOCR-VL-1.6';
      baselineDelayInput.value = 3;
      matchThresholdInput.value = 75;
      navigationModeSelect.value = 'semi_auto';
      updateThemeUI('auto');
      if (window.KamusMiniTheme) window.KamusMiniTheme.setTheme('auto');
      saveSettings(true);
    }
  });

  // Test AI Connection
  btnTestAiConnection.addEventListener('click', async () => {
    const provider = aiProviderSelect.value;
    const apiKey = aiApiKeyInput.value.trim();
    const model = (provider === 'custom')
      ? (aiCustomModelInput.value.trim() || 'deepseek-chat')
      : aiModelSelect.value;

    if (!apiKey && provider !== 'custom') {
      aiTestFeedback.className = 'test-feedback error';
      aiTestFeedback.textContent = 'Masukkan API Key terlebih dahulu.';
      aiTestFeedback.style.display = 'block';
      return;
    }

    aiTestFeedback.className = 'test-feedback';
    aiTestFeedback.textContent = 'Menguji koneksi...';
    aiTestFeedback.style.display = 'block';
    btnTestAiConnection.disabled = true;

    try {
      if (provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Ketik angka 2 jika kamu mendengar saya.' }] }]
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ? data.error.message : `HTTP Error ${res.status}`);
        }

        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'OK';
        aiTestFeedback.className = 'test-feedback success';
        aiTestFeedback.textContent = `Koneksi Berhasil (${reply.trim()})`;
      } else if (provider === 'groq') {
        const url = 'https://api.groq.com/openai/v1/chat/completions';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: 'Ketik angka 2' }],
            max_tokens: 10
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ? data.error.message : `HTTP Error ${res.status}`);
        }

        const reply = data.choices?.[0]?.message?.content || 'OK';
        aiTestFeedback.className = 'test-feedback success';
        aiTestFeedback.textContent = `Koneksi Berhasil (${reply.trim()})`;
      } else if (provider === 'openai') {
        const url = 'https://api.openai.com/v1/chat/completions';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: 'Ketik angka 2' }],
            max_tokens: 10
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ? data.error.message : `HTTP Error ${res.status}`);
        }

        const reply = data.choices?.[0]?.message?.content || 'OK';
        aiTestFeedback.className = 'test-feedback success';
        aiTestFeedback.textContent = `Koneksi Berhasil (${reply.trim()})`;
      } else if (provider === 'custom') {
        const rawBaseUrl = aiCustomBaseUrlInput.value.trim() || 'https://api.deepseek.com/v1';
        const baseUrl = rawBaseUrl.replace(/\/+$/, '');
        const url = `${baseUrl}/chat/completions`;
        const customModel = aiCustomModelInput.value.trim() || 'deepseek-chat';

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            model: customModel,
            messages: [{ role: 'user', content: 'Ketik angka 2 jika kamu mendengar saya.' }],
            max_tokens: 15
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ? (data.error.message || JSON.stringify(data.error)) : `HTTP Error ${res.status}`);
        }

        const reply = data.choices?.[0]?.message?.content || 'OK';
        aiTestFeedback.className = 'test-feedback success';
        aiTestFeedback.textContent = `Koneksi Berhasil (${customModel}: ${reply.trim()})`;
      }
    } catch (err) {
      aiTestFeedback.className = 'test-feedback error';
      aiTestFeedback.textContent = `Koneksi Gagal: ${err.message}`;
    } finally {
      btnTestAiConnection.disabled = false;
    }
  });

  // Test PaddleOCR Connection
  if (btnTestPaddleOcr) {
    btnTestPaddleOcr.addEventListener('click', async () => {
      const token = paddleOcrTokenInput ? paddleOcrTokenInput.value.trim() : '';
      const ocrModel = (paddleOcrModelInput ? paddleOcrModelInput.value.trim() : '') || 'PaddleOCR-VL-1.6';

      if (!token) {
        ocrTestFeedback.className = 'test-feedback error';
        ocrTestFeedback.textContent = 'Masukkan Access Token Baidu AI Studio terlebih dahulu.';
        ocrTestFeedback.style.display = 'block';
        return;
      }

      if (typeof KamusMiniOcr === 'undefined' || typeof KamusMiniOcr.testPaddleOcrConnection !== 'function') {
        ocrTestFeedback.className = 'test-feedback error';
        ocrTestFeedback.textContent = 'Modul KamusMiniOcr tidak tersedia.';
        ocrTestFeedback.style.display = 'block';
        return;
      }

      ocrTestFeedback.className = 'test-feedback';
      ocrTestFeedback.textContent = 'Mengirim gambar uji ke PaddleOCR-VL-1.6...';
      ocrTestFeedback.style.display = 'block';
      btnTestPaddleOcr.disabled = true;

      try {
        const result = await KamusMiniOcr.testPaddleOcrConnection({
          token,
          model: ocrModel,
          onProgress: (p) => {
            if (p.stage === 'submitting') {
              ocrTestFeedback.textContent = `Mengunggah gambar uji ke PaddleOCR (${p.model})...`;
            } else if (p.stage === 'polling') {
              ocrTestFeedback.textContent = `Memproses OCR di server Baidu... (poll #${p.pollCount || 1})`;
            } else if (p.stage === 'fetching_result') {
              ocrTestFeedback.textContent = 'Mengunduh hasil Markdown OCR...';
            }
          }
        });

        const previewText = (result.cleanMarkdown || result.rawMarkdown || '').trim().replace(/\s+/g, ' ');
        ocrTestFeedback.className = 'test-feedback success';
        ocrTestFeedback.textContent = `PaddleOCR Berhasil (${previewText.slice(0, 60) || 'Teks terbaca'}) — ${result.durationMs}ms`;
      } catch (err) {
        ocrTestFeedback.className = 'test-feedback error';
        ocrTestFeedback.textContent = `Tes PaddleOCR Gagal: ${err.message}`;
      } finally {
        btnTestPaddleOcr.disabled = false;
      }
    });
  }

  // Test Kamus Mini Cloud Connection
  if (btnTestCloudConnection && cloudTestFeedback) {
    btnTestCloudConnection.addEventListener('click', async () => {
      const apiKey = backendApiKeyInput ? backendApiKeyInput.value.trim() : '';
      if (!apiKey) {
        cloudTestFeedback.className = 'test-feedback error';
        cloudTestFeedback.textContent = 'Masukkan x-api-key Kamus Mini Cloud terlebih dahulu.';
        cloudTestFeedback.style.display = 'block';
        return;
      }

      cloudTestFeedback.className = 'test-feedback';
      cloudTestFeedback.textContent = `Menghubungi ${CLOUD_ENDPOINT}/api/v1/agent/categories...`;
      cloudTestFeedback.style.display = 'block';
      btnTestCloudConnection.disabled = true;

      try {
        const res = await fetch(`${CLOUD_ENDPOINT}/api/v1/agent/categories`, {
          method: 'GET',
          headers: { 'x-api-key': apiKey }
        });

        let data = null;
        try {
          data = await res.json();
        } catch (_) {
          data = null;
        }

        if (!res.ok) {
          const msg = data?.error || data?.message || `HTTP Error ${res.status}`;
          throw new Error(msg);
        }

        if (data && data.success === false) {
          throw new Error(data.error || 'Autentikasi Cloud gagal.');
        }

        const catCount = Array.isArray(data?.data) ? data.data.length : 0;
        cloudTestFeedback.className = 'test-feedback success';
        cloudTestFeedback.textContent = `Terhubung ke Kamus Mini Cloud (${catCount} kategori soal tersedia).`;
      } catch (err) {
        cloudTestFeedback.className = 'test-feedback error';
        cloudTestFeedback.textContent = `Koneksi Cloud Gagal: ${err.message}`;
      } finally {
        btnTestCloudConnection.disabled = false;
      }
    });
  }
});
