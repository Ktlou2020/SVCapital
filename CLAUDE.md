# SVCapital — Claude Code Instructions

## Branch Strategy
All changes go to a single track targeting `main`:

| Files changed | Work branch | PR target |
|---|---|---|
| All files (`portal/**`, `mobile/**`, `admin/**`, `server/**`, `dist/**`, etc.) | `claude/exciting-volta-CxUp1` | `main` |

Always work on `claude/exciting-volta-CxUp1`. The `develop` branch no longer exists.

## Pull Requests
- Always create a PR (not draft) after pushing, if one doesn't already exist for the branch.
- Immediately after creating the PR, call `mcp__github__enable_pr_auto_merge` with `mergeMethod: "SQUASH"` so it merges automatically once checks pass.
- If `enable_pr_auto_merge` returns "already in clean status", call `mcp__github__merge_pull_request` with `merge_method: "squash"` to merge it directly.
- If the PR was already open, still call `enable_pr_auto_merge` on it (then merge directly if already clean).

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
`openSaInvest()` must check `wallet_balance >= min_investment + platform_fee` before navigating to the marketplace. Uses cheapest open pool as the threshold.
