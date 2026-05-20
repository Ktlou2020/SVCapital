# SV Capital — Alternative Investment Platform

**SmartVest Financial Services (Pty) Ltd · FSP #52449 · FSCA Regulated**

> "Investments that make sense"

---

## Project Overview

A premium, conversion-focused alternative-investment platform for South Africa, built as a static website with a full RESTful data layer. The platform covers three portals:

| Portal | Path | Description |
|--------|------|-------------|
| Public Website | `/index.html` | Marketing / product showcase |
| Investor Portal | `/portal/index.html` | Self-service investor dashboard |
| Admin Console | `/admin/index.html` | Back-office management |
| **IFA Partner Portal** | **`/ifa/index.html`** | **IFA client management portal** |
| IFA Login | `/ifa/login.html` | Dedicated IFA sign-in page |
| **Fund Management Console** | **`/fund/index.html`** | **Fund operations, return calculator & analytics** |
| **Team Dashboard (EVA)** | **`/team/index.html`** | **Internal KPI tracking, EVA compensation & gamification** |
| Login | `/login.html` | Unified sign-in page (investor / admin) |
| **Staff Login** | **`/team/login.html`** | **Staff email + PIN login** |
| **Staff Hub** | **`/team/hub.html`** | **Role-based app launcher (post-login)** |
| **Director Panel** | **`/team/director.html`** | **Super Admin: create employees, manage onboarding, RBAC matrix** |

---

## Corporate Identity

The platform applies the **official SV Capital CI** throughout:

- **Logo**: Multi-color gradient petal SVG (`assets/logo-inline.svg`) — visible in all sidebar headers, login page, and printed statements
- **Primary**: Orange gradient `#FF9B0C → #FF5229`
- **Secondary**: Teal `#2F8C9B → #0096FF`
- **Accent**: Green `#22C55E`, Purple `#A855F7`
- **Background**: White/light `#F7F8FA / #FFFFFF`
- **Text**: Charcoal `#303030` / Muted `#6B7280`
- **Tagline**: "Investments that make sense"

CI tokens are declared in `css/brand.css` and applied/overridden via `css/ci-theme.css`.

---

## File Structure

```
index.html                    ← Public marketing page
login.html                    ← Unified login (CI-branded, light theme)
README.md

assets/
  logo-inline.svg             ← Official multi-color SVG logo mark
  svcapital-logo-header.png   ← Logo for OG/header use
  svcapital-og.png            ← OG image

css/
  style.css                   ← Public website styles
  admin.css                   ← Shared admin/portal layout (dark base)
  brand.css                   ← CI design tokens (colors, typography, spacing)
  ci-theme.css                ← CI override layer (light theme on top of admin.css)

js/
  main.js                     ← Public website JavaScript
  api.js                      ← RESTful API wrapper (all CRUD helpers + Utils + Toast + Modal)

portal/
  index.html                  ← Investor Portal SPA
  css/portal.css              ← Portal-specific styles + CI overrides
  js/portal.js                ← Portal logic (overview, investments, transactions,
                                  wallet, marketplace, maturity, support, referral,
                                  statement generator)

admin/
  index.html                  ← Admin Console SPA
  js/admin.js                 ← Admin logic (dashboard, investors, KYC, pools,
                                  investments, maturity, transactions, analytics,
                                  support tickets, settings)
```

---

## Features Implemented

### Public Website (`index.html`)
- [x] Dark-luxury hero with animated counter stats
- [x] Product cards: Cattle Finance, Solar (5/6/7yr), SMME Short-Term, Delivery Bikes
- [x] Interactive investment calculator (R500–R500k slider, 4 product tabs, live Chart.js bar)
- [x] Return comparison table (12–21% vs bank 5–7%)
- [x] Impact / SDG badges (700+ jobs, clean energy)
- [x] FSCA compliance badge
- [x] Product detail modals

### Login Page (`login.html`) ✨ CI-Branded
- [x] Split-panel layout: brand story left, form right
- [x] Real SV Capital SVG logo
- [x] Demo credentials notice (investor / admin / password)
- [x] Role selector (Investor Portal / Admin Console)
- [x] Password show/hide toggle
- [x] Quick access links (bypass login for demo)
- [x] Demo authentication logic → redirect to correct portal
- [x] FSCA compliance badge
- [x] Fully responsive (mobile hides left panel)

### Investor Portal (`portal/index.html`)
- [x] Sidebar with CI logo (SVG) + navigation
- [x] **Portfolio Overview** — KPI hero, trend chart, allocation doughnut, recent investments, recent transactions
- [x] **My Investments** — cards with progress bars, filter tabs, detail stats
- [x] **Transactions** — ledger table with filter by type, summary stats, pagination
- [x] **Wallet** — balance display, premium 3-step payment gateway modal, recent activity
- [x] **Browse Pools** — marketplace cards, category tabs, Invest Now modal with live preview
- [x] **Maturity Instructions** — submit payout/reinvest instruction
- [x] **My Profile** — personal info, risk profile, FICA status, security settings
- [x] **Support** — ticket submission form, ticket list, FAQ, Contact Us
- [x] **Refer & Earn** — referral code, link copy/share, stats, T&Cs
- [x] **My Statement** ✨ NEW — premium statement generator (see below)
- [x] CI theme: light/white background, orange/teal accent colors

### 📄 Statement Generator (`portal/index.html` → Statement view)
- [x] Date range picker (defaults to current year)
- [x] Configurable sections: Portfolio Summary, Investment Details, Transactions, Performance Analysis
- [x] Real-time preview with quick stats
- [x] Full premium HTML statement document with:
  - Dark hero header with SV Capital SVG logo
  - Orange CI accent band with period and investor identity
  - Portfolio KPI boxes (4 metrics, color-coded)
  - Dual-column account details + investment snapshot
  - Performance analysis table by product type
  - Full investment details table (8 columns)
  - Transaction ledger with summary mini-boxes
  - Footer with SmartVest / FSCA regulatory info
  - Auto-generated statement number
- [x] Print / Save as PDF button → opens dedicated print window with CI toolbar
- [x] FSCA compliance footnote

### Admin Console (`admin/index.html`)
- [x] CI logo in sidebar header
- [x] **Dashboard** — KPI cards (investors, AUM, returns, pools), AUM chart, recent investments, open pools, pending actions
- [x] **Investor Management** — table, search, add investor modal, detail modal with investments + transactions
- [x] **KYC / FICA** — document review, approve/reject, status counters
- [x] **Pool Management** — pool grid, create/edit/close/mark-paid-out
- [x] **Investments** — full ledger, search/filter, pagination, detail modal
- [x] **Maturity Instructions** — process pending instructions
- [x] **Transactions** — ledger with filters, record new transaction modal
- [x] **Support Tickets** — ticket list, filters, detail/response modal
- [x] **Analytics** — charts (product volume, province, risk profile, transaction flow)
- [x] **Settings** — platform settings, compliance info
- [x] CI light theme applied

---

## Database Tables

All data is stored via the RESTful Table API (`tables/`).

| Table | Records | Description |
|-------|---------|-------------|
| `investors` | 5 | Investor profiles (18 fields) |
| `ifas` | 5 | IFA profiles and assigned clients (13 fields) |
| `fund_runs` | 4 | Fund run records — capital deployed, returns, fees (24 fields) |
| `return_schedules` | 4 | Per-investor payout schedule entries (21 fields) |
| `audit_events` | 15 | Immutable FSCA compliance log (13 fields) |
| `investor_allocations` | 13 | Investor ↔ fund run capital allocation with live NAV share (18 fields) |
| `fee_ledger` | 12 | Management/performance/structuring/admin fee entries per run (14 fields) |
| `fund_notifications` | 8 | In-app alert feed — overdue, maturity, liquidity, compliance (13 fields) |
| `cattle_costs` | 11 | Per-cycle cattle expenditure — feed, vet, transport, labour, mortality (13 fields) |
| `investment_pools` | 10 | Product pools (16 fields) |
| `investments` | 10 | Individual investment records (16 fields) |
| `transactions` | 15 | Financial transaction ledger (11 fields) |
| `kyc_documents` | 4+ | KYC/FICA document submissions |
| `maturity_instructions` | 4+ | Payout / reinvestment instructions |
| `support_tickets` | 4+ | Customer support tickets |
| `platform_settings` | — | System configuration key-value pairs |

---

## API Endpoints Used

All API calls use **absolute paths** from the project root (not relative from subdirectory) via the `_API_BASE` constant in `js/api.js`.

```
GET    tables/{table}?page=1&limit=100&search=q&sort=field
GET    tables/{table}/{id}
POST   tables/{table}
PUT    tables/{table}/{id}
PATCH  tables/{table}/{id}
DELETE tables/{table}/{id}
```

Available via `API.*` helpers in `js/api.js`:
- `API.investors.*` — list, get, create, update, delete
- `API.pools.*` — list, get, create, update
- `API.investments.*` — list, get, create, update
- `API.transactions.*` — list, get, create, update
- `API.kyc.*` — list, get, create, update
- `API.tickets.*` — list, get, create, update
- `API.maturity.*` — list, get, create, update
- `API.settings.*` — list, get, update

---

## Investment Products

| Product | Term | Expected Return | Min Investment |
|---------|------|-----------------|----------------|
| Cattle Finance | 6 months | 13–16% p.a. | R5,000 |
| Solar (5-year) | 5 years | 6.41% p.a. | R10,000 |
| Solar (6-year) | 6 years | 15.53% p.a. | R10,000 |
| Solar (7-year) | 7 years | 21.40% p.a. | R10,000 |
| SMME Short-Term | 5 months | 13.92% p.a. | R1,000 |
| Delivery Bikes | 12 months | 14–18% p.a. | R2,500 |

