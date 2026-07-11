// ============================================================================
// SMARTBALANÇO - LÓGICA DO APP
// ============================================================================

const API_URL = "https://script.google.com/macros/s/AKfycbwGBnFvY9FtaNm2AF4gBkgbNf21iYYyyAFIAjqtAlprGXyqaZKZyIidNrzR5UNvhiNA/exec";
const GOOGLE_CLIENT_ID = "964045201445-qc96mfjmeghvaknoegpgm5m4esk6ij4g.apps.googleusercontent.com";

let tokenLoginAtual = null;      // token do Google (só no 1º login)
let emailUsuarioAtual = null;
let sessaoAtual = null;          // código de sessão de 30 dias

// ============================================================================
// SESSÃO DE 30 DIAS + BLOQUEIO POR BIOMETRIA/PIN
// ============================================================================
const CHAVE_SESSAO   = "sb_sessao";
const CHAVE_EMAIL    = "sb_email";
const CHAVE_PIN      = "sb_pin";           // hash do PIN (nunca o PIN em si)
const CHAVE_BIOMETRIA = "sb_biometria";    // credencial biométrica cadastrada
const MINUTOS_BLOQUEIO = 5;                // pede desbloqueio se ficou 5+ min fora

let momentoQueSaiu = null;   // quando o app foi para segundo plano
let appBloqueado = false;

// ---- Guarda/lê a sessão no aparelho ----
function salvarSessao(codigo, email) {
  try {
    localStorage.setItem(CHAVE_SESSAO, codigo);
    localStorage.setItem(CHAVE_EMAIL, email);
  } catch (e) {}
}

function lerSessaoSalva() {
  try {
    return {
      sessao: localStorage.getItem(CHAVE_SESSAO),
      email: localStorage.getItem(CHAVE_EMAIL)
    };
  } catch (e) { return { sessao: null, email: null }; }
}

function apagarSessao() {
  try {
    localStorage.removeItem(CHAVE_SESSAO);
    localStorage.removeItem(CHAVE_EMAIL);
  } catch (e) {}
}

// Mês/ano atualmente em exibição (navegável)
let mesExibido = new Date().getMonth();
let anoExibido = new Date().getFullYear();

// Estado do modal de liquidação
let lancamentoAtual = null;   // dados da linha sendo liquidada
let listasValidas = null;     // categorias e métodos (carregado 1x)

// ============================================================================
// CACHE LOCAL (guarda os dados do dashboard no aparelho)
// Permite mostrar a tela instantaneamente ao abrir, enquanto busca os novos.
// Guarda só dados do dashboard (saldos, contas). Nunca token ou senha.
// ============================================================================
const CACHE_PREFIXO = "sb_dash_";

function chaveCache(mes, ano) {
  return CACHE_PREFIXO + ano + "_" + mes;
}

function salvarCache(mes, ano, dados) {
  try {
    const pacote = { quando: Date.now(), dados: dados };
    localStorage.setItem(chaveCache(mes, ano), JSON.stringify(pacote));
  } catch (e) {
    // Se o armazenamento estiver cheio ou bloqueado, apenas ignora.
  }
}

function lerCache(mes, ano) {
  try {
    const bruto = localStorage.getItem(chaveCache(mes, ano));
    if (!bruto) return null;
    const pacote = JSON.parse(bruto);
    return pacote && pacote.dados ? pacote : null;
  } catch (e) {
    return null;
  }
}

function tempoRelativo(timestamp) {
  const seg = Math.floor((Date.now() - timestamp) / 1000);
  if (seg < 60) return "agora há pouco";
  const min = Math.floor(seg / 60);
  if (min < 60) return "há " + min + " min";
  const h = Math.floor(min / 60);
  if (h < 24) return "há " + h + "h";
  const dias = Math.floor(h / 24);
  return "há " + dias + (dias === 1 ? " dia" : " dias");
}

function mostrarAvisoAtualizando(textoOuNull) {
  const el = document.getElementById("aviso-cache");
  if (!el) return;
  if (textoOuNull) {
    el.textContent = textoOuNull;
    el.style.display = "block";
  } else {
    el.style.display = "none";
  }
}

// ============================================================================
// LOGIN
// ============================================================================
async function aoReceberLoginGoogle(resposta) {
  tokenLoginAtual = resposta.credential;
  try {
    const payload = JSON.parse(atob(tokenLoginAtual.split(".")[1]));
    emailUsuarioAtual = payload.email;
  } catch (e) {
    emailUsuarioAtual = "(desconhecido)";
  }

  mostrarCarregando("Entrando...");

  // Troca o token do Google por uma sessão de 30 dias
  try {
    const r = await chamarServidor("login", { dispositivo: navigator.userAgent || "" });
    if (r.ok && r.sessao) {
      sessaoAtual = r.sessao;
      emailUsuarioAtual = r.usuario || emailUsuarioAtual;
      salvarSessao(r.sessao, emailUsuarioAtual);
      tokenLoginAtual = null;   // não precisa mais do token do Google

      // Primeira vez? Oferece cadastrar biometria/PIN
      if (!temDesbloqueioConfigurado()) {
        mostrarTelaConfigurarBloqueio();
        return;
      }

      entrarNoApp();
    } else {
      mostrarErroLogin(r.mensagem || "Não foi possível criar a sessão.");
    }
  } catch (e) {
    mostrarErroLogin("Sem conexão com o servidor.");
  }
}

// ============================================================================
// SERVIDOR
// ============================================================================
async function chamarServidor(acao, paramsExtras) {
  paramsExtras = paramsExtras || {};

  // Prioridade: sessão de 30 dias. Token do Google só no 1º login.
  const base = { acao: acao };
  if (sessaoAtual) base.sessao = sessaoAtual;
  else if (tokenLoginAtual) base.token = tokenLoginAtual;

  const params = new URLSearchParams(Object.assign(base, paramsExtras));
  const url = API_URL + "?" + params.toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Falha na conexão (HTTP " + resp.status + ").");
  return await resp.json();
}

// ============================================================================
// ENTRADA / CARGA DO DASHBOARD
// ============================================================================
let entrando = false;   // trava contra chamadas simultâneas ao servidor

async function entrarNoApp() {
  if (entrando) return;
  entrando = true;

  try {
    await executarEntradaNoApp();
  } finally {
    entrando = false;
  }
}

async function executarEntradaNoApp() {
  // 1. Se houver cache deste mês, mostra IMEDIATAMENTE (sem esperar o servidor)
  const cache = lerCache(mesExibido, anoExibido);
  if (cache) {
    preencherDashboard(cache.dados);
    mostrarTelaInterna();
    mostrarAvisoAtualizando("Dados de " + tempoRelativo(cache.quando) + " · atualizando...");
  } else {
    mostrarCarregando("Carregando seus dados...");
  }

  // 2. Checa aprovações pendentes em segundo plano (para mostrar o badge)
  checarPendentesAprovacao();

  // 3. Busca os dados frescos (em segundo plano se o cache já apareceu)
  try {
    const r = await chamarServidor("dashboard", { mes: mesExibido, ano: anoExibido });
    if (r.ok) {
      salvarCache(mesExibido, anoExibido, r);
      preencherDashboard(r);
      mostrarTelaInterna();
      mostrarAvisoAtualizando(null);

      // Avisa sobre contas vencendo (só no mês corrente)
      const hj = new Date();
      if (mesExibido === hj.getMonth() && anoExibido === hj.getFullYear()) {
        verificarContasEVNotificar(r).catch(function () {});
      }
    } else if (r.erro === "NAO_AUTORIZADO") {
      mostrarErroLogin(r.mensagem || "Acesso negado. Este e-mail não está autorizado.");
    } else if (!cache) {
      mostrarErroLogin(r.mensagem || "Não foi possível carregar os dados.");
    } else {
      mostrarAvisoAtualizando("⚠️ Não foi possível atualizar. Mostrando dados salvos.");
    }
  } catch (e) {
    if (!cache) {
      mostrarErroLogin("Sem conexão com o servidor. Verifique a internet.");
    } else {
      mostrarAvisoAtualizando("⚠️ Sem conexão. Mostrando dados salvos " + tempoRelativo(cache.quando) + ".");
    }
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

  // Se houver cache do mês pedido, mostra na hora enquanto busca o novo
  const cache = lerCache(mesExibido, anoExibido);
  if (cache) {
    preencherDashboard(cache.dados);
    mostrarAvisoAtualizando("Dados de " + tempoRelativo(cache.quando) + " · atualizando...");
    document.getElementById("conteudo-dash").style.opacity = "1";
  } else {
    document.getElementById("conteudo-dash").style.opacity = "0.4";
  }

  try {
    const r = await chamarServidor("dashboard", { mes: mesExibido, ano: anoExibido });
    if (r.ok) {
      salvarCache(mesExibido, anoExibido, r);
      preencherDashboard(r);
      mostrarAvisoAtualizando(null);

      const hj = new Date();
      if (mesExibido === hj.getMonth() && anoExibido === hj.getFullYear()) {
        verificarContasEVNotificar(r).catch(function () {});
      } else {
        esconderAvisoVencimento();
      }
    } else {
      mostrarAvisoAtualizando("⚠️ Não foi possível atualizar.");
    }
  } catch (e) {
    mostrarAvisoAtualizando(cache ? "⚠️ Sem conexão. Mostrando dados salvos." : "⚠️ Sem conexão.");
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
        '<div class="li-esq">' +
          '<div><b class="li-data">' + c.data + '</b> ' + escaparHtml(c.descricao) + '</div>' +
          '<div class="li-mov">MOV-' + c.numMov + '</div>' +
        '</div>' +
        '<div class="li-dir">' +
          '<span class="li-valor vermelho">' + formatarMoeda(c.valor) + '</span>' +
          '<button class="btn-liquidar" onclick="abrirLiquidacao(' + c.numMov + ')">Liquidar</button>' +
        '</div>';
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
  const b = document.getElementById("btn-nova-despesa");
  if (b) b.style.display = "none";
}

function mostrarTelaLogin() {
  document.getElementById("tela-carregando").style.display = "none";
  document.getElementById("tela-interna").style.display = "none";
  document.getElementById("tela-login").style.display = "flex";
  const b = document.getElementById("btn-nova-despesa");
  if (b) b.style.display = "none";
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
  document.getElementById("tela-config-bloqueio").style.display = "none";
  document.getElementById("tela-interna").style.display = "block";
  document.getElementById("btn-nova-despesa").style.display = (abaAtiva === "dashboard") ? "flex" : "none";
}

async function sair() {
  if (!confirm("Sair do Smartbalanço?\n\nVocê precisará fazer login com o Google novamente.")) return;

  try { await chamarServidor("logout"); } catch (e) {}

  sessaoAtual = null;
  tokenLoginAtual = null;
  emailUsuarioAtual = null;
  apagarSessao();
  apagarDesbloqueio();

  try { google.accounts.id.disableAutoSelect(); } catch (e) {}

  mostrarTelaLogin();
  document.getElementById("login-erro").style.display = "none";
}

// ============================================================================
// INICIALIZAÇÃO + LOGIN SILENCIOSO
// ============================================================================
window.addEventListener("load", async function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(function () {});
  }

  // Detecta quando o app sai/volta (para bloqueio e atualização automática)
  configurarDeteccaoRetorno();

  // ---------- 1. Já tem sessão salva no aparelho? ----------
  const salva = lerSessaoSalva();

  if (salva.sessao) {
    sessaoAtual = salva.sessao;
    emailUsuarioAtual = salva.email;

    mostrarCarregando("Entrando...");

    // Se tem bloqueio configurado, pede a digital/PIN antes de mostrar os dados.
    // NÃO valida a sessão aqui: causaria duas chamadas simultâneas ao servidor
    // (o Apps Script serializa execuções e uma travaria a outra).
    // A validação acontece naturalmente no entrarNoApp(), após o desbloqueio.
    if (temDesbloqueioConfigurado()) {
      bloquearApp();
      return;
    }

    // Sem bloqueio: entra direto
    const valida = await validarSessaoSalva();
    if (valida) return;   // entrarNoApp() já foi chamado dentro
  }

  // ---------- 2. Sem sessão: mostra o login do Google ----------
  prepararLoginGoogle();
});

// Confere se a sessão salva ainda é válida no servidor
async function validarSessaoSalva() {
  try {
    const r = await chamarServidor("login");
    if (r.ok) {
      emailUsuarioAtual = r.usuario || emailUsuarioAtual;
      if (!appBloqueado) entrarNoApp();
      return true;
    }
    // Sessão expirou (mais de 30 dias sem usar)
    apagarSessao();
    sessaoAtual = null;
    document.getElementById("tela-bloqueio").style.display = "none";
    appBloqueado = false;
    prepararLoginGoogle();
    mostrarErroLogin("Sua sessão expirou. Faça login novamente.");
    return false;

  } catch (e) {
    // Sem internet: se tiver cache, mostra os dados salvos
    if (!appBloqueado) {
      const cache = lerCache(mesExibido, anoExibido);
      if (cache) {
        preencherDashboard(cache.dados);
        mostrarTelaInterna();
        mostrarAvisoAtualizando("⚠️ Sem conexão. Mostrando dados salvos " + tempoRelativo(cache.quando) + ".");
      } else {
        mostrarErroLogin("Sem conexão com o servidor.");
      }
    }
    return true;
  }
}

// Prepara o botão de login do Google
function prepararLoginGoogle() {
  try {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: aoReceberLoginGoogle,
      auto_select: false,
      cancel_on_tap_outside: true
    });

    google.accounts.id.renderButton(
      document.getElementById("botao-google"),
      { theme: "outline", size: "large", width: 260, text: "signin_with", locale: "pt-BR" }
    );
  } catch (e) {
    console.warn("Google Sign-In não carregou:", e);
  }

  mostrarTelaLogin();
}

