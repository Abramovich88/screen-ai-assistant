/* AI Screen Assistant — логика интерфейса (работает в песочнице рендерера) */

'use strict';

var $ = function (id) { return document.getElementById(id); };

var SYSTEM_PROMPT = [
  'Ты — «Экранный помощник»: ИИ-ассистент, встроенный в рабочий стол пользователя Windows.',
  'Ты видишь экран пользователя: к сообщению пользователя может прилагаться свежий скриншот его монитора.',
  'Твоя задача — помогать: отвечать на вопросы о том, что видно на экране (что это, как работает, как сделать, где купить), подсказывать решения, находить ошибки в интерфейсах, объяснять и переводить текст с экрана.',
  'Правила:',
  '1. Всегда отвечай по-русски, если пользователь сам не попросил другой язык.',
  '2. Отвечай кратко и по делу: обычно 2–6 предложений, если не просят подробнее. Твои ответы будут озвучиваться синтезатором речи, поэтому избегай больших списков, таблиц и избыточного форматирования.',
  '3. Если приложен скриншот — опирайся на него и описывай конкретно то, что видишь. Не выдумывай содержимое экрана.',
  '4. Если скриншота нет и вопрос касается экрана — напомни включить режим «Видеть экран» (чип над полем ввода) или нажать «Анализ экрана».',
  '5. Будь дружелюбным и естественным, как живой помощник, сидящий рядом.'
].join('\n');

var PRESETS = {
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.5v', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  bigmodel: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5v', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-001', keyUrl: 'https://openrouter.ai/keys' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  custom: { baseUrl: '', model: '', keyUrl: '' }
};

var S = {
  apiPreset: 'zai',
  baseUrl: PRESETS.zai.baseUrl,
  apiKey: '',
  model: PRESETS.zai.model,
  ttsEnabled: true,
  ttsVoice: 'ru-RU-DmitryNeural',
  ttsRate: 0,
  attachScreenshot: true,
  sttModel: 'base',
  hfMirror: false,
  voiceMode: false
};

var history = [];
var streaming = false;
var streamText = '';
var streamThink = '';
var recording = false;
var mediaRecorder = null;
var recChunks = [];
var recStartedAt = 0;
var recTimer = null;
var currentAudio = null;
var speaking = false;
var speakSeq = 0;
var pendingSpeakSeq = 0;
var typingEl = null;
var aiBubbleEl = null;
var aiThinkEl = null;

/* ------------------------------ утилиты ------------------------------ */

