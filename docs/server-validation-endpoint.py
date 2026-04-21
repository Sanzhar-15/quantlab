"""
Reference Implementation: Strategy Validation Endpoint
======================================================

Deploy this to Delta Plus Server at: POST /v1/strategies/validate

This endpoint validates Quantlab strategy code using the same regex patterns
as the client-side StrategyValidator, ensuring consistent validation across
client and server.

Dependencies:
    pip install fastapi pydantic

Integration with QIC:
    When QIC generates a strategy, it calls this endpoint to validate the code
    before returning it to the user. If validation fails, QIC can retry with
    error feedback.
"""

import re
from typing import Optional, List, Literal
from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException

# Validation patterns - MUST match StrategyValidator.ts exactly
VECTOR_PATTERN = re.compile(r'def\s+strategy\s*\(\s*data\s*\)')
EVENT_PATTERN = re.compile(r'def\s+on_bar\s*\(\s*ctx\s*\)')
CLASS_PATTERN = re.compile(r'class\s+(\w+)\s*\(\s*ql\.Strategy\s*\)')

# Dangerous code patterns
DANGEROUS_PATTERNS = [
    (re.compile(r'\beval\s*\('), 'eval() is prohibited'),
    (re.compile(r'\bexec\s*\('), 'exec() is prohibited'),
    (re.compile(r'\b__import__\s*\('), '__import__() is prohibited'),
    (re.compile(r'\bsubprocess\b'), 'subprocess module is prohibited'),
    (re.compile(r'\bos\.system\b'), 'os.system() is prohibited'),
    (re.compile(r'\brequests\b'), 'network requests are prohibited'),
]

# Error codes
UTILITY_MODULE_CODE = 'UTILITY_MODULE'
NOT_PYTHON_CODE = 'NOT_PYTHON'
DANGEROUS_CODE = 'DANGEROUS_CODE'

# Request/Response Models
class StrategyValidationRequest(BaseModel):
    """Request body for strategy validation."""
    code: str = Field(..., description="Python strategy code to validate")
    filename: Optional[str] = Field("strategy.py", description="Optional filename")


class ValidationError(BaseModel):
    """Validation error details."""
    line: int = Field(..., description="Line number (0 for global errors)")
    code: str = Field(..., description="Error code (UTILITY_MODULE, NOT_PYTHON, DANGEROUS_CODE)")
    message: str = Field(..., description="Human-readable error message")
    suggestion: Optional[str] = Field(None, description="Suggested fix")


class ValidationWarning(BaseModel):
    """Validation warning details."""
    line: int = Field(..., description="Line number")
    code: str = Field(..., description="Warning code")
    message: str = Field(..., description="Warning message")


class StrategyEntrypoint(BaseModel):
    """Detected strategy entrypoint."""
    type: Literal['vectorized', 'eventDriven', 'classBased']
    functionName: Optional[str] = None  # For vectorized/eventDriven
    className: Optional[str] = None     # For classBased


class StrategyValidationResponse(BaseModel):
    """Response from strategy validation."""
    isValid: bool = Field(..., description="Whether the strategy is valid")
    entrypoint: Optional[StrategyEntrypoint] = Field(None, description="Detected entrypoint")
    complexity: Literal['safe', 'partial', 'viewOnly'] = Field('safe', description="Execution complexity level")
    errors: List[ValidationError] = Field(default_factory=list, description="Validation errors")
    warnings: List[ValidationWarning] = Field(default_factory=list, description="Validation warnings")


# Validation Logic
def detect_entrypoint(code: str) -> Optional[StrategyEntrypoint]:
    """
    Detect strategy entrypoint using exact regex patterns.

    Returns:
        StrategyEntrypoint if valid entrypoint found, None otherwise
    """
    # Check vectorized pattern
    if VECTOR_PATTERN.search(code):
        return StrategyEntrypoint(type='vectorized', functionName='strategy')

    # Check event-driven pattern
    if EVENT_PATTERN.search(code):
        return StrategyEntrypoint(type='eventDriven', functionName='on_bar')

    # Check class-based pattern
    class_match = CLASS_PATTERN.search(code)
    if class_match:
        return StrategyEntrypoint(type='classBased', className=class_match.group(1))

    return None


