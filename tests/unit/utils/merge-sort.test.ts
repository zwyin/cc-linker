import { test, expect, describe } from "bun:test";
import { mergeSort } from "../../../src/utils/merge-sort";

describe("mergeSort", () => {
  test("空数组", () => {
    expect(mergeSort([])).toEqual([]);
  });

  test("单元素", () => {
    expect(mergeSort([42])).toEqual([42]);
  });

  test("已排序数组", () => {
    expect(mergeSort([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  test("逆序数组", () => {
    expect(mergeSort([5, 4, 3, 2, 1])).toEqual([1, 2, 3, 4, 5]);
  });

  test("含重复元素", () => {
    expect(mergeSort([3, 1, 3, 2, 1])).toEqual([1, 1, 2, 3, 3]);
  });

  test("全相同元素", () => {
    expect(mergeSort([7, 7, 7, 7])).toEqual([7, 7, 7, 7]);
  });

  test("稳定性：相等元素保持原顺序", () => {
    const items = [
      { key: 1, label: "a" },
      { key: 1, label: "b" },
      { key: 2, label: "c" },
      { key: 2, label: "d" },
    ];
    const sorted = mergeSort(items, (a, b) => a.key - b.key);
    expect(sorted.map((x) => x.label)).toEqual(["a", "b", "c", "d"]);
  });

  test("大范围随机数", () => {
    const arr = Array.from({ length: 10000 }, () => Math.random() * 100000);
    const sorted = mergeSort(arr);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBeGreaterThanOrEqual(sorted[i - 1]);
    }
  });

  test("自定义比较器：字符串按长度排序", () => {
    const words = ["banana", "hi", "a", "test", "hello"];
    expect(mergeSort(words, (a, b) => a.length - b.length)).toEqual([
      "a",
      "hi",
      "test",
      "hello",
      "banana",
    ]);
  });
});
