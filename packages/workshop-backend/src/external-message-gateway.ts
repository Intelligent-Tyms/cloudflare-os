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
import {
  CHANNEL_COMMANDS_HELP,
  formatWorkspaceList,
  formatWorkspaceMatchFailure,
  matchWorkspace,
  parseChannelCommand,
} from "./external-message-commands.js";

type ExternalMessageGatewayProps = {
  source: string;
};

@validateRpc()
export class ExternalMessageGateway extends WorkerEntrypoint<Cloudflare.Env, ExternalMessageGatewayProps> implements ExternalMessageGatewayContract {
  async submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult> {
    let source = this.ctx.props.source;
    if (!source) throw new Error("ExternalMessageGateway source prop is required.");

    // Every external conversation lands in the workspace it is routed to -- the caller's
    // home assistant workspace unless a channel command, the assistant's switchWorkspace
    // tool, or an address hint pointed it elsewhere (see UserDurableObject.channelRoutes).
    // Gateways never mint workspaces; the home workspace is created on first contact, but
    // only for existing accounts.
    let callerEmail = input.callerEmail.trim().toLowerCase();
    let user = this.ctx.exports.UserDurableObject.getByName(callerEmail);
    let homeWorkspaceId = await user.ensureHomeWorkspace();
    if (!homeWorkspaceId) {
      let siteName = resolveSiteName((await readAdminConfig(this.env)).siteName);
      return {
        accepted: false,
        message: `Please create a ${siteName} account to continue.`,
      };
    }

    // External chat and message keys are prefixed with the binding-owned source, preventing
    // collisions between gateways that happen to pick the same conversation keys. The same
    // key names the conversation's route.
    let conversationKey = `${source}:${input.chatKey}`;
    let prompt = input.prompt;

    // An address hint ("assistant+crm@", "[CRM] subject") re-routes the conversation before
    // delivery; a hint naming nothing is answered rather than silently landing in home.
    let hint = input.workspaceHint?.trim();
    if (hint) {
      let workspaces = await user.listChannelRoutableWorkspaces();
      let match = matchWorkspace(workspaces, hint);
      if (match.kind !== "match") {
        return { accepted: false, message: formatWorkspaceMatchFailure(match, hint, workspaces) };
      }
      await user.setChannelRoute(conversationKey, match.workspace.isHome ? null : match.workspace.id);
    }

    // Channel commands are answered here, without an agent turn. A command followed by more
    // lines delivers those lines to the (possibly just switched) workspace.
    let command = parseChannelCommand(prompt);
    if (command) {
      let workspaces = await user.listChannelRoutableWorkspaces();
      let current = (await user.getChannelRoute(conversationKey))?.id ?? homeWorkspaceId;
      switch (command.command) {
        case "help":
          return { accepted: false, message: CHANNEL_COMMANDS_HELP };
        case "workspaces":
          return { accepted: false, message: formatWorkspaceList(workspaces, current) };
        case "where": {
          let workspace = workspaces.find(w => w.id === current);
          return {
            accepted: false,
            message: workspace?.isHome !== false
                ? "This conversation is with your home assistant. Send /workspaces to see where else it can go."
                : `This conversation is in ${workspace.title}. Send /home to go back to your home assistant.`,
          };
        }
        case "home":
        case "use": {
          let target;
          if (command.command === "home") {
            target = workspaces.find(w => w.isHome);
            if (!target) return { accepted: false, message: "You have no home workspace yet." };
          } else {
            if (!command.argument) {
              return { accepted: false, message: formatWorkspaceList(workspaces, current) };
            }
            let match = matchWorkspace(workspaces, command.argument);
            if (match.kind !== "match") {
              return {
                accepted: false,
                message: formatWorkspaceMatchFailure(match, command.argument, workspaces),
              };
            }
            target = match.workspace;
          }
          await user.setChannelRoute(conversationKey, target.isHome ? null : target.id);
          if (!command.remainder) {
            return {
              accepted: false,
              message: target.isHome
                  ? "You're back with your home assistant."
                  : `Switched this conversation to ${target.title}. Everything you send here now goes there; /home brings you back.`,
            };
          }
          prompt = command.remainder;
        }
      }
    }

    let route = await user.getChannelRoute(conversationKey);
    let workspaceId = route?.id ?? homeWorkspaceId;
    let workspaceTitle = route?.title ?? HOME_WORKSPACE_TITLE;

    // Messaging credits: channels with a real per-message delivery cost (per the central
    // rate card) need a positive messaging balance, and so do voice notes (transcription
    // and synthesis run on the platform's speech account) even on otherwise-free channels.
    // Free legs are never blocked, and the check fails open when billing is unconfigured
    // or unreachable.
    let billing = await usageCollector(this.ctx).getBillingState().catch(() => null);
    let paidLeg = billing !== null
        && ((billing.channelRatesMicroUsd[source] ?? 0) > 0
          || (input.voiceNote != null && (billing.channelRatesMicroUsd.voice ?? 0) > 0));
    if (billing && billing.tier !== "enterprise"
        && paidLeg
        && billing.messagingBalanceMicroUsd <= 0) {
      return {
        accepted: false,
        message: "This workspace is out of messaging credits. " +
            "Ask a workspace admin to top up under Admin → Billing and usage.",
      };
    }

    let overseers = this.ctx.exports.OverseerDurableObject;
    let overseer = overseers.get(overseers.idFromString(workspaceId));

    let result = await overseer.receiveExternalMessage({
      callerEmail,
      externalChatKey: conversationKey,
      idempotencyKey: `${source}:${input.messageKey}`,
      prompt,
      replyBinding: input.replyBinding,
      deliveryKey: input.deliveryKey,
      title: workspaceTitle,
    });

    // Meter accepted inbound messages. The webhook-derived messageKey makes redelivered
    // webhooks bill once. A voice note bills an additional "voice" leg for its
    // transcription, priced by the rate card independently of the carrying channel.
    if (result.accepted !== false) {
      recordUsage(this.ctx, this.env, [
        {
          sourceKey: `msg:in:${source}:${input.messageKey}`,
          kind: "message",
          channel: source,
          direction: "inbound",
        },
        ...(input.voiceNote != null ? [{
          sourceKey: `voice:in:${source}:${input.messageKey}`,
          kind: "message" as const,
          channel: "voice",
          direction: "inbound" as const,
        }] : []),
      ]);
    }
    return result;
  }
}
