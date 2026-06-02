// src/ai-signals.js
// Gera sinais de mercado (COMPRAR/VENDER/AGUARDAR + confiança) usando Groq.
// Intervalo configurável via definições da app (Firestore). Alimenta o
// "cérebro AI" e a saída por flip. Optimizado para poupar tokens.

const logger = require("./logger");
const prices = require("./prices");

let signals      = {};   // { assetId: { sinal, confianca, razao, previsao, ts } }
let lastFetch    = 0;
let rateLimitedUntil = 0; // se a Groq devolver 429, esperamos até este timestamp

// Intervalo (minutos) — começa nos 15 min; a app pode alterar via definições.
let refreshMin = parseInt(process.env.AI_SIGNALS_MIN || "15", 10);

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Modelo pequeno e barato em tokens por defeito (chega para sinais de SIM).
const GROQ_MODEL   = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

// Só geramos sinais para ativos negociáveis (menos ativos = menos tokens).
const TRADEABLE = new Set(["btc","eth","wti","gold","silver","spy","qqq","gld","eurusd","gbpusd"]);

// Permite à app ajustar o intervalo em tempo real (lido das definições).
function setRefreshMinutes(min) {
  const m = Number(min);
  if (m && m >= 1 && m <= 120 && m !== refreshMin) {
    refreshMin = m;
    logger.info(`🤖 Intervalo de sinais AI alterado para ${m} min`);
  }
}

async function callGroq(messages, { max_tokens = 700, temperature = 0.25 } = {}) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens, temperature, messages }),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message || `Groq ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  let txt = data?.choices?.[0]?.message?.content || "{}";
  txt = txt.replace(/```json|```/g, "").trim();
  const start = txt.indexOf("{");
  const end   = txt.lastIndexOf("}");
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  return JSON.parse(txt);
}

// ── Atualizar sinais (respeita o intervalo configurável) ──────────────────────
async function refresh() {
  if (!GROQ_API_KEY) return signals; // sem chave, sinais ficam vazios
  const now = Date.now();

  // Se fomos rate-limited, não tentar até passar o tempo indicado pela Groq
  if (now < rateLimitedUntil) return signals;

  const intervalMs = refreshMin * 60 * 1000;
  if (now - lastFetch < intervalMs) return signals;
  lastFetch = now;

  try {
    const all = prices.getAll();
    // Apenas ativos negociáveis com preço válido
    const lines = prices.ASSETS
      .filter(a => TRADEABLE.has(a.id))
      .map(a => {
        const d = all[a.id];
        if (!d?.price) return null;
        return `${a.id}=$${d.price}(${(d.change >= 0 ? "+" : "") + (d.change || 0).toFixed(2)}%)`;
      })
      .filter(Boolean)
      .join(", ");

    if (!lines) return signals;

    const result = await callGroq([
      { role: "system", content: "Trader profissional. Respondes SO com JSON puro valido, sem markdown." },
      { role: "user", content:
`Sinal por ativo (tendencia+momento): ${lines}
JSON: {"signals":[{"id":"btc","sinal":"COMPRAR|VENDER|AGUARDAR","confianca":78,"razao":"frase curta pt"}]}` },
    ]);

    const map = {};
    (result.signals || []).forEach(s => {
      if (s && s.id) map[s.id] = { ...s, ts: now };
    });
    signals = map;
    const buys = Object.values(map).filter(s => s.sinal === "COMPRAR").length;
    logger.info(`🤖 Sinais AI: ${Object.keys(map).length} ativos (${buys} COMPRAR) · proximo em ${refreshMin}min`);
  } catch (e) {
    if (e.status === 429) {
      // Rate limit: tenta extrair "try again in Xs" da mensagem; senao espera 30 min
      const m = /try again in ([\d.]+)s/i.exec(e.message);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 5000 : 30 * 60 * 1000;
      rateLimitedUntil = Date.now() + waitMs;
      logger.warn(`Groq rate-limit atingido. A pausar sinais AI por ~${Math.round(waitMs/60000)}min.`);
    } else {
      logger.warn(`Sinais AI falharam: ${e.message}`);
    }
  }
  return signals;
}

function getSignals()        { return signals; }
function getSignal(assetId)  { return signals[assetId] || null; }
function getRefreshMinutes() { return refreshMin; }

module.exports = { refresh, getSignals, getSignal, setRefreshMinutes, getRefreshMinutes };