// ============================================================================
// ===================== MODAL DE LIQUIDAÇÃO ==================================
// ============================================================================

// Abre o modal e carrega os dados do lançamento
async function abrirLiquidacao(numMov) {
  const modal = document.getElementById("modal-liquidar");
  modal.style.display = "flex";
  document.getElementById("modal-corpo").style.display = "none";
  document.getElementById("modal-carregando").style.display = "block";
  document.getElementById("modal-erro").style.display = "none";
  document.getElementById("modal-confirmacao").style.display = "none";

  try {
    // Carrega o lançamento
    const r = await chamarServidor("buscarLancamento", { numMov: numMov });
    if (!r.ok) {
      mostrarErroModal(r.mensagem || "Não foi possível carregar o lançamento.");
      return;
    }
    lancamentoAtual = r.lancamento;

    // Carrega listas de categoria/método (só na primeira vez)
    if (!listasValidas) {
      try {
        const rl = await chamarServidor("listasValidas");
        if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
      } catch (e) {
        listasValidas = { categorias: [], metodos: [] };
      }
    }

    preencherModal(lancamentoAtual);
    document.getElementById("modal-carregando").style.display = "none";
    document.getElementById("modal-corpo").style.display = "block";

  } catch (e) {
    mostrarErroModal("Erro de conexão. Tente novamente.");
  }
}

function preencherModal(l) {
  // Cabeçalho: Nº Mov em destaque
  document.getElementById("modal-nummov").textContent = "MOV-" + l.numMov;

  // Resumo (modo leitura)
  document.getElementById("rd-descricao").textContent = l.descricao;
  document.getElementById("rd-valor").textContent = formatarMoeda(l.valorParcela);
  document.getElementById("rd-vencimento").textContent = formatarDataBr(l.vencimento);
  document.getElementById("rd-metodo").textContent = l.metodo || "-";
  document.getElementById("rd-categoria").textContent = l.categoria || "-";
  const parcTxt = (l.totalParcelas && parseInt(l.totalParcelas) > 1)
    ? l.numParcela + "/" + l.totalParcelas : "À vista";
  document.getElementById("rd-parcela").textContent = parcTxt;

  // Data de pagamento: por padrão, hoje
  const hoje = new Date();
  const hojeStr = hoje.getFullYear() + "-" +
    ("0" + (hoje.getMonth() + 1)).slice(-2) + "-" +
    ("0" + hoje.getDate()).slice(-2);
  document.getElementById("in-datapgto").value = hojeStr;

  // Campos de edição (escondidos por padrão)
  document.getElementById("ed-descricao").value = l.descricao;
  document.getElementById("ed-valor").value = l.valorParcela.toFixed(2);
  document.getElementById("ed-vencimento").value = l.vencimento;

  // Menus
  montarSelect("ed-metodo", listasValidas ? listasValidas.metodos : [], l.metodo);
  definirCategoriaCampo("ed-categoria", l.categoria);

  // Reseta o toggle de edição
  document.getElementById("chk-editar").checked = false;
  document.getElementById("area-edicao").style.display = "none";
}

function montarSelect(id, lista, valorAtual) {
  const sel = document.getElementById(id);
  sel.innerHTML = "";
  let achou = false;

  (lista || []).forEach(function (v) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    if (v === valorAtual) { opt.selected = true; achou = true; }
    sel.appendChild(opt);
  });

  // Se o valor atual não está na lista, adiciona como opção (para não perder o dado)
  if (!achou && valorAtual) {
    const opt = document.createElement("option");
    opt.value = valorAtual;
    opt.textContent = valorAtual + " (atual)";
    opt.selected = true;
    sel.insertBefore(opt, sel.firstChild);
  }
}

function formatarDataBr(iso) {
  if (!iso) return "-";
  const p = iso.split("-");
  if (p.length !== 3) return iso;
  return p[2] + "/" + p[1] + "/" + p[0];
}

function alternarEdicao() {
  const marcado = document.getElementById("chk-editar").checked;
  document.getElementById("area-edicao").style.display = marcado ? "block" : "none";
  document.getElementById("area-leitura").style.display = marcado ? "none" : "block";
}

function fecharModal() {
  document.getElementById("modal-liquidar").style.display = "none";
  lancamentoAtual = null;
}

function mostrarErroModal(msg) {
  document.getElementById("modal-carregando").style.display = "none";
  document.getElementById("modal-corpo").style.display = "none";
  document.getElementById("modal-confirmacao").style.display = "none";
  const el = document.getElementById("modal-erro");
  el.textContent = msg;
  el.style.display = "block";
}

// ---------- Etapa de confirmação ----------
function pedirConfirmacao() {
  const dataPgto = document.getElementById("in-datapgto").value;
  if (!dataPgto) {
    alert("Escolha a data de pagamento.");
    return;
  }

  const editando = document.getElementById("chk-editar").checked;
  const l = lancamentoAtual;

  // Monta o resumo do que será gravado
  let resumo = '<div class="conf-linha"><span>Nº Movimentação</span><b>MOV-' + l.numMov + '</b></div>';
  resumo += '<div class="conf-linha"><span>Data de pagamento</span><b class="verde">' + formatarDataBr(dataPgto) + '</b></div>';

  if (editando) {
    const novaDesc = document.getElementById("ed-descricao").value;
    const novoValor = document.getElementById("ed-valor").value;
    const novoVenc = document.getElementById("ed-vencimento").value;
    const novoMet = document.getElementById("ed-metodo").value;
    const novaCat = document.getElementById("ed-categoria").value;

    let mudou = false;
    if (novaDesc !== l.descricao) {
      resumo += '<div class="conf-linha alterado"><span>Descrição</span><b>' + escaparHtml(novaDesc) + '</b></div>';
      mudou = true;
    }
    if (parseFloat(novoValor) !== l.valorParcela) {
      resumo += '<div class="conf-linha alterado"><span>Valor</span><b>' + formatarMoeda(parseFloat(novoValor)) + '</b></div>';
      mudou = true;
    }
    if (novoVenc !== l.vencimento) {
      resumo += '<div class="conf-linha alterado"><span>Vencimento</span><b>' + formatarDataBr(novoVenc) + '</b></div>';
      mudou = true;
    }
    if (novoMet !== l.metodo) {
      resumo += '<div class="conf-linha alterado"><span>Método</span><b>' + escaparHtml(novoMet) + '</b></div>';
      mudou = true;
    }
    if (novaCat !== l.categoria) {
      resumo += '<div class="conf-linha alterado"><span>Categoria</span><b>' + escaparHtml(novaCat) + '</b></div>';
      mudou = true;
    }
    if (!mudou) {
      resumo += '<div class="conf-nota">Nenhum campo foi alterado.</div>';
    }
  } else {
    resumo += '<div class="conf-linha"><span>Descrição</span><b>' + escaparHtml(l.descricao) + '</b></div>';
    resumo += '<div class="conf-linha"><span>Valor</span><b>' + formatarMoeda(l.valorParcela) + '</b></div>';
  }

  document.getElementById("conf-resumo").innerHTML = resumo;
  document.getElementById("modal-corpo").style.display = "none";
  document.getElementById("modal-confirmacao").style.display = "block";
}

function voltarDaConfirmacao() {
  document.getElementById("modal-confirmacao").style.display = "none";
  document.getElementById("modal-corpo").style.display = "block";
}

// ---------- Grava de fato ----------
function confirmarLiquidacao() {
  const l = lancamentoAtual;
  const editando = document.getElementById("chk-editar").checked;

  const params = {
    numMov: l.numMov,
    dataPagamento: document.getElementById("in-datapgto").value
  };

  if (editando) {
    params.descricao = document.getElementById("ed-descricao").value;
    params.valorParcela = document.getElementById("ed-valor").value;
    params.vencimento = document.getElementById("ed-vencimento").value;
    params.metodo = document.getElementById("ed-metodo").value;
    params.categoria = document.getElementById("ed-categoria").value;
  }

  // 👉 FECHA O MODAL NA HORA (não trava o usuário esperando)
  const numMov = l.numMov;
  fecharModal();

  // Some a linha da lista imediatamente (feedback visual instantâneo)
  removerLinhaDaLista(numMov);

  // Toast de progresso, fica visível até terminar
  mostrarToast("⏳ Liquidando MOV-" + numMov + "...", true);

  // Envia em segundo plano
  enviarLiquidacao(params, numMov);
}

// Faz o envio de verdade, sem travar a tela
async function enviarLiquidacao(params, numMov) {
  try {
    const r = await chamarServidor("liquidar", params);
    if (r.ok) {
      mostrarToast("✅ MOV-" + numMov + " liquidado! Comprovante enviado por e-mail.");
      await recarregarDados();
    } else {
      mostrarToast("❌ MOV-" + numMov + ": " + (r.mensagem || "não foi possível liquidar."));
      await recarregarDados(); // traz a linha de volta se falhou
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. MOV-" + numMov + " NÃO foi liquidado.");
    await recarregarDados();
  }
}

// Remove visualmente a linha da lista (some na hora, antes do servidor responder)
function removerLinhaDaLista(numMov) {
  const btn = document.querySelector('.btn-liquidar[onclick="abrirLiquidacao(' + numMov + ')"]');
  if (!btn) return;
  const linha = btn.closest(".linha-item");
  if (!linha) return;
  linha.style.transition = "opacity 0.3s, transform 0.3s";
  linha.style.opacity = "0";
  linha.style.transform = "translateX(30px)";
  setTimeout(function () {
    if (linha.parentNode) linha.parentNode.removeChild(linha);
  }, 300);
}

// ---------- Aviso flutuante ----------
let toastTimer = null;

function mostrarToast(msg, fixo) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("visivel");

  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

  // Se "fixo", não some sozinho (fica até a próxima mensagem substituir)
  if (!fixo) {
    toastTimer = setTimeout(function () { t.classList.remove("visivel"); }, 5000);
  }
}


// ============================================================================
// ===================== INCLUSÃO DE DESPESA MANUAL ===========================
// ============================================================================

