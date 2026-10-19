const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Load the actual MIDI mapping logic without initializing the browser UI.
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(
  source.slice(0, source.indexOf("const els ="))
    + source.slice(source.indexOf("const state ="), source.indexOf("function renderScale()")),
  context,
);

function check(name, notes, expected, options = {}) {
  context.input = { notes, ...options };
  const actual = vm.runInContext(`
    state.ticksPerBeat = input.ticksPerBeat || 480;
    state.scale = input.scale || [60, 64, 67];
    state.notes = input.notes.map(([tick, originalNote]) => ({
      tick, originalNote, duration: 120,
    }));
    mapNotes();
    JSON.stringify(state.notes.filter(n => n.repeated).map(n => [n.tick, n.mappedNote]));
  `, context);
  assert.deepStrictEqual(JSON.parse(actual), expected, name);
  console.log(`PASS ${name}`);
}

check("adjacent slots flag the later strike", [[0, 60], [120, 60]], [[120, 60]]);
check("an empty slot allows the next strike", [[0, 60], [240, 60]], []);
check("a long silence does not flag a repeat", [[0, 60], [3840, 60]], []);
check("other pitches do not hide adjacent repeats", [[0, 60], [0, 64], [120, 60]], [[120, 60]]);
check("every tine in consecutive chords is checked", [[0, 60], [0, 64], [120, 60], [120, 64]], [[120, 60], [120, 64]]);
check("adjacent slots across a bar boundary", [[1800, 60], [1920, 60]], [[1920, 60]]);
check("an empty slot across a bar boundary", [[1680, 60], [1920, 60]], []);
check("runs flag each adjacent strike", [[0, 60], [120, 60], [240, 60], [480, 60]], [[120, 60], [240, 60]]);
check("folded notes share the physical tine", [[0, 48], [120, 60]], [[120, 60]]);
check("unmapped notes do not interfere", [[0, 60], [60, 61], [120, 60]], [[120, 60]]);
check("duplicate attacks do not become repeats", [[0, 60], [0, 60], [240, 60]], []);
check("unsorted edited notes are checked chronologically", [[240, 60], [0, 60], [120, 60]], [[120, 60], [240, 60]]);
check("spacing follows MIDI tick resolution", [[0, 60], [240, 60], [720, 60]], [[240, 60]], { ticksPerBeat: 960 });
check("off-grid strikes closer than one slot are flagged", [[0, 60], [60, 60]], [[60, 60]]);

// Re-check the same notes after edits and scale changes to catch stale flags.
vm.runInContext(`
  state.ticksPerBeat = 480;
  state.scale = [60];
  state.notes = [{tick: 0, originalNote: 48, duration: 120}, {tick: 120, originalNote: 60, duration: 120}];
  mapNotes();
`, context);
assert.strictEqual(vm.runInContext("state.notes[1].repeated", context), true);
vm.runInContext("state.scale = [48, 60]; mapNotes();", context);
assert.strictEqual(vm.runInContext("state.notes[1].repeated", context), false);
vm.runInContext("state.notes[0].originalNote = 60; mapNotes();", context);
assert.strictEqual(vm.runInContext("state.notes[1].repeated", context), true);
vm.runInContext("state.notes[1].tick = 240; mapNotes();", context);
assert.strictEqual(vm.runInContext("state.notes[1].repeated", context), false);
console.log("PASS edits and scale changes recompute warnings");
