import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export type OpType =
  | "household-add"
  | "household-update"
  | "duplicate-merge"
  | "task-add"
  | "task-advance"
  | "task-transfer";
export type OpStatus = "pending" | "done" | "failed";

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
  /** 上次成功同步时的字段快照，作为字段级三方合并的基准 */
  base: Record<string, unknown>;
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

/** 统一操作号：批次提交、重复合并、任务转移都落在同一条操作日志上 */
export interface Operation {
  id: string;
  batchId: string;
  type: OpType;
  status: OpStatus;
  /** 幂等键：重放同一批时据此判重，合并/转移不会执行两次 */
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

export interface PendingChange {
  id: string;
  batchId: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
  status: OpStatus;
  error?: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: string;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
  origin: "sync" | "merge";
}

const KEY = "pair-wise-yf-50/assessment";

const mergeableFields = ["head", "community", "address", "members", "vulnerable", "needLevel", "needs", "note"] as const;
type MergeableField = (typeof mergeableFields)[number];

const seedBase: Record<string, unknown> = {
  head: "王建国",
  community: "河湾社区",
  address: "河湾路18号",
  members: 4,
  vulnerable: ["老人"],
  needLevel: "紧急",
  needs: ["临时安置"],
  note: "一层受淹"
};

const seedHouseholds: Household[] = [
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
    base: { ...seedBase, vulnerable: [...(seedBase.vulnerable as string[])], needs: [...(seedBase.needs as string[])] }
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
    note: "饮水库存不足",
    base: { head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], note: "饮水库存不足" }
  },
  {
    id: "h3",
    head: "王建国",
    community: "河湾社区",
    address: "河湾路18号2幢2单元",
    members: 4,
    vulnerable: ["老人", "儿童"],
    needLevel: "紧急",
    needs: ["临时安置", "慢病用药"],
    status: "待评估",
    version: 1,
    deviceUpdatedAt: new Date().toISOString(),
    note: "疑似重复登记",
    base: { ...seedBase, vulnerable: [...(seedBase.vulnerable as string[])], needs: [...(seedBase.needs as string[])] }
  }
];

const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" },
  { id: "k2", householdId: "h3", title: "现场复核", assignee: "救援一组", priority: "紧急", status: "进行中", due: "2026-09-30 18:00" },
  { id: "k3", householdId: "h1", title: "现场复核", assignee: "救援一组", priority: "紧急", status: "待接收", due: "2026-09-30 18:00" }
];

const seedOps: Operation[] = [
  { id: "op-seed-1", batchId: "batch-seed-1", type: "household-add", status: "pending", idempotencyKey: "household-add:h3", payload: { householdId: "h3", head: "王建国" }, createdAt: new Date().toISOString() },
  { id: "op-seed-2", batchId: "batch-seed-2", type: "task-add", status: "pending", idempotencyKey: "task-add:k2", payload: { taskId: "k2", title: "现场复核", assignee: "救援一组" }, createdAt: new Date().toISOString() },
  { id: "op-seed-3", batchId: "batch-seed-3", type: "household-update", status: "pending", idempotencyKey: "household-update:h3:seed-vulnerable", payload: { householdId: "h3", head: "王建国", fields: ["vulnerable"], patch: { vulnerable: ["老人", "儿童"] } }, createdAt: new Date().toISOString() }
];

function fieldLabel(type: OpType): string {
  switch (type) {
    case "household-add":
      return "家庭需求记录";
    case "household-update":
      return "家庭需求记录";
    case "duplicate-merge":
      return "重复记录";
    case "task-add":
      return "任务";
    case "task-advance":
      return "任务";
    case "task-transfer":
      return "任务";
  }
}

function actionLabel(type: OpType): string {
  switch (type) {
    case "household-add":
      return "新增";
    case "household-update":
      return "修改";
    case "duplicate-merge":
      return "合并";
    case "task-add":
      return "分派";
    case "task-advance":
      return "状态流转";
    case "task-transfer":
      return "转移";
  }
}

