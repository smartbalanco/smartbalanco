// ============================================================================
// SMARTBALANÇO - LÓGICA DO APP
// ============================================================================

const API_URL = "https://script.google.com/macros/s/AKfycbwGBnFvY9FtaNm2AF4gBkgbNf21iYYyyAFIAjqtAlprGXyqaZKZyIidNrzR5UNvhiNA/exec";
const GOOGLE_CLIENT_ID = "964045201445-qc96mfjmeghvaknoegpgm5m4esk6ij4g.apps.googleusercontent.com";

let tokenLoginAtual = null;
let emailUsuarioAtual = null;

// Mês/ano atualmente em exibição (navegável)
let mesExibido = new Date().getMonth();
let anoExibido = new Date().getFullYear();

// ============================================================================
// LOGIN
// ============================================================================
function aoReceberLoginGoogle(resposta) {
  tokenLoginAtual = resposta.credential;
  try {
    const payload = JSON.parse(atob(tokenLoginAtual.split(".")[1]));
    emailUsuarioAtual = payload.email;
  } catch (e) {
    emailUsuarioAtual = "(desconhecido)";
  }
  entrarNoApp();
}

// ============================================================================
// SERVIDOR
// ============================================================================
async function chamarServidor(acao, paramsExtras) {
  paramsExtras = paramsExtras || {};
  const base = { acao: acao, token: tokenLoginAtual || "" };
  const params = new URLSearchParams(Object.assign(base, paramsExtras));
  const url = API_URL + "?" + params.toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Falha na conexão (HTTP " + resp.status + ").");
  return await resp.json();
}

// ============================================================================
// ENTRADA / CARGA DO DASHBOARD
// ============================================================================
async function entrarNoApp() {
  mostrarCarregando("Carregando seus dados...");
  try {
    const r = await chamarServidor("dashboard", { mes: mesExibido, ano: anoExibido });
    if (r.ok) {
      preencherDashboard(r);
      mostrarTelaInterna();
    } else if (r.erro === "NAO_AUTORIZADO") {
      mostrarErroLogin(r.mensagem || "Acesso negado. Este e-mail não está autorizado.");
    } else {
      mostrarErroLogin(r.mensagem || "Não foi possível carregar os dados.");
    }
  } catch (e) {
    mostrarErroLogin("Sem conexão com o servidor. Verifique a internet.");
  }
}

// ============================================================================
// NAVEGAÇÃO ENTRE MESES
// ============================================================================
async function mudarMes(delta) {
  mesExibido += delta;
  if (mesExibido > 11) { mesExibido = 0; anoExibido++; }
  if (mesExibido < 0) { mesExibido = 11; anoExibido--; }
  await recarregarDados();
}

async function irParaMesAtual() {
  mesExibido = new Date().getMonth();
  anoExibido = new Date().getFullYear();
  await recarregarDados();
}

async function recarregarDados() {
  const btn = document.getElementById("btn-atualizar");
  if (btn) btn.classList.add("girando");
  document.getElementById("conteudo-dash").style.opacity = "0.4";
  try {
    const r = await chamarServidor("dashboard", { mes: mesExibido, ano: anoExibido });
    if (r.ok) preencherDashboard(r);
  } catch (e) {
    // mantém dados anteriores
  } finally {
    if (btn) btn.classList.remove("girando");
    document.getElementById("conteudo-dash").style.opacity = "1";
  }
}

// ============================================================================
// FORMATAÇÃO
// ============================================================================
function formatarMoeda(valor) {
  if (isNaN(valor) || valor === null) return "R$ 0,00";
  return "R$ " + Number(valor).toFixed(2).replace(".", ",").replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1.");
}

function corDoScore(classificacao) {
  const c = (classificacao || "").toLowerCase();
  if (c.indexOf("excelente") !== -1) return "#2e9e6b";
  if (c.indexOf("bom") !== -1) return "#eab308";
  if (c.indexOf("aten") !== -1) return "#f97316";
  return "#dc2626";
}

