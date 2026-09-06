// One task = one thread.
//
// A mention of the bot (or a DM) that is not inside a bound thread creates a
// Paperclip task; the bot answers in the thread under that message and the
// thread is bound to the task. From then on every human reply in the thread
// becomes a comment on the task, and every comment on the task that the plugin
// did not write itself is posted into the thread.
//
// Everything here takes its dependencies as an argument so the logic is tested
// without a Paperclip host or a Slack workspace.

export type ChatStateKey = string;

export interface ChatStateStore {
  get(key: ChatStateKey): Promise<unknown>;
  set(key: ChatStateKey, value: unknown): Promise<void>;
}

export interface ChatIssuesClient {
  create(input: { title: string; description: string; projectId?: string }): Promise<{ id: string; identifier: string | null }>;
  createComment(issueId: string, body: string): Promise<{ id: string }>;
  requestWakeup(issueId: string, reason: string): Promise<void>;
  listComments(issueId: string): Promise<Array<{ id: string; body: string; authorType: string }>>;
}

export interface ChatSlackClient {
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ok: boolean; ts?: string; error?: string }>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
}

export interface ChatTasksConfig {
  enabled: boolean;
  /** Only mentions (or DMs) start tasks; plain channel messages are ignored. */
  requireMention: boolean;
  projectId?: string;
  ackReaction: string;
  issueUrl(issueId: string): string;
}

export interface ChatTasksDeps {
  state: ChatStateStore;
  issues: ChatIssuesClient;
  slack: ChatSlackClient;
  config: ChatTasksConfig;
  botUserId: string | undefined;
  log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

/** The fields of a Slack `message` / `app_mention` event this module reads. */
export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
}

export type ThreadBinding = { channel: string; threadTs: string };

export const CHAT_STATE_KEYS = {
  /** channel + thread root ts -> issue id */
  thread: (channel: string, threadTs: string) => `chat-thread-${channel}-${threadTs}`,
  /** issue id -> { channel, threadTs } */
  issue: (issueId: string) => `chat-issue-${issueId}`,
  /** rolling list of processed `channel:ts` keys (Slack retries and message/app_mention twins) */
  dedupe: "chat-dedupe",
  /** rolling list of comment ids this plugin wrote, so they are not echoed back */
  ownComments: "chat-own-comments",
} as const;

const DEDUPE_WINDOW = 500;
const OWN_COMMENTS_WINDOW = 500;
export const MAX_TITLE_LENGTH = 120;
/** Slack refuses messages over 4000 characters; leave room for the prefix. */
export const SLACK_CHUNK_LENGTH = 3900;

export type InboundOutcome =
  | { kind: "created"; issueId: string }
  | { kind: "commented"; issueId: string; commentId: string }
  | { kind: "ignored"; reason: string }
  | { kind: "duplicate" };

const IGNORED_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "bot_message",
  "ekm_access_denied",
  "tombstone",
]);

export function mentionsUser(text: string, userId: string | undefined): boolean {
  return Boolean(userId) && text.includes(`<@${userId}>`);
}

