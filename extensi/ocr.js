/**
 * KamusMiniOcr - Integrasi PaddleOCR-VL-1.6 (Baidu AI Studio Async Job API)
 * Digunakan oleh content.js (halaman kuis) dan options.js (tes koneksi token).
 * Seluruh request jaringan melewati background.js proxyFetch agar bebas CORS & CSP.
 */
(function (global) {
  if (global.KamusMiniOcr) return;

  const DEFAULT_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
  const DEFAULT_MODEL = "PaddleOCR-VL-1.6";
  const DEFAULT_OPTIONAL_PAYLOAD = {
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: false
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function proxyFetchMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome?.runtime?.id) {
          reject(new Error("Extension context invalidated. Silakan refresh halaman."));
          return;
        }
        chrome.runtime.sendMessage({ action: "proxyFetch", ...payload }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "Gagal menghubungi background service worker"));
            return;
          }
          if (!resp || !resp.success) {
            reject(new Error(resp?.error || "Gagal memproses proxyFetch OCR"));
            return;
          }
          resolve(resp);
        });
      } catch (err) {
        reject(new Error(err?.message || "Gagal mengirim pesan ke background worker"));
      }
    });
  }

  function parseProxyJson(resp, contextLabel) {
    const raw = String(resp?.data || "").trim();
    if (!raw) {
      throw new Error(`${contextLabel} HTTP ${resp?.status ?? "?"} ${resp?.statusText || ""} (respons kosong)`.trim());
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`${contextLabel} HTTP ${resp?.status ?? "?"} non-JSON response: ${raw.slice(0, 220)}`);
    }
  }

  function extractApiError(json, status, statusText, rawText) {
    if (json && typeof json === "object") {
      return json.errorMsg || json.msg || json.message || json.detail || json.error?.message || `HTTP ${status} ${statusText || ""}`.trim();
    }
    return `HTTP ${status} ${statusText || ""}: ${String(rawText || "").slice(0, 180)}`.trim();
  }

  function resolveMappedImageUrl(rawSrc, imageMap) {
    if (!rawSrc) return "";
    const trimmed = String(rawSrc).trim();
    if (imageMap && typeof imageMap === "object") {
      if (imageMap[trimmed]) return imageMap[trimmed];
      const noDot = trimmed.replace(/^\.\//, "");
      if (imageMap[noDot]) return imageMap[noDot];
      const decoded = (() => {
        try { return decodeURIComponent(trimmed); } catch (e) { return trimmed; }
      })();
      if (imageMap[decoded]) return imageMap[decoded];
      const baseName = trimmed.split("/").pop().split("?")[0];
      for (const [k, v] of Object.entries(imageMap)) {
        const keyBase = String(k).split("/").pop().split("?")[0];
        if (k === trimmed || k === noDot || keyBase === baseName) {
          return v;
        }
      }
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    return "";
  }

  /**
   * Mem-parse file .jsonl hasil job PaddleOCR menjadi teks Markdown+LaTeX bersih
   * dan daftar potongan gambar non-teks (diagram/bangunan/foto).
   */
  function buildMarkdownAndImages(jsonlText) {
    const lines = String(jsonlText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return { rawMarkdown: "", cleanMarkdown: "", imageEntries: [] };
    }

    const rawSections = [];
    const cleanSections = [];
    const urlToEntry = new Map();
    const imageEntries = [];

    const registerImage = (keyHint, resolvedUrl) => {
      if (!resolvedUrl) return null;
      if (urlToEntry.has(resolvedUrl)) {
        return urlToEntry.get(resolvedUrl);
      }
      const entry = {
        index: imageEntries.length + 1,
        key: keyHint || resolvedUrl,
        url: resolvedUrl,
        marker: `[Gambar Diagram #${imageEntries.length + 1}]`
      };
      urlToEntry.set(resolvedUrl, entry);
      imageEntries.push(entry);
      return entry;
    };

    for (const line of lines) {
      let lineJson;
      try {
        lineJson = JSON.parse(line);
      } catch (e) {
        continue;
      }

      const resultObj = lineJson.result || lineJson;
      const layouts = Array.isArray(resultObj?.layoutParsingResults) ? resultObj.layoutParsingResults : [];

      for (const res of layouts) {
        const mdText = res?.markdown?.text ? String(res.markdown.text) : "";
        const imageMap = (res?.markdown?.images && typeof res.markdown.images === "object")
          ? res.markdown.images
          : {};

        if (mdText) rawSections.push(mdText);

        let cleaned = mdText;

        // 1. Ganti <div ...><img src="..."></div> (format umum layout PaddleOCR)
        cleaned = cleaned.replace(
          /<div\b[^>]*>\s*<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/div>/gi,
          (match, src) => {
            const url = resolveMappedImageUrl(src, imageMap);
            const entry = registerImage(src, url);
            return entry ? `\n${entry.marker}\n` : "\n[Gambar]\n";
          }
        );

        // 2. Ganti tag <img src="..."> berdiri sendiri
        cleaned = cleaned.replace(
          /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
          (match, src) => {
            const url = resolveMappedImageUrl(src, imageMap);
            const entry = registerImage(src, url);
            return entry ? `\n${entry.marker}\n` : "\n[Gambar]\n";
          }
        );

        // 3. Ganti sintaks gambar Markdown ![alt](src)
        cleaned = cleaned.replace(
          /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
          (match, _alt, src) => {
            const url = resolveMappedImageUrl(src, imageMap);
            const entry = registerImage(src, url);
            return entry ? `\n${entry.marker}\n` : "\n[Gambar]\n";
          }
        );

        // 4. Tangkap sisa entry di markdown.images yang tidak direferensikan di teks
        const extraMarkers = [];
        for (const [imgKey, imgUrl] of Object.entries(imageMap)) {
          if (imgUrl && !urlToEntry.has(imgUrl)) {
            const entry = registerImage(imgKey, imgUrl);
            if (entry) extraMarkers.push(entry.marker);
          }
        }
        if (extraMarkers.length > 0) {
          cleaned = `${cleaned}\n${extraMarkers.join("\n")}`;
        }

        if (cleaned.trim()) {
          cleanSections.push(cleaned.replace(/\n{3,}/g, "\n\n").trim());
        }
      }
    }

    return {
      rawMarkdown: rawSections.join("\n\n").trim(),
      cleanMarkdown: cleanSections.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(),
      imageEntries
    };
  }

  async function fetchImageAsDataUrl(imageUrl) {
    const resp = await proxyFetchMessage({
      url: imageUrl,
      options: { method: "GET" },
      responseType: "dataUrl"
    });
    if (!resp.ok || !resp.dataUrl || !resp.base64) {
      throw new Error(`Gagal mengunduh potongan gambar OCR (HTTP ${resp.status || "?"})`);
    }
    return {
      dataUrl: resp.dataUrl,
      base64: resp.base64,
      mimeType: resp.mimeType || "image/jpeg",
      sizeBytes: resp.sizeBytes || 0
    };
  }

  async function runPaddleOcr({
    imageBase64,
    filename = "question.png",
    token,
    model = DEFAULT_MODEL,
    jobUrl = DEFAULT_JOB_URL,
    optionalPayload = DEFAULT_OPTIONAL_PAYLOAD,
    pollIntervalMs = 1500,
    timeoutMs = 45000,
    maxDiagramImages = 4,
    onProgress = null,
    shouldAbort = null
  }) {
    const cleanToken = String(token || "").trim();
    if (!cleanToken) {
      throw new Error("Access Token PaddleOCR belum diisi.");
    }
    if (!imageBase64) {
      throw new Error("Data gambar PNG kosong untuk dikirim ke PaddleOCR.");
    }

    const t0 = Date.now();
    const targetUrl = String(jobUrl || DEFAULT_JOB_URL).replace(/\/+$/, "");
    const targetModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

    const checkAbort = () => {
      if (typeof shouldAbort === "function" && shouldAbort()) {
        const err = new Error("Proses PaddleOCR dibatalkan oleh pengguna.");
        err.aborted = true;
        throw err;
      }
    };

    checkAbort();
    if (onProgress) onProgress({ stage: "submitting", model: targetModel });

    // 1. Submit Job Multipart ke PaddleOCR v2
    const submitResp = await proxyFetchMessage({
      url: targetUrl,
      options: {
        method: "POST",
        headers: {
          Authorization: `bearer ${cleanToken}`
        }
      },
      multipart: {
        fields: {
          model: targetModel,
          optionalPayload: JSON.stringify(optionalPayload || DEFAULT_OPTIONAL_PAYLOAD)
        },
        files: [
          {
            field: "file",
            filename,
            mimeType: "image/png",
            base64: imageBase64
          }
        ]
      }
    });

    const submitJson = parseProxyJson(submitResp, "PaddleOCR Submit");
    if (!submitResp.ok || !submitJson?.data?.jobId) {
      throw new Error(`PaddleOCR Submit gagal: ${extractApiError(submitJson, submitResp.status, submitResp.statusText, submitResp.data)}`);
    }

    const jobId = submitJson.data.jobId;
    if (onProgress) onProgress({ stage: "submitted", jobId });

    // 2. Polling Status Job sampai selesai / timeout
    let jsonlUrl = "";
    let pollCount = 0;
    const deadline = t0 + timeoutMs;

    while (true) {
      checkAbort();
      if (Date.now() > deadline) {
        throw new Error(`PaddleOCR timeout setelah ${Math.round(timeoutMs / 1000)} detik (jobId=${jobId}).`);
      }

      pollCount++;
      const pollResp = await proxyFetchMessage({
        url: `${targetUrl}/${encodeURIComponent(jobId)}`,
        options: {
          method: "GET",
          headers: {
            Authorization: `bearer ${cleanToken}`
          }
        }
      });

      const pollJson = parseProxyJson(pollResp, "PaddleOCR Poll");
      if (!pollResp.ok || !pollJson?.data) {
        throw new Error(`PaddleOCR Poll gagal: ${extractApiError(pollJson, pollResp.status, pollResp.statusText, pollResp.data)}`);
      }

      const state = pollJson.data.state;
      const progressInfo = pollJson.data.extractProgress || {};
      if (onProgress) {
        onProgress({
          stage: "polling",
          jobId,
          pollCount,
          state,
          extractedPages: progressInfo.extractedPages ?? null,
          totalPages: progressInfo.totalPages ?? null
        });
      }

      if (state === "done") {
        jsonlUrl = pollJson.data?.resultUrl?.jsonUrl || "";
        if (!jsonlUrl) {
          throw new Error("PaddleOCR selesai tanpa URL hasil JSONL (resultUrl.jsonUrl kosong).");
        }
        break;
      }

      if (state === "failed") {
        throw new Error(`PaddleOCR gagal memproses gambar: ${pollJson.data.errorMsg || "Unknown failure"}`);
      }

      await sleep(pollIntervalMs);
    }

    checkAbort();
    if (onProgress) onProgress({ stage: "fetching_result", jobId });

    // 3. Unduh & parse hasil JSONL (tanpa Authorization header karena signed URL BOS)
    const jsonlResp = await proxyFetchMessage({
      url: jsonlUrl,
      options: { method: "GET" }
    });
    if (!jsonlResp.ok) {
      throw new Error(`Gagal mengunduh hasil JSONL PaddleOCR (HTTP ${jsonlResp.status})`);
    }

    const parsed = buildMarkdownAndImages(jsonlResp.data);
    if (!parsed.cleanMarkdown && parsed.imageEntries.length === 0) {
      throw new Error("PaddleOCR tidak menghasilkan teks Markdown maupun potongan gambar.");
    }

    // 4. Jika ada gambar diagram/bangunan terdeteksi, unduh potongan gambarnya sebagai Base64
    const diagramImages = [];
    const limitedEntries = parsed.imageEntries.slice(0, Math.max(0, maxDiagramImages));
    for (const entry of limitedEntries) {
      checkAbort();
      try {
        const downloaded = await fetchImageAsDataUrl(entry.url);
        diagramImages.push({
          index: entry.index,
          marker: entry.marker,
          url: entry.url,
          mimeType: downloaded.mimeType,
          base64: downloaded.base64,
          dataUrl: downloaded.dataUrl,
          sizeBytes: downloaded.sizeBytes
        });
      } catch (dlErr) {
        // Lanjutkan jika masih ada potongan gambar lain, cek total di akhir loop
        console.warn(`[PaddleOCR] Gagal mengunduh ${entry.marker}:`, dlErr.message);
      }
    }

    if (parsed.imageEntries.length > 0 && diagramImages.length === 0) {
      throw new Error("PaddleOCR mendeteksi gambar diagram, tetapi gagal mengunduh potongan gambarnya.");
    }

    const totalDiagramKB = Number(
      (diagramImages.reduce((acc, item) => acc + (item.sizeBytes || 0), 0) / 1024).toFixed(1)
    );

    return {
      jobId,
      model: targetModel,
      durationMs: Date.now() - t0,
      rawMarkdown: parsed.rawMarkdown,
      cleanMarkdown: parsed.cleanMarkdown,
      imageEntries: parsed.imageEntries,
      diagramImages,
      stats: {
        markdownLen: parsed.cleanMarkdown.length,
        diagramDetectedCount: parsed.imageEntries.length,
        diagramDownloadedCount: diagramImages.length,
        totalDiagramKB,
        pollCount
      }
    };
  }

  /**
   * Membuat gambar PNG sintetis sederhana lalu mengujinya ke PaddleOCR-VL-1.6
   * untuk memverifikasi keabsahan Access Token di halaman Pengaturan.
   */
  async function testPaddleOcrConnection({ token, model = DEFAULT_MODEL, jobUrl = DEFAULT_JOB_URL, onProgress = null }) {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111827";
    ctx.font = "24px Arial, sans-serif";
    ctx.fillText("Tes OCR: 15 + 25 = 40", 36, 72);
    ctx.font = "18px Arial, sans-serif";
    ctx.fillText("a. 35    b. 40", 36, 114);
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1] || "";

    return await runPaddleOcr({
      imageBase64: base64,
      filename: "test_token_ocr.png",
      token,
      model,
      jobUrl,
      pollIntervalMs: 1200,
      timeoutMs: 30000,
      onProgress
    });
  }

  async function recognizeImageBlob(blob, token, model = DEFAULT_MODEL, options = {}) {
    if (!blob) throw new Error("Blob gambar kosong.");
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = reader.result || "";
        const b64 = typeof res === "string" ? (res.split(",")[1] || "") : "";
        resolve(b64);
      };
      reader.onerror = () => reject(reader.error || new Error("Gagal membaca Blob gambar"));
      reader.readAsDataURL(blob);
    });
    return await runPaddleOcr({
      imageBase64: base64,
      filename: "blob_image.png",
      token,
      model,
      ...options
    });
  }

  global.KamusMiniOcr = {
    DEFAULT_JOB_URL,
    DEFAULT_MODEL,
    DEFAULT_OPTIONAL_PAYLOAD,
    buildMarkdownAndImages,
    fetchImageAsDataUrl,
    runPaddleOcr,
    recognizeImageBlob,
    testPaddleOcrConnection
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

