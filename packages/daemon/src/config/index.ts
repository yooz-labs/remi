export {
  applyEnvOverrides,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  defaultModel,
  detectLocalLLMPlatform,
  llamaServerCommand,
  formatConfig,
  generateDefaultConfig,
  initConfigFile,
  loadConfig,
} from './config.ts';

export type {
  AuthConfig,
  DaemonConfig,
  DisplayConfig,
  NetworkConfig,
  RemiConfig,
  TelegramConfig,
} from './config.ts';
