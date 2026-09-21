/**
 * 全局枚举与中文标签。
 * 说明：SQLite 下 Prisma 不支持 enum，因此数据库里存字符串，
 * 取值集合的唯一真相是本文件，写入前一律用 Zod（schemas.ts）校验。
 */

function labelMap<T extends readonly string[]>(keys: T, labels: Record<T[number], string>) {
  return labels as Record<T[number], string>;
}

export const GARMENT_STATUSES = ['active', 'needs_repair', 'in_repair', 'observing', 'retired'] as const;
export type GarmentStatus = (typeof GARMENT_STATUSES)[number];
export const GARMENT_STATUS_LABEL = labelMap(GARMENT_STATUSES, {
  active: '在用',
  needs_repair: '待修',
  in_repair: '修补中',
  observing: '观察期',
  retired: '已退役',
});

export const GARMENT_CATEGORIES = [
  'coat', 'jacket', 'sweater', 'shirt', 'tshirt', 'pants', 'jeans',
  'skirt', 'dress', 'underwear', 'socks', 'shoes', 'bag', 'other',
] as const;
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];
export const GARMENT_CATEGORY_LABEL = labelMap(GARMENT_CATEGORIES, {
  coat: '大衣', jacket: '外套', sweater: '毛衣/针织', shirt: '衬衫', tshirt: 'T恤',
  pants: '长裤', jeans: '牛仔裤', skirt: '裙子', dress: '连衣裙', underwear: '内衣',
  socks: '袜子', shoes: '鞋', bag: '包', other: '其他',
});

export const MATERIAL_PRIMARIES = [
  'cotton', 'wool', 'cashmere', 'linen', 'silk',
  'polyester', 'nylon', 'denim', 'leather', 'blend', 'other',
] as const;
export type MaterialPrimary = (typeof MATERIAL_PRIMARIES)[number];
export const MATERIAL_PRIMARY_LABEL = labelMap(MATERIAL_PRIMARIES, {
  cotton: '棉', wool: '羊毛', cashmere: '羊绒', linen: '亚麻', silk: '真丝',
  polyester: '涤纶', nylon: '锦纶', denim: '牛仔', leather: '皮革', blend: '混纺', other: '其他',
});

export const KNIT_OR_WOVEN = ['knit', 'woven', 'leather'] as const;
export type KnitOrWoven = (typeof KNIT_OR_WOVEN)[number];
export const KNIT_OR_WOVEN_LABEL = labelMap(KNIT_OR_WOVEN, {
  knit: '针织', woven: '梭织', leather: '皮革',
});

export const SEASONS = ['spring', 'summer', 'autumn', 'winter', 'all'] as const;
export type Season = (typeof SEASONS)[number];
export const SEASON_LABEL = labelMap(SEASONS, {
  spring: '春', summer: '夏', autumn: '秋', winter: '冬', all: '四季',
});

export const WEAR_FREQUENCY_BANDS = ['high', 'medium', 'low', 'occasional'] as const;
export type WearFrequencyBand = (typeof WEAR_FREQUENCY_BANDS)[number];
export const WEAR_FREQUENCY_BAND_LABEL = labelMap(WEAR_FREQUENCY_BANDS, {
  high: '高频（≥8 次/月）',
  medium: '中频（3–7 次/月）',
  low: '低频（1–2 次/月）',
  occasional: '偶发（<1 次/月）',
});

export const WEAR_SESSIONS = ['full_day', 'half_day', 'brief', 'unknown'] as const;
export type WearSession = (typeof WEAR_SESSIONS)[number];
export const WEAR_SESSION_LABEL = labelMap(WEAR_SESSIONS, {
  full_day: '全天', half_day: '半天', brief: '短时', unknown: '不确定',
});
/** 加权穿着次数权重，见项目文档 13.1 */
export const WEAR_SESSION_WEIGHT: Record<WearSession, number> = {
  full_day: 1.0,
  half_day: 0.6,
  brief: 0.3,
  unknown: 0.7,
};