async function abrirNovaDespesa() {
  const modal = document.getElementById("modal-despesa");
  modal.style.display = "flex";
  document.getElementById("nd-erro").style.display = "none";
  document.getElementById("nd-form").style.display = "block";
  document.getElementById("nd-confirmacao").style.display = "none";

  // Carrega listas (categoria/método) se ainda não tiver
  if (!listasValidas) {
    document.getElementById("nd-form").style.opacity = "0.5";
    try {
      const rl = await chamarServidor("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) {
      listasValidas = { categorias: [], metodos: [] };
    }
    document.getElementById("nd-form").style.opacity = "1";
  }

  // Preenche os campos
  montarSelect("nd-metodo", listasValidas ? listasValidas.metodos : [], "");
  definirCategoriaCampo("nd-categoria", "");

  // Limpa/reseta os campos
  const hoje = dataHojeISO();
  document.getElementById("nd-descricao").value = "";
  document.getElementById("nd-valor").value = "";
  document.getElementById("nd-datacompra").value = hoje;
  document.getElementById("nd-parcelas").value = "1";
  document.getElementById("nd-vencimento").value = hoje;
  document.getElementById("nd-chk-pago").checked = false;
  document.getElementById("nd-datapgto").value = hoje;

  atualizarCamposDespesa();
}

function dataHojeISO() {
  const h = new Date();
  return h.getFullYear() + "-" + ("0" + (h.getMonth() + 1)).slice(-2) + "-" + ("0" + h.getDate()).slice(-2);
}

function fecharModalDespesa() {
  document.getElementById("modal-despesa").style.display = "none";
}

// Mostra/esconde campos conforme as escolhas
function atualizarCamposDespesa() {
  const metodo = (document.getElementById("nd-metodo").value || "").toLowerCase();
  const ehCartao = metodo.indexOf("cartão") !== -1 || metodo.indexOf("cartao") !== -1;
  const jaPago = document.getElementById("nd-chk-pago").checked;

  // Vencimento: some se for cartão (é calculado automaticamente)
  document.getElementById("nd-bloco-vencimento").style.display = ehCartao ? "none" : "block";
  document.getElementById("nd-aviso-cartao").style.display = ehCartao ? "block" : "none";

  // Data de pagamento: aparece só se marcado como pago
  document.getElementById("nd-bloco-datapgto").style.display = jaPago ? "block" : "none";

  // Mostra o valor da parcela em tempo real
  atualizarPreviaParcela();
}

function atualizarPreviaParcela() {
  const valor = parseFloat(document.getElementById("nd-valor").value) || 0;
  const parc = parseInt(document.getElementById("nd-parcelas").value) || 1;
  const el = document.getElementById("nd-previa");

  if (valor > 0 && parc > 1) {
    el.textContent = parc + "x de " + formatarMoeda(valor / parc);
    el.style.display = "block";
  } else if (valor > 0) {
    el.textContent = "À vista: " + formatarMoeda(valor);
    el.style.display = "block";
  } else {
    el.style.display = "none";
  }
}

// ---------- Confirmação ----------
function confirmarNovaDespesa() {
  const desc = document.getElementById("nd-descricao").value.trim();
  const valor = parseFloat(document.getElementById("nd-valor").value);
  const dataCompra = document.getElementById("nd-datacompra").value;
  const parcelas = parseInt(document.getElementById("nd-parcelas").value) || 1;
  const metodo = document.getElementById("nd-metodo").value;
  const categoria = document.getElementById("nd-categoria").value;
  const jaPago = document.getElementById("nd-chk-pago").checked;

  // Validações
  if (!desc) return mostrarErroDespesa("Informe a descrição.");
  if (!valor || valor <= 0) return mostrarErroDespesa("Informe um valor maior que zero.");
  if (!dataCompra) return mostrarErroDespesa("Informe a data da compra.");
  if (!metodo) return mostrarErroDespesa("Escolha o método de pagamento.");
  if (!categoria) return mostrarErroDespesa("Escolha a categoria.");
  if (jaPago && !document.getElementById("nd-datapgto").value) {
    return mostrarErroDespesa("Informe a data de pagamento.");
  }

  const ehCartao = metodo.toLowerCase().indexOf("cart") !== -1;

  // Monta o resumo
  let resumo = '<div class="conf-linha"><span>Descrição</span><b>' + escaparHtml(desc) + '</b></div>';
  resumo += '<div class="conf-linha"><span>Valor total</span><b>' + formatarMoeda(valor) + '</b></div>';
  if (parcelas > 1) {
    resumo += '<div class="conf-linha"><span>Parcelas</span><b>' + parcelas + 'x de ' + formatarMoeda(valor / parcelas) + '</b></div>';
  } else {
    resumo += '<div class="conf-linha"><span>Parcelas</span><b>À vista</b></div>';
  }
  resumo += '<div class="conf-linha"><span>Data da compra</span><b>' + formatarDataBr(dataCompra) + '</b></div>';
  if (ehCartao) {
    resumo += '<div class="conf-linha"><span>Vencimento</span><b class="calc">calculado pela fatura</b></div>';
  } else {
    resumo += '<div class="conf-linha"><span>Vencimento</span><b>' + formatarDataBr(document.getElementById("nd-vencimento").value) + '</b></div>';
  }
  resumo += '<div class="conf-linha"><span>Método</span><b>' + escaparHtml(metodo) + '</b></div>';
  resumo += '<div class="conf-linha"><span>Categoria</span><b>' + escaparHtml(categoria) + '</b></div>';

  if (jaPago) {
    const dp = document.getElementById("nd-datapgto").value;
    resumo += '<div class="conf-linha alterado"><span>Status</span><b>✅ Já paga em ' + formatarDataBr(dp) + '</b></div>';
  } else {
    resumo += '<div class="conf-linha"><span>Status</span><b class="pendente">⏳ A pagar</b></div>';
  }

  if (parcelas > 1) {
    resumo += '<div class="conf-nota">Serão criadas ' + parcelas + ' linhas na planilha (uma por parcela).</div>';
  }

  document.getElementById("nd-conf-resumo").innerHTML = resumo;
  document.getElementById("nd-form").style.display = "none";
  document.getElementById("nd-confirmacao").style.display = "block";
}

function voltarDoResumoDespesa() {
  document.getElementById("nd-confirmacao").style.display = "none";
  document.getElementById("nd-form").style.display = "block";
}

function mostrarErroDespesa(msg) {
  const el = document.getElementById("nd-erro");
  el.textContent = "⚠️ " + msg;
  el.style.display = "block";
  setTimeout(function () { el.style.display = "none"; }, 4000);
}

// ---------- Envio ----------
function enviarNovaDespesa() {
  const desc = document.getElementById("nd-descricao").value.trim();
  const jaPago = document.getElementById("nd-chk-pago").checked;

  const params = {
    descricao: desc,
    valorTotal: document.getElementById("nd-valor").value,
    dataCompra: document.getElementById("nd-datacompra").value,
    totalParcelas: document.getElementById("nd-parcelas").value,
    metodo: document.getElementById("nd-metodo").value,
    categoria: document.getElementById("nd-categoria").value,
    vencimento: document.getElementById("nd-vencimento").value,
    jaPago: jaPago ? "true" : "false"
  };

  if (jaPago) params.dataPagamento = document.getElementById("nd-datapgto").value;

  // Fecha na hora e envia em segundo plano
  fecharModalDespesa();
  mostrarToast("⏳ Lançando \"" + desc + "\"...", true);

  gravarNovaDespesa(params, desc);
}

async function gravarNovaDespesa(params, desc) {
  try {
    const r = await chamarServidor("incluirDespesa", params);
    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      await recarregarDados();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não foi possível lançar a despesa."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. \"" + desc + "\" NÃO foi lançada.");
  }
}


// ============================================================================
// ===================== APROVAÇÕES ===========================================
// ============================================================================

let abaAtiva = "dashboard";        // "dashboard", "aprovacoes" ou "relatorios"
let gruposAprovacao = [];          // cache dos grupos carregados
let grupoEditando = null;          // grupo aberto no modal
let aprovacoesPreCarregadas = false;  // já buscamos as aprovações em 2º plano?

// ---------- Troca de aba ----------
function trocarAba(nome) {
  abaAtiva = nome;

  document.getElementById("conteudo-dash").style.display  = (nome === "dashboard")  ? "block" : "none";
  document.getElementById("conteudo-aprov").style.display = (nome === "aprovacoes") ? "block" : "none";
  document.getElementById("conteudo-rel").style.display   = (nome === "relatorios") ? "block" : "none";
  document.getElementById("nav-mes-wrap").style.display   = (nome === "dashboard")  ? "flex"  : "none";

  document.getElementById("tab-dashboard").classList.toggle("ativa", nome === "dashboard");
  document.getElementById("tab-aprovacoes").classList.toggle("ativa", nome === "aprovacoes");
  document.getElementById("tab-relatorios").classList.toggle("ativa", nome === "relatorios");

  // Botão (+) só faz sentido no dashboard
  document.getElementById("btn-nova-despesa").style.display = (nome === "dashboard") ? "flex" : "none";

  if (nome === "aprovacoes") carregarAprovacoes(false);
  if (nome === "relatorios") renderizarTelaRelatorios();
}

// ---------- Carrega a lista ----------
async function carregarAprovacoes(forcar) {
  const lista = document.getElementById("lista-aprovacoes");

  // 👉 Se já temos os dados pré-carregados, mostra IMEDIATAMENTE.
  if (aprovacoesPreCarregadas && !forcar) {
    renderizarAprovacoes();
  } else {
    lista.innerHTML = '<p class="vazio">Carregando...</p>';
  }

  try {
    const r = await chamarServidor("listarAprovacoes");
    if (!r.ok) {
      if (!aprovacoesPreCarregadas) {
        lista.innerHTML = '<p class="vazio">⚠️ ' + escaparHtml(r.mensagem || "Erro ao carregar.") + '</p>';
      }
      return;
    }
    gruposAprovacao = r.grupos || [];
    aprovacoesPreCarregadas = true;
    renderizarAprovacoes();
  } catch (e) {
    if (!aprovacoesPreCarregadas) {
      lista.innerHTML = '<p class="vazio">⚠️ Sem conexão.</p>';
    }
  }
}

function renderizarAprovacoes() {
  const lista = document.getElementById("lista-aprovacoes");
  lista.innerHTML = "";

  atualizarBadgeAprovacoes(gruposAprovacao.length);

  if (gruposAprovacao.length === 0) {
    lista.innerHTML =
      '<div class="card" style="text-align:center; padding:36px 20px;">' +
        '<div style="font-size:40px; margin-bottom:10px;">✅</div>' +
        '<p style="font-size:15px; color:#334155; font-weight:600;">Nada pendente!</p>' +
        '<p style="font-size:13px; color:#94a3b8; margin-top:4px;">Não há lançamentos aguardando aprovação.</p>' +
      '</div>';
    return;
  }

  gruposAprovacao.forEach(function (g, idx) {
    const faixa = (g.movInicial === g.movFinal)
      ? "MOV-" + g.movInicial
      : "MOV-" + g.movInicial + " a " + g.movFinal;

    const parcTxt = (g.totalParcelas > 1)
      ? g.totalParcelas + "x de " + formatarMoeda(g.valorParcela)
      : "À vista";

    const card = document.createElement("div");
    card.className = "card card-aprov";
    card.innerHTML =
      '<div class="ap-topo">' +
        '<div class="ap-desc">' + escaparHtml(g.descricao) + '</div>' +
        '<div class="ap-mov">' + faixa + '</div>' +
      '</div>' +

      '<div class="ap-valor">' + formatarMoeda(g.valorTotal) +
        '<span class="ap-parc">' + parcTxt + '</span>' +
      '</div>' +

      '<div class="ap-infos">' +
        '<div><span>Vencimento</span><b>' + formatarDataBr(g.primeiroVenc) + '</b></div>' +
        '<div><span>Método</span><b>' + escaparHtml(g.metodo || "-") + '</b></div>' +
      '</div>' +
      '<div class="ap-cat">' + escaparHtml(g.categoria || "sem categoria") + '</div>' +

      '<div class="ap-acoes">' +
        '<button class="ap-btn rejeitar" onclick="confirmarRejeicao(' + idx + ')">🗑️ Rejeitar</button>' +
        '<button class="ap-btn editar" onclick="abrirEdicaoAprovacao(' + idx + ')">✏️ Editar</button>' +
        '<button class="ap-btn aprovar" onclick="aprovarDireto(' + idx + ')">✅ Aprovar</button>' +
      '</div>';

    lista.appendChild(card);
  });
}

function atualizarBadgeAprovacoes(n) {
  const badge = document.getElementById("badge-aprov");
  if (!badge) return;
  if (n > 0) {
    badge.textContent = n;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

// ---------- Aprovar sem editar ----------
function aprovarDireto(idx) {
  const g = gruposAprovacao[idx];
  if (!g) return;

  const txt = (g.totalParcelas > 1)
    ? "Aprovar \"" + g.descricao + "\" (" + g.totalParcelas + " parcelas)?"
    : "Aprovar \"" + g.descricao + "\"?";

  if (!confirm(txt + "\n\nSerá enviado para a planilha de Transações.")) return;

  removerCardAprovacao(idx);
  mostrarToast("⏳ Aprovando \"" + g.descricao + "\"...", true);
  executarAprovacao({ chave: g.chave }, g.descricao);
}

// ---------- Rejeitar ----------
function confirmarRejeicao(idx) {
  const g = gruposAprovacao[idx];
  if (!g) return;

  const linhasTxt = (g.totalParcelas > 1) ? g.totalParcelas + " linhas" : "1 linha";
  if (!confirm("🗑️ REJEITAR \"" + g.descricao + "\"?\n\n" +
               linhasTxt + " serão APAGADAS da fila e NÃO irão para Transações.\n\nEsta ação não pode ser desfeita.")) return;

  removerCardAprovacao(idx);
  mostrarToast("⏳ Rejeitando...", true);
  executarRejeicao({ chave: g.chave }, g.descricao);
}

function removerCardAprovacao(idx) {
  gruposAprovacao.splice(idx, 1);
  renderizarAprovacoes();
}

async function executarAprovacao(params, desc) {
  try {
    const r = await chamarServidor("aprovarGrupo", params);
    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      limparTodoCache();
      await carregarAprovacoes();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Falha ao aprovar."));
      await carregarAprovacoes();
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. \"" + desc + "\" NÃO foi aprovado.");
    await carregarAprovacoes();
  }
}

async function executarRejeicao(params, desc) {
  try {
    const r = await chamarServidor("rejeitarGrupo", params);
    if (r.ok) {
      mostrarToast("🗑️ " + r.mensagem);
      await carregarAprovacoes();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Falha ao rejeitar."));
      await carregarAprovacoes();
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. Nada foi removido.");
    await carregarAprovacoes();
  }
}

// Limpa o cache do dashboard (os dados mudaram)
function limparTodoCache() {
  try {
    const remover = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(CACHE_PREFIXO) === 0) remover.push(k);
    }
    remover.forEach(function (k) { localStorage.removeItem(k); });
  } catch (e) {}
}

