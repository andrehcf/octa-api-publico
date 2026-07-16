// ══════════════════════════════════════════════════════════════
// Helpers de agregação e formatação.
// As tabelas agg_* guardam SOMAS e CONTAGENS — aqui recompomos as
// médias ponderadas para qualquer período selecionado.
// ══════════════════════════════════════════════════════════════

const KPIS = {

  // Soma um campo numérico de uma lista de linhas (null-safe)
  soma(rows, campo) {
    return rows.reduce((acc, r) => acc + (Number(r[campo]) || 0), 0);
  },

  // Média ponderada: soma(campo_soma) / soma(campo_n)
  mediaPonderada(rows, campoSoma, campoN) {
    const n = this.soma(rows, campoN);
    if (!n) return null;
    return this.soma(rows, campoSoma) / n;
  },

  // KPIs completos de chats a partir das linhas diárias (agg_chats_dia)
  kpisChats(rows) {
    const volume = this.soma(rows, "volume_atendido");
    const transferidos = this.soma(rows, "total_transferidos");
    const fechados = this.soma(rows, "total_fechados");
    const semAtender = this.soma(rows, "fechados_sem_atender");
    const respondidos = this.soma(rows, "csat_respondidos");
    const satisfeitos = this.soma(rows, "csat_satisfeitos");
    const resolvSim = this.soma(rows, "resolvidos_sim");
    const resolvTotal = this.soma(rows, "resolvidos_total");
    return {
      volume, transferidos, semAtender, respondidos, resolvSim, resolvTotal,
      tmeN: this.soma(rows, "tme_n"),
      tmaN: this.soma(rows, "tma_n"),
      tmeSeg: this.mediaPonderada(rows, "tme_soma_seg", "tme_n"),
      tmaSeg: this.mediaPonderada(rows, "tma_soma_seg", "tma_n"),
      csatMedia: this.mediaPonderada(rows, "csat_soma_score", "csat_n"),
      abandonoPct: fechados > 0 ? (100 * semAtender / fechados) : null,
      csatPct: respondidos > 0 ? (100 * satisfeitos / respondidos) : null,
      resolvidosPct: resolvTotal > 0 ? (100 * resolvSim / resolvTotal) : null,
      engajamentoPct: volume > 0 ? (100 * respondidos / volume) : null,
    };
  },

  // Score do ranking — mesma fórmula da dashboard interna
  // (média ponderada dos 4 percentuais + bônus fixo de TMA por fora)
  scoreRanking(a, pesos, tmaLimiteMin) {
    const somaPesos = (pesos.volume + pesos.engajamento + pesos.csat + pesos.resolvidos) || 1;
    const base = (
      (a.participacaoPct || 0) * pesos.volume +
      (a.engajamentoPct || 0) * pesos.engajamento +
      (a.csatPct || 0) * pesos.csat +
      (a.resolvidosPct || 0) * pesos.resolvidos
    ) / somaPesos;
    const bonus = (a.tmaMin !== null && a.tmaMin < tmaLimiteMin) ? pesos.tma : 0;
    return base + bonus;
  },

  // ── Formatação (pt-BR) ──
  fmtInt(v) {
    return v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR");
  },

  fmtPct(v, casas = 1) {
    if (v === null || v === undefined) return "—";
    return v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%";
  },

  // Segundos → "4m06s" | "1h07m"
  fmtDuracao(seg) {
    if (seg === null || seg === undefined) return "—";
    seg = Math.round(seg);
    const h = Math.floor(seg / 3600);
    const m = Math.floor((seg % 3600) / 60);
    const s = seg % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
    return `${m}m${String(s).padStart(2, "0")}s`;
  },

  // Horas decimais → "2d 3h" | "4h30"
  fmtHoras(h) {
    if (h === null || h === undefined) return "—";
    const dias = Math.floor(h / 24);
    const horas = Math.floor(h % 24);
    const min = Math.round((h * 60) % 60);
    if (dias > 0) return horas ? `${dias}d ${horas}h` : `${dias}d`;
    if (horas > 0) return `${horas}h${String(min).padStart(2, "0")}`;
    return `${min}min`;
  },

  // "2026-06-15" → "15/06"
  fmtDiaCurto(iso) {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
  },

  // "2026-06-01" → "Jun/26"
  fmtMes(iso) {
    const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    const [a, m] = iso.split("-");
    return `${meses[parseInt(m, 10) - 1]}/${a.slice(2)}`;
  },

  // Delta HTML vs período anterior. inverso=true quando "menor é melhor".
  deltaHtml(atual, anterior, { inverso = false, fmt = null, sufixo = "" } = {}) {
    if (atual === null || anterior === null || atual === undefined ||
        anterior === undefined || !isFinite(anterior)) {
      return `<span class="delta-neutral">— <span>sem comparativo</span></span>`;
    }
    const diff = atual - anterior;
    if (Math.abs(diff) < 1e-9) {
      return `<span class="delta-neutral">= <span>vs anterior</span></span>`;
    }
    const subiu = diff > 0;
    const bom = inverso ? !subiu : subiu;
    const cls = subiu ? (bom ? "delta-up" : "delta-up-bad") : (bom ? "delta-down-good" : "delta-down");
    const seta = subiu ? "▲" : "▼";
    const valor = fmt ? fmt(Math.abs(diff)) : Math.abs(diff).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
    return `<span class="${cls}">${seta} <strong>${valor}${sufixo}</strong></span> <span>vs anterior</span>`;
  },

  // Delta em % RELATIVO (estilo octa-api): só a seta + variação percentual.
  // inverso=true quando "menor é melhor" (TME, TMA, Abandono).
  deltaPctHtml(atual, anterior, inverso = false) {
    if (atual === null || atual === undefined || anterior === null ||
        anterior === undefined || !isFinite(anterior) || anterior === 0) {
      return `<span class="delta-neutral">—</span>`;
    }
    const diff = atual - anterior;
    if (Math.abs(diff) < 1e-9) return `<span class="delta-neutral">=</span>`;
    const subiu = diff > 0;
    const bom = inverso ? !subiu : subiu;
    const cls = subiu ? (bom ? "delta-up" : "delta-up-bad") : (bom ? "delta-down-good" : "delta-down");
    const pct = Math.abs(100 * diff / anterior);
    return `<span class="${cls}">${subiu ? "▲" : "▼"} ${pct.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>`;
  },
};
