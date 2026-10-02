export {
  applyEnvOverrides,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  formatConfig,
  generateDefaultConfig,
  initConfigFile,
  loadConfig,
  loadConfigWithNotices,
} from './config.ts';

export type {
  AuthConfig,
  DaemonConfig,
  DisplayConfig,
  LoadedConfig,
  NetworkConfig,
  NotificationsConfig,
  RemiConfig,
  TelegramConfig,
} from './config.ts';
