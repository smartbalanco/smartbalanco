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
let listasValidas = null;     // categorias e métodos (vindos da aba "Dados fcnmt")
let listasValidasEm = 0;      // quando foram carregadas (para revalidar)
const LISTAS_TTL_MS = 5 * 60 * 1000;

// As categorias são digitadas direto na planilha, então a lista pode mudar
// sem o app saber. Em vez de segurar o que foi carregado no primeiro uso,
// mostra a lista atual na hora e confere com o servidor em segundo plano;
// se tiver mudado, chama aoAtualizar() para redesenhar.
function revalidarListasValidas(aoAtualizar) {
  if (Date.now() - listasValidasEm < LISTAS_TTL_MS) return;

  chamarServidor("listasValidas").then(function (rl) {
    if (!rl || !rl.ok) return;

    const antes = listasValidas
      ? listasValidas.categorias.join("|") + "##" + listasValidas.metodos.join("|")
      : "";
    listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    listasValidasEm = Date.now();

    const depois = rl.categorias.join("|") + "##" + rl.metodos.join("|");
    if (antes !== depois && typeof aoAtualizar === "function") aoAtualizar();
  }).catch(function () {
    // Sem conexão: segue com a lista que já estava em mãos.
  });
}

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

      // Login aberto PELO aplicativo: devolve a sessão para ele e encerra aqui
      if (ehLoginParaAplicativo()) { devolverSessaoAoAplicativo(r.sessao); return; }

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
// FATURAS DE CARTÃO NA LISTA DE CONTAS A VENCER
// A compra no cartão não é uma conta a pagar sozinha: o servidor manda as
// compras já somadas por cartão + vencimento, e o que se liquida é a fatura
// inteira, carimbando a data em todas as compras dela de uma vez.
// ============================================================================
let faturasNaTela = [];

function alternarItensFatura(idLista, botao) {
  const el = document.getElementById(idLista);
  if (!el) return;

  const aberto = el.classList.toggle("aberto");
  if (botao) {
    botao.textContent = botao.textContent.replace(
      aberto ? "· ver" : "· ocultar",
      aberto ? "· ocultar" : "· ver"
    );
  }
}

async function liquidarFaturaNaTela(indice) {
  const f = faturasNaTela[indice];
  if (!f) return;

  // Vindo do widget ou do calendário, valor e quantidade podem não ser
  // conhecidos — nesse caso o texto não inventa números.
  let detalhe;
  if (f.qtd > 0) detalhe = formatarMoeda(f.valor) + " em " + f.qtd + " compra(s).";
  else if (f.valor > 0) detalhe = formatarMoeda(f.valor) + ".";
  else detalhe = "Todas as compras em aberto dessa fatura.";

  const confirmou = confirm(
    "Liquidar a " + f.descricao + "?\n\n" + detalhe + "\n\n" +
    "Todas ficarão com a data de pagamento de hoje."
  );
  if (!confirmou) return;

  mostrarToast("⏳ Liquidando " + f.descricao + "...", true);

  try {
    const r = await chamarServidor("liquidarFatura", {
      cartao: f.cartao,
      vencimento: f.vencimento,
      dataPagamento: dataHojeISO()
    });

    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      limparTodoCache();
      await recarregarDados();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não foi possível liquidar."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. Nada foi alterado.");
  }
}

// ============================================================================
// EDITAR LANÇAMENTO
// Em compra parcelada é preciso dizer até onde a mudança vai: desta parcela
// em diante ou todas. Quem aplica a regra é o servidor (editarLancamento);
// aqui só se escolhe o escopo e os campos.
// ============================================================================
let edicaoAtual = null;
let escopoEdicao = "adiante";

