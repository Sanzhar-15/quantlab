#!/bin/bash
# Self-test of check-no-secret-in-logs.sh (F-PACK-13 closing check 7). Builds synthetic copies of the gate's 10 target
# files in a `mktemp -d` tree (honours TMPDIR; kept, never deleted, path printed), copies the gate beside them, and runs it:
# every MUTATION case must make the gate fail with rc 1 naming the mutated file (and, for rule B, a `caught-error` line);
# every CLEAN case must pass with rc 0; precondition cases must give rc 3 (missing target) or rc 2 (tool error).
# It never reads the product files, so its result does not depend on the product's state.
# Run: bash src/vs/platform/encryption/test/check-no-secret-in-logs.selftest.sh   → rc 0 all cases as expected, rc 1 not.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/check-no-secret-in-logs.sh"
if [ ! -f "$GATE" ]; then
	echo "SELFTEST ERROR: gate not found at $GATE"
	exit 2
fi
WORK="$(mktemp -d)"
if [ ! -d "$WORK" ]; then
	echo "SELFTEST ERROR: mktemp -d failed"
	exit 2
fi
echo "fixtures: $WORK (kept)"

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
EMS=src/vs/platform/encryption/electron-main/encryptionMainService.ts
SEC=src/vs/platform/secrets/common/secrets.ts
# Catch scopes in the clean fixture: EMS 3 (keychainCall, decrypt, getKeyStorageProvider) + SEC 2 + one promise .catch.
CLEAN_SCOPES=6

