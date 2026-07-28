"""Tests for web/app.py. Uses FastAPI TestClient (no live server needed).

Run:  python3 -m unittest web.test_app -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# 让 web/ 能 import cli/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from web import db as _db
from web.app import app  # noqa: E402


client = TestClient(app)


# 测试用内存 DB,不污染 data/sport.db
TEST_DB = Path(__file__).resolve().parent / "test_sport.db"


def setUpModule():
    """所有测试用临时 DB。"""
    if TEST_DB.exists():
        TEST_DB.unlink()
    import web.db
    web.db.DB_PATH = TEST_DB
    web.db._conn = None
    _db.init_schema(_db.connect(TEST_DB))


def tearDownModule():
    if TEST_DB.exists():
        TEST_DB.unlink()


class TestPages(unittest.TestCase):
    def test_root_renders(self):
        r = client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/html", r.headers["content-type"])

    def test_plan_returns_html(self):
        r = client.get("/plan")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/html", r.headers["content-type"])
        self.assertIn("计划", r.text)
        self.assertIn('data-page="plan"', r.text)
        self.assertIn("check-in-btn", r.text)
        self.assertIn("start-training-btn", r.text)
        self.assertIn('id="training-overlay"', r.text)
        self.assertIn("/static/training.js", r.text)

    def test_browse_returns_html(self):
        r = client.get("/browse")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/html", r.headers["content-type"])
        self.assertIn("浏览", r.text)

    def test_generate_returns_html(self):
        r = client.get("/generate")
        self.assertEqual(r.status_code, 200)
        self.assertIn("生成", r.text)

    def test_settings_returns_html(self):
        r = client.get("/settings")
        self.assertEqual(r.status_code, 200)
        self.assertIn("设置", r.text)

    def test_exercise_page_returns_html(self):
        r = client.get("/exercise/0001")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/html", r.headers["content-type"])

    def test_exercise_404(self):
        r = client.get("/exercise/zzzz")
        self.assertEqual(r.status_code, 404)

    def test_static_assets_served(self):
        for path in ("/static/style.css", "/static/i18n.js",
                     "/static/shared.js", "/static/plan.js",
                     "/static/generate.js", "/static/browse.js",
                     "/static/detail.js", "/static/settings.js",
                     "/static/training.js"):
            r = client.get(path)
            self.assertEqual(r.status_code, 200, f"{path} failed")


class TestApiExercise(unittest.TestCase):
    def test_get_exercise(self):
        r = client.get("/api/exercise/0001")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data["id"], "0001")
        self.assertIn("image_cdn", data)
        self.assertIn("gif_cdn", data)

    def test_404(self):
        r = client.get("/api/exercise/zzzz")
        self.assertEqual(r.status_code, 404)


class TestApiAlternatives(unittest.TestCase):
    def test_alt(self):
        r = client.get("/api/alternatives/0025")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertGreater(len(data["alternatives"]), 0)

    def test_404(self):
        r = client.get("/api/alternatives/zzzz")
        self.assertEqual(r.status_code, 404)


class TestApiBrowse(unittest.TestCase):
    def test_search(self):
        r = client.get("/api/browse?q=bench")
        self.assertEqual(r.status_code, 200)
        self.assertGreater(r.json()["count"], 0)

    def test_target_filter(self):
        r = client.get("/api/browse?target=pectorals&limit=5")
        data = r.json()
        for e in data["results"]:
            self.assertEqual(e["target"].lower(), "pectorals")


class TestApiFilters(unittest.TestCase):
    def test_filters(self):
        r = client.get("/api/filters")
        data = r.json()
        self.assertIn("pectorals", data["target"])
        self.assertIn("dumbbell", data["equipment"])


class TestApiPlanDemo(unittest.TestCase):
    def test_demo(self):
        r = client.get("/api/plan/demo")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("days", data)
        for day in data["days"]:
            for ex in day["exercises"]:
                self.assertIn("gif_cdn", ex)


class TestApiPlanErrorHandling(unittest.TestCase):
    def test_missing_key_503(self):
        with patch.dict("os.environ", {}, clear=True):
            r = client.post("/api/plan", json={"intent": "x", "days": 1, "per_day": 2})
            self.assertEqual(r.status_code, 503)


# ─── Plans / Check-ins API 测试 ─────────────────────────────────────

SAMPLE_PLAN = {
    "title": "测试计划",
    "split": "PPL",
    "summary": "测试",
    "days": [
        {"day": 1, "title": "推日", "summary": "推", "exercises": [
            {"id": "0289", "sets": 3, "reps": "8-12", "rest_seconds": 90, "reason": "测试"}]},
        {"day": 2, "title": "拉日", "summary": "拉", "exercises": [
            {"id": "0017", "sets": 3, "reps": "8-12", "rest_seconds": 90, "reason": "测试"}]},
    ],
}


class TestApiPlans(unittest.TestCase):
    def setUp(self):
        # 清掉数据
        for p in _db.list_plans(include_archived=True):
            _db.delete_plan(p["id"])

    def test_create_and_get(self):
        r = client.post("/api/plans", json={"name": "我的计划", "plan": SAMPLE_PLAN})
        self.assertEqual(r.status_code, 200)
        plan = r.json()["plan"]
        self.assertEqual(plan["name"], "我的计划")
        self.assertTrue(plan["is_current"])

        # 拉列表
        r = client.get("/api/plans")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["plans"]), 1)
        self.assertEqual(r.json()["plans"][0]["check_in_count"], 0)
        self.assertEqual(r.json()["plans"][0]["day_count"], 2)

    def test_create_default_make_current(self):
        client.post("/api/plans", json={"name": "A", "plan": SAMPLE_PLAN})
        client.post("/api/plans", json={"name": "B", "plan": SAMPLE_PLAN})
        # 第二个自动 is_current=True,第一个变 0
        cur = _db.get_current_plan()
        self.assertEqual(cur["name"], "B")

    def test_create_no_make_current(self):
        client.post("/api/plans", json={"name": "A", "plan": SAMPLE_PLAN, "make_current": True})
        client.post("/api/plans", json={"name": "B", "plan": SAMPLE_PLAN, "make_current": False})
        cur = _db.get_current_plan()
        self.assertEqual(cur["name"], "A")

    def test_get_current(self):
        client.post("/api/plans", json={"name": "测试", "plan": SAMPLE_PLAN})
        r = client.get("/api/plans/current")
        self.assertIsNotNone(r.json()["plan"])

    def test_set_current_via_patch(self):
        r1 = client.post("/api/plans", json={"name": "A", "plan": SAMPLE_PLAN, "make_current": True})
        r2 = client.post("/api/plans", json={"name": "B", "plan": SAMPLE_PLAN, "make_current": False})
        id_a = r1.json()["plan"]["id"]
        id_b = r2.json()["plan"]["id"]
        # 把 B 设为当前
        client.patch(f"/api/plans/{id_b}", json={"current": True})
        self.assertEqual(_db.get_current_plan()["id"], id_b)

    def test_archive_and_restore(self):
        r = client.post("/api/plans", json={"name": "归档测试", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        # 归档
        r = client.patch(f"/api/plans/{pid}", json={"archived": True})
        self.assertIsNotNone(r.json()["plan"]["archived_at"])
        # active 列表里没有了
        r = client.get("/api/plans")
        self.assertEqual(len(r.json()["plans"]), 0)
        # include_archived=true 能看到
        r = client.get("/api/plans?include_archived=true")
        self.assertEqual(len(r.json()["plans"]), 1)
        # 归档后 get_current 不会返回
        self.assertIsNone(_db.get_current_plan())
        # 取消归档
        client.patch(f"/api/plans/{pid}", json={"archived": False})
        r = client.get("/api/plans")
        self.assertEqual(len(r.json()["plans"]), 1)

    def test_rename(self):
        r = client.post("/api/plans", json={"name": "旧名", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        client.patch(f"/api/plans/{pid}", json={"name": "新名"})
        self.assertEqual(_db.get_plan(pid)["name"], "新名")

    def test_delete(self):
        r = client.post("/api/plans", json={"name": "X", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        client.delete(f"/api/plans/{pid}")
        self.assertIsNone(_db.get_plan(pid))

    def test_404_on_update(self):
        r = client.patch("/api/plans/nonexistent", json={"name": "x"})
        self.assertEqual(r.status_code, 404)


class TestApiCheckIns(unittest.TestCase):
    def setUp(self):
        for p in _db.list_plans(include_archived=True):
            _db.delete_plan(p["id"])

    def test_check_in_and_list(self):
        r = client.post("/api/plans", json={"name": "test", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        r = client.post(f"/api/plans/{pid}/check-in", json={"day_number": 1, "note": "感觉还行"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["check_in"]["day_number"], 1)

        r = client.get(f"/api/plans/{pid}/check-ins")
        self.assertEqual(len(r.json()["check_ins"]), 1)
        self.assertEqual(r.json()["check_ins"][0]["note"], "感觉还行")

    def test_check_in_idempotent(self):
        r = client.post("/api/plans", json={"name": "test", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        client.post(f"/api/plans/{pid}/check-in", json={"day_number": 1, "note": "first"})
        client.post(f"/api/plans/{pid}/check-in", json={"day_number": 1, "note": "second"})
        # 同一天只能有一条(ON CONFLICT UPDATE)
        r = client.get(f"/api/plans/{pid}/check-ins")
        self.assertEqual(len(r.json()["check_ins"]), 1)
        self.assertEqual(r.json()["check_ins"][0]["note"], "second")

    def test_undo_check_in(self):
        r = client.post("/api/plans", json={"name": "test", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        client.post(f"/api/plans/{pid}/check-in", json={"day_number": 1})
        client.delete(f"/api/plans/{pid}/check-in/1")
        r = client.get(f"/api/plans/{pid}/check-ins")
        self.assertEqual(len(r.json()["check_ins"]), 0)

    def test_check_in_updates_stats(self):
        r = client.post("/api/plans", json={"name": "test", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        client.post(f"/api/plans/{pid}/check-in", json={"day_number": 1})
        r = client.get("/api/plans")
        self.assertEqual(r.json()["plans"][0]["check_in_count"], 1)

    def test_404_on_missing_plan(self):
        r = client.post("/api/plans/nonexistent/check-in", json={"day_number": 1})
        self.assertEqual(r.status_code, 404)

    def test_invalid_day_number(self):
        r = client.post("/api/plans", json={"name": "test", "plan": SAMPLE_PLAN})
        pid = r.json()["plan"]["id"]
        r = client.post(f"/api/plans/{pid}/check-in", json={"day_number": "abc"})
        self.assertEqual(r.status_code, 400)


class TestApiMigrate(unittest.TestCase):
    def setUp(self):
        for p in _db.list_plans(include_archived=True):
            _db.delete_plan(p["id"])

    def test_migrate_from_localstorage(self):
        r = client.post("/api/migrate", json={
            "plans": [
                {"id": "old1", "name": "迁移A", "plan": SAMPLE_PLAN, "saved_at": "2026-01-01T00:00:00Z", "is_current": True},
                {"id": "old2", "name": "迁移B", "plan": SAMPLE_PLAN, "saved_at": "2026-01-02T00:00:00Z"},
            ],
            "check_ins": [],
        })
        data = r.json()
        self.assertEqual(data["plans_migrated"], 2)
        self.assertEqual(len(_db.list_plans(include_archived=True)), 2)

    def test_migrate_skips_existing(self):
        client.post("/api/plans", json={"name": "already", "plan": SAMPLE_PLAN})
        existing_id = _db.list_plans()[0]["id"]
        r = client.post("/api/migrate", json={
            "plans": [{"id": existing_id, "name": "dup", "plan": SAMPLE_PLAN}],
        })
        self.assertEqual(r.json()["plans_migrated"], 0)


if __name__ == "__main__":
    unittest.main()