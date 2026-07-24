// ══════════════════════════════════════════════════════════════
// Dashboard pública CPlug Suporte — estado, filtros e renderização.
// Dados: tabelas agg_* do Supabase (janela móvel de ~120 dias).
// ══════════════════════════════════════════════════════════════

(() => {
  const estado = {
    dados: null,
    preset: "hoje",    // hoje | ontem | semana (dom–sáb) | mes — âncora = último dia com dados
    range: null,       // {inicio, fim} quando período personalizado ativo
    fila: "todas",
    secao: "performance",
    rankingMes: null,
    tkt: { form: "", status: "", analista: "", porFechamento: false },  // filtros de tickets
    tktExport: { forms: [], ranking: [] },                              // último resultado p/ CSV
  };

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

  function membrosDaFila(slug) {
    const g = (estado.gruposFila || []).find((x) => x.slug === slug);
    return g ? g.membros : [slug];
  }

  // Linhas diárias da fila (somando os membros do grupo) — uma linha por dia.
  function linhasFilaPorDia(slug, ini, fim) {
    const membros = new Set(membrosDaFila(slug));
    const porDia = new Map();
    for (const r of estado.dados.chatsDia) {
      if (!membros.has(r.fila_slug) || !entre(r.dia, ini, fim)) continue;
      let acc = porDia.get(r.dia);
      if (!acc) {
        acc = { dia: r.dia, fila_slug: slug };
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
    setar("kpiAbandono", KPIS.fmtPct(k.abandonoPct, 1));
    setar("kpiCsat", KPIS.fmtPct(k.csatPct, 1));
    setar("kpiResolvidos", KPIS.fmtPct(k.resolvidosPct, 1));

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
    setar("kpiAbandonoAnt", KPIS.fmtPct(kAnt.abandonoPct, 1));
    setar("kpiCsatAnt", KPIS.fmtPct(kAnt.csatPct, 1));
    setar("kpiResolvidosAnt", KPIS.fmtPct(kAnt.resolvidosPct, 1));

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
    if (stats) stats.innerHTML =
      `${periodoLbl} · ${filaLabel(estado.fila)} · Média <b>${min1(media)}</b> · ` +
      `P50 <b>${min1(p50)}</b> · P90 <b>${min1(p90)}</b> · P95 <b>${min1(p95)}</b> · n <b>${KPIS.fmtInt(n)}</b>`;
    novoChart("chartTmaDistP", {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: counts,
          backgroundColor: "rgba(139,92,246,0.8)", borderRadius: 7, borderSkipped: false,
        }],
      },
      options: opts({ y: { beginAtZero: true, grace: "12%" } }),
      plugins: [rotuloBarras],
    });
  }

  // Preenche uma tabela de categorias somando o período a partir de agg_categorias_dia.
  // TMA: mediana exata quando o filtro é um único dia; senão média ponderada.
  let categoriasReqSeq = 0;   // guarda de corrida (descarta resposta obsoleta da RPC)

  async function preencherCategorias(tabelaId, subId, limite) {
    const tabela = $(tabelaId);
    if (!tabela) return;
    const p = periodo();
    if (!p) return;
    const meuSeq = ++categoriasReqSeq;
    const membros = membrosDaFila(estado.fila);
    let cats;
    try {
      cats = await API.categoriasPeriodo(membros, p.inicio, p.fim);
    } catch (e) {
      console.error(e);
      return;
    }
    if (meuSeq !== categoriasReqSeq) return;   // filtro/período mudou: resposta velha
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
        <td class="num">${c.csat_respondidos ? KPIS.fmtPct(100 * c.csat_satisfeitos / c.csat_respondidos) : "—"}</td>
        <td class="num">${KPIS.fmtInt(c.csat_respondidos)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="empty-note">Sem dados no período</td></tr>`;
  }

  function renderCategoriasPerf() {
    preencherCategorias("tabelaCategoriasP", "subCategoriasP", 10);
  }

  // ══════════════ DIA X HORA ══════════════

  let diaHoraReqSeq = 0;   // guarda de corrida (descarta resposta obsoleta da RPC)

  async function renderDiaHora() {
    const p = periodo();
    if (!p) return;
    const meuSeq = ++diaHoraReqSeq;
    let linhas;   // linhas agregadas por (dow, hora) vindas da RPC
    try {
      linhas = await API.chatsHoraPeriodo(membrosDaFila(estado.fila), p.inicio, p.fim);
    } catch (e) {
      console.error(e);
      return;
    }
    if (meuSeq !== diaHoraReqSeq) return;   // filtro/período mudou: resposta velha

    // Heatmap DOW × hora
    const grade = Array.from({ length: 7 }, () => Array(24).fill(0));
    const tmePorHora = Array.from({ length: 24 }, () => ({ soma: 0, n: 0 }));
    const tmaPorHora = Array.from({ length: 24 }, () => ({ soma: 0, n: 0 }));
    const csatPorHora = Array.from({ length: 24 }, () => ({ resp: 0, sat: 0, rsim: 0, rtot: 0 }));
    const volPorHora = Array(24).fill(0);
    const tmeMinPorHora = Array(24).fill(null);   // menor TME (min dos mínimos diários)
    const tmeMaxPorHora = Array(24).fill(null);   // maior TME (max dos máximos diários)
    const analistasPorHora = Array.from({ length: 24 }, () => new Set());  // distintos no período
    for (const r of linhas) {
      grade[r.dow][r.hora] += r.volume;             // dow (0=Dom) já vem do banco
      volPorHora[r.hora] += r.volume;
      tmePorHora[r.hora].soma += r.tme_soma_seg || 0;
      tmePorHora[r.hora].n += r.tme_n || 0;
      tmaPorHora[r.hora].soma += r.tma_soma_seg || 0;
      tmaPorHora[r.hora].n += r.tma_n || 0;
      const c = csatPorHora[r.hora];
      c.resp += r.csat_respondidos || 0;
      c.sat += r.csat_satisfeitos || 0;
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
          { label: "CSAT %", data: hs.map((h) => pctH(csatPorHora[h].sat, csatPorHora[h].resp)),
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

    // ── TME × TMA por hora (barras agrupadas, eixo duplo) — paridade com o octa-api v2 ──
    novoChart("chartTmeTmaHora", {
      type: "bar",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [
          { label: "TME", data: hs.map((h) => minH(tmePorHora[h])), yAxisID: "yTme",
            backgroundColor: "rgba(16,185,129,0.6)", borderColor: "#10b981", borderWidth: 1, borderRadius: 4 },
          { label: "TMA", data: hs.map((h) => minH(tmaPorHora[h])), yAxisID: "yTma",
            backgroundColor: "rgba(99,102,241,0.55)", borderColor: "#6366f1", borderWidth: 1, borderRadius: 4 },
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
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : KPIS.fmtDuracao(ctx.parsed.y * 60)}`,
              afterBody: (items) => {
                const h = hs[items[0].dataIndex];
                return [
                  `TME menor/maior: ${KPIS.fmtDuracao(tmeMinPorHora[h])} / ${KPIS.fmtDuracao(tmeMaxPorHora[h])}`,
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
          { label: "CSAT %", data: hs.map((h) => pctH(csatPorHora[h].sat, csatPorHora[h].resp)),
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
        scales: { x: { grid: { color: GRID } }, y: { grid: { color: GRID }, beginAtZero: true } },
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
      ini: p.inicio, fim: p.fim, porFechamento: t.porFechamento,
    };
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
      </tr>`).join("") || `<tr><td colspan="7" class="empty-note">Sem dados no período</td></tr>`;

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
    $("tktAnalista").innerHTML = opt("", "Todos os analistas") + (ops.analistas || []).map((n) => opt(n, n)).join("");
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

  // ══════════════ CATEGORIAS ══════════════

  function renderCategorias() {
    const p = periodo();
    if (!p) return;
    preencherCategorias("tabelaCategorias", "subCategorias", 20);
  }

  // ══════════════ RANKING ══════════════

  function renderRanking() {
    const meses = [...new Set(estado.dados.agentesMes.map((r) => r.mes))].sort().reverse();
    const sel = $("rankingMes");
    if (sel.options.length !== meses.length) {
      sel.innerHTML = meses.map((m) => `<option value="${m}">${KPIS.fmtMes(m)}</option>`).join("");
    }
    if (!estado.rankingMes || !meses.includes(estado.rankingMes)) estado.rankingMes = meses[0];
    sel.value = estado.rankingMes;

    const linhas = estado.dados.agentesMes.filter((r) => r.mes === estado.rankingMes);
    const totalVolume = KPIS.soma(linhas, "volume") || 1;

    const analistas = linhas.map((r) => {
      const tmaMin = r.tma_n ? r.tma_soma_seg / r.tma_n / 60 : null;
      const a = {
        nome: r.agent_name,
        volume: r.volume,
        participacaoPct: 100 * r.volume / totalVolume,
        engajamentoPct: r.volume > 0 ? 100 * r.csat_respondidos / r.volume : null,
        csatPct: r.csat_respondidos > 0 ? 100 * r.csat_satisfeitos / r.csat_respondidos : null,
        resolvidosPct: r.resolvidos_total > 0 ? 100 * r.resolvidos_sim / r.resolvidos_total : null,
        tmaMin,
      };
      a.score = KPIS.scoreRanking(a, CONFIG.PESOS, CONFIG.TMA_LIMITE_MIN);
      return a;
    }).sort((a, b) => b.score - a.score);

    $("tabelaRanking").querySelector("tbody").innerHTML = analistas.map((a, i) => `
      <tr>
        <td><span class="pos-badge ${i < 3 ? "top" + (i + 1) : ""}">${i + 1}</span></td>
        <td>${esc(a.nome)}</td>
        <td class="num"><strong>${a.score.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</strong></td>
        <td class="num">${KPIS.fmtInt(a.volume)}</td>
        <td class="num">${KPIS.fmtPct(a.participacaoPct)}</td>
        <td class="num">${KPIS.fmtPct(a.engajamentoPct)}</td>
        <td class="num">${KPIS.fmtPct(a.csatPct)}</td>
        <td class="num">${KPIS.fmtPct(a.resolvidosPct)}</td>
        <td class="num">${a.tmaMin !== null ? KPIS.fmtDuracao(a.tmaMin * 60) : "—"}</td>
      </tr>`).join("") || `<tr><td colspan="9" class="empty-note">Sem dados</td></tr>`;
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

  function filaLabel(slug) {
    const g = (estado.gruposFila || []).find((x) => x.slug === slug);
    if (g) {
      const sufixo = g.dim === "tag" ? " (tag)" : g.dim === "origem" ? " (origem)" : "";
      return g.label + sufixo;
    }
    const r = estado.dados.chatsDia.find((x) => x.fila_slug === slug);
    return r ? r.fila_label : slug;
  }

  const RENDERS = {
    performance: () => { renderPerformance(); renderDiaHora(); renderDistTma(); renderCategoriasPerf(); },
    tickets: renderTickets,
    categorias: renderCategorias,
    ranking: renderRanking,
    reincidencia: renderReincidencia,
  };

  const TITULOS = {
    performance: ["Performance de Atendimento", "KPIs de chats — volume, tempos, qualidade"],
    tickets: ["Tickets", "Fluxo, formulários e status"],
    categorias: ["Por Categoria", "Volume, TMA e CSAT por categoria de atendimento"],
    ranking: ["Ranking de Analistas", "Score ponderado mensal"],
    reincidencia: ["Reincidência", "Clientes que retornaram em até 7 dias"],
  };

  function render() {
    if (!estado.dados) return;
    aplicarTemaCharts();   // GRID/texto dos gráficos acompanham o tema atual (claro/escuro)
    const [t, s] = TITULOS[estado.secao];
    $("pageTitle").textContent = t;
    $("pageSubtitle").textContent = s;
    // Filtros de fila/tag/origem só se aplicam à seção Performance
    { const vis = estado.secao === "performance" ? "visible" : "hidden";
      $("filaSelect").style.visibility = vis;
      $("tagSelect").style.visibility = vis;
      $("origemSelect").style.visibility = vis; }
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
      `Dados atualizados em ${fmt} · janela de ${si.janela_dias} dias · atualização automática a cada 5 min`;
    if (box) {
      const linha = (lbl, valor, iso) =>
        `<div class="sync-line"><span class="sync-head">` +
        `<span class="status-dot${stale12(iso) ? " stale" : ""}"></span> ${lbl}</span>` +
        `<b>${valor}</b></div>`;
      box.innerHTML =
        linha("Banco Oficial:", fmtOrigem, si.origem_sync_em) +
        linha("Banco Supabase:", fmt, si.executado_em);
    }
  }

  function popularFilas() {
    estado.gruposFila = construirGruposFila();
    const g = estado.gruposFila;
    const optsDe = (dim) => g.filter((x) => x.dim === dim)
      .map((x) => `<option value="${esc(x.slug)}">${esc(x.label)}</option>`).join("");
    // Três dropdowns independentes: Filas, Tags, Origem (mutuamente exclusivos).
    $("filaSelect").innerHTML = optsDe("fila");
    $("tagSelect").innerHTML = `<option value="">Tag…</option>` + optsDe("tag");
    $("origemSelect").innerHTML = `<option value="">Origem…</option>` + optsDe("origem");
    if (!g.some((x) => x.slug === estado.fila)) estado.fila = "todas";
    sincronizarSeletores();
  }

  // Fila, tag e origem são mutuamente exclusivos — estado.fila guarda um slug de fila
  // OU de tag (tag:) OU de origem (orig:). Espelha o slug ativo nos três dropdowns.
  function sincronizarSeletores() {
    const s = estado.fila;
    $("filaSelect").value = s.includes(":") ? "todas" : s;
    $("tagSelect").value = s.startsWith("tag:") ? s : "";
    $("origemSelect").value = s.startsWith("orig:") ? s : "";
  }

  async function carregar() {
    try {
      estado.dados = await API.carregarTudo();
      $("errorBanner").classList.add("hidden");
      popularFilas();
      popularTktFiltros();     // dropdowns de tickets (formulários/analistas via RPC)
      render();
    } catch (e) {
      console.error(e);
      $("errorBanner").textContent =
        "Não foi possível carregar os dados. Tente novamente em instantes. (" + e.message + ")";
      $("errorBanner").classList.remove("hidden");
      $("syncStatus").textContent = "Erro ao carregar";
    }
  }

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

  // Filas, tags e origem são mutuamente exclusivos: escolher um zera os outros dois.
  $("filaSelect").addEventListener("change", (e) => {
    estado.fila = e.target.value;
    $("tagSelect").value = "";
    $("origemSelect").value = "";
    render();
  });

  $("tagSelect").addEventListener("change", (e) => {
    estado.fila = e.target.value || "todas";   // vazio = volta para todas as filas
    $("filaSelect").value = "todas";
    $("origemSelect").value = "";
    render();
  });

  $("origemSelect").addEventListener("change", (e) => {
    estado.fila = e.target.value || "todas";
    $("filaSelect").value = "todas";
    $("tagSelect").value = "";
    render();
  });

  $("rankingMes").addEventListener("change", (e) => {
    estado.rankingMes = e.target.value;
    renderRanking();
  });

  // ── Filtros de Tickets (formulário/status/analista + toggle abertura/fechamento) ──
  $("tktForm").addEventListener("change", (e) => { estado.tkt.form = e.target.value; renderTickets(); });
  $("tktStatus").addEventListener("change", (e) => { estado.tkt.status = e.target.value; renderTickets(); });
  $("tktAnalista").addEventListener("change", (e) => { estado.tkt.analista = e.target.value; renderTickets(); });
  $("tktModoTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    document.querySelectorAll("#tktModoTabs .tab").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    estado.tkt.porFechamento = btn.dataset.fech === "1";
    renderTickets();
  });
  $("btnExportTktForm").addEventListener("click", () => {
    baixarCSV("tickets_por_formulario.csv",
      ["Formulário", "Total", "Em aberto", "Fechados", "TMA (h)", "SLA alvo (h)", "% no SLA"],
      (estado.tktExport.forms || []).map((r) => [
        r.form_name, r.total, r.em_aberto, r.fechados,
        r.tma_mediana_h != null ? r.tma_mediana_h.toFixed(1) : "",
        r.alvo_horas != null ? r.alvo_horas : "",
        r.pct_dentro_sla != null ? r.pct_dentro_sla.toFixed(1) : "",
      ]));
  });
  $("btnExportTktRanking").addEventListener("click", () => {
    baixarCSV("ranking_analistas.csv",
      ["#", "Analista", "Produtividade", "Qualidade (%)", "SLA (%)", "Média final"],
      (estado.tktExport.ranking || []).map((r) => [
        r.posicao, r.assigned_name, r.produtividade,
        (100 * (r.qualidade_frac || 0)).toFixed(2),
        r.sla_pct != null ? r.sla_pct.toFixed(1) : "",
        (r.media_final != null ? r.media_final.toFixed(2) : ""),
      ]));
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
    await carregar();
  }

  function encerrarSessao() {
    estado.dados = null;
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

  // Sem polling periódico: os dados só mudam no sync (~3-4x/dia). Atualiza ao voltar
  // pra aba (visibilitychange); recarregar a página (F5) força dados frescos na hora.
  document.addEventListener("visibilitychange", () => {
    if (logado && document.visibilityState === "visible") carregar();
  });
})();
