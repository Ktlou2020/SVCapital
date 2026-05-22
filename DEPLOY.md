# 🚀 Deploying SV Capital to Railway

## Overview

The platform runs as a single Railway service:
- **Backend**: Express.js (Node 20) serving the REST API
- **Database**: PostgreSQL (Railway plugin)
- **Frontend**: Static HTML/CSS/JS served by the same Express server

---

## Step 1 — Create a Railway Project

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project** → **Empty Project**
3. Name it `svcapital` (or any name)

---

## Step 2 — Add a PostgreSQL Database

1. Inside your project, click **+ Add Service** → **Database** → **PostgreSQL**
2. Railway will provision a Postgres database and set `DATABASE_URL` automatically
3. Wait for it to become **Available** (green dot)

---

## Step 3 — Deploy the Backend Service

### Option A — Deploy from GitHub (Recommended)

1. Click **+ Add Service** → **GitHub Repo**
2. Connect your GitHub account and select the `SVCapital` repository
3. Railway will detect the `railway.toml` and configure automatically
4. Click **Deploy**

### Option B — Deploy with Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Deploy
railway up
```

---

## Step 4 — Set Environment Variables

In your Railway service, go to **Variables** tab and add:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | *(auto-set by Postgres plugin)* | Don't change |
| `JWT_SECRET` | `your-long-random-secret` | Run: `openssl rand -base64 48` |
| `NODE_ENV` | `production` | Required |
| `PORT` | `3000` | Railway sets this automatically |
| `ALLOWED_ORIGINS` | *(leave empty or your domain)* | e.g. `https://svcapital.up.railway.app` |

> **Tip**: Railway auto-injects `DATABASE_URL` from the linked Postgres plugin.

---

## Step 5 — Run Database Migrations + Seed

After your first deploy, run the database setup:

### Via Railway CLI

```bash
# Run migrations (creates all tables)
railway run --service svcapital npm run migrate

# Run seed (inserts demo data + admin user)
railway run --service svcapital npm run seed
```

### Via Railway Dashboard

1. Go to your service → **Settings** → **Deploy** section
2. Temporarily change Start Command to: `cd server && node db/migrate.js && node db/seed.js && node index.js`
3. Redeploy → revert Start Command back to `cd server && node index.js`

---

## Step 6 — Get Your Public URL

1. In Railway, go to your service → **Settings** → **Networking**
2. Click **Generate Domain** to get a public URL like `https://svcapital.up.railway.app`
3. Your platform is live! 🎉

---

## Demo Credentials (after seeding)

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@svcapital.co.za` | `Admin@2024!` |
| Director | `director@svcapital.co.za` | `Admin@2024!` |
| Investor | `investor@svcapital.co.za` | `Demo@2024!` |
| Investor | `thabo@email.co.za` | `Demo@2024!` |
| IFA | `ifa@svcapital.co.za` | `ifa123` |

---

## Creating New Users

### Via Admin Console
1. Log in as `admin@svcapital.co.za`
2. Go to **Investor Management** → **Add Investor**
3. Fill in investor details and click **Save**
4. A matching user account is automatically created

### Via the API (programmatic)
```bash
# Create admin user
curl -X POST https://your-app.up.railway.app/api/users \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "new@svcapital.co.za",
    "password": "Secure@2024!",
    "role": "admin",
    "firstName": "New",
    "lastName": "Admin"
  }'
```

### Via Self-Registration
- Go to `/signup.html` — investors can self-register
- Admin must approve KYC before the investor can invest

### Available Roles
| Role | Portal | Description |
|------|--------|-------------|
| `investor` | `/portal/` | Self-service investment dashboard |
| `admin` | `/admin/` | Platform back-office |
| `director` | `/team/director.html` | Super admin + RBAC |
| `ifa` | `/ifa/` | IFA partner portal |
| `fund_manager` | `/fund/` | Fund operations console |
| `staff` | `/team/hub.html` | Internal team dashboard |

---

## API Reference

All API routes are prefixed with `/api/`:

### Auth
```
POST /api/auth/login          — Login (returns JWT)
POST /api/auth/register       — Register new investor
POST /api/auth/logout         — Logout
GET  /api/auth/me             — Current user info
PUT  /api/auth/change-password
POST /api/auth/forgot-password
```

### Users (Admin only)
```
GET    /api/users             — List all users
GET    /api/users/:id
POST   /api/users             — Create user
PUT    /api/users/:id         — Update user
PATCH  /api/users/:id/toggle-active
PATCH  /api/users/:id/reset-password
DELETE /api/users/:id
```

### Data Tables
```
GET    /api/tables/:table
GET    /api/tables/:table/:id
POST   /api/tables/:table
PUT    /api/tables/:table/:id
PATCH  /api/tables/:table/:id
DELETE /api/tables/:table/:id
```

Available tables: `investors`, `investment_pools`, `investments`, `transactions`,
`kyc_documents`, `maturity_instructions`, `support_tickets`, `platform_settings`,
`ifas`, `fund_runs`, `return_schedules`, `audit_events`, `investor_allocations`,
`fee_ledger`, `fund_notifications`, `cattle_costs`, `employees`

### Health Check
```
GET /api/health               — Returns DB connection status
```

---

## Troubleshooting

### Database connection fails
- Verify `DATABASE_URL` is set in Railway Variables
- Ensure Postgres plugin is linked to your service

### 401 Unauthorised on API calls
- JWT token expired — log in again
- `JWT_SECRET` mismatch between deploys — use a consistent secret

### Migrations failed
- Check Railway build logs
- Manually run: `railway run node server/db/migrate.js`

### Port issues
- Railway sets `PORT` automatically — don't hardcode it
- The server listens on `process.env.PORT || 3000`
