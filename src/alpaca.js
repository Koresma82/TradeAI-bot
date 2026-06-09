// src/alpaca.js
// Alpaca Markets API — REST simples, $0 comissão, perfeito para day trading
// Paper: https://paper-api.alpaca.markets
// Live:  https://api.alpaca.markets

const logger = require("./logger");

const BASE_URL   = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const API_KEY    = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;

let accountCache = null;

// ── Fetch helper ─────────────────────────────────────────────────────────────
async function alpacaFetch(path, options = {}) {
  if (!API_KEY || !SECRET_KEY) throw new Error("ALPACA_API_KEY ou ALPACA_SECRET_KEY não configurados");
  const r = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "APCA-API-KEY-ID":     API_KEY,
      "APCA-API-SECRET-KEY": SECRET_KEY,
      "Content-Type":        "application/json",
      ...options.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Alpaca [${r.status}] ${path}: ${data.message || JSON.stringify(data)}`);
  return data;
}

// ── Conta ────────────────────────────────────────────────────────────────────
async function getAccount() {
  const acc = await alpacaFetch("/v2/account");
  accountCache = acc;
  logger.info(`Alpaca account: $${parseFloat(acc.portfolio_value).toFixed(2)} | BP: $${parseFloat(acc.buying_power).toFixed(2)}`);
  return acc;
}

// ── Preço actual ──────────────────────────────────────────────────────────────
async function getPrice(symbol) {
  // Alpaca Data API — último trade
  const dataUrl = BASE_URL.includes("paper")
    ? "https://data.alpaca.markets"
    : "https://data.alpaca.markets";
  const r = await fetch(`${dataUrl}/v2/stocks/${symbol}/trades/latest`, {
    headers: {
      "APCA-API-KEY-ID":     API_KEY,
      "APCA-API-SECRET-KEY": SECRET_KEY,
    },
  });
  const d = await r.json();
  return d?.trade?.p || null;
}

// ── Posições abertas ──────────────────────────────────────────────────────────
async function getPositions() {
  return alpacaFetch("/v2/positions");
}

// ── Colocar ordem de mercado ──────────────────────────────────────────────────
async function placeOrder({ symbol, qty, side, takeProfit, stopLoss }) {
  // A Alpaca trata cripto e ações de forma diferente:
  //  • Cripto (símbolo com "/", ex.: SOL/USD) → time_in_force DEVE ser "gtc"
  //    e NÃO aceita bracket (SL/TP nativo). Enviar "day" dá erro 422
  //    "invalid crypto time_in_force"; enviar bracket também é rejeitado.
  //  • Ações/ETF (ex.: SPY) → "day" e bracket nativo são suportados.
  const isCrypto = String(symbol).includes("/");

  const body = {
    symbol,
    qty:        qty.toFixed(8),
    side,       // "buy" | "sell"
    type:       "market",
    time_in_force: isCrypto ? "gtc" : "day",
  };

  // Bracket (SL/TP nativo) só em ações/ETF — nunca em cripto.
  if (!isCrypto && (takeProfit || stopLoss)) {
    body.order_class = "bracket";
    if (takeProfit) body.take_profit = { limit_price: takeProfit.toFixed(2) };
    if (stopLoss)   body.stop_loss   = { stop_price:  stopLoss.toFixed(2)   };
  }

  const order = await alpacaFetch("/v2/orders", {
    method: "POST",
    body:   JSON.stringify(body),
  });
  logger.info(`Alpaca ordem: ${side.toUpperCase()} ${qty} ${symbol} | id: ${order.id}`);
  return order;
}

// ── Fechar posição ────────────────────────────────────────────────────────────
async function closePosition(symbol) {
  const order = await alpacaFetch(`/v2/positions/${symbol}`, { method: "DELETE" });
  logger.info(`Alpaca fechar posição: ${symbol}`);
  return order;
}

// ── Fechar uma QUANTIDADE específica de uma posição ──────────────────────────
// Fecha exatamente `qty` unidades (não a posição inteira do símbolo), devolvendo
// a ordem para podermos ler o preço real de execução. Se qty for nula/indefinida
// ou >= à posição, fecha tudo (comportamento antigo). Tenta confirmar o fill.
async function closePositionQty(symbol, qty) {
  let order;
  if (qty == null || !(qty > 0)) {
    order = await alpacaFetch(`/v2/positions/${symbol}`, { method: "DELETE" });
  } else {
    // qty como query param fecha só essa porção da posição
    order = await alpacaFetch(`/v2/positions/${symbol}?qty=${qty}`, { method: "DELETE" });
  }
  logger.info(`Alpaca fechar ${qty != null ? qty : "TUDO"} de ${symbol} | id: ${order?.id || "?"}`);
  // Tentar confirmar o fill (a DELETE devolve a ordem mas pode ainda não ter preço)
  if (order?.id && !order.filled_avg_price) {
    try {
      const confirmed = await getOrder(order.id);
      if (confirmed?.filled_avg_price) return confirmed;
    } catch { /* fica com a ordem inicial */ }
  }
  return order;
}

// ── Consultar uma ordem (para confirmar fill) ────────────────────────────────
async function getOrder(orderId) {
  return alpacaFetch(`/v2/orders/${orderId}`);
}

// ── Cancelar ordem ────────────────────────────────────────────────────────────
async function cancelOrder(orderId) {
  await alpacaFetch(`/v2/orders/${orderId}`, { method: "DELETE" });
  logger.info(`Alpaca cancelar ordem: ${orderId}`);
}

// ── Estado do mercado ─────────────────────────────────────────────────────────
async function isMarketOpen() {
  const clock = await alpacaFetch("/v2/clock");
  return clock.is_open;
}

// ── Isolar se é paper ou live ─────────────────────────────────────────────────
function isLive() { return !BASE_URL.includes("paper"); }
function isConnected() { return !!(API_KEY && SECRET_KEY); }

// ── Mapa de símbolos Alpaca por asset ID ──────────────────────────────────────
// Para commodities sem ticker direto, usa ETFs equivalentes
const SYMBOL_MAP = {
  btc:    "BTCUSD",  eth:    "ETHUSD",
  bnb:    "BNBUSD",  sol:    "SOLUSD",
  xrp:    "XRPUSD",  doge:   "DOGEUSD",
  ada:    "ADAUSD",  avax:   "AVAXUSD",
  dot:    "DOTUSD",  link:   "LINKUSD",
  spy:    "SPY",     qqq:    "QQQ",
  iwm:    "IWM",     gld:    "GLD",   // GLD = ETF do ouro
  tlt:    "TLT",     xle:    "XLE",
  eem:    "EEM",     vti:    "VTI",
  // Commodities via ETFs (Alpaca não tem futuros)
  gold:   "GLD",     silver: "SLV",
  wti:    "USO",     natgas: "UNG",
  copper: "CPER",
};

function getAlpacaSymbol(assetId) {
  return SYMBOL_MAP[assetId] || assetId.toUpperCase();
}

module.exports = {
  getAccount,
  getPrice,
  getPositions,
  placeOrder,
  closePosition,
  closePositionQty,
  getOrder,
  cancelOrder,
  isMarketOpen,
  isLive,
  isConnected,
  getAlpacaSymbol,
  SYMBOL_MAP,
};
