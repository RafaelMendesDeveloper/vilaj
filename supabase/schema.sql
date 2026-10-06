-- =====================================================================
-- Vilaj Coworking — aniversariantes e cupons
-- Rodar inteiro no SQL Editor do Supabase. Pode rodar de novo sem erro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

-- Espelho das pessoas do Conexa (sincronizado pelo cron diário).
-- O id é o personId do Conexa.
create table if not exists pessoas (
  id                  bigint primary key,
  conexa_customer_id  bigint,
  nome                text not null,
  email               text,
  data_nascimento     date,
  ativo               boolean not null default true,
  atualizado_em       timestamptz not null default now(),
  criado_em           timestamptz not null default now()
);

create table if not exists beneficios (
  id         bigint generated always as identity primary key,
  nome       text not null unique,
  descricao  text not null,
  ordem      int not null default 0,
  ativo      boolean not null default true
);

create table if not exists cupons (
  id                bigint generated always as identity primary key,
  codigo            text not null unique,
  pessoa_id         bigint not null references pessoas(id),
  ano               int not null,                 -- ano do aniversário que gerou o cupom
  validade          date not null,
  enviado_para      text,
  enviado_em        timestamptz,
  usado             boolean not null default false,
  usado_em          timestamptz,
  usado_por         uuid references auth.users(id),
  beneficio_id      bigint references beneficios(id),
  criado_em         timestamptz not null default now(),
  unique (pessoa_id, ano)                         -- um cupom por pessoa por ano
);

insert into beneficios (nome, descricao, ordem) values
  ('Sala de reunião',             '20% de desconto em 1 reserva (até 4 horas)',                          1),
  ('Coworking (diária ou plano)', '15% de desconto em 1 diária ou na 1ª mensalidade do novo plano',      2),
  ('Endereço fiscal/comercial',   '10% de desconto no 1º trimestre de contratação',                      3)
on conflict (nome) do nothing;

-- ---------------------------------------------------------------------
-- Segurança: RLS ligado e nenhum acesso direto às tabelas pelo frontend.
-- Tudo passa pelas funções abaixo. O cron usa a secret key (ignora RLS).
-- ---------------------------------------------------------------------

alter table pessoas    enable row level security;
alter table beneficios enable row level security;
alter table cupons     enable row level security;

drop policy if exists "logados leem beneficios" on beneficios;
create policy "logados leem beneficios"
  on beneficios for select
  to authenticated
  using (ativo);

-- ---------------------------------------------------------------------
-- Datas
-- ---------------------------------------------------------------------

create or replace function hoje_sp()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/Sao_Paulo')::date;
$$;

-- Data do aniversário num ano. Quem nasceu em 29/02 comemora em 28/02
-- nos anos não bissextos.
create or replace function aniversario_no_ano(p_nascimento date, p_ano int)
returns date
language sql
immutable
as $$
  select make_date(
    p_ano,
    extract(month from p_nascimento)::int,
    least(
      extract(day from p_nascimento)::int,
      extract(day from (make_date(p_ano, extract(month from p_nascimento)::int, 1)
                        + interval '1 month - 1 day'))::int
    )
  );
$$;

-- ---------------------------------------------------------------------
-- Aniversariantes de hoje até hoje + p_dias (0 = só hoje)
-- ---------------------------------------------------------------------

