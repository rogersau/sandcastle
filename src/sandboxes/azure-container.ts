/**
 * Azure Container Instances isolated sandbox provider.
 *
 * ACI cannot bind-mount the host worktree, so this provider uses Sandcastle's
 * isolated-provider sync protocol and the ACI exec WebSocket for commands.
 * The Azure SDK and `ws` are loaded only when a sandbox is created.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

const DEFAULT_WORKTREE_PATH = "/home/agent/workspace";
const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_GB = 4;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TERMINAL_SIZE = { rows: 200, cols: 240 };
const DEFAULT_MAX_LIFETIME_SECONDS = 2 * 60 * 60;
const SHELL_READY_MARKER = "__SANDCASTLE_SHELL_READY__";
const SHELL_READY_SEQUENCE = `\n${SHELL_READY_MARKER}\n`;
const OUTPUT_START_MARKER = "__SANDCASTLE_OUTPUT_START__";
const OUTPUT_START_SEQUENCE = `\n${OUTPUT_START_MARKER}\n`;
const STDIN_READY_MARKER = "__SANDCASTLE_STDIN_READY__";
const STDIN_READY_SEQUENCE = `\n${STDIN_READY_MARKER}\n`;
const EXIT_MARKER = "__SANDCASTLE_EXIT_CODE__";
const EXIT_CODE_PATTERN = new RegExp(`\\n${EXIT_MARKER}(\\d+)\\n`);
const INPUT_CHUNK_SIZE = 8 * 1024;
const CANONICAL_INPUT_CHUNK_SIZE = 2 * 1024;

/** Credentials or managed identity used to pull a private image. */
export interface AzureContainerRegistryOptions {
  /** Registry login server without a protocol, e.g. `example.azurecr.io`. */
  readonly server: string;
  /** Registry username, when using username/password authentication. */
  readonly username?: string;
  /** Registry password, when using username/password authentication. */
  readonly password?: string;
  /** Resource ID of a user-assigned managed identity with pull access. */
  readonly identity?: string;
}

/** Options for the Azure Container Instances sandbox provider. */
export interface AzureContainerOptions {
  /** Azure subscription ID. Falls back to `AZURE_SUBSCRIPTION_ID`. */
  readonly subscriptionId?: string;
  /** Resource group for the temporary container group. Falls back to `AZURE_RESOURCE_GROUP`. */
  readonly resourceGroup?: string;
  /** Azure region for the container group. Falls back to `AZURE_LOCATION`. */
  readonly location?: string;
  /** Container image to run. Falls back to `AZURE_CONTAINER_IMAGE`. */
  readonly image?: string;
  /** Explicit container-group name. Otherwise a unique name is generated. */
  readonly containerGroupName?: string;
  /** Container name inside the group. Defaults to `agent`. */
  readonly containerName?: string;
  /** CPU request for the container. Defaults to 2. */
  readonly cpu?: number;
  /** Memory request in GiB. Defaults to 4. */
  readonly memoryInGB?: number;
  /** Command that keeps the container alive. */
  readonly command?: readonly string[];
  /** Maximum lifetime of the default keep-alive command. Defaults to 2 hours. */
  readonly maxLifetimeSeconds?: number;
  /** Optional private registry authentication. */
  readonly registry?: AzureContainerRegistryOptions;
  /** Optional user-assigned identity attached to the container group. */
  readonly identity?: string;
  /** Tags applied to the temporary container group. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /** Terminal size used for ACI exec sessions. */
  readonly terminalSize?: { readonly rows: number; readonly cols: number };
  /** Maximum retained streamed output per stream. Defaults to 64 KiB. */
  readonly maxOutputTailChars?: number;
  /** Maximum time to wait for the container to reach Running state. */
  readonly startupTimeoutMs?: number;
  /** Poll interval while waiting for the container to reach Running state. */
  readonly pollIntervalMs?: number;
}

type ContainerState = {
  readonly state?: string;
  readonly exitCode?: number;
  readonly detailStatus?: string;
  readonly reason?: string;
};

type ContainerGroupState = {
  readonly containers?: ReadonlyArray<{
    readonly instanceView?: { readonly currentState?: ContainerState };
  }>;
  readonly instanceView?: { readonly state?: string };
};

