#!/usr/bin/env python3
"""Export MIDI as MP3 with a synthesized music-box / kalimba-like tine voice."""

from __future__ import annotations

import argparse
import math
import shutil
import subprocess
import tempfile
import wave
from array import array
from pathlib import Path

import mido

from musicbox_strip import fold_note, load_config, physical_notes, quantize_tick


SAMPLE_RATE = 44100
VOICE_SECONDS = 2.4
OUTPUT_TAIL_SECONDS = 2.5
CONFIG_PATH = Path(__file__).parent / "configs" / "photo_30_note.json"


def collect_attacks(midi_path: Path, bpm: float) -> list[tuple[float, int, int]]:
    if not math.isfinite(bpm) or bpm <= 0:
        raise ValueError("BPM must be a positive number")

    midi = mido.MidiFile(midi_path)
    cfg = load_config(CONFIG_PATH)
    allowed = physical_notes(cfg)
    timing = cfg["timing"]
    quantize = float(timing.get("quantize_quarter", 0))
    selected_tracks = cfg["mapping"].get("tracks", "all")
    track_filter = None if selected_tracks == "all" else {int(i) for i in selected_tracks}
    attacks: list[tuple[float, int, int]] = []
    seen: set[tuple[int, int]] = set()

    for track_index, track in enumerate(midi.tracks):
        if track_filter is not None and track_index not in track_filter:
            continue
        absolute_tick = 0
        for message in track:
            absolute_tick += message.time
            if message.type != "note_on" or message.velocity <= 0:
                continue

            tick = quantize_tick(absolute_tick, midi.ticks_per_beat, quantize)
            note, _ = fold_note(int(message.note), allowed, cfg)
            if note is None:
                continue
            key = (tick, note)
            if cfg["mapping"].get("dedupe_same_tick", True) and key in seen:
                continue
            seen.add(key)
            seconds = tick / midi.ticks_per_beat * 60.0 / bpm
            attacks.append((seconds, note, int(message.velocity)))

    attacks.sort()
    if not attacks:
        raise ValueError("No playable note_on events found in this MIDI file")
    return attacks


def make_voice(note: int) -> array:
    """Build a decaying, slightly inharmonic pluck from three partials."""
    frame_count = int(SAMPLE_RATE * VOICE_SECONDS)
    samples = array("f", [0.0]) * frame_count
    fundamental = 440.0 * 2 ** ((note - 69) / 12)
    partials = ((1.0, 0.66, 2.8), (2.76, 0.24, 5.5), (5.4, 0.10, 8.0))

    for index in range(frame_count):
        time = index / SAMPLE_RATE
        sample = 0.0
        for ratio, amplitude, decay in partials:
            envelope = math.exp(-decay * time)
            sample += amplitude * envelope * math.sin(
                2 * math.pi * fundamental * ratio * time
            )
        samples[index] = sample

    peak = max(abs(sample) for sample in samples)
    if peak:
        scale = 0.92 / peak
        for index in range(frame_count):
            samples[index] *= scale
    return samples


def render_wav(attacks: list[tuple[float, int, int]], wav_path: Path) -> None:
    total_frames = int((attacks[-1][0] + OUTPUT_TAIL_SECONDS) * SAMPLE_RATE)
    mix = array("f", [0.0]) * total_frames
    voices: dict[int, array] = {}

    for seconds, note, velocity in attacks:
        if note not in voices:
            voices[note] = make_voice(note)
        voice = voices[note]
        start = int(seconds * SAMPLE_RATE)
        gain = (velocity / 127.0) ** 0.7
        count = min(len(voice), total_frames - start)
        for index in range(count):
            mix[start + index] += voice[index] * gain

    peak = max(abs(sample) for sample in mix) or 1.0
    output = array("h")
    scale = 0.92 / peak
    for sample in mix:
        output.append(int(max(-1.0, min(1.0, sample * scale)) * 32767))

    if output.itemsize != 2:
        raise RuntimeError("This platform does not support 16-bit PCM output")
    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(output.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export MIDI using the music-box notes from the photo strip configuration."
    )
    parser.add_argument("midi", type=Path, help="Input MIDI file")
    parser.add_argument("bpm", type=float, help="Playback tempo in quarter notes per minute")
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        parser.error("ffmpeg was not found; install FFmpeg and make sure ffmpeg is on PATH")

    try:
        attacks = collect_attacks(args.midi, args.bpm)
        output_path = args.midi.with_name(f"{args.midi.stem}_musicbox.mp3")
        if output_path.exists():
            raise FileExistsError(f"Output already exists; refusing to overwrite: {output_path}")
        with tempfile.TemporaryDirectory(prefix="musicbox-") as temp_dir:
            wav_path = Path(temp_dir) / "render.wav"
            render_wav(attacks, wav_path)
            subprocess.run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-n",
                    "-i",
                    str(wav_path),
                    "-codec:a",
                    "libmp3lame",
                    "-q:a",
                    "2",
                    str(output_path),
                ],
                check=True,
            )
        print(f"Exported {len(attacks)} notes at {args.bpm:g} BPM: {output_path}")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
