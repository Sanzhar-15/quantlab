"""
Job Execution Module.

Provides job execution framework for backtesting, optimization,
Monte Carlo simulation, and walk-forward analysis.

Spec Reference: Technical Spec §8, Phase 4 Action View MVP
"""

from .base import Job
from .base import JobCancelledException
from .base import JobConfig
from .base import JobContext
from .base import JobExecutor
from .base import JobStatus
from .base import JobType
from .base import generate_job_id
from .protocol import CancelRequest
from .protocol import CompleteMessage
from .protocol import FailedMessage
from .protocol import JobMessage
from .protocol import JobMessageType
from .protocol import JobResult
from .protocol import LogLevel
from .protocol import LogMessage
from .protocol import MetricValue
from .protocol import NDJSONParser
from .protocol import NDJSONWriter
from .protocol import ProgressMessage
from .protocol import RunRequest
from .backtest import BacktestConfig
from .backtest import BacktestJob
from .backtest import BacktestResult
from .backtest import Trade
from .optimize import OptimizeConfig
from .optimize import OptimizeJob
from .optimize import OptimizeResult
from .optimize import OptimizationRun
from .optimize import ParameterRange
from .montecarlo import MonteCarloConfig
from .montecarlo import MonteCarloJob
from .montecarlo import MonteCarloResult
from .montecarlo import DistributionStats
from .montecarlo import SimulationRun
from .wfa import WFAConfig
from .wfa import WFAJob
from .wfa import WFAResult
from .wfa import WFASplit

__all__ = [
    # Base classes
    "Job",
    "JobConfig",
    "JobContext",
    "JobExecutor",
    "JobStatus",
    "JobType",
    "JobCancelledException",
    "generate_job_id",
    # Protocol
    "JobMessage",
    "JobMessageType",
    "ProgressMessage",
    "LogMessage",
    "LogLevel",
    "CompleteMessage",
    "FailedMessage",
    "JobResult",
    "MetricValue",
    "RunRequest",
    "CancelRequest",
    "NDJSONParser",
    "NDJSONWriter",
    # Backtest
    "BacktestJob",
    "BacktestConfig",
    "BacktestResult",
    "Trade",
    # Optimize
    "OptimizeJob",
    "OptimizeConfig",
    "OptimizeResult",
    "OptimizationRun",
    "ParameterRange",
    # Monte Carlo
    "MonteCarloJob",
    "MonteCarloConfig",
    "MonteCarloResult",
    "DistributionStats",
    "SimulationRun",
    # Walk-Forward Analysis
    "WFAJob",
    "WFAConfig",
    "WFAResult",
    "WFASplit",
]
