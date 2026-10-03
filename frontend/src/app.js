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

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

function fmtNum(v) {
  if (v === null || v === undefined) return "—";
  return Number(v).toFixed(1);
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
  cmp: {
    spans: [],
    preset: "30",
    baseline_span: "",
    comparison_span: "",
    custom_start: "",
    custom_end: "",
    data: null,
    archive: [],
    loading: false,
    submitting: false,
    error: "",
    msg: "",
  },
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

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadReadings, 3000);
}

function stopPolling() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/* ---------- 邻跨对照 ---------- */

// 仅按时窗预设生成查询用的时窗参数；差值绝不在此（或页面任何位置）计算。
function cmpWindow(cmp) {
  if (cmp.preset === "custom") {
    if (!cmp.custom_start || !cmp.custom_end) {
      throw new Error("自定义时窗的起点与终点都必须填写");
    }
    return {
      window_start: new Date(cmp.custom_start).toISOString(),
      window_end: new Date(cmp.custom_end).toISOString(),
    };
  }
  const days = Number(cmp.preset);
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  return { window_start: start.toISOString(), window_end: end.toISOString() };
}

async function loadSpans() {
  const cmp = state.cmp;
  try {
    cmp.spans = await api("/api/spans");
    cmp.error = "";
  } catch (err) {
    cmp.error = err.message || "跨段清单加载失败";
  }
  m.redraw();
}

async function loadArchive() {
  const cmp = state.cmp;
  try {
    cmp.archive = await api("/api/span-comparisons");
  } catch {
    // 台账加载失败不阻断对照
  }
  m.redraw();
}

async function previewComparison() {
  const cmp = state.cmp;
  cmp.error = "";
  cmp.msg = "";
  if (!cmp.baseline_span || !cmp.comparison_span) {
    cmp.error = "请先点名选择基准跨与对照跨";
    return;
  }
  if (cmp.baseline_span === cmp.comparison_span) {
    cmp.error = "基准跨与对照跨不能为同一跨";
    return;
  }
  let win;
  try {
    win = cmpWindow(cmp);
  } catch (err) {
    cmp.error = err.message;
    return;
  }
  cmp.loading = true;
  try {
    const qs = new URLSearchParams({
      baseline_span: cmp.baseline_span,
      comparison_span: cmp.comparison_span,
      ...win,
    });
    cmp.data = await api(`/api/span-comparison?${qs.toString()}`);
  } catch (err) {
    cmp.data = null;
    cmp.error = err.message || "对照失败";
  } finally {
    cmp.loading = false;
    m.redraw();
  }
}

async function submitComparison() {
  const cmp = state.cmp;
  if (!cmp.data || !cmp.data.comparable) return;
  cmp.error = "";
  cmp.msg = "";
  cmp.submitting = true;
  try {
    // 只上送点名跨与窗口；差值由后台同事务重算，任何私填字段都不发送
    const saved = await api("/api/span-comparisons", {
      method: "POST",
      body: JSON.stringify({
        baseline_span: cmp.data.baseline_span,
        comparison_span: cmp.data.comparison_span,
        window_start: cmp.data.window_start,
        window_end: cmp.data.window_end,
      }),
    });
    cmp.msg = `已抄档（台账编号 ${saved.id}），差值与截止时刻由后台同一次重算落档`;
    await previewComparison();
    await loadArchive();
  } catch (err) {
    cmp.error = err.message || "报送失败";
  } finally {
    cmp.submitting = false;
    m.redraw();
  }
}

const PRESETS = [
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "60", label: "近 60 天" },
  { value: "custom", label: "自定义时窗" },
];

function spanSelect(valueAttr, label) {
  const cmp = state.cmp;
  return m("label", [
    label,
    m(
      "select",
      {
        value: cmp[valueAttr],
        onchange: (e) => {
          cmp[valueAttr] = e.target.value;
        },
      },
      [
        m("option", { value: "" }, "请选择跨段（点名）"),
        ...cmp.spans.map((s) =>
          m(
            "option",
            { value: s.span_code },
            `${s.span_code}（已办结 ${s.done_count} 条）`
          )
        ),
      ]
    ),
  ]);
}

function sideCell(side) {
  // side: cmp.data.baseline / cmp.data.comparison，可能为 null（时窗内无办结）
  if (!side) {
    return m("td.side.missing", [
      m("div.side-title", "时窗内无办结点"),
      m("div.muted", "不计入差值"),
    ]);
  }
  return m("td.side", [
    m("div.side-title", side.span_code),
    m("div.strain", `${fmtNum(side.microstrain)} με`),
    m("div.muted", [
      "最近办结：",
      fmtTime(side.processed_at),
      `（读数 #${side.reading_id}）`,
    ]),
    m(
      "span",
      { class: verdictClass(side.verdict, "done") },
      side.verdict || "—"
    ),
  ]);
}

