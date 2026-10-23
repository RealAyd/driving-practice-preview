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
