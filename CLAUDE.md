# SVCapital — Claude Code Instructions

## Branch Strategy
Develop on `staging`. Commit and push all changes to `staging`. Merge `staging` → `main` only when ready to deploy to production.

Three branches, one Railway environment each, in the SV Capital project:

| Branch                | Railway environment   | Deploys to                                     |
| --------------------- | --------------------- | ---------------------------------------------- |
| `main`                | production            | platform.svcapital.co.za — real clients, real money |
| `staging`             | staging               | svcapital-staging.up.railway.app                |
| `future-developments` | Future Developments   | svcapital-future-developments.up.railway.app    |

Each environment has its own Postgres, so nothing on a branch can reach
another's data. `future-developments` is for work that is not ready to sit in
the staging queue; it branched from `staging` and is merged back into
`staging`, never straight into `main`.

Push to the branch the work belongs on. Do not push to a branch the user did
not name.

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

## Rebuilding the mobile bundle
Rebuild with `node mobile/scripts/build.js` after any change that reaches the
app — anything in `mobile/src/`, and anything in `portal/` or the shared
`js|css|assets/` that the app inherits.

**There is no cache version to bump any more.** The app carried a caching
service worker with a `svc-portal-vN` version, and this file used to say to
bump it on every change. It never ran: `mobile/src/js/native.js` unregisters
every service worker and deletes every cache at launch, deliberately — a
cache-first worker over assets that are already local serves stale JS and
races network against cache, so content flashes and disappears. The bundle
now carries the push-only worker from `portal/sw.js`, which has no version.
`check-mobile-config` holds that: it asserts the app registers no worker and
that `native.js` still clears any it finds.

`mobile/www` is a BUILD OUTPUT, generated from `portal/` plus the overrides in
`mobile/src/`. A file edited in `www` is wiped by the next build.
`check-mobile-build-reproducible` catches it: it rebuilds and compares byte for
byte, and names any file edited in `www` instead of `src`.

**A file in `mobile/src/` SHADOWS the shared one, so a fix made on the web
never reaches the app.** That is what an override is for, and it is also how
`signup.html` and `staff-auth.js` quietly fell months behind. Before adding
one, check whether the difference is something `build.js` already injects —
it adds the Capacitor native config to every HTML file it copies. Delete a
file from `mobile/src/` to hand it back to the shared layer.

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

**The group screens are a deliberate exception and carry no purple at all.**
Asked for in a review of the staging stokvel pages: a group's banner should
read as its own thing, what is approved should read as settled, and what is
waiting on somebody should read as waiting. The personal portal is unchanged
and still purple — if the two look different on your screen, that is why, and
it is not a bug to fix.

Their palette is four named constants at the top of the Stokvels section in
`js/portal-core.js`, and nothing in those screens writes a colour literal:

| Constant | Value | What it is for |
| --- | --- | --- |
| `SV_GREEN` | `#078e07` | The group's own colour: its banner, and anything settled — approved, confirmed, done, verified. |
| `SV_GOLD` | `#ff9b0c` | A thing waiting on a person: a vote they owe, a payment due, the step in progress, the primary button. |
| `SV_INK` | `#303030` | Text. |
| `SV_GREY` | `#656565` | Borders, dividers, and an icon that is punctuation rather than a signal. |
| `SV_WASH` | `rgba(0,0,0,0.035)` | The faint wash behind a highlighted box, so its border does the speaking. |

A border that was purple becomes `SV_GREY`, not `SV_GREEN`: it was carrying
the brand, not saying anything, and a green box round everything makes the
green that DOES mean something worthless.

`check-group-colour.cjs` holds both halves — no purple inside the group
functions, and no raw hex where a constant belongs.

## Platform Fee
Platform fee is 1% of the investment amount, charged **on top of it**. The amount a client enters is what reaches the pool; the wallet pays that amount plus the fee. Enter R500 into a pool with a R500 minimum and R500 reaches the pool, R5,00 is the fee, and R505,00 leaves the wallet.

The pool minimum is a rule about the **pool**, so it is tested against the pool amount, never against the wallet spend. Fee transactions must always display as **negative** in all transaction lists and statements.

## Sub-Account Invest Gate
`openSaInvest()` must check `wallet_balance >= min_investment + fee` before navigating to the marketplace. Uses the cheapest open pool as the threshold. A balance equal to the minimum is short by the fee.