const requiredOption = (
  value: string | undefined,
  environmentName: string,
  optionName: string,
): string => {
  const resolved = value ?? process.env[environmentName];
  if (!resolved) {
    throw new Error(
      `Azure Container provider requires ${optionName} (pass it to azureContainer() or set ${environmentName}).`,
    );
  }
  return resolved;
};

const validateName = (value: string, label: string): void => {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(
      `Azure Container provider ${label} must be 1-63 lowercase letters, numbers, or hyphens and cannot end with a hyphen.`,
    );
  }
};

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const defaultCommand = (maxLifetimeSeconds: number): string[] => [
  "/bin/sh",
  "-c",
  `mkdir -p /home/agent/workspace && sleep ${maxLifetimeSeconds}`,
];

const toText = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data))
    return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
};

const createTarGz = (directory: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const process = spawn("tar", ["-czf", "-", "-C", directory, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    process.once("error", reject);
    process.once("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new Error(
            `Failed to archive '${directory}' with tar (exit ${exitCode}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });

const sendSocketText = (
  socket: { send(data: string, callback?: (error?: Error) => void): void },
  text: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    try {
      socket.send(text, (error?: Error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });

const sendSocketChunks = async (
  socket: { send(data: string, callback?: (error?: Error) => void): void },
  input: string,
): Promise<void> => {
  for (let offset = 0; offset < input.length; offset += INPUT_CHUNK_SIZE) {
    await sendSocketText(
      socket,
      input.slice(offset, offset + INPUT_CHUNK_SIZE),
    );
  }
};

const sendSocketInput = async (
  socket: { send(data: string, callback?: (error?: Error) => void): void },
  input: string,
  lineBreaks: boolean,
): Promise<void> => {
  const chunkSize = lineBreaks ? CANONICAL_INPUT_CHUNK_SIZE : INPUT_CHUNK_SIZE;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const chunk = input.slice(offset, offset + chunkSize);
    await sendSocketText(socket, lineBreaks ? `${chunk}\n` : chunk);
  }

  // ACI exposes a terminal rather than a half-close operation. Ctrl-D is the
  // terminal equivalent of closing stdin for commands such as base64 and tar.
  await sendSocketText(socket, "\u0004");
};

const extractExitCode = (
  output: string,
): { readonly stdout: string; readonly exitCode: number } => {
  const normalized = output.replace(/\r\n/g, "\n");
  const outputStartIndex = normalized.indexOf(OUTPUT_START_SEQUENCE);
  if (outputStartIndex < 0) {
    return { stdout: output, exitCode: 0 };
  }

  const payloadStart = outputStartIndex + OUTPUT_START_SEQUENCE.length;
  const match = normalized.slice(payloadStart).match(EXIT_CODE_PATTERN);
  if (!match || match.index === undefined) {
    return { stdout: output, exitCode: 0 };
  }

  return {
    stdout: normalized
      .slice(payloadStart, payloadStart + match.index)
      .replace(STDIN_READY_SEQUENCE, ""),
    exitCode: Number(match[1]),
  };
};

const buildRemoteCommand = (
  command: string,
  cwd: string,
  sudo: boolean,
  hasStdin: boolean,
): string => {
  const effectiveCommand = sudo ? `sudo ${command}` : command;
  const runCommand = hasStdin
    ? `if [ "$code" -eq 0 ]; then printf '\\n${STDIN_READY_MARKER}\\n'; ${effectiveCommand}; code=$?; fi`
    : `if [ "$code" -eq 0 ]; then ${effectiveCommand}; code=$?; fi`;
  const body = [
    // The shell bootstrap is noncanonical so the command itself can be
    // streamed reliably. Restore canonical mode before a command consumes
    // stdin, then announce that boundary before the client sends Ctrl-D.
    ...(hasStdin ? ["stty icanon -echo"] : []),
    `printf '\\n${OUTPUT_START_MARKER}\\n'`,
    `cd ${shellQuote(cwd)}`,
    "code=$?",
    runCommand,
    `printf '\\n${EXIT_MARKER}%s\\n' "$code"`,
    'exit "$code"',
  ].join("\n");
  return body;
};

const buildShellBootstrap = (): string =>
  [
    // ACI exec sessions are backed by a PTY. Disable canonical input and
    // input echo before sending any large command input.
    "stty -icanon -echo 2>/dev/null || true",
    "PS1=",
    `printf '\\n${SHELL_READY_MARKER}\\n'`,
  ].join("\n");

const waitForRunning = async (
  client: {
    containerGroups: {
      get(resourceGroup: string, name: string): Promise<ContainerGroupState>;
    };
  },
  resourceGroup: string,
  groupName: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";

  while (Date.now() < deadline) {
    const group = await client.containerGroups.get(resourceGroup, groupName);
    const containerState = group.containers?.[0]?.instanceView?.currentState;
    lastState = containerState?.state ?? group.instanceView?.state ?? lastState;

    if (lastState.toLowerCase() === "running") return;
    if (["terminated", "failed", "crashed"].includes(lastState.toLowerCase())) {
      throw new Error(
        `Azure container '${groupName}' did not start (state ${lastState}, exit ${containerState?.exitCode ?? "unknown"}${containerState?.detailStatus ? `, ${containerState.detailStatus}` : ""}).`,
      );
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Azure container '${groupName}' did not reach Running state within ${timeoutMs}ms (last state: ${lastState}).`,
  );
};

/**
 * Create an isolated Azure Container Instances sandbox provider.
 *
 * Authentication uses `DefaultAzureCredential`, so local Azure CLI login,
 * managed identity, workload identity, and service-principal environment
 * variables are all supported by the Azure SDK.
 *
 * The container image must contain `git`, `sh`, `base64`, and `tar`, and must
 * remain running until Sandcastle closes the provider.
 */
export const azureContainer = (
  options?: AzureContainerOptions,
): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "azure-container",
    env: options?.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const subscriptionId = requiredOption(
        options?.subscriptionId,
        "AZURE_SUBSCRIPTION_ID",
        "subscriptionId",
      );
      const resourceGroup = requiredOption(
        options?.resourceGroup,
        "AZURE_RESOURCE_GROUP",
        "resourceGroup",
      );
      const location = requiredOption(
        options?.location,
        "AZURE_LOCATION",
        "location",
      );
      const image = requiredOption(
        options?.image,
        "AZURE_CONTAINER_IMAGE",
        "image",
      );
      const groupName =
        options?.containerGroupName ??
        `sandcastle-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const containerName = options?.containerName ?? "agent";
      const maxLifetimeSeconds =
        options?.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
      if (!Number.isFinite(maxLifetimeSeconds) || maxLifetimeSeconds <= 0) {
        throw new Error("maxLifetimeSeconds must be a positive finite number.");
      }
      validateName(groupName, "containerGroupName");
      validateName(containerName, "containerName");

      const [
        { ContainerInstanceManagementClient },
        { DefaultAzureCredential },
      ] = await Promise.all([
        import("@azure/arm-containerinstance"),
        import("@azure/identity"),
      ]);
      const client = new ContainerInstanceManagementClient(
        new DefaultAzureCredential(),
        subscriptionId,
      );

      const registry = options?.registry;
      const environmentVariables = Object.entries(createOptions.env).map(
        ([name, value]) => ({ name, secureValue: value }),
      );
      const identity = options?.identity ?? registry?.identity;
      const containerGroup = {
        location,
        tags: options?.tags ? { ...options.tags } : undefined,
        ...(identity
          ? {
              identity: {
                type: "UserAssigned" as const,
                userAssignedIdentities: { [identity]: {} },
              },
            }
          : {}),
        osType: "Linux" as const,
        // The default command exits successfully after its safety lifetime,
        // so Never stops billing if the host process disappears unexpectedly.
        restartPolicy: "Never" as const,
        containers: [
          {
            name: containerName,
            image,
            command: [
              ...(options?.command ?? defaultCommand(maxLifetimeSeconds)),
            ],
            environmentVariables,
            resources: {
              requests: {
                cpu: options?.cpu ?? DEFAULT_CPU,
                memoryInGB: options?.memoryInGB ?? DEFAULT_MEMORY_GB,
              },
            },
          },
        ],
        ...(registry
          ? {
              imageRegistryCredentials: [
                {
                  server: registry.server,
                  ...(registry.username ? { username: registry.username } : {}),
                  ...(registry.password ? { password: registry.password } : {}),
                  ...(registry.identity ? { identity: registry.identity } : {}),
                },
              ],
            }
          : {}),
      };

      let created = false;
      try {
        await client.containerGroups.beginCreateOrUpdateAndWait(
          resourceGroup,
          groupName,
          containerGroup,
        );
        created = true;
        await waitForRunning(
          client,
          resourceGroup,
          groupName,
          options?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
          options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        );
      } catch (error) {
        if (created) {
          await client.containerGroups
            .beginDeleteAndWait(resourceGroup, groupName)
            .catch(() => {});
        }
        throw error;
      }

      const terminalSize = options?.terminalSize ?? DEFAULT_TERMINAL_SIZE;
      const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;

      const exec = async (
        command: string,
        opts?: {
          onLine?: (line: string) => void;
          cwd?: string;
          sudo?: boolean;
          stdin?: string;
          stdinLineBreaks?: boolean;
        },
      ): Promise<ExecResult> => {
        const remoteScript = buildRemoteCommand(
          command,
          opts?.cwd ?? DEFAULT_WORKTREE_PATH,
          opts?.sudo ?? false,
          opts?.stdin !== undefined,
        );
        const response = await client.containers.executeCommand(
          resourceGroup,
          groupName,
          containerName,
          {
            // ACI's exec API starts a single process; shell commands and
            // arguments are entered through the interactive WebSocket.
            command: "/bin/sh",
            terminalSize,
          },
        );
        const webSocketUri = response.webSocketUri;
        const password = response.password;
        if (!webSocketUri || !password) {
          throw new Error(
            `Azure did not return an exec WebSocket for container '${groupName}'.`,
          );
        }

        const { WebSocket } = await import("ws");
        const socket = new WebSocket(webSocketUri);

        const stdoutTail = opts?.onLine
          ? new BoundedTail(maxOutputTailChars, "\n")
          : undefined;
        const rawOutput = await new Promise<string>((resolve, reject) => {
          const chunks: string[] = [];
          let pending = "";
          let readyPending = "";
          let shellReady = false;
          let stdinReady = opts?.stdin === undefined;
          let outputStarted = false;
          let markerSeen = false;
          let settled = false;
          let resolveShellReady!: () => void;
          let rejectShellReady!: (error: Error) => void;
          let resolveStdinReady!: () => void;
          let rejectStdinReady!: (error: Error) => void;
          const shellReadyPromise = new Promise<void>((ready, failed) => {
            resolveShellReady = ready;
            rejectShellReady = failed;
          });
          const stdinReadyPromise =
            opts?.stdin === undefined
              ? Promise.resolve()
              : new Promise<void>((ready, failed) => {
                  resolveStdinReady = ready;
                  rejectStdinReady = failed;
                });
          void shellReadyPromise.catch(() => undefined);
          void stdinReadyPromise.catch(() => undefined);

          const emitLine = (line: string): void => {
            const normalized = line.replace(/\r$/, "");
            stdoutTail?.push(normalized);
            opts?.onLine?.(normalized);
          };

          const processShellReady = (text: string): void => {
            if (shellReady) return;
            readyPending += text.replace(/\r\n/g, "\n");
            if (readyPending.includes(SHELL_READY_SEQUENCE)) {
              shellReady = true;
              resolveShellReady();
              return;
            }
            readyPending = readyPending.slice(
              -(SHELL_READY_SEQUENCE.length - 1),
            );
          };

          const processOutput = (text: string): void => {
            if (markerSeen) return;
            pending += text.replace(/\r\n/g, "\n");

            if (!outputStarted) {
              const outputStartIndex = pending.indexOf(OUTPUT_START_SEQUENCE);
              if (outputStartIndex < 0) {
                pending = pending.slice(-(OUTPUT_START_SEQUENCE.length - 1));
                return;
              }
              pending = pending.slice(
                outputStartIndex + OUTPUT_START_SEQUENCE.length,
              );
              outputStarted = true;
            }

            if (!stdinReady) {
              const stdinReadyIndex = pending.indexOf(STDIN_READY_SEQUENCE);
              if (stdinReadyIndex < 0) {
                pending = pending.slice(-(STDIN_READY_SEQUENCE.length - 1));
                return;
              }
              pending = pending.slice(
                stdinReadyIndex + STDIN_READY_SEQUENCE.length,
              );
              stdinReady = true;
              resolveStdinReady();
            }

            const exitMatch = pending.match(EXIT_CODE_PATTERN);
            if (exitMatch?.index !== undefined) {
              if (opts?.onLine) {
                const payload = pending.slice(0, exitMatch.index);
                const lines = payload.split("\n");
                const last = lines.pop();
                for (const line of lines) emitLine(line);
                if (last) emitLine(last);
              }
              pending = "";
              markerSeen = true;
              // ACI can emit the completion marker without closing the exec
              // WebSocket. The marker is our framed command boundary, so do
              // not wait indefinitely for a transport-level close event. A
              // graceful close can itself remain pending with ACI and block
              // the next exec session, so destroy this client transport.
              finish();
              socket.terminate();
              return;
            }

            if (!opts?.onLine) {
              // Keep only enough data to recognize a marker split across
              // WebSocket frames; the complete output remains in chunks.
              pending = pending.slice(-(EXIT_MARKER.length + 32));
              return;
            }

            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) emitLine(line);
          };

          const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            if (!shellReady) {
              rejectShellReady(
                error ??
                  new Error(
                    `Azure exec WebSocket closed before shell startup for command '${command}'.`,
                  ),
              );
            }
            if (!stdinReady) {
              rejectStdinReady(
                error ??
                  new Error(
                    `Azure exec WebSocket closed before stdin was ready for command '${command}'.`,
                  ),
              );
            }
            if (error) socket.close();
            if (error) reject(error);
            else resolve(chunks.join(""));
          };

          socket.once("open", () => {
            void (async () => {
              try {
                await sendSocketText(socket, password);
                await sendSocketChunks(socket, `${buildShellBootstrap()}\n`);
                await shellReadyPromise;
                await sendSocketChunks(socket, `${remoteScript}\n`);
                if (opts?.stdin !== undefined) {
                  await stdinReadyPromise;
                  await sendSocketInput(
                    socket,
                    opts.stdin,
                    opts.stdinLineBreaks ?? false,
                  );
                }
              } catch (error) {
                finish(
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
            })();
          });
          socket.on("message", (data: unknown) => {
            const text = toText(data);
            chunks.push(text);
            processShellReady(text);
            processOutput(text);
          });
          socket.once("error", (error: Error) => finish(error));
          socket.once("close", () => {
            if (markerSeen) {
              finish();
            } else {
              finish(
                new Error(
                  `Azure exec WebSocket closed before command '${command}' completed.`,
                ),
              );
            }
          });
        });

        const result = extractExitCode(rawOutput);
        if (opts?.onLine) {
          return {
            stdout: stdoutTail?.toString() ?? "",
            stderr: "",
            exitCode: result.exitCode,
          };
        }
        return { stdout: result.stdout, stderr: "", exitCode: result.exitCode };
      };

      return {
        worktreePath: DEFAULT_WORKTREE_PATH,
        exec,

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            const archive = await createTarGz(hostPath);
            const result = await exec(
              `mkdir -p ${shellQuote(sandboxPath)} && base64 --decode | tar --extract --gzip --directory ${shellQuote(sandboxPath)}`,
              {
                stdin: archive.toString("base64"),
                stdinLineBreaks: true,
              },
            );
            if (result.exitCode !== 0) {
              throw new Error(
                `Failed to copy directory '${hostPath}' into Azure container: ${result.stdout}`,
              );
            }
            return;
          }

          const content = (await readFile(hostPath)).toString("base64");
          const result = await exec(
            `mkdir -p ${shellQuote(dirname(sandboxPath))} && base64 --decode > ${shellQuote(sandboxPath)}`,
            { stdin: content, stdinLineBreaks: true },
          );
          if (result.exitCode !== 0) {
            throw new Error(
              `Failed to copy '${hostPath}' into Azure container: ${result.stdout}`,
            );
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          const result = await exec(
            `base64 ${shellQuote(sandboxPath)} | tr -d '\\r\\n'`,
          );
          if (result.exitCode !== 0) {
            throw new Error(
              `Failed to copy '${sandboxPath}' out of Azure container: ${result.stdout}`,
            );
          }
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(
            hostPath,
            Buffer.from(result.stdout.trim(), "base64"),
          );
        },

        close: async (): Promise<void> => {
          await client.containerGroups.beginDeleteAndWait(
            resourceGroup,
            groupName,
          );
        },
      };
    },
  });
