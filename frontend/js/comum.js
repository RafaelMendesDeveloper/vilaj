// Funções usadas pelas telas logadas (app.html e historico.html).

const $ = (id) => document.getElementById(id);

const esc = (texto) => String(texto ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// "2026-10-06" -> Date local (sem deslocar o dia pelo fuso)
const paraData = (iso) => {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d);
};
const dataCurta = (iso) => paraData(iso).toLocaleDateString("pt-BR");
const dataHora = (iso) => new Date(iso).toLocaleString("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const diaSemana = (iso) => paraData(iso).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });

// Data de hoje em São Paulo, no formato AAAA-MM-DD
const hojeIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

// Sem sessão volta para o login; com sessão mostra a página e o email no topo.
async function exigirSessao() {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    location.replace("index.html");
    return null;
  }
  $("usuario").textContent = data.session.user.email;
  document.body.hidden = false;
  return data.session;
}

sb.auth.onAuthStateChange((evento) => {
  if (evento === "SIGNED_OUT") location.replace("index.html");
});

$("sair").addEventListener("click", () => sb.auth.signOut());