# Placeholders: E (inside `catch (e)` of keychainCall), DEC (inside decrypt's `catch (e)`), ERR (inside `catch (err)` of
# secrets.get), K (inside `catch (keychainFailure)` of secrets.set), TOP (a method body, no catch), HELPER (errorClassOf's
# class line).
ems_text() {
	cat <<'TS'
import { ILogService } from '../../log/common/log.js';

function errorClassOf(error: unknown): string {
	if (error instanceof Error) {
		@@HELPER@@
	}
	return `non-Error ${typeof error}`;
}

export class EncryptionMainServiceWithElectron {
	constructor(private readonly safeStorage: SafeStorage, private readonly logService: ILogService) { }

	private keychainCall<T>(operation: string, call: () => T): T {
		this.logService.info(`[EncryptionMainService] keychain: ${operation} start`);
		try {
			return call();
		} catch (e) {
			const errorClass = errorClassOf(e);
			this.logService.error(`[EncryptionMainService] ${operation} failed (${errorClass})`);
			@@E@@
			throw new Error(`[EncryptionMainService] ${operation} failed (${errorClass})`);
		}
	}

	async decrypt(value: string): Promise<string> {
		let bufferToDecrypt: Buffer;
		try {
			const parsedValue: { data: string } = JSON.parse(value);
			bufferToDecrypt = Buffer.from(parsedValue.data);
		} catch (e) {
			// A JSON.parse SyntaxError quotes its input: only the class is logged. this.logService.error(e); `${e}`
			const doc = 'this.logService.error(e) ${e} String(e) { cause: e }';
			if (/[`{}(]+/.test(doc) && e instanceof SyntaxError) {
				this.logService.error(`[EncryptionMainService] Invalid encrypted value (${e instanceof Error ? e.name : typeof e})`);
			}
			@@DEC@@
			throw new Error('[EncryptionMainService] Invalid encrypted value');
		}
		return this.keychainCall('decryptString', () => this.safeStorage.decryptString(bufferToDecrypt));
	}

	getKeyStorageProvider(): string {
		try {
			return this.safeStorage.getSelectedStorageBackend();
		} catch (e) {
			this.logService.error(`[EncryptionMainService] backend failed (${e?.constructor.name})`);
			return 'unknown';
		}
	}

	probe(): Promise<void> {
		@@TOP@@
		return this.safeStorage.probe().catch(failure => {
			this.logService.warn(`[EncryptionMainService] probe failed (${errorClassOf(failure)})`);
		});
	}
}
TS
}

sec_text() {
	cat <<'TS'
export class BaseSecretStorageService {
	get(key: string): Promise<string | undefined> {
		return this._sequencer.queue(key, async () => {
			const fullKey = this.getKey(key);
			this._logService.trace('[secrets] getting secret for key:', fullKey);
			try {
				return await this._encryptionService.decrypt(this.storage.get(fullKey));
			} catch (err) {
				if (isCancellationError(err)) {
					return undefined;
				}
				@@ERR@@
				this._logService.error(`[secrets] decrypt failed (${err instanceof Error ? err.name : typeof err})`);
				throw err;
			}
		});
	}

	set(key: string, value: string): Promise<void> {
		return this._sequencer.queue(key, async () => {
			let encrypted;
			try {
				encrypted = await this._encryptionService.encrypt(value);
			} catch (keychainFailure) {
				@@K@@
				throw new Error('[secrets] encrypt failed');
			}
			this.storage.store(this.getKey(key), encrypted);
		});
	}
}
TS
}

plain_text() {
	cat <<'TS'
export function parseKey(key: string): { extensionId: string; key: string } | undefined {
	try {
		return JSON.parse(key);
	} catch {
		return undefined;
	}
}
TS
}

# build <dir> <E> <DEC> <ERR> <K> <TOP> <HELPER>: writes the fixture tree and the gate copy.
build() {
	local dir="$1"
	local f t
	mkdir -p "$dir/src/vs/platform/encryption/test" || return 2
	cp "$GATE" "$dir/src/vs/platform/encryption/test/check-no-secret-in-logs.sh" || return 2
	for f in "${TARGETS[@]}"; do
		mkdir -p "$dir/$(dirname "$f")" || return 2
		case "$f" in
			"$EMS") t="$(ems_text)" ;;
			"$SEC") t="$(sec_text)" ;;
			*) t="$(plain_text)" ;;
		esac
		t="${t//@@E@@/"$2"}"
		t="${t//@@DEC@@/"$3"}"
		t="${t//@@ERR@@/"$4"}"
		t="${t//@@K@@/"$5"}"
		t="${t//@@TOP@@/"$6"}"
		t="${t//@@HELPER@@/"$7"}"
		printf '%s\n' "$t" >"$dir/$f" || return 2
	done
}

HELPER_OK='return error.constructor.name;'
pass=0
failed=0
n=0

# case <name> <expect rc> <expect file or -> <expect tag or -> <E> <DEC> <ERR> <K> <TOP> <HELPER> [skip-target]
case_run() {
	local name="$1" want="$2" wfile="$3" wtag="$4"
	n=$((n + 1))
	local dir="$WORK/case-$n"
	if ! build "$dir" "$5" "$6" "$7" "$8" "$9" "${10}"; then
		echo "FAIL $name: fixture build error"
		failed=$((failed + 1))
		return
	fi
	if [ -n "${11-}" ]; then
		mv "$dir/${11}" "$dir/${11}.absent" || { echo "FAIL $name: could not hide target"; failed=$((failed + 1)); return; }
	fi
	local out rc
	out="$(bash "$dir/src/vs/platform/encryption/test/check-no-secret-in-logs.sh" 2>&1)"
	rc=$?
	local ok=1
	[ "$rc" -eq "$want" ] || ok=0
	if [ "$wfile" != "-" ] && ! printf '%s\n' "$out" | grep -qF "$wfile:"; then ok=0; fi
	if [ "$wtag" != "-" ] && ! printf '%s\n' "$out" | grep -qF "$wtag"; then ok=0; fi
	if [ "$ok" -eq 1 ]; then
		echo "PASS $name (rc $rc)"
		pass=$((pass + 1))
	else
		echo "FAIL $name: rc $rc (want $want); output:"
		printf '%s\n' "$out" | sed 's/^/    | /'
		failed=$((failed + 1))
	fi
}

# ---- clean cases: rc 0 ----
case_run "clean baseline (class-only logging, tokenizer traps in comment/string/regex)" 0 - "$CLEAN_SCOPES catch scopes walked" "" "" "" "" "" "$HELPER_OK"
case_run "clean instanceof/name/typeof guard in a log" 0 - - 'this.logService.error(`[x] failed (${e instanceof Error ? e.name : typeof e})`);' "" "" "" "" "$HELPER_OK"
case_run "clean errorClassOf alias interpolated and thrown" 0 - - 'const cls = errorClassOf(e); this.logService.warn(`[x] (${cls})`); throw new Error(`[x] (${cls})`, { cause: cls });' "" "" "" "" "$HELPER_OK"
case_run "clean predicate + rethrow (rethrow is outside the rule)" 0 - - "" "" 'if (isCancellationError(err)) { throw err; }' "" "" "$HELPER_OK"
case_run "clean non-error identifiers in logs" 0 - - "" "" "" "this._logService.trace('[secrets] encrypt failed for key:', key);" "" "$HELPER_OK"

# ---- mutation cases: rc 1 ----
case_run "MUT raw logService.error(e)" 1 "$EMS" "caught-error log call" 'this.logService.error(e);' "" "" "" "" "$HELPER_OK"
case_run "MUT \${e} interpolation in a thrown Error" 1 "$EMS" "caught-error" 'throw new Error(`${e}`);' "" "" "" "" "$HELPER_OK"
case_run "MUT String(err)" 1 "$SEC" "caught-error String()" "" "" 'const message = String(err); void message;' "" "" "$HELPER_OK"
case_run "MUT new Error(msg, { cause: e })" 1 "$EMS" "caught-error Error cause" "" 'throw new Error(msg, { cause: e });' "" "" "" "$HELPER_OK"
case_run "MUT \${value} in decrypt's error (rule A)" 1 "$EMS" 'Invalid encrypted value: ${value}' "" 'throw new Error(`[EncryptionMainService] Invalid encrypted value: ${value}`);' "" "" "" "$HELPER_OK"
case_run "MUT any binding name: keychainFailure.message to warn" 1 "$SEC" "caught-error log call" "" "" "" "this._logService.warn('[secrets] encrypt failed', keychainFailure.message);" "" "$HELPER_OK"
case_run "MUT multi-line log call" 1 "$EMS" "caught-error log call" "$(printf 'this.logService.error(\n\t\t\t\t\x27[x] failed\x27,\n\t\t\t\te\n\t\t\t);')" "" "" "" "" "$HELPER_OK"
case_run "MUT destructured message tainted" 1 "$SEC" "caught-error interpolation" "" "" 'const { message } = err; this._logService.error(`[secrets] ${message}`);' "" "" "$HELPER_OK"
case_run "MUT string concatenation" 1 "$EMS" "caught-error string concatenation" 'const text = "[x] failed: " + e; void text;' "" "" "" "" "$HELPER_OK"
case_run "MUT e.toString()" 1 "$EMS" "caught-error toString()" 'const text = e.toString(); void text;' "" "" "" "" "$HELPER_OK"
case_run "MUT cause assignment" 1 "$SEC" "caught-error Error cause" "" "" "" 'const wrapped = new Error("x"); wrapped.cause = keychainFailure; throw wrapped;' "" "$HELPER_OK"
case_run "MUT e.message beside errorClassOf in an interpolation" 1 "$EMS" "caught-error" 'this.logService.error(`[x] ${errorClassOf(e)} ${e.message}`);' "" "" "" "" "$HELPER_OK"
case_run "MUT promise .catch(error => log(error))" 1 "$EMS" "caught-error log call" "" "" "" "" 'void this.safeStorage.probe().catch(error => this.logService.error(error));' "$HELPER_OK"
case_run "MUT .then(ok, (rejection) => \`\${rejection}\`)" 1 "$EMS" "caught-error interpolation" "" "" "" "" 'void this.safeStorage.probe().then(() => undefined, (rejection) => { throw new Error(`[x] ${rejection}`); });' "$HELPER_OK"
case_run "MUT .catch(onUnexpectedError) handler" 1 "$EMS" "rejection handler not an inline function" "" "" "" "" 'void this.safeStorage.probe().catch(onUnexpectedError);' "$HELPER_OK"
case_run "MUT errorClassOf body returns the message" 1 "$EMS" "errorClassOf: body is not the pinned" "" "" "" "" "" 'return error.message;'

# ---- precondition cases ----
case_run "PRE missing target → rc 3" 3 - "MISSING target: $SEC" "" "" "" "" "" "$HELPER_OK" "$SEC"
case_run "PRE untokenizable target → rc 2, never no-hits" 2 - "walker: cannot analyse" '/* a block comment never closed' "" "" "" "" "$HELPER_OK"

# node absent: PATH holds only the tools the gate needs besides node.
n=$((n + 1))
nodir="$WORK/case-$n"
if build "$nodir" "" "" "" "" "" "$HELPER_OK" && mkdir -p "$nodir/bin"; then
	tools_ok=1
	for tool in dirname grep sed tail; do
		p="$(type -P "$tool")"
		if [ -z "$p" ]; then tools_ok=0; break; fi
		ln -s "$p" "$nodir/bin/$tool" || { tools_ok=0; break; }
	done
	if [ "$tools_ok" -eq 1 ]; then
		out="$(PATH="$nodir/bin" "$(type -P bash)" "$nodir/src/vs/platform/encryption/test/check-no-secret-in-logs.sh" 2>&1)"
		rc=$?
		if [ "$rc" -eq 2 ] && printf '%s\n' "$out" | grep -qF "node not found"; then
			echo "PASS PRE node absent → rc 2 (rc $rc)"
			pass=$((pass + 1))
		else
			echo "FAIL PRE node absent: rc $rc (want 2); output:"
			printf '%s\n' "$out" | sed 's/^/    | /'
			failed=$((failed + 1))
		fi
	else
		echo "FAIL PRE node absent: could not stage the tool PATH"
		failed=$((failed + 1))
	fi
else
	echo "FAIL PRE node absent: fixture build error"
	failed=$((failed + 1))
fi

if [ "$failed" -ne 0 ]; then
	echo "SELFTEST RED: $failed of $n cases not as expected"
	exit 1
fi
echo "SELFTEST GREEN: $pass of $n cases as expected"
exit 0
