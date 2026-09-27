import { Socket } from "node:net";
import type { Writable } from "node:stream";
import { z } from "zod";
import { THREAD_DELTA_NOTIFICATION_METHOD } from "../thread-delta.js";

const TRANSIENT_WRITE_ERROR_CODES = new Set(["ENOBUFS", "ENOMEM"]);

export interface TransientWriteRetryOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  budgetMs: number;
}

export const DEFAULT_TRANSIENT_WRITE_RETRY: TransientWriteRetryOptions = {
  baseDelayMs: 5,
  maxDelayMs: 1_000,
  budgetMs: 30_000,
};

type WriteCallback = (error?: Error | null) => void;

function isTransientWriteError(error: Error | null | undefined): boolean {
  if (!error) return false;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && TRANSIENT_WRITE_ERROR_CODES.has(code);
}

export function retryTransientSocketWriteFailures(
  socket: Socket,
  options: TransientWriteRetryOptions = DEFAULT_TRANSIENT_WRITE_RETRY,
): void {
  const dispatchWithRetry = (
    dispatch: (callback: WriteCallback) => void,
    callback: WriteCallback,
  ): void => {
    const deadline = Date.now() + options.budgetMs;
    let delayMs = options.baseDelayMs;
    const attempt = (): void => {
      let dispatching = true;
      dispatch((error) => {
        if (
          dispatching &&
          isTransientWriteError(error) &&
          !socket.destroyed &&
          Date.now() + delayMs <= deadline
        ) {
          const retryDelayMs = delayMs;
          delayMs = Math.min(delayMs * 2, options.maxDelayMs);
          setTimeout(attempt, retryDelayMs);
          return;
        }
        callback(error);
      });
      dispatching = false;
    };
    attempt();
  };

  const write = socket._write;
  socket._write = (chunk, encoding, callback) => {
    dispatchWithRetry(
      (retryCallback) => write.call(socket, chunk, encoding, retryCallback),
      callback,
    );
  };
  const writev = socket._writev;
  if (writev) {
    socket._writev = (chunks, callback) => {
      dispatchWithRetry(
        (retryCallback) => writev.call(socket, chunks, retryCallback),
        callback,
      );
    };
  }
}

export function installBridgeStdioGuards(args: {
  stdout: Writable;
  stderr: Writable;
  onStdoutFailure: (error: Error) => void;
  retry?: TransientWriteRetryOptions;
}): void {
  for (const stream of [args.stdout, args.stderr]) {
    if (stream instanceof Socket) {
      retryTransientSocketWriteFailures(stream, args.retry);
    }
  }
  args.stderr.on("error", () => undefined);
  let failed = false;
  args.stdout.on("error", (error) => {
    if (failed) return;
    failed = true;
    args.onStdoutFailure(error);
  });
}

const supersedableDeltaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("item.progress"),
    key: z.unknown(),
    flush: z.literal(false).optional(),
  }),
  z.object({
    kind: z.literal("command.outputSnapshot"),
    key: z.unknown(),
  }),
]);

const supersedableNotificationSchema = z.object({
  method: z.literal(THREAD_DELTA_NOTIFICATION_METHOD),
  params: z.object({
    threadId: z.string(),
    deltas: z.array(supersedableDeltaSchema).min(1),
  }),
});

function supersedeKeyOf(message: unknown): string | null {
  const parsed = supersedableNotificationSchema.safeParse(message);
  if (!parsed.success) return null;
  return `s:${JSON.stringify([
    parsed.data.params.threadId,
    parsed.data.params.deltas.map((delta) => [delta.kind, delta.key]),
  ])}`;
}

export interface BridgeOutput {
  write(line: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

export function createBridgeOutboundQueue(
  output: BridgeOutput,
): (message: unknown) => void {
  const pending = new Map<string, string>();
  let nextOrderedKey = 0;
  let waitingForDrain = false;

  const writeLine = (line: string): void => {
    if (!output.write(line)) {
      waitingForDrain = true;
      output.once("drain", flush);
    }
  };

  const flush = (): void => {
    waitingForDrain = false;
    for (const [key, line] of pending) {
      pending.delete(key);
      writeLine(line);
      if (waitingForDrain) return;
    }
  };

  return (message) => {
    const line = `${JSON.stringify(message)}\n`;
    if (!waitingForDrain) {
      writeLine(line);
      return;
    }
    const key = supersedeKeyOf(message) ?? `o:${nextOrderedKey++}`;
    pending.delete(key);
    pending.set(key, line);
  };
}
