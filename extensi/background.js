importScripts('shared/update-check.js')

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cariJawaban",
    title: "Cari Kunci Jawaban",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "cariJawaban") {
    const selectedText = info.selectionText;
    
    // Kirim pesan ke content.js di tab yang sedang aktif untuk mencari jawaban
    chrome.tabs.sendMessage(tab.id, {
      action: "searchAnswer",
      query: selectedText
    });
  }
});

const PADDLE_OCR_DNR_RULE_ID = 9001;
let _dnrReadyPromise = null;

function ensurePaddleOcrDnrRule() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    return Promise.resolve();
  }
  if (!_dnrReadyPromise) {
    _dnrReadyPromise = chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PADDLE_OCR_DNR_RULE_ID],
      addRules: [
        {
          id: PADDLE_OCR_DNR_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "remove" }
            ]
          },
          condition: {
            urlFilter: "||paddleocr.aistudio-app.com/",
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    }).catch((err) => {
      _dnrReadyPromise = null;
      console.warn("[KamusMini] DNR setup warning:", err);
    });
  }
  return _dnrReadyPromise;
}

ensurePaddleOcrDnrRule();

function detectImageMimeType(bytes, url, headerMime) {
  if (headerMime && headerMime.startsWith("image/")) {
    return headerMime;
  }
  if (bytes && bytes.length >= 12) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return "image/webp";
  }
  const cleanUrl = String(url || "").split("?")[0].toLowerCase();
  if (cleanUrl.endsWith(".jpg") || cleanUrl.endsWith(".jpeg")) return "image/jpeg";
  if (cleanUrl.endsWith(".png")) return "image/png";
  if (cleanUrl.endsWith(".webp")) return "image/webp";
  if (cleanUrl.endsWith(".gif")) return "image/gif";
  return headerMime || "image/jpeg";
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(""));
}

function buildProxyFetchInit(request) {
  const opts = request.options ? { ...request.options } : {};
  if (!request.multipart) {
    return opts;
  }

  const formData = new FormData();
  const fields = request.multipart.fields || {};
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined && val !== null) {
      formData.append(key, String(val));
    }
  }

  const files = Array.isArray(request.multipart.files) ? request.multipart.files : [];
  for (const f of files) {
    const bytes = base64ToUint8Array(f.base64 || "");
    const blob = new Blob([bytes], { type: f.mimeType || "application/octet-stream" });
    formData.append(f.field || "file", blob, f.filename || "upload.bin");
  }

  // Biarkan fetch mengatur boundary Content-Type multipart secara otomatis
  const headers = opts.headers ? { ...opts.headers } : {};
  delete headers["Content-Type"];
  delete headers["content-type"];

  return {
    ...opts,
    method: opts.method || "POST",
    headers,
    body: formData
  };
}

// Listener untuk aksi-aksi khusus dari Content Script (seperti Tangkapan Layar & Proxy Fetch)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "captureVisibleTab") {
    const targetWindowId = (sender && sender.tab && typeof sender.tab.windowId === 'number')
      ? sender.tab.windowId
      : null;
    chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          success: false,
          windowId: targetWindowId,
          error: chrome.runtime.lastError.message
        });
      } else if (!dataUrl) {
        sendResponse({
          success: false,
          windowId: targetWindowId,
          error: "captureVisibleTab mengembalikan dataUrl kosong"
        });
      } else {
        sendResponse({
          success: true,
          windowId: targetWindowId,
          tabId: sender?.tab?.id ?? null,
          dataUrl: dataUrl
        });
      }
    });
    return true; // Menandakan bahwa sendResponse akan dipanggil secara asinkron
  }

  // Proxy Fetch untuk membypass batasan CSP / CORS / Mixed Content halaman website (termasuk multipart & binary)
  if (request.action === "proxyFetch") {
    const t0 = Date.now();
    let fetchInit;
    try {
      fetchInit = buildProxyFetchInit(request);
    } catch (buildErr) {
      sendResponse({
        success: false,
        durationMs: Date.now() - t0,
        error: `MultipartBuildError: ${buildErr.message}`
      });
      return true;
    }

    const preflight = (typeof request.url === "string" && request.url.includes("paddleocr.aistudio-app.com"))
      ? ensurePaddleOcrDnrRule()
      : Promise.resolve();

    preflight
      .then(() => fetch(request.url, fetchInit))
      .then(async (res) => {
        if (request.responseType === "dataUrl" || request.responseType === "base64") {
          const buf = await res.arrayBuffer();
          const rawMime = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
          const detectedMime = detectImageMimeType(new Uint8Array(buf), request.url, rawMime);
          const b64 = arrayBufferToBase64(buf);
          sendResponse({
            success: true,
            ok: res.ok,
            status: res.status,
            statusText: res.statusText || "",
            durationMs: Date.now() - t0,
            mimeType: detectedMime,
            sizeBytes: buf.byteLength,
            base64: b64,
            dataUrl: `data:${detectedMime};base64,${b64}`
          });
          return;
        }

        const text = await res.text();
        sendResponse({
          success: true,
          ok: res.ok,
          status: res.status,
          statusText: res.statusText || "",
          durationMs: Date.now() - t0,
          data: text
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          durationMs: Date.now() - t0,
          error: `${err.name || 'FetchError'}: ${err.message}`
        });
      });
    return true;
  }
});

