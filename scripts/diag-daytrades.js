#!/usr/bin/env node
/**
 * diag-daytrades.js — Diagnóstico: encontra onde estão os day-trades presos.
 *
 * Procura trades em VÁRIOS sítios e mostra onde estão, para percebermos porque
 * o painel "Trades de Hoje" continua a mostrá-los. NÃO apaga nada.
 *
 * USO: node scripts/diag-daytrades.js
 */
const admin = require("firebase-admin");
const fb = require("../src/firebase");

async function main() {
  const USER_UID = process.env.USER_UID;
  fb.initFirebase();
  const db = admin.firestore();

  console.log(`\n🔍 DIAGNÓSTICO · USER_UID do bot = ${USER_UID}\n`);

  // 1) dtState do UID do bot
  const dtRef = db.collection("users").doc(USER_UID).collection("settings").doc("dtState");
  const dtSnap = await dtRef.get();
  if (dtSnap.exists) {
    const dt = dtSnap.data() || {};
    console.log(`[dtState do bot] trades: ${(dt.trades || []).length}`);
    (dt.trades || []).slice(0, 5).forEach(t => console.log(`   · ${t.assetSym || t.assetId} @ ${t.entryPrice} (${t.openedAt})`));
  } else {
    console.log("[dtState do bot] não existe");
  }

  // 2) Procurar TODOS os utilizadores com um dtState (pode haver outro UID)
  console.log("\n🔍 A procurar dtState noutros UIDs...");
  const usersSnap = await db.collection("users").get();
  for (const u of usersSnap.docs) {
    const ref = db.collection("users").doc(u.id).collection("settings").doc("dtState");
    const s = await ref.get();
    if (s.exists) {
      const d = s.data() || {};
      const n = (d.trades || []).length;
      if (n > 0 || u.id !== USER_UID) {
        console.log(`   UID ${u.id}: ${n} day-trade(s) no dtState`);
        (d.trades || []).slice(0, 5).forEach(t => console.log(`      · ${t.assetSym || t.assetId} @ ${t.entryPrice} (${t.openedAt})`));
      }
    }
  }

  // 3) Trades na coleção 'trades' com stratId daytrading e datas antigas
  console.log("\n🔍 Day-trades na coleção 'trades' (do bot)...");
  for (const u of usersSnap.docs) {
    const tradesSnap = await db.collection("users").doc(u.id).collection("trades")
      .where("stratId", "==", "daytrading").get().catch(() => null);
    if (tradesSnap && tradesSnap.size) {
      console.log(`   UID ${u.id}: ${tradesSnap.size} day-trade(s) na coleção 'trades'`);
    }
  }

  // 4) Procurar "Cobre"/"WTI"/"Ethereum" em TODAS as settings (qualquer chave)
  console.log("\n🔍 A procurar 'Cobre/WTI' em TODAS as settings do teu UID...");
  const setSnap = await db.collection("users").doc(USER_UID).collection("settings").get();
  for (const d of setSnap.docs) {
    const raw = JSON.stringify(d.data() || {});
    if (/copper|cobre|WTI|Petróleo|4\.33|98\.27|1651\.21/i.test(raw)) {
      console.log(`   ⚠ ENCONTRADO na setting "${d.id}" (tamanho: ${raw.length} chars)`);
      // mostrar uma amostra
      console.log(`      amostra: ${raw.slice(0, 300)}`);
    }
  }
  console.log("   (se nada acima, os trades NÃO estão em nenhuma setting)");

  console.log("\n✓ Diagnóstico concluído.\n");
  process.exit(0);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
