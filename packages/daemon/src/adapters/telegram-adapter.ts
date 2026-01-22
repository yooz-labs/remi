/**
 * Telegram Adapter - Telegram bot as a connection adapter.
 *
 * Uses Telegram Forum Mode (topics) for session separation.
 * Each Claude Code session = one topic thread.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateId, now } from '@remi/shared';
import type { AgentStatus, Message, ProtocolMessage, Question, UUID } from '@remi/shared';
import { Bot, type Context } from 'grammy';
import type {
  AdapterConfig,
  AdapterEvents,
  AdapterMetadata,
  ConnectionAdapter,
} from './connection-adapter.ts';
import {
  formatHelpMessage,
  formatMessageForTelegram,
  formatQuestionKeyboard,
  isValidContent,
  stripTerminalCodes,
} from './telegram-ui.ts';

/**
 * Resolve a directory path, expanding ~ and validating it exists.
 * Returns null with error message if invalid.
 */
function resolveDirectory(inputPath: string): { resolved: string } | { error: string } {
  let resolved = inputPath;

  // Expand ~ to home directory
  if (resolved.startsWith('~/')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  } else if (resolved === '~') {
    resolved = os.homedir();
  }

  // Resolve to absolute path
  resolved = path.resolve(resolved);

  // Check if directory exists
  if (!fs.existsSync(resolved)) {
    return { error: `Directory not found: ${resolved}` };
  }

  // Check if it's actually a directory
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${resolved}` };
  }

  return { resolved };
}

/** Telegram adapter configuration */
export interface TelegramAdapterConfig extends AdapterConfig {
  /** Bot token from @BotFather */
  readonly token: string;

  /** Default working directory for new sessions */
  readonly defaultDirectory?: string;
}

/** Session binding - maps Telegram topic to Claude session */
export interface SessionBinding {
  /** Internal connection ID */
  connectionId: UUID;

  /** Claude session ID (from ~/.claude/) */
  sessionId: UUID;

  /** Telegram group ID */
  chatId: number;

  /** Telegram topic ID (message_thread_id) */
  topicId: number;

  /** Working directory for this session */
  workingDirectory: string;

  /** Machine name */
  machineName: string;

  /** Topic name (e.g., "yahyasmcm-remi-1") */
  topicName: string;

  /** Session number for this directory */
  sessionNumber: number;

  /** When session started */
  startedAt: string;

  /** Current message being streamed (for editing) */
  currentMessageId?: number;

  /** Accumulated content for streaming */
  streamBuffer: string;

  /** Last content we sent (for deduplication) */
  lastSentContent: string;

  /** Is session paused */
  paused: boolean;
}

/** Directory session counter */
interface SessionCounter {
  directory: string;
  count: number;
}

/**
 * Telegram adapter using Forum Mode for session management.
 */
export class TelegramAdapter implements ConnectionAdapter {
  readonly type = 'telegram';

  private readonly config: TelegramAdapterConfig;
  private readonly events: Partial<AdapterEvents>;

  private bot: Bot | null = null;
  private running = false;

  /** Maps `${chatId}:${topicId}` to session binding */
  private readonly sessions: Map<string, SessionBinding> = new Map();

  /** Maps connectionId to session key */
  private readonly connectionToSession: Map<UUID, string> = new Map();

  /** Session counters per directory */
  private readonly sessionCounters: Map<string, number> = new Map();

  constructor(config: TelegramAdapterConfig, events: Partial<AdapterEvents> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      token: config.token,
      defaultDirectory: config.defaultDirectory ?? process.cwd(),
    };
    this.events = events;
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Telegram adapter already running');
    }

    if (!this.config.enabled) {
      console.log('Telegram adapter disabled');
      return;
    }

    if (!this.config.token) {
      console.log('Telegram adapter: No token configured, skipping');
      return;
    }

    this.bot = new Bot(this.config.token);
    this.setupHandlers();

    // Start long polling
    console.log('Telegram adapter starting...');
    this.bot.start({
      onStart: () => {
        console.log('Telegram adapter running (long polling)');
        this.running = true;
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.running || !this.bot) {
      return;
    }

    await this.bot.stop();
    this.bot = null;
    this.running = false;
    console.log('Telegram adapter stopped');
  }

  sendMessage(connectionId: UUID, message: Message): boolean {
    const sessionKey = this.connectionToSession.get(connectionId);
    if (!sessionKey) {
      return false;
    }

    const session = this.sessions.get(sessionKey);
    if (!session || !this.bot || session.paused) {
      return false;
    }

    // Format message for Telegram
    const text = formatMessageForTelegram(message);

    // Skip if no valid content
    if (!text || !isValidContent(text)) {
      return true; // Not an error, just nothing to send
    }

    // Stream by editing existing message or creating new one
    this.streamMessage(session, text).catch((err) => {
      console.error('Failed to send Telegram message:', err);
    });

    return true;
  }

  sendQuestion(connectionId: UUID, question: Question): boolean {
    const sessionKey = this.connectionToSession.get(connectionId);
    if (!sessionKey) {
      return false;
    }

    const session = this.sessions.get(sessionKey);
    if (!session || !this.bot) {
      return false;
    }

    // Create inline keyboard for question
    const keyboard = formatQuestionKeyboard(question);

    this.bot.api
      .sendMessage(session.chatId, question.text, {
        message_thread_id: session.topicId,
        reply_markup: keyboard,
      })
      .catch((err) => {
        console.error('Failed to send Telegram question:', err);
      });

    return true;
  }

  sendStatus(connectionId: UUID, status: AgentStatus, context?: string): boolean {
    const sessionKey = this.connectionToSession.get(connectionId);
    if (!sessionKey) {
      return false;
    }

    const session = this.sessions.get(sessionKey);
    if (!session || !this.bot || session.paused) {
      return false;
    }

    // Show typing indicator for thinking/executing status
    if (status === 'thinking' || status === 'executing') {
      // Send typing indicator repeatedly while working
      this.bot.api
        .sendChatAction(session.chatId, 'typing', {
          message_thread_id: session.topicId,
        })
        .catch(() => {
          // Ignore typing indicator errors
        });
    }

    return true;
  }

  sendRaw(connectionId: UUID, message: ProtocolMessage): boolean {
    // Telegram doesn't use raw protocol messages
    // Convert to appropriate Telegram message type
    if (message.type === 'agent_output') {
      return this.sendMessage(connectionId, (message as any).message);
    }
    if (message.type === 'question') {
      return this.sendQuestion(connectionId, (message as any).question);
    }
    if (message.type === 'session_update') {
      return this.sendStatus(connectionId, (message as any).session.status);
    }
    return false;
  }

  broadcast(message: ProtocolMessage): void {
    // Send to all active sessions
    for (const [, session] of this.sessions) {
      this.sendRaw(session.connectionId, message);
    }
  }

  hasConnection(connectionId: UUID): boolean {
    return this.connectionToSession.has(connectionId);
  }

  /** Get session binding by connection ID */
  getSession(connectionId: UUID): SessionBinding | undefined {
    const sessionKey = this.connectionToSession.get(connectionId);
    if (!sessionKey) {
      return undefined;
    }
    return this.sessions.get(sessionKey);
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    // Handle /start command
    this.bot.command('start', async (ctx) => {
      await this.handleStart(ctx);
    });

    // Handle /stop command
    this.bot.command('stop', async (ctx) => {
      await this.handleStop(ctx);
    });

    // Handle /interrupt command - send Escape to Claude
    this.bot.command('interrupt', async (ctx) => {
      await this.handleInterrupt(ctx);
    });

    // Handle /pause command
    this.bot.command('pause', async (ctx) => {
      await this.handlePause(ctx);
    });

    // Handle /resume command
    this.bot.command('resume', async (ctx) => {
      await this.handleResume(ctx);
    });

    // Handle /status command
    this.bot.command('status', async (ctx) => {
      await this.handleStatus(ctx);
    });

    // Handle /clear command
    this.bot.command('clear', async (ctx) => {
      await this.handleClear(ctx);
    });

    // Handle /help command
    this.bot.command('help', async (ctx) => {
      await this.handleHelp(ctx);
    });

    // Handle callback queries (button presses)
    this.bot.callbackQuery(/^answer:(.+):(.+)$/, async (ctx) => {
      await this.handleAnswerCallback(ctx);
    });

    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });
  }

  private async handleStart(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Get directory from command arguments and resolve it
    const rawDirectory = ctx.match?.toString().trim() || this.config.defaultDirectory!;
    const directoryResult = resolveDirectory(rawDirectory);

    if ('error' in directoryResult) {
      await ctx.reply(`Cannot start session: ${directoryResult.error}`);
      return;
    }

    const directory = directoryResult.resolved;

    // Check if this is a forum (supergroup with topics)
    const chat = await ctx.api.getChat(chatId);
    if (chat.type !== 'supergroup' || !('is_forum' in chat) || !chat.is_forum) {
      await ctx.reply(
        'Please use this bot in a group with Forum Topics enabled.\n\n' +
          'To enable Forum Topics:\n' +
          '1. Create a group or use an existing one\n' +
          '2. Go to Group Settings > Topics > Enable Topics\n' +
          '3. Add this bot to the group\n' +
          '4. Send /start in any topic',
      );
      return;
    }

    // Generate session details
    const machineName = os.hostname().replace(/\./g, '-').toLowerCase();
    const dirName = path.basename(directory);
    const sessionNumber = this.getNextSessionNumber(chatId, directory);
    const topicName = `${machineName}-${dirName}-${sessionNumber}`;

    try {
      // Create new forum topic
      const topic = await ctx.api.createForumTopic(chatId, topicName);
      const topicId = topic.message_thread_id;

      // Create session binding
      const connectionId = generateId();
      const sessionId = generateId(); // Will be replaced with actual Claude session ID
      const sessionKey = `${chatId}:${topicId}`;

      const session: SessionBinding = {
        connectionId,
        sessionId,
        chatId,
        topicId,
        workingDirectory: directory,
        machineName,
        topicName,
        sessionNumber,
        startedAt: now(),
        streamBuffer: '',
        lastSentContent: '',
        paused: false,
      };

      this.sessions.set(sessionKey, session);
      this.connectionToSession.set(connectionId, sessionKey);

      // Send welcome message in new topic
      await ctx.api.sendMessage(
        chatId,
        `Session started in ${directory}\n\nSend a message to talk to Claude.`,
        {
          message_thread_id: topicId,
        },
      );

      // Notify daemon of new connection
      const metadata: AdapterMetadata = {
        adapterType: this.type,
        displayName: topicName,
        platformData: {
          chatId,
          topicId,
          directory,
        },
      };
      this.events.onConnect?.(connectionId, metadata);

      // Reply in original topic
      await ctx.reply(`Created session "${topicName}" - check the new topic!`);
    } catch (err) {
      console.error('Failed to create forum topic:', err);
      await ctx.reply('Failed to create session topic. Make sure the bot has admin permissions.');
    }
  }

  private async handleStop(ctx: Context): Promise<void> {
    const session = this.getSessionFromContext(ctx);
    if (!session) {
      await ctx.reply('No active session in this topic.');
      return;
    }

    // Remove session
    const sessionKey = `${session.chatId}:${session.topicId}`;
    this.sessions.delete(sessionKey);
    this.connectionToSession.delete(session.connectionId);

    // Notify daemon
    this.events.onDisconnect?.(session.connectionId, 'User stopped session');

    await ctx.reply('Session stopped.');
  }

  private async handleStatus(ctx: Context): Promise<void> {
    const session = this.getSessionFromContext(ctx);
    if (!session) {
      await ctx.reply('No active session in this topic.');
      return;
    }

    const status = session.paused ? '⏸️ Paused' : '▶️ Active';
    await ctx.reply(
      `📁 Session: ${session.topicName}\n` +
        `📂 Directory: ${session.workingDirectory}\n` +
        `🕐 Started: ${session.startedAt}\n` +
        `📊 Status: ${status}`,
    );
  }

  private async handleClear(ctx: Context): Promise<void> {
    const session = this.getSessionFromContext(ctx);
    if (!session) {
      await ctx.reply('No active session in this topic. Use /start to create one.');
      return;
    }

    // Close current topic
    try {
      await ctx.api.closeForumTopic(session.chatId, session.topicId);
    } catch {
      // Topic might already be closed
    }

    // Create new session in new topic
    await this.handleStart(ctx);
  }

  private async handleInterrupt(ctx: Context): Promise<void> {
    const session = this.getSessionFromContext(ctx);
    if (!session) {
      await ctx.reply('No active session in this topic.');
      return;
    }

    // Send Escape key to interrupt Claude
    // The daemon will handle this by sending \x1b to the PTY
    this.events.onUserInput?.(session.connectionId, session.sessionId, '\x1b');

    await ctx.reply('⏹️ Interrupt sent to Claude (Escape key)');
  }

  private async handlePause(ctx: Context): Promise<void> {
    const session = this.getSessionFromContext(ctx);
    if (!session) {
      await ctx.reply('No active session in this topic.');
      return;
    }

    session.paused = true;
    await ctx.reply(
      '⏸️ Session paused. Messages from Claude will be held. Use /resume to continue.',
    );
  }

  private async handleResume(ctx: Context): Promise<void> {
    const session = this.getSessionFromContext(ctx);
    if (!session) {
      await ctx.reply('No active session in this topic.');
      return;
    }

    session.paused = false;
    await ctx.reply('▶️ Session resumed.');
  }

  private async handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(formatHelpMessage());
  }

  private async handleAnswerCallback(ctx: Context): Promise<void> {
    const match = ctx.match as RegExpMatchArray;
    const questionId = match[1] as UUID;
    const answer = match[2] ?? '';

    const session = this.getSessionFromContext(ctx);
    if (!session) {
      await ctx.answerCallbackQuery('Session not found');
      return;
    }

    // Notify daemon of answer
    this.events.onAnswer?.(session.connectionId, questionId, answer);

    // Acknowledge the callback
    await ctx.answerCallbackQuery('Sent!');

    // Update the message to remove the keyboard
    try {
      // Use an empty inline keyboard to remove buttons
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      // Message might not be editable
    }
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const session = this.getSessionFromContext(ctx);
    if (!session) {
      // No session - ignore or prompt to start
      return;
    }

    const text = ctx.message?.text;
    if (!text) return;

    // Notify daemon of user input
    this.events.onUserInput?.(session.connectionId, session.sessionId, text);
  }

  private getSessionFromContext(ctx: Context): SessionBinding | undefined {
    const chatId = ctx.chat?.id;
    const topicId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

    if (!chatId || !topicId) {
      return undefined;
    }

    const sessionKey = `${chatId}:${topicId}`;
    return this.sessions.get(sessionKey);
  }

  private getNextSessionNumber(chatId: number, directory: string): number {
    const key = `${chatId}:${directory}`;
    const current = this.sessionCounters.get(key) ?? 0;
    const next = current + 1;
    this.sessionCounters.set(key, next);
    return next;
  }

  private async streamMessage(session: SessionBinding, content: string): Promise<void> {
    if (!this.bot) return;

    // Clean the content
    const cleanContent = stripTerminalCodes(content).trim();
    if (!cleanContent || !isValidContent(cleanContent)) {
      return;
    }

    // Check for duplicate content (skip if same as last sent)
    if (cleanContent === session.lastSentContent) {
      return;
    }

    // Update buffer - replace, don't append (content is already full message)
    session.streamBuffer = cleanContent;
    session.lastSentContent = cleanContent;

    // If we have an existing message, try to edit it
    if (session.currentMessageId !== undefined) {
      try {
        await this.bot.api.editMessageText(session.chatId, session.currentMessageId, cleanContent);
        return;
      } catch {
        // Message might be too old to edit, create new one
        delete (session as any).currentMessageId;
      }
    }

    // Create new message
    try {
      const msg = await this.bot.api.sendMessage(session.chatId, cleanContent, {
        message_thread_id: session.topicId,
      });
      session.currentMessageId = msg.message_id;
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  }

  /** Finalize current stream and reset buffer */
  finalizeStream(connectionId: UUID): void {
    const sessionKey = this.connectionToSession.get(connectionId);
    if (!sessionKey) return;

    const session = this.sessions.get(sessionKey);
    if (!session) return;

    delete (session as any).currentMessageId;
    session.streamBuffer = '';
    session.lastSentContent = '';
  }

  /** Send typing indicator */
  async sendTypingIndicator(connectionId: UUID): Promise<void> {
    const sessionKey = this.connectionToSession.get(connectionId);
    if (!sessionKey || !this.bot) return;

    const session = this.sessions.get(sessionKey);
    if (!session) return;

    try {
      await this.bot.api.sendChatAction(session.chatId, 'typing', {
        message_thread_id: session.topicId,
      });
    } catch {
      // Ignore typing indicator errors
    }
  }
}
