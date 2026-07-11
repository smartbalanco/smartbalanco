// ============================================================================
// SMARTBALANÇO - LÓGICA DO APP
// ============================================================================

// URL do seu Web App do Apps Script (termina em /exec)
const API_URL = "https://script.google.com/macros/s/AKfycbwGBnFvY9FtaNm2AF4gBkgbNf21iYYyyAFIAjqtAlprGXyqaZKZyIidNrzR5UNvhiNA/exec";

// Client ID do login Google
const GOOGLE_CLIENT_ID = "964045201445-qc96mfjmeghvaknoegpgm5m4esk6ij4g.apps.googleusercontent.com";

// Guarda o token de login do usuário atual (em memória, durante a sessão)
let tokenLoginAtual = null;
let emailUsuarioAtual = null;

// ============================================================================
// LOGIN COM GOOGLE
// Chamado automaticamente pela biblioteca do Google quando o usuário entra.
// ============================================================================
function aoReceberLoginGoogle(resposta) {
  // resposta.credential é o "id_token" — a prova de identidade do usuário.
  tokenLoginAtual = resposta.credential;

  // Descobre o e-mail lendo o token (só pra mostrar na tela; a validação
  // de verdade acontece no servidor).
  try {
    const payload = JSON.parse(atob(tokenLoginAtual.split(".")[1]));
    emailUsuarioAtual = payload.email;
  } catch (e) {
    emailUsuarioAtual = "(desconhecido)";
  }

  // Confirma com o servidor se este usuário está autorizado.
  verificarAutorizacao();
}

// ============================================================================
// COMUNICAÇÃO COM O SERVIDOR (Apps Script)
// Monta a URL com a ação desejada + o token de login, e busca a resposta.
// ============================================================================
async function chamarServidor(acao, paramsExtras = {}) {
  const params = new URLSearchParams({
    acao: acao,
    token: tokenLoginAtual || "",
    ...paramsExtras
  });

  const url = API_URL + "?" + params.toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Falha na conexão com o servidor (HTTP " + resp.status + ").");
  return await resp.json();
}

// ============================================================================
// VERIFICA SE O USUÁRIO LOGADO ESTÁ AUTORIZADO
// ============================================================================
async function verificarAutorizacao() {
  mostrarCarregando("Verificando acesso...");
  try {
    const r = await chamarServidor("ping");
    if (r.ok) {
      // Autorizado! Mostra a tela interna.
      mostrarTelaInterna(r.usuario);
    } else {
      // Servidor recusou (e-mail não autorizado ou token inválido).
      mostrarErroLogin(r.mensagem || "Acesso negado.");
    }
  } catch (e) {
    mostrarErroLogin("Não foi possível falar com o servidor. Verifique a internet.");
  }
}

// ============================================================================
// CONTROLE DE TELAS
// ============================================================================
function mostrarCarregando(msg) {
  document.getElementById("tela-login").style.display = "none";
  document.getElementById("tela-interna").style.display = "none";
  document.getElementById("tela-carregando").style.display = "flex";
  document.getElementById("carregando-msg").textContent = msg || "Carregando...";
}

function mostrarTelaLogin() {
  document.getElementById("tela-carregando").style.display = "none";
  document.getElementById("tela-interna").style.display = "none";
  document.getElementById("tela-login").style.display = "flex";
}

function mostrarErroLogin(msg) {
  mostrarTelaLogin();
  const el = document.getElementById("login-erro");
  el.textContent = msg;
  el.style.display = "block";
}

function mostrarTelaInterna(email) {
  document.getElementById("tela-carregando").style.display = "none";
  document.getElementById("tela-login").style.display = "none";
  document.getElementById("tela-interna").style.display = "block";
  document.getElementById("usuario-email").textContent = email;
}

// ============================================================================
// BOTÃO DE TESTE (prova que app <-> servidor conversam)
// ============================================================================
async function testarConexao() {
  const resultado = document.getElementById("teste-resultado");
  resultado.textContent = "Chamando o servidor...";
  try {
    const r = await chamarServidor("ping");
    resultado.textContent = "✅ " + r.mensagem + " (você é: " + r.usuario + ")";
  } catch (e) {
    resultado.textContent = "❌ Erro: " + e.message;
  }
}

// ============================================================================
// SAIR
// ============================================================================
function sair() {
  tokenLoginAtual = null;
  emailUsuarioAtual = null;
  google.accounts.id.disableAutoSelect();
  mostrarTelaLogin();
  document.getElementById("login-erro").style.display = "none";
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
window.addEventListener("load", () => {
  // Registra o service worker (torna o app instalável).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch((e) =>
      console.warn("Service worker não registrado:", e)
    );
  }

  // Configura o login do Google.
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: aoReceberLoginGoogle
  });

  // Desenha o botão "Entrar com Google".
  google.accounts.id.renderButton(
    document.getElementById("botao-google"),
    { theme: "outline", size: "large", width: 260, text: "signin_with", locale: "pt-BR" }
  );

  mostrarTelaLogin();
});
