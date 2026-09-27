import { EventEmitter } from "node:events";
import { createServer, Socket, type Server } from "node:net";
import { constants } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { THREAD_DELTA_NOTIFICATION_METHOD } from "../thread-delta.js";
import {
  createBridgeOutboundQueue,
  installBridgeStdioGuards,
  retryTransientSocketWriteFailures,
  type TransientWriteRetryOptions,
} from "./bridge-output.js";

const FAST_RETRY: TransientWriteRetryOptions = {
  baseDelayMs: 1,
  maxDelayMs: 4,
  budgetMs: 2_000,
};

const HANDLE_WRITE_METHODS = [
  "writev",
  "writeUtf8String",
  "writeBuffer",
  "writeLatin1String",
  "writeAsciiString",
  "writeUcs2String",
] as const;

interface ConnectedPair {
  client: Socket;
  received: () => string;
  closed: Promise<void>;
}

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function connectPair(): Promise<ConnectedPair> {
  let data = "";
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((peer) => {
    sockets.push(peer);
    peer.setEncoding("utf8");
    peer.on("data", (chunk: string) => {
      data += chunk;
    });
    peer.on("end", () => resolveClosed());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  const client = new Socket();
  sockets.push(client);
  await new Promise<void>((resolve) =>
    client.connect(address.port, "127.0.0.1", resolve),
  );
  return { client, received: () => data, closed };
}

function failHandleWrites(socket: Socket, failures: number): () => number {
  const handle: unknown = Reflect.get(socket, "_handle");
  if (typeof handle !== "object" || handle === null) {
    throw new Error("socket has no handle");
  }
  let remaining = failures;
  let failed = 0;
  for (const method of HANDLE_WRITE_METHODS) {
    const original: unknown = Reflect.get(handle, method);
    if (typeof original !== "function") continue;
    Reflect.set(handle, method, (...args: unknown[]): unknown => {
      if (remaining > 0) {
        remaining -= 1;
        failed += 1;
        return -constants.errno.ENOBUFS;
      }
      return Reflect.apply(original, handle, args);
    });
  }
  return () => failed;
}

function writeCorkedBatch(socket: Socket, lines: string[]): void {
  socket.cork();
  for (const line of lines) socket.write(line);
  socket.uncork();
}

function nextError(socket: Socket): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve) => socket.once("error", resolve));
}

describe("retryTransientSocketWriteFailures", () => {
  it("reproduces the unguarded crash: a synchronous ENOBUFS destroys the socket", async () => {
    const { client } = await connectPair();
    failHandleWrites(client, 1);
    const error = nextError(client);
    writeCorkedBatch(client, ["a\n", "b\n"]);
    await expect(error).resolves.toMatchObject({
      code: "ENOBUFS",
      syscall: "write",
    });
    expect(client.destroyed).toBe(true);
  });

  it("replays writev and single writes after synchronous ENOBUFS without loss or duplication", async () => {
    const { client, received, closed } = await connectPair();
    retryTransientSocketWriteFailures(client, FAST_RETRY);
    const failedWrites = failHandleWrites(client, 5);
    const errors: Error[] = [];
    client.on("error", (error) => errors.push(error));
    const lines = Array.from({ length: 200 }, (_, index) => `line-${index}\n`);
    writeCorkedBatch(client, lines.slice(0, 100));
    client.write(lines[100] ?? "");
    for (const line of lines.slice(101)) client.write(line);
    client.end();
    await closed;
    expect(errors).toEqual([]);
    expect(failedWrites()).toBe(5);
    expect(received()).toBe(lines.join(""));
  });

  it("surfaces the error once the retry budget is exhausted", async () => {
    const { client } = await connectPair();
    retryTransientSocketWriteFailures(client, {
      baseDelayMs: 1,
      maxDelayMs: 2,
      budgetMs: 20,
    });
    failHandleWrites(client, Number.POSITIVE_INFINITY);
    const error = nextError(client);
    client.write("never\n");
    await expect(error).resolves.toMatchObject({ code: "ENOBUFS" });
  });

  it("never replays a write whose ENOBUFS arrived asynchronously", async () => {
    const socket = new Socket();
    sockets.push(socket);
    let dispatches = 0;
    socket._write = (_chunk, _encoding, callback) => {
      dispatches += 1;
      setImmediate(() =>
        callback(
          Object.assign(new Error("write ENOBUFS"), { code: "ENOBUFS" }),
        ),
      );
    };
    retryTransientSocketWriteFailures(socket, FAST_RETRY);
    const error = nextError(socket);
    socket.write("partial\n");
    await expect(error).resolves.toMatchObject({ code: "ENOBUFS" });
    expect(dispatches).toBe(1);
  });
});