// ============================================================================
// MODAL DE EDIÇÃO DA APROVAÇÃO
// ============================================================================
async function abrirEdicaoAprovacao(idx) {
  const g = gruposAprovacao[idx];
  if (!g) return;
  grupoEditando = g;

  const modal = document.getElementById("modal-aprov");
  modal.style.display = "flex";
  document.getElementById("ea-erro").style.display = "none";

  // Carrega listas se preciso
  if (!listasValidas) {
    try {
      const rl = await chamarServidor("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) {
      listasValidas = { categorias: [], metodos: [] };
    }
  }

  const faixa = (g.movInicial === g.movFinal)
    ? "MOV-" + g.movInicial
    : "MOV-" + g.movInicial + " a " + g.movFinal;
  document.getElementById("ea-mov").textContent = faixa;

  document.getElementById("ea-descricao").value = g.descricao;
  document.getElementById("ea-valor").value = Number(g.valorTotal).toFixed(2);
  document.getElementById("ea-datacompra").value = g.dataCompra;
  document.getElementById("ea-primeirovenc").value = g.primeiroVenc;

  montarSelect("ea-metodo", listasValidas.metodos, g.metodo);
  definirCategoriaCampo("ea-categoria", g.categoria);

  // Info de parcelas (travado)
  const infoParc = document.getElementById("ea-info-parcelas");
  if (g.totalParcelas > 1) {
    infoParc.innerHTML =
      '📦 <b>' + g.totalParcelas + ' parcelas.</b> O valor total será dividido igualmente. ' +
      'As demais parcelas seguem mês a mês a partir do 1º vencimento.<br>' +
      '<span style="color:#94a3b8;">Para mudar o número de parcelas, rejeite e lance manualmente.</span>';
    infoParc.style.display = "block";
  } else {
    infoParc.style.display = "none";
  }

  atualizarPreviaAprov();
}

function atualizarPreviaAprov() {
  if (!grupoEditando) return;
  const valor = parseFloat(document.getElementById("ea-valor").value) || 0;
  const parc = grupoEditando.totalParcelas;
  const el = document.getElementById("ea-previa");

  if (valor > 0 && parc > 1) {
    el.textContent = parc + "x de " + formatarMoeda(valor / parc);
    el.style.display = "block";
  } else if (valor > 0) {
    el.textContent = "À vista: " + formatarMoeda(valor);
    el.style.display = "block";
  } else {
    el.style.display = "none";
  }
}

function fecharModalAprov() {
  document.getElementById("modal-aprov").style.display = "none";
  grupoEditando = null;
}

function salvarEAprovar() {
  const g = grupoEditando;
  if (!g) return;

  const desc = document.getElementById("ea-descricao").value.trim();
  const valor = parseFloat(document.getElementById("ea-valor").value);
  const dataCompra = document.getElementById("ea-datacompra").value;
  const primeiroVenc = document.getElementById("ea-primeirovenc").value;
  const metodo = document.getElementById("ea-metodo").value;
  const categoria = document.getElementById("ea-categoria").value;

  if (!desc) return mostrarErroAprov("Informe a descrição.");
  if (!valor || valor <= 0) return mostrarErroAprov("Valor deve ser maior que zero.");
  if (!dataCompra) return mostrarErroAprov("Informe a data da compra.");
  if (!primeiroVenc) return mostrarErroAprov("Informe o 1º vencimento.");
  if (!metodo) return mostrarErroAprov("Escolha o método.");
  if (!categoria) return mostrarErroAprov("Escolha a categoria.");

  const params = {
    chave: g.chave,
    descricao: desc,
    valorTotal: valor,
    dataCompra: dataCompra,
    primeiroVenc: primeiroVenc,
    metodo: metodo,
    categoria: categoria
  };

  const idx = gruposAprovacao.indexOf(g);
  fecharModalAprov();
  if (idx >= 0) removerCardAprovacao(idx);

  mostrarToast("⏳ Aprovando \"" + desc + "\" com as edições...", true);
  executarAprovacao(params, desc);
}

function mostrarErroAprov(msg) {
  const el = document.getElementById("ea-erro");
  el.textContent = "⚠️ " + msg;
  el.style.display = "block";
  setTimeout(function () { el.style.display = "none"; }, 4000);
}


// Pré-carrega as aprovações em segundo plano (para abrir instantâneo depois)
async function checarPendentesAprovacao() {
  try {
    const r = await chamarServidor("listarAprovacoes");
    if (r.ok) {
      gruposAprovacao = r.grupos || [];
      aprovacoesPreCarregadas = true;
      atualizarBadgeAprovacoes(gruposAprovacao.length);

      // Se a aba de aprovações já estiver aberta, atualiza a tela
      if (abaAtiva === "aprovacoes") renderizarAprovacoes();
    }
  } catch (e) {
    // silencioso
  }
}


// ============================================================================
// ===================== SELETOR DE CATEGORIA COM BUSCA =======================
// Substitui o <select> por um campo que abre uma tela de busca.
// Só aceita categorias válidas (não permite texto livre).
// ============================================================================

let seletorCatDestino = null;  // id do campo que está sendo preenchido

// Abre a tela de busca. destinoId = id do input escondido que guarda o valor.
function abrirSeletorCategoria(destinoId) {
  seletorCatDestino = destinoId;

  const modal = document.getElementById("modal-categoria");
  modal.style.display = "flex";

  const busca = document.getElementById("sc-busca");
  busca.value = "";
  renderizarListaCategorias("");

  // Foca no campo de busca (com um respiro pro teclado abrir direito)
  setTimeout(function () { busca.focus(); }, 120);
}

function fecharSeletorCategoria() {
  document.getElementById("modal-categoria").style.display = "none";
  seletorCatDestino = null;
}

// Remove acentos e deixa minúsculo (para busca tolerante)
function normalizarBusca(txt) {
  return (txt || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function filtrarCategorias() {
  renderizarListaCategorias(document.getElementById("sc-busca").value);
}

function renderizarListaCategorias(termo) {
  const lista = document.getElementById("sc-lista");
  lista.innerHTML = "";

  const todas = (listasValidas && listasValidas.categorias) ? listasValidas.categorias : [];
  const t = normalizarBusca(termo).trim();

  // Filtra por nome OU número (ex: "merc", "2.2", "2.2.001", "agua")
  const filtradas = t === ""
    ? todas
    : todas.filter(function (c) { return normalizarBusca(c).indexOf(t) !== -1; });

  if (filtradas.length === 0) {
    lista.innerHTML =
      '<div class="sc-vazio">Nenhuma categoria encontrada para "' + escaparHtml(termo) + '".<br>' +
      '<span>Só é possível escolher categorias já cadastradas.</span></div>';
    return;
  }

  // Valor atualmente escolhido (para destacar)
  const atual = seletorCatDestino ? (document.getElementById(seletorCatDestino).value || "") : "";

  filtradas.forEach(function (c) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sc-item" + (c === atual ? " atual" : "");

    // Separa o código do nome, pra destacar visualmente
    const m = c.match(/^([\d.]+)\s*\.?\s*(.*)$/);
    if (m && m[1] && m[2]) {
      item.innerHTML = '<span class="sc-cod">' + escaparHtml(m[1]) + '</span>' +
                       '<span class="sc-nome">' + escaparHtml(m[2]) + '</span>';
    } else {
      item.innerHTML = '<span class="sc-nome">' + escaparHtml(c) + '</span>';
    }

    item.onclick = function () { escolherCategoria(c); };
    lista.appendChild(item);
  });
}

// Grava a categoria escolhida no campo de destino
function escolherCategoria(categoria) {
  if (!seletorCatDestino) return;

  const hidden = document.getElementById(seletorCatDestino);
  hidden.value = categoria;

  // Atualiza o texto exibido no botão do formulário
  const visivel = document.getElementById(seletorCatDestino + "-txt");
  if (visivel) {
    visivel.textContent = categoria;
    visivel.classList.remove("vazio-cat");
  }

  fecharSeletorCategoria();
}

// Preenche o campo de categoria (usado ao abrir os modais)
function definirCategoriaCampo(destinoId, valor) {
  const hidden = document.getElementById(destinoId);
  const visivel = document.getElementById(destinoId + "-txt");
  hidden.value = valor || "";
  if (visivel) {
    if (valor) {
      visivel.textContent = valor;
      visivel.classList.remove("vazio-cat");
    } else {
      visivel.textContent = "Toque para escolher a categoria";
      visivel.classList.add("vazio-cat");
    }
  }
}


// ============================================================================
// ===================== RELATÓRIOS ===========================================
// ============================================================================

const CACHE_REL_SALVOS = "sb_rel_salvos";  // relatórios fixados offline
let relatorioAtual = null;                  // relatório exibido no momento

// Definição dos relatórios disponíveis e seus períodos
const RELATORIOS = {
  evolucao: {
    nome: "Evolução Mensal",
    icone: "📈",
    desc: "Receitas x despesas ao longo do ano",
    periodo: "ano"
  },
  comparacao: {
    nome: "Comparação entre Meses",
    icone: "⚖️",
    desc: "Compare dois meses lado a lado",
    periodo: "doisMeses"
  },
  regra503020: {
    nome: "Regra 50/30/20",
    icone: "🎯",
    desc: "Sobrevivência, estilo de vida e riqueza",
    periodo: "mes"
  },
  dre: {
    nome: "DRE do Mês",
    icone: "📋",
    desc: "Receitas e despesas detalhadas por grupo",
    periodo: "mes"
  },
  parcelamentos: {
    nome: "Parcelamentos Ativos",
    icone: "💳",
    desc: "O que ainda falta pagar e o progresso",
    periodo: "nenhum"
  },
  projecao: {
    nome: "Projeção Futura",
    icone: "🔮",
    desc: "Quanto já está comprometido nos próximos meses",
    periodo: "meses"
  },
  extrato: {
    nome: "Extrato do Mês",
    icone: "🧾",
    desc: "Todos os lançamentos do mês",
    periodo: "mes"
  },
  previsao: {
    nome: "Previsão Orçamentária",
    icone: "🧠",
    desc: "Quanto você vai gastar no mês que vem",
    periodo: "janela"
  }
};

const MESES_NOMES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                     "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

// ---------- Tela inicial de relatórios ----------
function renderizarTelaRelatorios() {
  const wrap = document.getElementById("conteudo-rel");

  const salvos = lerRelatoriosSalvos();
  let htmlSalvos = "";

  if (salvos.length > 0) {
    let itens = "";
    salvos.forEach(function (s, i) {
      itens +=
        '<div class="rel-salvo">' +
          '<button class="rs-abrir" onclick="abrirRelatorioSalvo(' + i + ')">' +
            '<span class="rs-icone">' + (RELATORIOS[s.tipo] ? RELATORIOS[s.tipo].icone : "📄") + '</span>' +
            '<span class="rs-info">' +
              '<b>' + escaparHtml(s.meta.titulo) + '</b>' +
              '<span>' + escaparHtml(s.meta.subtitulo) + ' &middot; ' + escaparHtml(s.meta.geradoEm) + '</span>' +
            '</span>' +
          '</button>' +
          '<button class="rs-excluir" onclick="excluirRelatorioSalvo(' + i + ')" title="Excluir">🗑️</button>' +
        '</div>';
    });

    htmlSalvos =
      '<div class="card">' +
        '<h2>📌 Salvos offline</h2>' +
        itens +
      '</div>';
  }

  let htmlDisponiveis = '<div class="card"><h2>Gerar relatório</h2>';
  Object.keys(RELATORIOS).forEach(function (k) {
    const r = RELATORIOS[k];
    htmlDisponiveis +=
      '<button class="rel-opcao" onclick="abrirPeriodo(\'' + k + '\')">' +
        '<span class="ro-icone">' + r.icone + '</span>' +
        '<span class="ro-info">' +
          '<b>' + r.nome + '</b>' +
          '<span>' + r.desc + '</span>' +
        '</span>' +
        '<span class="ro-seta">›</span>' +
      '</button>';
  });
  htmlDisponiveis += '</div>';

  wrap.innerHTML = htmlSalvos + htmlDisponiveis;
}

// ---------- Seletor de período ----------
let relTipoEscolhido = null;

function abrirPeriodo(tipo) {
  relTipoEscolhido = tipo;
  const r = RELATORIOS[tipo];

  document.getElementById("modal-periodo").style.display = "flex";
  document.getElementById("mp-titulo").textContent = r.icone + " " + r.nome;

  const corpo = document.getElementById("mp-corpo");
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth();

  if (r.periodo === "ano") {
    let opts = "";
    for (let a = anoAtual; a >= anoAtual - 4; a--) {
      opts += '<option value="' + a + '"' + (a === anoAtual ? ' selected' : '') + '>' + a + '</option>';
    }
    corpo.innerHTML =
      '<div class="campo-bloco">' +
        '<label for="mp-ano">Ano</label>' +
        '<select id="mp-ano">' + opts + '</select>' +
      '</div>';

  } else if (r.periodo === "mes") {
    corpo.innerHTML =
      '<div class="linha-dupla">' +
        '<div class="campo-bloco">' +
          '<label for="mp-mes">Mês</label>' +
          '<select id="mp-mes">' + opcoesMeses(mesAtual) + '</select>' +
        '</div>' +
        '<div class="campo-bloco">' +
          '<label for="mp-ano">Ano</label>' +
          '<select id="mp-ano">' + opcoesAnos(anoAtual) + '</select>' +
        '</div>' +
      '</div>';

  } else if (r.periodo === "nenhum") {
    corpo.innerHTML =
      '<p style="font-size:14px; color:var(--cinza-texto); line-height:1.6; text-align:center; padding:10px 0;">' +
        'Este relatório mostra <b>todos os parcelamentos em aberto</b> no momento.<br>' +
        'Não precisa escolher período.' +
      '</p>';

  } else if (r.periodo === "meses") {
    corpo.innerHTML =
      '<div class="campo-bloco">' +
        '<label for="mp-meses">Quantos meses à frente?</label>' +
        '<select id="mp-meses">' +
          '<option value="3">3 meses</option>' +
          '<option value="6" selected>6 meses</option>' +
          '<option value="12">12 meses</option>' +
          '<option value="18">18 meses</option>' +
          '<option value="24">24 meses</option>' +
        '</select>' +
      '</div>';

  } else if (r.periodo === "janela") {
    corpo.innerHTML =
      '<p style="font-size:13px; color:var(--cinza-texto); line-height:1.6; margin-bottom:16px;">' +
        'Quanto maior a janela, mais dados o sistema usa para entender o padrão de cada categoria. ' +
        'Janelas curtas reagem mais rápido a mudanças recentes.' +
      '</p>' +
      '<div class="campo-bloco">' +
        '<label for="mp-meses">Analisar os últimos:</label>' +
        '<select id="mp-meses">' +
          '<option value="3">3 meses (mais reativo)</option>' +
          '<option value="6" selected>6 meses (equilibrado)</option>' +
          '<option value="12">12 meses (1 ano)</option>' +
          '<option value="24">24 meses (2 anos)</option>' +
        '</select>' +
      '</div>';

  } else if (r.periodo === "doisMeses") {
    let mesB = mesAtual - 1, anoB = anoAtual;
    if (mesB < 0) { mesB = 11; anoB--; }

    corpo.innerHTML =
      '<div class="mp-secao">Comparar este mês:</div>' +
      '<div class="linha-dupla">' +
        '<div class="campo-bloco">' +
          '<label for="mp-mesA">Mês</label>' +
          '<select id="mp-mesA">' + opcoesMeses(mesAtual) + '</select>' +
        '</div>' +
        '<div class="campo-bloco">' +
          '<label for="mp-anoA">Ano</label>' +
          '<select id="mp-anoA">' + opcoesAnos(anoAtual) + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="mp-secao">…com este mês:</div>' +
      '<div class="linha-dupla">' +
        '<div class="campo-bloco">' +
          '<label for="mp-mesB">Mês</label>' +
          '<select id="mp-mesB">' + opcoesMeses(mesB) + '</select>' +
        '</div>' +
        '<div class="campo-bloco">' +
          '<label for="mp-anoB">Ano</label>' +
          '<select id="mp-anoB">' + opcoesAnos(anoB) + '</select>' +
        '</div>' +
      '</div>';
  }
}

function opcoesMeses(selecionado) {
  let o = "";
  for (let m = 0; m < 12; m++) {
    o += '<option value="' + m + '"' + (m === selecionado ? ' selected' : '') + '>' + MESES_NOMES[m] + '</option>';
  }
  return o;
}

function opcoesAnos(selecionado) {
  const atual = new Date().getFullYear();
  let o = "";
  for (let a = atual + 1; a >= atual - 4; a--) {
    o += '<option value="' + a + '"' + (a === selecionado ? ' selected' : '') + '>' + a + '</option>';
  }
  return o;
}

function fecharModalPeriodo() {
  document.getElementById("modal-periodo").style.display = "none";
}

// ---------- Gerar ----------
async function gerarRelatorioAgora() {
  const tipo = relTipoEscolhido;
  if (!tipo) return;

  const r = RELATORIOS[tipo];
  const params = { tipoRel: tipo };

  if (r.periodo === "ano") {
    params.ano = document.getElementById("mp-ano").value;
  } else if (r.periodo === "mes") {
    params.mes = document.getElementById("mp-mes").value;
    params.ano = document.getElementById("mp-ano").value;
  } else if (r.periodo === "meses" || r.periodo === "janela") {
    params.meses = document.getElementById("mp-meses").value;
  } else if (r.periodo === "nenhum") {
    // sem parâmetros
  } else if (r.periodo === "doisMeses") {
    params.mesA = document.getElementById("mp-mesA").value;
    params.anoA = document.getElementById("mp-anoA").value;
    params.mesB = document.getElementById("mp-mesB").value;
    params.anoB = document.getElementById("mp-anoB").value;
  }

  fecharModalPeriodo();

  const wrap = document.getElementById("conteudo-rel");
  wrap.innerHTML =
    '<div class="card" style="text-align:center; padding:46px 20px;">' +
      '<div class="spinner" style="margin:0 auto 16px;"></div>' +
      '<p style="color:var(--cinza-texto); font-size:14px;">Gerando ' + r.nome + '...</p>' +
    '</div>';

  try {
    const res = await chamarServidor("gerarRelatorio", params);
    if (res.ok) {
      relatorioAtual = res;
      renderizarRelatorio(res, false);
    } else {
      wrap.innerHTML = '<div class="card"><p class="vazio">⚠️ ' + escaparHtml(res.mensagem || "Erro ao gerar.") + '</p></div>';
      setTimeout(renderizarTelaRelatorios, 2500);
    }
  } catch (e) {
    wrap.innerHTML = '<div class="card"><p class="vazio">⚠️ Sem conexão com o servidor.</p></div>';
    setTimeout(renderizarTelaRelatorios, 2500);
  }
}

// ---------- Renderiza o relatório ----------
function renderizarRelatorio(res, ehSalvo) {
  const wrap = document.getElementById("conteudo-rel");
  relatorioAtual = res;

  let corpo = "";
  if (res.tipo === "evolucao")            corpo = htmlEvolucao(res);
  else if (res.tipo === "comparacao")     corpo = htmlComparacao(res);
  else if (res.tipo === "regra503020")    corpo = htmlRegra(res);
  else if (res.tipo === "dre")            corpo = htmlDRE(res);
  else if (res.tipo === "parcelamentos")  corpo = htmlParcelamentos(res);
  else if (res.tipo === "projecao")       corpo = htmlProjecao(res);
  else if (res.tipo === "extrato")        corpo = htmlExtrato(res);
  else if (res.tipo === "previsao")       corpo = htmlPrevisao(res);

  const jaSalvo = ehSalvo || relatorioJaSalvo(res);

  wrap.innerHTML =
    '<div class="rel-barra">' +
      '<button class="rb-btn" onclick="renderizarTelaRelatorios()">‹ Voltar</button>' +
      '<div class="rb-acoes">' +
        (jaSalvo
          ? '<button class="rb-btn salvo" disabled>📌 Salvo</button>'
          : '<button class="rb-btn" onclick="salvarRelatorioOffline()">📌 Salvar</button>') +
        '<button class="rb-btn" onclick="compartilharRelatorio()">📤</button>' +
        '<button class="rb-btn" onclick="imprimirRelatorio()">🖨️</button>' +
      '</div>' +
    '</div>' +

    '<div id="rel-imprimivel">' +
      '<div class="rel-cabecalho">' +
        '<h1>' + escaparHtml(res.meta.titulo) + '</h1>' +
        '<p class="rc-sub">' + escaparHtml(res.meta.subtitulo) + '</p>' +
        '<p class="rc-data">' + escaparHtml(res.meta.geradoEm) + '</p>' +
      '</div>' +
      corpo +
      '<div class="rel-assinatura">' +
        '<span class="ra-linha"></span>' +
        '<span class="ra-txt">' + escaparHtml(res.meta.assinatura) + '</span>' +
      '</div>' +
    '</div>';

  window.scrollTo(0, 0);
}

// ============================================================================
// HTML DE CADA RELATÓRIO
// ============================================================================

function htmlEvolucao(r) {
  const max = Math.max.apply(null, r.meses.map(function (m) {
    return Math.max(m.receitas, m.despesas);
  })) || 1;

  let barras = "";
  r.meses.forEach(function (m) {
    if (m.receitas === 0 && m.despesas === 0) return;
    const hR = (m.receitas / max) * 100;
    const hD = (m.despesas / max) * 100;
    barras +=
      '<div class="ev-col">' +
        '<div class="ev-barras">' +
          '<div class="ev-bar rec" style="height:' + hR + '%" title="' + formatarMoeda(m.receitas) + '"></div>' +
          '<div class="ev-bar des" style="height:' + hD + '%" title="' + formatarMoeda(m.despesas) + '"></div>' +
        '</div>' +
        '<div class="ev-mes">' + m.abrev + '</div>' +
      '</div>';
  });

  let linhas = "";
  r.meses.forEach(function (m) {
    if (m.receitas === 0 && m.despesas === 0) return;
    const cor = m.saldo >= 0 ? "verde" : "vermelho";
    linhas +=
      '<tr>' +
        '<td>' + m.nome + '</td>' +
        '<td class="num verde">' + formatarMoeda(m.receitas) + '</td>' +
        '<td class="num vermelho">' + formatarMoeda(m.despesas) + '</td>' +
        '<td class="num ' + cor + '"><b>' + formatarMoeda(m.saldo) + '</b></td>' +
      '</tr>';
  });

  return (
    '<div class="card">' +
      '<h2>Receitas x Despesas</h2>' +
      '<div class="ev-grafico">' + barras + '</div>' +
      '<div class="ev-legenda">' +
        '<span><i class="lg rec"></i> Receitas</span>' +
        '<span><i class="lg des"></i> Despesas</span>' +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<h2>Detalhamento</h2>' +
      '<table class="rel-tabela">' +
        '<thead><tr><th>Mês</th><th class="num">Receitas</th><th class="num">Despesas</th><th class="num">Saldo</th></tr></thead>' +
        '<tbody>' + linhas + '</tbody>' +
        '<tfoot><tr>' +
          '<td><b>Total</b></td>' +
          '<td class="num verde"><b>' + formatarMoeda(r.totais.receitas) + '</b></td>' +
          '<td class="num vermelho"><b>' + formatarMoeda(r.totais.despesas) + '</b></td>' +
          '<td class="num ' + (r.totais.saldo >= 0 ? 'verde' : 'vermelho') + '"><b>' + formatarMoeda(r.totais.saldo) + '</b></td>' +
        '</tr></tfoot>' +
      '</table>' +
      '<div class="rel-nota">' +
        'Média mensal: <b class="verde">' + formatarMoeda(r.totais.mediaReceitas) + '</b> de receita · ' +
        '<b class="vermelho">' + formatarMoeda(r.totais.mediaDespesas) + '</b> de despesa ' +
        '(' + r.totais.mesesComDados + ' meses com dados)' +
      '</div>' +
    '</div>'
  );
}

function htmlComparacao(r) {
  function cardMes(m, destaque) {
    return (
      '<div class="cp-mes' + (destaque ? ' destaque' : '') + '">' +
        '<div class="cp-nome">' + escaparHtml(m.nome) + '</div>' +
        '<div class="cp-linha"><span>Receitas</span><b class="verde">' + formatarMoeda(m.receitas) + '</b></div>' +
        '<div class="cp-linha"><span>Despesas</span><b class="vermelho">' + formatarMoeda(m.despesas) + '</b></div>' +
        '<div class="cp-linha total"><span>Saldo</span><b class="' + (m.saldo >= 0 ? 'verde' : 'vermelho') + '">' + formatarMoeda(m.saldo) + '</b></div>' +
      '</div>'
    );
  }

  const v = r.variacao;
  const setaD = v.despesas > 0 ? "▲" : (v.despesas < 0 ? "▼" : "―");
  const corD = v.despesas > 0 ? "vermelho" : "verde";  // gastar mais é ruim
  const setaR = v.receitas > 0 ? "▲" : (v.receitas < 0 ? "▼" : "―");
  const corR = v.receitas > 0 ? "verde" : "vermelho";

  let cats = "";
  r.categorias.forEach(function (c) {
    const cor = c.diferenca > 0 ? "vermelho" : (c.diferenca < 0 ? "verde" : "");
    const seta = c.diferenca > 0 ? "▲" : (c.diferenca < 0 ? "▼" : "―");
    cats +=
      '<tr>' +
        '<td class="cat">' + escaparHtml(c.categoria) + '</td>' +
        '<td class="num">' + formatarMoeda(c.valorA) + '</td>' +
        '<td class="num cinza">' + formatarMoeda(c.valorB) + '</td>' +
        '<td class="num ' + cor + '"><b>' + seta + ' ' + formatarMoeda(Math.abs(c.diferenca)) + '</b></td>' +
      '</tr>';
  });

  return (
    '<div class="card">' +
      '<div class="cp-wrap">' + cardMes(r.mesA, true) + cardMes(r.mesB, false) + '</div>' +

      '<div class="cp-variacao">' +
        '<div class="cv-item">' +
          '<span>Despesas</span>' +
          '<b class="' + corD + '">' + setaD + ' ' + Math.abs(v.despesasPct).toFixed(1) + '%</b>' +
          '<small>' + (v.despesas >= 0 ? '+' : '−') + formatarMoeda(Math.abs(v.despesas)) + '</small>' +
        '</div>' +
        '<div class="cv-item">' +
          '<span>Receitas</span>' +
          '<b class="' + corR + '">' + setaR + ' ' + Math.abs(v.receitasPct).toFixed(1) + '%</b>' +
          '<small>' + (v.receitas >= 0 ? '+' : '−') + formatarMoeda(Math.abs(v.receitas)) + '</small>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<h2>Variação por categoria</h2>' +
      '<table class="rel-tabela compacta">' +
        '<thead><tr><th>Categoria</th><th class="num">' + escaparHtml(r.mesA.nome.split("/")[0]) + '</th>' +
        '<th class="num">' + escaparHtml(r.mesB.nome.split("/")[0]) + '</th><th class="num">Dif.</th></tr></thead>' +
        '<tbody>' + (cats || '<tr><td colspan="4" class="vazio">Sem dados.</td></tr>') + '</tbody>' +
      '</table>' +
    '</div>'
  );
}

function htmlRegra(r) {
  let baldes = "";
  r.baldes.forEach(function (b) {
    const corStatus = b.status === "ok" ? "verde" : (b.status === "atencao" ? "laranja" : "vermelho");
    const alvoTxt = b.tipo === "max" ? "ideal até " + b.ideal + "%" : "ideal mín. " + b.ideal + "%";
    const largura = Math.min(b.percentual, 100);

    let itens = "";
    b.categorias.slice(0, 6).forEach(function (c) {
      itens += '<div class="rg-item"><span>' + escaparHtml(c.categoria) + '</span><b>' + formatarMoeda(c.valor) + '</b></div>';
    });

    baldes +=
      '<div class="rg-balde">' +
        '<div class="rg-topo">' +
          '<span class="rg-nome">' + escaparHtml(b.nome) + '</span>' +
          '<span class="rg-pct ' + corStatus + '">' + b.percentual.toFixed(1) + '%</span>' +
        '</div>' +
        '<div class="rg-barra">' +
          '<div class="rg-preench ' + corStatus + '" style="width:' + largura + '%"></div>' +
          '<div class="rg-alvo" style="left:' + Math.min(b.ideal, 100) + '%"></div>' +
        '</div>' +
        '<div class="rg-info">' +
          '<span>' + formatarMoeda(b.valor) + '</span>' +
          '<span class="rg-alvo-txt">' + alvoTxt + '</span>' +
        '</div>' +
        (itens ? '<div class="rg-itens">' + itens + '</div>' : '') +
      '</div>';
  });

  return (
    '<div class="card">' +
      '<div class="rg-base">' +
        'Base de cálculo: receita de <b>' + escaparHtml(r.mesBaseNome) + '</b> = ' +
        '<b class="verde">' + formatarMoeda(r.receitaBase) + '</b>' +
      '</div>' +
      baldes +
      '<div class="rg-resumo">' +
        '<div><span>Total gasto</span><b class="vermelho">' + formatarMoeda(r.totalDespesas) + '</b></div>' +
        '<div><span>Sobra</span><b class="' + (r.sobra >= 0 ? 'verde' : 'vermelho') + '">' + formatarMoeda(r.sobra) + '</b></div>' +
      '</div>' +
    '</div>'
  );
}

function htmlDRE(r) {
  function bloco(titulo, lista, classe, total) {
    let grupos = "";
    lista.forEach(function (g) {
      let itens = "";
      g.itens.forEach(function (it) {
        itens += '<div class="dre-item"><span>' + escaparHtml(it.categoria) + '</span><b>' + formatarMoeda(it.valor) + '</b></div>';
      });
      grupos +=
        '<div class="dre-grupo">' +
          '<div class="dg-topo ' + classe + '">' +
            '<span>' + escaparHtml(g.grupo) + '</span>' +
            '<b>' + formatarMoeda(g.total) + '</b>' +
          '</div>' +
          itens +
        '</div>';
    });

    if (!grupos) grupos = '<p class="vazio">Nenhum lançamento.</p>';

    return (
      '<div class="card">' +
        '<h2>' + titulo + '</h2>' +
        grupos +
        '<div class="dre-total ' + classe + '"><span>Total</span><b>' + formatarMoeda(total) + '</b></div>' +
      '</div>'
    );
  }

  const corRes = r.resultado >= 0 ? "verde" : "vermelho";

  return (
    bloco("🟢 Receitas", r.receitas, "rec", r.totalReceitas) +
    bloco("🔴 Despesas", r.despesas, "des", r.totalDespesas) +
    '<div class="card dre-resultado">' +
      '<span>Resultado do mês</span>' +
      '<b class="' + corRes + '">' + formatarMoeda(r.resultado) + '</b>' +
    '</div>'
  );
}

// ============================================================================
// SALVAR / EXCLUIR OFFLINE
// ============================================================================
function lerRelatoriosSalvos() {
  try {
    const b = localStorage.getItem(CACHE_REL_SALVOS);
    return b ? JSON.parse(b) : [];
  } catch (e) { return []; }
}

function relatorioJaSalvo(res) {
  const salvos = lerRelatoriosSalvos();
  return salvos.some(function (s) {
    return s.tipo === res.tipo && s.meta.subtitulo === res.meta.subtitulo;
  });
}

function salvarRelatorioOffline() {
  if (!relatorioAtual) return;
  try {
    const salvos = lerRelatoriosSalvos();
    salvos.unshift(relatorioAtual);
    if (salvos.length > 20) salvos.length = 20;  // limite
    localStorage.setItem(CACHE_REL_SALVOS, JSON.stringify(salvos));
    mostrarToast("📌 Relatório salvo offline!");
    renderizarRelatorio(relatorioAtual, true);
  } catch (e) {
    mostrarToast("❌ Não foi possível salvar (armazenamento cheio?).");
  }
}

function abrirRelatorioSalvo(idx) {
  const salvos = lerRelatoriosSalvos();
  const r = salvos[idx];
  if (r) renderizarRelatorio(r, true);
}

function excluirRelatorioSalvo(idx) {
  const salvos = lerRelatoriosSalvos();
  const r = salvos[idx];
  if (!r) return;
  if (!confirm("Excluir o relatório salvo \"" + r.meta.titulo + " - " + r.meta.subtitulo + "\"?")) return;

  salvos.splice(idx, 1);
  localStorage.setItem(CACHE_REL_SALVOS, JSON.stringify(salvos));
  mostrarToast("🗑️ Relatório excluído.");
  renderizarTelaRelatorios();
}

// ============================================================================
// IMPRIMIR / COMPARTILHAR
// ============================================================================
function imprimirRelatorio() {
  window.print();
}

async function compartilharRelatorio() {
  if (!relatorioAtual) return;
  const texto = relatorioParaTexto(relatorioAtual);

  if (navigator.share) {
    try {
      await navigator.share({
        title: relatorioAtual.meta.titulo + " - " + relatorioAtual.meta.subtitulo,
        text: texto
      });
    } catch (e) { /* usuário cancelou */ }
  } else {
    try {
      await navigator.clipboard.writeText(texto);
      mostrarToast("📋 Relatório copiado! Cole onde quiser.");
    } catch (e) {
      mostrarToast("❌ Não foi possível copiar.");
    }
  }
}

// Converte o relatório em texto puro (para compartilhar)
function relatorioParaTexto(r) {
  let t = "*" + r.meta.titulo.toUpperCase() + "*\n";
  t += r.meta.subtitulo + "\n";
  t += r.meta.geradoEm + "\n";
  t += "――――――――――――――――\n\n";

  if (r.tipo === "evolucao") {
    r.meses.forEach(function (m) {
      if (m.receitas === 0 && m.despesas === 0) return;
      t += m.nome + "\n";
      t += "  Receitas: " + formatarMoeda(m.receitas) + "\n";
      t += "  Despesas: " + formatarMoeda(m.despesas) + "\n";
      t += "  Saldo: " + formatarMoeda(m.saldo) + "\n\n";
    });
    t += "TOTAL DO ANO\n";
    t += "  Receitas: " + formatarMoeda(r.totais.receitas) + "\n";
    t += "  Despesas: " + formatarMoeda(r.totais.despesas) + "\n";
    t += "  Saldo: " + formatarMoeda(r.totais.saldo) + "\n";

  } else if (r.tipo === "comparacao") {
    [r.mesA, r.mesB].forEach(function (m) {
      t += m.nome + "\n";
      t += "  Receitas: " + formatarMoeda(m.receitas) + "\n";
      t += "  Despesas: " + formatarMoeda(m.despesas) + "\n";
      t += "  Saldo: " + formatarMoeda(m.saldo) + "\n\n";
    });
    t += "VARIAÇÃO\n";
    t += "  Despesas: " + r.variacao.despesasPct.toFixed(1) + "%\n";
    t += "  Receitas: " + r.variacao.receitasPct.toFixed(1) + "%\n";

  } else if (r.tipo === "regra503020") {
    t += "Receita base (" + r.mesBaseNome + "): " + formatarMoeda(r.receitaBase) + "\n\n";
    r.baldes.forEach(function (b) {
      t += b.nome + ": " + formatarMoeda(b.valor) + " (" + b.percentual.toFixed(1) + "%)\n";
    });
    t += "\nTotal gasto: " + formatarMoeda(r.totalDespesas) + "\n";
    t += "Sobra: " + formatarMoeda(r.sobra) + "\n";

  } else if (r.tipo === "dre") {
    t += "RECEITAS\n";
    r.receitas.forEach(function (g) {
      t += "  " + g.grupo + ": " + formatarMoeda(g.total) + "\n";
    });
    t += "  Total: " + formatarMoeda(r.totalReceitas) + "\n\n";
    t += "DESPESAS\n";
    r.despesas.forEach(function (g) {
      t += "  " + g.grupo + ": " + formatarMoeda(g.total) + "\n";
    });
    t += "  Total: " + formatarMoeda(r.totalDespesas) + "\n\n";
    t += "RESULTADO: " + formatarMoeda(r.resultado) + "\n";

  } else if (r.tipo === "parcelamentos") {
    t += "Falta pagar: " + formatarMoeda(r.resumo.totalRestante) + "\n";
    t += "Por mês: " + formatarMoeda(r.resumo.parcelaMensal) + "\n";
    t += "Progresso: " + r.resumo.progressoGeral.toFixed(1) + "%\n\n";
    r.parcelamentos.forEach(function (p) {
      t += p.descricao + "\n";
      t += "  " + p.pagas + "/" + p.totalParcelas + " pagas · falta " + formatarMoeda(p.valorRestante) + "\n";
      t += "  " + formatarMoeda(p.valorParcela) + "/mês até " + p.ultimoVenc + "\n\n";
    });

  } else if (r.tipo === "projecao") {
    t += "Total comprometido: " + formatarMoeda(r.resumo.totalComprometido) + "\n";
    t += "Média mensal: " + formatarMoeda(r.resumo.mediaMensal) + "\n";
    t += "Comprometimento: " + r.resumo.comprometimentoMedio.toFixed(1) + "%\n\n";
    r.meses.forEach(function (m) {
      t += m.nome + ": " + formatarMoeda(m.total) + "\n";
    });

  } else if (r.tipo === "previsao") {
    t += "PREVISÃO PARA " + r.mesAlvo.toUpperCase() + "\n\n";
    t += "Total previsto: " + formatarMoeda(r.resumo.totalPrevisto) + "\n";
    t += "Faixa: " + formatarMoeda(r.resumo.totalMinimo) + " a " + formatarMoeda(r.resumo.totalMaximo) + "\n";
    t += "Receita ref.: " + formatarMoeda(r.resumo.receitaReferencia) + "\n";
    t += "Sobra prevista: " + formatarMoeda(r.resumo.sobraPrevista) + "\n";
    t += "Comprometimento: " + r.resumo.comprometimento.toFixed(0) + "%\n\n";
    t += "PRINCIPAIS CATEGORIAS\n";
    r.previsoes.slice(0, 12).forEach(function (p) {
      if (p.previsto > 0) {
        t += "  " + p.categoria + ": " + formatarMoeda(p.previsto) + "\n";
      }
    });

  } else if (r.tipo === "extrato") {
    t += "Receitas: " + formatarMoeda(r.resumo.receitas) + "\n";
    t += "Despesas: " + formatarMoeda(r.resumo.despesas) + "\n";
    t += "Saldo: " + formatarMoeda(r.resumo.saldo) + "\n\n";
    r.itens.forEach(function (it) {
      const sinal = it.tipo === "receita" ? "+" : "-";
      t += it.data + " " + it.descricao + " " + sinal + formatarMoeda(it.valor) + "\n";
    });
  }

  t += "\n――――――――――――――――\n" + r.meta.assinatura;
  return t;
}

// ============================================================================
// ===================== BIOMETRIA (DIGITAL) E PIN ============================
// Usa WebAuthn para a digital do aparelho. Se não houver biometria disponível,
// cai no PIN de 4 dígitos.
// ============================================================================

// ---- Verifica se já existe algum método de desbloqueio configurado ----
function temDesbloqueioConfigurado() {
  try {
    return !!(localStorage.getItem(CHAVE_BIOMETRIA) || localStorage.getItem(CHAVE_PIN));
  } catch (e) { return false; }
}

function temBiometriaCadastrada() {
  try { return !!localStorage.getItem(CHAVE_BIOMETRIA); } catch (e) { return false; }
}

function apagarDesbloqueio() {
  try {
    localStorage.removeItem(CHAVE_BIOMETRIA);
    localStorage.removeItem(CHAVE_PIN);
  } catch (e) {}
}

// ---- O aparelho tem leitor biométrico disponível? ----
async function biometriaDisponivel() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) { return false; }
}

