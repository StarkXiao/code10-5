/**
 * 复检分级流程集成测试（真实 HTTP + 真实 SQLite）：
 *   L1 初检通过：良好/尚可 → 收口/观察，连续计数清零；
 *   L2 加严复检：首次不合格 → 返工/退役；
 *   L3 退役评估：同一破损「连续两轮」判定不合格 → 自动升级、破损不可修、生成退役待办、通知全部家人；
 *   跨轮计数：返工会产生新的修补轮次，连续失败按破损事件聚合；
 *   观察期未满仍需 confirmEarly 二次确认。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86_400_000));

interface Ctx {
  token: string;
  wardrobeId: string;
  memberToken: string;
  memberId: string;
  dictionary: Record<string, Array<Record<string, string>>>;
}

async function setupWardrobe(): Promise<Ctx> {
  const ownerEmail = `grade-owner-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`;
  const owner = await request(app)
    .post('/api/auth/register')
    .send({ email: ownerEmail, password: 'mending123', displayName: '分级主人' })
    .expect(201);
  const token = owner.body.data.token as string;
  const wardrobeId = owner.body.data.wardrobe.id as string;
  const inviteCode = owner.body.data.wardrobe.inviteCode as string;

  // 第二个账号加入同一衣橱，充当「家人」
  const memberEmail = `grade-member-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`;
  const memberReg = await request(app)
    .post('/api/auth/register')
    .send({ email: memberEmail, password: 'mending123', displayName: '分级家人' })
    .expect(201);
  const memberToken = memberReg.body.data.token as string;
  const memberId = memberReg.body.data.user.id as string;
  await request(app)
    .post('/api/wardrobe/join')
    .set('authorization', `Bearer ${memberToken}`)
    .send({ inviteCode })
    .expect(200);

  const dictRes = await request(app)
    .get('/api/dictionary')
    .set('authorization', `Bearer ${token}`)
    .expect(200);
  return { token, wardrobeId, memberToken, memberId, dictionary: dictRes.body.data };
}

function auth(token: string, req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

async function createDamageWithRepair(
  ctx: Ctx,
  opts: { name: string; round?: number; finishedDaysAgo?: number; stitchCode?: string; executedBy?: string },
): Promise<{ garmentId: string; damageId: string; repairId: string }> {
  const garment = (
    await auth(ctx.token, request(app).post('/api/garments')).send({
      name: opts.name,
      category: 'sweater',
      materialPrimary: 'wool',
      knitOrWoven: 'knit',
      seasonTags: ['winter'],
    })
  ).body.data.garment;

  const damage = (
    await auth(ctx.token, request(app).post('/api/damage-events')).send({
      garmentId: garment.id,
      damageTypeId: ctx.dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
      severity: 'moderate',
      detectedAt: daysAgo(40),
      annotationIds: [],
      locationUnknown: true,
      locationNote: '分级流程用例',
    })
  ).body.data.damage;

  const repair = (
    await auth(ctx.token, request(app).post('/api/repairs')).send({
      damageEventId: damage.id,
      executedBy: opts.executedBy ?? 'self',
      stitchId: ctx.dictionary.stitches.find((s) => s.code === (opts.stitchCode ?? 'darning_hand'))!.id,
      startedAt: daysAgo((opts.finishedDaysAgo ?? 20) + 2),
      finishedAt: daysAgo(opts.finishedDaysAgo ?? 20),
    })
  ).body.data.repair;

  await auth(ctx.token, request(app).put(`/api/repairs/${repair.id}/change`)).send({
    visibility: 'slight',
    colorMatch: 'close',
    stiffness: 'same',
    drapeChange: 'none',
    mobilityLimited: false,
    visibleFromOutside: false,
  });

  return { garmentId: garment.id, damageId: damage.id, repairId: repair.id };
}

let ctx: Ctx;

beforeAll(async () => {
  ctx = await setupWardrobe();
});

describe('复检分级 · L1/L2 与观察期二次确认', () => {
  it('L1：良好闭环，分级为 L1，连续计数为 0', async () => {
    const { damageId, repairId } = await createDamageWithRepair(ctx, { name: 'L1 衣物' });
    const response = await auth(ctx.token, request(app).post(`/api/repairs/${repairId}/review`))
      .send({ reviewedAt: daysAgo(3), verdict: 'good', nextAction: 'close' })
      .expect(201);
    expect(response.body.data.grade).toBe('L1');
    expect(response.body.data.autoEscalated).toBe(false);
    expect(response.body.data.consecutiveFailures).toBe(0);
    expect(response.body.data.repairStatus).toBe('passed');
    expect(response.body.data.damageStatus).toBe('resolved');

    const stored = await prisma.reviewResult.findFirstOrThrow({ where: { repairId } });
    expect(stored.grade).toBe('L1');
    const damage = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damageId } });
    expect(damage.consecutiveFailures).toBe(0);
    expect(damage.escalatedAt).toBeNull();
  });

  it('不合格只能选返工或退役；选继续观察也被拒绝（L2 必须给出整改动作）', async () => {
    const { repairId } = await createDamageWithRepair(ctx, { name: 'L2 校验衣物' });
    const monitor = await auth(ctx.token, request(app).post(`/api/repairs/${repairId}/review`))
      .send({ reviewedAt: daysAgo(3), verdict: 'failed', nextAction: 'monitor' })
      .expect(422);
    expect(monitor.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('L2：首次不合格 + 返工，生成高优返工待办，连续计数为 1 且未升级', async () => {
    const { damageId, repairId } = await createDamageWithRepair(ctx, { name: 'L2 衣物' });
    const response = await auth(ctx.token, request(app).post(`/api/repairs/${repairId}/review`))
      .send({
        reviewedAt: daysAgo(3),
        verdict: 'failed',
        verdictNote: '边缘又开了',
        nextAction: 'rework',
      })
      .expect(201);
    expect(response.body.data.grade).toBe('L2');
    expect(response.body.data.autoEscalated).toBe(false);
    expect(response.body.data.consecutiveFailures).toBe(1);
    expect(response.body.data.familyNotified).toBe(0);
    expect(response.body.data.reminderCreated.kind).toBe('rework');

    const damage = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damageId } });
    expect(damage.consecutiveFailures).toBe(1);
    expect(damage.status).toBe('pending');
    expect(damage.escalatedAt).toBeNull();
  });
});

describe('复检分级 · L3 自动升级与家人通知', () => {
  it('跨修补轮次连续两轮不合格 → L3：破损不可修 + 退役待办 + 所有者之外的家人收到通知', async () => {
    const { garmentId, damageId: damageEventId, repairId: firstRepairId } = await createDamageWithRepair(ctx, {
      name: 'L3 升级衣物',
      finishedDaysAgo: 30,
    });

    // 第一轮：L2 返工（30 天前完成、14 天观察期，12 天前复检已过观察期）
    const firstRaw = await auth(ctx.token, request(app).post(`/api/repairs/${firstRepairId}/review`))
      .send({ reviewedAt: daysAgo(12), verdict: 'failed', nextAction: 'rework' });
    expect(firstRaw.status, JSON.stringify(firstRaw.body)).toBe(201);
    const first = firstRaw;
    expect(first.body.data.grade).toBe('L2');

    // 登记第二轮修补（送修，7 天观察期，9 天前完成 → 2 天前到期）
    const secondRepairId = (
      await auth(ctx.token, request(app).post('/api/repairs')).send({
        damageEventId,
        executedBy: 'shop',
        stitchId: ctx.dictionary.stitches.find((s) => s.code === 'patch_applique')!.id,
        startedAt: daysAgo(10),
        finishedAt: daysAgo(9),
      })
    ).body.data.repair.id;
    await auth(ctx.token, request(app).put(`/api/repairs/${secondRepairId}/change`)).send({
      visibility: 'noticeable',
      colorMatch: 'close',
      stiffness: 'stiffer',
      drapeChange: 'slight',
      mobilityLimited: false,
      visibleFromOutside: true,
    });

    // 观察期未满：用观察期内的日期先被拦（二次确认机制在分级流程里保留）
    const early = await auth(ctx.token, request(app).post(`/api/repairs/${secondRepairId}/review`))
      .send({ reviewedAt: daysAgo(8), verdict: 'failed', nextAction: 'rework' })
      .expect(409);
    expect(early.body.error.code).toBe('OBSERVATION_NOT_FINISHED');

    // 即使提交的是 rework，连续第二轮 failed 也强制升级 L3
    const response = await auth(ctx.token, request(app).post(`/api/repairs/${secondRepairId}/review`))
      .send({
        reviewedAt: iso(today),
        verdict: 'failed',
        nextAction: 'rework',
        confirmEarly: true,
      })
      .expect(201);

    expect(response.body.data.grade).toBe('L3');
    expect(response.body.data.autoEscalated).toBe(true);
    expect(response.body.data.effectiveAction).toBe('retire');
    // 用户提交的动作保留在 nextAction 字段，便于留档
    expect(response.body.data.nextAction).toBe('rework');
    expect(response.body.data.consecutiveFailures).toBe(2);
    expect(response.body.data.damageStatus).toBe('unrepairable');
    expect(response.body.data.reminderCreated.kind).toBe('retire');
    // 衣橱有所有者 + 1 位成员；操作者是所有者本人，故家人通知数为 1
    expect(response.body.data.familyNotified).toBe(1);

    // 破损事件落库：不可修、计数 2、升级时间已写
    const damage = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damageEventId } });
    expect(damage.status).toBe('unrepairable');
    expect(damage.consecutiveFailures).toBe(2);
    expect(damage.escalatedAt).toBeTruthy();

    // 第二条复检留档：grade=L3、autoEscalated=true、实际动作 retire
    const secondReview = await prisma.reviewResult.findFirstOrThrow({ where: { repairId: secondRepairId } });
    expect(secondReview.grade).toBe('L3');
    expect(secondReview.autoEscalated).toBe(true);
    expect(secondReview.nextAction).toBe('retire');

    // 家人（衣橱成员）收到独立的高优通知
    const familyReminder = await prisma.reminder.findFirst({
      where: {
        wardrobeId: ctx.wardrobeId,
        userId: ctx.memberId,
        occurrenceKey: `family-escalation:${damageEventId}:${ctx.memberId}`,
      },
    });
    expect(familyReminder).toBeTruthy();
    expect(familyReminder!.priority).toBe('high');
    expect(familyReminder!.status).toBe('notified');
    expect(familyReminder!.title).toContain('退役');

    // 衣物页仍可打开；已生成退役评估待办（所有者一条）
    const reminders = await auth(ctx.token, request(app).get('/api/reminders?scope=all&limit=50')).expect(200);
    const retireTodos = reminders.body.data.items.filter(
      (r: { occurrenceKey: string }) => r.occurrenceKey === `retire:${garmentId}:${damageEventId}`,
    );
    expect(retireTodos).toHaveLength(1);

    // L3 之后破损已终结：不能再登记修补
    const blocked = await auth(ctx.token, request(app).post('/api/repairs'))
      .send({
        damageEventId,
        executedBy: 'self',
        stitchId: ctx.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
        startedAt: daysAgo(1),
        finishedAt: iso(today),
      })
      .expect(409);
    expect(blocked.body.error.code).toBe('DAMAGE_ALREADY_RESOLVED');
  });

  it('连续计数在中间出现通过结论后清零：失败 → 通过 → 失败 只算 L2，不升级', async () => {
    const { damageId: damageEventId, repairId: firstRepairId } = await createDamageWithRepair(ctx, {
      name: '计数清零衣物',
      finishedDaysAgo: 40,
    });

    // 第 1 轮：失败 L2（40 天前完成、14 天观察期，22 天前复检）
    const firstFailRaw = await auth(ctx.token, request(app).post(`/api/repairs/${firstRepairId}/review`))
      .send({ reviewedAt: daysAgo(22), verdict: 'failed', nextAction: 'rework' });
    expect(firstFailRaw.status, JSON.stringify(firstFailRaw.body)).toBe(201);

    // 第 2 轮：尚可但继续观察（fair + monitor）→ 计数清零
    const secondRepairId = (
      await auth(ctx.token, request(app).post('/api/repairs')).send({
        damageEventId,
        executedBy: 'self',
        stitchId: ctx.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
        startedAt: daysAgo(21),
        finishedAt: daysAgo(20),
        observationDays: 14,
      })
    ).body.data.repair.id;
    await auth(ctx.token, request(app).put(`/api/repairs/${secondRepairId}/change`)).send({
      visibility: 'slight',
      colorMatch: 'close',
      stiffness: 'same',
      drapeChange: 'none',
      mobilityLimited: false,
      visibleFromOutside: false,
    });
    const fair = await auth(ctx.token, request(app).post(`/api/repairs/${secondRepairId}/review`))
      .send({ reviewedAt: iso(today), verdict: 'fair', nextAction: 'monitor', confirmEarly: true })
      .expect(201);
    expect(fair.body.data.grade).toBe('L1');
    expect(fair.body.data.consecutiveFailures).toBe(0);

    // 第 3 轮：再失败 —— 应为 L2 而非 L3（计数已被中间的通过清零）
    const thirdRepairId = (
      await auth(ctx.token, request(app).post('/api/repairs')).send({
        damageEventId,
        executedBy: 'self',
        stitchId: ctx.dictionary.stitches.find((s) => s.code === 'overcast')!.id,
        startedAt: daysAgo(10),
        finishedAt: daysAgo(9),
        observationDays: 7,
      })
    ).body.data.repair.id;
    await auth(ctx.token, request(app).put(`/api/repairs/${thirdRepairId}/change`)).send({
      visibility: 'noticeable',
      colorMatch: 'close',
      stiffness: 'same',
      drapeChange: 'none',
      mobilityLimited: false,
      visibleFromOutside: false,
    });
    const secondFail = await auth(ctx.token, request(app).post(`/api/repairs/${thirdRepairId}/review`))
      .send({ reviewedAt: iso(today), verdict: 'failed', nextAction: 'rework', confirmEarly: true })
      .expect(201);
    expect(secondFail.body.data.grade).toBe('L2');
    expect(secondFail.body.data.autoEscalated).toBe(false);
    expect(secondFail.body.data.consecutiveFailures).toBe(1);

    const damage = await prisma.damageEvent.findUniqueOrThrow({ where: { id: damageEventId } });
    expect(damage.status).not.toBe('unrepairable');
    expect(damage.escalatedAt).toBeNull();
  });
});