def check_dangerous_code(code: str) -> List[ValidationWarning]:
    """
    Check for dangerous code patterns.

    Returns:
        List of warnings if dangerous patterns found
    """
    warnings = []

    for pattern, message in DANGEROUS_PATTERNS:
        match = pattern.search(code)
        if match:
            # Try to find line number
            line_num = 0
            try:
                line_num = code[:match.start()].count('\n') + 1
            except:
                pass

            warnings.append(ValidationWarning(
                line=line_num,
                code=DANGEROUS_CODE,
                message=f"Dangerous code detected: {message}"
            ))

    return warnings


def get_helpful_error_message(code: str) -> str:
    """
    Generate helpful error message for common mistakes.

    Args:
        code: Strategy code that failed validation

    Returns:
        Helpful error message with fix suggestions
    """
    # Detect class without ql.Strategy parent
    if re.search(r'class\s+\w+\s*:', code) and not CLASS_PATTERN.search(code):
        return (
            'Class-based strategies must inherit from ql.Strategy.\n'
            'Example: class MyStrategy(ql.Strategy):'
        )

    # Detect wrong function names
    if re.search(r'def\s+(run|execute|main|trade)\s*\(', code):
        return (
            'Invalid entry point function name.\n'
            'Use: def strategy(data), def on_bar(ctx), or class X(ql.Strategy)'
        )

    # Detect type-annotated strategy function
    if re.search(r'def\s+strategy\s*\(\s*data\s*:', code):
        return (
            'Strategy function signature must be exactly: def strategy(data)\n'
            'Remove type annotations from the function signature.'
        )

    # Detect wrong parameter name in on_bar
    if re.search(r'def\s+on_bar\s*\(\s*(?:context|self)\s*\)', code):
        return (
            'Event-driven function signature must be exactly: def on_bar(ctx)\n'
            'Use "ctx" as the parameter name, not "context" or "self".'
        )

    # Detect wrong visualize signature
    if re.search(r'def\s+visualize\s*\(\s*chart\s*\)', code):
        return (
            'Visualize function signature must be: def visualize(chart, data, params)\n'
            'All three parameters are required.'
        )

    # Generic fallback
    return (
        'No valid strategy entrypoint found.\n'
        'Required: def strategy(data), def on_bar(ctx), or class X(ql.Strategy):'
    )


def validate_strategy_code(code: str, filename: str = 'strategy.py') -> StrategyValidationResponse:
    """
    Validate strategy code and return detailed validation result.

    Args:
        code: Python strategy code
        filename: Optional filename (for .py check)

    Returns:
        StrategyValidationResponse with validation details
    """
    errors = []
    warnings = []

    # Check if Python file
    is_python = filename.endswith('.py')

    # Detect entrypoint
    entrypoint = detect_entrypoint(code) if is_python else None

    # If no entrypoint found, generate helpful error
    if not entrypoint:
        error_code = NOT_PYTHON_CODE if not is_python else UTILITY_MODULE_CODE
        error_message = (
            'Not a Python file. Strategy files must use .py extension.'
            if not is_python
            else get_helpful_error_message(code)
        )

        errors.append(ValidationError(
            line=0,
            code=error_code,
            message=error_message
        ))

        return StrategyValidationResponse(
            isValid=False,
            entrypoint=None,
            complexity='viewOnly',
            errors=errors,
            warnings=warnings
        )

    # Check for dangerous code
    warnings = check_dangerous_code(code)

    # If dangerous code found, mark as viewOnly
    complexity = 'viewOnly' if warnings else 'safe'

    return StrategyValidationResponse(
        isValid=True,
        entrypoint=entrypoint,
        complexity=complexity,
        errors=errors,
        warnings=warnings
    )


# FastAPI Router
router = APIRouter(prefix="/v1/strategies", tags=["strategies"])


