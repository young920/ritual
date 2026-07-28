"""SQLite 数据层 — plans + check_ins。

设计:
- 单文件 DB:data/sport.db(wal 模式,读不阻塞写)
- plans 存完整 JSON 数据(days[] 整个塞进去)
- check_ins:每条一行,UNIQUE(plan_id, day_number) 幂等
- is_current 用一个标记位,只有一条 plan 可以是 current(其他 0)
- archived_at NULL = active;非 NULL = 已归档

服务启动时自动建表(SQLite IF NOT EXISTS)。
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Iterable

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "sport.db"


SCHEMA = """
CREATE TABLE IF NOT EXISTS plans (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    plan_data   TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    archived_at TEXT,
    is_current  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS check_ins (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id      TEXT NOT NULL,
    day_number   INTEGER NOT NULL,
    completed_at TEXT NOT NULL,
    note         TEXT,
    UNIQUE(plan_id, day_number),
    FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkins_plan ON check_ins(plan_id);
CREATE INDEX IF NOT EXISTS idx_plans_archived ON plans(archived_at);
"""


def _now_iso() -> str:
    """ISO 8601 UTC,精确到秒,带 Z。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=10, isolation_level=None,  # autocommit
                           check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def get_default_conn() -> sqlite3.Connection:
    """单例连接,FastAPI 里复用一个 conn。"""
    global _conn
    if _conn is None:
        _conn = connect()
        init_schema(_conn)
    return _conn


_conn: sqlite3.Connection | None = None


# ─── Plans CRUD ───────────────────────────────────────────────────────

def create_plan(name: str, plan_data: dict, *, make_current: bool = False) -> dict:
    conn = get_default_conn()
    pid = str(uuid.uuid4())[:8]
    created_at = _now_iso()
    if make_current:
        conn.execute("UPDATE plans SET is_current = 0")
    conn.execute(
        "INSERT INTO plans (id, name, plan_data, created_at, is_current) VALUES (?, ?, ?, ?, ?)",
        (pid, name, json.dumps(plan_data, ensure_ascii=False), created_at, 1 if make_current else 0),
    )
    return get_plan(pid)


def get_plan(plan_id: str) -> dict | None:
    conn = get_default_conn()
    row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    return _row_to_plan(row) if row else None


def list_plans(*, include_archived: bool = False) -> list[dict]:
    conn = get_default_conn()
    if include_archived:
        rows = conn.execute(
            "SELECT * FROM plans ORDER BY archived_at IS NOT NULL, created_at DESC"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM plans WHERE archived_at IS NULL ORDER BY created_at DESC"
        ).fetchall()
    return [_row_to_plan(r) for r in rows]


def list_plans_with_stats(*, include_archived: bool = False) -> list[dict]:
    """带每个计划的打卡统计(完成数 / 总天数)。"""
    plans = list_plans(include_archived=include_archived)
    conn = get_default_conn()
    for p in plans:
        stats = conn.execute(
            """SELECT COUNT(*) AS done
                 FROM check_ins WHERE plan_id = ?""",
            (p["id"],),
        ).fetchone()
        p["check_in_count"] = stats["done"] if stats else 0
        total = len((p.get("plan") or {}).get("days") or [])
        p["day_count"] = total
    return plans


def get_current_plan() -> dict | None:
    conn = get_default_conn()
    row = conn.execute(
        "SELECT * FROM plans WHERE is_current = 1 AND archived_at IS NULL LIMIT 1"
    ).fetchone()
    return _row_to_plan(row) if row else None


def set_current_plan(plan_id: str) -> dict | None:
    conn = get_default_conn()
    plan = get_plan(plan_id)
    if not plan or plan.get("archived_at"):
        return None
    conn.execute("UPDATE plans SET is_current = 0")
    conn.execute("UPDATE plans SET is_current = 1 WHERE id = ?", (plan_id,))
    return get_plan(plan_id)


def update_plan(plan_id: str, *, name: str | None = None,
                 archived: bool | None = None) -> dict | None:
    """改名 / 归档 / 取消归档。"""
    conn = get_default_conn()
    plan = get_plan(plan_id)
    if not plan:
        return None
    if name is not None:
        conn.execute("UPDATE plans SET name = ? WHERE id = ?", (name, plan_id))
    if archived is True:
        conn.execute(
            "UPDATE plans SET archived_at = ?, is_current = 0 WHERE id = ?",
            (_now_iso(), plan_id),
        )
    elif archived is False:
        conn.execute("UPDATE plans SET archived_at = NULL WHERE id = ?", (plan_id,))
    return get_plan(plan_id)


def delete_plan(plan_id: str) -> bool:
    conn = get_default_conn()
    cur = conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
    return cur.rowcount > 0


def _row_to_plan(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "plan": json.loads(row["plan_data"]),
        "created_at": row["created_at"],
        "archived_at": row["archived_at"],
        "is_current": bool(row["is_current"]),
    }


# ─── Check-ins ───────────────────────────────────────────────────────

def check_in_day(plan_id: str, day_number: int, note: str | None = None) -> dict | None:
    """标记某天完成(幂等:同一天二次打卡覆盖 note 和时间戳)。"""
    conn = get_default_conn()
    if not get_plan(plan_id):
        return None
    completed_at = _now_iso()
    conn.execute(
        """INSERT INTO check_ins (plan_id, day_number, completed_at, note)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(plan_id, day_number) DO UPDATE SET
             completed_at = excluded.completed_at,
             note = excluded.note""",
        (plan_id, day_number, completed_at, note),
    )
    return get_check_in(plan_id, day_number)


def undo_check_in(plan_id: str, day_number: int) -> bool:
    conn = get_default_conn()
    cur = conn.execute(
        "DELETE FROM check_ins WHERE plan_id = ? AND day_number = ?",
        (plan_id, day_number),
    )
    return cur.rowcount > 0


def get_check_in(plan_id: str, day_number: int) -> dict | None:
    conn = get_default_conn()
    row = conn.execute(
        "SELECT * FROM check_ins WHERE plan_id = ? AND day_number = ?",
        (plan_id, day_number),
    ).fetchone()
    return _row_to_checkin(row) if row else None


def list_check_ins(plan_id: str) -> list[dict]:
    conn = get_default_conn()
    rows = conn.execute(
        "SELECT * FROM check_ins WHERE plan_id = ? ORDER BY day_number",
        (plan_id,),
    ).fetchall()
    return [_row_to_checkin(r) for r in rows]


def _row_to_checkin(row: sqlite3.Row) -> dict:
    return {
        "plan_id": row["plan_id"],
        "day_number": row["day_number"],
        "completed_at": row["completed_at"],
        "note": row["note"],
    }