// Nexora landing JS — vanilla. Sem fallback mock: falha de API vira "indisponível".
(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };

  // ---- Hamburger ----
  var ham = $("hamburger"), mm = $("mobileMenu");
  if (ham && mm) ham.addEventListener("click", function(){ mm.classList.toggle("open"); });
  if (mm) mm.querySelectorAll("a").forEach(function(a){ a.addEventListener("click", function(){ mm.classList.remove("open"); }); });

  // ---- i18n simples PT/EN ----
  // O dicionário precisa casar com o HTML atual. Se uma chave aqui descrever
  // algo que o produto não faz (bot, plano diário, comissão), ela é mentira
  // renderizada por cima da página — então não existe.
  var dict = {
    en: { nav_about:"About", nav_faq:"FAQ", nav_contact:"Contact", nav_signup:"Connect wallet",
      hero_badge:"Real DeFi protocols, in your own wallet",
      hero_title:'On-chain yield <span class="grad-text">on Solana</span> without us holding your money',
      hero_sub:"Nexora shows the real on-chain data for SOL staking (Jito) and USDT vaults (Kamino). You connect Phantom and transact with the protocol directly — we never take custody of your funds." },
    pt: { nav_about:"Sobre", nav_faq:"FAQ", nav_contact:"Contato", nav_signup:"Conectar carteira",
      hero_badge:"Protocolos DeFi reais, na sua carteira",
      hero_title:'Rendimento DeFi <span class="grad-text">na Solana</span> sem intermediar seu dinheiro',
      hero_sub:"A Nexora mostra os dados on-chain reais do staking de SOL (Jito) e dos vaults USDT (Kamino). Você conecta a Phantom e opera direto no protocolo — a Nexora nunca recebe seus fundos." }
  };
  var lang = "pt";
  var toggle = $("langToggle");
  if (toggle) toggle.addEventListener("click", function(){
    lang = (lang === "pt") ? "en" : "pt";
    toggle.textContent = (lang === "pt") ? "EN" : "PT";
    document.documentElement.lang = (lang === "pt") ? "pt-BR" : "en";
    document.querySelectorAll("[data-i18n]").forEach(function(el){
      var k = el.getAttribute("data-i18n");
      if (dict[lang][k]) el.innerHTML = dict[lang][k];
    });
  });

  // ---- FAQ accordion ----
  document.querySelectorAll(".faq-item").forEach(function(item){
    var q = item.querySelector(".faq-q");
    if (q) q.addEventListener("click", function(){
      var open = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach(function(o){ o.classList.remove("open"); });
      if (!open) item.classList.add("open");
    });
  });

  // ---- Ticker & Coins: /api/crypto/prices com fallback mock ----
  var ticker = $("ticker");
  var coinsGrid = $("coinsGrid");
  function renderTicker(list){
    if (!ticker) return;
    ticker.innerHTML = "";
    list.forEach(function(c){
      var s = document.createElement("span");
      s.className = "tick";
      var cls = c.change >= 0 ? "up" : "down";
      var arrow = c.change >= 0 ? "▲" : "▼";
      var price = typeof c.price === "number" ? c.price.toLocaleString("pt-BR",{minimumFractionDigits:2, maximumFractionDigits:4}) : c.price;
      var logoHtml = c.logo ? '<img src="' + c.logo + '" alt="' + c.symbol + '" class="tick-logo" loading="lazy">' : '';
      s.innerHTML = logoHtml + '<span class="sym">'+c.symbol+'</span> $'+price+' <span class="'+cls+'">'+arrow+' '+Math.abs(c.change).toFixed(1)+'%</span>';
      ticker.appendChild(s);
    });
  }
  function renderCoins(list){
    if (!coinsGrid) return;
    coinsGrid.innerHTML = "";
    list.forEach(function(c){
      var div = document.createElement("div");
      div.className = "coin";
      var logoHtml = c.logo ? '<img src="' + c.logo + '" alt="' + c.symbol + '" class="coin-logo-img" loading="lazy">' : '<span class="coin-i" style="background:' + (c.color || '#8b5cf6') + '">' + (c.symbol || '?').charAt(0) + '</span>';
      div.innerHTML = logoHtml + '<div><b>' + (c.symbol || '?') + '</b><small>' + (c.name || '') + '</small></div>';
      coinsGrid.appendChild(div);
    });
  }
  // Não renderizamos preço fictício como se fosse real. Até a API responder,
  // o estado é "indisponível"; se ela falhar, continua assim.
  function renderUnavailable(){
    if (ticker) ticker.innerHTML = '<span class="tick" style="color:#8b98a5">preços indisponíveis — fonte de dados não respondeu</span>';
    if (coinsGrid) coinsGrid.innerHTML = '<div class="coin"><div><b>—</b><small>preço indisponível</small></div></div>';
  }
  renderUnavailable();
  fetch("/api/crypto/prices").then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(d){
    var arr = Array.isArray(d) ? d : (d.data || d.prices || null);
    if (arr && arr.length) {
      var mapped = arr.map(function(c){ return {symbol:c.symbol||c.sym, name:c.name||c.n, price:Number(c.price), change:Number(c.change24h ?? c.change ?? 0), logo: c.logo || '', color: c.color || '#8b5cf6'}; });
      renderTicker(mapped);
      renderCoins(mapped);
    }
  }).catch(function(){ /* mantém "indisponível" */ });

  // ---- Planos + calculadora (juros simples) ----
  // A formula aqui e a MESMA que accrual.js credita no servidor:
  //   dia = principal * (taxa/100) ; total = principal + dia * dias
  // Sem capitalizacao.
  var planSel=$("calcPlan"), amtEl=$("calcAmount"), daysSel=$("calcDays");
  var rD=$("rDaily"), rT=$("rTotal"), rN=$("rNet");
  var PLANS=[];

  function fmt(v){ return "$" + Number(v||0).toLocaleString("en-US",{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function numBR(v){
    if (typeof v === "number") return v;
    if (v == null) return NaN;
    return parseFloat(String(v).replace(",", "."));
  }

  function currentPlan(){
    if(!planSel) return PLANS[0] || null;
    var id=Number(planSel.value);
    return PLANS.filter(function(p){ return Number(p.id)===id; })[0] || PLANS[0] || null;
  }

  function renderPlans(list){
    var grid=$("plansGrid");
    if (grid){
      if (!list.length){
        grid.innerHTML='<div class="card plan"><p class="muted">Nenhum plano ativo no momento.</p></div>';
      } else {
        grid.innerHTML=list.map(function(p){
          var dailyAtMin=Number(p.daily_amount_at_min||0);
          var grossMin=Number(p.gross_at_min||0);
          var maxDep=Number(p.max_deposit||0);
          var hasMax=maxDep>0;
          var dailyAtMax=Number(p.daily_amount_at_max||0);
          var grossMax=Number(p.gross_at_max||0);
          var rate='<div class="rate'+(hasMax?' range':'')+'">'+
            '<b>'+fmt(dailyAtMin)+'</b>'+
            (hasMax?'<i aria-hidden="true">→</i><b>'+fmt(dailyAtMax)+'</b>':'')+
            '<small>rende por dia investindo entre '+fmt(p.min_deposit)+(hasMax?' e '+fmt(maxDep):'')+'</small>'+
          '</div>';
          return '<div class="card plan">'+
            '<span class="tag">'+String(p.daily_rate).replace(".",",")+'% ao dia</span>'+
            '<h3>'+p.name+'</h3>'+
            rate+
            '<ul>'+
              '<li>'+p.duration_days+' dia(s) de duracao</li>'+
              '<li>Lucro total no minimo ('+fmt(p.min_deposit)+'): <b>'+fmt(grossMin)+'</b></li>'+
              (hasMax?'<li>Lucro total no maximo ('+fmt(maxDep)+'): <b>'+fmt(grossMax)+'</b></li>':'')+
              '<li>Juros simples, sem capitalizacao</li>'+
            '</ul>'+
            '<a class="btn btn-primary btn-block" href="#calculadora" data-plan="'+p.id+'">Simular este plano</a>'+
          '</div>';
        }).join("");
      }
    }

    if (planSel){
      planSel.innerHTML = list.length
        ? list.map(function(p){ return '<option value="'+p.id+'">'+p.name+'</option>'; }).join("")
        : '<option value="">Nenhum plano</option>';
    }
    var sel = currentPlan();
    syncPlan(sel);
    calc();
  }

  // Mantem calculadora coerente com o plano escolhido:
  //  - dias: habilita so o que o plano cobre e volta para "1 dia" se a
  //    escolha atual passar do fim do contrato;
  //  - valor: se estiver fora da faixa (ou vazio), usa o limite da faixa.
  function syncPlan(p){
    if(!p) return;
    if(daysSel){
      var opts=daysSel.options, dur=Number(p.duration_days)||1;
      for (var i=0;i<opts.length;i++) opts[i].disabled = Number(opts[i].value) > dur;
      var cur=parseInt(daysSel.value,10);
      if(!cur || cur>dur) daysSel.value="1";
    }
    if(amtEl){
      var min=Number(p.min_deposit||0), max=Number(p.max_deposit||0);
      var a=numBR(amtEl.value);
      if(!(a>0) || (min>0 && a<min)) amtEl.value=String(min);
      else if(max>0 && a>max) amtEl.value=String(max);
    }
  }

  function calc(){
    var warn=$("calcWarn");
    var p=currentPlan();
    if(!p || !amtEl){
      if(rD) rD.textContent="-"; if(rT) rT.textContent="-"; if(rN) rN.textContent="-";
      return;
    }
    var min=Number(p.min_deposit||0), max=Number(p.max_deposit||0);
    var a=Math.max(0, numBR(amtEl.value)||0);

    // Nao trava o campo: o usuario pode simular fora da faixa e ver o aviso.
    var out=false, msg="";
    if (a>0 && a<min){ out=true; msg="Abaixo do minimo deste plano ("+fmt(min)+"). O sistema nao aceita este valor."; }
    else if (a>max){ out=true; msg="Acima do maximo deste plano ("+fmt(max)+")."; }
    if(warn){ warn.textContent=msg; warn.style.display=msg?"":"none"; }

    var daily=a*(Number(p.daily_rate)/100);
    var days=daysSel?(parseInt(daysSel.value,10)||1):1;
    var total=out?0:a+daily*days;
    if(rD) rD.textContent=out?"—":fmt(daily);
    if(rN) rN.textContent=out?"—":fmt(daily*days);
    if(rT) rT.textContent=out?"—":fmt(total)+" ("+days+(days===1?" dia":" dias")+")";
  }

  if(planSel) planSel.addEventListener("change", function(){ syncPlan(currentPlan()); calc(); });
  if(daysSel) daysSel.addEventListener("change", calc);
  if(amtEl) amtEl.addEventListener("input", calc);

  // "Simular este plano" ja escolhe o plano na calculadora antes de rolar ate ela.
  var plansGrid=$("plansGrid");
  if(plansGrid && planSel) plansGrid.addEventListener("click", function(e){
    var a=e.target && e.target.closest ? e.target.closest("a[data-plan]") : null;
    if(!a) return;
    planSel.value=a.getAttribute("data-plan");
    syncPlan(currentPlan());
    calc();
  });

  fetch("/api/public/plans").then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(list){
    PLANS = Array.isArray(list) ? list : [];
    renderPlans(PLANS);
  }).catch(function(){
    PLANS=[];
    renderPlans([]);
    var grid=$("plansGrid");
    if(grid) grid.innerHTML='<div class="card plan"><p class="muted">Nao foi possivel carregar os planos.</p></div>';
  });

  // ---- Stats: totais REAIS calculados pelo banco (sem número inventado) ----
  // Enquanto a instalação não tiver operação, os valores ficam 0/1 — e é isso
  // que aparece. Nada é preenchido com dado fictício.
  function brl(v){ return "$" + Number(v||0).toLocaleString("pt-BR",{maximumFractionDigits:0}); }
  fetch("/api/public/stats").then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(d){
    var s = d.data || d;
    if($("stUsers")) $("stUsers").textContent = Number(s.user_count||0).toLocaleString("pt-BR");
    if($("stVolume")) $("stVolume").textContent = brl(s.total_invested);
    if($("stPaid")) $("stPaid").textContent = brl(s.total_paid);
  }).catch(function(){
    if($("stUsers")) $("stUsers").textContent = "—";
    if($("stVolume")) $("stVolume").textContent = "—";
    if($("stPaid")) $("stPaid").textContent = "—";
  });

  // ---- Pool Jito (SOL em stake, lido on-chain) ----
  function sol(v){ return Number(v||0).toLocaleString("pt-BR",{maximumFractionDigits:0}); }
  fetch("/api/solana/jito").then(function(r){ return r.json(); }).then(function(j){
    if(j && j.ok){
      if($("heroBalance")) $("heroBalance").textContent = sol(j.solInPool) + " SOL";
      if($("stJitoTvl"))   $("stJitoTvl").textContent = sol(j.solInPool) + " SOL";
    } else {
      if($("heroBalance")) $("heroBalance").textContent = "indisponível";
      if($("stJitoTvl"))   $("stJitoTvl").textContent = "indisponível";
    }
    if(j && j.ok && $("jitoRate")){
      $("jitoRate").textContent = Number(j.solPerJitoSol||0).toFixed(4) + " SOL por jitoSOL";
    }
  }).catch(function(){
    if($("heroBalance")) $("heroBalance").textContent = "—";
    if($("stJitoTvl"))   $("stJitoTvl").textContent = "—";
  });

  // Maior APY real entre vaults USDT da Kamino foi removido da landing: o
  // maior APY de um vault pequeno e volatil, isolado, e presented como numero
  // de destaque induzia erro. A tabela completa por vault vive em /yield.html.

  // Sem barra "animada de atividade": uma barra que se move sozinha sugeriria
  // operações em andamento que não existem. A barra fica parada e neutra.
  var bar = $("heroBar"); if(bar){ bar.style.width = "0%"; }

  // ---- Protocolos e ferramentas realmente usados ----
  // Antes esta lista era Binance/Bybit/OKX rotulada "exchanges parceiras", o que
  // é falso: não temos parceria com nenhuma delas. Listamos o que de fato
  // consultamos/indicamos.
  var exchangesGrid = $("exchangesGrid");
  var protocols = [
    { name: "Jito",        logo: "https://www.google.com/s2/favicons?domain=jito.network&sz=64" },
    { name: "Kamino",      logo: "https://www.google.com/s2/favicons?domain=kamino.finance&sz=64" },
    { name: "Solana",      logo: "https://www.google.com/s2/favicons?domain=solana.com&sz=64" },
    { name: "Phantom",     logo: "https://www.google.com/s2/favicons?domain=phantom.app&sz=64" }
  ];
  function renderExchanges(list){
    if (!exchangesGrid) return;
    exchangesGrid.innerHTML = "";
    list.forEach(function(ex){
      var div = document.createElement("div");
      div.className = "exchange-logo";
      div.innerHTML = '<span class="exchange-name">' + ex.name + '</span>' +
        '<img src="' + ex.logo + '" alt="' + ex.name + '" loading="lazy" title="' + ex.name + '">';
      exchangesGrid.appendChild(div);
    });
  }
  renderExchanges(protocols);
})();
