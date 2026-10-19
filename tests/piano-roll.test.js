const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const core = source.slice(0, source.indexOf("const els ="))
  + source.slice(source.indexOf("const state ="), source.indexOf("function renderScale()"));
const context = vm.createContext({});
vm.runInContext(core, context);
const run = script => vm.runInContext(script, context);
run("state.scale = [60]; state.midiName = 'test.mid';");
function checkLength(ticks, bars, loopBars) {
  context.ticks = ticks;
  run("state.notes = ticks.map(tick => ({tick, originalNote: 60, duration: 120})); mapNotes();");
  assert.strictEqual(run("state.editorBars"), bars);
  assert.strictEqual(run("state.loopTicks / barTicks()"), loopBars);
}
checkLength([], 4, 1);
checkLength([0], 4, 1);
checkLength([3840], 4, 3);
checkLength([5760], 6, 4);
checkLength([7680], 6, 5);
checkLength([9600], 8, 6);
checkLength([13440], 10, 8);
checkLength([0, 5760], 6, 4);
checkLength([0], 4, 1);
checkLength([], 4, 1);
run("state.meter = { numerator: 3, denominator: 8 }; state.notes = [{tick: 2160, originalNote: 60, duration: 9000}]; mapNotes();");
assert.strictEqual(run("state.editorBars"), 6);
assert.strictEqual(run("state.loopTicks"), 2880);
console.log("PASS 4-bar minimum, two-bar growth/shrink, onset-based loops, and non-4/4 meters");

const voices = [];
const clock = { currentTime: 10 };
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    value: "", checked: true, scrollLeft: 0, scrollTop: 0, listeners: {}, classes: new Set(),
    classList: { add(name) { element(id).classes.add(name); }, remove(name) { element(id).classes.delete(name); } },
    addEventListener(type, listener) { this.listeners[type] = listener; },
  });
  return elements.get(id);
};
context.els = new Proxy({}, { get: (_, id) => element(id) });
context.ensureAudio = () => clock;
context.playVoice = (pitch, velocity, when) => voices.push({ pitch, when });
context.updatePlayhead = tick => { context.lastPlayhead = tick; };
context.requestAnimationFrame = () => 1;
run(source.slice(source.indexOf("function scheduleAudio()"), source.indexOf("function updatePlayhead(")));
run(`state.meter = {numerator:4, denominator:4}; state.bpm=120;
  state.notes=[{tick:0,mappedNote:60,velocity:90},{tick:1800,mappedNote:64,velocity:90}];
  state.isPlaying=true; state.loopTicks=1920; state.playbackOriginTick=0;
  state.playbackStartAudio=10; state.scheduledThrough=10; scheduleAudio();`);
assert.strictEqual(voices.length, 1);
clock.currentTime = 11.84; run("scheduleAudio();");
assert.strictEqual(voices[1].when, 11.875);
clock.currentTime = 11.96; run("scheduleAudio(); scheduleAudio();");
assert.strictEqual(voices.length, 3);
assert.strictEqual(voices[2].when, 12);
clock.currentTime = 12.25; run("animatePlayhead();");
assert.strictEqual(context.lastPlayhead, 240);
voices.length = 0;
clock.currentTime = 20;
run("state.playbackStartAudio=20; state.playbackOriginTick=960; state.scheduledThrough=20; scheduleAudio();");
assert.strictEqual(voices.length, 0);
clock.currentTime = 20.84; run("scheduleAudio();");
assert.strictEqual(voices[0].when, 20.875);
clock.currentTime = 20.96; run("scheduleAudio();");
assert.strictEqual(voices[1].when, 21);
voices.length = 0;
clock.currentTime = 120;
run("scheduleAudio();");
assert(voices.length <= 1, "A delayed timer must not replay missed loops in a burst");
console.log("PASS seamless scheduling across loop boundary, no duplicate attacks, seek, and playhead wrap");

const readers = [];
const imports = [];
const messages = [];
context.FileReader = function () {
  readers.push(this);
  this.readAsArrayBuffer = file => imports.push(file.name);
};
context.stopPlayback = reset => run(`state.isPlaying=false; ${reset ? "state.playbackStartTick=0;" : ""}`);
context.renderAll = () => {};
context.setStatus = () => {};
context.toast = message => messages.push(message);
context.window = { addEventListener() {} };
context.adaptedScale = () => [60, 64];
run(source.slice(source.indexOf("function updateMeterAndBpm("), source.indexOf('els.preset.addEventListener("change"')));
run("resetRoll(true);");
assert.strictEqual(run("state.midiName"), "Untitled.mid");
assert.strictEqual(run("state.editorBars"), 4);
assert.strictEqual(run("state.barsVisible"), 4);
assert.strictEqual(run("state.notes.length"), 0);
function drop(name) {
  let prevented = false;
  const file = { name };
  element("roll-frame").listeners.drop({
    dataTransfer: { types: ["Files"], files: [file] },
    preventDefault() { prevented = true; },
  });
  assert(prevented);
}
drop("song.MIDI");
assert.strictEqual(imports[0], "song.MIDI");
// A file finishing after New/Clear must not restore the discarded arrangement.
run("resetRoll(true);");
readers[0].onload();
assert.strictEqual(run("state.midiName"), "Untitled.mid");
assert.strictEqual(run("state.notes.length"), 0);
drop("not-midi.txt");
assert.strictEqual(imports.length, 1);
assert.strictEqual(messages.length, 1);
run("state.notes=[{tick:9600,originalNote:60,duration:120}]; mapNotes();");
drop("replacement.mid");
assert.strictEqual(imports[1], "replacement.mid");
run("resetRoll();");
assert.strictEqual(run("state.editorBars"), 4);
assert.strictEqual(run("state.notes.length"), 0);
// File picker remains wired to the same importer and resets for same-file reloads.
const input = { files: [{name: "picker.mid"}], value: "picker.mid" };
element("midi-file").listeners.change({target: input});
assert.strictEqual(imports[2], "picker.mid");
assert.strictEqual(input.value, "");
console.log("PASS dropping onto empty/filled rolls, validation, Clear/New, stale loads, and file picker");
