# Vilaj — Cupons de aniversário

Sistema da Vilaj Coworking que envia cupons de aniversário por email e permite validar esses cupons na recepção.

- **Site:** https://rafaelmendesdeveloper.github.io/vilaj/
- **Tela de login:** os usuários são criados no Supabase (não há cadastro aberto).
- **Área logada:** validar cupom e ver os aniversariantes (hoje, 7 dias, 30 dias).
- **Rotina diária (08:00):** sincroniza as pessoas do Conexa, gera um cupom para cada aniversariante do dia e envia o email.

```
Conexa (/persons) ──▶ GitHub Actions (cron 08:00) ──▶ Supabase (pessoas, cupons)
                              │                              ▲
                              └──▶ Gmail SMTP ──▶ cliente     │
                                                             │
                      GitHub Pages (login + validar) ────────┘
```

## Regras

- Um cupom por pessoa por ano, no formato `NIVER-XXXXXX`, válido por 30 dias a partir do aniversário (`VALIDADE_DIAS`).
- O cupom vale para **um** benefício, escolhido na hora da validação:
  - Sala de reunião: 20% de desconto em 1 reserva (até 4 horas)
  - Coworking (diária ou plano): 15% de desconto em 1 diária ou na 1ª mensalidade do novo plano
  - Endereço fiscal/comercial: 10% de desconto no 1º trimestre de contratação
- Os benefícios ficam na tabela `beneficios` e podem ser editados pelo Table Editor do Supabase.
- Entram todas as pessoas do Conexa com data de nascimento e email, ativas ou não. As inativas aparecem marcadas na lista.
- Quem nasceu em 29/02 recebe o cupom em 28/02 nos anos não bissextos.
- Rodar a rotina duas vezes no mesmo dia não manda email duplicado.

## Estrutura

```
frontend/                 site (GitHub Pages)
  index.html              login
  app.html                validar cupom + aniversariantes
  js/supabase.js          URL e chave pública do Supabase
cron/
  rotina_diaria.py        sincroniza Conexa, gera cupons, envia emails (só biblioteca padrão)
  template_email.html     email do cupom
supabase/schema.sql       tabelas, RLS e funções
.github/workflows/
  cron.yml                rotina diária + email de teste manual
  pages.yml               publica o frontend
```

## Configuração

### Supabase
1. **SQL Editor:** rodar `supabase/schema.sql` inteiro. Pode rodar de novo depois de mudanças.
2. **Authentication → Sign In / Providers:** desligar *Allow new users to sign up*.
3. **Authentication → URL Configuration:** Site URL = `https://rafaelmendesdeveloper.github.io/vilaj/`.
4. Novos usuários: **Authentication → Users → Add user** (marcar *Auto Confirm User*).

### Gmail (senha de app)
O Google não aceita a senha normal da conta para SMTP. Para gerar uma senha de app:
1. Ativar a verificação em 2 etapas da conta `lalis@vilaj.com.br`.
2. Acessar https://myaccount.google.com/apppasswords e criar uma senha de app chamada "Vilaj Cupons".
3. Gravar os 16 caracteres no secret `SMTP_PASSWORD`, sem espaços.

Em conta Google Workspace, o administrador precisa permitir senhas de app.

### GitHub (Settings → Secrets and variables → Actions)

| Secret | |
|---|---|
| `SUPABASE_URL` | URL do projeto |
| `SUPABASE_SECRET_KEY` | secret key (`sb_secret_...`) |
| `CONEXA_SUBDOMAIN` | `vilajcoworking` |
| `CONEXA_TOKEN` | token de API do Conexa |
| `SMTP_USER` | `lalis@vilaj.com.br` |
| `SMTP_PASSWORD` | senha de app do Google |

| Variable | |
|---|---|
| `ENVIO_REAL` | `true` para enviar de verdade. Com qualquer outro valor a rotina só simula. |
| `VALIDADE_DIAS` | dias de validade do cupom (padrão 30) |

## Operação

- **Testar o email:** Actions → *Cupons de aniversário* → *Run workflow* → preencher `email_teste`.
- **Rodar a rotina na mão:** o mesmo botão, com `email_teste` vazio.
- **Ligar o envio:** mudar a variável `ENVIO_REAL` para `true`.
- **Atenção:** em repositório público, o GitHub desliga os workflows agendados depois de 60 dias sem commits. Quando chegar o aviso por email, basta reativar em Actions.

### Rodar localmente

```bash
cp .env.exemplo .env   # preencher
python3 cron/rotina_diaria.py --so-sincronizar
python3 cron/rotina_diaria.py                 # simulação, se ENVIO_REAL != true
python3 cron/rotina_diaria.py --teste voce@email.com
```

O frontend é HTML puro: `python3 -m http.server -d frontend 8000` e abrir http://localhost:8000.
