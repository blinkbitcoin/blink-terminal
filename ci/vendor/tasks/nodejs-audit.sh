#!/bin/bash

#! Auto synced from Shared CI Resources repository
#! Don't change this file, instead change it in github.com/blinkbitcoin/concourse-shared

set -eu

REPO_ROOT=${REPO_ROOT:-./}
LEVEL=${LEVEL:-high}

pushd ${REPO_ROOT}

if [[ -f ./pnpm-lock.yaml ]] && [[ ! -f ./yarn.lock ]]; then
  # pnpm applies --audit-level itself and exits non-zero when it finds
  # anything at or above that level (or cannot complete the audit), so its
  # exit code is the verdict. It is not a yarn severity bitmask: pnpm exits 1,
  # which the bitmask check below would read as "no high findings".
  pnpm audit --prod --audit-level="${LEVEL}" || exit 1
  exit 0
fi

set +e
if [[ -f ./yarn.lock ]]; then
  yarn audit --groups dependencies --level ${LEVEL}
else
  echo "Failed audit: Unsupported PckgMgr"
  exit 2
fi

audit_return=$?
set -e

# yarn classic exits with a bitmask of the severities found.
# See https://classic.yarnpkg.com/lang/en/docs/cli/audit for explanation of exit codes
if [[ ${LEVEL} == "critical" ]] && [[ ${audit_return} -ge 16 ]]; then
  exit 1
elif [[ ${LEVEL} == "high" ]] && [[ ${audit_return} -ge 8 ]]; then
  exit 1
fi
