// ══════════════════════════════════════════════════════════════
// Configuração da dashboard (privada — exige login).
// A publishable/anon key pode ficar exposta: sozinha ela NÃO dá acesso a dado
// nenhum. O RLS do Supabase só libera leitura para usuários AUTENTICADOS; sem
// login (papel anon) toda consulta é negada.
//
// A anon key fica em: Supabase Dashboard → Settings → API → "anon public".
// ⚠️ FALTA APENAS colar a SUPABASE_ANON_KEY abaixo (a URL já está correta).
// ══════════════════════════════════════════════════════════════
const CONFIG = {
  SUPABASE_URL: "https://dholqliulwtnrsjgxjqp.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ZajsLXmw6LAd43CWl_strg_XJOB8fOQ",

  // Pesos do score do ranking (os mesmos em uso na dashboard interna — octa-api).
  // "volume" pesa a REPRESENTATIVIDADE (participação no volume do time), não o volume bruto.
  // TMA não entra na média: é bônus de +peso quando o TMA fica abaixo de TMA_LIMITE_MIN.
  PESOS: { volume: 3.5, engajamento: 2.5, csat: 2.5, resolvidos: 2.5, tma: 1 },
  TMA_LIMITE_MIN: 30,

  // Piso para entrar no ranking: fração da MEDIANA de volume do time no período. Sem ele,
  // quem atendeu 1-9 chats com CSAT perfeito ocupa o topo (CSAT+Resolvidos valem 5 de 11 do
  // score). Quem fica abaixo continua vendo as próprias métricas, só não recebe posição.
  RANKING_PISO_FRAC: 0.10,

  // Cache no navegador (js/cache.js). false = desliga para todos (volta a consultar o banco a
  // cada tela). Para desligar só numa aba, abra a dashboard com ?nocache na URL.
  CACHE_ATIVO: true,
};
