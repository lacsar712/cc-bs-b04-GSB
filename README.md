# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

顶栏 **邻跨对照** 专页可点名选择基准跨与对照跨及办结时窗，中列展示双方时窗内最近办结微应变与**服务端计算**的差值（差值＝基准跨－对照跨），下挂口径说明；测量员可报送抄档，复核员只读。

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
| surveyor | surv123456 | 测量员，可提交读数、可报送邻跨对照抄档 |
| reviewer | rev123456 | 复核员，只读列表/对照预览/抄档台账，不能报送 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变（最近办结/更早） | 结论 |
|------|--------|------|
| 跨中S1 | 150 / 142 με | 合格 |
| 支座S2 | 40 / 46 με | 越界 |
| 跨中S3 | 170（3天前）/ 158（20天前） | 合格 |
| 支座S4 | 90 με | 合格 |
| 跨中S5 | 168 με（6天前） | 合格 |
| 支座S6 | 85 με（12天前） | 合格 |
| 远跨S7 | 230 με（45天前） | 越界，落在近30天时窗外 |

多时点种子用于验证：每跨只取**时窗内办结时刻最近**的一条；办结时刻落在所选时窗外的点不计入差值。

## 邻跨对照口径

- 差值＝**基准跨微应变－对照跨微应变**，双方各取所选时窗（按 `processed_at` 办结时刻）内最近的一条 `done` 读数。
- **差值只由服务端计算**，页面不做任何相减；接口随结果下发口径文案。
- 任一侧（或两侧）时窗内无办结读数时不成差，`difference_microstrain` 为 `null`，不假造数值。
- 报送抄档（`POST /api/span-comparisons`，仅测量员）在**同一事务**内重取两侧读数、在数据库内重算差值并盖 `cutoff_at` 截止时刻快照；缺任一侧返回 **422**，整单不落档。
- 请求体中私填的 `difference_microstrain`、`cutoff_at` 等字段服务端一律不读；跳过后台重算视为未完成。

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/api/spans` | GET | 登录 | 跨段清单与办结条数，供点名选择 |
| `/api/span-comparison` | GET | 登录 | 对照预览（query：双方跨号 + `window_start/window_end` ISO8601） |
| `/api/span-comparisons` | GET | 登录 | 抄档台账（复核员可看） |
| `/api/span-comparisons` | POST | 测量员 | 同事务重算差值 + 截止时刻并抄档，缺侧 422 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