// ---- Hash simples do PIN (para não guardar o número em texto puro) ----
async function hashPin(pin) {
  const dados = new TextEncoder().encode("smartbalanco:" + pin);
  const buffer = await crypto.subtle.digest("SHA-256", dados);
  return Array.from(new Uint8Array(buffer))
    .map(function (b) { return b.toString(16).padStart(2, "0"); })
    .join("");
}

// ============================================================================
// CADASTRO DO DESBLOQUEIO (na 1ª vez que loga)
// ============================================================================
async function mostrarTelaConfigurarBloqueio() {
  document.getElementById("tela-carregando").style.display = "none";
  document.getElementById("tela-login").style.display = "none";
  document.getElementById("tela-interna").style.display = "none";
  document.getElementById("tela-config-bloqueio").style.display = "flex";

  const btnBio = document.getElementById("cb-btn-biometria");
  const temBio = await biometriaDisponivel();

  if (temBio) {
    btnBio.style.display = "flex";
    document.getElementById("cb-sem-bio").style.display = "none";
  } else {
    btnBio.style.display = "none";
    document.getElementById("cb-sem-bio").style.display = "block";
  }
}

// ---- Cadastra a digital ----
async function cadastrarBiometria() {
  try {
    const idUsuario = new TextEncoder().encode(emailUsuarioAtual || "smartbalanco");
    const desafio = crypto.getRandomValues(new Uint8Array(32));

    const credencial = await navigator.credentials.create({
      publicKey: {
        challenge: desafio,
        rp: { name: "Smartbalanço" },
        user: {
          id: idUsuario,
          name: emailUsuarioAtual || "usuario",
          displayName: "Smartbalanço"
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },    // ES256
          { type: "public-key", alg: -257 }   // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",   // usa o sensor do próprio aparelho
          userVerification: "required"           // exige digital/rosto
        },
        timeout: 60000
      }
    });

    if (!credencial) throw new Error("Cadastro cancelado.");

    // Guarda o ID da credencial (não guarda a digital em si — ela nunca sai do aparelho)
    const id = btoa(String.fromCharCode.apply(null, new Uint8Array(credencial.rawId)));
    localStorage.setItem(CHAVE_BIOMETRIA, id);

    mostrarToast("✅ Digital cadastrada!");
    entrarNoApp();

  } catch (e) {
    mostrarToast("⚠️ Não foi possível cadastrar a digital. Use um PIN.");
    mostrarCadastroPin();
  }
}

