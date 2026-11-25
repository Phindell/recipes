-- Family Recipes — database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

-- Recipes: Name, Photo, Ingredients, Method, Extra notes
create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  photo_url   text,
  ingredients text[] not null default '{}',
  method      text[] not null default '{}',
  notes       text not null default '',
  servings    int,
  source_url  text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Meal planner
create table if not exists public.meal_plan (
  id         uuid primary key default gen_random_uuid(),
  plan_date  date not null,
  slot       text not null check (slot in ('breakfast','lunch','dinner')),
  recipe_id  uuid references public.recipes(id) on delete cascade,
  label      text,
  servings   int,
  created_at timestamptz not null default now()
);
create index if not exists meal_plan_date_idx on public.meal_plan (plan_date);

-- Shared shopping list
create table if not exists public.shopping_items (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  checked     boolean not null default false,
  recipe_name text,
  created_at  timestamptz not null default now()
);

-- Security: only signed-in family members can read or change anything.
alter table public.recipes        enable row level security;
alter table public.meal_plan      enable row level security;
alter table public.shopping_items enable row level security;

drop policy if exists "family access" on public.recipes;
drop policy if exists "family access" on public.meal_plan;
drop policy if exists "family access" on public.shopping_items;
create policy "family access" on public.recipes        for all to authenticated using (true) with check (true);
create policy "family access" on public.meal_plan      for all to authenticated using (true) with check (true);
create policy "family access" on public.shopping_items for all to authenticated using (true) with check (true);

-- Live updates (shopping list ticks show up on everyone's phone)
do $$
begin
  begin alter publication supabase_realtime add table public.recipes;        exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.meal_plan;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.shopping_items; exception when duplicate_object then null; end;
end $$;

-- Photo storage. Photos are viewable by link (needed to show them in the app);
-- only signed-in family members can upload or delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 10485760, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists "family upload photos" on storage.objects;
drop policy if exists "family update photos" on storage.objects;
drop policy if exists "family delete photos" on storage.objects;
create policy "family upload photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "family update photos" on storage.objects for update to authenticated using (bucket_id = 'photos');
create policy "family delete photos" on storage.objects for delete to authenticated using (bucket_id = 'photos');

-- Folders (also available on its own as add-folders.sql)

create table if not exists public.folders (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 60),
  created_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists folders_name_unique on public.folders (lower(trim(name)));

-- A recipe can be in several folders
alter table public.recipes add column if not exists folder_ids uuid[] not null default '{}';
create index if not exists recipes_folder_ids_idx on public.recipes using gin (folder_ids);

-- Anyone signed in (the family) can add, rename and delete folders
alter table public.folders enable row level security;
drop policy if exists "family access" on public.folders;
create policy "family access" on public.folders for all to authenticated using (true) with check (true);

-- Deleting a folder takes it off every recipe (the recipes themselves stay)
create or replace function public.remove_folder_from_recipes() returns trigger
language plpgsql set search_path = public as $$
begin
  update public.recipes set folder_ids = array_remove(folder_ids, old.id) where old.id = any(folder_ids);
  return old;
end $$;
drop trigger if exists folders_cleanup on public.folders;
create trigger folders_cleanup after delete on public.folders
  for each row execute function public.remove_folder_from_recipes();

-- Live updates
do $$ begin
  alter publication supabase_realtime add table public.folders;
exception when duplicate_object then null; end $$;
