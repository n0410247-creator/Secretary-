/* ==========================================================================
   VICTOR AI — real voice pipeline.

   Two genuine speech-recognition engines, selected by the "auto" preference:

   1. Browser Web Speech API (window.SpeechRecognition / webkitSpeechRecognition)
      • Free, on-device/cloud transcription by the browser.
      • Works in Chrome, Edge, Safari. Does NOT exist in an Android WebView,
        which is why the Capacitor APK must use engine 2.
      • Requires a secure context (https:// or localhost) and mic permission.

   2. Server-side transcription (MediaRecorder -> POST /api/voice/transcribe)
      • Works in any browser that supports MediaRecorder, including WebView.
      • Uses the configured Gemini transcription model on the server.

   Text-to-speech is likewise dual:
   • speechSynthesis (free, instant, always available in a real browser)
   • Gemini TTS via the server (real neural voice, works in WebView)

   Every failure path reports the actual reason. Nothing is simulated: the
   orb animation reflects real state changes only.
   ========================================================================== */
(function () {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const HAS_MEDIA_RECORDER = typeof window.MediaRecorder !== 'undefined';
  const HAS_SYNTH = typeof window.speechSynthesis !== 'undefined';

  const STATES = {
    idle:       { key: 'idle',       label: 'READY WHEN YOU ARE',  body: '' },
    requesting: { key: 'requesting', label: 'REQUESTING MICROPHONE', body: '' },
    listening:  { key: 'listening',  label: 'LISTENING',           body: 'listening' },
    processing: { key: 'processing', label: 'PROCESSING',          body: '' },
    thinking:   { key: 'thinking',   label: 'VICTOR IS THINKING',  body: '' },
    speaking:   { key: 'speaking',   label: 'VICTOR IS SPEAKING',  body: 'speaking' },
    muted:      { key: 'muted',      label: 'MICROPHONE MUTED',    body: '' },
    error:      { key: 'error',      label: 'ERROR',               body: '' }
  };

  const v = {
    state: 'idle',
    engine: null,             // 'browser' | 'server' — decided at runtime
    ttsEngine: null,          // 'browser' | 'gemini'
    muted: false,
    settings: null,
    listeners: [],
    recognition: null,
    recorder: null,
    mediaStream: null,
    chunks: [],
    currentUtterance: null,
    audioEl: null,
    lastTranscript: '',
    lastError: null,
    cancelled: false,
    sessionStart: 0
  };

  function emit(type, detail) {
    for (const fn of v.listeners.slice()) {
      try { fn({ type, state: v.state, detail }); } catch (e) { console.error('voice listener error', e); }
    }
  }

  function setState(name, detail) {
    const s = STATES[name] || STATES.idle;
    v.state = s.key;
    document.body.classList.remove('listening', 'speaking');
    if (s.body) document.body.classList.add(s.body);
    emit('state', Object.assign({ label: s.label }, detail || {}));
  }

  function fail(code, message, fix) {
    v.lastError = { code, message, fix: fix || null };
    setState('error');
    emit('error', v.lastError);
    return v.lastError;
  }

  /** What this browser can actually do — probed, never assumed. */
  function capabilities() {
    return {
      secureContext: window.isSecureContext === true,
      webSpeechApi: Boolean(SR),
      mediaRecorder: HAS_MEDIA_RECORDER,
      getUserMedia: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      speechSynthesis: HAS_SYNTH,
      // A WebView (the Android APK) has getUserMedia but no Web Speech API.
      isWebViewLike: Boolean(SR) === false && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      userAgent: navigator.userAgent
    };
  }

  /** Pick the recognition engine honestly, based on real probing. */
  function chooseSttEngine(pref) {
    const c = capabilities();
    if (pref === 'browser') {
      return SR ? { engine: 'browser', reason: 'Browser Web Speech API selected in Settings.' }
        : { engine: null, reason: 'Settings force the browser engine, but this browser does not expose the Web Speech API. Switch to "auto" or "server".' };
    }
    if (pref === 'server') {
      return c.mediaRecorder && c.getUserMedia
        ? { engine: 'server', reason: 'Server-side transcription selected in Settings.' }
        : { engine: null, reason: 'Server-side capture needs MediaRecorder and getUserMedia, which this browser does not provide.' };
    }
    // auto
    if (SR && c.secureContext) return { engine: 'browser', reason: 'Browser Web Speech API is available and the page is a secure context.' };
    if (SR && !c.secureContext) return { engine: c.mediaRecorder ? 'server' : null,
      reason: 'The Web Speech API exists but browsers disable it outside a secure context (https:// or localhost). Falling back to server-side capture.' };
    if (c.mediaRecorder && c.getUserMedia) return { engine: 'server',
      reason: 'No Web Speech API in this browser (typical of an Android WebView). Using server-side transcription.' };
    return { engine: null, reason: 'This browser supports neither the Web Speech API nor MediaRecorder, so speech input is not possible here.' };
  }

  function chooseTtsEngine(pref) {
    if (pref === 'browser') return HAS_SYNTH ? 'browser' : null;
    if (pref === 'gemini') return 'gemini';
    // auto: prefer the neural server voice when the backend is reachable and a
    // Gemini key is configured; otherwise use the free browser voice.
    const s = v.settings;
    if (s && s.secrets && s.secrets['gemini.apiKey'] && s.secrets['gemini.apiKey'].set && s.voice && s.voice.ttsEngine !== 'browser') {
      return 'gemini';
    }
    return HAS_SYNTH ? 'browser' : null;
  }

  // --- microphone permission ----------------------------------------------
  async function ensureMicPermission() {
    const c = capabilities();
    if (!c.getUserMedia) {
      throw Object.assign(new Error('This browser does not expose navigator.mediaDevices.getUserMedia, so the microphone cannot be requested.'),
        { code: 'no_getusermedia', fix: 'Use Chrome, Edge, Safari or Firefox on a desktop or Android device.' });
    }
    if (!c.secureContext) {
      throw Object.assign(new Error('The page is not a secure context, so the browser blocks microphone access.'),
        { code: 'insecure_context',
          fix: 'Open the app over https://, or use http://localhost. A plain http:// address on a LAN IP is blocked by every modern browser.' });
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      // Keep it only if we will record; otherwise release it immediately so the
      // browser indicator does not stay lit.
      if (v.engine !== 'server') stream.getTracks().forEach(t => t.stop());
      else v.mediaStream = stream;
      return stream;
    } catch (err) {
      const map = {
        NotAllowedError: ['permission_denied', 'Microphone permission was denied by you or by the browser/site settings.',
          'Chrome: tap the lock icon in the address bar → Site settings → Microphone → Allow. Android: Settings → Apps → Permissions → Microphone.'],
        PermissionDeniedError: ['permission_denied', 'Microphone permission was denied.',
          'Allow microphone access for this site, then retry.'],
        NotFoundError: ['no_device', 'No microphone device was found.',
          'Connect a microphone, or check that another app is not holding the only device.'],
        NotReadableError: ['device_busy', 'The microphone exists but could not be opened — another application is using it.',
          'Close other apps that use the microphone (calls, recorders, other browser tabs) and retry.'],
        OverconstrainedError: ['constraint_failed', 'The microphone could not satisfy the requested audio constraints.', 'Retry with default settings.'],
        SecurityError: ['security', 'The browser blocked microphone access for a security reason.', 'Serve the app over https://.']
      };
      const m = map[err.name] || ['mic_error', `Microphone error: ${err.name || err.message}`, null];
      throw Object.assign(new Error(m[1]), { code: m[0], fix: m[2], cause: err });
    }
  }

  // --- engine 1: browser Web Speech API -----------------------------------
  function startBrowserRecognition() {
    return new Promise((resolve, reject) => {
      let rec;
      try { rec = new SR(); }
      catch (e) { return reject(Object.assign(new Error(`Could not construct a SpeechRecognition instance: ${e.message}`), { code: 'sr_construct' })); }

      const s = v.settings && v.settings.voice || {};
      rec.lang = s.sttLanguage || 'en-NG';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;

      let finalText = '';
      let interimText = '';
      let settled = false;
      const done = (val) => { if (!settled) { settled = true; resolve(val); } };
      const bad = (err) => { if (!settled) { settled = true; reject(err); } };

      rec.onstart = () => { v.sessionStart = Date.now(); emit('started', { engine: 'browser', lang: rec.lang }); };
      rec.onaudiostart = () => emit('audio', { phase: 'audiostart' });
      rec.onspeechstart = () => emit('audio', { phase: 'speechstart' });
      rec.onresult = (e) => {
        interimText = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interimText += r[0].transcript;
        }
        const shown = (finalText + interimText).trim();
        emit('transcript', { text: shown, interim: interimText, final: finalText, confidence: e.results[e.results.length - 1][0].confidence });
      };
      rec.onerror = (e) => {
        const reasons = {
          'not-allowed': ['permission_denied', 'The browser blocked speech recognition. Microphone permission is required.',
            'Allow the microphone for this site, then tap the mic again.'],
          'service-not-allowed': ['service_denied', 'The browser refused the speech-recognition service (often a permission or policy block).',
            'Check site permissions. On managed devices a policy may disable the Web Speech API — use the server engine instead.'],
          'no-speech': ['no_speech', 'No speech was detected before the recognizer timed out.',
            'Speak closer to the microphone, and check the input level in your OS sound settings.'],
          'aborted': ['aborted', 'Recognition was cancelled.', null],
          'audio-capture': ['no_device', 'No microphone was available to the speech recognizer.',
            'Connect a microphone and make sure no other app is holding it.'],
          'network': ['network', 'The browser could not reach its speech-recognition service.',
            'Chrome sends audio to Google servers for recognition, so this needs internet access. Use the server engine if that is blocked.'],
          'language-not-supported': ['lang_unsupported', `The language "${rec.lang}" is not supported by this browser's recognizer.`,
            'Choose a different recognition language in Settings → Voice.']
        };
        const m = reasons[e.error] || ['sr_error', `Speech recognition error: ${e.error}`, null];
        bad(Object.assign(new Error(m[1]), { code: m[0], fix: m[2], raw: e.error }));
      };
      rec.onend = () => {
        const text = (finalText || interimText).trim();
        if (!text && !settled) {
          bad(Object.assign(new Error('The recognizer ended without capturing any speech.'),
            { code: 'empty_result', fix: 'Speak clearly and try again. If this repeats, switch the recognition engine in Settings.' }));
          return;
        }
        done({ text, engine: 'browser', lang: rec.lang, ms: Date.now() - v.sessionStart });
      };

      v.recognition = rec;
      try { rec.start(); }
      catch (e) {
        // InvalidStateError means a session is already running.
        if (e.name === 'InvalidStateError') return bad(Object.assign(new Error('Speech recognition is already running.'), { code: 'already_running' }));
        bad(Object.assign(new Error(`Could not start recognition: ${e.message}`), { code: 'sr_start' }));
      }
    });
  }

  // --- engine 2: record + server transcription ----------------------------
  function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/ogg'];
    for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    return '';
  }

  function startServerCapture() {
    return new Promise((resolve, reject) => {
      if (!v.mediaStream || v.mediaStream.getAudioTracks().every(t => t.readyState === 'ended')) {
        return reject(Object.assign(new Error('The microphone stream was released before recording could start.'),
          { code: 'stream_lost', fix: 'Tap the microphone again to re-request access.' }));
      }
      const mime = pickMime();
      let rec;
      try { rec = new MediaRecorder(v.mediaStream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); }
      catch (e) { return reject(Object.assign(new Error(`MediaRecorder could not start: ${e.message}`), { code: 'recorder_init' })); }

      v.chunks = [];
      let settled = false;
      const done = val => { if (!settled) { settled = true; resolve(val); } };
      const bad = err => { if (!settled) { settled = true; reject(err); } };

      rec.ondataavailable = e => { if (e.data && e.data.size) v.chunks.push(e.data); };
      rec.onerror = e => bad(Object.assign(new Error(`Recorder error: ${(e.error && e.error.name) || 'unknown'}`), { code: 'recorder_error' }));
      rec.onstart = () => { v.sessionStart = Date.now(); emit('started', { engine: 'server', mime: rec.mimeType || mime }); };
      rec.onstop = async () => {
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(v.chunks, { type });
        if (v.mediaStream) { v.mediaStream.getTracks().forEach(t => t.stop()); v.mediaStream = null; }
        if (!blob.size) {
          return bad(Object.assign(new Error('The recorder produced no audio data.'),
            { code: 'empty_recording', fix: 'Speak while the microphone is active, then stop.' }));
        }
        if (v.cancelled) return bad(Object.assign(new Error('Recording cancelled.'), { code: 'cancelled' }));

        emit('transcript', { text: '', interim: '', final: '', note: 'Uploading audio for transcription…' });
        setState('processing', { note: 'Sending audio to the server' });
        try {
          const b64 = await blobToBase64(blob);
          const r = await window.VictorAPI.transcribeBase64(b64, type);
          if (!r.ok || !r.text) {
            return bad(Object.assign(new Error((r.error && r.error.message) || 'The server returned no transcript.'),
              { code: (r.error && r.error.code) || 'no_transcript', fix: r.note || null }));
          }
          emit('transcript', { text: r.text, interim: '', final: r.text });
          done({ text: r.text, engine: 'server', model: r.model, mime: type, bytes: blob.size, ms: Date.now() - v.sessionStart });
        } catch (err) {
          bad(Object.assign(new Error(err.message), { code: err.code || 'transcribe_failed', fix: err.fix }));
        }
      };

      v.recorder = rec;
      try { rec.start(250); }
      catch (e) { bad(Object.assign(new Error(`MediaRecorder.start failed: ${e.message}`), { code: 'recorder_start' })); }
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('Could not read the recorded audio.'));
      fr.readAsDataURL(blob);
    });
  }

  // --- text to speech ------------------------------------------------------
  function browserVoices() {
    if (!HAS_SYNTH) return [];
    return window.speechSynthesis.getVoices() || [];
  }

  function pickBrowserVoice(style) {
    const voices = browserVoices();
    if (!voices.length) return null;
    if (!style || style === 'default') {
      return voices.find(x => x.default) || voices.find(x => /^en[-_]/i.test(x.lang)) || voices[0];
    }
    const female = /female|woman|zira|samantha|victoria|karen|moira|tessa|fiona|serena|susan|allison|ava|zoe/i;
    const male = /male|man|david|mark|daniel|alex|fred|george|oliver|tom|arthur|lee/i;
    const re = style === 'female' ? female : male;
    return voices.find(x => re.test(x.name)) || voices.find(x => /^en[-_]/i.test(x.lang)) || voices[0];
  }

  /**
   * Speak text. Returns {ok, engine, voice} or throws with the real reason.
   */
  async function speak(text, opts = {}) {
    if (!text || !String(text).trim()) return { ok: false, skipped: true };
    if (v.muted && !opts.force) {
      emit('speaking', { skipped: true, reason: 'Speech output is muted.' });
      return { ok: false, muted: true };
    }
    const s = (v.settings && v.settings.voice) || {};
    const rate = opts.rate != null ? opts.rate : Number(s.rate || 1);
    const engine = opts.engine || v.ttsEngine || chooseTtsEngine(s.ttsEngine);

    stopSpeaking();
    setState('speaking', { text });
    emit('speakstart', { engine, text });

    if (engine === 'gemini') {
      try {
        const r = await window.VictorAPI.speakBase64(text, opts.voice || s.ttsVoice);
        if (!r.ok || !r.audioBase64) {
          const msg = (r.error && r.error.message) || 'The server returned no audio.';
          // Fall back to the free browser voice rather than staying silent.
          if (HAS_SYNTH) {
            emit('warn', { message: `Neural voice failed (${msg}). Using the browser voice instead.` });
            return speakBrowser(text, rate, s.browserVoiceStyle);
          }
          throw Object.assign(new Error(msg), { code: (r.error && r.error.code) || 'tts_failed' });
        }
        await playBase64Audio(r.audioBase64, r.mimeType || 'audio/wav');
        return { ok: true, engine: 'gemini', voice: r.voice, model: r.model };
      } catch (err) {
        if (HAS_SYNTH) {
          emit('warn', { message: `Neural voice failed: ${err.message}. Using the browser voice instead.` });
          return speakBrowser(text, rate, s.browserVoiceStyle);
        }
        throw Object.assign(new Error(`Speech output failed: ${err.message}`), { code: err.code || 'tts_failed', fix: err.fix });
      }
    }

    if (HAS_SYNTH) return speakBrowser(text, rate, s.browserVoiceStyle);
    throw Object.assign(new Error('This browser has no speechSynthesis and no server voice is configured.'),
      { code: 'no_tts', fix: 'Add a Gemini API key in Settings to enable the server voice.' });
  }

  function speakBrowser(text, rate, style) {
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = Math.max(0.5, Math.min(2, Number(rate) || 1));
      u.pitch = 1;
      const voice = pickBrowserVoice(style);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      else u.lang = (v.settings && v.settings.voice && v.settings.voice.sttLanguage) || 'en-US';

      u.onstart = () => emit('speaking', { engine: 'browser', voice: voice ? voice.name : 'device default' });
      u.onend = () => { setState('idle'); emit('speakend', { engine: 'browser' }); resolve({ ok: true, engine: 'browser', voice: voice ? voice.name : null }); };
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') { setState('idle'); return resolve({ ok: false, interrupted: true }); }
        setState('error');
        reject(Object.assign(new Error(`Browser speech output failed: ${e.error}`),
          { code: 'synth_error',
            fix: 'Some browsers only speak after a user gesture, and some Android builds ship no TTS voice at all. Install a system TTS engine, or add a Gemini key to use the server voice.' }));
      };
      v.currentUtterance = u;
      try { window.speechSynthesis.speak(u); }
      catch (e) { reject(Object.assign(new Error(`Could not start speech: ${e.message}`), { code: 'synth_start' })); }
    });
  }

  function playBase64Audio(b64, mime) {
    return new Promise((resolve, reject) => {
      try {
        if (!v.audioEl) {
          v.audioEl = new Audio();
          v.audioEl.preload = 'auto';
        }
        const el = v.audioEl;
        el.src = `data:${mime};base64,${b64}`;
        const cleanup = () => { el.removeEventListener('ended', onEnd); el.removeEventListener('error', onErr); };
        const onEnd = () => { cleanup(); setState('idle'); emit('speakend', { engine: 'gemini' }); resolve(); };
        const onErr = () => {
          cleanup();
          reject(Object.assign(new Error('The browser could not decode the audio returned by the server.'),
            { code: 'audio_decode', fix: `The server sent ${mime}. Try a different TTS model in Settings.` }));
        };
        el.addEventListener('ended', onEnd);
        el.addEventListener('error', onErr);
        const p = el.play();
        if (p && p.catch) p.catch(err => {
          cleanup();
          reject(Object.assign(new Error(`Audio playback was blocked: ${err.message}`),
            { code: 'autoplay_blocked', fix: 'Browsers require a user gesture before audio can play. Tap the microphone once, then audio will work.' }));
        });
      } catch (e) { reject(Object.assign(new Error(e.message), { code: 'audio_setup' })); }
    });
  }

  function stopSpeaking() {
    try { if (HAS_SYNTH) window.speechSynthesis.cancel(); } catch {}
    try { if (v.audioEl) { v.audioEl.pause(); v.audioEl.currentTime = 0; } } catch {}
    v.currentUtterance = null;
  }

  // --- public control surface ---------------------------------------------
  /**
   * Run one full turn: listen -> transcribe -> ask the AI -> speak the reply.
   * Resolves with the real result or throws with the real error.
   */
  async function listenAndReply(opts = {}) {
    v.cancelled = false;
    const s = (v.settings && v.settings.voice) || {};
    const choice = chooseSttEngine(s.sttEngine);
    v.engine = choice.engine;
    emit('engine', { stt: choice.engine, sttReason: choice.reason, tts: v.ttsEngine });

    if (!choice.engine) {
      return { ok: false, stage: 'engine', error: fail('no_engine', choice.reason,
        'Use Chrome, Edge or Safari over https:// for the free browser engine, or add a Gemini API key in Settings and choose the server engine (this is what the Android APK uses).') };
    }

    setState('requesting');
    try { await ensureMicPermission(); }
    catch (e) { return { ok: false, stage: 'permission', error: fail(e.code, e.message, e.fix) }; }

    setState('listening', { engine: v.engine });
    emit('listenstart', { engine: v.engine });

    let heard;
    try {
      heard = v.engine === 'browser' ? await startBrowserRecognition() : await startServerCapture();
    } catch (e) {
      releaseMic();
      return { ok: false, stage: 'recognition', error: fail(e.code, e.message, e.fix) };
    }
    releaseMic();

    if (v.cancelled) { setState('idle'); return { ok: false, stage: 'cancelled', cancelled: true }; }
    if (!heard.text || !heard.text.trim()) {
      return { ok: false, stage: 'recognition', error: fail('empty_result', 'Nothing was recognised from that recording.',
        'Speak a little louder and closer to the microphone, then try again.') };
    }
    v.lastTranscript = heard.text.trim();
    emit('heard', { text: v.lastTranscript, engine: heard.engine, model: heard.model || null });

    if (opts.transcribeOnly) { setState('idle'); return { ok: true, text: v.lastTranscript, capture: heard }; }

    // Ask the AI through the backend, which routes to the configured provider.
    setState('thinking', { text: v.lastTranscript });
    emit('thinking', { text: v.lastTranscript });
    let reply;
    try {
      reply = await window.VictorAPI.chat(v.lastTranscript, opts.sessionId || 'voice');
    } catch (e) {
      setState('error');
      return { ok: false, stage: 'ai', transcript: v.lastTranscript,
        error: fail(e.code || 'ai_failed', e.message, e.fix || 'Open Settings → AI providers, add a key and run the connection test to see the exact provider error.') };
    }
    emit('reply', { text: reply.text, provider: reply.provider, model: reply.model, latencyMs: reply.latencyMs, usedFallback: reply.usedFallback });

    if (s.autoSpeakReplies !== false) {
      try { await speak(reply.text); }
      catch (e) { emit('warn', { message: `The reply is valid but speech output failed: ${e.message}` }); }
    } else {
      setState('idle');
    }
    return { ok: true, transcript: v.lastTranscript, reply, capture: heard };
  }

  function stop() {
    v.cancelled = false;
    try { if (v.recognition) v.recognition.stop(); } catch {}
    try { if (v.recorder && v.recorder.state !== 'inactive') v.recorder.stop(); } catch {}
    releaseMic();
  }

  function cancel() {
    v.cancelled = true;
    try { if (v.recognition) { v.recognition.onresult = null; v.recognition.abort(); } } catch {}
    try { if (v.recorder && v.recorder.state !== 'inactive') { v.recorder.ondataavailable = null; v.recorder.stop(); } } catch {}
    v.chunks = [];
    releaseMic();
    stopSpeaking();
    setState('idle');
    emit('cancelled', {});
  }

  function releaseMic() {
    try { if (v.mediaStream) { v.mediaStream.getTracks().forEach(t => t.stop()); } } catch {}
    v.mediaStream = null;
  }

  function setMuted(m) {
    v.muted = Boolean(m);
    if (v.muted) { stop(); stopSpeaking(); setState('muted'); }
    else setState('idle');
    emit('mute', { muted: v.muted });
    return v.muted;
  }

  function on(fn) { v.listeners.push(fn); return () => { v.listeners = v.listeners.filter(f => f !== fn); }; }

  /** Refresh voices once the browser has loaded them (they arrive async). */
  function primeVoices() {
    if (!HAS_SYNTH) return;
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => emit('voices', { count: browserVoices().length });
    } catch {}
  }

  window.VictorVoice = {
    STATES, capabilities, chooseSttEngine, chooseTtsEngine,
    listenAndReply, speak, stop, cancel, setMuted, on, setState,
    primeVoices, browserVoices, pickBrowserVoice,
    get state() { return v.state; },
    get engine() { return v.engine; },
    get muted() { return v.muted; },
    get settings() { return v.settings; },
    set settings(s) { v.settings = s; v.ttsEngine = chooseTtsEngine((s && s.voice && s.voice.ttsEngine) || 'auto'); },
    get lastTranscript() { return v.lastTranscript; },
    get lastError() { return v.lastError; },
    _internals: v
  };

  primeVoices();
})();
