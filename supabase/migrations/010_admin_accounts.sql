-- Dashboard admins added from /admin. The server's ADMIN_EMAIL account is the
-- owner and is not stored here. Only the server (service role) can read or
-- write this table: RLS is on and there are no policies for app users.
create table if not exists public.admin_accounts (
  email text primary key check (email = lower(email) and length(email) <= 254),
  name text not null check (length(name) between 1 and 100),
  password_hash text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

alter table public.admin_accounts enable row level security;
revoke all on public.admin_accounts from public, anon, authenticated;
grant all on public.admin_accounts to service_role;
