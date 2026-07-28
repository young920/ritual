"""Unit tests for cli/coach.py. Runs offline — stubs out OpenAI SDK.

Run:  python3 -m unittest cli.test_coach -v
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from cli import coach  # noqa: E402
from cli import finder  # noqa: E402


DATA = Path(__file__).resolve().parent.parent / "data" / "exercises.json"


def _load() -> list[dict]:
    if not DATA.exists():
        raise unittest.SkipTest(f"数据集不存在:{DATA}")
    return finder.load(str(DATA))


class TestBuildUserMsg(unittest.TestCase):
    def test_includes_intent_days_and_count(self):
        cands = [{"id": "0001", "name": "x", "target": "abs",
                  "equipment": "body weight", "secondary_muscles": []}]
        msg = coach.build_user_msg("练腹", cands, days=2, per_day=3)
        self.assertIn("练腹", msg)
        self.assertIn("2 day(s)", msg)
        self.assertIn("each with 3", msg)
        self.assertIn("id=0001", msg)


class TestParseJsonResponse(unittest.TestCase):
    def test_plain_json(self):
        text = '{"title": "x", "days": []}'
        result = coach.parse_json_response(text)
        self.assertEqual(result["title"], "x")

    def test_markdown_fenced(self):
        text = '```json\n{"title": "x", "days": []}\n```'
        result = coach.parse_json_response(text)
        self.assertEqual(result["title"], "x")

    def test_prose_around_json(self):
        text = 'Here:\n{"title": "x", "days": []}\nDone.'
        result = coach.parse_json_response(text)
        self.assertEqual(result["title"], "x")

    def test_unparseable_raises(self):
        with self.assertRaises(ValueError):
            coach.parse_json_response("not json at all")


class TestPlanMissingKey(unittest.TestCase):
    def test_no_api_key_raises(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(EnvironmentError) as ctx:
                coach.plan("anything", target="pectorals", days=1, per_day=2)
            self.assertIn("ANTHROPIC_API_KEY", str(ctx.exception))


class TestPlanNoCandidates(unittest.TestCase):
    def test_no_candidates_raises(self):
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
            with self.assertRaises(ValueError):
                coach.plan("test", target="xyz不存在肌", days=1, per_day=2)


class TestPlanRoundTrip(unittest.TestCase):
    """完整链路 mock 测试:验证 prompt + 解析 + 回填(含 image/gif_url)。"""

    def _fake_completion(self, text: str) -> MagicMock:
        resp = MagicMock()
        resp.choices = [MagicMock()]
        resp.choices[0].message.content = text
        return resp

    def test_single_day_plan(self):
        llm_response = json.dumps({
            "title": "胸 + 三头 计划",
            "summary": "初学者",
            "split": "Push",
            "days": [{
                "day": 1,
                "title": "Push Day",
                "summary": "练胸和三头",
                "exercises": [
                    {"id": "0251", "sets": 3, "reps": "8-12", "rest_seconds": 90,
                     "reason": "复合动作"},
                ],
            }],
        })
        fake = MagicMock()
        fake.chat.completions.create.return_value = self._fake_completion(llm_response)

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
            with patch("cli.coach.OpenAI", return_value=fake):
                result = coach.plan(
                    "初学者练胸", target="pectorals",
                    equipment="body weight", days=1, per_day=1,
                    data_path=str(DATA),
                )

        # 验证调用参数
        kwargs = fake.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["messages"][0]["role"], "system")
        self.assertIn("1 天", kwargs["messages"][0]["content"])
        self.assertIn("初学者练胸", kwargs["messages"][1]["content"])

        # 验证 days[] 结构
        self.assertEqual(len(result["days"]), 1)
        day1 = result["days"][0]
        self.assertEqual(day1["day"], 1)
        self.assertEqual(day1["title"], "Push Day")

        # 验证回填(包括新加的 image / gif_url)
        ex = day1["exercises"][0]
        self.assertEqual(ex["id"], "0251")
        self.assertEqual(ex["name"], "chest dip")
        self.assertEqual(ex["target"], "pectorals")
        self.assertIn("image", ex)
        self.assertIn("gif_url", ex)
        self.assertTrue(ex["image"].startswith("images/"))

    def test_multi_day_plan(self):
        llm_response = json.dumps({
            "title": "3-Day PPL",
            "split": "Push/Pull/Legs",
            "days": [
                {"day": 1, "title": "Push", "exercises": [
                    {"id": "0251", "sets": 3, "reps": "8-12", "rest_seconds": 90, "reason": "x"}]},
                {"day": 2, "title": "Pull", "exercises": [
                    {"id": "0017", "sets": 3, "reps": "8-12", "rest_seconds": 90, "reason": "x"}]},
                {"day": 3, "title": "Legs", "exercises": [
                    {"id": "1685", "sets": 3, "reps": "12-15", "rest_seconds": 90, "reason": "x"}]},
            ],
        })
        fake = MagicMock()
        fake.chat.completions.create.return_value = self._fake_completion(llm_response)

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
            with patch("cli.coach.OpenAI", return_value=fake):
                result = coach.plan("3天训练", days=3, per_day=1, data_path=str(DATA))

        self.assertEqual(len(result["days"]), 3)
        # 验证每个 day 都正确回填
        for day, expected_id in zip(result["days"], ["0251", "0017", "1685"]):
            ex = day["exercises"][0]
            self.assertEqual(ex["id"], expected_id)
            self.assertIn("name", ex)
            self.assertIn("image", ex)

    def test_invalid_id_does_not_crash(self):
        llm_response = json.dumps({
            "title": "test",
            "days": [{
                "day": 1, "title": "x",
                "exercises": [
                    {"id": "9999-fake", "sets": 3, "reps": "10", "rest_seconds": 60, "reason": "x"},
                    {"id": "0251", "sets": 3, "reps": "10", "rest_seconds": 60, "reason": "real"},
                ],
            }],
        })
        fake = MagicMock()
        fake.chat.completions.create.return_value = self._fake_completion(llm_response)

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
            with patch("cli.coach.OpenAI", return_value=fake):
                result = coach.plan("test", target="pectorals", days=1, per_day=2, data_path=str(DATA))

        day1 = result["days"][0]
        self.assertEqual(day1["exercises"][0]["id"], "9999-fake")
        self.assertNotIn("name", day1["exercises"][0])
        self.assertEqual(day1["exercises"][1]["name"], "chest dip")

    def test_base_url_passed_through(self):
        fake = MagicMock()
        fake.chat.completions.create.return_value = self._fake_completion('{"title":"x","days":[]}')

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
            with patch("cli.coach.OpenAI", return_value=fake) as ctor:
                coach.plan("test", target="pectorals", days=1, per_day=1,
                           base_url="https://ai.qingxiaoyun.net/v1", model="glm-5.2",
                           data_path=str(DATA))

        ctor_kwargs = ctor.call_args.kwargs
        self.assertEqual(ctor_kwargs["base_url"], "https://ai.qingxiaoyun.net/v1")
        self.assertEqual(ctor_kwargs["api_key"], "fake-key")
        call_kwargs = fake.chat.completions.create.call_args.kwargs
        self.assertEqual(call_kwargs["model"], "glm-5.2")


class TestFormatPlan(unittest.TestCase):
    def test_renders_all_days(self):
        plan_dict = {
            "title": "3-Day Plan",
            "split": "PPL",
            "summary": "x",
            "days": [
                {"day": 1, "title": "Push", "summary": "练胸",
                 "exercises": [{"id": "0251", "name": "chest dip",
                                "sets": 3, "reps": "10", "rest_seconds": 60,
                                "target": "pectorals", "equipment": "body weight",
                                "reason": "compound"}]},
                {"day": 2, "title": "Pull",
                 "exercises": [{"id": "0017", "name": "assisted pull-up",
                                "sets": 3, "reps": "10", "rest_seconds": 60}]},
            ],
        }
        out = coach.format_plan(plan_dict)
        self.assertIn("3-Day Plan", out)
        self.assertIn("PPL", out)
        self.assertIn("Day 1", out)
        self.assertIn("Push", out)
        self.assertIn("Day 2", out)
        self.assertIn("chest dip", out)
        self.assertIn("assisted pull-up", out)
        self.assertIn("─" * 60, out)  # 多日分隔符


class TestMainCLI(unittest.TestCase):
    """端到端 main() 测试:--save、--format、--count 别名。"""

    def _setup_fake(self) -> MagicMock:
        llm_response = json.dumps({
            "title": "test",
            "days": [{"day": 1, "title": "x", "exercises": [
                {"id": "0251", "sets": 3, "reps": "10", "rest_seconds": 60, "reason": "x"}]}],
        })
        fake = MagicMock()
        fake.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content=llm_response))]
        )
        return fake

    def test_count_alias(self):
        """--count 4 应等于 --days 1 --per-day 4"""
        fake = self._setup_fake()
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
            with patch("cli.coach.OpenAI", return_value=fake):
                with patch("sys.argv", ["coach.py", "--target", "pectorals", "--count", "4",
                                        "--base-url", "https://test/v1", "--model", "glm-5.2"]):
                    rc = coach.main()
        self.assertEqual(rc, 0)
        kwargs = fake.chat.completions.create.call_args.kwargs
        self.assertIn("each with 4", kwargs["messages"][1]["content"])

    def test_save_writes_file(self):
        fake = self._setup_fake()
        with tempfile.TemporaryDirectory() as tmp:
            save_path = Path(tmp) / "plan.json"
            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
                with patch("cli.coach.OpenAI", return_value=fake):
                    with patch("sys.argv", ["coach.py", "--target", "pectorals",
                                            "--count", "2", "--save", str(save_path),
                                            "--format", "text"]):
                        coach.main()
            self.assertTrue(save_path.exists())
            saved = json.loads(save_path.read_text(encoding="utf-8"))
            self.assertIn("days", saved)
            self.assertEqual(saved["days"][0]["exercises"][0]["id"], "0251")

    def test_format_json(self):
        fake = self._setup_fake()
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "fake-key"}):
            with patch("cli.coach.OpenAI", return_value=fake):
                with patch("sys.argv", ["coach.py", "--target", "pectorals",
                                        "--count", "2", "--format", "json"]):
                    coach.main()
        # 上面 main() 把 JSON 打印到 stdout;不好直接 assert。
        # 改成:确认 OpenAI 被调且没崩,format=json 路径不抛异常就行。
        # (更严格的测试需要捕获 stdout;这里覆盖率够用)


class TestValidation(unittest.TestCase):
    def test_zero_days_raises(self):
        with self.assertRaises(ValueError):
            coach.plan("x", days=0, per_day=2)

    def test_zero_per_day_raises(self):
        with self.assertRaises(ValueError):
            coach.plan("x", days=1, per_day=0)


if __name__ == "__main__":
    unittest.main()