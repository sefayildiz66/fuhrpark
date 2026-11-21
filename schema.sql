-- YILDIZ TAXI – Fuhrpark & Behörden
-- Fahrer stempeln per PIN mit Fahrzeug, Vorgänge (Strafen, Lenkerauskunft, Rechnungen) werden automatisch dem Fahrer zugeordnet.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tabellen ----------
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.settings (
  id int primary key default 1 check (id = 1),
  company_name text not null default 'YILDIZ TAXI KG',
  company_address text,
  signer text default 'Sefa Yildiz'
);
insert into public.settings(id) values (1) on conflict do nothing;

create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  birth_date date,
  address text,
  phone text,
  email text,
  licence_no text,
  licence_authority text,
  taxi_licence_no text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- PINs getrennt, damit sie nie in die App geladen werden
create table public.driver_pins (
  driver_id uuid primary key references public.drivers(id) on delete cascade,
  pin_hash text not null
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  plate text not null check (length(trim(plate)) > 0),
  plate_norm text generated always as (upper(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g'))) stored,
  model text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index vehicles_plate_norm_uq on public.vehicles(plate_norm);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete restrict,
  vehicle_id uuid not null references public.vehicles(id) on delete restrict,
  start_at timestamptz not null,
  end_at timestamptz,
  start_km integer check (start_km is null or start_km >= 0),
  end_km integer check (end_km is null or end_km >= 0),
  source text not null default 'stempel' check (source in ('stempel','manuell')),
  auto_closed boolean not null default false,
  note text,
  edited boolean not null default false,
  created_at timestamptz not null default now(),
  check (end_at is null or end_at >= start_at)
);
create index trips_driver_idx on public.trips(driver_id);
create index trips_vehicle_time_idx on public.trips(vehicle_id, start_at);
create index trips_start_idx on public.trips(start_at);
create unique index trips_one_open_per_driver on public.trips(driver_id) where end_at is null;
create unique index trips_one_open_per_vehicle on public.trips(vehicle_id) where end_at is null;

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('lenkerauskunft','anonymverfuegung','strafverfuegung','organstrafverfuegung','rechnung','sonstiges')),
  vehicle_id uuid references public.vehicles(id) on delete set null,
  plate_text text,
  incident_at timestamptz,
  location text,
  offense text,
  authority text,
  reference text,
  received_at date,
  due_at date,
  amount numeric(10,2) check (amount is null or amount >= 0),
  driver_id uuid references public.drivers(id) on delete set null,
  driver_auto boolean not null default false,
  status text not null default 'offen' check (status in ('offen','beantwortet','bezahlt','einspruch','erledigt')),
  done_at timestamptz,
  charge_driver boolean not null default false,
  driver_paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cases_due_idx on public.cases(due_at);
create index cases_vehicle_idx on public.cases(vehicle_id);
create index cases_driver_idx on public.cases(driver_id);

create table public.case_files (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  path text not null unique,
  name text not null,
  size bigint,
  mime text,
  created_at timestamptz not null default now()
);
create index case_files_case_idx on public.case_files(case_id);

create table public.pin_attempts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now()
);
create index pin_attempts_at_idx on public.pin_attempts(at);

-- ---------- Zugriffsschutz ----------
alter table public.admins enable row level security;
alter table public.settings enable row level security;
alter table public.drivers enable row level security;
alter table public.driver_pins enable row level security;
alter table public.vehicles enable row level security;
alter table public.trips enable row level security;
alter table public.cases enable row level security;
alter table public.case_files enable row level security;
alter table public.pin_attempts enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admins where user_id = (select auth.uid())) $$;

create policy "admin sieht eigenen Eintrag" on public.admins for select to authenticated using (user_id = (select auth.uid()));
create policy "chef settings" on public.settings for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "chef drivers" on public.drivers for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "chef vehicles" on public.vehicles for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "chef trips" on public.trips for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "chef cases" on public.cases for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "chef case_files" on public.case_files for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
-- driver_pins und pin_attempts: keine Policies = nur über Funktionen erreichbar

-- Erster angemeldeter Benutzer wird Chef
create or replace function public.claim_admin()
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then return false; end if;
  if not exists (select 1 from public.admins) then
    insert into public.admins(user_id) values (auth.uid());
  end if;
  return exists (select 1 from public.admins where user_id = auth.uid());
end $$;

