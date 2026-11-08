#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo_dir"
compose=(docker compose -f "$repo_dir/e2e/docker-compose.yml")
# Fixed project and ports mean two journeys must never share a sandbox.
exec 9>"${TMPDIR:-/tmp}/pi-hindsight-e2e.lock"
flock -n 9 || { echo "Another pi-hindsight-e2e journey is running" >&2; exit 1; }

for program in docker node flock; do
  command -v "$program" >/dev/null || { echo "Missing prerequisite: $program" >&2; exit 1; }
done
existing=$(docker ps -aq --filter label=com.docker.compose.project=pi-hindsight-e2e)
if [[ -n "$existing" ]]; then
  echo "Existing pi-hindsight-e2e containers found; inspect and remove that sandbox before replaying." >&2
  exit 1
fi
# Refuse occupied ports before creating resources; never stop their owners.
node --input-type=module <<'JS'
import { createServer } from 'node:net';
for (const port of [18890, 18891]) {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
JS

evidence_root=${E2E_EVIDENCE_DIR:-${TMPDIR:-/tmp}/pi-hindsight-e2e-evidence}
mkdir -p -- "$evidence_root"
evidence_root=$(cd -- "$evidence_root" && pwd)
export E2E_RUN_EVIDENCE_DIR
E2E_RUN_EVIDENCE_DIR=$(mktemp -d "$evidence_root/run-XXXXXXXX")
export E2E_TEMP_DIR
E2E_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-hindsight-e2e-XXXXXXXX")
export E2E_STUB_LOG="$E2E_RUN_EVIDENCE_DIR/stub-requests.jsonl"
# A local, gitignored llm.env gives the sandbox Hindsight a real LLM for digest generation.
export E2E_LLM=0
if [[ -f "$repo_dir/e2e/llm.env" ]]; then E2E_LLM=1; fi
stub_pid=
compose_started=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  set +e
  if [[ -d "$E2E_TEMP_DIR/agent" ]]; then
    cp -R -- "$E2E_TEMP_DIR/agent" "$E2E_RUN_EVIDENCE_DIR/agent"
  fi
  if [[ "$compose_started" == 1 ]]; then
    "${compose[@]}" logs --no-color >"$E2E_RUN_EVIDENCE_DIR/compose.log" 2>&1
    "${compose[@]}" ps -a --format json >"$E2E_RUN_EVIDENCE_DIR/compose-ps.json" 2>&1
    "${compose[@]}" down -v --timeout 10 >"$E2E_RUN_EVIDENCE_DIR/teardown.log" 2>&1
    if [[ $? != 0 ]]; then result=1; fi
  fi
  if [[ -n "$stub_pid" ]]; then
    kill "$stub_pid" 2>/dev/null
    wait "$stub_pid" 2>/dev/null
  fi
  rm -rf -- "$E2E_TEMP_DIR"
  echo "$result" >"$E2E_RUN_EVIDENCE_DIR/exit-code"
  echo "E2E exit $result; evidence preserved at $E2E_RUN_EVIDENCE_DIR"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Evidence must never contain the LLM credential from llm.env.
"${compose[@]}" config | sed -E 's/((API_KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*: ).*/\1"[REDACTED]"/' >"$E2E_RUN_EVIDENCE_DIR/compose-config.yml"
compose_started=1
"${compose[@]}" up -d >"$E2E_RUN_EVIDENCE_DIR/compose-up.log" 2>&1
node "$repo_dir/e2e/stub-llm-server.mjs" >"$E2E_RUN_EVIDENCE_DIR/stub.log" 2>&1 &
stub_pid=$!
node --input-type=module <<'JS'
import { poll } from './e2e/lib/assertions.mjs';
await poll('stub health', async () => {
  const response = await fetch('http://127.0.0.1:18891/health', { signal: AbortSignal.timeout(500) });
  return response.ok;
}, { timeoutMs: 5000, intervalMs: 100 });
JS
node "$repo_dir/e2e/journey.mjs" 2>&1 | tee "$E2E_RUN_EVIDENCE_DIR/journey.log"
