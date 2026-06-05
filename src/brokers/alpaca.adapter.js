// src/brokers/alpaca.adapter.js
// Adaptador Alpaca — embrulha o src/alpaca.js existente no contrato comum.
// Cobre crypto + ações/ETFs US. Comissão $0 em ações; crypto com spread.

const logger = require("../logger");
const alpaca = require("../alpaca");

// IDs de crypto que a Alpaca negoceia (formato de ordem "BTC/USD").
const CRYPTO_IDS = new Set(["btc", "eth", "bnb", "sol", "xrp", "doge"]);
// Ativos não-crypto que a Alpaca cobre via ETF/ticker (ver SYMBOL_MAP em alpaca.js).
const NON_CRYPTO_SUPPORTED = new Set([
  "spy", "qqq", "iwm", "gld", "tlt", "xle", "eem", "vti",
  "gold", "silver", "wti", "natgas", "copper",
]);

function isCrypto(assetId) { return CRYPTO_IDS.has(assetId); }

function orderSymbol(assetId) {
  const base = alpaca.getAlpacaSymbol(assetId); // ex.: BTCUSD, SPY, GLD
  return isCrypto(assetId) ? base.replace(/USD$/, "/USD") : base;
}

module.exports = {
  id: "alpaca",
  name: "Alpaca Markets",
  assetClasses: ["crypto", "etf", "stock", "commodity"],

  supports(assetId) {
    return isCrypto(assetId) || NON_CRYPTO_SUPPORTED.has(assetId);
  },

  isConnected() { return alpaca.isConnected(); },

  async verifyConnection() {
    if (!alpaca.isConnected()) {
      throw new Error("Alpaca não configurada — define ALPACA_API_KEY e ALPACA_SECRET_KEY");
    }
    const acc  = await alpaca.getAccount();
    const live = alpaca.isLive();
    logger.info(`  └ Alpaca ${live ? "LIVE 💵" : "PAPER 📝"} | Conta: $${parseFloat(acc.portfolio_value).toFixed(2)} | Compra: $${parseFloat(acc.buying_power).toFixed(2)}`);
    return { ok: true, name: this.name, detail: { live, account: acc } };
  },

  isLive() { return alpaca.isLive(); },

  async getBalance() {
    const acc = await alpaca.getAccount();
    return parseFloat(acc.cash);
  },

  async buy({ assetId, amount, price, sl, tp }) {
    const symbol = orderSymbol(assetId);
    if (!isCrypto(assetId)) {
      const open = await alpaca.isMarketOpen();
      if (!open) {
        logger.warn(`Mercado fechado para ${symbol} — ordem adiada`);
        return { ok: false, reason: "market_closed" };
      }
    }
    const qty = amount / price;
    try {
      const orderParams = { symbol, qty, side: "buy" };
      // Bracket (SL+TP nativo) só em ações; crypto é gerida pelo nosso motor.
      if (!isCrypto(assetId)) { orderParams.takeProfit = tp; orderParams.stopLoss = sl; }
      const order = await alpaca.placeOrder(orderParams);
      const fillPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : price;
      return { ok: true, fillPrice, brokerOrderId: order.id, simulated: false };
    } catch (err) {
      logger.error(`[Alpaca] compra falhou (${symbol}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  },

  async sell({ assetId, units, price }) {
    const symbol = orderSymbol(assetId);
    try {
      await alpaca.closePosition(isCrypto(assetId) ? symbol.replace("/", "") : symbol);
      return { ok: true, fillPrice: price, simulated: false };
    } catch (err) {
      logger.error(`[Alpaca] venda falhou (${symbol}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  },
};
