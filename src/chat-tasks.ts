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
  /** actorUserId attributes the comment to that Paperclip user; the host wakes the assignee for it. */
  createComment(issueId: string, body: string, options?: { actorUserId?: string }): Promise<{ id: string }>;
  requestWakeup(issueId: string, reason: string): Promise<void>;
  listComments(issueId: string): Promise<Array<{ id: string; body: string; authorType: string }>>;
  listInteractions(issueId: string): Promise<ChatInteraction[]>;
  respondInteraction(issueId: string, interactionId: string, action: "accept" | "reject"): Promise<{ applied: boolean }>;
}

/** The part of a Paperclip issue-thread interaction the thread card needs. */
export interface ChatInteraction {
  id: string;
  kind: string;
  status: string;
  title?: string | null;
  summary?: string | null;
  payload: Record<string, unknown>;
}

export interface ChatSlackClient {
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ok: boolean; ts?: string; error?: string }>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  /** Slack's native thread status; resolves false when the workspace or token cannot show one. */
  setThreadStatus(channel: string, threadTs: string, status: string): Promise<boolean>;
  postBlocks(channel: string, text: string, blocks: unknown[], threadTs?: string): Promise<{ ok: boolean; ts?: string; error?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<{ ok: boolean; error?: string }>;
}

export interface ChatTasksConfig {
  enabled: boolean;
  /** Only mentions (or DMs) start tasks; plain channel messages are ignored. */
  requireMention: boolean;
  projectId?: string;
  ackReaction: string;
  /** Reaction that stands in for the thread status where Slack cannot show one. */
  workingReaction: string;
  /** Slack user id -> Paperclip user id, for comments attributed to the person rather than the bot. */
  pairings: Record<string, string>;
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
  /** issue id -> the run currently shown as working, so a stale finish cannot clear a newer start */
  working: (issueId: string) => `chat-working-${issueId}`,
  /** interaction id -> { ts, status } of its card in the thread */
  interaction: (id: string) => `chat-interaction-${id}`,
  /** issue ids with a thread, for the interaction poll */
  boundIssues: "chat-bound-issues",
} as const;

const BOUND_ISSUES_WINDOW = 200;

/** action_id values of the interaction buttons; the value carries "<issueId>:<interactionId>". */
export const INTERACTION_ACTIONS = {
  accept: "chat_interaction_accept",
  reject: "chat_interaction_reject",
} as const;

/** What the thread status says while an agent is on the task. */
export const WORKING_STATUS = "is working on this task…";

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
  await rememberInRollingList(state, CHAT_STATE_KEYS.boundIssues, issueId, BOUND_ISSUES_WINDOW);
}

export async function listBoundIssues(state: ChatStateStore): Promise<string[]> {
  const raw = await state.get(CHAT_STATE_KEYS.boundIssues);
  return Array.isArray(raw) ? (raw as string[]) : [];
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
      const comment = await relayComment(deps, issueId, text, event.user);
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

/**
 * Writes a Slack reply as a comment. A sender paired to a Paperclip user is
 * that user: the comment is theirs and the host wakes the assignee as for
 * any comment from the web app. Anyone else is relayed under the plugin's
 * identity with their Slack handle, and the assignee is woken by hand.
 */
async function relayComment(deps: ChatTasksDeps, issueId: string, text: string, slackUserId: string | undefined): Promise<{ id: string }> {
  const paired = slackUserId ? deps.config.pairings[slackUserId] : undefined;
  if (paired) {
    try {
      const comment = await deps.issues.createComment(issueId, text, { actorUserId: paired });
      await rememberInRollingList(deps.state, CHAT_STATE_KEYS.ownComments, comment.id, OWN_COMMENTS_WINDOW);
      return comment;
    } catch (err) {
      // The pairing names someone the host no longer accepts (left the
      // company, or the capability is missing); fall through to the relay.
      deps.log.warn("human-attributed comment refused; relaying as the bot", { slackUserId, err: String(err) });
    }
  }
  const comment = await deps.issues.createComment(issueId, formatInboundComment(text, slackUserId));
  await rememberInRollingList(deps.state, CHAT_STATE_KEYS.ownComments, comment.id, OWN_COMMENTS_WINDOW);
  // A plugin-authored comment never wakes the assignee on its own.
  await deps.issues.requestWakeup(issueId, "slack_reply");
  return comment;
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

/**
 * Handles a status change on a bound task. A finished task gets one line in
 * the thread and the working marks come off; in-progress and anything else
 * are shown by the run lifecycle, not by a message.
 */
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
  await clearWorking(deps, input.issueId, binding);
  const result = await deps.slack.postMessage(binding.channel, line, binding.threadTs);
  return result.ok;
}

export type RunLifecycle = "started" | "finished" | "failed" | "cancelled";

/**
 * Handles an agent run on a bound task. While the run lasts the thread
 * carries Slack's native status ("is working…"), or, where the workspace
 * cannot show one, a reaction on the message that started the task; nothing
 * is posted. A failed run is the one outcome that gets a line, because the
 * person would otherwise wait for an answer that is not coming.
 */
export async function handleRunLifecycle(
  deps: ChatTasksDeps,
  input: { issueId: string; runId: string; state: RunLifecycle; error?: string },
): Promise<boolean> {
  if (!deps.config.enabled) return false;
  const binding = await getIssueThread(deps.state, input.issueId);
  if (!binding) return false;
  if (input.state === "started") {
    await deps.state.set(CHAT_STATE_KEYS.working(input.issueId), input.runId);
    const shown = await deps.slack.setThreadStatus(binding.channel, binding.threadTs, WORKING_STATUS);
    if (!shown && deps.config.workingReaction) {
      await safely(deps, () => deps.slack.addReaction(binding.channel, binding.threadTs, deps.config.workingReaction));
    }
    return true;
  }
  // A finish for a run that is not the one shown (an older run ending after
  // a newer one started) must not clear the newer run's status.
  const shown = await deps.state.get(CHAT_STATE_KEYS.working(input.issueId));
  if (typeof shown === "string" && shown && shown !== input.runId) return false;
  await clearWorking(deps, input.issueId, binding);
  if (input.state === "failed") {
    const reason = input.error ? `: ${input.error}` : "";
    await deps.slack.postMessage(binding.channel, `❌ The agent's run failed${reason}`, binding.threadTs);
  }
  return true;
}

async function clearWorking(deps: ChatTasksDeps, issueId: string, binding: ThreadBinding): Promise<void> {
  await deps.state.set(CHAT_STATE_KEYS.working(issueId), "");
  await deps.slack.setThreadStatus(binding.channel, binding.threadTs, "");
  if (deps.config.workingReaction) {
    await safely(deps, () => deps.slack.removeReaction(binding.channel, binding.threadTs, deps.config.workingReaction));
  }
}

async function safely(deps: ChatTasksDeps, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.log.warn("Slack call failed", { err: String(err) });
  }
}