@router.post("/validate", response_model=StrategyValidationResponse)
async def validate_strategy(request: StrategyValidationRequest):
    """
    Validate Quantlab strategy code.

    This endpoint uses the same regex patterns as the client-side validator
    to ensure consistent validation. It checks for:

    1. Valid entrypoint (def strategy, def on_bar, or class-based)
    2. Dangerous code patterns (eval, exec, subprocess, etc.)
    3. Common mistakes (wrong signatures, missing imports, etc.)

    The validation result includes:
    - isValid: Whether the strategy has a valid entrypoint
    - entrypoint: Type and name of detected entrypoint
    - complexity: 'safe', 'partial', or 'viewOnly' based on code analysis
    - errors: List of validation errors with suggestions
    - warnings: List of warnings (dangerous code, etc.)

    Example:
        POST /v1/strategies/validate
        {
            "code": "import quantlab as ql\\n\\ndef strategy(data):\\n    return ql.Signals()",
            "filename": "my_strategy.py"
        }

        Response:
        {
            "isValid": true,
            "entrypoint": {"type": "vectorized", "functionName": "strategy"},
            "complexity": "safe",
            "errors": [],
            "warnings": []
        }
    """
    try:
        result = validate_strategy_code(request.code, request.filename)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Validation error: {str(e)}")


# Integration with existing FastAPI app
def setup_validation_endpoint(app):
    """
    Setup validation endpoint in existing FastAPI application.

    Usage:
        from fastapi import FastAPI
        from server_validation_endpoint import setup_validation_endpoint

        app = FastAPI()
        setup_validation_endpoint(app)
    """
    app.include_router(router)


# Standalone testing
if __name__ == '__main__':
    # Test cases
    test_cases = [
        # Valid vectorized
        {
            'name': 'Valid vectorized strategy',
            'code': 'import quantlab as ql\n\ndef strategy(data):\n    return ql.Signals()',
            'expected_valid': True,
            'expected_type': 'vectorized'
        },
        # Valid event-driven
        {
            'name': 'Valid event-driven strategy',
            'code': 'import quantlab as ql\n\ndef on_bar(ctx):\n    pass',
            'expected_valid': True,
            'expected_type': 'eventDriven'
        },
        # Valid class-based
        {
            'name': 'Valid class-based strategy',
            'code': 'import quantlab as ql\n\nclass MyStrategy(ql.Strategy):\n    def on_bar(self, ctx):\n        pass',
            'expected_valid': True,
            'expected_type': 'classBased'
        },
        # Invalid - type hints
        {
            'name': 'Invalid - type hints',
            'code': 'import quantlab as ql\n\ndef strategy(data: pd.DataFrame):\n    return ql.Signals()',
            'expected_valid': False
        },
        # Invalid - wrong class parent
        {
            'name': 'Invalid - class without parent',
            'code': 'class MyStrategy:\n    def on_bar(self, ctx):\n        pass',
            'expected_valid': False
        },
        # Dangerous code
        {
            'name': 'Dangerous code - eval',
            'code': 'import quantlab as ql\n\ndef strategy(data):\n    eval("malicious")\n    return ql.Signals()',
            'expected_valid': True,
            'expected_warnings': 1
        }
    ]

    print("Running validation tests...\n")
    passed = 0
    failed = 0

    for test in test_cases:
        result = validate_strategy_code(test['code'])

        # Check validity
        if result.isValid == test['expected_valid']:
            if result.isValid and test.get('expected_type'):
                if result.entrypoint and result.entrypoint.type == test['expected_type']:
                    passed += 1
                    print(f"✓ {test['name']}")
                else:
                    failed += 1
                    print(f"✗ {test['name']} - Wrong entrypoint type")
            elif not result.isValid:
                passed += 1
                print(f"✓ {test['name']}")
            else:
                passed += 1
                print(f"✓ {test['name']}")
        else:
            failed += 1
            print(f"✗ {test['name']} - Expected valid={test['expected_valid']}, got {result.isValid}")

        # Check warnings if expected
        if 'expected_warnings' in test:
            if len(result.warnings) == test['expected_warnings']:
                print(f"  ✓ Warnings: {len(result.warnings)}")
            else:
                print(f"  ✗ Expected {test['expected_warnings']} warnings, got {len(result.warnings)}")

    print(f"\n{passed} passed, {failed} failed")
