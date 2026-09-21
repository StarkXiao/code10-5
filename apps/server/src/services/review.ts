/**
 * 复检：整个闭环的收敛点（项目文档 6.1），采用分级流程。
 *
 * 分级（grade）：
 *   L1 初检通过：verdict 为 good / fair —— 闭环收口或继续观察；
 *   L2 加严复检：verdict 为 failed 且该破损事件此前没有连续不合格 —— 返工重修或评估退役；
 *   L3 退役评估：同一破损事件「连续两轮」判定 failed —— 自动升级，
 *               破损转 unrepairable、生成退役评估高优待办、通知衣橱内所有家人。
 *
 * 连续计数以 ReviewResult 历史为唯一真相，DamageEvent.consecutiveFailures 是其投影。
 * 任一非 failed 结论都会把计数清零。观察期未满时仍需 confirmEarly 二次确认。
 */
import { daysBetween, type ReviewInput, type ReviewGrade } from '@gml/shared';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { addDays } from '../lib/date.js';
import { syncGarmentStatus } from './stats.js';
import { closeRemindersFor, createReminderIfAbsent } from './rules/engine.js';
import { notifyFamilyOfEscalation } from './notify-family.js';

export interface ReviewOutcome {
  reviewId: string;
  verdict: ReviewInput['verdict'];
  nextAction: ReviewInput['nextAction'];
  /** 本次复检实际落库的动作；L3 自动升级时恒为 retire（可能与提交的 nextAction 不同） */
  effectiveAction: ReviewInput['nextAction'];
  grade: ReviewGrade;
  /** L3：由"连续两轮不合格"自动升级 */
  autoEscalated: boolean;
  /** 本次判定后该破损事件的连续不合格轮次数 */
  consecutiveFailures: number;
  familyNotified: number;
  repairStatus: string;
  damageStatus: string;
  garmentStatus: string;
  wearCountSince: number;
  reminderCreated: { kind: string; id: string } | null;
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
      reviews: { orderBy: { reviewedAt: 'asc' } },
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
  // 按文档要求给一个明确的 409，让客户端确认后再提交（避免把"刚补完"当成"已经验过"）。
  if (!params.input.confirmEarly && reviewedAt.getTime() < repair.observationUntil.getTime()) {
    throw new HttpError(
      'OBSERVATION_NOT_FINISHED',
      `这次修补的观察期到 ${repair.observationUntil.toISOString().slice(0, 10)} 才结束，现在复检属于提前复检`,
      { observationUntil: repair.observationUntil, daysUntilEnd: daysBetween(reviewedAt, repair.observationUntil) },
    );
  }

  const wearCountSince =
    params.input.wornSince ??
    (await prisma.wearLog.count({
      where: {
        garmentId: repair.damageEvent.garmentId,
        wornOn: { gte: repair.finishedAt, lte: reviewedAt },
      },
    }));

  // —— 分级判定：先数这个破损事件上「连续」的不合格轮次（历史，不含本次提交）——
  // 复检挂在修补上，而返工行会产生新的修补轮次，所以必须把该破损事件下
  // 每一轮修补的最后一条复检结论都取回来，按轮次从新到旧数连续 failed。
  const allRepairs = await prisma.repair.findMany({
    where: { damageEventId: repair.damageEventId },
    select: {
      id: true,
      round: true,
      reviews: { orderBy: { reviewedAt: 'asc' }, select: { verdict: true } },
    },
    orderBy: { round: 'desc' },
  });
  const priorFailures = countConsecutiveFailures(repair.id, allRepairs);
  const isFailed = params.input.verdict === 'failed';
  const consecutiveFailures = isFailed ? priorFailures + 1 : 0;
  // 第二轮连续不合格 → L3 自动升级，本次动作强制为退役评估
  const autoEscalated = isFailed && consecutiveFailures >= 2;
  const grade: ReviewGrade = !isFailed ? 'L1' : autoEscalated ? 'L3' : 'L2';
  const effectiveAction = (autoEscalated ? 'retire' : params.input.nextAction) as ReviewInput['nextAction'];

  const review = await prisma.reviewResult.create({
    data: {
      repairId: repair.id,
      reviewedAt,
      verdict: params.input.verdict,
      wornSince: wearCountSince,
      daysSinceRepair,
      reoccurred: params.input.reoccurred,
      verdictNote: params.input.verdictNote ?? null,
      // L3 自动升级时，留档的是实际执行的退役动作而非用户提交的动作
      nextAction: effectiveAction,
      grade,
      autoEscalated,
      sourceReminderId: params.sourceReminderId ?? null,
      createdBy: params.userId,
    },
  });

  // 投影到破损事件：连续计数 + 自动升级时间
  await prisma.damageEvent.update({
    where: { id: repair.damageEventId },
    data: {
      consecutiveFailures,
      ...(autoEscalated ? { escalatedAt: new Date() } : {}),
    },
  });

  let repairStatus = repair.status;
  let damageStatus = repair.damageEvent.status;
  let reminderCreated: ReviewOutcome['reminderCreated'] = null;
  let familyNotified = 0;
  const reviewIndex = repair.reviews.length + 1;
  const garmentName = repair.damageEvent.garment.name;
  const partName = repair.damageEvent.part ? ` 的 ${repair.damageEvent.part.name}` : '';

