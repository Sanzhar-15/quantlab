# CI/CD Pipeline Fixes

---

## FIX-CI001: Engine PR Workflow Missing (P1 - High)

**File**: `.github/workflows/engine-pr.yml` (MISSING)
**Issue**: No PR validation workflow for the Python engine. Changes to engine code are not automatically tested.

**Fix**: Create comprehensive PR workflow:
```yaml
name: Engine PR Validation

on:
  pull_request:
    paths:
      - 'engine/**'
      - '.github/workflows/engine-pr.yml'

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.11", "3.12"]

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python ${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}

      - name: Install dependencies
        run: |
          cd engine
          pip install -e ".[dev,test]"

      - name: Lint with ruff
        run: |
          cd engine
          ruff check quantlab tests

      - name: Type check with pyright
        run: |
          cd engine
          pyright quantlab

      - name: Run unit tests
        run: |
          cd engine
          pytest -v --cov=quantlab --cov-report=xml tests/

      - name: Run golden tests
        run: |
          cd engine
          pytest -v -m golden tests/golden/

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: engine/coverage.xml
          fail_ci_if_error: false

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Bandit
        run: pip install bandit

      - name: Run security scan
        run: |
          cd engine
          bandit -r quantlab -ll -ii
```

---

## FIX-CI002: Benchmark Regression Check Not Implemented (P1 - High)

**File**: `.github/workflows/engine-benchmark.yml`
**Issue**: Lines 53-57 contain TODO placeholder for regression check.

**Fix**: Implement the regression check step:
```yaml
- name: Check regression (vs main)
  id: regression
  run: |
    cd engine

    # Download baseline from artifacts (if exists)
    if gh run download --name benchmark-baseline -D baseline/ 2>/dev/null; then
      echo "Baseline found, comparing..."
      python -m benchmarks.check \
        --baseline baseline/benchmark-results.json \
        --current benchmark-results.json \
        --threshold small:1.5,medium:1.5,large:1.25,multi:1.5 \
        --output regression-report.json

      if [ $? -ne 0 ]; then
        echo "regression_detected=true" >> $GITHUB_OUTPUT
      fi
    else
      echo "No baseline found (first run on this branch)"
      echo "regression_detected=false" >> $GITHUB_OUTPUT
    fi
  env:
    GH_TOKEN: ${{ github.token }}

- name: Upload baseline for future comparisons
  if: github.ref == 'refs/heads/main'
  uses: actions/upload-artifact@v4
  with:
    name: benchmark-baseline
    path: engine/benchmark-results.json
    retention-days: 30

- name: Comment on PR if regression
  if: steps.regression.outputs.regression_detected == 'true' && github.event_name == 'pull_request'
  uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const report = JSON.parse(fs.readFileSync('engine/regression-report.json', 'utf8'));

      let comment = '## ⚠️ Benchmark Regression Detected\n\n';
      for (const [name, data] of Object.entries(report.regressions)) {
        comment += `- **${name}**: ${data.current_p95}s (was ${data.baseline_p95}s, +${data.change_pct}%)\n`;
      }

      github.rest.issues.createComment({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        body: comment
      });
```

---

## FIX-CI003: Security Scanning Workflow Missing (P2 - Medium)

**File**: `.github/workflows/engine-security.yml` (MISSING)
**Issue**: No automated security scanning for vulnerabilities.

**Fix**: Create security workflow:
```yaml
name: Security Scan

on:
  push:
    branches: [main]
    paths:
      - 'engine/**'
  pull_request:
    paths:
      - 'engine/**'
  schedule:
    - cron: '0 6 * * 1'  # Weekly on Monday at 6 AM

jobs:
  bandit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Bandit
        run: pip install bandit

      - name: Run Bandit security scan
        run: |
          cd engine
          bandit -r quantlab -f json -o bandit-report.json || true

      - name: Upload Bandit report
        uses: actions/upload-artifact@v4
        with:
          name: bandit-report
          path: engine/bandit-report.json

      - name: Fail on high severity issues
        run: |
          cd engine
          bandit -r quantlab -ll -ii  # -ll = low and below ignored, -ii = medium confidence and below ignored

  dependency-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install safety
        run: pip install safety

      - name: Check dependencies for vulnerabilities
        run: |
          cd engine
          pip install -e .
          safety check --full-report

  secrets-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## FIX-CI004: Memory Profiling Job Is Placeholder (P2 - Medium)

**File**: `.github/workflows/engine-benchmark.yml`
**Issue**: The `memory-profile` job is entirely a placeholder.

**Fix**: Implement memory profiling:
```yaml
memory-profile:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Set up Python
      uses: actions/setup-python@v5
      with:
        python-version: "3.11"

    - name: Install dependencies
      run: |
        cd engine
        pip install -e ".[dev,benchmark]"
        pip install memray

    - name: Generate benchmark data
      run: |
        cd engine
        python -m benchmarks.data.generate_data

    - name: Profile backtest memory usage
      run: |
        cd engine
        memray run -o backtest-memory.bin python -c "
        from benchmarks.runner import BenchmarkRunner
        runner = BenchmarkRunner()
        runner.run_by_name('bench_medium')
        "

    - name: Generate memory report
      run: |
        cd engine
        memray flamegraph backtest-memory.bin -o memory-flamegraph.html
        memray summary backtest-memory.bin > memory-summary.txt

    - name: Check memory threshold
      run: |
        cd engine
        peak_mb=$(memray stats backtest-memory.bin | grep "Peak" | awk '{print $3}')
        echo "Peak memory: ${peak_mb} MB"

        # Fail if peak memory exceeds 500 MB for medium benchmark
        if (( $(echo "$peak_mb > 500" | bc -l) )); then
          echo "ERROR: Memory usage exceeds 500 MB threshold"
          exit 1
        fi

    - name: Upload memory reports
      uses: actions/upload-artifact@v4
      with:
        name: memory-profile
        path: |
          engine/memory-flamegraph.html
          engine/memory-summary.txt
```
