// src/sim-engine.js
// Motor de simulação 24/7 — corre no servidor sem IBKR/Alpaca
// Lê estratégias do Firestore, executa lógica, guarda trades no Firestore
// A app React lê os resultados em tempo real via onSnapshot

const logger  = require("./logger");
const fb      = require("./firebase");
const prices  = require("./prices");
const stats   = require("./stats");
const { notify, tg } = require("./telegram");

const uid = () => require("crypto").randomUUID();

// ── Estado em memória ─────────────────────────────────────────────────────────
let strategies    = [];
let openPositions = {};  // { posId: { ...position } }
let priceHistory  = {};  // { assetId: [{ price, ts }] }
let totalInvested = 0;
let dailyLossHit  = false;
let simBalance    = parseFloat(process.env.SIM_CAPITAL || "1000");
let simCapital    = simBalance;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sign = v => v >= 0 ? "+" : "−";
const eur  = v => `€${Math.abs(v).toFixed(2)}`;

function recordPrice(assetId, price) {
  if (!priceHistory[assetId]) priceHistory[assetId] = [];
  const now = Date.now();
  priceHistory[assetId].push({ price, ts: now });
  priceHistory[assetId] = priceHistory[assetId].filter(p => now - p.ts < 5 * 60 * 1000);
}

function getRecentHigh(assetId) {
  const pts = priceHistory[assetId] || [];
  return pts.length ? Math.max(...pts.map(p => p.price)) : null;
}

// ── Verificar SL/TP ───────────────────────────────────────────────────────────
async function checkSLTP(currentPrices) {
  for (const [posId, pos] of Object.entries(openPositions)) {
    const price = currentPrices[pos.assetId]?.price;
    if (!price) continue;

    let reason = null;
    let closePrice = price;

    if (price <= pos.sl) { reason = "SL"; closePrice = pos.sl; }
    if (price >= pos.tp) { reason = "TP"; closePrice = pos.tp; }
    if (!reason) continue;

    const pnl = (closePrice - pos.entryPrice) * pos.units;
    logger.info(`${reason === "TP" ? "✅" : "🛑"} ${reason} ${pos.assetSym} | P&L ${sign(pnl)}${eur(pnl)}`);

    const closedTrade = {
      ...pos,
      status:    reason,
      closePrice,
      closedAt:  new Date().toLocaleTimeString("pt-PT"),
      pnl,
    };

    // Remove posição + devolve saldo
    delete openPositions[posId];
    totalInvested = Math.max(0, totalInvested - pos.amount);
    simBalance    = +(simBalance + pos.amount + pnl).toFixed(2);

    // Guarda no Firestore
    await fb.updateTrade("server", posId, { status: reason, closePrice, pnl, closedAt: closedTrade.closedAt });
    await fb.saveBalance("server", simBalance);
    stats.addClosedTrade(closedTrade);
    dailyLossHit = stats.checkDailyLossLimit();

    await notify(tg.tradeClose(closedTrade, pnl, reason));
  }
}

// ── Executar compra simulada ──────────────────────────────────────────────────
async function executeBuy(strategy, assetId, price) {
  const amount = Math.min(strategy.perTrade, parseFloat(process.env.MAX_POSITION_EUR || "500"));

  if (simBalance < amount) {
    logger.warn(`Saldo insuficiente: €${simBalance} < €${amount}`);
    return;
  }
  if (totalInvested + amount > parseFloat(process.env.MAX_TOTAL_EUR || simCapital)) {
    logger.warn(`Limite total atingido`);
    return;
  }
  if (dailyLossHit) { logger.warn("Limite perda diária atingido — bloqueado"); return; }

  const units = +(amount / price).toFixed(7);
  const sl    = +(price * (1 - strategy.sl  / 100)).toFixed(4);
  const tp    = +(price * (1 + strategy.tp  / 100)).toFixed(4);
  const posId = `sim_${Date.now()}_${assetId}`;

  const position = {
    id:          posId,
    assetId,
    assetName:   assetId,
    assetSym:    assetId.toUpperCase(),
    entryPrice:  price,
    units,
    amount,
    sl, tp,
    strategy:    strategy.nome,
    stratId:     strategy.id,
    openedAt:    new Date().toLocaleTimeString("pt-PT"),
    status:      "ABERTA",
    mode:        "sim",
  };

  openPositions[posId] = position;
  totalInvested += amount;
  simBalance     = +(simBalance - amount).toFixed(2);

  // Guarda no Firestore — a app React vê em tempo real
  await fb.saveTrade("server", position);
  await fb.saveBalance("server", simBalance);
  await notify(tg.tradeOpen(position, "demo"));

  logger.info(`BUY SIM ${assetId} | €${amount} | @$${price} | SL $${sl} | TP $${tp}`);
}

