/* ==========================================================================
   VICTOR AI — Settings screen controller.

   Every control on this screen performs a real operation: it writes to the
   server, or it calls the remote service and shows the actual response.
   A saved key is never reported as a successful connection — only a passed
   test is.
   ========================================================================== */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const API = window.VictorAPI;

  let S = null;              // current settings object from the server
  let pending = {};          // unsaved preference changes

  // --- helpers -------------------------------------------------------------
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setSwitch(el, on) { if (el) el.setAttribute('aria-checked', String(Boolean(on))); }
  function getSwitch(el) { return el ? el.getAttribute('aria-checked') === 'true' : false; }

  function dot(id, kind) { const el = $(id); if (!el) return; el.className = 'dot' + (kind ? ' ' + kind : ''); }

  function renderResult(container, r) {
    const el = typeof container === 'string' ? $(container) : container;
    if (!el) return;
    const pass = Boolean(r && r.ok);
    const cls = r && r.running ? 'run' : pass ? 'pass' : 'fail';
    const title = r && r.running ? 'Testing…' : pass ? 'PASSED — verified against the live service' : 'FAILED';
    const meta = [];
    if (r && r.latencyMs != null) meta.push(`${r.latencyMs} ms`);
    if (r && r.model) meta.push(`model ${r.model}`);
    if (r && r.statusCode) meta.push(`HTTP ${r.statusCode}`);
    if (r && r.provider) meta.push(`provider ${r.provider}`);
    if (r && r.bytes) meta.push(`${r.bytes} bytes of audio`);
    el.innerHTML =
      `<div class="testresult ${cls}">
         <div class="testhead">${r && r.running ? '<span class="spin sm"></span>' : (pass ? '✓' : '✕')} <span>${esc(title)}</span></div>
         ${meta.length ? `<div class="testmeta">${esc(meta.join(' · '))}</div>` : ''}
         <div class="testdetail">${esc(r && (r.detail || (r.error && (r.error.message || r.error)) || r.message) || '')}</div>
         ${r && r.error && r.error.hint ? `<div class="testdetail" style="color:#f2d79a;margin-top:6px">↳ ${esc(r.error.hint)}</div>` : ''}
         ${r && r.fix ? `<div class="testdetail" style="color:#f2d79a;margin-top:6px">↳ ${esc(r.fix)}</div>` : ''}
         ${r && Array.isArray(r.attempts) && r.attempts.length > 1 ? `<div class="testdetail" style="margin-top:6px">${r.attempts.map(a => `${esc(a.label || a.provider)}: ${a.ok ? 'ok' : esc(a.error && a.error.message || 'failed')}`).join('<br>')}</div>` : ''}
       </div>`;
  }

  function banner(container, kind, title, msg, fix) {
    const el = typeof container === 'string' ? $(container) : container;
    if (!el) return;
    el.innerHTML = `<div class="banner ${kind}"><strong>${esc(title)}</strong><p>${esc(msg)}</p>${fix ? `<p class="fix">${esc(fix)}</p>` : ''}</div>`;
  }
  function clearBanner(container) { const el = $(container); if (el) el.innerHTML = ''; }

  async function savePatch(patch, label) {
    try {
      const r = await API.saveSettings(patch);
      S = r.settings || await API.getSettings();
      if (r.rejected && r.rejected.length) {
        banner('#settingsBanner', 'warn', 'Some values were rejected',
          r.rejected.map(x => `${x.path}: ${x.reason}`).join('; '),
          `${r.applied.length} value(s) were saved.`);
      } else {
        $('#saveStatus').textContent = `${label || 'Preferences'} saved at ${new Date().toLocaleTimeString()}.`;
        clearBanner('#settingsBanner');
      }
      window.VictorApp && window.VictorApp.onSettingsChanged(S);
      return true;
    } catch (e) {
      banner('#settingsBanner', 'error', 'Could not save', e.message, e.fix);
      return false;
    }
  }

  // --- load ----------------------------------------------------------------
  async function load() {
    try {
      S = await API.getSettings();
    } catch (e) {
      banner('#settingsBanner', 'error', 'Could not read settings from the server', e.message, e.fix);
      return;
    }
    populateCatalogs();
    fillForm();
    renderServerPanel();
    renderCallEligibility();
    renderVoiceCaps();
    updateWebhookPanel();
    window.VictorApp && window.VictorApp.onSettingsChanged(S);
  }

  function populateCatalogs() {
    const c = (S && S.catalog) || {};
    const fill = (sel, items, valFn, labelFn, current) => {
      const el = $(sel); if (!el) return;
      el.innerHTML = items.map(i => `<option value="${esc(valFn(i))}">${esc(labelFn(i))}</option>`).join('');
      if (current != null && current !== '') el.value = current;
    };
    fill('#inGeminiModel', c.geminiModels || [], i => i.id, i => `${i.id} — ${i.label}`, S.providers.gemini.model);
    fill('#inSttModel', c.geminiSttModels || [], i => i, i => i, S.voice.sttModel);
    fill('#inTtsModel', c.geminiTtsModels || [], i => i, i => i, S.voice.ttsModel);
    fill('#inTtsVoice', c.geminiVoices || [], i => i, i => i, S.voice.ttsVoice);
    // GonkaRouter model is free text so a newly released model can be used.
  }

  function fillForm() {
    const sec = S.secrets || {};
    const cred = (dotSel, valSel, key, label) => {
      const st = sec[key] || {};
      dot(dotSel, st.set ? (st.decryptable === false ? 'bad' : 'on') : '');
      $(valSel).textContent = st.set ? `${st.masked} · ${st.fingerprint}` : 'not stored';
      if (st.set && st.decryptable === false) $(valSel).textContent += ' — UNREADABLE: the vault key changed';
    };
    cred('#dotGemini', '#valGemini', 'gemini.apiKey');
    cred('#dotGonka', '#valGonka', 'gonka.apiKey');
    cred('#dotHf', '#valHf', 'huggingface.token');
    cred('#dotWa', '#valWa', 'whatsapp.accessToken');

    $('#inPrimary').value = S.providers.primary;
    $('#inFallback').value = S.providers.fallback || '';
    setSwitch($('#swFallback'), S.providers.fallbackEnabled);
    $('#inGonkaBase').value = S.providers.gonka.baseUrl;
    $('#inGonkaFormat').value = S.providers.gonka.apiFormat;
    $('#inGonkaModel').value = S.providers.gonka.model;
    $('#inHfModel').value = S.providers.huggingface.model || '';
    setSwitch($('#swHf'), S.providers.huggingface.enabled);
    $('#inTemp').value = S.providers.gemini.temperature;
    $('#inMaxTok').value = S.providers.gemini.maxOutputTokens;
    $('#inPersona').value = S.persona.systemPrompt;
    $('#inBossName').value = S.persona.bossName;

    $('#inSttEngine').value = S.voice.sttEngine;
    $('#inSttLang').value = S.voice.sttLanguage;
    $('#inTtsEngine').value = S.voice.ttsEngine;
    $('#inBrowserVoice').value = S.voice.browserVoiceStyle;
    $('#inTtsStyle').value = S.voice.ttsStyle;
    $('#rate').value = S.voice.rate;
    $('#rateValue').textContent = Number(S.voice.rate).toFixed(1) + '×';
    setSwitch($('#swAutoSpeak'), S.voice.autoSpeakReplies);

    $('#inWaPhoneId').value = S.whatsapp.phoneNumberId;
    $('#inWaWabaId').value = S.whatsapp.wabaId;
    $('#inWaVersion').value = S.whatsapp.graphVersion;
    $('#reply').value = S.whatsapp.autoReplyText;
    setSwitch($('#swAutoReply'), S.whatsapp.autoReplyEnabled);
    setSwitch($('#swAway'), S.whatsapp.awayModeEnabled);
    $('#inAwayMode').value = S.whatsapp.awayModeSchedule.mode;
    $('#inAwayStart').value = S.whatsapp.awayModeSchedule.start;
    $('#inAwayEnd').value = S.whatsapp.awayModeSchedule.end;
    $('#inThrottle').value = S.whatsapp.autoReplyOncePerContactHours;
    setSwitch($('#swVoiceNotes'), S.whatsapp.handleVoiceNotes);
    setSwitch($('#swTranscribe'), S.whatsapp.transcribeVoiceNotes);
    setSwitch($('#swSummarize'), S.whatsapp.summarizeVoiceNotes);
    setSwitch($('#swFlag'), S.whatsapp.flagImportant);
    setSwitch($('#swNotify'), S.whatsapp.notifyOwner);
    $('#inOwnerWa').value = S.whatsapp.ownerWaId;
    $('#inRetries').value = S.whatsapp.maxRetries;

    setSwitch($('#swCalling'), S.whatsapp.callingEnabled);
    $('#inCallMode').value = S.whatsapp.callingAnswerMode;
    $('#inCallGreeting').value = S.whatsapp.callingGreeting;
    $('#inCallMax').value = S.whatsapp.callingMaxSeconds;
    $('#inCallTurns').value = S.whatsapp.callingMaxTurns;
    setSwitch($('#swCallRecord'), S.whatsapp.callingRecordAudio);
    setSwitch($('#swConsent'), S.privacy.playConsentDisclosure);
    $('#inConsent').value = S.privacy.consentDisclosure;

    $('#inRetention').value = S.privacy.retentionDays;
    setSwitch($('#swKeepAudio'), S.privacy.keepAudio);
    setSwitch($('#swKeepTranscripts'), S.privacy.keepTranscripts);
    setSwitch($('#swAutoPurge'), S.privacy.autoPurge);

    $('#providerSub').textContent = `Primary ${S.providers.primary}${S.providers.fallbackEnabled && S.providers.fallback ? ` · fallback ${S.providers.fallback}` : ' · no fallback'}`;
    $('#voiceSub').textContent = `STT ${S.voice.sttEngine} · TTS ${S.voice.ttsEngine} · voice ${S.voice.ttsVoice}`;
    $('#waSub').textContent = S.whatsapp.phoneNumberId ? `Number ID ${S.whatsapp.phoneNumberId}` : 'Not configured';
    $('#callSub').textContent = S.whatsapp.callingEnabled ? `Enabled · ${S.whatsapp.callingAnswerMode}` : 'Disabled';
    $('#privSub').textContent = `${S.privacy.retentionDays} days · audio ${S.privacy.keepAudio ? 'kept' : 'not kept'}`;
  }

  function renderServerPanel() {
    const srv = S.server || {};
    const health = window.VictorApp && window.VictorApp.health;
    $('#srvSub').textContent = srv.publicUrl ? 'Public URL configured' : 'No public URL — webhooks cannot arrive';
    $('#serverBody').innerHTML = `
      <div class="rowsetting"><span>Environment<small>NODE_ENV on the server</small></span><span class="val">${esc(srv.env || '?')}</span></div>
      <div class="rowsetting"><span>Public URL<small>Set PUBLIC_URL in .env</small></span><span class="val breakword">${esc(srv.publicUrl || 'not set')}</span></div>
      <div class="rowsetting"><span>App PIN protection<small>Without it the API is open to anyone who can reach the URL</small></span><span class="val">${srv.appPinSet ? 'enabled' : 'NOT SET'}</span></div>
      <div class="rowsetting"><span>ffmpeg<small>Needed for WhatsApp call audio and format conversion</small></span><span class="val">${health && health.ffmpeg ? (health.ffmpeg.ffmpeg ? 'available' : 'MISSING') : 'unknown'}</span></div>
      <div class="rowsetting"><span>WebRTC media stack<small>Needed for live two-way call audio</small></span><span class="val">${srv.callingMediaSupported ? 'available' : 'MISSING'}</span></div>
      <div class="rowsetting"><span>Server time</span><span class="val">${esc(new Date().toString().slice(0, 24))}</span></div>
      ${!srv.callingMediaSupported ? `<div class="banner warn mt10"><strong>Live call audio is unavailable</strong><p>${esc(srv.callingMediaReason || '')}</p></div>` : ''}
      ${health && health.ffmpeg && !health.ffmpeg.ffmpeg ? `<div class="banner warn mt10"><strong>ffmpeg is missing</strong><p>${esc(health.ffmpeg.detail)}</p></div>` : ''}
      <div class="banner mt10"><strong>Where your keys live</strong>
        <p>API keys are encrypted with AES-256-GCM inside the server database and decrypted only in the server process. This page receives a masked preview such as <span class="mono">AIza…cdef</span> and never the key itself, so they cannot leak through the app, the APK or the browser.</p></div>`;
  }

  function updateWebhookPanel() {
    const srv = S.server || {};
    const base = srv.publicUrl;
    $('#waWebhookUrl').textContent = base ? `${base}${srv.webhookPath || '/webhooks/whatsapp'}` : 'PUBLIC_URL is not set — there is no address Meta can reach.';
    $('#waWebhookHelp').textContent = base
      ? 'Paste this URL into Meta App Dashboard → WhatsApp → Configuration → Webhooks → Callback URL, subscribe to the messages and calls fields, then press "Test connection".'
      : 'Deploy the backend to a public HTTPS host and set PUBLIC_URL in .env, or expose it with a free tunnel while you test. Meta cannot deliver webhooks to localhost.';
    const st = S.secrets && S.secrets['whatsapp.appSecret'];
    $('#waVerifyState').textContent = st && st.set ? 'configured' : 'MISSING — set WA_VERIFY_TOKEN in .env';
  }

  function renderVoiceCaps() {
    const c = window.VictorVoice.capabilities();
    const choice = window.VictorVoice.chooseSttEngine(S.voice.sttEngine);
    $('#voiceCaps').innerHTML = `
      <div class="banner ${c.secureContext ? 'ok' : 'error'}" style="margin-top:0">
        <strong>What this browser can really do</strong>
        <p>Secure context: ${c.secureContext ? 'yes' : 'NO — microphone access is blocked'}<br>
        Web Speech API: ${c.webSpeechApi ? 'available' : 'not available'}<br>
        MediaRecorder: ${c.mediaRecorder ? 'available' : 'not available'}<br>
        getUserMedia: ${c.getUserMedia ? 'available' : 'not available'}<br>
        speechSynthesis: ${c.speechSynthesis ? 'available' : 'not available'}</p>
        <p class="fix">Engine that will be used: <b>${esc(choice.engine || 'NONE')}</b> — ${esc(choice.reason)}</p>
      </div>`;
  }

  async function renderCallEligibility() {
    let e = null;
    try { e = await API.callingEligibility(); } catch { /* not fatal */ }
    const media = (S.server || {}).callingMediaSupported;
    const bic = e && e.businessInitiated;
    $('#callEligibility').innerHTML = `
      <div class="banner ${media ? 'ok' : 'warn'}" style="margin-top:0">
        <strong>Answering incoming calls — what is actually required</strong>
        <p>Meta's Calling API needs ALL of the following, and no code can substitute for them:</p>
        <p style="margin-top:7px">1. The number registered on <b>Cloud API</b>, not the WhatsApp Business app.<br>
        2. A daily messaging limit tier of <b>at least 2,000 unique recipients</b> (public test numbers and Tech Partner sandbox accounts are exempt).<br>
        3. Calling enabled on the number — the button below performs that real write.<br>
        4. The app subscribed to the <b>calls</b> webhook field, and <b>whatsapp_business_messaging</b> granted.<br>
        5. A public HTTPS server reachable by Meta's media servers, with a routable IP or a TURN relay.<br>
        6. Callers must use an <b>iPhone or Android phone</b> client — tablets, WhatsApp Web and desktop cannot place these calls.</p>
        ${bic ? `<p class="fix">${esc(bic.reason)}</p>` : ''}
      </div>
      <div class="banner ${media ? 'ok' : 'error'}">
        <strong>Live audio engine on this server: ${media ? 'available' : 'NOT available'}</strong>
        <p>${esc((S.server || {}).callingMediaReason || '')}</p>
      </div>`;
  }

  // --- diagnostics ---------------------------------------------------------
  async function runDiagnostics(target) {
    const body = target || '#diagBody';
    $(body).innerHTML = '<div class="row"><span class="spin"></span><span class="tiny">Running live checks against Google, GonkaRouter, Meta and this server…</span></div>';
    try {
      const d = await API.diagnostics();
      const groups = {};
      for (const c of d.checks) (groups[c.group] = groups[c.group] || []).push(c);
      const names = { ai: 'AI providers', voice: 'Voice pipeline', whatsapp: 'WhatsApp messaging', calling: 'WhatsApp calling' };
      const pass = d.checks.filter(c => c.ok).length;
      $('#diagSub').textContent = `${pass}/${d.checks.length} checks pass · ${d.ready.whatsappMessaging ? 'messaging ready' : 'messaging not ready'} · ${d.ready.whatsappCalling ? 'calling ready' : 'calling not ready'}`;
      $(body).innerHTML = Object.entries(groups).map(([g, items]) => `
        <div class="sectionrow"><div class="sectiontitle">${esc(names[g] || g)}</div><span class="eyebrow" style="letter-spacing:.1em">${items.filter(i => i.ok).length}/${items.length}</span></div>
        ${items.map(c => `
          <div class="check ${c.ok ? 'pass' : 'fail'}">
            <span class="mark">${c.ok ? '✓' : '✕'}</span>
            <span class="grow">
              <span class="clabel">${esc(c.label)}</span>
              <span class="cdetail">${esc(c.detail)}</span>
              ${!c.ok && c.fix ? `<span class="cfix">${esc(c.fix)}</span>` : ''}
            </span>
          </div>`).join('')}
      `).join('') + `
        <div class="banner ${d.ready.whatsappMessaging ? 'ok' : 'warn'} mt14"><strong>Overall</strong><p>${esc(d.summary || '')}</p></div>
        <div class="banner mt10"><strong>What this app can do right now</strong>
          <p>Voice conversation in this app: ${d.ready.browserVoice || d.ready.serverVoice ? 'yes' : 'no'}<br>
          Server AI replies: ${d.ready.aiText ? 'yes' : 'no — add a provider key'}<br>
          WhatsApp messaging automation: ${d.ready.whatsappMessaging ? 'ready' : 'not ready'}<br>
          WhatsApp call answering: ${d.ready.whatsappCalling ? 'ready' : 'not ready'}</p></div>`;
      if (!target) { $('#grpDiag').open = true; window.VictorApp && window.VictorApp.refreshHomeStatus(); }
    } catch (e) {
      $(body).innerHTML = `<div class="banner error"><strong>Diagnostics failed</strong><p>${esc(e.message)}</p>${e.fix ? `<p class="fix">${esc(e.fix)}</p>` : ''}</div>`;
    }
  }

  // --- credential save/test wiring -----------------------------------------
  function wireCredential({ inputSel, saveSel, testSel, clearSel, secretKey, resultSel, testTarget, onTest }) {
    const inp = $(inputSel);
    $(saveSel).addEventListener('click', async () => {
      const value = inp.value.trim();
      if (!value) { banner('#settingsBanner', 'warn', 'Nothing to save', 'Paste a credential first, or use Remove to delete the stored one.'); return; }
      try {
        const r = await API.putSecret(secretKey, value);
        inp.value = '';
        const st = r.status || {};
        renderResult(resultSel, { ok: true, detail: st.masked ? `Stored encrypted. Preview ${st.masked}, fingerprint ${st.fingerprint || 'available'}. This is NOT a successful connection yet — press Test.` : 'Stored on the server. Reloading status…', latencyMs: null });
        window.VictorApp && window.VictorApp.toast('Credential stored encrypted');
        await load();
      } catch (e) { renderResult(resultSel, { ok: false, error: { message: e.message }, fix: e.fix }); }
    });
    $(testSel).addEventListener('click', async () => {
      renderResult(resultSel, { running: true, detail: 'Calling the live service…' });
      try {
        const r = await API.test(testTarget);
        if (onTest) onTest(r);
        renderResult(resultSel, r);
        window.VictorApp && window.VictorApp.toast(r.ok ? 'Connection test PASSED' : 'Connection test FAILED');
      } catch (e) {
        renderResult(resultSel, { ok: false, error: { message: e.message }, fix: e.fix, statusCode: e.status, detail: (e.data && (e.data.detail || (e.data.error && e.data.error.message))) || e.message });
      }
    });
    $(clearSel).addEventListener('click', async () => {
      if (!confirm('Remove this stored credential? The app will stop using this provider until you add a new one.')) return;
      try { await API.deleteSecret(secretKey); renderResult(resultSel, { ok: true, detail: 'Credential removed from the server.' }); await load(); }
      catch (e) { renderResult(resultSel, { ok: false, error: { message: e.message } }); }
    });
  }

  function collect() {
    return {
      providers: {
        primary: $('#inPrimary').value,
        fallback: $('#inFallback').value,
        fallbackEnabled: getSwitch($('#swFallback')),
        gemini: { model: $('#inGeminiModel').value, temperature: Number($('#inTemp').value), maxOutputTokens: Number($('#inMaxTok').value) },
        gonka: { baseUrl: $('#inGonkaBase').value.trim(), apiFormat: $('#inGonkaFormat').value, model: $('#inGonkaModel').value.trim() },
        huggingface: { model: $('#inHfModel').value.trim(), enabled: getSwitch($('#swHf')) }
      },
      persona: { systemPrompt: $('#inPersona').value, bossName: $('#inBossName').value.trim() || 'my boss' },
      voice: {
        sttEngine: $('#inSttEngine').value, sttModel: $('#inSttModel').value, sttLanguage: $('#inSttLang').value.trim() || 'en-NG',
        ttsEngine: $('#inTtsEngine').value, ttsModel: $('#inTtsModel').value, ttsVoice: $('#inTtsVoice').value,
        ttsStyle: $('#inTtsStyle').value.trim(), browserVoiceStyle: $('#inBrowserVoice').value,
        rate: Number($('#rate').value), autoSpeakReplies: getSwitch($('#swAutoSpeak'))
      },
      whatsapp: {
        graphVersion: $('#inWaVersion').value.trim() || 'v23.0',
        phoneNumberId: $('#inWaPhoneId').value.trim(), wabaId: $('#inWaWabaId').value.trim(),
        autoReplyEnabled: getSwitch($('#swAutoReply')), awayModeEnabled: getSwitch($('#swAway')),
        awayModeSchedule: { mode: $('#inAwayMode').value, start: $('#inAwayStart').value, end: $('#inAwayEnd').value, days: [0, 1, 2, 3, 4, 5, 6] },
        autoReplyText: $('#reply').value,
        autoReplyOncePerContactHours: Number($('#inThrottle').value),
        handleVoiceNotes: getSwitch($('#swVoiceNotes')), transcribeVoiceNotes: getSwitch($('#swTranscribe')),
        summarizeVoiceNotes: getSwitch($('#swSummarize')), flagImportant: getSwitch($('#swFlag')),
        notifyOwner: getSwitch($('#swNotify')), ownerWaId: $('#inOwnerWa').value.trim(),
        maxRetries: Number($('#inRetries').value),
        callingEnabled: getSwitch($('#swCalling')), callingAnswerMode: $('#inCallMode').value,
        callingGreeting: $('#inCallGreeting').value, callingMaxSeconds: Number($('#inCallMax').value),
        callingMaxTurns: Number($('#inCallTurns').value), callingRecordAudio: getSwitch($('#swCallRecord'))
      },
      privacy: {
        retentionDays: Number($('#inRetention').value), keepAudio: getSwitch($('#swKeepAudio')),
        keepTranscripts: getSwitch($('#swKeepTranscripts')), autoPurge: getSwitch($('#swAutoPurge')),
        playConsentDisclosure: getSwitch($('#swConsent')), consentDisclosure: $('#inConsent').value
      }
    };
  }

  function init() {
    // Switches that persist immediately.
    const immediate = [
      ['#swFallback', v => ({ providers: { fallbackEnabled: v } })],
      ['#swHf', v => ({ providers: { huggingface: { enabled: v } } })],
      ['#swAutoSpeak', v => ({ voice: { autoSpeakReplies: v } })],
      ['#swAutoReply', v => ({ whatsapp: { autoReplyEnabled: v } })],
      ['#swAway', v => ({ whatsapp: { awayModeEnabled: v } })],
      ['#swVoiceNotes', v => ({ whatsapp: { handleVoiceNotes: v } })],
      ['#swTranscribe', v => ({ whatsapp: { transcribeVoiceNotes: v } })],
      ['#swSummarize', v => ({ whatsapp: { summarizeVoiceNotes: v } })],
      ['#swFlag', v => ({ whatsapp: { flagImportant: v } })],
      ['#swNotify', v => ({ whatsapp: { notifyOwner: v } })],
      ['#swCalling', v => ({ whatsapp: { callingEnabled: v } })],
      ['#swCallRecord', v => ({ whatsapp: { callingRecordAudio: v } })],
      ['#swConsent', v => ({ privacy: { playConsentDisclosure: v } })],
      ['#swKeepAudio', v => ({ privacy: { keepAudio: v } })],
      ['#swKeepTranscripts', v => ({ privacy: { keepTranscripts: v } })],
      ['#swAutoPurge', v => ({ privacy: { autoPurge: v } })]
    ];
    for (const [sel, build] of immediate) {
      const el = $(sel);
      if (!el) continue;
      el.addEventListener('click', async () => {
        const next = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', String(next));
        const ok = await savePatch(build(next));
        if (!ok) el.setAttribute('aria-checked', String(!next));   // revert on failure
        window.VictorApp && window.VictorApp.syncHomeFromSettings();
      });
    }

    $('#rate').addEventListener('input', () => { $('#rateValue').textContent = Number($('#rate').value).toFixed(1) + '×'; });
    $('#rate').addEventListener('change', () => savePatch({ voice: { rate: Number($('#rate').value) } }));
    $('#inSttEngine').addEventListener('change', async () => { await savePatch({ voice: { sttEngine: $('#inSttEngine').value } }); renderVoiceCaps(); });
    $('#inTtsEngine').addEventListener('change', () => { savePatch({ voice: { ttsEngine: $('#inTtsEngine').value } }); renderVoiceCaps(); });
    $('#inAwayMode').addEventListener('change', () => savePatch({ whatsapp: { awayModeSchedule: Object.assign({}, S.whatsapp.awayModeSchedule, { mode: $('#inAwayMode').value }) } }));

    $('#btnSaveAll').addEventListener('click', async () => {
      $('#saveStatus').textContent = 'Saving…';
      await savePatch(collect(), 'All preferences');
      await load();
    });

    $('#btnRunDiagnostics').addEventListener('click', () => runDiagnostics());
    $('#btnResetPrefs').addEventListener('click', async () => {
      if (!confirm('Reset all preferences to defaults? Stored API keys are kept.')) return;
      try { await API.resetSettings(); await load(); window.VictorApp && window.VictorApp.toast('Preferences reset'); }
      catch (e) { banner('#settingsBanner', 'error', 'Reset failed', e.message); }
    });

    wireCredential({ inputSel: '#inGemini', saveSel: '#saveGemini', testSel: '#testGemini', clearSel: '#clearGemini',
      secretKey: 'gemini.apiKey', resultSel: '#resGemini', testTarget: 'gemini' });
    wireCredential({ inputSel: '#inGonka', saveSel: '#saveGonka', testSel: '#testGonka', clearSel: '#clearGonka',
      secretKey: 'gonka.apiKey', resultSel: '#resGonka', testTarget: 'gonka' });
    wireCredential({ inputSel: '#inHf', saveSel: '#saveHf', testSel: '#testHf', clearSel: '#clearHf',
      secretKey: 'huggingface.token', resultSel: '#resHf', testTarget: 'huggingface' });

    // WhatsApp credentials: token + app secret saved together.
    $('#saveWa').addEventListener('click', async () => {
      const tok = $('#inWaToken').value.trim();
      const sec = $('#inWaSecret').value.trim();
      let did = false;
      try {
        if (tok) { await API.putSecret('whatsapp.accessToken', tok); $('#inWaToken').value = ''; did = true; }
        if (sec) { await API.putSecret('whatsapp.appSecret', sec); $('#inWaSecret').value = ''; did = true; }
      } catch (e) { renderResult('#resWa', { ok: false, error: { message: e.message }, fix: e.fix }); return; }
      const okPatch = await savePatch({ whatsapp: {
        phoneNumberId: $('#inWaPhoneId').value.trim(), wabaId: $('#inWaWabaId').value.trim(),
        graphVersion: $('#inWaVersion').value.trim() || 'v23.0' } }, 'WhatsApp configuration');
      if (did || okPatch) { renderResult('#resWa', { ok: true, detail: 'Saved. Now press "Test connection" — Meta must accept the token and the Phone Number ID before anything will send.' }); await load(); }
    });

    $('#testWa').addEventListener('click', async () => {
      renderResult('#resWa', { running: true, detail: 'Calling the Meta Graph API…' });
      try {
        const r = await API.test('whatsapp');
        const pass = r.checks.filter(c => c.ok).length, total = r.checks.length;
        renderResult('#resWa', {
          ok: r.messagingReady, latencyMs: r.latencyMs,
          detail: `${pass}/${total} checks pass. ${r.summary}`,
          error: r.messagingReady ? null : { message: 'WhatsApp messaging is not ready yet.', hint: null }
        });
        // Show each check so the user sees the real reason.
        const el = $('#resWa');
        el.insertAdjacentHTML('beforeend', `<div class="testresult ${r.messagingReady ? 'pass' : 'fail'}">
          <div class="testhead">Detailed checks</div>
          ${r.checks.map(c => `<div class="testdetail" style="margin-top:6px">${c.ok ? '✓' : '✕'} <b>${esc(c.label)}</b> — ${esc(c.detail)}${!c.ok && c.blocker ? `<br><span style="color:#f2d79a">↳ ${esc(c.blocker)}</span>` : ''}</div>`).join('')}
        </div>`);
        if (r.profile) {
          el.insertAdjacentHTML('beforeend', `<div class="testresult pass"><div class="testhead">Number profile returned by Meta</div>
            <div class="testmeta">${esc(JSON.stringify(r.profile))}</div></div>`);
        }
      } catch (e) { renderResult('#resWa', { ok: false, error: { message: e.message }, fix: e.fix, statusCode: e.status }); }
    });

    $('#clearWa').addEventListener('click', async () => {
      if (!confirm('Remove the stored WhatsApp token and App Secret?')) return;
      try { await API.deleteSecret('whatsapp.accessToken'); await API.deleteSecret('whatsapp.appSecret'); await load(); renderResult('#resWa', { ok: true, detail: 'WhatsApp credentials removed.' }); }
      catch (e) { renderResult('#resWa', { ok: false, error: { message: e.message } }); }
    });

    $('#testCallSettings').addEventListener('click', async () => {
      renderResult('#resCall', { running: true, detail: 'Reading call settings from Meta…' });
      try { const r = await API.test('whatsapp_calling'); renderResult('#resCall', { ok: r.ok, detail: r.ok ? `Meta returned: ${JSON.stringify(r.settings)}` : (r.error && r.error.message), error: r.error, latencyMs: r.latencyMs, statusCode: r.statusCode }); }
      catch (e) { renderResult('#resCall', { ok: false, error: { message: e.message }, fix: e.fix }); }
    });

    $('#btnEnableCalling').addEventListener('click', async () => {
      if (!confirm('This performs a real write to Meta: POST /{phone_number_id}/settings with calling ENABLED. Continue?')) return;
      renderResult('#resCall', { running: true, detail: 'Enabling calling on your number…' });
      try {
        const r = await API.enableCalling({ status: 'ENABLED' });
        renderResult('#resCall', r.ok ? { ok: true, detail: 'Meta accepted the change. Calling is now ENABLED on this number. WhatsApp clients can take up to 7 days to show the call icon; opening your business chat info page forces a refresh.' }
          : { ok: false, detail: r.error && r.error.message, error: r.error, statusCode: r.statusCode });
      } catch (e) { renderResult('#resCall', { ok: false, error: { message: e.message, hint: e.data && e.data.error && e.data.error.hint }, fix: e.fix }); }
    });

    $('#listGeminiModels').addEventListener('click', async () => {
      renderResult('#resGemini', { running: true, detail: 'Fetching the model list for your key…' });
      try {
        const r = await API.test('gemini_models');
        renderResult('#resGemini', { ok: r.ok, detail: r.ok ? `${r.count} models are reachable with this key.` : (r.error && r.error.message), error: r.error });
        if (r.ok && r.models) {
          const el = $('#resGemini');
          el.insertAdjacentHTML('beforeend', `<div class="testresult pass"><div class="testhead">Models reachable with your key (${r.count})</div>
            <div class="testdetail mono" style="max-height:150px;overflow:auto">${r.models.map(esc).join('<br>')}</div></div>`);
        }
      } catch (e) { renderResult('#resGemini', { ok: false, error: { message: e.message } }); }
    });

    $('#listGonkaModels').addEventListener('click', async () => {
      renderResult('#resGonka', { running: true, detail: 'Fetching the model list from GonkaRouter…' });
      try {
        const r = await API.test('gonka_models');
        renderResult('#resGonka', { ok: r.ok, detail: r.ok ? `${r.count} models are reachable with this key.` : (r.error && r.error.message), error: r.error });
        if (r.ok && r.models) {
          $('#resGonka').insertAdjacentHTML('beforeend', `<div class="testresult pass"><div class="testhead">Models reachable with your key (${r.count})</div>
            <div class="testdetail mono" style="max-height:150px;overflow:auto">${r.models.map(esc).join('<br>')}</div></div>`);
        }
      } catch (e) { renderResult('#resGonka', { ok: false, error: { message: e.message } }); }
    });

    $('#testVoice').addEventListener('click', async () => {
      const rate = Number($('#rate').value);
      $('#voiceStatus').textContent = 'Speaking with the browser voice…';
      try {
        await window.VictorVoice.speak('Hello. I am VICTOR AI, your personal secretary. This is the browser voice engine.', { engine: 'browser', rate });
        $('#voiceStatus').textContent = 'Browser voice worked. This engine is free but is not available inside an Android WebView.';
      } catch (e) { $('#voiceStatus').textContent = e.message + (e.fix ? ' ' + e.fix : ''); }
    });

    $('#testNeuralVoice').addEventListener('click', async () => {
      renderResult('#resVoice', { running: true, detail: 'Synthesising with the Gemini TTS model…' });
      try {
        const r = await API.test('gemini_voices');
        renderResult('#resVoice', r);
        if (r.ok) {
          await window.VictorVoice.speak('Hello. I am VICTOR AI, your personal secretary.', { engine: 'gemini' });
          $('#voiceStatus').textContent = `Neural voice worked: ${r.model}, voice "${r.voice}".`;
        }
      } catch (e) { renderResult('#resVoice', { ok: false, error: { message: e.message }, fix: e.fix }); }
    });

    load();
  }

  window.VictorSettings = { init, load, runDiagnostics, get settings() { return S; }, collect, savePatch };
})();
