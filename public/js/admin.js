/* ============================================================
   Nexora — public/js/admin.js (vanilla JS)
   Painel Admin — mesmo designer do dashboard do usuário.
   APIs usadas:
   - GET /api/me (valida is_admin)
   - GET /api/admin/users | PUT /api/admin/users/:id
     (balance, total_earnings, active_deposit, affiliate_rate, is_admin)
     -> "aprovar usuário" = aprovar depósito dele; "saldo" = editar balance
   - GET|PUT /api/admin/deposits/:id (pending/active/rejected)
   - GET|PUT /api/admin/withdrawals/:id (pending/approved/rejected)
     -> "habilitar saque" = aprovar saque + gateway ativo
   - GET|POST|PUT|DELETE /api/admin/plans, /api/admin/gateways
     -> "config planos" reflete na landing (/api/public/plans) e calculadora
   - GET|PUT /api/admin/settings (site_name, hero_title, cores, etc)
   ============================================================ */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(v) {
    if (!v) return '—';
    try {
      var d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2} /.test(v) ? v.replace(' ', 'T') + 'Z' : v);
      if (isNaN(d.getTime())) return esc(v);
      return esc(d.toLocaleString('pt-BR'));
    } catch (e) { return esc(v); }
  }
  function pill(s) {
    var k = String(s == null ? '' : s).toLowerCase();
    var cls = 'pending';
    if (['approved', 'active', 'paid', 'completed', 'buy'].indexOf(k) >= 0) cls = 'approved';
    else if (['rejected', 'failed', 'cancelled', 'canceled', 'sell'].indexOf(k) >= 0) cls = 'rejected';
    else if (['inactive', 'disabled', 'off'].indexOf(k) >= 0) cls = 'inactive';
    return '<span class="pill ' + cls + '">' + esc(s || '—') + '</span>';
  }

  /* ---------- toasts ---------- */
  function toast(msg, type) {
    var box = $('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, 3200);
  }
  function inlineErr(msg) {
    var el = $('inlineError');
    if (!el) return;
    el.innerHTML = msg ? '<div class="alert error" style="display:block;margin-bottom:16px">' + esc(msg) + '</div>' : '';
  }

  /* ---------- auth ---------- */
  var token = null;
  try { token = localStorage.getItem('nexora_token'); } catch (e) { token = null; }
  if (!token) { window.location.href = './admin-login.html'; return; }

  function headers() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }; }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: headers(),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      try { localStorage.removeItem('nexora_token'); localStorage.removeItem('nexora_user'); } catch (e) {}
      window.location.href = './admin-login.html';
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && (data.error || data.message)) || ('Erro ' + res.status));
    return data;
  }

  function setApiStatus(ok) {
    var b = $('apiStatus');
    if (!b) return;
    b.className = 'status-badge ' + (ok ? 'online' : 'offline');
    b.textContent = ok ? '● API online' : '● API offline';
    var banner = $('offlineBanner');
    if (banner) banner.style.display = ok ? 'none' : 'block';
  }

  /* ---------- state ---------- */
  var S = { me: null, users: [], deposits: [], withdrawals: [], plans: [], gateways: [], settings: {} };

  /* ---------- drawer / tabs (igual dashboard usuário) ---------- */
  var sidebar = $('sidebar'), hamburger = $('hamburger'), backdrop = $('backdrop');
  function closeDrawer() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
  }
  if (hamburger && sidebar) hamburger.addEventListener('click', function () {
    sidebar.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('show', sidebar.classList.contains('open'));
  });
  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeDrawer(); closeModals(); } });

  var TITLES = { overview: 'Visão Geral', users: 'Usuários', deposits: 'Depósitos', withdrawals: 'Saques', plans: 'Planos', gateways: 'Gateways', settings: 'Config Site' };
  function route() {
    var h = (window.location.hash || '#overview').replace('#', '').split('?')[0];
    return TITLES[h] ? h : 'overview';
  }
  function render(r) {
    document.querySelectorAll('.view').forEach(function (s) { s.classList.remove('active'); });
    var sec = $('view-' + r);
    if (sec) sec.classList.add('active');
    document.querySelectorAll('#adminNav a[data-tab]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-tab') === r);
    });
    var t = $('pageTitle');
    if (t) t.textContent = TITLES[r] || 'Visão Geral';
    closeDrawer();
    if (r === 'overview') loadOverview();
    else if (r === 'users') loadUsers();
    else if (r === 'deposits') loadDeposits();
    else if (r === 'withdrawals') loadWithdrawals();
    else if (r === 'plans') loadPlans();
    else if (r === 'gateways') loadGateways();
    else if (r === 'settings') loadSettings();
    if (r !== 'overview') stopLiveLoop();
  }
  window.addEventListener('hashchange', function () { render(route()); });
  document.querySelectorAll('#adminNav a[data-tab]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.hash = '#' + a.getAttribute('data-tab');
      render(route());
    });
  });

  /* ---------- modals ---------- */
  function openModal(id) { var m = $(id); if (m) m.classList.add('open'); if (backdrop) backdrop.classList.add('show'); }
  function closeModals() {
    document.querySelectorAll('.modal-backdrop.open').forEach(function (m) { m.classList.remove('open'); });
    if (sidebar && !sidebar.classList.contains('open') && backdrop) backdrop.classList.remove('show');
    else if (sidebar && sidebar.classList.contains('open')) return;
    else if (backdrop) backdrop.classList.remove('show');
  }
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', closeModals);
  });
  document.querySelectorAll('.modal-backdrop').forEach(function (m) {
    m.addEventListener('click', function (e) { if (e.target === m) closeModals(); });
  });

  /* ---------- boot: valida admin ---------- */
  async function boot() {
    try {
      var me = await api('/api/me');
      var u = me.user || me.data || me;
      var isAdmin = u.is_admin === 1 || u.is_admin === true || u.is_admin === '1' || u.role === 'admin';
      if (!isAdmin) {
        inlineErr('Esta conta não é administradora. Entre com admin em ./admin-login.html');
        toast('Acesso restrito ao administrador.', 'error');
        setTimeout(function () { window.location.href = './admin-login.html'; }, 1500);
        return;
      }
      S.me = u;
      var w = $('adminWelcome'); if (w) w.textContent = u.username || 'Admin';
      var em = $('adminEmail'); if (em) em.textContent = u.email || '';
      setApiStatus(true);
      render(route());
      /* ticker: carregado por ./js/ticker.js (mesmo módulo da landing,
         do login e do painel do usuário) — nada duplicado aqui. */
    } catch (err) {
      setApiStatus(false);
      inlineErr(err.message);
    }
  }

  /* ---------- OVERVIEW ---------- */
  var liveTimer = null, livePrev = {};

  async function loadOverview() {
    try {
      var results = await Promise.allSettled([
        api('/api/admin/users'), api('/api/admin/deposits'),
        api('/api/admin/withdrawals'), api('/api/admin/plans')
      ]);
      S.users = results[0].status === 'fulfilled' ? normArr(results[0].value) : S.users;
      S.deposits = results[1].status === 'fulfilled' ? normArr(results[1].value) : S.deposits;
      S.withdrawals = results[2].status === 'fulfilled' ? normArr(results[2].value) : S.withdrawals;
      S.plans = results[3].status === 'fulfilled' ? normArr(results[3].value) : S.plans;
      setApiStatus(true);
    } catch (e) { setApiStatus(false); }

    paintOverviewCards();
    if ($('r_date') && !$('r_date').value) $('r_date').value = new Date().toISOString().slice(0, 10);
    await loadLive();
    await loadChartData();
    startLiveLoop();
  }

  function paintOverviewCards() {
    var pendD = S.deposits.filter(function (d) { return d.status === 'pending'; });
    var pendW = S.withdrawals.filter(function (w) { return w.status === 'pending'; });
    var sumD = S.deposits.filter(function (d) { return d.status === 'active'; }).reduce(function (a, d) { return a + Number(d.amount || 0); }, 0);
    var cards = $('overviewCards');
    if (cards) cards.innerHTML =
      card('green', 'Usuários', S.users.length, S.users.filter(function (u) { return u.is_admin; }).length + ' admins') +
      card('', 'Depósitos pendentes', pendD.length, money(pendD.reduce(function (a, d) { return a + Number(d.amount || 0); }, 0)) + ' aguardando aprovação') +
      card('', 'Saques pendentes', pendW.length, money(pendW.reduce(function (a, w) { return a + Number(w.amount || 0); }, 0)) + ' p/ habilitar (aprovar)') +
      card('', 'Depósitos aprovados', money(sumD), 'histórico — capital em posição está no painel abaixo');
    var sum = $('overviewSummary');
    if (sum) sum.innerHTML = '<b>Alerta:</b> depósito e saque aqui são <b>saldos internos</b>, não operação de rendimento. ' +
      'Aprovar um depósito não coloca SOL nem USDT em stake em lugar nenhum — apenas credita um número no banco. ' +
      'Para rendimento real, o usuário opera direto no Jito ou na Kamino pela wallet. ' +
      'Comissão de afiliado: <b>5%</b> do <b>1º depósito</b> do indicado (creditado ao aprovar).';
  }

  /* ---------- caixa ao vivo: contador rolando para TODOS os usuários ---------- */
  function stopLiveLoop() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
  function startLiveLoop() { stopLiveLoop(); liveTimer = setInterval(loadLive, 15000); }

  function fmtInt(v) { return (Number(v) || 0).toLocaleString('en-US'); }
  function setSub(id, txt) { var el = $(id); if (el) el.textContent = txt; }

  function setNum(id, to, fmt) {
    var el = $(id);
    if (!el) return;
    to = Number(to) || 0;
    var from = livePrev[id];
    livePrev[id] = to;
    if (from === undefined || from === to) { el.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = 800;
    (function step(t) {
      var p = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
    var cell = el.parentNode;
    if (cell && cell.classList) { cell.classList.remove('bump'); void cell.offsetWidth; cell.classList.add('bump'); }
  }

  async function loadLive() {
    var stamp = $('liveStamp');
    try {
      var d = await api('/api/admin/overview');
      setApiStatus(true);
      paintLive(d);
      if (stamp) { stamp.className = 'live-badge fresh'; stamp.textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-BR'); }
    } catch (e) {
      setApiStatus(false);
      if (stamp) { stamp.className = 'live-badge err'; stamp.textContent = 'falha ao atualizar'; }
    }
  }

  function paintLive(d) {
    setNum('lv-invested', d.invested_active, money);
    setNum('lv-generated', d.generated_paid, money);
    setNum('lv-cash', d.cash_needed, money);
    setNum('lv-balance', d.balance_total, money);
    setNum('lv-daily', d.daily_yield, money);
    setNum('lv-users', d.users_total, function (v) { return fmtInt(v); });
    setSub('lv-invested-sub', fmtInt(d.positions_active) + ' posição(ões) · ' + fmtInt(d.users_active_positions) + ' usuário(s)');
    setSub('lv-generated-sub', 'a vencer: ' + money(d.projected_pending) + ' · já creditado acima');
    setSub('lv-cash-sub', 'saldos ' + money(d.balance_total) + ' + projeção ' + money(d.projected_pending));
    setSub('lv-balance-sub', 'saques pedidos: ' + money(d.pending_withdraw) + ' · já sacado: ' + money(d.total_withdrawn));
    setSub('lv-daily-sub', 'custo diário das posições ativas');
    setSub('lv-users-sub', 'com posição ativa: ' + fmtInt(d.users_active_positions));
  }

  /* ---------- gráficos da Visão Geral ---------- */
  function period() { var s = $('evoDays'); return s ? Number(s.value) || 30 : 30; }

  async function loadChartData() {
    var res = await Promise.allSettled([
      api('/api/admin/evolution?days=' + period()),
      api('/api/admin/results')
    ]);
    if (res[0].status === 'fulfilled') { S.evo = res[0].value; setApiStatus(true); }
    else { S.evo = null; setApiStatus(false); }
    var r = res[1].status === 'fulfilled' ? res[1].value : null;
    S.results = (r && r.items) || [];
    S.metaFactor = (r && Number(r.meta_factor)) || (S.evo && Number(S.evo.meta_factor)) || 1.3;
    S.goal = (S.evo && Number(S.evo.goal)) || 0;

    paintEvolution();
    paintScenario();
    paintResults();
    var g = $('g_goal');
    if (g && document.activeElement !== g) g.value = String(S.metaFactor);
    var gh = $('goalHint');
    if (gh) gh.textContent = 'meta atual: ' + money(S.goal) + ' (= lucro gerado ' + money((S.evo && S.evo.generated_cum && S.evo.generated_cum[S.evo.generated_cum.length - 1]) || 0) + ' × ' + S.metaFactor + ')';
    var gb = $('goalBadge');
    if (gb) gb.textContent = 'meta ' + money(S.goal);
  }

  function paintEvolution() {
    var host = $('evoChart');
    if (!host) return;
    if (!S.evo || !S.evo.dates || !S.evo.dates.length) { host.innerHTML = '<p class="desc">Sem dados de evolução.</p>'; return; }
    drawChart('evoChart', 'evoLegend', S.evo, [
      { key: 'invested_cum', name: 'Capital investido (acum.)', color: '#8b5cf6' },
      { key: 'generated_cum', name: 'Rendimento gerado (acum.)', color: '#10b981' }
    ], 0);
  }

  function paintScenario() {
    var host = $('scenarioChart');
    if (!host) return;
    if (!S.evo || !S.evo.dates || !S.evo.dates.length) { host.innerHTML = '<p class="desc">Sem dados de cenário.</p>'; return; }
    drawChart('scenarioChart', 'scenarioLegend', S.evo, [
      { key: 'generated_cum', name: 'Lucro gerado aos usuários (acum.)', color: '#10b981' },
      { key: 'result_cum', name: 'Resultado aplicado pela empresa (acum.)', color: '#38bdf8' }
    ], S.evo.goal_series || 0);
  }

  function fmtDay(iso) {
    var p = String(iso || '').split('-');
    if (p.length < 3) return String(iso || '');
    return p[2] + '/' + p[1];
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var exp = Math.floor(Math.log10(v)), f = v / Math.pow(10, exp);
    var n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * Math.pow(10, exp);
  }

  // Gráfico de linhas em SVG puro (sem lib, sem build).
  // goal: número (linha fixa) OU array com a meta por dia (linha dinâmica).
  function drawChart(hostId, legendId, data, series, goal) {
    var host = $(hostId);
    if (!host) return;
    var dates = (data && data.dates) || [];
    var lg = $(legendId);
    if (!dates.length) { host.innerHTML = '<p class="desc">Sem dados no período.</p>'; if (lg) lg.innerHTML = ''; return; }

    var goalArr = null, goalNum = 0;
    if (Array.isArray(goal)) goalArr = goal.map(Number);
    else goalNum = Number(goal) || 0;
    var hasGoal = goalArr ? goalArr.some(function (v) { return v > 0; }) : goalNum > 0;

    var W = 900, H = 330, padL = 78, padR = 16, padT = 16, padB = 34;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var vals = [];
    series.forEach(function (s) { (data[s.key] || []).forEach(function (v) { vals.push(Number(v) || 0); }); });
    if (hasGoal) { if (goalArr) goalArr.forEach(function (v) { vals.push(v); }); else vals.push(goalNum); }
    var max = niceMax(Math.max.apply(null, vals.concat([1])));
    var n = dates.length;
    var X = function (i) { return n > 1 ? padL + (plotW * i) / (n - 1) : padL + plotW / 2; };
    var Y = function (v) { return padT + plotH - (Math.max(0, Number(v) || 0) / max) * plotH; };
    var step = Math.max(1, Math.ceil(n / 7));

    var s = ['<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg" preserveAspectRatio="xMidYMid meet" role="img">'];
    for (var i = 0; i <= 4; i++) {
      var v = (max * i) / 4, yy = Y(v);
      s.push('<line class="ch-grid" x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '"/>');
      s.push('<text class="ch-y" x="' + (padL - 8) + '" y="' + (yy + 4).toFixed(1) + '" text-anchor="end">' + esc(moneyShort(v)) + '</text>');
    }
    dates.forEach(function (dt, i) {
      if (i % step === 0 || i === n - 1) s.push('<text class="ch-x" x="' + X(i).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(fmtDay(dt)) + '</text>');
    });
    if (hasGoal && goalArr) {
      var gpts = goalArr.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
      s.push('<polyline class="ch-goal" points="' + gpts + '" fill="none"/>');
      var lastG = goalArr[goalArr.length - 1];
      s.push('<text class="ch-goal-lbl" x="' + (W - padR) + '" y="' + Math.max(12, Y(lastG) - 8).toFixed(1) + '" text-anchor="end">Meta ' + esc(moneyShort(lastG)) + '</text>');
    } else if (hasGoal) {
      var gy = Y(goalNum);
      s.push('<line class="ch-goal" x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '"/>');
      s.push('<text class="ch-goal-lbl" x="' + (W - padR) + '" y="' + (gy - 7).toFixed(1) + '" text-anchor="end">Meta ' + esc(moneyShort(goalNum)) + '</text>');
    }
    series.forEach(function (ser) {
      var arr = data[ser.key] || [];
      var pts = arr.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
      s.push('<polyline points="' + pts + '" fill="none" stroke="' + ser.color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>');
      arr.forEach(function (v, i) {
        if (i % step === 0 || i === n - 1) {
          s.push('<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="3.5" fill="' + ser.color + '">' +
            '<title>' + esc(fmtDay(dates[i])) + ' — ' + esc(ser.name) + ': ' + money(v) + '</title></circle>');
        }
      });
    });
    s.push('</svg>');
    host.innerHTML = s.join('');
    if (lg) {
      lg.innerHTML = series.map(function (ser) {
        return '<span class="lg"><i style="background:' + ser.color + '"></i>' + esc(ser.name) + '</span>';
      }).join('') + (hasGoal ? '<span class="lg"><i class="dash"></i>Meta (lucro × ' + esc(String(S.metaFactor || 1.3)) + ')</span>' : '');
    }
  }

  function paintResults() {
    var tb = $('resultsBody');
    if (!tb) return;
    if (!S.results || !S.results.length) { tb.innerHTML = '<tr><td colspan="5" class="empty-row">Nenhum resultado lançado.</td></tr>'; return; }
    tb.innerHTML = S.results.map(function (r) {
      return '<tr><td class="mono">' + esc(r.result_date) + '</td>' +
        '<td><b>' + money(r.amount) + '</b></td>' +
        '<td>' + esc(r.note || '—') + '</td>' +
        '<td class="muted" style="font-size:12px">' + fmtDate(r.created_at) + '</td>' +
        '<td><div class="row-actions"><button class="btn btn-sm btn-danger" data-del-result="' + Number(r.id) + '">Excluir</button></div></td></tr>';
    }).join('');
    tb.querySelectorAll('[data-del-result]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Excluir este lançamento?')) return;
        try { await api('/api/admin/results/' + b.getAttribute('data-del-result'), { method: 'DELETE' }); toast('Lançamento excluído.', 'success'); await loadChartData(); }
        catch (e) { toast('Erro: ' + e.message, 'error'); }
      });
    });
  }
  function card(cls, lbl, val, sub) {
    return '<div class="card ' + cls + '"><div class="lbl"><div class="ico"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M16 12h5"/></svg></div>' + esc(lbl) + '</div><div class="val">' + val + '</div><div class="sub">' + sub + '</div></div>';
  }
  function normArr(d) { return Array.isArray(d) ? d : (d && (d.data || d.items || d.users || d.deposits || d.withdrawals || d.plans || d.gateways)) || []; }

  /* ---------- USERS: aprovar (via depósito) + editar saldo ---------- */
  async function loadUsers() {
    var tb = $('usersBody');
    try {
      S.users = normArr(await api('/api/admin/users'));
      setApiStatus(true);
    } catch (err) { setApiStatus(false); if (tb) tb.innerHTML = '<tr><td colspan="8" class="loading">Falha: ' + esc(err.message) + '</td></tr>'; return; }
    paintUsers();
  }
  function paintUsers() {
    var tb = $('usersBody');
    if (!tb) return;
    var q = ($('userSearch') && $('userSearch').value || '').toLowerCase();
    var list = S.users.filter(function (u) {
      return !q || String(u.username || '').toLowerCase().indexOf(q) >= 0 || String(u.email || '').toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-row">Nenhum usuário.</td></tr>'; return; }
    tb.innerHTML = list.map(function (u) {
      return '<tr><td class="mono">#' + u.id + '</td>' +
        '<td><b>' + esc(u.username) + '</b><br><span class="muted" style="font-size:12px">' + esc(u.email || '') + '</span></td>' +
        '<td>' + money(u.balance) + '</td><td>' + money(u.total_earnings) + '</td><td>' + money(u.active_deposit) + '</td>' +
        '<td>' + esc(u.affiliate_rate != null ? u.affiliate_rate + '%' : '—') + '</td>' +
        '<td>' + (u.is_admin ? '<span class="pill approved">admin</span>' : '<span class="pill inactive">user</span>') + '</td>' +
        '<td><div class="row-actions"><button class="btn btn-sm" data-edit-user="' + u.id + '">Editar saldo</button><button class="btn btn-sm btn-danger" data-del-user="' + u.id + '" data-username="' + esc(u.username) + '">Excluir</button></div></td></tr>';
    }).join('');
    tb.querySelectorAll('[data-edit-user]').forEach(function (b) {
      b.addEventListener('click', function () { openUserModal(Number(b.getAttribute('data-edit-user'))); });
    });
    tb.querySelectorAll('[data-del-user]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-del-user'));
        var nm = b.getAttribute('data-username') || ('#' + id);
        if (S.me && Number(S.me.id) === id) { toast('Você não pode excluir sua própria conta.', 'error'); return; }
        if (!confirm('Excluir o usuário ' + nm + ' (#' + id + ')? Depósitos, saques e histórico dele serão apagados juntos.')) return;
        b.disabled = true;
        try {
          await api('/api/admin/users/' + id, { method: 'DELETE' });
          toast('Usuário ' + nm + ' excluído.', 'info');
          loadUsers();
        } catch (err) { toast('Erro: ' + err.message, 'error'); b.disabled = false; }
      });
    });
  }
  var us = $('userSearch');
  if (us) us.addEventListener('input', paintUsers);

  function openUserModal(id) {
    var u = S.users.filter(function (x) { return Number(x.id) === Number(id); })[0];
    if (!u) return;
    $('u_id').value = u.id;
    $('userModalTitle').textContent = '#' + u.id + ' ' + (u.username || '');
    $('u_balance').value = u.balance != null ? u.balance : 0;
    $('u_earnings').value = u.total_earnings != null ? u.total_earnings : 0;
    $('u_active_deposit').value = u.active_deposit != null ? u.active_deposit : 0;
    $('u_affiliate').value = u.affiliate_rate != null ? u.affiliate_rate : 10;
    $('u_admin').checked = !!(u.is_admin);
    var hint = $('userModalHint');
    if (hint) hint.textContent = 'Dica: "Aprovar usuário" = aprovar o depósito dele na aba Depósitos. "Habilitar saque" = aprovar o saque na aba Saques. Aqui você ajusta saldo/earnings manualmente.';
    openModal('userModal');
  }
  var uf = $('userForm');
  if (uf) uf.addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('u_id').value;
    var body = {
      balance: Number($('u_balance').value),
      total_earnings: Number($('u_earnings').value),
      active_deposit: Number($('u_active_deposit').value),
      affiliate_rate: Number($('u_affiliate').value),
      is_admin: $('u_admin').checked ? 1 : 0
    };
    try {
      await api('/api/admin/users/' + id, { method: 'PUT', body: body });
      toast('Usuário #' + id + ' atualizado (saldo habilitado).', 'success');
      closeModals(); loadUsers();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  });

  /* ---------- DEPOSITS: aprovar / rejeitar ---------- */
  async function loadDeposits() {
    var tb = $('depositsBody');
    try {
      S.deposits = normArr(await api('/api/admin/deposits'));
      setApiStatus(true);
    } catch (err) { setApiStatus(false); if (tb) tb.innerHTML = '<tr><td colspan="7" class="loading">Falha: ' + esc(err.message) + '</td></tr>'; return; }
    paintDeposits();
  }
  function paintDeposits() {
    var tb = $('depositsBody');
    if (!tb) return;
    var f = ($('depositFilter') && $('depositFilter').value) || '';
    var list = S.deposits.filter(function (d) { return !f || d.status === f; });
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-row">Nenhum depósito.</td></tr>'; return; }
    tb.innerHTML = list.map(function (d) {
      var acts = d.status === 'pending'
        ? '<div class="row-actions"><button class="btn btn-sm btn-success" data-dep="active" data-id="' + d.id + '">Aprovar</button><button class="btn btn-sm btn-danger" data-dep="rejected" data-id="' + d.id + '">Rejeitar</button></div>'
        : '<span class="muted" style="font-size:12px">—</span>';
      return '<tr><td class="mono">#' + d.id + '</td><td><b>' + esc(d.username || d.user || ('user ' + d.user_id)) + '</b><br><span class="muted" style="font-size:12px">' + esc(d.plan_name || 'Saldo (top-up)') + '</span></td>' +
        '<td>' + money(d.amount) + '</td><td>' + esc(d.gateway_symbol || d.gateway_id || '—') + '</td>' +
        '<td>' + pill(d.status) + '</td><td class="muted">' + fmtDate(d.created_at) + '</td><td>' + acts + '</td></tr>';
    }).join('');
    tb.querySelectorAll('[data-dep]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-id'), st = b.getAttribute('data-dep');
        b.disabled = true;
        try {
          await api('/api/admin/deposits/' + id, { method: 'PUT', body: { status: st } });
          toast('Depósito #' + id + ' → ' + st + ' (usuário aprovado/creditado).', st === 'active' ? 'success' : 'info');
          loadDeposits();
        } catch (err) { toast('Erro: ' + err.message, 'error'); b.disabled = false; }
      });
    });
  }
  var df = $('depositFilter');
  if (df) df.addEventListener('change', paintDeposits);

  /* ---------- WITHDRAWALS: habilitar (aprovar) / rejeitar ---------- */
  async function loadWithdrawals() {
    var tb = $('withdrawalsBody');
    try {
      S.withdrawals = normArr(await api('/api/admin/withdrawals'));
      setApiStatus(true);
    } catch (err) { setApiStatus(false); if (tb) tb.innerHTML = '<tr><td colspan="7" class="loading">Falha: ' + esc(err.message) + '</td></tr>'; return; }
    paintWithdrawals();
  }
  function paintWithdrawals() {
    var tb = $('withdrawalsBody');
    if (!tb) return;
    var f = ($('withdrawFilter') && $('withdrawFilter').value) || '';
    var list = S.withdrawals.filter(function (w) { return !f || w.status === f; });
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-row">Nenhum saque.</td></tr>'; return; }
    tb.innerHTML = list.map(function (w) {
      var dest = esc(w.wallet_to || w.wallet || w.address || '—');
      var short = dest.length > 18 ? dest.slice(0, 10) + '…' + dest.slice(-6) : dest;
      var acts = w.status === 'pending'
        ? '<div class="row-actions"><button class="btn btn-sm btn-success" data-wd="approved" data-id="' + w.id + '">Habilitar/Aprovar</button><button class="btn btn-sm btn-danger" data-wd="rejected" data-id="' + w.id + '">Rejeitar</button></div>'
        : '<span class="muted" style="font-size:12px">—</span>';
      return '<tr><td class="mono">#' + w.id + '</td><td><b>' + esc(w.username || ('user ' + w.user_id)) + '</b></td>' +
        '<td>' + money(w.amount) + '</td><td class="mono" title="' + dest + '">' + short + '</td>' +
        '<td>' + pill(w.status) + '</td><td class="muted">' + fmtDate(w.created_at) + '</td><td>' + acts + '</td></tr>';
    }).join('');
    tb.querySelectorAll('[data-wd]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-id'), st = b.getAttribute('data-wd');
        b.disabled = true;
        try {
          await api('/api/admin/withdrawals/' + id, { method: 'PUT', body: { status: st } });
          toast('Saque #' + id + ' → ' + st + '.', st === 'approved' ? 'success' : 'info');
          loadWithdrawals();
        } catch (err) { toast('Erro: ' + err.message, 'error'); b.disabled = false; }
      });
    });
  }
  var wf = $('withdrawFilter');
  if (wf) wf.addEventListener('change', paintWithdrawals);

  /* ---------- PLANS ---------- */
  // CRUD de plano em MODO SIMULAÇÃO. A taxa é configuração, não rentabilidade:
  // o que for salvo aqui vira o número que accrual.js credita todo dia. O que
  // NÃO existe é o pool/contrato que pagaria essa taxa — daí o aviso no modal.
  async function loadPlans() {
    var tb = $('plansBody');
    try {
      S.plans = normArr(await api('/api/admin/plans'));
      setApiStatus(true);
    } catch (err) {
      setApiStatus(false);
      if (tb) tb.innerHTML = '<tr><td colspan="8" class="loading">Falha: ' + esc(err.message) + '</td></tr>';
      return;
    }
    if (!tb) return;
    if (!S.plans.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-row">Nenhum plano.</td></tr>'; return; }
    tb.innerHTML = S.plans.map(function (p) {
      var daily = Number(p.daily_rate || 0) / 100;
      var grossMin = Number(p.min_deposit || 0) * daily * Number(p.duration_days || 0);
      return '<tr><td class="mono">#' + p.id + '</td><td><b>' + esc(p.name) + '</b></td>' +
        '<td style="color:#fbbf24">' + String(p.daily_rate).replace('.', ',') + '%</td>' +
        '<td>' + p.duration_days + 'd</td>' +
        '<td>$' + esc(p.min_deposit) + '</td><td>$' + esc(p.max_deposit) + '</td>' +
        '<td>' + (Number(p.active) ? '<span class="pill approved">ativo</span>' : '<span class="pill inactive">off</span>') + '</td>' +
        '<td><div class="row-actions"><button class="btn btn-sm" data-p-edit="' + p.id + '">Editar</button>' +
        '<button class="btn btn-sm ' + (Number(p.active) ? 'btn-warn' : 'btn-success') + '" data-p-toggle="' + p.id + '">' + (Number(p.active) ? 'Desabilitar' : 'Habilitar') + '</button>' +
        '<button class="btn btn-sm btn-danger" data-p-del="' + p.id + '" title="Lucro estimado no mínimo: $' + grossMin.toFixed(2) + '">Excluir</button></div></td></tr>';
    }).join('');
    tb.querySelectorAll('[data-p-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openPlanModal(Number(b.getAttribute('data-p-edit'))); });
    });
    tb.querySelectorAll('[data-p-toggle]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-p-toggle'));
        var cur = S.plans.filter(function (x) { return Number(x.id) === id; })[0];
        if (!cur) return;
        try {
          await api('/api/admin/plans/' + id, {
            method: 'PUT',
            body: {
              name: cur.name, daily_rate: cur.daily_rate, duration_days: cur.duration_days,
              min_deposit: cur.min_deposit, max_deposit: cur.max_deposit,
              active: Number(cur.active) ? 0 : 1
            }
          });
          toast('Plano #' + id + (Number(cur.active) ? ' desabilitado.' : ' habilitado.'), 'success');
          loadPlans();
        } catch (err) { toast('Erro: ' + err.message, 'error'); }
      });
    });
    tb.querySelectorAll('[data-p-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-p-del'));
        var cur = S.plans.filter(function (x) { return Number(x.id) === id; })[0];
        if (!cur) return;
        if (!confirm('Excluir o plano "' + cur.name + '"?\n\nAs posições já abertas continuam existindo em `positions` com a taxa copiada na época.')) return;
        try {
          await api('/api/admin/plans/' + id, { method: 'DELETE' });
          toast('Plano excluído.', 'success');
          loadPlans();
        } catch (err) { toast('Erro: ' + err.message, 'error'); }
      });
    });
  }
  function openPlanModal(id) {
    var p = id ? S.plans.filter(function (x) { return Number(x.id) === Number(id); })[0] : null;
    $('planModalTitle').textContent = p ? 'Editar plano #' + p.id : 'Novo plano';
    $('p_id').value = p ? p.id : '';
    $('p_name').value = p ? p.name : '';
    $('p_daily_rate').value = p ? p.daily_rate : '';
    $('p_duration_days').value = p ? p.duration_days : '';
    $('p_min_deposit').value = p ? p.min_deposit : '';
    $('p_max_deposit').value = p ? p.max_deposit : '';
    $('p_active').value = p ? (Number(p.active) ? '1' : '0') : '1';
    openModal('planModal');
  }
  var bnP = $('btnNewPlan');
  if (bnP) bnP.addEventListener('click', function () { openPlanModal(null); });
  var pf = $('planForm');
  if (pf) pf.addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('p_id').value;
    var body = {
      name: $('p_name').value.trim(),
      daily_rate: $('p_daily_rate').value,
      duration_days: $('p_duration_days').value,
      min_deposit: $('p_min_deposit').value,
      max_deposit: $('p_max_deposit').value,
      active: Number($('p_active').value) ? 1 : 0
    };
    var sb = $('p_submit');
    if (sb) sb.disabled = true;
    try {
      if (id) await api('/api/admin/plans/' + id, { method: 'PUT', body: body });
      else await api('/api/admin/plans', { method: 'POST', body: body });
      toast('Plano salvo.', 'success');
      closeModals(); loadPlans();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
    finally { if (sb) sb.disabled = false; }
  });

  /* ---------- GATEWAYS ---------- */
  async function loadGateways() {
    var tb = $('gatewaysBody');
    try {
      S.gateways = normArr(await api('/api/admin/gateways'));
      setApiStatus(true);
    } catch (err) { setApiStatus(false); if (tb) tb.innerHTML = '<tr><td colspan="7" class="loading">Falha: ' + esc(err.message) + '</td></tr>'; return; }
    if (!S.gateways.length) { tb.innerHTML = '<tr><td colspan="7" class="empty-row">Nenhum gateway.</td></tr>'; return; }
    tb.innerHTML = S.gateways.map(function (g) {
      var wal = esc(g.wallet_address || '');
      var short = wal.length > 20 ? wal.slice(0, 12) + '…' + wal.slice(-6) : wal;
      return '<tr><td class="mono">#' + g.id + '</td><td><b>' + esc(g.symbol) + '</b></td><td>' + esc(g.name) + '</td><td>' + esc(g.network) + '</td>' +
        '<td class="mono" title="' + wal + '">' + short + '</td>' +
        '<td>' + (Number(g.active) ? '<span class="pill approved">ativo</span>' : '<span class="pill inactive">off</span>') + '</td>' +
        '<td><div class="row-actions"><button class="btn btn-sm" data-gw-edit="' + g.id + '">Editar</button>' +
        '<button class="btn btn-sm ' + (Number(g.active) ? 'btn-warn' : 'btn-success') + '" data-gw-toggle="' + g.id + '">' + (Number(g.active) ? 'Desabilitar' : 'Habilitar') + '</button></div></td></tr>';
    }).join('');
    tb.querySelectorAll('[data-gw-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openGatewayModal(Number(b.getAttribute('data-gw-edit'))); });
    });
    tb.querySelectorAll('[data-gw-toggle]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = Number(b.getAttribute('data-gw-toggle'));
        var cur = S.gateways.filter(function (x) { return Number(x.id) === id; })[0];
        if (!cur) return;
        try {
          await api('/api/admin/gateways/' + id, {
            method: 'PUT',
            body: { symbol: cur.symbol, name: cur.name, network: cur.network, wallet_address: cur.wallet_address, active: Number(cur.active) ? 0 : 1 }
          });
          toast('Gateway #' + id + (Number(cur.active) ? ' desabilitado (saque/depósito bloqueado).' : ' habilitado.'), 'success');
          loadGateways();
        } catch (err) { toast('Erro: ' + err.message, 'error'); }
      });
    });
  }
  function openGatewayModal(id) {
    var g = id ? S.gateways.filter(function (x) { return Number(x.id) === Number(id); })[0] : null;
    $('gatewayModalTitle').textContent = g ? 'Editar gateway #' + g.id : 'Novo gateway';
    $('g_id').value = g ? g.id : '';
    $('g_symbol').value = g ? g.symbol : '';
    $('g_name').value = g ? g.name : '';
    $('g_network').value = g ? g.network : '';
    $('g_wallet').value = g ? g.wallet_address : '';
    $('g_active').checked = g ? !!Number(g.active) : true;
    openModal('gatewayModal');
  }
  var bnG = $('btnNewGateway');
  if (bnG) bnG.addEventListener('click', function () { openGatewayModal(null); });
  var gf = $('gatewayForm');
  if (gf) gf.addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('g_id').value;
    var body = {
      symbol: $('g_symbol').value.trim(), name: $('g_name').value.trim(),
      network: $('g_network').value.trim(), wallet_address: $('g_wallet').value.trim(),
      active: $('g_active').checked ? 1 : 0
    };
    try {
      if (id) await api('/api/admin/gateways/' + id, { method: 'PUT', body: body });
      else await api('/api/admin/gateways', { method: 'POST', body: body });
      toast('Gateway salvo!', 'success');
      closeModals(); loadGateways();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  });

  /* ---------- SETTINGS ---------- */
  var KNOWN = ['site_name', 'support_telegram', 'hero_title', 'primary_color', 'secondary_color', 'total_invested', 'running_days'];
  async function loadSettings() {
    try {
      S.settings = await api('/api/admin/settings');
      setApiStatus(true);
    } catch (err) { setApiStatus(false); toast('Falha settings: ' + err.message, 'error'); return; }
    var map = { site_name: 'f_site_name', support_telegram: 'f_support_telegram', hero_title: 'f_hero_title', primary_color: 'f_primary_color', secondary_color: 'f_secondary_color', total_invested: 'f_total_invested', running_days: 'f_running_days' };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (el && S.settings[k] != null) el.value = S.settings[k];
    });
    if ($('f_primary_color_picker') && S.settings.primary_color) $('f_primary_color_picker').value = normColor(S.settings.primary_color);
    if ($('f_secondary_color_picker') && S.settings.secondary_color) $('f_secondary_color_picker').value = normColor(S.settings.secondary_color);
    applyLiveColors();
    var extra = Object.keys(S.settings).filter(function (k) { return KNOWN.indexOf(k) < 0; });
    var box = $('extraSettings');
    if (box) {
      box.innerHTML = extra.length ? extra.map(function (k) {
        return '<div style="margin-top:10px"><label>' + esc(k) + '</label><input data-extra="' + esc(k) + '" value="' + esc(S.settings[k]) + '"/></div>';
      }).join('') : '<p class="muted" style="font-size:12.5px;margin-top:10px">Nenhuma chave extra.</p>';
    }
  }
  function normColor(v) {
    v = String(v || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#10b981';
  }
  function applyLiveColors() {
    var p = ($('f_primary_color') && $('f_primary_color').value) || '#10b981';
    var s = ($('f_secondary_color') && $('f_secondary_color').value) || '#8b5cf6';
    var r = document.documentElement.style;
    r.setProperty('--primary', p); r.setProperty('--primary-color', p); r.setProperty('--green', p);
    r.setProperty('--secondary', s); r.setProperty('--secondary-color', s); r.setProperty('--violet', s);
    r.setProperty('--grad', 'linear-gradient(135deg,' + p + ',' + s + ')');
  }
  ['f_primary_color', 'f_secondary_color'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', applyLiveColors);
  });
  var pcp = $('f_primary_color_picker'), scp = $('f_secondary_color_picker');
  if (pcp) pcp.addEventListener('input', function () { $('f_primary_color').value = pcp.value; applyLiveColors(); });
  if (scp) scp.addEventListener('input', function () { $('f_secondary_color').value = scp.value; applyLiveColors(); });
  var brc = $('btnResetColors');
  if (brc) brc.addEventListener('click', function () {
    $('f_primary_color').value = '#10b981'; $('f_secondary_color').value = '#8b5cf6';
    pcp.value = '#10b981'; scp.value = '#8b5cf6'; applyLiveColors();
  });
  var sf = $('settingsForm');
  if (sf) sf.addEventListener('submit', async function (e) {
    e.preventDefault();
    var body = {};
    KNOWN.forEach(function (k) {
      var map = { site_name: 'f_site_name', support_telegram: 'f_support_telegram', hero_title: 'f_hero_title', primary_color: 'f_primary_color', secondary_color: 'f_secondary_color', total_invested: 'f_total_invested', running_days: 'f_running_days' };
      var el = $(map[k]);
      if (el) body[k] = el.value;
    });
    document.querySelectorAll('[data-extra]').forEach(function (el) { body[el.getAttribute('data-extra')] = el.value; });
    try {
      S.settings = await api('/api/admin/settings', { method: 'PUT', body: body });
      toast('Configurações salvas! (cores/textos do site atualizados)', 'success');
      applyLiveColors();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  });

  /* ---------- cenário: lançar resultado, meta e período ---------- */
  var evoSel = $('evoDays');
  if (evoSel) evoSel.addEventListener('change', loadChartData);

  var rf = $('resultForm');
  if (rf) rf.addEventListener('submit', async function (e) {
    e.preventDefault();
    var body = {
      result_date: $('r_date').value,
      amount: Number($('r_amount').value),
      note: $('r_note').value
    };
    if (!body.result_date || !(body.amount > 0)) { toast('Informe a data e um valor maior que zero.', 'error'); return; }
    try {
      await api('/api/admin/results', { method: 'POST', body: body });
      toast('Resultado lançado.', 'success');
      $('r_amount').value = ''; $('r_note').value = '';
      await loadChartData();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  });

  var gf = $('goalForm');
  if (gf) gf.addEventListener('submit', async function (e) {
    e.preventDefault();
    var v = Number($('g_goal').value);
    if (isNaN(v) || v <= 0) { toast('Informe o fator da meta (ex.: 1,30 = lucro + 30%).', 'error'); return; }
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { meta_factor: String(v) } });
      toast('Meta salva.', 'success');
      await loadChartData();
    } catch (err) { toast('Erro: ' + err.message, 'error'); }
  });

  /* ---------- logout ---------- */
  var lo = $('btnLogout');
  if (lo) lo.addEventListener('click', function () {
    try { localStorage.removeItem('nexora_token'); localStorage.removeItem('nexora_user'); } catch (e) {}
    window.location.href = './admin-login.html';
  });


  /* ---------- helpers de grafico ---------- */
  function moneyShort(v) {
    v = Number(v) || 0;
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }

  boot();
})();
