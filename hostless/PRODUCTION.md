# Simulator production

Production app: dp-sim-production; public platform URL:
https://dp-sim-production.hostless.app. Canonical URL: https://vr.drivingpractice.live.
Separate Mongo instance dp-sim-production, logical database dp_sim_production,
readWrite-only app user, and new SESSION_SECRET. No staging data is copied.

Run Hostless simulator production on main with source_ref set to a reviewed
simulator commit/branch. Workflow: .github/workflows/hostless-production.yml.
Release branch: hostless-production-release. Staging uses separate scripts,
release branch, app and database. Both workflows currently consume HOSTLESS_TOKEN
and the sending key RESEND from the existing github-pages Actions environment.
Production Stripe secrets are never taken from GitHub staging secrets.

The user saved live credentials in dp-sim-staging, but the API rejected the
requested secure transfer with HTTP 403: Missing required scope(s): secrets:read,
apps:read. No values were obtained or printed, and no bypass was attempted.

Set directly in Hostless Apps > dp-sim-production > Settings > Environment variables:
- STRIPE_SECRET_KEY: live restricted key; read access for Payment Links,
  Checkout Sessions, Prices, Products, Charges, Refunds and Disputes. Refunds
  write is also needed for automatic duplicate-Starter refunds.
- STRIPE_WEBHOOK_SECRET: signing secret for the existing LIVE endpoint at
  https://vr.drivingpractice.live/api/stripe/webhook (not either staging endpoint).
The workflow preserves these values using keepExistingValue; it never reveals
them. RESEND_API_KEY is provisioned from GitHub RESEND. Other runtime defaults,
administrator email, MONGODB_URI and SESSION_SECRET are provisioned automatically.
Optional Google/Apple configuration belongs in this app's environment settings.

The production build fails if four distinct live links are missing, and refuses
to start with a test Stripe key or dev fakes. Deployment verifies exact commit,
build time, live pack URLs and canonical callback origin. This does not prove
Stripe permissions or successful live crediting.

Before cutover, verify app health and configuration on its platform URL. Its
APP_BASE_URL is the canonical vr URL, so full sign-in/checkout return testing
requires that domain. Never configure the production webhook to the staging DB.

DNS observed before cutover: vr.drivingpractice.live CNAME realayd.github.io.
After production is healthy, change only Namecheap CNAME Host vr to
gateway.hostless.cloud and verify HTTPS, health, sign-in and webhook delivery.
Rollback DNS to realayd.github.io if necessary; rolling back DNS does not reverse
charges or database writes. For code rollback use an earlier successful Hostless
production deployment. Preserve production database data.

Restore staging's test Stripe credentials via its existing staging workflow only
after the live secrets have been saved to production, so they are not lost.