// ---- interactions -----------------------------------------------------------
//
// An agent's question to the person (a confirmation, a set of questions, a
// list of suggested tasks) is a card in the thread. The host raises no event
// when one is created, so bound tasks are polled. The plugin SDK can accept
// or reject an interaction but not answer questions or pick tasks, so those
// cards carry the question and a link to answer in Tandem.

type InteractionCard = { ts: string; status: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function interactionHeading(i: ChatInteraction): string {
  switch (i.kind) {
    case "request_confirmation":
    case "request_checkbox_confirmation":
      return "The agent asks you to confirm";
    case "ask_user_questions":
      return "The agent has questions";
    case "suggest_tasks":
      return "The agent suggests tasks";
    case "request_item_verdicts":
      return "The agent asks for verdicts";
    default:
      return "The agent needs you";
  }
}

/** The card's text: what is asked, in mrkdwn, without the buttons. */
export function interactionText(i: ChatInteraction): string {
  const p = i.payload;
  const lines: string[] = [`*${interactionHeading(i)}*`];
  if (i.title) lines.push(`*${i.title}*`);
  switch (i.kind) {
    case "request_confirmation":
    case "request_checkbox_confirmation": {
      if (str(p.prompt)) lines.push(str(p.prompt));
      if (str(p.detailsMarkdown)) lines.push(markdownToMrkdwn(str(p.detailsMarkdown)));
      const options = arr(p.options).map(rec);
      if (options.length) lines.push(options.map((o) => `• ${str(o.label) || str(o.id)}`).join("\n"));
      break;
    }
    case "ask_user_questions": {
      const questions = arr(p.questions).map(rec);
      questions.forEach((q, n) => {
        lines.push(`${n + 1}. ${str(q.prompt) || str(q.header)}`);
        const options = arr(q.options).map(rec);
        if (options.length) lines.push(options.map((o) => `    • ${str(o.label) || str(o.id)}`).join("\n"));
      });
      break;
    }
    case "suggest_tasks": {
      const tasks = arr(p.tasks).map(rec);
      if (tasks.length) lines.push(tasks.map((t) => `• ${str(t.title)}`).join("\n"));
      break;
    }
    default:
      if (i.summary) lines.push(i.summary);
  }
  if (i.summary && i.kind !== "request_confirmation" && !lines.includes(i.summary)) lines.push(i.summary);
  return lines.join("\n");
}

/** Block Kit for a pending interaction. */
export function interactionBlocks(i: ChatInteraction, issueId: string, issueUrl: string): unknown[] {
  const p = i.payload;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: interactionText(i).slice(0, 2900) } }];
  const value = `${issueId}:${i.id}`;
  const elements: unknown[] = [];
  if (i.kind === "request_confirmation" || i.kind === "request_checkbox_confirmation") {
    elements.push(
      { type: "button", text: { type: "plain_text", text: (str(p.acceptLabel) || "Accept").slice(0, 75) }, style: "primary", action_id: INTERACTION_ACTIONS.accept, value },
      { type: "button", text: { type: "plain_text", text: (str(p.rejectLabel) || "Reject").slice(0, 75) }, style: "danger", action_id: INTERACTION_ACTIONS.reject, value },
    );
  }
  elements.push({ type: "button", text: { type: "plain_text", text: elements.length ? "Open in Tandem" : "Answer in Tandem" }, url: issueUrl, action_id: "chat_interaction_open" });
  blocks.push({ type: "actions", elements });
  return blocks;
}

