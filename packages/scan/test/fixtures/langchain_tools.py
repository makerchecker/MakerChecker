from langchain.tools import tool, Tool, StructuredTool


@tool
def drop_table(table_name: str, cascade: bool = False):
    """Drop a database table and all of its rows."""
    run_sql(f"DROP TABLE {table_name}")


@tool("refund_customer")
def _issue_refund(customer_id: str, amount: float):
    """Issue a refund to a customer."""
    payments.refund(customer_id, amount)


web_search = Tool(
    name="web_search",
    func=do_search,
    description="Search the public web for a query.",
)

calc = StructuredTool.from_function(
    func=compute,
    name="run_calculation",
    description="Run an arbitrary numeric calculation.",
)


def not_a_tool(x, y):
    """A plain helper that should be ignored."""
    return x + y
