import os
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")


def _hash_password(plain: str) -> bytes:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt())


def _check_password(plain: str, hashed: bytes) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed)
    except ValueError:
        return False


USERS = {
    "surveyor": {"role": "writer", "password_hash": _hash_password("surv123456")},
    "reviewer": {"role": "reader", "password_hash": _hash_password("rev123456")},
}

app = Sanic("bridge-strain-shift")

# 差值口径（随预览与抄档一并下发，页面只展示、不参与运算）
CALC_BASIS = (
    "差值＝基准跨微应变－对照跨微应变；"
    "双方各取所选时窗内办结时刻最近的一条已办结读数，由服务端计算。"
)

# 取某跨在时窗内的最近办结点（办结时刻落在窗外的点不取）
LATEST_DONE_SQL = """
SELECT id, span_code, microstrain, verdict, processed_at
FROM strain_readings
WHERE span_code = %s
  AND status = 'done'
  AND processed_at IS NOT NULL
  AND processed_at BETWEEN %s AND %s
ORDER BY processed_at DESC, id DESC
LIMIT 1
"""

# 报送抄档：同一条语句内重取两侧办结点、在数据库内做差并盖截止时刻。
# 任一侧时窗内无办结点时 CROSS JOIN 结果为空，整行不插入（缺一边整题失败）。
INSERT_COMPARISON_SQL = """
WITH b AS (
    SELECT id, microstrain, processed_at
    FROM strain_readings
    WHERE span_code = %(baseline)s
      AND status = 'done'
      AND processed_at IS NOT NULL
      AND processed_at BETWEEN %(window_start)s AND %(window_end)s
    ORDER BY processed_at DESC, id DESC
    LIMIT 1
),
c AS (
    SELECT id, microstrain, processed_at
    FROM strain_readings
    WHERE span_code = %(comparison)s
      AND status = 'done'
      AND processed_at IS NOT NULL
      AND processed_at BETWEEN %(window_start)s AND %(window_end)s
    ORDER BY processed_at DESC, id DESC
    LIMIT 1
)
INSERT INTO span_comparisons (
    baseline_span, comparison_span, window_start, window_end,
    baseline_reading_id, comparison_reading_id,
    baseline_microstrain, comparison_microstrain,
    baseline_processed_at, comparison_processed_at,
    difference_microstrain, cutoff_at, created_by
)
SELECT %(baseline)s, %(comparison)s, %(window_start)s, %(window_end)s,
       b.id, c.id, b.microstrain, c.microstrain,
       b.processed_at, c.processed_at,
       b.microstrain - c.microstrain,
       now(), %(created_by)s
FROM b CROSS JOIN c
RETURNING *
"""


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


def _parse_dt(value, field: str) -> datetime:
    if not value:
        raise ValueError(f"{field}不能为空")
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _reading_brief(row) -> dict | None:
    if row is None:
        return None
    return {
        "reading_id": row["id"],
        "span_code": row["span_code"],
        "microstrain": row["microstrain"],
        "verdict": row["verdict"],
        "processed_at": _iso(row["processed_at"]),
    }


def _comparison_out(row) -> dict:
    return {
        "id": row["id"],
        "baseline_span": row["baseline_span"],
        "comparison_span": row["comparison_span"],
        "window_start": _iso(row["window_start"]),
        "window_end": _iso(row["window_end"]),
        "baseline_reading_id": row["baseline_reading_id"],
        "comparison_reading_id": row["comparison_reading_id"],
        "baseline_microstrain": row["baseline_microstrain"],
        "comparison_microstrain": row["comparison_microstrain"],
        "baseline_processed_at": _iso(row["baseline_processed_at"]),
        "comparison_processed_at": _iso(row["comparison_processed_at"]),
        "difference_microstrain": row["difference_microstrain"],
        "cutoff_at": _iso(row["cutoff_at"]),
        "created_by": row["created_by"],
        "created_at": _iso(row["created_at"]),
        "calculation_basis": CALC_BASIS,
    }


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
    if not user or not _check_password(password, user["password_hash"]):
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


def _parse_window(source):
    """解析并校验基准跨/对照跨/时窗。返回 (baseline, comparison, start, end)。"""
    baseline = str(source.get("baseline_span", "")).strip()
    comparison = str(source.get("comparison_span", "")).strip()
    if not baseline or not comparison:
        raise ValueError("基准跨与对照跨都必须点名选择")
    if baseline == comparison:
        raise ValueError("基准跨与对照跨不能为同一跨")
    window_start = _parse_dt(source.get("window_start"), "时窗起点")
    window_end = _parse_dt(source.get("window_end"), "时窗终点")
    if window_start >= window_end:
        raise ValueError("时窗起点必须早于终点")
    return baseline, comparison, window_start, window_end


