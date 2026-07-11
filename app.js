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
  // 1. Se houver cache deste mês, mostra IMEDIATAMENTE (sem esperar o servidor)
  const cache = lerCache(mesExibido, anoExibido);
  if (cache) {
    preencherDashboard(cache.dados);
    mostrarTelaInterna();
    mostrarAvisoAtualizando("Dados de " + tempoRelativo(cache.quando) + " · atualizando...");
  } else {
    mostrarCarregando("Carregando seus dados...");
  }

  // 2. Busca os dados frescos (em segundo plano se o cache já apareceu)
  try {
    const r = await chamarServidor("dashboard", { mes: mesExibido, ano: anoExibido });
    if (r.ok) {
      salvarCache(mesExibido, anoExibido, r);
      preencherDashboard(r);
      mostrarTelaInterna();
      mostrarAvisoAtualizando(null);
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
  document.getElementById("tela-interna").style.display = "block";
  document.getElementById("btn-nova-despesa").style.display = "flex";
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

  // Menus suspensos
  montarSelect("ed-metodo", listasValidas ? listasValidas.metodos : [], l.metodo);
  montarSelect("ed-categoria", listasValidas ? listasValidas.categorias : [], l.categoria);

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

  // Preenche os selects
  montarSelect("nd-metodo", listasValidas ? listasValidas.metodos : [], "");
  montarSelect("nd-categoria", listasValidas ? listasValidas.categorias : [], "");

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

  // 👉 Se for cartão, a compra já nasce quitada (quem se paga é a fatura).
  // Então a caixa "já foi paga" não faz sentido: some.
  const blocoPago = document.getElementById("nd-toggle-pago");
  if (ehCartao) {
    blocoPago.style.display = "none";
    document.getElementById("nd-chk-pago").checked = false;
    document.getElementById("nd-bloco-datapgto").style.display = "none";
  } else {
    blocoPago.style.display = "flex";
    document.getElementById("nd-bloco-datapgto").style.display = jaPago ? "block" : "none";
  }

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
