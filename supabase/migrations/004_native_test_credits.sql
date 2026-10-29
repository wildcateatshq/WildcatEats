-- Admin-issued test credits for native accounts. These are not cash, payments,
-- or withdrawable funds. Only the server's secret/service-role key may insert.
create table if not exists public.native_test_balances (
  user_id uuid primary key references public.native_profiles(id) on delete cascade,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.native_test_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.native_profiles(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 100000),
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  created_by text not null,
  request_id uuid not null unique,
  created_at timestamptz not null default now()
);

create index if not exists native_test_credits_user_created_idx
  on public.native_test_credits(user_id, created_at desc);

create or replace function public.apply_native_test_credit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.native_test_balances (user_id, balance_cents, updated_at)
  values (new.user_id, new.amount_cents, now())
  on conflict (user_id) do update
    set balance_cents = public.native_test_balances.balance_cents + excluded.balance_cents,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_native_test_credit_added on public.native_test_credits;
create trigger on_native_test_credit_added
  after insert on public.native_test_credits
  for each row execute function public.apply_native_test_credit();

alter table public.native_test_balances enable row level security;
alter table public.native_test_credits enable row level security;

drop policy if exists "native_test_balances_select_own" on public.native_test_balances;
create policy "native_test_balances_select_own"
  on public.native_test_balances for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "native_test_credits_select_own" on public.native_test_credits;
create policy "native_test_credits_select_own"
  on public.native_test_credits for select to authenticated
  using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.native_test_balances from anon, authenticated;
revoke insert, update, delete on public.native_test_credits from anon, authenticated;
grant select on public.native_test_balances, public.native_test_credits to authenticated;
grant all on public.native_test_balances, public.native_test_credits to service_role;
