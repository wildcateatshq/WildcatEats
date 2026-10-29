-- Order-number persistence and live runner markers for the native order map.

-- The SQL editor is often used to run this file by itself. Keep the base
-- objects idempotent here as well, so this migration does not depend on the
-- user having pasted 001_native_app.sql first.
create extension if not exists pgcrypto;

create table if not exists public.native_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  email text not null,
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists public.native_orders (
  id uuid primary key default gen_random_uuid(),
  orderer_id uuid not null references public.native_profiles(id) on delete cascade,
  runner_id uuid references public.native_profiles(id) on delete set null,
  store text not null,
  hall text not null,
  pickup_latitude double precision,
  pickup_longitude double precision,
  dropoff_details text not null default '',
  items text not null,
  tip numeric not null default 0,
  status text not null default 'open' check (status in ('open', 'claimed', 'picked_up', 'arrived', 'delivered', 'cancelled')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  picked_up_at timestamptz,
  arrived_at timestamptz,
  delivered_at timestamptz
);

create index if not exists native_orders_open_created_idx on public.native_orders(status, created_at desc);

alter table public.native_profiles enable row level security;
alter table public.native_orders enable row level security;

drop policy if exists "native_profiles_select_own" on public.native_profiles;
create policy "native_profiles_select_own" on public.native_profiles for select to authenticated using (id = auth.uid());
drop policy if exists "native_profiles_insert_own" on public.native_profiles;
create policy "native_profiles_insert_own" on public.native_profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists "native_profiles_update_own" on public.native_profiles;
create policy "native_profiles_update_own" on public.native_profiles for update to authenticated using (id = auth.uid());

drop policy if exists "native_orders_read_authenticated" on public.native_orders;
create policy "native_orders_read_authenticated" on public.native_orders for select to authenticated using (true);
drop policy if exists "native_orders_create_own" on public.native_orders;
create policy "native_orders_create_own" on public.native_orders for insert to authenticated with check (orderer_id = auth.uid());
drop policy if exists "native_orders_update_participant" on public.native_orders;
create policy "native_orders_update_participant" on public.native_orders for update to authenticated using (orderer_id = auth.uid() or runner_id = auth.uid() or (status = 'open' and runner_id is null)) with check (orderer_id = auth.uid() or runner_id = auth.uid());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.native_profiles (id, name, email, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Also create profiles for users who existed before this trigger was added.
insert into public.native_profiles (id, name, email, phone)
select
  id,
  coalesce(raw_user_meta_data ->> 'name', ''),
  coalesce(email, ''),
  raw_user_meta_data ->> 'phone'
from auth.users
on conflict (id) do update set email = excluded.email;

alter table public.native_orders
  add column if not exists order_number text not null default '',
  add column if not exists pickup_latitude double precision,
  add column if not exists pickup_longitude double precision;

create table if not exists public.native_runner_locations (
  user_id uuid primary key references public.native_profiles(id) on delete cascade,
  display_name text not null default 'Runner',
  latitude double precision not null,
  longitude double precision not null,
  updated_at timestamptz not null default now()
);

create index if not exists native_runner_locations_updated_idx on public.native_runner_locations(updated_at desc);

alter table public.native_runner_locations enable row level security;

drop policy if exists "native_runner_locations_read_authenticated" on public.native_runner_locations;
create policy "native_runner_locations_read_authenticated"
  on public.native_runner_locations for select to authenticated using (true);

drop policy if exists "native_runner_locations_write_own" on public.native_runner_locations;
create policy "native_runner_locations_write_own"
  on public.native_runner_locations for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "native_runner_locations_update_own" on public.native_runner_locations;
create policy "native_runner_locations_update_own"
  on public.native_runner_locations for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