export const WEAR_INTENSITIES = ['light', 'normal', 'heavy'] as const;
export type WearIntensity = (typeof WEAR_INTENSITIES)[number];
export const WEAR_INTENSITY_LABEL = labelMap(WEAR_INTENSITIES, {
  light: '轻', normal: '一般', heavy: '高强度',
});

export const DAMAGE_TYPES = [
  'hole', 'seam_open', 'thinning', 'tear', 'zipper', 'button', 'stain', 'shrink_deform', 'pilling',
] as const;
export type DamageTypeCode = (typeof DAMAGE_TYPES)[number];
export const DAMAGE_TYPE_LABEL = labelMap(DAMAGE_TYPES, {
  hole: '破洞', seam_open: '开线', thinning: '磨薄', tear: '撕裂', zipper: '拉链损坏',
  button: '纽扣脱落', stain: '染色', shrink_deform: '缩水变形', pilling: '起球',
});

export const SEVERITIES = ['minor', 'moderate', 'severe'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_LABEL = labelMap(SEVERITIES, {
  minor: '轻微', moderate: '中等', severe: '严重',
});

export const DAMAGE_STATUSES = [
  'pending', 'scheduled', 'in_repair', 'repaired', 'observing', 'resolved', 'unrepairable', 'cancelled',
] as const;
export type DamageStatus = (typeof DAMAGE_STATUSES)[number];
export const DAMAGE_STATUS_LABEL = labelMap(DAMAGE_STATUSES, {
  pending: '待修', scheduled: '已排期', in_repair: '修补中', repaired: '已修补',
  observing: '观察期', resolved: '复检通过', unrepairable: '不可修', cancelled: '已取消',
});
/** 终结态：进入后不可再登记修补 */
export const DAMAGE_TERMINAL_STATUSES: DamageStatus[] = ['resolved', 'unrepairable', 'cancelled'];

export const DETECTED_SOURCES = ['self', 'family', 'professional', 'routine_check'] as const;
export type DetectedSource = (typeof DETECTED_SOURCES)[number];
export const DETECTED_SOURCE_LABEL = labelMap(DETECTED_SOURCES, {
  self: '自己发现', family: '家人发现', professional: '师傅发现', routine_check: '例行检查发现',
});

export const CAUSE_GUESSES = ['friction', 'stretch', 'age', 'accidental', 'quality', 'unknown'] as const;
export type CauseGuess = (typeof CAUSE_GUESSES)[number];
export const CAUSE_GUESS_LABEL = labelMap(CAUSE_GUESSES, {
  friction: '摩擦', stretch: '牵扯受力', age: '老化', accidental: '意外',
  quality: '面料/做工问题', unknown: '不清楚',
});

export const STITCH_CODES = [
  'invisible_stitch', 'backstitch', 'running_stitch', 'overcast', 'darning_hand',
  'darning_machine', 'patch_applique', 'fusible', 'serging', 'part_replacement',
] as const;
export type StitchCode = (typeof STITCH_CODES)[number];
export const STITCH_LABEL = labelMap(STITCH_CODES, {
  invisible_stitch: '藏针缝', backstitch: '回针缝', running_stitch: '平针缝', overcast: '锁边缝',
  darning_hand: '织补（手工）', darning_machine: '织补（机器）', patch_applique: '贴布补丁',
  fusible: '熨烫贴合补', serging: '机器锁边', part_replacement: '换件替换',
});

export const EXECUTED_BY = ['self', 'family', 'tailor', 'shop'] as const;
export type ExecutedBy = (typeof EXECUTED_BY)[number];
export const EXECUTED_BY_LABEL = labelMap(EXECUTED_BY, {
  self: '自己补', family: '家人补', tailor: '师傅补', shop: '送店修补',
});

export const RESULT_RATINGS = ['satisfied', 'acceptable', 'unsatisfied'] as const;
export type ResultRating = (typeof RESULT_RATINGS)[number];
export const RESULT_RATING_LABEL = labelMap(RESULT_RATINGS, {
  satisfied: '满意', acceptable: '能接受', unsatisfied: '不满意',
});

export const REPAIR_STATUSES = ['draft', 'done', 'observing', 'passed', 'failed', 'superseded'] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];
export const REPAIR_STATUS_LABEL = labelMap(REPAIR_STATUSES, {
  draft: '草稿', done: '已修补', observing: '观察期', passed: '复检通过',
  failed: '复检不合格', superseded: '已被返工替代',
});

