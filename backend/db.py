import os
from datetime import datetime, timedelta, timezone

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from rules import judge_microstrain

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://app:app@localhost:54398/bridgestrain"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS strain_readings (
    id serial PRIMARY KEY,
    span_code text NOT NULL,
    microstrain double precision NOT NULL,
    verdict text,
    reason text,
    status text NOT NULL DEFAULT 'pending',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_strain_readings_status ON strain_readings (status, id);
CREATE INDEX IF NOT EXISTS idx_strain_readings_span_done
    ON strain_readings (span_code, processed_at DESC)
    WHERE status = 'done';

-- 邻跨对照报送抄档：差值只由服务端在同一事务内重算并落档，
-- 截止时刻 cutoff_at 与差值取自同一次快照，缺任一侧整单不落。
CREATE TABLE IF NOT EXISTS span_comparisons (
    id serial PRIMARY KEY,
    baseline_span text NOT NULL,
    comparison_span text NOT NULL,
    window_start timestamptz NOT NULL,
    window_end timestamptz NOT NULL,
    baseline_reading_id bigint NOT NULL REFERENCES strain_readings (id),
    comparison_reading_id bigint NOT NULL REFERENCES strain_readings (id),
    baseline_microstrain double precision NOT NULL,
    comparison_microstrain double precision NOT NULL,
    baseline_processed_at timestamptz NOT NULL,
    comparison_processed_at timestamptz NOT NULL,
    difference_microstrain double precision NOT NULL,
    cutoff_at timestamptz NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_span_comparisons_created
    ON span_comparisons (id DESC);
"""

# (跨段, 微应变, 办结时刻距今天数)。每跨至少一个办结点；
# 部分跨只有窗外点，用于验证“办结时刻落在所选时窗外的点不得计入差”。
SEED_DONE = [
    ("跨中S1", 150.0, 0),
    ("跨中S1", 142.0, 24),
    ("支座S2", 40.0, 0),
    ("支座S2", 46.0, 24),
    ("跨中S3", 170.0, 3),
    ("跨中S3", 158.0, 20),
    ("支座S4", 90.0, 0),
    ("跨中S5", 168.0, 6),
    ("支座S6", 85.0, 12),
    ("远跨S7", 230.0, 45),
]


def _seed_done_rows(cur) -> None:
    now = datetime.now(timezone.utc)
    for span_code, microstrain, age_days in SEED_DONE:
        verdict, reason = judge_microstrain(microstrain)
        ts = now - timedelta(days=age_days)
        cur.execute(
            """
            INSERT INTO strain_readings
                (span_code, microstrain, verdict, reason, status,
                 created_by, created_at, processed_at)
            VALUES (%s, %s, %s, %s, 'done', 'surveyor', %s, %s)
            """,
            (span_code, microstrain, verdict, reason, ts, ts),
        )


async def create_pool() -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        conninfo=DSN,
        min_size=1,
        max_size=5,
        kwargs={"row_factory": dict_row},
        open=False,
    )
    await pool.open()
    return pool


async def ensure_schema(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        await conn.execute(SCHEMA_SQL)
        await conn.commit()


async def seed_if_empty(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS n FROM strain_readings")
            row = await cur.fetchone()
            if row["n"] > 0:
                return
            await _seed_done_rows(cur)
        await conn.commit()


def connect_sync():
    import psycopg

    return psycopg.connect(DSN, row_factory=dict_row)


def ensure_schema_sync(conn) -> None:
    conn.execute(SCHEMA_SQL)


def seed_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM strain_readings").fetchone()
    if row["n"] > 0:
        return
    with conn.cursor() as cur:
        _seed_done_rows(cur)
    conn.commit()
