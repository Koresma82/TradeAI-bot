// src/prices.js
// Preços reais — CoinGecko (crypto) + Stooq (commodities/ETFs/forex)
// Stooq funciona bem em datacenters (Yahoo bloqueia frequentemente)

const logger = require("./logger");

const ASSETS = [
  { id:"btc",    sym:"BTC",     cat:"Crypto",    cg:"bitcoin",      stooq:null         },
  { id:"eth",    sym:"ETH",     cat:"Crypto",    cg:"ethereum",     stooq:null         },
  { id:"bnb",    sym:"BNB",     cat:"Crypto",    cg:"binancecoin",  stooq:null         },
  { id:"sol",    sym:"SOL",     cat:"Crypto",    cg:"solana",       stooq:null         },
  { id:"xrp",    sym:"XRP",     cat:"Crypto",    cg:"ripple",       stooq:null         },
  { id:"wti",    sym:"WTI",     cat:"Commodity", cg:null,           stooq:"cl.f"       },
  { id:"gold",   sym:"XAU",     cat:"Commodity", cg:null,           stooq:"gc.f"       },
  { id:"silver", sym:"XAG",     cat:"Commodity", cg:null,           stooq:"si.f"       },
  { id:"spy",    sym:"SPY",     cat:"ETF",       cg:null,           stooq:"spy.us"     },
  { id:"qqq",    sym:"QQQ",     cat:"ETF",       cg:null,           stooq:"qqq.us"     },
  { id:"gld",    sym:"GLD",     cat:"ETF",       cg:null,           stooq:"gld.us"     },
  { id:"eurusd", sym:"EUR/USD", cat:"Forex",     cg:null,           stooq:"eurusd"     },
  { id:"gbpusd", sym:"GBP/USD", cat:"Forex",     cg:null,           stooq:"gbpusd"     },
];

const BASE_PRICES = {
  btc:67420, eth:3580, bnb:420, sol:145, xrp:0.52,
  wti:78, gold:2341, silver:27.85, spy:524, qqq:448, gld:218,
  eurusd:1.0842, gbpusd:1.268,
};

let priceCache  = {};
let prevPrices  = {};
let initialized = false;

// ── CoinGecko (crypto) ──────────────────────────────────────────────────────
async function fetchCoinGecko() {
  const cgAssets = ASSETS.filter(a => a.cg);
  const ids      = cgAssets.map(a => a.cg).join(",");
  const url      = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const data = await r.json();
  cgAssets.forEach(a => {
    if (data[a.cg]) {
      priceCache[a.id] = {
        price:  data[a.cg].usd,
        change: data[a.cg].usd_24h_change || 0,
        ts:     Date.now(),
      };
    }
  });
  logger.info(`CoinGecko: ${cgAssets.length} preços ✓`);
}

// ── Stooq (commodities/ETFs/forex) — CSV, funciona em datacenters ──────────
// Formato CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
async function fetchStooq() {
  const stooqAssets = ASSETS.filter(a => a.stooq);
  const symbols     = stooqAssets.map(a => a.stooq).join(",");
  // Stooq aceita múltiplos símbolos: https://stooq.com/q/l/?s=SYM1,SYM2&f=sd2t2ohlcv&h&e=csv
  const url = `https://stooq.com/q/l/?s=${symbols}&f=sd2t2ohlcv&h&e=csv`;
  const r   = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Stooq ${r.status}`);
  const csv   = await r.text();
  const lines = csv.trim().split("\n");
  // Primeira linha é cabeçalho
  for (let i = 1; i < lines.length; i++) {
    const cols   = lines[i].split(",");
    const symbol = cols[0]?.toLowerCase();
    const close  = parseFloat(cols[6]);
    if (!symbol || isNaN(close)) continue;
    const asset = stooqAssets.find(a => a.stooq.toLowerCase() === symbol);
    if (!asset) continue;
    // Calcular change vs preço anterior em cache
    const prev   = prevPrices[asset.id] || close;
    const change = prev > 0 ? ((close - prev) / prev) * 100 : 0;
    priceCache[asset.id] = {
      price:  +close.toFixed(asset.cat === "Forex" ? 5 : 2),
      change: +change.toFixed(3),
      ts:     Date.now(),
    };
  }
  logger.info(`Stooq: ${stooqAssets.length} preços ✓`);
}

// ── Refresh all ─────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!initialized) {
    Object.entries(BASE_PRICES).forEach(([id, p]) => {
      if (!priceCache[id]) priceCache[id] = { price: p, change: 0, ts: Date.now() };
    });
    initialized = true;
  }

  // Guardar preços atuais como "anteriores" para cálculo de change
  Object.entries(priceCache).forEach(([id, d]) => { prevPrices[id] = d.price; });

  const results = await Promise.allSettled([fetchCoinGecko(), fetchStooq()]);
  const errors  = results.filter(r => r.status === "rejected");
  if (errors.length) {
    errors.forEach(e => logger.warn(`Price feed falhou: ${e.reason?.message}`));
  }
}

function getPrice(assetId) { return priceCache[assetId]?.price || BASE_PRICES[assetId] || null; }
function getAll()          { return { ...priceCache }; }

module.exports = { refreshAll, getPrice, getAll, ASSETS, BASE_PRICES };
