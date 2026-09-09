import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, test } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { waitForGatewayHttpReadiness } from "../cli/daemon-cli/restart-health-probe.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createConfiguredGatewayLocalProbe,
  requestGatewayLocalHttpProbe,
} from "./local-http-probe.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;

test("probes configured local TLS readiness with its exact certificate pin", async () => {
  await withTestDir({ prefix: "openclaw-local-http-probe-" }, async (directory) => {
    const certPath = path.join(directory, "gateway-cert.pem");
    const keyPath = path.join(directory, "gateway-key.pem");
    await Promise.all([
      writeFile(certPath, TEST_TLS_CERT_PEM),
      writeFile(keyPath, TEST_TLS_KEY_PEM),
    ]);
    const paths: string[] = [];
    const server = createServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (request, response) => {
        paths.push(request.url ?? "");
        response.statusCode = 200;
        response.end(JSON.stringify({ ready: request.url === "/readyz" }));
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    try {
      const probe = createConfiguredGatewayLocalProbe({
        gateway: { tls: { enabled: true, autoGenerate: false, certPath, keyPath } },
      });
      const config = {
        gateway: { tls: { enabled: true, autoGenerate: false, certPath, keyPath } },
      };
      await expect(
        waitForGatewayHttpReadiness({
          attempts: 1,
          config,
          deadlineAt: Date.now() + 1_000,
          delayMs: 0,
          port: address.port,
        }),
      ).resolves.toEqual({ healthz: 200, readyz: 200 });
      expect(paths).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
      await expect(
        probe.requestHttp({
          host: "127.0.0.1",
          pathname: "/readyz",
          port: address.port,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ ready: true }) });
      await expect(
        requestGatewayLocalHttpProbe({
          host: "127.0.0.1",
          pathname: "/readyz",
          port: address.port,
          timeoutMs: 1_000,
          tlsFingerprint: fingerprint.replace(/[\dA-F]/g, "0"),
        }),
      ).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

// The strict marker is what lets supervised-lock recovery tell a draining gateway
// (503) from a zombie still holding the port (200). It reached production through
// two separate helpers, and an earlier port applied it to only one of them - which
// left the production probe inert while every test still passed. These cases pin
// BOTH call shapes and the public probe's legacy marker-free contract.
test("carries the strict marker on both probe helpers and omits it by default", async () => {
  const paths: string[] = [];
  const server = createHttpServer((request, response) => {
    paths.push(request.url ?? "");
    response.statusCode = 200;
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    // 1. bare helper, strict opted in
    await requestGatewayLocalHttpProbe({
      host: "127.0.0.1",
      pathname: "/healthz",
      port,
      timeoutMs: 1_000,
      strictLiveProbe: true,
    });
    // 2. the helper production actually wires for supervised-lock recovery
    await createConfiguredGatewayLocalProbe({}).requestHttp({
      host: "127.0.0.1",
      pathname: "/healthz",
      port,
      timeoutMs: 1_000,
      strictLiveProbe: true,
    });
    // 3. public probe: no marker, legacy always-200 contract preserved
    await requestGatewayLocalHttpProbe({
      host: "127.0.0.1",
      pathname: "/healthz",
      port,
      timeoutMs: 1_000,
    });

    expect(paths).toEqual(["/healthz?strict=1", "/healthz?strict=1", "/healthz"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
