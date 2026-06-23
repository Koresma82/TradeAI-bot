// src/dca-engine.js
// ─────────────────────────────────────────────────────────────────────────────
// MOTOR DCA (Dollar-Cost Averaging) — núcleo PASSIVO, com MÚLTIPLOS PLANOS.
//
// Modelo (definido pelo utilizador na app):
//   • dcaValorMensal: o "bolo" que invistes por período (ex.: 100€/mês).
//   • dcaPlanos: lista de planos, cada um com objetivo próprio. Ex.:
//       [{ id, nome:"Férias", carteira:[{id,peso}], alocacao:{tipo:"pct",valor:30},
//          frequencia:"mensal", proximaCompra, dataInicio, reequilibrar }]
//   • Fatia AI Trade: o que defines para o trading ativo fica como reserva de
//     capital (AI Brain + manuais). Não compra nada sozinho — é só o teto.
//
// Repartição FLEXÍVEL: cada plano aloca por PERCENTAGEM do bolo, ou por VALOR
// fixo (€). Podes misturar. Se a soma de % exceder o restante, são reduzidos
// proporcionalmente.
//
// Cada plano tem a SUA carteira, histórico e dataInicio (para medir desempenho).
// Posições marcadas com stratId "dca" e planId — separadas do trading ativo e
// nunca fechadas pela lógica de SL/TP.
//
// Retrocompat: se existir o formato antigo (dcaCarteira/dcaValorPeriodico), é
// convertido para um plano único "Principal" automaticamente.
// ─────────────────────────────────────────────────────────────────────────────

const logger = require("./logger");

const FREQ_MS = {
  semanal:   7  * 24 * 60 * 60 * 1000,
  quinzenal: 15 * 24 * 60 * 60 * 1000,
  mensal:    30 * 24 * 60 * 60 * 1000,
};

let lastRebalanceCheck = 0;
const REBALANCE_CHECK_MS = 6 * 60 * 60 * 1000;

let ctx = null;
function init(context) { ctx = context; }

// ── Normaliza a config para a lista de planos (com retrocompat) ───────────────
function getPlanos() {
  const s = ctx.settings();
  if (Array.isArray(s.dcaPlanos) && s.dcaPlanos.length) return s.dcaPlanos;
  if (Array.isArray(s.dcaCarteira) && s.dcaCarteira.length) {
    return [{
      id: "principal", nome: "Principal",
      carteira: s.dcaCarteira,
      alocacao: { tipo: "valor", valor: Number(s.dcaValorPeriodico) || 50 },
      frequencia: s.dcaFrequencia || "mensal",
      proximaCompra: s.dcaProximaCompra || null,
      dataInicio: s.dcaDataInicio || null,
      reequilibrar: s.dcaReequilibrar !== false,
    }];
  }
  return [];
}

// Quanto € cada plano recebe deste período, dado o bolo mensal.
function repartir(planos, bolo) {
  const fixos = planos.filter(p => p.alocacao && p.alocacao.tipo === "valor");
  const pcts  = planos.filter(p => p.alocacao && p.alocacao.tipo === "pct");
  const totalFixo = fixos.reduce((a, p) => a + (Number(p.alocacao.valor) || 0), 0);
  const restante = Math.max(0, bolo - totalFixo);
  const somaPct = pcts.reduce((a, p) => a + (Number(p.alocacao.valor) || 0), 0);
  const out = {};
  for (const p of fixos) out[p.id] = Math.min(Number(p.alocacao.valor) || 0, bolo);
  for (const p of pcts) {
    const ideal = bolo * (Number(p.alocacao.valor) || 0) / 100;
    out[p.id] = somaPct > 0 ? Math.min(ideal, restante * (Number(p.alocacao.valor) / somaPct)) : 0;
  }
  return out;
}