-- ---------- PIN verwalten ----------
create or replace function public.set_driver_pin(p_driver uuid, p_pin text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if p_pin is null or p_pin = '' then
    delete from public.driver_pins where driver_id = p_driver; return;
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'pin_format'; end if;
  if exists (select 1 from public.driver_pins dp join public.drivers d on d.id = dp.driver_id
             where d.active and dp.driver_id <> p_driver and dp.pin_hash = extensions.crypt(p_pin, dp.pin_hash)) then
    raise exception 'pin_taken';
  end if;
  insert into public.driver_pins(driver_id, pin_hash)
    values (p_driver, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
    on conflict (driver_id) do update set pin_hash = excluded.pin_hash;
end $$;

create or replace function public.drivers_with_pin()
returns setof uuid language sql stable security definer set search_path = ''
as $$ select driver_id from public.driver_pins where public.is_admin() $$;

-- ---------- Stempeln (Fahrer, ohne Login, nur PIN) ----------
create or replace function public.driver_stamp(p_pin text, p_action text default 'check', p_vehicle uuid default null, p_km integer default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_drv record; v_trip record; v_veh record; v_other record;
  v_now timestamptz := now();
begin
  delete from public.pin_attempts where at < v_now - interval '1 day';
  if (select count(*) from public.pin_attempts where at > v_now - interval '10 minutes') >= 15 then
    return jsonb_build_object('error', 'locked');
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    insert into public.pin_attempts default values;
    return jsonb_build_object('error', 'unknown');
  end if;
  select d.id, d.name into v_drv from public.drivers d join public.driver_pins dp on dp.driver_id = d.id
    where d.active and dp.pin_hash = extensions.crypt(p_pin, dp.pin_hash) limit 1;
  if not found then
    insert into public.pin_attempts default values;
    return jsonb_build_object('error', 'unknown');
  end if;

  select t.*, v.plate into v_trip from public.trips t join public.vehicles v on v.id = t.vehicle_id
    where t.driver_id = v_drv.id and t.end_at is null for update of t;

  if p_action = 'start' then
    if v_trip.id is not null then return jsonb_build_object('error', 'already_in'); end if;
    select * into v_veh from public.vehicles where id = p_vehicle and active;
    if not found then return jsonb_build_object('error', 'no_vehicle'); end if;
    -- Auto noch bei jemand anderem offen? -> dort automatisch beenden (ein Auto = ein Fahrer)
    select * into v_other from public.trips where vehicle_id = v_veh.id and end_at is null for update;
    if found then
      update public.trips set end_at = greatest(v_now, v_other.start_at), auto_closed = true,
        note = trim(coalesce(note, '') || ' Automatisch beendet: Fahrzeug von anderem Fahrer übernommen.')
        where id = v_other.id;
    end if;
    insert into public.trips(driver_id, vehicle_id, start_at, start_km, source)
      values (v_drv.id, v_veh.id, v_now, p_km, 'stempel');
    return jsonb_build_object('ok', true, 'action', 'start', 'name', split_part(v_drv.name, ' ', 1), 'plate', v_veh.plate, 'at', v_now);

  elsif p_action = 'end' then
    if v_trip.id is null then return jsonb_build_object('error', 'not_in'); end if;
    if p_km is not null and v_trip.start_km is not null and p_km < v_trip.start_km then
      return jsonb_build_object('error', 'km_low', 'start_km', v_trip.start_km);
    end if;
    update public.trips set end_at = v_now, end_km = p_km where id = v_trip.id;
    return jsonb_build_object('ok', true, 'action', 'end', 'name', split_part(v_drv.name, ' ', 1), 'plate', v_trip.plate, 'at', v_now,
      'minutes', round(extract(epoch from (v_now - v_trip.start_at)) / 60),
      'km', case when p_km is not null and v_trip.start_km is not null then p_km - v_trip.start_km end);

  else
    return jsonb_build_object('ok', true, 'name', split_part(v_drv.name, ' ', 1),
      'state', case when v_trip.id is null then 'out' else 'in' end,
      'trip', case when v_trip.id is null then null else jsonb_build_object('plate', v_trip.plate, 'start_at', v_trip.start_at, 'start_km', v_trip.start_km) end,
      'vehicles', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'plate', v.plate, 'model', v.model,
                      'busy', (select split_part(d2.name, ' ', 1) from public.trips t2 join public.drivers d2 on d2.id = t2.driver_id
                               where t2.vehicle_id = v.id and t2.end_at is null limit 1)) order by v.plate), '[]'::jsonb)
                   from public.vehicles v where v.active));
  end if;
end $$;

