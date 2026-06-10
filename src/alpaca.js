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

  // Fix 3: a Alpaca NÃO aceita bracket (SL/TP nativo) em ordens de quantidade
  // FRACIONÁRIA — só com qty inteira. Com teto baixo por trade (ex.: €100) e
  // ações caras (SPY ~$470), a qty é fracionária e o bracket seria rejeitado,
  // OU a ordem abria sem proteção nenhuma enquanto o motor julgava que a
  // corretora a geria. Solução: só pedimos bracket quando a qty é inteira;
  // caso contrário NÃO enviamos bracket e devolvemos bracketApplied=false para
  // o motor saber que tem de gerir o SL/TP ele próprio.
  const isWholeQty = Number.isInteger(qty) && qty >= 1;
  const wantsBracket = !isCrypto && (takeProfit || stopLoss);
  const useBracket   = wantsBracket && isWholeQty;

  const body = {
    symbol,
    qty:        qty.toFixed(8),
    side,       // "buy" | "sell"
    type:       "market",
    time_in_force: isCrypto ? "gtc" : "day",
  };

  if (useBracket) {
    body.order_class = "bracket";
    if (takeProfit) body.take_profit = { limit_price: takeProfit.toFixed(2) };
    if (stopLoss)   body.stop_loss   = { stop_price:  stopLoss.toFixed(2)   };
  } else if (wantsBracket && !isWholeQty) {
    logger.warn(`Alpaca ${symbol}: qty ${qty} é fracionária — bracket nativo não suportado. Ordem simples; SL/TP fica a cargo do motor.`);
  }

  const order = await alpacaFetch("/v2/orders", {
    method: "POST",
    body:   JSON.stringify(body),
  });
  // Anexa (não-persistente) se o bracket foi mesmo aplicado, para o adaptador.
  if (order && typeof order === "object") order._bracketApplied = useBracket;
  logger.info(`Alpaca ordem: ${side.toUpperCase()} ${qty} ${symbol}${useBracket ? " [bracket]" : ""} | id: ${order.id}`);
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

// ── Cancelar TODAS as ordens abertas de um símbolo ───────────────────────────
// Fix 2: antes de fechar manualmente uma posição com bracket nativo, é preciso
// cancelar as ordens-filhas (SL/TP) ainda abertas. Senão, ao fechar a posição,
// a perna que sobra do bracket fica órfã e pode disparar depois → venda a
// descoberto (short acidental). Devolve o nº de ordens canceladas.
async function cancelOpenOrders(symbol) {
  try {
    // Inclui ordens aninhadas (as filhas do bracket vêm dentro de "legs").
    const open = await alpacaFetch(`/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&nested=true`);
    if (!Array.isArray(open) || !open.length) return 0;
    let n = 0;
    for (const o of open) {
      const ids = [o.id, ...((o.legs || []).map(l => l.id))].filter(Boolean);
      for (const id of ids) {
        try { await cancelOrder(id); n++; } catch (e) { logger.warn(`Cancelar ordem ${id} falhou: ${e.message}`); }
      }
    }
    if (n) logger.info(`Alpaca: ${n} ordem(ns) aberta(s) de ${symbol} cancelada(s) antes do fecho`);
    return n;
  } catch (e) {
    logger.warn(`cancelOpenOrders(${symbol}) falhou: ${e.message}`);
    return 0;
  }
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
  cancelOpenOrders,
  isMarketOpen,
  isLive,
  isConnected,
  getAlpacaSymbol,
  SYMBOL_MAP,
};
