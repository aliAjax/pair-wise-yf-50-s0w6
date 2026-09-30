import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";
export type OperationStatus = "待同步" | "同步中" | "已同步";
export type OperationType = "household.create" | "household.update" | "duplicate.merge" | "task.create" | "task.advance" | "conflict.resolve" | "manual.note";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
  fieldVersions: Record<string, number>;
  baseFields: Partial<Record<keyof Household, unknown>>;
  mergedFrom: string[];
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
}

export type MergeableField = "head" | "community" | "address" | "members" | "vulnerable" | "needLevel" | "needs" | "note";

export interface FieldConflict {
  id: string;
  kind: "重复合并" | "远端同步";
  operationId?: string;
  batchId?: string;
  householdId: string;
  field: MergeableField;
  localValue: string;
  remoteValue: string;
  localLabel: string;
  remoteLabel: string;
  status: "待处理" | "采用本地" | "采用远端";
}

export interface SyncOperation {
  id: string;
  seq: number;
  submitBatchId?: string;
  type: OperationType;
  entity: string;
  action: string;
  detail: string;
  time: string;
  status: OperationStatus;
  error?: string;
  householdId?: string;
  taskId?: string;
  payload?: unknown;
}

export interface SyncResult {
  ok: boolean;
  offline: boolean;
  batchId: string;
  processed: number;
  remaining: number;
  conflicts: number;
  message: string;
}

const SCALAR_FIELDS: MergeableField[] = ["head", "community", "address", "members", "needLevel", "note"];
const ARRAY_FIELDS: MergeableField[] = ["vulnerable", "needs"];
const DATA_FIELDS: MergeableField[] = [...SCALAR_FIELDS, ...ARRAY_FIELDS];
const LEGACY_KEY = "pair-wise-yf-50/assessment";
const KEY = "pair-wise-yf-50/assessment/v2";
const commonAddress = "河湾路18号2号楼2单元";

type SeedHousehold = Omit<Household, "fieldVersions" | "baseFields" | "mergedFrom"> & {
  fieldVersions?: Partial<Record<MergeableField, number>>;
  baseFields?: Partial<Record<keyof Household, unknown>>;
};

const seedHouseholds: SeedHousehold[] = [
  {
    id: "h1",
    head: "王建国",
    community: "河湾社区",
    address: "河湾路18号2单元",
    members: 4,
    vulnerable: ["老人"],
    needLevel: "紧急",
    needs: ["临时安置", "慢病用药"],
    status: "待复核",
    version: 2,
    deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(),
    note: "一层受淹，老人行动不便",
    fieldVersions: { address: 2, note: 2 },
    baseFields: { address: commonAddress, note: "一层受淹" }
  },
  {
    id: "h2",
    head: "赵敏",
    community: "新城社区",
    address: "新城三街9号",
    members: 2,
    vulnerable: [],
    needLevel: "一般",
    needs: ["饮用水"],
    status: "已分派",
    version: 1,
    deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(),
    note: "饮水库存不足"
  },
  {
    id: "h3",
    head: "王建国",
    community: "河湾社区",
    address: "河湾路18号2幢2单元",
    members: 4,
    vulnerable: ["老人"],
    needLevel: "紧急",
    needs: ["临时安置", "慢病用药"],
    status: "待评估",
    version: 2,
    deviceUpdatedAt: new Date().toISOString(),
    note: "疑似重复登记，老人行动不便",
    fieldVersions: { address: 2, note: 2 },
    baseFields: { address: commonAddress, note: "老人行动不便" }
  }
];

const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" },
  { id: "k2", householdId: "h3", title: "现场复核重复登记", assignee: "复核一组", priority: "紧急", status: "待接收", due: "2026-09-30 18:00" }
];

interface PersistedState {
  households: Household[];
  archivedHouseholds: Household[];
  aliases: Record<string, string>;
  tasks: FieldTask[];
  operations: SyncOperation[];
  conflicts: FieldConflict[];
  seenRemoteRevisions: string[];
  nextOperationSeq: number;
  lastSyncedAt: string;
}

function createId(prefix = "") {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return prefix ? `${prefix}-${uuid}` : uuid;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isEmptyFieldValue(value: unknown) {
  if (Array.isArray(value)) return value.length === 0;
  return value === undefined || value === null || String(value).trim() === "";
}

function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.join("、");
  return value === undefined || value === null ? "" : String(value);
}

