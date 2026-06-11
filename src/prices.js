// src/prices.js
// Preços reais com FALLBACK EM CASCATA por classe de ativo:
//   Crypto       : Binance → CoinGecko → cache
//   Forex/ETF/Comm: TwelveData → Stooq → Yahoo → cache
// Sem média de fontes (prioridade + deteção de outliers). TwelveData usa TWELVEDATA_KEY.

const logger = require("./logger");

const TWELVE_KEY = process.env.TWELVEDATA_KEY || "";
const STOOQ_KEY  = process.env.STOOQ_APIKEY || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
// Domínio de dados da Binance (público, sem 451 em datacenters). Override via env.
const BINANCE_DATA = process.env.BINANCE_DATA_URL || "https://data-api.binance.vision";
let binanceBlocked = false; // se der 451, deixa de tentar nesta execução

const ASSETS = [
  // ── Crypto (CoinGecko, 24/7) ──
  { id:"btc",    sym:"BTC",     name:"Bitcoin",       icon:"₿",  cat:"Crypto",    cg:"bitcoin",      stooq:null, binance:"BTCUSDT", td:null, yahoo:null },
  { id:"eth",    sym:"ETH",     name:"Ethereum",      icon:"Ξ",  cat:"Crypto",    cg:"ethereum",     stooq:null, binance:"ETHUSDT", td:null, yahoo:null },
  { id:"bnb",    sym:"BNB",     name:"BNB",           icon:"🔶", cat:"Crypto",    cg:"binancecoin",  stooq:null, binance:"BNBUSDT", td:null, yahoo:null },
  { id:"sol",    sym:"SOL",     name:"Solana",        icon:"◎",  cat:"Crypto",    cg:"solana",       stooq:null, binance:"SOLUSDT", td:null, yahoo:null },
  { id:"xrp",    sym:"XRP",     name:"XRP",           icon:"✕",  cat:"Crypto",    cg:"ripple",       stooq:null, binance:"XRPUSDT", td:null, yahoo:null },
  { id:"ada",    sym:"ADA",     name:"Cardano",       icon:"₳",  cat:"Crypto",    cg:"cardano",      stooq:null, binance:"ADAUSDT", td:null, yahoo:null },
  { id:"doge",   sym:"DOGE",    name:"Dogecoin",      icon:"🐕", cat:"Crypto",    cg:"dogecoin",     stooq:null, binance:"DOGEUSDT", td:null, yahoo:null },
  { id:"avax",   sym:"AVAX",    name:"Avalanche",     icon:"🔺", cat:"Crypto",    cg:"avalanche-2",  stooq:null, binance:"AVAXUSDT", td:null, yahoo:null },
  { id:"dot",    sym:"DOT",     name:"Polkadot",      icon:"⬤",  cat:"Crypto",    cg:"polkadot",     stooq:null, binance:"DOTUSDT", td:null, yahoo:null },
  { id:"link",   sym:"LINK",    name:"Chainlink",     icon:"⬡",  cat:"Crypto",    cg:"chainlink",    stooq:null, binance:"LINKUSDT", td:null, yahoo:null },
  // ── Commodities (Stooq, horário de mercado) ──
  { id:"wti",    sym:"WTI",     name:"Petróleo WTI",  icon:"🛢", cat:"Commodity", cg:null,           stooq:"cl.f", binance:null, td:"WTI/USD", finnhub:"OANDA:WTICO_USD", yahoo:"CL=F" },
  { id:"gold",   sym:"XAU",     name:"Ouro",          icon:"🥇", cat:"Commodity", cg:null,           stooq:"gc.f", binance:null, td:"XAU/USD", finnhub:"OANDA:XAU_USD", yahoo:"GC=F" },
  { id:"silver", sym:"XAG",     name:"Prata",         icon:"🥈", cat:"Commodity", cg:null,           stooq:"si.f", binance:null, td:"XAG/USD", finnhub:"OANDA:XAG_USD", yahoo:"SI=F" },
  // ── ETFs (Stooq, horário de mercado) ──
  { id:"spy",    sym:"SPY",     name:"S&P 500 ETF",   icon:"📈", cat:"ETF",       cg:null,           stooq:"spy.us", binance:null, td:"SPY", finnhub:"SPY", yahoo:"SPY" },
  { id:"qqq",    sym:"QQQ",     name:"Nasdaq ETF",    icon:"💻", cat:"ETF",       cg:null,           stooq:"qqq.us", binance:null, td:"QQQ", finnhub:"QQQ", yahoo:"QQQ" },
  { id:"gld",    sym:"GLD",     name:"Gold ETF",      icon:"🏅", cat:"ETF",       cg:null,           stooq:"gld.us", binance:null, td:"GLD", finnhub:"GLD", yahoo:"GLD" },
  { id:"iwm",    sym:"IWM",     name:"Russell 2000",  icon:"📊", cat:"ETF",       cg:null,           stooq:"iwm.us", binance:null, td:"IWM", finnhub:"IWM", yahoo:"IWM" },
  { id:"tlt",    sym:"TLT",     name:"US Bonds ETF",  icon:"📋", cat:"ETF",       cg:null,           stooq:"tlt.us", binance:null, td:"TLT", finnhub:"TLT", yahoo:"TLT" },
  { id:"xle",    sym:"XLE",     name:"Energy ETF",    icon:"⚡", cat:"ETF",       cg:null,           stooq:"xle.us", binance:null, td:"XLE", finnhub:"XLE", yahoo:"XLE" },
  // ── Forex (Stooq, dias úteis) ──
  { id:"eurusd", sym:"EUR/USD", name:"EUR/USD",       icon:"💶", cat:"Forex",     cg:null,           stooq:"eurusd", binance:null, td:"EUR/USD", finnhub:"OANDA:EUR_USD", yahoo:"EURUSD=X" },
  { id:"gbpusd", sym:"GBP/USD", name:"GBP/USD",       icon:"💷", cat:"Forex",     cg:null,           stooq:"gbpusd", binance:null, td:"GBP/USD", finnhub:"OANDA:GBP_USD", yahoo:"GBPUSD=X" },
  { id:"usdjpy", sym:"USD/JPY", name:"USD/JPY",       icon:"¥",  cat:"Forex",     cg:null,           stooq:"usdjpy", binance:null, td:"USD/JPY", finnhub:"OANDA:USD_JPY", yahoo:"USDJPY=X" },
  { id:"usdchf", sym:"USD/CHF", name:"USD/CHF",       icon:"🇨🇭", cat:"Forex",    cg:null,           stooq:"usdchf", binance:null, td:"USD/CHF", finnhub:"OANDA:USD_CHF", yahoo:"USDCHF=X" },
  { id:"audusd", sym:"AUD/USD", name:"AUD/USD",       icon:"🇦🇺", cat:"Forex",    cg:null,           stooq:"audusd", binance:null, td:"AUD/USD", finnhub:"OANDA:AUD_USD", yahoo:"AUDUSD=X" },
  { id:"usdcad", sym:"USD/CAD", name:"USD/CAD",       icon:"🇨🇦", cat:"Forex",    cg:null,           stooq:"usdcad", binance:null, td:"USD/CAD", finnhub:"OANDA:USD_CAD", yahoo:"USDCAD=X" },
];