---

## Demo Credentials

| Role | Email | Password |
|------|-------|----------|
| Investor | investor@svcapital.co.za | Demo@2024! |
| Admin | admin@svcapital.co.za | Demo@2024! |

> Any password works in demo mode — the login redirects based on role selection.

---

## 🤖 SV Intelligence — AI Data Assistant

SV Intelligence is a built-in, client-side AI assistant that reads all live platform data and provides smart, context-aware analysis. It runs entirely in the browser — no external API keys required.

### Where it appears
| Portal | Trigger | Icon |
|--------|---------|------|
| Investor Portal (`portal/index.html`) | Orange floating button (bottom-right) | 🤖 Robot |
| Admin Console (`admin/index.html`) | Orange floating button (bottom-right) | 🤖 Robot |

### Files
| File | Purpose |
|------|---------|
| `css/sv-intelligence.css` | Full panel, chat bubble, insight card, FAB styles |
| `js/sv-intelligence.js` | Data loading, answer engine, Markdown renderer |

### Investor Portal capabilities
- 📊 **Portfolio Summary** — total value, invested, returns, wallet
- 💰 **Returns Analysis** — effective rate, expected earnings, best pool
- 💳 **Wallet Status** — balance, topup guidance, pool affordability
- ⏰ **Maturing Investments** — days remaining per pool, instruction reminders
- 🏊 **Open Pools** — sorted by rate, wallet vs minimum check, recommendation
- 📈 **Transaction History** — deposits, investments, returns breakdown
- 🔒 **Portfolio Risk** — concentration analysis, diversification advice
- 💡 **Smart Tips** — personalised actionable advice from live data

### Admin Console capabilities
- 📊 **Platform Summary** — AUM, investors, pools, action items count
- 💰 **AUM & Returns** — total ever invested, paid out, expected future
- 👥 **Investor Stats** — active/pending/suspended, top 5 by investment
- 🏊 **Pool Health** — fill rates, near-full pools, highest-rate pool
- ⚠️ **Pending Actions** — KYC review, urgent tickets, pending deposits, maturity
- 🎫 **Support Tickets** — open/urgent/high counts, most recent tickets
- 📋 **KYC / FICA** — pending/approved/rejected counts, action required flag
- 📈 **Transactions** — ledger breakdown by type, pending deposit alert

---

## IFA Partner Portal (`/ifa/`)

A fully separate SPA portal for Independent Financial Advisers to log in and manage their clients independently from the Admin Console.

### Portal Structure
| File | Purpose |
|------|---------|
| `ifa/login.html` | IFA-specific login page with brand left-panel + credentials form |
| `ifa/index.html` | IFA dashboard SPA (5 views) |
| `ifa/css/ifa.css` | Full portal stylesheet — sidebar, tables, modals, badges |
| `ifa/js/ifa.js` | Complete portal logic — auth, data loaders, all view renderers |

### Authentication
- IFAs log in using their registered **email address** (matched against `ifas` table)
- Demo password: `ifa123`
- Session stored in `sessionStorage` (or `localStorage` if "Remember me" checked)
- Auto-redirect to `login.html` if no valid session
- Suspended/inactive accounts are blocked with a clear error message

### Views
| View | Description |
|------|-------------|
| **Dashboard** | KPI stats (clients, AUM, returns, commission), AUM-by-client doughnut chart, pending actions, recent clients widget, active investments widget |
| **My Clients** | Full searchable/filterable client table — FICA status, wallet, invested, active investment count — click to open full client detail modal |
| **Investments** | All investments across linked clients — filter by status, shows expected returns |
| **Transactions** | All financial activity across linked clients — filter by type |
| **Support Tickets** | All tickets raised by linked clients — filter by status, priority indicators |
| **My Profile** | IFA profile info, performance summary, account actions (change password, request client link, sign out) |

### Data Access
- All data is filtered server-side to **only show data belonging to linked clients** (`assigned_clients` array on the IFA record)
- Uses the shared `../js/api.js` for `Utils`, `Toast`, `Modal` and fetch helpers
- The `_API_BASE` resolver in `api.js` now handles `/ifa/` subdirectory correctly (returns `../`)

---

## IFA Management (Admin Console)

The Admin Console includes a full **Independent Financial Adviser (IFA)** management section, accessible via the **IFA Management** sidebar item under the *Investors* group.

### Features
| Feature | Description |
|---------|-------------|
| **IFA Dashboard Stats** | Total IFAs, Active IFAs, Total linked clients, IFA-managed AUM |
| **IFA Table** | Searchable/filterable table with name, company, FSP license, client count, AUM, commission rate, status |
| **IFA Detail Modal** | Full profile view: contact info, performance summary, admin notes, linked clients table with invest/wallet totals |
| **Add IFA** | Create new IFA with name, email, phone, FSP license, company, commission rate, status, notes |
| **Link Client** | Dropdown to link any unlinked investor to an IFA — auto-updates IFA AUM |
| **Unlink Client** | Remove a client from an IFA directly from the detail modal |
| **Activate / Deactivate** | Toggle IFA status active ↔ inactive |
| **Delete IFA** | Permanently remove an IFA from the platform |
| **Live Search & Filter** | Filter by status; search by name, company, license number, email |

### Data Model — `ifas` table
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `IFA-XXX` identifier |
| `first_name` / `last_name` | text | IFA name |
| `email` / `phone` | text | Contact details |
| `license_number` | text | FSP license (e.g. `FSP-48821`) |
| `company_name` | text | IFA practice/firm |
| `status` | text | `active` \| `inactive` \| `suspended` |
| `commission_rate` | number | Percentage rate (e.g. `1.5`) |
| `assigned_clients` | array | Array of investor IDs |
| `aum_managed` | number | Total AUM in ZAR |
| `date_joined` | datetime | Platform join date |
| `notes` | rich_text | Internal admin notes |

### Files Modified
- `admin/index.html` — IFA nav item, `view-ifa` section, IFA detail modal, Add IFA modal, Link Client modal
- `admin/js/admin.js` — `STATE.ifas`, `navigate()` titles & loaders, `loadIFAs()`, `renderIFAStats()`, `renderIFATable()`, `setupIFASearch()`, `viewIFA()`, `openAddIFAModal()`, `saveNewIFA()`, `openLinkClientModal()`, `confirmLinkClient()`, `unlinkClient()`, `toggleIFAStatus()`, `deleteIFA()`
- `tables/ifas` — RESTful table with 5 seeded demo IFAs

---

## Fund Management Tool (`/fund/`)

A standalone operations console for SV Capital fund managers to run daily investment operations, calculate returns, manage fund runs, and produce analytics reports. Staff Auth guard (`fund` app key) protects access.

### Portal Structure
| File | Purpose |
|------|---------|
| `fund/index.html` | Fund Management SPA (6 views) — dashboard now includes product quick-links |
| `fund/css/fund.css` | Full portal stylesheet — orange accent, KPI cards, run cards, calc panels |
| `fund/js/fund.js` | Complete fund logic — Calc engine, CRUD, all view renderers, chart loaders |
| `fund/cattle.html` | Cattle Investment SPA — NAV Dashboard, Cycles, Animals (full CRUD), Import, Settings |
| `fund/js/cattle.js` | Cattle NAV engine + cycle CRUD + **animal CRUD** (add/edit/delete per animal) + CSV import |
| `fund/css/cattle.css` | Cattle-specific styles |
| `fund/solar.html` | **NEW** Solar Investment SPA — Dashboard, Projects, NAV Calculator |
| `fund/js/solar.js` | **NEW** Solar NAV engine + full project CRUD |
| `fund/shortterm.html` | **NEW** Short-Term Loans SPA — Dashboard, All Loans, Overdue, NAV &amp; Returns |
| `fund/js/shortterm.js` | **NEW** Loan NAV engine + overdue detection + fund return calculator + CRUD |

### Views
| View | Description |
|------|-------------|
| **Dashboard** | KPI tiles (active runs, total capital, AUM, avg return), Chart.js AUM-by-product doughnut + gross vs net bar chart, recent runs, upcoming payouts widget |
| **Return Calculator** | Live parameter calculator — principal, rate, term, compounding, fee settings. Outputs: gross return, fees breakdown, net return, total payout, effective annual rate. Accrual schedule table + quick presets (Cattle, Solar 7yr, Short-Term). |
| **Fund Runs** | Searchable card-list of all runs. New/Edit/View/Delete modals. Status badges: draft → in_progress → completed → cancelled. KPI metrics per card. |
| **Payout Schedules** | Table of return_schedules entries. Filter by status. Mark individual or bulk entries as Paid. Shows investor, amount, expected date, days until payout. |
| **Pool Overview** | Cross-reference of investment_pools with linked fund runs. Capacity utilisation bars, status indicators, investor count. |
| **Reports & Analytics** | Chart.js: product performance bar chart, return distribution doughnut, payouts-by-month timeline. Summary KPI metrics. Export buttons. |

### Calc Engine (Pure JavaScript)
Located in `fund/js/fund.js` under the `Calc` object:

| Method | Formula | Description |
|--------|---------|-------------|
| `simpleReturn()` | `P × r × (days/365)` | Gross return; deducts management fee (prorated) + performance fee |
| `compoundReturn()` | `P × (1 + r/n)^(n×t)` | Compound with configurable compounding frequency |
| `effectiveAnnualRate()` | `(1 + r×days/365)^(365/days) − 1` | Convert nominal rate to EAR |
| `allocateRunReturns()` | Pro-rata share | Distribute fund run returns across multiple investors by investment size |
| `daysBetween()` | `(endDate − startDate) / 86400000` | Utility: exact day count between two dates |

