// src/broker.js
// Camada de execução: decide entre SIMULAR (modo sim) ou EXECUTAR ORDEM REAL
// na Alpaca (modo paper/real). O resto do motor (AI Brain, estratégias, SL/TP)
// não muda — só chama broker.buy() / broker.sell() e esta camada trata do resto.
//
// MODE = "sim"   → tudo fictício, sem corretora (como até agora)
// MODE = "paper" → ordens REAIS na Alpaca paper (dinheiro fictício, API real)
// MODE = "real"  → ordens REAIS na Alpaca live (DINHEIRO REAL)

const logger = require("./logger");

const MODE = (process.env.MODE || "sim").toLowerCase();
const LIVE = MODE === "paper" || MODE === "real"; // usa Alpaca?

let alpaca = null;
if (LIVE) {
  alpaca = require("./alpaca");
}

// Crypto na Alpaca usa formato "BTC/USD" para ordens (e funciona 24/7).
// Ações/ETFs usam o ticker simples ("SPY"). Distinguimos pelos IDs de crypto.
const CRYPTO_IDS = new Set(["btc", "eth", "bnb", "sol", "xrp", "doge"]);

function isCrypto(assetId) {
  return CRYPTO_IDS.has(assetId);
}

// Símbolo correto para ORDENS na Alpaca
function orderSymbol(assetId) {
  const base = alpaca.getAlpacaSymbol(assetId); // ex.: BTCUSD, SPY, GLD
  if (isCrypto(assetId)) {
    // BTCUSD → BTC/USD (formato exigido para ordens de crypto)
    return base.replace(/USD$/, "/USD");
  }
  return base;
}

// ── Estado / verificações ────────────────────────────────────────────────────
function getMode() { return MODE; }
function isLive()  { return LIVE; }
function isReal()  { return MODE === "real"; }

async function verifyConnection() {
  if (!LIVE) {
    logger.info("Broker: modo SIMULAÇÃO (sem corretora)");
    return { ok: true, mode: "sim" };
  }
  if (!alpaca.isConnected()) {
    throw new Error("Alpaca não configurada — define ALPACA_API_KEY e ALPACA_SECRET_KEY");
  }
  const acc = await alpaca.getAccount();
  const live = alpaca.isLive();
  // Guarda de segurança: se MODE=real mas a URL é paper (ou vice-versa), avisa
  if (MODE === "real" && !live) {
    logger.warn("⚠ MODE=real mas ALPACA_BASE_URL aponta para PAPER. A executar em PAPER.");
  }
  if (MODE === "paper" && live) {
    throw new Error("MODE=paper mas ALPACA_BASE_URL aponta para LIVE — abortado por segurança. Corrige a URL.");
  }
  logger.info(`Broker: Alpaca ${live ? "LIVE 💵" : "PAPER 📝"} | Conta: $${parseFloat(acc.portfolio_value).toFixed(2)} | Poder de compra: $${parseFloat(acc.buying_power).toFixed(2)}`);
  return { ok: true, mode: MODE, account: acc };
}

// Saldo real da conta (para sincronizar com o motor). Em sim devolve null.
async function getBalance() {
  if (!LIVE) return null;
  const acc = await alpaca.getAccount();
  return parseFloat(acc.cash); // dinheiro disponível
}

// ── COMPRA ───────────────────────────────────────────────────────────────────
// Devolve { ok, fillPrice, brokerOrderId } — fillPrice pode ser estimado em sim.
// amount = € a investir; price = preço de referência atual.
async function buy({ assetId, amount, price, sl, tp }) {
  if (!LIVE) {
    // SIMULAÇÃO: execução imediata ao preço de referência
    return { ok: true, fillPrice: price, brokerOrderId: null, simulated: true };
  }

  // ── ORDEM REAL na Alpaca ──
  const symbol = orderSymbol(assetId);

  // Ações: o mercado tem de estar aberto. Crypto: 24/7.
  if (!isCrypto(assetId)) {
    const open = await alpaca.isMarketOpen();
    if (!open) {
      logger.warn(`Mercado fechado para ${symbol} — ordem adiada`);
      return { ok: false, reason: "market_closed" };
    }
  }

  const qty = amount / price; // quantidade (frações permitidas em crypto e ações Alpaca)

  try {
    // Bracket (SL+TP) só é suportado em ações; crypto na Alpaca não aceita bracket,
    // por isso a crypto é gerida pelo nosso próprio SL/TP no motor.
    const orderParams = { symbol, qty, side: "buy" };
    if (!isCrypto(assetId)) {
      orderParams.takeProfit = tp;
      orderParams.stopLoss   = sl;
    }
    const order = await alpaca.placeOrder(orderParams);
    // Preço de execução: Alpaca preenche assíncrono; usamos o preço de referência
    // como estimativa imediata (o reconcile posterior corrige com o fill real).
    const fillPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : price;
    return { ok: true, fillPrice, brokerOrderId: order.id, simulated: false };
  } catch (err) {
    logger.error(`Ordem de compra falhou (${symbol}): ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

// ── VENDA / FECHO ──────────────────────────────────────────────────────────────
async function sell({ assetId, units, price }) {
  if (!LIVE) {
    return { ok: true, fillPrice: price, simulated: true };
  }

  const symbol = orderSymbol(assetId);
  try {
    // Fecha a posição inteira do símbolo na Alpaca
    await alpaca.closePosition(isCrypto(assetId) ? symbol.replace("/", "") : symbol);
    return { ok: true, fillPrice: price, simulated: false };
  } catch (err) {
    logger.error(`Ordem de venda falhou (${symbol}): ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  getMode, isLive, isReal, verifyConnection, getBalance,
  buy, sell, isCrypto, orderSymbol,
};
