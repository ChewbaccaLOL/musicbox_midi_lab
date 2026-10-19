(function (root) {
  "use strict";
  const KEY = "musicbox-midi-lab.project.v1";
  const pitch = value => Number.isInteger(value) && value >= 0 && value <= 127;
  const positive = value => Number.isFinite(value) && value > 0;
  function save(state, settings, storage) {
    if (!state.midiName) return true;
    try {
      const project = {
        version: 1, midiName: state.midiName, ticksPerBeat: state.ticksPerBeat,
        meter: state.meter, bpm: state.bpm, scale: state.scale, preset: state.preset,
        barsVisible: state.barsVisible, sampleRoot: state.sampleRoot,
        sampleToken: state.sampleToken || "", sampleName: state.sampleName || "",
        notes: state.notes.map(n => ({ tick: n.tick, originalNote: n.originalNote,
          duration: n.duration, velocity: n.velocity, channel: n.channel, trackIndex: n.trackIndex })),
        settings,
      };
      (storage || root.localStorage).setItem(KEY, JSON.stringify(project));
      return true;
    } catch { return false; }
  }
  function load(storage) {
    try {
      const project = JSON.parse((storage || root.localStorage).getItem(KEY));
      if (!project || project.version !== 1 || typeof project.midiName !== "string" || !project.midiName
        || !Number.isInteger(project.ticksPerBeat) || project.ticksPerBeat < 1 || project.ticksPerBeat > 32767
        || !Number.isFinite(project.bpm) || project.bpm < 20 || project.bpm > 300
        || !project.meter || !Number.isInteger(project.meter.numerator) || project.meter.numerator < 1 || project.meter.numerator > 255
        || ![1, 2, 4, 8, 16, 32, 64].includes(project.meter.denominator)
        || !Array.isArray(project.scale) || !project.scale.length || !project.scale.every(pitch)
        || new Set(project.scale).size !== project.scale.length
        || !Array.isArray(project.notes) || !project.notes.every(n => n && pitch(n.originalNote)
          && Number.isFinite(n.tick) && n.tick >= 0 && positive(n.duration))) return null;
      project.preset = /^(photo|range|chromatic(15|20|30)|adapt(15|20|30))$/.test(project.preset) ? project.preset : "range";
      project.barsVisible = positive(project.barsVisible) ? project.barsVisible : 4;
      project.sampleRoot = pitch(project.sampleRoot) ? project.sampleRoot : 60;
      project.sampleToken = typeof project.sampleToken === "string" ? project.sampleToken : "";
      project.sampleName = typeof project.sampleName === "string" ? project.sampleName : "";
      project.settings = project.settings || {};
      return project;
    } catch { return null; }
  }
  function sampleTransaction(mode, operation) {
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open("musicbox-midi-lab", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("samples");
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Sample cache is blocked"));
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("samples", mode);
        let result;
        try { result = operation(transaction.objectStore("samples")); }
        catch (error) { db.close(); reject(error); return; }
        transaction.oncomplete = () => { db.close(); resolve(result.result); };
        transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }
  async function saveSample(file, token) {
    return sampleTransaction("readwrite", store => store.put({ file, token }, "current"));
  }
  async function loadSample(token) {
    const record = await sampleTransaction("readonly", store => store.get("current"));
    return record && record.token === token ? record.file : null;
  }
  const api = { KEY, save, load, saveSample, loadSample };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ProjectCache = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
