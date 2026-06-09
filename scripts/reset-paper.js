#!/usr/bin/env node
/**
 * reset-paper.js — Recomeço LIMPO do paper trading.
 *
 * Faz as DUAS coisas que um recomeço limpo precisa:
 *   1) Fecha TODAS as posições abertas na Alpaca (paper) → volta a 100% cash.
 *   2) Apaga os registos de trades live/paper no Firestore (mode === "live").
 *
 * Deixa INTACTOS: estratégias, definições e trades de simulação (mode === "sim").
 *
 * SEGURANÇA:
 *   - Por defeito corre em DRY-RUN: mostra o que faria, NÃO altera nada.
 *   - Para executar mesmo:  node scripts/reset-paper.js --executar
 *   - Recusa correr se MODE === "real" (proteção contra apagar trading real),
 *     a não ser que forces com --forcar-real (NÃO recomendado).
 *
 * Pré-requisitos (as MESMAS variáveis do bot):
 *   ALPACA_API_KEY, ALPACA_SECRET_KEY   (conta paper)
 *   ALPACA_BASE_URL                      (ou vazio = paper, o default)
 *   FIREBASE_ADMIN_JSON, USER_UID
 *
 * Uso (no Console do Railway):
 *   node scripts/reset-paper.js              # pré-visualiza
 *   node scripts/reset-paper.js --executar   # executa
 */

const EXECUTAR    = process.argv.includes("--executar");
const FORCAR_REAL = process.argv.includes("--forcar-real");
const MODE        = (process.env.MODE || "sim").toLowerCase();
const USER_UID    = process.env.USER_UID;

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Proteção: nunca correr isto em REAL sem forçar explicitamente.
if (MODE === "real" && !FORCAR_REAL) {
  fail("MODE=real detetado. Este script é para PAPER. Se tens MESMO a certeza, usa --forcar-real (perigoso).");
}
if (!USER_UID) fail("Falta USER_UID.");
if (!process.env.FIREBASE_ADMIN_JSON) fail("Falta FIREBASE_ADMIN_JSON.");
if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) fail("Faltam as chaves da Alpaca.");

const BASE_URL   = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const API_KEY    = process.env.ALPACA_API_KEY;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;

async function alpaca(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "APCA-API-KEY-ID": API_KEY,
      "APCA-API-SECRET-KEY": SECRET_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const admin = require("firebase-admin");
let serviceAccount;
try { serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON); }
catch { fail("FIREBASE_ADMIN_JSON inválido."); }
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const userCol = (col) => db.collection("users").doc(USER_UID).collection(col);

async function main() {
  console.log(`\n${EXECUTAR ? "🗑  MODO EXECUTAR" : "👀 PRÉ-VISUALIZAÇÃO (não altera nada)"} · MODE=${MODE} · UID=${USER_UID}`);
  console.log(`Alpaca: ${BASE_URL}\n`);

  // ── 1) Posições reais na Alpaca ──
  const acc = await alpaca("/v2/account");
  console.log(`Conta Alpaca: $${(+acc.portfolio_value).toFixed(2)} | cash $${(+acc.cash).toFixed(2)}`);
  const pos = await alpaca("/v2/positions");
  console.log(`Posições abertas na Alpaca: ${pos.length}`);
  pos.slice(0, 20).forEach(p => console.log(`  • ${p.symbol}: ${p.qty} @ $${(+p.avg_entry_price).toFixed(4)} (mkt $${(+p.market_value).toFixed(2)})`));
  if (pos.length > 20) console.log(`  … e mais ${pos.length - 20}.`);

  if (EXECUTAR && pos.length) {
    console.log("\n→ A fechar TODAS as posições na Alpaca…");
    // Endpoint "close all" da Alpaca: DELETE /v2/positions
    await alpaca("/v2/positions?cancel_orders=true", { method: "DELETE" });
    // Esperar e confirmar que ficou a zero
    await sleep(4000);
    const restantes = await alpaca("/v2/positions");
    if (restantes.length) {
      console.log(`  ⚠ Ainda restam ${restantes.length} (mercado pode estar a processar). Corre de novo daqui a 1 min se preciso.`);
    } else {
      console.log("  ✓ Todas as posições fechadas — conta a 100% cash.");
    }
  }

  // ── 2) Registos de trades live/paper no Firestore ──
  const snap = await userCol("trades").get();
  const todos = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  const live  = todos.filter(t => t.mode === "live");
  const sim   = todos.filter(t => t.mode === "sim");
  console.log(`\nFirestore trades: ${todos.length} (sim: ${sim.length} · live/paper: ${live.length})`);

  if (EXECUTAR && live.length) {
    let n = 0;
    for (let i = 0; i < live.length; i += 450) {
      const batch = db.batch();
      live.slice(i, i + 450).forEach(t => { batch.delete(t.ref); n++; });
      await batch.commit();
    }
    console.log(`  ✓ Apagados ${n} registos de trades live/paper no Firestore.`);
  } else if (!EXECUTAR) {
    console.log(`  (Pré-visualização) Apagaria ${live.length} registos live/paper. Sim e estratégias ficam INTACTOS.`);
  }

  if (!EXECUTAR) {
    console.log("\n→ Para executar mesmo: node scripts/reset-paper.js --executar\n");
  } else {
    console.log("\n✓ Reset concluído. Reinicia o bot — a reconciliação deve dizer 'tudo alinhado'.\n");
  }
  process.exit(0);
}

main().catch(e => fail(e.message));
