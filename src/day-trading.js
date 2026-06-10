// src/day-trading.js
// Day Trading 24/7 no servidor. Lê a config em users/{uid}/settings/dtState
// (escrita pela app), faz scan com a Groq e abre posições "daytrading".
// A gestão de SL/TP é feita pelo sim-engine (igual às outras posições).

const logger = require("./logger");
const prices = require("./prices");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

// Universo do Day Trading. Crypto (24/7) + ETFs/commodities em sessão US.
// Inclui agora os crypto que negoceias de facto (SOL/XRP/ADA/AVAX/DOT/LINK),
// que antes ficavam de fora — o DT nunca lhes tocava mesmo ligado.
const TRADEABLE = ["btc","eth","sol","xrp","ada","avax","dot","link","wti","gold","silver","spy","qqq","gld","eurusd","gbpusd"];
const META = {
  btc:{nome:"Bitcoin",sym:"BTC"}, eth:{nome:"Ethereum",sym:"ETH"},
  sol:{nome:"Solana",sym:"SOL"}, xrp:{nome:"XRP",sym:"XRP"},
  ada:{nome:"Cardano",sym:"ADA"}, avax:{nome:"Avalanche",sym:"AVAX"},
  dot:{nome:"Polkadot",sym:"DOT"}, link:{nome:"Chainlink",sym:"LINK"},
  wti:{nome:"Petróleo WTI",sym:"WTI"}, gold:{nome:"Ouro",sym:"XAU"},
  silver:{nome:"Prata",sym:"XAG"}, spy:{nome:"S&P 500 ETF",sym:"SPY"},
  qqq:{nome:"Nasdaq ETF",sym:"QQQ"}, gld:{nome:"Gold ETF",sym:"GLD"},
  eurusd:{nome:"EUR/USD",sym:"EUR/USD"}, gbpusd:{nome:"GBP/USD",sym:"GBP/USD"},
};

// Horário de mercado (UTC). Crypto = sempre. Resto = sessão US/Forex em dias úteis.
const HOURS = {
  crypto:    { always: true },
  commodity: { openH: 14.5, closeH: 21, weekdays: true },
  etf:       { openH: 14.5, closeH: 21, weekdays: true },
  forex:     { openH: 0,    closeH: 21, weekdays: true },
};
const CAT = {
  btc:"crypto", eth:"crypto", sol:"crypto", xrp:"crypto", ada:"crypto",
  avax:"crypto", dot:"crypto", link:"crypto",
  wti:"commodity", gold:"commodity", silver:"commodity",
  spy:"etf", qqq:"etf", gld:"etf", eurusd:"forex", gbpusd:"forex",
};
function isOpen(id) {
  const h = HOURS[CAT[id]];
  if (!h || h.always) return true;
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const dow = now.getUTCDay();
  if (h.weekdays && (dow === 0 || dow === 6)) return false;
  return utcH >= h.openH && utcH < h.closeH;
}

let lastScan = 0;
let lastRlLog = 0;
let rateLimitedUntil = 0;
// Intervalo de scan do Day Trading. Cada scan é 1 chamada Groq com vários ativos.
// A 5 min eram 288 scans/dia — esgotava o free-tier sozinho, sobretudo a competir
// com os sinais do Cérebro AI. Default agora 10 min (configurável por env).
const SCAN_INTERVAL_MS = (parseInt(process.env.DT_SCAN_MIN || "10", 10)) * 60 * 1000;

async function callGroq(messages, { max_tokens = 1200, temperature = 0.25 } = {}) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens, temperature, messages }),
  });
  const data = await r.json();
  if (!r.ok) { const e = new Error(data?.error?.message || `Groq ${r.status}`); e.status = r.status; throw e; }
  let txt = (data?.choices?.[0]?.message?.content || "{}").replace(/```json|```/g, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
  return JSON.parse(txt);
}

