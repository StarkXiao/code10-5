/**
 * 复检：整个闭环的收敛点（项目文档 6.1）。
 *
 * 分级流程：
 *   A 级 良好 → 只能闭环；
 *   B 级 尚可 → 闭环或继续观察（30 天后加检）；
 *   C 级 不合格 → 首轮返工重修；若上一轮也判定不合格（连续两轮 C 级），
 *     不再允许返工，自动升级为退役评估，并给衣橱里的家人各发一条通知。
 *
 * 观察期未满时复检属于「提前复检」：第一次请求被 OBSERVATION_NOT_FINISHED 拦下，
 * 客户端二次确认后带 confirmEarly 再提交；earlyConfirmed 会落库留痕。
 *
 * 这里同时被 /repairs/:id/review 和提醒的"一键执行"复用。
 */
import {
  CONSECUTIVE_FAILED_LIMIT,
  daysBetween,
  VERDICT_GRADE,
  type ReviewInput,
  type Verdict,
} from '@gml/shared';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { addDays } from '../lib/date.js';
import { syncGarmentStatus } from './stats.js';
import { closeRemindersFor, createReminderIfAbsent } from './rules/engine.js';
import { publishToUser } from './sse.js';

export interface FamilyNotification {
  userId: string;
  reminderId: string;
}

export interface ReviewOutcome {
  reviewId: string;
  verdict: ReviewInput['verdict'];
  grade: string;
  nextAction: ReviewInput['nextAction'];
  /** 服务端是否覆盖了用户选择（连续两轮不合格时 rework 被强制改成 retire） */
  autoEscalated: boolean;
  consecutiveFailed: number;
  earlyConfirmed: boolean;
  repairStatus: string;
  damageStatus: string;
  garmentStatus: string;
  wearCountSince: number;
  reminderCreated: { kind: string; id: string } | null;
  /** 收到退役评估通知的家人（不含操作人自己） */
  familyNotified: FamilyNotification[];
}

