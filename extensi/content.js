// ======================================================
// KAMUS MINI — STEALTH ANSWER FINDER & AI AGENT SOLVER
// ======================================================

// ---- MOODLE / CBT QUIZ DOCUMENT RESOLVER ----
// Mendukung Halaman Reguler, ReplayWeb Shadow DOM (<replay-web-page>), Nested ShadowRoot, & IFrames
function findQuizContextInRoot(root, targetDoc = null, chain = [], visited = new Set(), viaShadow = false) {
  if (!root || visited.has(root)) return null;
  visited.add(root);

  // 1. Cek langsung pada root (Document)
  try {
    if (root.nodeType === 9) {
      if (targetDoc) {
        if (root === targetDoc) {
          const sourceType = chain.length === 0 ? 'main_document' : (viaShadow ? 'replay_shadow_iframe' : 'iframe');
          return { doc: root, iframeChain: chain, sourceType };
        }
      } else if (root.querySelector && root.querySelector('.formulation')) {
        const sourceType = chain.length === 0 ? 'main_document' : (viaShadow ? 'replay_shadow_iframe' : 'iframe');
        return { doc: root, iframeChain: chain, sourceType };
      }
    }
  } catch (e) {}

  // 2. Cek di dalam custom element <replay-web-page> atau nested ShadowRoot di dalam Shadow DOM
  try {
    if (root.nodeType === 9 && root.querySelector) {
      const replayEl = root.querySelector('replay-web-page');
      if (replayEl && replayEl.shadowRoot) {
        const hit = findQuizContextInRoot(replayEl.shadowRoot, targetDoc, chain, visited, true);
        if (hit) return hit;
      }
      // Fallback ringan: cek child langsung <body> yang mungkin berupa custom element ber-shadowRoot
      if (root === document && document.body) {
        for (const child of document.body.children) {
          if (child.shadowRoot && child !== replayEl) {
            const hit = findQuizContextInRoot(child.shadowRoot, targetDoc, chain, visited, true);
            if (hit) return hit;
          }
        }
      }
    } else if (root.nodeType === 11 && root.querySelectorAll) {
      // Sudah berada di dalam ShadowRoot: telusuri sub-komponen yang punya shadowRoot terbuka
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const hit = findQuizContextInRoot(el.shadowRoot, targetDoc, chain, visited, true);
          if (hit) return hit;
        }
      }
    }
  } catch (e) {}

  // 3. Cek semua iframe same-origin di dalam root (mendukung iframe bersarang / nested)
  try {
    const iframes = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
    for (const ifr of iframes) {
      try {
        const doc = ifr.contentDocument || ifr.contentWindow?.document;
        if (doc) {
          const hit = findQuizContextInRoot(doc, targetDoc, [...chain, ifr], visited, viaShadow);
          if (hit) return hit;
        }
      } catch (e) {}
    }
  } catch (e) {}

  return null;
}

function getQuizDocument() {
  const hit = findQuizContextInRoot(document);
  return hit ? hit.doc : null;
}

// Menentukan apakah script saat ini berjalan di dalam iframe same-origin yang bisa
// dikendalikan langsung oleh top frame (seperti di replayweb.page).
// Top frame punya koordinat layar & offset iframe yang akurat untuk crop screenshot.
function isManagedByTopFrame() {
  if (window === window.top) return false;
  try {
    const topDoc = window.top.document;
    return !!(topDoc && topDoc.querySelector);
  } catch (e) {
    return false;
  }
}

// ---- UTILITY CHECK: Exam/Quiz Website Detection ----
const isExamSite = () => {
  const doc = getQuizDocument();
  if (doc && doc.querySelector && doc.querySelector('.formulation')) {
    return true;
  }

  const host = window.location.hostname.toLowerCase();
  const path = window.location.pathname.toLowerCase();
  
  const excludedHosts = [
    'whatsapp.com', 'whatsapp.net', 'telegram.org', 'web.telegram.org',
    'google.com', 'google.co.id', 'youtube.com', 'facebook.com', 
    'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'zoom.us',
    'github.com', 'gmail.com', 'drive.google.com', 'stackoverflow.com'
  ];
  
  if (excludedHosts.some(ex => host.includes(ex))) {
    return false;
  }
  
  const examKeywords = [
    'ujian', 'exam', 'cbt', 'elearning', 'quiz', 'localhost', '127.0.0.1', 
    'mulok', 'test', 'evaluasi', 'assessment', 'bimtek', 'belajar',
    'lms', 'telkomschools', 'replayweb.page', 'webrecorder'
  ];
  
  return examKeywords.some(keyword => 
    host.includes(keyword) || path.includes(keyword)
  );
};

// Agent state belongs to one tab. Unscoped legacy states never start automation.
let agentTabId = null;
const agentTabReady = new Promise(resolve => {
  chrome.runtime.sendMessage({ action: 'getTabIdentity' }, response => {
    if (!chrome.runtime.lastError && Number.isInteger(response?.tabId)) agentTabId = response.tabId;
    resolve(agentTabId);
  });
});
function ownsAgentState(state) {
  return Number.isInteger(agentTabId) && state?.tabId === agentTabId;
}
function getAgentState(callback) {
  chrome.storage.local.get(['agentState'], res => callback({
    agentState: ownsAgentState(res.agentState) ? res.agentState : {}
  }));
}
function setAgentState(patch, callback) {
  if (!Number.isInteger(agentTabId)) return;
  chrome.storage.local.set({ ...patch, agentState: { ...patch.agentState, tabId: agentTabId } }, callback);
}
let agentGeneration = 0;

// ---- GLOBAL AGENT STATE ----
let isAgentRunning = false;
let agentLoopTimeout = null;
let lastObservedQNum = null;
let lastSolvedQuestionKey = null;
let solvedQuestionKeys = new Set();
let isSolvingActive = false;
let isPendingNextNavigation = false;

function clearPendingAgentTimer() {
  if (agentLoopTimeout) {
    clearTimeout(agentLoopTimeout);
    agentLoopTimeout = null;
  }
  isPendingNextNavigation = false;
}

function resetSolvedQuestionTracking() {
  agentGeneration++;
  lastSolvedQuestionKey = null;
  solvedQuestionKeys.clear();
}

function resolveQuizDocAndScope(scopeOrDoc) {
  if (!scopeOrDoc) {
    const doc = getQuizDocument() || document;
    return { doc, scope: doc };
  }
  if (scopeOrDoc.nodeType === 9) {
    return { doc: scopeOrDoc, scope: scopeOrDoc };
  }
  const doc = scopeOrDoc.ownerDocument || getQuizDocument() || document;
  return { doc, scope: scopeOrDoc };
}

function getQuestionIdentityFromElement(scopeEl) {
  const scope = scopeEl || getQuizDocument() || document;
  const qnoEl = scope.querySelector('.info .qno') || scope.querySelector('.qno');
  const qtextEl = scope.querySelector('.qtext');
  const qNum = qnoEl ? qnoEl.textContent.trim() : "1";
  const qText = qtextEl ? qtextEl.textContent.trim() : "";
  const idPrefix = (scope.nodeType === 1 && scope.id) ? `${scope.id}::` : '';
  return {
    qNum,
    qText,
    questionKey: `${idPrefix}${qNum}::${qText.slice(0, 80)}`
  };
}

function isAnswerableQuestionElement(queEl) {
  if (!queEl || queEl.nodeType !== 1) return false;
  if (!queEl.querySelector('.formulation')) return false;
  if (queEl.classList.contains('description') || queEl.classList.contains('informationitem')) {
    return false;
  }
  return Boolean(
    queEl.querySelector([
      '.answer input[type="radio"]:not([value="-1"]):not(:disabled)',
      '.answer input[type="checkbox"]:not(:disabled)',
      '.answer input[type="text"]:not(:disabled)',
      '.answer input[type="number"]:not(:disabled)',
      '.qtext input[type="text"]:not(:disabled)',
      '.qtext input[type="number"]:not(:disabled)',
      '.answer textarea',
      '.answer [contenteditable="true"]',
      '.qtype_essay_response [contenteditable="true"]',
      '.answer iframe'
    ].join(', '))
  );
}

function getPageQuestions(doc) {
  const d = doc || getQuizDocument() || document;
  if (!d) return [];
  const ques = Array.from(d.querySelectorAll('.que')).filter(isAnswerableQuestionElement);
  if (ques.length > 0) return ques;
  return d.querySelector('.formulation') ? [d] : [];
}

function getCurrentQuestionIdentity(doc) {
  const d = doc || getQuizDocument() || document;
  const questions = getPageQuestions(d);
  if (questions.length > 1) {
    const first = getQuestionIdentityFromElement(questions[0]);
    const last = getQuestionIdentityFromElement(questions[questions.length - 1]);
    return {
      qNum: `${first.qNum}-${last.qNum}`,
      qText: first.qText,
      questionKey: `multi(${questions.length})::${first.questionKey}::${last.questionKey}`
    };
  }
  return getQuestionIdentityFromElement(questions[0] || d);
}

// ---- TOAST UI (MINIMALIST) ----
function showToast(title, message, type = 'info') {
  const doc = getQuizDocument() || document;
  const targetBody = document.body || doc.body;
  if (!targetBody) return;

  const existing = document.getElementById('g-dict-tooltip') || (doc.getElementById ? doc.getElementById('g-dict-tooltip') : null);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'g-dict-tooltip';

  let dotColor = '#5d6b72';
  if (type === 'success') {
    dotColor = '#0f7d45';
  } else if (type === 'warning') {
    dotColor = '#b45309';
  } else if (type === 'error') {
    dotColor = '#c5221f';
  }

  const displayText = (message || title || '').replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, '');
  if (!displayText) return;

  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '18px',
    left: '18px',
    maxWidth: '240px',
    width: 'fit-content',
    padding: '6px 11px',
    backgroundColor: '#1f3038',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    color: '#f7f9fa',
    borderRadius: '6px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '12px',
    fontWeight: '500',
    lineHeight: '1.4',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    pointerEvents: 'none',
    transition: 'opacity 0.2s ease, transform 0.2s ease',
    transform: 'translateY(8px)',
    opacity: '0'
  });

  toast.innerHTML = `
    <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};flex:none;"></span>
    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${displayText}</span>
  `;

  targetBody.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });

  const duration = (type === 'error' || type === 'warning') ? 3500 : 1800;
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ---- FUZZY STRING SIMILARITY (Dice's Coefficient) ----
function getStringSimilarity(str1, str2) {
  const s1 = (str1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = (str2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) {
    return Math.max(s1.length, s2.length) > 0 ? Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length) : 0;
  }
  
  const getBigrams = (str) => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.substr(i, 2));
    }
    return bigrams;
  };
  
  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);
  
  let intersection = 0;
  b1.forEach(val => {
    if (b2.has(val)) intersection++;
  });
  
  const total = b1.size + b2.size;
  return total > 0 ? (2 * intersection) / total : 0;
}

// ---- CLOUDFLARE CAPTCHA DETECTION ----
function checkForCaptcha() {
  const doc = getQuizDocument() || document;
  const isCfIframe = document.querySelector('.cf-turnstile') || 
                     document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                     (doc !== document && doc.querySelector('.cf-turnstile'));
  const isCfForm = document.querySelector('#challenge-form') || 
                   document.querySelector('#cf-wrapper') ||
                   (doc !== document && doc.querySelector('#challenge-form'));
  const isCfTitle = document.title.includes("Cloudflare") || document.title.includes("Just a moment");

  return !!(isCfIframe || isCfForm || isCfTitle);
}

// Handler Deteksi Captcha Secara Proaktif
function handleProactiveCaptchaCheck() {
  if (checkForCaptcha()) {
    getAgentState( (res) => {
      const state = res.agentState || {};
      if (state.status === 'running') {
        isAgentRunning = false;
        resetSolvedQuestionTracking();
        clearPendingAgentTimer();
        
        setAgentState({
          agentState: {
            status: 'paused-by-captcha',
            lastUrl: window.location.href,
            timestamp: Date.now()
          }
        });
        showToast("", "Captcha terdeteksi", "warning");
        logAgentActivity("⚠️ Cloudflare Captcha terdeteksi! Agen dihentikan sementara.");
      }
    });
    return true;
  }
  return false;
}

// Helper to wait until DOM is fully parsed
function onDomReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}

function isQuizSummaryPage(doc) {
  const d = doc || document;
  const href = String((d.defaultView?.location?.href) || window.location.href || '').toLowerCase();
  if (href.includes('mod/quiz/summary.php') || href.includes('mod/quiz/review.php')) {
    return true;
  }
  const btns = d.querySelectorAll('button, input[type="submit"]');
  for (const btn of btns) {
    const label = String(btn.value || btn.textContent || '').toLowerCase().trim();
    if (/(submit all and finish|kumpulkan semua dan selesai|kirim semua dan selesai|finish review)/i.test(label)) {
      return true;
    }
  }
  return false;
}

// Menjalankan pemeriksaan saat DOM selesai dimuat
onDomReady(async () => {
  await agentTabReady;
  if (isManagedByTopFrame()) return;
  handleProactiveCaptchaCheck();

  getAgentState( (res) => {
    const state = res.agentState || {};

    if (state.status === 'running') {
      const doc = getQuizDocument();
      if (doc && doc.querySelector('.formulation')) {
        const currentUrl = window.location.href;
        const { questionKey } = getCurrentQuestionIdentity(doc);

        if (state.pendingAutoNext && state.lastAutoNavUrl === currentUrl && state.lastAutoNavKey === questionKey) {
          const sameCount = Number(state.samePageNavCount || 0) + 1;
          if (sameCount >= 2) {
            isAgentRunning = false;
            clearPendingAgentTimer();
            setAgentState({
              agentState: { status: 'idle', message: 'Berhenti: halaman tidak berpindah' }
            });
            showToast("", "Halaman berulang · Stop", "warning");
            logAgentActivity("⚠️ Auto Mode dihentikan karena halaman tetap sama setelah navigasi Next (Anti-Loop Guard).");
            return;
          }
          setAgentState({
            agentState: {
              ...state,
              pendingAutoNext: false,
              samePageNavCount: sameCount
            }
          });
        } else if (state.pendingAutoNext || state.samePageNavCount) {
          setAgentState({
            agentState: {
              status: 'running',
              lastAutoNavUrl: null,
              lastAutoNavKey: null,
              pendingAutoNext: false,
              samePageNavCount: 0
            }
          });
        }

        logAgentActivity("🔄 Melanjutkan pengerjaan kuis di halaman baru...");
        isAgentRunning = true;
        startAgentLoop();
      } else if (isQuizSummaryPage(document)) {
        isAgentRunning = false;
        clearPendingAgentTimer();
        setAgentState({ agentState: { status: 'completed' } });
        showToast("", "Kuis selesai", "success");
        logAgentActivity("🏁 Halaman ringkasan/pengumpulan kuis terdeteksi. Auto Mode berhenti aman sebelum submit final.");
      }
    }
    else if (state.status === 'paused-by-captcha') {
      const doc = getQuizDocument();
      if (doc && doc.querySelector('.formulation')) {
        setAgentState({
          agentState: { status: 'running' }
        }, () => {
          showToast("", "Lanjut kuis...", "success");
          logAgentActivity("🔄 Berhasil melewati Captcha. Melanjutkan pengerjaan kuis secara otomatis...");
          isAgentRunning = true;
          startAgentLoop();
        });
      }
    }
  });

});

// ---- EXTRA MATH ENGINE (KATEX LOCAL RENDERING) ----
let katexLoaded = false;

function injectKaTexIfNeeded(cb) {
  if (katexLoaded) { cb(); return; }

  if (!document.getElementById('kx-css')) {
    const link = document.createElement('link');
    link.id = 'kx-css';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('lib/katex.min.css');
    document.head.appendChild(link);
  }

  if (!document.getElementById('kx-js')) {
    const s = document.createElement('script');
    s.id = 'kx-js';
    s.src = chrome.runtime.getURL('lib/katex.min.js');
    s.onload = () => {
      const s2 = document.createElement('script');
      s2.src = chrome.runtime.getURL('lib/auto-render.min.js');
      s2.onload = () => { katexLoaded = true; cb(); };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  }
}

function renderMathInToast(element) {
  injectKaTexIfNeeded(() => {
    if (window.renderMathInElement) {
      renderMathInElement(element, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$',  right: '$',  display: false }
        ],
        throwOnError: false
      });
    }
  });
}

// ---- API KONEKTOR (KAMUS MINI CLOUD) ----
const KAMUS_MINI_CLOUD_URL = 'https://mylms.melvino.online';
const CLOUD_BACKEND_READY = true; // Cloud-Ready Build: langsung terhubung ke mylms.melvino.online

async function fetchAnswer(query) {
  if (!query || query.trim().length < 5) return;
  if (!CLOUD_BACKEND_READY) {
    showToast('', 'Cloud Coming Soon', 'info');
    return;
  }

  try {
    const cfg = await new Promise(r => chrome.storage.local.get(['apiKey', 'selectedModelId'], r));
    const { body: data, limit } = await KamusMiniCloud.searchAnswer(cfg.apiKey, {
      query: query.trim(), modelId: cfg.selectedModelId || null
    });
    if (limit) { showToast('', `AI dilimit: ${limit.message}`, 'error'); return; }
    const answerText = data.jawaban || data.answer || '';
    if ((data.success !== false) && answerText) {
      showToast('', answerText, 'info');
      const toast = document.getElementById('g-dict-tooltip');
      if (toast) renderMathInToast(toast);
    }
  } catch (err) {
    console.error("Gagal melakukan pencarian pasif:", err);
  }
}

