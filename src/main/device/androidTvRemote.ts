import { createNodeFileSystem, type IFileSystem } from '../../backend/core/fileSystem';
import { AndroidTvCertStore } from '../../backend/devices/credentials/androidTvCertStore';
import type { CommandDispatchRequest } from '../../shared/types';
import { isCaptureEnabled, record, recordBuffer } from '../capture';
import { createNodeLogger, getAppDataPath, logError } from '../logger';
import { commandMetricsStore } from '../metrics';

import {
  DEFAULT_PAIRING_PORT,
  SERVICE_NAME,
  isCertificateRejectedError,
  normalizeRemoteError,
  toError,
  type DeviceSession,
  type RemoteClientPort,
  type RemoteState,
} from './androidTvRemote.types';
import type { PemPair } from './protocol/certificate';
import { encodeAppLinkLaunchMessage } from './appLinkCodec';
import { SafeTlsTransport } from './safeTlsTransport';

const PAIRING_CONNECT_TIMEOUT_MS = 20_000;
const REMOTE_CONNECT_TIMEOUT_MS = 15_000;

interface LibretvRemoteClientInstance {
  close(): Promise<void>;
  commandDownUp(key: string): Promise<void>;
  connect(): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  on(event: 'message', listener: (message: LibretvRemoteMessage) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  text(value: string): Promise<void>;
  voiceBegin(): Promise<{ sessionId: number }>;
  voiceEnd(): Promise<void>;
  voicePayload(samples: Uint8Array): Promise<void>;
}

type LibretvRemoteMessage =
  | {
      type: 'configure';
      appVersion?: string;
      deviceModel?: string;
      vendor?: string;
    }
  | {
      type: 'text';
      fieldCounter: number;
      imeCounter: number;
    }
  | {
      type: 'ready';
      started: boolean;
    }
  | {
      type: 'voice';
      phase: 'begin' | 'payload' | 'end';
      sessionId: number;
    };

interface LibretvGoogleModule {
  PairingClient: new (options: {
    cert?: string;
    clientName?: string;
    host?: string;
    key?: string;
    port?: number;
    rejectUnauthorized?: boolean;
    timeoutMs?: number;
    transport?: SafeTlsTransport;
  }) => {
    close(): Promise<void>;
    start(): Promise<unknown>;
    submitCode(code: string): Promise<{ type: string; status?: string }>;
  };
  RemoteClient: new (options: {
    cert?: string;
    host?: string;
    key?: string;
    port?: number;
    rejectUnauthorized?: boolean;
    timeoutMs?: number;
    transport?: SafeTlsTransport;
  }) => LibretvRemoteClientInstance;
  RemoteKeyCodes: Record<string, number>;
}

/** Android KEYCODE_VOLUME_MUTE — not yet exported by @librecontrol/google-tv. */
const KEYCODE_VOLUME_MUTE = 164;
/** Android KEYCODE_SETTINGS — not yet exported by @librecontrol/google-tv. */
const KEYCODE_SETTINGS = 176;

const COMMAND_TO_LIBRETV_KEY: Record<CommandDispatchRequest['command'], string> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  home: 'home',
  back: 'back',
  play_pause: 'playPause',
  volume_up: 'volumeUp',
  volume_down: 'volumeDown',
  mute: 'mute',
  power: 'power',
  settings: 'settings',
  assistant_press: 'assistant',
  assistant_release: 'assistant',
};

let librecontrolGoogleTvModule: Promise<LibretvGoogleModule> | undefined;

function loadLibretvGoogle(): Promise<LibretvGoogleModule> {
  librecontrolGoogleTvModule ??= import('@librecontrol/google-tv').then((mod) => {
    const module = mod as LibretvGoogleModule;
    if (module.RemoteKeyCodes.mute == null) {
      module.RemoteKeyCodes.mute = KEYCODE_VOLUME_MUTE;
    }
    if (module.RemoteKeyCodes.settings == null) {
      module.RemoteKeyCodes.settings = KEYCODE_SETTINGS;
    }
    return module;
  });
  return librecontrolGoogleTvModule;
}

class LibretvGoogleRemoteClient implements RemoteClientPort {
  private client: LibretvRemoteClientInstance | undefined;
  private transport: SafeTlsTransport | undefined;
  private connectPromise: Promise<void> | undefined;
  private protocolReady = false;
  private activeVoiceSessionId: number | undefined;
  private state: RemoteState = {
    imeCounter: 0,
    imeFieldCounter: 0,
    lastActivityAt: 0,
  };

  constructor(
    private readonly host: string,
    private readonly certs: PemPair
  ) {}

  get snapshot(): RemoteState {
    return this.state;
  }

  get isConnected(): boolean {
    return Boolean(this.client && this.protocolReady);
  }

