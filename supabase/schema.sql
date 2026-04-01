-- Extensions
create extension if not exists "pgcrypto";

-- Charities
create table if not exists public.charities (
  id text primary key,
  name text not null,
  description text not null
);

-- Profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'user',
  is_subscribed boolean not null default false,
  plan text not null default 'free',
  charity_id text references public.charities(id),
  contribution_percentage integer not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Scores
create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  score integer not null check (score between 1 and 45),
  created_at timestamptz not null default now()
);

-- Draws
create table if not exists public.draws (
  id uuid primary key default gen_random_uuid(),
  numbers integer[] not null,
  created_at timestamptz not null default now()
);

-- Results
create table if not exists public.results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  draw_id uuid not null references public.draws(id) on delete cascade,
  draw_date timestamptz not null,
  matches integer not null default 0,
  winnings integer not null default 0,
  created_at timestamptz not null default now()
);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- Create a profile automatically when auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role, is_subscribed, plan, charity_id, contribution_percentage)
  values (
    new.id,
    coalesce(new.email, ''),
    'user',
    false,
    'free',
    (select id from public.charities order by name asc limit 1),
    10
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- RLS
alter table public.charities enable row level security;
alter table public.profiles enable row level security;
alter table public.scores enable row level security;
alter table public.draws enable row level security;
alter table public.results enable row level security;

-- Helpers
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

-- Charities policies
drop policy if exists "read charities" on public.charities;
create policy "read charities"
on public.charities
for select
to authenticated, anon
using (true);

-- Profiles policies
drop policy if exists "read own profile or admin" on public.profiles;
create policy "read own profile or admin"
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists "update own profile or admin" on public.profiles;
create policy "update own profile or admin"
on public.profiles
for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

drop policy if exists "insert own profile or admin" on public.profiles;
create policy "insert own profile or admin"
on public.profiles
for insert
to authenticated
with check (id = auth.uid() or public.is_admin());

-- Scores policies
drop policy if exists "read own scores or admin" on public.scores;
create policy "read own scores or admin"
on public.scores
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "insert own scores" on public.scores;
create policy "insert own scores"
on public.scores
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "delete own scores or admin" on public.scores;
create policy "delete own scores or admin"
on public.scores
for delete
to authenticated
using (user_id = auth.uid() or public.is_admin());

-- Draws policies
drop policy if exists "read draws" on public.draws;
create policy "read draws"
on public.draws
for select
to authenticated
using (true);

drop policy if exists "insert draws admin only" on public.draws;
create policy "insert draws admin only"
on public.draws
for insert
to authenticated
with check (public.is_admin());

-- Results policies
drop policy if exists "read results own or admin" on public.results;
create policy "read results own or admin"
on public.results
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "insert results admin only" on public.results;
create policy "insert results admin only"
on public.results
for insert
to authenticated
with check (public.is_admin());

-- Seed charities
insert into public.charities (id, name, description)
values
  ('charity-hope', 'Hope Harbor', 'Supports food banks and emergency housing relief.'),
  ('charity-kids', 'Bright Futures Fund', 'Funds youth education, tutoring, and school supplies.'),
  ('charity-health', 'Health for All', 'Helps with clinics, screenings, and care access.'),
  ('charity-earth', 'Green Earth Trust', 'Invests in clean water, conservation, and climate work.')
on conflict (id) do nothing;
