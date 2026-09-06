import { describe, it, expect, beforeEach } from "vitest";
import {
  CHAT_STATE_KEYS,
  chunkText,
  extractTaskTitle,
  handleInboundMessage,
  handleIssueCommentCreated,
  ensureTaskThread,
  refreshTaskCard,
  wantsTaskThread,
  taskCardText,
  DM_UNSUPPORTED_REPLY,
  type ChatIssueSummary,
  handleIssueStatusChanged,
  handleRunLifecycle,
  handleInteractionAction,
  interactionBlocks,
  interactionText,
  syncInteractions,
  syncAllInteractions,
  listBoundIssues,
  markdownToMrkdwn,
  INTERACTION_ACTIONS,
  WORKING_STATUS,
  type ChatInteraction,
  stripMention,
  type ChatTasksDeps,
} from "../src/chat-tasks.js";

const BOT = "UBOT";

function makeDeps(overrides: Partial<ChatTasksDeps["config"]> = {}) {
  const store = new Map<string, unknown>();
  const created: Array<{ title: string; description: string; projectId?: string }> = [];
  const comments: Array<{ issueId: string; body: string; actorUserId?: string }> = [];
  const wakeups: string[] = [];
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const reactions: Array<{ channel: string; ts: string; name: string }> = [];
  const removed: Array<{ channel: string; ts: string; name: string }> = [];
  const statuses: Array<{ channel: string; threadTs: string; status: string }> = [];
  let statusSupported = true;
  const blockPosts: Array<{ channel: string; text: string; blocks: unknown[]; threadTs?: string }> = [];
  const updates: Array<{ channel: string; ts: string; text: string }> = [];
  const interactions = new Map<string, ChatInteraction[]>();
  const responses: Array<{ issueId: string; interactionId: string; action: string }> = [];
  let issueSeq = 0;
  let commentSeq = 0;
  const issueComments = new Map<string, Array<{ id: string; body: string; authorType: string }>>();
  const issuesById = new Map<string, ChatIssueSummary>();
  const agents = new Map<string, string>([["agent-ceo", "CEO"]]);
  const deps: ChatTasksDeps = {
    state: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
    },
    issues: {
      create: async (input) => {
        created.push(input);
        issueSeq += 1;
        const id = `issue-${issueSeq}`;
        issuesById.set(id, { id, identifier: `ACME-${issueSeq}`, title: input.title, status: "todo", parentId: null, assigneeAgentId: null });
        return { id, identifier: `ACME-${issueSeq}` };
      },
      get: async (issueId) => issuesById.get(issueId) ?? null,
      agentName: async (agentId) => agents.get(agentId) ?? null,
      createComment: async (issueId, body, options) => {
        if (options?.actorUserId === "user-gone") throw new Error("not an active member");
        comments.push({ issueId, body, actorUserId: options?.actorUserId });
        commentSeq += 1;
        const id = `comment-${commentSeq}`;
        const list = issueComments.get(issueId) ?? [];
        list.push({ id, body, authorType: "agent" });
        issueComments.set(issueId, list);
        return { id };
      },
      requestWakeup: async (issueId) => void wakeups.push(issueId),
      listComments: async (issueId) => issueComments.get(issueId) ?? [],
      listInteractions: async (issueId) => interactions.get(issueId) ?? [],
      respondInteraction: async (issueId, interactionId, action) => {
        responses.push({ issueId, interactionId, action });
        const i = (interactions.get(issueId) ?? []).find((x) => x.id === interactionId);
        if (i) i.status = action === "accept" ? "accepted" : "rejected";
        return { applied: true };
      },
    },
    slack: {
      postMessage: async (channel, text, threadTs) => {
        posts.push({ channel, text, threadTs });
        return { ok: true, ts: `${posts.length}.000` };
      },
      addReaction: async (channel, ts, name) => void reactions.push({ channel, ts, name }),
      removeReaction: async (channel, ts, name) => void removed.push({ channel, ts, name }),
      setThreadStatus: async (channel, threadTs, status) => {
        statuses.push({ channel, threadTs, status });
        return statusSupported;
      },
      postBlocks: async (channel, text, blocks, threadTs) => {
        blockPosts.push({ channel, text, blocks, threadTs });
        return { ok: true, ts: `card-${blockPosts.length}` };
      },
      updateMessage: async (channel, ts, text) => {
        updates.push({ channel, ts, text });
        return { ok: true };
      },
    },
    config: {
      enabled: true,
      requireMention: true,
      projectId: "proj-1",
      ackReaction: "eyes",
      workingReaction: "gear",
      pairings: {},
      tasksThreadScope: "assigned",
      issueUrl: (id) => `https://pc.example/issues/${id}`,
      ...overrides,
    },
    botUserId: BOT,
    log: { info() {}, warn() {} },
  };
  return {
    deps, store, created, comments, wakeups, posts, reactions, removed, statuses, issueComments,
    blockPosts, updates, interactions, responses, issuesById,
    setStatusSupported: (v: boolean) => { statusSupported = v; },
  };
}

