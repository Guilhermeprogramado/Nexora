/* ============================================================
   Nexora — public/js/ticker.js
   Ticker de criptos compartilhado: mesma faixa no painel do
   usuário, na landing (index.html) e no login.
   - Sem auth: /api/crypto/prices é público.
   - Sem preço inventado: se a API falhar ou devolver lista vazia,
     a faixa mostra "indisponível" (regra do README).
   - Só roda se existir #tickerTrack na página.
   ============================================================ */
(function () {
  'use strict';

  var track = document.getElementById('tickerTrack');
  if (!track) return;

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtPrice(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return n >= 1000
      ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  function renderTicker(coins) {
    if (!coins || !coins.length) {
      track.innerHTML = '<div class="ticker-empty">Preços indisponíveis no momento.</div>';
      return;
    }
    var group = coins.map(function (c) {
      var s = esc(c.symbol || '?');
      var n = esc(c.name || '');
      var ch = Number(c.change ?? c.change24h ?? c.change_24h ?? 0);
      if (!isFinite(ch)) ch = 0;
      var up = ch >= 0;
      var logoUrl = c.logo || '';
      return '<div class="tk">' +
        '<div class="coin-logo">' + (logoUrl
          ? '<img src="' + esc(logoUrl) + '" alt="' + esc(s) + '" loading="lazy">'
          : '<div class="coin" style="background:' + esc(c.color || '#8b5cf6') + '">' + esc(s.charAt(0)) + '</div>') +
        '</div>' +
        '<div class="info"><b>' + s + '</b><span>' + n + '</span></div>' +
        '<div class="price"><b>$' + fmtPrice(c.price) + '</b>' +
        '<div class="chg ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + ' ' +
          Math.abs(ch).toFixed(1) + '%</div></div>' +
      '</div>';
    }).join('');
    track.innerHTML = group + group; /* duplicado p/ loop infinito */
  }

  function normalize(payload) {
    var arr = Array.isArray(payload) ? payload
      : (payload && (payload.prices || payload.data || payload.tickers)) || [];
    if (!Array.isArray(arr) || !arr.length) return [];
    return arr.map(function (c) {
      return {
        symbol: c.symbol || c.s || c.coin || '?',
        name: c.name || c.n || c.label || '',
        price: c.price ?? c.p ?? c.value ?? 0,
        change: c.change ?? c.change24h ?? c.change_24h ?? c.ch ?? c.percent ?? 0,
        color: c.color || '#8b5cf6',
        logo: c.logo || ''
      };
    });
  }

  async function loadTicker() {
    try {
      var res = await fetch('/api/crypto/prices', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      renderTicker(normalize(data));
    } catch (err) {
      renderTicker(null); /* fonte caiu: mostra indisponível, nunca número inventado */
    }
  }

  loadTicker();
  setInterval(loadTicker, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') loadTicker();
  });
})();
