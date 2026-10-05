"""Entry point of the bundled (PyInstaller) Quantlab engine.

A frozen executable has no `-m`, yet the extension starts every engine job as
`<engine> -m <module>` (extensions/quantlab/src/core/engine/JobRunner.ts). This entry
gives the bundle that form for the modules it carries:

    quantlab-engine -m quantlab.cli.run_backtest   # runs that module as __main__
    quantlab-engine start|status|stop ...          # the daemon CLI (quantlab.daemon)

A module the bundle does not carry is refused by name (exit 2); nothing is substituted.
"""

import runpy
import sys

# Modules runnable with -m. Each is also in bundle.py's HIDDEN_IMPORTS.
RUNNABLE_MODULES = ("quantlab.cli.run_backtest",)


def main() -> int:
    args = sys.argv[1:]
    if args[:1] != ["-m"]:
        from quantlab.daemon.__main__ import main as daemon_main

        return daemon_main()
    if len(args) < 2:
        sys.stderr.write("quantlab-engine: -m needs a module name\n")
        return 2
    module = args[1]
    if module not in RUNNABLE_MODULES:
        sys.stderr.write(
            f"quantlab-engine: module '{module}' is not in this bundle"
            f" (runnable with -m: {', '.join(RUNNABLE_MODULES)})\n"
        )
        return 2
    sys.argv = [module, *args[2:]]
    runpy.run_module(module, run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
