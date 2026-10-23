# Simulator staging on Hostless

Run **Hostless simulator staging** from Actions on `main`, with `source_ref`
set to the simulator branch or commit (default `assets/batch-a`).

This workflow uses existing environment `github-pages` because that is where
the owner saved its secrets. It does not invoke GitHub Pages deployment.
The source repository is public. The workflow builds it with Node 22, overlays
same-origin hosting, tests the API, writes `dist-sim/access.json` with gate=true,
removes CNAME and publishes a complete build to `hostless-staging-release`.
That branch has no automatic Pages deployment trigger. It is intended only for
the new Hostless app `dp-sim-staging`. Manual deployments are serialized.

Required GitHub environment secrets:
- HOSTLESS_TOKEN: apps read/write, deployments read/write, databases read.
- STRIPE_SECRET_KEY: TEST mode; restricted read access to Payment Links,
  Checkout Sessions, Prices, Products, Charges, Refunds, Disputes.
- RESEND_API_KEY: sending permission for the verified sender domain.
- STRIPE_WEBHOOK_SECRET: signing secret of the new staging endpoint. If absent
  on first deploy, the workflow attempts to create a TEST endpoint, requiring
  webhook list/create permissions. Existing matching endpoints are not replaced.

Optional environment variables: GOOGLE_CLIENT_ID and APPLE_SERVICES_ID.
No secret values are printed. Runtime secrets are passed directly to Hostless;
they are never written to the release branch or build artifacts.

The isolated Hostless Mongo instance `dp-sim-staging` exists in the owner's
default project. The runner creates logical database `dp_sim_staging` and a
scoped readWrite user, verifies the connection and saves MONGODB_URI in Hostless.
It generates SESSION_SECRET once and preserves it on later releases.
It preserves existing Hostless variables without revealing their values.

Initial app URL: https://dp-sim-staging.hostless.app
Initial webhook URL: https://dp-sim-staging.hostless.app/api/stripe/webhook
Events: checkout.session.completed, checkout.session.async_payment_succeeded,
checkout.session.async_payment_failed, charge.refunded, charge.dispute.created.
APP_BASE_URL initially uses the platform URL so email links and cookies match.
Namecheap custom DNS and the switch to staging.drivingpractice.live are pending.
Coordinate APP_BASE_URL, webhook URL and provider origins when switching domains.

Administrator: dosumuaybamo1@gmail.com.
Sender: Driving Practice <support@drivingpractice.live>.
Reply-to: support.drivingpractice@gmail.com.
Resend must verify drivingpractice.live; creating a key for a different verified
domain does not verify this one. Do not alter existing production/email records.

Owner is supplying TEST Payment Links; server/packs.json currently has empty
links. Deployment health does not establish working checkout or email delivery.
The workflow does not send an email or run a real checkout automatically.

Rollback: use the previous successful Hostless deployment. Release-branch
history preserves earlier artifacts. This does not revert database data.
