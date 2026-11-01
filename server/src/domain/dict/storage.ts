import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 文件型词典的落盘位置。
 *
 * 目录结构：
 *   <dataDir>/dictionaries/
 *     <uuid>/xxx.mdx          已导入词典的原始文件副本（查词期要回读）
 *     <uuid>/xxx.mdd
 *     <uuid>/xxx.ifo / .idx / .dict(.dz) / .syn
 *     _staging/<token>/       上传中的临时文件，导入成功后整目录搬走
 *
 * 为什么保留副本而不引用用户原始路径：用户随时可能移动、重命名或删掉下载目录，
 * 那时词典会变成一堆点不开的词条。副本让「导入」成为一次独立、可回滚的操作。
 */

let storageRoot: string | null = null;

export function configureDictionaryStorage(dir: string): void {
  storageRoot = dir;
}

export function dictionaryStorageRoot(): string {
  if (!storageRoot) throw new Error('词典存储目录未初始化');
  mkdirSync(storageRoot, { recursive: true });
  return storageRoot;
}

/** 每本词典一个独立目录，便于整体删除，也避免不同词典的同名资源互相覆盖。 */
export function createDictionaryDir(): string {
  const dir = join(dictionaryStorageRoot(), randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDictionaryDir(dir: string | null | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // 目录删不掉不该阻断「从列表里移除词典」这个用户动作。
    console.warn('[dict] 删除词典目录失败', dir, err);
  }
}

/**
 * 把选中的文件复制进词典目录。
 * 返回「原路径 → 副本路径」，后续解析统一走副本，避免用户中途动源文件。
 */
export function copyIntoDictionary(dir: string, files: string[]): Map<string, string> {
  const used = new Set<string>();
  const copies = new Map<string, string>();

  for (const file of files) {
    let name = basename(file);
    if (used.has(name.toLowerCase())) {
      // 同名不同目录（比如两个 part 目录下的 index.idx）加序号区分。
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let index = 2;
      while (used.has(`${stem}-${index}${ext}`.toLowerCase())) index += 1;
      name = `${stem}-${index}${ext}`;
    }
    used.add(name.toLowerCase());
    const target = join(dir, name);
    copyFileSync(file, target);
    copies.set(file, target);
  }
  return copies;
}

/* ------------------------------- 上传暂存 ------------------------------- */

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StagedUpload {
  token: string;
  dir: string;
}

/** 本地接口的 token 会出现在 URL 里，目录名必须严格校验，绝不能让路径穿越进来。 */
export function isValidUploadToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function createStagingDir(): StagedUpload {
  const token = randomUUID();
  const dir = join(dictionaryStorageRoot(), '_staging', token);
  mkdirSync(dir, { recursive: true });
  return { token, dir };
}

export function stagingDirOf(token: string): string | null {
  if (!isValidUploadToken(token)) return null;
  const dir = join(dictionaryStorageRoot(), '_staging', token);
  return existsSync(dir) ? dir : null;
}

export function removeStagingDir(token: string): void {
  removeDictionaryDir(stagingDirOf(token));
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 库里存的是「相对词典根目录」的路径，而不是绝对路径：
 * 用户换机器、改数据目录（FEEDFUSE_DATA_DIR）之后词典还能找到自己的文件。
 */
export function relativeToRoot(absolute: string): string {
  return relative(dictionaryStorageRoot(), absolute);
}

export function absoluteFromRoot(stored: string): string {
  return isAbsolute(stored) ? stored : join(dictionaryStorageRoot(), stored);
}
