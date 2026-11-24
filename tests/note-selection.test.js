const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const listeners = {};
const timers = [];
const element = () => ({
  style: {}, listeners: {}, classes: new Set(),
  classList: {
    toggle() {}, add() {}, remove() {},
  },
  addEventListener(type, fn) { this.listeners[type] = fn; },
  setAttribute() {}, setPointerCapture() {}, releasePointerCapture() {},
  append() {}, remove() {},
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 100, height: 20 }; },
});
const lanes = element();
const els = { lanes, "roll-scroll": { ...element(), scrollLeft: 0, scrollTop: 0 } };
const context = vm.createContext({
  els, setTimeout: fn => timers.push(fn),
  document: { addEventListener(type, fn) { listeners[`document:${type}`] = fn; }, createElement: element },
  window: { addEventListener(type, fn) { listeners[type] = fn; } },
  renderAll() {},
});
const run = script => vm.runInContext(script, context);
run(source.slice(0, source.indexOf("const els ="))
  + source.slice(source.indexOf("const state ="), source.indexOf("function renderScale()")));
run(source.slice(source.indexOf("function refreshSelection()"), source.indexOf("function renderAll()")));
run(source.slice(source.indexOf('document.addEventListener("keydown"'), source.indexOf('window.addEventListener("resize"')));
function setup() {
  run(`state.midiName='test.mid'; state.ticksPerBeat=480; state.scale=[60,62,64,65];
    state.notes=[{tick:120,originalNote:60,duration:90,velocity:80,channel:2,trackIndex:1},
      {tick:360,originalNote:64,duration:240,velocity:100,channel:3,trackIndex:2},
      {tick:720,originalNote:62,duration:120,velocity:90}];
    state.selection=new Set(state.notes.slice(0,2)); mapNotes();`);
}
function key(key, ctrlKey = false, editing = false) {
  let prevented = false;
  listeners["document:keydown"]({ key, ctrlKey, target: { closest: () => editing, matches: () => false },
    preventDefault() { prevented = true; } });
  return prevented;
}
setup();
assert(key("ArrowRight"));
assert.strictEqual(run("state.notes[0].tick"), 720); // Unselected note stays put despite sorting.
assert.strictEqual(run("[...state.selection][0].tick"), 2040);
assert.strictEqual(run("[...state.selection][1].tick"), 2280);
key("ArrowLeft");
key("ArrowLeft");
assert.strictEqual(run("[...state.selection][0].tick"), 0);
assert.strictEqual(run("[...state.selection][1].tick"), 240);
key("ArrowDown");
assert.strictEqual(run("[...state.selection][1].mappedNote"), 64); // Bottom edge clamps the entire group.
key("ArrowUp");
assert.strictEqual(run("[...state.selection][0].mappedNote"), 62);
assert.strictEqual(run("[...state.selection][1].mappedNote"), 65);
key("ArrowUp");
assert.strictEqual(run("[...state.selection][0].mappedNote"), 62);
assert(!key("a", true, true));
assert.strictEqual(run("state.selection.size"), 2);
console.log("PASS whole-note keyboard moves, shared time/lane boundary clamping, and editable-field shortcut isolation");

setup();
key("c", true);
for (const [cursor, expected] of [[299, 240], [300, 240], [301, 360]]) {
  context.cursor = cursor;
  run("state.playbackStartTick=cursor");
  key("v", true);
  assert.strictEqual(run("[...state.selection][0].tick"), expected);
  assert.strictEqual(run("[...state.selection][1].tick"), expected + 240);
  assert.strictEqual(run("[...state.selection][0].velocity"), 80);
  assert.strictEqual(run("[...state.selection][1].duration"), 240);
}
key("x", true);
assert.strictEqual(run("state.selection.size"), 0);
key("v", true);
assert.strictEqual(run("state.selection.size"), 2);
key("a", true);
assert.strictEqual(run("state.selection.size"), run("state.notes.length"));
key("Delete");
assert.strictEqual(run("state.notes.length"), 0);
run("state.playbackStartTick=0; state.ticksPerBeat=960;");
key("v", true);
assert.strictEqual(run("state.notes[1].tick"), 480);
assert.strictEqual(run("state.notes[1].duration"), 480);
console.log("PASS copy/cut/select-all/delete, independent repeated pastes, halfway snapping, metadata, and MIDI resolution scaling");

setup();
const marker = element();
marker.parentElement = element();
context.marker = marker;
run("state.noteMarkers = new Map(state.notes.map(note => [note, marker]));");
const pointer = (x, y, extra = {}) => ({ button: 0, pointerId: 1, clientX: x, clientY: y,
  stopPropagation() {}, target: { closest() { return false; } }, ...extra });
context.event = pointer(100, 20);
run("startNoteDrag(event, state.notes[0], 192, 1920, marker)");
listeners.pointermove(pointer(124, 20));
listeners.pointerup(pointer(124, 20));
assert.strictEqual(run("[...state.selection][0].tick"), 360);
assert.strictEqual(run("[...state.selection][1].tick"), 600);
assert.strictEqual(run("state.notes.length"), 3);
assert(run("state.suppressClick"));
let suppressed = false;
listeners["document:click"]({ preventDefault() {}, stopImmediatePropagation() { suppressed = true; } });
assert(suppressed);
timers.splice(0).forEach(fn => fn());
context.event = pointer(100, 20, { ctrlKey: true, shiftKey: true });
run("startNoteDrag(event, [...state.selection][0], 192, 1920, marker)");
assert.strictEqual(run("state.selection.size"), 1);
assert.strictEqual(run("state.drag"), null);
console.log("PASS dragging selected groups preserves offsets, suppresses release-click edits, and Ctrl+Shift-click subtracts");

setup();
const markers = [element(), element(), element()];
markers.forEach((m, i) => {
  m.getBoundingClientRect = () => ({ left: 100+i*100, right: 110+i*100, top: 20, bottom: 40 });
});
context.markers = markers;
run("state.noteMarkers = new Map(state.notes.map((note, index) => [note, markers[index]])); state.selection.clear();");
function box(extra = {}, reverse = false) {
  lanes.listeners.pointerdown(pointer(reverse ? 220 : 90, reverse ? 50 : 10, extra));
  listeners.pointermove(pointer(reverse ? 90 : 220, reverse ? 10 : 50, extra));
  listeners.pointerup(pointer(reverse ? 90 : 220, reverse ? 10 : 50, extra));
}
box({}, true);
assert.strictEqual(run("state.selection.size"), 2);
run("state.selection=new Set([state.notes[2]])");
box({shiftKey:true});
assert.strictEqual(run("state.selection.size"), 3);
box({ctrlKey:true, shiftKey:true});
assert.strictEqual(run("state.selection.size"), 1);
assert(run("state.selection.has(state.notes[2])"));
lanes.listeners.pointerdown(pointer(90, 10));
listeners.pointermove(pointer(220, 50));
listeners.pointercancel(pointer(220, 50));
assert.strictEqual(run("state.selection.size"), 1);
assert(run("state.selection.has(state.notes[2])"));
run("state.notes=[]; mapNotes()");
assert.strictEqual(run("state.selection.size"), 0);
console.log("PASS reverse box selection, Shift add, Ctrl+Shift subtract, pointer cancellation, and stale selection cleanup");
