# Staging status — 23 October 2026

- Source handoff d4da039 includes backend and sign-in/purchase UI.
- Manual deployment workflow is published on main. It accepts source_ref,
  resolves abbreviated commits to full SHAs and uses environment github-pages.
- Node 22 Docker packaging, same-origin static/API serving, gate=true,
  provenance, CNAME removal and isolated release branch are implemented.
- Local frontend/backend build passed. The first source checkout failed because
  actions/checkout interpreted d4da039 as a branch; full-SHA resolution fixed it.
- Current run: https://github.com/RealAyd/driving-practice-preview/actions/runs/40034741800
- Current blocker: `Missing environment secrets: RESEND_API_KEY`.
  HOSTLESS_TOKEN and STRIPE_SECRET_KEY are available to the runner (values not
  read or displayed). Stripe mode/permissions and webhook secret remain untested.
- Separate Mongo instance dp-sim-staging is RUNNING/HEALTHY, 2 GiB, Mongo 7.0,
  0.2 CPU / 512 MB. Logical dp_sim_staging database and scoped user are pending
  runner setup. No simulator backend app has been created yet.
- Owner supplies test Payment Links. Resend's existing verified domain is for
  another project; drivingpractice.live still needs domain setup/verification.
- Namecheap DNS changes and custom staging domain are pending app creation.
- Existing production Pages, DriveTest UK backend/database and other webhooks
  have not been changed.

Next: correct the Resend secret name, rerun workflow, resolve any webhook scope
blocker, verify hosted health and scoped database access, then configure DNS,
Resend domain and Payment Links and test account/payment flows.

## Resend mapping resolved

GitHub secret RESEND is now mapped to runtime RESEND_API_KEY. Run
https://github.com/RealAyd/driving-practice-preview/actions/runs/40035247439
passed secret checks, build/tests, packaging and release-branch publication.
All four runtime/deploy secret names are available, including STRIPE_WEBHOOK_SECRET.
Deployment stopped before Hostless app/database-user mutation with exact error:
`STRIPE_SECRET_KEY must be a Stripe TEST key`. The supplied value did not match
the supported sk_test_ or rk_test_ format; its value was not displayed. Owner
must save the correct test key. App creation remains pending.

## Updated Stripe key accepted

Run https://github.com/RealAyd/driving-practice-preview/actions/runs/40036203680
passed test-key format validation, provisioned the scoped dp_sim_app Mongo user
for dp_sim_staging, verified its connection, and created app dp-sim-staging.
The container image built successfully; deployment/HTTP checks are pending.
Hostless deployment id: 6adbe4fe9600443a5d3b1fff.
Release commit: 4d356fcee6f93133adbd8fffb2c8fd6b1eefceaa.
Added staging.drivingpractice.live as a custom domain; DNS status Pending.
No Namecheap records were changed.

Owner supplied the following test links (not yet wired into the deployed packs):
- Starter Pass, GBP2.99: https://buy.stripe.com/test_3cI8wHeQWfyc6Fr4Qe0VO02
  One lesson + one mock test + one free drive; backend needs per-mode allowances.
- VR 5, GBP9.99: https://buy.stripe.com/test_8x2fZ9106adS5Bn0zY0VO03
- VR 15, GBP24.99: https://buy.stripe.com/test_9B628jaAG5XC7Jv0zY0VO04
- VR 35, GBP49.99: https://buy.stripe.com/test_4gM4gr5gmbhWe7T0zY0VO05
All return to https://staging.drivingpractice.live/?checkout=done. Completing
that return journey requires the custom domain to be configured and verified.
The earlier placeholder packs must be replaced before payment testing.

### Deployment verified

The run completed successfully. https://dp-sim-staging.hostless.app/healthz
returns HTTP 200 with ok=true. access.json reports gate=true; /api/config reports
gate=true and devCheckout=false. build-info.json matches source commit
d4da039a97a30ef097df90694c2cc505cdb55d12. Runtime logs confirm API startup on port
8000 in Stripe test mode. This verifies startup and configuration, not payment
crediting, email delivery, browser operation or the Starter entitlement model.

## 24 October 2026: packs, Starter enforcement, workflow fixes, end-to-end results

Source: RealAyd/driving-simulator-vr `assets/batch-a`, commit 7291b73 (packs and
Starter) then f786f86 (adds a log line per Stripe webhook delivery). Deployed URL:
https://dp-sim-staging.hostless.app (Stripe TEST mode; access gate on).

Workflow fixes on main (deploy.mjs): the app update rejected `gitCommitHash`
(Hostless 400) and `deployments/new` needs undocumented fields, so the release now
saves the settings with `?deploy=true` (releases the release-branch head; the
existing check confirms the served commit). Hostless errors are printed with
every secret masked. APP_BASE_URL switches to https://staging.drivingpractice.live
on the first deploy after that domain serves the app; until then it stays on the
platform URL.

