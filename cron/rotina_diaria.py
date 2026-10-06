"""Rotina diária do Vilaj: sincroniza as pessoas do Conexa com o Supabase e
envia um cupom por email para cada aniversariante do dia.

Uso:
  python cron/rotina_diaria.py                  # sincroniza e envia os cupons do dia
  python cron/rotina_diaria.py --so-sincronizar # só atualiza a tabela pessoas
  python cron/rotina_diaria.py --teste EMAIL    # envia um email de exemplo para EMAIL

Sem ENVIO_REAL=true a rotina roda em simulação: sincroniza, lista quem
receberia e não cria cupom nem envia email.

Os logs não mostram nome completo nem email inteiro, porque em repositório
público os logs do GitHub Actions ficam visíveis para qualquer pessoa.
"""

import html
import json
import os
import re
import secrets
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from string import Template

RAIZ = Path(__file__).resolve().parent
ALFABETO_CUPOM = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # sem I, L, O, 0 e 1
EMAIL_RE = re.compile(r"[^@\s;,]+@[^@\s;,]+\.[^@\s;,]+")


# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------

def carregar_env_local():
    """Lê o .env da raiz do projeto, se existir (uso local)."""
    arquivo = RAIZ.parent / ".env"
    if not arquivo.exists():
        return
    for linha in arquivo.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, valor = linha.split("=", 1)
        os.environ.setdefault(chave.strip(), valor.strip().strip('"').strip("'"))


def env(nome, padrao=None):
    valor = os.environ.get(nome, padrao)
    if valor in (None, ""):
        sys.exit(f"Variável de ambiente obrigatória ausente: {nome}")
    return valor


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def requisicao(metodo, url, headers=None, corpo=None, tentativas=4):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    for tentativa in range(tentativas):
        req = urllib.request.Request(url, data=dados, method=metodo, headers=headers or {})
        if dados is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                texto = resp.read().decode()
                return json.loads(texto) if texto else None
        except urllib.error.HTTPError as erro:
            if erro.code == 429 and tentativa < tentativas - 1:
                espera = int(erro.headers.get("X-Rate-Limit-Reset") or 60) + 1
                print(f"  limite de requisições atingido, aguardando {espera}s")
                time.sleep(espera)
                continue
            detalhe = erro.read().decode(errors="replace")[:500]
            raise RuntimeError(f"{metodo} {url.split('?')[0]} -> HTTP {erro.code}: {detalhe}") from None
        except urllib.error.URLError:
            if tentativa < tentativas - 1:
                time.sleep(5)
                continue
            raise


class Supabase:
    def __init__(self, url, chave):
        self.base = re.sub(r"/rest/v1/?$", "", url.rstrip("/"))
        self.headers = {"apikey": chave, "Authorization": f"Bearer {chave}"}

    def _h(self, extra=None):
        return {**self.headers, **(extra or {})}

    def get(self, tabela, filtros):
        return requisicao("GET", f"{self.base}/rest/v1/{tabela}?{urllib.parse.urlencode(filtros)}", self._h())

    def insert(self, tabela, linha):
        return requisicao("POST", f"{self.base}/rest/v1/{tabela}", self._h({"Prefer": "return=representation"}), linha)[0]

    def upsert(self, tabela, linhas, conflito):
        requisicao("POST", f"{self.base}/rest/v1/{tabela}?on_conflict={conflito}",
                   self._h({"Prefer": "resolution=merge-duplicates,return=minimal"}), linhas)

    def update(self, tabela, filtros, valores):
        requisicao("PATCH", f"{self.base}/rest/v1/{tabela}?{urllib.parse.urlencode(filtros)}",
                   self._h({"Prefer": "return=minimal"}), valores)

    def rpc(self, funcao, args):
        return requisicao("POST", f"{self.base}/rest/v1/rpc/{funcao}", self._h(), args)


# ---------------------------------------------------------------------------
# Conexa -> Supabase
# ---------------------------------------------------------------------------

def buscar_pessoas_conexa(subdominio, token):
    base = f"https://{subdominio}.conexa.app/index.php/api/v2/persons"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    pessoas, offset = [], 0
    while True:
        pagina = requisicao("GET", f"{base}?limit=100&offset={offset}", headers)
        pessoas += pagina["data"]
        if not pagina["pagination"]["hasNext"]:
            return pessoas
        offset += 100
        time.sleep(1.1)  # API do Conexa: 60 requisições por minuto


def primeiro_email(emails):
    for item in emails or []:
        achado = EMAIL_RE.search(item or "")
        if achado:
            return achado.group(0).lower()
    return None


