const SITUACOES = {
  usado: { rotulo: "Usado", classe: "valido" },
  disponivel: { rotulo: "Disponível", classe: "disponivel" },
  vencido: { rotulo: "Vencido", classe: "vencido" },
};

let registros = [];

// ---------------------------------------------------------------------------
// Período
// ---------------------------------------------------------------------------

const isoDe = (d) => d.toISOString().slice(0, 10);

function somarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return isoDe(d);
}

function intervalo() {
  const hoje = hojeIso();
  const [ano, mes] = hoje.split("-").map(Number);
  switch ($("periodo").value) {
    case "mes":
      return [`${hoje.slice(0, 7)}-01`, hoje];
    case "mes-passado": {
      const inicio = isoDe(new Date(Date.UTC(ano, mes - 2, 1)));
      const fim = isoDe(new Date(Date.UTC(ano, mes - 1, 0)));
      return [inicio, fim];
    }
    case "30": return [somarDias(hoje, -29), hoje];
    case "90": return [somarDias(hoje, -89), hoje];
    case "ano": return [`${ano}-01-01`, hoje];
    case "tudo": return ["2000-01-01", "2100-12-31"];
    default:
      return [$("inicio").value || hoje, $("fim").value || hoje];
  }
}

// ---------------------------------------------------------------------------
// Carregar e mostrar
// ---------------------------------------------------------------------------

async function carregar() {
  const [inicio, fim] = intervalo();
  $("linhas").innerHTML = '<tr><td colspan="8" class="carregando">Carregando…</td></tr>';
  $("exportar").disabled = true;

  const { data, error } = await sb.rpc("historico_cupons", {
    p_inicio: inicio, p_fim: fim, p_campo: $("campo").value,
  });

  if (error) {
    $("linhas").innerHTML = '<tr><td colspan="8"><p class="erro-geral">Não foi possível carregar o histórico.</p></td></tr>';
    return;
  }

  registros = data || [];
  mostrarIndicadores();
  mostrarTabela();
}

function mostrarIndicadores() {
  const enviados = registros.filter((r) => r.enviado_em).length;
  const usados = registros.filter((r) => r.situacao === "usado");

  $("ind-enviados").textContent = enviados;
  $("ind-usados").textContent = usados.length;
  $("ind-taxa").textContent = $("campo").value === "envio" && enviados
    ? `${Math.round((usados.length / enviados) * 100)}%`
    : "–";

  const contagem = {};
  usados.forEach((r) => { if (r.beneficio) contagem[r.beneficio] = (contagem[r.beneficio] || 0) + 1; });
  const [maisUsado, vezes] = Object.entries(contagem).sort((a, b) => b[1] - a[1])[0] || [];
  $("ind-beneficio").textContent = maisUsado ? `${maisUsado} (${vezes})` : "–";
}

function filtrados() {
  const situacao = $("situacao").value;
  const busca = $("busca").value.trim().toLowerCase();
  return registros.filter((r) => (
    (!situacao || r.situacao === situacao)
    && (!busca || [r.cliente, r.email, r.codigo].some((v) => (v || "").toLowerCase().includes(busca)))
  ));
}

function mostrarTabela() {
  const linhas = filtrados();
  $("contagem").textContent = linhas.length === 1 ? "1 cupom" : `${linhas.length} cupons`;
  $("exportar").disabled = !linhas.length;

  if (!linhas.length) {
    $("linhas").innerHTML = `
      <tr><td colspan="8">
        <div class="vazio"><div class="vazio__setas" aria-hidden="true">›››</div><p>Nenhum cupom nesse filtro.</p></div>
      </td></tr>`;
    return;
  }

  $("linhas").innerHTML = linhas.map((r) => {
    const s = SITUACOES[r.situacao];
    return `
      <tr>
        <td><strong>${esc(r.cliente)}</strong><small>${esc(r.email)}</small></td>
        <td class="tabela__codigo">${esc(r.codigo)}</td>
        <td>${r.enviado_em ? dataHora(r.enviado_em) : "–"}</td>
        <td>${dataCurta(r.validade)}</td>
        <td><span class="selo selo--${s.classe}">${s.rotulo}</span></td>
        <td>${r.usado_em ? dataHora(r.usado_em) : "–"}</td>
        <td>${esc(r.beneficio || "–")}</td>
        <td>${esc(r.validado_por || "–")}</td>
      </tr>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// CSV (separado por ponto e vírgula, abre direto no Excel em português)
// ---------------------------------------------------------------------------

function exportar() {
  const campo = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const cabecalho = ["Cliente", "Email", "Código", "Enviado em", "Validade", "Situação", "Usado em", "Benefício", "Validado por"];
  const linhas = filtrados().map((r) => [
    r.cliente, r.email, r.codigo,
    r.enviado_em ? dataHora(r.enviado_em) : "",
    dataCurta(r.validade),
    SITUACOES[r.situacao].rotulo,
    r.usado_em ? dataHora(r.usado_em) : "",
    r.beneficio || "", r.validado_por || "",
  ]);
  const csv = [cabecalho, ...linhas].map((l) => l.map(campo).join(";")).join("\r\n");

  const [inicio, fim] = intervalo();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  link.download = $("periodo").value === "tudo" ? "cupons-vilaj.csv" : `cupons-vilaj_${inicio}_a_${fim}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------------------------------------------------------------------------

$("periodo").addEventListener("change", () => {
  const personalizado = $("periodo").value === "personalizado";
  $("datas").hidden = !personalizado;
  if (personalizado && !$("inicio").value) {
    $("inicio").value = `${hojeIso().slice(0, 7)}-01`;
    $("fim").value = hojeIso();
  }
  carregar();
});
$("inicio").addEventListener("change", carregar);
$("fim").addEventListener("change", carregar);
$("campo").addEventListener("change", carregar);
$("situacao").addEventListener("change", mostrarTabela);
$("busca").addEventListener("input", mostrarTabela);
$("filtros").addEventListener("submit", (e) => e.preventDefault());
$("exportar").addEventListener("click", exportar);

(async () => {
  if (await exigirSessao()) carregar();
})();
