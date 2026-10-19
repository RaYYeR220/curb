import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatClock,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatSig,
  formatSpan,
  formatTick,
  parseAmount,
  shortHex,
} from "./format";

describe("format", () => {
  it("keeps significant digits without exponent notation", () => {
    expect(formatSig(0.000001065106, 4)).toBe("0.000001065");
    expect(formatSig(9642.948757, 4)).toBe("9,643");
  });

  it("formats base-unit amounts", () => {
    expect(formatAmount(1065106246299n, 18)).toBe("0.000001065");
    expect(formatAmount(9642948757067656730759n, 18)).toBe("9,643");
    expect(formatAmount(-100000000n, 18)).toBe("−0.0000000001");
  });

  it("parses typed amounts and rejects anything else", () => {
    expect(parseAmount("0.0001", 18)).toBe(100000000000000n);
    expect(parseAmount(" 10,000 ", 18)).toBe(10000n * 10n ** 18n);
    expect(parseAmount(".5", 18)).toBe(5n * 10n ** 17n);
    expect(parseAmount("0", 18)).toBeNull();
    expect(parseAmount("-1", 18)).toBeNull();
    expect(parseAmount("1e5", 18)).toBeNull();
    expect(parseAmount("0.1234567", 6)).toBeNull();
    expect(parseAmount("", 18)).toBeNull();
  });

  it("writes ticks with a true minus", () => {
    expect(formatTick(230129)).toBe("230,129");
    expect(formatTick(-887272)).toBe("−887,272");
  });

  it("shortens hashes and addresses", () => {
    expect(shortHex("0xE83bc0dddED710C5A6e4E6Fc8d6E5da4Cd46042c")).toBe("0xE83b…042c");
    expect(shortHex("0x1234")).toBe("0x1234");
  });

  it("formats durations and spans", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(300)).toBe("5m 00s");
    expect(formatDuration(3900)).toBe("1h 05m");
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2d 04h");
    expect(formatSpan(300)).toBe("5 min");
    expect(formatSpan(15)).toBe("15 s");
    expect(formatSpan(7200)).toBe("2 h");
  });

  it("keeps time in UTC", () => {
    expect(formatClock(1792437715)).toBe("19:21:55 UTC");
    expect(formatDateTime(1792437715)).toBe("Oct 19, 19:21:55 UTC");
    expect(formatRelative(110, 100)).toBe("in 10s");
    expect(formatRelative(100, 400)).toBe("5m 00s ago");
    expect(formatRelative(100, 100.4)).toBe("now");
  });
});