// ---- Cadastro de PIN ----
function mostrarCadastroPin() {
  document.getElementById("cb-escolha").style.display = "none";
  document.getElementById("cb-pin").style.display = "block";
  document.getElementById("cb-pin1").value = "";
  document.getElementById("cb-pin2").value = "";
  document.getElementById("cb-pin-erro").style.display = "none";
  setTimeout(function () { document.getElementById("cb-pin1").focus(); }, 150);
}

async function salvarPin() {
  const p1 = document.getElementById("cb-pin1").value;
  const p2 = document.getElementById("cb-pin2").value;
  const erro = document.getElementById("cb-pin-erro");

  if (!/^\d{4}$/.test(p1)) {
    erro.textContent = "O PIN deve ter exatamente 4 números.";
    erro.style.display = "block";
    return;
  }
  if (p1 !== p2) {
    erro.textContent = "Os PINs não coincidem.";
    erro.style.display = "block";
    return;
  }

  const hash = await hashPin(p1);
  localStorage.setItem(CHAVE_PIN, hash);

  mostrarToast("✅ PIN cadastrado!");
  entrarNoApp();
}

// Pula o cadastro (usuário não quer bloqueio)
function pularBloqueio() {
  if (!confirm("Continuar sem bloqueio?\n\nQualquer pessoa com acesso ao seu celular desbloqueado poderá abrir o Smartbalanço.")) return;
  entrarNoApp();
}