describe("text helpers", () => {
  it("strips the bot mention and keeps other mentions", () => {
    expect(stripMention(`<@${BOT}> please review <@U2>'s PR`, BOT)).toBe("please review <@U2>'s PR");
    expect(stripMention(`<@${BOT}|tandem>   hi`, BOT)).toBe("hi");
  });

  it("titles from the first line, cut at a word boundary, with a fallback", () => {
    expect(extractTaskTitle("Fix the login page\nIt 500s on submit")).toBe("Fix the login page");
    expect(extractTaskTitle("")).toBe("Request from Slack");
    const long = extractTaskTitle(`${"word ".repeat(40)}end`);
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith("…")).toBe(true);
  });

  it("converts the markdown agents write into mrkdwn", () => {
    expect(markdownToMrkdwn("## Plan\n\n**bold** and [docs](https://x.y/z)\n- one\n- two")).toBe(
      "*Plan*\n\n*bold* and <https://x.y/z|docs>\n• one\n• two",
    );
  });

  it("chunks long text at paragraph boundaries", () => {
    const para = "a".repeat(2000);
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 4100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${para}\n\n${para}`);
    expect(chunks[1]).toBe(para);
  });
});

describe("inbound: mention creates a task bound to the thread", () => {
  let env: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    env = makeDeps();
  });

  it("creates a task, replies in the thread, reacts, stores both bindings", async () => {
    const outcome = await handleInboundMessage(env.deps, {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: `<@${BOT}> Write the release notes\nfor 2.3`,
      ts: "100.1",
    });
    expect(outcome).toEqual({ kind: "created", issueId: "issue-1" });
    expect(env.created[0]).toMatchObject({ title: "Write the release notes", projectId: "proj-1" });
    expect(env.created[0]!.description).toContain("Write the release notes\nfor 2.3");
    expect(env.created[0]!.description).toContain("<@U1>");
    expect(env.posts[0]).toMatchObject({ channel: "C1", threadTs: "100.1" });
    expect(env.posts[0]!.text).toContain("ACME-1");
    expect(env.posts[0]!.text).toContain("https://pc.example/issues/issue-1");
    expect(env.reactions[0]).toEqual({ channel: "C1", ts: "100.1", name: "eyes" });
    expect(env.store.get(CHAT_STATE_KEYS.thread("C1", "100.1"))).toBe("issue-1");
    expect(env.store.get(CHAT_STATE_KEYS.issue("issue-1"))).toEqual({ channel: "C1", threadTs: "100.1" });
  });

  it("dedupes the app_mention twin and Slack retries by channel:ts", async () => {
    const event = { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> hi`, ts: "100.1" };
    await handleInboundMessage(env.deps, event);
    expect(await handleInboundMessage(env.deps, { ...event, type: "app_mention" })).toEqual({ kind: "duplicate" });
    expect(await handleInboundMessage(env.deps, event)).toEqual({ kind: "duplicate" });
    expect(env.created).toHaveLength(1);
  });

  it("answers a direct message that it is not supported yet, and creates nothing", async () => {
    const env = makeDeps();
    const out = await handleInboundMessage(env.deps, { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "1.2" });
    expect(out).toEqual({ kind: "unsupported", reason: "dm" });
    expect(env.created).toHaveLength(0);
    expect(env.posts).toEqual([{ channel: "D1", text: DM_UNSUPPORTED_REPLY, threadTs: undefined }]);
  });

  it("ignores plain channel messages when a mention is required, and answers DMs with unsupported", async () => {
    expect(await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: "hello", ts: "1.1" })).toEqual({
      kind: "ignored",
      reason: "no_mention",
    });
    expect(await handleInboundMessage(env.deps, { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "1.2" })).toEqual({ kind: "unsupported", reason: "dm" });
  });

  it("ignores the bot's own messages, bot messages and edits", async () => {
    expect(await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: BOT, text: "x", ts: "1.1" })).toMatchObject({ kind: "ignored", reason: "own_or_bot" });
    expect(await handleInboundMessage(env.deps, { type: "message", channel: "C1", bot_id: "B1", text: "x", ts: "1.2" })).toMatchObject({ kind: "ignored" });
    expect(await handleInboundMessage(env.deps, { type: "message", subtype: "message_changed", channel: "C1", text: "x", ts: "1.3" })).toMatchObject({ kind: "ignored" });
  });

  it("does nothing when disabled", async () => {
    const off = makeDeps({ enabled: false });
    expect(await handleInboundMessage(off.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> x`, ts: "1" })).toMatchObject({ kind: "ignored", reason: "disabled" });
  });
});

describe("inbound: replies in a bound thread become comments", () => {
  it("relays the reply as a comment, remembers it as its own, and wakes the assignee", async () => {
    const env = makeDeps();
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    const outcome = await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U2", text: "also check staging", ts: "100.2", thread_ts: "100.1" });
    expect(outcome).toEqual({ kind: "commented", issueId: "issue-1", commentId: "comment-1" });
    expect(env.comments[0]).toMatchObject({ issueId: "issue-1" });
    expect(env.comments[0]!.body).toContain("also check staging");
    expect(env.comments[0]!.body).toContain("<@U2>");
    expect(env.wakeups).toEqual(["issue-1"]);
    expect(env.store.get(CHAT_STATE_KEYS.ownComments)).toEqual(["comment-1"]);
  });

  it("ignores replies in threads it does not know, unless the bot is mentioned", async () => {
    const env = makeDeps();
    expect(await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: "random", ts: "5.2", thread_ts: "5.1" })).toEqual({
      kind: "ignored",
      reason: "unbound_thread",
    });
    const outcome = await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> take this thread`, ts: "5.3", thread_ts: "5.1" });
    expect(outcome).toEqual({ kind: "created", issueId: "issue-1" });
    // Bound to the thread root, acked on the mention itself.
    expect(env.store.get(CHAT_STATE_KEYS.thread("C1", "5.1"))).toBe("issue-1");
    expect(env.reactions[0]).toMatchObject({ ts: "5.3" });
  });
});

