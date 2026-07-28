"""AI workout coach: compose day-based workout plans via LLM.

Pipeline:
  1. CLI parses intent (natural language + optional hard filters)
  2. finder.find_by_criteria narrows candidates
  3. Build prompt with candidates + user intent + day count
  4. Call LLM (OpenAI-compatible SDK; works with Anthropic, Zhipu GLM,
     QingXiaoyun, and most aggregators that follow chat-completions)
  5. Parse JSON output (tolerate markdown fences)
  6. Resolve exercise IDs back to full records (name/target/equipment/image/gif_url)
  7. Output as text (default) or JSON; optionally save to file

Public entry point: plan(...)
CLI: `python cli/coach.py "..." --days N --per-day M ...`
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from openai import OpenAI
import anthropic

import cli.finder as finder

DEFAULT_DATA = Path(__file__).resolve().parent.parent / "data" / "exercises.json"
DEFAULT_MODEL = "glm-4.5"
DEFAULT_BASE_URL: str | None = os.environ.get("ANTHROPIC_BASE_URL")  # 兼容 Claude Code 本地代理
DEFAULT_PER_DAY = 4
DEFAULT_CANDIDATE_LIMIT = 40
API_KEY_ENV = "ANTHROPIC_API_KEY"


def _system_prompt(days: int, warmup_pool: list[dict]) -> str:
    pool_str = _format_warmup_pool(warmup_pool)
    return f"""你是健身教练。用户给一段意图和一个候选动作列表(已按目标肌/器械预筛选)。
请生成一个 **{days} 天** 的训练计划,每天一组动作,只输出 JSON,不要任何额外文字或 markdown 包裹。

JSON schema(所有计划都是这个 schema,即使只有 1 天):
{{
  "title": "一句话训练计划标题",
  "summary": "一句话说明这个计划适合谁/练什么",
  "split": "例如 Push/Pull/Legs / Upper/Lower / Full Body",
  "days": [
    {{
      "day": 1,
      "title": "Day 1 主题,如 Push Day / 上肢推 / 练胸日",
      "summary": "这天的目标一句话",
      "warmup": {{
        "duration_sec": 60,
        "voice_intro": "热身一分钟,跟着节奏做关节绕环",
        "phases": [
          {{"name": "颈绕环", "sec": 12, "tip": "缓慢绕动,放松颈椎", "exercise_id": "1403"}},
          {{"name": "肩绕环", "sec": 12, "tip": "前后各 6 次,打开肩胛", "exercise_id": "0669"}},
          {{"name": "动态胸椎", "sec": 12, "tip": "猫式伸展,打开胸椎", "exercise_id": "1167"}},
          {{"name": "激活", "sec": 36, "tip": "徒手动作把目标肌叫醒", "exercise_id": "0002"}}
        ]
      }},
      "exercises": [
        {{
          "id": "0001",
          "sets": 3,
          "reps": "8-12",
          "rest_seconds": 60,
          "sec_per_rep": 6,
          "voice_intro": "哑铃卧推,8 次,主要练胸,慢下快推",
          "phases": [
            {{"name": "准备", "sec": 0.5, "tip": "吸气,核心收紧"}},
            {{"name": "下放", "sec": 2.0, "tip": "控制速度,肘部贴近身体"}},
            {{"name": "推起", "sec": 1.5, "tip": "呼气发力,胸肌主导"}},
            {{"name": "收紧", "sec": 0.5, "tip": "顶峰停顿,肩胛骨后缩"}}
          ],
          "reason": "为什么选这个(一句话)"
        }}
      ],
      "cooldown": {{
        "duration_sec": 60,
        "voice_intro": "拉伸一分钟,每个动作保持 30 秒",
        "phases": [
          {{"name": "胸部拉伸", "sec": 30, "tip": "前臂贴墙,身体前压"}},
          {{"name": "肩部拉伸", "sec": 30, "tip": "一手过头,另一手拉向"}}
        ]
      }}
    }}
  ]
}}

