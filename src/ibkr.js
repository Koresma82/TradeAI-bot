// src/ibkr.js
// Wrapper para o Interactive Brokers TWS API via @stoqey/ib

const { IBApi, EventName, BarSizeSetting, WhatToShow, SecType, OrderAction, OrderType } = require("@stoqey/ib");
const logger = require("./logger");

let ib;
let connected = false;
let nextOrderId = 1;
const priceCache = {};   // { symbol: lastPrice }
const orderCallbacks = {}; // { orderId: { resolve, reject, timeout } }

// ── Símbolos IBKR por asset ID ────────────────────────────────────────────────
// STK = Stock/ETF  |  CMDTY = Commodity/Index CFD  |  CRYPTO = Crypto  |  CASH = Forex
const SYMBOL_MAP = {
  btc:    { symbol: "BTC",    secType: SecType.CRYPTO, currency: "USD", exchange: "PAXOS"      },
  eth:    { symbol: "ETH",    secType: SecType.CRYPTO, currency: "USD", exchange: "PAXOS"      },
  wti:    { symbol: "CL",     secType: SecType.FUT,    currency: "USD", exchange: "NYMEX", lastTradeDateOrContractMonth: "20251219" },
  gold:   { symbol: "GC",     secType: SecType.FUT,    currency: "USD", exchange: "COMEX", lastTradeDateOrContractMonth: "20251230" },
  silver: { symbol: "SI",     secType: SecType.FUT,    currency: "USD", exchange: "COMEX", lastTradeDateOrContractMonth: "20251229" },
  spy:    { symbol: "SPY",    secType: SecType.STK,    currency: "USD", exchange: "SMART"       },
  qqq:    { symbol: "QQQ",    secType: SecType.STK,    currency: "USD", exchange: "SMART"       },
  eurusd: { symbol: "EUR",    secType: SecType.CASH,   currency: "USD", exchange: "IDEALPRO"    },
};

function getContract(assetId) {
  const c = SYMBOL_MAP[assetId];
  if (!c) throw new Error(`Asset desconhecido: ${assetId}`);
  return c;
}

// ── Conectar ao TWS ───────────────────────────────────────────────────────────
function connect(mode = "demo") {
  const port = mode === "real"
    ? parseInt(process.env.IBKR_PORT_REAL || "7496")
    : parseInt(process.env.IBKR_PORT_DEMO || "7497");
  const host     = process.env.IBKR_HOST      || "127.0.0.1";
  const clientId = parseInt(process.env.IBKR_CLIENT_ID || "1");

  return new Promise((resolve, reject) => {
    ib = new IBApi({ host, port, clientId });

    ib.on(EventName.connected, () => {
      connected = true;
      logger.info(`IBKR conectado — modo ${mode.toUpperCase()} (${host}:${port}) ✓`);
      resolve();
    });

    ib.on(EventName.nextValidId, id => {
      nextOrderId = id;
      logger.info(`Next Order ID: ${nextOrderId}`);
    });

    ib.on(EventName.error, (err, code, reqId) => {
      // Códigos informativos (não são erros reais)
      if ([2104, 2106, 2158, 2119].includes(code)) return;
      logger.warn(`IBKR erro [${code}] req#${reqId}: ${err.message || err}`);
      if (!connected) reject(err);
    });

    ib.on(EventName.disconnected, () => {
      connected = false;
      logger.warn("IBKR desconectado — a tentar reconectar em 10s…");
      setTimeout(() => connect(mode).catch(e => logger.error(`Reconexão falhou: ${e.message}`)), 10000);
    });

    // Preços em tempo real via tick
    ib.on(EventName.tickPrice, (reqId, tickType, price) => {
      if (price > 0 && priceCache[`req_${reqId}`]) {
        priceCache[priceCache[`req_${reqId}`]] = price;
      }
    });

    // Confirmação de ordem executada
    ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
      const cb = orderCallbacks[orderId];
      if (!cb) return;
      if (status === "Filled") {
        clearTimeout(cb.timeout);
        cb.resolve({ orderId, avgFillPrice, filled });
        delete orderCallbacks[orderId];
        logger.info(`Ordem ${orderId} executada @ $${avgFillPrice} (${filled} unidades)`);
      }
      if (["Cancelled", "Inactive", "ApiCancelled"].includes(status)) {
        clearTimeout(cb.timeout);
        cb.reject(new Error(`Ordem ${orderId} cancelada (${status})`));
        delete orderCallbacks[orderId];
      }
    });

    ib.connect();
    setTimeout(() => {
      if (!connected) reject(new Error("Timeout a conectar ao IBKR — confirma que o TWS está aberto"));
    }, 20000);
  });
}

