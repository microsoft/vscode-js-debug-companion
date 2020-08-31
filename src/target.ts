/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess } from 'child_process';
import split2 from 'split2';
import { PassThrough, Readable, Writable } from 'stream';
import { CancellationTokenSource, Event, EventEmitter } from 'vscode';
import WebSocket from 'ws';
import { retryGetWSEndpoint } from './getWsEndpoint';

export interface ITarget {
  readonly input: Writable;
  readonly output: Readable;
  readonly onError: Event<Error>;
  readonly onClose: Event<void>;

  dispose(): Promise<void>;
}

/**
 * A debug target that sends data through the target's stdio streams.
 */
export class PipedTarget implements ITarget {
  private errorEmitter = new EventEmitter<Error>();
  private closeEmitter = new EventEmitter<void>();

  public readonly onError = this.errorEmitter.event;
  public readonly onClose = this.closeEmitter.event;

  constructor(private readonly process: ChildProcess) {
    if (this.process.stdio.length < 5) {
      throw new Error('Insufficient fd number on child process');
    }

    process.on('error', e => this.errorEmitter.fire(e));
    process.on('exit', () => this.closeEmitter.fire());
  }

  public get input() {
    return this.process.stdio[3] as Writable;
  }

  public get output() {
    return this.process.stdio[4] as Readable;
  }

  public dispose() {
    this.process.kill();
    return Promise.resolve();
  }
}

/**
 * Attaches to a debug target on the given host and port.
 */
export class AttachTarget implements ITarget {
  private errorEmitter = new EventEmitter<Error>();
  private closeEmitter = new EventEmitter<void>();

  public readonly onError = this.errorEmitter.event;
  public readonly onClose = this.closeEmitter.event;

  public static async create(host: string, port: number) {
    const cts = new CancellationTokenSource();
    setTimeout(() => cts.cancel(), 10 * 1000);

    const endpoint = await retryGetWSEndpoint(`http://${host}:${port}`, cts.token);
    const ws = new WebSocket(endpoint, [], {
      headers: { host: 'localhost' },
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
      followRedirects: true,
    });

    return await new Promise<ITarget>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(new AttachTarget(ws)));
      ws.addEventListener('error', errorEvent => reject(errorEvent.error));
    });
  }

  protected constructor(private readonly ws: WebSocket) {
    ws.on('error', evt => this.errorEmitter.fire(evt));
    ws.on('close', () => this.closeEmitter.fire());
  }

  public get input() {
    const s2 = split2('\0');

    s2.pipe(
      new Writable({
        write: (chunk, _encoding, next) => {
          this.ws.send(chunk.toString(), next);
        },
      }),
    );

    return s2;
  }

  public get output() {
    const delimiter = Buffer.alloc(1, 0);
    const r = new PassThrough();
    this.ws.on('message', data =>
      r.push(Buffer.concat([data instanceof Buffer ? data : Buffer.from(data), delimiter])),
    );
    this.ws.on('close', () => r.push(null));

    return r;
  }

  public async dispose() {
    await new Promise(r => {
      this.ws.on('close', r);
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

  public readonly onError = this.errorEmitter.event;
  public readonly onClose = this.closeEmitter.event;

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

  protected constructor(private readonly process: ChildProcess, private readonly attach: ITarget) {
    process.on('error', e => this.errorEmitter.fire(e));
    process.on('close', () => this.closeEmitter.fire());
    attach.onError(err => this.errorEmitter.fire(err));
    attach.onClose(() => this.closeEmitter.fire());
  }

  public get input() {
    return this.attach.input;
  }

  public get output() {
    return this.attach.output;
  }

  public dispose() {
    this.process.kill();
    return this.attach.dispose();
  }
}