**Quick Presets (Calculator view):**
| Preset | Rate | Term | Notes |
|--------|------|------|-------|
| Cattle Finance | 14.83% p.a. | 183 days | 6-month cattle cycle |
| Solar 7-Year | 13.5% p.a. | 2,555 days | Long-term solar return |
| Short-Term SMME | 12.0% p.a. | 90 days | 3-month SMME loan |

### Data Models

#### `fund_runs` table (24 fields)
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `FR-XXXX` identifier |
| `run_name` | text | Descriptive name (e.g. "Cattle Run Q1 2025") |
| `product_type` | text | `cattle` \| `solar` \| `smme` \| `delivery_bikes` \| `other` |
| `status` | text | `draft` \| `in_progress` \| `completed` \| `cancelled` |
| `principal_amount` | number | Total capital deployed (ZAR) |
| `annual_rate` | number | Annual interest rate (decimal, e.g. `0.1483`) |
| `term_days` | number | Run duration in days |
| `start_date` / `end_date` | datetime | Run period |
| `gross_return` | number | Calculated gross return (ZAR) |
| `management_fee` / `performance_fee` / `total_fees` | number | Fee breakdown (ZAR) |
| `net_return` | number | Investor net return after fees |
| `total_payout` | number | Principal + net return |
| `mgmt_fee_pct` / `perf_fee_pct` | number | Fee rates (decimal) |
| `compounding` | text | `simple` \| `monthly` \| `quarterly` \| `annually` |
| `investor_ids` | array | Linked investor IDs |
| `pool_id` | text | Linked investment pool ID |
| `notes` | rich_text | Manager notes |
| `created_by` | text | Admin user who created the run |

#### `return_schedules` table (21 fields)
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `RS-XXXX` identifier |
| `run_id` | text | Links to `fund_runs.id` |
| `investor_id` | text | Links to `investors.id` |
| `investor_name` | text | Denormalised display name |
| `principal_amount` | number | Investor's principal (ZAR) |
| `expected_return` | number | Calculated net return (ZAR) |
| `total_payout` | number | Principal + expected return |
| `payout_date` | datetime | Scheduled payout date |
| `status` | text | `scheduled` \| `processing` \| `paid` \| `cancelled` |
| `payment_method` | text | `bank_transfer` \| `wallet_credit` \| `reinvest` |
| `payment_reference` | text | Bank/payment reference |
| `notes` | rich_text | Payment notes |

---

## Cattle Finance Module (`/fund/cattle.html`) v2

### Animal CRUD (new in v6)
Individual animals in every cycle now support full add / edit / delete:
- **Add Animal** button in the Animals filter bar opens a modal form
- **Edit** (pencil icon) per row — pre-populates all fields
- **Delete** (trash icon) per row — confirm dialog before removal
- Modal fields: Tag Number, Batch No., Batch Name, Cycle (dropdown), Breed, Gender, Entry Mass, Exit Mass, Status (active/sold/mortality), Sale Batch, Sale Date, Mortality Date, Mortality Report, Notes
- Mortality-specific fields auto-show/hide based on Status selection

---

## Solar Finance Module (`/fund/solar.html`) ← NEW

A dedicated investment management module for solar projects.

### Views
| View | Description |
|------|-------------|
| **Dashboard** | Portfolio NAV hero, 4 KPI cards, Capital by Project bar chart, Product Term doughnut, NAV snapshot table |
| **All Projects** | Searchable/filterable project cards with term progress bars, NAV per project, edit/delete actions |
| **NAV Calculator** | Portfolio NAV panel, formula documentation, per-project NAV breakdown table |

### NAV Engine
| Formula | Description |
|---------|-------------|
| `AccruedReturn = Capital × AnnualRate × (DaysElapsed / 365)` | Daily accrual from deployment date |
| `ProjectNAV = Capital + AccruedReturn` | Current estimated value |
| `PortfolioNAV = Σ ProjectNAV (active projects)` | Sum across all active projects |

### Data Model — `solar_projects` table
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `SOL-XXX` identifier |
| `project_name` | text | Display name |
| `location` | text | City, Province |
| `capacity_kw` | number | kW installed |
| `product_type` | text | `5yr` \| `6yr` \| `7yr` |
| `status` | text | `active` \| `matured` \| `pending` \| `cancelled` |
| `capital_deployed` | number | ZAR invested |
| `annual_rate` | number | Decimal rate (e.g. `0.1483`) |
| `term_years` | number | Investment term in years |
| `start_date` | datetime | Deployment date |
| `maturity_date` | datetime | Contracted maturity |
| `contracted_return` | number | Total contracted return (ZAR) |
| `actual_return` | number | Actual return received (ZAR) |
| `investor_count` | number | Number of investors |
| `notes` | rich_text | PPA/off-taker details |

### Demo Projects Seeded
| ID | Project | Type | Capital | Rate |
|----|---------|------|---------|------|
| SOL-001 | Limpopo Solar Farm — Phase 1 | 7yr | R4.5M | 14.83% |
| SOL-002 | Ekurhuleni Commercial Rooftop | 5yr | R1.2M | 13.5% |
| SOL-003 | Cape Winelands Solar Co-op | 6yr | R950k | 14.2% |
| SOL-004 | Durban Industrial Park — Block B | 5yr | R2.1M | 13.5% (matured) |

---

## Short-Term Loans Module (`/fund/shortterm.html`) ← NEW

A dedicated module for tracking business loan disbursements with agreed repayment dates and interest.

### Views
| View | Description |
|------|-------------|
| **Dashboard** | Portfolio NAV hero, 5 KPI cards, Monthly Disbursements bar chart, Status Breakdown doughnut, recent loans table |
| **All Loans** | Full searchable/filterable table with NAV per loan, overdue highlighting, edit/delete actions |
| **Overdue** | Dedicated overdue loan cards with days-late counter, outstanding balance, contact details |
| **NAV & Returns** | Fund Return panel, formula documentation, per-loan NAV breakdown table sorted by return % |

### NAV Engine
| Formula | Description |
|---------|-------------|
| `AccruedInterest = Principal × Rate × (DaysElapsed / 365)` | For rate-based loans |
| `LoanNAV = max(0, TotalRepayable − PartialRepayments)` | Outstanding balance |
| `PortfolioNAV = Σ LoanNAV (active + partial loans)` | Sum of all outstanding balances |
| `FundReturn = (TotalRepaid − TotalDisbursedOnRepaid) / TotalDisbursedOnRepaid × 100` | Realised return on completed loans |

### Overdue Detection
- On every page load, loans with `status: active` past their `repayment_date` are automatically flagged
- Overdue badge counter on sidebar nav item
- Overdue rows highlighted in red across all table views
- Dedicated Overdue view shows days-late per loan with contact details

### Data Model — `shortterm_loans` table
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `STL-XXX` identifier |
| `loan_ref` | text | Human-readable reference |
| `business_name` | text | Borrowing entity name |
| `business_reg` | text | CIPC registration number |
| `contact_name` / `contact_phone` | text | Primary contact |
| `amount_disbursed` | number | Principal (ZAR) |
| `interest_rate` | number | Annual rate as decimal |
| `interest_amount` | number | Fixed interest amount if agreed |
| `total_repayable` | number | Principal + interest |
| `disbursement_date` | datetime | Date funds were sent |
| `repayment_date` | datetime | Agreed due date |
| `actual_repayment_date` | datetime | Date payment received |
| `status` | text | `active` \| `repaid` \| `overdue` \| `partial` \| `written_off` |
| `partial_repayments` | number | Amount received to date |
| `notes` | rich_text | Collateral, security notes |

### Demo Loans Seeded
| ID | Business | Amount | Rate | Status |
|----|---------|--------|------|--------|
| STL-001 | Ndlovu Trading & Supplies | R500k | 18% | Repaid |
| STL-002 | Khumalo Construction (Pty) Ltd | R1.2M | 20% | Active |
| STL-003 | Protea Agri Distributors | R750k | 16% | Active |
| STL-004 | Sunrise Catering Solutions | R300k | 22% | Overdue (partial) |
| STL-005 | Mthembu Logistics CC | R800k | 18% | Active |

---

### Access from Admin Console
The **Fund Ops** button appears in the Admin Console topbar:
```html
<a href="../fund/index.html" class="btn btn--secondary btn--sm" title="Fund Management Console">
  <i class="fa-solid fa-chart-bar"></i> Fund Ops
</a>
```

### Supporting Documents — `loan_documents` table
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `LDOC-{timestamp}-{rand}` |
| `loan_id` | text | FK → `shortterm_loans.id` |
| `doc_type` | text | `loan_agreement` \| `id_document` \| `bank_statement` \| `business_registration` \| `collateral_deed` \| `invoice` \| `bank_confirmation` \| `board_resolution` \| `financial_statements` \| `other` |
| `doc_name` | text | Original filename |
| `doc_url` | rich_text | Base64 data URI (PDF/JPG/PNG/WEBP) |
| `file_size` | number | Bytes |
| `mime_type` | text | MIME type string |
| `notes` | text | Optional annotation |
| `uploaded_by` | text | User identifier |
| `uploaded_at` | datetime | Upload timestamp |

