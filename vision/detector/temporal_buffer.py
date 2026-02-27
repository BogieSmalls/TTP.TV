"""Temporal smoothing buffer for NES game state detection.

Requires state changes to persist across N consecutive frames before
being accepted into the stable state. This prevents single-frame
misdetection flicker (e.g. hearts briefly reading wrong during
screen transitions).

Inspired by nestrischamps' 3-frame temporal buffering approach.
"""

from dataclasses import asdict
from typing import Any

import numpy as np

from .nes_state import NesStateDetector, GameState


class TemporalBuffer:
    """Temporal smoothing wrapper around NesStateDetector.

    Each field is independently buffered. A field's stable value only
    updates when the last `buffer_size` raw readings all agree.

    Args:
        detector: The NesStateDetector to wrap.
        buffer_size: Number of consecutive matching frames required.
    """

    def __init__(self, detector: NesStateDetector, buffer_size: int = 3):
        self.detector = detector
        self.buffer_size = buffer_size
        self.pending: dict[str, list[Any]] = {}
        self.stable_state: dict[str, Any] = {}
        self.frame_count = 0

    def process_frame(self, frame: np.ndarray) -> GameState:
        """Detect game state with temporal smoothing applied.

        Args:
            frame: 256x240 BGR NES frame.

        Returns:
            GameState with stable (smoothed) values.
        """
        raw_state = self.detector.detect(frame)
        raw_dict = raw_state.to_dict()
        self.frame_count += 1

        for key, value in raw_dict.items():
            history = self.pending.setdefault(key, [])
            history.append(value)

            # Keep only the last buffer_size readings
            if len(history) > self.buffer_size:
                history.pop(0)

            # Accept if all recent values agree
            if len(history) >= self.buffer_size and _all_equal(history):
                self.stable_state[key] = value

        # Build stable GameState
        result = GameState()
        for key, value in self.stable_state.items():
            if hasattr(result, key):
                setattr(result, key, value)

        return result

    def get_raw_and_stable(self, frame: np.ndarray) -> tuple[GameState, GameState]:
        """Return both raw (unsmoothed) and stable (smoothed) state.

        Useful for learn mode to compare raw vs smoothed detection.
        """
        raw_state = self.detector.detect(frame)
        raw_dict = raw_state.to_dict()
        self.frame_count += 1

        for key, value in raw_dict.items():
            history = self.pending.setdefault(key, [])
            history.append(value)
            if len(history) > self.buffer_size:
                history.pop(0)
            if len(history) >= self.buffer_size and _all_equal(history):
                self.stable_state[key] = value

        stable = GameState()
        for key, value in self.stable_state.items():
            if hasattr(stable, key):
                setattr(stable, key, value)

        return raw_state, stable

    def reset(self) -> None:
        """Clear all buffered state."""
        self.pending.clear()
        self.stable_state.clear()
        self.frame_count = 0


def _all_equal(values: list[Any]) -> bool:
    """Check if all values in a list are equal."""
    if not values:
        return True
    first = values[0]
    for v in values[1:]:
        if v != first:
            return False
    return True
