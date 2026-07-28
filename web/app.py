"""Phase 3 — 4 个独立页面的 Web UI:sport.

页面:
  GET  /today                       今日训练(载入当前计划,默认 demo)
  GET  /browse                      浏览全部动作
  GET  /generate                    生成新计划(可保存 / 重置)
  GET  /settings                    API 设置
  GET  /exercise/{id}               动作详情

API(供前端 JS 调用):
  GET  /api/plan/demo               静态 demo 计划
  POST /api/plan                    用 LLM 生成
  GET  /api/exercise/{id}           动作详情(含 image_cdn / gif_cdn)
  GET  /api/alternatives/{id}       替代动作
  GET  /api/browse?q=&target=&equipment=&limit=  浏览/搜索
  GET  /api/filters                 给前端下拉用的(target / equipment 唯一值列表)

GIF/image URL 用上游 GitHub raw CDN,本地不存媒体。
"""
from __future__ import annotations
# Debug:在 import 之前写日志,看 binary 是否真的开始执行 app.py
import os as _dbg_os
_dbg_path = (_dbg_os.path.expanduser('~/.ritual-debug.log'))
try:
    with open(_dbg_path, 'a') as _f:
        _f.write(f"[{_dbg_os.environ.get('_RITUAL_TS', '0')}] top of app.py reached\n")
except Exception:
    pass

import hashlib
import json as _json
import subprocess
import sys
from pathlib import Path

# 让 web/ 能找到 cli/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import APIConnectionError, AuthenticationError
import anthropic as _anthropic_lib

import sys as _sys, os as _os
# PyInstaller / macOS 双击 .app 启动时 stdout/stderr 可能未绑定,
# print 会 BrokenPipeError 导致进程秒退。检测到 fd<0 就重定向到日志文件。
if not _sys.stdout or _sys.stdout.fileno() < 0:
    _log_dir = Path.home() / ".ritual"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _sys.stdout = open(_log_dir / "ritual.log", "a", buffering=1)
if not _sys.stderr or _sys.stderr.fileno() < 0:
    _log_dir = Path.home() / ".ritual"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _sys.stderr = open(_log_dir / "ritual.err", "a", buffering=1)

# PyInstaller onedir 经常把空 __init__.py 的 package 收集错,导致 from cli import finder 无限递归。
# 改成 importlib 直接按文件加载,完全绕开 package 机制。
import importlib.util
def _load_module_from_path(name: str, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    _sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod

# 探测 cli/ 包位置:开发模式 = 项目根 /cli/,打包模式 = _internal/cli/
def _find_pkg_dir():
    candidates = [
        Path(__file__).resolve().parent.parent / "cli",  # 源码模式
    ]
    if hasattr(_sys, '_MEIPASS'):
        candidates.append(Path(_sys._MEIPASS) / "cli")
        candidates.append(Path(_sys._MEIPASS) / "cli_pkg")  # --add-data 时被改名
    for c in candidates:
        if c.exists() and (c / "__init__.py").exists():
            return c
    return None

_pkg = _find_pkg_dir()
if _pkg:
    # 把 _pkg 加到 sys.path 第一位,让 `from cli import X` 找得到
    if str(_pkg.parent) not in _sys.path:
        _sys.path.insert(0, str(_pkg.parent))
    finder = _load_module_from_path("cli.finder", _pkg / "finder.py")
    coach = _load_module_from_path("cli.coach", _pkg / "coach.py")
else:
    # 兜底:源码 import
    from cli import finder  # type: ignore
    from cli import coach  # type: ignore

from web import db as _db

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
EXERCISES_JSON = DATA_DIR / "exercises.json"
WEB_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = WEB_DIR / "templates"
STATIC_DIR = WEB_DIR / "static"
DEMO_PATH = WEB_DIR / "data" / "demo.json"
GIF_BASE_REMOTE = "https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/"
GIF_BASE_CDN = "https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@main"
MEDIA_LOCAL_DIR = STATIC_DIR / "media"  # 本地媒体目录(可选,跑了 download_media.py 才有)

# PyInstaller 单文件适配:静态/模板/数据被打进 bundle,运行时通过 sys._MEIPASS 访问
import sys as _sys
if hasattr(_sys, '_MEIPASS'):
    _bundle = Path(_sys._MEIPASS)
    # PyInstaller onedir 把 _internal 加到 sys.path,但 cli/ 是空 __init__.py 的 namespace package,
    # Python 找不到 __init__ 内容,会反复 import。强制把 _bundle 放 sys.path 第一位。
    if str(_bundle) not in _sys.path:
        _sys.path.insert(0, str(_bundle))
    TEMPLATES_DIR = _bundle / "web" / "templates"
    STATIC_DIR = _bundle / "web" / "static"
    DEMO_PATH = _bundle / "web" / "data" / "demo.json"
    EXERCISES_JSON = _bundle / "data" / "exercises.json"
    # PyInstaller onedir 偶尔把 exercises.json 当目录,加 fallback
    if EXERCISES_JSON.is_dir():
        EXERCISES_JSON = EXERCISES_JSON / "exercises.json"
    # data/sport.db 仍然写在 exe 旁的 EXE 同目录(可写)
    DATA_DIR = Path(_sys.executable).resolve().parent / "data"

app = FastAPI(title="sport", docs_url=None, redoc_url=None)

# Debug:启动立刻写日志,确认 binary 起来了
try:
    _dbg = Path.home() / ".ritual-debug.log"
    with open(_dbg, "a") as _f:
        _f.write(f"[{__import__('time').time()}] app.py loaded, EXERCISES_JSON={EXERCISES_JSON}\n")
        _f.write(f"[{__import__('time').time()}] sys.path={_sys.path[:5]}\n")
        _f.write(f"[{__import__('time').time()}] cli finder dir={dir(finder)[:200]}\n")
except Exception as _e:
    try:
        with open(Path.home() / ".ritual-debug.log", "a") as _f2:
            _f2.write(f"DEBUG IMPORT ERR: {_e}\n")
    except Exception:
        pass


@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception):
    """兜底:任何漏网的异常都转成 JSON 500,而不是 HTML stack trace。"""
    import traceback
    tb = traceback.format_exc()
    print(f"[unhandled] {request.method} {request.url.path}\n{tb}", file=sys.stderr)
    return JSONResponse(
        {"error": "internal", "message": str(exc) or exc.__class__.__name__,
         "type": exc.__class__.__name__},
        status_code=500,
    )


