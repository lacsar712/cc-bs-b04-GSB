import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  page: "readings",
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
};

// 邻跨对照专页状态：差值只展示服务端抄档结果，页面不做任何相减。
const compare = {
  spans: [],
  baseline: "",
  compare: "",
  preset: "all",
  windowStart: "",
  windowEnd: "",
  latest: null,
  history: [],
  ready: false,
  loading: false,
  error: "",
  msg: "",
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

async function poll() {
  await loadReadings();
  if (state.page === "compare" && compare.ready) {
    try {
      await loadComparisons();
    } catch {
      /* 轮询失败静默，保留页面现有数据 */
    }
    m.redraw();
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(poll, 3000);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtNum(v) {
  if (v === null || v === undefined) return "—";
  return String(Math.round(Number(v) * 100) / 100);
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function applyPreset(p) {
  compare.preset = p;
  if (p === "all") {
    compare.windowStart = "";
    compare.windowEnd = "";
    return;
  }
  const hours = { "1h": 1, "8h": 8, "24h": 24 }[p] || 24;
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  compare.windowStart = toLocalInput(start);
  compare.windowEnd = toLocalInput(end);
}

async function loadSpans() {
  compare.spans = await api("/api/spans");
  if (!compare.baseline || !compare.spans.includes(compare.baseline)) {
    compare.baseline = compare.spans[0] || "";
  }
  if (!compare.compare || !compare.spans.includes(compare.compare)) {
    compare.compare =
      compare.spans.find((s) => s !== compare.baseline) || compare.baseline;
  }
}

async function loadComparisons() {
  if (!compare.baseline || !compare.compare) {
    compare.history = [];
    compare.latest = null;
    return;
  }
  const q =
    `/api/comparisons?baseline_span=${encodeURIComponent(compare.baseline)}` +
    `&compare_span=${encodeURIComponent(compare.compare)}`;
  compare.history = await api(q);
  compare.latest = compare.history.length ? compare.history[0] : null;
}

async function ensureCompareReady() {
  compare.error = "";
  try {
    await loadSpans();
    await loadComparisons();
    compare.ready = true;
  } catch (err) {
    compare.error = err.message || "加载邻跨对照失败";
  }
  m.redraw();
}

async function onPairChange() {
  compare.msg = "";
  compare.error = "";
  try {
    await loadComparisons();
  } catch (err) {
    compare.error = err.message || "加载抄档记录失败";
  }
  m.redraw();
}

async function recompute() {
  compare.error = "";
  compare.msg = "";
  compare.loading = true;
  try {
    const payload = {
      baseline_span: compare.baseline,
      compare_span: compare.compare,
      window_start: compare.windowStart
        ? new Date(compare.windowStart).toISOString()
        : null,
      window_end: compare.windowEnd
        ? new Date(compare.windowEnd).toISOString()
        : null,
    };
    const data = await api("/api/comparisons/recompute", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    compare.msg = data.message || "已重算并抄档";
    await loadComparisons();
  } catch (err) {
    compare.error = err.message || "重算失败";
  } finally {
    compare.loading = false;
    m.redraw();
  }
}

function windowLabel(rec) {
  const s = rec.window_start ? fmtTime(rec.window_start) : "不限";
  const e = rec.window_end ? fmtTime(rec.window_end) : "不限";
  return `${s} ~ ${e}`;
}

function sideBox(title, span, value, processedAt) {
  const missing = value === null || value === undefined;
  return m("div.side", [
    m("div.side-title", `${title}：${span}`),
    m("div.side-value", missing ? "无办结读数" : `${fmtNum(value)} με`),
    m("div.muted", missing ? "时窗内无办结点" : `办结于 ${fmtTime(processedAt)}`),
  ]);
}

function compareView() {
  const isWriter = state.user?.role === "writer";
  const L = compare.latest;
  const bothMissing =
    L && L.baseline_microstrain === null && L.compare_microstrain === null;
  const oneMissing =
    L &&
    L.diff_microstrain === null &&
    !bothMissing &&
    (L.baseline_microstrain === null || L.compare_microstrain === null);

  return [
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "邻跨对照"),
      m(
        "p.sub",
        "点名选择基准跨与对照跨；差值由服务端重算，并随截止时刻一并抄档。"
      ),
      m("div.row", [
        m("label", [
          "基准跨",
          m(
            "select",
            {
              value: compare.baseline,
              onchange: async (e) => {
                compare.baseline = e.target.value;
                await onPairChange();
              },
            },
            compare.spans.map((s) =>
              m("option", { value: s, selected: s === compare.baseline }, s)
            )
          ),
        ]),
        m("label", [
          "对照跨",
          m(
            "select",
            {
              value: compare.compare,
              onchange: async (e) => {
                compare.compare = e.target.value;
                await onPairChange();
              },
            },
            compare.spans.map((s) =>
              m("option", { value: s, selected: s === compare.compare }, s)
            )
          ),
        ]),
        m("label", [
          "时窗开始",
          m("input", {
            type: "datetime-local",
            value: compare.windowStart,
            oninput: (e) => {
              compare.windowStart = e.target.value;
              compare.preset = "custom";
            },
          }),
        ]),
        m("label", [
          "时窗结束",
          m("input", {
            type: "datetime-local",
            value: compare.windowEnd,
            oninput: (e) => {
              compare.windowEnd = e.target.value;
              compare.preset = "custom";
            },
          }),
        ]),
      ]),
      m("div.row", { style: { marginTop: "0.75rem" } }, [
        ...[
          ["1h", "最近1小时"],
          ["8h", "最近8小时"],
          ["24h", "最近24小时"],
          ["all", "全部"],
        ].map(([key, label]) =>
          m(
            "button",
            {
              type: "button",
              class: compare.preset === key ? "preset active" : "preset",
              onclick: () => applyPreset(key),
            },
            label
          )
        ),
        isWriter
          ? m(
              "button",
              {
                type: "button",
                disabled:
                  compare.loading || !compare.baseline || !compare.compare,
                onclick: recompute,
              },
              compare.loading ? "重算中…" : "重算并抄档"
            )
          : null,
      ]),
      isWriter
        ? m("p.muted", "调整跨组合或时窗后，需点击“重算并抄档”生成新抄档。")
        : m("p.muted", "复核员只读：可查看抄档结果，不能重算报送。"),
      compare.error ? m("p.err", compare.error) : null,
      compare.msg ? m("p.ok", compare.msg) : null,
    ]),

    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "最近办结对照"),
      L
        ? m("div", [
            m("div.compare-grid", [
              sideBox(
                "基准跨",
                L.baseline_span,
                L.baseline_microstrain,
                L.baseline_processed_at
              ),
              sideBox(
                "对照跨",
                L.compare_span,
                L.compare_microstrain,
                L.compare_processed_at
              ),
            ]),
            m("div.diff-box", [
              m("div.diff-label", "差值（基准跨 − 对照跨，服务端计算）"),
              m(
                "div.diff-value",
                L.diff_microstrain === null
                  ? "—"
                  : `${fmtNum(L.diff_microstrain)} με`
              ),
              bothMissing
                ? m("p.muted", "两侧均无办结读数，不差值。")
                : oneMissing
                ? m("p.muted", "一侧无办结读数，差值留空。")
                : null,
            ]),
            m(
              "p.muted",
              `截止时刻（抄档）：${fmtTime(L.computed_at)} · 时窗：${windowLabel(
                L
              )} · 操作人：${L.computed_by}`
            ),
          ])
        : m(
            "p.sub",
            compare.baseline && compare.compare
              ? isWriter
                ? "该跨组合尚无抄档记录，点击“重算并抄档”生成。"
                : "该跨组合尚无抄档记录，待测量员重算抄档后展示。"
              : "暂无可对照的跨段。"
          ),
    ]),

    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "口径"),
      m("ul.caliber", [
        m(
          "li",
          "差值 = 基准跨最近办结微应变 − 对照跨最近办结微应变，一律由服务端计算，页面不得自行相减。"
        ),
        m(
          "li",
          "仅取状态为“办结”的读数，且办结时刻须落在所选时窗内；时窗外的点不计入差值。"
        ),
        m("li", "每侧取时窗内办结时刻最新的一条；任一侧无办结读数时，差值留空，不假造。"),
        m("li", "每次重算与截止时刻抄档在同一次服务端操作中完成，缺一不可。"),
        m("li", "测量员可选跨重算报送；复核员只读，不能报送。"),
      ]),
    ]),

    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "抄档记录"),
      compare.history.length
        ? m("table", [
            m("thead", [
              m("tr", [
                m("th", "编号"),
                m("th", "截止时刻"),
                m("th", "基准跨"),
                m("th", "基准值(με)"),
                m("th", "对照跨"),
                m("th", "对照值(με)"),
                m("th", "差值(με)"),
                m("th", "时窗"),
                m("th", "操作人"),
              ]),
            ]),
            m(
              "tbody",
              compare.history.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", fmtTime(r.computed_at)),
                  m("td", r.baseline_span),
                  m("td", fmtNum(r.baseline_microstrain)),
                  m("td", r.compare_span),
                  m("td", fmtNum(r.compare_microstrain)),
                  m(
                    "td",
                    r.diff_microstrain === null
                      ? "—"
                      : fmtNum(r.diff_microstrain)
                  ),
                  m("td", windowLabel(r)),
                  m("td", r.computed_by),
                ])
              )
            ),
          ])
        : m("p.sub", "暂无抄档记录"),
    ]),
  ];
}

