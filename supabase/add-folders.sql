-- Family Recipes — folders
-- Safe to run more than once. Paste into Supabase → SQL Editor → New query → Run.

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