// ---- EXTENSION CONTEXT VALIDITY HELPER ----
function isExtensionValid() {
  try {
    return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

// ---- LOGGING AKTIVITAS & DIAGNOSTIK LENGKAP (TERSERI TANPA RACE CONDITION) ----
let _logWriteChain = Promise.resolve();

function enqueueStorageLogUpdate(updaterFn) {
  if (!isExtensionValid()) return Promise.resolve();
  _logWriteChain = _logWriteChain.then(() => new Promise((resolve) => {
    try {
      chrome.storage.local.get(['agentLogs', 'agentDebugLogs'], (res) => {
        if (chrome.runtime.lastError) {
          resolve();
          return;
        }
        try {
          const patch = updaterFn(res || {});
          if (patch && Object.keys(patch).length > 0) {
            chrome.storage.local.set(patch, () => resolve());
          } else {
            resolve();
          }
        } catch (e) {
          resolve();
        }
      });
    } catch (e) {
      resolve();
    }
  }));
  return _logWriteChain;
}

function logDebugEvent(category, level, message, data = null) {
  globalThis.KamusQuestionLogs?.event(category, level, message, data);
  const ts = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const iso = new Date().toISOString();
  const frameRole = (window === window.top) ? 'TOP' : 'IFRAME';
  const entry = { ts, iso, frame: frameRole, category, level, message };
  if (data !== null && data !== undefined) {
    entry.data = data;
  }

  const consoleLine = `[KamusMini][${frameRole}][${category}][${level}] ${message}`;
  if (level === 'ERROR') console.error(consoleLine, data || '');
  else if (level === 'WARN') console.warn(consoleLine, data || '');
  else console.log(consoleLine, data || '');

  if (!isExtensionValid()) return;
  enqueueStorageLogUpdate((res) => {
    const debugLogs = Array.isArray(res.agentDebugLogs) ? res.agentDebugLogs.slice() : [];
    debugLogs.push(entry);
    if (debugLogs.length > 200) debugLogs.splice(0, debugLogs.length - 200);
    return { agentDebugLogs: debugLogs };
  });
}

function logAgentActivity(message, level = null) {
  globalThis.KamusQuestionLogs?.event('ACTIVITY', level || 'INFO', message);
  const inferredLevel = level || (
    message.includes('❌') ? 'ERROR'
      : message.includes('⚠️') ? 'WARN'
      : (message.includes('Sukses') || message.includes('Berhasil') || message.includes('✅')) ? 'SUCCESS'
      : 'INFO'
  );
  const ts = new Date().toLocaleTimeString('id-ID', { hour12: false });
  console.log(`[AI Agent][${inferredLevel}] ${message}`);

  if (!isExtensionValid()) return;
  enqueueStorageLogUpdate((res) => {
    const logs = Array.isArray(res.agentLogs) ? res.agentLogs.slice() : [];
    logs.push(`[${ts}] ${message}`);
    if (logs.length > 150) logs.splice(0, logs.length - 150);

    const debugLogs = Array.isArray(res.agentDebugLogs) ? res.agentDebugLogs.slice() : [];
    debugLogs.push({
      ts,
      iso: new Date().toISOString(),
      frame: (window === window.top) ? 'TOP' : 'IFRAME',
      category: 'ACTIVITY',
      level: inferredLevel,
      message
    });
    if (debugLogs.length > 200) debugLogs.splice(0, debugLogs.length - 200);
    return { agentLogs: logs, agentDebugLogs: debugLogs };
  });
}

function saveCapturedDebugPreview(meta) {
  globalThis.KamusQuestionLogs?.preview(meta?.dataUrlPreview);
  if (!isExtensionValid()) return;
  try {
    chrome.storage.local.set({ lastCapturedDebug: meta });
  } catch (e) {}
}

function mergeCapturedDebugPreview(patch) {
  if (patch?.aiAnswer || patch?.aiChoice) globalThis.KamusQuestionLogs?.answer(patch);
  if (!isExtensionValid() || !patch) return;
  try {
    chrome.storage.local.get(['lastCapturedDebug'], (res) => {
      if (chrome.runtime.lastError) return;
      const base = (res && res.lastCapturedDebug && typeof res.lastCapturedDebug === 'object')
        ? res.lastCapturedDebug
        : {};
      chrome.storage.local.set({ lastCapturedDebug: { ...base, ...patch } });
    });
  } catch (e) {}
}

// ======================================================
// INTRO: AUTOMATED AI AGENT SOLVER IMPLEMENTATION
// ======================================================

// ---- SCRAPING HELPER (TAHAP 3: LATEX & DECORATIVE IMAGE FILTERING) ----
function isDecorativeImage(img) {
  if (!img) return false;
  if (img.closest && img.closest('.editor_atto_toolbar, .editor_atto_notification, .tox-editor-header, .mce-toolbar')) {
    return true;
  }
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const cw = img.clientWidth || img.width;
  const ch = img.clientHeight || img.height;
  if ((nw > 0 && nw <= 14 && nh > 0 && nh <= 14) || (cw > 0 && cw <= 14 && ch > 0 && ch <= 14)) {
    return true;
  }
  const className = String(img.className || '').toLowerCase();
  if (/(icon|smallicon|spacer|emoticon|pixel|blank)/i.test(className)) {
    return true;
  }
  const src = String(img.getAttribute('src') || '').toLowerCase();
  if (/(spacer\.gif|pixel\.gif|blank\.gif|pix\.gif|theme\/image\.php\/.*\/spacer)/i.test(src)) {
    return true;
  }
  const alt = String(img.getAttribute('alt') || '').trim();
  const role = String(img.getAttribute('role') || '').toLowerCase();
  const ariaHidden = img.getAttribute('aria-hidden') === 'true';
  if ((role === 'presentation' || ariaHidden) && !alt) {
    return true;
  }
  return false;
}

function isFormulaImage(img) {
  if (!img) return false;
  const src = String(img.getAttribute('src') || '').toLowerCase();
  const alt = String(img.getAttribute('alt') || '').trim();
  
  if (img.classList.contains('tex') || img.classList.contains('math') || img.classList.contains('equation')) {
    return true;
  }
  if (src.includes('/filter/tex/') || src.includes('/filter/mathjax/')) {
    return true;
  }
  if (alt && (/(\\[a-zA-Z]+|\^|_|\$)/.test(alt) || alt.startsWith('$$') || alt.startsWith('$'))) {
    return true;
  }
  return false;
}

function isContentImage(img) {
  if (!img) return false;
  if (isDecorativeImage(img)) return false;
  if (isFormulaImage(img)) {
    const alt = String(img.getAttribute('alt') || '').trim();
    if (alt) return false; // Rumus matematika LaTeX dapat diekstrak langsung dari atribut alt
  }
  return true;
}

function extractRichDomTextWithLatex(container) {
  if (!container) return "";
  const clone = container.cloneNode(true);

  // 1. Hapus elemen preview MathJax agar tidak ada teks rumus terduplikasi
  clone.querySelectorAll('.MathJax_Preview, .MJX_Assistive_MathML').forEach(el => el.remove());

  // 2. Konversi script MathJax Math/TeX ke format LaTeX $ ... $
  clone.querySelectorAll('script[type*="math/tex"]').forEach(s => {
    const tex = s.textContent.trim();
    const isDisplay = (s.getAttribute('type') || '').includes('display');
    const replacement = isDisplay ? `\n$$ ${tex} $$\n` : `$ ${tex} $`;
    s.replaceWith(document.createTextNode(replacement));
  });

  // 3. Konversi MathML MathJax v3 / KaTeX annotation ke $ ... $
  clone.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(ann => {
    const tex = ann.textContent.trim();
    const mathParent = ann.closest('math') || ann;
    mathParent.replaceWith(document.createTextNode(`$ ${tex} $`));
  });

  // 4. Konversi gambar rumus TeX Moodle ke teks LaTeX
  clone.querySelectorAll('img').forEach(img => {
    if (isDecorativeImage(img)) {
      img.remove();
      return;
    }
    if (isFormulaImage(img)) {
      let alt = (img.getAttribute('alt') || '').trim();
      alt = alt.replace(/^\$+|\$+$/g, '').trim();
      if (alt) {
        img.replaceWith(document.createTextNode(`$ ${alt} $`));
      } else {
        img.remove();
      }
      return;
    }
    // Gambar diagram / foto non-rumus
    img.replaceWith(document.createTextNode(' [Gambar Diagram] '));
  });

  // 5. Normalisasi line-break
  clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
  clone.querySelectorAll('p, div, li, tr').forEach(block => {
    block.appendChild(document.createTextNode('\n'));
  });

  return clone.textContent
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

function scrapeQuestionText(doc) {
  const d = doc || getQuizDocument() || document;
  const qtextEl = d.querySelector('.qtext');
  return qtextEl ? extractRichDomTextWithLatex(qtextEl) : "";
}

/**
 * Locate active input / rich-text editor targets for essay & short-answer Moodle questions.
 */
function findAnswerTextTargets(doc) {
  const d = doc || getQuizDocument() || document;
  const hasChoiceInputs = Boolean(d.querySelector('.answer input[type="radio"], .answer input[type="checkbox"]'));

  const attoEditable = d.querySelector('.answer .editor_atto_content[contenteditable="true"], .formulation .editor_atto_content[contenteditable="true"], .qtype_essay_response .editor_atto_content[contenteditable="true"]');
  const contentEditable = attoEditable || d.querySelector('.answer [contenteditable="true"], .qtype_essay_response [contenteditable="true"]');

  let tinymceBody = null;
  const iframes = d.querySelectorAll('.answer iframe, .qtype_essay_response iframe');
  for (const frame of iframes) {
    try {
      const fDoc = frame.contentDocument || frame.contentWindow?.document;
      const fBody = fDoc && fDoc.body;
      if (fBody && (fBody.isContentEditable || fBody.getAttribute('contenteditable') === 'true')) {
        tinymceBody = { iframe: frame, doc: fDoc, body: fBody };
        break;
      }
    } catch (_) {
      // Skip cross-origin frames safely
    }
  }

  let textarea = null;
  const editorContainer = (attoEditable || contentEditable)?.closest('.editor_atto_wrap, .qtype_essay_editor, .qtype_essay_response, .answer');
  if (editorContainer) {
    textarea = editorContainer.querySelector('textarea');
  }
  if (!textarea) {
    textarea = d.querySelector('.answer textarea, .qtype_essay_response textarea, .qtext textarea');
  }

  const textInput = d.querySelector('.answer input[type="text"], .answer input[type="number"], .qtext input[type="text"], .qtext input[type="number"]');

  return {
    hasChoiceInputs,
    attoEditable,
    contentEditable,
    tinymceBody,
    textarea,
    textInput
  };
}

/**
 * Detect Moodle question input type: 'choice' | 'essay' | 'shortanswer'.
 */
function detectQuizInputType(doc) {
  const d = doc || getQuizDocument() || document;
  const targets = findAnswerTextTargets(d);
  if (targets.hasChoiceInputs) return 'choice';

  const isEssayClass = Boolean(d.querySelector('.que.essay, .qtype_essay_response, .editor_atto_wrap'));
  if (isEssayClass || targets.attoEditable || targets.contentEditable || targets.tinymceBody || targets.textarea) {
    return 'essay';
  }
  if (d.querySelector('.que.shortanswer, .que.numerical') || targets.textInput) {
    return 'shortanswer';
  }
  return 'choice';
}

function scrapeOptionsText(doc) {
  const d = doc || getQuizDocument() || document;
  if (detectQuizInputType(d) !== 'choice') {
    return [];
  }
  const optionElements = d.querySelectorAll('.answer > div');
  return Array.from(optionElements).map((el, idx) => {
    const numEl = el.querySelector('.answernumber');
    const textEl = el.querySelector('.flex-fill') || el.querySelector('label') || el;
    
    // Fallback otomatis A, B, C, D... jika soal tidak punya .answernumber (seperti True/False)
    let label = String.fromCharCode(65 + Math.min(idx, 25));
    if (numEl) {
      const numText = numEl.textContent.trim().toUpperCase().replace(/[^A-E]/g, '');
      if (['A', 'B', 'C', 'D', 'E'].includes(numText)) {
        label = numText;
      }
    }
    
    let text = extractRichDomTextWithLatex(textEl);
    if (numEl) {
      const numStr = numEl.textContent.trim();
      if (text.startsWith(numStr)) {
        text = text.slice(numStr.length).trim();
      }
    }
    if (!text) {
      const img = textEl.querySelector('img') || el.querySelector('img');
      if (img) {
        const alt = (img.getAttribute('alt') || '').trim();
        const isRawFilename = !alt || /\.(jpe?g|png|gif|webp|bmp|svg)(\?.*)?$/i.test(alt);
        text = isRawFilename
          ? `[Lihat nilai pilihan ${label} pada gambar]`
          : `[Gambar / Rumus (${alt})]`;
      }
    }
    return `${label}. ${text}`;
  });
}

function checkForImageTags(doc) {
  const d = doc || getQuizDocument() || document;
  const qtext = d.querySelector('.qtext');
  const answers = d.querySelector('.answer');

  const hasContentImg = (container) => {
    if (!container) return false;
    const imgs = Array.from(container.querySelectorAll('img'));
    return imgs.some(img => isContentImage(img));
  };

  return hasContentImg(qtext) || hasContentImg(answers);
}

function inspectFormulationImages(container) {
  if (!container) return { total: 0, loaded: 0, pending: 0, broken: 0 };
  const imgs = Array.from(container.querySelectorAll('img'));
  let loaded = 0;
  let pending = 0;
  let broken = 0;
  for (const img of imgs) {
    if (!img.complete) pending++;
    else if (img.naturalWidth > 0) loaded++;
    else broken++;
  }
  return { total: imgs.length, loaded, pending, broken };
}

async function waitForElementImages(container, timeoutMs = 1200) {
  const imgs = Array.from(container.querySelectorAll('img')).filter(img => !img.complete);
  if (imgs.length === 0) return inspectFormulationImages(container);

  await Promise.race([
    Promise.all(imgs.map(img => new Promise(res => {
      const done = () => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
        res();
      };
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }))),
    new Promise(res => setTimeout(res, timeoutMs))
  ]);
  return inspectFormulationImages(container);
}

// ---- MOUSE & ULTRA-SMOOTH EASING SCROLL ENGINE ----
let _activeScrollCancel = null;

function easeInOutQuint(t) {
  return t < 0.5
    ? 16 * t * t * t * t * t
    : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

function getEffectiveScrollTarget(element, doc) {
  const container = getScrollContainer(element, doc);
  if (container) return { type: 'element', el: container, doc };
  const targetDoc = doc || document;
  const rootEl = targetDoc.scrollingElement || targetDoc.documentElement || targetDoc.body;
  return { type: 'document', el: rootEl, doc: targetDoc };
}

function smoothScrollTo(element, options = {}) {
  return new Promise((resolve) => {
    if (!element) { resolve(); return; }
    if (_activeScrollCancel) {
      try { _activeScrollCancel(); } catch (_) {}
      _activeScrollCancel = null;
    }

    const d = element.ownerDocument || getQuizDocument() || document;
    const win = d.defaultView || window;
    const target = getEffectiveScrollTarget(element, d);
    const scroller = target.el;
    if (!scroller) { resolve(); return; }

    const rect = element.getBoundingClientRect();
    const isDocScroller = (target.type === 'document');
    const viewportH = isDocScroller ? (win.innerHeight || scroller.clientHeight || 800) : (scroller.clientHeight || win.innerHeight || 800);
    const containerTop = isDocScroller ? 0 : scroller.getBoundingClientRect().top;
    const currentScrollTop = isDocScroller ? (win.scrollY ?? scroller.scrollTop ?? 0) : scroller.scrollTop;
    const maxScrollTop = Math.max(0, (scroller.scrollHeight || 0) - viewportH);

    const topOffset = options.topOffset !== undefined ? options.topOffset : 84;
    const block = options.block || 'smart';

    let desiredRelativeTop;
    if (block === 'center' || (block === 'smart' && rect.height <= viewportH * 0.48)) {
      desiredRelativeTop = Math.max(topOffset, (viewportH - rect.height) / 2);
    } else {
      desiredRelativeTop = topOffset;
    }

    const elemOffsetFromContainerTop = rect.top - containerTop;
    const rawTargetTop = currentScrollTop + elemOffsetFromContainerTop - desiredRelativeTop;
    const targetTop = Math.max(0, Math.min(maxScrollTop, Math.round(rawTargetTop)));
    const delta = targetTop - currentScrollTop;

    // Jika elemen sudah berada nyaman di posisi pandang, lewati animasi agar tidak berkedut
    if (Math.abs(delta) < 18) {
      resolve();
      return;
    }

    // Jika tab tidak aktif (rAF di-throttle Chrome), geser langsung agar tidak macet
    if (d.hidden) {
      if (isDocScroller) win.scrollTo(win.scrollX, targetTop);
      else scroller.scrollTop = targetTop;
      resolve();
      return;
    }

    const maxDuration = options.maxDuration !== undefined ? options.maxDuration : 920;
    const duration = Math.min(maxDuration, Math.max(440, Math.round(Math.abs(delta) * 0.62)));
    const startTs = performance.now();
    let rafId = null;
    let settled = false;

    const finish = (applyFinal = true) => {
      if (settled) return;
      settled = true;
      if (rafId !== null) win.cancelAnimationFrame(rafId);
      clearTimeout(safetyTimer);
      if (applyFinal) {
        if (isDocScroller) win.scrollTo(win.scrollX, targetTop);
        else scroller.scrollTop = targetTop;
      }
      if (_activeScrollCancel === cancel) _activeScrollCancel = null;
      resolve();
    };

    const cancel = () => finish(false);
    _activeScrollCancel = cancel;

    const step = (now) => {
      if (settled) return;
      const elapsed = now - startTs;
      const progress = Math.min(1, elapsed / duration);
      const eased = easeInOutQuint(progress);
      const nextTop = currentScrollTop + delta * eased;

      if (isDocScroller) win.scrollTo(win.scrollX, nextTop);
      else scroller.scrollTop = nextTop;

      if (progress < 1) {
        rafId = win.requestAnimationFrame(step);
      } else {
        finish(true);
      }
    };

    const safetyTimer = setTimeout(() => finish(true), duration + 140);
    rafId = win.requestAnimationFrame(step);
  });
}

// ---- SCREENSHOT & ELEMENT CROPPING HELPER (STICKY-FREE SCROLL-AND-STITCH) ----
let lastTabCaptureTs = 0;

async function requestTabCaptureDataUrl(retryLeft = 1, diagOut = null) {
  if (!isExtensionValid()) {
    const errMsg = "Koneksi ekstensi terputus (Extension context invalidated). Silakan refresh halaman (F5).";
    console.warn(errMsg);
    if (diagOut) diagOut.captureError = errMsg;
    return null;
  }

  // Chrome MV3 membatasi captureVisibleTab maksimal 2 kali per detik
  const elapsed = Date.now() - lastTabCaptureTs;
  if (lastTabCaptureTs > 0 && elapsed < 580) {
    await new Promise(r => setTimeout(r, 580 - elapsed));
  }

  return await new Promise((resolve) => {
    try {
      lastTabCaptureTs = Date.now();
      chrome.runtime.sendMessage({ action: "captureVisibleTab" }, async (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "Unknown runtime error";
          console.warn("captureVisibleTab error:", msg);
          if (retryLeft > 0 && /MAX_CAPTURE|quota/i.test(msg)) {
            await new Promise(r => setTimeout(r, 650));
            resolve(await requestTabCaptureDataUrl(retryLeft - 1, diagOut));
            return;
          }
          if (diagOut) diagOut.captureError = `runtime.lastError: ${msg}`;
          resolve(null);
          return;
        }
        if (!response || !response.success || !response.dataUrl) {
          const errMsg = response ? (response.error || "Unknown background error") : "Empty response from background";
          if (retryLeft > 0 && /MAX_CAPTURE|quota/i.test(errMsg)) {
            await new Promise(r => setTimeout(r, 650));
            resolve(await requestTabCaptureDataUrl(retryLeft - 1, diagOut));
            return;
          }
          console.error("Gagal mengambil screenshot dari background:", errMsg);
          if (diagOut) diagOut.captureError = `background captureVisibleTab: ${errMsg}`;
          resolve(null);
          return;
        }
        if (diagOut) {
          diagOut.windowId = response.windowId ?? null;
          diagOut.tabId = response.tabId ?? null;
        }
        resolve(response.dataUrl);
      });
    } catch (err) {
      if (diagOut) diagOut.captureError = `sendMessage throw: ${err.message}`;
      resolve(null);
    }
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function sampleCanvasBlankness(canvas) {
  try {
    const sw = 32;
    const sh = 32;
    const probe = document.createElement('canvas');
    probe.width = sw;
    probe.height = sh;
    const pCtx = probe.getContext('2d');
    pCtx.drawImage(canvas, 0, 0, sw, sh);
    const data = pCtx.getImageData(0, 0, sw, sh).data;
    let nonWhitePixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 10 && (r < 246 || g < 246 || b < 246)) {
        nonWhitePixels++;
      }
    }
    return {
      sampledPixels: sw * sh,
      nonWhitePixels,
      isLikelyBlank: nonWhitePixels === 0
    };
  } catch (e) {
    return { sampledPixels: 0, nonWhitePixels: -1, isLikelyBlank: false, sampleError: e.message };
  }
}

function computeFrameViewportBounds(targetDoc) {
  let clipLeft = 0;
  let clipTop = 0;
  let clipRight = window.innerWidth;
  let clipBottom = window.innerHeight;
  let absLeft = 0;
  let absTop = 0;
  let iframeChain = [];
  let sourceType = 'main_document';

  if (targetDoc !== document) {
    const ctx = findQuizContextInRoot(document, targetDoc);
    iframeChain = ctx ? ctx.iframeChain : [];
    sourceType = ctx ? ctx.sourceType : 'detached_doc';
    for (const ifr of iframeChain) {
      const r = ifr.getBoundingClientRect();
      const cLeft = absLeft + r.left + (ifr.clientLeft || 0);
      const cTop = absTop + r.top + (ifr.clientTop || 0);
      const cRight = cLeft + (ifr.clientWidth || r.width);
      const cBottom = cTop + (ifr.clientHeight || r.height);
      clipLeft = Math.max(clipLeft, cLeft);
      clipTop = Math.max(clipTop, cTop);
      clipRight = Math.min(clipRight, cRight);
      clipBottom = Math.min(clipBottom, cBottom);
      absLeft = cLeft;
      absTop = cTop;
    }
  }

  return { absLeft, absTop, clipLeft, clipTop, clipRight, clipBottom, iframeChain, sourceType };
}

function isScrollableNode(node) {
  if (!node || node.scrollHeight <= node.clientHeight + 2) return false;
  const before = node.scrollTop;
  const probe = (before > 0) ? (before - 1) : 1;
  node.scrollTop = probe;
  const changed = Math.abs(node.scrollTop - before) > 0.2;
  node.scrollTop = before;
  return changed;
}

function getScrollContainer(element, doc) {
  const win = doc.defaultView || window;
  let cur = element.parentElement;
  while (cur && cur !== doc.body && cur !== doc.documentElement) {
    try {
      const ovY = win.getComputedStyle(cur).overflowY;
      if ((ovY === 'auto' || ovY === 'scroll' || ovY === 'overlay') && isScrollableNode(cur)) {
        return cur;
      }
    } catch (e) {}
    cur = cur.parentElement;
  }

  const candidates = [doc.scrollingElement, doc.body, doc.documentElement];
  for (const cand of candidates) {
    if (cand && isScrollableNode(cand)) return cand;
  }
  return doc.scrollingElement || doc.documentElement || doc.body || null;
}

function hideOverlayElement(el, element, hiddenMap) {
  if (!el || hiddenMap.has(el) || el === element) return false;
  try {
    if (el.contains(element) || element.contains(el)) return false;
  } catch (e) {
    return false;
  }
  hiddenMap.set(el, {
    opacityVal: el.style.getPropertyValue('opacity'),
    opacityPrio: el.style.getPropertyPriority('opacity'),
    visibilityVal: el.style.getPropertyValue('visibility'),
    visibilityPrio: el.style.getPropertyPriority('visibility'),
    transitionVal: el.style.getPropertyValue('transition'),
    transitionPrio: el.style.getPropertyPriority('transition')
  });
  // Matikan transisi CSS seketika agar toast/navbar langsung lenyap di frame yang sama
  el.style.setProperty('transition', 'none', 'important');
  el.style.setProperty('opacity', '0', 'important');
  el.style.setProperty('visibility', 'hidden', 'important');
  return true;
}

function hideObstructingOverlays(element, doc, rectInDoc, frameBounds, hiddenMap) {
  let newlyHidden = 0;
  const dWin = doc.defaultView || window;

  // 1. Sembunyikan toast ekstensi (#g-dict-tooltip) di top frame & iframe
  for (const targetRoot of [document, doc]) {
    try {
      const toast = targetRoot.getElementById ? targetRoot.getElementById('g-dict-tooltip') : null;
      if (toast && hideOverlayElement(toast, element, hiddenMap)) newlyHidden++;
    } catch (e) {}
  }

  // 2. Sembunyikan header/navbar/drawer/timer bertipe fixed/sticky yang berpotensi menimpa area soal
  try {
    const candidates = doc.querySelectorAll(
      'header, nav, .s-top, #topBarContainer, .fixed-top, .sticky-top, [id*="topBar"], [id*="quiz-timer"], [class*="floating"], [class*="drawer"], [id*="drawer"]'
    );
    for (const cand of candidates) {
      if (hiddenMap.has(cand)) continue;
      const pos = dWin.getComputedStyle(cand).position;
      if ((pos === 'fixed' || pos === 'sticky') && hideOverlayElement(cand, element, hiddenMap)) {
        newlyHidden++;
      }
    }
  } catch (e) {}

  // 3. Deteksi geometris elemen penutup via elementsFromPoint di dalam slice yang terlihat
  const visWinLeft = Math.max(frameBounds.clipLeft, frameBounds.absLeft + rectInDoc.left);
  const visWinRight = Math.min(frameBounds.clipRight, frameBounds.absLeft + rectInDoc.right);
  const visWinTop = Math.max(frameBounds.clipTop, frameBounds.absTop + rectInDoc.top);
  const visWinBottom = Math.min(frameBounds.clipBottom, frameBounds.absTop + rectInDoc.bottom);

  if (visWinRight - visWinLeft > 12 && visWinBottom - visWinTop > 12) {
    const docClipLeft = visWinLeft - frameBounds.absLeft;
    const docClipRight = visWinRight - frameBounds.absLeft;
    const docClipTop = visWinTop - frameBounds.absTop;
    const docClipBottom = visWinBottom - frameBounds.absTop;

    const xs = [
      docClipLeft + 1,
      docClipLeft + 10,
      (docClipLeft + docClipRight) / 2,
      docClipRight - 10,
      docClipRight - 1
    ].filter(x => x > docClipLeft && x < docClipRight);
    const ys = [
      docClipTop + 2,
      Math.min(docClipBottom - 4, docClipTop + 14),
      Math.min(docClipBottom - 4, docClipTop + 32),
      (docClipTop + docClipBottom) / 2,
      Math.max(docClipTop + 4, docClipBottom - 14),
      docClipBottom - 2
    ].filter(y => y > docClipTop && y < docClipBottom);

    if (doc.elementsFromPoint) {
      for (const y of ys) {
        for (const x of xs) {
          let stack = [];
          try { stack = doc.elementsFromPoint(x, y); } catch (e) {}
          for (const hit of stack) {
            if (!hit || hit === doc.body || hit === doc.documentElement) continue;
            if (hit === element || element.contains(hit)) break; // Sudah sampai elemen soal
            if (hit.contains(element)) continue;

            // Cari ancestor terdekat bertipe fixed/sticky/floating di bawah root pembungkus bersama
            let cur = hit;
            let overlayTarget = null;
            while (cur && cur !== doc.body && cur !== doc.documentElement && !cur.contains(element)) {
              const st = dWin.getComputedStyle(cur);
              const pos = st.position;
              const z = parseInt(st.zIndex, 10);
              if (pos === 'fixed' || pos === 'sticky' || (pos === 'absolute' && !Number.isNaN(z) && z > 0)) {
                overlayTarget = cur;
              }
              cur = cur.parentElement;
            }
            if (overlayTarget && hideOverlayElement(overlayTarget, element, hiddenMap)) {
              newlyHidden++;
            }
          }
        }
      }
    }

    // 4. Cek overlay di top frame / shadow DOM yang mungkin menutup atas iframe
    if (doc !== document) {
      const topRoots = [document];
      try {
        const rw = document.querySelector('replay-web-page');
        if (rw && rw.shadowRoot) topRoots.push(rw.shadowRoot);
      } catch (e) {}

      const winXs = [visWinLeft + 8, (visWinLeft + visWinRight) / 2, visWinRight - 8];
      const winYs = [visWinTop + 4, (visWinTop + visWinBottom) / 2, visWinBottom - 6];
      const chainSet = new Set(frameBounds.iframeChain || []);
      const elementHostsTarget = (candidate, targetSet) => {
        for (const t of targetSet) {
          try {
            if (candidate === t || candidate.contains(t)) return true;
            let root = t.getRootNode ? t.getRootNode() : null;
            while (root && root.host) {
              if (candidate === root.host || candidate.contains(root.host)) return true;
              root = root.host.getRootNode ? root.host.getRootNode() : null;
            }
          } catch (e) {}
        }
        return false;
      };

      for (const root of topRoots) {
        if (!root.elementsFromPoint) continue;
        for (const wy of winYs) {
          for (const wx of winXs) {
            let stack = [];
            try { stack = root.elementsFromPoint(wx, wy); } catch (e) {}
            for (const hit of stack) {
              if (!hit || hit === document.body || hit === document.documentElement) continue;
              if (chainSet.has(hit) || elementHostsTarget(hit, chainSet)) break;

              const st = window.getComputedStyle(hit);
              if ((st.position === 'fixed' || st.position === 'sticky') && hideOverlayElement(hit, element, hiddenMap)) {
                newlyHidden++;
              }
            }
          }
        }
      }
    }
  }

  return newlyHidden > 0;
}

function restoreHiddenOverlays(hiddenMap) {
  for (const [el, orig] of hiddenMap.entries()) {
    try {
      if (orig.opacityVal) {
        el.style.setProperty('opacity', orig.opacityVal, orig.opacityPrio || '');
      } else {
        el.style.removeProperty('opacity');
      }
      if (orig.visibilityVal) {
        el.style.setProperty('visibility', orig.visibilityVal, orig.visibilityPrio || '');
      } else {
        el.style.removeProperty('visibility');
      }
      if (orig.transitionVal) {
        el.style.setProperty('transition', orig.transitionVal, orig.transitionPrio || '');
      } else {
        el.style.removeProperty('transition');
      }
    } catch (e) {}
  }
  hiddenMap.clear();
}

async function captureFormulationElement(scopeOrDoc, diagOut = null) {
  const diag = diagOut || {};
  diag.frameRole = (window === window.top) ? 'TOP' : 'IFRAME';
  diag.pageUrl = window.location.href;
  diag.viewport = { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  diag.slices = [];
  diag.overlaysHidden = [];

  const { doc: d, scope } = resolveQuizDocAndScope(scopeOrDoc);
  const qtextCandidate = scope.querySelector('.qtext');
  const answerEl = scope.querySelector('.answer');
  const answerHasContentImg = answerEl
    ? Array.from(answerEl.querySelectorAll('img')).some(img => isContentImage(img))
    : false;
  const preferEssayQtext = detectQuizInputType(scope) === 'essay'
    && qtextCandidate
    && !answerHasContentImg
    && qtextCandidate.getBoundingClientRect().height > 20;

  const element = preferEssayQtext
    ? qtextCandidate
    : ((scope !== d && scope.classList?.contains('formulation'))
      ? scope
      : (scope.querySelector('.formulation') || qtextCandidate || (scope !== d ? scope : d.querySelector('.que'))));
  if (!element) {
    diag.failReason = "Elemen .formulation / .qtext / .que tidak ditemukan pada targetDoc";
    logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
    return null;
  }

  const dWin = d.defaultView || window;
  const scrollContainer = getScrollContainer(element, d);
  diag.scrollContainer = scrollContainer
    ? `${scrollContainer.tagName}${scrollContainer.id ? '#' + scrollContainer.id : ''} (${scrollContainer.scrollHeight}/${scrollContainer.clientHeight})`
    : 'none';
  const origInnerScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
  const origInnerScrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
  const origTopScrollY = (d !== document) ? window.scrollY : 0;
  const hiddenOverlays = new Map();

  const waitFrames = async (ms = 35) => {
    await new Promise(r => setTimeout(r, ms));
    await new Promise(r => (dWin.requestAnimationFrame || window.requestAnimationFrame)(r));
  };

  let didStitchScroll = false;
  try {
    // Tunggu sejenak jika masih ada gambar soal/opsi yang belum selesai dimuat (misal dari Service Worker ReplayWeb)
    diag.imgStats = await waitForElementImages(element, 1200);

    // 1. Hanya gulir jika area soal belum terlihat utuh di viewport (hindari snap mendadak setelah smoothScrollTo)
    const preBounds = computeFrameViewportBounds(d);
    const preVisRect = element.getBoundingClientRect();
    const preAbsTop = preBounds.absTop + preVisRect.top;
    const preAbsBottom = preBounds.absTop + preVisRect.bottom;
    const isAlreadyFullyVisible = (preAbsTop >= preBounds.clipTop + 2 && preAbsBottom <= preBounds.clipBottom - 2);
    if (!isAlreadyFullyVisible) {
      await smoothScrollTo(element, { block: 'start', topOffset: 16, maxDuration: 420 });
      await waitFrames(45);
    }

    const initialBounds = computeFrameViewportBounds(d);
    diag.sourceType = initialBounds.sourceType;
    diag.iframeChainLen = initialBounds.iframeChain.length;
    diag.initialBounds = {
      absLeft: Math.round(initialBounds.absLeft),
      absTop: Math.round(initialBounds.absTop),
      clipLeft: Math.round(initialBounds.clipLeft),
      clipTop: Math.round(initialBounds.clipTop),
      clipRight: Math.round(initialBounds.clipRight),
      clipBottom: Math.round(initialBounds.clipBottom)
    };

    if (initialBounds.clipRight <= initialBounds.clipLeft || initialBounds.clipBottom <= initialBounds.clipTop) {
      diag.failReason = `Viewport iframe tidak terlihat / kosong (clip: ${diag.initialBounds.clipLeft},${diag.initialBounds.clipTop}..${diag.initialBounds.clipRight},${diag.initialBounds.clipBottom})`;
      logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
      return null;
    }

    const initRect = element.getBoundingClientRect();
    const elemCssW = Math.ceil(initRect.width);
    const elemCssH = Math.ceil(initRect.height);
    diag.elemCssSize = { width: elemCssW, height: elemCssH, left: Math.round(initRect.left), top: Math.round(initRect.top) };
    if (elemCssW <= 0 || elemCssH <= 0) {
      diag.failReason = `Dimensi elemen soal nol (${elemCssW}x${elemCssH})`;
      logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
      return null;
    }

    let finalCanvas = null;
    let finalCtx = null;
    let imgScaleX = window.devicePixelRatio || 1;
    let imgScaleY = window.devicePixelRatio || 1;
    let outScaleX = imgScaleX;
    let outScaleY = imgScaleY;

    let capturedElemY = 0;
    const maxSlices = 12;

    for (let sliceIdx = 0; sliceIdx < maxSlices && capturedElemY < elemCssH - 1; sliceIdx++) {
      // 2. Pada slice pertama, pertahankan posisi halus bila seluruh elemen muat di viewport;
      //    hanya geser jika elemen terpotong viewport atau sedang menyambung slice berikutnya
      const boundsNow = computeFrameViewportBounds(d);
      const preRect = element.getBoundingClientRect();
      const targetLineScreenY = boundsNow.absTop + preRect.top + capturedElemY;
      const elemBottomScreenY = boundsNow.absTop + preRect.bottom;
      const desiredScreenY = boundsNow.clipTop + ((boundsNow.clipBottom - boundsNow.clipTop > 20) ? 3 : 0);
      const fitsInCurrentViewport = (sliceIdx === 0 && capturedElemY === 0 && targetLineScreenY >= boundsNow.clipTop + 2 && elemBottomScreenY <= boundsNow.clipBottom - 2);
      const scrollDelta = fitsInCurrentViewport ? 0 : (targetLineScreenY - desiredScreenY);

      let scrolled = false;
      if (Math.abs(scrollDelta) > 1.5) {
        didStitchScroll = true;
        if (scrollContainer) {
          const prev = scrollContainer.scrollTop;
          scrollContainer.scrollTop = prev + scrollDelta;
          if (Math.abs(scrollContainer.scrollTop - prev) > 0.5) scrolled = true;
        }
        if (!scrolled && d !== document) {
          const prevWinY = window.scrollY;
          window.scrollBy(0, scrollDelta);
          if (Math.abs(window.scrollY - prevWinY) > 0.5) scrolled = true;
        }
        if (scrolled) await waitFrames(50);
      }

      // 3. Sembunyikan sticky navbar / floating badge / toast yang menutupi potongan ini
      const liveBounds = computeFrameViewportBounds(d);
      const rectBeforeHide = element.getBoundingClientRect();
      const didHide = hideObstructingOverlays(element, d, rectBeforeHide, liveBounds, hiddenOverlays);
      if (didHide) await waitFrames(45);

      const finalBounds = computeFrameViewportBounds(d);
      const rectNow = element.getBoundingClientRect();

      const elemWinLeft = finalBounds.absLeft + rectNow.left;
      const elemWinTop = finalBounds.absTop + rectNow.top;
      const elemWinRight = finalBounds.absLeft + rectNow.right;
      const elemWinBottom = finalBounds.absTop + rectNow.bottom;

      const visWinLeft = Math.max(finalBounds.clipLeft, elemWinLeft);
      const visWinRight = Math.min(finalBounds.clipRight, elemWinRight);
      const visWinTop = Math.max(finalBounds.clipTop, elemWinTop + capturedElemY);
      const visWinBottom = Math.min(finalBounds.clipBottom, elemWinBottom);

      const sliceCssW = visWinRight - visWinLeft;
      const sliceCssH = visWinBottom - visWinTop;
      if (sliceCssW <= 1 || sliceCssH <= 1) {
        if (sliceIdx === 0) {
          diag.failReason = `Slice awal di luar clip viewport (sliceCss: ${sliceCssW.toFixed(1)}x${sliceCssH.toFixed(1)}, elemWinTop: ${elemWinTop.toFixed(1)})`;
        }
        break;
      }

      // 4. Tangkap tab aktual dan jahit potongan pada resolusi penuh (tanpa downscale CSS transform)
      const capT0 = Date.now();
      const dataUrl = await requestTabCaptureDataUrl(1, diag);
      const capMs = Date.now() - capT0;
      if (!dataUrl) {
        if (sliceIdx === 0) {
          diag.failReason = diag.captureError || "requestTabCaptureDataUrl gagal mengembalikan gambar";
          logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
          return null;
        }
        break;
      }

      const img = await loadImageFromDataUrl(dataUrl);
      if (!img) {
        if (sliceIdx === 0) {
          diag.failReason = "loadImageFromDataUrl gagal (kemungkinan diblokir CSP data: URL)";
          logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
          return null;
        }
        break;
      }

      if (!finalCanvas) {
        imgScaleX = img.width / Math.max(1, window.innerWidth);
        imgScaleY = img.height / Math.max(1, window.innerHeight);
        outScaleX = Math.min(2, imgScaleX);
        outScaleY = Math.min(2, imgScaleY);

        finalCanvas = document.createElement('canvas');
        finalCanvas.width = Math.max(1, Math.round(elemCssW * outScaleX));
        finalCanvas.height = Math.max(1, Math.round(elemCssH * outScaleY));
        finalCtx = finalCanvas.getContext('2d');
        finalCtx.fillStyle = '#ffffff';
        finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
      }

      const sx = Math.max(0, Math.round(visWinLeft * imgScaleX));
      const sy = Math.max(0, Math.round(visWinTop * imgScaleY));
      const sRight = Math.min(img.width, Math.round(visWinRight * imgScaleX));
      const sBottom = Math.min(img.height, Math.round(visWinBottom * imgScaleY));
      const sw = sRight - sx;
      const sh = sBottom - sy;
      if (sw <= 0 || sh <= 0) {
        if (sliceIdx === 0) diag.failReason = `Koordinat sumber crop kosong (sw=${sw}, sh=${sh})`;
        break;
      }

      const sliceStartInElemX = Math.max(0, visWinLeft - elemWinLeft);
      const sliceStartInElemY = Math.max(0, visWinTop - elemWinTop);
      const dx = Math.round(sliceStartInElemX * outScaleX);
      const dy = Math.round(sliceStartInElemY * outScaleY);
      const dw = Math.max(1, Math.round(sliceCssW * outScaleX));
      const dh = Math.max(1, Math.round(sliceCssH * outScaleY));

      finalCtx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      diag.slices.push({
        idx: sliceIdx + 1,
        src: [sx, sy, sw, sh],
        dst: [dx, dy, dw, dh],
        tabImg: [img.width, img.height],
        captureMs: capMs
      });

      const newCapturedY = sliceStartInElemY + sliceCssH;
      if (newCapturedY <= capturedElemY + 1) break;
      capturedElemY = newCapturedY;
    }

    for (const overlayEl of hiddenOverlays.keys()) {
      diag.overlaysHidden.push(
        `${overlayEl.tagName}${overlayEl.id ? '#' + overlayEl.id : ''}${typeof overlayEl.className === 'string' && overlayEl.className ? '.' + overlayEl.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`
      );
    }

    if (!finalCanvas || diag.slices.length === 0) {
      if (!diag.failReason) diag.failReason = "Kanvas tangkapan kosong (0 potongan tergambar)";
      logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
      return null;
    }

    diag.canvasSize = { width: finalCanvas.width, height: finalCanvas.height };
    diag.blankCheck = sampleCanvasBlankness(finalCanvas);

    const blob = await new Promise((resolve) => {
      finalCanvas.toBlob((b) => resolve(b), 'image/png');
    });
    if (!blob) {
      diag.failReason = "finalCanvas.toBlob menghasilkan null";
      logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
      return null;
    }
    diag.sizeKB = Number((blob.size / 1024).toFixed(1));

    const level = diag.blankCheck.isLikelyBlank ? 'WARN' : 'INFO';
    logDebugEvent('CAPTURE', level,
      diag.blankCheck.isLikelyBlank
        ? `⚠️ Hasil tangkapan terdeteksi putih polos (${diag.canvasSize.width}x${diag.canvasSize.height}, ${diag.slices.length} slice)!`
        : `Capture selesai: ${diag.canvasSize.width}x${diag.canvasSize.height} (${diag.sizeKB} KB, ${diag.slices.length} slice)`,
      diag
    );
    return blob;
  } catch (err) {
    diag.failReason = `Exception: ${err.message}`;
    logDebugEvent('CAPTURE', 'ERROR', diag.failReason, diag);
    console.warn("captureFormulationElement error:", err);
    return null;
  } finally {
    restoreHiddenOverlays(hiddenOverlays);
    try {
      if (didStitchScroll) {
        if (scrollContainer) {
          scrollContainer.scrollTop = origInnerScrollTop;
          scrollContainer.scrollLeft = origInnerScrollLeft;
        }
        if (d !== document && window.scrollY !== origTopScrollY) {
          window.scrollTo(window.scrollX, origTopScrollY);
        }
      }
    } catch (e) {}
  }
}

// ---- CLICK SIMULATOR (TAHAP 5: MULTI-TYPE MOODLE INPUTS - RADIO, CHECKBOX, TEXT) ----
function clickInputOption(optionElement, preserveOthers = false) {
  const input = optionElement.querySelector('input[type="radio"], input[type="checkbox"]');
  if (input && input.isConnected !== false && !input.disabled && !input.matches(':disabled')) {
    if (input.type === 'checkbox') {
      if (!input.checked) {
        input.click();
      }
    } else {
      if (!input.checked) input.click();
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!input.checked || input.isConnected === false) return false;
    
    // Bersihkan outline dari opsi lain di pertanyaan yang sama jika ini adalah radio
    const parent = optionElement.closest('.answer') || optionElement.parentElement;
    if (parent && !preserveOthers && input.type === 'radio') {
      const siblings = parent.querySelectorAll('[data-km-selected]');
      siblings.forEach(el => {
        el.removeAttribute('data-km-selected');
        el.style.outline = 'none';
        el.style.outlineOffset = '0';
      });
    }

    // Penanda kotak halus tanpa latar dan tanpa pergeseran layout/padding
    optionElement.setAttribute('data-km-selected', 'true');
    optionElement.style.outline = '1.5px solid #0d7480';
    optionElement.style.outlineOffset = '2px';
    optionElement.style.borderRadius = '4px';
    optionElement.style.backgroundColor = 'transparent';
    optionElement.style.transition = 'outline 0.15s ease';
    return true;
  }
  return false;
}
const clickRadioOption = clickInputOption;

function escapeHtmlForEditor(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAnswerAsHtmlParagraphs(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (!normalized) return '';
  const lines = normalized.split('\n');
  return lines.map(line => {
    const trimmedRight = line.replace(/\s+$/g, '');
    return trimmedRight ? `<p>${escapeHtmlForEditor(trimmedRight)}</p>` : '<p><br></p>';
  }).join('');
}

function setNativeControlValue(el, value) {
  if (!el) return;
  const win = el.ownerDocument?.defaultView || window;
  const proto = el.tagName === 'TEXTAREA'
    ? (win.HTMLTextAreaElement?.prototype || HTMLTextAreaElement.prototype)
    : (win.HTMLInputElement?.prototype || HTMLInputElement.prototype);
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

function styleSelectedTarget(el) {
  if (!el) return;
  el.setAttribute('data-km-selected', 'true');
  el.style.outline = '1.5px solid #0d7480';
  el.style.outlineOffset = '1px';
  el.style.borderRadius = '4px';
}

function dispatchTypingEvents(el, chunkText = '') {
  if (!el) return;
  const win = el.ownerDocument?.defaultView || window;
  try {
    if (typeof win.InputEvent === 'function') {
      el.dispatchEvent(new win.InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: chunkText
      }));
    } else {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch (_) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  try {
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
  } catch (_) {}
}

function dispatchCommitEvents(el) {
  if (!el) return;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function typeTextGradually(fullText, onStep, shouldContinue = () => true) {
  const str = String(fullText || '');
  const len = str.length;
  if (len === 0) return;

  const chunkSize = len <= 28 ? 2 : Math.max(3, Math.ceil(len / 28));
  let pos = 0;
  while (pos < len) {
    if (!shouldContinue()) return;
    const nextPos = Math.min(len, pos + chunkSize);
    const partial = str.slice(0, nextPos);
    const chunk = str.slice(pos, nextPos);
    onStep(partial, chunk);
    pos = nextPos;
    if (pos < len) {
      await new Promise(r => setTimeout(r, 16));
    }
  }
}

/**
 * Type answer cleanly into Moodle Atto, TinyMCE iframe, generic contenteditable, textarea, or input.
 */
async function fillTextInputOption(answerText, doc, shouldContinue = () => true) {
  if (!shouldContinue()) return { success: false };
  const cleanText = String(answerText || '').trim();
  if (!cleanText) return { success: false };

  const d = doc || getQuizDocument() || document;
  const targets = findAnswerTextTargets(d);
  const visualRichEl = targets.attoEditable
    || targets.contentEditable
    || (targets.tinymceBody ? targets.tinymceBody.body : null);

  if (visualRichEl) {
    const textarea = targets.textarea;
    try { visualRichEl.focus(); } catch (_) {}

    await typeTextGradually(cleanText, (partial, chunk) => {
      const htmlPartial = formatAnswerAsHtmlParagraphs(partial);
      visualRichEl.innerHTML = htmlPartial;
      dispatchTypingEvents(visualRichEl, chunk);
      if (textarea) {
        setNativeControlValue(textarea, htmlPartial);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, shouldContinue);
    if (!shouldContinue()) return { success: false };

    const finalHtml = formatAnswerAsHtmlParagraphs(cleanText);
    visualRichEl.innerHTML = finalHtml;
    if (textarea) {
      setNativeControlValue(textarea, finalHtml);
      dispatchCommitEvents(textarea);
    }
    try {
      const ownerWin = (targets.tinymceBody?.doc?.defaultView) || d.defaultView || window;
      if (ownerWin?.tinyMCE && typeof ownerWin.tinyMCE.triggerSave === 'function') {
        ownerWin.tinyMCE.triggerSave();
      }
    } catch (_) {}

    dispatchCommitEvents(visualRichEl);
    const highlightBox = targets.attoEditable
      ? (targets.attoEditable.closest('.editor_atto_content_wrap') || targets.attoEditable)
      : (targets.tinymceBody ? targets.tinymceBody.iframe : visualRichEl);
    styleSelectedTarget(highlightBox);

    const mode = targets.attoEditable
      ? 'atto_editor'
      : (targets.tinymceBody ? 'tinymce_editor' : 'contenteditable');
    return { success: true, mode, element: visualRichEl };
  }

  const plainTarget = targets.textarea || targets.textInput;
  if (plainTarget && !plainTarget.disabled && !plainTarget.readOnly && !plainTarget.matches(':disabled')) {
    try { plainTarget.focus(); } catch (_) {}
    await typeTextGradually(cleanText, (partial, chunk) => {
      setNativeControlValue(plainTarget, partial);
      dispatchTypingEvents(plainTarget, chunk);
    }, shouldContinue);
    if (!shouldContinue()) return { success: false };
    setNativeControlValue(plainTarget, cleanText);
    dispatchCommitEvents(plainTarget);
    styleSelectedTarget(plainTarget);
    return {
      success: String(plainTarget.value || '').trim() === cleanText && plainTarget.isConnected !== false,
      mode: plainTarget.tagName === 'TEXTAREA' ? 'textarea' : 'text_input',
      element: plainTarget
    };
  }

  return { success: false };
}

function getOptionLetterForElement(el, idx) {
  const numEl = el ? el.querySelector('.answernumber') : null;
  if (numEl) {
    const numText = numEl.textContent.trim().toUpperCase().replace(/[^A-E]/g, '');
    if (['A', 'B', 'C', 'D', 'E'].includes(numText)) return numText;
  }
  return String.fromCharCode(65 + Math.min(idx, 25));
}

function extractChoiceLettersList(rawChoice) {
  const s = String(rawChoice || '').trim().toUpperCase();
  if (!s || ['BENAR', 'SALAH', 'TRUE', 'FALSE'].includes(s)) return [];
  // Compact letter sequence like "ADE" or "AC"
  if (/^[A-E]{2,5}$/.test(s)) {
    return Array.from(new Set(s.split('')));
  }
  // Separated list like "A, D, E", "A, D, AND E", "A, D, DAN E", "A & D + E"
  const normalized = s.replace(/\b(AND|DAN)\b/g, ',');
  if (/^[A-E](?:[\s,&+/|;]+[A-E])+\.?$|^[A-E]$/.test(normalized)) {
    const found = normalized.match(/[A-E]/g) || [];
    return Array.from(new Set(found));
  }
  // Prefixed lines like "A. ... \n D. ..."
  const lineLetters = Array.from(s.matchAll(/(?:^|[\n;|])\s*([A-E])[\.\)\s]/g)).map(m => m[1]);
  return Array.from(new Set(lineLetters));
}

function extractExpectedMultiChoiceCount(questionText) {
  const txt = String(questionText || '').toLowerCase();
  if (!txt) return 0;

  const numMatch =
    txt.match(/(?:there\s+are|choose|select|pick|mark|pilih(?:lah)?|tentukan|ada)\s+(?:the\s+|tepat\s+)?([2-5])\b/) ||
    txt.match(/\b([2-5])\s+(?:correct\s+answers?|answers?|options?|pilihan\s+(?:yang\s+)?benar|jawaban\s+(?:yang\s+)?benar|jawaban\s+tepat)/);
  if (numMatch) return parseInt(numMatch[1], 10);

  const wordMap = { two: 2, dua: 2, three: 3, tiga: 3, four: 4, empat: 4, five: 5, lima: 5 };
  const wordMatch = txt.match(/(?:there\s+are|choose|select|pick|mark|pilih(?:lah)?|tentukan|ada)\s+(?:the\s+|tepat\s+)?(two|dua|three|tiga|four|empat|five|lima)\b/);
  if (wordMatch && wordMap[wordMatch[1]]) return wordMap[wordMatch[1]];

  return 0;
}

function clearCheckboxSelections(doc) {
  const d = doc || getQuizDocument() || document;
  const rows = d.querySelectorAll('.answer > div');
  rows.forEach(row => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb && cb.checked) {
      cb.click();
    }
    row.removeAttribute('data-km-selected');
    row.style.outline = 'none';
    row.style.outlineOffset = '0';
  });
}

function selectOptionsByLetters(choiceLetters, doc) {
  if (!choiceLetters) return { success: false, count: 0 };
  const letters = Array.isArray(choiceLetters)
    ? Array.from(new Set(choiceLetters.map(l => String(l).trim().toUpperCase()).filter(l => /^[A-E]$/.test(l))))
    : extractChoiceLettersList(choiceLetters);

  if (letters.length === 0) return { success: false, count: 0 };
  const d = doc || getQuizDocument() || document;
  const optionElements = d.querySelectorAll('.answer > div');
  let selectedCount = 0;
  optionElements.forEach((el, idx) => {
    const letter = getOptionLetterForElement(el, idx);
    if (letters.includes(letter)) {
      if (clickInputOption(el, true)) selectedCount++;
    } else {
      uncheckCheckboxRow(el);
    }
  });
  return { success: selectedCount === letters.length, count: selectedCount };
}

// Cabut centang lama (mis. jawaban tersimpan sebelumnya) agar hasil akhir = persis himpunan jawaban AI
function uncheckCheckboxRow(rowEl) {
  const cb = rowEl && rowEl.querySelector('input[type="checkbox"]');
  if (cb && cb.checked) {
    cb.click();
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (rowEl && rowEl.hasAttribute('data-km-selected')) {
    rowEl.removeAttribute('data-km-selected');
    rowEl.style.outline = 'none';
    rowEl.style.outlineOffset = '0';
  }
}

function selectMultipleOptionsByText(answerText, threshold = 0.70, doc) {
  if (!answerText) return { success: false, count: 0 };
  const d = doc || getQuizDocument() || document;
  const optionElements = Array.from(d.querySelectorAll('.answer > div'));
  if (optionElements.length === 0) return { success: false, count: 0 };

  const segments = String(answerText)
    .split(/\r?\n|\|\||\||;/)
    .map(part => part.replace(/^\s*[A-E][\.\)\s]+/i, '').trim())
    .filter(part => part.length >= 2);
  if (segments.length === 0) return { success: false, count: 0 };

  let count = 0;
  const matchedSet = new Set();
  for (const seg of segments) {
    let bestEl = null;
    let bestScore = -1;
    for (const el of optionElements) {
      const numEl = el.querySelector('.answernumber');
      const textEl = el.querySelector('.flex-fill') || el.querySelector('label') || el;
      const cleanText = textEl.textContent.replace(numEl ? numEl.textContent : '', '').trim();
      const score = getStringSimilarity(cleanText, seg);
      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }
    if (bestEl && bestScore >= threshold && !matchedSet.has(bestEl)) {
      if (clickInputOption(bestEl, true)) {
        matchedSet.add(bestEl);
        count++;
      }
    }
  }
  if (count > 0) {
    optionElements.forEach(el => { if (!matchedSet.has(el)) uncheckCheckboxRow(el); });
  }
  return { success: count > 0, count };
}

// ---- SELECT OPTION BY ANSWER FUZZY MATCH ----
function selectOptionByText(answerText, threshold = 0.70, doc) {
  const d = doc || getQuizDocument() || document;
  const optionElements = d.querySelectorAll('.answer > div');
  let bestMatch = null;
  let highestScore = -1;

  optionElements.forEach(el => {
    const numEl = el.querySelector('.answernumber');
    const textEl = el.querySelector('.flex-fill') || el.querySelector('label') || el;
    
    const cleanText = textEl.textContent.replace(numEl ? numEl.textContent : '', '').trim();
    
    const score = getStringSimilarity(cleanText, answerText);
    if (score > highestScore) {
      highestScore = score;
      bestMatch = el;
    }
  });

  if (bestMatch && highestScore >= threshold) {
    const success = clickInputOption(bestMatch);
    return { success, element: bestMatch, score: highestScore };
  }
  
  return { success: false, score: highestScore };
}

// ---- SELECT OPTION BY LETTER (A, B, C, D, E) ----
function selectOptionByLetter(choiceLetter, doc) {
  if (!choiceLetter) return { success: false };
  const targetLetter = choiceLetter.trim().toUpperCase().replace(/[^A-E]/g, '');
  if (!targetLetter) return { success: false };

  const d = doc || getQuizDocument() || document;
  const optionElements = d.querySelectorAll('.answer > div');
  for (let idx = 0; idx < optionElements.length; idx++) {
    const el = optionElements[idx];
    const letter = getOptionLetterForElement(el, idx);
    if (letter === targetLetter) {
      return { success: clickInputOption(el), element: el };
    }
  }
  return { success: false };
}

// ---- UNIFIED QUIZ ANSWER APPLIER (TAHAP 5 + ESSAY / ATTO SUPPORT) ----
async function applyAnswerToQuizDom({ choice, answer }, threshold = 0.60, doc, shouldContinue = () => isAgentRunning) {
  if (!shouldContinue()) return { success: false, mode: 'Stopped' };
  const d = doc || getQuizDocument() || document;
  const inputType = detectQuizInputType(d);

  // Essay / Rich-text editor / Short-answer typed input takes direct typing path
  if (inputType === 'essay' || inputType === 'shortanswer') {
    const typedMatch = await fillTextInputOption(answer || choice, d, shouldContinue);
    if (typedMatch.success) {
      return { success: true, mode: typedMatch.mode || 'text_input', element: typedMatch.element };
    }
    return { success: false };
  }

  const hasCheckboxes = Boolean(d.querySelector('.answer input[type="checkbox"]'));

  // 1. Opsi Multiple Response (Checkboxes A, D, E dll.)
  if (hasCheckboxes) {
    const multiFromChoice = extractChoiceLettersList(choice);
    if (multiFromChoice.length > 0) {
      const multiMatch = selectOptionsByLetters(multiFromChoice, d);
      if (multiMatch.success) return { success: true, mode: 'multi_checkbox', count: multiMatch.count };
    }
    const multiFromAnswerLetters = extractChoiceLettersList(answer);
    if (multiFromAnswerLetters.length > 0) {
      const multiMatch = selectOptionsByLetters(multiFromAnswerLetters, d);
      if (multiMatch.success) return { success: true, mode: 'multi_checkbox', count: multiMatch.count };
    }
    if (answer) {
      const multiTextMatch = selectMultipleOptionsByText(answer, threshold, d);
      if (multiTextMatch.success) return { success: true, mode: 'multi_checkbox_text', count: multiTextMatch.count };
    }
  } else if (choice && (choice.includes(',') || choice.length > 1) && !['BENAR', 'SALAH', 'TRUE', 'FALSE'].includes(choice.toUpperCase())) {
    const multiMatch = selectOptionsByLetters(choice, d);
    if (multiMatch.success) return { success: true, mode: 'multi_checkbox', count: multiMatch.count };
  }

  // 2. Pilih berdasarkan huruf tunggal (A, B, C, D, E)
  if (choice) {
    let matched = selectOptionByLetter(choice, d);
    if (matched.success) return { success: true, mode: 'letter', element: matched.element };
  }

  // 3. Cocokkan berdasarkan teks fuzzy (termasuk True/False atau Benar/Salah)
  if (answer) {
    let matched = selectOptionByText(answer, threshold, d);
    if (matched.success) return { success: true, mode: 'text_fuzzy', element: matched.element };
  }
  if (choice && choice.length > 1) {
    let matched = selectOptionByText(choice, threshold, d);
    if (matched.success) return { success: true, mode: 'text_fuzzy', element: matched.element };
  }

  // 4. Fallback terakhir: ketik ke text input / textarea / editor jika tersedia
  const textMatch = await fillTextInputOption(answer || choice, d, shouldContinue);
  if (textMatch.success) return { success: true, mode: textMatch.mode || 'text_input', element: textMatch.element };

  return { success: false };
}

// ---- HELPER: CONVERT BLOB TO BASE64 ----
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result || '').split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---- HELPER: EXTRACT REASONING & PARSE AI RESPONSE (TAHAP 6: STEP-BY-STEP MATH SUMMARY) ----
function extractReasoningText(rawText) {
  if (!rawText) return "";
  let text = String(rawText).trim();
  const lastJsonOpen = text.lastIndexOf('{');
  if (lastJsonOpen > 0) {
    text = text.slice(0, lastJsonOpen).trim();
  }
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
  return text;
}

function parseAiJsonCandidate(candidateText) {
  if (!candidateText) return null;
  try {
    return JSON.parse(candidateText);
  } catch (_) {
    // Recover JSON when LLM embeds raw newlines inside string values
    try {
      const escaped = candidateText.replace(/"(?:\\.|[^"\\])*"/g, m =>
        m.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      );
      return JSON.parse(escaped);
    } catch (__) {
      return null;
    }
  }
}

function normalizeParsedAnswerObj(obj, reasoning, isTypedMode) {
  if (!obj || typeof obj !== 'object') return null;
  const rawChoice = String(obj.choice || obj.pilihan || obj.jawaban_huruf || '').trim().toUpperCase();
  const choice = isTypedMode ? '' : rawChoice;
  const answer = String(obj.answer || obj.jawaban || obj.teks || '').trim();
  if (choice || answer) {
    return { choice, answer, reasoning };
  }
  return null;
}

function parseAiResponse(rawText, expectedType = 'choice') {
  if (!rawText) return { choice: '', answer: '', reasoning: '' };
  const isTypedMode = (expectedType === 'essay' || expectedType === 'shortanswer');
  const reasoning = extractReasoningText(rawText);

  // 1. Bersihkan tag pemikiran model AI (<think>, <thought>, <reasoning>, markdown)
  let clean = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  // 2. Prioritas 1: Telusuri kandidat '{' dari belakang menuju lastClose (aman jika teks jawaban berisi '{...}' atau LaTeX '\frac{a}{b}')
  const lastClose = clean.lastIndexOf('}');
  if (lastClose !== -1) {
    let searchEnd = lastClose;
    let tries = 0;
    while (searchEnd > 0 && tries < 24) {
      const openIdx = clean.lastIndexOf('{', searchEnd - 1);
      if (openIdx === -1) break;
      tries++;
      const candidate = clean.slice(openIdx, lastClose + 1);
      if (/"(?:choice|pilihan|answer|jawaban|teks)"/i.test(candidate)) {
        const parsedObj = normalizeParsedAnswerObj(parseAiJsonCandidate(candidate), reasoning, isTypedMode);
        if (parsedObj) return parsedObj;
      }
      searchEnd = openIdx;
    }
  }

  // 3. Prioritas 2: Regex blok JSON single-line/compact
  const jsonRegex = /\{[^{}]*(?:"choice"|"pilihan"|"answer"|"jawaban"|"teks")[^{}]*\}/gi;
  const jsonMatches = clean.match(jsonRegex);
  if (jsonMatches && jsonMatches.length > 0) {
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      const parsedMatch = normalizeParsedAnswerObj(parseAiJsonCandidate(jsonMatches[i]), reasoning, isTypedMode);
      if (parsedMatch) return parsedMatch;
    }
  }

  // 4. Untuk mode Essay / Short-Answer: tangani JSON yang kutip dalamnya tidak ter-escape, hindari regex tebakan A-E
  if (isTypedMode) {
    const answerFieldMatch = clean.match(/"(?:answer|jawaban|teks)"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"(?:choice|pilihan|reasoning|jawaban_huruf)"|\n\s*\}|\}$)/i);
    if (answerFieldMatch && answerFieldMatch[1]) {
      const extracted = answerFieldMatch[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
      if (extracted) return { choice: '', answer: extracted, reasoning };
    }
    const strippedPlain = clean
      .replace(/\{[\s\S]*$/g, '')
      .replace(/^(?:jawaban|answer)\s*:\s*/i, '')
      .trim();
    return { choice: '', answer: strippedPlain || clean, reasoning };
  }

  // 5. Fallback Cerdas pilihan ganda: Cari kesimpulan huruf tunggal/jamak di bagian akhir teks
  const conclusionRegexes = [
    /(?:pilihan|opsi|jawaban)\s*(?:yang\s+sesuai|yang\s+benar|akhir)?\s*(?:adalah|=)?\s*[:\s]*\b([A-E](?:\s*(?:,?\s*(?:dan|and|&)|,)\s*[A-E])*)\b/gi,
    /"choice"\s*:\s*"([A-E](?:\s*,\s*[A-E])*)"/gi,
    /"pilihan"\s*:\s*"([A-E](?:\s*,\s*[A-E])*)"/gi,
    /(?:jadi|maka|kesimpulan)\s*(?:jawaban)?\s*(?:yang\s+benar)?\s*(?:adalah|=)?\s*[:\s]*\b([A-E](?:\s*(?:,?\s*(?:dan|and|&)|,)\s*[A-E])*)\b/gi
  ];

  for (let regex of conclusionRegexes) {
    const matches = Array.from(clean.matchAll(regex));
    if (matches && matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const extracted = extractChoiceLettersList(lastMatch[1]);
      const foundChoice = extracted.length > 1 ? extracted.join(', ') : lastMatch[1].trim().toUpperCase();
      return { choice: foundChoice, answer: clean, reasoning };
    }
  }

  // 6. Fallback Terakhir pilihan ganda: huruf di baris paling akhir
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    const letterPrefixMatch = lastLine.match(/^([A-E])[\.\)\s]/i);
    if (letterPrefixMatch) {
      return {
        choice: letterPrefixMatch[1].toUpperCase(),
        answer: lastLine.replace(/^([A-E])[\.\)\s]/i, '').trim(),
        reasoning
      };
    }
  }

  return { choice: '', answer: clean, reasoning };
}

