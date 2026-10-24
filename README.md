# SK Photography

## Deploy to Vercel

The app uses SQLite and local image files for local development. Vercel functions
are temporary, so production needs a hosted Neon Postgres database and a Vercel
Blob store.

1. Create a Neon Postgres project and copy its connection string.
2. Create a Vercel Blob store.
3. Deploy this folder with the Vercel CLI (`npx vercel login`, then `npx vercel`)
   or import its Git repository into Vercel. Set the project root to this folder.
4. Add these environment variables in the Vercel project settings for Production
   (and Preview if needed):
   - `DATABASE_URL`: Neon connection string
   - `BLOB_READ_WRITE_TOKEN`: Vercel Blob read/write token
   - `ADMIN_USERNAME`: `skphotography`
   - `ADMIN_PASSWORD`: a unique password of at least 12 characters
   - `ADMIN_PHONE`: admin mobile number in international format, for example
     `+918296880354`
   - `JWT_SECRET`: a random secret of at least 32 characters
   - Optional SMS password reset: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
     either `TWILIO_PHONE_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`
5. Deploy. Vercel serves the files in `public/` and the catch-all API function in
   `api/[...path].js`. Database tables and the first admin account are
   initialized automatically on the first API request.
6. Open the deployment URL and test a booking. Admin access is at
   `https://<your-deployment>/#studio-admin`.

Do not put production secrets in source control. `.env` and generated `.vercel/`
metadata are ignored by Git; commit `vercel.json`. `.env.example` contains
variable names and example values only.

## Migrate local data

Run this once from this project folder after putting the target Neon URL and
Blob token in your local ignored `.env` file:

```powershell
npm run migrate:vercel
```

The migration copies local SQLite admins, settings, bookings, and uploaded
portfolio photos to Neon and Blob. It is safe to re-run for the same records.
The current local SQLite database has no bookings or portfolio photo records.
To transfer photos stored only in a browser's local storage, run the updated app
on the same local origin with Neon and Blob configured, then sign in as admin
from the same browser and address where those photos were originally saved. The
sign-in flow transfers those browser photos and portrait to online storage.

## Local development

Copy `.env.example` to `.env`, set a local `ADMIN_PASSWORD` and `JWT_SECRET`,
then run:

```powershell
npm start
```

Without `DATABASE_URL`, the app uses local SQLite and `uploads/`. With
`DATABASE_URL`, it uses Neon. Photo uploads require `BLOB_READ_WRITE_TOKEN` when
using Neon.
