// A minimal MCP client over stdio JSON-RPC, for talking to the bundled azmcp.
//
// Why not @modelcontextprotocol/client: it validates every result against the spec, and azmcp 3.0.0
// advertises some tools with a non-object outputSchema, so a strict client rejects its whole tools/list.
// This proxy forwards results unchanged and only needs initialize, tools/list and tools/call, so a small
// newline-delimited JSON-RPC client is enough and passes through exactly what Microsoft's server says.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class StdioRpcClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private stderrTail: string[] = [];
  exited = false;
  /** Answers requests azmcp sends us (elicitation/create). Unset, or throwing, means a JSON-RPC error back. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      // Keep a short tail for error messages; never forward it anywhere else.
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    const fail = (why: string) => {
      this.exited = true;
      const error = new RpcError(`${why}. ${this.lastStderr()}`.trim());
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
    };
    this.child.on("error", (error) => fail(`Could not start ${command}: ${error.message}`));
    this.child.on("exit", (code, signal) => fail(`Microsoft Azure MCP server exited (${signal ?? `code ${code}`})`));
  }

  lastStderr(): string {
    const text = this.stderrTail.join("").trim();
    return text ? `Last output: ${text.slice(-600)}` : "";
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: { id?: number | string; result?: unknown; error?: { code?: number; message?: string }; method?: string };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (message.method !== undefined) {
        // A request or notification from azmcp (elicitation, logging). Requests go to onRequest; without one,
        // or when it fails, azmcp gets an error back instead of waiting forever.
        if (message.id !== undefined) this.answer(message.id, message.method, (message as { params?: unknown }).params);
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.message ?? "error", message.error.code));
      else pending.resolve(message.result);
    }
  }

  private answer(id: number | string, method: string, params: unknown): void {
    const handler = this.onRequest;
    const reply = handler ? handler(method, params) : Promise.reject(new Error(`${method} is not supported by the Azure proxy`));
    reply.then(
      (result) => this.safeWrite({ jsonrpc: "2.0", id, result }),
      (error: unknown) => this.safeWrite({ jsonrpc: "2.0", id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } }),
    );
  }

  private safeWrite(message: unknown): void {
    try {
      this.write(message);
    } catch {
      // The child is gone; nothing to answer.
    }
  }

  private write(message: unknown): void {
    if (this.exited) throw new RpcError(`Microsoft Azure MCP server is not running. ${this.lastStderr()}`.trim());
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async initialize(clientName: string, clientVersion: string, capabilities?: Record<string, unknown>): Promise<{ serverInfo?: { name?: string; version?: string } }> {
    const result = await this.request<{ serverInfo?: { name?: string; version?: string } }>(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: capabilities ?? {}, clientInfo: { name: clientName, version: clientVersion } },
      60_000,
    );
    this.notify("notifications/initialized");
    return result;
  }

  close(): void {
    if (this.exited) return;
    this.exited = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}
