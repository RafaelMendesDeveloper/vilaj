let beneficios = [];

async function iniciar() {
  if (!await exigirSessao()) return;

  $("hoje").textContent = new Date().toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "long", day: "numeric", month: "long",
  }).replace(/^./, (c) => c.toUpperCase());

  const { data: lista } = await sb.from("beneficios").select("id, nome, descricao").order("ordem");
  beneficios = lista || [];

  carregarAniversariantes(0);
  $("codigo").focus();
}

// ---------------------------------------------------------------------------
// Aniversariantes
// ---------------------------------------------------------------------------

document.querySelectorAll(".aba").forEach((aba) => {
  aba.addEventListener("click", () => {
    document.querySelectorAll(".aba").forEach((a) => a.setAttribute("aria-selected", String(a === aba)));
    carregarAniversariantes(Number(aba.dataset.dias));
  });
});

async function carregarAniversariantes(dias) {
  const alvo = $("aniversariantes");
  alvo.innerHTML = '<p class="carregando">Carregando…</p>';
  $("contador").textContent = "";

  const { data, error } = await sb.rpc("aniversariantes", { p_dias: dias });
  if (error) {
    alvo.innerHTML = '<p class="erro-geral">Não foi possível carregar os aniversariantes.</p>';
    return;
  }

  $("contador").textContent = data.length === 1 ? "1 pessoa" : `${data.length} pessoas`;

  if (!data.length) {
    alvo.innerHTML = `
      <div class="vazio">
        <div class="vazio__setas" aria-hidden="true">›››</div>
        <p>${dias === 0 ? "Ninguém faz aniversário hoje." : "Nenhum aniversário nesse período."}</p>
      </div>`;
    return;
  }

  const hoje = hojeIso();

  alvo.innerHTML = `<ul class="lista">${data.map((p) => {
    const ehHoje = p.data_aniversario === hoje;
    const tags = [];
    if (!ehHoje) tags.push(`<span class="tag tag--data">${esc(diaSemana(p.data_aniversario))}</span>`);
    if (p.cupom_usado) tags.push('<span class="tag tag--usado">cupom usado</span>');
    else if (p.cupom_enviado) tags.push('<span class="tag tag--enviado">cupom enviado</span>');
    if (!p.email) tags.push('<span class="tag tag--alerta">sem email</span>');
    if (!p.ativo) tags.push('<span class="tag">inativo</span>');

    return `
      <li class="pessoa${ehHoje ? " pessoa--hoje" : ""}">
        <div class="pessoa__inicial" aria-hidden="true">${esc((p.nome || "?").trim().charAt(0).toUpperCase())}</div>
        <div>
          <p class="pessoa__nome">${esc(p.nome)}</p>
          <p class="pessoa__info">${ehHoje ? "Faz" : "Fará"} ${p.idade} anos${p.email ? " · " + esc(p.email) : ""}</p>
        </div>
        <div class="pessoa__tags">${tags.join("")}</div>
      </li>`;
  }).join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// Cupom
// ---------------------------------------------------------------------------

const ROTULOS = {
  valido: "Cupom válido",
  usado: "Já utilizado",
  vencido: "Vencido",
  inexistente: "Não encontrado",
};

$("form-cupom").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const codigo = $("codigo").value.trim();
  if (!codigo) return;

  const botao = $("consultar");
  botao.disabled = true;
  $("resultado").innerHTML = '<p class="carregando">Consultando…</p>';

  const { data, error } = await sb.rpc("consultar_cupom", { p_codigo: codigo });
  botao.disabled = false;

  if (error || data.situacao === "nao_autenticado") {
    $("resultado").innerHTML = '<p class="erro-geral">Não foi possível consultar o cupom. Recarregue a página e tente de novo.</p>';
    return;
  }
  mostrarCupom(data);
});

function mostrarCupom(c, recemUsado = false) {
  const s = c.situacao;
  let corpo = "";

  if (s === "inexistente") {
    corpo = `
      <p class="ficha__codigo">${esc(c.codigo)}</p>
      <p class="ficha__msg">Nenhum cupom com esse código. Confira se foi digitado certo.</p>`;
  } else {
    const dados = [`<dt>Validade</dt><dd>${dataCurta(c.validade)}</dd>`];
    if (c.usado_em) dados.push(`<dt>Usado em</dt><dd>${dataHora(c.usado_em)}</dd>`);
    if (c.beneficio) dados.push(`<dt>Benefício</dt><dd>${esc(c.beneficio)}</dd>`);
    if (c.usado_por) dados.push(`<dt>Validado por</dt><dd>${esc(c.usado_por)}</dd>`);

    corpo = `
      <p class="ficha__codigo">${esc(c.codigo)}</p>
      <p class="ficha__nome">${esc(c.nome)}</p>
      <dl class="ficha__dados">${dados.join("")}</dl>`;

    if (recemUsado) {
      corpo += '<p class="ficha__msg"><strong>Uso registrado.</strong> Aplique o desconto do benefício escolhido.</p>';
    } else if (s === "valido") {
      corpo += `
        <form id="form-uso">
          <fieldset class="beneficios">
            <legend>Qual benefício o cliente vai usar?</legend>
            ${beneficios.map((b) => `
              <label class="beneficio">
                <input type="radio" name="beneficio" value="${b.id}">
                <span><strong>${esc(b.nome)}</strong><small>${esc(b.descricao)}</small></span>
              </label>`).join("")}
          </fieldset>
          <div class="acoes">
            <button class="botao" type="submit" id="confirmar" disabled>Confirmar uso do cupom</button>
            <button class="botao botao--fantasma" type="button" data-limpar>Cancelar</button>
          </div>
        </form>`;
    }
  }

  const rotulo = recemUsado ? "Cupom usado com sucesso" : ROTULOS[s];
  const classe = recemUsado ? "valido" : s;

  $("resultado").innerHTML = `
    <div class="ficha ficha--${classe}">
      <span class="selo selo--${classe}">${rotulo}</span>
      ${corpo}
    </div>
    ${s !== "valido" || recemUsado ? '<div class="acoes"><button class="botao botao--fantasma" type="button" data-limpar>Validar outro cupom</button></div>' : ""}`;

  const formUso = $("form-uso");
  if (formUso) {
    formUso.addEventListener("change", () => { $("confirmar").disabled = false; });
    formUso.addEventListener("submit", (e) => confirmarUso(e, c.codigo));
  }
}

async function confirmarUso(evento, codigo) {
  evento.preventDefault();
  const escolhido = evento.target.querySelector('input[name="beneficio"]:checked');
  if (!escolhido) return;

  const botao = $("confirmar");
  botao.disabled = true;
  botao.textContent = "Registrando…";

  const { data, error } = await sb.rpc("usar_cupom", { p_codigo: codigo, p_beneficio_id: Number(escolhido.value) });

  if (error) {
    botao.disabled = false;
    botao.textContent = "Confirmar uso do cupom";
    alert("Não foi possível registrar o uso. Tente de novo.");
    return;
  }

  if (data.ok) {
    mostrarCupom(data.cupom, true);
  } else {
    // alguém usou o cupom antes, ou ele venceu: mostra a situação atual
    const atual = await sb.rpc("consultar_cupom", { p_codigo: codigo });
    if (atual.data) mostrarCupom(atual.data);
  }
  carregarAniversariantes(Number(document.querySelector('.aba[aria-selected="true"]').dataset.dias));
}

$("resultado").addEventListener("click", (evento) => {
  if (!evento.target.matches("[data-limpar]")) return;
  $("resultado").innerHTML = "";
  $("codigo").value = "";
  $("codigo").focus();
});

iniciar();
