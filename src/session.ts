/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import { WebSocket as NodeWebSocket } from 'node:http';
import { Disposable, EventEmitter } from 'vscode';
import { ITarget, ITargetMessage, normalizeMessage } from './target';

class MessageQueue<T> {
  private qOrFn: T[] | ((value: T) => void) = [];

  public push(value: T) {
    if (typeof this.qOrFn === 'function') {
      this.qOrFn(value);
    } else {
      this.qOrFn.push(value);
    }
  }

  public connect(fn: (value: T) => void) {
    if (typeof this.qOrFn === 'function') {
      throw new Error('Already connected');
    }

    const prev = this.qOrFn;
    this.qOrFn = fn;
    for (const queued of prev) {
      fn(queued);
    }
  }
}

/**
 * The Session manages the lifecycle for a single top-level browser debug sesssion.
 */
export class Session implements Disposable {
  private readonly errorEmitter = new EventEmitter<Error>();
  public readonly onError = this.errorEmitter.event;

  private readonly closeEmitter = new EventEmitter<void>();
  public readonly onClose = this.closeEmitter.event;

  private disposed = false;
  private browserProcess?: ITarget;
  private socket?: InstanceType<typeof NodeWebSocket>;

  private fromSocketQueue = new MessageQueue<ITargetMessage>();
  private fromBrowserQueue = new MessageQueue<ITargetMessage>();

  constructor() {
    this.onClose(() => this.dispose());
    this.onError(() => this.dispose());
  }

  /**
   * Attaches the socket looping back up to js-debug.
   */
  public attachSocket(host: string, port: number, path: string) {
    const url = new URL(`ws://${host}:${port}${path}`);
    const deadline = Date.now() + 5000;
    this.attachSocketLoop(url, deadline);
  }

  /**
   * Attaches the browser child process.
   */
  public attachChild(target: ITarget) {
    if (this.disposed) {
      target.dispose();
      return;
    }

    this.browserProcess = target;
    target.onClose(() => this.closeEmitter.fire());
    target.onError(err => this.errorEmitter.fire(err));
    target.onMessage(msg => this.fromBrowserQueue.push(msg));
    this.fromSocketQueue.connect(data => target.send(data));
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    if (!this.disposed) {
      this.browserProcess?.dispose();
      this.socket?.close();
      this.disposed = true;
    }
  }

  private attachSocketLoop(url: URL, deadline: number) {
    if (this.disposed) {
      return;
    }

    const socket = new NodeWebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.setupSocket(socket, url, deadline);
  }

  private setupSocket(socket: InstanceType<typeof NodeWebSocket>, url: URL, deadline: number) {
    socket.addEventListener('open', () => {
      if (this.disposed) {
        socket.close();
        return;
      }

      this.socket = socket;
      this.socket.addEventListener('close', () => this.closeEmitter.fire());
      this.socket.addEventListener('message', (event: unknown) =>
        this.fromSocketQueue.push(normalizeMessage((event as { data: unknown }).data)),
      );
      this.fromBrowserQueue.connect(data => socket.send(data));
    });

    socket.addEventListener('error', (event: unknown) => {
      const err =
        typeof event === 'object' &&
        event !== null &&
        'error' in event &&
        (event as { error?: unknown }).error instanceof Error
          ? (event as { error: Error }).error
          : undefined;
      if (this.socket === socket || Date.now() > deadline) {
        this.errorEmitter.fire(err ?? new Error(`Error connecting websocket to ${url.toString()}`));
      } else {
        setTimeout(() => this.attachSocketLoop(url, deadline), 100);
      }
    });
  }
}