export const VERDICTS = ['good', 'fair', 'failed'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABEL = labelMap(VERDICTS, {
  good: '良好', fair: '尚可', failed: '不合格',
});

/**
 * 复检分级（项目文档 6.1 的「分级流程」）：
 *   A 级 良好 → 收口；B 级 尚可 → 收口或继续观察；
 *   C 级 不合格 → 首轮返工，连续两轮不合格时强制升级退役评估。
 */
export const REVIEW_GRADES = ['A', 'B', 'C'] as const;
export type ReviewGrade = (typeof REVIEW_GRADES)[number];
export const VERDICT_GRADE: Record<Verdict, ReviewGrade> = {
  good: 'A',
  fair: 'B',
  failed: 'C',
};
export const REVIEW_GRADE_LABEL = labelMap(REVIEW_GRADES, {
  A: 'A 级 · 良好',
  B: 'B 级 · 尚可',
  C: 'C 级 · 不合格',
});

/** 连续两轮复检不合格时，系统把处置自动升级为退役评估 */
export const CONSECUTIVE_FAILED_LIMIT = 2;

export const NEXT_ACTIONS = ['close', 'monitor', 'rework', 'retire'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];
export const NEXT_ACTION_LABEL = labelMap(NEXT_ACTIONS, {
  close: '闭环结束', monitor: '继续观察', rework: '返工重修', retire: '评估退役',
});

/**
 * 每个分级允许选择的下一步（分级流程的动作矩阵）。
 * C 级单独选 rework 时：若上一轮也不合格，服务端会忽略 rework、强制走 retire。
 */
export const ALLOWED_NEXT_ACTIONS: Record<Verdict, readonly NextAction[]> = {
  good: ['close'],
  fair: ['close', 'monitor'],
  failed: ['rework', 'retire'],
};

export const VISIBILITIES = ['invisible', 'slight', 'noticeable', 'obvious'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABEL = labelMap(VISIBILITIES, {
  invisible: '完全看不出', slight: '仔细看能看出', noticeable: '较明显', obvious: '很明显',
});

export const COLOR_MATCHES = ['perfect', 'close', 'mismatch'] as const;
export type ColorMatch = (typeof COLOR_MATCHES)[number];
export const COLOR_MATCH_LABEL = labelMap(COLOR_MATCHES, {
  perfect: '几乎一致', close: '接近', mismatch: '明显色差',
});

export const STIFFNESS = ['softer', 'same', 'stiffer'] as const;
export type Stiffness = (typeof STIFFNESS)[number];
export const STIFFNESS_LABEL = labelMap(STIFFNESS, {
  softer: '更软', same: '没变化', stiffer: '更硬/更板',
});

export const DRAPE_CHANGES = ['none', 'slight', 'obvious'] as const;
export type DrapeChange = (typeof DRAPE_CHANGES)[number];
export const DRAPE_CHANGE_LABEL = labelMap(DRAPE_CHANGES, {
  none: '无变化', slight: '略有变化', obvious: '明显变化',
});

export const PHOTO_VIEWS = [
  'front', 'back', 'left', 'right', 'top', 'bottom', 'detail', 'care_label', 'tag', 'before', 'after',
] as const;
export type PhotoView = (typeof PHOTO_VIEWS)[number];
export const PHOTO_VIEW_LABEL = labelMap(PHOTO_VIEWS, {
  front: '正面', back: '背面', left: '左侧', right: '右侧', top: '上部', bottom: '下部',
  detail: '局部特写', care_label: '洗标', tag: '吊牌', before: '修补前', after: '修补后',
});

export const ANNOTATION_KINDS = ['point', 'rect', 'polyline'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];
export const ANNOTATION_STATUSES = ['draft', 'linked'] as const;
export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number];

export const FABRIC_KINDS = [
  'original_scrap', 'donor_garment', 'purchased_patch', 'fusible_patch', 'thread_only', 'shop_supplied', 'other',
] as const;
export type FabricKind = (typeof FABRIC_KINDS)[number];
export const FABRIC_KIND_LABEL = labelMap(FABRIC_KINDS, {
  original_scrap: '原衣余料', donor_garment: '同款旧衣拆解', purchased_patch: '市售补丁布',
  fusible_patch: '无痕贴', thread_only: '只用线', shop_supplied: '师傅自带', other: '其他',
});

export const INVENTORY_UNITS = ['cm2', 'cm', 'piece'] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];
export const INVENTORY_UNIT_LABEL = labelMap(INVENTORY_UNITS, {
  cm2: '平方厘米', cm: '厘米', piece: '片',
});