规则:
- 只能从 candidates 列表里挑(用它们的 id)
- 共生成 {days} 个 day,每天 {DEFAULT_PER_DAY} 个动作(可用 --per-day 调整)
- 合理 split:常见的有 Push/Pull/Legs(3 天)、Upper/Lower(4 天)、Bro split(5 天)、Full Body
- 一天内同一肌群不要重复(不要同时选卧推 + 哑铃卧推)
- 不同天之间尽量不重复动作(除非刻意安排的频次)
- 考虑经验等级:初学者优先复合动作 + 少组数;进阶者可以加孤立动作 + 多组数
- 组数:典型 3-5 组;次数:力量 3-6、增肌 8-12、耐力 12+;休息:复合动作 90-180s,孤立 60-90s
- **每个动作的「起承转合」必须分析清楚**,不是统一的 4 步,不同动作不同:
  - **phases 数组(必须填)**:`[{{"name": "...", "sec": X.X, "tip": "..."}}]`
  - **sec_per_rep**(整个 rep 的总时长,必须填)= phases 里所有 sec 之和
  - phases 的 sec 不必相等:离心(下放/下落)通常 1.5-2.5s(慢控),向心(推起/起身)1.0-1.5s(发力快),起止(准备/收紧)0.3-0.8s(停顿)
  - 不同动作的典型 phase 拆解参考(不强制,按动作实际来):
    * **俯卧撑类(推)**:准备→下放(慢)→推起(发力)→收紧
    * **深蹲类(蹲)**:准备→下蹲(慢)→起身(发力)→锁定
    * **硬拉类(拉)**:准备→下放→拉起(发力)→顶峰
    * **跳跃类(爆发)**:蓄力→起跳→落地→缓冲
    * **平板支撑**:调位→保持(长)→保持(长)→放松
    * **弯举类(孤立)**:准备→弯起(发力)→挤压→下放(慢)
    * **划船类(拉)**:准备→拉近→挤压→回放(慢)
- **voice_intro(必须填,且不超过 30 字)**:动作开始时念给用户听的话。
  - 包含:动作名 + 次数 + 目标肌 + 一个关键要点
  - 风格:教练口吻,专业克制,不要"加油""你最棒"之类的鸡汤
  - 例:「哑铃卧推,8 次,主要练胸,慢下快推」
- **warmup / cooldown(每天必须填,名称对位硬约束)**:
  - 总时长 30-90 秒,warmup 不要超过 90s,cooldown 不要超过 120s
  - warmup 至少 3 个 phase,cooldown 至少 2 个 phase
  - warmup 要针对当天主肌群设计;cooldown 拉伸今天练过的部位

  - **每个 phase 必须从下面 WARMUP_POOL 里挑 `exercise_id`**(库里所有真人 GIF 的柔韧/活动度动作):
{pool_str}
  - **`phase.name 必须等于库里英文原名`**(从 WARMUP_POOL 的 `name="..."` 字段原文复制)
  - **库里没有的「绕环」就别硬塞**:库里有 wrist circles / ankle circles;但没有「肩绕环」「颈绕环」,肩部只有 rear deltoid stretch,颈部只有 neck side stretch — 不合适的就别挑,留空 exercise_id 即可
  - **`tip` 字段写中文**(给前端展示用),格式:`"中文译名,一句话要点"`
  - **绝对禁止**把 archer push up / push up / squat / press 这种力量动作塞进 warmup
  - **绝对禁止**用库里没有的中文名(如「肩绕环」「颈绕环」)
  - 如果 WARMUP_POOL 里实在没合适的,phase.exercise_id 可以省略,但 phase.name + 完整中文 tip 必须填 — 前端会显示「听语音引导」卡片
  - cooldown 同样从 WARMUP_POOL 里挑,优先 stretch 类,避开 circles / rotation