describe("outbound: task comments and status land in the thread", () => {
  it("posts a comment it did not write, converted and chunked", async () => {
    const env = makeDeps();
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    env.issueComments.set("issue-1", [{ id: "agent-1", body: "**Done.** See [PR](https://g.h/p/1)\n\n" + "x".repeat(5000), authorType: "agent" }]);
    const result = await handleIssueCommentCreated(env.deps, { issueId: "issue-1", commentId: "agent-1" });
    expect(result).toEqual({ posted: true });
    const threadPosts = env.posts.filter((p) => p.threadTs === "100.1");
    // 1 creation reply + 2 chunks
    expect(threadPosts).toHaveLength(3);
    expect(threadPosts[1]!.text.startsWith("*Done.* See <https://g.h/p/1|PR>")).toBe(true);
  });

  it("does not echo its own comments and skips unbound issues", async () => {
    const env = makeDeps();
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: "reply", ts: "100.2", thread_ts: "100.1" });
    expect(await handleIssueCommentCreated(env.deps, { issueId: "issue-1", commentId: "comment-1" })).toEqual({ posted: false, reason: "own" });
    expect(await handleIssueCommentCreated(env.deps, { issueId: "issue-9", commentId: "c" })).toEqual({ posted: false, reason: "unbound" });
  });

  it("announces done in the thread", async () => {
    const env = makeDeps();
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    expect(await handleIssueStatusChanged(env.deps, { issueId: "issue-1", status: "done", title: "start" })).toBe(true);
    expect(env.posts.at(-1)).toMatchObject({ threadTs: "100.1", text: "✅ Task done: start" });
    expect(await handleIssueStatusChanged(env.deps, { issueId: "issue-1", status: "in_progress" })).toBe(false);
  });
});

