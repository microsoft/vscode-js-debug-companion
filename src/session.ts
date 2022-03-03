/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import { Disposable, EventEmitter } from 'vscode';
import WebSocket from 'ws';
import { ITarget } from './target';

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
  private socket?: WebSocket;

  private fromSocketQueue = new MessageQueue<WebSocket.RawData>();
  private fromBrowserQueue = new MessageQueue<WebSocket.RawData>();

  constructor() {
    this.onClose(() => this.dispose());
    this.onError(() => this.dispose());
  }

  /**
   * Attaches the socket looping back up to js-debug.
   */
  public attachSocket(host: string, port: number, path: string) {
    const url = new URL(`ws://${host}:${port}${path}`);
    this.attachSocketLoop(url, Date.now() + 5000);
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

  /**
   * It seems there may be some latency before the port becomes available
   * in WSL -- even though js-debug waits for the `listening` event and the
   * events round trip though DAP and VS Code. This function will repeatedly
   * try to connect to the socket.
   */
  private attachSocketLoop(url: URL, deadline: number) {
    if (this.disposed) {
      return;
    }

    const socket = new WebSocket(url, { perMessageDeflate: true });

    socket.on('open', () => {
      if (this.disposed) {
        socket.close();
        return;
      }

      this.socket = socket;
      this.socket.on('close', () => this.closeEmitter.fire());
      this.socket.on('message', data => this.fromSocketQueue.push(data));
      this.fromBrowserQueue.connect(data => socket.send(data));
    });

    socket.on('error', err => {
      if (this.socket === socket || Date.now() > deadline) {
        this.errorEmitter.fire(err);
      } else {
        setTimeout(() => this.attachSocketLoop(url, deadline), 100);
      }
    });
  }
}