def sincronizar(sb, subdominio, token):
    pessoas = buscar_pessoas_conexa(subdominio, token)
    agora = datetime.now(timezone.utc).isoformat()
    linhas = [
        {
            "id": p["personId"],
            "conexa_customer_id": p.get("customerId"),
            "nome": (p.get("name") or "").strip() or f"Pessoa {p['personId']}",
            "email": primeiro_email(p.get("emails")),
            "data_nascimento": p.get("birthDate") or None,
            "ativo": bool(p.get("isActive")),
            "atualizado_em": agora,
        }
        for p in pessoas
    ]
    for i in range(0, len(linhas), 500):
        sb.upsert("pessoas", linhas[i:i + 500], "id")
    com_data = sum(1 for l in linhas if l["data_nascimento"])
    com_email = sum(1 for l in linhas if l["data_nascimento"] and l["email"])
    print(f"Sincronização: {len(linhas)} pessoas | {com_data} com nascimento | {com_email} com nascimento e email")


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

def mascarar(email):
    usuario, _, dominio = (email or "").partition("@")
    return f"{usuario[:2]}***@{dominio}" if dominio else "***"


def primeiro_nome(nome):
    return (nome or "").split()[0].capitalize() if nome else ""


def formatar_data(d):
    return d.strftime("%d/%m/%Y")


def montar_email(remetente_nome, remetente_email, destino, nome, codigo, validade, beneficios, logo_url):
    template = Template((RAIZ / "template_email.html").read_text(encoding="utf-8"))
    linhas_beneficios = "".join(
        Template((RAIZ / "template_beneficio.html").read_text(encoding="utf-8")).substitute(
            nome=html.escape(b["nome"]), descricao=html.escape(b["descricao"])
        )
        for b in beneficios
    )
    corpo_html = template.substitute(
        nome=html.escape(primeiro_nome(nome)),
        codigo=codigo,
        validade=formatar_data(validade),
        beneficios=linhas_beneficios,
        logo_url=logo_url,
    )
    corpo_texto = (
        f"Feliz aniversário, {primeiro_nome(nome)}!\n\n"
        f"Para comemorar, o Vilaj preparou um cupom para você usar em um destes benefícios:\n\n"
        + "".join(f"- {b['nome']}: {b['descricao']}\n" for b in beneficios)
        + f"\nSeu cupom: {codigo}\nVálido até {formatar_data(validade)}, para um benefício à sua escolha.\n\n"
        "É só apresentar o código na recepção ou responder este email.\n\n"
        "Um abraço,\nEquipe Vilaj Coworking"
    )

    msg = EmailMessage()
    msg["Subject"] = f"Feliz aniversário, {primeiro_nome(nome)}! Seu presente do Vilaj chegou"
    msg["From"] = formataddr((remetente_nome, remetente_email))
    msg["To"] = destino
    msg["Message-ID"] = make_msgid(domain=remetente_email.split("@")[1])
    msg.set_content(corpo_texto)
    msg.add_alternative(corpo_html, subtype="html")
    return msg


class Carteiro:
    """Mantém uma conexão SMTP aberta e reconecta se ela cair."""

    def __init__(self, usuario, senha):
        self.usuario, self.senha, self.smtp = usuario, senha, None

    def _conectar(self):
        self.smtp = smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=60)
        self.smtp.login(self.usuario, self.senha)

    def enviar(self, msg):
        for tentativa in range(2):
            try:
                if self.smtp is None:
                    self._conectar()
                self.smtp.send_message(msg)
                return
            except smtplib.SMTPServerDisconnected:
                self.smtp = None
                if tentativa:
                    raise

    def fechar(self):
        if self.smtp:
            try:
                self.smtp.quit()
            except smtplib.SMTPException:
                pass


# ---------------------------------------------------------------------------
# Cupons
# ---------------------------------------------------------------------------

def gerar_codigo():
    return "NIVER-" + "".join(secrets.choice(ALFABETO_CUPOM) for _ in range(6))


def obter_ou_criar_cupom(sb, pessoa, validade_dias):
    aniversario = date.fromisoformat(pessoa["data_aniversario"])
    filtros = {"pessoa_id": f"eq.{pessoa['id']}", "ano": f"eq.{aniversario.year}", "select": "*"}
    existentes = sb.get("cupons", filtros)
    if existentes:
        return existentes[0]
    for _ in range(5):
        try:
            return sb.insert("cupons", {
                "codigo": gerar_codigo(),
                "pessoa_id": pessoa["id"],
                "ano": aniversario.year,
                "validade": (aniversario + timedelta(days=validade_dias)).isoformat(),
            })
        except RuntimeError as erro:
            if "HTTP 409" not in str(erro):
                raise
            existentes = sb.get("cupons", filtros)  # outra execução criou antes
            if existentes:
                return existentes[0]
    raise RuntimeError("não foi possível gerar um código único")


