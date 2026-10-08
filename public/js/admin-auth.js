// Nexora admin auth — vanilla JS, igual ao login de usuário
(function(){
  "use strict";
  function $(id){ return document.getElementById(id); }
  function showMsg(kind, text){
    var el = $("alert");
    if(!el) return;
    el.className = "alert " + kind;
    el.textContent = text;
  }
  function setLoading(form, loading){
    var btn = form.querySelector('button[type="submit"]');
    if(!btn) return;
    if(loading){
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Aguarde…';
    } else {
      btn.disabled = false;
      if(btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }
  function saveSession(data){
    try{
      if(!data.token) throw new Error("Resposta de login inválida (sem token).");
      var user = data.user || { email: data.email || "" };
      localStorage.setItem("nexora_token", data.token);
      localStorage.setItem("nexora_user", JSON.stringify(user));
    }catch(e){ throw e; }
  }
  function goAdmin(){ window.location.href = "./admin.html"; }

  var loginForm = $("loginForm");
  if(loginForm){
    loginForm.addEventListener("submit", function(ev){
      ev.preventDefault();
      var loginEl = $("login");
      var login = loginEl.value.trim();
      var pass = $("password").value;
      if(!login || !pass){ showMsg("error","Preencha usuário e senha."); return; }
      setLoading(loginForm, true);
      fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:login,password:pass})})
        .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, body:j}; }); })
        .then(function(res){
          if(!res.ok) throw new Error(res.body.message || res.body.error || "Falha no login. Verifique suas credenciais.");
          var u = res.body.user || {};
          var isAdmin = u.is_admin === 1 || u.is_admin === true || u.is_admin === '1' || u.role === 'admin';
          if(!isAdmin) throw new Error("Esta conta não é administradora. Acesso restrito.");
          saveSession(res.body);
          showMsg("success","Login admin realizado! Redirecionando…");
          setTimeout(goAdmin, 700);
        })
        .catch(function(err){ showMsg("error", err.message || "Erro de conexão com o servidor. Ele está rodando? (npm start)"); setLoading(loginForm,false); });
    });
  }
})();