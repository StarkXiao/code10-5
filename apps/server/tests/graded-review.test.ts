/**
 * 分级复检流程集成测试（真实 HTTP + 真实 SQLite）：
 *   1. 动作矩阵：A 级只能闭环、B 级只能闭环/观察、C 级只能返工/退役；
 *   2. 观察期未满二次确认（confirmEarly）后会落 earlyConfirmed；
 *   3. 连续两轮 C 级 → 自动升级退役评估，且通知衣橱里的家人（各一条待办）；
 *   4. 中间夹一轮 A 级后，连续计数清零，不会误升级。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
const today = iso(new Date());

interface Account {
  token: string;
  wardrobeId: string;
  userId: string;
  auth: (req: request.Test) => request.Test;
  dictionary: Record<string, Array<Record<string, string>>>;
}

async function register(label: string): Promise<Account> {
  const slug = label.replace(/[^a-zA-Z0-9]/gu, '') || 'user';
  const registered = await request(app)
    .post('/api/auth/register')
    .send({
      email: `${slug}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`,
      password: 'mending123',
      displayName: label,
    })
    .expect(201);
  const token = registered.body.data.token as string;
  const dictionary = (
    await request(app).get('/api/dictionary').set('authorization', `Bearer ${token}`).expect(200)
  ).body.data;
  return {
    token,
    wardrobeId: registered.body.data.wardrobe.id,
    userId: registered.body.data.user.id,
    auth: (req) => req.set('authorization', `Bearer ${token}`),
    dictionary,
  };
}

let owner: Account;

beforeAll(async () => {
  owner = await register('分级复检主人');
});

/** 建一件衣服 + 一个位置不明的破损，返回 garmentId / damageId */
async function createDamage(name: string): Promise<{ garmentId: string; damageId: string }> {
  const garment = (
    await owner.auth(request(app).post('/api/garments')).send({
      name,
      category: 'sweater',
      materialPrimary: 'wool',
      knitOrWoven: 'knit',
      seasonTags: ['winter'],
    })
  ).body.data.garment;
  const damage = (
    await owner.auth(request(app).post('/api/damage-events')).send({
      garmentId: garment.id,
      damageTypeId: owner.dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
      severity: 'moderate',
      detectedAt: daysAgo(60),
      annotationIds: [],
      locationUnknown: true,
      locationNote: '分级复检用例',
    })
  ).body.data.damage;
  return { garmentId: garment.id, damageId: damage.id };
}

/** 登记一轮已完成的修补：完成于 finishDaysAgo 天前，观察期固定 14 天 */
async function createRepair(damageId: string, finishDaysAgo: number, stitchCode = 'darning_hand'): Promise<string> {
  const repair = (
    await owner.auth(request(app).post('/api/repairs')).send({
      damageEventId: damageId,
      executedBy: 'self',
      stitchId: owner.dictionary.stitches.find((s) => s.code === stitchCode)!.id,
      startedAt: daysAgo(finishDaysAgo + 5),
      finishedAt: daysAgo(finishDaysAgo),
      observationDays: 14,
    })
  ).body.data.repair;
  await owner.auth(request(app).put(`/api/repairs/${repair.id}/change`)).send({
    visibility: 'slight',
    colorMatch: 'close',
    stiffness: 'same',
    drapeChange: 'none',
    mobilityLimited: false,
    visibleFromOutside: false,
  });
  await owner.auth(request(app).post(`/api/repairs/${repair.id}/start-observation`)).send({});
  return repair.id as string;
}

describe('分级复检 · 动作矩阵', () => {
  it('A 级不能选继续观察/返工，B 级不能闭环以外的 C 级动作', async () => {
    const { damageId } = await createDamage('动作矩阵衣物');
    const repairId = await createRepair(damageId, 20);

    const badA = await owner
      .auth(request(app).post(`/api/repairs/${repairId}/review`))
      .send({ reviewedAt: today, verdict: 'good', nextAction: 'rework' })
      .expect(422);
    expect(badA.body.error.code).toBe('VALIDATION_FAILED');

    const badB = await owner
      .auth(request(app).post(`/api/repairs/${repairId}/review`))
      .send({ reviewedAt: today, verdict: 'fair', nextAction: 'rework' })
      .expect(422);
    expect(badB.body.error.code).toBe('VALIDATION_FAILED');

    const okB = await owner
      .auth(request(app).post(`/api/repairs/${repairId}/review`))
      .send({ reviewedAt: today, verdict: 'fair', nextAction: 'close' })
      .expect(201);
    expect(okB.body.data.grade).toBe('B');
    expect(okB.body.data.repairStatus).toBe('passed');
  });
});

describe('分级复检 · 观察期未满二次确认', () => {
  it('首次提交 409，带 confirmEarly 后落 earlyConfirmed=true', async () => {
    const { damageId } = await createDamage('提前确认衣物');
    const repair = (
      await owner.auth(request(app).post('/api/repairs')).send({
        damageEventId: damageId,
        executedBy: 'self',
        stitchId: owner.dictionary.stitches.find((s) => s.code === 'running_stitch')!.id,
        startedAt: daysAgo(2),
        finishedAt: daysAgo(1),
        observationDays: 14,
      })
    ).body.data.repair;

    const early = await owner
      .auth(request(app).post(`/api/repairs/${repair.id}/review`))
      .send({ reviewedAt: today, verdict: 'good', nextAction: 'close' })
      .expect(409);
    expect(early.body.error.code).toBe('OBSERVATION_NOT_FINISHED');

    const confirmed = await owner
      .auth(request(app).post(`/api/repairs/${repair.id}/review`))
      .send({ reviewedAt: today, verdict: 'good', nextAction: 'close', confirmEarly: true })
      .expect(201);
    expect(confirmed.body.data.earlyConfirmed).toBe(true);
    expect(confirmed.body.data.autoEscalated).toBe(false);

    const stored = await prisma.reviewResult.findUniqueOrThrow({ where: { id: confirmed.body.data.reviewId } });
    expect(stored.earlyConfirmed).toBe(true);
    expect(stored.grade).toBe('A');
  });
});

