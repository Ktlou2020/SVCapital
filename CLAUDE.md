# SVCapital — Claude Code Instructions

## Branch Strategy
Develop on `staging`. Commit and push all changes to `staging`. Merge `staging` → `main` only when ready to deploy to production.

## Pull Requests
Do not create pull requests. Push commits directly to `staging` during development.

## Service Worker Cache
Bump `mobile/www/sw.js` CACHE version (svc-portal-vN) with every JS/CSS change to mobile.

## Web Portal Versioning
Bump `portal/index.html` query string (`js/portal.js?v=N`) with every web portal JS change.

## Admin Console Versioning
Bump `admin/index.html` query string (`js/admin.js?v=N`) with every admin JS change. Check the current version number in `admin/index.html` before bumping.

## Purple / Brand Colour
The single canonical purple across the entire platform is `#eda5ff`. No other purple values are permitted.

## Platform Fee
Platform fee is 1% of investment amount. Fee transactions must always display as **negative** in all transaction lists and statements.

## Sub-Account Invest Gate
`openSaInvest()` must check `wallet_balance >= min_investment` before navigating to the marketplace. Uses cheapest open pool as the threshold. Fee is inclusive (taken from the wallet amount, not added on top).