  async connect(commandId?: string): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (commandId) {
      commandMetricsStore.recordConnectStarted(this.host, commandId);
    }

    this.connectPromise = this.open(commandId).finally(() => {
      this.connectPromise = undefined;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.protocolReady = false;
    this.activeVoiceSessionId = undefined;
    if (client) {
      void client.close();
    }
    commandMetricsStore.recordSocketClosed(this.host);
  }

  async sendCommand(request: CommandDispatchRequest): Promise<void> {
    const client = this.requireClient();
    const key = COMMAND_TO_LIBRETV_KEY[request.command];
    if (request.command === 'assistant_press') {
      await client.keyDown(key);
    } else if (request.command === 'assistant_release') {
      await client.keyUp(key);
    } else {
      await client.commandDownUp(key);
    }
    commandMetricsStore.recordSocketWrite(request, { host: this.host, buffered: false });
  }

  async sendText(text: string): Promise<void> {
    await this.requireClient().text(text.trim());
  }

  async sendAppLink(appLink: string): Promise<void> {
    const payload = encodeAppLinkLaunchMessage(appLink);
    await this.connect();
    try {
      await this.requireTransport().send(payload);
    } catch {
      // Socket may have dropped mid-session — force a fresh connect and retry once.
      this.protocolReady = false;
      this.client = undefined;
      this.transport = undefined;
      await this.connect();
      await this.requireTransport().send(payload);
    }
    this.state.lastActivityAt = Date.now();
  }

  async startVoiceSession(): Promise<number> {
    const session = await this.requireClient().voiceBegin();
    this.activeVoiceSessionId = session.sessionId;
    this.state.voiceSessionId = session.sessionId;
    return session.sessionId;
  }

  async sendVoiceChunk(sessionId: number, samples: Buffer): Promise<void> {
    if (!samples.length) {
      return;
    }
    this.activeVoiceSessionId = sessionId;
    await this.requireClient().voicePayload(samples);
  }

  async stopVoiceSession(sessionId: number): Promise<void> {
    if (this.activeVoiceSessionId === sessionId || this.state.voiceSessionId === sessionId) {
      await this.requireClient().voiceEnd();
      this.activeVoiceSessionId = undefined;
      this.state.voiceSessionId = undefined;
    }
  }

  private async open(commandId?: string): Promise<void> {
    const { RemoteClient } = await loadLibretvGoogle();
    const transport = new SafeTlsTransport({
      cert: this.certs.cert,
      host: this.host,
      key: this.certs.key,
      port: 6466,
      rejectUnauthorized: false,
      timeoutMs: REMOTE_CONNECT_TIMEOUT_MS,
    });
    const client = new RemoteClient({
      cert: this.certs.cert,
      transport,
    });
    this.transport = transport;
    this.client = client;
    client.on('message', (message) => {
      commandMetricsStore.recordInboundMessage(this.host);
      this.state.lastActivityAt = Date.now();
      if (message.type === 'configure') {
        this.state.deviceInfo = {
          appVersion: message.appVersion,
          model: message.deviceModel,
          vendor: message.vendor,
        };
      } else if (message.type === 'text') {
        this.state.imeCounter = message.imeCounter;
        this.state.imeFieldCounter = message.fieldCounter;
      } else if (message.type === 'ready') {
        this.state.isOn = message.started;
      } else if (message.phase === 'begin') {
        this.state.voiceSessionId = message.sessionId;
      } else if (message.phase === 'end') {
        this.state.voiceSessionId = undefined;
      }
    });
    client.on('close', () => {
      commandMetricsStore.recordSocketClosed(this.host);
      this.protocolReady = false;
      this.client = undefined;
      this.transport = undefined;
    });
    client.on('error', (error) => {
      void logError('androidtvremote', 'LibreControl Google TV remote client error', error);
    });

    try {
      await client.connect();
      this.protocolReady = true;
      this.state.lastActivityAt = Date.now();
      if (commandId) {
        commandMetricsStore.recordConnectCompleted(this.host, commandId);
      }
    } catch (error) {
      this.client = undefined;
      this.protocolReady = false;
      if (commandId) {
        commandMetricsStore.recordConnectFailed(
          this.host,
          commandId,
          toError(error, `Could not connect to ${this.host}.`).message
        );
      }
      throw error;
    }
  }

  private requireClient(): LibretvRemoteClientInstance {
    if (!this.client || !this.protocolReady) {
      throw new Error('Connection has been lost.');
    }
    return this.client;
  }

  private requireTransport(): SafeTlsTransport {
    if (!this.transport) {
      throw new Error('Remote transport is not connected.');
    }
    return this.transport;
  }
}

export class AndroidTvRemoteBridge {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly fs: IFileSystem = createNodeFileSystem();

