// ======================================================
// KAMUS MINI CLOUD CLIENT (v2) — single source of truth
// Semua fetch ke mylms.melvino.online lewat sini:
// otomatis header X-AI-Client-Version: 2 + modelId + parser limit.
// ======================================================
(function (global) {
  'use strict';

  const CLOUD_URL = 'https://mylms.melvino.online';
  const CLIENT_VERSION = '2';

  // Normalisasi error limit dari response 429/503 menjadi objek terstruktur.
  // Return null kalau bukan error limit.
  function parseLimitError(res, body) {
    if (res.status !== 429 && res.status !== 503) return null;
    const reasonCode = (body && body.reasonCode) ||
      (res.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_UNAVAILABLE');
    let retryAfterSeconds = Number(body && body.retryAfterSeconds);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      const h = Number(res.headers && res.headers.get('Retry-After'));
      retryAfterSeconds = Number.isFinite(h) ? h : (res.status === 429 ? 10 : 30);
    }
    return {
      isLimit: true,
      reasonCode,
      retryAfterSeconds,
      message: (body && (body.answer || body.message)) || 'Batas AI tercapai.',
      httpStatus: res.status
    };
  }

  // Wrapper safeFetch-style: kirim header v2, return { res, body, limit }.
  // `fetchImpl` disuntik agar bisa jalan di content script (safeFetch),
  // popup/options (fetch biasa), maupun unit test (fetch palsu).
  async function request(path, { method = 'GET', apiKey, fetchImpl, json, formData } = {}) {
    if (!apiKey) throw new Error('API Key Kamus Mini Cloud belum diatur di Pengaturan.');
    const impl = fetchImpl || (typeof global.safeFetch === 'function' ? global.safeFetch : global.fetch);
    const headers = {
      'x-api-key': apiKey,
      'X-AI-Client-Version': CLIENT_VERSION
    };
    const init = { method, headers };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (formData !== undefined) {
      init.body = formData; // FormData set Content-Type sendiri (boundary)
    }
    const res = await impl(CLOUD_URL + path, init);
    let body = null;
    try { body = await res.json(); } catch (_) { /* body non-JSON */ }
    const limit = parseLimitError(res, body);
    return { res, body, limit };
  }

  // ---- API level tinggi ----

  async function getAvailableModels(apiKey, fetchImpl) {
    const { body } = await request('/api/v1/ai-models/available', { apiKey, fetchImpl });
    if (!body || !body.success) throw new Error('Gagal mengambil katalog model.');
    return body.data; // { models: [...], selectedModelId }
  }

  async function saveModelPreference(apiKey, modelId, fetchImpl) {
    const { res, body, limit } = await request('/api/v1/ai-models/preference', {
      method: 'PUT', apiKey, fetchImpl, json: { modelId }
    });
    if (limit) throw limit;
    if (!res.ok || !body || !body.success) {
      throw new Error((body && body.message) || 'Model tidak bisa disimpan.');
    }
    return body.data; // { modelId, displayName }
  }

  async function getMyAiUsage(apiKey, fetchImpl) {
    const { body } = await request('/api/v1/agent/my-ai-usage', { apiKey, fetchImpl });
    if (!body || !body.success) throw new Error('Gagal mengambil kuota AI.');
    return body.data;
  }

  // Lookup teks (agent attempt/fallback & quick search).
  // modelId boleh null -> server pakai preferensi akun.
  async function searchAnswer(apiKey, { questionText, options = null, query, modelId, context, sourceOptions }, fetchImpl) {
    const payload = query !== undefined
      ? { query, ...(modelId ? { modelId } : {}) }
      : { questionText, options, context: context ? { ...context, attemptId: context.attemptId + (options ? ':text-options' : ':text-fast') } : undefined, sourceOptions, ...(modelId ? { modelId } : {}) };
    const path = query !== undefined ? '/api/search' : '/api/v1/agent/search-answer';
    return request(path, { method: 'POST', apiKey, fetchImpl, json: payload });
  }

  // Lookup gambar (multipart). `modelId` opsional sebagai form field.
  async function searchAnswerImage(apiKey, { imageBlob, filename, modelId, imageProcessingMode = 'ocr_first', questionText = '', options = [], questionType = 'choice', isMultiChoice = false, expectedCount = 0, context }, fetchImpl) {
    const fd = new FormData();
    fd.append('image', imageBlob, filename || 'question.png');
    fd.append('imageProcessingMode', imageProcessingMode);
    fd.append('questionText', questionText);
    if (context) fd.append('context', JSON.stringify({ ...context, attemptId: context.attemptId + ':image' }));
    fd.append('options', JSON.stringify(options));
    fd.append('questionType', questionType);
    fd.append('isMultiChoice', String(Boolean(isMultiChoice)));
    fd.append('expectedCount', String(expectedCount || 0));
    if (modelId) fd.append('modelId', modelId);
    return request('/api/v1/agent/search-answer-image', {
      method: 'POST', apiKey, fetchImpl, formData: fd
    });
  }

  global.KamusMiniCloud = {
    CLOUD_URL, CLIENT_VERSION,
    parseLimitError, request,
    getAvailableModels, saveModelPreference, getMyAiUsage,
    searchAnswer, searchAnswerImage
  };
})(typeof window !== 'undefined' ? window : self);
