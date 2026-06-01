// src/ai-signals.js
// Gera sinais de mercado (COMPRAR/VENDER/AGUARDAR + confiança) usando Groq.
// Corre no servidor a cada 5 min. Alimenta o "cérebro AI" e a saída por flip.

const logger = require("./logger");
const prices = require("./prices");

let signals      = {};   // { assetId: { sinal, confianca, razao, previsao, ts } }
let lastFetch    = 0;
const REFRESH_MS = 5 * 60 * 1000; // 5 min

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

async function callGroq(messages, { max_tokens = 1200, temperature = 0.25 } = {}) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens, temperature, messages }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Groq ${r.status}`);
  let txt = data?.choices?.[0]?.message?.content || "{}";
  // Limpar fences de markdown se existirem
  txt = txt.replace(/```json|```/g, "").trim();
  // Extrair o primeiro bloco JSON
  const start = txt.indexOf("{");
  const end   = txt.lastIndexOf("}");
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  return JSON.parse(txt);
}

// ── Atualizar sinais (respeita o intervalo de 5 min) ──────────────────────────
async function refresh() {
  if (!GROQ_API_KEY) return signals; // sem chave, sinais ficam vazios
  const now = Date.now();
  if (now - lastFetch < REFRESH_MS) return signals;
  lastFetch = now;

  try {
    const all = prices.getAll();
    const lines = prices.ASSETS.map(a => {
      const d = all[a.id];
      if (!d?.price) return null;
      return `${a.id}:${a.sym}=$${d.price}(${(d.change >= 0 ? "+" : "") + (d.change || 0).toFixed(2)}%)`;
    }).filter(Boolean).join(", ");

    if (!lines) return signals;

    const result = await callGroq([
      { role: "system", content: "És um trader profissional. Respondes SEMPRE com JSON puro válido, sem markdown nem texto fora do JSON." },
      { role: "user", content:
`Analisa estes ativos AGORA e dá um sinal por ativo: ${lines}

Considera tendência, momento e volatilidade. Sê decisivo.
JSON puro: {"signals":[{"id":"btc","sinal":"COMPRAR|VENDER|AGUARDAR","confianca":78,"razao":"1 frase pt","previsao":"tendência 1-3 dias pt"}]}` },
    ]);

    const map = {};
    (result.signals || []).forEach(s => {
      if (s && s.id) map[s.id] = { ...s, ts: now };
    });
    signals = map;
    const buys = Object.values(map).filter(s => s.sinal === "COMPRAR").length;
    logger.info(`🤖 Sinais AI atualizados: ${Object.keys(map).length} ativos (${buys} COMPRAR)`);
  } catch (e) {
    logger.warn(`Sinais AI falharam: ${e.message}`);
  }
  return signals;
}

function getSignals()        { return signals; }
function getSignal(assetId)  { return signals[assetId] || null; }

module.exports = { refresh, getSignals, getSignal };
