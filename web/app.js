const PHOTO_NOTES = [48, 50, 55, 57, 59, 60, 62, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 86, 88];
const PHOTO_LABELS = ["C", "D", "G", "A", "B", "C1", "D1", "E1", "F1", "F#1", "G1", "G#1", "A1", "A#1", "B1", "C2", "C#2", "D2", "D#2", "E2", "F2", "F#2", "G2", "G#2", "A2", "A#2", "B2", "C3", "D3", "E3"];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const els = Object.fromEntries(["midi-file", "sample-file", "sample-label", "sample-root", "sample-root-control", "bars-per-page", "bars-per-page-value", "single-page", "volume", "volume-value", "enforce-repeats", "preset", "range-controls", "range-low", "range-high", "scale-list", "scale-count", "voice", "sound-caption", "play", "stop", "rewind", "bpm", "song-title", "song-details", "status-text", "export-midi", "export-pdf", "print-strip", "zoom-out", "zoom-in", "zoom-value", "fit-song", "note-count", "mapping-summary", "roll-frame", "roll-scroll", "roll-content", "ruler", "lanes", "playhead", "empty-state", "toast"].map(id => [id, document.getElementById(id)]));

const state = {
  midiName: "",
  ticksPerBeat: 480,
  meter: { numerator: 4, denominator: 4 },
  bpm: 120,
  notes: [],
  scale: [...PHOTO_NOTES],
  preset: "photo",
  barsVisible: 2,
  totalTicks: 0,
  audioContext: null,
  masterGain: null,
  keepAliveOscillator: null,
  audioVoices: new Set(),
  sampleBuffer: null,
  sampleRoot: 60,
  isPlaying: false,
  playbackStartAudio: 0,
  playbackStartTick: 0,
  playbackOriginTick: 0,
  scheduledThrough: 0,
  scheduleTimer: 0,
  animationFrame: 0,
  printNode: null,
  drag: null,
  cursorDrag: null,
};

function noteName(note) {
  const pitch = NOTE_NAMES[note % 12];
  const octave = Math.floor(note / 12) - 1;
  return `${pitch}${octave}`;
}

function pitchLabel(note) {
  if (state.preset === "photo") {
    const index = PHOTO_NOTES.indexOf(note);
    if (index !== -1) return PHOTO_LABELS[index];
  }
  return noteName(note);
}

