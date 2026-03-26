/**
 * Minimal type stub for openclaw/plugin-sdk.
 * Allows @ultramemory/core to typecheck without the full OpenClaw dependency.
 * The actual types are provided at runtime by the OpenClaw host.
 */
declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    registerTool(factory: (ctx: any) => any, options?: { name?: string }): void;
    registerCli?(cli: any): void;
    registerHook?(event: string, handler: (...args: any[]) => any, options?: any): void;
    registerService?(config: any): void;
    on(event: string, handler: (...args: any[]) => any, options?: any): void;
    resolvePath(path: string): string;
    pluginConfig: unknown;
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      debug?(msg: string): void;
      error?(msg: string): void;
    };
  }

  export const Type: any;
  export function stringEnum(values: string[]): any;
}
