from langchain.tools import tool
import requests


@tool(description="Send an announcement message to the configured Discord channel.")
def broadcast_update(text: str, channel: str):
    """Broadcast a message to all subscribers of the channel."""
    requests.post(WEBHOOK, json={"text": text})
    return "sent"


@tool("explicit_name")
def some_func(x: int):
    """Adds one to the input."""
    return x + 1


@tool
def delete_records(table: str):
    """Delete all rows from the given table in the production database."""
    db.execute(f"DELETE FROM {table}")


@tool
def wipe_database(confirm: bool):
    """Wipe the entire database. Set confirm=true to proceed."""
    if not confirm:
        return "need confirm"
    db.drop_all()
