/** 一个已接管字段的诊断记录。 */
export interface FieldGuardRecord {
  /** 字段名。 */
  readonly key: string;
  /** 接管前的原值。 */
  readonly original: unknown;
  /** 本守卫最后一次写入的值。 */
  readonly last: unknown;
}

/**
 * 共享对象字段的所有权记录。
 *
 * 只记录**实际改动过**的字段的原值与最后写入值；恢复时仅覆盖"当前值仍等于本模块最后写入值"
 * 的字段，因此不会覆盖期间其它调用方写入的新值。适用于接管 `scene.fog` 这类共享对象的场景：
 * 业务可以在 SDK 生效期间改同一个字段，`restore()` 不会把它改回去。
 *
 * 局限：无法区分"别的模块写入了相同的值"，后续写入方应接入同一协议。
 */
export class FieldGuard {
  private readonly fields = new Map<string, { original: unknown; last: unknown }>();

  /**
   * @param target - 被接管的对象；省略时所有写入都是空操作（`set` 返回 `false`）。
   */
  constructor(private readonly target: Record<string, unknown> | undefined) {}

  /** 已接管字段数量。 */
  get size(): number {
    return this.fields.size;
  }

  /**
   * 写入字段并记录原值（首次写入才记录）。
   *
   * @param key - 字段名。
   * @param value - 新值。
   * @returns 目标存在且值确实变化时为 `true`。
   */
  set(key: string, value: unknown): boolean {
    const target: Record<string, unknown> | undefined = this.target;
    if (!target) {
      return false;
    }
    if (target[key] === value) {
      return false;
    }
    const record = this.fields.get(key);
    if (record) {
      record.last = value;
    } else {
      this.fields.set(key, { original: target[key], last: value });
    }
    target[key] = value;
    return true;
  }

  /** 该字段是否已被本守卫接管。 */
  has(key: string): boolean {
    return this.fields.has(key);
  }

  /** 读取字段当前值；目标不存在时返回 `undefined`。 */
  get(key: string): unknown {
    return this.target?.[key];
  }

  /**
   * 恢复全部已接管字段。
   *
   * 只覆盖"当前值仍等于本守卫最后写入值"的字段，返回实际恢复的字段数量。
   */
  restore(): number {
    const target: Record<string, unknown> | undefined = this.target;
    if (!target) {
      this.fields.clear();
      return 0;
    }
    let restored = 0;
    for (const [key, record] of this.fields) {
      if (target[key] === record.last) {
        target[key] = record.original;
        restored += 1;
      }
    }
    this.fields.clear();
    return restored;
  }

  /**
   * 读取已接管字段的诊断快照。
   *
   * @returns 字段名、原值与最后写入值；顺序为接管顺序。
   */
  describe(): FieldGuardRecord[] {
    return [...this.fields.entries()].map(([key, record]) => ({
      key,
      original: record.original,
      last: record.last,
    }));
  }
}
