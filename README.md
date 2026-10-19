<div align="center">

# 🎵 Music Box MIDI Lab

**Turn a MIDI melody into a music-box arrangement.**

Map your notes · Edit the piano roll · Hear the result · Print a punch strip

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Browser app](https://img.shields.io/badge/Browser-Vanilla_JS-f7df1e)
![Local processing](https://img.shields.io/badge/MIDI-Stays_on_your_device-2ea44f)

[Quick start](#quick-start) · [Features](#features) · [Command-line tools](#optional-command-line-tools) · [Strip calibration](#photographed-30-note-scale) · [License](#license)

</div>

---

Explore, adapt, and edit MIDI for a music-box instrument. The browser app maps notes to a playable range, previews them with a live playhead, and exports edited MIDI or a printable punch-strip PDF.

**Runs locally in your browser. No build step or JavaScript dependencies.** MIDI files are read on your device and are not uploaded.

## Quick start

From the `musicbox_strip_tool` directory:

```powershell
python -m http.server 8765 --directory web
```

Open [localhost:8765](http://localhost:8765), then:

1. **Load** a `.mid` or `.midi` file.
2. **Map** it to your instrument’s range and adjust notes in the piano roll.
3. **Listen** to the arrangement and check repeated-tine warnings.
4. **Export** MIDI or use **Print / PDF** to create a punch strip.

> **Printing a physical strip?** Use **100% / Actual size** and verify your instrument’s lane spacing before punching.

## Features

| Step | What you can do |
| :--- | :--- |
| 🎼 **Map** | Choose the photographed 30-note strip, chromatic 15/20/30-note presets, a MIDI-adapted range, or a custom range. |
| ✏️ **Edit** | Click to add or remove notes; drag to change timing and pitch. Notes snap to 1/16-note slots. |
| 🔊 **Listen** | Set BPM, seek with the playhead, choose a built-in voice or load an audio sample, and adjust volume. |
| 🔎 **Check** | See immediate repeats on the same mapped tine. Repeat enforcement is on by default and can omit these notes from playback and exports. |
| 📄 **Export** | Download mapped MIDI, or print a PDF with 1–9 bars per landscape page or the whole song on one page. |

## Publish on GitHub Pages

<details>
<summary>Deploy the static browser app</summary>

The repository includes a GitHub Actions workflow that publishes only the static `web/` app when changes are pushed to `main`.

For the first deployment, open the repository’s **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. Then check the **Deploy MIDI Lab** workflow under **Actions**. After a successful run, GitHub shows the site URL in **Settings → Pages**.

GitHub Pages availability for private repositories depends on the account or organization plan. If Pages is unavailable for a private repository, the choices are to make it public, use a plan that supports Pages, or publish `web/` from a separate public repository.

</details>

## Optional command-line tools

The browser app is the main workflow. The Python scripts are available for batch PDF/MP3 output.

<details>
<summary>Python setup, PDF generation, and MP3 export</summary>

### Install PDF dependencies

Python 3.10+ is recommended:

```bash
pip install mido reportlab
```

MP3 export also requires FFmpeg’s `ffmpeg` encoder on `PATH`.

### Generate a long-strip PDF

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_strip.pdf
```

Limit the output to 44 bars with `--bars 44`. For landscape pages, use `--split-pages`; the default is two bars per page, adjustable with `--bars-per-page`:

```bash
python musicbox_strip.py input.mid \
  -c configs/photo_30_note.json \
  -o output_pages.pdf \
  --split-pages --bars-per-page 4
```

The split layout includes note names, bar numbers, and omits the MIDI filename. A `.report.txt` diagnostics file is written beside the PDF.

### Export an MP3 preview

```bash
python play_musicbox.py input.mid 120
```

The arguments are the MIDI path and BPM. The script writes `input_musicbox.mp3` beside the MIDI and refuses to overwrite an existing file. It uses the photographed strip’s note mapping and a synthesized kalimba/music-box-like plucked tone.

</details>

## Photographed 30-note scale

<details>
<summary>Note lanes, mapping options, and physical calibration</summary>

`configs/photo_30_note.json` describes the supplied photographed strip. Physical lanes, left to right:

`C, D, G, A, B, C1, D1, E1, F1, F#1, G1, G#1, A1, A#1, B1, C2, C#2, D2, D#2, E2, F2, F#2, G2, G#2, A2, A#2, B2, C3, D3, E3`

The low end is intentionally irregular: C/D/G/A/B are present, while low E and F are not. `base_midi` defaults to MIDI 48 (C3); change it or `input_transpose_semitones` if your MIDI labels the strip an octave differently.

Unavailable pitches use `out_of_scale: "octave_fold"` by default, mapping to the nearest available note with the same pitch class. Alternatives are `"drop"` and `"error"`. The default `quantize_quarter` is `0.25`, snapping attacks to 1/16-note positions; set it to `0` to preserve raw timing. Track selection defaults to all tracks (`"tracks": "all"`) and can be restricted to zero-based indexes such as `[1, 2, 4]`.

For physical calibration, adjust `width_mm`, `mm_per_quarter`, `left_margin_mm`, `right_margin_mm`, and `punch_radius_mm` in the config. Print at **100% / Actual size**, not “Fit to page”. Verify the photographed scale against the physical blank strip before punching a final copy.

For example, the two main calibration values are:

| Config section | Setting | Default |
| :--- | :--- | ---: |
| `strip` | `width_mm` | `70.0` |
| `timing` | `mm_per_quarter` | `8.0` |

If the MIDI contains no time-signature event, the renderer assumes:

```json
{ "default_time_signature": [4, 4] }
```

</details>

## MIDI behavior and limitations

- The punch-strip renderer uses note attacks; note duration is ignored.
- Identical attacks at the same tick and mapped lane are deduplicated.
- Velocity is not represented in the PDF because hole size is fixed.
- Very fast repeated notes may still be difficult for a mechanism to play or punch.

## License

Copyright (c) 2026 Oleksandr Volkov.

Licensed under the **GNU General Public License v3.0 only** (`GPL-3.0-only`). See [LICENSE](LICENSE) for the full terms.

You may use, study, modify, and share this software, including commercially. If you distribute modified versions or derivative works, you must license the covered work under GPLv3 and provide the corresponding source code as required by the license. Private modifications do not have to be published.

The software is provided without warranty. This license covers the project’s code; it does not grant rights to third-party music or MIDI files.
