/**
 * Message Tracking State — user message tracking, session lifecycle metadata.
 */

export interface MessageTrackingState {
  lastUserMessageId: string;
  sentMessageAt: number;
  sessionCreatedAt: number;
  messageCount: number;
  lastKnownStatus: string;
}

export function createMessageTrackingDefaults(now: number): MessageTrackingState {
  return {
    lastUserMessageId: '',
    sentMessageAt: 0,
    sessionCreatedAt: now,
    messageCount: 0,
    lastKnownStatus: 'unknown',
  };
}