@app.get("/api/spans")
async def list_spans(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT span_code,
                       COUNT(*) FILTER (WHERE status = 'done') AS done_count,
                       MAX(processed_at) AS latest_processed_at
                FROM strain_readings
                GROUP BY span_code
                ORDER BY span_code
                """
            )
            rows = await cur.fetchall()
    return sanic_json(
        [
            {
                "span_code": r["span_code"],
                "done_count": r["done_count"],
                "latest_processed_at": _iso(r["latest_processed_at"]),
            }
            for r in rows
        ]
    )


@app.get("/api/span-comparison")
async def preview_span_comparison(request):
    """邻跨对照预览：双方各取时窗内最近办结点，差值由服务端计算。"""
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    try:
        baseline, comparison, window_start, window_end = _parse_window(
            request.args
        )
    except ValueError as exc:
        return sanic_json({"detail": str(exc)}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                LATEST_DONE_SQL, (baseline, window_start, window_end)
            )
            base_row = await cur.fetchone()
            await cur.execute(
                LATEST_DONE_SQL, (comparison, window_start, window_end)
            )
            comp_row = await cur.fetchone()

    missing = []
    if base_row is None:
        missing.append(f"基准跨 {baseline}")
    if comp_row is None:
        missing.append(f"对照跨 {comparison}")

    # 两侧都无办结（或缺任一侧）时不造差值，difference_microstrain 置 null
    difference = None
    comparable = base_row is not None and comp_row is not None
    if comparable:
        difference = float(base_row["microstrain"]) - float(
            comp_row["microstrain"]
        )

    return sanic_json(
        {
            "baseline_span": baseline,
            "comparison_span": comparison,
            "window_start": _iso(window_start),
            "window_end": _iso(window_end),
            "baseline": _reading_brief(base_row),
            "comparison": _reading_brief(comp_row),
            "difference_microstrain": difference,
            "comparable": comparable,
            "missing": missing,
            "missing_reason": (
                "时窗内" + "、".join(missing) + "没有已办结读数，不成差"
                if missing
                else None
            ),
            "calculation_basis": CALC_BASIS,
        }
    )


@app.get("/api/span-comparisons")
async def list_span_comparisons(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM span_comparisons ORDER BY id DESC"
            )
            rows = await cur.fetchall()
    return sanic_json([_comparison_out(r) for r in rows])


@app.post("/api/span-comparisons")
async def create_span_comparison(request):
    """报送抄档：仅测量员。同一事务内重取双方办结点、服务端重算差值并盖截止时刻；
    任一侧时窗内无办结点则整单失败、不落任何记录。
    浏览器私填的 difference_microstrain 等字段一律不读、不算数。"""
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可报送邻跨对照抄档，复核侧只读"}, status=403)

    body = request.json or {}
    try:
        baseline, comparison, window_start, window_end = _parse_window(body)
    except ValueError as exc:
        return sanic_json({"detail": str(exc)}, status=400)

    params = {
        "baseline": baseline,
        "comparison": comparison,
        "window_start": window_start,
        "window_end": window_end,
        "created_by": user["username"],
    }
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        try:
            async with conn.cursor() as cur:
                await cur.execute(INSERT_COMPARISON_SQL, params)
                row = await cur.fetchone()
                if row is None:
                    # 缺一侧（或两侧）办结点：整题失败
                    await cur.execute(
                        LATEST_DONE_SQL, (baseline, window_start, window_end)
                    )
                    base_row = await cur.fetchone()
                    await cur.execute(
                        LATEST_DONE_SQL, (comparison, window_start, window_end)
                    )
                    comp_row = await cur.fetchone()
                    missing = []
                    if base_row is None:
                        missing.append(f"基准跨 {baseline}")
                    if comp_row is None:
                        missing.append(f"对照跨 {comparison}")
                    detail = (
                        "时窗内" + "、".join(missing) + "没有已办结读数，"
                        "差值无法在服务端重算，本次报送整单失败且未抄档"
                    )
                    await conn.rollback()
                    return sanic_json({"detail": detail}, status=422)
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise

    return sanic_json(_comparison_out(row), status=201)
