/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess } from 'child_process';
import { WebSocket as NodeWebSocket } from 'node:http';
import split from 'split2';
import { CancellationTokenSource, Event, EventEmitter } from 'vscode';
import { retryGetWSEndpoint } from './getWsEndpoint';

export type ITargetMessage = Buffer | ArrayBuffer | Uint8Array | string;

export interface ITarget {
  readonly onMessage: Event<ITargetMessage>;
  readonly onError: Event<Error>;
  readonly onClose: Event<void>;

  send(message: ITargetMessage): void;
  dispose(): Promise<void>;
}

const waitForExit = async (process: ChildProcess) => {
  if (process.exitCode) {
    return;
  }

  await Promise.race([
    new Promise(r => process.on('exit', r)),
    new Promise(r => setTimeout(r, 1000)),
  ]);
};

/**
 * A debug target that sends data through the target's stdio streams.
 */
export class PipedTarget implements ITarget {
  private errorEmitter = new EventEmitter<Error>();
  private closeEmitter = new EventEmitter<void>();
  private messageEmitter = new EventEmitter<ITargetMessage>();

  public readonly onError = this.errorEmitter.event;
  public readonly onClose = this.closeEmitter.event;
  public readonly onMessage = this.messageEmitter.event;

  constructor(private readonly process: ChildProcess) {
    if (this.process.stdio.length < 5) {
      throw new Error('Insufficient fd number on child process');
    }

    process.on('error', e => this.errorEmitter.fire(e));
    process.on('exit', () => this.closeEmitter.fire());

    (process.stdio[4] as NodeJS.ReadableStream)
      .pipe(split('\0'))
      .on('data', data => this.messageEmitter.fire(data))
      .resume();
  }

  public send(message: ITargetMessage): void {
    const w = this.process.stdio[3] as NodeJS.WritableStream;
    if (message instanceof Uint8Array) {
      w.write(message);
    } else if (message instanceof ArrayBuffer) {
      w.write(new Uint8Array(message));
    } else {
      w.write(message);
    }

    w.write('\0');
  }

  public async dispose() {
    await waitForExit(this.process);
    this.process.kill();
  }
}

/**
 * Attaches to a debug target on the given host and port.
 */
export class AttachTarget implements ITarget {
  private errorEmitter = new EventEmitter<Error>();
  private closeEmitter = new EventEmitter<void>();
  private messageEmitter = new EventEmitter<ITargetMessage>();

  public readonly onError = this.errorEmitter.event;
  public readonly onClose = this.closeEmitter.event;
  public readonly onMessage = this.messageEmitter.event;

  public static async create(host: string, port: number) {
    const cts = new CancellationTokenSource();
    setTimeout(() => cts.cancel(), 10 * 1000);

    const endpoint = await retryGetWSEndpoint(`http://${host}:${port}`, cts.token);
    const ws = new NodeWebSocket(endpoint);
    ws.binaryType = 'arraybuffer';

    return await new Promise<ITarget>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(new AttachTarget(ws)));
      ws.addEventListener('error', (errorEvent: unknown) => {
        const err =
          typeof errorEvent === 'object' &&
          errorEvent !== null &&
          'error' in errorEvent &&
          (errorEvent as { error?: unknown }).error instanceof Error
            ? (errorEvent as { error: Error }).error
            : undefined;
        reject(err ?? new Error('WebSocket error'));
      });
    });
  }

  protected constructor(private readonly ws: InstanceType<typeof NodeWebSocket>) {
    ws.addEventListener('error', (evt: unknown) => {
      const err =
        typeof evt === 'object' &&
        evt !== null &&
        'error' in evt &&
        (evt as { error?: unknown }).error instanceof Error
          ? (evt as { error: Error }).error
          : undefined;
      this.errorEmitter.fire(err ?? new Error('WebSocket error'));
    });
    ws.addEventListener('close', () => this.closeEmitter.fire());
    ws.addEventListener('message', (event: unknown) =>
      this.messageEmitter.fire(normalizeMessage((event as { data: unknown }).data)),
    );
  }

  public send(message: ITargetMessage): void {
    this.ws.send(message);
  }

  public async dispose() {
    await new Promise(r => {
      this.ws.addEventListener('close', () => r(undefined));
      this.ws.close();
    });
  }
}

/**
 * Target that attaches to the process as a server.
 * Dispose will also kill the process.
 */
export class ServerTarget implements ITarget {
  private errorEmitter = new EventEmitter<Error>();
  private closeEmitter = new EventEmitter<void>();
  private messageEmitter = new EventEmitter<ITargetMessage>();

  public readonly onError = this.errorEmitter.event;
  public readonly onClose = this.closeEmitter.event;
  public readonly onMessage = this.messageEmitter.event;

  public static async create(child: ChildProcess, port: number) {
    const cts = new CancellationTokenSource();
    setTimeout(() => cts.cancel(), 10 * 1000);
    try {
      const target = await AttachTarget.create('localhost', port);
      return new ServerTarget(child, target);
    } catch (e) {
      child.kill();
      throw e;
    }
  }

  protected constructor(
    private readonly process: ChildProcess,
    private readonly attach: ITarget,
  ) {
    process.on('error', e => this.errorEmitter.fire(e));
    process.on('close', () => this.closeEmitter.fire());
    attach.onError(err => this.errorEmitter.fire(err));
    attach.onClose(() => this.closeEmitter.fire());
    attach.onMessage(evt => this.messageEmitter.fire(evt));
  }

  public send(message: ITargetMessage): void {
    this.attach.send(message);
  }

  public async dispose() {
    this.attach.dispose();
    await waitForExit(this.process);
    this.process.kill();
  }
}

export const normalizeMessage = (message: unknown): ITargetMessage => {
  if (
    typeof message === 'string' ||
    message instanceof Uint8Array ||
    message instanceof ArrayBuffer
  ) {
    return message;
  }

  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }

  return String(message);
};
