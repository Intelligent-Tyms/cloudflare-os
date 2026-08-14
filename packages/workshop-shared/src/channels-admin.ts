// RPC contract between the workshop backend and the deployment's channels worker
// (the Telegram/Slack bridge). The workshop reaches it over an optional CHANNELS
// service binding (entrypoint ChannelsAdmin) that deploy tooling injects only when
// the deployment configures the channels worker.

/** Which messaging channels this deployment has configured. */
export type ChannelsDescription = {
  telegram: {
    configured: boolean;
    /** Bot username (t.me/<botUserName>), present when configured. */
    botUserName?: string;
  };
  slack: {
    configured: boolean;
  };
  email: {
    configured: boolean;
    /** Domain assistant addresses are minted under, present when configured. */
    domain?: string;
  };
};

/** A Telegram account linked to a tenant email. */
export type TelegramBinding = {
  email: string;
  telegramUserId: string;
  telegramUserName?: string;
  linkedAt: number;
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
   * from userEmail. Also ensures the inbound webhook is registered on first use.
   */
  provisionEmailInbox(userEmail: string, username?: string): Promise<EmailInbox>;
  /** List provisioned assistant inboxes. */
  listEmailInboxes(): Promise<EmailInbox[]>;
  /** Delete userEmail's assistant inbox (provider-side too); false when none exists. */
  deleteEmailInbox(userEmail: string): Promise<boolean>;
}
