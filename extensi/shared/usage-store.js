// A single worker cache serves the popup and every visible quiz overlay.
var KamusUsageStore = (() => {
  function create({ storage, fetchUsage, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    const ports = new Set();
    let state = { status: 'loading', data: null, cachedAt: null, stale: false };
    let pending = null;
    let timer = null;
    let generation = 0;
    let invalidated = false;

    function send(port) {
      try { port.postMessage(state); } catch (_) { ports.delete(port); }
    }
    function publish() { for (const port of ports) send(port); }
    function stopTimer() { if (timer !== null) cancel(timer); timer = null; }
    function planRefresh() {
      stopTimer();
      if (ports.size) timer = schedule(() => { timer = null; void refresh(); }, 10000);
    }
    function refresh(force = false) {
      if (!ports.size) return Promise.resolve();
      if (pending) return pending;
      if (!force && !invalidated && !state.stale && state.cachedAt !== null && now() - state.cachedAt < 10000) {
        planRefresh();
        return Promise.resolve();
      }
      const current = generation;
      invalidated = false;
      const work = (async () => {
        try {
          const saved = await storage.get('apiKey');
          if (current !== generation || !ports.size) return;
          const key = typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '';
          if (!key) state = { status: 'disconnected', data: null, cachedAt: null, stale: false };
          else {
            const data = await fetchUsage(key);
            if (current !== generation) return;
            state = { status: 'ready', data, cachedAt: now(), stale: invalidated };
          }
        } catch (_) {
          if (current !== generation) return;
          state = { ...state, status: 'error', stale: state.data !== null };
        } finally {
          if (current === generation) publish();
        }
      })();
      pending = work;
      void work.finally(() => {
        if (pending !== work) return;
        pending = null;
        if (invalidated && ports.size) void refresh(true);
        else planRefresh();
      });
      return work;
    }
    function invalidate(clear = false) {
      invalidated = true;
      if (clear) { generation++; pending = null; }
      stopTimer();
      state = clear
        ? { status: 'loading', data: null, cachedAt: null, stale: false }
        : { ...state, stale: state.data !== null };
      publish();
      void refresh(true);
    }
    function connect(port) {
      if (port.name !== 'kamus-usage') return;
      ports.add(port);
      send(port);
      port.onMessage.addListener(message => { if (message?.action === 'refresh') void refresh(true); });
      port.onDisconnect.addListener(() => {
        ports.delete(port);
        if (!ports.size) stopTimer();
      });
      void refresh();
    }
    return { connect, invalidate };
  }
  return { create };
})();
