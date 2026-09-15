// ══════════════════════════════════════════════════════════════
// Cache de respostas no navegador (Plano A).
//
// Os dados da dashboard só mudam quando o sync publica. Então cada resposta (tabela ou RPC)
// é guardada com uma ETIQUETA = versão do site + usuário + versão da publicação
// (sync_info.versao_dados). Enquanto a etiqueta é a mesma, a resposta guardada é idêntica à
// que o banco daria — e o banco não precisa refazer a conta. Mudou a etiqueta → busca de novo.
//
// Travas contra dado velho:
//  1. A versão da publicação muda a CADA tabela gravada pelo sync (não só quando ele termina),
//     então sync parcial, --tabela e sync manual invalidam o cache.
//  2. RPCs entram na chave com os parâmetros reais (datas do período, filas) — nunca pelo nome
//     do atalho ("Hoje"). A virada do dia muda as datas e, portanto, a chave.
//  3. A versão do site (?v= do script) entra na etiqueta — todo deploy invalida.
// Na dúvida, busca ao vivo: sem sessão, sem versão ou IndexedDB com problema = comportamento
// de antes do cache. Nunca cai em dado velho.
//
// Sem dependências (nem DOM, nem supabase) para poder ser testado isoladamente.
// ══════════════════════════════════════════════════════════════

const CacheRespostas = (() => {
  const clonar = (v) => (v === undefined ? undefined
    : typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  // obterVersao() → {usuario, token} (pode lançar). armazem = armazemIndexedDB() | armazemMemoria().
  function criar({ obterVersao, armazem, appV, ligado = true }) {
    const memoria = new Map();   // chave → dados (cópia própria; quem recebe ganha outra cópia)
    const emVoo = new Map();     // chave → Promise (duas telas pedindo o mesmo = 1 busca só)
    let etiquetaAtual = null;
    const contagem = { guardadas: 0, buscadas: 0, aoVivo: 0 };

    async function obter(nome, params, buscar) {
      if (!ligado) { contagem.aoVivo++; return buscar(); }
      let v;
      try { v = await obterVersao(); } catch (e) { contagem.aoVivo++; return buscar(); }
      if (!v || !v.token || !v.usuario) { contagem.aoVivo++; return buscar(); }

      const etiqueta = `${appV}|${v.usuario}|${v.token}`;
      if (etiquetaAtual !== etiqueta) {   // publicação nova, outro usuário ou deploy novo
        etiquetaAtual = etiqueta;
        memoria.clear();
        armazem.podar(etiqueta).catch(() => {});   // apaga do disco o que for de outra etiqueta
      }
      const chave = `${etiqueta}|${nome}|${JSON.stringify(params === undefined ? null : params)}`;

      if (memoria.has(chave)) { contagem.guardadas++; return clonar(memoria.get(chave)); }
      if (emVoo.has(chave)) return clonar(await emVoo.get(chave));

      const promessa = (async () => {
        const salvo = await armazem.ler(chave).catch(() => undefined);
        if (salvo && salvo.chave === chave) {
          contagem.guardadas++;
          memoria.set(chave, salvo.dados);
          return salvo.dados;
        }
        contagem.buscadas++;
        const dados = await buscar();   // erro sobe e NADA é guardado
        const copia = clonar(dados);
        if (etiqueta === etiquetaAtual) {   // a etiqueta pode ter mudado durante a busca
          memoria.set(chave, copia);
          armazem.gravar(chave, { chave, etiqueta, dados: copia, ts: Date.now() }).catch(() => {});
        }
        return copia;
      })();
      emVoo.set(chave, promessa);
      try {
        return clonar(await promessa);
      } finally {
        emVoo.delete(chave);
      }
    }

    async function limpar() {
      memoria.clear();
      emVoo.clear();
      etiquetaAtual = null;
      await armazem.limpar().catch(() => {});
    }

    return { obter, limpar, estado: () => ({ ligado, etiqueta: etiquetaAtual, ...contagem }) };
  }

  // IndexedDB (sobrevive a F5 e a fechar o navegador). Qualquer erro ou lentidão vira
  // "não achei" para quem chamou — o cache nunca pode travar a dashboard.
  function armazemIndexedDB(nomeDb = "cplug-cache", prazoMs = 1500) {
    const LOJA = "respostas";
    let abrindo = null;
    function abrir() {
      if (!abrindo) {
        abrindo = new Promise((ok, falha) => {
          const req = indexedDB.open(nomeDb, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(LOJA);
          req.onsuccess = () => ok(req.result);
          req.onerror = () => falha(req.error);
          req.onblocked = () => falha(new Error("IndexedDB bloqueado"));
        });
        abrindo.catch(() => { abrindo = null; });   // deixa tentar de novo na próxima
      }
      return abrindo;
    }
    const comPrazo = (p) => Promise.race([p, new Promise((_, falha) =>
      setTimeout(() => falha(new Error("IndexedDB lento")), prazoMs))]);
    async function transacao(modo, fazer) {
      const db = await comPrazo(abrir());
      return comPrazo(new Promise((ok, falha) => {
        const t = db.transaction(LOJA, modo);
        const req = fazer(t.objectStore(LOJA));
        t.oncomplete = () => ok(req ? req.result : undefined);
        t.onerror = () => falha(t.error);
        t.onabort = () => falha(t.error);
      }));
    }
    return {
      ler: (chave) => transacao("readonly", (s) => s.get(chave)),
      gravar: (chave, valor) => transacao("readwrite", (s) => s.put(valor, chave)),
      limpar: () => transacao("readwrite", (s) => s.clear()),
      podar: (etiqueta) => transacao("readwrite", (s) => {
        const cursor = s.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          if (!c.value || c.value.etiqueta !== etiqueta) c.delete();
          c.continue();
        };
        return null;
      }),
    };
  }

  // Mesmo contrato, em memória — usado nos testes (e se um dia o IndexedDB faltar).
  function armazemMemoria() {
    const m = new Map();
    return {
      ler: async (k) => clonar(m.get(k)),
      gravar: async (k, v) => { m.set(k, clonar(v)); },
      limpar: async () => { m.clear(); },
      podar: async (etiqueta) => { for (const [k, v] of m) if (v.etiqueta !== etiqueta) m.delete(k); },
      tamanho: () => m.size,
    };
  }

  return { criar, armazemIndexedDB, armazemMemoria };
})();
