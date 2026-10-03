import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _parse_dt(value):
    """解析时窗边界；返回 (datetime|None, 错误信息|None)。空值视为不限。"""
    if value is None:
        return None, None
    if not isinstance(value, str):
        return None, "时窗边界必须是 ISO 时间字符串"
    text = value.strip()
    if not text:
        return None, None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None, "时窗边界不是合法的 ISO 时间"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt, None


def _comparison_out(r: dict) -> dict:
    return {
        "id": r["id"],
        "baseline_span": r["baseline_span"],
        "compare_span": r["compare_span"],
        "window_start": _iso(r["window_start"]),
        "window_end": _iso(r["window_end"]),
        "baseline_reading_id": r["baseline_reading_id"],
        "baseline_microstrain": r["baseline_microstrain"],
        "baseline_processed_at": _iso(r["baseline_processed_at"]),
        "compare_reading_id": r["compare_reading_id"],
        "compare_microstrain": r["compare_microstrain"],
        "compare_processed_at": _iso(r["compare_processed_at"]),
        "diff_microstrain": r["diff_microstrain"],
        "computed_by": r["computed_by"],
        "computed_at": _iso(r["computed_at"]),
    }


# 重算与截止时刻抄档在同一条 SQL（同一事务）内完成：
# 两侧各取时窗内办结时刻最新的 done 读数，差值由数据库计算，
# 任一侧无办结时 diff 为 NULL，不假造。
RECOMPUTE_SQL = """
WITH b AS (
    SELECT id, microstrain, processed_at
    FROM strain_readings
    WHERE span_code = %(baseline)s
      AND status = 'done'
      AND (%(ws)s::timestamptz IS NULL OR processed_at >= %(ws)s::timestamptz)
      AND (%(we)s::timestamptz IS NULL OR processed_at <= %(we)s::timestamptz)
    ORDER BY processed_at DESC, id DESC
    LIMIT 1
),
c AS (
    SELECT id, microstrain, processed_at
    FROM strain_readings
    WHERE span_code = %(compare)s
      AND status = 'done'
      AND (%(ws)s::timestamptz IS NULL OR processed_at >= %(ws)s::timestamptz)
      AND (%(we)s::timestamptz IS NULL OR processed_at <= %(we)s::timestamptz)
    ORDER BY processed_at DESC, id DESC
    LIMIT 1
)
INSERT INTO span_comparisons (
    baseline_span, compare_span, window_start, window_end,
    baseline_reading_id, baseline_microstrain, baseline_processed_at,
    compare_reading_id, compare_microstrain, compare_processed_at,
    diff_microstrain, computed_by, computed_at
)
SELECT
    %(baseline)s,
    %(compare)s,
    %(ws)s::timestamptz,
    %(we)s::timestamptz,
    (SELECT id FROM b),
    (SELECT microstrain FROM b),
    (SELECT processed_at FROM b),
    (SELECT id FROM c),
    (SELECT microstrain FROM c),
    (SELECT processed_at FROM c),
    (SELECT b.microstrain - c.microstrain FROM b, c),
    %(computed_by)s,
    now()
RETURNING id, baseline_span, compare_span, window_start, window_end,
          baseline_reading_id, baseline_microstrain, baseline_processed_at,
          compare_reading_id, compare_microstrain, compare_processed_at,
          diff_microstrain, computed_by, computed_at
"""


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


@app.get("/api/spans")
async def list_spans(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT DISTINCT span_code FROM strain_readings ORDER BY span_code"
            )
            rows = await cur.fetchall()
    return sanic_json([r["span_code"] for r in rows])


@app.get("/api/comparisons")
async def list_comparisons(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    baseline = (request.args.get("baseline_span") or "").strip()
    compare = (request.args.get("compare_span") or "").strip()
    if not baseline or not compare:
        return sanic_json({"detail": "基准跨与对照跨不能为空"}, status=400)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, baseline_span, compare_span, window_start, window_end,
                       baseline_reading_id, baseline_microstrain, baseline_processed_at,
                       compare_reading_id, compare_microstrain, compare_processed_at,
                       diff_microstrain, computed_by, computed_at
                FROM span_comparisons
                WHERE baseline_span = %s AND compare_span = %s
                ORDER BY id DESC
                LIMIT 20
                """,
                (baseline, compare),
            )
            rows = await cur.fetchall()
    return sanic_json([_comparison_out(r) for r in rows])


@app.post("/api/comparisons/recompute")
async def recompute_comparison(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可重算并抄档，复核侧只读"}, status=403)
    body = request.json or {}
    baseline = str(body.get("baseline_span", "")).strip()
    compare = str(body.get("compare_span", "")).strip()
    if not baseline or not compare:
        return sanic_json({"detail": "基准跨与对照跨不能为空"}, status=400)
    window_start, err = _parse_dt(body.get("window_start"))
    if err:
        return sanic_json({"detail": f"时窗起点：{err}"}, status=400)
    window_end, err = _parse_dt(body.get("window_end"))
    if err:
        return sanic_json({"detail": f"时窗终点：{err}"}, status=400)
    if window_start and window_end and window_start > window_end:
        return sanic_json({"detail": "时窗起点不能晚于终点"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                RECOMPUTE_SQL,
                {
                    "baseline": baseline,
                    "compare": compare,
                    "ws": window_start,
                    "we": window_end,
                    "computed_by": user["username"],
                },
            )
            row = await cur.fetchone()
        await conn.commit()

    out = _comparison_out(row)
    out["message"] = "已重算并抄档"
    return sanic_json(out, status=201)
