// src/firebase.js
// Lê estratégias e escreve trades/stats no Firestore
// Dados partilhados com a app React em: users/{uid}/...

const admin  = require("firebase-admin");
const path   = require("path");
const fs     = require("fs");
const logger = require("./logger");

let db;

// O UID do utilizador autorizado (mesmo da app React).
// Definido via env USER_UID — obtém-se na app (DevTools → Application → IndexedDB → firebase)
// ou usa "server" como fallback partilhado.
const USER_UID = process.env.USER_UID || "server";

function initFirebase() {
  let serviceAccount;

  // ── DIAGNÓSTICO ──
  const raw = process.env.FIREBASE_ADMIN_JSON;
  logger.info(`[DIAG] FIREBASE_ADMIN_JSON existe? ${raw ? "SIM" : "NÃO"}`);
  logger.info(`[DIAG] Comprimento: ${raw ? raw.length : 0} caracteres`);
  if (raw) logger.info(`[DIAG] Começa com: ${raw.slice(0, 30)}`);
  logger.info(`[DIAG] Todas as env keys: ${Object.keys(process.env).filter(k => k.includes("FIREBASE") || k.includes("MODE") || k.includes("USER") || k.includes("SIM") || k.includes("GROQ")).join(", ")}`);

  // Opção 1: credencial via variável de ambiente (Railway/Hetzner)
  if (process.env.FIREBASE_ADMIN_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
      logger.info("Firebase: credencial lida de FIREBASE_ADMIN_JSON ✓");
    } catch (e) {
      throw new Error("FIREBASE_ADMIN_JSON inválido — verifica que colaste o JSON completo");
    }
  }
  // Opção 2: ficheiro local (desenvolvimento)
  else {
    const filePath = path.join(__dirname, "../config/firebase-admin.json");
    if (fs.existsSync(filePath)) {
      serviceAccount = require(filePath);
      logger.info("Firebase: credencial lida de config/firebase-admin.json ✓");
    } else {
      throw new Error("Sem credencial Firebase — define FIREBASE_ADMIN_JSON ou coloca config/firebase-admin.json");
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  process.env.FIREBASE_PROJECT_ID || "tradeaisimulator-aebcd",
  });
  db = admin.firestore();
  logger.info(`Firebase Admin inicializado ✓ (uid: ${USER_UID})`);
  if (!process.env.USER_UID) {
    logger.warn("⚠ USER_UID NÃO definido — o bot escreve em users/server.");
    logger.warn("⚠ A tua app lê no teu UID de login. Define USER_UID (Definições → Copiar UID na app)");
    logger.warn("⚠ senão NÃO vais ver os trades do bot na app!");
  }
}

// Helpers para caminhos sob users/{uid}/...
const userCol = (col) => db.collection("users").doc(USER_UID).collection(col);
const userDoc = (col, id) => userCol(col).doc(id);

// ── Subscrever estratégias activas ────────────────────────────────────────────
function watchStrategies(callback) {
  return userCol("strategies")
    .where("ativo", "==", true)
    .onSnapshot(snap => {
      const strats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      logger.info(`Estratégias activas: ${strats.length}`);
      callback(strats);
    }, err => logger.error(`watchStrategies erro: ${err.message}`));
}