### Supporting Documents — `solar_documents` table
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `SDOC-{timestamp}-{rand}` |
| `project_id` | text | FK → `solar_projects.id` |
| `doc_type` | text | `ppa_agreement` \| `installation_certificate` \| `municipal_approval` \| `investor_agreement` \| `compliance_certificate` \| `engineering_report` \| `insurance_policy` \| `grid_connection` \| `financial_model` \| `other` |
| `doc_name` | text | Original filename |
| `doc_url` | rich_text | Base64 data URI |
| `file_size` | number | Bytes |
| `mime_type` | text | MIME type |
| `notes` | text | Optional annotation |
| `uploaded_by` | text | User identifier |
| `uploaded_at` | datetime | Upload timestamp |

### Fund Intelligence View (`fund/index.html` → Intelligence tab)
| Section | Description |
|---------|-------------|
| KPI Row | Available to Deploy, Liquidity Coverage Ratio, 90-day Obligations, Deployment Rate |
| Capital Balance Breakdown | Total Raised, Total Deployed (breakdown by product), Obligations Reserve, Available Balance + utilisation bar |
| Next Pool Maturity | Countdown panel for the next pool to mature + all pools maturing in 90 days |
| Upcoming Obligations Table | Payout schedules due in 90 days with urgency colour-coding |
| AI Deployment Recommendations | Ranked product suggestions: Solar, Short-Term Loans, Cattle — scored 0–100 with reasoning, estimated return, action items |

### AI Advisor Engine — `AIAdvisor` object in `fund/js/fund.js`
| Method | Description |
|--------|-------------|
| `buildContext({pools, schedules, runs, investments, solar, loans, cattle})` | Aggregates all data; computes availableBalance = totalRaised − totalDeployed − (obligations × 1.1) |
| `scoreOpportunity(type, ctx)` | Returns 0–100 score for `solar` / `loans` / `cattle` based on rate, concentration, overdue risk |
| `generateSuggestions(ctx)` | Returns sorted array of suggestion objects with icon, color, amount, returnEstimate, reasoning, actions |

---

## P2 Features — Fee Ledger, Risk Dashboard, Notifications, Cattle Costs

### Fee Ledger & Revenue Tracking (`fees` view — `fund/index.html`)

Tracks management, performance, structuring, admin, and early-exit fees across all fund products.

| Section | Description |
|---------|-------------|
| **4 KPI Cards** | Total Fee Revenue Earned · Fees Received (Cash) · Fees Accrued (Pending) · Fee Margin % |
| **Revenue by Fee Type** | Chart.js doughnut: management / performance / structuring / admin / early_exit |
| **Revenue by Product** | Chart.js doughnut: Solar / Short-Term Loans / Cattle |
| **Monthly Timeline** | Chart.js stacked bar: received vs accrued per month, last 12 months |
| **Fee Ledger Table** | Sortable table: date, run, product, fee type, capital base, rate, fee amount, status, invoice ref |
| **Filters** | Filter by fee type and status (received / accrued / invoiced / waived) |
| **CSV Export** | `exportFeeLedger()` — downloads full ledger as `.csv` |

#### `fee_ledger` table (14 fields)
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `FEE-{timestamp}` |
| `run_id` / `run_name` | text | Linked fund run |
| `product_type` | text | `solar` \| `loans` \| `cattle` \| `other` |
| `fee_type` | text | `management` \| `performance` \| `structuring` \| `admin` \| `early_exit` |
| `capital_base` | number | Capital amount the fee is applied to |
| `fee_rate` | number | Decimal rate (e.g. `0.02`) |
| `term_days` | number | Duration used in prorated calculation |
| `fee_amount` | number | ZAR fee value |
| `fee_date` | datetime | Date fee was earned/invoiced |
| `status` | text | `received` \| `accrued` \| `invoiced` \| `waived` |
| `invoice_ref` | text | Invoice reference number |
| `received_date` | datetime | Date payment was received |

---

### Risk Dashboard (`risk` view — `fund/index.html`)

Portfolio-level risk monitoring with HHI concentration scoring, vintage analysis, and product-level stress panels.

| Section | Description |
|---------|-------------|
| **4 KPI Cards** | Loan Default Rate · Overdue Exposure (ZAR) · Top Product Concentration % · Portfolio HHI Score |
| **Concentration Donut** | Chart.js doughnut: Solar / Short-Term Loans / Cattle by AUM |
| **Vintage Analysis** | Chart.js horizontal bar: capital deployed by year; current year highlighted gold |
| **Concentration Table** | 6-column table: product, capital, share%, HHI component, risk bar + label (green/amber/red), alert icon |
| **Loan Stress Panel** | Active/Overdue/Defaulted/Paid counters + loan-by-loan table with days-to-maturity |
| **Solar Risk Panel** | Project count counters + solar table with maturity countdown and rate range |
| **`riskAlertBadge`** | Sidebar badge auto-shows when HHI ≥ 2500 (concentrated) or default rate ≥ 10% |

**HHI Scoring:**
| Score | Status | Colour |
|-------|--------|--------|
| < 1,500 | Diversified | Green |
| 1,500 – 2,500 | Moderate concentration | Amber |
| > 2,500 | Concentrated — alert | Red |

---

### Notification Centre (`notifications` view — `fund/index.html`)

In-app alert feed for operational events: overdue loans, maturing pools, liquidity warnings, compliance flags.

| Feature | Description |
|---------|-------------|
| **Alert cards** | Colour-coded by severity (critical=red / warning=amber / info=blue); unread dot; entity linkback; timestamp |
| **Mark-read on click** | PATCH `is_read:true`; visual dot removed without full re-render |
| **Mark All Read** | Parallel PATCH all unread → re-render + toast |
| **Dismiss** | PATCH `is_dismissed:true`; card fades out |
| **Filters** | Category (overdue / maturity / liquidity / compliance / performance / system) + Severity |
| **Badge counts** | `unreadNotifBadge` (sidebar) · `topbarNotifCount` (bell button) · `riskAlertBadge` (Risk nav) — all updated on DOMContentLoaded and after every read/dismiss action |

#### `fund_notifications` table (13 fields)
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `NOTIF-{timestamp}` |
| `category` | text | `overdue` \| `maturity` \| `liquidity` \| `compliance` \| `performance` \| `system` |
| `severity` | text | `info` \| `warning` \| `critical` |
| `title` | text | Short notification title |
| `message` | text | Full message body |
| `entity_type` / `entity_id` / `entity_name` | text | Linked record identity |
| `action_url` | text | Navigate-to view key |
| `is_read` | bool | Read/unread state |
| `is_dismissed` | bool | Permanently hidden |
| `auto_generated` | bool | System-generated vs manual |
| `notified_at` | datetime | Timestamp (ms) |

---

### Cattle Cost Ledger (`costs` view — `fund/cattle.html`)

Per-cycle cost tracking for all cattle expenditure: feed, vet, transport, labour, mortality, and other costs.

| Section | Description |
|---------|-------------|
| **4 KPI Cards** | Total Costs · Feed Costs · Vet/Medical · Mortality/Loss |
| **Cost by Type Chart** | Chart.js doughnut: per-type colour coding (feed=amber, vet=blue, transport=purple, labour=green, mortality=red) |
| **Cost per Cycle Chart** | Chart.js horizontal bar: total spend per batch (top 10 cycles) |
| **Cost Ledger Table** | Date, cycle, type, description, per-animal, animal count, total, supplier, invoice, status, edit/delete |
| **Net Return Impact** | Per-cycle table: sale value − purchase cost = gross return; gross − total costs = **net return**; margin % |
| **Add / Edit Modal** | Dynamically built via `_ensureCostModal()` — cycle dropdown, type select, all cost fields |
| **CSV Export** | `exportCostLedger()` — downloads as `.csv` |

#### `cattle_costs` table (13 fields)
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `CCOST-{timestamp}` |
| `cycle_id` / `cycle_name` | text | Linked cattle cycle |
| `cost_type` | text | `feed` \| `vet` \| `transport` \| `labour` \| `mortality` \| `other` |
| `description` | text | Narrative description |
| `amount` | number | Total ZAR cost |
| `per_animal` | number | Per-head cost (ZAR) |
| `animals_count` | number | Herd size for this entry |
| `cost_date` | datetime | Date of expenditure |
| `supplier` | text | Supplier or vendor name |
| `invoice_ref` | text | Invoice reference |
| `status` | text | `pending` \| `paid` \| `approved` |

---

### Audit Trail — `audit_events` table
| Field | Type | Description |
|-------|------|-------------|
| `id` | text | `AUD-{timestamp}` |
| `event_type` | text | `fund_run` \| `solar_project` \| `loan` \| `cattle` \| `pool` \| `schedule` \| `auth` \| `system` |
| `action` | text | `create` \| `update` \| `delete` \| `status_change` \| `approve` \| `export` \| `mark_paid` \| `calculate_returns` |
| `entity_id` / `entity_name` | text | Affected record |
| `actor` / `actor_role` | text | Who performed the action |
| `before_state` / `after_state` | rich_text | JSON snapshots for diff view |
| `change_summary` | text | Human-readable description |
| `ip_address` | text | Client IP |
| `severity` | text | `info` \| `warning` \| `critical` |
| `event_at` | datetime | Timestamp |

**Audit is wired into:** fund run create, fund run edit/status-change, return calculation, payout mark-paid, allocation mature, audit log CSV export

### Investor Allocations — `investor_allocations` table
| Key Field | Description |
|-----------|-------------|
| `investor_id` / `investor_name` / `investor_email` | Investor identity |
| `product_type` | Product line allocation belongs to |
| `entity_id` / `entity_name` | Fund run / project / loan linked to |
| `capital_committed` / `capital_paid` | Committed vs received |
| `allocation_pct` | Investor's % share of that deployment |
| `annual_rate` / `term_days` / `start_date` / `maturity_date` | Terms |
| `expected_payout` / `actual_payout` | Projected vs realised |
| `status` | `committed` \| `active` \| `matured` \| `defaulted` \| `cancelled` |

