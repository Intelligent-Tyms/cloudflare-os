import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";

const EXPIRED = "This connection attempt has expired. Please try again.";

const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** Load a connect or reconnect flow's final page; the ticket is the one it hands the popup. */
async function handoffTicket(url: string): Promise<string> {
  const response = await harness.fetchWorker(TEST_GATEKEEPER_WORKER, url);
  expect(response.status).toBe(200);
  const literal = /var ticket = (".*?");\n/.exec(await response.text());
  if (literal === null) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

/** Run a connect flow to its handoff page. */
async function finishFlow(api: RpcStub<AuthenticatedApi>)
    : Promise<{ label: string; nonce: string; ticket: string }> {
  const { url, nonce } = await api.connectAccount(TEST_VENDOR_ID);
  const label = new URL(url).pathname.slice("/connect/".length);
  return { label, nonce, ticket: await handoffTicket(url) };
}

const testAccounts = async (api: RpcStub<AuthenticatedApi>) =>
  // Only accounts a connect flow added: the forced ambient account the fork provisions is not one.
  (await listConnectedAccounts(api, { includeForcedAutoProvisionedAccounts: false }))
      .filter(account => account.vendorId === TEST_VENDOR_ID);

/** A user-connected (so reconnectable) account, not an auto-provisioned one. */
async function connectConfirmed(api: RpcStub<AuthenticatedApi>) {
  const { label, nonce, ticket } = await finishFlow(api);
  await api.completeConnectHandoff(ticket, nonce);
  return await waitFor("the connected account", async () =>
    (await testAccounts(api)).find(account => accountLabel(account) === label) ?? null);
}

const credentialsValid = (api: RpcStub<AuthenticatedApi>, accountId: number, valid: boolean) =>
  waitFor(`the account's credentials to be ${valid ? "valid" : "expired"}`, async () =>
    (await testAccounts(api)).some(a => a.id === accountId && a.credentialsValid === valid) || null);

const control = <T>(route: string, body: object) => testControl<T>(harness, route, body);

const revocations = async (label: string) =>
  (await control<{ count: number }>("revocation-count", { label })).count;

it.concurrent("a connect flow adds the account only when its own session redeems the ticket, once",
    async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = stack.use(await signUp(stack.use(connect(harness.url)), aliceName!));
  const bob = stack.use(await signUp(stack.use(connect(harness.url)), bobName!));

  const { label, nonce, ticket } = await finishFlow(alice);
  expect(await testAccounts(alice)).toEqual([]);

  await expect(bob.completeConnectHandoff(ticket, nonce)).rejects.toThrow(EXPIRED);
  await expect(alice.completeConnectHandoff("not-a-ticket", "not-a-nonce")).rejects.toThrow(EXPIRED);
  await alice.completeConnectHandoff(ticket, nonce);
  expect(await testAccounts(alice)).toHaveLength(1);
  expect(await testAccounts(bob)).toEqual([]);

  await expect(alice.completeConnectHandoff(ticket, nonce)).rejects.toThrow(EXPIRED);
  expect(await testAccounts(alice)).toHaveLength(1);
  expect(await revocations(label)).toBe(0);
});

it.concurrent("a ticket with another flow's nonce, or a malformed one, is refused, spent and revoked",
    async () => {
  using stack = new DisposableStack();
  const carol = stack.use(await signUp(stack.use(connect(harness.url)), nextUsernames("carol")[0]!));
  const a = await finishFlow(carol);
  const b = await finishFlow(carol);
  const c = await finishFlow(carol);

  await expect(carol.completeConnectHandoff(a.ticket, b.nonce)).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(a.ticket, a.nonce)).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(b.ticket, b.nonce)).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(c.ticket, "not-a-nonce")).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(c.ticket, c.nonce)).rejects.toThrow(EXPIRED);
  expect(await testAccounts(carol)).toEqual([]);
  expect(await Promise.all([a, b, c].map(flow => revocations(flow.label)))).toEqual([1, 1, 1]);
});

it.concurrent("another user cannot redeem a reconnect handoff", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = stack.use(await signUp(stack.use(connect(harness.url)), aliceName!));
  const bob = stack.use(await signUp(stack.use(connect(harness.url)), bobName!));
  const account = await connectConfirmed(alice);
  const label = accountLabel(account);
  await control("expire-credentials", { label });
  await credentialsValid(alice, account.id, false);

  const { url, nonce } = await alice.reconnectAccount(account.id);
  const ticket = await handoffTicket(url);
  await expect(bob.completeConnectHandoff(ticket, nonce)).rejects.toThrow(EXPIRED);

  expect(await testAccounts(alice))
      .toEqual([expect.objectContaining({ id: account.id, credentialsValid: false })]);
  expect(await control("credential", { label })).toEqual({ credential: 1 });
  expect(await revocations(label)).toBe(0);
});
