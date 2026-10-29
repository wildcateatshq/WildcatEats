-- Give the assigned deliverer one short, server-enforced window to release a
-- request. After 30 seconds the assignment is final. Releasing returns the
-- order to the open request list; it does not cancel the customer's order.

create or replace function public.release_native_delivery(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Please sign in again.';
  end if;

  select claimed_at into v_claimed_at
  from public.native_orders
  where id = p_order_id
    and runner_id = auth.uid()
    and status = 'claimed'
  for update;

  if not found then
    raise exception 'This delivery is no longer assigned to you.';
  end if;

  if v_claimed_at is null or v_claimed_at + interval '30 seconds' <= now() then
    raise exception 'The 30-second cancellation window has ended.';
  end if;

  update public.native_orders
  set runner_id = null,
      status = 'open',
      claimed_at = null
  where id = p_order_id;

  delete from public.native_delivery_handoffs
  where order_id = p_order_id;

  return true;
end;
$$;

revoke all on function public.release_native_delivery(uuid) from public, anon;
grant execute on function public.release_native_delivery(uuid) to authenticated;
