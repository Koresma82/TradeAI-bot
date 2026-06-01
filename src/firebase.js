// src/firebase.js
// Lê estratégias e escreve trades/stats no Firestore

const admin  = require("firebase-admin");
const path   = require("path");
const logger = require("./logger");

let db;

function initFirebase() {
  const serviceAccount = require(path.join(__dirname, "../config/firebase-admin.json"));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  process.env.FIREBASE_PROJECT_ID || "tradeaisimulator-aebcd",
  });
  db = admin.firestore();
  logger.info("Firebase Admin inicializado ✓");
}

// ── Ler estratégias activas ───────────────────────────────────────────────────
async function getActiveStrategies() {
  const snap = await db
    .collection("strategies")
    .where("ativo", "==", true)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Subscrever estratégias (live updates) ────────────────────────────────────
function watchStrategies(callback) {
  return db
    .collection("strategies")
    .where("ativo", "==", true)
    .onSnapshot(snap => {
      const strats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      logger.info(`Estratégias activas: ${strats.length}`);
      callback(strats);
    });
}

// ── Guardar trade ─────────────────────────────────────────────────────────────
async function saveTrade(trade) {
  await db.collection("trades").doc(trade.id).set({
    ...trade,
    savedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Actualizar trade (fechar posição) ────────────────────────────────────────
async function updateTrade(id, updates) {
  await db.collection("trades").doc(id).update({
    ...updates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Guardar snapshot de stats diárias ────────────────────────────────────────
async function saveStats(stats) {
  const day = new Date().toISOString().split("T")[0];
  await db.collection("stats").doc(day).set({
    ...stats,
    savedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`Stats do dia ${day} guardadas`);
}

// ── Ler saldo actual guardado ─────────────────────────────────────────────────
async function getBalance() {
  const snap = await db.collection("settings").doc("balance").get();
  return snap.exists ? snap.data().value : null;
}

// ── Actualizar saldo ──────────────────────────────────────────────────────────
async function saveBalance(value) {
  await db.collection("settings").doc("balance").set({
    value,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Guardar log de erro ───────────────────────────────────────────────────────
async function logError(context, error) {
  await db.collection("errors").add({
    context,
    message: error?.message || String(error),
    stack:   error?.stack   || "",
    ts:      admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  initFirebase,
  watchStrategies,
  getActiveStrategies,
  saveTrade,
  updateTrade,
  saveStats,
  getBalance,
  saveBalance,
  logError,
};
