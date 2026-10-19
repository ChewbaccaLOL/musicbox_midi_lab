const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const cache = require("../web/project-cache.js");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const core = source.slice(0, source.indexOf("const els ="))
  + source.slice(source.indexOf("const state ="), source.indexOf("function renderScale()"));
const stored = new Map();
const storage = { setItem: (k, v) => stored.set(k, v), getItem: k => stored.get(k) || null,
  removeItem: k => stored.delete(k) };
const elements = new Map();
const els = new Proxy({}, { get: (_, key) => {
  if (!elements.has(key)) elements.set(key, {value: "", checked: false});
  return elements.get(key);
}});
let downloaded;
const context = vm.createContext({
  els, ProjectCache: { save: (s, o) => cache.save(s, o, storage), load: () => cache.load(storage),
    clear: () => cache.clear(storage) },
  setStatus() {}, toast() {}, renderAll() {},
  Blob: function (parts, options) { this.parts = parts; this.type = options.type; },
  download: (blob, name) => { downloaded = { blob, name }; },
});
const run = script => vm.runInContext(script, context);
run(core);
run(`state.midiName="edited.mid"; state.bpm=93; state.scale=[60,64]; state.preset="range";
  state.barsVisible=6; state.sampleRoot=48;
  state.notes=[{tick:0,originalNote:60,duration:120,velocity:90,channel:9},
    {tick:240,originalNote:64,duration:120,velocity:80,channel:3}]; mapNotes();`);
