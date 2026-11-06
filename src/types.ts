export type ConversationKind = 'im' | 'mpim' | 'channel';

export interface SlackMessage {
  ts: string;
  user?: string;
  botId?: string;
  subtype?: string;
  text: string;
  threadTs?: string;
}

export interface Watch {
  /** 'w' + 6 lowercase base36 chars, unique across sessions. */
  id: string;
  sessionKey: string;
  channel: string;
  /** Null until resolved on the first poll. */
  questionTs: string | null;
  /** tool_input.thread_ts ?? questionTs. */
  threadTs: string | null;
  createdAt: number;
  /** Resolved on the first poll. */
  kind: ConversationKind | null;
  /** Only messages with ts > lastSeenTs are new. */
  lastSeenTs: string;
  /** Burst being coalesced. */
  pending: SlackMessage[];
  lastPendingAt: number | null;
  nextPollAt: number;
  /** The fallback search for the question ts has been tried (it runs once). */
  questionLookupDone?: boolean;
}

export type CloseReason = 'done' | 'cancelled';
