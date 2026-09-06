export const PLUGIN_ID = "paperclip-plugin-slack";
export const PLUGIN_VERSION = "2.5.0";

export const WEBHOOK_KEYS = {
  slackEvents: "slack-events",
  slashCommand: "slash-command",
  interactivity: "slack-interactivity",
} as const;

export const SLOT_IDS = {
  settingsPage: "slack-settings-page",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "SlackSettingsPage",
} as const;

export const STATE_KEYS = {
  escalationRecord: (id: string) => `escalation-record-${id}`,
  escalationTs: (id: string) => `escalation-ts-${id}`,
  escalationChannel: (id: string) => `escalation-channel-${id}`,
  sessionRegistry: (ch: string, ts: string) => `sessions_${ch}_${ts}`,
  outputQueue: (ch: string, ts: string) => `output-queue_${ch}_${ts}`,
  msgAgent: (ch: string, ts: string) => `msg-agent-${ch}-${ts}`,
  activeDiscussion: (ch: string, ts: string) => `active-discussion-${ch}-${ts}`,
  discussion: (id: string) => `discussion_${id}`,
  handoff: (id: string) => `handoff-${id}`,
  slackChannel: "slack-channel",
  threadIssue: (id: string) => `thread-issue-${id}`,
  dailyCost: (date: string) => `daily-cost-${date}`,
  dailyAgentCosts: (date: string) => `daily-agent-costs-${date}`,
  firstRunNotified: (id: string) => `first-run-notified-${id}`,
  budgetAlert: (id: string, bucket: number) => `budget-alert-${id}-${bucket}`,
  watchRegistry: (ch: string, ts: string) => `watches_${ch}_${ts}`,
  commandRegistry: "custom-commands",
} as const;

export const DEFAULT_CONFIG = {
  slackTokenRef: "",
  slackSigningSecretRef: "",
  defaultChannelId: "",
  approvalsChannelId: "",
  errorsChannelId: "",
  pipelineChannelId: "",
  escalationChatId: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnApprovalCreated: true,
  notifyOnAgentError: true,
  notifyOnAgentConnected: true,
  notifyOnBudgetThreshold: true,
  enableDailyDigest: false,
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Your request has been escalated to a human agent. Please hold.",
  paperclipBaseUrl: "http://localhost:3100",
  maxAgentsPerThread: 5,
  // Slack Web API base. A hosted deployment points this at a proxy that
  // holds the real bot token; the token in slackTokenRef is then a bearer
  // for that proxy. The plugin does not know the difference.
  slackApiBaseUrl: "https://slack.com/api",
  chatTasksEnabled: true,
  chatTasksProjectId: "",
  chatRequireMention: true,
  chatAckReaction: "eyes",
  // Shown on the message that started a task while an agent works on it, in
  // workspaces where Slack's native thread status is not available.
  chatWorkingReaction: "gear",
  // The tasks channel: every task gets a thread there, rooted at a card.
  // Empty means no tasks channel; tasks then live only in threads that
  // started from a mention.
  chatTasksChannelId: "",
  chatTasksThreadScope: "assigned",
} as const;