els.voice.value = "box"; els.volume.value = "55";
els["bars-per-page"].value = "3"; els["single-page"].checked = true;
els["enforce-repeats"].checked = true;
run("saveProject();");
const snapshot = cache.load(storage);
assert.strictEqual(snapshot.bpm, 93);
assert.strictEqual(snapshot.notes.length, 2);
assert.strictEqual(snapshot.settings.voice, "box");
assert(!Object.prototype.hasOwnProperty.call(snapshot.notes[0], "repeated"));
// Reload the actual app restore function after changing in-memory state/controls.
run("state.notes=[]; state.bpm=120; state.scale=[48];"); els.voice.value = "soft";
run("restoreProject();");
assert.strictEqual(run("state.notes.length"), 2);
assert.strictEqual(run("state.bpm"), 93);
assert.strictEqual(run("state.notes[1].mappedNote"), 64);
assert.strictEqual(els.voice.value, "box");
assert.strictEqual(els.volume.value, "55");
assert.strictEqual(els["bars-per-page"].value, "3");
assert.strictEqual(els["sample-root"].value, "48");
assert.strictEqual(els["single-page"].checked, true);
assert.strictEqual(run("state.isPlaying"), false);
run("state.notes=[]; mapNotes(); saveProject(); restoreProject();");
assert.strictEqual(run("state.notes.length"), 0);
assert.strictEqual(run("state.editorBars"), 4);
for (const invalid of ["not JSON", "null", JSON.stringify({...snapshot, version:99}),
  JSON.stringify({...snapshot, bpm:0}), JSON.stringify({...snapshot, notes:[{tick:-1, originalNote:60, duration:120}]})]) {
  storage.setItem(cache.KEY, invalid);
  assert.strictEqual(cache.load(storage), null);
}
const unavailable = { getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Full"); } };
assert.strictEqual(cache.load(unavailable), null);
assert.strictEqual(cache.save(snapshot, {}, unavailable), false);
console.log("PASS reload restores edited roll/settings; cleared roll stays empty; corrupt/blocked storage is safe");

cache.save(snapshot, snapshot.settings, storage);
run("restoreProject();");
context.stopPlayback = () => run("state.isPlaying=false; state.playbackStartTick=0;");
run(source.slice(source.indexOf("function unloadRoll()"), source.indexOf("function resetRoll(")));
const revision = run("state.importRevision");
run("state.isPlaying=true; unloadRoll(); saveProject(); restoreProject();");
assert.strictEqual(run("state.midiName"), "");
assert.strictEqual(run("state.notes.length"), 0);
assert.strictEqual(run("state.isPlaying"), false);
assert.strictEqual(run("state.importRevision"), revision + 1);
assert.strictEqual(cache.load(storage), null);
assert.strictEqual(els["midi-file"].value, "");
assert.strictEqual(els["roll-scroll"].scrollLeft, 0);
console.log("PASS Unload cancels playback/imports and removes the saved roll across reloads");
cache.save(snapshot, snapshot.settings, storage);
run("restoreProject();");

run(source.slice(source.indexOf("function writeVar("), source.indexOf("function encodeWav(")));
run(`state.notes=[{tick:0,originalNote:60,duration:120,velocity:90,channel:9},
  {tick:240,originalNote:64,duration:120,velocity:80,channel:3},
  {tick:360,originalNote:64,duration:120,velocity:80,channel:3}]; mapNotes(); exportMidi();`);
let midi = Buffer.from(downloaded.blob.parts[0]);
assert.strictEqual(downloaded.name, "edited_edited.mid");
assert.strictEqual(midi[22], 0);
assert.strictEqual(midi[23], 0xc0, "Instrument must precede the first note-on");
assert.strictEqual(midi[24], 10, "Music box program is zero-based 10");
context.midiBuffer = midi.buffer.slice(midi.byteOffset, midi.byteOffset + midi.byteLength);
assert(Math.abs(run("parseMidi(midiBuffer).bpm") - 93) < 0.001);
assert.strictEqual(run("parseMidi(midiBuffer).notes.length"), 2);
assert.strictEqual(run("parseMidi(midiBuffer).notes[0].channel"), 0, "Imported drum channels become pitched notes");
els.voice.value="tine"; run("exportMidi();");
assert.strictEqual(Buffer.from(downloaded.blob.parts[0])[24], 108);
els.voice.value="soft"; run("exportMidi();");
assert.strictEqual(Buffer.from(downloaded.blob.parts[0])[24], 73);
console.log("PASS MIDI BPM, repeat filtering, instrument-before-note order, pitched channels, and voice programs");

run(source.slice(source.indexOf("function encodeWav("), source.indexOf("function download(")));
const waveBuffer = { numberOfChannels:2, length:3, sampleRate:44100,
  getChannelData: ch => ch ? new Float32Array([-1,0,2]) : new Float32Array([1,0.5,-2]) };
context.waveBuffer = waveBuffer;
const wav = Buffer.from(run("encodeWav(waveBuffer)"));
assert.strictEqual(wav.toString("ascii",0,4), "RIFF");
assert.strictEqual(wav.toString("ascii",8,12), "WAVE");
assert.strictEqual(wav.length,56);
assert.strictEqual(wav.readUInt32LE(4),48);
assert.strictEqual(wav.readUInt32LE(24),44100);
assert.strictEqual(wav.readUInt16LE(22),2);
assert.deepStrictEqual([44,46,48,50,52,54].map(offset=>wav.readInt16LE(offset)),[32767,-32768,16384,0,-32768,32767]);
console.log("PASS PCM WAV header, channel interleaving, sample rate, and clipping");

async function main() {
  // Mock only audio devices; execute the actual shared synthesis and export paths.
  let graph=[];
  const param=()=>({value:0,setValueAtTime:(...a)=>graph.push(["set",...a]),
    exponentialRampToValueAtTime:(...a)=>graph.push(["ramp",...a]),setTargetAtTime:(...a)=>graph.push(["target",...a])});
  const node=()=>({gain:param(),frequency:param(),playbackRate:param(),connect(){},
    start:(...a)=>graph.push(["start",...a]),stop:(...a)=>graph.push(["stop",...a])});
  const device=()=>({createGain:node,createOscillator:node,createBufferSource:node});
  context.ensureAudio=()=>device();
  run(source.slice(source.indexOf("function playVoice("), source.indexOf("function play()")));
  for(const voice of ["tine","box","soft","sample"]) {
    els.voice.value=voice;
    run("state.sampleBuffer={duration:1.5}; state.masterGain={};");
    graph=[]; run("playVoice(60,100,0);"); const live=JSON.stringify(graph);
    context.offline=device(); graph=[];
    run("playVoice(60,100,0,offline,{},false);");
    assert.strictEqual(JSON.stringify(graph),live,`${voice} must share the live audio synthesis`);
    run("state.audioVoices.clear();");
  }
  let offlineConfig;
  context.window={OfflineAudioContext:function(channels,length,rate){
    offlineConfig={channels,length,rate}; Object.assign(this,device());
    this.destination={}; this.startRendering=async()=>waveBuffer;
  }};
  els.voice.value="box";
  await run("exportAudio();");
  assert.strictEqual(downloaded.name,"edited_musicbox.wav");
  assert.strictEqual(downloaded.blob.type,"audio/wav");
  assert.strictEqual(Buffer.from(downloaded.blob.parts[0]).toString("ascii",0,4),"RIFF");
  assert.strictEqual(offlineConfig.channels,2);
  assert.strictEqual(offlineConfig.rate,44100);
  assert.strictEqual(run("state.exportingAudio"),false);
  assert.strictEqual(run("state.audioVoices.size"),0);
  console.log("PASS WAV export uses live synthesis for every voice/sample without joining the live player");

  // Exercise the IndexedDB wrapper with asynchronous requests/transactions.
  let record;
  const sampleContext=vm.createContext({ indexedDB:{open(){
    const request={};
    const db={createObjectStore(){},close(){},transaction(){
      const tx={objectStore:()=>({
        put(value){record=value;const result={result:"current"};setImmediate(()=>tx.oncomplete());return result;},
        get(){const result={result:record};setImmediate(()=>tx.oncomplete());return result;},
      })};return tx;
    }};
    request.result=db;
    setImmediate(()=>{request.onupgradeneeded();request.onsuccess();});
    return request;
  }}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../web/project-cache.js"),"utf8"),sampleContext);
  const file={name:"custom.wav",data:new Uint8Array([1,2,3])};
  await sampleContext.ProjectCache.saveSample(file,"current-token");
  assert.strictEqual(await sampleContext.ProjectCache.loadSample("current-token"),file);
  assert.strictEqual(await sampleContext.ProjectCache.loadSample("old-token"),null);
  console.log("PASS custom sample cache round-trip and stale sample token rejection");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
