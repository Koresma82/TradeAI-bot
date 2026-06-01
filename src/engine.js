// src/engine.js
// Motor principal: lê estratégias do Firestore e executa ordens no IBKR

const { v4: uuid }               = require("crypto").randomUUID ? { v4: () => require("crypto").randomUUID() } : require("crypto");
const logger                     = require("./logger");
const ibkr                       = require("./ibkr");
const fb                         = require("./firebase");
const stats                      = require("./stats");
const { notify, tg }             = require("./telegram");

const MODE            = process.env.MODE || "demo";
const MAX_PER_POS     = parseFloat(process.env.MAX_POSITION_EUR     || "500");
const MAX_TOTAL       = parseFloat(process.env.MAX_TOTAL_INVESTED_EUR || "3000");

// Estado em memória
let strategies    = [];
let openPositions = {};  // { positionId: { ...position, ibkrOrderId } }
let priceHistory  = {};  // { assetId: [{ price, ts }] } — últimos 5 min
let totalInvested = 0;
let dailyLimitHit = false;

// IDs de subscrição de preços IBKR (1 por ativo)
const REQ_ID_MAP = {
  btc: 1, eth: 2, wti: 3, gold: 4, silver: 5, spy: 6, qqq: 7, eurusd: 8,
};

// ── Inicializar subscrições de preço ─────────────────────────────────────────
function initPriceFeeds() {
  Object.entries(REQ_ID_MAP).forEach(([assetId, reqId]) => {
    ibkr.subscribePrice(assetId, reqId);
  });
  logger.info("Price feeds iniciados para todos os ativos ✓");
}

// ── Registar preço no histórico (janela 5 min) ────────────────────────────────
function recordPrice(assetId, price) {
  if (!priceHistory[assetId]) priceHistory[assetId] = [];
  const now = Date.now();
  priceHistory[assetId].push({ price, ts: now });
  // Manter só últimos 5 minutos
  priceHistory[assetId] = priceHistory[assetId].filter(p => now - p.ts < 5 * 60 * 1000);
}

// ── Obter máximo recente (janela configurável) ────────────────────────────────
function getRecentHigh(assetId, windowMs = 2 * 60 * 1000) {
  const now   = Date.now();
  const slice = (priceHistory[assetId] || []).filter(p => now - p.ts <= windowMs);
  if (!slice.length) return null;
  return Math.max(...slice.map(p => p.price));
}

// ── Verificar condições da estratégia ────────────────────────────────────────
function checkSignal(strategy, assetId, currentPrice) {
  const high = getRecentHigh(assetId);
  if (!high || high <= 0) return false;

  const dropPct = ((high - currentPrice) / high) * 100;
  return dropPct >= strategy.compra;
}

// ── Executar compra ───────────────────────────────────────────────────────────
async function executeBuy(strategy, assetId, currentPrice) {
  const amount = Math.min(strategy.perTrade, MAX_PER_POS);

  // Verificações de segurança
  if (totalInvested + amount > MAX_TOTAL) {
    logger.warn(`Limite total investido atingido (€${totalInvested} + €${amount} > €${MAX_TOTAL})`);
    return;
  }
  if (dailyLimitHit) {
    logger.warn("Limite diário de perda atingido — trade bloqueado");
    return;
  }

  const units    = +(amount / currentPrice).toFixed(7);
  const slPrice  = +(currentPrice * (1 - strategy.sl  / 100)).toFixed(4);
  const tpPrice  = +(currentPrice * (1 + strategy.tp  / 100)).toFixed(4);
  const assetDef = ibkr.SYMBOL_MAP[assetId];
  const posId    = `pos_${Date.now()}_${assetId}`;

  logger.info(`→ BUY ${assetId} | €${amount} | ${units} units | SL $${slPrice} | TP $${tpPrice}`);

  try {
    let fillPrice = currentPrice;

    if (MODE === "real") {
      // Ordem real com bracket (SL e TP automáticos no IBKR)
      const result = await ibkr.placeBracketOrder(assetId, units, currentPrice, slPrice, tpPrice);
      fillPrice = result.avgFillPrice || currentPrice;
    } else {
      // Demo: simula execução imediata
      logger.info(`[DEMO] Ordem simulada — sem execução real no IBKR`);
    }

    const position = {
      id:          posId,
      assetId,
      assetName:   assetDef?.symbol || assetId,
      assetSym:    assetDef?.symbol || assetId,
      entryPrice:  fillPrice,
      units,
      amount,
      sl:          slPrice,
      tp:          tpPrice,
      strategy:    strategy.nome,
      stratId:     strategy.id,
      openedAt:    new Date().toLocaleTimeString("pt-PT"),
      status:      "ABERTA",
      mode:        MODE,
    };

    openPositions[posId] = position;
    totalInvested += amount;

    // Guarda no Firestore
    await fb.saveTrade(position);
    await notify(tg.tradeOpen(position, MODE));

    logger.info(`✓ Posição aberta: ${posId}`);
  } catch (err) {
    logger.error(`Erro ao executar BUY ${assetId}: ${err.message}`);
    await fb.logError("executeBuy", err);
    await notify(tg.error(`BUY ${assetId} falhou: ${err.message}`));
  }
}

