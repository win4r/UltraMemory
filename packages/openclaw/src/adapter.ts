/**
 * OpenClaw adapter — registers UltraMemory tools via the OpenClaw plugin API.
 *
 * This is a thin translation layer: each tool delegates directly to MemoryService.
 */

import type {
  MemoryService,
  StoreParams,
  RecallParams,
  UpdateParams,
  ForgetParams,
  ListParams,
} from "@ultramemory/server";
import { createMcpToolDefinitions } from "@ultramemory/server";

// Minimal OpenClaw plugin API surface — avoids a hard dependency on the
// OpenClaw gateway package while still being type-safe for the hooks we use.
export interface OpenClawPluginApi {
  registerTool(
    name: string,
    schema: unknown,
    handler: (args: unknown, ctx: unknown) => Promise<unknown>,
  ): void;
  registerCli?(cli: unknown): void;
  pluginConfig: unknown;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
    error(msg: string): void;
  };
  resolvePath(path: string): string;
}

// -------------------------------------------------------------------------
// Tool handlers — one per MemoryService method
// -------------------------------------------------------------------------

type Args = Record<string, unknown>;

function storeHandler(service: MemoryService) {
  return async (args: unknown) => {
    const a = args as Args;
    const params: StoreParams = {
      text: String(a.text ?? ""),
      category: a.category as string | undefined,
      scope: a.scope as string | undefined,
      importance: a.importance as number | undefined,
    };
    return service.store(params);
  };
}

function recallHandler(service: MemoryService) {
  return async (args: unknown) => {
    const a = args as Args;
    const params: RecallParams = {
      query: String(a.query ?? ""),
      limit: a.limit as number | undefined,
      scopeFilter: a.scope ? [String(a.scope)] : undefined,
      category: a.category as string | undefined,
    };
    return service.recall(params);
  };
}

function updateHandler(service: MemoryService) {
  return async (args: unknown) => {
    const a = args as Args;
    const params: UpdateParams = {
      id: String(a.memoryId ?? a.id ?? ""),
      text: a.text as string | undefined,
      importance: a.importance as number | undefined,
      category: a.category as string | undefined,
    };
    return service.update(params);
  };
}

function forgetHandler(service: MemoryService) {
  return async (args: unknown) => {
    const a = args as Args;
    const params: ForgetParams = {
      id: String(a.id ?? ""),
    };
    return service.forget(params);
  };
}

function listHandler(service: MemoryService) {
  return async (args: unknown) => {
    const a = args as Args;
    const params: ListParams = {
      scopeFilter: a.scope ? [String(a.scope)] : undefined,
      category: a.category as string | undefined,
      limit: a.limit as number | undefined,
      offset: a.offset as number | undefined,
    };
    return service.list(params);
  };
}

function statsHandler(service: MemoryService) {
  return async (args: unknown) => {
    const a = args as Args;
    const scopeFilter = a.scope ? [String(a.scope)] : undefined;
    return service.stats(scopeFilter);
  };
}

// -------------------------------------------------------------------------
// Public entry
// -------------------------------------------------------------------------

const HANDLER_MAP: Record<string, (svc: MemoryService) => (args: unknown) => Promise<unknown>> = {
  memory_store: storeHandler,
  memory_recall: recallHandler,
  memory_update: updateHandler,
  memory_forget: forgetHandler,
  memory_list: listHandler,
  memory_stats: statsHandler,
};

export function createOpenClawAdapter(api: OpenClawPluginApi, service: MemoryService): void {
  const toolDefs = createMcpToolDefinitions();

  for (const def of toolDefs) {
    const factory = HANDLER_MAP[def.name];
    if (!factory) {
      api.logger.warn(`ultramemory: no handler for tool "${def.name}", skipping`);
      continue;
    }
    api.registerTool(def.name, def.inputSchema, async (args, _ctx) => factory(service)(args));
  }

  api.logger.info(`ultramemory: OpenClaw adapter registered ${toolDefs.length} tools`);
}
