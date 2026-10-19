/* Shared vector drawing for downloadable PDFs and browser printing. No network dependencies. */
(function (root) {
  "use strict";
  const WIDTH = 841.89, HEIGHT = 595.28; // A4 landscape, points
  const clean = value => String(value).replace(/[^\x20-\x7e]/g, "?");
  const number = value => Number(value.toFixed(3));

  function createPages(options) {
    const { notes, scale, ticksPerBeat, meter, totalTicks, enforceRepeats } = options;
    const barTicks = ticksPerBeat * meter.numerator * 4 / meter.denominator;
    const totalBars = Math.max(1, Math.ceil(totalTicks / barTicks));
    const barsPerPage = options.singlePage ? totalBars : Math.max(1, Math.min(9, Math.round(options.barsPerPage) || 2));
    const pageCount = Math.ceil(totalBars / barsPerPage);
    const pitches = [...scale].sort((a, b) => a - b);
    const pages = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const firstBar = pageIndex * barsPerPage;
      const barsOnPage = Math.min(barsPerPage, totalBars - firstBar);
      const startTick = firstBar * barTicks, endTick = startTick + barsOnPage * barTicks;
      const commands = [];
      const text = (x, y, value, size = 9, anchor = "start") => commands.push({ type: "text", x, y, value: clean(value), size, anchor });
      const line = (x1, y1, x2, y2, gray = 0.7, width = 0.4) => commands.push({ type: "line", x1, y1, x2, y2, gray, width });
      const left = 46, right = WIDTH - 30, top = 96, bottom = HEIGHT - 58;
      const laneWidth = (right - left) / pitches.length;
      text(left, 34, "Music Box MIDI Lab", 17);
      text(left, 53, `Bars ${firstBar + 1}-${firstBar + barsOnPage}  |  ${pitches.length} lanes  |  ${options.bpm} BPM`, 10);
      text(right, 34, `${pageIndex + 1} / ${pageCount}`, 10, "end");
      line(left, 64, right, 64, 0.35, 0.6);
      for (let lane = 0; lane < pitches.length; lane++) {
        const x = left + (lane + 0.5) * laneWidth;
        text(x, 84, options.label(pitches[lane]), pitches.length > 45 ? 6 : 9, "middle");
        line(x, top, x, bottom, 0.72, 0.4);
      }
      // Explicit vector strokes remain visible when print backgrounds are disabled.
      const slots = Math.round(barsOnPage * barTicks / (ticksPerBeat / 4));
      const slotsPerBar = Math.round(barTicks / (ticksPerBeat / 4));
      for (let slot = 0; slot <= slots; slot++) {
        const isBar = slot % slotsPerBar === 0;
        const isBeat = slot % 4 === 0;
        // Avoid a solid gray field when the whole song is squeezed onto one page.
        if (!isBar && (bottom - top) / slots < 3 && !isBeat) continue;
        if (!isBar && isBeat && (bottom - top) / slots * 4 < 3) continue;
        const y = top + slot / slots * (bottom - top);
        line(left, y, right, y, isBar ? 0.35 : isBeat ? 0.68 : 0.86, isBar ? 0.7 : 0.3);
        if (isBar) text(left - 9, y + (slot === slots ? -2 : 3), firstBar + slot / slotsPerBar + 1, 8, "end");
      }
      for (const note of notes) {
        if (note.duplicate || note.mappedNote === null || (enforceRepeats && note.repeated)
          || note.tick < startTick || note.tick >= endTick) continue;
        const lane = pitches.indexOf(note.mappedNote);
        if (lane < 0) continue;
        commands.push({ type: "note", x: left + (lane + 0.5) * laneWidth,
          y: top + (note.tick - startTick) / (endTick - startTick) * (bottom - top),
          radius: Math.min(2.5, laneWidth * 0.28), folded: Boolean(note.folded), repeated: Boolean(note.repeated) });
      }
      text(left, HEIGHT - 32, "Filled: mapped note   |   Ring: octave-folded note   |   Cross: repeated tine (when included)", 8);
      text(left, HEIGHT - 18, `1/16-note timing grid  |  Repeat enforcement: ${enforceRepeats ? "on - flagged notes omitted" : "off - flagged notes included"}`, 8);
      pages.push({ width: WIDTH, height: HEIGHT, commands });
    }
    return pages;
  }

  function toPdf(pages) {
    const objects = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    const pageIds = [];
    const escape = value => clean(value).replace(/[\\()]/g, "\\$&");
    for (const page of pages) {
      const draw = [];
      for (const c of page.commands) {
        if (c.type === "text") {
          // Standard Helvetica metrics for accurate centering of pitch labels.
          const widths = { " ": 278, "#": 556, "-": 333, "/": 278, "|": 260, ":": 278,
            A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778 };
          const textWidth = [...c.value].reduce((sum, ch) => sum + (widths[ch] || 556), 0) * c.size / 1000;
          const x = c.x - (c.anchor === "middle" ? textWidth / 2 : c.anchor === "end" ? textWidth : 0);
          draw.push(`0 g BT /F1 ${c.size} Tf ${number(x)} ${number(page.height - c.y)} Td (${escape(c.value)}) Tj ET`);
        } else if (c.type === "line") {
          draw.push(`${c.gray} G ${c.width} w ${number(c.x1)} ${number(page.height - c.y1)} m ${number(c.x2)} ${number(page.height - c.y2)} l S`);
        } else {
          const x = c.x, y = page.height - c.y, r = c.radius, k = r * 0.55228475;
          draw.push(`0 G 0 g 0.8 w ${number(x+r)} ${number(y)} m`,
            `${number(x+r)} ${number(y+k)} ${number(x+k)} ${number(y+r)} ${number(x)} ${number(y+r)} c`,
            `${number(x-k)} ${number(y+r)} ${number(x-r)} ${number(y+k)} ${number(x-r)} ${number(y)} c`,
            `${number(x-r)} ${number(y-k)} ${number(x-k)} ${number(y-r)} ${number(x)} ${number(y-r)} c`,
            `${number(x+k)} ${number(y-r)} ${number(x+r)} ${number(y-k)} ${number(x+r)} ${number(y)} c`,
            c.folded || c.repeated ? "1 g B" : "B");
          if (c.repeated) draw.push(`0 G 0.8 w ${number(x-r)} ${number(y-r)} m ${number(x+r)} ${number(y+r)} l ${number(x-r)} ${number(y+r)} m ${number(x+r)} ${number(y-r)} l S`);
        }
      }
      const stream = draw.join("\n") + "\n";
      const pageId = objects.length + 1, streamId = pageId + 1;
      pageIds.push(pageId);
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    }
    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`;
    let pdf = "%PDF-1.4\n", offsets = [0];
    objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Uint8Array([...pdf].map(ch => ch.charCodeAt(0)));
  }

  function toSvg(page) {
    const esc = text => String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
    const gray = value => `rgb(${Math.round(value * 255)},${Math.round(value * 255)},${Math.round(value * 255)})`;
    const content = page.commands.map(c => {
      if (c.type === "text") return `<text x="${c.x}" y="${c.y}" font-size="${c.size}" text-anchor="${c.anchor}">${esc(c.value)}</text>`;
      if (c.type === "line") return `<line x1="${c.x1}" y1="${c.y1}" x2="${c.x2}" y2="${c.y2}" stroke="${gray(c.gray)}" stroke-width="${c.width}"/>`;
      const circle = `<circle cx="${c.x}" cy="${c.y}" r="${c.radius}" fill="${c.folded || c.repeated ? "white" : "black"}" stroke="black" stroke-width="0.8"/>`;
      return circle + (c.repeated ? `<path d="M${c.x-c.radius} ${c.y-c.radius}l${2*c.radius} ${2*c.radius}m${-2*c.radius} 0l${2*c.radius} ${-2*c.radius}" stroke="black" stroke-width="0.8"/>` : "");
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}" font-family="Arial, sans-serif" fill="black">${content}</svg>`;
  }
  const api = { createPages, toPdf, toSvg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StripExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