describe("run lifecycle: the thread's status, not a message", () => {
  async function bound() {
    const env = makeDeps();
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    const postsBefore = env.posts.length;
    return { env, postsBefore };
  }

  it("shows Slack's native status while the run lasts and clears it after, posting nothing", async () => {
    const { env, postsBefore } = await bound();
    expect(await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "started" })).toBe(true);
    expect(env.statuses).toEqual([{ channel: "C1", threadTs: "100.1", status: WORKING_STATUS }]);
    expect(env.reactions.filter((r) => r.name === "gear")).toHaveLength(0);
    expect(await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "finished" })).toBe(true);
    expect(env.statuses.at(-1)).toEqual({ channel: "C1", threadTs: "100.1", status: "" });
    expect(env.posts).toHaveLength(postsBefore);
  });

  it("falls back to a reaction where the workspace cannot show a status", async () => {
    const { env } = await bound();
    env.setStatusSupported(false);
    await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "started" });
    expect(env.reactions.at(-1)).toEqual({ channel: "C1", ts: "100.1", name: "gear" });
    await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "finished" });
    expect(env.removed.at(-1)).toEqual({ channel: "C1", ts: "100.1", name: "gear" });
  });

  it("posts one line when the run fails", async () => {
    const { env, postsBefore } = await bound();
    await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "started" });
    await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "failed", error: "timed out" });
    expect(env.posts).toHaveLength(postsBefore + 1);
    expect(env.posts.at(-1)).toMatchObject({ threadTs: "100.1", text: "❌ The agent's run failed: timed out" });
  });

  it("ignores an older run finishing after a newer one started, and unbound issues", async () => {
    const { env } = await bound();
    await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "started" });
    await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-2", state: "started" });
    expect(await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "finished" })).toBe(false);
    expect(env.statuses.at(-1)!.status).toBe(WORKING_STATUS);
    expect(await handleRunLifecycle(env.deps, { issueId: "issue-9", runId: "r", state: "started" })).toBe(false);
  });

  it("clears the working marks when the task is done", async () => {
    const { env } = await bound();
    await handleRunLifecycle(env.deps, { issueId: "issue-1", runId: "run-1", state: "started" });
    await handleIssueStatusChanged(env.deps, { issueId: "issue-1", status: "done" });
    expect(env.statuses.at(-1)!.status).toBe("");
    expect(env.posts.at(-1)!.text).toContain("✅");
  });
});

describe("interactions: cards in the thread", () => {
  const confirm: ChatInteraction = {
    id: "int-1",
    kind: "request_confirmation",
    status: "pending",
    title: "Deploy to staging?",
    payload: { prompt: "I will deploy build 42 to staging.", acceptLabel: "Deploy", rejectLabel: "Hold" },
  };
  const questions: ChatInteraction = {
    id: "int-2",
    kind: "ask_user_questions",
    status: "pending",
    payload: { questions: [{ id: "q1", prompt: "Which region?", options: [{ id: "eu", label: "EU" }, { id: "us", label: "US" }] }] },
  };

  async function bound() {
    const env = makeDeps();
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    return env;
  }

  it("renders a confirmation with accept and reject buttons carrying issue and interaction ids", () => {
    const blocks = interactionBlocks(confirm, "issue-1", "https://pc.example/issues/issue-1") as Array<Record<string, any>>;
    expect(interactionText(confirm)).toContain("Deploy to staging?");
    expect(interactionText(confirm)).toContain("I will deploy build 42 to staging.");
    const buttons = blocks[1]!.elements as Array<Record<string, any>>;
    expect(buttons.map((b) => b.action_id)).toEqual([INTERACTION_ACTIONS.accept, INTERACTION_ACTIONS.reject, "chat_interaction_open"]);
    expect(buttons[0]!.value).toBe("issue-1:int-1");
    expect(buttons[0]!.text.text).toBe("Deploy");
  });

  it("renders questions with their options and only a link to answer", () => {
    const text = interactionText(questions);
    expect(text).toContain("1. Which region?");
    expect(text).toContain("• EU");
    const blocks = interactionBlocks(questions, "issue-1", "https://pc.example/issues/issue-1") as Array<Record<string, any>>;
    const buttons = blocks[1]!.elements as Array<Record<string, any>>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.text.text).toBe("Answer in Tandem");
    expect(buttons[0]!.url).toBe("https://pc.example/issues/issue-1");
  });

  it("posts a card once per pending interaction and updates it when it settles elsewhere", async () => {
    const env = await bound();
    env.interactions.set("issue-1", [{ ...confirm }, { ...questions }]);
    expect(await syncInteractions(env.deps, "issue-1")).toBe(2);
    expect(env.blockPosts).toHaveLength(2);
    expect(env.blockPosts[0]).toMatchObject({ channel: "C1", threadTs: "100.1" });
    // Nothing new: nothing posted again.
    expect(await syncInteractions(env.deps, "issue-1")).toBe(0);
    expect(env.blockPosts).toHaveLength(2);
    // Answered in the web app: the card loses its buttons and says so.
    env.interactions.get("issue-1")![1]!.status = "answered";
    expect(await syncInteractions(env.deps, "issue-1")).toBe(1);
    expect(env.updates.at(-1)).toMatchObject({ ts: "card-2" });
    expect(env.updates.at(-1)!.text).toContain("✅ Answered");
    // The poll covers every bound task.
    expect(await listBoundIssues(env.deps.state)).toEqual(["issue-1"]);
    expect(await syncAllInteractions(env.deps)).toBe(0);
  });

  it("accept and reject buttons answer the interaction and say who did it", async () => {
    const env = await bound();
    env.interactions.set("issue-1", [{ ...confirm }]);
    await syncInteractions(env.deps, "issue-1");
    const outcome = await handleInteractionAction(env.deps, { value: "issue-1:int-1", action: "accept", slackUserId: "U7" });
    expect(outcome.ok).toBe(true);
    expect(env.responses).toEqual([{ issueId: "issue-1", interactionId: "int-1", action: "accept" }]);
    expect(outcome.text).toContain("✅ Accepted by <@U7>");
    // A second click on a settled card answers nothing and shows the outcome.
    const again = await handleInteractionAction(env.deps, { value: "issue-1:int-1", action: "reject", slackUserId: "U8" });
    expect(env.responses).toHaveLength(1);
    expect(again.text).toContain("✅ Accepted");
    // Junk values are refused politely.
    expect((await handleInteractionAction(env.deps, { value: "nope", action: "accept" })).ok).toBe(false);
  });

  it("does nothing for tasks without a thread", async () => {
    const env = makeDeps();
    env.interactions.set("issue-9", [{ ...confirm }]);
    expect(await syncInteractions(env.deps, "issue-9")).toBe(0);
    expect(env.blockPosts).toHaveLength(0);
  });
});

