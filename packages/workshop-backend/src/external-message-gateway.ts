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

    // External chat and message keys are prefixed with the binding-owned source, preventing
    // collisions between gateways that happen to pick the same conversation keys.
    let overseers = this.ctx.exports.OverseerDurableObject;
    let overseer = overseers.get(overseers.idFromString(workspaceId));

    return await overseer.receiveExternalMessage({
      callerEmail,
      externalChatKey: `${source}:${input.chatKey}`,
      idempotencyKey: `${source}:${input.messageKey}`,
      prompt: input.prompt,
      replyBinding: input.replyBinding,
      deliveryKey: input.deliveryKey,
      title: HOME_WORKSPACE_TITLE,
    });
  }
}
