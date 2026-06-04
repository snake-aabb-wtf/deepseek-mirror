const STATE = {
  token: localStorage.getItem("admin_token") || null,
  view: "dashboard",
};

function setToken(t) { STATE.token = t; if (t) localStorage.setItem("admin_token", t); else localStorage.removeItem("admin_token"); }
function authHeader() { return STATE.token ? { "Authorization": `Bearer ${STATE.token}` } : {}; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...authHeader(), ...opts.headers },
    ...opts,
  });
  if (res.status === 401) { setToken(null); render(); throw new Error("未授权"); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function toast(msg, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function navigate(view) {
  STATE.view = view;
  window.location.hash = view;
  render();
}

window.addEventListener("hashchange", () => {
  const view = window.location.hash.slice(1) || "dashboard";
  STATE.view = view;
  render();
});

const ICON = {
  dashboard: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  users: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  login: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
  activity: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  settings: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  logOut: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  reload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
};

let loginRendered = false;

function render() {
  const app = document.getElementById("app");
  if (!STATE.token) {
    if (!loginRendered) { app.innerHTML = renderLogin(); attachLogin(); loginRendered = true; }
    return;
  }
  loginRendered = false;
  app.innerHTML = renderLayout();

  const main = document.getElementById("page-content");
  switch (STATE.view) {
    case "dashboard": renderDashboard(main); break;
    case "accounts": renderAccounts(main); break;
    default: renderDashboard(main);
  }

  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.view === STATE.view);
  });
}

function renderLayout() {
  return `<aside class="sidebar">
    <div class="sidebar-header">
      <h1>DeepSeek 镜像站</h1>
      <div class="sub">管理面板</div>
    </div>
    <nav class="sidebar-nav">
      <button class="nav-item${STATE.view === 'dashboard' ? ' active' : ''}" data-view="dashboard" onclick="navigate('dashboard')">
        ${ICON.dashboard} 概览
      </button>
      <button class="nav-item${STATE.view === 'accounts' ? ' active' : ''}" data-view="accounts" onclick="navigate('accounts')">
        ${ICON.users} 账号池
      </button>
    </nav>
    <div class="sidebar-footer">
      <button class="btn-logout" onclick="logout()">${ICON.logOut} 退出</button>
    </div>
  </aside>
  <main class="main" id="page-content"></main>`;
}

function logout() { setToken(null); render(); }

function renderLogin() {
  return `<div class="login-page">
    <div class="login-card">
      <h2>镜像站管理</h2>
      <div class="desc">输入管理员账号密码</div>
      <div id="login-error"></div>
      <label for="usr">账号</label>
      <input type="text" id="usr" placeholder="管理员账号" autofocus>
      <label for="pwd">密码</label>
      <input type="password" id="pwd" placeholder="管理密码">
      <button class="btn btn-primary" id="login-btn">${ICON.login} 登录</button>
    </div>
  </div>`;
}

function attachLogin() {
  const btn = document.getElementById("login-btn");
  const inputUsr = document.getElementById("usr");
  const inputPwd = document.getElementById("pwd");
  const errDiv = document.getElementById("login-error");

  async function doLogin() {
    const usr = inputUsr.value.trim();
    const pwd = inputPwd.value.trim();
    if (!usr || !pwd) { errDiv.innerHTML = '<div class="login-error">请输入账号和密码</div>'; return; }
    btn.disabled = true;
    btn.textContent = "登录中…";
    try {
      const res = await api("/admin/api/login", {
        method: "POST", body: JSON.stringify({ username: usr, password: pwd }),
      });
      setToken(res.token);
      render();
    } catch (e) {
      errDiv.innerHTML = `<div class="login-error">${e.message}</div>`;
      btn.disabled = false;
      btn.innerHTML = `${ICON.login} 登录`;
    }
  }

  btn.onclick = doLogin;
  inputPwd.onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
}

async function renderDashboard(el) {
  el.innerHTML = `<h1 class="page-title">${ICON.activity} 概览</h1>
    <div class="stats-grid" id="stats-grid">
      <div class="stat-card"><div class="label">总请求</div><div class="value accent" id="stat-total">-</div></div>
      <div class="stat-card"><div class="label">成功</div><div class="value green" id="stat-success">-</div></div>
      <div class="stat-card"><div class="label">失败</div><div class="value red" id="stat-fail">-</div></div>
      <div class="stat-card"><div class="label">成功率</div><div class="value accent" id="stat-rate">-</div></div>
      <div class="stat-card"><div class="label">平均延迟</div><div class="value" id="stat-lat">-</div></div>
      <div class="stat-card"><div class="label">运行时长</div><div class="value" id="stat-uptime">-</div></div>
    </div>
    <div class="section">
      <div class="section-header">${ICON.users} 账号池状态</div>
      <div class="section-body">
        <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
          <div class="stat-card"><div class="label">总计</div><div class="value" id="pool-total">-</div></div>
          <div class="stat-card"><div class="label green">空闲</div><div class="value green" id="pool-idle">-</div></div>
          <div class="stat-card"><div class="label yellow">繁忙</div><div class="value yellow" id="pool-busy">-</div></div>
          <div class="stat-card"><div class="label red">错误</div><div class="value red" id="pool-error">-</div></div>
        </div>
        <div id="pool-badges" class="account-badges"></div>
      </div>
    </div>`;

  async function refresh() {
    try {
      const [stats, accts] = await Promise.all([
        api("/admin/api/stats"),
        api("/admin/api/accounts"),
      ]);
      document.getElementById("stat-total").textContent = stats.total_requests ?? 0;
      document.getElementById("stat-success").textContent = stats.success_requests ?? 0;
      document.getElementById("stat-fail").textContent = stats.failed_requests ?? 0;
      const rate = stats.total_requests > 0
        ? ((stats.success_requests / stats.total_requests) * 100).toFixed(1) + "%"
        : "-";
      document.getElementById("stat-rate").textContent = rate;
      document.getElementById("stat-lat").textContent = stats.avg_latency_ms > 0 ? stats.avg_latency_ms + "ms" : "-";
      document.getElementById("stat-uptime").textContent = fmtUptime(stats.uptime_secs);

      document.getElementById("pool-total").textContent = accts.total ?? 0;
      document.getElementById("pool-idle").textContent = accts.idle ?? 0;
      document.getElementById("pool-busy").textContent = accts.busy ?? 0;
      document.getElementById("pool-error").textContent = accts.error ?? 0;

      const badgesEl = document.getElementById("pool-badges");
      if (accts.accounts && accts.accounts.length) {
        badgesEl.innerHTML = accts.accounts.map(a =>
          `<span class="badge ${a.state}">${esc(a.email)}</span>`
        ).join("");
      } else {
        badgesEl.innerHTML = '<div class="empty">暂无账号</div>';
      }
    } catch (e) { /* polling retries */ }
  }

  refresh();
  const iv = setInterval(refresh, 5000);
  el._iv = iv;
}