const BASE_PRICES = {
  btc:67420, eth:3580, bnb:420, sol:145, xrp:0.52, ada:0.45, doge:0.12,
  avax:35, dot:6.5, link:14,
  wti:78, gold:2341, silver:27.85, spy:524, qqq:448, gld:218, iwm:215, tlt:92, xle:88,
  eurusd:1.0842, gbpusd:1.268, usdjpy:151.5, usdchf:0.88, audusd:0.66, usdcad:1.36,
};

let priceCache  = {};
let prevPrices  = {};
let initialized = false;

// ── Saúde das fontes de preço (para o health check na app) ──────────────────
const sourceHealth = {
  binance:    { ok: null, lastOk: 0, lastErr: null, disabled: false, exhausted: false },
  coingecko:  { ok: null, lastOk: 0, lastErr: null, disabled: false, exhausted: false },
  twelvedata: { ok: null, lastOk: 0, lastErr: null, disabled: false, exhausted: false },
  finnhub:    { ok: null, lastOk: 0, lastErr: null, disabled: false, exhausted: false },
  stooq:      { ok: null, lastOk: 0, lastErr: null, disabled: false, exhausted: false },
  yahoo:      { ok: null, lastOk: 0, lastErr: null, disabled: false, exhausted: false },
};
function getSourceHealth() { return sourceHealth; }

