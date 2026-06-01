// src/prices.js
// Preços reais via CoinGecko + Yahoo Finance — não precisa de IBKR/Alpaca

const logger = require("./logger");

// ── Asset definitions ─────────────────────────────────────────────────────────
const ASSETS = [
  { id:"btc",    sym:"BTC",     cat:"Crypto",    cg:"bitcoin",      yahoo:null        },
  { id:"eth",    sym:"ETH",     cat:"Crypto",    cg:"ethereum",     yahoo:null        },
  { id:"bnb",    sym:"BNB",     cat:"Crypto",    cg:"binancecoin",  yahoo:null        },
  { id:"sol",    sym:"SOL",     cat:"Crypto",    cg:"solana",       yahoo:null        },
  { id:"xrp",    sym:"XRP",     cat:"Crypto",    cg:"ripple",       yahoo:null        },
  { id:"wti",    sym:"WTI",     cat:"Commodity", cg:null,           yahoo:"CL=F"      },
  { id:"gold",   sym:"XAU",     cat:"Commodity", cg:null,           yahoo:"GC=F"      },
  { id:"silver", sym:"XAG",     cat:"Commodity", cg:null,           yahoo:"SI=F"      },
  { id:"brent",  sym:"BRENT",   cat:"Commodity", cg:null,           yahoo:"BZ=F"      },
  { id:"spy",    sym:"SPY",     cat:"ETF",       cg:null,           yahoo:"SPY"       },
  { id:"qqq",    sym:"QQQ",     cat:"ETF",       cg:null,           yahoo:"QQQ"       },
  { id:"gld",    sym:"GLD",     cat:"ETF",       cg:null,           yahoo:"GLD"       },
  { id:"eurusd", sym:"EUR/USD", cat:"Forex",     cg:null,           yahoo:"EURUSD=X"  },
  { id:"gbpusd", sym:"GBP/USD", cat:"Forex",     cg:null,           yahoo:"GBPUSD=X"  },
];

const BASE_PRICES = {
  btc:67420, eth:3580, bnb:420, sol:145, xrp:0.52,
  wti:78, gold:2341, silver:27.85, brent:82, spy:524, qqq:448, gld:218,
  eurusd:1.0842, gbpusd:1.268,
};

let priceCache = {}; // { assetId: { price, change, ts } }
let initialized = false;

// ── CoinGecko ─────────────────────────────────────────────────────────────────
async function fetchCoinGecko() {
  const cgAssets = ASSETS.filter(a => a.cg);
  const ids      = cgAssets.map(a => a.cg).join(",");
  const url      = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const r        = await fetch(url, { headers: { "Accept": "application/json" } });
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
  logger.info(`CoinGecko: ${cgAssets.length} preços atualizados`);
}

// ── Yahoo Finance ─────────────────────────────────────────────────────────────
async function fetchYahoo(asset) {
  const url = `https://query1.finance.yahoo.com/v8/chart/${encodeURIComponent(asset.yahoo)}?interval=1m&range=1d`;
  const r   = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
  if (!r.ok) throw new Error(`Yahoo ${asset.yahoo} ${r.status}`);
  const data  = await r.json();
  const meta  = data?.chart?.result?.[0]?.meta;
  if (!meta) return;
  const price     = meta.regularMarketPrice || meta.chartPreviousClose;
  const prevClose = meta.chartPreviousClose  || price;
  const change    = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
  priceCache[asset.id] = { price: +price.toFixed(4), change: +change.toFixed(3), ts: Date.now() };
}

// ── Refresh all prices ────────────────────────────────────────────────────────
async function refreshAll() {
  // Initialize with base prices if empty
  if (!initialized) {
    Object.entries(BASE_PRICES).forEach(([id, p]) => {
      if (!priceCache[id]) priceCache[id] = { price: p, change: 0, ts: Date.now() };
    });
    initialized = true;
  }

  // Fetch live prices
  const results = await Promise.allSettled([
    fetchCoinGecko(),
    ...ASSETS.filter(a => a.yahoo).map(a => fetchYahoo(a)),
  ]);
  const errors = results.filter(r => r.status === "rejected");
  if (errors.length) logger.warn(`${errors.length} price feeds falharam: ${errors.map(e => e.reason?.message).join(", ")}`);
}

// ── Get price for asset ───────────────────────────────────────────────────────
function getPrice(assetId) {
  return priceCache[assetId]?.price || BASE_PRICES[assetId] || null;
}

function getAll() { return { ...priceCache }; }

module.exports = { refreshAll, getPrice, getAll, ASSETS, BASE_PRICES };
