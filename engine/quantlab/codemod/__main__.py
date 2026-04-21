"""
CodeMod Subprocess Entry Point.

Allows running the codemod module as a subprocess:
    python -m quantlab.codemod

Spec Reference: Technical Spec §20.5, Phase 6 Code Modification Contract
"""

import sys

from .handler import main

if __name__ == "__main__":
    sys.exit(main())
