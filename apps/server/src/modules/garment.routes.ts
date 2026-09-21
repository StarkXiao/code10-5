import { Router } from 'express';
import { z } from 'zod';
import {
  DAMAGE_STATUS_LABEL,
  DAMAGE_TERMINAL_STATUSES,
  GARMENT_CATEGORIES,
  GARMENT_STATUSES,
  GARMENT_STATUS_LABEL,
  MATERIAL_PRIMARIES,
  SEASONS,
  WEAR_FREQUENCY_BANDS,
  garmentCreateSchema,
  garmentRetireSchema,
  garmentUpdateSchema,
  type DamageStatus,
  type GarmentStatus,
  type MaterialPrimary,
  type Season,
  type WearFrequencyBand,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { nextGarmentCode } from '../lib/ids.js';
import { withUniqueRetry } from '../lib/prisma-errors.js';
import { parseDateOnly } from '../lib/date.js';
import { requireAuth } from '../middleware/auth.js';
import {
  computeAllGarmentStats,
  computeHealth,
  loadDataset,
  syncGarmentStatus,
} from '../services/stats.js';
import { expireRemindersFor } from '../services/rules/engine.js';

export const garmentRouter = Router();
garmentRouter.use(requireAuth);

const listQuerySchema = z.object({
  q: z.string().optional(),
  status: z.enum(GARMENT_STATUSES).optional(),
  category: z.enum(GARMENT_CATEGORIES).optional(),
  material: z.enum(MATERIAL_PRIMARIES).optional(),
  season: z.enum(SEASONS).optional(),
  frequencyBand: z.enum(WEAR_FREQUENCY_BANDS).optional(),
  needsAttention: z.coerce.boolean().optional(),
  sort: z.enum(['recent', 'health', 'wear', 'cost', 'code']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeRetired: z.coerce.boolean().default(false),
});

garmentRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(listQuerySchema, req.query);
    const dataset = await loadDataset(req.ctx.wardrobeId, { includeRetired: query.includeRetired });
    const stats = computeAllGarmentStats(dataset);

    let garments = dataset.garments;
    if (query.q) {
      const needle = query.q.trim().toLowerCase();
      garments = garments.filter(
        (g) =>
          g.name.toLowerCase().includes(needle) ||
          g.code.toLowerCase().includes(needle) ||
          (g.brand ?? '').toLowerCase().includes(needle),
      );
    }
    if (query.status) garments = garments.filter((g) => g.status === query.status);
    if (query.category) garments = garments.filter((g) => g.category === query.category);
    if (query.material) garments = garments.filter((g) => g.materialPrimary === query.material);
    if (query.season) {
      garments = garments.filter((g) => {
        const tags = Array.isArray(g.seasonTags) ? (g.seasonTags as string[]) : [];
        return tags.includes(query.season!) || tags.includes('all');
      });
    }
    if (query.frequencyBand) {
      garments = garments.filter((g) => stats.get(g.id)?.frequencyBand === query.frequencyBand);
    }
    if (query.needsAttention) {
      garments = garments.filter((g) => ['needs_repair', 'in_repair', 'observing'].includes(g.status));
    }

    const withStats = garments.map((g) => ({ garment: g, stats: stats.get(g.id)! }));
    withStats.sort((a, b) => {
      switch (query.sort) {
        case 'health':
          return (computeHealth(a.stats).score ?? 0) - (computeHealth(b.stats).score ?? 0);
        case 'wear':
          return b.stats.wearCount - a.stats.wearCount;
        case 'cost':
          return (b.stats.costPerWear ?? -1) - (a.stats.costPerWear ?? -1);
        case 'code':
          return a.garment.code.localeCompare(b.garment.code);
        default:
          return b.garment.updatedAt.getTime() - a.garment.updatedAt.getTime();
      }
    });

    const total = withStats.length;
    const start = (query.page - 1) * query.pageSize;
    const pageItems = withStats.slice(start, start + query.pageSize);
    const photos = await prisma.garmentPhoto.findMany({
      where: { garmentId: { in: pageItems.map((i) => i.garment.id) }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, garmentId: true, view: true, thumbPath: true },
    });

    ok(
      req,
      res,
      {
        items: pageItems.map(({ garment, stats: s }) => ({
          id: garment.id,
          code: garment.code,
          name: garment.name,
          category: garment.category,
          materialPrimary: garment.materialPrimary,
          knitOrWoven: garment.knitOrWoven,
          seasonTags: garment.seasonTags,
          status: garment.status,
          statusLabel: GARMENT_STATUS_LABEL[garment.status as GarmentStatus] ?? garment.status,
          color: garment.color,
          storageLocation: garment.storageLocation,
          thumbPhotoId: photos.find((p) => p.garmentId === garment.id)?.id ?? null,
          wearCount: s.wearCount,
          perMonth: s.perMonth,
          frequencyBand: s.frequencyBand,
          repairCount: s.repairCount,
          openDamageCount: s.openDamageCount,
          costPerWear: s.costPerWear,
          serviceDays: s.serviceDays,
          healthScore: computeHealth(s).score,
          healthLevel: computeHealth(s).level,
          lastWornOn: s.lastWornOn,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
      { appliedFilters: query },
    );
  }),
);

garmentRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(garmentCreateSchema, req.body);
    // 编号是"查最大值 +1"生成的：两个标签页同时建档会撞车，
    // 这里撞车就重算一次，而不是把 500 抛给用户。
    const garment = await withUniqueRetry(async () => {
      const code = await nextGarmentCode(req.ctx.wardrobeId);
      return prisma.garment.create({
        data: {
          wardrobeId: req.ctx.wardrobeId,
          code,
          name: body.name.trim(),
          category: body.category,
          brand: body.brand ?? null,
          sizeLabel: body.sizeLabel ?? null,
          materialPrimary: body.materialPrimary,
          materialComposition: (body.materialComposition ?? undefined) as never,
          materialStretch: body.materialStretch ?? null,
          knitOrWoven: body.knitOrWoven,
          seasonTags: body.seasonTags as never,
          color: body.color ?? null,
          purchaseDate: body.purchaseDate ? parseDateOnly(body.purchaseDate) : null,
          purchasePrice: body.purchasePrice ?? null,
          careWashTemp: body.careWashTemp ?? null,
          careMachineWash: body.careMachineWash ?? null,
          careDryCleanOnly: body.careDryCleanOnly ?? null,
          careNote: body.careNote ?? null,
          storageLocation: body.storageLocation ?? null,
          firstWearDate: body.firstWearDate ? parseDateOnly(body.firstWearDate) : null,
          note: body.note ?? null,
          healthScore: 100,
          createdBy: req.ctx.userId,
        },
      });
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment',
      entityId: garment.id,
      action: 'create',
      diff: { code: garment.code, name: garment.name },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { garment });
  }),
);

garmentRouter.get(
  '/:id',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const dataset = await loadDataset(req.ctx.wardrobeId, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset).get(garment.id);
    const health = stats ? computeHealth(stats) : null;

    const [photos, damages, orphanAnnotations, careRule, material] = await Promise.all([
      prisma.garmentPhoto.findMany({
        where: { garmentId: garment.id, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: {
          annotations: {
            include: { part: true, damageEvent: { include: { damageType: true } }, repair: { include: { stitch: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      prisma.damageEvent.findMany({
        where: { garmentId: garment.id },
        orderBy: { detectedAt: 'desc' },
        include: {
          damageType: true,
          part: true,
          repairs: {
            orderBy: { round: 'asc' },
            include: {
              stitch: true,
              change: true,
              reviews: { orderBy: { reviewedAt: 'asc' } },
              materials: { include: { fabricSource: true } },
            },
          },
          original: { select: { id: true, code: true } },
          recurrences: { select: { id: true, code: true, detectedAt: true } },
        },
      }),
      prisma.photoAnnotation.count({ where: { garmentId: garment.id, status: 'draft' } }),
      prisma.careRule.findUnique({ where: { materialCode: garment.materialPrimary } }),
      prisma.material.findUnique({ where: { code: garment.materialPrimary } }),
    ]);

    const wearLogs = await prisma.wearLog.findMany({
      where: { garmentId: garment.id },
      orderBy: { wornOn: 'desc' },
      take: 60,
    });

    ok(req, res, {
      garment,
      stats,
      health,
      photos,
      damages,
      wearLogs,
      orphanAnnotationCount: orphanAnnotations,
      careRule,
      material,
      suggestedStitches: await suggestStitches(garment.knitOrWoven, garment.materialPrimary),
    });
  }),
);

garmentRouter.patch(
  '/:id',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(garmentUpdateSchema, req.body);
    const updated = await prisma.garment.update({
      where: { id: garment.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.brand !== undefined ? { brand: body.brand } : {}),
        ...(body.sizeLabel !== undefined ? { sizeLabel: body.sizeLabel } : {}),
        ...(body.materialPrimary !== undefined ? { materialPrimary: body.materialPrimary } : {}),
        ...(body.materialComposition !== undefined ? { materialComposition: body.materialComposition as never } : {}),
        ...(body.materialStretch !== undefined ? { materialStretch: body.materialStretch } : {}),
        ...(body.knitOrWoven !== undefined ? { knitOrWoven: body.knitOrWoven } : {}),
        ...(body.seasonTags !== undefined ? { seasonTags: body.seasonTags as never } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.purchaseDate !== undefined
          ? { purchaseDate: body.purchaseDate ? parseDateOnly(body.purchaseDate) : null }
          : {}),
        ...(body.purchasePrice !== undefined ? { purchasePrice: body.purchasePrice } : {}),
        ...(body.careWashTemp !== undefined ? { careWashTemp: body.careWashTemp } : {}),
        ...(body.careMachineWash !== undefined ? { careMachineWash: body.careMachineWash } : {}),
        ...(body.careDryCleanOnly !== undefined ? { careDryCleanOnly: body.careDryCleanOnly } : {}),
        ...(body.careNote !== undefined ? { careNote: body.careNote } : {}),
        ...(body.storageLocation !== undefined ? { storageLocation: body.storageLocation } : {}),
        ...(body.firstWearDate !== undefined
          ? { firstWearDate: body.firstWearDate ? parseDateOnly(body.firstWearDate) : null }
          : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment',
      entityId: garment.id,
      action: 'update',
      diff: body,
      requestId: req.ctx.requestId,
    });
    ok(req, res, { garment: updated });
  }),
);

garmentRouter.post(
  '/:id/retire',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(garmentRetireSchema, req.body);
    if (garment.status === 'retired') throw new HttpError('CONFLICT', '这件衣物已经退役了');

    const openDamages = await prisma.damageEvent.findMany({
      where: { garmentId: garment.id },
      select: { id: true, status: true },
    });
    const open = openDamages.filter((d) => !DAMAGE_TERMINAL_STATUSES.includes(d.status as DamageStatus));

    const updated = await prisma.garment.update({
      where: { id: garment.id },
      data: {
        status: 'retired',
        retiredAt: body.retiredAt ? parseDateOnly(body.retiredAt) : new Date(),
        disposition: body.disposition,
        dispositionNote: body.dispositionNote ?? null,
      },
    });
    // 退役后所有未完成待办都失效，避免留下永远处理不了的提醒
    for (const damage of open) {
      await expireRemindersFor('damage_event', damage.id, '衣物已退役，破损事件不再需要处理');
    }
    await expireRemindersFor('garment', garment.id, '衣物已退役');

    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment',
      entityId: garment.id,
      action: 'status_change',
      diff: { from: garment.status, to: 'retired', disposition: body.disposition },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { garment: updated, expiredDamageCount: open.length });
  }),
);

garmentRouter.post(
  '/:id/restore',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    if (garment.status !== 'retired') throw new HttpError('CONFLICT', '这件衣物当前不是退役状态');
    await prisma.garment.update({
      where: { id: garment.id },
      data: { status: 'active', retiredAt: null, disposition: null, dispositionNote: null },
    });
    const status = await syncGarmentStatus(garment.id);
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment',
      entityId: garment.id,
      action: 'status_change',
      diff: { from: 'retired', to: status },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { status });
  }),
);

