/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Socket } from 'net';
import { Disposable, EventEmitter } from 'vscode';
import { createGunzip, createGzip } from 'zlib';
import { ITarget } from './target';

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
  private socket?: Socket;

  constructor() {
    this.onClose(() => this.dispose());
    this.onError(() => this.dispose());
  }

  /**
   * Attaches the socket looping back up to js-debug.
   */
  public attachSocket(host: string, port: number) {
    this.attachSocketLoop(host, port, Date.now() + 5000);
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

    this.tryActivate();
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    if (!this.disposed) {
      this.browserProcess?.dispose();
      // the browser process closing will cause the connection to drain and close
      this.disposed = true;
    }
  }

  /**
   * It seems there may be some latency before the port becomes available
   * in WSL -- even though js-debug waits for the `listening` event and the
   * events round trip though DAP and VS Code. This function will repeatedly
   * try to connect to the socket.
   */
  private attachSocketLoop(host: string, port: number, deadline: number) {
    if (this.disposed) {
      return;
    }

    const socket = new Socket().connect({ port: Number(port), host });

    socket.on('connect', () => {
      if (this.disposed) {
        socket.destroy();
        return;
      }

      this.socket = socket;
      this.socket.on('close', () => this.closeEmitter.fire());
      this.tryActivate();
    });

    socket.on('error', err => {
      if (this.socket === socket || Date.now() > deadline) {
        this.errorEmitter.fire(err);
      } else {
        setTimeout(() => this.attachSocketLoop(host, port, deadline), 100);
      }
    });
  }

  private tryActivate() {
    if (!this.browserProcess || !this.socket) {
      return;
    }

    const compressor = createGzip();
    const cpOut = this.browserProcess.output;
    cpOut.pipe(compressor).pipe(this.socket).resume();
    cpOut.on('data', (data: Buffer) => {
      if (data.includes(0)) {
        compressor.flush(2 /* Z_SYNC_FLUSH */);
      }
    });

    this.socket.pipe(createGunzip()).pipe(this.browserProcess.input);
  }
}
