# Kamus Mini (MyLMS Extension)

Ekstensi peramban (Google Chrome / Chromium-based - Manifest V3) yang dirancang untuk membantu dan mengotomatisasi pengerjaan soal/kuis daring pada platform Learning Management System (LMS), khususnya berbasis **Moodle**, CBT, dan e-learning.

Ekstensi ini disamarkan dengan nama **"Kamus Mini"** (*stealth mode*) agar tidak mencolok saat terpasang di peramban, serta dilengkapi dengan modul bypass proteksi ujian, perenderan rumus matematika lokal (KaTeX), halaman pengaturan mandiri (`options.html`), dan **Direct AI Engine** (Google Gemini, Groq, OpenAI).

---

## 🌟 Fitur Utama

1. **Direct AI Engine & Cloud LLM (Tanpa Butuh Server Lokal)**
   - Mendukung **Google Gemini API** (rekomendasi: `gemini-1.5-flash` dan `gemini-2.0-flash`).
   - Mendukung **Groq Cloud** (`llama-3.3-70b-versatile`) dan **OpenAI** (`gpt-4o-mini`).
   - Mendukung **Custom OpenAI-Compatible Provider** (DeepSeek `api.deepseek.com`, OpenRouter `openrouter.ai`, Ollama lokal `localhost:11434`, LM Studio, vLLM, dll.).
   - Mampu memecahkan soal teks maupun soal bergambar/rumus matematika secara langsung (*multimodal vision*) tanpa server OCR perantara.
   - Pilihan alternatif: tetap mendukung server bank soal lokal (`localhost:3000`).

2. **Halaman Pengaturan Mandiri (`options.html`)**
   - Halaman dashboard konfigurasi lengkap di tab browser (`chrome-extension://.../options.html`).
   - Memisahkan pengaturan rumit dari popup, sehingga popup kontroler tetap bersih, minimalis, dan ringan.
   - Dilengkapi fitur **"⚡ Tes Koneksi AI"** untuk memverifikasi API Key secara langsung.

3. **Stealth Protection Bypass (`bypass.js`)**
   - Mengaktifkan kembali klik kanan (`contextmenu`) dan seleksi teks (`user-select: text !important`).
   - Mencegat pemblokiran shortcut keyboard (Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+X).
   - Menetralkan event listener pengunci halaman (`preventDefault`, `stopPropagation`).
   - Mencegat popup peringatan kecurangan (`alert` & `confirm`).
   - Whitelist otomatis untuk domain populer (Google, WhatsApp, GitHub, dll.).

4. **AI Agent Auto-Solver (`content.js`)**
   - **DOM Scraping Moodle:** Mengambil teks soal (`.qtext`), nomor soal, dan opsi jawaban (`.answer > div`).
   - **Pencocokan Jawaban Fleksibel:** Memilih opsi berdasarkan huruf (`A/B/C/D/E`) atau kecocokan teks fuzzy *Dice's Coefficient*.
   - **Simulasi Klik & Navigasi Manusia:** Memilih radio button dengan efek penanda visual, jeda acak (*jitter delay*) yang manusiawi, lalu berpindah ke halaman berikutnya.
   - **Auto-Submit Guard:** Otomatis berhenti ketika mendeteksi halaman akhir (*Finish attempt*) demi mencegah pengiriman kuis tanpa persetujuan manual.
   - **Deteksi Cloudflare Turnstile/Captcha:** Berhenti sementara (*paused-by-captcha*) dan otomatis melanjutkan pengerjaan (*auto-resume*) setelah pengguna menyelesaikan captcha.

---

## 📁 Struktur Direktori

```plaintext
Mylms Extension/
├── .gitignore                # Perlindungan berkas rahasia (.env, logs)
├── extensi/                  # Folder ekstensi Chrome (Unpacked)
│   ├── manifest.json         # Konfigurasi Manifest V3
│   ├── background.js         # Service worker background & screenshot handler
│   ├── bypass.js             # Skrip bypass anti-cheat (MAIN world)
│   ├── content.js            # Skrip injeksi AI solver (Direct AI & Local Backend)
│   ├── options.html          # Dashboard pengaturan lengkap di tab browser
│   ├── options.js            # Logika penyimpanan & uji koneksi AI
│   ├── popup.html            # Minimalist HUD controller (Start/Stop/Status/Logs)
│   ├── popup.js              # Logika UI popup & pembuka options page
│   └── lib/                  # Library KaTeX offline (CSS, JS, Fonts)
├── .env                      # Contoh API key backend (diabaikan git)
├── example.md                # Catatan teknis alur solver & selector Moodle
├── openapi.json              # Spesifikasi OpenAPI 3.0 untuk Backend AI Agent API
├── README.md                 # Dokumentasi umum proyek
└── context.md                # Dokumentasi arsitektur & konteks sistem untuk AI/Developer
```

---

## 🚀 Panduan Instalasi & Penggunaan

### 1. Memasang Ekstensi di Chrome / Edge / Brave

1. Buka peramban Chromium Anda dan masuk ke halaman ekstensi:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`
2. Aktifkan **Developer mode** di pojok kanan atas.
3. Klik tombol **Load unpacked** (Muat yang belum dibongkar).
4. Pilih folder `extensi/` di dalam direktori proyek ini.
5. Ekstensi **Kamus Mini** siap digunakan.

### 2. Konfigurasi AI di Halaman Pengaturan

1. Klik ikon ekstensi **Kamus Mini** di toolbar browser.
2. Klik tombol roda gigi (⚙️ **Pengaturan**) di pojok kanan atas popup.
3. Halaman pengaturan (`options.html`) akan terbuka di tab baru:
   - Pilih mesin: **🤖 Direct AI (Rekomendasi)**.
   - Pilih Provider: **Google Gemini API**.
   - Masukkan **API Key** Google Gemini Anda.
   - Klik **⚡ Tes Koneksi AI** untuk memastikan koneksi aktif (indikator hijau).
   - Klik **💾 Simpan Pengaturan**.

### 3. Menjalankan AI Agent

1. Buka halaman kuis Moodle aktif Anda.
2. Klik ikon ekstensi untuk membuka popup minimalis.
3. Klik tombol **🚀 Start**.
4. Agen otomatis memecahkan soal, memilih jawaban yang tepat, dan menavigasi ke halaman berikutnya.
5. Untuk menghentikan agen sewaktu-waktu, klik tombol **🛑 Stop**.
