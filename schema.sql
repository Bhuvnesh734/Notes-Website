-- =====================================================================
-- NOTES PLATFORM — SUPABASE SCHEMA
-- =====================================================================
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New query).
-- It is safe to re-run individual sections, but running the whole file twice
-- will error on things that already exist (tables, policies). If you need to
-- start over, drop the tables/buckets first.
-- =====================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- =====================================================================
-- 1. PROFILES  (one row per auth.users row)
-- =====================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Helper function: check admin status without recursive RLS lookups.
-- SECURITY DEFINER lets it read profiles.is_admin regardless of the caller's RLS.
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

-- Auto-create a profile row whenever a new user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Prevent a normal user from promoting themselves to admin via the API.
-- Admin status may only be granted manually via the Supabase SQL editor
-- (which runs as the postgres role, not through the API) — see README.md.
create or replace function public.prevent_admin_self_promotion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_admin is distinct from old.is_admin and auth.role() <> 'service_role' then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_admin_self_promotion on public.profiles;
create trigger trg_prevent_admin_self_promotion
  before update on public.profiles
  for each row execute function public.prevent_admin_self_promotion();

create policy "profiles: read own or admin reads all"
  on public.profiles for select
  using (auth.uid() = id or public.is_admin(auth.uid()));

create policy "profiles: update own or admin updates all"
  on public.profiles for update
  using (auth.uid() = id or public.is_admin(auth.uid()))
  with check (auth.uid() = id or public.is_admin(auth.uid()));

-- No insert/delete policy for regular users — rows are created only by the
-- handle_new_user trigger (SECURITY DEFINER), so direct inserts are denied by default.

-- =====================================================================
-- 2. SUBJECTS
-- =====================================================================

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table public.subjects enable row level security;

create policy "subjects: anyone can read"
  on public.subjects for select
  using (true);

create policy "subjects: admin can insert"
  on public.subjects for insert
  with check (public.is_admin(auth.uid()));

create policy "subjects: admin can update"
  on public.subjects for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy "subjects: admin can delete"
  on public.subjects for delete
  using (public.is_admin(auth.uid()));

-- =====================================================================
-- 3. NOTES
-- =====================================================================

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subject_id uuid references public.subjects(id) on delete set null,
  class_name text not null,
  chapter text,
  description text,
  pdf_path text not null,        -- path inside the private 'notes-pdfs' bucket
  cover_path text,               -- path inside the public 'cover-images' bucket
  is_free boolean not null default true,
  price numeric(10,2) not null default 0,
  allow_preview boolean not null default true,
  is_featured boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_non_negative check (price >= 0),
  constraint paid_notes_need_price check (is_free = true or price > 0)
);

create index if not exists notes_subject_idx on public.notes(subject_id);
create index if not exists notes_created_at_idx on public.notes(created_at desc);
create index if not exists notes_is_free_idx on public.notes(is_free);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_notes_updated_at on public.notes;
create trigger trg_notes_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

alter table public.notes enable row level security;

create policy "notes: anyone can read"
  on public.notes for select
  using (true);

create policy "notes: admin can insert"
  on public.notes for insert
  with check (public.is_admin(auth.uid()));

create policy "notes: admin can update"
  on public.notes for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy "notes: admin can delete"
  on public.notes for delete
  using (public.is_admin(auth.uid()));

-- =====================================================================
-- 4. ORDERS / ORDER_ITEMS / PURCHASES
--    These are written only by the Edge Functions using the service_role
--    key, which bypasses RLS entirely. Regular users get read-only access
--    to their own rows and no direct write access at all (safer than
--    trying to carve out a narrow insert policy).
-- =====================================================================

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  razorpay_order_id text unique,
  razorpay_payment_id text,
  razorpay_signature text,
  amount numeric(10,2) not null,
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created','paid','failed','cancelled')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete restrict,
  price numeric(10,2) not null
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  purchased_at timestamptz not null default now(),
  unique (user_id, note_id)
);

