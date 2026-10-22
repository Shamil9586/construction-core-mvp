#!/usr/bin/env bash
set -euo pipefail

ROOT="${GITHUB_WORKSPACE:?GitHub Actions workspace required}"
BUNDLE="$ROOT/review-input/R04_CP02_candidate.bundle"
CAND="b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d"
BASE="92fcf6d047fd22453349260432dbc65590386a17"
BUNDLE_SHA256="7a22bf6ded4e70536a3bcbbfd949c23873ce894e2574245a197b7a3978396821"

[[ -f "$BUNDLE" ]] || {
  echo "BLOCKED: exact owner-approved Git bundle not uploaded to review-input branch" >&2
  exit 2
}
printf '%s  %s\n' "$BUNDLE_SHA256" "$BUNDLE" | sha256sum --check --status || {
  echo "REFUSED: candidate bundle SHA-256 mismatch" >&2
  exit 2
}
[[ "$(git -C "$ROOT/core" rev-parse HEAD)" == "$BASE" ]] || {
  echo "REFUSED: baseline checkout identity mismatch" >&2
  exit 2
}
[[ -z "$(git -C "$ROOT/core" status --porcelain)" ]] || {
  echo "REFUSED: dirty baseline checkout" >&2
  exit 2
}
git -C "$ROOT/core" bundle verify "$BUNDLE"
heads="$(git -C "$ROOT/core" bundle list-heads "$BUNDLE")"
[[ "$heads" == "$CAND refs/heads/feature/gpr2-r04-cp02" ]] || {
  echo "REFUSED: unexpected bundle head" >&2
  exit 2
}
git -C "$ROOT/core" fetch --no-tags "$BUNDLE" 'refs/heads/feature/gpr2-r04-cp02:refs/remotes/r04-bundle/candidate'
[[ "$(git -C "$ROOT/core" rev-parse refs/remotes/r04-bundle/candidate)" == "$CAND" ]] || {
  echo "REFUSED: fetched candidate SHA mismatch" >&2
  exit 2
}
git -C "$ROOT/core" -c advice.detachedHead=false checkout --detach "$CAND"
printf 'verified_bundle_sha256=%s\n' "$BUNDLE_SHA256"
printf 'verified_candidate_sha=%s\n' "$CAND"
