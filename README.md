# SK Photography

## Deploy to Vercel

The app uses SQLite and local image files for local development. Vercel functions
are temporary, so production needs a hosted Neon Postgres database and a Vercel
Blob store.

1. Create a Neon Postgres project and copy its connection string.
2. Create a Vercel Blob store.
3. Deploy this folder with the Vercel CLI (`npx vercel login`, then `npx vercel`)
   or import its Git repository into Vercel. Set the project root to this folder
   and allow Vercel to detect the Express framework (or choose **Express** if
   prompted). Vercel detects the root `server.js` Express app; `vercel.json`
   includes `public/` in the function bundle for the homepage route.
4. Add these environment variables in **Vercel → Project → Settings →
   Environment Variables** for Production (and Preview if needed):
   - `DATABASE_URL`: Neon connection string
   - Connect a Vercel Blob store to the project for Production (and Preview if
     needed). Vercel Blob uses its managed OIDC credentials; alternatively,
     configure a `BLOB_READ_WRITE_TOKEN`.
   - `ADMIN_USERNAME`: `skphotography`
   - `ADMIN_PASSWORD`: a unique password of at least 12 characters
   - `ADMIN_PHONE`: admin mobile number in international format, for example
     `+918217626808`
   - `BOOKING_NOTIFICATION_PHONE`: photographer's number to notify for each
     booking, in international format (defaults to `ADMIN_PHONE`), for example
     `+918217626808`
   - `JWT_SECRET`: a random secret of at least 32 characters
   - SMS notifications and password reset: `TWILIO_ACCOUNT_SID`,
     `TWILIO_AUTH_TOKEN`, and
     either `TWILIO_PHONE_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`
5. Redeploy after adding or changing environment variables. Vercel runs the exported Express app as a function and serves the
   files in `public/` as static assets. Database tables and the first admin
   account are initialized automatically on the first API request.
6. Open the deployment URL and test a booking. Admin access is at
   `https://<your-deployment>/#studio-admin`.

Do not put production secrets in source control. `.env` and generated `.vercel/`
metadata are ignored by Git; commit `vercel.json`. `.env.example` contains
variable names and example values only.

## Migrate local data

Run this once from this project folder after putting the target Neon URL and
Blob credentials in your local ignored `.env` file. For OIDC credentials, use
`vercel env pull` from the linked project:

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
`DATABASE_URL`, it uses Neon. Photo uploads with Neon need a connected Vercel
Blob store (OIDC) or a `BLOB_READ_WRITE_TOKEN`.
