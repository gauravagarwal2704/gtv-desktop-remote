import { EventEmitter } from 'node:events';
import tls from 'node:tls';

type FrameParserInstance = {
  push(chunk: Buffer | Uint8Array): Uint8Array[];
};

type FramingModule = {
  FrameParser: new () => FrameParserInstance;
  encodeFrame(payload: Uint8Array): Uint8Array;
};

export type SafeTlsTransportOptions = {
  host: string;
  port: number;
  cert?: string | Buffer;
  key?: string | Buffer;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
};

let framingModule: Promise<FramingModule> | undefined;

function loadFraming(): Promise<FramingModule> {
  framingModule ??= import('@librecontrol/google-tv').then((mod) => mod as unknown as FramingModule);
  return framingModule;
}

/**
 * TLS frame transport for Android TV pairing/remote.
 * Unlike @librecontrol/google-tv NodeTlsTransport, this rejects when the
 * socket closes before secureConnect — that path previously hung forever
 * because close cleared the timeout without rejecting the connect promise.
 */
export class SafeTlsTransport extends EventEmitter {
  private socket: tls.TLSSocket | undefined;
  private connectingSocket: tls.TLSSocket | undefined;
  private parser: FrameParserInstance | undefined;
  private encodeFrame: ((payload: Uint8Array) => Uint8Array) | undefined;

  constructor(private readonly options: SafeTlsTransportOptions) {
    super();
  }

  private async ensureFraming(): Promise<void> {
    if (this.parser && this.encodeFrame) {
      return;
    }
    const framing = await loadFraming();
    this.parser = new framing.FrameParser();
    this.encodeFrame = framing.encodeFrame.bind(framing);
  }

  async connect(): Promise<void> {
    await this.ensureFraming();

    if (this.socket) {
      return;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = tls.connect({
        host: this.options.host,
        port: this.options.port,
        cert: this.options.cert,
        key: this.options.key,
        ca: this.options.ca,
        rejectUnauthorized: this.options.rejectUnauthorized ?? false,
      });
      this.connectingSocket = socket;

      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.connectingSocket = undefined;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const timer = setTimeout(() => {
        const error = new Error(
          `TLS connection timed out after ${this.options.timeoutMs ?? 15_000}ms`
        );
        socket.destroy(error);
        settle(error);
      }, this.options.timeoutMs ?? 15_000);

      socket.once('secureConnect', () => {
        this.socket = socket;
        settle();
      });

      socket.once('error', (error) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', error);
        }
        settle(error);
      });

      socket.on('data', (chunk) => {
        const parser = this.parser;
        if (!parser) {
          return;
        }
        for (const frame of parser.push(chunk)) {
          this.emit('frame', frame);
        }
      });

      socket.once('close', () => {
        this.socket = undefined;
        this.connectingSocket = undefined;
        this.emit('close');
        settle(new Error('TLS connection closed before it became ready.'));
      });
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    await this.ensureFraming();
    if (!this.socket || !this.encodeFrame) {
      throw new Error('transport is not connected');
    }

    const payload = this.encodeFrame(frame);
    await new Promise<void>((resolve, reject) => {
      this.socket?.write(payload, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket ?? this.connectingSocket;
    this.socket = undefined;
    this.connectingSocket = undefined;
    if (!socket || socket.destroyed) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  getCertificates(): {
    local?: tls.PeerCertificate | tls.DetailedPeerCertificate;
    peer?: tls.PeerCertificate | tls.DetailedPeerCertificate;
  } {
    const local = this.socket?.getCertificate();
    const peer = this.socket?.getPeerCertificate();
    return {
      local: local && typeof local === 'object' && 'raw' in local ? local : undefined,
      peer: peer && 'raw' in peer ? peer : undefined,
    };
  }
}