async function renderAccounts(el) {
  el.innerHTML = `<h1 class="page-title">${ICON.users} 账号池</h1>
    <div class="section">
      <div class="section-header">添加账号</div>
      <div class="section-body">
        <div class="form-row">
          <div class="form-group" style="flex:1;min-width:180px">
            <label>标识</label>
            <input class="input" id="acct-email" placeholder="user@example.com">
          </div>
          <div class="form-group" style="flex:2;min-width:240px">
            <label>Token</label>
            <input class="input code" id="acct-token" placeholder="Bearer token">
          </div>
          <div class="form-group" style="flex:2;min-width:240px">
            <label>Cookies</label>
            <input class="input code" id="acct-cookies" placeholder="cf_clearance=...; session=...">
          </div>
          <button class="btn btn-primary" id="acct-add-btn">${ICON.plus} 添加</button>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-header">
        <span>账号列表</span>
        <button class="btn btn-sm btn-outline" id="acct-refresh-btn" style="margin-left:auto">${ICON.refresh} 刷新</button>
      </div>
      <div class="section-body" id="acct-table-wrap"><div class="loading">加载中…</div></div>
    </div>`;

  const wrap = document.getElementById("acct-table-wrap");

  async function loadList() {
    try {
      const data = await api("/admin/api/accounts");
      const accounts = data.accounts || [];
      if (!accounts.length) {
        wrap.innerHTML = '<div class="empty">暂无账号</div>';
        return;
      }
      wrap.innerHTML = `<table>
        <thead><tr>
          <th>标识</th>
          <th>状态</th>
          <th>错误次数</th>
          <th>最后错误</th>
          <th style="width:100px">操作</th>
        </tr></thead>
        <tbody>${accounts.map((a, i) => `<tr>
          <td><span class="truncate" style="max-width:200px;display:inline-block">${esc(a.email)}</span></td>
          <td><span class="badge ${a.state}">${stateLabel(a.state)}</span></td>
          <td>${a.error_count}</td>
          <td class="text-muted truncate" style="max-width:240px">${esc(a.last_error) || '-'}</td>
          <td>
            ${a.state === 'error'
              ? `<button class="btn btn-sm btn-outline" onclick="reloginAccount(${i})">${ICON.reload} 重登</button>`
              : '<span class="text-muted text-sm">-</span>'}
            <button class="btn-icon danger" onclick="removeAccount(${i})" title="删除">${ICON.x}</button>
          </td>
        </tr>`).join("")}</tbody>
      </table>`;
    } catch (e) {
      wrap.innerHTML = `<div class="loading" style="color:var(--red)">加载失败: ${esc(e.message)}</div>`;
    }
  }

  document.getElementById("acct-add-btn").onclick = async () => {
    const email = document.getElementById("acct-email").value.trim();
    const token = document.getElementById("acct-token").value.trim();
    const cookies = document.getElementById("acct-cookies").value.trim();
    if (!token || !cookies) { toast("Token 和 Cookies 不能为空", "err"); return; }
    try {
      await api("/admin/api/accounts", {
        method: "POST", body: JSON.stringify({ token, cookies, email }),
      });
      toast("账号添加成功");
      document.getElementById("acct-email").value = "";
      document.getElementById("acct-token").value = "";
      document.getElementById("acct-cookies").value = "";
      loadList();
    } catch (e) { toast(e.message, "err"); }
  };

  document.getElementById("acct-refresh-btn").onclick = loadList;
  loadList();
}

async function reloginAccount(index) {
  try {
    const res = await api(`/admin/api/accounts/${index}/relogin`, { method: "POST" });
    if (res.ok) { toast("重登录成功"); render(); }
    else { toast(`重登录失败: ${res.message}`, "err"); render(); }
  } catch (e) { toast(e.message, "err"); }
}

async function removeAccount(index) {
  if (!confirm("确定删除此账号？")) return;
  try {
    await api(`/admin/api/accounts/${index}`, { method: "DELETE" });
    toast("账号已删除");
    render();
  } catch (e) { toast(e.message, "err"); }
}

function fmtUptime(s) {
  if (!s) return "-";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  let r = "";
  if (d > 0) r += d + "天 ";
  if (h > 0) r += h + "时 ";
  r += m + "分";
  return r;
}

function stateLabel(s) {
  return { idle: "空闲", busy: "繁忙", error: "异常" }[s] || s;
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

render();
