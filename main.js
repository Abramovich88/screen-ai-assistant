/*
 * AI Screen Assistant — Electron main process
 * Видит экран пользователя, общается с vision-LLM,
 * распознаёт русскую речь (Whisper, локально) и отвечает голосом (Microsoft Edge TTS).
 */

const { app, BrowserWindow, Menu, ipcMain, desktopCapturer, screen, globalShortcut, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/* ------------------------------ настройки ------------------------------ */

const DEFAULT_SETTINGS = {
  apiPreset: 'zai',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  apiKey: '',
  model: 'glm-4.5v',
  ttsEnabled: true,
  ttsVoice: 'ru-RU-DmitryNeural',
  ttsRate: 0,
  attachScreenshot: true,
  sttModel: 'base',
  hfMirror: false,
  voiceMode: false
};

const STT_MODELS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small'
};

let win = null;
let settings = Object.assign({}, DEFAULT_SETTINGS);
let transcriber = null;
let transcriberKey = '';
let transcriberLoading = false;
let abortController = null;

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function settingsPath () {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings () {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) {
    settings = Object.assign({}, DEFAULT_SETTINGS);
  }
}

function persistSettings () {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { /* игнорируем */ }
}

/* ------------------------------ окно ------------------------------ */

function createWindow () {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1160,
    height: 800,
    minWidth: 920,
    minHeight: 620,
    title: 'AI Экранный Помощник',
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (win) win.show(); });

  // Логируем ошибки интерфейса, чтобы их можно было увидеть в консоли/логах
  try {
    win.webContents.on('console-message', (e, level, message) => {
      const msg = (e && typeof e === 'object' && e.message !== undefined) ? e.message : message;
      if (msg) console.log('[renderer]', msg);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer gone]', details && details.reason);
    });
  } catch (_) {}
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

/* ------------------------------ снимок экрана ------------------------------ */

ipcMain.handle('capture-screen', async () => {
  const displays = screen.getAllDisplays();
  let w = 1280, h = 800;
  for (const d of displays) {
    w = Math.max(w, Math.round(d.size.width * d.scaleFactor));
    h = Math.max(h, Math.round(d.size.height * d.scaleFactor));
  }
  w = Math.min(w, 1920);
  h = Math.min(h, 1920);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  if (!sources || !sources.length) throw new Error('Не удалось получить изображение экрана');
  const cursor = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor);
  let idx = sources.findIndex(s => s.display_id && String(disp.id) === s.display_id);
  if (idx < 0) idx = 0;
  let img = sources[idx].thumbnail;
  if (img.getSize().width > 1600) img = img.resize({ width: 1600 });
  const jpeg = img.toJPEG(82);
  if (!jpeg || jpeg.length < 1000) throw new Error('Снимок экрана пуст — попробуй ещё раз');
  return {
    jpegB64: jpeg.toString('base64'),
    monitor: sources.length > 1 ? ('Монитор ' + (idx + 1)) : 'Экран'
  };
});

/* ------------------------------ чат с LLM (поток) ------------------------------ */

ipcMain.handle('chat-stream', async (event, payload) => {
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
  if (!settings.apiKey) throw new Error('Сначала укажи API-ключ в настройках (кнопка-шестерёнка).');
  if (!settings.baseUrl) throw new Error('Не указан адрес API в настройках.');

  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  abortController = new AbortController();
  let full = '';

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify({
        model: settings.model,
        messages: messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let msg = 'Ошибка API ' + res.status;
      if (res.status === 401) msg = 'Неверный API-ключ (ошибка 401). Проверь ключ в настройках.';
      else if (res.status === 404) msg = 'Не найдено (404). Проверь адрес API и название модели.';
      else if (res.status === 429) msg = 'Превышен лимит запросов (429). Подожди немного.';
      try {
        const j = JSON.parse(t);
        const extra = (j.error && (j.error.message || j.error.code)) || j.message || '';
        if (extra) msg += ': ' + String(extra).slice(0, 300);
      } catch (_) {
        if (t && !msg.includes(':')) msg += ' — ' + t.slice(0, 200);
      }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          send('llm-done', { text: full });
          return full;
        }
        try {
          const j = JSON.parse(data);
          const delta = (j.choices && j.choices[0] && j.choices[0].delta) || {};
          if (delta.reasoning_content) send('llm-chunk', { reasoning: delta.reasoning_content });
          if (delta.content) {
            full += delta.content;
            send('llm-chunk', { delta: delta.content });
          }
        } catch (_) { /* частичный JSON — пропускаем */ }
      }
    }

    send('llm-done', { text: full });
    return full;
  } catch (err) {
    const aborted = err && (err.name === 'AbortError');
    send('llm-done', { aborted: aborted, text: full, error: aborted ? null : String((err && err.message) || err) });
    if (aborted) return full;
    return full;
  } finally {
    abortController = null;
  }
});

ipcMain.handle('llm-abort', async () => {
  if (abortController) {
    try { abortController.abort(); } catch (_) {}
  }
  return true;
});

/* ------------------------------ проверка подключения ------------------------------ */