  private readonly certStore = new AndroidTvCertStore(
    this.fs,
    {
      getCertStateDir: () => getAppDataPath('androidtvremote'),
      getAppDataPath: (...segments) => getAppDataPath(...segments),
    },
    createNodeLogger()
  );

  private getFilesForCertKey(certKey: string): { certPath: string; keyPath: string } {
    return this.certStore.getFilesForCertKey(certKey);
  }

  /** @deprecated Use getFilesForCertKey with a macAddress-based key */
  private getFilesForHost(host: string): { certPath: string; keyPath: string } {
    return this.getFilesForCertKey(host);
  }

  /**
   * Move persisted certs from one identity key to another.
   * Safe to call even if the old file doesn't exist.
   */
  async migratePersistedCerts(oldCertKey: string, newCertKey: string): Promise<void> {
    await this.certStore.migrate(oldCertKey, newCertKey);
  }

  /**
   * Migrate certs from old IP-based filename to MAC-based filename.
   * Safe to call even if the old file doesn't exist.
   */
  async migrateCerts(oldHost: string, macAddress: string): Promise<void> {
    await this.migratePersistedCerts(oldHost, macAddress);
  }

  private async loadOrCreateCerts(certKey: string): Promise<PemPair> {
    return this.certStore.loadOrCreate(certKey);
  }

  private async clearPersistedHostState(certKey: string): Promise<void> {
    await this.certStore.clear(certKey);
  }

  private async clearHostSession(
    host: string,
    removeCerts = false,
    certKey?: string
  ): Promise<void> {
    const normalizedHost = host.trim();
    const session = this.sessions.get(normalizedHost);

    session?.remoteClient?.disconnect();
    if (session?.pairingManager) {
      try {
        await session.pairingManager.close();
      } catch {
        // Ignore close failures while tearing down a stuck pairing session.
      }
    }
    this.sessions.delete(normalizedHost);

    if (removeCerts) {
      await this.clearPersistedHostState(certKey ?? normalizedHost);
    }
  }

  private async getSession(host: string, certKey?: string): Promise<DeviceSession> {
    const normalizedHost = host.trim();
    if (!normalizedHost) {
      throw new Error('Missing host');
    }

    const normalizedCertKey = certKey?.trim();
    if (normalizedCertKey && normalizedCertKey !== normalizedHost) {
      await this.migrateCerts(normalizedHost, normalizedCertKey);
    }

    const existing = this.sessions.get(normalizedHost);
    if (existing) {
      return existing;
    }

    const session: DeviceSession = {
      certs: await this.loadOrCreateCerts(normalizedCertKey ?? normalizedHost),
    };
    this.sessions.set(normalizedHost, session);
    return session;
  }

  async startPairing(
    host: string,
    certKey?: string,
    pairingPort: number = DEFAULT_PAIRING_PORT
  ): Promise<Record<string, unknown> | undefined> {
    record({
      layer: 'pairing',
      direction: 'call',
      event: 'startPairing',
      meta: { host, certKey, pairingPort },
    });
    const session = await this.getSession(host, certKey);

    if (session.pairingReady) {
      await session.pairingReady;
      return {};
    }

    const { PairingClient } = await loadLibretvGoogle();
    const port =
      Number.isFinite(pairingPort) && pairingPort > 0 ? pairingPort : DEFAULT_PAIRING_PORT;
    const transport = new SafeTlsTransport({
      cert: session.certs.cert,
      host,
      key: session.certs.key,
      port,
      rejectUnauthorized: false,
      timeoutMs: PAIRING_CONNECT_TIMEOUT_MS,
    });
    const pairingManager = new PairingClient({
      cert: session.certs.cert,
      clientName: SERVICE_NAME,
      transport,
      timeoutMs: PAIRING_CONNECT_TIMEOUT_MS,
    });

    session.pairingManager = pairingManager;
    session.pairingReady = pairingManager
      .start()
      .then(() => undefined)
      .catch(async (error: unknown) => {
        session.pairingManager = undefined;
        try {
          await pairingManager.close();
        } catch {
          // Ignore close failures after a failed start.
        }
        throw normalizeRemoteError(error, 'Pairing failed.');
      })
      .finally(() => {
        session.pairingReady = undefined;
      });

    await session.pairingReady;
    return {};
  }

  async finishPairing(host: string, code: string, certKey?: string): Promise<void> {
    record({
      layer: 'pairing',
      direction: 'call',
      event: 'finishPairing',
      meta: { host, certKey, codeLength: code.length },
    });
    const session = await this.getSession(host, certKey);
    if (!session.pairingManager) {
      throw new Error('No pairing session is active for this device.');
    }

    try {
      const result = await session.pairingManager.submitCode(code.trim());
      if (result.type !== 'secret-ack' || result.status !== 'ok') {
        throw new Error('Invalid pairing code. Request a new code and try again.');
      }
      await session.pairingManager.close();
      session.pairingManager = undefined;
    } catch (error) {
      await this.clearHostSession(host);
      throw normalizeRemoteError(error, 'Pairing failed.');
    }
  }