function comparisonView() {
  const cmp = state.cmp;
  const isWriter = state.user?.role === "writer";
  const d = cmp.data;

  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "邻跨对照"),
    m(
      "p.sub",
      { style: { marginBottom: "0.75rem" } },
      "点名选择基准跨与对照跨及办结时窗：双方各取时窗内办结时刻最近的一条已办结读数，差值由服务端计算并随结果下发，页面不做相减。"
    ),
    m("div.row", [
      spanSelect("baseline_span", "基准跨"),
      spanSelect("comparison_span", "对照跨"),
      m("label", [
        "办结时窗",
        m(
          "select",
          {
            value: cmp.preset,
            onchange: (e) => {
              cmp.preset = e.target.value;
            },
          },
          PRESETS.map((p) => m("option", { value: p.value }, p.label))
        ),
      ]),
      cmp.preset === "custom"
        ? m("label", [
            "起",
            m("input", {
              type: "datetime-local",
              value: cmp.custom_start,
              oninput: (e) => {
                cmp.custom_start = e.target.value;
              },
            }),
          ])
        : null,
      cmp.preset === "custom"
        ? m("label", [
            "止",
            m("input", {
              type: "datetime-local",
              value: cmp.custom_end,
              oninput: (e) => {
                cmp.custom_end = e.target.value;
              },
            }),
          ])
        : null,
      m(
        "button",
        {
          type: "button",
          disabled: cmp.loading,
          onclick: () => previewComparison(),
        },
        cmp.loading ? "对照中…" : "对照"
      ),
    ]),
    cmp.error ? m("p.err", cmp.error) : null,
    cmp.msg ? m("p.ok", cmp.msg) : null,

    d
      ? m("div.result", [
          m("table.cmp-table", [
            m("thead", [
              m("tr", [
                m("th", `基准跨：${d.baseline_span}`),
                m("th.center", "差值（服务端计算）"),
                m("th.right", `对照跨：${d.comparison_span}`),
              ]),
            ]),
            m("tbody", [
              m("tr", [
                sideCell(d.baseline),
                m("td.diff-cell", [
                  d.comparable
                    ? [
                        m(
                          "div.diff",
                          `${d.difference_microstrain > 0 ? "+" : ""}${fmtNum(
                            d.difference_microstrain
                          )} με`
                        ),
                        m("div.muted", "基准跨 − 对照跨"),
                      ]
                    : m("div.no-diff", "不成差"),
                ]),
                sideCell(d.comparison),
              ]),
            ]),
          ]),
          m("p.basis", [
            m("strong", "口径："),
            d.calculation_basis,
          ]),
          d.comparable
            ? m("p.muted", [
                `时窗：${fmtTime(d.window_start)} ～ ${fmtTime(d.window_end)}`,
              ])
            : m("p.err", d.missing_reason),

          isWriter
            ? m(
                "button",
                {
                  type: "button",
                  disabled: cmp.submitting || !d.comparable,
                  onclick: () => submitComparison(),
                },
                cmp.submitting ? "报送中…" : "报送抄档（后台重算差值并盖截止时刻）"
              )
            : m(
                "p.note",
                "复核侧只读：可查看对照结果与抄档台账，不能报送。"
              ),
        ])
      : m(
          "p.muted",
          "选择两条跨段并点“对照”，结果由服务端返回；任一侧时窗内无办结读数时不成差、不留差值。"
        ),
  ]);
}

function archiveView() {
  const cmp = state.cmp;
  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "对照抄档台账"),
    m("table", [
      m("thead", [
        m("tr", [
          m("th", "编号"),
          m("th", "基准跨"),
          m("th", "对照跨"),
          m("th", "基准微应变"),
          m("th", "对照微应变"),
          m("th", "差值(με)"),
          m("th", "时窗起"),
          m("th", "时窗止"),
          m("th", "截止时刻"),
          m("th", "报送人"),
        ]),
      ]),
      m(
        "tbody",
        cmp.archive.length
          ? cmp.archive.map((r) =>
              m("tr", { key: r.id }, [
                m("td", r.id),
                m("td", r.baseline_span),
                m("td", r.comparison_span),
                m("td", `${fmtNum(r.baseline_microstrain)}（#${r.baseline_reading_id}）`),
                m("td", `${fmtNum(r.comparison_microstrain)}（#${r.comparison_reading_id}）`),
                m("td.diff-archive", fmtNum(r.difference_microstrain)),
                m("td", fmtTime(r.window_start)),
                m("td", fmtTime(r.window_end)),
                m("td", fmtTime(r.cutoff_at)),
                m("td", r.created_by),
              ])
            )
          : [m("tr", m("td", { colspan: 10 }, "暂无抄档"))]
      ),
    ]),
  ]);
}

const App = {
  oninit() {
    loadReadings();
    startPolling();
  },
  onremove() {
    stopPolling();
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

    const goPage = (page) => {
      state.page = page;
      if (page === "readings") {
        startPolling();
        loadReadings();
      } else stopPolling();
      if (page === "comparison") {
        loadSpans();
        loadArchive();
      }
    };

    const navTab = (key, label) =>
      m(
        "button.nav" + (state.page === key ? ".active" : ".secondary"),
        { type: "button", onclick: () => goPage(key) },
        label
      );

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div.topright", [
          m("div.navs", [
            navTab("readings", "读数台"),
            navTab("comparison", "邻跨对照"),
          ]),
          m("div.who", [
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
                  stopPolling();
                  m.redraw();
                },
              },
              "退出"
            ),
          ]),
        ]),
      ]),
      state.page === "comparison"
        ? [comparisonView(), archiveView()]
        : [
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
          ],
    ]);
  },
};

export default App;
