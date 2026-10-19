#!/usr/bin/env python3
"""
Generate a printable punch-strip PDF from a MIDI file.

Dependencies:
    pip install mido reportlab

Example:
    python musicbox_strip.py song.mid -c configs/photo_30_note.json -o song_strip.pdf
    python musicbox_strip.py song.mid -c configs/photo_30_note.json -o song_strip.pdf --bars 44
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import mido
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.lib.pagesizes import A4, landscape


@dataclass(frozen=True)
class NoteEvent:
    tick: int
    midi_note: int
    velocity: int
    track_index: int


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    required = ["scale", "strip", "timing", "render", "mapping"]
    for key in required:
        if key not in cfg:
            raise ValueError(f"Missing config section: {key}")
    return cfg


def physical_notes(cfg: dict) -> list[int]:
    scale = cfg["scale"]
    if "midi_notes" in scale:
        notes = [int(x) for x in scale["midi_notes"]]
    else:
        base = int(scale["base_midi"])
        notes = [base + int(x) for x in scale["semitone_offsets"]]

    if len(notes) != int(scale["lane_count"]):
        raise ValueError(
            f"Scale defines {len(notes)} notes but lane_count={scale['lane_count']}"
        )
    if len(set(notes)) != len(notes):
        raise ValueError("Physical MIDI notes must be unique")
    return notes


def scale_labels(cfg: dict) -> list[str]:
    labels = cfg["scale"].get("labels", [])
    if labels and len(labels) != int(cfg["scale"]["lane_count"]):
        raise ValueError("labels length must equal lane_count")
    if labels:
        return [str(x) for x in labels]
    return [str(n) for n in physical_notes(cfg)]


def collect_note_events(mid: mido.MidiFile, cfg: dict) -> list[NoteEvent]:
    wanted_tracks = cfg["mapping"].get("tracks", "all")
    if wanted_tracks == "all":
        track_filter = None
    else:
        track_filter = {int(x) for x in wanted_tracks}

    events: list[NoteEvent] = []
    for ti, track in enumerate(mid.tracks):
        if track_filter is not None and ti not in track_filter:
            continue
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                events.append(NoteEvent(abs_tick, int(msg.note), int(msg.velocity), ti))
    events.sort(key=lambda e: (e.tick, e.midi_note, e.track_index))
    return events


def time_signature_events(mid: mido.MidiFile, cfg: dict) -> list[tuple[int, int, int]]:
    found: list[tuple[int, int, int]] = []
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.is_meta and msg.type == "time_signature":
                found.append((abs_tick, int(msg.numerator), int(msg.denominator)))

    found.sort(key=lambda x: x[0])
    # Deduplicate same tick. First is enough for our layout.
    dedup: list[tuple[int, int, int]] = []
    seen = set()
    for item in found:
        if item[0] not in seen:
            dedup.append(item)
            seen.add(item[0])

    if not dedup or dedup[0][0] != 0:
        ts = cfg["timing"].get("default_time_signature", [4, 4])
        dedup.insert(0, (0, int(ts[0]), int(ts[1])))
    return dedup


def quantize_tick(tick: int, ticks_per_beat: int, quarter_step: float) -> int:
    if not quarter_step or quarter_step <= 0:
        return tick
    quantum = ticks_per_beat * quarter_step
    return int(round(tick / quantum) * quantum)


def fold_note(note: int, allowed: list[int], cfg: dict) -> tuple[int | None, str]:
    """
    Map an input MIDI note to a physical lane.

    Returns: (mapped_note or None, status)
    status is one of: exact, folded, dropped
    """
    transpose = int(cfg["mapping"].get("input_transpose_semitones", 0))
    note += transpose

    if note in allowed:
        return note, "exact"

    behavior = cfg["mapping"].get("out_of_scale", "octave_fold")
    if behavior == "drop":
        return None, "dropped"
    if behavior == "error":
        raise ValueError(f"MIDI note {note} is not available on the configured scale")
    if behavior != "octave_fold":
        raise ValueError(f"Unknown out_of_scale mode: {behavior}")

    candidates = [n for n in allowed if (n - note) % 12 == 0]
    if not candidates:
        return None, "dropped"

    preference = cfg["mapping"].get("octave_fold_preference", "nearest")

    def key_nearest(n: int):
        distance = abs(n - note)
        # Tie breaker can prefer upward or downward folding.
        if preference == "up":
            tie = 0 if n > note else 1
        elif preference == "down":
            tie = 0 if n < note else 1
        else:
            tie = 0
        return (distance, tie, n)

    return min(candidates, key=key_nearest), "folded"


def build_bar_boundaries(
    end_tick: int,
    ticks_per_beat: int,
    signatures: list[tuple[int, int, int]]
) -> list[tuple[int, int]]:
    """
    Return list of (tick, bar_number), with bar 1 starting at tick 0.
    Time-signature changes are assumed to occur at bar boundaries.
    """
    result = [(0, 1)]
    bar_no = 1
    pos = 0

    for idx, (sig_tick, num, den) in enumerate(signatures):
        if sig_tick > pos:
            # Advance using previous signature if necessary.
            pnum, pden = signatures[max(0, idx - 1)][1:]
            bar_len = ticks_per_beat * pnum * 4 / pden
            while pos + bar_len <= min(sig_tick, end_tick):
                pos = int(round(pos + bar_len))
                bar_no += 1
                result.append((pos, bar_no))
        pos = max(pos, sig_tick)
        next_sig_tick = signatures[idx + 1][0] if idx + 1 < len(signatures) else end_tick
        bar_len = ticks_per_beat * num * 4 / den
        while pos + bar_len <= min(next_sig_tick, end_tick):
            pos = int(round(pos + bar_len))
            bar_no += 1
            result.append((pos, bar_no))

    return result


def generate_paginated_pdf(
    output_path: Path,
    mapped: list[tuple[int, int, int, int, str]],
    labels: list[str],
    ticks_per_beat: int,
    signatures: list[tuple[int, int, int]],
    bars_per_page: int,
    timing: dict,
    render: dict,
) -> int:
    max_tick = max(tick for tick, *_ in mapped)
    max_bar_quarters = max(num * 4 / den for _, num, den in signatures)
    boundary_horizon = max_tick + math.ceil(
        ticks_per_beat * max_bar_quarters * (bars_per_page + 1)
    )
    boundaries = build_bar_boundaries(boundary_horizon, ticks_per_beat, signatures)
    boundary_by_bar = {bar_no: tick for tick, bar_no in boundaries}
    last_bar = max(bar_no for tick, bar_no in boundaries if tick <= max_tick)

    page_width_pt, page_height_pt = landscape(A4)
    page_width_mm = page_width_pt / mm
    page_height_mm = page_height_pt / mm
    left_mm = 12.0
    right_mm = 12.0
    top_mm = 24.0
    bottom_mm = 12.0
    grid_height_mm = page_height_mm - top_mm - bottom_mm
    lane_count = len(labels)
    usable_width_mm = page_width_mm - left_mm - right_mm
    lane_x_mm = [
        left_mm + usable_width_mm * i / max(1, lane_count - 1)
        for i in range(lane_count)
    ]
    direction = render.get("time_direction", "top_to_bottom")
    subdivisions = int(timing.get("grid_subdivisions_per_quarter", 4))
    punch_radius_mm = float(render.get("punch_radius_mm", 0.85))
    folded_style = render.get("folded_style", "ring")
    c = canvas.Canvas(str(output_path), pagesize=(page_width_pt, page_height_pt))
    c.setTitle(output_path.stem)

    page_count = 0
    for first_bar in range(1, last_bar + 1, bars_per_page):
        final_bar = first_bar + bars_per_page
        start_tick = boundary_by_bar[first_bar]
        stop_tick = boundary_by_bar[final_bar]
        page_count += 1

        def y_for_tick(tick: int) -> float:
            fraction = (tick - start_tick) / (stop_tick - start_tick)
            offset = fraction * grid_height_mm
            if direction == "bottom_to_top":
                return bottom_mm + offset
            return page_height_mm - top_mm - offset

        c.setFillGray(0.0)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(left_mm * mm, (page_height_mm - 9.0) * mm,
                     f"Bars {first_bar}-{final_bar - 1}")

        c.setFont("Helvetica", 6.2)
        for x, label in zip(lane_x_mm, labels):
            c.drawCentredString(x * mm, (page_height_mm - 18.0) * mm, label)

        grid_top_mm = page_height_mm - top_mm
        c.setStrokeGray(0.78)
        c.setLineWidth(0.25)
        for x in lane_x_mm:
            c.line(x * mm, bottom_mm * mm, x * mm, grid_top_mm * mm)

        if subdivisions > 0:
            step_tick = ticks_per_beat / subdivisions
            tick = math.ceil(start_tick / step_tick) * step_tick
            c.setStrokeGray(0.88)
            c.setLineWidth(0.2)
            while tick < stop_tick:
                y = y_for_tick(int(round(tick)))
                c.line(left_mm * mm, y * mm, (page_width_mm - right_mm) * mm, y * mm)
                tick += step_tick

        c.setStrokeGray(0.30)
        c.setFillGray(0.20)
        c.setFont("Helvetica", 6.5)
        for tick, bar_no in boundaries:
            if start_tick <= tick < stop_tick:
                y = y_for_tick(tick)
                c.setLineWidth(0.65)
                c.line(left_mm * mm, y * mm, (page_width_mm - right_mm) * mm, y * mm)
                c.drawRightString((left_mm - 2.0) * mm, (y - 1.0) * mm, str(bar_no))

        for tick, lane, _, _, status in mapped:
            if not start_tick <= tick < stop_tick:
                continue
            x = lane_x_mm[lane]
            y = y_for_tick(tick)
            if status == "folded" and folded_style == "ring":
                c.setLineWidth(0.7)
                c.setStrokeGray(0.0)
                c.setFillGray(1.0)
                c.circle(x * mm, y * mm, punch_radius_mm * mm, stroke=1, fill=0)
            else:
                c.setFillGray(0.0)
                c.circle(x * mm, y * mm, punch_radius_mm * mm, stroke=0, fill=1)

        c.showPage()

    c.save()
    return page_count


def write_report(
    midi_path: Path,
    config_path: Path,
    output_path: Path,
    mid: mido.MidiFile,
    mapped: list[tuple[int, int, int, int, str]],
    allowed: list[int],
    labels: list[str],
    warnings: list[str],
    page_count: int,
) -> None:
    report_path = output_path.with_suffix(".report.txt")
    exact_count = sum(1 for *_, status in mapped if status == "exact")
    folded_count = sum(1 for *_, status in mapped if status == "folded")
    report = [
        f"Input MIDI: {midi_path}",
        f"Config: {config_path}",
        f"Ticks/quarter: {mid.ticks_per_beat}",
        f"PDF pages: {page_count}",
        f"Mapped note attacks: {len(mapped)}",
        f"Exact: {exact_count}",
        f"Octave-folded: {folded_count}",
        f"Warnings: {len(warnings)}",
        "",
        "Physical lanes:",
    ]
    for i, (label, midi_note) in enumerate(zip(labels, allowed), start=1):
        report.append(f"{i:02d}: {label:>4} -> MIDI {midi_note}")
    if warnings:
        report += ["", "Mapping warnings:"] + warnings
    report_path.write_text("\n".join(report), encoding="utf-8")

    print(f"Wrote: {output_path}")
    print(f"Wrote: {report_path}")
    print(f"Mapped attacks: {len(mapped)} (folded: {folded_count}, warnings: {len(warnings)})")


def generate_pdf(
    midi_path: Path,
    config_path: Path,
    output_path: Path,
    max_bars: int | None = None,
    split_pages: bool = False,
    bars_per_page: int = 2,
):
    if bars_per_page < 1:
        raise ValueError("bars_per_page must be at least 1")
    cfg = load_config(config_path)
    mid = mido.MidiFile(midi_path)

    allowed = physical_notes(cfg)
    labels = scale_labels(cfg)
    lane_count = len(allowed)
    lane_by_note = {note: i for i, note in enumerate(allowed)}

    events = collect_note_events(mid, cfg)
    if not events:
        raise ValueError("No note_on events found in selected MIDI tracks")

    q_step = float(cfg["timing"].get("quantize_quarter", 0))
    signatures = time_signature_events(mid, cfg)

    # Determine cutoff from requested bars.
    max_tick = max(e.tick for e in events)
    boundaries = build_bar_boundaries(max_tick + mid.ticks_per_beat * 16, mid.ticks_per_beat, signatures)
    cutoff_tick = None
    if max_bars is not None:
        # Start of bar max_bars+1.
        for tick, bar_no in boundaries:
            if bar_no == max_bars + 1:
                cutoff_tick = tick
                break

    mapped = []
    warnings = []
    dedupe = set()

    for e in events:
        tick = quantize_tick(e.tick, mid.ticks_per_beat, q_step)
        if cutoff_tick is not None and tick >= cutoff_tick:
            continue

        target, status = fold_note(e.midi_note, allowed, cfg)
        if target is None:
            warnings.append(
                f"DROP tick={tick}: MIDI {e.midi_note} has no octave-equivalent physical lane"
            )
            continue

        lane = lane_by_note[target]
        dedupe_key = (tick, lane)
        if cfg["mapping"].get("dedupe_same_tick", True) and dedupe_key in dedupe:
            continue
        dedupe.add(dedupe_key)

        mapped.append((tick, lane, e.midi_note, target, status))
        if status == "folded":
            warnings.append(
                f"FOLD tick={tick}: MIDI {e.midi_note} -> {target} ({labels[lane]})"
            )

    if not mapped:
        raise ValueError("All notes were filtered/dropped")

    end_tick = max(tick for tick, *_ in mapped)
    if cutoff_tick is not None:
        end_tick = cutoff_tick

    strip = cfg["strip"]
    timing = cfg["timing"]
    render = cfg["render"]

    if split_pages:
        page_count = generate_paginated_pdf(
            output_path,
            mapped,
            labels,
            mid.ticks_per_beat,
            signatures,
            bars_per_page,
            timing,
            render,
        )
        write_report(midi_path, config_path, output_path, mid, mapped, allowed,
                     labels, warnings, page_count)
        return

    strip_width_mm = float(strip.get("width_mm", 70.0))
    left_margin_mm = float(strip.get("left_margin_mm", 3.0))
    right_margin_mm = float(strip.get("right_margin_mm", 3.0))
    top_margin_mm = float(strip.get("top_margin_mm", 12.0))
    bottom_margin_mm = float(strip.get("bottom_margin_mm", 12.0))

    mm_per_quarter = float(timing.get("mm_per_quarter", 8.0))
    total_quarters = end_tick / mid.ticks_per_beat
    music_height_mm = max(1.0, total_quarters * mm_per_quarter)
    page_height_mm = top_margin_mm + music_height_mm + bottom_margin_mm

    page_width_pt = strip_width_mm * mm
    page_height_pt = page_height_mm * mm

    c = canvas.Canvas(str(output_path), pagesize=(page_width_pt, page_height_pt))
    c.setTitle(output_path.stem)

    usable_width_mm = strip_width_mm - left_margin_mm - right_margin_mm
    if lane_count == 1:
        lane_x_mm = [left_margin_mm + usable_width_mm / 2]
    else:
        lane_x_mm = [
            left_margin_mm + usable_width_mm * i / (lane_count - 1)
            for i in range(lane_count)
        ]

    time_direction = render.get("time_direction", "top_to_bottom")

    def y_for_tick(tick: int) -> float:
        q = tick / mid.ticks_per_beat
        offset = q * mm_per_quarter
        if time_direction == "bottom_to_top":
            return bottom_margin_mm + offset
        return page_height_mm - top_margin_mm - offset

    # Background / lane guides
    c.setLineWidth(0.25)
    c.setStrokeGray(0.78)
    for x in lane_x_mm:
        c.line(x * mm, bottom_margin_mm * mm, x * mm, (page_height_mm - top_margin_mm) * mm)

    # Beat/subdivision grid
    subdivisions = int(timing.get("grid_subdivisions_per_quarter", 4))
    if subdivisions > 0:
        step_tick = mid.ticks_per_beat / subdivisions
        t = 0.0
        c.setStrokeGray(0.88)
        c.setLineWidth(0.2)
        while t <= end_tick:
            y = y_for_tick(int(round(t)))
            c.line(left_margin_mm * mm, y * mm, (strip_width_mm - right_margin_mm) * mm, y * mm)
            t += step_tick

    # Bar lines
    bar_boundaries = build_bar_boundaries(end_tick, mid.ticks_per_beat, signatures)
    c.setStrokeGray(0.30)
    c.setFillGray(0.20)
    c.setFont("Helvetica", 5.5)
    for tick, bar_no in bar_boundaries:
        if tick > end_tick:
            break
        y = y_for_tick(tick)
        c.setLineWidth(0.65)
        c.line(left_margin_mm * mm, y * mm, (strip_width_mm - right_margin_mm) * mm, y * mm)
        c.drawString(0.8 * mm, (y - 0.7) * mm, f"{bar_no}")

    # Punch marks
    punch_radius_mm = float(render.get("punch_radius_mm", 0.85))
    folded_style = render.get("folded_style", "ring")

    for tick, lane, src, target, status in mapped:
        x = lane_x_mm[lane]
        y = y_for_tick(tick)
        if status == "folded" and folded_style == "ring":
            c.setLineWidth(0.7)
            c.setStrokeGray(0.0)
            c.setFillGray(1.0)
            c.circle(x * mm, y * mm, punch_radius_mm * mm, stroke=1, fill=0)
        else:
            c.setFillGray(0.0)
            c.circle(x * mm, y * mm, punch_radius_mm * mm, stroke=0, fill=1)

    # Lane labels at both ends for easier punching.
    c.setFillGray(0.0)
    font_size = float(render.get("label_font_size", 4.6))
    c.setFont("Helvetica", font_size)
    for x, label in zip(lane_x_mm, labels):
        c.saveState()
        c.translate(x * mm, (page_height_mm - 2.5) * mm)
        c.rotate(90)
        c.drawString(0, 0, label)
        c.restoreState()

        c.saveState()
        c.translate(x * mm, 2.2 * mm)
        c.rotate(90)
        c.drawString(0, 0, label)
        c.restoreState()

    # Feed/time arrow and title
    c.setFont("Helvetica-Bold", 6)
    c.drawString(left_margin_mm * mm, (page_height_mm - 6.0) * mm, midi_path.stem[:45])
    c.setFont("Helvetica", 5)
    c.drawRightString((strip_width_mm - right_margin_mm) * mm, (page_height_mm - 6.0) * mm,
                      f"{lane_count} lanes | {mm_per_quarter:g} mm/qn")

    # Draw a simple direction arrow.
    arrow_x = strip_width_mm - 2.0
    if time_direction == "bottom_to_top":
        y1, y2 = 5.0, 10.0
    else:
        y1, y2 = page_height_mm - 5.0, page_height_mm - 10.0
    c.setLineWidth(0.8)
    c.line(arrow_x * mm, y1 * mm, arrow_x * mm, y2 * mm)
    sign = 1 if y2 > y1 else -1
    c.line(arrow_x * mm, y2 * mm, (arrow_x - 0.8) * mm, (y2 - sign * 1.2) * mm)
    c.line(arrow_x * mm, y2 * mm, (arrow_x + 0.8) * mm, (y2 - sign * 1.2) * mm)

    c.showPage()
    c.save()

    write_report(midi_path, config_path, output_path, mid, mapped, allowed,
                 labels, warnings, 1)


def main():
    p = argparse.ArgumentParser(description="Generate a music-box punch-strip PDF from MIDI.")
    p.add_argument("midi", type=Path, help="Input MIDI file")
    p.add_argument("-c", "--config", type=Path, required=True, help="JSON configuration")
    p.add_argument("-o", "--output", type=Path, required=True, help="Output PDF")
    p.add_argument("--bars", type=int, default=None, help="Stop after N bars")
    p.add_argument("--split-pages", action="store_true",
                   help="Create landscape pages instead of one long strip")
    p.add_argument("--bars-per-page", type=int, default=2,
                   help="Bars on each page when --split-pages is enabled (default: 2)")
    args = p.parse_args()

    generate_pdf(args.midi, args.config, args.output, args.bars,
                 args.split_pages, args.bars_per_page)


if __name__ == "__main__":
    main()
