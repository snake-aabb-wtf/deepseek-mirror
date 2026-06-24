// admin/app.js — PR-4 改进
// 修复：
//   - [PR-4.1] admin 鉴权改 httpOnly cookie (credentials: 'include')
//              移除 localStorage 存储，防御 XSS
//   - [PR-3.6] setInterval 泄漏：返回 cleanup 函数，render() 调用上一个 cleanup
//   - [PR-3.6] 5s 轮询竞态：generation + inFlight 标志
//   - [PR-3.3] 账号 API 从 :index 改为 :id
//   - 删除 loginRendered 标志（每次 token 变化全量重渲染）
//   - a.state 加白名单防属性注入
//   - 错误消息用 textContent 替代 innerHTML

const STATE = {
  // [PR-4.1] 不再 localStorage 存 token；用 httpOnly cookie
  view: "dashboard",
  cleanup: null,  // 当前页面的 cleanup 函数
};

function authHeader() { return {}; }  // [PR-4.1] 已废：cookie 自动带

async function api(path, opts = {}) {
  // [PR-4.1] credentials: 'include' 带上 httpOnly cookie
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) { STATE.loggedIn = false; render(); throw new Error("未授权"); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function toast(msg, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;  // textContent 防 XSS
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
  if (view !== STATE.view) {
    STATE.view = view;
    render();
  }
});

const ICON = {
  dashboard: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  users: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  login: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y1="12"/></svg>',
  activity: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y1="19"/><line x1="5" y1="12" x2="19" y1="12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y1="18"/><line x1="6" y1="6" x2="18" y1="18"/></svg>',
  logOut: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y1="12"/></svg>',
  reload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
};