create index if not exists orders_user_idx on public.orders(user_id);
create index if not exists order_items_order_idx on public.order_items(order_id);
create index if not exists purchases_user_idx on public.purchases(user_id);
create index if not exists purchases_note_idx on public.purchases(note_id);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.purchases enable row level security;

create policy "orders: read own or admin reads all"
  on public.orders for select
  using (auth.uid() = user_id or public.is_admin(auth.uid()));

create policy "order_items: read own or admin reads all"
  on public.order_items for select
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_items.order_id
        and (o.user_id = auth.uid() or public.is_admin(auth.uid()))
    )
  );

create policy "purchases: read own or admin reads all"
  on public.purchases for select
  using (auth.uid() = user_id or public.is_admin(auth.uid()));

-- Intentionally no insert/update/delete policies for these three tables:
-- only the service_role key (used inside the Edge Functions) can write to
-- them, so a payment can never be faked from the browser.

-- =====================================================================
-- 5. STORAGE BUCKETS
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('notes-pdfs', 'notes-pdfs', false, 26214400, array['application/pdf'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cover-images', 'cover-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- --- notes-pdfs: private bucket -----------------------------------------
-- Free notes: anyone (including logged-out visitors) can read the file that
-- belongs to a note marked is_free = true.
create policy "pdf: free notes are readable by anyone"
  on storage.objects for select
  using (
    bucket_id = 'notes-pdfs'
    and exists (
      select 1 from public.notes n
      where n.pdf_path = storage.objects.name and n.is_free = true
    )
  );

-- Paid notes: only readable by a user who has a purchase record for that note.
create policy "pdf: paid notes are readable by purchasers"
  on storage.objects for select
  using (
    bucket_id = 'notes-pdfs'
    and exists (
      select 1 from public.notes n
      join public.purchases p on p.note_id = n.id
      where n.pdf_path = storage.objects.name and p.user_id = auth.uid()
    )
  );

-- Admin: full read access (needed for the admin panel and editing).
create policy "pdf: admin can read all"
  on storage.objects for select
  using (bucket_id = 'notes-pdfs' and public.is_admin(auth.uid()));

create policy "pdf: admin can upload"
  on storage.objects for insert
  with check (bucket_id = 'notes-pdfs' and public.is_admin(auth.uid()));

create policy "pdf: admin can update"
  on storage.objects for update
  using (bucket_id = 'notes-pdfs' and public.is_admin(auth.uid()))
  with check (bucket_id = 'notes-pdfs' and public.is_admin(auth.uid()));

create policy "pdf: admin can delete"
  on storage.objects for delete
  using (bucket_id = 'notes-pdfs' and public.is_admin(auth.uid()));

-- --- cover-images: public bucket ----------------------------------------
create policy "covers: anyone can read"
  on storage.objects for select
  using (bucket_id = 'cover-images');

create policy "covers: admin can upload"
  on storage.objects for insert
  with check (bucket_id = 'cover-images' and public.is_admin(auth.uid()));

create policy "covers: admin can update"
  on storage.objects for update
  using (bucket_id = 'cover-images' and public.is_admin(auth.uid()))
  with check (bucket_id = 'cover-images' and public.is_admin(auth.uid()));

create policy "covers: admin can delete"
  on storage.objects for delete
  using (bucket_id = 'cover-images' and public.is_admin(auth.uid()));

-- =====================================================================
-- 6. MAKE YOURSELF THE FIRST ADMIN
-- =====================================================================
-- 1. Sign up once through the website itself (Sign Up page).
-- 2. Then run this, replacing the email address, in the SQL Editor:
--
--    update public.profiles set is_admin = true where email = 'you@example.com';
--
-- This only works from the SQL Editor / service role — the trigger above
-- blocks this exact update if it's attempted through the normal API.
-- =====================================================================