// ---- BULLETPROOF FETCH HELPER (BYPASS MIXED CONTENT, CSP & CORS VIA BACKGROUND PROXY) ----
async function serializeFormDataForProxy(formData) {
  const fields = {};
  const files = [];
  for (const [key, val] of formData.entries()) {
    if (typeof Blob !== 'undefined' && val instanceof Blob) {
      const base64 = await blobToBase64(val);
      files.push({
        field: key,
        filename: val.name || 'upload.bin',
        mimeType: val.type || 'application/octet-stream',
        base64
      });
    } else {
      fields[key] = String(val);
    }
  }
  return { fields, files };
}

async function proxyFetchViaBackground(url, options = {}) {
  if (!isExtensionValid()) {
    throw new Error("Koneksi ekstensi terputus (Extension context invalidated). Silakan refresh halaman web ini (F5 / Ctrl+R).");
  }

  let sendOptions = options ? { ...options } : {};
  let multipart = null;
  if (typeof FormData !== 'undefined' && sendOptions.body instanceof FormData) {
    multipart = await serializeFormDataForProxy(sendOptions.body);
    delete sendOptions.body;
  }

  const messagePayload = {
    action: "proxyFetch",
    url: url,
    options: sendOptions
  };
  if (multipart) messagePayload.multipart = multipart;
  if (sendOptions.responseType) {
    messagePayload.responseType = sendOptions.responseType;
    delete sendOptions.responseType;
  }

  return await new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(messagePayload, (resp) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || "";
          if (errMsg.includes("context invalidated") || errMsg.includes("Could not establish connection")) {
            reject(new Error("Koneksi ekstensi terputus (Extension context invalidated). Silakan refresh halaman web ini (F5 / Ctrl+R)."));
          } else {
            reject(new Error(errMsg || "Gagal menghubungi background service worker"));
          }
          return;
        }
        if (!resp || !resp.success) {
          reject(new Error(resp ? resp.error : "Gagal memproses permintaan AI via background proxy"));
          return;
        }
        resolve({
          ok: resp.ok,
          status: resp.status,
          statusText: resp.statusText || "",
          headers: { get: () => null },
          viaProxy: true,
          durationMs: resp.durationMs ?? null,
          base64: resp.base64 || null,
          mimeType: resp.mimeType || null,
          dataUrl: resp.dataUrl || null,
          json: async () => {
            try {
              return JSON.parse(resp.data);
            } catch (parseErr) {
              throw new Error(`HTTP ${resp.status} non-JSON response: ${String(resp.data || '').slice(0, 220)}`);
            }
          },
          text: async () => resp.data
        });
      });
    } catch (err) {
      reject(new Error("Koneksi ekstensi terputus (Extension context invalidated). Silakan refresh halaman web ini (F5 / Ctrl+R)."));
    }
  });
}

