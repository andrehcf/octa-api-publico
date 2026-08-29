// ══════════════════════════════════════════════════════════════
// Dashboard pública CPlug Suporte — estado, filtros e renderização.
// Dados: tabelas agg_* do Supabase (janela móvel de ~120 dias).
// ══════════════════════════════════════════════════════════════

(() => {
  const estado = {
    dados: null,
    perfil: null,      // {is_gestor, agent_id, agent_name, email} — define gestão vs analista
    preset: "hoje",    // hoje | ontem | semana (dom–sáb) | mes — âncora = último dia com dados
    range: null,       // {inicio, fim} quando período personalizado ativo
    fila: ["todas"],   // ARRAY = filas selecionadas (multi, somadas); STRING = tag:/orig:/eu

    secao: "performance",
    rankingSort: { col: "score", dir: "desc" },  // ordenação da tabela de ranking (gestão)
    rankingView: "fila",                         // "fila" (2 categorias) | "geral" (todo o Suporte)
    rankingRows: [],                             // analistas agregados do período (p/ re-ordenar/exportar)
    tkt: { form: "", status: "", analista: "", issue: "todos", porFechamento: false },  // filtros de tickets
    tktExport: { forms: [], ranking: [] },                              // último resultado p/ CSV
  };

  // Papel: analista = logado, autorizado, MAS não-gestão (vê só os próprios dados).
  const ehAnalista = () => !!(estado.perfil && !estado.perfil.is_gestor);
  // Fontes de categorias/horas que trocam para as RPCs por-analista no modo analista
  // (mesma forma de retorno → os renders são reaproveitados sem alteração).
  const fonteCategorias = (ini, fim, membros) =>
    ehAnalista() ? API.categoriasPeriodoAnalista(ini, fim) : API.categoriasPeriodo(membros, ini, fim);
  const fonteChatsHora = (ini, fim, membros) =>
    ehAnalista() ? API.chatsHoraPeriodoAnalista(ini, fim) : API.chatsHoraPeriodo(membros, ini, fim);

  const charts = {};   // registry de instâncias Chart.js

  const $ = (id) => document.getElementById(id);

  Chart.defaults.font = { family: "Inter", size: 11 };
  // Cores de tema dos gráficos: lidas das variáveis CSS (--grid / --chart-text) para
  // acompanhar claro/escuro. Reaplicadas a cada render() e no toggle (window.onThemeChange).
  const cssVar = (nome, fb) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim() || fb;
  // Escapa string vinda do banco antes de injetar via innerHTML (defesa contra XSS).
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let GRID = "rgba(255,255,255,0.05)";
  let CHART_TEXT = "#8893aa";
  function aplicarTemaCharts() {
    GRID = cssVar("--grid", "rgba(255,255,255,0.05)");
    CHART_TEXT = cssVar("--chart-text", "#8893aa");
    Chart.defaults.color = CHART_TEXT;
  }
  aplicarTemaCharts();

  function novoChart(id, cfg) {
    const el = $(id);
    if (!el) return;   // canvas ausente no HTML (layout enxuto) → ignora
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(el, cfg);
  }

  // Plugin inline (sem dependência externa): escreve o valor acima de cada barra.
  const rotuloBarras = {
    id: "rotuloBarras",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      const ctx = chart.ctx;
      const cor = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#e6ebf5";
      ctx.save();
      ctx.font = "600 11px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = cor;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      meta.data.forEach((bar, i) => {
        const v = chart.data.datasets[0].data[i];
        if (!v) return;   // não rotula zero/nulo
        ctx.fillText(Number(v).toLocaleString("pt-BR"), bar.x, bar.y - 4);
      });
      ctx.restore();
    },
  };

  // Idem, mas rotula TODAS as barras (datasets agrupados) — valor arredondado.
  const rotuloBarrasGrupo = {
    id: "rotuloBarrasGrupo",
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const cor = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#e6ebf5";
      ctx.save();
      ctx.font = "600 10px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = cor;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (!meta || meta.hidden || !meta.data) return;
        meta.data.forEach((bar, i) => {
          const v = ds.data[i];
          if (v == null) return;
          ctx.fillText(Math.round(v).toLocaleString("pt-BR"), bar.x, bar.y - 3);
        });
      });
      ctx.restore();
    },
  };

  // ── Período selecionado ──
  // fim = último dia com dados; início = fim - dias + 1 (ou início da janela).
  function periodo() {
    const dias = estado.dados.chatsDia.map((r) => r.dia).sort();
    if (!dias.length) return null;
    const maxDia = dias[dias.length - 1];
    const minDia = dias[0];
    // Período personalizado (data inicial/final), clampado à janela de dados.
    if (estado.range) {
      let { inicio, fim } = estado.range;
      if (inicio < minDia) inicio = minDia;
      if (fim > maxDia) fim = maxDia;
      if (fim < inicio) return null;
      return { inicio, fim, minDia };
    }
    // Presets ancorados em HOJE (horário de Brasília, UTC-3 — casa com o "dia" BRT dos
    // dados, independente do fuso do navegador). Semana = domingo→hoje; mês = dia 1→hoje
    // (to-date). NÃO usa o último dia com dados como âncora: senão "Ontem" viraria
    // anteontem e "Essa semana" começaria num domingo isolado quando o sync atrasa.
    // Dias ainda sem dados simplesmente somam 0 — não distorcem a comparação.
    const iso = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    const brt = new Date(Date.now() - 3 * 3600 * 1000);   // "agora" em BRT
    const ref = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()));  // meia-noite de hoje (BRT)
    let ini = new Date(ref), fim = new Date(ref);
    if (estado.preset === "ontem") {
      ini.setUTCDate(ini.getUTCDate() - 1); fim = new Date(ini);
    } else if (estado.preset === "semana") {
      ini.setUTCDate(ini.getUTCDate() - ref.getUTCDay());   // volta ao domingo (getUTCDay: 0=dom)
    } else if (estado.preset === "mes") {
      ini = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
    }                                                        // "hoje": ini = fim = hoje
    let inicio = iso(ini);
    const fimS = iso(fim);
    if (inicio < minDia) inicio = minDia;   // piso da janela de 120 dias
    if (fimS < inicio) return null;
    return { inicio, fim: fimS, minDia };
  }

  function periodoAnterior(p) {
    const dur = (new Date(p.fim) - new Date(p.inicio)) / 86400000 + 1;
    const fimAnt = new Date(p.inicio + "T00:00:00");
    fimAnt.setDate(fimAnt.getDate() - 1);
    const iniAnt = new Date(fimAnt);
    iniAnt.setDate(iniAnt.getDate() - dur + 1);
    const inicio = iniAnt.toISOString().slice(0, 10);
    const fim = fimAnt.toISOString().slice(0, 10);
    if (inicio < p.minDia) return null;  // período anterior não cabe na janela
    return { inicio, fim };
  }

  const entre = (v, ini, fim) => v >= ini && v <= fim;

  function mesesDoPeriodo(p) {
    // 1º dia dos meses que intersectam o período
    const meses = new Set();
    const d = new Date(p.inicio + "T00:00:00");
    d.setDate(1);
    while (d.toISOString().slice(0, 10) <= p.fim) {
      meses.add(d.toISOString().slice(0, 10));
      d.setMonth(d.getMonth() + 1);
    }
    return meses;
  }

  // ── Filas combinadas ──
  // Cada fila-base soma sua versão "Plantão" (ex.: "Estendido" = estendido +
  // estendido-plantao). 'todas' e 'plantao' (Plantão Geral) ficam isolados.
  // Base e plantão têm aliases distintos no banco → conjuntos DISJUNTOS, então
  // somar nunca duplica contagem.
  const CAMPOS_CHATS_DIA = [
    "volume_atendido", "total_transferidos", "total_fechados", "fechados_sem_atender",
    "tme_soma_seg", "tme_n", "tma_soma_seg", "tma_n",
    "csat_respondidos", "csat_satisfeitos", "csat_soma_score", "csat_n",
    "resolvidos_sim", "resolvidos_total",
  ];

  function construirGruposFila() {
    const label = new Map();
    for (const r of estado.dados.chatsDia)
      if (!label.has(r.fila_slug)) label.set(r.fila_slug, r.fila_label);
    const ordena = (arr) => arr.sort((a, b) => label.get(a).localeCompare(label.get(b), "pt-BR"));
    const grupos = [];

    // Filas (slug sem prefixo). Pareia base + -plantao ("X (+Plantão)").
    if (label.has("todas"))
      grupos.push({ slug: "todas", label: "Todas as filas", membros: ["todas"], dim: "fila" });
    const bases = ordena([...label.keys()].filter(
      (s) => !s.includes(":") && s !== "todas" && s !== "plantao" && !s.endsWith("-plantao")));
    for (const base of bases) {
      const membros = [base];
      let lbl = label.get(base);
      if (label.has(base + "-plantao")) { membros.push(base + "-plantao"); lbl += " (+Plantão)"; }
      grupos.push({ slug: base, label: lbl, membros, dim: "fila" });
    }

    // Tags (tag:*) e Origem (orig:*) — independentes, sem combinação (membro único).
    for (const s of ordena([...label.keys()].filter((s) => s.startsWith("tag:"))))
      grupos.push({ slug: s, label: label.get(s), membros: [s], dim: "tag" });
    for (const s of ordena([...label.keys()].filter((s) => s.startsWith("orig:"))))
      grupos.push({ slug: s, label: label.get(s), membros: [s], dim: "origem" });

    return grupos;
  }

  // Aceita um slug único (fila/tag/origem) OU um array de slugs de fila (multi-seleção):
  // devolve a UNIÃO dos membros (fila_slugs crus), sem duplicar. Base e plantão de cada fila
  // são conjuntos disjuntos no banco, então somar filas nunca conta o mesmo chat duas vezes.
  function membrosDaFila(sel) {
    const slugs = Array.isArray(sel) ? sel : [sel];
    const out = new Set();
    for (const slug of slugs) {
      const g = (estado.gruposFila || []).find((x) => x.slug === slug);
      (g ? g.membros : [slug]).forEach((m) => out.add(m));
    }
    return [...out];
  }

  // Linhas diárias da fila (somando os membros do grupo) — uma linha por dia.
  function linhasFilaPorDia(slug, ini, fim) {
    const membros = new Set(membrosDaFila(slug));
    const porDia = new Map();
    for (const r of estado.dados.chatsDia) {
      if (!membros.has(r.fila_slug) || !entre(r.dia, ini, fim)) continue;
      let acc = porDia.get(r.dia);
      if (!acc) {
        acc = { dia: r.dia, fila_slug: Array.isArray(slug) ? "sel" : slug };
        for (const c of CAMPOS_CHATS_DIA) acc[c] = 0;
        porDia.set(r.dia, acc);
      }
      for (const c of CAMPOS_CHATS_DIA) acc[c] += Number(r[c]) || 0;
    }
    return [...porDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1));
  }

  // ══════════════ PERFORMANCE ══════════════

  function renderPerformance() {
    const p = periodo();
    if (!p) return;
    const linhas = linhasFilaPorDia(estado.fila, p.inicio, p.fim);
    const k = KPIS.kpisChats(linhas);

    const pAnt = periodoAnterior(p);
    const kAnt = pAnt
      ? KPIS.kpisChats(linhasFilaPorDia(estado.fila, pAnt.inicio, pAnt.fim))
      : {};

    const setar = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    const setarH = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
    const media1 = (x) => (x == null ? "—" : x.toLocaleString("pt-BR", { maximumFractionDigits: 1 }));

    // Valores
    setar("kpiVolume", KPIS.fmtInt(k.volume));
    setar("kpiTme", KPIS.fmtDuracao(k.tmeSeg));
    setar("kpiTma", KPIS.fmtDuracao(k.tmaSeg));
    setar("kpiAbandono", KPIS.fmtPct(k.abandonoPct, 2));
    setar("kpiCsat", KPIS.fmtPct(k.csatPct, 2));
    setar("kpiResolvidos", KPIS.fmtPct(k.resolvidosPct, 2));

    // Delta % relativo (estilo octa-api)
    setarH("kpiVolumeDelta", KPIS.deltaPctHtml(k.volume, kAnt.volume));
    setarH("kpiTmeDelta", KPIS.deltaPctHtml(k.tmeSeg, kAnt.tmeSeg, true));
    setarH("kpiTmaDelta", KPIS.deltaPctHtml(k.tmaSeg, kAnt.tmaSeg, true));
    setarH("kpiAbandonoDelta", KPIS.deltaPctHtml(k.abandonoPct, kAnt.abandonoPct, true));
    setarH("kpiCsatDelta", KPIS.deltaPctHtml(k.csatPct, kAnt.csatPct));
    setarH("kpiResolvidosDelta", KPIS.deltaPctHtml(k.resolvidosPct, kAnt.resolvidosPct));

    // ANTERIOR (valor absoluto do período anterior)
    setar("kpiVolumeAnt", KPIS.fmtInt(kAnt.volume));
    setar("kpiTmeAnt", KPIS.fmtDuracao(kAnt.tmeSeg));
    setar("kpiTmaAnt", KPIS.fmtDuracao(kAnt.tmaSeg));
    setar("kpiAbandonoAnt", KPIS.fmtPct(kAnt.abandonoPct, 2));
    setar("kpiCsatAnt", KPIS.fmtPct(kAnt.csatPct, 2));
    setar("kpiResolvidosAnt", KPIS.fmtPct(kAnt.resolvidosPct, 2));

    // Rodapé de contexto (igual octa-api)
    setar("kpiVolumeFoot", `de ${KPIS.fmtInt(k.transferidos)} transferidos`);
    setar("kpiTmeFoot", `baseado em ${KPIS.fmtInt(k.tmeN)} chats`);
    setar("kpiTmaFoot", `baseado em ${KPIS.fmtInt(k.tmaN)} chats`);
    setar("kpiAbandonoFoot", `${KPIS.fmtInt(k.semAtender)} de ${KPIS.fmtInt(k.transferidos)} transferidos`);
    setar("kpiCsatFoot", `${KPIS.fmtInt(k.respondidos)} resp. · méd. ${media1(k.csatMedia)} · ${KPIS.fmtPct(k.engajamentoPct)} eng.`);
    setar("kpiResolvidosFoot", `${KPIS.fmtInt(k.resolvSim)} / ${KPIS.fmtInt(k.resolvTotal)} resolvidos`);

    const labels = linhas.map((r) => KPIS.fmtDiaCurto(r.dia));
    const subVol = $("subVolumeDia");
    if (subVol) subVol.textContent =
      `${KPIS.fmtDiaCurto(p.inicio)} a ${KPIS.fmtDiaCurto(p.fim)} — ${filaLabel(estado.fila)}`;

    novoChart("chartVolumeDia", {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Atendidos",
          data: linhas.map((r) => r.volume_atendido),
          borderColor: "#4f7cf7", backgroundColor: "rgba(79,124,247,0.08)",
          tension: 0.4, pointRadius: 2, fill: true,
        }],
      },
      options: opts({ y: { beginAtZero: true } }),
    });

    novoChart("chartTempoDia", {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "TME (min)", data: linhas.map((r) => r.tme_n ? r.tme_soma_seg / r.tme_n / 60 : null),
            borderColor: "#22d3ee", backgroundColor: "rgba(34,211,238,0.08)", tension: 0.4, pointRadius: 2 },
          { label: "TMA (min)", data: linhas.map((r) => r.tma_n ? r.tma_soma_seg / r.tma_n / 60 : null),
            borderColor: "#14b8a6", backgroundColor: "rgba(20,184,166,0.08)", tension: 0.4, pointRadius: 2 },
        ],
      },
      options: opts({ y: { beginAtZero: true } }),
    });
  }

  // Distribuição de TMA do PERÍODO selecionado, FILTRADA pela fila — histograma +
  // percentis, no estilo do octa-api. Dado: agg_tma_distribuicao_dia (por dia e fila).
  // Histograma/n/média somam os dias do período × membros da fila (aditivos, exatos);
  // percentis são exatos p/ 1 linha (dia único + fila única) e média ponderada por n
  // nos demais casos (multi-dia ou fila combinada).
  function renderDistTma() {
    const p = periodo();
    if (!p) return;
    const stats = $("statsTmaDist");
    const min1 = (x) => (x == null ? "—" : x.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " min");
    const semDados = () => {
      estado.distTmaExport = null;   // desabilita o export enquanto não há dados
      if (stats) stats.textContent = "Sem dados no período";
      novoChart("chartTmaDistP", { type: "bar", data: { labels: [], datasets: [{ data: [] }] },
        options: opts({ y: { beginAtZero: true } }) });
    };

    const membros = new Set(membrosDaFila(estado.fila));
    const rows = (estado.dados.tmaDistDia || [])
      .filter((r) => membros.has(r.fila_slug) && entre(r.dia, p.inicio, p.fim));
    if (!rows.length) return semDados();

    const base = typeof rows[0].buckets === "string" ? JSON.parse(rows[0].buckets) : rows[0].buckets;
    const labels = base.map((b) => b.label);
    const counts = base.map(() => 0);
    let n = 0, mediaSoma = 0, p50Soma = 0, p90Soma = 0, p95Soma = 0;
    for (const r of rows) {
      const bs = typeof r.buckets === "string" ? JSON.parse(r.buckets) : r.buckets;
      bs.forEach((b, i) => { counts[i] += b.count || 0; });
      const ni = r.n || 0;
      n += ni;
      if (r.media_min != null) mediaSoma += r.media_min * ni;
      if (r.p50_min != null) p50Soma += r.p50_min * ni;
      if (r.p90_min != null) p90Soma += r.p90_min * ni;
      if (r.p95_min != null) p95Soma += r.p95_min * ni;
    }
    if (!n) return semDados();
    const media = mediaSoma / n;
    const unico = rows.length === 1;   // 1 dia + 1 fila → percentis exatos do banco
    const p50 = unico ? rows[0].p50_min : p50Soma / n;
    const p90 = unico ? rows[0].p90_min : p90Soma / n;
    const p95 = unico ? rows[0].p95_min : p95Soma / n;

    const periodoLbl = p.inicio === p.fim
      ? KPIS.fmtDiaCurto(p.inicio)
      : `${KPIS.fmtDiaCurto(p.inicio)} a ${KPIS.fmtDiaCurto(p.fim)}`;
    // Guarda o agregado já calculado (em memória) p/ o export Excel — sem query nova ao banco.
    estado.distTmaExport = { labels, counts, media, p50, p90, p95, n,
      filaLbl: filaLabel(estado.fila), ini: p.inicio, fim: p.fim };
    if (stats) stats.innerHTML =
      `${periodoLbl} · ${filaLabel(estado.fila)} · Média <b>${min1(media)}</b> · ` +
      `P50 <b>${min1(p50)}</b> · P90 <b>${min1(p90)}</b> · P95 <b>${min1(p95)}</b> · n <b>${KPIS.fmtInt(n)}</b>`;
    // Tooltip enriquecido: "N chats (X% do total)" + "Até aqui: Y%" (acumulado da
    // esquerda até a barra). Lê os counts do próprio dataset (já agregados no sync).
    const tmaOpts = opts({ y: { beginAtZero: true, grace: "12%" } });
    tmaOpts.plugins.tooltip.callbacks = {
      label: (ctx) => {
        const cs = ctx.chart.data.datasets[0].data;
        const tot = cs.reduce((a, b) => a + (b || 0), 0);
        const val = ctx.parsed.y || 0;
        const pct = tot ? (val / tot * 100).toFixed(2) : "0.00";
        let cum = 0;
        for (let i = 0; i <= ctx.dataIndex; i++) cum += (cs[i] || 0);
        const cumPct = tot ? (cum / tot * 100).toFixed(2) : "0.00";
        return [`${KPIS.fmtInt(val)} chats (${pct}% do total)`, `Até aqui: ${cumPct}%`];
      },
    };
    novoChart("chartTmaDistP", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: counts,
          backgroundColor: "rgba(139,92,246,0.8)", borderRadius: 7, borderSkipped: false,
        }],
      },
      options: tmaOpts,
      plugins: [rotuloBarras],
    });
  }

  // Preenche uma tabela de categorias somando o período a partir de agg_categorias_dia.
  // TMA: mediana exata quando o filtro é um único dia; senão média ponderada.
  let categoriasReqSeq = 0;   // guarda de corrida (descarta resposta obsoleta da RPC)

  // Encerramentos automáticos (inatividade/abandono) continuam contando em TODAS as métricas
  // gerais — só são ocultados do top-10 da Performance (ocultar=true), onde poluiriam o "top
  // por volume". A seção "Por Categoria" (ocultar=false) mostra tudo.
  const CATEGORIAS_OCULTAS = new Set([
    "Encerramento - Inatividade / Sem Resposta",
    "Encerramento - Abandono pelo Cliente",
  ]);

  async function preencherCategorias(tabelaId, subId, limite, ocultar = false) {
    const tabela = $(tabelaId);
    if (!tabela) return;
    const p = periodo();
    if (!p) return;
    const meuSeq = ++categoriasReqSeq;
    const membros = membrosDaFila(estado.fila);
    let cats;
    try {
      cats = await fonteCategorias(p.inicio, p.fim, membros);
    } catch (e) {
      console.error(e);
      return;
    }
    if (meuSeq !== categoriasReqSeq) return;   // filtro/período mudou: resposta velha
    // Filtra ANTES do slice para não desperdiçar vaga do top com categoria oculta.
    if (ocultar) cats = cats.filter((c) => !CATEGORIAS_OCULTAS.has(c.categoria_nome));
    cats = cats.slice(0, limite);
    const sub = $(subId);
    if (sub) sub.textContent =
      `Top ${cats.length} categorias — ${KPIS.fmtDiaCurto(p.inicio)} a ${KPIS.fmtDiaCurto(p.fim)}`;
    tabela.querySelector("tbody").innerHTML = cats.map((c) => {
      const tma = c.tma_n ? c.tma_soma_seg / c.tma_n : null;
      return `<tr>
        <td>${esc(c.categoria_nome)}</td>
        <td class="num">${KPIS.fmtInt(c.volume)}</td>
        <td class="num">${KPIS.fmtDuracao(tma)}</td>
        <td class="num">${c.csat_respondidos ? KPIS.fmtPct((c.csat_soma_score / c.csat_respondidos) / 5 * 100) : "—"}</td>
        <td class="num">${KPIS.fmtInt(c.csat_respondidos)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="empty-note">Sem dados no período</td></tr>`;
  }

  function renderCategoriasPerf() {
    preencherCategorias("tabelaCategoriasP", "subCategoriasP", 10, true);
  }

  // ══════════════ DIA X HORA ══════════════

  let diaHoraReqSeq = 0;   // guarda de corrida (descarta resposta obsoleta da RPC)

  async function renderDiaHora() {
    const p = periodo();
    if (!p) return;
    const meuSeq = ++diaHoraReqSeq;
    let linhas;   // linhas agregadas por (dow, hora) vindas da RPC
    try {
      linhas = await fonteChatsHora(p.inicio, p.fim, membrosDaFila(estado.fila));
    } catch (e) {
      console.error(e);
      return;
    }
    if (meuSeq !== diaHoraReqSeq) return;   // filtro/período mudou: resposta velha

    // Heatmap DOW × hora
    const grade = Array.from({ length: 7 }, () => Array(24).fill(0));
    const tmePorHora = Array.from({ length: 24 }, () => ({ soma: 0, n: 0 }));
    const tmaPorHora = Array.from({ length: 24 }, () => ({ soma: 0, n: 0 }));
    const csatPorHora = Array.from({ length: 24 }, () => ({ resp: 0, sat: 0, soma: 0, rsim: 0, rtot: 0 }));
    const volPorHora = Array(24).fill(0);
    const abandonoPorHora = Array(24).fill(0);    // chats fechados sem resposta do atendente
    const tmeMinPorHora = Array(24).fill(null);   // menor TME (min dos mínimos diários)
    const tmeMaxPorHora = Array(24).fill(null);   // maior TME (max dos máximos diários)
    const analistasPorHora = Array.from({ length: 24 }, () => new Set());  // distintos no período
    for (const r of linhas) {
      grade[r.dow][r.hora] += r.volume;             // dow (0=Dom) já vem do banco
      volPorHora[r.hora] += r.volume;
      abandonoPorHora[r.hora] += r.abandono || 0;
      tmePorHora[r.hora].soma += r.tme_soma_seg || 0;
      tmePorHora[r.hora].n += r.tme_n || 0;
      tmaPorHora[r.hora].soma += r.tma_soma_seg || 0;
      tmaPorHora[r.hora].n += r.tma_n || 0;
      const c = csatPorHora[r.hora];
      c.resp += r.csat_respondidos || 0;
      c.sat += r.csat_satisfeitos || 0;
      c.soma += r.csat_soma_score || 0;
      c.rsim += r.resolvidos_sim || 0;
      c.rtot += r.resolvidos_total || 0;
      if (r.tme_min_seg != null)
        tmeMinPorHora[r.hora] = tmeMinPorHora[r.hora] == null ? r.tme_min_seg : Math.min(tmeMinPorHora[r.hora], r.tme_min_seg);
      if (r.tme_max_seg != null)
        tmeMaxPorHora[r.hora] = tmeMaxPorHora[r.hora] == null ? r.tme_max_seg : Math.max(tmeMaxPorHora[r.hora], r.tme_max_seg);
      // analistas = array dos arrays diários (jsonb_agg); achata e deduplica.
      for (const arr of (r.analistas || [])) for (const a of arr) analistasPorHora[r.hora].add(a);
    }
    const maxCell = Math.max(1, ...grade.flat());
    const DOWS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    let html = `<div class="hm-corner"></div>` +
      Array.from({ length: 24 }, (_, h) => `<div class="hm-hour">${h}</div>`).join("");
    for (let d = 0; d < 7; d++) {
      html += `<div class="hm-dow">${DOWS[d]}</div>`;
      for (let h = 0; h < 24; h++) {
        const v = grade[d][h];
        const alpha = v ? 0.15 + 0.85 * (v / maxCell) : 0;
        html += `<div class="hm-cell" title="${DOWS[d]} ${h}h — ${KPIS.fmtInt(v)} atendimentos"
          style="${v ? `background:rgba(79,124,247,${alpha.toFixed(2)})` : ""}"></div>`;
      }
    }
    const elHm = $("heatmap");
    if (elHm) elHm.innerHTML = html;

    // Só as horas com volume (remove madrugada/horários vazios) — usado por todos os
    // gráficos horários (Volume, TME e Série temporal).
    let hIni = 24, hFim = -1;
    for (let h = 0; h < 24; h++) if (volPorHora[h] > 0) { if (h < hIni) hIni = h; if (h > hFim) hFim = h; }
    if (hFim < hIni) { hIni = 0; hFim = 23; }
    const hs = [];
    for (let h = hIni; h <= hFim; h++) hs.push(h);
    const pctH = (a, b) => (b ? 100 * a / b : null);
    const minH = (o) => (o.n ? o.soma / o.n / 60 : null);

    novoChart("chartVolumeHora", {
      type: "bar",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [{ data: hs.map((h) => volPorHora[h]), backgroundColor: "rgba(79,124,247,0.8)", borderRadius: 5, borderSkipped: false }],
      },
      options: opts({ y: { beginAtZero: true, grace: "12%" } }),
      plugins: [rotuloBarras],
    });

    novoChart("chartSerieHora", {
      type: "line",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [
          { label: "Volume", data: hs.map((h) => volPorHora[h]),
            borderColor: "#818cf8", backgroundColor: "rgba(129,140,248,0.12)", fill: true,
            tension: 0.4, pointRadius: 0, borderWidth: 2, yAxisID: "yVol" },
          { label: "TMA (min)", data: hs.map((h) => minH(tmaPorHora[h])),
            borderColor: "#f59e0b", tension: 0.4, pointRadius: 0, borderWidth: 2, yAxisID: "yMin" },
          { label: "TME (min)", data: hs.map((h) => minH(tmePorHora[h])),
            borderColor: "#2dd4bf", borderDash: [5, 4], tension: 0.4, pointRadius: 0, borderWidth: 2, yAxisID: "yMin" },
          { label: "CSAT %", data: hs.map((h) => (csatPorHora[h].resp ? (csatPorHora[h].soma / csatPorHora[h].resp) / 5 * 100 : null)),
            borderColor: "#22d3ee", borderDash: [5, 4], tension: 0.4, pointRadius: 0, borderWidth: 2, yAxisID: "yPct" },
          { label: "Resolvidos %", data: hs.map((h) => pctH(csatPorHora[h].rsim, csatPorHora[h].rtot)),
            borderColor: "#4ade80", borderDash: [5, 4], tension: 0.4, pointRadius: 0, borderWidth: 2, yAxisID: "yPct" },
          { label: "Engajamento %", data: hs.map((h) => pctH(csatPorHora[h].resp, volPorHora[h])),
            borderColor: "#a78bfa", borderDash: [2, 3], tension: 0.4, pointRadius: 0, borderWidth: 2, yAxisID: "yPct" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "top",
            labels: { boxWidth: 12, usePointStyle: true, pointStyle: "line", color: CHART_TEXT, font: { size: 11 } } },
          tooltip: { mode: "index", intersect: false },
        },
        scales: {
          x: { grid: { color: GRID } },
          yVol: { position: "left", beginAtZero: true, grid: { color: GRID },
            title: { display: true, text: "Volume", color: "#818cf8", font: { size: 10 } } },
          yMin: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false },
            title: { display: true, text: "Minutos", color: "#f59e0b", font: { size: 10 } } },
          yPct: { position: "right", beginAtZero: true, max: 100, grid: { drawOnChartArea: false },
            ticks: { callback: (v) => v + "%" },
            title: { display: true, text: "%", color: "#22d3ee", font: { size: 10 } } },
        },
      },
    });

    // ── TME × TMA × Abandonos por hora (barras agrupadas; min nos eixos TME/TMA, contagem
    //    de abandono em eixo próprio oculto yAband) — paridade com o octa-api v2 ──
    novoChart("chartTmeTmaHora", {
      type: "bar",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [
          { label: "TME", data: hs.map((h) => minH(tmePorHora[h])), yAxisID: "yTme",
            backgroundColor: "rgba(16,185,129,0.6)", borderColor: "#10b981", borderWidth: 1, borderRadius: 4 },
          { label: "TMA", data: hs.map((h) => minH(tmaPorHora[h])), yAxisID: "yTma",
            backgroundColor: "rgba(99,102,241,0.55)", borderColor: "#6366f1", borderWidth: 1, borderRadius: 4 },
          { label: "Abandonos", data: hs.map((h) => abandonoPorHora[h] || 0), yAxisID: "yAband",
            backgroundColor: "rgba(244,63,94,0.55)", borderColor: "#f43f5e", borderWidth: 1, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "top",
            labels: { boxWidth: 12, usePointStyle: true, pointStyle: "rect", color: CHART_TEXT, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.label === "Abandonos"
                ? `Abandonos: ${KPIS.fmtInt(ctx.parsed.y || 0)}`
                : `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : KPIS.fmtDuracao(ctx.parsed.y * 60)}`,
              afterBody: (items) => {
                const h = hs[items[0].dataIndex];
                return [
                  `Volume atendido: ${KPIS.fmtInt(volPorHora[h])}`,
                  `Analistas: ${analistasPorHora[h].size}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { grid: { color: GRID } },
          yTme: { position: "left", beginAtZero: true, grace: "12%", grid: { color: GRID },
            title: { display: true, text: "TME (min)", color: "#10b981", font: { size: 10 } } },
          yTma: { position: "right", beginAtZero: true, grace: "12%", grid: { drawOnChartArea: false },
            title: { display: true, text: "TMA (min)", color: "#6366f1", font: { size: 10 } } },
          yAband: { position: "right", display: false, beginAtZero: true, grid: { drawOnChartArea: false } },
        },
      },
      plugins: [rotuloBarrasGrupo],
    });

    // ── CSAT / Resolvidos por hora (barras agrupadas %) ──
    novoChart("chartCsatResolvHora", {
      type: "bar",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [
          { label: "CSAT %", data: hs.map((h) => (csatPorHora[h].resp ? (csatPorHora[h].soma / csatPorHora[h].resp) / 5 * 100 : null)),
            backgroundColor: "rgba(14,165,233,0.6)", borderColor: "#0ea5e9", borderWidth: 1, borderRadius: 4 },
          { label: "Resolvidos %", data: hs.map((h) => pctH(csatPorHora[h].rsim, csatPorHora[h].rtot)),
            backgroundColor: "rgba(20,184,166,0.55)", borderColor: "#14b8a6", borderWidth: 1, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "top",
            labels: { boxWidth: 12, usePointStyle: true, pointStyle: "rect", color: CHART_TEXT, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : KPIS.fmtPct(ctx.parsed.y)}`,
              afterBody: (items) => {
                const h = hs[items[0].dataIndex];
                return [`Respondidas: ${KPIS.fmtInt(csatPorHora[h].resp)}`];
              },
            },
          },
        },
        scales: {
          x: { grid: { color: GRID } },
          y: { beginAtZero: true, max: 115, grid: { color: GRID }, ticks: { stepSize: 20, callback: (v) => (v <= 100 ? v + "%" : "") } },
        },
      },
      plugins: [rotuloBarrasGrupo],
    });

    // ── Engajamento por hora (respondidas; engajamento% e volume no tooltip) ──
    novoChart("chartEngajHora", {
      type: "bar",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [{
          data: hs.map((h) => csatPorHora[h].resp),
          backgroundColor: "rgba(167,139,250,0.7)", borderColor: "#a78bfa", borderWidth: 1, borderRadius: 5, borderSkipped: false,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => {
                const h = hs[item.dataIndex];
                const eng = pctH(csatPorHora[h].resp, volPorHora[h]);
                return [
                  `Respondidas: ${KPIS.fmtInt(csatPorHora[h].resp)}`,
                  `Volume atendido: ${KPIS.fmtInt(volPorHora[h])}`,
                  `Engajamento: ${eng == null ? "—" : KPIS.fmtPct(eng)}`,
                ];
              },
            },
          },
        },
        scales: { x: { grid: { color: GRID } }, y: { grid: { color: GRID }, beginAtZero: true, grace: "12%" } },
      },
      plugins: [rotuloBarras],
    });
  }

  // ══════════════ TICKETS ══════════════

  let tktReqSeq = 0;   // guarda de corrida das RPCs de tickets

  async function renderTickets() {
    const p = periodo();
    if (!p) return;
    const meuSeq = ++tktReqSeq;
    const t = estado.tkt;
    const f = {
      forms: t.form ? [t.form] : [],
      status: t.status ? [t.status] : [],
      analistas: t.analista ? [t.analista] : [],
      issue: t.issue || "todos",
      ini: p.inicio, fim: p.fim, porFechamento: t.porFechamento,
    };
    estado.tktFiltro = f;                          // guarda p/ a modal de SLA estourado
    const pAnt = periodoAnterior(p);
    const fAnt = pAnt ? { ...f, ini: pAnt.inicio, fim: pAnt.fim } : null;

    let kpis, kAnt, ts, forms, ranking, status;
    try {
      [kpis, kAnt, ts, forms, ranking, status] = await Promise.all([
        API.ticketsKpis(f),
        fAnt ? API.ticketsKpis(fAnt) : Promise.resolve({}),
        API.ticketsTimeseries(f),
        API.ticketsPorFormulario(f),
        API.ticketsRankingAnalistas(f),
        API.ticketsPorStatus(f),
      ]);
    } catch (e) { console.error(e); return; }
    if (meuSeq !== tktReqSeq) return;              // filtro/período mudou: resposta velha
    estado.tktExport = { forms, ranking };

    const setar = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const setarH = (id, h) => { const el = $(id); if (el) el.innerHTML = h; };
    const int = (x) => KPIS.fmtInt(x || 0);
    const horas = (h) => (h == null ? "—" : KPIS.fmtHoras(h));

    // KPIs
    setar("kpiTktTotal", int(kpis.total));
    setar("kpiTktAbertos", int(kpis.abertos));
    setar("kpiTktFechados", int(kpis.fechados));
    setar("kpiTktTma", horas(kpis.tma_mediana_h));
    setarH("kpiTktTotalDelta", KPIS.deltaPctHtml(kpis.total, kAnt.total));
    setarH("kpiTktFechadosDelta", KPIS.deltaPctHtml(kpis.fechados, kAnt.fechados));
    setarH("kpiTktTmaDelta", KPIS.deltaPctHtml(kpis.tma_mediana_h, kAnt.tma_mediana_h, true));
    setar("kpiTktTotalAnt", int(kAnt.total));
    setar("kpiTktFechadosAnt", int(kAnt.fechados));
    setar("kpiTktTmaAnt", horas(kAnt.tma_mediana_h));
    const comFormPct = kpis.total ? 100 * (kpis.com_form || 0) / kpis.total : 0;
    setar("kpiTktTotalFoot", `${KPIS.fmtPct(comFormPct)} com formulário`);
    setar("kpiTktTmaFoot", `mediana de ${int(kpis.fechados)} fechados`);
    setar("subTktFluxo", `${int(kpis.abertos_fluxo)} criados · ${int(kpis.fechados_fluxo)} fechados no período`);

    // Evolução diária (total / fechados)
    novoChart("chartTicketsFluxo", {
      type: "line",
      data: {
        labels: ts.map((r) => KPIS.fmtDiaCurto(r.dia)),
        datasets: [
          { label: "Total", data: ts.map((r) => r.total),
            borderColor: "#4f7cf7", backgroundColor: "rgba(79,124,247,0.08)", tension: 0.4, pointRadius: 2, fill: true },
          { label: "Fechados", data: ts.map((r) => r.fechados),
            borderColor: "#34d399", backgroundColor: "rgba(52,211,153,0.08)", tension: 0.4, pointRadius: 2, fill: true },
        ],
      },
      options: opts({ y: { beginAtZero: true } }),
    });

    // Por formulário + SLA
    $("tabelaTktForm").querySelector("tbody").innerHTML = forms.map((r) => `
      <tr>
        <td title="${esc(r.form_name)}">${esc(r.form_name)}</td>
        <td class="num">${int(r.total)}</td>
        <td class="num">${int(r.em_aberto)}</td>
        <td class="num">${int(r.fechados)}</td>
        <td class="num">${horas(r.tma_mediana_h)}</td>
        <td class="num">${r.alvo_horas != null ? horas(r.alvo_horas) : "—"}</td>
        <td class="num">${r.pct_dentro_sla != null ? KPIS.fmtPct(r.pct_dentro_sla) : "—"}</td>
        <td class="num">${
          r.alvo_horas == null ? "—"
          : r.sla_estourado > 0
            ? `<button class="sla-badge" data-form="${esc(r.form_name)}" title="Ver tickets estourados">${int(r.sla_estourado)}</button>`
            : `<span class="sla-zero">0</span>`
        }</td>
      </tr>`).join("") || `<tr><td colspan="8" class="empty-note">Sem dados no período</td></tr>`;

    // Ranking de analistas
    $("tabelaTktRanking").querySelector("tbody").innerHTML = ranking.map((r) => `
      <tr>
        <td class="num">${r.posicao}</td>
        <td>${esc(r.assigned_name)}</td>
        <td class="num">${int(r.produtividade)}</td>
        <td class="num">${KPIS.fmtPct(100 * (r.qualidade_frac || 0))}</td>
        <td class="num">${r.sla_pct != null ? KPIS.fmtPct(r.sla_pct) : "—"}</td>
        <td class="num"><strong>${(r.media_final || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
      </tr>`).join("") || `<tr><td colspan="6" class="empty-note">Sem dados no período</td></tr>`;

    // Por status
    novoChart("chartTicketsStatus", {
      type: "doughnut",
      data: {
        labels: status.map((r) => r.status_name),
        datasets: [{
          data: status.map((r) => r.total),
          backgroundColor: ["#34d399", "#4f7cf7", "#fbbf24", "#f87171", "#a78bfa", "#22d3ee"],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11 } } } },
      },
    });
  }

  // Popula os dropdowns de filtro de tickets (formulários/analistas via RPC; status fixo).
  const TKT_STATUS = ["Novo", "Em andamento", "Pendente", "Resolvido", "Cancelado"];
  async function popularTktFiltros() {
    let ops;
    try { ops = await API.ticketsOpcoes(); } catch (e) { console.error(e); return; }
    const opt = (v, txt) => `<option value="${esc(v)}">${esc(txt)}</option>`;
    $("tktForm").innerHTML = opt("", "Todos os formulários") + (ops.forms || []).map((n) => opt(n, n)).join("");
    $("tktStatus").innerHTML = opt("", "Todos os status") + TKT_STATUS.map((s) => opt(s, s)).join("");
    // analistas = [{id, nome}] — value = assigned_id (o filtro casa todos os tickets da
    // pessoa, mesmo renomeada no Octadesk); label = nome atual.
    $("tktAnalista").innerHTML = opt("", "Todos os analistas") + (ops.analistas || []).map((a) => opt(a.id, a.nome)).join("");
  }

  // Download client-side de CSV (separador ';' + BOM p/ abrir certo no Excel pt-BR).
  function baixarCSV(nomeArq, cabecalho, linhas) {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cabecalho, ...linhas].map((row) => row.map(esc).join(";")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nomeArq;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Gera um Excel (SpreadsheetML 2003 — XML puro, o Excel abre nativo) SEM biblioteca
  // externa/CDN, respeitando a CSP. `abas` = [{nome, linhas}]; cada célula é primitivo
  // (número vira Number) OU {v, s} com s = id de estilo ("t" título, "h" cabeçalho).
  function baixarExcel(nomeArq, abas) {
    const escX = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const celula = (c) => {
      let v = c, s = null;
      if (c && typeof c === "object" && "v" in c) { v = c.v; s = c.s; }
      const attr = s ? ` ss:StyleID="${s}"` : "";
      if (typeof v === "number" && isFinite(v))
        return `<Cell${attr}><Data ss:Type="Number">${v}</Data></Cell>`;
      return `<Cell${attr}><Data ss:Type="String">${escX(v)}</Data></Cell>`;
    };
    const abaXml = (a) =>
      `<Worksheet ss:Name="${escX(a.nome)}"><Table>` +
      a.linhas.map((row) => `<Row>${(row || []).map(celula).join("")}</Row>`).join("") +
      `</Table></Worksheet>`;
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"' +
      ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Styles>' +
      '<Style ss:ID="t"><Font ss:Bold="1" ss:Size="13"/></Style>' +
      '<Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#E8EAF0" ss:Pattern="Solid"/></Style>' +
      '</Styles>' + abas.map(abaXml).join("") + '</Workbook>';
    const blob = new Blob(["﻿" + xml], { type: "application/vnd.ms-excel;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nomeArq;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Exporta a Distribuição de TMA. Aba "Resumo" = agregado da fila (já em memória, zero
  // banco). Aba "Por analista" = lida sob demanda via RPC tma_dist_analista_periodo (reusa
  // agg_analista_tma_dist_dia, sem espaço novo; escopada por RLS — gestor vê todos).
  async function exportarDistTma() {
    const d = estado.distTmaExport;
    if (!d) return;   // sem dados no período/fila atuais
    const r1 = (x) => (x == null ? "" : Math.round(x * 10) / 10);
    const btn = $("btnExportDistTma");
    if (btn) btn.disabled = true;

    const abas = [{ nome: "Resumo", linhas: [
      [{ v: "Distribuição de TMA — Resumo", s: "t" }],
      [`Período: ${d.ini} a ${d.fim} · Fila: ${d.filaLbl}`],
      [],
      [{ v: "Faixa", s: "h" }, { v: "Qtde. chats", s: "h" }],
      ...d.labels.map((lab, i) => [lab, d.counts[i] || 0]),
      [],
      [{ v: "Estatísticas", s: "h" }, ""],
      ["Média (min)", r1(d.media)],
      ["P50 (min)", r1(d.p50)],
      ["P90 (min)", r1(d.p90)],
      ["P95 (min)", r1(d.p95)],
      ["N (chats)", d.n],
    ] }];

    // Aba por analista (todas as filas — a tabela por-analista não é separada por fila).
    try {
      const rows = await API.tmaDistAnalistaPeriodo(d.ini, d.fim);
      if (rows.length) {
        const nomes = new Map((estado.dados.agentesDia || []).map((r) => [r.agent_id, r.agent_name]));
        if (estado.perfil && estado.perfil.agent_id)
          nomes.set(estado.perfil.agent_id, estado.perfil.agent_name);
        const labels = (rows[0].buckets || []).map((b) => b.label);
        const cab = [{ v: "Analista", s: "h" }, ...labels.map((l) => ({ v: l, s: "h" })),
          { v: "Total", s: "h" }, { v: "Média (min)", s: "h" },
          { v: "P50 (min)", s: "h" }, { v: "P90 (min)", s: "h" }, { v: "P95 (min)", s: "h" }];
        const linhasA = rows.map((a) => {
          const bmap = new Map((a.buckets || []).map((b) => [b.label, b.count || 0]));
          return [nomes.get(a.agent_id) || a.agent_id,
            ...labels.map((l) => bmap.get(l) || 0),
            a.n, r1(a.media_min), r1(a.p50_min), r1(a.p90_min), r1(a.p95_min)];
        });
        abas.push({ nome: "Por analista", linhas: [
          [{ v: "Distribuição de TMA — Por analista (todas as filas)", s: "t" }],
          [`Período: ${d.ini} a ${d.fim}`],
          [],
          cab,
          ...linhasA,
        ] });
      }
    } catch (e) {
      console.error(e);   // sem a aba por-analista, ainda exporta o Resumo
    }

    if (btn) btn.disabled = false;
    baixarExcel(`distribuicao_tma_${d.ini}_${d.fim}.xls`, abas);
  }

  // ══════════════ CATEGORIAS ══════════════

  function renderCategorias() {
    const p = periodo();
    if (!p) return;
    preencherCategorias("tabelaCategorias", "subCategorias", 20);
  }

  // ══════════════ RANKING ══════════════

  // Modo analista: em vez do ranking de todos (dado da equipe, escondido por RLS),
  // mostra só a POSIÇÃO do próprio analista NO PERÍODO do filtro de data (via
  // meu_ranking_periodo — calcula o rank de todos server-side, devolve só a linha dele).
  async function renderRankingAnalista() {
    $("btnExportRanking").style.display = "none";   // exportar/ordenar é só na visão da gestão
    const p = periodo();
    const sub = $("subRanking");
    const tbody = $("tabelaRanking").querySelector("tbody");
    if (!p) {
      if (sub) sub.textContent = "Sem dados";
      tbody.innerHTML = `<tr><td colspan="8" class="empty-note">Sem dados</td></tr>`;
      return;
    }
    const per = `${KPIS.fmtDiaCurto(p.inicio)} a ${KPIS.fmtDiaCurto(p.fim)}`;
    let r;
    try {
      r = await API.meuRankingPeriodo(p.inicio, p.fim, CONFIG.PESOS, CONFIG.TMA_LIMITE_MIN);
    } catch (e) { console.error(e); return; }
    if (!r) {
      if (sub) sub.textContent = `Sem dados · ${per}`;
      tbody.innerHTML = `<tr><td colspan="8" class="empty-note">Sem dados no período</td></tr>`;
      return;
    }
    if (sub) sub.textContent = `Sua posição: #${r.posicao} de ${r.total} · ${per}`;
    tbody.innerHTML = `
      <tr>
        <td><span class="pos-badge ${r.posicao <= 3 ? "top" + r.posicao : ""}">${r.posicao}</span></td>
        <td>${esc(r.agent_name || "Você")}</td>
        <td class="num">${KPIS.fmtInt(r.volume)}</td>
        <td class="num">${KPIS.fmtPct(r.participacao_pct)}</td>
        <td class="num">${KPIS.fmtPct(r.engajamento_pct)}</td>
        <td class="num">${KPIS.fmtPct(r.csat_pct)}</td>
        <td class="num">${KPIS.fmtPct(r.resolvidos_pct)}</td>
        <td class="num">${r.tma_min != null ? KPIS.fmtDuracao(r.tma_min * 60) : "—"}</td>
      </tr>`;
  }

  // Gestão: ranking geral no PERÍODO do filtro de data do topo (Hoje/Ontem/semana/
  // mês + início/fim). Soma os dias de agg_agentes_dia por analista — mesmas colunas e
  // Score de antes, só que agora recortado por data (não mais pelo mês fixo).
  function renderRanking() {
    if (ehAnalista()) return renderRankingAnalista();

    const p = periodo();
    const tbody = $("tabelaRanking").querySelector("tbody");
    const sub = $("subRanking");
    if (!p) {
      if (sub) sub.textContent = "Sem dados";
      tbody.innerHTML = `<tr><td colspan="8" class="empty-note">Sem dados</td></tr>`;
      return;
    }
    if (sub) sub.textContent =
      `Score ponderado · ${KPIS.fmtDiaCurto(p.inicio)} a ${KPIS.fmtDiaCurto(p.fim)}`;

    // Agrega os dias do período por analista (agent_id).
    const porAgente = new Map();
    for (const r of estado.dados.agentesDia) {
      if (!entre(r.dia, p.inicio, p.fim)) continue;
      let a = porAgente.get(r.agent_id);
      if (!a) {
        a = { id: r.agent_id, nome: r.agent_name, volume: 0, tma_soma_seg: 0, tma_n: 0,
              csat_respondidos: 0, csat_satisfeitos: 0, csat_soma_score: 0,
              resolvidos_sim: 0, resolvidos_total: 0 };
        porAgente.set(r.agent_id, a);
      }
      a.volume += r.volume || 0;
      a.tma_soma_seg += r.tma_soma_seg || 0;
      a.tma_n += r.tma_n || 0;
      a.csat_respondidos += r.csat_respondidos || 0;
      a.csat_satisfeitos += r.csat_satisfeitos || 0;
      a.csat_soma_score += r.csat_soma_score || 0;
      a.resolvidos_sim += r.resolvidos_sim || 0;
      a.resolvidos_total += r.resolvidos_total || 0;
    }

    const linhas = [...porAgente.values()];
    const totalVolume = linhas.reduce((s, a) => s + a.volume, 0) || 1;

    // Bucket por categoria de fila: soma o volume por (agent, categoria) no período;
    // o analista entra na categoria de MAIOR volume (foco = % do volume nessa categoria).
    const filaPorAgente = new Map();
    for (const fr of (estado.dados.agentesFilaDia || [])) {
      if (!entre(fr.dia, p.inicio, p.fim)) continue;
      let f = filaPorAgente.get(fr.agent_id);
      if (!f) { f = { est_conv: 0, especializado: 0 }; filaPorAgente.set(fr.agent_id, f); }
      f[fr.categoria_slug] = (f[fr.categoria_slug] || 0) + (fr.volume || 0);
    }

    estado.rankingRows = linhas.map((r) => {
      const tmaMin = r.tma_n ? r.tma_soma_seg / r.tma_n / 60 : null;
      const a = {
        id: r.id,
        nome: r.nome,
        volume: r.volume,
        participacaoPct: 100 * r.volume / totalVolume,
        engajamentoPct: r.volume > 0 ? 100 * r.csat_respondidos / r.volume : null,
        csatPct: r.csat_respondidos > 0 ? (r.csat_soma_score / r.csat_respondidos) / 5 * 100 : null,
        resolvidosPct: r.resolvidos_total > 0 ? 100 * r.resolvidos_sim / r.resolvidos_total : null,
        tmaMin,
      };
      a.score = KPIS.scoreRanking(a, CONFIG.PESOS, CONFIG.TMA_LIMITE_MIN);
      const f = filaPorAgente.get(r.id) || { est_conv: 0, especializado: 0 };
      const totalCat = f.est_conv + f.especializado;
      a.categoria = totalCat === 0 ? "outros"
        : (f.est_conv >= f.especializado ? "est_conv" : "especializado");
      a.focoPct = totalCat ? 100 * Math.max(f.est_conv, f.especializado) / totalCat : null;
      return a;
    });
    $("btnExportRanking").style.display = "";   // gestão pode exportar a lista
    pintarRanking();
  }

  // Colunas ordenáveis: data-col do <th> → valor + tipo (nulos vão sempre p/ o fim).
  const RANKING_COLS = {
    nome:         { get: (a) => a.nome,            tipo: "txt" },
    score:        { get: (a) => a.score,           tipo: "num" },
    volume:       { get: (a) => a.volume,          tipo: "num" },
    participacao: { get: (a) => a.participacaoPct, tipo: "num" },
    engajamento:  { get: (a) => a.engajamentoPct,  tipo: "num" },
    csat:         { get: (a) => a.csatPct,         tipo: "num" },
    resolvidos:   { get: (a) => a.resolvidosPct,   tipo: "num" },
    tma:          { get: (a) => a.tmaMin,          tipo: "num" },
  };

  function ordenarRanking(rows) {
    const { col, dir } = estado.rankingSort;
    const def = RANKING_COLS[col] || RANKING_COLS.score;
    const mul = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = def.get(a), vb = def.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;      // nulo sempre por último, independente da direção
      if (vb == null) return -1;
      if (def.tipo === "txt") return mul * String(va).localeCompare(String(vb), "pt-BR");
      return mul * (va - vb);
    });
  }

  // Badge "% foco na fila" (quanto do volume do analista está na categoria dominante).
  function focoBadge(pct) {
    if (pct == null) return "";
    const cls = pct >= 90 ? "foco-alto" : pct >= 70 ? "foco-medio" : "foco-baixo";
    return ` <span class="foco-badge ${cls}" title="Foco na fila: ${KPIS.fmtPct(pct)} do volume do analista nesta categoria">${KPIS.fmtPct(pct, 0)}</span>`;
  }

  // (Re)desenha o ranking da gestão: "Geral" (todo o Suporte) + dois grupos por categoria de fila.
  function pintarRanking() {
    const rows = ordenarRanking(estado.rankingRows);
    estado.rankingSorted = rows;   // ordem exibida → a exportação bate com a tela
    // Geral = todo o Suporte (todas as filas), sem badge de foco.
    pintarGrupoRanking("tabelaRankingGeral", "subRankingGeral", rows, false);
    // Por fila: "outros" (analista sem volume nas 2 categorias — raríssimo) fica junto de Est+Conv.
    pintarGrupoRanking("tabelaRankingA", "subRankingA", rows.filter((a) => a.categoria !== "especializado"), true);
    pintarGrupoRanking("tabelaRankingB", "subRankingB", rows.filter((a) => a.categoria === "especializado"), true);

    document.querySelectorAll("#sec-ranking .ranking-tabela thead th[data-col]").forEach((th) => {
      const ativa = th.dataset.col === estado.rankingSort.col;
      th.classList.toggle("sort-asc", ativa && estado.rankingSort.dir === "asc");
      th.classList.toggle("sort-desc", ativa && estado.rankingSort.dir === "desc");
    });
  }

  function pintarGrupoRanking(tabelaId, subId, rows, comFoco) {
    const ehRankScore = estado.rankingSort.col === "score" && estado.rankingSort.dir === "desc";
    $(tabelaId).querySelector("tbody").innerHTML = rows.map((a, i) => `
      <tr>
        <td><span class="pos-badge ${ehRankScore && i < 3 ? "top" + (i + 1) : ""}">${i + 1}</span></td>
        <td>${esc(a.nome)}${comFoco ? focoBadge(a.focoPct) : ""}</td>
        <td class="num">${KPIS.fmtInt(a.volume)}</td>
        <td class="num">${KPIS.fmtPct(a.participacaoPct)}</td>
        <td class="num">${KPIS.fmtPct(a.engajamentoPct)}</td>
        <td class="num">${KPIS.fmtPct(a.csatPct)}</td>
        <td class="num">${KPIS.fmtPct(a.resolvidosPct)}</td>
        <td class="num">${a.tmaMin !== null ? KPIS.fmtDuracao(a.tmaMin * 60) : "—"}</td>
      </tr>`).join("") || `<tr><td colspan="8" class="empty-note">Sem analistas nesta fila no período</td></tr>`;
    const sub = $(subId);
    if (sub) {
      const vol = rows.reduce((s, a) => s + (a.volume || 0), 0);
      sub.textContent = `${rows.length} analista${rows.length === 1 ? "" : "s"} · ${KPIS.fmtInt(vol)} atend.`;
    }
  }

  // ══════════════ REINCIDÊNCIA ══════════════

  function renderReincidencia() {
    const linhas = estado.dados.reincMes;
    if (!linhas.length) return;
    const ult = linhas[linhas.length - 1];
    const taxa = ult.total_contatos > 0 ? 100 * ult.contatos_reinc / ult.total_contatos : null;
    const tempoDias = ult.horas_n > 0 ? ult.horas_soma / ult.horas_n / 24 : null;
    const mesmaCat = ult.com_categoria > 0 ? 100 * ult.mesma_categoria / ult.com_categoria : null;

    $("kpiReincTaxa").textContent = KPIS.fmtPct(taxa);
    $("subReincTaxa").textContent = `${KPIS.fmtMes(ult.mes)} — janela de ${ult.janela_dias} dias`;
    $("kpiReincContatos").textContent = KPIS.fmtInt(ult.contatos_reinc);
    $("kpiReincTempo").textContent = tempoDias !== null
      ? tempoDias.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " dias" : "—";
    $("kpiReincMesmaCat").textContent = KPIS.fmtPct(mesmaCat);

    novoChart("chartReincMes", {
      type: "bar",
      data: {
        labels: linhas.map((r) => KPIS.fmtMes(r.mes)),
        datasets: [
          { type: "bar", label: "Contatos reincidentes", data: linhas.map((r) => r.contatos_reinc),
            backgroundColor: "rgba(248,113,113,0.7)", borderRadius: 7, borderSkipped: false, yAxisID: "y1" },
          { type: "line", label: "Taxa %", yAxisID: "y2",
            data: linhas.map((r) => r.total_contatos > 0 ? 100 * r.contatos_reinc / r.total_contatos : null),
            borderColor: "#fbbf24", tension: 0.4, pointRadius: 3 },
        ],
      },
      options: opts({
        y1: { position: "left", grid: { color: GRID }, beginAtZero: true },
        y2: { position: "right", grid: { drawOnChartArea: false }, beginAtZero: true,
              ticks: { callback: (v) => v + "%" } },
      }, true),
    });
  }

  // ══════════════ Infra ══════════════

  function opts(scalesY = {}, multiEixo = false) {
    const scales = { x: { grid: { color: GRID } } };
    if (multiEixo) Object.assign(scales, scalesY);
    else scales.y = Object.assign({ grid: { color: GRID } }, scalesY.y || {});
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
      scales,
    };
  }

  function filaLabel(sel) {
    if (Array.isArray(sel)) {
      const filas = sel.filter((s) => s !== "todas");
      return filas.length ? filas.map(filaLabel).join(" + ") : "Todas as filas";
    }
    const g = (estado.gruposFila || []).find((x) => x.slug === sel);
    if (g) {
      const sufixo = g.dim === "tag" ? " (tag)" : g.dim === "origem" ? " (origem)" : "";
      return g.label + sufixo;
    }
    const r = estado.dados.chatsDia.find((x) => x.fila_slug === sel);
    return r ? r.fila_label : sel;
  }

  // ── Bot (fase pré-humana): contenção/resolução do bot antes de cair na fila. ──
  // Lê agg_bot_dia (dia×canal) e agg_bot_hora (dia×hora), soma o período no cliente.
  function renderBot() {
    const p = periodo();
    if (!p) return;
    const setar = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const setarH = (id, h) => { const el = $(id); if (el) el.innerHTML = h; };
    const pct = (a, b) => (b ? 100 * a / b : null);
    const int = (x) => KPIS.fmtInt(x || 0);
    const pctTxt = (x) => (x == null ? "—" : KPIS.fmtPct(x));

    const somar = (rows) => {
      const t = { volume: 0, bot_only: 0, resolvido_bot: 0, transferido: 0, woz: 0, woz_resolvido: 0, tempo_soma: 0, tempo_n: 0 };
      for (const r of rows) {
        t.volume += r.volume || 0; t.bot_only += r.bot_only || 0;
        t.resolvido_bot += r.resolvido_bot || 0; t.transferido += r.transferido || 0;
        t.woz += r.woz || 0; t.woz_resolvido += r.woz_resolvido || 0;
        t.tempo_soma += r.tempo_bot_soma_seg || 0; t.tempo_n += r.tempo_bot_n || 0;
      }
      return t;
    };
    const rows = (estado.dados.botDia || []).filter((r) => entre(r.dia, p.inicio, p.fim));
    const k = somar(rows);
    const pAnt = periodoAnterior(p);
    const kAnt = pAnt ? somar((estado.dados.botDia || []).filter((r) => entre(r.dia, pAnt.inicio, pAnt.fim))) : {};

    const contencao = pct(k.bot_only, k.volume), contencaoAnt = pct(kAnt.bot_only, kAnt.volume);
    const resolucao = pct(k.resolvido_bot, k.volume), resolucaoAnt = pct(kAnt.resolvido_bot, kAnt.volume);
    const transfer = pct(k.transferido, k.volume), transferAnt = pct(kAnt.transferido, kAnt.volume);
    const tempoMin = k.tempo_n ? k.tempo_soma / k.tempo_n / 60 : null;

    setar("kpiBotVolume", int(k.volume));
    setarH("kpiBotVolumeDelta", KPIS.deltaPctHtml(k.volume, kAnt.volume));
    setar("kpiBotVolumeAnt", int(kAnt.volume));
    setar("kpiBotVolumeFoot", `${int(k.bot_only)} contidas · ${int(k.transferido)} transferidas`);
    setar("kpiBotContencao", pctTxt(contencao));
    setarH("kpiBotContencaoDelta", KPIS.deltaPctHtml(contencao, contencaoAnt));
    setar("kpiBotContencaoAnt", pctTxt(contencaoAnt));
    setar("kpiBotContencaoFoot", `${int(k.bot_only)} de ${int(k.volume)} conversas`);
    setar("kpiBotResolucao", pctTxt(resolucao));
    setarH("kpiBotResolucaoDelta", KPIS.deltaPctHtml(resolucao, resolucaoAnt));
    setar("kpiBotResolucaoAnt", pctTxt(resolucaoAnt));
    setar("kpiBotResolucaoFoot", `${int(k.resolvido_bot)} resolvidas pelo bot`);
    setar("kpiBotTransfer", pctTxt(transfer));
    setarH("kpiBotTransferDelta", KPIS.deltaPctHtml(transfer, transferAnt, true));
    setar("kpiBotTransferAnt", pctTxt(transferAnt));
    setar("kpiBotTransferFoot", `${int(k.transferido)} caíram na fila humana`);
    setar("kpiBotTempo", tempoMin == null ? "—" : KPIS.fmtDuracao(tempoMin * 60));
    setar("kpiBotTempoFoot", `média de ${int(k.tempo_n)} contidas fechadas`);
    setar("kpiBotWoz", pctTxt(pct(k.woz, k.volume)));
    setar("kpiBotWozFoot", k.woz ? `${int(k.woz)} conversas · ${pctTxt(pct(k.woz_resolvido, k.woz))} resolvidas` : "sem uso no período");

    // Evolução diária: volume (barras) + contenção % (linha, eixo direito)
    const porDia = new Map();
    for (const r of rows) {
      let d = porDia.get(r.dia); if (!d) { d = { volume: 0, bot_only: 0 }; porDia.set(r.dia, d); }
      d.volume += r.volume || 0; d.bot_only += r.bot_only || 0;
    }
    const dias = [...porDia.keys()].sort();
    novoChart("chartBotDia", {
      type: "bar",
      data: {
        labels: dias.map((x) => KPIS.fmtDiaCurto(x)),
        datasets: [
          { label: "Volume", data: dias.map((x) => porDia.get(x).volume), yAxisID: "yVol",
            backgroundColor: "rgba(79,124,247,0.55)", borderColor: "#4f7cf7", borderWidth: 1, borderRadius: 4 },
          { type: "line", label: "Contenção %", data: dias.map((x) => pct(porDia.get(x).bot_only, porDia.get(x).volume)),
            yAxisID: "yPct", borderColor: "#34d399", backgroundColor: "rgba(52,211,153,0.08)", tension: 0.4, pointRadius: 2, fill: true },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: {
          label: (ctx) => ctx.dataset.label === "Contenção %"
            ? `Contenção: ${ctx.parsed.y == null ? "—" : KPIS.fmtPct(ctx.parsed.y)}`
            : `Volume: ${KPIS.fmtInt(ctx.parsed.y)}` } } },
        scales: {
          x: { grid: { color: GRID } },
          yVol: { position: "left", beginAtZero: true, grid: { color: GRID } },
          yPct: { position: "right", beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: (v) => v + "%" } },
        },
      },
    });

    // Por canal (tabela)
    const porCanal = new Map();
    for (const r of rows) {
      let c = porCanal.get(r.canal); if (!c) { c = { volume: 0, bot_only: 0, resolvido_bot: 0 }; porCanal.set(r.canal, c); }
      c.volume += r.volume || 0; c.bot_only += r.bot_only || 0; c.resolvido_bot += r.resolvido_bot || 0;
    }
    const tb = $("tabelaBotCanal");
    if (tb) tb.querySelector("tbody").innerHTML =
      [...porCanal.entries()].sort((a, b) => b[1].volume - a[1].volume).map(([canal, c]) => `
        <tr>
          <td>${esc(canal)}</td>
          <td class="num">${int(c.volume)}</td>
          <td class="num">${int(c.bot_only)}</td>
          <td class="num">${pctTxt(pct(c.bot_only, c.volume))}</td>
          <td class="num">${pctTxt(pct(c.resolvido_bot, c.volume))}</td>
        </tr>`).join("") || `<tr><td colspan="5" class="empty-note">Sem dados no período</td></tr>`;

    // Por hora do dia (barras agrupadas: volume × contidas)
    const volH = Array(24).fill(0), boH = Array(24).fill(0);
    for (const r of (estado.dados.botHora || [])) {
      if (!entre(r.dia, p.inicio, p.fim)) continue;
      volH[r.hora] += r.volume || 0; boH[r.hora] += r.bot_only || 0;
    }
    const hs = Array.from({ length: 24 }, (_, h) => h);
    novoChart("chartBotHora", {
      type: "bar",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [
          { label: "Volume", data: hs.map((h) => volH[h]), backgroundColor: "rgba(79,124,247,0.55)", borderColor: "#4f7cf7", borderWidth: 1, borderRadius: 4 },
          { label: "Contidas", data: hs.map((h) => boH[h]), backgroundColor: "rgba(52,211,153,0.6)", borderColor: "#34d399", borderWidth: 1, borderRadius: 4 },
        ],
      },
      options: opts({ y: { beginAtZero: true, grace: "10%" } }),
    });
  }

  // ── Auditoria QA (só-gestão) ── leitura dos resultados já auditados no octa-api.
  // Agrupa por analista, calcula score médio e critério mais fraco; o drill-down (clique
  // na linha) abre o relatório 1:1. Nada de LLM aqui — a análise roda no octa-api.
  function renderQa() {
    const p = periodo();
    if (!p) return;
    const int = (x) => KPIS.fmtInt(x || 0);
    const setar = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const rows = (estado.dados.qaResultados || []).filter((r) => entre(r.dia, p.inicio, p.fim));

    // KPIs de topo
    const comScore = rows.filter((r) => r.score != null);
    const scoreMedio = comScore.length
      ? comScore.reduce((s, r) => s + Number(r.score), 0) / comScore.length : null;
    const comCsat = rows.filter((r) => r.csat_score != null);
    const neg = rows.filter((r) => r.csat_score != null && r.csat_score <= 2).length;
    const analistas = new Set(rows.map((r) => r.analista_id)).size;
    setar("kpiQaTotal", int(rows.length));
    setar("kpiQaTotalFoot", rows.length ? `${int(comCsat.length)} com CSAT respondido` : "sem auditorias no período");
    setar("kpiQaScore", scoreMedio == null ? "—" : scoreMedio.toFixed(1));
    setar("kpiQaScoreFoot", "nota da IA (0–10)");
    setar("kpiQaAnalistas", int(analistas));
    setar("kpiQaAnalistasFoot", analistas ? "com auditoria no período" : "");
    setar("kpiQaNeg", int(neg));
    setar("kpiQaNegFoot", rows.length ? `${KPIS.fmtPct(100 * neg / rows.length)} das auditorias` : "");

    // Agrega por analista (score médio, negativos, média por critério)
    const porAnalista = new Map();
    for (const r of rows) {
      let a = porAnalista.get(r.analista_id);
      if (!a) { a = { id: r.analista_id, nome: r.analista_nome, itens: [], somaScore: 0, nScore: 0, neg: 0, crit: new Map() }; porAnalista.set(r.analista_id, a); }
      a.nome = r.analista_nome || a.nome;
      a.itens.push(r);
      if (r.score != null) { a.somaScore += Number(r.score); a.nScore++; }
      if (r.csat_score != null && r.csat_score <= 2) a.neg++;
      for (const c of (r.criterios || [])) {
        if (c && c.nome != null && c.nota != null) {
          const key = qaNormCrit(c.nome);           // a IA varia caixa/acentos do mesmo critério
          if (!key) continue;
          let g = a.crit.get(key);
          if (!g) { g = { soma: 0, n: 0, label: String(c.nome).trim() }; a.crit.set(key, g); }
          g.soma += Number(c.nota); g.n++;
          const nova = String(c.nome).trim();        // prefere o rótulo com minúsculas/acentos
          if (/[a-zà-ÿ]/.test(nova) && !/[a-zà-ÿ]/.test(g.label)) g.label = nova;
        }
      }
    }
    estado.qaPorAnalista = porAnalista;   // fonte do drill-down (modal)

    const lista = [...porAnalista.values()].sort((x, y) => y.itens.length - x.itens.length);
    const tb = $("tabelaQaAnalistas");
    if (tb) tb.querySelector("tbody").innerHTML = lista.map((a) => {
      const media = a.nScore ? a.somaScore / a.nScore : null;
      const pior = qaCriterioMaisFraco(a);
      const ultima = a.itens.reduce((m, r) => (r.dia > m ? r.dia : m), a.itens[0].dia);
      return `<tr data-analista="${esc(String(a.id))}" data-nome="${esc(a.nome)}" tabindex="0">
        <td>${esc(a.nome)}</td>
        <td class="num">${int(a.itens.length)}</td>
        <td class="num">${media == null ? "—" : media.toFixed(1)}</td>
        <td class="num">${int(a.neg)}</td>
        <td>${esc(KPIS.fmtDiaCurto(ultima))}</td>
        <td>${pior ? esc(pior.nome) + " (" + pior.media.toFixed(1) + ")" : "—"}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="empty-note">Sem auditorias no período</td></tr>`;

    // Autocomplete (datalist) + reaplica a busca ativa após o re-render.
    const dl = $("qaAnalistasList");
    if (dl) dl.innerHTML = lista.map((a) => `<option value="${esc(a.nome)}"></option>`).join("");
    filtrarQaTabela();
  }

  // Normaliza o nome do critério (sem acento, maiúsculo, espaços colapsados) para agrupar
  // variações que a IA devolve com grafias diferentes ("Conferência..." vs "CONFERENCIA...").
  function qaNormCrit(s) {
    return [...String(s).normalize("NFD")].filter((ch) => {
      const cc = ch.charCodeAt(0); return cc < 0x300 || cc > 0x36f;   // remove diacríticos
    }).join("").toUpperCase().replace(/\s+/g, " ").trim();
  }

  // Filtra as linhas da tabela QA pelo texto da busca (case-insensitive, ao vivo).
  function filtrarQaTabela() {
    const campo = $("qaBusca");
    const q = ((campo && campo.value) || "").trim().toLowerCase();
    const tb = $("tabelaQaAnalistas");
    if (!tb) return;
    let visiveis = 0;
    tb.querySelectorAll("tbody tr[data-analista]").forEach((tr) => {
      const ok = !q || (tr.getAttribute("data-nome") || "").toLowerCase().includes(q);
      tr.style.display = ok ? "" : "none";
      if (ok) visiveis++;
    });
    const vazio = tb.querySelector("tbody tr.qa-busca-vazia");
    if (q && visiveis === 0 && !vazio) {
      tb.querySelector("tbody").insertAdjacentHTML("beforeend",
        `<tr class="qa-busca-vazia"><td colspan="6" class="empty-note">Nenhum analista encontrado</td></tr>`);
    } else if ((!q || visiveis > 0) && vazio) { vazio.remove(); }
  }

  // Critérios ordenados por média de nota (asc) — o 1º é o mais fraco.
  function qaCriteriosOrdenados(a) {
    return [...a.crit.values()]
      .map((g) => ({ nome: g.label, media: g.soma / g.n }))
      .sort((x, y) => x.media - y.media);
  }
  function qaCriterioMaisFraco(a) {
    const cs = qaCriteriosOrdenados(a);
    return cs.length ? cs[0] : null;
  }

  // HTML do relatório 1:1 (cabeçalho + considerações determinísticas + 1 cartão por auditoria).
  // A síntese por IA ("líder preparando 1:1") NÃO é reproduzida — fica no octa-api.
  function qaRelatorioHtml(a, p) {
    const media = a.nScore ? a.somaScore / a.nScore : null;
    const crits = qaCriteriosOrdenados(a);
    const csatPill = (s) => s == null
      ? '<span class="qa-pill nr">CSAT n/r</span>'
      : `<span class="qa-pill ${s <= 2 ? "ruim" : s >= 4 ? "bom" : "neutro"}">CSAT ${s}/5</span>`;
    const lista = (arr) => (arr && arr.length)
      ? `<ul class="qa-lista">${arr.map((x) => `<li>${esc(String(x))}</li>`).join("")}</ul>` : "";
    const dias = a.itens.map((r) => r.dia).filter(Boolean).sort();
    const span = dias.length
      ? `Auditadas entre ${esc(KPIS.fmtDiaCurto(dias[0]))} e ${esc(KPIS.fmtDiaCurto(dias[dias.length - 1]))}`
      : `Período ${esc(KPIS.fmtDiaCurto(p.inicio))}–${esc(KPIS.fmtDiaCurto(p.fim))}`;
    const cabec = `
      <div class="qa-rel-cabec">
        <h2>${esc(a.nome)}</h2>
        <div class="qa-rel-meta">${span} · ${a.itens.length} auditoria(s) · Score médio ${media == null ? "—" : media.toFixed(1)}</div>
      </div>`;
    const consid = crits.length ? `
      <div class="qa-rel-consid">
        <h3>Critérios mais fracos (média das notas)</h3>
        <ol>${crits.slice(0, 5).map((c) => `<li>${esc(c.nome)} <b>${c.media.toFixed(1)}</b></li>`).join("")}</ol>
      </div>` : "";
    const cartoes = a.itens.map((r) => {
      const crit = (r.criterios || []).map((c) =>
        `<li><b>${esc(String(c.nome ?? ""))}</b> — ${c.nota == null ? "—" : esc(String(c.nota))}${c.comentario ? ": " + esc(String(c.comentario)) : ""}</li>`).join("");
      const bloco = (titulo, html) => html ? `<div class="qa-sub">${titulo}</div>${html}` : "";
      return `
        <div class="qa-cartao">
          <div class="qa-cartao-topo">
            <span class="qa-chat">Atendimento #${esc(String(r.chat_number ?? "—"))}</span>
            <span class="qa-data">${esc(KPIS.fmtDiaCurto(r.dia))}</span>
            ${csatPill(r.csat_score)}
            <span class="qa-score">Score ${r.score == null ? "—" : Number(r.score).toFixed(1)}</span>
          </div>
          ${r.assunto ? `<div class="qa-assunto">${esc(r.assunto)}</div>` : ""}
          ${bloco("Critérios", crit ? `<ul class="qa-criterios">${crit}</ul>` : "")}
          ${bloco("Pontos positivos", lista(r.pontos_positivos))}
          ${bloco("Pontos negativos", lista(r.pontos_negativos))}
          ${bloco("Insight", r.insight ? `<p class="qa-insight">${esc(r.insight)}</p>` : "")}
        </div>`;
    }).join("");
    return cabec + consid + `<div class="qa-cartoes">${cartoes}</div>`;
  }

  function abrirQaAnalista(id) {
    const a = estado.qaPorAnalista && estado.qaPorAnalista.get(id);
    if (!a) return;
    $("qaModalTitulo").textContent = `Relatório 1:1 — ${a.nome}`;
    $("qaModalBody").innerHTML = qaRelatorioHtml(a, periodo());
    $("qaModal").hidden = false;
    document.body.classList.add("qa-modal-aberto");
  }
  function fecharQaModal() {
    $("qaModal").hidden = true;
    document.body.classList.remove("qa-modal-aberto");
  }

  // ── Modal: tickets com SLA estourado de UM formulário (clique no badge da tabela) ──
  async function abrirTktModal(formName) {
    const f = estado.tktFiltro;
    if (!f) return;
    $("tktModalTitulo").textContent = `SLA estourado — ${formName}`;
    $("tktModalBody").innerHTML = `<div class="tkt-modal-empty">Carregando…</div>`;
    $("tktModal").hidden = false;
    let rows;
    try {
      rows = await API.ticketsSlaEstourado(f, formName);
    } catch (e) {
      console.error(e);
      $("tktModalBody").innerHTML = `<div class="tkt-modal-empty">Erro ao carregar os tickets.</div>`;
      return;
    }
    const horasH = (h) => (h == null ? "—" : KPIS.fmtHoras(h));
    const dia = (d) => (d ? KPIS.fmtDiaCurto(d) : "—");
    const hoje = new Date();
    // Atraso (arredondado em dias): fechado usa TMA; aberto usa idade até hoje. Ambos − alvo.
    const atraso = (r) => {
      if (r.alvo_horas == null) return "—";
      let excedenteH;
      if (r.fechado && r.tma_seg != null) excedenteH = r.tma_seg / 3600 - r.alvo_horas;
      else if (!r.fechado && r.created_dia)
        excedenteH = Math.floor((hoje - new Date(r.created_dia + "T00:00:00")) / 86400000) * 24 - r.alvo_horas;
      else return "—";
      return `<span class="tkt-modal-atraso">+${Math.max(0, Math.round(excedenteH / 24))}d</span>`;
    };
    const sub = `${rows.length} ticket(s) estourado(s) · ${dia(f.ini)} a ${dia(f.fim)}`
      + ` · ${f.porFechamento ? "por fechamento" : "por abertura"}`;
    const linhas = rows.map((r) => `
      <tr>
        <td>${r.ticket_number != null
          ? `<a class="tkt-link" href="https://app.octadesk.com/ticket/edit/${r.ticket_number}" target="_blank" rel="noopener noreferrer" title="Abrir no Octadesk">#${r.ticket_number}</a>`
          : "—"}</td>
        <td>${esc(r.status_name || "—")}</td>
        <td>${esc(r.assigned_name || "—")}</td>
        <td>${dia(r.created_dia)}</td>
        <td>${dia(r.closed_dia)}</td>
        <td class="num">${r.tma_seg != null ? horasH(r.tma_seg / 3600) : "—"}</td>
        <td class="num">${horasH(r.alvo_horas)}</td>
        <td class="num">${atraso(r)}</td>
      </tr>`).join("");
    $("tktModalBody").innerHTML = `
      <p class="tkt-modal-sub">${esc(sub)}</p>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Ticket</th><th>Status</th><th>Analista</th><th>Aberto</th><th>Fechado</th>
          <th class="num">TMA</th><th class="num">Alvo</th><th class="num">Atraso</th>
        </tr></thead>
        <tbody>${linhas || `<tr><td colspan="8" class="tkt-modal-empty">Nenhum ticket estourado no período.</td></tr>`}</tbody>
      </table></div>`;
  }
  function fecharTktModal() { $("tktModal").hidden = true; }

  const RENDERS = {
    performance: () => { renderPerformance(); renderDiaHora(); renderDistTma(); renderCategoriasPerf(); },
    bot: renderBot,
    tickets: renderTickets,
    categorias: renderCategorias,
    ranking: renderRanking,
    reincidencia: renderReincidencia,
    qa: renderQa,
  };

  const TITULOS = {
    performance: ["Performance de Atendimento", "KPIs de chats — volume, tempos, qualidade"],
    bot: ["Bot", "Contenção e resolução do bot — conversas antes de cair na fila humana"],
    tickets: ["Tickets", "Fluxo, formulários e status"],
    categorias: ["Por Categoria", "Volume, TMA e CSAT por categoria de atendimento"],
    ranking: ["Ranking de Analistas", "Score ponderado — filtre por data"],
    reincidencia: ["Reincidência", "Clientes que retornaram em até 7 dias"],
    qa: ["Auditoria de Qualidade", "Avaliação por IA dos atendimentos — visível só para a gestão"],
  };

  function render() {
    if (!estado.dados) return;
    aplicarTemaCharts();   // GRID/texto dos gráficos acompanham o tema atual (claro/escuro)
    const [t, s] = TITULOS[estado.secao];
    $("pageTitle").textContent = t;
    // Analista: personaliza o subtítulo com o nome (mesmos gráficos, dados só dele).
    const nome = estado.perfil && estado.perfil.agent_name;
    $("pageSubtitle").textContent = ehAnalista() ? `Meus indicadores${nome ? " — " + nome : ""}` : s;
    // Filtros de fila/tag/origem: só na Performance E só para a gestão (o analista vê o
    // total dele em todas as filas — não escolhe segmento).
    { const vis = (!ehAnalista() && estado.secao === "performance") ? "visible" : "hidden";
      $("filaMulti").style.visibility = vis;
      $("tagSelect").style.visibility = vis;
      $("origemSelect").style.visibility = vis;
      if (vis === "hidden") fecharFilaMulti(); }
    atualizarControlesData();
    RENDERS[estado.secao]();
    renderStatus();
  }

  // O toggle de tema (script inline no index.html) chama isto após trocar data-theme:
  // re-renderiza a seção ativa para os gráficos pegarem as novas cores (GRID/texto).
  window.onThemeChange = render;

  // Sincroniza os campos de data: define limites [minDia, maxDia] e, em modo
  // preset, espelha o período calculado (ponto de partida para editar).
  function atualizarControlesData() {
    const dias = estado.dados.chatsDia.map((r) => r.dia).sort();
    if (!dias.length) return;
    const minDia = dias[0], maxDia = dias[dias.length - 1];
    const di = $("dataInicio"), df = $("dataFim");
    di.min = df.min = minDia;
    di.max = df.max = maxDia;
    const custom = !!estado.range;
    const p = periodo();
    if (!custom && p) { di.value = p.inicio; df.value = p.fim; }
    $("dateRange").classList.toggle("active", custom);
    $("dateClear").classList.toggle("hidden", !custom);
  }

  function renderStatus() {
    const si = estado.dados.syncInfo;
    const box = $("syncStatus");
    const fmtDt = (iso) => (iso
      ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—");
    const stale12 = (iso) => iso && (Date.now() - new Date(iso).getTime()) / 3600000 > 12;

    if (!si) {
      if (box) box.textContent = "Sem info de sync";
      $("footerAtualizado").textContent = "";
      return;
    }

    const fmt = fmtDt(si.executado_em);           // banco local → Supabase (nosso sync)
    const fmtOrigem = fmtDt(si.origem_sync_em);   // API Octadesk → banco local (sync do octa-api)
    $("footerAtualizado").textContent =
      `Dados atualizados em ${fmt} · janela de ${si.janela_dias} dias`;
    if (box) {
      const linha = (lbl, valor, iso) =>
        `<div class="sync-line"><span class="sync-head">` +
        `<span class="status-dot${stale12(iso) ? " stale" : ""}"></span> ${lbl}</span>` +
        `<b>${valor}</b></div>`;
      const linhaDot = (lbl, valor, cls) =>
        `<div class="sync-line"><span class="sync-head">` +
        `<span class="status-dot${cls ? " " + cls : ""}"></span> ${lbl}</span>` +
        `<b>${valor}</b></div>`;
      const fmtBytes = (b) => {
        if (b == null) return "—";
        if (b < 1024) return `${b} B`;
        if (b < 1048576) return `${Math.round(b / 1024)} KB`;
        if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
        return `${(b / 1073741824).toFixed(2)} GB`;
      };
      let html =
        linha("Banco Oficial:", fmtOrigem, si.origem_sync_em) +
        linha("Banco Supabase:", fmt, si.executado_em);

      // Tamanho do banco (limite do plano free = 500 MB) — ponto verde/amarelo/vermelho por faixa.
      // Infra: só para a gestão (o analista não precisa/deve ver o status do banco).
      const LIMITE_MB = 500;
      if (!ehAnalista() && si.db_size_bytes != null) {
        const mb = si.db_size_bytes / 1048576;
        const pct = (mb / LIMITE_MB) * 100;
        const cls = pct >= 90 ? "crit" : pct >= 70 ? "stale" : "";
        html += linhaDot("Tamanho:", `${mb.toFixed(0)} / ${LIMITE_MB} MB (${pct.toFixed(0)}%)`, cls);
      }
      // Saúde de IO: cache hit % (100% = servido da RAM) + temp gerado desde o último sync
      // (sinal dos sorts em disco — o que disparou o alerta de Disk IO antes).
      if (!ehAnalista() && si.db_cache_hit_pct != null) {
        const cache = Number(si.db_cache_hit_pct);
        const delta = si.db_temp_bytes_delta;
        const tempAlto = delta != null && delta > 209715200; // > 200 MB desde o último sync
        const cls = cache < 95 || tempAlto ? "crit" : cache < 99 ? "stale" : "";
        const tempTxt = delta != null ? ` · temp ${fmtBytes(delta)}` : "";
        html += linhaDot("IO / cache:", `${cache.toFixed(2)}%${tempTxt}`, cls);
      }
      box.innerHTML = html;
    }
  }

  function popularFilas() {
    estado.gruposFila = construirGruposFila();
    const g = estado.gruposFila;
    const optsDe = (dim) => g.filter((x) => x.dim === dim)
      .map((x) => `<option value="${esc(x.slug)}">${esc(x.label)}</option>`).join("");
    // Filas = múltipla escolha (checkboxes); Tags e Origem = dropdowns únicos. Os três são
    // mutuamente exclusivos (escolher tag/origem zera as filas e vice-versa).
    $("filaMultiPanel").innerHTML = g.filter((x) => x.dim === "fila").map((x) =>
      `<label class="multi-opt"><input type="checkbox" value="${esc(x.slug)}"> ${esc(x.label)}</label>`
    ).join("");
    $("tagSelect").innerHTML = `<option value="">Tag…</option>` + optsDe("tag");
    $("origemSelect").innerHTML = `<option value="">Origem…</option>` + optsDe("origem");
    // Preserva a seleção anterior se os slugs ainda existirem; senão, volta para "todas".
    const existe = (s) => g.some((x) => x.slug === s);
    if (Array.isArray(estado.fila)) {
      const validos = estado.fila.filter(existe);
      estado.fila = validos.length ? validos : ["todas"];
    } else if (!existe(estado.fila)) {
      estado.fila = ["todas"];
    }
    sincronizarSeletores();
  }

  // Fila, tag e origem são mutuamente exclusivos — estado.fila guarda um ARRAY de slugs de
  // fila (multi) OU uma string de tag (tag:) OU de origem (orig:). Espelha o ativo nos controles.
  function sincronizarSeletores() {
    const s = estado.fila;
    const ehTag = typeof s === "string" && s.startsWith("tag:");
    const ehOrig = typeof s === "string" && s.startsWith("orig:");
    $("tagSelect").value = ehTag ? s : "";
    $("origemSelect").value = ehOrig ? s : "";
    atualizarFilaMulti();
  }

  // Reflete estado.fila nos checkboxes + rótulo do botão de filas. Quando a dimensão ativa é
  // tag/origem (estado.fila é string), o botão mostra o default "Todas as filas".
  function atualizarFilaMulti() {
    const painel = $("filaMultiPanel");
    if (!painel) return;
    const arr = Array.isArray(estado.fila) ? estado.fila : [];
    const marcados = new Set(arr.length ? arr : ["todas"]);
    painel.querySelectorAll("input[type=checkbox]").forEach((b) => { b.checked = marcados.has(b.value); });
    const especificas = [...marcados].filter((s) => s !== "todas");
    const full = especificas.map(filaLabel).join(" + ");
    const lbl = $("filaMultiLabel");
    if (lbl) lbl.textContent = !especificas.length ? "Todas as filas"
      : (full.length <= 32 ? full : `${especificas.length} filas`);
    const btn = $("filaMultiBtn");
    if (btn) btn.title = especificas.length ? full : "Todas as filas";
  }

  function fecharFilaMulti() {
    const painel = $("filaMultiPanel");
    if (painel && !painel.hidden) {
      painel.hidden = true;
      const btn = $("filaMultiBtn");
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  }

  // ── Cache local (degradação graciosa) ──
  // Guarda o último carregamento OK no navegador. Se o Supabase estiver lento/fora, o
  // painel mostra os últimos dados salvos (com aviso) em vez de tela em branco. Só reutiliza
  // o cache do MESMO usuário; é limpo no logout (não vaza dado entre logins no mesmo PC).
  const CACHE_KEY = "cplug-cache-dados";
  function salvarCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        ts: Date.now(), email: estado.perfil && estado.perfil.email, dados: estado.dados,
      }));
    } catch (e) { /* cota/serialização: cache é best-effort */ }
  }
  function lerCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!c || !c.dados || !estado.perfil || c.email !== estado.perfil.email) return null;
      return c;
    } catch (e) { return null; }
  }
  // Reconstrói os grupos de fila/segmento a partir de estado.dados (sem rede) — usado no
  // load normal e no fallback do cache.
  function reconstruirSegmentos() {
    if (ehAnalista()) {
      estado.gruposFila = [{ slug: "eu", label: "Meus indicadores", membros: ["eu"], dim: "fila" }];
      estado.fila = "eu";
    } else {
      popularFilas();
    }
  }

  let ultimaCarga = 0;   // timestamp da última carga OK — evita refetch a cada troca de aba
  async function carregar() {
    try {
      if (ehAnalista()) {
        estado.dados = await API.carregarTudoAnalista();   // RLS escopa ao próprio analista
        reconstruirSegmentos();
        popularTktFiltros();   // formulários/status; o dropdown de analista fica escondido
      } else {
        estado.dados = await API.carregarTudo();
        reconstruirSegmentos();
        popularTktFiltros();   // dropdowns de tickets (formulários/analistas via RPC)
      }
      $("errorBanner").classList.add("hidden");
      $("errorBanner").classList.remove("offline");
      render();
      ultimaCarga = Date.now();
      salvarCache();                       // guarda p/ degradação graciosa
    } catch (e) {
      console.error(e);
      const cache = lerCache();
      if (cache) {
        // Supabase lento/fora → exibe o último dado salvo em vez de tela em branco.
        estado.dados = cache.dados;
        reconstruirSegmentos();
        render();
        const quando = new Date(cache.ts).toLocaleString("pt-BR",
          { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        const b = $("errorBanner");
        b.textContent = `⚠ Sem conexão com o servidor agora — exibindo os últimos dados salvos (${quando}). Atualize (F5) quando o servidor voltar.`;
        b.classList.add("offline");
        b.classList.remove("hidden");
      } else {
        const b = $("errorBanner");
        b.classList.remove("offline");
        b.textContent = "Não foi possível carregar os dados. Tente novamente em instantes. (" + e.message + ")";
        b.classList.remove("hidden");
        $("syncStatus").textContent = "Erro ao carregar";
      }
    }
  }

  // ── Tooltip dos ícones "i" dos KPIs (hoje só na seção Bot) ──
  // A caixa é anexada ao <body> porque o card tem overflow:hidden (cortaria um ::after).
  // Delegação no document: funciona p/ qualquer .kpi-info[data-tip], em hover, foco e toque.
  (function initKpiTips() {
    let tip = null;
    const mostrar = (el) => {
      if (!tip) { tip = document.createElement("div"); tip.className = "kpi-tip"; document.body.appendChild(tip); }
      tip.innerHTML = el.dataset.tip || "";
      tip.classList.add("show");
      const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
      let left = r.left + r.width / 2 - t.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
      let top = r.top - t.height - 8;
      if (top < 8) top = r.bottom + 8;                 // sem espaço acima → mostra abaixo
      tip.style.left = `${left}px`; tip.style.top = `${top}px`;
    };
    const esconder = () => { if (tip) tip.classList.remove("show"); };
    document.addEventListener("mouseover", (e) => { const el = e.target.closest(".kpi-info"); if (el) mostrar(el); });
    document.addEventListener("mouseout", (e) => { if (e.target.closest(".kpi-info")) esconder(); });
    document.addEventListener("focusin", (e) => { const el = e.target.closest(".kpi-info"); if (el) mostrar(el); });
    document.addEventListener("focusout", (e) => { if (e.target.closest(".kpi-info")) esconder(); });
    document.addEventListener("click", (e) => {       // toque no mobile: abre; toque fora: fecha
      const el = e.target.closest(".kpi-info");
      if (el) { e.stopPropagation(); mostrar(el); } else esconder();
    });
    window.addEventListener("scroll", esconder, true);
  })();

  // ── Eventos ──
  $("nav").addEventListener("click", (e) => {
    const item = e.target.closest(".nav-item");
    if (!item) return;
    document.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
    item.classList.add("active");
    estado.secao = item.dataset.section;
    document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
    $("sec-" + estado.secao).classList.add("active");
    render();
    if (window.innerWidth <= 768) fecharSidebar();
  });

  // ── Busca por analista (autocomplete via datalist) ──
  $("qaBusca").addEventListener("input", filtrarQaTabela);

  // ── Modal do relatório 1:1 de Auditoria QA ──
  $("tabelaQaAnalistas").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-analista]");
    if (tr) abrirQaAnalista(tr.dataset.analista);
  });
  $("tabelaQaAnalistas").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-analista]");
    if (tr) { e.preventDefault(); abrirQaAnalista(tr.dataset.analista); }
  });
  $("qaModalFechar").addEventListener("click", fecharQaModal);
  $("qaModalPdf").addEventListener("click", () => window.print());
  $("qaModal").addEventListener("click", (e) => { if (e.target === $("qaModal")) fecharQaModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("qaModal").hidden) fecharQaModal();
  });

  // Modal de SLA estourado: clique no badge da tabela abre; ✕/overlay/Esc fecham.
  $("tabelaTktForm").addEventListener("click", (e) => {
    const b = e.target.closest(".sla-badge");
    if (b) abrirTktModal(b.dataset.form);
  });
  $("tktModalFechar").addEventListener("click", fecharTktModal);
  $("tktModal").addEventListener("click", (e) => { if (e.target === $("tktModal")) fecharTktModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("tktModal").hidden) fecharTktModal();
  });

  $("periodoTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    document.querySelectorAll("#periodoTabs .tab").forEach((x) => x.classList.remove("active"));
    tab.classList.add("active");
    estado.preset = tab.dataset.preset;
    estado.range = null;            // sai do modo personalizado
    render();
  });

  // ── Período personalizado (data inicial/final) ──
  function aplicarDatas() {
    const a = $("dataInicio").value, b = $("dataFim").value;
    if (!a || !b) return;                       // precisa das duas datas
    estado.range = a <= b ? { inicio: a, fim: b } : { inicio: b, fim: a };
    document.querySelectorAll("#periodoTabs .tab").forEach((x) => x.classList.remove("active"));
    render();
  }
  $("dataInicio").addEventListener("change", aplicarDatas);
  $("dataFim").addEventListener("change", aplicarDatas);
  $("dateClear").addEventListener("click", () => {
    estado.range = null;
    const tab = document.querySelector(`#periodoTabs .tab[data-preset="${estado.preset}"]`);
    if (tab) tab.classList.add("active");
    render();
  });

  // Filas (multi), tags e origem são mutuamente exclusivos: escolher um zera os outros.
  // Abre/fecha o painel de filas.
  $("filaMultiBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const painel = $("filaMultiPanel");
    const abrir = painel.hidden;
    painel.hidden = !abrir;
    e.currentTarget.setAttribute("aria-expanded", String(abrir));
  });
  // Clique fora do seletor fecha o painel.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#filaMulti")) fecharFilaMulti();
  });
  // Marcar/desmarcar filas soma as selecionadas. "Todas as filas" é exclusiva (zera as demais);
  // marcar uma fila específica destrava de "todas". Nada marcado → volta para "todas".
  $("filaMultiPanel").addEventListener("change", (e) => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    const set = new Set(Array.isArray(estado.fila) ? estado.fila : []);
    if (cb.checked) {
      if (cb.value === "todas") { set.clear(); set.add("todas"); }
      else { set.delete("todas"); set.add(cb.value); }
    } else {
      set.delete(cb.value);
    }
    let sel = [...set];
    if (!sel.length) sel = ["todas"];
    estado.fila = sel;
    $("tagSelect").value = "";
    $("origemSelect").value = "";
    atualizarFilaMulti();
    render();
  });

  $("tagSelect").addEventListener("change", (e) => {
    estado.fila = e.target.value || ["todas"];   // vazio = volta para todas as filas
    $("origemSelect").value = "";
    atualizarFilaMulti();
    render();
  });

  $("origemSelect").addEventListener("change", (e) => {
    estado.fila = e.target.value || ["todas"];
    $("tagSelect").value = "";
    atualizarFilaMulti();
    render();
  });

  // ── Filtros de Tickets (formulário/status/analista + toggle abertura/fechamento) ──
  $("tktForm").addEventListener("change", (e) => { estado.tkt.form = e.target.value; renderTickets(); });
  $("tktStatus").addEventListener("change", (e) => { estado.tkt.status = e.target.value; renderTickets(); });
  $("tktAnalista").addEventListener("change", (e) => { estado.tkt.analista = e.target.value; renderTickets(); });
  $("tktIssue").addEventListener("change", (e) => { estado.tkt.issue = e.target.value; renderTickets(); });
  $("tktModoTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    document.querySelectorAll("#tktModoTabs .tab").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    estado.tkt.porFechamento = btn.dataset.fech === "1";
    renderTickets();
  });
  $("btnExportDistTma").addEventListener("click", exportarDistTma);
  $("btnExportTktForm").addEventListener("click", () => {
    baixarCSV("tickets_por_formulario.csv",
      ["Formulário", "Total", "Em aberto", "Fechados", "TMA (h)", "SLA alvo (h)", "% no SLA", "SLA estourado"],
      (estado.tktExport.forms || []).map((r) => [
        r.form_name, r.total, r.em_aberto, r.fechados,
        r.tma_mediana_h != null ? r.tma_mediana_h.toFixed(1) : "",
        r.alvo_horas != null ? r.alvo_horas : "",
        r.pct_dentro_sla != null ? r.pct_dentro_sla.toFixed(2) : "",
        r.alvo_horas != null ? (r.sla_estourado || 0) : "",
      ]));
  });
  $("btnExportTktRanking").addEventListener("click", () => {
    baixarCSV("ranking_analistas.csv",
      ["#", "Analista", "Produtividade", "Qualidade (%)", "SLA (%)", "Média final"],
      (estado.tktExport.ranking || []).map((r) => [
        r.posicao, r.assigned_name, r.produtividade,
        (100 * (r.qualidade_frac || 0)).toFixed(2),
        r.sla_pct != null ? r.sla_pct.toFixed(2) : "",
        (r.media_final != null ? r.media_final.toFixed(2) : ""),
      ]));
  });

  // ── Ranking (gestão): ordenar por clique no cabeçalho (vale pras 2 categorias) + Excel ──
  $("rankingGestao").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th || ehAnalista()) return;
    const col = th.dataset.col;
    if (estado.rankingSort.col === col) {
      estado.rankingSort.dir = estado.rankingSort.dir === "asc" ? "desc" : "asc";
    } else {
      estado.rankingSort = { col, dir: "asc" };   // nova coluna começa crescente
    }
    pintarRanking();
  });
  $("btnExportRanking").addEventListener("click", () => {
    const p = periodo();
    const per = p ? `${p.inicio}_a_${p.fim}` : "periodo";
    const num1 = (v) => (v == null ? "" : v.toFixed(1).replace(".", ","));   // minutos (TMA)
    const num2 = (v) => (v == null ? "" : v.toFixed(2).replace(".", ","));   // percentuais (2 casas)
    const sorted = estado.rankingSorted || [];
    const catLabel = { est_conv: "Est+Conv", especializado: "Especializado", outros: "—" };
    const linhas = [];
    if (estado.rankingView === "geral") {
      // Geral: lista corrida de todo o Suporte (a categoria vai só como referência).
      sorted.forEach((a, i) => linhas.push([
        catLabel[a.categoria] || "—", i + 1, a.nome, num2(a.focoPct), a.volume,
        num2(a.participacaoPct), num2(a.engajamentoPct),
        num2(a.csatPct), num2(a.resolvidosPct), num1(a.tmaMin),
      ]));
    } else {
      [["Fila estendido + convencional", sorted.filter((a) => a.categoria !== "especializado")],
       ["Fila Especializado", sorted.filter((a) => a.categoria === "especializado")],
      ].forEach(([cat, grupo]) => grupo.forEach((a, i) => linhas.push([
        cat, i + 1, a.nome, num2(a.focoPct), a.volume,
        num2(a.participacaoPct), num2(a.engajamentoPct),
        num2(a.csatPct), num2(a.resolvidosPct), num1(a.tmaMin),
      ])));
    }
    baixarCSV(`ranking_analistas_${per}.csv`,
      ["Categoria", "#", "Analista", "Foco na fila (%)", "Volume", "Participação (%)",
       "Engajamento (%)", "CSAT (%)", "Resolvidos (%)", "TMA (min)"],
      linhas);
  });
  // Alterna a visão do ranking (gestão): "Por fila" (2 categorias) ↔ "Geral" (todo o Suporte).
  $("rankingViewTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    estado.rankingView = btn.dataset.view;
    document.querySelectorAll("#rankingViewTabs .tab").forEach((t) => t.classList.toggle("active", t === btn));
    $("rankingPorFila").hidden = estado.rankingView !== "fila";
    $("rankingGeral").hidden = estado.rankingView !== "geral";
  });

  // ── Sidebar mobile ──
  const sidebar = $("sidebar"), overlay = $("overlay");
  function fecharSidebar() { sidebar.classList.remove("open"); overlay.classList.remove("open"); }
  $("hamburger").addEventListener("click", () => {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("open");
  });
  overlay.addEventListener("click", fecharSidebar);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharSidebar(); });

  // ── Autenticação (Supabase Auth) + boot ──
  // A dashboard só carrega dados com sessão válida. Isto NÃO é só visual: o RLS
  // do Supabase bloqueia qualquer leitura sem usuário autenticado (o papel anon
  // não tem SELECT nas tabelas). A tela de login começa visível no HTML.
  const cliente = API.cliente;
  let logado = false;

  // Espera o load completo (CSS aplicado) antes do 1º render — sem isso o
  // Chart.js pode medir os containers com largura 0 e travar os gráficos.
  const documentoPronto = (async () => {
    if (document.readyState !== "complete") {
      await new Promise((res) => window.addEventListener("load", res, { once: true }));
    }
    await new Promise((res) => setTimeout(res, 0));
  })();

  function mostrarLogin(mostrar) {
    $("loginScreen").classList.toggle("hidden", !mostrar);
  }

  async function iniciarSessao() {
    mostrarLogin(false);
    await documentoPronto;
    // Busca o perfil ANTES de carregar: decide o modo (gestão vs analista) e a fonte
    // de dados. Se falhar/for nulo, cai no modo gestão (a RLS ainda barra o que não pode).
    try { estado.perfil = await API.meuPerfil(); }
    catch (e) { console.error(e); estado.perfil = null; }
    aplicarModoPapel();
    await carregar();
  }

  // Ajusta a navegação/UI conforme o papel: analista não vê Reincidência (não se aplica)
  // e ganha a classe body.modo-analista (esconde dropdown de analista e ranking de tickets).
  function aplicarModoPapel() {
    const analista = ehAnalista();
    document.body.classList.toggle("modo-analista", analista);
    const navReinc = document.querySelector('.nav-item[data-section="reincidencia"]');
    if (navReinc) navReinc.style.display = analista ? "none" : "";
    if (analista && estado.secao === "reincidencia") {
      estado.secao = "performance";
      document.querySelectorAll(".nav-item").forEach((x) =>
        x.classList.toggle("active", x.dataset.section === "performance"));
      document.querySelectorAll(".section").forEach((s) =>
        s.classList.toggle("active", s.id === "sec-performance"));
    }
  }

  function encerrarSessao() {
    estado.dados = null;
    estado.perfil = null;
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}   // não vaza dado entre logins no mesmo PC
    mostrarLogin(true);
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("loginEmail").value.trim();
    const senha = $("loginPassword").value;
    const btn = $("loginBtn"), erro = $("loginError");
    erro.classList.add("hidden");
    btn.disabled = true; btn.textContent = "Entrando…";
    const { error } = await cliente.auth.signInWithPassword({ email, password: senha });
    btn.disabled = false; btn.textContent = "Entrar";
    if (error) {
      erro.textContent = "E-mail ou senha inválidos.";
      erro.classList.remove("hidden");
    } else {
      $("loginPassword").value = "";
    }
    // Sucesso é tratado por onAuthStateChange.
  });

  $("btnSair").addEventListener("click", () => cliente.auth.signOut());

  // Dispara no boot (sessão inicial), no login e no logout. Não chamar métodos
  // supabase com await direto aqui (risco de deadlock) — o setTimeout defere.
  cliente.auth.onAuthStateChange((_evento, sessao) => {
    const agora = !!sessao;
    if (agora === logado) return;
    logado = agora;
    setTimeout(() => { if (agora) iniciarSessao(); else encerrarSessao(); }, 0);
  });

  // Sem polling periódico e SEM refetch a cada troca de aba: os dados só mudam no sync
  // (~1x/dia). Ao voltar pra aba, só recarrega se a última carga está VELHA (> 30 min) —
  // evita rebater a cada alt-tab (economia de IO no Supabase). F5 sempre força dados frescos.
  const REFRESH_VELHO_MS = 30 * 60 * 1000;
  document.addEventListener("visibilitychange", () => {
    if (logado && document.visibilityState === "visible"
        && Date.now() - ultimaCarga > REFRESH_VELHO_MS) carregar();
  });
})();