function escapeHtml (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdLite (src) {
  var text = escapeHtml(src);
  var blocks = [];
  text = text.replace(/```([\s\S]*?)```/g, function (m, code) {
    var body = code.replace(/^\s*[a-zA-Z0-9_+-]*\n/, '');
    blocks.push('<pre>' + body + '</pre>');
    return '\u0001B' + (blocks.length - 1) + '\u0001';
  });
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/(https?:\/\/[^\s<>"')\]]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  text = text.replace(/\n/g, '<br>');
  text = text.replace(/\u0001B(\d+)\u0001/g, function (m, i) { return blocks[Number(i)] || ''; });
  return text;
}

function stripForTTS (src) {
  return String(src || '')
    .replace(/```[\s\S]*?```/g, ' фрагмент кода. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ссылка ')
    .replace(/[#>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

var toastEl = null;
function toast (msg, isError) {
  if (toastEl) toastEl.remove();
  toastEl = document.createElement('div');
  toastEl.id = 'toast';
  if (isError) toastEl.className = 'error';
  toastEl.textContent = msg;
  document.body.appendChild(toastEl);
  setTimeout(function () { if (toastEl) { toastEl.remove(); toastEl = null; } }, 4200);
}

function setStatus (msg) {
  var el = $('sttStatus');
  if (el) el.textContent = msg || '';
}

function scrollBottom () {
  var m = $('messages');
  m.scrollTop = m.scrollHeight;
}

function saveHistory () {
  try { localStorage.setItem('sai_history', JSON.stringify(history.slice(-40))); } catch (e) {}
}

function loadHistory () {
  try {
    var raw = localStorage.getItem('sai_history');
    if (raw) history = JSON.parse(raw) || [];
  } catch (e) { history = []; }
}

/* ------------------------------ рендер сообщений ------------------------------ */

function nowTime () {
  var d = new Date();
  function p (n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function avatarEl (cls, letter) {
  var av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = letter;
  return av;
}

function shotChip () {
  return '<div class="shot-chip"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> со скриншотом экрана</div>';
}

function renderUser (text, hadImg) {
  var wrap = document.createElement('div');
  wrap.className = 'msg user';
  var b = document.createElement('div');
  b.className = 'bubble';
  b.innerHTML = (hadImg ? shotChip() : '') + mdLite(text);
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'Ты · ' + nowTime();
  b.appendChild(meta);
  wrap.appendChild(b);
  wrap.appendChild(avatarEl('', 'Я'));
  $('messages').appendChild(wrap);
  scrollBottom();
}

function renderAi (html, isError) {
  var wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.appendChild(avatarEl('', 'ИИ'));
  var b = document.createElement('div');
  b.className = 'bubble' + (isError ? ' err' : '');
  b.innerHTML = html;
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'Помощник · ' + nowTime();
  b.appendChild(meta);
  wrap.appendChild(b);
  $('messages').appendChild(wrap);
  scrollBottom();
  return b;
}

function renderAiOnly (text) {
  renderAi(mdLite(text), false);
}

function startAssistantBubble () {
  streamText = '';
  streamThink = '';
  var wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.appendChild(avatarEl('', 'ИИ'));
  var b = document.createElement('div');
  b.className = 'bubble';
  b.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  typingEl = b.querySelector('.typing');
  aiThinkEl = null;
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'Помощник печатает…';
  b.appendChild(meta);
  wrap.appendChild(b);
  $('messages').appendChild(wrap);
  aiBubbleEl = b;
  scrollBottom();
}

function updateAssistantBubble () {
  if (!aiBubbleEl) return;
  if (typingEl) { typingEl.remove(); typingEl = null; }
  if (streamThink && !aiThinkEl) {
    aiThinkEl = document.createElement('div');
    aiThinkEl.className = 'think';
    aiBubbleEl.insertBefore(aiThinkEl, aiBubbleEl.firstChild);
  }
  if (aiThinkEl) aiThinkEl.textContent = streamThink.slice(-400);
  var meta = aiBubbleEl.querySelector('.meta');
  var html = mdLite(streamText);
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  aiBubbleEl.insertBefore(tmp, meta);
  scrollBottom();
}

function finalizeAssistant (text, isError, stopped) {
  if (aiBubbleEl) {
    aiBubbleEl.remove();
    aiBubbleEl = null;
  }
  typingEl = null;
  aiThinkEl = null;
  streaming = false;
  setStreamUI(false);
  if (isError) {
    renderAi(mdLite(text), true);
    return;
  }
  var t = (text || '').trim() || (stopped ? '(остановлено)' : '(пустой ответ)');
  history.push({ role: 'assistant', content: t });
  saveHistory();
  renderAiOnly(t);
  if (!stopped && S.ttsEnabled) {
    speak(t);
  } else if (S.voiceMode && !recording) {
    startRecording();
  }
}

function setStreamUI (on) {
  $('btnSend').classList.toggle('hidden', on);
  $('btnStop').classList.toggle('hidden', !on);
}

/* ------------------------------ отправка ------------------------------ */

function buildApiMessages (imgB64) {
  var msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  var h = history.slice(-14);
  for (var i = 0; i < h.length; i++) {
    var m = h[i];
    var isLast = (i === h.length - 1);
    if (m.role === 'user') {
      if (isLast && imgB64) {
        msgs.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imgB64 } },
            { type: 'text', text: m.content }
          ]
        });
      } else {
        msgs.push({ role: 'user', content: (m.hadImg ? '[скриншот экрана был приложен ранее] ' : '') + m.content });
      }
    } else {
      msgs.push({ role: 'assistant', content: m.content });
    }
  }
  return msgs;
}

function sendMessage (text, opts) {
  opts = opts || {};
  text = String(text || '').trim();
  if (!text || streaming) return;

  var imgB64 = null;
  var needsShot = typeof opts.attach === 'boolean' ? opts.attach : S.attachScreenshot;

  var doSend = function () {
    history.push({ role: 'user', content: text, hadImg: !!imgB64 });
    saveHistory();
    renderUser(text, !!imgB64);
    $('input').value = '';
    autoGrow();
    var apiMessages = buildApiMessages(imgB64);
    startAssistantBubble();
    streaming = true;
    setStreamUI(true);
    window.api.chatStream({ messages: apiMessages }).catch(function (e) {
      finalizeAssistant('Не удалось отправить запрос: ' + (e && e.message ? e.message : e), true);
    });
  };

  if (needsShot) {
    setStatus('Делаю снимок экрана…');
    window.api.captureScreen().then(function (shot) {
      imgB64 = opts.b64 || shot.jpegB64;
      showPreview(imgB64);
      setStatus('');
      doSend();
    }).catch(function (e) {
      setStatus('');
      toast('Не удалось снять экран: ' + (e && e.message ? e.message : e), true);
      imgB64 = null;
      doSend();
    });
  } else {
    doSend();
  }
}

function analyzeScreen () {
  if (streaming) { toast('Дождись окончания ответа'); return; }
  setStatus('Делаю снимок экрана…');
  window.api.captureScreen().then(function (shot) {
    showPreview(shot.jpegB64);
    setStatus('');
    sendMessage('Посмотри на мой экран и скажи, что сейчас происходит. Если видишь ошибки, важные элементы или что-то интересное — расскажи.', { attach: true, b64: shot.jpegB64 });
  }).catch(function (e) {
    setStatus('');
    toast('Ошибка снимка экрана: ' + (e && e.message ? e.message : e), true);
  });
}

/* ------------------------------ озвучка ------------------------------ */

function speak (text) {
  var t = stripForTTS(text);
  if (!t) return;
  speakSeq++;
  pendingSpeakSeq = speakSeq;
  setStatus('Озвучиваю ответ…');
  window.api.speak(t).catch(function (e) {
    setStatus('');
    toast('Ошибка озвучки: ' + (e && e.message ? e.message : e), true);
  });
}

function stopAudio () {
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    currentAudio = null;
  }
  speaking = false;
}

function playAudio (b64) {
  stopAudio();
  currentAudio = new Audio('data:audio/mpeg;base64,' + b64);
  speaking = true;
  var done = function () {
    speaking = false;
    currentAudio = null;
    setStatus('');
    if (S.voiceMode && !recording && !streaming) {
      startRecording();
    }
  };
  currentAudio.onended = done;
  currentAudio.onerror = done;
  currentAudio.play().catch(done);
}

/* ------------------------------ запись голоса ------------------------------ */

function pickMime () {
  var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
  }
  return '';
}

function mixdown (audioBuffer) {
  var ch = audioBuffer.numberOfChannels;
  if (ch === 1) return audioBuffer.getChannelData(0).slice();
  var a = audioBuffer.getChannelData(0);
  var b = audioBuffer.getChannelData(1);
  var out = new Float32Array(a.length);
  for (var i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

function resampleTo16k (input, fromRate) {
  if (fromRate === 16000) return input;
  var ratio = fromRate / 16000;
  var len = Math.max(1, Math.round(input.length / ratio));
  var out = new Float32Array(len);
  for (var i = 0; i < len; i++) {
    var pos = i * ratio;
    var i0 = Math.floor(pos);
    var frac = pos - i0;
    var s0 = input[i0] || 0;
    var s1 = (input[i0 + 1] !== undefined) ? input[i0 + 1] : s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function toggleMic () {
  if (recording) { stopRecording(); return; }
  if (streaming) { toast('Дождись окончания ответа'); return; }
  if (speaking) stopAudio();
  startRecording().catch(function (e) {
    setStatus('');
    toast('Не удалось начать запись: ' + (e && e.message ? e.message : e), true);
  });
}

function startRecording () {
  if (recording) return Promise.resolve();
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  }).then(function (stream) {
    recChunks = [];
    var opts = {};
    var mime = pickMime();
    try {
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      mediaRecorder = new MediaRecorder(stream);
    }
    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size) recChunks.push(e.data);
    };
    mediaRecorder.onstop = function () { handleRecorded(stream); };
    mediaRecorder.start(250);
    recording = true;
    recStartedAt = Date.now();
    $('btnMic').classList.add('rec');
    recTimer = setInterval(function () {
      var sec = Math.floor((Date.now() - recStartedAt) / 1000);
      setStatus('Запись… ' + sec + ' c (клик по микрофону — закончить)');
    }, 300);
    setStatus('Слушаю… говори!');
  });
}

function stopRecording () {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recording = false;
  $('btnMic').classList.remove('rec');
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
}

function handleRecorded (stream) {
  stream.getTracks().forEach(function (t) { t.stop(); });
  var dur = Date.now() - recStartedAt;
  if (dur < 600) {
    setStatus('');
    toast('Слишком короткая запись — нажми микрофон, говори, потом снова нажми.');
    return;
  }
  try {
    var blob = new Blob(recChunks, { type: (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm' });
    setStatus('Обрабатываю аудио…');
    blob.arrayBuffer().then(function (arr) {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      return ctx.decodeAudioData(arr).then(function (decoded) {
        var mono = mixdown(decoded);
        var pcm = resampleTo16k(mono, decoded.sampleRate);
        ctx.close();
        setStatus('Распознаю речь…');
        return window.api.transcribe(pcm.buffer);
      });
    }).then(function (res) {
      var text = res && res.text ? String(res.text).trim() : '';
      setStatus('');
      if (text) {
        sendMessage(text, { attach: S.attachScreenshot });
      } else {
        toast('Не разобрал речь. Попробуй ещё раз или напиши текстом.');
      }
    }).catch(function (e) {
      setStatus('');
      toast('Ошибка распознавания: ' + (e && e.message ? e.message : e), true);
    });
  } catch (e) {
    setStatus('');
    toast('Ошибка обработки аудио: ' + (e && e.message ? e.message : e), true);
  }
}

/* ------------------------------ превью экрана ------------------------------ */

function showPreview (b64) {
  $('screenPreview').src = 'data:image/jpeg;base64,' + b64;
}

function refreshPreview () {
  window.api.captureScreen().then(function (shot) {
    showPreview(shot.jpegB64);
  }).catch(function (e) {
    toast('Ошибка снимка: ' + (e && e.message ? e.message : e), true);
  });
}

/* ------------------------------ чипы ------------------------------ */

function applyChips () {
  var cs = $('chipScreen');
  var ct = $('chipTts');
  var cv = $('chipVoice');
  cs.classList.toggle('active', !!S.attachScreenshot);
  cs.querySelector('span').textContent = 'Видеть экран: ' + (S.attachScreenshot ? 'вкл' : 'выкл');
  ct.classList.toggle('active', !!S.ttsEnabled);
  ct.querySelector('span').textContent = 'Озвучка: ' + (S.ttsEnabled ? 'вкл' : 'выкл');
  cv.classList.toggle('active', !!S.voiceMode);
  cv.querySelector('span').textContent = 'Голосовой режим: ' + (S.voiceMode ? 'вкл' : 'выкл');
  var dot = $('connStatus');
  dot.classList.toggle('on', !!S.apiKey);
  dot.classList.toggle('off', !S.apiKey);
  dot.title = S.apiKey ? 'API-ключ настроен' : 'API-ключ не настроен — открой настройки';
}

function toggleSetting (key) {
  S[key] = !S[key];
  window.api.saveSettings(S).then(function (s) { S = s; applyChips(); });
}

/* ------------------------------ настройки (модалка) ------------------------------ */

function openSettings () {
  $('stProvider').value = S.apiPreset || 'zai';
  $('stBaseUrl').value = S.baseUrl || '';
  $('stApiKey').value = S.apiKey || '';
  $('stModel').value = S.model || '';
  $('stVoiceMale').checked = (S.ttsVoice !== 'ru-RU-SvetlanaNeural');
  $('stVoiceFemale').checked = (S.ttsVoice === 'ru-RU-SvetlanaNeural');
  $('stRate').value = S.ttsRate || 0;
  $('stRateVal').textContent = (S.ttsRate >= 0 ? '+' : '') + (S.ttsRate || 0) + '%';
  $('stTtsEnabled').checked = !!S.ttsEnabled;
  $('stAttach').checked = !!S.attachScreenshot;
  $('stSttModel').value = S.sttModel || 'base';
  $('stHfMirror').checked = !!S.hfMirror;
  updateKeyLink();
  $('testResult').textContent = '';
  $('modalOverlay').classList.remove('hidden');
}

function closeSettings () {
  $('modalOverlay').classList.add('hidden');
}

function updateKeyLink () {
  var p = $('stProvider').value;
  var preset = PRESETS[p] || PRESETS.zai;
  var link = $('stKeyLink');
  link.href = preset.keyUrl || '#';
  link.textContent = (p === 'zai' ? 'z.ai — ключи API' :
    p === 'bigmodel' ? 'open.bigmodel.cn — ключи API' :
    p === 'openrouter' ? 'openrouter.ai/keys' :
    p === 'openai' ? 'platform.openai.com/api-keys' :
    'документация твоего сервера');
}

function collectSettings () {
  var voice = $('stVoiceFemale').checked ? 'ru-RU-SvetlanaNeural' : 'ru-RU-DmitryNeural';
  var patch = {
    apiPreset: $('stProvider').value,
    baseUrl: $('stBaseUrl').value.trim(),
    apiKey: $('stApiKey').value.trim(),
    model: $('stModel').value.trim(),
    ttsVoice: voice,
    ttsRate: Number($('stRate').value) || 0,
    ttsEnabled: $('stTtsEnabled').checked,
    attachScreenshot: $('stAttach').checked,
    sttModel: $('stSttModel').value,
    hfMirror: $('stHfMirror').checked
  };
  S = Object.assign({}, S, patch);
  return window.api.saveSettings(S).then(function (s) { S = s; applyChips(); });
}

function testConnection () {
  collectSettings().then(function () {
    var el = $('testResult');
    el.className = '';
    el.textContent = 'Проверяю…';
    window.api.testConnection().then(function (r) {
      el.className = 'ok';
      el.textContent = 'Подключено! Модель ответила: «' + String(r.reply || '').slice(0, 80) + '»';
    }).catch(function (e) {
      el.className = 'bad';
      el.textContent = 'Ошибка: ' + (e && e.message ? e.message : e);
    });
  });
}

/* ------------------------------ приветствие ------------------------------ */

function addWelcome () {
  var txt;
  if (!S.apiKey) {
    txt = 'Привет! Я — твой экранный помощник. Вот что я умею:\n\n' +
      '**1. Вижу твой экран.** Спроси: «Что это?», «Как это сделать?», «Где это купить?» — я смотрю на снимок монитора и отвечаю по тому, что вижу.\n\n' +
      '**2. Слышу твой голос.** Нажми кнопку с микрофоном, скажи вопрос, нажми ещё раз — я распознаю речь и отвечу.\n\n' +
      '**3. Говорю по-русски.** Живые нейроголоса: мужской (Дмитрий) или женский (Светлана) — выбирается в настройках.\n\n' +
      'Чтобы я заработал, нужен API-ключ ИИ (настраивается один раз): открой настройки и вставь ключ, например от **Z.ai** или **OpenRouter**. Там же есть кнопка «Проверить подключение».';
  } else {
    txt = 'Готов к работе! Спроси меня что-нибудь о том, что на экране, нажми «Анализ экрана» или кнопку с микрофоном и скажи вопрос голосом.';
  }
  renderAiOnly(txt);
}

/* ------------------------------ прочее ------------------------------ */

function autoGrow () {
  var el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function clearChat () {
  history = [];
  saveHistory();
  $('messages').innerHTML = '';
  addWelcome();
}

/* ------------------------------ события ------------------------------ */

function bindUI () {
  $('btnSend').addEventListener('click', function () {
    sendMessage($('input').value, { attach: S.attachScreenshot });
  });
  $('input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage($('input').value, { attach: S.attachScreenshot });
    }
  });
  $('input').addEventListener('input', autoGrow);

  $('btnMic').addEventListener('click', toggleMic);
  $('btnAnalyze').addEventListener('click', analyzeScreen);
  $('btnPreview').addEventListener('click', function () {
    var pane = $('screenPane');
    pane.classList.toggle('hidden');
    if (!pane.classList.contains('hidden') && !$('screenPreview').src) refreshPreview();
  });
  $('btnRefreshScreen').addEventListener('click', refreshPreview);
  $('btnClear').addEventListener('click', clearChat);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettingsCancel').addEventListener('click', closeSettings);
  $('btnSettingsSave').addEventListener('click', function () {
    collectSettings().then(function () {
      closeSettings();
      toast('Настройки сохранены');
    });
  });
  $('btnTest').addEventListener('click', testConnection);
  $('stProvider').addEventListener('change', function () {
    var p = $('stProvider').value;
    var preset = PRESETS[p];
    if (preset && preset.baseUrl) {
      $('stBaseUrl').value = preset.baseUrl;
      $('stModel').value = preset.model;
    }
    updateKeyLink();
  });
  $('stRate').addEventListener('input', function () {
    var v = Number($('stRate').value);
    $('stRateVal').textContent = (v >= 0 ? '+' : '') + v + '%';
  });
  $('stApiKey').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') testConnection();
  });

  $('chipScreen').addEventListener('click', function () { toggleSetting('attachScreenshot'); });
  $('chipTts').addEventListener('click', function () { toggleSetting('ttsEnabled'); });
  $('chipVoice').addEventListener('click', function () {
    toggleSetting('voiceMode');
    setTimeout(function () {
      if (S.voiceMode) toast('Голосовой режим включён: говори — я слушаю. Отвечу голосом и снова буду слушать.');
    }, 50);
  });

  $('modalOverlay').addEventListener('click', function (e) {
    if (e.target === $('modalOverlay')) closeSettings();
  });

  window.api.on('llm-chunk', function (d) {
    if (!streaming) return;
    if (d.reasoning) streamThink += d.reasoning;
    if (d.delta) {
      streamText += d.delta;
      updateAssistantBubble();
    }
  });

  window.api.on('llm-done', function (d) {
    if (!streaming) return;
    if (d && d.error) {
      finalizeAssistant('Ошибка: ' + d.error, true);
    } else if (d && d.aborted) {
      finalizeAssistant(streamText, false, true);
    } else {
      finalizeAssistant((d && d.text) || streamText, false, false);
    }
  });

  window.api.on('stt-status', function (d) {
    if (d && d.message) setStatus(d.message);
    else if (d && d.state === 'ready') setStatus('');
    if (d && d.state === 'error' && d.message) toast(d.message, true);
  });

  window.api.on('tts-audio', function (d) {
    if (speakSeq !== pendingSpeakSeq) return;
    playAudio(d.b64);
  });

  window.api.on('hotkey-analyze', function () { analyzeScreen(); });
  window.api.on('hotkey-mic', function () { toggleMic(); });
}

/* ------------------------------ инициализация ------------------------------ */

function init () {
  bindUI();
  window.api.getSettings().then(function (s) {
    S = s;
    loadHistory();
    applyChips();
    if (history.length) {
      for (var i = 0; i < history.length; i++) {
        var m = history[i];
        if (m.role === 'user') renderUser(m.content, m.hadImg);
        else renderAiOnly(m.content);
      }
      renderAiOnly('(чат восстановлен из прошлого запуска)');
    } else {
      addWelcome();
    }
    if (!S.apiKey) openSettings();
  });
}

init();
