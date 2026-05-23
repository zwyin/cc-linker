/**
 * 自底向上归并排序
 *
 * 时间复杂度：O(N log N) — 最坏/平均/最好均为 O(N log N)
 * 空间复杂度：O(N) — 仅需一个临时数组
 * 稳定性：稳定（相等元素保持原有相对顺序）
 */

export function mergeSort<T>(arr: T[], compare: (a: T, b: T) => number = defaultCompare): T[] {
  if (arr.length <= 1) return [...arr];

  const result = [...arr];
  const aux = new Array<T>(arr.length);

  // 奇数长度时，最后一个元素无法配对，先复制到 aux
  for (let i = 0; i < arr.length; i++) aux[i] = result[i];

  // width 控制当前合并的子数组大小：1 → 2 → 4 → 8 → ...
  for (let width = 1; width < arr.length; width *= 2) {
    for (let left = 0; left < arr.length; left += 2 * width) {
      const mid = Math.min(left + width, arr.length);
      const right = Math.min(left + 2 * width, arr.length);

      if (mid >= right) continue;

      // 从 aux 读取，写入 result
      merge(aux, result, left, mid, right, compare);
    }
    // 本轮结果：result 是输出，下一轮需要从 result 读取，所以拷回 aux
    for (let i = 0; i < arr.length; i++) aux[i] = result[i];
  }

  return result;
}

function merge<T>(
  src: T[],
  dest: T[],
  left: number,
  mid: number,
  right: number,
  compare: (a: T, b: T) => number,
): void {
  let i = left;
  let j = mid;
  let k = left;

  while (i < mid && j < right) {
    dest[k++] = compare(src[i], src[j]) <= 0 ? src[i++] : src[j++];
  }
  while (i < mid) dest[k++] = src[i++];
  while (j < right) dest[k++] = src[j++];
}

function defaultCompare<T>(a: T, b: T): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