describe("inbound: paired senders are themselves", () => {
  it("attributes a paired person's reply to their Tandem user and lets the host wake the assignee", async () => {
    const env = makeDeps({ pairings: { U2: "auth0|pavel" } });
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U2", text: "ship it", ts: "100.2", thread_ts: "100.1" });
    expect(env.comments.at(-1)).toEqual({ issueId: "issue-1", body: "ship it", actorUserId: "auth0|pavel" });
    expect(env.wakeups).toEqual([]);
    // Unpaired people are relayed by the bot, with a wakeup.
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U3", text: "me too", ts: "100.3", thread_ts: "100.1" });
    expect(env.comments.at(-1)!.actorUserId).toBeUndefined();
    expect(env.comments.at(-1)!.body).toContain("<@U3>");
    expect(env.wakeups).toEqual(["issue-1"]);
  });

  it("falls back to the bot when the host refuses the pairing", async () => {
    const env = makeDeps({ pairings: { U2: "user-gone" } });
    await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U1", text: `<@${BOT}> start`, ts: "100.1" });
    const outcome = await handleInboundMessage(env.deps, { type: "message", channel: "C1", user: "U2", text: "hello", ts: "100.2", thread_ts: "100.1" });
    expect(outcome.kind).toBe("commented");
    expect(env.comments.at(-1)!.actorUserId).toBeUndefined();
    expect(env.wakeups).toEqual(["issue-1"]);
  });
});