/** Removes the bot's own mention and tidies whitespace; other mentions stay. */
export function stripMention(text: string, userId: string | undefined): string {
  const stripped = userId ? text.replace(new RegExp(`<@${escapeRegExp(userId)}(\\|[^>]*)?>`, "g"), "") : text;
  return stripped.replace(/[ \t]+/g, " ").replace(/^\s+|\s+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First line of the message, cut at a word boundary; a fallback when the message is only a mention. */
export function extractTaskTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const plain = firstLine.replace(/[*_~`>]/g, "").trim();
  if (!plain) return "Request from Slack";
  if (plain.length <= MAX_TITLE_LENGTH) return plain;
  const cut = plain.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 40 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Enough Markdown → mrkdwn for agent comments: bold, headings, links, code fences stay. */
export function markdownToMrkdwn(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^(\s*)\d+\.\s+/gm, "$1")
    .trim();
}

/** Splits at paragraph, then line boundaries so a chunk never ends mid-word if it can help it. */
export function chunkText(text: string, limit: number = SLACK_CHUNK_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function rememberInRollingList(state: ChatStateStore, key: string, value: string, window: number): Promise<boolean> {
  const raw = await state.get(key);
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  if (list.includes(value)) return false;
  list.push(value);
  if (list.length > window) list.splice(0, list.length - window);
  await state.set(key, list);
  return true;
}

async function isInRollingList(state: ChatStateStore, key: string, value: string): Promise<boolean> {
  const raw = await state.get(key);
  return Array.isArray(raw) && (raw as string[]).includes(value);
}

export async function getThreadIssue(state: ChatStateStore, channel: string, threadTs: string): Promise<string | null> {
  const value = await state.get(CHAT_STATE_KEYS.thread(channel, threadTs));
  return typeof value === "string" && value ? value : null;
}

export async function getIssueThread(state: ChatStateStore, issueId: string): Promise<ThreadBinding | null> {
  const value = await state.get(CHAT_STATE_KEYS.issue(issueId));
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.channel === "string" && typeof v.threadTs === "string") return { channel: v.channel, threadTs: v.threadTs };
  }
  return null;
}

export async function bindThread(state: ChatStateStore, issueId: string, binding: ThreadBinding): Promise<void> {
  await state.set(CHAT_STATE_KEYS.thread(binding.channel, binding.threadTs), issueId);
  await state.set(CHAT_STATE_KEYS.issue(issueId), binding);
}

/**
 * Handles one Slack `message` or `app_mention` event. Slack sends both for a
 * mention and retries on slow responses, so the first thing is a logical
 * dedupe on `channel:ts`.
 */
export async function handleInboundMessage(deps: ChatTasksDeps, event: SlackMessageEvent): Promise<InboundOutcome> {
  if (!deps.config.enabled) return { kind: "ignored", reason: "disabled" };
  const channel = event.channel ?? "";
  const ts = event.ts ?? "";
  if (!channel || !ts) return { kind: "ignored", reason: "no_channel_or_ts" };
  if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) return { kind: "ignored", reason: `subtype:${event.subtype}` };
  if (event.bot_id || (deps.botUserId && event.user === deps.botUserId)) return { kind: "ignored", reason: "own_or_bot" };

  const fresh = await rememberInRollingList(deps.state, CHAT_STATE_KEYS.dedupe, `${channel}:${ts}`, DEDUPE_WINDOW);
  if (!fresh) return { kind: "duplicate" };

  const rawText = event.text ?? "";
  const mentioned = mentionsUser(rawText, deps.botUserId);
  const text = stripMention(rawText, deps.botUserId);
  const isDm = event.channel_type === "im" || channel.startsWith("D");
  const threadRoot = event.thread_ts && event.thread_ts !== ts ? event.thread_ts : null;

  if (threadRoot) {
    const issueId = await getThreadIssue(deps.state, channel, threadRoot);
    if (issueId) {
      if (!text) return { kind: "ignored", reason: "empty" };
      const comment = await deps.issues.createComment(issueId, formatInboundComment(text, event.user));
      await rememberInRollingList(deps.state, CHAT_STATE_KEYS.ownComments, comment.id, OWN_COMMENTS_WINDOW);
      // A plugin-authored comment never wakes the assignee on its own.
      await deps.issues.requestWakeup(issueId, "slack_reply");
      deps.log.info("Slack reply relayed as comment", { channel, threadRoot, issueId, commentId: comment.id });
      return { kind: "commented", issueId, commentId: comment.id };
    }
    // A mention inside an unbound thread starts a task for that thread.
    if (!mentioned) return { kind: "ignored", reason: "unbound_thread" };
    return createTaskForThread(deps, { channel, threadTs: threadRoot, text, user: event.user, ackTs: ts });
  }

  if (!mentioned && !isDm && deps.config.requireMention) return { kind: "ignored", reason: "no_mention" };
  if (!mentioned && !isDm && !deps.config.requireMention && !text) return { kind: "ignored", reason: "empty" };
  return createTaskForThread(deps, { channel, threadTs: ts, text, user: event.user, ackTs: ts });
}

async function createTaskForThread(
  deps: ChatTasksDeps,
  input: { channel: string; threadTs: string; text: string; user: string | undefined; ackTs: string },
): Promise<InboundOutcome> {
  const title = extractTaskTitle(input.text);
  const description = `${input.text || "_(no text)_"}\n\n---\n_Created from Slack${input.user ? ` by <@${input.user}>` : ""} in <#${input.channel}>._`;
  const issue = await deps.issues.create({ title, description, projectId: deps.config.projectId || undefined });
  await bindThread(deps.state, issue.id, { channel: input.channel, threadTs: input.threadTs });
  const label = issue.identifier ?? issue.id.slice(0, 8);
  const reply = await deps.slack.postMessage(
    input.channel,
    `Created task <${deps.config.issueUrl(issue.id)}|${label}>: ${title}\nReplies in this thread go to the task; the agent answers here.`,
    input.threadTs,
  );
  if (!reply.ok) deps.log.warn("Slack thread reply failed", { channel: input.channel, error: reply.error });
  if (deps.config.ackReaction) {
    try {
      await deps.slack.addReaction(input.channel, input.ackTs, deps.config.ackReaction);
    } catch (err) {
      deps.log.warn("Slack reaction failed", { channel: input.channel, err: String(err) });
    }
  }
  deps.log.info("Slack mention created task", { channel: input.channel, threadTs: input.threadTs, issueId: issue.id });
  return { kind: "created", issueId: issue.id };
}

export function formatInboundComment(text: string, slackUserId: string | undefined): string {
  const who = slackUserId ? `Slack user <@${slackUserId}>` : "Slack";
  return `${text}\n\n_— ${who}_`;
}

/**
 * Handles `issue.comment.created`: posts the comment into the bound thread
 * unless this plugin wrote it. The event carries only a snippet, so the full
 * body is read back from the issue.
 */
export async function handleIssueCommentCreated(
  deps: ChatTasksDeps,
  input: { issueId: string; commentId: string },
): Promise<{ posted: boolean; reason?: string }> {
  if (!deps.config.enabled) return { posted: false, reason: "disabled" };
  const binding = await getIssueThread(deps.state, input.issueId);
  if (!binding) return { posted: false, reason: "unbound" };
  if (await isInRollingList(deps.state, CHAT_STATE_KEYS.ownComments, input.commentId)) return { posted: false, reason: "own" };
  const comments = await deps.issues.listComments(input.issueId);
  const comment = comments.find((c) => c.id === input.commentId);
  if (!comment) return { posted: false, reason: "comment_not_found" };
  const body = markdownToMrkdwn(comment.body);
  if (!body) return { posted: false, reason: "empty" };
  const chunks = chunkText(body);
  for (const chunk of chunks) {
    const result = await deps.slack.postMessage(binding.channel, chunk, binding.threadTs);
    if (!result.ok) {
      deps.log.warn("Slack thread post failed", { issueId: input.issueId, error: result.error });
      return { posted: false, reason: result.error ?? "slack_error" };
    }
  }
  return { posted: true };
}

/** Handles a status change on a bound task: a short line in the thread. */
export async function handleIssueStatusChanged(
  deps: ChatTasksDeps,
  input: { issueId: string; status: string; title?: string },
): Promise<boolean> {
  const binding = await getIssueThread(deps.state, input.issueId);
  if (!binding) return false;
  const line =
    input.status === "done"
      ? `✅ Task done${input.title ? `: ${input.title}` : ""}`
      : input.status === "cancelled"
        ? `🚫 Task cancelled${input.title ? `: ${input.title}` : ""}`
        : null;
  if (!line) return false;
  const result = await deps.slack.postMessage(binding.channel, line, binding.threadTs);
  return result.ok;
}
