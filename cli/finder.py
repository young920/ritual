"""Exercise search and alternative-finding logic.

Pure functions over the exercises dataset. No I/O, no CLI plumbing —
that lives in exercises.py.
"""
from __future__ import annotations

import json
from typing import Iterable

# 器械从「最易获得」到「最特定」,用作 tiebreaker。
# 同样的训练效果,优先推容易获得的(用户更可能在家能做)。
_EQUIPMENT_COMPLEXITY = {
    "body weight": 0,
    "band": 1,
    "dumbbell": 2,
    "kettlebell": 2,
    "medicine ball": 2,
    "stability ball": 3,
    "bosu ball": 3,
    "ez barbell": 3,
    "barbell": 4,
    "cable": 4,
    "smith machine": 4,
    "leverage machine": 5,
    "weighted": 4,
    "other": 5,
}


def load(path: str) -> list[dict]:
    """Load exercises from a JSON file."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def find_by_name(exercises: list[dict], query: str, limit: int = 5) -> list[dict]:
    """Case-insensitive substring match on name. Prefix matches rank first."""
    q = query.lower().strip()
    if not q:
        return []
    matches = [e for e in exercises if q in e["name"].lower()]
    matches.sort(key=lambda e: (not e["name"].lower().startswith(q), e["name"]))
    return matches[:limit]


def get_by_id(exercises: list[dict], exercise_id: str) -> dict | None:
    for e in exercises:
        if e["id"] == exercise_id:
            return e
    return None


def resolve(exercises: list[dict], query: str) -> dict | None:
    """Resolve a query string to a single exercise.

    Tries exact id match first, then exact name match, then prefix match.
    Returns None if ambiguous or not found.
    """
    q = query.lower().strip()
    if not q:
        return None
    if (exact := get_by_id(exercises, q)):
        return exact
    name_matches = [e for e in exercises if e["name"].lower() == q]
    if len(name_matches) == 1:
        return name_matches[0]
    if len(name_matches) > 1:
        return None  # ambiguous
    prefix_matches = [e for e in exercises if e["name"].lower().startswith(q)]
    if len(prefix_matches) == 1:
        return prefix_matches[0]
    return None


def _secondary_overlap(a: dict, b: dict) -> int:
    sa = {m.lower() for m in a.get("secondary_muscles", [])}
    sb = {m.lower() for m in b.get("secondary_muscles", [])}
    return len(sa & sb)


def _equipment_complexity(equipment: str) -> int:
    return _EQUIPMENT_COMPLEXITY.get(equipment.lower(), 5)


def _score(source: dict, candidate: dict) -> tuple[int, list[str]]:
    """Score a candidate against source. Returns (score, reasons).

    Tuned weights (post A-iteration):
      - 同 target          +10
      - 同 body_part       +5
      - secondary 重叠每个 +3 (从 +2 提到 +3,加大区分度)
      - 不同 equipment     +3
      - 同 muscle_group    +1
    """
    score = 0
    reasons: list[str] = []

    if source["target"].lower() == candidate["target"].lower():
        score += 10
        reasons.append(f"同主肌 {candidate['target']}")

    if source["body_part"].lower() == candidate["body_part"].lower():
        score += 5
        reasons.append(f"同部位 {candidate['body_part']}")

    overlap = _secondary_overlap(source, candidate)
    if overlap:
        score += 3 * overlap
        reasons.append(f"{overlap} 个协同肌重合")

    if source["equipment"].lower() != candidate["equipment"].lower():
        score += 3
        reasons.append(f"换 {candidate['equipment']}")

    if source["muscle_group"].lower() == candidate["muscle_group"].lower():
        score += 1

    return score, reasons


def find_alternatives(
    exercises: list[dict],
    source: dict,
    limit: int = 5,
    exclude_same_equipment: bool = False,
) -> list[tuple[dict, int, list[str]]]:
    """Find alternatives to source.

    Sort: score desc, then equipment complexity asc (易获得的优先),
    then id asc (稳定排序,便于测试)。
    """
    scored: list[tuple[dict, int, list[str]]] = []
    for cand in exercises:
        if cand["id"] == source["id"]:
            continue
        if exclude_same_equipment and cand["equipment"].lower() == source["equipment"].lower():
            continue
        score, reasons = _score(source, cand)
        if score == 0:
            continue
        scored.append((cand, score, reasons))
    scored.sort(key=lambda x: (-x[1], _equipment_complexity(x[0]["equipment"]), x[0]["id"]))
    return scored[:limit]


def find_by_criteria(
    exercises: list[dict],
    target: str | list[str] | None = None,
    body_part: str | None = None,
    muscle_group: str | None = None,
    equipment: str | list[str] | None = None,
    limit: int = 20,
) -> list[dict]:
    """Reverse pick: 找符合条件的所有动作。

    target / equipment 接受 str 或 list[str]:
      - None / 空 = 不过滤
      - str  = exercise 字段必须精确等于
      - list = exercise 字段命中任一即可(OR 语义)
    body_part / muscle_group 维持单值(str | None)。
    """
    def as_list(v):
        if v is None: return None
        if isinstance(v, list): return [x.lower() for x in v if x]
        return [v.lower()]

    target_list = as_list(target)
    equipment_list = as_list(equipment)

    def matches(e: dict) -> bool:
        if target_list and e["target"].lower() not in target_list:
            return False
        if body_part and e["body_part"].lower() != body_part.lower():
            return False
        if muscle_group and e["muscle_group"].lower() != muscle_group.lower():
            return False
        if equipment_list and e["equipment"].lower() not in equipment_list:
            return False
        return True

    results = [e for e in exercises if matches(e)]
    # Body weight 优先,然后按器械简易度,然后按名字
    results.sort(key=lambda e: (
        _equipment_complexity(e["equipment"]),
        e["name"],
    ))
    return results[:limit]