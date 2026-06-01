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
  // Alpaca suporta bracket orders nativamente
  const body = {
    symbol,
    qty:        qty.toFixed(8),
    side,       // "buy" | "sell"
    type:       "market",
    time_in_force: "day",
  };

  // Adicionar bracket se tiver SL/TP
  if (takeProfit || stopLoss) {
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
  cancelOrder,
  isMarketOpen,
  isLive,
  isConnected,
  getAlpacaSymbol,
  SYMBOL_MAP,
};
