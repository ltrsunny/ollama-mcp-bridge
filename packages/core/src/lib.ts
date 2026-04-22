export { detectHardware } from './hardware/detect.js';
export type { HardwareInfo, Platform } from './hardware/detect.js';

export { fetchCatalog, parseCatalog, CatalogFetchError } from './models/catalog.js';
export type { CatalogModel, FetchCatalogOptions } from './models/catalog.js';

export {
  OllamaClient,
  OllamaDaemonError,
  DEFAULT_OLLAMA_HOST,
} from './ollama/client.js';
export type { InstalledModel, ChatOptions } from './ollama/client.js';

export { buildBridgeServer, runBridgeServerStdio } from './mcp/server.js';
export type { BridgeServerOptions } from './mcp/server.js';

export {
  DEFAULT_CONFIG,
  withOverrides,
  tierForTool,
  modelForTool,
} from './config/tiers.js';
export type { Tier, TierConfig, BridgeConfig, ResolveOptions } from './config/tiers.js';