// ============================================================================
// TELA DE DESBLOQUEIO (quando volta após 5+ min fora)
// ============================================================================
async function bloquearApp() {
  appBloqueado = true;

  document.getElementById("tela-bloqueio").style.display = "flex";
  document.getElementById("bl-pin-area").style.display = "none";
  document.getElementById("bl-pin-erro").style.display = "none";
  document.getElementById("bl-pin").value = "";

  const temBio = temBiometriaCadastrada();
  const temPin = !!localStorage.getItem(CHAVE_PIN);

  document.getElementById("bl-btn-bio").style.display = temBio ? "block" : "none";
  document.getElementById("bl-btn-pin").style.display = (temPin && temBio) ? "block" : "none";

  // Se só tem PIN, já mostra o campo direto
  if (temPin && !temBio) {
    mostrarCampoPin();
  }

  // Se tem biometria, tenta pedir a digital automaticamente
  if (temBio) {
    setTimeout(desbloquearComBiometria, 400);
  }
}

async function desbloquearComBiometria() {
  try {
    const idSalvo = localStorage.getItem(CHAVE_BIOMETRIA);
    if (!idSalvo) throw new Error("Sem biometria.");

    const rawId = Uint8Array.from(atob(idSalvo), function (c) { return c.charCodeAt(0); });
    const desafio = crypto.getRandomValues(new Uint8Array(32));

    const resultado = await navigator.credentials.get({
      publicKey: {
        challenge: desafio,
        allowCredentials: [{ type: "public-key", id: rawId }],
        userVerification: "required",
        timeout: 60000
      }
    });

    if (resultado) desbloquear();

  } catch (e) {
    // Cancelou ou falhou: oferece o PIN se houver
    if (localStorage.getItem(CHAVE_PIN)) {
      mostrarCampoPin();
    }
  }
}

function mostrarCampoPin() {
  document.getElementById("bl-pin-area").style.display = "block";
  document.getElementById("bl-btn-bio").style.display = "none";
  document.getElementById("bl-btn-pin").style.display = "none";
  setTimeout(function () { document.getElementById("bl-pin").focus(); }, 150);
}

async function verificarPin() {
  const pin = document.getElementById("bl-pin").value;
  const erro = document.getElementById("bl-pin-erro");

  if (!/^\d{4}$/.test(pin)) {
    erro.textContent = "Digite os 4 números.";
    erro.style.display = "block";
    return;
  }

  const hash = await hashPin(pin);
  if (hash === localStorage.getItem(CHAVE_PIN)) {
    desbloquear();
  } else {
    erro.textContent = "PIN incorreto.";
    erro.style.display = "block";
    document.getElementById("bl-pin").value = "";
  }
}

let desbloqueando = false;   // trava contra desbloqueio duplo (PIN dispara 2x)

function desbloquear() {
  if (desbloqueando) return;
  desbloqueando = true;

  appBloqueado = false;
  momentoQueSaiu = null;
  document.getElementById("tela-bloqueio").style.display = "none";
  document.getElementById("bl-pin").value = "";

  // Se o app ainda não foi carregado (desbloqueio na abertura), precisa entrar.
  // Se já estava aberto, só atualiza os dados.
  const jaAberto = document.getElementById("tela-interna").style.display === "block";

  if (jaAberto) {
    atualizarAoVoltar();
  } else {
    entrarNoApp();
  }

  setTimeout(function () { desbloqueando = false; }, 2000);
}

// ============================================================================
// DETECTA SAÍDA/RETORNO DO APP
// - Se ficou 5+ minutos fora e tem bloqueio configurado -> pede digital/PIN
// - Sempre que volta -> atualiza os dados automaticamente
// ============================================================================
function configurarDeteccaoRetorno() {
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      // Saiu do app (trocou de aba, minimizou, bloqueou o celular...)
      momentoQueSaiu = Date.now();
    } else {
      // Voltou para o app
      if (!sessaoAtual) return;   // não está logado, ignora

      const minutosFora = momentoQueSaiu
        ? (Date.now() - momentoQueSaiu) / 60000
        : 0;

      if (minutosFora >= MINUTOS_BLOQUEIO && temDesbloqueioConfigurado()) {
        bloquearApp();
      } else {
        atualizarAoVoltar();
      }
    }
  });
}

// Atualiza os dados da aba que estiver aberta
async function atualizarAoVoltar() {
  if (!sessaoAtual || appBloqueado) return;

  // Aprovações são sempre atualizadas em segundo plano (para abrir instantâneo)
  checarPendentesAprovacao();

  if (abaAtiva === "dashboard") {
    await recarregarDados();
  }
}

// ============================================================================
// HTML DOS RELATÓRIOS DO BLOCO 2
// ============================================================================

function htmlParcelamentos(r) {
  const res = r.resumo;

  if (!r.parcelamentos || r.parcelamentos.length === 0) {
    return '<div class="card" style="text-align:center; padding:40px 20px;">' +
             '<div style="font-size:40px; margin-bottom:10px;">🎉</div>' +
             '<p style="font-size:15px; color:#334155; font-weight:600;">Nenhum parcelamento em aberto!</p>' +
           '</div>';
  }

  let cards = "";
  r.parcelamentos.forEach(function (p) {
    const cartao = iconeCartao(p.metodo);
    cards +=
      '<div class="pc-item">' +
        '<div class="pc-topo">' +
          '<div class="pc-desc">' + escaparHtml(p.descricao) + cartao + '</div>' +
          '<div class="pc-restante">' + formatarMoeda(p.valorRestante) + '</div>' +
        '</div>' +

        '<div class="pc-barra">' +
          '<div class="pc-preench" style="width:' + p.progresso + '%"></div>' +
        '</div>' +

        '<div class="pc-info">' +
          '<span><b>' + p.pagas + '/' + p.totalParcelas + '</b> pagas</span>' +
          '<span>' + formatarMoeda(p.valorParcela) + '/mês</span>' +
          '<span>até ' + escaparHtml(p.ultimoVenc) + '</span>' +
        '</div>' +

        '<div class="pc-detalhes">' +
          'Total: ' + formatarMoeda(p.valorTotal) +
          ' &middot; Pago: <b class="verde">' + formatarMoeda(p.valorPago) + '</b>' +
          ' &middot; Próxima: ' + escaparHtml(p.proximoVenc) +
        '</div>' +
      '</div>';
  });

  return (
    '<div class="card">' +
      '<div class="pc-resumo">' +
        '<div class="pr-box">' +
          '<span>Falta pagar</span>' +
          '<b class="vermelho">' + formatarMoeda(res.totalRestante) + '</b>' +
        '</div>' +
        '<div class="pr-box">' +
          '<span>Por mês</span>' +
          '<b class="laranja">' + formatarMoeda(res.parcelaMensal) + '</b>' +
        '</div>' +
      '</div>' +

      '<div class="pc-geral">' +
        '<div class="pg-topo">' +
          '<span>Progresso geral</span>' +
          '<b>' + res.progressoGeral.toFixed(1) + '%</b>' +
        '</div>' +
        '<div class="pc-barra grande">' +
          '<div class="pc-preench" style="width:' + res.progressoGeral + '%"></div>' +
        '</div>' +
        '<div class="pg-info">' +
          formatarMoeda(res.totalPago) + ' pagos de ' + formatarMoeda(res.totalGeral) +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<h2>' + res.quantidade + ' ' + (res.quantidade === 1 ? 'compra em aberto' : 'compras em aberto') + '</h2>' +
      cards +
    '</div>'
  );
}

function htmlProjecao(r) {
  const res = r.resumo;
  const max = Math.max.apply(null, r.meses.map(function (m) { return m.total; })) || 1;

  let barras = "";
  r.meses.forEach(function (m) {
    const h = (m.total / max) * 100;
    barras +=
      '<div class="pj-col">' +
        '<div class="pj-valor">' + (m.total > 0 ? formatarMoedaCurta(m.total) : "—") + '</div>' +
        '<div class="pj-bar-wrap">' +
          '<div class="pj-bar" style="height:' + h + '%"></div>' +
        '</div>' +
        '<div class="pj-mes">' + escaparHtml(m.abrev) + '</div>' +
      '</div>';
  });

  let linhas = "";
  r.meses.forEach(function (m) {
    let cats = "";
    m.topCategorias.forEach(function (c) {
      cats += '<div class="pj-cat"><span>' + escaparHtml(c.categoria) + '</span><b>' + formatarMoeda(c.valor) + '</b></div>';
    });

    linhas +=
      '<div class="pj-mes-bloco">' +
        '<div class="pj-mb-topo">' +
          '<span>' + escaparHtml(m.nome) + '</span>' +
          '<b class="vermelho">' + formatarMoeda(m.total) + '</b>' +
        '</div>' +
        '<div class="pj-mb-sub">' +
          (m.parcelas > 0 ? '📦 Parcelas: ' + formatarMoeda(m.parcelas) + ' &middot; ' : '') +
          '🧾 À vista: ' + formatarMoeda(m.avista) +
          (m.receitas > 0 ? ' &middot; 🟢 Receitas: ' + formatarMoeda(m.receitas) : '') +
        '</div>' +
        (cats ? '<div class="pj-cats">' + cats + '</div>' : '') +
      '</div>';
  });

  const alerta = res.comprometimentoMedio > 80
    ? '<div class="pj-alerta critico">🔴 Comprometimento médio de <b>' + res.comprometimentoMedio.toFixed(1) + '%</b> da sua receita base.</div>'
    : (res.comprometimentoMedio > 50
      ? '<div class="pj-alerta atencao">🟠 Comprometimento médio de <b>' + res.comprometimentoMedio.toFixed(1) + '%</b> da sua receita base.</div>'
      : '<div class="pj-alerta ok">🟢 Comprometimento médio de <b>' + res.comprometimentoMedio.toFixed(1) + '%</b> da sua receita base.</div>');

  return (
    '<div class="card">' +
      '<h2>Comprometimento mês a mês</h2>' +
      '<div class="pj-grafico">' + barras + '</div>' +
    '</div>' +

    '<div class="card">' +
      '<div class="pj-resumo">' +
        '<div class="pr-box">' +
          '<span>Total comprometido</span>' +
          '<b class="vermelho">' + formatarMoeda(res.totalComprometido) + '</b>' +
        '</div>' +
        '<div class="pr-box">' +
          '<span>Média mensal</span>' +
          '<b>' + formatarMoeda(res.mediaMensal) + '</b>' +
        '</div>' +
      '</div>' +
      alerta +
      '<div class="rel-nota">' +
        'Referência: receita base de ' + formatarMoeda(res.receitaReferencia) + '. ' +
        'Do total, <b>' + formatarMoeda(res.totalParcelas) + '</b> são parcelas de compras já feitas.' +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<h2>Detalhamento</h2>' +
      linhas +
    '</div>'
  );
}

function htmlExtrato(r) {
  const res = r.resumo;

  if (!r.itens || r.itens.length === 0) {
    return '<div class="card"><p class="vazio">Nenhum lançamento neste mês.</p></div>';
  }

  let linhas = "";
  r.itens.forEach(function (it) {
    const cartaoHtml = it.ehCartao
      ? '<span class="ex-cartao">💳 ' + escaparHtml(it.cartao) + '</span>'
      : '';

    const parcHtml = it.parcela
      ? '<span class="ex-parc">' + escaparHtml(it.parcela) + '</span>'
      : '';

    const catHtml = it.codCategoria
      ? '<button class="ex-cat" onclick="mostrarCategoriaCompleta(this)" data-cat="' +
        escaparHtml(it.categoria) + '">' + escaparHtml(it.codCategoria) + '</button>'
      : '';

    const pagoHtml = (it.tipo === "despesa" && !it.pago)
      ? '<span class="ex-pendente">⏳</span>'
      : '';

    linhas +=
      '<div class="ex-linha ' + it.tipo + '">' +
        '<div class="ex-data">' + escaparHtml(it.data) + '</div>' +
        '<div class="ex-meio">' +
          '<div class="ex-desc">' + escaparHtml(it.descricao) + pagoHtml + '</div>' +
          '<div class="ex-tags">' + catHtml + cartaoHtml + parcHtml + '</div>' +
        '</div>' +
        '<div class="ex-valor ' + (it.tipo === "receita" ? "verde" : "vermelho") + '">' +
          (it.tipo === "receita" ? "+" : "−") + formatarMoeda(it.valor).replace("R$ ", "") +
        '</div>' +
      '</div>';
  });

  return (
    '<div class="card">' +
      '<div class="ex-resumo">' +
        '<div><span>Receitas</span><b class="verde">' + formatarMoeda(res.receitas) + '</b></div>' +
        '<div><span>Despesas</span><b class="vermelho">' + formatarMoeda(res.despesas) + '</b></div>' +
        '<div><span>Saldo</span><b class="' + (res.saldo >= 0 ? 'verde' : 'vermelho') + '">' + formatarMoeda(res.saldo) + '</b></div>' +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<h2>' + res.quantidade + ' lançamentos</h2>' +
      '<div class="ex-lista">' + linhas + '</div>' +
      '<div class="rel-nota">Toque no código da categoria para ver o nome completo. ⏳ = pendente de pagamento.</div>' +
    '</div>'
  );
}

