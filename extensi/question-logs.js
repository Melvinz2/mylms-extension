(function (global) {
  'use strict';
  let active = null;
  let writes = Promise.resolve();
  function sessionId() {
    let id = sessionStorage.getItem('kamusCloudSession');
    const last = Number(sessionStorage.getItem('kamusCloudLastActivity') || 0);
    if (!id || Date.now() - last >= 30 * 60000) { id = crypto.randomUUID(); sessionStorage.setItem('kamusCloudSession', id); }
    sessionStorage.setItem('kamusCloudLastActivity', String(Date.now()));
    return id;
  }
  function update(patch, event, identity = active) {
    if (!identity) return;
    const saved = { ...identity };
    if (typeof chrome.runtime.sendMessage === 'function') {
      chrome.runtime.sendMessage({ action:'questionLogWrite', identity:saved, patch, event }, () => { void chrome.runtime.lastError; });
      return;
    }
    writes = writes.then(() => new Promise(resolve => chrome.storage.local.get(['questionSummaries', 'questionPreviews'], state => {
      if (chrome.runtime.lastError) return resolve();
      const rows = Array.isArray(state.questionSummaries) ? state.questionSummaries.slice() : [];
      const i = rows.findIndex(r => r.id === saved.id);
      const prior = i < 0 ? { ...saved, status: 'running', stages: [] } : rows[i];
      const row = { ...prior, ...patch, stages: event ? [...prior.stages, event].slice(-60) : prior.stages };
      if (i < 0) rows.push(row); else rows[i] = row;
      chrome.storage.local.set({ questionSummaries: rows.slice(-50) }, resolve);
    }))).catch(() => {});
    return writes;
  }
  async function preview(url, identity = active) {
    if (!identity || !/^data:image\/(png|jpeg|webp);base64,/.test(url || '')) return;
    const id = identity.id;
    try {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1400 / image.width);
      canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      let dataUrl;
      for (let q = .75; q > .1; q -= .1) { dataUrl = canvas.toDataURL('image/jpeg', q); if (dataUrl.length <= 200 * 1024) break; }
      if (dataUrl.length > 200 * 1024) return;
      if (typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({ action:'questionLogWrite', identity:{id}, preview:dataUrl }, () => { void chrome.runtime.lastError; });
        return;
      }
      writes = writes.then(() => new Promise(resolve => chrome.storage.local.get(['questionPreviews'], state => {
        const rows = Array.isArray(state.questionPreviews) ? state.questionPreviews : [];
        chrome.storage.local.set({ questionPreviews: [...rows.filter(p => p.id !== id), { id, dataUrl }].slice(-5) }, resolve);
      }))).catch(() => {});
    } catch (_) {}
  }
  global.KamusQuestionLogs = {
    begin(qNum, questionId) { const attemptId = crypto.randomUUID(); active = { id: `${sessionId()}:${questionId}:${attemptId}`, sessionId: sessionId(), questionId, attemptId, qNum, startedAt: new Date().toISOString() }; update({}); return { ...active }; },
    context(questionType, isMultiChoice, expectedCount) { return active ? { sessionId: active.sessionId, questionId: active.questionId, attemptId: active.attemptId, questionType, isMultiChoice, expectedCount: expectedCount || 0 } : undefined; },
    event(category, level, message, data) { update({}, { iso: new Date().toISOString(), category, level, message, data }); },
    answer(data) { update({ answer: data.answer || data.aiAnswer || '', choice: data.choice || data.aiChoice || '', model: data.aiModel, timings: data.timings || (Number.isFinite(data.aiDurationMs) ? { aiMs:data.aiDurationMs } : undefined) }); },
    preview,
    blob(blob) { const identity = active; const reader = new FileReader(); reader.onload = () => preview(reader.result, identity); reader.readAsDataURL(blob); },
    finish(result, duration, identity = active) { update({ status: result?.success ? 'success' : 'error', mode: result?.mode || 'Unknown', totalDurationMs: duration }, null, identity); if (active?.id === identity?.id) active = null; },
  };
})(typeof window !== 'undefined' ? window : self);
