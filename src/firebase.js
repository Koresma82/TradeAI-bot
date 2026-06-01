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

module.exports = {
  initFirebase,
  watchStrategies,
  saveTrade,
  updateTrade,
  saveSetting,
  saveStats,
  getBalance,
  saveBalance,
  logError,
  USER_UID,
};
