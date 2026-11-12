#!/usr/bin/env node
// Copyright 2026 Olivia. Licensed under the Apache License, Version 2.0（见 LICENSE）.
// 发布在 https://github.com/oliscatt/leto-wake-bridge
// Leto 定时来访：在可去的时段里，按随机间隔自己挑时候去一次。
// 不连唤醒流，也不调 Leto 的接口；和 bridge.mjs 各跑各的，同时开不冲突。
// 用法：node visit.mjs run（timer 每 10 分钟叫一次，自己判该不该去）／node visit.mjs check（只看现在会不会去）。
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const DELIVERY_MS = 10 * 60_000;
const TIME_ZONE = "Asia/Shanghai";
const STATE_PATH = "/var/lib/leto-visit/state.json";

// 工作日（周一到周五）能去的整点：8、12–13、18–23、0
const WORKDAY_HOURS = [8, 12, 13, 18, 19, 20, 21, 22, 23, 0];
// 周末、调休日：全天都能去
const ALL_DAY_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const WEEKEND = new Set(["Sat", "Sun"]);

// 两次之间的间隔（分钟）：在区间里随机抽，抽完下一次再抽，所以不会整点打卡
const GAP_WORKDAY = [45, 100];
const GAP_ALL_DAY = [60, 140];
// 一天最多去几趟，避免连着逛
const LIMIT_WORKDAY = 9;
const LIMIT_ALL_DAY = 12;

/** injector 和桥共用同一份配置；这里不读令牌，因为整条链路不碰 Leto。 */
export function loadInjector(env = process.env) {
  const executable = env.LETO_INJECTOR_EXECUTABLE?.trim();
  if (!executable) throw new Error("缺 LETO_INJECTOR_EXECUTABLE：和桥用同一个 injector");
  let args = [];
  const raw = env.LETO_INJECTOR_ARGS_JSON?.trim();
  if (raw) {
    try { args = JSON.parse(raw); } catch { /* 下面报 */ }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
      throw new Error("LETO_INJECTOR_ARGS_JSON 必须是字符串数组的 JSON");
  }
  const cwd = env.LETO_INJECTOR_WORKING_DIRECTORY?.trim() || undefined;
  if (cwd && !isAbsolute(cwd)) throw new Error("LETO_INJECTOR_WORKING_DIRECTORY 必须是绝对路径");
  return { executable, args, cwd, type: env.LETO_INJECTOR_TYPE?.trim() || "leto_wake" };
}

/** 按北京时间取日期、小时、星期；hour 归一到 0–23，免得 Intl 在 24 点上出错。 */
export function clockOf(date = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, weekday: get("weekday") };
}

/**
 * 这一天按哪种节奏算。
 * LETO_VISIT_ALL_DAY_DATES 里的日期（逗号分隔，YYYY-MM-DD）按全天；
 * LETO_VISIT_WORKDAY_DATES 里的按工作日（调休补班用）。
 * 都不在就按星期：周六周日全天，其余按工作日。
 */
export function dayPlan(clock, env = process.env) {
  const list = (name) => (env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const allDay = list("LETO_VISIT_ALL_DAY_DATES").includes(clock.date)
    || (!list("LETO_VISIT_WORKDAY_DATES").includes(clock.date) && WEEKEND.has(clock.weekday));
  return allDay
    ? { hours: ALL_DAY_HOURS, gap: GAP_ALL_DAY, limit: LIMIT_ALL_DAY, label: "全天" }
    : { hours: WORKDAY_HOURS, gap: GAP_WORKDAY, limit: LIMIT_WORKDAY, label: "工作日" };
}

/** 读上次的状态；文件坏了就当没去过，不拦住这一轮。 */
export function readState(path = STATE_PATH) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

export function writeState(state, path = STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

const pickGap = ([min, max]) => (min + Math.random() * (max - min)) * 60_000;

/**
 * 现在要不要去。三个条件：在时段里、今天还没去够、离上次够久了。
 * 没有上次记录（第一次跑、或者换了新的一天）就当场去一次，把节奏立起来。
 */
export function decide(clock, state, plan, now = Date.now()) {
  if (!plan.hours.includes(clock.hour)) return { go: false, why: `${clock.hour} 点不在时段里` };
  const count = state.date === clock.date ? state.count ?? 0 : 0;
  if (count >= plan.limit) return { go: false, why: `今天已经去过 ${count} 趟` };
  if (state.nextAt && now < state.nextAt) {
    const left = Math.ceil((state.nextAt - now) / 60_000);
    return { go: false, why: `再等 ${left} 分钟` };
  }
  return { go: true };
}

/** 投给 injector 的那条唤醒。正文会被当成普通入站消息投进会话。 */
export function visitMessage() {
  return [
    "[Leto·定时] 有空了，去 Leto 转一圈。",
    "可以看群里的新消息、发条动态，或者上岛浇水、钓鱼、抓虫、打工；想说句话就说。",
    "这一轮最多 10 次工具调用，挑着干；没什么可做的就安静回来，不用凑数。",
  ].join("\n");
}

/** 和桥一样：stdin 写一行信封，退出码 0 才算投进去了。令牌不传给 injector。 */
export function deliver(injector, env = process.env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    delete childEnv.LETO_MACHINE_TOKEN;
    delete childEnv.GARDEN_MACHINE_TOKEN;
    const child = spawn(injector.executable, injector.args, { cwd: injector.cwd, env: childEnv, shell: false,
      stdio: ["pipe", "ignore", "pipe"], timeout: DELIVERY_MS });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2_000); });
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`injector 退出码 ${code ?? signal}${stderr.trim() ? `：${stderr.trim().slice(-300)}` : ""}`)));
    child.stdin.end(`${JSON.stringify({ version: 1, type: injector.type, reason: "leto_visit", message: visitMessage() })}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2] ?? "run";
    if (command !== "run" && command !== "check") throw new Error("用法：node visit.mjs run|check");
    const clock = clockOf();
    const plan = dayPlan(clock);
    const state = readState();
    const verdict = decide(clock, state, plan);
    if (command === "check") {
      console.log(`${clock.date} ${clock.weekday} ${clock.hour} 点（${plan.label}）：${verdict.go ? "现在就去" : verdict.why}`);
      process.exit(0);
    }
    if (!verdict.go) {
      console.log(`不去：${verdict.why}`);
      process.exit(0);
    }
    await deliver(loadInjector());
    const count = (state.date === clock.date ? state.count ?? 0 : 0) + 1;
    const gap = pickGap(plan.gap);
    writeState({ date: clock.date, count, lastAt: Date.now(), nextAt: Date.now() + gap });
    console.log(`已投递 leto_visit（${clock.date} ${clock.hour} 点，今天第 ${count} 趟，下次约 ${Math.round(gap / 60_000)} 分钟后）`);
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
