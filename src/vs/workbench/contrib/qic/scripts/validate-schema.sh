#!/bin/bash
# QIC Schema Consistency Validation
# Run: bash scripts/validate-schema.sh
set -e

QIC_DIR="src/vs/workbench/contrib/qic"

echo "=== QIC Schema Consistency Validation ==="

# 1. No boolean permission returns (should use PermissionCheckResult)
echo -n "Check 1: No boolean permission returns... "
if grep -rE "check\w*\(.*\):\s*boolean" "$QIC_DIR/common/" --include="*.ts" | grep -v test | grep -v ".d.ts" | grep -q "permission\|Permission"; then
    echo "FAILED"
    exit 1
fi
echo "PASSED"

# 2. No AtomicMultiFileWriter references
echo -n "Check 2: No AtomicMultiFileWriter references... "
if grep -r "AtomicMultiFileWriter" "$QIC_DIR/common/" --include="*.ts" | grep -v test | grep -q .; then
    echo "FAILED"
    exit 1
fi
echo "PASSED"

# 3. No [STUB] warnings in security code
echo -n "Check 3: No [STUB] in security code... "
if grep -r "\[STUB\]" "$QIC_DIR/common/security/" --include="*.ts" | grep -q .; then
    echo "FAILED"
    exit 1
fi
echo "PASSED"

# 4. No renameSync in production code (anti-pattern #2)
echo -n "Check 4: No renameSync in production code... "
if grep -r "renameSync" "$QIC_DIR/common/" --include="*.ts" | grep -q .; then
    echo "FAILED"
    exit 1
fi
echo "PASSED"

# 5. Tool registry completeness (22 tools)
echo -n "Check 5: Tool registry completeness... "
npx ts-node "$QIC_DIR/scripts/validate-tool-registry.ts" > /dev/null 2>&1
echo "PASSED"

# 6. Lane configuration completeness
echo -n "Check 6: Lane configuration completeness... "
npx ts-node "$QIC_DIR/scripts/validate-lane-prompts.ts" > /dev/null 2>&1
echo "PASSED"

echo ""
echo "=== Schema validation passed ==="