drop function if exists aniversariantes(int);
create or replace function aniversariantes(p_dias int default 0)
returns table (
  id               bigint,
  nome             text,
  email            text,
  ativo            boolean,
  data_nascimento  date,
  data_aniversario date,
  idade            int,
  cupom_enviado    boolean,
  cupom_usado      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select p.*,
           aniversario_no_ano(p.data_nascimento, extract(year from hoje_sp())::int) as neste_ano
      from pessoas p
     where p.data_nascimento is not null
  ),
  prox as (
    select b.*,
           case when b.neste_ano < hoje_sp()
                then aniversario_no_ano(b.data_nascimento, extract(year from hoje_sp())::int + 1)
                else b.neste_ano end as data_aniversario
      from base b
  )
  select x.id, x.nome, x.email, x.ativo, x.data_nascimento, x.data_aniversario,
         (extract(year from x.data_aniversario) - extract(year from x.data_nascimento))::int,
         coalesce(c.enviado_em is not null, false),
         coalesce(c.usado, false)
    from prox x
    left join cupons c
      on c.pessoa_id = x.id
     and c.ano = extract(year from x.data_aniversario)::int
   where x.data_aniversario between hoje_sp() and hoje_sp() + greatest(p_dias, 0)
   order by x.data_aniversario, x.nome;
$$;

-- ---------------------------------------------------------------------
-- Cupons: consultar (só lê) e usar (marca como usado)
-- Aceita "NIVER-AB12CD", "niver ab12cd" ou só "AB12CD".
-- ---------------------------------------------------------------------

create or replace function normalizar_codigo(p_codigo text)
returns text
language sql
immutable
as $$
  select case
           when c ~ '^NIVER' then 'NIVER-' || substr(c, 6)
           else 'NIVER-' || c
         end
    from (select regexp_replace(upper(coalesce(p_codigo, '')), '[^A-Z0-9]', '', 'g') as c) t;
$$;

create or replace function consultar_cupom(p_codigo text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  c   cupons%rowtype;
  p   pessoas%rowtype;
  b   beneficios%rowtype;
  quem text;
  situacao text;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'situacao', 'nao_autenticado');
  end if;

  select * into c from cupons where codigo = normalizar_codigo(p_codigo);
  if not found then
    return json_build_object('ok', false, 'situacao', 'inexistente',
                             'codigo', normalizar_codigo(p_codigo));
  end if;

  select * into p from pessoas where id = c.pessoa_id;
  select * into b from beneficios where id = c.beneficio_id;
  select email into quem from auth.users where id = c.usado_por;

  situacao := case
                when c.usado then 'usado'
                when c.validade < hoje_sp() then 'vencido'
                else 'valido'
              end;

  return json_build_object(
    'ok',         situacao = 'valido',
    'situacao',   situacao,
    'codigo',     c.codigo,
    'nome',       p.nome,
    'email',      c.enviado_para,
    'validade',   c.validade,
    'usado_em',   c.usado_em,
    'usado_por',  quem,
    'beneficio',  b.nome
  );
end;
$$;

create or replace function usar_cupom(p_codigo text, p_beneficio_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  c cupons%rowtype;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'situacao', 'nao_autenticado');
  end if;

  if not exists (select 1 from beneficios where id = p_beneficio_id and ativo) then
    return json_build_object('ok', false, 'situacao', 'beneficio_invalido');
  end if;

  select * into c from cupons where codigo = normalizar_codigo(p_codigo) for update;

  if not found then
    return json_build_object('ok', false, 'situacao', 'inexistente');
  elsif c.usado then
    return json_build_object('ok', false, 'situacao', 'usado', 'usado_em', c.usado_em);
  elsif c.validade < hoje_sp() then
    return json_build_object('ok', false, 'situacao', 'vencido', 'validade', c.validade);
  end if;

  update cupons
     set usado = true, usado_em = now(), usado_por = auth.uid(), beneficio_id = p_beneficio_id
   where id = c.id;

  return json_build_object('ok', true, 'cupom', consultar_cupom(c.codigo));
end;
$$;

-- ---------------------------------------------------------------------
-- Permissões: só usuários logados (e o cron) chamam as funções
-- ---------------------------------------------------------------------

revoke all on function aniversariantes(int)            from public, anon;
revoke all on function consultar_cupom(text)           from public, anon;
revoke all on function usar_cupom(text, bigint)        from public, anon;

grant execute on function aniversariantes(int)         to authenticated, service_role;
grant execute on function consultar_cupom(text)        to authenticated;
grant execute on function usar_cupom(text, bigint)     to authenticated;