// ── Tick principal ────────────────────────────────────────────────────────────
async function tick() {
  try {
    // 1. Refresh preços
    await prices.refreshAll();
    const currentPrices = prices.getAll();

    // Registar histórico
    Object.entries(currentPrices).forEach(([id, d]) => {
      if (d?.price) recordPrice(id, d.price);
    });

    // 2. Verificar SL/TP
    await checkSLTP(currentPrices);

    // 3. Verificar sinais das estratégias
    if (!dailyLossHit) {
      for (const strategy of strategies) {
        if (!strategy.ativo) continue;
        for (const assetId of (strategy.ativos || [])) {
          const priceData = currentPrices[assetId];
          if (!priceData?.price) continue;

          // Verificar se já tem posição aberta neste ativo/estratégia
          const alreadyOpen = Object.values(openPositions).some(
            p => p.assetId === assetId && p.stratId === strategy.id
          );
          if (alreadyOpen) continue;

          // Verificar sinal: queda do máximo recente
          const high = getRecentHigh(assetId);
          if (!high) continue;
          const dropPct = ((high - priceData.price) / high) * 100;
          if (dropPct >= strategy.compra) {
            logger.info(`🎯 Sinal: ${strategy.nome} → ${assetId} (queda ${dropPct.toFixed(2)}%)`);
            await executeBuy(strategy, assetId, priceData.price);
          }
        }
      }
    }

    // 4. Atualizar P&L não realizado no Firestore (a cada tick)
    const unrealized = Object.values(openPositions).reduce((s, pos) => {
      const p = currentPrices[pos.assetId]?.price;
      return s + (p ? (p - pos.entryPrice) * pos.units : 0);
    }, 0);
    await fb.saveSetting("server", "simLive", {
      balance:       simBalance,
      unrealized:    +unrealized.toFixed(2),
      totalInvested: +totalInvested.toFixed(2),
      openPositions: Object.keys(openPositions).length,
      lastTick:      new Date().toISOString(),
    });

  } catch (err) {
    logger.error(`SimEngine tick erro: ${err.message}`);
    await fb.logError("sim-engine-tick", err).catch(() => {});
  }
}

// ── Inicializar ───────────────────────────────────────────────────────────────
async function init() {
  logger.info("═══════════════════════════════════");
  logger.info("  TradeAI Sim Engine 24/7");
  logger.info(`  Capital: €${simCapital}`);
  logger.info("═══════════════════════════════════");

  stats.setBalance(simBalance);

  // Carregar saldo guardado
  const savedBal = await fb.getBalance("server");
  if (savedBal && savedBal > 0) {
    simBalance = savedBal;
    simCapital = savedBal; // considera o atual como base se já havia
    stats.setBalance(simBalance);
    logger.info(`Saldo restaurado: €${simBalance}`);
  }

  // Subscrever estratégias em tempo real
  fb.watchStrategies(newStrats => {
    strategies = newStrats;
    logger.info(`Estratégias: ${strategies.map(s => s.nome).join(", ") || "nenhuma"}`);
  });

  // Aguardar carga inicial
  await new Promise(r => setTimeout(r, 2000));

  // Primeiro fetch de preços
  await prices.refreshAll();
  logger.info("Preços inicializados ✓");

  // Loop principal
  const TICK_MS = parseInt(process.env.SIM_TICK_MS || "30000"); // 30s por defeito
  setInterval(tick, TICK_MS);
  logger.info(`Motor iniciado — tick cada ${TICK_MS / 1000}s ✓`);

  // Primeiro tick imediato
  await tick();
}

module.exports = { init };
