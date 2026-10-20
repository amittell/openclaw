import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { vi } from "vitest";
import type { TelegramIngressWorkerMessage } from "./telegram-ingress-worker.js";

export type WorkerPollSuccessListener = (message: {
  type: "poll-success";
  offset: null;
  count: number;
  finishedAt: number;
}) => void;
export type WorkerPollErrorListener = (message: {
  type: "poll-error";
  message: string;
  errorCode?: number;
  finishedAt: number;
}) => void;
export type WorkerMessageListener = (message: TelegramIngressWorkerMessage) => void;
type TestWorkerMessage =
  | TelegramIngressWorkerMessage
  | { type: "poll-success"; finishedAt: number; count: number }
  | { type: "poll-error"; finishedAt: number; message: string };

export function createIdleIngressWorker() {
  let stopWorker: (() => void) | undefined;
  const workerDone = new Promise<void>((resolve) => {
    stopWorker = resolve;
  });
  const workerStop = vi.fn(async () => {
    stopWorker?.();
  });
  const createWorker = vi.fn(() => ({
    onMessage: vi.fn(() => () => undefined),
    stop: workerStop,
    task: vi.fn(async () => {
      await workerDone;
    }),
  }));
  return {
    createWorker,
    stop: () => stopWorker?.(),
    workerStop,
  };
}

export function createListeningIngressWorker() {
  let listener: WorkerMessageListener | undefined;
  const listening = createDeferred<void>();
  const firstAck = createDeferred<void>();
  const idle = createIdleIngressWorker();
  const ackSpooledUpdate = vi.fn(() => firstAck.resolve());
  const createWorker = vi.fn(() => {
    const worker = idle.createWorker();
    return {
      ...worker,
      ackSpooledUpdate,
      onMessage: vi.fn((nextListener: WorkerMessageListener) => {
        listener = nextListener;
        listening.resolve();
        return () => undefined;
      }),
    };
  });
  return {
    ackSpooledUpdate,
    firstAck: firstAck.promise,
    createWorker,
    emit: (message: TestWorkerMessage) => listener?.(message as TelegramIngressWorkerMessage),
    hasListener: () => listener !== undefined,
    listening: listening.promise,
    stop: idle.stop,
    workerStop: idle.workerStop,
  };
}
