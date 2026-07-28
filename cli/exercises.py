"""CLI for the exercises dataset.

Usage:
    python exercises.py search <query>          # 搜动作
    python exercises.py show <id-or-name>       # 看详情
    python exercises.py alt <id-or-name>        # 找替代动作

Examples:
    python exercises.py search "bench press"
    python exercises.py show 0001
    python exercises.py alt "barbell bench press"
    python exercises.py alt 0001 --no-same-equipment --limit 10
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import finder

DEFAULT_DATA = Path(__file__).resolve().parent.parent / "data" / "exercises.json"


def cmd_search(exercises: list[dict], args: argparse.Namespace) -> int:
    matches = finder.find_by_name(exercises, args.query, limit=args.limit)
    if not matches:
        print(f'没找到匹配 "{args.query}" 的动作', file=sys.stderr)
        return 1
    print(f'搜 "{args.query}",找到 {len(matches)} 个:')
    for e in matches:
        print(f"  [{e['id']}] {e['name']}  ·  {e['target']} · {e['equipment']}")
    return 0


def _format_exercise(e: dict, lang: str = "en") -> str:
    lines = [
        f"[{e['id']}] {e['name']}",
        f"  部位:    {e['body_part']}",
        f"  目标肌:  {e['target']}",
        f"  协同肌:  {e['muscle_group']}  +  {', '.join(e.get('secondary_muscles', []))}",
        f"  器械:    {e['equipment']}",
    ]
    steps = e.get("instruction_steps", {}).get(lang)
    if steps:
        lines.append(f"  步骤({lang}):")
        for i, step in enumerate(steps, 1):
            lines.append(f"    {i}. {step}")
    elif e.get("instructions", {}).get(lang):
        lines.append(f"  说明({lang}): {e['instructions'][lang]}")
    return "\n".join(lines)


def cmd_show(exercises: list[dict], args: argparse.Namespace) -> int:
    e = finder.resolve(exercises, args.query)
    if not e:
        # Maybe multiple prefix matches — show them as a hint
        suggestions = finder.find_by_name(exercises, args.query, limit=5)
        print(f'找不到 "{args.query}"', file=sys.stderr)
        if suggestions:
            print("你是不是想找:", file=sys.stderr)
            for s in suggestions:
                print(f"  [{s['id']}] {s['name']}", file=sys.stderr)
        return 1
    print(_format_exercise(e, lang=args.lang))
    return 0


def cmd_alt(exercises: list[dict], args: argparse.Namespace) -> int:
    source = finder.resolve(exercises, args.query)
    if not source:
        print(f'找不到 "{args.query}",没法找替代。先 search 看看?',file=sys.stderr)
        return 1
    alts = finder.find_alternatives(
        exercises,
        source,
        limit=args.limit,
        exclude_same_equipment=args.no_same_equipment,
    )
    if not alts:
        print(f"「{source['name']}」找不到替代动作。试试 --no-same-equipment 关掉?", file=sys.stderr)
        return 1
    src_name = source["name"]
    src_target = source["target"]
    src_equipment = source["equipment"]
    print(f"「{src_name}」(主肌 {src_target} · {src_equipment}) 的替代动作:")
    print()
    for i, (cand, score, reasons) in enumerate(alts, 1):
        marker = "★" if i == 1 else "·"
        cand_name = cand["name"]
        cand_target = cand["target"]
        cand_equipment = cand["equipment"]
        print(f"  {marker} [{cand['id']}] {cand_name}  (得分 {score})")
        print(f"      主肌 {cand_target} · {cand_equipment}")
        if reasons:
            print(f"      理由: {' · '.join(reasons)}")
    return 0


def cmd_pick(exercises: list[dict], args: argparse.Namespace) -> int:
    """按条件挑动作(反向查找):给定主肌/部位/器械,返回所有匹配。"""
    if not any([args.target, args.body_part, args.muscle_group]):
        print("至少给一个过滤条件:--target / --body-part / --muscle-group", file=sys.stderr)
        print("例: --target pectorals --equipment 'body weight'", file=sys.stderr)
        return 1
    results = finder.find_by_criteria(
        exercises,
        target=args.target,
        body_part=args.body_part,
        muscle_group=args.muscle_group,
        equipment=args.equipment,
        limit=args.limit,
    )
    if not results:
        print("没有匹配的动作。", file=sys.stderr)
        return 1
    # 打印条件摘要
    cond = []
    if args.target:
        cond.append(f"主肌={args.target}")
    if args.body_part:
        cond.append(f"部位={args.body_part}")
    if args.muscle_group:
        cond.append(f"协同={args.muscle_group}")
    if args.equipment:
        cond.append(f"器械={args.equipment}")
    print(f"按 {', '.join(cond)} 找到 {len(results)} 个动作:")
    print()
    for e in results:
        print(f"  [{e['id']}] {e['name']}  ·  {e['target']} · {e['equipment']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="健身动作数据集 CLI")
    p.add_argument("--data", default=str(DEFAULT_DATA), help="exercises.json 路径")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_search = sub.add_parser("search", help="按名字模糊搜索")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=10)
    p_search.set_defaults(func=cmd_search)

    p_show = sub.add_parser("show", help="看一个动作的详情")
    p_show.add_argument("query", help="id 或名字")
    p_show.add_argument("--lang", default="en")
    p_show.set_defaults(func=cmd_show)

    p_alt = sub.add_parser("alt", aliases=["alternatives"], help="找替代动作")
    p_alt.add_argument("query", help="id 或名字")
    p_alt.add_argument("--limit", type=int, default=5)
    p_alt.add_argument("--no-same-equipment", action="store_true",
                       help="排除同器械的(默认保留,可能有用)")
    p_alt.set_defaults(func=cmd_alt)

    p_pick = sub.add_parser("pick", help="按条件反向挑动作")
    p_pick.add_argument("--target", help="主目标肌,如 pectorals / quads / lats")
    p_pick.add_argument("--body-part", help="部位,如 chest / upper legs / back")
    p_pick.add_argument("--muscle-group", help="协同肌群")
    p_pick.add_argument("--equipment", help="器械,如 'body weight' / dumbbell")
    p_pick.add_argument("--limit", type=int, default=20)
    p_pick.set_defaults(func=cmd_pick)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        exercises = finder.load(args.data)
    except FileNotFoundError:
        print(f"找不到数据文件: {args.data}", file=sys.stderr)
        print("先下载:curl -o data/exercises.json https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/data/exercises.json", file=sys.stderr)
        return 2
    return args.func(exercises, args)


if __name__ == "__main__":
    raise SystemExit(main())