# Music Box MIDI Lab

A browser-based MIDI explorer and editor for music-box arrangements. Import a MIDI file, map its notes to an instrument range, edit the piano roll, audition it, then export MIDI or print a PDF punch strip.

## Open locally

From this directory, start a static server:

```powershell
python -m http.server 8765 --directory web
```

Open `http://localhost:8765`. The app has no build step or JavaScript package dependencies. MIDI files are read locally in the browser; they are not uploaded to a server.

## MIDI Lab controls

- **Scale presets:** use the photographed 30-note music-box range, chromatic 15/20/30-note ranges, ranges adapted to the imported MIDI, or a custom range.
- **Piano roll:** click an empty grid slot to add a note, click a note to remove it, or drag a note to another lane and time slot. Notes snap to the 1/16-note grid.
- **Repeat-tine enforcement:** enabled by default. Immediate repeats on the same mapped tine are marked; enforcement optionally omits them from playback and MIDI/PDF exports.
- **Playback:** adjust BPM, drag the playhead to seek, select a built-in voice or load an audio sample, and change volume.
- **MIDI export:** download the edited, mapped notes as a MIDI file.
- **PDF export:** print the mapped punch strip with 1–9 bars per landscape page or the whole song on one page. The browser print dialog lets you save as PDF.

## Publish on GitHub Pages

This repository includes `.github/workflows/deploy-pages.yml`. It deploys the contents of `web/` when changes reach the `main` branch, with no site build step.

For the first deployment:

1. Push the repository to GitHub.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment → Source**, select **GitHub Actions**.
4. Open the **Actions** tab and check the **Deploy MIDI Lab** workflow. After a successful run, the Pages settings show the public site URL.

GitHub Pages availability for private repositories depends on the account or organization plan. If Pages is unavailable for this private repository, make the repository public, use a plan that supports Pages for private repositories, or publish only the `web/` directory from a separate public repository.

## Command-line tools

The Python tools are optional; they generate a calibrated punch-strip PDF or an MP3 preview outside the browser app.

### Install

Python 3.10+ is recommended. Install the PDF tool dependencies:

```bash
pip install mido reportlab
```

MP3 export also requires FFmpeg's `ffmpeg` encoder available on `PATH`.

### Generate a long strip PDF

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_strip.pdf
```

Limit the PDF to the first 44 bars:

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_44bars.pdf \
  --bars 44
```

Create a landscape PDF with two bars per page, retaining note names and omitting the MIDI filename:

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_pages.pdf \
  --split-pages
```

Use `--bars-per-page 4` to change the page length when `--split-pages` is enabled. The default layout remains one long, narrow strip. A `.report.txt` file is written beside the PDF with lane mappings and folding/drop warnings.

### Export an MP3 preview

```bash
python play_musicbox.py input.mid 120
```

The arguments are the MIDI path and BPM. The script writes `input_musicbox.mp3` beside the MIDI without overwriting an existing file. It applies the photographed strip's range mapping and uses a synthesized kalimba/music-box-like plucked tone.

## Photographed 30-note scale

`configs/photo_30_note.json` describes the supplied photographed music-box strip. Its physical lanes, left to right, are:

`C, D, G, A, B, C1, D1, E1, F1, F#1, G1, G#1, A1, A#1, B1, C2, C#2, D2, D#2, E2, F2, F#2, G2, G#2, A2, A#2, B2, C3, D3, E3`

The low end is intentionally irregular: it has C/D/G/A/B, so low E and F do not exist. `base_midi` defaults to MIDI 48 (C3); adjust it or `input_transpose_semitones` if the source MIDI labels this strip an octave differently.

### Mapping and calibration

Unavailable notes use `out_of_scale: "octave_fold"` by default, mapping to an available note of the same pitch class in another octave. Set this to `"drop"` or `"error"` if preferred. Folded notes are drawn as hollow circles in the CLI PDF.

For physical strip calibration, the primary values are:

```json
"width_mm": 70.0,
"mm_per_quarter": 8.0
```

`width_mm` controls lane spacing; `mm_per_quarter` controls paper consumed per MIDI quarter note. Print at **100% / Actual size**, not “Fit to page”. Other adjustable values include `left_margin_mm`, `right_margin_mm`, `punch_radius_mm`, and `grid_subdivisions_per_quarter`.

If the MIDI has no time-signature events, the default is:

```json
"default_time_signature": [4, 4]
```

The default `quantize_quarter` is `0.25`, snapping note attacks to 1/16-note positions. Set it to `0` to preserve raw MIDI timing. Track selection defaults to all tracks (`"tracks": "all"`); it can be restricted to zero-based indexes such as `[1, 2, 4]`.

## Notes and limitations

- Note duration is ignored by the paper-strip renderer; attack position is what matters.
- Duplicate notes at exactly the same tick and mapped lane are deduplicated.
- Very fast repeated notes may still be mechanically difficult to punch or play.
- Velocity is not represented in the punch-strip PDF because hole size is fixed.
- Verify the transcribed photographed scale against the physical blank strip before punching a final copy.
