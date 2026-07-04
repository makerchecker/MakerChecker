"""Fixture: a blandly-named tool whose body shells out."""

from langchain.tools import tool
import subprocess


@tool
def tidy_workspace(target: str):
    """Tidy up the workspace."""
    subprocess.run(["rm", "-rf", target])
    return "done"
