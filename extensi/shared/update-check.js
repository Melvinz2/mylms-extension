/**
 * Kamus Mini — update checker (shared).
 * Pure global IIFE; no modules/bundler (repo rule). Load order:
 *   background: importScripts("shared/update-check.js") at the very top.
 *   popup: <script src="shared/update-check.js"></script> before popup.js.
 *
 * Checks the MyLMS protected endpoint for a newer release and surfaces it in
 * the popup (banner) and as a toolbar badge. The endpoint requires auth; the
 * extension sends its API key (x-api-key) so only configured members see it.
 */
(() => {
  const VERSION = (() => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version
      }
    } catch { /* environment without chrome (tests/harness) */ }
    return '0.0.0'
  })()
  const STORE_KEY = 'kamusMini_updateNotified'

  const cmp = (a, b) => {
    const pa = String(a).split('.').map(Number)
    const pb = String(b).split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0)
      if (d) return d
    }
    return 0
  }

  function settings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['backendUrl', 'apiKey'], (v) => resolve({
        serverUrl: v.backendUrl || '',
        apiKey: v.apiKey || '',
      }))
    })
  }

  async function check(serverUrl, apiKey) {
    if (!serverUrl) return null
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/v1/extension/latest`, {
      headers: { 'x-api-key': apiKey, 'X-AI-Client-Version': VERSION },
    })
    if (!res.ok) return null
    const meta = await res.json()
    if (!meta || !meta.version) return null
    if (cmp(meta.version, VERSION) <= 0) return null
    return { ...meta, installed: VERSION }
  }

  function renderPopupBanner(update) {
    const body = document.body
    if (!body || document.querySelector('[data-kamus-update-banner]')) return
    const banner = document.createElement('div')
    banner.dataset.kamusUpdateBanner = '1'
    const style = ['position:sticky', 'top:0', 'z-index:9999', 'display:flex', 'align-items:center', 'gap:8px',
      'padding:8px 10px', 'margin:-4px -4px 8px', 'font:500 12px/1.4 system-ui, sans-serif',
      'color:#fff', 'background:#b45309', 'border-radius:8px'].join(';')
    banner.setAttribute('style', style)
    const text = document.createElement('span')
    text.style.flex = '1'
    text.textContent = `Versi ${update.version} tersedia (Anda: ${update.installed})`
    const link = document.createElement('a')
    link.href = `${String(update.serverUrl || '').replace(/\/+$/, '')}/ekstensi`
    link.target = '_blank'
    link.textContent = 'Unduh'
    link.setAttribute('style', 'color:#fff;font-weight:700;text-decoration:underline')
    const close = document.createElement('button')
    close.type = 'button'
    close.setAttribute('aria-label', 'Tutup pemberitahuan')
    close.textContent = '×'
    close.setAttribute('style', 'border:0;background:transparent;color:#fff;font-size:16px;cursor:pointer;line-height:1')
    close.addEventListener('click', () => banner.remove())
    banner.append(text, link, close)
    body.prepend(banner)
  }

  const notifyInPage = (update) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => renderPopupBanner(update), { once: true })
    } else {
      renderPopupBanner(update)
    }
  }

  async function run() {
    const { serverUrl, apiKey } = await settings()
    const update = await check(serverUrl, apiKey).catch(() => null)
    if (!update) {
      if (chrome.action?.setBadgeText) chrome.action.setBadgeText({ text: '' })
      return
    }
    if (chrome.action?.setBadgeText) chrome.action.setBadgeText({ text: '!' })
    const notified = localStorage.getItem(STORE_KEY)
    if (notified !== update.version) {
      localStorage.setItem(STORE_KEY, update.version)
      notifyInPage(update)
    }
  }

  // Popup: every open.
  if (typeof document !== 'undefined' && document.getElementById('statusBadge')) {
    document.addEventListener('DOMContentLoaded', () => { run().catch(() => {}) })
  }

  // Background service worker: every launch + daily alarm.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => { run().catch(() => {}) })
    if (chrome.alarms) {
      chrome.alarms.create('kamusMiniUpdateCheck', { periodInMinutes: 24 * 60 })
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'kamusMiniUpdateCheck') run().catch(() => {})
      })
    }
  }

  self.KamusMiniUpdate = { VERSION, check, cmp, run }
})()