async function abrirEdicao(numMov) {
  const it = (resultadosBusca || []).filter(function (x) { return x.numMov === numMov; })[0] || itemDetalhe;
  if (!it) return;

  edicaoAtual = it;
  escopoEdicao = "adiante";

  // Garante as listas para os seletores
  if (!listasValidas) {
    try {
      const rl = await chamarServidor("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) { listasValidas = { categorias: [], metodos: [] }; }
  }

  document.getElementById("modal-editar").style.display = "flex";
  document.getElementById("edt-mov").textContent = "MOV-" + it.numMov;
  document.getElementById("edt-descricao").value = it.descricao || "";
  document.getElementById("edt-valor").value = (parseFloat(it.valor) || 0).toFixed(2);
  document.getElementById("edt-vencimento").value = converterDataParaISO(it.vencimento) || "";
  document.getElementById("edt-aviso").textContent = "";

  montarSelect("edt-metodo", listasValidas.metodos, it.metodo || "");
  definirCategoriaCampo("edt-categoria", it.categoria || "");

  // Escolha do escopo só aparece quando há mais de uma parcela
  const partes = (it.parcela || "").toString().split("/");
  const totalParc = partes.length === 2 ? (parseInt(partes[1]) || 1) : 1;
  const parcAtual = partes.length === 2 ? (parseInt(partes[0]) || 1) : 1;

  const bloco = document.getElementById("edt-escopo-bloco");
  if (totalParc > 1) {
    bloco.classList.add("aberto");
    document.getElementById("edt-escopo-info").textContent =
      "Esta é a parcela " + parcAtual + " de " + totalParc + ". O que a alteração deve pegar?";
    definirEscopoEdicao("adiante");
  } else {
    bloco.classList.remove("aberto");
  }
}

function fecharEdicao() {
  document.getElementById("modal-editar").style.display = "none";
  edicaoAtual = null;
}

function definirEscopoEdicao(qual) {
  escopoEdicao = (qual === "todas") ? "todas" : "adiante";
  document.getElementById("edt-op-adiante").classList.toggle("ativa", escopoEdicao === "adiante");
  document.getElementById("edt-op-todas").classList.toggle("ativa", escopoEdicao === "todas");
}

async function salvarEdicao() {
  if (!edicaoAtual) return;

  const btn = document.getElementById("edt-btn-salvar");
  const aviso = document.getElementById("edt-aviso");

  const descricao = document.getElementById("edt-descricao").value.trim();
  const categoria = document.getElementById("edt-categoria").value;

  if (!descricao) { aviso.textContent = "A descrição não pode ficar vazia."; return; }
  if (!categoria) { aviso.textContent = "Escolha a categoria."; return; }

  btn.disabled = true;
  btn.textContent = "Salvando...";

  try {
    const r = await chamarServidor("editarLancamento", {
      numMov: edicaoAtual.numMov,
      escopo: escopoEdicao,
      descricao: descricao,
      categoria: categoria,
      metodo: document.getElementById("edt-metodo").value,
      valorParcela: document.getElementById("edt-valor").value,
      vencimento: document.getElementById("edt-vencimento").value
    });

    if (r.ok) {
      fecharEdicao();
      mostrarToast("✅ " + r.mensagem);
      limparTodoCache();
      fecharDetalhe();
      await recarregarDados();
      if (typeof executarBusca === "function" && resultadosBusca && resultadosBusca.length) {
        executarBusca(true);
      }
    } else {
      aviso.textContent = r.mensagem || "Não foi possível salvar.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão. Nada foi alterado.";
  } finally {
    // Sempre devolve o botão: sem isso, a segunda edição pegaria ele travado.
    btn.disabled = false;
    btn.textContent = "Salvar";
  }
}

// ============================================================================
// NOTIFICAÇÕES LOCAIS (só dentro do aplicativo Android)
// Nada de servidor de push: o próprio aparelho guarda os avisos das contas a
// vencer. O reagendamento acontece toda vez que o dashboard carrega, o que
// basta para contas com vencimento conhecido.
// No navegador, tudo aqui é silenciosamente ignorado.
// ============================================================================
const ID_BASE_NOTIFICACAO = 10000;   // acima disso, as notificações são nossas

function rodandoNoAplicativo() {
  try {
    return !!(window.Capacitor &&
              typeof window.Capacitor.isNativePlatform === "function" &&
              window.Capacitor.isNativePlatform());
  } catch (e) { return false; }
}

function pluginNotificacoes() {
  try { return window.Capacitor.Plugins.LocalNotifications || null; }
  catch (e) { return null; }
}

// "dd/MM" -> Date deste ano (ou do ano que vem, se a data já passou)
function dataDeDiaMes(txt) {
  const p = (txt || "").split("/");
  if (p.length !== 2) return null;

  const hoje = new Date();
  let d = new Date(hoje.getFullYear(), parseInt(p[1]) - 1, parseInt(p[0]));

  // O dashboard só manda os próximos 15 dias; se caiu bem atrás, virou o ano.
  if (d.getTime() < hoje.getTime() - (60 * 86400000)) {
    d = new Date(hoje.getFullYear() + 1, parseInt(p[1]) - 1, parseInt(p[0]));
  }
  return isNaN(d.getTime()) ? null : d;
}

async function agendarNotificacoesContas(contas) {
  if (!rodandoNoAplicativo()) return;

  const LN = pluginNotificacoes();
  if (!LN) return;

  try {
    let permissao = await LN.checkPermissions();
    if (permissao.display !== "granted") {
      permissao = await LN.requestPermissions();
      if (permissao.display !== "granted") return;
    }

    // Limpa as que este código agendou antes, para não duplicar a cada carga
    const pendentes = await LN.getPending();
    const nossas = (pendentes.notifications || [])
      .filter(function (n) { return n.id >= ID_BASE_NOTIFICACAO; })
      .map(function (n) { return { id: n.id }; });
    if (nossas.length > 0) await LN.cancel({ notifications: nossas });

    const agora = new Date();
    const aAgendar = [];

    (contas || []).forEach(function (c, i) {
      const venc = dataDeDiaMes(c.data);
      if (!venc) return;

      // Aviso às 9h do dia anterior ao vencimento
      const quando = new Date(venc.getFullYear(), venc.getMonth(), venc.getDate() - 1, 9, 0, 0);
      if (quando <= agora) return;   // já passou: não adianta agendar

      aAgendar.push({
        id: ID_BASE_NOTIFICACAO + i,
        title: c.ehFatura ? "Fatura vence amanhã" : "Conta vence amanhã",
        body: c.descricao + " · " + formatarMoeda(c.valor),
        schedule: { at: quando, allowWhileIdle: true }
      });
    });

    if (aAgendar.length > 0) await LN.schedule({ notifications: aAgendar });
  } catch (e) {
    // Notificação é um extra: se falhar, o app segue normal.
    console.warn("Notificações locais não agendadas:", e);
  }
}

// ============================================================================
// SMARTCALENDÁRIO
// Mês em grade, com as contas a vencer e os compromissos no mesmo lugar.
// Compromissos ficam na aba 'Compromissos' da planilha; as despesas vêm da
// mesma fonte do resto do app, então liquidar aqui é o mesmo fluxo do
// dashboard — nada é recalculado por fora.
// ============================================================================
let calMes = new Date().getMonth();
let calAno = new Date().getFullYear();
let calDiaEscolhido = null;      // "yyyy-MM-dd"
let calDados = { compromissos: [], despesas: [] };

function alternarMenuProdutos() {
  document.getElementById("menu-produtos").classList.toggle("aberto");
}

function irParaProduto(qual) {
  document.getElementById("menu-produtos").classList.remove("aberto");
  if (qual === "calendario") abrirCalendario();
  else trocarAba("dashboard");
}

// Fecha o menu ao tocar fora
document.addEventListener("click", function (e) {
  const menu = document.getElementById("menu-produtos");
  const botao = document.getElementById("titulo-topo");
  if (!menu || !botao) return;
  if (!menu.contains(e.target) && !botao.contains(e.target)) {
    menu.classList.remove("aberto");
  }
});

async function abrirCalendario() {
  trocarAba("calendario");

  // No calendário não há o que lançar: os botões flutuantes saem de cena.
  ["btn-nova-despesa", "btn-chat-ia"].forEach(function (id) {
    const b = document.getElementById(id);
    if (b) b.style.display = "none";
  });

  const hoje = new Date();
  calMes = hoje.getMonth();
  calAno = hoje.getFullYear();
  calDiaEscolhido = dataParaISO(hoje);

  await carregarCalendario();
}

function mudarMesCalendario(passo) {
  calMes += passo;
  if (calMes > 11) { calMes = 0; calAno++; }
  if (calMes < 0) { calMes = 11; calAno--; }
  calDiaEscolhido = null;
  carregarCalendario();
}

async function carregarCalendario() {
  document.getElementById("cal-mes-nome").textContent = MESES_NOMES[calMes] + " de " + calAno;
  document.getElementById("cal-grade").innerHTML = '<p class="vazio" style="grid-column:1/8;">Carregando...</p>';

  try {
    const r = await chamarServidor("dadosCalendario", { mes: calMes, ano: calAno });
    calDados = r.ok ? { compromissos: r.compromissos || [], despesas: r.despesas || [] }
                    : { compromissos: [], despesas: [] };
    if (!r.ok) mostrarToast("❌ " + (r.mensagem || "Não consegui carregar o mês."));
  } catch (e) {
    calDados = { compromissos: [], despesas: [] };
    mostrarToast("❌ Sem conexão.");
  }

  desenharGradeCalendario();
  mostrarDiaCalendario(calDiaEscolhido);
}

function desenharGradeCalendario() {
  const grade = document.getElementById("cal-grade");
  const primeiro = new Date(calAno, calMes, 1);
  const diasNoMes = new Date(calAno, calMes + 1, 0).getDate();
  const hojeISO = dataParaISO(new Date());

  // Quais dias têm o quê
  const comDespesa = {};
  const comCompromisso = {};
  calDados.despesas.forEach(function (d) { comDespesa[d.data] = true; });
  calDados.compromissos.forEach(function (c) { comCompromisso[c.data] = true; });

  let html = "";

  // Espaços até o primeiro dia cair no dia da semana certo
  for (let i = 0; i < primeiro.getDay(); i++) {
    html += '<button class="cal-dia vazio"></button>';
  }

  for (let dia = 1; dia <= diasNoMes; dia++) {
    const iso = calAno + "-" + ("0" + (calMes + 1)).slice(-2) + "-" + ("0" + dia).slice(-2);
    const classes = ["cal-dia"];
    if (iso === hojeISO) classes.push("hoje");
    if (iso === calDiaEscolhido) classes.push("escolhido");

    let pontos = "";
    if (comDespesa[iso]) pontos += '<i class="ponto despesa"></i>';
    if (comCompromisso[iso]) pontos += '<i class="ponto compromisso"></i>';

    html +=
      '<button class="' + classes.join(" ") + '" onclick="mostrarDiaCalendario(\'' + iso + '\')">' +
        '<span>' + dia + '</span>' +
        '<span class="cal-pontos">' + pontos + '</span>' +
      '</button>';
  }

  grade.innerHTML = html;
}

function mostrarDiaCalendario(iso) {
  calDiaEscolhido = iso;
  desenharGradeCalendario();

  const titulo = document.getElementById("cal-dia-titulo");
  const alvo = document.getElementById("cal-dia-conteudo");

  if (!iso) {
    titulo.textContent = "Selecione um dia";
    alvo.innerHTML = '<p class="vazio">Toque num dia do calendário.</p>';
    return;
  }

  const p = iso.split("-");
  titulo.textContent = p[2] + " de " + MESES_NOMES[parseInt(p[1]) - 1];

  const compromissos = calDados.compromissos.filter(function (c) { return c.data === iso; });
  const despesas = calDados.despesas.filter(function (d) { return d.data === iso; });

  if (compromissos.length === 0 && despesas.length === 0) {
    alvo.innerHTML = '<p class="vazio">Nada neste dia.</p>';
    return;
  }

  let html = "";

  compromissos
    .sort(function (a, b) { return (a.hora || "99").localeCompare(b.hora || "99"); })
    .forEach(function (c) {
      const detalhe = [c.hora, c.local].filter(function (x) { return x; }).join(" · ");
      html +=
        '<div class="cal-item' + (c.concluido ? " feito" : "") + '">' +
          '<div class="cal-item-info" onclick="abrirCompromisso(\'' + c.id + '\')">' +
            '<div class="cal-item-titulo">📌 ' + escaparHtml(c.titulo) + '</div>' +
            (detalhe ? '<div class="cal-item-sub">' + escaparHtml(detalhe) + '</div>' : '') +
          '</div>' +
          '<button class="cal-btn" onclick="alternarConcluido(\'' + c.id + '\', ' + (!c.concluido) + ')">' +
            (c.concluido ? "Reabrir" : "Feito") +
          '</button>' +
        '</div>';
    });

  despesas.forEach(function (d, i) {
    const acao = d.ehFatura
      ? 'liquidarFaturaDoCalendario(' + i + ')'
      : 'fecharCalendarioELiquidar(' + d.numMov + ')';

    html +=
      '<div class="cal-item">' +
        '<div class="cal-item-info">' +
          '<div class="cal-item-titulo">' + (d.ehFatura ? "💳 " : "💸 ") + escaparHtml(d.descricao) + '</div>' +
          '<div class="cal-item-sub">' + (d.numMov ? "MOV-" + d.numMov : "fatura") + '</div>' +
        '</div>' +
        '<span class="cal-item-valor">' + formatarMoeda(d.valor) + '</span>' +
        '<button class="cal-btn" onclick="' + acao + '">Liquidar</button>' +
      '</div>';
  });

  alvo.innerHTML = html;
}

// Liquidar do calendário reusa o fluxo do dashboard, em vez de refazer a regra
function fecharCalendarioELiquidar(numMov) {
  abrirLiquidacao(numMov);
}

async function liquidarFaturaDoCalendario(indice) {
  const despesasDoDia = calDados.despesas.filter(function (d) { return d.data === calDiaEscolhido; });
  const f = despesasDoDia[indice];
  if (!f || !f.ehFatura) return;

  faturasNaTela = [{
    cartao: f.cartao,
    vencimento: f.vencimento,
    descricao: f.descricao,
    valor: f.valor,
    qtd: 0
  }];
  await liquidarFaturaNaTela(0);
  carregarCalendario();
}

// ---------- Compromissos ----------
function abrirCompromisso(id) {
  const modal = document.getElementById("modal-compromisso");
  modal.style.display = "flex";

  const existente = id ? calDados.compromissos.filter(function (c) { return c.id === id; })[0] : null;

  document.getElementById("cp-id").value = existente ? existente.id : "";
  document.getElementById("cp-nome").value = existente ? existente.titulo : "";
  document.getElementById("cp-data").value = existente ? existente.data : (calDiaEscolhido || dataHojeISO());
  document.getElementById("cp-hora").value = existente ? existente.hora : "";
  document.getElementById("cp-local").value = existente ? existente.local : "";
  document.getElementById("cp-lembrete").value = existente ? String(existente.lembrete || 0) : "60";
  document.getElementById("cp-aviso").textContent = "";

  document.getElementById("cp-titulo-modal").textContent = existente ? "📅 Editar compromisso" : "📅 Novo compromisso";
  document.getElementById("cp-btn-excluir").style.display = existente ? "block" : "none";
}

function fecharCompromisso() {
  document.getElementById("modal-compromisso").style.display = "none";
}

async function salvarCompromissoApp() {
  const aviso = document.getElementById("cp-aviso");
  const btn = document.getElementById("cp-btn-salvar");

  const titulo = document.getElementById("cp-nome").value.trim();
  const data = document.getElementById("cp-data").value;

  if (!titulo) { aviso.textContent = "Dê um nome ao compromisso."; return; }
  if (!data) { aviso.textContent = "Escolha a data."; return; }

  btn.disabled = true;
  btn.textContent = "Salvando...";

  try {
    const r = await chamarServidor("salvarCompromisso", {
      id: document.getElementById("cp-id").value,
      titulo: titulo,
      data: data,
      hora: document.getElementById("cp-hora").value,
      local: document.getElementById("cp-local").value.trim(),
      lembrete: document.getElementById("cp-lembrete").value
    });

    if (r.ok) {
      fecharCompromisso();
      mostrarToast("✅ " + r.mensagem);
      calDiaEscolhido = data;
      await carregarCalendario();
    } else {
      aviso.textContent = r.mensagem || "Não foi possível salvar.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão. Nada foi salvo.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar";
  }
}

async function excluirCompromissoApp() {
  const id = document.getElementById("cp-id").value;
  if (!id) return;
  if (!confirm("Excluir este compromisso?")) return;

  try {
    const r = await chamarServidor("excluirCompromisso", { id: id });
    if (r.ok) {
      fecharCompromisso();
      mostrarToast("✅ " + r.mensagem);
      await carregarCalendario();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não foi possível excluir."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

async function alternarConcluido(id, novoEstado) {
  try {
    const r = await chamarServidor("concluirCompromisso", { id: id, concluido: novoEstado ? "true" : "false" });
    if (r.ok) {
      const c = calDados.compromissos.filter(function (x) { return x.id === id; })[0];
      if (c) c.concluido = novoEstado;
      mostrarDiaCalendario(calDiaEscolhido);
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não deu."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

// ============================================================================
// ATUALIZAÇÃO DO APLICATIVO
// O app pergunta ao GitHub qual é a última versão publicada e compara com a
// instalada. Só o que é nativo (widget, notificação, permissão) exige APK
// novo — mudança de tela chega sozinha, porque o app carrega o site.
// No navegador nada disso roda.
// ============================================================================
const API_RELEASES = "https://api.github.com/repos/pvsm23/smartbalanco-android/releases/latest";
// Link fixo: sempre serve o APK da última versão publicada.
const LINK_APK = "https://github.com/pvsm23/smartbalanco-android/releases/latest/download/Smartbalanco.apk";

// Compara "1.10" com "1.9" corretamente (comparar como texto diria que 1.10 < 1.9)
function versaoEhMaior(nova, atual) {
  const a = (nova || "").split(".").map(function (n) { return parseInt(n) || 0; });
  const b = (atual || "").split(".").map(function (n) { return parseInt(n) || 0; });
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function verificarAtualizacaoApp() {
  if (!rodandoNoAplicativo()) return;

  try {
    const A = window.Capacitor.Plugins.App;
    if (!A || !A.getInfo) return;

    const info = await A.getInfo();
    const instalada = info.version || "0";

    const resp = await fetch(API_RELEASES, { headers: { "Accept": "application/vnd.github+json" } });
    if (!resp.ok) return;

    const dados = await resp.json();
    const tag = (dados.tag_name || "").replace(/^v/, "");
    if (!tag || !versaoEhMaior(tag, instalada)) return;

    const apk = (dados.assets || []).filter(function (a) {
      return a.name === "Smartbalanco.apk";
    })[0];
    if (!apk) return;

    mostrarAvisoAtualizacao(tag, instalada, apk.browser_download_url);
  } catch (e) {
    // Sem rede ou GitHub fora do ar: não atrapalha o uso do app.
    console.warn("Não consegui verificar atualização:", e);
  }
}

function mostrarAvisoAtualizacao(nova, atual, url) {
  const caixa = document.getElementById("aviso-atualizacao");
  if (!caixa) return;

  caixa.innerHTML =
    '<div class="av-titulo">📲 Versão ' + escaparHtml(nova) + ' disponível</div>' +
    '<div class="av-texto">Você está na ' + escaparHtml(atual) + '. ' +
    'A instalação abre o arquivo baixado — é normal o Android pedir confirmação.</div>' +
    '<div class="av-acoes">' +
      '<button class="av-btn depois" onclick="dispensarAtualizacao()">Depois</button>' +
      '<button class="av-btn baixar" onclick="baixarAtualizacao(\'' + url + '\')">Baixar</button>' +
    '</div>';
  caixa.style.display = "block";
}

function dispensarAtualizacao() {
  const caixa = document.getElementById("aviso-atualizacao");
  if (caixa) caixa.style.display = "none";
}

async function baixarAtualizacao(url) {
  try {
    const B = window.Capacitor.Plugins.Browser;
    if (B && B.open) await B.open({ url: url });
    else window.open(url, "_blank");
    dispensarAtualizacao();
  } catch (e) {
    mostrarToast("❌ Não consegui abrir o download.");
  }
}

// ============================================================================
// WIDGET DA TELA INICIAL (só dentro do aplicativo Android)
// O widget roda fora da WebView e não consegue chamar este JavaScript. A ponte
// é o armazenamento nativo: aqui se grava um resumo com o plugin Preferences
// (que por baixo escreve no SharedPreferences "CapacitorStorage"), e o widget
// lê de lá. Depois de gravar, pede o redesenho — senão ele só atualizaria no
// ciclo de 30 minutos do Android e mostraria dado velho logo após liquidar
// uma conta.
// ============================================================================
async function atualizarWidget(dashboard) {
  if (!rodandoNoAplicativo()) return;

  try {
    const P = window.Capacitor.Plugins.Preferences;
    if (!P) return;

    const contas = (dashboard && dashboard.contasAVencer) ? dashboard.contasAVencer : [];

    // O widget mostra UM dia: o próximo que tem conta a vencer, com tudo que
    // vence nele. A lista já vem ordenada por vencimento, então o dia do
    // primeiro item é esse dia.
    const dia = contas.length > 0 ? contas[0].data : "";
    const doDia = contas.filter(function (c) { return c.data === dia; });

    let total = 0;
    const lista = doDia.map(function (c) {
      total += (parseFloat(c.valor) || 0);
      return {
        descricao: (c.ehFatura ? "💳 " : "") + c.descricao,
        valor: formatarMoeda(c.valor),
        // O botão "Liquidar" do widget precisa saber o que abrir
        numMov: c.numMov || 0,
        ehFatura: !!c.ehFatura,
        cartao: c.cartao || "",
        vencimento: c.vencimento || ""
      };
    });

    const agora = new Date();
    const hora = ("0" + agora.getHours()).slice(-2) + ":" + ("0" + agora.getMinutes()).slice(-2);
    const qtd = lista.length === 1 ? "1 conta" : lista.length + " contas";

    await P.set({ key: "widget_lista", value: JSON.stringify(lista) });
    await P.set({ key: "widget_dia", value: dia });
    await P.set({ key: "widget_dia_total", value: lista.length > 0 ? formatarMoeda(total) : "" });
    await P.set({ key: "widget_dia_qtd", value: lista.length > 0 ? qtd : "" });
    await P.set({ key: "widget_atualizado", value: "às " + hora });

    const W = window.Capacitor.Plugins.Widget;
    if (W && W.atualizar) await W.atualizar();
  } catch (e) {
    // O widget é um extra: se falhar, o app segue igual.
    console.warn("Widget não atualizado:", e);
  }
}

// ============================================================================
// CONFIGURAÇÕES — CATEGORIAS
// As categorias vivem na planilha no formato "2.2.004. Padaria", e é o código
// que decide se algo é receita ou despesa. Por isso aqui se escolhe o GRUPO e
// se digita só o nome: quem gera o número é o servidor. Deixar o código livre
// seria o jeito mais fácil de criar uma categoria que não entra em conta
// nenhuma.
// ============================================================================
async function abrirConfig() {
  document.getElementById("modal-config").style.display = "flex";
  document.getElementById("cfg-nova").classList.remove("aberto");

  const alvo = document.getElementById("cfg-categorias");
  alvo.innerHTML = '<p class="vazio">Carregando...</p>';

  // Sempre busca do servidor: aqui a lista precisa estar exata.
  try {
    const rl = await chamarServidor("listasValidas");
    if (rl.ok) {
      listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
      listasValidasEm = Date.now();
    }
  } catch (e) {
    alvo.innerHTML = '<p class="vazio">Sem conexão.</p>';
    return;
  }

  renderizarCategoriasConfig();
  montarCodigoAcesso();
  montarVersaoApp();

  const conta = document.getElementById("cfg-conta-email");
  if (conta) conta.textContent = emailUsuarioAtual || "";

  // Reabre sempre recolhida
  const secao = document.getElementById("cfg-secao-categorias");
  const rotulo = document.getElementById("cfg-cat-rotulo");
  if (secao) secao.style.display = "none";
  if (rotulo) rotulo.textContent = "🏷️ Editar categorias";
}

// Bloco de versão em Configurações: mostra a instalada e um botão que abre o
// download da última, sem depender de esperar o aviso automático aparecer.
async function montarVersaoApp() {
  const alvo = document.getElementById("cfg-versao");
  if (!alvo) return;

  if (!rodandoNoAplicativo()) {
    alvo.innerHTML = '<div class="cfg-aviso">Você está pelo navegador. ' +
      'O aplicativo Android tem widgets e avisos de vencimento.</div>' +
      '<button class="btn-modal confirmar" style="width:100%;" ' +
      'onclick="baixarAtualizacao(\'' + LINK_APK + '\')">📲 Baixar o aplicativo</button>';
    return;
  }

  let instalada = "?";
  try {
    const A = window.Capacitor.Plugins.App;
    if (A && A.getInfo) instalada = (await A.getInfo()).version || "?";
  } catch (e) {}

  alvo.innerHTML =
    '<div class="cfg-aviso">Versão instalada: <b>' + escaparHtml(instalada) + '</b></div>' +
    '<button class="btn-modal confirmar" style="width:100%;" ' +
    'onclick="baixarAtualizacao(\'' + LINK_APK + '\')">📲 Baixar a última versão</button>';
}

function fecharConfig() {
  document.getElementById("modal-config").style.display = "none";
}

// Separa "2.2.004. Padaria" em código e nome
function partirCategoria(texto) {
  const m = (texto || "").toString().trim().match(/^(\d+\.\d+)\.(\d+)\.?\s*(.*)$/);
  if (!m) return null;
  return { grupo: m[1], sequencial: m[2], nome: m[3] || "", completo: texto.trim() };
}

function renderizarCategoriasConfig() {
  const alvo = document.getElementById("cfg-categorias");
  const todas = (listasValidas && listasValidas.categorias) ? listasValidas.categorias : [];

  // Agrupa por prefixo (2.1, 2.2, ...) para a lista não virar um paredão
  const grupos = {};
  const foraDoPadrao = [];

  todas.forEach(function (c) {
    const p = partirCategoria(c);
    if (!p) { foraDoPadrao.push(c); return; }
    if (!grupos[p.grupo]) grupos[p.grupo] = [];
    grupos[p.grupo].push(p);
  });

  // Alimenta o seletor de grupo do formulário de criação
  const selGrupo = document.getElementById("cfg-grupo");
  const chaves = Object.keys(grupos).sort();
  selGrupo.innerHTML = chaves.map(function (g) {
    const exemplos = grupos[g].slice(0, 2).map(function (p) { return p.nome; }).join(", ");
    return '<option value="' + g + '">' + g + (exemplos ? " — " + escaparHtml(exemplos) : "") + '</option>';
  }).join("");

  let html = "";
  chaves.forEach(function (g) {
    html += '<div class="cfg-grupo-titulo">Grupo ' + g + '</div>';
    grupos[g].sort(function (a, b) { return a.sequencial.localeCompare(b.sequencial); });

    grupos[g].forEach(function (p) {
      const seguro = escaparHtml(p.completo).replace(/'/g, "&#39;");
      html +=
        '<div class="cfg-item">' +
          '<span class="cfg-item-nome">' + escaparHtml(p.nome) +
            '<span class="cfg-item-cod">' + p.grupo + '.' + p.sequencial + '</span>' +
          '</span>' +
          '<button class="cfg-btn" title="Renomear" onclick="renomearCategoriaApp(\'' + seguro + '\')">✏️</button>' +
          '<button class="cfg-btn" title="Excluir" onclick="excluirCategoriaApp(\'' + seguro + '\')">🗑️</button>' +
        '</div>';
    });
  });

  if (foraDoPadrao.length > 0) {
    html += '<div class="cfg-grupo-titulo">Fora do padrão</div>';
    foraDoPadrao.forEach(function (c) {
      html += '<div class="cfg-item"><span class="cfg-item-nome">' + escaparHtml(c) +
              '<span class="cfg-item-cod">sem código — não dá para renomear por aqui</span></span></div>';
    });
  }

  alvo.innerHTML = html || '<p class="vazio">Nenhuma categoria cadastrada.</p>';
}

// A lista de categorias é longa demais para ficar sempre aberta em
// Configurações: empurrava conta, versão e código para fora da tela.
function alternarSecaoCategorias() {
  const secao = document.getElementById("cfg-secao-categorias");
  const rotulo = document.getElementById("cfg-cat-rotulo");
  const abriu = secao.style.display === "none";

  secao.style.display = abriu ? "block" : "none";
  rotulo.textContent = abriu ? "🏷️ Ocultar categorias" : "🏷️ Editar categorias";
}

function alternarNovaCategoria() {
  const box = document.getElementById("cfg-nova");
  const abriu = box.classList.toggle("aberto");
  if (abriu) {
    document.getElementById("cfg-nome").value = "";
    document.getElementById("cfg-previa").textContent =
      "O código é gerado automaticamente dentro do grupo escolhido.";
    document.getElementById("cfg-nome").focus();
  }
}

async function salvarNovaCategoria() {
  const grupo = document.getElementById("cfg-grupo").value;
  const nome = document.getElementById("cfg-nome").value.trim();
  const aviso = document.getElementById("cfg-previa");

  if (!nome) {
    aviso.textContent = "Digite um nome para a categoria.";
    return;
  }

  aviso.textContent = "Criando...";

  try {
    const r = await chamarServidor("criarCategoria", { grupo: grupo, nome: nome });

    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      document.getElementById("cfg-nova").classList.remove("aberto");
      listasValidasEm = 0;          // força a próxima revalidação
      await abrirConfig();
    } else {
      aviso.textContent = r.mensagem || "Não foi possível criar.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão.";
  }
}

async function renomearCategoriaApp(categoria) {
  const p = partirCategoria(categoria);
  if (!p) return;

  const novo = prompt(
    "Novo nome para a categoria:\n\n" + categoria +
    "\n\nO código " + p.grupo + "." + p.sequencial + " é mantido, e os lançamentos " +
    "que já usam essa categoria são atualizados junto.",
    p.nome
  );
  if (novo === null) return;

  const nome = novo.trim();
  if (!nome || nome === p.nome) return;

  mostrarToast("⏳ Renomeando...", true);

  try {
    const r = await chamarServidor("renomearCategoria", { categoria: categoria, nome: nome });

    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      listasValidasEm = 0;
      limparTodoCache();
      await abrirConfig();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não foi possível renomear."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. Nada foi alterado.");
  }
}

async function excluirCategoriaApp(categoria) {
  if (!confirm("Excluir a categoria?\n\n" + categoria +
               "\n\nSó é possível se nenhum lançamento estiver usando ela.")) return;

  mostrarToast("⏳ Excluindo...", true);

  try {
    const r = await chamarServidor("excluirCategoria", { categoria: categoria });

    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      listasValidasEm = 0;
      await abrirConfig();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não foi possível excluir."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. Nada foi alterado.");
  }
}

// ============================================================================
// PREVISÃO DE CONTAS ("Ver tudo" das contas a vencer)
// O dashboard mostra só 15 dias à frente. Aqui o período é escolhido: um mês
// ou um intervalo livre, para dar previsibilidade do que ainda vai vencer.
// ============================================================================
let faturasPrevisao = [];   // faturas exibidas na previsão (para expandir)

function abrirPrevisao() {
  document.getElementById("modal-previsao").style.display = "flex";

  const hoje = new Date();

  // Preenche os seletores de mês/ano na primeira abertura
  const selMes = document.getElementById("pv-mes");
  if (!selMes.options.length) {
    selMes.innerHTML = opcoesMeses(hoje.getMonth());
    document.getElementById("pv-ano").innerHTML = opcoesAnos(hoje.getFullYear());
  }

  // Período personalizado começa em hoje -> fim do mês que vem
  if (!document.getElementById("pv-de").value) {
    const fimProximo = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 0);
    document.getElementById("pv-de").value = dataHojeISO();
    document.getElementById("pv-ate").value = dataParaISO(fimProximo);
  }

  // Abre já mostrando o mês corrente
  previsaoAtalho("mes");
}

function fecharPrevisao() {
  document.getElementById("modal-previsao").style.display = "none";
}

function dataParaISO(d) {
  return d.getFullYear() + "-" +
         ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
         ("0" + d.getDate()).slice(-2);
}

function marcarChipPrevisao(qual) {
  const chips = document.querySelectorAll("#modal-previsao .pv-chip");
  for (let i = 0; i < chips.length; i++) chips[i].classList.remove("ativo");
  if (qual != null && chips[qual]) chips[qual].classList.add("ativo");
}

function previsaoAtalho(qual) {
  const hoje = new Date();
  let de, ate, indice;

  if (qual === "mes") {
    de = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    ate = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
    indice = 0;
  } else if (qual === "proximo") {
    de = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
    ate = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 0);
    indice = 1;
  } else if (qual === "3meses") {
    de = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    ate = new Date(hoje.getFullYear(), hoje.getMonth() + 3, 0);
    indice = 2;
  } else {
    de = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    ate = new Date(hoje.getFullYear(), hoje.getMonth() + 6, 0);
    indice = 3;
  }

  marcarChipPrevisao(indice);
  carregarPrevisao({ de: dataParaISO(de), ate: dataParaISO(ate) });
}

function verPrevisaoMes() {
  marcarChipPrevisao(null);
  carregarPrevisao({
    mes: document.getElementById("pv-mes").value,
    ano: document.getElementById("pv-ano").value
  });
}

function verPrevisaoPeriodo() {
  const de = document.getElementById("pv-de").value;
  const ate = document.getElementById("pv-ate").value;

  if (!de || !ate) {
    document.getElementById("pv-resultado").innerHTML =
      '<p class="vazio">Preencha as duas datas.</p>';
    return;
  }

  marcarChipPrevisao(null);
  carregarPrevisao({ de: de, ate: ate });
}

async function carregarPrevisao(params) {
  const alvo = document.getElementById("pv-resultado");
  alvo.innerHTML = '<p class="vazio">Carregando...</p>';

  try {
    const r = await chamarServidor("previsaoContas", params);

    if (!r.ok) {
      alvo.innerHTML = '<p class="vazio">' + escaparHtml(r.mensagem || "Não foi possível carregar.") + '</p>';
      return;
    }

    renderizarPrevisao(r);
  } catch (e) {
    alvo.innerHTML = '<p class="vazio">Sem conexão. Tente de novo.</p>';
  }
}

function renderizarPrevisao(r) {
  const alvo = document.getElementById("pv-resultado");
  faturasPrevisao = [];

  if (!r.meses || r.meses.length === 0) {
    alvo.innerHTML =
      '<div class="pv-total">' +
        '<div class="pv-total-valor">' + formatarMoeda(0) + '</div>' +
        '<div class="pv-total-info">Nada em aberto de ' + r.de + ' a ' + r.ate + '</div>' +
      '</div>';
    return;
  }

  let html =
    '<div class="pv-total">' +
      '<div class="pv-total-valor">' + formatarMoeda(r.total) + '</div>' +
      '<div class="pv-total-info">' + r.quantidade + ' lançamento(s) · ' + r.de + ' a ' + r.ate + '</div>' +
    '</div>';

  r.meses.forEach(function (m) {
    html +=
      '<div class="pv-mes">' +
        '<div class="pv-mes-topo">' +
          '<span class="pv-mes-nome">' + escaparHtml(m.rotulo) + '</span>' +
          '<span class="pv-mes-total">' + formatarMoeda(m.total) + '</span>' +
        '</div>';

    m.itens.forEach(function (it) {
      if (it.ehFatura) {
        const iF = faturasPrevisao.push(it) - 1;
        const idItens = "pv-fatura-" + iF;
        const htmlItens = (it.itens || []).map(function (c) {
          return '<div class="fi-linha">' +
                   '<span>' + escaparHtml(c.descricao) + '</span>' +
                   '<span>' + formatarMoeda(c.valor) + '</span>' +
                 '</div>';
        }).join("");

        html +=
          '<div class="pv-item">' +
            '<div>' +
              '<span class="pv-item-data">' + it.data + '</span>' +
              '💳 ' + escaparHtml(it.descricao) +
              '<div class="li-mov fatura-toggle" onclick="alternarItensFatura(\'' + idItens + '\', this)">' +
                (it.itens || []).length + ' compras · ver' +
              '</div>' +
              '<div class="fatura-itens" id="' + idItens + '">' + htmlItens + '</div>' +
            '</div>' +
            '<span class="pv-item-valor vermelho">' + formatarMoeda(it.valor) + '</span>' +
          '</div>';
      } else {
        html +=
          '<div class="pv-item">' +
            '<div>' +
              '<span class="pv-item-data">' + it.data + '</span>' +
              escaparHtml(it.descricao) +
            '</div>' +
            '<span class="pv-item-valor vermelho">' + formatarMoeda(it.valor) + '</span>' +
          '</div>';
      }
    });

    html += '</div>';
  });

  alvo.innerHTML = html;
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
    faturasNaTela = [];

    d.contasAVencer.forEach(function (c) {
      const item = document.createElement("div");
      item.className = "linha-item";

      // ---- Fatura de cartão: as compras vêm somadas numa linha só ----
      if (c.ehFatura) {
        const iFatura = faturasNaTela.push({
          cartao: c.cartao,
          vencimento: c.vencimento,
          descricao: c.descricao,
          valor: c.valor,
          qtd: (c.itens || []).length
        }) - 1;

        const idItens = "fatura-itens-" + iFatura;
        const htmlItens = (c.itens || []).map(function (it) {
          return '<div class="fi-linha">' +
                   '<span>' + escaparHtml(it.descricao) + '</span>' +
                   '<span>' + formatarMoeda(it.valor) + '</span>' +
                 '</div>';
        }).join("");

        item.innerHTML =
          '<div class="li-esq">' +
            '<div><b class="li-data">' + c.data + '</b> 💳 ' + escaparHtml(c.descricao) + '</div>' +
            '<div class="li-mov fatura-toggle" onclick="alternarItensFatura(\'' + idItens + '\', this)">' +
              (c.itens || []).length + ' compras · ver' +
            '</div>' +
            '<div class="fatura-itens" id="' + idItens + '">' + htmlItens + '</div>' +
          '</div>' +
          '<div class="li-dir">' +
            '<span class="li-valor vermelho">' + formatarMoeda(c.valor) + '</span>' +
            '<div class="li-botoes">' +
              '<button class="btn-liquidar" onclick="liquidarFaturaNaTela(' + iFatura + ')">Liquidar fatura</button>' +
            '</div>' +
          '</div>';
        listaVencer.appendChild(item);
        return;
      }

      // Botão de copiar código (só se a despesa tiver boleto/PIX salvo)
      const btnCopiar = c.codigoPagamento
        ? '<button class="btn-copiar" data-codigo="' + escaparHtml(c.codigoPagamento) +
          '" onclick="copiarCodigo(this)" title="Copiar código de pagamento">📋</button>'
        : '';

      item.innerHTML =
        '<div class="li-esq">' +
          '<div><b class="li-data">' + c.data + '</b> ' + escaparHtml(c.descricao) + '</div>' +
          '<div class="li-mov">MOV-' + c.numMov + '</div>' +
        '</div>' +
        '<div class="li-dir">' +
          '<span class="li-valor vermelho">' + formatarMoeda(c.valor) + '</span>' +
          '<div class="li-botoes">' +
            btnCopiar +
            '<button class="btn-liquidar" onclick="abrirLiquidacao(' + c.numMov + ')">Liquidar</button>' +
          '</div>' +
        '</div>';
      listaVencer.appendChild(item);
    });
  }

  // Reagenda os avisos e alimenta o widget (só fazem algo dentro do aplicativo)
  agendarNotificacoesContas(d.contasAVencer);
  atualizarWidget(d);

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

// ============================================================================
// LOGIN DO APLICATIVO PELO NAVEGADOR
// O Google não deixa o login rodar dentro da WebView de um app. Então o app
// abre o navegador de verdade nesta mesma página, com ?paraApp=1; aqui o
// login acontece normalmente e a sessão volta para o app por um endereço
// próprio (com.smartbalanco.app://login?codigo=...), que o Android entrega
// de volta ao aplicativo.
// ============================================================================
const ESQUEMA_APP = "com.smartbalanco.app";

function ehLoginParaAplicativo() {
  try {
    return new URLSearchParams(location.search).get("paraApp") === "1";
  } catch (e) { return false; }
}

function devolverSessaoAoAplicativo(codigo) {
  const destino = ESQUEMA_APP + "://login?codigo=" + encodeURIComponent(codigo);

  document.body.innerHTML =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'height:100vh;text-align:center;padding:24px;background:#e8ecf3;color:#1e293b;">' +
      '<div style="font-size:44px;margin-bottom:14px;">✅</div>' +
      '<h2 style="margin-bottom:8px;font-size:19px;">Pronto!</h2>' +
      '<p style="font-size:14px;color:#5b6878;line-height:1.5;">Voltando para o aplicativo...</p>' +
      '<p style="font-size:12px;color:#5b6878;margin-top:22px;line-height:1.6;">' +
        'Se nada acontecer, <a href="' + destino + '" style="color:#2c5f8a;font-weight:700;">toque aqui</a>.' +
      '</p>' +
    '</div>';

  // Alguns navegadores ignoram o redirecionamento se ele vier antes do
  // desenho da página; o pequeno atraso evita a tela em branco.
  setTimeout(function () { location.href = destino; }, 400);
}

// Dentro do aplicativo: abre o navegador para logar e espera a volta
async function entrarComGoogleNoAplicativo() {
  try {
    const B = window.Capacitor.Plugins.Browser;
    const url = location.origin + location.pathname + "?paraApp=1";
    if (B && B.open) await B.open({ url: url });
  } catch (e) {
    mostrarErroLogin("Não consegui abrir o navegador para o login.");
  }
}

// Recebe a volta do navegador (com.smartbalanco.app://login?codigo=...)
function escutarVoltaDoLogin() {
  if (!rodandoNoAplicativo()) return;

  try {
    const A = window.Capacitor.Plugins.App;
    if (!A || !A.addListener) return;

    A.addListener("appUrlOpen", async function (evento) {
      const url = (evento && evento.url) ? evento.url : "";

      // Botão "Liquidar" do widget
      if (url.indexOf(ESQUEMA_APP + "://liquidar") === 0) {
        tratarLiquidacaoDoWidget(url);
        return;
      }

      // Atalhos do widget de ações (e o "+")
      if (tratarAtalhoDeTela(url)) return;

      if (url.indexOf(ESQUEMA_APP + "://login") !== 0) return;

      let codigo = "";
      try {
        codigo = new URLSearchParams(url.split("?")[1] || "").get("codigo") || "";
      } catch (e) { codigo = ""; }

      try {
        const B = window.Capacitor.Plugins.Browser;
        if (B && B.close) await B.close();
      } catch (e) {}

      if (!codigo) { mostrarErroLogin("O login não devolveu o código."); return; }

      const campo = document.getElementById("login-codigo");
      if (campo) campo.value = codigo;
      entrarComCodigo();
    });
  } catch (e) {
    console.warn("Não foi possível escutar a volta do login:", e);
  }
}

// Atalhos do widget de ações. Devolve true se a URL era de atalho.
// Cada destino cai numa tela que já existe: o widget é um caminho mais curto,
// não uma cópia paralela do app.
function tratarAtalhoDeTela(url) {
  const destinos = {
    // Vindos do pop-up nativo: a escolha já foi feita na tela inicial, então
    // aqui abre direto o formulário, sem repetir o menu.
    "novo-manual": function () { quandoTelaPronta(function () { escolherAcao("manual"); }); },
    "novo-documento": function () { quandoTelaPronta(function () { escolherAcao("lancar"); }); },
    "novo-arquivar": function () { quandoTelaPronta(function () { escolherAcao("arquivar"); }); },
    "novo": function () { abrirMenuAdicionarQuandoPronto(); },
    "chat": function () { quandoTelaPronta(function () { trocarAba("chat"); }); },
    "busca": function () { quandoTelaPronta(function () { trocarAba("busca"); abrirBusca(); }); },
    "aprovacoes": function () { quandoTelaPronta(function () { trocarAba("aprovacoes"); }); },
    "relatorios": function () { quandoTelaPronta(function () { trocarAba("relatorios"); }); },
    "calendario": function () { quandoTelaPronta(function () { abrirCalendario(); }); }
  };

  const nomes = Object.keys(destinos);
  for (let i = 0; i < nomes.length; i++) {
    if (url.indexOf(ESQUEMA_APP + "://" + nomes[i]) === 0) {
      destinos[nomes[i]]();
      return true;
    }
  }
  return false;
}

// Espera o app estar realmente dentro (logado e com a tela montada) antes de
// navegar: o atalho pode chegar com o app fechado, no meio do carregamento.
function quandoTelaPronta(acao, tentativa) {
  tentativa = tentativa || 0;
  if (tentativa > 40) return;   // ~20s e desiste em silêncio

  const tela = document.getElementById("tela-interna");
  if (tela && tela.style.display !== "none" && sessaoAtual) { acao(); return; }

  setTimeout(function () { quandoTelaPronta(acao, tentativa + 1); }, 500);
}

// O atalho "+" pode chegar antes de o app terminar de entrar (ou com o app
// fechado). Espera a tela ficar pronta antes de abrir o menu, em vez de
// piscar um menu sobre a tela de carregamento.
function abrirMenuAdicionarQuandoPronto(tentativa) {
  tentativa = tentativa || 0;
  if (tentativa > 40) return;   // ~20s: desiste em silêncio

  const tela = document.getElementById("tela-interna");
  const pronto = tela && tela.style.display !== "none" && sessaoAtual;

  if (pronto && typeof abrirMenuAdicionar === "function") {
    abrirMenuAdicionar();
    return;
  }
  setTimeout(function () { abrirMenuAdicionarQuandoPronto(tentativa + 1); }, 500);
}

// Atalho "+" com o app fechado: o Android entrega a URL na abertura, não pelo
// listener, então é preciso olhar a intent inicial também.
async function verificarAtalhoDeAbertura() {
  if (!rodandoNoAplicativo()) return;
  try {
    const A = window.Capacitor.Plugins.App;
    if (!A || !A.getLaunchUrl) return;

    const inicial = await A.getLaunchUrl();
    const url = (inicial && inicial.url) ? inicial.url : "";

    if (url.indexOf(ESQUEMA_APP + "://liquidar") === 0) tratarLiquidacaoDoWidget(url);
    else tratarAtalhoDeTela(url);
  } catch (e) { /* atalho é conveniência: falhar aqui não quebra nada */ }
}

// Liquidar a partir do widget. Não faz a baixa direto: abre a mesma tela de
// liquidação do app, para você conferir valor e data antes de confirmar —
// dar baixa com um toque solto na tela inicial é fácil demais de errar.
function tratarLiquidacaoDoWidget(url, tentativa) {
  tentativa = tentativa || 0;
  if (tentativa > 40) return;

  const tela = document.getElementById("tela-interna");
  const pronto = tela && tela.style.display !== "none" && sessaoAtual;

  if (!pronto) {
    setTimeout(function () { tratarLiquidacaoDoWidget(url, tentativa + 1); }, 500);
    return;
  }

  let params;
  try {
    params = new URLSearchParams(url.split("?")[1] || "");
  } catch (e) { return; }

  // Fatura: reaproveita o fluxo de liquidação em lote do dashboard
  if (url.indexOf(ESQUEMA_APP + "://liquidarFatura") === 0) {
    const cartao = params.get("cartao") || "";
    const venc = params.get("venc") || "";
    if (!cartao || !venc) return;

    faturasNaTela = [{
      cartao: cartao,
      vencimento: venc,
      descricao: "Fatura " + cartao,
      valor: 0,
      qtd: 0
    }];
    liquidarFaturaNaTela(0);
    return;
  }

  const mov = parseInt(params.get("mov"));
  if (!isNaN(mov) && mov > 0) abrirLiquidacao(mov);
}

// ============================================================================
// ENTRAR COM CÓDIGO DE ACESSO
// O login do Google não roda dentro do WebView do aplicativo — o próprio
// Google bloqueia esse fluxo em WebView por segurança. Como o servidor já
// trabalha com sessão de 30 dias que se renova a cada uso, o app aceita o
// código gerado no navegador: entra-se uma vez e pronto.
// ============================================================================
function alternarLoginCodigo() {
  const area = document.getElementById("login-codigo-area");
  const abriu = area.classList.toggle("aberto");
  if (abriu) document.getElementById("login-codigo").focus();
}

async function entrarComCodigo() {
  const campo = document.getElementById("login-codigo");
  const codigo = (campo.value || "").trim();
  const btn = document.getElementById("btn-entrar-codigo");

  if (!codigo) { mostrarErroLogin("Cole o código de acesso."); return; }

  const anterior = sessaoAtual;
  btn.disabled = true;
  btn.textContent = "Entrando...";
  sessaoAtual = codigo;

  try {
    const r = await chamarServidor("login");

    if (r.ok && r.usuario) {
      emailUsuarioAtual = r.usuario;
      salvarSessao(codigo, r.usuario);
      campo.value = "";
      await entrarNoApp();
      return;
    }

    sessaoAtual = anterior;
    mostrarErroLogin(r.mensagem || "Código inválido ou expirado.");
  } catch (e) {
    sessaoAtual = anterior;
    mostrarErroLogin("Sem conexão. Tente de novo.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
}

// Mostra o código da sessão atual em Configurações, para levar ao aplicativo
function montarCodigoAcesso() {
  const alvo = document.getElementById("cfg-codigo");
  if (!alvo) return;

  if (!sessaoAtual) {
    alvo.innerHTML = '<p class="vazio">Sem sessão ativa.</p>';
    return;
  }

  alvo.innerHTML =
    '<div class="cfg-aviso">Cole este código na tela de entrada do aplicativo. ' +
    'Ele dá acesso à sua conta — não compartilhe.</div>' +
    '<div class="cfg-codigo-caixa" id="cfg-codigo-txt">' + escaparHtml(sessaoAtual) + '</div>' +
    '<button class="btn-modal confirmar" style="width:100%;" onclick="copiarCodigoAcesso()">' +
      '📋 Copiar código' +
    '</button>';
}

async function copiarCodigoAcesso() {
  try {
    await navigator.clipboard.writeText(sessaoAtual || "");
    mostrarToast("📋 Código copiado.");
  } catch (e) {
    // WebView antigo: cai no seletor manual
    const el = document.getElementById("cfg-codigo-txt");
    if (el) {
      const faixa = document.createRange();
      faixa.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(faixa);
      try {
        document.execCommand("copy");
        mostrarToast("📋 Código copiado.");
      } catch (e2) {
        mostrarToast("Selecione e copie o código manualmente.");
      }
    }
  }
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

  // 👉 Os dois botões flutuantes só aparecem no dashboard
  const noDash = (abaAtiva === "dashboard");
  document.getElementById("btn-nova-despesa").style.display = noDash ? "flex" : "none";

  const btnIA = document.getElementById("btn-chat-ia");
  if (btnIA) btnIA.style.display = noDash ? "flex" : "none";
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

  // Dentro do aplicativo: fica pronto para receber a volta do login e
  // confere se há APK novo (não bloqueia a entrada).
  escutarVoltaDoLogin();
  verificarAtualizacaoApp();
  verificarAtalhoDeAbertura();

  // ---------- 1. Já tem sessão salva no aparelho? ----------
  const salva = lerSessaoSalva();

  // Este navegador foi aberto PELO aplicativo só para logar. Se já existe
  // sessão aqui, devolve na hora — sem fazer o usuário logar de novo.
  if (ehLoginParaAplicativo() && salva.sessao) {
    devolverSessaoAoAplicativo(salva.sessao);
    return;
  }

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
  // Dentro do aplicativo o botão do Google não funciona (a WebView é
  // bloqueada por ele). Ali entra um botão que abre o navegador de verdade.
  if (rodandoNoAplicativo()) {
    const alvo = document.getElementById("botao-google");
    if (alvo) {
      alvo.innerHTML =
        '<button id="btn-google-app" onclick="entrarComGoogleNoAplicativo()">' +
          'Entrar com Google' +
        '</button>';
    }
    mostrarTelaLogin();
    return;
  }

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
  limparComprovanteLiquidacao();   // anexo da liquidação anterior não vaza
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

// ---------------------------------------------------------------------------
// COMPROVANTE ANEXADO NA LIQUIDAÇÃO
// O anexo é opcional e vai DEPOIS da baixa: se o upload falhar, a liquidação
// já está gravada e o que se perde é só o arquivo — o contrário deixaria a
// despesa em aberto por causa de uma foto.
// ---------------------------------------------------------------------------
let comprovanteLiquidacao = null;

function aoEscolherComprovante(input) {
  const arquivo = input.files && input.files[0];
  const rotulo = document.getElementById("liq-arquivo-nome");

  if (!arquivo) { comprovanteLiquidacao = null; return; }

  if (arquivo.size > 8 * 1024 * 1024) {
    mostrarToast("❌ Arquivo muito grande (máx. 8 MB).");
    input.value = "";
    return;
  }

  const leitor = new FileReader();
  leitor.onload = function (ev) {
    comprovanteLiquidacao = {
      base64: ev.target.result.split(",")[1],
      mimeType: arquivo.type || "image/jpeg",
      nome: arquivo.name || "comprovante"
    };
    if (rotulo) {
      rotulo.textContent = "📎 " + arquivo.name;
      rotulo.classList.remove("vazio-cat");
    }
  };
  leitor.readAsDataURL(arquivo);
}

function limparComprovanteLiquidacao() {
  comprovanteLiquidacao = null;
  const campo = document.getElementById("liq-arquivo");
  const rotulo = document.getElementById("liq-arquivo-nome");
  if (campo) campo.value = "";
  if (rotulo) rotulo.textContent = "Anexar comprovante";
}

// Envia o anexo já vinculado ao Nº Mov, reusando o mesmo caminho do
// "Arquivar documento" do app.
async function enviarComprovanteAnexado(doc, numMov, descricao) {
  try {
    const r = await chamarServidorPost("arquivarDocumento", {
      arquivo: doc.base64,
      mimeType: doc.mimeType,
      tipoDocumento: "Comprovante",
      descricao: descricao || ("Comprovante MOV-" + numMov),
      numMovVinculo: String(numMov)
    });
    if (r && r.ok) mostrarToast("📎 Comprovante anexado ao MOV-" + numMov + ".");
    else mostrarToast("⚠️ Liquidado, mas o comprovante não subiu.");
  } catch (e) {
    mostrarToast("⚠️ Liquidado, mas o comprovante não subiu.");
  }
}

// Faz o envio de verdade, sem travar a tela
async function enviarLiquidacao(params, numMov) {
  // Guarda e limpa antes do await: se o usuário abrir outra liquidação
  // enquanto esta viaja, o anexo não pode vazar para a despesa errada.
  const doc = comprovanteLiquidacao;
  limparComprovanteLiquidacao();

  try {
    const r = await chamarServidor("liquidar", params);
    if (r.ok) {
      mostrarToast("✅ MOV-" + numMov + " liquidado! Comprovante enviado por e-mail.");
      if (doc) await enviarComprovanteAnexado(doc, numMov, params.descricao);
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

  // Vencimento: no cartão ele continua à vista, mas preenchido pela fatura
  document.getElementById("nd-bloco-vencimento").style.display = "block";
  document.getElementById("nd-aviso-cartao").style.display = ehCartao ? "block" : "none";
  preencherVencimentoCartao("nd");

  // Data de pagamento: aparece só se marcado como pago
  document.getElementById("nd-bloco-datapgto").style.display = jaPago ? "block" : "none";

  // Mostra o valor da parcela em tempo real
  atualizarPreviaParcela();
}

// ---------------------------------------------------------------------------
// VENCIMENTO PELA FATURA DO CARTÃO
// Quem calcula é o servidor — a mesma função que grava a despesa. Assim a data
// que aparece na tela é exatamente a que vai para a planilha, em vez de uma
// conta repetida aqui que pode divergir com o tempo.
// Vale para os formulários "nd" (nova despesa) e "dr" (revisão do scanner).
// ---------------------------------------------------------------------------
async function preencherVencimentoCartao(prefixo) {
  const selMetodo = document.getElementById(prefixo + "-metodo");
  const campoVenc = document.getElementById(prefixo + "-vencimento");
  const campoCompra = document.getElementById(prefixo + "-datacompra");
  if (!selMetodo || !campoVenc) return;

  const metodo = selMetodo.value || "";
  const ehCartao = normalizarBusca(metodo).indexOf("cart") !== -1;

  // Não é cartão: a data volta a ser escolha de quem lança.
  if (!ehCartao) {
    campoVenc.readOnly = false;
    campoVenc.classList.remove("campo-automatico");
    return;
  }

  campoVenc.readOnly = true;
  campoVenc.classList.add("campo-automatico");

  try {
    const r = await chamarServidor("vencimentoCartao", {
      metodo: metodo,
      dataCompra: campoCompra ? campoCompra.value : ""
    });

    if (r && r.ok && r.ehCartao && r.vencimento) {
      campoVenc.value = r.vencimento;
      return;
    }
  } catch (e) {
    // Cai no destravamento abaixo.
  }

  // Cartão sem dia de vencimento na aba 'Config Cartões', ou sem conexão:
  // devolve o campo para o usuário em vez de deixá-lo travado e vazio.
  campoVenc.readOnly = false;
  campoVenc.classList.remove("campo-automatico");
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
  document.getElementById("conteudo-chat").style.display  = (nome === "chat")       ? "flex"  : "none";
  document.getElementById("conteudo-busca").style.display = (nome === "busca")      ? "block" : "none";
  document.getElementById("conteudo-calendario").style.display = (nome === "calendario") ? "block" : "none";
  document.getElementById("nav-mes-wrap").style.display   = (nome === "dashboard")  ? "flex"  : "none";
  document.getElementById("abas-principais").style.display =
    (nome === "chat" || nome === "busca" || nome === "calendario") ? "none" : "flex";

  document.getElementById("tab-dashboard").classList.toggle("ativa", nome === "dashboard");
  document.getElementById("tab-aprovacoes").classList.toggle("ativa", nome === "aprovacoes");
  document.getElementById("tab-relatorios").classList.toggle("ativa", nome === "relatorios");

  // Botões flutuantes: só no dashboard
  const noDash = (nome === "dashboard");
  document.getElementById("btn-nova-despesa").style.display = noDash ? "flex" : "none";
  document.getElementById("btn-chat-ia").style.display = noDash ? "flex" : "none";

  // Botão voltar (no chat e na busca)
  document.getElementById("btn-voltar").style.display =
    (nome === "chat" || nome === "busca" || nome === "calendario") ? "inline-block" : "none";

  // Título do topo
  // Só o texto muda: a seta do menu de produtos fica num span à parte, senão
  // seria apagada a cada troca de aba.
  const titulo = document.getElementById("titulo-texto");
  if (nome === "chat") titulo.textContent = "🧠 Assistente IA";
  else if (nome === "busca") titulo.textContent = "🚀 Lançamentos";
  else if (nome === "calendario") titulo.textContent = "Smartcalendário";
  else titulo.textContent = "Smartbalanço";

  if (nome === "aprovacoes") carregarAprovacoes(false);
  if (nome === "relatorios") renderizarTelaRelatorios();
  if (nome === "chat") abrirChat();
  if (nome === "busca") abrirBusca();
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

  // Pega categorias criadas na planilha depois que o app abriu
  revalidarListasValidas(function () {
    if (modal.style.display === "flex") renderizarListaCategorias(busca.value);
  });

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
  },
  gastosCategoria: {
    nome: "Gastos por Categoria",
    icone: "🗂️",
    desc: "Todos os gastos de categorias num período",
    periodo: "intervaloCategorias"
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

async function abrirPeriodo(tipo) {
  relTipoEscolhido = tipo;
  const r = RELATORIOS[tipo];

  // Se o relatório usa categorias, garante que as listas estão carregadas
  if (r.periodo === "intervaloCategorias" && !listasValidas) {
    try {
      const rl = await chamarServidor("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) { listasValidas = { categorias: [], metodos: [] }; }
  }

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

  } else if (r.periodo === "intervaloCategorias") {
    catsRelatorio = [];
    const hojeISO = dataHojeISO();
    const inicioAno = anoAtual + "-01-01";

    corpo.innerHTML =
      '<div class="linha-dupla">' +
        '<div class="campo-bloco">' +
          '<label for="mp-inicio">De</label>' +
          '<input type="date" id="mp-inicio" value="' + inicioAno + '" />' +
        '</div>' +
        '<div class="campo-bloco">' +
          '<label for="mp-fim">Até</label>' +
          '<input type="date" id="mp-fim" value="' + hojeISO + '" />' +
        '</div>' +
      '</div>' +
      '<div class="campo-bloco">' +
        '<label>Categorias</label>' +
        '<button type="button" class="btn-categoria" onclick="abrirMultiCategorias(\'relatorio\')">' +
          '<span class="cat-txt vazio-cat" id="mp-categorias-txt">Todas as categorias</span>' +
          '<span class="cat-lupa">🔍</span>' +
        '</button>' +
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
  } else if (r.periodo === "intervaloCategorias") {
    params.dataInicio = document.getElementById("mp-inicio").value;
    params.dataFim = document.getElementById("mp-fim").value;
    params.categorias = catsRelatorio.join("|");
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
  else if (res.tipo === "gastosCategoria") corpo = htmlGastosCategoria(res);

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

  } else if (r.tipo === "gastosCategoria") {
    t += "Total: " + formatarMoeda(r.resumo.total) + "\n";
    t += "Média mensal: " + formatarMoeda(r.resumo.mediaMensal) + "\n";
    t += r.resumo.quantidade + " lançamentos\n\n";
    r.grupos.forEach(function (g) {
      t += g.categoria + ": " + formatarMoeda(g.total) + " (" + g.quantidade + ")\n";
      g.itens.forEach(function (it) {
        t += "   " + it.data + " " + it.descricao + " - " + formatarMoeda(it.valor) + "\n";
      });
      t += "\n";
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

// ============================================================================
// ===================== CHAT COM IA ==========================================
// ============================================================================

const CHAVE_CHAT_HIST = "sb_chat_hist";     // histórico salvo por conta
const CHAVE_CHAT_MOTOR = "sb_chat_motor";   // motor preferido

let motorIA = "gemini";        // "gemini" ou "claude"
let historicoChat = [];        // [{role, content, uso}]
let aguardandoIA = false;

// ---------- Persistência do histórico (por conta) ----------
function chaveHistorico() {
  return CHAVE_CHAT_HIST + "_" + (emailUsuarioAtual || "anon");
}

function salvarHistoricoChat() {
  try {
    // Guarda no máximo as últimas 60 mensagens
    const recorte = historicoChat.slice(-60);
    localStorage.setItem(chaveHistorico(), JSON.stringify(recorte));
  } catch (e) {}
}

function carregarHistoricoChat() {
  try {
    const b = localStorage.getItem(chaveHistorico());
    historicoChat = b ? JSON.parse(b) : [];
  } catch (e) {
    historicoChat = [];
  }
}

function salvarMotorPreferido() {
  try { localStorage.setItem(CHAVE_CHAT_MOTOR, motorIA); } catch (e) {}
}

function carregarMotorPreferido() {
  try {
    const m = localStorage.getItem(CHAVE_CHAT_MOTOR);
    motorIA = (m === "claude") ? "claude" : "gemini";
  } catch (e) { motorIA = "gemini"; }
}

// ---------- Abrir a aba de chat ----------
function abrirChat() {
  carregarMotorPreferido();
  carregarHistoricoChat();
  atualizarBotaoMotor();
  renderizarChat();
  buscarGastoIA();

  setTimeout(function () { rolarChatParaBaixo(); }, 100);
}

// ---------- Alterna o motor ----------
function trocarMotorIA() {
  motorIA = (motorIA === "gemini") ? "claude" : "gemini";
  salvarMotorPreferido();
  atualizarBotaoMotor();

  const nome = motorIA === "claude" ? "Claude Sonnet 5 (pago)" : "Gemini (grátis)";
  mostrarToast("🔄 Motor: " + nome);
}

function atualizarBotaoMotor() {
  const btn = document.getElementById("chat-motor");
  if (!btn) return;

  if (motorIA === "claude") {
    btn.className = "chat-motor claude";
    btn.innerHTML = '<span class="cm-bolinha"></span> Claude <span class="cm-tag">pago</span>';
  } else {
    btn.className = "chat-motor gemini";
    btn.innerHTML = '<span class="cm-bolinha"></span> Gemini <span class="cm-tag">grátis</span>';
  }
}

// ---------- Gasto do mês ----------
async function buscarGastoIA() {
  try {
    const r = await chamarServidor("gastoIA");
    if (r.ok) atualizarGastoIA(r.gastoMes);
  } catch (e) {}
}

function atualizarGastoIA(g) {
  const el = document.getElementById("chat-gasto");
  if (!el || !g) return;

  if (g.brl > 0) {
    el.innerHTML = '💰 <b>R$ ' + g.brl.toFixed(2).replace(".", ",") + '</b> este mês ›';
    el.style.display = "block";
  } else {
    el.innerHTML = '💰 <b>R$ 0,00</b> este mês ›';
    el.style.display = "block";
  }
}

// ---------- Renderiza as mensagens ----------
function renderizarChat() {
  const wrap = document.getElementById("chat-mensagens");
  wrap.innerHTML = "";

  if (historicoChat.length === 0) {
    wrap.innerHTML =
      '<div class="chat-vazio">' +
        '<div class="cv-icone">🧠</div>' +
        '<h3>Converse sobre suas finanças</h3>' +
        '<p>A IA tem acesso aos seus dados dos últimos 12 meses.</p>' +
        '<div class="cv-sugestoes">' +
          '<button onclick="usarSugestao(this)">Quanto gastei em mercado nos últimos 3 meses?</button>' +
          '<button onclick="usarSugestao(this)">Onde estou gastando mais do que deveria?</button>' +
          '<button onclick="usarSugestao(this)">Consigo economizar em quê?</button>' +
          '<button onclick="usarSugestao(this)">Como está minha saúde financeira?</button>' +
        '</div>' +
      '</div>';
    return;
  }

  historicoChat.forEach(function (m) {
    const div = document.createElement("div");
    div.className = "chat-msg " + (m.role === "user" ? "usuario" : "ia");

    if (m.role === "user") {
      div.innerHTML = '<div class="cm-bolha">' + escaparHtml(m.content) + '</div>';
    } else {
      let rodape = "";
      if (m.uso) {
        const u = m.uso;
        rodape =
          '<div class="cm-rodape">' +
            '<span class="cmr-modelo">' + escaparHtml(m.modelo || "IA") + '</span>' +
            (u.custoBRL > 0
              ? '<span class="cmr-custo">$' + u.custoUSD.toFixed(4) +
                ' · R$ ' + u.custoBRL.toFixed(3).replace(".", ",") + '</span>'
              : '<span class="cmr-custo gratis">grátis</span>') +
            '<span class="cmr-tokens">' + (u.tokensEntrada + u.tokensSaida) + ' tokens</span>' +
          '</div>';
      }
      div.innerHTML =
        '<div class="cm-bolha">' + formatarRespostaIA(m.content) + '</div>' + rodape;
    }

    wrap.appendChild(div);
  });
}

// Converte a resposta da IA em HTML seguro (negrito, listas, quebras)
function formatarRespostaIA(txt) {
  let h = escaparHtml(txt);
  h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  h = h.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  h = h.replace(/^## (.+)$/gm, "<h4>$1</h4>");
  h = h.replace(/^[-•] (.+)$/gm, "<li>$1</li>");
  h = h.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");
  h = h.replace(/\n/g, "<br>");
  h = h.replace(/<\/ul><br>/g, "</ul>");
  h = h.replace(/<br><ul>/g, "<ul>");
  return h;
}

function usarSugestao(btn) {
  document.getElementById("chat-input").value = btn.textContent;
  enviarPergunta();
}

// ---------- Enviar pergunta ----------
async function enviarPergunta() {
  if (aguardandoIA) return;

  const input = document.getElementById("chat-input");
  const pergunta = input.value.trim();
  if (!pergunta) return;

  input.value = "";
  input.style.height = "auto";

  // Adiciona a pergunta na tela
  historicoChat.push({ role: "user", content: pergunta });
  renderizarChat();
  rolarChatParaBaixo();

  // Mostra o "digitando..."
  aguardandoIA = true;
  document.getElementById("chat-enviar").disabled = true;
  mostrarDigitando(true);

  // Monta o histórico para o servidor (só role e content)
  const histParaServidor = historicoChat.slice(0, -1).map(function (m) {
    return { role: m.role, content: m.content };
  });

  try {
    // 👉 POST em vez de GET: o histórico da conversa cresce a cada troca e
    // estoura o limite de tamanho da URL a partir da 2ª pergunta.
    const r = await chamarServidorPost("perguntarIA", {
      pergunta: pergunta,
      motor: motorIA,
      historico: JSON.stringify(histParaServidor)
    });

    mostrarDigitando(false);

    if (r.ok) {
      historicoChat.push({
        role: "assistant",
        content: r.resposta,
        modelo: r.modelo,
        uso: r.uso
      });
      salvarHistoricoChat();
      renderizarChat();
      if (r.gastoMes) atualizarGastoIA(r.gastoMes);
    } else {
      historicoChat.push({
        role: "assistant",
        content: "⚠️ " + (r.mensagem || "Não consegui responder."),
        modelo: "erro"
      });
      renderizarChat();
    }
  } catch (e) {
    mostrarDigitando(false);

    // Mostra o erro REAL, não uma mensagem genérica
    let detalhe = e && e.message ? e.message : String(e);
    historicoChat.push({
      role: "assistant",
      content: "⚠️ Falha ao chamar o servidor.\n\nDetalhe técnico: " + detalhe,
      modelo: "erro"
    });
    renderizarChat();
    console.error("Erro no chat:", e);
  } finally {
    aguardandoIA = false;
    document.getElementById("chat-enviar").disabled = false;
    rolarChatParaBaixo();
  }
}

function mostrarDigitando(mostrar) {
  const el = document.getElementById("chat-digitando");
  if (el) el.style.display = mostrar ? "flex" : "none";
  if (mostrar) rolarChatParaBaixo();
}

function rolarChatParaBaixo() {
  const wrap = document.getElementById("chat-scroll");
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

// Cresce a caixa de texto conforme digita
function ajustarAlturaInput(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ---------- Limpar conversa ----------
function limparConversa() {
  if (historicoChat.length === 0) return;
  if (!confirm("Apagar toda a conversa?\n\nO histórico de custos NÃO será apagado.")) return;

  historicoChat = [];
  try { localStorage.removeItem(chaveHistorico()); } catch (e) {}
  renderizarChat();
  mostrarToast("🗑️ Conversa apagada.");
}

// ============================================================================
// RELATÓRIO DE USO DA IA (ao tocar no total)
// ============================================================================
async function abrirRelatorioUsoIA() {
  const modal = document.getElementById("modal-uso-ia");
  modal.style.display = "flex";
  document.getElementById("ui-corpo").innerHTML =
    '<div style="text-align:center; padding:40px;"><div class="spinner" style="margin:0 auto;"></div></div>';

  try {
    const r = await chamarServidor("relatorioUsoIA");
    if (r.ok) {
      renderizarRelatorioUsoIA(r);
    } else {
      document.getElementById("ui-corpo").innerHTML =
        '<p class="vazio">⚠️ ' + escaparHtml(r.mensagem || "Erro ao carregar.") + '</p>';
    }
  } catch (e) {
    document.getElementById("ui-corpo").innerHTML = '<p class="vazio">⚠️ Sem conexão.</p>';
  }
}

function fecharRelatorioUsoIA() {
  document.getElementById("modal-uso-ia").style.display = "none";
}

function renderizarRelatorioUsoIA(r) {
  const mes = r.mesAtual || { usd: 0, brl: 0, chamadas: 0 };

  // --- Destaque do mês ---
  let html =
    '<div class="ui-destaque">' +
      '<div class="uid-label">Gasto neste mês</div>' +
      '<div class="uid-brl">R$ ' + mes.brl.toFixed(2).replace(".", ",") + '</div>' +
      '<div class="uid-usd">US$ ' + mes.usd.toFixed(4) + ' · ' + mes.chamadas + ' consultas</div>' +
      '<div class="uid-cotacao">Dólar: R$ ' + (r.cotacaoAtual || 0).toFixed(2).replace(".", ",") + '</div>' +
    '</div>';

  // --- Por mês ---
  if (r.meses && r.meses.length > 0) {
    let linhas = "";
    r.meses.forEach(function (m) {
      linhas +=
        '<tr>' +
          '<td>' + escaparHtml(m.nome) + '</td>' +
          '<td class="num">' + m.chamadas + '</td>' +
          '<td class="num cinza">$' + m.usd.toFixed(3) + '</td>' +
          '<td class="num"><b>R$ ' + m.brl.toFixed(2).replace(".", ",") + '</b></td>' +
        '</tr>';
    });
    html +=
      '<div class="ui-secao">' +
        '<h3>📅 Por mês</h3>' +
        '<table class="rel-tabela">' +
          '<thead><tr><th>Mês</th><th class="num">Consultas</th><th class="num">USD</th><th class="num">BRL</th></tr></thead>' +
          '<tbody>' + linhas + '</tbody>' +
        '</table>' +
      '</div>';
  }

  // --- Por usuário ---
  if (r.porUsuario && r.porUsuario.length > 0) {
    let linhas = "";
    r.porUsuario.forEach(function (u) {
      linhas +=
        '<tr>' +
          '<td class="cat">' + escaparHtml(u.email) + '</td>' +
          '<td class="num">' + u.chamadas + '</td>' +
          '<td class="num"><b>R$ ' + u.brl.toFixed(2).replace(".", ",") + '</b></td>' +
        '</tr>';
    });
    html +=
      '<div class="ui-secao">' +
        '<h3>👥 Por pessoa</h3>' +
        '<table class="rel-tabela">' +
          '<thead><tr><th>Conta</th><th class="num">Consultas</th><th class="num">Total</th></tr></thead>' +
          '<tbody>' + linhas + '</tbody>' +
        '</table>' +
      '</div>';
  }

  // --- Por modelo ---
  if (r.porMotor && r.porMotor.length > 0) {
    let linhas = "";
    r.porMotor.forEach(function (m) {
      linhas +=
        '<tr>' +
          '<td>' + escaparHtml(m.modelo) + '</td>' +
          '<td class="num">' + m.chamadas + '</td>' +
          '<td class="num"><b>' + (m.brl > 0 ? 'R$ ' + m.brl.toFixed(2).replace(".", ",") : 'grátis') + '</b></td>' +
        '</tr>';
    });
    html +=
      '<div class="ui-secao">' +
        '<h3>🤖 Por modelo</h3>' +
        '<table class="rel-tabela">' +
          '<thead><tr><th>Modelo</th><th class="num">Consultas</th><th class="num">Total</th></tr></thead>' +
          '<tbody>' + linhas + '</tbody>' +
        '</table>' +
      '</div>';
  }

  // --- Histórico detalhado ---
  if (r.historico && r.historico.length > 0) {
    let itens = "";
    r.historico.forEach(function (h) {
      itens +=
        '<div class="ui-hist">' +
          '<div class="uih-topo">' +
            '<span class="uih-data">' + escaparHtml(h.data) + '</span>' +
            '<span class="uih-custo">' +
              (h.brl > 0 ? 'R$ ' + h.brl.toFixed(3).replace(".", ",") : 'grátis') +
            '</span>' +
          '</div>' +
          '<div class="uih-pergunta">' + escaparHtml(h.pergunta) + '</div>' +
          '<div class="uih-meta">' +
            escaparHtml(h.email.split("@")[0]) + ' · ' + escaparHtml(h.modelo) + ' · ' +
            (h.tokensEntrada + h.tokensSaida) + ' tokens' +
          '</div>' +
        '</div>';
    });
    html +=
      '<div class="ui-secao">' +
        '<h3>📜 Histórico detalhado</h3>' +
        '<div class="ui-hist-lista">' + itens + '</div>' +
      '</div>';
  }

  // --- Total geral ---
  const tg = r.totalGeral || { usd: 0, brl: 0, chamadas: 0 };
  html +=
    '<div class="ui-total">' +
      '<span>Total desde o início</span>' +
      '<b>R$ ' + tg.brl.toFixed(2).replace(".", ",") + '</b>' +
    '</div>';

  document.getElementById("ui-corpo").innerHTML = html;
}

// ============================================================================
// ===================== DOCUMENTOS (foto / PDF) ==============================
// ============================================================================

let arquivoAtual = null;      // { base64, mimeType, nome, previewUrl }
let dadosExtraidos = null;    // o que a IA leu
let modoDocumento = null;     // "lancar" ou "arquivar"

// ---------- Chamada POST (para enviar arquivos grandes) ----------
async function chamarServidorPost(acao, dados) {
  const corpo = Object.assign({ acao: acao }, dados);
  if (sessaoAtual) corpo.sessao = sessaoAtual;
  else if (tokenLoginAtual) corpo.token = tokenLoginAtual;

  const resp = await fetch(API_URL, {
    method: "POST",
    // text/plain evita o "preflight" do CORS, que o Apps Script não suporta
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(corpo)
  });

  if (!resp.ok) throw new Error("Falha na conexão (HTTP " + resp.status + ").");
  return await resp.json();
}

// ============================================================================
// MENU DO BOTÃO (+)
// ============================================================================
function abrirMenuAdicionar() {
  document.getElementById("menu-adicionar").style.display = "flex";
}

function fecharMenuAdicionar() {
  document.getElementById("menu-adicionar").style.display = "none";
}

function escolherAcao(acao) {
  fecharMenuAdicionar();

  if (acao === "manual") {
    abrirNovaDespesa();
  } else if (acao === "lancar") {
    modoDocumento = "lancar";
    abrirSeletorArquivo();
  } else if (acao === "arquivar") {
    modoDocumento = "arquivar";
    abrirSeletorArquivo();
  }
}

// ============================================================================
// SELEÇÃO DO ARQUIVO
// ============================================================================
function abrirSeletorArquivo() {
  arquivoAtual = null;
  dadosExtraidos = null;

  const modal = document.getElementById("modal-doc");
  modal.style.display = "flex";

  document.getElementById("doc-titulo").textContent =
    modoDocumento === "lancar" ? "📷 Lançar por documento" : "📎 Arquivar documento";
  document.getElementById("doc-sub").textContent =
    modoDocumento === "lancar" ? "Boleto, PIX, nota, comprovante..." : "Salvar no e-mail";

  // Reseta as etapas
  document.getElementById("doc-etapa-arquivo").style.display = "block";
  document.getElementById("doc-etapa-lendo").style.display = "none";
  document.getElementById("doc-etapa-revisar").style.display = "none";
  document.getElementById("doc-erro").style.display = "none";
  document.getElementById("doc-preview").style.display = "none";
  document.getElementById("doc-observacao").value = "";
  document.getElementById("doc-btn-analisar").disabled = true;

  // O botão de confirmar fica desabilitado durante o envio e o modal fecha
  // antes da resposta chegar. Sem religar aqui, o 2º lançamento pegava o
  // botão cinza e travado em "Enviando...".
  const btnConfirmar = document.getElementById("dr-btn-confirmar");
  btnConfirmar.disabled = false;
  btnConfirmar.textContent =
    modoDocumento === "lancar" ? "📥 Enviar para aprovação" : "📎 Arquivar no e-mail";

  document.getElementById("doc-input-camera").value = "";
  document.getElementById("doc-input-arquivo").value = "";
}

function fecharModalDoc() {
  document.getElementById("modal-doc").style.display = "none";
  arquivoAtual = null;
  dadosExtraidos = null;
}

// Quando escolhe um arquivo (câmera ou galeria)
function aoEscolherArquivo(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  // Limite de tamanho (o Apps Script tem limite de payload)
  if (file.size > 8 * 1024 * 1024) {
    mostrarErroDoc("Arquivo muito grande (máx. 8 MB). Tente uma foto menor.");
    return;
  }

  const leitor = new FileReader();
  leitor.onload = function (ev) {
    const resultado = ev.target.result;
    const base64 = resultado.split(",")[1];

    arquivoAtual = {
      base64: base64,
      mimeType: file.type || "image/jpeg",
      nome: file.name || "documento",
      preview: resultado
    };

    // Mostra a prévia
    const prev = document.getElementById("doc-preview");
    if (file.type.indexOf("image") === 0) {
      prev.innerHTML = '<img src="' + resultado + '" alt="prévia" />' +
                       '<div class="dp-nome">' + escaparHtml(file.name) + '</div>';
    } else {
      prev.innerHTML = '<div class="dp-pdf">📄</div>' +
                       '<div class="dp-nome">' + escaparHtml(file.name) + '</div>';
    }
    prev.style.display = "block";

    document.getElementById("doc-btn-analisar").disabled = false;
  };
  leitor.readAsDataURL(file);
}

function mostrarErroDoc(msg) {
  const el = document.getElementById("doc-erro");
  el.textContent = "⚠️ " + msg;
  el.style.display = "block";
  setTimeout(function () { el.style.display = "none"; }, 5000);
}

// ============================================================================
// ANALISAR COM A IA
// ============================================================================
async function analisarDocumento() {
  if (!arquivoAtual) return;

  document.getElementById("doc-etapa-arquivo").style.display = "none";
  document.getElementById("doc-etapa-lendo").style.display = "block";

  try {
    const r = await chamarServidorPost("analisarDocumento", {
      arquivo: arquivoAtual.base64,
      mimeType: arquivoAtual.mimeType,
      observacao: document.getElementById("doc-observacao").value.trim()
    });

    if (r.ok) {
      dadosExtraidos = r.dados;
      mostrarRevisao(r.dados, r.avisoCodigo);
    } else {
      document.getElementById("doc-etapa-lendo").style.display = "none";
      document.getElementById("doc-etapa-arquivo").style.display = "block";
      mostrarErroDoc(r.mensagem || "Não consegui ler o documento.");
    }
  } catch (e) {
    document.getElementById("doc-etapa-lendo").style.display = "none";
    document.getElementById("doc-etapa-arquivo").style.display = "block";
    mostrarErroDoc("Erro de conexão. Tente novamente.");
  }
}

// ============================================================================
// REVISÃO DOS DADOS EXTRAÍDOS
// ============================================================================
async function mostrarRevisao(d, avisoCodigo) {
  document.getElementById("doc-etapa-lendo").style.display = "none";
  document.getElementById("doc-etapa-revisar").style.display = "block";

  // Carrega listas se preciso
  if (!listasValidas) {
    try {
      const rl = await chamarServidor("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) { listasValidas = { categorias: [], metodos: [] }; }
  }

  // Tipo do documento
  document.getElementById("dr-tipo").textContent = d.tipo_documento || "Documento";

  // Código de pagamento
  const blocoCod = document.getElementById("dr-bloco-codigo");
  if (d.codigo_pagamento) {
    const ehPix = d.tipo_codigo === "pix";
    document.getElementById("dr-cod-titulo").textContent =
      ehPix ? "🔷 Código PIX detectado" : "🧾 Código de barras detectado";
    document.getElementById("dr-cod-valor").textContent = d.codigo_pagamento;
    document.getElementById("dr-codigo").value = d.codigo_pagamento;
    document.getElementById("dr-tipocodigo").value = d.tipo_codigo || "";

    const aviso = document.getElementById("dr-cod-aviso");
    if (avisoCodigo) {
      aviso.textContent = avisoCodigo;
      aviso.style.display = "block";
    } else {
      aviso.style.display = "none";
    }
    blocoCod.style.display = "block";
  } else {
    blocoCod.style.display = "none";
    document.getElementById("dr-codigo").value = "";
    document.getElementById("dr-tipocodigo").value = "";
  }

  // Campos
  document.getElementById("dr-descricao").value = d.descricao || "";
  document.getElementById("dr-beneficiario").value = d.beneficiario || "";
  document.getElementById("dr-valor").value = (parseFloat(d.valor_total) || 0).toFixed(2);
  document.getElementById("dr-parcelas").value = parseInt(d.total_parcelas) || 1;
  document.getElementById("dr-datacompra").value = converterDataParaISO(d.data_compra) || dataHojeISO();
  document.getElementById("dr-vencimento").value = converterDataParaISO(d.data_vencimento) || dataHojeISO();

  montarSelect("dr-metodo", listasValidas.metodos, d.metodo || "");
  definirCategoriaCampo("dr-categoria", d.categoria || "");

  // Se a IA identificou um cartão, a fatura decide o vencimento — não o
  // que estava escrito no comprovante.
  preencherVencimentoCartao("dr");

  // Já pago?
  document.getElementById("dr-chk-pago").checked = !!d.ja_pago;
  document.getElementById("dr-bloco-datapgto").style.display = d.ja_pago ? "block" : "none";
  document.getElementById("dr-datapgto").value = converterDataParaISO(d.data_pagamento) || dataHojeISO();

  // Modo ARQUIVAR: esconde os campos de lançamento e mostra o vínculo
  const ehArquivar = (modoDocumento === "arquivar");
  document.getElementById("dr-campos-lancamento").style.display = ehArquivar ? "none" : "block";
  document.getElementById("dr-bloco-vinculo").style.display = ehArquivar ? "block" : "none";

  document.getElementById("dr-btn-confirmar").textContent =
    ehArquivar ? "📎 Arquivar no e-mail" : "📥 Enviar para aprovação";

  // Reseta o vínculo
  document.getElementById("dr-chk-vincular").checked = false;
  document.getElementById("dr-area-vinculo").style.display = "none";
  document.getElementById("dr-nummov").value = "";
  document.getElementById("dr-despesa-encontrada").style.display = "none";
}

// Converte "DD/MM/AAAA" para "yyyy-MM-dd"
function converterDataParaISO(br) {
  if (!br) return "";
  const p = br.toString().split("/");
  if (p.length !== 3) return "";
  return p[2] + "-" + ("0" + p[1]).slice(-2) + "-" + ("0" + p[0]).slice(-2);
}

function alternarPagoDoc() {
  const pago = document.getElementById("dr-chk-pago").checked;
  document.getElementById("dr-bloco-datapgto").style.display = pago ? "block" : "none";
}

// ---------- Vínculo com despesa existente ----------
function alternarVinculo() {
  const marcado = document.getElementById("dr-chk-vincular").checked;
  document.getElementById("dr-area-vinculo").style.display = marcado ? "block" : "none";
  if (!marcado) {
    document.getElementById("dr-nummov").value = "";
    document.getElementById("dr-despesa-encontrada").style.display = "none";
  }
}

let buscaMovTimer = null;

// ---------------------------------------------------------------------------
// ATUALIZAR O VALOR DA DESPESA PELO DOCUMENTO ANEXADO
// Conta de valor variável (água, luz, cartão) chega com o valor certo só no
// boleto. Quando o documento vinculado tem valor diferente do gravado, aqui
// se OFERECE a atualização — nunca automática: uma compra pode vir com nota
// separada por item, e nesse caso o valor da nota é só uma parte da despesa.
// ---------------------------------------------------------------------------
// Reusa editarLancamento com escopo "adiante": numa despesa de parcela única
// (o caso das contas variáveis) ele altera só ela; numa parcelada, o novo
// valor vale desta parcela em diante, que é o comportamento esperado quando
// uma conta muda de preço.
async function atualizarValorPeloDocumento(numMov, valor) {
  try {
    const r = await chamarServidor("editarLancamento", {
      numMov: numMov,
      escopo: "adiante",
      valorParcela: String(valor)
    });
    if (r && r.ok) mostrarToast("💰 Valor do MOV-" + numMov + " atualizado para " + formatarMoeda(valor) + ".");
    else mostrarToast("⚠️ Documento anexado, mas o valor não foi atualizado.");
  } catch (e) {
    mostrarToast("⚠️ Documento anexado, mas o valor não foi atualizado.");
  }
}

function montarOpcaoAtualizarValor(despesa) {
  const lido = dadosExtraidos ? parseFloat(dadosExtraidos.valor_total) : 0;
  const atual = parseFloat(despesa.valor) || 0;

  if (!lido || lido <= 0) return "";
  if (Math.abs(lido - atual) < 0.01) return "";       // mesmo valor: nada a fazer
  if (despesa.pago) return "";                         // já liquidada: não mexe

  return (
    '<label class="dv-atualizar">' +
      '<input type="checkbox" id="dr-chk-atualizar-valor" />' +
      '<span>Atualizar a despesa para <b>' + formatarMoeda(lido) + '</b> ' +
      '(hoje está ' + formatarMoeda(atual) + ')</span>' +
    '</label>'
  );
}

function buscarDespesaPorMov() {
  clearTimeout(buscaMovTimer);
  const num = document.getElementById("dr-nummov").value.trim();
  const box = document.getElementById("dr-despesa-encontrada");

  if (!num) {
    box.style.display = "none";
    return;
  }

  buscaMovTimer = setTimeout(async function () {
    box.innerHTML = '<div class="dv-buscando">Buscando MOV-' + escaparHtml(num) + '...</div>';
    box.className = "dv-box buscando";
    box.style.display = "block";

    try {
      const r = await chamarServidor("buscarPorNumMov", { numMov: num });

      if (r.ok) {
        const d = r.despesa;
        box.className = "dv-box encontrada";
        box.innerHTML =
          '<div class="dv-titulo">✅ Despesa encontrada</div>' +
          '<div class="dv-desc">' + escaparHtml(d.descricao) + '</div>' +
          '<div class="dv-info">' +
            '<span>' + formatarMoeda(d.valor) + '</span>' +
            '<span>vence ' + escaparHtml(d.vencimento) + '</span>' +
            '<span>' + escaparHtml(d.parcela) + '</span>' +
          '</div>' +
          '<div class="dv-cat">' + escaparHtml(d.categoria) + '</div>' +
          (d.pago ? '<div class="dv-alerta">⚠️ Esta despesa já consta como paga.</div>' : '') +
          montarOpcaoAtualizarValor(d) +
          (d.codigoAtual ? '<div class="dv-alerta">⚠️ Esta despesa já tem um código salvo. Ele será substituído.</div>' : '');
      } else {
        box.className = "dv-box erro";
        box.innerHTML = '<div class="dv-titulo">❌ ' + escaparHtml(r.mensagem || "Não encontrado") + '</div>';
      }
    } catch (e) {
      box.className = "dv-box erro";
      box.innerHTML = '<div class="dv-titulo">⚠️ Erro de conexão</div>';
    }
  }, 600);
}

// ============================================================================
// CONFIRMAR (lançar ou arquivar)
// ============================================================================
async function confirmarDocumento() {
  const btn = document.getElementById("dr-btn-confirmar");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  const ehArquivar = (modoDocumento === "arquivar");

  const dados = {
    arquivo: arquivoAtual.base64,
    mimeType: arquivoAtual.mimeType,
    tipoDocumento: document.getElementById("dr-tipo").textContent,
    descricao: document.getElementById("dr-descricao").value.trim(),
    beneficiario: document.getElementById("dr-beneficiario").value.trim(),
    valorTotal: document.getElementById("dr-valor").value,
    dataCompra: document.getElementById("dr-datacompra").value,
    vencimento: document.getElementById("dr-vencimento").value,
    categoria: document.getElementById("dr-categoria").value,
    codigoPagamento: document.getElementById("dr-codigo").value.trim(),
    tipoCodigo: document.getElementById("dr-tipocodigo").value
  };

  if (ehArquivar) {
    if (document.getElementById("dr-chk-vincular").checked) {
      const num = document.getElementById("dr-nummov").value.trim();
      if (!num) {
        mostrarErroDoc("Informe o Nº de movimentação.");
        btn.disabled = false;
        btn.textContent = "📎 Arquivar no e-mail";
        return;
      }
      dados.numMovVinculo = num;

      // Só marca a intenção; a atualização vai depois do arquivo subir.
      const chk = document.getElementById("dr-chk-atualizar-valor");
      dados._atualizarValorPara = (chk && chk.checked && dadosExtraidos)
        ? parseFloat(dadosExtraidos.valor_total) : 0;
    }
  } else {
    // Modo lançar: valida os campos
    if (!dados.descricao) { mostrarErroDoc("Informe a descrição."); btn.disabled = false; btn.textContent = "📥 Enviar para aprovação"; return; }
    if (!dados.categoria) { mostrarErroDoc("Escolha a categoria."); btn.disabled = false; btn.textContent = "📥 Enviar para aprovação"; return; }

    dados.metodo = document.getElementById("dr-metodo").value;
    dados.totalParcelas = document.getElementById("dr-parcelas").value;

    const jaPago = document.getElementById("dr-chk-pago").checked;
    dados.jaPago = jaPago ? "true" : "false";
    if (jaPago) dados.dataPagamento = document.getElementById("dr-datapgto").value;

    if (!dados.metodo) { mostrarErroDoc("Escolha o método."); btn.disabled = false; btn.textContent = "📥 Enviar para aprovação"; return; }
  }

  const desc = dados.descricao || "documento";
  fecharModalDoc();
  mostrarToast("⏳ " + (ehArquivar ? "Arquivando" : "Enviando") + ' "' + desc + '"...', true);

  try {
    const acao = ehArquivar ? "arquivarDocumento" : "lancarPorDocumento";
    const r = await chamarServidorPost(acao, dados);

    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      limparTodoCache();

      // Valor do documento manda na despesa vinculada, quando pedido
      if (dados._atualizarValorPara > 0 && dados.numMovVinculo) {
        await atualizarValorPeloDocumento(dados.numMovVinculo, dados._atualizarValorPara);
      }

      if (!ehArquivar) checarPendentesAprovacao();
      else await recarregarDados();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Falhou."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. Nada foi enviado.");
  }
}

// ============================================================================
// COPIAR CÓDIGO DE PAGAMENTO (nas contas a vencer)
// ============================================================================
async function copiarCodigo(botao) {
  const codigo = botao.getAttribute("data-codigo");
  if (!codigo) return;

  try {
    await navigator.clipboard.writeText(codigo);
    mostrarToast("📋 Código copiado! Cole no app do banco.");
    botao.textContent = "✅";
    setTimeout(function () { botao.textContent = "📋"; }, 2000);
  } catch (e) {
    // Fallback para navegadores antigos
    const tmp = document.createElement("textarea");
    tmp.value = codigo;
    document.body.appendChild(tmp);
    tmp.select();
    try {
      document.execCommand("copy");
      mostrarToast("📋 Código copiado!");
    } catch (e2) {
      mostrarToast("❌ Não foi possível copiar.");
    }
    document.body.removeChild(tmp);
  }
}

// ============================================================================
// ===================== BUSCA ================================================
// ============================================================================

let modoBusca = "lancamentos";     // "lancamentos" ou "documentos"
let categoriasSelecionadas = [];   // filtro de múltiplas categorias
let resultadosBusca = [];
let paginaBusca = 0;
let temMaisBusca = false;
let buscaTimer = null;
let buscaSequencia = 0;   // descarta respostas de buscas já superadas
let itemDetalhe = null;
let somaBusca = { despesas: 0, receitas: 0, saldo: 0 };

async function abrirBusca() {
  if (!listasValidas) {
    try {
      const rl = await chamarServidor("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) {
      listasValidas = { categorias: [], metodos: [] };
    }
  }

  // Preenche o select de métodos
  const sel = document.getElementById("bl-metodo");
  if (sel && sel.options.length <= 1 && listasValidas.metodos) {
    listasValidas.metodos.forEach(function (m) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
  }

  renderizarTelaBusca();

  // Abre já mostrando os últimos lançamentos (busca sem filtro, que o servidor
  // devolve ordenada por Nº Mov decrescente), em vez de uma tela vazia.
  executarBusca(true);
}

function renderizarTelaBusca() {
  document.getElementById("busca-modo-lanc").classList.toggle("ativo", modoBusca === "lancamentos");
  document.getElementById("busca-modo-doc").classList.toggle("ativo", modoBusca === "documentos");

  document.getElementById("busca-filtros-lanc").style.display =
    modoBusca === "lancamentos" ? "block" : "none";
  document.getElementById("busca-filtros-doc").style.display =
    modoBusca === "documentos" ? "block" : "none";

  document.getElementById("busca-resultados").innerHTML =
    '<p class="vazio">' +
      (modoBusca === "lancamentos"
        ? "Digite algo ou use os filtros para buscar lançamentos."
        : "Busque documentos arquivados sem vínculo com lançamento.") +
    '</p>';

  resultadosBusca = [];
  paginaBusca = 0;
}

function trocarModoBusca(modo) {
  modoBusca = modo;
  renderizarTelaBusca();
}

// ---------- Filtros ----------
function alternarFiltrosBusca() {
  const el = document.getElementById("busca-filtros-avancados");
  const aberto = el.style.display === "block";
  el.style.display = aberto ? "none" : "block";
  document.getElementById("busca-btn-filtros").textContent =
    aberto ? "⚙️ Filtros" : "⚙️ Ocultar filtros";
}

function limparFiltrosBusca() {
  document.getElementById("bl-texto").value = "";
  document.getElementById("bl-nummov").value = "";
  document.getElementById("bl-valor").value = "";
  document.getElementById("bl-metodo").value = "";
  document.getElementById("bl-mes").value = "";
  document.getElementById("bl-ano").value = "";
  document.getElementById("bl-status").value = "";
  categoriasSelecionadas = [];
  atualizarBotaoCategorias();
  renderizarTelaBusca();
}

// ---------- Busca com atraso (evita chamar a cada tecla) ----------
function buscarComAtraso() {
  clearTimeout(buscaTimer);
  buscaTimer = setTimeout(function () { executarBusca(true); }, 500);
}

// ---------- Executa a busca ----------
async function executarBusca(novaBusca) {
  if (novaBusca) {
    paginaBusca = 0;
    resultadosBusca = [];
  }

  const wrap = document.getElementById("busca-resultados");

  if (novaBusca) {
    wrap.innerHTML = '<div style="text-align:center; padding:30px;"><div class="spinner" style="margin:0 auto;"></div></div>';
  }

  // Cada busca ganha um número. O Apps Script serializa as execuções e demora
  // segundos, então a resposta de um termo antigo chegava DEPOIS da do termo
  // novo e era concatenada por cima — a tela acabava misturando resultados de
  // buscas diferentes. Respostas que não são da busca mais recente são
  // descartadas aqui.
  const minhaBusca = ++buscaSequencia;

  try {
    if (modoBusca === "lancamentos") {
      const params = {
        texto: document.getElementById("bl-texto").value.trim(),
        numMov: document.getElementById("bl-nummov").value.trim(),
        valor: document.getElementById("bl-valor").value.trim(),
        categorias: categoriasSelecionadas.join("|"),
        metodo: document.getElementById("bl-metodo").value,
        mes: document.getElementById("bl-mes").value,
        ano: document.getElementById("bl-ano").value,
        status: document.getElementById("bl-status").value,
        pagina: paginaBusca
      };

      const r = await chamarServidor("buscarLancamentos", params);
      if (minhaBusca !== buscaSequencia) return;   // chegou atrasada

      if (r.ok) {
        resultadosBusca = resultadosBusca.concat(r.itens || []);
        temMaisBusca = r.temMais;
        somaBusca = r.soma || { despesas: 0, receitas: 0, saldo: 0 };
        renderizarResultadosLancamentos(r.total);
      } else {
        wrap.innerHTML = '<p class="vazio">⚠️ ' + escaparHtml(r.mensagem || "Erro.") + '</p>';
      }

    } else {
      // Busca de documentos avulsos
      const params = {
        texto: document.getElementById("bd-texto").value.trim(),
        mes: document.getElementById("bd-mes").value,
        ano: document.getElementById("bd-ano").value,
        anexos: "false"
      };

      const r = await chamarServidor("buscarDocumentosLivre", params);
      if (minhaBusca !== buscaSequencia) return;   // chegou atrasada

      if (r.ok) {
        renderizarResultadosDocumentos(r.documentos, r.total);
      } else {
        wrap.innerHTML = '<p class="vazio">⚠️ ' + escaparHtml(r.mensagem || "Erro.") + '</p>';
      }
    }
  } catch (e) {
    wrap.innerHTML = '<p class="vazio">⚠️ Sem conexão.</p>';
  }
}

// ---------- Resultados: lançamentos ----------
function renderizarResultadosLancamentos(total) {
  const wrap = document.getElementById("busca-resultados");

  if (resultadosBusca.length === 0) {
    wrap.innerHTML = '<p class="vazio">Nenhum lançamento encontrado.</p>';
    return;
  }

  // Somador
  let somaHtml = '';
  if (somaBusca.despesas > 0 || somaBusca.receitas > 0) {
    somaHtml = '<div class="busca-soma">';
    if (somaBusca.despesas > 0) {
      somaHtml += '<div><span>Despesas</span><b class="vermelho">' + formatarMoeda(somaBusca.despesas) + '</b></div>';
    }
    if (somaBusca.receitas > 0) {
      somaHtml += '<div><span>Receitas</span><b class="verde">' + formatarMoeda(somaBusca.receitas) + '</b></div>';
    }
    if (somaBusca.despesas > 0 && somaBusca.receitas > 0) {
      somaHtml += '<div><span>Saldo</span><b class="' + (somaBusca.saldo >= 0 ? "verde" : "vermelho") + '">' +
                  formatarMoeda(somaBusca.saldo) + '</b></div>';
    }
    somaHtml += '</div>';
  }

  let html = somaHtml +
    '<div class="busca-total">' + total + (total === 1 ? ' resultado' : ' resultados') + '</div>';

  resultadosBusca.forEach(function (it, idx) {
    const cartaoHtml = it.ehCartao
      ? '<span class="ex-cartao">💳 ' + escaparHtml(it.cartao) + '</span>' : '';
    const parcHtml = it.parcela
      ? '<span class="ex-parc">' + escaparHtml(it.parcela) + '</span>' : '';
    const codHtml = it.codigoPagamento
      ? '<span class="br-cod">📋</span>' : '';
    const statusHtml = it.tipo === "despesa"
      ? (it.pago ? '<span class="br-pago">✅</span>' : '<span class="br-pend">⏳</span>')
      : '';

    html +=
      '<div class="br-item" onclick="abrirDetalheBusca(' + idx + ')">' +
        '<div class="br-topo">' +
          '<span class="br-desc">' + escaparHtml(it.descricao) + '</span>' +
          '<span class="br-valor ' + (it.tipo === "receita" ? "verde" : "vermelho") + '">' +
            (it.tipo === "receita" ? "+" : "−") + formatarMoeda(it.valor).replace("R$ ", "") +
          '</span>' +
        '</div>' +
        '<div class="br-meio">' +
          '<span class="br-data">' + escaparHtml(it.vencimento) + '</span>' +
          '<span class="br-mov">MOV-' + it.numMov + '</span>' +
          statusHtml + codHtml + cartaoHtml + parcHtml +
        '</div>' +
      '</div>';
  });

  if (temMaisBusca) {
    html += '<button class="br-mais" onclick="carregarMaisBusca()">Carregar mais</button>';
  }

  wrap.innerHTML = html;
}

async function carregarMaisBusca() {
  paginaBusca++;
  await executarBusca(false);
}

// ---------- Resultados: documentos avulsos ----------
function renderizarResultadosDocumentos(docs, total) {
  const wrap = document.getElementById("busca-resultados");

  if (!docs || docs.length === 0) {
    wrap.innerHTML = '<p class="vazio">Nenhum documento avulso encontrado.</p>';
    return;
  }

  let html = '<div class="busca-total">' + total + (total === 1 ? ' documento' : ' documentos') + '</div>';

  docs.forEach(function (d, idx) {
    const qtdAnexos = d.anexos ? d.anexos.length : 0;
    html +=
      '<div class="br-item" onclick="abrirDocumentoAvulso(' + idx + ')">' +
        '<div class="br-topo">' +
          '<span class="br-desc">📎 ' + escaparHtml(d.assuntoLimpo) + '</span>' +
        '</div>' +
        '<div class="br-meio">' +
          '<span class="br-data">' + escaparHtml(d.data) + '</span>' +
          (qtdAnexos > 0
            ? '<span class="br-anexo">' + qtdAnexos + (qtdAnexos === 1 ? ' anexo' : ' anexos') + '</span>'
            : '<span class="br-anexo vazio">sem anexo</span>') +
        '</div>' +
      '</div>';
  });

  wrap.innerHTML = html;
  documentosAvulsos = docs;
}

let documentosAvulsos = [];

// ============================================================================
// DETALHE DO LANÇAMENTO
// ============================================================================
function abrirDetalheBusca(idx) {
  const it = resultadosBusca[idx];
  if (!it) return;
  itemDetalhe = it;

  const modal = document.getElementById("modal-detalhe");
  modal.style.display = "flex";

  document.getElementById("det-mov").textContent = "MOV-" + it.numMov;

  const cartaoHtml = it.ehCartao ? ' <span class="ex-cartao">💳 ' + escaparHtml(it.cartao) + '</span>' : '';

  document.getElementById("det-corpo").innerHTML =
    '<div class="det-valor ' + (it.tipo === "receita" ? "verde" : "vermelho") + '">' +
      formatarMoeda(it.valor) +
    '</div>' +
    '<div class="det-desc">' + escaparHtml(it.descricao) + cartaoHtml + '</div>' +

    '<div class="det-linhas">' +
      '<div class="det-linha"><span>Vencimento</span><b>' + escaparHtml(it.vencimento) + '</b></div>' +
      '<div class="det-linha"><span>Data da compra</span><b>' + escaparHtml(it.dataCompra) + '</b></div>' +
      (it.parcela ? '<div class="det-linha"><span>Parcela</span><b>' + escaparHtml(it.parcela) + '</b></div>' : '') +
      '<div class="det-linha"><span>Método</span><b>' + escaparHtml(it.metodo) + '</b></div>' +
      '<div class="det-linha"><span>Categoria</span><b>' + escaparHtml(it.categoria) + '</b></div>' +
      '<div class="det-linha"><span>Status</span><b class="' + (it.pago ? "verde" : "laranja") + '">' +
        (it.pago ? "✅ Pago" + (it.dataPagamento ? " em " + escaparHtml(it.dataPagamento) : "") : "⏳ Pendente") +
      '</b></div>' +
    '</div>' +

    (it.codigoPagamento
      ? '<div class="det-codigo">' +
          '<div class="dc-titulo">🧾 Código de pagamento</div>' +
          '<div class="dc-valor">' + escaparHtml(it.codigoPagamento) + '</div>' +
          '<button class="dc-copiar" data-codigo="' + escaparHtml(it.codigoPagamento) + '" ' +
                  'onclick="copiarCodigo(this)">📋 Copiar código</button>' +
        '</div>'
      : '') +

    '<div class="det-acoes">' +
      '<button class="det-btn doc" onclick="buscarDocsDoMov(' + it.numMov + ', true)">' +
        '📎 Buscar documentos' +
      '</button>' +
      '<button class="det-btn email" onclick="buscarDocsDoMov(' + it.numMov + ', false)">' +
        '✉️ Ver e-mails' +
      '</button>' +
    '</div>' +

    '<button class="det-btn editar" onclick="fecharDetalhe(); abrirEdicao(' + it.numMov + ');">' +
      '✏️ Editar lançamento' +
    '</button>' +

    (!it.pago && it.tipo === "despesa"
      ? '<button class="det-btn liquidar" onclick="fecharDetalhe(); abrirLiquidacao(' + it.numMov + ');">' +
          '✅ Liquidar esta despesa' +
        '</button>'
      : '') +

    '<div id="det-documentos"></div>';
}

function fecharDetalhe() {
  document.getElementById("modal-detalhe").style.display = "none";
  itemDetalhe = null;
}

// ---------- Busca os documentos daquele MOV ----------
async function buscarDocsDoMov(numMov, comAnexos) {
  const wrap = document.getElementById("det-documentos");
  wrap.innerHTML =
    '<div class="det-buscando">' +
      '<div class="spinner" style="margin:0 auto 12px;"></div>' +
      '<p>' + (comAnexos ? "Buscando documentos no e-mail..." : "Buscando e-mails...") + '</p>' +
      (comAnexos ? '<small>Pode demorar alguns segundos</small>' : '') +
    '</div>';

  try {
    const r = await chamarServidor("buscarDocumentosPorMov", {
      numMov: numMov,
      anexos: comAnexos ? "true" : "false"
    });

    if (!r.ok) {
      wrap.innerHTML = '<p class="vazio">⚠️ ' + escaparHtml(r.mensagem || "Erro.") + '</p>';
      return;
    }

    if (!r.documentos || r.documentos.length === 0) {
      wrap.innerHTML = '<p class="vazio">📭 Nenhum documento encontrado para MOV-' + numMov + '.</p>';
      return;
    }

    renderizarDocumentosEncontrados(r.documentos, comAnexos, wrap);

  } catch (e) {
    wrap.innerHTML = '<p class="vazio">⚠️ Erro ao buscar. Tente novamente.</p>';
  }
}

function renderizarDocumentosEncontrados(docs, comAnexos, wrap) {
  let html = '<div class="det-docs-titulo">📎 ' + docs.length +
             (docs.length === 1 ? ' documento encontrado' : ' documentos encontrados') + '</div>';

  docs.forEach(function (d, i) {
    html += '<div class="det-doc">';
    html += '<div class="dd-assunto">' + escaparHtml(d.assuntoLimpo) + '</div>';
    html += '<div class="dd-data">' + escaparHtml(d.data) + '</div>';

    if (d.anexos && d.anexos.length > 0) {
      d.anexos.forEach(function (a, j) {
        html += '<div class="dd-anexo">';
        html += '<span class="dda-icone">' + iconeArquivo(a.tipo) + '</span>';
        html += '<span class="dda-info">' +
                  '<b>' + escaparHtml(a.nome) + '</b>' +
                  '<span>' + escaparHtml(a.tamanhoTxt) + '</span>' +
                '</span>';

        if (a.muitoGrande) {
          html += '<span class="dda-grande">muito grande</span>';
        } else if (a.conteudo) {
          html += '<button class="dda-baixar" onclick="baixarAnexo(' + i + ',' + j + ')">⬇️</button>';
        }
        html += '</div>';
      });
    } else {
      html += '<div class="dd-sem-anexo">Sem anexos neste e-mail.</div>';
    }

    html += '<a class="dd-email" href="' + escaparHtml(d.link) + '" target="_blank">✉️ Abrir e-mail no Gmail</a>';
    html += '</div>';
  });

  wrap.innerHTML = html;
  documentosEncontrados = docs;
}

let documentosEncontrados = [];

function iconeArquivo(tipo) {
  const t = (tipo || "").toLowerCase();
  if (t.indexOf("pdf") !== -1) return "📄";
  if (t.indexOf("image") !== -1) return "🖼️";
  return "📎";
}

// ---------- Baixar o anexo ----------
function baixarAnexo(iDoc, iAnexo) {
  try {
    const doc = documentosEncontrados[iDoc];
    if (!doc) return;
    const anexo = doc.anexos[iAnexo];
    if (!anexo || !anexo.conteudo) return;

    // Converte base64 em arquivo e dispara o download
    const bin = atob(anexo.conteudo);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const blob = new Blob([bytes], { type: anexo.tipo || "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = anexo.nome || "documento";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    mostrarToast("⬇️ Baixando " + anexo.nome);

  } catch (e) {
    mostrarToast("❌ Não foi possível baixar.");
  }
}

// ---------- Documento avulso ----------
async function abrirDocumentoAvulso(idx) {
  const d = documentosAvulsos[idx];
  if (!d) return;

  const modal = document.getElementById("modal-detalhe");
  modal.style.display = "flex";
  document.getElementById("det-mov").textContent = "Documento";

  document.getElementById("det-corpo").innerHTML =
    '<div class="det-desc">📎 ' + escaparHtml(d.assuntoLimpo) + '</div>' +
    '<div class="det-linhas">' +
      '<div class="det-linha"><span>Arquivado em</span><b>' + escaparHtml(d.data) + '</b></div>' +
    '</div>' +
    '<div class="det-buscando">' +
      '<div class="spinner" style="margin:0 auto 12px;"></div>' +
      '<p>Buscando anexos...</p>' +
    '</div>' +
    '<div id="det-documentos"></div>';

  // Busca de novo, agora com os anexos
  try {
    const r = await chamarServidor("buscarDocumentosLivre", {
      texto: d.assuntoLimpo.substring(0, 40),
      anexos: "true"
    });

    const wrap = document.getElementById("det-documentos");
    document.querySelector("#det-corpo .det-buscando").style.display = "none";

    if (r.ok && r.documentos && r.documentos.length > 0) {
      renderizarDocumentosEncontrados(r.documentos, true, wrap);
    } else {
      wrap.innerHTML = '<p class="vazio">Nenhum anexo encontrado.</p>';
    }
  } catch (e) {
    document.getElementById("det-documentos").innerHTML =
      '<p class="vazio">⚠️ Erro ao buscar anexos.</p>';
  }
}


function voltarAoDashboard() {
  trocarAba("dashboard");
}


// ============================================================================
// SELETOR DE MÚLTIPLAS CATEGORIAS
// ============================================================================
let destinoMultiCat = null;   // "busca" ou "relatorio"

function abrirMultiCategorias(destino) {
  destinoMultiCat = destino;
  const modal = document.getElementById("modal-multicat");
  modal.style.display = "flex";

  document.getElementById("mc-busca").value = "";
  renderizarMultiCategorias("");

  revalidarListasValidas(function () {
    if (modal.style.display === "flex") {
      renderizarMultiCategorias(document.getElementById("mc-busca").value);
    }
  });

  setTimeout(function () { document.getElementById("mc-busca").focus(); }, 120);
}

function fecharMultiCategorias() {
  document.getElementById("modal-multicat").style.display = "none";
}

function filtrarMultiCategorias() {
  renderizarMultiCategorias(document.getElementById("mc-busca").value);
}

function renderizarMultiCategorias(termo) {
  const lista = document.getElementById("mc-lista");
  lista.innerHTML = "";

  const todas = (listasValidas && listasValidas.categorias) ? listasValidas.categorias : [];
  const t = normalizarBusca(termo).trim();

  const filtradas = t === "" ? todas
    : todas.filter(function (c) { return normalizarBusca(c).indexOf(t) !== -1; });

  const selecionadas = (destinoMultiCat === "relatorio") ? catsRelatorio : categoriasSelecionadas;

  if (filtradas.length === 0) {
    lista.innerHTML = '<div class="sc-vazio">Nenhuma categoria encontrada.</div>';
    return;
  }

  filtradas.forEach(function (c) {
    const marcada = selecionadas.indexOf(c) !== -1;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mc-item" + (marcada ? " marcada" : "");

    const m = c.match(/^([\d.]+)\s*\.?\s*(.*)$/);
    const cod = (m && m[1]) ? m[1] : "";
    const nome = (m && m[2]) ? m[2] : c;

    item.innerHTML =
      '<span class="mc-check">' + (marcada ? "☑️" : "⬜") + '</span>' +
      (cod ? '<span class="sc-cod">' + escaparHtml(cod) + '</span>' : '') +
      '<span class="sc-nome">' + escaparHtml(nome) + '</span>';

    item.onclick = function () { alternarCategoria(c); };
    lista.appendChild(item);
  });

  atualizarContadorMultiCat();
}

function alternarCategoria(cat) {
  const lista = (destinoMultiCat === "relatorio") ? catsRelatorio : categoriasSelecionadas;
  const idx = lista.indexOf(cat);
  if (idx === -1) lista.push(cat);
  else lista.splice(idx, 1);

  renderizarMultiCategorias(document.getElementById("mc-busca").value);
}

function atualizarContadorMultiCat() {
  const lista = (destinoMultiCat === "relatorio") ? catsRelatorio : categoriasSelecionadas;
  const el = document.getElementById("mc-contador");
  if (!el) return;
  el.textContent = lista.length === 0 ? "Nenhuma selecionada (= todas)"
    : lista.length + (lista.length === 1 ? " categoria" : " categorias");
}

function limparMultiCategorias() {
  if (destinoMultiCat === "relatorio") catsRelatorio = [];
  else categoriasSelecionadas = [];
  renderizarMultiCategorias(document.getElementById("mc-busca").value);
}

function confirmarMultiCategorias() {
  fecharMultiCategorias();

  if (destinoMultiCat === "relatorio") {
    atualizarBotaoCategoriasRelatorio();
  } else {
    atualizarBotaoCategorias();
    buscarComAtraso();
  }
}

function atualizarBotaoCategorias() {
  const el = document.getElementById("bl-categorias-txt");
  if (!el) return;
  if (categoriasSelecionadas.length === 0) {
    el.textContent = "Todas as categorias";
    el.classList.add("vazio-cat");
  } else if (categoriasSelecionadas.length === 1) {
    el.textContent = categoriasSelecionadas[0];
    el.classList.remove("vazio-cat");
  } else {
    el.textContent = categoriasSelecionadas.length + " categorias selecionadas";
    el.classList.remove("vazio-cat");
  }
}

// ============================================================================
// RELATÓRIO: GASTOS POR CATEGORIA
// ============================================================================
let catsRelatorio = [];   // categorias selecionadas para o relatório

function atualizarBotaoCategoriasRelatorio() {
  const el = document.getElementById("mp-categorias-txt");
  if (!el) return;
  if (catsRelatorio.length === 0) {
    el.textContent = "Todas as categorias";
    el.classList.add("vazio-cat");
  } else if (catsRelatorio.length === 1) {
    el.textContent = catsRelatorio[0];
    el.classList.remove("vazio-cat");
  } else {
    el.textContent = catsRelatorio.length + " categorias selecionadas";
    el.classList.remove("vazio-cat");
  }
}

function htmlGastosCategoria(r) {
  const res = r.resumo;

  if (!r.grupos || r.grupos.length === 0) {
    return '<div class="card"><p class="vazio">Nenhum gasto encontrado neste período.</p></div>';
  }

  let grupos = "";
  r.grupos.forEach(function (g, idx) {
    let itens = "";
    g.itens.forEach(function (it) {
      const cartao = iconeCartao(it.metodo);
      const parc = it.parcela ? '<span class="ex-parc">' + escaparHtml(it.parcela) + '</span>' : '';
      const pend = !it.pago ? '<span class="gc-pend">⏳</span>' : '';

      itens +=
        '<div class="gc-item">' +
          '<div class="gc-i-esq">' +
            '<div class="gc-i-desc">' + escaparHtml(it.descricao) + pend + '</div>' +
            '<div class="gc-i-meta">' +
              '<span class="gc-i-data">' + escaparHtml(it.data) + '</span>' +
              '<span class="gc-i-mov">MOV-' + it.numMov + '</span>' +
              '<span class="gc-i-met">' + escaparHtml(it.metodo) + '</span>' +
              cartao + parc +
            '</div>' +
          '</div>' +
          '<div class="gc-i-valor">' + formatarMoeda(it.valor) + '</div>' +
        '</div>';
    });

    grupos +=
      '<div class="gc-grupo">' +
        '<div class="gc-g-topo" onclick="alternarGrupoGC(' + idx + ')">' +
          '<div class="gc-g-esq">' +
            '<div class="gc-g-nome">' + escaparHtml(g.categoria) + '</div>' +
            '<div class="gc-g-qtd">' + g.quantidade +
              (g.quantidade === 1 ? ' lançamento' : ' lançamentos') +
              ' · ' + g.percentual.toFixed(1) + '% do total' +
            '</div>' +
          '</div>' +
          '<div class="gc-g-dir">' +
            '<b>' + formatarMoeda(g.total) + '</b>' +
            '<span class="gc-seta" id="gc-seta-' + idx + '">▾</span>' +
          '</div>' +
        '</div>' +
        '<div class="gc-g-barra">' +
          '<div class="gc-g-preench" style="width:' + g.percentual + '%"></div>' +
        '</div>' +
        '<div class="gc-itens" id="gc-itens-' + idx + '">' + itens + '</div>' +
      '</div>';
  });

  return (
    '<div class="card">' +
      '<div class="gc-resumo">' +
        '<div class="gcr-box">' +
          '<span>Total gasto</span>' +
          '<b class="vermelho">' + formatarMoeda(res.total) + '</b>' +
        '</div>' +
        '<div class="gcr-box">' +
          '<span>Média mensal</span>' +
          '<b>' + formatarMoeda(res.mediaMensal) + '</b>' +
        '</div>' +
      '</div>' +
      '<div class="rel-nota">' +
        res.quantidade + ' lançamentos em ' + res.categorias +
        (res.categorias === 1 ? ' categoria' : ' categorias') +
        ' · período de ' + res.meses + (res.meses === 1 ? ' mês' : ' meses') +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<h2>Detalhamento</h2>' +
      '<p class="pv-intro">Toque numa categoria para ver ou ocultar os lançamentos.</p>' +
      grupos +
    '</div>'
  );
}

function alternarGrupoGC(idx) {
  const el = document.getElementById("gc-itens-" + idx);
  const seta = document.getElementById("gc-seta-" + idx);
  if (!el) return;
  const aberto = el.classList.contains("aberto");
  el.classList.toggle("aberto", !aberto);
  if (seta) seta.textContent = aberto ? "▾" : "▴";
}