function fieldVersion(household: Household, field: MergeableField) {
  return household.fieldVersions[field] ?? 1;
}

function isMergeableField(field: keyof Household | string): field is MergeableField {
  return DATA_FIELDS.includes(field as MergeableField);
}

function normalizeHousehold(input: SeedHousehold): Household {
  const seed = input as Household;
  const fieldVersions: Record<string, number> = {};
  const baseFields: Partial<Record<keyof Household, unknown>> = {};

  DATA_FIELDS.forEach((field) => {
    fieldVersions[field] = input.fieldVersions?.[field] ?? 1;
    baseFields[field] = input.baseFields?.[field] !== undefined ? clone(input.baseFields[field]) : clone(seed[field]);
  });

  return {
    ...seed,
    vulnerable: clone(seed.vulnerable),
    needs: clone(seed.needs),
    fieldVersions,
    baseFields,
    mergedFrom: clone(seed.mergedFrom ?? [])
  };
}

function loadState(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState & { queue?: PendingChange[]; nextOperationSeq?: number };
    if (parsed && Array.isArray(parsed.households) && !Array.isArray(parsed.operations)) {
      parsed.operations = (parsed.queue ?? []).map((item, index) => ({
        ...item,
        seq: index + 1,
        type: "manual.note" as OperationType,
        status: "待同步" as OperationStatus
      }));
      parsed.nextOperationSeq = parsed.operations.length + 1;
      parsed.archivedHouseholds = [];
      parsed.aliases = {};
      parsed.seenRemoteRevisions = [];
      parsed.conflicts = (parsed.conflicts ?? []).map((item) => ({
        ...item,
        kind: "远端同步" as const,
        field: isMergeableField(item.field) ? item.field : "note",
        localLabel: "本机记录",
        remoteLabel: "远端记录"
      }));
    }
    parsed.households = (parsed.households ?? []).map(normalizeHousehold);
    parsed.archivedHouseholds = (parsed.archivedHouseholds ?? []).map(normalizeHousehold);
    parsed.aliases = parsed.aliases ?? {};
    parsed.operations = parsed.operations ?? [];
    parsed.conflicts = parsed.conflicts ?? [];
    parsed.seenRemoteRevisions = parsed.seenRemoteRevisions ?? [];
    return parsed as PersistedState;
  } catch {
    return null;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useAssessmentStore = defineStore("assessment", () => {
  const stored = loadState();
  const households = ref<Household[]>(stored?.households?.length ? stored.households : seedHouseholds.map(normalizeHousehold));
  const archivedHouseholds = ref<Household[]>(stored?.archivedHouseholds ?? []);
  const aliases = ref<Record<string, string>>(stored?.aliases ?? {});
  const tasks = ref<FieldTask[]>(stored?.tasks?.length ? stored.tasks : clone(seedTasks));
  const operations = ref<SyncOperation[]>(stored?.operations ?? []);
  const conflicts = ref<FieldConflict[]>(stored?.conflicts ?? []);
  const seenRemoteRevisions = ref<string[]>(stored?.seenRemoteRevisions ?? []);
  const online = ref(true);
  const lastSyncedAt = ref(stored?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);
  let operationSeq = stored?.nextOperationSeq ?? operations.value.reduce((max, item) => Math.max(max, item.seq ?? 0), 0) + 1;
  const appliedOperationIds = new Set(operations.value.map((item) => item.id));

  const queue = computed(() => operations.value.filter((item) => item.status !== "已同步"));

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function canonicalHouseholdId(id: string) {
    return aliases.value[id] ?? id;
  }

  function findHousehold(id: string) {
    return households.value.find((item) => item.id === canonicalHouseholdId(id));
  }

  function findTask(id: string) {
    return tasks.value.find((item) => item.id === id);
  }

  function openConflictCount(householdId: string) {
    const canonicalId = canonicalHouseholdId(householdId);
    return conflicts.value.filter((item) => item.householdId === canonicalId && item.status === "待处理").length;
  }

  function touchHousehold(household: Household) {
    household.version += 1;
    household.deviceUpdatedAt = new Date().toISOString();
  }

  function reconcileHousehold(household: Household) {
    const unresolved = openConflictCount(household.id) > 0;
    const relatedTasks = tasks.value.filter((item) => item.householdId === household.id);
    const hasOpenTask = relatedTasks.some((item) => item.status !== "已完成");

    if (unresolved) {
      if (household.status === "已完成" || household.status === "待评估") household.status = "待复核";
      return;
    }

    if (relatedTasks.length > 0) {
      household.status = hasOpenTask ? "已分派" : "已完成";
    }
  }

  function recordOperation(type: OperationType, entity: string, action: string, detail: string, payload?: unknown, refs: { householdId?: string; taskId?: string } = {}) {
    const operation: SyncOperation = {
      id: createId("op"),
      seq: operationSeq++,
      type,
      entity,
      action,
      detail,
      time: new Date().toISOString(),
      status: "待同步",
      payload,
      householdId: refs.householdId,
      taskId: refs.taskId
    };
    operations.value.unshift(operation);
    appliedOperationIds.add(operation.id);
    return operation;
  }

  function enqueue(entity: string, action: string, detail: string) {
    return recordOperation("manual.note", entity, action, detail);
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt" | "fieldVersions" | "baseFields" | "mergedFrom">) {
    const household = normalizeHousehold({
      ...input,
      id: createId("h"),
      status: "待评估",
      version: 1,
      deviceUpdatedAt: new Date().toISOString()
    });
    const payload = { household: clone(household) };
    recordOperation("household.create", "家庭需求记录", "新增", input.head, payload, { householdId: household.id });
    households.value.unshift(household);
    return household.id;
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = findHousehold(id);
    if (!household) return;

    const canonicalId = household.id;
    const next = { ...patch };
    delete next.id;
    delete next.version;
    delete next.deviceUpdatedAt;
    delete next.fieldVersions;
    delete next.baseFields;
    delete next.mergedFrom;

    DATA_FIELDS.forEach((field) => {
      if (!(field in next)) return;
      household.fieldVersions[field] = fieldVersion(household, field) + 1;
    });

    Object.assign(household, next);
    touchHousehold(household);
    reconcileHousehold(household);

    recordOperation(
      "household.update",
      "家庭需求记录",
      "修改",
      `${household.head}：${Object.keys(next).join("、")}`,
      { householdId: canonicalId, patch: clone(next) },
      { householdId: canonicalId }
    );
  }

  function buildMergePlan(target: Household, source: Household, operationId: string, batchId?: string) {
    const patch: Partial<Household> = {};
    const nextFieldVersions = new Map<MergeableField, number>();
    const newConflicts: FieldConflict[] = [];

    SCALAR_FIELDS.forEach((field) => {
      const targetValue = target[field] as string | number;
      const sourceValue = source[field] as string | number;
      if (targetValue === sourceValue) return;

      if (isEmptyFieldValue(sourceValue)) return;
      if (isEmptyFieldValue(targetValue)) {
        if (field === "members") patch.members = Number(sourceValue);
        else (patch as Record<string, string>)[field] = String(sourceValue);
        nextFieldVersions.set(field, fieldVersion(target, field) + 1);
        return;
      }

      const targetChanged = fieldVersion(target, field) > 1;
      const sourceChanged = fieldVersion(source, field) > 1;
      const bothChanged = targetChanged && sourceChanged;
      const neitherChanged = !targetChanged && !sourceChanged;

      if (bothChanged || neitherChanged) {
        newConflicts.push({
          id: `${operationId}:${field}`,
          kind: "重复合并",
          operationId,
          batchId,
          householdId: target.id,
          field,
          localValue: formatFieldValue(targetValue),
          remoteValue: formatFieldValue(sourceValue),
          localLabel: `保留记录 ${target.address}`,
          remoteLabel: `转入记录 ${source.address}`,
          status: "待处理"
        });
        nextFieldVersions.set(field, Math.max(fieldVersion(target, field), fieldVersion(source, field)) + 1);
        return;
      }

      if (sourceChanged) {
        if (field === "members") patch.members = Number(sourceValue);
        else (patch as Record<string, string>)[field] = String(sourceValue);
        nextFieldVersions.set(field, Math.max(fieldVersion(target, field), fieldVersion(source, field)) + 1);
      }
    });

    ARRAY_FIELDS.forEach((field) => {
      const targetValues = target[field] as string[];
      const sourceValues = source[field] as string[];
      const merged = Array.from(new Set([...targetValues, ...sourceValues]));
      if (merged.length !== targetValues.length) {
        if (field === "needs") patch.needs = merged;
        else patch.vulnerable = merged;
        nextFieldVersions.set(field, Math.max(fieldVersion(target, field), fieldVersion(source, field)) + 1);
      }
    });

    return { patch, nextFieldVersions, newConflicts };
  }

  function executeMerge(operation: SyncOperation) {
    const payload = operation.payload as { sourceId: string; targetId: string };
    const source = households.value.find((item) => item.id === payload.sourceId);
    const target = findHousehold(payload.targetId);

    if (!source || !target || source.id === target.id) return { transferredTaskIds: [] as string[], rewrittenOperationIds: [] as string[] };
    if (appliedOperationIds.has(operation.id) && archivedHouseholds.value.some((item) => item.id === source.id)) {
      return { transferredTaskIds: [] as string[], rewrittenOperationIds: [] as string[] };
    }

    const plan = buildMergePlan(target, source, operation.id, operation.submitBatchId);
    Object.assign(target, plan.patch);
    plan.nextFieldVersions.forEach((version, field) => {
      target.fieldVersions[field] = version;
    });

    plan.newConflicts.forEach((conflict) => {
      if (!conflicts.value.some((item) => item.id === conflict.id)) conflicts.value.push(conflict);
    });

    conflicts.value.forEach((conflict) => {
      if (conflict.householdId === source.id) conflict.householdId = target.id;
    });

    const transferredTaskIds: string[] = [];
    tasks.value.forEach((task) => {
      if (task.householdId === source.id) {
        task.householdId = target.id;
        transferredTaskIds.push(task.id);
      }
    });

    const rewrittenOperationIds: string[] = [];
    operations.value.forEach((item) => {
      if (item.id === operation.id || item.status === "已同步" || item.type === "household.create" || item.type === "duplicate.merge") return;
      const itemPayload = item.payload as { householdId?: string; task?: { householdId?: string } } | undefined;
      const referenceId = item.type === "task.create" ? itemPayload?.task?.householdId : itemPayload?.householdId;
      if (referenceId === source.id) {
        if (item.type === "task.create" && itemPayload?.task) itemPayload.task.householdId = target.id;
        else if (itemPayload) itemPayload.householdId = target.id;
        item.householdId = target.id;
        rewrittenOperationIds.push(item.id);
      }
    });

    target.mergedFrom = Array.from(new Set([...target.mergedFrom, source.id, ...source.mergedFrom]));
    target.version = Math.max(target.version, source.version) + 1;
    target.deviceUpdatedAt = new Date().toISOString();

    archivedHouseholds.value.unshift(clone(source));
    households.value = households.value.filter((item) => item.id !== source.id);
    aliases.value[source.id] = target.id;
    reconcileHousehold(target);

    return { transferredTaskIds, rewrittenOperationIds };
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const canonicalTargetId = canonicalHouseholdId(targetId);
    const canonicalSourceId = canonicalHouseholdId(sourceId);
    const source = households.value.find((item) => item.id === canonicalSourceId);
    const target = households.value.find((item) => item.id === canonicalTargetId);
    if (!source || !target || source.id === target.id) return;

    const operation = recordOperation(
      "duplicate.merge",
      "重复记录",
      "合并/任务转移",
      `${source.head}：${source.address} → ${target.address}`,
      {
        sourceId: source.id,
        targetId: target.id,
        sourceSnapshot: clone(source),
        transferredTaskIds: [],
        rewrittenOperationIds: []
      },
      { householdId: target.id }
    );

    const result = executeMerge(operation);
    operation.payload = {
      ...(operation.payload as Record<string, unknown>),
      transferredTaskIds: result.transferredTaskIds,
      rewrittenOperationIds: result.rewrittenOperationIds
    };
    operation.detail = `${source.head}：${source.address} → ${target.address}；转入 ${result.transferredTaskIds.length} 个任务`;
    return operation.id;
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    const household = findHousehold(input.householdId);
    if (!household) return;

    const task: FieldTask = {
      ...input,
      householdId: household.id,
      id: createId("k"),
      status: "待接收"
    };
    recordOperation(
      "task.create",
      "任务",
      "分派",
      `${input.title} / ${input.assignee}`,
      { task: clone(task) },
      { householdId: household.id, taskId: task.id }
    );
    tasks.value.unshift(task);
    reconcileHousehold(household);
    return task.id;
  }

  function taskStatusRank(status: TaskStatus) {
    return { "待接收": 0, "进行中": 1, "已完成": 2 }[status];
  }

  function advanceTask(id: string) {
    const task = findTask(id);
    if (!task) return;

    const nextStatus: TaskStatus = task.status === "待接收" ? "进行中" : "已完成";
    recordOperation(
      "task.advance",
      "任务",
      "状态流转",
      `${task.title} → ${nextStatus}`,
      { taskId: task.id, householdId: task.householdId, nextStatus },
      { householdId: task.householdId, taskId: task.id }
    );

    if (taskStatusRank(nextStatus) > taskStatusRank(task.status)) task.status = nextStatus;
    const household = findHousehold(task.householdId);
    if (household) reconcileHousehold(household);
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return;

    const household = findHousehold(conflict.householdId);
    const rawValue = resolution === "采用本地" ? conflict.localValue : conflict.remoteValue;
    if (household) {
      if (conflict.field === "members") household.members = Number(rawValue);
      else if (!ARRAY_FIELDS.includes(conflict.field)) (household as Record<string, unknown>)[conflict.field] = rawValue;
      household.baseFields[conflict.field] = clone(household[conflict.field as keyof Household]);
      household.fieldVersions[conflict.field] = fieldVersion(household, conflict.field) + 1;
      touchHousehold(household);
    }

    conflict.status = resolution;
    recordOperation(
      "conflict.resolve",
      "字段冲突",
      resolution,
      `${household?.head ?? conflict.householdId} / ${conflict.field}`,
      { conflictId: conflict.id, householdId: household?.id ?? conflict.householdId, field: conflict.field, value: rawValue },
      { householdId: household?.id ?? conflict.householdId }
    );
    if (household) reconcileHousehold(household);
  }

  interface RemoteFieldChange {
    value: string | number;
    baseValue?: string | number;
    revision: string;
  }

  function receiveRemotePatch(householdId: string, changes: Partial<Record<MergeableField, RemoteFieldChange>>) {
    const household = findHousehold(householdId);
    if (!household) return [];

    const created: FieldConflict[] = [];
    Object.entries(changes).forEach(([field, change]) => {
      if (!change || seenRemoteRevisions.value.includes(change.revision)) return;
      const mergeField = field as MergeableField;
      if (!SCALAR_FIELDS.includes(mergeField)) return;

      const localValue = household[mergeField] as string | number;
      const baseValue = change.baseValue ?? (household.baseFields[mergeField] as string | number | undefined);
      seenRemoteRevisions.value.push(change.revision);

      if (localValue === change.value) return;
      if (baseValue === undefined || localValue === baseValue) {
        if (mergeField === "members") household.members = Number(change.value);
        else (household as Record<string, unknown>)[mergeField] = change.value;
        household.baseFields[mergeField] = change.value;
        household.fieldVersions[mergeField] = fieldVersion(household, mergeField) + 1;
        touchHousehold(household);
        return;
      }

      const conflict: FieldConflict = {
        id: change.revision,
        kind: "远端同步",
        operationId: change.revision,
        householdId: household.id,
        field: mergeField,
        localValue: formatFieldValue(localValue),
        remoteValue: formatFieldValue(change.value),
        localLabel: "本机记录",
        remoteLabel: "回站批次",
        status: "待处理"
      };
      if (!conflicts.value.some((item) => item.id === conflict.id)) {
        conflicts.value.push(conflict);
        created.push(conflict);
      }
    });
    return created;
  }

  function pullStationChanges() {
    const household = households.value.find((item) => item.id === "h1") ?? households.value[0];
    if (!household) return [];
    return receiveRemotePatch(household.id, {
      address: {
        value: "河湾路18号2栋2单元",
        baseValue: commonAddress,
        revision: "station-20260930-h1-address"
      }
    });
  }

  async function flushBatch(requestedBatchId?: string): Promise<SyncResult> {
    if (syncing.value) {
      return {
        ok: false,
        offline: false,
        batchId: requestedBatchId ?? "",
        processed: 0,
        remaining: queue.value.length,
        conflicts: conflicts.value.filter((item) => item.status === "待处理").length,
        message: "上一批仍在提交中。"
      };
    }
    if (!online.value) {
      return {
        ok: false,
        offline: true,
        batchId: requestedBatchId ?? operations.value.find((item) => item.status === "同步中")?.submitBatchId ?? "",
        processed: 0,
        remaining: queue.value.length,
        conflicts: conflicts.value.filter((item) => item.status === "待处理").length,
        message: "网络仍不可用，已处理项保留，未完成项不会重放。"
      };
    }

    const unfinished = operations.value.filter((item) => item.status !== "已同步");

    if (requestedBatchId) {
      const selectedUnfinished = unfinished.filter((item) => item.submitBatchId === requestedBatchId);
      if (selectedUnfinished.length === 0) {
        const hasProcessedOperation = operations.value.some((item) => item.submitBatchId === requestedBatchId && item.status === "已同步");
        return {
          ok: hasProcessedOperation,
          offline: false,
          batchId: requestedBatchId,
          processed: 0,
          remaining: 0,
          conflicts: conflicts.value.filter((item) => item.status === "待处理").length,
          message: hasProcessedOperation ? "同一批次已处理，重放不会重复执行。" : "没有找到该操作号对应的批次。"
        };
      }
    }

    syncing.value = true;
    let batchId = requestedBatchId ?? "";

    if (batchId) {
      unfinished
        .filter((item) => item.submitBatchId === batchId)
        .forEach((item) => { item.status = "同步中"; });
    } else {
      const active = [...unfinished].sort((a, b) => a.seq - b.seq).find((item) => item.submitBatchId);
      batchId = active?.submitBatchId ?? createId("batch");
      unfinished
        .filter((item) => !active || item.submitBatchId === batchId)
        .forEach((item) => {
          item.submitBatchId = batchId;
          item.status = "同步中";
        });
    }

    const selected = operations.value
      .filter((item) => item.submitBatchId === batchId && item.status !== "已同步")
      .sort((a, b) => a.seq - b.seq);
    let processed = 0;

    try {
      for (const operation of selected) {
        await wait(70);
        if (!online.value) throw new Error("offline");
        operation.status = "已同步";
        operation.error = undefined;
        processed += 1;
      }

      await wait(120);
      if (!online.value) throw new Error("offline");
      const remoteConflicts = pullStationChanges();
      lastSyncedAt.value = new Date().toISOString();
      const openConflicts = conflicts.value.filter((item) => item.status === "待处理").length;
      return {
        ok: true,
        offline: false,
        batchId,
        processed,
        remaining: 0,
        conflicts: openConflicts,
        message: remoteConflicts.length
          ? `批次 ${batchId.slice(0, 8)} 已提交，发现 ${remoteConflicts.length} 个字段冲突。`
          : `批次 ${batchId.slice(0, 8)} 提交完成，未重复执行操作。`
      };
    } catch {
      operations.value
        .filter((item) => item.submitBatchId === batchId && item.status === "同步中")
        .forEach((item) => { item.status = "待同步"; });
      const remaining = operations.value.filter((item) => item.submitBatchId === batchId && item.status !== "已同步");
      if (remaining[0]) remaining[0].error = "网络中断，恢复后仅续传该项及后续未完成项。";
      return {
        ok: false,
        offline: true,
        batchId,
        processed,
        remaining: remaining.length,
        conflicts: conflicts.value.filter((item) => item.status === "待处理").length,
        message: `网络中断：已保留 ${processed} 项，恢复后续传 ${remaining.length} 项。`
      };
    } finally {
      syncing.value = false;
    }
  }

  function simulateSync(batchId?: string) {
    return flushBatch(batchId);
  }

  function replayBatch(batchId: string) {
    return flushBatch(batchId);
  }

  if (typeof window !== "undefined") {
    watch([households, archivedHouseholds, aliases, tasks, operations, conflicts, seenRemoteRevisions, lastSyncedAt], () => {
      const state: PersistedState = {
        households: households.value,
        archivedHouseholds: archivedHouseholds.value,
        aliases: aliases.value,
        tasks: tasks.value,
        operations: operations.value,
        conflicts: conflicts.value,
        seenRemoteRevisions: seenRemoteRevisions.value,
        nextOperationSeq: operationSeq,
        lastSyncedAt: lastSyncedAt.value
      };
      window.localStorage.setItem(KEY, JSON.stringify(state));
    }, { deep: true });
  }

  return {
    households,
    archivedHouseholds,
    aliases,
    tasks,
    operations,
    queue,
    conflicts,
    online,
    lastSyncedAt,
    syncing,
    metrics,
    duplicates,
    canonicalHouseholdId,
    openConflictCount,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    advanceTask,
    simulateSync,
    flushBatch,
    replayBatch,
    resolveConflict,
    receiveRemotePatch,
    enqueue
  };
});