describe("tasks channel: one thread per task", () => {
  it("opens a thread with a card for a top-level task that has an agent, once", async () => {
    const env = makeDeps({ tasksChannelId: "CTASKS" });
    env.issuesById.set("t1", { id: "t1", identifier: "ACME-7", title: "Check August payments", status: "todo", priority: "high", parentId: null, assigneeAgentId: "agent-ceo" });
    expect(await ensureTaskThread(env.deps, "t1")).toEqual({ created: true });
    expect(env.blockPosts).toHaveLength(1);
    expect(env.blockPosts[0].channel).toBe("CTASKS");
    expect(env.blockPosts[0].threadTs).toBeUndefined();
    expect(env.blockPosts[0].text).toBe(taskCardText(env.issuesById.get("t1")!, "CEO", "https://pc.example/issues/t1"));
    expect(env.blockPosts[0].text).toContain("ACME-7: Check August payments — Queued · CEO");
    // The card's thread is the task's thread: a reply there is a comment,
    // an agent's comment lands there, and it is not opened twice.
    expect(await ensureTaskThread(env.deps, "t1")).toEqual({ created: false, reason: "bound" });
    const reply = await handleInboundMessage(env.deps, { type: "message", channel: "CTASKS", user: "U1", text: "use the July report", ts: "9.1", thread_ts: "card-1" });
    expect(reply.kind).toBe("commented");
    expect(env.comments[0]).toMatchObject({ issueId: "t1" });
    expect(env.wakeups).toEqual(["t1"]);
    env.issueComments.set("t1", [{ id: "c-agent", body: "On it.", authorType: "agent" }]);
    expect(await handleIssueCommentCreated(env.deps, { issueId: "t1", commentId: "c-agent" })).toEqual({ posted: true });
    expect(env.posts.at(-1)).toEqual({ channel: "CTASKS", text: "On it.", threadTs: "card-1" });
  });

  it("skips subtasks, unassigned tasks under the default scope, and everything without a channel", async () => {
    const env = makeDeps({ tasksChannelId: "CTASKS" });
    env.issuesById.set("sub", { id: "sub", identifier: "ACME-8", title: "Part", status: "todo", parentId: "t1", assigneeAgentId: "agent-ceo" });
    env.issuesById.set("free", { id: "free", identifier: "ACME-9", title: "Nobody's", status: "todo", parentId: null, assigneeAgentId: null });
    expect(await ensureTaskThread(env.deps, "sub")).toEqual({ created: false, reason: "out_of_scope" });
    expect(await ensureTaskThread(env.deps, "free")).toEqual({ created: false, reason: "out_of_scope" });
    // Assigned later: the next look opens it.
    env.issuesById.get("free")!.assigneeAgentId = "agent-ceo";
    expect(await ensureTaskThread(env.deps, "free")).toEqual({ created: true });
    // Scope "all" takes unassigned top-level tasks too, never subtasks.
    const all = makeDeps({ tasksChannelId: "CTASKS", tasksThreadScope: "all" });
    expect(wantsTaskThread(all.deps.config, { id: "x", identifier: null, title: "x", status: "todo", parentId: null, assigneeAgentId: null })).toBe(true);
    expect(wantsTaskThread(all.deps.config, { id: "x", identifier: null, title: "x", status: "todo", parentId: "p", assigneeAgentId: null })).toBe(false);
    const off = makeDeps();
    off.issuesById.set("t", { id: "t", identifier: null, title: "t", status: "todo", parentId: null, assigneeAgentId: "agent-ceo" });
    expect(await ensureTaskThread(off.deps, "t")).toEqual({ created: false, reason: "no_tasks_channel" });
    expect(env.blockPosts).toHaveLength(1);
  });

  it("edits the card in place as the task moves, and says done in the thread", async () => {
    const env = makeDeps({ tasksChannelId: "CTASKS" });
    env.issuesById.set("t1", { id: "t1", identifier: "ACME-7", title: "Check payments", status: "todo", parentId: null, assigneeAgentId: "agent-ceo" });
    await ensureTaskThread(env.deps, "t1");
    env.issuesById.get("t1")!.status = "in_progress";
    expect(await refreshTaskCard(env.deps, "t1")).toBe(true);
    expect(env.updates.at(-1)).toMatchObject({ channel: "CTASKS", ts: "card-1" });
    expect(env.updates.at(-1)!.text).toContain("Working · CEO");
    env.issuesById.get("t1")!.status = "done";
    expect(await handleIssueStatusChanged(env.deps, { issueId: "t1", status: "done", title: "Check payments" })).toBe(true);
    expect(env.updates.at(-1)!.text).toContain("Done · CEO");
    expect(env.posts.at(-1)).toEqual({ channel: "CTASKS", text: "✅ Task done: Check payments", threadTs: "card-1" });
    // A thread that began with a mention has no card to refresh.
    const mention = makeDeps();
    await handleInboundMessage(mention.deps, { type: "app_mention", channel: "C1", user: "U1", text: `<@${BOT}> fix it`, ts: "1.1" });
    expect(await refreshTaskCard(mention.deps, "issue-1")).toBe(false);
  });
});