function readVar(data, cursor) {
  let value = 0;
  while (cursor.i < data.length) {
    const byte = data[cursor.i++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error("Unexpected end of MIDI variable-length value");
}

function parseMidi(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const text = (offset, count) => String.fromCharCode(...data.subarray(offset, offset + count));
  if (text(0, 4) !== "MThd") throw new Error("This file does not have a standard MIDI header");
  const headerLength = view.getUint32(4);
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI files are not supported yet");
  const ticksPerBeat = division;
  const tracks = [];
  const tempos = [];
  let meter = { numerator: 4, denominator: 4 };
  let offset = 8 + headerLength;

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (text(offset, 4) !== "MTrk") throw new Error(`MIDI track ${trackIndex + 1} is malformed`);
    const length = view.getUint32(offset + 4);
    const end = offset + 8 + length;
    const cursor = { i: offset + 8 };
    let tick = 0;
    let runningStatus = 0;
    const pending = new Map();
    const notes = [];
    while (cursor.i < end) {
      tick += readVar(data, cursor);
      let status = data[cursor.i];
      if (status & 0x80) {
        cursor.i++;
        runningStatus = status < 0xf0 ? status : runningStatus;
      } else {
        status = runningStatus;
      }
      if (status === 0xff) {
        const type = data[cursor.i++];
        const size = readVar(data, cursor);
        const start = cursor.i;
        cursor.i += size;
        if (type === 0x51 && size === 3) {
          const micros = (data[start] << 16) | (data[start + 1] << 8) | data[start + 2];
          if (micros > 0) tempos.push({ tick, bpm: 60000000 / micros });
        } else if (type === 0x58 && size >= 2 && tick === 0) {
          meter = { numerator: data[start], denominator: 2 ** data[start + 1] };
        }
        if (type === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        cursor.i += readVar(data, cursor);
        continue;
      }
      if (status >= 0xf0) throw new Error("Unsupported MIDI system event");
      const command = status & 0xf0;
      const channel = status & 0x0f;
      const first = data[cursor.i++];
      const second = command === 0xc0 || command === 0xd0 ? 0 : data[cursor.i++];
      if (command === 0x90 && second > 0) {
        const key = `${channel}:${first}`;
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push({ tick, note: first, velocity: second, channel, trackIndex });
      } else if (command === 0x80 || (command === 0x90 && second === 0)) {
        const key = `${channel}:${first}`;
        const queue = pending.get(key);
        if (queue && queue.length) {
          const onset = queue.shift();
          notes.push({ ...onset, duration: Math.max(1, tick - onset.tick), originalNote: onset.note });
        }
      }
    }
    for (const queue of pending.values()) {
      for (const onset of queue) notes.push({ ...onset, duration: Math.round(ticksPerBeat / 4), originalNote: onset.note });
    }
    tracks.push(notes);
    offset = end;
  }
  if (format > 2) throw new Error("MIDI format 2 is not supported");
  const quantize = ticksPerBeat / 4;
  const notes = tracks.flat().map(note => ({
    ...note,
    tick: Math.round(note.tick / quantize) * quantize,
  })).sort((a, b) => a.tick - b.tick || a.note - b.note);
  if (!notes.length) throw new Error("No note events found in this MIDI file");
  tempos.sort((a, b) => a.tick - b.tick);
  return { notes, ticksPerBeat, meter, bpm: (tempos.length ? tempos[0].bpm : 120) };
}

function foldNote(note, scale) {
  if (scale.includes(note)) return { note, folded: false };
  const candidates = scale.filter(candidate => (candidate - note) % 12 === 0);
  if (!candidates.length) return { note: null, folded: false };
  candidates.sort((a, b) => Math.abs(a - note) - Math.abs(b - note) || a - b);
  return { note: candidates[0], folded: true };
}

function mapNotes() {
  const seen = new Set();
  const lastTickByPitch = new Map();
  const gridStep = state.ticksPerBeat / 4;
  for (const note of state.notes) {
    const mapping = foldNote(note.originalNote, state.scale);
    note.mappedNote = mapping.note;
    note.folded = mapping.folded;
    note.duplicate = false;
    note.repeated = false;
    if (mapping.note !== null) {
      const key = `${note.tick}:${mapping.note}`;
      if (seen.has(key)) note.duplicate = true;
      seen.add(key);
    }
  }
  state.notes.sort((a, b) => a.tick - b.tick || a.originalNote - b.originalNote);
  for (const note of state.notes) {
    if (note.mappedNote === null || note.duplicate) continue;
    const previousTick = lastTickByPitch.get(note.mappedNote);
    // Each tine needs an empty grid slot between strikes, even in chords
    // and across bar boundaries. Other pitches do not reset its spacing.
    note.repeated = previousTick !== undefined && note.tick - previousTick <= gridStep;
    lastTickByPitch.set(note.mappedNote, note.tick);
  }
  state.totalTicks = state.notes.length
    ? Math.max(...state.notes.map(note => note.tick + note.duration))
    : 0;
}

function barTicks() {
  return state.ticksPerBeat * state.meter.numerator * 4 / state.meter.denominator;
}

function formatDuration(ticks) {
  const beats = ticks / state.ticksPerBeat;
  const seconds = beats * 60 / state.bpm;
  return `${Math.ceil(state.totalTicks / barTicks())} bars · ${seconds.toFixed(0)} sec · ${state.notes.length} attacks`;
}

function renderScale() {
  els["scale-list"].replaceChildren();
  const candidates = Array.from({ length: 128 }, (_, index) => index);
  for (const note of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scale-chip${state.scale.includes(note) ? " active" : ""}`;
    button.textContent = pitchLabel(note);
    button.dataset.pitch = String(note);
    button.title = `${state.scale.includes(note) ? "Remove" : "Add"} ${pitchLabel(note)} · MIDI ${note}`;
    button.disabled = !state.midiName;
    button.addEventListener("click", () => {
      stopPlayback();
      if (state.scale.includes(note)) {
        if (state.scale.length <= 1) return toast("Keep at least one active lane");
        state.scale = state.scale.filter(value => value !== note);
      } else {
        state.scale.push(note);
        state.scale.sort((a, b) => a - b);
      }
      mapNotes();
      renderAll();
    });
    els["scale-list"].append(button);
  }
  els["scale-count"].textContent = `${state.scale.length} lanes`;
  if (state.midiName && state.scale.length) {
    const low = Math.min(...state.scale);
    els["scale-list"].scrollTop = Math.max(0, Math.floor(low / 5) * 29);
  }
}

function setStatus(message, busy = false) {
  els["status-text"].textContent = message;
  els["status-text"].parentElement.classList.toggle("busy", busy);
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2500);
}

function removeNote(note, marker) {
  marker.classList.add("note-remove");
  marker.disabled = true;
  setTimeout(() => {
    state.notes = state.notes.filter(item => item !== note);
    mapNotes();
    renderAll();
  }, 105);
}

function tickAtGridX(clientX, pxPerBar, ticksPerBar) {
  const viewport = els["roll-scroll"].getBoundingClientRect();
  const maxX = Math.max(0, els["roll-content"].scrollWidth - 42);
  const x = Math.max(0, Math.min(maxX,
    clientX - viewport.left + els["roll-scroll"].scrollLeft - 42));
  const gridStep = state.ticksPerBeat / 4;
  const rawTick = x / pxPerBar * ticksPerBar;
  const maxTick = Math.ceil((maxX / pxPerBar * ticksPerBar) / gridStep) * gridStep;
  return Math.max(0, Math.min(maxTick, Math.floor(rawTick / gridStep) * gridStep));
}

function startNoteDrag(event, note, pxPerBar, ticksPerBar, marker) {
  if (event.button !== 0) return;
  marker.setPointerCapture(event.pointerId);
  state.drag = {
    note,
    marker,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    pxPerBar,
    ticksPerBar,
    moved: false,
  };
}

window.addEventListener("pointermove", event => {
  if (!state.drag) return;
  if (Math.abs(event.clientX - state.drag.startX) + Math.abs(event.clientY - state.drag.startY) > 4) {
    state.drag.moved = true;
  }
  if (state.drag.moved) {
    state.drag.marker.classList.add("dragging");
    state.drag.marker.style.transform = `translate(${event.clientX - state.drag.startX}px, ${event.clientY - state.drag.startY}px)`;
  }
});

window.addEventListener("pointerup", event => {
  const drag = state.drag;
  if (!drag) return;
  state.drag = null;
  if (!drag.moved) return;

  drag.note.tick = tickAtGridX(event.clientX, drag.pxPerBar, drag.ticksPerBar);
  const laneRows = [...els.lanes.querySelectorAll(".lane-row[data-pitch]")];
  const targetRow = laneRows.find(row => {
    const bounds = row.getBoundingClientRect();
    return event.clientY >= bounds.top && event.clientY < bounds.bottom;
  });
  if (targetRow) drag.note.originalNote = Number(targetRow.dataset.pitch);
  drag.note.justMoved = true;
  drag.marker.classList.remove("dragging");
  drag.marker.style.transform = "";
  try { drag.marker.releasePointerCapture(drag.pointerId); } catch {}
  mapNotes();
  renderAll();
});

function renderAll() {
  const loaded = Boolean(state.midiName);
  els["roll-frame"].classList.toggle("has-midi", loaded);
  const playableNotes = state.notes.filter(note => note.mappedNote !== null && !note.duplicate);
  const enforceableNotes = playableNotes.filter(note => !els["enforce-repeats"].checked || !note.repeated);
  els["empty-state"].hidden = loaded;
  els["roll-scroll"].hidden = !loaded;
  for (const id of ["preset", "voice", "bpm", "stop", "rewind", "zoom-out", "zoom-in", "fit-song", "single-page", "enforce-repeats"]) {
    els[id].disabled = !loaded;
  }
  els["bars-per-page"].disabled = !loaded || els["single-page"].checked;
  els["bars-per-page-value"].textContent = els["single-page"].checked ? "All bars" : "bars / page";
  els.play.disabled = !enforceableNotes.length;
  els["export-midi"].disabled = !enforceableNotes.length;
  els["export-pdf"].disabled = !enforceableNotes.length;
  els["print-strip"].disabled = !enforceableNotes.length;
  renderScale();
  if (!loaded) return;

  const pitches = [...state.scale].sort((a, b) => b - a);
  const rowByPitch = new Map();
  const bTicks = barTicks();
  const gridStep = state.ticksPerBeat / 4;
  const totalBars = Math.max(1, Math.ceil(state.totalTicks / bTicks));
  const visibleWidth = Math.max(800, els["roll-scroll"].clientWidth - 2);
  const pxPerBar = Math.max(190, visibleWidth / state.barsVisible);
  const slotWidth = pxPerBar * gridStep / bTicks;
  const width = Math.max(visibleWidth, totalBars * pxPerBar + 42);
  els["roll-content"].style.width = `${width}px`;
  els["ruler"].replaceChildren();
  for (let bar = 0; bar <= totalBars; bar++) {
    const mark = document.createElement("span");
    mark.className = "ruler-mark";
    mark.textContent = `BAR ${bar + 1}`;
    mark.style.left = `${42 + bar * pxPerBar}px`;
    els["ruler"].append(mark);
  }

  els.lanes.replaceChildren();
  const topOffset = 30;
  pitches.forEach((pitch, index) => {
    const row = document.createElement("div");
    row.className = "lane-row";
    row.dataset.pitch = String(pitch);
    row.style.width = `${width}px`;
    rowByPitch.set(pitch, row);
    const label = document.createElement("span");
    label.className = "lane-label";
    label.textContent = pitchLabel(pitch);
    row.append(label);
    for (let bar = 0; bar <= totalBars; bar++) {
      const line = document.createElement("i");
      line.className = "bar-line";
      line.style.left = `${42 + bar * pxPerBar}px`;
      row.append(line);
    }
    const subdivisionsPerBeat = 4;
    const totalSubdivisions = totalBars * state.meter.numerator * subdivisionsPerBeat;
    for (let subdivision = 1; subdivision < totalSubdivisions; subdivision++) {
      if (subdivision % (state.meter.numerator * subdivisionsPerBeat) === 0
        || subdivision % subdivisionsPerBeat === 0) continue;
      const line = document.createElement("i");
      line.className = "subdivision-line";
      line.style.left = `${42 + subdivision / (state.meter.numerator * subdivisionsPerBeat) * pxPerBar}px`;
      row.append(line);
    }
    for (let beat = 1; beat < totalBars * state.meter.numerator; beat++) {
      if (beat % state.meter.numerator === 0) continue;
      const line = document.createElement("i");
      line.className = "beat-line";
      line.style.left = `${42 + beat / state.meter.numerator * pxPerBar}px`;
      row.append(line);
    }
    row.addEventListener("click", event => {
      if (event.target.closest(".note, .lane-label")) return;
      const viewport = els["roll-scroll"].getBoundingClientRect();
      if (event.clientX < viewport.left + 42) return;
      const tick = tickAtGridX(event.clientX, pxPerBar, bTicks);
      if (state.notes.some(note => note.tick === tick && note.mappedNote === pitch && !note.duplicate)) return;
      state.notes.push({ tick, note: pitch, originalNote: pitch, mappedNote: pitch, velocity: 100, duration: gridStep, folded: false, channel: 0, trackIndex: 0, justAdded: true });
      mapNotes();
      renderAll();
    });
    els.lanes.append(row);
  });

  const unmappedNotes = state.notes.filter(note => note.mappedNote === null);
  if (unmappedNotes.length) {
    const illegalRow = document.createElement("div");
    illegalRow.className = "lane-row illegal-row";
    illegalRow.style.width = `${width}px`;
    const label = document.createElement("span");
    label.className = "lane-label illegal-label";
    label.textContent = "OUT";
    illegalRow.append(label);
    for (let bar = 0; bar <= totalBars; bar++) {
      const line = document.createElement("i");
      line.className = "bar-line";
      line.style.left = `${42 + bar * pxPerBar}px`;
      illegalRow.append(line);
    }
    illegalRow.addEventListener("click", event => {
      if (event.target.closest(".note, .lane-label")) return;
      const viewport = els["roll-scroll"].getBoundingClientRect();
      if (event.clientX < viewport.left + 42) return;
      const tick = tickAtGridX(event.clientX, pxPerBar, bTicks);
      const targetPitch = state.scale[state.scale.length - 1];
      state.notes.push({ tick, note: targetPitch, originalNote: targetPitch, mappedNote: targetPitch, velocity: 100, duration: gridStep, folded: false, channel: 0, trackIndex: 0, justAdded: true });
      mapNotes();
      renderAll();
    });
    for (const note of unmappedNotes) {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "note illegal-note";
      marker.title = `${noteName(note.originalNote)} · outside active range · click to remove or drag`;
      marker.className = "note out-note";
      marker.style.left = `${43 + note.tick / gridStep * slotWidth}px`;
      marker.style.width = `${Math.max(1, slotWidth - 2)}px`;
      marker.style.top = "1px";
      marker.style.height = "calc(100% - 2px)";
      marker.addEventListener("click", event => {
        event.stopPropagation();
        removeNote(note, marker);
      });
      marker.addEventListener("pointerdown", event => startNoteDrag(event, note, pxPerBar, bTicks, marker));
      if (note.justAdded || note.justMoved) {
        marker.classList.add("note-arrive");
        note.justAdded = false;
        note.justMoved = false;
      }
      illegalRow.append(marker);
    }
    els.lanes.prepend(illegalRow);
  }

  for (const note of playableNotes) {
    const noteRow = rowByPitch.get(note.mappedNote);
    if (!noteRow) continue;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `note${note.folded ? " folded" : ""}${note.repeated ? " repeat-warning" : ""}`;
    marker.title = `${noteName(note.mappedNote)}${note.folded ? ` (from ${noteName(note.originalNote)})` : ""}${note.repeated ? " · same tine needs an empty 1/16-note slot between strikes" : ""} · bar ${Math.floor(note.tick / bTicks) + 1}`;
    marker.style.left = `${43 + note.tick / gridStep * slotWidth}px`;
    marker.style.width = `${Math.max(1, slotWidth - 2)}px`;
    marker.style.top = "1px";
    marker.style.height = "calc(100% - 2px)";
    marker.addEventListener("click", event => {
      event.stopPropagation();
      removeNote(note, marker);
    });
    marker.addEventListener("pointerdown", event => startNoteDrag(event, note, pxPerBar, bTicks, marker));
    if (note.justAdded || note.justMoved) {
      marker.classList.add("note-arrive");
      note.justAdded = false;
      note.justMoved = false;
    }
    noteRow.append(marker);
  }

  els.playhead.style.height = `${els.lanes.offsetHeight}px`;
  els["note-count"].textContent = `${playableNotes.length} / ${state.notes.length} notes · ${state.scale.length} lanes`;
  els["song-title"].textContent = state.midiName;
  els["song-details"].textContent = formatDuration(state.totalTicks);
  const presetLabel = state.preset === "photo" ? "Photo strip"
    : state.preset.startsWith("chromatic") ? `Chromatic ${state.preset.replace("chromatic", "")}`
      : state.preset.startsWith("adapt") ? `MIDI-adapted ${state.preset.replace("adapt", "")}`
        : "Custom range";
  els["mapping-summary"].textContent = `${presetLabel} mapping · octave fold`;
  els["zoom-value"].textContent = `${state.barsVisible} bars`;
  updatePlayhead(state.playbackStartTick);
}

function setPreset(preset) {
  stopPlayback();
  state.preset = preset;
  els["range-controls"].hidden = preset !== "range";
  if (preset === "photo") state.scale = [...PHOTO_NOTES];
  if (preset.startsWith("chromatic")) {
    const count = Number(preset.replace("chromatic", ""));
    state.scale = Array.from({ length: count }, (_, i) => i + 48);
  }
  if (preset.startsWith("adapt")) {
    const count = Number(preset.replace("adapt", ""));
    state.scale = adaptedScale(state.notes, count);
  }
  if (preset === "range") applyRange();
  mapNotes();
  renderAll();
}

function adaptedScale(notes, laneCount) {
  const pitches = notes.map(note => note.originalNote);
  const center = (Math.min(...pitches) + Math.max(...pitches)) / 2;
  let bestLow = 0;
  let bestScore = [Infinity, Infinity, Infinity];
  for (let low = 0; low <= 128 - laneCount; low++) {
    const candidate = Array.from({ length: laneCount }, (_, index) => low + index);
    let dropped = 0;
    let foldDistance = 0;
    for (const pitch of pitches) {
      const mapping = foldNote(pitch, candidate);
      if (mapping.note === null) dropped++;
      else foldDistance += Math.abs(mapping.note - pitch);
    }
    const score = [dropped, foldDistance, Math.abs(low + (laneCount - 1) / 2 - center)];
    if (score[0] < bestScore[0]
      || (score[0] === bestScore[0] && score[1] < bestScore[1])
      || (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])) {
      bestLow = low;
      bestScore = score;
    }
  }
  const low = bestLow;
  return Array.from({ length: laneCount }, (_, index) => low + index);
}

function applyRange() {
  stopPlayback();
  const low = Math.max(0, Math.min(127, Number(els["range-low"].value) || 0));
  const high = Math.max(0, Math.min(127, Number(els["range-high"].value) || 0));
  if (low > high) return toast("Low note must not exceed high note");
  if (high - low > 47) return toast("Custom range is limited to 48 notes");
  state.scale = Array.from({ length: high - low + 1 }, (_, index) => low + index);
  mapNotes();
  renderAll();
}

function ensureAudio() {
  if (!state.audioContext) state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (!state.masterGain) {
    state.masterGain = state.audioContext.createGain();
    state.masterGain.gain.value = Number(els.volume.value) / 100;
    state.masterGain.connect(state.audioContext.destination);
  }
  if (!state.keepAliveOscillator) {
    const oscillator = state.audioContext.createOscillator();
    const silentGain = state.audioContext.createGain();
    silentGain.gain.value = 0;
    oscillator.connect(silentGain);
    silentGain.connect(state.audioContext.destination);
    oscillator.start();
    state.keepAliveOscillator = oscillator;
  }
  if (state.audioContext.state === "suspended") state.audioContext.resume();
  return state.audioContext;
}

function playVoice(note, velocity, when) {
  const context = ensureAudio();
  const output = context.createGain();
  const voiceRecord = { output, sources: new Set() };
  state.audioVoices.add(voiceRecord);
  const volume = (velocity / 127) ** 0.7 * 0.16;
  output.gain.setValueAtTime(0.0001, when);
  output.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), when + 0.008);
  output.connect(state.masterGain);

  if (els.voice.value === "sample" && state.sampleBuffer) {
    const source = context.createBufferSource();
    source.buffer = state.sampleBuffer;
    source.playbackRate.value = 2 ** ((note - state.sampleRoot) / 12);
    source.connect(output);
    voiceRecord.sources.add(source);
    source.onended = () => {
      voiceRecord.sources.delete(source);
      if (!voiceRecord.sources.size) state.audioVoices.delete(voiceRecord);
    };
    output.gain.setValueAtTime(Math.max(0.0002, volume), when + Math.min(0.5, state.sampleBuffer.duration));
    output.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(2, state.sampleBuffer.duration));
    source.start(when);
    source.stop(when + Math.min(2, state.sampleBuffer.duration));
    return;
  }

  const voice = els.voice.value;
  const partials = voice === "box" ? [[1, .5, 2.1], [2, .34, 3.2], [3.92, .2, 4.5], [6.1, .1, 6]]
    : voice === "soft" ? [[1, .9, 1.8], [2, .1, 3.4]]
      : [[1, .66, 2.8], [2.76, .24, 5.5], [5.4, .1, 8]];
  const frequency = 440 * 2 ** ((note - 69) / 12);
  for (const [ratio, level, decay] of partials) {
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency * ratio;
    partialGain.gain.value = level;
    oscillator.connect(partialGain);
    partialGain.connect(output);
    partialGain.gain.setTargetAtTime(0.0001, when + 0.01, 1 / decay);
    oscillator.start(when);
    oscillator.stop(when + 2.4);
    voiceRecord.sources.add(oscillator);
    oscillator.onended = () => {
      voiceRecord.sources.delete(oscillator);
      if (!voiceRecord.sources.size) state.audioVoices.delete(voiceRecord);
    };
  }
  output.gain.setTargetAtTime(0.0001, when + 0.01, .48);
}

function play() {
  if (!state.notes.some(note => note.mappedNote !== null && !note.duplicate
    && (!els["enforce-repeats"].checked || !note.repeated))) return;
  if (state.isPlaying) return stopPlayback();
  const context = ensureAudio();
  const current = state.playbackStartTick;
  if (current >= state.totalTicks) state.playbackStartTick = 0;
  state.playbackStartAudio = context.currentTime;
  state.playbackOriginTick = state.playbackStartTick;
  state.scheduledThrough = context.currentTime;
  state.isPlaying = true;
  els.play.classList.add("playing");
  els.play.setAttribute("aria-label", "Pause");
  els.play.title = "Pause";
  setStatus("Playing live", true);
  state.scheduleTimer = setInterval(scheduleAudio, 25);
  state.animationFrame = requestAnimationFrame(animatePlayhead);
}

function scheduleAudio() {
  if (!state.isPlaying) return;
  const context = ensureAudio();
  const now = context.currentTime;
  const startTime = state.playbackStartAudio;
  const originTick = state.playbackOriginTick;
  const secondsPerTick = 60 / state.bpm / state.ticksPerBeat;
  const horizon = now + 0.08;
  for (const note of state.notes) {
    if (note.tick < originTick || note.mappedNote === null || note.duplicate
      || (els["enforce-repeats"].checked && note.repeated)) continue;
    const when = startTime + (note.tick - originTick) * secondsPerTick;
    if (when >= state.scheduledThrough && when <= horizon) {
      playVoice(note.mappedNote, note.velocity, Math.max(when, now + 0.004));
    }
  }
  state.scheduledThrough = horizon;
  const endTime = startTime + (state.totalTicks - originTick) * secondsPerTick;
  if (now > endTime + 0.15) stopPlayback();
}

function animatePlayhead() {
  if (!state.isPlaying) return;
  const elapsed = ensureAudio().currentTime - state.playbackStartAudio;
  const tick = Math.min(state.totalTicks, state.playbackOriginTick + elapsed * state.bpm / 60 * state.ticksPerBeat);
  updatePlayhead(tick);
  state.animationFrame = requestAnimationFrame(animatePlayhead);
}

function updatePlayhead(tick) {
  const pxPerBar = Math.max(190, Math.max(800, els["roll-scroll"].clientWidth - 2) / state.barsVisible);
  const playheadX = 42 + tick / barTicks() * pxPerBar;
  els.playhead.style.left = `${playheadX}px`;
  state.playbackStartTick = tick;
  if (state.isPlaying) {
    const viewport = els["roll-scroll"];
    const followAnchor = viewport.clientWidth * 0.9;
    const viewportX = playheadX - viewport.scrollLeft;
    if (viewportX > followAnchor) {
      viewport.scrollLeft = playheadX - followAnchor;
    }
  }
}

function seekFromPointer(clientX) {
  const viewport = els["roll-scroll"].getBoundingClientRect();
  const contentX = clientX - viewport.left + els["roll-scroll"].scrollLeft - 42;
  const pxPerBar = Math.max(190, Math.max(800, els["roll-scroll"].clientWidth - 2) / state.barsVisible);
  const rawTick = contentX / pxPerBar * barTicks();
  const gridStep = state.ticksPerBeat / 4;
  const tick = Math.max(0, Math.min(state.totalTicks,
    Math.round(rawTick / gridStep) * gridStep));
  state.playbackStartTick = tick;
  updatePlayhead(tick);
}

els.playhead.addEventListener("pointerdown", event => {
  if (event.button !== 0 || !state.notes.length) return;
  state.cursorDrag = { wasPlaying: state.isPlaying };
  if (state.isPlaying) stopPlayback();
  els.playhead.setPointerCapture(event.pointerId);
  seekFromPointer(event.clientX);
  event.preventDefault();
});
els.playhead.addEventListener("pointermove", event => {
  if (!state.cursorDrag) return;
  seekFromPointer(event.clientX);
});
els.playhead.addEventListener("pointerup", event => {
  if (!state.cursorDrag) return;
  const resume = state.cursorDrag.wasPlaying;
  state.cursorDrag = null;
  if (resume) play();
});
els.playhead.addEventListener("pointercancel", () => { state.cursorDrag = null; });

function stopPlayback(reset = false) {
  if (state.scheduleTimer) clearInterval(state.scheduleTimer);
  if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
  state.scheduleTimer = 0;
  state.animationFrame = 0;
  state.isPlaying = false;
  if (state.audioContext) {
    const now = state.audioContext.currentTime;
    for (const voice of state.audioVoices) {
      voice.output.gain.cancelScheduledValues(now);
      voice.output.gain.setTargetAtTime(0.0001, now, 0.012);
      for (const source of voice.sources) {
        try { source.stop(now + 0.06); } catch {}
      }
    }
    state.audioVoices.clear();
  }
  state.playbackStartAudio = 0;
  state.scheduledThrough = 0;
  els.play.setAttribute("aria-label", "Play");
  els.play.title = "Play";
  els.play.classList.remove("playing");
  if (state.notes.length) setStatus("MIDI ready");
  if (reset) state.playbackStartTick = 0;
  updatePlayhead(state.playbackStartTick);
}

function writeVar(value) {
  let buffer = [value & 0x7f];
  while ((value >>= 7)) buffer.unshift((value & 0x7f) | 0x80);
  return buffer;
}

function exportMidi() {
  const tempo = Math.round(60000000 / state.bpm);
  const events = [[0, [0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255]]];
  events.push([0, [0xff, 0x58, 4, state.meter.numerator, Math.round(Math.log2(state.meter.denominator)), 24, 8]]);
  for (const note of state.notes) {
    if (note.mappedNote === null || note.duplicate
      || (els["enforce-repeats"].checked && note.repeated)) continue;
    const channel = (note.channel || 0) & 0x0f;
    events.push([note.tick, [0x90 | channel, note.mappedNote, note.velocity || 90]]);
    events.push([note.tick + note.duration, [0x80 | channel, note.mappedNote, 0]]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1][0] - b[1][0]);
  const track = [];
  let previous = 0;
  for (const [tick, bytes] of events) {
    track.push(...writeVar(Math.max(0, tick - previous)), ...bytes);
    previous = tick;
  }
  track.push(0, 0xff, 0x2f, 0);
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (state.ticksPerBeat >> 8) & 255, state.ticksPerBeat & 255];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 255, (track.length >>> 16) & 255, (track.length >>> 8) & 255, track.length & 255];
  download(new Blob([new Uint8Array([...header, ...trackHeader, ...track])], { type: "audio/midi" }), `${baseName()}_edited.mid`);
}

function baseName() {
  return state.midiName.replace(/\.(midi?|MIDI?)$/, "") || "musicbox";
}

function download(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function stripPages() {
  return StripExport.createPages({
    notes: state.notes, scale: state.scale, ticksPerBeat: state.ticksPerBeat,
    meter: state.meter, totalTicks: state.totalTicks, bpm: state.bpm,
    enforceRepeats: els["enforce-repeats"].checked,
    singlePage: els["single-page"].checked,
    barsPerPage: Number(els["bars-per-page"].value), label: pitchLabel,
  });
}

function exportPdf() {
  stopPlayback();
  download(new Blob([StripExport.toPdf(stripPages())], { type: "application/pdf" }), `${baseName()}_strip.pdf`);
}

function printStrip() {
  stopPlayback();
  if (state.printCleanup) state.printCleanup();
  const pages = document.createElement("div");
  pages.className = "print-pages";
  for (const drawing of stripPages()) {
    const page = document.createElement("section");
    page.className = "print-page";
    page.innerHTML = StripExport.toSvg(drawing);
    pages.append(page);
  }
  state.printNode = pages;
  document.body.append(pages);
  document.body.classList.add("printing");
  const cleanup = () => {
    document.body.classList.remove("printing");
    pages.remove();
    state.printNode = null;
    state.printCleanup = null;
    window.removeEventListener("afterprint", cleanup);
  };
  state.printCleanup = cleanup;
  window.addEventListener("afterprint", cleanup);
  window.print();
}

function updateMeterAndBpm(parsed) {
  state.ticksPerBeat = parsed.ticksPerBeat;
  state.meter = parsed.meter;
  state.bpm = Math.round(parsed.bpm);
  els.bpm.value = String(state.bpm);
}

function importMidi(file) {
  if (!file) return;
  stopPlayback(true);
  setStatus("Reading MIDI…", true);
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseMidi(reader.result);
      state.midiName = file.name;
      state.notes = parsed.notes;
      updateMeterAndBpm(parsed);
      state.preset = "adapt30";
      state.scale = adaptedScale(state.notes, 30);
      els.preset.value = "adapt30";
      els["range-controls"].hidden = true;
      els["empty-state"].hidden = true;
      els["roll-scroll"].hidden = false;
      mapNotes();
      renderAll();
      setStatus("MIDI ready");
    } catch (error) {
      setStatus("Import failed");
      toast(error.message || "Could not read this MIDI file");
    }
  };
  reader.onerror = () => { setStatus("Import failed"); toast("Could not read the selected MIDI file"); };
  reader.readAsArrayBuffer(file);
}

els["midi-file"].addEventListener("change", event => importMidi(event.target.files[0]));
els.preset.addEventListener("change", () => setPreset(els.preset.value));
els["range-low"].addEventListener("change", applyRange);
els["range-high"].addEventListener("change", applyRange);
els.play.addEventListener("click", play);
els.stop.addEventListener("click", () => stopPlayback(true));
els.rewind.addEventListener("click", () => { stopPlayback(true); els["roll-scroll"].scrollLeft = 0; renderAll(); });
els["export-midi"].addEventListener("click", exportMidi);
els["export-pdf"].addEventListener("click", exportPdf);
els["print-strip"].addEventListener("click", printStrip);
els["bars-per-page"].addEventListener("change", () => {
  let bars = Number(els["bars-per-page"].value);
  bars = Math.max(1, Math.min(9, Math.round(bars || 1)));
  els["bars-per-page"].value = String(bars);
  els["bars-per-page-value"].textContent = bars === 1 ? "bar / page" : "bars / page";
});
els["bars-per-page"].addEventListener("wheel", event => {
  if (els["bars-per-page"].disabled) return;
  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  els["bars-per-page"].value = String(Math.max(1, Math.min(9, Number(els["bars-per-page"].value) + direction)));
  els["bars-per-page"].dispatchEvent(new Event("change", { bubbles: true }));
}, { passive: false });
els["single-page"].addEventListener("change", () => {
  els["bars-per-page"].disabled = els["single-page"].checked || !state.midiName;
  els["bars-per-page-value"].textContent = els["single-page"].checked ? "All bars" : "bars / page";
});
els["enforce-repeats"].addEventListener("change", () => {
  stopPlayback();
  renderAll();
});
els["zoom-in"].addEventListener("click", () => { state.barsVisible = Math.max(1, state.barsVisible - 1); renderAll(); });
els["zoom-out"].addEventListener("click", () => { state.barsVisible = Math.min(16, state.barsVisible + 1); renderAll(); });
els["fit-song"].addEventListener("click", () => { state.barsVisible = Math.max(1, Math.ceil(state.totalTicks / barTicks())); renderAll(); });
els.bpm.addEventListener("change", () => {
  stopPlayback();
  const bpm = Number(els.bpm.value);
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
    els.bpm.value = String(state.bpm);
    return toast("Choose a BPM between 20 and 300");
  }
  state.bpm = bpm;
  renderAll();
});
els.bpm.addEventListener("wheel", event => {
  if (els.bpm.disabled) return;
  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  stopPlayback();
  state.bpm = Math.max(20, Math.min(300, Number(els.bpm.value) + direction));
  els.bpm.value = String(state.bpm);
  renderAll();
}, { passive: false });
els.volume.addEventListener("input", () => {
  const volume = Number(els.volume.value);
  els["volume-value"].textContent = `${volume}%`;
  if (state.masterGain && state.audioContext) {
    state.masterGain.gain.setTargetAtTime(volume / 100, state.audioContext.currentTime, 0.015);
  }
});
els.voice.addEventListener("change", () => {
  const sample = els.voice.value === "sample";
  els["sample-label"].hidden = !sample;
  els["sample-root-control"].hidden = !sample;
  els["sound-caption"].textContent = sample ? (state.sampleBuffer ? "User sample loaded · playback-rate pitch shift" : "Choose an audio file to use as the instrument sample") : ({ tine: "Three tuned partials · short natural decay", box: "Bright inharmonic harmonics · longer decay", soft: "Pure sine tone · gentle decay" })[els.voice.value];
});
els["sample-file"].addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const context = ensureAudio();
    state.sampleBuffer = await context.decodeAudioData(await file.arrayBuffer());
    els["sound-caption"].textContent = `${file.name} · pitch follows mapped note`;
    toast("Instrument sample loaded");
  } catch {
    toast("Could not decode that audio file");
  }
});
els["sample-root"].addEventListener("change", () => {
  state.sampleRoot = Math.max(0, Math.min(127, Number(els["sample-root"].value) || 60));
  els["sample-root"].value = String(state.sampleRoot);
});
document.addEventListener("keydown", event => {
  if (event.code !== "Space" || event.target.matches("input, select, button, textarea")) return;
  event.preventDefault();
  if (!els.play.disabled) play();
});
window.addEventListener("resize", () => { if (state.notes.length) renderAll(); });
renderAll();
