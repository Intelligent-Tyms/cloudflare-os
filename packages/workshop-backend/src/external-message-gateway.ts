import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  type ExternalMessageGateway as ExternalMessageGatewayContract,
  type SubmitExternalMessageInput,
  type SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import { resolveSiteName } from "@gadgets/workshop-shared/api";
import { readAdminConfig } from "./admin-config.js";
import { HOME_WORKSPACE_TITLE } from "./user.js";
import { recordUsage, usageCollector } from "./usage-collector.js";

type ExternalMessageGatewayProps = {
  source: string;
};

@validateRpc()
export class ExternalMessageGateway extends WorkerEntrypoint<Cloudflare.Env, ExternalMessageGatewayProps> implements ExternalMessageGatewayContract {
  async submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult> {
    let source = this.ctx.props.source;
    if (!source) throw new Error("ExternalMessageGateway source prop is required.");

    // Every external conversation lands in the caller's home assistant workspace as its own
    // chat thread; gateways never mint workspaces. The home workspace is created on first
    // contact, but only for existing accounts.
    let callerEmail = input.callerEmail.trim().toLowerCase();
    let user = this.ctx.exports.UserDurableObject.getByName(callerEmail);
    let workspaceId = await user.ensureHomeWorkspace();
    if (!workspaceId) {
      let siteName = resolveSiteName((await readAdminConfig(this.env)).siteName);
      return {
        accepted: false,
        message: `Please create a ${siteName} account to continue.`,
      };
    }

    // Messaging credits: channels with a real per-message delivery cost (per the central
    // rate card) need a positive messaging balance. Free channels are never blocked, and
    // the check fails open when billing is unconfigured or unreachable.
    let billing = await usageCollector(this.ctx).getBillingState().catch(() => null);
    if (billing && billing.tier !== "enterprise"
        && (billing.channelRatesMicroUsd[source] ?? 0) > 0
        && billing.messagingBalanceMicroUsd <= 0) {
      return {
        accepted: false,
        message: "This workspace is out of messaging credits. " +
            "Ask a workspace admin to top up under Admin → Billing and usage.",
      };
    }

    // External chat and message keys are prefixed with the binding-owned source, preventing
    // collisions between gateways that happen to pick the same conversation keys.
    let overseers = this.ctx.exports.OverseerDurableObject;
    let overseer = overseers.get(overseers.idFromString(workspaceId));

    let result = await overseer.receiveExternalMessage({
      callerEmail,
      externalChatKey: `${source}:${input.chatKey}`,
      idempotencyKey: `${source}:${input.messageKey}`,
      prompt: input.prompt,
      replyBinding: input.replyBinding,
      deliveryKey: input.deliveryKey,
      title: HOME_WORKSPACE_TITLE,
    });

    // Meter accepted inbound messages. The webhook-derived messageKey makes redelivered
    // webhooks bill once.
    if (result.accepted !== false) {
      recordUsage(this.ctx, this.env, [{
        sourceKey: `msg:in:${source}:${input.messageKey}`,
        kind: "message",
        channel: source,
        direction: "inbound",
      }]);
    }
    return result;
  }
}
