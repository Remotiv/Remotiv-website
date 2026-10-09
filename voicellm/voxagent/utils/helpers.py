"""Shared utility functions."""

import os
import glob


def read_text(path: str) -> str:
    """Read a text file and return contents."""
    with open(path, "r") as f:
        return f.read()


def read_questions(directory: str) -> list:
    """Collect sorted .wav file paths from a directory."""
    wavs = sorted(glob.glob(os.path.join(directory, "*.wav")))
    if not wavs:
        raise FileNotFoundError(f"No .wav files found in {directory}")
    return wavs
