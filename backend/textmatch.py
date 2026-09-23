"""Shared fuzzy-string primitives - used by validation (duplicate/ownership-conflict
detection) and by the extraction correction-reuse lookup, so both draw on one definition
of "close enough to be the same, modulo OCR noise"."""


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for row, char_a in enumerate(a, start=1):
        current = [row] + [0] * len(b)
        for col, char_b in enumerate(b, start=1):
            cost = 0 if char_a == char_b else 1
            current[col] = min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + cost)
        previous = current
    return previous[-1]


def similar(a: str, b: str, max_ratio: float) -> bool:
    """Fuzzy-equal within max_ratio of edit distance (as a fraction of the longer string's
    length) - tolerates a mangled digit/character without treating any two short, mostly-
    unrelated strings as a match."""
    if not a or not b:
        return False
    if a == b:
        return True
    if min(len(a), len(b)) <= 2:
        return False
    distance = levenshtein(a, b)
    return distance <= max(1, round(max_ratio * max(len(a), len(b))))
