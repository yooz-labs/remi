export {
  applyEnvOverrides,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  formatConfig,
  DAEMON_HOLD_SECONDS_MAX,
  generateDefaultConfig,
  HOLD_SECONDS_MAX,
  HOLD_SECONDS_MIN,
  initConfigFile,
  loadConfig,
  loadConfigWithNotices,
  relayRequested,
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
