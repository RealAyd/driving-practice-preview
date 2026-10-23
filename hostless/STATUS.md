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
