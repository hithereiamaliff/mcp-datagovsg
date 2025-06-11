import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerDataGovSgTools } from './datagovsg.tools.js';
import { registerSingStatTools } from './singstat.tools.js';

export default function createStatelessServer({
  config: _config,
}: {
  config: z.infer<typeof configSchema>;
}) {
  const server = new McpServer({
    name: 'Singapore Government Data MCP Server',
    version: '1.0.0',
  });

  // Register data.gov.sg tools
  registerDataGovSgTools(server);

  // Register SingStat tools
  registerSingStatTools(server);

  return server.server;
}

// Optional config schema
export const configSchema = z.object({});
