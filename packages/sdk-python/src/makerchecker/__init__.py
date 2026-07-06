"""MakerChecker Python SDK.

Govern AI-agent tool calls through a running MakerChecker server: deny-by-default
grants, segregation of duties, and a hash-chained, signed audit trail. This SDK
is a thin HTTP client plus the framework-agnostic ``governed_tool`` wrapper; the
server holds all the governance and audit logic.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

from ._client import ApiError, CheckResult, Client, create_client
from ._governance import GovernanceDeniedError, governed_tool

try:
    __version__ = version("makerchecker")
except PackageNotFoundError:  # running from a source checkout, not an install
    __version__ = "0.0.0"

__all__ = [
    "ApiError",
    "CheckResult",
    "Client",
    "GovernanceDeniedError",
    "create_client",
    "governed_tool",
]
