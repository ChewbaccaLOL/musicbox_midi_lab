# MIDI -> music-box punch strip PDF

Small CLI tool for turning a MIDI file into a long, narrow PDF that resembles a 30-note paper music-box strip.

## Install

Python 3.10+ recommended.

```bash
pip install mido reportlab
```

## Quick start

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_strip.pdf
```

Limit the output to the first 44 bars:

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_44bars.pdf \
  --bars 44
```

Create a landscape PDF with two bars per page. Each page has the note names
across the top and omits the MIDI filename:

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_pages.pdf \
  --split-pages
```

Change the number of bars per page with `--bars-per-page 4` (only applies with
`--split-pages`). The default long, narrow strip layout is unchanged.

The program also writes `output_strip.report.txt` with every physical lane and all notes that were octave-folded or dropped.

## Export an audio preview

Export a MIDI file as an MP3 with the same note range and quantization used by
the photographed strip configuration:

```bash
python play_musicbox.py input.mid 120
```

The two arguments are the MIDI path and playback BPM. The script writes
`input_musicbox.mp3` next to the MIDI file, without overwriting an existing
export. It applies the photo configuration's octave folding, so the heard
pitches match the notes available to the strip. It uses a built-in synthesized,
kalimba/music-box-like plucked tone rather than a recording or external
soundfont. FFmpeg's `ffmpeg` encoder must be installed and available on `PATH`.

## MIDI Lab

Open the browser-based MIDI editor by serving its static files locally:

```powershell
python -m http.server 8765 --directory web
```

Then visit `http://localhost:8765`. No JavaScript packages or build step are
required. The lab imports standard MIDI files, adapts a 15-, 20-, or 30-note
draggable playhead and synthesized or user-supplied sample voice. BPM and PDF
range to the imported melody or uses a scale preset, and plays with a live,
draggable playhead and synthesized or user-supplied sample voice. Scroll over
the BPM or bars-per-page number fields to adjust them; use the volume slider
beside the transport to set playback level. Click empty
space to add a note, click a note to remove it, or drag it to move it. Striped
notes flag an immediate repeat on the same mapped tine; truly unmappable notes
remain in a separate subdued `OUT` lane. **Print / PDF** opens the browser
print dialog; choose 1–9 bars per landscape page or fit the whole song on one
page.

## Default photographed 30-note scale

The default `configs/photo_30_note.json` is based on the supplied photograph.

Physical lanes, left to right:

`C, D, G, A, B, C1, D1, E1, F1, F#1, G1, G#1, A1, A#1, B1, C2, C#2, D2, D#2, E2, F2, F#2, G2, G#2, A2, A#2, B2, C3, D3, E3`

The important part is not the printed octave suffix, but the explicit semitone offsets. The low end is intentionally irregular: it has C/D/G/A/B, so low E and F do not exist.

`base_midi` defaults to MIDI 48 (C3). If your source MIDI/service labels the same physical strip one octave differently, change only `base_midi` or use `input_transpose_semitones`.

## Octave folding

`out_of_scale: "octave_fold"` maps an unavailable note to an available note of the same pitch class in another octave.

Example:
- unavailable low E -> E one octave higher, if available;
- unavailable very high G -> G one octave lower.

Folded notes are drawn as hollow circles by default. Exact notes are solid circles.

If you do not want automatic folding:

```json
"out_of_scale": "drop"
```

or:

```json
"out_of_scale": "error"
```

## Physical calibration

The two values you are most likely to tune after comparing the PDF against a real blank strip are:

```json
"width_mm": 70.0,
"mm_per_quarter": 8.0
```

`width_mm` controls lane spacing across the strip.

`mm_per_quarter` controls how much paper is consumed by one MIDI quarter note. This does not determine playback tempo by itself: on a hand-crank mechanism, actual tempo still depends on crank speed.

You can also adjust:
- `left_margin_mm`
- `right_margin_mm`
- `punch_radius_mm`
- `grid_subdivisions_per_quarter`

For best results, print at **100% / Actual size**, never "Fit to page".

## Bar lines

If the MIDI contains time-signature events, the program uses them. Otherwise it uses:

```json
"default_time_signature": [4, 4]
```

Set this to the intended meter if the MIDI does not contain one.

`--bars 44` stops at the start of bar 45.

## Quantization

Default:

```json
"quantize_quarter": 0.25
```

That means note attacks are snapped to 1/16-note positions in 4/4 terminology (one quarter of a quarter note).

Set it to `0` to preserve raw MIDI timing.

## Selecting MIDI tracks

Default is all tracks:

```json
"tracks": "all"
```

To use only specific zero-based track indexes:

```json
"tracks": [1, 2, 4]
```

## Long vertical PDF

The PDF uses the strip's physical width as page width and creates one tall custom page. This is good for inspection, punching reference, or later slicing into printable pages.

If a print shop or PDF viewer dislikes very tall pages, reduce `mm_per_quarter` for a preview or split the PDF afterward.

## Notes / limitations

- Note duration is ignored. A paper-strip music box cares about attack position.
- Multiple identical notes at exactly the same time are deduplicated.
- Very fast repeated notes may still be mechanically impossible. The report does not currently auto-remove them.
- Dynamic/velocity information is not represented because hole size is fixed.
- The default scale was transcribed visually from the supplied strip photo. Verify it against one physical blank strip before punching a final copy.