export const INVENTORY_DIRECTIONS = ['consume', 'restock', 'adjust'] as const;
export type InventoryDirection = (typeof INVENTORY_DIRECTIONS)[number];

export const DISPOSITIONS = ['rag', 'donate', 'recycle', 'discard', 'upcycle'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const DISPOSITION_LABEL = labelMap(DISPOSITIONS, {
  rag: '剪成抹布', donate: '捐赠', recycle: '回收', discard: '丢弃', upcycle: '改制成其他用品',
});

export const REMINDER_TRIGGER_KINDS = [
  'repair_followup', 'observation_due', 'wear_threshold', 'wash_cycle',
  'season_switch', 'inventory_low', 'lifecycle_review', 'custom',
] as const;
export type ReminderTriggerKind = (typeof REMINDER_TRIGGER_KINDS)[number];
export const REMINDER_TRIGGER_KIND_LABEL = labelMap(REMINDER_TRIGGER_KINDS, {
  repair_followup: '修补后复检', observation_due: '观察期到期', wear_threshold: '高频穿着加检',
  wash_cycle: '洗护周期', season_switch: '换季检查', inventory_low: '耗材低库存',
  lifecycle_review: '服役评估', custom: '自定义',
});

export const REMINDER_STATUSES = ['pending', 'notified', 'done', 'snoozed', 'dismissed', 'expired'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export const REMINDER_STATUS_LABEL = labelMap(REMINDER_STATUSES, {
  pending: '待处理', notified: '已通知', done: '已完成', snoozed: '已顺延',
  dismissed: '已忽略', expired: '已失效',
});
export const REMINDER_TERMINAL_STATUSES: ReminderStatus[] = ['done', 'dismissed', 'expired'];

export const REMINDER_SUBJECT_TYPES = ['garment', 'damage_event', 'repair', 'fabric_inventory', 'wardrobe'] as const;
export type ReminderSubjectType = (typeof REMINDER_SUBJECT_TYPES)[number];

export const REMINDER_ACTION_KINDS = [
  'open_garment', 'open_review_form', 'open_repair_rework', 'open_inventory', 'open_report',
] as const;
export type ReminderActionKind = (typeof REMINDER_ACTION_KINDS)[number];
export const REMINDER_ACTION_KIND_LABEL = labelMap(REMINDER_ACTION_KINDS, {
  open_garment: '打开衣物档案',
  open_review_form: '填写复检',
  open_repair_rework: '安排返工',
  open_inventory: '查看布料库存',
  open_report: '查看评估报告',
});

export const DISMISS_REASONS = ['duplicate', 'not_applicable', 'handled_elsewhere', 'other'] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
export const DISMISS_REASON_LABEL = labelMap(DISMISS_REASONS, {
  duplicate: '重复提醒', not_applicable: '不适用', handled_elsewhere: '已自行处理', other: '其他',
});

export const REMINDER_CHANNELS = ['inapp', 'inapp_email', 'inapp_webhook'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export const SHARE_SCOPES = ['garment', 'wardrobe'] as const;
export type ShareScope = (typeof SHARE_SCOPES)[number];

export const ACTIVITY_ACTIONS = ['create', 'update', 'delete', 'status_change', 'export'] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const PART_CATEGORY_HINTS = ['garment', 'lower', 'accessory'] as const;
