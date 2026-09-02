// ══════════════════════════════════════════════════════════════
// Acesso ao Supabase (somente leitura, via anon key + RLS).
// Carrega a janela completa de cada tabela agg_* e filtra no cliente.
// ══════════════════════════════════════════════════════════════

const API = (() => {
  const cliente = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const PAGINA = 1000;  // teto por request do PostgREST (Supabase)

  // Reexecuta uma query do Supabase quando o erro é TRANSITÓRIO (statement_timeout=57014,
  // 504, esgotamento de conexão, rede) — o free-tier fica lento em rajadas e um único
  // timeout de 8s derrubaria a carga inteira. Backoff curto (0,6s → 1,2s). Erro "real"
  // (permissão, etc.) NÃO é reexecutado. Devolve {data, error} como o supabase-js.
  // Retry SUAVE (2 tentativas): com a instância saturada, insistir muito = mais carga
  // (thundering herd). Melhor falhar rápido pro cache. Backoff maior + jitter grande p/
  // dessincronizar vários usuários. Só reexecuta erro transitório (57014/504/conn/rede).
  async function comRetry(fazerQuery, tentativas = 2) {
    let ultimo;
    for (let i = 0; i < tentativas; i++) {
      ultimo = await fazerQuery();
      if (!ultimo.error) return ultimo;
      const msg = (ultimo.error.message || "").toLowerCase();
      const transitorio = /timeout|57014|53300|504|too many|fetch|network|terminat|econn/.test(msg);
      if (!transitorio || i === tentativas - 1) return ultimo;
      await new Promise((r) => setTimeout(r, 900 + Math.random() * 900));
    }
    return ultimo;
  }

  // Carrega TODAS as linhas de uma tabela paginando de 1000 em 1000, em série.
  // SEM `ORDER BY`: o front reordena/agrupa por dia no cliente de qualquer forma, e o sort
  // server-side em work_mem=2MB era fonte de spill (temp = Disk IO). Paginação por `range`
  // sobre a ordem física (tabelas pequenas ~2k linhas; TRUNCATE+INSERT do sync dá ordem estável).
  async function tabela(nome) {
    const todas = [];
    for (let de = 0; ; de += PAGINA) {
      // Nova query a cada tentativa (o builder do supabase-js é de uso único).
      const { data, error } = await comRetry(() =>
        cliente.from(nome).select("*").range(de, de + PAGINA - 1));
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
    const { data, error } = await comRetry(() => cliente.rpc("categorias_periodo",
      { p_slugs: membros, p_ini: inicio, p_fim: fim }));
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
      tabela("agg_analista_dia"),
      tabela("agg_analista_tma_dist_dia"),
      tabela("sync_info"),
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
    const { data, error } = await comRetry(() => cliente.rpc("chats_hora_periodo",
      { p_slugs: membros, p_ini: inicio, p_fim: fim }));
    if (error) throw new Error(`chats_hora_periodo: ${error.message}`);
    return data || [];
  }

  // ── Tickets: tudo agregado server-side sob demanda (paridade com octa-api) ──
  // `f` = { forms:[], status:[], analistas:[], ini, fim, porFechamento }.
  async function _rpc(nome, params) {
    const { data, error } = await comRetry(() => cliente.rpc(nome, params));
    if (error) throw new Error(`${nome}: ${error.message}`);
    return data;
  }
  const _tktParams = (f) => ({
    p_forms: f.forms || [], p_status: f.status || [], p_analistas: f.analistas || [],
    p_ini: f.ini, p_fim: f.fim, p_por_fechamento: !!f.porFechamento,
    p_issue: f.issue || "todos",
  });
  const ticketsOpcoes         = ()  => _rpc("tickets_opcoes", {});                                  // {forms, analistas}
  // PAINEL: 1 RPC devolve tudo (kpis+timeseries+por_formulario+por_status+ranking) num JSON —
  // 1 scan da tabela-fato em vez de 6. Substitui as 6 RPCs de tickets no render.
  const ticketsPainel         = (f) => _rpc("tickets_painel", _tktParams(f));
  // Lista os tickets estourados de UM formulário (para a modal ao clicar na contagem).
  const ticketsSlaEstourado   = (f, formName) =>
    _rpc("tickets_sla_estourado", { ..._tktParams(f), p_form_name: formName }).then((d) => d || []);

  // CARGA CORE (login): só o essencial da Performance (a seção padrão) — 3 tabelas em vez
  // de 9. As demais seções (Ranking/Bot/Reincidência/Auditoria) carregam SOB DEMANDA via
  // carregarTabelas quando abertas. Corta ~2/3 das queries por acesso → muito menos IO
  // simultâneo no free-tier e login mais rápido. (Categorias/horas já são RPC on-demand.)
  async function carregarCore() {
    const [chatsDia, syncInfo] = await Promise.all([
      tabela("agg_chats_dia"),   // agg_tma_distribuicao_dia saiu daqui → agora é a RPC dist_tma_periodo
      tabela("sync_info"),
    ]);
    return { chatsDia, syncInfo: syncInfo[0] || null };
  }

  // Distribuição de TMA do período agregada server-side (soma buckets + percentis ponderados) —
  // ~1 objeto em vez de baixar ~2k linhas de agg_tma_distribuicao_dia. Chamada sob demanda no render.
  async function distTmaPeriodo(membros, inicio, fim) {
    const { data, error } = await comRetry(() => cliente.rpc("dist_tma_periodo",
      { p_slugs: membros, p_ini: inicio, p_fim: fim }));
    if (error) throw new Error(`dist_tma_periodo: ${error.message}`);
    return data || null;
  }

  // Carrega tabelas adicionais sob demanda. specs: [{key, nome, fallback}]. Fallback []: se a
  // tabela não existir/RLS barrar, a seção fica vazia em vez de quebrar.
  async function carregarTabelas(specs) {
    const dados = await Promise.all(specs.map((s) =>
      s.fallback ? tabela(s.nome).catch(() => []) : tabela(s.nome)));
    const out = {};
    specs.forEach((s, i) => { out[s.key] = dados[i]; });
    return out;
  }

  return {
    carregarCore, carregarTabelas, categoriasPeriodo, chatsHoraPeriodo, distTmaPeriodo,
    tmaDistAnalistaPeriodo, cliente,
    ticketsOpcoes, ticketsPainel, ticketsSlaEstourado,
    // modo analista
    meuPerfil, carregarTudoAnalista, categoriasPeriodoAnalista,
    chatsHoraPeriodoAnalista, meuRankingPeriodo,
  };
})();
