// ============================================================================
// AÇÕES DE LIQUIDAÇÃO
// Adicionar ao AppAPI.gs
// ============================================================================

// ============================================================================
// AÇÃO: buscarLancamento
// Dado um Nº Mov, devolve todos os dados daquela linha (para preencher o modal).
// ============================================================================
function buscarLancamento(numMov) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Transações');
  if (!sheet) return { ok: false, erro: "SEM_ABA", mensagem: "Aba 'Transações' não encontrada." };

  const alvo = parseInt(numMov);
  if (isNaN(alvo)) return { ok: false, erro: "SEM_NUM_MOV", mensagem: "Nº de movimentação inválido." };

  const dados = sheet.getDataRange().getValues();

  for (let i = 1; i < dados.length; i++) {
    const numLinha = parseInt(dados[i][10]); // Coluna K = Nº Mov
    if (numLinha === alvo) {
      const venc = parseDataPlanilha(dados[i][4]);
      const dataCompra = parseDataPlanilha(dados[i][3]);
      const dataPgto = dados[i][9];

      return {
        ok: true,
        lancamento: {
          numMov: alvo,
          linha: i + 1,
          descricao: (dados[i][0] || "").toString(),
          valorTotal: extrairValorNumerico(dados[i][1]),
          valorParcela: extrairValorNumerico(dados[i][2]),
          dataCompra: dataCompra ? Utilities.formatDate(dataCompra, "GMT-3", "yyyy-MM-dd") : "",
          vencimento: venc ? Utilities.formatDate(venc, "GMT-3", "yyyy-MM-dd") : "",
          metodo: (dados[i][5] || "").toString(),
          numParcela: dados[i][6] || "",
          totalParcelas: dados[i][7] || "",
          categoria: (dados[i][8] || "").toString(),
          dataPagamento: dataPgto ? dataPgto.toString() : "",
          jaPago: (dataPgto && dataPgto.toString().trim() !== "")
        }
      };
    }
  }

  return { ok: false, erro: "NAO_ENCONTRADO", mensagem: "Lançamento Nº " + alvo + " não encontrado." };
}

// ============================================================================
// AÇÃO: listasValidas
// Devolve as listas de categorias e métodos da aba 'Dados fcnmt',
// para montar os menus suspensos do modal de edição.
// ============================================================================
function obterListasValidas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const aba = ss.getSheetByName('Dados fcnmt');
  if (!aba) return { ok: false, erro: "SEM_ABA", mensagem: "Aba 'Dados fcnmt' não encontrada." };

  const ultLinha = aba.getLastRow();
  if (ultLinha < 2) return { ok: true, categorias: [], metodos: [] };

  const categorias = aba.getRange(2, 1, ultLinha - 1, 1).getValues()
    .map(function (r) { return (r[0] || "").toString().trim(); })
    .filter(function (v) { return v !== ""; });

  const metodos = aba.getRange(2, 2, ultLinha - 1, 1).getValues()
    .map(function (r) { return (r[0] || "").toString().trim(); })
    .filter(function (v) { return v !== ""; });

  return { ok: true, categorias: categorias, metodos: metodos };
}