/** What a settled card says instead of its buttons. */
export function interactionOutcome(i: ChatInteraction, by?: string): string {
  const who = by ? ` by ${by}` : "";
  switch (i.status) {
    case "accepted":
      return `✅ Accepted${who}`;
    case "rejected":
      return `❌ Rejected${who}`;
    case "answered":
      return `✅ Answered${who}`;
    case "cancelled":
      return "🚫 Withdrawn";
    default:
      return `Closed (${i.status})`;
  }
}

/**
 * Brings the thread's cards in line with the task's interactions: a pending
 * one not yet shown gets a card; a shown one that settled elsewhere (in the
 * web app, or by another person) has its buttons replaced by the outcome.
 * Returns how many cards were posted or updated.
 */
export async function syncInteractions(deps: ChatTasksDeps, issueId: string): Promise<number> {
  if (!deps.config.enabled) return 0;
  const binding = await getIssueThread(deps.state, issueId);
  if (!binding) return 0;
  const interactions = await deps.issues.listInteractions(issueId);
  let changed = 0;
  for (const i of interactions) {
    const key = CHAT_STATE_KEYS.interaction(i.id);
    const card = (await deps.state.get(key)) as InteractionCard | null | undefined;
    if (!card) {
      if (i.status !== "pending") continue;
      const text = interactionText(i);
      const result = await deps.slack.postBlocks(binding.channel, text, interactionBlocks(i, issueId, deps.config.issueUrl(issueId)), binding.threadTs);
      if (!result.ok || !result.ts) {
        deps.log.warn("Slack interaction card failed", { issueId, interactionId: i.id, error: result.error });
        continue;
      }
      await deps.state.set(key, { ts: result.ts, status: "pending" } satisfies InteractionCard);
      changed += 1;
      continue;
    }
    if (card.status === i.status || i.status === "pending") continue;
    const text = `${interactionText(i)}\n\n${interactionOutcome(i)}`;
    const result = await deps.slack.updateMessage(binding.channel, card.ts, text, [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }]);
    if (!result.ok) {
      deps.log.warn("Slack interaction card update failed", { issueId, interactionId: i.id, error: result.error });
      continue;
    }
    await deps.state.set(key, { ts: card.ts, status: i.status } satisfies InteractionCard);
    changed += 1;
  }
  return changed;
}

/** Runs syncInteractions over every bound task; the poll's body. */
export async function syncAllInteractions(deps: ChatTasksDeps): Promise<number> {
  let changed = 0;
  for (const issueId of await listBoundIssues(deps.state)) {
    try {
      changed += await syncInteractions(deps, issueId);
    } catch (err) {
      deps.log.warn("interaction sync failed", { issueId, err: String(err) });
    }
  }
  return changed;
}

/**
 * Handles a click on a card's Accept or Reject. Returns the text the card
 * should show now; the caller replaces the card with it through Slack's
 * response_url.
 */
export async function handleInteractionAction(
  deps: ChatTasksDeps,
  input: { value: string; action: "accept" | "reject"; slackUserId?: string },
): Promise<{ ok: boolean; text: string }> {
  const [issueId, interactionId] = input.value.split(":");
  if (!issueId || !interactionId) return { ok: false, text: "This button no longer points at a task." };
  const interactions = await deps.issues.listInteractions(issueId);
  const current = interactions.find((i) => i.id === interactionId);
  if (!current) return { ok: false, text: "This request is gone." };
  if (current.status !== "pending") {
    const text = `${interactionText(current)}\n\n${interactionOutcome(current)}`;
    await deps.state.set(CHAT_STATE_KEYS.interaction(interactionId), { ts: "", status: current.status } satisfies InteractionCard);
    return { ok: true, text };
  }
  let applied = false;
  try {
    applied = (await deps.issues.respondInteraction(issueId, interactionId, input.action)).applied;
  } catch (err) {
    deps.log.warn("respondInteraction failed", { issueId, interactionId, err: String(err) });
    return { ok: false, text: `${interactionText(current)}\n\n⚠️ Could not record the answer: ${String(err).slice(0, 200)}` };
  }
  const settled: ChatInteraction = { ...current, status: input.action === "accept" ? "accepted" : "rejected" };
  const by = input.slackUserId ? `<@${input.slackUserId}>` : undefined;
  const text = `${interactionText(settled)}\n\n${interactionOutcome(settled, by)}${applied ? "" : " (recorded, not applied)"}`;
  const card = (await deps.state.get(CHAT_STATE_KEYS.interaction(interactionId))) as InteractionCard | null | undefined;
  await deps.state.set(CHAT_STATE_KEYS.interaction(interactionId), { ts: card?.ts ?? "", status: settled.status } satisfies InteractionCard);
  return { ok: true, text };
}
