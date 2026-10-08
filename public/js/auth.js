// Nexora auth — vanilla JS
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
  function goDashboard(){ window.location.href = "./dashboard.html"; }

  // Pré-preenche ?ref= no signup
  var refInput = $("ref");
  if(refInput){
    try{
      var q = new URLSearchParams(window.location.search);
      var ref = q.get("ref") || q.get("codigo") || "";
      if(ref) refInput.value = ref;
    }catch(e){}
  }

  // LOGIN — backend espera { login: username|email, password }
  var loginForm = $("loginForm");
  if(loginForm){
    loginForm.addEventListener("submit", function(ev){
      ev.preventDefault();
      var loginEl = $("login") || $("email");
      var login = loginEl.value.trim();
      var pass = $("password").value;
      if(!login || !pass){ showMsg("error","Preencha usuário e senha."); return; }
      setLoading(loginForm, true);
      fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:login,password:pass})})
        .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, body:j}; }); })
        .then(function(res){
          if(!res.ok) throw new Error(res.body.message || res.body.error || "Falha no login. Verifique suas credenciais.");
          saveSession(res.body);
          showMsg("success","Login realizado! Redirecionando…");
          setTimeout(goDashboard, 700);
        })
        .catch(function(err){ showMsg("error", err.message || "Erro de conexão com o servidor. Ele está rodando? (npm start)"); setLoading(loginForm,false); });
    });
  }

  // SIGNUP — backend espera { username, email, password, ref? }
  var signupForm = $("signupForm");
  if(signupForm){
    signupForm.addEventListener("submit", function(ev){
      ev.preventDefault();
      var userEl = $("username") || $("name");
      var name = userEl.value.trim();
      var email = $("email").value.trim();
      var pass = $("password").value;
      var pass2 = $("password2").value;
      var ref = refInput ? refInput.value.trim() : "";
      if(!name || !email || !pass){ showMsg("error","Preencha usuário, e-mail e senha."); return; }
      if(!/^[a-zA-Z0-9_]{3,20}$/.test(name)){ showMsg("error","Usuário inválido: 3-20 caracteres, só letras, números e _."); return; }
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ showMsg("error","E-mail inválido."); return; }
      if(pass.length < 6){ showMsg("error","A senha deve ter ao menos 6 caracteres."); return; }
      if(pass !== pass2){ showMsg("error","As senhas não coincidem."); return; }
      setLoading(signupForm, true);
      fetch("/api/auth/signup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:name,email:email,password:pass,ref:ref})})
        .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, body:j}; }); })
        .then(function(res){
          if(!res.ok) throw new Error(res.body.message || res.body.error || "Não foi possível criar a conta.");
          saveSession(res.body);
          showMsg("success","Conta criada com sucesso! Redirecionando…");
          setTimeout(goDashboard, 700);
        })
        .catch(function(err){ showMsg("error", err.message || "Erro de conexão com o servidor. Ele está rodando? (npm start)"); setLoading(signupForm,false); });
    });
  }

  // FORGOT (mock)
  var forgotForm = $("forgotForm");
  if(forgotForm){
    forgotForm.addEventListener("submit", function(ev){
      ev.preventDefault();
      var email = $("email").value.trim();
      if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ showMsg("error","Informe um e-mail válido."); return; }
      setLoading(forgotForm, true);
      setTimeout(function(){
        setLoading(forgotForm, false);
        showMsg("success","Link enviado! Verifique seu e-mail ("+email+") para redefinir a senha.");
        forgotForm.reset();
      }, 900);
    });
  }
})();