async function safeFetch(url, options = {}) {
  // Jika URL tujuan menggunakan HTTP (insecure) sedangkan halaman saat ini HTTPS (secure),
  // browser akan langsung memblokir dengan 'Mixed Content' jika dipanggil via fetch() di tab.
  // Begitu pula IP lokal/LAN (misal http://192.168.x.x, http://localhost).
  // Maka LANGSUNG alihkan ke background proxy yang bebas dari batasan Mixed Content, CSP & CORS!
  // Request ke Kamus Mini Cloud membawa header kustom (X-AI-Client-Version) yang memicu preflight CORS
  // dan gagal dari origin halaman kuis -> langsung lewat background proxy tanpa mencoba fetch langsung.
  if (typeof url === 'string' && typeof KAMUS_MINI_CLOUD_URL === 'string' && url.startsWith(KAMUS_MINI_CLOUD_URL)) {
    return await proxyFetchViaBackground(url, options);
  }

  const isHttpsPage = window.location.protocol === 'https:';
  const isInsecureUrl = typeof url === 'string' && url.startsWith('http://');
  const isLocalOrLan = typeof url === 'string' && (url.includes('192.168.') || url.includes('10.') || url.includes('172.') || url.includes('localhost') || url.includes('127.0.0.1'));

  if ((isHttpsPage && isInsecureUrl) || isLocalOrLan) {
    return await proxyFetchViaBackground(url, options);
  }

  try {
    const res = await fetch(url, options);
    return res;
  } catch (err) {
    logDebugEvent('NETWORK', 'WARN', `Direct fetch gagal (${err.message}), dialihkan via background proxy: ${String(url).split('?')[0]}`, { url: String(url).split('?')[0] });
    return await proxyFetchViaBackground(url, options);
  }
}