-- ---------- Wer ist gefahren? ----------
create or replace function public.who_drove(p_vehicle uuid, p_at timestamptz)
returns table(trip_id uuid, driver_id uuid, driver_name text, start_at timestamptz, end_at timestamptz, exact boolean, gap_min integer)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.driver_id, d.name, t.start_at, t.end_at,
    (t.start_at <= p_at and coalesce(t.end_at, now()) >= p_at) as exact,
    round(case when t.start_at > p_at then extract(epoch from t.start_at - p_at) / 60
               when coalesce(t.end_at, now()) < p_at then extract(epoch from p_at - coalesce(t.end_at, now())) / 60
               else 0 end)::int as gap_min
  from public.trips t join public.drivers d on d.id = t.driver_id
  where public.is_admin() and t.vehicle_id = p_vehicle
    and t.start_at <= p_at + interval '24 hours'
    and coalesce(t.end_at, now()) >= p_at - interval '24 hours'
  order by gap_min, t.start_at
  limit 6
$$;

-- ---------- Vorgänge: Kennzeichen erkennen, Fahrer automatisch zuordnen ----------
create or replace function public.cases_before_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_ids uuid[];
begin
  new.updated_at := now();
  if new.vehicle_id is null and coalesce(new.plate_text, '') <> '' then
    select id into new.vehicle_id from public.vehicles
      where plate_norm = upper(regexp_replace(new.plate_text, '[^A-Za-z0-9]', '', 'g'));
  end if;
  if tg_op = 'UPDATE' then
    if new.driver_id is distinct from old.driver_id then
      new.driver_auto := false;            -- von Hand geändert
    elsif old.driver_auto and (new.vehicle_id is distinct from old.vehicle_id or new.incident_at is distinct from old.incident_at) then
      new.driver_id := null; new.driver_auto := false;   -- neu berechnen
    else
      new.driver_auto := old.driver_auto;
    end if;
  else
    new.driver_auto := false;
  end if;
  if new.driver_id is null and new.vehicle_id is not null and new.incident_at is not null then
    select array_agg(distinct t.driver_id) into v_ids from public.trips t
      where t.vehicle_id = new.vehicle_id and t.start_at <= new.incident_at and coalesce(t.end_at, now()) >= new.incident_at;
    if coalesce(array_length(v_ids, 1), 0) = 1 then
      new.driver_id := v_ids[1]; new.driver_auto := true;
    end if;
  end if;
  if new.driver_id is null then new.driver_auto := false; end if;
  if new.status in ('beantwortet','bezahlt','erledigt') then
    if new.done_at is null then new.done_at := now(); end if;
  else
    new.done_at := null;
  end if;
  return new;
end $$;
create trigger cases_before_write before insert or update on public.cases
  for each row execute function public.cases_before_write();

-- ---------- Dokumente (privater Speicher) ----------
insert into storage.buckets (id, name, public, file_size_limit)
  values ('dokumente', 'dokumente', false, 26214400)
  on conflict (id) do nothing;
create policy "chef liest dokumente" on storage.objects for select to authenticated
  using (bucket_id = 'dokumente' and (select public.is_admin()));
create policy "chef lädt dokumente hoch" on storage.objects for insert to authenticated
  with check (bucket_id = 'dokumente' and (select public.is_admin()));
create policy "chef ändert dokumente" on storage.objects for update to authenticated
  using (bucket_id = 'dokumente' and (select public.is_admin()));
create policy "chef löscht dokumente" on storage.objects for delete to authenticated
  using (bucket_id = 'dokumente' and (select public.is_admin()));

-- ---------- Rechte auf Funktionen ----------
revoke all on function public.driver_stamp(text, text, uuid, integer) from public;
grant execute on function public.driver_stamp(text, text, uuid, integer) to anon, authenticated;
revoke all on function public.claim_admin() from public, anon;
grant execute on function public.claim_admin() to authenticated;
revoke all on function public.set_driver_pin(uuid, text) from public, anon;
grant execute on function public.set_driver_pin(uuid, text) to authenticated;
revoke all on function public.drivers_with_pin() from public, anon;
grant execute on function public.drivers_with_pin() to authenticated;
revoke all on function public.who_drove(uuid, timestamptz) from public, anon;
grant execute on function public.who_drove(uuid, timestamptz) to authenticated;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.cases_before_write() from public, anon, authenticated;

-- Tabellenrechte (Zugriff regelt danach RLS)
grant select, insert, update, delete on public.drivers, public.vehicles, public.trips, public.cases, public.case_files to authenticated;
grant select, update on public.settings to authenticated;
grant select on public.admins to authenticated;
revoke all on public.driver_pins, public.pin_attempts from anon, authenticated;
