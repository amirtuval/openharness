#!/usr/bin/env bash
#
# Smoke test a deployed openharness environment, with retries (issue #155, epic #148).
#
# Run after the rollout has completed — the pod being ready is not the same as the
# environment answering, because on a first deploy the Google-managed certificate is
# still being issued and the domain may not resolve yet. So every probe is retried with
# backoff until the deadline, and the deadline **fails** rather than hanging: a workflow
# that waits forever tells nobody anything.
#
# What it asserts, and why each one:
#
#   /health       200   the process is alive.
#   /ready        200   it can take traffic — this one answers 503 while the store is
#                       unreachable, so it is the probe that catches a bad database-url.
#   /             HTML  the built web app is being served at the root, not a 404 or the
#                       API's JSON.
#   /v1/sessions  401   the API is up and the auth guard is in front of it. Asserted
#                       rather than "not 200": a request that never reached the app
#                       (404 from the load balancer, 502 from a missing backend) is a
#                       different failure and must not pass.
#
# Usage:
#   .github/scripts/smoke-test.sh https://staging.oharness.dev [timeout-seconds]
#
# Exit status: 0 once every probe passes, 1 on the deadline. Writes a table of the last
# attempt to the GitHub step summary when it runs under Actions.

set -euo pipefail

BASE_URL="${1:?usage: smoke-test.sh <base-url> [timeout-seconds]}"
TIMEOUT="${2:-900}"
INTERVAL="${SMOKE_TEST_INTERVAL:-15}"
# Trailing slashes would double up in the probe URLs.
BASE_URL="${BASE_URL%/}"

DEADLINE=$((SECONDS + TIMEOUT))
ATTEMPT=0
PASSED=false
# Initialised so the failure report below still reads correctly if the loop never runs
# (a zero or negative timeout) — `set -u` would otherwise abort on an unset variable.
health=000
ready=000
root_type=''
sessions=000

# `-k` is deliberately absent: a certificate that does not validate for the domain is a
# failure this test exists to catch. `--max-time` keeps one hung connection from eating
# the whole deadline, and `|| echo 000` turns curl's own failure into the same shape as a
# response that never arrived.
probe_status() {
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 10 "$1" 2>/dev/null || echo '000'
}

probe_content_type() {
  curl --silent --show-error --output /dev/null --write-out '%{content_type}' \
    --max-time 10 "$1" 2>/dev/null || echo ''
}

echo "Smoke testing $BASE_URL (up to ${TIMEOUT}s, every ${INTERVAL}s)."

while ((SECONDS < DEADLINE)); do
  ATTEMPT=$((ATTEMPT + 1))

  health="$(probe_status "$BASE_URL/health")"
  ready="$(probe_status "$BASE_URL/ready")"
  root_type="$(probe_content_type "$BASE_URL/")"
  sessions="$(probe_status "$BASE_URL/v1/sessions")"

  echo "attempt $ATTEMPT: /health=$health /ready=$ready /='${root_type:-none}' /v1/sessions=$sessions"

  if [[ $health == 200 && $ready == 200 && $root_type == text/html* && $sessions == 401 ]]; then
    PASSED=true
    break
  fi

  sleep "$INTERVAL"
done

if [[ $PASSED == true ]]; then
  echo "$BASE_URL is healthy (after ${ATTEMPT} attempt(s))."
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    {
      echo "### Smoke test passed"
      echo
      echo "\`$BASE_URL\` answered on attempt $ATTEMPT: \`/health\` 200, \`/ready\` 200, \`/\` HTML, \`/v1/sessions\` 401."
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

echo "::error title=Smoke test failed::$BASE_URL did not become healthy within ${TIMEOUT}s."

last="attempt $ATTEMPT: /health=$health /ready=$ready /='${root_type:-none}' /v1/sessions=$sessions"
echo "Last observed: $last"

if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  cat >>"$GITHUB_STEP_SUMMARY" <<EOF
### Smoke test failed

\`$BASE_URL\` did not answer correctly within ${TIMEOUT}s.

| Probe           | Expected        | Last observed        |
| --------------- | --------------- | -------------------- |
| \`/health\`     | 200             | \`${health}\`        |
| \`/ready\`      | 200             | \`${ready}\`         |
| \`/\`           | HTML            | \`${root_type:-none}\` |
| \`/v1/sessions\` | 401 unauthenticated | \`${sessions}\` |

On a **first** deploy this is usually DNS or the certificate, not the app: the
Google-managed certificate is only issued once the domain resolves to the load balancer,
which can take longer than this test waits. Check where the domain points, then:

\`\`\`bash
gcloud container clusters get-credentials openharness --region us-central1 --project <project-id>
kubectl -n openharness get managedcertificate,ingress
kubectl -n openharness describe managedcertificate openharness
\`\`\`

If the certificate is \`Provisioning\` and DNS is already correct, re-run the deploy
(\`workflow_dispatch\`) rather than changing anything — it re-checks the same build.
EOF
fi

exit 1
