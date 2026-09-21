# SVCapital — Claude Code Instructions

## Branch Strategy
Develop on `staging`. Commit and push all changes to `staging`. Merge `staging` → `main` only when ready to deploy to production.

## Pull Requests
Do not create pull requests. Push commits directly to `staging` during development.

## Announcing a New Feature
Every feature added to the admin console or the live client portal gets a row
in `feature_announcements`, so staff are told it exists and where to find it.

Add it as a step in `server/db/setup.js` alongside the others, with
`ON CONFLICT (id) DO NOTHING` so a redeploy never overwrites wording somebody
has edited or switched off. Each notice carries:

| Field | What goes in it |
| --- | --- |
| `title` | The feature, in a line. |
| `body` | What it does, and what it replaced if that is why it matters. |
| `where_to_find` | **The path to it.** "Clients → open a client → Overview tab." This is the field release notes leave out and the only one somebody can act on — a notice without it is not worth publishing. |
| `area` | `admin`, `portal`, or `both` — where the feature lives. |
| `audience` | `staff` (default), `clients`, or `everyone`. |

Staff see undismissed notices at the top of the admin dashboard and dismiss
them one at a time; the dismissal is per person and per notice, held server
side, so reading it on one machine settles it on all of them.

Fixes to existing behaviour do not need one. A change to where something is,
what it is called, or what it now does, does.

## Service Worker Cache
Bump `mobile/www/sw.js` CACHE version (svc-portal-vN) with every JS/CSS change to mobile.

## Web Portal Versioning
Bump `portal/index.html` query string (`js/portal.js?v=N`) with every web portal JS change.

## Admin Console Versioning
Bump `admin/index.html` query string (`js/admin.js?v=N`) with every admin JS change. Check the current version number in `admin/index.html` before bumping.

## Running the Checks
`npm run check` — the suite, each check in its own database cloned from a
template. `npm run check:shuffle` runs them in a random order; isolation means
that should be boring, and a failure there means a check has grown a
dependency on what ran before it. Needs `DATABASE_URL` pointed at a scratch
Postgres — the runner creates and drops databases and refuses anything that
does not look like scratch.

## Purple / Brand Colour
The single canonical purple across the entire platform is `#eda5ff`. No other purple values are permitted.

## Platform Fee
Platform fee is 1% of the investment amount, charged **on top of it**. The amount a client enters is what reaches the pool; the wallet pays that amount plus the fee. Enter R500 into a pool with a R500 minimum and R500 reaches the pool, R5,00 is the fee, and R505,00 leaves the wallet.

The pool minimum is a rule about the **pool**, so it is tested against the pool amount, never against the wallet spend. Fee transactions must always display as **negative** in all transaction lists and statements.

## Sub-Account Invest Gate
`openSaInvest()` must check `wallet_balance >= min_investment + fee` before navigating to the marketplace. Uses the cheapest open pool as the threshold. A balance equal to the minimum is short by the fee.