function readingsView(isWriter) {
  return [
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m(
            "form",
            {
              onsubmit: async (e) => {
                e.preventDefault();
                state.error = "";
                state.msg = "";
                state.loading = true;
                try {
                  const data = await api("/api/readings", {
                    method: "POST",
                    body: JSON.stringify({
                      span_code: state.submitForm.span_code,
                      microstrain: parseFloat(state.submitForm.microstrain),
                    }),
                  });
                  state.msg = data.message || "已提交";
                  state.submitForm = { span_code: "", microstrain: "" };
                  await loadReadings();
                } catch (err) {
                  state.error = err.message || "提交失败";
                } finally {
                  state.loading = false;
                  m.redraw();
                }
              },
            },
            [
              m("div.row", [
                m("label", [
                  "跨段编号",
                  m("input", {
                    required: true,
                    placeholder: "例如 跨中S3",
                    value: state.submitForm.span_code,
                    oninput: (e) => {
                      state.submitForm.span_code = e.target.value;
                    },
                  }),
                ]),
                m("label", [
                  "微应变（με）",
                  m("input", {
                    required: true,
                    type: "number",
                    step: "0.1",
                    value: state.submitForm.microstrain,
                    oninput: (e) => {
                      state.submitForm.microstrain = e.target.value;
                    },
                  }),
                ]),
                m(
                  "button",
                  { type: "submit", disabled: state.loading },
                  "提交"
                ),
              ]),
              state.error ? m("p.err", state.error) : null,
              state.msg ? m("p.ok", state.msg) : null,
            ]
          ),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "结论"),
            m("th", "说明"),
            m("th", "状态"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.rows.length
            ? state.rows.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", r.span_code),
                  m("td", r.microstrain),
                  m("td", [
                    m(
                      "span",
                      { class: verdictClass(r.verdict, r.status) },
                      displayVerdict(r)
                    ),
                  ]),
                  m("td", r.reason || "—"),
                  m("td", r.status),
                  m("td", r.created_by),
                ])
              )
            : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
        ),
      ]),
    ]),
  ];
}

