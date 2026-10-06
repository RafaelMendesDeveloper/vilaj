// URL e chave pública (publishable) do Supabase. Podem ficar no repositório:
// o acesso aos dados é protegido pelo RLS e pelas funções do banco.
const SUPABASE_URL = "https://fpbuyodxsgaixfquesvh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_h-fp4dfjmagSyCpc7O-Elw_-pVQcxh6";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
