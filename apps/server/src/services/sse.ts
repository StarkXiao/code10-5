import type { Response } from 'express';
import { logger } from '../lib/logger.js';

export interface SseEvent {
  type:
    | 'reminder.created'
    | 'reminder.updated'
    | 'garment.status_changed'
    | 'review.escalated'
    | 'sync.required'
    | 'ping';
  payload: Record<string, unknown>;
}

const subscribers = new Map<string, Set<Response>>();

export function subscribe(userId: string, res: Response): () => void {
  let set = subscribers.get(userId);
  if (!set) {
    set = new Set();
    subscribers.set(userId, set);
  }
  set.add(res);
  logger.debug({ userId, count: set.size }, 'sse subscribed');
  return () => {
    set?.delete(res);
    if (set && set.size === 0) subscribers.delete(userId);
  };
}

export function publishToUser(userId: string, event: SseEvent): void {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;
  const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(chunk);
    } catch (error) {
      logger.warn({ err: error, userId }, 'sse write failed');
    }
  }
}

export function publishToWardrobe(userIds: string[], event: SseEvent): void {
  for (const userId of userIds) publishToUser(userId, event);
}

export function subscriberCount(): number {
  let total = 0;
  for (const set of subscribers.values()) total += set.size;
  return total;
}
