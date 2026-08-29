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

  // Distribuição de TMA por analista no período (só p/ o export Excel; sob demanda no
  // clique). RPC SECURITY INVOKER → gestor vê todos, analista só o dele (RLS da tabela).
  async function tmaDistAnalistaPeriodo(inicio, fim) {
    const { data, error } = await cliente.rpc("tma_dist_analista_periodo",
      { p_ini: inicio, p_fim: fim });
    if (error) throw new Error(`tma_dist_analista_periodo: ${error.message}`);
    return data || [];
  }

  // Categorias agregadas server-side para o segmento (membros) + período — retorna
  // ~25 linhas em vez de baixar a tabela inteira (~45k). Chamada sob demanda no render.
  async function categoriasPeriodo(membros, inicio, fim) {
    const { data, error } = await cliente.rpc("categorias_periodo",
      { p_slugs: membros, p_ini: inicio, p_fim: fim });
    if (error) throw new Error(`categorias_periodo: ${error.message}`);
    return data || [];
  }

  // ── Modo ANALISTA (isolamento por linha; escopo vem da RLS, não de argumento) ──
  // Perfil do usuário logado (define o modo: gestão vê tudo, analista só o dele).
  async function meuPerfil() {
    const { data, error } = await cliente.rpc("meu_perfil");
    if (error) throw new Error(`meu_perfil: ${error.message}`);
    return data || null;   // {autorizado, is_gestor, agent_id, agent_name, email} | null
  }

  // Carrega os dados do próprio analista (tabelas agg_analista_*, escopadas por RLS) já
  // no formato que os renders da equipe esperam: fila_slug 'eu' (segmento único).
  async function carregarTudoAnalista() {
    const [analistaDia, analistaTma, syncInfo] = await Promise.all([
      tabela("agg_analista_dia", "dia,agent_id"),
      tabela("agg_analista_tma_dist_dia", "dia,agent_id"),
      tabela("sync_info", "id"),
    ]);
    return {
      chatsDia: analistaDia.map((r) => ({ ...r, fila_slug: "eu", fila_label: "Meus indicadores" })),
      tmaDistDia: analistaTma.map((r) => ({ ...r, fila_slug: "eu" })),
      agentesDia: [],   // ranking do analista vem por meu_ranking_periodo (só a posição dele)
      reincMes: [],     // reincidência não se aplica ao analista (seção escondida)
      syncInfo: syncInfo[0] || null,
    };
  }

  // Categorias/horas do próprio analista — mesma forma de retorno das RPCs da equipe.
  async function categoriasPeriodoAnalista(inicio, fim) {
    const { data, error } = await cliente.rpc("categorias_periodo_analista",
      { p_ini: inicio, p_fim: fim });
    if (error) throw new Error(`categorias_periodo_analista: ${error.message}`);
    return data || [];
  }
  async function chatsHoraPeriodoAnalista(inicio, fim) {
    const { data, error } = await cliente.rpc("chats_hora_periodo_analista",
      { p_ini: inicio, p_fim: fim });
    if (error) throw new Error(`chats_hora_periodo_analista: ${error.message}`);
    return data || [];
  }
  // Posição do analista no ranking do mês (só a linha dele; pesos = os do front).
  async function meuRankingPeriodo(ini, fim, pesos, tmaLimiteMin) {
    const { data, error } = await cliente.rpc("meu_ranking_periodo", {
      p_ini: ini, p_fim: fim,
      p_w_volume: pesos.volume, p_w_eng: pesos.engajamento, p_w_csat: pesos.csat,
      p_w_resolv: pesos.resolvidos, p_w_tma: pesos.tma, p_tma_limite_min: tmaLimiteMin,
    });
    if (error) throw new Error(`meu_ranking_periodo: ${error.message}`);
    return (data && data[0]) || null;
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
    p_issue: f.issue || "todos",
  });
  const ticketsOpcoes         = ()  => _rpc("tickets_opcoes", {});                                  // {forms, analistas}
  const ticketsKpis           = (f) => _rpc("tickets_kpis", _tktParams(f)).then((d) => (d && d[0]) || {});
  const ticketsTimeseries     = (f) => _rpc("tickets_timeseries", _tktParams(f)).then((d) => d || []);
  const ticketsPorFormulario  = (f) => _rpc("tickets_por_formulario", _tktParams(f)).then((d) => d || []);
  const ticketsPorStatus      = (f) => _rpc("tickets_por_status", _tktParams(f)).then((d) => d || []);
  const ticketsRankingAnalistas = (f) => _rpc("tickets_ranking_analistas", _tktParams(f)).then((d) => d || []);
  // Lista os tickets estourados de UM formulário (para a modal ao clicar na contagem).
  const ticketsSlaEstourado   = (f, formName) =>
    _rpc("tickets_sla_estourado", { ..._tktParams(f), p_form_name: formName }).then((d) => d || []);

  // Carrega as tabelas pequenas em paralelo; ordem = PK de cada uma. (Tickets saíram
  // daqui — agora são a tabela-fato + RPCs, agregados server-side sob demanda.)
  async function carregarTudo() {
    const [
      chatsDia, agentesDia, agentesFilaDia, tmaDistDia, reincMes, botDia, botHora, qaResultados, syncInfo,
    ] = await Promise.all([
      tabela("agg_chats_dia", "dia,fila_slug"),
      tabela("agg_agentes_dia", "dia,agent_id"),
      // Ranking por categoria de fila (só-gestão via RLS). Fallback []: se a migration
      // ainda não rodou, o ranking cai no modo não-agrupado (ver app.js).
      tabela("agg_agentes_fila_dia", "dia,agent_id,categoria_slug").catch(() => []),
      tabela("agg_tma_distribuicao_dia", "dia,fila_slug"),
      tabela("agg_reincidencia_mes", "mes"),
      tabela("agg_bot_dia", "dia,canal"),      // seção Bot (só-gestão via RLS)
      tabela("agg_bot_hora", "dia,hora"),
      // Auditoria QA (só-gestão via RLS). Fallback []: se a tabela ainda não existe
      // (migration_qa.sql não aplicada) a dashboard não quebra — a seção fica vazia.
      tabela("agg_qa_resultados", "result_id").catch(() => []),
      tabela("sync_info", "id"),
    ]);
    return {
      chatsDia, agentesDia, agentesFilaDia, tmaDistDia, reincMes, botDia, botHora, qaResultados,
      syncInfo: syncInfo[0] || null,
    };
  }

  return {
    carregarTudo, categoriasPeriodo, chatsHoraPeriodo, tmaDistAnalistaPeriodo, cliente,
    ticketsOpcoes, ticketsKpis, ticketsTimeseries,
    ticketsPorFormulario, ticketsPorStatus, ticketsRankingAnalistas, ticketsSlaEstourado,
    // modo analista
    meuPerfil, carregarTudoAnalista, categoriasPeriodoAnalista,
    chatsHoraPeriodoAnalista, meuRankingPeriodo,
  };
})();
