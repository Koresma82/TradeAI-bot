// src/news-sentiment.js
// ─────────────────────────────────────────────────────────────────────────────
// SENTIMENT DE NOTÍCIAS → VIÉS DE EXPOSIÇÃO (nunca toca em SL/TP).
//
// FILOSOFIA (importante, lê isto):
//   A tentação é deixar a IA ler notícias e ALARGAR o TP quando "prevê" subida.
//   Isso é curve-fitting reativo e perde dinheiro: a notícia já está no preço
//   quando a lês, o LLM não tem edge preditivo de direção, e mexer no nível de
//   stop com base num palpite de manchete é exatamente como se rebentam contas.
//
//   O que ESTE módulo faz é diferente e defensável: traduz o "clima" de notícias
//   num único número — viés de exposição em [-1, +1] — que SÓ ajusta QUANTO
//   arriscas (nº de posições, € por trade, confiança exigida), dentro dos tetos
//   que o utilizador já definiu. NUNCA mexe em SL/TP de trade nenhum.
//     • Clima muito negativo (ex.: escalada de guerra, choque macro) → -1 →
//       aperta exposição (menos posições, menos €, exige mais confiança).
//     • Clima muito positivo (ex.: desescalada credível, corte de juros) → +1 →
//       afrouxa até ao TETO do utilizador (nunca acima).
//     • Incerteza/ruído → ~0 → não mexe.
//
//   Resumo: a IA pode dizer "o ambiente parece arriscado" e o bot encolhe.
//   A IA NÃO decide "vai subir, aposta mais e põe o alvo mais longe".
//   Direção é do mercado; tamanho é do risco. Só mexemos no segundo.
//
// FONTE: uma chamada Groq periódica (15-30 min) que classifica o clima macro a
//   partir de uma lista curta de manchetes que TU lhe dás (ou um resumo). Sem
//   manchetes → fica neutro. Free-tier-friendly: 1 chamada barata por ciclo.
// ─────────────────────────────────────────────────────────────────────────────

const logger = require("./logger");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_NEWS_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

let state = {
  bias: 0,            // viés de exposição em [-1, +1]
  label: "neutro",    // "muito negativo" | "negativo" | "neutro" | "positivo" | "muito positivo"
  rationale: "sem notícias avaliadas",
  ts: 0,
  source: "none",     // "groq" | "manual" | "none"
};

let lastFetch = 0;
let rateLimitedUntil = 0;
let refreshMin = parseInt(process.env.NEWS_REFRESH_MIN || "20", 10);

// Limite de quanto o sentiment pode mexer — nunca domina os indicadores técnicos.
// 0.30 = no máximo ±30% de ajuste de exposição. O viés é um modificador, não o motor.
const MAX_TILT = Math.min(0.5, Math.max(0, parseFloat(process.env.NEWS_MAX_TILT || "0.30")));

// ── Headlines: lidas do Firestore (a app/utilizador escreve) ou env de teste ──
// Mantemos o módulo agnóstico: quem alimenta as manchetes é o caller (sim-engine
// lê de users/{uid}/settings/newsFeed e passa-as a refresh()).
function labelFromBias(b) {
  if (b <= -0.6) return "muito negativo";
  if (b <= -0.2) return "negativo";
  if (b <   0.2) return "neutro";
  if (b <   0.6) return "positivo";
  return "muito positivo";
}