ipcMain.handle('test-connection', async () => {
  if (!settings.apiKey) throw new Error('Ключ не указан');
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + settings.apiKey
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'user', content: 'Ответь одним коротким словом: работает' }],
      stream: false,
      max_tokens: 1000
    })
  });
  const t = await res.text();
  if (!res.ok) {
    let msg = 'Ошибка ' + res.status;
    try {
      const j = JSON.parse(t);
      msg += ': ' + ((j.error && (j.error.message || j.error.code)) || j.message || t.slice(0, 200));
    } catch (_) {
      msg += ': ' + t.slice(0, 200);
    }
    throw new Error(msg);
  }
  try {
    const j = JSON.parse(t);
    const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { ok: true, reply: c || 'Соединение установлено (модель ответила пусто — проверь название модели)' };
  } catch (_) {
    return { ok: true, reply: 'Соединение установлено' };
  }
});

/* ------------------------------ распознавание речи (Whisper, локально) ------------------------------ */

async function ensureTranscriber () {
  const key = STT_MODELS[settings.sttModel] ? settings.sttModel : 'base';
  if (transcriber && transcriberKey === key) return transcriber;
  if (transcriberLoading) throw new Error('Модель распознавания ещё загружается — подожди пару секунд.');
  transcriberLoading = true;
  try {
    send('stt-status', { state: 'loading', message: 'Готовлю модель распознавания речи…' });
    const tf = require('@huggingface/transformers');
    tf.env.cacheDir = path.join(app.getPath('userData'), 'models');
    tf.env.allowLocalModels = false;
    if (settings.hfMirror) {
      tf.env.remoteHost = 'https://hf-mirror.com';
    }
    transcriber = await tf.pipeline('automatic-speech-recognition', STT_MODELS[key], {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.file) {
          const pct = typeof p.progress === 'number' ? (Math.round(p.progress) + '%') : '';
          send('stt-status', { state: 'downloading', message: 'Скачиваю модель распознавания ' + pct + '(один раз)…' });
        }
      }
    });
    transcriberKey = key;
    send('stt-status', { state: 'ready', message: '' });
    return transcriber;
  } catch (err) {
    send('stt-status', { state: 'error', message: 'Ошибка загрузки модели: ' + String((err && err.message) || err) });
    throw err;
  } finally {
    transcriberLoading = false;
  }
}

ipcMain.handle('stt-transcribe', async (event, payload) => {
  try {
    let ab = payload;
    if (Buffer.isBuffer(ab)) ab = ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
    else if (ab instanceof Uint8Array) ab = ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
    else if (ab && ab.type === 'Buffer' && Array.isArray(ab.data)) ab = Uint8Array.from(ab.data).buffer;
    if (!(ab instanceof ArrayBuffer)) throw new Error('Неверный формат аудио');
    const f32 = new Float32Array(ab);
    if (f32.length < 5000) return { text: '' };

    const t = await ensureTranscriber();
    send('stt-status', { state: 'processing', message: 'Распознаю речь…' });
    const out = await t(f32, { language: 'russian', task: 'transcribe' });
    send('stt-status', { state: 'ready', message: '' });
    return { text: (out && out.text ? String(out.text) : '').trim() };
  } catch (err) {
    send('stt-status', { state: 'error', message: '' });
    throw err;
  }
});

/* ------------------------------ озвучка ответов (Edge TTS, русские голоса) ------------------------------ */

function escapeSSML (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

ipcMain.handle('tts-speak', async (event, text) => {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false };

  const mod = require('msedge-tts');
  const MsEdgeTTS = mod.MsEdgeTTS;
  const OUTPUT_FORMAT = mod.OUTPUT_FORMAT;

  const engine = new MsEdgeTTS();
  const voice = settings.ttsVoice || 'ru-RU-DmitryNeural';
  const rate = Number(settings.ttsRate) || 0;
  const rateStr = (rate >= 0 ? '+' : '') + rate + '%';

  await engine.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const streamObj = engine.toStream(escapeSSML(clean), { rate: rateStr });
  const stream = streamObj && streamObj.audioStream ? streamObj.audioStream : streamObj;

  await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      try { engine.close(); } catch (_) {}
      const b64 = Buffer.concat(chunks).toString('base64');
      send('tts-audio', { b64: b64 });
      resolve();
    });
    stream.on('error', (e) => {
      try { engine.close(); } catch (_) {}
      reject(e);
    });
  });

  return { ok: true };
});

/* ------------------------------ настройки ------------------------------ */

ipcMain.handle('get-settings', async () => settings);

ipcMain.handle('save-settings', async (e, s) => {
  settings = Object.assign({}, DEFAULT_SETTINGS, settings, s || {});
  persistSettings();
  return settings;
});

/* ------------------------------ запуск ------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadSettings();

    try {
      session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
        callback(permission === 'media');
      });
    } catch (_) {}

    createWindow();

    try {
      globalShortcut.register('Control+Shift+S', () => send('hotkey-analyze', {}));
      globalShortcut.register('Control+Shift+D', () => send('hotkey-mic', {}));
    } catch (_) {}

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

app.on('window-all-closed', () => {
  app.quit();
});
