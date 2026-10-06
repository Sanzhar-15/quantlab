#!/bin/bash
# F-PACK-13 closing check (LOG-1): no secret value in a log line or thrown message on the encryption / secret-storage paths.
# Run: bash src/vs/platform/encryption/test/check-no-secret-in-logs.sh   (from any directory)
# rc 0 = no hit · rc 1 = hit(s), printed as file:line · rc 3 = a target file is missing · rc 2 = grep error.
#
# Class pattern: a SINK line (throw, Error(...), a log call, console.*) that also carries a value-bearing
# identifier in a LEAK position: a ${...} interpolation of the bare identifier (or its member chain), a bare
# call argument, a string concatenation operand, or a JSON.stringify argument.
# Identifier names (keys such as `key`/`fullKey`/`extensionId` are identifiers, not secrets, and are not listed):
# value(s), encrypted/decrypted(Value), ciphertext, plaintext, password, secret(Value), token, parsedValue, bufferToDecrypt.
# Limit: one line at a time; a log call whose leaking argument sits on a continuation line is not seen.
set -u

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"

TARGETS=(
	src/vs/platform/encryption/common/encryptionService.ts
	src/vs/platform/encryption/electron-main/encryptionMainService.ts
	src/vs/platform/secrets/common/secrets.ts
	src/vs/workbench/services/secrets/browser/secretStorageService.ts
	src/vs/workbench/services/secrets/electron-browser/secretStorageService.ts
	src/vs/workbench/services/encryption/browser/encryptionService.ts
	src/vs/workbench/services/encryption/electron-browser/encryptionService.ts
	src/vs/workbench/api/browser/mainThreadSecretState.ts
	src/vs/workbench/api/common/extHostSecretState.ts
	src/vs/workbench/api/common/extHostSecrets.ts
)

missing=0
for f in "${TARGETS[@]}"; do
	if [ ! -f "$ROOT/$f" ]; then
		echo "MISSING target: $f"
		missing=1
	fi
done
if [ "$missing" -ne 0 ]; then
	echo "RED: target file(s) missing (rc 3)"
	exit 3
fi

NB='[^A-Za-z0-9_$]'
IDS='(value|values|encrypted|decrypted|encryptedValue|decryptedValue|ciphertext|cipherText|plaintext|plainText|password|secret|secretValue|token|parsedValue|bufferToDecrypt)'
CHAIN='([.][A-Za-z0-9_$]+)*'
SINK='(throw[[:space:]]|Error\(|\.(trace|debug|info|warn|error|critical|log)\(|console\.)'
LEAK_INTERP="\\\$\\{[[:space:]]*${IDS}${CHAIN}[[:space:]]*\\}"
LEAK_ARG="[(,][[:space:]]*${IDS}${CHAIN}[[:space:]]*[,)]"
LEAK_CONCAT="(\\+[[:space:]]*${IDS}(${NB}|\$)|(^|${NB})${IDS}${CHAIN}[[:space:]]*\\+)"
LEAK_JSON="JSON\\.stringify\\([[:space:]]*${IDS}(${NB}|\$)"
LEAK="(${LEAK_INTERP}|${LEAK_ARG}|${LEAK_CONCAT}|${LEAK_JSON})"

hits=0
for f in "${TARGETS[@]}"; do
	sink_lines="$(grep -nE "$SINK" "$ROOT/$f")"
	rc=$?
	if [ "$rc" -eq 2 ]; then
		echo "grep error on $f (rc 2)"
		exit 2
	fi
	if [ "$rc" -eq 1 ]; then
		continue
	fi
	leak_lines="$(printf '%s\n' "$sink_lines" | grep -E "$LEAK")"
	rc=$?
	if [ "$rc" -eq 2 ]; then
		echo "grep error on $f (rc 2)"
		exit 2
	fi
	if [ "$rc" -eq 0 ]; then
		printf '%s\n' "$leak_lines" | sed "s|^|$f:|"
		hits=1
	fi
done

if [ "$hits" -ne 0 ]; then
	echo "RED: secret value in a log line or thrown message (rc 1)"
	exit 1
fi
echo "GREEN: ${#TARGETS[@]} target files present, 0 hits"
exit 0
