from __future__ import annotations


def _pitch_label(pitch: int) -> str:
    names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    return f"{names[pitch % 12]}{pitch // 12 - 1}"


def _viewpoint_label(viewpoint: tuple[int, int, bool, bool] | None) -> str | None:
    if viewpoint is None:
        return None
    pitch, duration_bin, overlaps_left, overlaps_right = viewpoint
    overlap_label = ""
    if overlaps_left or overlaps_right:
        sides = []
        if overlaps_left:
            sides.append("left")
        if overlaps_right:
            sides.append("right")
        overlap_label = f", overlaps {'/'.join(sides)}"
    return (
        f"{_pitch_label(int(pitch))}, duration bin {int(duration_bin)}{overlap_label}"
    )
