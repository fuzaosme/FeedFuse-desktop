import type { ServerConfig } from '../config';
import { listDueFeeds } from '../domain/feeds';
import { pruneLogs } from '../domain/logs';
import { writeLog } from '../domain/logs';
import { getSettings } from '../domain/settings';
import { refreshFeeds } from './ingest';

const TICK_MS = 60_000;
/** 日志按留存天数裁剪，一天最多改一次就够，没必要跟着每分钟的抓取 tick 跑。 */
const MAINTENANCE_MS = 3_600_000;
/** 启动后第一轮维护等一分钟：先让首屏与首批抓取把 IO 用掉。 */
const MAINTENANCE_FIRST_DELAY_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let maintenanceBootTimer: NodeJS.Timeout | null = null;
let running = false;

/** 维护 tick：目前只有「按留存天数裁日志」，关掉日志功能时不清，避免用户重新打开后发现历史没了。 */
function runMaintenance(): void {
  try {
    const settings = getSettings();
    if (!settings.logging.enabled) return;
    pruneLogs();
  } catch (err) {
    writeLog({
      level: 'error',
      category: 'scheduler',
      message: '日志留存清理失败',
      source: 'services/scheduler',
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 本地调度器：每分钟检查一次到期订阅。
 * 之所以不用队列/worker，是因为单机场景只需要「别在启动瞬间把几十个源一起打出去」。
 */
export function startScheduler(cfg: ServerConfig): void {
  if (timer) return;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // 到期与否只看每个订阅自己的 fetch_interval_minutes（见 listDueFeeds），不读全局设置。
      const due = listDueFeeds();

      if (due.length > 0) {
        await refreshFeeds(
          due.slice(0, 12).map((feed) => feed.id),
          cfg,
          { force: false },
        );
      }
    } catch (err) {
      writeLog({
        level: 'error',
        category: 'scheduler',
        message: '定时任务执行失败',
        source: 'services/scheduler',
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  // 启动后先等 8 秒再跑第一轮，让界面先完成首屏。
  // 句柄要留到 stopScheduler 能清掉，否则停掉的调度器还会再 fire 一次 tick。
  bootTimer = setTimeout(() => void tick(), 8_000);
  bootTimer.unref?.();
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();

  maintenanceBootTimer = setTimeout(runMaintenance, MAINTENANCE_FIRST_DELAY_MS);
  maintenanceBootTimer.unref?.();
  maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_MS);
  maintenanceTimer.unref?.();

  writeLog({
    level: 'info',
    category: 'scheduler',
    message: '本地调度器已启动',
    source: 'services/scheduler',
    context: { tickMs: TICK_MS, maintenanceMs: MAINTENANCE_MS },
  });
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  if (maintenanceBootTimer) {
    clearTimeout(maintenanceBootTimer);
    maintenanceBootTimer = null;
  }
}