### Cash Flow Forecast Engine (`loadForecast()` + `buildForecast()` in `fund/js/fund.js`)
Reads: `return_schedules`, `investor_allocations`, `shortterm_loans`, `solar_projects`, `cattle_cycles`, `fund_runs`, `investment_pools`

Produces 12 monthly buckets with:
- **Inflows**: loan repayments, solar maturities, cattle exits, fund run completions
- **Outflows**: payout schedules, maturing investor allocations
- **Net + Cumulative Net** per month
- **Chart.js** grouped bar (in/out) + line (net) overlay
- **Event timeline** sorted by date with product-colour coding

### Fund Console — Full Navigation Map
| View | Nav Key | Loader | Description |
|------|---------|--------|-------------|
| Dashboard | `dashboard` | `loadDashboard()` | KPIs, charts, product links |
| Return Calculator | `calculator` | `initCalculator()` | Simple/compound return math |
| Fund Runs | `runs` | `loadRuns()` | Full CRUD, status workflow |
| Payout Schedules | `schedules` | `loadSchedules()` | Mark paid, filter |
| Pool Overview | `pools` | `loadPools()` | Investment pool reference |
| Reports & Analytics | `reports` | `loadReports()` | Rate comparison, charts |
| Fund Intelligence | `intelligence` | `loadIntelligence()` | AI advisor, balance, suggestions |
| Cash Flow Forecast | `forecast` | `loadForecast()` | 12M inflow/outflow chart + timeline |
| Investor Allocations | `allocations` | `loadAllocations()` | Per-investor capital, NAV, maturity |
| Audit Trail | `audit` | `loadAuditTrail()` | Immutable log, CSV export, diff modal |
| **Fee Ledger** | **`fees`** | **`loadFees()`** | **Revenue tracking, 3 charts, CSV export** |
| **Risk Dashboard** | **`risk`** | **`loadRiskDashboard()`** | **HHI, concentration, loan stress, solar risk** |
| **Notification Centre** | **`notifications`** | **`loadNotifications()`** | **Alert feed, mark-read, dismiss, badge counts** |

### API Layer
`fund.js` uses its own `apiFetch` / `apiGet` / `apiPost` / `apiPatch` / `apiDelete` helpers with `BASE = '../'` constant (no dependency on `api.js`). The `_API_BASE` resolver in `api.js` also handles `/fund/` subdirectory correctly (returns `../`) for any future shared-library integration.

---

## P3 Features — Print Documents, Forgot Password, PWA

### P3.1 — KYC Document Upload (`admin/index.html` + `admin/js/admin.js`)

Allows admin users to attach supporting identity documents to any investor KYC record.

| Component | Description |
|-----------|-------------|
| **Upload button** | Per-row upload button in the KYC table (8th column) + top-level "Upload Document" button |
| **Modal** | `#kycUploadModal` — investor select (populated from `STATE.investors`), document type, status, drag-drop zone |
| **FileReader** | `_kycPreviewFile(file)` — reads file as base64 data URL; 10 MB size guard; displays file name + size preview |
| **Save** | `saveKycUpload()` — POSTs to `tables/kyc_documents` with `file_data` (base64), `file_size`, `mime_type` fields |
| **Schema update** | `kyc_documents` extended from 10 → 13 fields: `file_data` (rich_text), `file_size` (number), `mime_type` (text) |

### P3.2 — Investor Return Statement (`fund/js/fund.js` → `printInvestorStatement()`)

Print-window generator triggered from the allocation detail modal (gold "Investor Statement" button).

| Section | Content |
|---------|---------|
| **Header** | SV Capital letterhead, FSP #52449, document reference `SVC-INV-{id}`, issue date |
| **Investor Details** | Name, email, investor ID, account status |
| **Investment Details** | Product, deployment name, start/maturity dates, term, annual rate, allocation %, days elapsed |
| **Live NAV Snapshot** | 3 pills: Capital Invested (gold) · Accrued Return to Today (green) · Current NAV (blue) |
| **Return Summary** | Table with SARS-style rows: capital, gross return, expected total payout at maturity |
| **Disclaimer** | FSCA regulatory notice, FSP #52449, contact details |
| **Print bar** | "Print / Save PDF" + "Close" buttons (hidden on print) |

### P3.3 — IT3(b) Tax Certificate (`fund/js/fund.js` → `printTaxCertificate()`)

Formal SARS IT3(b)-format certificate triggered from the allocation detail modal (blue "IT3(b) Tax Cert" button).

| Section | Content |
|---------|---------|
| **Banner** | Dark navy header with certificate title, subtitle, Tax Administration Act reference |
| **Tax Year Badge** | Computed from maturity date: `YYYY/(YYYY+1)` South African tax year |
| **Paying Institution** | SmartVest FSP details, registration number, tax reference, address |
| **Recipient** | Investor name, email, reference, product, investment period |
| **Income Schedule** | SARS code 4201 (local interest — gross return), 4238 (WHT — NIL), 4210 (return of capital) |
| **SARS Note** | Section 10(1)(i) interest exemption reminder (R23,800 / R34,500 thresholds) |
| **Signature block** | Authorised signatory line (Alexandra van der Berg) + official stamp area |
| **Certificate number** | `IT3B-SVC-{taxYear}-{allocId-last8}` |

### P3.4 — Forgot Password / PIN Flow

#### `login.html` (Investor / Admin)
- "Forgot password?" link replaced with `onclick="showForgotPassword(event)"`
- New `#forgotPanel` div: back button, email input, error state, submit button
- `submitForgotPassword()`: validates email → 1.2s loading spinner → success panel with "Check your inbox" message and `<strong>` email echo
- `showLoginForm()` / `showForgotPassword()` toggle visibility cleanly; no page reload

#### `team/login.html` (Staff Portal)
- "Forgot your PIN?" link below the email input on step 1
- New `#forgotPinPanel` div: back button, email input, same flow pattern
- `showForgotPin()` hides all steps + step indicator; `closeForgotPin()` restores them
- Consistent with dark-theme design system (uses existing `.alert`, `.btn-primary`, `.spinner` classes)

### P3.5 — PWA Manifest + Service Worker

| File | Description |
|------|-------------|
| `manifest.json` | App name "SV Capital Fund Portal", `start_url: /fund/index.html`, `theme_color: #D4AF37`, 2 icon entries (192px + 512px), 2 shortcuts (Dashboard + Cattle) |
| `fund/sw.js` | Install: pre-caches 7 static shell files; Activate: deletes old caches; Fetch: network-first strategy, API calls (`/tables/`) always pass-through, cache fallback for offline; message handler for `SKIP_WAITING` + `CLEAR_CACHE` |
| `fund/index.html` | Added `<link rel="manifest">`, `theme-color` meta, `apple-mobile-web-app-*` meta tags, `apple-touch-icon`; SW registration script at page bottom with 60-second update polling |

---

## Pending / Recommended Next Steps

