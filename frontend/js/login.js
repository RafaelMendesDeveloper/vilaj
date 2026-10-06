const form = document.getElementById("form-login");
const erro = document.getElementById("erro");
const botao = document.getElementById("entrar");

sb.auth.getSession().then(({ data }) => {
  if (data.session) location.replace("app.html");
});

function mostrarErro(texto) {
  erro.textContent = texto;
  erro.hidden = false;
}

form.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  erro.hidden = true;

  const email = document.getElementById("email").value.trim();
  const senha = document.getElementById("senha").value;
  if (!email || !senha) {
    mostrarErro("Preencha email e senha.");
    return;
  }

  botao.disabled = true;
  botao.textContent = "Entrando…";

  const { error } = await sb.auth.signInWithPassword({ email, password: senha });

  if (error) {
    mostrarErro(error.message === "Invalid login credentials"
      ? "Email ou senha incorretos."
      : "Não foi possível entrar. Tente de novo.");
    botao.disabled = false;
    botao.textContent = "Entrar";
    return;
  }

  location.replace("app.html");
});