// ── Compra periódica (por plano) ──────────────────────────────────────────────
async function tickCompras() {
  const s = ctx.settings();
  if (!s.dcaAtivo) return;
  const planos = getPlanos();
  if (!planos.length) return;
  const bolo = Number(s.dcaValorMensal) || 0;
  if (bolo <= 0) return;

  const agora = ctx.now();
  const reparticao = repartir(planos, bolo);

  for (const plano of planos) {
    const carteira = Array.isArray(plano.carteira) ? plano.carteira.filter(c => c.peso > 0) : [];
    if (!carteira.length) continue;

    const intervalo = FREQ_MS[plano.frequencia] || FREQ_MS.mensal;
    const proxima = plano.proximaCompra || 0;
    if (proxima && agora < proxima) continue;

    const valorPlano = +(reparticao[plano.id] || 0).toFixed(2);
    if (valorPlano >= 1) {
      // Planos MANUAIS (ETF/ações em brokers sem API automática): o bot não
      // executa — calcula o que comprar e cria uma "ordem pendente" + notifica.
      // O utilizador compra à mão no seu broker e confirma na app/Telegram.
      if (plano.modoExecucao === "manual") {
        await criarOrdemManual(plano, carteira, valorPlano);
      } else {
        await executarCompraPlano(plano, carteira, valorPlano);
      }
    }
    await ctx.agendarPlano(plano.id, agora + intervalo, plano.dataInicio || agora);
  }
}

// Cria uma ordem de compra manual pendente: lista o que comprar (€ e ativo, com
// preço sugerido atual) e avisa por Telegram. Fica à espera de confirmação.
async function criarOrdemManual(plano, carteira, valorPlano) {
  const somaPesos = carteira.reduce((a, c) => a + c.peso, 0) || 100;
  const itens = carteira.map(item => {
    const eur = +(valorPlano * (item.peso / somaPesos)).toFixed(2);
    const px = ctx.priceOf(item.id);
    return { assetId: item.id, eur, precoSugerido: px };
  }).filter(i => i.eur >= 1);
  if (!itens.length) return;

  const ordem = {
    id: `dca_manual_${plano.id}_${Date.now()}`,
    planId: plano.id, planNome: plano.nome,
    valorTotal: valorPlano, itens,
    broker: plano.brokerId || null,
    criadoEm: Date.now(), estado: "PENDENTE",
  };
  await ctx.criarOrdemManual(ordem);

  // Notificação clara do que fazer, com link direto para confirmar na app.
  const linhas = itens.map(i => `  • €${i.eur} de ${i.assetId.toUpperCase()}${i.precoSugerido ? ` (~$${i.precoSugerido})` : ""}`);
  const appUrl = (process.env.APP_URL || "https://tradeaiko.netlify.app").replace(/\/$/, "");
  const msg = [
    `🔔 DCA "${plano.nome}" — está na hora da compra!`,
    `Compra no teu broker (total €${valorPlano.toFixed(2)}):`,
    ...linhas,
    ``,
    `👉 Confirmar aqui: ${appUrl}/?tab=dca`,
  ].join("\n");
  await ctx.notificar(msg);
  logger.info(`🔔 DCA[${plano.nome}]: ordem manual criada (€${valorPlano}) — utilizador notificado`);

  // Lembrete de depósito: se o saldo manual do broker (XTB) está a ficar baixo
  // (menos de 2x o valor desta compra), avisa para depositar, evitando falhas.
  const s2 = ctx.settings();
  const saldoXtb = Number(s2.xtbSaldo);
  if (Number.isFinite(saldoXtb) && saldoXtb < valorPlano * 2) {
    await ctx.notificar(`⚠️ Saldo XTB baixo (€${saldoXtb.toFixed(2)}). Considera depositar para não falhares as próximas compras DCA.`);
  }
}

