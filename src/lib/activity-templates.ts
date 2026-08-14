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
    maxParticipants?: number;
    enableProductLink?: boolean;
    productLinkTitle?: string;
    productLinkPrice?: string;
    enableFlashSale?: boolean;
    flashSaleSessionLabel?: string;
    flashSaleStockLimit?: number | null;
    flashSaleMaxPerUser?: number;
    flashSalePaymentRequired?: boolean;
    flashSalePriceCents?: number | null;
    flashSaleCurrency?: string;
    flashSaleTitle?: string;
    /** 阶梯定价配置（flash_sale 批量优惠）：格式与前端表单 flashSalePricingTiers 一致 */
    flashSalePricingTiers?: Array<{
      minQuantity: number;
      unitPriceCents: number;
      label: string;
    }>;
  };
  /** 提示文案：创建时需要填写的关键字段 */
  hints: string[];
}

export const ACTIVITY_TEMPLATES: ActivityTemplate[] = [
  // 延迟大转盘：experience=wheel 只是参与壳；中奖由 performDraw（manual/scheduled）产生（docs/115）。
  // 即时出奖请用 lottery-wheel-instant（独立 spin 结果机，docs/116）。
  {
    id: "lottery-wheel",
    name: "大转盘抽奖",
    description:
      "转盘是参与互动壳：用户点击完成登记，进入开奖候选池；中奖由主办方开奖或定时开奖统一产生，不是转盘停下的那一格。适合福利放送、粉丝互动、节日活动。",
    icon: "🎡",
    category: "engagement",
    defaults: {
      activityKind: "lottery",
      experienceType: "wheel",
      resultMode: "manual", // 延迟开奖；即时请用 lottery-wheel-instant
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 1,
      showParticipantCount: 1,
      showWinnerCount: 1,
    },
    hints: [
      "设置奖品和中奖名额（开奖时从参与池抽取）",
      "设置活动开始/结束时间；需要到点自动开奖时改用定时开奖",
      "公开页转盘动画表示「已参与」，不代表当场中奖",
      "可开启密码保护或邀请码模式",
    ],
  },
  {
    id: "lottery-scratch",
    name: "刮刮卡抽奖",
    description:
      "刮开涂层是参与前的互动，确认后提交登记进入候选池；是否中奖在主办方开奖或定时开奖后查询，不是刮开瞬间出奖。适合线下引流、产品推广、节日营销。",
    icon: "🎴",
    category: "engagement",
    defaults: {
      activityKind: "lottery",
      experienceType: "scratch",
      resultMode: "manual",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 1,
      showParticipantCount: 0,
      showWinnerCount: 0,
    },
    hints: [
      "设置奖品和中奖名额",
      "建议关闭参与人数显示以保持悬念",
      "刮开后仍须点参与；结果以开奖后「查结果」为准",
      "可设置每人仅限一次",
    ],
  },
  // 即时大转盘：独立 spin 结果机（docs/116）；与 lottery-wheel（延迟开奖）并存互斥
  {
    id: "lottery-wheel-instant",
    name: "即时大转盘",
    description:
      "用户参与后当场 spin 出奖/未中；每人可配置抽奖次数（1=只抽一次）。适合现场互动、裂变加次。不走统一开奖。",
    icon: "🎯",
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
    hints: [
      "设置每人抽奖次数 maxSpinsPerEntry（≥1）",
      "奖项须配置 weight>0 与档位名额；码类准备足够库存",
      "勿使用「立即开奖/定时开奖」——结果由用户 spin 产生",
      "裂变开启时邀请成功 +抽奖次数（受双封顶），排行榜仍按邀请人数",
    ],
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
    hints: ["选择模板后在活动内容配置中调整问卷字段", "可在导流配置中添加完成后的引导链接", "建议关闭参与人数显示"],
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
    hints: ["选择模板后在活动内容配置中调整投票选项", "投票结束后可在管理后台查看票数统计", "每人限投一次"],
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
  // docs/130/131：秒杀体验壳。导流由商品链接承接；paymentRequired=true 后走 cf-lottery 直付发卡。
  {
    id: "flash-sale-rush",
    name: "限时抢购",
    description:
      "商品化限时限量抢购：商品图、价格、倒计时、已抢进度、「抢」按钮。可导流到 cf-shop/外部店铺，也可开启 EasyPay/ZPay 直付发卡。适合 Token 卡密、联名商品、社群爆品场次。",
    icon: "⚡",
    category: "conversion",
    defaults: {
      activityKind: "claim",
      experienceType: "flash_sale",
      resultMode: "instant",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 0,
      showParticipantCount: 1,
      showWinnerCount: 0,
      maxParticipants: 100,
      enableProductLink: true,
      productLinkTitle: "限时抢购商品",
      productLinkPrice: "",
      enableFlashSale: true,
      flashSaleSessionLabel: "12:00场",
      flashSaleStockLimit: 100,
      flashSaleMaxPerUser: 5,
      flashSalePaymentRequired: true,
      flashSalePriceCents: 990,
      flashSaleCurrency: "cny",
      flashSaleTitle: "限时抢购商品",
      // 阶梯定价：批发优惠预置 2 档（单件 / 5件起），运营可改；前端表单按 minQuantity 升序展示
      flashSalePricingTiers: [
        { minQuantity: 1, unitPriceCents: 990, label: "单件" },
        { minQuantity: 5, unitPriceCents: 890, label: "5件起" },
      ],
    },
    hints: [
      "先填商品链接、商品名称、展示价格和图片；导流模式必须指向可下单页面",
      "确认活动开始/结束时间、maxParticipants 与 flashSale.stockLimit",
      "直付模式开启 paymentRequired 后必须配置 priceCents、EasyPay/ZPay 支付设置和单一卡密码池",
      "支付金额以 flashSale.priceCents 为准；productLink.price 仅用于外部导流展示",
    ],
  },
  // docs/162 P2-A：预约活动模板（reservation / calendar / capacity_assignment）
  // 后端已支持 reservation activityKind，但此前无模板；enabled_kinds 默认含 reservation。
  {
    id: "reservation-booking",
    name: "预约报名",
    description: "用户选择后提交预约，按容量确认占位，满员即止。适合课程预约、门店到店、号源占位、活动场次预约。",
    icon: "🗓️",
    category: "conversion",
    defaults: {
      activityKind: "reservation",
      experienceType: "calendar",
      resultMode: "capacity_assignment",
      participationMode: "open",
      allocationPolicy: "capacity",
      winnerCount: 0,
      showParticipantCount: 1,
      showWinnerCount: 0,
      maxParticipants: 50,
    },
    hints: [
      "设置预约名额上限（maxParticipants）",
      "公开页展示已预约人数（showParticipantCount=1）",
      "过期后可在管理台导出预约名单",
      "可设置密码保护或名单模式控制参与资格",
    ],
  },
];
