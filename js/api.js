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

  // ── Tickets: tudo agregado server-side sob demanda (paridade com octa-api) ──
  // `f` = { forms:[], status:[], analistas:[], ini, fim, porFechamento }.
  async function _rpc(nome, params) {
    const { data, error } = await cliente.rpc(nome, params);
    if (error) throw new Error(`${nome}: ${error.message}`);
    return data;
  }
  const _tktParams = (f) => ({
    p_forms: f.forms || [], p_status: f.status || [], p_analistas: f.analistas || [],
    p_ini: f.ini, p_fim: f.fim, p_por_fechamento: !!f.porFechamento,
  });
  const ticketsOpcoes         = ()  => _rpc("tickets_opcoes", {});                                  // {forms, analistas}
  const ticketsKpis           = (f) => _rpc("tickets_kpis", _tktParams(f)).then((d) => (d && d[0]) || {});
  const ticketsTimeseries     = (f) => _rpc("tickets_timeseries", _tktParams(f)).then((d) => d || []);
  const ticketsPorFormulario  = (f) => _rpc("tickets_por_formulario", _tktParams(f)).then((d) => d || []);
  const ticketsPorStatus      = (f) => _rpc("tickets_por_status", _tktParams(f)).then((d) => d || []);
  const ticketsRankingAnalistas = (f) => _rpc("tickets_ranking_analistas", _tktParams(f)).then((d) => d || []);

  // Carrega as tabelas pequenas em paralelo; ordem = PK de cada uma. (Tickets saíram
  // daqui — agora são a tabela-fato + RPCs, agregados server-side sob demanda.)
  async function carregarTudo() {
    const [
      chatsDia, agentesMes, tmaDistDia, reincMes, syncInfo,
    ] = await Promise.all([
      tabela("agg_chats_dia", "dia,fila_slug"),
      tabela("agg_agentes_mes", "mes,agent_id"),
      tabela("agg_tma_distribuicao_dia", "dia,fila_slug"),
      tabela("agg_reincidencia_mes", "mes"),
      tabela("sync_info", "id"),
    ]);
    return {
      chatsDia, agentesMes, tmaDistDia, reincMes,
      syncInfo: syncInfo[0] || null,
    };
  }

  return {
    carregarTudo, categoriasPeriodo, chatsHoraPeriodo, cliente,
    ticketsOpcoes, ticketsKpis, ticketsTimeseries,
    ticketsPorFormulario, ticketsPorStatus, ticketsRankingAnalistas,
  };
})();
