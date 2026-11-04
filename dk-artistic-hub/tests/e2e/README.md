# End-to-end test

`e2e_full.py` drives the real pages in Chrome against a real PostgreSQL that has `supabase/all_in_one.sql` loaded.
A small PostgREST/Auth emulator inside the script turns browser requests into real SQL (with the real roles and Row Level Security).

Needs: PostgreSQL 16, Python 3 with `playwright` and `psycopg2-binary`, Google Chrome, and `npm install leaflet@1.9.4` (served locally in place of the CDN).

1. Start Postgres, create a database `dktest`, then load `tests/stub_supabase.sql` (imitates Supabase roles and the `auth` schema). **Never run the stub on a real Supabase project.**
2. Load `supabase/all_in_one.sql` with the admin email set to `admin@dk.test`.
3. `insert into auth.users (email, email_confirmed_at) values ('admin@dk.test', now()), ('other@dk.test', now());`
4. Serve the site folder on port 8765 and edit the path constants at the top of the script (`SITE`, `LEAF`, `SHOTS`, the Postgres socket).
5. `python3 e2e_full.py` -> expect `65/65 passed`.
