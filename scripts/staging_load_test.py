#!/usr/bin/env python3
"""Run the staging user journey from the staging host itself."""

from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from random import random


BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8001"
TOKEN_FILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/staging-load-tokens.json"
STAGES = [int(value) for value in (sys.argv[3] if len(sys.argv) > 3 else "10,50,100,250,500,1000,2000,3000").split(",")]
FIXTURE = json.load(open(TOKEN_FILE, encoding="utf-8"))
TOKENS = FIXTURE["tokens"]
QUESTION_ID = urllib.parse.quote(str(FIXTURE["questionId"]), safe="")


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(len(ordered) * fraction + 0.999) - 1))]


def request(path, token=None, method="GET", payload=None, key=None):
    started = time.perf_counter()
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        headers["Content-Type"] = "application/json"
        headers["Idempotency-Key"] = key or "staging-load-" + str(time.time_ns())
    try:
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            parsed = json.loads(raw.decode()) if raw else None
            return response.status, (time.perf_counter() - started) * 1000, parsed
    except Exception as error:  # noqa: BLE001 - load test records failures instead of aborting
        return 0, (time.perf_counter() - started) * 1000, str(error)


def user_journey(index):
    token = TOKENS[index]
    rows = []
    for path in (
        "/api/student/v1/categories/",
        "/api/student/v1/articles/",
        "/api/student/v1/questions/?source=literature&categoryId=pre-qin",
    ):
        rows.append(request(path))
    rows.append(request(f"/api/student/v1/questions/{QUESTION_ID}/", token))
    rows.append(request("/api/student/v1/me/statistics/", token))
    rows.append(request("/api/student/v1/me/resume/", token))
    status, elapsed, current = request(f"/api/student/v1/me/questions/{QUESTION_ID}/state/", token)
    rows.append((status, elapsed, current))
    version = current.get("version", 0) if isinstance(current, dict) else 0
    rows.append(request(
        f"/api/student/v1/me/questions/{QUESTION_ID}/state/",
        token,
        "PUT",
        {"mastered": bool(random() < 0.5), "baseVersion": version},
        f"staging-load-{index}-{time.time_ns()}",
    ))
    return rows


for count in STAGES:
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=count) as executor:
        rows = [item for batch in executor.map(user_journey, range(count)) for item in batch]
    durations = [row[1] for row in rows]
    failures = [row for row in rows if not 200 <= row[0] < 300]
    print(json.dumps({
        "virtualUsers": count,
        "requests": len(rows),
        "durationSeconds": round(time.perf_counter() - started, 2),
        "p95Ms": round(percentile(durations, 0.95), 1),
        "p99Ms": round(percentile(durations, 0.99), 1),
        "errorRate": round(len(failures) / max(1, len(rows)), 5),
        "statusCounts": {str(code): sum(row[0] == code for row in rows) for code in sorted({row[0] for row in rows})},
        "sampleErrors": [row[2] for row in failures[:3]],
    }, ensure_ascii=False), flush=True)
