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
const EXIT_MARKER = "__SANDCASTLE_EXIT_CODE__";
const INPUT_CHUNK_SIZE = 32 * 1024;

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

const sendSocketInput = async (
  socket: { send(data: string, callback?: (error?: Error) => void): void },
  input: string,
): Promise<void> => {
  for (let offset = 0; offset < input.length; offset += INPUT_CHUNK_SIZE) {
    await sendSocketText(
      socket,
      input.slice(offset, offset + INPUT_CHUNK_SIZE),
    );
  }

  // ACI exposes a terminal rather than a half-close operation. Ctrl-D is the
  // terminal equivalent of closing stdin for commands such as base64 and tar.
  await sendSocketText(socket, "\u0004");
};

const extractExitCode = (
  output: string,
): { readonly stdout: string; readonly exitCode: number } => {
  const match = output.match(new RegExp(`${EXIT_MARKER}(\\d+)`));
  if (!match || match.index === undefined) {
    return { stdout: output, exitCode: 0 };
  }

  return {
    stdout: output.slice(0, match.index),
    exitCode: Number(match[1]),
  };
};

const buildRemoteCommand = (
  command: string,
  cwd: string,
  sudo: boolean,
): string => {
  const effectiveCommand = sudo ? `sudo ${command}` : command;
  const body = [
    `cd ${shellQuote(cwd)}`,
    "code=$?",
    `if [ "$code" -eq 0 ]; then ${effectiveCommand}; code=$?; fi`,
    `printf '\\n${EXIT_MARKER}%s\\n' "$code"`,
    'exit "$code"',
  ].join("; ");
  return `sh -c ${shellQuote(body)}`;
};

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
        },
      ): Promise<ExecResult> => {
        const response = await client.containers.executeCommand(
          resourceGroup,
          groupName,
          containerName,
          {
            command: buildRemoteCommand(
              command,
              opts?.cwd ?? DEFAULT_WORKTREE_PATH,
              opts?.sudo ?? false,
            ),
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
          let markerSeen = false;
          let settled = false;

          const emitLine = (line: string): void => {
            const normalized = line.replace(/\r$/, "");
            stdoutTail?.push(normalized);
            opts?.onLine?.(normalized);
          };

          const processForStreaming = (text: string): void => {
            if (!opts?.onLine || markerSeen) return;
            pending += text.replace(/\r\n/g, "\n");
            const markerIndex = pending.indexOf(EXIT_MARKER);
            if (markerIndex >= 0) {
              const beforeMarker = pending.slice(0, markerIndex);
              const lines = beforeMarker.split("\n");
              const last = lines.pop();
              for (const line of lines) emitLine(line);
              if (last) emitLine(last);
              pending = "";
              markerSeen = true;
              return;
            }
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) emitLine(line);
          };

          const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            if (!markerSeen && opts?.onLine && pending) {
              const markerIndex = pending.indexOf(EXIT_MARKER);
              const finalOutput =
                markerIndex >= 0 ? pending.slice(0, markerIndex) : pending;
              if (finalOutput) emitLine(finalOutput);
            }
            if (error) socket.close();
            if (error) reject(error);
            else resolve(chunks.join(""));
          };

          socket.once("open", () => {
            void (async () => {
              try {
                await sendSocketText(socket, password);
                if (opts?.stdin !== undefined) {
                  await sendSocketInput(socket, opts.stdin);
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
            processForStreaming(text);
          });
          socket.once("error", (error: Error) => finish(error));
          socket.once("close", () => finish());
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
              { stdin: archive.toString("base64") },
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
            { stdin: content },
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
