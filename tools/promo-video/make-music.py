"""Writes a gentle, original 30-second romantic background track (no samples, no licensing).

Soft pad chords (Cmaj9 - Am9 - Fmaj9 - G6) with a slow bell-like arpeggio, fading in and out.
Usage: python3 make-music.py output.wav
"""
import math
import struct
import sys
import wave

RATE = 44100
LENGTH = 30.0
BEAT = 60 / 72  # 72 beats per minute
CHORD_BEATS = 4

# Frequencies in Hz.
def note(n):  # n semitones from A4
    return 440.0 * 2 ** (n / 12)

C3, E3, G3, A3, B3 = note(-21), note(-17), note(-14), note(-12), note(-10)
C4, D4, E4, F4, G4, A4, B4 = note(-9), note(-7), note(-5), note(-4), note(-2), note(0), note(2)
F3, D3 = note(-16), note(-19)
CHORDS = [
    ([C3, G3, B3, D4, E4], [E4, G4, B4, D4 * 2, B4, G4, E4, D4]),           # Cmaj9
    ([A3 / 2, E3, G3, B3, C4], [C4, E4, G4, B4, G4, E4, C4, B3]),            # Am9
    ([F3 / 2, C3, E3, A3, G4 / 2], [A4 / 2, C4, E4, G4, E4, C4, A4 / 2, G3]),  # Fmaj9
    ([G3 / 2, D3, G3, B3, E4], [D4, G4, B4, E4 * 2, B4, G4, D4, B3]),         # G6
]

samples = []
total = int(RATE * LENGTH)
chord_len = BEAT * CHORD_BEATS
for i in range(total):
    t = i / RATE
    index = int(t // chord_len) % len(CHORDS)
    pad, arpeggio = CHORDS[index]
    in_chord = t % chord_len
    # Pad: soft sines with gentle attack and release around each chord change.
    env = min(1.0, in_chord / 0.8) * min(1.0, (chord_len - in_chord) / 0.6 + 0.35)
    value = 0.0
    for k, f in enumerate(pad):
        value += math.sin(2 * math.pi * f * t + k) * 0.06 + math.sin(2 * math.pi * f * 1.003 * t) * 0.03
    value *= env
    # Bell arpeggio: one note every half beat, exponential decay.
    step = BEAT / 2
    position = int(in_chord // step)
    since = in_chord - position * step
    f = arpeggio[position % len(arpeggio)]
    value += (math.sin(2 * math.pi * f * 2 * t) * 0.10 + math.sin(2 * math.pi * f * 4 * t) * 0.02) * math.exp(-since * 3.2)
    # Overall fade in (1.5 s) and out (2.5 s).
    master = min(1.0, t / 1.5) * min(1.0, (LENGTH - t) / 2.5)
    samples.append(max(-1.0, min(1.0, value * master * 0.9)))

with wave.open(sys.argv[1], "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(RATE)
    out.writeframes(b"".join(struct.pack("<h", int(s * 32000)) for s in samples))
print("wrote", sys.argv[1], f"{LENGTH:.0f}s")
