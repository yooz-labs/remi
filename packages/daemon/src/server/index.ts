/**
 * Server module - WebSocket server for client connections.
 */

export { Connection } from './connection.ts';
export type { ConnectionState, ConnectionEvents, ConnectionConfig } from './connection.ts';

export { WebSocketServer } from './websocket-server.ts';
export type { ServerConfig, ServerEvents } from './websocket-server.ts';