async function executarCompraPlano(plano, carteira, valorPlano) {
  const saldo = ctx.dcaBalance();
  if (saldo < valorPlano) {
    logger.warn(`DCA[${plano.nome}]: saldo (€${saldo.toFixed(2)}) < compra (€${valorPlano}). Adiada.`);
    return;
  }
  const somaPesos = carteira.reduce((a, c) => a + c.peso, 0) || 100;
  logger.info(`📈 DCA[${plano.nome}]: compra de €${valorPlano} por ${carteira.length} ativos`);

  for (const item of carteira) {
    const fatia = +(valorPlano * (item.peso / somaPesos)).toFixed(2);
    if (fatia < 1) continue;
    const px = ctx.priceOf(item.id);
    if (px == null) { logger.warn(`DCA[${plano.nome}]: sem preço para ${item.id} — saltado`); continue; }
    try {
      await ctx.buyDCA(item.id, fatia, plano.id, plano.nome);
      logger.info(`  ✓ ${plano.nome}: €${fatia} de ${item.id}`);
    } catch (e) {
      logger.warn(`  ✗ ${plano.nome} ${item.id}: ${e.message}`);
    }
  }
}

// ── Reequilíbrio (por plano) ──────────────────────────────────────────────────
async function tickReequilibrio() {
  const s = ctx.settings();
  if (!s.dcaAtivo) return;
  const agora = ctx.now();
  if (agora - lastRebalanceCheck < REBALANCE_CHECK_MS) return;
  lastRebalanceCheck = agora;

  for (const plano of getPlanos()) {
    if (plano.reequilibrar === false) continue;
    const carteira = Array.isArray(plano.carteira) ? plano.carteira.filter(c => c.peso > 0) : [];
    if (carteira.length < 2) continue;

    const posicoes = ctx.dcaPositions().filter(p => p.planId === plano.id);
    if (!posicoes.length) continue;

    const valorPorAtivo = {};
    let valorTotal = 0;
    let semPreco = false;
    for (const p of posicoes) {
      const px = ctx.priceOf(p.assetId);
      if (px == null) { semPreco = true; break; }
      const v = p.units * px;
      valorPorAtivo[p.assetId] = (valorPorAtivo[p.assetId] || 0) + v;
      valorTotal += v;
    }
    if (semPreco || valorTotal <= 0) continue;

    const somaPesos = carteira.reduce((a, c) => a + c.peso, 0) || 100;
    const derivaMax = Number(s.dcaDerivaPct) || 5;
    const ajustes = [];
    for (const item of carteira) {
      const alvo = (item.peso / somaPesos) * 100;
      const real = ((valorPorAtivo[item.id] || 0) / valorTotal) * 100;
      const deriva = real - alvo;
      if (Math.abs(deriva) >= derivaMax) {
        ajustes.push({ id: item.id, deriva: +deriva.toFixed(1), eur: +((deriva / 100) * valorTotal).toFixed(2) });
      }
    }
    if (!ajustes.length) continue;

    logger.info(`⚖️ DCA[${plano.nome}] reequilíbrio: ${ajustes.length} ativos fora do alvo`);
    for (const a of ajustes.filter(x => x.eur > 0)) {
      try { await ctx.sellDCA(a.id, a.eur, plano.id); logger.info(`  ↓ ${plano.nome}: vendeu €${a.eur} de ${a.id}`); }
      catch (e) { logger.warn(`  ✗ venda ${a.id}: ${e.message}`); }
    }
    for (const a of ajustes.filter(x => x.eur < 0)) {
      const eur = Math.abs(a.eur);
      if (ctx.dcaBalance() < eur) continue;
      try { await ctx.buyDCA(a.id, eur, plano.id, plano.nome); logger.info(`  ↑ ${plano.nome}: comprou €${eur} de ${a.id}`); }
      catch (e) { logger.warn(`  ✗ compra ${a.id}: ${e.message}`); }
    }
  }
}

async function tick() {
  if (!ctx) return;
  try { await tickCompras(); }       catch (e) { logger.warn(`DCA compras: ${e.message}`); }
  try { await tickReequilibrio(); }  catch (e) { logger.warn(`DCA reequilíbrio: ${e.message}`); }
}

module.exports = { init, tick, getPlanos, repartir };