describe('分级复检 · 连续两轮 C 级自动升级并通知家人', () => {
  it('首轮 C 级返工，二轮 C 级被强制升级退役评估', async () => {
    // 先让一个家人加入这个衣橱（通过邀请码）
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({ where: { id: owner.wardrobeId } });
    const family = await register('分级复检家人');
    await family
      .auth(request(app).post('/api/wardrobe/join'))
      .send({ inviteCode: wardrobe.inviteCode })
      .expect(200);

    const { garmentId, damageId } = await createDamage('连判不合格衣物');

    // 第一轮：40 天前完成（观察期已过），C 级 + 返工（正常）
    const firstId = await createRepair(damageId, 40, 'darning_hand');
    const first = await owner
      .auth(request(app).post(`/api/repairs/${firstId}/review`))
      .send({ reviewedAt: daysAgo(20), verdict: 'failed', verdictNote: '边缘又开了', nextAction: 'rework' })
      .expect(201);
    expect(first.body.data.autoEscalated).toBe(false);
    expect(first.body.data.repairStatus).toBe('failed');
    expect(first.body.data.damageStatus).toBe('pending');

    // 第二轮：20 天前完成，再判 C 级，即使前端仍传 rework，服务端也强制改成 retire
    const secondId = await createRepair(damageId, 20, 'patch_applique');
    const second = await owner
      .auth(request(app).post(`/api/repairs/${secondId}/review`))
      .send({ reviewedAt: today, verdict: 'failed', verdictNote: '补丁也开了', nextAction: 'rework' })
      .expect(201);
    expect(second.body.data.autoEscalated).toBe(true);
    expect(second.body.data.consecutiveFailed).toBe(2);
    expect(second.body.data.nextAction).toBe('retire');
    expect(second.body.data.repairStatus).toBe('failed');
    expect(second.body.data.damageStatus).toBe('unrepairable');

    // 操作者本人收到退役评估待办
    const damage = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damageId } });
    expect(damage.status).toBe('unrepairable');
    const actorRetire = await prisma.reminder.findFirst({
      where: {
        userId: owner.userId,
        subjectType: 'garment',
        subjectId: garmentId,
        occurrenceKey: `retire:${garmentId}:${damageId}`,
      },
    });
    expect(actorRetire).toBeTruthy();
    expect(actorRetire?.priority).toBe('high');

    // 家人各收到一条独立的升级通知待办（occurrenceKey 用 damageCode，且带家人自己的 userId）
    const damageCode = await prisma.damageEvent
      .findUniqueOrThrow({ where: { id: damageId } })
      .then((d) => d.code);
    const familyReminders = await prisma.reminder.findMany({
      where: {
        userId: family.userId,
        subjectType: 'garment',
        subjectId: garmentId,
        occurrenceKey: {
          startsWith: `retire-escalation:${garmentId}:${damageCode}:`,
        },
      },
    });
    expect(familyReminders).toHaveLength(1);
    expect(familyReminders[0].status).toBe('notified');
    expect(familyReminders[0].priority).toBe('high');
    expect(second.body.data.familyNotified.map((n: { userId: string }) => n.userId)).toContain(family.userId);

    // 复检记录上留有自动升级与连续轮次
    const stored = await prisma.reviewResult.findUniqueOrThrow({ where: { id: second.body.data.reviewId } });
    expect(stored.autoEscalated).toBe(true);
    expect(stored.consecutiveFailed).toBe(2);
    expect(stored.nextAction).toBe('retire');
  });

  it('两轮 C 级之间夹了一轮 B 级：连续计数中断，不升级', async () => {
    const { damageId } = await createDamage('计数清零衣物');

    // 第一轮 C 级返工（60 天前完成，40 天前复检）
    const firstId = await createRepair(damageId, 60, 'darning_hand');
    await owner
      .auth(request(app).post(`/api/repairs/${firstId}/review`))
      .send({ reviewedAt: daysAgo(40), verdict: 'failed', nextAction: 'rework' })
      .expect(201);

    // 第二轮 B 级继续观察（40 天前完成，20 天前复检；破损保持 observing，链条不断）
    const middleId = await createRepair(damageId, 40, 'backstitch');
    await owner
      .auth(request(app).post(`/api/repairs/${middleId}/review`))
      .send({ reviewedAt: daysAgo(20), verdict: 'fair', nextAction: 'monitor' })
      .expect(201);

    // 第三轮（20 天前完成，今天复检）再判 C 级：上一轮最终结论是 B，连续计数中断，仍走返工而非退役
    const thirdId = await createRepair(damageId, 20, 'overcast');
    const result = await owner
      .auth(request(app).post(`/api/repairs/${thirdId}/review`))
      .send({ reviewedAt: today, verdict: 'failed', nextAction: 'rework' })
      .expect(201);
    expect(result.body.data.autoEscalated).toBe(false);
    expect(result.body.data.damageStatus).toBe('pending');

    const damage = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damageId } });
    expect(damage.status).toBe('pending');
  });
});