export async function performReview(params: {
  repairId: string;
  wardrobeId: string;
  userId: string;
  email?: string;
  requestId: string;
  input: ReviewInput;
  sourceReminderId?: string | null;
}): Promise<ReviewOutcome> {
  const repair = await prisma.repair.findFirst({
    where: { id: params.repairId, damageEvent: { garment: { wardrobeId: params.wardrobeId } } },
    include: {
      damageEvent: { include: { garment: true, part: true, damageType: true } },
      reviews: true,
      stitch: true,
    },
  });
  if (!repair) throw new HttpError('NOT_FOUND', '修补记录不存在');
  if (repair.status === 'superseded') {
    throw new HttpError('CONFLICT', '这条修补已被返工替代，请对最新的那一轮做复检');
  }

  const reviewedAt = new Date(params.input.reviewedAt);
  const daysSinceRepair = daysBetween(repair.finishedAt, reviewedAt);

  // 观察期还没到就复检：可能确实，也可能只是点错了。
  // 按文档要求给一个明确的 409，让客户端二次确认后再提交（避免把"刚补完"当成"已经验过"）。
  const early = reviewedAt.getTime() < repair.observationUntil.getTime();
  if (!params.input.confirmEarly && early) {
    throw new HttpError(
      'OBSERVATION_NOT_FINISHED',
      `这次修补的观察期到 ${repair.observationUntil.toISOString().slice(0, 10)} 才结束，现在复检属于提前复检`,
      { observationUntil: repair.observationUntil, daysUntilEnd: daysBetween(reviewedAt, repair.observationUntil) },
    );
  }

  // 分级判定：看上一轮的最后一次结论，判断这次是不是"连续 C 级"。
  // 同一轮内可以复检多次（如 B 级继续观察后再检），所以只统计每轮的最终结论。
  const priorRounds = await prisma.repair.findMany({
    where: { damageEventId: repair.damageEventId, round: { lt: repair.round }, status: { not: 'superseded' } },
    orderBy: { round: 'desc' },
    include: { reviews: { orderBy: { reviewedAt: 'desc' }, take: 1 } },
  });
  const priorVerdicts: Verdict[] = priorRounds
    .map((round) => round.reviews[0]?.verdict)
    .filter((verdict): verdict is Verdict => verdict === 'good' || verdict === 'fair' || verdict === 'failed');

  let consecutiveFailed = 0;
  for (const verdict of priorVerdicts) {
    if (verdict === 'failed') consecutiveFailed += 1;
    else break;
  }

  const grade = VERDICT_GRADE[params.input.verdict];
  let nextAction = params.input.nextAction;
  const autoEscalated =
    params.input.verdict === 'failed' && consecutiveFailed + 1 >= CONSECUTIVE_FAILED_LIMIT;
  if (autoEscalated) {
    // 连续两轮不合格：返工不再是用户能选的出口，系统强制升级为退役评估。
    nextAction = 'retire';
  }

  const wearCountSince =
    params.input.wornSince ??
    (await prisma.wearLog.count({
      where: {
        garmentId: repair.damageEvent.garmentId,
        wornOn: { gte: repair.finishedAt, lte: reviewedAt },
      },
    }));

  const review = await prisma.reviewResult.create({
    data: {
      repairId: repair.id,
      reviewedAt,
      verdict: params.input.verdict,
      grade,
      wornSince: wearCountSince,
      daysSinceRepair,
      reoccurred: params.input.reoccurred,
      verdictNote: params.input.verdictNote ?? null,
      nextAction,
      earlyConfirmed: early && params.input.confirmEarly,
      autoEscalated,
      consecutiveFailed: autoEscalated ? consecutiveFailed + 1 : 0,
      sourceReminderId: params.sourceReminderId ?? null,
      createdBy: params.userId,
    },
  });

  let repairStatus = repair.status;
  let damageStatus = repair.damageEvent.status;
  let reminderCreated: ReviewOutcome['reminderCreated'] = null;
  const reviewIndex = repair.reviews.length + 1;

  if (nextAction === 'close') {
    repairStatus = params.input.verdict === 'failed' ? 'failed' : 'passed';
    damageStatus = 'resolved';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
  } else if (nextAction === 'monitor') {
    repairStatus = 'observing';
    damageStatus = 'observing';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { status: 'observing' },
    });
    const dueAt = addDays(reviewedAt, 30);
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: params.userId,
      subjectType: 'repair',
      subjectId: repair.id,
      title: `再观察一次：${repair.damageEvent.garment.name}${repair.damageEvent.part ? ` 的 ${repair.damageEvent.part.name}` : ''}`,
      body: `上次复检结论是"尚可/还需观察"，30 天后请再看一眼修补处。`,
      reason: '你在复检时选择了「继续观察」，系统按 30 天后再检查一次来安排。',
      actionKind: 'open_review_form',
      actionPayload: { repairId: repair.id, garmentId: repair.damageEvent.garmentId },
      dueAt,
      expireAt: addDays(dueAt, 30),
      occurrenceKey: `monitor:repair:${repair.id}:${reviewIndex}`,
      notifyNow: false,
      email: params.email,
    });
    if (created.created && created.reminderId) reminderCreated = { kind: 'monitor', id: created.reminderId };
  } else if (nextAction === 'rework') {
    repairStatus = 'failed';
    damageStatus = 'pending';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { status: 'pending', resolvedAt: null },
    });
    const dueAt = new Date(reviewedAt);
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: params.userId,
      subjectType: 'damage_event',
      subjectId: repair.damageEventId,
      title: `安排返工：${repair.damageEvent.garment.name}（${repair.damageEvent.code}）`,
      body: `复检不合格（第 ${repair.round} 轮 · ${repair.stitch.name}）。建议换一种针法或加内侧加固，重新登记一条修补记录。`,
      reason: '你在复检时选择了「返工重修」，系统生成了这条返工任务。',
      actionKind: 'open_repair_rework',
      actionPayload: { damageEventId: repair.damageEventId, garmentId: repair.damageEvent.garmentId },
      dueAt,
      expireAt: addDays(dueAt, 60),
      occurrenceKey: `rework:${repair.damageEventId}:${reviewIndex}`,
      priority: 'high',
      notifyNow: true,
      email: params.email,
    });
    if (created.created && created.reminderId) reminderCreated = { kind: 'rework', id: created.reminderId };
  } else if (nextAction === 'retire') {
    repairStatus = 'failed';
    damageStatus = 'unrepairable';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { status: 'unrepairable', resolvedAt: new Date() },
    });
    const dueAt = new Date(reviewedAt);
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: params.userId,
      subjectType: 'garment',
      subjectId: repair.damageEvent.garmentId,
      title: `评估退役：${repair.damageEvent.garment.name}`,
      body: autoEscalated
        ? `第 ${repair.round - 1}、${repair.round} 轮修补连续复检不合格（${repair.damageEvent.code}），系统已自动升级为退役评估。看看健康分与每穿成本，决定是改抹布、捐赠、改制还是回收，并在档案里登记处置方式。`
        : '这件衣物判定为不易修补，看看健康分与每穿成本，决定是改抹布、捐赠、改制还是回收，然后在档案里登记处置方式。',
      reason: autoEscalated
        ? `连续 ${CONSECUTIVE_FAILED_LIMIT} 轮复检不合格，系统自动升级为退役评估。`
        : '你在复检时选择了「评估退役」。',
      actionKind: 'open_report',
      actionPayload: { garmentId: repair.damageEvent.garmentId, damageEventId: repair.damageEventId },
      dueAt,
      expireAt: addDays(dueAt, 90),
      occurrenceKey: `retire:${repair.damageEvent.garmentId}:${repair.damageEventId}`,
      priority: autoEscalated ? 'high' : 'normal',
      notifyNow: true,
      email: params.email,
    });
    if (created.created && created.reminderId) reminderCreated = { kind: 'retire', id: created.reminderId };
  }

  await prisma.repair.update({ where: { id: repair.id }, data: { status: repairStatus } });

  // 复检提交后，这条修补相关的待办全部闭环（带结果引用，不能"假完成"）
  await closeRemindersFor('repair', repair.id, { reviewId: review.id, verdict: params.input.verdict });
  if (reminderCreated) {
    await prisma.reminder.update({
      where: { id: reminderCreated.id },
      data: {
        resultRef: {
          createdFromReviewId: review.id,
          ...(autoEscalated ? { autoEscalated: true, consecutiveFailed: consecutiveFailed + 1 } : {}),
        },
      },
    });
  }

  const garmentStatus = await syncGarmentStatus(repair.damageEvent.garmentId);

  // 自动升级退役评估：通知衣橱里的家人（所有者 + 其他成员，操作者本人除外）。
  let familyNotified: FamilyNotification[] = [];
  if (autoEscalated) {
    familyNotified = await notifyFamilyOfEscalation({
      wardrobeId: params.wardrobeId,
      actorUserId: params.userId,
      garmentName: repair.damageEvent.garment.name,
      garmentId: repair.damageEvent.garmentId,
      damageCode: repair.damageEvent.code,
      rounds: [repair.round - 1, repair.round],
      reviewId: review.id,
    });
  }

  await logActivity({
    wardrobeId: params.wardrobeId,
    actorId: params.userId,
    entityType: 'review_result',
    entityId: review.id,
    action: 'create',
    diff: {
      repairId: repair.id,
      verdict: params.input.verdict,
      grade,
      nextAction,
      repairStatus,
      damageStatus,
      earlyConfirmed: early && params.input.confirmEarly,
      autoEscalated,
      consecutiveFailed: autoEscalated ? consecutiveFailed + 1 : 0,
      familyNotifiedUserIds: familyNotified.map((item) => item.userId),
    },
    requestId: params.requestId,
  });

  return {
    reviewId: review.id,
    verdict: params.input.verdict,
    grade,
    nextAction,
    autoEscalated,
    consecutiveFailed: autoEscalated ? consecutiveFailed + 1 : 0,
    earlyConfirmed: early && params.input.confirmEarly,
    repairStatus,
    damageStatus,
    garmentStatus,
    wearCountSince,
    reminderCreated,
    familyNotified,
  };
}

