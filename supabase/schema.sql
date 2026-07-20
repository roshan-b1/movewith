-- MoveWith anonymous usage counter.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).
-- It creates an insert-only events table so the site can count visits and uploads
-- without exposing anything to read. No personal data: anon_id is a random uuid the
-- browser makes up, and the videos themselves never touch Supabase.

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  event       text not null check (char_length(event) <= 40),
  anon_id     text not null check (char_length(anon_id) <= 64),
  props       jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists events_event_idx      on public.events (event);
create index if not exists events_anon_id_idx     on public.events (anon_id);
create index if not exists events_created_at_idx  on public.events (created_at);

-- Row Level Security: the public (anon) key may INSERT only. It can never read or
-- change rows, so the key being in the client bundle is fine.
alter table public.events enable row level security;

drop policy if exists "anon can insert events" on public.events;
create policy "anon can insert events"
  on public.events for insert
  to anon
  with check (true);

-- Handy read-only views for you (query these in the SQL editor while signed in):
--   distinct visitors:   select count(distinct anon_id) from public.events where event = 'visit';
--   distinct uploaders:  select count(distinct anon_id) from public.events where event = 'upload';
--   total uploads:       select count(*)                from public.events where event = 'upload';
create or replace view public.usage_summary as
  select
    count(distinct anon_id) filter (where event = 'visit')  as distinct_visitors,
    count(distinct anon_id) filter (where event = 'upload') as distinct_uploaders,
    count(*)                filter (where event = 'upload') as total_uploads,
    count(*)                filter (where event = 'visit')  as total_visits
  from public.events;
