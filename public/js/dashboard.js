/* ============================================================
   Nexora — public/js/dashboard.js (vanilla JS, sem dependências)
   - Guard de auth via localStorage `nexora_token`
   - Roteamento hash SPA (#dashboard, #deposit, #withdraw, ...)
   - fetch com Authorization: Bearer <token>, try/catch, null-checks
   ============================================================ */
(function () {
  'use strict';

  /* ---------- helpers ---------- */
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
      var d = new Date(v);
      if (isNaN(d.getTime())) return esc(v);
      return esc(d.toLocaleString('pt-BR'));
    } catch (e) { return esc(v); }
  }
  function statusPill(s) {
    var k = String(s || 'pending').toLowerCase();
    var cls = 'pending';
    if (['approved', 'paid', 'completed', 'active', 'confirmed', 'success', 'buy'].indexOf(k) >= 0) cls = 'buy';
    else if (['rejected', 'failed', 'cancelled', 'canceled', 'sell'].indexOf(k) >= 0) cls = 'sell';
    return '<span class="pill ' + cls + '">' + esc(s || 'pending') + '</span>';
  }

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  /* ---------- auth ---------- */
  var token = null;
  try { token = localStorage.getItem('nexora_token'); } catch (e) { token = null; }
  if (!token) { window.location.href = '/login.html'; return; }

  function authHeaders(extra) {
    var h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  async function api(path, opts) {
    opts = opts || {};
    try {
      var res = await fetch(path, {
        method: opts.method || 'GET',
        headers: authHeaders(),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      if (res.status === 401) {
        try { localStorage.removeItem('nexora_token'); localStorage.removeItem('nexora_user'); } catch (e) {}
        window.location.href = '/login.html';
        return null;
      }
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        var msg = (data && (data.message || data.error)) || ('Erro ' + res.status);
        throw new Error(msg);
      }
      return data;
    } catch (err) {
      throw err;
    }
  }

  function logout() {
    try { localStorage.removeItem('nexora_token'); localStorage.removeItem('nexora_user'); } catch (e) {}
    window.location.href = '/login.html';
  }

  /* ---------- sidebar drawer (mobile) ---------- */
  var sidebar = $('sidebar'), hamburger = $('hamburger'), backdrop = $('backdrop');
  function closeDrawer() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
  }
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', function () {
      sidebar.classList.toggle('open');
      if (backdrop) backdrop.classList.toggle('show', sidebar.classList.contains('open'));
    });
  }
  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  /* ---------- SPA router ---------- */
  var TITLES = {
    dashboard: 'Dashboard', deposit: 'Investir em Plano', wallet: 'Adicionar Saldo', withdraw: 'Sacar',
    history: 'Histórico Transações', deposits: 'Meus Depósitos',
    referrals: 'Menu Referral', security: 'Segurança', settings: 'Config Conta'
  };
  var loaded = {};
  function currentRoute() {
    try {
      var q = new URLSearchParams(window.location.search).get('view');
      var h = (window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
      var r = (h || q || 'dashboard').toLowerCase();
      return TITLES[r] ? r : 'dashboard';
    } catch (e) { return 'dashboard'; }
  }
  function render(route) {
    var views = document.querySelectorAll('.view');
    views.forEach(function (s) { s.classList.remove('active'); });
    var sec = $('view-' + route);
    if (sec) sec.classList.add('active');
    var links = document.querySelectorAll('#mainNav a[data-route]');
    links.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === route);
    });
    var t = $('pageTitle');
    if (t) t.textContent = TITLES[route] || 'Dashboard';
    closeDrawer();
    lazyLoad(route);
  }
  function lazyLoad(route) {
    if (loaded[route]) return;
    loaded[route] = true;
    if (route === 'dashboard') { loadPositions(); loadAccruals(); }
    else if (route === 'history') loadHistory();
    else if (route === 'deposits') loadDeposits();
    else if (route === 'referrals') loadReferrals();
    else if (route === 'deposit') { loadPlans(); loadMe(); }
    else if (route === 'wallet') loadWalletGateways();
    else if (route === 'withdraw') loadGateways();
  }
  window.addEventListener('hashchange', function () { render(currentRoute()); });

  /* ---------- state ---------- */
  var state = { me: null, plans: [], gateways: [], positions: [], available: 0, hasInvestment: null };

  /* O servidor devolve objetos ({ simulated, positions }) e não listas.
     Aceitar as duas formas evita painel vazio quando a API muda. */
  function listFrom(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload[key])) return payload[key];
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  }

  /* ---------- rendimento ao vivo: um contador por plano + total no topo ----------
     O motor de crédito (accrual.js) creditava 1x por dia. Entre um crédito e o
     próximo este módulo interpola a fração do dia corrente para o número subir
     de forma contínua — a sensação de "minerando". Regras:
       1. o valor exibido NUNCA passa do que o servidor realmente vai creditar;
       2. a cada sincronização o número volta exatamente para `positions.accrued`;
       3. encerrado o período, o contador congela no total finalizado. */
  var DAY_MS = 86400000;
  var mine = { rows: [], simulated: false, key: null, models: [] };

  function moneyLive(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) n = 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  }
  function fmtLeft(ms) {
    if (!isFinite(ms) || ms <= 0) return '0s';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function buildModel(p) {
    var startedMs = Date.parse(String(p.started_on || '').slice(0, 10) + 'T00:00:00Z');
    if (!isFinite(startedMs)) startedMs = Date.now();
    var days = Math.max(1, parseInt(p.duration_days, 10) || 1);
    var paid = Math.min(days, Math.max(0, parseInt(p.days_paid, 10) || 0));
    var daily = Number(p.daily_amount);
    if (!isFinite(daily) || daily <= 0) {
      daily = (Number(p.principal) || 0) * ((Number(p.daily_rate) || 0) / 100);
    }
    return {
      id: p.id,
      plan: p.plan_name || 'Plano',
      principal: Number(p.principal) || 0,
      rate: Number(p.daily_rate) || 0,
      days: days,
      paid: paid,
      daily: daily,
      accrued: Number(p.accrued) || 0,
      startedMs: startedMs,
      closed: p.status === 'closed' || paid >= days,
      dayStart: startedMs + paid * DAY_MS,
      dayEnd: startedMs + (paid + 1) * DAY_MS,
      endMs: startedMs + days * DAY_MS,
      el: null
    };
  }
  function liveAccrued(m, now) {
    if (m.closed) return m.accrued;
    var maxCreditable = m.accrued + m.daily * (m.days - m.paid);
    if (now <= m.dayStart) return m.accrued;
    var frac = (now - m.dayStart) / Math.max(1, m.dayEnd - m.dayStart);
    if (frac > 1) frac = 1;
    return Math.min(maxCreditable, m.accrued + m.daily * frac);
  }

  function counterHTML(m) {
    return '<div class="mine-card' + (m.closed ? ' done' : '') + '" data-pid="' + esc(m.id) + '">' +
      '<div class="mine-card-top"><b>' + esc(m.plan) + '</b>' +
        (m.closed ? '<span class="pill buy">Concluído</span>' : '<span class="mine-live-tag">Ativo</span>') +
      '</div>' +
      '<div class="mine-meta">' + money(m.principal) + ' · ' + String(m.rate).replace('.', ',') +
        '% ao dia · ' + m.days + ' dia(s)</div>' +
      '<div class="mine-amount" data-role="amount">' + moneyLive(m.accrued) + '</div>' +
      '<div class="mine-amount-lbl">rendimento acumulado' + (m.closed ? ' (creditado)' : ' (ao vivo)') + '</div>' +
      '<div class="mine-bar"><i data-role="bar" style="width:0%"></i></div>' +
      '<div class="mine-foot"><span data-role="days">' + m.paid + '/' + m.days + ' dias</span>' +
        '<span data-role="eta"></span></div>' +
    '</div>';
  }

  function paintMine() {
    var panel = $('minePanel'), grid = $('mineGrid');
    if (!panel || !grid) return;
    panel.style.display = '';
    var sub = $('mineSub');
    if (sub) sub.textContent = mine.simulated
      ? 'Modo simulação — taxa de configuração, crédito só no banco local'
      : 'Crédito diário automático por plano · atualiza sozinho';

    // Ativos primeiro; concluídos (encerrados no período) ficam visíveis ao final.
    var rows = mine.rows.slice().sort(function (a, b) {
      var ac = a.status === 'closed' ? 1 : 0, bc = b.status === 'closed' ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return Number(b.id) - Number(a.id);
    });

    if (!rows.length) {
      mine.key = 'empty';
      mine.models = [];
      grid.innerHTML = '<div class="mine-empty">Nenhum plano ativo ainda. ' +
        '<a href="#deposit">Investir em um plano →</a></div>';
      var t = $('mineTotal'); if (t) t.textContent = '$0.000000';
      var sp = $('mineSplit'); if (sp) sp.textContent = '—';
      var nt = $('mineNote'); if (nt) nt.textContent = '';
      return;
    }

    var key = rows.map(function (p) { return p.id + ':' + p.status; }).join('|');
    if (key !== mine.key) {
      mine.key = key;
      mine.models = rows.map(buildModel);
      grid.innerHTML = mine.models.map(counterHTML).join('');
    } else {
      // Mesma lista: só re-le o que o servidor gravou (novo crédito, encerramento).
      mine.models = rows.map(buildModel);
    }
    mine.models.forEach(function (m) {
      m.el = grid.querySelector('.mine-card[data-pid="' + m.id + '"]');
    });

    var note = $('mineNote');
    if (note) {
      note.textContent = 'Contador ao vivo: cresce entre um crédito e o próximo e volta ao ' +
        'valor exato do banco a cada sincronização (20s). Ao fim do período o contador congela ' +
        'no total creditado e o saldo já fica atualizado no cartão acima.';
    }
    tickMine();
  }
  function tickMine() {
    if (!mine.models.length) {
      var t0 = $('mineTotal');
      if (t0) t0.textContent = '$0.000000';
      return;
    }
    var now = Date.now();
    var capital = 0, earnings = 0;
    mine.models.forEach(function (m) {
      var amt = liveAccrued(m, now);
      capital += m.principal;
      earnings += amt;
      var el = m.el || document.querySelector('.mine-card[data-pid="' + m.id + '"]');
      if (!el) return;
      m.el = el;
      var a = el.querySelector('[data-role="amount"]');
      if (a) a.textContent = moneyLive(amt);
      var frac = 1;
      if (!m.closed) {
        frac = (now - m.dayStart) / Math.max(1, m.dayEnd - m.dayStart);
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
      }
      var pct = ((m.paid + frac) / m.days) * 100;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      var bar = el.querySelector('[data-role="bar"]');
      if (bar) bar.style.width = pct.toFixed(3) + '%';
      var d = el.querySelector('[data-role="days"]');
      if (d) d.textContent = m.paid + '/' + m.days + ' dias creditados';
      var eta = el.querySelector('[data-role="eta"]');
      if (eta) {
        eta.textContent = m.closed
          ? 'período encerrado'
          : 'próximo crédito ' + fmtLeft(m.dayEnd - now) + ' · fim ' + fmtLeft(m.endMs - now);
      }
    });
    var t = $('mineTotal');
    if (t) t.textContent = moneyLive(capital + earnings);
    var sp = $('mineSplit');
    if (sp) sp.textContent = 'capital ' + money(capital) + ' · rendimento +' + moneyLive(earnings);
  }

  async function loadPositions() {
    var grid = $('mineGrid');
    try {
      var data = await api('/api/my/positions');
      var rows = listFrom(data, 'positions');
      mine.rows = rows;
      mine.simulated = !!(data && data.simulated);
      state.positions = rows;
      if (rows.length) state.hasInvestment = true;
      if (state.me) paintBalances();
      paintMine();
    } catch (err) {
      if (grid && !mine.models.length) {
        grid.innerHTML = '<div class="mine-empty">Falha ao carregar os contadores.</div>';
      }
    }
  }

  async function loadAccruals() {
    var box = $('accrualList');
    if (!box) return;
    try {
      var data = await api('/api/my/accruals');
      var rows = listFrom(data, 'accruals');
      if (!rows.length) { box.innerHTML = '<p class="desc">Nenhum crédito diário ainda.</p>'; return; }
      box.innerHTML = '<table class="table"><thead><tr><th>Data</th><th>Plano</th>' +
        '<th>Crédito</th><th>Rendimento acumulado</th></tr></thead><tbody>' +
        rows.map(function (a) {
          var dateStr = a.accrual_date ? new Date(a.accrual_date + 'T00:00:00').toLocaleDateString('pt-BR') : '—';
          var acc = (a.earned_until !== undefined && a.earned_until !== null) ? a.earned_until : a.balance_after;
          return '<tr><td>' + esc(dateStr) + '</td><td>' + esc(a.plan_name || '—') + '</td>' +
            '<td style="color:var(--green,#10b981)">+' + money(a.amount) + '</td>' +
            '<td>' + money(acc) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (err) {
      box.innerHTML = '<p class="desc">Falha ao carregar créditos.</p>';
    }
  }

  function pick(obj, keys, fb) {
    if (!obj) return fb;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return fb;
  }

  /* ---------- /api/me ---------- */
  async function loadMe() {
    try {
      var data = await api('/api/me');
      if (!data) return;
      var u = data.user || data.data || data;
      state.me = u;
      var username = pick(u, ['username', 'name', 'login'], 'User');
      var email = pick(u, ['email'], '');
      var code = pick(u, ['referral_code', 'ref_code', 'refCode', 'ref'], '');
      var wN = $('welcomeName'); if (wN) wN.textContent = username;
      var chip = $('userChip'); if (chip) chip.innerHTML = '<b>' + esc(username) + '</b>' + (email ? ' · ' + esc(email) : '');
      $('cardAvailable').textContent = money(pick(u, ['available_balance', 'balance', 'availableBalance', 'available'], 0));
      $('cardEarnings').textContent = money(pick(u, ['total_earnings', 'earnings', 'profit', 'totalEarnings'], 0));
      $('cardActiveDeposit').textContent = money(pick(u, ['active_deposit', 'activeDeposit', 'invested'], 0));
      $('cardWithdrawn').textContent = money(pick(u, ['total_withdrawn', 'withdrawn', 'totalWithdrawn'], 0));
      var pw = $('cardPendingWithdraw');
      if (pw) pw.textContent = money(pick(u, ['pending_withdraw', 'pendingWithdraw', 'pending'], 0));

      var bal = Number(pick(u, ['available_balance', 'balance', 'availableBalance', 'available'], 0)) || 0;
      var pend = Number(pick(u, ['pending_withdraw', 'pendingWithdraw', 'pending'], 0)) || 0;
      var avail = Math.max(0, bal - pend);
      state.available = avail;

      // Regra: só saca quem já investiu em algum plano (tem posição no banco).
      var hi = u.has_investment;
      if (hi === undefined || hi === null) state.hasInvestment = state.positions.length > 0;
      else state.hasInvestment = hi === true || hi === 1 || hi === '1';
      paintBalances();
      if (code) {
        var link = 'https://site/?ref=' + code;
        var r1 = $('refLink'); if (r1) r1.value = link;
        var r2 = $('refLink2'); if (r2) r2.value = link;
        var rc = $('refCode'); if (rc) rc.textContent = code;
      }
      var su = $('setUsername'); if (su) su.value = username;
      var se = $('setEmail'); if (se && !se.value) se.value = email;
      try { localStorage.setItem('nexora_user', JSON.stringify({ username: username, email: email, referral_code: code })); } catch (e) {}
    } catch (err) {
      toast('Falha ao carregar perfil: ' + err.message, 'error');
    }
  }

  /* Saldos nas telas "Investir em Plano" e "Sacar" + regra do produto:
     só é possível sacar depois de ter investido em algum plano (o servidor
     rejeita com 403; aqui a tela só avisa antes). */
  function paintBalances() {
    var avail = Number(state.available) || 0;
    var has = state.hasInvestment;
    var ok = has === true;

    var ia = $('invAvailable');
    if (ia) ia.textContent = money(avail);
    var iw = $('invWithdrawable');
    if (iw) iw.textContent = money(avail);
    var iws = $('invWithdrawSub');
    if (iws) iws.textContent = ok
      ? 'liberado — você já investiu em um plano'
      : 'liberado após investir em um plano';

    var wa = $('wdAvailable');
    if (wa) wa.textContent = money(avail);
    var wr = $('wdRule');
    if (wr) {
      wr.textContent = has === null ? 'verificando…' : (ok ? 'Liberado' : 'Bloqueado');
      wr.className = has === null ? '' : (ok ? 'ok' : 'no');
    }
    var wrs = $('wdRuleSub');
    if (wrs) wrs.textContent = has === null ? 'aguardando dados da conta'
      : (ok ? 'plano investido' : 'nenhum plano investido ainda');
    var wrn = $('wdRuleNote');
    if (wrn) wrn.textContent = ok
      ? 'Saque liberado: você já investiu em um plano. Máximo disponível: ' + money(avail) + '.'
      : 'Saque bloqueado até você investir em um plano — a regra também é validada no servidor.';

    var btn = $('wdSubmit');
    if (btn) btn.disabled = (has === false);
  }


  /* ---------- lists ---------- */
  function rowDeposit(d) {
    var plan = esc(pick(d, ['plan_name', 'plan', 'planName'], 'Saldo'));
    var gw = esc(pick(d, ['gateway', 'gateway_name', 'gateway_symbol', 'method'], '—'));
    return '<tr><td><b>' + plan + '</b></td><td>' + money(pick(d, ['amount', 'value'], 0)) + '</td><td>' + gw + '</td>' +
      '<td>' + statusPill(pick(d, ['status'], 'pending')) + '</td><td class="muted">' + fmtDate(pick(d, ['created_at', 'createdAt', 'date'], '')) + '</td></tr>';
  }
  function rowTx(t) {
    var type = String(pick(t, ['type', 'kind'], 'deposit')).toLowerCase();
    var label = type.indexOf('with') >= 0 ? '<span class="pill sell">Saque</span>'
      : type.indexOf('invest') >= 0 ? '<span class="pill buy">Investimento</span>'
      : '<span class="pill buy">Depósito</span>';
    return '<tr><td>' + label + '</td><td>' + money(pick(t, ['amount', 'value'], 0)) + '</td>' +
      '<td>' + statusPill(pick(t, ['status'], 'pending')) + '</td><td class="muted">' + fmtDate(pick(t, ['created_at', 'createdAt', 'date'], '')) + '</td></tr>';
  }

  async function loadRecent() {
    var rd = $('recentDeposits'), rw = $('recentWithdrawals');
    try {
      var dep = await api('/api/my/deposits');
      var arr = Array.isArray(dep) ? dep : (dep && (dep.data || dep.deposits || dep.items)) || [];
      if (rd) rd.innerHTML = arr.length
        ? arr.slice(0, 5).map(function (d) {
            return '<tr><td><b>' + esc(pick(d, ['plan_name', 'plan', 'planName'], 'Saldo')) + '</b></td><td>' + money(pick(d, ['amount', 'value'], 0)) + '</td><td>' + statusPill(pick(d, ['status'], 'pending')) + '</td></tr>';
          }).join('')
        : '<tr class="empty-row"><td colspan="3">Nenhum depósito ainda.</td></tr>';
      try {
        var w = await api('/api/my/withdrawals');
        var warr = Array.isArray(w) ? w : (w && (w.data || w.withdrawals || w.items)) || [];
        if (rw) rw.innerHTML = warr.length
          ? warr.slice(0, 5).map(function (x) {
              var wallet = esc(pick(x, ['wallet_to', 'wallet', 'address'], '—'));
              var short = wallet.length > 14 ? wallet.slice(0, 8) + '…' + wallet.slice(-4) : wallet;
              return '<tr><td>' + money(pick(x, ['amount', 'value'], 0)) + '</td><td class="mono">' + short + '</td><td>' + statusPill(pick(x, ['status'], 'pending')) + '</td></tr>';
            }).join('')
          : '<tr class="empty-row"><td colspan="3">Nenhum saque ainda.</td></tr>';
      } catch (e2) {
        /* fallback: deriva saques do histórico */
        try {
          var h = await api('/api/my/transactions');
          var hall = Array.isArray(h) ? h : (h && (h.data || h.transactions || h.items)) || [];
          var onlyW = hall.filter(function (t) { return String(pick(t, ['type', 'kind'], '')).toLowerCase().indexOf('with') >= 0; });
          if (rw) rw.innerHTML = onlyW.length
            ? onlyW.slice(0, 5).map(function (x) {
                return '<tr><td>' + money(pick(x, ['amount', 'value'], 0)) + '</td><td class="muted">—</td><td>' + statusPill(pick(x, ['status'], 'pending')) + '</td></tr>';
              }).join('')
            : '<tr class="empty-row"><td colspan="3">Nenhum saque ainda.</td></tr>';
        } catch (e3) { if (rw) rw.innerHTML = '<tr class="empty-row"><td colspan="3">Indisponível.</td></tr>'; }
      }
    } catch (err) {
      if (rd) rd.innerHTML = '<tr class="empty-row"><td colspan="3">Falha ao carregar.</td></tr>';
      if (rw) rw.innerHTML = '<tr class="empty-row"><td colspan="3">Falha ao carregar.</td></tr>';
    }
  }

  async function loadHistory() {
    var tb = $('historyBody');
    try {
      var data = await api('/api/my/transactions');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.transactions || data.items)) || [];
      if (tb) tb.innerHTML = arr.length ? arr.map(rowTx).join('') : '<tr class="empty-row"><td colspan="4">Nenhuma transação.</td></tr>';
    } catch (err) { if (tb) tb.innerHTML = '<tr class="empty-row"><td colspan="4">Falha ao carregar.</td></tr>'; }
  }
  async function loadDeposits() {
    var tb = $('depositsBody');
    try {
      var data = await api('/api/my/deposits');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.deposits || data.items)) || [];
      if (tb) tb.innerHTML = arr.length ? arr.map(rowDeposit).join('') : '<tr class="empty-row"><td colspan="5">Nenhum depósito.</td></tr>';
    } catch (err) { if (tb) tb.innerHTML = '<tr class="empty-row"><td colspan="5">Falha ao carregar.</td></tr>'; }
  }
  async function loadReferrals() {
    var tb = $('referralsBody');
    try {
      var data = await api('/api/my/referrals');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.referrals || data.items)) || [];
      // Sem coluna de bônus: a comissão foi removida do produto. Mostrar "$0,00
      // ganho" para cada indicado seria sugerir que ainda existe um pagamento.
      if (tb) tb.innerHTML = arr.length
        ? arr.map(function (r) {
            return '<tr><td><b>' + esc(pick(r, ['username', 'name', 'email', 'user'], '—')) + '</b></td><td class="muted">' + fmtDate(pick(r, ['created_at', 'createdAt', 'date'], '')) + '</td></tr>';
          }).join('')
        : '<tr class="empty-row"><td colspan="2">Nenhuma conta usou seu link ainda.</td></tr>';
    } catch (err) { if (tb) tb.innerHTML = '<tr class="empty-row"><td colspan="2">Falha ao carregar.</td></tr>'; }
  }

  /* ---------- planos & gateways ---------- */
  // Planos vêm do servidor com a taxa de configuração. A tela diz, no
  // mínimo e no máximo de cada plano, o mesmo número que o servidor usa —
  // fora da faixa, o servidor rejeita o investimento (POST /api/my/invest).
  function paintPlanHint() {
    var sel = $('depPlan'), panel = $('depPlanHint');
    if (!sel || !panel) return;
    var cur = state.plans.filter(function (p) { return String(p.id) === String(sel.value); })[0];
    if (!cur) { panel.innerHTML = '<p class="desc">Sem planos ativos.</p>'; return; }
    var daily = (Number(cur.daily_rate) / 100);
    panel.innerHTML =
      '<div class="calc-result"><span>Taxa (configurada)</span><b>' +
        String(cur.daily_rate).replace('.', ',') + '% ao dia</b></div>' +
      '<div class="calc-result"><span>Faixa aceita</span><b>' + money(cur.min_deposit) + ' — ' +
        money(cur.max_deposit) + '</b></div>' +
      '<div class="calc-result"><span>Duração</span><b>' + cur.duration_days + ' dia(s)</b></div>' +
      '<div class="calc-result"><span>Lucro no valor mínimo</span><b>' +
        money(Number(cur.min_deposit) * daily * Number(cur.duration_days)) + '</b></div>' +
      (cur.simulated === false ? '' :
        '<p class="hero-note" style="color:#f59e0b">Simulação — taxa de configuração, sem lastro.</p>');
  }
  async function loadPlans() {
    var sel = $('depPlan');
    try {
      var data = await api('/api/public/plans');
      state.plans = Array.isArray(data) ? data : [];
      if (sel) {
        sel.innerHTML = state.plans.length
          ? state.plans.map(function (p) {
              return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
            }).join('')
          : '<option value="">Nenhum plano ativo</option>';
      }
      paintPlanHint();
    } catch (err) {
      state.plans = [];
      if (sel) sel.innerHTML = '<option value="">Falha ao carregar planos</option>';
      var panel = $('depPlanHint');
      if (panel) panel.innerHTML = '<p class="desc">Não foi possível carregar os planos.</p>';
    }
    await loadGateways();
    await loadPositions();
    await loadAccruals();
  }
  async function loadGateways() {
    var s1 = $('depGateway'), s2 = $('wdGateway');
    try {
      var data = await api('/api/public/gateways');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.gateways || data.items)) || [];
      state.gateways = arr;
      var html = arr.length
        ? arr.map(function (g) {
            var id = g.id ?? g._id ?? g.code ?? g.name;
            return '<option value="' + esc(id) + '">' + esc(g.name || g.label || id) + '</option>';
          }).join('')
        : '<option value="">Nenhum gateway disponível</option>';
      if (s1) s1.innerHTML = html;
      if (s2) s2.innerHTML = html;
      paintGatewayInfo();
    } catch (err) {
      if (s1) s1.innerHTML = '<option value="">Falha ao carregar</option>';
      if (s2) s2.innerHTML = '<option value="">Falha ao carregar</option>';
    }
  }
  function paintGatewayInfo() {
    var sel = $('depGateway'), box = $('gatewayInfo');
    if (!sel || !box) return;
    var g = state.gateways.filter(function (x) { return String(x.id ?? x._id ?? x.code ?? x.name) === String(sel.value); })[0];
    if (g && (g.address || g.wallet || g.instructions)) {
      box.hidden = false;
      box.innerHTML = 'Send to: <b>' + esc(g.address || g.wallet || '') + '</b>' + (g.instructions ? '<br>' + esc(g.instructions) : '');
    } else { box.hidden = true; box.innerHTML = ''; }
  }

  /* ---------- carteira: redes + conexão ---------- */
  function walletHint(net) {
    var n = String(net || '').toUpperCase();
    if (n.indexOf('SOL') >= 0 || n.indexOf('SPL') >= 0) return 'Use a Phantom (Solana) para enviar nesta rede.';
    if (n.indexOf('BEP20') >= 0 || n.indexOf('ERC20') >= 0 || n.indexOf('ETH') >= 0 || n.indexOf('BNB') >= 0 || n.indexOf('POLYGON') >= 0 || n.indexOf('ARBITRUM') >= 0 || n.indexOf('EVM') >= 0) return 'Use MetaMask ou Coinbase Wallet para enviar nesta rede.';
    if (n.indexOf('TRC20') >= 0 || n.indexOf('TRX') >= 0) return 'Use TronLink ou o app da sua corretora (rede Tron).';
    return 'Envie pelo app oficial da moeda, sempre na rede indicada acima.';
  }
  var WALLET_INSTALL = {
    metamask: { name: 'MetaMask', url: 'https://metamask.io/download/' },
    phantom: { name: 'Phantom', url: 'https://phantom.app/download' },
    coinbase: { name: 'Coinbase Wallet', url: 'https://www.coinbase.com/wallet/downloads' }
  };
  var walletRetryKey = null;
  function walletKind(net) {
    var n = String(net || '').toUpperCase();
    if (n.indexOf('SOL') >= 0 || n.indexOf('SPL') >= 0) return 'sol';
    if (n.indexOf('BEP20') >= 0 || n.indexOf('ERC20') >= 0 || n.indexOf('ETH') >= 0 || n.indexOf('BNB') >= 0 || n.indexOf('POLYGON') >= 0 || n.indexOf('ARBITRUM') >= 0 || n.indexOf('EVM') >= 0) return 'evm';
    return 'other';
  }
  function selectedGateway() {
    var sel = $('topGateway');
    if (!sel || !sel.value) return null;
    var g = state.gateways.filter(function (x) { return String(x.id ?? x._id ?? x.code ?? x.name) === String(sel.value); })[0];
    return g || null;
  }
  function paintWalletRecommend() {
    var rec = $('walletRecommend');
    var g = selectedGateway();
    var bm = $('btnMetaMask'), bp = $('btnPhantom'), bc = $('btnCoinbase');
    [bm, bp, bc].forEach(function (b) { if (b) b.classList.remove('recommended'); });
    document.querySelectorAll('.wallet-btn .rec-tag').forEach(function (t) { t.hidden = true; });
    if (!g) { if (rec) rec.textContent = 'Selecione um ativo acima para ver a carteira recomendada.'; return; }
    var kind = walletKind(g.network);
    var label = esc(g.symbol || '') + ' na rede ' + esc(g.network || '');
    function mark(btn) { if (!btn) return; btn.classList.add('recommended'); var t = btn.querySelector('.rec-tag'); if (t) t.hidden = false; }
    if (kind === 'evm') {
      mark(bm); mark(bc);
      if (rec) rec.innerHTML = 'Para <b>' + label + '</b>, use <b>MetaMask</b> ou <b>Coinbase Wallet</b> (destacadas). Clique para conectar.';
    } else if (kind === 'sol') {
      mark(bp);
      if (rec) rec.innerHTML = 'Para <b>' + label + '</b>, use <b>Phantom</b> (destacada). Clique para conectar.';
    } else {
      if (rec) rec.innerHTML = 'Para <b>' + label + '</b>, envie pelo app oficial da moeda (ou corretora) e cole o hash no passo 3.';
    }
  }
  function showWalletInstall(key) {
    var w = WALLET_INSTALL[key];
    if (!w) return;
    walletRetryKey = key;
    var g = selectedGateway();
    var asset = g ? (' para operar ' + (g.symbol || '') + ' na rede ' + (g.network || '')) : '';
    var box = $('walletInstallBox');
    var title = $('walletInstallTitle');
    var steps = $('walletInstallSteps');
    var link = $('walletInstallLink');
    if (title) title.textContent = w.name + ' não encontrada — instale para continuar';
    if (steps) steps.innerHTML =
      '<li>Clique em <b>Instalar agora</b> e instale a extensão ' + esc(w.name) + ' no seu navegador.</li>' +
      '<li>Crie ou importe sua carteira' + esc(asset) + ' e volte a esta página.</li>' +
      '<li>Clique em <b>Já instalei, tentar de novo</b> e conecte.</li>';
    if (link) link.href = w.url;
    if (box) { box.hidden = false; try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {} }
  }
  function hideWalletInstall() { var box = $('walletInstallBox'); if (box) box.hidden = true; }
  async function loadWalletGateways() {
    var sel = $('topGateway');
    try {
      var data = await api('/api/public/gateways');
      var arr = Array.isArray(data) ? data : (data && (data.data || data.gateways || data.items)) || [];
      state.gateways = arr;
      if (sel) sel.innerHTML = arr.length
        ? arr.map(function (g) {
            var id = g.id ?? g._id ?? g.code ?? g.name;
            return '<option value="' + esc(id) + '">' + esc(g.symbol || g.name || id) + ' — ' + esc(g.network || '') + '</option>';
          }).join('')
        : '<option value="">Nenhuma rede disponível</option>';
      paintTopGateway();
    } catch (err) { if (sel) sel.innerHTML = '<option value="">Falha ao carregar redes</option>'; }
  }
  function paintTopGateway() {
    var sel = $('topGateway'), box = $('topGatewayInfo');
    if (!sel || !box) return;
    var g = state.gateways.filter(function (x) { return String(x.id ?? x._id ?? x.code ?? x.name) === String(sel.value); })[0];
    if (!g) { box.hidden = true; box.innerHTML = ''; return; }
    var addr = g.wallet_address || g.address || g.wallet || '';
    box.hidden = false;
    box.innerHTML = 'Rede: <b>' + esc(g.network || '—') + ' (' + esc(g.symbol || g.name || '') + ')</b>' +
      '<br>Endereço da plataforma: <b class="mono">' + esc(addr) + '</b>' +
      '<br><span class="form-hint">' + esc(walletHint(g.network)) + '</span>';
    var hid = $('topAddrValue');
    if (hid) hid.value = addr;
    paintWalletRecommend();
  }

  function getWallet() {
    try { return JSON.parse(localStorage.getItem('nexora_wallet') || 'null'); }
    catch (e) { return null; }
  }
  function saveWallet(type, address) {
    try { localStorage.setItem('nexora_wallet', JSON.stringify({ type: type, address: address })); } catch (e) {}
    paintWallet();
  }
  function paintWallet() {
    var st = $('walletStatus'), dc = $('walletDisconnect');
    var w = getWallet();
    if (st) st.innerHTML = w
      ? ('Carteira conectada: <b>' + esc(w.type) + '</b> · <span class="mono">' + esc(w.address) + '</span>')
      : 'Nenhuma carteira conectada.';
    if (dc) dc.style.display = w ? '' : 'none';
  }
  async function connectEVM(provider, type) {
    if (!provider || !provider.request) { toast('Carteira ' + type + ' não encontrada neste navegador.', 'error'); return; }
    try {
      var accs = await provider.request({ method: 'eth_requestAccounts' });
      if (!accs || !accs.length) throw new Error('nenhuma conta autorizada');
      saveWallet(type, accs[0]);
      toast(type + ' conectada!', 'success');
    } catch (err) { toast('Falha ao conectar: ' + (err && err.message ? err.message : err), 'error'); }
  }
  function connectWalletByKey(key) {
    hideWalletInstall();
    if (key === 'metamask') {
      if (!window.ethereum) { showWalletInstall('metamask'); return; }
      connectEVM(window.ethereum, 'MetaMask');
    } else if (key === 'phantom') {
      (async function () {
        var sol = window.solana;
        if (!sol || !sol.isPhantom) { showWalletInstall('phantom'); return; }
        try {
          var r = await sol.connect();
          saveWallet('Phantom', String(r.publicKey));
          toast('Phantom conectada!', 'success');
        } catch (err) { toast('Falha ao conectar: ' + (err && err.message ? err.message : err), 'error'); }
      })();
    } else if (key === 'coinbase') {
      var cp = window.coinbaseWalletExtension || window.ethereum;
      if (!cp) { showWalletInstall('coinbase'); return; }
      connectEVM(cp, 'Coinbase Wallet');
    }
  }
  function bindWallet() {
    var bm = $('btnMetaMask');
    if (bm) bm.addEventListener('click', function () { connectWalletByKey('metamask'); });
    var bp = $('btnPhantom');
    if (bp) bp.addEventListener('click', function () { connectWalletByKey('phantom'); });
    var bc = $('btnCoinbase');
    if (bc) bc.addEventListener('click', function () { connectWalletByKey('coinbase'); });
    var rt = $('walletInstallRetry');
    if (rt) rt.addEventListener('click', function () { if (walletRetryKey) connectWalletByKey(walletRetryKey); });
    var dc = $('walletDisconnect');
    if (dc) dc.addEventListener('click', function () {
      try { localStorage.removeItem('nexora_wallet'); } catch (e) {}
      paintWallet();
      toast('Carteira desconectada.', 'success');
    });
  }

  /* ---------- forms ---------- */
  function bindForms() {
    /* Investir em plano: AUTOMÁTICO via /api/my/invest. Debitamos o saldo do
       usuário na hora e abrimos a posição (o rendimento começa hoje). Nenhuma
       aprovação de admin aqui — o depósito (1x) que espera aprovação está na
       tela "Adicionar Saldo". */
    var df = $('depositForm');
    if (df) {
      var dpl = $('depPlan');
      if (dpl) dpl.addEventListener('change', paintPlanHint);
      df.addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = $('depSubmit');
        var plan = dpl && dpl.value;
        var amount = $('depAmount') && Number($('depAmount').value);
        if (!plan) { toast('Escolha um plano.', 'error'); return; }
        if (!isFinite(amount) || amount <= 0) { toast('Informe o valor.', 'error'); return; }
        var cur = state.plans.filter(function (p) { return String(p.id) === String(plan); })[0];
        if (cur && (amount < Number(cur.min_deposit) || amount > Number(cur.max_deposit))) {
          toast('Valor fora da faixa do plano (' + money(cur.min_deposit) + ' — ' + money(cur.max_deposit) + ').', 'error');
          return;
        }
        if (amount > (Number(state.available) || 0)) {
          toast('Saldo insuficiente (disponível: ' + money(state.available) + '). Faça um depósito em "Adicionar Saldo" primeiro.', 'error');
          return;
        }
        if (btn) btn.disabled = true;
        try {
          var body = { plan_id: plan, amount: amount };
          await api('/api/my/invest', { method: 'POST', body: body });
          toast('Investimento realizado! O rendimento começa a contar hoje.', 'success');
          df.reset();
          paintPlanHint();
          await loadPlans();
          await loadPositions();
          loadMe();
        } catch (err) { toast('Erro: ' + err.message, 'error'); }
        finally { if (btn) btn.disabled = false; }
      });
    }

    /* Top-up manual: envia hash da transferência para validação do saldo */
    var tg = $('topGateway');
    if (tg) tg.addEventListener('change', paintTopGateway);
    var cb = $('copyTopAddrBtn');
    if (cb) cb.addEventListener('click', function () {
      var v = $('topAddrValue') && $('topAddrValue').value;
      copyText(v, 'Endereço copiado! Confira a rede antes de enviar.');
    });
    var tf = $('topupForm');
    if (tf) tf.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('topupSubmit');
      var gateway = $('topGateway') && $('topGateway').value;
      var amount = $('topAmount') && Number($('topAmount').value);
      var tx = $('topTxHash') && $('topTxHash').value.trim();
      if (!gateway || !isFinite(amount) || amount <= 0) { toast('Escolha a moeda/rede e o valor.', 'error'); return; }
      if (!tx || tx.length < 5) { toast('Cole o hash da transferência para validação.', 'error'); return; }
      if (btn) btn.disabled = true;
      try {
        await api('/api/my/deposits', { method: 'POST', body: { amount: amount, gateway_id: gateway, tx_hash: tx } });
        toast('Hash enviado! Saldo creditado após validação.', 'success');
        tf.reset(); loadRecent();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });

    var wf = $('withdrawForm');
    if (wf) wf.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('wdSubmit');
      var amount = $('wdAmount') && Number($('wdAmount').value);
      var gateway = $('wdGateway') && $('wdGateway').value;
      var wallet = $('wdWallet') && $('wdWallet').value.trim();
        if (!isFinite(amount) || amount <= 0 || !gateway || !wallet) { toast('Preencha valor, gateway e carteira.', 'error'); return; }
        if (state.hasInvestment === false) {
          toast('Saque liberado somente após investir em um plano.', 'error');
          return;
        }
        if (amount > state.available) { toast('Saldo insuficiente (disponível: ' + money(state.available) + ').', 'error'); return; }
      if (btn) btn.disabled = true;
      try {
        await api('/api/my/withdrawals', { method: 'POST', body: { amount: amount, gateway_id: gateway, gateway: gateway, wallet_to: wallet, wallet: wallet } });
        toast('Saque solicitado!', 'success');
        wf.reset(); loadRecent(); loadMe();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });

    var sf = $('securityForm');
    if (sf) sf.addEventListener('submit', async function (e) {
      e.preventDefault();
      var cur = $('secCurrent') && $('secCurrent').value;
      var nw = $('secNew') && $('secNew').value;
      var nw2 = $('secNew2') && $('secNew2').value;
      if (!cur || !nw) { toast('Preencha as senhas.', 'error'); return; }
      if (nw !== nw2) { toast('Nova senha e confirmação divergem.', 'error'); return; }
      var btn = $('secSubmit'); if (btn) btn.disabled = true;
      try {
        await api('/api/me/change-password', { method: 'POST', body: { current_password: cur, currentPassword: cur, new_password: nw, newPassword: nw } });
        toast('Senha atualizada!', 'success');
        sf.reset();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });

    var st = $('settingsForm');
    if (st) st.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = $('setEmail') && $('setEmail').value.trim();
      if (!email) { toast('Informe um email válido.', 'error'); return; }
      var btn = $('setSubmit'); if (btn) btn.disabled = true;
      try {
        await api('/api/me', { method: 'PUT', body: { email: email } });
        toast('Conta atualizada!', 'success');
        loadMe();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });
  }

  /* ---------- copy buttons ---------- */
  function copyText(v, okMsg) {
    if (!v) { toast('Link ainda não carregado.', 'error'); return; }
    function done() { toast(okMsg || 'Copiado!', 'success'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = v; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); done();
      } catch (e) { toast('Não foi possível copiar.', 'error'); }
    }
  }
  function bindCopy() {
    var b1 = $('copyRefBtn'), b2 = $('copyRefBtn2');
    if (b1) b1.addEventListener('click', function () { copyText($('refLink') && $('refLink').value, 'Affiliate link copiado!'); });
    if (b2) b2.addEventListener('click', function () { copyText($('refLink2') && $('refLink2').value, 'Affiliate link copiado!'); });
  }

  /* ---------- logout ---------- */
  var lo = $('logoutLink');
  if (lo) lo.addEventListener('click', function (e) { e.preventDefault(); logout(); });

  /* ---------- boot ---------- */
  /* Aviso de simulação: some apenas se o servidor declarar simulated=false.
     Enquanto o fetch não responde, o aviso fica oculto — nunca o contrário. */
  function paintSimNotice() {
    api('/api/public/plans').then(function (d) {
      var arr = Array.isArray(d) ? d : [];
      var sim = arr.length ? arr[0].simulated !== false : true;
      var n = $('simNotice'); if (n) n.style.display = sim ? '' : 'none';
      var s = $('simStats'); if (s) s.style.display = sim ? '' : 'none';
    }).catch(function () { /* rede caiu: mantém o aviso como está */ });
  }
  bindForms();
  bindCopy();
  bindWallet();
  paintWallet();
  paintSimNotice();
  /* ?view=xxx → normaliza para hash na primeira carga */
  try {
    var qv = new URLSearchParams(window.location.search).get('view');
    if (qv && TITLES[qv.toLowerCase()] && !window.location.hash) {
      window.location.hash = '#' + qv.toLowerCase();
    }
  } catch (e) {}
  render(currentRoute());
  loadMe();
  loadRecent();

  /* ---- contadores ao vivo: tick por segundo + ressincronização com o banco ---- */
  setInterval(tickMine, 1000);
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    loadPositions();
  }, 20000);
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    loadMe();      /* saldo/earnings sobem sozinhos quando o crédito do dia cai */
    loadAccruals();
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    loadPositions();
    loadMe();
    loadAccruals();
  });
})();