- [x] **Staff login + RBAC hub** — `team/login.html`, `team/hub.html`, `js/staff-auth.js`
- [x] **Director Super Admin** — `team/director.html` + `team/js/director.js` + `team/css/director.css`
- [x] **Onboarding journey** — auto-enrolment, 3 seeded courses, 10-task checklist, welcome banner
- [x] **Onboarding task persistence** — `syncOnboardingProgress()` evaluates real data, PATCHes `employee_onboarding` on every trigger
- [x] **Onboarding completion ceremony** — 100% → PATCH `status: completed`, +150 XP, confetti, success banner, auto-dismiss
- [x] **Director completion notification** — activity feed entry POSTed to creating director on employee's onboarding completion
- [x] **Platform Help System** — `HELP_CONTENT` for all 16 employee views + `DIR_HELP` for all 6 director views
- [x] **Director Help Panel** — floating gold button, sliding panel, auto-updates on `navTo()`
- [x] **IFA portal guard** — `StaffAuth.guard('ifa')` + `injectWidget()` added to `ifa/index.html`
- [x] **Cattle animal CRUD** — Add/Edit/Delete individual animals in `fund/cattle.html` + `fund/js/cattle.js`
- [x] **Solar Finance module** — `fund/solar.html` + `fund/js/solar.js` — NAV engine, full CRUD, Chart.js charts
- [x] **Short-Term Loans module** — `fund/shortterm.html` + `fund/js/shortterm.js` — NAV, overdue tracking, fund return calculator
- [x] **Fund Console product links** — Solar + Short-Term added to `fund/index.html` sidebar + dashboard product row
- [x] **Loan Supporting Documents** — Upload, view, download, delete for each short-term loan (`loan_documents` table, base64 storage, drag-drop FileReader API, sliding drawer panel)
- [x] **Solar Supporting Documents** — Same document capability for solar projects (`solar_documents` table, gold-themed drawer, `openSolarDocs()` / `closeSolarDocs()` / `uploadSolarDocData()`)
- [x] **Fund Intelligence Dashboard** — `fund/index.html` new view showing: available balance (raised − deployed − 90d obligations), deployment utilisation bar, next pool maturity countdown, 90-day obligations table
- [x] **AI Deployment Engine** — `AIAdvisor` object in `fund/js/fund.js` reads live data from all 6 tables, scores Solar / Loans / Cattle opportunities (0–100), generates ranked contextual recommendations with liquidity alerts
- [x] **P1 — Audit Trail** — Immutable `audit_events` table (13 fields), compliance log view with severity filters, CSV export, before/after state diff modal; `auditLog()` helper wired into: fund run create/edit/status-change, return calculation, payout mark-paid, allocation mature, audit export
- [x] **P1 — Investor ↔ Fund Allocations** — `investor_allocations` table (18 fields), 13 demo records across 8 investors; Allocations view with per-investor breakdown cards, live NAV share calc, maturity countdown, quick-add, mature action
- [x] **P1 — 12-Month Cash Flow Forecast** — Forecast engine reads all 7 product tables, builds monthly inflow/outflow buckets; Chart.js bar + line chart; monthly breakdown table with cumulative net; event timeline with colour-coded entries by product and direction
- [x] **P2 — Fee Ledger & Revenue Tracking** — `fee_ledger` table (12 seeded entries); `fees` view in Fund Console with 4 KPI cards, 3 Chart.js charts (type donut, product donut, monthly stacked bar), ledger table with type/status filters, CSV export; `applyFeeFilters()` wired to selects
- [x] **P2 — Risk Dashboard** — `risk` view with HHI concentration engine (Σshare²), concentration donut + vintage bar charts, 6-column concentration table with HHI component + alert icons, loan stress panel (default rate, overdue exposure, per-loan table), solar risk panel (maturity countdown, rate range); `riskAlertBadge` auto-shown on critical thresholds
- [x] **P2 — Notification Centre** — `fund_notifications` table (8 seeded alerts); `notifications` view with severity-coloured cards, mark-read-on-click, mark-all-read, dismiss with fade-out, category+severity filters; `updateNotifBadges()` fires on `DOMContentLoaded` and after every action; topbar bell badge + sidebar badge + risk badge all synced
- [x] **P2 — Cattle Cost Ledger** — `cattle_costs` table (11 seeded entries); `costs` view added to `fund/cattle.html` sidebar (Finance section) and `fund/js/cattle.js` navigate(); 4 KPI cards, cost-by-type donut + cost-per-cycle horizontal bar; full cost ledger table with cycle/type filters; Net Return Impact panel; add/edit/delete modal via `_ensureCostModal()`; CSV export
- [x] **P3 — KYC Document Upload** — File picker + drag-drop zone in Admin Console; `openKycUploadModal()`, `_kycPreviewFile()`, `saveKycUpload()`; base64 FileReader → `kyc_documents.file_data` (rich_text); max 10 MB guard; MIME type + file size stored; 8-col KYC table with per-row upload button; `#kycUploadModal` HTML added to `admin/index.html`
- [x] **P3 — Investor Return Statement** — `printInvestorStatement(allocId)` in `fund/js/fund.js`; opens print-window with A4 HTML; live NAV snapshot (capital + accrued return + current NAV pills), return summary table, FSCA notice, signature block; triggered from allocation detail modal; "Print / Save PDF" + Close buttons
- [x] **P3 — IT3(b) Tax Certificate** — `printTaxCertificate(allocId)` in `fund/js/fund.js`; SARS-format IT3(b) print window; SARS codes 4201 (local interest), 4238 (WHT — NIL), 4210 (return of capital); paying institution block, recipient block, income schedule table, Section 10(1)(i) exemption notice, authorised signatory + stamp area, certificate number `IT3B-SVC-{year}-{id}`
- [x] **P3 — Forgot Password Flow (Investor/Admin login)** — In-page 2-step flow on `login.html`; clicking "Forgot password?" hides the main form and shows a reset panel; email validation → 1.2s simulated send → success confirmation with check-inbox panel; "Back to Sign In" restores original form; no page reload
- [x] **P3 — Forgot PIN Flow (Staff login)** — "Forgot your PIN?" link on step 1 of `team/login.html`; hides email/PIN steps and step indicator; email input → 1.2s simulated send → success state with `closeForgotPin()` returning to step 1; consistent with dark-theme design system
- [x] **P3 — PWA Manifest** — `manifest.json` at project root (`/manifest.json`); `fund/sw.js` service worker with install (pre-cache static shell), activate (old cache cleanup), fetch (network-first + cache fallback; API calls pass-through); `<link rel="manifest">` + `theme-color`, `apple-mobile-web-app-*` meta tags added to `fund/index.html`; SW registration script at page bottom with 60s update polling
- [ ] **2FA / OTP** for login security
- [ ] **Push notifications** for maturity reminders
- [ ] **Dark/light mode toggle** (CSS variables already support both)
- [ ] **Mobile app** store submission (manifest + icons ready)
- [x] **Paystack** inline payment popup (card, instant EFT, mobile money) — test keys integrated
- [x] **Ozow** direct EFT redirect (all SA banks) — sandbox mode
- [ ] **Ozow production** — replace SiteCode `SVCA-001` and add server-side hash generation
- [ ] **Paystack webhooks** — server-side payment verification (requires backend)
- [ ] **Email delivery** for statement PDF (via email API)

---

## Payment Gateway Integration

The investor portal wallet supports three funding methods via a **premium 3-step modal flow** (`portal/js/portal.js`):

### Step 1 — Amount
- Large amount input with quick-select chips (R500 / R1k / R2.5k / R5k / R10k / R25k / R50k / R100k)
- Live hint: validates minimum R100 and shows green confirmation copy
- Progress bar and step label update on each transition

### Step 2 — Choose Method
| Method | Provider | Timing | Notes |
|--------|----------|--------|-------|
| Card / Instant EFT / Mobile Money | **Paystack** | Same day | Inline popup — no redirect |
| Direct bank EFT | **Ozow** | Same day | Page redirect to Ozow secure page |
| Manual bank transfer | Manual EFT | 1–2 business days | Shows bank details in-modal |

### Step 3 — Process
- **Paystack**: `PaystackPop.setup()` launches the Paystack inline iframe. On `callback` the deposit is recorded as `completed`. On `onClose` the modal returns to step 2.
- **Ozow**: A pending deposit is pre-recorded then the browser redirects to `pay.ozow.com`. Return URL query params (`?payment=success|cancelled|error&ref=…&gw=ozow`) are detected on page load and the transaction is updated accordingly.
- **EFT**: Bank details (ABSA, account 4085261234, investor ID as reference) are displayed. "I've Made the Transfer" records a `pending` deposit.

### Keys & Config
| Key | Value | Environment |
|-----|-------|-------------|
| Paystack Public Key | `pk_test_72040393098052bb00477db9fb8f69f369193707` | **Test** |
| Paystack Secret Key | `sk_test_9696da0…` (server-side only, never in frontend) | **Test** |
| Ozow SiteCode | `SVCA-001` (placeholder) | **Sandbox** |

> ⚠️ **Production checklist**:
> 1. Replace Paystack test key with live `pk_live_…` key
> 2. Set up Paystack webhook (`/webhooks/paystack`) to verify charges server-side
> 3. Replace Ozow `SiteCode` with your registered site code and generate the `HashCheck` server-side using your Ozow private key
> 4. Move the Paystack secret key to a server-side environment variable — **never expose it in the browser**

---

## Compliance

- **Regulator**: Financial Sector Conduct Authority (FSCA) — South Africa
- **License**: SmartVest Financial Services (Pty) Ltd · FSP #52449
- **License Type**: FSP — Short-Term & Long-Term
- **AML/FICA**: Compliant
- **Data**: All investor data is stored in the platform's sandboxed database

---

---

## CI Files Summary

| File | Purpose |
|------|---------|
| `css/home-ci.css` | CI overrides for public home page (white sections, orange/teal accents) |
| `css/ci-theme.css` | CI overrides for portal + admin (light theme on dark base) |
| `css/brand.css` | Brand design tokens (colors, typography, spacing) |
| `assets/logo-inline.svg` | Official SVG logo mark — used in nav, sidebar, footer, statements |

*Last updated: May 2026 — **v5 Release:** Onboarding task persistence engine (`syncOnboardingProgress()` — evaluates real data, auto-PATCHes progress + completes journey with +150 XP ceremony). Director completion notifications. Director Help Panel (6 views, gold floating button). IFA portal auth guard. **v4 Release:** Director Panel (`team/director.html`) — Super Admin rights for CEO/executive employees, full employee creation wizard with 4-step onboarding automation, RBAC matrix view, course library, onboarding progress tracker. Onboarding Journey: 3 AI-generated orientation courses pre-seeded (CRS-OB-001/002/003) with 9 modules, auto-enrolment on employee creation, onboarding banner on employee portal. Platform Help System: `HELP_CONTENT` for all 16 views, sliding help panel, auto-updates on navigation. Staff Auth v2: `isDirector()` helper, `director` app key in RBAC. **v3:** Employee Self-Service Portal v3: Profile, Birthday notifications, Team Leave Calendar. **v2:** Staff Login + RBAC Hub + EVA compensation formula (AUM × 2.5%). **v1:** Public site, Investor Portal, Admin Console, IFA Portal, Fund Management, SV Intelligence AI.*

---

## 🔐 Staff Authentication & Role-Based Access Control

A complete login and RBAC system for all internal staff portals, using `localStorage` sessions (static site — no backend required).

### Entry Points
| URL | Purpose |
|-----|---------|
| `/team/login.html` | Staff login page — email lookup + 4-digit PIN |
| `/team/hub.html` | Post-login app hub — shows only permitted apps for logged-in role |

### Files
| File | Purpose |
|------|---------|
| `js/staff-auth.js` | Shared auth library: `getSession`, `setSession`, `clearSession`, `guard()`, `getAllowedApps()`, `canAccess()`, `injectWidget()`, `logout()` |
| `team/login.html` | Staff login SPA — 2-step flow (email → PIN), employee preview card, animated PIN boxes, demo hints |
| `team/hub.html` | Role-filtered app hub — allowed tiles + locked tiles + session bar + access-denied banner |