// Mostra o nome completo da categoria ao tocar no badge
function mostrarCategoriaCompleta(botao) {
  const cat = botao.getAttribute("data-cat");
  mostrarToast("📂 " + cat);
}

// Ícone do cartão (se for cartão)
function iconeCartao(metodo) {
  const m = (metodo || "").toLowerCase();
  if (m.indexOf("cart") === -1) return "";
  let nome = "";
  if (m.indexOf("xp") !== -1) nome = "XP";
  else if (m.indexOf("inter") !== -1) nome = "Inter";
  else if (m.indexOf("nubank") !== -1) nome = "Nubank";
  else if (m.indexOf("amazon") !== -1) nome = "Amazon";
  else if (m.indexOf("mp") !== -1) nome = "MP";
  else nome = metodo;
  return ' <span class="ex-cartao">💳 ' + escaparHtml(nome) + '</span>';
}

// Formata valores grandes de forma curta (para caber nos gráficos)
function formatarMoedaCurta(v) {
  if (v >= 1000) return (v / 1000).toFixed(1).replace(".", ",") + "k";
  return Math.round(v).toString();
}

// ============================================================================
// ===================== NOTIFICAÇÕES =========================================
// Avisa sobre contas vencendo quando o app é aberto.
// (Um app web não consegue notificar com o app fechado sem infraestrutura de
//  push; para isso, o alerta diário por e-mail cobre o caso.)
// ============================================================================

const CHAVE_ULTIMA_NOTIF = "sb_ultima_notif";

// Pede permissão para notificar (só na primeira vez)
async function pedirPermissaoNotificacao() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  try {
    const p = await Notification.requestPermission();
    return p === "granted";
  } catch (e) {
    return false;
  }
}

// Verifica se já notificamos hoje (para não repetir a cada abertura)
function jaNotificouHoje() {
  try {
    const hoje = new Date().toDateString();
    return localStorage.getItem(CHAVE_ULTIMA_NOTIF) === hoje;
  } catch (e) { return false; }
}

function marcarNotificadoHoje() {
  try {
    localStorage.setItem(CHAVE_ULTIMA_NOTIF, new Date().toDateString());
  } catch (e) {}
}

// Checa as contas a vencer e notifica (chamado após carregar o dashboard)
async function verificarContasEVNotificar(dadosDashboard) {
  try {
    await executarVerificacaoNotificacao(dadosDashboard);
  } catch (e) {
    console.warn("Notificação falhou (ignorado):", e);
  }
}

async function executarVerificacaoNotificacao(dadosDashboard) {
  if (!dadosDashboard || !dadosDashboard.contasAVencer) return;

  const contas = dadosDashboard.contasAVencer;
  if (contas.length === 0) return;

  // Só as que vencem nos próximos 3 dias
  const hoje = new Date();
  const urgentes = contas.filter(function (c) {
    // c.data vem como "dd/MM"
    const p = c.data.split("/");
    if (p.length !== 2) return false;
    const d = new Date(hoje.getFullYear(), parseInt(p[1]) - 1, parseInt(p[0]));
    const dias = Math.round((d - hoje) / 86400000);
    return dias >= 0 && dias <= 3;
  });

  if (urgentes.length === 0) return;

  // Mostra o aviso dentro do app (sempre)
  mostrarAvisoVencimento(urgentes);

  // Notificação do sistema (uma vez por dia)
  if (jaNotificouHoje()) return;

  const permitido = await pedirPermissaoNotificacao();
  if (!permitido) return;

  let total = 0;
  urgentes.forEach(function (c) { total += c.valor; });

  const titulo = urgentes.length === 1
    ? "⏰ 1 conta vencendo"
    : "⏰ " + urgentes.length + " contas vencendo";

  const corpo = urgentes.length === 1
    ? urgentes[0].descricao + " · " + formatarMoeda(urgentes[0].valor) + " · vence " + urgentes[0].data
    : "Total: " + formatarMoeda(total) + "\n" + urgentes.slice(0, 3).map(function (c) {
        return "• " + c.data + " " + c.descricao;
      }).join("\n");

  try {
    new Notification(titulo, {
      body: corpo,
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: "smartbalanco-vencimentos"
    });
    marcarNotificadoHoje();
  } catch (e) {
    // Alguns navegadores exigem service worker para notificar
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(titulo, {
          body: corpo,
          icon: "icon-192.png",
          badge: "icon-192.png",
          tag: "smartbalanco-vencimentos"
        });
        marcarNotificadoHoje();
      }
    } catch (e2) {}
  }
}

// Faixa de aviso dentro do app
function mostrarAvisoVencimento(urgentes) {
  const el = document.getElementById("aviso-vencimento");
  if (!el) return;

  let total = 0;
  urgentes.forEach(function (c) { total += c.valor; });

  const hojeCount = urgentes.filter(function (c) {
    const h = new Date();
    const p = c.data.split("/");
    return parseInt(p[0]) === h.getDate() && parseInt(p[1]) === (h.getMonth() + 1);
  }).length;

  let txt;
  if (hojeCount > 0) {
    txt = "🔴 <b>" + hojeCount + (hojeCount === 1 ? " conta vence HOJE" : " contas vencem HOJE") + "</b>";
    if (urgentes.length > hojeCount) {
      txt += " · " + (urgentes.length - hojeCount) + " nos próximos dias";
    }
    el.className = "aviso-venc critico";
  } else {
    txt = "⏰ <b>" + urgentes.length + (urgentes.length === 1 ? " conta vence" : " contas vencem") +
          " nos próximos 3 dias</b> · " + formatarMoeda(total);
    el.className = "aviso-venc atencao";
  }

  el.innerHTML = txt;
  el.style.display = "block";
}

function esconderAvisoVencimento() {
  const el = document.getElementById("aviso-vencimento");
  if (el) el.style.display = "none";
}

// ============================================================================
// HTML DA PREVISÃO ORÇAMENTÁRIA
// ============================================================================

const PERFIS_INFO = {
  contratado: { icone: "🔒", cor: "#2563eb", nome: "Já contratado",
                desc: "Valor já lançado na planilha. É certeza." },
  fixo:       { icone: "📌", cor: "#2e9e6b", nome: "Fixo / recorrente",
                desc: "Estável. Previsto pelo último valor (não pela média)." },
  variavel:   { icone: "📊", cor: "#f97316", nome: "Recorrente variável",
                desc: "Oscila. Previsto pela média ponderada, com faixa." },
  sazonal:    { icone: "🗓️", cor: "#8e44ad", nome: "Sazonal",
                desc: "Só cai em meses específicos." },
  eventual:   { icone: "🎲", cor: "#94a3b8", nome: "Eventual",
                desc: "Esporádico. Não é previsível — não entra no total." }
};

const CONFIANCA_INFO = {
  maxima: { txt: "certeza", cor: "#2563eb" },
  alta:   { txt: "alta",    cor: "#2e9e6b" },
  media:  { txt: "média",   cor: "#f97316" },
  baixa:  { txt: "baixa",   cor: "#94a3b8" }
};

function htmlPrevisao(r) {
  const res = r.resumo;

  // ---- Cartão principal: o número que importa ----
  const comp = res.comprometimento;
  let corComp, statusComp;
  if (comp <= 70)       { corComp = "verde";    statusComp = "🟢 Confortável"; }
  else if (comp <= 90)  { corComp = "laranja";  statusComp = "🟠 Apertado"; }
  else                  { corComp = "vermelho"; statusComp = "🔴 Estourado"; }

  const principal =
    '<div class="card pv-principal">' +
      '<div class="pv-label">Previsão de gastos para</div>' +
      '<div class="pv-mes">' + escaparHtml(r.mesAlvo) + '</div>' +
      '<div class="pv-valor">' + formatarMoeda(res.totalPrevisto) + '</div>' +
      '<div class="pv-faixa">' +
        'entre ' + formatarMoeda(res.totalMinimo) + ' e ' + formatarMoeda(res.totalMaximo) +
      '</div>' +

      '<div class="pv-vs-receita">' +
        '<div class="pvr-linha">' +
          '<span>Receita de referência</span>' +
          '<b class="verde">' + formatarMoeda(res.receitaReferencia) + '</b>' +
        '</div>' +
        '<div class="pvr-linha">' +
          '<span>Sobra prevista</span>' +
          '<b class="' + (res.sobraPrevista >= 0 ? "verde" : "vermelho") + '">' +
            formatarMoeda(res.sobraPrevista) +
          '</b>' +
        '</div>' +
        '<div class="pvr-barra">' +
          '<div class="pvr-preench ' + corComp + '" style="width:' + Math.min(comp, 100) + '%"></div>' +
        '</div>' +
        '<div class="pvr-status ' + corComp + '">' +
          statusComp + ' &middot; ' + comp.toFixed(0) + '% da receita' +
        '</div>' +
      '</div>' +
    '</div>';

  // ---- Como o sistema pensou (perfis) ----
  let perfisHtml = "";
  r.perfis.forEach(function (p) {
    const info = PERFIS_INFO[p.perfil] || PERFIS_INFO.eventual;
    perfisHtml +=
      '<div class="pv-perfil">' +
        '<div class="pvp-topo">' +
          '<span class="pvp-nome">' + info.icone + ' ' + escaparHtml(p.nome) + '</span>' +
          '<b class="pvp-valor">' + formatarMoeda(p.total) + '</b>' +
        '</div>' +
        '<div class="pvp-desc">' + escaparHtml(info.desc) +
          ' <span class="pvp-qtd">(' + p.qtd + (p.qtd === 1 ? ' categoria' : ' categorias') + ')</span>' +
        '</div>' +
      '</div>';
  });

  const blocoPerfis =
    '<div class="card">' +
      '<h2>🧠 Como o sistema previu</h2>' +
      '<p class="pv-intro">' +
        'Cada categoria tem um comportamento diferente. Usar a média para todas daria ' +
        'resultado errado — por isso o sistema classifica cada uma e aplica o método certo.' +
      '</p>' +
      perfisHtml +
    '</div>';

  // ---- Detalhe por categoria ----
  let cats = "";
  r.previsoes.forEach(function (p, idx) {
    const info = PERFIS_INFO[p.perfil] || PERFIS_INFO.eventual;
    const conf = CONFIANCA_INFO[p.confianca] || CONFIANCA_INFO.baixa;
    const h = p.historico;

    // Mini-gráfico da série histórica
    const maxSerie = Math.max.apply(null, h.serie.concat([1]));
    let spark = "";
    h.serie.forEach(function (v) {
      const alt = (v / maxSerie) * 100;
      spark += '<div class="pv-spark-bar" style="height:' + Math.max(alt, 3) + '%;' +
               (v === 0 ? 'opacity:0.25;' : '') + '"></div>';
    });

    const previstoTxt = p.previsto > 0
      ? formatarMoeda(p.previsto)
      : '<span class="pv-zero">—</span>';

    cats +=
      '<div class="pv-cat" onclick="alternarDetalhePrev(' + idx + ')">' +
        '<div class="pvc-topo">' +
          '<div class="pvc-esq">' +
            '<span class="pvc-perfil" style="background:' + info.cor + '20; color:' + info.cor + ';">' +
              info.icone +
            '</span>' +
            '<span class="pvc-nome">' + escaparHtml(p.categoria) + '</span>' +
          '</div>' +
          '<div class="pvc-valor">' + previstoTxt + '</div>' +
        '</div>' +

        '<div class="pvc-meta">' +
          '<span class="pvc-conf" style="color:' + conf.cor + ';">confiança ' + conf.txt + '</span>' +
          (p.previsto > 0 && p.minimo !== p.maximo
            ? '<span class="pvc-faixa">' + formatarMoeda(p.minimo) + ' – ' + formatarMoeda(p.maximo) + '</span>'
            : '') +
        '</div>' +

        '<div class="pv-detalhe" id="pv-det-' + idx + '">' +
          '<div class="pvd-expl">' + escaparHtml(p.explicacao) + '</div>' +

          '<div class="pv-spark">' + spark + '</div>' +
          '<div class="pv-spark-legenda">últimos ' + h.totalMeses + ' meses</div>' +

          '<div class="pvd-stats">' +
            '<div><span>Média</span><b>' + formatarMoeda(h.media) + '</b></div>' +
            '<div><span>Último</span><b>' + formatarMoeda(h.ultimo) + '</b></div>' +
            '<div><span>Frequência</span><b>' + h.mesesComGasto + '/' + h.totalMeses + '</b></div>' +
          '</div>' +

          (Math.abs(h.tendencia) > 5
            ? '<div class="pvd-tend ' + (h.tendencia > 0 ? "alta" : "baixa") + '">' +
                (h.tendencia > 0 ? "▲ Subindo" : "▼ Caindo") + ' ' +
                Math.abs(h.tendencia).toFixed(0) + '% no período' +
              '</div>'
            : '') +

          (p.agendado > 0
            ? '<div class="pvd-agendado">🔒 ' + formatarMoeda(p.agendado) + ' já lançado para o mês</div>'
            : '') +
        '</div>' +
      '</div>';
  });

  const blocoCats =
    '<div class="card">' +
      '<h2>Detalhe por categoria</h2>' +
      '<p class="pv-intro">Toque numa categoria para ver como a previsão foi feita.</p>' +
      cats +
    '</div>';

  return principal + blocoPerfis + blocoCats;
}

// Abre/fecha o detalhe de uma categoria
function alternarDetalhePrev(idx) {
  const el = document.getElementById("pv-det-" + idx);
  if (!el) return;
  const aberto = el.classList.contains("aberto");
  el.classList.toggle("aberto", !aberto);
}