// ── Obter preço actual ────────────────────────────────────────────────────────
function getPrice(assetId) {
  return priceCache[assetId] || null;
}

// ── Subscrever preços em tempo real ──────────────────────────────────────────
function subscribePrice(assetId, reqId) {
  const contract = getContract(assetId);
  priceCache[`req_${reqId}`] = assetId;
  ib.reqMktData(reqId, contract, "", false, false);
  logger.info(`Subscrito preço ${assetId} (req#${reqId})`);
}

// ── Executar ordem de compra (market order) ───────────────────────────────────
function placeMarketOrder(assetId, units, action = OrderAction.BUY) {
  return new Promise((resolve, reject) => {
    if (!connected) return reject(new Error("IBKR não conectado"));

    const contract = getContract(assetId);
    const orderId  = nextOrderId++;

    const order = {
      action,
      orderType: OrderType.MKT,
      totalQuantity: units,
      transmit: true,
    };

    const timeout = setTimeout(() => {
      delete orderCallbacks[orderId];
      reject(new Error(`Timeout na ordem ${orderId} — sem confirmação em 30s`));
    }, 30000);

    orderCallbacks[orderId] = { resolve, reject, timeout };
    ib.placeOrder(orderId, contract, order);
    logger.info(`Ordem colocada: ${action} ${units} ${assetId} (id:${orderId})`);
  });
}

// ── Executar ordem com bracket (SL + TP automáticos) ────────────────────────
function placeBracketOrder(assetId, units, entryPrice, slPrice, tpPrice) {
  return new Promise((resolve, reject) => {
    if (!connected) return reject(new Error("IBKR não conectado"));

    const contract   = getContract(assetId);
    const parentId   = nextOrderId++;
    const slOrderId  = nextOrderId++;
    const tpOrderId  = nextOrderId++;

    // Ordem principal
    const parent = {
      orderId:       parentId,
      action:        OrderAction.BUY,
      orderType:     OrderType.MKT,
      totalQuantity: units,
      transmit:      false, // não transmite até ter os filhos
    };

    // Stop Loss
    const stopLoss = {
      orderId:       slOrderId,
      action:        OrderAction.SELL,
      orderType:     OrderType.STP,
      auxPrice:      slPrice,
      totalQuantity: units,
      parentId,
      transmit:      false,
    };

    // Take Profit
    const takeProfit = {
      orderId:       tpOrderId,
      action:        OrderAction.SELL,
      orderType:     OrderType.LMT,
      lmtPrice:      tpPrice,
      totalQuantity: units,
      parentId,
      transmit:      true, // transmite tudo junto
    };

    const timeout = setTimeout(() => {
      delete orderCallbacks[parentId];
      reject(new Error("Timeout na bracket order"));
    }, 30000);

    orderCallbacks[parentId] = { resolve, reject, timeout };

    ib.placeOrder(parentId,  contract, parent);
    ib.placeOrder(slOrderId, contract, stopLoss);
    ib.placeOrder(tpOrderId, contract, takeProfit);

    logger.info(`Bracket order: BUY ${units} ${assetId} | SL $${slPrice} | TP $${tpPrice}`);
  });
}

// ── Fechar posição (vender tudo) ──────────────────────────────────────────────
function closePosition(assetId, units) {
  return placeMarketOrder(assetId, units, OrderAction.SELL);
}

function isConnected() { return connected; }

module.exports = {
  connect,
  subscribePrice,
  getPrice,
  placeMarketOrder,
  placeBracketOrder,
  closePosition,
  isConnected,
  SYMBOL_MAP,
};
