# Driving Practice preview

Isolated staging site: https://realayd.github.io/driving-practice-preview/

Open directly in Safari on iPhone, not inside a Claude preview frame.

The workflow checks out `RealAyd/driving-simulator-vr` branch `rebuild/3d-judgement-simulator`, runs `npm ci` and `npm run build`, and publishes `dist-sim`. Production is not modified. No custom domain is configured.

## Refresh after source updates

Open Actions → Standalone iPhone preview → Run workflow → main → Run workflow. This publishes the latest rebuild source. Source pushes alone do not trigger this separate repository.

Build identity is available at `/driving-practice-preview/build-info.json`.

Tilt requires a real iPhone test: select Tilt, grant motion permission if requested, calibrate in landscape, and check steering direction and recentering. Hosting alone does not prove tilt or phone-viewer VR works.