// ── fetch com timeout + retry (recupera falhas de rede pontuais) ────────────
async function fetchWithRetry(url, opts = {}, { tries = 2, timeoutMs = 8000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const reason = e.name === "AbortError" ? `timeout ${timeoutMs}ms` : e.message;
      if (attempt < tries) {
        await new Promise(res => setTimeout(res, 1000 * attempt)); // backoff: 1s, 2s
      } else {
        throw new Error(reason);
      }
    }
  }
  throw lastErr;
}

// ── CoinGecko (crypto) — com cache para evitar 429 ──────────────────────────
let lastCgFetch = 0;
const CG_MIN_INTERVAL = 60000; // mínimo 60s entre pedidos ao CoinGecko (free tier)

async function fetchCoinGecko() {
  const now = Date.now();
  // Respeitar rate limit — só busca se passaram 60s desde o último
  if (now - lastCgFetch < CG_MIN_INTERVAL) {
    return; // mantém os preços em cache, não falha
  }
  lastCgFetch = now;

  const cgAssets = ASSETS.filter(a => a.cg && isStale(a.id));
  if (cgAssets.length === 0) return;
  const ids      = cgAssets.map(a => a.cg).join(",");
  const url      = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const r = await fetchWithRetry(url, { headers: { "Accept": "application/json" } });
  if (r.status === 429) {
    // Rate limited — recua e tenta mais tarde, mantém cache
    lastCgFetch = now + 60000; // espera mais 60s extra
    logger.warn("CoinGecko 429 — a usar cache, retry em 2min");
    return;
  }
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

// ── Helpers de frescura/cache ────────────────────────────────────────────────
function dec(asset) { return asset.cat === "Forex" ? 5 : 2; }
function isStale(id, maxAgeMs = 90000) {
  const c = priceCache[id];
  return !c || (Date.now() - c.ts) > maxAgeMs;
}
function setPrice(asset, price, change) {
  if (change == null) {
    const prev = prevPrices[asset.id] || price;
    change = prev > 0 ? ((price - prev) / prev) * 100 : 0;
  }
  priceCache[asset.id] = { price: +(+price).toFixed(dec(asset)), change: +(+change).toFixed(3), ts: Date.now() };
}
function flagOutliers() {
  ASSETS.forEach(a => {
    const cur = priceCache[a.id]?.price, prev = prevPrices[a.id];
    if (!cur || !prev) return;
    const jump = Math.abs((cur - prev) / prev) * 100;
    const limit = a.cat === "Crypto" ? 15 : a.cat === "Forex" ? 2 : 8;
    if (jump > limit) logger.warn(`⚠ Salto suspeito ${a.sym}: ${prev} → ${cur} (${jump.toFixed(1)}%)`);
  });
}

// ── Binance (crypto, primário) — domínio de DADOS, sem 451 em datacenters ───
async function fetchBinance() {
  if (binanceBlocked) return; // já deu 451 nesta execução; não insistir
  const cryptos = ASSETS.filter(a => a.binance);
  const symbols = JSON.stringify(cryptos.map(a => a.binance));
  const url = `${BINANCE_DATA}/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`;
  const r = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
  if (r.status === 451 || r.status === 403) {
    binanceBlocked = true; // região bloqueada — CoinGecko assume a crypto
    throw new Error(`Binance ${r.status} (região bloqueada — a usar CoinGecko)`);
  }
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  const data = await r.json();
  const bySym = {}; data.forEach(d => { bySym[d.symbol] = d; });
  let ok = 0;
  cryptos.forEach(a => {
    const d = bySym[a.binance]; if (!d) return;
    const price = parseFloat(d.lastPrice); if (isNaN(price)) return;
    priceCache[a.id] = { price, change: +parseFloat(d.priceChangePercent || 0).toFixed(3), ts: Date.now() };
    ok++;
  });
  logger.info(`Binance: ${ok}/${cryptos.length} preços ✓`);
  if (ok === 0) throw new Error("Binance devolveu 0 preços");
}

// ── TwelveData (forex/ETF/commodity, primário) ──────────────────────────────
// Cobra 1 crédito POR SÍMBOLO. Plano grátis: 800/dia, 8 CRÉDITOS/min.
// Por isso: ≤6 símbolos por chamada, ≤1 chamada/min (≤6 créditos/min < 8), e
// orçamento diário. Ao esgotar, o Stooq cobre o resto do dia.
const TD_DAILY_BUDGET = parseInt(process.env.TWELVEDATA_DAILY_BUDGET || "700");
const TD_MIN_INTERVAL = 60000; // 1 chamada por minuto
const TD_MAX_SYMBOLS  = 6;     // ≤6 símbolos/chamada
let tdCreditsToday = 0, tdDayKey = "", tdLastCall = 0;
function tdResetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== tdDayKey) { tdDayKey = today; tdCreditsToday = 0; }
}

