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
  const mode = (process.env.MODE || "sim").toLowerCase();
  const wantMode = (mode === "paper" || mode === "real") ? "live" : "sim";
  const snap = await userCol("trades").where("status", "==", "ABERTA").get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => t.mode === wantMode);
}

// ── Actualizar trade (fechar posição) ────────────────────────────────────────
async function updateTrade(uid, id, updates) {
  await userDoc("trades", id).set({
    ...updates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ── Fila de comandos (app → bot) ─────────────────────────────────────────────
// A app escreve a intenção do utilizador (comprar/vender manualmente) na coleção
// "commands"; o bot lê os pendentes, executa na corretora e marca como feitos.
// Isto mantém o bot como ÚNICA autoridade de execução — a app nunca negoceia.
async function fetchPendingCommands() {
  const snap = await userCol("commands").where("status", "==", "PENDENTE").get();
  return snap.docs
    .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
    .sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0)); // mais antigo primeiro
}
async function markCommand(id, status, result) {
  await userDoc("commands", id).set({
    status,
    result: result || null,
    processedTs: Date.now(),
    processedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ── Actualizar setting (P&L ao vivo, saldo, etc.) ────────────────────────────
async function saveSetting(uid, key, value) {
  await userDoc("settings", key).set({
    value,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Guardar snapshot de stats diárias ────────────────────────────────────────
// Apaga um trade (ex.: pré-registo PENDING cuja ordem falhou — não poluir histórico).
async function deleteTrade(uid, id) {
  await userCol("trades").doc(id).delete();
}

async function saveStats(uid, stats) {
  const day = new Date().toISOString().split("T")[0];
  await userDoc("stats", day).set({
    ...stats,
    savedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`Stats do dia ${day} guardadas`);
}

// ── Log de eventos para a app (tab Mensagens) ───────────────────────────────
// Acrescenta um evento ao documento do DIA (logs/{data}) via arrayUnion — uma
// escrita pequena por evento, não um documento por evento. A app lê os últimos
// dias e mostra-os. Mantém só 3 dias (apaga os mais antigos quando vira o dia).
const _lastLogCleanup = { day: "" };
async function appendLog(uid, entry) {
  try {
    const day = new Date().toISOString().split("T")[0];
    const item = {
      ts: Date.now(),
      level: entry.level || "info",   // "info" | "buy" | "sell" | "warn" | "error"
      msg: String(entry.msg || "").slice(0, 300),
    };
    await userDoc("logs", day).set(
      { items: admin.firestore.FieldValue.arrayUnion(item), day },
      { merge: true }
    );
    // Auto-limpeza: 1x por dia, apaga documentos de logs com mais de 3 dias.
    if (_lastLogCleanup.day !== day) {
      _lastLogCleanup.day = day;
      const corte = new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0];
      const snap = await userCol("logs").get();
      const batch = db.batch();
      let n = 0;
      snap.docs.forEach(d => { if (d.id < corte) { batch.delete(d.ref); n++; } });
      if (n) await batch.commit();
    }
  } catch { /* logs não devem partir o tick */ }
}

// ── Ler saldo actual guardado ─────────────────────────────────────────────────
async function getBalance(uid) {
  const mode = (process.env.MODE || "sim").toLowerCase();
  const key  = (mode === "paper" || mode === "real") ? "liveBalance" : "simBalance";
  const snap = await userDoc("settings", key).get();
  return snap.exists ? snap.data().value : null;
}

// ── Actualizar saldo ──────────────────────────────────────────────────────────
let _lastBalanceWritten = null;
async function saveBalance(uid, value) {
  // Escreve na chave conforme o modo: simBalance (sim) ou liveBalance (paper/real).
  // Otimização Firestore: só reescreve se o saldo MUDOU. Várias operações por tick
  // chamam saveBalance com o mesmo valor — evitar isso poupa escritas (free tier).
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  if (_lastBalanceWritten === rounded) return;
  _lastBalanceWritten = rounded;
  const mode = (process.env.MODE || "sim").toLowerCase();
  const key  = (mode === "paper" || mode === "real") ? "liveBalance" : "simBalance";
  await userDoc("settings", key).set({
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

// ── Publicar a lista de ativos negociáveis (sync app↔bot) ──────────────────
// O bot é a fonte de verdade: só publica ativos que consegue mesmo negociar
// (têm fonte de preço). A app lê isto para só deixar criar estratégias válidas.
async function publishTradeableAssets(assets) {
  await userDoc("settings", "tradeableAssets").set({
    value: assets,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Vigiar trades abertos (apanha compras MANUAIS feitas na app em tempo real) ──
// O bot só carregava posições no arranque; sem isto, uma compra manual na app
// só seria gerida (SL/TP) após um restart. Agora o bot apanha-as logo.
function watchOpenTrades(callback) {
  const mode = (process.env.MODE || "sim").toLowerCase();
  const wantMode = (mode === "paper" || mode === "real") ? "live" : "sim";
  return userCol("trades")
    .where("status", "==", "ABERTA")
    .onSnapshot(snap => {
      const abertas = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.mode === wantMode);
      callback(abertas);
    }, err => logger.error(`watchOpenTrades erro: ${err.message}`));
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

// ── Data "civil" no fuso de Lisboa (YYYY-MM-DD) ──────────────────────────────
// Usamos sempre o fuso de Portugal para decidir a que dia pertence um trade,
// independentemente de o servidor (Railway) correr em UTC.
function lisbonDayString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function lisbonYesterdayString(ref = new Date()) {
  return lisbonDayString(new Date(ref.getTime() - 86400000));
}

// ── Último dia já arquivado ───────────────────────────────────────────────────
async function getLastArchivedDay() {
  const snap = await userCol("archives").get();
  if (snap.empty) return null;
  const days = snap.docs.map(d => d.id).filter(id => /^\d{4}-\d{2}-\d{2}$/.test(id));
  if (!days.length) return null;
  days.sort();
  return days[days.length - 1];
}

// ── Arquivar trades fechados do dia ──────────────────────────────────────────
// Move os trades FECHADOS pertencentes a `day` (fuso Lisboa) para
// users/{uid}/archives/{day} e remove-os da coleção "trades" ativa.
// As posições ABERTAS ficam intactas. Idempotente: se o arquivo do dia já
// existir, não duplica. `day` por defeito = ontem.
// Devolve um resumo { day, count, pnl, winRate, ... } ou null se não houver nada.
async function archiveClosedTrades(dateStr) {
  const day = dateStr || lisbonYesterdayString();

  // Idempotência: não re-arquivar um dia já arquivado.
  const existing = await userCol("archives").doc(day).get();
  if (existing.exists) {
    logger.info(`Arquivo ${day}: já existe — ignorado (idempotente)`);
    return null;
  }

  // Ler trades fechados (status != ABERTA) — qualquer modo (sim/paper/live)
  const snap = await userCol("trades").where("status", "!=", "ABERTA").get();
  const todasFechadas = snap.docs.map(d => ({ _ref: d.ref, id: d.id, ...d.data() }));

  if (!todasFechadas.length) {
    logger.info(`Arquivo ${day}: nenhum trade fechado para arquivar`);
    return null;
  }

  // Filtrar só os que fecharam NESTE dia (fuso Lisboa). Trades antigos sem
  // closedTs (legado) só entram quando arquivamos o dia de ontem no fluxo
  // normal, para não ficarem presos na coleção ativa indefinidamente.
  const ontem = lisbonYesterdayString();
  const fechadas = todasFechadas.filter(t => {
    if (typeof t.closedTs === "number") return lisbonDayString(new Date(t.closedTs)) === day;
    return day === ontem; // legado
  });

  if (!fechadas.length) {
    logger.info(`Arquivo ${day}: nenhum trade fechado neste dia`);
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

// ── Catch-up de arquivos perdidos (chamado no arranque) ──────────────────────
// Resolve o "dia perdido": se o bot esteve em baixo / reiniciou na meia-noite,
// o cron desse dia não correu. No arranque, percorre do dia seguinte ao último
// arquivo até ontem e arquiva cada dia em falta. Idempotente.
async function catchUpArchives() {
  try {
    const ontem = lisbonYesterdayString();
    const last  = await getLastArchivedDay();

    let cursor;
    if (last) {
      const d = new Date(`${last}T12:00:00Z`); // meio-dia evita saltos de DST
      d.setUTCDate(d.getUTCDate() + 1);
      cursor = lisbonDayString(d);
    } else {
      cursor = ontem; // sem histórico: só tenta recuperar ontem
    }

    if (cursor > ontem) {
      logger.info("Catch-up de arquivo: nada em falta ✓");
      return [];
    }

    const recuperados = [];
    let guard = 0;
    while (cursor <= ontem && guard < 60) {
      guard++;
      const r = await archiveClosedTrades(cursor);
      if (r) recuperados.push(r);
      const d = new Date(`${cursor}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      cursor = lisbonDayString(d);
    }

    if (recuperados.length) {
      const dias = recuperados.map(r => `${r.day} (${r.count})`).join(", ");
      logger.info(`📁 Catch-up: recuperados ${recuperados.length} dia(s) — ${dias}`);
    } else {
      logger.info("Catch-up de arquivo: nada para recuperar ✓");
    }
    return recuperados;
  } catch (err) {
    logger.error(`Catch-up de arquivo falhou: ${err.message}`);
    await logError("catch-up-archive", err).catch(() => {});
    return [];
  }
}

// ── Rollover robusto por tick ────────────────────────────────────────────────
// Em vez de depender só do cron da meia-noite (que falha se o bot estiver em
// baixo nesse minuto), verificamos a cada tick se o dia mudou. O último dia
// processado é guardado no Firestore (sobrevive a reinícios). Quando o dia muda,
// arquiva todos os dias em falta entre o último processado e ontem. Barato:
// normalmente só lê 1 doc e compara strings; só arquiva quando o dia vira.
let _rolloverMemoDay = "";
async function checkDayRollover() {
  try {
    const hoje = lisbonDayString();
    // Cache em memória: na esmagadora maioria dos ticks o dia não mudou.
    if (_rolloverMemoDay === hoje) return null;

    const ref = userDoc("settings", "lastProcessedDay");
    const snap = await ref.get();
    const ultimo = snap.exists ? snap.data().value : null;

    if (ultimo === hoje) { _rolloverMemoDay = hoje; return null; }

    // O dia mudou (ou primeiro arranque). Arquiva os dias em falta até ontem.
    const recuperados = await catchUpArchives();

    // Marca hoje como processado para não repetir.
    await ref.set({ value: hoje, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    _rolloverMemoDay = hoje;

    if (recuperados && recuperados.length) {
      logger.info(`🌙 Rollover de dia: arquivados ${recuperados.length} dia(s)`);
    }
    return recuperados;
  } catch (err) {
    logger.error(`Rollover de dia falhou: ${err.message}`);
    return null;
  }
}

module.exports = {
  initFirebase,
  appendLog,
  deleteTrade,
  checkDayRollover,
  watchStrategies,
  saveTrade,
  loadOpenPositions,
  watchOpenTrades,
  publishTradeableAssets,
  updateTrade,
  saveSetting,
  saveStats,
  getBalance,
  saveBalance,
  logError,
  getSetting,
  watchSetting,
  archiveClosedTrades,
  getLastArchivedDay,
  catchUpArchives,
  fetchPendingCommands,
  markCommand,
  lisbonDayString,
  USER_UID,
};
