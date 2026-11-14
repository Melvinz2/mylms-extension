// theme.js - Shared Zero-FOUC Theme Manager for Kamus Mini
// Supports 'auto' (system), 'light' (cool-white-slate), and 'dark' (green-black-bone)

(function () {
  function getSystemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function resolveEffectiveTheme(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return getSystemTheme();
  }

  function applyThemeToDocument(pref) {
    const effective = resolveEffectiveTheme(pref);
    const root = document.documentElement;
    root.setAttribute('data-theme', effective);
    root.setAttribute('data-theme-preference', pref || 'auto');
    try {
      localStorage.setItem('kamusMiniTheme', pref || 'auto');
    } catch (e) {}
    return effective;
  }

  // 1. Synchronous early execution to prevent Flash of Unstyled Color (FOUC)
  let initialPref = 'auto';
  try {
    initialPref = localStorage.getItem('kamusMiniTheme') || 'auto';
  } catch (e) {}
  applyThemeToDocument(initialPref);

  // 2. Sync with chrome.storage.local
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['uiTheme'], (res) => {
      const storedPref = res.uiTheme || initialPref || 'auto';
      if (storedPref !== initialPref) {
        applyThemeToDocument(storedPref);
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.uiTheme) {
        applyThemeToDocument(changes.uiTheme.newValue || 'auto');
        dispatchThemeChange(changes.uiTheme.newValue || 'auto');
      }
    });
  }

  // 3. Listen to system dark/light changes when in 'auto' mode
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMedia = () => {
      const currentPref = document.documentElement.getAttribute('data-theme-preference') || 'auto';
      if (currentPref === 'auto') {
        applyThemeToDocument('auto');
        dispatchThemeChange('auto');
      }
    };
    if (media.addEventListener) {
      media.addEventListener('change', handleMedia);
    } else if (media.addListener) {
      media.addListener(handleMedia);
    }
  }

  const subscribers = new Set();
  function dispatchThemeChange(pref) {
    const effective = resolveEffectiveTheme(pref);
    subscribers.forEach(cb => {
      try { cb({ preference: pref, effective: effective }); } catch (err) {}
    });
  }

  window.KamusMiniTheme = {
    getPreference: function () {
      return document.documentElement.getAttribute('data-theme-preference') || 'auto';
    },
    getEffectiveTheme: function () {
      return document.documentElement.getAttribute('data-theme') || resolveEffectiveTheme(this.getPreference());
    },
    setTheme: function (newPref) {
      const valid = (newPref === 'light' || newPref === 'dark') ? newPref : 'auto';
      applyThemeToDocument(valid);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ uiTheme: valid });
      }
      dispatchThemeChange(valid);
      return valid;
    },
    toggleCycle: function () {
      // Cycle: light -> dark -> light
      const current = this.getEffectiveTheme();
      const next = current === 'dark' ? 'light' : 'dark';
      this.setTheme(next);
      return next;
    },
    onChange: function (callback) {
      if (typeof callback === 'function') {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      }
    }
  };
})();

