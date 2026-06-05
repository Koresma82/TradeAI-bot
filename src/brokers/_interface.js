// src/brokers/_interface.js
// ─────────────────────────────────────────────────────────────────────────────
// CONTRATO DE UM ADAPTADOR DE BROKER
// ─────────────────────────────────────────────────────────────────────────────
// Cada broker (Alpaca, Binance, IBKR, …) é um ficheiro nesta pasta que exporta
// um objeto com EXATAMENTE esta forma. O router (broker.js) só conhece este
// contrato — não sabe nada de específico de cada corretora. Para acrescentar um
// broker novo: cria um ficheiro aqui que cumpra este contrato e regista-o em
// registry.js. Para remover: tira-o do registry. Para trocar: muda o routing no
// .env. NADA no motor (sim-engine.js) precisa de mudar.
//
// Um adaptador exporta:
//
//   id            string   — identificador curto, ex.: "alpaca", "binance"
//   name          string   — nome legível, ex.: "Alpaca Markets"
//   assetClasses  string[] — classes que cobre: "crypto","etf","stock","forex","commodity"
//
//   supports(assetId)            → boolean
//       Diz se este broker consegue negociar este ativo. O router usa isto para
//       só encaminhar ativos suportados.
//
//   isConnected()                → boolean
//       Há credenciais configuradas? (não faz chamada de rede)
//
//   async verifyConnection()     → { ok, name, detail? }
//       Liga-se e confirma que as credenciais funcionam. Lança erro se falhar.
//
//   async getBalance()           → number | null
//       Dinheiro disponível na conta (na moeda da conta). null se não aplicável.
//
//   async buy({ assetId, amount, price, sl, tp })
//       → { ok, fillPrice, brokerOrderId, simulated? }  ou  { ok:false, reason }
//       amount = quanto investir (na moeda base); price = preço de referência.
//
//   async sell({ assetId, units, price })
//       → { ok, fillPrice, simulated? }  ou  { ok:false, reason }
//
// Notas:
// - Se um broker não suporta SL/TP nativo (ex.: crypto spot), ignora sl/tp — o
//   motor já gere SL/TP internamente.
// - Os adaptadores NÃO decidem o modo (sim/paper/real); recebem isso do router.
//   Em modo "sim" o router nem chama o adaptador (resolve localmente).

module.exports = {}; // ficheiro só de documentação
