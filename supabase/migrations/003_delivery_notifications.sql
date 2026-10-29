-- Nearby delivery offers for active native-app deliverers.
-- Run after 002_order_map.sql.

alter table public.native_orders
  add column if not exists pickup_latitude double precision,
  add column if not exists pickup_longitude double precision;

create table if not exists public.native_delivery_notifications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.native_orders(id) on delete cascade,
  recipient_id uuid not null references public.native_profiles(id) on delete cascade,
  title text not null default 'New nearby delivery',
  body text not null default '',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed', 'expired')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists native_delivery_notifications_recipient_idx
  on public.native_delivery_notifications(recipient_id, status, created_at desc);

create unique index if not exists native_delivery_notifications_pending_idx
  on public.native_delivery_notifications(order_id, recipient_id)
  where status = 'pending';

alter table public.native_delivery_notifications enable row level security;

drop policy if exists "native_delivery_notifications_read_own" on public.native_delivery_notifications;
create policy "native_delivery_notifications_read_own"
  on public.native_delivery_notifications for select to authenticated
  using (recipient_id = auth.uid());

drop policy if exists "native_delivery_notifications_update_own" on public.native_delivery_notifications;
create policy "native_delivery_notifications_update_own"
  on public.native_delivery_notifications for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create or replace function public.notify_nearby_native_deliverers()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.pickup_latitude is null or new.pickup_longitude is null then
    return new;
  end if;

  insert into public.native_delivery_notifications (order_id, recipient_id, title, body)
  select
    new.id,
    locations.user_id,
    'New nearby delivery',
    new.store || ' needs a delivery runner.'
  from public.native_runner_locations locations
  where locations.user_id <> new.orderer_id
    and locations.updated_at > now() - interval '10 minutes'
    and (
      111320 * sqrt(
        power(locations.latitude - new.pickup_latitude, 2)
        + power(
          (locations.longitude - new.pickup_longitude)
          * cos(radians(new.pickup_latitude)),
          2
        )
      )
    ) <= 1500
  on conflict (order_id, recipient_id) where status = 'pending' do nothing;

  return new;
end;
$$;

drop trigger if exists on_native_order_created_notify_deliverers on public.native_orders;
create trigger on_native_order_created_notify_deliverers
  after insert on public.native_orders
  for each row execute procedure public.notify_nearby_native_deliverers();