### Authentication Flow
1. Employee visits any protected page → `StaffAuth.guard()` fires
2. No session → redirect to `team/login.html` (intended URL stored in `sessionStorage`)
3. Enter work email → system looks up `employees` table (full pagination)
4. Employee found → show employee card + PIN step
5. PIN = last 4 digits of SA ID number (or universal demo PIN `1234`)
6. Valid PIN → `StaffAuth.setSession()` → redirect to `team/hub.html` (or original destination)
7. Session stored in `localStorage` for **8 hours** then auto-expires

### RBAC Matrix
| Role | Permitted Apps |
|------|---------------|
| `CEO` | All **7** apps (employee, team, fund, admin, ifa, portal, **director**) |
| `Operations Manager` | employee, team, fund, admin |
| `Finance Manager` | employee, team, fund, admin |
| `Tech Lead` | employee, team, fund, admin |
| `Investment Analyst` | employee, team, fund |
| `Compliance Officer` | employee, admin |
| `Client Relations` | employee, portal |
| `Marketing` | employee only |
| `Junior Analyst` | employee only |
| `Admin` | employee only |
| Any `executive` level | All **7** apps including **director** (level overrides role) |

> **Super Admin Rule**: Director Panel (`director` app key) is only accessible if `StaffAuth.isDirector(session)` returns `true`. This checks `session.role === 'CEO' || session.level === 'executive'`.

### Session Object (localStorage `staffSession`)
```json
{
  "empId": "uuid",
  "email": "sipho.dlamini@svcapital.co.za",
  "firstName": "Sipho",
  "lastName": "Dlamini",
  "role": "Investment Analyst",
  "level": "senior",
  "department": "Investments",
  "avatarInitials": "SD",
  "avatarColor": "#7c5cfc",
  "xpPoints": 2450,
  "loginTime": 1716192000000,
  "expiresAt": 1716220800000
}
```

### Auth-Protected Pages
| Page | App Key | Guard Added |
|------|---------|-------------|
| `team/employee.html` | `employee` | ✅ |
| `team/index.html` | `team` | ✅ |
| `admin/index.html` | `admin` | ✅ |
| `fund/index.html` | `fund` | ✅ |
| `team/director.html` | `director` | ✅ `isDirector()` |
| `ifa/index.html` | `ifa` | ✅ |

### Hub Features
- **Role-filtered tiles** — only permitted apps shown as clickable cards
- **Locked section** — restricted apps shown (greyed out) so users understand the platform scope
- **Primary tile** — My Dashboard always shows first as a full-width featured card
- **Access-denied banner** — shows when redirected from an unauthorised page
- **Session bar** — shows login time, date, session expiry countdown
- **XP badge** — shows employee's current XP in the hero area
- **Session widget** — floating pill injected on all staff pages: avatar + name + hub link + logout

### Demo Login
| Employee | Email | PIN | Access Level |
|----------|-------|-----|-------------|
| **Alexandra van der Berg (CEO)** | **alex.vanderberg@svcapital.co.za** | **`2083`** (last 4 of ID) | **All 7 apps + Director Panel** |
| Sipho Dlamini (Investment Analyst) | sipho.dlamini@svcapital.co.za | Last 4 of ID or `1234` | employee, team, fund |
| Zanele Nkosi (Compliance Officer) | zanele.nkosi@svcapital.co.za | Last 4 of ID or `1234` | employee, admin |

> **Test Director**: Alexandra van der Berg — `EMP-DIR-001` — Role: CEO — Level: Executive — 8,750 XP (MVP) — Streak: 21 days — All 7 apps including Director Panel.

---

## Team Dashboard — EVA Compensation Platform (`/team/`)

An internal high-performance team dashboard combining KPI tracking, Economic Value Added (EVA) compensation calculations, leave management, gamification and analytics.

### Portal Structure
| File | Purpose |
|------|---------||
| `team/index.html` | Team Dashboard SPA (7 views) |
| `team/css/team.css` | Dark gamification theme — XP bars, rank badges, streak counters, leaderboard |
| `team/js/team.js` | EVA engine, KPI scoring, all view renderers, gamification logic |

### Views
| View | Description |
|------|-------------|
| **Dashboard** | EVA hero panel (AUM, revenue, pool totals), team member KPI cards with score rings, XP progress bars, active challenges widget, team KPI bar chart |
| **Leaderboard** | XP-ranked leaderboard with level badges, streak indicators, EVA share; per-period distribution table |
| **KPI Management** | Score all 8 dimensions per employee per period; radar comparison chart; dimension reference guide |
| **Leave Management** | Approve/reject leave requests; annual/sick/study/family types; EVA impact indicators |
| **EVA Pool** | Full EVA calculation engine; individual + collective breakdown table; doughnut chart; CSV export |
| **Achievements** | Badge wall; team challenges with XP + ZAR rewards; award badges via modal |
| **Settings** | Employee profile management; XP, streak, EVA weight, status edits |

### EVA Calculation Engine
```
Gross Revenue  = Total AUM × 2.5%                   ← Fixed formula (e.g. R168M × 2.5% = R4.2M)
EVA Pool       = Gross Revenue − Operational Costs
Team Pool      = EVA Pool × team_pool_pct (50%)
Indiv Pool     = Team Pool × 60%       (weighted by KPI score × eva_weight)
Collect Pool   = Team Pool × 40%       (split equally across all active employees)
Employee Share = (emp_weight × overall_score/100) / Σ(all weights) × Indiv Pool + Collect Pool/headcount
```
The 2.5% rule is enforced in `deriveEVAPeriod()` in `team.js` and `EMP_AUM_RATE` in `employee.js`. Both the Admin EVA panel and the Employee EVA Statement show the formula breakdown transparently.

### Gamification System
| Element | Description |
|---------|-------------|
| **XP Points** | Awarded for badges, achievements and top performance |
| **Levels** | Analyst → Associate → Senior → Lead → Director → MVP (based on XP thresholds: 0/500/1200/2500/4500/7000) |
| **Streaks** | Consecutive-day performance streaks with flame indicator |
| **Badges** | Custom badges with icon, colour, category, XP award |
| **Challenges** | Team and individual challenges with ZAR + XP + badge rewards |
| **Leaderboard** | Live XP ranking with gold/silver/bronze rank medals |

### Database Tables
| Table | Fields | Purpose |
|-------|--------|--------|
| `employees` | 17 | Staff profiles, XP, level, streak, EVA weight, avatar |
| `kpi_scores` | 16 | Monthly per-employee scores across 8 dimensions + overall + EVA share |
| `leave_requests` | 12 | Leave requests with type, date range, EVA impact % |
| `eva_periods` | 14 | Monthly EVA pool periods with full financial breakdown |
| `achievements` | 11 | Badge/achievement records with XP awards |
| `team_challenges` | 13 | Team and individual challenges with rewards |

---

## Employee Self-Service Portal (`/team/employee.html`) — World-Class Edition

A fully automated, gamified employee-facing dashboard. Every action earns XP, boosts KPI scores, and moves the EVA pool share — no admin intervention required.

### Access
URL: `team/employee.html?id=EMP001` (any employee ID from `employees` table)
Linked from: Team Dashboard → each employee card → "Employee View"

### 14 Views
| View | Sidebar Icon | Description |
|------|------|-------------|
| **Dashboard** | 🏠 | Profile hero, XP bar, level, streak, EVA preview, smart notifications (check-in, pulse, 1-on-1, wellbeing alerts), stats cards, recent activity feed |
| **My Courses** | 📖 | In-progress, completed, recommended; full course reader with module nav, rich lessons, MCQ quiz; AI generator |
| **Learning Paths** | 🛤️ | Structured role-based paths (mandatory + optional); sequential course steps; path completion rewards |
| **My KPIs** | 📊 | 8 dimension bars, Chart.js trend line + radar, course→KPI map, 6-month history table |
| **My OKRs** | 🎯 | Full CRUD: create objectives + 3 KRs; slider progress updates; auto KPI boost on 100% completion |
| **Feedback & Kudos** | 👏 | Give kudos; 360° feedback modal; received/given/team-wall tabs; +25 XP for giving kudos |
| **Pulse Survey** | 📊 | Weekly 3-question + eNPS survey; auto-shows active survey; previous responses history |
| **1-on-1s** | 💬 | View past + upcoming meetings; toggle action items done (auto-XP); request new meetings; add pre-meeting notes |
| **Daily Check-in** | ☀️ | Mood selector (5 options); tasks planned; auto-streak; burnout detection (3+ stressed moods → alert) |
| **My Leave** | 📅 | Submit and track leave requests; EVA impact indicator |
| **Achievements** | 🏆 | Badge wall (earned + locked); certificates list with click-to-view; XP total; streak display |
| **Activity Feed** | ⚡ | Chronological feed: course completions, badges, kudos, OKR milestones, level-ups, streaks |
| **Journal** | ✏️ | Private notes editor; pinned notes; create/edit/delete; privacy toggle |
| **EVA Statement** | 💰 | Payslip-style breakdown: team pool → individual + collective share; KPI-linked improvement guide; history table |

### Full Automation Engine