Packs (server/packs.json, test links): Starter Pass £2.99 = 1 lesson + 1 mock test
+ 1 free drive as three separate allowances, once per account; VR 5 £9.99, VR 15
£24.99, VR 35 £49.99 = 5/15/35 general sessions. The server decides a drive's kind
from its scenario; a second Starter payment is refunded automatically (flagged if
Stripe refuses). Details and the refund/reconciliation path: server/README.md in
the source repository.

Automated tests (source repository): 34 server tests + 4 against a real MongoDB
(concurrent webhooks, concurrent drive starts, simultaneous Starter payments),
G26 browser flow with fakes. All pass.

End-to-end on staging (real Resend email to throwaway inboxes, real Stripe
test-mode checkout pages, test cards):
- PASS config (gate on, no dev checkout, the four packs and prices)
- PASS email delivery (about 5 s), code (wrong/right/reused), link (once, reuse refused)
- PASS session cookie (survives reload; HttpOnly, Secure, SameSite=Lax); logout
- PASS server-built checkout address (account reference and email)
- PASS declined card and abandoned checkout grant nothing
- FAIL payment credit: test payments complete at Stripe (the browser is sent to
  https://staging.drivingpractice.live/?checkout=done) but no sessions arrive.
  The webhook endpoint is reported as https://staging.drivingpractice.live/api/stripe/webhook,
  and that name does not resolve (NXDOMAIN on public DNS as of 02:00 UTC), so
  Stripe cannot deliver. Starter, duplicate Starter, session use, refunds,
  disputes and isolation on staging are blocked behind this.
- PENDING expired code (automated tests only), iPhone Safari cookies (needs a phone)

Blockers:
1. DNS: add the record Hostless shows for staging.drivingpractice.live (app
   dp-sim-staging, Settings > Custom domains) at Namecheap; then rerun the
   workflow so APP_BASE_URL switches. Resend's records for drivingpractice.live
   are present (DKIM, send.* SPF/MX) and email is delivering.
2. Webhook: until DNS resolves, either wait, or add a second TEST endpoint for
   https://dp-sim-staging.hostless.app/api/stripe/webhook and put its signing
   secret in STRIPE_WEBHOOK_SECRET. Runtime logs now show each delivery
   ("Stripe webhook: <type> <id>") or a signature mismatch.
3. The Stripe key needs Refunds write permission for the automatic refund of a
   second Starter Pass (otherwise it is flagged for a manual refund).

Rollback: redeploy an earlier source commit with the workflow (source_ref), or
the previous Hostless deployment; database data is not reverted.
Live payments have not been switched on; production is unchanged.

## 24 October 2026: custom-domain DNS activation

Owner added CNAME staging.drivingpractice.live -> gateway.hostless.cloud at
Namecheap. Public Google DNS initially returned NXDOMAIN, then resolved the
correct CNAME. HTTPS /healthz on the custom domain returned 200 with ok=true.
No Namecheap settings were changed by this agent.

First rerun 40079666364 retained the platform APP_BASE_URL because the GitHub
runner still saw a negative DNS result. Its verification also accepted the old
build because the source commit matched. Fixed deploy.mjs to keep the verified
canonical origin stable and require matching commit AND builtAt provenance,
plus the API callback origin. New run: 40079776365, source_ref assets/batch-a.
Hostless deployment: 6adc7215cfbe3ce006a06784.

The new release now serves the custom origin: /api/config reports
appleRedirect=https://staging.drivingpractice.live/api/auth/apple/callback,
gate=true and devCheckout=false. HTTPS /healthz returns 200. After rollout,
91 available runtime log entries contained no Stripe webhook delivery or
signature-mismatch lines. Payment crediting remains unverified; make a fresh
Stripe TEST purchase or resend a previous failed test event to check delivery.

## 24 October 2026, 10:30 UTC: end-to-end passed on https://staging.drivingpractice.live

DNS now resolves (CNAME to gateway.hostless.cloud) and HTTPS answers; the deploy
switched APP_BASE_URL to the custom domain. STRIPE_WEBHOOK_SECRET is the signing
secret of the hostless.app endpoint (the custom-domain endpoint's deliveries are
refused by signature; disable one of the two endpoints when convenient).
Source commit 92a4c23 (server unchanged since 365d721).

All PASS (real Resend email, real Stripe TEST checkout pages, test cards):
config; email delivery (2 s), code and link (once each); cookie (HttpOnly, Secure,
Lax, survives reload) and logout; server-built checkout address; VR 5 payment
credited 5 sessions through the webhook; declined card and abandoned checkout
grant nothing; Starter Pass grants 1 lesson + 1 mock test + 1 free drive, is then
refused (409) and a second payment through the public link grants nothing and is
refunded automatically (charge.refunded received); allowances used by the kind of
drive the server decides; failed load gives the session back; 6 simultaneous starts
with 5 sessions + 1 allowance start exactly 6; another account cannot report a
drive; signed out cannot start; a forged cookie is refused.

Still PENDING: code expiry (automated tests only), iPhone Safari cookies (needs a
phone), manual refunds and disputes from the Stripe dashboard (automated tests only).
Live payments are not switched on.