async function callGroq(messages, { max_tokens = 350, temperature = 0.15 } = {}) {
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

// headlines: array de strings (manchetes de fontes fiáveis que TU forneces).
// Manual override: { manualBias:Number, manualLabel:String } salta o Groq.
async function refresh(feed = {}) {
  const now = Date.now();

  // Override manual (utilizador define o clima à mão na app) — tem prioridade.
  if (feed.manualBias != null) {
    const b = Math.max(-1, Math.min(1, Number(feed.manualBias)));
    state = { bias: b, label: feed.manualLabel || labelFromBias(b),
              rationale: feed.manualRationale || "definido manualmente", ts: now, source: "manual" };
    return state;
  }

  if (!GROQ_API_KEY) return state;
  if (now < rateLimitedUntil) return state;
  if (now - lastFetch < refreshMin * 60 * 1000) return state;

  const headlines = Array.isArray(feed.headlines) ? feed.headlines.filter(Boolean) : [];
  if (!headlines.length) {
    // Sem manchetes → decai suavemente para neutro (não confiar em leitura velha).
    if (state.bias !== 0 && now - state.ts > 6 * 60 * 60 * 1000) {
      state = { bias: 0, label: "neutro", rationale: "notícias expiraram → neutro", ts: now, source: "none" };
    }
    return state;
  }

  lastFetch = now;
  try {
    const result = await callGroq([
      { role: "system", content:
        "És um analista macro. Classificas o CLIMA de RISCO de mercado a partir de manchetes. " +
        "Não prevês direção de preços — avalias se o ambiente está mais ou menos arriscado para " +
        "estar exposto. Respondes SÓ JSON puro, sem markdown." },
      { role: "user", content:
`Manchetes de fontes fiáveis (mais recentes primeiro):
${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Avalia o CLIMA DE RISCO macro GLOBAL (não um ativo específico).
- bias: número entre -1 e +1.
    -1 = ambiente muito arriscado / risk-off (ex.: escalada de guerra, choque macro, crise) → encolher exposição
     0 = incerto / misto / ruído → não mexer
    +1 = ambiente favorável / risk-on credível (ex.: desescalada confirmada, alívio macro) → permitir mais exposição
- IMPORTANTE: só dás bias forte (>0.6 ou <-0.6) se houver um FACTO concreto e credível, não rumor.
- rationale: 1 frase curta em pt a justificar.

JSON: {"bias": -0.4, "rationale": "..."}` },
    ]);

    let b = Math.max(-1, Math.min(1, Number(result.bias) || 0));
    state = { bias: b, label: labelFromBias(b), rationale: String(result.rationale || "").slice(0, 200), ts: now, source: "groq" };
    logger.info(`📰 Sentiment notícias: ${state.label} (bias ${b >= 0 ? "+" : ""}${b.toFixed(2)}) — ${state.rationale}`);
  } catch (e) {
    if (e.status === 429) {
      const m = /try again in ([\d.]+)s/i.exec(e.message);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 5000 : 30 * 60 * 1000;
      rateLimitedUntil = Date.now() + waitMs;
      logger.warn(`Sentiment notícias: Groq rate-limit — pausa ~${Math.round(waitMs/60000)}min`);
    } else {
      logger.warn(`Sentiment notícias falhou: ${e.message}`);
    }
  }
  return state;
}

// ── Fatores de exposição derivados do viés ────────────────────────────────────
// Devolve multiplicadores em torno de 1.0, limitados por MAX_TILT. Estes
// COMBINAM-se (multiplicam) com os do regime técnico — não os substituem.
//   bias +1 → posicoes/valor até (1 + MAX_TILT);  confExtra negativo (afrouxa)
//   bias -1 → posicoes/valor até (1 - MAX_TILT);  confExtra positivo (aperta)
// O caller decide se aplica (só quando regimeDinamico/newsTilt estiverem ligados).
function fatores() {
  const tilt = state.bias * MAX_TILT;          // ∈ [-MAX_TILT, +MAX_TILT]
  return {
    posicoes: +(1 + tilt).toFixed(3),          // >1 só afrouxa até ao TETO do user (o caller faz clamp)
    valor:    +(1 + tilt).toFixed(3),
    confExtra: Math.round(-state.bias * 6),    // bias negativo → +confiança exigida; positivo → -exige
    bias: state.bias, label: state.label,
  };
}

function getState() { return { ...state }; }
function setRefreshMinutes(min) {
  const m = Number(min);
  if (m >= 5 && m <= 120) refreshMin = m;
}

module.exports = { refresh, fatores, getState, setRefreshMinutes };
