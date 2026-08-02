import { describe, expect, it, vi } from "vitest";
import { azureContainer } from "./azure-container.js";

const azureMocks = vi.hoisted(() => {
  const createOrUpdate = vi.fn().mockResolvedValue({});
  const get = vi.fn().mockResolvedValue({
    containers: [{ instanceView: { currentState: { state: "Running" } } }],
  });
  const deleteGroup = vi.fn().mockResolvedValue({});
  const executeCommand = vi.fn().mockResolvedValue({
    webSocketUri: "wss://example.test/exec",
    password: "password",
  });

  class FakeWebSocket {
    static readonly OPEN = 1;
    private readonly listeners = new Map<
      string,
      Array<(...args: any[]) => void>
    >();

    constructor(_url: string) {
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
      queueMicrotask(() => {
        this.emit(
          "message",
          `\n__SANDCASTLE_OUTPUT_START__\nhello\n__SANDCASTLE_EXIT_CODE__0\n`,
        );
        this.emit("close");
      });
    }

    close(): void {
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
});
