-- One-time setup for folders and attached files. Paste into Supabase > SQL Editor > New query > Run.
-- Safe to run again: every statement checks first. It only ADDS things; existing notes are untouched.

-- 1) Folders
create table if not exists public.class_folders (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
alter table public.class_folders enable row level security;
drop policy if exists "own rows" on public.class_folders;
create policy "own rows" on public.class_folders for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
alter table public.class_sessions
  add column if not exists folder_id bigint references public.class_folders(id) on delete set null;

-- 2) Attached files: a table that remembers each file, plus a private storage bucket that holds it
create table if not exists public.class_files (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id bigint not null references public.class_sessions(id) on delete cascade,
  name text not null,
  mime text not null default 'application/octet-stream',
  size bigint not null default 0,
  path text not null,
  created_at timestamptz not null default now()
);
alter table public.class_files enable row level security;
drop policy if exists "own rows" on public.class_files;
create policy "own rows" on public.class_files for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit)
values ('class-files', 'class-files', false, 52428800)
on conflict (id) do nothing;

-- each person may only touch files inside their own folder: <user id>/...
drop policy if exists "class-files read own" on storage.objects;
create policy "class-files read own" on storage.objects for select to authenticated
  using (bucket_id = 'class-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "class-files add own" on storage.objects;
create policy "class-files add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'class-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "class-files delete own" on storage.objects;
create policy "class-files delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'class-files' and (storage.foldername(name))[1] = auth.uid()::text);
