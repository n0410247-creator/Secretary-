/* ==========================================================================
   VICTOR AI — API client.

   All traffic goes to the same origin (relative URLs), so the Android APK
   needs no CORS configuration and no key is ever present in this file.
   Credentials are sent to the server to be stored; they are never read back.
   ========================================================================== */
(function () {
  'use strict';

  const state = {
    authorized: false,
    authRequired: false,
    pinConfigured: false,
    settings: null,
    health: null
  };

  /* Where the backend lives.

     In a browser this is the same origin, so the value is empty and every
     request stays relative. Inside the Android APK the page is served by the
     Capacitor WebView from https://localhost, where there is no backend at
     all, so the user must point the app at the real server. That address is
     stored on the device; it is never a credential, and no key ever travels
     through it in plaintext form in this file. */
  const SERVER_KEY = 'victor.serverUrl';

  function isNative() {
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
        return !!window.Capacitor.isNativePlatform();
      }
    } catch {}
    return /; wv\)|VictorAndroid/i.test(navigator.userAgent || '');
  }

  function serverUrl() {
    let v = '';
    try { v = (localStorage.getItem(SERVER_KEY) || '').trim(); } catch {}
    return v.replace(/\/+$/, '');
  }

  function setServerUrl(v) {
    const clean = String(v || '').trim().replace(/\/+$/, '');
    try {
      if (clean) localStorage.setItem(SERVER_KEY, clean);
      else localStorage.removeItem(SERVER_KEY);
    } catch {}
    return clean;
  }

  /** Resolve an API path against the configured backend. */
  function url(path) {
    const b = serverUrl();
    if (!b) return path;
    return b + (path.startsWith('/') ? path : '/' + path);
  }

  function fetchOpts(extra) {
    // A cross-origin backend needs cookies to be sent explicitly; same-origin
    // keeps the stricter default.
    return Object.assign({ credentials: serverUrl() ? 'include' : 'same-origin' }, extra || {});
  }

  function json(res) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text().then(t => { try { return JSON.parse(t); } catch { return { raw: t }; } });
  }

  async function request(method, path, body, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    let payload;
    if (body instanceof FormData) {
      payload = body;                       // browser sets the multipart boundary
    } else if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const pin = sessionStorage.getItem('victor.pin');
    if (pin) headers['X-Victor-Pin'] = pin;

    const res = await fetch(url(path), fetchOpts({ method, headers, body: payload }));
    const data = await json(res);

    if (res.status === 401) {
      state.authorized = false;
      const err = new Error(data && data.error ? data.error : 'Not authorized.');
      err.status = 401; err.fix = data && data.fix;
      throw err;
    }
    if (!res.ok) {
      const detail = data && data.detail;
      const message = data && (data.error?.message || data.error || (typeof detail === 'object' ? (detail.message || detail.error) : detail));
      const err = new Error(message || `Request failed with HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      err.fix = data && (data.error?.fix || data.fix || (detail && detail.fix));
      throw err;
    }
    return data;
  }

  const API = {
    state,

    // --- session -----------------------------------------------------------
    async authStatus() {
      // Send the stored PIN as well as the cookie: a WebView or a browser with
      // cookies blocked would otherwise report "not authorized" after login.
      const hdrs = {};
      const pin = sessionStorage.getItem('victor.pin');
      if (pin) hdrs.headers = { 'X-Victor-Pin': pin };
      const r = await fetch(url('/api/auth/status'), fetchOpts(hdrs)).then(json);
      state.authRequired = Boolean(r.authRequired);
      state.pinConfigured = Boolean(r.pinConfigured);
      state.authorized = Boolean(r.authorized);
      return r;
    },
    async login(pin) {
      const r = await request('POST', '/api/auth/login', { pin });
      if (r.ok) { sessionStorage.setItem('victor.pin', pin); state.authorized = true; }
      return r;
    },
    logout() { sessionStorage.removeItem('victor.pin'); state.authorized = false; },

    // --- server facts ------------------------------------------------------
    health: () => request('GET', '/api/health'),
    diagnostics: () => request('GET', '/api/diagnostics'),

    // --- settings ----------------------------------------------------------
    async getSettings() {
      state.settings = await request('GET', '/api/settings');
      return state.settings;
    },
    saveSettings: patch => request('PUT', '/api/settings', patch),
    resetSettings: () => request('POST', '/api/settings/reset'),
    putSecret: (key, value) => request('PUT', `/api/secrets/${encodeURIComponent(key)}`, { value }),
    deleteSecret: key => request('DELETE', `/api/secrets/${encodeURIComponent(key)}`),

    // --- connection tests --------------------------------------------------
    test: target => request('POST', `/api/test/${encodeURIComponent(target)}`),
    connectionTests: () => request('GET', '/api/connection-tests'),
    enableCalling: body => request('POST', '/api/whatsapp/calling/enable', body || {}),
    callingEligibility: () => request('GET', '/api/whatsapp/calling/eligibility'),

    // --- AI ----------------------------------------------------------------
    chat: (message, sessionId) => request('POST', '/api/chat', { message, sessionId }),
    summarize: (text, kind) => request('POST', '/api/summarize', { text, kind }),

    // --- voice -------------------------------------------------------------
    /** Send real recorded audio for server-side transcription. */
    transcribeBase64: (audioBase64, mimeType) =>
      request('POST', '/api/voice/transcribe', { audioBase64, mimeType }),
    /** Get real TTS audio back as base64 (works inside an Android WebView). */
    speakBase64: (text, voice) =>
      request('POST', '/api/voice/speak', { text, voice, format: 'base64' }),
    /** One round trip: text -> AI reply -> spoken audio. */
    ask: (text, sessionId) => request('POST', '/api/voice/ask', { text, sessionId }),
    storeClip: (audioBase64, mimeType) =>
      request('POST', '/api/voice/store', { audioBase64, mimeType }),

    // --- records -----------------------------------------------------------
    messages: params => request('GET', '/api/messages' + qs(params)),
    contacts: params => request('GET', '/api/contacts' + qs(params)),
    calls: params => request('GET', '/api/calls' + qs(params)),
    call: id => request('GET', `/api/calls/${encodeURIComponent(id)}`),
    endCall: waCallId => request('POST', `/api/calls/${encodeURIComponent(waCallId)}/end`),
    recordings: params => request('GET', '/api/recordings' + qs(params)),
    transcribeRecording: id => request('POST', `/api/recordings/${id}/transcribe`),
    summarizeRecording: id => request('POST', `/api/recordings/${id}/summarize`),
    deleteRecording: id => request('DELETE', `/api/recordings/${id}`),
    purgeExpired: () => request('POST', '/api/recordings/purge-expired'),
    activity: params => request('GET', '/api/activity' + qs(params)),
    stats: () => request('GET', '/api/reports/stats'),
    reportDay: day => request('GET', `/api/reports/day/${encodeURIComponent(day)}`),
    generateReport: day => request('POST', `/api/reports/day/${encodeURIComponent(day)}/generate`),
    reportList: () => request('GET', '/api/reports/list'),

    audioUrl: id => url(`/api/recordings/${id}/audio`),

    // --- backend location (used by the Android app) -------------------------
    isNative,
    serverUrl,
    setServerUrl,
    resolve: url,
    /** Real reachability probe against the configured backend. */
    async probeServer() {
      const started = Date.now();
      try {
        const res = await fetch(url('/api/health'), fetchOpts({ method: 'GET' }));
        const data = await json(res);
        return { ok: res.ok && data && data.ok !== false, status: res.status, ms: Date.now() - started, data };
      } catch (e) {
        return { ok: false, status: 0, ms: Date.now() - started, error: e.message };
      }
    }
  };

  function qs(params) {
    if (!params) return '';
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
    const s = u.toString();
    return s ? '?' + s : '';
  }

  window.VictorAPI = API;
})();
