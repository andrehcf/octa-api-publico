// ══════════════════════════════════════════════════════════════
// Acesso ao Supabase (somente leitura, via anon key + RLS).
// Carrega a janela completa de cada tabela agg_* de uma vez —
// o volume é pequeno (~3 mil linhas) e os filtros rodam no cliente.
// ══════════════════════════════════════════════════════════════

const API = (() => {
  const cliente = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const LIMITE = 10000; // acima do cap default de 1000 linhas do PostgREST

  async function tabela(nome, ordem) {
    const { data, error } = await cliente
      .from(nome)
      .select("*")
      .order(ordem, { ascending: true })
      .limit(LIMITE);
    if (error) throw new Error(`${nome}: ${error.message}`);
    return data || [];
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