@app.on_event("startup")
def _startup_init_db():
    """启动时初始化 SQLite schema + 自动开浏览器(PyInstaller .app 启动用)。"""
    _db.init_schema(_db.get_default_conn())
    # .app 启动时(launchd,没有 shell)自动开浏览器
    import threading
    def _open_browser():
        import time, subprocess
        time.sleep(0.5)
        try:
            subprocess.Popen(["open", "http://127.0.0.1:8000/generate"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    threading.Thread(target=_open_browser, daemon=True).start()

_exercises_cache: list[dict] | None = None


def exercises() -> list[dict]:
    global _exercises_cache
    if _exercises_cache is None:
        _exercises_cache = finder.load(str(EXERCISES_JSON))
    return _exercises_cache


def by_id(eid: str) -> dict | None:
    return finder.get_by_id(exercises(), eid)


_local_index: set[str] | None = None


def _local_index_loaded() -> set[str]:
    """一次性扫描 web/static/media/ 索引,加速查找。"""
    global _local_index
    if _local_index is None:
        idx = set()
        if MEDIA_LOCAL_DIR.exists():
            for p in MEDIA_LOCAL_DIR.rglob("*"):
                if p.is_file():
                    idx.add(str(p.relative_to(MEDIA_LOCAL_DIR)))
        _local_index = idx
    return _local_index


def gif_url(ex: dict) -> str:
    """三级 fallback:本地 → jsdelivr CDN → raw.githubusercontent。"""
    rel = ex.get("gif_url", "")
    if not rel:
        return ""
    if rel in _local_index_loaded():
        return f"/static/media/{rel}"
    return f"{GIF_BASE_CDN}/{rel}"


def image_url(ex: dict) -> str:
    rel = ex.get("image", "")
    if not rel:
        return ""
    if rel in _local_index_loaded():
        return f"/static/media/{rel}"
    return f"{GIF_BASE_CDN}/{rel}"


def render(name: str) -> HTMLResponse:
    return HTMLResponse((TEMPLATES_DIR / name).read_text(encoding="utf-8"))


# ─── 页面 ─────────────────────────────────────────────────────────────

@app.get("/favicon.ico", include_in_schema=False)
async def favicon_ico():
    from fastapi.responses import FileResponse
    return FileResponse(str(STATIC_DIR / "favicon.ico"), media_type="image/x-icon")


@app.get("/favicon.svg", include_in_schema=False)
async def favicon_svg():
    from fastapi.responses import FileResponse
    return FileResponse(str(STATIC_DIR / "favicon.svg"), media_type="image/svg+xml")


@app.get("/", response_class=HTMLResponse)
async def root():
    return render("plan.html")


@app.get("/plan", response_class=HTMLResponse)
async def plan_page():
    return render("plan.html")


@app.get("/today", response_class=HTMLResponse)
async def today_redirect():
    """兼容老 URL:跳转 /plan。"""
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/plan", status_code=301)


@app.get("/browse", response_class=HTMLResponse)
async def browse():
    return render("browse.html")


@app.get("/generate", response_class=HTMLResponse)
async def generate_page():
    return render("generate.html")


@app.get("/settings", response_class=HTMLResponse)
async def settings_page():
    return render("settings.html")


@app.get("/exercise/{eid}", response_class=HTMLResponse)
async def exercise_page(eid: str):
    if not by_id(eid):
        raise HTTPException(404, f"Exercise {eid} not found")
    return render("exercise.html")


# ─── API ──────────────────────────────────────────────────────────────

@app.get("/api/plan/demo")
async def api_plan_demo():
    """静态 demo 计划 — 注入 image_cdn / gif_cdn 让 demo 也走本地。"""
    if not DEMO_PATH.exists():
        return JSONResponse({"error": "demo_missing"}, status_code=404)
    data = _json.loads(DEMO_PATH.read_text(encoding="utf-8"))
    for day in data.get("days", []):
        for item in day.get("exercises", []):
            eid = item.get("id", "")
            ex = by_id(eid)
            if ex:
                item["image_cdn"] = image_url(ex)
                item["gif_cdn"] = gif_url(ex)
    return data


import json as _json_mod  # for JSONDecodeError distinction

# ─── Debug:最近 20 条 /api/plan 请求/响应的内存 log ───
_RECENT: list[dict] = []


@app.post("/api/plan")
async def api_plan(req: Request):
    body = await req.json()
    _RECENT.append({"kind": "request", "body": body, "ts": __import__('time').time()})
    _RECENT[:] = _RECENT[-20:]
    # === 调试日志:每次请求都打,无论成败 ===
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"[api_plan] request body: {_json_mod.dumps(body, ensure_ascii=False)}", file=sys.stderr)
    plan_dict = None
    last_err: Exception | None = None
    # 同一个 model 重试 3 次 — 代理间歇性失败 / 临时 503 / LLM 偶发输出坏 JSON,重试一般能过
    # 不换 model(不 fallback 兜底),失败 3 次才报错
    import time as _t
    for attempt in range(1, 4):
        try:
            plan_dict = coach.plan(
                intent=body.get("intent", ""),
                days=body.get("days", 1),
                per_day=body.get("per_day", 4),
                target=body.get("target"),
                body_part=body.get("body_part"),
                equipment=body.get("equipment"),
                muscle_group=body.get("muscle_group"),
                model=body.get("model"),
                base_url=body.get("base_url"),
                api_key=body.get("api_key"),
                data_path=str(EXERCISES_JSON),
            )
            break
        except (EnvironmentError, AuthenticationError, APIConnectionError) as e:
            # 这些是确定性的(没 key / auth 错 / 连不上),不重试
            last_err = e
            break
        except _json_mod.JSONDecodeError as e:
            # LLM 输出坏 JSON — 这是临时问题(下次的输出可能就好了),重试
            last_err = e
            if attempt < 3:
                _t.sleep(attempt)
                continue
            break
        except ValueError as e:
            # 真正的 "找不到候选"(不是 JSON 解析失败),确定性错误,不重试
            last_err = e
            break
        except _anthropic_lib.APIError as e:
            last_err = e
            inner = (getattr(e, 'body', None) or {}).get('error', {}) if isinstance(getattr(e, 'body', None), dict) else {}
            code = inner.get('code') or inner.get('type') or ''
            # model_not_found 是用户配错,不是临时问题,不重试
            if code == 'model_not_found':
                break
            if attempt < 3:
                _t.sleep(attempt)
                continue
            break
        except Exception as e:
            last_err = e
            break

    if plan_dict is None:
        # === 失败日志:每次失败都打 stderr,方便排查 ===
        print(f"[api_plan] FAILED after 3 attempts", file=sys.stderr)
        print(f"[api_plan] last_err type: {type(last_err).__name__ if last_err else 'None'}", file=sys.stderr)
        if last_err:
            print(f"[api_plan] last_err msg: {last_err}", file=sys.stderr)
            import traceback as _tb
            _tb.print_exception(type(last_err), last_err, last_err.__traceback__, file=sys.stderr)
        # 三次都失败(或确定性错误) — 透传最后一次异常
        if isinstance(last_err, EnvironmentError):
            resp = JSONResponse({"error": "missing_api_key", "message": str(last_err)}, status_code=503)
            _RECENT.append({"kind": "response", "status": 503, "body": {"error": "missing_api_key", "message": str(last_err)}, "ts": __import__('time').time()})
            return resp
        if isinstance(last_err, _json_mod.JSONDecodeError):
            msg = f"LLM 输出不是合法 JSON(已重试 3 次)。原始输出前 200 字符:{(last_err.msg or '')[-200:]}"
            resp = JSONResponse({"error": "parse_failed", "message": msg}, status_code=502)
            _RECENT.append({"kind": "response", "status": 502, "body": {"error": "parse_failed", "message": msg}, "ts": __import__('time').time()})
            return resp
        if isinstance(last_err, ValueError):
            resp = JSONResponse({"error": "no_candidates", "message": str(last_err)}, status_code=400)
            _RECENT.append({"kind": "response", "status": 400, "body": {"error": "no_candidates", "message": str(last_err)}, "ts": __import__('time').time()})
            return resp
        if isinstance(last_err, AuthenticationError):
            resp = JSONResponse({"error": "auth_failed", "message": "API key 无效或被拒绝。"}, status_code=401)
            _RECENT.append({"kind": "response", "status": 401, "body": {"error": "auth_failed", "message": "API key 无效"}, "ts": __import__('time').time()})
            return resp
        if isinstance(last_err, APIConnectionError):
            resp = JSONResponse({"error": "connection_failed", "message": f"连不上 LLM 服务:{last_err}"}, status_code=502)
            _RECENT.append({"kind": "response", "status": 502, "body": {"error": "connection_failed", "message": str(last_err)}, "ts": __import__('time').time()})
            return resp
        if isinstance(last_err, _anthropic_lib.APIError):
            msg = str(last_err)
            err_code = "llm_error"
            status = 502
            try:
                inner = (getattr(last_err, 'body', None) or {}).get('error', {}) if isinstance(getattr(last_err, 'body', None), dict) else {}
                code = inner.get('code') or inner.get('type') or ''
                inner_msg = inner.get('message') or ''
                if code == 'model_not_found' or 'model_not_found' in str(inner_msg):
                    err_code = 'model_not_found'
                    status = 503
                    msg = f"模型不可用:{inner_msg or '该 model 在当前 base_url / 分组下不可用'}"
                elif inner_msg:
                    msg = f"LLM 返回错误:{inner_msg}"
            except Exception:
                pass
            resp = JSONResponse({"error": err_code, "message": msg}, status_code=status)
            _RECENT.append({"kind": "response", "status": status, "body": {"error": err_code, "message": msg}, "ts": __import__('time').time()})
            return resp
        # 兜底
        resp = JSONResponse({"error": "llm_error", "message": str(last_err)}, status_code=502)
        _RECENT.append({"kind": "response", "status": 502, "body": {"error": "llm_error", "message": str(last_err)}, "ts": __import__('time').time()})
        return resp

    # 注入 CDN URL(主训练 actions + warmup/cooldown phases 都按 exercise_id 拿图)
    for day in plan_dict.get("days", []):
        for item in day.get("exercises", []):
            ex = by_id(item.get("id", ""))
            if ex:
                item["image_cdn"] = image_url(ex)
                item["gif_cdn"] = gif_url(ex)
        # warmup phase: 如果 phase 里有 exercise_id,注入 image_cdn / gif_cdn
        for section_name in ("warmup", "cooldown"):
            section = day.get(section_name)
            if section and isinstance(section.get("phases"), list):
                for p in section["phases"]:
                    if isinstance(p, dict) and p.get("exercise_id"):
                        pex = by_id(p["exercise_id"])
                        if pex:
                            p["image_cdn"] = image_url(pex)
                            p["gif_cdn"] = gif_url(pex)
    print(f"[api_plan] SUCCESS, {len(plan_dict.get('days', []))} days", file=sys.stderr)
    _RECENT.append({"kind": "response", "status": 200, "body": {"title": plan_dict.get("title", ""), "exercises_first": (plan_dict.get("days", [{}])[0].get("exercises", [{}])[0] if plan_dict.get("days") else {})}, "ts": __import__('time').time()})
    return plan_dict


@app.get("/api/debug/recent")
async def debug_recent():
    """返回最近 20 条 /api/plan 请求/响应(供前端调试用)。"""
    return {"recent": _RECENT}


@app.get("/api/exercise/{eid}")
async def api_exercise(eid: str):
    ex = by_id(eid)
    if not ex:
        raise HTTPException(404, "not found")
    return {**ex, "image_cdn": image_url(ex), "gif_cdn": gif_url(ex)}


@app.get("/api/alternatives/{eid}")
async def api_alternatives(eid: str, limit: int = Query(5, ge=1, le=20),
                           exclude_same_equipment: bool = False):
    source = by_id(eid)
    if not source:
        raise HTTPException(404, "not found")
    alts = finder.find_alternatives(exercises(), source, limit=limit,
                                    exclude_same_equipment=exclude_same_equipment)
    return {
        "source": {"id": source["id"], "name": source["name"]},
        "alternatives": [
            {**cand, "image_cdn": image_url(cand), "gif_cdn": gif_url(cand),
             "score": score, "reasons": reasons}
            for cand, score, reasons in alts
        ],
    }


@app.get("/api/browse")
async def api_browse(q: str = "", target: str | None = None,
                     body_part: str | None = None,
                     equipment: str | None = None,
                     limit: int = Query(60, ge=1, le=200)):
    if q:
        results = finder.find_by_name(exercises(), q, limit=limit)
    elif target or body_part or equipment:
        results = finder.find_by_criteria(
            exercises(), target=target, body_part=body_part,
            equipment=equipment, limit=limit,
        )
    else:
        results = []
    return {
        "count": len(results),
        "results": [{**e, "image_cdn": image_url(e), "gif_cdn": gif_url(e)} for e in results],
    }


@app.get("/api/filters")
async def api_filters():
    """给前端下拉用:target / equipment / body_part 的所有唯一值。"""
    exs = exercises()
    return {
        "target": sorted({e["target"] for e in exs if e.get("target")}),
        "equipment": sorted({e["equipment"] for e in exs if e.get("equipment")}),
        "body_part": sorted({e["body_part"] for e in exs if e.get("body_part")}),
    }


# ─── Plans & Check-ins (SQLite) ──────────────────────────────────────

@app.get("/api/plans")
async def api_plans_list(include_archived: bool = False):
    """列出所有 active 计划(默认)。include_archived=true 也列出归档。"""
    return {"plans": _db.list_plans_with_stats(include_archived=include_archived)}


@app.get("/api/plans/current")
async def api_plans_current():
    """当前激活的计划 + 打卡记录。"""
    plan = _db.get_current_plan()
    if not plan:
        return {"plan": None, "check_ins": []}
    return {"plan": plan, "check_ins": _db.list_check_ins(plan["id"])}


@app.post("/api/plans")
async def api_plans_create(req: Request):
    body = await req.json()
    name = (body.get("name") or "").strip() or "未命名计划"
    plan_data = body.get("plan") or {}
    make_current = bool(body.get("make_current", True))
    plan = _db.create_plan(name, plan_data, make_current=make_current)
    return {"plan": plan}


@app.patch("/api/plans/{plan_id}")
async def api_plans_update(plan_id: str, req: Request):
    body = await req.json()
    name = body.get("name")
    archived = body.get("archived")  # True/False/None
    if archived is None and name is None and "current" not in body:
        raise HTTPException(400, "no-op patch")
    if "current" in body and body["current"]:
        result = _db.set_current_plan(plan_id)
        if not result:
            raise HTTPException(404, "plan not found or archived")
        return {"plan": result}
    if "current" in body and not body["current"]:
        # 取消当前:置 0
        conn = _db.get_default_conn()
        conn.execute("UPDATE plans SET is_current = 0 WHERE id = ?", (plan_id,))
    plan = _db.update_plan(plan_id, name=name, archived=archived)
    if not plan:
        raise HTTPException(404, "plan not found")
    return {"plan": plan}


@app.delete("/api/plans/{plan_id}")
async def api_plans_delete(plan_id: str):
    ok = _db.delete_plan(plan_id)
    if not ok:
        raise HTTPException(404, "plan not found")
    return {"deleted": True}


@app.post("/api/plans/{plan_id}/check-in")
async def api_check_in(plan_id: str, req: Request):
    body = await req.json()
    day_number = body.get("day_number")
    note = body.get("note")
    if not isinstance(day_number, int):
        raise HTTPException(400, "day_number must be int")
    ci = _db.check_in_day(plan_id, day_number, note=note)
    if not ci:
        raise HTTPException(404, "plan not found")
    return {"check_in": ci}


@app.delete("/api/plans/{plan_id}/check-in/{day_number}")
async def api_check_in_undo(plan_id: str, day_number: int):
    ok = _db.undo_check_in(plan_id, day_number)
    if not ok:
        raise HTTPException(404, "check-in not found")
    return {"undone": True}


@app.get("/api/plans/{plan_id}/check-ins")
async def api_check_ins_list(plan_id: str):
    return {"check_ins": _db.list_check_ins(plan_id)}


@app.post("/api/migrate")
async def api_migrate(req: Request):
    """从前端 localStorage 迁数据到 DB(首次访问时调用一次)。
    接受:{plans: [...], check_ins: [...]}。已存在则跳过。
    """
    body = await req.json()
    plans = body.get("plans", []) or []
    check_ins = body.get("check_ins", []) or []
    existing = _db.list_plans(include_archived=True)
    existing_ids = {p["id"] for p in existing}

    migrated = 0
    for entry in plans:
        pid = entry.get("id")
        if not pid or pid in existing_ids:
            continue
        try:
            conn = _db.get_default_conn()
            conn.execute(
                """INSERT INTO plans (id, name, plan_data, created_at, archived_at, is_current)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    pid,
                    entry.get("name", "迁移计划"),
                    _json.dumps(entry.get("plan", {}), ensure_ascii=False),
                    entry.get("saved_at") or "",
                    None,
                    1 if entry.get("is_current") else 0,
                ),
            )
            migrated += 1
        except Exception:
            pass

    ci_migrated = 0
    for ci in check_ins:
        pid = ci.get("plan_id")
        day = ci.get("day_number")
        if not pid or day is None:
            continue
        try:
            conn = _db.get_default_conn()
            conn.execute(
                """INSERT OR IGNORE INTO check_ins (plan_id, day_number, completed_at, note)
                   VALUES (?, ?, ?, ?)""",
                (pid, int(day), ci.get("completed_at", ""), ci.get("note")),
            )
            ci_migrated += 1
        except Exception:
            pass

    return {"plans_migrated": migrated, "check_ins_migrated": ci_migrated}


# ─── Static ───────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ─── TTS(服务端实时合成 mp3) ─────────────────────────────────────
# 用 macOS `say -v Tingting` 拼 aiff,ffmpeg 转 mp3,缓存到 /tmp/tts_cache。
# 浏览器 fetch /api/tts?text=... 拿 mp3 直接 Audio 元素播放。
TTS_CACHE_DIR = Path("/tmp/tts_cache")
TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
TTS_VOICE = "Tingting"


def _tts_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


@app.get("/api/tts")
async def api_tts(text: str):
    """合成中文 mp3(text 用 say -v Tingting)。缓存命中直接 serve。"""
    text = (text or "").strip()
    if not text:
        return JSONResponse({"error": "empty"}, status_code=400)
    if len(text) > 200:
        text = text[:200]
    key = _tts_key(text)
    mp3_path = TTS_CACHE_DIR / f"{key}.mp3"
    if mp3_path.exists():
        from fastapi.responses import FileResponse
        return FileResponse(str(mp3_path), media_type="audio/mpeg")

    aiff_tmp = TTS_CACHE_DIR / f"{key}.aiff"
    try:
        subprocess.run(
            ["say", "-v", TTS_VOICE, "-o", str(aiff_tmp), text],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(aiff_tmp),
             "-codec:a", "libmp3lame", "-b:a", "64k",
             "-ar", "22050", "-ac", "1", str(mp3_path)],
            check=True, capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        return JSONResponse(
            {"error": "tts_failed", "message": str(e)},
            status_code=500,
        )
    finally:
        if aiff_tmp.exists():
            aiff_tmp.unlink()
    from fastapi.responses import FileResponse
    return FileResponse(str(mp3_path), media_type="audio/mpeg")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")