async function fetchTwelveData() {
  if (!TWELVE_KEY) return;
  tdResetIfNewDay();
  const now = Date.now();
  if (now - tdLastCall < TD_MIN_INTERVAL) return;
  if (tdCreditsToday >= TD_DAILY_BUDGET) {
    if (tdCreditsToday === TD_DAILY_BUDGET) logger.warn(`TwelveData: orçamento diário (${TD_DAILY_BUDGET}) atingido — backup assume até amanhã`);
    // Marca esgotado para a app NÃO mostrar "OK" enganador. Lança erro suave
    // para o track refletir o estado real (limite atingido).
    const e = new Error(`orçamento diário esgotado (${TD_DAILY_BUDGET} créditos)`);
    e.tdExhausted = true;
    throw e;
  }
  // Só ativos stale há >4min (mexem devagar), no máx TD_MAX_SYMBOLS, mais antigos 1º.
  const wanted = ASSETS.filter(a => a.td && isStale(a.id, 240000))
    .sort((x, y) => (priceCache[x.id]?.ts || 0) - (priceCache[y.id]?.ts || 0))
    .slice(0, TD_MAX_SYMBOLS);
  if (!wanted.length) return;
  tdLastCall = now;
  tdCreditsToday += wanted.length;
  const symbols = wanted.map(a => a.td).join(",");
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${TWELVE_KEY}`;
  const r = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
  if (r.status === 429) { tdCreditsToday = TD_DAILY_BUDGET; throw new Error("TwelveData 429 (limite) — Stooq assume"); }
  if (!r.ok) throw new Error(`TwelveData ${r.status}`);
  const data = await r.json();
  const entries = wanted.length === 1 ? { [wanted[0].td]: data } : data;
  let ok = 0;
  wanted.forEach(a => {
    const q = entries[a.td];
    if (!q || q.status === "error" || q.code) return;
    const price = parseFloat(q.close ?? q.price); if (isNaN(price)) return;
    const change = parseFloat(q.percent_change ?? 0);
    setPrice(a, price, isNaN(change) ? null : change);
    ok++;
  });
  if (ok > 0) logger.info(`TwelveData: ${ok}/${wanted.length} preços ✓`);
  else if (wanted.length) throw new Error("TwelveData devolveu 0 preços úteis");
}

// ── Finnhub (forex/ETF/ação) — quote por símbolo ────────────────────────────
// Free tier: ações/ETF US em tempo real, 60 chamadas/min. O endpoint /quote é
// 1 símbolo por chamada → buscamos só os stale, com teto por ciclo, mais antigos
// primeiro. Forex usa formato OANDA:XXX_YYY.
let fhLastCall = 0;
const FH_MIN_INTERVAL = 60000;            // no máx 1 lote por minuto
const FH_MAX_PER_CYCLE = parseInt(process.env.FINNHUB_MAX_PER_CYCLE || "8"); // ≤8 símbolos/ciclo (folga no 60/min)
async function fetchFinnhub() {
  if (!FINNHUB_KEY) { const e = new Error("Finnhub sem API key (env FINNHUB_KEY)"); e.fhNoKey = true; throw e; }
  const now = Date.now();
  if (now - fhLastCall < FH_MIN_INTERVAL) return;        // respeita o ritmo
  const wanted = ASSETS.filter(a => a.finnhub && isStale(a.id, 240000))
    .sort((x, y) => (priceCache[x.id]?.ts || 0) - (priceCache[y.id]?.ts || 0))
    .slice(0, FH_MAX_PER_CYCLE);
  if (!wanted.length) return;
  fhLastCall = now;
  let ok = 0;
  for (const a of wanted) {
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(a.finnhub)}&token=${FINNHUB_KEY}`;
      const r = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
      if (r.status === 429) throw new Error("Finnhub 429 (limite/min)");
      if (!r.ok) continue;
      const q = await r.json();
      // c=preço atual, dp=variação %. c=0 significa sem dados (símbolo não coberto no free).
      const price = parseFloat(q.c);
      if (!price || isNaN(price)) continue;
      const change = parseFloat(q.dp);
      setPrice(a, price, isNaN(change) ? null : change);
      ok++;
    } catch (e) {
      if (String(e.message).includes("429")) { throw e; } // propaga rate-limit
      // outros erros por símbolo: ignora e continua
    }
  }
  if (ok > 0) logger.info(`Finnhub: ${ok}/${wanted.length} preços ✓`);
  else throw new Error("Finnhub devolveu 0 preços úteis (símbolos podem exigir plano pago)");
}

