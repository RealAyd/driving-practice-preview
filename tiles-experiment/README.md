# Tiles experiment preview package (not active here)

Ready-to-copy deployment for the Google Photorealistic 3D Tiles experiment
(`RealAyd/driving-simulator-vr`, branch `experiment/babylon-photorealistic-tiles`).

It sits in this folder on purpose: workflows only run from the repository root's
`.github/workflows`, and this one is also guarded to run only in
`RealAyd/driving-practice-tiles-experiment`. Nothing here changes this repository's
`main`, its workflow or https://realayd.github.io/driving-practice-preview/.

## To deploy (separate URL)

1. Create a public repository `RealAyd/driving-practice-tiles-experiment` with a README.
2. Its Settings → Pages → Source: **GitHub Actions**.
3. Copy `tiles-experiment/.github/workflows/tiles-experiment-preview.yml` to
   `.github/workflows/tiles-experiment-preview.yml` on that repository's `main`
   (the push starts the build).
4. Optional: repository secret `GOOGLE_MAPS_BROWSER_KEY` (a website-restricted browser key).
   Without it the workflow reuses the existing key from the legacy page on `main`, masked in logs.

Result: https://realayd.github.io/driving-practice-tiles-experiment/ ; `build-info.json` there names
the source commit. iPhone test steps: `docs/experiments/tiles-preview-deploy.md` in the simulator repository.

To deploy under a different repository name, change the `if:` line in the workflow to match.
