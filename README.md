# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

顶栏「邻跨对照」专页支持点名选跨对差：上方选 **基准跨 / 对照跨** 与时窗，中部列双方 **最近办结微应变** 与 **差值**，下方挂口径与抄档记录。

## 邻跨对照口径

- 差值 = 基准跨最近办结微应变 − 对照跨最近办结微应变，**一律服务端计算**，页面不得自行相减。
- 仅取状态为 **办结（done）** 的读数，且 **办结时刻** 须落在所选时窗内；时窗外的点不计入差值。
- 每侧取时窗内办结时刻最新的一条；任一侧无办结读数时，差值留空（`null`），不假造。
- 每次 **重算与截止时刻抄档在同一次服务端操作（同一事务）内完成**，缺一不可；抄档落 `span_comparisons` 表。
- 测量员可选跨重算报送；复核员只读，不能报送（接口返回 403）。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/spans` | 列出可点名对照的跨段 |
| GET | `/api/comparisons?baseline_span=&compare_span=` | 查该跨组合的抄档记录（两类角色均可） |
| POST | `/api/comparisons/recompute` | 仅测量员；按 `{baseline_span, compare_span, window_start, window_end}` 重算并抄档，返回本次抄档 |

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
