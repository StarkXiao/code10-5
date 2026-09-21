/**
 * 家人通知：复检分级流程中，同一破损连续两轮判定不合格（L3 自动升级退役评估）时，
 * 给衣橱内「所有家人」—— 所有者 + 全部成员 —— 各发一条独立的站内待办，
 * 并立即 SSE 推送；若对方/衣橱的通知渠道含邮件（配置了 SMTP），同时发邮件。
 *
 * 操作者本人不在这里重复通知：他自己的那条退役评估待办已经由 review.ts 生成。
 * 每个家人一条 reminder（userId 不同），occurrenceKey 里带 userId，天然避开幂等唯一约束。
 */
import { prisma } from '../lib/prisma.js';
import { addDays } from '../lib/date.js';
import { notify } from './notify.js';
import { logger } from '../lib/logger.js';

export interface EscalationInfo {
  wardrobeId: string;
  skipUserId: string;
  garment: { id: string; name: string };
  damage: { id: string; code: string };
  repair: { round: number; stitchName: string };
  reviewId: string;
}

export async function notifyFamilyOfEscalation(info: EscalationInfo): Promise<number> {
  const wardrobe = await prisma.wardrobe.findUnique({
    where: { id: info.wardrobeId },
    select: {
      ownerId: true,
      members: { select: { userId: true } },
    },
  });
  if (!wardrobe) return 0;

  // 所有者 + 成员去重，排除操作者本人
  const recipientIds = [...new Set([wardrobe.ownerId, ...wardrobe.members.map((m) => m.userId)])].filter(
    (userId) => userId !== info.skipUserId,
  );
  if (recipientIds.length === 0) return 0;

  const recipients = await prisma.user.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true, email: true },
  });

  const now = new Date();
  const title = `衣物可能要退役了：${info.garment.name}`;
  const body =
    `${info.damage.code} 已连续两轮复检不合格（第 ${info.repair.round} 轮 · ${info.repair.stitchName}），` +
    '系统已自动升级为退役评估。请和家人一起看看这件衣物的健康分与每穿成本，决定改抹布、捐赠、改制还是回收。';
  const reason = '复检分级流程：同一破损连续两轮判定不合格，自动升级为 L3 退役评估，需家人知晓并共同决定处置方式。';

  let notified = 0;
  for (const recipient of recipients) {
    try {
      const reminder = await prisma.reminder.create({
        data: {
          wardrobeId: info.wardrobeId,
          userId: recipient.id,
          subjectType: 'garment',
          subjectId: info.garment.id,
          title,
          body,
          reason,
          actionKind: 'open_report',
          actionPayload: {
            garmentId: info.garment.id,
            damageEventId: info.damage.id,
            autoEscalated: true,
            fromReviewId: info.reviewId,
          } as never,
          dueAt: now,
          expireAt: addDays(now, 90),
          status: 'notified',
          notifiedAt: now,
          priority: 'high',
          occurrenceKey: `family-escalation:${info.damage.id}:${recipient.id}`,
          resultRef: {
            familyNotice: true,
            autoEscalated: true,
            fromReviewId: info.reviewId,
          } as never,
        },
      });

      // 立刻推到对方面前：SSE 始终发；邮件渠道在配置 SMTP 时发（未配置静默跳过）
      await notify({
        userId: recipient.id,
        email: recipient.email,
        title,
        body,
        reason,
        reminderId: reminder.id,
        actionKind: 'open_report',
        actionPayload: {
          garmentId: info.garment.id,
          damageEventId: info.damage.id,
          autoEscalated: true,
        },
        channel: 'inapp_email',
      });
      notified += 1;
    } catch (error) {
      // 单个家人通知失败（如邮件异常）不能让复检主流程回滚：记录后继续通知其余家人
      logger.error({ err: error, userId: recipient.id, damageId: info.damage.id }, 'family escalation notify failed');
    }
  }

  return notified;
}
