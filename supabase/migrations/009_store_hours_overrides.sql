-- Admin-controlled exceptions to Villanova's published dining hours.
-- Only the service-role-backed admin dashboard can write these rows. The
-- active state is public so signed-out and signed-in app sessions agree.

create table if not exists public.native_store_hours_overrides (
  store text primary key check (store in (
    'COVA',
    'Cascia',
    'Connelly Center',
    'St. Mary''s',
    'Wawa',
    'Holy Grounds (Bartley)'
  )),
  force_open boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.native_store_hours_overrides enable row level security;

revoke all on table public.native_store_hours_overrides from public, anon, authenticated;
grant select on table public.native_store_hours_overrides to anon, authenticated;

drop policy if exists "Anyone can read store-hour overrides" on public.native_store_hours_overrides;
create policy "Anyone can read store-hour overrides"
on public.native_store_hours_overrides
for select
to anon, authenticated
using (true);