// ── Yahoo Finance (ETF/commodity, último recurso) ───────────────────────────
async function fetchYahoo() {
  const wanted = ASSETS.filter(a => a.yahoo && a.cat !== "Forex" && isStale(a.id));
  if (!wanted.length) return;
  const symbols = wanted.map(a => a.yahoo).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
  const r = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json" } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const data = await r.json();
  const rows = data?.quoteResponse?.result || [];
  const bySym = {}; rows.forEach(q => { bySym[q.symbol] = q; });
  let ok = 0;
  wanted.forEach(a => {
    const q = bySym[a.yahoo]; if (!q) return;
    const price = parseFloat(q.regularMarketPrice); if (isNaN(price)) return;
    setPrice(a, price, parseFloat(q.regularMarketChangePercent || 0));
    ok++;
  });
  if (ok > 0) logger.info(`Yahoo: ${ok}/${wanted.length} preços ✓`);
}

// ── Stooq (commodities/ETFs/forex) — CSV, funciona em datacenters ──────────
// Formato CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
async function fetchStooq() {
  // Desde março de 2026 o Stooq exige API key para downloads CSV. Sem chave,
  // devolve uma página HTML de instruções (não CSV) → tratamos como indisponível.
  if (!STOOQ_KEY) {
    const e = new Error("Stooq requer API key (env STOOQ_APIKEY) — fonte desativada");
    e.stooqNoKey = true;
    throw e;
  }
  const stooqAssets = ASSETS.filter(a => a.stooq && isStale(a.id));
  if (!stooqAssets.length) return;
  const symbols     = stooqAssets.map(a => a.stooq).join(",");
  // Stooq aceita múltiplos símbolos: https://stooq.com/q/l/?s=SYM1,SYM2&f=sd2t2ohlcv&h&e=csv
  const url = `https://stooq.com/q/l/?s=${symbols}&f=sd2t2ohlcv&h&e=csv&apikey=${encodeURIComponent(STOOQ_KEY)}`;
  const r   = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Stooq ${r.status}`);
  const csv   = await r.text();
  // Se vier HTML (página de instruções/erro de chave) em vez de CSV, é falha.
  const head = csv.slice(0, 200).toLowerCase();
  if (head.includes("<!doctype") || head.includes("<html") || head.includes("apikey")) {
    throw new Error("Stooq devolveu HTML (API key inválida ou em falta)");
  }
  const lines = csv.trim().split("\n");
  let ok = 0;
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
    ok++;
  }
  if (ok > 0) logger.info(`Stooq: ${ok}/${stooqAssets.length} preços ✓`);
  else throw new Error("Stooq devolveu 0 preços úteis");
}

// ── Refresh all ─────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!initialized) {
    Object.entries(BASE_PRICES).forEach(([id, p]) => {
      if (!priceCache[id]) priceCache[id] = { price: p, change: 0, ts: Date.now(), seed: true };
    });
    initialized = true;
  }

  // Guardar preços atuais como "anteriores" para cálculo de change
  Object.entries(priceCache).forEach(([id, d]) => { prevPrices[id] = d.price; });

  const track = (name, res) => {
    const src = sourceHealth[name]; if (!src) return;
    if (res.status === "rejected") {
      // TwelveData com orçamento diário esgotado → estado "limite", não falha de rede.
      if (res.reason?.tdExhausted) {
        src.ok = false; src.exhausted = true; src.disabled = false; src.lastErr = res.reason.message;
        if (!src._warnedExhausted) { logger.warn(`TwelveData: ${res.reason.message} — repõe amanhã`); src._warnedExhausted = true; }
        return;
      }
      // Finnhub ou Stooq sem API key → "desativado", não falha. Loga 1x.
      if (res.reason?.stooqNoKey || res.reason?.fhNoKey) {
        src.ok = false; src.disabled = true; src.lastErr = "sem API key";
        if (!src._warnedNoKey) { logger.warn(`${name} desativado: define a API key para o reativar`); src._warnedNoKey = true; }
        return;
      }
      src.ok = false; src.disabled = false; src.lastErr = res.reason?.message || String(res.reason);
      logger.warn(`Price feed ${name} falhou: ${src.lastErr} (a usar próxima fonte/cache)`);
    } else { src.ok = true; src.disabled = false; src.exhausted = false; src.lastOk = Date.now(); src.lastErr = null; src._warnedExhausted = false; }
  };

  // 1) Crypto: Binance primeiro, CoinGecko cobre buracos.
  track("binance",   (await Promise.allSettled([fetchBinance()]))[0]);
  track("coingecko", (await Promise.allSettled([fetchCoinGecko()]))[0]);

  // 2) Forex/ETF/Commodity: TwelveData primeiro (se houver chave).
  track("twelvedata", (await Promise.allSettled([fetchTwelveData()]))[0]);

  // 3) Finnhub (forex/ETF/ação) — backup principal dos não-crypto. Free 60/min.
  track("finnhub", (await Promise.allSettled([fetchFinnhub()]))[0]);

  // 4) Fallbacks para o que ainda estiver stale: Stooq e Yahoo.
  const [stooqRes, yahooRes] = await Promise.allSettled([fetchStooq(), fetchYahoo()]);
  track("stooq", stooqRes);
  track("yahoo", yahooRes);

  // 4) Diagnóstico de outliers (não bloqueia).
  flagOutliers();

  // 5) Relatório do que ficou só em cache/base.
  const stale = ASSETS.filter(a => isStale(a.id, 120000)).map(a => a.sym);
  if (stale.length) logger.warn(`A usar cache/base para: ${stale.join(", ")}`);
}

function getPrice(assetId) { return priceCache[assetId]?.price || BASE_PRICES[assetId] || null; }
function getAll()          { return { ...priceCache }; }

// ── Preço FRESCO e REAL (para decisões de trading) ───────────────────────────
// getPrice() devolve o base estático como último recurso, o que é aceitável para
// DISPLAY mas perigoso para SL/TP/abertura/fecho: comparar uma entrada real com
// um base desatualizado gera P&L e disparos fantasma (foi o que aconteceu com o
// ouro na app). Para trading, usamos getFreshPrice(): só devolve preço se vier
// mesmo de um feed (não-seed) e estiver fresco; caso contrário devolve null e o
// motor NÃO opera nesse ativo neste tick.
// Janela de frescura por CATEGORIA. Crypto atualiza ao segundo → apertado.
// Metais/ETF/forex movem-se devagar e as fontes (Stooq/TwelveData/Yahoo) são
// mais lentas e falham mais → tolerância maior, senão recusam-se compras
// legítimas a preços ainda válidos (foi o que bloqueou a compra de prata).
// Isto NÃO enfraquece a proteção do crypto, que continua apertada.
const FRESH_BY_CAT = {
  Crypto:    120000,   // 2 min
  Commodity: 600000,   // 10 min
  ETF:       600000,   // 10 min
  Forex:     600000,   // 10 min
  "Ação":    600000,   // 10 min
};
function freshWindow(assetId) {
  const a = ASSETS.find(x => x.id === assetId);
  return (a && FRESH_BY_CAT[a.cat]) || 120000;
}
function isReal(assetId, maxAgeMs) {
  const c = priceCache[assetId];
  const win = typeof maxAgeMs === "number" ? maxAgeMs : freshWindow(assetId);
  return !!c && !c.seed && typeof c.price === "number" && c.price > 0 && (Date.now() - c.ts) <= win;
}
function getFreshPrice(assetId, maxAgeMs) {
  return isReal(assetId, maxAgeMs) ? priceCache[assetId].price : null;
}

// ── Histórico diário (para indicadores: RSI, médias móveis) ──────────────────
// Busca ~3 meses de fechos diários. Stooq (ações/ETF/commodity/forex) e
// CoinGecko (crypto). Devolve { assetId: [preços, mais antigo→recente] }.
async function fetchHistory() {
  const hist = {};

  // Stooq: endpoint de histórico diário por símbolo
  const stooqAssets = ASSETS.filter(a => a.stooq);
  for (const a of stooqAssets) {
    try {
      const url = `https://stooq.com/q/d/l/?s=${a.stooq}&i=d`;
      const r = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } }, { tries: 2, timeoutMs: 10000 });
      if (!r.ok) continue;
      const csv = (await r.text()).trim().split("\n");
      // cabeçalho: Date,Open,High,Low,Close,Volume
      const closes = csv.slice(1)
        .map(l => parseFloat(l.split(",")[4]))
        .filter(v => !isNaN(v));
      if (closes.length) hist[a.id] = closes.slice(-90); // últimos ~90 dias
    } catch (e) { /* ignora; indicadores nascem quando houver dados */ }
  }

  // CoinGecko: market_chart com 90 dias
  const cgAssets = ASSETS.filter(a => a.cg);
  for (const a of cgAssets) {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${a.cg}/market_chart?vs_currency=usd&days=90&interval=daily`;
      const r = await fetchWithRetry(url, { headers: { "Accept": "application/json" } }, { tries: 2, timeoutMs: 10000 });
      if (!r.ok) continue;
      const data = await r.json();
      const closes = (data.prices || []).map(p => p[1]).filter(v => !isNaN(v));
      if (closes.length) hist[a.id] = closes.slice(-90);
      await new Promise(res => setTimeout(res, 1500)); // respeitar rate limit do CG
    } catch (e) { /* ignora */ }
  }

  return hist;
}

module.exports = { refreshAll, getPrice, getFreshPrice, isReal, getAll, getSourceHealth, fetchHistory, ASSETS, BASE_PRICES };
