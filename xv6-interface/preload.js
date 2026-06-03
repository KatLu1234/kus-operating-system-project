const { contextBridge, ipcRenderer } = require('electron');

// LLM IPC handlers are kept in main.js for use by the OOM killer integration.
// The renderer only consumes status + OOM events; it no longer drives a chat UI.
contextBridge.exposeInMainWorld('xv6', {
  // qemu lifecycle + IO
  onStart:   (cb) => ipcRenderer.on('qemu:start',   (_, d) => cb(d)),
  onStdout:  (cb) => ipcRenderer.on('qemu:stdout',  (_, d) => cb(d)),
  onStderr:  (cb) => ipcRenderer.on('qemu:stderr',  (_, d) => cb(d)),
  onExit:    (cb) => ipcRenderer.on('qemu:exit',    (_, d) => cb(d)),
  onMetrics: (cb) => ipcRenderer.on('qemu:metrics', (_, d) => cb(d)),  // host QEMU (legacy)
  onKstat:   (cb) => ipcRenderer.on('kstat:update', (_, d) => cb(d)),  // xv6 internal status (statd)
  restart:   () => ipcRenderer.invoke('qemu:restart'),
  stop:      () => ipcRenderer.invoke('qemu:stop'),
  send:      (text) => ipcRenderer.invoke('xv6:stdin', text),

  // Server purpose from the commissioning popup — sent to the LLM with every
  // OOM kill decision so it protects/sacrifices processes per the operator's intent.
  setPurpose: (text) => ipcRenderer.invoke('oom:setPurpose', text),

  // OOM killer telemetry (structured) — emitted by main.js after parsing coomd EVENT lines
  onOomEvent:    (cb) => ipcRenderer.on('oom:event',    (_, d) => cb(d)),
  onOomPressure: (cb) => ipcRenderer.on('oom:pressure', (_, d) => cb(d)),

  // Python LLM helper orchestration (the interface manages the Python side)
  onPyStatus:  (cb) => ipcRenderer.on('py:status', (_, d) => cb(d)),
  pyCheck:     () => ipcRenderer.invoke('py:check'),
  setEngine:   (engine) => ipcRenderer.invoke('oom:engine', engine),
  testOom:     () => ipcRenderer.invoke('oom:test'),

  // coomd lifecycle + raw output
  onCoomdStatus: (cb) => ipcRenderer.on('coomd:status', (_, d) => cb(d)),
  onCoomdStdout: (cb) => ipcRenderer.on('coomd:stdout', (_, d) => cb(d)),
  onCoomdStderr: (cb) => ipcRenderer.on('coomd:stderr', (_, d) => cb(d)),
  coomdRestart:  () => ipcRenderer.invoke('coomd:restart'),
  coomdStop:     () => ipcRenderer.invoke('coomd:stop'),

  // LLM status (read-only). The actual `llm:chat` is invoked from main.js by
  // the OOM decision path, not from the renderer.
  llmStatus: () => ipcRenderer.invoke('llm:status'),
});
