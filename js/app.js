// ══════════════════════════════════════════════════════════════
// Dashboard pública CPlug Suporte — estado, filtros e renderização.
// Dados: tabelas agg_* do Supabase (janela móvel de ~120 dias).
// ══════════════════════════════════════════════════════════════

(() => {
  const estado = {
    dados: null,
    dias: 30,          // 0 = janela completa
    range: null,       // {inicio, fim} quando período personalizado ativo
    fila: "todas",
    secao: "performance",
    rankingMes: null,
  };

  const charts = {};   // registry de instâncias Chart.js

  const $ = (id) => document.getElementById(id);

  Chart.defaults.font = { family: "Inter", size: 11 };
  Chart.defaults.color = "#8893aa";
  const GRID = "rgba(255,255,255,0.05)";

  function novoChart(id, cfg) {
    const el = $(id);
    if (!el) return;   // canvas ausente no HTML (layout enxuto) → ignora
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(el, cfg);
  }

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
    if (estado.dias === 0) return { inicio: minDia, fim: maxDia, minDia };
    const d = new Date(maxDia + "T00:00:00");
    d.setDate(d.getDate() - estado.dias + 1);
    const inicio = d.toISOString().slice(0, 10);
    return { inicio: inicio < minDia ? minDia : inicio, fim: maxDia, minDia };
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
    const grupos = [];
    if (label.has("todas")) grupos.push({ slug: "todas", label: "Todas as filas", membros: ["todas"] });
    const bases = [...label.keys()]
      .filter((s) => s !== "todas" && s !== "plantao" && !s.endsWith("-plantao"))
      .sort((a, b) => label.get(a).localeCompare(label.get(b), "pt-BR"));
    for (const base of bases) {
      const membros = [base];
      let lbl = label.get(base);
      if (label.has(base + "-plantao")) {
        membros.push(base + "-plantao");
        lbl += " (+Plantão)";
      }
      grupos.push({ slug: base, label: lbl, membros });
    }
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

  // Distribuição de TMA (mês mais recente dentro do período) — histograma + percentis,
  // no estilo da página de Indicadores do octa-api. Dado: agg_tma_distribuicao_mes.
  function renderDistTma() {
    const p = periodo();
    if (!p) return;
    const mesesSel = mesesDoPeriodo(p);
    const dist = estado.dados.tmaDistMes || [];
    let row = null;
    for (const r of dist) if (mesesSel.has(r.mes)) row = r;   // mais recente no período
    if (!row) row = dist.length ? dist[dist.length - 1] : null;
    const stats = $("statsTmaDist");
    if (!row) { if (stats) stats.textContent = "Sem dados no período"; return; }
    const buckets = typeof row.buckets === "string" ? JSON.parse(row.buckets) : row.buckets;
    const min1 = (x) => (x == null ? "—" : x.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " min");
    if (stats) stats.innerHTML =
      `${KPIS.fmtMes(row.mes)} · Média <b>${min1(row.media_min)}</b> · P50 <b>${min1(row.p50_min)}</b> · ` +
      `P90 <b>${min1(row.p90_min)}</b> · P95 <b>${min1(row.p95_min)}</b> · n <b>${KPIS.fmtInt(row.n)}</b>`;
    novoChart("chartTmaDistP", {
      type: "bar",
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [{
          data: buckets.map((b) => b.count),
          backgroundColor: "rgba(139,92,246,0.8)", borderRadius: 7, borderSkipped: false,
        }],
      },
      options: opts({ y: { beginAtZero: true } }),
    });
  }

  // Preenche uma tabela de categorias somando o período a partir de agg_categorias_dia.
  // TMA: mediana exata quando o filtro é um único dia; senão média ponderada.
  function preencherCategorias(tabelaId, subId, limite) {
    const tabela = $(tabelaId);
    if (!tabela) return;
    const p = periodo();
    if (!p) return;
    const umDia = p.inicio === p.fim;
    const porCat = {};
    for (const r of estado.dados.categoriasDia) {
      if (!entre(r.dia, p.inicio, p.fim)) continue;
      const c = porCat[r.categoria_nome] ||
        (porCat[r.categoria_nome] = { volume: 0, resp: 0, satis: 0, tmaSoma: 0, tmaN: 0, mediana: null });
      c.volume += r.volume;
      c.resp += r.csat_respondidos;
      c.satis += r.csat_satisfeitos;
      c.tmaSoma += r.tma_soma_seg || 0;
      c.tmaN += r.tma_n || 0;
      if (umDia) c.mediana = r.tma_mediana_seg;   // dia único → mediana exata (1 linha/cat)
    }
    const cats = Object.entries(porCat).sort((a, b) => b[1].volume - a[1].volume).slice(0, limite);
    const sub = $(subId);
    if (sub) sub.textContent =
      `Top ${cats.length} categorias — ${KPIS.fmtDiaCurto(p.inicio)} a ${KPIS.fmtDiaCurto(p.fim)}`;
    tabela.querySelector("tbody").innerHTML = cats.map(([nome, c]) => {
      const tma = (umDia && c.mediana != null) ? c.mediana : (c.tmaN ? c.tmaSoma / c.tmaN : null);
      return `<tr>
        <td>${nome}</td>
        <td class="num">${KPIS.fmtInt(c.volume)}</td>
        <td class="num">${KPIS.fmtDuracao(tma)}</td>
        <td class="num">${c.resp ? KPIS.fmtPct(100 * c.satis / c.resp) : "—"}</td>
        <td class="num">${KPIS.fmtInt(c.resp)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="empty-note">Sem dados no período</td></tr>`;
  }

  function renderCategoriasPerf() {
    preencherCategorias("tabelaCategoriasP", "subCategoriasP", 10);
  }

  // ══════════════ DIA X HORA ══════════════

  function renderDiaHora() {
    const p = periodo();
    if (!p) return;
    const linhas = estado.dados.chatsHora.filter((r) => entre(r.dia, p.inicio, p.fim));

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
      const dow = new Date(r.dia + "T00:00:00").getDay();
      grade[dow][r.hora] += r.volume;
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
      const ana = typeof r.analistas === "string" ? JSON.parse(r.analistas) : (r.analistas || []);
      for (const a of ana) analistasPorHora[r.hora].add(a);
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
      options: opts({ y: { beginAtZero: true } }),
    });

    // TME por hora — tooltip estilo octa-api (TME médio/menor/maior, volume, analistas).
    novoChart("chartTmeHora", {
      type: "bar",
      data: {
        labels: hs.map((h) => `${h}h`),
        datasets: [{
          data: hs.map((h) => (tmePorHora[h].n ? tmePorHora[h].soma / tmePorHora[h].n / 60 : null)),
          backgroundColor: "rgba(34,211,238,0.8)", borderRadius: 5, borderSkipped: false,
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
                const t = tmePorHora[h];
                const medio = t.n ? t.soma / t.n : null;
                return [
                  `TME médio: ${KPIS.fmtDuracao(medio)}`,
                  `Menor TME: ${KPIS.fmtDuracao(tmeMinPorHora[h])}`,
                  `Maior TME: ${KPIS.fmtDuracao(tmeMaxPorHora[h])}`,
                  `Volume atendido: ${KPIS.fmtInt(t.n)}`,
                  `Analistas: ${analistasPorHora[h].size}`,
                ];
              },
            },
          },
        },
        scales: { x: { grid: { color: GRID } }, y: { grid: { color: GRID }, beginAtZero: true } },
      },
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
            labels: { boxWidth: 12, usePointStyle: true, pointStyle: "line", color: "#8893aa", font: { size: 11 } } },
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
  }

  // ══════════════ TICKETS ══════════════

  function renderTickets() {
    const p = periodo();
    if (!p) return;
    const linhas = estado.dados.ticketsDia.filter((r) => entre(r.dia, p.inicio, p.fim));
    const abertos = KPIS.soma(linhas, "abertos");
    const fechados = KPIS.soma(linhas, "fechados");

    const pAnt = periodoAnterior(p);
    const linhasAnt = pAnt
      ? estado.dados.ticketsDia.filter((r) => entre(r.dia, pAnt.inicio, pAnt.fim)) : null;

    $("kpiTktAbertos").textContent = KPIS.fmtInt(abertos);
    $("kpiTktFechados").textContent = KPIS.fmtInt(fechados);
    $("kpiTktSaldo").textContent = (abertos - fechados > 0 ? "+" : "") + KPIS.fmtInt(abertos - fechados);
    $("kpiTktAbertosDelta").innerHTML = KPIS.deltaHtml(
      abertos, linhasAnt ? KPIS.soma(linhasAnt, "abertos") : null, { inverso: true, fmt: KPIS.fmtInt });
    $("kpiTktFechadosDelta").innerHTML = KPIS.deltaHtml(
      fechados, linhasAnt ? KPIS.soma(linhasAnt, "fechados") : null, { fmt: KPIS.fmtInt });

    const tm = estado.dados.ticketsMes;
    const ultimoMes = tm.length ? tm[tm.length - 1] : null;
    $("kpiTktTma").textContent = ultimoMes ? KPIS.fmtHoras(ultimoMes.tma_mediana_h) : "—";

    novoChart("chartTicketsFluxo", {
      type: "line",
      data: {
        labels: linhas.map((r) => KPIS.fmtDiaCurto(r.dia)),
        datasets: [
          { label: "Abertos", data: linhas.map((r) => r.abertos),
            borderColor: "#4f7cf7", backgroundColor: "rgba(79,124,247,0.08)", tension: 0.4, pointRadius: 2, fill: true },
          { label: "Fechados", data: linhas.map((r) => r.fechados),
            borderColor: "#34d399", backgroundColor: "rgba(52,211,153,0.08)", tension: 0.4, pointRadius: 2, fill: true },
        ],
      },
      options: opts({ y: { beginAtZero: true } }),
    });

    // Por formulário / status — meses que intersectam o período
    const mesesSel = mesesDoPeriodo(p);
    const porForm = {};
    for (const r of estado.dados.ticketsFormMes) {
      if (!mesesSel.has(r.mes)) continue;
      porForm[r.form_name] = (porForm[r.form_name] || 0) + r.total;
    }
    const topForms = Object.entries(porForm).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const maxForm = topForms.length ? topForms[0][1] : 1;
    $("ticketsForms").innerHTML = topForms.map(([nome, tot]) => `
      <div class="bar-item">
        <div class="bar-label-row"><strong title="${nome}">${nome}</strong><span>${KPIS.fmtInt(tot)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(100 * tot / maxForm)}%"></div></div>
      </div>`).join("") || `<div class="empty-note">Sem dados no período</div>`;

    const porStatus = {};
    for (const r of estado.dados.ticketsStatusMes) {
      if (!mesesSel.has(r.mes)) continue;
      porStatus[r.status_name] = (porStatus[r.status_name] || 0) + r.total;
    }
    const stEntries = Object.entries(porStatus).sort((a, b) => b[1] - a[1]);
    novoChart("chartTicketsStatus", {
      type: "doughnut",
      data: {
        labels: stEntries.map(([s]) => s),
        datasets: [{
          data: stEntries.map(([, v]) => v),
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

  // ══════════════ CATEGORIAS ══════════════

  function renderCategorias() {
    const p = periodo();
    if (!p) return;
    preencherCategorias("tabelaCategorias", "subCategorias", 20);

    // Distribuição de TMA — mês mais recente disponível
    const dist = estado.dados.tmaDistMes;
    const ult = dist.length ? dist[dist.length - 1] : null;
    if (ult) {
      const buckets = typeof ult.buckets === "string" ? JSON.parse(ult.buckets) : ult.buckets;
      $("subTmaDist").textContent =
        `${KPIS.fmtMes(ult.mes)} — mediana ${Math.round(ult.p50_min)}min · p90 ${Math.round(ult.p90_min)}min · ${KPIS.fmtInt(ult.n)} chats`;
      novoChart("chartTmaDist", {
        type: "bar",
        data: {
          labels: buckets.map((b) => b.label),
          datasets: [{
            data: buckets.map((b) => b.count),
            backgroundColor: "rgba(20,184,166,0.8)", borderRadius: 7, borderSkipped: false,
          }],
        },
        options: opts({ y: { beginAtZero: true } }),
      });
    }
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
        <td>${a.nome}</td>
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
    if (g) return g.label;
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
    const [t, s] = TITULOS[estado.secao];
    $("pageTitle").textContent = t;
    $("pageSubtitle").textContent = s;
    // Filtro de fila só se aplica à seção Performance
    $("filaSelect").style.visibility = estado.secao === "performance" ? "visible" : "hidden";
    atualizarControlesData();
    RENDERS[estado.secao]();
    renderStatus();
  }

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
    if (!si) {
      $("statusTexto").textContent = "Sem info de sync";
      $("footerAtualizado").textContent = "";
      return;
    }
    const dt = new Date(si.executado_em);
    const fmt = dt.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const horasAtras = (Date.now() - dt.getTime()) / 3600000;
    $("statusDot").className = "status-dot" + (horasAtras > 12 ? " stale" : "");
    $("statusTexto").textContent = `Atualizado ${fmt}`;
    $("footerAtualizado").textContent =
      `Dados atualizados em ${fmt} · janela de ${si.janela_dias} dias · atualização automática a cada 5 min`;
  }

  function popularFilas() {
    estado.gruposFila = construirGruposFila();
    $("filaSelect").innerHTML = estado.gruposFila
      .map((g) => `<option value="${g.slug}">${g.label}</option>`).join("");
    if (!estado.gruposFila.some((g) => g.slug === estado.fila))
      estado.fila = estado.gruposFila[0] ? estado.gruposFila[0].slug : "todas";
    $("filaSelect").value = estado.fila;
  }

  async function carregar() {
    try {
      estado.dados = await API.carregarTudo();
      $("errorBanner").classList.add("hidden");
      popularFilas();
      render();
    } catch (e) {
      console.error(e);
      $("errorBanner").textContent =
        "Não foi possível carregar os dados. Tente novamente em instantes. (" + e.message + ")";
      $("errorBanner").classList.remove("hidden");
      $("statusTexto").textContent = "Erro ao carregar";
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
    estado.dias = parseInt(tab.dataset.dias, 10);
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
    const tab = document.querySelector(`#periodoTabs .tab[data-dias="${estado.dias}"]`);
    if (tab) tab.classList.add("active");
    render();
  });

  $("filaSelect").addEventListener("change", (e) => {
    estado.fila = e.target.value;
    render();
  });

  $("rankingMes").addEventListener("change", (e) => {
    estado.rankingMes = e.target.value;
    renderRanking();
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
  let intervalo = null;
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
    if (!intervalo) intervalo = setInterval(carregar, CONFIG.REFRESH_MS);
  }

  function encerrarSessao() {
    if (intervalo) { clearInterval(intervalo); intervalo = null; }
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
})();
