// ======================================================
// KAMUS MINI CLOUD CLIENT (v3) — single source of truth
// Semua fetch ke mylms.melvino.online lewat sini:
// otomatis header X-AI-Client-Version: 3 + modelId + parser limit.
// ======================================================
(function (global) {
  'use strict';

  const CLOUD_URL = 'https://mylms.melvino.online';
  const CLIENT_VERSION = '3';

  // Normalisasi error limit dari response 429/503 menjadi objek terstruktur.
  // Return null kalau bukan error limit.
  function parseLimitError(res, body) {
    const isCancelled = body?.reasonCode === 'REQUEST_CANCELLED';
    const isAccessRestricted = [401, 403].includes(res.status) || ['PROFILE_REQUIRED', 'IDENTITY_REVIEW_PENDING'].includes(body?.reasonCode) || String(body?.reasonCode || '').startsWith('ACCOUNT_');
    const isUnavailable = res.status === 503 || body?.aiUnavailable === true ||
      ['PROVIDER_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'AI_DISABLED'].includes(body?.reasonCode);
    if (res.status !== 429 && !isUnavailable && !isAccessRestricted && !isCancelled) return null;
    const reasonCode = (body && body.reasonCode) ||
      (isAccessRestricted ? 'ACCOUNT_ACCESS_RESTRICTED' : res.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_UNAVAILABLE');
    let retryAfterSeconds = Number(body && body.retryAfterSeconds);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      const h = Number(res.headers && res.headers.get('Retry-After'));
      retryAfterSeconds = Number.isFinite(h) && h > 0 ? h : (isUnavailable ? null : 10);
    }
    return {
      isLimit: !isAccessRestricted && !isCancelled,
      isCancelled,
      isAccessRestricted,
      profilePath: body?.profilePath || null,
      isUnavailable,
      reasonCode,
      retryAfterSeconds,
      message: (body && (body.message || body.jawaban || body.answer || body.error)) ||
        (isCancelled ? 'Permintaan AI dibatalkan. Ulangi soal ini secara manual.' : isAccessRestricted ? 'Akses Cloud dibatasi. Periksa identitas akun atau hubungi admin sekolah.' : isUnavailable ? 'Layanan AI sedang tidak tersedia. Silakan coba lagi nanti.' : 'Batas AI tercapai.'),
      httpStatus: res.status
    };
  }

  // Wrapper safeFetch-style: kirim header v3, return { res, body, limit }.
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
    let res;
    try { res = await impl(CLOUD_URL + path, init); }
    catch (cause) {
      const error = new Error('Layanan AI Cloud tidak dapat dihubungi. Silakan coba lagi nanti.');
      error.aiUnavailable = true;
      error.cause = cause;
      throw error;
    }
    finally {
      if (method === 'POST' && ['/api/search', '/api/v1/agent/search-answer', '/api/v1/agent/search-answer-image'].includes(path)) {
        try { global.chrome?.runtime?.sendMessage({ action: 'quotaUsageInvalidate' }, () => { void global.chrome?.runtime?.lastError; }); } catch (_) {}
      }
    }
    let body = null;
    try { body = await res.json(); } catch (_) { /* body non-JSON */ }
    const limit = parseLimitError(res, body);
    return { res, body, limit };
  }

  // A similarity threshold applies only to bank matches, never to an AI confidence guess.
  function isAcceptableAnswer(res, body, threshold = 0.75) {
    if (!res?.ok || !body || body.success === false || body.aiUnavailable || body.aiQuotaExceeded || (!body.answer && !body.choice)) return false;
    if (body.answerOrigin === 'AI' || body.source === 'AI_FALLBACK') return true;
    const similarity = Number(body.similarityScore ?? body.matchScore);
    return Number.isFinite(similarity) && similarity >= threshold;
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

  // Reads account status and catalog configuration without a model call.
  async function diagnose(apiKey, fetchImpl) {
    const profile = await request('/api/v1/me/academic-profile', { apiKey, fetchImpl });
    if (!profile.res.ok || !profile.body?.data) return { status: profile.res.status, limit: profile.limit, profile: null };
    const account = profile.body.data;
    const catalog = await request('/api/v1/ai-models/available', { apiKey, fetchImpl });
    return { status: profile.res.status, profile: account, catalog: catalog.res.ok ? catalog.body?.data : null, catalogStatus: catalog.res.status };
  }

  global.KamusMiniCloud = {
    CLOUD_URL, CLIENT_VERSION,
    parseLimitError, request, isAcceptableAnswer, diagnose,
    getAvailableModels, saveModelPreference, getMyAiUsage,
    searchAnswer, searchAnswerImage
  };
})(typeof window !== 'undefined' ? window : self);
