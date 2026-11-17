// One service-worker writer serializes updates from every tab and frame.
var KamusQuestionLogStore = (() => {
  let chain = Promise.resolve();
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : value;
  function write(request) {
    chain = chain.then(() => new Promise(resolve => {
      chrome.storage.local.get(['questionSummaries','questionPreviews'], state => {
        if (chrome.runtime.lastError) return resolve();
        const identity = request.identity;
        if (!identity || typeof identity.id !== 'string' || identity.id.length > 1000) return resolve();
        let patch;
        if (request.preview) {
          const url = request.preview;
          if (typeof url !== 'string' || url.length > 200*1024 || !/^data:image\/(png|jpeg|webp);base64,/.test(url)) return resolve();
          patch = { questionPreviews: [...(state.questionPreviews || []).filter(p => p.id !== identity.id),{id:identity.id,dataUrl:url}].slice(-5) };
        } else {
          const rows = Array.isArray(state.questionSummaries) ? state.questionSummaries : [];
          const index = rows.findIndex(r => r.id === identity.id);
          const prior = index < 0 ? { ...identity, status:'running', stages:[] } : rows[index];
          const changes = { ...request.patch };
          changes.answer = text(changes.answer, 12000); changes.choice = text(changes.choice, 1000);
          Object.keys(changes).forEach(k => { if (changes[k] === undefined) delete changes[k]; });
          let event = request.event;
          if (event) { event = { ...event, message:text(event.message,2000) }; if (event.data && JSON.stringify(event.data).length > 2000) event.data = { truncated:true, preview:JSON.stringify(event.data).slice(0,1900) }; }
          const row = { ...prior, ...changes, stages:event ? [...prior.stages,event].slice(-40) : prior.stages };
          // Bound even four-byte Unicode, leaving room for legacy logs and previews.
          while (JSON.stringify(row).length > 22000 && row.stages.length) row.stages.shift();
          if (index < 0) rows.push(row); else rows[index] = row;
          patch = { questionSummaries: rows.slice(-50) };
        }
        chrome.storage.local.set(patch, resolve);
      });
    })).catch(() => {});
    return chain;
  }
  return { write };
})();
