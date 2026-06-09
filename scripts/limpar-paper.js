#!/usr/bin/env node
/**
 * limpar-paper.js — Limpeza segura dos trades de PAPER/LIVE no Firestore.
 *
 * Porque existe: quando se passa de simulação para paper, os trades de paper
 * ficam na coleção "trades" com mode === "live". Este script apaga SÓ esses,
 * deixando intactos: as estratégias, as definições, e os trades de simulação.
 *
 * SEGURANÇA:
 *  - Por defeito corre em DRY-RUN (só mostra o que apagaria, NÃO apaga nada).
 *  - Para apagar mesmo, corre com  --apagar
 *  - Apaga apenas documentos com mode === "live" (paper/real). NUNCA toca em
 *    mode === "sim" nem em strategies/settings.
 *
 * IMPORTANTE: isto limpa os REGISTOS no Firestore, não as posições na corretora.
 * Se tiveres posições abertas na Alpaca paper, fecha-as primeiro no dashboard da
 * Alpaca (ou deixa o bot reconciliar) — senão a reconciliação vai avisar que a
 * corretora tem posições que o bot não conhece.
 *
 * Pré-requisitos (as MESMAS variáveis que o bot já usa):
 *   FIREBASE_ADMIN_JSON  → o JSON da service account (string)
 *   USER_UID             → o teu UID
 *
 * Uso:
 *   # pré-visualizar (não apaga):
 *   node scripts/limpar-paper.js
 *   # apagar mesmo:
 *   node scripts/limpar-paper.js --apagar
 *   # apagar também o arquivo diário de live (raro):
 *   node scripts/limpar-paper.js --apagar --com-arquivo
 */

const admin = require("firebase-admin");

const APAGAR      = process.argv.includes("--apagar");
const COM_ARQUIVO = process.argv.includes("--com-arquivo");
const USER_UID    = process.env.USER_UID;

function fail(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

if (!process.env.FIREBASE_ADMIN_JSON) fail("Falta FIREBASE_ADMIN_JSON (a mesma do bot).");
if (!USER_UID) fail("Falta USER_UID (o teu UID).");

let serviceAccount;
try { serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON); }
catch { fail("FIREBASE_ADMIN_JSON inválido — cola o JSON completo."); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const userCol = (col) => db.collection("users").doc(USER_UID).collection(col);

async function main() {
  console.log(`\n${APAGAR ? "🗑  MODO APAGAR" : "👀 MODO PRÉ-VISUALIZAÇÃO (não apaga nada)"} · UID: ${USER_UID}\n`);

  // 1) Trades de paper/live (mode === "live")
  const snap = await userCol("trades").get();
  const todos = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  const live  = todos.filter(t => t.mode === "live");
  const sim   = todos.filter(t => t.mode === "sim");

  console.log(`Trades na coleção: ${todos.length} (sim: ${sim.length} · live/paper: ${live.length})`);
  const abertas = live.filter(t => t.status === "ABERTA").length;
  console.log(`  └ live/paper abertas: ${abertas} · fechadas: ${live.length - abertas}`);

  if (!live.length) { console.log("\n✓ Não há trades de paper/live para limpar.\n"); }
  else if (!APAGAR) {
    console.log("\n(Pré-visualização) Seriam apagados estes trades de paper/live:");
    live.slice(0, 10).forEach(t => console.log(`  • ${t.assetSym || t.assetId} · ${t.status} · €${t.amount} · ${t.openedAt || ""}`));
    if (live.length > 10) console.log(`  … e mais ${live.length - 10}.`);
    console.log("\n→ Para apagar mesmo: node scripts/limpar-paper.js --apagar\n");
  } else {
    let n = 0;
    // Apaga em lotes (Firestore: máx 500 por batch)
    for (let i = 0; i < live.length; i += 450) {
      const batch = db.batch();
      live.slice(i, i + 450).forEach(t => { batch.delete(t.ref); n++; });
      await batch.commit();
    }
    console.log(`\n✓ Apagados ${n} trades de paper/live.`);
  }

  // 2) (Opcional) arquivo diário de dias só-live. Por defeito NÃO mexe, porque
  //    os arquivos diários costumam misturar dados; só se pedires --com-arquivo.
  if (COM_ARQUIVO && APAGAR) {
    const arq = await userCol("archives").get();
    let n = 0;
    for (const doc of arq.docs) {
      // só apaga arquivos cujos trades sejam todos live (raro); por segurança,
      // aqui apenas listamos — apagar arquivos é destrutivo e normalmente não é preciso.
      console.log(`  (arquivo ${doc.id} mantido — apagar arquivos não é recomendado)`);
    }
  }

  // 3) Saldo live: NÃO mexemos. O saldo de paper vem da Alpaca no arranque do bot.
  console.log("\nNota: o saldo de paper é lido da Alpaca pelo bot — não é preciso repor aqui.");
  console.log("Nota: estratégias e definições ficaram INTACTAS.\n");

  process.exit(0);
}

main().catch(e => fail(e.message));
