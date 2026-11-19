# Deployment (#144)

## Pipeline

1. **Verify** — CI jobs (contract sync, migrations, build, tests, actionlint,
   shellcheck).
2. **Image** — buildx pushes `ghcr.io/<repo>@sha256:<digest>`, cosign signs the
   digest, Syft emits an SPDX SBOM.
3. **Staging** — `deploy-env.yml` verifies the cosign identity, lints migrations
   and runs `helm upgrade --install --atomic`.
4. **Staging checks** — readiness must hold 3 consecutive probes, indexer lag
   must be ≤ 120 ledgers and the cursor must advance.
5. **Production** — same reusable workflow with the production GitHub
   Environment (required reviewers).
6. **Production checks** — 5 consecutive readiness probes plus the same lag,
   cursor and Prometheus checks.

Secrets (kubeconfig, Helm values) live in GitHub Environments. The image is
referenced by digest, never by a mutable tag.

## Migration rule: expand / contract

`scripts/check-migration-compat.mjs` (run on the migrations changed in a PR/release) blocks:

- `DROP TABLE`, `DROP COLUMN`, `RENAME`;
- `ALTER COLUMN … TYPE`;
- `SET NOT NULL`;
- `CREATE INDEX` without `CONCURRENTLY`.

Ship additive migrations first, deploy both versions, then remove old columns
in a later release. `--allow-breaking` exists only for an explicitly approved
maintenance window.

## Admin RBAC first deploy (#49)

Ship the `20261019110000_admin_rbac` migration before the new image. On first
boot the process seeds the fixed permission/role catalogue and assigns every
`ADMIN_ADDRESSES` entry as `super_admin` under an advisory lock. After that the
database is authoritative: removing an address from the environment does **not**
revoke it, and the env list is never consulted per request. Grant/revoke and
treasury writes require a wallet proof no older than `STEP_UP_MAX_AGE_SECONDS`.
If the seed cannot complete, the process refuses to boot rather than serve
without an admin role catalogue.

## Payment intent confirmer (#52)

`startPaymentIntentCron` runs every `PAYMENT_INTENT_CONFIRM_CRON` (default
`*/20 * * * * *`) and uses the same per-hash advisory lock as the legacy unlock,
so all replicas can schedule it safely. It is bounded by
`PAYMENT_INTENT_CONFIRM_BATCH` and backs off up to
`PAYMENT_INTENT_MAX_ATTEMPTS`. Set `PAYMENT_INTENT_CONFIRM_ENABLED=false` to
pause it without blocking interactive `POST /…/submit` calls.

## Rollback

Roll back the Helm release to the previous revision. If the new release added
only expand-phase changes, the old code keeps working. Do **not** roll back the
database; forward-fix instead.

## Post-deploy checks

```bash
API_URL=https://api.example \
INDEXER_STATUS_URL=https://api.example/internal/indexer-status \
MAX_INDEXER_LAG_LEDGERS=120 \
PROMETHEUS_URL=https://prometheus.example \
KUBE_NAMESPACE=oracledesk DEPLOYMENTS="api indexer worker" \
DIGEST=<sha256> ./scripts/post-deploy-checks.sh
```

Checks are read-only. `SKIP_KUBE=1` omits the digest check in local tests.

## Price-market feed health & post-resolution verification (#309)

Open Reflector price-mode markets are checked every 15 minutes (and every 5
minutes within `PRICE_FEED_MONITOR_CLOSE_WINDOW_SECS` of close) using fresh
SEP-40 reads (`assets()`, `decimals()`, `resolution()`, `lastprice()`, and
recent `price(asset, ts)` grid slots) evaluated against the **latest ledger
close time**. Inspect status via `GET /api/v1/admin/price-markets/health`.

### Guardian actions by open-market severity

| Severity | Triggers | Recommended guardian action |
|---|---|---|
| `OK` | Asset supported, decimals & resolution unchanged, age ≤ `maxStaleness / 2`, zero grid gaps. | No action required. |
| `WARN` | `FEED_AGING` (`ageSecs > maxStaleness / 2`), `FEED_STALE` / `NO_DATA` outside the close window, `GRID_GAPS` in the last `PRICE_FEED_GAP_SLOTS` slots, or `RESOLUTION_CHANGED`. | Monitor the Reflector feed status and upstream oracle announcements; confirm whether updates resume before the close window. Pause new price-market creation if the feed is degraded. |
| `CRITICAL` | `FEED_UNSUPPORTED` (asset removed from `assets()`), `DECIMALS_CHANGED` (committed fixed-point threshold no longer matches the intended price), or `STALE_NEAR_CLOSE` / `NO_DATA_NEAR_CLOSE` within `PRICE_FEED_MONITOR_CLOSE_WINDOW_SECS` of close. | **Act before finality**: `resolve_price` finalises immediately with no dispute window, and `guardian_void_market` rejects a `Finalized` market. Verify the feed on-chain and, if the market cannot settle safely, invoke `guardian_void_market` from `RESOLVER_GUARDIAN_ADDRESS` before close/resolution. |

### Post-resolution verification verdicts

On every indexed `PriceResolution` event, the backend verifies the settled
outcome against the committed spec and the close-time snapshot (`price_close_snapshots`):

| Verdict | Meaning | Action |
|---|---|---|
| `CONSISTENT` | Event outcome matches `expectedOutcome(price, threshold, direction)`, event price/timestamp match the close snapshot, and no outcome-flipping outlier was detected. | Record audited; no action required. |
| `UNVERIFIABLE` | No close snapshot was captured and feed history aged out on-chain. | Check why `captureCloseSnapshot` did not record before feed retention expired; verify RPC availability. |
| `OUTCOME_MISMATCH` | Spec hash mismatch or `expectedOutcome` disagrees with the on-chain event outcome (**CRITICAL**). | Treat as a severe resolver/spec incident. Pause agents (`POST /api/v1/admin/agents/ALL/pause`) and investigate contract/spec state immediately. |
| `PRICE_MISMATCH` | Event price or timestamp differs from the Reflector record at `close_time` (**CRITICAL**). | Audit the transaction XDR and Reflector storage history; verify no retroactive feed mutation or resolver misconfiguration occurred. |
| `OUTLIER` | Event price deviated from the median of neighbouring grid records by > `PRICE_VERIFY_OUTLIER_BPS` **and** the threshold lies between the event price and the median (flipping the outcome) (**CRITICAL**). | Inspect the `detail` payload (`deviationFromMedianBps`, `distanceToThresholdBps`, `medianPrice`), audit the Reflector oracle feed, and consider removing the feed from `REFLECTOR_FEEDS_JSON`. |
