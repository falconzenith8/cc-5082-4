// 确定性伪随机数生成器（mulberry32 + 字符串种子哈希）。
// 同一种子产出完全相同的字节序列，用于重建角色池与情境提交序列；禁止用 Date.now/Math.random。

export function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const input = String(seed);
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.seedText = String(seed);
    this.state = hashSeed(seed);
    this.calls = 0;
  }

  next() {
    this.calls += 1;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // 闭区间 [min, max] 整数
  int(min, max) {
    if (max < min) throw new Error(`Rng.int: max(${max}) < min(${min})`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick(list) {
    if (!list.length) throw new Error('Rng.pick: empty list');
    return list[Math.floor(this.next() * list.length)];
  }

  // Fisher–Yates 洗牌，返回新数组
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  fork(salt) {
    return new Rng(`${this.seedText}:${salt}`);
  }
}
