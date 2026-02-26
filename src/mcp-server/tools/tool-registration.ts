/**
 * @fileoverview Encapsulates the registration of all tool definitions for the application's
 * dependency injection (DI) container and provides a registry service to apply them to an
 * McpServer instance.
 * @module src/mcp-server/tools/tool-registration
 */
import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodObject, ZodRawShape } from 'zod';

import type { ToolDefinition } from '@/mcp-server/tools/utils/index.js';
import { createMcpToolHandler } from '@/mcp-server/tools/utils/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { ErrorHandler, logger, requestContextService } from '@/utils/index.js';

export class ToolRegistry {
  constructor(
    private toolDefs: ToolDefinition<
      ZodObject<ZodRawShape>,
      ZodObject<ZodRawShape>
    >[],
  ) {}

  /**
   * Registers all resolved tool definitions with the provided McpServer instance.
   * @param {McpServer} server - The server instance to register tools with.
   */
  public async registerAll(server: McpServer): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: 'ToolRegistry.registerAll',
    });
    logger.info(`Registering ${this.toolDefs.length} tool(s)...`, context);
    for (const toolDef of this.toolDefs) {
      await this.registerTool(server, toolDef);
    }
  }

  private deriveTitleFromName(name: string): string {
    return name
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private async registerTool<
    TInputSchema extends ZodObject<ZodRawShape>,
    TOutputSchema extends ZodObject<ZodRawShape>,
  >(
    server: McpServer,
    tool: ToolDefinition<TInputSchema, TOutputSchema>,
  ): Promise<void> {
    const registrationContext = requestContextService.createRequestContext({
      operation: 'ToolRegistry.registerTool',
      toolName: tool.name,
    });

    logger.debug(`Registering tool: '${tool.name}'`, registrationContext);

    await ErrorHandler.tryCatch(
      () => {
        const handler = createMcpToolHandler({
          toolName: tool.name,
          logic: tool.logic,
          ...(tool.responseFormatter && {
            responseFormatter: tool.responseFormatter,
          }),
        });

        const title =
          tool.title ??
          tool.annotations?.title ??
          this.deriveTitleFromName(tool.name);

        server.registerTool(
          tool.name,
          {
            title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            ...(tool.annotations && { annotations: tool.annotations }),
          },
          handler as ToolCallback<TInputSchema>,
        );

        logger.notice(
          `Tool '${tool.name}' registered successfully.`,
          registrationContext,
        );
      },
      {
        operation: `RegisteringTool_${tool.name}`,
        context: registrationContext,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      },
    );
  }
}
