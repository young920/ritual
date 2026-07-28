"""Unit tests for cli/finder.py.

Run:  python3 -m unittest cli.test_finder -v
Or:   cd cli && python3 -m unittest test_finder -v
"""
from __future__ import annotations

import unittest
from pathlib import Path

from cli import finder  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "data" / "exercises.json"


def _load() -> list[dict]:
    if not DATA.exists():
        raise unittest.SkipTest(f"数据集不存在:{DATA}。先下载。")
    return finder.load(str(DATA))


class TestFindByName(unittest.TestCase):
    def test_substring_match(self):
        ex = _load()
        result = finder.find_by_name(ex, "bench press")
        self.assertGreater(len(result), 0)
        self.assertTrue(all("bench press" in e["name"].lower() for e in result))

    def test_prefix_match_ranks_first(self):
        ex = _load()
        result = finder.find_by_name(ex, "squat", limit=5)
        # 前几个应该都是 "squat" 开头的
        self.assertTrue(result[0]["name"].lower().startswith("squat"))

    def test_empty_query_returns_empty(self):
        self.assertEqual(finder.find_by_name(_load(), ""), [])
        self.assertEqual(finder.find_by_name(_load(), "  "), [])


class TestResolve(unittest.TestCase):
    def test_by_id(self):
        ex = _load()
        result = finder.resolve(ex, "0001")
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "0001")

    def test_by_exact_name(self):
        ex = _load()
        result = finder.resolve(ex, "3/4 sit-up")
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "0001")

    def test_by_prefix(self):
        ex = _load()
        # "3/4 sit" 是唯一的 prefix 匹配
        result = finder.resolve(ex, "3/4 sit")
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "0001")

    def test_ambiguous_returns_none(self):
        ex = _load()
        # "barbell bench" 是多个动作的前缀,resolve 应该返回 None(歧义)
        result = finder.resolve(ex, "barbell bench")
        self.assertIsNone(result)

    def test_not_found(self):
        self.assertIsNone(finder.resolve(_load(), "xyz不存在"))


class TestFindAlternatives(unittest.TestCase):
    def test_basic_alt(self):
        ex = _load()
        bench = finder.resolve(ex, "barbell bench press")
        self.assertIsNotNone(bench)
        alts = finder.find_alternatives(ex, bench, limit=5)
        self.assertEqual(len(alts), 5)
        # 不应该返回自己
        for cand, _, _ in alts:
            self.assertNotEqual(cand["id"], bench["id"])
        # Top 替代应该跟主肌相关(pectorals)
        names = [c["name"].lower() for c, _, _ in alts]
        # 至少应该有一个"push"相关的(俯卧撑是经典替代)
        self.assertTrue(any("push" in n or "dip" in n or "press" in n for n in names))

    def test_body_weight_ranks_first(self):
        """新调优:同分情况下徒手动作应排在前面。"""
        ex = _load()
        bench = finder.resolve(ex, "barbell bench press")
        alts = finder.find_alternatives(ex, bench, limit=5)
        # 第一个推荐的应该是 body weight
        self.assertEqual(alts[0][0]["equipment"].lower(), "body weight")

    def test_exclude_same_equipment(self):
        ex = _load()
        bench = finder.resolve(ex, "barbell bench press")
        alts = finder.find_alternatives(ex, bench, limit=20, exclude_same_equipment=True)
        # 所有结果都不应该是 barbell
        for cand, _, _ in alts:
            self.assertNotEqual(cand["equipment"].lower(), "barbell")

    def test_score_deterministic(self):
        """同输入两次跑,结果应完全一致。"""
        ex = _load()
        bench = finder.resolve(ex, "barbell bench press")
        a1 = finder.find_alternatives(ex, bench, limit=10)
        a2 = finder.find_alternatives(ex, bench, limit=10)
        ids1 = [c["id"] for c, _, _ in a1]
        ids2 = [c["id"] for c, _, _ in a2]
        self.assertEqual(ids1, ids2)

    def test_score_reason_non_empty(self):
        ex = _load()
        bench = finder.resolve(ex, "barbell bench press")
        alts = finder.find_alternatives(ex, bench, limit=5)
        for cand, score, reasons in alts:
            self.assertGreater(score, 0)
            self.assertGreater(len(reasons), 0)


class TestFindByCriteria(unittest.TestCase):
    def test_target_only(self):
        ex = _load()
        result = finder.find_by_criteria(ex, target="pectorals", limit=50)
        self.assertGreater(len(result), 0)
        self.assertTrue(all(e["target"].lower() == "pectorals" for e in result))

    def test_target_plus_equipment(self):
        ex = _load()
        result = finder.find_by_criteria(
            ex, target="pectorals", equipment="body weight", limit=50
        )
        self.assertGreater(len(result), 0)
        for e in result:
            self.assertEqual(e["target"].lower(), "pectorals")
            self.assertEqual(e["equipment"].lower(), "body weight")

    def test_body_weight_first(self):
        """调优:Body weight 应排在最前。"""
        ex = _load()
        result = finder.find_by_criteria(ex, target="pectorals", limit=10)
        self.assertEqual(result[0]["equipment"].lower(), "body weight")

    def test_no_match(self):
        ex = _load()
        result = finder.find_by_criteria(ex, target="xyz不存在肌")
        self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()