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

  lerCacheado("listasValidas").then(function (rl) {
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
/** O cache antigo, por mês. Só existe para limpar o que ficou dos aparelhos. */
const CACHE_PREFIXO = "sb_dash_";

function chaveCache(mes, ano) {
  return CACHE_PREFIXO + ano + "_" + mes;
}

/**
 * A chave do dashboard de um mês no cache de leitura.
 *
 * Passa pelo MESMO limparVazios que lerDoServidor usa: ele ordena as chaves,
 * e escrever { ano, mes } à mão em um lugar e { mes, ano } no outro daria
 * strings diferentes para o mesmo mês. Já foi assim, e só não quebrou por
 * sorte.
 */
function chaveDashboard(mes, ano) {
  return CACHE_LEITURA + "dashboard|" + JSON.stringify(limparVazios({ mes: mes, ano: ano }));
}

/** Devolve se coube. Quem chama decide o que fazer quando não cabe. */
function salvarCache(mes, ano, dados) {
  try {
    localStorage.setItem(chaveDashboard(mes, ano), JSON.stringify({
      carimbo: carimbosConhecidos.transacoes,
      quando: Date.now(),
      dados: dados
    }));
    return true;
  } catch (e) {
    return false;
  }
}

function lerCache(mes, ano) {
  try {
    let bruto = localStorage.getItem(chaveDashboard(mes, ano));

    // O cache antigo ainda vale para quem já tinha meses guardados nele:
    // sem isto, atualizar o app esvaziaria o seletor até a próxima pré-carga.
    if (!bruto) bruto = localStorage.getItem(chaveCache(mes, ano));

    if (!bruto) return null;
    const pacote = JSON.parse(bruto);
    if (!pacote || !pacote.dados) return null;

    // O mês guardado tem de ser o mês pedido. Parece redundante -- a chave já
    // leva mês e ano --, mas uma corrida entre a troca de mês e a resposta que
    // ainda estava no ar gravou setembro na chave de outubro, e a cópia errada
    // conta como FRESCA: sem esta conferência ela nunca mais seria buscada e
    // outubro mostraria setembro para sempre. Jogar fora aqui cura sozinho o
    // que já está gravado no aparelho, sem ninguém precisar limpar nada.
    const esperado = MESES_NOMES[mes] + "/" + ano;
    const veio = (pacote.dados || {}).mesReferencia;
    if (veio && veio !== esperado) {
      try { localStorage.removeItem(chaveDashboard(mes, ano)); } catch (e) {}
      try { localStorage.removeItem(chaveCache(mes, ano)); } catch (e) {}
      return null;
    }

    return pacote;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// OS CARIMBOS — não buscar o que não mudou
// ----------------------------------------------------------------------------
// Cada tela buscava os dados dela do zero toda vez, e o Apps Script não é
// rápido. Abrir Planos, trocar de mês, voltar ao Dashboard: uma ida e volta
// cada, quase sempre para receber exatamente a mesma resposta de antes.
//
// Agora o servidor mantém um número por domínio (transações, planos, agenda,
// trabalho, configuração) que sobe a cada gravação. O app pergunta os cinco
// UMA vez ao abrir -- é a chamada mais barata que existe lá -- e todo domínio
// que não mudou dispensa a busca INTEIRA. A tela sai do aparelho, sem rede.
//
// O ganho não é o cache: já havia cache no Dashboard. É deixar de esperar a
// resposta para saber que ela era igual.
// ============================================================================
const CACHE_LEITURA = "sb_l_";
const CARIMBOS_CHAVE = "sb_carimbos";

/**
 * Os carimbos que este aparelho já viu.
 *
 * Lido do armazenamento AQUI, na própria declaração, e não numa função que
 * alguém precisa lembrar de chamar. Foi exatamente esse o defeito da primeira
 * versão: a função existia e nunca era chamada, então toda abertura começava
 * com a lista vazia, achava que os cinco domínios tinham mudado e jogava fora
 * o cache inteiro -- a pré-carga do ano se refazia a cada vez que o app abria.
 *
 * Sem aviso, sem erro: só parecia lento de novo.
 */
let carimbosConhecidos = carimbosGuardados();

function carimbosGuardados() {
  try {
    return JSON.parse(localStorage.getItem(CARIMBOS_CHAVE) || "{}") || {};
  } catch (e) {
    return {};
  }
}

/**
 * De que domínio cada leitura depende.
 *
 * É o que liga uma gravação às telas que ela estraga. Uma leitura que não
 * esteja aqui simplesmente não é cacheada -- some o ganho, nada quebra. O
 * perigo é apontar para o domínio ERRADO: aí a tela guarda dado velho e não
 * tem nada que a faça atualizar.
 */
const DOMINIO_DA_LEITURA = {
  dashboard: "transacoes",
  listarAprovacoes: "transacoes",
  descricoesUsadas: "transacoes",
  listarFixas: "transacoes",
  previsaoFixas: "transacoes",
  gerarRelatorio: "transacoes",
  resumoWidget: "transacoes",
  listasValidas: "config",
  listarCartoesConfig: "config",
  dadosCalendario: "agenda",
  listarTarefas: "agenda",
  buscarLancamentos: "transacoes",
  listarPlanos: "planos",
  listarReprovados: "planos",
  trabalhoPainel: "trabalho"
};

/** Tira os campos em branco. O servidor trata ausente e vazio igual. */
function limparVazios(obj) {
  const saida = {};
  Object.keys(obj).sort().forEach(function (k) {
    const v = obj[k];
    if (v === "" || v === null || v === undefined) return;
    saida[k] = v;
  });
  return saida;
}

function guardarCarimbos() {
  try {
    localStorage.setItem(CARIMBOS_CHAVE, JSON.stringify(carimbosConhecidos));
  } catch (e) {}
}

/**
 * Pergunta ao servidor o que mudou e joga fora o cache do que mudou.
 *
 * Roda ao abrir e no ↻. Falhar aqui não pode travar nada: sem resposta, o app
 * segue com os carimbos que tinha e cada tela decide se busca -- que é
 * exatamente o comportamento de antes deste arquivo existir.
 */
async function sincronizarCarimbos() {
  try {
    const r = await chamarServidor("carimbos");
    if (!r || !r.ok || !r.carimbos) return false;

    const codigoAntes = carimbosConhecidos.codigo;
    const sujos = [];
    Object.keys(r.carimbos).forEach(function (d) {
      if (carimbosConhecidos[d] === r.carimbos[d]) return;
      carimbosConhecidos[d] = r.carimbos[d];
      sujos.push(d);
    });

    // GRAVA PRIMEIRO, esquece depois.
    //
    // Na ordem inversa, qualquer erro ao limpar abortava antes de gravar --
    // e aí a abertura seguinte começava sem carimbo nenhum, achava que tudo
    // tinha mudado e jogava o cache fora outra vez. Um defeito assim não dá
    // erro na tela: o app só volta a parecer lento, para sempre.
    if (sujos.length) guardarCarimbos();

    // O CÓDIGO do servidor mudou: a conta é outra, e tudo que está guardado
    // foi calculado pela conta antiga. Carimbo de domínio não pega este caso
    // -- uma correção de cálculo não mexe em nenhuma linha da planilha --, e
    // sem isto uma correção publicada e verificada no ar continua invisível
    // no aparelho, que segue respondendo do próprio bolso.
    //
    // Só quando JÁ HAVIA um valor: na primeira execução não há nada velho
    // para jogar fora, e limpar ali seria uma varrida a mais em toda
    // instalação nova.
    if (codigoAntes !== undefined && r.carimbos.codigo !== undefined &&
        codigoAntes !== r.carimbos.codigo) {
      esquecerTudo();
      guardarCarimbos();
    }

    // Não apaga: o carimbo novo já torna as entradas daquele domínio
    // SUSPEITAS, e suspeito se resolve mostrando e conferindo atrás.
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Idade máxima de qualquer coisa guardada.
 *
 * O carimbo pega o que o APP grava. Não pega o que é digitado direto na
 * planilha -- e nesta casa isso acontece: categoria nova, linha corrigida à
 * mão. Sem um teto, uma edição dessas ficaria invisível para sempre.
 *
 * Doze horas porque o ↻ já resolve na hora para quem percebeu; isto é a rede
 * de segurança de quem não percebeu.
 */
const CACHE_IDADE_MAX = 12 * 60 * 60 * 1000;

/** Joga fora TODA leitura guardada. É o que o ↻ faz. */
function esquecerTudo() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.indexOf(CACHE_LEITURA) === 0 || k.indexOf(CACHE_PREFIXO) === 0) {
        localStorage.removeItem(k);
      }
    }
    localStorage.removeItem(PRECARGA_MARCA);
    localStorage.removeItem(LANCAMENTOS_CHAVE);
  } catch (e) {}
}

/** Apaga tudo que foi guardado de um domínio. */
function esquecerDominio(dominio) {
  const acoes = Object.keys(DOMINIO_DA_LEITURA).filter(function (a) {
    return DOMINIO_DA_LEITURA[a] === dominio;
  });

  try {
    // De trás para a frente: remover encurta a lista e pular índice deixaria
    // chave para trás -- justamente a que devia morrer.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;

      if (k.indexOf(CACHE_LEITURA) === 0) {
        const acao = k.slice(CACHE_LEITURA.length).split("|")[0];
        if (acoes.indexOf(acao) >= 0) localStorage.removeItem(k);
      } else if (dominio === "transacoes" && k.indexOf(CACHE_PREFIXO) === 0) {
        // O Dashboard tem cache próprio, de antes disto, e é por mês: some
        // TODO mês, porque uma transação lançada em março muda março.
        localStorage.removeItem(k);
      }
    }

    // A marca da pré-carga e os lançamentos guardados são dados de
    // TRANSAÇÕES, e precisam cair junto.
    //
    // Deixar a marca para trás foi um defeito de verdade: ela continuava
    // dizendo "o ano está guardado" depois dos meses terem sido apagados, e
    // a pré-carga nunca mais rodava. O sintoma era voltar a carregar mês a
    // mês, sem nada indicando o motivo.
    if (dominio === "transacoes") {
      localStorage.removeItem(PRECARGA_MARCA);
      localStorage.removeItem(LANCAMENTOS_CHAVE);
    }
  } catch (e) {}
}

/**
 * Depois de gravar, o domínio está sujo AQUI mesmo -- sem perguntar a ninguém.
 *
 * Zerar o carimbo conhecido, e não só apagar o cache, é o que importa: apagado
 * mas com o carimbo casando, a próxima sincronização acharia que está tudo em
 * dia e o dado novo nunca seria buscado.
 */
function sujarDominio(dominio) {
  if (!dominio) return;

  // Só esquece o CARIMBO, nunca os dados.
  //
  // Antes isto apagava tudo do domínio -- e uma conta de R$ 20 lançada jogava
  // fora os 25 meses da pré-carga, que voltavam a ser buscados um a um. O que
  // está guardado continua quase inteiramente certo: o certo é MOSTRAR e
  // conferir atrás, não apagar e esperar.
  delete carimbosConhecidos[dominio];
  guardarCarimbos();

  // O carimbo novo do servidor, em segundo plano. Sem isto os dados ficariam
  // "suspeitos para sempre" e toda leitura revalidaria.
  setTimeout(function () { sincronizarCarimbos(); }, 1200);
}

/**
 * Uma leitura, do aparelho quando dá e do servidor quando precisa.
 *
 * Devolve { ok, dados, doCache }. Quem chama não precisa saber de carimbo
 * nenhum -- troca chamarServidor por esta e pronto.
 */
/**
 * @param aoRevalidar  Quando existe e o guardado está suspeito, a função
 *   devolve o guardado NA HORA e busca o novo atrás; quando a resposta chega,
 *   chama isto com ela. Sem esta função, suspeito equivale a não ter: espera.
 */
async function lerDoServidor(acao, params, aoRevalidar) {
  // Campo vazio sai antes da chave. Uma busca sem filtro chega da tela com
  // sete campos em branco; sem limpar, ela nunca casaria com a mesma busca
  // guardada pela pré-carga, que manda só { pagina: 0 }.
  params = limparVazios(params || {});

  const dominio = DOMINIO_DA_LEITURA[acao];
  const chave = CACHE_LEITURA + acao + "|" + JSON.stringify(params);

  let guardado = null;
  if (dominio) {
    try {
      const bruto = localStorage.getItem(chave);
      if (bruto) guardado = JSON.parse(bruto);
    } catch (e) {}
  }

  if (guardado && guardado.dados) {
    const velho = !guardado.quando || (Date.now() - guardado.quando) > CACHE_IDADE_MAX;
    const fresco = carimbosConhecidos[dominio] !== undefined &&
                   guardado.carimbo === carimbosConhecidos[dominio] && !velho;

    if (fresco) return { ok: true, dados: guardado.dados, doCache: true, quando: guardado.quando };

    // Suspeito, mas existe. Devolve agora e confere atrás: a tela aparece
    // instantânea e se corrige sozinha um segundo depois, em vez de ficar
    // vazia esperando.
    if (typeof aoRevalidar === "function" && !velho) {
      revalidarAtras(acao, params, chave, dominio, aoRevalidar);
      return { ok: true, dados: guardado.dados, doCache: true,
               suspeito: true, quando: guardado.quando };
    }
  }

  const r = await chamarServidor(acao, params);

  if (r && r.ok && dominio && carimbosConhecidos[dominio] !== undefined) {
    try {
      localStorage.setItem(chave, JSON.stringify({
        carimbo: carimbosConhecidos[dominio], quando: Date.now(), dados: r
      }));
    } catch (e) {
      // Armazenamento cheio: joga fora o que é mais fácil de refazer e segue.
      esquecerDominio("transacoes");
    }
  }

  return { ok: !!(r && r.ok), dados: r, doCache: false };
}

/**
 * Igual a chamarServidor, mas passando pelo cache.
 *
 * Devolve a resposta crua, na mesma forma: quem chama continua lendo r.ok,
 * r.planos, r.mensagem. É o que permite trocar uma pela outra sem mexer no
 * resto da tela.
 */
/**
 * Soma um lançamento recém-criado nos meses já guardados.
 *
 * Por quê: depois de salvar, o app pedia tudo de novo à planilha e a tela
 * ficava com o número velho até a resposta chegar -- segundos olhando para um
 * saldo que você sabe que mudou. O app tem todos os dados para fazer essa
 * conta sozinho: valor, data, parcelas e se já foi pago.
 *
 * É uma ESTIMATIVA, e assumida como tal: logo depois a revalidação traz o
 * número do servidor e escreve por cima. Se eu errar a conta aqui, o erro
 * dura um segundo e se corrige sozinho -- e é por isso que ela pode ser
 * simples em vez de reimplementar o dashboard inteiro.
 *
 * O que ela NÃO mexe: categorias, contas a vencer, faturas e score. Aqueles
 * dependem de regras que só o servidor tem (ciclo de fatura, limite,
 * pontuação), e chutar ali daria um número plausível e errado -- pior que um
 * número velho, porque não se sabe que é chute.
 */
function somarLancamentoNoCache(params) {
  const total = Number(params.valorTotal) || 0;
  if (!(total > 0)) return;

  const partes = Math.max(1, parseInt(params.totalParcelas) || 1);
  const porParcela = total / partes;
  const pago = (params.jaPago === "true" || params.jaPago === true);

  const venc = dataDeTexto(params.vencimento);
  if (!venc) return;

  for (let i = 0; i < partes; i++) {
    const d = new Date(venc.getFullYear(), venc.getMonth() + i, 1);
    somarNoMesGuardado(d.getMonth(), d.getFullYear(), porParcela, pago);
  }
}

/** "2026-10-15" ou "15/10/2026" -> Date. Vazio ou estranho -> null. */
function dataDeTexto(txt) {
  const v = (txt || "").toString().trim();
  if (!v) return null;

  let p = v.split("-");
  if (p.length === 3 && p[0].length === 4) {
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  p = v.split("/");
  if (p.length === 3) return new Date(+p[2], +p[1] - 1, +p[0]);
  return null;
}

/**
 * Soma num mês específico, nos dois caches que o dashboard usa.
 *
 * Só toca no que é aritmética pura: despesa, saldo e o par pago/pendente. O
 * mês que ainda não foi guardado não recebe nada -- ele vai ser buscado do
 * servidor completo quando for aberto, já com o lançamento dentro.
 */
function somarNoMesGuardado(mes, ano, valor, pago) {
  const chave = CACHE_LEITURA + "dashboard|" + JSON.stringify({ ano: ano, mes: mes });

  try {
    const bruto = localStorage.getItem(chave);
    if (!bruto) return;

    const p = JSON.parse(bruto);
    const d = p && p.dados;
    if (!d || !d.saldo) return;

    d.saldo.despesas = arredondarCentavos(d.saldo.despesas + valor);
    d.saldo.saldo = arredondarCentavos(d.saldo.saldo - valor);
    d.saldo.despesasEsperadas = arredondarCentavos((d.saldo.despesasEsperadas || 0) + valor);
    d.saldo.despesasComPlanos = arredondarCentavos((d.saldo.despesasComPlanos || 0) + valor);

    if (d.despesasStatus) {
      if (pago) d.despesasStatus.pagas = arredondarCentavos(d.despesasStatus.pagas + valor);
      else d.despesasStatus.pendentes = arredondarCentavos(d.despesasStatus.pendentes + valor);
    }

    // Guarda com carimbo inválido de propósito: assim a entrada continua
    // SUSPEITA e a revalidação acontece. Um número estimado não pode virar
    // verdade guardada só porque ficou bonito na tela.
    localStorage.setItem(chave, JSON.stringify({
      carimbo: "estimado", quando: p.quando || Date.now(), dados: d
    }));

    // O cache de pintura instantânea recebe a mesma conta.
    salvarCache(mes, ano, d);
  } catch (e) {}
}

function arredondarCentavos(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/**
 * Busca o valor certo atrás da tela e avisa quem pediu.
 *
 * Uma por chave de cada vez: o dashboard dispara isto a cada pintura, e sem a
 * trava trocar de mês três vezes deixaria três buscas do mesmo mês correndo
 * juntas, com a mais lenta chegando por último e escrevendo por cima.
 */
const revalidando = {};

function revalidarAtras(acao, params, chave, dominio, aoRevalidar) {
  if (revalidando[chave]) return;
  revalidando[chave] = true;

  chamarServidor(acao, params).then(function (r) {
    if (!r || !r.ok) return;

    try {
      localStorage.setItem(chave, JSON.stringify({
        carimbo: carimbosConhecidos[dominio], quando: Date.now(), dados: r
      }));
    } catch (e) {}

    aoRevalidar(r);
  }).catch(function () {
    // Sem rede: fica o que estava na tela, que é o que a pessoa já está lendo.
  }).then(function () {
    delete revalidando[chave];
  });
}

async function lerCacheado(acao, params) {
  return (await lerDoServidor(acao, params)).dados;
}

// ============================================================================
// TAREFAS EM SEGUNDO PLANO
// ----------------------------------------------------------------------------
// Algumas coisas demoram porque demoram: a IA lendo um plano, um site sendo
// aberto para pegar preço, a planilha gerando os processos do mês. Enquanto
// isso o app ficava parado -- a folha aberta, o botão escrito "Analisando...",
// e nada mais a fazer além de esperar.
//
// Agora essas ações saem da frente: a folha fecha, uma barrinha no rodapé diz
// o que está rodando, e o app continua inteiro. Quando termina, avisa.
//
// A barra some sozinha quando a última tarefa acaba. Ela NUNCA bloqueia a
// tela -- se bloqueasse, seria a mesma espera com outra aparência.
// ============================================================================
let tarefasFundo = [];
let proximaTarefaId = 1;

function pintarBarraFundo() {
  let el = document.getElementById("barra-fundo");

  if (!tarefasFundo.length) {
    if (el) el.classList.remove("visivel");
    return;
  }

  if (!el) {
    el = document.createElement("div");
    el.id = "barra-fundo";
    document.body.appendChild(el);
  }

  const primeira = tarefasFundo[0];
  const resto = tarefasFundo.length - 1;

  el.innerHTML = '<span class="bf-giro"></span>' +
    '<span class="bf-txt">' + escaparHtml(primeira.rotulo) + '</span>' +
    (resto > 0 ? '<span class="bf-mais">+' + resto + '</span>' : '');

  // O reflow força a transição a acontecer quando o elemento acabou de ser
  // criado: sem ele o navegador junta criar e mostrar num quadro só, e a
  // barra aparece de estalo.
  void el.offsetHeight;
  el.classList.add("visivel");
}

/**
 * Roda algo demorado sem segurar a tela.
 *
 * Devolve a promessa para quem quiser esperar -- mas o normal é NÃO esperar:
 * quem chama fecha a folha e segue. O retorno existe para o caso raro de uma
 * segunda etapa depender da primeira.
 */
function emSegundoPlano(rotulo, fn, aoTerminar) {
  const id = proximaTarefaId++;
  tarefasFundo.push({ id: id, rotulo: rotulo });
  pintarBarraFundo();

  return Promise.resolve()
    .then(fn)
    .then(function (r) {
      if (typeof aoTerminar === "function") aoTerminar(r, null);
      return r;
    })
    .catch(function (e) {
      // O erro vira aviso na tela, não exceção solta: ninguém está esperando
      // esta promessa, então um throw aqui morreria calado no console.
      mostrarToast("⚠ " + rotulo + ": " + (e && e.message ? e.message : "falhou"));
      if (typeof aoTerminar === "function") aoTerminar(null, e);
      return null;
    })
    .then(function (r) {
      tarefasFundo = tarefasFundo.filter(function (t) { return t.id !== id; });
      pintarBarraFundo();
      return r;
    });
}

// ============================================================================
// PRÉ-CARGA — ter o ano inteiro antes de precisar dele
// ----------------------------------------------------------------------------
// O carimbo evita rebuscar o que não mudou, mas só depois da primeira visita.
// Abrir um mês pela primeira vez continuava custando a espera inteira.
//
// Aqui o app pede 25 meses (12 para trás, o atual, 12 para frente) e os 500
// lançamentos mais recentes numa chamada só, em segundo plano, logo depois de
// entrar. Depois disso, navegar no tempo não fala mais com o servidor.
//
// Roda de novo quando o carimbo de transações muda -- ou seja, quando alguma
// coisa de dinheiro foi gravada. Não roda a cada abertura: seria baixar o ano
// inteiro para descobrir que continua igual.
// ============================================================================
const PRECARGA_MARCA = "sb_precarga";
const LANCAMENTOS_CHAVE = "sb_lancamentos";

function precargaEstaEmDia() {
  try {
    const p = JSON.parse(localStorage.getItem(PRECARGA_MARCA) || "null");
    if (!p) return false;

    // A pergunta aqui é "os meses ESTÃO guardados?", não "estão atualizados?".
    //
    // Enquanto valia o carimbo, lançar uma despesa fazia os 25 meses serem
    // baixados de novo na abertura seguinte. Agora eles ficam, e cada um se
    // atualiza sozinho quando é aberto -- um mês de cada vez, atrás da tela.

    // Confere se o dado está MESMO lá, em vez de acreditar só na marca.
    //
    // Marca e dado moram em chaves diferentes, e uma limpeza que pegue uma e
    // não a outra é possível -- foi o que aconteceu. Uma marca que mente não
    // se conserta sozinha: a pré-carga nunca mais roda, e o sintoma é voltar
    // a carregar mês a mês sem nada explicando por quê.
    //
    // A conferida é no ÚLTIMO mês que a pré-carga gravou, não no mês de hoje:
    // o de hoje aparece no cache só por você ter aberto o app, então ele
    // estaria lá mesmo com o resto do ano faltando.
    return !!(p.prova && localStorage.getItem(p.prova));
  } catch (e) {
    return false;
  }
}

/**
 * Busca o ano inteiro e guarda.
 *
 * Não devolve nada e não trava nada: quem chama dispara e segue. Se falhar, o
 * app continua exatamente como era -- cada mês buscado quando for aberto.
 */
async function preCarregarAno() {
  if (precargaEstaEmDia()) return;

  const r = await chamarServidor("preCarga", {});
  if (!r || !r.ok) return;

  const carimbo = carimbosConhecidos.transacoes;
  let guardados = 0;

  // A chave do mês mais distante que conseguiu entrar. É por ela que a
  // próxima abertura confere se a pré-carga continua de pé -- e ela funciona
  // mesmo quando o armazenamento encheu e só metade dos meses coube.
  let prova = "";

  // Do mês atual para fora, alternando. Se o armazenamento encher no meio, o
  // que sobra guardado são os meses PERTO de hoje -- que são os que se abre.
  // Guardando em ordem, o estouro comeria sempre o futuro.
  const ordenados = (r.meses || []).slice().sort(function (a, b) {
    return Math.abs(distanciaEmMeses(a)) - Math.abs(distanciaEmMeses(b));
  });

  for (let i = 0; i < ordenados.length; i++) {
    const m = ordenados[i];
    // Uma escrita só. Guardar duas cópias do mesmo mês era o que enchia o
    // armazenamento -- e a segunda falhava calada, deixando o seletor cego.
    if (!salvarCache(m.mes, m.ano, m.dados)) break;   // encheu: fica o que entrou

    guardados++;
    prova = chaveDashboard(m.mes, m.ano);
  }

  try {
    if (r.buscaInicial) {
      localStorage.setItem(
        CACHE_LEITURA + 'buscarLancamentos|{"pagina":0}',
        JSON.stringify({ carimbo: carimbo, quando: Date.now(), dados: r.buscaInicial }));
    }
    if (r.lancamentos) {
      localStorage.setItem(LANCAMENTOS_CHAVE, JSON.stringify({
        carimbo: carimbo, quando: Date.now(), itens: r.lancamentos
      }));
    }
    localStorage.setItem(PRECARGA_MARCA, JSON.stringify({
      carimbo: carimbo, quando: Date.now(), meses: guardados, prova: prova
    }));
  } catch (e) {}
}

function distanciaEmMeses(m) {
  const hoje = new Date();
  return (m.ano - hoje.getFullYear()) * 12 + (m.mes - hoje.getMonth());
}

/** Os últimos lançamentos guardados, para quem quiser sem ir à rede. */
function lancamentosGuardados() {
  try {
    const p = JSON.parse(localStorage.getItem(LANCAMENTOS_CHAVE) || "null");
    return (p && p.itens) ? p.itens : [];
  } catch (e) {
    return [];
  }
}

// ============================================================================
// TEMAS
// ----------------------------------------------------------------------------
// Cada tema e um conjunto dos MESMOS tokens, redefinidos num bloco
// :root[data-tema="..."] do CSS. Aqui so se escreve o atributo -- nenhuma cor
// mora no JavaScript, senao trocar de tema exigiria mexer nos dois lugares.
// ============================================================================
const TEMA_CHAVE = "sb_tema";

const TEMAS = [
  { v: "",          nome: "Padrão",   fundo: "#e8ecf3", texto: "#1e293b",
    pontos: ["#2e9e6b", "#f97316", "#b91c1c"] },
  { v: "papel",     nome: "Papel",    fundo: "#ece6dd", texto: "#332e28",
    pontos: ["#3f7d55", "#b06f22", "#ab3b2b"] },
  { v: "salvia",    nome: "Sálvia",   fundo: "#e3e9e1", texto: "#26302a",
    pontos: ["#2f6b4f", "#a96826", "#a13429"] },
  { v: "petroleo",  nome: "Petróleo", fundo: "#e2ecea", texto: "#1c2b2a",
    pontos: ["#0f766e", "#b1661a", "#a93a34"] },
  { v: "indigo",    nome: "Índigo",   fundo: "#e8e7f2", texto: "#23213a",
    pontos: ["#2f7d5e", "#b0620f", "#a83055"] },
  { v: "ardosia",   nome: "Ardósia",  fundo: "#2a2f37", texto: "#e6ebf2",
    pontos: ["#4ade80", "#fbbf24", "#f87171"] },
  { v: "cafe",      nome: "Café",     fundo: "#2b2622", texto: "#f0e9e1",
    pontos: ["#7cc79a", "#e0a34a", "#ef8272"] }
];

function temaGuardado() {
  try { return localStorage.getItem(TEMA_CHAVE) || ""; } catch (e) { return ""; }
}

/**
 * Escreve o tema no <html>.
 *
 * Roda ANTES da primeira pintura (a chamada esta no fim deste arquivo, que
 * carrega no <head>): aplicar depois faria a tela piscar no tema errado a
 * cada abertura.
 */
function aplicarTema(v) {
  const raiz = document.documentElement;
  if (v) raiz.setAttribute("data-tema", v);
  else raiz.removeAttribute("data-tema");

  // A barra de status do celular acompanha o fundo. Sem isso ela fica preta
  // sobre um app bege, que e o tipo de detalhe que denuncia remendo.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const achado = TEMAS.filter(function (x) { return x.v === v; })[0];
    if (achado) meta.setAttribute("content", achado.fundo);
  }
}

function escolherTema(v) {
  try { localStorage.setItem(TEMA_CHAVE, v); } catch (e) {}
  aplicarTema(v);
  pintarEscolhaDeTema();
}

function pintarEscolhaDeTema() {
  const alvo = document.getElementById("cfg-tema-grade");
  if (!alvo) return;

  const atual = temaGuardado();

  alvo.innerHTML = TEMAS.map(function (x) {
    const pontos = x.pontos.map(function (c) {
      return '<span class="cfg-tema-ponto" style="background:' + c + '"></span>';
    }).join("");

    return '<button type="button" class="cfg-tema-op' + (x.v === atual ? " ativo" : "") +
        '" onclick="escolherTema(' + JSON.stringify(x.v).replace(/"/g, "&quot;") + ')">' +
        '<span class="cfg-tema-amostra" style="background:' + x.fundo +
          '; box-shadow: inset 0 0 0 1px rgba(0,0,0,.08)">' + pontos + '</span>' +
        '<span class="cfg-tema-nome">' + escaparHtml(x.nome) + '</span>' +
      '</button>';
  }).join("");

  // A fileira rola de lado, e o tema escolhido pode estar fora da parte
  // visível -- o Café, que é o último, começa 126px além da borda. Abrir
  // Configurações e não enxergar qual está ligado é o mesmo que não marcar.
  const ligado = alvo.querySelector(".cfg-tema-op.ativo");
  if (ligado) {
    // Pela POSICAO NA TELA, nao por offsetLeft: offsetLeft e medido a partir
    // do primeiro ancestral posicionado, que aqui nao e o proprio rolador --
    // medir por ele rolava 37px em vez dos 134 que faltavam.
    const cx = alvo.getBoundingClientRect();
    const op = ligado.getBoundingClientRect();
    if (op.right > cx.right) alvo.scrollLeft += (op.right - cx.right) + 8;
    else if (op.left < cx.left) alvo.scrollLeft -= (cx.left - op.left) + 8;
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
      aplicarRestricaoDaConta(r);
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

  // Manda os DOIS quando existem. O servidor tenta a sessão primeiro e cai no
  // token se ela não valer.
  //
  // Antes era `else if`: com uma sessão inválida gravada, o token do login
  // novo nunca era enviado, e o app ficava preso repetindo a credencial morta
  // — o Google logava, voltava, e nada mudava.
  const base = { acao: acao };
  if (sessaoAtual) base.sessao = sessaoAtual;
  if (tokenLoginAtual) base.token = tokenLoginAtual;

  const params = new URLSearchParams(Object.assign(base, paramsExtras));
  const url = API_URL + "?" + params.toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Falha na conexão (HTTP " + resp.status + ").");

  const dados = await resp.json();

  // Sessão recusada: apaga na hora. Guardá-la só faria a próxima chamada
  // repetir o mesmo erro, e é isso que trava o login.
  if (dados && dados.erro === "NAO_AUTORIZADO" && sessaoAtual) {
    sessaoAtual = null;
    apagarSessao();
  }

  // O servidor diz o que gravou. Aqui, e não em cada botão, porque esquecer
  // numa tela só apareceria como um número que não atualiza -- sem erro,
  // sem aviso, e difícil de ligar à tela que esqueceu.
  if (dados && dados._carimbou) {
    dados._carimbou.forEach(sujarDominio);
  }

  return dados;
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

// A fatura liquidava direto num confirm(), sem lugar para o comprovante — que
// é justamente o documento mais importante do mês. Agora abre uma gaveta com
// a data do pagamento e o anexo, como na liquidação de uma despesa avulsa.
let faturaLiquidando = null;

function liquidarFaturaNaTela(indice) {
  const f = faturasNaTela[indice];
  if (!f) return;

  faturaLiquidando = f;

  let detalhe;
  if (f.qtd > 0) detalhe = formatarMoeda(f.valor) + " em " + f.qtd + " compra(s)";
  else if (f.valor > 0) detalhe = formatarMoeda(f.valor);
  else detalhe = "Todas as compras em aberto dessa fatura";

  document.getElementById("modal-fatura").style.display = "flex";
  document.getElementById("lf-titulo").textContent = f.descricao;
  document.getElementById("lf-detalhe").textContent =
    detalhe + (f.vencimento ? " · vence " + formatarDataBR(f.vencimento) : "");
  document.getElementById("lf-datapgto").value = dataHojeISO();
  document.getElementById("lf-aviso").textContent = "";

  limparComprovanteFatura();
}

function formatarDataBR(iso) {
  const p = (iso || "").split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

function fecharLiquidarFatura() {
  document.getElementById("modal-fatura").style.display = "none";
  faturaLiquidando = null;
  limparComprovanteFatura();
}

function limparComprovanteFatura() {
  comprovanteFatura = null;
  const el = document.getElementById("lf-comprovante-nome");
  if (el) el.textContent = "";
  const inp = document.getElementById("lf-arquivo");
  if (inp) inp.value = "";
}

let comprovanteFatura = null;

function escolherComprovanteFatura(input) {
  const arq = input.files && input.files[0];
  if (!arq) return;

  // 6 MB é o teto do que o Apps Script aceita por requisição.
  if (arq.size > 6 * 1024 * 1024) {
    document.getElementById("lf-aviso").textContent = "Arquivo maior que 6 MB.";
    input.value = "";
    return;
  }

  const leitor = new FileReader();
  leitor.onload = function () {
    comprovanteFatura = {
      nome: arq.name,
      mime: arq.type || "application/octet-stream",
      base64: String(leitor.result).split(",")[1] || ""
    };
    document.getElementById("lf-comprovante-nome").textContent = "📎 " + arq.name;
    document.getElementById("lf-aviso").textContent = "";
  };
  leitor.readAsDataURL(arq);
}

async function confirmarLiquidarFatura() {
  const f = faturaLiquidando;
  if (!f) return;

  const btn = document.getElementById("lf-btn-confirmar");
  const dataPgto = document.getElementById("lf-datapgto").value;
  if (!dataPgto) {
    document.getElementById("lf-aviso").textContent = "Informe a data do pagamento.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Liquidando...";

  try {
    const r = await chamarServidor("liquidarFatura", {
      cartao: f.cartao,
      vencimento: f.vencimento,
      dataPagamento: dataPgto
    });

    if (!r.ok) {
      document.getElementById("lf-aviso").textContent = r.mensagem || "Não foi possível liquidar.";
      btn.disabled = false;
      btn.textContent = "Liquidar fatura";
      return;
    }

    // Guarda o anexo ANTES de fechar: fecharLiquidarFatura() limpa o
    // comprovante, e sem isto ele era descartado sem aviso.
    const anexo = comprovanteFatura;
    const descricaoFatura = f.descricao;

    fecharLiquidarFatura();
    mostrarToast("✅ " + r.mensagem);
    limparTodoCache();

    // O comprovante vai DEPOIS da liquidação: se o arquivo falhar, a fatura
    // já está liquidada e dá para anexar de novo — o contrário deixaria o
    // documento guardado apontando para uma fatura ainda em aberto.
    if (anexo) {
      mostrarToast("⏳ Anexando o comprovante...", true);
      try {
        const a = await chamarServidorPost("arquivarDocumento", {
          arquivoBase64: anexo.base64,
          nomeArquivo: anexo.nome,
          mimeType: anexo.mime,
          descricao: "Comprovante " + descricaoFatura,
          dataDocumento: dataPgto
        });
        mostrarToast(a.ok ? "✅ Comprovante anexado."
                          : "⚠ Fatura liquidada, mas o comprovante não subiu.");
      } catch (e) {
        mostrarToast("⚠ Fatura liquidada, mas o comprovante não subiu.");
      }
    }

    await recarregarDados();

  } catch (e) {
    document.getElementById("lf-aviso").textContent = "Sem conexão. Nada foi alterado.";
    btn.disabled = false;
    btn.textContent = "Liquidar fatura";
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
      const rl = await lerCacheado("listasValidas");
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

// Excluir respeita o mesmo escopo da edição: numa compra parcelada, "desta em
// diante" ou "todas". Sem isso sobraria meia compra na planilha.
async function excluirLancamentoApp() {
  if (!edicaoAtual) return;

  const it = edicaoAtual;
  const partes = (it.parcela || "").toString().split("/");
  const totalParc = partes.length === 2 ? (parseInt(partes[1]) || 1) : 1;

  let texto = 'Excluir "' + (it.descricao || "") + '" (MOV-' + it.numMov + ')?';
  if (totalParc > 1) {
    texto += escopoEdicao === "todas"
      ? "\n\nVai apagar TODAS as " + totalParc + " parcelas."
      : "\n\nVai apagar desta parcela em diante.";
  }
  texto += "\n\nIsso não tem desfazer.";

  if (!confirm(texto)) return;

  try {
    const r = await chamarServidor("excluirLancamento", {
      numMov: it.numMov,
      escopo: escopoEdicao
    });

    if (r.ok) {
      fecharEdicao();
      mostrarToast("✅ " + r.mensagem);
      if (typeof fecharDetalhe === "function") fecharDetalhe();
      await recarregarDados();
      if (abaAtiva === "busca") buscarLancamentos();
    } else {
      document.getElementById("edt-aviso").textContent = r.mensagem || "Não foi possível excluir.";
    }
  } catch (e) {
    document.getElementById("edt-aviso").textContent = "Sem conexão.";
  }
}

// ============================================================================
// CONFIRMAÇÃO COM ATALHO PARA EDITAR
// ----------------------------------------------------------------------------
// Toda inclusão, edição e liquidação termina aqui. O "Editar" ao lado da
// mensagem existe porque é NESSE instante que se percebe o erro de digitação —
// e sem ele o caminho seria ir na busca, procurar o lançamento e abrir.
// ============================================================================
function mostrarToastComEditar(msg, numMov) {
  const t = document.getElementById("toast");
  if (!t) return;

  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

  t.innerHTML = "";
  const txt = document.createElement("span");
  txt.textContent = msg;
  t.appendChild(txt);

  if (numMov) {
    const b = document.createElement("button");
    b.className = "toast-acao";
    b.textContent = "Editar";
    b.onclick = function () {
      t.classList.remove("visivel");
      abrirEdicaoPorMov(numMov);
    };
    t.appendChild(b);
  }

  t.classList.add("visivel");
  // Mais tempo que o toast comum: aqui há um botão para alcançar.
  toastTimer = setTimeout(function () { t.classList.remove("visivel"); }, 9000);
}

// A edição precisa do lançamento em mãos; vindo de uma inclusão, ele ainda não
// está em nenhuma lista da tela, então busca no servidor pelo número.
async function abrirEdicaoPorMov(numMov) {
  const naTela = (resultadosBusca || []).filter(function (x) { return x.numMov === numMov; })[0];
  if (naTela) { abrirEdicao(numMov); return; }

  mostrarToast("Abrindo lançamento...");
  try {
    const r = await chamarServidor("buscarLancamento", { numMov: numMov });
    if (r.ok && r.lancamento) {
      itemDetalhe = r.lancamento;
      abrirEdicao(numMov);
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não encontrei o lançamento."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
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
      const movEditado = edicaoAtual.numMov;
      fecharEdicao();
      mostrarToastComEditar("✅ " + r.mensagem, movEditado);
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

      // Dois avisos por conta: na véspera para dar tempo de resolver, e no
      // próprio dia porque é nele que o pagamento vence. Só a véspera deixava
      // passar quem não abriu o app naquele dia.
      //
      // Os ids saem de faixas separadas (i e i+500) para os dois não se
      // sobrescreverem — o plugin usa o id como chave.
      const vespera = new Date(venc.getFullYear(), venc.getMonth(), venc.getDate() - 1, 9, 0, 0);
      const noDia   = new Date(venc.getFullYear(), venc.getMonth(), venc.getDate(), 8, 0, 0);

      if (vespera > agora) {
        aAgendar.push({
          id: ID_BASE_NOTIFICACAO + i,
          title: c.ehFatura ? "Fatura vence amanhã" : "Conta vence amanhã",
          body: c.descricao + " · " + formatarMoeda(c.valor),
          schedule: { at: vespera, allowWhileIdle: true }
        });
      }

      if (noDia > agora) {
        aAgendar.push({
          id: ID_BASE_NOTIFICACAO + 500 + i,
          title: c.ehFatura ? "⚠️ Fatura vence HOJE" : "⚠️ Conta vence HOJE",
          body: c.descricao + " · " + formatarMoeda(c.valor),
          schedule: { at: noDia, allowWhileIdle: true }
        });
      }
    });

    if (aAgendar.length > 0) await LN.schedule({ notifications: aAgendar });
  } catch (e) {
    // Notificação é um extra: se falhar, o app segue normal.
    console.warn("Notificações locais não agendadas:", e);
  }
}

// ============================================================================
// SUGESTÃO DE DESCRIÇÃO
// Digitar "10 p" e o campo oferecer "10 pães" porque já foi lançado antes.
// Usa o autocomplete nativo do campo (datalist): o teclado do Android já sabe
// mostrar e filtrar, sem código de tecla nenhum.
// A lista é carregada UMA vez por sessão — buscar a cada tecla seria
// insuportável com a lentidão do Apps Script.
// ============================================================================
let descricoesCarregadas = false;

async function carregarSugestoesDescricao() {
  if (descricoesCarregadas) return;
  descricoesCarregadas = true;   // marca antes: evita duas cargas simultâneas

  try {
    const r = await lerCacheado("descricoesUsadas");
    if (!r.ok || !r.descricoes) return;

    const lista = document.getElementById("lista-descricoes");
    if (!lista) return;

    lista.innerHTML = r.descricoes.map(function (d) {
      return '<option value="' + escaparHtml(d) + '"></option>';
    }).join("");
  } catch (e) {
    descricoesCarregadas = false;   // deixa tentar de novo depois
  }
}

// ============================================================================
// DOCUMENTO COMPARTILHADO DE OUTRO APP
// O lado nativo recebe o arquivo (imagem ou PDF), converte para base64 e
// deixa no armazenamento compartilhado. Aqui ele é recuperado e o app abre
// as opções — lançar por IA, arquivar, ou lançar na mão.
// O arquivo é apagado do armazenamento assim que lido: ele é pesado e não
// pode reaparecer no próximo uso.
// ============================================================================
let documentoCompartilhado = null;

async function verificarDocumentoCompartilhado() {
  if (!rodandoNoAplicativo()) return;

  try {
    const P = window.Capacitor.Plugins.Preferences;
    if (!P) return;

    const guardado = await P.get({ key: "doc_compartilhado" });
    if (!guardado || !guardado.value) return;

    const mime = await P.get({ key: "doc_compartilhado_mime" });
    const nome = await P.get({ key: "doc_compartilhado_nome" });

    documentoCompartilhado = {
      base64: guardado.value,
      mimeType: (mime && mime.value) || "image/jpeg",
      nome: (nome && nome.value) || "documento"
    };

    await P.remove({ key: "doc_compartilhado" });
    await P.remove({ key: "doc_compartilhado_mime" });
    await P.remove({ key: "doc_compartilhado_nome" });

    quandoTelaPronta(abrirOpcoesDoCompartilhado);
  } catch (e) {
    console.warn("Documento compartilhado não pôde ser lido:", e);
  }
}

function abrirOpcoesDoCompartilhado() {
  if (!documentoCompartilhado) return;
  document.getElementById("modal-compartilhado").style.display = "flex";
  document.getElementById("comp-nome").textContent = documentoCompartilhado.nome;
}

function fecharCompartilhado() {
  document.getElementById("modal-compartilhado").style.display = "none";
  documentoCompartilhado = null;
}

// Usa o documento recebido no fluxo escolhido. "manual" ignora o arquivo de
// propósito: lançar na mão não depende dele.
function usarCompartilhado(comoFazer) {
  const doc = documentoCompartilhado;
  document.getElementById("modal-compartilhado").style.display = "none";

  if (comoFazer === "manual") {
    documentoCompartilhado = null;
    escolherAcao("manual");
    return;
  }

  // Liquidar: o documento vira o comprovante da baixa. Como ainda não se sabe
  // QUAL despesa, o app leva para a lista de pendentes e segura o arquivo até
  // a liquidação ser aberta.
  if (comoFazer === "liquidar") {
    comprovanteLiquidacao = {
      base64: doc.base64,
      mimeType: doc.mimeType,
      nome: doc.nome
    };
    comprovanteVeioDeFora = true;
    documentoCompartilhado = null;

    trocarAba("busca");
    const status = document.getElementById("bl-status");
    if (status) status.value = "pendente";
    abrirBusca();

    mostrarToast("📎 Escolha a despesa para liquidar com este comprovante.", true);
    return;
  }

  modoDocumento = (comoFazer === "arquivar") ? "arquivar" : "lancar";
  abrirSeletorArquivo();

  // Entrega o arquivo já pronto, como se tivesse sido escolhido ali
  arquivoAtual = {
    base64: doc.base64,
    mimeType: doc.mimeType,
    nome: doc.nome,
    preview: "data:" + doc.mimeType + ";base64," + doc.base64
  };
  documentoCompartilhado = null;

  const prev = document.getElementById("doc-preview");
  if (doc.mimeType.indexOf("image") === 0) {
    prev.innerHTML = '<img src="' + arquivoAtual.preview + '" alt="prévia" />' +
                     '<div class="dp-nome">' + escaparHtml(doc.nome) + '</div>';
  } else {
    prev.innerHTML = '<div class="dp-pdf">📄</div>' +
                     '<div class="dp-nome">' + escaparHtml(doc.nome) + '</div>';
  }
  prev.style.display = "block";
  habilitarCaminhosDoDocumento(true);
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
  else if (qual === "tarefas") trocarAba("tarefas");
  else if (qual === "trabalho") abrirTrabalho();
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

  // Sugestões são do mês que estava em tela; ao virar o mês elas ficariam
  // penduradas fora de contexto.
  const sug = document.getElementById("cal-sugestoes");
  if (sug) sug.innerHTML = "";

  carregarCalendario();
}

async function carregarCalendario() {
  document.getElementById("cal-mes-nome").textContent = MESES_NOMES[calMes] + " de " + calAno;
  document.getElementById("cal-grade").innerHTML = '<p class="vazio" style="grid-column:1/8;">Carregando...</p>';

  try {
    const r = await lerCacheado("dadosCalendario", { mes: calMes, ano: calAno });
    calDados = r.ok ? { compromissos: r.compromissos || [], despesas: r.despesas || [] }
                    : { compromissos: [], despesas: [] };
    if (!r.ok) mostrarToast("❌ " + (r.mensagem || "Não consegui carregar o mês."));
  } catch (e) {
    calDados = { compromissos: [], despesas: [] };
    mostrarToast("❌ Sem conexão.");
  }

  desenharGradeCalendario();
  mostrarDiaCalendario(calDiaEscolhido);
  alimentarWidgetAgenda();
}

// Grava a agenda que o widget do Smartcalendário mostra.
// Feito aqui porque neste ponto compromissos e despesas do mês já estão em
// mãos — pedir de novo ao servidor só para o widget custaria uma consulta a
// mais em cada abertura do app.
async function alimentarWidgetAgenda() {
  if (!rodandoNoAplicativo()) return;

  try {
    const P = window.Capacitor.Plugins.Preferences;
    if (!P) return;

    const hojeISO = dataParaISO(new Date());
    const itens = [];

    calDados.compromissos.forEach(function (c) {
      if (c.data < hojeISO || c.concluido) return;
      itens.push({
        iso: c.data,
        data: c.data.slice(8, 10) + "/" + c.data.slice(5, 7),
        texto: "📌 " + c.titulo + (c.hora ? " · " + c.hora : "")
      });
    });

    calDados.despesas.forEach(function (d) {
      if (d.data < hojeISO) return;
      itens.push({
        iso: d.data,
        data: d.data.slice(8, 10) + "/" + d.data.slice(5, 7),
        texto: (d.ehFatura ? "💳 " : "") + d.descricao + " · " + formatarMoeda(d.valor)
      });
    });

    itens.sort(function (a, b) { return a.iso.localeCompare(b.iso); });

    await P.set({ key: "widget_agenda", value: JSON.stringify(itens.slice(0, 4)) });

    const W = window.Capacitor.Plugins.Widget;
    if (W && W.atualizar) await W.atualizar();
  } catch (e) {
    console.warn("Agenda do widget não atualizada:", e);
  }
}

// ============================================================================
// WIDGET DE CALENDÁRIO
// ----------------------------------------------------------------------------
// Busca o resumo do mês e entrega ao widget, junto da credencial que o botão
// "atualizar" dele usa para buscar sozinho depois.
//
// Roda quando o app carrega dados novos. Sem isso o widget ficaria preso ao
// ciclo de meia hora do Android e mostraria número velho logo depois de você
// liquidar uma conta aqui dentro.
// ============================================================================
async function alimentarWidgetCalendario() {
  const W = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Widget;
  if (!W || !W.guardarResumo) return;   // navegador, ou APK antigo

  try {
    const r = await chamarServidor("resumoWidget");
    if (!r || !r.ok) return;

    await W.guardarResumo({ resumo: JSON.stringify(r) });

    // A credencial vai junto, e só quando existe sessão de verdade. Passar
    // vazio APAGA a guardada: credencial velha faria o serviço do widget
    // tentar em silêncio e falhar para sempre.
    if (W.guardarCredencial) {
      await W.guardarCredencial({
        url: sessaoAtual ? API_URL : "",
        sessao: sessaoAtual || ""
      });
    }
  } catch (e) {
    // Widget é conveniência: falhar aqui não pode atrapalhar o app.
    console.warn("Widget de calendário não atualizado:", e);
  }
}

// ============================================================================
// PLANOS DE COMPRA
// ----------------------------------------------------------------------------
// A despesa que ainda não existe. Passa pelos sete tópicos antes de virar
// lançamento; enquanto está em análise não aparece em Transações nem em
// Aprovações.
//
// Cinco tópicos o servidor responde sozinho. Os outros dois são seus -- e são
// justamente os que não dá para automatizar: por que você quer, e se está
// comprando por cansaço.
// ============================================================================
let planosCarregados = [];
let planoAberto = null;
let topicoAberto = null;
let planoFiltroPessoa = "";          // "" = todos
let planoPessoas = ["Paulo"];
let planoPerguntas = {};
let planoPerguntasPresente = {};
let planoFrequencias = [];
let planoSigiloConfigurado = false;
let planoCofrePorPessoa = {};

const NOMES_TOPICOS = {
  1: "Necessidade", 2: "Impacto no orçamento", 3: "Custo real",
  4: "Pesquisa", 5: "Carência", 6: "Motivação", 7: "Decisão"
};
const TOPICOS_AUTOMATICOS = [2, 5, 7];

async function carregarPlanos() {
  const lista = document.getElementById("planos-lista");
  try {
    const r = await lerCacheado("listarPlanos");
    if (!r.ok) { lista.innerHTML = '<p class="vazio">⚠️ ' + escaparHtml(r.mensagem || "Erro.") + '</p>'; return; }

    planosCarregados = r.planos || [];
    planoPessoas = r.pessoas || planoPessoas;
    planoPerguntas = r.perguntas || {};
    planoPerguntasPresente = r.perguntasPresente || {};
    planoFrequencias = r.frequencias || [];
    planoSigiloConfigurado = r.sigiloConfigurado === true;
    planoCofrePorPessoa = r.cofrePorPessoa || {};
    pintarRevisoes(r.revisoes || []);

    pintarCofre(r.cofre || 0);
    pintarFiltroPessoas();
    pintarListaPlanos();
    marcarCarenciasVencidas();

  } catch (e) {
    lista.innerHTML = '<p class="vazio">⚠️ Sem conexão.</p>';
  }
}

function pintarCofre(valor) {
  const alvo = document.getElementById("planos-cofre");
  if (!valor) { alvo.innerHTML = ""; return; }

  // Com filtro ligado, o cofre mostra o daquela pessoa: número total com
  // lista filtrada seria duas verdades na mesma tela.
  const mostrado = planoFiltroPessoa
    ? (planoCofrePorPessoa[planoFiltroPessoa] || 0)
    : valor;

  alvo.innerHTML = '<div class="cofre-card" onclick="abrirCofre()">' +
      '<div class="cofre-rot">não comprei' +
        (planoFiltroPessoa ? " · " + escaparHtml(planoFiltroPessoa) : "") + '</div>' +
      '<div class="cofre-valor">' + formatarMoeda(mostrado) + '</div>' +
      '<div class="cofre-sub">toque para ver o que está aqui dentro</div>' +
    '</div>';
}

function pintarFiltroPessoas() {
  const alvo = document.getElementById("planos-filtro");
  if (!alvo) return;

  const opcoes = [""].concat(planoPessoas);
  alvo.innerHTML = opcoes.map(function (nome) {
    const ativo = planoFiltroPessoa === nome;
    const quantos = nome
      ? planosCarregados.filter(function (p) { return p.pessoa === nome; }).length
      : planosCarregados.length;
    return '<button class="chip-pessoa' + (ativo ? " ativo" : "") + '" ' +
      'onclick="filtrarPessoa(' + JSON.stringify(nome).replace(/"/g, "&quot;") + ')">' +
      (nome || "Todos") + (quantos ? ' <b>' + quantos + '</b>' : '') + '</button>';
  }).join("");
}

function filtrarPessoa(nome) {
  planoFiltroPessoa = nome;
  pintarFiltroPessoas();
  pintarListaPlanos();
  // O cofre acompanha o filtro.
  const total = Object.keys(planoCofrePorPessoa).reduce(function (s, k) {
    return s + planoCofrePorPessoa[k];
  }, 0);
  pintarCofre(total);
}

function planosVisiveis() {
  if (!planoFiltroPessoa) return planosCarregados;
  return planosCarregados.filter(function (p) { return p.pessoa === planoFiltroPessoa; });
}

function pintarListaPlanos() {
  const lista = document.getElementById("planos-lista");
  const visiveis = planosVisiveis();

  if (!visiveis.length) {
    lista.innerHTML = '<div class="planos-vazio">' +
      '<div class="planos-vazio-icone">🛒</div>' +
      (planoFiltroPessoa
        ? "Nenhum plano de " + escaparHtml(planoFiltroPessoa) + "."
        : "Nenhum plano aberto.<br>O primeiro é aquela compra que você está adiando decidir.") +
      '</div>';
    document.getElementById("badge-planos").textContent = "";
    return;
  }

  // O badge conta só o que já pode ser decidido: número que pisca por algo
  // que ainda vai esperar 20 dias é ruído.
  const prontos = planosCarregados.filter(function (p) {
    return p.veredito.situacao === "pronto";
  }).length;
  document.getElementById("badge-planos").textContent = prontos ? prontos : "";

  lista.innerHTML = visiveis.map(function (p) {
    const cor = corDoVeredito(p.veredito.situacao);
    const i = planosCarregados.indexOf(p);
    const marca = (p.tipo === "presente" ? "🎁 " : "");

    return '<div class="plano-card" onclick="abrirPlano(' + i + ')">' +
        '<div class="plano-topo">' +
          '<span class="plano-nome">' + marca + escaparHtml(p.titulo) + '</span>' +
          '<span class="plano-valor">' + formatarMoeda(p.valor) + '</span>' +
        '</div>' +
        '<div class="plano-linha2">' +
          '<span class="plano-selo" style="color:' + cor + '">' + p.veredito.texto + '</span>' +
          '<span class="plano-nota">' + escaparHtml(p.pessoa) + ' · ' + p.respondidos + '/7' +
            (p.links && p.links.length ? ' · ' + p.links.length + ' preço(s)' : '') +
          '</span>' +
        '</div>' +
        (p.prioridadeIA || p.frequenciaRotulo
          ? '<div class="plano-chips">' +
              (p.prioridadeIA
                ? '<span class="chip-prio ' + p.prioridadeIA.replace("é", "e") + '">' +
                  'prioridade ' + p.prioridadeIA + '</span>'
                : '') +
              (p.frequenciaRotulo
                ? '<span class="chip-freq">' + escaparHtml(p.frequenciaRotulo.toLowerCase()) +
                  (p.custoPorUso ? ' · ' + formatarMoeda(p.custoPorUso) + '/uso' : '') +
                  '</span>'
                : '') +
            '</div>'
          : '') +
        '<div class="plano-barra"><div style="width:' + Math.round(p.respondidos / 7 * 100) +
          '%; background:' + cor + '"></div></div>' +
      '</div>';
  }).join("");
}

/**
 * Uma cor por situação, tirada da paleta do app.
 *
 * Só a cor, sem fundo: neste app o que separa uma superfície é o relevo, e
 * retângulo colorido briga com isso. A cor entra em ponto, texto e barra.
 */
function corDoVeredito(situacao) {
  if (situacao === "pronto")   return "var(--verde)";
  if (situacao === "carencia") return "var(--laranja)";
  if (situacao === "nao-cabe") return "var(--vermelho)";
  return "var(--azul-claro)";
}

// ---------------------------------------------------------------- novo plano
function abrirNovoPlano() {
  document.getElementById("modal-novo-plano").style.display = "flex";
  ["np-link", "np-titulo", "np-valor"].forEach(function (id) {
    document.getElementById(id).value = "";
  });
  document.getElementById("np-aviso").style.display = "none";
  document.getElementById("np-carencia").style.display = "none";

  const sel = document.getElementById("np-pessoa");
  sel.innerHTML = planoPessoas.map(function (n) {
    return '<option value="' + escaparHtml(n) + '">' + escaparHtml(n) + '</option>';
  }).join("");
  if (planoFiltroPessoa) sel.value = planoFiltroPessoa;
}

function fecharNovoPlano() {
  document.getElementById("modal-novo-plano").style.display = "none";
}

// Mostra a carência assim que o valor é digitado: saber que vai esperar 30
// dias ANTES de criar o plano é o que faz a regra ser aceita.
function mostrarCarenciaPrevista() {
  const v = parseFloat(document.getElementById("np-valor").value) || 0;
  const el = document.getElementById("np-carencia");
  if (!v) { el.style.display = "none"; return; }

  const dias = v <= 100 ? 1 : (v <= 500 ? 7 : 30);
  el.textContent = "Carência de " + (dias === 1 ? "24 horas" : dias + " dias") +
                   " para este valor. O app avisa quando vencer.";
  el.style.display = "block";
}

async function lerLinkDoPlano() {
  const url = document.getElementById("np-link").value.trim();
  const aviso = document.getElementById("np-aviso");
  const btn = document.getElementById("np-btn-ler");

  if (!url) { aviso.textContent = "Cole o link primeiro."; aviso.style.display = "block"; return; }

  btn.disabled = true;
  btn.textContent = "Lendo...";
  aviso.style.display = "none";

  try {
    const r = await chamarServidor("analisarLinkProduto", { url: url });

    // Mesmo quando não dá para ler o preço, o endereço costuma entregar o
    // nome. Preencher metade é melhor que devolver um erro e nada.
    if (r.produto && !document.getElementById("np-titulo").value.trim()) {
      document.getElementById("np-titulo").value = r.produto;
    }
    if (r.ok && r.preco) {
      document.getElementById("np-valor").value = Number(r.preco).toFixed(2);
      mostrarCarenciaPrevista();
      aviso.textContent = "✅ " + (r.loja || "loja") + " · " + formatarMoeda(r.preco);
    } else {
      aviso.textContent = "⚠️ " + (r.mensagem || "Não consegui ler.") +
                          " O link fica guardado do mesmo jeito.";
    }
    aviso.style.display = "block";

  } catch (e) {
    aviso.textContent = "⚠️ Sem conexão. O link fica guardado do mesmo jeito.";
    aviso.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "🔗 Ler o link";
  }
}

async function criarPlanoApp() {
  const titulo = document.getElementById("np-titulo").value.trim();
  const valor = document.getElementById("np-valor").value;
  const url = document.getElementById("np-link").value.trim();
  const pessoa = document.getElementById("np-pessoa").value;
  const aviso = document.getElementById("np-aviso");

  if (!titulo || !(parseFloat(valor) > 0)) {
    aviso.textContent = "Preencha o que é e quanto custa.";
    aviso.style.display = "block";
    return;
  }

  const btn = document.getElementById("np-btn-criar");
  btn.disabled = true;
  btn.textContent = "Criando...";

  try {
    const r = await chamarServidor("criarPlano", {
      titulo: titulo, valor: valor, pessoa: pessoa
    });
    if (!r.ok) { aviso.textContent = "⚠️ " + r.mensagem; aviso.style.display = "block"; return; }

    // O link é guardado mesmo sem leitura: ele é o caminho de volta para a
    // loja daqui a 30 dias, e isso vale por si.
    if (url) {
      await chamarServidor("adicionarLinkAoPlano", { id: r.id, url: url, preco: valor });
    }
    agendarAvisoCarencia(r.id, titulo, valor, r.carenciaDias);

    fecharNovoPlano();
    mostrarToast("✅ " + r.mensagem);
    carregarPlanos();

  } catch (e) {
    aviso.textContent = "⚠️ Sem conexão.";
    aviso.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Criar";
  }
}

/**
 * Agenda a notificação do fim da carência.
 *
 * É local, no aparelho: não depende de o app estar aberto nem de servidor
 * nenhum. Sem esse aviso, a carência viraria só um jeito de esquecer a
 * compra -- que às vezes é o objetivo, mas não pode ser o único resultado.
 */
async function agendarAvisoCarencia(id, titulo, valor, dias) {
  try {
    const LN = window.Capacitor && window.Capacitor.Plugins &&
               window.Capacitor.Plugins.LocalNotifications;
    if (!LN) return;

    const perm = await LN.checkPermissions();
    if (perm.display !== "granted") {
      const pedido = await LN.requestPermissions();
      if (pedido.display !== "granted") return;
    }

    const quando = new Date(Date.now() + dias * 86400000);
    quando.setHours(10, 0, 0, 0);   // de manhã, não no meio da noite

    await LN.schedule({
      notifications: [{
        // Id numérico derivado do id do plano: o Android exige número, e usar
        // o mesmo permite cancelar depois se o plano for decidido antes.
        id: Math.abs(hashDoTexto(id)) % 2000000,
        title: "Passaram " + (dias === 1 ? "24 horas" : dias + " dias"),
        body: titulo + " · " + formatarMoeda(valor) + ". Ainda quer?",
        schedule: { at: quando },
        extra: { plano: id }
      }]
    });
  } catch (e) {
    // Sem notificação o plano continua valendo; só não vai lembrar sozinho.
    console.warn("Aviso da carência não agendado:", e);
  }
}

function hashDoTexto(t) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
  return h;
}

// ------------------------------------------------------------------- a ficha
function abrirPlano(i) {
  planoAberto = planosCarregados[i];
  if (!planoAberto) return;
  topicoAberto = null;

  document.getElementById("modal-plano").style.display = "flex";
  document.getElementById("pl-titulo").textContent = planoAberto.titulo;
  document.getElementById("pl-sub").textContent =
    formatarMoeda(planoAberto.valor) + " · " +
    (planoAberto.tipo === "presente" ? "🎁 presente para " : "") + planoAberto.pessoa +
    (planoAberto.diasFaltando ? " · faltam " + planoAberto.diasFaltando + " dias" : "");
  pintarFicha();
}

function fecharPlano() {
  document.getElementById("modal-plano").style.display = "none";
  planoAberto = null;
}

function pintarFicha() {
  const p = planoAberto;
  const cor = corDoVeredito(p.veredito.situacao);

  document.getElementById("pl-veredito").innerHTML =
    '<div class="pl-veredito">' +
      '<span class="pl-veredito-ponto" style="background:' + cor + '"></span>' +
      '<span>' +
        '<span class="pl-veredito-txt" style="color:' + cor + '">' + p.veredito.texto + '</span>' +
        '<span class="pl-veredito-sub">sugestão do app; a decisão é sua</span>' +
      '</span>' +
    '</div>';

  let html = "";
  for (let n = 1; n <= 7; n++) {
    const automatico = TOPICOS_AUTOMATICOS.indexOf(n) >= 0;
    const conjunto = (p.tipo === "presente") ? planoPerguntasPresente : planoPerguntas;
    const perguntas = conjunto[String(n)] || [];
    const feito = automatico || perguntasCompletas(perguntas, p.respostas);
    const aberto = topicoAberto === n;

    let corpo = "";
    if (aberto) {
      corpo = '<div class="topico-corpo">' + (automatico ? autoDoTopico(n, p) : "");

      // Um campo por pergunta: com tudo numa caixa só, as perguntas de baixo
      // não são respondidas -- vira um parágrafo sobre a primeira.
      perguntas.forEach(function (q) {
        const v = (p.respostas[q.c] === undefined || p.respostas[q.c] === null)
          ? "" : p.respostas[q.c].toString();
        const campo = (q.tipo === "frequencia")
          ? campoFrequencia(q.c, v)
          : (q.tipo === "valor" || q.tipo === "numero")
          ? '<input type="number" step="' + (q.tipo === "valor" ? "0.01" : "1") +
            '" inputmode="decimal" id="resp-' + q.c + '" value="' + escaparHtml(v) + '" ' +
            'onclick="event.stopPropagation()" />'
          : '<textarea id="resp-' + q.c + '" onclick="event.stopPropagation()" ' +
            'placeholder="sua resposta">' + escaparHtml(v) + '</textarea>';

        html += "";
        corpo += '<div class="pergunta">' +
            '<label for="resp-' + q.c + '">' + escaparHtml(q.p) + '</label>' +
            campo +
          '</div>';
      });

      if (perguntas.length) {
        corpo += '<button class="btn-modal confirmar" style="width:100%; margin-top:8px;" ' +
          'onclick="event.stopPropagation(); salvarTopico(' + n + ')">Salvar</button>';
      }
      if (n === 2) corpo += simuladorHtml(p);
      if (n === 5) corpo += semDataHtml(p);
      if (n === 7) corpo += analiseHtml(p);
      if (n === 4) {
        corpo += '<button class="btn-modal cancelar" style="width:100%; margin-top:6px;" ' +
          'onclick="event.stopPropagation(); abrirLinks()">🔗 Onde comprar (' +
          (p.links ? p.links.length : 0) + ')</button>';
      }
      corpo += '</div>';
    }

    const corEstado = feito ? "var(--verde)" : "var(--cinza-texto)";
    html += '<div class="topico' + (aberto ? " aberto" : "") +
        '" onclick="alternarTopico(' + n + ')">' +
        '<div class="topico-topo">' +
          '<span class="topico-num" style="color:' + corEstado + '">' +
            (feito ? "✓" : n) + '</span>' +
          '<span class="topico-nome">' + NOMES_TOPICOS[n] + '</span>' +
          '<span class="topico-estado" style="color:' + corEstado + '">' +
            (automatico ? "automático" : (feito ? "respondido" : "pendente")) + '</span>' +
        '</div>' + corpo +
      '</div>';
  }
  document.getElementById("pl-topicos").innerHTML = html;

  pintarAcoesDoPlano();
}

function perguntasCompletas(perguntas, respostas) {
  if (!perguntas.length) return false;
  for (let i = 0; i < perguntas.length; i++) {
    const v = respostas[perguntas[i].c];
    if (v === undefined || v === null || v.toString().trim() === "") return false;
  }
  return true;
}

/** As respostas que o servidor deu. */
function autoDoTopico(n, p) {
  const linha = function (x) { return '<div class="topico-auto">' + x + "</div>"; };

  if (n === 2) {
    const l = [];
    l.push(p.cabe
      ? "<b>Cabe</b> sem mexer na reserva. Sobram " + formatarMoeda(p.sobraDepois) + " depois."
      : (p.mexeNaReserva
          ? "<b>Não cabe</b> no que sobra do mês. Só mexendo na reserva de emergência."
          : "<b>Não cabe</b> nem com a reserva."));
    if (p.horasDeTrabalho) l.push("São <b>" + p.horasDeTrabalho + " horas</b> de trabalho.");
    if (p.parcelasComprometidas) {
      l.push("Você já tem <b>" + formatarMoeda(p.parcelasComprometidas) +
             "</b> em parcelas comprometidas nos próximos meses.");
    }
    return l.map(linha).join("");
  }

  if (n === 5) {
    const l = [];
    l.push(p.carenciaVencida
      ? "<b>Carência cumprida.</b> Você esperou e ainda está aqui."
      : "Faltam <b>" + p.diasFaltando + " dias</b> · vence em " + formatarDataBR(p.carenciaAte));
    if (p.melhorDia && p.melhorDia.dias > 0) {
      l.push("Comprando a partir de <b>" + formatarDataBR(p.melhorDia.aPartirDe) +
             "</b>, cai na fatura seguinte do " + p.melhorDia.cartao + ".");
    }
    return l.map(linha).join("");
  }

  if (n === 7) {
    const l = [p.respondidos + " de 7 tópicos completos."];
    if (p.custoPorUso) {
      l.push("Custo por uso: <b>" + formatarMoeda(p.custoPorUso) + "</b>" +
             (p.frequenciaRotulo
               ? " (" + p.usosPrevistos + " usos no 1º ano, pela frequência)"
               : ""));
    }
    if (p.menorPreco) l.push("Menor preço achado: <b>" + formatarMoeda(p.menorPreco) + "</b>");
    return l.map(linha).join("");
  }
  return "";
}

/**
 * As faixas de frequência, uma embaixo da outra.
 *
 * Não é um <select>: com cinco opções que precisam de uma explicação cada, a
 * lista fechada esconderia justamente o que faz escolher. E cada faixa mostra
 * quantos usos o app vai supor -- o número volta para a tela como ESTIMATIVA
 * declarada, em vez de virar uma conta escondida atrás de um rótulo.
 *
 * O valor fica num campo escondido porque o resto do formulário lê tudo por
 * getElementById("resp-" + codigo), e uma exceção aqui vazaria para o salvar.
 */
function campoFrequencia(codigo, valor) {
  if (!planoFrequencias.length) {
    return '<input type="number" step="1" inputmode="numeric" id="resp-' + codigo +
           '" value="' + escaparHtml(valor) + '" onclick="event.stopPropagation()" />';
  }

  return '<input type="hidden" id="resp-' + codigo + '" value="' + escaparHtml(valor) + '" />' +
    '<div class="freq-opcoes" id="freq-' + codigo + '" data-c="' + codigo + '">' +
      planoFrequencias.map(function (f) {
        return '<button type="button" class="freq-opcao' + (f.v === valor ? " ativa" : "") +
            '" data-v="' + f.v + '" onclick="event.stopPropagation(); ' +
            'escolherFrequencia(this)">' +
            '<span class="freq-rot">' + escaparHtml(f.r) + '</span>' +
            '<span class="freq-det">' + escaparHtml(f.d) + '</span>' +
            '<span class="freq-usos">≈ ' + f.usos + '/ano</span>' +
          '</button>';
      }).join("") +
    '</div>';
}

function escolherFrequencia(botao) {
  const caixa = botao.parentNode;
  const valor = botao.getAttribute("data-v");

  const campo = document.getElementById("resp-" + caixa.getAttribute("data-c"));
  if (campo) campo.value = valor;

  caixa.querySelectorAll(".freq-opcao").forEach(function (x) {
    x.classList.toggle("ativa", x === botao);
  });
}

function alternarTopico(n) {
  topicoAberto = (topicoAberto === n) ? null : n;
  pintarFicha();
}

async function salvarTopico(n) {
  if (!planoAberto) return;
  const conjunto = (planoAberto.tipo === "presente") ? planoPerguntasPresente : planoPerguntas;
  const perguntas = conjunto[String(n)] || [];

  perguntas.forEach(function (q) {
    const el = document.getElementById("resp-" + q.c);
    if (el) planoAberto.respostas[q.c] = el.value.trim();
  });

  // O tópico 3 alimenta as colunas de custo e de usos, que são o que o
  // servidor usa para calcular o custo por uso.
  const extras = { id: planoAberto.id, respostas: JSON.stringify(planoAberto.respostas) };
  if (n === 3) {
    extras.custosExtras = planoAberto.respostas["3a"] || 0;
    extras.usosPrevistos = planoAberto.respostas["3b"] || 0;
  }

  try {
    const r = await chamarServidor("salvarPlano", extras);
    if (!r.ok) { mostrarToast("⚠ " + r.mensagem); return; }

    mostrarToast("✅ Salvo.");
    topicoAberto = null;

    // Recarrega para o veredito levar as respostas novas em conta.
    const idAtual = planoAberto.id;
    await carregarPlanos();
    const atual = planosCarregados.filter(function (x) { return x.id === idAtual; })[0];
    if (atual) { planoAberto = atual; pintarFicha(); }

  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

function pintarAcoesDoPlano() {
  const p = planoAberto;
  document.getElementById("pl-acoes").innerHTML =
    '<button class="btn-modal cancelar" style="flex:1;" onclick="decidir(&quot;reprovar&quot;)">Desisti</button>' +
    '<button class="btn-modal cancelar" style="flex:1;" onclick="decidir(&quot;adiar&quot;)">+30 dias</button>' +
    '<button class="btn-modal confirmar" style="flex:1;" onclick="abrirComprar()">' +
      (p.veredito.situacao === "pronto" ? "Compra feita" : "Comprei mesmo assim") + '</button>' +
    '<button class="cd-excluir" style="width:100%; margin-top:6px;" ' +
      'onclick="excluirPlanoApp()">Apagar este plano</button>';
}

/**
 * Apaga de vez, incluindo do cofre.
 *
 * Existe porque "desisti" soma no cofre, e um teste ou um engano viram número
 * falso lá dentro -- e o cofre só vale enquanto for verdadeiro.
 */
async function excluirPlanoApp() {
  if (!planoAberto) return;
  if (!confirm("Apagar " + planoAberto.titulo + " e tudo dele? Não dá para desfazer.")) return;

  try {
    const r = await chamarServidor("excluirPlano", { id: planoAberto.id });
    if (!r.ok) { mostrarToast("⚠ " + r.mensagem); return; }

    fecharPlano();
    fecharCofre();
    mostrarToast("✅ " + r.mensagem);
    carregarPlanos();
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

async function decidir(decisao) {
  if (!planoAberto) return;

  // Comprar antes da carência vencer é permitido, mas não em silêncio: a
  // regra existe para ser vista no momento de quebrá-la.
  if (decisao === "aprovar" && !planoAberto.carenciaVencida) {
    if (!confirm("Ainda faltam " + planoAberto.diasFaltando +
                 " dias de carência. Comprar mesmo assim?")) return;
  }
  if (decisao === "reprovar") {
    if (!confirm("Desistir de " + planoAberto.titulo + "? O valor vai para o cofre.")) return;
  }

  try {
    const r = await chamarServidor("decidirPlano", {
      id: planoAberto.id, decisao: decisao, dias: 30
    });
    if (!r.ok) { mostrarToast("⚠ " + r.mensagem); return; }

    fecharPlano();
    mostrarToast("✅ " + r.mensagem);
    limparTodoCache();
    carregarPlanos();

  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

// --------------------------------------------------------- análise sincera
/**
 * O botão da análise, e a análise quando já existe.
 *
 * Fica travado enquanto faltar tópico. Não por limitação técnica: uma análise
 * feita pela metade vira palpite, e palpite com cara de conclusão é pior que
 * nenhuma análise. Responder tudo também é o ponto do fluxo -- liberar o
 * atalho antes tiraria o motivo de responder.
 */
function analiseHtml(p) {
  const completo = p.respondidos >= 7;
  let h = '<div class="analise-bloco" onclick="event.stopPropagation()">';

  if (!completo) {
    h += '<div class="analise-travada">' +
         '<b>Análise sincera da IA</b><br>' +
         'Disponível quando os 7 tópicos estiverem respondidos. Faltam ' +
         (7 - p.respondidos) + '.</div>';
    return h + '</div>';
  }

  h += '<div id="analise-texto"></div>' +
       '<button class="btn-modal confirmar" style="width:100%;" id="btn-analise" ' +
       'onclick="pedirAnalise(false, ' + (p.temAnalise ? "false" : "true") + ')">' +
       (p.temAnalise ? "🔍 Ver a análise da IA" : "🔍 Analisar com a IA") +
       '</button>';

  // Já existe análise: mostra sozinha, sem exigir um toque. Fechar a ficha
  // sem querer e ver o texto sumir dá a impressão de que ele se perdeu --
  // e ele não se perde, está guardado na planilha.
  if (p.temAnalise) {
    setTimeout(function () {
      if (topicoAberto === 7 && document.getElementById("analise-texto")) pedirAnalise(false);
    }, 40);
  }
  return h + '</div>';
}

/**
 * @param refazer   Gerar de novo em vez de ler a guardada.
 * @param aoFundo   Rodar sem segurar a tela. Vale para a análise NOVA, que
 *   demora de verdade; ler a guardada é instantâneo e sair da tela para
 *   esperar por ela seria pior que esperar.
 */
async function pedirAnalise(refazer, aoFundo) {
  if (!planoAberto) return;

  const btn = document.getElementById("btn-analise");
  const alvo = document.getElementById("analise-texto");

  if (aoFundo) {
    const id = planoAberto.id;
    const nome = planoAberto.titulo;

    fecharPlano();
    emSegundoPlano("Analisando " + nome + "...", function () {
      return chamarServidor("analisarPlanoComIA", { id: id, refazer: "1" });
    }, function (r) {
      if (!r) return;
      if (!r.ok) { mostrarToast("⚠ " + (r.mensagem || "Não consegui analisar.")); return; }

      // A ficha pode ter sido reaberta enquanto rodava -- ou outra pode estar
      // aberta no lugar. Só pinta se for a MESMA; pintar por cima de outro
      // plano poria a análise de um na ficha do outro.
      if (planoAberto && planoAberto.id === id && document.getElementById("analise-texto")) {
        planoAberto.temAnalise = true;
        document.getElementById("analise-texto").innerHTML = montarAnalise(r);
      } else {
        mostrarToast("✅ Análise de " + nome + " pronta.");
      }
      carregarPlanos();
    });
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "Analisando..."; }

  try {
    const r = await chamarServidor("analisarPlanoComIA", {
      id: planoAberto.id,
      refazer: refazer ? "1" : ""
    });

    if (!r.ok) {
      alvo.innerHTML = '<div class="analise-travada">⚠️ ' +
        escaparHtml(r.mensagem || "Não consegui analisar.") + '</div>';
      return;
    }

    planoAberto.temAnalise = true;
    alvo.innerHTML = montarAnalise(r);

  } catch (e) {
    alvo.innerHTML = '<div class="analise-travada">⚠️ Sem conexão.</div>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔄 Analisar de novo";
      btn.setAttribute("onclick", "pedirAnalise(true, true)");
    }
  }
}

/**
 * Separa o veredito do resto e o destaca.
 *
 * A IA termina com "VEREDITO: ESPERE ...". Esse é o pedaço que você vai ler
 * primeiro -- e provavelmente o único, se estiver com pressa.
 */
function montarAnalise(r) {
  const texto = (r.analise || "").toString().trim();
  const corte = texto.lastIndexOf("VEREDITO:");

  let corpo = texto, veredito = "";
  if (corte >= 0) {
    corpo = texto.slice(0, corte).trim();
    veredito = texto.slice(corte + 9).trim();
  }

  // A prioridade sai do corpo e vira selo. Deixada no texto, ela apareceria
  // como uma linha solta em CAIXA ALTA no fim de um parágrafo -- e é o
  // contrário de uma conclusão: é a etiqueta dela.
  const mp = corpo.match(/PRIORIDADE:\s*(ALTA|M[ÉE]DIA|BAIXA)\s*$/im);
  const prioridade = mp ? mp[1].toUpperCase().replace("E", "É") : "";
  if (mp) corpo = corpo.slice(0, mp.index).trim();

  // O card da lista precisa saber, senão o selo só apareceria na próxima vez
  // que a lista fosse buscada do servidor.
  if (planoAberto && prioridade) {
    planoAberto.prioridadeIA = prioridade.toLowerCase();
  }

  const cor = /não compre/i.test(veredito) ? "var(--vermelho)"
            : (/espere/i.test(veredito)    ? "var(--laranja)" : "var(--verde)");

  let h = "";
  if (prioridade) {
    h += '<div class="analise-prio"><span class="chip-prio ' +
         prioridade.toLowerCase().replace("é", "e") + '">prioridade ' +
         prioridade.toLowerCase() + '</span></div>';
  }
  h += '<div class="analise-texto">' + escaparHtml(corpo).replace(/\n/g, "<br>") + '</div>';

  if (veredito) {
    h += '<div class="analise-veredito" style="color:' + cor + '">' +
         escaparHtml(veredito) + '</div>';
  }
  if (r.quando) {
    h += '<div class="analise-quando">' +
         (r.doCache ? "análise de " + escaparHtml(r.quando) : "analisado agora") + '</div>';
  }
  return h;
}

// ------------------------------------------------------------- simulação
/**
 * Como ficam os próximos meses se a compra for parcelada.
 *
 * Mostra o que JÁ está comprometido em cada mês e o que a parcela nova
 * acrescenta. Um total solto ("R$ 890 em parcelas") não responde a pergunta
 * que importa, que é se ainda vai caber em março.
 */
function simuladorHtml(p) {
  // Sem data não tem mês de entrada: simular seis meses a partir de um prazo
  // que não existe seria desenhar um cenário inventado.
  if (p.semData) {
    return '<div class="simulador" onclick="event.stopPropagation()">' +
        '<div class="topico-auto">Esta compra está <b>sem data definida</b>, ' +
        'então não há mês para simular. Desmarque no tópico 5 para ver o estudo.</div>' +
      '</div>';
  }

  const sim = p.simulacao;
  let h = '<div class="simulador" onclick="event.stopPropagation()">' +
    '<div class="sim-linha1">' +
      '<label for="sim-parcelas">Parcelar em</label>' +
      '<input type="number" id="sim-parcelas" min="1" max="24" step="1" value="' +
        (p.parcelas || 1) + '" onchange="mudarParcelas()" />' +
      '<span>vez(es)</span>' +
    '</div>';

  if (!sim || !sim.meses || !sim.meses.length) return h + '</div>';

  // Em que mês você pretende comprar. Muda o estudo inteiro: a parcela entra
  // a partir dali, e a janela dos seis meses continua a mesma -- assim dá
  // para comparar uma escolha com a outra.
  h += '<div class="sim-linha1" style="margin-top:10px;">' +
      '<label for="sim-mes">Pretendo comprar em</label>' +
      '<select id="sim-mes" onchange="mudarMesPretendido()">' +
        sim.meses.map(function (m, i) {
          return '<option value="' + i + '"' +
                 (i === sim.entrada ? " selected" : "") + '>' + m.rotulo + '</option>';
        }).join("") +
      '</select>' +
    '</div>';

  h += '<div class="sim-valor">' + sim.parcelas + 'x de ' +
       formatarMoeda(sim.valorParcela) + '</div>';

  h += '<div class="sim-cabecalho">os próximos 6 meses, supondo a mesma receita de ' +
       formatarMoeda(sim.receita) + '</div>';

  // Cada mês é uma linha: o que já estava comprometido, a parcela nova e o
  // que sobra. A barra é da RECEITA, não do maior mês -- assim a altura de
  // cada barra quer dizer a mesma coisa em todas as linhas.
  const teto = Math.max(sim.receita, 1);

  sim.meses.forEach(function (m) {
    const pJa = Math.min(100, (m.jaComprometido / teto) * 100);
    const pNova = Math.min(100 - pJa, (m.novaParcela / teto) * 100);
    // Os outros planos entram DEPOIS desta compra na barra: assim o pedaço
    // verde encosta no que já está comprometido, e dá para ler o impacto
    // desta decisão sem a fila da frente empurrando ele para o lado.
    const pOutros = Math.min(100 - pJa - pNova, ((m.outrosPlanos || 0) / teto) * 100);
    const corSobra = !m.cabe ? "var(--vermelho)"
                    : (m.apertado ? "var(--laranja)" : "var(--verde)");

    h += '<div class="sim-mes">' +
        '<span class="sim-rot">' + m.rotulo + '</span>' +
        '<span class="sim-barra">' +
          '<span class="sim-ja" style="width:' + pJa + '%"></span>' +
          (pNova > 0 ? '<span class="sim-nova' + (m.cabe ? "" : " estoura") +
            '" style="width:' + pNova + '%"></span>' : '') +
          (pOutros > 0 ? '<span class="sim-outros" title="outros planos em aberto"' +
            ' style="width:' + pOutros + '%"></span>' : '') +
        '</span>' +
        '<span class="sim-num" style="color:' + corSobra + '">' +
          (m.sobra < 0 ? "-" : "") + formatarMoeda(Math.abs(m.sobra)) + '</span>' +
      '</div>';
  });

  h += '<div class="sim-legenda">' +
      '<span><i class="sim-ponto sim-ponto-ja"></i>já comprometido</span>' +
      '<span><i class="sim-ponto sim-ponto-nova"></i>esta compra</span>' +
      (sim.outrosPlanosQtd > 0
        ? '<span><i class="sim-ponto sim-ponto-outros"></i>outros ' +
          sim.outrosPlanosQtd + ' plano' + (sim.outrosPlanosQtd > 1 ? "s" : "") + '</span>'
        : '') +
      '<span class="sim-legenda-sobra">à direita: o que sobra</span>' +
    '</div>';

  // A fila inteira de planos, num aviso à parte.
  //
  // Fora do "o que sobra" de propósito: aquele número é o desta decisão, e
  // reprovar esta compra por causa de outra que talvez nem aconteça seria
  // decidir pelo que ainda é vontade. Mas ignorar a fila faria cada plano
  // parecer o único -- e a conta só fecha se todos forem somados uma vez.
  // Quando a fila não muda o mês mais apertado nem a folga, o aviso repetiria
  // com outras palavras a frase que vem logo abaixo.
  const filaMuda = sim.piorMesComOutros !== sim.piorMes ||
                   Math.abs((sim.piorSobraComOutros || 0) - (sim.piorSobra || 0)) > 0.01;

  if (sim.outrosPlanosQtd > 0 && sim.outrosPlanosTotal > 0 && filaMuda) {
    h += '<div class="sim-outros-aviso' +
        (sim.piorSobraComOutros < 0 ? " estoura" : "") + '">' +
      'Com os outros ' + sim.outrosPlanosQtd + ' plano' +
      (sim.outrosPlanosQtd > 1 ? "s" : "") + ' em aberto, o mês mais apertado ' +
      'seria ' + sim.piorMesComOutros +
      (sim.piorSobraComOutros < 0
        ? ', faltando ' + formatarMoeda(Math.abs(sim.piorSobraComOutros)) + '.'
        : ', com ' + formatarMoeda(sim.piorSobraComOutros) + ' de folga.') +
    '</div>';
  }

  // O pior mês é a conclusão do estudo. Sem ele, seis linhas de número pedem
  // que você faça a comparação de cabeça.
  if (sim.mesesApertados > 0) {
    h += '<div class="sim-aviso">' +
      (sim.piorSobra < 0
        ? "Em " + sim.piorMes + " você fecharia no vermelho: faltariam " +
          formatarMoeda(Math.abs(sim.piorSobra)) + "."
        : "O mês mais apertado é " + sim.piorMes + ", com " +
          formatarMoeda(sim.piorSobra) + " de folga.") +
      '</div>';
  } else {
    h += '<div class="sim-ok">Os seis meses cabem, e o mais apertado ainda deixa ' +
         formatarMoeda(sim.piorSobra) + '.</div>';
  }

  return h + '</div>';
}

/**
 * "Sem data definida": o desejo anotado que não entra em projeção nenhuma.
 *
 * Fica no tópico da carência porque é ali que se fala de prazo -- e marcar
 * isto é justamente dizer "não tenho prazo".
 */
function semDataHtml(p) {
  return '<div class="sem-data" onclick="event.stopPropagation()">' +
      '<label class="sem-data-linha">' +
        '<input type="checkbox" id="pl-sem-data"' + (p.semData ? " checked" : "") +
          ' onchange="mudarSemData()" />' +
        '<span>Sem data definida</span>' +
      '</label>' +
      '<div class="sem-data-nota">' +
        (p.semData
          ? "Não entra na projeção nem na previsão. Fica guardado para quando você quiser."
          : "Marque para tirar esta compra das projeções: ela continua aqui, mas para de pesar nos meses à frente.") +
      '</div>' +
    '</div>';
}

async function mudarSemData() {
  const c = document.getElementById("pl-sem-data");
  if (!c || !planoAberto) return;
  await salvarNoPlano({ semData: c.checked ? "1" : "0" }, 5);
}

async function mudarMesPretendido() {
  const campo = document.getElementById("sim-mes");
  if (!campo || !planoAberto) return;
  await salvarNoPlano({ mesPretendido: campo.value }, 2);
}

async function mudarParcelas() {
  const campo = document.getElementById("sim-parcelas");
  if (!campo || !planoAberto) return;

  const n = Math.max(1, Math.min(24, parseInt(campo.value) || 1));
  await salvarNoPlano({ parcelas: n }, 2);
}

/**
 * Salva um campo do plano e redesenha a ficha com o tópico certo aberto.
 *
 * Recarregar a lista inteira é o que garante que os números do estudo venham
 * recalculados pelo servidor; refazer a conta no app seria ter a mesma regra
 * em dois lugares.
 */
async function salvarNoPlano(campos, manterTopicoAberto) {
  try {
    const r = await chamarServidor("salvarPlano",
      Object.assign({ id: planoAberto.id }, campos));
    if (!r.ok) { mostrarToast("⚠ " + r.mensagem); return; }

    const idAtual = planoAberto.id;
    await carregarPlanos();
    const atual = planosCarregados.filter(function (x) { return x.id === idAtual; })[0];
    if (atual) {
      planoAberto = atual;
      topicoAberto = manterTopicoAberto;
      pintarFicha();
    }
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

// ------------------------------------------------------------ compra feita
/**
 * Vira lançamento, com os dados do plano já preenchidos.
 *
 * Confirma antes de gravar: o plano sabe o quê e quanto, mas não sabe em qual
 * cartão você passou nem em que categoria isso entra -- e adivinhar essas
 * duas seria lançar errado com cara de certo.
 */
function abrirComprar() {
  if (!planoAberto) return;
  const p = planoAberto;

  document.getElementById("modal-comprar").style.display = "flex";
  document.getElementById("cp-descricao").value = p.titulo;

  // O menor preço achado vale mais que o valor do plano: é o preço de hoje,
  // não o do dia em que a vontade apareceu.
  document.getElementById("cp-valor").value =
    Number(p.menorPreco || p.valor).toFixed(2);

  document.getElementById("cp-parcelas").value = p.parcelas || 1;
  document.getElementById("cp-data").value = dataHojeISO();
  document.getElementById("cp-pago").checked = false;
  document.getElementById("cp-aviso").style.display = "none";

  const sel = document.getElementById("cp-metodo");
  const metodos = (listasValidas && listasValidas.metodos) || [];
  sel.innerHTML = '<option value="">escolha...</option>' + metodos.map(function (m) {
    return '<option value="' + escaparHtml(m) + '">' + escaparHtml(m) + '</option>';
  }).join("");

  document.getElementById("cp-categoria").value = "";
}

function fecharComprar() {
  document.getElementById("modal-comprar").style.display = "none";
}

async function confirmarCompraDoPlano() {
  if (!planoAberto) return;

  const dados = {
    id: planoAberto.id,
    decisao: "aprovar",
    valorFinal: document.getElementById("cp-valor").value,
    totalParcelas: document.getElementById("cp-parcelas").value || 1,
    metodo: document.getElementById("cp-metodo").value,
    categoria: document.getElementById("cp-categoria").value.trim(),
    dataCompra: document.getElementById("cp-data").value,
    jaPago: document.getElementById("cp-pago").checked ? "true" : "false"
  };
  if (dados.jaPago === "true") dados.dataPagamento = dados.dataCompra;

  const aviso = document.getElementById("cp-aviso");
  if (!dados.metodo)    { aviso.textContent = "Escolha o método."; aviso.style.display = "block"; return; }
  if (!dados.categoria) { aviso.textContent = "Escolha a categoria."; aviso.style.display = "block"; return; }
  if (!(parseFloat(dados.valorFinal) > 0)) {
    aviso.textContent = "Informe o valor pago."; aviso.style.display = "block"; return;
  }

  // Comprar antes da carência vencer é permitido, mas não em silêncio.
  if (!planoAberto.carenciaVencida &&
      !confirm("Ainda faltam " + planoAberto.diasFaltando +
               " dias de carência. Lançar mesmo assim?")) return;

  const btn = document.getElementById("cp-btn");
  btn.disabled = true;
  btn.textContent = "Lançando...";

  try {
    const r = await chamarServidor("decidirPlano", dados);
    if (!r.ok) { aviso.textContent = "⚠️ " + r.mensagem; aviso.style.display = "block"; return; }

    fecharComprar();
    fecharPlano();
    mostrarToast("✅ " + r.mensagem);
    limparTodoCache();
    carregarPlanos();

  } catch (e) {
    aviso.textContent = "⚠️ Sem conexão.";
    aviso.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Lançar";
  }
}

// --------------------------------------------------------- sigilo e revisão
/**
 * Avisa quando o presente NÃO vai ficar escondido.
 *
 * Sem o e-mail da pessoa configurado, o presente aparece na lista dela como
 * qualquer outro plano. Dizer isso é o mínimo: prometer sigilo e não entregar
 * é pior que não ter a funcionalidade.
 */
function avisarSigilo() {
  const tipo = document.getElementById("np-tipo").value;
  const el = document.getElementById("np-sigilo");

  if (tipo !== "presente") { el.style.display = "none"; return; }

  el.textContent = planoSigiloConfigurado
    ? "Some da lista de quem vai ganhar, se a conta dela estiver configurada."
    : "⚠️ Os e-mails ainda não foram configurados, então o presente VAI aparecer " +
      "para quem vai ganhar. Me peça para configurar.";
  el.style.display = "block";
}

/**
 * O custo por uso, três meses depois.
 *
 * "Você previu R$ 4,27 por uso" vira "está em R$ 40". É isso que ensina sobre
 * a PRÓXIMA compra -- o tópico respondido antes dela não ensina nada sozinho.
 */
function pintarRevisoes(revisoes) {
  const alvo = document.getElementById("planos-revisoes");
  if (!alvo) return;

  if (!revisoes.length) { alvo.innerHTML = ""; return; }

  alvo.innerHTML = revisoes.map(function (r) {
    return '<div class="revisao-card">' +
        '<div style="font-size:12px; font-weight:600;">' + escaparHtml(r.titulo) + '</div>' +
        '<div style="font-size:11px; color:var(--cinza-texto); margin-top:3px; line-height:1.5;">' +
          'comprado há ' + r.diasDesde + ' dias · você previu ' + r.usosPrevistos +
          ' usos (' + formatarMoeda(r.custoPrevisto) + ' cada)</div>' +
        '<div style="display:flex; gap:7px; align-items:center; margin-top:9px;">' +
          '<input type="number" id="uso-' + r.id + '" min="0" step="1" placeholder="usei" ' +
            'style="flex:1;" />' +
          '<button class="btn-modal confirmar" style="flex:0 0 auto;" onclick="salvarUsoReal(' +
            JSON.stringify(r.id).replace(/"/g, "&quot;") + ')">Responder</button>' +
        '</div>' +
      '</div>';
  }).join("");
}

async function salvarUsoReal(id) {
  const campo = document.getElementById("uso-" + id);
  if (!campo || campo.value === "") { mostrarToast("⚠ Diga quantas vezes usou."); return; }

  try {
    const r = await chamarServidor("registrarUsoReal", { id: id, usosReais: campo.value });
    if (!r.ok) { mostrarToast("⚠ " + r.mensagem); return; }

    mostrarToast("✅ " + r.mensagem);
    carregarPlanos();
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

// -------------------------------------------------------------------- links
function abrirLinks() {
  if (!planoAberto) return;
  document.getElementById("modal-links").style.display = "flex";
  document.getElementById("lk-url").value = "";
  document.getElementById("lk-preco").value = "";
  document.getElementById("lk-aviso").style.display = "none";
  pintarLinks();
}

function fecharLinks() {
  document.getElementById("modal-links").style.display = "none";
}

function pintarLinks() {
  const links = (planoAberto && planoAberto.links) || [];
  const alvo = document.getElementById("lk-lista");

  if (!links.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum link ainda. Cole o primeiro abaixo.</p>';
    return;
  }

  const menor = links.reduce(function (m, k) {
    const p = Number(k.preco) || 0;
    return (p > 0 && (m === 0 || p < m)) ? p : m;
  }, 0);

  alvo.innerHTML = links.map(function (k) {
    const preco = Number(k.preco) || 0;
    const ehMenor = preco > 0 && preco === menor && links.length > 1;

    // O histórico é o que faz a carência trabalhar a favor: em 30 dias o
    // preço muda, e sem registro ninguém lembra de quanto era.
    let variacao = "";
    if (k.precos && k.precos.length > 1) {
      const primeiro = Number(k.precos[0].preco) || 0;
      const dif = preco - primeiro;
      if (dif !== 0 && primeiro > 0) {
        variacao = (dif < 0 ? "caiu " : "subiu ") + formatarMoeda(Math.abs(dif)) +
                   " desde " + formatarDataBR(k.precos[0].data);
      }
    }

    return '<div class="link-item' + (ehMenor ? " menor" : "") + '">' +
        '<div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;">' +
          '<span class="link-loja">' + escaparHtml(k.loja || "loja") +
            (ehMenor ? ' <span style="color:var(--verde)">· menor</span>' : '') + '</span>' +
          '<span class="link-preco" style="color:' + (ehMenor ? "var(--verde)" : "var(--texto)") + '">' +
            (preco ? formatarMoeda(preco) : "—") + '</span>' +
        '</div>' +
        (k.produto ? '<div style="font-size:10.5px; color:var(--cinza-texto); margin-top:3px; line-height:1.4;">' +
          escaparHtml(k.produto.slice(0, 60)) + '</div>' : '') +
        (variacao ? '<div style="font-size:10.5px; font-weight:600; margin-top:5px; color:' +
          (variacao.indexOf("caiu") === 0 ? "var(--verde)" : "var(--vermelho)") +
          '">' + variacao + '</div>' : '') +
        '<div class="link-acoes">' +
          '<span style="color:var(--azul-claro)" onclick="abrirLinkExterno(' +
            JSON.stringify(k.url).replace(/"/g, "&quot;") + ')">abrir a loja</span>' +
          '<span style="color:var(--cinza-texto)" onclick="atualizarPrecoLink(' +
            JSON.stringify(k.url).replace(/"/g, "&quot;") + ')">rever preço</span>' +
        '</div>' +
      '</div>';
  }).join("");
}

function abrirLinkExterno(url) {
  try {
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (B && B.open) { B.open({ url: url }); return; }
  } catch (e) {}
  window.open(url, "_blank");
}

async function adicionarLink() {
  const url = document.getElementById("lk-url").value.trim();
  const preco = document.getElementById("lk-preco").value;
  const aviso = document.getElementById("lk-aviso");
  const btn = document.getElementById("lk-btn-add");

  if (!url) { aviso.textContent = "Cole o link."; aviso.style.display = "block"; return; }

  btn.disabled = true;
  btn.textContent = "Lendo...";
  aviso.style.display = "none";

  let dados = { url: url, preco: preco, loja: "", produto: "" };

  try {
    // Tenta ler; se a loja bloquear, guarda o que der. O link vale mesmo sem
    // preço: é o caminho de volta para a loja daqui a 30 dias.
    const r = await chamarServidor("analisarLinkProduto", { url: url });
    if (r.produto) dados.produto = r.produto;
    if (r.loja) dados.loja = r.loja;
    if (r.ok && r.preco && !preco) dados.preco = r.preco;

    if (!r.ok && !preco) {
      aviso.textContent = "⚠️ " + (r.mensagem || "Não li o preço.") + " Guardei sem preço.";
      aviso.style.display = "block";
    }
  } catch (e) {
    aviso.textContent = "⚠️ Sem conexão para ler. Guardando assim mesmo.";
    aviso.style.display = "block";
  }

  try {
    const g = await chamarServidor("adicionarLinkAoPlano", Object.assign({ id: planoAberto.id }, dados));
    if (!g.ok) { aviso.textContent = "⚠️ " + g.mensagem; aviso.style.display = "block"; return; }

    planoAberto.links = g.links || [];
    document.getElementById("lk-url").value = "";
    document.getElementById("lk-preco").value = "";
    pintarLinks();
    mostrarToast("✅ " + g.mensagem);

  } catch (e) {
    aviso.textContent = "⚠️ Sem conexão.";
    aviso.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Adicionar";
  }
}

/** Relê a página e acrescenta o preço de hoje ao histórico daquele link. */
async function atualizarPrecoLink(url) {
  mostrarToast("⏳ Relendo...", true);
  try {
    const r = await chamarServidor("analisarLinkProduto", { url: url });
    if (!r.ok || !r.preco) {
      mostrarToast("⚠ " + (r.mensagem || "Não consegui reler."));
      return;
    }
    const g = await chamarServidor("adicionarLinkAoPlano", {
      id: planoAberto.id, url: url, preco: r.preco, loja: r.loja, produto: r.produto
    });
    if (g.ok) {
      planoAberto.links = g.links || [];
      pintarLinks();
      mostrarToast("✅ " + formatarMoeda(r.preco));
    }
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

// -------------------------------------------------------------------- cofre
async function abrirCofre() {
  document.getElementById("modal-cofre").style.display = "flex";
  const alvo = document.getElementById("cf-lista");
  alvo.innerHTML = '<p class="vazio">Carregando...</p>';

  try {
    const r = await lerCacheado("listarReprovados");
    if (!r.ok || !r.itens.length) {
      alvo.innerHTML = '<p class="vazio">Nada aqui ainda.</p>';
      return;
    }
    alvo.innerHTML = r.itens.map(function (i) {
      return '<div class="link-item">' +
          '<div style="display:flex; justify-content:space-between; align-items:baseline;">' +
            '<span style="font-size:12px; font-weight:600;">' + escaparHtml(i.titulo) + '</span>' +
            '<span style="font-size:14px;">' + formatarMoeda(i.valor) + '</span>' +
          '</div>' +
          '<div style="font-size:10px; color:var(--cinza-texto); margin-top:3px;">' +
            escaparHtml(i.pessoa) + (i.quando ? " · " + formatarDataBR(i.quando) : "") +
            (i.motivo ? " · " + escaparHtml(i.motivo) : "") + '</div>' +
          '<span style="font-size:11px; color:#b91c1c; display:inline-block; margin-top:6px;" ' +
            'onclick="apagarDoCofre(' + JSON.stringify(i.id).replace(/"/g, "&quot;") + ', ' +
            JSON.stringify(i.titulo).replace(/"/g, "&quot;") + ')">apagar de vez</span>' +
        '</div>';
    }).join("");
  } catch (e) {
    alvo.innerHTML = '<p class="vazio">⚠️ Sem conexão.</p>';
  }
}

function fecharCofre() {
  const m = document.getElementById("modal-cofre");
  if (m) m.style.display = "none";
}

async function apagarDoCofre(id, titulo) {
  if (!confirm("Apagar " + titulo + " do cofre? O valor sai da conta.")) return;
  try {
    const r = await chamarServidor("excluirPlano", { id: id });
    if (!r.ok) { mostrarToast("⚠ " + r.mensagem); return; }
    mostrarToast("✅ " + r.mensagem);
    abrirCofre();
    carregarPlanos();
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

/**
 * Quem cumpriu a carência ganha um empurrão ao abrir a tela.
 *
 * Sem isto, um plano pronto ficaria parado esperando você lembrar dele -- e
 * lembrar é justamente o que a carência de 30 dias atrapalha.
 */
function marcarCarenciasVencidas() {
  const prontos = planosCarregados.filter(function (p) {
    return p.carenciaVencida && p.veredito.situacao !== "nao-cabe";
  });
  if (!prontos.length) return;

  setTimeout(function () {
    mostrarToast("⏰ " + prontos.length + " plano(s) cumpriram a carência.");
  }, 900);
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

// ---------- Sugestões de lembrete pela IA ----------
// Ela sugere; você escolhe. Nada vira compromisso sozinho: agenda que se
// enche de lembrete não pedido é agenda que ninguém lê.
let sugestoesLembrete = [];

async function sugerirLembretesApp() {
  const alvo = document.getElementById("cal-sugestoes");
  alvo.innerHTML = '<div class="cfg-aviso">✨ Analisando suas contas...</div>';

  try {
    const r = await chamarServidor("sugerirLembretes");

    if (!r.ok) { alvo.innerHTML = '<div class="cfg-aviso">' + escaparHtml(r.mensagem || "Não deu.") + '</div>'; return; }

    sugestoesLembrete = r.sugestoes || [];
    if (sugestoesLembrete.length === 0) {
      alvo.innerHTML = '<div class="cfg-aviso">' + escaparHtml(r.mensagem || "Nenhuma sugestão por agora.") + '</div>';
      return;
    }

    let html = '<div class="cfg-aviso">Toque para criar o lembrete:</div>';
    sugestoesLembrete.forEach(function (s, i) {
      const p = (s.data || "").split("-");
      const dataBr = p.length === 3 ? p[2] + "/" + p[1] : s.data;

      html +=
        '<button type="button" class="sug-item" onclick="criarLembreteSugerido(' + i + ')">' +
          '<span class="sug-info">' +
            '<b>✨ ' + escaparHtml(s.titulo) + '</b>' +
            '<span class="sug-sub">' + dataBr + (s.hora ? " às " + escaparHtml(s.hora) : "") +
            (s.motivo ? " · " + escaparHtml(s.motivo) : "") + '</span>' +
          '</span>' +
          '<span class="sug-valor">criar</span>' +
        '</button>';
    });

    alvo.innerHTML = html;
  } catch (e) {
    alvo.innerHTML = '<div class="cfg-aviso">Sem conexão.</div>';
  }
}

async function criarLembreteSugerido(indice) {
  const s = sugestoesLembrete[indice];
  if (!s) return;

  try {
    const r = await chamarServidor("salvarCompromisso", {
      titulo: s.titulo,
      data: s.data,
      hora: s.hora || "09:00",
      local: "",
      lembrete: "60"
    });

    if (r.ok) {
      mostrarToast("✅ Lembrete criado: " + s.titulo);
      sugestoesLembrete.splice(indice, 1);
      document.getElementById("cal-sugestoes").innerHTML = "";
      await carregarCalendario();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não foi possível criar."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
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
  document.getElementById("cp-livre").value = "";
  document.getElementById("cp-aviso-ia").textContent = "Confira os campos depois: a IA às vezes erra a data.";

  document.getElementById("cp-titulo-modal").textContent = existente ? "📅 Editar compromisso" : "📅 Novo compromisso";
  document.getElementById("cp-btn-excluir").style.display = existente ? "block" : "none";
}

// Manda o texto para a IA e PREENCHE os campos — não salva. O que ela devolve
// é rascunho: data é justamente o que ela mais erra, e um compromisso salvo no
// dia errado incomoda mais do que um campo vazio.
async function interpretarCompromissoApp() {
  const campo = document.getElementById("cp-livre");
  const btn = document.getElementById("cp-btn-ia");
  const aviso = document.getElementById("cp-aviso-ia");

  const texto = campo.value.trim();
  if (!texto) { aviso.textContent = "Escreva o compromisso primeiro."; return; }

  btn.disabled = true;
  btn.textContent = "Entendendo...";

  try {
    const r = await chamarServidor("interpretarCompromisso", { texto: texto });

    if (r.ok) {
      if (r.titulo) document.getElementById("cp-nome").value = r.titulo;
      if (r.data) document.getElementById("cp-data").value = r.data;
      if (r.hora) document.getElementById("cp-hora").value = r.hora;
      if (r.local) document.getElementById("cp-local").value = r.local;

      campo.value = "";
      aviso.textContent = "Preenchido. Confira a data antes de salvar.";
    } else {
      aviso.textContent = r.mensagem || "Não consegui entender.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Preencher com IA";
  }
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
// SMARTTRABALHO
// ----------------------------------------------------------------------------
// Fechamento mensal de condomínios, em duas frentes: contas a pagar de um
// lado, balancete do outro. Em tela larga as duas aparecem lado a lado; no
// celular só a escolhida, pelo segmented control.
//
// Os dados são separados por e-mail no servidor: o que aparece aqui é sempre
// só de quem está logado.
// ============================================================================
let trabComp = "";              // "aaaa-mm"
let trabFrente = "contas";
let trabDados = null;

function competenciaDeHoje() {
  // A competência trabalhada é a do mês PASSADO: em agosto se fecha julho.
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2);
}

function competenciaPorExtenso(comp) {
  const p = (comp || "").split("-");
  if (p.length !== 2) return comp;
  return MESES_NOMES[parseInt(p[1]) - 1] + " de " + p[0];
}

function mudarCompetencia(passo) {
  const p = trabComp.split("-");
  const d = new Date(parseInt(p[0]), parseInt(p[1]) - 1 + passo, 1);
  trabComp = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2);
  carregarTrabalho();
}

function trocarFrente(qual) {
  trabFrente = qual;
  document.getElementById("trab-frente-contas").classList.toggle("ativo", qual === "contas");
  document.getElementById("trab-frente-balancete").classList.toggle("ativo", qual === "balancete");
  aplicarFrenteVisivel();
}

// Girar o celular ou redimensionar a janela muda de qual lado o CSS manda:
// sem reavaliar, as duas colunas ficam visíveis onde só cabe uma.
window.addEventListener("resize", function () {
  if (abaAtiva === "trabalho") aplicarFrenteVisivel();
});

// Em telas largas o CSS manda (as duas colunas aparecem). Aqui só se resolve
// o caso do celular, onde uma some.
function aplicarFrenteVisivel() {
  const largo = window.matchMedia("(min-width: 900px)").matches;
  document.getElementById("trab-coluna-contas").style.display =
    (largo || trabFrente === "contas") ? "block" : "none";
  document.getElementById("trab-coluna-balancete").style.display =
    (largo || trabFrente === "balancete") ? "block" : "none";
}

async function abrirTrabalho() {
  trocarAba("trabalho");
  if (!trabComp) trabComp = competenciaDeHoje();
  await carregarTrabalho();
}

async function carregarTrabalho() {
  document.getElementById("trab-competencia").textContent = competenciaPorExtenso(trabComp);
  document.getElementById("trab-lista-contas").innerHTML = '<p class="vazio">Carregando...</p>';
  document.getElementById("trab-lista-balancete").innerHTML = "";

  try {
    const r = await lerCacheado("trabalhoPainel", { competencia: trabComp });
    if (!r.ok) {
      trabDados = null;
      document.getElementById("trab-lista-contas").innerHTML =
        '<p class="vazio">' + escaparHtml(r.mensagem || "Não consegui carregar.") + '</p>';
      return;
    }
    trabDados = r;
  } catch (e) {
    trabDados = null;
    document.getElementById("trab-lista-contas").innerHTML = '<p class="vazio">Sem conexão.</p>';
    return;
  }

  renderizarTrabalho();
  aplicarFrenteVisivel();
}

function renderizarTrabalho() {
  const d = trabDados;
  if (!d) return;

  // Sem condomínio nenhum: oferece semear, para dar o que ver na primeira vez.
  if (!d.condominios.length) {
    const vazio =
      '<p class="vazio">Nenhum condomínio cadastrado.</p>' +
      '<div class="trab-acoes-card">' +
        '<button onclick="abrirCondominio()">+ Cadastrar um</button>' +
        '<button onclick="semearCondominios()">Cadastrar minha carteira</button>' +
      '</div>';
    document.getElementById("trab-lista-contas").innerHTML = vazio;
    document.getElementById("trab-lista-balancete").innerHTML = "";
    document.getElementById("trab-resumo").innerHTML = "";
    renderizarConselho();
    renderizarMemoria();
    return;
  }

  // Competência ainda não aberta
  if (!d.itens.length) {
    const vazio =
      '<p class="vazio">Nada aberto em ' + escaparHtml(competenciaPorExtenso(trabComp)) + '.</p>' +
      '<div class="trab-acoes-card">' +
        '<button onclick="gerarProcessos()">Abrir esta competência</button>' +
      '</div>';
    document.getElementById("trab-lista-contas").innerHTML = vazio;
    document.getElementById("trab-lista-balancete").innerHTML = "";
  } else {
    // Cada condomínio aparece só na(s) frente(s) dele. Home Boutique, que faz
    // as duas coisas, é o único que aparece nas duas colunas.
    ["contas", "balancete"].forEach(function (frente) {
      const meus = d.itens.filter(function (it) {
        return it.frentes === frente || it.frentes === "ambas";
      });
      document.getElementById("trab-lista-" + frente).innerHTML = meus.length
        ? meus.map(function (it) { return cardCondominio(it, frente); }).join("")
        : '<p class="vazio">Nenhum condomínio nesta frente.</p>';
    });
  }

  renderizarPlacar();
  renderizarPrecisaAtencao();
  renderizarConselho();
  renderizarMemoria();
}

// O que responde "como estou?" antes de rolar a tela. Números, não listas:
// com 20 condomínios, a lista só faz sentido depois de saber onde olhar.
function renderizarPlacar() {
  const d = trabDados;
  const el = document.getElementById("trab-placar");
  if (!d || !d.itens.length) { el.innerHTML = ""; return; }

  const prontos = d.itens.filter(function (i) { return i.total > 0 && i.feitas === i.total; }).length;
  const atrasados = d.itens.filter(function (i) {
    return i.prazo && (i.prazo.nivel === "estourado" || i.prazo.nivel === "critico");
  }).length;
  const comDoc = d.itens.filter(function (i) { return !!i.situacao; }).length;

  // Quantas etapas faltam no total: mede o tamanho do que resta, que "13 de
  // 20 condomínios" sozinho não mostra.
  let faltam = 0;
  d.itens.forEach(function (i) { faltam += (i.total - i.feitas); });

  function bloco(classe, num, rot) {
    return '<div class="placar-item ' + classe + '">' +
             '<div class="placar-num">' + num + '</div>' +
             '<div class="placar-rot">' + rot + '</div>' +
           '</div>';
  }

  el.innerHTML =
    bloco(prontos === d.itens.length ? "bom" : "neutro",
          prontos + " / " + d.itens.length, "Condomínios concluídos") +
    bloco(atrasados ? "alerta" : "bom", atrasados, "Com prazo apertado") +
    bloco(comDoc ? "atencao" : "bom", comDoc, "Com documentação pendente") +
    bloco("neutro", faltam, "Etapas a fazer") +
    bloco("neutro", formatarMoeda(d.totalRetido || 0), "Retido na competência");
}

// Na lateral, só quem precisa de você — o resto já está na lista principal.
function renderizarPrecisaAtencao() {
  const d = trabDados;
  const el = document.getElementById("trab-resumo");
  if (!d) { el.innerHTML = ""; return; }

  const urgentes = d.itens.filter(function (i) {
    return (i.prazo && (i.prazo.nivel === "estourado" || i.prazo.nivel === "critico")) || i.situacao;
  }).slice(0, 8);

  if (!urgentes.length) {
    el.innerHTML = '<p class="vazio">' +
      (d.itens.length ? "Nada apertado agora." : d.condominios.length + " cadastrado(s).") +
      '</p>';
    return;
  }

  el.innerHTML = urgentes.map(function (i) {
    const motivos = [];
    if (i.prazo && i.prazo.nivel === "estourado") motivos.push("entrega vencida em " + (i.prazo.entrega || ""));
    else if (i.prazo && i.prazo.nivel === "critico") motivos.push("entregar até " + (i.prazo.entrega || ""));
    if (i.situacao) motivos.push("documentação");

    return '<div class="trab-mem" style="cursor:pointer" onclick="abrirProcesso(\'' + i.idProcesso + '\')">' +
             '<div style="flex:1;">' +
               '<div style="font-size:12px;font-weight:600;">' + escaparHtml(i.nome) + '</div>' +
               '<div class="trab-mem-data">' + escaparHtml(motivos.join(" · ")) + '</div>' +
             '</div>' +
           '</div>';
  }).join("");
}

function cardCondominio(it, frente) {
  const etapas = trabDados.etapas.filter(function (e) { return e.frente === frente; });
  const feitasAqui = etapas.filter(function (e) { return !!it.etapas[e.chave]; }).length;
  const pct = etapas.length ? Math.round((feitasAqui / etapas.length) * 100) : 0;

  let selos = "";
  if (it.frentes === "ambas") selos += '<span class="trab-selo">2 FRENTES</span>';
  if (it.boleto) selos += '<span class="trab-selo boleto">BOLETO</span>';
  if (frente === "balancete" && it.situacao) {
    selos += '<span class="trab-selo doc">DOC. PENDENTE</span>';
  }
  if (it.prazo) {
    const n = it.prazo.nivel;
    // A data que importa é a de ENTREGA, não a do vencimento do boleto: a
    // entrega vem 10 dias antes, para o boleto ser emitido e chegar a tempo.
    let txt;
    if (n === "pronto") txt = "no prazo";
    else if (n === "estourado") txt = Math.abs(it.prazo.diasRestantes) + "d vencido";
    else txt = it.prazo.diasRestantes + "d · até " + (it.prazo.entrega || it.prazo.dia);
    selos += '<span class="trab-selo ' + n + '" title="' +
             (it.boleto ? "Boleto vence " + (it.prazo.vencimento || "") + "; entregar antes" : "Entrega") +
             '">' + txt + '</span>';
  }

  const linhas = etapas.map(function (e) {
    const data = it.etapas[e.chave] || "";
    return '<div class="trab-etapa' + (data ? " feita" : "") + '">' +
             '<span class="trab-etapa-nome">' + (data ? "✔ " : "○ ") + e.rotulo + '</span>' +
             '<input type="date" value="' + data + '" ' +
               'onchange="marcarEtapa(\'' + it.idProcesso + '\',\'' + e.chave + '\',this.value)" />' +
           '</div>';
  }).join("");

  // A pendência só faz sentido ao lado da conciliação, que é onde ela nasce.
  // A lista pode ter 20+ linhas, então vem recolhida: o card viraria uma
  // parede de texto e o próximo condomínio sumiria da tela.
  let pend = "";
  if (frente === "balancete" && it.pendencias) {
    const linhas = it.pendencias.split("\n");
    const resumo = linhas[0];
    const resto = linhas.slice(1).join("\n");
    pend = '<div class="trab-pendencia" onclick="this.classList.toggle(\'aberta\')">' +
             '<b>⚠ ' + escaparHtml(resumo) + '</b>' +
             (resto ? '<div class="trab-pendencia-itens">' + escaparHtml(resto) + '</div>' +
                      '<div class="trab-pendencia-mais">toque para ver os itens</div>' : '') +
           '</div>';
  }

  const impostos = (frente === "balancete" && it.totalRetido > 0)
    ? '<div class="trab-progresso-txt" style="margin-top:8px;">Retido: <b>' +
      formatarMoeda(it.totalRetido) + '</b></div>'
    : '';

  const detalhe = (frente === "balancete")
    ? '<div class="trab-acoes-card">' +
        '<button onclick="abrirProcesso(\'' + it.idProcesso + '\')">Impostos e notas</button>' +
      '</div>'
    : '';

  return '<div class="trab-card">' +
    '<div class="trab-card-topo">' +
      '<div class="trab-nome">' + escaparHtml(it.nome) + '</div>' + selos +
    '</div>' +
    '<div class="trab-barra"><div class="trab-barra-preenchida" style="width:' + pct + '%"></div></div>' +
    '<div class="trab-progresso-txt">' + feitasAqui + " de " + etapas.length + ' nesta frente</div>' +
    linhas + pend + impostos + detalhe +
  '</div>';
}

async function marcarEtapa(idProcesso, etapa, data) {
  try {
    const r = await chamarServidor("trabalhoMarcarEtapa", {
      idProcesso: idProcesso, etapa: etapa, data: data || ""
    });
    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      await carregarTrabalho();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não deu."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

async function gerarProcessos() {
  mostrarToast("Abrindo a competência...");
  try {
    const r = await chamarServidor("trabalhoGerarProcessos", { competencia: trabComp });
    mostrarToast((r.ok ? "✅ " : "❌ ") + r.mensagem);
    if (r.ok) await carregarTrabalho();
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

async function semearCondominios() {
  try {
    const r = await chamarServidor("trabalhoSemear", {});
    mostrarToast((r.ok ? "✅ " : "❌ ") + r.mensagem);
    if (r.ok) await carregarTrabalho();
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

// ---------- Conselho e conversa ----------
function renderizarConselho() {
  const el = document.getElementById("trab-conselho");
  const c = trabDados && trabDados.conselho;
  el.innerHTML = c
    ? escaparHtml(c.texto)
    : '<p class="vazio">Sem conselho hoje ainda. Toque em Atualizar.</p>';

  // Conselho longo nasce encolhido: o painel abaixo é o que você veio ver.
  // A escolha fica guardada, senão ele voltaria a crescer a cada recarga.
  const guardado = localStorage.getItem("trab_conselho_encolhido");
  const encolher = guardado === null
    ? (c && c.texto.length > 180)
    : guardado === "1";

  aplicarConselhoEncolhido(!!encolher);
}

function aplicarConselhoEncolhido(encolher) {
  document.getElementById("trab-conselho").classList.toggle("encolhido", encolher);
  document.getElementById("trab-btn-encolher").textContent = encolher ? "Expandir" : "Encolher";
}

function alternarConselho() {
  const agora = !document.getElementById("trab-conselho").classList.contains("encolhido");
  aplicarConselhoEncolhido(agora);
  localStorage.setItem("trab_conselho_encolhido", agora ? "1" : "0");
}

async function atualizarConselho() {
  const el = document.getElementById("trab-conselho");
  el.innerHTML = '<p class="vazio">Analisando...</p>';

  try {
    const r = await chamarServidor("trabalhoConselho", { competencia: trabComp, forcar: "true" });
    if (r.ok) {
      if (trabDados) trabDados.conselho = r.conselho;
      el.innerHTML = escaparHtml(r.conselho.texto);
      // Quem acabou de pedir um conselho quer lê-lo: abre inteiro, sem mexer
      // na preferência guardada.
      aplicarConselhoEncolhido(false);
    } else {
      el.innerHTML = '<p class="vazio">' + escaparHtml(r.mensagem || "Não consegui.") + '</p>';
    }
  } catch (e) {
    el.innerHTML = '<p class="vazio">Sem conexão.</p>';
  }
}

async function perguntarIA() {
  const campo = document.getElementById("trab-pergunta");
  const saida = document.getElementById("trab-resposta");
  const texto = campo.value.trim();
  if (!texto) return;

  const lembrar = document.getElementById("trab-lembrar").checked;
  saida.textContent = "Pensando...";

  try {
    const r = await chamarServidor("trabalhoPerguntar", {
      texto: texto, competencia: trabComp, lembrar: lembrar ? "true" : "false"
    });

    if (r.ok) {
      saida.textContent = r.resposta;
      campo.value = "";
      if (lembrar) {
        document.getElementById("trab-lembrar").checked = false;
        await carregarTrabalho();
      }
    } else {
      saida.textContent = r.mensagem || "Não consegui responder.";
    }
  } catch (e) {
    saida.textContent = "Sem conexão.";
  }
}

// ---------- Memória ----------
function renderizarMemoria() {
  const el = document.getElementById("trab-memoria");
  const lista = (trabDados && trabDados.memoria) || [];

  if (!lista.length) {
    el.innerHTML = '<p class="vazio">Nada pendente na memória dela.</p>';
    return;
  }

  // Regras primeiro: são as que valem sempre.
  const ordem = { regra: 0, lembrete: 1, nota: 2 };
  const ordenada = lista.slice().sort(function (a, b) {
    return (ordem[a.tipo] || 1) - (ordem[b.tipo] || 1);
  });

  el.innerHTML = ordenada.map(function (m) {
    const marca = m.tipo === "regra" ? "📌 " : (m.tipo === "nota" ? "" : "🔔 ");
    return '<div class="trab-mem">' +
             '<div class="tf-check" onclick="concluirMemoria(\'' + m.id + '\')"></div>' +
             '<div style="flex:1;">' + marca + escaparHtml(m.texto) +
               '<div class="trab-mem-data">' +
                 (m.tipo === "regra" ? "regra fixa" : escaparHtml(m.data)) +
               '</div>' +
             '</div>' +
           '</div>';
  }).join("");
}

async function anotarNaMemoria() {
  const texto = prompt("O que ela precisa lembrar?");
  if (!texto || !texto.trim()) return;

  try {
    const r = await chamarServidor("trabalhoAnotarMemoria", { texto: texto.trim() });
    mostrarToast((r.ok ? "✅ " : "❌ ") + r.mensagem);
    if (r.ok) await carregarTrabalho();
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

async function concluirMemoria(id) {
  try {
    const r = await chamarServidor("trabalhoConcluirMemoria", { id: id, concluido: "true" });
    mostrarToast((r.ok ? "✅ " : "❌ ") + r.mensagem);
    if (r.ok) await carregarTrabalho();
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

// ---------- Impostos e notas do processo ----------
function abrirProcesso(idProcesso) {
  const it = trabDados.itens.filter(function (i) { return i.idProcesso === idProcesso; })[0];
  if (!it) return;

  document.getElementById("modal-processo").style.display = "flex";
  document.getElementById("pr-id").value = idProcesso;
  document.getElementById("pr-titulo").textContent = it.nome;
  document.getElementById("pr-sub").textContent = competenciaPorExtenso(trabComp);
  document.getElementById("pr-pendencias").value = it.pendencias || "";
  document.getElementById("pr-observacoes").value = it.observacoes || "";
  document.getElementById("pr-aviso").textContent = "";
  ["pr-imp-nome", "pr-imp-valor", "pr-imp-base", "pr-imp-venc"].forEach(function (id) {
    document.getElementById(id).value = "";
  });

  document.getElementById("pr-imp-lista").innerHTML =
    (trabDados.impostosComuns || []).map(function (i) {
      return '<option value="' + i + '"></option>';
    }).join("");

  renderizarImpostos(it);
}

function renderizarImpostos(it) {
  const el = document.getElementById("pr-impostos");
  if (!it.impostos || !it.impostos.length) {
    el.innerHTML = '<p class="vazio">Nenhum imposto lançado.</p>';
    return;
  }

  el.innerHTML = it.impostos.map(function (i) {
    return '<div class="trab-imposto">' +
             '<span class="trab-imposto-nome">' + escaparHtml(i.imposto) + '</span>' +
             '<span class="trab-imposto-val">' + formatarMoeda(i.valor) + '</span>' +
             '<button class="tf-btn" title="Excluir" onclick="excluirImposto(\'' + i.id + '\')">×</button>' +
           '</div>';
  }).join("");
}

function fecharProcesso() {
  document.getElementById("modal-processo").style.display = "none";
}

async function salvarImposto() {
  const aviso = document.getElementById("pr-aviso");
  const nome = document.getElementById("pr-imp-nome").value.trim();
  const valor = document.getElementById("pr-imp-valor").value.trim();

  if (!nome) { aviso.textContent = "Qual imposto?"; return; }
  if (!valor) { aviso.textContent = "Informe o valor retido."; return; }

  try {
    const r = await chamarServidor("trabalhoSalvarImposto", {
      idProcesso: document.getElementById("pr-id").value,
      imposto: nome,
      valor: valor,
      base: document.getElementById("pr-imp-base").value.trim(),
      vencimento: document.getElementById("pr-imp-venc").value
    });

    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      const id = document.getElementById("pr-id").value;
      await carregarTrabalho();
      abrirProcesso(id);
    } else {
      aviso.textContent = r.mensagem || "Não deu.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão.";
  }
}

async function excluirImposto(id) {
  if (!confirm("Excluir este lançamento?")) return;

  try {
    const r = await chamarServidor("trabalhoExcluirImposto", { id: id });
    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      const idProc = document.getElementById("pr-id").value;
      await carregarTrabalho();
      abrirProcesso(idProc);
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não deu."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

async function salvarNotasProcesso() {
  const btn = document.getElementById("pr-btn-salvar");
  btn.disabled = true;
  btn.textContent = "Salvando...";

  try {
    const r = await chamarServidor("trabalhoSalvarNotas", {
      idProcesso: document.getElementById("pr-id").value,
      pendencias: document.getElementById("pr-pendencias").value.trim(),
      observacoes: document.getElementById("pr-observacoes").value.trim()
    });

    if (r.ok) {
      fecharProcesso();
      mostrarToast("✅ " + r.mensagem);
      await carregarTrabalho();
    } else {
      document.getElementById("pr-aviso").textContent = r.mensagem || "Não deu.";
    }
  } catch (e) {
    document.getElementById("pr-aviso").textContent = "Sem conexão.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar anotações";
  }
}

// ---------- Chat dos balancetes ----------
// Conversa separada do "conselho do dia", mas com a MESMA memória por trás:
// o que você fixa aqui entra no conselho de amanhã, e o que a outra sabe
// aparece aqui. É o mesmo assistente, dois jeitos de falar com ele.
let chtHistorico = [];

function abrirChatTrabalho() {
  document.getElementById("modal-chat-trabalho").style.display = "flex";

  const regras = ((trabDados && trabDados.memoria) || [])
    .filter(function (m) { return m.tipo === "regra"; }).length;

  document.getElementById("cht-sub").textContent =
    competenciaPorExtenso(trabComp) +
    (regras ? " · " + regras + " regra(s) fixada(s)" : "");

  if (!chtHistorico.length) {
    document.getElementById("cht-mensagens").innerHTML =
      '<div class="cht-msg ia">Pergunte o que quiser sobre os balancetes: quem está ' +
      'atrasado, o que falta em cada condomínio, documentação pendente, retenções, prazos.\n\n' +
      'Se quiser que eu passe a seguir alguma regra sua, escreva e toque em "Fixar como regra".</div>';
  }
  setTimeout(function () { document.getElementById("cht-texto").focus(); }, 100);
}

function fecharChatTrabalho() {
  document.getElementById("modal-chat-trabalho").style.display = "none";
}

function pintarMensagemChat(de, texto) {
  const caixa = document.getElementById("cht-mensagens");
  const div = document.createElement("div");
  div.className = "cht-msg " + de;
  div.textContent = texto;
  caixa.appendChild(div);
  caixa.scrollTop = caixa.scrollHeight;
  return div;
}

async function enviarChatTrabalho() {
  const campo = document.getElementById("cht-texto");
  const btn = document.getElementById("cht-enviar");
  const texto = campo.value.trim();
  if (!texto) return;

  pintarMensagemChat("eu", texto);
  chtHistorico.push({ de: "eu", texto: texto });
  campo.value = "";

  btn.disabled = true;
  const pensando = pintarMensagemChat("ia", "Pensando...");

  try {
    // POST: o histórico não caberia numa URL.
    const r = await chamarServidorPost("trabalhoChat", {
      texto: texto,
      competencia: trabComp,
      historico: JSON.stringify(chtHistorico.slice(-8))
    });

    if (r.ok) {
      pensando.textContent = r.resposta;
      chtHistorico.push({ de: "ia", texto: r.resposta });

      // Ela propõe, você decide: cada ação vira um cartão com o que vai
      // acontecer e três saídas — editar, confirmar ou cancelar. Nada foi
      // gravado até você tocar em Confirmar.
      if (r.propostas && r.propostas.length) {
        r.propostas.forEach(function (p) { pintarProposta(p); });
      }
    } else {
      pensando.className = "cht-msg erro";
      pensando.textContent = r.mensagem || "Não consegui responder.";
    }
  } catch (e) {
    pensando.className = "cht-msg erro";
    pensando.textContent = "Sem conexão.";
  } finally {
    btn.disabled = false;
    campo.focus();
  }
}

// ============================================================================
// PROPOSTA DA IA: EDITAR · CONFIRMAR · CANCELAR
// ----------------------------------------------------------------------------
// Nada que a IA sugere é gravado antes de você confirmar. O cartão diz por
// extenso o que vai acontecer, e "Editar" abre os campos — porque o erro dela
// costuma ser o condomínio ou o mês, não o texto da anotação.
// ============================================================================
function pintarProposta(p) {
  const caixa = document.getElementById("cht-mensagens");
  const div = document.createElement("div");
  div.className = "cht-proposta" + (p.pronta ? "" : " incompleta");

  const resumo = document.createElement("div");
  resumo.className = "cht-prop-resumo";
  resumo.textContent = (p.pronta ? "Vou fazer isto: " : "⚠ ") + p.resumo;
  div.appendChild(resumo);

  // Campos de edição, escondidos até você pedir
  const campos = document.createElement("div");
  campos.className = "cht-prop-campos";
  campos.style.display = p.pronta ? "none" : "block";

  function campo(rotulo, valor, chave) {
    const bloco = document.createElement("div");
    bloco.className = "campo-bloco";
    const lab = document.createElement("label");
    lab.textContent = rotulo;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = valor || "";
    inp.dataset.chave = chave;
    bloco.appendChild(lab);
    bloco.appendChild(inp);
    campos.appendChild(bloco);
  }

  campo("Anotação", p.texto, "texto");
  if (p.tipo === "pendencia") {
    campo("Condomínio", p.condominio, "condominio");
    campo("Competência (aaaa-mm)", p.competencia, "competencia");
  }
  div.appendChild(campos);

  const acoes = document.createElement("div");
  acoes.className = "cht-prop-acoes";

  const bEditar = document.createElement("button");
  bEditar.textContent = "Editar";
  bEditar.onclick = function () {
    const aberto = campos.style.display !== "none";
    campos.style.display = aberto ? "none" : "block";
    bEditar.textContent = aberto ? "Editar" : "Ocultar";
  };

  const bConfirmar = document.createElement("button");
  // Remover e substituir apagam: o botão avisa antes de ser tocado.
  const destrutiva = (p.modo === "remover" || p.modo === "substituir");
  bConfirmar.className = destrutiva ? "principal perigo" : "principal";
  bConfirmar.textContent = destrutiva ? "Confirmar e apagar" : "Confirmar";
  bConfirmar.onclick = async function () {
    const dados = { tipo: p.tipo, modo: p.modo || "", competenciaTela: trabComp };
    campos.querySelectorAll("input").forEach(function (i) { dados[i.dataset.chave] = i.value.trim(); });

    if (!dados.texto) { resumo.textContent = "⚠ A anotação não pode ficar vazia."; return; }

    bConfirmar.disabled = true;
    bConfirmar.textContent = "Gravando...";

    try {
      const r = await chamarServidor("trabalhoAplicarAcao", dados);
      if (r.ok) {
        div.className = "cht-proposta feita";
        div.innerHTML = "";
        const ok = document.createElement("div");
        ok.className = "cht-prop-resumo";
        ok.textContent = "✅ " + r.mensagem;
        div.appendChild(ok);
        await carregarTrabalho();
      } else {
        resumo.textContent = "⚠ " + (r.mensagem || "Não consegui gravar.");
        campos.style.display = "block";
        bEditar.textContent = "Ocultar";
        bConfirmar.disabled = false;
        bConfirmar.textContent = "Confirmar";
      }
    } catch (e) {
      resumo.textContent = "⚠ Sem conexão. Nada foi gravado.";
      bConfirmar.disabled = false;
      bConfirmar.textContent = "Confirmar";
    }
  };

  const bCancelar = document.createElement("button");
  bCancelar.textContent = "Cancelar";
  bCancelar.onclick = function () {
    div.className = "cht-proposta cancelada";
    div.innerHTML = "";
    const x = document.createElement("div");
    x.className = "cht-prop-resumo";
    x.textContent = "Cancelado — nada foi gravado.";
    div.appendChild(x);
  };

  acoes.appendChild(bEditar);
  acoes.appendChild(bCancelar);
  acoes.appendChild(bConfirmar);
  div.appendChild(acoes);

  caixa.appendChild(div);
  caixa.scrollTop = caixa.scrollHeight;
}

// Fixa o que está escrito no campo — ou, se estiver vazio, a última coisa que
// VOCÊ disse. Nunca a resposta da IA: fixar o que ela inventou como se fosse
// regra sua é o jeito mais rápido de envenenar a memória.
async function fixarNaMemoria(tipo) {
  const campo = document.getElementById("cht-texto");
  const aviso = document.getElementById("cht-aviso");

  let texto = campo.value.trim();
  if (!texto) {
    const minhas = chtHistorico.filter(function (m) { return m.de === "eu"; });
    texto = minhas.length ? minhas[minhas.length - 1].texto : "";
  }

  if (!texto) {
    aviso.textContent = "Escreva primeiro o que você quer fixar.";
    return;
  }

  try {
    const r = await chamarServidor("trabalhoAnotarMemoria", { texto: texto, tipo: tipo });
    if (r.ok) {
      aviso.textContent = "✅ " + r.mensagem;
      campo.value = "";
      pintarMensagemChat("ia", (tipo === "regra" ? "📌 Regra fixada: " : "🔔 Lembrete fixado: ") + texto);
      await carregarTrabalho();
      abrirChatTrabalho();
    } else {
      aviso.textContent = r.mensagem || "Não consegui fixar.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão.";
  }
}

// ---------- Configurações do Smarttrabalho ----------
function abrirConfigTrabalho() {
  document.getElementById("modal-config-trabalho").style.display = "flex";
  document.getElementById("ct-busca").value = "";
  document.getElementById("ct-aviso-periodo").textContent = "";
  // "Até" nasce na competência da tela, que é a que se está trabalhando.
  document.getElementById("ct-ate").value = trabComp;
  renderizarListaCondominios();
}

// Abrir mês a mês seria sete toques para montar o histórico do ano.
async function abrirPeriodoTrabalho() {
  const aviso = document.getElementById("ct-aviso-periodo");
  const de = document.getElementById("ct-de").value;
  const ate = document.getElementById("ct-ate").value;

  if (!de || !ate) { aviso.textContent = "Preencha as duas competências."; return; }
  if (de > ate) { aviso.textContent = "A primeira competência é posterior à última."; return; }

  aviso.textContent = "Abrindo... isso pode levar alguns segundos.";

  try {
    const r = await chamarServidor("trabalhoAbrirPeriodo", { de: de, ate: ate });
    aviso.textContent = r.mensagem || (r.ok ? "Pronto." : "Não consegui.");
    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      await carregarTrabalho();
    }
  } catch (e) {
    aviso.textContent = "Sem conexão.";
  }
}

function fecharConfigTrabalho() {
  document.getElementById("modal-config-trabalho").style.display = "none";
}

function renderizarListaCondominios() {
  const el = document.getElementById("ct-lista");
  const todos = (trabDados && trabDados.condominios) || [];
  const busca = document.getElementById("ct-busca").value.trim().toLowerCase();

  document.getElementById("ct-sub").textContent =
    todos.length + " condomínio(s) cadastrado(s)";

  const lista = busca
    ? todos.filter(function (c) { return c.nome.toLowerCase().indexOf(busca) >= 0; })
    : todos;

  if (!lista.length) {
    el.innerHTML = '<p class="vazio">' +
      (busca ? "Nada encontrado." : "Nenhum condomínio ainda.") + '</p>';
    return;
  }

  // Em ordem alfabética: aqui você procura pelo nome, não pela urgência.
  const ordenada = lista.slice().sort(function (a, b) { return a.nome.localeCompare(b.nome); });

  el.innerHTML = ordenada.map(function (c) {
    const partes = [];
    if (c.frentes === "ambas") partes.push("Balancete + contas");
    else if (c.frentes === "contas") partes.push("Contas a pagar");
    else partes.push("Balancete");
    if (c.boleto) partes.push("boleto dia " + c.diaBoleto);
    if (c.diaEntrega) partes.push("entrega dia " + c.diaEntrega);
    if (!c.ativo) partes.push("arquivado");

    return '<div class="ct-item' + (c.ativo ? "" : " arquivado") + '" ' +
             'onclick="editarPelaConfig(\'' + c.id + '\')">' +
             '<div class="ct-item-info">' +
               '<div class="ct-item-nome">' + escaparHtml(c.nome) + '</div>' +
               '<div class="ct-item-sub">' + escaparHtml(partes.join(" · ")) + '</div>' +
             '</div>' +
             '<span class="tf-btn">✎</span>' +
           '</div>';
  }).join("");
}

function editarPelaConfig(id) {
  fecharConfigTrabalho();
  abrirCondominio(id);
}

// Conta antes de apagar: linha removida da planilha não tem desfazer.
async function procurarDuplicados() {
  const aviso = document.getElementById("ct-aviso-dup");
  aviso.textContent = "Procurando...";

  try {
    const r = await chamarServidor("trabalhoLimparDuplicados", { simular: "true" });
    if (!r.ok) { aviso.textContent = r.mensagem || "Não consegui verificar."; return; }

    if (!r.condominios && !r.processos) {
      aviso.textContent = "Nada repetido. Está tudo limpo.";
      return;
    }

    const nomes = (r.nomes || []).slice(0, 6).join(", ");
    aviso.textContent =
      "Repetidos: " + r.condominios + " condomínio(s) e " + r.processos + " processo(s)" +
      (r.impostos ? ", além de " + r.impostos + " imposto(s) ligados a eles" : "") +
      (nomes ? ". São: " + nomes : "") + ".";

    const texto =
      "Remover " + r.condominios + " condomínio(s) repetido(s) e " +
      r.processos + " processo(s)?\n\n" +
      "Fica sempre o cadastro mais antigo de cada nome — que é o que os " +
      "processos já apontam.\n\nIsso não tem desfazer.";

    if (!confirm(texto)) { aviso.textContent = "Nada foi removido."; return; }

    const f = await chamarServidor("trabalhoLimparDuplicados", {});
    if (f.ok) {
      mostrarToast("✅ " + f.mensagem);
      aviso.textContent = f.mensagem;
      await carregarTrabalho();
      renderizarListaCondominios();
    } else {
      aviso.textContent = f.mensagem || "Não consegui remover.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão.";
  }
}

// ---------- Cadastro de condomínio ----------
function abrirCondominio(id) {
  const c = id && trabDados
    ? trabDados.condominios.filter(function (x) { return x.id === id; })[0]
    : null;

  document.getElementById("modal-condominio").style.display = "flex";
  document.getElementById("cd-id").value = c ? c.id : "";
  document.getElementById("cd-nome").value = c ? c.nome : "";
  document.getElementById("cd-cnpj").value = c ? c.cnpj : "";
  document.getElementById("cd-boleto").checked = c ? c.boleto : false;
  document.getElementById("cd-dia-boleto").value = c && c.diaBoleto ? c.diaBoleto : "";
  document.getElementById("cd-dia-entrega").value = c && c.diaEntrega ? c.diaEntrega : "";
  document.getElementById("cd-banco").value = c ? (c.banco || "") : "";
  document.getElementById("cd-aprovacao").value = c ? (c.aprovacao || "") : "";
  document.getElementById("cd-obs").value = c ? c.observacao : "";
  document.getElementById("cd-ativo").checked = c ? c.ativo : true;
  document.getElementById("cd-aviso").textContent = "";
  document.getElementById("cd-titulo").textContent = c ? "🏢 Editar condomínio" : "🏢 Novo condomínio";

  // Só faz sentido arquivar, excluir ou desativar o que já existe.
  ["cd-btn-arquivar", "cd-btn-excluir", "cd-bloco-ativo"].forEach(function (id) {
    document.getElementById(id).style.display = c ? "block" : "none";
  });
  if (c) document.getElementById("cd-bloco-ativo").style.display = "flex";

  escolherFrentes(c ? c.frentes : "balancete");
  alternarCamposBoleto();
}

function escolherFrentes(qual) {
  document.getElementById("modal-condominio").dataset.frentes = qual;
  ["balancete", "contas", "ambas"].forEach(function (f) {
    document.getElementById("cd-frente-" + f).classList.toggle("ativo", f === qual);
  });
}

// O dia da conciliação só importa para quem emite boleto: é ele que aperta
// o prazo. Sem boleto, o campo só confundiria.
function alternarCamposBoleto() {
  const marcado = document.getElementById("cd-boleto").checked;
  document.getElementById("cd-bloco-boleto").style.display = marcado ? "block" : "none";
}

function fecharCondominio() {
  document.getElementById("modal-condominio").style.display = "none";
}

async function salvarCondominio() {
  const aviso = document.getElementById("cd-aviso");
  const nome = document.getElementById("cd-nome").value.trim();
  if (!nome) { aviso.textContent = "Dê um nome ao condomínio."; return; }

  const boleto = document.getElementById("cd-boleto").checked;
  const diaBoleto = document.getElementById("cd-dia-boleto").value;
  if (boleto && !diaBoleto) {
    aviso.textContent = "Até que dia a conciliação precisa estar pronta?";
    return;
  }

  const btn = document.getElementById("cd-btn-salvar");
  btn.disabled = true;
  btn.textContent = "Salvando...";

  try {
    const r = await chamarServidor("trabalhoSalvarCondominio", {
      id: document.getElementById("cd-id").value,
      nome: nome,
      cnpj: document.getElementById("cd-cnpj").value.trim(),
      boleto: boleto ? "true" : "false",
      diaBoleto: diaBoleto || "0",
      diaEntrega: document.getElementById("cd-dia-entrega").value || "0",
      observacao: document.getElementById("cd-obs").value.trim(),
      frentes: document.getElementById("modal-condominio").dataset.frentes || "balancete",
      ativo: document.getElementById("cd-ativo").checked ? "true" : "false",
      banco: document.getElementById("cd-banco").value.trim(),
      aprovacao: document.getElementById("cd-aprovacao").value.trim()
    });

    if (r.ok) {
      fecharCondominio();
      mostrarToast("✅ " + r.mensagem);
      await carregarTrabalho();
    } else {
      aviso.textContent = r.mensagem || "Não foi possível salvar.";
    }
  } catch (e) {
    aviso.textContent = "Sem conexão.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar";
  }
}

// Confirmação em duas etapas de propósito: leva os processos e impostos junto
// e não tem desfazer. Arquivar continua sendo o caminho normal.
async function apagarCondominioDeVez() {
  const id = document.getElementById("cd-id").value;
  if (!id) return;

  const nome = document.getElementById("cd-nome").value.trim();
  const c = trabDados && trabDados.condominios.filter(function (x) { return x.id === id; })[0];
  if (!c) return;

  if (!confirm('Excluir "' + nome + '" DE VEZ?\n\nVai junto todo o histórico: ' +
               'processos, etapas e impostos lançados.\n\nIsso não tem desfazer. ' +
               'Se você só quer tirá-lo da lista, use Arquivar.')) return;

  if (!confirm("Tem certeza? Última confirmação.")) return;

  try {
    const r = await chamarServidor("trabalhoApagarCondominio", { id: id });
    if (r.ok) {
      fecharCondominio();
      mostrarToast("✅ " + r.mensagem);
      await carregarTrabalho();
    } else {
      document.getElementById("cd-aviso").textContent = r.mensagem || "Não deu.";
    }
  } catch (e) {
    document.getElementById("cd-aviso").textContent = "Sem conexão.";
  }
}

async function arquivarCondominio() {
  const id = document.getElementById("cd-id").value;
  if (!id) return;
  if (!confirm("Arquivar este condomínio? O histórico dele fica.")) return;

  try {
    const r = await chamarServidor("trabalhoExcluirCondominio", { id: id });
    if (r.ok) {
      fecharCondominio();
      mostrarToast("✅ " + r.mensagem);
      await carregarTrabalho();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não deu."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

// ============================================================================
// SMARTTAREFAS
// ----------------------------------------------------------------------------
// Tarefas, lembretes e ideias. A lista do tipo escolhido vem inteira do
// servidor (inclusive as concluídas) e o filtro — busca e "mostrar feitas" —
// acontece aqui. É de propósito: o Apps Script leva segundos por chamada, e
// filtrar no servidor a cada tecla traria de volta a corrida de respostas
// atrasadas que já deu dor de cabeça na busca de lançamentos.
// ============================================================================
let tfTipo = "tarefa";
let tfMostrarFeitas = false;
let tfDados = [];

// "novo" está aqui porque lembrete é masculino e tarefa/ideia femininas:
// sem isso o título do modal saía "Nova lembrete".
const TF_ROTULOS = {
  tarefa:   { emoji: "✅", singular: "tarefa",   plural: "Tarefas",   novo: "Nova" },
  lembrete: { emoji: "🔔", singular: "lembrete", plural: "Lembretes", novo: "Novo" },
  ideia:    { emoji: "💡", singular: "ideia",    plural: "Ideias",    novo: "Nova" }
};

function trocarTipoTarefa(tipo) {
  tfTipo = tipo;
  ["tarefa", "lembrete", "ideia"].forEach(function (t) {
    document.getElementById("tf-aba-" + t).classList.toggle("ativo", t === tipo);
  });
  document.getElementById("tf-busca").value = "";
  carregarTarefas();
}

function alternarFeitas() {
  tfMostrarFeitas = !tfMostrarFeitas;
  document.getElementById("tf-btn-feitas").textContent =
    tfMostrarFeitas ? "Esconder feitas" : "Mostrar feitas";
  renderizarTarefas();
}

function filtrarTarefas() {
  renderizarTarefas();
}

async function carregarTarefas() {
  const lista = document.getElementById("tf-lista");
  lista.innerHTML = '<p class="vazio">Carregando...</p>';

  try {
    const r = await chamarServidor("listarTarefas", { tipo: tfTipo, incluirFeitas: "true" });

    if (r.ok) {
      tfDados = r.tarefas || [];
      ["tarefa", "lembrete", "ideia"].forEach(function (t) {
        const n = (r.abertas && r.abertas[t]) || 0;
        document.getElementById("tf-selo-" + t).textContent = n > 0 ? n : "";
      });
    } else {
      tfDados = [];
      mostrarToast("❌ " + (r.mensagem || "Não consegui carregar."));
    }
  } catch (e) {
    tfDados = [];
    mostrarToast("❌ Sem conexão.");
  }

  renderizarTarefas();
}

function renderizarTarefas() {
  const lista = document.getElementById("tf-lista");
  const rot = TF_ROTULOS[tfTipo];
  const busca = document.getElementById("tf-busca").value.trim().toLowerCase();

  document.getElementById("tf-lista-titulo").textContent =
    rot.plural + (tfMostrarFeitas ? "" : " em aberto");

  let itens = tfDados;
  if (!tfMostrarFeitas) itens = itens.filter(function (t) { return !t.concluido; });
  if (busca) {
    itens = itens.filter(function (t) {
      return (t.titulo + " " + t.detalhe).toLowerCase().indexOf(busca) >= 0;
    });
  }

  if (!itens.length) {
    lista.innerHTML = '<p class="vazio">' +
      (busca ? "Nada encontrado." : "Nenhuma " + rot.singular + " por aqui ainda.") + '</p>';
    return;
  }

  const hoje = dataHojeISO();
  let html = "";

  itens.forEach(function (t) {
    const tags = [];

    if (t.data) {
      let classe = "", texto = formatarDataCurta(t.data);
      if (t.hora) texto += " · " + t.hora;
      if (!t.concluido && t.data < hoje) { classe = "atrasada"; texto = "Atrasada · " + texto; }
      else if (t.data === hoje) { classe = "hoje"; texto = "Hoje" + (t.hora ? " · " + t.hora : ""); }
      tags.push('<span class="tf-tag ' + classe + '">' + texto + '</span>');
    }
    if (t.prioridade !== "normal") {
      tags.push('<span class="tf-tag ' + t.prioridade + '">' +
                (t.prioridade === "alta" ? "Alta" : "Baixa") + '</span>');
    }
    if (t.origem) tags.push('<span class="tf-tag">Veio de uma ideia</span>');

    // Promover só faz sentido em ideia aberta: é o caminho ideia -> tarefa.
    const btnPromover = (t.tipo === "ideia" && !t.concluido)
      ? '<button class="tf-btn" title="Virar tarefa" onclick="promoverIdeiaApp(\'' + t.id + '\')">→</button>'
      : '';

    html +=
      '<div class="tf-item' + (t.concluido ? " feita" : "") + '">' +
        '<div class="tf-check" onclick="concluirTarefaApp(\'' + t.id + '\', ' + (!t.concluido) + ')">' +
          (t.concluido ? "✔" : "") +
        '</div>' +
        '<div class="tf-info" onclick="abrirTarefa(\'' + t.id + '\')">' +
          '<div class="tf-titulo">' + escaparHtml(t.titulo) + '</div>' +
          (t.detalhe ? '<div class="tf-detalhe">' + escaparHtml(t.detalhe) + '</div>' : '') +
          (tags.length ? '<div class="tf-linha-meta">' + tags.join("") + '</div>' : '') +
        '</div>' +
        '<div class="tf-acoes">' +
          btnPromover +
          '<button class="tf-btn" title="Editar" onclick="abrirTarefa(\'' + t.id + '\')">✎</button>' +
        '</div>' +
      '</div>';
  });

  lista.innerHTML = html;
}

// "2026-08-14" -> "14/08"
function formatarDataCurta(iso) {
  const p = (iso || "").split("-");
  return p.length === 3 ? p[2] + "/" + p[1] : iso;
}

function abrirTarefa(id) {
  const modal = document.getElementById("modal-tarefa");
  modal.style.display = "flex";

  const t = id ? tfDados.filter(function (x) { return x.id === id; })[0] : null;

  document.getElementById("tf-id").value = t ? t.id : "";
  document.getElementById("tf-nome").value = t ? t.titulo : "";
  document.getElementById("tf-detalhe").value = t ? t.detalhe : "";
  document.getElementById("tf-data").value = t ? t.data : "";
  document.getElementById("tf-hora").value = t ? t.hora : "";
  document.getElementById("tf-prioridade").value = t ? t.prioridade : "normal";
  document.getElementById("tf-aviso").textContent = "";
  document.getElementById("tf-btn-excluir").style.display = t ? "block" : "none";

  // Nova anotação nasce no tipo da aba aberta: quem está em "Ideias" e toca
  // no "+" quer anotar uma ideia.
  escolherTipoTarefa(t ? t.tipo : tfTipo);
}

function escolherTipoTarefa(tipo) {
  document.getElementById("modal-tarefa").dataset.tipo = tipo;

  ["tarefa", "lembrete", "ideia"].forEach(function (t) {
    document.getElementById("tf-tipo-" + t).classList.toggle("ativo", t === tipo);
  });

  const rot = TF_ROTULOS[tipo];
  const editando = !!document.getElementById("tf-id").value;
  document.getElementById("tf-titulo-modal").textContent =
    rot.emoji + " " + (editando ? "Editar " : rot.novo + " ") + rot.singular;

  document.getElementById("tf-bloco-prazo").style.display = (tipo === "ideia") ? "none" : "block";
}

function fecharTarefa() {
  document.getElementById("modal-tarefa").style.display = "none";
}

async function salvarTarefaApp() {
  const aviso = document.getElementById("tf-aviso");
  const btn = document.getElementById("tf-btn-salvar");

  const tipo = document.getElementById("modal-tarefa").dataset.tipo || "tarefa";
  const titulo = document.getElementById("tf-nome").value.trim();
  const data = document.getElementById("tf-data").value;

  if (!titulo) { aviso.textContent = "Escreva o título."; return; }
  if (tipo === "lembrete" && !data) { aviso.textContent = "Um lembrete precisa de data."; return; }

  btn.disabled = true;
  btn.textContent = "Salvando...";

  try {
    const r = await chamarServidor("salvarTarefa", {
      id: document.getElementById("tf-id").value,
      tipo: tipo,
      titulo: titulo,
      detalhe: document.getElementById("tf-detalhe").value.trim(),
      data: (tipo === "ideia") ? "" : data,
      hora: (tipo === "ideia") ? "" : document.getElementById("tf-hora").value,
      prioridade: document.getElementById("tf-prioridade").value
    });

    if (r.ok) {
      fecharTarefa();
      mostrarToast("✅ " + r.mensagem);
      // Trocar o tipo dentro do modal move a anotação de aba; sem isto ela
      // sumiria da tela e pareceria perdida.
      if (tipo !== tfTipo) trocarTipoTarefa(tipo);
      else await carregarTarefas();
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

async function concluirTarefaApp(id, feito) {
  // Muda na tela antes da resposta: marcar item é gesto rápido e esperar o
  // Apps Script responder parece travamento.
  const alvo = tfDados.filter(function (x) { return x.id === id; })[0];
  if (alvo) { alvo.concluido = feito; renderizarTarefas(); }

  try {
    const r = await chamarServidor("concluirTarefa", { id: id, concluido: feito ? "true" : "false" });
    if (!r.ok) {
      if (alvo) { alvo.concluido = !feito; renderizarTarefas(); }
      mostrarToast("❌ " + (r.mensagem || "Não deu."));
      return;
    }
    const selo = document.getElementById("tf-selo-" + tfTipo);
    const n = Math.max(0, (parseInt(selo.textContent) || 0) + (feito ? -1 : 1));
    selo.textContent = n > 0 ? n : "";
  } catch (e) {
    if (alvo) { alvo.concluido = !feito; renderizarTarefas(); }
    mostrarToast("❌ Sem conexão.");
  }
}

async function excluirTarefaApp() {
  const id = document.getElementById("tf-id").value;
  if (!id) return;
  if (!confirm("Excluir definitivamente?")) return;

  try {
    const r = await chamarServidor("excluirTarefa", { id: id });
    if (r.ok) {
      fecharTarefa();
      mostrarToast("✅ " + r.mensagem);
      await carregarTarefas();
    } else {
      mostrarToast("❌ " + (r.mensagem || "Não foi possível excluir."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

// A ideia não é apagada: fica marcada como concluída e a tarefa nova aponta
// para ela. Saber de onde a tarefa veio é metade da graça de anotar ideia.
async function promoverIdeiaApp(id) {
  const ideia = tfDados.filter(function (x) { return x.id === id; })[0];
  if (!ideia) return;
  if (!confirm('Transformar "' + ideia.titulo + '" em tarefa?')) return;

  try {
    const r = await chamarServidor("promoverIdeia", { id: id });
    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      trocarTipoTarefa("tarefa");
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
  // O modal aparece ANTES de pintar os temas: a fileira rola para mostrar o
  // tema escolhido, e elemento escondido nao tem largura nem posicao -- com
  // display:none o calculo da rolagem da zero e nada se move.
  document.getElementById("modal-config").style.display = "flex";
  pintarEscolhaDeTema();
  document.getElementById("cfg-nova").classList.remove("aberto");

  const alvo = document.getElementById("cfg-categorias");
  alvo.innerHTML = '<p class="vazio">Carregando...</p>';

  // Sempre busca do servidor: aqui a lista precisa estar exata.
  try {
    const rl = await lerCacheado("listasValidas");
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

  // Reabre sempre na lista: sair de Configurações dentro de uma sub-tela e
  // voltar lá dentro seria reabrir no meio de um assunto já resolvido.
  voltarDoSubConfig();
}

// Bloco de versão em Configurações: mostra a instalada e um botão que abre o
// download da última, sem depender de esperar o aviso automático aparecer.
async function montarVersaoApp() {
  const alvo = document.getElementById("cfg-versao");
  if (!alvo) return;

  if (!rodandoNoAplicativo()) {
    alvo.innerHTML =
      '<div class="cfg-lin cfg-lin-estatica"><span class="cfg-lin-txt">' +
        '<span class="cfg-lin-tit">Você está pelo navegador</span>' +
        '<span class="cfg-lin-sub">o aplicativo Android tem widgets e avisos de vencimento</span>' +
      '</span></div>' +
      '<button type="button" class="cfg-lin cfg-lin-verde" ' +
      'onclick="baixarAtualizacao(\'' + LINK_APK + '\')">' +
        '<span class="cfg-lin-txt"><span class="cfg-lin-tit">Baixar o aplicativo</span></span>' +
        '<span class="cfg-lin-seta">&#8250;</span>' +
      '</button>';
    return;
  }

  let instalada = "?";
  try {
    const A = window.Capacitor.Plugins.App;
    if (A && A.getInfo) instalada = (await A.getInfo()).version || "?";
  } catch (e) {}

  alvo.innerHTML =
    '<div class="cfg-lin cfg-lin-estatica">' +
      '<span class="cfg-lin-txt"><span class="cfg-lin-tit">Versão instalada</span></span>' +
      '<span class="cfg-lin-val">' + escaparHtml(instalada) + '</span>' +
    '</div>' +
    '<button type="button" class="cfg-lin cfg-lin-verde" ' +
    'onclick="baixarAtualizacao(\'' + LINK_APK + '\')">' +
      '<span class="cfg-lin-txt"><span class="cfg-lin-tit">Baixar a última versão</span></span>' +
      '<span class="cfg-lin-seta">&#8250;</span>' +
    '</button>';
}

function fecharConfig() {
  document.getElementById("modal-config").style.display = "none";

  // Fechar com o código revelado não pode deixá-lo revelado para a próxima
  // abertura -- e o relógio não tem por que continuar correndo.
  if (cfgCodigoRelogio) { clearInterval(cfgCodigoRelogio); cfgCodigoRelogio = null; }
  montarCodigoAcesso();
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

// ============================================================================
// DESPESAS FIXAS
// Elas dividem a aba 'Dados fcnmt' com categorias e métodos, então o servidor
// só mexe nas colunas delas — apagar a linha inteira levaria junto uma
// categoria e um método. Aqui é só a tela.
// ============================================================================
let fixasCarregadas = [];

// ============================================================================
// VENCIMENTO DOS CARTÕES
// ----------------------------------------------------------------------------
// Mudar o dia aqui NÃO remarca o que já está lançado — e é bom que não
// remarque: fatura já conferida com o banco não pode se mexer sozinha. O
// realinhamento é um segundo passo, com prévia do que muda.
// ============================================================================
let cartoesConfig = [];

function alternarSecaoCartoes() { abrirSubConfig("cartoes"); }

async function carregarCartoesConfig() {
  const alvo = document.getElementById("cfg-lista-cartoes");
  alvo.innerHTML = '<p class="vazio">Carregando...</p>';

  try {
    const r = await chamarServidor("listarCartoesConfig");
    if (!r.ok) { alvo.innerHTML = '<p class="vazio">' + escaparHtml(r.mensagem || "Falhou.") + '</p>'; return; }

    cartoesConfig = r.cartoes || [];
    if (!cartoesConfig.length) {
      alvo.innerHTML = '<p class="vazio">Nenhum cartão configurado.</p>';
      if (subConfigAberta === "cartoes") dicaDoSubConfig("nenhum configurado");
      return;
    }

    if (subConfigAberta === "cartoes") {
      dicaDoSubConfig(cartoesConfig.length +
        (cartoesConfig.length === 1 ? " cartão" : " cartões") + " · vencimento e limite");
    }

    alvo.innerHTML = cartoesConfig.map(function (c, i) {
      // Mostra os dias que APARECEM nas compras em aberto: é assim que se
      // enxerga a parcela cadastrada fora do dia certo, sem procurar uma a uma.
      const fora = (c.diasEncontrados || []).filter(function (d) { return d.ok === false; });
      const aviso = fora.length
        ? '<div class="cart-fora">⚠ ' +
            fora.map(function (d) { return d.quantas + " no dia " + d.dia; }).join(" · ") +
          '</div>'
        : '';

      return '<div class="cart-item">' +
        '<div class="cart-nome">' + escaparHtml(c.nome) + '</div>' +
        '<div class="cart-linha">' +
          '<label>Vence dia</label>' +
          '<input type="number" min="0" max="31" id="cart-venc-' + i + '" value="' + c.diaVencimento + '" />' +
          '<button onclick="salvarVencimentoCartao(' + i + ')">Salvar</button>' +
        '</div>' +
        '<div class="cart-sub">' + c.emAberto + ' compra(s) em aberto' +
          (c.diaVencimento === 0
            ? ' · <b>vence no último dia do mês anterior</b>'
            : '') +
        '</div>' +
        (c.diaVencimento === 0 || c.diaVencimento === 1
          ? '<button class="cart-alinhar" onclick="anteciparCartao(' + i + ')">' +
              (c.diaVencimento === 0
                ? 'Conferir se sobrou parcela no dia 1º'
                : 'Antecipar: passar a vencer no último dia do mês anterior') +
            '</button>'
          : '') +
        aviso +
        // No cartão antecipado este botão não tem o que dizer: "alinhar ao
        // dia 0" não quer dizer nada, e quem varre o dia 1º é o de cima.
        (c.emAberto > 0 && c.diaVencimento > 0
          ? '<button class="cart-alinhar" onclick="alinharCartao(' + i + ')">' +
              'Alinhar as compras em aberto ao dia ' + c.diaVencimento +
            '</button>'
          : '') +
      '</div>';
    }).join("");

  } catch (e) {
    alvo.innerHTML = '<p class="vazio">Sem conexão.</p>';
  }
}

/**
 * Passa o cartão a vencer no último dia do mês anterior, e leva junto o que
 * já está lançado.
 *
 * A fatura que vence dia 1º é paga na véspera: pelo banco ela é do mês
 * seguinte, pelo dinheiro é deste. Isto muda o rótulo, não o conteúdo -- o
 * fechamento passa de 8 para 7 dias antes do vencimento, o que deixa a data
 * de corte exatamente onde estava.
 *
 * SIMULA primeiro e mostra o número antes de escrever: são dezenas de linhas
 * de histórico, e ver "137 parcelas" antes de confirmar é diferente de
 * descobrir depois.
 */
/**
 * Põe cada lançamento de cartão na data da fatura dele.
 *
 * Simula antes: são dezenas de linhas, e ver o número e alguns exemplos antes
 * de confirmar é diferente de descobrir depois. Não toca em parcela paga --
 * o dinheiro saiu naquele dia, e mudar o vencimento reescreveria mês fechado.
 */
async function corrigirVencimentosCartao() {
  mostrarToast("Conferindo…");

  let sim;
  try {
    sim = await chamarServidor("corrigirVencimentosDeCartao", { simular: "true" });
  } catch (e) {
    mostrarToast("Falhou: " + (e.message || "sem conexão"));
    return;
  }
  if (!sim || !sim.ok) {
    // A trava de "mudaria mais de um ano" não pode sair num toast que some:
    // ela é o aviso de que a conta deu errado.
    alert((sim && sim.mensagem) || "Não consegui conferir.");
    return;
  }

  if (!sim.mexidos) {
    mostrarToast("Nada fora do lugar: as fixas de cartão estão na data da fatura.");
    return;
  }

  let aviso = sim.mexidos + " fixa(s) de cartão estão fora da data da fatura.\n\n";
  sim.exemplos.forEach(function (e) {
    aviso += "• " + e.descricao + ": " + e.de + " → " + e.para + "\n";
  });
  if (sim.mexidos > sim.exemplos.length) {
    aviso += "… e mais " + (sim.mexidos - sim.exemplos.length) + ".\n";
  }
  // Dizer o que NÃO é tocado importa tanto quanto o que é: foi por não
  // separar parcelamento que a primeira versão quis mover 55 linhas.
  aviso += "\nNão são tocados: " + sim.pulouParcelados + " parcelamento(s), " +
           sim.pulouPagos + " já paga(s)" +
           (sim.pulouSemCompra ? ", " + sim.pulouSemCompra + " sem data de compra" : "") +
           ".\n\nCorrigir?";

  if (!confirm(aviso)) return;

  try {
    const r = await chamarServidor("corrigirVencimentosDeCartao", { simular: "false" });
    mostrarToast((r && r.mensagem) || "Pronto.");
    esquecerDominio("transacoes");
    await carregarCartoesConfig();
    await recarregarDados();
  } catch (e) {
    mostrarToast("Falhou: " + (e.message || "sem conexão"));
  }
}

async function anteciparCartao(indice) {
  const c = cartoesConfig[indice];
  if (!c) return;

  mostrarToast("Conferindo o que mudaria…");

  let sim;
  try {
    sim = await chamarServidor("anteciparFaturasDoCartao", { cartao: c.nome, simular: "true" });
  } catch (e) {
    mostrarToast("Falhou: " + (e.message || "sem conexão"));
    return;
  }
  if (!sim || !sim.ok) { mostrarToast((sim && sim.mensagem) || "Não consegui conferir."); return; }

  if (c.diaVencimento === 0 && !sim.mexidos) {
    mostrarToast("Nada fora do lugar: nenhuma parcela no dia 1º neste cartão.");
    return;
  }

  let aviso = "Antecipar o " + c.nome + "?\n\n" +
    sim.mexidos + " parcela(s) que vencem no dia 1º passam para o último dia " +
    "do mês anterior.\n\n" +
    "As compras de cada fatura NÃO mudam: o fechamento passa a ser 7 dias " +
    "antes em vez de 8, e a data de corte fica onde está. O que muda é o mês " +
    "em que a fatura aparece no balanço.";

  if (sim.foraDoPadrao && sim.foraDoPadrao.length) {
    aviso += "\n\nFicam como estão " +
      sim.foraDoPadrao.map(function (f) { return f.quantas + " do dia " + f.dia; }).join(", ") +
      " — podem ser ajustes feitos à mão.";
  }

  if (!confirm(aviso)) return;

  try {
    const r1 = await chamarServidor("salvarCartaoConfig", { cartao: c.nome, diaVencimento: 0 });
    if (!r1 || !r1.ok) {
      // Um toast some sozinho, e foi assim que a recusa da configuração
      // passou batida: a migração não rodou e pareceu que nada aconteceu.
      alert("Não consegui mudar o cartão, então NADA foi alterado nos lançamentos.\n\n" +
            ((r1 && r1.mensagem) || "o servidor não respondeu"));
      return;
    }

    const r2 = await chamarServidor("anteciparFaturasDoCartao", { cartao: c.nome, simular: "false" });
    mostrarToast((r2 && r2.mensagem) || "Pronto.");

    esquecerDominio("transacoes");
    await carregarCartoesConfig();
    await recarregarDados();
  } catch (e) {
    mostrarToast("Falhou: " + (e.message || "sem conexão"));
  }
}

async function salvarVencimentoCartao(indice) {
  const c = cartoesConfig[indice];
  if (!c) return;

  const dia = parseInt(document.getElementById("cart-venc-" + indice).value);
  // 0 não é "vazio": é "último dia do mês anterior".
  if (isNaN(dia) || dia < 0 || dia > 31) { mostrarToast("Dia deve ser de 0 a 31."); return; }

  try {
    const r = await chamarServidor("salvarCartaoConfig", { cartao: c.nome, diaVencimento: dia });
    if (!r.ok) { mostrarToast("❌ " + r.mensagem); return; }

    mostrarToast("✅ " + r.mensagem);
    await carregarCartoesConfig();

    // Salvar o dia novo e ver a lista velha intacta parece que nada
    // aconteceu. Oferecer o alinhamento aqui, com o cartão já atualizado, é o
    // momento em que a pergunta faz sentido — em vez de esperar você notar um
    // botão a mais no card.
    const atualizado = cartoesConfig.filter(function (x) { return x.nome === c.nome; })[0];
    if (!atualizado || !atualizado.emAberto) return;

    const fora = (atualizado.diasEncontrados || [])
      .filter(function (d) { return d.ok === false; })
      .reduce(function (s, d) { return s + d.quantas; }, 0);

    if (!fora) return;

    const indiceNovo = cartoesConfig.indexOf(atualizado);
    if (confirm(fora + " compra(s) em aberto do " + c.nome + " ainda vencem em " +
                "outro dia.\n\nQuer passá-las para o dia " + dia + " agora?")) {
      await alinharCartao(indiceNovo);
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

// Mostra o que muda ANTES de mudar: remarcar vencimento em massa sem ver a
// lista é o tipo de coisa que só se descobre errada no extrato.
async function alinharCartao(indice) {
  const c = cartoesConfig[indice];
  if (!c) return;

  mostrarToast("Conferindo...");

  try {
    // Sem competencia, o servidor limita ao mes atual em diante: mes fechado
    // nao se remexe.
    const s = await chamarServidor("alinharVencimentosDoCartao", {
      cartao: c.nome, dia: c.diaVencimento, simular: "true"
    });

    if (!s.ok) { mostrarToast("ℹ️ " + (s.mensagem || "Nada a alinhar.")); return; }

    const amostra = (s.itens || []).slice(0, 8)
      .map(function (i) { return "• " + i.descricao + ": " + i.de + " → " + i.para; })
      .join("\n");

    const texto = s.quantidade + " compra(s) do " + c.nome +
      " passam para o dia " + c.diaVencimento + ":\n\n" + amostra +
      (s.quantidade > 8 ? "\n... e mais " + (s.quantidade - 8) : "") +
      "\n\nTotal: " + formatarMoeda(s.total) + "\n\nConfirmar?";

    if (!confirm(texto)) return;

    const r = await chamarServidor("alinharVencimentosDoCartao", {
      cartao: c.nome, dia: c.diaVencimento
    });

    mostrarToast((r.ok ? "✅ " : "❌ ") + r.mensagem);
    if (r.ok) {
      limparTodoCache();
      await carregarCartoesConfig();
      await recarregarDados();
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

function alternarSecaoFixas() { abrirSubConfig("fixas"); }

async function carregarFixas() {
  const alvo = document.getElementById("cfg-fixas-lista");
  alvo.innerHTML = '<p class="vazio">Carregando...</p>';

  try {
    const r = await chamarServidor("listarFixas");
    fixasCarregadas = (r.ok && r.fixas) ? r.fixas : [];
  } catch (e) {
    alvo.innerHTML = '<p class="vazio">Sem conexão.</p>';
    return;
  }

  if (fixasCarregadas.length === 0) {
    alvo.innerHTML = '<p class="vazio">Nenhuma despesa fixa cadastrada.</p>';
    if (subConfigAberta === "fixas") dicaDoSubConfig("nenhuma cadastrada");
    return;
  }

  let total = 0;
  let html = "";

  fixasCarregadas.forEach(function (f, i) {
    total += f.valor || 0;
    html +=
      '<div class="cfg-item">' +
        '<span class="cfg-item-nome">' + escaparHtml(f.descricao) +
          '<span class="cfg-item-cod">dia ' + f.dia + ' · ' + escaparHtml(f.metodo || "sem método") + '</span>' +
        '</span>' +
        '<span class="sug-valor">' + formatarMoeda(f.valor) + '</span>' +
        '<button class="cfg-btn" title="Editar" onclick="abrirFormFixa(' + i + ')">✏️</button>' +
        '<button class="cfg-btn" title="Excluir" onclick="excluirFixaApp(' + i + ')">🗑️</button>' +
      '</div>';
  });

  alvo.innerHTML = html;

  // O resumo vai para o cabeçalho da sub-tela, onde serve para conferir sem
  // rolar até o fim da lista.
  if (subConfigAberta === "fixas") {
    dicaDoSubConfig(fixasCarregadas.length +
      (fixasCarregadas.length === 1 ? " cadastrada · " : " cadastradas · ") +
      formatarMoeda(total) + " por mês");
  }
}

/**
 * No cartão, o dia da fixa não decide nada: quem decide é a fatura.
 *
 * O campo some e fica valendo o DIA 15 por baixo -- um dia no meio do ciclo,
 * que é o que faz a fixa cair na fatura daquele mês em vez de escorregar para
 * a seguinte. Ele continua gravado porque é dele que sai a resposta de "em
 * qual fatura isto entra"; o que muda é não perguntar o que você não precisa
 * decidir.
 */
function ajustarCamposDaFixa() {
  const metodo = (document.getElementById("fix-metodo").value || "").toLowerCase();
  const ehCartao = metodo.indexOf("cart") >= 0;

  document.getElementById("fix-bloco-dia").style.display = ehCartao ? "none" : "block";
  document.getElementById("fix-bloco-fatura").style.display = ehCartao ? "block" : "none";

  if (ehCartao) {
    const campo = document.getElementById("fix-dia");
    if (!campo.value || parseInt(campo.value) < 1) campo.value = 15;
  }
}

function abrirFormFixa(indice) {
  const f = (indice !== undefined) ? fixasCarregadas[indice] : null;
  const form = document.getElementById("fix-form");
  form.classList.add("aberto");

  montarSelect("fix-metodo", (listasValidas && listasValidas.metodos) ? listasValidas.metodos : [],
               f ? f.metodo : "");
  definirCategoriaCampo("fix-categoria", f ? f.categoria : "");

  document.getElementById("fix-linha").value = f ? f.linha : "";
  document.getElementById("fix-desc").value = f ? f.descricao : "";
  document.getElementById("fix-valor").value = f ? f.valor : "";
  document.getElementById("fix-dia").value = f ? f.dia : "";
  document.getElementById("fix-juros").value = f ? (f.juros || "") : "";
  document.getElementById("fix-taxa").value = f && f.taxa ? f.taxa : "";
  document.getElementById("fix-periodo").value = f && f.periodo ? f.periodo : 12;
  document.getElementById("fix-desde").value = (f && f.desde) ? f.desde : dataHojeISO();
  alternarCamposJuros();
  // Depois de escolher o método: é ele que decide se o dia aparece.
  aplicarFormatoDaFixa();
  document.getElementById("fix-aviso").textContent = "";
}

// Mostra os campos de taxa só quando há correção, e adianta em texto o que a
// regra faz — juros composto sobre 3 anos surpreende quem só viu a taxa.
function alternarCamposJuros() {
  const tipo = document.getElementById("fix-juros").value;
  const bloco = document.getElementById("fix-bloco-juros");
  bloco.style.display = tipo ? "block" : "none";
  if (!tipo) return;

  const base = parseFloat(document.getElementById("fix-valor").value) || 0;
  const taxa = parseFloat(document.getElementById("fix-taxa").value) || 0;
  const periodo = parseInt(document.getElementById("fix-periodo").value) || 12;
  const previa = document.getElementById("fix-previa-juros");

  if (!base || !taxa) { previa.textContent = ""; return; }

  const t = taxa / 100;
  const depois = (tipo === "composto") ? base * Math.pow(1 + t, 3) : base * (1 + t * 3);
  previa.textContent = "Depois de 3 ciclos de " + periodo + " meses: " +
                       formatarMoeda(base) + " vira " + formatarMoeda(Math.round(depois * 100) / 100) + ".";
}

/** Chamado no fim de abrirFormFixa: o método já está escolhido aqui. */
function aplicarFormatoDaFixa() {
  try { ajustarCamposDaFixa(); } catch (e) {}
}

function fecharFormFixa() {
  document.getElementById("fix-form").classList.remove("aberto");
}

async function salvarFixaApp() {
  const aviso = document.getElementById("fix-aviso");
  const btn = document.getElementById("fix-btn-salvar");

  const descricao = document.getElementById("fix-desc").value.trim();
  const valor = document.getElementById("fix-valor").value;
  const categoria = document.getElementById("fix-categoria").value;

  if (!descricao) { aviso.textContent = "Informe a descrição."; return; }
  if (!valor || parseFloat(valor) <= 0) { aviso.textContent = "Informe o valor."; return; }
  if (!categoria) { aviso.textContent = "Escolha a categoria."; return; }

  btn.disabled = true;
  btn.textContent = "Salvando...";

  try {
    const r = await chamarServidor("salvarFixa", {
      linha: document.getElementById("fix-linha").value,
      descricao: descricao,
      valor: valor,
      dia: document.getElementById("fix-dia").value,
      metodo: document.getElementById("fix-metodo").value,
      categoria: categoria,
      juros: document.getElementById("fix-juros").value,
      taxa: document.getElementById("fix-taxa").value,
      periodo: document.getElementById("fix-periodo").value,
      desde: document.getElementById("fix-desde").value
    });

    if (r.ok) {
      fecharFormFixa();
      mostrarToast("✅ " + r.mensagem);
      await carregarFixas();
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

async function excluirFixaApp(indice) {
  const f = fixasCarregadas[indice];
  if (!f) return;
  if (!confirm("Excluir a despesa fixa?\n\n" + f.descricao +
               "\n\nOs lançamentos já feitos a partir dela não são afetados.")) return;

  try {
    const r = await chamarServidor("excluirFixa", { linha: f.linha });
    if (r.ok) { mostrarToast("✅ " + r.mensagem); await carregarFixas(); }
    else mostrarToast("❌ " + (r.mensagem || "Não foi possível excluir."));
  } catch (e) {
    mostrarToast("❌ Sem conexão.");
  }
}

async function gerarFixasApp() {
  const btn = document.getElementById("fix-btn-gerar");
  const mes = document.getElementById("fix-mes");
  const ano = document.getElementById("fix-ano");

  if (!confirm("Incluir as despesas fixas de " + MESES_NOMES[parseInt(mes.value)] +
               " de " + ano.value + "?\n\nElas vão para Aprovações. " +
               "O que já foi lançado nesse mês é ignorado.")) return;

  btn.disabled = true;
  btn.textContent = "...";

  try {
    // Pedido por você vai direto para Transações — conferir de novo em
    // Aprovações seria olhar duas vezes a mesma lista.
    const r = await chamarServidor("gerarFixasDoMes", {
      mes: mes.value, ano: ano.value, destino: "transacoes"
    });

    if (r.ok) {
      mostrarToast("✅ " + r.mensagem);
      limparTodoCache();
      await recarregarDados();
      checarPendentesAprovacao();
    } else if (r.erro === "NADA_A_GERAR" && (r.detalhe || []).length) {
      // Um toque de "já está tudo lançado" não dá para conferir: se a tela
      // pedir o lançamento e o servidor disser que já existe, um dos dois está
      // olhando a data errada, e sem ver ONDE não há como saber qual.
      const antigas = r.detalhe.filter(function (p) { return p.antiga; }).length;
      alert("Nada a gerar — cada uma já existe, nesta data:\n\n" +
            r.detalhe.map(function (p) {
              return "· " + p.descricao + " — " + p.data +
                     " (" + p.onde + (p.antiga ? ", data antiga" : "") + ")";
            }).join("\n") +
            (antigas
              ? "\n\n" + antigas + " está(ão) na data velha, de antes de as fixas de " +
                "cartão passarem a cair na fatura. Elas continuam aparecendo como " +
                "não lançadas na tela do mês. Use 'Pôr as fixas de cartão na data " +
                "da fatura' em Configurações → Cartões — simule antes."
              : ""));
    } else {
      mostrarToast("⚠️ " + (r.mensagem || "Nada foi gerado."));
    }
  } catch (e) {
    mostrarToast("❌ Sem conexão. Nada foi gerado.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Incluir";
  }
}

// ============================================================================
// SUB-TELAS DE CONFIGURAÇÕES
// ----------------------------------------------------------------------------
// Categorias, fixas e cartões abriam POR DENTRO da lista, cada uma empurrando
// as outras seções para fora da tela -- e para fechar era preciso rolar de
// volta e encontrar o mesmo botão que abriu. Agora a lista dá lugar a uma
// sub-tela com título próprio e seta de voltar.
//
// É UMA sub-tela só: o cabeçalho é o mesmo, o conteúdo troca. Três cabeçalhos
// iguais seriam três lugares para corrigir a mesma coisa.
// ============================================================================
let subConfigAberta = "";

function abrirSubConfig(qual) {
  const lista = document.getElementById("cfg-lista");
  const sub = document.getElementById("cfg-sub");
  const tit = document.getElementById("cfg-sub-tit");
  const add = document.getElementById("cfg-sub-add");
  if (!lista || !sub) return;

  ["categorias", "cartoes", "fixas"].forEach(function (n) {
    const el = document.getElementById("cfg-secao-" + n);
    if (el) el.style.display = (n === qual) ? "block" : "none";
  });

  subConfigAberta = qual;
  lista.style.display = "none";
  sub.style.display = "block";

  if (qual === "categorias") {
    tit.textContent = "Categorias";
    add.style.display = "";
    dicaDoSubConfig(contarCategorias()
      ? contarCategorias() + " no plano de contas"
      : "plano de contas");

  } else if (qual === "cartoes") {
    tit.textContent = "Cartões";
    // Cartão não se cria aqui: ele nasce de um lançamento. Um "+" que não
    // cria nada é pior do que nenhum.
    add.style.display = "none";
    dicaDoSubConfig("carregando...");
    carregarCartoesConfig();

  } else if (qual === "fixas") {
    tit.textContent = "Despesas fixas";
    add.style.display = "";
    dicaDoSubConfig("carregando...");

    // Os seletores de mês/ano só existem depois de abrir a seção. Começam no
    // mês que vem: fixa se lança para o ciclo seguinte.
    const hoje = new Date();
    const selMes = document.getElementById("fix-mes");
    if (selMes && !selMes.options.length) {
      selMes.innerHTML = opcoesMeses((hoje.getMonth() + 1) % 12);
      document.getElementById("fix-ano").innerHTML = opcoesAnos(hoje.getFullYear());
    }
    carregarFixas();
  }

  // Entrar já rolado no meio é o que faz parecer que o topo não existe.
  const caixa = sub.closest(".modal-caixa");
  if (caixa) caixa.scrollTop = 0;
}

function voltarDoSubConfig() {
  const lista = document.getElementById("cfg-lista");
  const sub = document.getElementById("cfg-sub");
  if (!lista || !sub) return;

  // Formulário meio preenchido não sobrevive à saída: reabrir e encontrar
  // dados de uma fixa que não foi salva é o caminho para salvar sem querer.
  fecharFormFixa();
  const nova = document.getElementById("cfg-nova");
  if (nova) nova.classList.remove("aberto");

  subConfigAberta = "";
  sub.style.display = "none";
  lista.style.display = "block";
  pintarDicasDeConfig();

  const caixa = lista.closest(".modal-caixa");
  if (caixa) caixa.scrollTop = 0;
}

/** O "+" do cabeçalho faz o que o botão de largura inteira fazia. */
function acaoDoSubConfig() {
  if (subConfigAberta === "categorias") alternarNovaCategoria();
  else if (subConfigAberta === "fixas") abrirFormFixa();
}

function dicaDoSubConfig(texto) {
  const el = document.getElementById("cfg-sub-dica");
  if (el) el.textContent = texto || "";
}

async function salvarLimiteApp() {
  const campo = document.getElementById("cfg-limite");
  try {
    const r = await chamarServidor("salvarLimiteDeGastos", { limite: campo.value.trim() });
    mostrarToast((r && r.mensagem) || "Pronto.");
    if (r && r.ok) {
      esquecerDominio("config");
      esquecerDominio("transacoes");   // o dashboard carrega o limite junto
      await recarregarDados();
    }
  } catch (e) {
    mostrarToast("Falhou: " + (e.message || "sem conexão"));
  }
}

/**
 * As quatro cores da barra do primeiro card, na mesma roda do grupo.
 *
 * As cores vivas do app entram como ponto de partida quando não há escolha
 * guardada: a roda precisa de um lugar para a bolinha, e começar tudo no
 * centro faria parecer que nada está definido.
 */
const CORES_BARRA_PADRAO = { pago: "#2b6cb0", pendente: "#c2703d",
                             fixas: "#c2703d", sobra: "#3f7a4e" };

function montarRodaDasCoresDaBarra() {
  if (!document.getElementById("cb-roda")) return;
  const C = (dashboardAtual && dashboardAtual.coresBarra) || {};

  montarRodaDeCor({
    ids: { alvos: "cb-alvos", roda: "cb-roda", knob: "cb-knob",
           escuro: "cb-roda-escuro", brilho: "cb-brilho" },
    alvos: [
      { chave: "pago",     rotulo: "Já pago",   cor: C.pago     || CORES_BARRA_PADRAO.pago },
      { chave: "pendente", rotulo: "A pagar",   cor: C.pendente || CORES_BARRA_PADRAO.pendente },
      { chave: "fixas",    rotulo: "Fixas",     cor: C.fixas    || CORES_BARRA_PADRAO.fixas },
      { chave: "sobra",    rotulo: "Sobra",     cor: C.sobra    || CORES_BARRA_PADRAO.sobra }
    ]
  });
}

async function salvarCoresDaBarraApp() {
  if (!roda) return;
  const params = {};
  roda.alvos.forEach(function (a) { params[a.chave] = a.cor || ""; });

  try {
    const r = await chamarServidor("salvarCoresDaBarra", params);
    if (!r || !r.ok) { alert((r && r.mensagem) || "Não deu para salvar."); return; }
    mostrarToast("✅ " + r.mensagem);
    esquecerDominio("config");
    esquecerDominio("transacoes");   // as cores viajam dentro do dashboard
    await recarregarDados();
  } catch (e) {
    alert("Falhou: " + (e.message || "sem conexão"));
  }
}

async function salvarCartaoValeApp() {
  const campo = document.getElementById("cfg-cartao-vale");
  try {
    const r = await chamarServidor("salvarLimiteDeGastos", { cartaoVale: campo.value });
    mostrarToast((r && r.mensagem) || "Pronto.");
    if (r && r.ok) {
      esquecerDominio("config");
      esquecerDominio("transacoes");   // o teto do mês é calculado no dashboard
      await recarregarDados();
    }
  } catch (e) {
    mostrarToast("Falhou: " + (e.message || "sem conexão"));
  }
}

function contarCategorias() {
  return (listasValidas && listasValidas.categorias) ? listasValidas.categorias.length : 0;
}

/**
 * Escreve o estado de cada fileira embaixo do nome dela.
 *
 * Só mostra número que já está na memória -- nenhuma destas linhas dispara
 * leitura do servidor. Abrir Configurações não deve custar cinco chamadas
 * para preencher legendas que ninguém pediu; o que ainda não foi carregado
 * fica com a descrição, e ganha o número quando a sub-tela abrir.
 */
function pintarDicasDeConfig() {
  // A roda das cores é montada toda vez que Configurações abre: ela guarda o
  // estado em `roda`, que o formulário de grupo também usa. Montar uma só vez,
  // no início, faria a segunda tela encontrar os alvos da primeira.
  montarRodaDasCoresDaBarra();

  function por(id, texto) {
    const el = document.getElementById(id);
    if (el && texto) el.textContent = texto;
  }

  const cats = contarCategorias();
  if (cats) por("cfg-dica-categorias", cats + " no plano de contas");

  // O limite vem do dashboard, que já está carregado.
  const campoLim = document.getElementById("cfg-limite");
  if (campoLim && dashboardAtual) {
    const L = dashboardAtual.limite;
    // O limiteBase, NUNCA o limite. O limite já vem com o crédito do vale
    // somado; pôr isso no campo faria o próximo "Salvar" gravar o teto mais o
    // vale como novo teto, e ele subiria de novo todo mês, sozinho.
    campoLim.value = L ? L.limiteBase : "";
  }

  // O seletor do cartão de benefício sai dos MÉTODOS, não da Config Cartões:
  // vale-alimentação não tem fechamento nem fatura, então ele não está lá --
  // mas é por método que a despesa e o crédito são lançados, e é o método que
  // precisa casar na hora de somar.
  const campoVale = document.getElementById("cfg-cartao-vale");
  if (campoVale) {
    const atual = (dashboardAtual && dashboardAtual.limite)
      ? (dashboardAtual.limite.cartaoVale || "") : "";
    const metodos = (listasValidas && listasValidas.metodos) ? listasValidas.metodos : [];

    // O guardado entra na lista mesmo que não esteja mais entre os métodos --
    // senão o <select> cairia calado em "nenhum" e o teto encolheria sem nada
    // dizendo que foi o app que trocou a escolha.
    const opcoes = metodos.slice();
    if (atual && opcoes.indexOf(atual) === -1) opcoes.push(atual);

    campoVale.innerHTML = '<option value="">nenhum</option>' +
      opcoes.map(function (m) {
        return '<option value="' + escaparHtml(m) + '">' + escaparHtml(m) + '</option>';
      }).join("");
    campoVale.value = atual;

    const nota = document.getElementById("cfg-vale-nota");
    const L = dashboardAtual && dashboardAtual.limite;
    if (nota && L && L.cartaoVale) {
      nota.innerHTML = (L.vale > 0
        ? "Entraram <b>" + formatarMoeda(L.vale) + "</b> neste mês, somados ao teto."
        : "<b>Nada entrou neste mês</b> — o teto fica só no valor de cima. " +
          "O crédito precisa estar lançado como receita neste método para ser contado.");
    }
  }

  // gruposCompletos vem do dashboard, que já carregou antes daqui.
  const g = (typeof gruposCompletos !== "undefined" ? gruposCompletos : []).length;
  por("cfg-dica-grupos", g
    ? g + (g === 1 ? " grupo" : " grupos") + " · mesadas e combinados"
    : "nenhum ainda · toque para criar");

  if (fixasCarregadas.length) {
    let soma = 0;
    fixasCarregadas.forEach(function (f) { soma += f.valor || 0; });
    por("cfg-dica-fixas", fixasCarregadas.length +
      (fixasCarregadas.length === 1 ? " cadastrada · " : " cadastradas · ") +
      formatarMoeda(soma) + " por mês");
  }

  if (cartoesConfig.length) {
    por("cfg-dica-cartoes", cartoesConfig.length +
      (cartoesConfig.length === 1 ? " cartão" : " cartões") + " · vencimento e limite");
  }
}

// Os nomes antigos continuam existindo: eram o que o HTML chamava, e podem
// estar em atalho ou teste em algum lugar.
function alternarSecaoCategorias() { abrirSubConfig("categorias"); }

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
  // No computador, a entrada é a escolha do módulo — não o Smartbalanço.
  // Numa tela grande dá para ver os quatro de uma vez; no celular isso seria
  // um toque a mais toda vez, e lá o menu do topo já resolve.
  if (abrirHubSeCouber()) return;

  // 1. Se houver cache deste mês, mostra IMEDIATAMENTE (sem esperar o servidor)
  const cache = lerCache(mesExibido, anoExibido);
  if (cache) {
    preencherDashboard(cache.dados);
    mostrarTelaInterna();
    mostrarAvisoAtualizando("Dados de " + tempoRelativo(cache.quando) + " · atualizando...");
  } else {
    mostrarCarregando("Carregando seus dados...");
  }

  // 2. Uma pergunta só: mudou alguma coisa? O que não mudou dispensa busca,
  //    nesta tela e em todas as outras que forem abertas depois.
  await sincronizarCarimbos();

  // 3. Checa aprovações pendentes em segundo plano (para mostrar o badge)
  checarPendentesAprovacao();

  // 4. O ano inteiro, atrás da tela. Depois disto, trocar de mês é instantâneo
  //    mesmo em mês nunca aberto.
  if (!precargaEstaEmDia()) {
    emSegundoPlano("Guardando 12 meses para frente e para trás...", preCarregarAno);
  }

  // 3. Busca os dados frescos (em segundo plano se o cache já apareceu)
  try {
    const lido = await lerDoServidor("dashboard", { mes: mesExibido, ano: anoExibido });
    const r = lido.dados;
    if (lido.ok) {
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
// SELETOR DE MÊS
// ----------------------------------------------------------------------------
// Chegar a um mês distante custava um toque por mês, e cada toque chamava
// recarregarDados(). De setembro a março do ano seguinte eram seis idas.
//
// A folha lê o que a PRÉ-CARGA já guardou: preCarregarAno() grava um
// dashboard inteiro por mês em localStorage, 12 para trás e 12 para frente.
// Por isso a lista sai com os valores de todos os meses sem UMA chamada de
// rede -- e abre igual sem internet.
// ============================================================================
let anoDoSeletor = null;

function abrirSeletorMeses() {
  anoDoSeletor = anoExibido;
  document.getElementById("modal-meses").style.display = "flex";
  pintarSeletorMeses();
}

function fecharSeletorMeses() {
  document.getElementById("modal-meses").style.display = "none";
}

function mudarAnoSeletor(delta) {
  anoDoSeletor += delta;
  pintarSeletorMeses();
}

/** Sem centavos: são doze números empilhados, e o centavo atrapalha varrer. */
function semCentavos(v) {
  return Math.round(v || 0).toLocaleString("pt-BR");
}

async function escolherMesDoSeletor(mes, ano) {
  fecharSeletorMeses();

  if (mes < 0) { await irParaMesAtual(); return; }
  if (mes === mesExibido && ano === anoExibido) return;

  mesExibido = mes;
  anoExibido = ano;
  await recarregarDados();
}

function pintarSeletorMeses() {
  const alvo = document.getElementById("sel-meses");
  if (!alvo) return;

  const hoje = new Date();
  const linhas = [];
  let maior = 0;
  let somaFechada = 0;
  let fechados = 0;

  for (let m = 0; m < 12; m++) {
    const c = lerCache(m, anoDoSeletor);
    if (!c) { linhas.push({ mes: m, tem: false }); continue; }

    const r = resumoDoMes(c.dados);
    linhas.push({ mes: m, tem: true, receita: r.receita, sobra: r.sobra, previsto: r.supondo });

    maior = Math.max(maior, Math.abs(r.sobra));
    if (!r.previsto && !r.supondo) { somaFechada += r.sobra; fechados++; }
  }

  // ---- o ano ----
  document.getElementById("sel-ano-num").textContent = anoDoSeletor;

  const total = document.getElementById("sel-ano-total");
  if (fechados > 0) {
    const cor = somaFechada >= 0 ? "var(--verde)" : "var(--vermelho)";
    // "em N meses fechados", e não "de janeiro a X": os meses guardados podem
    // ter buracos, e aí "de janeiro a" seria mentira sobre o que foi somado.
    total.innerHTML = (somaFechada >= 0 ? "sobrou " : "faltou ") +
      '<b style="color:' + cor + '">R$ ' + escaparHtml(semCentavos(Math.abs(somaFechada))) + '</b>' +
      " em " + fechados + (fechados === 1 ? " mês fechado" : " meses fechados");
  } else {
    total.textContent = "nenhum mês fechado neste ano";
  }

  // ---- os doze ----
  alvo.innerHTML = linhas.map(function (l) {
    const nome = MESES_NOMES[l.mes].slice(0, 3).toLowerCase();
    const aberto = (l.mes === mesExibido && anoDoSeletor === anoExibido);
    const eHoje = (l.mes === hoje.getMonth() && anoDoSeletor === hoje.getFullYear());
    const ir = 'onclick="escolherMesDoSeletor(' + l.mes + ',' + anoDoSeletor + ')"';

    // Fora dos 25 meses guardados o mês CONTINUA na lista, apagado e dizendo
    // que vai precisar de rede -- sumir daria a impressão de que o app só
    // tem dois anos de história.
    if (!l.tem) {
      return '<button type="button" class="sel-mes vazio" ' + ir + '>' +
        '<span class="sel-nome">' + nome + '</span>' +
        '<span class="sel-barra"></span>' +
        '<span class="sel-vl" style="font-size:10.5px; font-weight:600; color:var(--fraco-2)">' +
          'buscar<small>precisa de rede</small></span>' +
      '</button>';
    }

    // A barra compara com o MELHOR mês do ano, não com a receita: o que sobra
    // é uma fatia pequena do que entra, e contra a receita as doze barras
    // ficariam quase vazias e indistinguíveis entre si.
    const pct = maior > 0 ? Math.min(100, (Math.abs(l.sobra) / maior) * 100) : 0;
    const cor = l.sobra >= 0 ? "var(--verde)" : "var(--vermelho)";

    // Listrado para o que ainda não aconteceu: a mesma marca que a Projeção
    // Futura já usa. Cor chapada diria que o mês fechou assim.
    const tinta = l.previsto
      ? "background: repeating-linear-gradient(45deg, " + cor + " 0 3px, transparent 3px 6px);"
      : "background: " + cor + ";";

    const legenda = aberto
      ? ("aberto" + (eHoje ? " · hoje" : ""))
      : (l.previsto ? "previsto" : semCentavos(l.receita) + " entrou");

    return '<button type="button" class="sel-mes' + (aberto ? " aberto" : "") + '" ' + ir + '>' +
      '<span class="sel-nome">' + nome + '</span>' +
      '<span class="sel-barra"><span style="width:' + pct.toFixed(1) + '%; ' + tinta + '"></span></span>' +
      '<span class="sel-vl" style="color:' + (l.previsto ? "var(--cinza-texto)" : cor) + '">' +
        (l.previsto ? "≈ " : (l.sobra >= 0 ? "+ " : "− ")) + escaparHtml(semCentavos(Math.abs(l.sobra))) +
        '<small>' + escaparHtml(legenda) + '</small>' +
      '</span>' +
    '</button>';
  }).join("");
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

// Compara a versão que ESTA página carregou com a que o servidor serve agora.
//
// Existe porque o ↻ recarregava dados, não a página: depois de uma publicação
// que mexesse no HTML, apertá-lo não trazia a tela nova, e não havia nada no
// app que trouxesse. Quem só usa o aplicativo não tem "atualizar a página".
async function conferirPaginaNova() {
  try {
    const resp = await fetch("./index.html", { cache: "reload" });
    if (!resp.ok) return false;

    const html = await resp.text();
    const servida = (html.match(/app\.js\?v=(\d+)/) || [])[1];

    // A versão desta página está na própria tag que a carregou.
    const tag = document.querySelector('script[src*="app.js?v="]');
    const minha = tag ? (tag.getAttribute("src").match(/v=(\d+)/) || [])[1] : null;

    return !!(servida && minha && servida !== minha);
  } catch (e) {
    return false;   // sem rede: não é hora de falar de atualização
  }
}

/**
 * @param conferirOutrosAparelhos  Perguntar ao servidor se algo mudou fora
 *   daqui. Só o ↻ pede isso. Trocar de mês NÃO pede: as gravações feitas
 *   neste aparelho já apagam o cache sozinhas (pelo _carimbou da resposta), e
 *   uma conferida por mês visitado devolveria a espera que este recurso veio
 *   tirar.
 */
async function recarregarDados(conferirOutrosAparelhos) {
  // Antes dos dados: se a própria tela está velha, recarregar dados não
  // adianta — o que o usuário procura pode nem existir neste HTML.
  conferirPaginaNova().then(function (temNova) {
    if (!temNova) return;
    mostrarToastComAcaoGenerica("Há uma versão nova do app", "Atualizar", function () {
      location.reload();
    });
  });

  const btn = document.getElementById("btn-atualizar");
  if (btn) btn.classList.add("girando");

  // O ↻ é o único gesto que quer dizer "desconfie do que está na tela", e
  // por isso ele joga fora TUDO -- não basta reconferir os carimbos, porque
  // uma linha corrigida à mão na planilha não sobe carimbo nenhum. É
  // justamente essa a mudança que faz a pessoa apertar o botão.
  if (conferirOutrosAparelhos) {
    esquecerTudo();
    try { localStorage.removeItem(PRECARGA_MARCA); } catch (e) {}
    await sincronizarCarimbos();
    emSegundoPlano("Recarregando os 12 meses...", preCarregarAno);
  }

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
    // O mês pedido, guardado: se estiver suspeito, vem o guardado AGORA e o
    // certo chega alguns instantes depois, por aqui.
    // TUDO daqui para baixo se refere ao PEDIDO, nunca ao mês que está na tela
    // agora. Os dois são a mesma coisa só enquanto ninguém troca de mês -- e
    // trocar de mês com uma resposta no ar era exatamente o caso que
    // envenenava o cache: a resposta de setembro chegava depois do toque em
    // outubro e era gravada NA CHAVE DE OUTUBRO. A partir daí outubro
    // mostrava setembro para sempre, porque a cópia errada conta como fresca
    // e nunca mais era buscada.
    const pedido = { mes: mesExibido, ano: anoExibido };
    const aindaNoPedido = function () {
      return mesExibido === pedido.mes && anoExibido === pedido.ano;
    };

    const lido = await lerDoServidor("dashboard", pedido, function (novo) {
      // Guarda sempre no lugar certo; só PINTAR é que depende de a tela ainda
      // estar nesse mês.
      salvarCache(pedido.mes, pedido.ano, novo);
      if (!aindaNoPedido()) return;
      preencherDashboard(novo);
      mostrarAvisoAtualizando(null);
    });

    const r = lido.dados;
    if (lido.ok) {
      salvarCache(pedido.mes, pedido.ano, r);

      if (aindaNoPedido()) {
        preencherDashboard(r);
        mostrarAvisoAtualizando(lido.suspeito ? "conferindo..." : null);

        const hj = new Date();
        if (pedido.mes === hj.getMonth() && pedido.ano === hj.getFullYear()) {
          verificarContasEVNotificar(r).catch(function () {});
        } else {
          esconderAvisoVencimento();
        }
      }
    } else if (aindaNoPedido()) {
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
/**
 * O nome da categoria, sem o codigo.
 *
 * "2.3.009. Viagem de App" vira "Viagem de App". O codigo e chave de
 * planilha: nao diz nada na tela e ocupa a largura que o nome queria.
 *
 * Função única de propósito. A regra estava escrita duas vezes, e numa delas
 * as barras invertidas se perderam na edição: a expressão passou a procurar a
 * letra "d" em vez de um dígito, o que não casa com nada. E falha CALADA —
 * o código continuava aparecendo na tela e nada acusava.
 */
const CODIGO_DA_CATEGORIA = /^[\d.]+\s*/;

function nomeDaCategoria(cat) {
  const c = (cat || "").toString();
  return c.replace(CODIGO_DA_CATEGORIA, "") || c;
}

function formatarMoeda(valor) {
  if (isNaN(valor) || valor === null) return "R$ 0,00";
  return "R$ " + Number(valor).toFixed(2).replace(".", ",").replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1.");
}

function corDoScore(classificacao) {
  const c = (classificacao || "").toLowerCase();
  if (c.indexOf("excelente") !== -1) return "var(--verde)";
  if (c.indexOf("bom") !== -1) return "var(--laranja)";
  if (c.indexOf("aten") !== -1) return "var(--laranja)";
  return "var(--vermelho)";
}

function escaparHtml(txt) {
  const div = document.createElement("div");
  div.textContent = txt == null ? "" : String(txt);
  return div.innerHTML;
}

// ============================================================================
// PREENCHER DASHBOARD
// ============================================================================
/**
 * O resultado de um mês, a partir do dashboard dele.
 *
 * Mês futuro: a receita do mês base ainda não foi lançada, e o saldo do
 * servidor sai de uma receita ZERO -- o que faz um mês tranquilo aparecer
 * como "FALTA R$ 349". A última receita conhecida entra no lugar, e quem
 * mostra DIZ que está supondo: número supondo é útil, número errado não.
 *
 * Nesse caso prevê OS DOIS LADOS: a receita já entrava estimada, mas as
 * fixas ainda não lançadas ficavam de fora, e o número saía otimista por
 * exatamente o valor das contas que todo mundo sabe que vão chegar.
 *
 * No mês CORRENTE nada disso vale: lá o número é "o que sobra agora", e as
 * fixas que faltam moram no bloco de baixo do balanço.
 */
function resumoDoMes(d) {
  const s = (d && d.saldo) || {};
  const supondo = !(s.receitaBase > 0) && s.receitaPrevista > 0;
  const receita = s.receitaBase > 0 ? s.receitaBase : (s.receitaPrevista || 0);
  const fixasNaConta = supondo ? (s.fixasPrevistas || 0) : 0;

  return {
    s: s,
    supondo: supondo,
    receita: receita,
    despesas: s.despesas || 0,
    fixasNaConta: fixasNaConta,
    sobra: supondo ? (receita - (s.despesas || 0) - fixasNaConta) : (s.saldo || 0)
  };
}

/** O ultimo dashboard pintado. As fatias leem dele em vez de rebuscar. */
let dashboardAtual = null;

function preencherDashboard(d) {
  dashboardAtual = d;
  // "Setembro/2026" vira "Setembro 2026": a barra é o rótulo do mês, não um
  // caminho. A barra continua em d.mesReferencia, que outras partes partem.
  document.getElementById("mes-referencia").textContent =
    (d.mesReferencia || "").replace("/", " ");

  // O "Hoje" fica INVISÍVEL no mês corrente, não removido: com display:none
  // ele encolhia a linha e os três ícones de cima andavam de lugar conforme
  // o mês aberto -- o alvo de Configurações mudava de posição.
  const hojeM = new Date().getMonth();
  const hojeA = new Date().getFullYear();
  const btnHoje = document.getElementById("btn-hoje");
  btnHoje.style.visibility = (d.mes === hojeM && d.ano === hojeA) ? "hidden" : "visible";

  // ---- SALDO (base = receita do mês anterior) ----
  const r = resumoDoMes(d);
  const s = r.s;
  const supondo = r.supondo;
  const receitaDaConta = r.receita;
  const fixasNaConta = r.fixasNaConta;
  const sobraReal = r.sobra;

  const elSaldo = document.getElementById("saldo-valor");
  const elSegundo = document.getElementById("saldo-segundo");
  const L = d.limite;

  if (L) {
    // COM LIMITE, ele é o número grande -- é a pergunta que você faz todo
    // dia. A sobra da receita não sai da tela: desce um degrau. Destacar é
    // mudar a ordem, não esconder.
    elSaldo.textContent = (L.estourou ? "− " : "") + formatarMoeda(Math.abs(L.sobra));
    elSaldo.style.color = L.estourou ? "var(--vermelho)" : "var(--verde)";

    // "Real:" e o sinal fazem o trabalho que as palavras faziam. Negativo
    // sai com menos e em vermelho, positivo em verde -- a mesma convenção do
    // número grande logo acima, para os dois se lerem juntos sem traduzir.
    elSegundo.style.display = "block";
    elSegundo.innerHTML = 'Real: <b style="color:' +
      (sobraReal < 0 ? "var(--vermelho)" : "var(--verde)") + '">' +
      (sobraReal < 0 ? "− " : "") + (supondo ? "≈ " : "") +
      formatarMoeda(Math.abs(sobraReal)) + "</b>";
  } else {
    elSaldo.textContent = (supondo ? "≈ " : "") + formatarMoeda(sobraReal);
    elSaldo.style.color = (sobraReal >= 0) ? "var(--verde)" : "var(--vermelho)";
    elSegundo.style.display = "none";
  }

  const ds = d.despesasStatus || {};
  pintarBarraDoSaldo(d, s, ds, supondo, receitaDaConta, sobraReal, fixasNaConta);
  pintarPrevisto(d, s, receitaDaConta, fixasNaConta > 0);

  document.getElementById("saldo-rotulo").textContent = d.limite
    ? (d.limite.estourou ? "PASSOU DO LIMITE EM " : "AINDA CABE NO LIMITE DE ") +
      (d.mesReferencia || "").split("/")[0].toUpperCase()
    : (sobraReal >= 0 ? (supondo ? "SOBRA PREVISTA EM " : "SOBRA EM ") : "FALTA EM ") +
      (d.mesReferencia || "").split("/")[0].toUpperCase();

  // A explicação virou um link de uma linha. O texto inteiro continua
  // existindo, atrás de um toque -- ele importa uma vez, não toda abertura.
  explicandoSuposicao = supondo;
  document.getElementById("aviso-base").textContent = supondo
    ? "supondo a última receita conhecida · por quê?"
    : "conta o que já saiu da conta · como assim?";

  // Só aparece quando há receita recebida. "R$ 0,00" todo mês, no rodapé de
  // um card, é uma linha que nunca diz nada -- e ela sobrava justamente no
  // começo do mês, quando a tela já está cheia de número.
  const elReceita = document.getElementById("receita-mes-atual");
  if (s.receitaDoMes > 0) {
    elReceita.style.display = "block";
    elReceita.textContent =
      "Já entrou em " + (d.mesReferencia || "") + ": " + formatarMoeda(s.receitaDoMes);
  } else {
    elReceita.style.display = "none";
  }

  // ---- SCORE ----
  const sc = d.score || {};
  const cor = corDoScore(sc.classificacao);
  document.getElementById("score-valor").textContent = (sc.valor != null ? sc.valor : "-") + "/100";
  document.getElementById("score-valor").style.color = cor;
  document.getElementById("score-classificacao").textContent = sc.classificacao || "";
  document.getElementById("score-classificacao").style.color = cor;
  document.getElementById("score-barra-preenchida").style.width = (sc.valor || 0) + "%";
  document.getElementById("score-barra-preenchida").style.background = cor;
  pintarMetricasDoScore(sc.metricas || []);
  pintarTendenciaDoScore(d, sc);

  pintarGruposDeSaldo(d);
  pintarRitmo(d);
  pintarAvisoVencidas(d);

  // ---- CONTAS A VENCER ----
  const listaVencer = document.getElementById("lista-vencer");
  listaVencer.innerHTML = "";
  if (!d.contasAVencer || d.contasAVencer.length === 0) {
    listaVencer.innerHTML = '<p class="vazio">✅ Nenhuma conta a vencer nos próximos 15 dias.</p>';
  } else {
    faturasNaTela = [];

    d.contasAVencer.forEach(function (c) {
      const item = document.createElement("div");
      // Vencida ganha faixa vermelha: é a que exige ação hoje, e antes ela
      // simplesmente não aparecia nesta lista.
      item.className = "linha-item" + (c.diasVencida > 0 ? " vencida" : "");

      const selo = c.diasVencida > 0
        ? '<span class="selo-vencida">' +
          (c.diasVencida === 1 ? "venceu ontem" : "vencida há " + c.diasVencida + " dias") +
          '</span>'
        : "";

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
          chipDeData(c.data) +
          '<div class="li-corpo">' +
            '<div class="li-l1">' +
              '<span class="li-nome">💳 ' + escaparHtml(c.descricao) + selo + '</span>' +
              '<span class="li-valor vermelho">' + formatarMoeda(c.valor) + '</span>' +
            '</div>' +
            '<div class="li-l2">' +
              '<span class="li-mov fatura-toggle" onclick="alternarItensFatura(\'' + idItens + '\', this)">' +
                (c.itens || []).length + ' compras · ver' +
              '</span>' +
              '<button class="btn-liquidar" onclick="liquidarFaturaNaTela(' + iFatura + ')">Liquidar</button>' +
            '</div>' +
            '<div class="fatura-itens" id="' + idItens + '">' + htmlItens + '</div>' +
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
        chipDeData(c.data) +
        '<div class="li-corpo">' +
          '<div class="li-l1">' +
            '<span class="li-nome">' + escaparHtml(c.descricao) + selo + '</span>' +
            '<span class="li-valor vermelho">' + formatarMoeda(c.valor) + '</span>' +
          '</div>' +
          '<div class="li-l2">' +
            '<span class="li-mov">MOV-' + c.numMov + '</span>' +
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
      // O código da categoria ("2.3.007.") sai da tela. Ele é chave de
      // planilha, não nome de gasto -- e ocupava a largura que o nome queria.
      const nome = nomeDaCategoria(c.categoria);

      // Variacao que arredonda para zero vira "igual". Uma seta para cima com
      // 0% ao lado e pior que nao mostrar nada: aponta uma mudanca que nao houve.
      let variacao = "";
      if (c.variacao !== null && c.variacao !== undefined) {
        variacao = (Math.abs(c.variacao) < 1)
          ? '<span class="cat-peso">igual ao mês passado</span>'
          : '<span class="cat-var ' + (c.variacao > 0 ? "subiu" : "caiu") + '">' +
              (c.variacao > 0 ? "▲" : "▼") + " " +
              Math.abs(c.variacao).toFixed(0) + "%</span>";
      }

      // A categoria abre a busca já filtrada nela e no mês exibido. Antes era
      // texto morto: você via "Viagens R$ 887" e tinha de ir à busca montar o
      // filtro na mão para descobrir o que era.
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");
      item.className = "cat-item cat-tocavel";
      item.onclick = function () { abrirBuscaPorCategoria(c.categoria); };
      item.onkeydown = function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); item.onclick(); }
      };

      item.innerHTML =
        '<div class="cat-topo"><span class="cat-nome">' + escaparHtml(nome) + '</span>' +
        '<span class="cat-valor">' + formatarMoeda(c.valor) + '</span></div>' +
        '<div class="cat-barra"><div class="cat-barra-preenchida" style="width:' + pct + '%"></div></div>' +
        '<div class="cat-meta">' +
          '<span class="cat-peso">' + (c.peso || 0).toFixed(0) + '% do mês</span>' +
          variacao +
        '</div>';
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
        '</div>' +
        blocoDeLimite(c);
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
      // Pago e pendente viram uma barra, não dois emojis.
      //
      // O "⏳ pendente" dizia que havia algo a pagar e escondia QUANTO -- e
      // quando havia os dois, a linha virava uma fileira de emoji com dois
      // valores. A barra responde as duas coisas de uma vez.
      const pctPago = m.total > 0 ? (m.pago / m.total) * 100 : 0;

      let statusTxt =
        '<div class="om-barra">' +
          (m.pago > 0 ? '<span style="width:' + pctPago + '%; background:var(--verde)"></span>' : '') +
          (m.pendente > 0 ? '<span style="flex-grow:1; background:var(--laranja)"></span>' : '') +
        '</div>' +
        '<div class="om-status">' +
          (m.pago > 0 ? '<span><i class="om-pt" style="background:var(--verde)"></i>' +
            formatarMoeda(m.pago) + ' pago</span>' : '') +
          (m.pendente > 0 ? '<span><i class="om-pt" style="background:var(--laranja)"></i>' +
            formatarMoeda(m.pendente) + ' a pagar</span>' : '') +
        '</div>';

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

// Rede de segurança: se este navegador está restrito ao Smarttrabalho, a tela
// de login diz isso e oferece a saída. Sem este aviso, ficar preso parece
// falta de acesso da conta — que é exatamente o que aconteceu.
function mostrarAvisoModoRestrito() {
  const alvo = document.getElementById("tela-login");
  if (!alvo || !soTrabalho()) return;
  if (document.getElementById("aviso-modo-restrito")) return;

  const div = document.createElement("div");
  div.id = "aviso-modo-restrito";
  div.className = "cfg-aviso";
  div.style.cssText = "max-width:320px;margin:14px auto 0;text-align:center;";
  div.innerHTML =
    'Este navegador está no modo <b>só Smarttrabalho</b>. ' +
    '<a href="?modo=completo" style="color:var(--azul);font-weight:700;">Voltar ao app completo</a>';

  const rodape = alvo.querySelector(".rodape-login");
  alvo.insertBefore(div, rodape || null);
}

let preparandoLoginGoogle = false;

function mostrarTelaLogin() {
  mostrarAvisoModoRestrito();
  document.getElementById("tela-carregando").style.display = "none";
  document.getElementById("tela-interna").style.display = "none";
  document.getElementById("tela-login").style.display = "flex";
  const b = document.getElementById("btn-nova-despesa");
  if (b) b.style.display = "none";

  // Garante o botão do Google. Quem o desenha é prepararLoginGoogle(), mas os
  // caminhos de erro (sessão inválida, sem autorização) chamavam esta tela
  // direto — e ela aparecia SEM botão nenhum, sem como entrar.
  // O guard existe porque prepararLoginGoogle() termina chamando esta função.
  const alvo = document.getElementById("botao-google");
  if (alvo && !alvo.innerHTML.trim() && !preparandoLoginGoogle) {
    preparandoLoginGoogle = true;
    try { prepararLoginGoogle(); } catch (e) {}
    preparandoLoginGoogle = false;
  }
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
    'height:100vh;text-align:center;padding:24px;background:#e8ecf3;color:var(--texto);">' +
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
    // Vem do widget do microfone: abre direto a conversa, sem passar pelo menu.
    "voz": function () { quandoTelaPronta(function () { abrirLancarFalando(); }); },
    // Vem do aviso "Anotei: R$ ..." do leitor de notificações.
    "capturadas": function () { quandoTelaPronta(function () { abrirComprasCapturadas(); }); },
    "novo": function () { abrirMenuAdicionarQuandoPronto(); },
    "chat": function () { quandoTelaPronta(function () { trocarAba("chat"); }); },
    "busca": function () { quandoTelaPronta(function () { trocarAba("busca"); abrirBusca(); }); },
    "aprovacoes": function () { quandoTelaPronta(function () { trocarAba("aprovacoes"); }); },
    "relatorios": function () { quandoTelaPronta(function () { trocarAba("relatorios"); }); },
    "calendario": function () { quandoTelaPronta(function () { abrirCalendario(); }); },
    "tarefas": function () { quandoTelaPronta(function () { trocarAba("tarefas"); }); }
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
      aplicarRestricaoDaConta(r);
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

// ============================================================================
// CÓDIGO DE ACESSO
// ----------------------------------------------------------------------------
// Este código é a chave da conta: é o que se cola na tela de entrada do
// aplicativo para entrar. Ele ficava impresso por extenso em Configurações,
// sempre, na mesma rolagem em que se troca o tema -- bastava alguém olhar o
// celular na sua mão para levar a conta.
//
// Agora a linha fica fechada, dizendo o que aquilo é, e o código só aparece
// depois de um toque. Some sozinho: quem revela para copiar não volta para
// esconder, e um código revelado esquecido na tela é o mesmo problema de antes.
// ============================================================================
const CODIGO_SEGUNDOS = 30;
let cfgCodigoRelogio = null;

function montarCodigoAcesso() {
  const alvo = document.getElementById("cfg-codigo");
  if (!alvo) return;

  if (cfgCodigoRelogio) { clearInterval(cfgCodigoRelogio); cfgCodigoRelogio = null; }

  if (!sessaoAtual) {
    alvo.innerHTML =
      '<div class="cfg-lin cfg-lin-estatica"><span class="cfg-lin-txt">' +
        '<span class="cfg-lin-tit">Código de acesso</span>' +
        '<span class="cfg-lin-sub">sem sessão ativa</span>' +
      '</span></div>';
    return;
  }

  alvo.innerHTML =
    '<button type="button" class="cfg-lin" onclick="mostrarCodigoAcesso()">' +
      '<span class="cfg-lin-txt">' +
        '<span class="cfg-lin-tit">Código de acesso</span>' +
        '<span class="cfg-lin-sub alerta">quem tiver este código entra na sua conta</span>' +
      '</span>' +
      '<span class="cfg-lin-acao">Mostrar</span>' +
    '</button>';
}

function mostrarCodigoAcesso() {
  const alvo = document.getElementById("cfg-codigo");
  if (!alvo || !sessaoAtual) return;

  alvo.innerHTML =
    '<div class="cfg-codigo-bloco">' +
      '<div class="cfg-codigo-topo">' +
        '<span class="cfg-lin-tit">Código de acesso</span>' +
        '<span class="cfg-codigo-conta" id="cfg-codigo-conta"></span>' +
      '</div>' +
      '<div class="cfg-codigo-caixa" id="cfg-codigo-txt">' + escaparHtml(sessaoAtual) + '</div>' +
      '<div class="cfg-codigo-acoes">' +
        '<button type="button" class="btn-modal confirmar" onclick="copiarCodigoAcesso()">Copiar</button>' +
        '<button type="button" class="btn-modal cancelar" onclick="montarCodigoAcesso()">Esconder</button>' +
      '</div>' +
    '</div>';

  let resta = CODIGO_SEGUNDOS;
  const conta = document.getElementById("cfg-codigo-conta");
  conta.textContent = "esconde em 0:" + CODIGO_SEGUNDOS;

  if (cfgCodigoRelogio) clearInterval(cfgCodigoRelogio);
  cfgCodigoRelogio = setInterval(function () {
    // O bloco pode ter saído da tela por outro caminho (Esconder, fechar o
    // modal, sair da conta). Sem esta checagem o relógio continuaria correndo
    // e redesenharia um pedaço de tela que não está mais lá.
    if (!document.getElementById("cfg-codigo-txt")) {
      clearInterval(cfgCodigoRelogio); cfgCodigoRelogio = null; return;
    }
    resta--;
    if (resta <= 0) { montarCodigoAcesso(); return; }
    const el = document.getElementById("cfg-codigo-conta");
    if (el) el.textContent = "esconde em 0:" + (resta < 10 ? "0" : "") + resta;
  }, 1000);
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

  // Saída manual: qualquer credencial velha guardada neste aparelho pode estar
  // atrapalhando o login novo. O botão apaga tudo e recomeça do zero.
  if (!document.getElementById("btn-limpar-acesso")) {
    const b = document.createElement("button");
    b.id = "btn-limpar-acesso";
    b.textContent = "Limpar dados de acesso e tentar de novo";
    b.style.cssText = "display:block;margin:12px auto 0;background:none;border:none;" +
                      "color:var(--cinza-texto);font-size:12px;font-family:inherit;" +
                      "text-decoration:underline;cursor:pointer;";
    b.onclick = function () {
      try {
        apagarSessao();
        localStorage.removeItem(MODO_CHAVE);
      } catch (e) {}
      sessaoAtual = null;
      tokenLoginAtual = null;
      emailUsuarioAtual = null;
      location.href = location.pathname + "?modo=completo";
    };
    el.parentNode.insertBefore(b, el.nextSibling);
  }
}

function mostrarTelaInterna() {
  document.getElementById("tela-carregando").style.display = "none";
  document.getElementById("tela-login").style.display = "none";
  document.getElementById("tela-config-bloqueio").style.display = "none";
  document.getElementById("tela-interna").style.display = "block";

  if (soTrabalho()) { aplicarModoSoTrabalho(); return; }

  // Aqui, e não no load: a sessão já está em mãos. Antes isto rodava antes do
  // login resolver, e o envio das compras capturadas ia sem credencial.
  if (!capturadasJaVerificadas) {
    capturadasJaVerificadas = true;
    verificarComprasCapturadas();
  }

  // O widget é alimentado aqui pelo mesmo motivo das compras capturadas: a
  // sessão já está em mãos, e é ela que o widget precisa guardar.
  alimentarWidgetCalendario();

  // 👉 Os dois botões flutuantes só aparecem no dashboard
  const noDash = (abaAtiva === "dashboard");
  document.getElementById("btn-nova-despesa").style.display = noDash ? "flex" : "none";

  const btnIA = document.getElementById("btn-chat-ia");
  if (btnIA) btnIA.style.display = noDash ? "flex" : "none";
}

// ============================================================================
// MENU DE MÓDULOS (o "hub")
// ----------------------------------------------------------------------------
// Tela inicial no computador: os quatro Smarts lado a lado. O que a conta não
// alcança aparece com cadeado em vez de sumir — saber que existe e está
// fechado é informação; um menu que muda de tamanho conforme quem entra
// confunde mais do que esconde.
// ============================================================================
const MODULOS = [
  { id: "balanco",    icone: "💰", nome: "Smartbalanço",   desc: "Contas, cartões e relatórios" },
  { id: "calendario", icone: "📅", nome: "Smartcalendário", desc: "Compromissos e vencimentos" },
  { id: "tarefas",    icone: "✅", nome: "Smarttarefas",    desc: "Tarefas, lembretes e ideias" },
  { id: "trabalho",   icone: "💼", nome: "Smarttrabalho",   desc: "Balancetes dos condomínios" }
];

function moduloLiberado(id) {
  return soTrabalho() ? (id === "trabalho") : true;
}

// Só no computador: no celular o hub viraria um toque a mais em toda abertura.
function abrirHubSeCouber() {
  if (!window.matchMedia("(min-width: 900px)").matches) return false;
  mostrarTelaInterna();
  trocarAba("modulos");
  return true;
}

function renderizarModulos() {
  const alvo = document.getElementById("modulos-grid");
  if (!alvo) return;

  const restrita = soTrabalho();
  document.getElementById("modulos-aviso").textContent = restrita
    ? "Esta conta tem acesso apenas ao Smarttrabalho."
    : "";

  alvo.innerHTML = MODULOS.map(function (m) {
    const livre = moduloLiberado(m.id);
    return '<button class="modulo-card' + (livre ? "" : " trancado") + '" ' +
             (livre ? 'onclick="abrirModulo(\'' + m.id + '\')"' : 'disabled') + '>' +
             '<div class="modulo-icone">' + m.icone + '</div>' +
             '<div class="modulo-nome">' + m.nome + '</div>' +
             '<div class="modulo-desc">' + m.desc + '</div>' +
             (livre ? '' : '<div class="modulo-cadeado">🔒 Sem acesso</div>') +
           '</button>';
  }).join("");
}

function abrirModulo(id) {
  if (!moduloLiberado(id)) return;

  if (id === "balanco") trocarAba("dashboard");
  else if (id === "calendario") abrirCalendario();
  else if (id === "tarefas") trocarAba("tarefas");
  else if (id === "trabalho") abrirTrabalho();
}

function voltarAosModulos() {
  const menu = document.getElementById("menu-produtos");
  if (menu) menu.classList.remove("aberto");
  trocarAba("modulos");
}

// ============================================================================
// MODO "SÓ TRABALHO"
// ----------------------------------------------------------------------------
// Para o PC do escritório: abrindo com ?modo=trabalho, este navegador passa a
// mostrar SÓ o Smarttrabalho — sem finanças pessoais, sem tarefas, sem agenda.
//
// A escolha fica gravada NESTE navegador, não na URL: se ficasse só na URL,
// bastaria alguém abrir o endereço normal para ver tudo. Para voltar ao app
// completo é preciso abrir com ?modo=completo de propósito.
//
// Limite honesto: isto é separação de TELA, não de permissão. A sessão é a
// mesma e o servidor continua respondendo a tudo — quem abrir as ferramentas
// do desenvolvedor alcança o resto. Serve para o colega que senta na sua mesa,
// não contra alguém tentando bisbilhotar de verdade.
// ============================================================================
const MODO_CHAVE = "smart_modo";

function soTrabalho() {
  try {
    const m = localStorage.getItem(MODO_CHAVE);
    return m === "trabalho" || m === "conta";
  } catch (e) { return false; }
}

// A conta do escritório se restringe sozinha, sem depender do link: o servidor
// avisa no login e o app se ajusta.
//
// São DOIS modos gravados, e a diferença importa: "trabalho" você ligou de
// propósito pelo link e só sai pelo link; "conta" acompanha quem está logado
// e sai sozinho ao entrar com a conta pessoal.
//
// Antes isto só ligava, nunca desligava — então uma única entrada com a conta
// do escritório deixava o navegador restrito para sempre, inclusive para você.
// A trava que vale é a do servidor; esta aqui é conforto de tela.
function aplicarRestricaoDaConta(resposta) {
  try {
    const atual = localStorage.getItem(MODO_CHAVE);
    if (atual === "trabalho") return;   // escolha manual, não se mexe

    if (resposta && resposta.soTrabalho) localStorage.setItem(MODO_CHAVE, "conta");
    else if (atual === "conta") localStorage.removeItem(MODO_CHAVE);
  } catch (e) {}
}

// Roda antes do login: a URL manda, e o que ela disser fica guardado.
function lerModoDaURL() {
  try {
    const m = new URLSearchParams(location.search).get("modo");
    if (m === "trabalho") localStorage.setItem(MODO_CHAVE, "trabalho");
    else if (m === "completo") localStorage.removeItem(MODO_CHAVE);
  } catch (e) {}
}

function aplicarModoSoTrabalho() {
  // Some tudo que leva aos outros módulos.
  ["btn-nova-despesa", "btn-chat-ia", "btn-buscar", "btn-hoje", "btn-config",
   "nav-mes-wrap", "abas-principais", "menu-produtos"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  // O título deixa de ser botão: não há para onde ir.
  const topo = document.getElementById("titulo-topo");
  if (topo) {
    topo.onclick = null;
    topo.style.pointerEvents = "none";
    const seta = topo.querySelector(".seta-produtos");
    if (seta) seta.style.display = "none";
  }

  // O menu do topo some, então o "‹" é o único caminho de volta ao hub — que
  // nesta conta serve para ver o que existe e está trancado.
  const voltar = document.getElementById("btn-voltar");
  if (voltar) {
    voltar.onclick = voltarAosModulos;
    voltar.style.display = (abaAtiva === "trabalho") ? "inline-block" : "none";
  }

  if (abaAtiva !== "trabalho" && abaAtiva !== "modulos") abrirTrabalho();
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
  // Antes de tudo: ?modo=trabalho decide se este navegador vê só o
  // Smarttrabalho. Precisa vir cedo, senão o dashboard pisca na tela.
  lerModoDaURL();

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
  verificarDocumentoCompartilhado();

  // Com o app já aberto, o compartilhamento chega pelo onNewIntent do
  // Android e esta página não recarrega — só descobre ao voltar à tona.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) verificarDocumentoCompartilhado();
  });

  // ---------- 1. Já tem sessão salva no aparelho? ----------
  const salva = lerSessaoSalva();

  // Este navegador foi aberto PELO aplicativo só para logar. Se já existe
  // sessão aqui, aproveita — mas só depois de CONFERIR se ela ainda vale.
  //
  // Devolver sem conferir criava um beco sem saída: o navegador entregava uma
  // sessão morta em milissegundos, o app a recusava, e a tentativa seguinte
  // repetia exatamente o mesmo caminho. Parecia que a conta tinha perdido o
  // acesso; na verdade o login de verdade nunca chegava a acontecer.
  if (ehLoginParaAplicativo() && salva.sessao) {
    sessaoAtual = salva.sessao;
    let vale = false;

    try {
      const r = await chamarServidor("login");
      if (r.ok && r.sessao) { devolverSessaoAoAplicativo(r.sessao); return; }
      vale = false;
    } catch (e) {
      // Sem rede não dá para afirmar que a sessão morreu; devolve e deixa o
      // app decidir, que é o comportamento antigo.
      devolverSessaoAoAplicativo(salva.sessao);
      return;
    }

    if (!vale) {
      apagarSessao();
      sessaoAtual = null;
      emailUsuarioAtual = null;
      // Segue para o login normal, com o botão do Google.
    }
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
      aplicarRestricaoDaConta(r);
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

    // A biblioteca do Google falhou (rede, bloqueio, script fora do ar). Sem
    // isto o espaço do botão fica VAZIO e não há como entrar — foi assim que
    // a tela apareceu só com a mensagem de erro.
    const alvo = document.getElementById("botao-google");
    if (alvo && !alvo.innerHTML.trim()) {
      alvo.innerHTML =
        '<button id="btn-google-app" onclick="location.reload()">' +
          'Recarregar para entrar com Google' +
        '</button>' +
        '<div class="cfg-aviso" style="margin-top:8px;">' +
          'O login do Google não carregou. Recarregue, ou use o código de acesso.' +
        '</div>';
    }
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
  // Anexo da liquidação anterior não pode vazar para esta — a não ser que o
  // arquivo tenha vindo de um compartilhamento, que é justamente para ser
  // usado na despesa que está sendo escolhida agora.
  if (comprovanteVeioDeFora) mostrarComprovantePendente();
  else limparComprovanteLiquidacao();
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
        const rl = await lerCacheado("listasValidas");
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
// Comprovante que veio de um compartilhamento: sobrevive à abertura da tela
// de liquidação, que normalmente zera o anexo da vez anterior.
let comprovanteVeioDeFora = false;

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
  comprovanteVeioDeFora = false;
  const campo = document.getElementById("liq-arquivo");
  const rotulo = document.getElementById("liq-arquivo-nome");
  if (campo) campo.value = "";
  if (rotulo) rotulo.textContent = "Anexar comprovante";
}

// Mostra no botão o arquivo que já está em mãos (veio compartilhado)
function mostrarComprovantePendente() {
  const rotulo = document.getElementById("liq-arquivo-nome");
  if (rotulo && comprovanteLiquidacao) {
    rotulo.textContent = "📎 " + comprovanteLiquidacao.nome;
    rotulo.classList.remove("vazio-cat");
  }
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
  // textContent limpa o botão que a versão com "Editar" possa ter deixado.
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
  carregarSugestoesDescricao();
  const modal = document.getElementById("modal-despesa");
  modal.style.display = "flex";
  document.getElementById("nd-erro").style.display = "none";
  document.getElementById("nd-form").style.display = "block";
  document.getElementById("nd-confirmacao").style.display = "none";

  // Carrega listas (categoria/método) se ainda não tiver
  if (!listasValidas) {
    document.getElementById("nd-form").style.opacity = "0.5";
    try {
      const rl = await lerCacheado("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) {
      listasValidas = { categorias: [], metodos: [] };
    }
    document.getElementById("nd-form").style.opacity = "1";
  }

  // Preenche os campos
  montarSelect("nd-metodo", listasValidas ? listasValidas.metodos : [], "");
  definirCategoriaCampo("nd-categoria", "");

  // Grupo zerado a cada abertura: herdar a escolha do lancamento anterior
  // poria uma compra qualquer numa mesada sem ninguem pedir.
  document.getElementById("nd-grupo").value = "";
  document.getElementById("nd-grupo").removeAttribute("data-manual");
  document.getElementById("nd-grupo-dica").textContent = "";
  pintarChipsDeGrupo("nd");

  // Limpa/reseta os campos
  const hoje = dataHojeISO();
  document.getElementById("nd-descricao").value = "";
  document.getElementById("nd-valor").value = "";
  document.getElementById("nd-datacompra").value = hoje;
  document.getElementById("nd-parcelas").value = "1";
  document.getElementById("nd-vencimento").value = hoje;
  document.getElementById("nd-chk-pago").checked = false;
  document.getElementById("nd-datapgto").value = hoje;

  // Limpa o aviso de cópia: sem isso, abrir "nova despesa" depois de duplicar
  // ainda diria que é cópia de outro lançamento.
  const avisoND = document.getElementById("nd-aviso");
  if (avisoND) avisoND.textContent = "";

  atualizarCamposDespesa();
}

function dataHojeISO() {
  const h = new Date();
  return h.getFullYear() + "-" + ("0" + (h.getMonth() + 1)).slice(-2) + "-" + ("0" + h.getDate()).slice(-2);
}

// ============================================================================
// MELHORAR O PRÉ-LANÇAMENTO COM A FOTO DO COMPROVANTE
// ----------------------------------------------------------------------------
// A notificação do banco dá valor e estabelecimento — nada mais. A foto do
// comprovante tem o resto: itens, forma de pagamento, às vezes o CNPJ. Aqui
// ela passa pelo mesmo OCR + IA da leitura de documento, e o que voltar
// preenche o pré-lançamento.
//
// O valor lido da notificação PREVALECE sobre o da foto: ele veio do banco,
// que é a fonte do que foi realmente cobrado. A foto entra para melhorar
// descrição e categoria, não para corrigir o que já é certo.
// ============================================================================
let preLancamentoAlvo = null;

function anexarFotoAoPreLancamento(chave) {
  preLancamentoAlvo = chave;

  const inp = document.getElementById("pre-foto-arquivo");
  if (inp) { inp.value = ""; inp.click(); }
}

async function processarFotoDoPreLancamento(input) {
  const arq = input.files && input.files[0];
  if (!arq || !preLancamentoAlvo) return;

  const grupo = gruposAprovacao.filter(function (g) { return g.chave === preLancamentoAlvo; })[0];
  if (!grupo) return;

  if (arq.size > 6 * 1024 * 1024) {
    mostrarToast("❌ Arquivo maior que 6 MB.");
    return;
  }

  mostrarToast("⏳ Lendo o comprovante...", true);

  const leitor = new FileReader();
  leitor.onload = async function () {
    const base64 = String(leitor.result).split(",")[1] || "";

    try {
      const r = await chamarServidorPost("analisarDocumento", {
        arquivo: base64,
        mimeType: arq.type || "image/jpeg",
        observacao: "Comprovante de: " + grupo.descricao
      });

      if (!r.ok) { mostrarToast("❌ " + (r.mensagem || "Não consegui ler.")); return; }

      const d = r.dados || {};

      // Abre a edição do grupo já com o que a foto acrescentou. Não grava
      // sozinho: a foto pode ser de outra compra, e só você sabe.
      abrirEdicaoAprovacaoPorChave(grupo.chave, {
        descricao: d.descricao || grupo.descricao,
        categoria: d.categoria || grupo.categoria,
        metodo: d.metodo || grupo.metodo
      });

      mostrarToast("✅ Li o comprovante. Confira e salve.");

    } catch (e) {
      mostrarToast("❌ Sem conexão.");
    }
  };
  leitor.readAsDataURL(arq);
}

// Abre a edição do grupo e sobrescreve os campos com o que veio da foto.
function abrirEdicaoAprovacaoPorChave(chave, novos) {
  const idx = gruposAprovacao.findIndex(function (g) { return g.chave === chave; });
  if (idx < 0) return;

  abrirEdicaoAprovacao(idx);

  setTimeout(function () {
    if (novos.descricao) {
      const c = document.getElementById("ea-descricao");
      if (c) c.value = novos.descricao;
    }
    if (novos.categoria && typeof definirCategoriaCampo === "function") {
      definirCategoriaCampo("ea-categoria", novos.categoria);
    }
    if (novos.metodo) {
      const m = document.getElementById("ea-metodo");
      if (m) m.value = novos.metodo;
    }
  }, 300);
}

// ============================================================================
// COMPRAS CAPTURADAS DAS NOTIFICAÇÕES DO BANCO
// ----------------------------------------------------------------------------
// O serviço nativo lê as notificações dos apps de banco e guarda numa fila no
// próprio aparelho. Aqui essa fila vira lançamento — passando SEMPRE por
// Aprovações, nunca direto para Transações.
//
// Por que Aprovações: a leitura vem de um texto curto de notificação, sem
// categoria e com o nome do estabelecimento como o banco escreveu ("PAG*PADAR
// IA CENT"). Isso precisa de olho humano antes de virar dado.
// ============================================================================
let comprasCapturadas = [];
let capturadasJaVerificadas = false;   // mostrarTelaInterna roda mais de uma vez

function pluginNotificacoesBanco() {
  try {
    const P = window.Capacitor && window.Capacitor.Plugins;
    return (P && P.NotificacoesBanco) ? P.NotificacoesBanco : null;
  } catch (e) { return null; }
}

// Chamado na abertura do app: se houver compras na fila, avisa discretamente.
async function verificarComprasCapturadas() {
  const P = pluginNotificacoesBanco();
  if (!P) return;

  try {
    const r = await P.listar();
    comprasCapturadas = (r && r.itens) ? r.itens : [];
    if (!comprasCapturadas.length) return;

    // Manda sozinho. Antes isto só mostrava um aviso, e a compra só chegava a
    // Aprovações depois de tocar em "Ver" e depois em "Enviar" -- dois toques
    // que existiam por causa de como a coisa foi construída (uma fila no
    // aparelho), não por uma decisão que valesse a pena pedir.
    //
    // Mandar sozinho é seguro porque o destino é APROVAÇÕES, que é justamente
    // onde se confere: a compra entra como cartão amarelo e não vira lançamento
    // nenhum antes de você aprovar.
    const res = await mandarCapturadas();

    // Só duplicadas: diz, em vez de calar. Some da fila de qualquer jeito, e
    // silêncio aqui parece que a compra se perdeu.
    if (!res.enviadas && !res.falhas.length) {
      if (res.jaEstavam) {
        mostrarToast("✓ " + res.jaEstavam + " compra(s) já estavam em Aprovações.");
      }
      return;
    }

    if (res.enviadas && !res.falhas.length) {
      mostrarToastComAcaoGenerica(
        "✅ " + res.enviadas + " compra(s) em Aprovações",
        "Ver",
        function () { trocarAba("aprovacoes"); }
      );
      checarPendentesAprovacao();
      return;
    }

    // Falhou: o aviso diz o motivo e a fila continua intacta, para tentar de
    // novo. Silêncio aqui foi o que fez dois dias de captura parecerem que o
    // recurso não funcionava.
    mostrarToastComAcaoGenerica(
      "⚠ " + res.falhas.length + " compra(s) não entraram: " +
        (res.falhas[0] || "erro desconhecido"),
      "Ver",
      abrirComprasCapturadas
    );

  } catch (e) {
    // Fila indisponível não é erro que mereça interromper a abertura do app.
  }
}

// ----------------------------------------------------------------------------
// Relê o que está na barra de notificações agora e manda para Aprovações.
//
// O caminho automático depende de o serviço estar ligado NO INSTANTE em que o
// banco notifica. Se ele estava desligado — app recém-atualizado, aparelho
// recém-ligado, permissão religada agora —, aquela entrega já passou e não
// volta. Enquanto o aviso do banco continuar na barra, este botão o recupera.
//
// O resultado é dito em etapas de propósito: "14 na barra, nenhuma dos seus
// bancos" aponta para o problema; "não achei nada" não aponta para lugar
// nenhum.
// ----------------------------------------------------------------------------
async function varrerNotificacoesAgora() {
  const P = pluginNotificacoesBanco();
  const btn = document.getElementById("cap-btn-varrer");
  const aviso = document.getElementById("cap-aviso");

  if (!P) {
    aviso.textContent = "Isto só funciona dentro do aplicativo, não pelo navegador.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Lendo...";
  aviso.textContent = "";

  try {
    const r = await P.varrerAgora();

    if (!r.ok) {
      aviso.textContent = "⚠️ " + (r.motivo || "Não consegui ler.") +
        " Desligue e religue a permissão de acesso a notificações.";
      return;
    }

    const resumo = r.naBarra + " na barra · " + r.dosBancos + " do XP ou Inter · " +
                   r.capturadas + " nova(s)";

    // Recarrega a fila e tenta mandar o que houver.
    const lista = await P.listar();
    comprasCapturadas = (lista && lista.itens) ? lista.itens : [];
    renderizarComprasCapturadas();

    if (!comprasCapturadas.length) {
      aviso.textContent = r.dosBancos === 0
        ? resumo + ". Nenhuma notificação dos seus bancos está na barra — " +
          "se você já dispensou o aviso da compra, ele não volta."
        : resumo + ". As notificações do banco que estão na barra não são " +
          "compra no crédito.";
      return;
    }

    const res = await mandarCapturadas();

    if (res.enviadas && !res.falhas.length) {
      fecharComprasCapturadas();
      mostrarToast("✅ " + res.enviadas + " compra(s) em Aprovações.");
      checarPendentesAprovacao();
      return;
    }
    if (!res.enviadas && !res.falhas.length) {
      aviso.textContent = resumo + ". Já estavam em Aprovações.";
      renderizarComprasCapturadas();
      return;
    }
    aviso.textContent = "⚠️ " + res.falhas.slice(0, 2).join(" · ");

  } catch (e) {
    aviso.textContent = "⚠️ " + (e && e.message ? e.message : "Falhou a leitura.");
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Ler as notificações que estão na barra agora";
  }
}

// ----------------------------------------------------------------------------
// Envia a fila para Aprovações. Só a mecânica: quem cuida de tela é quem chama,
// porque isto roda tanto na abertura do app (sem modal nenhum aberto) quanto
// pelo botão da lista.
//
// A fila só é limpa quando TUDO entrou — limpar com falha perderia a compra, e
// ela não existe em nenhum outro lugar.
// ----------------------------------------------------------------------------
async function mandarCapturadas() {
  let enviadas = 0;
  let jaEstavam = 0;      // recusadas por já existirem: resolvidas, não falhas
  const falhas = [];

  for (let i = 0; i < comprasCapturadas.length; i++) {
    const c = comprasCapturadas[i];
    const valor = (c.valor || "").replace(/\./g, "").replace(",", ".");
    const quando = c.quando ? new Date(c.quando) : new Date();

    try {
      const r = await chamarServidor("lancarCompraDeNotificacao", {
        descricao: c.estabelecimento || c.titulo || "Compra no cartão",
        valor: valor,
        // O identificador da notificação é o que distingue "mandei de novo" de
        // "comprei duas vezes a mesma coisa". Sem ele, dois cafés no mesmo
        // lugar e no mesmo dia viravam um só.
        idNotificacao: c.assinatura || "",
        // Pode sair vazio quando a lista de métodos ainda não chegou; o
        // servidor descobre pelo banco. Ver metodoPeloBanco.
        metodo: metodoDoBanco(c.app),
        categoria: "",              // fica em branco: quem classifica é você
        dataCompra: quando.getFullYear() + "-" +
                    ("0" + (quando.getMonth() + 1)).slice(-2) + "-" +
                    ("0" + quando.getDate()).slice(-2),
        banco: c.app
      });

      if (r.ok) enviadas++;
      else if (r.erro === "DUPLICADA") jaEstavam++;
      else falhas.push((c.estabelecimento || "compra") + ": " + (r.mensagem || "falhou"));
    } catch (e) {
      falhas.push((c.estabelecimento || "compra") + ": sem conexão");
      break;   // rede caiu: parar evita repetir o erro em todas
    }
  }

  // Limpa quando nada ficou pendente de verdade. O que entrou agora e o que já
  // estava lá contam igual: nos dois casos a compra está em Aprovações.
  if ((enviadas || jaEstavam) && !falhas.length) {
    const P = pluginNotificacoesBanco();
    if (P) { try { await P.limpar(); } catch (e) {} }
    comprasCapturadas = [];
    limparTodoCache();
  }

  return { enviadas: enviadas, jaEstavam: jaEstavam, falhas: falhas };
}

// Igual ao toast com "Editar", mas com rótulo e ação livres.
function mostrarToastComAcaoGenerica(msg, rotulo, aoTocar) {
  const t = document.getElementById("toast");
  if (!t) return;

  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

  t.innerHTML = "";
  const txt = document.createElement("span");
  txt.textContent = msg;
  t.appendChild(txt);

  const b = document.createElement("button");
  b.className = "toast-acao";
  b.textContent = rotulo;
  b.onclick = function () { t.classList.remove("visivel"); aoTocar(); };
  t.appendChild(b);

  t.classList.add("visivel");
  toastTimer = setTimeout(function () { t.classList.remove("visivel"); }, 12000);
}

async function abrirComprasCapturadas() {
  const modal = document.getElementById("modal-capturadas");
  modal.style.display = "flex";
  document.getElementById("cap-aviso").textContent = "";

  const P = pluginNotificacoesBanco();

  // Sem permissão a lista nunca vai encher: explica e oferece a tela onde ela
  // é concedida, porque o Android não deixa pedir por diálogo.
  if (P) {
    try {
      const perm = await P.temPermissao();
      document.getElementById("cap-sem-permissao").style.display = perm.tem ? "none" : "block";
    } catch (e) {}
    try {
      const r = await P.listar();
      comprasCapturadas = (r && r.itens) ? r.itens : [];
    } catch (e) {}
    pintarDiagnosticoCaptura(P);
  } else {
    document.getElementById("cap-sem-permissao").style.display = "none";
    document.getElementById("cap-diagnostico").innerHTML = "";
  }

  renderizarComprasCapturadas();
}

// Mostra se a captura está funcionando, sem depender de ter havido compra.
//
// A linha que importa é a "última notificação lida": ela prova que o serviço
// está recebendo. Fila vazia com leitura recente significa que não houve
// compra; fila vazia sem leitura nenhuma significa que a permissão não está
// valendo. Sem essa linha, os dois casos parecem iguais na tela.
async function pintarDiagnosticoCaptura(P) {
  const alvo = document.getElementById("cap-diagnostico");
  if (!alvo) return;

  let d;
  try {
    d = ultimoDiagnostico = await P.diagnostico();
  } catch (e) {
    alvo.innerHTML = "";   // versão antiga do app, sem esse método
    return;
  }

  function linha(rotulo, valor, classe) {
    return '<div class="cap-diag-linha">' +
             '<span class="cap-diag-rot">' + rotulo + '</span>' +
             '<span class="cap-diag-val ' + (classe || "") + '">' + valor + '</span>' +
           '</div>';
  }

  let html = '<div class="cap-diag">';
  html += linha("Permissão de ler notificações",
                d.temPermissao ? "concedida" : "faltando",
                d.temPermissao ? "ok" : "nao");
  // Permissão concedida e serviço CONECTADO são coisas diferentes: atualizar o
  // app derruba a conexão, e ela costuma só voltar religando a permissão. Sem
  // esta linha, esse caso se disfarça de "não comprei nada".
  html += linha("Serviço ligado",
                d.conectadoDesde ? "sim, desde " + tempoRelativoCurto(d.conectadoDesde)
                                 : "não",
                d.conectadoDesde ? "ok" : "nao");
  html += linha("Bancos observados", "XP e Inter");
  html += linha("Esperando envio",
                (d.naFila || 0) + (d.naFila === 1 ? " compra" : " compras"),
                d.naFila ? "ok" : "");
  html += linha("Última notificação lida",
                tempoRelativoCurto(d.ultimaVista),
                d.ultimaVista ? "ok" : "nao");

  // O que foi descartado fica à vista: se uma compra de verdade parar de ser
  // reconhecida (o banco muda o texto), o sintoma aparece aqui em vez de ser
  // silêncio até a fatura chegar.
  const ign = (d.ignorados || []).slice(-5).reverse();
  if (ign.length) {
    html += '<div class="cap-ignorados">';
    html += '<div class="cap-diag-rot" style="margin-bottom:4px">' +
              'Ignoradas por não serem compra no crédito:</div>';
    ign.forEach(function (i) {
      html += '<div class="cap-ign-item"><b>' + escaparHtml(i.app || "") + '</b> · ' +
                escaparHtml(String(i.texto || "").slice(0, 70)) +
                '<br><span class="cap-ign-motivo">' + escaparHtml(i.motivo || "") + '</span>' +
              '</div>';
    });
    html += '</div>';
  }
  if (d.pacotes) {
    html += '<div class="cap-diag-rot" style="margin-top:8px;font-size:10px;opacity:.7">' +
              'Lendo de: ' + escaparHtml(d.pacotes) + '</div>';
  }
  html += '</div>';

  alvo.innerHTML = html;
}

let ultimoDiagnostico = null;

// Junta num texto só tudo que decide se a captura funciona, para poder ser
// colado numa conversa. Descrever isso a cada rodada -- "o que diz a linha
// tal?" -- custou várias idas e vindas sem fechar o diagnóstico.
//
// Vai o texto ORIGINAL das notificações junto: é ele que diz se o filtro
// descartou uma compra de verdade, e nenhuma outra informação substitui.
async function copiarDiagnosticoCaptura() {
  const d = ultimoDiagnostico || {};
  const l = [];

  l.push("=== Captura de notificações ===");
  l.push("Permissão: " + (d.temPermissao ? "concedida" : "FALTANDO"));
  l.push("Serviço ligado: " + (d.conectadoDesde
        ? "sim (" + tempoRelativoCurto(d.conectadoDesde) + ")" : "NÃO"));
  l.push("Última notificação lida: " + tempoRelativoCurto(d.ultimaVista));
  l.push("Lendo de: " + (d.pacotes || "?"));
  l.push("Versão da tela: " + (versaoDaPagina() || "?"));
  l.push("");

  l.push("Na fila (" + comprasCapturadas.length + "):");
  if (!comprasCapturadas.length) l.push("  (vazia)");
  comprasCapturadas.forEach(function (c) {
    l.push("  - " + (c.app || "?") + " | R$ " + (c.valor || "?") +
           " | " + (c.estabelecimento || "sem lugar"));
    l.push("    texto: " + (c.texto || "(vazio)"));
  });
  l.push("");

  const ign = d.ignorados || [];
  l.push("Ignoradas (" + ign.length + "):");
  if (!ign.length) l.push("  (nenhuma)");
  ign.slice(-8).forEach(function (i) {
    l.push("  - " + (i.app || "?") + " | " + (i.motivo || "?"));
    l.push("    texto: " + (i.texto || "(vazio)"));
  });

  const texto = l.join("\n");

  try {
    await navigator.clipboard.writeText(texto);
    mostrarToast("✅ Diagnóstico copiado. É só colar.");
  } catch (e) {
    // A área de transferência falha em WebView em alguns aparelhos. Mostrar o
    // texto ainda permite copiar à mão -- melhor que um erro sem saída.
    const aviso = document.getElementById("cap-aviso");
    aviso.textContent = texto;
    aviso.style.whiteSpace = "pre-wrap";
    aviso.style.userSelect = "text";
    mostrarToast("Copie o texto que apareceu abaixo.");
  }
}

// A versão que ESTA página carregou, lida da tag que a trouxe.
function versaoDaPagina() {
  const tag = document.querySelector('script[src*="app.js?v="]');
  return tag ? (tag.getAttribute("src").match(/v=(\d+)/) || [])[1] : null;
}

// "há 3 min", "há 2 h", "ontem". Zero vira "nenhuma ainda", que é o estado
// que denuncia a permissão desligada.
function tempoRelativoCurto(quando) {
  if (!quando) return "nenhuma ainda";
  const seg = Math.max(0, Math.floor((Date.now() - Number(quando)) / 1000));
  if (seg < 60) return "agora há pouco";
  if (seg < 3600) return "há " + Math.floor(seg / 60) + " min";
  if (seg < 86400) return "há " + Math.floor(seg / 3600) + " h";
  const dias = Math.floor(seg / 86400);
  return dias === 1 ? "ontem" : "há " + dias + " dias";
}

function fecharComprasCapturadas() {
  document.getElementById("modal-capturadas").style.display = "none";
}

async function pedirPermissaoNotificacoes() {
  const P = pluginNotificacoesBanco();
  if (!P) return;
  try {
    await P.pedirPermissao();
    document.getElementById("cap-aviso").textContent =
      "Procure 'Smartintegrado' na lista e ligue. Depois volte aqui.";
  } catch (e) {
    document.getElementById("cap-aviso").textContent = "Não consegui abrir as configurações.";
  }
}

function renderizarComprasCapturadas() {
  const alvo = document.getElementById("cap-lista");

  if (!comprasCapturadas.length) {
    alvo.innerHTML = '<p class="vazio">Nenhuma compra capturada ainda. ' +
      'Elas aparecem aqui sozinhas quando o banco notificar.</p>';
    document.getElementById("cap-btn-enviar").style.display = "none";
    return;
  }

  document.getElementById("cap-btn-enviar").style.display = "block";
  document.getElementById("cap-btn-enviar").textContent =
    "Enviar " + comprasCapturadas.length + " para Aprovações";

  alvo.innerHTML = comprasCapturadas.map(function (c, i) {
    const quando = c.quando ? new Date(c.quando) : null;
    const hora = quando
      ? ("0" + quando.getDate()).slice(-2) + "/" + ("0" + (quando.getMonth() + 1)).slice(-2) +
        " " + ("0" + quando.getHours()).slice(-2) + ":" + ("0" + quando.getMinutes()).slice(-2)
      : "";

    return '<div class="cap-item">' +
             '<div class="cap-topo">' +
               '<b>' + escaparHtml(c.estabelecimento || c.titulo || "Compra") + '</b>' +
               '<span class="cap-valor">R$ ' + escaparHtml(c.valor || "") + '</span>' +
             '</div>' +
             '<div class="cap-sub">' + escaparHtml(c.app || "") +
               (hora ? " · " + hora : "") + '</div>' +
             // O texto original fica à vista: é ele que permite conferir se a
             // leitura pegou o valor certo.
             '<div class="cap-original">' + escaparHtml(c.texto || "") + '</div>' +
             '<button class="cap-descartar" onclick="descartarCaptura(' + i + ')">Descartar</button>' +
           '</div>';
  }).join("");
}

function descartarCaptura(indice) {
  comprasCapturadas.splice(indice, 1);
  renderizarComprasCapturadas();
}

async function enviarCapturadasParaAprovacoes() {
  if (!comprasCapturadas.length) return;

  const btn = document.getElementById("cap-btn-enviar");
  const aviso = document.getElementById("cap-aviso");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  const res = await mandarCapturadas();

  if (res.enviadas && !res.falhas.length) {
    fecharComprasCapturadas();
    mostrarToast("✅ " + res.enviadas + " compra(s) em Aprovações.");
    checarPendentesAprovacao();
    return;
  }

  aviso.textContent = res.enviadas + " enviada(s), " + res.falhas.length +
                      " com problema: " + res.falhas.slice(0, 3).join(" · ");
  btn.disabled = false;
  renderizarComprasCapturadas();
}

// O nome do banco vira o método do lançamento. Sem correspondência exata, cai
// em branco e você escolhe na aprovação — melhor que inventar um método que
// não existe na planilha.
function metodoDoBanco(app) {
  if (!listasValidas || !listasValidas.metodos) return "";
  const alvo = (app || "").toLowerCase();

  const achado = listasValidas.metodos.filter(function (m) {
    const n = m.toLowerCase();
    return alvo && (n.indexOf(alvo) >= 0 || alvo.indexOf(n.replace(/cart(ã|a)o\s*/, "")) >= 0);
  })[0];

  return achado || "";
}

// ============================================================================
// LANÇAR FALANDO
// ----------------------------------------------------------------------------
// Você fala, a IA extrai o que deu e PERGUNTA o que falta — em voz alta, uma
// coisa de cada vez. Nada é lançado sem você conferir na tela: valor e método
// errados viram lançamento errado, e corrigir depois custa mais.
//
// O reconhecimento de fala é do próprio navegador. Onde ele não existe (parte
// das WebView de aplicativo), o campo de texto assume — e ali o microfone do
// teclado resolve, que é o mesmo gesto.
// ============================================================================
let vozReconhecimento = null;
let vozOuvindo = false;
let vozJaSei = {};
let vozDados = null;

function temReconhecimentoDeVoz() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function abrirLancarFalando() {
  fecharMenuAdicionar();
  document.getElementById("modal-voz").style.display = "flex";

  vozJaSei = {};
  vozDados = null;
  document.getElementById("voz-conversa").innerHTML = "";
  document.getElementById("voz-texto").value = "";
  document.getElementById("voz-resumo").style.display = "none";
  document.getElementById("voz-aviso").textContent = "";

  const semVoz = !temReconhecimentoDeVoz();
  document.getElementById("voz-btn-mic").style.display = semVoz ? "none" : "flex";
  document.getElementById("voz-sem-microfone").style.display = semVoz ? "block" : "none";

  falarNaTela("ia", "Pode falar. Por exemplo: “comprei pão hoje no cartão XP, doze reais”.");
}

function fecharLancarFalando() {
  pararDeOuvir();
  try { window.speechSynthesis.cancel(); } catch (e) {}
  document.getElementById("modal-voz").style.display = "none";
}

function falarNaTela(quem, texto) {
  const caixa = document.getElementById("voz-conversa");
  const div = document.createElement("div");
  div.className = "voz-msg " + quem;
  div.textContent = texto;
  caixa.appendChild(div);
  caixa.scrollTop = caixa.scrollHeight;
}

// Lê a pergunta em voz alta. É o que fecha o ciclo: falar e ouvir de volta,
// sem precisar olhar a tela no meio da rua.
function falarEmVozAlta(texto) {
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const f = new SpeechSynthesisUtterance(texto);
    f.lang = "pt-BR";
    f.rate = 1.05;
    window.speechSynthesis.speak(f);
  } catch (e) {}
}

function alternarMicrofone() {
  if (vozOuvindo) { pararDeOuvir(); return; }

  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) return;

  try { window.speechSynthesis.cancel(); } catch (e) {}

  vozReconhecimento = new Rec();
  vozReconhecimento.lang = "pt-BR";
  vozReconhecimento.continuous = false;
  vozReconhecimento.interimResults = false;

  vozReconhecimento.onstart = function () {
    vozOuvindo = true;
    const b = document.getElementById("voz-btn-mic");
    b.classList.add("ouvindo");
    b.textContent = "⏹";
    document.getElementById("voz-aviso").textContent = "Ouvindo...";
  };

  vozReconhecimento.onresult = function (e) {
    const dito = e.results[0][0].transcript;
    document.getElementById("voz-texto").value = dito;
    enviarFala(dito);
  };

  vozReconhecimento.onerror = function (e) {
    document.getElementById("voz-aviso").textContent =
      e.error === "not-allowed"
        ? "Preciso da permissão do microfone. Libere nas configurações do navegador."
        : "Não consegui ouvir. Tente de novo ou escreva.";
    pararDeOuvir();
  };

  vozReconhecimento.onend = function () { pararDeOuvir(); };

  try { vozReconhecimento.start(); } catch (e) {
    document.getElementById("voz-aviso").textContent = "Não consegui abrir o microfone.";
  }
}

function pararDeOuvir() {
  vozOuvindo = false;
  const b = document.getElementById("voz-btn-mic");
  if (b) { b.classList.remove("ouvindo"); b.textContent = "🎤"; }
  const av = document.getElementById("voz-aviso");
  if (av && av.textContent === "Ouvindo...") av.textContent = "";
  try { if (vozReconhecimento) vozReconhecimento.stop(); } catch (e) {}
}

function enviarFalaEscrita() {
  const t = document.getElementById("voz-texto").value.trim();
  if (t) enviarFala(t);
}

async function enviarFala(texto) {
  falarNaTela("eu", texto);
  document.getElementById("voz-texto").value = "";
  document.getElementById("voz-aviso").textContent = "Entendendo...";

  try {
    const r = await chamarServidor("interpretarDespesaFalada", {
      texto: texto,
      jaSei: JSON.stringify(vozJaSei)
    });

    if (!r.ok) {
      document.getElementById("voz-aviso").textContent = r.mensagem || "Não entendi.";
      return;
    }

    // O que ela já entendeu vira a base da próxima rodada — assim você
    // completa aos poucos, sem repetir o que já disse.
    vozJaSei = r.dados;
    vozDados = r.dados;
    document.getElementById("voz-aviso").textContent = "";

    if (r.completo) {
      falarNaTela("ia", "Entendi. Confira antes de lançar.");
      falarEmVozAlta("Confira antes de lançar.");
      mostrarResumoVoz(r.dados);
    } else {
      falarNaTela("ia", r.pergunta);
      falarEmVozAlta(r.pergunta);
      document.getElementById("voz-resumo").style.display = "none";
    }
  } catch (e) {
    document.getElementById("voz-aviso").textContent = "Sem conexão.";
  }
}

function mostrarResumoVoz(d) {
  const el = document.getElementById("voz-resumo");
  el.style.display = "block";

  const linha = function (rot, val) {
    return '<div class="voz-campo"><span>' + rot + "</span><b>" + escaparHtml(val) + "</b></div>";
  };

  el.innerHTML =
    linha("O quê", d.descricao) +
    linha("Valor", formatarMoeda(d.valor)) +
    linha("Como", d.metodo) +
    linha("Categoria", d.categoria) +
    linha("Data", (d.dataCompra || "").split("-").reverse().join("/")) +
    (d.parcelas > 1 ? linha("Parcelas", d.parcelas + "x") : "") +
    '<div class="voz-acoes">' +
      '<button onclick="corrigirNoFormulario()">Corrigir</button>' +
      '<button class="principal" onclick="lancarPelaVoz()">Lançar</button>' +
    '</div>';
}

// Abre o formulário normal com tudo preenchido: quando algo saiu errado, o
// caminho conhecido é melhor do que insistir na conversa.
async function corrigirNoFormulario() {
  const d = vozDados;
  if (!d) return;

  fecharLancarFalando();
  await abrirNovaDespesa();

  document.getElementById("nd-descricao").value = d.descricao || "";
  document.getElementById("nd-valor").value = (parseFloat(d.valor) || 0).toFixed(2);
  if (listasValidas) montarSelect("nd-metodo", listasValidas.metodos, d.metodo || "");
  definirCategoriaCampo("nd-categoria", d.categoria || "");
  if (d.dataCompra) document.getElementById("nd-datacompra").value = d.dataCompra;
  document.getElementById("nd-parcelas").value = d.parcelas || 1;
  atualizarCamposDespesa();
}

async function lancarPelaVoz() {
  const d = vozDados;
  if (!d) return;

  const btn = document.querySelector("#voz-resumo .principal");
  if (btn) { btn.disabled = true; btn.textContent = "Lançando..."; }

  try {
    const r = await chamarServidor("incluirDespesa", {
      descricao: d.descricao,
      valorTotal: d.valor,
      metodo: d.metodo,
      categoria: d.categoria,
      dataCompra: d.dataCompra,
      totalParcelas: d.parcelas || 1,
      jaPago: d.jaPago ? "true" : "false"
    });

    if (r.ok) {
      fecharLancarFalando();
      mostrarToastComEditar("✅ " + r.mensagem, r.idInicial);
      await recarregarDados();
    } else {
      document.getElementById("voz-aviso").textContent = r.mensagem || "Não deu para lançar.";
      if (btn) { btn.disabled = false; btn.textContent = "Lançar"; }
    }
  } catch (e) {
    document.getElementById("voz-aviso").textContent = "Sem conexão. Nada foi lançado.";
    if (btn) { btn.disabled = false; btn.textContent = "Lançar"; }
  }
}

// ============================================================================
// DUPLICAR LANÇAMENTO
// ----------------------------------------------------------------------------
// Abre o formulário de nova despesa já preenchido com os dados de um
// lançamento existente. É um RASCUNHO: nada é gravado até você confirmar, e
// tudo continua editável — inclusive anexar documento, que é o mesmo caminho
// da inclusão normal.
//
// As DATAS não são copiadas: uma despesa recorrente repete descrição, valor,
// método e categoria, mas nunca o vencimento do mês passado. Copiar a data
// velha faria a cópia nascer vencida.
// ============================================================================
async function duplicarLancamento(numMov) {
  let it = (resultadosBusca || []).filter(function (x) { return x.numMov === numMov; })[0] || itemDetalhe;

  if (!it || it.numMov !== numMov) {
    try {
      const r = await chamarServidor("buscarLancamento", { numMov: numMov });
      if (!r.ok || !r.lancamento) {
        mostrarToast("❌ " + (r.mensagem || "Não encontrei o lançamento."));
        return;
      }
      it = r.lancamento;
    } catch (e) {
      mostrarToast("❌ Sem conexão.");
      return;
    }
  }

  await abrirNovaDespesa();

  document.getElementById("nd-descricao").value = it.descricao || "";
  document.getElementById("nd-valor").value = (parseFloat(it.valor) || 0).toFixed(2);

  if (listasValidas) montarSelect("nd-metodo", listasValidas.metodos, it.metodo || "");
  definirCategoriaCampo("nd-categoria", it.categoria || "");

  // Parcelas voltam a 1: o que se duplica é a compra, não o parcelamento dela.
  document.getElementById("nd-parcelas").value = "1";
  document.getElementById("nd-chk-pago").checked = false;

  atualizarCamposDespesa();

  const aviso = document.getElementById("nd-aviso");
  if (aviso) {
    aviso.textContent = "Cópia de MOV-" + numMov + ". Confira a data e o valor antes de confirmar.";
  }
  mostrarToast("⧉ Cópia de MOV-" + numMov + " — nada foi lançado ainda.");
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

  // No cartão não existe "já paga": quem se paga é a fatura, e a data de
  // pagamento só é carimbada quando ela é liquidada.
  esconderJaPagoSeCartao("nd", ehCartao);

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
// Some com o "já foi paga" quando o método é cartão. A compra entra na fatura
// e só recebe data de pagamento quando a fatura inteira é liquidada — deixar
// a opção na tela convida a marcar algo que o servidor ignora.
function esconderJaPagoSeCartao(prefixo, ehCartao) {
  const toggle = document.getElementById(prefixo + "-toggle-pago");
  const check = document.getElementById(prefixo + "-chk-pago");
  const blocoData = document.getElementById(prefixo + "-bloco-datapgto");
  const aviso = document.getElementById(prefixo + "-aviso-cartao");

  if (toggle) toggle.style.display = ehCartao ? "none" : "flex";

  if (ehCartao) {
    if (check) check.checked = false;          // desmarca o que já estivesse
    if (blocoData) blocoData.style.display = "none";
    if (aviso) {
      aviso.innerHTML = "💳 Vencimento definido pela fatura deste cartão, que fecha 8 dias antes. " +
                        "A data de pagamento é preenchida quando você liquida a fatura.";
    }
  }
}

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
    grupo: (document.getElementById("nd-grupo") || {}).value || "",
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

  // A conta na hora, antes de a planilha responder. Se der erro no envio, a
  // revalidação devolve o número certo -- e o toast diz que não lançou.
  somarLancamentoNoCache(params);
  recarregarDados();

  gravarNovaDespesa(params, desc);
}

async function gravarNovaDespesa(params, desc) {
  try {
    const r = await chamarServidor("incluirDespesa", params);
    if (r.ok) {
      // Numa compra parcelada, o atalho abre a PRIMEIRA parcela — é dela que
      // a edição consegue alcançar o grupo inteiro.
      mostrarToastComEditar("✅ " + r.mensagem, r.idInicial);
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
  // No modo "só trabalho" não existe outro destino: qualquer caminho que
  // tentasse levar ao Smartbalanço (atalho, widget, deep link) cai aqui.
  // O hub é exceção — lá os outros módulos aparecem trancados, e é assim
  // que se vê que existem.
  if (soTrabalho() && nome !== "trabalho" && nome !== "modulos") nome = "trabalho";

  abaAtiva = nome;

  document.getElementById("conteudo-dash").style.display  = (nome === "dashboard")  ? "block" : "none";
  document.getElementById("conteudo-aprov").style.display = (nome === "aprovacoes") ? "block" : "none";
  document.getElementById("conteudo-rel").style.display   = (nome === "relatorios") ? "block" : "none";
  document.getElementById("conteudo-planos").style.display = (nome === "planos") ? "block" : "none";
  document.getElementById("conteudo-chat").style.display  = (nome === "chat")       ? "flex"  : "none";
  document.getElementById("conteudo-busca").style.display = (nome === "busca")      ? "block" : "none";
  document.getElementById("conteudo-calendario").style.display = (nome === "calendario") ? "block" : "none";
  document.getElementById("conteudo-tarefas").style.display = (nome === "tarefas") ? "block" : "none";
  document.getElementById("conteudo-trabalho").style.display = (nome === "trabalho") ? "block" : "none";
  document.getElementById("conteudo-modulos").style.display = (nome === "modulos") ? "block" : "none";
  document.getElementById("nav-mes-wrap").style.display   = (nome === "dashboard")  ? "flex"  : "none";
  document.getElementById("abas-principais").style.display =
    (nome === "chat" || nome === "busca" || nome === "calendario" ||
     nome === "tarefas" || nome === "trabalho" || nome === "modulos") ? "none" : "flex";

  document.getElementById("tab-dashboard").classList.toggle("ativa", nome === "dashboard");
  document.getElementById("tab-aprovacoes").classList.toggle("ativa", nome === "aprovacoes");
  document.getElementById("tab-relatorios").classList.toggle("ativa", nome === "relatorios");
  document.getElementById("tab-planos").classList.toggle("ativa", nome === "planos");
  if (nome === "planos") carregarPlanos();

  // Botões flutuantes: só no dashboard
  const noDash = (nome === "dashboard");
  document.getElementById("btn-nova-despesa").style.display = noDash ? "flex" : "none";
  document.getElementById("btn-chat-ia").style.display = noDash ? "flex" : "none";
  document.getElementById("btn-nova-tarefa").style.display = (nome === "tarefas") ? "flex" : "none";
  document.getElementById("btn-chat-trabalho").style.display = (nome === "trabalho") ? "flex" : "none";

  // Botão voltar (no chat e na busca)
  document.getElementById("btn-voltar").style.display =
    (nome === "chat" || nome === "busca" || nome === "calendario" ||
     nome === "tarefas" || nome === "trabalho") ? "inline-block" : "none";

  if (soTrabalho()) aplicarModoSoTrabalho();

  // Título do topo
  // Só o texto muda: a seta do menu de produtos fica num span à parte, senão
  // seria apagada a cada troca de aba.
  const titulo = document.getElementById("titulo-texto");
  if (nome === "chat") titulo.textContent = "🧠 Assistente IA";
  else if (nome === "busca") titulo.textContent = "🚀 Lançamentos";
  else if (nome === "calendario") titulo.textContent = "Smartcalendário";
  else if (nome === "tarefas") titulo.textContent = "Smarttarefas";
  else if (nome === "trabalho") titulo.textContent = "Smarttrabalho";
  else if (nome === "modulos") titulo.textContent = "Módulos";
  else titulo.textContent = "Smartbalanço";

  if (nome === "aprovacoes") carregarAprovacoes(false);
  if (nome === "relatorios") renderizarTelaRelatorios();
  if (nome === "chat") abrirChat();
  if (nome === "busca") abrirBusca();
  if (nome === "tarefas") carregarTarefas();
  if (nome === "modulos") renderizarModulos();
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
    const r = await lerCacheado("listarAprovacoes");
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

// ============================================================================
// CONFERIR E APROVAR TUDO
// ----------------------------------------------------------------------------
// A conferência vem ANTES da aprovação, e é a tela inteira: descrição, valor,
// parcelas, método e categoria de cada lançamento. Aprovar em massa sem ver o
// que entra é como assinar sem ler.
// ============================================================================
function abrirConferencia() {
  if (!gruposAprovacao.length) return;

  const total = gruposAprovacao.reduce(function (s, g) {
    return s + (parseFloat(g.valorTotal) || 0);
  }, 0);

  const linhas = gruposAprovacao.map(function (g) {
    const detalhe = [
      g.totalParcelas > 1 ? g.totalParcelas + "x" : "",
      g.metodo, g.categoria
    ].filter(function (x) { return x; }).join(" · ");

    return '<div class="conf-item">' +
             '<div class="conf-info">' +
               '<div class="conf-desc">' + escaparHtml(g.descricao || "") + '</div>' +
               (detalhe ? '<div class="conf-sub">' + escaparHtml(detalhe) + '</div>' : '') +
             '</div>' +
             '<div class="conf-valor">' + formatarMoeda(g.valorTotal) + '</div>' +
           '</div>';
  }).join("");

  document.getElementById("modal-conferir").style.display = "flex";
  document.getElementById("conf-resumo").textContent =
    gruposAprovacao.length + " lançamento(s) · " + formatarMoeda(total);
  document.getElementById("conf-lista").innerHTML = linhas;
  document.getElementById("conf-aviso").textContent = "";

  const btn = document.getElementById("conf-btn-aprovar");
  btn.disabled = false;
  btn.textContent = "Aprovar os " + gruposAprovacao.length;
}

function fecharConferencia() {
  document.getElementById("modal-conferir").style.display = "none";
}

async function aprovarTudoDeUmaVez() {
  const btn = document.getElementById("conf-btn-aprovar");
  const aviso = document.getElementById("conf-aviso");
  const quantos = gruposAprovacao.length;

  btn.disabled = true;
  btn.textContent = "Aprovando...";
  aviso.textContent = "Isso pode levar alguns segundos.";

  try {
    // Manda quantos você conferiu: se a lista mudou nesse meio-tempo, o
    // servidor recusa em vez de aprovar algo que ninguém viu.
    const r = await chamarServidor("aprovarTodos", { quantidade: quantos });

    if (r.ok) {
      fecharConferencia();
      mostrarToast("✅ " + r.mensagem);

      if (r.falhas && r.falhas.length) {
        // Falha parcial não pode virar só um número: sem saber QUAL não
        // entrou, não há como agir.
        setTimeout(function () {
          alert("Não entraram:\n\n" + r.falhas.join("\n"));
        }, 600);
      }

      limparTodoCache();
      await carregarAprovacoes(true);
      await recarregarDados();
    } else {
      aviso.textContent = r.mensagem || "Não foi possível aprovar.";
      btn.disabled = false;
      btn.textContent = "Aprovar os " + quantos;
      if (r.erro === "MUDOU") await carregarAprovacoes(true);
    }
  } catch (e) {
    aviso.textContent = "Sem conexão. Confira a lista antes de tentar de novo — " +
                        "parte pode ter sido aprovada.";
    btn.disabled = false;
    btn.textContent = "Aprovar os " + quantos;
  }
}

function renderizarAprovacoes() {
  const lista = document.getElementById("lista-aprovacoes");
  lista.innerHTML = "";

  atualizarBadgeAprovacoes(gruposAprovacao.length);

  // Barra de conferência: só aparece quando há mais de um, porque para um
  // lançamento só o botão do próprio card já resolve.
  const barra = document.getElementById("aprov-barra-tudo");
  if (barra) {
    barra.style.display = gruposAprovacao.length > 1 ? "flex" : "none";
    const cont = document.getElementById("aprov-contagem");
    if (cont) {
      const total = gruposAprovacao.reduce(function (s, g) {
        return s + (parseFloat(g.valorTotal) || 0);
      }, 0);
      cont.textContent = gruposAprovacao.length + " pendentes · " + formatarMoeda(total);
    }
  }

  if (gruposAprovacao.length === 0) {
    lista.innerHTML =
      '<div class="card" style="text-align:center; padding:36px 20px;">' +
        '<div style="font-size:40px; margin-bottom:10px;">✅</div>' +
        '<p style="font-size:15px; color:var(--texto-2); font-weight:600;">Nada pendente!</p>' +
        '<p style="font-size:13px; color:var(--fraco-2); margin-top:4px;">Não há lançamentos aguardando aprovação.</p>' +
      '</div>';
    return;
  }

  // O que é IGUAL em todos sobe para um cabeçalho e some das linhas.
  //
  // Nos sete pendentes da tela, vencimento e método eram os mesmos em todos:
  // catorze blocos rotulados repetindo a mesma informação, ocupando metade da
  // altura da lista. O que não varia não distingue nada.
  // Pela MAIORIA, não por unanimidade.
  //
  // A primeira versão só subia o campo quando era igual em TODOS -- e bastava
  // um Pix no meio de seis compras no cartão para os seis voltarem a repetir
  // "01/11/2026 · Cartão C XP" um por um. Agora o comum sobe e só quem foge
  // dele carrega o chip, que é justamente onde a informação está.
  const vencComum = valorDaMaioria(gruposAprovacao, function (g) { return g.primeiroVenc || ""; });
  const metodoComum = valorDaMaioria(gruposAprovacao, function (g) { return (g.metodo || "").trim(); });

  if (vencComum || metodoComum) {
    const cab = document.createElement("div");
    cab.className = "ap-comum";
    cab.innerHTML =
      (vencComum
        ? '<span>' + (vencComum.todos ? "todos vencem em " : "a maioria vence em ") +
          '<b>' + formatarDataBr(vencComum.valor) + '</b></span>'
        : '') +
      (metodoComum
        ? '<span>' + (metodoComum.todos ? "todos no " : "a maioria no ") +
          '<b>' + escaparHtml(metodoComum.valor) + '</b></span>'
        : '');
    lista.appendChild(cab);
  }

  const caixa = document.createElement("div");
  caixa.className = "card";
  lista.appendChild(caixa);

  gruposAprovacao.forEach(function (g, idx) {
    const faixa = (g.movInicial === g.movFinal)
      ? "MOV-" + g.movInicial
      : "MOV-" + g.movInicial + " a " + g.movFinal;

    const parcTxt = (g.totalParcelas > 1)
      ? g.totalParcelas + "x de " + formatarMoeda(g.valorParcela)
      : "À vista";

    const daNotificacao = (g.origem === "notificacao");

    const linha = document.createElement("div");
    linha.className = "ap-linha" +
      (g.preLancamento ? (daNotificacao ? " do-cartao" : " pre-lancamento") : "");

    // Chips: só o que DIFERE do cabeçalho. Repetir o comum aqui desfaria todo
    // o ganho de tê-lo subido.
    const chips = [];
    // Sem o codigo da categoria, como nos Maiores Gastos: "2.3.009." e chave
    // de planilha, e aqui ele estourava o chip e quebrava a linha em duas.
    if (g.categoria) {
      const catCurta = nomeDaCategoria(g.categoria);
      chips.push('<span class="ap-l-chip">' + escaparHtml(catCurta) + '</span>');
    }
    else chips.push('<span class="ap-l-chip alerta">sem categoria</span>');

    if (g.preLancamento) {
      chips.push('<span class="ap-l-chip origem' + (daNotificacao ? '' : ' doc') + '">' +
        (daNotificacao ? '💳 do cartão' : '⚡ do documento') + '</span>');
    }
    // Só o que FOGE do cabeçalho. É o chip que diz "este aqui é diferente".
    if (!vencComum || (g.primeiroVenc || "") !== vencComum.valor) {
      chips.push('<span class="ap-l-chip destaque">' + formatarDataBr(g.primeiroVenc) + '</span>');
    }
    if (!metodoComum || (g.metodo || "").trim() !== metodoComum.valor) {
      chips.push('<span class="ap-l-chip destaque">' + escaparHtml(g.metodo || "-") + '</span>');
    }
    if (g.totalParcelas > 1) chips.push('<span class="ap-l-chip">' + g.totalParcelas + 'x</span>');
    if (g.grupo) {
      chips.push('<span class="ap-l-chip origem">' + escaparHtml(g.grupo) + '</span>');
    }

    chips.push('<span>' + faixa + '</span>');

    const aviso = !g.preLancamento ? '' :
      '<div class="ap-det-nota">' +
        (daNotificacao
          ? 'Lido da notificação do banco. O nome do estabelecimento costuma vir abreviado — confira antes de aprovar.'
          : 'Lido do documento. Confira a categoria antes de aprovar.') +
      '</div>' +
      '<button class="ap-det-foto" onclick="event.stopPropagation(); anexarFotoAoPreLancamento(\'' +
        g.chave + '\')">📷 Melhorar com foto do comprovante</button>';

    linha.innerHTML =
      '<div class="ap-l-topo" onclick="alternarDetalheAprovacao(' + idx + ')">' +
        '<span class="ap-l-desc">' + escaparHtml(g.descricao) + '</span>' +
      '</div>' +
      '<div class="ap-l-sub" onclick="alternarDetalheAprovacao(' + idx + ')">' +
        '<b class="ap-l-valor">' + formatarMoeda(g.valorTotal) + '</b>' +
        chips.join("") +
      '</div>' +
      '<div class="ap-l-acoes">' +
        '<button class="ap-ic rej" aria-label="Rejeitar" title="Rejeitar" ' +
          'onclick="confirmarRejeicao(' + idx + ')">✕</button>' +
        '<button class="ap-ic" aria-label="Editar" title="Editar" ' +
          'onclick="abrirEdicaoAprovacao(' + idx + ')">✎</button>' +
        '<button class="ap-ic ok" aria-label="Aprovar" title="Aprovar" ' +
          'onclick="aprovarDireto(' + idx + ')">✓</button>' +
      '</div>' +
      '<div class="ap-l-det" id="ap-det-' + idx + '" style="display:none;">' +
        '<div class="ap-det-grade">' +
          '<div class="ap-det-item"><span>Vencimento</span><b>' +
            formatarDataBr(g.primeiroVenc) + '</b></div>' +
          '<div class="ap-det-item"><span>Método</span><b>' +
            escaparHtml(g.metodo || "-") + '</b></div>' +
          '<div class="ap-det-item"><span>Parcelas</span><b>' + parcTxt + '</b></div>' +
        '</div>' +
        '<div class="ap-det-nota"><b>' + escaparHtml(g.descricao) + '</b></div>' +
        (gruposConhecidos.length
          ? '<div class="ap-det-grupo">' +
              '<div class="ap-det-grupo-rot">Grupo de saldo</div>' +
              '<div class="det-grupo-chips" id="ap-grupo-' + idx + '">' +
                chipsDeGrupoAprovacao(idx, g.grupo) +
              '</div>' +
            '</div>'
          : '') +
        aviso +
      '</div>';

    caixa.appendChild(linha);
  });
}

/**
 * O valor mais repetido de um campo, quando ele domina a lista.
 *
 * Abaixo de 60% não é "o comum", é só o mais frequente -- e subir isso para o
 * cabeçalho faria metade das linhas carregarem um chip de exceção, que é pior
 * que não ter cabeçalho nenhum.
 */
function valorDaMaioria(itens, ler) {
  if (itens.length < 2) return null;

  const contagem = {};
  itens.forEach(function (g) {
    const v = ler(g);
    if (!v) return;
    contagem[v] = (contagem[v] || 0) + 1;
  });

  let melhor = null, quantos = 0;
  Object.keys(contagem).forEach(function (v) {
    if (contagem[v] > quantos) { melhor = v; quantos = contagem[v]; }
  });

  if (!melhor || quantos / itens.length < 0.6) return null;
  return { valor: melhor, quantos: quantos, todos: quantos === itens.length };
}

/**
 * Os botoes de grupo de um lancamento aguardando aprovacao.
 *
 * A aprovacao e a ultima conferencia antes de virar despesa de verdade, e e
 * ali que se costuma perceber que a compra era da mesada. Depois de aprovada
 * ela ainda pode ser marcada pela ficha -- isto so evita ter de lembrar.
 */
function chipsDeGrupoAprovacao(idx, atual) {
  const agora = (atual || "").toString().trim();

  return [{ v: "", r: "nenhum" }]
    .concat(gruposConhecidos.map(function (n) { return { v: n, r: n }; }))
    .map(function (o) {
      return '<button type="button" class="' + (o.v === agora ? "ativo" : "") +
        '" onclick="event.stopPropagation(); escolherGrupoDaAprovacao(' + idx + ', ' +
        JSON.stringify(o.v).replace(/"/g, "&quot;") + ')">' +
        escaparHtml(o.r) + '</button>';
    }).join("");
}

async function escolherGrupoDaAprovacao(idx, nome) {
  const g = gruposAprovacao[idx];
  if (!g) return;

  const caixa = document.getElementById("ap-grupo-" + idx);
  if (caixa) caixa.innerHTML = chipsDeGrupoAprovacao(idx, nome);

  try {
    const r = await chamarServidor("definirGrupoDaAprovacao", {
      movInicial: g.movInicial, movFinal: g.movFinal, grupo: nome
    });
    if (!r.ok) {
      mostrarToast("⚠ " + (r.mensagem || "Nao deu para marcar."));
      if (caixa) caixa.innerHTML = chipsDeGrupoAprovacao(idx, g.grupo);
      return;
    }

    g.grupo = nome;
    mostrarToast("✅ " + r.mensagem);
    renderizarAprovacoes();
    alternarDetalheAprovacao(idx);
  } catch (e) {
    mostrarToast("⚠ Sem conexao.");
    if (caixa) caixa.innerHTML = chipsDeGrupoAprovacao(idx, g.grupo);
  }
}

/**
 * Abre o detalhe de um lançamento aguardando aprovação.
 *
 * Fechado por padrão: vencimento, método e parcelas são iguais na maioria das
 * vezes, e mostrá-los sempre foi o que fez sete pendentes virarem três telas.
 * Quando um deles é diferente do resto, ele já aparece como chip na linha --
 * então abrir é para conferir, não para descobrir.
 */
function alternarDetalheAprovacao(idx) {
  const el = document.getElementById("ap-det-" + idx);
  if (!el) return;
  el.style.display = (el.style.display === "none") ? "block" : "none";
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
      const rl = await lerCacheado("listasValidas");
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
      '<span style="color:var(--fraco-2);">Para mudar o número de parcelas, rejeite e lance manualmente.</span>';
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
    const r = await lerCacheado("listarAprovacoes");
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

  // A categoria tem regra? O grupo dela já vem marcado -- e dá para trocar.
  // Mostrar isto aqui é o que transforma a regra em algo visível: senão o
  // lançamento cairia num grupo que ninguém viu escolher.
  const prefixo = seletorCatDestino.split("-")[0];
  if (prefixo === "nd" || prefixo === "dr") sugerirGrupoPelaCategoria(prefixo);
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
// ----------------------------------------------------------------------------
// Os emoji saíram. Nove ícones coloridos em coluna competem entre si e nenhum
// diz o que o relatório faz -- 🧠 para "Previsão Orçamentária" e 🔮 para
// "Projeção Futura" eram dois enfeites para duas coisas que já custam a
// distinguir pelo nome. Sem eles, o que diferencia volta a ser o texto.
//
// O campo "grupo" junta os quinze por PERGUNTA. Numa lista chapada é preciso
// ler todos para achar um; em grupos de três ou quatro, o cabeçalho já
// descarta os que não interessam.
// ----------------------------------------------------------------------------
const GRUPOS_RELATORIO = [
  { id: "mes",        nome: "O mês fechado" },
  { id: "combinados", nome: "Combinados, cartões e fixas" },
  { id: "comparar",   nome: "Comparar e acompanhar" },
  { id: "futuro",     nome: "O que vem pela frente" }
];

const RELATORIOS = {
  dre: {
    nome: "DRE do mês",
    desc: "receitas e despesas por grupo",
    periodo: "mes", grupo: "mes", paginas: 1
  },
  extrato: {
    nome: "Extrato do mês",
    desc: "todos os lançamentos",
    periodo: "mes", grupo: "mes", paginas: 3
  },
  regra503020: {
    nome: "Regra 50/30/20",
    desc: "sobrevivência, estilo de vida e riqueza",
    periodo: "mes", grupo: "mes", paginas: 1
  },

  gruposSaldo: {
    nome: "Grupos de saldo",
    desc: "quanto coube em cada combinado, e o que passa adiante",
    periodo: "mes", grupo: "combinados", paginas: 1
  },
  cartoes: {
    nome: "Fechamento dos cartões",
    desc: "fatura, parcelas antigas e limite preso",
    periodo: "mes", grupo: "combinados", paginas: 2
  },
  fixasRealizado: {
    nome: "Fixas: cadastrado x realizado",
    desc: "o que subiu de preço e o que não foi lançado",
    periodo: "mes", grupo: "combinados", paginas: 1
  },
  miudos: {
    nome: "Onde o dinheiro escorre",
    desc: "a soma das compras pequenas do mês",
    periodo: "mesTeto", grupo: "combinados", paginas: 2
  },

  evolucao: {
    nome: "Evolução mensal",
    desc: "receitas x despesas ao longo do ano",
    periodo: "ano", grupo: "comparar", paginas: 1
  },
  comparacao: {
    nome: "Comparação entre meses",
    desc: "dois meses lado a lado",
    periodo: "doisMeses", grupo: "comparar", paginas: 1
  },
  gastosCategoria: {
    nome: "Gastos por categoria",
    desc: "num período que você escolhe",
    periodo: "intervaloCategorias", grupo: "comparar", paginas: 2
  },
  retratoAno: {
    nome: "Retrato do ano",
    desc: "o ano inteiro numa página",
    periodo: "ano", grupo: "comparar", paginas: 1
  },

  projecao: {
    nome: "Projeção futura",
    desc: "o que já está comprometido",
    periodo: "meses", grupo: "futuro", paginas: 1
  },
  previsao: {
    nome: "Previsão orçamentária",
    desc: "quanto você vai gastar no mês que vem",
    periodo: "janela", grupo: "futuro", paginas: 1
  },
  parcelamentos: {
    nome: "Parcelamentos ativos",
    desc: "o que falta pagar e o progresso",
    periodo: "nenhum", grupo: "futuro", paginas: 1
  },
  planos: {
    nome: "Planos de compra",
    desc: "o que saiu do papel, o que ficou esperando",
    periodo: "ano", grupo: "futuro", paginas: 1
  }
};

const MESES_NOMES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                     "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

// ---------- Tela inicial de relatórios ----------
// ============================================================================
// CONCILIAÇÃO DE FATURA
// ----------------------------------------------------------------------------
// Manda a fatura, o servidor lê e compara com o que está lançado, e a tela
// mostra três listas: o que falta lançar, o que está sobrando no app e o que
// está com valor diferente.
//
// O app SÓ ACRESCENTA. Nada é apagado nem alterado: compra cancelada, estorno
// e lançamento errado se parecem aqui e se resolvem de formas diferentes, e
// nenhuma delas melhora com o app decidindo sozinho.
// ============================================================================
let conciliacaoAtual = null;

function abrirConciliacao() {
  document.getElementById("modal-conciliar").style.display = "flex";
  conciliacaoAtual = null;

  const sel = document.getElementById("cc-cartao");
  sel.innerHTML = (cartoesConfig.length
    ? cartoesConfig
    : [{ nome: "Cartão XP" }, { nome: "Cartão Inter" }]
  ).map(function (c) {
    return '<option value="' + escaparHtml(c.nome) + '">' + escaparHtml(c.nome) + '</option>';
  }).join("");

  const hoje = new Date();
  document.getElementById("cc-mes").innerHTML = opcoesMeses(hoje.getMonth());
  document.getElementById("cc-ano").innerHTML = opcoesAnos(hoje.getFullYear());

  document.getElementById("cc-resultado").innerHTML = "";
  document.getElementById("cc-inicio").style.display = "block";
  document.getElementById("cc-arquivo").value = "";
}

function fecharConciliacao() {
  document.getElementById("modal-conciliar").style.display = "none";
}

async function enviarFaturaParaConciliar() {
  const inp = document.getElementById("cc-arquivo");
  const arq = inp.files && inp.files[0];
  if (!arq) { mostrarToast("Escolha o arquivo da fatura."); return; }

  // Em base64 o arquivo cresce um terço. Acima disso o envio falha sem dizer
  // por quê -- e uma fatura desse tamanho costuma ser foto em resolução
  // máxima, que dá para trocar por uma menor ou pelo PDF do banco.
  if (arq.size > 6 * 1024 * 1024) {
    mostrarToast("Arquivo muito grande (" + Math.round(arq.size / 1048576) +
                 " MB). Use o PDF do banco ou uma foto menor.");
    return;
  }

  const cartao = document.getElementById("cc-cartao").value;
  const alvo = document.getElementById("cc-resultado");

  document.getElementById("cc-inicio").style.display = "none";
  alvo.innerHTML =
    '<div class="card" style="text-align:center; padding:40px 20px;">' +
      '<div class="spinner" style="margin:0 auto 14px;"></div>' +
      '<div style="font-size:13px; color:var(--cinza-texto);">Lendo a fatura e comparando…</div>' +
      '<div style="font-size:11px; color:var(--fraco-2); margin-top:6px;">' +
        'fatura grande costuma levar uns 30 segundos</div>' +
    '</div>';

  try {
    const base64 = await arquivoParaBase64(arq);

    // POST, como o envio de documento. chamarServidor monta um GET com tudo
    // na URL, e a fatura em base64 passa de 1 MB -- a requisição nem chega a
    // sair do navegador, e o erro que aparece é "Failed to fetch".
    const r = await chamarServidorPost("conciliarFatura", {
      arquivo: base64,
      mimeType: arq.type || "application/pdf",
      cartao: cartao,
      // Vai junto como reserva: se a IA não achar o vencimento no documento,
      // o servidor monta a data com este mês e o dia cadastrado do cartão.
      mes: document.getElementById("cc-mes").value,
      ano: document.getElementById("cc-ano").value
    });

    if (!r || !r.ok) {
      const d = r && r.diagnostico;
      alvo.innerHTML = '<div class="card"><p class="vazio">' +
        escaparHtml((r && r.mensagem) || "Não consegui ler a fatura.") + '</p>' +
        // O que a IA devolveu. Sem isso, "não consegui" não diz se ela leu
        // mal uma linha ou se não leu o documento inteiro.
        (d ? '<div class="rel-nota">A leitura devolveu ' + d.itensLidos +
             ' lançamento(s)' +
             (d.banco ? ', banco "' + escaparHtml(d.banco) + '"' : '') +
             (d.vencimentoBruto ? ', vencimento "' + escaparHtml(d.vencimentoBruto) + '"' : '') +
             (d.totalBruto ? ', total "' + escaparHtml(d.totalBruto) + '"' : '') +
             '.</div>'
           : '') +
        '</div>';
      document.getElementById("cc-inicio").style.display = "block";
      return;
    }

    conciliacaoAtual = r;
    pintarConciliacao();

  } catch (e) {
    alvo.innerHTML = '<div class="card"><p class="vazio">Falhou: ' +
      escaparHtml(e.message || "sem conexão") + '</p></div>';
    document.getElementById("cc-inicio").style.display = "block";
  }
}

function arquivoParaBase64(arq) {
  return new Promise(function (ok, erro) {
    const r = new FileReader();
    r.onload = function () { ok((r.result || "").toString().split(",")[1] || ""); };
    r.onerror = function () { erro(new Error("não consegui ler o arquivo")); };
    r.readAsDataURL(arq);
  });
}

function pintarConciliacao() {
  const r = conciliacaoAtual;
  const alvo = document.getElementById("cc-resultado");
  const res = r.resumo;

  // A diferença é a manchete: é ela que você está procurando todo mês.
  const bateu = Math.abs(res.diferenca) < 0.01;

  let html =
    '<div class="card">' +
      '<div class="nv-heroi ' + (bateu ? "verde" : "laranja") + '">' +
        (bateu ? "Bateu" : formatarMoeda(Math.abs(res.diferenca))) +
      '</div>' +
      '<div class="nv-heroi-rot">' +
        (bateu
          ? "a fatura e o app fecham no mesmo valor"
          : (res.diferenca > 0 ? "a mais na fatura do que no app" : "a mais no app do que na fatura")) +
      '</div>' +
      nvLinha("Fatura " + escaparHtml(r.vencimento), formatarMoeda(res.somaFatura)) +
      nvLinha("Lançado no app", formatarMoeda(res.somaApp)) +
      nvLinha("Linhas que casaram", res.casados + " de " + res.itensFatura) +
      (Math.abs(r.totalDeclarado - res.somaFatura) > 0.01
        ? '<div class="rel-nota">A fatura declara ' + formatarMoeda(r.totalDeclarado) +
          ' no topo, e as linhas que consegui ler somam ' + formatarMoeda(res.somaFatura) +
          '. A diferença pode ser linha que não foi lida — confira antes de lançar.</div>'
        : '') +
    '</div>';

  // ---- o que falta lançar ----
  if (r.faltando.length) {
    let itens = "";
    r.faltando.forEach(function (it, i) {
      itens +=
        '<div class="cc-item">' +
          '<label class="cc-marca">' +
            '<input type="checkbox" id="cc-f-' + i + '"' +
              (it.precisaCategoria ? "" : " checked") + ' />' +
          '</label>' +
          '<div class="cc-txt">' +
            '<div class="cc-nome">' + escaparHtml(it.descricao) +
              (it.totalParcelas > 1
                ? ' <span class="cinza">' + it.parcela + "/" + it.totalParcelas + '</span>'
                : '') +
            '</div>' +
            '<div class="cc-sub">' + escaparHtml(it.data) + '</div>' +
            '<select class="cc-cat" id="cc-cat-' + i + '">' +
              opcoesDeCategoria(it.categoriaSugerida) +
            '</select>' +
          '</div>' +
          '<div class="cc-valor">' + formatarMoeda(it.valor) + '</div>' +
        '</div>';
    });

    html +=
      '<div class="card">' +
        '<h2>Falta lançar · ' + r.faltando.length + '</h2>' +
        '<div class="rel-nota" style="margin:0 0 10px; border:none; padding:0;">' +
          'Está na fatura e não está no app. Confira a categoria antes de lançar.' +
        '</div>' +
        itens +
        '<button class="btn-modal confirmar" style="width:100%; margin-top:12px;" ' +
        'onclick="lancarFaltantes()">Lançar os marcados</button>' +
      '</div>';
  }

  // ---- o que está sobrando ----
  if (r.sobrando.length) {
    let itens = "";
    r.sobrando.forEach(function (l) {
      itens += '<div class="cc-item">' +
        '<div class="cc-txt"><div class="cc-nome">' + escaparHtml(l.descricao) + '</div>' +
        '<div class="cc-sub">' + escaparHtml(l.data) +
          (l.totalParcelas > 1 ? ' · ' + l.parcela + "/" + l.totalParcelas : '') +
          ' · nº ' + l.numMov + '</div></div>' +
        '<div class="cc-valor">' + formatarMoeda(l.valor) + '</div></div>';
    });

    html +=
      '<div class="card">' +
        '<h2>Está no app e não na fatura · ' + r.sobrando.length + '</h2>' +
        '<div class="rel-nota" style="margin:0 0 10px; border:none; padding:0;">' +
          'Pode ser compra cancelada, estorno ou lançamento no cartão errado. ' +
          'O app não apaga nada — se algum estiver errado, apague pela tela de ' +
          'Lançamentos, onde dá para ver a ficha inteira antes.' +
        '</div>' +
        itens +
      '</div>';
  }

  // ---- valores diferentes ----
  if (r.divergentes.length) {
    let itens = "";
    r.divergentes.forEach(function (d) {
      itens += '<div class="cc-item">' +
        '<div class="cc-txt"><div class="cc-nome">' + escaparHtml(d.descricao) + '</div>' +
        '<div class="cc-sub">app ' + formatarMoeda(d.noApp) +
          ' · fatura ' + formatarMoeda(d.naFatura) + ' · nº ' + d.numMov + '</div></div>' +
        '<div class="cc-valor ' + (d.diferenca > 0 ? "vermelho" : "verde") + '">' +
          (d.diferenca > 0 ? "+" : "") + formatarMoeda(d.diferenca) + '</div></div>';
    });

    html += '<div class="card"><h2>Valor diferente · ' + r.divergentes.length + '</h2>' +
      '<div class="rel-nota" style="margin:0 0 10px; border:none; padding:0;">' +
      'Mesma compra, valor diferente. Corrija pela ficha do lançamento.</div>' +
      itens + '</div>';
  }

  if (!r.faltando.length && !r.sobrando.length && !r.divergentes.length) {
    html += '<div class="card"><p class="vazio">Nada a conciliar: todas as linhas ' +
      'da fatura casaram com o que está lançado.</p></div>';
  }

  alvo.innerHTML = html;
}

/** As categorias do plano de contas, com a sugerida já escolhida. */
function opcoesDeCategoria(sugerida) {
  const cats = (listasValidas && listasValidas.categorias) || [];
  let o = '<option value="">— escolha a categoria —</option>';
  cats.forEach(function (c) {
    if (c.indexOf("2.") !== 0) return;   // conciliação de fatura é despesa
    o += '<option value="' + escaparHtml(c) + '"' +
         (c === sugerida ? " selected" : "") + '>' + escaparHtml(nomeDaCategoria(c)) + '</option>';
  });
  return o;
}

async function lancarFaltantes() {
  if (!conciliacaoAtual) return;

  const escolhidos = [];
  conciliacaoAtual.faltando.forEach(function (it, i) {
    const marcado = document.getElementById("cc-f-" + i);
    if (!marcado || !marcado.checked) return;

    const cat = document.getElementById("cc-cat-" + i);
    escolhidos.push({
      descricao: it.descricao,
      valor: it.valor,
      totalParcelas: it.totalParcelas,
      data: it.data,
      categoria: cat ? cat.value : ""
    });
  });

  if (!escolhidos.length) { mostrarToast("Marque o que você quer lançar."); return; }

  const semCategoria = escolhidos.filter(function (x) { return !x.categoria; });
  if (semCategoria.length) {
    mostrarToast(semCategoria.length + " item(ns) sem categoria. Sem ela o lançamento não aparece no balanço.");
    return;
  }

  mostrarToast("Lançando…");
  try {
    const r = await chamarServidorPost("aplicarConciliacao", {
      cartao: conciliacaoAtual.cartao,
      itens: JSON.stringify(escolhidos)
    });

    mostrarToast((r && r.mensagem) || "Pronto.");
    if (r && r.ok) {
      esquecerDominio("transacoes");
      fecharConciliacao();
      await recarregarDados();
    }
  } catch (e) {
    mostrarToast("Falhou: " + (e.message || "sem conexão"));
  }
}

// ============================================================================
// PRESTAÇÃO DE CONTAS
// ----------------------------------------------------------------------------
// Vários relatórios num documento só, com capa, índice e assinaturas.
//
// Os MODELOS ficam no localStorage: é decisão de formato, muda pouco, e não
// precisa sincronizar entre aparelhos para funcionar -- mesmo critério do
// rascunho de roteiro. Guardar na planilha custaria uma leitura por abertura
// da tela para uma lista de dois itens.
//
// A montagem faz UMA chamada por relatório, em série. É o mesmo caminho que
// gerar um relatório avulso já usa: uma ação nova no servidor que devolvesse
// todos de uma vez seria mais rápida, mas duplicaria o roteador de relatórios
// e estouraria o tempo do Apps Script justamente nos documentos grandes.
// Em série, um relatório que falha não derruba os outros.
// ============================================================================
const MODELOS_CHAVE = "sb_modelos_pc";

function lerModelos() {
  try {
    const bruto = localStorage.getItem(MODELOS_CHAVE);
    if (!bruto) return [modeloPadrao()];
    const lista = JSON.parse(bruto);
    return Array.isArray(lista) && lista.length ? lista : [modeloPadrao()];
  } catch (e) {
    return [modeloPadrao()];
  }
}

function salvarModelos(lista) {
  try { localStorage.setItem(MODELOS_CHAVE, JSON.stringify(lista)); } catch (e) {}
}

/** O primeiro modelo já vem montado: tela vazia não ensina o que ela faz. */
function modeloPadrao() {
  return {
    nome: "Fechamento do mês",
    relatorios: ["dre", "gruposSaldo", "cartoes", "extrato"],
    assinaturas: ["", ""]
  };
}

function paginasDoModelo(m) {
  let n = 1;   // a capa
  m.relatorios.forEach(function (k) {
    n += (RELATORIOS[k] && RELATORIOS[k].paginas) || 1;
  });
  return n;
}

function htmlModelosDeFechamento() {
  const modelos = lerModelos();
  const hoje = new Date();
  const mes = MESES_NOMES[mesExibido] || MESES_NOMES[hoje.getMonth()];
  const ano = anoExibido || hoje.getFullYear();

  let cartoes = "";
  modelos.forEach(function (m, i) {
    const n = m.relatorios.length;
    cartoes +=
      '<div class="pc-cartao">' +
        '<div class="pc-topo">' +
          '<div style="flex:1;">' +
            '<div class="pc-nome">' + escaparHtml(m.nome) + '</div>' +
            '<div class="pc-sub">' + n + (n === 1 ? " relatório" : " relatórios") +
              ' &middot; ' + paginasDoModelo(m) + ' páginas</div>' +
          '</div>' +
          '<button class="pc-icone" onclick="abrirMontadorPC(' + i + ')" aria-label="Editar modelo">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"></path></svg>' +
          '</button>' +
        '</div>' +
        '<button class="pc-btn" style="width:100%;" onclick="montarPrestacao(' + i + ')">' +
          'Montar de ' + escaparHtml(mes.toLowerCase()) + ' ' + ano +
        '</button>' +
      '</div>';
  });

  return '<div class="rel-secao">' +
      '<div class="rel-secao-rot">Prestação de contas</div>' +
      cartoes +
      '<div class="pc-linha">' +
        '<button class="pc-btn neutro" onclick="abrirMontadorPC(-1)">Novo modelo</button>' +
        '<button class="pc-btn neutro" onclick="abrirConciliacao()">Conferir fatura</button>' +
      '</div>' +
    '</div>';
}

// ---------------------------------------------------------------------------
// O MONTADOR
// ---------------------------------------------------------------------------
let modeloEditando = null;
let modeloIndice = -1;

function abrirMontadorPC(indice) {
  const modelos = lerModelos();
  modeloIndice = indice;
  modeloEditando = indice >= 0
    ? JSON.parse(JSON.stringify(modelos[indice]))
    : { nome: "Novo modelo", relatorios: ["dre"], assinaturas: ["", ""] };

  document.getElementById("modal-pc").style.display = "flex";
  pintarMontadorPC();
}

function fecharMontadorPC() {
  document.getElementById("modal-pc").style.display = "none";
  modeloEditando = null;
}

function pintarMontadorPC() {
  const m = modeloEditando;
  if (!m) return;

  document.getElementById("pc-nome-campo").value = m.nome;
  document.getElementById("pc-ass1").value = (m.assinaturas || ["", ""])[0] || "";
  document.getElementById("pc-ass2").value = (m.assinaturas || ["", ""])[1] || "";

  // ---- os escolhidos, na ordem do documento ----
  let escolhidos =
    '<div class="pc-item">' +
      '<span class="pc-marca on"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 12.5l4.5 4.5L19 7"></path></svg></span>' +
      '<span class="pc-item-txt"><span class="pc-item-nome">Capa</span>' +
        '<span class="pc-item-sub">título, resumo do mês e assinaturas</span></span>' +
      '<span class="pc-item-sub">fixa</span>' +
    '</div>';

  m.relatorios.forEach(function (k, i) {
    const r = RELATORIOS[k];
    if (!r) return;
    escolhidos +=
      '<div class="pc-item">' +
        '<button class="pc-marca on" onclick="tirarDoModelo(' + i + ')" aria-label="Tirar">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M5 12.5l4.5 4.5L19 7"></path></svg>' +
        '</button>' +
        '<span class="pc-item-txt">' +
          '<span class="pc-item-nome">' + escaparHtml(r.nome) + '</span>' +
          '<span class="pc-item-sub">' + (r.paginas || 1) +
            ((r.paginas || 1) === 1 ? " página" : " páginas") + '</span>' +
        '</span>' +
        '<span class="pc-ord">' +
          '<button onclick="moverNoModelo(' + i + ',-1)"' + (i === 0 ? " disabled" : "") +
            ' aria-label="Subir">&#9650;</button>' +
          '<button onclick="moverNoModelo(' + i + ',1)"' +
            (i === m.relatorios.length - 1 ? " disabled" : "") + ' aria-label="Descer">&#9660;</button>' +
        '</span>' +
      '</div>';
  });
  document.getElementById("pc-escolhidos").innerHTML = escolhidos;

  // ---- o que dá para acrescentar ----
  let resto = "";
  GRUPOS_RELATORIO.forEach(function (g) {
    const livres = Object.keys(RELATORIOS).filter(function (k) {
      return RELATORIOS[k].grupo === g.id && m.relatorios.indexOf(k) < 0;
    });
    if (!livres.length) return;

    resto += '<div class="pc-item-sub" style="margin:12px 0 2px 2px;">' +
             escaparHtml(g.nome) + '</div>';
    livres.forEach(function (k) {
      const r = RELATORIOS[k];
      resto +=
        '<button class="pc-item" onclick="porNoModelo(\'' + k + '\')">' +
          '<span class="pc-marca"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M5 12.5l4.5 4.5L19 7"></path></svg></span>' +
          '<span class="pc-item-txt">' +
            '<span class="pc-item-nome">' + escaparHtml(r.nome) + '</span>' +
            '<span class="pc-item-sub">' + escaparHtml(r.desc) + '</span>' +
          '</span>' +
        '</button>';
    });
  });
  document.getElementById("pc-resto").innerHTML = resto ||
    '<p class="vazio">Todos os relatórios já estão no documento.</p>';

  document.getElementById("pc-contador").textContent =
    m.relatorios.length + " de " + Object.keys(RELATORIOS).length + " relatórios escolhidos";
  document.getElementById("pc-btn-montar").textContent =
    "Montar · " + paginasDoModelo(m) + " páginas";
  document.getElementById("pc-btn-excluir").style.display =
    modeloIndice >= 0 && lerModelos().length > 1 ? "block" : "none";
}

/** Leva para o modelo o que esta escrito nos campos AGORA. */
function capturarCamposPC() {
  if (!modeloEditando) return;
  const n = document.getElementById("pc-nome-campo");
  const a1 = document.getElementById("pc-ass1");
  const a2 = document.getElementById("pc-ass2");
  if (n) modeloEditando.nome = n.value;
  if (a1 && a2) modeloEditando.assinaturas = [a1.value, a2.value];
}

function porNoModelo(tipo) {
  if (!modeloEditando) return;
  capturarCamposPC();
  if (modeloEditando.relatorios.indexOf(tipo) < 0) modeloEditando.relatorios.push(tipo);
  pintarMontadorPC();
}

function tirarDoModelo(i) {
  if (!modeloEditando) return;
  capturarCamposPC();
  modeloEditando.relatorios.splice(i, 1);
  pintarMontadorPC();
}

function moverNoModelo(i, dir) {
  if (!modeloEditando) return;
  capturarCamposPC();
  const j = i + dir;
  const lista = modeloEditando.relatorios;
  if (j < 0 || j >= lista.length) return;
  const tmp = lista[i]; lista[i] = lista[j]; lista[j] = tmp;
  pintarMontadorPC();
}

function guardarModeloAtual() {
  if (!modeloEditando) return null;
  modeloEditando.nome = document.getElementById("pc-nome-campo").value.trim() || "Sem nome";
  modeloEditando.assinaturas = [
    document.getElementById("pc-ass1").value.trim(),
    document.getElementById("pc-ass2").value.trim()
  ];

  const modelos = lerModelos();
  if (modeloIndice >= 0) modelos[modeloIndice] = modeloEditando;
  else { modelos.push(modeloEditando); modeloIndice = modelos.length - 1; }
  salvarModelos(modelos);
  return modeloEditando;
}

function salvarModeloPC() {
  if (!guardarModeloAtual()) return;
  fecharMontadorPC();
  renderizarTelaRelatorios();
  mostrarToast("Modelo salvo.");
}

function excluirModeloPC() {
  if (modeloIndice < 0) return;
  const modelos = lerModelos();
  if (modelos.length <= 1) return;
  if (!confirm("Apagar o modelo \"" + modelos[modeloIndice].nome + "\"?")) return;
  modelos.splice(modeloIndice, 1);
  salvarModelos(modelos);
  fecharMontadorPC();
  renderizarTelaRelatorios();
}

/** Do montador direto para o documento, salvando o que foi mexido. */
async function montarDoMontador() {
  const m = guardarModeloAtual();
  if (!m) return;
  fecharMontadorPC();
  await montarPrestacao(modeloIndice);
}

// ---------------------------------------------------------------------------
// A MONTAGEM
// ---------------------------------------------------------------------------

/**
 * Os parâmetros de um relatório a partir do MÊS do documento.
 *
 * O mês vale para o documento inteiro: perguntar o período cinco vezes
 * transformaria "montar o fechamento" num formulário. Relatório que pede
 * outro recorte usa este mês como referência.
 */
function paramsDoRelatorio(tipo, mes, ano) {
  const r = RELATORIOS[tipo];
  const p = { tipoRel: tipo };

  if (r.periodo === "mes") { p.mes = mes; p.ano = ano; }
  else if (r.periodo === "mesTeto") { p.mes = mes; p.ano = ano; p.teto = 50; }
  else if (r.periodo === "ano") { p.ano = ano; }
  else if (r.periodo === "meses" || r.periodo === "janela") { p.meses = 6; }
  else if (r.periodo === "doisMeses") {
    // Contra o mês anterior: num fechamento é a comparação que interessa.
    const antes = mes === 0 ? 11 : mes - 1;
    const anoAntes = mes === 0 ? ano - 1 : ano;
    p.mesA = antes; p.anoA = anoAntes; p.mesB = mes; p.anoB = ano;
  } else if (r.periodo === "intervaloCategorias") {
    const dois = function (n) { return (n < 10 ? "0" : "") + n; };
    const ultimo = new Date(ano, mes + 1, 0).getDate();
    p.dataInicio = ano + "-" + dois(mes + 1) + "-01";
    p.dataFim = ano + "-" + dois(mes + 1) + "-" + dois(ultimo);
    p.categorias = "";
  }
  return p;
}

async function montarPrestacao(indice) {
  const modelos = lerModelos();
  const m = modelos[indice];
  if (!m || !m.relatorios.length) {
    mostrarToast("Este modelo não tem relatório nenhum.");
    return;
  }

  const mes = mesExibido;
  const ano = anoExibido;
  const wrap = document.getElementById("conteudo-rel");

  const prontos = [];
  const falharam = [];

  for (let i = 0; i < m.relatorios.length; i++) {
    const tipo = m.relatorios[i];
    const r = RELATORIOS[tipo];

    wrap.innerHTML =
      '<div class="card" style="text-align:center; padding:46px 20px;">' +
        '<div class="spinner" style="margin:0 auto 16px;"></div>' +
        '<div style="font-size:14px; font-weight:700; color:var(--texto);">Montando ' +
          (i + 1) + ' de ' + m.relatorios.length + '</div>' +
        '<div style="font-size:12px; color:var(--cinza-texto); margin-top:6px;">' +
          escaparHtml(r ? r.nome : tipo) + '</div>' +
      '</div>';

    try {
      const res = await chamarServidor("gerarRelatorio", paramsDoRelatorio(tipo, mes, ano));
      // Um relatório que falha não derruba o documento: ele entra como uma
      // página dizendo o que faltou, e o resto segue.
      if (res && res.ok) prontos.push({ tipo: tipo, res: res });
      else falharam.push({ tipo: tipo, motivo: (res && res.mensagem) || "não veio" });
    } catch (e) {
      falharam.push({ tipo: tipo, motivo: "sem conexão" });
    }
  }

  renderizarPrestacao(m, mes, ano, prontos, falharam);
}

function renderizarPrestacao(modelo, mes, ano, prontos, falharam) {
  const wrap = document.getElementById("conteudo-rel");

  let corpo = "";
  prontos.forEach(function (p) {
    let html = "";
    const res = p.res;
    if (res.tipo === "evolucao")            html = htmlEvolucao(res);
    else if (res.tipo === "comparacao")     html = htmlComparacao(res);
    else if (res.tipo === "regra503020")    html = htmlRegra(res);
    else if (res.tipo === "dre")            html = htmlDRE(res);
    else if (res.tipo === "parcelamentos")  html = htmlParcelamentos(res);
    else if (res.tipo === "projecao")       html = htmlProjecao(res);
    else if (res.tipo === "extrato")        html = htmlExtrato(res);
    else if (res.tipo === "previsao")       html = htmlPrevisao(res);
    else if (res.tipo === "gastosCategoria") html = htmlGastosCategoria(res);
    else if (res.tipo === "gruposSaldo")    html = htmlGruposSaldo(res);
    else if (res.tipo === "cartoes")        html = htmlCartoes(res);
    else if (res.tipo === "miudos")         html = htmlMiudos(res);
    else if (res.tipo === "fixasRealizado") html = htmlFixasRealizado(res);
    else if (res.tipo === "retratoAno")     html = htmlRetratoAno(res);
    else if (res.tipo === "planos")         html = htmlPlanos(res);

    corpo +=
      '<div class="pc-bloco">' +
        '<div class="rel-cabecalho" style="margin-bottom:14px;">' +
          '<h1>' + escaparHtml(res.meta.titulo) + '</h1>' +
          '<p class="rc-sub">' + escaparHtml(res.meta.subtitulo) + '</p>' +
        '</div>' +
        html +
      '</div>';
  });

  falharam.forEach(function (f) {
    const r = RELATORIOS[f.tipo];
    corpo +=
      '<div class="pc-bloco"><div class="card">' +
        '<h2>' + escaparHtml(r ? r.nome : f.tipo) + '</h2>' +
        '<p class="vazio">Não entrou no documento: ' + escaparHtml(f.motivo) + '.</p>' +
      '</div></div>';
  });

  wrap.innerHTML =
    '<div class="rel-barra">' +
      '<button class="rb-btn" onclick="renderizarTelaRelatorios()">&#8249; Voltar</button>' +
      '<div class="rb-acoes">' +
        '<button class="rb-btn" onclick="compartilharPrestacao()">Compartilhar</button>' +
        '<button class="rb-btn" onclick="imprimirRelatorio()">Imprimir</button>' +
      '</div>' +
    '</div>' +
    '<div id="rel-imprimivel">' +
      '<div class="pc-corrido">' + escaparHtml(modelo.nome.toUpperCase()) + ' &middot; ' +
        escaparHtml((MESES_NOMES[mes] || "").toUpperCase()) + ' DE ' + ano + '</div>' +
      htmlCapaPrestacao(modelo, mes, ano, prontos, falharam) +
      corpo +
    '</div>';

  window.scrollTo(0, 0);
}

/**
 * A capa.
 *
 * Os três números saem do CACHE do mês, pelo mesmo resumoDoMes que o balanço
 * usa -- nenhuma chamada a mais, e o número da capa não diverge do da tela.
 * Sem o mês guardado, a capa sai sem eles em vez de mostrar zero: zero numa
 * prestação de contas é uma afirmação, não uma ausência.
 */
function htmlCapaPrestacao(modelo, mes, ano, prontos, falharam) {
  const cache = lerCache(mes, ano);
  const r = cache ? resumoDoMes(cache.dados) : null;

  const ultimo = new Date(ano, mes + 1, 0).getDate();
  const dois = function (n) { return (n < 10 ? "0" : "") + n; };

  let indice = "";
  let pagina = 2;
  prontos.forEach(function (p) {
    const def = RELATORIOS[p.tipo];
    const n = (def && def.paginas) || 1;
    const faixa = n > 1 ? (pagina + "–" + (pagina + n - 1)) : String(pagina);
    indice +=
      '<div class="pcc-idx"><span>' + escaparHtml(p.res.meta.titulo) + '</span>' +
      '<span class="pcc-pont"></span><span>' + faixa + '</span></div>';
    pagina += n;
  });
  falharam.forEach(function (f) {
    const def = RELATORIOS[f.tipo];
    indice += '<div class="pcc-idx"><span>' + escaparHtml(def ? def.nome : f.tipo) +
      '</span><span class="pcc-pont"></span><span>—</span></div>';
  });

  const ass = modelo.assinaturas || ["", ""];

  return (
    '<div class="pc-capa">' +
      '<div class="pcc-rot">PRESTAÇÃO DE CONTAS</div>' +
      '<div class="pcc-titulo">' + escaparHtml(MESES_NOMES[mes] || "") + '<br>de ' + ano + '</div>' +
      '<div class="pcc-risco"></div>' +
      '<div class="pcc-periodo">' +
        (modelo.nome ? escaparHtml(modelo.nome) + '<br>' : '') +
        'Período de 01/' + dois(mes + 1) + '/' + ano +
        ' a ' + dois(ultimo) + '/' + dois(mes + 1) + '/' + ano +
      '</div>' +

      (r
        ? '<div class="pcc-numeros">' +
            '<div><span>ENTROU</span><b>' + formatarMoeda(r.receita) + '</b></div>' +
            '<div><span>SAIU</span><b>' + formatarMoeda(r.despesas + r.fixasNaConta) + '</b></div>' +
            '<div><span>' + (r.sobra >= 0 ? "SOBROU" : "FALTOU") + '</span>' +
              '<b class="' + (r.sobra >= 0 ? "verde" : "vermelho") + '">' +
              (r.supondo ? "≈ " : "") + formatarMoeda(Math.abs(r.sobra)) + '</b></div>' +
          '</div>' +
          (r.supondo
            ? '<div class="pcc-aviso">Mês de previsão: a receita é a última conhecida ' +
              'e as fixas ainda não lançadas já estão descontadas.</div>'
            : '')
        : '<div class="pcc-aviso">Os totais do mês não estavam guardados no aparelho ' +
          'quando este documento foi montado.</div>') +

      '<div class="pcc-indice"><div class="pcc-idx-rot">NESTE DOCUMENTO</div>' + indice + '</div>' +

      '<div class="pcc-assinaturas">' +
        '<div><span>' + escaparHtml(ass[0] || " ") + '</span></div>' +
        '<div><span>' + escaparHtml(ass[1] || " ") + '</span></div>' +
      '</div>' +

      '<div class="pcc-rodape">Gerado pelo Smartbalanço em ' +
        escaparHtml(new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })) +
      '</div>' +
    '</div>'
  );
}

async function compartilharPrestacao() {
  const texto = document.getElementById("rel-imprimivel");
  if (!texto) return;
  try {
    await navigator.share({ title: "Prestação de contas", text: texto.innerText.slice(0, 4000) });
  } catch (e) {
    mostrarToast("Use Imprimir → Salvar como PDF para enviar o documento.");
  }
}

/** Um ícone de documento, o mesmo para todo relatório salvo. */
const ICONE_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path>' +
  '<path d="M14 3v5h5"></path></svg>';

function renderizarTelaRelatorios() {
  const wrap = document.getElementById("conteudo-rel");

  // ---- A prestação de contas vem primeiro: é o que se faz todo mês.
  // Relatório avulso é consulta, e consulta não disputa espaço com rotina.
  let html = htmlModelosDeFechamento();

  // ---- Salvos: era um card inteiro, com título próprio, para uma lista que
  // costuma ter uma linha.
  const salvos = lerRelatoriosSalvos();
  if (salvos.length > 0) {
    let itens = "";
    salvos.forEach(function (x, i) {
      itens +=
        '<div class="rel-salvo">' +
          '<button class="rs-abrir" onclick="abrirRelatorioSalvo(' + i + ')">' +
            '<span class="rs-icone">' + ICONE_DOC + '</span>' +
            '<span class="rs-info">' +
              '<b>' + escaparHtml(x.meta.titulo) + '</b>' +
              '<span>' + escaparHtml(x.meta.subtitulo) + ' &middot; ' + escaparHtml(x.meta.geradoEm) + '</span>' +
            '</span>' +
          '</button>' +
          '<button class="rs-excluir" onclick="excluirRelatorioSalvo(' + i + ')" aria-label="Apagar">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 7h16"></path><path d="M9 7V5h6v2"></path>' +
            '<path d="M6 7l1 13h10l1-13"></path></svg>' +
          '</button>' +
        '</div>';
    });

    html += '<div class="rel-secao"><div class="rel-secao-rot">Salvos no aparelho</div>' +
            '<div class="rel-lista">' + itens + '</div></div>';
  }

  // ---- Os relatórios, em grupos.
  GRUPOS_RELATORIO.forEach(function (g) {
    const doGrupo = Object.keys(RELATORIOS).filter(function (k) {
      return RELATORIOS[k].grupo === g.id;
    });
    if (!doGrupo.length) return;

    let itens = "";
    doGrupo.forEach(function (k) {
      const r = RELATORIOS[k];
      itens +=
        '<button class="rel-opcao" onclick="abrirPeriodo(\'' + k + '\')">' +
          '<span class="ro-info">' +
            '<b>' + escaparHtml(r.nome) + '</b>' +
            '<span>' + escaparHtml(r.desc) + '</span>' +
          '</span>' +
          '<span class="ro-seta">&#8250;</span>' +
        '</button>';
    });

    html += '<div class="rel-secao"><div class="rel-secao-rot">' + escaparHtml(g.nome) + '</div>' +
            '<div class="rel-lista">' + itens + '</div></div>';
  });

  wrap.innerHTML = html;
}

// ---------- Seletor de período ----------
let relTipoEscolhido = null;

async function abrirPeriodo(tipo) {
  relTipoEscolhido = tipo;
  const r = RELATORIOS[tipo];

  // Se o relatório usa categorias, garante que as listas estão carregadas
  if (r.periodo === "intervaloCategorias" && !listasValidas) {
    try {
      const rl = await lerCacheado("listasValidas");
      if (rl.ok) listasValidas = { categorias: rl.categorias, metodos: rl.metodos };
    } catch (e) { listasValidas = { categorias: [], metodos: [] }; }
  }

  document.getElementById("modal-periodo").style.display = "flex";
  document.getElementById("mp-titulo").textContent = r.nome;

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

  } else if (r.periodo === "mesTeto") {
    // O teto é a pergunta do relatório, não um detalhe: "pequeno" é R$ 20
    // para uns e R$ 100 para outros, e o número muda o que ele revela.
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
      '</div>' +
      '<div class="campo-bloco">' +
        '<label for="mp-teto">Considerar compras de até</label>' +
        '<select id="mp-teto">' +
          '<option value="20">R$ 20,00</option>' +
          '<option value="50" selected>R$ 50,00</option>' +
          '<option value="100">R$ 100,00</option>' +
          '<option value="200">R$ 200,00</option>' +
        '</select>' +
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
  } else if (r.periodo === "mesTeto") {
    params.mes = document.getElementById("mp-mes").value;
    params.ano = document.getElementById("mp-ano").value;
    params.teto = document.getElementById("mp-teto").value;
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

  // Os três relatórios que olham para a frente aceitam somar os planos.
  if (relComPlanos) params.comPlanos = "1";

  try {
    const res = await chamarServidor("gerarRelatorio", params);
    if (res.ok) {
      relatorioAtual = res;
      relatorioParams = params;
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

// Se os planos de compra entram nas contas dos relatórios que olham para a
// frente. Fica desligado por padrão: o número real é a pergunta principal, e
// o dos planos é um "e se" -- ligado por padrão, viraria o número de sempre.
let relComPlanos = false;
let relatorioParams = null;

const REL_ACEITAM_PLANOS = ["parcelamentos", "projecao", "previsao"];

/**
 * O interruptor, com os dois números lado a lado.
 *
 * Mostrar o valor real E o com planos ao mesmo tempo é o ponto: alternar sem
 * ver os dois faria você comparar de memória.
 */
function interruptorPlanos(res) {
  if (REL_ACEITAM_PLANOS.indexOf(res.tipo) < 0) return "";

  const temPlanos = (res.totalPlanos || 0) > 0;

  return '<div class="rel-planos">' +
      '<label class="rel-planos-linha">' +
        '<input type="checkbox"' + (relComPlanos ? " checked" : "") +
          ' onchange="alternarPlanosNoRelatorio()" />' +
        '<span>somar os planos de compra</span>' +
      '</label>' +
      (relComPlanos && temPlanos
        ? '<div class="rel-planos-num">' +
            '<span>real <b>' + formatarMoeda(res.total || 0) + '</b></span>' +
            '<span>com planos <b>' + formatarMoeda((res.total || 0) + res.totalPlanos) + '</b></span>' +
          '</div>'
        : '') +
      (relComPlanos && !temPlanos
        ? '<div class="rel-planos-nota">Nenhum plano aberto pesa neste período.</div>'
        : '') +
      (!relComPlanos
        ? '<div class="rel-planos-nota">O que você ainda não comprou fica de fora deste número.</div>'
        : '') +
    '</div>';
}

async function alternarPlanosNoRelatorio() {
  relComPlanos = !relComPlanos;
  if (!relatorioParams) return;

  const p = Object.assign({}, relatorioParams);
  if (relComPlanos) p.comPlanos = "1"; else delete p.comPlanos;

  try {
    const res = await chamarServidor("gerarRelatorio", p);
    if (res.ok) { relatorioAtual = res; relatorioParams = p; renderizarRelatorio(res, false); }
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

/**
 * A barra: para onde vai a receita do mês.
 *
 * Substituiu quatro números soltos (receita, despesas, pagas, pendentes) que
 * contavam a mesma história duas vezes. A barra diz o mesmo com PROPORÇÃO --
 * dá para ver que o mês está no limite sem ler número nenhum -- e os quatro
 * valores continuam escritos embaixo, na legenda.
 *
 * A base é a receita, não a despesa: a pergunta é quanto do que entrou já
 * está comprometido.
 */
/** Quais barras estão mostrando porcentagem. Some ao trocar de mês. */
let barrasEmPct = {};

function alternarPct(qual) {
  barrasEmPct[qual] = !barrasEmPct[qual];
  if (dashboardAtual) preencherDashboard(dashboardAtual);
}

/** "R$ 5.602,30" ou "R$ 5.602,30 · 67%", conforme a barra esteja alternada. */
function valorOuPct(qual, valor, total) {
  if (!barrasEmPct[qual] || !total) return formatarMoeda(valor);
  return formatarMoeda(valor) + " · " + Math.round((valor / total) * 100) + "%";
}

// ============================================================================
// MODO DRE — a mesma barra respondendo outra pergunta
// ----------------------------------------------------------------------------
// A barra normal responde "quanto já saiu e quanto ainda sai". Esta responde
// "saiu PARA ONDE". São perguntas diferentes sobre o mesmo mês, e por isso
// dividem o mesmo lugar em vez de virarem dois cards: duas barras empilhadas
// fariam procurar qual delas é a que interessa agora.
//
// A escolha fica guardada: quem liga o DRE quer vê-lo amanhã também, e voltar
// ao modo normal a cada abertura transformaria um modo em um clique repetido.
// ============================================================================
let modoDRE = false;
try { modoDRE = localStorage.getItem("sb_modo_dre") === "1"; } catch (e) {}

/** "65,4" e não "65.4". Uma casa só: a segunda não muda decisão nenhuma. */
function pctBR(v) {
  return (Math.round((v || 0) * 10) / 10).toLocaleString("pt-BR");
}

/**
 * O rótulo de uma linha do DRE: o código e o nome.
 *
 * O código vem na frente e em tom apagado. Ele é a chave do plano de contas --
 * é por ele que a linha se acha na planilha --, mas quem varre a lista lê o
 * NOME: deixar os dois com o mesmo peso faria a coluna virar uma parede de
 * números iguais, todos começando com "2.".
 *
 * Sem nome, fica só o código, sem repetição.
 */
function rotuloDRE(chave, nome) {
  const cod = '<i class="dre-cod">' + escaparHtml(chave) + '</i>';
  if (!nome || nome === chave) return cod;
  return cod + ' ' + escaparHtml(nome);
}

function alternarModoDRE() {
  modoDRE = !modoDRE;
  try { localStorage.setItem("sb_modo_dre", modoDRE ? "1" : "0"); } catch (e) {}
  if (dashboardAtual) preencherDashboard(dashboardAtual);
}

/** A barra repartida pelo plano de contas. Devolve se conseguiu pintar. */
function pintarBarraDRE(d) {
  const dre = d.dre;
  if (!dre || !dre.grupos || !dre.grupos.length || !(dre.total > 0)) return false;

  document.getElementById("sd-barra-rotulo").textContent = "GASTO DO MÊS";
  document.getElementById("sd-barra-total").textContent = formatarMoeda(dre.total);

  const elBarra = document.getElementById("sd-barra");
  elBarra.classList.add("dre");
  elBarra.innerHTML = dre.grupos.map(function (g) {
    return '<span style="width:' + Math.max(0, g.pct) + '%; background:' +
           escaparHtml(g.cor) + '" title="' + escaparHtml(g.nome) + '"></span>';
  }).join("");
  elBarra.onclick = abrirDRE;
  elBarra.style.cursor = "pointer";

  // A marca do limite sai: ela compara com a RECEITA, e aqui a barra inteira
  // é despesa. Deixá-la viraria uma linha medindo outra régua.
  document.getElementById("sd-limite").style.display = "none";

  // SÓ OS MAIORES na legenda do card. Onze linhas embaixo de um card é uma
  // parede: quem olha quer saber para onde foi a maior parte, e a cauda de
  // grupos abaixo de 1% não responde isso -- ela só empurra o resto do
  // dashboard para baixo. A lista inteira continua a um toque, na folha.
  const TETO_LEGENDA = 6;
  const visiveis = dre.grupos.slice(0, TETO_LEGENDA);
  const resto = dre.grupos.slice(TETO_LEGENDA);

  const linhaDRE = function (cor, rotulo, valor, pct, acao) {
    return '<button type="button" onclick="' + acao + '">' +
      '<span class="sd-ponto" style="background:' + cor + '"></span>' +
      '<span class="dre-leg-nome">' + rotulo + '</span>' +
      // Sempre com a porcentagem: no modo DRE ela é a informação, não um
      // extra que se revela tocando. "R$ 392,09" não diz nada sozinho;
      // "65% de tudo que saiu" diz.
      '<span class="dre-leg-val">' + formatarMoeda(valor) + '</span>' +
      '<span class="dre-leg-pct">' + pctBR(pct) + '%</span>' +
      '<span class="sd-seta">&#8250;</span></button>';
  };

  let legenda = visiveis.map(function (g) {
    return linhaDRE(escaparHtml(g.cor), rotuloDRE(g.chave, g.nome),
                    g.valor, g.pct, "abrirDRE('" + escaparHtml(g.chave) + "')");
  }).join("");

  if (resto.length) {
    const somaResto = resto.reduce(function (a, g) { return a + g.valor; }, 0);
    const pctResto = resto.reduce(function (a, g) { return a + g.pct; }, 0);
    legenda += linhaDRE("var(--fraco-2)",
      '+ ' + resto.length + ' grupos menores', somaResto, pctResto, "abrirDRE()");
  }

  const elLeg = document.getElementById("sd-legenda");
  elLeg.classList.add("dre-legenda");
  elLeg.innerHTML = legenda;

  return true;
}

/** Quais grupos do DRE estão abertos na folha. */
let dreAberto = {};

function abrirDRE(chave) {
  if (chave) dreAberto[chave] = !dreAberto[chave];
  const d = dashboardAtual;
  if (!d || !d.dre) return;

  document.getElementById("ft-titulo").textContent = "Para onde foi";
  document.getElementById("ft-sub").textContent = (d.mesReferencia || "").toLowerCase();
  document.getElementById("modal-fatia").style.display = "flex";

  const dre = d.dre;
  document.getElementById("ft-total").textContent = formatarMoeda(dre.total);
  let html = "";

  dre.grupos.forEach(function (g) {
    const aberto = !!dreAberto[g.chave];
    html += '<button type="button" class="dre-grupo" onclick="abrirDRE(\'' +
      escaparHtml(g.chave) + '\')">' +
      '<span class="sd-ponto" style="background:' + escaparHtml(g.cor) + '"></span>' +
      '<span class="dre-nome">' + rotuloDRE(g.chave, g.nome) +
      // Quando o plano de contas não dá nome ao nível 2, fica só o código. Um
      // nome deduzido dos filhos seria chute, e chute errado aqui não aparece.
      (g.temNome ? '' : ' <i class="dre-sem-nome">sem nome no plano</i>') +
      '</span>' +
      '<b class="dre-val">' + formatarMoeda(g.valor) + '</b>' +
      '<span class="dre-pct">' + pctBR(g.pct) + '%</span>' +
      '<span class="sd-seta">' + (aberto ? '&#8964;' : '&#8250;') + '</span>' +
      '</button>';

    if (aberto) {
      html += '<div class="dre-filhos">' + g.filhos.map(function (f) {
        return '<div class="dre-filho"><span class="dre-nome">' +
          rotuloDRE(f.chave, f.nome) +
          '</span><b class="dre-val">' + formatarMoeda(f.valor) +
          '</b><span class="dre-pct">' + pctBR(f.pct) + '%</span></div>';
      }).join("") + '</div>';
    }
  });

  document.getElementById("ft-corpo").innerHTML = html;
}

function pintarBarraDoSaldo(d, s, ds, supondo, receita, sobra, fixas) {
  const pagas = Math.max(0, ds.pagas || 0);
  const pendentes = Math.max(0, ds.pendentes || 0);
  const previstas = Math.max(0, fixas || 0);

  // A suposição e a sobra vêm DE FORA, já decididas por quem pintou o herói.
  // Recalcular aqui foi o que deixou o número de cima dizer "falta" enquanto
  // a barra mostrava o mês quase vazio -- dois cálculos para a mesma coisa.
  const bloco = document.getElementById("sd-barra-bloco");

  // O botão de modo é do CARD, e por isso é resolvido ANTES de qualquer saída
  // antecipada: num mês sem barra ele precisa sumir, e deixá-lo depois do
  // return o congelaria no estado do mês anterior.
  //
  // Só aparece quando há DRE para mostrar -- um botão que não leva a lugar
  // nenhum é pior que botão nenhum.
  const btModo = document.getElementById("sd-modo");
  const temDRE = !!(d.dre && d.dre.grupos && d.dre.grupos.length && d.dre.total > 0);
  if (btModo) {
    btModo.style.display = temDRE ? "" : "none";
    btModo.classList.toggle("ligado", modoDRE && temDRE);
  }

  // Sem receita nenhuma não há proporção possível: a barra some e sobram os
  // números. Uma barra cheia de despesa sobre base zero diria "100% gasto",
  // o que não é verdade -- é "não sei".
  //
  // O DRE, porém, não depende de receita: ele reparte o que SAIU. Então um
  // mês só de gastos continua tendo o que mostrar.
  if (!(receita > 0) && !(pagas + pendentes > 0) && !(modoDRE && temDRE)) {
    bloco.style.display = "none";
    return;
  }
  bloco.style.display = "block";

  // Modo DRE desenha a mesma barra respondendo outra pergunta. Se não houver
  // o que repartir, cai no normal em vez de mostrar uma barra vazia.
  if (modoDRE && temDRE && pintarBarraDRE(d)) return;

  // Voltou ao normal: as classes do DRE saem. Elas mudam grade e
  // arredondamento, e deixadas para trás a barra comum herdaria a aparência
  // do outro modo -- defeito que só apareceria ao desligar, e portanto o
  // último a ser notado.
  document.getElementById("sd-barra").classList.remove("dre");
  document.getElementById("sd-legenda").classList.remove("dre-legenda");

  document.getElementById("sd-barra-rotulo").textContent =
    supondo ? "PARA ONDE IRIA" : "PARA ONDE VAI";
  document.getElementById("sd-barra-total").textContent = formatarMoeda(receita);

  // Estourou a receita: a barra fica cheia de despesa e não há verde. Fingir
  // uma fatia de sobra num mês negativo seria mentir na única coisa que a
  // barra existe para mostrar.
  const teto = Math.max(receita, pagas + pendentes + previstas, 1);
  const pct = function (v) { return Math.max(0, (v / teto) * 100); };

  // A cor escolhida vence a de estado; vazia, fica a de sempre. O padrão é a
  // AUSÊNCIA de valor guardado, e não um valor igual ao padrão -- assim não
  // existe "restaurar", basta apagar.
  const C = d.coresBarra || {};
  const cPago = C.pago || "var(--azul)";
  const cPend = C.pendente || "var(--laranja)";
  const cFixas = C.fixas || "var(--laranja)";
  const cSobra = C.sobra || "var(--verde)";

  const faixas = [];
  if (pagas > 0) faixas.push('<span style="width:' + pct(pagas) + '%; background:' + cPago + '"></span>');
  if (pendentes > 0) faixas.push('<span style="width:' + pct(pendentes) + '%; background:' + cPend + '"></span>');

  // Listrada, não chapada: é a mesma marca que a Projeção Futura usa para o
  // que ainda não virou lançamento. Cor sozinha diria que já aconteceu.
  if (previstas > 0) {
    faixas.push('<span style="width:' + pct(previstas) + '%; ' +
      'background: repeating-linear-gradient(45deg, ' + cFixas + ' 0 3px, transparent 3px 6px); ' +
      'background-color: rgba(249, 115, 22, .18)"></span>');
  }

  if (sobra > 0) faixas.push('<span style="flex-grow:1; background:' + cSobra + '"></span>');
  document.getElementById("sd-barra").innerHTML = faixas.join("") + marcaDoLimite(d, teto);

  // A barra inteira é o alvo: tocar nela troca valor por valor + porcentagem.
  const elBarra = document.getElementById("sd-barra");
  elBarra.onclick = function () { alternarPct("saldo"); };
  elBarra.style.cursor = "pointer";

  const linha = function (cor, nome, valor, corNum, abre, pctDe) {
    const conteudo =
      '<span class="sd-ponto" style="background:' + cor + '"></span>' +
      '<span class="sd-nome">' + nome + '</span>' +
      '<span class="sd-num"' + (corNum ? ' style="color:' + corNum + '"' : '') + '>' +
        (pctDe ? valorOuPct("saldo", valor, pctDe) : formatarMoeda(valor)) + '</span>';

    if (!abre) return '<div class="sd-linha">' + conteudo + '</div>';

    return '<button type="button" class="sd-linha abre" onclick="' + abre + '">' +
      conteudo + '<span class="sd-seta">&#8250;</span></button>';
  };

  const listrado = "repeating-linear-gradient(45deg, " + cFixas + " 0 2px, transparent 2px 4px)";

  document.getElementById("sd-legenda").innerHTML =
    linha(cPago, "já pago", pagas, null,
          pagas > 0 ? "abrirFatia('pago')" : null, teto) +
    linha(cPend, "a pagar ainda", pendentes, null,
          pendentes > 0 ? "abrirFatia('pendente')" : null, teto) +
    (previstas > 0 ? linha(listrado, "fixas ainda não lançadas", previstas, null, "abrirFatia('fixas')", teto) : "") +
    (sobra >= 0
      ? linha(cSobra, supondo ? "sobraria" : "sobra", sobra, cSobra, null, teto)
      : linha("var(--vermelho)", "falta", Math.abs(sobra), "var(--vermelho)", null, teto));

  pintarLinhaDoLimite(d);

  pintarBarraDosGrupos(d);
}

// ============================================================================
// A BARRA POR GRUPO DE SALDO
// ----------------------------------------------------------------------------
// Ela mede o GASTO JÁ LANÇADO do mês, repartido pelos combinados. Não inclui
// as fixas que ainda não viraram lançamento: elas não têm grupo, e não dá
// para classificar o que ainda não existe. Por isso o total daqui é menor
// que o da barra de cima, e a legenda diz de que total se trata.
//
// "Sem grupo" é BRANCO COM CONTORNO, e isso não é só estética: quando a maior
// parte do mês está fora de qualquer combinado, uma cor forte ali dominaria a
// barra e as mesadas sumiriam. Branco ocupa o espaço sem disputar atenção.
// ============================================================================
/** O tracinho na posição do limite. Fora da escala da barra, não aparece. */
function marcaDoLimite(d, teto) {
  const L = d.limite;
  if (!L || !teto || L.limite > teto) return "";

  const pos = (L.limite / teto) * 100;
  const cor = L.estourou ? "var(--vermelho)" : "var(--texto)";

  return '<span class="sd-marca" style="left:' + pos.toFixed(2) + '%; background:' + cor + '"></span>';
}

function pintarLinhaDoLimite(d) {
  const el = document.getElementById("sd-limite");
  if (!el) return;

  const L = d.limite;
  if (!L) { el.style.display = "none"; return; }
  el.style.display = "block";

  const partes = ["Limite " + formatarMoeda(L.limite)];

  if (L.estourou) {
    partes.push('<b style="color:var(--vermelho)">passou ' + formatarMoeda(-L.sobra) + '</b>');
  } else {
    partes.push('<b style="color:var(--verde)">faltam ' + formatarMoeda(L.sobra) + '</b>');
    // Por dia só no mês corrente: num mês passado ou futuro, "até o fim" não
    // quer dizer nada.
    if (L.porDia > 0) {
      partes.push(formatarMoeda(L.porDia) + "/dia em " + L.diasQueFaltam + " dias");
    }
  }

  // De onde saiu o teto, PARCELA POR PARCELA. Um limite que muda de valor
  // sozinho, mês a mês, sem dizer por quê, faz desconfiar do app inteiro -- e
  // aqui ele muda mesmo: o crédito do vale entra, e o ajuste do mês também.
  //
  // O teto BASE vem sempre primeiro e nunca é substituído: é ele que você
  // combinou consigo, e o resto é anotação em cima dele.
  const soma = [];
  if (L.vale > 0 || L.extra > 0) soma.push(formatarMoeda(L.limiteBase));
  if (L.vale > 0) {
    soma.push("+ " + formatarMoeda(L.vale) + " de " + escaparHtml(L.cartaoVale || "benefício"));
  }
  if (L.extra > 0) {
    soma.push("+ " + formatarMoeda(L.extra) +
              (L.motivoExtra ? " (" + escaparHtml(L.motivoExtra) + ")" : " de ajuste"));
  }

  const nota = (soma.length ? soma.join(" ") + " · " : "") +
               "contando o que ainda vai ser lançado";

  el.innerHTML = partes.join(" &middot; ") +
    '<span class="sd-limite-nota">' + nota + '</span>' +
    '<button type="button" class="sd-limite-ajuste" onclick="abrirAjusteDoLimite()">' +
      (L.extra > 0 ? "mudar o ajuste deste mês" : "ajustar só este mês") +
    '</button>';
}

/**
 * O ajuste do mês que está na tela.
 *
 * Mora aqui, e não em Configurações, porque é um número DE UM MÊS: em
 * Configurações seria preciso primeiro escolher qual, e a tela onde o
 * problema aparece já sabe a resposta.
 */
async function abrirAjusteDoLimite() {
  const d = dashboardAtual;
  if (!d || !d.limite) return;

  const L = d.limite;
  const atual = L.extra > 0 ? String(L.extra).replace(".", ",") : "";

  const bruto = prompt(
    "Quanto a mais o teto aceita só em " + (d.mesReferencia || "") + "?\n\n" +
    "Teto combinado: " + formatarMoeda(L.limiteBase) + "\n" +
    "Vale deste mês: " + formatarMoeda(L.vale || 0) + "\n\n" +
    "Em branco remove o ajuste. Vale só para este mês.", atual);
  if (bruto === null) return;

  const valor = String(bruto).trim();
  let motivo = "";

  if (valor) {
    // Sem motivo não grava, e é de propósito: limite que se levanta toda vez
    // que estoura deixa de ser limite. O texto é o que, daqui a três meses,
    // explica o número.
    motivo = prompt("Por quê? (fica escrito no card)", L.motivoExtra || "");
    if (motivo === null) return;
    if (!motivo.trim()) { mostrarToast("⚠️ Sem motivo, não gravo."); return; }
  }

  try {
    const r = await chamarServidor("salvarLimiteExtra",
      { mes: d.mes, ano: d.ano, valor: valor, motivo: motivo });

    if (!r || !r.ok) { alert((r && r.mensagem) || "Não deu para gravar."); return; }

    mostrarToast("✅ " + r.mensagem);
    esquecerDominio("config");
    esquecerDominio("transacoes");   // o teto é calculado dentro do dashboard
    await recarregarDados();
  } catch (e) {
    alert("Falhou: " + (e.message || "sem conexão"));
  }
}

/**
 * A barra dos grupos sem o "sem grupo".
 *
 * Com metade do mês fora de qualquer combinado, a fatia branca domina e as
 * outras viram tiras finas -- a barra deixa de responder "como se repartiu o
 * que ESTÁ combinado", que é a pergunta de quem já organizou os grupos.
 *
 * É um modo, não um conserto: desligado, a barra volta a mostrar o mês
 * inteiro. Esconder o não classificado por padrão seria esconder o trabalho
 * que falta fazer.
 */
let soComGrupo = false;
try { soComGrupo = localStorage.getItem("sb_so_com_grupo") === "1"; } catch (e) {}

function alternarSoComGrupo() {
  soComGrupo = !soComGrupo;
  try { localStorage.setItem("sb_so_com_grupo", soComGrupo ? "1" : "0"); } catch (e) {}
  if (dashboardAtual) preencherDashboard(dashboardAtual);
}

function pintarBarraDosGrupos(d) {
  const barra = document.getElementById("bg-bloco");
  if (!barra) return;

  const grupos = (d.gruposDeSaldo || []).filter(function (g) {
    return !g.antesDaOrigem && g.gasto > 0;
  });

  // Ligado, o "sem grupo" sai da barra E da base da porcentagem: deixá-lo na
  // base faria as fatias somarem menos de 100% e sobrar um vão sem dono.
  const semGrupoReal = Math.max(0, d.despesaSemGrupo || 0);
  const semGrupo = soComGrupo ? 0 : semGrupoReal;
  const total = grupos.reduce(function (acc, g) { return acc + g.gasto; }, 0) + semGrupo;

  const btModo = document.getElementById("bg-modo");
  if (btModo) {
    // Sem nada fora de combinado, os dois modos mostram a mesma barra: o botão
    // sumiria de nada.
    btModo.style.display = semGrupoReal > 0 ? "" : "none";
    btModo.classList.toggle("ligado", soComGrupo);
  }
  const elRot = document.getElementById("bg-rot");
  if (elRot) {
    elRot.textContent = soComGrupo ? "Onde o gasto combinado caiu" : "Onde o gasto caiu";
  }

  if (total <= 0) { barra.style.display = "none"; return; }
  barra.style.display = "block";

  document.getElementById("bg-total").textContent = formatarMoeda(total);

  const pct = function (v) { return Math.max(0, (v / total) * 100); };

  let faixas = "";
  grupos.forEach(function (g) {
    faixas += '<span style="width:' + pct(g.gasto).toFixed(2) + '%; ' +
      corDeFatia(g) + '"></span>';
  });
  if (semGrupo > 0) {
    faixas += '<span style="flex-grow:1; background:#ffffff; ' +
      'box-shadow: inset 0 0 0 1.5px var(--texto)"></span>';
  }
  document.getElementById("bg-barra").innerHTML = faixas;

  const elBG = document.getElementById("bg-barra");
  elBG.onclick = function () { alternarPct("grupos"); };
  elBG.style.cursor = "pointer";

  let legenda = "";
  grupos.forEach(function (g) {
    legenda +=
      '<button type="button" class="sd-linha abre" onclick="abrirFatia(\'grupo\', ' +
        JSON.stringify(g.nome).replace(/"/g, "&quot;") + ')">' +
        '<span class="sd-ponto" style="' + corDeFatia(g) + '"></span>' +
        '<span class="sd-nome">' + escaparHtml(g.nome) + '</span>' +
        '<span class="sd-num">' + valorOuPct("grupos", g.gasto, total) + '</span>' +
        '<span class="sd-seta">&#8250;</span>' +
      '</button>';
  });
  if (semGrupo > 0) {
    legenda +=
      '<button type="button" class="sd-linha abre" onclick="abrirFatia(\'grupo\', \'__sem__\')">' +
        '<span class="sd-ponto" style="background:#ffffff; box-shadow: inset 0 0 0 1.5px var(--texto)"></span>' +
        '<span class="sd-nome">sem grupo</span>' +
        '<span class="sd-num">' + valorOuPct("grupos", semGrupo, total) + '</span>' +
        '<span class="sd-seta">&#8250;</span>' +
      '</button>';
  }
  document.getElementById("bg-legenda").innerHTML = legenda;

  // A nota fala do MÊS, não da barra. Com o modo ligado, semGrupo é zero e a
  // conta sobre ele diria "todo o gasto está combinado" -- exatamente a
  // mentira que o modo poderia contar, já que ele esconde o que falta.
  const totalDoMes = grupos.reduce(function (acc, g) { return acc + g.gasto; }, 0) + semGrupoReal;
  const fora = totalDoMes > 0 ? Math.round((semGrupoReal / totalDoMes) * 100) : 0;

  document.getElementById("bg-nota").innerHTML = semGrupoReal > 0
    ? (soComGrupo
        ? "Fora da barra: " + fora + "% do mês (" + formatarMoeda(semGrupoReal) +
          ") está fora de qualquer combinado."
        : fora + "% do que saiu está fora de qualquer combinado. Toque em " +
          "<b>sem grupo</b> para classificar.")
    : "Todo o gasto do mês está dentro de um combinado.";
}

/**
 * O estilo de uma fatia: cor de dentro e cor de borda.
 *
 * O fio de contorno padrão existe porque as cores escuras da paleta somem no
 * fundo dos temas escuros. A borda escolhida passa por cima dele.
 */
function corDeFatia(g) {
  const dentro = g.cor || "var(--fraco-2)";
  const borda = g.corBorda
    ? ("inset 0 0 0 1.5px " + g.corBorda)
    : "inset 0 0 0 1px var(--contorno-fatia)";
  return "background:" + dentro + "; box-shadow: " + borda;
}

// ============================================================================
// O QUE TEM DENTRO DE UMA FATIA
// ============================================================================
let fatiaAtual = null;

async function abrirFatia(tipo, grupo) {
  const d = dashboardAtual || {};
  fatiaAtual = { tipo: tipo, grupo: grupo || "" };

  document.getElementById("modal-fatia").style.display = "flex";

  const titulos = {
    pago: "Já pago",
    pendente: "A pagar ainda",
    fixas: "Fixas ainda não lançadas",
    grupo: grupo === "__sem__" ? "Sem grupo" : (grupo || "Grupo")
  };
  document.getElementById("ft-titulo").textContent = titulos[tipo] || "Detalhe";
  document.getElementById("ft-sub").textContent = (d.mesReferencia || "").toLowerCase();

  const alvo = document.getElementById("ft-corpo");

  // As fixas previstas JÁ estão no dashboard: não custam uma ida ao servidor.
  if (tipo === "fixas") {
    const itens = ((d.saldo || {}).fixasPrevistasItens) || [];
    pintarFatia(itens.map(function (f) {
      return { descricao: f.descricao, valor: f.valor, data: dataDaFixa(f),
               metodo: f.metodo || "", categoria: f.categoria || "", numMov: 0 };
    }), true);
    return;
  }

  alvo.innerHTML = '<div style="text-align:center; padding:40px 0;">' +
    '<div class="spinner" style="margin:0 auto;"></div></div>';

  try {
    const params = { mes: mesExibido, ano: anoExibido, pagina: 0 };
    if (tipo === "pago" || tipo === "pendente") params.status = tipo;
    if (tipo === "grupo") params.grupo = grupo;

    const r = await lerCacheado("buscarLancamentos", params);
    if (!r || !r.ok) {
      alvo.innerHTML = '<p class="vazio">' + escaparHtml((r && r.mensagem) || "Não consegui buscar.") + '</p>';
      return;
    }

    // A BUSCA VEM PAGINADA, de 30 em 30. Esta folha existe para conferir um
    // número do card -- e somar só a primeira página dava um total menor que
    // o do card, sem nada dizendo que faltava o resto. Um número que não bate
    // com o de cima é pior que nenhum: parece erro de conta.
    //
    // Teto de páginas para o caso de um filtro pegar o histórico inteiro; o
    // mês corrente não chega perto disso.
    let itens = (r.itens || []).slice();
    let temMais = r.temMais;
    for (let p = 1; temMais && p < 12; p++) {
      const extra = await lerCacheado("buscarLancamentos",
        Object.assign({}, params, { pagina: p }));
      if (!extra || !extra.ok) break;
      itens = itens.concat(extra.itens || []);
      temMais = extra.temMais;
    }

    pintarFatia(itens.map(function (it) {
      return {
        descricao: it.descricao,
        valor: it.valor,
        // Só dia e mês: o ano é o do título da folha.
        data: (it.vencimento || "").split("/").slice(0, 2).join("/"),
        metodo: it.ehCartao ? (it.cartao || it.metodo) : it.metodo,
        categoria: it.categoria,
        parcela: it.parcela,
        numMov: it.numMov
      };
    }), false);
  } catch (e) {
    alvo.innerHTML = '<p class="vazio">Sem conexão.</p>';
  }
}

function fecharFatia() {
  document.getElementById("modal-fatia").style.display = "none";
  fatiaAtual = null;
}

/**
 * A lista, agrupada por MÉTODO com subtotal.
 *
 * Num mês em que a maior parte é cartão, a pergunta seguinte é sempre
 * "quanto disso é a fatura?" -- e uma lista corrida de 34 linhas não responde.
 */
/**
 * Quando a fixa cai de verdade.
 *
 * Mostrar "dia 10" é mostrar a REGRA, não a data: no cartão a despesa cai na
 * fatura, que pode ser outro dia e até outro mês. Era essa etiqueta que
 * escondia a divergência -- onze fixas apareciam todas como "dia 10" e não
 * havia como ver que o app esperava cada uma em 31/10.
 */
function dataDaFixa(f) {
  if (f && f.vencimento) {
    const p = String(f.vencimento).split("-");   // yyyy-MM-dd
    if (p.length === 3) return p[2] + "/" + p[1];
  }
  return f && f.dia ? "dia " + f.dia : "";
}

function pintarFatia(itens, saoPrevistas) {
  const alvo = document.getElementById("ft-corpo");

  if (!itens.length) {
    alvo.innerHTML = '<p class="vazio">Nada aqui neste mês.</p>';
    document.getElementById("ft-total").textContent = formatarMoeda(0);
    return;
  }

  const porMetodo = {};
  let total = 0;
  itens.forEach(function (it) {
    const m = (it.metodo || "sem método").toString();
    if (!porMetodo[m]) porMetodo[m] = { total: 0, itens: [] };
    porMetodo[m].total += it.valor || 0;
    porMetodo[m].itens.push(it);
    total += it.valor || 0;
  });

  document.getElementById("ft-total").textContent = formatarMoeda(total);

  const nomes = Object.keys(porMetodo).sort(function (a, b) {
    return porMetodo[b].total - porMetodo[a].total;
  });

  let html = "";
  nomes.forEach(function (m) {
    html +=
      '<div class="ft-grupo">' +
        '<span>' + escaparHtml(m) + '</span>' +
        '<b>' + formatarMoeda(porMetodo[m].total) + '</b>' +
      '</div>';

    porMetodo[m].itens.forEach(function (it) {
      const acao = (!saoPrevistas && it.numMov)
        ? ' onclick="fecharFatia(); abrirFichaPorMov(' + it.numMov + ')"'
        : '';
      html +=
        '<' + (acao ? 'button type="button"' : 'div') + ' class="ft-item"' + acao + '>' +
          '<span class="ft-data">' + escaparHtml(it.data || "") + '</span>' +
          '<span class="ft-nome">' + escaparHtml(it.descricao || "") +
            (it.parcela ? ' <span style="color:var(--fraco-2)">' + escaparHtml(it.parcela) + '</span>' : '') +
            (it.categoria
              ? '<span class="ft-cat">' + escaparHtml(nomeDaCategoria(it.categoria)) + '</span>'
              : '') +
          '</span>' +
          '<span class="ft-val">' + formatarMoeda(it.valor) + '</span>' +
        '</' + (acao ? 'button' : 'div') + '>';
    });
  });

  if (saoPrevistas) {
    html += '<div class="rel-nota">Estas contas ainda não viraram lançamento, ' +
            'então não têm ficha para abrir.</div>';
  }

  alvo.innerHTML = html;
}

/** Abre a ficha do lançamento pela tela de Lançamentos, que é onde ela mora. */
// ============================================================================
// PAGAR SÓ UMA PARTE
// ----------------------------------------------------------------------------
// A parcela é DIVIDIDA em duas linhas no servidor (ver 66-PagamentoParcial.js);
// aqui só se pergunta quanto e quando, e se mostra o resultado ANTES de
// gravar. Dividir é escrever no histórico: o mesmo cuidado do botão de
// corrigir vencimento, que só não destruiu um parcelamento porque simulava.
// ============================================================================
async function abrirPagamentoParcial(numMov, valorAberto) {
  const bruto = prompt(
    "Quanto você pagou desta parcela?\n\n" +
    "Em aberto: " + formatarMoeda(valorAberto) + "\n" +
    "O resto continua em aberto, no mesmo vencimento.", "");
  if (bruto === null) return;

  const valor = parseFloat(String(bruto).replace(/\./g, "").replace(",", "."));
  if (!(valor > 0)) { mostrarToast("⚠️ Valor inválido."); return; }

  const hoje = new Date();
  const iso = hoje.getFullYear() + "-" +
    ("0" + (hoje.getMonth() + 1)).slice(-2) + "-" + ("0" + hoje.getDate()).slice(-2);
  const quando = prompt("Em que dia você pagou? (AAAA-MM-DD)", iso);
  if (quando === null) return;

  try {
    const sim = await chamarServidor("pagarParteDaParcela",
      { numMov: numMov, valorPago: valor, dataPagamento: quando, simular: "true" });

    if (!sim || !sim.ok) { alert((sim && sim.mensagem) || "Não deu para simular."); return; }
    if (!confirm(sim.mensagem + "\n\nConfirma?")) return;

    const r = await chamarServidor("pagarParteDaParcela",
      { numMov: numMov, valorPago: valor, dataPagamento: quando, simular: "false" });

    if (!r || !r.ok) { alert((r && r.mensagem) || "Não deu para gravar."); return; }

    mostrarToast("✅ " + r.mensagem);
    fecharDetalhe();
    limparTodoCache();
    await recarregarDados();
  } catch (e) {
    alert("Falhou: " + (e.message || "sem conexão"));
  }
}

async function abrirFichaPorMov(numMov) {
  trocarAba("busca");

  const campo = document.getElementById("bl-nummov");
  if (campo) campo.value = numMov;

  try {
    await executarBusca(true);
    // A ficha e a MESMA da tela de Lancamentos: abrirDetalheBusca indexa
    // resultadosBusca, entao a busca vem primeiro e o indice e o zero.
    if (resultadosBusca.length === 1) abrirDetalheBusca(0);
  } catch (e) {
    mostrarToast("Abri os lancamentos: procure por MOV-" + numMov + ".");
  }
}

/**
 * O bloco do que ainda não aconteceu: fixas não lançadas + planos de compra.
 *
 * Fechado por padrão, e FORA do card do saldo. Os dois moravam lá dentro, com
 * o mesmo peso visual do dinheiro real -- e era isso que fazia a tela parecer
 * uma pilha de números. Aqui o real fica em cima e a suposição embaixo, que é
 * a mesma regra que o resto do app já segue.
 */
/**
 * @param fixasJaContadas  As fixas já entraram no número de cima (mês de
 *   previsão). Sem avisar, quem lê "sobra ≈ X" e logo abaixo "+ R$ 2.748"
 *   subtrai de novo, de cabeça -- e erra por um mês inteiro de contas.
 */
function pintarPrevisto(d, s, receitaDaConta, fixasJaContadas) {
  const bloco = document.getElementById("bloco-previsto");
  const fixas = s.fixasPrevistas || 0;
  const planos = s.planos || 0;
  const total = fixas + planos;

  if (!(total > 0)) { bloco.style.display = "none"; return; }
  bloco.style.display = "block";

  const partes = [];
  if (fixas > 0) partes.push("contas fixas");
  if (planos > 0) partes.push("planos de compra");

  // Quando as fixas já estão no número de cima, o "+" some delas: só o que
  // ainda não foi contado é que acrescenta.
  const acrescenta = fixasJaContadas ? planos : total;

  document.getElementById("pv-sub").textContent =
    partes.join(" e ") + (fixasJaContadas ? " · fixas já na conta acima" : "");
  document.getElementById("pv-val").textContent = acrescenta > 0
    ? "+ " + formatarMoeda(acrescenta)
    : formatarMoeda(total);

  const itens = s.fixasPrevistasItens || [];
  const esperadas = (s.despesas || 0) + total;
  const receita = receitaDaConta || 0;

  let html = "";

  if (fixas > 0) {
    html += '<div class="pvd-item"><span>fixas ainda não lançadas' +
            (fixasJaContadas ? ' <i style="font-style:normal; color:var(--verde)">(já contadas)</i>' : '') +
            '</span><b>' + formatarMoeda(fixas) + '</b></div>';
    if (itens.length) {
      html += '<div class="pvd-lista">' + itens.map(function (f) {
        return '<div class="pvd-sub-item"><span>' + escaparHtml(f.descricao) +
               ' · ' + dataDaFixa(f) + '</span><b>' + formatarMoeda(f.valor) + '</b></div>';
      }).join("") + '</div>';
    }
  }

  if (planos > 0) {
    html += '<div class="pvd-item roxo"><span>planos de compra em aberto</span><b>' +
            formatarMoeda(planos) + '</b></div>';
  }

  html += '<div class="pvd-total"><span>despesas se tudo acontecer</span><b>' +
          formatarMoeda(esperadas) + '</b></div>';

  if (receita > 0) {
    const sobraria = receita - esperadas;
    html += '<div class="pvd-total" style="border:none; margin-top:0; padding-top:4px">' +
        '<span>' + (sobraria >= 0 ? "sobra que restaria" : "faltaria") + '</span>' +
        '<b style="color:' + (sobraria >= 0 ? "var(--verde)" : "var(--vermelho)") + '">' +
          formatarMoeda(Math.abs(sobraria)) + '</b>' +
      '</div>';
  }

  html += '<div class="pvd-nota">' +
    (fixasJaContadas
      ? "Mês de previsão: as fixas já estão descontadas no valor de cima. Os planos, não — eles ainda são vontade."
      : (planos > 0 && fixas > 0
        ? "As fixas vão chegar; os planos são vontade. Nenhum dos dois foi lançado."
        : (planos > 0
          ? "Nada disso foi comprado. Os números de cima seguem valendo."
          : "Contas cadastradas que ainda não viraram lançamento neste mês."))) +
    '</div>';

  document.getElementById("pv-corpo").innerHTML = html;
}

/**
 * Abre e fecha o bloco do previsto.
 *
 * Nasce fechado: o total importa sempre, o detalhe só quando ele surpreende.
 */
function alternarPrevisto() {
  const corpo = document.getElementById("pv-corpo");
  const seta = document.getElementById("pv-seta");
  const topo = document.getElementById("pv-topo");
  if (!corpo) return;

  const aberto = corpo.style.display !== "none";
  corpo.style.display = aberto ? "none" : "block";
  if (seta) seta.classList.toggle("aberta", !aberto);
  if (topo) topo.setAttribute("aria-expanded", aberto ? "false" : "true");
}

/**
 * O texto que estava sempre na tela, agora atrás de um toque.
 *
 * Ele explica uma regra do app que se entende UMA vez -- deixá-lo fixo custava
 * mais altura que a receita e a despesa juntas, todo dia, para sempre.
 */
let explicandoSuposicao = false;

function explicarBaseDeCalculo() {
  mostrarToast(explicandoSuposicao
    ? "Este mês ainda não tem receita lançada, então o cálculo usa a última que entrou de verdade. É estimativa, por isso o ≈."
    : "Conta a receita deste mês. A despesa entra pelo vencimento enquanto está em aberto e pelo PAGAMENTO depois de paga — antecipar a fatura traz o gasto para o mês em que você pagou.");
}

/**
 * Quanto do limite do cartão está ocupado.
 *
 * O limite já estava na planilha (coluna B de 'Config Cartões') e já era
 * lido -- o dashboard é que nunca tinha usado. E é o número que decide se
 * uma compra cabe: a fatura aberta diz o que você vai pagar agora, o limite
 * ocupado diz o que o banco está segurando.
 *
 * O ocupado inclui TODA parcela que ainda vai vencer, não só a fatura do
 * mês. É assim que o banco conta, e contar diferente daria a impressão de
 * folga que não existe.
 */
function blocoDeLimite(c) {
  // Sem limite cadastrado não há barra: inventar um teto para desenhar a
  // barra seria desenhar uma folga que ninguém informou.
  if (!c.limite || c.usoPct === null || c.usoPct === undefined) {
    return '<div class="lim-semdado">Limite não cadastrado para este cartão.</div>';
  }

  // Três faixas, e a cor muda de significado junto: perto do teto, o que
  // importa não é quanto foi usado, é quanto falta.
  const cor = c.usoPct >= 90 ? "var(--vermelho)"
            : (c.usoPct >= 70 ? "var(--laranja)" : "var(--verde)");

  return '<div class="lim-bloco">' +
      '<div class="lim-topo">' +
        '<span>' + formatarMoeda(c.comprometido) + ' de ' + formatarMoeda(c.limite) + '</span>' +
        '<b style="color:' + cor + '">' + c.usoPct.toFixed(0) + '%</b>' +
      '</div>' +
      '<div class="lim-barra">' +
        '<span style="width:' + c.usoPct + '%; background:' + cor + '"></span>' +
      '</div>' +
      '<div class="lim-livre">' +
        (c.livre > 0
          ? '<b>' + formatarMoeda(c.livre) + '</b> livres'
          : '<b style="color:var(--vermelho)">sem limite livre</b>') +
        ' &middot; inclui as parcelas que ainda vão vencer' +
      '</div>' +
    '</div>';
}

/**
 * O dia do vencimento numa plaquinha, à esquerda da linha.
 *
 * A data era um "01/10" em negrito colado no começo do nome, e o nome
 * empurrava tudo: "Fatura Cartão" numa linha e "C XP" na outra, com o botão
 * descendo junto. Com a data fora do fluxo do texto, o nome fica com a
 * largura inteira e nada mais quebra por causa dela.
 */
function chipDeData(data) {
  const p = (data || "").toString().split("/");
  const dia = p[0] || "--";
  const meses = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN",
                 "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  const mes = meses[(parseInt(p[1], 10) || 1) - 1] || "";

  return '<span class="li-chip"><b>' + escaparHtml(dia) + '</b><i>' + mes + '</i></span>';
}

/**
 * As quatro partes do score, uma por linha.
 *
 * Era uma frase só: "Comprometimento: 89.3% | Parcelas: 21.6% | Reserva: 0.0
 * meses | Poupança: 10.7%". Quatro números separados por barra vertical,
 * quebrando em duas linhas no celular -- ninguém lê isso, e mesmo lendo não
 * dá para saber qual deles está puxando o 35/100 para baixo.
 *
 * As bolinhas acesas são os pontos que cada item rendeu, de 25. É o que
 * transforma um score num diagnóstico.
 */
function pintarMetricasDoScore(metricas) {
  const alvo = document.getElementById("score-metricas");
  if (!alvo) return;

  if (!metricas.length) { alvo.innerHTML = ""; return; }

  alvo.innerHTML = metricas.map(function (m) {
    // 25 pontos = 4 bolinhas, uma a cada 6,25. O arredondamento para cima
    // evita que 5 pontos (um quarto do caminho) apareça como zero aceso.
    const acesas = Math.ceil((m.pontos / m.maximo) * 4);
    let bolinhas = "";
    for (let i = 0; i < 4; i++) {
      bolinhas += '<span class="sm-ponto' + (i < acesas ? " aceso" : "") + '"></span>';
    }

    const casas = m.unidade === " meses" ? 1 : 0;

    return '<div class="sm-linha">' +
        '<span class="sm-nome">' + escaparHtml(m.nome) + '</span>' +
        '<span class="sm-val">' + m.valor.toFixed(casas) + m.unidade + '</span>' +
        '<span class="sm-pontos">' + bolinhas + '</span>' +
      '</div>';
  }).join("");
}

/**
 * Os botões de grupo da ficha de um lançamento.
 *
 * É por aqui que uma despesa ANTIGA entra numa mesada: abre o lançamento na
 * busca e toca no grupo. O gasto passa a contar naquele grupo no mês em que
 * ele aconteceu, não no mês de hoje.
 */
function chipsDeGrupo(atual) {
  const agora = (atual || "").toString().trim();

  const opcoes = [{ nome: "", rotulo: "nenhum" }].concat(
    gruposConhecidos.map(function (n) { return { nome: n, rotulo: n }; }));

  return opcoes.map(function (o) {
    const ligado = (o.nome === agora);
    return '<button type="button" class="' + (ligado ? "ativo" : "") +
      '" onclick="escolherGrupoDoLancamento(this, ' +
      JSON.stringify(o.nome).replace(/"/g, "&quot;") + ')">' +
      escaparHtml(o.rotulo) + '</button>';
  }).join("");
}

async function escolherGrupoDoLancamento(botao, nome) {
  if (!itemDetalhe) return;

  const caixa = document.getElementById("det-grupo-chips");
  if (caixa) {
    caixa.querySelectorAll("button").forEach(function (b) { b.classList.remove("ativo"); });
    botao.classList.add("ativo");
  }

  try {
    const r = await chamarServidor("definirGrupoDoLancamento", {
      numMov: itemDetalhe.numMov, grupo: nome
    });
    if (!r.ok) { mostrarToast("⚠ " + (r.mensagem || "Não deu para marcar.")); return; }

    itemDetalhe.grupo = nome;
    mostrarToast("✅ " + r.mensagem);

    // O grupo mudou o quanto sobrou: o dashboard precisa refazer a conta.
    await recarregarDados();
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

// As categorias escolhidas no formulário de um grupo. Lista própria: o
// seletor é o mesmo da busca, e compartilhar a variável faria abrir o
// formulário limpar o filtro da tela de trás.
let catsGrupo = [];
let grupoDeSaldoEditando = null;

/**
 * Desenha os botões de grupo num formulário de lançamento.
 *
 * O bloco só aparece quando existe grupo cadastrado: num app sem nenhum, um
 * campo com um botão "nenhum" seria uma pergunta sem resposta possível.
 */
function pintarChipsDeGrupo(prefixo) {
  const bloco = document.getElementById(prefixo + "-bloco-grupo");
  const caixa = document.getElementById(prefixo + "-grupo-chips");
  if (!bloco || !caixa) return;

  if (!gruposConhecidos.length) { bloco.style.display = "none"; return; }
  bloco.style.display = "block";

  const atual = (document.getElementById(prefixo + "-grupo") || {}).value || "";

  caixa.innerHTML = [{ v: "", r: "nenhum" }]
    .concat(gruposConhecidos.map(function (n) { return { v: n, r: n }; }))
    .map(function (o) {
      return '<button type="button" class="' + (o.v === atual ? "ativo" : "") +
        '" onclick="escolherGrupoNoForm(' +
        JSON.stringify(prefixo).replace(/"/g, "&quot;") + ', ' +
        JSON.stringify(o.v).replace(/"/g, "&quot;") + ')">' +
        escaparHtml(o.r) + '</button>';
    }).join("");
}

function escolherGrupoNoForm(prefixo, nome) {
  const campo = document.getElementById(prefixo + "-grupo");
  if (campo) {
    campo.value = nome;
    // Marca que a decisao foi SUA. Sem isto, escolher "nenhum" e depois
    // trocar a categoria faria a regra marcar o grupo de novo -- "nenhum" e
    // "ainda nao escolhi" sao o mesmo campo vazio, e so este sinal separa os
    // dois.
    campo.setAttribute("data-manual", "1");
  }

  // Escolher à mão apaga o aviso da regra: a partir daqui a decisão é sua.
  const dica = document.getElementById(prefixo + "-grupo-dica");
  if (dica) dica.textContent = "";

  pintarChipsDeGrupo(prefixo);
}

/**
 * Marca o grupo que a categoria escolhida manda, se houver regra.
 *
 * Não sobrescreve uma escolha já feita à mão: quem marcou "Mesada Paulo" numa
 * compra de viagem quis dizer isso, e a regra não pode desfazer.
 */
function sugerirGrupoPelaCategoria(prefixo) {
  const cat = ((document.getElementById(prefixo + "-categoria") || {}).value || "").trim();
  const campo = document.getElementById(prefixo + "-grupo");
  const dica = document.getElementById(prefixo + "-grupo-dica");
  if (!campo) return;

  if (campo.value || campo.getAttribute("data-manual") === "1") {
    pintarChipsDeGrupo(prefixo);
    return;
  }

  const achado = gruposCompletos.filter(function (g) {
    return (g.categorias || []).indexOf(cat) >= 0;
  })[0];

  if (achado) {
    campo.value = achado.nome;
    if (dica) dica.textContent = "Marcado por causa da categoria. Dá para trocar.";
  } else if (dica) {
    dica.textContent = "";
  }

  pintarChipsDeGrupo(prefixo);
}

function abrirGerenciarGrupos() {
  document.getElementById("modal-grupos").style.display = "flex";
  pintarGerenciarGrupos();
}

function fecharGerenciarGrupos() {
  document.getElementById("modal-grupos").style.display = "none";
}

function pintarGerenciarGrupos() {
  const alvo = document.getElementById("gg-lista");
  const grupos = gruposCompletos;

  if (!grupos.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum grupo ainda.</p>';
    return;
  }

  alvo.innerHTML = grupos.map(function (g, i) {
    const cats = (g.categorias || []);
    const sub = cats.length
      ? cats.length + (cats.length === 1 ? " categoria entra sozinha" : " categorias entram sozinhas")
      : "sem regra de categoria";

    return '<button type="button" class="gg-item' + (g.ativo === false ? " inativo" : "") +
        '" onclick="abrirFormGrupo(' + i + ')">' +
        '<span class="gg-txt">' +
          '<span class="gg-nome">' + escaparHtml(g.nome) + '</span>' +
          '<span class="gg-sub">' + escaparHtml(sub) +
            (g.acumula ? " · acumula" : " · não acumula") +
            (g.corrige ? " · corrige pelo IPCA" : "") +
          '</span>' +
        '</span>' +
        '<span class="gg-valor">' + formatarMoeda(g.aporte) + '</span>' +
      '</button>';
  }).join("");
}

/**
 * O formulário de um grupo.
 *
 * O VALOR só é editável na criação. Depois dela, mudar por aqui reescreveria
 * o passado -- o valor de um grupo tem data de início, e é o lápis do card
 * (só no mês corrente) que registra desde quando o novo vale.
 */
/**
 * A cor escolhida no formulário. Vive fora do DOM porque "nenhuma" é uma
 * escolha legítima e precisa ser distinguível de "ainda não mexi".
 */
let corGrupoEscolhida = "";
let corBordaGrupoEscolhida = "";

/**
 * A RODA DE COR do formulário de grupo.
 *
 * Matiz pelo ÂNGULO, saturação pelo RAIO, brilho num controle à parte. Os três
 * saem de conta sobre a posição do dedo -- a roda é gradiente CSS, não canvas,
 * então não há buffer para dimensionar nem pixel para ler, e a cor é a mesma
 * em qualquer densidade de tela.
 *
 * Uma roda só para as duas cores, com o alvo sempre à vista nos botões de
 * cima. Duas rodas empilhadas passariam de 400px num formulário que já rola.
 */
function hsvParaHex(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const dois = function (n) {
    const t = Math.round((n + m) * 255).toString(16);
    return t.length === 1 ? "0" + t : t;
  };
  return "#" + dois(r) + dois(g) + dois(b);
}

function hexParaHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: ((h % 360) + 360) % 360, s: mx ? d / mx : 0, v: mx };
}

/**
 * A roda deixou de ser só do formulário de grupo.
 *
 * Ela guarda uma LISTA DE ALVOS -- cada um com rótulo, a cor atual e o que
 * fazer quando mudar -- e os ids dos elementos que vai usar. Assim a mesma
 * roda serve o formulário de grupo (preenchimento e contorno) e as cores da
 * barra do primeiro card (pago, a pagar, fixas, sobra), sem uma segunda
 * implementação que divergiria da primeira na próxima correção.
 */
let roda = null;   // { ids, alvos: [{chave, rotulo, cor}], atual, brilho }

function montarRodaDeCor(cfg) {
  roda = {
    ids: cfg.ids,
    alvos: cfg.alvos.map(function (a) { return { chave: a.chave, rotulo: a.rotulo, cor: a.cor || "" }; }),
    aoMudar: cfg.aoMudar || function () {},
    atual: 0,
    brilho: 70
  };

  const barra = document.getElementById(roda.ids.alvos);
  if (barra) {
    barra.innerHTML = roda.alvos.map(function (a, k) {
      return '<button type="button" class="gf-alvo' + (k === 0 ? ' ativo' : '') +
        '" data-k="' + k + '">' +
        '<span class="gf-alvo-amostra"></span>' + escaparHtml(a.rotulo) + '</button>';
    }).join("");
    Array.prototype.forEach.call(barra.querySelectorAll(".gf-alvo"), function (b) {
      b.onclick = function () { escolherAlvoDeCor(parseInt(b.getAttribute("data-k"))); };
    });
  }

  pintarAmostrasDeCor();
  ligarRodaDeCor();
  // Depois que o container aparece: a roda é medida por offsetWidth, e com ele
  // ainda escondido isso é zero -- a bolinha iria toda para o canto. Mesmo
  // tropeço do seletor de tema, que já custou uma correção.
  setTimeout(posicionarKnob, 0);
}

/** A cor do alvo que está sendo editado agora. */
function corDoAlvo() {
  return (roda && roda.alvos[roda.atual]) ? roda.alvos[roda.atual].cor : "";
}

function definirCorDoAlvo(hex) {
  if (!roda || !roda.alvos[roda.atual]) return;
  roda.alvos[roda.atual].cor = hex;
  pintarAmostrasDeCor();
  roda.aoMudar(roda.alvos[roda.atual].chave, hex, roda.alvos);
}

function escolherAlvoDeCor(k) {
  if (!roda) return;
  roda.atual = k;
  const barra = document.getElementById(roda.ids.alvos);
  if (barra) {
    Array.prototype.forEach.call(barra.querySelectorAll(".gf-alvo"), function (b, idx) {
      b.classList.toggle("ativo", idx === k);
    });
  }
  posicionarKnob();
}

function limparCorDoAlvo() {
  definirCorDoAlvo("");
  posicionarKnob();
}

function pintarAmostrasDeCor() {
  if (!roda) return;
  const barra = document.getElementById(roda.ids.alvos);
  if (!barra) return;
  Array.prototype.forEach.call(barra.querySelectorAll(".gf-alvo-amostra"), function (el, k) {
    el.style.background = (roda.alvos[k] && roda.alvos[k].cor) || "var(--cinza-fundo)";
  });
}

/**
 * Põe a bolinha onde está a cor atual, e escurece a roda conforme o brilho.
 *
 * Sem cor escolhida a bolinha vai para o CENTRO -- que é o branco, o ponto
 * neutro --, e não some: uma bolinha escondida faria parecer que a roda
 * travou.
 */
function posicionarKnob() {
  if (!roda) return;
  const el = document.getElementById(roda.ids.roda);
  const knob = document.getElementById(roda.ids.knob);
  const escuro = document.getElementById(roda.ids.escuro);
  if (!el || !knob) return;

  const hsv = hexParaHsv(corDoAlvo());
  const raio = el.offsetWidth / 2;

  if (hsv) {
    roda.brilho = Math.max(12, Math.round(hsv.v * 100));
    const faixa = document.getElementById(roda.ids.brilho);
    if (faixa) faixa.value = roda.brilho;

    // O mesmo ângulo do conic-gradient: começa no topo e anda no sentido
    // horário. Medir a partir da direita, como atan2 faz por padrão,
    // deixaria a bolinha 90° fora da cor que ela representa.
    const rad = (hsv.h * Math.PI) / 180;
    const dist = hsv.s * raio;
    knob.style.left = (raio + Math.sin(rad) * dist) + "px";
    knob.style.top = (raio - Math.cos(rad) * dist) + "px";
    knob.style.background = corDoAlvo();
  } else {
    knob.style.left = raio + "px";
    knob.style.top = raio + "px";
    knob.style.background = "transparent";
  }

  if (escuro) escuro.style.opacity = String(1 - roda.brilho / 100);
}

function corDaPosicao(ev) {
  const el = document.getElementById(roda.ids.roda);
  const r = el.getBoundingClientRect();
  const raio = r.width / 2;

  // Roda sem tamanho (tela ainda escondida, animação em curso): dividir pelo
  // raio zero dá NaN, e o NaN viraria "#NaNNaNNaN" gravado como cor. Melhor
  // ignorar o toque do que gravar lixo que só aparece na próxima abertura.
  if (!(raio > 0)) return null;
  const dx = ev.clientX - (r.left + raio);
  const dy = ev.clientY - (r.top + raio);

  // Arrastar para FORA da roda não cancela: gruda na borda. Soltar a cor
  // porque o dedo passou da linha é o jeito mais fácil de perder a escolha.
  const sat = Math.min(1, Math.sqrt(dx * dx + dy * dy) / raio);

  let ang = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (ang < 0) ang += 360;

  return hsvParaHex(ang, sat, roda.brilho / 100);
}

/**
 * Pointer Events, e não mouse: no toque, 'mousedown' só chega depois que o
 * navegador decide que não foi rolagem -- o primeiro arrasto sairia perdido.
 */
function ligarRodaDeCor() {
  const el = document.getElementById(roda.ids.roda);
  const faixa = document.getElementById(roda.ids.brilho);
  if (!el || el._ligada) return;
  el._ligada = true;

  let arrastando = false;
  const aplicar = function (ev) {
    const hex = corDaPosicao(ev);
    if (!hex) return;
    definirCorDoAlvo(hex);
    posicionarKnob();
  };

  el.addEventListener("pointerdown", function (ev) {
    arrastando = true;
    el.setPointerCapture(ev.pointerId);
    aplicar(ev);
    ev.preventDefault();
  });
  el.addEventListener("pointermove", function (ev) {
    if (arrastando) { aplicar(ev); ev.preventDefault(); }
  });
  const soltar = function (ev) {
    arrastando = false;
    try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
  };
  el.addEventListener("pointerup", soltar);
  el.addEventListener("pointercancel", soltar);

  if (faixa) {
    faixa.addEventListener("input", function () {
      roda.brilho = parseInt(faixa.value) || 70;
      // Mexer no brilho sem cor escolhida não inventa uma: só a roda escurece,
      // e a escolha continua sendo "sem cor" até você tocar nela.
      const hsv = hexParaHsv(corDoAlvo());
      if (hsv) definirCorDoAlvo(hsvParaHex(hsv.h, hsv.s, roda.brilho / 100));
      posicionarKnob();
    });
  }
}

/**
 * "Sem limite" esconde o valor E as duas regras que dependem dele.
 *
 * Acumular o que sobrou e corrigir pela inflação são regras SOBRE o teto:
 * sem teto, não sobra nada para passar adiante nem valor para corrigir.
 * Deixá-las marcadas e sem efeito seria mentir sobre o que o grupo faz.
 */
function aplicarSemLimite() {
  const sem = document.getElementById("gf-sem-limite");
  const ligado = !!(sem && sem.checked);

  const campo = document.getElementById("gf-aporte");
  if (campo) campo.parentElement.querySelector("label[for='gf-aporte']").style.display = ligado ? "none" : "";
  if (campo) campo.style.display = ligado ? "none" : "";

  const dica = document.getElementById("gf-dica-aporte");
  if (dica) {
    dica.textContent = ligado
      ? "O grupo aparece no gráfico e soma o gasto do mês, mas não tem teto para estourar."
      : "Depois de criado, o valor só muda pelo lápis no card — e só no mês corrente.";
  }

  ["gf-acumula", "gf-corrige"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = ligado;
    if (ligado) el.checked = false;
    if (el.parentElement) el.parentElement.style.opacity = ligado ? ".45" : "";
  });
}

function abrirFormGrupo(i) {
  const g = (i === null || i === undefined) ? null : gruposCompletos[i];
  grupoDeSaldoEditando = g;

  const semLim = document.getElementById("gf-sem-limite");
  if (semLim) {
    // Grupo já criado tem o aporte travado, então a caixa só é editável ao
    // CRIAR -- mudar "tem teto" depois reescreveria meses fechados.
    semLim.checked = g ? !!g.semLimite : false;
    semLim.disabled = !!g;
    if (semLim.parentElement) semLim.parentElement.style.opacity = g ? ".45" : "";
  }
  aplicarSemLimite();

  corGrupoEscolhida = g ? (g.cor || "") : "";
  corBordaGrupoEscolhida = g ? (g.corBorda || "") : "";

  montarRodaDeCor({
    ids: { alvos: "gf-alvos", roda: "gf-roda", knob: "gf-knob",
           escuro: "gf-roda-escuro", brilho: "gf-brilho" },
    alvos: [{ chave: "cor", rotulo: "Preenchimento", cor: corGrupoEscolhida },
            { chave: "borda", rotulo: "Contorno", cor: corBordaGrupoEscolhida }],
    aoMudar: function (chave, hex) {
      if (chave === "borda") corBordaGrupoEscolhida = hex; else corGrupoEscolhida = hex;
    }
  });

  document.getElementById("gf-titulo").textContent = g ? "Editar grupo" : "Novo grupo";
  document.getElementById("gf-nome").value = g ? g.nome : "";
  document.getElementById("gf-aporte").value = g ? g.aporte : "";
  document.getElementById("gf-acumula").checked = g ? !!g.acumula : true;
  document.getElementById("gf-corrige").checked = g ? !!g.corrige : true;
  document.getElementById("gf-ativo").checked = g ? (g.ativo !== false) : true;

  const campoAporte = document.getElementById("gf-aporte");
  campoAporte.disabled = !!g;
  document.getElementById("gf-dica-aporte").textContent = g
    ? "Para mudar o valor, use o lápis no card do dashboard — ele registra desde quando o novo vale."
    : "Depois de criado, o valor só muda pelo lápis no card, e só no mês corrente.";

  catsGrupo = g ? (g.categorias || []).slice() : [];
  pintarCategoriasDoGrupo();

  const aviso = document.getElementById("gf-aviso");
  aviso.textContent = "";
  aviso.classList.remove("aparece");

  document.getElementById("modal-grupo-form").style.display = "flex";
}

function fecharFormGrupo() {
  document.getElementById("modal-grupo-form").style.display = "none";
  grupoDeSaldoEditando = null;
}

function pintarCategoriasDoGrupo() {
  const el = document.getElementById("gf-categorias-txt");
  if (!el) return;

  if (!catsGrupo.length) {
    el.textContent = "Nenhuma";
    el.classList.add("vazio-cat");
  } else {
    el.textContent = catsGrupo.length === 1
      ? nomeDaCategoria(catsGrupo[0])
      : catsGrupo.length + " categorias";
    el.classList.remove("vazio-cat");
  }
}

async function salvarGrupoNaTela() {
  const nome = document.getElementById("gf-nome").value.trim();
  const aviso = document.getElementById("gf-aviso");

  function erro(msg) {
    aviso.textContent = msg;
    aviso.classList.add("aparece");
  }

  if (!nome) return erro("Dê um nome ao grupo.");

  const novo = !grupoDeSaldoEditando;
  const aporte = document.getElementById("gf-aporte").value;
  const semLimite = document.getElementById("gf-sem-limite").checked;
  // Sem limite não pede valor -- e passou a exigir MAIOR que zero quando há
  // limite: antes um "0" digitado passava e criava um grupo que estourava no
  // primeiro gasto, sem ninguém ter pedido teto nenhum.
  if (novo && !semLimite && !(parseFloat(aporte) > 0)) {
    return erro("Informe o valor mensal, ou marque que o grupo não tem limite.");
  }

  // Uma categoria em dois grupos é ambígua: o primeiro da lista ganharia, e
  // ninguém adivinha qual é o primeiro. Avisa antes de gravar.
  const conflito = catsGrupo.filter(function (c) {
    return gruposCompletos.some(function (g) {
      return g.nome !== (grupoDeSaldoEditando ? grupoDeSaldoEditando.nome : "") &&
             (g.categorias || []).indexOf(c) >= 0;
    });
  });
  if (conflito.length) {
    return erro("Já está em outro grupo: " + conflito.map(nomeDaCategoria).join(", ") +
                ". Tire de lá primeiro.");
  }

  try {
    const r = await chamarServidor("salvarGrupoDeSaldo", {
      nome: nome,
      original: grupoDeSaldoEditando ? grupoDeSaldoEditando.nome : "",
      aporte: aporte,
      categorias: catsGrupo.join("|"),
      acumula: document.getElementById("gf-acumula").checked ? "sim" : "não",
      corrige: document.getElementById("gf-corrige").checked ? "sim" : "não",
      ativo: document.getElementById("gf-ativo").checked ? "sim" : "não",
      // Sempre enviadas, inclusive vazias: o servidor só grava a coluna quando
      // o campo vem definido, então omitir seria o jeito de nunca conseguir
      // APAGAR uma cor depois de escolhida.
      semLimite: document.getElementById("gf-sem-limite").checked ? "sim" : "não",
      cor: corGrupoEscolhida,
      corBorda: corBordaGrupoEscolhida
    });

    if (!r.ok) return erro(r.mensagem || "Não deu para salvar.");

    fecharFormGrupo();
    mostrarToast("✅ " + r.mensagem);
    await recarregarDados();
    pintarGerenciarGrupos();

  } catch (e) {
    erro("Sem conexão.");
  }
}

/** Os grupos com a configuração inteira, para a tela de gerenciar. */
let gruposCompletos = [];

/** Os nomes dos grupos, para a ficha do lançamento poder oferecer a escolha. */
let gruposConhecidos = [];

/**
 * Quanto ainda cabe em cada combinado.
 *
 * O valor do aporte NÃO é despesa e não aparece em lugar nenhum das contas
 * reais: é só a referência contra a qual o gasto é medido. Quem gastou já
 * pesou no saldo do mês, uma vez só.
 */
function pintarGruposDeSaldo(d) {
  const card = document.getElementById("card-grupos");
  const lista = document.getElementById("grupos-lista");
  if (!card || !lista) return;

  const grupos = (d.gruposDeSaldo || []).filter(function (g) { return !g.antesDaOrigem; });
  gruposConhecidos = (d.gruposDeSaldo || []).map(function (g) { return g.nome; });
  gruposCompletos = (d.gruposDeSaldo || []).map(function (g) {
    return {
      nome: g.nome, aporte: g.aporteBase || g.aporte,
      categorias: g.categorias || [], acumula: g.acumula,
      corrige: g.corrige !== false, ativo: true
    };
  });

  if (!grupos.length) { card.style.display = "none"; return; }
  card.style.display = "block";

  lista.innerHTML = grupos.map(function (g, i) {
    const estourou = g.saldo < 0;

    // A barra mede o GASTO contra o disponível. Cheia e vermelha quando
    // passou: mostrar 110% de barra seria desenhar o que não cabe na régua.
    const pct = g.disponivel > 0
      ? Math.min(100, (g.gasto / g.disponivel) * 100)
      : (g.gasto > 0 ? 100 : 0);

    const cor = estourou ? "var(--vermelho)"
              : (pct >= 80 ? "var(--laranja)" : "var(--verde)");

    let nota = "";
    if (estourou) {
      nota = '<div class="gs-nota">Passou <b>' + formatarMoeda(Math.abs(g.saldo)) +
             '</b>' + (g.acumula ? ", que sai do mês que vem." : ".") + '</div>';
    } else if (g.acumulado > 0) {
      nota = '<div class="gs-nota">Inclui ' + formatarMoeda(g.acumulado) +
             ' que sobrou dos meses anteriores.</div>';
    } else if (g.acumulado < 0) {
      nota = '<div class="gs-nota">Já entrou devendo <b>' +
             formatarMoeda(Math.abs(g.acumulado)) + '</b> do mês passado.</div>';
    }

    // SEM LIMITE: o que importa é quanto saiu, e não quanto sobra de um
    // teto que não existe. Barra, "de X" e a cor de estouro saem da tela --
    // régua sem medida não mede nada, e pintar vermelho um grupo sem teto
    // seria acusar um estouro impossível.
    if (g.semLimite) {
      return '<div class="gs-item">' +
          '<div class="gs-topo">' +
            '<span class="gs-nome">' + escaparHtml(g.nome) + '</span>' +
            '<span class="gs-num">' + formatarMoeda(g.gasto) + '</span>' +
            '<span class="gs-de">sem limite</span>' +
          '</div>' +
        '</div>';
    }

    return '<div class="gs-item">' +
        '<div class="gs-topo">' +
          '<span class="gs-nome">' + escaparHtml(g.nome) + '</span>' +
          '<span class="gs-num" style="color:' + (estourou ? "var(--vermelho)" : "var(--verde)") + '">' +
            formatarMoeda(g.saldo) + '</span>' +
          '<span class="gs-de">de ' + formatarMoeda(g.disponivel) + '</span>' +
          (g.editavel
            ? '<button class="gs-editar" aria-label="Mudar o valor de ' + escaparHtml(g.nome) +
              '" onclick="mudarAporteDoGrupo(' + i + ')">&#9998;</button>'
            : '') +
        '</div>' +
        '<div class="gs-barra"><span style="width:' + pct + '%; background:' + cor + '"></span></div>' +
        nota +
      '</div>';
  }).join("");

  // Guardado para o lápis saber de quem é o valor que está mudando.
  pintarGruposDeSaldo.atuais = grupos;
}

/**
 * Muda o valor mensal de um grupo — só no mês corrente.
 *
 * O novo valor vira a base e segue sendo corrigido pela inflação a partir
 * dali. Um aumento só deste mês não precisa disto: basta gastar a mais, que o
 * acúmulo desconta do mês seguinte.
 */
async function mudarAporteDoGrupo(i) {
  const g = (pintarGruposDeSaldo.atuais || [])[i];
  if (!g) return;

  const txt = prompt(
    "Novo valor mensal de " + g.nome + "\n\n" +
    "Vale deste mês em diante, e segue corrigindo pela inflação.\n" +
    "Hoje: " + formatarMoeda(g.aporte) +
    (g.aporteBase !== g.aporte ? " (combinado original: " + formatarMoeda(g.aporteBase) + ")" : ""),
    String(g.aporte).replace(".", ","));

  if (txt === null) return;

  const valor = parseFloat(txt.toString().replace(/\./g, "").replace(",", "."));
  if (isNaN(valor) || valor < 0) { mostrarToast("⚠ Valor inválido."); return; }

  try {
    const r = await chamarServidor("ajustarAporteDoGrupo", {
      grupo: g.nome, valor: valor, mes: mesExibido, ano: anoExibido
    });
    if (!r.ok) { mostrarToast("⚠ " + (r.mensagem || "Não deu para mudar.")); return; }

    mostrarToast("✅ " + r.mensagem);
    await recarregarDados();
  } catch (e) {
    mostrarToast("⚠ Sem conexão.");
  }
}

/**
 * O aviso de contas vencidas, no topo da tela.
 *
 * Elas já apareciam na lista, com faixa vermelha -- mas no MEIO dela, depois
 * de rolar. Uma conta vencida é a única coisa do dashboard que pede ação
 * hoje, e era a que exigia mais esforço para descobrir.
 *
 * Só no mês corrente: "vencida" num mês passado que você está revisando é
 * história, não tarefa.
 */
function pintarAvisoVencidas(d) {
  const el = document.getElementById("aviso-vencidas");
  if (!el) return;

  const v = d.vencidas || {};
  const hj = new Date();
  const ehMesCorrente = (d.mes === hj.getMonth() && d.ano === hj.getFullYear());

  if (!v.quantidade || !ehMesCorrente) { el.style.display = "none"; return; }

  const uma = v.quantidade === 1;
  el.style.display = "flex";
  el.innerHTML =
    '<span class="av-marca"></span>' +
    '<span class="av-txt">' +
      '<b>' + v.quantidade + (uma ? " conta vencida" : " contas vencidas") + '</b>' +
      '<span>' + formatarMoeda(v.total) + (uma ? " em atraso" : " somados em atraso") + '</span>' +
    '</span>' +
    '<span class="av-ir">ver ›</span>';

  el.onclick = function () {
    const alvo = document.getElementById("lista-vencer");
    if (alvo) alvo.scrollIntoView({ behavior: "smooth", block: "center" });
  };
}

/**
 * Abre a busca já filtrada numa categoria, no mês que está na tela.
 *
 * O mês vai junto de propósito: o número que você tocou é o gasto DAQUELE
 * mês, e abrir a busca sem ele mostraria uma lista maior que o número --
 * aí some a ligação entre o que se tocou e o que apareceu.
 */
function abrirBuscaPorCategoria(categoria) {
  categoriasSelecionadas = [categoria];

  trocarAba("busca");

  // Depois de trocar de aba: os campos do filtro só existem com a tela montada.
  setTimeout(function () {
    const mes = document.getElementById("bl-mes");
    const ano = document.getElementById("bl-ano");
    if (mes) mes.value = String(mesExibido);
    if (ano) ano.value = String(anoExibido);

    const texto = document.getElementById("bl-texto");
    if (texto) texto.value = "";

    atualizarBotaoCategorias();
    executarBusca(true);
  }, 60);
}

/**
 * "35/100, era 42 em setembro."
 *
 * Um score sozinho não diz se a vida está melhorando ou piorando, que é a
 * única pergunta que importa num número desses.
 *
 * Sai de GRAÇA: o mês anterior já está guardado no aparelho pela pré-carga, e
 * o score dele foi calculado pelo mesmo servidor, com a mesma fórmula. Pedir
 * isso ao servidor custaria uma conta a mais em cada um dos 25 meses da
 * pré-carga para responder o que já está aqui.
 *
 * Sem o mês anterior guardado, não mostra nada -- nunca busca só para isto.
 */
function pintarTendenciaDoScore(d, sc) {
  const alvo = document.getElementById("score-tendencia");
  if (!alvo) return;
  alvo.style.display = "none";

  if (!sc || sc.valor === null || sc.valor === undefined) return;

  let mes = d.mes - 1, ano = d.ano;
  if (mes < 0) { mes = 11; ano--; }

  let antes = null;
  try {
    const bruto = localStorage.getItem(
      CACHE_LEITURA + "dashboard|" + JSON.stringify({ ano: ano, mes: mes }));
    if (bruto) {
      const p = JSON.parse(bruto);
      if (p && p.dados && p.dados.score) antes = p.dados.score.valor;
    }
  } catch (e) {}

  // Score zero do mês anterior quase sempre quer dizer "não havia receita
  // lançada ainda", não "a vida estava péssima". Comparar com ele daria um
  // salto de 35 pontos que não aconteceu.
  if (antes === null || antes === undefined || antes === 0) return;

  const dif = sc.valor - antes;
  const nome = ((d.comparacao && d.comparacao.mesBaseNome) || "mês passado").toLowerCase();

  alvo.style.display = "block";
  alvo.innerHTML = (Math.abs(dif) < 1)
    ? '<span class="st-igual">igual a ' + escaparHtml(nome) + '</span>'
    : '<span class="st-seta ' + (dif > 0 ? "subiu" : "caiu") + '">' +
        (dif > 0 ? "▲" : "▼") + '</span>' +
      '<span>' + (dif > 0 ? "+" : "−") + Math.abs(dif) +
      ' contra ' + escaparHtml(nome) + ' (' + antes + ')</span>';
}

/**
 * O ritmo do mês: o que dá para gastar por dia daqui até o fim.
 *
 * É o número mais acionável do app -- o saldo diz como o mês está, este diz o
 * que fazer hoje. Já existia no widget da tela inicial do celular e não
 * existia dentro do app, que é onde a pessoa olha quando está decidindo.
 *
 * Só no mês corrente: num mês fechado não há "quanto ainda dá", e num mês
 * futuro o dia de hoje não quer dizer nada.
 */
function pintarRitmo(d) {
  const card = document.getElementById("card-ritmo");
  const r = d.ritmo;
  if (!card) return;

  if (!r) { card.style.display = "none"; return; }
  card.style.display = "block";

  const negativo = r.porDia < 0;

  document.getElementById("rt-grade").innerHTML =
    '<div class="rt-caixa">' +
      '<span class="rt-rot">Por dia até o fim</span>' +
      '<span class="rt-val" style="color:' + (negativo ? "var(--vermelho)" : "var(--verde)") + '">' +
        formatarMoeda(Math.abs(r.porDia)) + '</span>' +
      '<span class="rt-sub">' + (negativo ? "já passou do que tinha" : "em " + r.diasRestantes + " dias que faltam") + '</span>' +
    '</div>' +
    '<div class="rt-caixa">' +
      '<span class="rt-rot">Dia do mês</span>' +
      '<span class="rt-val">' + r.dia + '<span style="font-size:13px;font-weight:600;color:var(--cinza-texto)">/' + r.diasNoMes + '</span></span>' +
      '<span class="rt-sub">' + Math.round((r.dia / r.diasNoMes) * 100) + '% do mês</span>' +
    '</div>';

  // A comparação com o mês passado, no MESMO recorte de dias. Sem o recorte,
  // todo começo de mês diria "você gastou 80% menos", que é verdade e não
  // serve para nada.
  const c = d.comparacao || {};
  const nota = document.getElementById("rt-nota");

  if (c.variacao === null || c.variacao === undefined) {
    nota.innerHTML = "Sem gasto no mês anterior para comparar.";
    return;
  }

  const subiu = c.variacao >= 0;
  nota.innerHTML =
    '<div class="comparacao">' +
      '<span class="cp-seta ' + (subiu ? "subiu" : "caiu") + '">' + (subiu ? "▲" : "▼") + '</span>' +
      '<span>Até o dia ' + c.ateODiaDoMes + ' você gastou <b>' + formatarMoeda(c.ateODia) +
      '</b> — ' + (subiu ? "mais" : "menos") + ' <b>' + Math.abs(c.variacao).toFixed(0) +
      '%</b> que no mesmo ponto de ' + escaparHtml(c.mesBaseNome || "mês passado").toLowerCase() +
      ' (' + formatarMoeda(c.anterior) + ').</span>' +
    '</div>';
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
  else if (res.tipo === "gruposSaldo")    corpo = htmlGruposSaldo(res);
  else if (res.tipo === "cartoes")        corpo = htmlCartoes(res);
  else if (res.tipo === "miudos")         corpo = htmlMiudos(res);
  else if (res.tipo === "fixasRealizado") corpo = htmlFixasRealizado(res);
  else if (res.tipo === "retratoAno")     corpo = htmlRetratoAno(res);
  else if (res.tipo === "planos")         corpo = htmlPlanos(res);

  corpo = interruptorPlanos(res) + corpo;

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

// ============================================================================
// OS SEIS RELATÓRIOS NOVOS
// ============================================================================

/** Uma linha de rótulo + valor, o par que mais se repete nestes relatórios. */
function nvLinha(rot, valor, classe) {
  return '<div class="nv-linha"><span>' + escaparHtml(rot) + '</span>' +
         '<b class="' + (classe || "") + '">' + valor + '</b></div>';
}

/** Barra de proporção. O canal afundado é o mesmo das outras barras do app. */
function nvBarra(pct, cor) {
  const p = Math.max(0, Math.min(100, pct));
  return '<div class="nv-barra"><span style="width:' + p.toFixed(1) + '%; background:' + cor + '"></span></div>';
}

// ---------------------------------------------------------------------------
function htmlGruposSaldo(r) {
  if (!r.grupos.length) {
    return '<div class="card"><p class="vazio">Nenhum grupo de saldo vale neste mês.</p>' +
      '<div class="rel-nota">Os grupos passam a valer a partir do mês de origem de cada um.</div></div>';
  }

  const proximo = (r.proximoMesNome || "").toLowerCase() || "o mês que vem";

  let blocos = "";
  r.grupos.forEach(function (g) {
    const estourou = g.saldo < 0;
    const pct = g.disponivel > 0 ? (g.gasto / g.disponivel) * 100 : (g.gasto > 0 ? 100 : 0);

    let itens = "";
    if (g.itens.length) {
      itens = '<table class="rel-tabela compacta" style="margin-top:10px;"><tbody>';
      g.itens.forEach(function (it) {
        itens += '<tr><td>' + escaparHtml(it.data) + '</td>' +
          '<td>' + escaparHtml(it.descricao) +
            (it.parcela ? ' <span class="cinza">' + escaparHtml(it.parcela) + '</span>' : '') + '</td>' +
          '<td class="num">' + formatarMoeda(it.valor) + '</td></tr>';
      });
      itens += '</tbody></table>';
    } else {
      itens = '<p class="vazio" style="margin-top:8px;">Nada gasto neste grupo.</p>';
    }

    blocos +=
      '<div class="card">' +
        '<h2>' + escaparHtml(g.nome) + '</h2>' +
        nvLinha("Aporte do mês", formatarMoeda(g.aporte)) +
        (g.acumulado !== 0
          ? nvLinha("Veio do mês anterior", formatarMoeda(g.acumulado),
                    g.acumulado < 0 ? "vermelho" : "verde")
          : "") +
        nvLinha("Disponível", formatarMoeda(g.disponivel)) +
        nvLinha("Gasto", formatarMoeda(g.gasto)) +
        nvBarra(pct, estourou ? "var(--vermelho)" : "var(--verde)") +
        '<div class="nv-destaque ' + (estourou ? "vermelho" : "verde") + '">' +
          (estourou ? "Passou " + formatarMoeda(-g.saldo) : "Sobrou " + formatarMoeda(g.saldo)) +
        '</div>' +
        (g.acumula
          ? '<div class="rel-nota">' +
              (estourou
                ? "Estes " + formatarMoeda(-g.saldo) + " saem do aporte de " + proximo + "."
                : "Estes " + formatarMoeda(g.saldo) + " entram no aporte de " + proximo + ".") +
            '</div>'
          : '<div class="rel-nota">Este grupo não acumula: o que sobra não passa adiante.</div>') +
        itens +
      '</div>';
  });

  return blocos +
    '<div class="card">' +
      '<h2>Somados</h2>' +
      nvLinha("Aportes", formatarMoeda(r.totais.aporte)) +
      nvLinha("Gastos", formatarMoeda(r.totais.gasto)) +
      nvLinha("Saldo", formatarMoeda(r.totais.saldo), r.totais.saldo < 0 ? "vermelho" : "verde") +
      '<div class="rel-nota">Este dinheiro não está reservado em conta nenhuma. ' +
      'Os grupos são uma máscara sobre o mesmo saldo.</div>' +
    '</div>';
}

// ---------------------------------------------------------------------------
function htmlCartoes(r) {
  if (r.semCartoes) {
    return '<div class="card"><p class="vazio">Nenhum cartão configurado.</p>' +
      '<div class="rel-nota">Cadastre em Configurações → Cartões.</div></div>';
  }

  let blocos = "";
  r.cartoes.forEach(function (c) {
    let itens = "";
    if (c.itens.length) {
      itens = '<table class="rel-tabela compacta" style="margin-top:10px;"><tbody>';
      c.itens.forEach(function (it) {
        itens += '<tr><td>' + escaparHtml(it.descricao) +
            (it.parcela ? ' <span class="cinza">' + escaparHtml(it.parcela) + '</span>' : '') + '</td>' +
          '<td class="num">' + formatarMoeda(it.valor) + '</td></tr>';
      });
      itens += '</tbody></table>';
      if (c.itensOcultos > 0) {
        itens += '<div class="rel-nota">E mais ' + c.itensOcultos + ' lançamento(s) menores.</div>';
      }
    }

    blocos +=
      '<div class="card">' +
        '<h2>' + escaparHtml(c.nome) + '</h2>' +
        '<div class="nv-heroi">' + formatarMoeda(c.fatura) + '</div>' +
        '<div class="nv-heroi-rot">fatura que vence dia ' + c.diaVencimento + '</div>' +
        nvLinha("De parcela de compra antiga", formatarMoeda(c.deParcelaAntiga)) +
        nvLinha("De compra deste mês", formatarMoeda(c.deCompraNova)) +
        (c.temLimite
          ? nvLinha("Limite preso em parcela não paga", formatarMoeda(c.comprometido)) +
            nvBarra(c.usoPct, c.usoPct >= 80 ? "var(--vermelho)" : (c.usoPct >= 50 ? "var(--laranja)" : "var(--verde)")) +
            '<div class="nv-destaque ' + (c.disponivel < 0 ? "vermelho" : "verde") + '">' +
              formatarMoeda(c.disponivel) + ' de limite livre &middot; ' + c.usoPct + '% usado' +
            '</div>' +
            (c.parcelasFuturas > 0
              ? '<div class="rel-nota">' + formatarMoeda(c.parcelasFuturas) +
                ' disso vence depois deste mês — é parcela que ainda vai chegar.</div>'
              : '')
          : '<div class="rel-nota">Limite não cadastrado para este cartão, ' +
            'então não dá para dizer quanto sobrou. O valor vai em Configurações → Cartões.</div>') +
        itens +
      '</div>';
  });

  return blocos;
}

// ---------------------------------------------------------------------------
function htmlMiudos(r) {
  if (!r.quantos) {
    return '<div class="card"><p class="vazio">Nenhuma compra de até ' +
      formatarMoeda(r.teto) + ' neste mês.</p></div>';
  }

  let cats = '<table class="rel-tabela"><thead><tr>' +
    '<th>Categoria</th><th class="num">Quantas</th><th class="num">Total</th>' +
    '</tr></thead><tbody>';
  r.categorias.forEach(function (c) {
    cats += '<tr><td class="cat">' + escaparHtml(nomeDaCategoria(c.categoria)) + '</td>' +
      '<td class="num">' + c.quantos + '</td>' +
      '<td class="num">' + formatarMoeda(c.total) + '</td></tr>';
  });
  cats += '</tbody></table>';

  let itens = '<table class="rel-tabela compacta"><tbody>';
  r.itens.forEach(function (it) {
    itens += '<tr><td>' + escaparHtml(it.data) + '</td>' +
      '<td>' + escaparHtml(it.descricao) + '</td>' +
      '<td class="num">' + formatarMoeda(it.valor) + '</td></tr>';
  });
  itens += '</tbody></table>';

  return (
    '<div class="card">' +
      '<div class="nv-heroi">' + formatarMoeda(r.soma) + '</div>' +
      '<div class="nv-heroi-rot">em ' + r.quantos + ' compras de até ' + formatarMoeda(r.teto) + '</div>' +
      nvBarra(r.fatiaPct, "var(--laranja)") +
      '<div class="nv-destaque laranja">' + r.fatiaPct + '% de tudo que saiu no mês</div>' +
      nvLinha("Média por compra", formatarMoeda(r.mediaPorItem)) +
      nvLinha("Despesa total do mês", formatarMoeda(r.totalDoMes)) +
      '<div class="rel-nota">Cada uma é pequena demais para chamar atenção ' +
      'sozinha. Somadas, são ' + r.fatiaPct + '% de tudo que saiu no mês.</div>' +
    '</div>' +
    '<div class="card"><h2>Em que caem</h2>' + cats + '</div>' +
    '<div class="card"><h2>As compras</h2>' + itens +
      (r.itensOcultos > 0
        ? '<div class="rel-nota">E mais ' + r.itensOcultos + ' abaixo destas.</div>'
        : '') +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
function htmlFixasRealizado(r) {
  if (!r.fixas.length) {
    return '<div class="card"><p class="vazio">Nenhuma despesa fixa cadastrada.</p></div>';
  }

  let linhas = "";
  r.fixas.forEach(function (f) {
    const marca = f.destaque === "faltou"
      ? '<span class="nv-tag vermelho">não lançou</span>'
      : (f.destaque === "mudou"
        ? '<span class="nv-tag laranja">' + (f.diferenca > 0 ? "+" : "") + f.variacaoPct + '%</span>'
        : '');

    linhas +=
      '<tr>' +
        '<td>' + escaparHtml(f.descricao) + ' ' + marca +
          (f.temCorrecao ? '<span class="cinza" style="display:block;font-size:10px;">com correção</span>' : '') +
        '</td>' +
        '<td class="num">' + formatarMoeda(f.previsto) + '</td>' +
        '<td class="num">' + (f.lancou ? formatarMoeda(f.realizado) : '<span class="cinza">—</span>') + '</td>' +
        '<td class="num ' + (f.diferenca > 0 ? "vermelho" : (f.diferenca < 0 ? "verde" : "")) + '">' +
          (f.lancou ? (f.diferenca > 0 ? "+" : "") + formatarMoeda(f.diferenca) : "") +
        '</td>' +
      '</tr>';
  });

  const t = r.totais;

  return (
    '<div class="card">' +
      (t.faltando > 0
        ? '<div class="nv-destaque vermelho">' + t.faltando +
          (t.faltando === 1 ? ' fixa não foi lançada' : ' fixas não foram lançadas') + ' neste mês</div>'
        : '<div class="nv-destaque verde">Todas as fixas foram lançadas</div>') +
      (t.mudaram > 0
        ? nvLinha("Mudaram mais de 10%", t.mudaram + (t.mudaram === 1 ? " conta" : " contas"), "laranja")
        : "") +
      nvLinha("Cadastrado", formatarMoeda(t.previsto)) +
      nvLinha("Realizado", formatarMoeda(t.realizado)) +
      nvLinha("Diferença", (t.diferenca > 0 ? "+" : "") + formatarMoeda(t.diferenca),
              t.diferenca > 0 ? "vermelho" : "verde") +
    '</div>' +
    '<div class="card">' +
      '<table class="rel-tabela"><thead><tr>' +
        '<th>Conta</th><th class="num">Cadastrado</th><th class="num">Lançado</th><th class="num">Dif.</th>' +
      '</tr></thead><tbody>' + linhas + '</tbody></table>' +
      '<div class="rel-nota">A conta é reconhecida pela CATEGORIA, não pelo nome: ' +
      '"Enel" e "Conta de luz" são a mesma fixa. Se duas fixas dividem a mesma ' +
      'categoria, o lançado aparece somado nas duas.</div>' +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
function htmlRetratoAno(r) {
  const t = r.totais;
  if (!t.mesesComDados) {
    return '<div class="card"><p class="vazio">Nenhum lançamento em ' + r.ano + '.</p></div>';
  }

  // A régua é o maior valor do ano, dos dois lados: comparar receita com
  // despesa na mesma escala é o que deixa ler o ano de relance.
  let teto = 0;
  r.meses.forEach(function (m) {
    teto = Math.max(teto, m.receitas, m.despesas);
  });

  let barras = "";
  r.meses.forEach(function (m) {
    if (!m.temDados) {
      barras += '<div class="nv-mes"><span class="nv-mes-nome cinza">' + m.abrev + '</span>' +
        '<span class="nv-mes-barras"></span>' +
        '<span class="nv-mes-val cinza">—</span></div>';
      return;
    }
    const pr = teto > 0 ? (m.receitas / teto) * 100 : 0;
    const pd = teto > 0 ? (m.despesas / teto) * 100 : 0;
    barras +=
      '<div class="nv-mes">' +
        '<span class="nv-mes-nome">' + m.abrev + '</span>' +
        '<span class="nv-mes-barras">' +
          '<span class="nv-mes-b" style="width:' + pr.toFixed(1) + '%; background:var(--verde)"></span>' +
          '<span class="nv-mes-b" style="width:' + pd.toFixed(1) + '%; background:var(--vermelho)"></span>' +
        '</span>' +
        '<span class="nv-mes-val ' + (m.saldo >= 0 ? "verde" : "vermelho") + '">' +
          (m.saldo >= 0 ? "+" : "−") + Math.abs(Math.round(m.saldo)).toLocaleString("pt-BR") +
        '</span>' +
      '</div>';
  });

  function tabelaMudanca(titulo, lista, cor) {
    if (!lista.length) return "";
    let l = "";
    lista.forEach(function (x) {
      l += '<tr><td class="cat">' + escaparHtml(nomeDaCategoria(x.categoria)) + '</td>' +
        '<td class="num">' + formatarMoeda(x.antes) + '</td>' +
        '<td class="num">' + formatarMoeda(x.agora) + '</td>' +
        '<td class="num ' + cor + '">' + (x.pct > 0 ? "+" : "") + x.pct + '%</td></tr>';
    });
    return '<div class="card"><h2>' + titulo + '</h2>' +
      '<table class="rel-tabela"><thead><tr><th>Categoria</th>' +
      '<th class="num">' + (r.ano - 1) + '</th><th class="num">' + r.ano + '</th>' +
      '<th class="num">Var.</th></tr></thead><tbody>' + l + '</tbody></table></div>';
  }

  let maiores = "";
  r.maioresCategorias.forEach(function (c) {
    maiores += '<tr><td class="cat">' + escaparHtml(nomeDaCategoria(c.categoria)) + '</td>' +
      '<td class="num">' + formatarMoeda(c.total) + '</td></tr>';
  });

  return (
    '<div class="card">' +
      '<div class="nv-heroi ' + (t.saldo >= 0 ? "verde" : "vermelho") + '">' + formatarMoeda(t.saldo) + '</div>' +
      '<div class="nv-heroi-rot">' + (t.saldo >= 0 ? "sobrou" : "faltou") +
        ' em ' + t.mesesComDados + (t.mesesComDados === 1 ? " mês" : " meses") + ' de ' + r.ano + '</div>' +
      nvLinha("Entrou", formatarMoeda(t.receitas)) +
      nvLinha("Saiu", formatarMoeda(t.despesas)) +
      nvLinha("Sobra média por mês", formatarMoeda(t.mediaSobra)) +
      '<div class="nv-destaque ' + (t.taxaGuardadaPct >= 0 ? "verde" : "vermelho") + '">' +
        'De cada R$ 100 que entraram, ficaram R$ ' + t.taxaGuardadaPct + '</div>' +
    '</div>' +

    '<div class="card"><h2>Mês a mês</h2>' + barras +
      '<div class="nv-legenda">' +
        '<span><i style="background:var(--verde)"></i>entrou</span>' +
        '<span><i style="background:var(--vermelho)"></i>saiu</span>' +
      '</div>' +
    '</div>' +

    '<div class="card"><h2>O melhor e o pior</h2>' +
      (r.melhorMes ? nvLinha(r.melhorMes.nome, formatarMoeda(r.melhorMes.saldo), "verde") : "") +
      (r.piorMes ? nvLinha(r.piorMes.nome, formatarMoeda(r.piorMes.saldo),
                           r.piorMes.saldo < 0 ? "vermelho" : "") : "") +
    '</div>' +

    '<div class="card"><h2>Para onde foi</h2>' +
      '<table class="rel-tabela"><tbody>' + maiores + '</tbody></table></div>' +

    (r.temAnoAnterior
      ? tabelaMudanca("O que mais subiu", r.subiram, "vermelho") +
        tabelaMudanca("O que mais caiu", r.cairam, "verde")
      : '<div class="card"><div class="rel-nota">Sem dados de ' + (r.ano - 1) +
        ' para comparar, então não dá para dizer o que subiu ou caiu.</div></div>')
  );
}

// ---------------------------------------------------------------------------
function htmlPlanos(r) {
  if (r.semPlanos) {
    return '<div class="card"><p class="vazio">Nenhum plano de compra cadastrado.</p></div>';
  }

  const t = r.totais;

  let comprados = "";
  r.comprados.forEach(function (c) {
    comprados +=
      '<tr>' +
        '<td>' + escaparHtml(c.titulo) +
          (c.paraQuem ? '<span class="cinza" style="display:block;font-size:10px;">' +
            escaparHtml(c.paraQuem) + '</span>' : '') +
        '</td>' +
        '<td class="num">' + formatarMoeda(c.previsto) + '</td>' +
        '<td class="num">' + (c.encontrou
          ? formatarMoeda(c.realizado)
          : '<span class="cinza">não achei</span>') + '</td>' +
        '<td class="num ' + (c.diferenca > 0 ? "vermelho" : (c.diferenca < 0 ? "verde" : "")) + '">' +
          (c.encontrou ? (c.diferenca > 0 ? "+" : "") + formatarMoeda(c.diferenca) : "") +
        '</td>' +
      '</tr>';
  });

  let esperando = "";
  r.esperando.forEach(function (e) {
    esperando += '<tr><td>' + escaparHtml(e.titulo) + '</td>' +
      '<td class="num">' + formatarMoeda(e.valor) + '</td>' +
      '<td class="num">' + (e.diasEsperando !== null ? e.diasEsperando + " dias" : "—") + '</td></tr>';
  });

  let reprovados = "";
  r.reprovados.forEach(function (x) {
    reprovados += '<tr><td>' + escaparHtml(x.titulo) +
      (x.motivo ? '<span class="cinza" style="display:block;font-size:10px;">' +
        escaparHtml(x.motivo) + '</span>' : '') + '</td>' +
      '<td class="num">' + formatarMoeda(x.valor) + '</td></tr>';
  });

  return (
    '<div class="card">' +
      nvLinha("Comprou", formatarMoeda(t.gastou)) +
      nvLinha("Tinha estimado", formatarMoeda(t.estimou)) +
      nvLinha("Diferença", (t.diferenca > 0 ? "+" : "") + formatarMoeda(t.diferenca),
              t.diferenca > 0 ? "vermelho" : "verde") +
      (t.economizou > 0
        ? '<div class="nv-destaque verde">' + formatarMoeda(t.economizou) +
          ' em planos reprovados — dinheiro que não saiu</div>'
        : "") +
    '</div>' +

    (comprados
      ? '<div class="card"><h2>Comprados</h2>' +
        '<table class="rel-tabela"><thead><tr><th>O quê</th>' +
        '<th class="num">Estimado</th><th class="num">Pago</th><th class="num">Dif.</th>' +
        '</tr></thead><tbody>' + comprados + '</tbody></table>' +
        (t.naoEncontrados > 0
          ? '<div class="rel-nota">' + t.naoEncontrados + ' compra(s) sem lançamento ' +
            'correspondente. O casamento é feito pelo NOME do plano — se o lançamento ' +
            'foi renomeado depois, ele não é encontrado.</div>'
          : '')
      + '</div>'
      : "") +

    (esperando
      ? '<div class="card"><h2>Ainda esperando</h2>' +
        '<table class="rel-tabela"><thead><tr><th>O quê</th>' +
        '<th class="num">Valor</th><th class="num">Há</th></tr></thead><tbody>' +
        esperando + '</tbody></table></div>'
      : "") +

    (reprovados
      ? '<div class="card"><h2>Reprovados</h2>' +
        '<table class="rel-tabela"><tbody>' + reprovados + '</tbody></table></div>'
      : "")
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
             '<p style="font-size:15px; color:var(--texto-2); font-weight:600;">Nenhum parcelamento em aberto!</p>' +
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

  // Com os planos ligados, a barra ganha um pedaço claro em cima: o real
  // continua sendo a parte cheia, e o acréscimo se vê separado.
  // O teto considera tudo que a barra pode mostrar: real + fixas previstas +
  // planos. Com um teto só do real, a parte prevista estouraria a coluna.
  const teto = Math.max.apply(null, r.meses.map(function (m) {
    return (m.total || 0) + (m.fixasPrevistas || 0) +
           (r.comPlanos ? (m.planos || 0) : 0);
  })) || 1;

  let barras = "";
  r.meses.forEach(function (m) {
    // Três camadas empilhadas, da mais alta para a mais baixa: planos (se
    // ligados), fixas previstas, e o real por cima de tudo. Cada faixa que
    // sobra aparecendo é o acréscimo daquela camada.
    const prev = m.fixasPrevistas || 0;
    const plan = r.comPlanos ? (m.planos || 0) : 0;

    const hReal = (m.total / teto) * 100;
    const hFixas = prev ? ((m.total + prev) / teto) * 100 : 0;
    const hPlano = plan ? ((m.total + prev + plan) / teto) * 100 : 0;
    const mostrado = m.total + prev + plan;

    barras +=
      '<div class="pj-col">' +
        '<div class="pj-valor">' + (mostrado > 0 ? formatarMoedaCurta(mostrado) : "—") + '</div>' +
        '<div class="pj-bar-wrap">' +
          (hPlano ? '<div class="pj-bar-plano" style="height:' + hPlano + '%"></div>' : '') +
          (hFixas ? '<div class="pj-bar-fixa" style="height:' + hFixas + '%"></div>' : '') +
          '<div class="pj-bar" style="height:' + hReal + '%"></div>' +
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

    // Real e previsto em linhas separadas, sempre. Se um número parecer
    // errado, é preciso saber de qual lado ele veio -- somar os dois num
    // total só esconderia justamente isso.
    const prevMes = m.fixasPrevistas || 0;

    linhas +=
      '<div class="pj-mes-bloco">' +
        '<div class="pj-mb-topo">' +
          '<span>' + escaparHtml(m.nome) + '</span>' +
          '<b class="vermelho">' + formatarMoeda(m.total) + '</b>' +
        '</div>' +
        (prevMes
          ? '<div class="pj-previsto">' +
              '<span>fixas ainda não lançadas</span>' +
              '<b>+ ' + formatarMoeda(prevMes) + '</b>' +
            '</div>' +
            '<div class="pj-somado">' +
              '<span>total esperado</span>' +
              '<b>' + formatarMoeda(m.total + prevMes) + '</b>' +
            '</div>'
          : '') +
        '<div class="pj-mb-sub">' +
          (m.parcelas > 0 ? '📦 Parcelas: ' + formatarMoeda(m.parcelas) + ' &middot; ' : '') +
          '🧾 À vista: ' + formatarMoeda(m.avista) +
          (m.receitas > 0 ? ' &middot; 🟢 Receitas: ' + formatarMoeda(m.receitas) : '') +
        '</div>' +
        (cats ? '<div class="pj-cats">' + cats + '</div>' : '') +
      '</div>';
  });

  const legenda = (r.totalFixasPrevistas > 0)
    ? '<div class="pj-legenda">' +
        '<span><i class="pj-amostra real"></i>lançado</span>' +
        '<span><i class="pj-amostra fixa"></i>fixa prevista</span>' +
        (r.comPlanos ? '<span><i class="pj-amostra plano"></i>plano de compra</span>' : '') +
        '<div class="pj-legenda-nota">A previsão sai do cadastro de despesas fixas. ' +
          'Quando você lança, ela sai daqui e entra no valor lançado.</div>' +
      '</div>'
    : "";

  const alerta = res.comprometimentoMedio > 80
    ? '<div class="pj-alerta critico">🔴 Comprometimento médio de <b>' + res.comprometimentoMedio.toFixed(1) + '%</b> da sua receita base.</div>'
    : (res.comprometimentoMedio > 50
      ? '<div class="pj-alerta atencao">🟠 Comprometimento médio de <b>' + res.comprometimentoMedio.toFixed(1) + '%</b> da sua receita base.</div>'
      : '<div class="pj-alerta ok">🟢 Comprometimento médio de <b>' + res.comprometimentoMedio.toFixed(1) + '%</b> da sua receita base.</div>');

  return (
    '<div class="card">' +
      '<h2>Comprometimento mês a mês</h2>' +
      '<div class="pj-grafico">' + barras + '</div>' +
      legenda +
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
  fixo:       { icone: "📌", cor: "var(--verde)", nome: "Fixo / recorrente",
                desc: "Estável. Previsto pelo último valor (não pela média)." },
  variavel:   { icone: "📊", cor: "var(--laranja)", nome: "Recorrente variável",
                desc: "Oscila. Previsto pela média ponderada, com faixa." },
  sazonal:    { icone: "🗓️", cor: "#8e44ad", nome: "Sazonal",
                desc: "Só cai em meses específicos." },
  eventual:   { icone: "🎲", cor: "var(--fraco-2)", nome: "Eventual",
                desc: "Esporádico. Não é previsível — não entra no total." }
};

const CONFIANCA_INFO = {
  maxima: { txt: "certeza", cor: "#2563eb" },
  alta:   { txt: "alta",    cor: "var(--verde)" },
  media:  { txt: "média",   cor: "var(--laranja)" },
  baixa:  { txt: "baixa",   cor: "var(--fraco-2)" }
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

  // "resposta", e não "dados": o parâmetro desta função já se chama dados.
  const resposta = await resp.json();
  if (resposta && resposta._carimbou) resposta._carimbou.forEach(sujarDominio);
  return resposta;
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
  carregarSugestoesDescricao();
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
  habilitarCaminhosDoDocumento(false);

  // O botão de confirmar fica desabilitado durante o envio e o modal fecha
  // antes da resposta chegar. Sem religar aqui, o 2º lançamento pegava o
  // botão cinza e travado em "Enviando...".
  const btnConfirmar = document.getElementById("dr-btn-confirmar");
  btnConfirmar.disabled = false;
  btnConfirmar.textContent =
    modoDocumento === "lancar" ? "✅ Lançar" : "📎 Arquivar no e-mail";

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

    habilitarCaminhosDoDocumento(true);
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
      const rl = await lerCacheado("listasValidas");
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

  // A IA leu a categoria; se ela tem regra, o grupo ja vem marcado -- e a
  // dica diz por que, para nao parecer que o app escolheu sozinho no escuro.
  document.getElementById("dr-grupo").value = "";
  document.getElementById("dr-grupo").removeAttribute("data-manual");
  document.getElementById("dr-grupo-dica").textContent = "";
  pintarChipsDeGrupo("dr");
  sugerirGrupoPelaCategoria("dr");

  // Se a IA identificou um cartão, a fatura decide o vencimento — não o
  // que estava escrito no comprovante.
  preencherVencimentoCartao("dr");
  esconderJaPagoSeCartao("dr", normalizarBusca(document.getElementById("dr-metodo").value || "").indexOf("cart") !== -1);

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
    const sug = document.getElementById("dr-sugestoes");
    if (sug) sug.innerHTML = "";
    return;
  }

  // Quem tem o documento na mão sabe o valor, não o Nº Mov: as despesas em
  // aberto com valor parecido viram atalho.
  sugerirDespesasParaVincular();
}

async function sugerirDespesasParaVincular() {
  const alvo = document.getElementById("dr-sugestoes");
  if (!alvo) return;

  const valor = dadosExtraidos ? parseFloat(dadosExtraidos.valor_total) : 0;
  if (!valor || valor <= 0) { alvo.innerHTML = ""; return; }

  alvo.innerHTML = '<div class="cfg-aviso">Procurando despesas de ' + formatarMoeda(valor) + '...</div>';

  try {
    const r = await chamarServidor("sugerirDespesasPorValor", { valor: String(valor) });

    if (!r.ok || !r.sugestoes || r.sugestoes.length === 0) {
      alvo.innerHTML = '<div class="cfg-aviso">Nenhuma despesa em aberto perto de ' +
                       formatarMoeda(valor) + '. Digite o Nº abaixo.</div>';
      return;
    }

    // As faturas vêm somadas por cartão + vencimento, como em "contas a
    // vencer": o comprovante traz o total da fatura, não o de cada compra.
    faturasSugeridas = r.sugestoes.filter(function (s) { return s.ehFatura; });

    let html = '<div class="cfg-aviso">Despesas em aberto com valor parecido:</div>';
    r.sugestoes.forEach(function (s) {
      if (s.ehFatura) {
        const idx = faturasSugeridas.indexOf(s);
        html +=
          '<button type="button" class="sug-item" onclick="escolherFaturaSugerida(' + idx + ')">' +
            '<span class="sug-info">' +
              '<b>💳 ' + escaparHtml(s.descricao) + '</b>' +
              '<span class="sug-sub">vence ' + escaparHtml(s.vencimento) +
                ' · ' + escaparHtml(s.parcela) + '</span>' +
            '</span>' +
            '<span class="sug-valor' + (s.exato ? " exato" : "") + '">' + formatarMoeda(s.valor) + '</span>' +
          '</button>';
        return;
      }

      const detalhe = [s.vencimento ? "vence " + s.vencimento : "", s.metodo, s.parcela]
        .filter(function (x) { return x; }).join(" · ");

      html +=
        '<button type="button" class="sug-item" onclick="escolherSugestao(' + s.numMov + ')">' +
          '<span class="sug-info">' +
            '<b>' + escaparHtml(s.descricao) + '</b>' +
            '<span class="sug-sub">MOV-' + s.numMov + (detalhe ? " · " + escaparHtml(detalhe) : "") + '</span>' +
          '</span>' +
          '<span class="sug-valor' + (s.exato ? " exato" : "") + '">' + formatarMoeda(s.valor) + '</span>' +
        '</button>';
    });

    alvo.innerHTML = html;
  } catch (e) {
    alvo.innerHTML = '<div class="cfg-aviso">Não consegui buscar sugestões. Digite o Nº abaixo.</div>';
  }
}

function escolherSugestao(numMov) {
  document.getElementById("dr-nummov").value = numMov;
  buscarDespesaPorMov();   // já mostra a despesa e a opção de atualizar o valor
}

// Fatura escolhida a partir do comprovante. Guardada aqui porque ela não tem
// Nº Mov — o que a identifica é o par cartão + vencimento.
let faturasSugeridas = [];
let faturaEscolhida = null;

function escolherFaturaSugerida(indice) {
  const f = faturasSugeridas[indice];
  if (!f) return;

  faturaEscolhida = f;
  document.getElementById("dr-nummov").value = "";

  const bloco = document.getElementById("dr-despesa-encontrada");
  bloco.style.display = "block";
  bloco.innerHTML =
    '<div class="dr-achou">' +
      '<b>💳 ' + escaparHtml(f.descricao) + '</b><br>' +
      '<span class="dr-achou-sub">Vence ' + escaparHtml(f.vencimento) +
        ' · ' + escaparHtml(f.parcela) + ' · ' + formatarMoeda(f.valor) + '</span><br>' +
      '<span class="dr-achou-sub">O comprovante será anexado à fatura inteira, ' +
        'e todas as compras dela serão liquidadas de uma vez.</span>' +
    '</div>' +
    '<button type="button" class="btn-modal cancelar" style="width:100%;margin-top:8px;" ' +
      'onclick="limparFaturaEscolhida()">Escolher outra despesa</button>';
}

function limparFaturaEscolhida() {
  faturaEscolhida = null;
  document.getElementById("dr-despesa-encontrada").style.display = "none";
  document.getElementById("dr-despesa-encontrada").innerHTML = "";
  sugerirDespesasParaVincular();
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

// Liga ou desliga os dois caminhos de uma vez. Eles dependem da mesma coisa --
// haver arquivo escolhido -- então tratar um sem o outro só cria o estado em
// que metade da tela responde.
function habilitarCaminhosDoDocumento(ligado) {
  ["doc-btn-analisar", "doc-btn-auto"].forEach(function (id) {
    const b = document.getElementById(id);
    if (b) b.disabled = !ligado;
  });
}

// ============================================================================
// LANÇAR AUTOMÁTICO
// ----------------------------------------------------------------------------
// Manda o documento e deixa a IA lançar sozinha, sem parar na tela de revisão.
// A compra cai em Aprovações como pré-lançamento (o cartão amarelo), que é onde
// a conferência acontece depois.
//
// É uma chamada só: o servidor analisa e grava na mesma ida. Analisar e depois
// gravar faria a foto subir duas vezes.
// ============================================================================
async function lancarAutomaticoDoDocumento() {
  if (!arquivoAtual) return;

  habilitarCaminhosDoDocumento(false);
  document.getElementById("doc-etapa-arquivo").style.display = "none";
  document.getElementById("doc-etapa-lendo").style.display = "block";

  try {
    const r = await chamarServidorPost("lancarAutomatico", {
      arquivo: arquivoAtual.base64,
      mimeType: arquivoAtual.mimeType,
      observacao: document.getElementById("doc-observacao").value.trim()
    });

    if (!r.ok) {
      // Falhou o automático, mas a foto continua em mãos: volta para a escolha
      // em vez de obrigar a fotografar tudo de novo.
      document.getElementById("doc-etapa-lendo").style.display = "none";
      document.getElementById("doc-etapa-arquivo").style.display = "block";
      habilitarCaminhosDoDocumento(true);
      mostrarErroDoc((r.mensagem || "Não consegui lançar.") +
                     ' Tente "Analisar e revisar".');
      return;
    }

    fecharModalDoc();
    mostrarToast("✅ " + r.mensagem);

    // Campo que a IA não conseguiu preencher é dito na hora, com nome. Descobrir
    // isso só na hora de aprovar, dias depois, é quando já não se lembra do que
    // era a compra.
    if (r.faltando && r.faltando.length) {
      setTimeout(function () {
        mostrarToast("⚠ Ficou sem " + r.faltando.join(" e ") + ". Complete em Aprovações.");
      }, 2600);
    }

    limparTodoCache();
    checarPendentesAprovacao();

  } catch (e) {
    document.getElementById("doc-etapa-lendo").style.display = "none";
    document.getElementById("doc-etapa-arquivo").style.display = "block";
    habilitarCaminhosDoDocumento(true);
    mostrarErroDoc("Sem conexão. Tente de novo.");
  }
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
      // Fatura escolhida: não há Nº Mov, o que identifica é cartão + vencimento.
      if (faturaEscolhida) {
        dados.faturaCartao = faturaEscolhida.cartao;
        dados.faturaVencimento = faturaEscolhida.vencimentoISO;
        dados._liquidarFatura = true;
      } else {
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
    }
  } else {
    // Modo lançar: valida os campos
    if (!dados.descricao) { mostrarErroDoc("Informe a descrição."); btn.disabled = false; btn.textContent = "✅ Lançar"; return; }
    if (!dados.categoria) { mostrarErroDoc("Escolha a categoria."); btn.disabled = false; btn.textContent = "✅ Lançar"; return; }

    // Você acabou de ver e corrigir o que a IA leu. Passar por Aprovações
    // agora seria pedir a mesma conferência de novo, na mesma tarde.
    dados.destino = "transacoes";

    dados.metodo = document.getElementById("dr-metodo").value;
    dados.totalParcelas = document.getElementById("dr-parcelas").value;
    dados.grupo = (document.getElementById("dr-grupo") || {}).value || "";

    const jaPago = document.getElementById("dr-chk-pago").checked;
    dados.jaPago = jaPago ? "true" : "false";
    if (jaPago) dados.dataPagamento = document.getElementById("dr-datapgto").value;

    if (!dados.metodo) { mostrarErroDoc("Escolha o método."); btn.disabled = false; btn.textContent = "✅ Lançar"; return; }
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

      // Fatura: o documento já subiu e ficou vinculado; agora liquida as
      // compras. Nesta ordem de propósito — se a liquidação falhar, o
      // comprovante continua guardado e dá para tentar de novo.
      if (dados._liquidarFatura) {
        const f = faturaEscolhida;
        faturaEscolhida = null;
        try {
          const lf = await chamarServidor("liquidarFatura", {
            cartao: f.cartao,
            vencimento: f.vencimentoISO,
            dataPagamento: dataHojeISO()
          });
          mostrarToast(lf.ok ? "✅ " + lf.mensagem
                             : "⚠ Documento guardado, mas a fatura não liquidou: " +
                               (lf.mensagem || ""));
        } catch (e) {
          mostrarToast("⚠ Documento guardado, mas a fatura não liquidou (sem conexão).");
        }
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
      const rl = await lerCacheado("listasValidas");
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

      pintarFiltrosRapidos();

      const r = await lerCacheado("buscarLancamentos", params);
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

  // O RESUMO DIZ DE QUE PERÍODO ELE É.
  //
  // Eram três caixas grandes com os totais de TODO o histórico -- saldo de
  // -108 mil como manchete de uma tela de busca, que assusta e não responde
  // nada. O número não mudou; o que mudou é ele dizer o que está somando.
  let html = '<div class="busca-resumo">' +
      '<div class="bs-topo">' +
        '<span>' + total + (total === 1 ? " RESULTADO" : " RESULTADOS") +
          ' · ' + escaparHtml(escopoDaBuscaEmTexto()) + '</span>' +
      '</div>' +
      '<div class="bs-nums">' +
        (somaBusca.despesas > 0
          ? '<span>despesas <b class="vermelho">' +
            formatarMoeda(somaBusca.despesas).replace("R$ ", "") + '</b></span>' : '') +
        (somaBusca.receitas > 0
          ? '<span>receitas <b class="verde">' +
            formatarMoeda(somaBusca.receitas).replace("R$ ", "") + '</b></span>' : '') +
        ((somaBusca.despesas > 0 && somaBusca.receitas > 0)
          ? '<span>saldo <b class="' + (somaBusca.saldo >= 0 ? "verde" : "vermelho") + '">' +
            formatarMoeda(somaBusca.saldo).replace("R$ ", "") + '</b></span>' : '') +
      '</div>' +
    '</div>';

  // Agrupado por mês de vencimento, com subtotal.
  //
  // Numa lista de 957 itens, saber onde um mês acaba é o que torna possível
  // LER: sem isso é uma fita contínua em que nada separa setembro de março.
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  let mesAtual = null;

  resultadosBusca.forEach(function (it, idx) {
    const chave = mesDoVencimento(it.vencimento);
    if (chave && chave.rotulo !== mesAtual) {
      mesAtual = chave.rotulo;
      const soma = somaDoMes(chave.rotulo);
      html += '<div class="bg-mes"><span>' + escaparHtml(chave.rotulo) + '</span>' +
        '<b class="' + (soma >= 0 ? "verde" : "vermelho") + '">' +
          (soma >= 0 ? "+" : "−") + formatarMoeda(Math.abs(soma)).replace("R$ ", "") +
        '</b></div>';
    }

    const cartaoHtml = it.ehCartao
      ? '<span class="ex-cartao">' + escaparHtml(it.cartao) + '</span>' : '';
    const parcHtml = it.parcela
      ? '<span class="ex-parc">' + escaparHtml(it.parcela) + '</span>' : '';
    const codHtml = it.codigoPagamento ? '<span class="br-cod">código</span>' : '';

    // Status em palavra. O emoji sozinho não tem legenda em lugar nenhum da
    // tela, e "vencida" nem existia: era o mesmo ampulheta de uma conta que
    // vence daqui a um mês.
    let statusHtml = "";
    if (it.tipo === "despesa") {
      if (it.pago) statusHtml = '<span class="br-status pago">pago</span>';
      else {
        const v = dataBrParaData(it.vencimento);
        statusHtml = (v && v < hoje)
          ? '<span class="br-status venc">vencida</span>'
          : '<span class="br-status pend">a pagar</span>';
      }
    }

    // Só o DIA: o mês já está no cabeçalho do grupo logo acima.
    const dia = (it.vencimento || "").split("/")[0] || it.vencimento;

    html +=
      '<div class="br-item" onclick="abrirDetalheBusca(' + idx + ')">' +
        '<div class="br-topo">' +
          '<span class="br-desc">' + escaparHtml(it.descricao) + '</span>' +
          '<span class="br-valor ' + (it.tipo === "receita" ? "verde" : "vermelho") + '">' +
            (it.tipo === "receita" ? "+" : "−") + formatarMoeda(it.valor).replace("R$ ", "") +
          '</span>' +
        '</div>' +
        '<div class="br-meio">' +
          '<span class="br-data">' + escaparHtml(dia) + '</span>' +
          cartaoHtml + parcHtml + codHtml +
          '<span class="br-mov">MOV-' + it.numMov + '</span>' +
          statusHtml +
        '</div>' +
      '</div>';
  });

  if (temMaisBusca) {
    html += '<button class="br-mais" onclick="carregarMaisBusca()">Carregar mais</button>';
  }

  wrap.innerHTML = html;
}

/** "28/09/2026" -> Date. Formato diferente devolve nulo, sem chutar. */
function dataBrParaData(txt) {
  const p = (txt || "").toString().split("/");
  if (p.length !== 3) return null;
  const d = new Date(+p[2], +p[1] - 1, +p[0]);
  return isNaN(d.getTime()) ? null : d;
}

/** O mês de um vencimento, como rótulo do grupo. */
function mesDoVencimento(txt) {
  const d = dataBrParaData(txt);
  if (!d) return null;

  const nomes = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
                 "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  return { rotulo: nomes[d.getMonth()] + " " + d.getFullYear() };
}

/**
 * O subtotal de um mês, somado do que está NA TELA.
 *
 * Receita entra positiva e despesa negativa, então o número do cabeçalho é o
 * saldo daquele mês. Com paginação ele cobre só o que já foi carregado -- e é
 * isso mesmo: prometer o total do mês inteiro enquanto faltam páginas seria
 * um número que muda sozinho ao rolar.
 */
function somaDoMes(rotulo) {
  let soma = 0;
  resultadosBusca.forEach(function (it) {
    const m = mesDoVencimento(it.vencimento);
    if (!m || m.rotulo !== rotulo) return;
    soma += (it.tipo === "receita") ? it.valor : -it.valor;
  });
  return arredondarCentavos(soma);
}

/** O que os filtros de hoje cobrem, em português, para o resumo. */
function escopoDaBuscaEmTexto() {
  const mes = (document.getElementById("bl-mes") || {}).value || "";
  const ano = (document.getElementById("bl-ano") || {}).value || "";
  const status = (document.getElementById("bl-status") || {}).value || "";
  const texto = ((document.getElementById("bl-texto") || {}).value || "").trim();

  const nomes = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
                 "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const partes = [];

  if (mes !== "" && ano !== "") partes.push(nomes[parseInt(mes)] + "/" + ano);
  else if (mes !== "") partes.push(nomes[parseInt(mes)]);
  else if (ano !== "") partes.push(ano);

  if (status === "pago") partes.push("pagos");
  else if (status === "pendente") partes.push("a pagar");
  else if (status === "vencida") partes.push("vencidas");

  if (categoriasSelecionadas.length === 1) partes.push(nomeDaCategoria(categoriasSelecionadas[0]));
  else if (categoriasSelecionadas.length > 1) partes.push(categoriasSelecionadas.length + " categorias");

  if (texto) partes.push('"' + texto + '"');

  return partes.length ? partes.join(" · ") : "todo o período";
}

/**
 * Os filtros de um toque.
 *
 * Eles mexem nos MESMOS campos do painel, que continuam sendo a fonte da
 * verdade da busca. Guardar o estado deles à parte daria dois lugares para a
 * mesma pergunta -- e um dia eles discordariam.
 */
function filtroRapido(qual) {
  const mes = document.getElementById("bl-mes");
  const ano = document.getElementById("bl-ano");
  const status = document.getElementById("bl-status");
  if (!mes || !ano || !status) return;

  const hoje = new Date();

  if (qual === "mes" || qual === "anterior") {
    const alvo = new Date(hoje.getFullYear(), hoje.getMonth() - (qual === "anterior" ? 1 : 0), 1);
    const jaEstava = (mes.value === String(alvo.getMonth()) && ano.value === String(alvo.getFullYear()));

    // Tocar de novo desliga. Sem isso, o único jeito de voltar a "todos" seria
    // abrir o painel -- justamente o que estes botões existem para evitar.
    mes.value = jaEstava ? "" : String(alvo.getMonth());
    ano.value = jaEstava ? "" : String(alvo.getFullYear());
  } else {
    status.value = (status.value === qual) ? "" : qual;
  }

  pintarFiltrosRapidos();
  buscarComAtraso();
}

/** Quais botões estão acesos, lido dos campos -- nunca de um estado próprio. */
function pintarFiltrosRapidos() {
  const mes = (document.getElementById("bl-mes") || {}).value || "";
  const ano = (document.getElementById("bl-ano") || {}).value || "";
  const status = (document.getElementById("bl-status") || {}).value || "";
  const hoje = new Date();

  const anterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const ligados = {
    mes: (mes === String(hoje.getMonth()) && ano === String(hoje.getFullYear())),
    anterior: (mes === String(anterior.getMonth()) && ano === String(anterior.getFullYear())),
    pendente: status === "pendente",
    vencida: status === "vencida"
  };

  document.querySelectorAll("#busca-rapidos button[data-rapido]").forEach(function (b) {
    b.classList.toggle("ligado", !!ligados[b.getAttribute("data-rapido")]);
  });

  // A engrenagem acende quando há filtro que os atalhos não mostram.
  const fino = ((document.getElementById("bl-nummov") || {}).value || "") ||
               ((document.getElementById("bl-valor") || {}).value || "") ||
               ((document.getElementById("bl-metodo") || {}).value || "") ||
               (status === "pago") ||
               categoriasSelecionadas.length > 0;

  const eng = document.getElementById("busca-btn-filtros");
  if (eng) eng.classList.toggle("tem-filtro", !!fino);
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

  // O selo do estado vem logo abaixo do valor, em vez de ser uma das cinco
  // linhas rotuladas. Vencida ganha cor própria: ela era "pendente" igual a
  // uma conta que vence daqui a um mês.
  const hj = new Date();
  hj.setHours(0, 0, 0, 0);
  const vencDate = dataBrParaData(it.vencimento);
  const venceu = !it.pago && vencDate && vencDate < hj;

  const selo = it.tipo !== "despesa" ? ""
    : (it.pago
        ? '<div class="det-selo" style="color:var(--verde)">pago' +
          (it.dataPagamento ? " em " + escaparHtml(it.dataPagamento) : "") + '</div>'
        : (venceu
            ? '<div class="det-selo" style="color:var(--vermelho)">venceu em ' +
              escaparHtml(it.vencimento) + '</div>'
            : '<div class="det-selo" style="color:var(--laranja)">a pagar</div>'));

  document.getElementById("det-corpo").innerHTML =
    '<div class="det-valor ' + (it.tipo === "receita" ? "verde" : "vermelho") + '">' +
      formatarMoeda(it.valor) +
    '</div>' +
    '<div class="det-desc">' + escaparHtml(it.descricao) + cartaoHtml + '</div>' +
    selo +

    // Quatro caixas numa grade, no lugar de cinco linhas rotuladas que
    // empurravam as ações para fora da tela.
    '<div class="det-grade">' +
      '<div class="det-caixa"><span>Vencimento</span><b>' + escaparHtml(it.vencimento) + '</b></div>' +
      '<div class="det-caixa"><span>Compra</span><b>' + escaparHtml(it.dataCompra) + '</b></div>' +
      '<div class="det-caixa"><span>Método</span><b>' + escaparHtml(it.metodo || "-") + '</b></div>' +
      '<div class="det-caixa"><span>Categoria</span><b>' +
        escaparHtml(nomeDaCategoria(it.categoria) || "sem categoria") + '</b></div>' +
      (it.parcela
        ? '<div class="det-caixa"><span>Parcela</span><b>' + escaparHtml(it.parcela) + '</b></div>'
        : '') +
    '</div>' +

    (it.codigoPagamento
      ? '<div class="det-codigo">' +
          '<div class="dc-titulo">Código de pagamento</div>' +
          '<div class="dc-valor">' + escaparHtml(it.codigoPagamento) + '</div>' +
          '<button class="dc-copiar" data-codigo="' + escaparHtml(it.codigoPagamento) + '" ' +
                  'onclick="copiarCodigo(this)">Copiar código</button>' +
        '</div>'
      : '') +

    (!it.pago && it.tipo === "despesa"
      ? '<button class="det-btn liquidar" onclick="fecharDetalhe(); abrirLiquidacao(' + it.numMov + ');">' +
          'Liquidar esta despesa' +
        '</button>' +
        // Pagar parte fica ABAIXO de liquidar e com menos peso: o caso comum é
        // pagar tudo, e o parcial é a exceção. Invertido, a exceção viraria a
        // primeira coisa que se lê.
        '<button class="det-btn" onclick="abrirPagamentoParcial(' + it.numMov + ', ' +
          (it.valor || 0) + ');">Pagar só uma parte</button>'
      : '') +

    // As quatro ações em 2x2. Eram quatro botões de largura inteira,
    // empilhados: 200px de altura para quatro palavras.
    '<div class="det-acoes-grade">' +
      '<button class="det-btn editar" onclick="fecharDetalhe(); abrirEdicao(' + it.numMov + ');">Editar</button>' +
      '<button class="det-btn editar" onclick="fecharDetalhe(); duplicarLancamento(' + it.numMov + ');">Duplicar</button>' +
      '<button class="det-btn doc" onclick="buscarDocsDoMov(' + it.numMov + ', true)">Documentos</button>' +
      '<button class="det-btn email" onclick="buscarDocsDoMov(' + it.numMov + ', false)">E-mails</button>' +
    '</div>' +

    '<div class="det-grupo">' +
      '<div class="det-grupo-rot">Grupo de saldo</div>' +
      '<div class="det-grupo-chips" id="det-grupo-chips">' + chipsDeGrupo(it.grupo) + '</div>' +
    '</div>' +

    '<div class="det-rodape">' +
      '<span>' + (it.parcela
        ? "Compra parcelada: a exclusão pergunta se é só esta parcela ou todas."
        : "A exclusão não tem desfazer.") + '</span>' +
      '<button class="det-excluir" onclick="excluirPelaFicha()">Excluir</button>' +
    '</div>' +

    '<div id="det-documentos"></div>';
}

/**
 * Excluir a partir da ficha de detalhe.
 *
 * A exclusão sempre morou na tela de edição, porque é lá que se escolhe o
 * ESCOPO de uma compra parcelada -- só esta parcela ou todas. Uma compra
 * parcelada é mandada para lá em vez de adivinhar o escopo: apagar dez
 * parcelas quando a pessoa queria uma não tem desfazer.
 *
 * Sem parcelas não há escopo para escolher, e aí a ficha resolve sozinha.
 */
function excluirPelaFicha() {
  if (!itemDetalhe) return;

  if (itemDetalhe.parcela) {
    const numMov = itemDetalhe.numMov;
    fecharDetalhe();
    abrirEdicao(numMov);
    mostrarToast("Escolha o alcance e toque em Excluir.");
    return;
  }

  edicaoAtual = itemDetalhe;
  escopoEdicao = "adiante";
  excluirLancamentoApp();
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

  const selecionadas = (destinoMultiCat === "relatorio") ? catsRelatorio
                     : (destinoMultiCat === "grupo") ? catsGrupo : categoriasSelecionadas;

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
  const lista = (destinoMultiCat === "relatorio") ? catsRelatorio
               : (destinoMultiCat === "grupo") ? catsGrupo : categoriasSelecionadas;
  const idx = lista.indexOf(cat);
  if (idx === -1) lista.push(cat);
  else lista.splice(idx, 1);

  renderizarMultiCategorias(document.getElementById("mc-busca").value);
}

function atualizarContadorMultiCat() {
  const lista = (destinoMultiCat === "relatorio") ? catsRelatorio
               : (destinoMultiCat === "grupo") ? catsGrupo : categoriasSelecionadas;
  const el = document.getElementById("mc-contador");
  if (!el) return;
  el.textContent = lista.length === 0 ? "Nenhuma selecionada (= todas)"
    : lista.length + (lista.length === 1 ? " categoria" : " categorias");
}

function limparMultiCategorias() {
  if (destinoMultiCat === "relatorio") catsRelatorio = [];
  else if (destinoMultiCat === "grupo") catsGrupo = [];
  else categoriasSelecionadas = [];
  renderizarMultiCategorias(document.getElementById("mc-busca").value);
}

function confirmarMultiCategorias() {
  fecharMultiCategorias();

  if (destinoMultiCat === "relatorio") {
    atualizarBotaoCategoriasRelatorio();
  } else if (destinoMultiCat === "grupo") {
    pintarCategoriasDoGrupo();
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

// O tema antes da primeira pintura: aplicar depois faria a tela piscar.
try { aplicarTema(temaGuardado()); } catch (e) {}
