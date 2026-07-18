// ══════════════════════════════════════════════════════════════
// Acesso ao Supabase (somente leitura, via anon key + RLS).
// Carrega a janela completa de cada tabela agg_* e filtra no cliente.
// ══════════════════════════════════════════════════════════════

const API = (() => {
  const cliente = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const PAGINA = 1000;  // teto por request do PostgREST (Supabase)

  // Carrega TODAS as linhas de uma tabela paginando de 1000 em 1000, em série.
  // (Paralelizar as páginas estoura o statement timeout do free tier — a instância
  // não aguenta várias queries pesadas simultâneas.) A tabela grande — categorias —
  // saiu daqui e virou a RPC categorias_periodo (agregada server-side sob demanda).
  // `ordem` = colunas da PK: usa o índice (OFFSET eficiente) e dá ordem estável.
  async function tabela(nome, ordem) {
    const cols = ordem.split(",").map((s) => s.trim());
    const todas = [];
    for (let de = 0; ; de += PAGINA) {
      const q = cols.reduce((acc, c) => acc.order(c, { ascending: true }),
        cliente.from(nome).select("*"));
      const { data, error } = await q.range(de, de + PAGINA - 1);
      if (error) throw new Error(`${nome}: ${error.message}`);
      todas.push(...(data || []));
      if (!data || data.length < PAGINA) break;
    }
    return todas;
  }

  // Categorias agregadas server-side para o segmento (membros) + período — retorna
  // ~25 linhas em vez de baixar a tabela inteira (~45k). Chamada sob demanda no render.
  async function categoriasPeriodo(membros, inicio, fim) {
    const { data, error } = await cliente.rpc("categorias_periodo",
      { p_slugs: membros, p_ini: inicio, p_fim: fim });
    if (error) throw new Error(`categorias_periodo: ${error.message}`);
    return data || [];
  }

  // Chats por hora agregados server-side (dow × hora, ≤168 linhas) para os gráficos
  // horários — evita baixar a tabela inteira (~19k). Chamada sob demanda no render.
  async function chatsHoraPeriodo(membros, inicio, fim) {
    const { data, error } = await cliente.rpc("chats_hora_periodo",
      { p_slugs: membros, p_ini: inicio, p_fim: fim });
    if (error) throw new Error(`chats_hora_periodo: ${error.message}`);
    return data || [];
  }

  // Carrega todas as tabelas em paralelo; ordem = PK de cada uma.
  async function carregarTudo() {
    const [
      chatsDia, ticketsDia, ticketsMes, ticketsFormMes, ticketsStatusMes,
      agentesMes, tmaDistDia, reincMes, syncInfo,
    ] = await Promise.all([
      tabela("agg_chats_dia", "dia,fila_slug"),
      tabela("agg_tickets_dia", "dia"),
      tabela("agg_tickets_mes", "mes"),
      tabela("agg_tickets_form_mes", "mes,form_name"),
      tabela("agg_tickets_status_mes", "mes,status_name"),
      tabela("agg_agentes_mes", "mes,agent_id"),
      tabela("agg_tma_distribuicao_dia", "dia,fila_slug"),
      tabela("agg_reincidencia_mes", "mes"),
      tabela("sync_info", "id"),
    ]);
    return {
      chatsDia, ticketsDia, ticketsMes, ticketsFormMes, ticketsStatusMes,
      agentesMes, tmaDistDia, reincMes,
      syncInfo: syncInfo[0] || null,
    };
  }

  return { carregarTudo, categoriasPeriodo, chatsHoraPeriodo, cliente };
})();