def enviar_cupons_do_dia(sb, carteiro, config, envio_real):
    beneficios = sb.get("beneficios", {"ativo": "eq.true", "order": "ordem", "select": "nome,descricao"})
    aniversariantes = sb.rpc("aniversariantes", {"p_dias": 0})
    com_email = [p for p in aniversariantes if p.get("email")]
    print(f"Aniversariantes hoje: {len(aniversariantes)} | com email: {len(com_email)}")

    enviados = pulados = falhas = 0
    for pessoa in com_email:
        rotulo = f"#{pessoa['id']} {primeiro_nome(pessoa['nome'])} <{mascarar(pessoa['email'])}>"
        if pessoa.get("cupom_enviado"):
            print(f"  já enviado    {rotulo}")
            pulados += 1
            continue
        if not envio_real:
            print(f"  [simulação]   {rotulo}")
            continue
        try:
            cupom = obter_ou_criar_cupom(sb, pessoa, config["validade_dias"])
            if cupom.get("enviado_em"):
                pulados += 1
                continue
            msg = montar_email(config["remetente_nome"], config["smtp_user"], pessoa["email"], pessoa["nome"],
                               cupom["codigo"], date.fromisoformat(cupom["validade"]), beneficios, config["logo_url"])
            carteiro.enviar(msg)
            sb.update("cupons", {"id": f"eq.{cupom['id']}"},
                      {"enviado_em": datetime.now(timezone.utc).isoformat(), "enviado_para": pessoa["email"]})
            print(f"  enviado       {rotulo}")
            enviados += 1
        except Exception as erro:  # segue com os próximos
            print(f"  FALHA         {rotulo}: {erro}")
            falhas += 1

    modo = "envio real" if envio_real else "simulação (defina ENVIO_REAL=true para enviar)"
    print(f"Resumo [{modo}]: {enviados} enviados | {pulados} já tinham recebido | {falhas} falhas")
    return falhas


# ---------------------------------------------------------------------------

def main():
    carregar_env_local()
    args = sys.argv[1:]

    config = {
        "remetente_nome": os.environ.get("EMAIL_FROM_NAME") or "Vilaj Coworking",
        "validade_dias": int(os.environ.get("VALIDADE_DIAS") or 30),
        "logo_url": os.environ.get("LOGO_URL") or "https://rafaelmendesdeveloper.github.io/vilaj/img/logo.png",
    }

    if args[:1] == ["--teste"]:
        if len(args) < 2:
            sys.exit("Uso: --teste EMAIL")
        config["smtp_user"] = env("SMTP_USER")
        beneficios = [
            {"nome": "Sala de reunião", "descricao": "20% de desconto em 1 reserva (até 4 horas)"},
            {"nome": "Coworking (diária ou plano)", "descricao": "15% de desconto em 1 diária ou na 1ª mensalidade do novo plano"},
            {"nome": "Endereço fiscal/comercial", "descricao": "10% de desconto no 1º trimestre de contratação"},
        ]
        msg = montar_email(config["remetente_nome"], config["smtp_user"], args[1], "Visitante Teste",
                           "NIVER-TESTE7", date.today() + timedelta(days=config["validade_dias"]),
                           beneficios, config["logo_url"])
        carteiro = Carteiro(config["smtp_user"], env("SMTP_PASSWORD"))
        carteiro.enviar(msg)
        carteiro.fechar()
        print(f"Email de teste enviado para {mascarar(args[1])}")
        return 0

    sb = Supabase(env("SUPABASE_URL"), env("SUPABASE_SECRET_KEY"))
    sincronizar(sb, env("CONEXA_SUBDOMAIN"), env("CONEXA_TOKEN"))
    if "--so-sincronizar" in args:
        return 0

    envio_real = (os.environ.get("ENVIO_REAL") or "").lower() == "true"
    carteiro = None
    if envio_real:
        config["smtp_user"] = env("SMTP_USER")
        carteiro = Carteiro(config["smtp_user"], env("SMTP_PASSWORD"))
    try:
        falhas = enviar_cupons_do_dia(sb, carteiro, config, envio_real)
    finally:
        if carteiro:
            carteiro.fechar()
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