/**
 * 自动升级时给家人发通知：所有者与其他成员各收一条独立待办（各自有自己的完成状态）。
 * occurrenceKey 带 userId 后缀，绕开 (subjectType, subjectId, occurrenceKey) 唯一约束。
 */
async function notifyFamilyOfEscalation(params: {
  wardrobeId: string;
  actorUserId: string;
  garmentName: string;
  garmentId: string;
  damageCode: string;
  rounds: number[];
  reviewId: string;
}): Promise<FamilyNotification[]> {
  const wardrobe = await prisma.wardrobe.findUnique({
    where: { id: params.wardrobeId },
    select: { ownerId: true, members: { select: { userId: true } } },
  });
  if (!wardrobe) return [];

  const recipientIds = [...new Set([wardrobe.ownerId, ...wardrobe.members.map((m) => m.userId)])].filter(
    (userId) => userId !== params.actorUserId,
  );
  const recipients = recipientIds.length
    ? await prisma.user.findMany({
        where: { id: { in: recipientIds } },
        select: { id: true, email: true },
      })
    : [];

  const notified: FamilyNotification[] = [];
  for (const recipient of recipients) {
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: recipient.id,
      subjectType: 'garment',
      subjectId: params.garmentId,
      title: `连续两轮复检不合格，建议退役：${params.garmentName}`,
      body: `${params.garmentName}（${params.damageCode}）第 ${params.rounds.join('、')} 轮修补连续判定不合格，已自动升级为退役评估，请和家人一起确认处置方式。`,
      reason: `复检连续 ${CONSECUTIVE_FAILED_LIMIT} 轮不合格，系统自动升级并通知家人。`,
      actionKind: 'open_report',
      actionPayload: { garmentId: params.garmentId },
      dueAt: new Date(),
      expireAt: addDays(new Date(), 90),
      occurrenceKey: `retire-escalation:${params.garmentId}:${params.damageCode}:${params.reviewId}:${recipient.id}`,
      priority: 'high',
      // 配置了 SMTP 时家人也收到邮件；没有配置就静默退化为站内 + SSE
      channel: 'inapp_email',
      notifyNow: true,
      email: recipient.email ?? undefined,
    });
    if (created.reminderId) {
      notified.push({ userId: recipient.id, reminderId: created.reminderId });
      // SSE 单独再发一条带语义的事件，前端可以直接弹"已通知家人"
      publishToUser(recipient.id, {
        type: 'review.escalated',
        payload: {
          garmentId: params.garmentId,
          garmentName: params.garmentName,
          damageCode: params.damageCode,
          rounds: params.rounds,
          reminderId: created.reminderId,
        },
      });
    }
  }
  return notified;
}