  if (effectiveAction === 'close') {
    repairStatus = 'passed';
    damageStatus = 'resolved';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
  } else if (effectiveAction === 'monitor') {
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
      title: `再观察一次：${garmentName}${partName}`,
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
  } else if (effectiveAction === 'rework') {
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
      title: `安排返工（L2 加严复检）：${garmentName}（${repair.damageEvent.code}）`,
      body:
        `复检不合格（第 ${repair.round} 轮 · ${repair.stitch.name}），这是第 1 次不合格（L2）。` +
        '建议换一种针法或加内侧加固，重新登记一条修补记录；若下一轮复检仍不合格，系统将自动升级为退役评估并通知家人。',
      reason: '复检分级流程：本次为 L2 加严复检，系统生成了这条返工任务。',
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
  } else if (effectiveAction === 'retire') {
    repairStatus = 'failed';
    damageStatus = 'unrepairable';
    await prisma.damageEvent.update({
      where: { id: repair.damageEventId },
      data: { status: 'unrepairable', resolvedAt: new Date() },
    });
    const dueAt = new Date(reviewedAt);
    // occurrenceKey 不带 reviewIndex：同一破损的退役评估待办只有一条，L3 与手动退役不会重复轰炸
    const created = await createReminderIfAbsent({
      wardrobeId: params.wardrobeId,
      userId: params.userId,
      subjectType: 'garment',
      subjectId: repair.damageEvent.garmentId,
      title: `评估退役：${garmentName}`,
      body: autoEscalated
        ? `同一处破损已连续两轮复检不合格（${repair.damageEvent.code}，第 ${repair.round} 轮 · ${repair.stitch.name}），系统自动升级为退役评估。已通知家人，请一起看看健康分与每穿成本，决定改抹布、捐赠、改制还是回收，并登记处置方式。`
        : '这件衣物判定为不易修补，看看健康分与每穿成本，决定是改抹布、捐赠、改制还是回收，然后在档案里登记处置方式。',
      reason: autoEscalated
        ? '复检分级流程：连续两轮判定不合格，自动升级为 L3 退役评估。'
        : '你在复检时选择了「评估退役」。',
      actionKind: 'open_report',
      actionPayload: {
        garmentId: repair.damageEvent.garmentId,
        damageEventId: repair.damageEventId,
        autoEscalated,
        fromReviewId: review.id,
      },
      dueAt,
      expireAt: addDays(dueAt, 90),
      occurrenceKey: `retire:${repair.damageEvent.garmentId}:${repair.damageEventId}`,
      priority: 'high',
      notifyNow: true,
      email: params.email,
    });
    if (created.created && created.reminderId) reminderCreated = { kind: 'retire', id: created.reminderId };

    // L3 自动升级：通知衣橱内所有家人（所有者 + 成员；操作者本人的那一条由上面的待办承载，不重复打扰）
    if (autoEscalated) {
      familyNotified = await notifyFamilyOfEscalation({
        wardrobeId: params.wardrobeId,
        skipUserId: params.userId,
        garment: { id: repair.damageEvent.garmentId, name: garmentName },
        damage: { id: repair.damageEventId, code: repair.damageEvent.code },
        repair: { round: repair.round, stitchName: repair.stitch.name },
        reviewId: review.id,
      });
    }
  }

  await prisma.repair.update({ where: { id: repair.id }, data: { status: repairStatus } });

  // 复检提交后，这条修补相关的待办全部闭环（带结果引用，不能"假完成"）
  await closeRemindersFor('repair', repair.id, {
    reviewId: review.id,
    verdict: params.input.verdict,
    grade,
    autoEscalated,
  });
  if (reminderCreated) {
    await prisma.reminder.update({
      where: { id: reminderCreated.id },
      data: { resultRef: { createdFromReviewId: review.id, grade, autoEscalated } },
    });
  }

  const garmentStatus = await syncGarmentStatus(repair.damageEvent.garmentId);

  await logActivity({
    wardrobeId: params.wardrobeId,
    actorId: params.userId,
    entityType: 'review_result',
    entityId: review.id,
    action: 'create',
    diff: {
      repairId: repair.id,
      verdict: params.input.verdict,
      nextAction: effectiveAction,
      requestedAction: params.input.nextAction,
      grade,
      autoEscalated,
      consecutiveFailures,
      repairStatus,
      damageStatus,
      familyNotified,
    },
    requestId: params.requestId,
  });

  return {
    reviewId: review.id,
    verdict: params.input.verdict,
    nextAction: params.input.nextAction,
    effectiveAction,
    grade,
    autoEscalated,
    consecutiveFailures,
    familyNotified,
    repairStatus,
    damageStatus,
    garmentStatus,
    wearCountSince,
    reminderCreated,
  };
}

/**
 * 统计该破损事件在本次复检之前「连续」的不合格轮次。
 * 入参是按 round 倒序的全部修补（含各自复检）：
 * 每一轮只取该轮最后一条复检结论；当前正在提交的这一轮跳过，
 * 从最近一轮往前数，遇到第一条非 failed 结论即中断。
 */
function countConsecutiveFailures(
  currentRepairId: string,
  repairs: Array<{ id: string; round: number; reviews: Array<{ verdict: string }> }>,
): number {
  let streak = 0;
  for (const record of repairs) {
    if (record.id === currentRepairId) continue;
    const lastVerdict = record.reviews.at(-1)?.verdict;
    if (!lastVerdict) continue; // 这一轮还没复检结论，不断链也不计数
    if (lastVerdict === 'failed') streak += 1;
    else break;
  }
  return streak;
}