function escaparHtml(txt) {
  const div = document.createElement("div");
  div.textContent = txt == null ? "" : String(txt);
  return div.innerHTML;
}

// ============================================================================
// PREENCHER DASHBOARD
// ============================================================================
function preencherDashboard(d) {
  document.getElementById("mes-referencia").textContent = d.mesReferencia || "";

  // Botão "hoje" só aparece se não estiver no mês corrente
  const hojeM = new Date().getMonth();
  const hojeA = new Date().getFullYear();
  const btnHoje = document.getElementById("btn-hoje");
  btnHoje.style.display = (d.mes === hojeM && d.ano === hojeA) ? "none" : "inline-block";

  // ---- SALDO (base = receita do mês anterior) ----
  const s = d.saldo || {};
  const elSaldo = document.getElementById("saldo-valor");
  elSaldo.textContent = formatarMoeda(s.saldo);
  elSaldo.style.color = (s.saldo >= 0) ? "#2e9e6b" : "#dc2626";

  document.getElementById("receita-base-label").textContent = "Receita de " + (d.mesBaseNome || "-");
  document.getElementById("saldo-receitas").textContent = formatarMoeda(s.receitaBase);
  document.getElementById("saldo-despesas").textContent = formatarMoeda(s.despesas);

  document.getElementById("aviso-base").textContent =
    "Base de cálculo: receita de " + (d.mesBaseNome || "-") + " (o que entrou no mês anterior é o que se gasta agora).";

  document.getElementById("receita-mes-atual").textContent =
    "Receita já recebida em " + (d.mesReferencia || "") + ": " + formatarMoeda(s.receitaDoMes);

  const ds = d.despesasStatus || {};
  document.getElementById("desp-pagas").textContent = formatarMoeda(ds.pagas);
  document.getElementById("desp-pendentes").textContent = formatarMoeda(ds.pendentes);

  // ---- SCORE ----
  const sc = d.score || {};
  const cor = corDoScore(sc.classificacao);
  document.getElementById("score-valor").textContent = (sc.valor != null ? sc.valor : "-") + "/100";
  document.getElementById("score-valor").style.color = cor;
  document.getElementById("score-classificacao").textContent = sc.classificacao || "";
  document.getElementById("score-classificacao").style.color = cor;
  document.getElementById("score-barra-preenchida").style.width = (sc.valor || 0) + "%";
  document.getElementById("score-barra-preenchida").style.background = cor;
  document.getElementById("score-detalhes").textContent = sc.detalhes || "";

  // ---- CONTAS A VENCER ----
  const listaVencer = document.getElementById("lista-vencer");
  listaVencer.innerHTML = "";
  if (!d.contasAVencer || d.contasAVencer.length === 0) {
    listaVencer.innerHTML = '<p class="vazio">✅ Nenhuma conta a vencer nos próximos 15 dias.</p>';
  } else {
    d.contasAVencer.forEach(function (c) {
      const item = document.createElement("div");
      item.className = "linha-item";
      item.innerHTML =
        '<span class="li-esq"><b class="li-data">' + c.data + '</b> ' + escaparHtml(c.descricao) + '</span>' +
        '<span class="li-valor vermelho">' + formatarMoeda(c.valor) + '</span>';
      listaVencer.appendChild(item);
    });
  }

  // ---- TOP CATEGORIAS ----
  const listaCat = document.getElementById("lista-categorias");
  listaCat.innerHTML = "";
  if (!d.topCategorias || d.topCategorias.length === 0) {
    listaCat.innerHTML = '<p class="vazio">Nenhum gasto registrado neste mês.</p>';
  } else {
    const maxCat = Math.max.apply(null, d.topCategorias.map(function (c) { return c.valor; })) || 1;
    d.topCategorias.forEach(function (c) {
      const pct = (c.valor / maxCat) * 100;
      const item = document.createElement("div");
      item.className = "cat-item";
      item.innerHTML =
        '<div class="cat-topo"><span class="cat-nome">' + escaparHtml(c.categoria) + '</span>' +
        '<span class="cat-valor">' + formatarMoeda(c.valor) + '</span></div>' +
        '<div class="cat-barra"><div class="cat-barra-preenchida" style="width:' + pct + '%"></div></div>';
      listaCat.appendChild(item);
    });
  }

  // ---- FATURAS DE CARTÃO ----
  const listaCartoes = document.getElementById("lista-cartoes");
  listaCartoes.innerHTML = "";
  if (!d.faturasCartao || d.faturasCartao.length === 0) {
    listaCartoes.innerHTML = '<p class="vazio">Nenhum cartão configurado.</p>';
  } else {
    d.faturasCartao.forEach(function (c) {
      const item = document.createElement("div");
      item.className = "cartao-item";
      item.innerHTML =
        '<div class="cartao-nome">💳 ' + escaparHtml(c.nome) +
          '<span class="cartao-venc">vence ' + escaparHtml(c.vencAtual) + '</span></div>' +
        '<div class="cartao-valores">' +
          '<div><span class="cv-label">Aberta &middot; ' + escaparHtml(c.mesAtual) + '</span>' +
          '<span class="cv-num">' + formatarMoeda(c.atual) + '</span></div>' +
          '<div><span class="cv-label">Seguinte &middot; ' + escaparHtml(c.mesProxima) + '</span>' +
          '<span class="cv-num cinza">' + formatarMoeda(c.proxima) + '</span></div>' +
        '</div>';
      listaCartoes.appendChild(item);
    });
  }

  // ---- OUTRAS DESPESAS (não-cartão) ----
  const listaOutros = document.getElementById("lista-outros");
  listaOutros.innerHTML = "";
  if (!d.outrosMetodos || d.outrosMetodos.length === 0) {
    listaOutros.innerHTML = '<p class="vazio">Nenhuma despesa fora do cartão neste mês.</p>';
  } else {
    let totalOutros = 0;
    d.outrosMetodos.forEach(function (m) { totalOutros += m.total; });

    d.outrosMetodos.forEach(function (m) {
      const item = document.createElement("div");
      item.className = "outro-item";
      let statusTxt = "";
      if (m.pendente > 0 && m.pago > 0) {
        statusTxt = '<span class="om-status">✅ ' + formatarMoeda(m.pago) + ' &middot; ⏳ ' + formatarMoeda(m.pendente) + '</span>';
      } else if (m.pendente > 0) {
        statusTxt = '<span class="om-status pend">⏳ pendente</span>';
      } else {
        statusTxt = '<span class="om-status pago">✅ pago</span>';
      }
      item.innerHTML =
        '<div class="om-topo"><span class="om-nome">' + escaparHtml(m.metodo) + '</span>' +
        '<span class="om-valor">' + formatarMoeda(m.total) + '</span></div>' + statusTxt;
      listaOutros.appendChild(item);
    });

    const tot = document.createElement("div");
    tot.className = "outro-total";
    tot.innerHTML = '<span>Total fora do cartão</span><span>' + formatarMoeda(totalOutros) + '</span>';
    listaOutros.appendChild(tot);
  }
}

// ============================================================================
// TELAS
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

function mostrarTelaInterna() {
  document.getElementById("tela-carregando").style.display = "none";
  document.getElementById("tela-login").style.display = "none";
  document.getElementById("tela-interna").style.display = "block";
}

function sair() {
  tokenLoginAtual = null;
  emailUsuarioAtual = null;
  google.accounts.id.disableAutoSelect();
  mostrarTelaLogin();
  document.getElementById("login-erro").style.display = "none";
}

// ============================================================================
// INICIALIZAÇÃO + LOGIN SILENCIOSO
// ============================================================================
window.addEventListener("load", function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(function () {});
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: aoReceberLoginGoogle,
    auto_select: true,
    cancel_on_tap_outside: false
  });

  google.accounts.id.renderButton(
    document.getElementById("botao-google"),
    { theme: "outline", size: "large", width: 260, text: "signin_with", locale: "pt-BR" }
  );

  mostrarTelaLogin();
  google.accounts.id.prompt();
});
