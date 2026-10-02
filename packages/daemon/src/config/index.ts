export {
  applyEnvOverrides,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  formatConfig,
  generateDefaultConfig,
  HOLD_SECONDS_MAX,
  HOLD_SECONDS_MIN,
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
  PromptsConfig,
  RemiConfig,
  TelegramConfig,
} from './config.ts';