class FakeOutput extends EventEmitter {
  readonly lines: unknown[] = [];
  full = false;

  write(line: string): boolean {
    this.lines.push(JSON.parse(line));
    return !this.full;
  }

  drain(): void {
    this.full = false;
    this.emit("drain");
  }
}

function progress(threadId: string, itemId: string, message: string) {
  return {
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: {
      threadId,
      deltas: [
        { kind: "item.progress", key: { providerItemId: itemId }, message },
      ],
    },
  };
}

function snapshot(threadId: string, itemId: string, text: string) {
  return {
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: {
      threadId,
      deltas: [
        {
          kind: "command.outputSnapshot",
          key: { providerItemId: itemId },
          text,
        },
      ],
    },
  };
}

describe("createBridgeOutboundQueue", () => {
  it("writes straight through while the output accepts data", () => {
    const output = new FakeOutput();
    const send = createBridgeOutboundQueue(output);
    send(progress("thr_a", "tool_1", "one"));
    send(progress("thr_a", "tool_1", "two"));
    expect(output.lines).toEqual([
      progress("thr_a", "tool_1", "one"),
      progress("thr_a", "tool_1", "two"),
    ]);
  });

  it("keeps only the latest superseding snapshot per item while backpressured", () => {
    const output = new FakeOutput();
    const send = createBridgeOutboundQueue(output);
    output.full = true;
    send({ jsonrpc: "2.0", id: 1, result: "first" });
    for (let index = 0; index < 10_000; index += 1) {
      send(progress("thr_a", "agent_1", `a-${index}`));
      send(progress("thr_a", "agent_2", `b-${index}`));
      send(snapshot("thr_a", "bash_1", "x".repeat(index)));
    }
    const response = { jsonrpc: "2.0", id: 2, result: "kept" };
    send(response);
    send(progress("thr_b", "agent_1", "other thread"));
    expect(output.lines).toHaveLength(1);
    output.drain();
    expect(output.lines).toEqual([
      { jsonrpc: "2.0", id: 1, result: "first" },
      progress("thr_a", "agent_1", "a-9999"),
      progress("thr_a", "agent_2", "b-9999"),
      snapshot("thr_a", "bash_1", "x".repeat(9_999)),
      response,
      progress("thr_b", "agent_1", "other thread"),
    ]);
  });

  it("never drops ordered messages or flushed progress", () => {
    const output = new FakeOutput();
    const send = createBridgeOutboundQueue(output);
    output.full = true;
    send({ jsonrpc: "2.0", id: 0, result: null });
    const textDelta = (text: string) => ({
      jsonrpc: "2.0",
      method: THREAD_DELTA_NOTIFICATION_METHOD,
      params: {
        threadId: "thr_a",
        deltas: [
          {
            kind: "item.textDelta",
            key: { providerItemId: "msg_1" },
            channel: "assistant",
            text,
          },
        ],
      },
    });
    const flushed = {
      ...progress("thr_a", "tool_1", "flushed"),
      params: {
        threadId: "thr_a",
        deltas: [
          {
            kind: "item.progress",
            key: { providerItemId: "tool_1" },
            message: "flushed",
            flush: true,
          },
        ],
      },
    };
    send(textDelta("a"));
    send(flushed);
    send(textDelta("b"));
    send(flushed);
    output.drain();
    expect(output.lines.slice(1)).toEqual([
      textDelta("a"),
      flushed,
      textDelta("b"),
      flushed,
    ]);
  });

  it("stops flushing when the output fills again and resumes on the next drain", () => {
    const output = new FakeOutput();
    const send = createBridgeOutboundQueue(output);
    output.full = true;
    send({ id: 0 });
    send({ id: 1 });
    send({ id: 2 });
    output.write = function (line: string): boolean {
      this.lines.push(JSON.parse(line));
      return false;
    };
    output.drain();
    expect(output.lines).toEqual([{ id: 0 }, { id: 1 }]);
    send({ id: 3 });
    output.write = FakeOutput.prototype.write;
    output.drain();
    expect(output.lines).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }]);
  });
});

describe("installBridgeStdioGuards", () => {
  it("reports a stdout failure once and swallows stderr failures", () => {
    const stdout = new Socket();
    const stderr = new Socket();
    sockets.push(stdout, stderr);
    const failures: Error[] = [];
    installBridgeStdioGuards({
      stdout,
      stderr,
      onStdoutFailure: (error) => failures.push(error),
      retry: FAST_RETRY,
    });
    const enobufs = Object.assign(new Error("write ENOBUFS"), {
      code: "ENOBUFS",
    });
    expect(() => stderr.emit("error", enobufs)).not.toThrow();
    stdout.emit("error", enobufs);
    stdout.emit("error", enobufs);
    expect(failures).toEqual([enobufs]);
  });
});
