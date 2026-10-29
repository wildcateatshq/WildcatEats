-- Run after 004_native_test_credits.sql. When an order becomes delivered, its
-- payout is recorded as a test credit for the runner, which updates their
-- balance through the existing on_native_test_credit_added trigger. These are
-- test credits, not cash. The order id is the credit's request_id, so a
-- delivery can pay out at most once.

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
  v_cents := least(round(new.tip * 100), 100000)::integer;
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

drop trigger if exists on_native_order_delivered_pay_runner on public.native_orders;
create trigger on_native_order_delivered_pay_runner
  after update of status on public.native_orders
  for each row execute function public.pay_native_delivery_runner();
