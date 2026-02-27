"""Zelda 1 overworld / dungeon map utilities.

Provides adjacency checks and position helpers for the
16x8 overworld grid (128 rooms) and 8x8 dungeon grid (64 rooms).

The NES encodes room position as a single byte:
  position = row * grid_cols + col
  row = position // grid_cols
  col = position % grid_cols
"""

# Grid dimensions
OVERWORLD_COLS = 16
OVERWORLD_ROWS = 8
DUNGEON_COLS = 8
DUNGEON_ROWS = 8


def is_adjacent(pos1: int, pos2: int, grid_cols: int) -> bool:
    """Check if two grid positions are adjacent (up/down/left/right).

    Same-room (pos1 == pos2) is considered adjacent.
    Diagonal moves are NOT adjacent.
    Respects row boundaries (col 0 and col max-1 do not wrap).
    """
    if pos1 == pos2:
        return True
    row1, col1 = divmod(pos1, grid_cols)
    row2, col2 = divmod(pos2, grid_cols)
    return abs(row1 - row2) + abs(col1 - col2) == 1


def position_to_rc(pos: int, grid_cols: int) -> tuple[int, int]:
    """Convert position byte to (row, col) tuple."""
    return divmod(pos, grid_cols)


def grid_cols_for_screen(screen_type: str) -> int:
    """Return the grid width for a given screen type."""
    return DUNGEON_COLS if screen_type == 'dungeon' else OVERWORLD_COLS