// ============================================================================
// AÇÃO: liquidar
// Grava a data de pagamento (e as edições, se houver) na linha do lançamento.
// Envia comprovante por e-mail para todos, destacando QUEM liquidou.
//
// Parâmetros esperados (todos vêm como texto):
//   numMov          - obrigatório
//   dataPagamento   - obrigatório, formato yyyy-MM-dd
//   descricao, valorParcela, vencimento, metodo, categoria - opcionais (edições)
// ============================================================================
function liquidarLancamento(params, emailUsuario) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, erro: "OCUPADO", mensagem: "Outra operação em andamento. Tente novamente." };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Transações');
    if (!sheet) return { ok: false, erro: "SEM_ABA", mensagem: "Aba 'Transações' não encontrada." };

    const alvo = parseInt(params.numMov);
    if (isNaN(alvo)) return { ok: false, erro: "SEM_NUM_MOV", mensagem: "Nº de movimentação inválido." };

    if (!params.dataPagamento) {
      return { ok: false, erro: "SEM_DATA", mensagem: "Data de pagamento é obrigatória." };
    }

    // Localiza a linha pelo Nº Mov
    const dados = sheet.getDataRange().getValues();
    let linhaAlvo = -1;
    for (let i = 1; i < dados.length; i++) {
      if (parseInt(dados[i][10]) === alvo) { linhaAlvo = i + 1; break; }
    }
    if (linhaAlvo === -1) {
      return { ok: false, erro: "NAO_ENCONTRADO", mensagem: "Lançamento Nº " + alvo + " não encontrado." };
    }

    // Segurança: não liquidar algo que já está pago
    const jaPagoAtual = (sheet.getRange(linhaAlvo, 10).getValue() || "").toString().trim();
    if (jaPagoAtual !== "") {
      return { ok: false, erro: "JA_PAGO", mensagem: "Este lançamento já consta como pago em " + jaPagoAtual + "." };
    }

    // Backup antes de alterar
    try { fazerBackupTransacoes(); } catch (e) { console.warn("Backup falhou: " + e.message); }

    // Guarda os valores ANTES (para o comprovante mostrar o que mudou)
    const antes = {
      descricao: (dados[linhaAlvo - 1][0] || "").toString(),
      valorParcela: extrairValorNumerico(dados[linhaAlvo - 1][2]),
      vencimento: dados[linhaAlvo - 1][4],
      metodo: (dados[linhaAlvo - 1][5] || "").toString(),
      categoria: (dados[linhaAlvo - 1][8] || "").toString()
    };

    let alteracoes = [];

    // ---- Aplica edições, se vieram ----
    if (params.descricao && params.descricao !== antes.descricao) {
      sheet.getRange(linhaAlvo, 1).setValue(params.descricao);
      alteracoes.push({ campo: "Descrição", de: antes.descricao, para: params.descricao });
    }

    if (params.valorParcela) {
      const novoValor = extrairValorNumerico(params.valorParcela);
      if (novoValor > 0 && Math.abs(novoValor - antes.valorParcela) > 0.001) {
        sheet.getRange(linhaAlvo, 3).setValue(novoValor);
        alteracoes.push({ campo: "Valor", de: formatarMoeda(antes.valorParcela), para: formatarMoeda(novoValor) });
      }
    }

    if (params.vencimento) {
      const partes = params.vencimento.split("-"); // yyyy-MM-dd
      if (partes.length === 3) {
        const novoVenc = new Date(parseInt(partes[0]), parseInt(partes[1]) - 1, parseInt(partes[2]));
        const vencAntigo = parseDataPlanilha(antes.vencimento);
        if (!vencAntigo || novoVenc.getTime() !== vencAntigo.getTime()) {
          sheet.getRange(linhaAlvo, 5).setValue(novoVenc);
          alteracoes.push({
            campo: "Vencimento",
            de: vencAntigo ? Utilities.formatDate(vencAntigo, "GMT-3", "dd/MM/yyyy") : "-",
            para: Utilities.formatDate(novoVenc, "GMT-3", "dd/MM/yyyy")
          });
        }
      }
    }

    if (params.metodo && params.metodo !== antes.metodo) {
      sheet.getRange(linhaAlvo, 6).setValue(params.metodo);
      alteracoes.push({ campo: "Método", de: antes.metodo, para: params.metodo });
    }

    if (params.categoria && params.categoria !== antes.categoria) {
      sheet.getRange(linhaAlvo, 9).setValue(params.categoria);
      alteracoes.push({ campo: "Categoria", de: antes.categoria, para: params.categoria });
      // Reaplica a cor da linha conforme a nova categoria
      try {
        aplicarCoresNaLinha(sheet.getRange(linhaAlvo, 1, 1, 11), params.categoria, params.descricao || antes.descricao);
      } catch (e) { console.warn("Cor não aplicada: " + e.message); }
    }

    // ---- Grava a DATA DE PAGAMENTO (coluna J = 10) ----
    const pp = params.dataPagamento.split("-");
    const dataPgtoObj = new Date(parseInt(pp[0]), parseInt(pp[1]) - 1, parseInt(pp[2]));
    sheet.getRange(linhaAlvo, 10).setValue(dataPgtoObj);

    SpreadsheetApp.flush();

    // ---- Relê os dados finais para o comprovante ----
    const finais = sheet.getRange(linhaAlvo, 1, 1, 11).getValues()[0];
    const dadosFinais = {
      numMov: alvo,
      descricao: (finais[0] || "").toString(),
      valorParcela: extrairValorNumerico(finais[2]),
      vencimento: parseDataPlanilha(finais[4]),
      metodo: (finais[5] || "").toString(),
      numParcela: finais[6] || "",
      totalParcelas: finais[7] || "",
      categoria: (finais[8] || "").toString(),
      dataPagamento: dataPgtoObj
    };

    // ---- Envia o comprovante por e-mail ----
    try {
      enviarComprovanteLiquidacao(dadosFinais, alteracoes, emailUsuario);
    } catch (e) {
      registrarErro("enviarComprovanteLiquidacao", e);
    }

    return {
      ok: true,
      mensagem: "Lançamento Nº " + alvo + " liquidado com sucesso!",
      numMov: alvo,
      alteracoes: alteracoes.length
    };

  } catch (err) {
    registrarErro("liquidarLancamento", err);
    return { ok: false, erro: "ERRO_INTERNO", mensagem: err.message };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// COMPROVANTE DE LIQUIDAÇÃO POR E-MAIL
// Enviado para todos os e-mails autorizados, destacando QUEM fez a liquidação.
// ============================================================================
function enviarComprovanteLiquidacao(d, alteracoes, emailUsuario) {
  const dataPgtoStr = Utilities.formatDate(d.dataPagamento, "GMT-3", "dd/MM/yyyy");
  const vencStr = d.vencimento ? Utilities.formatDate(d.vencimento, "GMT-3", "dd/MM/yyyy") : "-";
  const agora = Utilities.formatDate(new Date(), "GMT-3", "dd/MM/yyyy 'às' HH:mm");
  const infoParcela = (d.totalParcelas && parseInt(d.totalParcelas) > 1)
    ? d.numParcela + "/" + d.totalParcelas : "À vista";

  // Bloco de alterações (só aparece se houve edição)
  let blocoAlteracoes = "";
  if (alteracoes && alteracoes.length > 0) {
    let linhas = "";
    alteracoes.forEach(function (a) {
      linhas +=
        '<tr>' +
          '<td style="padding:8px; border-bottom:1px solid #f1f3f4; font-weight:bold; color:#334155; font-size:12px;">' + a.campo + '</td>' +
          '<td style="padding:8px; border-bottom:1px solid #f1f3f4; color:#94a3b8; font-size:12px; text-decoration:line-through;">' + a.de + '</td>' +
          '<td style="padding:8px; border-bottom:1px solid #f1f3f4; color:#2e9e6b; font-size:12px; font-weight:bold;">' + a.para + '</td>' +
        '</tr>';
    });
    blocoAlteracoes =
      '<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:14px; margin-top:18px;">' +
        '<p style="margin:0 0 10px; font-size:12px; font-weight:bold; color:#92400e; text-transform:uppercase;">✏️ Alterações realizadas na liquidação</p>' +
        '<table style="width:100%; border-collapse:collapse;">' +
          '<tr style="background:#fef3c7;">' +
            '<th style="padding:6px 8px; text-align:left; font-size:11px; color:#92400e;">CAMPO</th>' +
            '<th style="padding:6px 8px; text-align:left; font-size:11px; color:#92400e;">ANTES</th>' +
            '<th style="padding:6px 8px; text-align:left; font-size:11px; color:#92400e;">DEPOIS</th>' +
          '</tr>' + linhas +
        '</table>' +
      '</div>';
  }

  const html =
  '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">' +

    '<div style="background: linear-gradient(135deg, #1a3a5c 0%, #2c5f8a 100%); color: #fff; padding: 24px; text-align: center;">' +
      '<p style="margin:0; font-size:11px; letter-spacing:2px; color:#7fd4a8; font-weight:bold; text-transform:uppercase;">Comprovante de Liquidação</p>' +
      '<h1 style="margin:8px 0 0; font-size:22px; font-weight:600;">Despesa Liquidada</h1>' +
      '<div style="display:inline-block; background:rgba(255,255,255,0.15); border-radius:20px; padding:5px 16px; margin-top:10px; font-size:13px; font-weight:bold;">' +
        'MOV-' + d.numMov +
      '</div>' +
    '</div>' +

    '<div style="padding:24px; background:#fcfcfd;">' +

      // Quem liquidou (destaque)
      '<div style="background:#eef8f3; border-left:4px solid #2e9e6b; border-radius:6px; padding:14px; margin-bottom:20px;">' +
        '<p style="margin:0; font-size:11px; color:#64748b; text-transform:uppercase; font-weight:bold;">Liquidado por</p>' +
        '<p style="margin:4px 0 0; font-size:16px; color:#2e9e6b; font-weight:bold;">' + emailUsuario + '</p>' +
        '<p style="margin:4px 0 0; font-size:12px; color:#94a3b8;">via app Smartbalanço &middot; ' + agora + '</p>' +
      '</div>' +

      // Valor em destaque
      '<div style="text-align:center; background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:18px; margin-bottom:18px;">' +
        '<p style="margin:0; font-size:11px; color:#94a3b8; text-transform:uppercase; font-weight:bold;">Valor Liquidado</p>' +
        '<p style="margin:6px 0 0; font-size:30px; color:#1a3a5c; font-weight:800;">' + formatarMoeda(d.valorParcela) + '</p>' +
        '<p style="margin:8px 0 0; font-size:13px; color:#2e9e6b; font-weight:bold;">✅ Pago em ' + dataPgtoStr + '</p>' +
      '</div>' +

      // Detalhes
      '<table style="width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e8f0; border-radius:8px;">' +
        '<tr><td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:12px; color:#94a3b8; width:40%;">DESCRIÇÃO</td>' +
        '<td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:13px; color:#1e293b; font-weight:bold;">' + d.descricao + '</td></tr>' +

        '<tr><td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:12px; color:#94a3b8;">VENCIMENTO</td>' +
        '<td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:13px; color:#1e293b;">' + vencStr + '</td></tr>' +

        '<tr><td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:12px; color:#94a3b8;">MÉTODO</td>' +
        '<td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:13px; color:#1e293b;">' + d.metodo + '</td></tr>' +

        '<tr><td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:12px; color:#94a3b8;">PARCELA</td>' +
        '<td style="padding:11px 14px; border-bottom:1px solid #f1f3f4; font-size:13px; color:#1e293b;">' + infoParcela + '</td></tr>' +

        '<tr><td style="padding:11px 14px; font-size:12px; color:#94a3b8;">CATEGORIA</td>' +
        '<td style="padding:11px 14px; font-size:13px; color:#1e293b;">' + d.categoria + '</td></tr>' +
      '</table>' +

      blocoAlteracoes +

    '</div>' +

    '<div style="background:#1a3a5c; color:#8fa9c0; text-align:center; padding:14px; font-size:11px;">' +
      'Comprovante gerado automaticamente pelo <b style="color:#fff;">Smartbalanço 2.0</b>' +
    '</div>' +
  '</div>';

  MailApp.sendEmail({
    to: APP_EMAILS_AUTORIZADOS.join(", "),
    subject: "✅ Liquidação MOV-" + d.numMov + " - " + d.descricao + " - " + formatarMoeda(d.valorParcela),
    htmlBody: html
  });
}
