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

  // Atualização automática dos dados (ms)
  REFRESH_MS: 5 * 60 * 1000,

  // Pesos do score do ranking (mesmos defaults da dashboard interna)
  PESOS: { volume: 1, engajamento: 1, csat: 2, resolvidos: 2, tma: 1 },
  TMA_LIMITE_MIN: 30,
};
