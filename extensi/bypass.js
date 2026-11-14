(function() {
  'use strict';

  // Check if current site is an exam/quiz system to avoid breaking general websites.
  const isExamSite = () => {
    // Jika elemen kuis Moodle terdeteksi di DOM, otomatis valid
    if (document.querySelector && document.querySelector('.formulation')) {
      return true;
    }

    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    
    // Absolute exclusion list for common daily non-exam websites
    const excludedHosts = [
      'whatsapp.com', 'whatsapp.net', 'telegram.org', 'web.telegram.org',
      'google.com', 'google.co.id', 'youtube.com', 'facebook.com', 
      'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'zoom.us',
      'github.com', 'gmail.com', 'drive.google.com', 'stackoverflow.com'
    ];
    
    if (excludedHosts.some(ex => host.includes(ex))) {
      return false;
    }
    
    // Keywords representing exam/quiz websites (checked only on hostname or path)
    const examKeywords = [
      'ujian', 'exam', 'cbt', 'elearning', 'quiz', 'localhost', '127.0.0.1', 
      'mulok', 'test', 'evaluasi', 'assessment', 'bimtek', 'belajar',
      'lms', 'telkomschools', 'replayweb.page', 'webrecorder'
    ];
    
    return examKeywords.some(keyword => 
      host.includes(keyword) || path.includes(keyword)
    );
  };

  if (!isExamSite()) {
    console.log('Kamus Mini: Not an exam website. Bypassing engine deactivated to prevent website breakages.');
    return;
  }

  console.log('Kamus Mini: Exam website detected! Activating bypass engine...');

  // --- EXTRA HOOK: Block exam-related window alerts/popups ---
  const _origAlert = window.alert;
  window.alert = function(msg) {
    const text = String(msg).toLowerCase();
    if (text.includes('copy') || text.includes('paste') || text.includes('disabled') || text.includes('right click') || text.includes('cheat') || text.includes('dilarang') || text.includes('klik')) {
      console.log('Stealth-blocked alert:', msg);
      return;
    }
    return _origAlert.apply(this, arguments);
  };

  const _origConfirm = window.confirm;
  window.confirm = function(msg) {
    const text = String(msg).toLowerCase();
    if (text.includes('copy') || text.includes('paste') || text.includes('disabled') || text.includes('right click') || text.includes('cheat') || text.includes('dilarang') || text.includes('klik')) {
      console.log('Stealth-blocked confirm:', msg);
      return true;
    }
    return _origConfirm.apply(this, arguments);
  };

  // --- 1. Patch EventTarget.prototype.addEventListener to wrap key handlers ---
  const _origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    // Wrap keydown/keyup/keypress to drop keyboard copy-paste shortcuts before page-scripts get them
    if (['keydown', 'keyup', 'keypress'].includes(type) && typeof fn === 'function') {
      const originalFn = fn;
      fn = function(e) {
        if (e) {
          const isCmd = e.ctrlKey || e.metaKey;
          const key = (e.key || '').toLowerCase();
          // Filter out Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, and ContextMenu
          if (isCmd && ['c', 'v', 'x', 'a'].includes(key)) {
            return; 
          }
          if (e.key === 'ContextMenu') {
            return;
          }
        }
        return originalFn.apply(this, arguments);
      };

      if (!this._wrappedListeners) {
        this._wrappedListeners = new WeakMap();
      }
      this._wrappedListeners.set(originalFn, fn);
    }

    return _origAEL.call(this, type, fn, opts);
  };

  // Support removeEventListener properly
  const _origREL = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.removeEventListener = function(type, fn, opts) {
    if (this._wrappedListeners && this._wrappedListeners.has(fn)) {
      fn = this._wrappedListeners.get(fn);
    }
    return _origREL.call(this, type, fn, opts);
  };

  // --- 2. Intercept Event.prototype.preventDefault & stopPropagation to let browser defaults run ---
  const _origPD = Event.prototype.preventDefault;
  const ALLOW_EVENTS = ['contextmenu', 'selectstart', 'copy', 'cut', 'paste', 'dragstart', 'beforecopy'];
  Event.prototype.preventDefault = function() {
    if (ALLOW_EVENTS.includes(this.type)) {
      return;
    }
    if (['keydown', 'keyup', 'keypress'].includes(this.type)) {
      const isCmd = this.ctrlKey || this.metaKey;
      const key = (this.key || '').toLowerCase();
      if (isCmd && ['c', 'v', 'x', 'a'].includes(key)) {
        return;
      }
    }
    return _origPD.call(this);
  };

  const _origSP = Event.prototype.stopPropagation;
  const _origSIP = Event.prototype.stopImmediatePropagation;
  Event.prototype.stopPropagation = function() {
    if (ALLOW_EVENTS.includes(this.type)) return;
    return _origSP.call(this);
  };
  Event.prototype.stopImmediatePropagation = function() {
    if (ALLOW_EVENTS.includes(this.type)) return;
    return _origSIP.call(this);
  };

  // --- 3. Use Object.defineProperty to completely block assignment of on* properties ---
  const BLOCKED_PROPS = ['oncontextmenu', 'onselectstart', 'ondragstart', 'oncopy', 'oncut', 'onpaste', 'onbeforecopy'];
  const KEY_PROPS = ['onkeydown', 'onkeyup', 'onkeypress'];
  const TARGETS = [window, Document.prototype, HTMLDocument.prototype, HTMLElement.prototype, Element.prototype];

  BLOCKED_PROPS.forEach(prop => {
    TARGETS.forEach(target => {
      if (!target) return;
      try {
        Object.defineProperty(target, prop, {
          get() { return null; },
          set(val) { /* Silently drop any attempt to set inline blocking properties */ },
          configurable: true,
          enumerable: true
        });
      } catch (e) {}
    });
  });

  // For key properties, wrap assigned functions so they discard copy/paste shortcuts
  KEY_PROPS.forEach(prop => {
    TARGETS.forEach(target => {
      if (!target) return;
      try {
        let origDescriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (!origDescriptor && target !== window) {
          origDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), prop);
        }

        Object.defineProperty(target, prop, {
          get() {
            return this[`_${prop}_val`] || null;
          },
          set(fn) {
            if (typeof fn === 'function') {
              const originalFn = fn;
              fn = function(e) {
                if (e) {
                  const isCmd = e.ctrlKey || e.metaKey;
                  const key = (e.key || '').toLowerCase();
                  if (isCmd && ['c', 'v', 'x', 'a'].includes(key)) {
                    return;
                  }
                }
                return originalFn.apply(this, arguments);
              };
            }
            this[`_${prop}_val`] = fn;

            if (origDescriptor && origDescriptor.set) {
              origDescriptor.set.call(this, fn);
            }
          },
          configurable: true,
          enumerable: true
        });
      } catch (e) {}
    });
  });

  // --- 4. Strip dynamic inline event attributes (Fall-back Layer) ---
  function cleanHandlers(el) {
    if (!el) return;
    BLOCKED_PROPS.forEach(attr => {
      if (el[attr] !== null) {
        el[attr] = null;
      }
    });
  }

  function cleanAll() {
    cleanHandlers(window);
    cleanHandlers(document);
    if (document.documentElement) cleanHandlers(document.documentElement);
    if (document.body) cleanHandlers(document.body);
    
    const elements = document.querySelectorAll('[oncontextmenu],[onselectstart],[ondragstart],[oncopy],[oncut],[onpaste],[onbeforecopy]');
    elements.forEach(el => {
      BLOCKED_PROPS.forEach(attr => {
        if (el.hasAttribute(attr)) el.removeAttribute(attr);
      });
      cleanHandlers(el);
    });
  }

  cleanAll();
  document.addEventListener('DOMContentLoaded', cleanAll, true);
  window.addEventListener('load', cleanAll, true);

  const observer = new MutationObserver(() => {
    cleanAll();
  });
  
  const startObserver = () => {
    observer.observe(document.documentElement || document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...BLOCKED_PROPS, 'style', 'class']
    });
  };

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver, true);
  }

  // --- 5. Force User-Select CSS Styling ---
  const style = document.createElement('style');
  style.id = 'kj-main-select-style';
  style.textContent = `
    html, body, div, p, span, h1, h2, h3, h4, h5, h6, li, td, th, article, section, main, q, blockquote {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      -ms-user-select: text !important;
      user-select: text !important;
    }
  `;
  if (document.documentElement) {
    document.documentElement.appendChild(style);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.appendChild(style);
    }, true);
  }
})();