  async connect(host: string, certKey?: string): Promise<Record<string, unknown> | undefined> {
    record({ layer: 'transport', direction: 'call', event: 'connect', meta: { host, certKey } });
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);

    try {
      await session.remoteClient.connect();
    } catch (error) {
      const normalized = normalizeRemoteError(error, `Could not connect to ${host}.`);
      if (isCertificateRejectedError(error)) {
        await this.clearHostSession(host, true, certKey);
      }
      throw normalized;
    }

    const snapshot = session.remoteClient.snapshot;

    return {
      current_app: snapshot.currentApp,
      is_on: snapshot.isOn,
      mac: undefined,
      name: snapshot.deviceInfo?.model ?? host,
    };
  }

  disconnect(host: string): void {
    const session = this.sessions.get(host.trim());
    session?.remoteClient?.disconnect();
    if (session) {
      session.remoteClient = undefined;
    }
  }

  async reset(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.remoteClient?.disconnect();
      session.remoteClient = undefined;
      if (session.pairingManager) {
        try {
          await session.pairingManager.close();
        } catch {
          // Ignore close failures during reset.
        }
      }
      session.pairingManager = undefined;
      session.pairingReady = undefined;
    }

    this.sessions.clear();
    await this.fs.rmRecursive(getAppDataPath('androidtvremote'));
  }

  async sendCommand(
    host: string,
    request: CommandDispatchRequest,
    certKey?: string
  ): Promise<void> {
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);

    commandMetricsStore.recordBridgeSendStart(request, host);

    try {
      await session.remoteClient.connect(request.id);
      await session.remoteClient.sendCommand(request);
      commandMetricsStore.recordCommandSucceeded(request.id);
    } catch (error) {
      const normalizedError = normalizeRemoteError(
        error,
        `Could not send ${request.command} to ${host}.`
      );
      const reason = normalizedError.message.includes('Connection has been lost.')
        ? 'socket_destroyed'
        : normalizedError.message.includes('timed out')
          ? 'connect_failed'
          : 'send_failed';
      commandMetricsStore.recordCommandFailed(request, {
        reason,
        errorMessage: normalizedError.message,
        host,
      });
      throw normalizedError;
    }
  }

  async sendText(host: string, text: string, certKey?: string): Promise<void> {
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);

    await session.remoteClient.connect();
    await session.remoteClient.sendText(text);
  }

  async sendAppLink(host: string, appLink: string, certKey?: string): Promise<void> {
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);

    await session.remoteClient.connect();
    await session.remoteClient.sendAppLink(appLink);
  }

  async startAssistantVoice(host: string, certKey?: string): Promise<number> {
    record({ layer: 'voice', direction: 'call', event: 'startAssistantVoice', meta: { host } });
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);
    await session.remoteClient.connect();
    return session.remoteClient.startVoiceSession();
  }

  async sendAssistantVoiceChunk(
    host: string,
    sessionId: number,
    chunk: Buffer,
    certKey?: string
  ): Promise<void> {
    if (isCaptureEnabled()) {
      recordBuffer('voice', 'tx', 'voiceChunk', chunk, {
        host,
        sessionId,
        byteLength: chunk.byteLength,
      });
    }
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);
    await session.remoteClient.connect();
    await session.remoteClient.sendVoiceChunk(sessionId, chunk);
  }

  async stopAssistantVoice(host: string, sessionId: number, certKey?: string): Promise<void> {
    record({
      layer: 'voice',
      direction: 'call',
      event: 'stopAssistantVoice',
      meta: { host, sessionId },
    });
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);
    await session.remoteClient.connect();
    await session.remoteClient.stopVoiceSession(sessionId);
  }

  async hasPendingAssistantVoiceSession(host: string, certKey?: string): Promise<boolean> {
    const session = await this.getSession(host, certKey);
    session.remoteClient ??= new LibretvGoogleRemoteClient(host, session.certs);
    await session.remoteClient.connect();
    return Boolean(session.remoteClient.snapshot.voiceSessionId);
  }
}

/**
 * Factory: construct a fresh bridge. New code ( onward) should prefer this
 * over the singleton so each test gets an isolated session map. Production code
 * continues to use the `androidTvRemoteBridge` singleton below for backward
 * compatibility.
 */
export function createAndroidTvRemoteBridge(): AndroidTvRemoteBridge {
  return new AndroidTvRemoteBridge();
}

// Existing process-wide singleton — preserved for backward compatibility.
export const androidTvRemoteBridge = createAndroidTvRemoteBridge();
