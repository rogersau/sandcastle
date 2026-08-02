import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { azureContainer } from "./azure-container.js";

const azureMocks = vi.hoisted(() => {
  const createOrUpdate = vi.fn().mockResolvedValue({});
  const get = vi.fn().mockResolvedValue({
    containers: [{ instanceView: { currentState: { state: "Running" } } }],
  });
  const deleteGroup = vi.fn().mockResolvedValue({});
  let closeAfterCommand = true;
  let activeSockets = 0;
  let terminateCount = 0;
  let stdinReadySignalSent = false;
  let stdinSentBeforeReady = false;
  let commandOutput = "hello";
  const commandScripts: string[] = [];
  const sentStdin: string[] = [];
  const executeCommand = vi.fn().mockImplementation(async () => {
    if (activeSockets > 0) {
      throw new Error("previous ACI exec transport is still open");
    }
    return {
      webSocketUri: "wss://example.test/exec",
      password: "password",
    };
  });

  class FakeWebSocket {
    static readonly OPEN = 1;
    private readonly listeners = new Map<
      string,
      Array<(...args: any[]) => void>
    >();
    private closed = false;
    private awaitingStdin = false;

    constructor(_url: string) {
      activeSockets++;
      queueMicrotask(() => this.emit("open"));
    }

    once(event: string, listener: (...args: any[]) => void): this {
      this.listeners.set(event, [listener]);
      return this;
    }

    on(event: string, listener: (...args: any[]) => void): this {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }

    send(data: string, callback?: (error?: Error) => void): void {
      callback?.();
      if (data === "password") {
        return;
      }
      if (data.includes("__SANDCASTLE_SHELL_READY__")) {
        queueMicrotask(() =>
          this.emit("message", "\n__SANDCASTLE_SHELL_READY__\n"),
        );
        return;
      }
      if (data.includes("__SANDCASTLE_OUTPUT_START__")) {
        commandScripts.push(data);
        if (data.includes("__SANDCASTLE_STDIN_READY__")) {
          this.awaitingStdin = true;
          queueMicrotask(() => {
            stdinReadySignalSent = true;
            this.emit(
              "message",
              "\n__SANDCASTLE_OUTPUT_START__\n\n__SANDCASTLE_STDIN",
            );
            this.emit("message", "_READY__\n");
          });
          return;
        }
        queueMicrotask(() => this.complete());
        return;
      }
      if (this.awaitingStdin) {
        if (!stdinReadySignalSent) stdinSentBeforeReady = true;
        sentStdin.push(data);
        if (data === "\u0004") {
          queueMicrotask(() => this.complete(false));
        }
        return;
      }
      queueMicrotask(() => {
        this.complete();
      });
    }

    close(): void {
      if (closeAfterCommand) this.finish();
    }

    terminate(): void {
      terminateCount++;
      this.finish();
    }

    private complete(includeOutputStart = true): void {
      this.emit(
        "message",
        `${includeOutputStart ? "\n__SANDCASTLE_OUTPUT_START__\n" : ""}${commandOutput}\n__SANDCASTLE_EXIT_CODE__0\n`,
      );
      if (closeAfterCommand) this.finish();
    }

    private finish(): void {
      if (this.closed) return;
      this.closed = true;
      activeSockets--;
      this.emit("close");
    }

    private emit(event: string, ...args: any[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class FakeClient {
    readonly containerGroups = {
      beginCreateOrUpdateAndWait: createOrUpdate,
      get,
      beginDeleteAndWait: deleteGroup,
    };
    readonly containers = { executeCommand };
  }

  return {
    createOrUpdate,
    get,
    deleteGroup,
    executeCommand,
    FakeClient,
    FakeWebSocket,
    setCloseAfterCommand: (value: boolean) => {
      closeAfterCommand = value;
    },
    resetConnectionState: () => {
      closeAfterCommand = true;
      activeSockets = 0;
      terminateCount = 0;
      stdinReadySignalSent = false;
      stdinSentBeforeReady = false;
      commandOutput = "hello";
      commandScripts.length = 0;
      sentStdin.length = 0;
    },
    terminateCount: () => terminateCount,
    sentStdin: () => [...sentStdin],
    stdinSentBeforeReady: () => stdinSentBeforeReady,
    commandScripts: () => [...commandScripts],
    setCommandOutput: (value: string) => {
      commandOutput = value;
    },
  };
});

vi.mock("@azure/arm-containerinstance", () => ({
  ContainerInstanceManagementClient: azureMocks.FakeClient,
}));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {},
}));
vi.mock("ws", () => ({ WebSocket: azureMocks.FakeWebSocket }));