// dt: config lida do Firestore { active, profitTarget, maxLoss, amount, minConf, assets, dailyPnl }
// engine: hooks do sim-engine { openDayTrade, countDayTrades, hasOpen }
async function run(dt, maxDayTrading, engine) {
  if (!GROQ_API_KEY) return;
  if (!dt || !dt.active) return;                 // monitor desligado na app
  const now = Date.now();
  if (now < rateLimitedUntil) {
    // Não fica "morto" em silêncio — avisa de vez em quando porque não opera.
    if (now - lastRlLog > 5 * 60 * 1000) {
      lastRlLog = now;
      logger.warn(`⚡ DayTrading em pausa: Groq rate-limited por mais ~${Math.round((rateLimitedUntil - now)/60000)}min`);
    }
    return;
  }
  if (now - lastScan < SCAN_INTERVAL_MS) return; // respeita o intervalo configurável

  // Watchlist: ativos escolhidos na app, senão todos os tradeable. Só mercados abertos.
  let watch = (Array.isArray(dt.assets) && dt.assets.length)
    ? dt.assets.filter(id => TRADEABLE.includes(id))
    : [...TRADEABLE];
  watch = watch.filter(isOpen);
  if (!watch.length) return; // tudo fechado → poupa tokens

  const all = prices.getAll();
  const lines = watch.map(id => {
    const d = all[id];
    const m = META[id] || { nome: id, sym: id.toUpperCase() };
    return d?.price ? `id=${id} · ${m.nome}(${m.sym}): $${d.price} variação24h=${(d.change||0).toFixed(2)}%` : null;
  }).filter(Boolean).join("\n");
  if (!lines) return;

  lastScan = now;
  const profitTarget = dt.profitTarget ?? 6;
  const maxLoss      = dt.maxLoss ?? 3;
  const amount       = dt.amount ?? 100;
  const minConf      = dt.minConf ?? 75;

  let result;
  try {
    result = await callGroq([
      { role: "system", content: "És um day trader profissional de scalping. Respondes SÓ com JSON puro válido, sem markdown." },
      { role: "user", content:
`ANÁLISE DAY TRADING — ${new Date().toISOString()}
Ativos (mercado aberto):
${lines}

Meta de lucro: ${profitTarget}% · Stop loss: ${maxLoss}% · Valor por trade: €${amount}

Decide, para AGORA (hoje, não amanhã), as 4-6 melhores oportunidades.
No campo "id" usa SEMPRE o valor de id= acima (ex: "silver"), nunca o símbolo.
JSON: {"oportunidades":[{"id":"silver","acao":"COMPRAR|VENDER|AGUARDAR","entrada":30.5,"previsao":"frase curta pt","urgencia":"AGORA|HOJE|AGUARDAR","confianca":82}]}` },
    ]);
  } catch (e) {
    if (e.status === 429) {
      const m = /try again in ([\d.]+)s/i.exec(e.message);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 5000 : 15 * 60 * 1000;
      rateLimitedUntil = Date.now() + waitMs;
      logger.warn(`DayTrading: Groq rate-limit — pausa ~${Math.round(waitMs/60000)}min`);
    } else {
      logger.warn(`DayTrading scan falhou: ${e.message}`);
    }
    return;
  }

  const ops = result?.oportunidades || [];
  let buys = 0;
  for (const op of ops) {
    if (op.acao !== "COMPRAR" || op.urgencia !== "AGORA") continue;
    if ((op.confianca || 0) < minConf) continue;
    const id = String(op.id || "").toLowerCase().trim();
    if (!TRADEABLE.includes(id)) continue;
    if (!isOpen(id)) continue;
    if (engine.countDayTrades() >= maxDayTrading) break;   // limite de posições
    if (engine.hasOpen(id, "daytrading")) continue;        // não duplica o mesmo ativo
    const price = prices.getFreshPrice(id);
    if (!price) continue; // sem preço real fresco → não abre day-trade neste ativo

    const m = META[id] || { nome: id, sym: id.toUpperCase() };
    const ok = await engine.openDayTrade({
      assetId: id, assetName: m.nome, assetSym: m.sym,
      price, amount,
      sl: +(price * (1 - maxLoss / 100)).toFixed(id === "eurusd" ? 5 : 4),
      tp: +(price * (1 + profitTarget / 100)).toFixed(id === "eurusd" ? 5 : 4),
      previsao: op.previsao || "",
      confianca: op.confianca || 0,
    });
    if (ok) buys++;
  }
  if (buys) logger.info(`⚡ DayTrading: ${buys} nova(s) posição(ões) aberta(s)`);
}

module.exports = { run };
