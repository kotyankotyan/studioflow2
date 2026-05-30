// storage.js - IndexedDB persistence for projects and audio buffers

const DB_NAME = 'StudioFlow2';
const DB_VERSION = 1;
let db = null;

async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('projects')) {
        d.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('buffers')) {
        d.createObjectStore('buffers', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e.target.error);
  });
}

async function saveProject(meta) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

async function loadProject(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('projects', 'readonly');
    const req = tx.objectStore('projects').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function listProjects() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('projects', 'readonly');
    const req = tx.objectStore('projects').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function deleteProject(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(['projects', 'buffers'], 'readwrite');
    tx.objectStore('projects').delete(id);
    // Delete associated buffers
    const bufStore = tx.objectStore('buffers');
    const idx = IDBKeyRange.bound(id + '/', id + '/~');
    bufStore.delete(idx);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

async function saveBuffer(key, audioBuffer, ctx) {
  const d = await openDB();
  // Serialize AudioBuffer to interleaved Float32Array
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const data = new Float32Array(ch * len);
  for (let c = 0; c < ch; c++) {
    data.set(audioBuffer.getChannelData(c), c * len);
  }
  const meta = { id: key, ch, len, sr: audioBuffer.sampleRate, data };
  return new Promise((resolve, reject) => {
    const tx = d.transaction('buffers', 'readwrite');
    tx.objectStore('buffers').put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

async function loadBuffer(key, ctx) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('buffers', 'readonly');
    const req = tx.objectStore('buffers').get(key);
    req.onsuccess = () => {
      if (!req.result) { resolve(null); return; }
      const { ch, len, sr, data } = req.result;
      const buf = ctx.createBuffer(ch, len, sr);
      for (let c = 0; c < ch; c++) {
        buf.copyToChannel(data.slice(c * len, (c + 1) * len), c);
      }
      resolve(buf);
    };
    req.onerror = e => reject(e.target.error);
  });
}

window.SF2Storage = { saveProject, loadProject, listProjects, deleteProject, saveBuffer, loadBuffer };