// ======================================================
// HELPER KONEKTOR AI TERPADU (TEXT, VISION & PADDLEOCR)
// ======================================================
async function callConfiguredAiApi({ provider, apiKey, model, config, systemPrompt, userPrompt, images = [], temperature = 0.1, maxRetries = 2 }) {
  const aiT0 = Date.now();
  let rawReply = "";
  let httpStatus = null;
  let targetUrl = "";
  let usedModel = model;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (provider === 'gemini') {
        const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
        const parts = [{ text: combinedPrompt }];
        for (const img of images) {
          if (img && img.base64) {
            parts.push({
              inline_data: {
                mime_type: img.mimeType || 'image/png',
                data: img.base64
              }
            });
          }
        }
        targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await safeFetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }] })
        });
        httpStatus = res.status;
        const data = await res.json();
        if (!res.ok) {
          const errMsg = data.error ? (data.error.message || JSON.stringify(data.error)) : `HTTP Error ${res.status}`;
          if ((res.status === 429 || (res.status >= 500 && res.status <= 504)) && attempt < maxRetries) {
            const delayMs = (attempt + 1) * 2000;
            logAgentActivity(`[AI Retry] HTTP ${res.status} (${errMsg}). Mencoba ulang #${attempt + 1} dalam ${delayMs / 1000}d...`);
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }
          throw new Error(errMsg);
        }
        rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        break;
      } else {
        if (provider === 'groq') {
          targetUrl = 'https://api.groq.com/openai/v1/chat/completions';
        } else if (provider === 'openai') {
          targetUrl = 'https://api.openai.com/v1/chat/completions';
        } else {
          const rawBase = config.aiCustomBaseUrl || 'https://api.deepseek.com/v1';
          targetUrl = `${rawBase.replace(/\/+$/, '')}/chat/completions`;
          usedModel = config.aiCustomModel || model || 'deepseek-chat';
        }

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        let userContent = userPrompt;
        if (images && images.length > 0) {
          userContent = [{ type: 'text', text: userPrompt }];
          for (const img of images) {
            const dataUrl = img?.dataUrl || (img?.base64 ? `data:${img.mimeType || 'image/png'};base64,${img.base64}` : '');
            if (dataUrl) {
              userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
            }
          }
        }

        const res = await safeFetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: usedModel,
            messages: [
              { role: 'system', content: systemPrompt || 'Kamu adalah asisten ahli pemecah ujian pilihan ganda.' },
              { role: 'user', content: userContent }
            ],
            temperature
          })
        });
        httpStatus = res.status;
        const data = await res.json();
        if (!res.ok) {
          const errMsg = data.error ? (data.error.message || JSON.stringify(data.error)) : `HTTP Error ${res.status}`;
          if ((res.status === 429 || (res.status >= 500 && res.status <= 504)) && attempt < maxRetries) {
            const delayMs = (attempt + 1) * 2000;
            logAgentActivity(`[AI Retry] HTTP ${res.status} (${errMsg}). Mencoba ulang #${attempt + 1} dalam ${delayMs / 1000}d...`);
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }
          throw new Error(errMsg);
        }
        rawReply = data.choices?.[0]?.message?.content || "";
        break;
      }
    } catch (err) {
      if (attempt < maxRetries && /429|rate limit|quota|temporarily unavailable|overloaded/i.test(err.message)) {
        const delayMs = (attempt + 1) * 2000;
        logAgentActivity(`[AI Retry] Terkendala: ${err.message}. Mencoba ulang #${attempt + 1} dalam ${delayMs / 1000}d...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }

  return {
    rawReply,
    httpStatus,
    targetUrl,
    model: usedModel,
    durationMs: Date.now() - aiT0
  };
}

function formatMultiAnswerRule(expectedCount = 0) {
  if (expectedCount >= 2) {
    return `\nCATATAN PENTING: Soal ini bertipe CHECKBOX dengan TEPAT ${expectedCount} JAWABAN BENAR! Wajib cantumkan TEPAT ${expectedCount} huruf dipisah koma di field "choice" (misal: "C, D, E"), JANGAN hanya memilih 1 jawaban.`;
  }
  return '\nCATATAN PENTING: Soal ini bertipe CHECKBOX (multiple answers / all that apply). Wajib cantumkan SEMUA huruf jawaban benar dipisah koma di field "choice" (misal: "A, D, E"), JANGAN hanya memilih 1 jawaban.';
}

function buildOcrPrompt({ ocrMarkdown, options, hasDiagramImages, groqNoVisionWarning = false, questionType = 'choice', isMultiChoice = false, expectedCount = 0 }) {
  const isTypedMode = (questionType === 'essay' || questionType === 'shortanswer');
  const letters = isTypedMode ? [] : (options || [])
    .map(opt => {
      const m = String(opt).match(/^([A-E])\./);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  const letterHint = letters.length > 0
    ? `\nPilihan radio/checkbox aktif pada soal (${letters.join(', ')}).`
    : '';

  const multiRule = (!isTypedMode && isMultiChoice) ? formatMultiAnswerRule(expectedCount) : '';
  const choiceFormatDesc = isMultiChoice
    ? (expectedCount >= 2 ? `TEPAT ${expectedCount} huruf pilihan dipisah koma (misal "C, D, E")` : 'semua huruf pilihan benar dipisah koma (misal "A, D, E")')
    : 'huruf pilihan kapital (A/B/C/D/E)';

  const kindLabel = isTypedMode ? 'ujian isian / essay' : 'ujian pilihan ganda';
  const intro = hasDiagramImages
    ? (groqNoVisionWarning
      ? `Ini adalah soal ${kindLabel} hasil ekstraksi OCR (Markdown & LaTeX). Diagram visual tidak dapat dilampirkan ke model aktif, gunakan seluruh informasi teks & angka OCR sebaik mungkin.`
      : `Ini adalah soal ${kindLabel}. Seluruh teks, angka, dan rumus LaTeX telah diekstrak oleh OCR (Markdown di bawah), dan potongan gambar diagram/bangunan ([Gambar Diagram #...]) dilampirkan pada pesan ini.`)
    : `Ini adalah soal ${kindLabel} hasil ekstraksi OCR (Markdown & LaTeX) dari tampilan soal bergambar/rumus tanpa diagram tambahan.`;

  const diagramClause = (hasDiagramImages && !groqNoVisionWarning) ? ' serta gambar diagram terlampir' : '';
  const instructions = isTypedMode
    ? `Instruksi Pengerjaan:
1. Baca seluruh teks soal dan rumus LaTeX ($...$)${diagramClause} di atas dengan teliti.
2. Jika soal berbentuk melengkapi titik-titik / rumpang / angka singkat, tuliskan HANYA kata/frasa/nilai pengisinya saja tanpa mengulang kalimat soal.
3. Jika soal berbentuk uraian terbuka ("Jelaskan...", analisis, hitungan), susun jawaban yang jelas, padat, dan langsung ke inti (teks polos tanpa format Markdown).
4. Di akhir respons, WAJIB sertakan kesimpulan dalam format JSON persis:
{"choice": "", "answer": "teks jawaban final yang siap diketik ke kotak jawaban"}`
    : `Instruksi Pengerjaan:
1. Baca seluruh teks soal, rumus LaTeX ($...$),${hasDiagramImages && !groqNoVisionWarning ? ' gambar diagram terlampir,' : ''} serta pilihan di atas dengan sangat teliti.${multiRule}
2. Lakukan perhitungan matematis / penalaran langkah demi langkah hingga tuntas (misal jika mencari tembereng lingkaran: hitung luas juring lalu kurangi luas segitiga, jangan berhenti di tengah).
3. Di akhir respons, WAJIB sertakan kesimpulan jawaban dalam format JSON persis:
{"choice": "${choiceFormatDesc}", "answer": "teks atau angka jawaban yang dipilih"}`;

  return `${intro}${letterHint}

--- HASIL OCR PADDLEOCR-VL-1.6 (MARKDOWN & LATEX) ---
${ocrMarkdown}
--- AKHIR HASIL OCR ---

${instructions}`;
}

function buildDirectAiPrompts({ questionType = 'choice', isMultiChoice = false, expectedCount = 0, mode = 'text', questionText = '', options = [], ocrMarkdown = '', hasDiagramImages = false, groqNoVisionWarning = false }) {
  const isTypedMode = (questionType === 'essay' || questionType === 'shortanswer');
  const multiHint = (!isTypedMode && isMultiChoice) ? formatMultiAnswerRule(expectedCount) : '';
  const choiceFormatDesc = isMultiChoice
    ? (expectedCount >= 2 ? `TEPAT ${expectedCount} huruf pilihan dipisah koma (misal "C, D, E")` : 'semua huruf pilihan benar dipisah koma (misal "A, D, E")')
    : 'huruf pilihan (A/B/C/D/E)';

  const systemPrompt = isTypedMode
    ? 'Kamu adalah asisten ahli akademik dan pemecah soal ujian isian/essay yang sangat teliti. Analisis soal dengan cermat, lalu akhiri dengan format JSON valid {"choice": "", "answer": "jawaban final siap diketik ke kotak jawaban"}.'
    : `Kamu adalah asisten ahli matematika dan pemecah ujian pilihan ganda yang sangat teliti. Analisis teks dan gambar secara cermat, hitung langkah demi langkah hingga tuntas, dan akhiri dengan format JSON {"choice": "${choiceFormatDesc}", "answer": "teks jawaban"}.`;

  if (mode === 'ocr') {
    return {
      systemPrompt,
      userPrompt: buildOcrPrompt({ ocrMarkdown, options, hasDiagramImages, groqNoVisionWarning, questionType, isMultiChoice, expectedCount })
    };
  }

  if (mode === 'vision') {
    const qTextContext = (questionText && String(questionText).trim())
      ? `\nTeks Pertanyaan di Halaman:\n${String(questionText).replace(/\[Gambar Diagram\]/g, '').trim()}\n`
      : '';
    if (isTypedMode) {
      return {
        systemPrompt,
        userPrompt: `Ini adalah soal ujian isian / essay tanpa pilihan ganda (gambar bacaan/soal terlampir).
${qTextContext}
Instruksi Pengerjaan:
1. Baca seluruh teks pada gambar terlampir maupun teks pertanyaan di atas secara utuh dan teliti.
2. Jika soal berbentuk melengkapi titik-titik / rumpang / angka singkat (misal "...nasional"), berikan HANYA kata/frasa/nilai pengisinya saja tanpa mengulang kalimat soal.
3. Jika soal berbentuk uraian / pertanyaan terbuka (seperti pemahaman bacaan Bahasa Inggris/Indonesia, hitungan, "What...", "Explain...", "Jelaskan..."), tuliskan jawaban yang jelas, tepat, dan langsung pada inti dalam bahasa pertanyaan menggunakan teks polos tanpa format Markdown.
4. Di akhir respons, WAJIB sertakan kesimpulan dalam format JSON persis:
{"choice": "", "answer": "teks jawaban final yang siap diketik langsung"}`
      };
    }

    const optionsText = options && options.length > 0
      ? `\nPilihan Jawaban yang Tersedia:\n${options.join('\n')}\n`
      : '';
    return {
      systemPrompt,
      userPrompt: `Ini adalah soal ujian pilihan ganda (gambar soal terlampir).
${qTextContext}${optionsText}
Instruksi Pengerjaan:
1. Amati gambar soal secara utuh dan teliti (baca teks soal, rumus, nilai sudut/jari-jari/sisi pada diagram, dan tentukan apa yang dicari).
2. Periksa SELURUH pilihan jawaban yang ada di gambar / daftar pilihan.${multiHint}
3. Lakukan perhitungan matematis secara seksama langkah demi langkah hingga tuntas (contoh: jika mencari luas daerah diarsir/tembereng, hitung luas juring lingkaran terlebih dahulu, lalu kurangkan dengan luas segitiga, jangan berhenti hanya di luas segitiga saja).
4. Di akhir respons, WAJIB sertakan kesimpulan jawaban dalam format JSON persis:
{"choice": "${choiceFormatDesc}", "answer": "teks atau angka jawaban yang dipilih"}`
    };
  }

  // mode === 'text'
  if (isTypedMode) {
    return {
      systemPrompt,
      userPrompt: `Kamu adalah asisten pemecah soal ujian isian & essay yang cerdas dan teliti. Tidak ada pilihan ganda pada soal ini karena jawaban akan diketik langsung ke kotak teks LMS.

Instruksi Pengerjaan:
1. Pahami konteks kalimat soal dan jenis pertanyaan dengan cermat.
2. Jika soal berbentuk melengkapi titik-titik / rumpang / isian singkat (contoh: "...merupakan pengertian dari...nasional"), tuliskan HANYA kata/frasa/angka pengisi yang tepat (contoh: "Integrasi") tanpa mengulang kalimat soal.
3. Jika soal berbentuk uraian terbuka ("Jelaskan...", "Mengapa...", "Uraikan..."), tulis jawaban yang jelas, padat, dan langsung pada inti (1-2 paragraf atau poin teks polos tanpa format Markdown).
4. Di akhir respons, WAJIB sertakan kesimpulan jawaban dalam format JSON valid berikut:
{"choice": "", "answer": "teks jawaban final yang siap diketik langsung"}

Soal:
${questionText}`
    };
  }

  return {
    systemPrompt,
    userPrompt: `Kamu adalah asisten pemecah soal ujian pilihan ganda yang cerdas dan teliti. Analisis soal berikut dan tentukan jawaban yang paling tepat.${multiHint}

Instruksi Pengerjaan:
1. Pahami pertanyaan dan pilihan jawaban secara mendalam.
2. Analisis dan hitung langkah demi langkah hingga mendapatkan jawaban yang pasti.
3. Di akhir respons, WAJIB sertakan kesimpulan jawaban dalam format JSON valid berikut:
{"choice": "${choiceFormatDesc}", "answer": "teks pilihan jawaban yang dipilih"}

Soal:
${questionText}

Pilihan:
${(options || []).join('\n')}`
  };
}

// ======================================================
// QUESTION FINGERPRINT & OCR CACHE (TAHAP 2)
// ======================================================
function buildQuestionFingerprint(qNum, doc) {
  const d = doc || getQuizDocument() || document;
  const qtextEl = d.querySelector('.qtext') || d.querySelector('.formulation');
  const cleanText = (qtextEl ? qtextEl.textContent : '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160);

  const images = Array.from(d.querySelectorAll('.formulation img, .qtext img'))
    .filter(img => isContentImage(img))
    .map(img => {
      const src = img.getAttribute('src') || img.src || '';
      try {
        const url = new URL(src, window.location.href);
        return url.pathname.split('/').pop() || url.search;
      } catch (e) {
        return src.slice(-40);
      }
    })
    .filter(Boolean)
    .sort()
    .join('|');

  return `q_${qNum}::${cleanText}::${images}`;
}

const OCR_CACHE_MAX_ENTRIES = 40;

async function getOcrCache(fingerprint) {
  if (!fingerprint) return null;
  try {
    const res = await new Promise(resolve => chrome.storage.local.get(['paddleOcrCache'], resolve));
    const cache = res.paddleOcrCache || {};
    const entry = cache[fingerprint];
    if (entry && entry.cleanMarkdown) {
      entry.lastUsed = Date.now();
      chrome.storage.local.set({ paddleOcrCache: cache });
      return entry;
    }
  } catch (err) {
    console.warn("getOcrCache error:", err);
  }
  return null;
}

async function saveOcrCache(fingerprint, data) {
  if (!fingerprint || !data || !data.cleanMarkdown) return;
  try {
    const res = await new Promise(resolve => chrome.storage.local.get(['paddleOcrCache'], resolve));
    const cache = res.paddleOcrCache || {};

    cache[fingerprint] = {
      cleanMarkdown: data.cleanMarkdown,
      diagramImages: (data.diagramImages || []).map(img => ({
        marker: img.marker,
        mimeType: img.mimeType,
        sizeBytes: img.sizeBytes,
        dataUrl: (img.dataUrl && img.dataUrl.length <= 450000) ? img.dataUrl : null
      })),
      stats: data.stats || {},
      ocrMode: data.ocrMode || 'OCR_TEXT_ONLY',
      lastUsed: Date.now()
    };

    // Evict oldest if exceeding max entries
    const keys = Object.keys(cache);
    if (keys.length > OCR_CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => (cache[a].lastUsed || 0) - (cache[b].lastUsed || 0));
      const toRemove = keys.slice(0, keys.length - OCR_CACHE_MAX_ENTRIES);
      toRemove.forEach(k => delete cache[k]);
    }

    await new Promise(resolve => chrome.storage.local.set({ paddleOcrCache: cache }, resolve));
  } catch (err) {
    console.warn("saveOcrCache error:", err);
  }
}

async function extractContentImagesFallback(scope) {
  const d = scope || getQuizDocument() || document;
  const imgs = Array.from(d.querySelectorAll('.qtext img, .formulation img')).filter(img => isContentImage(img));
  for (const img of imgs) {
    try {
      if (img.complete && img.naturalWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1] || '';
        if (base64.length >= 50) {
          return { mimeType: 'image/png', base64, dataUrl };
        }
      }
    } catch (_) {
      // Cross-origin canvas taint -> fallback proxyFetchViaBackground
    }
    const rawSrc = img.currentSrc || img.getAttribute('src') || img.src || '';
    if (rawSrc && !rawSrc.startsWith('data:')) {
      try {
        const absUrl = new URL(rawSrc, window.location.href).href;
        const proxyRes = await proxyFetchViaBackground(absUrl, { method: 'GET', responseType: 'dataUrl' });
        if (proxyRes && proxyRes.ok && proxyRes.base64 && proxyRes.base64.length >= 50) {
          return {
            mimeType: proxyRes.mimeType || 'image/png',
            base64: proxyRes.base64,
            dataUrl: proxyRes.dataUrl
          };
        }
      } catch (_) {}
    }
  }
  return null;
}

// ======================================================
// DIRECT AI SOLVER ENGINE (GEMINI, GROQ, OPENAI, CUSTOM + PADDLEOCR)
// ======================================================
async function solveWithDirectAI(qNum, questionText, options, config, doc, solverOpts = {}) {
  const d = doc || getQuizDocument() || document;
  const apiKey = config.aiApiKey;
  const provider = config.aiProvider || 'gemini';
  const model = config.aiModel || 'gemini-1.5-flash';
  const rawThreshDirect = config.matchThreshold !== undefined ? Number(config.matchThreshold) : 0.70;
  const threshold = rawThreshDirect > 1 ? rawThreshDirect / 100 : rawThreshDirect;
  const questionType = detectQuizInputType(d);
  const isMultiChoice = Boolean(d.querySelector('.answer input[type="checkbox"]'));
  const expectedCount = extractExpectedMultiChoiceCount(questionText);
  const shouldContinue = solverOpts.shouldContinue || (() => isAgentRunning);
  const resetCbBeforeApply = Boolean(solverOpts && solverOpts.resetCheckboxesFirst);
  const applyDirectResult = async (parsedObj, minThresh) => {
    if (!shouldContinue()) return { success: false, mode: 'Stopped' };
    if (resetCbBeforeApply && parsedObj && (parsedObj.choice || parsedObj.answer)) {
      clearCheckboxSelections(d);
    }
    return await applyAnswerToQuizDom(parsedObj, minThresh, d, shouldContinue);
  };
  const ocrEnabled = config.ocrEnabled !== false;
  const ocrToken = String(config.paddleOcrToken || '').trim();
  const ocrModel = String(config.paddleOcrModel || 'PaddleOCR-VL-1.6').trim() || 'PaddleOCR-VL-1.6';
  const ocrJobUrl = String(config.paddleOcrJobUrl || '').trim() || undefined;

  if (!apiKey && provider !== 'custom') {
    showToast("", "API Key belum diatur", "error");
    logAgentActivity("❌ Gagal: AI API Key belum diatur di menu Pengaturan. Agen dihentikan.");
    isAgentRunning = false;
    setAgentState({ agentState: { status: 'idle' } });
    return { success: false, mode: 'Config Error' };
  }

  const hasImage = checkForImageTags(d);
  const supportsVision = (provider === 'gemini' || provider === 'custom' || provider === 'openai');
  const speedVision = hasImage && supportsVision && config.imageProcessingMode !== 'ocr_first';
  if (speedVision) logAgentActivity(`[Soal ${qNum}] Mode Cepat: screenshot langsung ke AI Vision, tanpa PaddleOCR.`);
  const canUseOcr = !speedVision && hasImage && ocrEnabled && Boolean(ocrToken) && Boolean(globalThis.KamusMiniOcr);
  const qFingerprint = buildQuestionFingerprint(qNum, d);

  // 1. CEK CACHE OCR (TAHAP 2) SEBELUM SCREENSHOT & SEBELUM CALL PADDLEOCR
  let cachedOcr = null;
  if (canUseOcr) {
    cachedOcr = await getOcrCache(qFingerprint);
  }

  if (cachedOcr) {
    logAgentActivity(`[Soal ${qNum}] Cache OCR ditemukan! Menggunakan hasil ekstraksi tersimpan (0 ms)...`);
    logDebugEvent('OCR', 'INFO', `Cache OCR HIT (fingerprint=${qFingerprint})`, {
      qNum,
      fingerprint: qFingerprint,
      cachedMarkdownLen: cachedOcr.cleanMarkdown.length,
      diagramCount: (cachedOcr.diagramImages || []).length
    });

    const diagramImages = Array.isArray(cachedOcr.diagramImages) ? cachedOcr.diagramImages : [];
    const hasDiagrams = diagramImages.length > 0;
    const ocrMode = !hasDiagrams
      ? 'OCR_TEXT_ONLY'
      : (supportsVision ? 'OCR_VISION_CROP' : 'OCR_TEXT_ONLY_NO_VISION');

    mergeCapturedDebugPreview({
      ocrUsed: true,
      ocrMode: `${ocrMode} (Cache)`,
      ocrDurationMs: 0,
      ocrStats: cachedOcr.stats || {},
      ocrMarkdown: cachedOcr.cleanMarkdown,
      ocrDiagramPreviews: diagramImages.map(img => ({
        marker: img.marker,
        mimeType: img.mimeType,
        sizeKB: Number(((img.sizeBytes || 0) / 1024).toFixed(1)),
        dataUrl: (img.dataUrl && img.dataUrl.length <= 450000) ? img.dataUrl : null
      }))
    });

    const { systemPrompt: aiSystemPrompt, userPrompt: ocrUserPrompt } = buildDirectAiPrompts({
      questionType,
      isMultiChoice,
      expectedCount,
      mode: 'ocr',
      ocrMarkdown: cachedOcr.cleanMarkdown,
      options,
      hasDiagramImages: hasDiagrams,
      groqNoVisionWarning: hasDiagrams && !supportsVision
    });
    const attachImages = (ocrMode === 'OCR_VISION_CROP') ? diagramImages : [];
    const logCategory = attachImages.length > 0 ? 'AI_VISION' : 'AI_TEXT';

    logDebugEvent(logCategory, 'INFO', `Mengirim hasil ${ocrMode} (Cache) ke ${provider.toUpperCase()}`, {
      qNum,
      provider,
      model: (provider === 'custom') ? (config.aiCustomModel || model) : model,
      ocrMode,
      questionType,
      attachedDiagramCount: attachImages.length,
      promptLen: ocrUserPrompt.length
    });

    const aiResp = await callConfiguredAiApi({
      provider,
      apiKey,
      model,
      config,
      systemPrompt: aiSystemPrompt,
      userPrompt: ocrUserPrompt,
      images: attachImages
    });

    const parsed = parseAiResponse(aiResp.rawReply, questionType);
    logDebugEvent(logCategory, 'INFO', `Respons ${ocrMode} diterima (HTTP ${aiResp.httpStatus}, ${aiResp.durationMs}ms)`, {
      qNum,
      ocrMode,
      httpStatus: aiResp.httpStatus,
      elapsedAiMs: aiResp.durationMs,
      rawReplyLen: aiResp.rawReply.length,
      rawReplyPreview: aiResp.rawReply.slice(0, 700),
      parsed
    });

    mergeCapturedDebugPreview({
      aiChoice: parsed.choice,
      aiAnswer: parsed.answer,
      aiReasoning: parsed.reasoning,
      aiDurationMs: aiResp.durationMs,
      aiModel: aiResp.model
    });

    const matched = await applyDirectResult(parsed, 0.60);
    const modeLabel = (ocrMode === 'OCR_VISION_CROP') ? 'PaddleOCR + Vision Crop (Cache)' : 'PaddleOCR + Text AI (Cache)';
    if (matched.success) {
      logAgentActivity(`[Soal ${qNum}] ${modeLabel} Sukses! Memilih ${parsed.choice || 'Jawaban'}. (${parsed.answer || ''})`);
      return { success: true, mode: modeLabel };
    }

    logAgentActivity(`⚠️ [Soal ${qNum}] ${modeLabel} menjawab choice="${parsed.choice || ''}" (${String(parsed.answer || '').slice(0, 120)}), tidak cocok ke elemen opsi.`);
    return { success: false, mode: `${modeLabel} (No Choice)` };
  }

  // 2. JIKA TIDAK ADA CACHE: AMBIL SCREENSHOT SEKALI JIKA PERLU
  if (hasImage && (canUseOcr || supportsVision)) {
    const captureDiag = {};
    let base64Data = "";
    let imageKB = 0;
    let dataUrlFull = "";
    let attachedMimeType = "image/png";

    try {
      let imageBlob = solverOpts?.preCapturedBlob || null;
      if (!imageBlob) {
        logAgentActivity(`[Soal ${qNum}] Terdeteksi Gambar/Rumus. Mengambil tangkapan layar soal...`);
        imageBlob = await captureFormulationElement(d, captureDiag);
      }

      if (imageBlob) {
        base64Data = await blobToBase64(imageBlob);
        attachedMimeType = imageBlob.type || 'image/png';
        imageKB = Number((imageBlob.size / 1024).toFixed(1));
        dataUrlFull = `data:${attachedMimeType};base64,${base64Data}`;

        saveCapturedDebugPreview({
          ts: new Date().toISOString(),
          qNum,
          failed: false,
          width: captureDiag.canvasSize?.width || null,
          height: captureDiag.canvasSize?.height || null,
          slices: captureDiag.slices?.length || 1,
          sizeKB: imageKB,
          base64Len: base64Data.length,
          isLikelyBlank: captureDiag.blankCheck?.isLikelyBlank || false,
          nonWhitePixels: captureDiag.blankCheck?.nonWhitePixels ?? null,
          overlaysHidden: captureDiag.overlaysHidden || [],
          sourceType: captureDiag.sourceType || 'unknown',
          scrollContainer: captureDiag.scrollContainer || '',
          dataUrlPreview: base64Data.length <= 2000000 ? dataUrlFull : null
        });
      }

      if (!base64Data || base64Data.length < 50) {
        const directImg = await extractContentImagesFallback(d);
        if (directImg && directImg.base64) {
          base64Data = directImg.base64;
          attachedMimeType = directImg.mimeType || 'image/png';
          dataUrlFull = directImg.dataUrl || `data:${attachedMimeType};base64,${base64Data}`;
          imageKB = Number(((base64Data.length * 0.75) / 1024).toFixed(1));
          logAgentActivity(`[Soal ${qNum}] Mengambil gambar <img> langsung (${imageKB} KB) sebagai fallback screenshot...`);
        }
      }

      if (!base64Data || base64Data.length < 50) {
        const detail = captureDiag.failReason || "alasan tidak diketahui";
        saveCapturedDebugPreview({
          ts: new Date().toISOString(),
          qNum,
          failed: true,
          failReason: detail,
          diag: captureDiag,
          dataUrlPreview: null
        });
        throw new Error(`Gagal memperoleh gambar soal (${detail})`);
      }
    } catch (captureErr) {
      logDebugEvent('AI_VISION', 'ERROR', `Capture gambar soal gagal${speedVision ? '' : ' -> dialihkan ke Text'}: ${captureErr.message}`, {
        qNum, error: captureErr.message, captureDiag
      });
      logAgentActivity(`❌ [Soal ${qNum}] Capture gagal${speedVision ? '' : ', dialihkan ke Text'}: ${captureErr.message}`);
      if (speedVision) return { success: false, mode: 'Speed Vision Capture Failed' };
      base64Data = "";
    }

    // 1A. JALUR OCR-FIRST HYBRID (PADDLEOCR-VL-1.6)
    if (base64Data && canUseOcr) {
      try {
        logAgentActivity(`[Soal ${qNum}] Mengirim gambar (${captureDiag.canvasSize?.width || '?'}x${captureDiag.canvasSize?.height || '?'}, ${imageKB} KB) ke PaddleOCR (${ocrModel})...`);
        logDebugEvent('OCR', 'INFO', `Mengirim gambar ke PaddleOCR (${ocrModel})`, {
          qNum, ocrModel, imageKB, canvasSize: captureDiag.canvasSize
        });

        let lastLoggedState = "";
        const ocrRes = await globalThis.KamusMiniOcr.runPaddleOcr({
          imageBase64: base64Data,
          filename: `question_${qNum}.png`,
          token: ocrToken,
          model: ocrModel,
          jobUrl: ocrJobUrl,
          shouldAbort: () => !shouldContinue(),
          onProgress: (p) => {
            if (p.stage === 'submitted') {
              logDebugEvent('OCR', 'INFO', `Job PaddleOCR dibuat (jobId=${p.jobId})`, { qNum, jobId: p.jobId });
            } else if (p.stage === 'polling' && p.state && p.state !== lastLoggedState) {
              lastLoggedState = p.state;
              logDebugEvent('OCR', 'INFO', `Status PaddleOCR: ${p.state} (poll #${p.pollCount})`, { qNum, ...p });
            }
          }
        });

        const diagramImages = Array.isArray(ocrRes.diagramImages) ? ocrRes.diagramImages : [];
        const hasDiagrams = diagramImages.length > 0;
        const ocrMode = !hasDiagrams
          ? 'OCR_TEXT_ONLY'
          : (supportsVision ? 'OCR_VISION_CROP' : 'OCR_TEXT_ONLY_NO_VISION');

        mergeCapturedDebugPreview({
          ocrUsed: true,
          ocrMode,
          ocrJobId: ocrRes.jobId,
          ocrDurationMs: ocrRes.durationMs,
          ocrStats: ocrRes.stats,
          ocrMarkdown: ocrRes.cleanMarkdown,
          ocrDiagramPreviews: diagramImages.map(img => ({
            marker: img.marker,
            mimeType: img.mimeType,
            sizeKB: Number(((img.sizeBytes || 0) / 1024).toFixed(1)),
            dataUrl: (img.dataUrl && img.dataUrl.length <= 450000) ? img.dataUrl : null
          }))
        });

        logDebugEvent('OCR', 'SUCCESS', `PaddleOCR selesai (${ocrRes.durationMs}ms): ${ocrRes.stats.markdownLen} karakter, ${diagramImages.length} potongan diagram -> ${ocrMode}`, {
          qNum,
          jobId: ocrRes.jobId,
          ocrMode,
          durationMs: ocrRes.durationMs,
          stats: ocrRes.stats,
          cleanMarkdownPreview: ocrRes.cleanMarkdown.slice(0, 1200)
        });

        // Simpan hasil ke Cache OCR (Tahap 2)
        await saveOcrCache(qFingerprint, {
          cleanMarkdown: ocrRes.cleanMarkdown,
          diagramImages: diagramImages,
          stats: ocrRes.stats,
          ocrMode: ocrMode
        });

        if (hasDiagrams && !supportsVision) {
          logAgentActivity(`⚠️ [Soal ${qNum}] PaddleOCR mendeteksi ${diagramImages.length} diagram, tetapi provider ${provider.toUpperCase()} tidak mendukung lampiran gambar. Mengirim Markdown OCR saja...`);
        } else if (hasDiagrams) {
          logAgentActivity(`[Soal ${qNum}] PaddleOCR: Terdeteksi ${diagramImages.length} gambar diagram + teks Markdown (${ocrRes.stats.markdownLen} char). Mengirim ke ${provider.toUpperCase()} Vision...`);
        } else {
          logAgentActivity(`[Soal ${qNum}] PaddleOCR: Teks/rumus murni (${ocrRes.stats.markdownLen} char, 0 diagram). Mengirim Markdown bersih ke ${provider.toUpperCase()}...`);
        }

        const { systemPrompt: aiSystemPrompt, userPrompt: ocrUserPrompt } = buildDirectAiPrompts({
          questionType,
          isMultiChoice,
          expectedCount,
          mode: 'ocr',
          ocrMarkdown: ocrRes.cleanMarkdown,
          options,
          hasDiagramImages: hasDiagrams,
          groqNoVisionWarning: hasDiagrams && !supportsVision
        });
        const attachImages = (ocrMode === 'OCR_VISION_CROP') ? diagramImages : [];

        const logCategory = attachImages.length > 0 ? 'AI_VISION' : 'AI_TEXT';
        logDebugEvent(logCategory, 'INFO', `Mengirim hasil ${ocrMode} ke ${provider.toUpperCase()}`, {
          qNum,
          provider,
          model: (provider === 'custom') ? (config.aiCustomModel || model) : model,
          ocrMode,
          questionType,
          attachedDiagramCount: attachImages.length,
          promptLen: ocrUserPrompt.length
        });

        const aiResp = await callConfiguredAiApi({
          provider,
          apiKey,
          model,
          config,
          systemPrompt: aiSystemPrompt,
          userPrompt: ocrUserPrompt,
          images: attachImages
        });

        const parsed = parseAiResponse(aiResp.rawReply, questionType);
        logDebugEvent(logCategory, 'INFO', `Respons ${ocrMode} diterima (HTTP ${aiResp.httpStatus}, ${aiResp.durationMs}ms)`, {
          qNum,
          ocrMode,
          httpStatus: aiResp.httpStatus,
          elapsedAiMs: aiResp.durationMs,
          rawReplyLen: aiResp.rawReply.length,
          rawReplyPreview: aiResp.rawReply.slice(0, 700),
          parsed
        });

        mergeCapturedDebugPreview({
          aiChoice: parsed.choice,
          aiAnswer: parsed.answer,
          aiReasoning: parsed.reasoning,
          aiDurationMs: aiResp.durationMs,
          aiModel: aiResp.model
        });

        const matched = await applyDirectResult(parsed, 0.60);
        const modeLabel = (ocrMode === 'OCR_VISION_CROP') ? 'PaddleOCR + Vision Crop' : 'PaddleOCR + Text AI';
        if (matched.success) {
          logAgentActivity(`[Soal ${qNum}] ${modeLabel} Sukses! Memilih ${parsed.choice || 'Jawaban'}. (${parsed.answer || ''})`);
          return { success: true, mode: modeLabel };
        }

        logAgentActivity(`⚠️ [Soal ${qNum}] ${modeLabel} menjawab choice="${parsed.choice || ''}" (${String(parsed.answer || '').slice(0, 120)}), tidak cocok ke elemen opsi.`);
        return { success: false, mode: `${modeLabel} (No Choice)` };
      } catch (ocrErr) {
        if (ocrErr?.aborted || !isAgentRunning) {
          logAgentActivity(`🛑 [Soal ${qNum}] Proses PaddleOCR dihentikan oleh pengguna.`);
          return { success: false, mode: 'Stopped' };
        }
        logDebugEvent('OCR', 'WARN', `PaddleOCR gagal -> fallback ke Direct Vision Screenshot: ${ocrErr.message}`, {
          qNum, error: ocrErr.message
        });
        mergeCapturedDebugPreview({
          ocrUsed: true,
          ocrMode: supportsVision ? 'OCR_FALLBACK_VISION' : 'OCR_FALLBACK_TEXT',
          ocrError: ocrErr.message
        });
        logAgentActivity(`⚠️ [Soal ${qNum}] PaddleOCR gagal (${ocrErr.message}). Fallback otomatis ke Direct Vision Screenshot...`);
      }
    }

    // 1B. DIRECT VISION SCREENSHOT PENUH (DEFAULT TANPA OCR ATAU FALLBACK SAAT OCR GAGAL)
    if (base64Data && supportsVision) {
      try {
        const { systemPrompt: visionSystemPrompt, userPrompt: promptText } = buildDirectAiPrompts({
          questionType,
          isMultiChoice,
          expectedCount,
          mode: 'vision',
          questionText,
          options
        });

        const targetModel = (provider === 'custom') ? (config.aiCustomModel || model) : model;
        logAgentActivity(`[Soal ${qNum}] Mengirim gambar (${captureDiag.canvasSize?.width || '?'}x${captureDiag.canvasSize?.height || '?'}, ${imageKB} KB, ${captureDiag.slices?.length || 1} slice) ke ${provider.toUpperCase()} Vision (${targetModel})...`);
        logDebugEvent('AI_VISION', 'INFO', `Mengirim request Vision ke ${provider.toUpperCase()}`, {
          qNum, provider, model: targetModel, imageKB, questionType,
          base64Len: base64Data.length,
          canvasSize: captureDiag.canvasSize, slices: captureDiag.slices?.length,
          isLikelyBlank: captureDiag.blankCheck?.isLikelyBlank
        });

        const aiResp = await callConfiguredAiApi({
          provider,
          apiKey,
          model,
          config,
          systemPrompt: visionSystemPrompt,
          userPrompt: promptText,
          images: [{ mimeType: attachedMimeType, base64: base64Data, dataUrl: dataUrlFull }]
        });

        const parsed = parseAiResponse(aiResp.rawReply, questionType);
        logDebugEvent('AI_VISION', 'INFO', `Respons Vision diterima (HTTP ${aiResp.httpStatus}, ${aiResp.durationMs}ms)`, {
          qNum,
          httpStatus: aiResp.httpStatus,
          elapsedAiMs: aiResp.durationMs,
          rawReplyLen: aiResp.rawReply.length,
          rawReplyPreview: aiResp.rawReply.slice(0, 700),
          parsed
        });

        mergeCapturedDebugPreview({
          aiChoice: parsed.choice,
          aiAnswer: parsed.answer,
          aiReasoning: parsed.reasoning,
          aiDurationMs: aiResp.durationMs,
          aiModel: aiResp.model
        });

        const matched = await applyDirectResult(parsed, 0.60);
        if (matched.success) {
          const actionVerb = (questionType === 'choice') ? `Memilih ${parsed.choice || 'Jawaban'}` : 'Mengetik jawaban';
          logAgentActivity(`[Soal ${qNum}] Direct AI (Vision) Sukses! ${actionVerb}. (${parsed.answer || ''})`);
          return { success: true, mode: 'Direct AI Vision' };
        } else {
          logAgentActivity(`⚠️ [Soal ${qNum}] AI Vision menjawab choice="${parsed.choice || ''}" (${String(parsed.answer || '').slice(0, 120)}), tidak cocok ke elemen opsi.`);
          return { success: false, mode: 'Direct AI Vision (No Choice)' };
        }
      } catch (err) {
        logDebugEvent('AI_VISION', 'ERROR', `Direct AI Vision gagal${speedVision ? '' : ' -> dialihkan ke Text'}: ${err.message}`, {
          qNum, error: err.message, captureDiag
        });
        logAgentActivity(`❌ [Soal ${qNum}] Direct AI Vision gagal${speedVision ? '' : ', dialihkan ke Text'}: ${err.message}`);
        console.warn(err);
        if (speedVision) return { success: false, mode: 'Speed Vision Failed' };
      }
    }
  }

  // 2. UNTUK SOAL TEKS BIASA (ATAU FALLBACK TERAKHIR SAAT VISION & OCR GAGAL)
  try {
    const displayModel = (provider === 'custom') ? (config.aiCustomModel || model) : model;
    if (hasImage) {
      logAgentActivity(`⚠️ [Soal ${qNum}] Peringatan: Mode teks berjalan TANPA lampiran gambar karena OCR & Vision dilewati/gagal.`);
    }
    logAgentActivity(`[Soal ${qNum}] Mengirim soal teks ke ${provider.toUpperCase()} (${displayModel})...`);
    logDebugEvent('AI_TEXT', 'INFO', `Mengirim request Text ke ${provider.toUpperCase()}`, {
      qNum, provider, model: displayModel, hasImageOnPage: hasImage,
      questionLen: questionText.length, options
    });

    const { systemPrompt: textSystemPrompt, userPrompt: promptText } = buildDirectAiPrompts({
      questionType,
      isMultiChoice,
      expectedCount,
      mode: 'text',
      questionText,
      options
    });

    const aiResp = await callConfiguredAiApi({
      provider,
      apiKey,
      model,
      config,
      systemPrompt: textSystemPrompt,
      userPrompt: promptText,
      images: []
    });

    const parsed = parseAiResponse(aiResp.rawReply, questionType);
    logDebugEvent('AI_TEXT', 'INFO', `Respons Text diterima`, {
      qNum,
      questionType,
      replyLen: aiResp.rawReply.length,
      replyPreview: aiResp.rawReply.slice(0, 700),
      parsed
    });

    mergeCapturedDebugPreview({
      aiChoice: parsed.choice,
      aiAnswer: parsed.answer,
      aiReasoning: parsed.reasoning,
      aiDurationMs: aiResp.durationMs,
      aiModel: aiResp.model
    });

    const matched = await applyDirectResult(parsed, threshold);
    if (matched.success) {
      const actionVerb = (questionType === 'choice') ? `Memilih ${parsed.choice || 'Jawaban'}` : 'Mengetik jawaban';
      logAgentActivity(`[Soal ${qNum}] Direct AI Sukses! ${actionVerb}. (${parsed.answer || ''})`);
      return { success: true, mode: 'Direct AI' };
    } else {
      logAgentActivity(`⚠️ [Soal ${qNum}] AI merespons ${parsed.choice || ''}: ${parsed.answer || ''}, tetapi gagal mengisi elemen jawaban.`);
    }
  } catch (err) {
    logDebugEvent('AI_TEXT', 'ERROR', `Direct AI Error: ${err.message}`, { qNum, error: err.message });
    logAgentActivity(`❌ [Soal ${qNum}] Direct AI Error: ${err.message}`);
    console.error(err);
  }

  return { success: false, mode: 'Failed' };
}

// ======================================================
// TWO-LEVEL NESTED FALLBACK / DUAL-ENGINE CORE SOLVER
// ======================================================
async function solveQuestionFlow(qNum, doc, targetScope = null, shouldContinue = () => isAgentRunning) {
  if (!shouldContinue()) return { success: false, mode: 'Stopped' };
  const { doc: rootDoc, scope: d } = resolveQuizDocAndScope(targetScope || doc);
  const config = await new Promise(r => chrome.storage.local.get([
    'solverEngine',
    'aiProvider',
    'aiApiKey',
    'aiModel',
    'aiCustomBaseUrl',
    'aiCustomModel',
    'imageProcessingMode',
    'ocrEnabled',
    'paddleOcrToken',
    'paddleOcrModel',
    'paddleOcrJobUrl',
    'apiKey',
    'baseUrl',
    'matchThreshold',
    'selectedModelId'
  ], r));
  if (!shouldContinue()) return { success: false, mode: 'Stopped' };

  const engine = config.solverEngine || 'direct_ai';
  const questionType = detectQuizInputType(d);
  const questionText = scrapeQuestionText(d);
  const options = scrapeOptionsText(d);
  const ctxInfo = findQuizContextInRoot(document, rootDoc);
  const imgStats = inspectFormulationImages(d.querySelector('.formulation') || d);

  logDebugEvent('SOLVER', 'INFO', `Memulai pengerjaan Soal #${qNum}`, {
    engine,
    questionType,
    provider: config.aiProvider || 'gemini',
    model: (config.aiProvider === 'custom') ? (config.aiCustomModel || config.aiModel) : (config.aiModel || 'default'),
    imageProcessingMode: config.imageProcessingMode === 'ocr_first' ? 'ocr_first' : 'vision_first',
    ocrEnabled: config.ocrEnabled !== false,
    hasOcrToken: Boolean((config.paddleOcrToken || '').trim()),
    ocrModel: config.paddleOcrModel || 'PaddleOCR-VL-1.6',
    sourceType: ctxInfo ? ctxInfo.sourceType : 'unknown',
    iframeChainLen: ctxInfo ? ctxInfo.iframeChain.length : 0,
    hasImageTags: checkForImageTags(d),
    imgStats,
    questionPreview: questionText.slice(0, 160),
    options
  });

  // JIKA MENGGUNAKAN DIRECT AI (atau Kamus Mini Cloud belum ready / Coming Soon)
  if (engine === 'direct_ai' || !CLOUD_BACKEND_READY) {
    if (engine !== 'direct_ai' && !CLOUD_BACKEND_READY) {
      logAgentActivity(`[Soal ${qNum}] Kamus Mini Cloud masih Coming Soon -> dialihkan ke Direct AI.`);
    }
    return await solveWithDirectAI(qNum, questionText, options, config, d, { shouldContinue });
  }

  // JIKA MENGGUNAKAN KAMUS MINI CLOUD (mylms.melvino.online)
  const apiKey = (config.apiKey || "").trim();
  const baseUrl = KAMUS_MINI_CLOUD_URL;
  const rawThresh = config.matchThreshold !== undefined ? Number(config.matchThreshold) : 75;
  const threshold = rawThresh > 1 ? rawThresh / 100 : rawThresh;

  if (!apiKey) {
    showToast("", "Cloud Key kosong", "error");
    logAgentActivity("❌ Gagal: API Key Kamus Mini Cloud belum diatur. Agen dihentikan.");
    isAgentRunning = false;
    setAgentState({ agentState: { status: 'idle' } });
    return { success: false, mode: 'Config Error' };
  }
  
  const sourceCtx = globalThis.KamusQuestionLogs?.context(questionType, Boolean(d.querySelector('.answer input[type="checkbox"]')), extractExpectedMultiChoiceCount(questionText));
  const fallbackCtx = { questionText, options, config, shouldContinue, sourceCtx };

  // 0. Cek Awal: Deteksi Gambar -> Langsung Fallback 2 (Math Mode / Direct AI Vision fallback)
  if (checkForImageTags(d)) {
    logAgentActivity(`[Soal ${qNum}] Terdeteksi Gambar/Rumus. Menggunakan ${config.imageProcessingMode === 'ocr_first' ? 'Cloud OCR' : 'Cloud Vision Cepat' }.`);
    return await executeFallback2(qNum, baseUrl, apiKey, threshold, d, fallbackCtx);
  }

  const hasCheckboxes = Boolean(d.querySelector('.answer input[type="checkbox"]'));
  const expectedMultiCount = hasCheckboxes ? extractExpectedMultiChoiceCount(questionText) : 0;
  const isMultiAnswerQuestion = hasCheckboxes && (expectedMultiCount >= 2 || /possible ones|all that apply|more than one|click on all|lebih dari satu/i.test(questionText));
  const hasDirectAiFallback = Boolean((config.aiApiKey || '').trim()) || (config.aiProvider === 'custom');

  const tryApplyCloudResponse = async (res, data, modeLabel, attemptLabel) => {
    if (!shouldContinue()) return null;
    if ((res && !res.ok) || !data || data.aiQuotaExceeded || (!data.answer && !data.choice) || Number(data.matchScore || 0) < threshold) {
      return null;
    }
    globalThis.KamusQuestionLogs?.answer(data);
    const match = await applyAnswerToQuizDom({ choice: data.choice || '', answer: data.answer || '' }, threshold, d, shouldContinue);
    if (!match.success) return null;

    const matchedCount = match.count || 1;
    const isIncompleteMulti = isMultiAnswerQuestion && (
      expectedMultiCount >= 2 ? matchedCount < expectedMultiCount : matchedCount === 1
    );

    if (isIncompleteMulti) {
      if (hasDirectAiFallback) {
        logAgentActivity(`⚠️ [Soal ${qNum}] Cloud (${attemptLabel}) hanya mengembalikan ${matchedCount} dari ${expectedMultiCount || 'beberapa'} jawaban checkbox. Menyempurnakan via Direct AI...`);
        const aiRefined = await solveWithDirectAI(qNum, questionText, options, config, d, { resetCheckboxesFirst: true, shouldContinue });
        if (aiRefined && aiRefined.success) {
          return aiRefined;
        }
      } else {
        logAgentActivity(`⚠️ [Soal ${qNum}] Cloud hanya mengembalikan ${matchedCount} jawaban untuk soal checkbox multi-jawaban (prompt fallback server memaksa "Pilih SATU"). Atur API Key Direct AI di Pengaturan atau perbarui prompt backend.`);
      }
    }

    logAgentActivity(`[Soal ${qNum}] ${attemptLabel} Sukses! Skor: ${(Number(data.matchScore || 0) * 100).toFixed(0)}%. Jawaban: ${data.answer || data.choice}`);
    return { success: true, mode: modeLabel, score: data.matchScore };
  };

  // ==========================================
  // ATTEMPT 1: Fast Text Search (Soal Saja)
  // ==========================================
  try {
    logAgentActivity(`[Soal ${qNum}] Attempt 1: Fast Text Search (${baseUrl})...`);
    const { res, body: data, limit } = await KamusMiniCloud.searchAnswer(apiKey, {
      questionText: questionText,
      context: sourceCtx, sourceOptions: options,
      options: null, // Attempt 1: teks soal saja
      modelId: config.selectedModelId || null
    });
    if (limit || data?.aiQuotaExceeded) {
      const waitSec = limit?.retryAfterSeconds || '?';
      const reason = limit?.reasonCode || 'QUOTA';
      logAgentActivity(`[Soal ${qNum}] AI dilimit (${reason}). Tunggu ${waitSec}s. DB lookup tetap jalan untuk soal ini.`);
    }
    const applied = await tryApplyCloudResponse(res, data, 'Cloud Fast Text', 'Attempt 1');
    if (applied) return applied;
  } catch (err) {
    console.warn(`[Soal ${qNum}] Attempt 1 mengalami error:`, err);
  }

  // ==========================================
  // FALLBACK 1: Refined Text Search (Soal + Opsi)
  // ==========================================
  try {
    logAgentActivity(`[Soal ${qNum}] Attempt 1 Gagal/Skor Rendah. Mencoba Fallback 1 (Soal + Opsi)...`);
    const { res, body: data, limit } = await KamusMiniCloud.searchAnswer(apiKey, {
      questionText: questionText,
      options: options, context: sourceCtx, sourceOptions: options,
      modelId: config.selectedModelId || null
    });
    if (limit || data?.aiQuotaExceeded) {
      const waitSec = limit?.retryAfterSeconds || '?';
      const reason = limit?.reasonCode || 'QUOTA';
      logAgentActivity(`[Soal ${qNum}] AI dilimit (${reason}). Tunggu ${waitSec}s. DB lookup tetap jalan untuk soal ini.`);
    }
    const applied = await tryApplyCloudResponse(res, data, 'Cloud Refined Text', 'Fallback 1');
    if (applied) return applied;
  } catch (err) {
    console.warn(`[Soal ${qNum}] Fallback 1 mengalami error:`, err);
  }

  // ==========================================
  // FALLBACK 2: Math Mode (Screenshot & OCR Cloud)
  // ==========================================
  logAgentActivity(`[Soal ${qNum}] Fallback 1 Gagal/Skor Rendah. Mencoba Fallback 2 (Cloud Math Mode)...`);
  return await executeFallback2(qNum, baseUrl, apiKey, threshold, d, fallbackCtx);
}

// Asynchronous execution of Fallback 2 (mendukung multipart langsung & background proxy fallback + Direct AI Vision fallback)
async function executeFallback2(qNum, baseUrl, apiKey, threshold, doc, fallbackCtx = null) {
  const shouldContinue = fallbackCtx?.shouldContinue || (() => isAgentRunning);
  if (!shouldContinue()) return { success: false, mode: 'Stopped' };
  const d = doc || getQuizDocument() || document;
  const imageProcessingMode = fallbackCtx?.config?.imageProcessingMode === 'ocr_first' ? 'ocr_first' : 'vision_first';
  const cloudVision = imageProcessingMode === 'vision_first';
  const questionType = detectQuizInputType(d);
  const questionText = fallbackCtx?.questionText || scrapeQuestionText(d);
  const options = fallbackCtx?.options || scrapeOptionsText(d);
  const isMultiChoice = Boolean(d.querySelector('.answer input[type="checkbox"]'));
  const expectedCount = isMultiChoice ? extractExpectedMultiChoiceCount(questionText) : 0;
  let imageBlob = null;
  try {
    logAgentActivity(`[Soal ${qNum}] Cloud ${cloudVision ? 'Vision Cepat: langsung ke AI, tanpa OCR' : 'OCR: ekstraksi gambar dahulu'}...`);
    imageBlob = await captureFormulationElement(d);
    if (!imageBlob) {
      const imgFallback = await extractContentImagesFallback(d);
      if (imgFallback && imgFallback.base64) {
        const bin = atob(imgFallback.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        imageBlob = new Blob([bytes], { type: imgFallback.mimeType || 'image/png' });
      }
    }
    if (!imageBlob) {
      throw new Error("Gagal memotong tangkapan layar maupun mengambil <img> soal");
    }

    const modelCfg = await new Promise(r => chrome.storage.local.get(['selectedModelId'], r));
    const selectedId = (fallbackCtx && fallbackCtx.config && fallbackCtx.config.selectedModelId) || modelCfg.selectedModelId || null;
    const { res, body: data, limit } = await KamusMiniCloud.searchAnswerImage(apiKey, {
      imageBlob, filename: `question_${qNum}.png`, modelId: selectedId,
      imageProcessingMode, questionText, options, questionType, isMultiChoice, expectedCount, context: fallbackCtx?.sourceCtx
    });
    if (limit || data?.aiQuotaExceeded) {
      const waitSec = limit?.retryAfterSeconds || '?';
      const reason = limit?.reasonCode || 'QUOTA';
      logAgentActivity(`[Soal ${qNum}] AI Cloud dilimit (${reason}). Tunggu ${waitSec}s.`);
    }

    if (!shouldContinue()) return { success:false, mode:'Stopped' };
    if (data) globalThis.KamusQuestionLogs?.answer(data);
    if (imageBlob) globalThis.KamusQuestionLogs?.blob(imageBlob);
    if (data?.timings) logDebugEvent('CLOUD', 'INFO', `Waktu server soal #${qNum} (${data.imageProcessingMode || imageProcessingMode})`, { qNum, ...data.timings });
    if (cloudVision && (!res?.ok || limit || data?.aiQuotaExceeded || data?.imageProcessingMode !== 'vision_first')) {
      throw new Error(data?.message || data?.error || limit?.message || 'Server belum menjalankan Mode Cepat Cloud. Perbarui backend atau pilih OCR dahulu.');
    }
    const isValidSuccess = Boolean(res && res.ok && !limit && !data?.aiQuotaExceeded);
    if (isValidSuccess && data && (data.answer || data.choice)) {
      const match = await applyAnswerToQuizDom({ choice: data.choice || '', answer: data.answer || '' }, 0.60, d, shouldContinue);
      if (match.success) {
        logAgentActivity(`[Soal ${qNum}] ${cloudVision ? 'Cloud Vision Cepat' : 'Cloud OCR'} Sukses! Skor Match: ${(Number(data.matchScore || 0) * 100).toFixed(0)}%. Jawaban: ${data.answer || data.choice}`);
        return { success: true, mode: cloudVision ? 'Cloud AI Vision' : 'Cloud Math OCR', score: data.matchScore };
      }
    }
  } catch (err) {
    logAgentActivity(`❌ [Soal ${qNum}] Fallback 2 Cloud Gagal: ${err.message}`);
    console.error(`[Soal ${qNum}] Fallback 2 mengalami error:`, err);
    if (cloudVision) return { success: false, mode: 'Cloud Vision Failed', error: err.message };
  }

  if (cloudVision) return { success: false, mode: 'Cloud Vision Failed', error: 'Jawaban Vision tidak dapat diterapkan ke soal. Tidak mencoba OCR otomatis.' };

  // Fallback otomatis ke Direct AI Vision jika Cloud gagal / tidak menemukan jawaban (sangat berguna untuk Essay bergambar)
  const cfg = fallbackCtx && fallbackCtx.config;
  const canUseDirectAi = Boolean(cfg && ((cfg.aiApiKey || '').trim() || cfg.aiProvider === 'custom'));
  if (canUseDirectAi) {
    logAgentActivity(`⚠️ [Soal ${qNum}] Cloud Image tidak memberi jawaban valid. Mengalihkan otomatis ke Direct AI Vision...`);
    return await solveWithDirectAI(qNum, fallbackCtx.questionText || scrapeQuestionText(d), fallbackCtx.options || scrapeOptionsText(d), cfg, d, {
      shouldContinue,
      preCapturedBlob: imageBlob || null
    });
  }

  logAgentActivity(`⚠️ [Soal ${qNum}] Lewati Soal. Seluruh metode pencarian gagal.`);
  return { success: false, mode: 'Failed' };
}

// ---- QUIZ NAVIGATION HELPERS (ANTI-LOOP & SUBMIT GUARD) ----
const EXCLUDED_NAV_SELECTOR = [
  '.qtext',
  '.answer',
  '.qn_buttons',
  '[id^="quiznavbutton"]',
  '.othernav',
  '#mod_quiz_navblock',
  '.block_quiz_navigation',
  'header',
  'footer',
  'nav',
  'aside',
  '.breadcrumb',
  '.activity-navigation',
  '#next-activity-link',
  '#prev-activity-link',
  '.course-content'
].join(', ');

function getNavControlLabel(el) {
  if (!el) return '';
  return String(el.value || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isVisibleEnabledControl(el, doc) {
  if (!el) return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  if (String(el.type || '').toLowerCase() === 'hidden') return false;
  try {
    const win = (doc && doc.defaultView) || el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }
  } catch (_) {}
  return true;
}

function getCurrentPageNumberFromDoc(doc) {
  try {
    const href = String((doc && doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || window.location.href || '');
    const m = href.match(/[?&]page=(\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) {
    return 0;
  }
}

function isExcludedQuizNavElement(el, doc) {
  if (!el) return true;
  if (el.closest && el.closest(EXCLUDED_NAV_SELECTOR)) {
    return true;
  }
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'A') {
    const href = String(el.getAttribute('href') || '').trim();
    if (!href || href === '#' || /^javascript:/i.test(href)) return true;
    if (/\/course\/view\.php|summary\.php|attempt\.php\?.*finish|mod\/[^/]+\/view\.php/i.test(href)) {
      return true;
    }
    const pageMatch = href.match(/[?&]page=(\d+)/i);
    if (pageMatch) {
      const targetPage = parseInt(pageMatch[1], 10);
      const currentPage = getCurrentPageNumberFromDoc(doc);
      if (!Number.isNaN(targetPage) && targetPage <= currentPage) {
        return true; // Hindari lompat mundur atau loop di halaman sekarang
      }
    }
  }
  return false;
}

function classifyNavButtonRole(el) {
  if (!el) return 'other';
  const label = getNavControlLabel(el).toLowerCase();
  const id = String(el.id || '').toLowerCase();
  const name = String(el.getAttribute('name') || '').toLowerCase();

  // 1. Tombol Previous / Sebelumnya harus selalu diabaikan
  if (
    name === 'previous' ||
    name === 'prev' ||
    id.includes('prev-nav') ||
    id.includes('prev') ||
    /(previous|sebelumnya|kembali|prev page)/i.test(label)
  ) {
    return 'previous';
  }

  // 2. Cek Finish / Submit / Selesai LEBIH DULU (Moodle tetap mempertahankan name="next" & id="mod_quiz-next-nav" pada tombol "Finish attempt ...")
  if (
    /(finish attempt|submit all|selesaikan kuis|selesaikan upaya|akhiri percobaan|akhiri kuis|kumpulkan)/i.test(label) ||
    /\b(submit|selesai|kirim)\b/i.test(label)
  ) {
    return 'finish_submit';
  }

  // 3. Tombol Next Page / Halaman Selanjutnya yang valid
  if (
    /^(next(\s*page)?|halaman\s*(selanjutnya|berikutnya)|selanjutnya|berikutnya|soal\s*berikutnya|lanjut(\s*soal)?)$/i.test(label) ||
    /\b(next page|halaman selanjutnya|halaman berikutnya)\b/i.test(label)
  ) {
    return 'next';
  }

  // 4. Fallback atribut standar tombol Next form Moodle apabila label kustom tetap bukan finish/previous
  if (name === 'next' || id === 'mod_quiz-next-nav' || el.classList?.contains('mod_quiz-next-nav')) {
    return 'next';
  }

  return 'other';
}

function findQuizNavigationTarget(doc) {
  const d = doc || getQuizDocument() || document;

  // Prioritas 1: Kontrol submit resmi di dalam form #responseform / .submitbtns Moodle
  const formSelectors = [
    'form#responseform .submitbtns input[type="submit"], form#responseform .submitbtns button',
    'form[action*="processattempt"] .submitbtns input[type="submit"], form[action*="processattempt"] .submitbtns button',
    '.submitbtns #mod_quiz-next-nav, .submitbtns [name="next"], form#responseform [name="next"]',
    '#mod_quiz-next-nav, .mod_quiz-next-nav'
  ].join(', ');

  const seen = new Set();
  const formControls = Array.from(d.querySelectorAll(formSelectors));
  for (const el of formControls) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisibleEnabledControl(el, d) || isExcludedQuizNavElement(el, d)) continue;
    const role = classifyNavButtonRole(el);
    if (role === 'previous') continue;
    if (role === 'finish_submit') {
      return { action: 'stop_finish', element: el, label: getNavControlLabel(el) };
    }
    if (role === 'next') {
      return { action: 'click_next', element: el, label: getNavControlLabel(el) };
    }
  }

  // Prioritas 2: Fallback aman untuk LMS non-Moodle standar (tanpa memindai tautan <a> biasa atau a[href*="page="])
  let firstNext = null;
  let firstFinish = null;
  const fallbackControls = d.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, [role="button"]');
  for (const el of fallbackControls) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisibleEnabledControl(el, d) || isExcludedQuizNavElement(el, d)) continue;
    const role = classifyNavButtonRole(el);
    if (role === 'next' && !firstNext) {
      firstNext = el;
      break;
    }
    if (role === 'finish_submit' && !firstFinish) {
      firstFinish = el;
    }
  }

  if (firstNext) {
    return { action: 'click_next', element: firstNext, label: getNavControlLabel(firstNext) };
  }
  if (firstFinish) {
    return { action: 'stop_finish', element: firstFinish, label: getNavControlLabel(firstFinish) };
  }
  return { action: 'none', element: null, label: '' };
}

// ---- NAVIGATION BUTTON CLICK SNIFFER ----
function attachNextButtonSniffer(doc) {
  try {
    const d = doc || getQuizDocument() || document;
    const buttons = d.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, [role="button"]');
    for (const btn of buttons) {
      if (isExcludedQuizNavElement(btn, d)) continue;
      if (classifyNavButtonRole(btn) !== 'next') continue;
      if (!btn.__hasAutoSolveListener) {
        btn.__hasAutoSolveListener = true;
        btn.addEventListener('click', () => {
          if (isAgentRunning) {
            clearPendingAgentTimer();
            logAgentActivity("🖱️ Tombol navigasi Next diklik. Memantau pemuatan soal berikutnya...");
            setTimeout(checkAndAutoSolveNewQuestion, 600);
            setTimeout(checkAndAutoSolveNewQuestion, 1200);
          }
        });
      }
    }
  } catch (e) {}
}

// ======================================================
// AGENT CONTROLLER & LOOPING ENGINE
// ======================================================
async function startAgentLoop() {
  if (!isExtensionValid() || isManagedByTopFrame()) {
    if (!isExtensionValid()) {
      console.warn("Koneksi ekstensi terputus (Extension context invalidated). Silakan refresh halaman.");
    }
    return;
  }
  if (!isAgentRunning || isSolvingActive) return;

  const generation = agentGeneration;
  const shouldContinue = () => isAgentRunning && agentGeneration === generation;
  const doc = getQuizDocument();
  if (!doc) {
    logAgentActivity("⚠️ Tidak ada elemen kuis (.formulation) di halaman atau frame ini.");
    return;
  }

  const formulation = doc.querySelector('.formulation');
  if (!formulation) return;

  if (doc.__isAgentSolving) return;
  doc.__isAgentSolving = true;
  isSolvingActive = true;

  try {
    // 1. Periksa Captcha Terlebih Dahulu
    if (handleProactiveCaptchaCheck()) {
      return;
    }

    // 2. Kumpulkan seluruh soal yang dapat dijawab pada halaman ini (1 soal atau banyak soal sekaligus)
    const allQuestions = getPageQuestions(doc);
    const pendingQuestions = allQuestions.filter(q => !solvedQuestionKeys.has(getQuestionIdentityFromElement(q).questionKey));
    if (pendingQuestions.length === 0) {
      return;
    }

    const pageIdentity = getCurrentQuestionIdentity(doc);
    lastSolvedQuestionKey = pageIdentity.questionKey;

    if (pendingQuestions.length > 1) {
      logAgentActivity(`📋 Terdeteksi ${pendingQuestions.length} soal pada halaman ini. Memproses berurutan...`);
    }

    // 3. Kerjakan seluruh soal pada halaman ini satu per satu secara terisolasi
    for (let i = 0; i < pendingQuestions.length; i++) {
      if (!shouldContinue()) return;

      const queScope = pendingQuestions[i];
      const { qNum, questionKey: itemKey } = getQuestionIdentityFromElement(queScope);
      lastObservedQNum = qNum;

      if (allQuestions.length > 1 && queScope !== doc) {
        await smoothScrollTo(queScope, { block: 'smart', topOffset: 88 });
      }

      const progressSuffix = pendingQuestions.length > 1 ? ` (${i + 1}/${pendingQuestions.length})` : '';
      showToast("", `Soal #${qNum}${progressSuffix}...`, 'info');

      const questionStartedAt = Date.now();
      const questionLogIdentity = globalThis.KamusQuestionLogs?.begin(qNum, itemKey);
      let result;
      try { result = await solveQuestionFlow(qNum, doc, queScope, shouldContinue); }
      catch (error) { result = { success:false, mode:'Error', error:error.message }; }
      logDebugEvent('SOLVER', result?.success ? 'SUCCESS' : 'WARN', `Total pengerjaan soal #${qNum}: ${((Date.now() - questionStartedAt) / 1000).toFixed(1)} detik`, {
        qNum, totalDurationMs: Date.now() - questionStartedAt, mode: result?.mode, success: Boolean(result?.success)
      });
      globalThis.KamusQuestionLogs?.finish(result, Date.now() - questionStartedAt, questionLogIdentity);
      if (!shouldContinue()) return;
      if (!result?.success) {
        logAgentActivity(`[Soal ${qNum}] Gagal dijawab: ${result?.error || result?.mode || 'Tidak ada jawaban valid'}. Agen berhenti; tekan Start untuk mencoba lagi.`);
        showToast("", `Gagal · #${qNum}`, 'warning');
        isAgentRunning = false;
        clearPendingAgentTimer();
        setAgentState({ agentState: { status: 'idle', message: result?.error || `Gagal menjawab soal #${qNum}` } });
        return;
      }
      solvedQuestionKeys.add(itemKey);

      if (!shouldContinue()) return;
      if (i < pendingQuestions.length - 1) {
        await new Promise(r => setTimeout(r, 350));
      }
    }

    // Pasang sniffer ke tombol navigasi jika user klik manual nanti
    attachNextButtonSniffer(doc);

    // 4. Cek kelanjutan
    if (!shouldContinue()) return; // Jika disetop manual saat pengerjaan

    // 5. Cek Mode Navigasi (Semi-Auto vs Full-Auto)
    const navStorage = await new Promise(r => chrome.storage.local.get(['navigationMode', 'baselineDelay', 'agentState'], r));
    if (!shouldContinue()) return;
    const isSemiAuto = (navStorage.navigationMode !== 'full_auto'); // Default: semi_auto

    if (isSemiAuto) {
      if (pendingQuestions.length > 1) {
        logAgentActivity(`✅ [Semi-Auto] Seluruh ${pendingQuestions.length} soal di halaman ini selesai dijawab. Silakan periksa jawaban lalu tekan tombol Next/Finish.`);
        showToast("", `Dipilih · ${pendingQuestions.length} soal`, "success");
      } else {
        logAgentActivity(`✅ [Semi-Auto] Soal #${lastObservedQNum} selesai dijawab. Silakan periksa jawaban Anda dan tekan tombol Selanjutnya/Next secara manual.`);
        showToast("", `Dipilih · #${lastObservedQNum}`, "success");
      }
      return;
    }

    // 6. Jika Full-Auto: Klasifikasikan tombol Next vs Finish/Submit dengan aman
    const navTarget = findQuizNavigationTarget(doc);

    if (navTarget.action === 'stop_finish') {
      logAgentActivity(`🏁 Tombol berubah menjadi "${navTarget.label || 'Finish attempt / Submit'}" (Submit/Selesai). Auto Mode berhenti agar Anda bisa meninjau & mengirim kuis.`);
      showToast("", "Siap Submit · Selesai", "success");
      isAgentRunning = false;
      clearPendingAgentTimer();
      setAgentState({ agentState: { status: 'completed' } });
      return;
    }

    if (navTarget.action === 'click_next' && navTarget.element) {
      const targetNextBtn = navTarget.element;
      const baselineDelay = navStorage.baselineDelay !== undefined ? Number(navStorage.baselineDelay) : 3;

      const randomExtra = Math.floor(Math.random() * 3000) + 1000;
      const finalDelay = (baselineDelay * 1000) + randomExtra;

      logAgentActivity(`⏳ Menunggu ${(finalDelay / 1000).toFixed(1)} detik sebelum menekan tombol "${navTarget.label || 'Next page'}"...`);

      clearPendingAgentTimer();
      isPendingNextNavigation = true;
      const priorSameCount = Number(navStorage.agentState?.samePageNavCount || 0);
      const navPageUrl = window.location.href;
      const checkpointKey = pageIdentity.questionKey;

      agentLoopTimeout = setTimeout(async () => {
        agentLoopTimeout = null;
        if (!shouldContinue()) {
          isPendingNextNavigation = false;
          return;
        }

        // Catat checkpoint sebelum submit/navigasi agar reload halaman yang identik beruntun bisa dideteksi
        try {
          await new Promise(resolve => {
            setAgentState({
              agentState: {
                status: 'running',
                pendingAutoNext: true,
                lastAutoNavUrl: navPageUrl,
                lastAutoNavKey: checkpointKey,
                samePageNavCount: priorSameCount
              }
            }, resolve);
          });
        } catch (_) {}

        logAgentActivity(`➡ Menekan tombol "${navTarget.label || 'Next page'}" ke halaman kuis berikutnya...`);
        await smoothScrollTo(targetNextBtn);
        if (!shouldContinue()) {
          isPendingNextNavigation = false;
          return;
        }

        targetNextBtn.click();

        // Fail-safe lepas lock bila SPA gagal berpindah tanpa reload penuh
        setTimeout(() => {
          isPendingNextNavigation = false;
        }, 4000);
      }, finalDelay);
    } else {
      logAgentActivity("🏁 Tombol Next halaman berikutnya tidak ditemukan. Agen berhenti pengerjaan.");
      showToast("", "Selesai", "success");
      isAgentRunning = false;
      clearPendingAgentTimer();
      setAgentState({ agentState: { status: 'completed' } });
    }
  } finally {
    isSolvingActive = false;
    if (doc) doc.__isAgentSolving = false;
  }
}

// ======================================================
// ACTIVE HEARTBEAT & SPA QUESTION CHANGE POLLER
// ======================================================
function checkAndAutoSolveNewQuestion() {
  if (!isExtensionValid() || isManagedByTopFrame()) return;
  if (!isAgentRunning || isSolvingActive) return;

  const doc = getQuizDocument();
  if (!doc) return;

  const questions = getPageQuestions(doc);
  if (questions.length === 0) return;

  const firstUnsolved = questions.find(q => !solvedQuestionKeys.has(getQuestionIdentityFromElement(q).questionKey));
  if (firstUnsolved) {
    isPendingNextNavigation = false;
    const { qNum } = getQuestionIdentityFromElement(firstUnsolved);
    logAgentActivity(`🔄 Terdeteksi soal belum terjawab (#${qNum}). Menjawab otomatis...`);
    startAgentLoop();
  } else if (isPendingNextNavigation) {
    return;
  }
}

// Polling interval setiap 700ms (ringan dan responsif terhadap perubahan halaman/SPA)
setInterval(checkAndAutoSolveNewQuestion, 700);

// SPA Navigation listeners (hashchange & popstate untuk replayweb.page)
window.addEventListener('hashchange', () => {
  if (isAgentRunning && !isSolvingActive) {
    setTimeout(checkAndAutoSolveNewQuestion, 400);
    setTimeout(checkAndAutoSolveNewQuestion, 1000);
  }
});

window.addEventListener('popstate', () => {
  if (isAgentRunning && !isSolvingActive) {
    setTimeout(checkAndAutoSolveNewQuestion, 400);
    setTimeout(checkAndAutoSolveNewQuestion, 1000);
  }
});

// ---- MESSAGE LISTENER FROM POPUP ----
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!['startAgent', 'stopAgent', 'searchAnswer'].includes(request.action)) return false;
  if (isManagedByTopFrame()) return false;
  if (request.action === 'startAgent' && !getQuizDocument()) return false;
  agentTabReady.then(() => {
    if (request.action === 'startAgent') {
      if (isManagedByTopFrame()) return false;
      const doc = getQuizDocument();
      if (!doc || !doc.querySelector('.formulation')) {
        sendResponse({ success: false, reason: "no_quiz_in_frame" });
        return true;
      }
      if (!isAgentRunning) {
        isAgentRunning = true;
        resetSolvedQuestionTracking(); // Reset agar mengeksekusi seluruh soal di halaman aktif
        clearPendingAgentTimer();
        setAgentState({
          agentState: {
            status: 'running',
            pendingAutoNext: false,
            lastAutoNavUrl: null,
            lastAutoNavKey: null,
            samePageNavCount: 0
          }
        });
        logAgentActivity("🚀 AI Agent Auto-Solver dinyalakan oleh pengguna.");
        startAgentLoop();
      }
      sendResponse({ success: true, status: "running" });
    }
    else if (request.action === 'stopAgent') {
      isAgentRunning = false;
      resetSolvedQuestionTracking();
      clearPendingAgentTimer();
      if (isManagedByTopFrame()) return false;
      setAgentState({ agentState: { status: 'idle' } });
      logAgentActivity("🛑 AI Agent Auto-Solver dimatikan oleh pengguna.");
      showToast("", "Berhenti", "info");
      sendResponse({ success: true, status: "idle" });
    }
    else if (request.action === 'searchAnswer') {
      if (isManagedByTopFrame()) return false;
      fetchAnswer(request.query);
      sendResponse({ success: true });
    }
  });
  return true;
});

