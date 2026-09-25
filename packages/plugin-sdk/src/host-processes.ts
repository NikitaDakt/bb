import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  killProcessesWithCwdUnder,
  type ProcessWithCwd,
} from "@bb/process-utils";

const sweepResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    processes: z.array(
      z.object({
        pid: z.number().int().positive(),
        cwd: z.string(),
        approximateCwd: z.boolean().optional(),
        matchEvidence: z
          .enum([
            "spawn-registry",
            "executable-path",
            "command-line",
            "descendant",
          ])
          .optional(),
      }),
    ),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export async function experimental_killProcessesWithCwdUnder(
  args: Parameters<typeof killProcessesWithCwdUnder>[0],
): Promise<ProcessWithCwd[]> {
  if (
    (args.platform ?? process.platform) !== "win32" ||
    process.env.BB_HOST_WORKER_PID !== String(process.pid)
  ) {
    return killProcessesWithCwdUnder(args);
  }
  const parent = await new Promise<ProcessWithCwd[]>((resolve, reject) => {
    if (!process.connected || process.send === undefined) {
      reject(new Error("Daemon disconnected before workspace process cleanup"));
      return;
    }
    const requestId = randomUUID();
    const finish = (error?: Error, processes: ProcessWithCwd[] = []) => {
      clearTimeout(timer);
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", onDisconnect);
      if (error !== undefined) reject(error);
      else resolve(processes);
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "process-sweep-result" ||
        !("requestId" in message) ||
        message.requestId !== requestId
      )
        return;
      const parsed = sweepResultSchema.safeParse(message);
      if (!parsed.success) {
        finish(new Error("Invalid daemon workspace process cleanup result"));
      } else if (!parsed.data.ok) {
        finish(new Error(parsed.data.error));
      } else {
        finish(undefined, parsed.data.processes);
      }
    };
    const onDisconnect = () =>
      finish(new Error("Daemon disconnected during workspace process cleanup"));
    const timer = setTimeout(
      () => finish(new Error("Daemon workspace process cleanup timed out")),
      120_000,
    );
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    try {
      process.send(
        {
          type: "process-sweep",
          requestId,
          directory: args.directory,
          graceMs: args.graceMs,
        },
        (error) => {
          if (error) finish(error);
        },
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const local = await killProcessesWithCwdUnder(args);
  return [
    ...new Map(
      [...local, ...parent].map((entry) => [entry.pid, entry]),
    ).values(),
  ];
}