- 如果用户意图里指定了器械或次数,优先按用户来
- 不要重复同一动作的不同变种
"""


def _format_candidates(candidates: list[dict]) -> str:
    lines = []
    for c in candidates:
        lines.append(
            f"- id={c['id']} | {c['name']} | target={c['target']} | "
            f"equipment={c['equipment']} | secondary={','.join(c.get('secondary_muscles', []))}"
        )
    return "\n".join(lines)


# warmup/cooldown 适用动作:库里所有 stretch / circles / rotation / mobility 类徒手动作。
# LLM 必须从这些里挑,且 phase.name = 库里英文原名(可附中文译名)。
_WARMUP_KEYWORDS = ("stretch", "circle", "circles", "rotation", "mobility", "reach", "relax")


def _find_warmup_cooldown_pool(exercises: list[dict]) -> list[dict]:
    """库里所有可作为 warmup/cooldown 的动作(柔韧/活动度/拉伸,徒手为主)。

    命名对位硬约束:LLM 只能从这个池子里挑 phase.exercise_id。
    """
    pool = []
    for e in exercises:
        name = e.get("name", "").lower()
        if any(k in name for k in _WARMUP_KEYWORDS):
            equip = (e.get("equipment") or "").lower()
            if equip in ("body weight", "other", ""):
                pool.append(e)
    pool.sort(key=lambda e: e["id"])
    return pool


def _format_warmup_pool(pool: list[dict]) -> str:
    """给 LLM 一份「必须从这里挑」的清单。"""
    lines = []
    for e in pool:
        lines.append(f"- id={e['id']}  name=\"{e['name']}\"  target={e['target']}")
    return "\n".join(lines)


def build_user_msg(intent: str, candidates: list[dict], days: int, per_day: int,
                   warmup_pool: list[dict]) -> str:
    return (
        f"User intent: {intent}\n"
        f"Generate {days} day(s), each with {per_day} exercises.\n\n"
        f"Main candidates:\n{_format_candidates(candidates)}\n\n"
        f"WARMUP_POOL (库里所有可作为 warmup/cooldown 的真人演示动作,phase.exercise_id 必须从这里挑):\n"
        f"{_format_warmup_pool(warmup_pool)}"
    )


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _try_parse(text: str) -> dict | None:
    """尝试各种容错路径解析 JSON。返回 dict 或 None。"""
    if not text:
        return None
    text = text.strip()
    # 1. 原文直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 2. 去掉 ```json ... ``` 围栏
    m = _JSON_FENCE_RE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    # 3. 找第一个 { 到**配对**的 } (扫描深度,不要用 rfind,会被字符串里的 } 误导)
    start = text.find("{")
    if start >= 0:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            c = text[i]
            if esc:
                esc = False
                continue
            if c == "\\":
                esc = True
                continue
            if c == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
    return None


def parse_json_response(text: str) -> dict:
    """LLM 输出 JSON 解析器(容错)。失败时抛 JSONDecodeError(不是 ValueError)。"""
    parsed = _try_parse(text)
    if parsed is not None:
        return parsed
    raise json.JSONDecodeError(
        f"LLM 输出无法解析为 JSON(已尝试剥围栏/扫描配对):\n{text[:500]}",
        text or "", 0,
    )


def _hydrate(by_id: dict[str, dict], item: dict) -> None:
    """把 plan 里的动作 id 回填成完整记录(就地修改)。

    兜底:LLM 瞎填 id(库里不存在)时,根据 target + equipment 找最接近的库项,
    至少保证 name 不空,不让前端显示空白卡片。
    """
    ex = by_id.get(item.get("id", ""))
    if not ex:
        # 兜底:用 target + equipment 在库里找最匹配的
        target = (item.get("target") or "").strip().lower()
        equip = (item.get("equipment") or "").strip().lower()
        cands = [e for e in by_id.values()
                 if (not target or e.get("target", "").lower() == target)
                 and (not equip or e.get("equipment", "").lower() == equip)]
        if cands:
            # 优先 body weight
            for c in cands:
                if c.get("equipment", "").lower() == "body weight":
                    ex = c
                    break
            else:
                ex = cands[0]
    if not ex:
        return
    item["id"] = ex["id"]  # 把瞎填的 id 修正
    item["name"] = ex["name"]
    item["target"] = ex["target"]
    item["equipment"] = ex["equipment"]
    item["image"] = ex.get("image", "")
    item["gif_url"] = ex.get("gif_url", "")


def _hydrate_phase(by_id: dict[str, dict], phase: dict,
                  warmup_pool_by_name: dict[str, dict]) -> None:
    """warmup/cooldown phase:exercise_id 存在时强制覆盖 name = 库原名(保证图文一致)。

    如果 exercise_id 缺失但 phase.name 能精确匹配库名,自动补上 exercise_id。
    """
    if not isinstance(phase, dict):
        return
    eid = phase.get("exercise_id")
    if eid:
        ex = by_id.get(eid)
        if not ex:
            return
        phase["name"] = ex["name"]  # 强制覆盖,LLM 即使填了「肩绕环」也会被改成 rear deltoid stretch
        phase["image_cdn"] = ex.get("image", "")
        phase["gif_cdn"] = ex.get("gif_url", "")
        return
    # 兜底:LLM 忘了填 exercise_id,但 phase.name 命中库名 → 自动补
    pname = (phase.get("name") or "").strip().lower()
    if pname and pname in warmup_pool_by_name:
        ex = warmup_pool_by_name[pname]
        phase["exercise_id"] = ex["id"]
        phase["name"] = ex["name"]
        phase["image_cdn"] = ex.get("image", "")
        phase["gif_cdn"] = ex.get("gif_url", "")


def plan(
    intent: str,
    *,
    days: int = 1,
    per_day: int = DEFAULT_PER_DAY,
    target: str | list[str] | None = None,
    body_part: str | None = None,
    muscle_group: str | None = None,
    equipment: str | list[str] | None = None,
    model: str = DEFAULT_MODEL,
    base_url: str | None = DEFAULT_BASE_URL,
    data_path: str | None = None,
    api_key: str | None = None,
) -> dict:
    """Compose a workout plan. Returns dict with days[] schema.

    `api_key=None` reads from ANTHROPIC_API_KEY env var.
    `base_url=None` uses OpenAI official.
    """
    if days < 1:
        raise ValueError("days 必须 >= 1")
    if per_day < 1:
        raise ValueError("per_day 必须 >= 1")

    api_key = (
        api_key
        or os.environ.get(API_KEY_ENV)
        or os.environ.get("ANTHROPIC_AUTH_TOKEN")  # 兼容 Claude Code 本地代理
    )
    if not api_key:
        raise EnvironmentError(
            "需要 API key。"
            "CLI:export ANTHROPIC_API_KEY=sk-..."
            "Web:在右上角「设置」里填。"
        )

    exercises = finder.load(data_path or str(DEFAULT_DATA))
    candidates = finder.find_by_criteria(
        exercises,
        target=target,
        body_part=body_part,
        muscle_group=muscle_group,
        equipment=equipment,
        limit=DEFAULT_CANDIDATE_LIMIT,
    )
    if not candidates:
        raise ValueError(
            "没找到符合条件的动作。"
            "试试放宽:把过滤条件设为「不指定」,或换个目标肌 / 器械。"
        )

    warmup_pool = _find_warmup_cooldown_pool(exercises)

    # 自动判断协议走对应 SDK:
    # - base_url 以 /v1 结尾 → OpenAI 兼容
    # - base_url 不带 /v1   → Anthropic 兼容
    base_url_clean = (base_url or "").rstrip("/")
    if base_url_clean.endswith("/v1"):
        # OpenAI 路径:base_url 保持 /v1,SDK 会拼 /chat/completions
        is_anthropic = False
        client_kwargs: dict = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url
        client = OpenAI(**client_kwargs)
    else:
        # Anthropic 路径:确保 base_url 不带 /v1 结尾(SDK 会拼 /v1/messages)
        if base_url and base_url_clean.endswith("/v1") is False:
            # base_url 可能是 http://x 或 http://x/v1/messages 等 — 直接用
            pass
        client_kwargs = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url
        is_anthropic = True
        client = anthropic.Anthropic(**client_kwargs)

    if is_anthropic:
        response = client.messages.create(
            model=model,
            max_tokens=4096,
            system=_system_prompt(days, warmup_pool),
            messages=[
                {"role": "user", "content": build_user_msg(intent, candidates, days, per_day, warmup_pool)},
            ],
        )
        raw = response.content[0].text
    else:
        response = client.chat.completions.create(
            model=model,
            max_tokens=4096,
            messages=[
                {"role": "system", "content": _system_prompt(days, warmup_pool)},
                {"role": "user", "content": build_user_msg(intent, candidates, days, per_day, warmup_pool)},
            ],
        )
        raw = response.choices[0].message.content
    plan_dict = parse_json_response(raw)

    # Hydrate: 把 id 映射回完整记录
    by_id = {e["id"]: e for e in exercises}
    warmup_pool = _find_warmup_cooldown_pool(exercises)
    warmup_pool_by_name = {e["name"].strip().lower(): e for e in warmup_pool}
    for day in plan_dict.get("days", []):
        for item in day.get("exercises", []):
            _hydrate(by_id, item)
        # warmup/cooldown phase:exercise_id 存在时强制覆盖 name = 库原名
        for section_name in ("warmup", "cooldown"):
            section = day.get(section_name)
            if section and isinstance(section.get("phases"), list):
                for p in section["phases"]:
                    _hydrate_phase(by_id, p, warmup_pool_by_name)
    return plan_dict


def format_plan(plan_dict: dict) -> str:
    """人读格式:多天之间用分隔符区分。"""
    lines = []
    title = plan_dict.get("title", "Workout Plan")
    split = plan_dict.get("split", "")
    summary = plan_dict.get("summary", "")
    header = f"🏋  {title}"
    if split:
        header += f"  [{split}]"
    lines.append(header)
    if summary:
        lines.append(f"   {summary}")
    lines.append("")

    days_list = plan_dict.get("days", [])
    for i, day in enumerate(days_list):
        if i > 0:
            lines.append("─" * 60)
            lines.append("")
        day_num = day.get("day", i + 1)
        day_title = day.get("title", f"Day {day_num}")
        lines.append(f"📅 Day {day_num} · {day_title}")
        if day.get("summary"):
            lines.append(f"   {day['summary']}")
        lines.append("")
        for j, ex in enumerate(day.get("exercises", []), 1):
            sets = ex.get("sets", "?")
            reps = ex.get("reps", "?")
            rest = ex.get("rest_seconds", "?")
            lines.append(f"  {j}. [{ex.get('id', '?')}] {ex.get('name', '?')}")
            lines.append(f"     {sets} 组 × {reps} 次 · 休息 {rest}s")
            if ex.get("target"):
                lines.append(f"     主肌 {ex['target']} · {ex.get('equipment', '')}")
            if ex.get("reason"):
                lines.append(f"     理由: {ex['reason']}")
            lines.append("")
    return "\n".join(lines).rstrip()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="AI 编排训练计划(plan 是默认动作,可不写)",
        epilog="例:\n"
               "  coach.py 练胸 --target chest --count 4\n"
               "  coach.py 练全身 --days 3 --per-day 4 --save plan.json\n"
               "  coach.py 练腿 --days 1 --per-day 5 --format json",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("intent", nargs="?", default="",
                   help="自然语言意图(可空)")
    p.add_argument("--data", default=str(DEFAULT_DATA))
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help="LLM 模型名,如 glm-5.2 / claude-sonnet-5")
    p.add_argument("--base-url", default=None,
                   help="OpenAI 兼容端点")
    p.add_argument("--target", help="主目标肌,如 pectorals / quads")
    p.add_argument("--body-part", help="部位,如 chest / upper legs")
    p.add_argument("--muscle-group", help="协同肌群")
    p.add_argument("--equipment", help="器械,如 'body weight' / dumbbell")
    p.add_argument("--count", type=int, default=None,
                   help="动作总数(单日计划,等价于 --days 1 --per-day N)")
    p.add_argument("--days", type=int, default=1, help="训练天数")
    p.add_argument("--per-day", type=int, default=DEFAULT_PER_DAY,
                   help="每天动作数")
    p.add_argument("--format", choices=["text", "json"], default="text",
                   help="输出格式:text 默认人类可读,json 给程序用")
    p.add_argument("--save", metavar="PATH", default=None,
                   help="保存 JSON 到指定路径(无论 --format 是什么)")
    return p


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "plan":
        argv = argv[1:]

    parser = build_parser()
    args = parser.parse_args(argv)

    # --count 是 --days 1 --per-day N 的便捷别名
    if args.count is not None:
        if args.days != 1:
            print("--count 和 --days 不能同时用", file=sys.stderr)
            return 1
        days = 1
        per_day = args.count
    else:
        days = args.days
        per_day = args.per_day

    try:
        plan_dict = plan(
            args.intent,
            days=days,
            per_day=per_day,
            target=args.target,
            body_part=args.body_part,
            muscle_group=args.muscle_group,
            equipment=args.equipment,
            model=args.model,
            base_url=args.base_url,
            data_path=args.data,
        )
    except EnvironmentError as e:
        print(str(e), file=sys.stderr)
        return 2
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.save:
        with open(args.save, "w", encoding="utf-8") as f:
            json.dump(plan_dict, f, ensure_ascii=False, indent=2)
        print(f"已保存到 {args.save}", file=sys.stderr)

    if args.format == "json":
        print(json.dumps(plan_dict, ensure_ascii=False, indent=2))
    else:
        print(format_plan(plan_dict))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())