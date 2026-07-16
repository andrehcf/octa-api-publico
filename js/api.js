// ══════════════════════════════════════════════════════════════
// Acesso ao Supabase (somente leitura, via anon key + RLS).
// Carrega a janela completa de cada tabela agg_* de uma vez —
// o volume é pequeno (~3 mil linhas) e os filtros rodam no cliente.
// ══════════════════════════════════════════════════════════════

const API = (() => {
  const cliente = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const PAGINA = 1000; // teto por request do PostgREST (Supabase) — .limit() não o ultrapassa

  // Carrega TODAS as linhas paginando com .range() (senão tabelas > 1000 linhas,
  // como agg_chats_hora, chegariam cortadas e faltariam os dias mais recentes).
  async function tabela(nome, ordem) {
    const todas = [];
    for (let de = 0; ; de += PAGINA) {
      const { data, error } = await cliente
        .from(nome)
        .select("*")
        .order(ordem, { ascending: true })
        .range(de, de + PAGINA - 1);
      if (error) throw new Error(`${nome}: ${error.message}`);
      todas.push(...(data || []));
      if (!data || data.length < PAGINA) break;
    }
    return todas;
  }

  // Carrega todas as tabelas em paralelo; retorna { nomeLogico: linhas }
  async function carregarTudo() {
    const [
      chatsDia, chatsHora, ticketsDia, ticketsMes, ticketsFormMes, ticketsStatusMes,
      agentesMes, categoriasMes, tmaDistMes, reincMes, syncInfo,
    ] = await Promise.all([
      tabela("agg_chats_dia", "dia"),
      tabela("agg_chats_hora", "dia"),
      tabela("agg_tickets_dia", "dia"),
      tabela("agg_tickets_mes", "mes"),
      tabela("agg_tickets_form_mes", "mes"),
      tabela("agg_tickets_status_mes", "mes"),
      tabela("agg_agentes_mes", "mes"),
      tabela("agg_categorias_mes", "mes"),
      tabela("agg_tma_distribuicao_mes", "mes"),
      tabela("agg_reincidencia_mes", "mes"),
      tabela("sync_info", "id"),
    ]);
    return {
      chatsDia, chatsHora, ticketsDia, ticketsMes, ticketsFormMes, ticketsStatusMes,
      agentesMes, categoriasMes, tmaDistMes, reincMes,
      syncInfo: syncInfo[0] || null,
    };
  }

  return { carregarTudo, cliente };
})();
