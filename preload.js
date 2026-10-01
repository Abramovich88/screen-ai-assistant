const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = ['llm-chunk', 'llm-done', 'stt-status', 'tts-audio', 'hotkey-analyze', 'hotkey-mic'];

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  chatStream: (payload) => ipcRenderer.invoke('chat-stream', payload),
  abortChat: () => ipcRenderer.invoke('llm-abort'),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  transcribe: (audioBuffer) => ipcRenderer.invoke('stt-transcribe', audioBuffer),
  speak: (text) => ipcRenderer.invoke('tts-speak', text),
  on: (channel, callback) => {
    if (!ALLOWED_EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (event, data) => callback(data));
  }
});