function render() {
  // [PR-3.6] 先清理上一页面
  if (STATE.cleanup) {
    try { STATE.cleanup(); } catch { /* ignore */ }
    STATE.cleanup = null;
  }

  const app = document.getElementById("app");
  if (!STATE.loggedIn) {
    app.innerHTML = renderLogin();
    attachLogin();
    return;
  }
  app.innerHTML = renderLayout();

  const main = document.getElementById("page-content");
  switch (STATE.view) {
    case "dashboard": STATE.cleanup = renderDashboard(main); break;
    case "accounts":  STATE.cleanup = renderAccounts(main); break;
    default: STATE.cleanup = renderDashboard(main);
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

async function logout() {
  // [PR-4.1] 调 /admin/api/logout 清除 cookie
  try { await api("/admin/api/logout", { method: "POST" }); } catch { /* ignore */ }
  STATE.loggedIn = false;
  render();
}

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

function setLoginError(msg) {
  const div = document.getElementById("login-error");
  if (!div) return;
  div.textContent = "";  // 清空
  if (msg) {
    const err = document.createElement("div");
    err.className = "login-error";
    err.textContent = msg;
    div.appendChild(err);
  }
}

function attachLogin() {
  const btn = document.getElementById("login-btn");
  const inputUsr = document.getElementById("usr");
  const inputPwd = document.getElementById("pwd");

  async function doLogin() {
    const usr = inputUsr.value.trim();
    const pwd = inputPwd.value.trim();
    if (!usr || !pwd) { setLoginError("请输入账号和密码"); return; }
    btn.disabled = true;
    btn.textContent = "登录中…";
    try {
      await api("/admin/api/login", {
        method: "POST", body: JSON.stringify({ username: usr, password: pwd }),
      });
      // [PR-4.1] cookie 已由服务端 Set-Cookie 写入
      STATE.loggedIn = true;
      render();
    } catch (e) {
      setLoginError(e.message);
      btn.disabled = false;
      btn.innerHTML = `${ICON.login} 登录`;
    }
  }

  btn.onclick = doLogin;
  inputPwd.onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
}

function renderDashboard(el) {
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

  // [PR-3.6] generation 防止旧请求覆盖新数据
  let gen = 0;
  let inFlight = false;
  let stopped = false;

  async function refresh() {
    if (inFlight || stopped) return;
    inFlight = true;
    const myGen = ++gen;
    try {
      const [stats, accts] = await Promise.all([
        api("/admin/api/stats"),
        api("/admin/api/accounts"),
      ]);
      // [PR-3.6] 防止过期请求覆盖
      if (myGen !== gen || stopped) return;
      const $ = (id) => document.getElementById(id);
      if ($("stat-total")) $("stat-total").textContent = stats.total_requests ?? 0;
      if ($("stat-success")) $("stat-success").textContent = stats.success_requests ?? 0;
      if ($("stat-fail")) $("stat-fail").textContent = stats.failed_requests ?? 0;
      const rate = stats.total_requests > 0
        ? ((stats.success_requests / stats.total_requests) * 100).toFixed(1) + "%"
        : "-";
      if ($("stat-rate")) $("stat-rate").textContent = rate;
      if ($("stat-lat")) $("stat-lat").textContent = stats.avg_latency_ms > 0 ? stats.avg_latency_ms + "ms" : "-";
      if ($("stat-uptime")) $("stat-uptime").textContent = fmtUptime(stats.uptime_secs);

      if ($("pool-total")) $("pool-total").textContent = accts.total ?? 0;
      if ($("pool-idle")) $("pool-idle").textContent = accts.idle ?? 0;
      if ($("pool-busy")) $("pool-busy").textContent = accts.busy ?? 0;
      if ($("pool-error")) $("pool-error").textContent = accts.error ?? 0;

      const badgesEl = $("pool-badges");
      if (badgesEl) {
        if (accts.accounts && accts.accounts.length) {
          badgesEl.innerHTML = accts.accounts.map(a =>
            `<span class="badge ${stateWhitelist(a.state)}">${esc(a.email)}</span>`
          ).join("");
        } else {
          badgesEl.innerHTML = '<div class="empty">暂无账号</div>';
        }
      }
    } catch (e) {
      if (!stopped) console.warn('refresh err:', e);
    } finally {
      inFlight = false;
    }
  }

  refresh();
  const iv = setInterval(refresh, 5000);
  // [PR-3.6] 返回 cleanup
  return () => {
    stopped = true;
    clearInterval(iv);
    gen++;  // 取消所有在途请求
  };
}

function renderAccounts(el) {
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
      // [PR-3.3] 用 a.id 而非 index
      wrap.innerHTML = `<table>
        <thead><tr>
          <th>标识</th>
          <th>状态</th>
          <th>错误次数</th>
          <th>最后错误</th>
          <th style="width:100px">操作</th>
        </tr></thead>
        <tbody>${accounts.map(a => `<tr>
          <td><span class="truncate" style="max-width:200px;display:inline-block">${esc(a.email)}</span></td>
          <td><span class="badge ${stateWhitelist(a.state)}">${stateLabel(a.state)}</span></td>
          <td>${a.error_count}</td>
          <td class="text-muted truncate" style="max-width:240px">${esc(a.last_error) || '-'}</td>
          <td>
            ${a.state === 'error'
              ? `<button class="btn btn-sm btn-outline" onclick="reloginAccount(${a.id})">${ICON.reload} 重登</button>`
              : '<span class="text-muted text-sm">-</span>'}
            <button class="btn-icon danger" onclick="removeAccount(${a.id})" title="删除">${ICON.x}</button>
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

  // 简单 cleanup: 无 interval
  return () => {};
}

// [PR-3.3] API 用 id 而非 index
async function reloginAccount(id) {
  try {
    const res = await api(`/admin/api/accounts/${id}/relogin`, { method: "POST" });
    if (res.ok) { toast("重登录成功"); render(); }
    else { toast(`重登录失败: ${res.message}`, "err"); render(); }
  } catch (e) { toast(e.message, "err"); }
}

async function removeAccount(id) {
  if (!confirm("确定删除此账号？")) return;
  try {
    await api(`/admin/api/accounts/${id}`, { method: "DELETE" });
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

// [PR-3] state 白名单：防止 state 注入到 class 属性
const VALID_STATES = { idle: 1, busy: 1, error: 1 };
function stateWhitelist(s) {
  return VALID_STATES[s] ? s : 'idle';
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// [PR-4.1] 启动时探测登录态: 调 /admin/api/stats 一次
// 成功 -> 已登录; 401 -> 未登录
(async function bootstrap() {
  try {
    await api("/admin/api/stats");
    STATE.loggedIn = true;
  } catch {
    STATE.loggedIn = false;
  }
  render();
})();
