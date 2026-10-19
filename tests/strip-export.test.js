const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const StripExport = require("../web/strip-export.js");

const options = {
  notes: [
    { tick: 0, mappedNote: 60 },
    { tick: 240, mappedNote: 64, folded: true },
    { tick: 360, mappedNote: 64, repeated: true },
    { tick: 0, mappedNote: 60, duplicate: true },
    { tick: 480, mappedNote: null },
    { tick: 3840, mappedNote: 60 },
  ],
  scale: [60, 64], ticksPerBeat: 480, meter: { numerator: 4, denominator: 4 },
  totalTicks: 3960, bpm: 120, enforceRepeats: true, barsPerPage: 2,
  singlePage: false, label: pitch => `C${pitch}`,
};
const notes = pages => pages.reduce((all, page) => all.concat(page.commands.filter(c => c.type === "note")), []);
const pages = StripExport.createPages(options);
assert.strictEqual(pages.length, 2);
assert.strictEqual(notes(pages).length, 3);
assert.strictEqual(notes([pages[0]]).length, 2);
assert.strictEqual(notes([pages[1]]).length, 1);
assert.strictEqual(notes(pages).filter(n => n.folded).length, 1);
assert.strictEqual(notes(StripExport.createPages({ ...options, enforceRepeats: false })).length, 4);
assert.strictEqual(StripExport.createPages({ ...options, singlePage: true }).length, 1);
assert.strictEqual(StripExport.createPages({ ...options, barsPerPage: 0 }).length, 2);
assert.strictEqual(StripExport.createPages({ ...options, meter: { numerator: 3, denominator: 8 } }).length, 3);
const svg = StripExport.toSvg(pages[0]);
assert(svg.includes("<line ") && svg.includes('<circle ') && svg.includes('fill="black"') && svg.includes('fill="white"'));
assert(!svg.includes("background:"));
assert(!StripExport.toSvg(StripExport.createPages({ ...options, label: () => '<script>&"' })[0]).includes("<script>"));
const pdf = Buffer.from(StripExport.toPdf(pages));
assert.strictEqual(pdf.slice(0, 8).toString(), "%PDF-1.4");
assert(pdf.toString().includes("/Count 2"));
// Cross-reference offsets must identify the actual object starts.
const raw = pdf.toString("ascii");
const xrefOffset = Number(raw.match(/startxref\n(\d+)/)[1]);
assert.strictEqual(raw.slice(xrefOffset, xrefOffset + 4), "xref");
const offsets = raw.slice(xrefOffset).split("\n").slice(3, 10);
offsets.forEach((entry, index) => assert(raw.slice(Number(entry.slice(0, 10))).startsWith(`${index + 1} 0 obj`)));
console.log("PASS vector export pagination, filtering, note styles, SVG escaping, and PDF structure");

// Exercise the actual imported arrangement, not a second implementation of mapping.
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
let downloaded;
vm.runInNewContext(
  source.slice(source.indexOf("function exportPdf()"), source.indexOf("function printStrip()")) + "exportPdf();",
  {
    StripExport, stripPages: () => pages, stopPlayback: () => {},
    Blob: function (parts, metadata) { this.parts = parts; this.type = metadata.type; },
    baseName: () => "example", download: (blob, name) => { downloaded = { blob, name }; },
    window: { print: () => { throw new Error("Download must not open the print dialog"); } },
  },
);
assert.strictEqual(downloaded.name, "example_strip.pdf");
assert.strictEqual(downloaded.blob.type, "application/pdf");
assert.strictEqual(Buffer.from(downloaded.blob.parts[0]).slice(0, 8).toString(), "%PDF-1.4");
console.log("PASS app downloads a PDF without opening the print dialog");
const context = vm.createContext({});
vm.runInContext(source.slice(0, source.indexOf("const els ="))
  + source.slice(source.indexOf("const state ="), source.indexOf("function renderScale()")), context);
// Optionally verify a real MIDI fixture supplied on the command line.
if (process.argv[3]) {
  const midi = fs.readFileSync(path.resolve(process.argv[3]));
  context.buffer = midi.buffer.slice(midi.byteOffset, midi.byteOffset + midi.byteLength);
  const arrangement = JSON.parse(vm.runInContext(`
    const parsed = parseMidi(buffer);
    Object.assign(state, parsed);
    mapNotes();
    JSON.stringify({notes: state.notes, scale: state.scale, ticksPerBeat: state.ticksPerBeat,
      meter: state.meter, totalTicks: state.totalTicks, bpm: state.bpm});
  `, context));
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const label = pitch => names[pitch % 12] + (Math.floor(pitch / 12) - 1);
  const realOptions = { ...arrangement, label, enforceRepeats: true, barsPerPage: 2 };
  const realPages = StripExport.createPages(realOptions);
  const expected = arrangement.notes.filter(n => !n.duplicate && n.mappedNote !== null && !n.repeated).length;
  assert.strictEqual(notes(realPages).length, expected);
  assert(notes(realPages).some(n => !n.folded));
  assert(notes(realPages).some(n => n.folded));
  console.log(`PASS actual MIDI: ${expected} punches on ${realPages.length} pages`);
  if (process.argv[2]) {
    const output = path.resolve(process.argv[2]);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "strip-review.pdf"), Buffer.from(StripExport.toPdf(realPages)));
    fs.writeFileSync(path.join(output, "strip-single-page.pdf"), Buffer.from(StripExport.toPdf(StripExport.createPages({ ...realOptions, singlePage: true }))));
  }
}
