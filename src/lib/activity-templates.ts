/**
 * 活动模板定义
 *
 * 预置常用活动模板，帮助 SaaS 客户快速创建活动。
 * 每个模板预设 activity_kind、experience_type、participation_mode、默认规则和说明文案。
 * 客户选择模板 → 填写标题和时间 → 一键创建。
 */
export interface ActivityTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: "marketing" | "engagement" | "conversion" | "research";
  defaults: {
    activityKind: string;
    experienceType: string;
    resultMode: string;
    participationMode: string;
    allocationPolicy: string;
    winnerCount: number;
    showParticipantCount: number;
    showWinnerCount: number;
  };
  /** 提示文案：创建时需要填写的关键字段 */
  hints: string[];
}

export const ACTIVITY_TEMPLATES: ActivityTemplate[] = [
  {
    id: "lottery-wheel",
    name: "大转盘抽奖",
    description: "经典转盘抽奖，用户转动转盘随机获得奖品。适合福利放送、粉丝互动、节日活动。",
    icon: "🎡",
    category: "engagement",
    defaults: {
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "instant",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 1,
      showParticipantCount: 1,
      showWinnerCount: 1,
    },
    hints: ["设置奖品和中奖名额", "设置活动开始和结束时间", "可开启密码保护或邀请码模式"],
  },
  {
    id: "lottery-scratch",
    name: "刮刮卡抽奖",
    description: "用户刮开涂层即时揭晓是否中奖。适合线下活动引流、产品推广、节日营销。",
    icon: "🎴",
    category: "engagement",
    defaults: {
      activityKind: "lottery",
      experienceType: "scratch",
      resultMode: "instant",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 1,
      showParticipantCount: 0,
      showWinnerCount: 0,
    },
    hints: ["设置奖品和中奖名额", "建议关闭参与人数显示以保持悬念", "可设置每人仅限一次"],
  },
  {
    id: "signup-chain",
    name: "报名接龙",
    description: "用户按顺序报名，满额自动候补。适合课程报名、活动签到、社群招募。",
    icon: "📋",
    category: "marketing",
    defaults: {
      activityKind: "signup_chain",
      experienceType: "submit",
      resultMode: "ordered_assignment",
      participationMode: "open",
      allocationPolicy: "waitlist",
      winnerCount: 0,
      showParticipantCount: 1,
      showWinnerCount: 0,
    },
    hints: ["设置报名名额上限", "开启候补名单避免名额浪费", "可设置名单模式控制参与资格"],
  },
  {
    id: "claim-download",
    name: "资料领取",
    description: "用户填写信息后领取资料/白皮书/优惠券。适合 B2B 留资、课程资料、产品试用。",
    icon: "📥",
    category: "conversion",
    defaults: {
      activityKind: "claim",
      experienceType: "reveal",
      resultMode: "instant",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 0,
      showParticipantCount: 0,
      showWinnerCount: 0,
    },
    hints: ["设置可领取的资料名称", "建议开启导流配置引导用户下一步", "可设置密码保护控制访问"],
  },
  {
    id: "survey-feedback",
    name: "问卷调研",
    description: "用户填写问卷提交反馈。适合用户调研、满意度收集、活动报名补充信息。",
    icon: "📝",
    category: "research",
    defaults: {
      activityKind: "survey",
      experienceType: "form",
      resultMode: "no_result",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 0,
      showParticipantCount: 0,
      showWinnerCount: 0,
    },
    hints: ["在活动描述中写明问卷内容", "可在导流配置中添加完成后的引导链接", "建议关闭参与人数显示"],
  },
  {
    id: "vote-pick",
    name: "投票评选",
    description: "用户从选项中投票选择。适合社群评选、作品投票、意见征集。",
    icon: "🗳️",
    category: "research",
    defaults: {
      activityKind: "vote",
      experienceType: "ballot",
      resultMode: "vote_tally",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 0,
      showParticipantCount: 1,
      showWinnerCount: 1,
    },
    hints: ["在活动描述中写明投票选项", "投票结束后可在管理后台查看票数统计", "每人限投一次"],
  },
  {
    id: "checkin-daily",
    name: "每日签到",
    description: "用户每天可签到一次，累积签到记录。适合训练营打卡、社群活跃度运营。",
    icon: "✅",
    category: "engagement",
    defaults: {
      activityKind: "checkin",
      experienceType: "submit",
      resultMode: "no_result",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 0,
      showParticipantCount: 1,
      showWinnerCount: 0,
    },
    hints: ["设置签到活动的持续时间", "同一用户每天可签到一次", "可在管理后台查看签到记录"],
  },
  {
    id: "approval-apply",
    name: "审核申请",
    description: "用户提交申请，管理员审核通过或拒绝。适合内测邀请、白名单申请、加群审核。",
    icon: "🔑",
    category: "conversion",
    defaults: {
      activityKind: "approval",
      experienceType: "form",
      resultMode: "review_decision",
      participationMode: "open",
      allocationPolicy: "approval",
      winnerCount: 0,
      showParticipantCount: 0,
      showWinnerCount: 0,
    },
    hints: ["用户提交申请后，在管理后台审批", "通过后可通过 Webhook 通知用户", "可在活动描述中说明审核标准"],
  },
];