/* Deploy estatico (ex.: ByetHost / hospedagem PHP sem Node).
 * O site (HTML/CSS/JS) roda aqui, mas a API Express continua no Vercel.
 * Este shim reescreve apenas as chamadas fetch() para /api/... apontando
 * para a base da API. Em localhost/Vercel/dominios proprios nao faz nada.
 * Para trocar o backend, ajuste NEXORA_API_BASE abaixo. */
(function () {
  var NEXORA_API_BASE = 'https://nexora-orpin-six.vercel.app';
  try {
    var host = String(location.hostname || '').toLowerCase();
    var sameHost = host === '' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.vercel.app');
    if (sameHost) return;
    var orig = window.fetch;
    if (!orig) return;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' && input.indexOf('/api/') === 0) {
          input = NEXORA_API_BASE + input;
        } else if (input && typeof input === 'object' && typeof input.url === 'string' && input.url.indexOf('/api/') === 0) {
          input = new Request(NEXORA_API_BASE + input.url, input);
        }
      } catch (e) { /* deixa seguir sem reescrever */ }
      return orig.call(this, input, init);
    };
  } catch (e) { /* shim opcional */ }
})();
