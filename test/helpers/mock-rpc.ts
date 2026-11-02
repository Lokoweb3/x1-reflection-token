// A local JSON-RPC server for running the real scripts against modelled chain answers: no network, no funds.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type RpcHandler = (method: string, params: any[]) => unknown;
export const rpcError = (code: number, message: string) => ({ __error: { code, message } });

export async function mockRpc(handler: RpcHandler) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const j = JSON.parse(body);
      calls.push(j.method);
      const out = handler(j.method, j.params ?? []) as { __error?: unknown } | undefined;
      if (out === undefined) console.error(`mock-rpc: unhandled ${j.method}`);
      const reply = out?.__error ? { jsonrpc: "2.0", id: j.id, error: out.__error } : { jsonrpc: "2.0", id: j.id, result: out ?? null };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => server.close(r)) };
}
