# Golf Charity Platform

React + Vite app for the PRD training project.

## What is included

- Supabase auth with a local demo fallback
- Fake but working subscription flow
- Five-score retention per user
- Charity selection with contribution percentage
- Monthly draw generation with score matching
- User dashboard
- Basic admin panel
- Supabase SQL schema and RLS policies

## Run locally

```bash
npm install
npm run dev
```

## Connect Supabase

1. Create a project in Supabase.
2. Paste [`supabase/schema.sql`](./supabase/schema.sql) into the SQL editor and run it.
3. Copy `.env.example` to `.env` and fill in:

```bash
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

4. Restart the Vite dev server.

If those values are not present, the app uses local demo auth so it still runs.

## Admin login in Supabase mode

The demo admin credentials only work in local fallback mode unless you create the admin user in Supabase Auth too.

To enable admin login with Supabase:

1. Open Supabase Dashboard > Authentication > Users.
2. Add a user with:
   - Email: `admin@golfcharity.org`
   - Password: `admin123`
3. After the user is created, open Table Editor > `profiles`.
4. Set that user's `role` to `admin`.

Why this is needed:

- `auth.users` stores login accounts.
- `public.profiles` stores app roles and subscription/charity data.
- The frontend can only sign in to accounts that already exist in `auth.users`.
