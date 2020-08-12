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
  public attachSocket(socket: Socket) {
    if (this.disposed) {
      socket.destroy();
      return;
    }

    this.socket = socket;
    socket.on('close', () => this.closeEmitter.fire());
    socket.on('error', err => this.errorEmitter.fire(err));

    this.tryActivate();
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
      this.disposed = true;
    }
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
