-- Run after 010_admin_accounts.sql. Real card payments for the native app
-- through Stripe. The server (novadash.online) holds the Stripe secret key, so
-- only the service role can read or write these tables.

-- One row per app account: the orderer's saved card and the runner's payout
-- (Stripe Connect Express) account. Card numbers never reach us; Stripe keeps
-- them and we store only its IDs plus the brand and last four digits.
create table if not exists public.native_payment_accounts (
  user_id uuid primary key references public.native_profiles(id) on delete cascade,
  stripe_customer_id text unique,
  payment_method_id text,
  card_brand text,
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  stripe_account_id text unique,
  payouts_ready boolean not null default false,
  updated_at timestamptz not null default now()
);

-- One row per delivery-fee charge. An order can have more than one if a
-- runner released it (refunded) and someone else accepted it.
create table if not exists public.native_order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.native_orders(id) on delete cascade,
  payment_intent_id text not null unique,
  orderer_id uuid not null,
  runner_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  runner_cents integer not null check (runner_cents >= 0),
  status text not null check (status in ('paid', 'refunded')),
  created_at timestamptz not null default now(),
  refunded_at timestamptz
);

create index if not exists native_order_payments_order_idx on public.native_order_payments(order_id);

alter table public.native_payment_accounts enable row level security;
alter table public.native_order_payments enable row level security;
revoke all on public.native_payment_accounts, public.native_order_payments from public, anon, authenticated;
grant all on public.native_payment_accounts, public.native_order_payments to service_role;

-- Accepting and releasing a delivery now go through the server, which charges
-- or refunds the delivery fee in the same step. Without this, an app could
-- call the RPCs directly and skip the payment.
revoke execute on function public.claim_native_delivery(uuid) from authenticated;
revoke execute on function public.release_native_delivery(uuid) from authenticated;

-- Test credits (007) are now only for orders that weren't paid by card, such
-- as dashboard test orders or a server without Stripe keys. They pay the same
-- runner share as a card payment (75%; see PLATFORM_CUT in payments.js).
create or replace function public.pay_native_delivery_runner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cents integer;
begin
  if new.status <> 'delivered' or old.status = 'delivered' or new.runner_id is null then
    return new;
  end if;
  if exists (
    select 1 from public.native_order_payments
    where order_id = new.id and status = 'paid'
  ) then
    return new;
  end if;
  v_cents := least(round(new.tip * 100) - round(round(new.tip * 100) * 0.25), 100000)::integer;
  if v_cents <= 0 then
    return new;
  end if;
  insert into public.native_test_credits (user_id, amount_cents, reason, created_by, request_id)
  values (
    new.runner_id,
    v_cents,
    left('Delivery payout: ' || new.store, 500),
    'delivery',
    new.id
  )
  on conflict (request_id) do nothing;
  return new;
end;
$$;

revoke all on function public.pay_native_delivery_runner() from public, anon, authenticated;