garmentRouter.delete(
  '/:id',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    await prisma.garment.update({ where: { id: garment.id }, data: { deletedAt: new Date() } });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment',
      entityId: garment.id,
      action: 'delete',
      diff: { code: garment.code, softDelete: true },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { deleted: true, recoverable: true });
  }),
);

garmentRouter.get(
  '/:id/timeline',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const damages = await prisma.damageEvent.findMany({
      where: { garmentId: garment.id },
      include: { damageType: true, part: true },
    });
    const damageIds = damages.map((d) => d.id);

    const repairs = await prisma.repair.findMany({
      where: { damageEvent: { garmentId: garment.id } },
      include: { stitch: true, damageEvent: { select: { code: true } } },
    });
    const repairIds = repairs.map((r) => r.id);

    const [reviews, wears, reminders] = await Promise.all([
      prisma.reviewResult.findMany({
        where: { repair: { damageEvent: { garmentId: garment.id } } },
        include: { repair: { include: { stitch: true, damageEvent: { select: { code: true } } } } },
      }),
      prisma.wearLog.findMany({ where: { garmentId: garment.id }, orderBy: { wornOn: 'desc' }, take: 120 }),
      prisma.reminder.findMany({
        where: {
          OR: [
            { subjectType: 'garment', subjectId: garment.id },
            { subjectType: 'repair', subjectId: { in: repairIds } },
            { subjectType: 'damage_event', subjectId: { in: damageIds } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
    ]);

    const events = [
      ...damages.map((d) => ({
        type: 'damage' as const,
        at: d.detectedAt,
        title: `登记破损：${d.damageType.name}（${d.part?.name ?? '未标部位'}）`,
        detail: `${d.code} · ${DAMAGE_STATUS_LABEL[d.status as DamageStatus] ?? d.status}`,
        refId: d.id,
        meta: { severity: d.severity, isRecurrence: !!d.recurrenceOf },
      })),
      ...repairs.map((r) => ({
        type: 'repair' as const,
        at: r.finishedAt,
        title: `完成第 ${r.round} 轮修补：${r.stitch.name}`,
        detail: `${r.damageEvent.code} · ${r.status}`,
        refId: r.id,
        meta: { executedBy: r.executedBy, observationUntil: r.observationUntil },
      })),
      ...reviews.map((r) => ({
        type: 'review' as const,
        at: r.reviewedAt,
        title: `复检结论：${r.verdict}`,
        detail: `${r.repair.damageEvent.code} · ${r.grade} · ${r.repair.stitch.name} · ${r.daysSinceRepair} 天后`,
        refId: r.id,
        meta: {
          nextAction: r.nextAction,
          reoccurred: r.reoccurred,
          grade: r.grade,
          autoEscalated: r.autoEscalated,
        },
      })),
      ...wears.map((w) => ({
        type: 'wear' as const,
        at: w.wornOn,
        title: '穿着记录',
        detail: `${w.session} · ${w.intensity}`,
        refId: w.id,
        meta: { occasion: w.occasion },
      })),
      ...reminders.map((r) => ({
        type: 'reminder' as const,
        at: r.createdAt,
        title: `提醒：${r.title}`,
        detail: `${r.status} · 到期 ${r.dueAt.toISOString().slice(0, 10)}`,
        refId: r.id,
        meta: { actionKind: r.actionKind, status: r.status },
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    ok(req, res, { events });
  }),
);

garmentRouter.get(
  '/:id/lifetime-report',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const dataset = await loadDataset(req.ctx.wardrobeId, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset).get(garment.id);
    if (!stats) throw new HttpError('NOT_FOUND', '统计信息不可用');
    const health = computeHealth(stats);
    const damages = await prisma.damageEvent.findMany({
      where: { garmentId: garment.id },
      include: { damageType: true, part: true, repairs: { include: { stitch: true, reviews: true } } },
      orderBy: { detectedAt: 'asc' },
    });

    const totalCost = stats.purchasePrice + stats.totalRepairCost + stats.totalMaterialCost;
    ok(req, res, {
      garment: {
        id: garment.id,
        code: garment.code,
        name: garment.name,
        status: garment.status,
        materialPrimary: garment.materialPrimary,
        seasonTags: garment.seasonTags,
        retiredAt: garment.retiredAt,
        disposition: garment.disposition,
      },
      report: {
        serviceDays: stats.serviceDays,
        firstWearDate: stats.firstWearDate,
        lastWornOn: stats.lastWornOn,
        wearCount: stats.wearCount,
        weightedWearCount: stats.weightedWearCount,
        perMonth: stats.perMonth,
        frequencyBand: stats.frequencyBand,
        damageCount: stats.damageCount,
        repairCount: stats.repairCount,
        recurrenceCount: stats.recurrenceCount,
        recurrenceRate: stats.recurrenceRate,
        repurchasePrice: stats.purchasePrice,
        totalRepairCost: stats.totalRepairCost,
        totalCost: Math.round(totalCost * 100) / 100,
        costPerWear: stats.costPerWear,
        health,
        lifespan: stats.lifespanSamples.map((s) => ({
          repairId: s.repairId,
          days: s.days,
          censored: s.censored,
          wears: s.wears,
        })),
      },
      history: damages.map((d) => ({
        id: d.id,
        code: d.code,
        damageType: d.damageType.name,
        severity: d.severity,
        part: d.part?.name ?? null,
        detectedAt: d.detectedAt,
        status: d.status,
        isRecurrence: !!d.recurrenceOf,
        repairs: d.repairs.map((r) => ({
          id: r.id,
          round: r.round,
          stitch: r.stitch.name,
          finishedAt: r.finishedAt,
          status: r.status,
          verdict: r.reviews.at(-1)?.verdict ?? null,
        })),
      })),
    });
  }),
);

garmentRouter.get(
  '/:id/wear-stats',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const dataset = await loadDataset(req.ctx.wardrobeId, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset).get(garment.id);
    if (!stats) throw new HttpError('NOT_FOUND', '统计信息不可用');
    ok(req, res, {
      garmentId: garment.id,
      wearCount: stats.wearCount,
      weightCount: stats.weightedWearCount,
      wearCountLast30: stats.wearCountLast30,
      wearCountLast90: stats.wearCountLast90,
      perMonth: stats.perMonth,
      frequencyBand: stats.frequencyBand,
      seasonWearCounts: stats.seasonWearCounts,
      costPerWear: stats.costPerWear,
      wearsSinceWash: garment.wearsSinceWash,
      lastWashedOn: garment.lastWashedOn,
    });
  }),
);

garmentRouter.post(
  '/:id/washed',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(
      z.object({ washedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), note: z.string().max(200).optional() }),
      req.body ?? {},
    );
    const updated = await prisma.garment.update({
      where: { id: garment.id },
      data: {
        lastWashedOn: body.washedOn ? parseDateOnly(body.washedOn) : new Date(),
        wearsSinceWash: 0,
      },
    });
    // 清洗完成 → 关闭对应的洗护提醒（闭环）
    const open = await prisma.reminder.findMany({
      where: {
        subjectType: 'garment',
        subjectId: garment.id,
        status: { in: ['pending', 'notified'] },
        occurrenceKey: { startsWith: 'wash:' },
      },
    });
    for (const reminder of open) {
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: 'done',
          handledAt: new Date(),
          handledBy: req.ctx.userId,
          resultRef: { washedOn: (body.washedOn ?? new Date().toISOString().slice(0, 10)) as string },
        },
      });
    }
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment',
      entityId: garment.id,
      action: 'update',
      diff: { washed: true, closedReminders: open.length },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { lastWashedOn: updated.lastWashedOn, wearsSinceWash: updated.wearsSinceWash, closedReminders: open.length });
  }),
);

garmentRouter.get(
  '/:id/annotations/orphans',
  handler(async (req, res) => {
    const garment = await findGarmentOrThrow(req.params.id, req.ctx.wardrobeId);
    const annotations = await prisma.photoAnnotation.findMany({
      where: { garmentId: garment.id, status: 'draft' },
      include: { photo: { select: { id: true, view: true } }, part: true },
      orderBy: { createdAt: 'desc' },
    });
    ok(req, res, { annotations });
  }),
);

async function findGarmentOrThrow(id: string, wardrobeId: string) {
  const garment = await prisma.garment.findFirst({ where: { id, wardrobeId, deletedAt: null } });
  if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在或已删除');
  return garment;
}

async function suggestStitches(knitOrWoven: string, materialPrimary: string) {
  const stitches = await prisma.stitch.findMany();
  return stitches
    .map((stitch) => {
      const fabrics = Array.isArray(stitch.suitableFabrics) ? (stitch.suitableFabrics as string[]) : [];
      const score = fabrics.includes(knitOrWoven) ? 2 : fabrics.includes(materialPrimary) ? 1 : 0;
      return { stitch, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.stitch.typicalMinutes ?? 999) - (b.stitch.typicalMinutes ?? 999))
    .map((item) => item.stitch);
}
