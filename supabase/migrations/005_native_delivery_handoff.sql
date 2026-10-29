-- Run after 003_delivery_notifications.sql. A delivery can only be completed
-- with a short-lived secret displayed by its orderer. Both nearby tap and QR
-- use this same server-side, one-time verification.

create table if not exists public.native_delivery_handoffs (
  order_id uuid primary key references public.native_orders(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  confirmation_method text check (confirmation_method in ('tap', 'qr'))
);

alter table public.native_delivery_handoffs enable row level security;
-- No direct table policies: clients use only the narrow functions below.
revoke all on public.native_delivery_handoffs from public, anon, authenticated;

-- The old participant UPDATE policy allowed a client to set status=delivered
-- directly. Claims and handoffs now go through checked SECURITY DEFINER RPCs.
revoke update on public.native_orders from public, anon, authenticated;
drop policy if exists "native_orders_update_participant" on public.native_orders;
drop policy if exists "native_orders_create_own" on public.native_orders;
create policy "native_orders_create_own" on public.native_orders
  for insert to authenticated
  with check (
    orderer_id = auth.uid() and runner_id is null and status = 'open'
    and claimed_at is null and picked_up_at is null
    and arrived_at is null and delivered_at is null
  );

create or replace function public.claim_native_delivery(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orderer uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in again.';
  end if;

  select orderer_id into v_orderer
  from public.native_orders
  where id = p_order_id and status = 'open' and runner_id is null
  for update;

  if v_orderer is null then
    raise exception 'Another student has already accepted this request.';
  end if;

  if v_orderer = auth.uid() and not exists (
    select 1 from public.native_delivery_notifications
    where order_id = p_order_id
      and recipient_id = auth.uid()
      and title = 'Test delivery request'
  ) then
    raise exception 'You cannot accept your own order.';
  end if;

  update public.native_orders
  set runner_id = auth.uid(), status = 'claimed', claimed_at = now()
  where id = p_order_id;
  return true;
end;
$$;

create or replace function public.start_native_delivery_handoff(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if auth.uid() is null then
    raise exception 'Please sign in again.';
  end if;
  perform 1 from public.native_orders
  where id = p_order_id and orderer_id = auth.uid()
    and runner_id is not null
    and status in ('claimed', 'picked_up', 'arrived')
  for update;
  if not found then
    raise exception 'This order is not ready for handoff.';
  end if;

  -- Two independent random UUIDs make a 256-bit bearer secret. Only its hash
  -- is retained; issuing a new code invalidates the prior code.
  v_token := replace(pg_catalog.gen_random_uuid()::text, '-', '')
          || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into public.native_delivery_handoffs
    (order_id, token_hash, expires_at, created_at, completed_at, confirmation_method)
  values (p_order_id, pg_catalog.md5(v_token), now() + interval '10 minutes', now(), null, null)
  on conflict (order_id) do update
    set token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at,
        completed_at = null,
        confirmation_method = null;
  return v_token;
end;
$$;

create or replace function public.complete_native_delivery_handoff(
  p_order_id uuid, p_token text, p_method text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff public.native_delivery_handoffs%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Please sign in again.';
  end if;
  if p_method not in ('tap', 'qr') then
    raise exception 'Invalid handoff method.';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid handoff code.';
  end if;

  perform 1 from public.native_orders
  where id = p_order_id and runner_id = auth.uid()
    and status in ('claimed', 'picked_up', 'arrived')
  for update;
  if not found then
    raise exception 'Only the assigned deliverer can complete this order.';
  end if;

  select * into v_handoff from public.native_delivery_handoffs
  where order_id = p_order_id for update;
  if not found or v_handoff.completed_at is not null
     or v_handoff.expires_at <= now()
     or v_handoff.token_hash <> pg_catalog.md5(p_token) then
    raise exception 'The handoff code expired or is invalid. Ask the recipient to refresh it.';
  end if;

  update public.native_delivery_handoffs
  set completed_at = now(), confirmation_method = p_method
  where order_id = p_order_id;
  update public.native_orders
  set status = 'delivered', delivered_at = now()
  where id = p_order_id;
  return true;
end;
$$;

revoke all on function public.claim_native_delivery(uuid) from public, anon;
revoke all on function public.start_native_delivery_handoff(uuid) from public, anon;
revoke all on function public.complete_native_delivery_handoff(uuid, text, text) from public, anon;
grant execute on function public.claim_native_delivery(uuid) to authenticated;
grant execute on function public.start_native_delivery_handoff(uuid) to authenticated;
grant execute on function public.complete_native_delivery_handoff(uuid, text, text) to authenticated;
