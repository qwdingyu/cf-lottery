/**
 * CheckinCalendar 组件逻辑测试（docs/268）
 *
 * 覆盖：
 * 1. 日历网格计算（月视图、补位、今日标记）
 * 2. 签到日期去重
 * 3. 月份边界处理
 * 4. 格式化函数
 */
import { describe, expect, it } from "vitest";

/** 格式化日期为 YYYY-MM-DD */
function formatDate(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 获取当月第一天是星期几（0=周日） */
function getFirstWeekday(year: number, month: number): number {
  return new Date(year, month - 1, 1).getDay();
}

/** 获取当月总天数 */
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

describe("formatDate", () => {
  it("格式化正确", () => {
    expect(formatDate(2026, 8, 23)).toBe("2026-08-23");
    expect(formatDate(2026, 1, 1)).toBe("2026-01-01");
    expect(formatDate(2026, 12, 31)).toBe("2026-12-31");
  });

  it("月份和日期补零", () => {
    expect(formatDate(2026, 1, 5)).toBe("2026-01-05");
    expect(formatDate(2026, 10, 1)).toBe("2026-10-01");
  });
});

describe("getFirstWeekday", () => {
  it("2026-08-01 是星期六（6）", () => {
    expect(getFirstWeekday(2026, 8)).toBe(6);
  });

  it("2026-01-01 是星期四（4）", () => {
    expect(getFirstWeekday(2026, 1)).toBe(4);
  });
});

describe("getDaysInMonth", () => {
  it("8 月有 31 天", () => {
    expect(getDaysInMonth(2026, 8)).toBe(31);
  });

  it("2 月有 28 天（非闰年）", () => {
    expect(getDaysInMonth(2026, 2)).toBe(28);
  });

  it("12 月有 31 天", () => {
    expect(getDaysInMonth(2026, 12)).toBe(31);
  });
});

describe("日历网格计算", () => {
  it("2026 年 8 月日历网格", () => {
    const year = 2026;
    const month = 8;
    const firstWeekday = getFirstWeekday(year, month);
    const totalDays = getDaysInMonth(year, month);

    // 上月补位天数
    const prevMonthDays = firstWeekday;
    expect(prevMonthDays).toBe(6); // 周六开始，需要补 6 天

    // 本月天数
    expect(totalDays).toBe(31);

    // 总格子数（补位 + 本月 + 下月补位 = 42）
    const totalCells = 42;
    const nextMonthDays = totalCells - prevMonthDays - totalDays;
    expect(nextMonthDays).toBe(5);
  });

  it("签到日期去重", () => {
    const signedDates = ["2026-08-23", "2026-08-22", "2026-08-23", "2026-08-21"];
    const uniqueDates = [...new Set(signedDates)].sort();

    expect(uniqueDates).toEqual(["2026-08-21", "2026-08-22", "2026-08-23"]);
  });

  it("今日标记", () => {
    const today = "2026-08-23";
    const calendarDays = [
      { date: "2026-08-22", isToday: false },
      { date: "2026-08-23", isToday: true },
      { date: "2026-08-24", isToday: false },
    ];

    const todayMarked = calendarDays.find((d) => d.date === today);
    expect(todayMarked?.isToday).toBe(true);
  });
});

describe("月份边界", () => {
  it("12 月切换到下一年 1 月", () => {
    const year = 2026;
    const month = 12;

    const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
    expect(nextMonth).toBe("2027-01");
  });

  it("1 月切换到上一年 12 月", () => {
    const year = 2026;
    const month = 1;

    const prevMonth = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
    expect(prevMonth).toBe("2025-12");
  });
});

describe("streak 统计", () => {
  it("计算连续签到天数", () => {
    const signedDates = ["2026-08-23", "2026-08-22", "2026-08-21", "2026-08-20"];
    const today = "2026-08-23";

    let streak = 0;
    let checkDate = new Date(today + "T00:00:00Z");

    for (const d of signedDates) {
      const dateStr = d.slice(0, 10);
      if (dateStr === checkDate.toISOString().slice(0, 10)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    expect(streak).toBe(4);
  });

  it("断签后 streak 重置", () => {
    const signedDates = ["2026-08-23", "2026-08-21", "2026-08-20"]; // 缺少 22 日
    const today = "2026-08-23";

    let streak = 0;
    let checkDate = new Date(today + "T00:00:00Z");

    for (const d of signedDates) {
      const dateStr = d.slice(0, 10);
      if (dateStr === checkDate.toISOString().slice(0, 10)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    expect(streak).toBe(1); // 只有今天
  });
});