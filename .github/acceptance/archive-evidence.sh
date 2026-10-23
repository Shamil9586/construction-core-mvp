#!/usr/bin/env bash
# Construction Core — GPR-2 CI Foundation: durable archival of one sealed evidence package (run by the OWNER or REVIEWER locally).
# GitHub Actions artifacts expire (90 days at most on a public repository). This helper, which needs a local `gh` login with read access,
#   1. downloads the sealed artifact of a run,
#   2. verifies it with verify-evidence.mjs against the profile at the run's workflow SHA,
#   3. writes a small, text-only evidence index under docs/acceptance-evidence/<stage>/<profile>/run-<id>-a<attempt>/
#      (acceptance-result.json, SUMMARY.md, manifest.json, SHA256SUMS, ARCHIVE.md) to be committed through a reviewed PR, and
#   4. prints — but never runs — the `gh release` command that would attach the full zip to a permanent GitHub Release.
# It changes nothing on GitHub by itself. Owner approval is required for the commit/PR and the release (contents: write).
#
# usage: bash .github/acceptance/archive-evidence.sh <run_id> [attempt]   (from a checkout of the repository)
set -euo pipefail
RUN="${1:?run id}"; ATTEMPT="${2:-1}"
[[ "$RUN" =~ ^[0-9]+$ && "$ATTEMPT" =~ ^[0-9]+$ ]] || { echo 'run id and attempt must be numeric' >&2; exit 64; }
REPO="Shamil9586/construction-core-mvp"
TOP="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
NAME="$(gh api "repos/$REPO/actions/runs/$RUN/artifacts" --jq ".artifacts[] | select(.name | test(\"^gpr2-acceptance-.*-run${RUN}-a${ATTEMPT}\$\")) | .name" | head -1)"
[[ -n "$NAME" ]] || { echo "no sealed artifact for run $RUN attempt $ATTEMPT (expired or never produced)" >&2; exit 2; }
ART_ID="$(gh api "repos/$REPO/actions/runs/$RUN/artifacts" --jq ".artifacts[] | select(.name==\"$NAME\") | .id")"
DIGEST="$(gh api "repos/$REPO/actions/artifacts/$ART_ID" --jq '.digest // ""')"
gh run download "$RUN" -R "$REPO" -n "$NAME" -D "$WORK/sealed"
( cd "$WORK" && zip -qr "$NAME.zip" sealed )
WSHA="$(jq -r .github.workflow_sha "$WORK/sealed/acceptance-result.json")"
PROFILE="$(jq -r .profile.id "$WORK/sealed/acceptance-result.json")"
STAGE="$(jq -r .stage "$WORK/sealed/acceptance-result.json")"
git -C "$TOP" cat-file -e "$WSHA^{commit}" || git -C "$TOP" fetch -q origin "$WSHA"
# Verify with the profile AND the verifier exactly as they were at the run's workflow commit.
mkdir -p "$WORK/at-workflow-sha"
git -C "$TOP" archive "$WSHA" .github/acceptance | tar -x -C "$WORK/at-workflow-sha"
ACC="$WORK/at-workflow-sha/.github/acceptance"
node "$ACC/lib/verify-evidence.mjs" "$WORK/sealed" --profile "$ACC/profiles/$PROFILE.json" --expect-run "$RUN" | tee "$WORK/verify.log"
DEST="$TOP/docs/acceptance-evidence/$(echo "$STAGE" | tr '[:upper:]' '[:lower:]')/$PROFILE/run-$RUN-a$ATTEMPT"
mkdir -p "$DEST"
cp "$WORK/sealed/acceptance-result.json" "$WORK/sealed/SUMMARY.md" "$WORK/sealed/manifest.json" "$WORK/sealed/SHA256SUMS" "$DEST/"
ZIPSHA="$(sha256sum "$WORK/$NAME.zip" | cut -d' ' -f1)"
TAG="acceptance-evidence/$(echo "$STAGE" | tr '[:upper:]' '[:lower:]')/$PROFILE/run-$RUN-a$ATTEMPT"
cat > "$DEST/ARCHIVE.md" <<EOF
# Archived acceptance evidence — $STAGE / $PROFILE / run $RUN attempt $ATTEMPT

- Sealed artifact: \`$NAME\` (artifact id $ART_ID, GitHub digest \`${DIGEST:-not reported}\`)
- Run: https://github.com/$REPO/actions/runs/$RUN/attempts/$ATTEMPT
- Workflow SHA: \`$WSHA\`; candidate: \`$(jq -r .git.candidate_sha "$WORK/sealed/acceptance-result.json")\`
- Technical gate: \`$(jq -r .result.gate "$WORK/sealed/acceptance-result.json")\`
- Locally re-zipped package sha256: \`$ZIPSHA\` (zip bytes are not reproducible; the file-level SHA256SUMS here are authoritative)
- Durable copy of the full package (owner action): release tag \`$TAG\`
- Verified on $(date -u +%FT%TZ) with verify-evidence.mjs: $(tail -1 "$WORK/verify.log")
EOF
cp "$WORK/$NAME.zip" "$TOP/$NAME.zip"
echo
echo "Evidence index written to ${DEST#"$TOP"/} — commit it through a reviewed PR."
echo "Full package: $NAME.zip (repository root, untracked). To preserve it permanently (owner decision, needs contents: write):"
echo "  gh release create '$TAG' '$NAME.zip' -R $REPO --target $WSHA --title 'Acceptance evidence $STAGE $PROFILE run $RUN' --notes-file '${DEST#"$TOP"/}/ARCHIVE.md' --prerelease"