| Trigger | Automated Action |
|---------|-----------------|
| Module quiz passed ≥60% | +XP to employee record; KPI boost applied |
| Course completed | Certificate ID generated; graduation badge created |
| Course completed | `completeModule()` → auto-XP → auto-KPI boost → auto-badge → confetti |
| Level threshold crossed | Toast + activity feed entry |
| OKR reaches 100% | KPI boost (+10 pts) + 100 XP |
| Kudos sent | +25 XP to sender |
| 360° feedback sent | +15 XP to sender |
| Daily check-in submitted | +20 XP + attendance KPI +1 + streak +1 |
| Streak milestone (×7) | +50 bonus XP + toast |
| Badge milestone (5/10 courses, 7/30 streak, etc.) | Auto-badge + 100 XP |
| Missed check-in day | Streak reset to 0 |
| Pulse survey submitted | +20 XP |
| Action item marked done | +10 XP |
| Learning path completed | Bonus XP + badge |

### AI Course Generator
- Employee enters: **title, category, KPI dimension, custom focus**
- Engine: `buildModuleTemplates()` → 3 modules × (lesson content + 5 key points + 3 MCQ quiz with explanations)
- On generation: auto-creates `employee_courses` + `course_modules` records + auto-enrols
- No external API required — intelligent SV Capital–specific template engine

### Employee Portal — Extra Views (v3 additions)
| View | Sidebar Icon | Description |
|------|------|-------------|
| **Leave Calendar** | 📅 | Full team calendar with coloured leave blocks per person, birthday 🎂 overlays, month navigation, "who's on leave" list below grid |
| **My Profile** | 🪪 | Personal details (name, email, phone, DOB, ID, emergency contact); banking info (bank, account #, type, branch, holder) with masking for privacy; proof of banking document upload; profile completeness indicator; edit modal for all fields |

### Birthday System
- On page load, `checkBirthdays()` scans all employees' `birth_date` field
- If today matches **any employee's** birthday: a top banner slides in with name + celebration emoji
- If it is **the logged-in employee's birthday**: auto-awards **+100 XP**, logs to activity feed
- "Send Wishes" button on birthday banner pre-fills the kudos form for that person
- Birthday dates are shown on the **Leave Calendar** with 🎂 chips

### Profile Fields Added to `employees` (28 fields total)
| Field | Description |
|---|---|
| `birth_date` | `YYYY-MM-DD` — used for birthday detection and age display |
| `phone` | Mobile/cell number |
| `id_number` | SA ID number (masked in UI: `YYMMDD••••••XX`) |
| `bank_name` | Bank (FNB, Standard, Nedbank, Absa, Capitec, etc.) |
| `bank_account_number` | Account number (masked: `•••••1234`) |
| `bank_account_type` | Cheque / Savings / Transmission |
| `bank_branch_code` | Universal branch code |
| `bank_account_holder` | Name exactly as on bank account |
| `proof_of_banking_url` | Filename/path of uploaded banking document |
| `emergency_contact_name` | Emergency contact full name |
| `emergency_contact_phone` | Emergency contact number |

### Onboarding System

Every newly created employee is automatically enrolled in an onboarding journey:

1. **`employee_onboarding` record** created on employee creation (`status: 'in_progress'`, `tasks_total: 10`)
2. **3 onboarding courses** auto-enrolled via `course_progress` records
3. **Activity feed entry** logged for `onboarding_started`
4. **Welcome banner** shown in `employee.html` while onboarding is incomplete

#### Onboarding Courses (pre-seeded)
| ID | Title | Category | XP | KPI Boost |
|----|-------|---------|----|-----------|
| `CRS-OB-001` | Welcome to SV Capital — Company Orientation | soft_skills | 200 | compliance_score +5 |
| `CRS-OB-002` | Platform Walkthrough — How Everything Works | technical | 250 | task_completion_rate +8 |
| `CRS-OB-003` | Compliance, FICA & Legal Obligations | compliance | 200 | compliance_score +8 |

#### Onboarding Modules (9 pre-seeded)
| Module | Course | Title |
|--------|--------|-------|
| MOD-OB-001-1 | CRS-OB-001 | Our Story, Mission & Values |
| MOD-OB-001-2 | CRS-OB-001 | Our Products & Investment Philosophy |
| MOD-OB-001-3 | CRS-OB-001 | Your Role in the Business |
| MOD-OB-002-1 | CRS-OB-002 | My Dashboard Deep Dive |
| MOD-OB-002-2 | CRS-OB-002 | Learning & XP System |
| MOD-OB-002-3 | CRS-OB-002 | EVA Compensation Model |
| MOD-OB-003-1 | CRS-OB-003 | FSCA Regulation & FAIS |
| MOD-OB-003-2 | CRS-OB-003 | POPIA & Data Privacy |
| MOD-OB-003-3 | CRS-OB-003 | AML Red Flags & Escalation |

#### Default 10 Onboarding Tasks (`buildDefaultTasks()`)
| # | Task Key | Category | XP | Required |
|---|----------|---------|-----|----------|
| 1 | `complete_profile` | setup | 50 | ✅ |
| 2 | `add_banking` | setup | 50 | ✅ |
| 3 | `course_orientation` | learning | 200 | ✅ |
| 4 | `course_platform` | learning | 250 | ✅ |
| 5 | `course_compliance` | compliance | 200 | ✅ |
| 6 | `first_checkin` | system | 20 | ✅ |
| 7 | `set_first_okr` | system | 50 | — |
| 8 | `give_first_kudos` | social | 25 | — |
| 9 | `view_eva_statement` | system | 20 | — |
| 10 | `upload_proof_banking` | compliance | 30 | ✅ |

#### Onboarding Welcome Banner (`#onboarding-banner`)
- Fixed top banner appears on `employee.html` if `employee_onboarding.status !== 'completed'`
- Shows: personalised welcome message, progress %, next 3 task chips (clickable → navigate to relevant view)
- Auto-adjusts page layout (adds `padding-top: 100px` to `.emp-layout`)
- Dismissible via Hide button

### Platform Help System

A sliding help panel (`#helpPanel`) on `employee.html` with contextual help text for all 16 views:

| View | Help Sections |
|------|---------------|
| Dashboard | Profile Hero, Smart Notifications, Stats Cards, Recent Activity |
| My Courses | Course Cards, Starting a Course, Quizzes, Certificates, AI Generator |
| Learning Paths | Mandatory vs Optional, Path Progress, Path Rewards |
| My KPIs | 8 KPI Dimensions, How Scores are Set, Trend Chart, KPI & EVA Link |
| My OKRs | What is an OKR, Creating an OKR, Updating Progress |
| Feedback & Kudos | Giving Kudos, 360° Feedback, Tab navigation |
| Pulse Survey | The Survey, eNPS, Previous Responses |
| 1-on-1s | Upcoming & Past Meetings, Action Items, Pre-Meeting Notes, Request Meeting |
| Daily Check-in | Mood Selector, Tasks, Streak System, Burnout Detection |
| My Leave | Leave Types, EVA Impact, Approval Process, Leave Calendar |
| Achievements | Earning Badges, Certificates, XP & Levels |
| Activity Feed | What Appears Here, Public vs Private |
| Journal | Privacy, Creating Notes, Editing & Deleting |
| EVA Statement | The Formula, Individual vs Collective |
| Leave Calendar | Calendar Reading, Birthday Chips |
| My Profile | Profile Fields, Banking Details, Document Upload |

**Implementation:**
- `toggleHelpPanel()` — slides panel in/out from right edge (400px wide, `z-index: 8500`)
- `renderHelpContent(view)` — populates panel body with view-specific content from `HELP_CONTENT` object
- `window.navigate` override — auto-updates help panel content when user navigates
- Quick-nav chips at bottom — jump to any view directly from the help panel

### All Database Tables

| Table | Fields | Purpose |
|-------|--------|---------|
| `employees` | 28 | Core employee profiles, XP, level, streak, banking, DOB, contact details |
| `kpi_scores` | 16 | 8-dimension monthly KPI records |
| `employee_courses` | 19 | Course catalogue + KPI mapping |
| `course_modules` | 9 | Lesson content + quiz JSON |
| `course_progress` | 14 | Per-employee enrollment + quiz scores + certificates |
| `daily_checkins` | 9 | Daily mood/tasks/streak |
| `okrs` | 19 | Objectives + 3 Key Results + progress + KPI link |
| `peer_feedback` | 11 | Kudos + 360° feedback between employees |
| `pulse_surveys` | 7 | Weekly 3-question pulse survey definitions |
| `pulse_responses` | 10 | Per-employee survey responses + eNPS |
| `one_on_ones` | 13 | Meeting notes + action items + mood rating |
| `learning_paths` | 12 | Ordered course sequences + mandatory flags |
| `activity_feed` | 10 | Event log for all XP/badge/kudos/OKR events |
| `personal_notes` | 8 | Private journal entries per employee |
| `achievements` | 11 | Earned badges per employee |
| `leave_requests` | 12 | Leave submissions + EVA impact |
| `eva_periods` | 14 | Monthly pool totals + status |
| `onboarding_tasks` | 14 | Per-employee onboarding task tracking (key, category, xp_reward, completion status) |
| `employee_onboarding` | 11 | Per-employee onboarding journey (status, tasks_total, tasks_completed, welcome_message, buddy) |

### KPI Dimensions
| Dimension | Field | Auto-Boosted By |
|-----------|-------|-----------------|
| Revenue Contribution | `revenue_contribution` | AUM/client courses |
| Client Satisfaction | `client_satisfaction` | Client relations courses |
| Task Completion | `task_completion_rate` | Any task-focused course |
| Response Time | `response_time_score` | Communication courses |
| Compliance | `compliance_score` | Compliance/FICA courses |
| Innovation | `innovation_score` | Tech/innovation courses |
| Team Collaboration | `team_collaboration` | Leadership courses |
| Attendance | `attendance_score` | Daily check-in (+1/day) |