// ---- STORAGE SYNC LISTENER (AUTO-TRIGGER ACROSS ALL FRAMES/IFRAMES) ----
chrome.storage.onChanged.addListener(async (changes, area) => {
  await agentTabReady;
  if (area === 'local' && changes.agentState) {
    const newState = changes.agentState.newValue || {};
    if (!ownsAgentState(newState)) {
      if (isAgentRunning) {
        isAgentRunning = false;
        resetSolvedQuestionTracking();
        clearPendingAgentTimer();
      }
      return;
    }
    if (newState.status === 'running') {
      if (isManagedByTopFrame()) return;
      if (!isAgentRunning) {
        isAgentRunning = true;
        resetSolvedQuestionTracking();
        clearPendingAgentTimer();
        const doc = getQuizDocument();
        if (doc && doc.querySelector('.formulation')) {
          logAgentActivity("🚀 AI Agent Auto-Solver aktif di frame kuis.");
          startAgentLoop();
        }
      }
    } else if (['idle', 'completed', 'paused-by-captcha'].includes(newState.status)) {
      isAgentRunning = false;
      resetSolvedQuestionTracking();
      clearPendingAgentTimer();
    }
  }
});

// ---- KEYDOWN AUTO-SEARCH ----
document.addEventListener('keydown', (e) => {
  if (!isExamSite()) return;

  if (e.key === 'Enter') {
    const sel = window.getSelection().toString().trim();
    if (sel.length > 5) fetchAnswer(sel);
  }
}, true);

// ---- FORCE CSS OVERRIDE SELECTION (STEALTH COPIER) ----
(function () {
  if (!isExamSite()) return;

  const s = document.createElement('style');
  s.id = 'kj-select-override';
  s.textContent = `
    html, body, div, p, span, h1, h2, h3, h4, h5, h6, li, td, th, article, section, main, q, blockquote {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      -ms-user-select: text !important;
      user-select: text !important;
    }
  `;
  if (document.documentElement) {
    document.documentElement.appendChild(s);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.appendChild(s);
    }, true);
  }
})();
