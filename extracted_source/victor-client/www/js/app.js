/* ==========================================================================
   VICTOR AI — application controller.

   Keeps the original interface behaviour (page switching, orb states, toast,
   wave bars, switches) and wires every visible control to a real operation.
   ========================================================================== */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const API = window.VictorAPI;
  const Voice = window.VictorVoice;

  let health = null;
  let settings = null;
  let lastQuestion = '';
  let busy = false;
  let refreshTimer = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- toast (original behaviour, preserved) -------------------------------
  let toastTimer;
  function toast(t) {
    const el = $('#toast');
    el.textContent = t;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // --- wave bars (original: 27 bars) ---------------------------------------
  function buildWaves() {
    const w = $('#waves');
    if (!w || w.childElementCount) return;
    for (let i = 0; i < 27; i++) {
      const b = document.createElement('i');
      b.style.animationDelay = `-${(i % 8) * 0.13}s`;
      w.appendChild(b);
    }
  }

  // --- navigation (original behaviour) -------------------------------------
  function page(name) {
    $$('.page').forEach(p => p.classList.toggle('active', p.dataset.view === name));
    $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.page === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'activity') loadActivityTab();
    if (name === 'recordings') loadRecordings();
    if (name === 'reports') loadReportsPage();
    if (name === 'home') loadHomeActivity();
    if (name === 'settings') { /* already loaded */ }
  }

  // --- status pill / LED driven by REAL state ------------------------------
  function setStatus(state, title, desc) {
    $('#led').dataset.state = state;
    $('#statusPill').dataset.state = state;
    $('#statusTitle').textContent = title;
    $('#statusDesc').textContent = desc;
    const labels = { live: 'LIVE', partial: 'PARTIAL', offline: 'NOT CONNECTED', unknown: 'CHECKING', busy: 'WORKING' };
    $('#statusPill').textContent = labels[state] || state.toUpperCase();
  }

  async function refreshHomeStatus() {
    try { health = await API.health(); } catch (e) {
      setStatus('offline', 'Backend unreachable', e.message);
      banner('#homeBanner', 'error', 'Cannot reach the VICTOR AI backend', e.message,
        'Start the server (npm start in the server folder) and reload this page.');
      return;
    }
    if (!settings) { try { settings = await API.getSettings(); } catch { settings = null; } }
    if (!settings) {
      setStatus('unknown', 'Locked', 'Enter your PIN in Settings to read the live state.');
      return;
    }

    const gemini = settings.secrets['gemini.apiKey'];
    const gonka = settings.secrets['gonka.apiKey'];
    const waTok = settings.secrets['whatsapp.accessToken'];
    const aiReady = Boolean((gemini && gemini.set) || (gonka && gonka.set));
    const away = settings.whatsapp.awayModeEnabled;

    // Away mode switch reflects the real stored preference.
    const awayEl = $('#away');
    awayEl.setAttribute('aria-checked', String(Boolean(away)));
    $('#awayDesc').textContent = away
      ? (settings.whatsapp.autoReplyEnabled ? 'Active. Inbound WhatsApp messages are answered automatically.' : 'Active, but auto-reply is switched off — messages are logged only.')
      : 'Off. Messages are logged but not answered automatically.';

    if (aiReady && waTok && waTok.set) {
      setStatus('live', 'Secretary is live', `AI via ${settings.providers.primary}. WhatsApp credentials stored — run the connection test in Settings to confirm Meta accepts them.`);
    } else if (aiReady) {
      setStatus('partial', 'AI connected · WhatsApp not configured', `Voice conversation works through ${settings.providers.primary}. Add WhatsApp credentials in Settings to handle messages and calls.`);
    } else if (waTok && waTok.set) {
      setStatus('partial', 'WhatsApp configured · no AI key', 'Add a Gemini or GonkaRouter key in Settings so VICTOR can understand and reply.');
    } else {
      setStatus('offline', 'Not configured yet', 'Open Settings, add at least one AI provider key, then run its connection test. Nothing works until a test passes.');
    }

    const caps = Voice.capabilities();
    const choice = Voice.chooseSttEngine(settings.voice.sttEngine);
    $('#engineHint').textContent = choice.engine
      ? `VOICE INPUT · ${choice.engine === 'browser' ? 'BROWSER SPEECH API' : 'SERVER TRANSCRIPTION'}`
      : 'VOICE INPUT UNAVAILABLE IN THIS BROWSER';
    $('#qMsg').textContent = settings.whatsapp.autoReplyEnabled ? 'Auto-reply on' : 'Logged only';
    $('#qCall').textContent = settings.whatsapp.callingEnabled ? `Handling · ${settings.whatsapp.callingAnswerMode}` : 'Handling off';

    const notes = [];
    if (!caps.secureContext) notes.push('This page is not a secure context, so the browser blocks the microphone. Open it over https:// or http://localhost.');
    if (!choice.engine) notes.push(choice.reason);
    if (health && health.ffmpeg && !health.ffmpeg.ffmpeg) notes.push('ffmpeg is missing on the server, so WhatsApp call audio and audio conversion are disabled.');
    if (settings.server && !settings.server.callingMediaSupported) notes.push('Live call audio is unavailable on this server: ' + settings.server.callingMediaReason);
    if (!settings.server || !settings.server.publicUrl) notes.push('PUBLIC_URL is not set, so Meta cannot deliver webhooks to this server.');

    if (notes.length) banner('#homeBanner', notes.some(n => /not a secure context|unavailable/.test(n)) ? 'error' : 'warn',
      'What is blocking full operation', notes.join(' '));
    else clearBanner('#homeBanner');

    $('#noticeText').textContent = 'This app reports the real state of every integration. Nothing here is simulated: a feature that cannot work yet says exactly what is missing and how to fix it.';
  }

  function banner(sel, kind, title, msg, fix) {
    const el = $(sel); if (!el) return;
    el.innerHTML = `<div class="banner ${kind}"><strong>${esc(title)}</strong><p>${esc(msg)}</p>${fix ? `<p class="fix">${esc(fix)}</p>` : ''}</div>`;
  }
  function clearBanner(sel) { const el = $(sel); if (el) el.innerHTML = ''; }

  // --- voice loop ----------------------------------------------------------
  function addTranscriptLine(who, text, meta, cls) {
    const box = $('#transcript');
    box.classList.remove('hidden');
    const line = document.createElement('div');
    line.className = 'tline ' + (cls || who);
    line.innerHTML = `<span class="who">${esc(who)}</span><span class="ttext">${esc(text)}</span>${meta ? `<span class="tmeta">${esc(meta)}</span>` : ''}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 40) box.removeChild(box.firstChild);
    return line;
  }
  function updateLastInterim(text) {
    const box = $('#transcript');
    let line = box.querySelector('.tline.interim');
    if (!line) line = addTranscriptLine('You (listening)', text, null, 'interim');
    else line.querySelector('.ttext').textContent = text;
  }
  function clearInterim() {
    const box = $('#transcript');
    const line = box.querySelector('.tline.interim');
    if (line) line.remove();
  }

  function setTransport(listening) {
    $('#btnStop').disabled = !listening;
    $('#btnCancel').disabled = !listening;
    $('#btnRetry').disabled = !lastQuestion;
    $('#mic').classList.toggle('stop', listening);
    $('#mic').setAttribute('aria-label', listening ? 'Stop voice input' : 'Start voice input');
  }

  async function onMic() {
    if (busy) { toast('VICTOR is already working — wait for it to finish or press cancel.'); return; }
    if (Voice.state === 'listening' || Voice.state === 'requesting') { Voice.stop(); setTransport(false); return; }
    if (Voice.muted) { toast('The microphone is muted. Tap the mute button to unmute.'); return; }

    busy = true;
    clearBanner('#homeBanner');
    setTransport(true);
    $('#voiceDetail').textContent = 'Starting…';
    addTranscriptLine('System', 'Listening started.', null, 'system');

    const r = await Voice.listenAndReply({ sessionId: 'voice' });
    busy = false;
    setTransport(false);
    clearInterim();

    if (!r.ok) {
      const e = r.error || {};
      $('#voiceDetail').textContent = e.message || 'Voice input failed.';
      addTranscriptLine('Error', e.message || 'Unknown error', e.fix ? 'How to fix: ' + e.fix : null, 'error');
      banner('#homeBanner', 'error', `Voice ${r.stage || ''} failed`.trim(), e.message || 'Unknown error', e.fix);
      toast(e.code === 'permission_denied' ? 'Microphone permission denied' : 'Voice input failed');
      refreshHomeStatus();
      return;
    }

    lastQuestion = r.transcript;
    $('#btnRetry').disabled = false;
    addTranscriptLine('You', r.transcript, r.capture ? `${r.capture.engine}${r.capture.model ? ' · ' + r.capture.model : ''} · ${r.capture.ms}ms` : null);
    if (r.reply) {
      addTranscriptLine('VICTOR', r.reply.text,
        `${r.reply.label || r.reply.provider} · ${r.reply.model || ''} · ${r.reply.latencyMs}ms${r.reply.usedFallback ? ' · used fallback provider' : ''}` +
        (r.reply.usage && r.reply.usage.totalTokens ? ` · ${r.reply.usage.totalTokens} tokens` : ''));
      $('#voiceDetail').textContent = 'Reply delivered.';
    }
    loadHomeActivity();
  }

  async function askTyped() {
    const text = prompt('Ask VICTOR a question:');
    if (!text || !text.trim()) return;
    busy = true;
    $('#voiceDetail').textContent = 'Thinking…';
    addTranscriptLine('You', text.trim(), 'typed');
    try {
      const r = await API.chat(text.trim(), 'voice');
      addTranscriptLine('VICTOR', r.text, `${r.label || r.provider} · ${r.model} · ${r.latencyMs}ms${r.usedFallback ? ' · fallback used' : ''}`);
      lastQuestion = text.trim();
      $('#btnRetry').disabled = false;
      if (settings && settings.voice.autoSpeakReplies !== false) Voice.speak(r.text).catch(() => {});
    } catch (e) {
      addTranscriptLine('Error', e.message, e.fix ? 'How to fix: ' + e.fix : null, 'error');
      banner('#homeBanner', 'error', 'The AI request failed', e.message, e.fix);
    } finally { busy = false; $('#voiceDetail').textContent = 'Tap the microphone to speak to VICTOR'; }
  }

  // --- activity tab ---------------------------------------------------------
  let activityTab = 'messages';
  async function loadActivityTab() {
    const list = $('#activityList');
    list.innerHTML = '<div class="row"><span class="spin"></span><span class="tiny">Loading real records…</span></div>';
    try {
      const stats = await API.stats();
      $('#stMsgIn').textContent = stats.allTime.messagesIn;
      $('#stMsgOut').textContent = stats.allTime.repliesSent;
      $('#stCallOk').textContent = stats.allTime.callsHandled;
      $('#stCallMissed').textContent = stats.allTime.callsMissed;
      const t = stats.todayCounts;
      $('#stMsgInFoot').textContent = `${t.messages.inbound} today · real counts`;
      $('#stMsgOutFoot').textContent = `${t.messages.repliesSent} today${t.messages.repliesFailed ? ` · ${t.messages.repliesFailed} failed` : ''}`;
      $('#stCallOkFoot').textContent = `${t.calls.handled} today · ${t.calls.totalSeconds}s`;
      $('#stCallMissedFoot').textContent = `${t.calls.missed} today`;
    } catch (e) {
      for (const id of ['#stMsgIn', '#stMsgOut', '#stCallOk', '#stCallMissed']) $(id).textContent = '—';
      banner('#activityBanner', 'error', 'Could not load counts', e.message, e.fix);
    }

    try {
      if (activityTab === 'messages') {
        const r = await API.messages({ limit: 40 });
        if (!r.items.length) return emptyState(list, 'No messages recorded',
          'Nothing has arrived yet. Connect WhatsApp in Settings, then messages that Meta delivers to your webhook will appear here with their real wamid, contact and delivery status.');
        list.innerHTML = r.items.map(m => messageCard(m)).join('');
      } else if (activityTab === 'calls') {
        const r = await API.calls({ limit: 40 });
        if (!r.items.length) return emptyState(list, 'No call events recorded',
          'Call rows appear only when Meta delivers a Call Connect or Terminate webhook. That requires an eligible number with calling enabled and the "calls" webhook field subscribed.');
        list.innerHTML = r.items.map(callCard).join('');
        wireCallButtons();
      } else {
        const r = await API.activity({ limit: 60 });
        if (!r.items.length) return emptyState(list, 'No system events yet',
          'Errors, replies, tests and call handling are logged here as they really happen.');
        list.innerHTML = r.items.map(a => `
          <div class="card">
            <div class="ctop"><span class="tag ${a.ok === 1 ? 'out' : a.ok === 0 ? 'bad' : 'info'}">${esc(a.kind)}</span>
              <span class="grow ctitle">${esc(a.title)}</span></div>
            ${a.detail ? `<div class="cbody">${esc(a.detail)}</div>` : ''}
            <div class="cfoot"><span class="tiny">${esc(a.created_at)}${a.ref_id ? ` · ref ${esc(a.ref_id)}` : ''}</span></div>
          </div>`).join('');
      }
      clearBanner('#activityBanner');
    } catch (e) {
      banner('#activityBanner', 'error', 'Could not load records', e.message, e.fix);
      list.innerHTML = '';
    }
  }

  function messageCard(m) {
    const inbound = m.direction === 'inbound';
    const statusTag = m.delivery ? `<span class="tag ${m.delivery === 'failed' ? 'bad' : m.delivery === 'read' ? 'out' : 'info'}">${esc(m.delivery)}</span>` : '';
    return `<div class="card">
      <div class="ctop">
        <span class="tag ${inbound ? 'in' : 'out'}">${inbound ? 'received' : 'sent'}</span>
        <span class="grow ctitle">${esc(m.contact_name || m.contact_wa_id || 'unknown')}</span>
        ${m.flagged ? '<span class="tag warn">important</span>' : ''}
        ${m.needs_callback ? '<span class="tag warn">callback</span>' : ''}
        ${statusTag}
      </div>
      <div class="csub">${esc(m.contact_wa_id || '')} · ${esc(m.type)} · ${esc(m.created_at)}${m.wa_message_id ? ` · ${esc(m.wa_message_id.slice(0, 22))}…` : ''}</div>
      ${m.body ? `<div class="cbody">${esc(m.body)}</div>` : ''}
      ${m.transcript ? `<div class="cbody"><b>Transcript:</b> ${esc(m.transcript)}</div>` : ''}
      ${m.summary ? `<div class="cbody"><b>Summary:</b> ${esc(m.summary)}</div>` : ''}
      ${m.error ? `<div class="banner error" style="margin-top:9px"><strong>Real error from the API</strong><p>${esc(m.error)}</p></div>` : ''}
    </div>`;
  }

  function callCard(c) {
    const stateTag = c.answered ? 'out' : (c.status === 'failed' ? 'bad' : 'warn');
    return `<div class="card">
      <div class="ctop">
        <span class="tag ${stateTag}">${esc(c.status)}</span>
        <span class="grow ctitle">${esc(c.contact_name || c.contact_wa_id || 'unknown caller')}</span>
        ${c.duration_sec != null ? `<span class="tag">${esc(c.duration_sec)}s</span>` : ''}
      </div>
      <div class="csub">${esc(c.contact_wa_id || '')} · ${esc(c.created_at)} · mode ${esc(c.answer_mode)} · media ${esc(c.media_state)}</div>
      ${c.transcript ? `<div class="cbody"><b>Transcript:</b><br>${esc(c.transcript)}</div>` : ''}
      ${c.summary ? `<div class="cbody"><b>Summary:</b> ${esc(c.summary)}</div>` : ''}
      ${c.error ? `<div class="banner error" style="margin-top:9px"><strong>Why this call was not completed</strong><p>${esc(c.error)}</p></div>` : ''}
      <div class="cfoot"><span class="tiny mono">${esc((c.wa_call_id || '').slice(0, 26))}…</span>${c.turns ? `<span class="tag">${esc(c.turns)} turns</span>` : ''}</div>
    </div>`;
  }

  function wireCallButtons() {
    $$('#activityList [data-endcall]').forEach(b => b.addEventListener('click', async () => {
      try { await API.endCall(b.dataset.endcall); toast('Call termination requested'); loadActivityTab(); }
      catch (e) { toast(e.message); }
    }));
  }

  function emptyState(container, title, desc) {
    container.innerHTML = `<div class="empty"><div class="etitle">${esc(title)}</div><div class="edesc">${esc(desc)}</div></div>`;
  }

  async function loadHomeActivity() {
    const box = $('#homeActivity');
    if (!box) return;
    try {
      const [stats, acts] = await Promise.all([API.stats(), API.activity({ limit: 4 })]);
      const rows = [];
      rows.push(`<div class="activityrow"><div class="activityicon">◌</div><div class="activitycopy">
        <div class="activityname">WhatsApp messages</div>
        <div class="activitynote">${stats.allTime.messagesIn} received · ${stats.allTime.repliesSent} replies actually sent${stats.todayCounts.messages.inbound ? ` · ${stats.todayCounts.messages.inbound} today` : ''}</div>
      </div><span class="quiet">${stats.allTime.messagesIn ? 'real' : 'none yet'}</span></div>`);
      rows.push(`<div class="activityrow"><div class="activityicon">⌁</div><div class="activitycopy">
        <div class="activityname">WhatsApp voice calls</div>
        <div class="activitynote">${stats.allTime.callsHandled} answered · ${stats.allTime.callsMissed} not answered · ${stats.allTime.recordings} recording(s)</div>
      </div><span class="quiet">${stats.allTime.callsHandled + stats.allTime.callsMissed ? 'real' : 'none yet'}</span></div>`);
      for (const a of acts.items) {
        rows.push(`<div class="activityrow"><div class="activityicon">${a.ok === 0 ? '⚠' : a.kind === 'error' ? '⚠' : '·'}</div><div class="activitycopy">
          <div class="activityname">${esc(a.title)}</div>
          <div class="activitynote">${esc((a.detail || '').slice(0, 110))}</div>
        </div><span class="quiet">${esc(String(a.created_at).slice(5, 16))}</span></div>`);
      }
      box.innerHTML = rows.join('');
      $('#qRec').textContent = `${stats.allTime.recordings} stored`;
    } catch (e) {
      box.innerHTML = `<div class="activityrow"><div class="activityicon">⚠</div><div class="activitycopy">
        <div class="activityname">Cannot read records</div><div class="activitynote">${esc(e.message)}</div></div></div>`;
    }
  }

  // --- recordings tab -------------------------------------------------------
  async function loadRecordings() {
    const list = $('#recordingsList');
    list.innerHTML = '<div class="row"><span class="spin"></span><span class="tiny">Loading the archive…</span></div>';
    try {
      const r = await API.recordings({ kind: $('#recKind').value, q: $('#recSearch').value, limit: 60 });
      if (!r.items.length) {
        return emptyState(list, 'The archive is empty',
          'No audio has been captured yet, and nothing fake is shown in its place. Entries appear when a WhatsApp voice note is downloaded, a permitted call is recorded, or you record a clip yourself with the button above.');
      }
      list.innerHTML = r.items.map(rec => `
        <div class="card" data-rec="${rec.id}">
          <div class="ctop">
            <span class="tag ${rec.kind === 'call_recording' ? 'warn' : rec.kind === 'whatsapp_voice_note' ? 'in' : 'info'}">${esc(rec.kind.replace(/_/g, ' '))}</span>
            <span class="grow ctitle">${esc(rec.contact_name || 'Unknown source')}</span>
            ${rec.authorized ? '<span class="tag out">authorised</span>' : '<span class="tag bad">not authorised</span>'}
          </div>
          <div class="csub">${esc(rec.created_at)}${rec.duration_sec ? ` · ${rec.duration_sec}s` : ''} · ${formatBytes(rec.bytes)} · ${esc(rec.mime || 'unknown format')}${rec.retained_until ? ` · kept until ${esc(rec.retained_until)}` : ''}</div>
          ${rec.path ? `<audio controls preload="none" src="${API.audioUrl(rec.id)}"></audio>`
            : `<div class="banner warn" style="margin-top:9px"><strong>No audio file</strong><p>Audio storage was disabled when this was captured, so only the transcript and metadata were kept.</p></div>`}
          ${rec.transcript ? `<div class="cbody"><b>Transcript:</b> ${esc(rec.transcript)}</div>` : ''}
          ${rec.summary ? `<div class="cbody"><b>Summary:</b> ${esc(rec.summary)}</div>` : ''}
          ${rec.ai_reply ? `<div class="cbody"><b>VICTOR replied:</b> ${esc(rec.ai_reply)}</div>` : ''}
          <div class="cfoot">
            ${rec.transcript ? '' : `<button class="btn small" data-act="transcribe">Transcribe</button>`}
            ${rec.transcript && !rec.summary ? `<button class="btn small" data-act="summarize">Summarise</button>` : ''}
            ${rec.transcript ? `<button class="btn small" data-act="speak">Read aloud</button>` : ''}
            <button class="btn small danger" data-act="delete">Delete</button>
          </div>
        </div>`).join('');
      wireRecordingButtons();
      clearBanner('#recBanner');
    } catch (e) {
      banner('#recBanner', 'error', 'Could not load the archive', e.message, e.fix);
      list.innerHTML = '';
    }
  }

  function wireRecordingButtons() {
    $$('#recordingsList [data-act]').forEach(btn => btn.addEventListener('click', async () => {
      const card = btn.closest('[data-rec]');
      const id = card.dataset.rec;
      const act = btn.dataset.act;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Working…';
      try {
        if (act === 'transcribe') {
          const r = await API.transcribeRecording(id);
          toast('Transcribed with ' + (r.model || 'the configured model'));
        } else if (act === 'summarize') {
          const r = await API.summarizeRecording(id);
          toast('Summarised with ' + (r.provider || 'the configured provider'));
        } else if (act === 'speak') {
          const rec = (await API.recordings({ limit: 100 })).items.find(x => String(x.id) === String(id));
          await Voice.speak(rec.transcript, { force: true });
          toast('Read aloud');
          return;
        } else if (act === 'delete') {
          if (!confirm('Delete this recording permanently? The audio file is removed from disk too.')) { btn.disabled = false; btn.textContent = old; return; }
          await API.deleteRecording(id);
          toast('Recording deleted');
        }
        await loadRecordings();
      } catch (e) {
        banner('#recBanner', 'error', 'That action failed', e.message, e.fix);
        btn.disabled = false; btn.textContent = old;
      }
    }));
  }

  async function recordClip() {
    const caps = Voice.capabilities();
    if (!caps.mediaRecorder || !caps.getUserMedia) {
      banner('#recBanner', 'error', 'This browser cannot record audio',
        'MediaRecorder or getUserMedia is unavailable, so a clip cannot be captured.',
        'Use Chrome, Edge, Firefox or Safari over https:// or localhost.');
      return;
    }
    if (!caps.secureContext) {
      banner('#recBanner', 'error', 'Microphone blocked — not a secure context',
        'Browsers only allow microphone access on https:// or http://localhost.',
        'Serve the app over HTTPS (the preview URL and a deployed host both are), then retry.');
      return;
    }
    let stream, rec;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { banner('#recBanner', 'error', 'Microphone permission failed', e.message,
      'Allow the microphone for this site in your browser or Android settings, then retry.'); return; }

    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    banner('#recBanner', 'warn', 'Recording…', 'Speak now. Press the button again to stop and save.', null);
    $('#btnRecordClip').textContent = 'Stop & save';
    rec.start();

    const stopHandler = async () => {
      $('#btnRecordClip').removeEventListener('click', stopHandler);
      $('#btnRecordClip').textContent = 'Record a mic clip';
      rec.stop();
      stream.getTracks().forEach(t => t.stop());
      await new Promise(r => { rec.onstop = r; });
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (!blob.size) { banner('#recBanner', 'error', 'Nothing was recorded', 'The recorder produced no audio data.'); return; }
      clearBanner('#recBanner');
      toast('Saving and transcribing…');
      try {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
        const r = await API.storeClip(b64, blob.type);
        banner('#recBanner', 'ok', 'Clip saved', r.transcript ? `Transcript: ${r.transcript}` : `Saved, but transcription failed: ${(r.transcriptError && r.transcriptError.message) || 'unknown'}`);
        await loadRecordings();
      } catch (e) { banner('#recBanner', 'error', 'Could not save the clip', e.message, e.fix); }
    };
    $('#btnRecordClip').addEventListener('click', stopHandler);
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // --- reports tab ----------------------------------------------------------
  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function loadReportsPage() {
    if (!$('#reportDay').value) $('#reportDay').value = todayLocal();
    renderSchedule();
    await loadReport($('#reportDay').value, false);
    try {
      const r = await API.reportList();
      $('#reportHistory').innerHTML = r.items.length
        ? r.items.map(x => `<div class="card"><div class="ctop"><span class="tag info">${esc(x.day)}</span>
            <span class="grow ctitle">${esc((x.narrative || 'No narrative stored').split('\n')[0].slice(0, 70))}</span></div>
            <div class="csub">${esc(x.generated_by || '')} · generated ${esc(x.created_at)}</div></div>`).join('')
        : '<div class="empty"><div class="etitle">No reports generated yet</div><div class="edesc">Press “Generate briefing” to build one from the real records for that day.</div></div>';
    } catch {}
  }

  function renderSchedule() {
    if (!settings) return;
    $('#reportSchedule').innerHTML = (settings.reports.schedules || []).map((sc, i) => `
      <div class="rowsetting"><span>${esc(sc.label)}<small>Scheduled time · ${esc(sc.time)} ${esc(settings.reports.timezone || '')}</small></span>
        <button class="switch" role="switch" aria-checked="${Boolean(sc.enabled)}" data-sched="${i}" aria-label="Toggle ${esc(sc.label)}"><span></span></button></div>`).join('') +
      `<p class="tiny mt10">Briefings are generated by the server on this schedule and can be delivered to your own WhatsApp number when notifications are enabled. Each one is built from real stored counts.</p>`;
    $$('#reportSchedule [data-sched]').forEach(b => b.addEventListener('click', async () => {
      const i = Number(b.dataset.sched);
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(next));
      const schedules = settings.reports.schedules.map((sc, j) => j === i ? Object.assign({}, sc, { enabled: next }) : sc);
      const ok = await window.VictorSettings.savePatch({ reports: { schedules } });
      if (!ok) b.setAttribute('aria-checked', String(!next));
      else toast(next ? 'Briefing scheduled' : 'Briefing unscheduled');
    }));
  }

  async function loadReport(day, generate) {
    $('#reportState').dataset.state = 'unknown';
    $('#reportState').textContent = generate ? 'GENERATING' : 'LOADING';
    try {
      const r = generate ? await API.generateReport(day) : await API.reportDay(day);
      const c = r.counts;
      $('#reportState').dataset.state = c.totals.anythingHappened ? 'live' : 'offline';
      $('#reportState').textContent = c.totals.anythingHappened ? 'REAL DATA' : 'NOTHING RECORDED';
      $('#reportCounts').innerHTML = `
        <div class="rowsetting"><span>Messages received</span><b>${c.messages.inbound}</b></div>
        <div class="rowsetting"><span>Voice notes received</span><b>${c.messages.voiceNotes}</b></div>
        <div class="rowsetting"><span>Replies actually sent</span><b>${c.messages.repliesSent}</b></div>
        <div class="rowsetting"><span>Replies that failed</span><b>${c.messages.repliesFailed}</b></div>
        <div class="rowsetting"><span>Flagged important</span><b>${c.messages.flagged}</b></div>
        <div class="rowsetting"><span>Callback requests</span><b>${c.messages.needsCallback}</b></div>
        <div class="rowsetting"><span>Calls answered</span><b>${c.calls.handled} (${c.calls.totalSeconds}s)</b></div>
        <div class="rowsetting"><span>Calls missed or not answered</span><b>${c.calls.missed}</b></div>
        <div class="rowsetting"><span>Recordings stored</span><b>${c.recordings.stored} (${c.recordings.transcribed} transcribed)</b></div>
        <div class="rowsetting"><span>Spoken turns in the app</span><b>${c.app.assistantTurns}</b></div>
        <div class="rowsetting"><span>Errors logged</span><b>${c.errors}</b></div>`;
      $('#reportNarrative').innerHTML = r.narrative
        ? `<div class="banner ok"><strong>Briefing${r.generatedBy ? ` · written by ${esc(r.generatedBy)}` : ''}</strong><p style="white-space:pre-wrap">${esc(r.narrative)}</p>
           ${r.providerError ? `<p class="fix">The AI provider failed (${esc(r.providerError.message || '')}); the counts above are still accurate.</p>` : ''}</div>`
        : (generate ? '' : `<div class="banner"><strong>Not generated yet</strong><p>Press “Generate briefing” to build it from these real counts.</p></div>`);
      $('#reportAttention').innerHTML = (r.attention && r.attention.length)
        ? `<div class="sectionrow"><div class="sectiontitle">Needs your attention</div><span class="eyebrow" style="letter-spacing:.1em">${r.attention.length}</span></div>` +
          r.attention.map(i => `<div class="card mt6"><div class="ctop"><span class="tag ${i.kind === 'system_error' || i.kind === 'delivery_failed' ? 'bad' : 'warn'}">${esc(i.kind.replace(/_/g, ' '))}</span>
            <span class="grow ctitle">${esc(i.title)}</span></div><div class="cbody">${esc(i.detail)}</div>
            <div class="cfoot"><span class="tiny">${esc(i.at)} · ${esc(i.refType)} #${esc(i.refId)}</span></div></div>`).join('')
        : `<div class="banner"><strong>Nothing needs your attention</strong><p>No important messages, failed sends, unanswered calls or system errors were recorded on ${esc(day)}.</p></div>`;
      if (generate) { loadReportHistoryOnly(); toast('Briefing generated from real records'); }
    } catch (e) {
      $('#reportState').dataset.state = 'offline';
      $('#reportState').textContent = 'FAILED';
      banner('#reportCounts', 'error', 'Could not build the report', e.message, e.fix);
    }
  }

  async function loadReportHistoryOnly() {
    try {
      const r = await API.reportList();
      $('#reportHistory').innerHTML = r.items.map(x => `<div class="card"><div class="ctop"><span class="tag info">${esc(x.day)}</span>
        <span class="grow ctitle">${esc((x.narrative || 'No narrative stored').split('\n')[0].slice(0, 70))}</span></div>
        <div class="csub">${esc(x.generated_by || '')} · generated ${esc(x.created_at)}</div></div>`).join('');
    } catch {}
  }

  // --- lock screen ----------------------------------------------------------
  /* Inside the Android package the page comes from the device, so the user must
     tell the app which server holds their keys. This box is hidden in a normal
     browser, where the UI and the API share an origin. */
  function initServerBox() {
    const box = $('#serverBox');
    if (!box) return;
    const saved = API.serverUrl();
    $('#lockServer').value = saved;
    const native = API.isNative();
    if (!native && !saved) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('#serverHint').textContent = native
      ? 'This app is running inside the Android package, where the page is served from the device itself. Point it at the server that holds your keys. The address is saved on this device only; no API key is ever stored in the app.'
      : 'This app is talking to a backend on a different address than the page. Change it here if you moved the server.';

    $('#lockServerTest').onclick = async () => {
      const v = $('#lockServer').value.trim();
      const out = $('#serverTestResult');
      if (!v) { out.innerHTML = '<div class="banner warn"><strong>No address entered</strong><p>Enter the full https:// address of your VICTOR AI server.</p></div>'; return; }
      if (!/^https?:\/\//i.test(v)) { out.innerHTML = '<div class="banner error"><strong>Not a valid address</strong><p>It must start with https:// (or http:// for a LAN test).</p></div>'; return; }
      API.setServerUrl(v);
      out.innerHTML = '<div class="banner"><strong>Testing…</strong><p>Contacting ' + esc(v) + '</p></div>';
      const r = await API.probeServer();
      if (r.ok) {
        out.innerHTML = `<div class="banner ok"><strong>Connected in ${r.ms} ms</strong><p>${esc(v)} answered /api/health. Now enter your PIN.</p></div>`;
      } else {
        out.innerHTML = `<div class="banner error"><strong>Could not reach that server</strong><p>${esc(r.error || ('HTTP ' + r.status))}</p>
          <p class="fix">Check the address, confirm the server is running, and make sure it allows this origin (CORS_ORIGINS). A non-HTTPS address will also be blocked by the Android WebView.</p></div>`;
      }
    };
    $('#lockServer').addEventListener('change', () => { API.setServerUrl($('#lockServer').value.trim()); });
  }

  async function initAuth() {
    initServerBox();
    let st;
    try { st = await API.authStatus(); } catch (e) {
      setStatus('offline', 'Backend unreachable', e.message);
      const box = $('#serverBox');
      if (box) box.classList.remove('hidden');
      $('#lockMsg').textContent = API.isNative()
        ? 'Cannot reach a backend. Enter your server address above, test it, then unlock.'
        : (e.message || 'Backend unreachable');
      return false;
    }
    if (st.authRequired && !st.authorized) {
      $('#lock').classList.remove('hidden');
      $('#lockPin').focus();
      return false;
    }
    $('#lock').classList.add('hidden');
    return true;
  }

  // --- init -----------------------------------------------------------------
  let initialized = false;

  function init() {
    // Guard: a WebView restore or a stray second call must not bind every
    // handler twice (that produced double settings writes).
    if (initialized) return;
    initialized = true;
    buildWaves();

    $$('[data-page]').forEach(b => b.addEventListener('click', () => page(b.dataset.page)));

    // Away-mode switch (original element id, now backed by real settings).
    $('#away').addEventListener('click', async () => {
      const el = $('#away');
      if (el.disabled) return;
      const next = el.getAttribute('aria-checked') !== 'true';
      el.disabled = true;                       // no double-tap writes
      el.setAttribute('aria-checked', String(next));
      let ok = false;
      try { ok = await window.VictorSettings.savePatch({ whatsapp: { awayModeEnabled: next } }); }
      finally { el.disabled = false; }
      if (!ok) {
        el.setAttribute('aria-checked', String(!next));
        toast('Away mode was NOT changed — see the error in Settings');
        return;
      }
      // Re-read the stored truth rather than trusting the optimistic flip.
      try {
        const s = await API.getSettings();
        settings = s; Voice.settings = s;
        el.setAttribute('aria-checked', String(Boolean(s.whatsapp.awayModeEnabled)));
      } catch { /* keep the optimistic value */ }
      toast(next ? 'Away mode enabled' : 'Away mode disabled');
      refreshHomeStatus();
    });

    $('#mic').addEventListener('click', onMic);
    $('#btnStop').addEventListener('click', () => { Voice.stop(); setTransport(false); toast('Listening stopped'); });
    $('#btnCancel').addEventListener('click', () => { Voice.cancel(); setTransport(false); clearInterim(); toast('Cancelled — nothing was sent'); });
    $('#btnMute').addEventListener('click', () => {
      const m = Voice.setMuted(!Voice.muted);
      $('#btnMute').classList.toggle('on', m);
      $('#btnMute').setAttribute('aria-pressed', String(m));
      toast(m ? 'Muted — microphone and speech output are off' : 'Unmuted');
    });
    $('#btnRetry').addEventListener('click', async () => {
      if (!lastQuestion) return;
      busy = true;
      addTranscriptLine('System', 'Retrying the last question…', null, 'system');
      try {
        const r = await API.chat(lastQuestion, 'voice');
        addTranscriptLine('VICTOR', r.text, `${r.label || r.provider} · ${r.model} · ${r.latencyMs}ms`);
        if (settings && settings.voice.autoSpeakReplies !== false) Voice.speak(r.text).catch(() => {});
      } catch (e) { addTranscriptLine('Error', e.message, e.fix, 'error'); }
      finally { busy = false; }
    });
    $('#qAsk').addEventListener('click', askTyped);
    $('#btnDiagnostics').addEventListener('click', () => { page('settings'); setTimeout(() => window.VictorSettings.runDiagnostics(), 120); });

    $$('.switch[data-atab]').forEach(() => {});
    $$('[data-atab]').forEach(b => b.addEventListener('click', () => {
      activityTab = b.dataset.atab;
      $$('[data-atab]').forEach(x => x.classList.toggle('primary', x === b));
      loadActivityTab();
    }));
    $('#btnRefreshActivity').addEventListener('click', loadActivityTab);
    $('#tabMessages').classList.add('primary');

    $('#recSearch').addEventListener('input', debounce(loadRecordings, 350));
    $('#recKind').addEventListener('change', loadRecordings);
    $('#btnRecordClip').addEventListener('click', recordClip);
    $('#btnPurgeExpired').addEventListener('click', async () => {
      if (!confirm('Delete every recording whose retention period has expired? Audio files are removed from disk.')) return;
      try { const r = await API.purgeExpired(); toast(`Removed ${r.removed} expired recording(s)`); loadRecordings(); }
      catch (e) { banner('#recBanner', 'error', 'Purge failed', e.message, e.fix); }
    });

    $('#btnLoadReport').addEventListener('click', () => loadReport($('#reportDay').value, false));
    $('#btnGenerateReport').addEventListener('click', () => loadReport($('#reportDay').value, true));

    $('#lockGo').addEventListener('click', doUnlock);
    $('#lockPin').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });

    // Voice engine events drive the orb and the transcript area.
    Voice.on(ev => {
      if (ev.type === 'state') {
        $('#voiceState').textContent = ev.detail && ev.detail.label ? ev.detail.label : ev.label || '';
        const map = { listening: 'Speak now — tap stop when you are done.', requesting: 'Waiting for microphone permission…',
          processing: 'Sending your audio for transcription…', thinking: 'VICTOR is composing a reply…',
          speaking: 'Speaking…', muted: 'Microphone and speech output are muted.', error: 'See the message below.',
          idle: 'Tap the microphone to speak to VICTOR' };
        $('#voiceDetail').textContent = (ev.detail && ev.detail.note) || map[ev.state] || '';
      } else if (ev.type === 'transcript' && ev.detail && (ev.detail.text || ev.detail.interim)) {
        updateLastInterim(ev.detail.text || ev.detail.interim);
      } else if (ev.type === 'warn' && ev.detail) {
        toast(ev.detail.message);
      } else if (ev.type === 'error' && ev.detail) {
        $('#voiceDetail').textContent = ev.detail.message || '';
      }
    });

    start();
  }

  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  async function doUnlock() {
    const pin = $('#lockPin').value;
    API.setServerUrl($('#lockServer') ? $('#lockServer').value.trim() : '');
    $('#lockMsg').textContent = 'Checking…';
    try {
      await API.login(pin);
      $('#lock').classList.add('hidden');
      $('#lockMsg').textContent = '';
      initialized = true;              // start() below must not re-run init work
      await start(true);
      $('#btnRetry').disabled = !lastQuestion;
      setTransport(false);
    } catch (e) {
      $('#lockMsg').textContent = (e.status === 0 || /fetch|network|Failed to fetch/i.test(e.message || ''))
        ? 'Cannot reach the server. Check the backend address above and that the server is running. (' + (e.message || '') + ')'
        : (e.message || 'Incorrect PIN.');
    }
  }

  async function start(afterUnlock) {
    const ok = await initAuth();
    if (!ok && !afterUnlock) return;
    try { health = await API.health(); } catch {}
    try { settings = await API.getSettings(); } catch (e) { settings = null; }
    if (settings) Voice.settings = settings;
    if (window.VictorSettings) window.VictorSettings.init();
    await refreshHomeStatus();
    await loadHomeActivity();
    setTransport(false);
    if (!refreshTimer) refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') loadHomeActivity(); }, 30000);
  }

  function onSettingsChanged(s) {
    settings = s;
    Voice.settings = s;
    refreshHomeStatus();
  }
  function syncHomeFromSettings() {
    if (window.VictorSettings && window.VictorSettings.settings) onSettingsChanged(window.VictorSettings.settings);
  }

  window.VictorApp = { init, page, toast, refreshHomeStatus, onSettingsChanged, syncHomeFromSettings,
    get health() { return health; }, get settings() { return settings; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