// ── Guardar trade ─────────────────────────────────────────────────────────────
async function saveTrade(uid, trade) {
  await userDoc("trades", trade.id).set({
    ...trade,
    savedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Carregar posições ABERTAS do Firestore (recuperar após restart) ──────────
// Sem isto, um restart do bot esquece as posições abertas e deixa-as órfãs
// (sem stop-loss / take-profit a serem aplicados).
async function loadOpenPositions(uid) {
  const snap = await userCol("trades").where("status", "==", "ABERTA").get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => t.mode === "sim");
}

// ── Actualizar trade (fechar posição) ────────────────────────────────────────
async function updateTrade(uid, id, updates) {
  await userDoc("trades", id).set({
    ...updates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ── Guardar setting (P&L ao vivo, saldo, etc.) ───────────────────────────────
async function saveSetting(uid, key, value) {
  await userDoc("settings", key).set({
    value,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Guardar snapshot de stats diárias ────────────────────────────────────────
async function saveStats(uid, stats) {
  const day = new Date().toISOString().split("T")[0];
  await userDoc("stats", day).set({
    ...stats,
    savedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`Stats do dia ${day} guardadas`);
}

// ── Ler saldo actual guardado ─────────────────────────────────────────────────
async function getBalance(uid) {
  const snap = await userDoc("settings", "simBalance").get();
  return snap.exists ? snap.data().value : null;
}

// ── Actualizar saldo ──────────────────────────────────────────────────────────
async function saveBalance(uid, value) {
  await userDoc("settings", "simBalance").set({
    value,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Ler uma definição (settings da app) ───────────────────────────────────────
async function getSetting(uid, key) {
  try {
    const snap = await userDoc("settings", key).get();
    return snap.exists ? snap.data().value : null;
  } catch { return null; }
}

// ── Subscrever definições em tempo real ──────────────────────────────────────
function watchSetting(key, callback) {
  return userDoc("settings", key).onSnapshot(snap => {
    if (snap.exists) callback(snap.data().value);
  }, () => {});
}

// ── Guardar log de erro ───────────────────────────────────────────────────────
async function logError(context, error) {
  try {
    await userCol("errors").add({
      context,
      message: error?.message || String(error),
      stack:   error?.stack   || "",
      ts:      admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { /* silencioso */ }
}

// ── Arquivar trades fechados do dia ──────────────────────────────────────────
// Move todos os trades já FECHADOS para users/{uid}/archives/{dia} e remove-os
// da coleção "trades" ativa. Mantém as posições ABERTAS intactas.
// Devolve um resumo { dia, count, pnl, winRate } ou null se não houver nada.
async function archiveClosedTrades(dateStr) {
  // dia a arquivar: por defeito ontem (corre à meia-noite a fechar o dia anterior)
  const day = dateStr || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  })();

  // Ler trades fechados (status != ABERTA) — qualquer modo (sim/paper/live)
  const snap = await userCol("trades").where("status", "!=", "ABERTA").get();
  const fechadas = snap.docs
    .map(d => ({ _ref: d.ref, id: d.id, ...d.data() }));

  if (!fechadas.length) {
    logger.info(`Arquivo ${day}: nenhum trade fechado para arquivar`);
    return null;
  }

  const limpos = fechadas.map(({ _ref, ...t }) => t); // sem a referência interna
  const pnl     = +limpos.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2);
  const wins    = limpos.filter(t => (t.pnl || 0) > 0).length;
  const winRate = limpos.length ? +(wins / limpos.length * 100).toFixed(1) : 0;

  // Breakdown por origem (AI Brain, estratégias, day trading, manual)
  const origemDe = (t) =>
      t.stratId === "ai-brain"   ? "AI Brain"
    : t.stratId === "daytrading" ? "Day Trading"
    : t.stratId === "manual"     ? "Manual"
    :                              "Estratégias";
  const porOrigem = {};
  limpos.forEach(t => {
    const o = origemDe(t);
    if (!porOrigem[o]) porOrigem[o] = { n: 0, wins: 0, pnl: 0 };
    porOrigem[o].n++;
    if ((t.pnl || 0) > 0) porOrigem[o].wins++;
    porOrigem[o].pnl = +(porOrigem[o].pnl + (t.pnl || 0)).toFixed(2);
  });

  // 1. Gravar o documento de arquivo do dia
  await userCol("archives").doc(day).set({
    day,
    trades:   limpos,
    count:    limpos.length,
    pnl,
    winRate,
    wins,
    porOrigem,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 2. Apagar os trades fechados da coleção ativa (em lotes de 400)
  const refs = fechadas.map(t => t._ref);
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach(r => batch.delete(r));
    await batch.commit();
  }

  logger.info(`📁 Arquivo ${day}: ${limpos.length} trades movidos · P&L ${pnl >= 0 ? "+" : "−"}€${Math.abs(pnl)} · WR ${winRate}%`);
  return { day, count: limpos.length, pnl, winRate, wins, porOrigem };
}

module.exports = {
  initFirebase,
  watchStrategies,
  saveTrade,
  loadOpenPositions,
  updateTrade,
  saveSetting,
  saveStats,
  getBalance,
  saveBalance,
  logError,
  getSetting,
  watchSetting,
  archiveClosedTrades,
  USER_UID,
};
