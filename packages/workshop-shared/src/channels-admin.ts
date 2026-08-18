// RPC contract between the workshop backend and the deployment's channels worker
// (the Telegram/Slack bridge). The workshop reaches it over an optional CHANNELS
// service binding (entrypoint ChannelsAdmin) that deploy tooling injects only when
// the deployment configures the channels worker.

/** Which messaging channels this deployment has configured. */
export type ChannelsDescription = {
  /**
   * Whether admin-entered setup can complete on its own: the worker knows its public
   * origin, so it can register platform webhooks itself. False only on deployments whose
   * deploy config can't compute the worker's URL — the setup forms then stay hidden.
   */
  selfSetup: boolean;
  telegram: {
    configured: boolean;
    /** Bot username (t.me/<botUserName>), present when configured. */
    botUserName?: string;
    /** Where the credentials came from; admin-entered setup can be disconnected. */
    source?: "deployment" | "admin";
  };
  slack: {
    configured: boolean;
  };
  email: {
    configured: boolean;
    /** Domain assistant addresses are minted under, present when configured. */
    domain?: string;
    /** Where the credentials came from; admin-entered setup can be disconnected. */
    source?: "deployment" | "admin";
  };
};

/** A Telegram account linked to a tenant email. */
export type TelegramBinding = {
  email: string;
  telegramUserId: string;
  telegramUserName?: string;
  linkedAt: number;
  /** Epoch millis of the last inbound message from this account, absent before the first. */
  lastMessageAt?: number;
};

/** A freshly minted one-time Telegram link for a tenant email. */
export type TelegramLinkCode = {
  /** Deep link (t.me/<bot>?start=<code>) to send to the user. */
  link: string;
  /** Epoch millis when the code stops working. */
  expiresAt: number;
};

/** One provisioned assistant email inbox (see ChannelsAdmin.provisionEmailInbox). */
export type EmailInbox = {
  /** The account (workspace member) this assistant inbox belongs to. */
  userEmail: string;
  /** The assistant's email address (e.g. allan@agentmail.to). */
  address: string;
  createdAt: number;
  /** Epoch millis of the last message this inbox accepted from its owner, absent before the first. */
  lastMessageAt?: number;
};

/**
 * One user's view of their own channel connections, for the user-facing Channels page.
 * Channels the deployment hasn't configured report configured: false with nothing else set.
 */
export type UserChannelsView = {
  telegram: {
    configured: boolean;
    /** Bot username (t.me/<botUserName>), present when configured. */
    botUserName?: string;
    /** Whether this user has linked a Telegram account. */
    linked: boolean;
    telegramUserName?: string;
    linkedAt?: number;
    lastMessageAt?: number;
  };
  /** Slack needs no per-user state: users are recognized by their Slack profile email. */
  slack: { configured: boolean };
  email: {
    configured: boolean;
    /** This user's assistant address, present once an admin has provisioned it. */
    address?: string;
    createdAt?: number;
    lastMessageAt?: number;
  };
};

/** Service binding RPC interface exposed by the channels worker for admin use. */
export interface ChannelsAdmin {
  /** Report which channels are configured on this deployment. */
  describeChannels(): Promise<ChannelsDescription>;
  /** Mint a one-time Telegram deep link that binds the tapping account to email. */
  mintTelegramLinkCode(email: string): Promise<TelegramLinkCode>;
  /** List Telegram accounts currently linked to tenant emails. */
  listTelegramBindings(): Promise<TelegramBinding[]>;
  /** Remove the Telegram binding for email; returns false when none exists. */
  unlinkTelegram(email: string): Promise<boolean>;
  /**
   * Create the assistant email inbox for userEmail (idempotent: returns the existing one if
   * already provisioned). username overrides the address local part, which otherwise derives
   * from userEmail. Also ensures the inbound webhook is registered: automatic when the worker
   * knows its public origin, otherwise the call throws until the register-webhook admin
   * endpoint has been hit once (so provisioning can never silently yield a dead channel).
   */
  provisionEmailInbox(userEmail: string, username?: string): Promise<EmailInbox>;
  /** List provisioned assistant inboxes. */
  listEmailInboxes(): Promise<EmailInbox[]>;
  /** Delete userEmail's assistant inbox (provider-side too); false when none exists. */
  deleteEmailInbox(userEmail: string): Promise<boolean>;
  /** One user's own channel connections (see UserChannelsView). Any email is accepted;
   * unknown emails simply report nothing linked. */
  describeUser(userEmail: string): Promise<UserChannelsView>;

  // --- Admin-entered channel setup (tenant admins bring their own credentials) ---
  //
  // Credentials transit these calls once and are stored only in the channels worker;
  // describeChannels never echoes them back. Deploy-time env secrets, where present,
  // remain as a fallback that setup/clear does not touch.

  /**
   * Connect Telegram from a BotFather bot token alone: the token is verified with
   * Telegram (which also yields the bot's username) and the webhook is registered at
   * this worker with a generated secret. Requires selfSetup.
   */
  setupTelegram(botToken: string): Promise<{ botUserName: string }>;
  /** Remove admin-entered Telegram credentials (best-effort webhook deregistration). */
  clearTelegramSetup(): Promise<boolean>;
  /**
   * Connect email from an AgentMail API key (+ optional custom domain verified on that
   * AgentMail account). The key is validated and the inbound webhook registered before
   * anything is stored. Requires selfSetup.
   */
  setupEmail(apiKey: string, domain?: string): Promise<void>;
  /** Remove admin-entered email credentials (best-effort webhook deregistration). */
  clearEmailSetup(): Promise<boolean>;
}
