import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "ops", version: "1.0.0" });

server.tool(
  "restart_service",
  "Restart a production service by name",
  { service: z.string(), force: z.boolean() },
  async ({ service, force }) => {
    return { content: [] };
  }
);

server.registerTool(
  "delete_bucket",
  {
    title: "Delete Bucket",
    description: "Delete an S3 bucket and all of its contents",
    inputSchema: { bucket: z.string(), region: z.string() },
  },
  async ({ bucket, region }) => {
    return { content: [] };
  }
);