const App = {
  oninit() {
    loadReadings();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
          m("h1", "桥梁应变班交台"),
          m(
            "p.sub",
            "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
          ),
          m("div.card", [
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.loading = true;
                  try {
                    const data = await api("/api/auth/login", {
                      method: "POST",
                      body: JSON.stringify(state.loginForm),
                    });
                    state.token = data.access_token;
                    state.user = { username: data.username, role: data.role };
                    localStorage.setItem(TOKEN_KEY, state.token);
                    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
                    state.page = "readings";
                    compare.ready = false;
                    await loadReadings();
                    startPolling();
                  } catch {
                    state.error = "用户名或密码错误";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "用户名",
                    m("input", {
                      value: state.loginForm.username,
                      oninput: (e) => {
                        state.loginForm.username = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "密码",
                    m("input", {
                      type: "password",
                      value: state.loginForm.password,
                      oninput: (e) => {
                        state.loginForm.password = e.target.value;
                      },
                    }),
                  ]),
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
              ]
            ),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
            ),
          ]),
        ]
      );
    }

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div.nav", [
          m(
            "button",
            {
              type: "button",
              class: state.page === "readings" ? "nav active" : "nav",
              onclick: () => {
                state.page = "readings";
              },
            },
            "读数列表"
          ),
          m(
            "button",
            {
              type: "button",
              class: state.page === "compare" ? "nav active" : "nav",
              onclick: async () => {
                state.page = "compare";
                if (compare.ready) {
                  await onPairChange();
                } else {
                  await ensureCompareReady();
                }
              },
            },
            "邻跨对照"
          ),
        ]),
        m("div", [
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                state.token = "";
                state.user = null;
                state.rows = [];
                state.page = "readings";
                compare.ready = false;
                compare.latest = null;
                compare.history = [];
                if (state.timer) clearInterval(state.timer);
                m.redraw();
              },
            },
            "退出"
          ),
        ]),
      ]),
      ...(state.page === "compare" ? compareView() : readingsView(isWriter)),
    ]);
  },
};

export default App;
