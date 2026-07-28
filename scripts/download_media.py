"""下载 exercises-dataset 的所有 GIF + 图片到本地,前端就走本地,不依赖外网。

用法:
    python3 scripts/download_media.py
    # 或指定目标目录:
    python3 scripts/download_media.py --out web/static/media
    # 或从不同的镜像拉(国内):
    python3 scripts/download_media.py --base https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@main

跑完一次就好,后续前端都用本地。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError

DEFAULT_BASE = "https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "web" / "static" / "media"
DATA_JSON = Path(__file__).resolve().parent.parent / "data" / "exercises.json"

USER_AGENT = "sport-downloader/1.0"


def fetch(url: str, dest: Path, retries: int = 3) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True  # 已下载,跳过
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(req, timeout=15) as r:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(r.read())
            return True
        except (URLError, OSError, TimeoutError) as e:
            if attempt == retries - 1:
                print(f"  × {url}: {e}", file=sys.stderr)
                return False
            time.sleep(0.5 * (attempt + 1))
    return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", default=DEFAULT_BASE,
                   help="上游 base URL(默认 raw.githubusercontent)")
    p.add_argument("--out", default=str(DEFAULT_OUT), help="本地输出目录")
    p.add_argument("--workers", type=int, default=8, help="并发下载数")
    args = p.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not DATA_JSON.exists():
        print(f"找不到 {DATA_JSON}", file=sys.stderr)
        return 1

    with open(DATA_JSON) as f:
        exercises = json.load(f)

    # 收集所有 gif / image URL
    tasks = []
    for ex in exercises:
        gif_rel = ex.get("gif_url", "")
        img_rel = ex.get("image", "")
        if gif_rel:
            tasks.append((args.base + "/" + gif_rel, out_dir / gif_rel, "gif"))
        if img_rel:
            tasks.append((args.base + "/" + img_rel, out_dir / img_rel, "img"))

    print(f"需要下载 {len(tasks)} 个文件到 {out_dir}")
    print(f"base: {args.base}")

    ok = 0
    fail = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch, url, dest): (url, kind)
                   for url, dest, kind in tasks}
        done = 0
        for fut in as_completed(futures):
            done += 1
            if fut.result():
                ok += 1
            else:
                fail += 1
            if done % 50 == 0:
                print(f"  ... {done}/{len(tasks)} (ok={ok}, fail={fail})")

    print(f"\n完成:ok={ok}, fail={fail}")
    if fail:
        print(f"失败的可以重跑,已存在的会被跳过")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())