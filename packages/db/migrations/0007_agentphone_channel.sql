-- AgentPhone as a message channel and a webhook source (SPEC D-12). Additive only: every value that
-- was accepted before is still accepted. Apply as the non-superuser migration owner. 0001 to 0006 are
-- unchanged. AgentPhone sends SMS through its REST API (channel 'agentphone') and posts calls and texts
-- to one webhook (webhook_events.source 'agentphone').

-- 1. A dispatch may be sent on the agentphone channel. qr_only still never has a dispatch row.
alter table public.message_dispatches drop constraint message_dispatches_channel_check;
alter table public.message_dispatches add constraint message_dispatches_channel_check
  check (channel in ('surge', 'android_gateway', 'whatsapp_sandbox', 'agentphone'));

-- 2. Signature-verified AgentPhone webhook rows are stored and deduplicated like the others
-- (never-broken rule 2): unique (source, provider_event_id), the provider event ID being X-Webhook-ID.
alter table public.webhook_events drop constraint webhook_events_source_check;
alter table public.webhook_events add constraint webhook_events_source_check
  check (source in ('square', 'twilio_voice', 'twilio_status', 'agentphone'));

-- 3. Approval material: an order or booking approval may name agentphone as its message channel.
-- The body is 0004's private.material with that one value added to the routing check. Replacing the
-- function keeps its owner and privileges.
-- Material projection is constructed here, never supplied as a list of keys by the caller.
create or replace function private.material(p_type text, p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare keys text[]; k text; result jsonb := '{}';
begin
  if p_type is null or p_type not in ('order_bundle','booking_bundle','fact_edit','price_edit') then raise exception 'MATERIAL: invalid bundle'; end if;
  keys := array['businessId','subjectId','actionBundle','expiresAt'] || case p_type
    when 'order_bundle' then array['agentVersionId','cartHash','totalMinor','currency','pickupAt','messageRecipient','messageChannel']
    when 'booking_bundle' then array['agentVersionId','serviceId','calendarId','startUtc','endUtc','timezone','messageRecipient','messageChannel']
    when 'fact_edit' then array['kind','key','fromVersion','before','after']
    when 'price_edit' then array['squareItemId','variationId','fromPriceMinor','newPriceMinor','currency','squareVersion']
    else null end;
  if keys is null or pg_catalog.jsonb_typeof(p) is distinct from 'object' then raise exception 'MATERIAL: invalid bundle'; end if;
  foreach k in array keys loop
    -- A customer who declined messages has no recipient. Only qr_only, which never sends,
    -- may omit it or sign it as null; the routing check below validates every other case.
    if k = 'messageRecipient' and p->>'messageChannel' = 'qr_only' and (not p ? k or p->k = 'null'::jsonb) then
      if p ? k then result := result || pg_catalog.jsonb_build_object(k, p->k); end if;
      continue;
    end if;
    if not p ? k then raise exception 'MATERIAL: missing %', k; end if;
    if k in ('actionBundle') then
      if pg_catalog.jsonb_typeof(p->k) is distinct from 'array' then raise exception 'MATERIAL: % must be array', k; end if;
    elsif k in ('totalMinor','fromVersion','fromPriceMinor','newPriceMinor','squareVersion') then
      if pg_catalog.jsonb_typeof(p->k) is distinct from 'number' or (p->>k)::numeric < 0
         or (p->>k)::numeric <> pg_catalog.trunc((p->>k)::numeric) then raise exception 'MATERIAL: % must be nonnegative integer', k; end if;
    elsif k not in ('before','after') and not (k = 'pickupAt' and p->k = 'null'::jsonb) then
      if pg_catalog.jsonb_typeof(p->k) is distinct from 'string' or p->>k = '' then raise exception 'MATERIAL: % must be string', k; end if;
    end if;
    result := result || pg_catalog.jsonb_build_object(k, p->k);
  end loop;
  if p_type in ('order_bundle','price_edit') and p->>'currency' <> 'USD' then raise exception 'MATERIAL: currency'; end if;
  if p_type in ('order_bundle','booking_bundle') and (p->>'messageChannel' not in ('surge','android_gateway','whatsapp_sandbox','qr_only','agentphone')
    or (p->>'messageRecipient' is null and p->>'messageChannel' <> 'qr_only')
    or p->>'messageRecipient' !~ '^\+[1-9][0-9]{6,14}$') then raise exception 'MATERIAL: message routing'; end if;
  return result;
end $$;