function opDetail(op: Operation): string {
  const p = op.payload;
  switch (op.type) {
    case "household-add":
      return `${p.head ?? ""}`;
    case "household-update":
      return `${p.head ?? ""}：${((p.fields as string[]) ?? []).join("、")}`;
    case "duplicate-merge":
      return `${p.sourceHead ?? p.sourceId} → ${p.targetHead ?? p.targetId}`;
    case "task-add":
      return `${p.title} / ${p.assignee}`;
    case "task-advance":
      return `${p.title} → ${p.toStatus}`;
    case "task-transfer":
      return `${p.title}：${p.fromId} → ${p.toId}`;
  }
}

function equalValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map(String).sort();
    const sb = [...b].map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return a === b;
}

function stringify(v: unknown): string {
  if (Array.isArray(v)) return v.join("、");
  return String(v);
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const ops = ref<Operation[]>(initial?.ops ?? seedOps);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const online = ref(true);
  const syncing = ref(false);
  /** 模拟中途断网：处理 2 项后中断，已处理项保留 */
  const injectFailure = ref(false);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncMessage = ref("");
  const blockedMessage = ref("");

  let activeBatchId = "";
  function beginBatch(): string {
    activeBatchId = crypto.randomUUID();
    return activeBatchId;
  }

  const queue = computed<PendingChange[]>(() =>
    ops.value
      .filter((o) => o.status === "pending" || o.status === "failed")
      .map((o) => ({
        id: o.id,
        batchId: o.batchId,
        entity: fieldLabel(o.type),
        action: actionLabel(o.type),
        detail: opDetail(o),
        time: o.createdAt,
        status: o.status,
        error: o.error
      }))
  );

  const doneOps = computed(() => ops.value.filter((o) => o.status === "done").length);

  function hasUnresolvedConflict(householdId: string): boolean {
    return conflicts.value.some((c) => c.householdId === householdId && c.status === "待处理");
  }

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length,
    failed: ops.value.filter((o) => o.status === "failed").length,
    blocked: households.value.filter((h) => hasUnresolvedConflict(h.id)).length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function commitOp(input: Omit<Operation, "id" | "batchId" | "status" | "createdAt">): Operation {
    const op: Operation = {
      id: crypto.randomUUID(),
      batchId: activeBatchId || beginBatch(),
      status: "pending",
      createdAt: new Date().toISOString(),
      ...input
    };
    ops.value.push(op);
    return op;
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt" | "base"> & { base?: Record<string, unknown> }) {
    beginBatch();
    const id = crypto.randomUUID();
    const base = { ...input, vulnerable: [...input.vulnerable], needs: [...input.needs] };
    const household: Household = { ...input, id, status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), base };
    households.value.unshift(household);
    commitOp({ type: "household-add", idempotencyKey: `household-add:${id}`, payload: { householdId: id, head: input.head } });
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    beginBatch();
    const fields = Object.keys(patch);
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    commitOp({
      type: "household-update",
      idempotencyKey: `household-update:${id}:${crypto.randomUUID()}`,
      payload: { householdId: id, head: household.head, fields, patch }
    });
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const key = `merge:${sourceId}->${targetId}`;
    // 幂等：同一合并批次重放时不重复执行
    if (ops.value.some((o) => o.idempotencyKey === key && o.status === "done")) {
      blockedMessage.value = "该合并批次已执行，不能重复合并。";
      return;
    }
    if (ops.value.some((o) => o.idempotencyKey === key && o.status !== "done")) {
      blockedMessage.value = "该合并已在队列中，请勿重复提交。";
      return;
    }
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    beginBatch();

    // 字段级三方合并：不同字段各自合并；同一字段双方都改过且不一致则保留两版，不静默覆盖
    const newConflicts: FieldConflict[] = [];
    for (const field of mergeableFields) {
      const sVal = (source as Record<string, unknown>)[field];
      const tVal = (target as Record<string, unknown>)[field];
      const sChanged = !equalValue(sVal, source.base?.[field]);
      const tChanged = !equalValue(tVal, target.base?.[field]);
      if (sChanged && tChanged && !equalValue(sVal, tVal)) {
        newConflicts.push({
          id: crypto.randomUUID(),
          householdId: target.id,
          field,
          localValue: stringify(tVal),
          remoteValue: stringify(sVal),
          status: "待处理",
          origin: "merge"
        });
      } else if (sChanged && !tChanged) {
        (target as Record<string, unknown>)[field] = sVal;
      }
    }

    // 任务转入保留记录：重新指向，进度不倒退
    const sourceTaskIds = new Set(tasks.value.filter((t) => t.householdId === sourceId).map((t) => t.id));
    for (const task of tasks.value) {
      if (task.householdId === sourceId) {
        task.householdId = targetId;
      }
    }
    // 同标题任务去重：保留进度更靠前的一版，低进度版本并入高进度，进度不倒退
    const rank: Record<TaskStatus, number> = { 待接收: 0, 进行中: 1, 已完成: 2 };
    const byTitle = new Map<string, FieldTask[]>();
    for (const task of tasks.value) {
      if (task.householdId === targetId) {
        const arr = byTitle.get(task.title) ?? [];
        arr.push(task);
        byTitle.set(task.title, arr);
      }
    }
    for (const arr of byTitle.values()) {
      if (arr.length > 1) {
        arr.sort((a, b) => rank[b.status] - rank[a.status]);
        for (const drop of arr.slice(1)) {
          tasks.value = tasks.value.filter((t) => t.id !== drop.id);
        }
      }
    }
    // 仅对去重后仍保留的任务记录转移操作
    const transferred = tasks.value.filter((t) => sourceTaskIds.has(t.id));

    // 待同步操作重新指向保留记录，避免合并后仍指向旧记录
    for (const op of ops.value) {
      if (op.status === "done") continue;
      if (op.payload.householdId === sourceId) op.payload.householdId = targetId;
      if (op.payload.fromId === sourceId) op.payload.fromId = targetId;
      if (op.payload.toId === sourceId) op.payload.toId = targetId;
    }
    // 未决冲突重新指向保留记录
    for (const c of conflicts.value) {
      if (c.householdId === sourceId) c.householdId = targetId;
    }
    conflicts.value.unshift(...newConflicts);

    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    target.deviceUpdatedAt = new Date().toISOString();
    // 合并绝不自动结案：有未决冲突或未完成任务都不能置为已完成
    const hasOpenTask = tasks.value.some((t) => t.householdId === targetId && t.status !== "已完成");
    if (hasOpenTask && target.status === "待评估") target.status = "已分派";

    households.value = households.value.filter((item) => item.id !== sourceId);

    commitOp({
      type: "duplicate-merge",
      idempotencyKey: key,
      payload: { sourceId, targetId, sourceHead: source.head, targetHead: target.head, conflicts: newConflicts.length }
    });
    for (const task of transferred) {
      commitOp({
        type: "task-transfer",
        idempotencyKey: `transfer:${task.id}:${sourceId}->${targetId}`,
        payload: { taskId: task.id, title: task.title, fromId: sourceId, toId: targetId }
      });
    }

    blockedMessage.value = newConflicts.length
      ? `合并完成：${newConflicts.length} 个字段冲突待处理，任务已转入保留记录；冲突未清前不可结案。`
      : "合并完成：任务已转入保留记录，待同步操作已重新指向。";
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    beginBatch();
    const id = crypto.randomUUID();
    const task: FieldTask = { ...input, id, status: "待接收" };
    tasks.value.unshift(task);
    const household = households.value.find((item) => item.id === input.householdId);
    // 分派只推进到已分派，绝不提前结案
    if (household && household.status === "待评估") household.status = "已分派";
    commitOp({ type: "task-add", idempotencyKey: `task-add:${id}`, payload: { taskId: id, title: task.title, assignee: task.assignee } });
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task || task.status === "已完成") return;
    beginBatch();
    const toStatus: TaskStatus = task.status === "待接收" ? "进行中" : "已完成";
    // 冲突未清前不能结案：完成动作被拦截，任务可继续推进
    if (toStatus === "已完成" && hasUnresolvedConflict(task.householdId)) {
      blockedMessage.value = "该家庭存在未解决的字段冲突，暂不能结案；可先推进任务状态。";
      if (task.status === "待接收") {
        task.status = "进行中";
        commitOp({ type: "task-advance", idempotencyKey: `advance:${id}:进行中`, payload: { taskId: id, title: task.title, toStatus: "进行中" } });
      }
      return;
    }
    task.status = toStatus;
    if (toStatus === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open && !hasUnresolvedConflict(task.householdId)) household.status = "已完成";
    }
    commitOp({ type: "task-advance", idempotencyKey: `advance:${id}:${toStatus}`, payload: { taskId: id, title: task.title, toStatus } });
  }

  function maybeGenerateSyncConflict() {
    const target = households.value.find((h) => !hasUnresolvedConflict(h.id));
    if (!target) return;
    const field = "address";
    if (conflicts.value.some((c) => c.householdId === target.id && c.field === field && c.status === "待处理")) return;
    conflicts.value.unshift({
      id: crypto.randomUUID(),
      householdId: target.id,
      field,
      localValue: stringify((target as Record<string, unknown>)[field]),
      remoteValue: "河湾路18号2栋2单元",
      status: "待处理",
      origin: "sync"
    });
  }

  async function simulateSync() {
    if (!online.value) {
      syncMessage.value = "仍在弱网状态，队列保留在设备中；恢复后从未完成项续传。";
      return;
    }
    syncing.value = true;
      await new Promise((resolve) => setTimeout(resolve, 350));
    let processed = 0;
    let failed = false;
    for (const op of ops.value) {
      if (op.status === "done") continue; // 幂等：已处理项跳过，重放不重复执行
      if (injectFailure.value && processed >= 2) {
        op.status = "failed";
        op.error = "网络中断，服务端未确认";
        failed = true;
        break;
      }
      op.status = "done";
      op.finishedAt = new Date().toISOString();
      processed++;
    }
    if (failed) {
      syncMessage.value = `网络中断：已处理 ${processed} 项并保留，恢复后从未完成项续传（已跳过已处理项）。`;
    } else {
      if (processed > 0) maybeGenerateSyncConflict();
      syncMessage.value = processed ? `同步完成：已处理 ${processed} 项，无重复执行。` : "没有待同步操作。";
    }
    lastSyncedAt.value = new Date().toISOString();
    syncing.value = false;
  }

  function retryFailed(id: string) {
    const op = ops.value.find((item) => item.id === id);
    if (!op || op.status !== "failed") return;
    op.status = "pending";
    op.error = undefined;
    simulateSync();
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") {
      (household as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
    }
    conflict.status = resolution;
    if (household) {
      household.version += 1;
      household.deviceUpdatedAt = new Date().toISOString();
    }
    blockedMessage.value = "";
  }

  if (typeof window !== "undefined") {
    watch(
      [households, tasks, ops, conflicts, lastSyncedAt],
      () => {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            households: households.value,
            tasks: tasks.value,
            ops: ops.value,
            conflicts: conflicts.value,
            lastSyncedAt: lastSyncedAt.value
          })
        );
      },
      { deep: true }
    );
  }

  return {
    households,
    tasks,
    ops,
    queue,
    conflicts,
    online,
    syncing,
    injectFailure,
    lastSyncedAt,
    syncMessage,
    blockedMessage,
    metrics,
    doneOps,
    duplicates,
    hasUnresolvedConflict,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    advanceTask,
    simulateSync,
    retryFailed,
    resolveConflict
  };
});