describe("azureContainer()", () => {
  it("returns an isolated Azure provider without loading Azure SDKs", () => {
    const provider = azureContainer();

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("azure-container");
    expect(typeof provider.create).toBe("function");
  });

  it("passes provider environment variables through", () => {
    const provider = azureContainer({
      env: { AZURE_PROVIDER_TEST: "value" },
    });

    expect(provider.env).toEqual({ AZURE_PROVIDER_TEST: "value" });
  });

  it("accepts container and registry configuration", () => {
    const provider = azureContainer({
      subscriptionId: "subscription",
      resourceGroup: "agents",
      location: "australiaeast",
      image: "registry.example.com/agent:latest",
      containerGroupName: "sandcastle-test",
      containerName: "agent",
      registry: {
        server: "registry.example.com",
        username: "user",
        password: "password",
      },
      identity:
        "/subscriptions/sub/resourceGroups/agents/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull",
    });

    expect(provider.tag).toBe("isolated");
  });

  it("creates an ACI group and streams an exec result", async () => {
    const provider = azureContainer({
      subscriptionId: "subscription",
      resourceGroup: "agents",
      location: "australiaeast",
      image: "agent:latest",
    });

    const handle = await provider.create({ env: { TOKEN: "secret" } });
    const lines: string[] = [];
    const result = await handle.exec("printf hello", {
      onLine: (line) => lines.push(line),
    });
    const bufferedResult = await handle.exec("printf hello");

    expect(azureMocks.createOrUpdate).toHaveBeenCalledOnce();
    expect(azureMocks.createOrUpdate.mock.calls[0]?.[2]).toMatchObject({
      osType: "Linux",
      restartPolicy: "Never",
      containers: [
        {
          command: [
            "/bin/sh",
            "-c",
            "mkdir -p /home/agent/workspace && sleep 7200",
          ],
          environmentVariables: [{ name: "TOKEN", secureValue: "secret" }],
        },
      ],
    });
    expect(azureMocks.executeCommand).toHaveBeenCalledTimes(2);
    expect(azureMocks.executeCommand.mock.calls[0]?.[3]).toMatchObject({
      command: "/bin/sh",
    });
    expect(lines).toEqual(["hello"]);
    expect(result).toMatchObject({ stdout: "hello", exitCode: 0 });
    expect(bufferedResult.stdout).toContain("hello");

    await handle.close();
    expect(azureMocks.deleteGroup).toHaveBeenCalledOnce();
  });

  it("terminates a marker-complete exec so the next ACI exec can start", async () => {
    azureMocks.resetConnectionState();
    azureMocks.setCloseAfterCommand(false);
    try {
      const provider = azureContainer({
        subscriptionId: "subscription",
        resourceGroup: "agents",
        location: "australiaeast",
        image: "agent:latest",
      });
      const handle = await provider.create({ env: {} });

      await expect(handle.exec("printf hello")).resolves.toMatchObject({
        stdout: "hello",
        exitCode: 0,
      });
      await expect(handle.exec("printf hello again")).resolves.toMatchObject({
        stdout: "hello",
        exitCode: 0,
      });
      expect(azureMocks.terminateCount()).toBe(2);
    } finally {
      azureMocks.resetConnectionState();
    }
  });

  it("waits for the ACI terminal to accept stdin before sending a prompt", async () => {
    azureMocks.resetConnectionState();
    try {
      const provider = azureContainer({
        subscriptionId: "subscription",
        resourceGroup: "agents",
        location: "australiaeast",
        image: "agent:latest",
      });
      const handle = await provider.create({ env: {} });
      const lines: string[] = [];

      await expect(
        handle.exec("cat", {
          stdin: "implement issue 612",
          onLine: (line) => lines.push(line),
        }),
      ).resolves.toMatchObject({ stdout: "hello", exitCode: 0 });

      expect(azureMocks.stdinSentBeforeReady()).toBe(false);
      expect(azureMocks.sentStdin()).toEqual(["implement issue 612", "\u0004"]);
      expect(lines).toEqual(["hello"]);

      await handle.close();
    } finally {
      azureMocks.resetConnectionState();
    }
  });

  it("copies wrapped base64 output without filtering its alphabet", async () => {
    azureMocks.resetConnectionState();
    const outputDirectory = await mkdtemp(join(tmpdir(), "azure-copy-out-"));
    const outputPath = join(outputDirectory, "payload.bin");
    const expected = Buffer.from("payload with r and n characters\n", "utf8");
    try {
      const provider = azureContainer({
        subscriptionId: "subscription",
        resourceGroup: "agents",
        location: "australiaeast",
        image: "agent:latest",
      });
      const handle = await provider.create({ env: {} });
      azureMocks.setCommandOutput(
        expected.toString("base64").replace(/.{12}/g, "$&\n"),
      );

      await handle.copyFileOut("/home/agent/payload.bin", outputPath);

      expect(await readFile(outputPath)).toEqual(expected);
      const copyCommand = azureMocks
        .commandScripts()
        .find((script) => script.includes("base64 '/home/agent/payload.bin'"));
      expect(copyCommand).toContain("base64 '/home/agent/payload.bin'");
      expect(copyCommand).not.toContain("tr -d");

      await handle.close();
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
      azureMocks.resetConnectionState();
    }
  });
});
