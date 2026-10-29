-- Allow an orderer to cancel an order only while it is still unclaimed.
-- Direct updates remain revoked; cancellation goes through this checked RPC.

create or replace function public.cancel_native_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Please sign in again.';
  end if;

  update public.native_orders
  set status = 'cancelled'
  where id = p_order_id
    and orderer_id = auth.uid()
    and runner_id is null
    and status = 'open';

  if not found then
    raise exception 'This order has already been accepted or cancelled.';
  end if;
  return true;
end;
$$;

revoke all on function public.cancel_native_order(uuid) from public, anon;
grant execute on function public.cancel_native_order(uuid) to authenticated;
