const { ipcRenderer } = require('electron');
// Measurement-only preload, no callable bridge, credentials or host capabilities.
async function sample() {
  ipcRenderer.send('clover-s9-memory', { pid: process.pid, memory: await process.getProcessMemoryInfo(), sandboxed: process.sandboxed, isolated: process.contextIsolated });
}
void sample();
setInterval(sample, 500);
