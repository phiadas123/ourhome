-- Our home: database setup. Paste all of this into Supabase > SQL Editor and press Run.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our home',
  currency text not null default 'GBP',
  invite_code text not null unique default upper(substr(md5(random()::text), 1, 6)),
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  household_id uuid not null references public.households on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  name text not null,
  sections text[] not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  room_id uuid not null references public.rooms on delete cascade,
  section text not null default 'Miscellaneous',
  url text not null,
  title text,
  shop text,
  image_url text,
  price numeric,
  currency text,
  qty int not null default 1,
  included boolean not null default true,
  notes text,
  status text not null default 'ready',
  created_at timestamptz not null default now()
);

create index if not exists items_household_idx on public.items (household_id);
create index if not exists rooms_household_idx on public.rooms (household_id);

-- Is the signed-in person part of this home?
create or replace function public.is_member(h uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.members where household_id = h and user_id = auth.uid());
$$;

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.rooms enable row level security;
alter table public.items enable row level security;

drop policy if exists "members read home" on public.households;
create policy "members read home" on public.households for select using (public.is_member(id));
drop policy if exists "members update home" on public.households;
create policy "members update home" on public.households for update using (public.is_member(id));

drop policy if exists "members see members" on public.members;
create policy "members see members" on public.members for select using (public.is_member(household_id));

drop policy if exists "members manage rooms" on public.rooms;
create policy "members manage rooms" on public.rooms for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

drop policy if exists "members manage items" on public.items;
create policy "members manage items" on public.items for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- Start a new home for the signed-in person.
create or replace function public.create_household(home_name text default 'Our home')
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.households (name) values (coalesce(nullif(trim(home_name), ''), 'Our home')) returning id into new_id;
  insert into public.members (household_id, user_id) values (new_id, auth.uid());
  return new_id;
end; $$;

-- Join a partner's home with their invite code.
create or replace function public.join_household(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into h from public.households where invite_code = upper(trim(code));
  if h is null then raise exception 'That code doesn''t match a home'; end if;
  insert into public.members (household_id, user_id) values (h, auth.uid()) on conflict do nothing;
  return h;
end; $$;

grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- Live updates, so changes from your partner appear straight away.
do $$ begin
  alter publication supabase_realtime add table public.rooms;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when others then null; end $$;