// ── Verificar SL/TP em posições abertas ──────────────────────────────────────
async function checkPositions(prices) {
  for (const [posId, pos] of Object.entries(openPositions)) {
    const price = prices[pos.assetId];
    if (!price) continue;

    let shouldClose = false;
    let reason      = "";

    if (price <= pos.sl) { shouldClose = true; reason = "SL"; }
    if (price >= pos.tp) { shouldClose = true; reason = "TP"; }

    if (!shouldClose) continue;

    const pnl        = (price - pos.entryPrice) * pos.units;
    const closePrice = price;

    logger.info(`${reason === "TP" ? "✅" : "🛑"} ${reason} ${pos.assetId} | P&L €${pnl.toFixed(2)}`);

    try {
      if (MODE === "real") {
        await ibkr.closePosition(pos.assetId, pos.units);
      } else {
        logger.info(`[DEMO] Fechar posição simulada`);
      }

      const closedTrade = {
        ...pos,
        status:     reason,
        closePrice,
        closedAt:   new Date().toLocaleTimeString("pt-PT"),
        pnl,
      };

      // Remove das posições abertas e actualiza Firestore
      delete openPositions[posId];
      totalInvested = Math.max(0, totalInvested - pos.amount);

      await fb.updateTrade(posId, { status: reason, closePrice, pnl, closedAt: closedTrade.closedAt });
      await notify(tg.tradeClose(closedTrade, pnl, reason));

      stats.addClosedTrade(closedTrade);
      dailyLimitHit = stats.checkDailyLossLimit();

    } catch (err) {
      logger.error(`Erro ao fechar posição ${posId}: ${err.message}`);
      await fb.logError("checkPositions", err);
    }
  }
}

// ── Loop principal (corre a cada 5s) ─────────────────────────────────────────
async function tick() {
  try {
    if (!ibkr.isConnected()) return;

    // Recolhe preços actuais
    const prices = {};
    for (const assetId of Object.keys(REQ_ID_MAP)) {
      const p = ibkr.getPrice(assetId);
      if (p) {
        prices[assetId] = p;
        recordPrice(assetId, p);
      }
    }

    // 1. Verificar SL/TP em posições abertas
    await checkPositions(prices);

    // 2. Verificar sinais das estratégias
    if (!dailyLimitHit) {
      for (const strategy of strategies) {
        if (!strategy.ativo) continue;

        for (const assetId of (strategy.ativos || [])) {
          const price = prices[assetId];
          if (!price) continue;

          // Verificar se já temos posição aberta neste ativo por esta estratégia
          const alreadyOpen = Object.values(openPositions).some(
            p => p.assetId === assetId && p.stratId === strategy.id
          );
          if (alreadyOpen) continue;

          if (checkSignal(strategy, assetId, price)) {
            logger.info(`🎯 Sinal: ${strategy.nome} → ${assetId} @ $${price}`);
            await executeBuy(strategy, assetId, price);
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Erro no tick: ${err.message}`);
    await fb.logError("tick", err).catch(() => {});
  }
}

// ── Inicializar motor ─────────────────────────────────────────────────────────
async function init() {
  logger.info(`═══════════════════════════════════`);
  logger.info(`  TradeAI Bot — Modo: ${MODE.toUpperCase()}`);
  logger.info(`═══════════════════════════════════`);

  // Ler saldo inicial
  const savedBalance = await fb.getBalance();
  if (savedBalance) stats.setBalance(savedBalance);

  // Subscrever estratégias do Firestore (live)
  fb.watchStrategies(newStrategies => {
    strategies = newStrategies;
    logger.info(`Estratégias carregadas: ${strategies.map(s => s.nome).join(", ") || "nenhuma"}`);
  });

  // Aguardar estratégias iniciais
  await new Promise(r => setTimeout(r, 2000));

  // Iniciar price feeds
  initPriceFeeds();

  // Loop principal a cada 5s
  const TICK_INTERVAL = 5000;
  setInterval(tick, TICK_INTERVAL);
  logger.info(`Motor iniciado — tick a cada ${TICK_INTERVAL / 1000}s ✓`);

  // Aguardar preços iniciais antes de começar
  await new Promise(r => setTimeout(r, 3000));
  logger.info("Bot a monitorizar mercados… ✓");
}

module.exports = { init };
